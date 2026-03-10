import {
  ActionReport,
  AffectState,
  BootstrapProgress,
  EmotionActionBiases,
  EmotionAppraisal,
  EmotionCoreState,
  EmotionEpisode,
  EmotionInterrupt,
  EmotionRegulation,
  InventoryDeltaSummary,
  MemoryObservation,
  MemoryState,
  PerceptionFrame,
  RecentActionSnapshot,
  ReplanTrigger,
  ResidentPersonalityProfile,
  ResidentNeedState,
  ValueProfile,
  Vec3
} from "@resident/shared";
import { DEFAULT_VALUE_PROFILE, clamp } from "@resident/shared";

export interface EmotionPerceptionContext {
  affect: AffectState;
  bootstrap: BootstrapProgress;
  homeAnchor?: Vec3;
  needs: ResidentNeedState;
  personality: ResidentPersonalityProfile;
  placeTags: string[];
  recentActions: RecentActionSnapshot[];
  overnightThemes?: string[];
}

export interface EmotionObservationContext {
  personality?: ResidentPersonalityProfile;
}

export interface ResidentDeathEmotionEvent {
  type: "resident_death";
  timestamp: string;
  cause_tags: string[];
  death_message?: string;
  dropped_items: InventoryDeltaSummary[];
  location?: Vec3;
  world?: string;
}

export interface ResidentRespawnEmotionEvent {
  type: "resident_respawn";
  timestamp: string;
  cause_tags: string[];
  location?: Vec3;
  respawn_location?: Vec3;
  world?: string;
  bed_spawn?: boolean;
}

export type ResidentEmotionEvent = ResidentDeathEmotionEvent | ResidentRespawnEmotionEvent;

export type EmotionCandidateKind =
  | "bootstrap"
  | "craft"
  | "build"
  | "farm"
  | "livestock"
  | "social"
  | "explore"
  | "store"
  | "observe";

export interface EmotionInterruptIntent {
  intent_type: "move" | "observe" | "recover" | "retreat";
  target?: Vec3;
  reason: string;
  dialogue: string;
  observation: string;
  observation_tags: string[];
}

const MAX_EPISODES = 12;
const MAX_TAGGED_PLACES = 8;
const DEFAULT_DOMINANT = ["steady"];

export function createEmotionCoreState(now = new Date().toISOString()): EmotionCoreState {
  const axes = defaultAxes();
  const regulation = defaultRegulation();
  return {
    axes,
    regulation,
    action_biases: deriveActionBiases(axes, regulation),
    dominant_emotions: [...DEFAULT_DOMINANT],
    recent_episodes: [],
    tagged_places: [],
    last_event_at: now
  };
}

