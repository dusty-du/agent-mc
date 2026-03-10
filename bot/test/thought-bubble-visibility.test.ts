import { describe, expect, it } from "vitest";
import { DEFAULT_THOUGHT_BUBBLE_HIDE_GRACE_MS, resolveStickyVisibility } from "../src/thought-bubble-visibility";

describe("resolveStickyVisibility", () => {
  it("shows immediately when the bubble can render", () => {
    expect(resolveStickyVisibility(true, 1_000, 900)).toEqual({
      hiddenSinceMs: null,
      visible: true
    });
  });

  it("keeps the bubble visible briefly after the first missed frame", () => {
    expect(resolveStickyVisibility(false, 1_000, null)).toEqual({
      hiddenSinceMs: 1_000,
      visible: true
    });
  });

  it("hides the bubble once the grace window elapses", () => {
    expect(resolveStickyVisibility(false, 1_000 + DEFAULT_THOUGHT_BUBBLE_HIDE_GRACE_MS, 1_000)).toEqual({
      hiddenSinceMs: 1_000,
      visible: false
    });
  });

  it("resets the missed-frame timer after the bubble becomes renderable again", () => {
    const transient = resolveStickyVisibility(false, 1_000, null);
    expect(transient.visible).toBe(true);

    expect(resolveStickyVisibility(true, 1_050, transient.hiddenSinceMs)).toEqual({
      hiddenSinceMs: null,
      visible: true
    });
  });
});
