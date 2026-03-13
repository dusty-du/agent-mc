import {
  ConsolidationRecord,
  CultureSignal,
  DailyOutcome,
  DayLifeReflectionInput,
  DayLifeReflectionObservation,
  DayLifeReflectionResult,
  DayLifeReflectionRecord,
  MemoryBundle
} from "@resident/shared";
import {
  ReflectiveConsolidator,
  SleepConsolidationError,
  SleepConsolidationInput,
  SleepConsolidationResult
} from "./sleep-core";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

type FunctionToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const DAY_REFLECTION_FUNCTION_NAME = "submit_day_reflection";
const OVERNIGHT_CONSOLIDATION_FUNCTION_NAME = "submit_overnight_consolidation";

const DAY_REFLECTION_TOOL: FunctionToolDefinition = {
  name: DAY_REFLECTION_FUNCTION_NAME,
  description: "Return a structured daytime life reflection patch for one salient event.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      event_kind: {
        type: "string",
        enum: ["death", "damage", "combat", "loss", "beauty", "social", "attachment", "nurture", "wonder", "play", "milestone", "achievement", "safety"]
      },
      salience: { type: "number", minimum: 0, maximum: 1 },
      dominant_emotions: {
        type: "array",
        items: { type: "string" }
      },
      appraisal: numericPatchSchema([
        "threat",
        "loss",
        "pain",
        "curiosity",
        "connection",
        "comfort",
        "mastery",
        "wonder"
      ]),
      regulation: numericPatchSchema(["arousal", "shock", "vigilance", "resolve", "recovery"]),
      action_biases: numericPatchSchema([
        "avoid_risk",
        "seek_shelter",
        "seek_recovery",
        "seek_company",
        "seek_mastery",
        "seek_wonder",
        "cautious_revisit"
      ]),
      subject: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["player", "pet", "herd", "place", "moment"] },
          label: { type: "string" }
        },
        required: ["kind", "label"]
      },
      place: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["death_site", "comfort_site", "awe_site", "nursery_site", "bond_site"] },
          label: { type: "string" },
          location: vec3Schema(),
          world: { type: "string" },
          salience: { type: "number", minimum: 0, maximum: 1 },
          revisit_policy: { type: "string", enum: ["avoid", "cautious", "open"] }
        },
        required: ["kind", "label", "location"]
      },
      bond: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["player", "pet", "herd"] },
          label: { type: "string" },
          bond_kind: { type: "string", enum: ["familiar", "companion", "caretaking"] },
          delta_familiarity: { type: "number", minimum: 0, maximum: 1 },
          delta_attachment: { type: "number", minimum: 0, maximum: 1 },
          home_affinity: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["kind", "label", "bond_kind", "delta_familiarity", "delta_attachment"]
      },
      interrupt: {
        type: "object",
        additionalProperties: false,
        properties: {
          trigger: { type: "string", enum: ["death", "respawn", "social_contact", "bonding", "birth", "wonder"] },
          reason: { type: "string" }
        },
        required: ["trigger", "reason"]
      },
      observation: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: [
              "discovery",
              "food",
              "crafting",
              "building",
              "rebuild",
              "livestock",
              "combat",
              "social",
              "beauty",
              "sleep",
              "danger",
              "recovery",
              "orientation",
              "project",
              "weather",
              "hospitality"
            ]
          },
          summary: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" }
          },
          importance: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["category", "summary", "tags", "importance"]
      }
    },
    required: ["summary", "event_kind", "salience", "dominant_emotions", "appraisal", "regulation"]
  }
};

const OVERNIGHT_CONSOLIDATION_TOOL: FunctionToolDefinition = {
  name: OVERNIGHT_CONSOLIDATION_FUNCTION_NAME,
  description: "Return a structured overnight consolidation summary for the resident's next day.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      insights: { type: "array", items: { type: "string" } },
      risk_themes: { type: "array", items: { type: "string" } },
      emotional_themes: { type: "array", items: { type: "string" } },
      place_memories: { type: "array", items: { type: "string" } },
      project_memories: { type: "array", items: { type: "string" } },
      creative_motifs: { type: "array", items: { type: "string" } }
    },
    required: [
      "summary",
      "insights",
      "risk_themes",
      "emotional_themes",
      "place_memories",
      "project_memories",
      "creative_motifs"
    ]
  }
};

export class OpenAIReflectiveConsolidator implements ReflectiveConsolidator {
  constructor(
    private readonly apiKey: string,
    public readonly modelName: string,
    private readonly baseUrl = process.env.RESIDENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ) {}

