import { describe, expect, it } from "vitest";
import {
  COMBAT_ENGAGE_DISTANCE,
  DEFAULT_LIVESTOCK_STATE,
  DEFAULT_VALUE_PROFILE,
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

  it("observes distant hostiles when no retreat target is known", () => {
    const decision = new WakeBrain().decide(
      withHostile(
        {
          ...basePerception,
          home_state: {
            ...basePerception.home_state,
            anchor: undefined
          },
          safe_route_state: {
            homeRouteKnown: false,
            nearestShelter: undefined,
            nightSafeRadius: 24
          }
        },
        COMBAT_ENGAGE_DISTANCE + 4
      ),
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hostile_detection"
    );

    expect(decision.intent.intent_type).toBe("observe");
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
