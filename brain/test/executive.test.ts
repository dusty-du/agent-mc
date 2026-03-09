import { describe, expect, it } from "vitest";
import { DEFAULT_LIVESTOCK_STATE, DEFAULT_VALUE_PROFILE, PerceptionFrame } from "@resident/shared";
import { createMemoryState } from "../src/memory/memory-state";
import { ResidentExecutive } from "../src/executive/resident-executive";

const basePerception: PerceptionFrame = {
  agent_id: "resident-1",
  tick_time: 6000,
  position: { x: 0, y: 64, z: 0 },
  biome: "plains",
  weather: "clear",
  light_level: 15,
  health: 20,
  hunger: 18,
  inventory: { oak_log: 8, wheat: 3, iron_ingot: 1, oak_planks: 8 },
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
  notable_places: ["river bend"],
  pantry_state: {
    carriedCalories: 300,
    pantryCalories: 300,
    cookedMeals: 2,
    cropReadiness: 0.8,
    emergencyReserveDays: 2
  },
  farm_state: {
    farmlandReady: true,
    plantedCrops: ["wheat"],
    hydratedTiles: 6,
    harvestableTiles: 2,
    seedStock: {}
  },
  livestock_state: DEFAULT_LIVESTOCK_STATE,
  combat_state: {
    hostilesNearby: 0,
    armorScore: 5,
    weaponTier: "stone",
    escapeRouteKnown: true
  },
  safe_route_state: {
    homeRouteKnown: true,
    nearestShelter: { x: 0, y: 64, z: 0 },
    nightSafeRadius: 24
  }
};

describe("ResidentExecutive", () => {
  it("keeps urgent heuristic intents over model suggestions", async () => {
    const executive = new ResidentExecutive({
      async suggest() {
        return {
          intent: {
            agent_id: "resident-1",
            intent_type: "build",
            target: "a gazebo",
            reason: "It would be pretty.",
            priority: 4,
            cancel_conditions: [],
            success_conditions: [],
            dialogue: "I want to build."
          }
        };
      }
    });

    const decision = await executive.decide(
      {
        ...basePerception,
        hunger: 6,
        pantry_state: { ...basePerception.pantry_state, emergencyReserveDays: 0.3 }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hunger_threshold"
    );

    expect(["eat", "farm"]).toContain(decision.intent.intent_type);
  });

  it("accepts model suggestions when the situation is calm", async () => {
    const executive = new ResidentExecutive({
      async suggest() {
        return {
          intent: {
            agent_id: "resident-1",
            intent_type: "socialize",
            target: "fireside conversation",
            reason: "A shared evening matters today.",
            priority: 4,
            cancel_conditions: ["danger appears"],
            success_conditions: ["kind moment created"],
            dialogue: "I would like to be warm and welcoming tonight."
          },
          observation: {
            timestamp: new Date().toISOString(),
            category: "social",
            summary: "A calm evening feels right for warmth and conversation.",
            tags: ["social", "hospitality"],
            importance: 0.6,
            source: "reflection"
          }
        };
      }
    });

    const decision = await executive.decide(
      {
        ...basePerception,
        farm_state: {
          ...basePerception.farm_state,
          harvestableTiles: 0
        },
        livestock_state: {
          ...basePerception.livestock_state,
          counts: {
            chicken: 2,
            sheep: 2,
            cow: 2,
            pig: 2
          }
        },
        pantry_state: {
          ...basePerception.pantry_state,
          emergencyReserveDays: 3
        }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "idle_check"
    );
    expect(decision.intent.intent_type).toBe("socialize");
    expect(decision.observations.some((entry) => entry.tags.includes("hospitality"))).toBe(true);
  });
});