export function syncEmotionCoreFromPerception(
  current: EmotionCoreState | undefined,
  perception: PerceptionFrame,
  context: EmotionPerceptionContext
): EmotionCoreState {
  const now = new Date().toISOString();
  const core = cloneEmotionCore(current ?? createEmotionCoreState(now));
  const safetySupport = clamp(
    perception.home_state.shelterScore * 0.32 +
      (perception.combat_state.hostilesNearby === 0 ? 0.18 : 0) +
      (perception.home_state.bedAvailable ? 0.1 : 0) +
      clamp(perception.health / 20) * 0.16 +
      clamp(perception.hunger / 20) * 0.1 +
      (perception.light_level >= 10 ? 0.08 : 0)
  );
  const comfortSupport = clamp(
    context.affect.security * 0.3 +
      context.affect.belonging * 0.18 +
      perception.home_state.shelterScore * 0.24 +
      (context.homeAnchor ? 0.08 : 0) +
      (context.placeTags.includes("home") ? 0.08 : 0)
  );
  const nearbyPlayer = perception.nearby_entities.some((entity) => entity.type === "player");
  const deathSitePressure = nearestTaggedPlaceDistance(core.tagged_places, "death_site", perception.position, 24);
  const unresolvedDeath = core.active_episode?.kind === "death" && !core.active_episode.resolved;
  const wonderSupport = clamp(
    context.affect.wonder * 0.6 +
      (perception.notable_places.length > 0 ? 0.18 : 0) +
      (perception.terrain_affordances?.some((entry) => entry.type === "view" || entry.type === "water") ? 0.12 : 0)
  );
  const masterySupport = clamp(
    (context.bootstrap.toolsReady ? 0.24 : 0.06) +
      (context.bootstrap.shelterSecured ? 0.18 : 0.04) +
      context.personality.traits.conscientiousness * 0.14 +
      (perception.combat_state.weaponTier !== "none" ? 0.08 : 0)
  );
  const overnightGuarded = (context.overnightThemes ?? []).some((theme) => /wary|guarded|watchful/i.test(theme)) ? 0.08 : 0;
  const overnightSettled = (context.overnightThemes ?? []).some((theme) => /relieved|rested|settled|gentle/i.test(theme)) ? 0.08 : 0;

  const axes: EmotionAppraisal = blendAxes(core.axes, {
    threat: clamp(
      context.needs.safety * 0.66 +
        perception.combat_state.hostilesNearby * 0.16 +
        context.personality.traits.threat_sensitivity * 0.16 +
        deathSitePressure * 0.24 +
        (unresolvedDeath ? core.active_episode?.appraisal.threat ?? 0 : 0) * 0.18 -
        safetySupport * 0.22 +
        overnightGuarded
    ),
    loss: clamp(
      (unresolvedDeath ? Math.max(core.active_episode?.appraisal.loss ?? 0, 0.18) : core.axes.loss * 0.72) +
        deathSitePressure * 0.08
    ),
    pain: clamp(
      Math.max(core.axes.pain * 0.72, unresolvedDeath ? (core.active_episode?.appraisal.pain ?? 0) * 0.76 : 0) +
        clamp((20 - perception.health) / 20) * 0.22
    ),
    curiosity: clamp(
      context.personality.traits.openness * 0.34 +
        wonderSupport * 0.32 +
        (perception.notable_places.length > 0 ? 0.12 : 0) -
        core.regulation.vigilance * 0.18 -
        deathSitePressure * 0.12
    ),
    connection: clamp(
      context.affect.belonging * 0.34 +
        (nearbyPlayer ? 0.22 : 0) +
        clamp(1 - context.needs.relatedness) * 0.14 -
        clamp(context.needs.relatedness * 0.08)
    ),
    comfort: clamp(comfortSupport + safetySupport * 0.18 - deathSitePressure * 0.16 + overnightSettled),
    mastery: clamp(masterySupport + clamp(1 - context.needs.competence) * 0.2),
    wonder: clamp(wonderSupport - deathSitePressure * 0.1)
  });

  const regulation: EmotionRegulation = blendRegulation(core.regulation, {
    arousal: clamp(axes.threat * 0.66 + axes.pain * 0.18 + perception.combat_state.hostilesNearby * 0.08 + deathSitePressure * 0.16),
    shock: clamp(
      Math.max(
        core.regulation.shock * 0.84,
        (unresolvedDeath ? (core.active_episode?.regulation.shock ?? 0) * 0.72 : 0) +
          deathSitePressure * 0.16 -
          safetySupport * 0.18
      )
    ),
    vigilance: clamp(axes.threat * 0.82 + context.personality.traits.threat_sensitivity * 0.12 + overnightGuarded),
    resolve: clamp(axes.mastery * 0.42 + context.personality.traits.conscientiousness * 0.18 + comfortSupport * 0.1),
    recovery: clamp(safetySupport * 0.4 + axes.comfort * 0.22 + axes.connection * 0.1 - axes.threat * 0.16 + overnightSettled)
  });

  const active_episode = evolveActiveEpisode(core.active_episode, axes, regulation, perception, now);
  const tagged_places = updatePassiveTaggedPlaces(core.tagged_places, perception, context.affect, now);
  const dominant_emotions = deriveDominantEmotions(axes, regulation);
  const action_biases = deriveActionBiases(axes, regulation, active_episode, tagged_places);

  return {
    ...core,
    axes,
    regulation,
    action_biases,
    dominant_emotions,
    active_episode,
    recent_episodes: trimEpisodes(syncRecentEpisodes(core.recent_episodes, active_episode), now),
    tagged_places,
    last_event_at: active_episode?.updated_at ?? core.last_event_at ?? now
  };
}

export function applyEmotionObservation(
  current: EmotionCoreState | undefined,
  observation: MemoryObservation,
  context: EmotionObservationContext = {}
): EmotionCoreState {
  const core = cloneEmotionCore(current ?? createEmotionCoreState(observation.timestamp));
  const episode = episodeFromObservation(observation, context.personality);
  if (!episode) {
    return core;
  }
  return integrateEpisode(core, episode);
}

export function applyEmotionActionReport(
  current: EmotionCoreState | undefined,
  report: ActionReport
): EmotionCoreState {
  const core = cloneEmotionCore(current ?? createEmotionCoreState());
  const episode = episodeFromActionReport(report, core);
  if (!episode) {
    return core;
  }
  return integrateEpisode(core, episode);
}

