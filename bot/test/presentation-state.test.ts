import { describe, expect, it } from "vitest";
import { DEFAULT_PRESENTATION_TTL_MS, ResidentPresentationController } from "../src/presentation-state";

describe("ResidentPresentationController", () => {
  it("publishes the current thought with a default expiry window", () => {
    const controller = new ResidentPresentationController();

    controller.publishThought({
      residentId: "resident-1",
      residentName: "resident-1",
      text: "I should head home.",
      nowMs: 1_000
    });

    expect(controller.getPresentationState(1_001)).toEqual({
      thought: {
        residentId: "resident-1",
        residentName: "resident-1",
        text: "I should head home.",
        createdAt: new Date(1_000).toISOString(),
        expiresAt: new Date(1_000 + DEFAULT_PRESENTATION_TTL_MS).toISOString()
      }
    });
  });

  it("expires the active thought once its ttl has passed", () => {
    const controller = new ResidentPresentationController();

    controller.publishThought({
      residentId: "resident-1",
      residentName: "resident-1",
      text: "I should look around first.",
      ttlMs: 500,
      nowMs: 2_000
    });

    expect(controller.getPresentationState(2_100).thought?.text).toBe("I should look around first.");
    expect(controller.getPresentationState(2_501)).toEqual({ thought: null });
  });
});
