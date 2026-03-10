import type { ResidentAgentRunnerConfig } from "./agent-runner";

export * from "./resident-bot";
export * from "./live-mineflayer-driver";
export * from "./agent-runner";
export * from "./presentation-state";

export const DEFAULT_MINECRAFT_VIEWER_PORT = 3000;

export function resolveRunnerConfig(env: NodeJS.ProcessEnv = process.env): ResidentAgentRunnerConfig {
  return {
    host: env.MINECRAFT_HOST ?? "127.0.0.1",
    port: Number(env.MINECRAFT_PORT ?? 25565),
    username: env.MINECRAFT_USERNAME ?? "resident-1",
    version: env.MINECRAFT_VERSION,
    auth: (env.MINECRAFT_AUTH as "offline" | "microsoft" | undefined) ?? "offline",
    viewerPort: env.MINECRAFT_VIEWER_PORT ? Number(env.MINECRAFT_VIEWER_PORT) : DEFAULT_MINECRAFT_VIEWER_PORT,
    serveBrain: env.RESIDENT_SERVE_BRAIN ? env.RESIDENT_SERVE_BRAIN !== "false" : undefined
  };
}

if (require.main === module) {
  const mode = process.argv[2] ?? "run";
  if (mode === "run") {
    const runner = new (require("./agent-runner").ResidentAgentRunner)(resolveRunnerConfig());

    runner.run().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
