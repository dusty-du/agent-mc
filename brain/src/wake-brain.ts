import {
  AgentIntent,
  BuildIntent,
  BuildPlan,
  CraftGoal,
  MemoryObservation,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  ProjectState,
  RecallQuery,
  ReplanLevel,
  ReplanTrigger,
  ValueProfile,
  WakeOrientation
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE } from "@resident/shared";
import { applyWakeOrientation, createMemoryState, syncMemoryState } from "./memory/memory-state";
import { SemanticBuildPlanner } from "./planning/build-planner";
import { CraftPlanner } from "./planning/craft-planner";

export interface WakeBrainDecision {
  intent: AgentIntent;
  memory: MemoryState;
  observations: MemoryObservation[];
  replanLevel: ReplanLevel;
  wakeOrientation?: WakeOrientation;
  craftGoal?: CraftGoal;
  buildPlan?: BuildPlan;
  recallQuery?: RecallQuery;
}

function isoNow(): string {
  return new Date().toISOString();
}

function observationFrom(
  frame: PerceptionFrame,
  category: MemoryObservation["category"],
  summary: string,
  tags: string[],
  source: MemoryObservation["source"] = "action"
): MemoryObservation {
  return {
    timestamp: isoNow(),
    category,
    summary,
    tags,
    importance: 0.6,
    source,
    location: frame.position,
    affect: {
      mood: 0.55,
      stress: frame.combat_state.hostilesNearby > 0 ? 0.82 : 0.3,
      loneliness: frame.nearby_entities.some((entity) => entity.type === "player") ? 0.2 : 0.45,
      wonder: frame.notable_places.length > 0 ? 0.76 : 0.36,
      security: frame.home_state.shelterScore,
      belonging: frame.home_state.bedAvailable ? 0.7 : 0.4,
      satisfaction: frame.pantry_state.emergencyReserveDays >= 1 ? 0.64 : 0.48
    }
  };
}

function replanLevelFor(trigger: ReplanTrigger): ReplanLevel {
  if (["spawn", "wake", "damage", "hostile_detection", "task_failure", "protected_area_conflict"].includes(trigger)) {
    return "hard";
  }
  if (["dawn", "dusk", "hunger_threshold", "inventory_change", "player_interaction", "task_completion", "idle_check"].includes(trigger)) {
    return "soft";
  }
  return "micro";
}

export class WakeBrain {
  private readonly craftPlanner = new CraftPlanner();
  private readonly buildPlanner = new SemanticBuildPlanner();

