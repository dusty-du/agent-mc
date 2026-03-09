import {
  ConsolidationRecord,
  CultureSignal,
  DailyOutcome,
  MemoryBundle,
  OvernightConsolidation,
  RecallQuery,
  RecallResult,
  ValueProfile,
  updateValueProfile
} from "@resident/shared";
import { FileBackedSleepStore, SleepStoreData } from "./file-store";

function summarizeBundle(bundle: MemoryBundle): string {
  const categories = bundle.observations.reduce<Record<string, number>>((acc, observation) => {
    acc[observation.category] = (acc[observation.category] ?? 0) + 1;
    return acc;
  }, {});
  const summaryBits = Object.entries(categories).map(([category, count]) => `${count} ${category}`);
  return summaryBits.length > 0 ? `The day held ${summaryBits.join(", ")}.` : bundle.summary;
}

function topTags(bundle: MemoryBundle): string[] {
  const counts = new Map<string, number>();
  for (const observation of bundle.observations) {
    for (const tag of observation.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + observation.importance);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([tag]) => tag);
}

function buildOvernightConsolidation(bundle: MemoryBundle, insights: string[], data: SleepStoreData): OvernightConsolidation {
  const riskThemes = bundle.recent_dangers.slice(-4);
  const projectMemories = bundle.active_projects.slice(-4).map((project) => `${project.title}: ${project.summary}`);
  const placeMemories = bundle.place_tags.slice(-5);
  const recentSignals = data.cultureSignals.slice(-5).map((signal) => `${signal.topic}: ${signal.notes ?? signal.signal_type}`);
  return {
    day_number: bundle.day_number,
    created_at: new Date().toISOString(),
    summary: summarizeBundle(bundle),
    insights,
    carry_over_commitments: bundle.carry_over_commitments.slice(-6),
    risk_themes: riskThemes,
    place_memories: placeMemories,
    project_memories: projectMemories,
    value_shift_summary: recentSignals,
    creative_motifs: bundle.observations
      .filter((observation) => observation.tags.includes("beauty") || observation.tags.includes("home"))
      .slice(-3)
      .map((observation) => observation.summary)
  };
}

export class SleepCore {
  constructor(private readonly store: FileBackedSleepStore) {}

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

    const tags = topTags(bundle);
    const insights = this.makeInsights(bundle, tags, outcome);
    const overnight = buildOvernightConsolidation(bundle, insights, data);
    const record: ConsolidationRecord = {
      dayNumber: bundle.day_number,
      createdAt: overnight.created_at,
      summary: overnight.summary,
      insights,
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

  async recall(query: RecallQuery): Promise<RecallResult> {
    const data = await this.store.load();
    const haystack = data.consolidations.flatMap((record) =>
      record.overnight.project_memories
        .concat(record.overnight.place_memories)
        .concat(record.overnight.insights)
        .concat(record.overnight.creative_motifs)
        .map((summary) => ({
          timestamp: record.createdAt,
          summary,
          tags: [
            ...record.overnight.place_memories,
            ...record.overnight.risk_themes,
            ...record.overnight.carry_over_commitments,
            ...record.overnight.project_memories
          ]
        }))
    );
    const normalizedQuery = query.query.toLowerCase();
    const semanticHints = [
      ...(query.tags ?? []),
      ...(query.place ? [query.place] : []),
      ...(query.entity ? [query.entity] : []),
      ...(query.project_id ? [query.project_id] : []),
      ...(query.mood ? [query.mood] : [])
    ];
    const matches = haystack
      .map((entry) => ({
        ...entry,
        relevance: scoreMatch(entry.summary, normalizedQuery, semanticHints, entry.tags)
      }))
      .filter((entry) => entry.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, query.limit ?? 5)
      .map(({ timestamp, summary, tags, relevance }) => ({ timestamp, summary, tags, relevance }));

    return {
      query,
      matches
    };
  }

  private makeInsights(bundle: MemoryBundle, tags: string[], outcome: DailyOutcome): string[] {
    const insights: string[] = [];

    if (bundle.recent_dangers.length > 0 || outcome.damageTaken > 6) {
      insights.push("Keep exits, food, and shelter close when danger gathers.");
    }
    if (outcome.hungerEmergencies > 0) {
      insights.push("Protect tomorrow by stabilizing food before ambitious travel.");
    }
    if (!outcome.survived || (outcome.setbacksFaced ?? 0) > 0) {
      insights.push("Failure can still belong to a good life if it is understood and tried again.");
    }
    if (outcome.hostedPlayers > 0 || bundle.recent_interactions.length > 0) {
      insights.push("Make room for warmth, welcome, and shared spaces.");
    }
    if ((outcome.meaningMoments ?? 0) > 0 || (outcome.recoveryMoments ?? 0) > 0) {
      insights.push("Meaning and recovery matter as much as success.");
    }

    for (const tag of tags) {
      if (insights.length >= 6) {
        break;
      }
      insights.push(`Remember ${tag} when choosing what feels worth doing next.`);
    }

    return [...new Set(insights)].slice(0, 6);
  }

  private bumpSalience(data: SleepStoreData, tags: string[], amount: number): void {
    for (const tag of tags) {
      const current = data.salience[tag] ?? 0;
      data.salience[tag] = Math.min(5, current + amount);
    }
  }
}

function scoreMatch(summary: string, query: string, hints: string[], entryTags: string[]): number {
  const normalizedSummary = summary.toLowerCase();
  const normalizedTags = entryTags.map((tag) => tag.toLowerCase());
  let score = 0;
  if (normalizedSummary.includes(query)) {
    score += 1;
  }
  for (const hint of hints) {
    const normalizedHint = hint.toLowerCase();
    if (normalizedSummary.includes(normalizedHint)) {
      score += 0.5;
    }
    if (normalizedTags.some((tag) => tag.includes(normalizedHint))) {
      score += 0.35;
    }
  }
  for (const tag of normalizedTags) {
    if (query.includes(tag)) {
      score += 0.2;
    }
  }
  return score;
}
