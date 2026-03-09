import { EventEmitter } from "node:events";
import Module from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