  decide(
    frame: PerceptionFrame,
    memory: MemoryState = createMemoryState(),
    values: ValueProfile = DEFAULT_VALUE_PROFILE,
    overnight?: OvernightConsolidation,
    trigger: ReplanTrigger = "idle_check"
  ): WakeBrainDecision {
    const replanLevel = replanLevelFor(trigger);
    let nextMemory = syncMemoryState(memory, frame, overnight);
    const observations: MemoryObservation[] = [];

    let wakeOrientation: WakeOrientation | undefined;
    if (trigger === "wake" || trigger === "spawn" || !nextMemory.last_wake_orientation) {
      wakeOrientation = this.orient(frame, nextMemory, overnight);
      nextMemory = applyWakeOrientation(nextMemory, wakeOrientation);
      observations.push(
        observationFrom(frame, "orientation", wakeOrientation.narration ?? "A new day begins.", ["wake", "orientation"], "reflection")
      );
    }

    if (trigger === "protected_area_conflict") {
      observations.push(
        observationFrom(
          frame,
          "danger",
          "I need to respect this boundary and choose a gentler place to shape.",
          ["protected-area", "boundary", "respect"],
          "reflection"
        )
      );
      nextMemory = rememberProject(nextMemory, {
        title: "Find a better build site",
        kind: "explore",
        status: "active",
        summary: "A protected area means I should create elsewhere.",
        location: frame.home_state.anchor ?? frame.position
      });
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "move",
          target: frame.home_state.anchor ?? frame.safe_route_state.nearestShelter ?? frame.position,
          reason: "Respect protected spaces and relocate to a safe, allowed area.",
          priority: 1,
          cancel_conditions: ["safe allowed area reached"],
          success_conditions: ["moved away from the protected area"],
          dialogue: "I should leave this place untouched and find room elsewhere.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (frame.combat_state.hostilesNearby > 0) {
      const risk = this.combatRisk(frame);
      if (risk > 0.55) {
        observations.push(
          observationFrom(frame, "danger", "Danger is close; safety matters more than pride right now.", ["combat", "retreat", "survival"])
        );
        return {
          intent: {
            agent_id: frame.agent_id,
            intent_type: "retreat",
            target: frame.safe_route_state.nearestShelter ?? frame.home_state.anchor,
            reason: "Avoid lethal combat and recover in safety.",
            priority: 1,
            cancel_conditions: ["hostiles no longer present", "safe shelter reached"],
            success_conditions: ["distance from hostiles increases", "shelter reached"],
            dialogue: "I need to fall back and stay alive.",
            trigger
          },
          memory: nextMemory,
          observations,
          replanLevel,
          wakeOrientation
        };
      }

      observations.push(
        observationFrom(frame, "combat", "The odds are tense but still manageable if I stay careful.", ["combat", "defense"], "perception")
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "fight",
          reason: "Fight only because the odds are acceptable and retreat is limited.",
          priority: 2,
          cancel_conditions: ["health drops below retreat threshold", "additional hostiles join"],
          success_conditions: ["immediate hostile threat removed"],
          dialogue: "I can handle this if I stay careful.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (trigger === "damage" && frame.health < 16) {
      observations.push(
        observationFrom(frame, "recovery", "That hurt. I want to recover before pushing farther.", ["recovery", "care", "safety"], "reflection")
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "recover",
          reason: "Stabilize after damage instead of pretending it did not matter.",
          priority: 1,
          cancel_conditions: ["health stabilized", "danger appears"],
          success_conditions: ["ate, regrouped, or reached safety"],
          dialogue: "I need a quieter moment to recover.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (frame.hunger <= 8 || frame.pantry_state.emergencyReserveDays < 1) {
      observations.push(
        observationFrom(frame, "food", "Food security needs attention before larger ambitions.", ["food", "survival", "farm"])
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: hasKnownFood(frame.inventory) ? "eat" : "farm",
          reason: "Preserve calories, recover stability, and protect tomorrow.",
          priority: 1,
          cancel_conditions: ["hunger restored", "new immediate danger appears"],
          success_conditions: ["safe meal consumed or food source secured"],
          dialogue: "I should feed myself before doing anything reckless.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    const daytime = frame.tick_time % 24000;
    if (daytime >= 12500 && frame.home_state.bedAvailable && values.safetyFloors.sleepNightly) {
      observations.push(
        observationFrom(
          frame,
          "sleep",
          "Night is coming; it is time to rest and let sleep reshape what matters.",
          ["sleep", "home", "rest"]
        )
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "sleep",
          target: frame.home_state.anchor,
          reason: "Nightly sleep is a hard rule and a chance to consolidate life.",
          priority: 1,
          cancel_conditions: ["immediate emergency", "bed missing"],
          success_conditions: ["bed entered safely"],
          dialogue: "I want to get home before night fully settles in.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (shouldStore(frame) && frame.workstation_state?.chestNearby) {
      observations.push(
        observationFrom(frame, "project", "My pockets are getting too full; it is time to put things in order.", ["storage", "home", "order"])
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "store",
          reason: "Keeping tools and resources organized protects future work.",
          priority: 2,
          cancel_conditions: ["danger appears"],
          success_conditions: ["items deposited into nearby storage"],
          dialogue: "I should put these things away before I lose track of them.",
          trigger
        },
        memory: rememberProject(nextMemory, {
          title: "Keep home organized",
          kind: "recovery",
          status: "active",
          summary: "Storage keeps the day from scattering.",
          location: frame.home_state.anchor ?? frame.position
        }),
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (shouldFarm(frame)) {
      observations.push(
        observationFrom(frame, "food", "The fields need attention if I want tomorrow to feel easy.", ["farm", "food", "stewardship"])
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "farm",
          reason: "Food systems deserve steady care, not only emergency panic.",
          priority: 2,
          cancel_conditions: ["danger appears", "night falls too close"],
          success_conditions: ["crops harvested, planted, or farmland improved"],
          dialogue: "I want to tend the fields while the day is still kind.",
          trigger
        },
        memory: rememberProject(nextMemory, {
          title: "Keep the fields alive",
          kind: "farm",
          status: "active",
          summary: "Food grows through repeated care.",
          location: frame.home_state.anchor ?? frame.position
        }),
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (shouldTendLivestock(frame)) {
      observations.push(
        observationFrom(frame, "livestock", "The animals need care if this place is going to feel alive and abundant.", ["livestock", "care", "stewardship"])
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "tend_livestock",
          reason: "Healthy animals are part of a gentle, renewable home.",
          priority: 2,
          cancel_conditions: ["danger appears", "night falls too close"],
          success_conditions: ["animals fed, checked, or their space improved"],
          dialogue: "I should care for the animals before asking more from them.",
          trigger
        },
        memory: rememberProject(nextMemory, {
          title: "Care for the animals",
          kind: "livestock",
          status: "active",
          summary: "The pens and herds shape the feeling of home.",
          location: frame.home_state.anchor ?? frame.position
        }),
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if (shouldSocialize(frame, nextMemory, values)) {
      observations.push(
        observationFrom(frame, "social", "Warm company is part of a good life too.", ["social", "hospitality", "belonging"], "reflection")
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "socialize",
          target: frame.nearby_entities.find((entity) => entity.type === "player")?.name,
          reason: "Connection and welcome matter alongside work.",
          priority: 3,
          cancel_conditions: ["danger appears", "the player leaves"],
          success_conditions: ["a kind exchange happens"],
          dialogue: socialDialogue(frame, nextMemory),
          trigger
        },
        memory: rememberProject(nextMemory, {
          title: "Share a warm moment",
          kind: "social",
          status: "active",
          summary: "Hospitality is part of what makes a place feel real.",
          location: frame.home_state.anchor ?? frame.position
        }),
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    const nextCraft = this.pickCraft(frame, nextMemory);
    if (nextCraft) {
      nextMemory = rememberProject(nextMemory, {
        title: `Craft ${nextCraft.target_item}`,
        kind: "craft",
        status: "active",
        summary: nextCraft.purpose,
        location: frame.home_state.anchor ?? frame.position
      });
      observations.push(
        observationFrom(frame, "crafting", `A useful next step is ${nextCraft.target_item}.`, ["craft", nextCraft.target_item], "reflection")
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "craft",
          target: nextCraft.target_item,
          reason: `Craft ${nextCraft.target_item} to support ${nextCraft.purpose}.`,
          priority: 3,
          cancel_conditions: ["materials unavailable", "night emergency"],
          success_conditions: [`${nextCraft.quantity} ${nextCraft.target_item} crafted`],
          dialogue: `I want to make ${nextCraft.target_item} next.`,
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation,
        craftGoal: nextCraft
      };
    }

    const buildIntent = this.pickBuildIntent(frame, nextMemory, values);
    const buildPlan = this.buildPlanner.plan(buildIntent, frame);
    observations.push(
      observationFrom(
        frame,
        buildIntent.rebuild_of ? "rebuild" : "building",
        `A new build direction is taking shape: ${buildIntent.purpose}.`,
        ["building", "home", ...buildIntent.style_tags]
      )
    );

    const recallQuery = trigger === "wake"
      ? {
          query: buildIntent.purpose,
          tags: buildIntent.style_tags,
          limit: 3
        }
      : maybeDelightRecall(frame, values);

    const delightMove = pickDelightMove(frame, values, nextMemory);
    if (delightMove) {
      observations.push(
        observationFrom(frame, "beauty", delightMove.summary, ["beauty", "curiosity", "joy"], "reflection")
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "move",
          target: delightMove.target,
          reason: delightMove.reason,
          priority: 4,
          cancel_conditions: ["danger appears", "night gets too close"],
          success_conditions: ["arrived at the chosen place"],
          dialogue: delightMove.dialogue,
          trigger
        },
        memory: rememberProject(nextMemory, {
          title: "Follow a moment of curiosity",
          kind: "explore",
          status: "active",
          summary: delightMove.reason,
          location: delightMove.target
        }),
        observations,
        replanLevel,
        wakeOrientation,
        recallQuery
      };
    }

    nextMemory = rememberProject(nextMemory, {
      title: buildIntent.purpose,
      kind: buildIntent.rebuild_of ? "rebuild" : "build",
      status: "active",
      summary: `Shape the world toward ${buildIntent.purpose}.`,
      location: buildIntent.site.center ?? frame.home_state.anchor ?? frame.position
    });

    return {
      intent: {
        agent_id: frame.agent_id,
        intent_type: buildIntent.rebuild_of ? "rebuild" : "build",
        target: buildIntent.purpose,
        reason: `Shape the world into a place worth living in: ${buildIntent.purpose}.`,
        priority: 4,
        cancel_conditions: ["immediate hunger or danger", "material bottleneck"],
        success_conditions: buildPlan.completion_checks,
        dialogue: "I want to make this place feel more like home.",
        trigger
      },
      memory: nextMemory,
      observations,
      replanLevel,
      wakeOrientation,
      buildPlan,
      recallQuery
      };
  }

  private orient(frame: PerceptionFrame, memory: MemoryState, overnight?: OvernightConsolidation): WakeOrientation {
    const immediateNeeds = [
      ...(frame.hunger <= 10 ? ["eat soon"] : []),
      ...(frame.combat_state.hostilesNearby > 0 ? ["find safety"] : []),
      ...(!frame.home_state.bedAvailable ? ["secure a bed"] : [])
    ];
    const riskFlags = [
      ...memory.recent_dangers.slice(-2),
      ...(frame.combat_state.hostilesNearby > 0 ? [`Hostiles nearby: ${frame.combat_state.hostilesNearby}`] : [])
    ];
    const priorities = [
      ...immediateNeeds,
      ...memory.carry_over_commitments.slice(0, 2),
      ...(overnight?.insights.slice(0, 2) ?? []),
      ...(memory.current_goals.slice(0, 2) ?? [])
    ].filter(Boolean);

    return {
      day_number: Math.floor(frame.tick_time / 24000),
      created_at: isoNow(),
      immediate_needs: immediateNeeds,
      risk_flags: riskFlags,
      carry_over_commitments: overnight?.carry_over_commitments ?? memory.carry_over_commitments,
      recalled_memories: [
        ...(overnight?.place_memories.slice(0, 2) ?? []),
        ...(overnight?.project_memories.slice(0, 2) ?? [])
      ],
      current_priorities: priorities.length > 0 ? priorities : ["look around and decide what the day asks for"],
      narration:
        frame.weather === "rain"
          ? "It is a wet morning. I should stay grounded in what matters."
          : "A new day is here. I can keep living, even if yesterday was imperfect."
    };
  }

  private combatRisk(frame: PerceptionFrame): number {
    const hungerPenalty = frame.hunger < 10 ? 0.2 : 0;
    const armorRelief = frame.combat_state.armorScore / 20;
    const threatPressure = frame.combat_state.hostilesNearby * 0.18;
    return Math.max(0, threatPressure + hungerPenalty - armorRelief);
  }

  private pickCraft(frame: PerceptionFrame, memory: MemoryState): CraftGoal | undefined {
    if (!frame.home_state.bedAvailable && (frame.inventory.white_wool ?? 0) >= 3 && countAnyPlanks(frame.inventory) >= 3) {
      return this.craftPlanner.plan("white_bed", 1, "secure nightly sleep", frame);
    }

    if (!frame.inventory.shield && (frame.inventory.iron_ingot ?? 0) >= 1 && countAnyPlanks(frame.inventory) >= 6) {
      return this.craftPlanner.plan("shield", 1, "defensive survival", frame);
    }

    return memory.craft_backlog[0];
  }

  private pickBuildIntent(frame: PerceptionFrame, memory: MemoryState, values: ValueProfile): BuildIntent {
    if (memory.build_backlog.length > 0) {
      return memory.build_backlog[0];
    }

    if (frame.home_state.shelterScore < 0.55) {
      return {
        purpose: "a cozy safe home that protects sleep, food, and tools",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 8 },
        style_tags: ["cozy", "shelter", "repairable"],
        functional_requirements: ["bed access", "storage", "lighting", "future pantry"],
        aesthetic_goals: ["warm entrance", "pleasant proportions"],
        materials_preference: ["oak_planks", "cobblestone", "torch"],
        expandable: true
      };
    }

    if (frame.livestock_state.welfareFlags.length > 0) {
      return {
        purpose: "repair and improve the animal spaces near home",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 12 },
        style_tags: ["practical", "gentle", "livestock"],
        functional_requirements: ["secure pens", "safe gates", "lighting"],
        aesthetic_goals: ["clear paths", "pleasant farm edge"],
        materials_preference: ["fence", "fence_gate", "torch", "oak_planks"],
        expandable: true,
        rebuild_of: "existing livestock pen"
      };
    }

    if (values.hospitality > 0.52) {
      return {
        purpose: "expand home for future guests and shared evenings",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 14 },
        style_tags: ["welcoming", "social", "garden"],
        functional_requirements: ["spare bed", "sitting area", "lit path", "food access"],
        aesthetic_goals: ["beautiful approach", "visible warmth"],
        materials_preference: ["oak_planks", "glass", "torch"],
        expandable: true
      };
    }

    return {
      purpose: "improve the comfort and beauty of home",
      site: { center: frame.home_state.anchor ?? frame.position, radius: 10 },
      style_tags: ["comfort", "beauty", "home"],
      functional_requirements: ["clear path", "better storage", "pleasant lighting"],
      aesthetic_goals: ["more charm", "more light", "more sense of belonging"],
      materials_preference: ["oak_planks", "torch", "glass"],
      expandable: true,
      rebuild_of: "current home"
    };
  }
}

function hasKnownFood(inventory: Record<string, number>): boolean {
  return countItems(inventory, ["bread", "baked_potato", "cooked_beef", "cooked_mutton", "cooked_porkchop", "cooked_chicken", "carrot", "apple"]) > 0;
}

function shouldStore(frame: PerceptionFrame): boolean {
  return Object.keys(frame.inventory).length >= 12 || countItems(frame.inventory, Object.keys(frame.inventory)) >= 48;
}

function shouldFarm(frame: PerceptionFrame): boolean {
  return (
    frame.farm_state.harvestableTiles > 0 ||
    (frame.pantry_state.emergencyReserveDays < 2 &&
      (frame.farm_state.farmlandReady || Object.values(frame.farm_state.seedStock).some((count) => count > 0)))
  );
}

function shouldTendLivestock(frame: PerceptionFrame): boolean {
  if (frame.livestock_state.welfareFlags.length > 0) {
    return true;
  }
  return Object.entries(frame.livestock_state.targetRanges).some(([species, range]) => (frame.livestock_state.counts[species] ?? 0) < range.min);
}

function shouldSocialize(frame: PerceptionFrame, memory: MemoryState, values: ValueProfile): boolean {
  const playersNearby = frame.nearby_entities.some((entity) => entity.type === "player");
  return playersNearby && (values.hospitality > 0.52 || values.sociability > 0.55 || memory.affect.loneliness > 0.42);
}

function socialDialogue(frame: PerceptionFrame, memory: MemoryState): string {
  const playerName = frame.nearby_entities.find((entity) => entity.type === "player")?.name;
  const opening = playerName ? `Hello ${playerName}.` : "Hello there.";
  const mood = memory.affect.wonder > 0.6 ? "It feels good to share this part of the world." : "I'm glad for the company.";
  return `${opening} ${mood}`;
}

function maybeDelightRecall(frame: PerceptionFrame, values: ValueProfile): RecallQuery | undefined {
  if (values.curiosity > 0.58 || values.beauty > 0.55 || frame.notable_places.length > 0) {
    return {
      query: frame.notable_places[0] ?? "beautiful places near home",
      tags: ["beauty", "home"],
      limit: 3
    };
  }
  return undefined;
}

function pickDelightMove(
  frame: PerceptionFrame,
  values: ValueProfile,
  memory: MemoryState
): { target: { x: number; y: number; z: number }; reason: string; dialogue: string; summary: string } | undefined {
  const affordance = frame.terrain_affordances?.find((entry) => entry.type === "view" || entry.type === "water" || entry.type === "cave");
  if (!affordance || (values.curiosity < 0.58 && values.beauty < 0.52 && values.joy < 0.7)) {
    return undefined;
  }
  if (memory.protected_areas.some((area) => distanceSquared(area.center, affordance.location) <= area.radius * area.radius)) {
    return undefined;
  }
  return {
    target: affordance.location,
    reason: `Make room for curiosity and lived beauty at the ${affordance.type}.`,
    dialogue: `I want to see what the ${affordance.type} feels like up close.`,
    summary: `A small act of curiosity feels worthwhile: visit the ${affordance.type}.`
  };
}

function rememberProject(
  memory: MemoryState,
  project: Pick<ProjectState, "title" | "kind" | "status" | "summary" | "location">
): MemoryState {
  const id = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const others = memory.active_projects.filter((entry) => entry.id !== id);
  const current: ProjectState = {
    id,
    title: project.title,
    kind: project.kind,
    status: project.status,
    summary: project.summary,
    location: project.location,
    updated_at: isoNow()
  };
  return {
    ...memory,
    active_projects: [...others.slice(-5), current],
    current_goals: [...new Set([...memory.current_goals, project.title])].slice(-6)
  };
}

function countAnyPlanks(inventory: Record<string, number>): number {
  return countItems(inventory, Object.keys(inventory).filter((key) => key.endsWith("_planks") || key === "planks"));
}

function countItems(inventory: Record<string, number>, names: string[]): number {
  return names.reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
}

function distanceSquared(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
