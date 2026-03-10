import {
  ConsolidationRecord,
  CultureSignal,
  DailyOutcome,
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
}

export interface SleepConsolidationResult {
  summary: string;
  insights: string[];
  risk_themes: string[];
  place_memories: string[];
  project_memories: string[];
  creative_motifs: string[];
}

export interface SleepConsolidator {
  readonly modelName: string;
  synthesize(input: SleepConsolidationInput): Promise<SleepConsolidationResult>;
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
    place_memories: synthesis.place_memories,
    project_memories: synthesis.project_memories,
    value_shift_summary: recentSignals,
    creative_motifs: synthesis.creative_motifs
  };
}

export class SleepCore {
  constructor(
    private readonly store: FileBackedSleepStore,
    private readonly consolidator: SleepConsolidator
  ) {}

  async ingestCultureSignal(signal: CultureSignal): Promise<void> {
    const data = await this.store.load();
    data.cultureSignals.push(signal);
    await this.store.save(data);
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
          recentConsolidations: data.consolidations.slice(-3)
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
    place_memories: normalizeStringArray(result.place_memories, 5, "place_memories", model),
    project_memories: normalizeStringArray(result.project_memories, 4, "project_memories", model),
    creative_motifs: normalizeStringArray(result.creative_motifs, 3, "creative_motifs", model)
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
