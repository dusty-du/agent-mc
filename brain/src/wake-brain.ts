import {
  AgentIntent,
  BuildIntent,
  COMBAT_ENGAGE_DISTANCE,
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
  Vec3,
  ValueProfile,
  WakeOrientation
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE } from "@resident/shared";
import {
  composeEmotionDialogue,
  emotionCandidateBias,
  emotionInterruptIntent,
  taggedPlaceAvoidancePenalty
} from "./emotion-core";
import { applyWakeOrientation, consumeEmotionInterrupt, createMemoryState, syncMemoryState } from "./memory/memory-state";
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

interface SurvivalIntentPlan {
  intentType: AgentIntent["intent_type"];
  target?: AgentIntent["target"];
  reason: string;
  successConditions: string[];
  dialogue: string;
  observation: string;
  observationTags: string[];
  project?: Pick<ProjectState, "title" | "kind" | "status" | "summary" | "location">;
}

interface DailyCandidatePlan {
  kind: "bootstrap" | "craft" | "build" | "farm" | "livestock" | "social" | "explore" | "store" | "observe";
  family: string;
  baseScore: number;
  intent: AgentIntent;
  observationCategory: MemoryObservation["category"];
  observationSummary: string;
  observationTags: string[];
  project?: Pick<ProjectState, "title" | "kind" | "status" | "summary" | "location">;
  craftGoal?: CraftGoal;
  buildIntent?: BuildIntent;
  recallQuery?: RecallQuery;
}

