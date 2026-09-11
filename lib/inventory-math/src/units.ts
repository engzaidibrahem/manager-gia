/**
 * Authoritative unit conversion — shared by API and Web preview.
 * Never silently falls back when conversion fails.
 */

export type UnitDim = "mass" | "vol" | "count";

const UNIT_TABLE: Record<string, { dim: UnitDim; factor: number }> = {
  kg: { dim: "mass", factor: 1000 },
  g: { dim: "mass", factor: 1 },
  gram: { dim: "mass", factor: 1 },
  grams: { dim: "mass", factor: 1 },
  l: { dim: "vol", factor: 1000 },
  liter: { dim: "vol", factor: 1000 },
  litre: { dim: "vol", factor: 1000 },
  ml: { dim: "vol", factor: 1 },
  pcs: { dim: "count", factor: 1 },
  pc: { dim: "count", factor: 1 },
  buah: { dim: "count", factor: 1 },
  unit: { dim: "count", factor: 1 },
};

export function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

export function getUnitMeta(unit: string) {
  return UNIT_TABLE[normalizeUnit(unit)];
}

export class UnitConversionError extends Error {
  readonly code: "VALIDATION_ERROR" | "INVALID_UNIT" | "INVALID_UNIT_CONVERSION";
  readonly details?: Record<string, unknown>;

  constructor(
    code: UnitConversionError["code"],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UnitConversionError";
    this.code = code;
    this.details = details;
  }
}

/** Convert quantity from `fromUnit` into item base unit `baseUnit`. */
export function convertToBaseUnit(qty: number, fromUnit: string, baseUnit: string): number {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(baseUnit);
  if (!(qty > 0) || !Number.isFinite(qty)) {
    throw new UnitConversionError("VALIDATION_ERROR", "Quantity must be a positive number");
  }
  if (from === to) return qty;

  const a = UNIT_TABLE[from];
  const b = UNIT_TABLE[to];
  if (!a || !b) {
    throw new UnitConversionError(
      "INVALID_UNIT",
      `Cannot convert ${fromUnit.toUpperCase()} to ${baseUnit.toUpperCase()}.`,
      { fromUnit, baseUnit },
    );
  }
  if (a.dim !== b.dim) {
    throw new UnitConversionError(
      "INVALID_UNIT_CONVERSION",
      `Cannot convert ${fromUnit.toUpperCase()} to ${baseUnit.toUpperCase()}.`,
      { fromUnit, baseUnit },
    );
  }
  return (qty * a.factor) / b.factor;
}

export const convertToItemUnit = convertToBaseUnit;

export function assertCompatibleUnits(fromUnit: string, baseUnit: string): void {
  convertToBaseUnit(1, fromUnit, baseUnit);
}
