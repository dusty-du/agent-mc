import {
  clamp,
  ConsolidationRecord,
  CultureSignal,
  DailyOutcome,
  DayLifeReflectionInput,
  DayLifeReflectionObservation,
  DayLifeReflectionRecord,
  DayLifeReflectionResult,
  EmotionActionBiases,
  EmotionAppraisal,
  EmotionInterrupt,
  EmotionRevisitPolicy,
  EmotionRegulation,
  EmotionTaggedPlaceKind,
  MemoryBundle,
  OvernightConsolidation,
  ValueProfile,
  driftResidentPersonality,
  updateValueProfile
} from "@resident/shared";
import { FileBackedSleepStore, SleepStoreData } from "./file-store";

export interface SleepConsolidationInput {
  bundle: MemoryBundle;
  outcome: DailyOutcome;
  recentCultureSignals: CultureSignal[];
  recentConsolidations: ConsolidationRecord[];
  recentDayReflections: DayLifeReflectionRecord[];
}

export interface SleepConsolidationResult {
  summary: string;
  insights: string[];
  risk_themes: string[];
  emotional_themes: string[];
  place_memories: string[];
  project_memories: string[];
  creative_motifs: string[];
}

export type DayLifeReflectionRequest = Omit<DayLifeReflectionInput, "latestDayReflections">;

export interface ReflectiveConsolidator {
  readonly modelName: string;
  synthesize(input: SleepConsolidationInput): Promise<SleepConsolidationResult>;
  reflectDay(input: DayLifeReflectionInput): Promise<DayLifeReflectionResult>;
}

export class SleepConsolidationError extends Error {
  constructor(
    message: string,
    public readonly model?: string,
    public readonly cause?: unknown
  ) {
    super(model ? `${message} [model=${model}]` : message);
    this.name = "SleepConsolidationError";
  }
}

function buildOvernightConsolidation(
  bundle: MemoryBundle,
  synthesis: SleepConsolidationResult,
  data: SleepStoreData,
  outcome: DailyOutcome
): OvernightConsolidation {
  const recentSignals = data.cultureSignals.slice(-5).map((signal) => `${signal.topic}: ${signal.notes ?? signal.signal_type}`);
  return {
    day_number: bundle.day_number,
    created_at: new Date().toISOString(),
    summary: synthesis.summary,
    personality_profile: driftResidentPersonality(
      bundle.personality_profile,
      outcome,
      data.cultureSignals.filter((signal) => signal.timestamp >= new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString())
    ),
    self_name: bundle.self_name,
    insights: synthesis.insights,
    carry_over_commitments: bundle.carry_over_commitments.slice(-6),
    risk_themes: synthesis.risk_themes,
    emotional_themes: synthesis.emotional_themes,
    place_memories: synthesis.place_memories,
    project_memories: synthesis.project_memories,
    value_shift_summary: recentSignals,
    creative_motifs: synthesis.creative_motifs
  };
}

export class SleepCore {
  constructor(
    private readonly store: FileBackedSleepStore,
    private readonly consolidator: ReflectiveConsolidator
  ) {}

  async ingestCultureSignal(signal: CultureSignal): Promise<void> {
    const data = await this.store.load();
    data.cultureSignals.push(signal);
    await this.store.save(data);
  }

  async reflectDayEvent(input: DayLifeReflectionRequest): Promise<DayLifeReflectionRecord> {
    const data = await this.store.load();
    const enrichedInput: DayLifeReflectionInput = {
      ...input,
      latestDayReflections: selectRecentDayReflections(data.dayReflections, input.memory.current_day)
    };
    const reflection = await this.buildDayReflection(enrichedInput);
    const createdAt = enrichedInput.currentPerception.tick_time === enrichedInput.previousPerception.tick_time
      ? new Date().toISOString()
      : new Date().toISOString();
    const record: DayLifeReflectionRecord = {
      id: `day-reflection:${createdAt}:${normalizeFingerprintPart(reflection.summary)}`,
      day_number: input.memory.current_day,
      created_at: createdAt,
      trigger: input.trigger,
      fingerprint: buildDayReflectionFingerprint(enrichedInput, reflection),
      summary: reflection.summary,
      result: reflection
    };

    data.dayReflections = trimDayReflections([...data.dayReflections, record], input.memory.current_day);
    await this.store.save(data);
    return record;
  }