export function applyResidentEmotionEvent(
  current: EmotionCoreState | undefined,
  event: ResidentEmotionEvent,
  personality: ResidentPersonalityProfile,
  now = event.timestamp
): EmotionCoreState {
  const core = cloneEmotionCore(current ?? createEmotionCoreState(now));

  if (event.type === "resident_death") {
    const appraisal: EmotionAppraisal = {
      threat: clamp(0.72 + personality.traits.threat_sensitivity * 0.18),
      loss: clamp(0.34 + Math.min(0.32, totalInventoryLoss(event.dropped_items) / 16)),
      pain: 0.92,
      curiosity: clamp(0.12 + personality.traits.openness * 0.06),
      connection: clamp(core.axes.connection * 0.84),
      comfort: 0.08,
      mastery: clamp(0.2 + personality.traits.conscientiousness * 0.18),
      wonder: 0.04
    };
    const regulation: EmotionRegulation = {
      arousal: 0.94,
      shock: 0.98,
      vigilance: clamp(0.7 + personality.traits.threat_sensitivity * 0.16),
      resolve: clamp(0.24 + personality.traits.conscientiousness * 0.16),
      recovery: 0.12
    };
    const episode: EmotionEpisode = {
      id: `death:${now}`,
      kind: "death",
      summary: event.death_message?.trim() || "I died.",
      started_at: now,
      updated_at: now,
      source_trigger: "death",
      dominant_emotions: deriveDominantEmotions(appraisal, regulation),
      cause_tags: compact(["death", ...event.cause_tags]),
      world: event.world,
      focal_location: event.location ? { ...event.location } : undefined,
      respawn_location: undefined,
      inventory_loss: normalizeInventoryLoss(event.dropped_items),
      appraisal,
      regulation,
      intensity: intensityFrom(appraisal, regulation),
      revisit_policy: "cautious",
      resolved: false
    };

    return updateTaggedPlace(
      integrateEpisode(core, episode, {
        trigger: "death",
        reason: episode.summary,
        created_at: now,
        episode_id: episode.id
      }),
      event.location
        ? {
            kind: "death_site",
            label: humanizeCauseTag(event.cause_tags.find((tag) => tag !== "death")),
            location: { ...event.location },
            world: event.world,
            salience: 0.96,
            cause_tags: [...episode.cause_tags],
            revisit_policy: "cautious",
            updated_at: now
          }
        : undefined
    );
  }

  const active = core.active_episode;
  if (!active || active.kind !== "death") {
    return {
      ...core,
      pending_interrupt: {
        trigger: "respawn",
        reason: "Respawning changed the situation enough to require a fresh read.",
        created_at: now
      },
      last_event_at: now
    };
  }

  const appraisal = blendAxes(active.appraisal, {
    ...active.appraisal,
    threat: clamp(active.appraisal.threat * 0.9),
    curiosity: clamp(active.appraisal.curiosity + 0.18),
    comfort: clamp(active.appraisal.comfort + (event.bed_spawn ? 0.22 : 0.12)),
    mastery: clamp(active.appraisal.mastery + 0.12)
  }, 0.6);
  const regulation = blendRegulation(active.regulation, {
    ...active.regulation,
    shock: clamp(active.regulation.shock * 0.72),
    recovery: clamp(active.regulation.recovery + 0.28),
    resolve: clamp(active.regulation.resolve + 0.16),
    vigilance: clamp(active.regulation.vigilance * 0.92)
  }, 0.6);
  const episode: EmotionEpisode = {
    ...active,
    updated_at: now,
    respawn_location: event.respawn_location ? { ...event.respawn_location } : event.location ? { ...event.location } : active.respawn_location,
    cause_tags: compact([...active.cause_tags, ...event.cause_tags]),
    appraisal,
    regulation,
    dominant_emotions: deriveDominantEmotions(appraisal, regulation),
    intensity: intensityFrom(appraisal, regulation)
  };

  const next = integrateEpisode(
    {
      ...core,
      active_episode: episode
    },
    episode,
    {
      trigger: "respawn",
      reason: "Respawning deserves orientation before routine takes over.",
      created_at: now,
      episode_id: episode.id
    }
  );

  return updateTaggedPlace(
    next,
    event.respawn_location && event.bed_spawn
      ? {
          kind: "comfort_site",
          label: "respawn shelter",
          location: { ...event.respawn_location },
          world: event.world,
          salience: 0.52,
          cause_tags: ["respawn", "comfort"],
          revisit_policy: "open",
          updated_at: now
        }
      : undefined
  );
}

export function consumePendingEmotionInterrupt(current: EmotionCoreState | undefined): EmotionCoreState {
  if (!current?.pending_interrupt) {
    return current ?? createEmotionCoreState();
  }
  return {
    ...cloneEmotionCore(current),
    pending_interrupt: undefined
  };
}

export function emotionInterruptIntent(
  memory: MemoryState,
  frame: PerceptionFrame,
  trigger: Extract<ReplanTrigger, "death" | "respawn">
): EmotionInterruptIntent | undefined {
  const active = memory.emotion_core.active_episode;
  if (!active || active.kind !== "death") {
    if (trigger !== "respawn") {
      return undefined;
    }
    return {
      intent_type: "observe",
      reason: "Orient after respawning before routine collapses back into autopilot.",
      dialogue: composeEmotionDialogue(
        memory,
        frame,
        "I need one honest read of this place before I decide what comes next.",
        "observe"
      ),
      observation: "Respawning changed the context enough to justify a deliberate pause.",
      observation_tags: ["emotion", "respawn", "orientation"]
    };
  }

  const hostilesNearby = frame.combat_state.hostilesNearby > 0;
  const underSheltered = frame.home_state.shelterScore < 0.45 && !frame.safe_route_state.nearestShelter;
  const sameThreatNearby = active.cause_tags.some((tag) =>
    frame.nearby_entities.some((entity) => entity.name.toLowerCase().includes(tag.toLowerCase()))
  );
  const nearDeathSite = active.focal_location ? distanceBetween(active.focal_location, frame.position) <= 22 : false;
  const preparedForRevisit = isPreparedForRevisit(memory, frame);

  if (hostilesNearby || underSheltered || sameThreatNearby) {
    return {
      intent_type: frame.safe_route_state.nearestShelter || frame.home_state.anchor ? "move" : "retreat",
      target: frame.safe_route_state.nearestShelter ?? frame.home_state.anchor,
      reason: "Safety should interrupt routine while the death response is still acute.",
      dialogue: composeEmotionDialogue(
        memory,
        frame,
        "I am not giving danger a second easy chance. I want shelter first.",
        "move"
      ),
      observation: "A recent death is still driving a strong return-to-safety response.",
      observation_tags: ["emotion", "death", "shelter", "interrupt"]
    };
  }

  if (frame.hunger <= 12 || frame.health < 18 || memory.emotion_core.action_biases.seek_recovery >= 0.58) {
    return {
      intent_type: "recover",
      reason: "Recovery takes precedence while shock and pain are still elevated.",
      dialogue: composeEmotionDialogue(
        memory,
        frame,
        "I came back shaken. Food, breath, and steadier footing matter before ambition.",
        "recover"
      ),
      observation: "The resident is choosing bodily recovery instead of blindly resuming routine.",
      observation_tags: ["emotion", "death", "recovery", "interrupt"]
    };
  }

  if (nearDeathSite && !preparedForRevisit) {
    return {
      intent_type: "move",
      target: frame.home_state.anchor ?? frame.safe_route_state.nearestShelter,
      reason: "The death site should be revisited cautiously, not on impulse.",
      dialogue: composeEmotionDialogue(
        memory,
        frame,
        "That spot is still too raw. I want a little preparation before I face it again.",
        "move"
      ),
      observation: "The resident recognizes the death site and chooses distance until better prepared.",
      observation_tags: ["emotion", "death", "avoidance", "interrupt"]
    };
  }

  return {
    intent_type: "observe",
    reason: "Orientation is warranted so the next move reflects the actual surroundings, not a loop.",
    dialogue: composeEmotionDialogue(
      memory,
      frame,
      "I want to look at where I am, what took me down, and what actually makes sense now.",
      "observe"
    ),
    observation: "A recent death is biasing the resident toward careful reorientation.",
    observation_tags: ["emotion", "death", "orientation", "interrupt"]
  };
}

