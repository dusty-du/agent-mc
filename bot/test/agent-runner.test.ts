import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VALUE_PROFILE, MemoryState, PerceptionFrame } from "@resident/shared";

const driverConnect = vi.fn();
const runtimeTick = vi.fn();
const executiveDecide = vi.fn();
const memoryCurrent = vi.fn();
const memoryReplace = vi.fn();
const memoryRemember = vi.fn();
const memoryRememberReport = vi.fn();
const memoryRememberActionSnapshot = vi.fn();
const memorySyncPerception = vi.fn();
const memoryRecall = vi.fn();
const memoryPendingSleepWork = vi.fn();
const sleepLatestOvernight = vi.fn();
const sleepCurrentValues = vi.fn();
const sleepReflectDayEvent = vi.fn();
const createServer = vi.fn(() => ({ close: vi.fn() }));
const createReflectiveConsolidatorFromEnv = vi.fn(() => ({ modelName: "sleep-test", synthesize: vi.fn(), reflectDay: vi.fn() }));
const rememberDayLifeReflection = vi.fn((memory: MemoryState) => memory);
const memoryCtorArgs: unknown[][] = [];
const sleepCtorArgs: unknown[][] = [];
const fetchMock = vi.fn();

vi.mock("@resident/brain", () => {
  class FileBackedMemoryStore {
    constructor(public readonly filePath: string) {}
  }

  class FileBackedSleepStore {
    constructor(public readonly filePath: string) {}
  }

  class MemoryManager {
    constructor(...args: unknown[]) {
      memoryCtorArgs.push(args);
    }

    current = memoryCurrent;
    replace = memoryReplace;
    remember = memoryRemember;
    rememberReport = memoryRememberReport;
    rememberActionSnapshot = memoryRememberActionSnapshot;
    syncPerception = memorySyncPerception;
    recall = memoryRecall;
    buildBundle = vi.fn();
    pendingSleepWork = memoryPendingSleepWork;
    resolveSleepWork = vi.fn();
    markSleepWorkRetry = vi.fn();
    queueSleepWork = vi.fn();
  }

  class SleepCore {
    constructor(...args: unknown[]) {
      sleepCtorArgs.push(args);
    }

    latestOvernight = sleepLatestOvernight;
    currentValues = sleepCurrentValues;
    consolidate = vi.fn();
    ingestCultureSignal = vi.fn();
    reflectDayEvent = sleepReflectDayEvent;
  }

  class ResidentExecutive {
    constructor(_planner?: unknown) {}

    decide = executiveDecide;
  }

  return {
    createOpenAIExecutivePlannerFromEnv: vi.fn(),
    createOpenAIReflectiveConsolidatorFromEnv: createReflectiveConsolidatorFromEnv,
    createResidentBrainServer: createServer,
    FileBackedMemoryStore,
    FileBackedSleepStore,
    MemoryManager,
    rememberDayLifeReflection,
    ResidentExecutive,
    SleepCore
  };
});

vi.mock("../src/live-mineflayer-driver", () => ({
  LiveMineflayerDriver: class {
    constructor(_config: unknown) {}

    connect = driverConnect;
  }
}));

vi.mock("../src/resident-bot", () => ({
  ResidentBotRuntime: class {
    constructor(_driver: unknown) {}

    tick = runtimeTick;
  }
}));