interface ScoutTarget {
  location: Vec3;
  label: string;
  source: "affordance" | "block" | "frontier";
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
  if (["spawn", "death", "respawn", "wake", "damage", "hostile_detection", "task_failure", "protected_area_conflict"].includes(trigger)) {
    return "hard";
  }
  if (
    ["social_contact", "bonding", "birth", "wonder", "dawn", "dusk", "hunger_threshold", "inventory_change", "player_interaction", "task_completion", "idle_check"].includes(
      trigger
    )
  ) {
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

    if (trigger === "spawn" && !memory.self_name && nextMemory.self_name) {
      observations.push(
        observationFrom(
          frame,
          "orientation",
          `When I opened my eyes in this world, I chose the name ${nextMemory.self_name}.`,
          ["identity", "name", "self"],
          "reflection"
        )
      );
    }

    const emotionPlan = this.planEmotionInterrupt(frame, nextMemory, trigger);
    if (emotionPlan) {
      observations.push(
        observationFrom(
          frame,
          emotionObservationCategory(emotionPlan.intentType),
          emotionPlan.observation,
          ["emotion", ...emotionPlan.observationTags],
          "reflection"
        )
      );
      const interruptedMemory = emotionPlan.project
        ? rememberProject(consumeEmotionInterrupt(nextMemory), emotionPlan.project)
        : consumeEmotionInterrupt(nextMemory);
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: emotionPlan.intentType,
          target: emotionPlan.target,
          reason: emotionPlan.reason,
          priority: 1,
          cancel_conditions: ["new immediate danger appears"],
          success_conditions: emotionPlan.successConditions,
          dialogue: emotionPlan.dialogue,
          trigger
        },
        memory: interruptedMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
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
      const retreatTarget = frame.safe_route_state.nearestShelter ?? frame.home_state.anchor;
      const hostileDistance = nearestHostileDistance(frame);
      const distantHostile = hostileDistance !== undefined && hostileDistance > COMBAT_ENGAGE_DISTANCE;
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

      if (distantHostile) {
        observations.push(
          observationFrom(
            frame,
            "danger",
            "Distant danger is a reason to stay cautious, not charge downhill into trouble.",
            ["combat", "distance", "survival"],
            "perception"
          )
        );
        if (retreatTarget) {
          return {
            intent: {
              agent_id: frame.agent_id,
              intent_type: "retreat",
              target: retreatTarget,
              reason: "Keep distance from danger until a hostile is close enough to matter directly.",
              priority: 1,
              cancel_conditions: ["hostiles no longer present", "safe shelter reached"],
              success_conditions: ["distance from hostiles increases", "shelter reached"],
              dialogue: "I should keep my distance and stay alive.",
              trigger
            },
            memory: nextMemory,
            observations,
            replanLevel,
            wakeOrientation
          };
        }
      }

      if (!distantHostile) {
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

    const survivalIntent = pickSurvivalIntent(frame, nextMemory);
    if (survivalIntent) {
      observations.push(
        observationFrom(
          frame,
          survivalIntent.intentType === "recover" ? "recovery" : survivalIntent.intentType === "observe" ? "orientation" : "food",
          survivalIntent.observation,
          survivalIntent.observationTags
        )
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: survivalIntent.intentType,
          target: survivalIntent.target,
          reason: survivalIntent.reason,
          priority: 1,
          cancel_conditions: ["hunger restored", "new immediate danger appears"],
          success_conditions: survivalIntent.successConditions,
          dialogue: survivalIntent.dialogue,
          trigger
        },
        memory: survivalIntent.project ? rememberProject(nextMemory, survivalIntent.project) : nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    const phase = nextMemory.mind_state.routinePhase;
    if (
      (phase === "dusk" || phase === "night") &&
      frame.home_state.shelterScore < 0.45 &&
      (frame.safe_route_state.nearestShelter ?? frame.home_state.anchor)
    ) {
      observations.push(
        observationFrom(
          frame,
          "danger",
          "Night asks for shelter first; exposed ground can wait until morning.",
          ["night", "shelter", "survival"],
          "reflection"
        )
      );
      return {
        intent: {
          agent_id: frame.agent_id,
          intent_type: "retreat",
          target: frame.safe_route_state.nearestShelter ?? frame.home_state.anchor,
          reason: "Reach enclosed shelter before darkness turns routine work into risk.",
          priority: 1,
          cancel_conditions: ["shelter reached", "immediate combat begins"],
          success_conditions: ["arrived at a safer sheltered location"],
          dialogue: "I need walls and light before I need anything else.",
          trigger
        },
        memory: nextMemory,
        observations,
        replanLevel,
        wakeOrientation
      };
    }

    if ((phase === "dusk" || phase === "night") && frame.home_state.bedAvailable && values.safetyFloors.sleepNightly) {
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

    const candidate = this.pickDailyCandidate(frame, nextMemory, values, trigger);
    const buildPlan = candidate.buildIntent ? this.buildPlanner.plan(candidate.buildIntent, frame) : undefined;

    observations.push(
      observationFrom(frame, candidate.observationCategory, candidate.observationSummary, candidate.observationTags, "reflection")
    );

    return {
      intent: {
        ...candidate.intent,
        agent_id: frame.agent_id,
        success_conditions: buildPlan?.completion_checks ?? candidate.intent.success_conditions,
        trigger
      },
      memory: candidate.project ? rememberProject(nextMemory, candidate.project) : nextMemory,
      observations,
      replanLevel,
      wakeOrientation,
      craftGoal: candidate.craftGoal,
      buildPlan,
      recallQuery: candidate.recallQuery
    };
  }

  private orient(frame: PerceptionFrame, memory: MemoryState, overnight?: OvernightConsolidation): WakeOrientation {
    const unresolvedEpisode =
      memory.emotion_core.active_episode && !memory.emotion_core.active_episode.resolved
        ? memory.emotion_core.active_episode
        : undefined;
    const immediateNeeds = [
      ...(frame.hunger <= 10 ? ["eat soon"] : []),
      ...(frame.combat_state.hostilesNearby > 0 ? ["find safety"] : []),
      ...(!frame.home_state.bedAvailable ? ["secure a bed"] : []),
      ...(unresolvedEpisode?.kind === "death" ? ["regain footing after death"] : [])
    ];
    const riskFlags = [
      ...memory.recent_dangers.slice(-2),
      ...(memory.emotion_core.dominant_emotions.length > 0
        ? [`Emotional tone: ${memory.emotion_core.dominant_emotions.join(", ")}`]
        : []),
      ...(unresolvedEpisode ? [unresolvedEpisode.summary] : []),
      ...(frame.combat_state.hostilesNearby > 0 ? [`Hostiles nearby: ${frame.combat_state.hostilesNearby}`] : [])
    ];
    const priorities = [
      ...immediateNeeds,
      ...(overnight?.emotional_themes?.slice(0, 2) ?? []),
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
        ...(overnight?.project_memories.slice(0, 2) ?? []),
        ...(unresolvedEpisode?.summary ? [unresolvedEpisode.summary] : [])
      ],
      current_priorities: priorities.length > 0 ? priorities : ["look around and decide what the day asks for"],
      narration:
        unresolvedEpisode?.kind === "death"
          ? "I woke carrying the memory of dying. Today should begin with attention, not denial."
          : frame.weather === "rain"
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

  private planEmotionInterrupt(
    frame: PerceptionFrame,
    memory: MemoryState,
    trigger: ReplanTrigger
  ): SurvivalIntentPlan | undefined {
    if (!["death", "respawn", "social_contact", "bonding", "birth", "wonder"].includes(trigger)) {
      return undefined;
    }

    const intent = emotionInterruptIntent(
      memory,
      frame,
      trigger as Extract<ReplanTrigger, "death" | "respawn" | "social_contact" | "bonding" | "birth" | "wonder">
    );
    if (!intent) {
      return undefined;
    }

    const fallbackLocation =
      frame.home_state.anchor ??
      memory.home_anchor ??
      memory.emotion_core.active_episode?.respawn_location ??
      memory.emotion_core.active_episode?.focal_location ??
      frame.position;

    return {
      intentType: intent.intent_type,
      target: intent.target,
      reason: intent.reason,
      successConditions:
        intent.intent_type === "observe"
          ? ["the current surroundings are assessed"]
          : intent.intent_type === "recover"
            ? ["health, food, or calm improves"]
            : intent.intent_type === "socialize"
              ? ["a warm exchange happens"]
              : intent.intent_type === "tend_livestock"
                ? ["the animals are checked or cared for"]
            : ["a safer position is reached"],
      dialogue: intent.dialogue,
      observation: intent.observation,
      observationTags: intent.observation_tags,
      project: {
        title:
          trigger === "death"
            ? "Recover after death"
            : trigger === "respawn"
              ? "Reorient after respawn"
              : trigger === "birth"
                ? "Care for new life"
                : trigger === "wonder"
                  ? "Honor a wonder moment"
                  : "Answer a meaningful bond",
        kind:
          intent.intent_type === "socialize"
            ? "social"
            : intent.intent_type === "tend_livestock"
              ? "livestock"
              : "recovery",
        status: "active",
        summary: intent.reason,
        location: intent.target ?? fallbackLocation
      }
    };
  }

  private pickDailyCandidate(
    frame: PerceptionFrame,
    memory: MemoryState,
    values: ValueProfile,
    trigger: ReplanTrigger
  ): DailyCandidatePlan {
    const candidates: DailyCandidatePlan[] = [];

    const bootstrapCandidate = this.pickBootstrapCandidate(frame, memory, values);
    if (bootstrapCandidate) {
      candidates.push(bootstrapCandidate);
    }

    candidates.push(...this.pickCraftCandidates(frame, memory));

    const urgentTorch = candidates.find(
      (candidate) =>
        candidate.family === "craft:torch" &&
        !memory.bootstrap_progress.lightSecured &&
        (memory.mind_state.routinePhase === "homeward" ||
          memory.mind_state.routinePhase === "dusk" ||
          frame.light_level <= 7)
    );
    if (urgentTorch) {
      return urgentTorch;
    }

    if (shouldStore(frame) && frame.workstation_state?.chestNearby) {
      candidates.push({
        kind: "store",
        family: "store",
        baseScore: 0.54,
        intent: {
          agent_id: frame.agent_id,
          intent_type: "store",
          reason: "Keeping tools and resources organized protects future work.",
          priority: 2,
          cancel_conditions: ["danger appears"],
          success_conditions: ["items deposited into nearby storage"],
          dialogue: "I should put these things away before I lose track of them."
        },
        observationCategory: "project",
        observationSummary: "My pockets are getting too full; it is time to put things in order.",
        observationTags: ["storage", "home", "order"],
        project: {
          title: "Keep home organized",
          kind: "recovery",
          status: "active",
          summary: "Storage keeps the day from scattering.",
          location: frame.home_state.anchor ?? frame.position
        }
      });
    }

    if (shouldFarm(frame, memory)) {
      candidates.push({
        kind: "farm",
        family: "farm",
        baseScore: 0.58,
        intent: {
          agent_id: frame.agent_id,
          intent_type: "farm",
          reason: "Food systems deserve steady care, especially once the basics are safe.",
          priority: 2,
          cancel_conditions: ["danger appears", "night falls too close"],
          success_conditions: ["crops harvested, planted, or farmland improved"],
          dialogue: "I want to tend the fields while the day is still kind."
        },
        observationCategory: "food",
        observationSummary: "The fields need attention if I want tomorrow to feel easy.",
        observationTags: ["farm", "food", "stewardship"],
        project: {
          title: "Keep the fields alive",
          kind: "farm",
          status: "active",
          summary: "Food grows through repeated care.",
          location: frame.home_state.anchor ?? frame.position
        }
      });
    }

    if (shouldTendLivestock(frame, memory)) {
      candidates.push({
        kind: "livestock",
        family: "tend_livestock",
        baseScore: 0.46,
        intent: {
          agent_id: frame.agent_id,
          intent_type: "tend_livestock",
          reason: "Healthy animals are part of a gentle, renewable home.",
          priority: 2,
          cancel_conditions: ["danger appears", "night falls too close"],
          success_conditions: ["animals fed, checked, or their space improved"],
          dialogue: "I should care for the animals before asking more from them."
        },
        observationCategory: "livestock",
        observationSummary: "The animals need care if this place is going to feel alive and abundant.",
        observationTags: ["livestock", "care", "stewardship"],
        project: {
          title: "Care for the animals",
          kind: "livestock",
          status: "active",
          summary: "The pens and herds shape the feeling of home.",
          location: frame.home_state.anchor ?? frame.position
        }
      });
    }

    if (shouldSocialize(frame, memory, values)) {
      candidates.push({
        kind: "social",
        family: `socialize:${frame.nearby_entities.find((entity) => entity.type === "player")?.name ?? "nearby-player"}`,
        baseScore: 0.54,
        intent: {
          agent_id: frame.agent_id,
          intent_type: "socialize",
          target: frame.nearby_entities.find((entity) => entity.type === "player")?.name,
          reason: "Connection and welcome matter alongside work.",
          priority: 3,
          cancel_conditions: ["danger appears", "the player leaves"],
          success_conditions: ["a kind exchange happens"],
          dialogue: socialDialogue(frame, memory)
        },
        observationCategory: "social",
        observationSummary: "Warm company is part of a good life too.",
        observationTags: ["social", "hospitality", "belonging"],
        project: {
          title: "Share a warm moment",
          kind: "social",
          status: "active",
          summary: "Hospitality is part of what makes a place feel real.",
          location: frame.home_state.anchor ?? frame.position
        }
      });
    }

    const buildIntent = this.pickBuildIntent(frame, memory, values);
    const buildKind = buildIntent.rebuild_of ? "rebuild" : "build";
    candidates.push({
      kind: "build",
      family: `${buildKind}:${buildIntent.purpose}`,
      baseScore: frame.home_state.shelterScore < 0.55 ? 0.88 : 0.38,
      intent: {
        agent_id: frame.agent_id,
        intent_type: buildKind,
        target: buildIntent.purpose,
        reason: `Shape the world into a place worth living in: ${buildIntent.purpose}.`,
        priority: 4,
        cancel_conditions: ["immediate hunger or danger", "material bottleneck"],
        success_conditions: ["build stage completed"],
        dialogue: composeEmotionDialogue(memory, frame, "I want to make this place feel more like home.", "build")
      },
      observationCategory: buildIntent.rebuild_of ? "rebuild" : "building",
      observationSummary: `A new build direction is taking shape: ${buildIntent.purpose}.`,
      observationTags: ["building", "home", ...buildIntent.style_tags],
      project: {
        title: buildIntent.purpose,
        kind: buildIntent.rebuild_of ? "rebuild" : "build",
        status: "active",
        summary: `Shape the world toward ${buildIntent.purpose}.`,
        location: buildIntent.site.center ?? frame.home_state.anchor ?? frame.position
      },
      buildIntent,
      recallQuery:
        trigger === "wake"
          ? {
              query: buildIntent.purpose,
              tags: buildIntent.style_tags,
              limit: 3
            }
          : maybeDelightRecall(frame, values, memory)
    });

    const delightMove = pickDelightMove(frame, values, memory);
    if (delightMove) {
      candidates.push({
        kind: "explore",
        family: `move:${Math.round(delightMove.target.x)}:${Math.round(delightMove.target.y)}:${Math.round(delightMove.target.z)}`,
        baseScore: 0.26,
        intent: {
          agent_id: frame.agent_id,
          intent_type: "move",
          target: delightMove.target,
          reason: delightMove.reason,
          priority: 4,
          cancel_conditions: ["danger appears", "night gets too close"],
          success_conditions: ["arrived at the chosen place"],
          dialogue: delightMove.dialogue
        },
        observationCategory: "beauty",
        observationSummary: delightMove.summary,
        observationTags: ["beauty", "curiosity", "joy"],
        project: {
          title: "Follow a moment of curiosity",
          kind: "explore",
          status: "active",
          summary: delightMove.reason,
          location: delightMove.target
        },
        recallQuery: maybeDelightRecall(frame, values, memory)
      });
    }

    candidates.push({
      kind: "observe",
      family: "observe",
      baseScore: 0.12,
      intent: {
        agent_id: frame.agent_id,
        intent_type: "observe",
        reason: "Pause, look carefully, and let the next worthwhile thread reveal itself.",
        priority: 4,
        cancel_conditions: ["danger appears", "a clearer opportunity surfaces"],
        success_conditions: ["a more grounded next step becomes clear"],
        dialogue: composeEmotionDialogue(memory, frame, "I want one clear read of the moment before I commit.", "observe")
      },
      observationCategory: "orientation",
      observationSummary: "A short pause can prevent a pointless loop and make the next step clearer.",
      observationTags: ["reflection", "anti-stuck", "attention"]
    });

    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(candidate, frame, memory, values)
      }))
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.candidate ?? candidates[candidates.length - 1];
  }

  private pickCraftCandidates(frame: PerceptionFrame, memory: MemoryState): DailyCandidatePlan[] {
    const candidates: DailyCandidatePlan[] = [];
    const canUseWorkbench =
      frame.home_state.workshopReady || frame.workstation_state?.craftingTableNearby || (frame.inventory.crafting_table ?? 0) > 0;

    if (!frame.home_state.workshopReady && (frame.inventory.crafting_table ?? 0) === 0) {
      const tableGoal = safeCraftPlan(this.craftPlanner, "crafting_table", 1, "set up a basic workshop", frame);
      if (tableGoal && isCraftGoalReady(tableGoal, frame)) {
        candidates.push(craftCandidate(frame, tableGoal, 0.98));
      }
    }

    if (!memory.bootstrap_progress.toolsReady && canUseWorkbench) {
      const toolMaterial = countItems(frame.inventory, ["cobblestone", "blackstone", "cobbled_deepslate"]) >= 6 ? "stone" : "wooden";
      if (!hasTool(frame.inventory, "axe")) {
        const axeGoal = safeCraftPlan(this.craftPlanner, `${toolMaterial}_axe`, 1, "speed up wood gathering", frame);
        if (axeGoal && isCraftGoalReady(axeGoal, frame)) {
          candidates.push(craftCandidate(frame, axeGoal, 0.92));
        }
      }
      if (!hasTool(frame.inventory, "pickaxe")) {
        const pickaxeGoal = safeCraftPlan(this.craftPlanner, `${toolMaterial}_pickaxe`, 1, "unlock stone and useful ores", frame);
        if (pickaxeGoal && isCraftGoalReady(pickaxeGoal, frame)) {
          candidates.push(craftCandidate(frame, pickaxeGoal, 0.9));
        }
      }
    }

    if (!memory.bootstrap_progress.lightSecured && countItems(frame.inventory, ["coal", "charcoal"]) >= 1 && (frame.inventory.stick ?? 0) >= 1) {
      const torchGoal = safeCraftPlan(this.craftPlanner, "torch", 8, "light shelter and safe routes before night", frame);
      if (torchGoal && isCraftGoalReady(torchGoal, frame)) {
        candidates.push(craftCandidate(frame, torchGoal, 0.94));
      }
    }

    if (!memory.bootstrap_progress.bedSecured && (frame.inventory.white_wool ?? 0) >= 3 && countAnyPlanks(frame.inventory) >= 3) {
      const bedGoal = safeCraftPlan(this.craftPlanner, "white_bed", 1, "secure nightly sleep", frame);
      if (bedGoal && isCraftGoalReady(bedGoal, frame)) {
        candidates.push(craftCandidate(frame, bedGoal, 0.93));
      }
    }

    if (!frame.inventory.shield && (frame.inventory.iron_ingot ?? 0) >= 1 && countAnyPlanks(frame.inventory) >= 6) {
      const shieldGoal = safeCraftPlan(this.craftPlanner, "shield", 1, "survive danger without wasting food and health", frame);
      if (shieldGoal && isCraftGoalReady(shieldGoal, frame)) {
        candidates.push(craftCandidate(frame, shieldGoal, 0.74));
      }
    }

    const backlogGoal = memory.craft_backlog[0];
    if (backlogGoal && isCraftGoalReady(backlogGoal, frame)) {
      candidates.push(craftCandidate(frame, backlogGoal, 0.58));
    }

    return candidates;
  }

  private pickBootstrapCandidate(frame: PerceptionFrame, memory: MemoryState, values: ValueProfile): DailyCandidatePlan | undefined {
    const phase = memory.mind_state.routinePhase;
    const progress = memory.bootstrap_progress;
    const treeAffordance = nearestAffordance(frame, ["tree"]);

    if (!progress.woodSecured) {
      if (treeAffordance) {
        return {
          kind: "bootstrap",
          family: "gather:wood",
          baseScore: phase === "dawn" || phase === "work" ? 1.08 : 0.96,
          intent: {
            agent_id: frame.agent_id,
            intent_type: "gather",
            target: "wood",
            reason: "Gather wood first so shelter, tools, and food systems are actually possible.",
            priority: 3,
            cancel_conditions: ["danger appears", "night falls too close"],
            success_conditions: ["wood collected for basic survival work"],
            dialogue: composeEmotionDialogue(memory, frame, "I need wood before this place can start feeling livable.", "gather")
          },
          observationCategory: "project",
          observationSummary: "The first good decision is still wood; nothing durable starts without it.",
          observationTags: ["bootstrap", "wood", "survival"],
          project: {
            title: "Bootstrap the basics",
            kind: "explore",
            status: "active",
            summary: "Gather the first materials needed for food and shelter.",
            location: treeAffordance.location
          }
        };
      }

      const scoutTarget = pickScoutTarget(frame, memory, ["tree", "water", "flat"]);
      if (scoutTarget && !(scoutTarget.source === "frontier" && isLowLightPhase(phase))) {
        return {
          kind: "bootstrap",
          family: `move:${Math.round(scoutTarget.location.x)}:${Math.round(scoutTarget.location.y)}:${Math.round(scoutTarget.location.z)}`,
          baseScore: 0.82,
          intent: {
            agent_id: frame.agent_id,
            intent_type: "move",
            target: scoutTarget.location,
            reason: `Move toward ${scoutTarget.label} to find better ground for wood, food, and shelter.`,
            priority: 3,
            cancel_conditions: ["danger appears", "night falls too close"],
            success_conditions: ["reached a more promising place to continue surviving"],
            dialogue: composeEmotionDialogue(
              memory,
              frame,
              `I should head toward the ${scoutTarget.label} and see what it offers.`,
              "move"
            )
          },
          observationCategory: "project",
          observationSummary: "Standing still will not solve survival; I need a better foothold.",
          observationTags: ["bootstrap", "scout", "survival"],
          project: {
            title: "Scout a better foothold",
            kind: "explore",
            status: "active",
            summary: `Look for a more promising place near the ${scoutTarget.label}.`,
            location: scoutTarget.location
          }
        };
      }
    }

    if (!progress.shelterSecured) {
      const buildIntent = this.pickBuildIntent(frame, memory, values);
      return {
        kind: "bootstrap",
        family: `build:${buildIntent.purpose}`,
        baseScore: phase === "dusk" || phase === "night" ? 1.04 : 0.86,
        intent: {
          agent_id: frame.agent_id,
          intent_type: buildIntent.rebuild_of ? "rebuild" : "build",
          target: buildIntent.purpose,
          reason: "A roof, walls, and a clear home anchor matter before comfort projects do.",
          priority: 3,
          cancel_conditions: ["danger appears", "materials run out"],
          success_conditions: ["basic shelter becomes safer and more usable"],
          dialogue: composeEmotionDialogue(memory, frame, "I need a shelter that can actually hold the night back.", "build")
        },
        observationCategory: "building",
        observationSummary: "Temporary shelter is the next real milestone; decoration can wait.",
        observationTags: ["bootstrap", "shelter", "survival"],
        project: {
          title: "Secure basic shelter",
          kind: "build",
          status: "active",
          summary: "Shape a first shelter before expanding into comfort.",
          location: frame.home_state.anchor ?? frame.position
        },
        buildIntent
      };
    }

    if (!progress.foodSecured && phase !== "night") {
      const scoutTarget = pickScoutTarget(frame, memory, ["water", "flat", "tree"]);
      if (scoutTarget && !(scoutTarget.source === "frontier" && isLowLightPhase(phase))) {
        return {
          kind: "bootstrap",
          family: `move:${Math.round(scoutTarget.location.x)}:${Math.round(scoutTarget.location.y)}:${Math.round(scoutTarget.location.z)}`,
          baseScore: 0.66,
          intent: {
            agent_id: frame.agent_id,
            intent_type: "move",
            target: scoutTarget.location,
            reason: `Move toward ${scoutTarget.label} to secure food and better working ground.`,
            priority: 3,
            cancel_conditions: ["danger appears", "night falls too close"],
            success_conditions: ["reached a better place for food or shelter work"],
            dialogue: composeEmotionDialogue(
              memory,
              frame,
              `I should check the ${scoutTarget.label} before hunger gets louder.`,
              "move"
            )
          },
          observationCategory: "food",
          observationSummary: "Food security is still unfinished, so I should move toward better ground for it.",
          observationTags: ["bootstrap", "food", "survival"],
          project: {
            title: "Secure food footing",
            kind: "explore",
            status: "active",
            summary: `Look for food-friendly ground near the ${scoutTarget.label}.`,
            location: scoutTarget.location
          }
        };
      }
    }

    return undefined;
  }

  private pickBuildIntent(frame: PerceptionFrame, memory: MemoryState, values: ValueProfile): BuildIntent {
    const personality = memory.personality_profile;
    const phase = memory.mind_state.routinePhase;
    const styleTags = [
      ...new Set([
        ...personality.style_tags,
        personality.motifs.primary,
        ...(personality.motifs.secondary ? [personality.motifs.secondary] : [])
      ])
    ];

    if (memory.build_backlog.length > 0) {
      return memory.build_backlog[0];
    }

    if (!memory.bootstrap_progress.shelterSecured || frame.home_state.shelterScore < 0.55) {
      return {
        purpose: "a cozy safe home that protects sleep, food, and tools",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 8 },
        style_tags: ["cozy", "shelter", "repairable", ...styleTags].slice(0, 5),
        functional_requirements: ["bed access", "storage", "lighting", "future pantry"],
        aesthetic_goals: ["warm entrance", "pleasant proportions"],
        materials_preference: ["oak_planks", "cobblestone", "torch"],
        expandable: true
      };
    }

    if (!memory.bootstrap_progress.bedSecured && (phase === "homeward" || phase === "dusk" || phase === "night")) {
      return {
        purpose: "finish a sheltered sleeping corner before the next night deepens",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 8 },
        style_tags: ["sleep", "shelter", "practical", ...styleTags].slice(0, 5),
        functional_requirements: ["bed space", "lighting", "door access", "safe path"],
        aesthetic_goals: ["warm threshold", "calm interior"],
        materials_preference: ["oak_planks", "torch", "cobblestone"],
        expandable: true
      };
    }