export function emotionCandidateBias(
  kind: EmotionCandidateKind,
  memory: MemoryState,
  frame: PerceptionFrame,
  values: ValueProfile = DEFAULT_VALUE_PROFILE
): number {
  const biases = memory.emotion_core.action_biases;
  let score = 0;

  score -= biases.avoid_risk * (kind === "explore" ? 0.54 : kind === "social" ? 0.16 : kind === "farm" || kind === "livestock" ? 0.14 : 0);
  score += biases.seek_shelter * (kind === "store" ? 0.18 : kind === "build" && frame.home_state.shelterScore < 0.7 ? 0.16 : 0);
  score += biases.seek_recovery * (kind === "observe" ? 0.18 : kind === "store" ? 0.08 : 0);
  score += biases.seek_mastery * (kind === "craft" || kind === "build" || kind === "bootstrap" ? 0.22 : 0);
  score += biases.seek_company * (kind === "social" ? 0.26 : kind === "livestock" ? 0.08 : 0);
  score += biases.seek_wonder * (kind === "explore" ? 0.18 : kind === "observe" ? 0.08 : 0);

  if (memory.emotion_core.active_episode?.kind === "death" && !memory.emotion_core.active_episode.resolved) {
    if (!isPreparedForRevisit(memory, frame)) {
      score += kind === "observe" ? 0.18 : 0;
      score += kind === "craft" ? 0.14 : 0;
      score += kind === "store" ? 0.12 : 0;
      score -= kind === "explore" ? 0.26 : 0;
    }
    if (frame.combat_state.weaponTier === "none") {
      score += kind === "craft" || kind === "bootstrap" ? 0.12 : 0;
    }
  }

  if (values.safety > 0.82) {
    score -= biases.avoid_risk * (kind === "explore" ? 0.12 : 0);
  }

  return score;
}

export function taggedPlaceAvoidancePenalty(target: Vec3 | undefined, memory: MemoryState): number {
  if (!target) {
    return 0;
  }

  return memory.emotion_core.tagged_places.reduce((penalty, place) => {
    if (place.kind !== "death_site" || place.revisit_policy !== "cautious") {
      return penalty;
    }
    const distance = distanceBetween(place.location, target);
    if (distance > 24) {
      return penalty;
    }
    return penalty + Math.max(0, memory.emotion_core.action_biases.cautious_revisit * place.salience * (1 - distance / 24));
  }, 0);
}

export function composeEmotionDialogue(
  memory: MemoryState,
  frame: PerceptionFrame,
  fallback: string,
  intentType: string
): string {
  const active = memory.emotion_core.active_episode;
  if (!active || active.kind !== "death" || active.resolved) {
    const dominant = memory.emotion_core.dominant_emotions[0] ?? "steady";
    if (dominant === "hopeful") {
      return fallback.replace(/^I /, "I feel more resolved, and I ");
    }
    if (dominant === "settled") {
      return fallback.replace(/^I /, "I feel steadier, and I ");
    }
    return fallback;
  }

  const cause = humanizeCauseTag(active.cause_tags.find((tag) => tag !== "death"));
  const place = active.focal_location ? describeRelativePlace(active.focal_location, frame.position) : "back there";
  const surroundings = describeCurrentSurroundings(frame);
  const lostItems = active.inventory_loss.length > 0 ? ` I also lost ${summarizeInventoryLoss(active.inventory_loss)}.` : "";
  const traits = memory.personality_profile.traits;

  if (traits.threat_sensitivity >= 0.66) {
    return `${cause ? `I still feel ${cause} ${place}.` : "Dying is still close in me."} ${surroundings} ${intentType === "recover" ? "I want calm and shelter before I risk another mistake." : fallback}${lostItems}`.trim();
  }

  if (traits.openness >= 0.62) {
    return `${cause ? `I keep replaying ${cause} ${place}.` : "I want to understand how I died."} ${surroundings} ${fallback}${lostItems}`.trim();
  }

  if (traits.conscientiousness >= 0.62) {
    return `${cause ? `I remember ${cause} ${place}.` : "I remember dying."} ${surroundings} ${intentType === "observe" ? "I should read this situation before I commit again." : fallback}${lostItems}`.trim();
  }

  return `${cause ? `I remember ${cause} ${place}.` : "I remember dying more clearly than I want to."} ${surroundings} ${fallback}${lostItems}`.trim();
}

