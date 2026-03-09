import { describe, expect, it } from "vitest";
import { rememberActionReport, rememberObservation } from "../src/memory/memory-state";
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
});
