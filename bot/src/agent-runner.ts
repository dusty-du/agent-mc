import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createOpenAIExecutivePlannerFromEnv,
  createOpenAISleepConsolidatorFromEnv,
  createResidentBrainServer,
  FileBackedMemoryStore,
  FileBackedSleepStore,
  MemoryManager,
  ResidentExecutive,
  SleepCore
} from "@resident/brain";
import {
  ActionReport,
  DailyOutcome,
  MemoryObservation,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  ProtectedArea,
  ReplanTrigger,
  ValueProfile
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE } from "@resident/shared";
import { LiveMineflayerDriver, LiveMineflayerDriverConfig } from "./live-mineflayer-driver";
import { IntentExecutionContext, ResidentBotRuntime } from "./resident-bot";

export interface ResidentAgentRunnerConfig extends LiveMineflayerDriverConfig {
  intervalMs?: number;
  serveBrain?: boolean;
  brainPort?: number;
  memoryStorePath?: string;
  sleepStorePath?: string;
}

export class ResidentAgentRunner {
  private readonly driver: LiveMineflayerDriver;
  private readonly runtime: ResidentBotRuntime;
  private readonly memory: MemoryManager;
  private readonly sleepCore: SleepCore;
  private readonly executive = new ResidentExecutive(createOpenAIExecutivePlannerFromEnv());
  private readonly intervalMs: number;
  private readonly serveBrain: boolean;
  private readonly brainPort: number;
  private brainServer?: ReturnType<typeof createResidentBrainServer>;
  private stopped = false;
  private pendingTrigger: ReplanTrigger = "spawn";
  private daily = new DailyAccumulator();

  constructor(private readonly config: ResidentAgentRunnerConfig) {
    this.driver = new LiveMineflayerDriver(config);
    this.runtime = new ResidentBotRuntime(this.driver);
    this.intervalMs = config.intervalMs ?? Number(process.env.RESIDENT_LOOP_MS ?? 4000);
    this.serveBrain = config.serveBrain ?? true;
    this.brainPort = config.brainPort ?? Number(process.env.RESIDENT_BRAIN_PORT ?? 8787);
    const sleepStore = new FileBackedSleepStore(
      config.sleepStorePath ?? process.env.RESIDENT_SLEEP_STORE ?? `${process.cwd()}/brain/.resident-data/sleep-core.json`
    );
    this.memory = new MemoryManager(
      new FileBackedMemoryStore(config.memoryStorePath ?? process.env.RESIDENT_MEMORY_STORE ?? `${process.cwd()}/brain/.resident-data/memory.json`),
      sleepStore
    );
    this.sleepCore = new SleepCore(sleepStore, createOpenAISleepConsolidatorFromEnv());
  }

