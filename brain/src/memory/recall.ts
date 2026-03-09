import {
  ConsolidationRecord,
  MemoryState,
  RecallQuery,
  RecallResult
} from "@resident/shared";

export interface LongTermMemoryArchive {
  loadConsolidations(): Promise<ConsolidationRecord[]>;
}

type RecallCandidate = {
  timestamp: string;
  summary: string;
  tags: string[];
};

export function recallFromMemory(
  memory: MemoryState,
  consolidations: ConsolidationRecord[],
  query: RecallQuery
): RecallResult {
  const normalizedQuery = query.query.toLowerCase();
  const semanticHints = [
    ...(query.tags ?? []),
    ...(query.place ? [query.place] : []),
    ...(query.entity ? [query.entity] : []),
    ...(query.project_id ? [query.project_id] : []),
    ...(query.mood ? [query.mood] : [])
  ];
  const matches = dedupeCandidates(buildAwakeCandidates(memory).concat(buildLongTermCandidates(consolidations)))
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

function buildAwakeCandidates(memory: MemoryState): RecallCandidate[] {
  return [
    ...memory.recent_observations.map((observation) => ({
      timestamp: observation.timestamp,
      summary: observation.summary,
      tags: observation.tags
    })),
    ...memory.self_narrative.map((summary) => ({
      timestamp: memory.last_updated_at,
      summary,
      tags: ["self-narrative"]
    })),
    ...memory.active_projects.map((project) => ({
      timestamp: project.updated_at,
      summary: `${project.title}: ${project.summary}`,
      tags: [project.kind, project.status, project.id]
    })),
    ...memory.carry_over_commitments.map((summary) => ({
      timestamp: memory.last_updated_at,
      summary,
      tags: ["commitment"]
    })),
    ...memory.place_tags.map((tag) => ({
      timestamp: memory.last_updated_at,
      summary: `Known place: ${tag}`,
      tags: ["place", tag]
    }))
  ];
}

function buildLongTermCandidates(consolidations: ConsolidationRecord[]): RecallCandidate[] {
  return consolidations.flatMap((record) =>
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
}

function dedupeCandidates(candidates: RecallCandidate[]): RecallCandidate[] {
  const unique = new Map<string, RecallCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.timestamp}::${candidate.summary}`, candidate);
  }
  return [...unique.values()];
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
