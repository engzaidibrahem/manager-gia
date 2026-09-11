import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertToBaseUnit } from "./units.ts";
import { AppError } from "./errors.ts";

describe("UnitService convertToBaseUnit", () => {
  it("kg ↔ g", () => {
    assert.equal(convertToBaseUnit(10, "g", "kg"), 0.01);
    assert.equal(convertToBaseUnit(0.5, "kg", "kg"), 0.5);
    assert.equal(convertToBaseUnit(500, "g", "kg"), 0.5);
  });

  it("L ↔ ml", () => {
    assert.equal(convertToBaseUnit(500, "ml", "l"), 0.5);
    assert.equal(convertToBaseUnit(1, "L", "ml"), 1000);
  });

  it("rejects incompatible mass → count", () => {
    assert.throws(() => convertToBaseUnit(10, "kg", "pcs"), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.match(err.message, /Cannot convert KG to PCS/i);
      return true;
    });
  });

  it("rejects unknown units hard (no fallback)", () => {
    assert.throws(() => convertToBaseUnit(10, "spoon", "kg"), (err: unknown) => {
      assert.ok(err instanceof AppError);
      return true;
    });
  });
});
