import { describe, expect, it } from "vitest";
import { DEFAULT_MINECRAFT_VIEWER_PORT, resolveRunnerConfig } from "../src";

describe("bot entry config", () => {
  it("defaults the viewer port when no override is provided", () => {
    const config = resolveRunnerConfig({});

    expect(config.viewerPort).toBe(DEFAULT_MINECRAFT_VIEWER_PORT);
  });

  it("uses an explicit viewer port override", () => {
    const config = resolveRunnerConfig({
      MINECRAFT_VIEWER_PORT: "4123"
    });

    expect(config.viewerPort).toBe(4123);
  });

  it("allows the runner brain server to be disabled explicitly", () => {
    const config = resolveRunnerConfig({
      RESIDENT_SERVE_BRAIN: "false"
    });

    expect(config.serveBrain).toBe(false);
  });
});