    if (frame.livestock_state.welfareFlags.length > 0) {
      return {
        purpose: "repair and improve the animal spaces near home",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 12 },
        style_tags: ["practical", "gentle", "livestock", ...styleTags].slice(0, 5),
        functional_requirements: ["secure pens", "safe gates", "lighting"],
        aesthetic_goals: ["clear paths", "pleasant farm edge"],
        materials_preference: ["fence", "fence_gate", "torch", "oak_planks"],
        expandable: true,
        rebuild_of: "existing livestock pen"
      };
    }

    if (values.hospitality > 0.52 || personality.motifs.primary === "host" || personality.traits.extraversion > 0.66) {
      return {
        purpose: "expand home for future guests and shared evenings",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 14 },
        style_tags: ["welcoming", "social", "garden", ...styleTags].slice(0, 5),
        functional_requirements: ["spare bed", "sitting area", "lit path", "food access"],
        aesthetic_goals: ["beautiful approach", "visible warmth"],
        materials_preference: ["oak_planks", "glass", "torch"],
        expandable: true
      };
    }

    if (personality.motifs.primary === "wanderer" || personality.traits.openness > 0.7 || values.curiosity > 0.66) {
      return {
        purpose: "shape a lookout and path that make the nearby land feel known",
        site: { center: frame.home_state.anchor ?? frame.position, radius: 12 },
        style_tags: ["lookout", "path", "curious", ...styleTags].slice(0, 5),
        functional_requirements: ["lit route", "clear sightline", "easy return home"],
        aesthetic_goals: ["memorable approach", "small scenic perch"],
        materials_preference: ["oak_planks", "torch", "cobblestone"],
        expandable: true,
        rebuild_of: "current home"
      };
    }

    return {
      purpose: "improve the comfort and beauty of home",
      site: { center: frame.home_state.anchor ?? frame.position, radius: 10 },
      style_tags: ["comfort", "beauty", "home", ...styleTags].slice(0, 5),
      functional_requirements: ["clear path", "better storage", "pleasant lighting"],
      aesthetic_goals: ["more charm", "more light", "more sense of belonging"],
      materials_preference: ["oak_planks", "torch", "glass"],
      expandable: true,
      rebuild_of: "current home"
    };
  }
}

