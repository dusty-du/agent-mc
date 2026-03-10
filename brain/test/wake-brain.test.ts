import { describe, expect, it } from "vitest";
import {
  COMBAT_ENGAGE_DISTANCE,
  DEFAULT_LIVESTOCK_STATE,
  DEFAULT_VALUE_PROFILE,
  MemoryState,
  PerceptionFrame
} from "@resident/shared";
import { createMemoryState } from "../src/memory/memory-state";
import { WakeBrain } from "../src/wake-brain";

const basePerception: PerceptionFrame = {
  agent_id: "resident-1",
  tick_time: 6000,
  position: { x: 0, y: 64, z: 0 },
  biome: "plains",
  weather: "clear",
  light_level: 15,
  health: 20,
  hunger: 18,
  inventory: { stone_sword: 1 },
  equipped_item: "stone_sword",
  nearby_entities: [],
  nearby_blocks: [],
  home_state: {
    anchor: { x: 0, y: 64, z: 0 },
    shelterScore: 0.75,
    bedAvailable: true,
    workshopReady: true,
    guestCapacity: 0
  },
  active_project: "",
  snapshot_refs: [],
  notable_places: [],
  pantry_state: {
    carriedCalories: 300,
    pantryCalories: 300,
    cookedMeals: 2,
    cropReadiness: 0.3,
    emergencyReserveDays: 2
  },
  farm_state: {
    farmlandReady: true,
    plantedCrops: [],
    hydratedTiles: 0,
    harvestableTiles: 0,
    seedStock: {}
  },
  livestock_state: DEFAULT_LIVESTOCK_STATE,
  combat_state: {
    hostilesNearby: 0,
    strongestThreat: undefined,
    armorScore: 5,
    weaponTier: "stone",
    shelterDistance: 6,
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

describe("WakeBrain combat decisions", () => {
  it("retreats from hostiles outside engage range when shelter is known", () => {
    const decision = new WakeBrain().decide(
      withHostile(basePerception, COMBAT_ENGAGE_DISTANCE + 4),
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hostile_detection"
    );

    expect(decision.intent.intent_type).toBe("retreat");
  });

  it("keeps moving toward a better foothold when distant hostiles are present but no retreat target is known", () => {
    const decision = new WakeBrain().decide(
      withHostile(
        {
          ...basePerception,
          inventory: {},
          home_state: {
            ...basePerception.home_state,
            anchor: undefined,
            shelterScore: 0.2,
            bedAvailable: false,
            workshopReady: false
          },
          safe_route_state: {
            homeRouteKnown: false,
            nearestShelter: undefined,
            nightSafeRadius: 24
          },
          terrain_affordances: [
            {
              type: "water",
              location: { x: 12, y: 64, z: 0 },
              note: "Water nearby for farming or quiet reflection."
            }
          ],
          pantry_state: {
            ...basePerception.pantry_state,
            carriedCalories: 0,
            pantryCalories: 0,
            cookedMeals: 0,
            emergencyReserveDays: 0
          }
        },
        COMBAT_ENGAGE_DISTANCE + 4
      ),
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hostile_detection"
    );

    expect(decision.intent.intent_type).toBe("move");
    expect(decision.intent.target).toEqual({ x: 12, y: 64, z: 0 });
  });

  it("fights only when a hostile is already within engage range and risk is acceptable", () => {
    const decision = new WakeBrain().decide(
      withHostile(basePerception, COMBAT_ENGAGE_DISTANCE - 1),
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hostile_detection"
    );

    expect(decision.intent.intent_type).toBe("fight");
  });

  it("gathers wood instead of farming air when reserves are low and trees are nearby", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        inventory: {},
        terrain_affordances: [
          {
            type: "tree",
            location: { x: 6, y: 64, z: 2 },
            note: "Wood and shade are nearby."
          }
        ],
        pantry_state: {
          ...basePerception.pantry_state,
          carriedCalories: 0,
          pantryCalories: 0,
          cookedMeals: 0,
          emergencyReserveDays: 0
        },
        farm_state: {
          ...basePerception.farm_state,
          farmlandReady: false,
          hydratedTiles: 0,
          harvestableTiles: 0,
          seedStock: {}
        }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "spawn"
    );

    expect(decision.intent.intent_type).toBe("gather");
    expect(decision.intent.target).toBe("wood");
  });

  it("moves to scout a better foothold when no immediate food action is available", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        inventory: {},
        terrain_affordances: [
          {
            type: "water",
            location: { x: 10, y: 64, z: 0 },
            note: "Water nearby for farming or quiet reflection."
          }
        ],
        pantry_state: {
          ...basePerception.pantry_state,
          carriedCalories: 0,
          pantryCalories: 0,
          cookedMeals: 0,
          emergencyReserveDays: 0
        },
        farm_state: {
          ...basePerception.farm_state,
          farmlandReady: false,
          hydratedTiles: 0,
          harvestableTiles: 0,
          seedStock: {}
        }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "spawn"
    );

    expect(decision.intent.intent_type).toBe("move");
    expect(decision.intent.target).toEqual({ x: 10, y: 64, z: 0 });
  });

  it("bootstraps materials instead of falling straight into a no-material build loop", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        inventory: {},
        home_state: {
          anchor: undefined,
          shelterScore: 0.3,
          bedAvailable: false,
          workshopReady: false,
          guestCapacity: 0
        },
        terrain_affordances: [
          {
            type: "tree",
            location: { x: 5, y: 64, z: 5 },
            note: "Wood and shade are nearby."
          }
        ],
        pantry_state: {
          ...basePerception.pantry_state,
          emergencyReserveDays: 1
        }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "spawn"
    );

    expect(decision.intent.intent_type).toBe("gather");
    expect(decision.intent.target).toBe("wood");
  });

  it("chooses and remembers a permanent self-name on spawn", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        tick_time: 0
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "spawn"
    );

    expect(decision.memory.self_name).toBeTruthy();
    expect(decision.observations.some((entry) => entry.tags.includes("identity"))).toBe(true);
    expect(decision.observations.some((entry) => entry.summary.includes(String(decision.memory.self_name)))).toBe(true);
  });

  it("retreats toward shelter at dusk instead of wandering when exposed", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        tick_time: 13000,
        home_state: {
          anchor: undefined,
          shelterScore: 0.25,
          bedAvailable: false,
          workshopReady: false,
          guestCapacity: 0
        },
        safe_route_state: {
          homeRouteKnown: false,
          nearestShelter: { x: 4, y: 64, z: 4 },
          nightSafeRadius: 24
        }
      },
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          chronotype: "steady"
        }
      }),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "dusk"
    );

    expect(decision.intent.intent_type).toBe("retreat");
    expect(decision.intent.target).toEqual({ x: 4, y: 64, z: 4 });
  });

  it("pivots away from farm after repeated blocked farm attempts", () => {
    const memory = createMemoryWith({
      bootstrap_progress: {
        woodSecured: true,
        toolsReady: true,
        shelterSecured: true,
        lightSecured: true,
        foodSecured: true,
        bedSecured: true
      },
      recent_action_snapshots: [
        {
          timestamp: "2026-03-09T12:00:00.000Z",
          intent_type: "farm",
          target_class: "farm",
          status: "blocked",
          position_delta: 0,
          risk_context: "safe"
        },
        {
          timestamp: "2026-03-09T12:04:00.000Z",
          intent_type: "farm",
          target_class: "farm",
          status: "blocked",
          position_delta: 0,
          risk_context: "safe"
        }
      ]
    });

    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        pantry_state: {
          ...basePerception.pantry_state,
          emergencyReserveDays: 2
        },
        farm_state: {
          ...basePerception.farm_state,
          harvestableTiles: 3,
          farmlandReady: true
        }
      },
      memory,
      DEFAULT_VALUE_PROFILE,
      undefined,
      "idle_check"
    );

    expect(decision.intent.intent_type).not.toBe("farm");
  });

  it("lets different personalities choose different believable calm actions", () => {
    const frame = {
      ...basePerception,
      nearby_entities: [
        {
          id: "player-1",
          name: "Alex",
          type: "player" as const,
          distance: 4
        }
      ],
      notable_places: ["river bend"],
      terrain_affordances: [
        {
          type: "view" as const,
          location: { x: 12, y: 66, z: 6 },
          note: "A high overlook above the river."
        }
      ]
    };
    const sharedValues = {
      ...DEFAULT_VALUE_PROFILE,
      curiosity: 0.82,
      beauty: 0.76,
      hospitality: 0.66,
      sociability: 0.62
    };

    const hostDecision = new WakeBrain().decide(
      frame,
      createMemoryWith({
        bootstrap_progress: {
          woodSecured: true,
          toolsReady: true,
          shelterSecured: true,
          lightSecured: true,
          foodSecured: true,
          bedSecured: true
        },
        personality_profile: {
          ...createMemoryState().personality_profile,
          traits: {
            openness: 0.42,
            conscientiousness: 0.6,
            extraversion: 0.86,
            agreeableness: 0.82,
            threat_sensitivity: 0.35
          },
          motifs: {
            primary: "host",
            secondary: "homesteader"
          },
          style_tags: ["host", "warm", "gentle"]
        }
      }),
      sharedValues,
      undefined,
      "idle_check"
    );

    const wandererDecision = new WakeBrain().decide(
      frame,
      createMemoryWith({
        bootstrap_progress: {
          woodSecured: true,
          toolsReady: true,
          shelterSecured: true,
          lightSecured: true,
          foodSecured: true,
          bedSecured: true
        },
        personality_profile: {
          ...createMemoryState().personality_profile,
          traits: {
            openness: 0.88,
            conscientiousness: 0.34,
            extraversion: 0.24,
            agreeableness: 0.42,
            threat_sensitivity: 0.2
          },
          motifs: {
            primary: "wanderer",
            secondary: "tinkerer"
          },
          style_tags: ["wanderer", "curious"]
        }
      }),
      sharedValues,
      undefined,
      "idle_check"
    );

    expect(hostDecision.intent.intent_type).toBe("socialize");
    expect(wandererDecision.intent.intent_type).not.toBe(hostDecision.intent.intent_type);
  });

  it("uses respawn emotion interrupts to reorient instead of dropping back into bootstrap autopilot", () => {
    const memory = createMemoryWith({
      bootstrap_progress: {
        woodSecured: false,
        toolsReady: false,
        shelterSecured: false,
        lightSecured: false,
        foodSecured: false,
        bedSecured: false
      },
      emotion_core: {
        ...createMemoryState().emotion_core,
        axes: {
          threat: 0.72,
          loss: 0.48,
          pain: 0.84,
          curiosity: 0.18,
          connection: 0.2,
          comfort: 0.1,
          mastery: 0.22,
          wonder: 0.04
        },
        regulation: {
          arousal: 0.88,
          shock: 0.92,
          vigilance: 0.78,
          resolve: 0.3,
          recovery: 0.18
        },
        action_biases: {
          avoid_risk: 0.82,
          seek_shelter: 0.76,
          seek_recovery: 0.8,
          seek_company: 0.12,
          seek_mastery: 0.18,
          seek_wonder: 0.04,
          cautious_revisit: 0.78
        },
        dominant_emotions: ["shaken", "wary"],
        active_episode: {
          id: "death:1",
          kind: "death",
          summary: "Otis was blown up by Creeper",
          started_at: "2026-03-10T06:00:00.000Z",
          updated_at: "2026-03-10T06:00:05.000Z",
          source_trigger: "death",
          dominant_emotions: ["shaken", "wary"],
          cause_tags: ["death", "entity_explosion"],
          world: "world",
          focal_location: { x: 6, y: 64, z: 6 },
          respawn_location: { x: 0, y: 64, z: 0 },
          inventory_loss: [{ item: "oak_log", count: 8 }],
          appraisal: {
            threat: 0.72,
            loss: 0.48,
            pain: 0.84,
            curiosity: 0.18,
            connection: 0.2,
            comfort: 0.1,
            mastery: 0.22,
            wonder: 0.04
          },
          regulation: {
            arousal: 0.88,
            shock: 0.92,
            vigilance: 0.78,
            resolve: 0.3,
            recovery: 0.18
          },
          intensity: 0.82,
          revisit_policy: "cautious",
          resolved: false
        },
        tagged_places: [
          {
            kind: "death_site",
            label: "entity explosion",
            location: { x: 6, y: 64, z: 6 },
            world: "world",
            salience: 0.94,
            cause_tags: ["death", "entity_explosion"],
            revisit_policy: "cautious",
            updated_at: "2026-03-10T06:00:05.000Z"
          }
        ],
        pending_interrupt: {
          trigger: "respawn",
          reason: "Respawning should interrupt routine.",
          created_at: "2026-03-10T06:00:05.000Z"
        }
      }
    });

    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        health: 14,
        hunger: 10,
        inventory: {},
        home_state: {
          ...basePerception.home_state,
          shelterScore: 0.25,
          bedAvailable: false,
          workshopReady: false
        },
        safe_route_state: {
          ...basePerception.safe_route_state,
          nearestShelter: { x: 0, y: 64, z: 0 }
        }
      },
      memory,
      DEFAULT_VALUE_PROFILE,
      undefined,
      "respawn"
    );

    expect(["move", "recover", "observe", "retreat"]).toContain(decision.intent.intent_type);
    expect(decision.intent.intent_type).not.toBe("gather");
    expect(decision.intent.dialogue?.toLowerCase()).toContain("explosion");
    expect(decision.observations.some((entry) => entry.tags.includes("emotion"))).toBe(true);
  });

  it("prioritizes crafting torches before dusk when light is unsecured", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        tick_time: 11800,
        light_level: 5,
        inventory: {
          crafting_table: 1,
          coal: 2,
          stick: 4,
          oak_planks: 8
        },
        home_state: {
          ...basePerception.home_state,
          workshopReady: false
        }
      },
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          chronotype: "steady"
        },
        bootstrap_progress: {
          woodSecured: true,
          toolsReady: true,
          shelterSecured: true,
          lightSecured: false,
          foodSecured: true,
          bedSecured: true
        }
      }),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "idle_check"
    );

    expect(decision.intent.intent_type).toBe("craft");
    expect(decision.intent.target).toBe("torch");
  });
});

function withHostile(frame: PerceptionFrame, distance: number): PerceptionFrame {
  return {
    ...frame,
    nearby_entities: [
      {
        id: "hostile-1",
        name: "zombie",
        type: "hostile",
        distance,
        position: { x: distance, y: 64, z: 0 },
        isAggressive: true
      }
    ],
    combat_state: {
      ...frame.combat_state,
      hostilesNearby: 1,
      strongestThreat: "zombie",
      shelterDistance: frame.safe_route_state.nearestShelter ? distance : undefined
    }
  };
}

function createMemoryWith(overrides: Partial<MemoryState>): MemoryState {
  return {
    ...createMemoryState(),
    ...overrides
  };
}