  async synthesize(input: SleepConsolidationInput): Promise<SleepConsolidationResult> {
    return this.requestStructuredArguments<SleepConsolidationResult>(
      [
        "You are the reflective autobiographical core for an autonomous Minecraft resident.",
        "Perform overnight consolidation only.",
        "Use the daytime reflection records as same-day meaning traces, then compress them into stable next-day themes.",
        "Do not plan wake-time actions and do not invent new commitments.",
        "Preserve meaning, safety, hospitality, home, beauty, bonding, nurture, wonder, and recovery.",
        "Use the function schema exactly."
      ].join(" "),
      buildOvernightPayload(input),
      OVERNIGHT_CONSOLIDATION_TOOL
    );
  }

  async reflectDay(input: DayLifeReflectionInput): Promise<DayLifeReflectionResult> {
    return this.requestStructuredArguments<DayLifeReflectionResult>(
      [
        "You are the reflective life-core for an autonomous Minecraft resident during the awake loop.",
        "Appraise one salient event that already happened and return an emotional patch, not a plan.",
        "You may strengthen or contextualize emotions, bonds, and places, and you may suggest an interrupt when the moment deserves follow-up.",
        "If you suggest an interrupt, the trigger must be exactly one of: death, respawn, social_contact, bonding, birth, wonder.",
        "Do not choose actions, do not create commitments, and do not rewrite full memory.",
        "Use the function schema exactly."
      ].join(" "),
      buildDayReflectionPayload(input),
      DAY_REFLECTION_TOOL
    );
  }

  private async requestStructuredArguments<T>(
    systemPrompt: string,
    payload: Record<string, unknown>,
    tool: FunctionToolDefinition
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        max_output_tokens: 900,
        tools: [
          {
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        ],
        tool_choice: {
          type: "function",
          name: tool.name
        },
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPrompt
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(payload)
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new SleepConsolidationError(`Reflective model request failed with status ${response.status}.`, this.modelName);
    }

    const body = (await response.json()) as OpenAIResponse;
    const functionCall = extractFunctionCall(body, tool.name);
    if (!functionCall.found) {
      const diagnostic = diagnosticSuffix(body);
      if (functionCall.kind === "wrong_name") {
        throw new SleepConsolidationError(
          `Reflective model returned function call "${functionCall.name}" instead of "${tool.name}".${diagnostic}`,
          this.modelName,
          body
        );
      }
      throw new SleepConsolidationError(
        `Reflective model returned no function call for "${tool.name}".${diagnostic}`,
        this.modelName,
        body
      );
    }

    try {
      return JSON.parse(functionCall.arguments) as T;
    } catch (error) {
      throw new SleepConsolidationError(
        `Reflective model returned invalid function arguments JSON for "${tool.name}".${diagnosticSuffix(body)}`,
        this.modelName,
        error
      );
    }
  }
}

export function createOpenAIReflectiveConsolidatorFromEnv(): OpenAIReflectiveConsolidator {
  const model = process.env.RESIDENT_REFLECTIVE_OPENAI_MODEL?.trim();
  if (!model) {
    throw new SleepConsolidationError("RESIDENT_REFLECTIVE_OPENAI_MODEL is required for reflective-core startup.");
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new SleepConsolidationError(
      "RESIDENT_REFLECTIVE_OPENAI_MODEL is set but OPENAI_API_KEY is missing.",
      model
    );
  }

  return new OpenAIReflectiveConsolidator(apiKey, model);
}

function buildOvernightPayload(input: SleepConsolidationInput): {
  bundle: MemoryBundle;
  outcome: DailyOutcome;
  recent_culture_signals: CultureSignal[];
  recent_day_reflections: Array<{
    created_at: string;
    trigger: string;
    summary: string;
    event_kind: string;
    dominant_emotions: string[];
  }>;
  recent_consolidations: Array<{
    day_number: number;
    summary: string;
    insights: string[];
    emotional_themes: string[];
    project_memories: string[];
    place_memories: string[];
  }>;
  schema: Record<string, unknown>;
} {
  return {
    bundle: input.bundle,
    outcome: input.outcome,
    recent_culture_signals: input.recentCultureSignals,
    recent_day_reflections: input.recentDayReflections.map((record) => ({
      created_at: record.created_at,
      trigger: record.trigger,
      summary: record.summary,
      event_kind: record.result.event_kind,
      dominant_emotions: record.result.dominant_emotions
    })),
    recent_consolidations: input.recentConsolidations.map((record: ConsolidationRecord) => ({
      day_number: record.dayNumber,
      summary: record.summary,
      insights: record.insights,
      emotional_themes: record.overnight.emotional_themes,
      project_memories: record.overnight.project_memories,
      place_memories: record.overnight.place_memories
    })),
    schema: {
      summary: "string",
      insights: ["string"],
      risk_themes: ["string"],
      emotional_themes: ["string"],
      place_memories: ["string"],
      project_memories: ["string"],
      creative_motifs: ["string"]
    }
  };
}