function nearestHostileDistance(frame: PerceptionFrame): number | undefined {
  return frame.nearby_entities
    .filter((entity) => entity.type === "hostile")
    .map((entity) => entity.distance)
    .sort((left, right) => left - right)[0];
}

function pickSurvivalIntent(frame: PerceptionFrame, memory: MemoryState): SurvivalIntentPlan | undefined {
  if (frame.hunger > 8 && frame.pantry_state.emergencyReserveDays >= 1 && memory.bootstrap_progress.foodSecured) {
    return undefined;
  }

  if (hasKnownFood(frame.inventory)) {
    return {
      intentType: "eat",
      reason: "Preserve calories, recover stability, and protect tomorrow.",
      successConditions: ["safe meal consumed or food source secured"],
      dialogue: "I should feed myself before doing anything reckless.",
      observation: "Food security needs attention before larger ambitions.",
      observationTags: ["food", "survival", "eat"]
    };
  }

  if (hasNearbyFarmOpportunity(frame) && memory.bootstrap_progress.shelterSecured && memory.mind_state.routinePhase !== "night") {
    return {
      intentType: "farm",
      reason: "Food systems deserve steady care, especially when reserves are thin.",
      successConditions: ["crops harvested, planted, or farmland improved"],
      dialogue: "I should tend the fields before hunger turns into panic.",
      observation: "Food security needs attention before larger ambitions.",
      observationTags: ["food", "survival", "farm"],
      project: {
        title: "Keep the fields alive",
        kind: "farm",
        status: "active",
        summary: "Food grows through repeated care.",
        location: frame.home_state.anchor ?? frame.position
      }
    };
  }

  const bootstrapIntent = pickEmergencyBootstrapIntent(frame, memory);
  if (bootstrapIntent) {
    return bootstrapIntent;
  }

  if (!memory.bootstrap_progress.woodSecured || !memory.bootstrap_progress.shelterSecured || !memory.bootstrap_progress.foodSecured) {
    return undefined;
  }

  return {
    intentType: "observe",
    reason: "Pause briefly and reassess because no immediate food or movement opportunity is visible yet.",
    successConditions: ["a safer next step becomes clear"],
    dialogue: composeEmotionDialogue(memory, frame, "I need to look carefully before I commit myself.", "observe"),
    observation: "The immediate area offers no obvious food path, so a careful pause is wiser than pretending otherwise.",
    observationTags: ["orientation", "survival", "observe"]
  };
}