describe("ResidentAgentRunner", () => {
  beforeEach(() => {
    driverConnect.mockReset();
    runtimeTick.mockReset();
    executiveDecide.mockReset();
    memoryCurrent.mockReset();
    memoryReplace.mockReset();
    memoryRemember.mockReset();
    memoryRememberReport.mockReset();
    memoryRememberActionSnapshot.mockReset();
    memorySyncPerception.mockReset();
    memoryRecall.mockReset();
    memoryPendingSleepWork.mockReset();
    sleepLatestOvernight.mockReset();
    sleepCurrentValues.mockReset();
    sleepReflectDayEvent.mockReset();
    rememberDayLifeReflection.mockClear();
    createServer.mockClear();
    createReflectiveConsolidatorFromEnv.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    memoryCtorArgs.length = 0;
    sleepCtorArgs.length = 0;
    sleepReflectDayEvent.mockImplementation(async (input?: { trigger?: string }) =>
      createDayReflectionRecord((input?.trigger as Parameters<typeof createDayReflectionRecord>[0]) ?? "wonder")
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses memory.recall for daytime recall and shares the sleep archive with memory", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const perception = createPerception();
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(baseMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(baseMemory);
    memoryReplace.mockResolvedValue(baseMemory);
    memoryRemember.mockResolvedValue(baseMemory);
    memoryRememberReport.mockResolvedValue(baseMemory);
    memoryRememberActionSnapshot.mockResolvedValue(baseMemory);
    memoryRecall.mockResolvedValue({
      query: {
        query: "beautiful home",
        tags: ["home"]
      },
      matches: [
        {
          timestamp: "2026-03-09T12:00:00.000Z",
          summary: "Remember the garden path near home.",
          tags: ["home", "garden"],
          relevance: 0.8
        }
      ]
    });
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "check the area",
        priority: 4,
        cancel_conditions: [],
        success_conditions: [],
        trigger: "idle_check"
      },
      memory: baseMemory,
      observations: [],
      replanLevel: "soft",
      recallQuery: {
        query: "beautiful home",
        tags: ["home"]
      }
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      intervalMs: 0
    });

    await runner.run();

    expect(memoryCtorArgs[0]?.[1]).toBe(sleepCtorArgs[0]?.[0]);
    expect(sleepCtorArgs[0]?.[1]).toBe(createReflectiveConsolidatorFromEnv.mock.results[0]?.value);
    expect(memoryRememberActionSnapshot).toHaveBeenCalledOnce();
    expect(memoryRecall).toHaveBeenCalledOnce();
    expect(memoryRecall).toHaveBeenCalledWith({
      query: "beautiful home",
      tags: ["home"]
    });
    expect(memoryRemember).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Long memory surfaced: Remember the garden path near home.",
        source: "reflection"
      })
    );
  });

  it("turns replan-needed reports into task_failure on the next planning turn", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const perception = {
      ...createPerception(),
      nearby_entities: [
        {
          id: "hostile-1",
          name: "zombie",
          type: "hostile",
          distance: 18
        }
      ],
      combat_state: {
        hostilesNearby: 1,
        strongestThreat: "zombie",
        armorScore: 0,
        weaponTier: "none",
        escapeRouteKnown: true
      }
    };
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(baseMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(baseMemory);
    memoryReplace.mockResolvedValue(baseMemory);
    memoryRemember.mockResolvedValue(baseMemory);
    memoryRememberReport.mockResolvedValue(baseMemory);
    memoryRememberActionSnapshot.mockResolvedValue(baseMemory);
    executiveDecide
      .mockResolvedValueOnce({
        intent: {
          agent_id: "resident-1",
          intent_type: "fight",
          reason: "stay safe",
          priority: 2,
          cancel_conditions: [],
          success_conditions: [],
          trigger: "hostile_detection"
        },
        memory: baseMemory,
        observations: [],
        replanLevel: "hard"
      })
      .mockResolvedValueOnce({
        intent: {
          agent_id: "resident-1",
          intent_type: "observe",
          reason: "reassess",
          priority: 1,
          cancel_conditions: [],
          success_conditions: [],
          trigger: "task_failure"
        },
        memory: baseMemory,
        observations: [],
        replanLevel: "hard"
      });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockResolvedValueOnce({
        perception,
        report: {
          intent_type: "fight",
          status: "blocked",
          notes: ["Detected zombie, but it is still outside melee range."],
          damage_taken: 0,
          inventory_delta: {},
          world_delta: [],
          needs_replan: true
        }
      })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      intervalMs: 0
    });

    await runner.run();

    expect(executiveDecide).toHaveBeenCalledTimes(2);
    expect(memoryRememberActionSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        intent_type: "fight",
        target_class: "fight",
        status: "blocked"
      })
    );
    expect(executiveDecide.mock.calls[1]?.[4]).toBe("task_failure");
  });

  it("prefers pending emotion interrupts over the generic runner trigger and clears them after planning", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const interruptedMemory: MemoryState = {
      ...baseMemory,
      emotion_core: {
        ...baseMemory.emotion_core,
        pending_interrupt: {
          trigger: "respawn",
          reason: "Respawning should interrupt routine.",
          created_at: "2026-03-10T05:00:00.000Z"
        }
      }
    };
    const perception = createPerception();
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(interruptedMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(interruptedMemory);
    memoryReplace.mockResolvedValue(interruptedMemory);
    memoryRemember.mockResolvedValue(interruptedMemory);
    memoryRememberReport.mockResolvedValue(interruptedMemory);
    memoryRememberActionSnapshot.mockResolvedValue(interruptedMemory);
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "reorient after respawn",
        priority: 1,
        cancel_conditions: [],
        success_conditions: [],
        dialogue: "I need to take in where I woke up.",
        trigger: "respawn"
      },
      memory: interruptedMemory,
      observations: [],
      replanLevel: "hard"
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      intervalMs: 0
    });

    await runner.run();

    expect(executiveDecide.mock.calls[0]?.[4]).toBe("respawn");
    expect(memoryReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        emotion_core: expect.objectContaining({
          pending_interrupt: undefined
        })
      })
    );
  });

  it("also clears soft life-core interrupts after they are consumed", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const interruptedMemory: MemoryState = {
      ...baseMemory,
      emotion_core: {
        ...baseMemory.emotion_core,
        pending_interrupt: {
          trigger: "wonder",
          reason: "Sunrise deserves a pause.",
          created_at: "2026-03-10T05:10:00.000Z"
        }
      }
    };
    const perception = createPerception();
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(interruptedMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(interruptedMemory);
    memoryReplace.mockResolvedValue(interruptedMemory);
    memoryRemember.mockResolvedValue(interruptedMemory);
    memoryRememberReport.mockResolvedValue(interruptedMemory);
    memoryRememberActionSnapshot.mockResolvedValue(interruptedMemory);
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "honor the sunrise",
        priority: 1,
        cancel_conditions: [],
        success_conditions: [],
        dialogue: "I want to really see this before I move on.",
        trigger: "wonder"
      },
      memory: interruptedMemory,
      observations: [],
      replanLevel: "soft"
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      intervalMs: 0
    });

    await runner.run();

    expect(executiveDecide.mock.calls[0]?.[4]).toBe("wonder");
    expect(memoryReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        emotion_core: expect.objectContaining({
          pending_interrupt: undefined
        })
      })
    );
  });

  it("queues daytime reflective follow-up without blocking the finished turn", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const reflectiveMemory: MemoryState = {
      ...baseMemory,
      emotion_core: {
        ...baseMemory.emotion_core,
        pending_interrupt: {
          trigger: "wonder",
          reason: "The sunrise is worth carrying forward.",
          created_at: "2026-03-10T06:00:00.000Z"
        }
      }
    };
    const perception = {
      ...createPerception(),
      tick_time: 1200,
      notable_places: ["sunrise ridge"],
      terrain_affordances: [
        {
          type: "view" as const,
          location: { x: 2, y: 64, z: 2 },
          note: "clear horizon"
        }
      ]
    };
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;
    let resolveReflection: ((value: unknown) => void) | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(reflectiveMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(reflectiveMemory);
    memoryReplace.mockResolvedValue(reflectiveMemory);
    memoryRemember.mockResolvedValue(reflectiveMemory);
    memoryRememberReport.mockResolvedValue(reflectiveMemory);
    memoryRememberActionSnapshot.mockResolvedValue(reflectiveMemory);
    sleepReflectDayEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReflection = resolve;
        })
    );
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "honor the sunrise",
        priority: 1,
        cancel_conditions: [],
        success_conditions: [],
        dialogue: "I want one still moment with this before I move on.",
        trigger: "wonder"
      },
      memory: reflectiveMemory,
      observations: [],
      replanLevel: "soft"
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      intervalMs: 0
    });

    await runner.run();

    expect(sleepReflectDayEvent).toHaveBeenCalledOnce();
    expect(sleepReflectDayEvent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        trigger: "wonder"
      })
    );

    resolveReflection?.({
      id: "day-reflection:1",
      day_number: 1,
      created_at: "2026-03-10T06:00:02.000Z",
      trigger: "wonder",
      fingerprint: "wonder|sunrise-ridge|none|0:8:0",
      summary: "The sunrise over home felt worth carrying forward.",
      result: {
        summary: "The sunrise over home felt worth carrying forward.",
        event_kind: "wonder",
        salience: 0.74,
        dominant_emotions: ["awed"],
        appraisal: {
          curiosity: 0.58,
          wonder: 0.82,
          comfort: 0.42
        },
        regulation: {
          arousal: 0.34,
          recovery: 0.48
        },
        observation: {
          category: "beauty",
          summary: "The sunrise over home steadied something in him.",
          tags: ["wonder", "sunrise", "home"],
          importance: 0.74
        }
      }
    });
    await vi.waitFor(() => {
      expect(rememberDayLifeReflection).toHaveBeenCalled();
    });
  });

  it("publishes the current intent dialogue through the presentation source shared with the brain server", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const perception = createPerception();
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(baseMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(baseMemory);
    memoryReplace.mockResolvedValue(baseMemory);
    memoryRemember.mockResolvedValue(baseMemory);
    memoryRememberReport.mockResolvedValue(baseMemory);
    memoryRememberActionSnapshot.mockResolvedValue(baseMemory);
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "pause and think",
        priority: 3,
        cancel_conditions: [],
        success_conditions: [],
        dialogue: "I should pause and read the shape of this place.",
        trigger: "idle_check"
      },
      memory: baseMemory,
      observations: [],
      replanLevel: "soft"
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: true,
      intervalMs: 0
    });

    await runner.run();

    const presentation = createServer.mock.calls[0]?.[3]?.presentation;
    expect(presentation?.getPresentationState()).toEqual({
      thought: expect.objectContaining({
        residentId: "resident-1",
        residentName: "resident-1",
        text: "I should pause and read the shape of this place."
      })
    });
    expect(memoryRemember).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "I should pause and read the shape of this place.",
        source: "dialogue",
        tags: expect.arrayContaining(["thought", "dialogue", "observe"])
      })
    );
  });

  it("mirrors presentation updates to the standalone brain server when local brain serving is disabled", async () => {
    const { ResidentAgentRunner } = await import("../src/agent-runner");
    const baseMemory = createMemory();
    const perception = createPerception();
    let runner: InstanceType<typeof ResidentAgentRunner> | undefined;

    fetchMock.mockResolvedValue({
      ok: true,
      status: 202
    });
    driverConnect.mockResolvedValue(undefined);
    sleepLatestOvernight.mockResolvedValue(undefined);
    sleepCurrentValues.mockResolvedValue(DEFAULT_VALUE_PROFILE);
    memorySyncPerception.mockResolvedValue(baseMemory);
    memoryPendingSleepWork.mockResolvedValue([]);
    memoryCurrent.mockResolvedValue(baseMemory);
    memoryReplace.mockResolvedValue(baseMemory);
    memoryRemember.mockResolvedValue(baseMemory);
    memoryRememberReport.mockResolvedValue(baseMemory);
    memoryRememberActionSnapshot.mockResolvedValue(baseMemory);
    executiveDecide.mockResolvedValue({
      intent: {
        agent_id: "resident-1",
        intent_type: "observe",
        reason: "pause and think",
        priority: 3,
        cancel_conditions: [],
        success_conditions: [],
        dialogue: "I should look over the spruce line before I move.",
        trigger: "idle_check"
      },
      memory: baseMemory,
      observations: [],
      replanLevel: "soft"
    });
    runtimeTick
      .mockResolvedValueOnce({ perception })
      .mockImplementationOnce(async () => {
        runner?.stop();
        return {
          perception,
          report: {
            intent_type: "observe",
            status: "completed",
            notes: [],
            damage_taken: 0,
            inventory_delta: {},
            world_delta: [],
            needs_replan: false
          }
        };
      });

    runner = new ResidentAgentRunner({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      auth: "offline",
      serveBrain: false,
      brainPort: 8787,
      intervalMs: 0
    });

    await runner.run();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/resident/presentation",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json"
        }
      })
    );
    const requestInit = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
    expect(requestInit?.body).toBeDefined();
    expect(JSON.parse(requestInit?.body ?? "{}")).toEqual({
      thought: expect.objectContaining({
        residentId: "resident-1",
        residentName: "resident-1",
        text: "I should look over the spruce line before I move."
      })
    });
  });
});

