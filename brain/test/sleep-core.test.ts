import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileBackedSleepStore } from "../src/sleep/file-store";
import { createOpenAISleepConsolidatorFromEnv } from "../src/sleep/openai-sleep-consolidator";
import { SleepConsolidationError, SleepConsolidator, SleepCore } from "../src/sleep/sleep-core";

const originalSleepModel = process.env.RESIDENT_SLEEP_OPENAI_MODEL;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.RESIDENT_OPENAI_BASE_URL;

afterEach(() => {
  restoreEnv("RESIDENT_SLEEP_OPENAI_MODEL", originalSleepModel);
  restoreEnv("OPENAI_API_KEY", originalApiKey);
  restoreEnv("RESIDENT_OPENAI_BASE_URL", originalBaseUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SleepCore", () => {
  it("consolidates a memory bundle using an injected sleep consolidator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-sleep-"));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, sampleConsolidator());
      const record = await sleepCore.consolidate(sampleBundle(), sampleOutcome());

      expect(record.overnight.carry_over_commitments).toContain("repair the doorway");
      expect(record.overnight.self_name).toBe("Hazel");
      expect(record.overnight.insights.length).toBeGreaterThan(0);
      expect(record.overnight.personality_profile.seed).toBe("resident-seed");
      expect(Math.abs(record.overnight.personality_profile.traits.openness - sampleBundle().personality_profile.traits.openness)).toBeLessThanOrEqual(0.02);
      expect(await sleepCore.latestOvernight()).toEqual(record.overnight);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses RESIDENT_SLEEP_OPENAI_MODEL for model-backed consolidation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-sleep-model-"));
    try {
      process.env.RESIDENT_SLEEP_OPENAI_MODEL = "gpt-sleep-test";
      process.env.OPENAI_API_KEY = "test-key";
      process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            summary: "A softer night settled over the doorway.",
            insights: ["Keep the warm threshold ready for tomorrow."],
            risk_themes: ["Skeleton near the tree line."],
            place_memories: ["home", "quiet corner"],
            project_memories: ["Doorway Repair: Keep the entrance dry and bright."],
            creative_motifs: ["The doorway looked warm in the rain."]
          })
        })
      }));
      vi.stubGlobal("fetch", fetchMock);

      const consolidator = createOpenAISleepConsolidatorFromEnv();
      expect(consolidator).toBeDefined();

      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, consolidator);
      const record = await sleepCore.consolidate(sampleBundle(), sampleOutcome());

      const [, request] = fetchMock.mock.calls[0] ?? [];
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(String((request as RequestInit).body)).model).toBe("gpt-sleep-test");
      expect(record.summary).toBe("A softer night settled over the doorway.");
      expect(record.overnight.project_memories).toEqual(["Doorway Repair: Keep the entrance dry and bright."]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws a SleepConsolidationError on malformed consolidator output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-sleep-invalid-"));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, {
        modelName: "sleep-test",
        synthesize: vi.fn(async () => ({
          summary: "Stillness arrived.",
          insights: "not-an-array" as unknown as string[],
          risk_themes: [],
          place_memories: [],
          project_memories: [],
          creative_motifs: []
        }))
      });

      await expect(sleepCore.consolidate(sampleBundle(), sampleOutcome())).rejects.toBeInstanceOf(SleepConsolidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast when RESIDENT_SLEEP_OPENAI_MODEL is missing", () => {
    delete process.env.RESIDENT_SLEEP_OPENAI_MODEL;
    process.env.OPENAI_API_KEY = "test-key";

    expect(() => createOpenAISleepConsolidatorFromEnv()).toThrow("RESIDENT_SLEEP_OPENAI_MODEL");
  });

  it("fails fast when a sleep model is configured without OPENAI_API_KEY", () => {
    process.env.RESIDENT_SLEEP_OPENAI_MODEL = "gpt-sleep-test";
    delete process.env.OPENAI_API_KEY;

    expect(() => createOpenAISleepConsolidatorFromEnv()).toThrow("OPENAI_API_KEY");
  });
});