function hasKnownFood(inventory: Record<string, number>): boolean {
  return countItems(inventory, ["bread", "baked_potato", "cooked_beef", "cooked_mutton", "cooked_porkchop", "cooked_chicken", "carrot", "apple"]) > 0;
}

function shouldStore(frame: PerceptionFrame): boolean {
  return Object.keys(frame.inventory).length >= 12 || countItems(frame.inventory, Object.keys(frame.inventory)) >= 48;
}

function shouldFarm(frame: PerceptionFrame, memory: MemoryState): boolean {
  if (frame.hunger <= 8 || frame.pantry_state.emergencyReserveDays < 1) {
    return false;
  }
  if (!memory.bootstrap_progress.shelterSecured || !memory.bootstrap_progress.woodSecured) {
    return false;
  }
  if (memory.mind_state.routinePhase === "dusk" || memory.mind_state.routinePhase === "night") {
    return false;
  }
  return hasNearbyFarmOpportunity(frame);
}

function hasNearbyFarmOpportunity(frame: PerceptionFrame): boolean {
  return (
    frame.farm_state.harvestableTiles > 0 ||
    (frame.pantry_state.emergencyReserveDays < 2 &&
      Object.values(frame.farm_state.seedStock).some((count) => count > 0) &&
      (frame.farm_state.farmlandReady || frame.farm_state.hydratedTiles > 0))
  );
}

function shouldTendLivestock(frame: PerceptionFrame, memory: MemoryState): boolean {
  if (!frame.nearby_entities.some((entity) => entity.type === "passive")) {
    return false;
  }
  if (!memory.bootstrap_progress.shelterSecured || memory.mind_state.routinePhase === "dusk" || memory.mind_state.routinePhase === "night") {
    return false;
  }
  if (frame.livestock_state.welfareFlags.length > 0) {
    return true;
  }
  if (
    memory.emotion_core.active_episode?.kind === "nurture" ||
    memory.emotion_core.bonded_entities.some((bond) => bond.kind === "herd" && bond.attachment >= 0.45)
  ) {
    return true;
  }
  return Object.entries(frame.livestock_state.targetRanges).some(([species, range]) => (frame.livestock_state.counts[species] ?? 0) < range.min);
}

