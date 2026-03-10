import { describe, expect, it } from "vitest";
import { driftResidentPersonality, createResidentPersonality } from "../src/personality";

describe("resident personality", () => {
  it("is deterministic for a given seed and varied across different seeds", () => {
    const first = createResidentPersonality("resident-alpha");
    const second = createResidentPersonality("resident-alpha");
    const third = createResidentPersonality("resident-bravo");

    expect(second.seed).toBe(first.seed);
    expect(second.traits).toEqual(first.traits);
    expect(second.motifs).toEqual(first.motifs);
    expect(second.style_tags).toEqual(first.style_tags);
    expect(third.traits).not.toEqual(first.traits);
  });

  it("drifts slowly from overnight outcomes instead of rewriting identity", () => {
    const profile = createResidentPersonality("resident-alpha");
    const drifted = driftResidentPersonality(profile, {
      dayNumber: 3,
      survived: true,
      sleptInBed: true,
      mealsConsumed: 3,
      hungerEmergencies: 0,
      damageTaken: 1,
      combatsWon: 0,
      retreatsUsed: 0,
      hostedPlayers: 2,
      explorationMoments: 3,
      craftedItems: 2,
      buildActions: 4,
      livestockStable: true,
      joyMoments: 2,
      setbacksFaced: 1,
      recoveryMoments: 1,
      meaningMoments: 2
    });

    expect(drifted.seed).toBe(profile.seed);
    expect(Math.abs(drifted.traits.openness - profile.traits.openness)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(drifted.traits.conscientiousness - profile.traits.conscientiousness)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(drifted.traits.extraversion - profile.traits.extraversion)).toBeLessThanOrEqual(0.02);
    expect(drifted.style_tags.length).toBeGreaterThan(0);
  });
});
