import { CultureSignal, DailyOutcome, ValueProfile } from "./contracts";
import { boundedBlend, clamp, DEFAULT_VALUE_PROFILE } from "./defaults";

type ValueDimension = Exclude<keyof ValueProfile, "safetyFloors" | "updatedAt">;

const VALUE_DIMENSIONS: ValueDimension[] = [
  "survival",
  "food_security",
  "safety",
  "curiosity",
  "craftsmanship",
  "beauty",
  "comfort",
  "sociability",
  "hospitality",
  "stewardship",
  "competence",
  "joy"
];

function accumulate(base: Partial<Record<ValueDimension, number>>, key: ValueDimension, value: number) {
  base[key] = (base[key] ?? 0) + value;
}

export function deriveValueFeedback(
  outcome: DailyOutcome,
  signals: CultureSignal[] = []
): Partial<Record<ValueDimension, number>> {
  const feedback: Partial<Record<ValueDimension, number>> = {};
  const recoveryMoments = outcome.recoveryMoments ?? 0;
  const setbacksFaced = outcome.setbacksFaced ?? 0;
  const meaningMoments = outcome.meaningMoments ?? 0;

  accumulate(feedback, "survival", outcome.survived ? 0.8 : -1);
  accumulate(feedback, "food_security", outcome.hungerEmergencies === 0 ? 0.55 : -0.7);
  accumulate(feedback, "safety", outcome.damageTaken === 0 ? 0.35 : -Math.min(0.9, outcome.damageTaken / 20));
  accumulate(feedback, "curiosity", Math.min(0.7, outcome.explorationMoments * 0.15));
  accumulate(feedback, "craftsmanship", Math.min(0.8, outcome.craftedItems * 0.08));
  accumulate(feedback, "beauty", Math.min(0.75, outcome.buildActions * 0.02 + outcome.joyMoments * 0.08 + meaningMoments * 0.04));
  accumulate(feedback, "comfort", outcome.sleptInBed ? 0.4 : -0.5);
  accumulate(feedback, "sociability", Math.min(0.75, outcome.hostedPlayers * 0.18));
  accumulate(feedback, "hospitality", Math.min(0.8, outcome.hostedPlayers * 0.22));
  accumulate(feedback, "stewardship", outcome.livestockStable ? 0.45 : -0.2);
  accumulate(feedback, "competence", Math.min(0.75, outcome.combatsWon * 0.12 + outcome.craftedItems * 0.05 + recoveryMoments * 0.04));
  accumulate(
    feedback,
    "joy",
    Math.min(
      0.85,
      outcome.joyMoments * 0.18 +
        outcome.explorationMoments * 0.05 +
        recoveryMoments * 0.06 +
        meaningMoments * 0.08 +
        Math.min(setbacksFaced, recoveryMoments) * 0.04
    )
  );

  for (const signal of signals) {
    const shaped = clamp((signal.valence * signal.strength) / 5, -1, 1);
    if (signal.topic.includes("social") || signal.topic.includes("guest")) {
      accumulate(feedback, "sociability", shaped * 0.8);
      accumulate(feedback, "hospitality", shaped);
    }
    if (signal.topic.includes("farm") || signal.topic.includes("animal")) {
      accumulate(feedback, "stewardship", shaped);
      accumulate(feedback, "food_security", shaped * 0.65);
    }
    if (signal.topic.includes("build") || signal.topic.includes("home")) {
      accumulate(feedback, "craftsmanship", shaped * 0.75);
      accumulate(feedback, "beauty", shaped * 0.75);
      accumulate(feedback, "comfort", shaped * 0.5);
    }
    if (signal.topic.includes("explore") || signal.topic.includes("travel")) {
      accumulate(feedback, "curiosity", shaped);
      accumulate(feedback, "joy", shaped * 0.65);
    }
  }

  return feedback;
}

export function updateValueProfile(
  profile: ValueProfile = DEFAULT_VALUE_PROFILE,
  outcome: DailyOutcome,
  signals: CultureSignal[] = []
): ValueProfile {
  const feedback = deriveValueFeedback(outcome, signals);
  const next: ValueProfile = {
    ...profile,
    safetyFloors: { ...profile.safetyFloors },
    updatedAt: new Date().toISOString()
  };

  for (const key of VALUE_DIMENSIONS) {
    const desired = clamp(profile[key] + (feedback[key] ?? 0) * 0.1);
    next[key] = boundedBlend(profile[key], desired);
  }

  next.survival = Math.max(next.survival, 0.8);
  next.food_security = Math.max(next.food_security, 0.75);
  next.safety = Math.max(next.safety, 0.72);

  return next;
}
