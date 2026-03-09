import { CombatPolicy, LivestockState, ValueProfile } from "./contracts";

export const DEFAULT_VALUE_PROFILE: ValueProfile = {
  survival: 0.95,
  food_security: 0.92,
  safety: 0.9,
  curiosity: 0.55,
  craftsmanship: 0.6,
  beauty: 0.45,
  comfort: 0.55,
  sociability: 0.5,
  hospitality: 0.45,
  stewardship: 0.6,
  competence: 0.7,
  joy: 0.7,
  safetyFloors: {
    preserveRenewableFood: true,
    noGriefing: true,
    noStealing: true,
    sleepNightly: true
  },
  updatedAt: new Date(0).toISOString()
};

export const DEFAULT_COMBAT_POLICY: CombatPolicy = {
  engage_threshold: 0.72,
  retreat_threshold: 0.45,
  night_travel_limit: 18,
  protect_home_radius: 24,
  preferred_weapon_mode: "best_available",
  panic_recovery_steps: [
    "retreat to nearest shelter",
    "close distance blockers or doors",
    "eat the safest available food",
    "re-equip best weapon and shield",
    "wait for health and danger to stabilize"
  ]
};

export const DEFAULT_LIVESTOCK_STATE: LivestockState = {
  counts: {
    chicken: 0,
    sheep: 0,
    cow: 0,
    pig: 0
  },
  targetRanges: {
    chicken: { min: 2, max: 8 },
    sheep: { min: 2, max: 8 },
    cow: { min: 2, max: 8 },
    pig: { min: 2, max: 6 }
  },
  enclosureStatus: {
    chicken: "unknown",
    sheep: "unknown",
    cow: "unknown",
    pig: "unknown"
  },
  outputs: {
    chicken: ["eggs", "meat"],
    sheep: ["wool", "meat"],
    cow: ["milk", "leather", "meat"],
    pig: ["meat"]
  },
  welfareFlags: []
};

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function boundedBlend(current: number, target: number, rate = 0.12): number {
  const blended = current + (target - current) * rate;
  return clamp(blended, 0.15, 1);
}