function defaultAxes(): EmotionAppraisal {
  return {
    threat: 0.18,
    loss: 0.08,
    pain: 0.06,
    curiosity: 0.46,
    connection: 0.4,
    comfort: 0.5,
    mastery: 0.38,
    wonder: 0.42
  };
}

function defaultRegulation(): EmotionRegulation {
  return {
    arousal: 0.28,
    shock: 0.04,
    vigilance: 0.22,
    resolve: 0.42,
    recovery: 0.56
  };
}

function deriveActionBiases(
  axes: EmotionAppraisal,
  regulation: EmotionRegulation,
  activeEpisode?: EmotionEpisode,
  taggedPlaces: EmotionCoreState["tagged_places"] = []
): EmotionActionBiases {
  const deathSiteSalience = taggedPlaces
    .filter((place) => place.kind === "death_site")
    .reduce((max, place) => Math.max(max, place.salience), 0);
  const unresolvedDeath = activeEpisode?.kind === "death" && !activeEpisode.resolved ? activeEpisode.intensity : 0;
  return {
    avoid_risk: clamp(axes.threat * 0.64 + regulation.vigilance * 0.24 + regulation.shock * 0.12),
    seek_shelter: clamp(axes.threat * 0.32 + regulation.shock * 0.24 + (1 - axes.comfort) * 0.26 + unresolvedDeath * 0.12),
    seek_recovery: clamp(axes.pain * 0.3 + regulation.shock * 0.28 + (1 - regulation.recovery) * 0.18 + (1 - axes.comfort) * 0.14),
    seek_company: clamp(axes.connection * 0.46 + (1 - axes.comfort) * 0.08 - axes.threat * 0.14),
    seek_mastery: clamp(axes.mastery * 0.48 + regulation.resolve * 0.32 - regulation.shock * 0.12),
    seek_wonder: clamp(axes.wonder * 0.46 + axes.curiosity * 0.34 - axes.threat * 0.18),
    cautious_revisit: clamp(unresolvedDeath * 0.46 + deathSiteSalience * 0.24 + regulation.vigilance * 0.18 + regulation.shock * 0.12)
  };
}

function blendAxes(current: EmotionAppraisal, desired: EmotionAppraisal, rate = 0.42): EmotionAppraisal {
  return {
    threat: blend(current.threat, desired.threat, rate),
    loss: blend(current.loss, desired.loss, rate),
    pain: blend(current.pain, desired.pain, rate),
    curiosity: blend(current.curiosity, desired.curiosity, rate),
    connection: blend(current.connection, desired.connection, rate),
    comfort: blend(current.comfort, desired.comfort, rate),
    mastery: blend(current.mastery, desired.mastery, rate),
    wonder: blend(current.wonder, desired.wonder, rate)
  };
}

function blendRegulation(current: EmotionRegulation, desired: EmotionRegulation, rate = 0.42): EmotionRegulation {
  return {
    arousal: blend(current.arousal, desired.arousal, rate),
    shock: blend(current.shock, desired.shock, rate),
    vigilance: blend(current.vigilance, desired.vigilance, rate),
    resolve: blend(current.resolve, desired.resolve, rate),
    recovery: blend(current.recovery, desired.recovery, rate)
  };
}

function evolveActiveEpisode(
  episode: EmotionEpisode | undefined,
  axes: EmotionAppraisal,
  regulation: EmotionRegulation,
  perception: PerceptionFrame,
  now: string
): EmotionEpisode | undefined {
  if (!episode) {
    return undefined;
  }

  const nearEpisode = episode.focal_location ? distanceBetween(episode.focal_location, perception.position) <= 18 : false;
  const next: EmotionEpisode = {
    ...episode,
    appraisal: blendAxes(episode.appraisal, {
      ...axes,
      threat: clamp(axes.threat + (nearEpisode ? 0.12 : 0)),
      loss: episode.kind === "death" ? Math.max(axes.loss, episode.appraisal.loss * 0.84) : axes.loss,
      pain: episode.kind === "death" ? Math.max(axes.pain, episode.appraisal.pain * 0.76) : axes.pain
    }, 0.4),
    regulation: blendRegulation(episode.regulation, {
      ...regulation,
      shock: clamp(regulation.shock + (nearEpisode ? 0.08 : 0))
    }, 0.4),
    updated_at: now
  };
  next.dominant_emotions = deriveDominantEmotions(next.appraisal, next.regulation);
  next.intensity = intensityFrom(next.appraisal, next.regulation);
  next.resolved =
    next.intensity < 0.3 &&
    next.regulation.recovery >= 0.72 &&
    next.regulation.shock <= 0.18 &&
    perception.combat_state.hostilesNearby === 0;
  return next.resolved ? undefined : next;
}

function updatePassiveTaggedPlaces(
  places: EmotionCoreState["tagged_places"],
  perception: PerceptionFrame,
  affect: AffectState,
  now: string
): EmotionCoreState["tagged_places"] {
  let next = places
    .map((place) => ({
      ...place,
      location: { ...place.location },
      cause_tags: [...place.cause_tags],
      salience: clamp(place.kind === "death_site" ? place.salience * 0.992 : place.salience * 0.97),
      updated_at: now
    }))
    .filter((place) => place.salience >= 0.12);

  if (perception.home_state.anchor && perception.home_state.shelterScore >= 0.62) {
    next = upsertTaggedPlace(next, {
      kind: "comfort_site",
      label: "home",
      location: { ...perception.home_state.anchor },
      salience: clamp(0.34 + affect.security * 0.42),
      cause_tags: ["home", "comfort"],
      revisit_policy: "open",
      updated_at: now
    });
  }

  if (perception.notable_places.length > 0 && affect.wonder >= 0.62) {
    next = upsertTaggedPlace(next, {
      kind: "awe_site",
      label: perception.notable_places[0] ?? "notable place",
      location: { ...perception.position },
      salience: clamp(0.26 + affect.wonder * 0.34),
      cause_tags: ["beauty", "wonder"],
      revisit_policy: "open",
      updated_at: now
    });
  }

  return trimTaggedPlaces(next);
}

