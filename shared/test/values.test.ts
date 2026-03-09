import { describe, expect, it } from "vitest";
import { DEFAULT_VALUE_PROFILE, updateValueProfile } from "../src";

describe("updateValueProfile", () => {
  it("keeps survival floors high even after a rough day", () => {
    const next = updateValueProfile(DEFAULT_VALUE_PROFILE, {
      dayNumber: 3,
      survived: false,
      sleptInBed: false,
      mealsConsumed: 0,
      hungerEmergencies: 2,
      damageTaken: 18,
      combatsWon: 0,
      retreatsUsed: 1,
      hostedPlayers: 0,
      explorationMoments: 0,
      craftedItems: 0,
      buildActions: 0,
      livestockStable: false,
      joyMoments: 0
    });

    expect(next.survival).toBeGreaterThanOrEqual(0.8);
    expect(next.food_security).toBeGreaterThanOrEqual(0.75);
    expect(next.safety).toBeGreaterThanOrEqual(0.72);
  });

  it("responds to culture feedback without exploding to extremes", () => {
    const next = updateValueProfile(
      DEFAULT_VALUE_PROFILE,
      {
        dayNumber: 7,
        survived: true,
        sleptInBed: true,
        mealsConsumed: 4,
        hungerEmergencies: 0,
        damageTaken: 1,
        combatsWon: 1,
        retreatsUsed: 1,
        hostedPlayers: 2,
        explorationMoments: 3,
        craftedItems: 6,
        buildActions: 18,
        livestockStable: true,
        joyMoments: 4
      },
      [
        {
          source_player: "ExamplePlayer",
          signal_type: "praise",
          topic: "build home social",
          valence: 1,
          strength: 4,
          timestamp: new Date().toISOString()
        }
      ]
    );

    expect(next.hospitality).toBeGreaterThan(DEFAULT_VALUE_PROFILE.hospitality);
    expect(next.beauty).toBeGreaterThan(DEFAULT_VALUE_PROFILE.beauty);
    expect(next.hospitality).toBeLessThanOrEqual(1);
  });

  it("allows joy to grow through recovery and meaning, not only clean success", () => {
    const next = updateValueProfile(DEFAULT_VALUE_PROFILE, {
      dayNumber: 9,
      survived: true,
      sleptInBed: true,
      mealsConsumed: 3,
      hungerEmergencies: 0,
      damageTaken: 9,
      combatsWon: 0,
      retreatsUsed: 2,
      hostedPlayers: 0,
      explorationMoments: 1,
      craftedItems: 1,
      buildActions: 2,
      livestockStable: true,
      joyMoments: 1,
      setbacksFaced: 2,
      recoveryMoments: 2,
      meaningMoments: 2
    });

    expect(next.joy).toBeGreaterThan(DEFAULT_VALUE_PROFILE.joy);
    expect(next.competence).toBeGreaterThan(DEFAULT_VALUE_PROFILE.competence);
  });
});
