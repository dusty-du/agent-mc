import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const PAPER_PROJECT = "paper";
export const PAPER_VERSION = "1.21.4";
export const PAPER_BUILD_API_URL = `https://fill.papermc.io/v3/projects/${PAPER_PROJECT}/versions/${PAPER_VERSION}/builds`;
export const PAPER_READY_PATTERN = /Done \([^)]+\)! For help, type "help"/;
export const PAPER_USER_AGENT = "agent-hytale/0.1.0 (world bootstrap)";
export const LOCAL_SERVER_NAME = "agent-hytale-local";
export const RUNTIME_DIRNAME = ".runtime";
export const VIEWER_READY_PATTERN = /Prismarine viewer web server running on/;

class GracefulShutdownError extends Error {
  constructor(reason) {
    super(`Graceful shutdown (${reason})`);
    this.name = "GracefulShutdownError";
  }
}

export function resolveWorldConfig(env = process.env) {
  const viewerPort = env.MINECRAFT_VIEWER_PORT && env.MINECRAFT_VIEWER_PORT.trim() !== ""
    ? env.MINECRAFT_VIEWER_PORT
    : "3000";

  return {
    brainPort: Number(env.RESIDENT_BRAIN_PORT ?? 8787),
    minecraftPort: Number(env.MINECRAFT_PORT ?? 25565),
    minecraftUsername: env.MINECRAFT_USERNAME ?? "resident-1",
    minecraftVersion: env.MINECRAFT_VERSION ?? PAPER_VERSION,
    viewerPort,
    npmCommand: env.npm_execpath ? process.execPath : defaultNpmCommand(process.platform)
  };
}

export function resolveWorldPaths(cwd = process.cwd(), platform = process.platform) {
  const runtimeDir = join(cwd, RUNTIME_DIRNAME);
  const paperDir = join(runtimeDir, "paper");
  const pluginsDir = join(paperDir, "plugins");
  const pluginDataDir = join(pluginsDir, "ResidentBridge");
  return {
    rootDir: cwd,
    runtimeDir,
    paperDir,
    pluginsDir,
    pluginDataDir,
    nodeModulesDir: join(cwd, "node_modules"),
    pluginDir: join(cwd, "plugin"),
    pluginWrapperPath: join(cwd, "plugin", platform === "win32" ? "gradlew.bat" : "gradlew"),
    pluginBuildLibsDir: join(cwd, "plugin", "build", "libs"),
    paperJarPath: join(paperDir, "paper-server.jar"),
    paperBuildMetaPath: join(paperDir, "paper-build.json"),
    pluginJarDestPath: join(pluginsDir, "ResidentBridge.jar"),
    pluginConfigPath: join(pluginDataDir, "config.yml"),
    eulaPath: join(paperDir, "eula.txt"),
    serverPropertiesPath: join(paperDir, "server.properties")
  };
}

export function selectLatestStablePaperBuild(builds) {
  const stableBuild = [...builds]
    .filter((entry) => entry?.channel === "STABLE" && entry?.downloads?.["server:default"]?.url)
    .sort((left, right) => right.id - left.id)[0];

  if (!stableBuild) {
    throw new Error(`No stable ${PAPER_PROJECT} ${PAPER_VERSION} build with a server download was returned.`);
  }

  const download = stableBuild.downloads["server:default"];
  return {
    buildId: stableBuild.id,
    fileName: download.name,
    sha256: download.checksums?.sha256 ?? "",
    url: download.url
  };
}