function shouldSocialize(frame: PerceptionFrame, memory: MemoryState, values: ValueProfile): boolean {
  const playersNearby = frame.nearby_entities.some((entity) => entity.type === "player");
  const bondedPlayerNearby = frame.nearby_entities.some(
    (entity) =>
      entity.type === "player" &&
      memory.emotion_core.bonded_entities.some((bond) => bond.kind === "player" && bond.label.toLowerCase() === entity.name.toLowerCase() && bond.attachment >= 0.42)
  );
  const wonderPull =
    frame.notable_places.length > 0 &&
    memory.personality_profile.traits.openness >= 0.78 &&
    memory.personality_profile.traits.extraversion <= 0.35 &&
    !bondedPlayerNearby;
  if (wonderPull) {
    return false;
  }
  return (
    playersNearby &&
    memory.bootstrap_progress.shelterSecured &&
    frame.combat_state.hostilesNearby === 0 &&
    (values.hospitality > 0.52 ||
      values.sociability > 0.55 ||
      memory.affect.loneliness > 0.42 ||
      memory.need_state.relatedness > 0.45 ||
      memory.personality_profile.traits.extraversion > 0.62 ||
      memory.emotion_core.active_episode?.kind === "attachment" ||
      bondedPlayerNearby)
  );
}

function socialDialogue(frame: PerceptionFrame, memory: MemoryState): string {
  const playerName = frame.nearby_entities.find((entity) => entity.type === "player")?.name;
  const opening = playerName ? `Hello ${playerName}.` : "Hello there.";
  const selfIntro = memory.self_name ? `I'm ${memory.self_name}.` : "";
  const bond = playerName
    ? memory.emotion_core.bonded_entities.find((entity) => entity.kind === "player" && entity.label.toLowerCase() === playerName.toLowerCase())
    : undefined;
  const mood =
    memory.emotion_core.active_episode?.kind === "attachment"
      ? "Your being here changes the feeling of this place."
      : bond && bond.attachment >= 0.42
        ? "It's good to see you again."
        : memory.affect.wonder > 0.6
          ? "It feels good to share this part of the world."
          : "I'm glad for the company.";
  return [opening, selfIntro, mood].filter(Boolean).join(" ");
}