function buildDayReflectionPayload(input: DayLifeReflectionInput): {
  trigger: string;
  previous_perception: DayLifeReflectionInput["previousPerception"];
  current_perception: DayLifeReflectionInput["currentPerception"];
  report?: DayLifeReflectionInput["report"];
  memory: DayLifeReflectionInput["memory"];
  overnight?: DayLifeReflectionInput["overnight"];
  recent_observations: DayLifeReflectionObservation[];
  recent_action_snapshot?: DayLifeReflectionInput["recentActionSnapshot"];
  latest_day_reflections: Array<{
    created_at: string;
    trigger: string;
    summary: string;
    dominant_emotions: string[];
  }>;
  schema: Record<string, unknown>;
} {
  return {
    trigger: input.trigger,
    previous_perception: input.previousPerception,
    current_perception: input.currentPerception,
    report: input.report,
    memory: input.memory,
    overnight: input.overnight,
    recent_observations: input.recentObservations.map((observation) => ({
      category: observation.category,
      summary: observation.summary,
      tags: observation.tags,
      importance: observation.importance
    })),
    recent_action_snapshot: input.recentActionSnapshot,
    latest_day_reflections: input.latestDayReflections.map((record: DayLifeReflectionRecord) => ({
      created_at: record.created_at,
      trigger: record.trigger,
      summary: record.summary,
      dominant_emotions: record.result.dominant_emotions
    })),
    schema: {
      summary: "string",
      event_kind: "death | damage | combat | loss | beauty | social | attachment | nurture | wonder | play | milestone | achievement | safety",
      salience: "number 0..1",
      dominant_emotions: ["string"],
      appraisal: {
        threat: "number 0..1",
        loss: "number 0..1",
        pain: "number 0..1",
        curiosity: "number 0..1",
        connection: "number 0..1",
        comfort: "number 0..1",
        mastery: "number 0..1",
        wonder: "number 0..1"
      },
      regulation: {
        arousal: "number 0..1",
        shock: "number 0..1",
        vigilance: "number 0..1",
        resolve: "number 0..1",
        recovery: "number 0..1"
      },
      action_biases: {
        avoid_risk: "number 0..1",
        seek_shelter: "number 0..1",
        seek_recovery: "number 0..1",
        seek_company: "number 0..1",
        seek_mastery: "number 0..1",
        seek_wonder: "number 0..1",
        cautious_revisit: "number 0..1"
      },
      subject: {
        kind: "player | pet | herd | place | moment",
        label: "string"
      },
      place: {
        kind: "death_site | comfort_site | awe_site | nursery_site | bond_site",
        label: "string",
        location: { x: "number", y: "number", z: "number" },
        world: "string",
        salience: "number 0..1",
        revisit_policy: "avoid | cautious | open"
      },
      bond: {
        kind: "player | pet | herd",
        label: "string",
        bond_kind: "familiar | companion | caretaking",
        delta_familiarity: "number 0..1",
        delta_attachment: "number 0..1",
        home_affinity: "number 0..1"
      },
      interrupt: {
        trigger: "death | respawn | social_contact | bonding | birth | wonder",
        reason: "string"
      },
      observation: {
        category: "discovery | food | crafting | building | rebuild | livestock | combat | social | beauty | sleep | danger | recovery | orientation | project | weather | hospitality",
        summary: "string",
        tags: ["string"],
        importance: "number 0..1"
      }
    }
  };
}

function numericPatchSchema(keys: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(keys.map((key) => [key, { type: "number", minimum: 0, maximum: 1 }]))
  };
}

function vec3Schema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      z: { type: "number" }
    },
    required: ["x", "y", "z"]
  };
}

function extractFunctionCall(
  body: OpenAIResponse,
  expectedName: string
):
  | { found: true; arguments: string }
  | { found: false; kind: "missing" }
  | { found: false; kind: "wrong_name"; name: string } {
  let wrongName: string | undefined;
  for (const item of body.output ?? []) {
    if (item.type !== "function_call") {
      continue;
    }
    if (item.name === expectedName && typeof item.arguments === "string") {
      return { found: true, arguments: item.arguments };
    }
    if (item.name) {
      wrongName = item.name;
    }
  }
  if (wrongName) {
    return { found: false, kind: "wrong_name", name: wrongName };
  }
  return { found: false, kind: "missing" };
}

function diagnosticSuffix(body: OpenAIResponse): string {
  const text = collectOutputText(body);
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  return ` Output text: ${JSON.stringify(compact.slice(0, 160))}.`;
}

function collectOutputText(body: OpenAIResponse): string {
  const chunks: string[] = [];
  if (body.output_text) {
    chunks.push(body.output_text);
  }
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n");
}
