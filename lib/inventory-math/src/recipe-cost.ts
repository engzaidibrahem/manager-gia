/**
 * Authoritative recipe costing — shared by API persistence and Web preview.
 * Does not mutate inventory.
 */

import { convertToBaseUnit } from "./units";

export { convertToBaseUnit as convertToItemUnit } from "./units";
export type { UnitDim } from "./units";

export function roundCost(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export type RecipeLineInput = {
  quantity: number;
  unit: string;
  itemUnit: string;
  costPerUnit: number;
  yieldPct?: number;
};

export type RecipeLineBreakdown = {
  quantity: number;
  unit: string;
  convertedQuantity: number;
  convertedUnit: string;
  effectiveQuantity: number;
  costPerUnit: number;
  yieldPct: number;
  lineCost: number;
};

export function computeRecipeLineCost(input: RecipeLineInput): RecipeLineBreakdown {
  const quantity = Number(input.quantity);
  const costPerUnit = Number(input.costPerUnit) || 0;
  const yieldPct = Number(input.yieldPct);
  const y = Number.isFinite(yieldPct) && yieldPct > 0 ? yieldPct : 100;
  if (!(quantity > 0)) throw new Error("quantity must be > 0");
  if (costPerUnit < 0) throw new Error("costPerUnit must be >= 0");
  if (y <= 0 || y > 100) throw new Error("yieldPct must be > 0 and <= 100");

  const convertedQuantity = convertToBaseUnit(quantity, input.unit, input.itemUnit);
  const effectiveQuantity = convertedQuantity / (y / 100);
  const lineCost = roundCost(effectiveQuantity * costPerUnit, 4);

  return {
    quantity,
    unit: input.unit,
    convertedQuantity: roundCost(convertedQuantity, 6),
    convertedUnit: input.itemUnit,
    effectiveQuantity: roundCost(effectiveQuantity, 6),
    costPerUnit,
    yieldPct: y,
    lineCost,
  };
}

export type RecipeTotals = {
  totalCost: number;
  portions: number;
  costPerPortion: number;
  suggestedPrice: number;
  foodCostPct: number;
};

export function computeRecipeTotals(
  lineCosts: number[],
  portions: number,
  sellingPrice = 0,
  targetFoodCostPct = 30,
): RecipeTotals {
  const totalCost = roundCost(lineCosts.reduce((s, c) => s + c, 0), 4);
  const p = Math.max(0.01, Number(portions) || 1);
  const costPerPortion = roundCost(totalCost / p, 4);
  const target = Math.max(1, Number(targetFoodCostPct) || 30);
  const suggestedPrice = roundCost(costPerPortion / (target / 100), 4);
  const sell = Number(sellingPrice) || 0;
  const foodCostPct = sell > 0 ? roundCost((costPerPortion / sell) * 100, 4) : 0;
  return { totalCost, portions: p, costPerPortion, suggestedPrice, foodCostPct };
}

export function tryComputeRecipeLineCost(input: RecipeLineInput): RecipeLineBreakdown | { error: string } {
  try {
    return computeRecipeLineCost(input);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid line" };
  }
}

export function assertRecipeLineCompatible(
  quantity: number,
  unit: string,
  itemUnit: string,
  yieldPct?: number,
): void {
  if (!(quantity > 0)) throw new Error("quantity must be > 0");
  const y = yieldPct == null ? 100 : Number(yieldPct);
  if (!(y > 0) || y > 100) throw new Error("yieldPct must be > 0 and <= 100");
  convertToBaseUnit(quantity, unit, itemUnit);
}
