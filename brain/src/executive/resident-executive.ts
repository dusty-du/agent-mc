import {
  BuildIntent,
  MemoryState,
  OvernightConsolidation,
  PerceptionFrame,
  ReplanTrigger,
  ValueProfile
} from "@resident/shared";
import { WakeBrain, WakeBrainDecision } from "../wake-brain";
import { CraftPlanner } from "../planning/craft-planner";
import { SemanticBuildPlanner } from "../planning/build-planner";
import { ExecutivePlanner, ExecutiveSuggestion } from "./openai-executive";

export class ResidentExecutive {
  private readonly wakeBrain = new WakeBrain();
  private readonly craftPlanner = new CraftPlanner();
  private readonly buildPlanner = new SemanticBuildPlanner();

  constructor(private readonly planner?: ExecutivePlanner) {}

  async decide(
    frame: PerceptionFrame,
    memory: MemoryState,
    values: ValueProfile,
    overnight: OvernightConsolidation | undefined,
    trigger: ReplanTrigger
  ): Promise<WakeBrainDecision> {
    const heuristic = this.wakeBrain.decide(frame, memory, values, overnight, trigger);
    if (!this.planner || shouldKeepHeuristic(heuristic)) {
      return heuristic;
    }

    const suggestion = await this.planner.suggest({
      trigger,
      perception: frame,
      memory: heuristic.memory,
      values,
      overnight,
      heuristicIntent: heuristic.intent
    });

    if (!suggestion) {
      return heuristic;
    }

    return this.applySuggestion(frame, heuristic, suggestion);
  }

  private applySuggestion(frame: PerceptionFrame, heuristic: WakeBrainDecision, suggestion: ExecutiveSuggestion): WakeBrainDecision {
    const next: WakeBrainDecision = {
      ...heuristic,
      intent: {
        ...suggestion.intent,
        agent_id: frame.agent_id,
        trigger: heuristic.intent.trigger
      },
      observations: suggestion.observation ? [...heuristic.observations, suggestion.observation] : heuristic.observations,
      recallQuery: suggestion.recallQuery ?? heuristic.recallQuery
    };

    if (suggestion.craftTarget) {
      next.craftGoal = this.craftPlanner.plan(
        suggestion.craftTarget.item,
        suggestion.craftTarget.quantity ?? 1,
        suggestion.craftTarget.purpose,
        frame
      );
      next.intent.target = next.craftGoal.target_item;
      next.intent.intent_type = "craft";
      next.intent.success_conditions = [`${next.craftGoal.quantity} ${next.craftGoal.target_item} crafted`];
    }

    if (suggestion.buildIntent) {
      const buildIntent: BuildIntent = {
        ...suggestion.buildIntent,
        site: suggestion.buildIntent.site.center || suggestion.buildIntent.site.radius || suggestion.buildIntent.site.footprint
          ? suggestion.buildIntent.site
          : { center: frame.home_state.anchor ?? frame.position, radius: 10 }
      };
      next.buildPlan = this.buildPlanner.plan(buildIntent, frame);
      next.intent.intent_type = buildIntent.rebuild_of ? "rebuild" : "build";
      next.intent.target = buildIntent.purpose;
      next.intent.success_conditions = next.buildPlan.completion_checks;
    }

    return next;
  }
}

function shouldKeepHeuristic(decision: WakeBrainDecision): boolean {
  return (
    decision.intent.priority <= 2 ||
    ["eat", "sleep", "retreat", "fight", "recover"].includes(decision.intent.intent_type)
  );
}
