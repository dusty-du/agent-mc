import { describe, expect, it } from "vitest";
import {
  COMBAT_ENGAGE_DISTANCE,
  DEFAULT_LIVESTOCK_STATE,
  DEFAULT_VALUE_PROFILE,
  MemoryState,
  PerceptionFrame
} from "@resident/shared";
import { composeEmotionDialogue } from "../src/emotion-core";
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

  it("keeps moving toward safer shelter footing when distant hostiles are present but no retreat target is known", () => {
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
              type: "flat",
              location: { x: 12, y: 64, z: 0 },
              note: "Open ground nearby that is easier to secure."
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
        home_state: {
          ...basePerception.home_state,
          anchor: undefined,
          shelterScore: 0.3,
          bedAvailable: false,
          workshopReady: false
        },
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

  it("does not keep regathering wood once wood bootstrap is already secured", () => {
    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        inventory: {
          oak_log: 12
        },
        terrain_affordances: [
          {
            type: "tree",
            location: { x: 6, y: 64, z: 2 },
            note: "Wood and shade are nearby."
          },
          {
            type: "water",
            location: { x: 10, y: 64, z: 0 },
            note: "Water nearby for farming or quiet reflection."
          }
        ],
        home_state: {
          ...basePerception.home_state,
          anchor: undefined,
          shelterScore: 0.3,
          bedAvailable: false,
          workshopReady: false
        },
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
      createMemoryWith({
        bootstrap_progress: {
          starterWoodSecured: true,
          woodReserveLow: false,
          woodSecured: true,
          toolsReady: false,
          shelterSecured: false,
          lightSecured: false,
          foodSecured: false,
          bedSecured: false
        }
      }),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "task_failure"
    );

    expect(decision.intent.intent_type).not.toBe("gather");
    expect(decision.intent.dialogue?.toLowerCase()).not.toContain("i need wood before this place can start feeling livable");
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
        starterWoodSecured: true,
        woodReserveLow: false,
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
          starterWoodSecured: true,
          woodReserveLow: false,
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
          starterWoodSecured: true,
          woodReserveLow: false,
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
        starterWoodSecured: false,
        woodReserveLow: true,
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
        bonded_entities: [],
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

  it("lets wonder interrupts produce a deliberate observe turn instead of routine work", () => {
    const memory = createMemoryWith({
      emotion_core: {
        ...createMemoryState().emotion_core,
        active_episode: {
          id: "wonder:1",
          kind: "wonder",
          summary: "Sunrise made the river bend feel newly alive.",
          started_at: "2026-03-10T06:00:00.000Z",
          updated_at: "2026-03-10T06:00:10.000Z",
          source_trigger: "wonder",
          dominant_emotions: ["awed"],
          cause_tags: ["sunrise", "wonder"],
          focal_location: { x: 3, y: 64, z: 3 },
          subject_kind: "moment",
          subject_id_or_label: "sunrise",
          novelty: 0.82,
          inventory_loss: [],
          appraisal: {
            threat: 0.02,
            loss: 0.01,
            pain: 0.01,
            curiosity: 0.62,
            connection: 0.18,
            comfort: 0.32,
            mastery: 0.14,
            wonder: 0.86
          },
          regulation: {
            arousal: 0.34,
            shock: 0.01,
            vigilance: 0.04,
            resolve: 0.3,
            recovery: 0.64
          },
          intensity: 0.7,
          revisit_policy: "open",
          resolved: false
        },
        pending_interrupt: {
          trigger: "wonder",
          reason: "A strong wonder moment deserves a pause.",
          created_at: "2026-03-10T06:00:10.000Z"
        }
      }
    });

    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        tick_time: 320,
        notable_places: ["river bend"],
        terrain_affordances: [
          {
            type: "view",
            location: { x: 6, y: 66, z: 1 },
            note: "A high overlook."
          }
        ]
      },
      memory,
      DEFAULT_VALUE_PROFILE,
      undefined,
      "wonder"
    );

    expect(decision.intent.intent_type).toBe("observe");
    expect(decision.intent.dialogue).toContain("worth");
  });

  it("varies neutral observe dialogue by personality and surroundings instead of repeating one canned line", () => {
    const scenicFrame: PerceptionFrame = {
      ...basePerception,
      notable_places: ["river bend"],
      terrain_affordances: [
        {
          type: "view",
          location: { x: 6, y: 66, z: 1 },
          note: "A high overlook."
        }
      ]
    };
    const fallback = "I want one clear read of the moment before I commit.";
    const caretakerDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "caretaker-seed",
          traits: {
            openness: 0.36,
            conscientiousness: 0.58,
            extraversion: 0.28,
            agreeableness: 0.82,
            threat_sensitivity: 0.71
          },
          motifs: {
            primary: "caretaker",
            secondary: "sentinel"
          },
          style_tags: ["caretaker", "sentinel", "gentle", "cautious"]
        }
      }),
      scenicFrame,
      fallback,
      "observe"
    );
    const wandererDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "wanderer-seed",
          traits: {
            openness: 0.8,
            conscientiousness: 0.44,
            extraversion: 0.42,
            agreeableness: 0.46,
            threat_sensitivity: 0.26
          },
          motifs: {
            primary: "wanderer",
            secondary: "tinkerer"
          },
          style_tags: ["wanderer", "tinkerer", "curious"]
        }
      }),
      scenicFrame,
      fallback,
      "observe"
    );

    expect(caretakerDialogue).not.toBe(fallback);
    expect(wandererDialogue).not.toBe(fallback);
    expect(caretakerDialogue).not.toBe(wandererDialogue);
    expect(caretakerDialogue.toLowerCase()).toMatch(/river bend|land opening out ahead/);
    expect(wandererDialogue.toLowerCase()).toMatch(/river bend|land opening out ahead/);
  });

  it("varies neutral gather dialogue by personality instead of repeating one wood sentence", () => {
    const woodedFrame: PerceptionFrame = {
      ...basePerception,
      terrain_affordances: [
        {
          type: "tree",
          location: { x: 5, y: 64, z: 2 },
          note: "Wood and shade are nearby."
        }
      ]
    };
    const fallback = "I need wood before this place can start feeling livable.";
    const sentinelDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "sentinel-gather-seed",
          traits: {
            openness: 0.34,
            conscientiousness: 0.63,
            extraversion: 0.24,
            agreeableness: 0.44,
            threat_sensitivity: 0.81
          },
          motifs: {
            primary: "sentinel",
            secondary: "homesteader"
          },
          style_tags: ["sentinel", "homesteader", "cautious"]
        }
      }),
      woodedFrame,
      fallback,
      "gather"
    );
    const hostDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "host-gather-seed",
          traits: {
            openness: 0.52,
            conscientiousness: 0.48,
            extraversion: 0.78,
            agreeableness: 0.75,
            threat_sensitivity: 0.29
          },
          motifs: {
            primary: "host",
            secondary: "caretaker"
          },
          style_tags: ["host", "caretaker", "warm", "gentle"]
        }
      }),
      woodedFrame,
      fallback,
      "gather"
    );

    expect(sentinelDialogue).not.toBe(fallback);
    expect(hostDialogue).not.toBe(fallback);
    expect(sentinelDialogue).not.toBe(hostDialogue);
    expect(sentinelDialogue.toLowerCase()).toMatch(/wood|tree line|shelter/);
    expect(hostDialogue.toLowerCase()).toMatch(/wood|tree line|shelter/);
  });

  it("varies neutral build dialogue by personality instead of repeating one stock home line", () => {
    const exposedFrame: PerceptionFrame = {
      ...basePerception,
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.26,
        bedAvailable: false,
        workshopReady: false
      }
    };
    const fallback = "I want to make this place feel more like home.";
    const sentinelDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "sentinel-build-seed",
          traits: {
            openness: 0.31,
            conscientiousness: 0.68,
            extraversion: 0.22,
            agreeableness: 0.4,
            threat_sensitivity: 0.82
          },
          motifs: {
            primary: "sentinel",
            secondary: "homesteader"
          },
          style_tags: ["sentinel", "homesteader", "cautious"]
        }
      }),
      exposedFrame,
      fallback,
      "build"
    );
    const hostDialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "host-build-seed",
          traits: {
            openness: 0.56,
            conscientiousness: 0.52,
            extraversion: 0.81,
            agreeableness: 0.78,
            threat_sensitivity: 0.24
          },
          motifs: {
            primary: "host",
            secondary: "caretaker"
          },
          style_tags: ["host", "caretaker", "warm", "gentle"]
        }
      }),
      exposedFrame,
      fallback,
      "build"
    );

    expect(sentinelDialogue).not.toBe(fallback);
    expect(hostDialogue).not.toBe(fallback);
    expect(sentinelDialogue).not.toBe(hostDialogue);
    expect(sentinelDialogue.toLowerCase()).toMatch(/shelter|cover|exposed|home/);
    expect(hostDialogue.toLowerCase()).toMatch(/welcoming|warmer|home|shelter/);
  });

  it("rotates neutral build dialogue away from the last repeated thought", () => {
    const frame: PerceptionFrame = {
      ...basePerception,
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.26,
        bedAvailable: false,
        workshopReady: false
      }
    };
    const baseMemory = createMemoryWith({
      personality_profile: {
        ...createMemoryState().personality_profile,
        seed: "repeat-build-seed",
        motifs: {
          primary: "homesteader",
          secondary: "sentinel"
        },
        style_tags: ["homesteader", "sentinel", "steady"]
      }
    });
    const firstLine = composeEmotionDialogue(baseMemory, frame, "I want to make this place feel more like home.", "build");
    const repeatedMemory = createMemoryWith({
      ...baseMemory,
      recent_observations: [
        {
          timestamp: "2026-03-10T06:00:00.000Z",
          category: "building",
          summary: firstLine,
          tags: ["thought", "dialogue", "build"],
          importance: 0.24,
          source: "dialogue"
        }
      ]
    });

    const rotatedLine = composeEmotionDialogue(repeatedMemory, frame, "I want to make this place feel more like home.", "build");

    expect(rotatedLine).not.toBe(firstLine);
    expect(rotatedLine.toLowerCase()).toMatch(/shelter|home|stay|shape/);
  });

  it("keeps move dialogue varied even when an active loss episode is steering the turn", () => {
    const frame: PerceptionFrame = {
      ...basePerception,
      terrain_affordances: [
        {
          type: "tree",
          location: { x: 8, y: 64, z: -2 },
          note: "A tree line worth checking."
        }
      ],
      home_state: {
        ...basePerception.home_state,
        shelterScore: 0.28,
        bedAvailable: false,
        workshopReady: false
      }
    };
    const fallback = "I should head toward the tree line and see what it offers.";
    const dialogue = composeEmotionDialogue(
      createMemoryWith({
        emotion_core: {
          ...createMemoryState().emotion_core,
          active_episode: {
            id: "loss-1",
            kind: "loss",
            summary: "Navigation kept failing.",
            started_at: "2026-03-10T06:00:00.000Z",
            updated_at: "2026-03-10T06:01:00.000Z",
            source_trigger: "task_failure",
            dominant_emotions: ["steady"],
            cause_tags: ["failure", "move"],
            inventory_loss: [],
            appraisal: {
              threat: 0.22,
              loss: 0.64,
              pain: 0.08,
              curiosity: 0.34,
              connection: 0.28,
              comfort: 0.22,
              mastery: 0.3,
              wonder: 0.16
            },
            regulation: {
              arousal: 0.42,
              shock: 0.18,
              vigilance: 0.34,
              resolve: 0.4,
              recovery: 0.24
            },
            salience: 0.64,
            intensity: 0.6,
            revisit_policy: "open",
            resolved: false
          }
        }
      }),
      frame,
      fallback,
      "move"
    );

    expect(dialogue).not.toBe(fallback);
    expect(dialogue.toLowerCase()).toMatch(/needles|setback|failure|move/);
    expect(dialogue.toLowerCase()).toMatch(/tree line|safer ground|open ground/);
  });

  it("turns internal place labels into natural observe speech", () => {
    const dialogue = composeEmotionDialogue(
      createMemoryWith({
        personality_profile: {
          ...createMemoryState().personality_profile,
          seed: "caretaker-ground-seed",
          motifs: {
            primary: "caretaker",
            secondary: "sentinel"
          },
          style_tags: ["caretaker", "sentinel", "gentle", "cautious"]
        }
      }),
      {
        ...basePerception,
        notable_places: ["good building ground"],
        terrain_affordances: []
      },
      "I want one clear read of the moment before I commit.",
      "observe"
    );

    expect(dialogue.toLowerCase()).not.toContain("good building ground");
    expect(dialogue.toLowerCase()).toContain("flat patch of ground");
  });

  it("breaks out of repeated stationary observe loops by scouting instead of observing again", () => {
    const memory = createMemoryWith({
      bootstrap_progress: {
        starterWoodSecured: true,
        woodReserveLow: false,
        woodSecured: true,
        toolsReady: false,
        shelterSecured: false,
        lightSecured: false,
        foodSecured: false,
        bedSecured: false
      },
      recent_action_snapshots: Array.from({ length: 4 }, (_, index) => ({
        timestamp: `2026-03-10T06:00:0${index}.000Z`,
        intent_type: "observe" as const,
        target_class: "observe",
        status: "completed" as const,
        position_delta: 0,
        risk_context: "exposed" as const
      }))
    });

    const decision = new WakeBrain().decide(
      {
        ...basePerception,
        tick_time: 6000,
        nearby_blocks: [],
        terrain_affordances: [],
        home_state: {
          ...basePerception.home_state,
          shelterScore: 0.3,
          bedAvailable: false,
          workshopReady: false
        }
      },
      memory,
      DEFAULT_VALUE_PROFILE,
      undefined,
      "task_completion"
    );

    expect(decision.intent.intent_type).not.toBe("observe");
    expect(decision.intent.dialogue?.toLowerCase()).not.toContain("good building ground");
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
          starterWoodSecured: true,
          woodReserveLow: false,
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

type TestMemoryOverrides = Omit<Partial<MemoryState>, "bootstrap_progress"> & {
  bootstrap_progress?: Partial<MemoryState["bootstrap_progress"]>;
};

function createMemoryWith(overrides: TestMemoryOverrides): MemoryState {
  const base = createMemoryState();
  return {
    ...base,
    ...overrides,
    bootstrap_progress: {
      ...base.bootstrap_progress,
      ...overrides.bootstrap_progress
    }
  };
}
