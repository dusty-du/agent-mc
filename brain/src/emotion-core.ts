import {
  ActionReport,
  AffectState,
  BondedEntity,
  BondedEntityBondKind,
  BootstrapProgress,
  DayLifeReflectionResult,
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
  ResidentMotif,
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

export interface AnimalBondEmotionEvent {
  type: "animal_bond";
  timestamp: string;
  cause_tags: string[];
  animal_label: string;
  animal_id?: string;
  bond_kind?: BondedEntityBondKind;
  location?: Vec3;
  world?: string;
}

export interface AnimalBirthEmotionEvent {
  type: "animal_birth";
  timestamp: string;
  cause_tags: string[];
  species: string;
  offspring_label?: string;
  herd_id?: string;
  location?: Vec3;
  world?: string;
}

export type ResidentEmotionEvent =
  | ResidentDeathEmotionEvent
  | ResidentRespawnEmotionEvent
  | AnimalBondEmotionEvent
  | AnimalBirthEmotionEvent;

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
  intent_type: "move" | "observe" | "recover" | "retreat" | "socialize" | "tend_livestock";
  target?: Vec3;
  reason: string;
  dialogue: string;
  observation: string;
  observation_tags: string[];
}

export interface DayLifeReflectionApplyContext {
  trigger: ReplanTrigger;
  timestamp: string;
  perception: PerceptionFrame;
  personality: ResidentPersonalityProfile;
}

const MAX_EPISODES = 12;
const MAX_TAGGED_PLACES = 8;
const MAX_BONDED_ENTITIES = 12;
const POSITIVE_EPISODE_KINDS = new Set<EmotionEpisode["kind"]>([
  "beauty",
  "social",
  "attachment",
  "nurture",
  "wonder",
  "play",
  "milestone",
  "achievement",
  "safety"
]);
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
    bonded_entities: [],
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
  const bonded_entities = evolveBondedEntities(core.bonded_entities, perception, now);
  const nearbyBondStrength = nearbyBondSignal(bonded_entities, perception);
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
  const sunriseWonder = wonderMomentSignal(perception, context);
  const nurtureSignal = nurtureMomentSignal(perception);
  const wonderSupport = clamp(
    context.affect.wonder * 0.6 +
      (perception.notable_places.length > 0 ? 0.18 : 0) +
      (perception.terrain_affordances?.some((entry) => entry.type === "view" || entry.type === "water") ? 0.12 : 0) +
      sunriseWonder * 0.26
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
        nearbyBondStrength * 0.26 +
        clamp(1 - context.needs.relatedness) * 0.14 -
        clamp(context.needs.relatedness * 0.08)
    ),
    comfort: clamp(comfortSupport + safetySupport * 0.18 - deathSitePressure * 0.16 + overnightSettled + nearbyBondStrength * 0.08),
    mastery: clamp(masterySupport + clamp(1 - context.needs.competence) * 0.2 + nurtureSignal * 0.08),
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
  const tagged_places = updatePassiveTaggedPlaces(core.tagged_places, perception, context.affect, bonded_entities, now);
  const dominant_emotions = deriveDominantEmotions(axes, regulation);
  const action_biases = deriveActionBiases(axes, regulation, active_episode, tagged_places);
  let next: EmotionCoreState = {
    ...core,
    axes,
    regulation,
    action_biases,
    dominant_emotions,
    active_episode,
    recent_episodes: trimEpisodes(syncRecentEpisodes(core.recent_episodes, active_episode), now),
    tagged_places,
    bonded_entities,
    last_event_at: active_episode?.updated_at ?? core.last_event_at ?? now
  };

  const perceptionEpisode = inferPerceptionLifeEpisode(core, next, perception, context, now);
  if (perceptionEpisode) {
    next = integrateEpisode(next, perceptionEpisode.episode, perceptionEpisode.interrupt);
  }

  return {
    ...next,
    bonded_entities: trimBondedEntities(next.bonded_entities),
    tagged_places: trimTaggedPlaces(next.tagged_places)
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
  const bonded_entities = updateBondedEntitiesFromActionReport(core.bonded_entities, report);
  if (!episode) {
    return {
      ...core,
      bonded_entities
    };
  }
  return {
    ...integrateEpisode(
      {
        ...core,
        bonded_entities
      },
      episode
    ),
    bonded_entities
  };
}

