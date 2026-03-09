export * from "./resident-bot";
export * from "./live-mineflayer-driver";
export * from "./agent-runner";

if (require.main === module) {
  const mode = process.argv[2] ?? "run";
  if (mode === "run") {
    const runner = new (require("./agent-runner").ResidentAgentRunner)({
      host: process.env.MINECRAFT_HOST ?? "127.0.0.1",
      port: Number(process.env.MINECRAFT_PORT ?? 25565),
      username: process.env.MINECRAFT_USERNAME ?? "resident-1",
      version: process.env.MINECRAFT_VERSION,
      auth: (process.env.MINECRAFT_AUTH as "offline" | "microsoft" | undefined) ?? "offline",
      viewerPort: process.env.MINECRAFT_VIEWER_PORT ? Number(process.env.MINECRAFT_VIEWER_PORT) : undefined
    });

    runner.run().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