  async latestDayReflections(limit = 8): Promise<DayLifeReflectionRecord[]> {
    const data = await this.store.load();
    return data.dayReflections.slice(-Math.max(1, limit));
  }

  async consolidate(bundle: MemoryBundle, outcome: DailyOutcome): Promise<ConsolidationRecord> {
    const data = await this.store.load();
    data.bundles.push(bundle);
    this.bumpSalience(data, bundle.place_tags, 0.5);
    this.bumpSalience(
      data,
      bundle.observations.flatMap((observation) => observation.tags),
      0.25
    );

    const synthesis = await this.buildModelSynthesis(bundle, outcome, data);
    const overnight = buildOvernightConsolidation(bundle, synthesis, data, outcome);
    const record: ConsolidationRecord = {
      dayNumber: bundle.day_number,
      createdAt: overnight.created_at,
      summary: overnight.summary,
      insights: synthesis.insights,
      linkedObservationTimestamps: bundle.observations.map((observation) => observation.timestamp),
      overnight
    };

    data.consolidations.push(record);
    data.valueProfile = updateValueProfile(
      data.valueProfile,
      outcome,
      data.cultureSignals.filter((signal) => signal.timestamp >= new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString())
    );
    await this.store.save(data);
    return record;
  }

  async latestOvernight(): Promise<OvernightConsolidation | undefined> {
    const data = await this.store.load();
    return data.consolidations.at(-1)?.overnight;
  }

  async currentValues(): Promise<ValueProfile> {
    const data = await this.store.load();
    return data.valueProfile;
  }

  private async buildModelSynthesis(
    bundle: MemoryBundle,
    outcome: DailyOutcome,
    data: SleepStoreData
  ): Promise<SleepConsolidationResult> {
    try {
      return normalizeSleepConsolidationResult(
        await this.consolidator.synthesize({
          bundle,
          outcome,
          recentCultureSignals: data.cultureSignals.slice(-5),
          recentConsolidations: data.consolidations.slice(-3),
          recentDayReflections: selectDayReflectionsForOvernight(data.dayReflections, bundle.day_number)
        }),
        this.consolidator.modelName
      );
    } catch (error) {
      if (error instanceof SleepConsolidationError) {
        throw error;
      }
      throw new SleepConsolidationError("Sleep consolidation failed.", this.consolidator.modelName, error);
    }
  }

  private async buildDayReflection(input: DayLifeReflectionInput): Promise<DayLifeReflectionResult> {
    try {
      return normalizeDayLifeReflectionResult(await this.consolidator.reflectDay(input), this.consolidator.modelName);
    } catch (error) {
      if (error instanceof SleepConsolidationError) {
        throw error;
      }
      throw new SleepConsolidationError("Daytime life reflection failed.", this.consolidator.modelName, error);
    }
  }

  private bumpSalience(data: SleepStoreData, tags: string[], amount: number): void {
    for (const tag of tags) {
      const current = data.salience[tag] ?? 0;
      data.salience[tag] = Math.min(5, current + amount);
    }
  }
}

function normalizeSleepConsolidationResult(
  result: SleepConsolidationResult,
  model?: string
): SleepConsolidationResult {
  return {
    summary: normalizeString(result.summary, "summary", model),
    insights: normalizeStringArray(result.insights, 6, "insights", model),
    risk_themes: normalizeStringArray(result.risk_themes, 4, "risk_themes", model),
    emotional_themes: normalizeOptionalStringArray(result.emotional_themes, 5, "emotional_themes", model),
    place_memories: normalizeStringArray(result.place_memories, 5, "place_memories", model),
    project_memories: normalizeStringArray(result.project_memories, 4, "project_memories", model),
    creative_motifs: normalizeStringArray(result.creative_motifs, 3, "creative_motifs", model)
  };
}

