/**
 * Recipe cost — re-exports authoritative shared math.
 * Persistence routes must use these functions (not frontend copies).
 */

export {
  assertRecipeLineCompatible,
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