function maybeDelightRecall(frame: PerceptionFrame, values: ValueProfile, memory: MemoryState): RecallQuery | undefined {
  if (
    values.curiosity > 0.58 ||
    values.beauty > 0.55 ||
    frame.notable_places.length > 0 ||
    memory.personality_profile.traits.openness > 0.62
  ) {
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
  const affordance = frame.terrain_affordances?.find(
    (entry) =>
      (entry.type === "view" || entry.type === "water" || entry.type === "cave") &&
      distanceSquared(frame.position, entry.location) > 9
  );
  if (
    !affordance ||
    (values.curiosity < 0.58 &&
      values.beauty < 0.52 &&
      values.joy < 0.7 &&
      memory.personality_profile.traits.openness < 0.62)
  ) {
    return undefined;
  }
  if (memory.protected_areas.some((area) => distanceSquared(area.center, affordance.location) <= area.radius * area.radius)) {
    return undefined;
  }
  if (memory.mind_state.routinePhase === "dusk" || memory.mind_state.routinePhase === "night") {
    return undefined;
  }
  return {
    target: affordance.location,
    reason: `Make room for curiosity and lived beauty at the ${affordance.type}.`,
    dialogue: `I want to see what the ${affordance.type} feels like up close.`,
    summary: `A small act of curiosity feels worthwhile: visit the ${affordance.type}.`
  };
}

function pickEmergencyBootstrapIntent(frame: PerceptionFrame, memory: MemoryState): SurvivalIntentPlan | undefined {
  if (memory.bootstrap_progress.foodSecured) {
    return undefined;
  }
  const treeAffordance = !memory.bootstrap_progress.woodSecured ? nearestAffordance(frame, ["tree"]) : undefined;
  if (treeAffordance) {
    return {
      intentType: "gather",
      target: "wood",
      reason: "Gather wood first so shelter, tools, and food systems are actually possible.",
      successConditions: ["wood collected for basic survival work"],
      dialogue: composeEmotionDialogue(memory, frame, "I need wood before this place can start feeling livable.", "gather"),
      observation: "I need materials before food security and shelter can take shape.",
      observationTags: ["bootstrap", "wood", "survival"],
      project: {
        title: "Bootstrap the basics",
        kind: "explore",
        status: "active",
        summary: "Gather the first materials needed for food and shelter.",
        location: treeAffordance.location
      }
    };
  }

  const scoutTarget = pickScoutTarget(frame, memory, ["water", "tree", "flat"]);
  if (!scoutTarget || (scoutTarget.source === "frontier" && isLowLightPhase(memory.mind_state.routinePhase))) {
    return undefined;
  }

  return {
    intentType: "move",
    target: scoutTarget.location,
    reason: `Move toward ${scoutTarget.label} to find better ground for food and shelter.`,
    successConditions: ["reached a more promising place to continue surviving"],
    dialogue: composeEmotionDialogue(
      memory,
      frame,
      `I should head toward the ${scoutTarget.label} and see what it offers.`,
      "move"
    ),
    observation: "Standing still will not solve food security; I need a better place to work from.",
    observationTags: ["bootstrap", "scout", "survival"],
    project: {
      title: "Scout a better foothold",
      kind: "explore",
      status: "active",
      summary: `Look for a more promising place near the ${scoutTarget.label}.`,
      location: scoutTarget.location
    }
  };
}

function nearestAffordance(
  frame: PerceptionFrame,
  types: Array<NonNullable<PerceptionFrame["terrain_affordances"]>[number]["type"]>
) {
  return frame.terrain_affordances
    ?.filter((entry) => types.includes(entry.type))
    .sort((left, right) => distanceSquared(frame.position, left.location) - distanceSquared(frame.position, right.location))[0];
}

function pickScoutTarget(
  frame: PerceptionFrame,
  memory: MemoryState,
  preferredTypes: Array<NonNullable<PerceptionFrame["terrain_affordances"]>[number]["type"]> = ["tree", "water", "flat", "view"]
): ScoutTarget | undefined {
  const candidateAffordance = frame.terrain_affordances
    ?.filter((entry) => entry.type !== "hazard" && entry.type !== "cave" && preferredTypes.includes(entry.type))
    .sort((left, right) => distanceSquared(frame.position, left.location) - distanceSquared(frame.position, right.location))
    .find((entry) => distanceSquared(frame.position, entry.location) > 9);

  if (candidateAffordance) {
    return {
      location: candidateAffordance.location,
      label: scoutAffordanceLabel(candidateAffordance.type),
      source: "affordance"
    };
  }

  const candidateBlock = frame.nearby_blocks
    .filter((block) => !block.name.includes("air"))
    .sort((left, right) => right.distance - left.distance)
    .find((block) => distanceSquared(frame.position, block.position) > 9);

  if (candidateBlock) {
    return {
      location: candidateBlock.position,
      label: scoutBlockLabel(candidateBlock.name),
      source: "block"
    };
  }

  return frontierScoutTarget(frame, memory, preferredTypes);
}

const FRONTIER_DIRECTIONS: Array<{ x: number; z: number }> = [
  { x: 1, z: 0 },
  { x: 1, z: 1 },
  { x: 0, z: 1 },
  { x: -1, z: 1 },
  { x: -1, z: 0 },
  { x: -1, z: -1 },
  { x: 0, z: -1 },
  { x: 1, z: -1 }
];

function scoutAffordanceLabel(type: NonNullable<PerceptionFrame["terrain_affordances"]>[number]["type"]): string {
  switch (type) {
    case "tree":
      return "tree line";
    case "water":
      return "water";
    case "flat":
      return "open ground";
    case "view":
      return "higher ground";
    case "slope":
      return "gentler ground";
    case "cave":
      return "cave mouth";
    case "hazard":
      return "safer ground";
  }
}

function scoutBlockLabel(name: string): string {
  if (name.includes("log") || name.includes("leaves") || name.includes("sapling")) {
    return "tree line";
  }
  if (name.includes("water")) {
    return "water";
  }
  if (name.includes("grass") || name.includes("dirt") || name.includes("sand") || name.includes("gravel")) {
    return "open ground";
  }
  return name.replace(/_/g, " ");
}

function frontierScoutTarget(
  frame: PerceptionFrame,
  memory: MemoryState,
  preferredTypes: Array<NonNullable<PerceptionFrame["terrain_affordances"]>[number]["type"]>
): ScoutTarget | undefined {
  if (isLowLightPhase(memory.mind_state.routinePhase)) {
    return undefined;
  }

  const radius = memory.bootstrap_progress.shelterSecured ? 8 : 12;
  const rotation = stableDirectionIndex(
    [
      memory.personality_profile.seed,
      preferredTypes.join(","),
      String(recentScoutStallCount(memory.recent_action_snapshots))
    ].join(":"),
    FRONTIER_DIRECTIONS.length
  );

  for (let offset = 0; offset < FRONTIER_DIRECTIONS.length; offset += 1) {
    const direction = FRONTIER_DIRECTIONS[(rotation + offset) % FRONTIER_DIRECTIONS.length];
    const target = {
      x: Math.round(frame.position.x + direction.x * radius),
      y: Math.round(frame.position.y),
      z: Math.round(frame.position.z + direction.z * radius)
    };
    if (distanceSquared(frame.position, target) <= 9) {
      continue;
    }
    if (frame.protected_areas?.some((area) => distanceSquared(area.center, target) <= area.radius * area.radius)) {
      continue;
    }
    return {
      location: target,
      label: frontierScoutLabel(preferredTypes),
      source: "frontier"
    };
  }

  return undefined;
}

function frontierScoutLabel(preferredTypes: Array<NonNullable<PerceptionFrame["terrain_affordances"]>[number]["type"]>): string {
  if (preferredTypes.includes("tree")) {
    return "better ground";
  }
  if (preferredTypes.includes("water")) {
    return "better water-bearing ground";
  }
  if (preferredTypes.includes("flat")) {
    return "better open ground";
  }
  if (preferredTypes.includes("view")) {
    return "higher ground";
  }
  return "better ground";
}

function recentScoutStallCount(recentActions: MemoryState["recent_action_snapshots"]): number {
  return recentActions
    .slice(-6)
    .filter(
      (entry) =>
        (entry.intent_type === "observe" && entry.position_delta < 0.75) ||
        (entry.intent_type === "move" && (entry.status === "blocked" || entry.status === "failed" || entry.position_delta < 0.75))
    ).length;
}

function stableDirectionIndex(key: string, size: number): number {
  if (size <= 1) {
    return 0;
  }
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

function isLowLightPhase(phase: MemoryState["mind_state"]["routinePhase"]): boolean {
  return phase === "dusk" || phase === "night";
}

function craftCandidate(frame: PerceptionFrame, goal: CraftGoal, baseScore: number): DailyCandidatePlan {
  return {
    kind: "craft",
    family: `craft:${goal.target_item}`,
    baseScore,
    intent: {
      agent_id: frame.agent_id,
      intent_type: "craft",
      target: goal.target_item,
      reason: `Craft ${goal.target_item} to support ${goal.purpose}.`,
      priority: 3,
      cancel_conditions: ["materials unavailable", "night emergency"],
      success_conditions: [`${goal.quantity} ${goal.target_item} crafted`],
      dialogue: `I want to make ${goal.target_item} next.`
    },
    observationCategory: "crafting",
    observationSummary: `A useful next step is ${goal.target_item}.`,
    observationTags: ["craft", goal.target_item],
    project: {
      title: `Craft ${goal.target_item}`,
      kind: "craft",
      status: "active",
      summary: goal.purpose,
      location: frame.home_state.anchor ?? frame.position
    },
    craftGoal: goal
  };
}

function safeCraftPlan(
  planner: CraftPlanner,
  targetItem: string,
  quantity: number,
  purpose: string,
  frame: PerceptionFrame
): CraftGoal | undefined {
  try {
    return planner.plan(targetItem, quantity, purpose, frame);
  } catch {
    return undefined;
  }
}

function isCraftGoalReady(goal: CraftGoal, frame: PerceptionFrame): boolean {
  if (Object.keys(goal.missing_inputs).length > 0) {
    return false;
  }
  return goal.required_stations.every((station) => {
    if (station === "crafting_table") {
      return frame.home_state.workshopReady || frame.workstation_state?.craftingTableNearby || (frame.inventory.crafting_table ?? 0) > 0;
    }
    if (station === "furnace") {
      return frame.workstation_state?.furnaceNearby || (frame.inventory.furnace ?? 0) > 0;
    }
    return true;
  });
}

function scoreCandidate(
  candidate: DailyCandidatePlan,
  frame: PerceptionFrame,
  memory: MemoryState,
  values: ValueProfile
): number {
  const phase = memory.mind_state.routinePhase;
  const repeatedPenalty = repetitionPenalty(memory.recent_action_snapshots, candidate.family);
  if (repeatedPenalty >= 2.5) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = candidate.baseScore;
  score += phaseBias(candidate.kind, phase);
  score += needBias(candidate.kind, memory);
  score += personalityBias(candidate.kind, memory);
  score += valueBias(candidate.kind, values, memory);
  score += emotionBias(candidate.kind, frame, memory, values);
  score -= repeatedPenalty;
  score -= movementCost(frame.position, candidate.intent.target);
  score -= taggedPlaceAvoidancePenalty(typeof candidate.intent.target === "string" ? undefined : candidate.intent.target, memory);

  if (frame.weather !== "clear" && candidate.kind === "explore") {
    score -= 0.18;
  }
  if (frame.combat_state.hostilesNearby > 0 && ["explore", "farm", "livestock", "social"].includes(candidate.kind)) {
    score -= 0.45;
  }
  if ((phase === "dusk" || phase === "night") && ["explore", "farm", "livestock"].includes(candidate.kind)) {
    score -= 0.75;
  }
  if ((phase === "dusk" || phase === "night") && candidate.kind === "build" && frame.home_state.shelterScore < 0.55) {
    score += 0.45;
  }
  if ((phase === "homeward" || phase === "dusk") && candidate.kind === "store" && frame.home_state.anchor) {
    score += 0.18;
  }
  if (!memory.bootstrap_progress.shelterSecured && ["social", "explore", "livestock"].includes(candidate.kind)) {
    score -= 0.35;
  }
  if (candidate.family === "craft:torch" && !memory.bootstrap_progress.lightSecured) {
    score += phase === "homeward" || phase === "dusk" ? 1.05 : 0.6;
  }
  if (candidate.family === "craft:white_bed" && !memory.bootstrap_progress.bedSecured) {
    score += phase === "homeward" || phase === "dusk" || phase === "night" ? 0.58 : 0.24;
  }
  if (candidate.family === "craft:crafting_table" && !frame.home_state.workshopReady) {
    score += 0.36;
  }
  if (candidate.family === "craft:shield" && memory.recent_dangers.length > 0) {
    score += 0.22;
  }
  if (candidate.kind === "build" && !memory.bootstrap_progress.lightSecured && memory.bootstrap_progress.shelterSecured) {
    score -= 0.24;
  }
  return score;
}

function phaseBias(kind: DailyCandidatePlan["kind"], phase: MemoryState["mind_state"]["routinePhase"]): number {
  const table: Record<MemoryState["mind_state"]["routinePhase"], Partial<Record<DailyCandidatePlan["kind"], number>>> = {
    dawn: { bootstrap: 0.24, craft: 0.08, observe: 0.1, build: 0.04 },
    work: { bootstrap: 0.18, craft: 0.16, build: 0.18, farm: 0.14, livestock: 0.08, explore: 0.04 },
    homeward: { store: 0.18, build: 0.12, social: 0.08, craft: 0.06, explore: -0.08 },
    dusk: { bootstrap: 0.18, build: 0.22, store: 0.14, observe: 0.1, social: -0.05, explore: -0.28, farm: -0.22, livestock: -0.2 },
    night: { observe: 0.16, store: 0.08, craft: 0.04, build: 0.08, social: -0.12, explore: -0.45, farm: -0.4, livestock: -0.35, bootstrap: -0.08 }
  };
  return table[phase][kind] ?? 0;
}

function needBias(kind: DailyCandidatePlan["kind"], memory: MemoryState): number {
  const needs = memory.need_state;
  switch (kind) {
    case "bootstrap":
      return needs.safety * 0.24 + needs.competence * 0.22 + needs.hunger * 0.16;
    case "craft":
      return needs.competence * 0.28 + needs.autonomy * 0.1 + needs.safety * 0.08;
    case "build":
      return needs.safety * 0.22 + needs.competence * 0.16 + needs.beauty * 0.08;
    case "farm":
      return needs.hunger * 0.22 + needs.safety * 0.1;
    case "livestock":
      return needs.relatedness * 0.08 + needs.beauty * 0.04;
    case "social":
      return needs.relatedness * 0.28;
    case "explore":
      return needs.autonomy * 0.18 + needs.beauty * 0.12;
    case "store":
      return needs.safety * 0.08 + needs.competence * 0.06;
    case "observe":
      return memory.mind_state.frustration * 0.18 + needs.rest * 0.06;
  }
}

function personalityBias(kind: DailyCandidatePlan["kind"], memory: MemoryState): number {
  const { traits, motifs } = memory.personality_profile;
  let bias = 0;
  if (kind === "explore") {
    bias += traits.openness * 0.24 - traits.threat_sensitivity * 0.18;
  }
  if (kind === "craft") {
    bias += traits.conscientiousness * 0.18 + traits.openness * 0.08;
  }
  if (kind === "build") {
    bias += traits.conscientiousness * 0.16 + traits.agreeableness * 0.05;
  }
  if (kind === "social") {
    bias += traits.extraversion * 0.28 + traits.agreeableness * 0.18;
  }
  if (kind === "bootstrap") {
    bias += traits.conscientiousness * 0.18 + traits.threat_sensitivity * 0.08;
  }
  if (kind === "farm" || kind === "livestock") {
    bias += traits.agreeableness * 0.08 + traits.conscientiousness * 0.12;
  }

  const motifSet = new Set([motifs.primary, motifs.secondary].filter(Boolean));
  if (motifSet.has("wanderer") && kind === "explore") {
    bias += 0.18;
  }
  if (motifSet.has("homesteader") && ["build", "farm", "store"].includes(kind)) {
    bias += 0.16;
  }
  if (motifSet.has("caretaker") && ["social", "livestock", "farm"].includes(kind)) {
    bias += 0.16;
  }
  if (motifSet.has("tinkerer") && kind === "craft") {
    bias += 0.18;
  }
  if (motifSet.has("sentinel") && ["bootstrap", "build", "craft"].includes(kind)) {
    bias += 0.12;
  }
  if (motifSet.has("host") && ["social", "build"].includes(kind)) {
    bias += kind === "social" ? 0.4 : 0.16;
  }
  return bias;
}

function valueBias(kind: DailyCandidatePlan["kind"], values: ValueProfile, memory: MemoryState): number {
  switch (kind) {
    case "build":
      return values.craftsmanship * 0.12 + values.comfort * 0.1 + values.beauty * 0.1;
    case "craft":
      return values.competence * 0.14 + values.craftsmanship * 0.12;
    case "farm":
      return values.food_security * 0.16 + values.stewardship * 0.08;
    case "livestock":
      return values.stewardship * 0.12 + values.hospitality * 0.04;
    case "social":
      return values.hospitality * 0.16 + values.sociability * 0.14;
    case "explore":
      return values.curiosity * 0.18 + values.beauty * 0.08 + memory.mind_state.valence * 0.06;
    case "bootstrap":
      return values.survival * 0.12 + values.safety * 0.12 + values.food_security * 0.08;
    case "store":
      return values.comfort * 0.04 + values.competence * 0.04;
    case "observe":
      return 0;
  }
}

function emotionBias(
  kind: DailyCandidatePlan["kind"],
  frame: PerceptionFrame,
  memory: MemoryState,
  values: ValueProfile
): number {
  return emotionCandidateBias(kind, memory, frame, values);
}

function emotionObservationCategory(intentType: SurvivalIntentPlan["intentType"]): MemoryObservation["category"] {
  if (intentType === "recover") {
    return "recovery";
  }
  if (intentType === "socialize") {
    return "social";
  }
  if (intentType === "tend_livestock") {
    return "livestock";
  }
  if (intentType === "observe") {
    return "orientation";
  }
  return "danger";
}

function repetitionPenalty(recentActions: MemoryState["recent_action_snapshots"], family: string): number {
  const recentSame = recentActions.filter((entry) => entry.target_class === family).slice(-4);
  if (recentSame.length === 0) {
    return 0;
  }
  const blocked = recentSame.filter((entry) => entry.status === "blocked" || entry.status === "failed").length;
  const stalled = recentSame.filter((entry) => entry.position_delta < 0.75 && entry.status !== "completed").length;
  const stationaryObserve = family === "observe" ? recentSame.filter((entry) => entry.intent_type === "observe" && entry.position_delta < 0.75).length : 0;
  if (family === "observe" && stationaryObserve >= 3) {
    return 2.6;
  }
  return recentSame.length * 0.12 + blocked * 0.9 + stalled * 0.65 + stationaryObserve * 0.55;
}

function movementCost(
  current: Vec3,
  target: AgentIntent["target"]
): number {
  if (!target || typeof target === "string") {
    return 0;
  }
  const dx = current.x - target.x;
  const dy = current.y - target.y;
  const dz = current.z - target.z;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  return horizontal / 80 + Math.abs(dy) / 16;
}

function hasTool(inventory: Record<string, number>, kind: "axe" | "pickaxe"): boolean {
  return Object.entries(inventory).some(([name, count]) => count > 0 && name.endsWith(`_${kind}`));
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
