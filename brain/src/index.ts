import { FileBackedMemoryStore } from "./memory/file-store";
import { MemoryManager } from "./memory/memory-manager";
import { FileBackedSleepStore } from "./sleep/file-store";
import { createOpenAISleepConsolidatorFromEnv } from "./sleep/openai-sleep-consolidator";
import { SleepCore } from "./sleep/sleep-core";
import { createResidentBrainServer } from "./server/http";
import { WakeBrain } from "./wake-brain";

export * from "./wake-brain";
export * from "./sleep/sleep-core";
export * from "./planning/craft-planner";
export * from "./planning/build-planner";
export * from "./memory/memory-state";
export * from "./memory/memory-manager";
export * from "./memory/recall";
export * from "./memory/file-store";
export * from "./sleep/file-store";
export * from "./sleep/openai-sleep-consolidator";
export * from "./executive/openai-executive";
export * from "./executive/resident-executive";
export * from "./server/http";

if (require.main === module) {
  const mode = process.argv[2] ?? "brain";
  if (mode === "brain" || mode === "sleep") {
    const memoryStore = new FileBackedMemoryStore(
      process.env.RESIDENT_MEMORY_STORE ?? `${process.cwd()}/brain/.resident-data/memory.json`
    );
    const store = new FileBackedSleepStore(
      process.env.RESIDENT_SLEEP_STORE ?? `${process.cwd()}/brain/.resident-data/sleep-core.json`
    );
    const memory = new MemoryManager(memoryStore, store);
    const sleepCore = new SleepCore(store, createOpenAISleepConsolidatorFromEnv());
    const port = Number(process.env.RESIDENT_BRAIN_PORT ?? process.env.RESIDENT_SLEEP_PORT ?? 8787);
    createResidentBrainServer(memory, sleepCore, port);
    process.stdout.write(`resident brain listening on ${port}\n`);
  } else if (mode === "wake") {
    const wakeBrain = new WakeBrain();
    process.stdout.write(`wake-brain ready: ${wakeBrain.constructor.name}\n`);
  }
}