function normalizeDayLifeReflectionResult(
  result: DayLifeReflectionResult,
  model?: string
): DayLifeReflectionResult {
  const summary = normalizeString(result.summary, "summary", model);
  const event_kind = normalizeEnum(
    result.event_kind,
    [
      "death",
      "damage",
      "combat",
      "loss",
      "beauty",
      "social",
      "attachment",
      "nurture",
      "wonder",
      "play",
      "milestone",
      "achievement",
      "safety"
    ],
    "event_kind",
    model
  );
  const dominant_emotions = normalizeOptionalStringArray(result.dominant_emotions, 4, "dominant_emotions", model);
  return {
    summary,
    event_kind,
    salience: normalizeNumber(result.salience, "salience", model),
    dominant_emotions,
    appraisal: normalizeEmotionPatch(result.appraisal, appraisalKeys(), "appraisal", model),
    regulation: normalizeEmotionPatch(result.regulation, regulationKeys(), "regulation", model),
    action_biases:
      result.action_biases === undefined ? undefined : normalizeEmotionPatch(result.action_biases, actionBiasKeys(), "action_biases", model),
    subject: normalizeSubject(result.subject, model),
    place: normalizeTaggedPlace(result.place, model),
    bond: normalizeBondDelta(result.bond, model),
    interrupt: normalizeInterrupt(result.interrupt, model),
    observation: normalizeObservation(result.observation, model)
  };
}

function normalizeSubject(result: DayLifeReflectionResult["subject"], model?: string): DayLifeReflectionResult["subject"] {
  if (!result) {
    return undefined;
  }
  return {
    kind: normalizeEnum(result.kind, ["player", "pet", "herd", "place", "moment"], "subject.kind", model),
    label: normalizeString(result.label, "subject.label", model)
  };
}

function normalizeTaggedPlace(
  place: DayLifeReflectionResult["place"],
  model?: string
): DayLifeReflectionResult["place"] {
  if (!place) {
    return undefined;
  }
  return {
    kind: normalizeEnum(
      place.kind,
      ["death_site", "comfort_site", "awe_site", "nursery_site", "bond_site"],
      "place.kind",
      model
    ) as EmotionTaggedPlaceKind,
    label: normalizeString(place.label, "place.label", model),
    location: normalizeVec3(place.location, "place.location", model),
    world: place.world?.trim() || undefined,
    salience: place.salience === undefined ? undefined : normalizeNumber(place.salience, "place.salience", model),
    revisit_policy:
      place.revisit_policy === undefined
        ? undefined
        : (normalizeEnum(place.revisit_policy, ["avoid", "cautious", "open"], "place.revisit_policy", model) as EmotionRevisitPolicy)
  };
}

function normalizeBondDelta(
  bond: DayLifeReflectionResult["bond"],
  model?: string
): DayLifeReflectionResult["bond"] {
  if (!bond) {
    return undefined;
  }
  return {
    kind: normalizeEnum(bond.kind, ["player", "pet", "herd"], "bond.kind", model),
    label: normalizeString(bond.label, "bond.label", model),
    bond_kind: normalizeEnum(bond.bond_kind, ["familiar", "companion", "caretaking"], "bond.bond_kind", model),
    delta_familiarity: normalizeNumber(bond.delta_familiarity, "bond.delta_familiarity", model),
    delta_attachment: normalizeNumber(bond.delta_attachment, "bond.delta_attachment", model),
    home_affinity: bond.home_affinity === undefined ? undefined : normalizeNumber(bond.home_affinity, "bond.home_affinity", model)
  };
}

function normalizeInterrupt(
  interrupt: DayLifeReflectionResult["interrupt"],
  model?: string
): DayLifeReflectionResult["interrupt"] {
  if (!interrupt) {
    return undefined;
  }
  return {
    trigger: normalizeEnum(interrupt.trigger, ["death", "respawn", "social_contact", "bonding", "birth", "wonder"], "interrupt.trigger", model) as EmotionInterrupt["trigger"],
    reason: normalizeString(interrupt.reason, "interrupt.reason", model)
  };
}

function normalizeObservation(
  observation: DayLifeReflectionResult["observation"],
  model?: string
): DayLifeReflectionResult["observation"] {
  if (!observation) {
    return undefined;
  }
  return {
    category: normalizeEnum(
      observation.category,
      ["discovery", "food", "crafting", "building", "rebuild", "livestock", "combat", "social", "beauty", "sleep", "danger", "recovery", "orientation", "project", "weather", "hospitality"],
      "observation.category",
      model
    ) as DayLifeReflectionObservation["category"],
    summary: normalizeString(observation.summary, "observation.summary", model),
    tags: normalizeStringArray(observation.tags, 8, "observation.tags", model),
    importance: normalizeNumber(observation.importance, "observation.importance", model)
  };
}

