import { EventEmitter } from "node:events";
import Module from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMBAT_ENGAGE_DISTANCE } from "@resident/shared";

const createBot = vi.fn();
const mineflayerViewer = vi.fn();
const pathfinderPlugin = Symbol("pathfinder");
const collectBlockPlugin = Symbol("collect-block");

vi.mock("mineflayer", () => ({
  createBot
}));

describe("LiveMineflayerDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      if (id === "mineflayer-collectblock") {
        return {
          plugin: collectBlockPlugin
        };
      }
      if (id === "prismarine-viewer") {
        return {
          mineflayer: mineflayerViewer
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

    expect(mineflayerViewer).not.toHaveBeenCalled();

    bot.entity = {
      position: { x: 0, y: 64, z: 0 },
      yaw: 0,
      pitch: 0
    };
    bot.emit("spawn");

    await expect(connectPromise).resolves.toBe(bot);
    requireSpy.mockRestore();
    expect(bot.loadPlugin).toHaveBeenNthCalledWith(1, pathfinderPlugin);
    expect(bot.loadPlugin).toHaveBeenNthCalledWith(2, collectBlockPlugin);
    expect(mineflayerViewer).toHaveBeenCalledWith(bot, {
      port: 3000,
      firstPerson: false
    });
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
    expect(report.notes[0]).toBe("I pause and take in the quiet of the world around me.");
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
    if (id === "mineflayer-collectblock") {
      return {
        plugin: collectBlockPlugin
      };
    }
    if (id === "prismarine-viewer") {
      return {
        mineflayer: mineflayerViewer
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
    goto: vi.fn().mockResolvedValue(undefined)
  };
  bot.inventory = {
    items: vi.fn(() => [{ name: "stone_sword" }]),
    slots: Array(9).fill(null)
  };
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