function integrateEpisode(
  core: EmotionCoreState,
  episode: EmotionEpisode,
  interrupt?: EmotionInterrupt
): EmotionCoreState {
  const dominant = deriveDominantEmotions(episode.appraisal, episode.regulation);
  const shouldPromote = !core.active_episode || core.active_episode.resolved || episode.intensity >= core.active_episode.intensity - 0.08;
  const active_episode = shouldPromote ? { ...episode, dominant_emotions: dominant } : core.active_episode;
  const axes = shouldPromote ? { ...episode.appraisal } : blendAxes(core.axes, episode.appraisal, 0.36);
  const regulation = shouldPromote ? { ...episode.regulation } : blendRegulation(core.regulation, episode.regulation, 0.36);
  const tagged_places = episode.kind === "beauty" && episode.focal_location
    ? upsertTaggedPlace(core.tagged_places, {
        kind: "awe_site",
        label: "beautiful place",
        location: { ...episode.focal_location },
        salience: clamp(0.28 + episode.appraisal.wonder * 0.3),
        cause_tags: ["beauty", ...episode.cause_tags],
        revisit_policy: "open",
        updated_at: episode.updated_at
      })
    : core.tagged_places;

  return {
    ...core,
    axes,
    regulation,
    action_biases: deriveActionBiases(axes, regulation, active_episode, tagged_places),
    dominant_emotions: dominant,
    active_episode,
    recent_episodes: trimEpisodes(syncRecentEpisodes(core.recent_episodes, active_episode), episode.updated_at),
    tagged_places,
    pending_interrupt: interrupt ?? core.pending_interrupt,
    last_event_at: episode.updated_at
  };
}

function episodeFromObservation(
  observation: MemoryObservation,
  personality?: ResidentPersonalityProfile
): EmotionEpisode | undefined {
  const importance = clamp(observation.importance);
  if (observation.tags.includes("death")) {
    return undefined;
  }

  if (observation.category === "danger" || observation.tags.includes("combat") || observation.tags.includes("boundary")) {
    return buildEpisode(
      "combat",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: clamp(0.64 + importance * 0.24),
        loss: clamp(0.12 + importance * 0.08),
        pain: clamp(0.24 + importance * 0.16),
        curiosity: 0.08,
        connection: 0.12,
        comfort: 0.14,
        mastery: clamp(0.2 + (personality?.traits.conscientiousness ?? 0.5) * 0.08),
        wonder: 0.04
      },
      {
        arousal: clamp(0.66 + importance * 0.18),
        shock: clamp(0.24 + importance * 0.18),
        vigilance: clamp(0.7 + importance * 0.14),
        resolve: 0.28,
        recovery: 0.18
      },
      "cautious"
    );
  }

  if (observation.category === "beauty") {
    return buildEpisode(
      "beauty",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: clamp(0.42 + importance * 0.18),
        connection: 0.18,
        comfort: clamp(0.34 + importance * 0.2),
        mastery: 0.14,
        wonder: clamp(0.72 + importance * 0.16)
      },
      {
        arousal: 0.34,
        shock: 0.02,
        vigilance: 0.08,
        resolve: 0.28,
        recovery: 0.52
      },
      "open"
    );
  }

  if (observation.category === "social" || observation.category === "hospitality") {
    return buildEpisode(
      "social",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: 0.18,
        connection: clamp(0.64 + importance * 0.18),
        comfort: clamp(0.34 + importance * 0.14),
        mastery: 0.16,
        wonder: 0.14
      },
      {
        arousal: 0.3,
        shock: 0.01,
        vigilance: 0.08,
        resolve: 0.28,
        recovery: 0.54
      },
      "open"
    );
  }

  if (observation.category === "recovery" || observation.category === "sleep") {
    return buildEpisode(
      "safety",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.1,
        loss: 0.04,
        pain: 0.06,
        curiosity: 0.14,
        connection: 0.2,
        comfort: clamp(0.54 + importance * 0.18),
        mastery: 0.28,
        wonder: 0.08
      },
      {
        arousal: 0.2,
        shock: 0.01,
        vigilance: 0.12,
        resolve: 0.38,
        recovery: clamp(0.72 + importance * 0.12)
      },
      "open"
    );
  }

  return undefined;
}

