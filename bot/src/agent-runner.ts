import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createOpenAIExecutivePlannerFromEnv,
  createOpenAIReflectiveConsolidatorFromEnv,
  createResidentBrainServer,
  FileBackedMemoryStore,
  FileBackedSleepStore,
  MemoryManager,
  rememberDayLifeReflection,
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
  RecentActionSnapshot,
  ResidentPresentationState,
  ReplanTrigger,
  ValueProfile
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE } from "@resident/shared";
import { LiveMineflayerDriver, LiveMineflayerDriverConfig } from "./live-mineflayer-driver";
import { ResidentPresentationController } from "./presentation-state";
import { IntentExecutionContext, ResidentBotRuntime } from "./resident-bot";

export interface ResidentAgentRunnerConfig extends LiveMineflayerDriverConfig {
  intervalMs?: number;
  serveBrain?: boolean;
  brainPort?: number;
  memoryStorePath?: string;
  sleepStorePath?: string;
}

interface DayReflectionCandidate {
  trigger: ReplanTrigger;
  priority: "hard" | "soft";
  fingerprint: string;
  previousPerception: PerceptionFrame;
  currentPerception: PerceptionFrame;
  report?: ActionReport;
  recentActionSnapshot?: RecentActionSnapshot;
  memory: MemoryState;
  overnight?: OvernightConsolidation;
}

export class ResidentAgentRunner {
  private readonly presentation = new ResidentPresentationController();
  private readonly driver: LiveMineflayerDriver;
  private readonly runtime: ResidentBotRuntime;
  private readonly memory: MemoryManager;
  private readonly sleepCore: SleepCore;
  private readonly executive = new ResidentExecutive(createOpenAIExecutivePlannerFromEnv());
  private readonly intervalMs: number;
  private readonly serveBrain: boolean;
  private readonly brainPort: number;
  private readonly remotePresentationEndpoint?: string;
  private brainServer?: ReturnType<typeof createResidentBrainServer>;
  private stopped = false;
  private pendingTrigger: ReplanTrigger = "spawn";
  private daily = new DailyAccumulator();
  private presentationSync = Promise.resolve();
  private dayReflectionInFlight?: Promise<void>;
  private queuedHardDayReflection?: DayReflectionCandidate;
  private queuedSoftDayReflection?: DayReflectionCandidate;
  private readonly softReflectionCooldowns = new Map<string, number>();

  constructor(private readonly config: ResidentAgentRunnerConfig) {
    this.driver = new LiveMineflayerDriver({
      ...config,
      presentation: this.presentation
    });
    this.runtime = new ResidentBotRuntime(this.driver);
    this.intervalMs = config.intervalMs ?? Number(process.env.RESIDENT_LOOP_MS ?? 4000);
    this.serveBrain = config.serveBrain ?? true;
    this.brainPort = config.brainPort ?? Number(process.env.RESIDENT_BRAIN_PORT ?? 8787);
    this.remotePresentationEndpoint = this.serveBrain ? undefined : `http://127.0.0.1:${this.brainPort}/resident/presentation`;
    const sleepStore = new FileBackedSleepStore(
      config.sleepStorePath ?? process.env.RESIDENT_SLEEP_STORE ?? `${process.cwd()}/brain/.resident-data/sleep-core.json`
    );
    this.memory = new MemoryManager(
      new FileBackedMemoryStore(config.memoryStorePath ?? process.env.RESIDENT_MEMORY_STORE ?? `${process.cwd()}/brain/.resident-data/memory.json`),
      sleepStore
    );
    this.sleepCore = new SleepCore(sleepStore, createOpenAIReflectiveConsolidatorFromEnv());
  }

