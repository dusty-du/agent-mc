import { CultureSignal, DailyOutcome, ResidentMotif, ResidentPersonalityProfile, ResidentTraitProfile } from "./contracts";
import { clamp } from "./defaults";

const MOTIFS: ResidentMotif[] = ["homesteader", "wanderer", "caretaker", "tinkerer", "sentinel", "host"];

export function createResidentPersonality(seed = randomSeed()): ResidentPersonalityProfile {
  const random = seededRandom(seed);
  const traits: ResidentTraitProfile = {
    openness: ranged(random, 0.3, 0.82),
    conscientiousness: ranged(random, 0.35, 0.88),
    extraversion: ranged(random, 0.22, 0.82),
    agreeableness: ranged(random, 0.3, 0.86),
    threat_sensitivity: ranged(random, 0.2, 0.82)
  };
  const chronotypeRoll = random();
  const chronotype = chronotypeRoll < 0.33 ? "early" : chronotypeRoll > 0.66 ? "late" : "steady";
  const motifs = selectMotifs(traits);
  return {
    seed,
    traits,
    chronotype,
    motifs,
    style_tags: deriveStyleTags(traits, motifs),
    updated_at: new Date().toISOString()
  };
}

export function driftResidentPersonality(
  profile: ResidentPersonalityProfile,
  outcome: DailyOutcome,
  signals: CultureSignal[] = []
): ResidentPersonalityProfile {
  const socialSignal = signals.reduce((sum, signal) => {
    if (signal.topic.includes("social") || signal.topic.includes("guest")) {
      return sum + signal.valence * signal.strength;
    }
    return sum;
  }, 0);
  const exploreBias = Math.min(0.02, outcome.explorationMoments * 0.004 + (outcome.joyMoments ?? 0) * 0.002);
  const dutyBias = Math.min(0.02, outcome.buildActions * 0.001 + outcome.craftedItems * 0.002 + (outcome.sleptInBed ? 0.006 : -0.01));
  const socialBias = clamp(outcome.hostedPlayers * 0.004 + socialSignal * 0.0015, -0.02, 0.02);
  const kindnessBias = clamp((outcome.hostedPlayers + (signals.some((signal) => signal.signal_type === "thank_you") ? 1 : 0)) * 0.004, -0.02, 0.02);
  const threatBias = clamp(
    outcome.damageTaken * 0.0015 + outcome.hungerEmergencies * 0.008 - (outcome.sleptInBed ? 0.006 : 0),
    -0.02,
    0.02
  );

  const nextTraits: ResidentTraitProfile = {
    openness: nudgeTrait(profile.traits.openness, exploreBias),
    conscientiousness: nudgeTrait(profile.traits.conscientiousness, dutyBias),
    extraversion: nudgeTrait(profile.traits.extraversion, socialBias),
    agreeableness: nudgeTrait(profile.traits.agreeableness, kindnessBias),
    threat_sensitivity: nudgeTrait(profile.traits.threat_sensitivity, threatBias)
  };
  const motifs = selectMotifs(nextTraits);
  return {
    ...profile,
    traits: nextTraits,
    motifs,
    style_tags: deriveStyleTags(nextTraits, motifs),
    updated_at: new Date().toISOString()
  };
}

export function deriveStyleTags(
  traits: ResidentTraitProfile,
  motifs: ResidentPersonalityProfile["motifs"]
): string[] {
  const tags = new Set<string>([motifs.primary, ...(motifs.secondary ? [motifs.secondary] : [])]);
  if (traits.openness >= 0.65) {
    tags.add("curious");
  }
  if (traits.conscientiousness >= 0.68) {
    tags.add("steady");
  }
  if (traits.extraversion >= 0.64) {
    tags.add("warm");
  }
  if (traits.agreeableness >= 0.68) {
    tags.add("gentle");
  }
  if (traits.threat_sensitivity >= 0.64) {
    tags.add("cautious");
  }
  if (traits.extraversion <= 0.35) {
    tags.add("reserved");
  }
  if (traits.openness <= 0.38) {
    tags.add("grounded");
  }
  return [...tags].slice(0, 4);
}

function selectMotifs(traits: ResidentTraitProfile): ResidentPersonalityProfile["motifs"] {
  const scores: Array<{ motif: ResidentMotif; score: number }> = [
    { motif: "homesteader", score: traits.conscientiousness * 0.7 + traits.agreeableness * 0.3 },
    { motif: "wanderer", score: traits.openness * 0.85 + (1 - traits.threat_sensitivity) * 0.15 },
    { motif: "caretaker", score: traits.agreeableness * 0.75 + traits.conscientiousness * 0.25 },
    { motif: "tinkerer", score: traits.openness * 0.45 + traits.conscientiousness * 0.55 },
    { motif: "sentinel", score: traits.threat_sensitivity * 0.7 + traits.conscientiousness * 0.3 },
    { motif: "host", score: traits.extraversion * 0.55 + traits.agreeableness * 0.45 }
  ].sort((left, right) => right.score - left.score);

  const [primary, ...rest] = scores;
  const secondary = rest.find((entry) => entry.motif !== primary.motif);
  return {
    primary: primary?.motif ?? MOTIFS[0],
    secondary: secondary?.motif
  };
}

function nudgeTrait(current: number, delta: number): number {
  return clamp(current + clamp(delta, -0.02, 0.02), 0.15, 0.92);
}

function randomSeed(): string {
  return `resident-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ranged(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let next = Math.imul(state ^ (state >>> 15), state | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