function sampleBundle() {
  return {
    agent_id: "resident-1",
    day_number: 3,
    created_at: new Date().toISOString(),
    summary: "A hard but meaningful day.",
    personality_profile: {
      seed: "resident-seed",
      traits: {
        openness: 0.52,
        conscientiousness: 0.64,
        extraversion: 0.4,
        agreeableness: 0.58,
        threat_sensitivity: 0.47
      },
      chronotype: "steady" as const,
      motifs: {
        primary: "homesteader" as const,
        secondary: "tinkerer" as const
      },
      style_tags: ["homesteader", "steady"],
      updated_at: new Date().toISOString()
    },
    self_name: "Hazel",
    need_state: {
      safety: 0.3,
      rest: 0.35,
      hunger: 0.25,
      autonomy: 0.4,
      competence: 0.38,
      relatedness: 0.2,
      beauty: 0.33
    },
    mind_state: {
      valence: 0.58,
      arousal: 0.36,
      confidence: 0.44,
      frustration: 0.18,
      fatigueDebt: 0.31,
      routinePhase: "night" as const
    },
    bootstrap_progress: {
      woodSecured: true,
      toolsReady: true,
      shelterSecured: true,
      lightSecured: true,
      foodSecured: true,
      bedSecured: true
    },
    observations: [
      {
        timestamp: new Date().toISOString(),
        category: "danger" as const,
        summary: "Barely escaped a skeleton at dusk.",
        tags: ["danger", "combat", "dusk"],
        importance: 0.9,
        source: "action" as const
      },
      {
        timestamp: new Date().toISOString(),
        category: "beauty" as const,
        summary: "The doorway looked warm in the rain.",
        tags: ["beauty", "home", "rain"],
        importance: 0.7,
        source: "reflection" as const
      }
    ],
    active_projects: [
      {
        id: "doorway-repair",
        title: "Doorway Repair",
        kind: "build" as const,
        status: "active" as const,
        summary: "Keep the entrance dry and bright.",
        updated_at: new Date().toISOString()
      }
    ],
    carry_over_commitments: ["repair the doorway"],
    recent_dangers: ["Skeleton near the tree line."],
    recent_interactions: [],
    recent_action_snapshots: [
      {
        timestamp: new Date().toISOString(),
        intent_type: "build" as const,
        target_class: "build:doorway-repair",
        status: "completed" as const,
        position_delta: 2.5,
        risk_context: "sheltered" as const
      }
    ],
    place_tags: ["home", "quiet corner"],
    final_affect: {
      mood: 0.6,
      stress: 0.5,
      loneliness: 0.3,
      wonder: 0.6,
      security: 0.55,
      belonging: 0.7,
      satisfaction: 0.58
    }
  };
}

function sampleOutcome() {
  return {
    dayNumber: 3,
    survived: true,
    sleptInBed: true,
    mealsConsumed: 3,
    hungerEmergencies: 0,
    damageTaken: 7,
    combatsWon: 0,
    retreatsUsed: 1,
    hostedPlayers: 0,
    explorationMoments: 1,
    craftedItems: 0,
    buildActions: 2,
    livestockStable: true,
    joyMoments: 1,
    setbacksFaced: 1,
    recoveryMoments: 1,
    meaningMoments: 1
  };
}

function sampleConsolidator(): SleepConsolidator {
  return {
    modelName: "sleep-test",
    synthesize: vi.fn(async () => ({
      summary: "A careful night gathered the day into memory.",
      insights: ["Keep the doorway warm and ready."],
      risk_themes: ["Skeleton near the tree line."],
      place_memories: ["home", "quiet corner"],
      project_memories: ["Doorway Repair: Keep the entrance dry and bright."],
      creative_motifs: ["The doorway looked warm in the rain."]
    }))
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