function normalizeEmotionPatch<T extends Record<string, unknown>>(
  patch: T | undefined,
  keys: string[],
  field: string,
  model?: string
): Partial<T> {
  if (patch === undefined || patch === null) {
    return {};
  }
  if (typeof patch !== "object") {
    throw new SleepConsolidationError(`Day reflection field "${field}" must be an object.`, model);
  }
  const next: Record<string, number> = {};
  for (const key of keys) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    next[key] = normalizeNumber(value, `${field}.${key}`, model);
  }
  return next as Partial<T>;
}

function normalizeVec3(value: unknown, field: string, model?: string): { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") {
    throw new SleepConsolidationError(`Day reflection field "${field}" must be a vec3 object.`, model);
  }
  const candidate = value as { x?: unknown; y?: unknown; z?: unknown };
  return {
    x: normalizeFiniteNumber(candidate.x, `${field}.x`, model),
    y: normalizeFiniteNumber(candidate.y, `${field}.y`, model),
    z: normalizeFiniteNumber(candidate.z, `${field}.z`, model)
  };
}

function normalizeString(value: unknown, field: string, model?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SleepConsolidationError(`Sleep consolidation field "${field}" must be a non-empty string.`, model);
  }
  return value.trim();
}

function normalizeStringArray(value: unknown, max: number, field: string, model?: string): string[] {
  if (!Array.isArray(value)) {
    throw new SleepConsolidationError(`Sleep consolidation field "${field}" must be an array.`, model);
  }
  return [...new Set(value.map((entry) => normalizeString(entry, field, model)).filter(Boolean))].slice(0, max);
}

function normalizeOptionalStringArray(value: unknown, max: number, field: string, model?: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return normalizeStringArray(value, max, field, model);
}

function normalizeNumber(value: unknown, field: string, model?: string): number {
  return clamp(normalizeFiniteNumber(value, field, model));
}

function normalizeFiniteNumber(value: unknown, field: string, model?: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SleepConsolidationError(`Day reflection field "${field}" must be a finite number.`, model);
  }
  return value;
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, model?: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SleepConsolidationError(`Day reflection field "${field}" must be one of: ${allowed.join(", ")}.`, model);
  }
  return value as T;
}

function selectRecentDayReflections(records: DayLifeReflectionRecord[], currentDay: number): DayLifeReflectionRecord[] {
  const sameDay = records.filter((record) => record.day_number === currentDay).slice(-4);
  const prior = records.filter((record) => record.day_number !== currentDay).slice(-2);
  return [...prior, ...sameDay];
}

function selectDayReflectionsForOvernight(records: DayLifeReflectionRecord[], dayNumber: number): DayLifeReflectionRecord[] {
  const sameDay = records.filter((record) => record.day_number === dayNumber);
  const prior = records.filter((record) => record.day_number !== dayNumber).slice(-4);
  return [...sameDay.slice(-8), ...prior];
}

function trimDayReflections(records: DayLifeReflectionRecord[], currentDay: number): DayLifeReflectionRecord[] {
  const latestIds = new Set(records.slice(-200).map((record) => record.id));
  return records.filter((record) => latestIds.has(record.id) || record.day_number >= currentDay - 2);
}

function buildDayReflectionFingerprint(input: DayLifeReflectionInput, reflection: DayLifeReflectionResult): string {
  const subject = reflection.subject?.label ?? reflection.bond?.label ?? "";
  const place = reflection.place?.label ?? "";
  const location = reflection.place?.location ?? input.currentPerception.position;
  return [
    input.trigger,
    normalizeFingerprintPart(subject),
    normalizeFingerprintPart(place),
    `${Math.floor(location.x / 8)}:${Math.floor(location.y / 8)}:${Math.floor(location.z / 8)}`
  ].join("|");
}

function normalizeFingerprintPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "none";
}

function appraisalKeys(): Array<keyof EmotionAppraisal> {
  return ["threat", "loss", "pain", "curiosity", "connection", "comfort", "mastery", "wonder"];
}

function regulationKeys(): Array<keyof EmotionRegulation> {
  return ["arousal", "shock", "vigilance", "resolve", "recovery"];
}

function actionBiasKeys(): Array<keyof EmotionActionBiases> {
  return ["avoid_risk", "seek_shelter", "seek_recovery", "seek_company", "seek_mastery", "seek_wonder", "cautious_revisit"];
}
