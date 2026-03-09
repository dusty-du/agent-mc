import { ActionReport, AgentIntent, BuildPlan, CraftGoal, PerceptionFrame } from "@resident/shared";

export interface MineflayerDriver {
  collectPerception(): Promise<PerceptionFrame>;
  executeIntent(intent: AgentIntent, context?: IntentExecutionContext): Promise<ActionReport>;
}

export interface IntentExecutionContext {
  craftGoal?: CraftGoal;
  buildPlan?: BuildPlan;
}

export interface BotTickResult {
  perception: PerceptionFrame;
  report?: ActionReport;
}

export class ResidentBotRuntime {
  constructor(private readonly driver: MineflayerDriver) {}

  async tick(intent?: AgentIntent, context?: IntentExecutionContext): Promise<BotTickResult> {
    let report: ActionReport | undefined;
    if (intent) {
      report = await this.driver.executeIntent(intent, context);
    }
    return {
      report,
      perception: await this.driver.collectPerception()
    };
  }
}
