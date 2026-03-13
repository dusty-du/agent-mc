import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVESTOCK_STATE, PerceptionFrame } from "@resident/shared";
import { createMemoryState } from "../src/memory/memory-state";
import { FileBackedSleepStore } from "../src/sleep/file-store";
import { createOpenAIReflectiveConsolidatorFromEnv } from "../src/sleep/openai-sleep-consolidator";
import { ReflectiveConsolidator, SleepConsolidationError, SleepCore } from "../src/sleep/sleep-core";

const originalReflectiveModel = process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.RESIDENT_OPENAI_BASE_URL;

afterEach(() => {
  restoreEnv("RESIDENT_REFLECTIVE_OPENAI_MODEL", originalReflectiveModel);
  delete process.env.RESIDENT_SLEEP_OPENAI_MODEL;
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
      expect(record.overnight.emotional_themes).toContain("resolved");
      expect(record.overnight.personality_profile.seed).toBe("resident-seed");
      expect(Math.abs(record.overnight.personality_profile.traits.openness - sampleBundle().personality_profile.traits.openness)).toBeLessThanOrEqual(0.02);
      expect(await sleepCore.latestOvernight()).toEqual(record.overnight);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses RESIDENT_REFLECTIVE_OPENAI_MODEL for model-backed consolidation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-sleep-model-"));
    try {
      process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
      process.env.OPENAI_API_KEY = "test-key";
      process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () =>
          responseWithFunctionCall("submit_overnight_consolidation", {
            summary: "A softer night settled over the doorway.",
            insights: ["Keep the warm threshold ready for tomorrow."],
            risk_themes: ["Skeleton near the tree line."],
            emotional_themes: ["relieved"],
            place_memories: ["home", "quiet corner"],
            project_memories: ["Doorway Repair: Keep the entrance dry and bright."],
            creative_motifs: ["The doorway looked warm in the rain."]
          })
      }));
      vi.stubGlobal("fetch", fetchMock);

      const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
      expect(consolidator).toBeDefined();

      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, consolidator);
      const record = await sleepCore.consolidate(sampleBundle(), sampleOutcome());

      const [, request] = fetchMock.mock.calls[0] ?? [];
      const requestBody = JSON.parse(String((request as RequestInit).body));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestBody.model).toBe("gpt-sleep-test");
      expect(requestBody.tool_choice).toEqual({ type: "function", name: "submit_overnight_consolidation" });
      expect(requestBody.tools).toEqual([
        expect.objectContaining({
          type: "function",
          name: "submit_overnight_consolidation"
        })
      ]);
      expect(record.summary).toBe("A softer night settled over the doorway.");
      expect(record.overnight.emotional_themes).toEqual(["relieved"]);
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
            emotional_themes: [],
            place_memories: [],
            project_memories: [],
            creative_motifs: []
        })),
        reflectDay: vi.fn(async () => ({
          summary: "A passing moment.",
          event_kind: "wonder",
          salience: 0.4,
          dominant_emotions: ["curious"],
          appraisal: {
            wonder: 0.5,
            curiosity: 0.42
          },
          regulation: {
            arousal: 0.28,
            recovery: 0.36
          }
        }))
      });

      await expect(sleepCore.consolidate(sampleBundle(), sampleOutcome())).rejects.toBeInstanceOf(SleepConsolidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast when RESIDENT_REFLECTIVE_OPENAI_MODEL is missing", () => {
    delete process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL;
    delete process.env.RESIDENT_SLEEP_OPENAI_MODEL;
    process.env.OPENAI_API_KEY = "test-key";

    expect(() => createOpenAIReflectiveConsolidatorFromEnv()).toThrow("RESIDENT_REFLECTIVE_OPENAI_MODEL");
  });

  it("fails fast when a reflective model is configured without OPENAI_API_KEY", () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    delete process.env.OPENAI_API_KEY;

    expect(() => createOpenAIReflectiveConsolidatorFromEnv()).toThrow("OPENAI_API_KEY");
  });

  it("hard-fails when only the old sleep-model env var is set", () => {
    process.env.RESIDENT_SLEEP_OPENAI_MODEL = "gpt-old-name";
    process.env.OPENAI_API_KEY = "test-key";

    expect(() => createOpenAIReflectiveConsolidatorFromEnv()).toThrow("RESIDENT_REFLECTIVE_OPENAI_MODEL");
  });

  it("stores a daytime life reflection record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-day-reflection-"));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, sampleConsolidator());
      const record = await sleepCore.reflectDayEvent({
        trigger: "wonder",
        previousPerception: samplePerception(900),
        currentPerception: samplePerception(1200),
        memory: sampleMemory(),
        recentObservations: sampleBundle().observations,
        recentActionSnapshot: sampleBundle().recent_action_snapshots[0]
      });

      expect(record.trigger).toBe("wonder");
      expect(record.result.event_kind).toBe("wonder");
      expect(record.summary).toContain("sunrise");
      await expect(sleepCore.latestDayReflections()).resolves.toEqual([record]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("feeds stored daytime reflections into overnight consolidation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-night-reflection-"));
    const synthesize = vi.fn(async () => ({
      summary: "Night folded the sunrise into tomorrow.",
      insights: ["Carry the ridge-light forward."],
      risk_themes: [],
      emotional_themes: ["hopeful"],
      place_memories: ["sunrise ridge"],
      project_memories: [],
      creative_motifs: ["Morning light along the ridge."]
    }));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, {
        ...sampleConsolidator(),
        synthesize
      });
      await sleepCore.reflectDayEvent({
        trigger: "wonder",
        previousPerception: samplePerception(900),
        currentPerception: samplePerception(1200),
        memory: sampleMemory(),
        recentObservations: sampleBundle().observations,
        recentActionSnapshot: sampleBundle().recent_action_snapshots[0]
      });

      await sleepCore.consolidate(sampleBundle(), sampleOutcome());

      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({
          recentDayReflections: [
            expect.objectContaining({
              trigger: "wonder",
              summary: expect.stringContaining("sunrise")
            })
          ]
        })
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses forced function calls for model-backed day reflection", async () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () =>
        responseWithFunctionCall("submit_day_reflection", {
          summary: "The sunrise over home felt worth carrying forward.",
          event_kind: "wonder",
          salience: 0.74,
          dominant_emotions: ["awed", "hopeful"],
          appraisal: {
            curiosity: 0.58,
            comfort: 0.42,
            wonder: 0.82
          },
          regulation: {
            arousal: 0.34,
            resolve: 0.3,
            recovery: 0.48
          },
          observation: {
            category: "beauty",
            summary: "The sunrise over home steadied something in him.",
            tags: ["wonder", "sunrise", "home"],
            importance: 0.74
          }
        })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
    const reflection = await consolidator.reflectDay({
      trigger: "wonder",
      previousPerception: samplePerception(900),
      currentPerception: samplePerception(1200),
      memory: sampleMemory(),
      recentObservations: sampleBundle().observations,
      recentActionSnapshot: sampleBundle().recent_action_snapshots[0],
      latestDayReflections: []
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    const requestBody = JSON.parse(String((request as RequestInit).body));
    expect(requestBody.tool_choice).toEqual({ type: "function", name: "submit_day_reflection" });
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "submit_day_reflection"
      })
    ]);
    expect(reflection.event_kind).toBe("wonder");
    expect(reflection.summary).toContain("sunrise");
  });

  it("fails loudly when the reflective model returns no function call", async () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Here is a prose answer instead." }]
            }
          ]
        })
      }))
    );

    const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
    await expect(
      consolidator.reflectDay({
        trigger: "wonder",
        previousPerception: samplePerception(900),
        currentPerception: samplePerception(1200),
        memory: sampleMemory(),
        recentObservations: sampleBundle().observations,
        recentActionSnapshot: sampleBundle().recent_action_snapshots[0],
        latestDayReflections: []
      })
    ).rejects.toThrow('Reflective model returned no function call for "submit_day_reflection"');
  });

  it("fails loudly when the reflective model returns the wrong function name", async () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          responseWithFunctionCall("submit_wrong_shape", {
            summary: "Unexpected tool."
          })
      }))
    );

    const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
    await expect(
      consolidator.synthesize({
        bundle: sampleBundle(),
        outcome: sampleOutcome(),
        recentCultureSignals: [],
        recentConsolidations: [],
        recentDayReflections: []
      })
    ).rejects.toThrow('Reflective model returned function call "submit_wrong_shape" instead of "submit_overnight_consolidation"');
  });

  it("fails loudly when the reflective model returns invalid function arguments JSON", async () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output: [
            {
              type: "function_call",
              name: "submit_day_reflection",
              arguments: "{\"summary\":"
            }
          ]
        })
      }))
    );

    const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
    await expect(
      consolidator.reflectDay({
        trigger: "wonder",
        previousPerception: samplePerception(900),
        currentPerception: samplePerception(1200),
        memory: sampleMemory(),
        recentObservations: sampleBundle().observations,
        recentActionSnapshot: sampleBundle().recent_action_snapshots[0],
        latestDayReflections: []
      })
    ).rejects.toThrow('Reflective model returned invalid function arguments JSON for "submit_day_reflection"');
  });

  it("surfaces reflective HTTP failures directly", async () => {
    process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL = "gpt-sleep-test";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.RESIDENT_OPENAI_BASE_URL = "https://sleep.example/v1";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502
      }))
    );

    const consolidator = createOpenAIReflectiveConsolidatorFromEnv();
    await expect(
      consolidator.synthesize({
        bundle: sampleBundle(),
        outcome: sampleOutcome(),
        recentCultureSignals: [],
        recentConsolidations: [],
        recentDayReflections: []
      })
    ).rejects.toThrow("Reflective model request failed with status 502.");
  });

  it("uses day reflection wording for day validation failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-day-reflection-invalid-"));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store, {
        ...sampleConsolidator(),
        reflectDay: vi.fn(async () => ({
          summary: "",
          event_kind: "wonder",
          salience: 0.4,
          dominant_emotions: ["curious"],
          appraisal: {
            wonder: 0.5
          },
          regulation: {
            recovery: 0.36
          }
        }))
      });

      await expect(
        sleepCore.reflectDayEvent({
          trigger: "wonder",
          previousPerception: samplePerception(900),
          currentPerception: samplePerception(1200),
          memory: sampleMemory(),
          recentObservations: sampleBundle().observations,
          recentActionSnapshot: sampleBundle().recent_action_snapshots[0]
        })
      ).rejects.toThrow('Day reflection field "summary" must be a non-empty string.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      homeKnown: true,
      starterWoodSecured: true,
      woodReserveLow: false,
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
    },
    emotion_core: {
      axes: {
        threat: 0.24,
        loss: 0.16,
        pain: 0.08,
        curiosity: 0.48,
        connection: 0.42,
        comfort: 0.52,
        mastery: 0.46,
        wonder: 0.58
      },
      regulation: {
        arousal: 0.34,
        shock: 0.08,
        vigilance: 0.24,
        resolve: 0.46,
        recovery: 0.6
      },
      action_biases: {
        avoid_risk: 0.22,
        seek_shelter: 0.2,
        seek_recovery: 0.18,
        seek_company: 0.24,
        seek_mastery: 0.32,
        seek_wonder: 0.38,
        cautious_revisit: 0.12
      },
      dominant_emotions: ["resolved", "awed"],
      recent_episodes: [],
      tagged_places: [],
      bonded_entities: []
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

function sampleMemory() {
  const memory = createMemoryState();
  memory.current_day = 3;
  memory.self_name = "Hazel";
  memory.home_anchor = { x: 0, y: 64, z: 0 };
  memory.place_tags = ["home", "quiet corner"];
  memory.emotion_core = sampleBundle().emotion_core;
  memory.recent_observations = sampleBundle().observations;
  memory.recent_action_snapshots = sampleBundle().recent_action_snapshots;
  return memory;
}

function samplePerception(tickTime: number): PerceptionFrame {
  return {
    agent_id: "resident-1",
    tick_time: tickTime,
    position: { x: 2, y: 64, z: 2 },
    weather: "clear",
    light_level: 15,
    health: 20,
    hunger: 18,
    inventory: { oak_log: 8 },
    nearby_entities: [],
    nearby_blocks: [],
    home_state: {
      anchor: { x: 0, y: 64, z: 0 },
      shelterScore: 0.82,
      bedAvailable: true,
      workshopReady: true,
      guestCapacity: 0
    },
    snapshot_refs: [],
    notable_places: ["home", "sunrise ridge"],
    pantry_state: {
      carriedCalories: 180,
      pantryCalories: 220,
      cookedMeals: 1,
      cropReadiness: 0,
      emergencyReserveDays: 2
    },
    farm_state: {
      farmlandReady: false,
      plantedCrops: [],
      hydratedTiles: 0,
      harvestableTiles: 0,
      seedStock: {}
    },
    livestock_state: DEFAULT_LIVESTOCK_STATE,
    combat_state: {
      hostilesNearby: 0,
      armorScore: 0,
      weaponTier: "none",
      escapeRouteKnown: true
    },
    safe_route_state: {
      homeRouteKnown: true,
      nearestShelter: { x: 0, y: 64, z: 0 },
      nightSafeRadius: 24
    },
    workstation_state: {
      craftingTableNearby: true,
      furnaceNearby: false,
      smokerNearby: false,
      blastFurnaceNearby: false,
      chestNearby: false
    },
    storage_sites: [],
    crop_sites: [],
    terrain_affordances: [],
    protected_areas: [],
    settlement_zones: []
  };
}

function sampleConsolidator(): ReflectiveConsolidator {
  return {
    modelName: "sleep-test",
    synthesize: vi.fn(async () => ({
      summary: "A careful night gathered the day into memory.",
      insights: ["Keep the doorway warm and ready."],
      risk_themes: ["Skeleton near the tree line."],
      emotional_themes: ["resolved", "relieved"],
      place_memories: ["home", "quiet corner"],
      project_memories: ["Doorway Repair: Keep the entrance dry and bright."],
      creative_motifs: ["The doorway looked warm in the rain."]
    })),
    reflectDay: vi.fn(async () => ({
      summary: "The sunrise at home felt worth carrying forward.",
      event_kind: "wonder",
      salience: 0.74,
      dominant_emotions: ["awed", "hopeful"],
      appraisal: {
        curiosity: 0.58,
        comfort: 0.42,
        wonder: 0.82
      },
      regulation: {
        arousal: 0.34,
        resolve: 0.3,
        recovery: 0.48
      },
      subject: {
        kind: "place",
        label: "sunrise ridge"
      },
      place: {
        kind: "awe_site",
        label: "sunrise ridge",
        location: { x: 2, y: 64, z: 2 },
        salience: 0.76,
        revisit_policy: "open"
      },
      observation: {
        category: "beauty",
        summary: "The sunrise over home steadied something in him.",
        tags: ["wonder", "sunrise", "home"],
        importance: 0.74
      }
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

function responseWithFunctionCall(name: string, argumentsPayload: Record<string, unknown>) {
  return {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "\n" }]
      },
      {
        type: "function_call",
        name,
        arguments: JSON.stringify(argumentsPayload)
      }
    ]
  };
}
