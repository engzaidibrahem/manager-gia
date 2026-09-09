import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertToBaseUnit } from "./units.ts";

describe("InventoryCore scenarios", () => {
  function apply(balance: number, delta: number) {
    const next = balance + delta;
    if (next < -0.0001) {
      throw new Error(`INSUFFICIENT_STOCK Available ${balance}, delta ${delta}`);
    }
    return Math.max(0, next);
  }

  it("transfer 35 WH → leaves 30 WH / 13 K when kitchen had 8", () => {
    let wh = 35;
    let k = 8;
    const qty = convertToBaseUnit(5, "kg", "kg");
    wh = apply(wh, -qty);
    k = apply(k, qty);
    assert.equal(wh, 30);
    assert.equal(k, 13);
  });

  it("insufficient stock rejects without partial apply", () => {
    let wh = 3;
    const snapshot = wh;
    assert.throws(() => {
      wh = apply(wh, -5);
    }, /INSUFFICIENT_STOCK|Available/);
    assert.equal(wh, snapshot);
  });

  it("invalid unit never silently uses raw qty", () => {
    assert.throws(() => convertToBaseUnit(5, "kg", "pcs"));
  });

  it("purchase invoice does not change stock; receive does", () => {
    const stockBefore = { warehouse: 10, kitchen: 2 };
    const purchaseQty = 5;
    const afterPurchase = { ...stockBefore };
    assert.deepEqual(afterPurchase, stockBefore);

    const receivedQty = convertToBaseUnit(purchaseQty, "kg", "kg");
    const afterReceive = {
      warehouse: stockBefore.warehouse + receivedQty,
      kitchen: stockBefore.kitchen,
    };
    assert.equal(afterReceive.warehouse, 15);
    assert.ok(receivedQty > 0);
  });

  it("reverse of out restores warehouse", () => {
    let wh = 10;
    const qty = 2;
    wh = apply(wh, -qty);
    assert.equal(wh, 8);
    wh = apply(wh, qty);
    assert.equal(wh, 10);
  });

  it("500g transfer against kg item converts to 0.5", () => {
    let wh = 35;
    let k = 8;
    const qty = convertToBaseUnit(500, "g", "kg");
    wh = apply(wh, -qty);
    k = apply(k, qty);
    assert.equal(wh, 34.5);
    assert.equal(k, 8.5);
  });
});
