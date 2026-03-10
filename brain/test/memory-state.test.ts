import { describe, expect, it } from "vitest";
import { buildMemoryBundle, rememberActionReport, rememberActionSnapshot, rememberObservation } from "../src/memory/memory-state";
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
    let memory = createMemoryState();

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
    expect(bundle.personality_profile.seed).toBe(memory.personality_profile.seed);
    expect(bundle.need_state).toEqual(memory.need_state);
    expect(bundle.bootstrap_progress).toEqual(memory.bootstrap_progress);
    expect(bundle.recent_action_snapshots).toHaveLength(16);
  });
});