export function applyResidentEmotionEvent(
  current: EmotionCoreState | undefined,
  event: ResidentEmotionEvent,
  personality: ResidentPersonalityProfile,
  now = event.timestamp
): EmotionCoreState {
  const core = cloneEmotionCore(current ?? createEmotionCoreState(now));

  if (event.type === "animal_bond") {
    const appraisal: EmotionAppraisal = {
      threat: 0.04,
      loss: 0.02,
      pain: 0.01,
      curiosity: clamp(0.24 + personality.traits.openness * 0.18),
      connection: clamp(0.76 + personality.traits.agreeableness * 0.12),
      comfort: 0.44,
      mastery: 0.28,
      wonder: 0.26
    };
    const regulation: EmotionRegulation = {
      arousal: 0.34,
      shock: 0.01,
      vigilance: 0.06,
      resolve: 0.36,
      recovery: 0.64
    };
    const label = event.animal_label.trim() || "animal companion";
    const episode = buildEpisode(
      "attachment",
      `A bond formed with ${label}.`,
      now,
      event.location,
      compact(["bonding", ...event.cause_tags, label]),
      appraisal,
      regulation,
      "open",
      {
        subject_kind: "pet",
        subject_id_or_label: event.animal_id ?? label,
        novelty: 0.92
      }
    );
    const next = integrateEpisode(
      {
        ...core,
        bonded_entities: upsertBondedEntity(core.bonded_entities, {
          id: event.animal_id ?? `pet:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          kind: "pet",
          label,
          bond_kind: event.bond_kind ?? "companion",
          familiarity: 0.56,
          attachment: 0.74,
          last_meaningful_contact_at: now,
          home_affinity: event.location ? comfortAtLocation(core.tagged_places, event.location) : undefined,
          place_affinity_label: event.location ? "bonded place" : undefined
        })
      },
      episode,
      canSoftInterrupt(core, personality) && event.location
        ? {
            trigger: "bonding",
            reason: `Bonding with ${label} deserves a deliberate response while the moment is fresh.`,
            created_at: now,
            episode_id: episode.id
          }
        : undefined
    );
    return updateTaggedPlace(
      next,
      event.location
        ? {
            kind: "bond_site",
            label,
            location: { ...event.location },
            world: event.world,
            salience: 0.68,
            cause_tags: ["bonding", label],
            revisit_policy: "open",
            updated_at: now
          }
        : undefined
    );
  }

  if (event.type === "animal_birth") {
    const label = event.offspring_label?.trim() || `${event.species} newborns`;
    const appraisal: EmotionAppraisal = {
      threat: 0.04,
      loss: 0.02,
      pain: 0.01,
      curiosity: clamp(0.26 + personality.traits.openness * 0.12),
      connection: clamp(0.56 + personality.traits.agreeableness * 0.16),
      comfort: 0.34,
      mastery: 0.42,
      wonder: 0.36
    };
    const regulation: EmotionRegulation = {
      arousal: 0.38,
      shock: 0.01,
      vigilance: 0.12,
      resolve: 0.44,
      recovery: 0.58
    };
    const episode = buildEpisode(
      "nurture",
      `New life arrived among the ${event.species}.`,
      now,
      event.location,
      compact(["birth", event.species, ...event.cause_tags]),
      appraisal,
      regulation,
      "open",
      {
        subject_kind: "herd",
        subject_id_or_label: event.herd_id ?? event.species,
        novelty: 0.86
      }
    );
    const next = integrateEpisode(
      {
        ...core,
        bonded_entities: upsertBondedEntity(core.bonded_entities, {
          id: event.herd_id ?? `herd:${event.species}`,
          kind: "herd",
          label: `${event.species} herd`,
          bond_kind: "caretaking",
          familiarity: 0.48,
          attachment: 0.52,
          last_meaningful_contact_at: now,
          home_affinity: event.location ? comfortAtLocation(core.tagged_places, event.location) : undefined,
          place_affinity_label: event.location ? "nursery" : undefined
        })
      },
      episode,
      canSoftInterrupt(core, personality)
        ? {
            trigger: "birth",
            reason: "New life in the herd is meaningful enough to bias the next move toward care.",
            created_at: now,
            episode_id: episode.id
          }
        : undefined
    );
    return updateTaggedPlace(
      next,
      event.location
        ? {
            kind: "nursery_site",
            label,
            location: { ...event.location },
            world: event.world,
            salience: 0.7,
            cause_tags: ["birth", event.species],
            revisit_policy: "open",
            updated_at: now
          }
        : undefined
    );
  }

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

export function applyDayLifeReflection(
  current: EmotionCoreState | undefined,
  reflection: DayLifeReflectionResult,
  context: DayLifeReflectionApplyContext
): EmotionCoreState {
  const core = cloneEmotionCore(current ?? createEmotionCoreState(context.timestamp));
  const focalLocation = reflection.place?.location ? { ...reflection.place.location } : { ...context.perception.position };
  const subject = reflection.subject ?? (reflection.bond ? { kind: reflection.bond.kind, label: reflection.bond.label } : undefined);
  const causeTags = compact([
    reflection.event_kind,
    context.trigger,
    subject?.label,
    reflection.place?.label
  ]);
  const baseEpisode = buildEpisode(
    reflection.event_kind,
    reflection.summary,
    context.timestamp,
    focalLocation,
    causeTags,
    applyAppraisalPatch(defaultAppraisalForReflection(reflection.event_kind), reflection.appraisal),
    applyRegulationPatch(defaultRegulationForReflection(reflection.event_kind), reflection.regulation),
    revisitPolicyForReflection(reflection.event_kind, reflection.appraisal, reflection.place?.revisit_policy),
    {
      subject_kind: subject?.kind,
      subject_id_or_label: subject?.label,
      novelty: clamp(reflection.salience)
    }
  );
  const matchingEpisode = findMatchingReflectionEpisode(core, reflection, focalLocation);
  const episode = matchingEpisode
    ? {
        ...baseEpisode,
        id: matchingEpisode.id,
        started_at: matchingEpisode.started_at,
        source_trigger: context.trigger,
        cause_tags: compact([...matchingEpisode.cause_tags, ...baseEpisode.cause_tags]),
        respawn_location: matchingEpisode.respawn_location,
        inventory_loss: matchingEpisode.inventory_loss.map((item) => ({ ...item })),
        appraisal: blendAxes(matchingEpisode.appraisal, baseEpisode.appraisal, 0.58),
        regulation: blendRegulation(matchingEpisode.regulation, baseEpisode.regulation, 0.58)
      }
    : {
        ...baseEpisode,
        source_trigger: context.trigger
      };
  episode.dominant_emotions = mergeDominantEmotions(
    reflection.dominant_emotions,
    deriveDominantEmotions(episode.appraisal, episode.regulation)
  );
  episode.intensity = clamp(Math.max(intensityFrom(episode.appraisal, episode.regulation), reflection.salience));

  const bonded_entities = reflection.bond
    ? upsertBondedEntity(core.bonded_entities, mergeBondFromReflection(core.bonded_entities, reflection, context))
    : core.bonded_entities;

  let next = integrateEpisode(
    {
      ...core,
      bonded_entities
    },
    episode
  );

  if (reflection.place) {
    next = updateTaggedPlace(next, {
      kind: reflection.place.kind,
      label: reflection.place.label,
      location: { ...reflection.place.location },
      world: reflection.place.world,
      salience: reflection.place.salience ?? clamp(0.28 + reflection.salience * 0.48),
      cause_tags: compact([reflection.event_kind, context.trigger, subject?.label]),
      revisit_policy: reflection.place.revisit_policy ?? episode.revisit_policy,
      updated_at: context.timestamp
    });
  }

  if (reflection.action_biases) {
    const action_biases = { ...next.action_biases };
    for (const [key, value] of Object.entries(reflection.action_biases) as Array<[keyof EmotionActionBiases, number | undefined]>) {
      if (value === undefined) {
        continue;
      }
      action_biases[key] = blend(action_biases[key], value, 0.55);
    }
    next = {
      ...next,
      action_biases
    };
  }

  const candidateInterrupt = reflection.interrupt
    ? {
        trigger: reflection.interrupt.trigger,
        reason: reflection.interrupt.reason,
        created_at: context.timestamp,
        episode_id: next.active_episode?.id
      }
    : undefined;

  const pending_interrupt =
    candidateInterrupt && (isHardInterrupt(candidateInterrupt.trigger) || canSoftInterrupt(next, context.personality))
      ? chooseStrongerInterrupt(next.pending_interrupt, candidateInterrupt)
      : next.pending_interrupt;

  return {
    ...next,
    pending_interrupt,
    last_event_at: context.timestamp
  };
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
  trigger: EmotionInterrupt["trigger"]
): EmotionInterruptIntent | undefined {
  const active = memory.emotion_core.active_episode;
  if (trigger === "wonder" && (active?.kind === "wonder" || active?.kind === "milestone" || active?.kind === "beauty")) {
    return {
      intent_type: "observe",
      reason: "Awe deserves a brief, grounded pause when survival is stable.",
      dialogue: composeEmotionDialogue(memory, frame, "I want to really see this before I hurry past it.", "observe"),
      observation: "The resident noticed a wonder moment and chose to stop long enough to take it in.",
      observation_tags: ["emotion", "wonder", "awe", "interrupt"]
    };
  }

  if ((trigger === "social_contact" || trigger === "bonding") && (active?.kind === "attachment" || active?.kind === "social")) {
    return {
      intent_type: "socialize",
      reason: "A fresh bond or reunion is meaningful enough to justify a warm exchange while it is safe.",
      dialogue: composeEmotionDialogue(memory, frame, "I want to answer this company honestly instead of drifting past it.", "socialize"),
      observation: "The resident is letting a new or renewed bond shape the next moment.",
      observation_tags: ["emotion", trigger, "connection", "interrupt"]
    };
  }

  if (trigger === "birth" && (active?.kind === "nurture" || active?.kind === "attachment")) {
    return {
      intent_type: "tend_livestock",
      reason: "New life in the herd should bias the next step toward care and protection.",
      dialogue: composeEmotionDialogue(memory, frame, "I want to check on them while this is still new and fragile.", "tend_livestock"),
      observation: "The resident is shifting toward nurture after noticing a birth or vulnerable young animals.",
      observation_tags: ["emotion", "birth", "nurture", "interrupt"]
    };
  }

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
  const active = memory.emotion_core.active_episode;
  const nearbyBondedPlayers = countNearbyBondedEntities(memory.emotion_core.bonded_entities, frame, "player");
  const nearbyCaretakingBonds = countNearbyBondedEntities(memory.emotion_core.bonded_entities, frame, "herd");
  let score = 0;

  score -= biases.avoid_risk * (kind === "explore" ? 0.54 : kind === "social" ? 0.16 : kind === "farm" || kind === "livestock" ? 0.14 : 0);
  score += biases.seek_shelter * (kind === "store" ? 0.18 : kind === "build" && frame.home_state.shelterScore < 0.7 ? 0.16 : 0);
  score += biases.seek_recovery * (kind === "observe" ? 0.18 : kind === "store" ? 0.08 : 0);
  score += biases.seek_mastery * (kind === "craft" || kind === "build" || kind === "bootstrap" ? 0.22 : 0);
  score += biases.seek_company * (kind === "social" ? 0.26 : kind === "livestock" ? 0.08 : 0);
  score += biases.seek_wonder * (kind === "explore" ? 0.18 : kind === "observe" ? 0.08 : 0);

  if (active?.kind === "death" && !active.resolved) {
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

  if ((active?.kind === "wonder" || active?.kind === "beauty") && frame.combat_state.hostilesNearby === 0) {
    score += kind === "observe" ? 0.34 : 0;
    score += kind === "explore" ? 0.16 : 0;
    score -= kind === "store" ? 0.08 : 0;
  }

  if (active?.kind === "attachment" || nearbyBondedPlayers > 0) {
    score += kind === "social" ? 0.34 + nearbyBondedPlayers * 0.08 : 0;
    score += kind === "store" && frame.home_state.anchor ? 0.08 : 0;
  }

  if (active?.kind === "nurture" || nearbyCaretakingBonds > 0) {
    score += kind === "livestock" ? 0.32 + nearbyCaretakingBonds * 0.1 : 0;
    score += kind === "build" && frame.home_state.anchor ? 0.12 : 0;
    score -= kind === "explore" ? 0.18 : 0;
  }

  if (active?.kind === "milestone") {
    score += kind === "build" || kind === "store" ? 0.16 : 0;
    score += kind === "observe" ? 0.1 : 0;
  }

  if (active?.kind === "play" && frame.combat_state.hostilesNearby === 0) {
    score += kind === "social" ? 0.18 : 0;
    score += kind === "observe" ? 0.1 : 0;
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
  const baseDialogue = composeBaseIntentDialogue(memory, frame, fallback, intentType);
  if (!active || active.resolved) {
    return baseDialogue;
  }

  if (active.kind === "wonder" || active.kind === "beauty") {
    const subject = humanizeNotablePlace(active.subject_id_or_label ?? frame.notable_places[0] ?? "this moment", "subject");
    return `Something about ${subject} feels worth really noticing. ${baseDialogue}`.trim();
  }

  if (active.kind === "attachment" || active.kind === "social") {
    const subject = active.subject_id_or_label ?? "this company";
    const prefix = active.cause_tags.includes("reunion") ? `${subject} being here again matters to me.` : `${subject} matters more than passing by politely.`;
    return `${prefix} ${baseDialogue}`.trim();
  }

  if (active.kind === "nurture") {
    const subject = active.subject_id_or_label ?? "the herd";
    return `${subject} feels newly vulnerable and important. ${baseDialogue}`.trim();
  }

  if (active.kind === "play") {
    return `This moment does not need to be useful to matter. ${baseDialogue}`.trim();
  }

  if (active.kind === "milestone") {
    const subject = humanizeNotablePlace(active.subject_id_or_label ?? "this place", "subject");
    return `${subject} feels like a first worth keeping. ${baseDialogue}`.trim();
  }

  if (active.kind !== "death") {
    return composeActiveEpisodeOverlay(active, frame, baseDialogue);
  }

  const cause = humanizeCauseTag(active.cause_tags.find((tag) => tag !== "death"));
  const place = active.focal_location ? describeRelativePlace(active.focal_location, frame.position) : "back there";
  const surroundings = describeCurrentSurroundings(frame);
  const lostItems = active.inventory_loss.length > 0 ? ` I also lost ${summarizeInventoryLoss(active.inventory_loss)}.` : "";
  const traits = memory.personality_profile.traits;

  if (traits.threat_sensitivity >= 0.66) {
    return `${cause ? `I still feel ${cause} ${place}.` : "Dying is still close in me."} ${surroundings} ${intentType === "recover" ? "I want calm and shelter before I risk another mistake." : baseDialogue}${lostItems}`.trim();
  }

  if (traits.openness >= 0.62) {
    return `${cause ? `I keep replaying ${cause} ${place}.` : "I want to understand how I died."} ${surroundings} ${baseDialogue}${lostItems}`.trim();
  }

  if (traits.conscientiousness >= 0.62) {
    return `${cause ? `I remember ${cause} ${place}.` : "I remember dying."} ${surroundings} ${intentType === "observe" ? "I should read this situation before I commit again." : baseDialogue}${lostItems}`.trim();
  }

  return `${cause ? `I remember ${cause} ${place}.` : "I remember dying more clearly than I want to."} ${surroundings} ${baseDialogue}${lostItems}`.trim();
}

function composeBaseIntentDialogue(
  memory: MemoryState,
  frame: PerceptionFrame,
  fallback: string,
  intentType: string
): string {
  if (intentType === "observe") {
    return composeNeutralObserveDialogue(memory, frame);
  }
  if (intentType === "gather") {
    return composeNeutralGatherDialogue(memory, frame);
  }
  if (intentType === "build" || intentType === "rebuild" || intentType === "repair") {
    return composeNeutralBuildDialogue(memory, frame);
  }
  if (intentType === "move") {
    return composeNeutralMoveDialogue(memory, frame);
  }
  return applyDominantToneToFallback(memory.emotion_core.dominant_emotions[0] ?? "steady", fallback);
}

function composeActiveEpisodeOverlay(active: EmotionEpisode, frame: PerceptionFrame, baseDialogue: string): string {
  if (active.kind === "loss") {
    const cause = humanizeCauseTag(active.cause_tags.find((tag) => tag !== "failure"));
    const prefix = cause ? `That last ${cause} still needles at me.` : "That last setback is still needling at me.";
    return `${prefix} ${baseDialogue}`.trim();
  }
  if (active.kind === "damage" || active.kind === "combat") {
    const threat = active.cause_tags.find((tag) => tag !== "combat" && tag !== "damage");
    const prefix = threat ? `I do not want ${humanizeCauseTag(threat)} to catch me flat-footed again.` : "I do not want to stumble into more hurt.";
    return `${prefix} ${baseDialogue}`.trim();
  }
  if (active.kind === "achievement") {
    const subject = humanizeNotablePlace(active.subject_id_or_label ?? "this progress", "subject");
    return `${subject} still feels like proof that I can carry something through. ${baseDialogue}`.trim();
  }
  if (active.kind === "safety") {
    const place = active.focal_location ? describeRelativePlace(active.focal_location, frame.position) : "here";
    return `This place feels a little steadier ${place}. ${baseDialogue}`.trim();
  }
  return baseDialogue;
}

const OBSERVE_DIALOGUE_TEMPLATES: Record<ResidentMotif, Array<(subject: string) => string>> = {
  homesteader: [
    (subject) => `I want to read ${subject} before I decide what belongs here next.`,
    (subject) => `One steady look at ${subject} will tell me how livable this place can become.`,
    (subject) => `I should take stock of ${subject} before I commit to the next task.`
  ],
  wanderer: [
    (subject) => `I want to read ${subject} before I choose my path through it.`,
    (subject) => `One careful look at ${subject} will tell me where the day wants to open.`,
    (subject) => `I should take the measure of ${subject} before I drift the wrong way.`
  ],
  caretaker: [
    (subject) => `I want to understand ${subject} before I disturb it or lean on it.`,
    (subject) => `A gentle look at ${subject} will tell me what needs care first.`,
    (subject) => `I should read ${subject} before I start changing things around me.`
  ],
  tinkerer: [
    (subject) => `I want to test the shape of ${subject} before I commit to a plan.`,
    (subject) => `A closer read of ${subject} will show what actually fits here.`,
    (subject) => `I should inspect ${subject} before I waste effort on the wrong move.`
  ],
  sentinel: [
    (subject) => `I need a careful read of ${subject} before I risk a wrong move.`,
    (subject) => `I want to study ${subject} long enough to see what it could hide.`,
    (subject) => `I should read ${subject} before I commit myself to it.`
  ],
  host: [
    (subject) => `I want to read ${subject} before I decide how to meet it.`,
    (subject) => `One honest look at ${subject} will tell me how to move without blundering in.`,
    (subject) => `I should take in ${subject} before I set the tone here.`
  ]
};

const GATHER_DIALOGUE_TEMPLATES: Record<ResidentMotif, Array<(focus: string) => string>> = {
  homesteader: [
    (focus) => `I need ${focus} before this place can start feeling properly livable.`,
    (focus) => `A little ${focus} will let me turn this patch into somewhere I can stay.`,
    (focus) => `I should bring in ${focus} before I ask anything else from this place.`
  ],
  wanderer: [
    (focus) => `I need ${focus} before this stretch can hold me for long.`,
    (focus) => `A little ${focus} will turn this stop from a pause into a foothold.`,
    (focus) => `I should gather ${focus} before I trust this place to keep me.`
  ],
  caretaker: [
    (focus) => `I need ${focus} before I can make a steadier place to care from.`,
    (focus) => `A little ${focus} will make things gentler and safer here.`,
    (focus) => `I should gather ${focus} before I start trying to shelter anything else.`
  ],
  tinkerer: [
    (focus) => `I need ${focus} before I can turn this patch into tools and shelter.`,
    (focus) => `A little ${focus} will give me something real to work with.`,
    (focus) => `I should gather ${focus} before I waste effort improvising around nothing.`
  ],
  sentinel: [
    (focus) => `I need ${focus} before this ground stops feeling exposed.`,
    (focus) => `A little ${focus} will buy me cover, tools, and fewer bad surprises.`,
    (focus) => `I should gather ${focus} before I trust this place at all.`
  ],
  host: [
    (focus) => `I need ${focus} before this place can properly welcome me.`,
    (focus) => `A little ${focus} will make this patch feel warmer and more usable.`,
    (focus) => `I should gather ${focus} before I ask this place to hold together.`
  ]
};

const BUILD_DIALOGUE_TEMPLATES: Record<ResidentMotif, Array<(focus: string) => string>> = {
  homesteader: [
    (focus) => `I need to shape ${focus} before this place can truly hold me.`,
    (focus) => `A little work on ${focus} will turn this patch into somewhere I can stay.`,
    (focus) => `I should put real shape into ${focus} before the day slips away from me.`
  ],
  wanderer: [
    (focus) => `I need ${focus} if this stop is going to become more than a pause.`,
    (focus) => `A little work on ${focus} will turn this stretch into a real foothold.`,
    (focus) => `I should shape ${focus} before I let this place remain temporary.`
  ],
  caretaker: [
    (focus) => `I need ${focus} before anything here can feel gentler or safer.`,
    (focus) => `A little care poured into ${focus} will make this place easier to live from.`,
    (focus) => `I should shape ${focus} before I ask this place to shelter anything else.`
  ],
  tinkerer: [
    (focus) => `I need ${focus} before I can turn this patch into something usable.`,
    (focus) => `A little structure in ${focus} will give me something real to work with.`,
    (focus) => `I should build out ${focus} before I waste effort improvising around gaps.`
  ],
  sentinel: [
    (focus) => `I need ${focus} before this ground stops feeling exposed.`,
    (focus) => `A little work on ${focus} will buy me cover and fewer bad surprises.`,
    (focus) => `I should fortify ${focus} before I trust this place at all.`
  ],
  host: [
    (focus) => `I need ${focus} before this place can start feeling welcoming.`,
    (focus) => `A little work on ${focus} will make this patch warmer and easier to use.`,
    (focus) => `I should shape ${focus} before I ask this place to hold together kindly.`
  ]
};

const MOVE_DIALOGUE_TEMPLATES: Record<ResidentMotif, Array<(focus: string) => string>> = {
  homesteader: [
    (focus) => `I should head toward ${focus} and see whether it can support a steadier life.`,
    (focus) => `A closer look at ${focus} might show me where a real foothold belongs.`,
    (focus) => `I should move toward ${focus} before I waste more time on the wrong patch.`
  ],
  wanderer: [
    (focus) => `I should follow ${focus} and see where it opens the day.`,
    (focus) => `A little movement toward ${focus} might turn this into the right path.`,
    (focus) => `I should drift toward ${focus} and see what kind of ground waits there.`
  ],
  caretaker: [
    (focus) => `I should head toward ${focus} and see if it offers a gentler place to work from.`,
    (focus) => `A closer look at ${focus} might show me where care can actually take hold.`,
    (focus) => `I should move toward ${focus} before I ask too much from this exposed spot.`
  ],
  tinkerer: [
    (focus) => `I should move toward ${focus} and test whether it gives me better options.`,
    (focus) => `A better angle on ${focus} might show what really fits here.`,
    (focus) => `I should head toward ${focus} before I keep guessing from the wrong place.`
  ],
  sentinel: [
    (focus) => `I should head toward ${focus} and see if it buys me safer ground.`,
    (focus) => `A closer look at ${focus} might put fewer surprises around me.`,
    (focus) => `I should move toward ${focus} before I stay exposed here any longer.`
  ],
  host: [
    (focus) => `I should head toward ${focus} and see if it offers a better place to settle into.`,
    (focus) => `A closer look at ${focus} might show where this place becomes more welcoming.`,
    (focus) => `I should move toward ${focus} before I commit to the wrong corner of this patch.`
  ]
};

function composeNeutralObserveDialogue(memory: MemoryState, frame: PerceptionFrame): string {
  const subject = describeObserveSubject(frame);
  const motif = memory.personality_profile.motifs.primary;
  const templates = OBSERVE_DIALOGUE_TEMPLATES[motif] ?? OBSERVE_DIALOGUE_TEMPLATES.homesteader;
  const tail = observeMoodTail(memory.emotion_core.dominant_emotions[0] ?? "steady");
  return pickFreshRenderedVariant(
    memory,
    templates,
    [
      memory.personality_profile.seed,
      motif,
      memory.personality_profile.motifs.secondary ?? "",
      subject,
      frame.weather,
      frame.biome ?? "",
      String(Math.floor(frame.tick_time / 1200))
    ].join(":"),
    (template) => [template(subject), tail].filter(Boolean).join(" ").trim(),
    (line) => `${line} ${repetitionTail("observe", memory, frame)}`.trim()
  );
}

function composeNeutralGatherDialogue(memory: MemoryState, frame: PerceptionFrame): string {
  const focus = describeGatherFocus(frame);
  const motif = memory.personality_profile.motifs.primary;
  const templates = GATHER_DIALOGUE_TEMPLATES[motif] ?? GATHER_DIALOGUE_TEMPLATES.homesteader;
  const tail = gatherMoodTail(memory.emotion_core.dominant_emotions[0] ?? "steady");
  return pickFreshRenderedVariant(
    memory,
    templates,
    [
      memory.personality_profile.seed,
      motif,
      memory.personality_profile.motifs.secondary ?? "",
      focus,
      frame.weather,
      frame.biome ?? "",
      String(Math.floor(frame.tick_time / 1200))
    ].join(":"),
    (template) => [template(focus), tail].filter(Boolean).join(" ").trim(),
    (line) => `${line} ${repetitionTail("gather", memory, frame)}`.trim()
  );
}

function composeNeutralBuildDialogue(memory: MemoryState, frame: PerceptionFrame): string {
  const focus = describeBuildFocus(frame);
  const motif = memory.personality_profile.motifs.primary;
  const templates = BUILD_DIALOGUE_TEMPLATES[motif] ?? BUILD_DIALOGUE_TEMPLATES.homesteader;
  const tail = buildMoodTail(memory.emotion_core.dominant_emotions[0] ?? "steady");
  return pickFreshRenderedVariant(
    memory,
    templates,
    [
      memory.personality_profile.seed,
      motif,
      memory.personality_profile.motifs.secondary ?? "",
      focus,
      frame.weather,
      frame.biome ?? "",
      String(Math.floor(frame.tick_time / 1200))
    ].join(":"),
    (template) => [template(focus), tail].filter(Boolean).join(" ").trim(),
    (line) => `${line} ${repetitionTail("build", memory, frame)}`.trim()
  );
}

function composeNeutralMoveDialogue(memory: MemoryState, frame: PerceptionFrame): string {
  const focus = describeMoveFocus(frame);
  const motif = memory.personality_profile.motifs.primary;
  const templates = MOVE_DIALOGUE_TEMPLATES[motif] ?? MOVE_DIALOGUE_TEMPLATES.homesteader;
  const tail = moveMoodTail(memory.emotion_core.dominant_emotions[0] ?? "steady");
  return pickFreshRenderedVariant(
    memory,
    templates,
    [
      memory.personality_profile.seed,
      motif,
      memory.personality_profile.motifs.secondary ?? "",
      focus,
      frame.weather,
      frame.biome ?? "",
      String(Math.floor(frame.tick_time / 1200))
    ].join(":"),
    (template) => [template(focus), tail].filter(Boolean).join(" ").trim(),
    (line) => `${line} ${repetitionTail("move", memory, frame)}`.trim()
  );
}

function applyDominantToneToFallback(dominant: string, fallback: string): string {
  if (dominant === "hopeful") {
    return fallback.replace(/^I /, "I feel more resolved, and I ");
  }
  if (dominant === "settled") {
    return fallback.replace(/^I /, "I feel steadier, and I ");
  }
  return fallback;
}

function observeMoodTail(dominant: string): string {
  if (dominant === "hopeful") {
    return "There may be a better turn here than panic.";
  }
  if (dominant === "settled") {
    return "A steady look will teach me more than rushing.";
  }
  return "";
}

function gatherMoodTail(dominant: string): string {
  if (dominant === "hopeful") {
    return "Once I have that, the rest can finally start taking shape.";
  }
  if (dominant === "settled") {
    return "Steady materials first; the rest can follow.";
  }
  return "";
}

function buildMoodTail(dominant: string): string {
  if (dominant === "hopeful") {
    return "If I get the shape right, the rest of life here can start gathering around it.";
  }
  if (dominant === "settled") {
    return "A few solid edges now will make everything else easier.";
  }
  return "";
}

function moveMoodTail(dominant: string): string {
  if (dominant === "hopeful") {
    return "There may be a better answer a little farther on.";
  }
  if (dominant === "settled") {
    return "A better read of the ground is worth the walk.";
  }
  return "";
}

function describeObserveSubject(frame: PerceptionFrame): string {
  const nearbyPlayer = frame.nearby_entities.find((entity) => entity.type === "player");
  if (nearbyPlayer) {
    return "this meeting";
  }
  if (frame.tick_time <= 1000 && frame.weather === "clear") {
    return "the morning light around me";
  }
  if (frame.tick_time >= 11800 && frame.tick_time <= 13000) {
    return "the failing light around me";
  }
  const overlook = frame.terrain_affordances?.find((entry) => entry.type === "view");
  if (overlook) {
    return "the land opening out ahead";
  }
  const water = frame.terrain_affordances?.find((entry) => entry.type === "water");
  if (water) {
    return "the waterline nearby";
  }
  const treeLine = frame.terrain_affordances?.find((entry) => entry.type === "tree");
  if (treeLine) {
    return "the tree line nearby";
  }
  if (frame.notable_places[0]) {
    return humanizeNotablePlace(frame.notable_places[0], "subject");
  }
  if (frame.home_state.shelterScore < 0.4) {
    return "this exposed patch of ground";
  }
  if (frame.weather !== "clear") {
    return "the weather and the ground around me";
  }
  if (frame.biome) {
    return `this ${frame.biome.replace(/_/g, " ")} stretch`;
  }
  return "the ground around me";
}

function describeGatherFocus(frame: PerceptionFrame): string {
  const treeLine = frame.terrain_affordances?.find((entry) => entry.type === "tree");
  if (treeLine) {
    return "wood from that tree line";
  }
  const logBlock = frame.nearby_blocks.find((block) => block.name.includes("log"));
  if (logBlock) {
    return "wood from the nearby logs";
  }
  if (frame.home_state.shelterScore < 0.4) {
    return "enough wood for a first shelter";
  }
  if (frame.weather !== "clear") {
    return "enough wood to get shelter and light up";
  }
  if (frame.biome?.includes("forest")) {
    return "some good wood";
  }
  return "some wood";
}

function describeBuildFocus(frame: PerceptionFrame): string {
  if (frame.home_state.shelterScore < 0.35) {
    return "real shelter";
  }
  if (!frame.home_state.bedAvailable) {
    return "a place I can finally sleep";
  }
  if (!frame.home_state.workshopReady) {
    return "a sturdier corner to work from";
  }
  if (frame.notable_places[0]) {
    return humanizeNotablePlace(frame.notable_places[0], "location");
  }
  return "a truer home";
}

function describeMoveFocus(frame: PerceptionFrame): string {
  const overlook = frame.terrain_affordances?.find((entry) => entry.type === "view");
  if (overlook) {
    return "the rise ahead";
  }
  const treeLine = frame.terrain_affordances?.find((entry) => entry.type === "tree");
  if (treeLine) {
    return "the tree line";
  }
  const water = frame.terrain_affordances?.find((entry) => entry.type === "water");
  if (water) {
    return "the nearby water";
  }
  const flatGround = frame.terrain_affordances?.find((entry) => entry.type === "flat");
  if (flatGround) {
    return "the open ground";
  }
  if (frame.home_state.shelterScore < 0.4) {
    return "safer ground";
  }
  return "a better foothold";
}

function withArticle(label: string): string {
  if (/^(the|this|that|my|our|their)\b/i.test(label) || /[A-Z]/.test(label.charAt(0)) || label.includes("'")) {
    return label;
  }
  return `the ${label}`;
}

function humanizeNotablePlace(label: string, mode: "subject" | "location"): string {
  const normalized = label.replace(/_/g, " ").trim().toLowerCase();
  if (normalized === "good building ground") {
    return mode === "subject" ? "this flat patch of ground" : "open ground";
  }
  if (normalized === "flat ground" || normalized === "open ground") {
    return mode === "subject" ? "this flat patch of ground" : normalized;
  }
  if (normalized === "wide view") {
    return mode === "subject" ? "the wider view from here" : "higher ground";
  }
  if (normalized === "near water") {
    return mode === "subject" ? "the nearby water" : "nearby water";
  }
  if (normalized === "company nearby") {
    return mode === "subject" ? "this company" : "company";
  }
  const humanized = label.replace(/_/g, " ");
  return mode === "subject" ? withArticle(humanized) : humanized;
}

function pickStableVariant<T>(items: readonly T[], key: string): T {
  return items[stableIndex(key, items.length)] ?? items[0];
}

function pickFreshRenderedVariant<T>(
  memory: MemoryState,
  items: readonly T[],
  key: string,
  render: (item: T) => string,
  whenExhausted?: (line: string) => string
): string {
  const baseIndex = stableIndex(key, items.length);
  const recentDialogues = recentThoughtDialogues(memory);
  for (let offset = 0; offset < items.length; offset += 1) {
    const item = items[(baseIndex + offset) % items.length] ?? items[0];
    const candidate = render(item).trim();
    if (!recentDialogues.has(normalizeDialogue(candidate))) {
      return candidate;
    }
  }
  const fallback = render(items[baseIndex] ?? items[0]).trim();
  return whenExhausted ? whenExhausted(fallback) : fallback;
}

function stableIndex(key: string, size: number): number {
  if (size <= 1) {
    return 0;
  }
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

function recentThoughtDialogues(memory: MemoryState): Set<string> {
  return new Set(
    memory.recent_observations
      .filter((observation) => observation.source === "dialogue" && observation.tags.includes("thought"))
      .slice(-6)
      .map((observation) => normalizeDialogue(observation.summary))
      .filter(Boolean)
  );
}

function normalizeDialogue(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

function repetitionTail(intentType: "observe" | "gather" | "build" | "move", memory: MemoryState, frame: PerceptionFrame): string {
  const optionsByIntent: Record<typeof intentType, string[]> = {
    observe: [
      "Another angle might show me what I missed.",
      "I do not want to mistake familiarity for understanding.",
      "A fresh read may finally make the shape of it click."
    ],
    gather: [
      "I need to make progress instead of thinking in circles.",
      "Another pass at it may finally give me the materials I need.",
      "If I keep repeating myself, the work still needs doing."
    ],
    build: [
      "A new pass at the shape might finally show me what belongs here.",
      "I need a fresher read of the structure than habit is giving me.",
      "If I keep circling the same line, the place will not improve on its own."
    ],
    move: [
      "A different angle on the ground might finally tell me something new.",
      "If I keep circling blindly, I will miss what this place is offering.",
      "A few more steps may make the terrain read differently."
    ]
  };
  const options = optionsByIntent[intentType];
  return pickStableVariant(
    options,
    [
      memory.personality_profile.seed,
      intentType,
      String(Math.floor(frame.tick_time / 80)),
      String(Math.round(frame.position.x / 4)),
      String(Math.round(frame.position.z / 4))
    ].join(":")
  );
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
  const positiveEpisode = POSITIVE_EPISODE_KINDS.has(episode.kind) && episode.kind !== "safety";
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(episode.started_at));
  const next: EmotionEpisode = {
    ...episode,
    appraisal: blendAxes(episode.appraisal, {
      ...axes,
      threat: clamp(axes.threat + (episode.kind === "death" && nearEpisode ? 0.12 : 0)),
      loss: episode.kind === "death" ? Math.max(axes.loss, episode.appraisal.loss * 0.84) : positiveEpisode ? blend(episode.appraisal.loss, axes.loss, 0.52) : axes.loss,
      pain: episode.kind === "death" ? Math.max(axes.pain, episode.appraisal.pain * 0.76) : positiveEpisode ? blend(episode.appraisal.pain, axes.pain, 0.56) : axes.pain,
      curiosity: positiveEpisode ? Math.max(axes.curiosity, episode.appraisal.curiosity * (nearEpisode ? 0.96 : 0.88)) : axes.curiosity,
      connection: positiveEpisode ? Math.max(axes.connection, episode.appraisal.connection * (nearEpisode ? 0.98 : 0.9)) : axes.connection,
      comfort: positiveEpisode ? Math.max(axes.comfort, episode.appraisal.comfort * (nearEpisode ? 0.98 : 0.9)) : axes.comfort,
      mastery: positiveEpisode ? Math.max(axes.mastery, episode.appraisal.mastery * (nearEpisode ? 0.97 : 0.9)) : axes.mastery,
      wonder: positiveEpisode ? Math.max(axes.wonder, episode.appraisal.wonder * (nearEpisode ? 0.98 : 0.88)) : axes.wonder
    }, 0.4),
    regulation: blendRegulation(episode.regulation, {
      ...regulation,
      shock: clamp(positiveEpisode ? Math.min(regulation.shock, episode.regulation.shock * 0.84) : regulation.shock + (nearEpisode ? 0.08 : 0)),
      resolve: positiveEpisode ? Math.max(regulation.resolve, episode.regulation.resolve * 0.92) : regulation.resolve,
      recovery: positiveEpisode ? Math.max(regulation.recovery, episode.regulation.recovery * 0.92) : regulation.recovery
    }, 0.4),
    updated_at: now
  };
  next.dominant_emotions = deriveDominantEmotions(next.appraisal, next.regulation);
  next.intensity = intensityFrom(next.appraisal, next.regulation);
  next.resolved = positiveEpisode
    ? (ageMs >= 1000 * 60 * 12 && next.intensity <= 0.62) ||
      (ageMs >= 1000 * 60 * 24 && next.intensity <= 0.74) ||
      (next.intensity < 0.36 && next.regulation.shock <= 0.12)
    : next.intensity < 0.3 &&
      next.regulation.recovery >= 0.72 &&
      next.regulation.shock <= 0.18 &&
      perception.combat_state.hostilesNearby === 0;
  return next.resolved ? undefined : next;
}

function updatePassiveTaggedPlaces(
  places: EmotionCoreState["tagged_places"],
  perception: PerceptionFrame,
  affect: AffectState,
  bondedEntities: EmotionCoreState["bonded_entities"],
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

  const strongestBond = bondedEntities
    .filter((bond) => bond.attachment >= 0.58)
    .sort((left, right) => right.attachment - left.attachment)[0];
  if (strongestBond && perception.home_state.anchor) {
    next = upsertTaggedPlace(next, {
      kind: "bond_site",
      label: strongestBond.label,
      location: { ...perception.home_state.anchor },
      salience: clamp(0.22 + strongestBond.attachment * 0.34),
      cause_tags: [strongestBond.kind, strongestBond.label, "bonding"],
      revisit_policy: "open",
      updated_at: now
    });
  }

  const babySpecies = firstNearbyBabySpecies(perception);
  if (babySpecies && perception.home_state.anchor) {
    next = upsertTaggedPlace(next, {
      kind: "nursery_site",
      label: `${babySpecies} nursery`,
      location: { ...perception.home_state.anchor },
      salience: 0.58,
      cause_tags: ["birth", babySpecies, "care"],
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
  let tagged_places = core.tagged_places;
  if (
    (episode.kind === "beauty" ||
      episode.kind === "wonder" ||
      (episode.kind === "milestone" && episode.cause_tags.some((tag) => tag === "sunrise" || tag === "wonder"))) &&
    episode.focal_location
  ) {
    tagged_places = upsertTaggedPlace(tagged_places, {
      kind: "awe_site",
      label: episode.subject_id_or_label ?? "beautiful place",
      location: { ...episode.focal_location },
      salience: clamp(0.28 + episode.appraisal.wonder * 0.3 + (episode.novelty ?? 0) * 0.1),
      cause_tags: ["beauty", ...episode.cause_tags],
      revisit_policy: "open",
      updated_at: episode.updated_at
    });
  }
  if (episode.kind === "attachment" && episode.focal_location) {
    tagged_places = upsertTaggedPlace(tagged_places, {
      kind: "bond_site",
      label: episode.subject_id_or_label ?? "bonded place",
      location: { ...episode.focal_location },
      salience: clamp(0.28 + episode.appraisal.connection * 0.28),
      cause_tags: ["bonding", ...episode.cause_tags],
      revisit_policy: "open",
      updated_at: episode.updated_at
    });
  }
  if (episode.kind === "nurture" && episode.focal_location) {
    tagged_places = upsertTaggedPlace(tagged_places, {
      kind: "nursery_site",
      label: episode.subject_id_or_label ?? "nursery",
      location: { ...episode.focal_location },
      salience: clamp(0.32 + episode.appraisal.connection * 0.24 + episode.appraisal.mastery * 0.16),
      cause_tags: ["birth", ...episode.cause_tags],
      revisit_policy: "open",
      updated_at: episode.updated_at
    });
  }

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

  if (observation.tags.includes("birth") || observation.tags.includes("nurture")) {
    return buildEpisode(
      "nurture",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: clamp(0.22 + importance * 0.12),
        connection: clamp(0.58 + importance * 0.18),
        comfort: clamp(0.3 + importance * 0.12),
        mastery: clamp(0.44 + importance * 0.16),
        wonder: clamp(0.28 + importance * 0.12)
      },
      {
        arousal: 0.34,
        shock: 0.01,
        vigilance: 0.12,
        resolve: 0.46,
        recovery: 0.56
      },
      "open",
      {
        subject_kind: observation.tags.includes("pet") ? "pet" : "herd",
        subject_id_or_label: observation.tags.find((tag) => !["birth", "nurture", "livestock", "pet", "care"].includes(tag)),
        novelty: importance
      }
    );
  }

  if (observation.tags.includes("bonding") || observation.tags.includes("pet") || observation.tags.includes("reunion")) {
    return buildEpisode(
      "attachment",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: clamp(0.2 + importance * 0.12),
        connection: clamp(0.68 + importance * 0.18),
        comfort: clamp(0.34 + importance * 0.12),
        mastery: 0.18,
        wonder: 0.16
      },
      {
        arousal: 0.3,
        shock: 0.01,
        vigilance: 0.08,
        resolve: 0.3,
        recovery: 0.58
      },
      "open",
      {
        subject_kind: observation.tags.includes("pet") ? "pet" : "player",
        subject_id_or_label: observation.tags.find((tag) => !["bonding", "pet", "player", "meeting", "reunion", "social"].includes(tag)),
        novelty: importance
      }
    );
  }

  if (observation.tags.includes("wonder") || observation.tags.includes("sunrise") || observation.tags.includes("sunset")) {
    return buildEpisode(
      "wonder",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.02,
        loss: 0.01,
        pain: 0.01,
        curiosity: clamp(0.48 + importance * 0.16),
        connection: 0.16,
        comfort: clamp(0.3 + importance * 0.16),
        mastery: 0.12,
        wonder: clamp(0.76 + importance * 0.14)
      },
      {
        arousal: 0.3,
        shock: 0.01,
        vigilance: 0.06,
        resolve: 0.28,
        recovery: 0.58
      },
      "open",
      {
        subject_kind: "moment",
        subject_id_or_label: observation.tags.includes("sunrise") ? "sunrise" : observation.tags.includes("sunset") ? "sunset" : observation.summary,
        novelty: importance
      }
    );
  }

  if (observation.tags.includes("play")) {
    return buildEpisode(
      "play",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.02,
        loss: 0.01,
        pain: 0.01,
        curiosity: clamp(0.34 + importance * 0.14),
        connection: clamp(0.44 + importance * 0.16),
        comfort: clamp(0.34 + importance * 0.14),
        mastery: 0.14,
        wonder: 0.24
      },
      {
        arousal: 0.34,
        shock: 0.01,
        vigilance: 0.04,
        resolve: 0.24,
        recovery: 0.58
      },
      "open",
      {
        subject_kind: observation.tags.includes("player") ? "player" : observation.tags.includes("pet") ? "pet" : "moment",
        subject_id_or_label: observation.tags.find((tag) => !["play", "player", "pet", "social"].includes(tag)),
        novelty: importance
      }
    );
  }

  if (observation.tags.includes("milestone") || observation.tags.includes("first")) {
    return buildEpisode(
      "milestone",
      observation.summary,
      observation.timestamp,
      observation.location,
      observation.tags,
      {
        threat: 0.02,
        loss: 0.01,
        pain: 0.01,
        curiosity: 0.22,
        connection: 0.24,
        comfort: clamp(0.38 + importance * 0.14),
        mastery: clamp(0.54 + importance * 0.14),
        wonder: clamp(0.32 + importance * 0.14)
      },
      {
        arousal: 0.32,
        shock: 0.01,
        vigilance: 0.06,
        resolve: 0.42,
        recovery: 0.54
      },
      "open",
      {
        subject_kind: observation.location ? "place" : "moment",
        subject_id_or_label: observation.summary,
        novelty: importance
      }
    );
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
      "open",
      {
        subject_kind: "place",
        subject_id_or_label: observation.summary,
        novelty: importance
      }
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
      "open",
      {
        subject_kind: "player",
        subject_id_or_label: observation.tags.find((tag) => !["chat", "player", "nearby", "ambient", "social", "hospitality"].includes(tag)),
        novelty: importance
      }
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

  if (report.status === "completed" && report.intent_type === "socialize") {
    return buildEpisode(
      "play",
      report.notes[0] ?? "A gentle social moment brightened the day.",
      timestamp,
      undefined,
      ["play", "social", report.intent_type],
      {
        threat: 0.02,
        loss: 0.01,
        pain: 0.01,
        curiosity: 0.28,
        connection: clamp(0.58 + core.axes.connection * 0.18),
        comfort: 0.44,
        mastery: 0.14,
        wonder: 0.22
      },
      {
        arousal: 0.34,
        shock: 0.01,
        vigilance: 0.04,
        resolve: 0.26,
        recovery: 0.6
      },
      "open",
      {
        subject_kind: "player",
        subject_id_or_label: firstCapitalizedWord(report.notes[0]),
        novelty: 0.44
      }
    );
  }

  if (report.status === "completed" && report.intent_type === "tend_livestock") {
    return buildEpisode(
      report.notes.some((note) => /fed|bred|baby|newborn/i.test(note)) ? "nurture" : "achievement",
      report.notes[0] ?? "Checking on the animals made the home feel more alive.",
      timestamp,
      undefined,
      ["livestock", "care", report.intent_type, ...extractSpeciesTags(report.notes)],
      {
        threat: 0.03,
        loss: 0.01,
        pain: 0.01,
        curiosity: 0.22,
        connection: 0.48,
        comfort: 0.42,
        mastery: 0.56,
        wonder: 0.18
      },
      {
        arousal: 0.32,
        shock: 0.01,
        vigilance: 0.06,
        resolve: 0.48,
        recovery: 0.58
      },
      "open",
      {
        subject_kind: "herd",
        subject_id_or_label: extractSpeciesTags(report.notes)[0],
        novelty: 0.46
      }
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
  revisit_policy: EmotionEpisode["revisit_policy"],
  metadata: Partial<Pick<EmotionEpisode, "subject_kind" | "subject_id_or_label" | "novelty">> = {}
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
    subject_kind: metadata.subject_kind,
    subject_id_or_label: metadata.subject_id_or_label,
    novelty: metadata.novelty,
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
  if (appraisal.connection >= 0.56 && appraisal.comfort >= 0.46) {
    emotions.push("tender");
  }
  if (appraisal.wonder >= 0.68) {
    emotions.push("awed");
  }
  if (appraisal.wonder >= 0.52 && appraisal.curiosity >= 0.48 && regulation.vigilance < 0.28) {
    emotions.push("curious");
  }
  if (appraisal.mastery >= 0.42 && appraisal.connection >= 0.5 && regulation.resolve >= 0.42) {
    emotions.push("protective");
  }
  if (appraisal.connection >= 0.48 && appraisal.wonder >= 0.34 && regulation.shock < 0.12) {
    emotions.push("playful");
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
    return `I can already tell I am near ${humanizeNotablePlace(frame.notable_places[0], "location")}.`;
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

function evolveBondedEntities(
  bonds: EmotionCoreState["bonded_entities"],
  perception: PerceptionFrame,
  now: string
): EmotionCoreState["bonded_entities"] {
  let next = bonds.map((bond) => ({
    ...bond,
    familiarity: clamp(bond.familiarity * (bond.kind === "player" ? 0.998 : 0.999)),
    attachment: clamp(bond.attachment * (bond.kind === "pet" ? 0.999 : 0.998))
  }));

  for (const entity of perception.nearby_entities.filter((entry) => entry.type === "player")) {
    const previous = findBond(next, entity.name, "player");
    next = upsertBondedEntity(next, {
      id: previous?.id ?? `player:${entity.name.toLowerCase()}`,
      kind: "player",
      label: entity.name,
      bond_kind: "familiar",
      familiarity: clamp((previous?.familiarity ?? 0.22) + 0.14),
      attachment: clamp((previous?.attachment ?? 0.14) + 0.1),
      last_meaningful_contact_at: now,
      home_affinity: previous?.home_affinity,
      place_affinity_label: previous?.place_affinity_label
    });
  }

  const babySpecies = firstNearbyBabySpecies(perception);
  if (babySpecies) {
    const previous = findBond(next, `${babySpecies} herd`, "herd") ?? findBond(next, babySpecies, "herd");
    next = upsertBondedEntity(next, {
      id: previous?.id ?? `herd:${babySpecies}`,
      kind: "herd",
      label: previous?.label ?? `${babySpecies} herd`,
      bond_kind: "caretaking",
      familiarity: clamp((previous?.familiarity ?? 0.24) + 0.12),
      attachment: clamp((previous?.attachment ?? 0.18) + 0.1),
      last_meaningful_contact_at: now,
      home_affinity: previous?.home_affinity,
      place_affinity_label: previous?.place_affinity_label
    });
  }

  return trimBondedEntities(next);
}

function nearbyBondSignal(bonds: EmotionCoreState["bonded_entities"], perception: PerceptionFrame): number {
  const nearbyPlayers = perception.nearby_entities.filter((entity) => entity.type === "player");
  const playerSignal = nearbyPlayers.reduce((sum, entity) => {
    const bond = findBond(bonds, entity.name, "player");
    return sum + ((bond?.attachment ?? 0) * 0.55 + (bond?.familiarity ?? 0) * 0.25);
  }, 0);
  const herdSignal = firstNearbyBabySpecies(perception)
    ? bonds
        .filter((bond) => bond.kind === "herd")
        .reduce((sum, bond) => sum + bond.attachment * 0.12, 0)
    : 0;
  return clamp(playerSignal + herdSignal);
}

function wonderMomentSignal(perception: PerceptionFrame, context: EmotionPerceptionContext): number {
  const time = normalizedDayTime(perception.tick_time);
  const dawnBand = time <= 1400 ? clamp((1400 - time) / 1400) : 0;
  const scenicSupport = perception.notable_places.length > 0 || perception.terrain_affordances?.some((entry) => entry.type === "view" || entry.type === "water");
  if (!scenicSupport || perception.weather !== "clear") {
    return 0;
  }
  return clamp(
    dawnBand * 0.62 +
      clamp(perception.light_level / 15) * 0.18 +
      (perception.combat_state.hostilesNearby === 0 ? 0.14 : 0) +
      context.affect.wonder * 0.14
  );
}

function nurtureMomentSignal(perception: PerceptionFrame): number {
  const babyPresent = firstNearbyBabySpecies(perception) ? 0.42 : 0;
  const welfarePressure = clamp(perception.livestock_state.welfareFlags.length * 0.12);
  return clamp(babyPresent + welfarePressure);
}

function inferPerceptionLifeEpisode(
  previous: EmotionCoreState,
  current: EmotionCoreState,
  perception: PerceptionFrame,
  context: EmotionPerceptionContext,
  now: string
): { episode: EmotionEpisode; interrupt?: EmotionInterrupt } | undefined {
  const candidates: Array<{ episode: EmotionEpisode; interrupt?: EmotionInterrupt; salience: number }> = [];
  const softInterruptAllowed = canSoftInterrupt(current);

  const nearbyPlayer = perception.nearby_entities.find((entity) => entity.type === "player");
  if (nearbyPlayer) {
    const previousBond = findBond(previous.bonded_entities, nearbyPlayer.name, "player");
    const currentBond = findBond(current.bonded_entities, nearbyPlayer.name, "player");
    const recentSocial = hasRecentEpisode(current.recent_episodes, ["attachment", "social"], nearbyPlayer.name, now, 1000 * 60 * 18);
    const absenceMs = previousBond ? Math.max(0, Date.parse(now) - Date.parse(previousBond.last_meaningful_contact_at)) : Number.POSITIVE_INFINITY;
    const firstMeeting = !previousBond && Boolean(currentBond);
    const reunion = Boolean(previousBond) && absenceMs >= 1000 * 60 * 60 && !recentSocial;
    if ((firstMeeting || reunion) && currentBond) {
      const trigger = firstMeeting ? "social_contact" : "bonding";
      const episode = buildEpisode(
        "attachment",
        firstMeeting ? `${nearbyPlayer.name} feels like someone new in my world.` : `${nearbyPlayer.name} is back, and that changes the feeling of this place.`,
        now,
        nearbyPlayer.position ?? perception.position,
        compact([firstMeeting ? "meeting" : "reunion", "player", nearbyPlayer.name]),
        {
          threat: 0.03,
          loss: 0.01,
          pain: 0.01,
          curiosity: clamp(0.24 + context.personality.traits.openness * 0.12),
          connection: clamp(0.68 + currentBond.attachment * 0.18),
          comfort: clamp(0.32 + currentBond.familiarity * 0.16),
          mastery: 0.14,
          wonder: clamp(0.18 + (firstMeeting ? 0.18 : 0.08))
        },
        {
          arousal: 0.32,
          shock: 0.01,
          vigilance: 0.08,
          resolve: 0.3,
          recovery: 0.58
        },
        "open",
        {
          subject_kind: "player",
          subject_id_or_label: nearbyPlayer.name,
          novelty: firstMeeting ? 0.94 : 0.62
        }
      );
      candidates.push({
        episode,
        interrupt: softInterruptAllowed
          ? {
              trigger,
              reason: firstMeeting ? "Meeting someone new can justify a brief social turn when the world is safe." : "A meaningful reunion can justify a brief social turn when the world is safe.",
              created_at: now,
              episode_id: episode.id
            }
          : undefined,
        salience: firstMeeting ? 0.82 : 0.66
      });
    }
  }

  const babySpecies = firstNearbyBabySpecies(perception);
  if (babySpecies && !hasRecentEpisode(current.recent_episodes, ["nurture"], babySpecies, now, 1000 * 60 * 20)) {
    const episode = buildEpisode(
      "nurture",
      `There is new ${babySpecies} life nearby, and it makes care feel more urgent.`,
      now,
      perception.home_state.anchor ?? perception.position,
      compact(["birth", babySpecies, "nurture", "care"]),
      {
        threat: 0.04,
        loss: 0.02,
        pain: 0.01,
        curiosity: 0.22,
        connection: clamp(0.56 + context.personality.traits.agreeableness * 0.16),
        comfort: 0.3,
        mastery: 0.44,
        wonder: 0.28
      },
      {
        arousal: 0.36,
        shock: 0.01,
        vigilance: 0.14,
        resolve: 0.44,
        recovery: 0.56
      },
      "open",
      {
        subject_kind: "herd",
        subject_id_or_label: babySpecies,
        novelty: 0.82
      }
    );
    candidates.push({
      episode,
      interrupt: softInterruptAllowed
        ? {
            trigger: "birth",
            reason: "New life in the herd can briefly redirect the next step toward care.",
            created_at: now,
            episode_id: episode.id
          }
        : undefined,
      salience: 0.78
    });
  }

  const wonderSignal = wonderMomentSignal(perception, context);
  const atHome = Boolean(perception.home_state.anchor && distanceBetween(perception.home_state.anchor, perception.position) <= 8);
  const firstHomeSunrise = atHome && !hasEpisodeTag(current.recent_episodes, "first-home-sunrise");
  if (wonderSignal >= 0.56 && !hasRecentEpisode(current.recent_episodes, ["wonder", "beauty", "milestone"], "sunrise", now, 1000 * 60 * 25)) {
    const kind = firstHomeSunrise ? "milestone" : "wonder";
    const cause_tags = compact(["sunrise", "wonder", firstHomeSunrise ? "first-home-sunrise" : undefined]);
    const episode = buildEpisode(
      kind,
      firstHomeSunrise
        ? "Sunrise over home made this place feel like something worth returning to."
        : "The sunrise made the world feel newly alive for a moment.",
      now,
      perception.position,
      cause_tags,
      {
        threat: 0.02,
        loss: 0.01,
        pain: 0.01,
        curiosity: clamp(0.46 + wonderSignal * 0.14),
        connection: atHome ? 0.24 : 0.14,
        comfort: atHome ? 0.38 : 0.24,
        mastery: firstHomeSunrise ? 0.44 : 0.14,
        wonder: clamp(0.72 + wonderSignal * 0.18)
      },
      {
        arousal: 0.32,
        shock: 0.01,
        vigilance: 0.04,
        resolve: firstHomeSunrise ? 0.42 : 0.28,
        recovery: 0.62
      },
      "open",
      {
        subject_kind: firstHomeSunrise ? "place" : "moment",
        subject_id_or_label: firstHomeSunrise ? "home sunrise" : "sunrise",
        novelty: firstHomeSunrise ? 0.9 : 0.74
      }
    );
    candidates.push({
      episode,
      interrupt: softInterruptAllowed
        ? {
            trigger: "wonder",
            reason: "A strong wonder moment can justify a short pause when survival is stable.",
            created_at: now,
            episode_id: episode.id
          }
        : undefined,
      salience: firstHomeSunrise ? 0.8 : 0.7
    });
  }

  const best = candidates.sort((left, right) => right.salience - left.salience)[0];
  return best ? { episode: best.episode, interrupt: best.interrupt } : undefined;
}

function updateBondedEntitiesFromActionReport(
  bonds: EmotionCoreState["bonded_entities"],
  report: ActionReport
): EmotionCoreState["bonded_entities"] {
  let next = [...bonds];
  if (report.status === "completed" && report.intent_type === "tend_livestock") {
    for (const species of extractSpeciesTags(report.notes)) {
      const previous = findBond(next, `${species} herd`, "herd") ?? findBond(next, species, "herd");
      next = upsertBondedEntity(next, {
        id: previous?.id ?? `herd:${species}`,
        kind: "herd",
        label: previous?.label ?? `${species} herd`,
        bond_kind: "caretaking",
        familiarity: clamp((previous?.familiarity ?? 0.24) + 0.1),
        attachment: clamp((previous?.attachment ?? 0.18) + 0.08),
        last_meaningful_contact_at: new Date().toISOString(),
        home_affinity: previous?.home_affinity,
        place_affinity_label: previous?.place_affinity_label
      });
    }
  }
  return trimBondedEntities(next);
}

function canSoftInterrupt(
  core: EmotionCoreState,
  personality?: ResidentPersonalityProfile
): boolean {
  return (
    core.axes.threat <= 0.34 &&
    core.regulation.shock <= 0.2 &&
    core.regulation.vigilance <= 0.46 &&
    (personality?.traits.threat_sensitivity ?? 0.5) <= 0.88
  );
}

function trimBondedEntities(bonds: EmotionCoreState["bonded_entities"]): EmotionCoreState["bonded_entities"] {
  return bonds
    .map((bond) => ({ ...bond }))
    .sort((left, right) => left.attachment + left.familiarity - (right.attachment + right.familiarity))
    .slice(-MAX_BONDED_ENTITIES);
}

function upsertBondedEntity(
  bonds: EmotionCoreState["bonded_entities"],
  bond: BondedEntity
): EmotionCoreState["bonded_entities"] {
  const next = bonds.filter((entry) => entry.id !== bond.id);
  next.push({ ...bond });
  return trimBondedEntities(next);
}

function mergeBondFromReflection(
  bonds: EmotionCoreState["bonded_entities"],
  reflection: DayLifeReflectionResult,
  context: DayLifeReflectionApplyContext
): BondedEntity {
  const bond = reflection.bond!;
  const id = `${bond.kind}:${bond.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const previous = bonds.find((entry) => entry.id === id || (entry.kind === bond.kind && entry.label.toLowerCase() === bond.label.toLowerCase()));
  return {
    id,
    kind: bond.kind,
    label: bond.label,
    bond_kind: bond.bond_kind,
    familiarity: clamp((previous?.familiarity ?? 0.24) + bond.delta_familiarity),
    attachment: clamp((previous?.attachment ?? 0.2) + bond.delta_attachment),
    last_meaningful_contact_at: context.timestamp,
    home_affinity: bond.home_affinity ?? previous?.home_affinity,
    place_affinity_label: reflection.place?.label ?? previous?.place_affinity_label
  };
}

function findMatchingReflectionEpisode(
  core: EmotionCoreState,
  reflection: DayLifeReflectionResult,
  focalLocation: Vec3
): EmotionEpisode | undefined {
  const active = core.active_episode;
  if (!active || active.kind !== reflection.event_kind || active.resolved) {
    return undefined;
  }
  if (reflection.subject?.label && active.subject_id_or_label?.toLowerCase() === reflection.subject.label.toLowerCase()) {
    return active;
  }
  if (reflection.bond?.label && active.subject_id_or_label?.toLowerCase() === reflection.bond.label.toLowerCase()) {
    return active;
  }
  if (active.focal_location && distanceBetween(active.focal_location, focalLocation) <= 6) {
    return active;
  }
  return undefined;
}

function defaultAppraisalForReflection(kind: EmotionEpisode["kind"]): EmotionAppraisal {
  switch (kind) {
    case "death":
      return { threat: 0.88, loss: 0.56, pain: 0.9, curiosity: 0.08, connection: 0.16, comfort: 0.06, mastery: 0.22, wonder: 0.02 };
    case "damage":
    case "combat":
      return { threat: 0.72, loss: 0.22, pain: 0.52, curiosity: 0.12, connection: 0.12, comfort: 0.1, mastery: 0.24, wonder: 0.02 };
    case "loss":
      return { threat: 0.42, loss: 0.62, pain: 0.26, curiosity: 0.12, connection: 0.2, comfort: 0.12, mastery: 0.2, wonder: 0.04 };
    case "social":
    case "attachment":
      return { threat: 0.04, loss: 0.02, pain: 0.01, curiosity: 0.24, connection: 0.72, comfort: 0.42, mastery: 0.2, wonder: 0.18 };
    case "nurture":
      return { threat: 0.04, loss: 0.02, pain: 0.01, curiosity: 0.24, connection: 0.6, comfort: 0.36, mastery: 0.44, wonder: 0.28 };
    case "wonder":
    case "beauty":
      return { threat: 0.04, loss: 0.02, pain: 0.01, curiosity: 0.48, connection: 0.2, comfort: 0.34, mastery: 0.18, wonder: 0.74 };
    case "play":
      return { threat: 0.02, loss: 0.02, pain: 0.01, curiosity: 0.38, connection: 0.44, comfort: 0.32, mastery: 0.18, wonder: 0.28 };
    case "milestone":
    case "achievement":
      return { threat: 0.04, loss: 0.02, pain: 0.01, curiosity: 0.28, connection: 0.3, comfort: 0.38, mastery: 0.64, wonder: 0.26 };
    case "safety":
      return { threat: 0.12, loss: 0.04, pain: 0.06, curiosity: 0.14, connection: 0.22, comfort: 0.58, mastery: 0.32, wonder: 0.08 };
  }
}

function defaultRegulationForReflection(kind: EmotionEpisode["kind"]): EmotionRegulation {
  switch (kind) {
    case "death":
      return { arousal: 0.94, shock: 0.96, vigilance: 0.84, resolve: 0.24, recovery: 0.12 };
    case "damage":
    case "combat":
      return { arousal: 0.76, shock: 0.4, vigilance: 0.72, resolve: 0.32, recovery: 0.18 };
    case "loss":
      return { arousal: 0.46, shock: 0.28, vigilance: 0.4, resolve: 0.28, recovery: 0.26 };
    case "social":
    case "attachment":
      return { arousal: 0.28, shock: 0.02, vigilance: 0.08, resolve: 0.32, recovery: 0.56 };
    case "nurture":
      return { arousal: 0.34, shock: 0.02, vigilance: 0.16, resolve: 0.46, recovery: 0.54 };
    case "wonder":
    case "beauty":
      return { arousal: 0.36, shock: 0.04, vigilance: 0.1, resolve: 0.24, recovery: 0.48 };
    case "play":
      return { arousal: 0.34, shock: 0.02, vigilance: 0.06, resolve: 0.22, recovery: 0.5 };
    case "milestone":
    case "achievement":
      return { arousal: 0.4, shock: 0.04, vigilance: 0.1, resolve: 0.54, recovery: 0.42 };
    case "safety":
      return { arousal: 0.18, shock: 0.02, vigilance: 0.12, resolve: 0.34, recovery: 0.66 };
  }
}

function applyAppraisalPatch(base: EmotionAppraisal, patch: Partial<EmotionAppraisal>): EmotionAppraisal {
  return {
    threat: patch.threat ?? base.threat,
    loss: patch.loss ?? base.loss,
    pain: patch.pain ?? base.pain,
    curiosity: patch.curiosity ?? base.curiosity,
    connection: patch.connection ?? base.connection,
    comfort: patch.comfort ?? base.comfort,
    mastery: patch.mastery ?? base.mastery,
    wonder: patch.wonder ?? base.wonder
  };
}

function applyRegulationPatch(base: EmotionRegulation, patch: Partial<EmotionRegulation>): EmotionRegulation {
  return {
    arousal: patch.arousal ?? base.arousal,
    shock: patch.shock ?? base.shock,
    vigilance: patch.vigilance ?? base.vigilance,
    resolve: patch.resolve ?? base.resolve,
    recovery: patch.recovery ?? base.recovery
  };
}

function revisitPolicyForReflection(
  kind: EmotionEpisode["kind"],
  appraisal: Partial<EmotionAppraisal>,
  explicit?: EmotionEpisode["revisit_policy"]
): EmotionEpisode["revisit_policy"] {
  if (explicit) {
    return explicit;
  }
  if (kind === "death" || kind === "damage" || kind === "combat" || kind === "loss") {
    return (appraisal.threat ?? 0) > 0.68 ? "avoid" : "cautious";
  }
  return "open";
}

function isHardInterrupt(trigger: EmotionInterrupt["trigger"]): boolean {
  return trigger === "death" || trigger === "respawn";
}

function chooseStrongerInterrupt(
  current: EmotionInterrupt | undefined,
  candidate: EmotionInterrupt
): EmotionInterrupt {
  if (!current) {
    return candidate;
  }
  const currentPriority = interruptPriority(current.trigger);
  const candidatePriority = interruptPriority(candidate.trigger);
  if (candidatePriority > currentPriority) {
    return candidate;
  }
  if (candidatePriority < currentPriority) {
    return current;
  }
  return candidate;
}

function interruptPriority(trigger: EmotionInterrupt["trigger"]): number {
  switch (trigger) {
    case "death":
      return 4;
    case "respawn":
      return 3;
    case "birth":
      return 2;
    case "social_contact":
    case "bonding":
    case "wonder":
      return 1;
  }
}

function mergeDominantEmotions(primary: string[], fallback: string[]): string[] {
  return [...new Set([...primary, ...fallback].map((entry) => entry.trim()).filter(Boolean))].slice(0, 4);
}

function findBond(
  bonds: EmotionCoreState["bonded_entities"],
  label: string,
  kind?: BondedEntity["kind"]
): BondedEntity | undefined {
  const target = label.trim().toLowerCase();
  return bonds.find((bond) => bond.label.trim().toLowerCase() === target && (!kind || bond.kind === kind));
}

function countNearbyBondedEntities(
  bonds: EmotionCoreState["bonded_entities"],
  frame: PerceptionFrame,
  kind: BondedEntity["kind"]
): number {
  if (kind === "player") {
    return frame.nearby_entities.filter((entity) => entity.type === "player" && findBond(bonds, entity.name, "player")).length;
  }
  if (kind === "herd") {
    const species = firstNearbyBabySpecies(frame);
    return species && findBond(bonds, `${species} herd`, "herd") ? 1 : 0;
  }
  return 0;
}

function firstNearbyBabySpecies(perception: PerceptionFrame): string | undefined {
  const baby = perception.nearby_entities.find((entity) => entity.type === "passive" && entity.isBaby);
  return baby ? speciesFromEntityName(baby.name) : undefined;
}

function speciesFromEntityName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("chicken")) {
    return "chicken";
  }
  if (lower.includes("sheep")) {
    return "sheep";
  }
  if (lower.includes("cow")) {
    return "cow";
  }
  if (lower.includes("pig")) {
    return "pig";
  }
  if (lower.includes("wolf") || lower.includes("dog")) {
    return "wolf";
  }
  if (lower.includes("cat")) {
    return "cat";
  }
  return lower.replace(/\s+/g, "_");
}

function extractSpeciesTags(notes: string[]): string[] {
  const species = new Set<string>();
  for (const note of notes) {
    for (const candidate of ["chicken", "sheep", "cow", "pig", "wolf", "cat"]) {
      if (note.toLowerCase().includes(candidate)) {
        species.add(candidate);
      }
    }
  }
  return [...species];
}

function firstCapitalizedWord(note: string | undefined): string | undefined {
  if (!note) {
    return undefined;
  }
  return note
    .split(/\s+/)
    .find((word) => /^[A-Z][a-z]/.test(word))
    ?.replace(/[^A-Za-z]/g, "");
}

function comfortAtLocation(
  places: EmotionCoreState["tagged_places"],
  location: Vec3
): number | undefined {
  const comfortSite = places
    .filter((place) => place.kind === "comfort_site")
    .sort((left, right) => distanceBetween(left.location, location) - distanceBetween(right.location, location))[0];
  if (!comfortSite) {
    return undefined;
  }
  return clamp(1 - Math.min(1, distanceBetween(comfortSite.location, location) / 24));
}

function hasRecentEpisode(
  episodes: EmotionEpisode[],
  kinds: EmotionEpisode["kind"][],
  subjectHint: string | undefined,
  now: string,
  windowMs: number
): boolean {
  const nowMs = Date.parse(now);
  return episodes.some((episode) => {
    if (!kinds.includes(episode.kind)) {
      return false;
    }
    if (nowMs - Date.parse(episode.updated_at) > windowMs) {
      return false;
    }
    if (!subjectHint) {
      return true;
    }
    const hint = subjectHint.toLowerCase();
    return (
      episode.subject_id_or_label?.toLowerCase().includes(hint) ||
      episode.summary.toLowerCase().includes(hint) ||
      episode.cause_tags.some((tag) => tag.toLowerCase().includes(hint))
    );
  });
}

function hasEpisodeTag(episodes: EmotionEpisode[], tag: string): boolean {
  const target = tag.toLowerCase();
  return episodes.some((episode) => episode.cause_tags.some((cause) => cause.toLowerCase() === target));
}

function normalizedDayTime(tickTime: number): number {
  const time = tickTime % 24000;
  return time < 0 ? time + 24000 : time;
}

function intensityFrom(appraisal: EmotionAppraisal, regulation: EmotionRegulation): number {
  const threatSalience = (appraisal.threat + appraisal.loss + appraisal.pain + regulation.shock + regulation.arousal) / 5;
  const lifeSalience =
    (appraisal.curiosity +
      appraisal.connection +
      appraisal.comfort +
      appraisal.mastery +
      appraisal.wonder +
      regulation.resolve +
      regulation.recovery) /
    7;
  return clamp(Math.max(threatSalience, lifeSalience * 0.9));
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
    bonded_entities: core.bonded_entities.map((bond) => ({ ...bond })),
    pending_interrupt: core.pending_interrupt ? { ...core.pending_interrupt } : undefined
  };
}

function compact(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function blend(current: number, target: number, rate: number): number {
  return clamp(current + (target - current) * rate);
}
