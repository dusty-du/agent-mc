import { describe, expect, it } from "vitest";
import { DEFAULT_LIVESTOCK_STATE, PerceptionFrame } from "@resident/shared";
import {
  applyResidentEmotionEventToMemory,
  applyWakeOrientation,
  buildMemoryBundle,
  rememberActionReport,
  rememberActionSnapshot,
  rememberObservation,
  syncMemoryState
} from "../src/memory/memory-state";
import { createMemoryState } from "../src/memory/memory-state";

describe("memory-state", () => {
  it("folds social and danger observations into unified awake memory", () => {
    let memory = createMemoryState();

    memory = rememberObservation(memory, {
      timestamp: new Date().toISOString(),
      category: "social",
      summary: "Alex said the garden feels welcoming.",
      tags: ["social", "garden", "hospitality"],
      importance: 0.6,
      source: "dialogue"
    });

    memory = rememberObservation(memory, {
      timestamp: new Date().toISOString(),
      category: "danger",
      summary: "A skeleton was waiting by the tree line.",
      tags: ["danger", "combat", "night"],
      importance: 0.9,
      source: "perception"
    });

    expect(memory.recent_interactions.at(-1)).toContain("welcoming");
    expect(memory.recent_dangers.at(-1)).toContain("skeleton");
    expect(memory.self_narrative.at(-1)).toContain("tree line");
  });

  it("updates matching active projects from action reports", () => {
    const memory = {
      ...createMemoryState(),
      active_projects: [
        {
          id: "improve-home",
          title: "Improve home",
          kind: "build" as const,
          status: "active" as const,
          summary: "Make the shelter warmer and safer.",
          updated_at: new Date().toISOString()
        }
      ]
    };

    const updated = rememberActionReport(memory, {
      intent_type: "build",
      status: "completed",
      notes: ["Placed the new roofline."],
      damage_taken: 0,
      inventory_delta: {},
      world_delta: ["placed oak_planks"],
      needs_replan: false
    });

    expect(updated.active_projects[0]?.status).toBe("complete");
    expect(updated.self_narrative.at(-1)).toContain("Placed the new roofline.");
  });

  it("persists recent action snapshots and exposes new psychology state in the memory bundle", () => {
    let memory = syncMemoryState(createMemoryState(), basePerception);

    for (let index = 0; index < 18; index += 1) {
      memory = rememberActionSnapshot(memory, {
        timestamp: `2026-03-09T12:${String(index).padStart(2, "0")}:00.000Z`,
        intent_type: "move",
        target_class: `move:${index}`,
        status: "completed",
        position_delta: 2,
        risk_context: "safe"
      });
    }

    const bundle = buildMemoryBundle(memory, "resident-1");

    expect(memory.recent_action_snapshots).toHaveLength(16);
    expect(memory.self_name).toBeTruthy();
    expect(bundle.self_name).toBe(memory.self_name);
    expect(bundle.personality_profile.seed).toBe(memory.personality_profile.seed);
    expect(bundle.need_state).toEqual(memory.need_state);
    expect(bundle.bootstrap_progress).toEqual(memory.bootstrap_progress);
    expect(bundle.recent_action_snapshots).toHaveLength(16);
  });

  it("chooses a permanent self-name on first sync", () => {
    const initial = createMemoryState();
    const named = syncMemoryState(initial, basePerception);
    const sameAfterSecondSync = syncMemoryState(named, {
      ...basePerception,
      tick_time: basePerception.tick_time + 20
    });

    expect(initial.self_name).toBeUndefined();
    expect(named.self_name).toBeTruthy();
    expect(named.self_name_chosen_at).toBeTruthy();
    expect(sameAfterSecondSync.self_name).toBe(named.self_name);
  });

  it("preserves unresolved death context through wake orientation", () => {
    let memory = rememberObservation(createMemoryState(), {
      timestamp: "2026-03-10T06:00:00.000Z",
      category: "danger",
      summary: "A creeper blast tore through the tree line.",
      tags: ["danger", "combat", "explosion"],
      importance: 0.95,
      source: "perception"
    });

    memory = applyResidentEmotionEventToMemory(memory, {
      type: "resident_death",
      timestamp: "2026-03-10T06:00:01.000Z",
      cause_tags: ["death", "entity_explosion"],
      death_message: "Otis was blown up by Creeper",
      dropped_items: [{ item: "oak_log", count: 8 }],
      location: { x: 5, y: 64, z: 5 },
      world: "world"
    });

    const oriented = applyWakeOrientation(memory, {
      day_number: 1,
      created_at: "2026-03-10T06:10:00.000Z",
      immediate_needs: ["regain footing after death"],
      risk_flags: ["Creeper blast nearby"],
      carry_over_commitments: [],
      recalled_memories: [],
      current_priorities: ["recover"],
      narration: "A rough morning asks for patience."
    });

    expect(oriented.recent_dangers.at(-1)).toContain("creeper blast");
    expect(oriented.emotion_core.active_episode?.kind).toBe("death");
    expect(oriented.emotion_core.pending_interrupt?.trigger).toBe("death");
    expect(oriented.emotion_core.active_episode?.inventory_loss).toEqual([{ item: "oak_log", count: 8 }]);
  });

  it("turns beauty observations into positive emotion episodes", () => {
    const memory = rememberObservation(createMemoryState(), {
      timestamp: "2026-03-10T07:00:00.000Z",
      category: "beauty",
      summary: "Lantern light made the harbor doorway feel warm and alive.",
      tags: ["beauty", "home", "lantern"],
      importance: 0.85,
      source: "reflection",
      location: { x: 1, y: 64, z: 1 }
    });

    expect(memory.emotion_core.active_episode?.kind).toBe("beauty");
    expect(memory.emotion_core.tagged_places.some((place) => place.kind === "awe_site")).toBe(true);
    expect(memory.emotion_core.dominant_emotions).toContain("awed");
  });

  it("creates attachment bonds from first nearby meetings", () => {
    const memory = syncMemoryState(createMemoryState(), {
      ...basePerception,
      nearby_entities: [
        {
          id: "player-1",
          name: "Alex",
          type: "player",
          distance: 4,
          position: { x: 4, y: 64, z: 0 }
        }
      ]
    });

    expect(memory.emotion_core.active_episode?.kind).toBe("attachment");
    expect(memory.emotion_core.pending_interrupt?.trigger).toBe("social_contact");
    expect(memory.emotion_core.bonded_entities.some((bond) => bond.kind === "player" && bond.label === "Alex")).toBe(true);
  });

  it("creates wonder episodes from safe sunrises", () => {
    const memory = syncMemoryState(createMemoryState(), {
      ...basePerception,
      tick_time: 350,
      notable_places: ["ridge overlook"],
      terrain_affordances: [
        {
          type: "view",
          location: { x: 8, y: 67, z: 1 },
          note: "A high place with a long view."
        }
      ]
    });

    expect(["wonder", "milestone"]).toContain(memory.emotion_core.active_episode?.kind);
    expect(memory.emotion_core.pending_interrupt?.trigger).toBe("wonder");
    expect(memory.emotion_core.tagged_places.some((place) => place.kind === "awe_site")).toBe(true);
  });

  it("creates nurture episodes and herd bonds around nearby newborn animals", () => {
    const memory = syncMemoryState(createMemoryState(), {
      ...basePerception,
      nearby_entities: [
        {
          id: "sheep-baby",
          name: "sheep",
          type: "passive",
          distance: 5,
          isBaby: true,
          position: { x: 5, y: 64, z: 2 }
        }
      ],
      livestock_state: {
        ...basePerception.livestock_state,
        counts: {
          sheep: 3
        }
      }
    });

    expect(memory.emotion_core.active_episode?.kind).toBe("nurture");
    expect(memory.emotion_core.pending_interrupt?.trigger).toBe("birth");
    expect(memory.emotion_core.tagged_places.some((place) => place.kind === "nursery_site")).toBe(true);
    expect(memory.emotion_core.bonded_entities.some((bond) => bond.kind === "herd" && bond.label.includes("sheep"))).toBe(true);
  });

  it("treats home anchors as known landmarks without pretending they are secure shelter", () => {
    const memory = syncMemoryState(createMemoryState(), {
      ...basePerception,
      home_state: {
        ...basePerception.home_state,
        anchor: { x: 12, y: 64, z: -4 },
        shelterScore: 0.32,
        bedAvailable: false,
        workshopReady: false
      }
    });

    expect(memory.bootstrap_progress.homeKnown).toBe(true);
    expect(memory.bootstrap_progress.shelterSecured).toBe(false);
  });

  it("does not count sticks as structural wood reserves", () => {
    const memory = syncMemoryState(createMemoryState(), {
      ...basePerception,
      inventory: { stick: 16 },
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.25,
        bedAvailable: false,
        workshopReady: false
      }
    });

    expect(memory.bootstrap_progress.starterWoodSecured).toBe(false);
    expect(memory.bootstrap_progress.woodReserveLow).toBe(true);
  });

  it("distinguishes starter wood from a healthy structural wood reserve", () => {
    const mediumReserve = syncMemoryState(createMemoryState(), {
      ...basePerception,
      inventory: { oak_log: 8 },
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.32,
        bedAvailable: false,
        workshopReady: false
      }
    });
    const healthyReserve = syncMemoryState(createMemoryState(), {
      ...basePerception,
      inventory: { oak_log: 8, oak_planks: 8 },
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.32,
        bedAvailable: false,
        workshopReady: false
      }
    });

    expect(mediumReserve.bootstrap_progress.starterWoodSecured).toBe(true);
    expect(mediumReserve.bootstrap_progress.woodReserveLow).toBe(true);
    expect(healthyReserve.bootstrap_progress.starterWoodSecured).toBe(true);
    expect(healthyReserve.bootstrap_progress.woodReserveLow).toBe(false);
  });
});