function episodeFromActionReport(report: ActionReport, core: EmotionCoreState): EmotionEpisode | undefined {
  const timestamp = new Date().toISOString();
  if (report.damage_taken > 0) {
    return buildEpisode(
      "damage",
      report.notes[0] ?? `Taking damage during ${report.intent_type} left a mark.`,
      timestamp,
      undefined,
      ["damage", report.intent_type],
      {
        threat: clamp(0.52 + report.damage_taken / 20),
        loss: 0.1,
        pain: clamp(0.3 + report.damage_taken / 20),
        curiosity: 0.08,
        connection: core.axes.connection * 0.8,
        comfort: 0.12,
        mastery: clamp(core.axes.mastery * 0.7),
        wonder: 0.02
      },
      {
        arousal: 0.74,
        shock: 0.22,
        vigilance: 0.66,
        resolve: 0.26,
        recovery: 0.18
      },
      "cautious"
    );
  }

  if (report.status === "failed" || report.needs_replan) {
    return buildEpisode(
      "loss",
      report.notes[0] ?? `${report.intent_type} failed and needs a new approach.`,
      timestamp,
      undefined,
      ["failure", report.intent_type],
      {
        threat: 0.24,
        loss: 0.34,
        pain: 0.08,
        curiosity: 0.12,
        connection: core.axes.connection,
        comfort: 0.18,
        mastery: clamp(core.axes.mastery * 0.58),
        wonder: 0.04
      },
      {
        arousal: 0.42,
        shock: 0.08,
        vigilance: 0.3,
        resolve: 0.24,
        recovery: 0.26
      },
      "cautious"
    );
  }

  if (report.status === "completed" && ["build", "craft", "repair", "farm", "tend_livestock"].includes(report.intent_type)) {
    return buildEpisode(
      "achievement",
      report.notes[0] ?? `Finishing ${report.intent_type} felt grounding.`,
      timestamp,
      undefined,
      ["achievement", report.intent_type],
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: 0.18,
        connection: core.axes.connection * 0.96,
        comfort: 0.42,
        mastery: 0.82,
        wonder: 0.14
      },
      {
        arousal: 0.34,
        shock: 0.01,
        vigilance: 0.08,
        resolve: 0.62,
        recovery: 0.56
      },
      "open"
    );
  }

  if (report.status === "completed" && ["recover", "eat", "sleep", "store"].includes(report.intent_type)) {
    return buildEpisode(
      "safety",
      report.notes[0] ?? `${report.intent_type} steadied the day.`,
      timestamp,
      undefined,
      ["recovery", report.intent_type],
      {
        threat: 0.08,
        loss: 0.02,
        pain: 0.04,
        curiosity: 0.14,
        connection: core.axes.connection,
        comfort: 0.62,
        mastery: 0.26,
        wonder: 0.06
      },
      {
        arousal: 0.2,
        shock: 0.01,
        vigilance: 0.12,
        resolve: 0.4,
        recovery: 0.82
      },
      "open"
    );
  }

  return undefined;
}

function buildEpisode(
  kind: EmotionEpisode["kind"],
  summary: string,
  timestamp: string,
  location: Vec3 | undefined,
  cause_tags: string[],
  appraisal: EmotionAppraisal,
  regulation: EmotionRegulation,
  revisit_policy: EmotionEpisode["revisit_policy"]
): EmotionEpisode {
  return {
    id: `${kind}:${timestamp}:${compact(cause_tags).join(":")}`,
    kind,
    summary,
    started_at: timestamp,
    updated_at: timestamp,
    source_trigger: "event",
    dominant_emotions: deriveDominantEmotions(appraisal, regulation),
    cause_tags: compact(cause_tags),
    focal_location: location ? { ...location } : undefined,
    respawn_location: undefined,
    inventory_loss: [],
    appraisal,
    regulation,
    intensity: intensityFrom(appraisal, regulation),
    revisit_policy,
    resolved: false
  };
}

function deriveDominantEmotions(appraisal: EmotionAppraisal, regulation: EmotionRegulation): string[] {
  const emotions: string[] = [];
  if (regulation.shock >= 0.64) {
    emotions.push("shaken");
  }
  if (appraisal.threat >= 0.56 || regulation.vigilance >= 0.64) {
    emotions.push("wary");
  }
  if (appraisal.loss >= 0.4) {
    emotions.push("grieving");
  }
  if (regulation.recovery >= 0.62 && appraisal.threat < 0.42) {
    emotions.push("recovering");
  }
  if (appraisal.connection >= 0.62) {
    emotions.push("connected");
  }
  if (appraisal.wonder >= 0.68) {
    emotions.push("awed");
  }
  if (appraisal.mastery >= 0.62 && regulation.resolve >= 0.48) {
    emotions.push("hopeful");
  }
  if (appraisal.comfort >= 0.6 && regulation.shock < 0.18) {
    emotions.push("settled");
  }
  return emotions.length > 0 ? emotions.slice(0, 3) : [...DEFAULT_DOMINANT];
}

function syncRecentEpisodes(
  episodes: EmotionEpisode[],
  activeEpisode: EmotionEpisode | undefined
): EmotionEpisode[] {
  const next = episodes.filter((episode) => !activeEpisode || episode.id !== activeEpisode.id);
  if (activeEpisode) {
    next.push(activeEpisode);
  }
  return next;
}

function trimEpisodes(episodes: EmotionEpisode[], now: string): EmotionEpisode[] {
  const nowMs = Date.parse(now);
  return episodes
    .filter((episode) => !episode.resolved || nowMs - Date.parse(episode.updated_at) < 1000 * 60 * 60 * 24)
    .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
    .slice(-MAX_EPISODES);
}

function updateTaggedPlace(
  core: EmotionCoreState,
  place: EmotionCoreState["tagged_places"][number] | undefined
): EmotionCoreState {
  if (!place) {
    return core;
  }
  const tagged_places = upsertTaggedPlace(core.tagged_places, place);
  return {
    ...core,
    tagged_places,
    action_biases: deriveActionBiases(core.axes, core.regulation, core.active_episode, tagged_places),
    last_event_at: place.updated_at
  };
}

