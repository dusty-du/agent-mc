import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapWorld,
  ensurePaperJar,
  resolveWorldConfig,
  resolveWorldPaths
} from "../scripts/world.mjs";

const tempDirs: string[] = [];

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exited = false;

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.exit(0, signal ?? null);
    return true;
  });

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", code, signal));
  }
}

describe("world bootstrap", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("downloads Paper only when the latest build changes", async () => {
    const cwd = await createTempRepo();
    const paths = resolveWorldPaths(cwd);
    const downloadCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/builds")) {
        return jsonResponse([
          {
            id: 207,
            channel: "STABLE",
            downloads: {
              "server:default": {
                name: "paper-1.21.4-207.jar",
                checksums: { sha256: "abc" },
                url: "https://example.invalid/paper-207.jar"
              }
            }
          }
        ]);
      }

      downloadCalls.push(url);
      return binaryResponse("paper-binary");
    });

    const first = await ensurePaperJar({ paths, fetchImpl });
    const second = await ensurePaperJar({ paths, fetchImpl });

    expect(first.downloaded).toBe(true);
    expect(second.downloaded).toBe(false);
    expect(downloadCalls).toEqual(["https://example.invalid/paper-207.jar"]);
  });

  it("boots a clean local stack in the expected order and writes runtime files", async () => {
    const cwd = await createTempRepo();
    const output = new PassThrough();
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
    const paperStdin = new PassThrough();
    const stdinChunks: Buffer[] = [];

    const spawnImpl = vi.fn((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
      const child = new FakeChild();

      queueMicrotask(async () => {
        const joined = [command, ...args].join(" ");
        if (joined.includes(" ci")) {
          await mkdir(join(cwd, "node_modules"), { recursive: true });
          child.exit(0);
          return;
        }

        if (joined.includes(" run build")) {
          child.exit(0);
          return;
        }

        if (joined.includes("gradlew") && joined.includes(" build")) {
          await mkdir(join(cwd, "plugin", "build", "libs"), { recursive: true });
          await writeFile(
            join(cwd, "plugin", "build", "libs", "agent-hytale-plugin-0.1.0-SNAPSHOT.jar"),
            "jar",
            "utf8"
          );
          child.exit(0);
          return;
        }

        if (joined.includes("brain/dist/index.js")) {
          child.stdout.write("resident brain listening on 8787\n");
          return;
        }

        if (command === "java") {
          child.stdin = paperStdin;
          child.stdin.on("data", (chunk) => {
            const buffer = Buffer.from(chunk);
            stdinChunks.push(buffer);
            if (buffer.toString("utf8").includes("stop")) {
              child.exit(0);
            }
          });
          child.stdout.write('[Server thread/INFO]: Done (1.234s)! For help, type "help"\n');
          return;
        }

        if (joined.includes("bot/dist/index.js")) {
          child.stdout.write('{"component":"resident-runner","event":"runner_start"}\n');
        }
      });

      return child as any;
    });

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/builds")) {
        return jsonResponse([
          {
            id: 207,
            channel: "STABLE",
            downloads: {
              "server:default": {
                name: "paper-1.21.4-207.jar",
                checksums: { sha256: "abc" },
                url: "https://example.invalid/paper-207.jar"
              }
            }
          }
        ]);
      }

      return binaryResponse("paper-binary");
    });

    const session = await bootstrapWorld({
      cwd,
      env: {
        MINECRAFT_PORT: "25565",
        MINECRAFT_USERNAME: "resident-1",
        RESIDENT_BRAIN_PORT: "8787"
      },
      fetchImpl,
      spawnImpl,
      output,
      installSignalHandlers: false,
      paperReadyTimeoutMs: 5_000
    });

    expect(spawnCalls[0]).toMatchObject({ command: "npm", args: ["ci"] });
    expect(spawnCalls[1]).toMatchObject({ command: "npm", args: ["run", "build"] });
    expect(spawnCalls[2].args.join(" ")).toContain("build --no-daemon");
    expect(spawnCalls[3].args.join(" ")).toContain("brain/dist/index.js");
    expect(spawnCalls[4]).toMatchObject({ command: "java" });
    expect(spawnCalls[5].args.join(" ")).toContain("bot/dist/index.js");
    expect(spawnCalls[3].env).toEqual(
      expect.objectContaining({
        OPENAI_API_KEY: "example-openai-api-key",
        RESIDENT_OPENAI_BASE_URL: "https://llm.example.invalid/v1",
        RESIDENT_SLEEP_OPENAI_MODEL: "example-reflective-model"
      })
    );
    expect(spawnCalls[5].env).toEqual(
      expect.objectContaining({
        OPENAI_API_KEY: "example-openai-api-key",
        RESIDENT_OPENAI_BASE_URL: "https://llm.example.invalid/v1",
        RESIDENT_OPENAI_MODEL: "gpt-5.4",
        RESIDENT_SLEEP_OPENAI_MODEL: "example-reflective-model"
      })
    );

    expect(await readFile(join(cwd, ".runtime", "paper", "eula.txt"), "utf8")).toContain("eula=true");
    const properties = await readFile(join(cwd, ".runtime", "paper", "server.properties"), "utf8");
    expect(properties).toContain("online-mode=false");
    expect(properties).toContain("server-port=25565");
    expect(await readFile(join(cwd, ".runtime", "paper", "plugins", "ResidentBridge.jar"), "utf8")).toBe("jar");
    const pluginConfig = await readFile(
      join(cwd, ".runtime", "paper", "plugins", "ResidentBridge", "config.yml"),
      "utf8"
    );
    expect(pluginConfig).toContain('endpoint: "http://127.0.0.1:8787/brain/events"');
    expect(pluginConfig).toContain('username: "resident-1"');

    await session.shutdown("test");
    await session.completionPromise.catch(() => undefined);

    expect(Buffer.concat(stdinChunks).toString("utf8")).toContain("stop");
  });

  it("resolves runtime paths under a hidden .runtime directory", async () => {
    const cwd = await createTempRepo();
    const paths = resolveWorldPaths(cwd);
    const config = resolveWorldConfig({
      MINECRAFT_PORT: "25570",
      MINECRAFT_USERNAME: "resident-a",
      RESIDENT_BRAIN_PORT: "9999"
    } as NodeJS.ProcessEnv);

    expect(paths.runtimeDir).toBe(join(cwd, ".runtime"));
    expect(config.minecraftPort).toBe(25570);
    expect(config.minecraftUsername).toBe("resident-a");
    expect(config.brainPort).toBe(9999);
  });

  it("overrides conflicting parent llm env when launching brain and bot", async () => {
    const cwd = await createTempRepo();
    const output = new PassThrough();
    const spawnCalls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const paperStdin = new PassThrough();

    const spawnImpl = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ command, args, env: options.env });
      const child = new FakeChild();

      queueMicrotask(async () => {
        const joined = [command, ...args].join(" ");
        if (joined.includes(" ci")) {
          await mkdir(join(cwd, "node_modules"), { recursive: true });
          child.exit(0);
          return;
        }

        if (joined.includes(" run build")) {
          child.exit(0);
          return;
        }

        if (joined.includes("gradlew") && joined.includes(" build")) {
          await mkdir(join(cwd, "plugin", "build", "libs"), { recursive: true });
          await writeFile(
            join(cwd, "plugin", "build", "libs", "agent-hytale-plugin-0.1.0-SNAPSHOT.jar"),
            "jar",
            "utf8"
          );
          child.exit(0);
          return;
        }

        if (joined.includes("brain/dist/index.js")) {
          child.stdout.write("resident brain listening on 8787\n");
          return;
        }

        if (command === "java") {
          child.stdin = paperStdin;
          child.stdin.on("data", (chunk) => {
            if (Buffer.from(chunk).toString("utf8").includes("stop")) {
              child.exit(0);
            }
          });
          child.stdout.write('[Server thread/INFO]: Done (1.234s)! For help, type "help"\n');
          return;
        }

        if (joined.includes("bot/dist/index.js")) {
          child.stdout.write('{"component":"resident-runner","event":"runner_start"}\n');
        }
      });

      return child as any;
    });

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/builds")) {
        return jsonResponse([
          {
            id: 207,
            channel: "STABLE",
            downloads: {
              "server:default": {
                name: "paper-1.21.4-207.jar",
                checksums: { sha256: "abc" },
                url: "https://example.invalid/paper-207.jar"
              }
            }
          }
        ]);
      }

      return binaryResponse("paper-binary");
    });

    const session = await bootstrapWorld({
      cwd,
      env: {
        MINECRAFT_PORT: "25565",
        MINECRAFT_USERNAME: "resident-1",
        OPENAI_API_KEY: "wrong-key",
        RESIDENT_OPENAI_BASE_URL: "https://example.invalid/v1",
        RESIDENT_OPENAI_MODEL: "wrong-main",
        RESIDENT_SLEEP_OPENAI_MODEL: "wrong-sleep"
      },
      fetchImpl,
      spawnImpl,
      output,
      installSignalHandlers: false,
      paperReadyTimeoutMs: 5_000
    });

    const brainCall = spawnCalls.find((call) => call.args.join(" ").includes("brain/dist/index.js"));
    const botCall = spawnCalls.find((call) => call.args.join(" ").includes("bot/dist/index.js"));

    expect(brainCall?.env).toEqual(
      expect.objectContaining({
        OPENAI_API_KEY: "example-openai-api-key",
        RESIDENT_OPENAI_BASE_URL: "https://llm.example.invalid/v1",
        RESIDENT_OPENAI_MODEL: "gpt-5.4",
        RESIDENT_SLEEP_OPENAI_MODEL: "example-reflective-model"
      })
    );
    expect(botCall?.env).toEqual(
      expect.objectContaining({
        OPENAI_API_KEY: "example-openai-api-key",
        RESIDENT_OPENAI_BASE_URL: "https://llm.example.invalid/v1",
        RESIDENT_OPENAI_MODEL: "gpt-5.4",
        RESIDENT_SLEEP_OPENAI_MODEL: "example-reflective-model"
      })
    );

    await session.shutdown("test");
    await session.completionPromise.catch(() => undefined);
  });
});

async function createTempRepo() {
  const cwd = await mkdtemp(join(tmpdir(), "agent-hytale-world-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "plugin"), { recursive: true });
  await mkdir(join(cwd, "brain", "dist"), { recursive: true });
  await mkdir(join(cwd, "bot", "dist"), { recursive: true });
  await writeFile(join(cwd, "plugin", "gradlew"), "#!/bin/sh\n", "utf8");
  await chmod(join(cwd, "plugin", "gradlew"), 0o755);
  await writeFile(join(cwd, "brain", "dist", "index.js"), "", "utf8");
  await writeFile(join(cwd, "bot", "dist", "index.js"), "", "utf8");
  return cwd;
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  };
}

function binaryResponse(content: string) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer
  };
}