  async run(): Promise<void> {
    await this.driver.connect();
    if (this.remotePresentationEndpoint) {
      void this.syncPresentationState({ thought: null });
      this.presentation.on("update", this.handlePresentationUpdate);
    }
    if (this.serveBrain) {
      this.brainServer = createResidentBrainServer(this.memory, this.sleepCore, this.brainPort, {
        presentation: this.presentation
      });
    }

    let latestOvernight = await this.sleepCore.latestOvernight();
    let values = await this.sleepCore.currentValues().catch(() => DEFAULT_VALUE_PROFILE);
    let previousPerception = (await this.runtime.tick()).perception;
    await this.memory.syncPerception(previousPerception, latestOvernight);
    ({ latestOvernight, values } = await this.flushPendingSleepWork(latestOvernight, values));
    const initialMemory = await this.memory.current();
    residentLog("runner_start", {
      agent: previousPerception.agent_id,
      selfName: initialMemory.self_name,
      position: previousPerception.position,
      brainPort: this.brainPort,
      serveBrain: this.serveBrain
    });

    while (!this.stopped) {
      ({ latestOvernight, values } = await this.flushPendingSleepWork(latestOvernight, values));
      const currentMemory = await this.memory.current();
      const emotionTrigger = currentMemory.emotion_core.pending_interrupt?.trigger;
      const trigger = emotionTrigger ?? this.pendingTrigger;
      const shouldClearEmotionTrigger = emotionTrigger === trigger;
      residentLog("planning_turn", {
        trigger,
        day: currentMemory.current_day,
        hunger: previousPerception.hunger,
        health: previousPerception.health,
        hostiles: previousPerception.combat_state.hostilesNearby,
        position: previousPerception.position
      });
      const decision = await this.executive.decide(previousPerception, currentMemory, values, latestOvernight, trigger);
      if (decision.intent.dialogue?.trim()) {
        this.presentation.publishThought({
          residentId: decision.intent.agent_id,
          residentName: decision.intent.agent_id,
          text: decision.intent.dialogue
        });
      } else {
        this.presentation.clear();
      }
      const latestMemory = await this.memory.current();
      const mergedMemory = mergeMemoryState(
        shouldClearEmotionTrigger
          ? {
              ...decision.memory,
              emotion_core: {
                ...decision.memory.emotion_core,
                pending_interrupt: undefined
              }
            }
          : decision.memory,
        latestMemory
      );
      await this.memory.replace(
        shouldClearEmotionTrigger
          ? {
              ...mergedMemory,
              emotion_core: {
                ...mergedMemory.emotion_core,
                pending_interrupt: undefined
              }
            }
          : mergedMemory
      );
      for (const observation of decision.observations) {
        await this.memory.remember(observation);
      }
      const thoughtObservation = buildThoughtObservation(previousPerception, decision.intent);
      if (thoughtObservation) {
        await this.memory.remember(thoughtObservation);
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

      const preActionMemory = await this.memory.current();

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
      let recentActionSnapshot: RecentActionSnapshot | undefined;
      if (report) {
        await this.memory.rememberReport(report);
        recentActionSnapshot = buildActionSnapshot(previousPerception, nextPerception, decision.intent, report);
        await this.memory.rememberActionSnapshot(
          recentActionSnapshot
        );
        this.daily.recordReport(report);
      }
      this.daily.recordPerception(nextPerception);
      const postTurnMemory = await this.memory.current();

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
        const nextTrigger = classifyTrigger(previousPerception, nextPerception, report, trigger);
        this.pendingTrigger = nextTrigger;
        this.queueDayReflection(
          this.prePlanLifeGate({
            turnTrigger: trigger,
            nextTrigger,
            beforeMemory: preActionMemory,
            afterMemory: postTurnMemory,
            previousPerception,
            currentPerception: nextPerception,
            report,
            recentActionSnapshot,
            overnight: latestOvernight
          })
        );
      }

      previousPerception = nextPerception;
      await delay(this.intervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    this.presentation.off("update", this.handlePresentationUpdate);
    this.brainServer?.close();
  }

  private readonly handlePresentationUpdate = (state: ResidentPresentationState) => {
    void this.syncPresentationState(state);
  };

  private syncPresentationState(state: ResidentPresentationState): Promise<void> {
    if (!this.remotePresentationEndpoint) {
      return Promise.resolve();
    }

    this.presentationSync = this.presentationSync
      .catch(() => {})
      .then(async () => {
        try {
          const response = await fetch(this.remotePresentationEndpoint as string, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify(state)
          });
          if (!response.ok) {
            residentLog("presentation_sync_failed", {
              status: response.status
            });
          }
        } catch (error) {
          residentLog("presentation_sync_failed", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });

    return this.presentationSync;
  }

  private prePlanLifeGate(input: {
    turnTrigger: ReplanTrigger;
    nextTrigger: ReplanTrigger;
    beforeMemory: MemoryState;
    afterMemory: MemoryState;
    previousPerception: PerceptionFrame;
    currentPerception: PerceptionFrame;
    report?: ActionReport;
    recentActionSnapshot?: RecentActionSnapshot;
    overnight?: OvernightConsolidation;
  }): DayReflectionCandidate | undefined {
    const trigger = selectDayReflectionTrigger(input.turnTrigger, input.nextTrigger, input.beforeMemory, input.afterMemory);
    if (!trigger) {
      return undefined;
    }
    const priority = isHardDayReflectionTrigger(trigger) ? "hard" : "soft";
    const fingerprint = buildDayReflectionFingerprint(trigger, input.afterMemory, input.currentPerception);
    if (priority === "soft" && this.isSoftReflectionCoolingDown(fingerprint)) {
      return undefined;
    }
    if (priority === "soft") {
      this.softReflectionCooldowns.set(fingerprint, Date.now());
    }
    return {
      trigger,
      priority,
      fingerprint,
      previousPerception: input.previousPerception,
      currentPerception: input.currentPerception,
      report: input.report,
      recentActionSnapshot: input.recentActionSnapshot,
      memory: input.afterMemory,
      overnight: input.overnight
    };
  }

  private queueDayReflection(candidate: DayReflectionCandidate | undefined): void {
    if (!candidate) {
      return;
    }
    if (this.dayReflectionInFlight) {
      if (candidate.priority === "hard") {
        this.queuedHardDayReflection = candidate;
      } else {
        this.queuedSoftDayReflection = candidate;
      }
      return;
    }
    this.startDayReflection(candidate);
  }

  private startDayReflection(candidate: DayReflectionCandidate): void {
    this.dayReflectionInFlight = this.runDayReflectionCandidate(candidate)
      .catch((error) => {
        residentLog("day_reflection_failed", {
          trigger: candidate.trigger,
          fingerprint: candidate.fingerprint,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.dayReflectionInFlight = undefined;
        const next = this.queuedHardDayReflection ?? this.queuedSoftDayReflection;
        this.queuedHardDayReflection = undefined;
        this.queuedSoftDayReflection = undefined;
        if (next && !this.stopped) {
          this.startDayReflection(next);
        }
      });
  }

  private async runDayReflectionCandidate(candidate: DayReflectionCandidate): Promise<void> {
    residentLog("day_reflection_start", {
      trigger: candidate.trigger,
      priority: candidate.priority,
      fingerprint: candidate.fingerprint
    });
    const record = await this.sleepCore.reflectDayEvent({
      trigger: candidate.trigger,
      previousPerception: candidate.previousPerception,
      currentPerception: candidate.currentPerception,
      report: candidate.report,
      memory: candidate.memory,
      overnight: candidate.overnight,
      recentObservations: candidate.memory.recent_observations.slice(-6),
      recentActionSnapshot: candidate.recentActionSnapshot
    });
    const latestMemory = await this.memory.current();
    await this.memory.replace(rememberDayLifeReflection(latestMemory, record, candidate.currentPerception));
    residentLog("day_reflection_applied", {
      trigger: record.trigger,
      fingerprint: record.fingerprint,
      summary: record.summary,
      eventKind: record.result.event_kind
    });
  }

  private isSoftReflectionCoolingDown(fingerprint: string): boolean {
    const now = Date.now();
    for (const [key, timestamp] of [...this.softReflectionCooldowns.entries()]) {
      if (now - timestamp > 45_000) {
        this.softReflectionCooldowns.delete(key);
      }
    }
    const previous = this.softReflectionCooldowns.get(fingerprint);
    return previous !== undefined && now - previous < 45_000;
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
  if (lastTrigger === "wake" || lastTrigger === "death" || lastTrigger === "respawn") {
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

function selectDayReflectionTrigger(
  turnTrigger: ReplanTrigger,
  nextTrigger: ReplanTrigger,
  beforeMemory: MemoryState,
  afterMemory: MemoryState
): ReplanTrigger | undefined {
  const pending = afterMemory.emotion_core.pending_interrupt?.trigger;
  const candidates = [pending, turnTrigger, nextTrigger].filter((value): value is ReplanTrigger => Boolean(value));
  for (const candidate of candidates) {
    if (alwaysReflectTriggers.has(candidate)) {
      return candidate;
    }
    if (conditionalReflectTriggers.has(candidate) && hasMeaningfulLifeDelta(beforeMemory, afterMemory)) {
      return candidate;
    }
  }
  return undefined;
}

function hasMeaningfulLifeDelta(beforeMemory: MemoryState, afterMemory: MemoryState): boolean {
  const beforeEpisode = beforeMemory.emotion_core.active_episode;
  const afterEpisode = afterMemory.emotion_core.active_episode;
  return (
    beforeEpisode?.id !== afterEpisode?.id ||
    beforeEpisode?.updated_at !== afterEpisode?.updated_at ||
    beforeMemory.emotion_core.bonded_entities.length !== afterMemory.emotion_core.bonded_entities.length ||
    beforeMemory.emotion_core.tagged_places.length !== afterMemory.emotion_core.tagged_places.length ||
    beforeMemory.emotion_core.pending_interrupt?.trigger !== afterMemory.emotion_core.pending_interrupt?.trigger
  );
}

function isHardDayReflectionTrigger(trigger: ReplanTrigger): boolean {
  return hardReflectTriggers.has(trigger);
}

function buildDayReflectionFingerprint(trigger: ReplanTrigger, memory: MemoryState, perception: PerceptionFrame): string {
  const active = memory.emotion_core.active_episode;
  const place = memory.emotion_core.tagged_places.at(-1);
  const location = place?.location ?? active?.focal_location ?? perception.position;
  return [
    trigger,
    normalizeFingerprintPart(active?.subject_id_or_label ?? active?.summary ?? "none"),
    normalizeFingerprintPart(place?.label ?? "none"),
    `${Math.floor(location.x / 8)}:${Math.floor(location.y / 8)}:${Math.floor(location.z / 8)}`
  ].join("|");
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

const alwaysReflectTriggers = new Set<ReplanTrigger>([
  "death",
  "respawn",
  "damage",
  "hostile_detection",
  "task_failure",
  "social_contact",
  "bonding",
  "birth",
  "wonder"
]);

const conditionalReflectTriggers = new Set<ReplanTrigger>(["player_interaction", "dawn", "task_completion"]);

const hardReflectTriggers = new Set<ReplanTrigger>(["death", "respawn", "damage", "hostile_detection", "task_failure"]);

function normalizeFingerprintPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "none";
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
    personality_profile: {
      ...primary.personality_profile,
      traits: { ...primary.personality_profile.traits },
      motifs: { ...primary.personality_profile.motifs },
      style_tags: [...primary.personality_profile.style_tags]
    },
    self_name: primary.self_name ?? latest.self_name,
    self_name_chosen_at: primary.self_name_chosen_at ?? latest.self_name_chosen_at,
    need_state: { ...primary.need_state },
    mind_state: { ...primary.mind_state },
    bootstrap_progress: { ...primary.bootstrap_progress },
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
    recent_action_snapshots: mergeActionSnapshots(primary.recent_action_snapshots, latest.recent_action_snapshots),
    place_tags: mergeStrings(primary.place_tags, latest.place_tags, 12),
    emotion_core: mergeEmotionCore(primary.emotion_core, latest.emotion_core),
    self_narrative: mergeStrings(primary.self_narrative, latest.self_narrative, 12),
    carry_over_commitments: mergeStrings(primary.carry_over_commitments, latest.carry_over_commitments, 10),
    last_wake_orientation: primary.last_wake_orientation ?? latest.last_wake_orientation,
    last_updated_at: new Date().toISOString()
  };
}

function mergeEmotionCore(primary: MemoryState["emotion_core"], latest: MemoryState["emotion_core"]): MemoryState["emotion_core"] {
  return {
    axes: { ...latest.axes, ...primary.axes },
    regulation: { ...latest.regulation, ...primary.regulation },
    action_biases: { ...latest.action_biases, ...primary.action_biases },
    dominant_emotions: [...new Set([...primary.dominant_emotions, ...latest.dominant_emotions])].slice(0, 3),
    active_episode:
      primary.active_episode && (!latest.active_episode || primary.active_episode.intensity >= latest.active_episode.intensity)
        ? {
            ...primary.active_episode,
            dominant_emotions: [...primary.active_episode.dominant_emotions],
            cause_tags: [...primary.active_episode.cause_tags],
            focal_location: primary.active_episode.focal_location ? { ...primary.active_episode.focal_location } : undefined,
            respawn_location: primary.active_episode.respawn_location ? { ...primary.active_episode.respawn_location } : undefined,
            inventory_loss: [...primary.active_episode.inventory_loss],
            subject_kind: primary.active_episode.subject_kind,
            subject_id_or_label: primary.active_episode.subject_id_or_label,
            novelty: primary.active_episode.novelty,
            appraisal: { ...primary.active_episode.appraisal },
            regulation: { ...primary.active_episode.regulation }
          }
        : latest.active_episode
          ? {
              ...latest.active_episode,
              dominant_emotions: [...latest.active_episode.dominant_emotions],
              cause_tags: [...latest.active_episode.cause_tags],
              focal_location: latest.active_episode.focal_location ? { ...latest.active_episode.focal_location } : undefined,
              respawn_location: latest.active_episode.respawn_location ? { ...latest.active_episode.respawn_location } : undefined,
              inventory_loss: [...latest.active_episode.inventory_loss],
              subject_kind: latest.active_episode.subject_kind,
              subject_id_or_label: latest.active_episode.subject_id_or_label,
              novelty: latest.active_episode.novelty,
              appraisal: { ...latest.active_episode.appraisal },
              regulation: { ...latest.active_episode.regulation }
            }
          : undefined,
    recent_episodes: mergeEmotionEpisodes(primary.recent_episodes, latest.recent_episodes),
    tagged_places: mergeTaggedPlaces(primary.tagged_places, latest.tagged_places),
    bonded_entities: mergeBondedEntities(primary.bonded_entities, latest.bonded_entities),
    pending_interrupt: primary.pending_interrupt ?? latest.pending_interrupt,
    last_event_at: primary.last_event_at ?? latest.last_event_at
  };
}

function mergeEmotionEpisodes(
  primary: MemoryState["emotion_core"]["recent_episodes"],
  latest: MemoryState["emotion_core"]["recent_episodes"]
): MemoryState["emotion_core"]["recent_episodes"] {
  const merged = new Map<string, MemoryState["emotion_core"]["recent_episodes"][number]>();
  for (const episode of [...latest, ...primary]) {
    merged.set(episode.id, {
      ...episode,
      dominant_emotions: [...episode.dominant_emotions],
      cause_tags: [...episode.cause_tags],
      focal_location: episode.focal_location ? { ...episode.focal_location } : undefined,
      respawn_location: episode.respawn_location ? { ...episode.respawn_location } : undefined,
      inventory_loss: [...episode.inventory_loss],
      subject_kind: episode.subject_kind,
      subject_id_or_label: episode.subject_id_or_label,
      novelty: episode.novelty,
      appraisal: { ...episode.appraisal },
      regulation: { ...episode.regulation }
    });
  }
  return [...merged.values()].slice(-12);
}

function mergeTaggedPlaces(
  primary: MemoryState["emotion_core"]["tagged_places"],
  latest: MemoryState["emotion_core"]["tagged_places"]
): MemoryState["emotion_core"]["tagged_places"] {
  const merged = new Map<string, MemoryState["emotion_core"]["tagged_places"][number]>();
  for (const place of [...latest, ...primary]) {
    merged.set(`${place.kind}:${Math.round(place.location.x)}:${Math.round(place.location.y)}:${Math.round(place.location.z)}`, {
      ...place,
      location: { ...place.location },
      cause_tags: [...place.cause_tags]
    });
  }
  return [...merged.values()].slice(-8);
}

function mergeBondedEntities(
  primary: MemoryState["emotion_core"]["bonded_entities"],
  latest: MemoryState["emotion_core"]["bonded_entities"]
): MemoryState["emotion_core"]["bonded_entities"] {
  const merged = new Map<string, MemoryState["emotion_core"]["bonded_entities"][number]>();
  for (const bond of [...latest, ...primary]) {
    merged.set(bond.id, { ...bond });
  }
  return [...merged.values()].slice(-12);
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

function mergeActionSnapshots(primary: RecentActionSnapshot[], latest: RecentActionSnapshot[]): RecentActionSnapshot[] {
  const merged = new Map<string, RecentActionSnapshot>();
  for (const snapshot of [...latest, ...primary]) {
    merged.set(`${snapshot.timestamp}:${snapshot.intent_type}:${snapshot.target_class}`, snapshot);
  }
  return [...merged.values()].slice(-16);
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

function buildActionSnapshot(
  previous: PerceptionFrame,
  current: PerceptionFrame,
  intent: { intent_type: string; target?: string | { x: number; y: number; z: number } },
  report: ActionReport
): RecentActionSnapshot {
  return {
    timestamp: new Date().toISOString(),
    intent_type: report.intent_type,
    target_class: classifyActionTarget(intent.intent_type, intent.target),
    status: report.status,
    position_delta: distance(previous.position, current.position),
    risk_context: classifyRiskContext(current)
  };
}

function buildThoughtObservation(
  perception: PerceptionFrame,
  intent: { intent_type: string; dialogue?: string }
): MemoryObservation | undefined {
  const summary = intent.dialogue?.trim();
  if (!summary) {
    return undefined;
  }

  return {
    timestamp: new Date().toISOString(),
    category: thoughtObservationCategory(intent.intent_type),
    summary,
    tags: ["thought", "dialogue", intent.intent_type],
    importance: 0.24,
    source: "dialogue",
    location: perception.position
  };
}

function thoughtObservationCategory(intentType: string): MemoryObservation["category"] {
  switch (intentType) {
    case "observe":
    case "move":
      return "discovery";
    case "build":
    case "rebuild":
    case "repair":
      return "building";
    case "gather":
    case "mine":
    case "craft":
    case "smelt":
    case "store":
      return "project";
    case "farm":
    case "tend_livestock":
      return intentType === "farm" ? "food" : "livestock";
    case "fight":
    case "retreat":
      return "danger";
    case "recover":
      return "recovery";
    case "sleep":
      return "sleep";
    case "eat":
      return "food";
    case "socialize":
      return "social";
    default:
      return "project";
  }
}

function classifyActionTarget(
  intentType: string,
  target?: string | { x: number; y: number; z: number }
): string {
  if (typeof target === "string" && target.trim().length > 0) {
    return `${intentType}:${target}`;
  }
  if (target && typeof target === "object") {
    return `${intentType}:${Math.round(target.x)}:${Math.round(target.y)}:${Math.round(target.z)}`;
  }
  return intentType;
}

function classifyRiskContext(frame: PerceptionFrame): RecentActionSnapshot["risk_context"] {
  if (frame.combat_state.hostilesNearby > 0) {
    return "threatened";
  }
  if (frame.home_state.shelterScore >= 0.65) {
    return "sheltered";
  }
  if (frame.light_level <= 7 || frame.home_state.shelterScore < 0.45) {
    return "exposed";
  }
  return "safe";
}

function distance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number }
): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