function upsertTaggedPlace(
  places: EmotionCoreState["tagged_places"],
  place: EmotionCoreState["tagged_places"][number]
): EmotionCoreState["tagged_places"] {
  const next = places.filter(
    (entry) =>
      !(
        entry.kind === place.kind &&
        Math.round(entry.location.x) === Math.round(place.location.x) &&
        Math.round(entry.location.y) === Math.round(place.location.y) &&
        Math.round(entry.location.z) === Math.round(place.location.z)
      )
  );
  next.push({
    ...place,
    location: { ...place.location },
    cause_tags: [...place.cause_tags]
  });
  return trimTaggedPlaces(next);
}

function trimTaggedPlaces(places: EmotionCoreState["tagged_places"]): EmotionCoreState["tagged_places"] {
  return places
    .sort((left, right) => left.salience - right.salience)
    .slice(-MAX_TAGGED_PLACES);
}

function normalizeInventoryLoss(items: InventoryDeltaSummary[]): InventoryDeltaSummary[] {
  const merged = new Map<string, number>();
  for (const item of items ?? []) {
    if (!item?.item || item.count <= 0) {
      continue;
    }
    merged.set(item.item, (merged.get(item.item) ?? 0) + item.count);
  }
  return [...merged.entries()]
    .map(([item, count]) => ({ item, count }))
    .sort((left, right) => right.count - left.count);
}

function totalInventoryLoss(items: InventoryDeltaSummary[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

function summarizeInventoryLoss(items: InventoryDeltaSummary[]): string {
  return items
    .slice(0, 3)
    .map((item) => `${item.count} ${item.item.replace(/_/g, " ")}`)
    .join(", ");
}

function humanizeCauseTag(tag: string | undefined): string {
  if (!tag) {
    return "danger";
  }
  return tag.replace(/_/g, " ");
}

function describeCurrentSurroundings(frame: PerceptionFrame): string {
  if (frame.combat_state.hostilesNearby > 0) {
    return `There ${frame.combat_state.hostilesNearby === 1 ? "is still danger close." : "are still hostiles close."}`;
  }
  if (frame.home_state.shelterScore >= 0.65) {
    return "This place feels safer than where I fell.";
  }
  if (frame.notable_places.length > 0) {
    return `I can already tell I am near ${frame.notable_places[0]}.`;
  }
  return "The surroundings deserve a real look.";
}

function describeRelativePlace(target: Vec3, current: Vec3): string {
  const distance = distanceBetween(target, current);
  if (distance <= 6) {
    return "right here";
  }
  if (distance <= 18) {
    return "nearby";
  }
  return "farther off";
}

function nearestTaggedPlaceDistance(
  places: EmotionCoreState["tagged_places"],
  kind: EmotionCoreState["tagged_places"][number]["kind"],
  position: Vec3,
  radius: number
): number {
  const nearest = places
    .filter((place) => place.kind === kind)
    .map((place) => distanceBetween(place.location, position))
    .sort((left, right) => left - right)[0];
  if (nearest === undefined || nearest > radius) {
    return 0;
  }
  return clamp((radius - nearest) / radius);
}

function isPreparedForRevisit(memory: MemoryState, frame: PerceptionFrame): boolean {
  return (
    frame.health >= 18 &&
    frame.hunger >= 14 &&
    (frame.combat_state.weaponTier !== "none" || memory.bootstrap_progress.toolsReady) &&
    (frame.home_state.shelterScore >= 0.55 || Boolean(frame.safe_route_state.nearestShelter))
  );
}

function intensityFrom(appraisal: EmotionAppraisal, regulation: EmotionRegulation): number {
  return clamp((appraisal.threat + appraisal.loss + appraisal.pain + regulation.shock + regulation.arousal) / 5);
}

function distanceBetween(left: Vec3, right: Vec3): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function cloneEmotionCore(core: EmotionCoreState): EmotionCoreState {
  return {
    ...core,
    axes: { ...core.axes },
    regulation: { ...core.regulation },
    action_biases: { ...core.action_biases },
    dominant_emotions: [...core.dominant_emotions],
    active_episode: core.active_episode
      ? {
          ...core.active_episode,
          dominant_emotions: [...core.active_episode.dominant_emotions],
          cause_tags: [...core.active_episode.cause_tags],
          focal_location: core.active_episode.focal_location ? { ...core.active_episode.focal_location } : undefined,
          respawn_location: core.active_episode.respawn_location ? { ...core.active_episode.respawn_location } : undefined,
          inventory_loss: core.active_episode.inventory_loss.map((item) => ({ ...item })),
          appraisal: { ...core.active_episode.appraisal },
          regulation: { ...core.active_episode.regulation }
        }
      : undefined,
    recent_episodes: core.recent_episodes.map((episode) => ({
      ...episode,
      dominant_emotions: [...episode.dominant_emotions],
      cause_tags: [...episode.cause_tags],
      focal_location: episode.focal_location ? { ...episode.focal_location } : undefined,
      respawn_location: episode.respawn_location ? { ...episode.respawn_location } : undefined,
      inventory_loss: episode.inventory_loss.map((item) => ({ ...item })),
      appraisal: { ...episode.appraisal },
      regulation: { ...episode.regulation }
    })),
    tagged_places: core.tagged_places.map((place) => ({
      ...place,
      location: { ...place.location },
      cause_tags: [...place.cause_tags]
    })),
    pending_interrupt: core.pending_interrupt ? { ...core.pending_interrupt } : undefined
  };
}

function compact(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function blend(current: number, target: number, rate: number): number {
  return clamp(current + (target - current) * rate);
}