  async run(): Promise<void> {
    await this.driver.connect();
    if (this.serveBrain) {
      this.brainServer = createResidentBrainServer(this.memory, this.sleepCore, this.brainPort);
    }

    let latestOvernight = await this.sleepCore.latestOvernight();
    let values = await this.sleepCore.currentValues().catch(() => DEFAULT_VALUE_PROFILE);
    let previousPerception = (await this.runtime.tick()).perception;
    await this.memory.syncPerception(previousPerception, latestOvernight);
    ({ latestOvernight, values } = await this.flushPendingSleepWork(latestOvernight, values));
    residentLog("runner_start", {
      agent: previousPerception.agent_id,
      position: previousPerception.position,
      brainPort: this.brainPort,
      serveBrain: this.serveBrain
    });

    while (!this.stopped) {
      ({ latestOvernight, values } = await this.flushPendingSleepWork(latestOvernight, values));
      const trigger = this.pendingTrigger;
      const currentMemory = await this.memory.current();
      residentLog("planning_turn", {
        trigger,
        day: currentMemory.current_day,
        hunger: previousPerception.hunger,
        health: previousPerception.health,
        hostiles: previousPerception.combat_state.hostilesNearby,
        position: previousPerception.position
      });
      const decision = await this.executive.decide(previousPerception, currentMemory, values, latestOvernight, trigger);
      const latestMemory = await this.memory.current();
      await this.memory.replace(mergeMemoryState(decision.memory, latestMemory));
      for (const observation of decision.observations) {
        await this.memory.remember(observation);
      }
      this.daily.recordObservations(decision.observations);

      if (decision.recallQuery) {
        residentLog("recall_query", {
          query: decision.recallQuery.query,
          tags: decision.recallQuery.tags ?? [],
          place: decision.recallQuery.place,
          project: decision.recallQuery.project_id
        });
        const recall = await this.memory.recall(decision.recallQuery);
        const best = recall.matches[0];
        if (best) {
          await this.memory.remember({
            timestamp: new Date().toISOString(),
            category: "project",
            summary: `Long memory surfaced: ${best.summary}`,
            tags: [...best.tags, "recall"],
            importance: Math.min(0.8, best.relevance),
            source: "reflection"
          });
        }
      }

      const context: IntentExecutionContext = {
        craftGoal: decision.craftGoal,
        buildPlan: decision.buildPlan
      };
      const tickResult = await this.runtime.tick(decision.intent, context);
      const nextPerception = tickResult.perception;
      const report = tickResult.report;
      residentLog("action_execution", {
        intent: decision.intent.intent_type,
        target: decision.intent.target,
        status: report?.status ?? "no-report",
        notes: report?.notes ?? []
      });
      await this.memory.syncPerception(nextPerception, latestOvernight);
      if (report) {
        await this.memory.rememberReport(report);
        this.daily.recordReport(report);
      }
      this.daily.recordPerception(nextPerception);

      if (decision.intent.intent_type === "sleep" && report?.status === "completed") {
        const bundle = await this.memory.buildBundle(nextPerception.agent_id);
        const outcome = this.daily.toOutcome(bundle.day_number);
        residentLog("memory_handoff", {
          day: bundle.day_number,
          summary: bundle.summary,
          observations: bundle.observations.length,
          projects: bundle.active_projects.length
        });
        try {
          const record = await this.sleepCore.consolidate(bundle, outcome);
          latestOvernight = record.overnight;
          residentLog("nightly_consolidation", {
            day: record.dayNumber,
            summary: record.summary,
            insights: record.insights
          });
          values = await this.sleepCore.currentValues();
          residentLog("value_update", {
            updatedAt: values.updatedAt,
            joy: values.joy,
            safety: values.safety,
            hospitality: values.hospitality,
            curiosity: values.curiosity
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.memory.queueSleepWork(bundle, outcome, message);
          residentLog("sleep_queue", {
            day: bundle.day_number,
            error: message
          });
        }
        this.pendingTrigger = "wake";
        this.daily.reset();
      } else {
        this.pendingTrigger = classifyTrigger(previousPerception, nextPerception, report, trigger);
      }

      previousPerception = nextPerception;
      await delay(this.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    this.brainServer?.close();
  }

  private async flushPendingSleepWork(
    latestOvernight: OvernightConsolidation | undefined,
    values: ValueProfile
  ): Promise<{ latestOvernight: OvernightConsolidation | undefined; values: ValueProfile }> {
    const pending = await this.memory.pendingSleepWork();
    for (const entry of pending) {
      try {
        residentLog("sleep_replay", {
          day: entry.bundle.day_number,
          queuedAt: entry.queued_at,
          attempts: entry.attempts
        });
        const record = await this.sleepCore.consolidate(entry.bundle, entry.outcome);
        await this.memory.resolveSleepWork(entry.id);
        latestOvernight = record.overnight;
        residentLog("nightly_consolidation", {
          day: record.dayNumber,
          summary: record.summary,
          insights: record.insights,
          replay: true
        });
        values = await this.sleepCore.currentValues().catch(() => values);
        residentLog("value_update", {
          updatedAt: values.updatedAt,
          joy: values.joy,
          safety: values.safety,
          hospitality: values.hospitality,
          curiosity: values.curiosity,
          replay: true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.memory.markSleepWorkRetry(entry.id, message);
        residentLog("sleep_replay_failed", {
          day: entry.bundle.day_number,
          error: message,
          attempts: entry.attempts + 1
        });
        break;
      }
    }

    return { latestOvernight, values };
  }
}

class DailyAccumulator {
  private mealsConsumed = 0;
  private hungerEmergencies = 0;
  private damageTaken = 0;
  private combatsWon = 0;
  private retreatsUsed = 0;
  private hostedPlayers = new Set<string>();
  private explorationMoments = 0;
  private craftedItems = 0;
  private buildActions = 0;
  private livestockStable = true;
  private joyMoments = 0;
  private recoveryMoments = 0;
  private setbacksFaced = 0;
  private meaningMoments = 0;
  private sleptInBed = false;

  recordObservations(observations: MemoryObservation[]): void {
    for (const observation of observations) {
      if (observation.category === "beauty" || observation.tags.includes("home") || observation.tags.includes("social")) {
        this.joyMoments += 1;
      }
      if (observation.category === "orientation" || observation.tags.includes("meaning") || observation.tags.includes("recovery")) {
        this.meaningMoments += 1;
      }
    }
  }

  recordReport(report: ActionReport): void {
    if (report.intent_type === "eat" && report.status === "completed") {
      this.mealsConsumed += 1;
      this.recoveryMoments += 1;
    }
    if (report.intent_type === "craft" && report.status === "completed") {
      this.craftedItems += 1;
    }
    if (["build", "rebuild", "repair"].includes(report.intent_type) && report.status === "completed") {
      this.buildActions += Math.max(1, report.world_delta.length);
    }
    if (report.intent_type === "fight" && report.status === "completed") {
      this.combatsWon += 1;
    }
    if (report.intent_type === "retreat" && report.status === "completed") {
      this.retreatsUsed += 1;
    }
    if (report.intent_type === "recover" && report.status !== "failed") {
      this.recoveryMoments += 1;
    }
    if (report.intent_type === "sleep" && report.status === "completed") {
      this.sleptInBed = true;
    }
    this.damageTaken += report.damage_taken;
    if (report.status === "failed" || report.needs_replan) {
      this.setbacksFaced += 1;
    }
  }

  recordPerception(perception: PerceptionFrame): void {
    if (perception.hunger <= 8) {
      this.hungerEmergencies += 1;
    }
    if (perception.notable_places.length > 0) {
      this.explorationMoments += 1;
    }
    if (perception.livestock_state.welfareFlags.length > 0) {
      this.livestockStable = false;
    }
    for (const entity of perception.nearby_entities) {
      if (entity.type === "player") {
        this.hostedPlayers.add(entity.name);
      }
    }
  }

  toOutcome(dayNumber: number): DailyOutcome {
    return {
      dayNumber,
      survived: true,
      sleptInBed: this.sleptInBed,
      mealsConsumed: this.mealsConsumed,
      hungerEmergencies: this.hungerEmergencies,
      damageTaken: this.damageTaken,
      combatsWon: this.combatsWon,
      retreatsUsed: this.retreatsUsed,
      hostedPlayers: this.hostedPlayers.size,
      explorationMoments: this.explorationMoments,
      craftedItems: this.craftedItems,
      buildActions: this.buildActions,
      livestockStable: this.livestockStable,
      joyMoments: this.joyMoments,
      recoveryMoments: this.recoveryMoments,
      setbacksFaced: this.setbacksFaced,
      meaningMoments: this.meaningMoments
    };
  }

  reset(): void {
    this.mealsConsumed = 0;
    this.hungerEmergencies = 0;
    this.damageTaken = 0;
    this.combatsWon = 0;
    this.retreatsUsed = 0;
    this.hostedPlayers.clear();
    this.explorationMoments = 0;
    this.craftedItems = 0;
    this.buildActions = 0;
    this.livestockStable = true;
    this.joyMoments = 0;
    this.recoveryMoments = 0;
    this.setbacksFaced = 0;
    this.meaningMoments = 0;
    this.sleptInBed = false;
  }
}

function classifyTrigger(
  previous: PerceptionFrame,
  current: PerceptionFrame,
  report: ActionReport | undefined,
  lastTrigger: ReplanTrigger
): ReplanTrigger {
  if (lastTrigger === "wake") {
    return "idle_check";
  }
  if (current.health < previous.health) {
    return "damage";
  }
  if (report?.notes.some((note) => note.toLowerCase().includes("protected"))) {
    return "protected_area_conflict";
  }
  if ((report?.damage_taken ?? 0) > 0 || current.health < previous.health) {
    return "damage";
  }
  if (report?.status === "failed") {
    return "task_failure";
  }
  if (report?.needs_replan) {
    return "task_failure";
  }
  if (current.combat_state.hostilesNearby > 0 && previous.combat_state.hostilesNearby === 0) {
    return "hostile_detection";
  }
  if (current.hunger <= 8 && previous.hunger > 8) {
    return "hunger_threshold";
  }
  if (crossedDawn(previous.tick_time, current.tick_time)) {
    return "dawn";
  }
  if (crossedDusk(previous.tick_time, current.tick_time)) {
    return "dusk";
  }
  if (inventoryHash(previous.inventory) !== inventoryHash(current.inventory)) {
    return "inventory_change";
  }
  if (report?.status === "completed") {
    return "task_completion";
  }
  if (hasNewPlayer(previous, current)) {
    return "player_interaction";
  }
  return "idle_check";
}

function crossedDawn(previousTick: number, currentTick: number): boolean {
  const previousTime = previousTick % 24000;
  const currentTime = currentTick % 24000;
  return previousTime > currentTime || (previousTime < 1000 && currentTime >= 1000 && currentTime < 4000);
}

function crossedDusk(previousTick: number, currentTick: number): boolean {
  const previousTime = previousTick % 24000;
  const currentTime = currentTick % 24000;
  return previousTime < 12500 && currentTime >= 12500;
}

function hasNewPlayer(previous: PerceptionFrame, current: PerceptionFrame): boolean {
  const before = new Set(previous.nearby_entities.filter((entity) => entity.type === "player").map((entity) => entity.name));
  return current.nearby_entities.some((entity) => entity.type === "player" && !before.has(entity.name));
}

function inventoryHash(inventory: Record<string, number>): string {
  return createHash("sha1").update(JSON.stringify(Object.entries(inventory).sort())).digest("hex");
}

function residentLog(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      component: "resident-runner",
      event,
      ...payload
    })}\n`
  );
}

function mergeMemoryState(primary: MemoryState, latest: MemoryState): MemoryState {
  return {
    ...primary,
    home_anchor: primary.home_anchor ?? latest.home_anchor,
    known_beds: mergeVecs(primary.known_beds, latest.known_beds),
    storage_sites: mergeByLocation(primary.storage_sites, latest.storage_sites),
    pantry_notes: mergeStrings(primary.pantry_notes, latest.pantry_notes, 12),
    crop_sites: mergeByLocation(primary.crop_sites, latest.crop_sites),
    safe_shelters: mergeVecs(primary.safe_shelters, latest.safe_shelters),
    routes_home: mergeVecs(primary.routes_home, latest.routes_home),
    protected_areas: mergeProtectedAreas(primary.protected_areas, latest.protected_areas),
    settlement_zones: mergeById(primary.settlement_zones, latest.settlement_zones),
    active_build_zones: mergeById(primary.active_build_zones, latest.active_build_zones),
    salvage_tasks: mergeStrings(primary.salvage_tasks, latest.salvage_tasks, 12),
    combat_posture: mergeStrings(primary.combat_posture, latest.combat_posture, 10),
    craft_backlog: mergeCraftGoals(primary.craft_backlog, latest.craft_backlog),
    build_backlog: mergeBuildIntents(primary.build_backlog, latest.build_backlog),
    active_projects: mergeById(primary.active_projects, latest.active_projects),
    current_goals: mergeStrings(primary.current_goals, latest.current_goals, 12),
    recent_observations: mergeObservations(primary.recent_observations, latest.recent_observations),
    recent_interactions: mergeStrings(primary.recent_interactions, latest.recent_interactions, 10),
    recent_dangers: mergeStrings(primary.recent_dangers, latest.recent_dangers, 10),
    place_tags: mergeStrings(primary.place_tags, latest.place_tags, 12),
    self_narrative: mergeStrings(primary.self_narrative, latest.self_narrative, 12),
    carry_over_commitments: mergeStrings(primary.carry_over_commitments, latest.carry_over_commitments, 10),
    last_wake_orientation: primary.last_wake_orientation ?? latest.last_wake_orientation,
    last_updated_at: new Date().toISOString()
  };
}

function mergeStrings(primary: string[], latest: string[], limit: number): string[] {
  return [...new Set([...latest, ...primary])].slice(-limit);
}

function mergeVecs(primary: Array<{ x: number; y: number; z: number }>, latest: Array<{ x: number; y: number; z: number }>) {
  const merged = new Map<string, { x: number; y: number; z: number }>();
  for (const entry of [...latest, ...primary]) {
    merged.set(`${Math.round(entry.x)}:${Math.round(entry.y)}:${Math.round(entry.z)}`, entry);
  }
  return [...merged.values()];
}

function mergeById<T extends { id: string }>(primary: T[], latest: T[]): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...latest, ...primary]) {
    merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

function mergeByLocation<T extends { location: { x: number; y: number; z: number } }>(primary: T[], latest: T[]): T[] {
  const merged = new Map<string, T>();
  for (const entry of [...latest, ...primary]) {
    merged.set(`${Math.round(entry.location.x)}:${Math.round(entry.location.y)}:${Math.round(entry.location.z)}`, entry);
  }
  return [...merged.values()];
}

function mergeProtectedAreas(primary: ProtectedArea[], latest: ProtectedArea[]): ProtectedArea[] {
  const merged = new Map<string, ProtectedArea>();
  for (const area of [...latest, ...primary]) {
    merged.set(area.id, area);
  }
  return [...merged.values()];
}

function mergeObservations(primary: MemoryObservation[], latest: MemoryObservation[]): MemoryObservation[] {
  const merged = new Map<string, MemoryObservation>();
  for (const observation of [...latest, ...primary]) {
    merged.set(`${observation.timestamp}:${observation.summary}`, observation);
  }
  return [...merged.values()].slice(-24);
}

function mergeCraftGoals(primary: MemoryState["craft_backlog"], latest: MemoryState["craft_backlog"]): MemoryState["craft_backlog"] {
  const merged = new Map<string, MemoryState["craft_backlog"][number]>();
  for (const goal of [...latest, ...primary]) {
    merged.set(`${goal.target_item}:${goal.purpose}`, goal);
  }
  return [...merged.values()];
}

function mergeBuildIntents(primary: MemoryState["build_backlog"], latest: MemoryState["build_backlog"]): MemoryState["build_backlog"] {
  const merged = new Map<string, MemoryState["build_backlog"][number]>();
  for (const intent of [...latest, ...primary]) {
    merged.set(`${intent.purpose}:${intent.rebuild_of ?? "new"}`, intent);
  }
  return [...merged.values()];
}