const basePerception: PerceptionFrame = {
  agent_id: "resident-1",
  tick_time: 6000,
  position: { x: 0, y: 64, z: 0 },
  biome: "plains",
  weather: "clear",
  light_level: 15,
  health: 20,
  hunger: 18,
  inventory: { oak_log: 8, oak_planks: 8 },
  nearby_entities: [],
  nearby_blocks: [],
  home_state: {
    anchor: { x: 0, y: 64, z: 0 },
    shelterScore: 0.75,
    bedAvailable: true,
    workshopReady: true,
    guestCapacity: 0
  },
  snapshot_refs: [],
  notable_places: [],
  pantry_state: {
    carriedCalories: 200,
    pantryCalories: 200,
    cookedMeals: 1,
    cropReadiness: 0.1,
    emergencyReserveDays: 2
  },
  farm_state: {
    farmlandReady: false,
    plantedCrops: [],
    hydratedTiles: 0,
    harvestableTiles: 0,
    seedStock: {}
  },
  livestock_state: DEFAULT_LIVESTOCK_STATE,
  combat_state: {
    hostilesNearby: 0,
    armorScore: 0,
    weaponTier: "stone",
    escapeRouteKnown: true
  },
  safe_route_state: {
    homeRouteKnown: true,
    nearestShelter: { x: 0, y: 64, z: 0 },
    nightSafeRadius: 24
  },
  workstation_state: {
    craftingTableNearby: true,
    furnaceNearby: false,
    smokerNearby: false,
    blastFurnaceNearby: false,
    chestNearby: false
  },
  storage_sites: [],
  crop_sites: [],
  terrain_affordances: [],
  protected_areas: [],
  settlement_zones: []
};
