/**
 * Web recipe preview — SAME module as API (@workspace/inventory-math).
 * Authoritative persisted values still come from API bulk-save responses.
 * This file must not contain independent conversion/cost formulas.
 */

export {
  computeRecipeLineCost,
  computeRecipeTotals,
  convertToItemUnit,
  roundCost,
  tryComputeRecipeLineCost,
  type RecipeLineBreakdown,
  type RecipeLineInput,
  type RecipeTotals,
  type UnitDim,
} from "@workspace/inventory-math/recipe-cost";