function createMemory(): MemoryState {
  return {
    current_day: 1,
    personality_profile: {
      seed: "resident-seed",
      traits: {
        openness: 0.5,
        conscientiousness: 0.6,
        extraversion: 0.4,
        agreeableness: 0.55,
        threat_sensitivity: 0.45
      },
      chronotype: "steady",
      motifs: {
        primary: "homesteader",
        secondary: "tinkerer"
      },
      style_tags: ["homesteader", "steady"],
      updated_at: "2026-03-09T11:00:00.000Z"
    },
    self_name: "Hazel",
    self_name_chosen_at: "2026-03-09T11:00:00.000Z",
    need_state: {
      safety: 0.3,
      rest: 0.2,
      hunger: 0.2,
      autonomy: 0.4,
      competence: 0.4,
      relatedness: 0.25,
      beauty: 0.3
    },
    mind_state: {
      valence: 0.55,
      arousal: 0.3,
      confidence: 0.45,
      frustration: 0.1,
      fatigueDebt: 0.2,
      routinePhase: "work"
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
    known_beds: [],
    workstation_state: {
      craftingTableNearby: false,
      furnaceNearby: false,
      smokerNearby: false,
      blastFurnaceNearby: false,
      chestNearby: false
    },
    storage_sites: [],
    pantry_notes: [],
    crop_sites: [],
    safe_shelters: [],
    routes_home: [],
    protected_areas: [],
    settlement_zones: [],
    active_build_zones: [],
    salvage_tasks: [],
    combat_posture: [],
    craft_backlog: [],
    build_backlog: [],
    active_projects: [],
    current_goals: [],
    recent_observations: [],
    recent_interactions: [],
    recent_dangers: [],
    recent_action_snapshots: [],
    place_tags: [],
    affect: {
      mood: 0.6,
      stress: 0.2,
      loneliness: 0.2,
      wonder: 0.6,
      security: 0.7,
      belonging: 0.6,
      satisfaction: 0.6
    },
    emotion_core: {
      axes: {
        threat: 0.18,
        loss: 0.08,
        pain: 0.06,
        curiosity: 0.46,
        connection: 0.4,
        comfort: 0.5,
        mastery: 0.38,
        wonder: 0.42
      },
      regulation: {
        arousal: 0.28,
        shock: 0.04,
        vigilance: 0.22,
        resolve: 0.42,
        recovery: 0.56
      },
      action_biases: {
        avoid_risk: 0.18,
        seek_shelter: 0.18,
        seek_recovery: 0.16,
        seek_company: 0.18,
        seek_mastery: 0.24,
        seek_wonder: 0.28,
        cautious_revisit: 0.08
      },
      dominant_emotions: ["steady"],
      recent_episodes: [],
      tagged_places: [],
      bonded_entities: []
    },
    self_narrative: ["I am here to live well."],
    carry_over_commitments: [],
    last_updated_at: "2026-03-09T11:00:00.000Z"
  };
}

function createDayReflectionRecord(trigger: "wonder" | "respawn" | "death" | "birth" | "bonding" | "social_contact" = "wonder") {
  return {
    id: `day-reflection:${trigger}`,
    day_number: 1,
    created_at: "2026-03-10T06:00:02.000Z",
    trigger,
    fingerprint: `${trigger}|sunrise-ridge|none|0:8:0`,
    summary: "The sunrise over home felt worth carrying forward.",
    result: {
      summary: "The sunrise over home felt worth carrying forward.",
      event_kind: trigger === "death" ? "death" : trigger === "respawn" ? "safety" : trigger === "birth" ? "nurture" : "wonder",
      salience: 0.74,
      dominant_emotions: trigger === "death" ? ["shaken"] : ["awed"],
      appraisal:
        trigger === "death"
          ? {
              threat: 0.82,
              loss: 0.44,
              pain: 0.86
            }
          : {
              curiosity: 0.58,
              wonder: 0.82,
              comfort: 0.42
            },
      regulation:
        trigger === "death"
          ? {
              arousal: 0.88,
              shock: 0.92,
              vigilance: 0.76
            }
          : {
              arousal: 0.34,
              recovery: 0.48
            },
      interrupt:
        trigger === "respawn"
          ? {
              trigger: "respawn" as const,
              reason: "A fresh look is warranted."
            }
          : trigger === "death"
            ? {
                trigger: "death" as const,
                reason: "Danger still frames the next move."
              }
            : undefined,
      observation: {
        category: "beauty" as const,
        summary: "The sunrise over home steadied something in him.",
        tags: ["wonder", "sunrise", "home"],
        importance: 0.74
      }
    }
  };
}

function createPerception(): PerceptionFrame {
  return {
    agent_id: "resident-1",
    tick_time: 24000,
    position: { x: 0, y: 64, z: 0 },
    weather: "clear",
    light_level: 15,
    health: 20,
    hunger: 20,
    inventory: {},
    nearby_entities: [],
    nearby_blocks: [],
    home_state: {
      shelterScore: 0.8,
      bedAvailable: true,
      workshopReady: true,
      guestCapacity: 1
    },
    snapshot_refs: [],
    notable_places: ["garden path"],
    pantry_state: {
      carriedCalories: 0,
      pantryCalories: 0,
      cookedMeals: 0,
      cropReadiness: 0,
      emergencyReserveDays: 0
    },
    farm_state: {
      farmlandReady: false,
      plantedCrops: [],
      hydratedTiles: 0,
      harvestableTiles: 0,
      seedStock: {}
    },
    livestock_state: {
      counts: {},
      targetRanges: {},
      enclosureStatus: {},
      outputs: {},
      welfareFlags: []
    },
    combat_state: {
      hostilesNearby: 0,
      armorScore: 0,
      weaponTier: "none",
      escapeRouteKnown: true
    },
    safe_route_state: {
      homeRouteKnown: true,
      nightSafeRadius: 16
    }
  };
}
