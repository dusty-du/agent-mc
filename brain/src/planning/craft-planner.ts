import { CraftGoal, CraftStep, PerceptionFrame } from "@resident/shared";
import minecraftData from "minecraft-data";

type RecipeLike = {
  ingredients?: Array<number | { id: number; count?: number }>;
  inShape?: Array<Array<number | { id: number; count?: number } | null>>;
  result?: { id: number; count?: number };
};

function normalizeIngredient(ingredient: number | { id: number; count?: number } | null | undefined): { id: number; count?: number } | undefined {
  if (ingredient === null || ingredient === undefined) {
    return undefined;
  }
  if (typeof ingredient === "number") {
    return { id: ingredient, count: 1 };
  }
  return ingredient;
}

function aggregateIngredients(recipe: RecipeLike): Record<number, number> {
  const totals = new Map<number, number>();
  const add = (id: number, count = 1) => totals.set(id, (totals.get(id) ?? 0) + count);

  for (const ingredient of recipe.ingredients ?? []) {
    const normalized = normalizeIngredient(ingredient);
    if (normalized) {
      add(normalized.id, normalized.count ?? 1);
    }
  }

  for (const row of recipe.inShape ?? []) {
    for (const ingredient of row) {
      const normalized = normalizeIngredient(ingredient);
      if (normalized) {
        add(normalized.id, normalized.count ?? 1);
      }
    }
  }

  return Object.fromEntries(totals.entries());
}

function inferStation(recipe: RecipeLike): CraftStep["station"] {
  if (recipe.inShape && recipe.inShape.some((row) => row.length > 2)) {
    return "crafting_table";
  }
  return "hand";
}

export class CraftPlanner {
  constructor(private readonly version = "1.20.4") {}

  plan(targetItem: string, quantity: number, purpose: string, perception?: PerceptionFrame): CraftGoal {
    const data = minecraftData(this.version);
    const item = data.itemsByName[targetItem];
    if (!item) {
      throw new Error(`Unknown item '${targetItem}' for Minecraft ${this.version}.`);
    }

    const visited = new Set<number>();
    const available = { ...(perception?.inventory ?? {}) };
    const steps = this.expandRecipe(item.id, quantity, visited, data, available);
    const missingInputs = this.calculateMissingInputs(steps, perception?.inventory ?? {});
    const requiredStations = [...new Set(steps.map((step) => step.station).filter((station) => station !== "hand"))];

    return {
      target_item: targetItem,
      quantity,
      purpose,
      required_stations: requiredStations,
      required_tools: this.requiredToolsFor(targetItem),
      recipe_path: steps,
      missing_inputs: missingInputs
    };
  }

  private expandRecipe(
    itemId: number,
    quantity: number,
    visited: Set<number>,
    data: ReturnType<typeof minecraftData>,
    available: Record<string, number>
  ): CraftStep[] {
    if (visited.has(itemId)) {
      return [];
    }
    visited.add(itemId);

    const recipes = (data.recipes[itemId] ?? []) as RecipeLike[];
    if (recipes.length === 0) {
      visited.delete(itemId);
      return [];
    }

    const recipe = recipes[0];
    const stepCount = recipe.result?.count ?? 1;
    const multiplier = Math.ceil(quantity / stepCount);
    const ingredientsById = aggregateIngredients(recipe);
    const childSteps: CraftStep[] = [];

    for (const [ingredientId, count] of Object.entries(ingredientsById)) {
      const numericId = Number(ingredientId);
      const ingredientName = data.items[numericId]?.name;
      const requiredCount = count * multiplier;
      let remaining = requiredCount;
      if (ingredientName) {
        const onHand = available[ingredientName] ?? 0;
        const consumed = Math.min(onHand, requiredCount);
        if (consumed > 0) {
          available[ingredientName] = onHand - consumed;
        }
        remaining = requiredCount - consumed;
        if (remaining <= 0) {
          continue;
        }
      }
      const ingredientRecipes = data.recipes[numericId] ?? [];
      if (ingredientRecipes.length > 0) {
        childSteps.push(...this.expandRecipe(numericId, remaining, visited, data, available));
      }
    }

    const step: CraftStep = {
      item: data.items[itemId]?.name ?? String(itemId),
      count: quantity,
      station: inferStation(recipe),
      ingredients: Object.fromEntries(
        Object.entries(ingredientsById).map(([ingredientId, count]) => [
          data.items[Number(ingredientId)]?.name ?? ingredientId,
          count * multiplier
        ])
      )
    };

    visited.delete(itemId);
    return [...childSteps, step];
  }

  private calculateMissingInputs(steps: CraftStep[], inventory: Record<string, number>): Record<string, number> {
    const missing = new Map<string, number>();
    for (const step of steps) {
      for (const [ingredient, required] of Object.entries(step.ingredients)) {
        const current = inventory[ingredient] ?? 0;
        if (current < required) {
          missing.set(ingredient, Math.max(missing.get(ingredient) ?? 0, required - current));
        }
      }
    }
    return Object.fromEntries(missing.entries());
  }

  private requiredToolsFor(targetItem: string): string[] {
    if (targetItem.includes("bucket") || targetItem.includes("shears") || targetItem.includes("shield")) {
      return ["furnace"];
    }
    if (targetItem.includes("bread")) {
      return [];
    }
    return [];
  }
}