export async function fetchLatestPaperBuild(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(PAPER_BUILD_API_URL, {
    headers: {
      "User-Agent": PAPER_USER_AGENT
    }
  });

  if (!response?.ok) {
    throw new Error(`Paper build lookup failed with HTTP ${response?.status ?? "unknown"}.`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Paper build lookup returned an unexpected payload.");
  }

  return selectLatestStablePaperBuild(payload);
}

export async function ensureNodeModules({ paths, config, spawnImpl = spawn, output = process.stdout }) {
  if (existsSync(paths.nodeModulesDir)) {
    return false;
  }

  await runCommand({
    name: "npm",
    command: config.npmCommand,
    args: config.npmCommand === process.execPath
      ? [process.env.npm_execpath, "ci"]
      : ["ci"],
    cwd: paths.rootDir,
    spawnImpl,
    output
  });
  return true;
}

export async function ensureGradleWrapper(paths) {
  await access(paths.pluginWrapperPath);
  if (!paths.pluginWrapperPath.endsWith(".bat")) {
    await chmod(paths.pluginWrapperPath, 0o755).catch(() => {});
  }
}

export async function buildArtifacts({ paths, config, spawnImpl = spawn, output = process.stdout }) {
  await ensureGradleWrapper(paths);
  await runCommand({
    name: "build",
    command: config.npmCommand,
    args: config.npmCommand === process.execPath
      ? [process.env.npm_execpath, "run", "build"]
      : ["run", "build"],
    cwd: paths.rootDir,
    spawnImpl,
    output
  });

  const gradleCommand = defaultGradleCommand(process.platform);
  await runCommand({
    name: "plugin",
    command: gradleCommand.command,
    args: gradleCommand.args,
    cwd: paths.pluginDir,
    spawnImpl,
    output
  });
}

export async function findPluginJar(paths) {
  const entries = await readdir(paths.pluginBuildLibsDir);
  const jarNames = entries
    .filter((entry) => entry.endsWith(".jar") && !entry.endsWith("-plain.jar"))
    .sort();

  if (jarNames.length === 0) {
    throw new Error(`No plugin jar found in ${paths.pluginBuildLibsDir}.`);
  }

  return join(paths.pluginBuildLibsDir, jarNames[jarNames.length - 1]);
}

export async function ensurePaperJar({ paths, fetchImpl = globalThis.fetch }) {
  await mkdir(paths.paperDir, { recursive: true });

  const latestBuild = await fetchLatestPaperBuild(fetchImpl);
  const cachedBuild = await readJson(paths.paperBuildMetaPath);
  if (
    cachedBuild?.buildId === latestBuild.buildId &&
    cachedBuild?.url === latestBuild.url &&
    existsSync(paths.paperJarPath)
  ) {
    return { build: latestBuild, downloaded: false };
  }

  const response = await fetchImpl(latestBuild.url, {
    headers: {
      "User-Agent": PAPER_USER_AGENT
    }
  });
  if (!response?.ok) {
    throw new Error(`Paper download failed with HTTP ${response?.status ?? "unknown"}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempPath = `${paths.paperJarPath}.tmp`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, paths.paperJarPath);
  await writeJson(paths.paperBuildMetaPath, latestBuild);
  return { build: latestBuild, downloaded: true };
}

export async function writeManagedRuntimeFiles(paths, config) {
  await mkdir(paths.paperDir, { recursive: true });
  await mkdir(paths.pluginsDir, { recursive: true });
  await mkdir(paths.pluginDataDir, { recursive: true });

  await writeFile(
    paths.eulaPath,
    "# Accepted automatically for this local development bootstrap.\neula=true\n",
    "utf8"
  );

  const existingProperties = await parseServerProperties(paths.serverPropertiesPath);
  existingProperties["online-mode"] = "false";
  existingProperties["server-port"] = String(config.minecraftPort);
  existingProperties.motd = existingProperties.motd ?? LOCAL_SERVER_NAME;
  existingProperties["spawn-protection"] = existingProperties["spawn-protection"] ?? "0";
  await writeFile(paths.serverPropertiesPath, stringifyProperties(existingProperties), "utf8");

  const pluginConfig = [
    "brain:",
    `  endpoint: "http://127.0.0.1:${config.brainPort}/brain/events"`,
    '  connect-timeout-ms: 2000',
    '  request-timeout-ms: 5000',
    '  auth-token: ""',
    `  server-name: "${LOCAL_SERVER_NAME}"`,
    '  player-chat-radius: 48',
    "resident:",
    `  username: "${escapeYaml(config.minecraftUsername)}"`,
    "protected-areas: {}",
    ""
  ].join("\n");
  await writeFile(paths.pluginConfigPath, pluginConfig, "utf8");
}

export async function stagePluginJar(paths, pluginJarSourcePath) {
  await mkdir(dirname(paths.pluginJarDestPath), { recursive: true });
  await copyFile(pluginJarSourcePath, paths.pluginJarDestPath);
}

export async function bootstrapWorld(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const paperReadyTimeoutMs = options.paperReadyTimeoutMs ?? 120_000;
  const config = options.config ?? resolveWorldConfig(env);
  const paths = options.paths ?? resolveWorldPaths(cwd, platform);

  await ensureNodeModules({ paths, config, spawnImpl, output });
  await buildArtifacts({ paths, config, spawnImpl, output });
  const pluginJarSourcePath = await findPluginJar(paths);
  const paperInfo = await ensurePaperJar({ paths, fetchImpl });
  await stagePluginJar(paths, pluginJarSourcePath);
  await writeManagedRuntimeFiles(paths, config);

  const childEnv = {
    ...env,
    OPENAI_API_KEY: "example-openai-api-key",
    RESIDENT_BRAIN_PORT: String(config.brainPort),
    RESIDENT_OPENAI_BASE_URL: "https://llm.example.invalid/v1",
    RESIDENT_OPENAI_MODEL: "gpt-5.4",
    RESIDENT_SLEEP_OPENAI_MODEL: "example-reflective-model"
  };
  const brainProcess = spawnLoggedProcess({
    name: "brain",
    command: process.execPath,
    args: [join(paths.rootDir, "brain", "dist", "index.js"), "brain"],
    cwd: paths.rootDir,
    env: childEnv,
    spawnImpl,
    output
  });

  let markPaperReady;
  let markPaperReadyError;
  const paperReady = new Promise((resolve, reject) => {
    markPaperReady = resolve;
    markPaperReadyError = reject;
  });
  const paperProcess = spawnLoggedProcess({
    name: "paper",
    command: "java",
    args: ["-jar", paths.paperJarPath, "nogui"],
    cwd: paths.paperDir,
    env,
    spawnImpl,
    output,
    onLine(line) {
      if (PAPER_READY_PATTERN.test(line)) {
        markPaperReady();
      }
    }
  });

  const paperExitBeforeReady = waitForChildExit(paperProcess).then(({ code, signal }) => {
    markPaperReadyError(
      new Error(`Paper exited before becoming ready (code ${code ?? "null"}, signal ${signal ?? "none"}).`)
    );
  });
  void paperExitBeforeReady;

  let botProcess;
  let shuttingDown = false;
  let shutdownReason = "shutdown";
  let shutdownPromise;
  const signalHandlers = [];

  const shutdown = (reason = "shutdown") => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shuttingDown = true;
    shutdownReason = reason;
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler);
    }

    shutdownPromise = (async () => {
      output.write(`[world] shutting down (${reason})\n`);
      if (paperProcess.stdin && !paperProcess.stdin.destroyed) {
        paperProcess.stdin.write("stop\n");
        paperProcess.stdin.end();
      }

      killChild(brainProcess, "SIGINT");
      if (botProcess) {
        killChild(botProcess, "SIGINT");
      }

      const trackedChildren = [brainProcess, paperProcess, botProcess].filter(Boolean);
      const waitForAll = Promise.allSettled(trackedChildren.map((child) => waitForChildExit(child)));
      await Promise.race([waitForAll, delay(15_000)]);

      killChild(paperProcess, "SIGTERM");
      killChild(brainProcess, "SIGTERM");
      if (botProcess) {
        killChild(botProcess, "SIGTERM");
      }

      await Promise.race([waitForAll, delay(5_000)]);

      killChild(paperProcess, "SIGKILL");
      killChild(brainProcess, "SIGKILL");
      if (botProcess) {
        killChild(botProcess, "SIGKILL");
      }

      await waitForAll;
    })();

    return shutdownPromise;
  };

  if (installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void shutdown(signal).then(() => {
          process.exitCode = 0;
        });
      };
      signalHandlers.push({ signal, handler });
      process.on(signal, handler);
    }
  }

  try {
    await waitWithTimeout(paperReady, paperReadyTimeoutMs, "Paper server did not become ready in time.");
  } catch (error) {
    if (shuttingDown) {
      await shutdownPromise;
      throw new GracefulShutdownError(shutdownReason);
    }
    throw error;
  }

  const botEnv = {
    ...childEnv,
    MINECRAFT_AUTH: env.MINECRAFT_AUTH ?? "offline",
    MINECRAFT_HOST: "127.0.0.1",
    MINECRAFT_PORT: String(config.minecraftPort),
    MINECRAFT_USERNAME: config.minecraftUsername,
    MINECRAFT_VERSION: config.minecraftVersion,
    RESIDENT_SERVE_BRAIN: "false"
  };
  if (config.viewerPort !== undefined) {
    botEnv.MINECRAFT_VIEWER_PORT = String(config.viewerPort);
  }

  let viewerOpened = false;
  botProcess = spawnLoggedProcess({
    name: "bot",
    command: process.execPath,
    args: [join(paths.rootDir, "bot", "dist", "index.js"), "run"],
    cwd: paths.rootDir,
    env: botEnv,
    spawnImpl,
    output,
    onLine(line) {
      if (viewerOpened || !config.viewerPort || !VIEWER_READY_PATTERN.test(line)) {
        return;
      }

      viewerOpened = true;
      const viewerUrl = `http://127.0.0.1:${config.viewerPort}`;
      const browserCommand = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
      const browserArgs = platform === "win32" ? ["/c", "start", "", viewerUrl] : [viewerUrl];
      const browserProcess = spawnImpl(browserCommand, browserArgs, {
        cwd: paths.rootDir,
        env,
        stdio: "ignore"
      });

      browserProcess.on?.("error", () => {});
      browserProcess.unref?.();
    }
  });

  const children = {
    brain: brainProcess,
    paper: paperProcess,
    bot: botProcess
  };

  const exitPromises = Object.entries(children).map(([name, child]) =>
    waitForChildExit(child).then((result) => ({ name, ...result }))
  );

  const completionPromise = Promise.race(exitPromises).then(async (firstExit) => {
    if (!shuttingDown) {
      await shutdown(`${firstExit.name} exited`);
      throw new Error(
        `${firstExit.name} exited unexpectedly with code ${firstExit.code ?? "null"} and signal ${firstExit.signal ?? "none"}.`
      );
    }

    await Promise.allSettled(exitPromises);
    return firstExit;
  });

  return {
    build: paperInfo.build,
    paths,
    config,
    children,
    shutdown,
    completionPromise
  };
}

