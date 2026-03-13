import { EventEmitter } from "node:events";
import Module from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMBAT_ENGAGE_DISTANCE } from "@resident/shared";

const createBot = vi.fn();
const pathfinderPlugin = Symbol("pathfinder");
const watcherServerCtor = vi.fn();
const watcherServerStart = vi.fn();

vi.mock("mineflayer", () => ({
  createBot
}));

vi.mock("../src/watcher-server", () => ({
  ResidentWatcherServer: class {
    constructor(...args: unknown[]) {
      watcherServerCtor(...args);
    }

    start = watcherServerStart;
    close = vi.fn();
  }
}));

describe("LiveMineflayerDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watcherServerStart.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the viewer after spawn in third-person mode", async () => {
    const originalRequire = Module.prototype.require;
    const requireSpy = vi.spyOn(Module.prototype, "require").mockImplementation(function (id: string) {
      if (id === "mineflayer-pathfinder") {
        return {
          pathfinder: pathfinderPlugin,
          goals: {
            GoalNear: class GoalNear {}
          }
        };
      }
      return originalRequire.call(this, id);
    });
    const bot = new EventEmitter() as any;
    bot.loadPlugin = vi.fn();
    bot.username = "resident-1";
    createBot.mockReturnValue(bot);

    const { LiveMineflayerDriver } = await import("../src/live-mineflayer-driver");
    const driver = new LiveMineflayerDriver({
      host: "127.0.0.1",
      port: 25565,
      username: "resident-1",
      viewerPort: 3000
    });

    const connectPromise = driver.connect();

    expect(watcherServerStart).not.toHaveBeenCalled();

    bot.entity = {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0
    };
    bot.emit("spawn");

    await expect(connectPromise).resolves.toBe(bot);
    requireSpy.mockRestore();
    expect(bot.loadPlugin).toHaveBeenCalledOnce();
    expect(bot.loadPlugin).toHaveBeenCalledWith(pathfinderPlugin);
    expect(watcherServerCtor).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({
        port: 3000,
        firstPerson: false,
        presentation: expect.any(Object)
      })
    );
    expect(watcherServerStart).toHaveBeenCalledOnce();
  });

  it("blocks fight intent when the nearest hostile is outside melee range", async () => {
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    const hostile = createHostile("zombie", COMBAT_ENGAGE_DISTANCE + 4);
    bot.entities = { hostile };

    const report = await driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "fight",
      reason: "danger",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "hostile_detection"
    });

    requireSpy.mockRestore();
    expect(bot.attack).not.toHaveBeenCalled();
    expect(report.status).toBe("blocked");
    expect(report.needs_replan).toBe(true);
    expect(report.notes[0]).toContain("outside melee range");
  });

  it("reports partial combat when a hostile survives the exchange", async () => {
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    const hostile = createHostile("zombie", COMBAT_ENGAGE_DISTANCE - 2);
    bot.attack.mockImplementation(async () => {
      hostile.position = { x: COMBAT_ENGAGE_DISTANCE + 6, y: 64, z: 0 };
    });
    bot.entities = { hostile };

    const report = await driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "fight",
      reason: "danger",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "hostile_detection"
    });

    requireSpy.mockRestore();
    expect(bot.attack).toHaveBeenCalledOnce();
    expect(report.status).toBe("partial");
    expect(report.needs_replan).toBe(true);
    expect(report.notes[0]).toContain("threat remains");
  });

  it("reports completed combat when the hostile is removed", async () => {
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    const hostile = createHostile("zombie", COMBAT_ENGAGE_DISTANCE - 2);
    bot.attack.mockImplementation(async () => {
      hostile.isValid = false;
    });
    bot.entities = { hostile };

    const report = await driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "fight",
      reason: "danger",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "hostile_detection"
    });

    requireSpy.mockRestore();
    expect(bot.attack).toHaveBeenCalledOnce();
    expect(report.status).toBe("completed");
    expect(report.needs_replan).toBe(false);
    expect(report.notes[0]).toContain("ended the immediate threat");
  });

  it("does not describe the resident as a nearby player during observe", async () => {
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    bot.entities = {
      self: {
        id: "resident",
        username: "resident-1",
        name: "resident-1",
        type: "player",
        position: { x: 0, y: 64, z: 0 }
      }
    };
    bot.findBlock = vi.fn(() => null);

    const report = await driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "observe",
      reason: "look around",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "idle_check"
    });

    requireSpy.mockRestore();
    expect(report.status).toBe("completed");
    expect(report.notes[0]).not.toContain("resident-1");
    expect([
      "I pause and let the area settle into focus around me.",
      "I hold still long enough to read the shape of the world around me.",
      "I pause and listen to what this place is telling me."
    ]).toContain(report.notes[0]);
  });

  it("returns a failed gather report when pathfinding times out instead of hanging the driver", async () => {
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);
    const timeoutError = new Error("Took to long to decide path to goal!");

    bot.findBlock = vi.fn(() => ({
      name: "oak_log",
      position: { x: 4, y: 64, z: 0 }
    }));
    bot.pathfinder.goto.mockRejectedValueOnce(timeoutError);
    bot.dig = vi.fn();

    const report = await driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "gather",
      target: "wood",
      reason: "bootstrap",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "idle_check"
    });

    requireSpy.mockRestore();
    expect(bot.dig).not.toHaveBeenCalled();
    expect(report.status).toBe("failed");
    expect(report.needs_replan).toBe(true);
    expect(report.notes[0]).toContain("Took to long to decide path to goal");
  });

  it("fails stalled move intents after the execution deadline instead of hanging forever", async () => {
    vi.useFakeTimers();
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    bot.pathfinder.goto.mockImplementation(() => new Promise(() => {}));

    const reportPromise = driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "move",
      target: { x: 8, y: 64, z: 0 },
      reason: "reposition",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "task_failure"
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const report = await reportPromise;

    requireSpy.mockRestore();
    expect(bot.pathfinder.stop).toHaveBeenCalledOnce();
    expect(report.status).toBe("failed");
    expect(report.needs_replan).toBe(true);
    expect(report.notes[0]).toContain("move timed out while waiting on navigation");
  });

  it("fails stalled gather intents after the execution deadline instead of hanging forever", async () => {
    vi.useFakeTimers();
    const { driver, bot, requireSpy } = await connectFightHarness((hostile) => hostile);

    bot.findBlock = vi.fn(() => ({
      name: "oak_log",
      position: { x: 4, y: 64, z: 0 }
    }));
    bot.pathfinder.goto.mockImplementation(() => new Promise(() => {}));

    const reportPromise = driver.executeIntent({
      agent_id: "resident-1",
      intent_type: "gather",
      target: "wood",
      reason: "bootstrap",
      priority: 1,
      cancel_conditions: [],
      success_conditions: [],
      trigger: "spawn"
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const report = await reportPromise;

    requireSpy.mockRestore();
    expect(bot.pathfinder.stop).toHaveBeenCalledOnce();
    expect(report.status).toBe("failed");
    expect(report.needs_replan).toBe(true);
    expect(report.notes[0]).toContain("gather timed out while waiting on navigation");
  });
});

