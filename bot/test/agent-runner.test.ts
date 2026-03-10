import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VALUE_PROFILE, MemoryState, PerceptionFrame } from "@resident/shared";

const driverConnect = vi.fn();
const runtimeTick = vi.fn();
const executiveDecide = vi.fn();
const memoryCurrent = vi.fn();
const memoryReplace = vi.fn();
const memoryRemember = vi.fn();
const memoryRememberReport = vi.fn();
const memorySyncPerception = vi.fn();
const memoryRecall = vi.fn();
const memoryPendingSleepWork = vi.fn();
const sleepLatestOvernight = vi.fn();
const sleepCurrentValues = vi.fn();
const createServer = vi.fn(() => ({ close: vi.fn() }));
const createSleepConsolidatorFromEnv = vi.fn(() => ({ modelName: "sleep-test", synthesize: vi.fn() }));
const memoryCtorArgs: unknown[][] = [];
const sleepCtorArgs: unknown[][] = [];

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
  }

  class ResidentExecutive {
    constructor(_planner?: unknown) {}

    decide = executiveDecide;
  }

  return {
    createOpenAIExecutivePlannerFromEnv: vi.fn(),
    createOpenAISleepConsolidatorFromEnv: createSleepConsolidatorFromEnv,
    createResidentBrainServer: createServer,
    FileBackedMemoryStore,
    FileBackedSleepStore,
    MemoryManager,
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
    memorySyncPerception.mockReset();
    memoryRecall.mockReset();
    memoryPendingSleepWork.mockReset();
    sleepLatestOvernight.mockReset();
    sleepCurrentValues.mockReset();
    createServer.mockClear();
    createSleepConsolidatorFromEnv.mockClear();
    memoryCtorArgs.length = 0;
    sleepCtorArgs.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    expect(sleepCtorArgs[0]?.[1]).toBe(createSleepConsolidatorFromEnv.mock.results[0]?.value);
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
    expect(executiveDecide.mock.calls[1]?.[4]).toBe("task_failure");
  });
});

function createMemory(): MemoryState {
  return {
    current_day: 1,
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
    self_narrative: ["I am here to live well."],
    carry_over_commitments: [],
    last_updated_at: "2026-03-09T11:00:00.000Z"
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