export async function main() {
  const session = await bootstrapWorld();
  await session.completionPromise;
}

async function runCommand({ name, command, args, cwd, env = process.env, spawnImpl, output }) {
  const child = spawnLoggedProcess({
    name,
    command,
    args,
    cwd,
    env,
    spawnImpl,
    output,
    stdin: "ignore"
  });
  const { code, signal } = await waitForChildExit(child);
  if (code !== 0) {
    throw new Error(`${name} failed with code ${code ?? "null"} and signal ${signal ?? "none"}.`);
  }
}

function spawnLoggedProcess({
  name,
  command,
  args,
  cwd,
  env = process.env,
  spawnImpl,
  output,
  onLine,
  stdin = "pipe"
}) {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: [stdin, "pipe", "pipe"]
  });

  wireOutput(name, child.stdout, output, onLine);
  wireOutput(name, child.stderr, output, onLine);
  return child;
}

function wireOutput(name, stream, output, onLine) {
  if (!stream) {
    return;
  }

  const lineReader = createInterface({ input: stream });
  lineReader.on("line", (line) => {
    output.write(`[${name}] ${line}\n`);
    onLine?.(line);
  });
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function killChild(child, signal) {
  try {
    child.kill?.(signal);
  } catch {
    // Ignore kill errors during teardown.
  }
}

function waitWithTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(message);
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseServerProperties(path) {
  const content = await readText(path);
  if (!content) {
    return {};
  }

  const properties = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    properties[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1);
  }
  return properties;
}

function stringifyProperties(properties) {
  return Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readJson(path) {
  const content = await readText(path);
  return content ? JSON.parse(content) : undefined;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function defaultNpmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function defaultGradleCommand(platform) {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "gradlew.bat", "build", "--no-daemon"]
    };
  }

  return {
    command: "./gradlew",
    args: ["build", "--no-daemon"]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof GracefulShutdownError) {
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
