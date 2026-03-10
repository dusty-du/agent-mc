import {
  AgentIntent,
  BuildIntent,
  MemoryObservation,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  RecallQuery,
  ReplanTrigger,
  ValueProfile
} from "@resident/shared";

export interface ExecutiveSuggestion {
  intent: AgentIntent;
  observation?: MemoryObservation;
  buildIntent?: BuildIntent;
  craftTarget?: { item: string; purpose: string; quantity?: number };
  recallQuery?: RecallQuery;
}

export interface ExecutivePlannerInput {
  trigger: ReplanTrigger;
  perception: PerceptionFrame;
  memory: MemoryState;
  values: ValueProfile;
  overnight?: OvernightConsolidation;
  heuristicIntent: AgentIntent;
}

export interface ExecutivePlanner {
  suggest(input: ExecutivePlannerInput): Promise<ExecutiveSuggestion | undefined>;
}

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export class OpenAIExecutivePlanner implements ExecutivePlanner {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.RESIDENT_OPENAI_MODEL ?? "gpt-4.1-mini",
    private readonly baseUrl = process.env.RESIDENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ) {}

  async suggest(input: ExecutivePlannerInput): Promise<ExecutiveSuggestion | undefined> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        max_output_tokens: 500,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are choosing the next action for an autonomous Minecraft resident. " +
                  "Respect survival floors first: avoid lethal danger, eat when needed, sleep nightly, do not grief, and respect protected areas. " +
                  "Stay consistent with the resident's personality, current routine phase, unmet needs, and recent failed actions. " +
                  "Use real Minecraft survival priorities: wood, tools, shelter, light, food, then bed. " +
                  "Happiness is not a scoreboard; failure can still belong to a good life. " +
                  "Return only strict JSON."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  trigger: input.trigger,
                  heuristic_intent: input.heuristicIntent,
                  perception: {
                    tick_time: input.perception.tick_time,
                    position: input.perception.position,
                    weather: input.perception.weather,
                    health: input.perception.health,
                    hunger: input.perception.hunger,
                    home_state: input.perception.home_state,
                    pantry_state: input.perception.pantry_state,
                    livestock_state: input.perception.livestock_state,
                    combat_state: input.perception.combat_state,
                    notable_places: input.perception.notable_places,
                    nearby_entities: input.perception.nearby_entities
                  },
                  memory: {
                    personality_profile: input.memory.personality_profile,
                    self_name: input.memory.self_name,
                    need_state: input.memory.need_state,
                    mind_state: input.memory.mind_state,
                    bootstrap_progress: input.memory.bootstrap_progress,
                    emotion_core: {
                      dominant_emotions: input.memory.emotion_core.dominant_emotions,
                      axes: input.memory.emotion_core.axes,
                      regulation: input.memory.emotion_core.regulation,
                      action_biases: input.memory.emotion_core.action_biases,
                      active_episode: input.memory.emotion_core.active_episode
                        ? {
                            kind: input.memory.emotion_core.active_episode.kind,
                            summary: input.memory.emotion_core.active_episode.summary,
                            cause_tags: input.memory.emotion_core.active_episode.cause_tags,
                            focal_location: input.memory.emotion_core.active_episode.focal_location,
                            respawn_location: input.memory.emotion_core.active_episode.respawn_location,
                            subject_kind: input.memory.emotion_core.active_episode.subject_kind,
                            subject_id_or_label: input.memory.emotion_core.active_episode.subject_id_or_label,
                            novelty: input.memory.emotion_core.active_episode.novelty,
                            inventory_loss: input.memory.emotion_core.active_episode.inventory_loss,
                            intensity: input.memory.emotion_core.active_episode.intensity,
                            revisit_policy: input.memory.emotion_core.active_episode.revisit_policy,
                            resolved: input.memory.emotion_core.active_episode.resolved
                          }
                        : undefined,
                      tagged_places: input.memory.emotion_core.tagged_places,
                      bonded_entities: input.memory.emotion_core.bonded_entities,
                      pending_interrupt: input.memory.emotion_core.pending_interrupt
                    },
                    current_goals: input.memory.current_goals,
                    carry_over_commitments: input.memory.carry_over_commitments,
                    recent_dangers: input.memory.recent_dangers,
                    recent_action_snapshots: input.memory.recent_action_snapshots,
                    self_narrative: input.memory.self_narrative,
                    place_tags: input.memory.place_tags
                  },
                  overnight: input.overnight
                    ? {
                        ...input.overnight,
                        emotional_themes: input.overnight.emotional_themes
                      }
                    : undefined,
                  values: input.values,
                  schema: {
                    intent: {
                      intent_type:
                        "one of move, observe, eat, sleep, gather, mine, craft, smelt, build, rebuild, repair, store, farm, tend_livestock, socialize, retreat, fight, recover",
                      target: "optional string or vec3-like object",
                      reason: "string",
                      priority: "number 1-5",
                      cancel_conditions: ["string"],
                      success_conditions: ["string"],
                      dialogue: "optional string"
                    },
                    observation: {
                      summary: "string",
                      tags: ["string"],
                      category: "event category"
                    },
                    build_intent: {
                      purpose: "string",
                      style_tags: ["string"],
                      functional_requirements: ["string"],
                      aesthetic_goals: ["string"],
                      materials_preference: ["string"],
                      expandable: "boolean",
                      rebuild_of: "optional string"
                    },
                    craft_target: {
                      item: "craftable item name",
                      purpose: "why it matters",
                      quantity: "optional integer"
                    },
                    recall_query: {
                      query: "string",
                      tags: ["string"]
                    }
                  }
                })
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as OpenAIResponse;
    const payload = extractOutputText(body);
    if (!payload) {
      return undefined;
    }

    const parsed = JSON.parse(payload) as {
      intent: AgentIntent;
      observation?: { summary: string; tags: string[]; category: MemoryObservation["category"] };
      build_intent?: Omit<BuildIntent, "site"> & { site?: BuildIntent["site"] };
      craft_target?: { item: string; purpose: string; quantity?: number };
      recall_query?: RecallQuery;
    };

    return {
      intent: parsed.intent,
      observation: parsed.observation
        ? {
            timestamp: new Date().toISOString(),
            category: parsed.observation.category,
            summary: parsed.observation.summary,
            tags: parsed.observation.tags,
            importance: 0.5,
            source: "reflection"
          }
        : undefined,
      buildIntent: parsed.build_intent
        ? {
            ...parsed.build_intent,
            site: parsed.build_intent.site ?? {}
          }
        : undefined,
      craftTarget: parsed.craft_target,
      recallQuery: parsed.recall_query
    };
  }
}

export function createOpenAIExecutivePlannerFromEnv(): OpenAIExecutivePlanner | undefined {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }
  return new OpenAIExecutivePlanner(apiKey);
}

function extractOutputText(body: OpenAIResponse): string | undefined {
  if (body.output_text) {
    return body.output_text;
  }
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) {
        return content.text;
      }
    }
  }
  return undefined;
}
