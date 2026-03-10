import {
  ActionReport,
  DailyOutcome,
  MemoryBundle,
  MemoryObservation,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  ProtectedArea,
  RecentActionSnapshot,
  RecallQuery,
  RecallResult,
  WakeOrientation
} from "@resident/shared";
import { FileBackedMemoryStore, PendingSleepWork } from "./file-store";
import { LongTermMemoryArchive, recallFromMemory } from "./recall";
import {
  applyWakeOrientation,
  applyResidentEmotionEventToMemory,
  buildMemoryBundle,
  consumeEmotionInterrupt,
  mergeProtectedAreas,
  rememberActionSnapshot,
  rememberActionReport,
  rememberObservation,
  syncMemoryState,
  updateProtectedAreas
} from "./memory-state";
import { ResidentEmotionEvent } from "../emotion-core";

export class MemoryManager {
  constructor(
    private readonly store: FileBackedMemoryStore,
    private readonly longTermArchive: LongTermMemoryArchive
  ) {}

  async current(): Promise<MemoryState> {
    const data = await this.store.load();
    return data.memory;
  }

  async replace(memory: MemoryState): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = memory;
    await this.store.save(data);
    return data.memory;
  }

  async syncPerception(perception: PerceptionFrame, overnight?: OvernightConsolidation): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = syncMemoryState(data.memory, perception, overnight);
    await this.store.save(data);
    return data.memory;
  }

  async remember(observation: MemoryObservation): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = rememberObservation(data.memory, observation);
    await this.store.save(data);
    return data.memory;
  }

  async rememberReport(report: ActionReport): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = rememberActionReport(data.memory, report);
    await this.store.save(data);
    return data.memory;
  }

  async rememberActionSnapshot(snapshot: RecentActionSnapshot): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = rememberActionSnapshot(data.memory, snapshot);
    await this.store.save(data);
    return data.memory;
  }

  async setProtectedAreas(protectedAreas: ProtectedArea[]): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = updateProtectedAreas(data.memory, protectedAreas);
    await this.store.save(data);
    return data.memory;
  }

  async mergeProtectedAreas(protectedAreas: ProtectedArea[]): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = mergeProtectedAreas(data.memory, protectedAreas);
    await this.store.save(data);
    return data.memory;
  }

  async applyOrientation(orientation: WakeOrientation): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = applyWakeOrientation(data.memory, orientation);
    await this.store.save(data);
    return data.memory;
  }

  async applyResidentEmotionEvent(event: ResidentEmotionEvent): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = applyResidentEmotionEventToMemory(data.memory, event);
    await this.store.save(data);
    return data.memory;
  }

  async consumeEmotionInterrupt(): Promise<MemoryState> {
    const data = await this.store.load();
    data.memory = consumeEmotionInterrupt(data.memory);
    await this.store.save(data);
    return data.memory;
  }

  async buildBundle(agentId: string): Promise<MemoryBundle> {
    const data = await this.store.load();
    return buildMemoryBundle(data.memory, agentId);
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    const data = await this.store.load();
    const consolidations = await this.longTermArchive.loadConsolidations();
    return recallFromMemory(data.memory, consolidations, query);
  }

  async queueSleepWork(bundle: MemoryBundle, outcome: DailyOutcome, lastError?: string): Promise<PendingSleepWork> {
    const data = await this.store.load();
    const queued: PendingSleepWork = {
      id: `${bundle.day_number}:${bundle.created_at}`,
      queued_at: new Date().toISOString(),
      bundle,
      outcome,
      attempts: 1,
      last_error: lastError
    };
    data.pending_sleep_work = data.pending_sleep_work.filter((entry) => entry.id !== queued.id);
    data.pending_sleep_work.push(queued);
    await this.store.save(data);
    return queued;
  }

  async pendingSleepWork(): Promise<PendingSleepWork[]> {
    const data = await this.store.load();
    return data.pending_sleep_work;
  }

  async resolveSleepWork(id: string): Promise<void> {
    const data = await this.store.load();
    data.pending_sleep_work = data.pending_sleep_work.filter((entry) => entry.id !== id);
    await this.store.save(data);
  }

  async markSleepWorkRetry(id: string, lastError: string): Promise<void> {
    const data = await this.store.load();
    data.pending_sleep_work = data.pending_sleep_work.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            attempts: entry.attempts + 1,
            last_error: lastError
          }
        : entry
    );
    await this.store.save(data);
  }
}
