import { describe, expect, it } from "vitest";
import { DEFAULT_LIVESTOCK_STATE, DEFAULT_VALUE_PROFILE, PerceptionFrame } from "@resident/shared";
import { createMemoryState } from "../src/memory/memory-state";
import { SemanticBuildPlanner } from "../src/planning/build-planner";
import { CraftPlanner } from "../src/planning/craft-planner";
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
  inventory: { oak_log: 8, wheat: 3, iron_ingot: 1, oak_planks: 8 },
  equipped_item: "stone_sword",
  nearby_entities: [],
  nearby_blocks: [],
  home_state: {
    anchor: { x: 0, y: 64, z: 0 },
    shelterScore: 0.42,
    bedAvailable: false,
    workshopReady: false,
    guestCapacity: 0
  },
  active_project: "",
  snapshot_refs: [],
  notable_places: [],
  pantry_state: {
    carriedCalories: 300,
    pantryCalories: 120,
    cookedMeals: 0,
    cropReadiness: 0.2,
    emergencyReserveDays: 0.5
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
  }
};

describe("CraftPlanner", () => {
  it("builds a multi-step plan for a shield", () => {
    const planner = new CraftPlanner();
    const goal = planner.plan("shield", 1, "defensive survival", basePerception);
    expect(goal.recipe_path.some((step) => step.item === "shield")).toBe(true);
    expect(goal.required_tools).toContain("furnace");
  });
});

describe("SemanticBuildPlanner", () => {
  it("creates salvage-aware rebuild stages", () => {
    const planner = new SemanticBuildPlanner();
    const plan = planner.plan(
      {
        purpose: "replace ugly wall and expand for guests",
        site: { center: { x: 0, y: 64, z: 0 }, radius: 10 },
        style_tags: ["welcoming", "cozy"],
        functional_requirements: ["guest bed", "storage"],
        aesthetic_goals: ["replace ugly wall", "more light"],
        materials_preference: ["oak_planks", "glass"],
        expandable: true,
        rebuild_of: "old front room"
      },
      basePerception
    );

    expect(plan.stages.length).toBeGreaterThanOrEqual(4);
    expect(plan.salvage_steps.length).toBeGreaterThan(0);
  });
});

describe("WakeBrain", () => {
  it("prioritizes food when reserves are low", () => {
    const brain = new WakeBrain();
    const decision = brain.decide(
      {
        ...basePerception,
        hunger: 6,
        pantry_state: { ...basePerception.pantry_state, emergencyReserveDays: 0.2 }
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      undefined,
      "hunger_threshold"
    );

    expect(["eat", "farm"]).toContain(decision.intent.intent_type);
  });

  it("creates a wake orientation from immediate reality plus overnight memory", () => {
    const brain = new WakeBrain();
    const decision = brain.decide(
      {
        ...basePerception,
        tick_time: 100,
        weather: "rain",
        hunger: 9
      },
      createMemoryState(),
      DEFAULT_VALUE_PROFILE,
      {
        day_number: 0,
        created_at: new Date().toISOString(),
        summary: "A difficult but meaningful day.",
        insights: ["Failure can still be part of a good life."],
        carry_over_commitments: ["repair the home entrance"],
        risk_themes: ["Hostiles near the tree line."],
        place_memories: ["home", "quiet corner"],
        project_memories: ["Repair shelter roof."],
        value_shift_summary: ["social: appreciated kindness"],
        creative_motifs: ["A warm doorway against the rain."]
      },
      "wake"
    );

    expect(decision.wakeOrientation?.carry_over_commitments).toContain("repair the home entrance");
    expect(decision.wakeOrientation?.narration).toContain("morning");
  });
});