async function connectFightHarness(mapHostile: (hostile: ReturnType<typeof createHostile>) => unknown) {
  const originalRequire = Module.prototype.require;
  const requireSpy = vi.spyOn(Module.prototype, "require").mockImplementation(function (id: string) {
    if (id === "mineflayer-pathfinder") {
      return {
        pathfinder: pathfinderPlugin,
        goals: {
          GoalNear: class GoalNear {}
        }
      };
    }
    return originalRequire.call(this, id);
  });

  const bot = new EventEmitter() as any;
  bot.loadPlugin = vi.fn();
  bot.username = "resident-1";
  bot.health = 20;
  bot.equip = vi.fn().mockResolvedValue(undefined);
  bot.attack = vi.fn().mockResolvedValue(undefined);
  bot.pathfinder = {
    goto: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn()
  };
  bot.dig = vi.fn().mockResolvedValue(undefined);
  bot.inventory = {
    items: vi.fn(() => [{ name: "stone_sword" }]),
    slots: Array(9).fill(null)
  };
  bot.findBlock = vi.fn(() => null);
  bot.entity = {
    id: "resident",
    position: {
      x: 0,
      y: 64,
      z: 0,
      distanceTo(target: { x: number; y: number; z: number }) {
        return Math.sqrt(target.x ** 2 + (target.y - 64) ** 2 + target.z ** 2);
      }
    },
    yaw: 0,
    pitch: 0
  };
  bot.entities = {
    hostile: mapHostile(createHostile("zombie", COMBAT_ENGAGE_DISTANCE - 2))
  };
  createBot.mockReturnValue(bot);

  const { LiveMineflayerDriver } = await import("../src/live-mineflayer-driver");
  const driver = new LiveMineflayerDriver({
    host: "127.0.0.1",
    port: 25565,
    username: "resident-1"
  });

  const connectPromise = driver.connect();
  bot.emit("spawn");
  await expect(connectPromise).resolves.toBe(bot);
  return { driver, bot, requireSpy };
}

function createHostile(name: string, distance: number) {
  return {
    id: `${name}-${distance}`,
    name,
    type: "mob",
    isValid: true,
    position: { x: distance, y: 64, z: 0 }
  };
}
