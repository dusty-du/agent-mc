import {
  ActionReport,
  AffectState,
  BootstrapProgress,
  DayLifeReflectionRecord,
  MemoryBundle,
  MemoryObservation,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  ProtectedArea,
  RecentActionSnapshot,
  ResidentChronotype,
  ResidentMindState,
  ResidentNeedState,
  WakeOrientation
} from "@resident/shared";
import {
  chooseResidentSelfName,
  createResidentPersonality,
  DEFAULT_BOOTSTRAP_PROGRESS,
  DEFAULT_MIND_STATE,
  DEFAULT_NEED_STATE
} from "@resident/shared";
import {
  applyDayLifeReflection,
  applyEmotionActionReport,
  applyEmotionObservation,
  applyResidentEmotionEvent,
  consumePendingEmotionInterrupt,
  createEmotionCoreState,
  ResidentEmotionEvent,
  syncEmotionCoreFromPerception
} from "../emotion-core";

function defaultAffect(): AffectState {
  return {
    mood: 0.6,
    stress: 0.25,
    loneliness: 0.35,
    wonder: 0.45,
    security: 0.55,
    belonging: 0.5,
    satisfaction: 0.55
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryState(): MemoryState {
  return {
    current_day: 0,
    personality_profile: createResidentPersonality(),
    self_name: undefined,
    self_name_chosen_at: undefined,
    need_state: { ...DEFAULT_NEED_STATE },
    mind_state: { ...DEFAULT_MIND_STATE },
    bootstrap_progress: { ...DEFAULT_BOOTSTRAP_PROGRESS },
    known_beds: [],
    workstation_state: {
      craftingTableNearby: false,
      furnaceNearby: false,
      smokerNearby: false,
      blastFurnaceNearby: false,
      chestNearby: false
    },
    storage_sites: [],
    pantry_notes: [],
    crop_sites: [],
    safe_shelters: [],
    routes_home: [],
    protected_areas: [],
    settlement_zones: [],
    active_build_zones: [],
    salvage_tasks: [],
    combat_posture: [],
    craft_backlog: [],
    build_backlog: [],
    active_projects: [],
    current_goals: [],
    recent_observations: [],
    recent_interactions: [],
    recent_dangers: [],
    recent_action_snapshots: [],
    place_tags: [],
    affect: defaultAffect(),
    emotion_core: createEmotionCoreState(),
    self_narrative: ["I am here to live, learn, and shape a world worth returning to."],
    carry_over_commitments: [],
    last_updated_at: nowIso()
  };
}

export function syncMemoryState(
  memory: MemoryState,
  perception: PerceptionFrame,
  overnight?: OvernightConsolidation
): MemoryState {
  const personality = overnight?.personality_profile ?? memory.personality_profile;
  const selfName = memory.self_name ?? chooseResidentSelfName(personality);
  const selfNameChosenAt = memory.self_name_chosen_at ?? nowIso();
  const knownBeds = perception.home_state.anchor
    ? dedupePositions([perception.home_state.anchor, ...memory.known_beds])
    : [...memory.known_beds];
  const safeShelters = perception.safe_route_state.nearestShelter
    ? dedupePositions([perception.safe_route_state.nearestShelter, ...memory.safe_shelters])
    : [...memory.safe_shelters];
  const routesHome = perception.home_state.anchor
    ? dedupePositions([perception.home_state.anchor, ...memory.routes_home])
    : [...memory.routes_home];
  const affect = deriveAffect(perception, memory.affect);
  const bootstrapProgress = deriveBootstrapProgress(perception);
  const needState = deriveNeedState(perception, affect, bootstrapProgress, memory.need_state);
  const mindState = deriveMindState(perception, affect, needState, memory.recent_action_snapshots, personality.chronotype);
  const emotionCore = syncEmotionCoreFromPerception(
    memory.emotion_core,
    perception,
    {
      affect,
      bootstrap: bootstrapProgress,
      homeAnchor: perception.home_state.anchor ?? memory.home_anchor,
      needs: needState,
      personality,
      placeTags: memory.place_tags,
      recentActions: memory.recent_action_snapshots,
      overnightThemes: overnight?.emotional_themes
    }
  );

  const next: MemoryState = {
    ...memory,
    current_day: Math.floor(perception.tick_time / 24000),
    personality_profile: personality,
    self_name: overnight?.self_name ?? selfName,
    self_name_chosen_at: selfNameChosenAt,
    need_state: needState,
    mind_state: mindState,
    bootstrap_progress: bootstrapProgress,
    home_anchor: perception.home_state.anchor ?? memory.home_anchor,
    known_beds: knownBeds,
    workstation_state: {
      craftingTableNearby:
        perception.workstation_state?.craftingTableNearby ?? perception.home_state.workshopReady ?? memory.workstation_state.craftingTableNearby,
      furnaceNearby: perception.workstation_state?.furnaceNearby ?? memory.workstation_state.furnaceNearby,
      smokerNearby: perception.workstation_state?.smokerNearby ?? memory.workstation_state.smokerNearby,
      blastFurnaceNearby: perception.workstation_state?.blastFurnaceNearby ?? memory.workstation_state.blastFurnaceNearby,
      chestNearby: perception.workstation_state?.chestNearby ?? memory.workstation_state.chestNearby
    },
    storage_sites: perception.storage_sites ? [...perception.storage_sites] : [...memory.storage_sites],
    crop_sites: perception.crop_sites ? [...perception.crop_sites] : [...memory.crop_sites],
    safe_shelters: safeShelters,
    routes_home: routesHome,
    protected_areas: perception.protected_areas ? [...perception.protected_areas] : [...memory.protected_areas],
    settlement_zones: perception.settlement_zones ? [...perception.settlement_zones] : [...memory.settlement_zones],
    active_build_zones: perception.settlement_zones ? [...perception.settlement_zones] : [...memory.active_build_zones],
    pantry_notes: updatePantryNotes(memory.pantry_notes, perception),
    recent_interactions: trim([
      ...memory.recent_interactions,
      ...perception.nearby_entities.filter((entity) => entity.type === "player").map((entity) => `Saw ${entity.name} nearby.`)
    ]),
    recent_dangers: trim([
      ...memory.recent_dangers,
      ...perception.nearby_entities
        .filter((entity) => entity.type === "hostile")
        .map((entity) => `Hostile nearby: ${entity.name}.`)
    ]),
    place_tags: trimUnique([
      ...memory.place_tags,
      ...perception.notable_places,
      ...(perception.home_state.shelterScore > 0.6 ? ["home"] : [])
    ]),
    affect,
    emotion_core: emotionCore,
    carry_over_commitments: overnight
      ? trimUnique([...overnight.carry_over_commitments, ...memory.carry_over_commitments])
      : [...memory.carry_over_commitments],
    self_narrative: overnight
      ? trim([
          ...memory.self_narrative,
          ...overnight.insights.slice(0, 2),
          ...overnight.project_memories.slice(0, 1)
        ])
      : [...memory.self_narrative],
    last_updated_at: nowIso()
  };

  return next;
}

export function rememberObservation(memory: MemoryState, observation: MemoryObservation): MemoryState {
  const interactionNote =
    observation.category === "social" ||
    observation.category === "hospitality" ||
    observation.source === "dialogue" ||
    observation.tags.includes("chat")
      ? observation.summary
      : undefined;
  const dangerNote =
    observation.category === "danger" ||
    observation.tags.includes("death") ||
    observation.tags.includes("combat") ||
    observation.tags.includes("boundary")
      ? observation.summary
      : undefined;
  const pantryNotes =
    observation.category === "food" ? trimUnique([...memory.pantry_notes, observation.summary], 10) : memory.pantry_notes;

  return {
    ...memory,
    recent_observations: trim([...memory.recent_observations, observation], 18),
    recent_interactions: interactionNote ? trim([...memory.recent_interactions, interactionNote], 10) : memory.recent_interactions,
    recent_dangers: dangerNote ? trim([...memory.recent_dangers, dangerNote], 10) : memory.recent_dangers,
    place_tags: trimUnique([...memory.place_tags, ...observation.tags]),
    pantry_notes: pantryNotes,
    affect: observation.affect ? { ...observation.affect } : memory.affect,
    emotion_core: applyEmotionObservation(memory.emotion_core, observation, { personality: memory.personality_profile }),
    self_narrative: trim([...memory.self_narrative, observation.summary], 10),
    last_updated_at: nowIso()
  };
}

export function rememberActionReport(memory: MemoryState, report: ActionReport): MemoryState {
  const note = report.notes[0] ?? `Action ${report.intent_type} ended with ${report.status}.`;
  const nextGoals = report.needs_replan ? trimUnique([...memory.current_goals, `Revisit ${report.intent_type}`]) : memory.current_goals;
  const nextProjectStatus: "active" | "blocked" | "complete" =
    report.status === "completed" ? "complete" : report.status === "failed" ? "blocked" : "active";
  const updatedProjects = memory.active_projects.map((project) =>
    project.kind === report.intent_type ||
    (project.kind === "build" && ["build", "repair"].includes(report.intent_type)) ||
    (project.kind === "rebuild" && report.intent_type === "rebuild") ||
    (project.kind === "farm" && report.intent_type === "farm") ||
    (project.kind === "livestock" && report.intent_type === "tend_livestock") ||
    (project.kind === "recovery" && report.intent_type === "recover") ||
    (project.kind === "craft" && report.intent_type === "craft")
      ? {
          ...project,
          status: nextProjectStatus,
          updated_at: nowIso()
        }
      : project
  );
  return {
    ...memory,
    current_goals: nextGoals,
    recent_dangers:
      report.damage_taken > 0 ? trim([...memory.recent_dangers, `Took ${report.damage_taken} damage during ${report.intent_type}.`]) : memory.recent_dangers,
    active_projects: updatedProjects,
    emotion_core: applyEmotionActionReport(memory.emotion_core, report),
    self_narrative: trim([...memory.self_narrative, note]),
    last_updated_at: nowIso()
  };
}

export function rememberActionSnapshot(memory: MemoryState, snapshot: RecentActionSnapshot): MemoryState {
  return {
    ...memory,
    recent_action_snapshots: trim([...memory.recent_action_snapshots, snapshot], 16),
    last_updated_at: nowIso()
  };
}

export function rememberDayLifeReflection(
  memory: MemoryState,
  reflection: DayLifeReflectionRecord,
  perception: PerceptionFrame
): MemoryState {
  const observation = reflection.result.observation
    ? {
        timestamp: reflection.created_at,
        category: reflection.result.observation.category,
        summary: reflection.result.observation.summary,
        tags: [...reflection.result.observation.tags],
        importance: reflection.result.observation.importance,
        source: "reflection" as const,
        location: reflection.result.place?.location ? { ...reflection.result.place.location } : { ...perception.position }
      }
    : undefined;
  const interactionNote =
    observation &&
    (observation.category === "social" || observation.category === "hospitality" || observation.tags.includes("bonding"))
      ? observation.summary
      : reflection.result.event_kind === "social" || reflection.result.event_kind === "attachment"
        ? reflection.summary
        : undefined;
  const dangerNote =
    observation && (observation.category === "danger" || observation.tags.includes("death") || observation.tags.includes("combat"))
      ? observation.summary
      : ["death", "damage", "combat", "loss"].includes(reflection.result.event_kind)
        ? reflection.summary
        : undefined;

  return {
    ...memory,
    recent_observations: observation ? trim([...memory.recent_observations, observation], 18) : memory.recent_observations,
    recent_interactions: interactionNote ? trim([...memory.recent_interactions, interactionNote], 10) : memory.recent_interactions,
    recent_dangers: dangerNote ? trim([...memory.recent_dangers, dangerNote], 10) : memory.recent_dangers,
    place_tags: trimUnique([
      ...memory.place_tags,
      ...(observation?.tags ?? []),
      ...(reflection.result.place?.label ? [reflection.result.place.label] : [])
    ]),
    emotion_core: applyDayLifeReflection(memory.emotion_core, reflection.result, {
      trigger: reflection.trigger,
      timestamp: reflection.created_at,
      perception,
      personality: memory.personality_profile
    }),
    self_narrative: trim(
      [
        ...memory.self_narrative,
        reflection.summary,
        ...(observation && observation.summary !== reflection.summary ? [observation.summary] : [])
      ],
      10
    ),
    last_updated_at: nowIso()
  };
}

export function updateProtectedAreas(memory: MemoryState, protectedAreas: ProtectedArea[]): MemoryState {
  return {
    ...memory,
    protected_areas: [...protectedAreas],
    self_narrative: trim([
      ...memory.self_narrative,
      protectedAreas.length > 0
        ? `I know ${protectedAreas.length} places that deserve careful respect.`
        : "The world feels open again where no protected boundaries are marked."
    ]),
    last_updated_at: nowIso()
  };
}

export function mergeProtectedAreas(memory: MemoryState, protectedAreas: ProtectedArea[]): MemoryState {
  const merged = new Map<string, ProtectedArea>();
  for (const area of [...memory.protected_areas, ...protectedAreas]) {
    merged.set(area.id, area);
  }
  return updateProtectedAreas(memory, [...merged.values()]);
}

export function buildMemoryBundle(memory: MemoryState, agentId: string): MemoryBundle {
  const currentDayObservations = memory.recent_observations.slice(-24);
  const selfName = requireSelfName(memory);
  return {
    agent_id: agentId,
    day_number: memory.current_day,
    created_at: nowIso(),
    summary:
      currentDayObservations.at(-1)?.summary ??
      memory.self_narrative.at(-1) ??
      "A day of living, trying, and continuing.",
    personality_profile: { ...memory.personality_profile, traits: { ...memory.personality_profile.traits }, motifs: { ...memory.personality_profile.motifs }, style_tags: [...memory.personality_profile.style_tags] },
    self_name: selfName,
    need_state: { ...memory.need_state },
    mind_state: { ...memory.mind_state },
    bootstrap_progress: { ...memory.bootstrap_progress },
    observations: currentDayObservations,
    active_projects: [...memory.active_projects],
    carry_over_commitments: [...memory.carry_over_commitments],
    recent_dangers: [...memory.recent_dangers],
    recent_interactions: [...memory.recent_interactions],
    recent_action_snapshots: [...memory.recent_action_snapshots],
    place_tags: [...memory.place_tags],
    final_affect: { ...memory.affect },
    emotion_core: {
      ...memory.emotion_core,
      axes: { ...memory.emotion_core.axes },
      regulation: { ...memory.emotion_core.regulation },
      action_biases: { ...memory.emotion_core.action_biases },
      dominant_emotions: [...memory.emotion_core.dominant_emotions],
      active_episode: memory.emotion_core.active_episode
        ? {
            ...memory.emotion_core.active_episode,
            dominant_emotions: [...memory.emotion_core.active_episode.dominant_emotions],
            cause_tags: [...memory.emotion_core.active_episode.cause_tags],
            focal_location: memory.emotion_core.active_episode.focal_location ? { ...memory.emotion_core.active_episode.focal_location } : undefined,
            respawn_location: memory.emotion_core.active_episode.respawn_location ? { ...memory.emotion_core.active_episode.respawn_location } : undefined,
            inventory_loss: [...memory.emotion_core.active_episode.inventory_loss],
            subject_kind: memory.emotion_core.active_episode.subject_kind,
            subject_id_or_label: memory.emotion_core.active_episode.subject_id_or_label,
            novelty: memory.emotion_core.active_episode.novelty,
            appraisal: { ...memory.emotion_core.active_episode.appraisal },
            regulation: { ...memory.emotion_core.active_episode.regulation }
          }
        : undefined,
      recent_episodes: memory.emotion_core.recent_episodes.map((episode) => ({
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
      })),
      tagged_places: memory.emotion_core.tagged_places.map((place) => ({
        ...place,
        location: { ...place.location },
        cause_tags: [...place.cause_tags]
      })),
      bonded_entities: memory.emotion_core.bonded_entities.map((bond) => ({ ...bond })),
      pending_interrupt: memory.emotion_core.pending_interrupt ? { ...memory.emotion_core.pending_interrupt } : undefined
    }
  };
}

export function applyWakeOrientation(memory: MemoryState, orientation: WakeOrientation): MemoryState {
  const preserveContext = Boolean(memory.emotion_core.active_episode && !memory.emotion_core.active_episode.resolved);
  return {
    ...memory,
    current_day: orientation.day_number,
    current_goals: [...orientation.current_priorities],
    carry_over_commitments: [...orientation.carry_over_commitments],
    recent_observations: preserveContext ? memory.recent_observations.slice(-6) : [],
    recent_interactions: preserveContext ? memory.recent_interactions.slice(-4) : [],
    recent_dangers: preserveContext ? memory.recent_dangers.slice(-4) : [],
    place_tags: preserveContext ? trimUnique([...memory.place_tags, ...(memory.home_anchor ? ["home"] : [])], 12) : memory.home_anchor ? ["home"] : [],
    emotion_core: preserveContext ? { ...memory.emotion_core } : consumePendingEmotionInterrupt(memory.emotion_core),
    self_narrative: trim([...memory.self_narrative, orientation.narration ?? "A new day begins."]),
    last_wake_orientation: orientation,
    last_updated_at: nowIso()
  };
}

export function applyResidentEmotionEventToMemory(memory: MemoryState, event: ResidentEmotionEvent): MemoryState {
  return {
    ...memory,
    emotion_core: applyResidentEmotionEvent(memory.emotion_core, event, memory.personality_profile, event.timestamp),
    last_updated_at: nowIso()
  };
}

export function consumeEmotionInterrupt(memory: MemoryState): MemoryState {
  return {
    ...memory,
    emotion_core: consumePendingEmotionInterrupt(memory.emotion_core),
    last_updated_at: nowIso()
  };
}

function updatePantryNotes(notes: string[], perception: PerceptionFrame): string[] {
  const next = [...notes];
  if (perception.pantry_state.emergencyReserveDays < 1) {
    next.push("Emergency reserve below one day.");
  }
  if (perception.hunger <= 8) {
    next.push("Hunger is pressing; keep food close.");
  }
  return trimUnique(next);
}

function deriveAffect(frame: PerceptionFrame, current: AffectState): AffectState {
  return {
    mood: clampAverage(current.mood, frame.home_state.shelterScore > 0.6 ? 0.68 : 0.52),
    stress: clampAverage(current.stress, frame.combat_state.hostilesNearby > 0 ? 0.82 : 0.28),
    loneliness: clampAverage(current.loneliness, frame.nearby_entities.some((entity) => entity.type === "player") ? 0.2 : 0.4),
    wonder: clampAverage(current.wonder, frame.notable_places.length > 0 ? 0.75 : 0.4),
    security: clampAverage(current.security, frame.home_state.shelterScore),
    belonging: clampAverage(current.belonging, frame.home_state.bedAvailable ? 0.72 : 0.45),
    satisfaction: clampAverage(current.satisfaction, frame.pantry_state.emergencyReserveDays >= 1 ? 0.66 : 0.48)
  };
}

function deriveBootstrapProgress(frame: PerceptionFrame): BootstrapProgress {
  const inventory = frame.inventory;
  const woodCount = countItems(inventory, woodItems);
  const toolReady = hasTool(inventory, "axe") && hasTool(inventory, "pickaxe");
  const torchesNearby = frame.nearby_blocks.some((block) => block.name.includes("torch") || block.name.includes("lantern"));
  return {
    woodSecured: woodCount >= 8 || Boolean(inventory.crafting_table) || frame.home_state.workshopReady,
    toolsReady: toolReady,
    shelterSecured: frame.home_state.shelterScore >= 0.55 || Boolean(frame.home_state.anchor),
    lightSecured: countItems(inventory, ["torch", "lantern"]) >= 4 || torchesNearby || frame.light_level >= 10,
    foodSecured: frame.pantry_state.emergencyReserveDays >= 1 || hasKnownFood(inventory) || frame.farm_state.harvestableTiles > 0,
    bedSecured: frame.home_state.bedAvailable || inventory.white_bed > 0 || inventory.red_bed > 0 || inventory.blue_bed > 0
  };
}

function deriveNeedState(
  frame: PerceptionFrame,
  affect: AffectState,
  bootstrap: BootstrapProgress,
  current: ResidentNeedState
): ResidentNeedState {
  const next: ResidentNeedState = {
    safety: clampAverage(
      current.safety,
      clamp01(
        1 -
        (frame.home_state.shelterScore * 0.45 + Math.min(frame.light_level / 15, 1) * 0.2) +
        frame.combat_state.hostilesNearby * 0.18 +
        (bootstrap.lightSecured ? -0.08 : 0.08)
      )
    ),
    rest: clampAverage(
      current.rest,
      clamp01(routinePhaseFatigue(frame.tick_time, frame.home_state.bedAvailable) + (frame.home_state.bedAvailable ? -0.08 : 0.08))
    ),
    hunger: clampAverage(
      current.hunger,
      clamp01((20 - frame.hunger) / 20 + (frame.pantry_state.emergencyReserveDays < 1 ? 0.35 : frame.pantry_state.emergencyReserveDays < 2 ? 0.15 : 0))
    ),
    autonomy: clampAverage(current.autonomy, clamp01(0.45 + (frame.notable_places.length === 0 ? 0.1 : -0.05) + (bootstrap.shelterSecured ? 0.05 : 0))),
    competence: clampAverage(current.competence, clamp01((bootstrap.toolsReady ? 0.22 : 0.62) + (bootstrap.woodSecured ? -0.08 : 0.12))),
    relatedness: clampAverage(current.relatedness, clamp01(frame.nearby_entities.some((entity) => entity.type === "player") ? 0.18 : affect.loneliness + 0.08)),
    beauty: clampAverage(current.beauty, clamp01(frame.notable_places.length > 0 ? 0.28 : 0.52))
  };
  return next;
}

function deriveMindState(
  frame: PerceptionFrame,
  affect: AffectState,
  needs: ResidentNeedState,
  recentActions: RecentActionSnapshot[],
  chronotype: ResidentChronotype
): ResidentMindState {
  const recentBlocked = recentActions.filter((entry) => entry.status === "blocked" || entry.position_delta < 0.75).slice(-4).length;
  const recentSuccess = recentActions.filter((entry) => entry.status === "completed" && entry.position_delta >= 0.75).slice(-4).length;
  const routinePhase = phaseForTick(frame.tick_time, chronotype);
  return {
    valence: clamp01((affect.mood + affect.satisfaction + affect.belonging) / 3 - recentBlocked * 0.05),
    arousal: clamp01((affect.stress + needs.safety + (frame.combat_state.hostilesNearby > 0 ? 0.25 : 0.1)) / 2),
    confidence: clamp01(0.4 + recentSuccess * 0.08 - recentBlocked * 0.06 + (frame.combat_state.weaponTier === "none" ? -0.08 : 0.06)),
    frustration: clamp01(needs.competence * 0.5 + recentBlocked * 0.12),
    fatigueDebt: clamp01(needs.rest + (routinePhase === "night" ? 0.15 : routinePhase === "dusk" ? 0.08 : 0)),
    routinePhase
  };
}

function clampAverage(current: number, next: number): number {
  return Math.max(0, Math.min(1, (current + next) / 2));
}

function dedupePositions(positions: Vec3Like[]): Vec3Like[] {
  const seen = new Set<string>();
  const next: Vec3Like[] = [];
  for (const position of positions) {
    const key = `${Math.round(position.x)}:${Math.round(position.y)}:${Math.round(position.z)}`;
    if (!seen.has(key)) {
      seen.add(key);
      next.push(position);
    }
  }
  return next;
}

function trim<T>(entries: T[], limit = 8): T[] {
  return entries.slice(-limit);
}

function trimUnique(entries: string[], limit = 10): string[] {
  const unique = [...new Set(entries)];
  return unique.slice(-limit);
}

function phaseForTick(tick: number, chronotype: ResidentChronotype): ResidentMindState["routinePhase"] {
  const offset = chronotype === "early" ? 1000 : chronotype === "late" ? -1000 : 0;
  const adjusted = ((tick + offset) % 24000 + 24000) % 24000;
  if (adjusted >= 23000 || adjusted < 2000) {
    return "dawn";
  }
  if (adjusted < 11000) {
    return "work";
  }
  if (adjusted < 12500) {
    return "homeward";
  }
  if (adjusted < 14000) {
    return "dusk";
  }
  return "night";
}

function routinePhaseFatigue(tick: number, bedAvailable: boolean): number {
  const daytime = tick % 24000;
  if (daytime >= 12500 && bedAvailable) {
    return 0.72;
  }
  if (daytime >= 11000) {
    return 0.58;
  }
  if (daytime < 2000) {
    return 0.42;
  }
  return 0.26;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requireSelfName(memory: MemoryState): string {
  if (!memory.self_name) {
    throw new Error("Resident self-name has not been chosen yet.");
  }
  return memory.self_name;
}

function hasTool(inventory: Record<string, number>, kind: "axe" | "pickaxe"): boolean {
  return Object.entries(inventory).some(([name, count]) => count > 0 && name.endsWith(`_${kind}`));
}

function hasKnownFood(inventory: Record<string, number>): boolean {
  return countItems(inventory, ["bread", "baked_potato", "cooked_beef", "cooked_mutton", "cooked_porkchop", "cooked_chicken", "carrot", "apple"]) > 0;
}

function countItems(inventory: Record<string, number>, names: string[]): number {
  return names.reduce((sum, name) => sum + (inventory[name] ?? 0), 0);
}

const woodItems = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "stick"
];

type Vec3Like = {
  x: number;
  y: number;
  z: number;
};
