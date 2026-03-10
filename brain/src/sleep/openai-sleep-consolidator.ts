import {
  ConsolidationRecord,
  CultureSignal,
  DailyOutcome,
  MemoryBundle
} from "@resident/shared";
import {
  SleepConsolidationError,
  SleepConsolidationInput,
  SleepConsolidationResult,
  SleepConsolidator
} from "./sleep-core";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export class OpenAISleepConsolidator implements SleepConsolidator {
  constructor(
    private readonly apiKey: string,
    public readonly modelName: string,
    private readonly baseUrl = process.env.RESIDENT_OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ) {}

  async synthesize(input: SleepConsolidationInput): Promise<SleepConsolidationResult> {
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        max_output_tokens: 900,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are sleep-core for an autonomous Minecraft resident. " +
                  "Perform overnight autobiographical consolidation only. " +
                  "The bundle includes personality, current needs, recent action snapshots, and bootstrap progress. " +
                  "Do not plan wake-time actions and do not invent new commitments. " +
                  "Preserve meaning, safety, hospitality, home, and beauty. " +
                  "Return only strict JSON."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(buildPayload(input))
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new SleepConsolidationError(
        `Sleep consolidation request failed with status ${response.status}.`,
        this.modelName
      );
    }

    const body = (await response.json()) as OpenAIResponse;
    const payload = extractOutputText(body);
    if (!payload) {
      throw new SleepConsolidationError("Sleep consolidation returned no output text.", this.modelName);
    }

    try {
      return JSON.parse(payload) as SleepConsolidationResult;
    } catch (error) {
      throw new SleepConsolidationError("Sleep consolidation returned invalid JSON.", this.modelName, error);
    }
  }
}

export function createOpenAISleepConsolidatorFromEnv(): OpenAISleepConsolidator {
  const model = process.env.RESIDENT_SLEEP_OPENAI_MODEL?.trim();
  if (!model) {
    throw new SleepConsolidationError("RESIDENT_SLEEP_OPENAI_MODEL is required for sleep-core startup.");
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new SleepConsolidationError(
      "RESIDENT_SLEEP_OPENAI_MODEL is set but OPENAI_API_KEY is missing.",
      model
    );
  }

  return new OpenAISleepConsolidator(apiKey, model);
}

function buildPayload(input: SleepConsolidationInput): {
  bundle: MemoryBundle;
  outcome: DailyOutcome;
  recent_culture_signals: CultureSignal[];
  recent_consolidations: Array<{
    day_number: number;
    summary: string;
    insights: string[];
    project_memories: string[];
    place_memories: string[];
  }>;
  schema: Record<string, unknown>;
} {
  return {
    bundle: input.bundle,
    outcome: input.outcome,
    recent_culture_signals: input.recentCultureSignals,
    recent_consolidations: input.recentConsolidations.map((record: ConsolidationRecord) => ({
      day_number: record.dayNumber,
      summary: record.summary,
      insights: record.insights,
      project_memories: record.overnight.project_memories,
      place_memories: record.overnight.place_memories
    })),
    schema: {
      summary: "string",
      insights: ["string"],
      risk_themes: ["string"],
      place_memories: ["string"],
      project_memories: ["string"],
      creative_motifs: ["string"]
    }
  };
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
