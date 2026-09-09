import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeRecipeLineCost,
  computeRecipeTotals,
  convertToItemUnit,
} from "./recipe-cost.ts";

describe("convertToItemUnit", () => {
  it("kg ↔ g", () => {
    assert.equal(convertToItemUnit(10, "g", "kg"), 0.01);
    assert.equal(convertToItemUnit(0.5, "kg", "kg"), 0.5);
    assert.equal(convertToItemUnit(500, "g", "kg"), 0.5);
  });

  it("l ↔ ml", () => {
    assert.equal(convertToItemUnit(500, "ml", "l"), 0.5);
    assert.equal(convertToItemUnit(1, "L", "ml"), 1000);
  });

  it("count units", () => {
    assert.equal(convertToItemUnit(1, "pcs", "pcs"), 1);
    assert.equal(convertToItemUnit(2, "pc", "pcs"), 2);
  });

  it("rejects incompatible mass → count", () => {
    assert.throws(() => convertToItemUnit(10, "kg", "pcs"), /Cannot convert|Incompatible/i);
    assert.throws(() => convertToItemUnit(10, "g", "pcs"), /Cannot convert|Incompatible/i);
  });

  it("rejects unknown units", () => {
    assert.throws(() => convertToItemUnit(10, "spoon", "kg"), /Cannot convert/i);
  });
});

describe("computeRecipeLineCost", () => {
  it("TEST1 Garlic Sauce: 1kg=10000 → 10g = 100", () => {
    const r = computeRecipeLineCost({
      quantity: 10,
      unit: "g",
      itemUnit: "kg",
      costPerUnit: 10000,
      yieldPct: 100,
    });
    assert.equal(r.convertedQuantity, 0.01);
    assert.equal(r.convertedUnit, "kg");
    assert.equal(r.lineCost, 100);
  });

  it("TEST2 Coleslaw: 1kg=8000 → 20g = 160", () => {
    const r = computeRecipeLineCost({
      quantity: 20,
      unit: "g",
      itemUnit: "kg",
      costPerUnit: 8000,
    });
    assert.equal(r.lineCost, 160);
  });

  it("TEST3 Bread: 1pcs=1500 → 1pcs = 1500", () => {
    const r = computeRecipeLineCost({
      quantity: 1,
      unit: "pcs",
      itemUnit: "pcs",
      costPerUnit: 1500,
    });
    assert.equal(r.lineCost, 1500);
  });

  it("TEST5 same unit 0.5 kg @ 10000 = 5000", () => {
    const r = computeRecipeLineCost({
      quantity: 0.5,
      unit: "kg",
      itemUnit: "kg",
      costPerUnit: 10000,
    });
    assert.equal(r.lineCost, 5000);
  });

  it("TEST6 500 g @ 10000/kg = 5000", () => {
    const r = computeRecipeLineCost({
      quantity: 500,
      unit: "g",
      itemUnit: "kg",
      costPerUnit: 10000,
    });
    assert.equal(r.lineCost, 5000);
  });

  it("TEST7 incompatible kg recipe pcs inventory", () => {
    assert.throws(
      () => computeRecipeLineCost({
        quantity: 10,
        unit: "pcs",
        itemUnit: "kg",
        costPerUnit: 10000,
      }),
      /Cannot convert|Incompatible/i,
    );
  });

  it("TEST8 yield 80%: 80g usable → 100g raw cost", () => {
    // Inventory priced per kg = 10000 → 10 IDR/g
    // 80g usable at 80% yield → 100g raw → 100 * 10 = 1000 if base were g;
    // with base kg: 80g = 0.08 kg → /0.8 = 0.1 kg × 10000 = 1000
    const r = computeRecipeLineCost({
      quantity: 80,
      unit: "g",
      itemUnit: "kg",
      costPerUnit: 10000,
      yieldPct: 80,
    });
    assert.equal(r.convertedQuantity, 0.08);
    assert.equal(r.effectiveQuantity, 0.1);
    assert.equal(r.lineCost, 1000);
  });
});

describe("computeRecipeTotals", () => {
  it("TEST4 total garlic+coleslaw+bread+chicken = 5760; 10 portions → 576; food cost @20000 = 2.88%", () => {
    const garlic = computeRecipeLineCost({ quantity: 10, unit: "g", itemUnit: "kg", costPerUnit: 10000 }).lineCost;
    const coleslaw = computeRecipeLineCost({ quantity: 20, unit: "g", itemUnit: "kg", costPerUnit: 8000 }).lineCost;
    const bread = computeRecipeLineCost({ quantity: 1, unit: "pcs", itemUnit: "pcs", costPerUnit: 1500 }).lineCost;
    const chicken = computeRecipeLineCost({ quantity: 100, unit: "g", itemUnit: "kg", costPerUnit: 40000 }).lineCost;
    assert.equal(garlic, 100);
    assert.equal(coleslaw, 160);
    assert.equal(bread, 1500);
    assert.equal(chicken, 4000);
    const t = computeRecipeTotals([garlic, coleslaw, bread, chicken], 10, 20000);
    assert.equal(t.totalCost, 5760);
    assert.equal(t.costPerPortion, 576);
    assert.equal(t.foodCostPct, 2.88);
  });

  it("TEST9 portions: 10000 / 5 = 2000", () => {
    const t = computeRecipeTotals([10000], 5);
    assert.equal(t.costPerPortion, 2000);
  });
});
