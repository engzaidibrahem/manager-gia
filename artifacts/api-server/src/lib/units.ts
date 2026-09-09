/**
 * Shared Unit Conversion Service — wraps @workspace/inventory-math with AppError.
 */

import {
  assertCompatibleUnits as assertCompatibleUnitsCore,
  convertToBaseUnit as convertToBaseUnitCore,
  getUnitMeta,
  normalizeUnit,
  UnitConversionError,
  type UnitDim,
} from "@workspace/inventory-math/units";
import { AppError } from "./errors";

export type { UnitDim };
export type InventoryLocation = "warehouse" | "kitchen";
export { getUnitMeta, normalizeUnit };

/** Convert quantity from `fromUnit` into item base unit `baseUnit`. */
export function convertToBaseUnit(qty: number, fromUnit: string, baseUnit: string): number {
  try {
    return convertToBaseUnitCore(qty, fromUnit, baseUnit);
  } catch (err: unknown) {
    if (err instanceof UnitConversionError) {
      throw new AppError(err.code, err.message, 400, err.details);
    }
    throw err;
  }
}

/** @deprecated alias — use convertToBaseUnit */
export const convertToItemUnit = convertToBaseUnit;

export function assertCompatibleUnits(fromUnit: string, baseUnit: string): void {
  try {
    assertCompatibleUnitsCore(fromUnit, baseUnit);
  } catch (err: unknown) {
    if (err instanceof UnitConversionError) {
      throw new AppError(err.code, err.message, 400, err.details);
    }
    throw err;
  }
}
