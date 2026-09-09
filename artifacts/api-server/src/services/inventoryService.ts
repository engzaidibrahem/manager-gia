/**
 * Inventory Core — sole writer of location stock balances.
 * Uses row lock (FOR UPDATE) + conditional update so concurrent transfers cannot oversell.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { dailyPurchasesTable, inventoryItemsTable, inventoryMovementsTable, warehouseLotsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import type { InventoryLocation } from "../lib/units";
import {
  consumeWarehouseLots,
  parseLotAllocations,
  restoreWarehouseLots,
  reverseReceiveLot,
  serializeLotAllocations,
  type LotAllocation,
} from "./lotFifo";

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MovementType =
  | "in"
  | "out"
  | "kitchen"
  | "adjustment"
  | "transfer"
  | "receive"
  | "opening_balance"
  | "waste"
  | "reversal"
  | "legacy_backfill"
  | "correction";

export type ApplyDeltaInput = {
  itemId: number;
  location: InventoryLocation;
  /** Signed delta in item base units (+ receive, − issue). */
  delta: number;
  allowNegative?: boolean;
  costPerUnit?: number;
};

export type RecordMovementInput = {
  itemId: number;
  type: MovementType;
  location: InventoryLocation;
  quantity: number;
  unitCost?: number;
  note?: string;
  actor: string;
  purchaseId?: number | null;
  lotId?: number | null;
  fromLocation?: InventoryLocation | null;
  toLocation?: InventoryLocation | null;
  baseQuantity?: number;
  unit?: string;
  method?: string;
  userId?: number | null;
  reversalOfId?: number | null;
  lotAllocations?: string | null;
};

function stockField(location: InventoryLocation): "currentStock" | "kitchenStock" {
  return location === "kitchen" ? "kitchenStock" : "currentStock";
}

function locationLabel(location: InventoryLocation): string {
  return location === "kitchen" ? "kitchen" : "warehouse";
}

export function assertItemOperable(item: { id: number; name: string; archivedAt?: Date | null }) {
  if (item.archivedAt) {
    throw new AppError(
      "ITEM_ARCHIVED",
      `Item #${item.id} (${item.name}) is archived and cannot be used for new stock operations`,
      400,
    );
  }
}

/** Lock item row for the duration of the surrounding transaction (Postgres + PGlite). */
async function lockItemRow(tx: DbTx | typeof db, itemId: number) {
  await tx.execute(sql`SELECT id FROM inventory_items WHERE id = ${itemId} FOR UPDATE`);
}

/** Apply signed stock delta. Must run inside a transaction for multi-step ops. */
export async function applyLocationDelta(
  tx: DbTx | typeof db,
  input: ApplyDeltaInput,
) {
  await lockItemRow(tx, input.itemId);

  const item = await tx.query.inventoryItemsTable.findFirst({
    where: eq(inventoryItemsTable.id, input.itemId),
  });
  if (!item) {
    throw new AppError("ITEM_NOT_FOUND", `Item ${input.itemId} not found`, 404);
  }

  const field = stockField(input.location);
  const current = Number(item[field]);
  const next = current + input.delta;
  const unit = item.unit || "unit";
  const loc = locationLabel(input.location);

  if (!input.allowNegative && next < -0.0001) {
    const requested = Math.abs(input.delta);
    throw new AppError(
      "INSUFFICIENT_STOCK",
      `Insufficient ${loc} stock. Available: ${current} ${unit}, requested: ${requested} ${unit}.`,
      400,
      {
        itemId: item.id,
        itemName: item.name,
        location: input.location,
        available: current,
        requested,
        unit,
      },
    );
  }

  // Conditional UPDATE: second concurrent writer sees 0 rows and fails safely
  if (field === "kitchenStock") {
    const where = input.allowNegative
      ? eq(inventoryItemsTable.id, input.itemId)
      : and(
        eq(inventoryItemsTable.id, input.itemId),
        sql`${inventoryItemsTable.kitchenStock} + ${input.delta} >= -0.0001`,
      );
    const patch: Record<string, unknown> = {
      kitchenStock: sql`${inventoryItemsTable.kitchenStock} + ${input.delta}`,
      updatedAt: new Date(),
    };
    if (input.costPerUnit != null && input.costPerUnit >= 0) patch.costPerUnit = input.costPerUnit;
    const [updated] = await tx.update(inventoryItemsTable).set(patch).where(where).returning();
    if (!updated) {
      throw new AppError(
        "INSUFFICIENT_STOCK",
        `Insufficient kitchen stock. Available: ${current} ${unit}, requested: ${Math.abs(input.delta)} ${unit}.`,
        400,
        { available: current, requested: Math.abs(input.delta), unit },
      );
    }
    return updated;
  }

  const where = input.allowNegative
    ? eq(inventoryItemsTable.id, input.itemId)
    : and(
      eq(inventoryItemsTable.id, input.itemId),
      sql`${inventoryItemsTable.currentStock} + ${input.delta} >= -0.0001`,
    );
  const patch: Record<string, unknown> = {
    currentStock: sql`${inventoryItemsTable.currentStock} + ${input.delta}`,
    updatedAt: new Date(),
  };
  if (input.costPerUnit != null && input.costPerUnit >= 0) patch.costPerUnit = input.costPerUnit;
  const [updated] = await tx.update(inventoryItemsTable).set(patch).where(where).returning();
  if (!updated) {
    throw new AppError(
      "INSUFFICIENT_STOCK",
      `Insufficient warehouse stock. Available: ${current} ${unit}, requested: ${Math.abs(input.delta)} ${unit}.`,
      400,
      { available: current, requested: Math.abs(input.delta), unit },
    );
  }
  // Clamp tiny negatives from float noise
  const stock = Number(updated.currentStock);
  if (stock < 0 && stock > -0.0001) {
    await tx.update(inventoryItemsTable).set({ currentStock: 0 }).where(eq(inventoryItemsTable.id, input.itemId));
  }
  const kStock = Number(updated.kitchenStock);
  if (kStock < 0 && kStock > -0.0001) {
    await tx.update(inventoryItemsTable).set({ kitchenStock: 0 }).where(eq(inventoryItemsTable.id, input.itemId));
  }
  return (await tx.query.inventoryItemsTable.findFirst({
    where: eq(inventoryItemsTable.id, input.itemId),
  })) ?? updated;
}

/** Insert an inventory movement row (ledger). */
export async function recordMovement(tx: DbTx | typeof db, input: RecordMovementInput) {
  if (!input.actor?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Actor is required for inventory movements");
  }
  const values: Record<string, unknown> = {
    itemId: input.itemId,
    type: input.type,
    location: input.location,
    quantity: input.quantity,
    unitCost: input.unitCost ?? 0,
    note: input.note ?? "",
    actor: input.actor.trim(),
    purchaseId: input.purchaseId ?? null,
    lotId: input.lotId ?? null,
  };
  if (input.fromLocation != null) values.fromLocation = input.fromLocation;
  if (input.toLocation != null) values.toLocation = input.toLocation;
  if (input.baseQuantity != null) values.baseQuantity = input.baseQuantity;
  if (input.unit != null) values.unit = input.unit;
  if (input.method != null) values.method = input.method;
  if (input.userId != null) values.userId = input.userId;
  if (input.reversalOfId != null) values.reversalOfId = input.reversalOfId;
  if (input.lotAllocations != null) values.lotAllocations = input.lotAllocations;

  try {
    const [created] = await tx
      .insert(inventoryMovementsTable)
      .values(values as typeof inventoryMovementsTable.$inferInsert)
      .returning();
    return created;
  } catch {
    const [created] = await tx.insert(inventoryMovementsTable).values({
      itemId: input.itemId,
      type: input.type,
      location: input.location,
      quantity: input.quantity,
      unitCost: input.unitCost ?? 0,
      note: input.note ?? "",
      actor: input.actor.trim(),
      purchaseId: input.purchaseId ?? null,
      lotId: input.lotId ?? null,
    }).returning();
    return created;
  }
}

export async function getItemOrThrow(tx: DbTx | typeof db, itemId: number) {
  const item = await tx.query.inventoryItemsTable.findFirst({
    where: eq(inventoryItemsTable.id, itemId),
  });
  if (!item) throw new AppError("ITEM_NOT_FOUND", `Item ${itemId} not found`, 404);
  return item;
}

function resolveTransferAllocations(movement: {
  lotAllocations?: string | null;
  lotId?: number | null;
  baseQuantity?: number | null;
  quantity: number;
  id: number;
}): { allocations: LotAllocation[]; mode: "exact" | "stock_only" } {
  const parsed = parseLotAllocations(movement.lotAllocations);
  if (parsed.length) return { allocations: parsed, mode: "exact" };
  // No allocation payload: only allow stock-only reverse when no lot was recorded.
  // A lone lotId without allocations is ambiguous (multi-lot FIFO used to store last lot only).
  if (!movement.lotId) return { allocations: [], mode: "stock_only" };
  throw new AppError(
    "CONFLICT",
    `Cannot reverse transfer #${movement.id}: missing lot_allocations required for exact FIFO restore. Do not guess lot quantities.`,
    409,
  );
}

async function rollbackPurchaseReceived(
  tx: DbTx | typeof db,
  purchaseId: number | null | undefined,
  qtyInItemUnit: number,
  itemUnit: string,
) {
  if (!purchaseId) return;
  const purchase = await tx.query.dailyPurchasesTable.findFirst({
    where: eq(dailyPurchasesTable.id, purchaseId),
  });
  if (!purchase) return;
  let rollbackQty = qtyInItemUnit;
  try {
    const { convertToBaseUnit } = await import("../lib/units");
    rollbackQty = convertToBaseUnit(qtyInItemUnit, itemUnit, purchase.unit);
  } catch {
    rollbackQty = qtyInItemUnit;
  }
  const next = Math.max(0, Number(purchase.quantityReceived || 0) - rollbackQty);
  const ordered = Number(purchase.quantity);
  let status = "ordered";
  if (next <= 0.0001) status = "ordered";
  else if (next + 0.0001 >= ordered) status = "received";
  else status = "partially_received";
  await tx.update(dailyPurchasesTable).set({
    quantityReceived: next,
    status,
  }).where(eq(dailyPurchasesTable.id, purchaseId));
}

/** Reverse a movement by applying opposite stock deltas and inserting a reversal row. History is append-only. */
export async function reverseMovement(
  tx: DbTx | typeof db,
  movementId: number,
  actor: string,
  userId?: number | null,
  reason?: string,
) {
  if (!actor?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Actor is required for reversal");
  }
  const movement = await tx.query.inventoryMovementsTable.findFirst({
    where: eq(inventoryMovementsTable.id, movementId),
  });
  if (!movement) throw new AppError("MOVEMENT_NOT_FOUND", `Movement ${movementId} not found`, 404);
  if (movement.type === "reversal") {
    throw new AppError("VALIDATION_ERROR", "Cannot reverse a reversal movement");
  }

  // Prevent double-reversal of the same movement (idempotent reject)
  const existing = await tx.select().from(inventoryMovementsTable)
    .where(eq(inventoryMovementsTable.reversalOfId, movementId))
    .limit(1);
  if (existing.length) {
    throw new AppError("CONFLICT", `Movement #${movementId} already has a reversal`, 409);
  }

  const item = await getItemOrThrow(tx, movement.itemId);
  const qtyAbs = Math.abs(Number(movement.baseQuantity ?? movement.quantity));
  const signedBase = Number(movement.baseQuantity ?? movement.quantity);
  const type = movement.type;
  const location = (movement.location === "kitchen" ? "kitchen" : "warehouse") as InventoryLocation;

  if (type === "transfer") {
    const to = (movement.toLocation === "warehouse" || movement.toLocation === "kitchen")
      ? movement.toLocation as InventoryLocation
      : location;
    const from = (movement.fromLocation === "warehouse" || movement.fromLocation === "kitchen")
      ? movement.fromLocation as InventoryLocation
      : (to === "kitchen" ? "warehouse" : "kitchen");

    // Restore FIFO lots when transfer left the warehouse
    if (from === "warehouse") {
      const resolved = resolveTransferAllocations(movement);
      if (resolved.mode === "exact") {
        await restoreWarehouseLots(tx, resolved.allocations);
      }
      // stock_only: balances only (legacy transfers with no lots)
    }

    await applyLocationDelta(tx, { itemId: movement.itemId, location: to, delta: -qtyAbs });
    await applyLocationDelta(tx, { itemId: movement.itemId, location: from, delta: qtyAbs });
  } else if (type === "receive" || type === "in" || type === "opening_balance") {
    if (movement.lotId) {
      await reverseReceiveLot(tx, movement.lotId, qtyAbs);
    } else {
      const createdAlloc = parseLotAllocations(movement.lotAllocations);
      for (const alloc of createdAlloc) {
        await reverseReceiveLot(tx, alloc.lotId, alloc.quantity);
      }
    }
    await applyLocationDelta(tx, { itemId: movement.itemId, location: "warehouse", delta: -qtyAbs });
    if (type !== "opening_balance") {
      await rollbackPurchaseReceived(tx, movement.purchaseId, qtyAbs, item.unit);
    }
  } else if (type === "adjustment") {
    // Signed baseQuantity: reverse is the mathematical opposite
    const reverseDelta = -signedBase;
    if (location === "warehouse" && reverseDelta < 0) {
      // Reversing a positive adj: consume lots if we created one, else FIFO consume
      const createdAlloc = parseLotAllocations(movement.lotAllocations);
      if (createdAlloc.length) {
        // Original was +qty creating a lot — reverse by reducing that lot
        for (const alloc of createdAlloc) {
          await reverseReceiveLot(tx, alloc.lotId, alloc.quantity);
        }
      } else {
        const consumed = await consumeWarehouseLots(tx, movement.itemId, Math.abs(reverseDelta));
        // Store on reversal movement below via note only — already applying stock
        void consumed;
      }
    } else if (location === "warehouse" && reverseDelta > 0) {
      // Reversing a negative adj: restore consumed lots
      const allocations = parseLotAllocations(movement.lotAllocations);
      if (allocations.length) {
        await restoreWarehouseLots(tx, allocations);
      } else if (movement.lotId) {
        await restoreWarehouseLots(tx, [{ lotId: movement.lotId, quantity: Math.abs(signedBase) }]);
      } else {
        // Create correction lot so reconcile stays consistent
        const [lot] = await tx.insert(warehouseLotsTable).values({
          itemId: movement.itemId,
          receiptDate: new Date().toISOString().slice(0, 10),
          brand: item.brand ?? "",
          quantityReceived: reverseDelta,
          quantityRemaining: reverseDelta,
          costPerUnit: Number(item.costPerUnit) || 0,
          note: `Reversal restore for adjustment #${movementId}`,
          actor: actor.trim(),
        }).returning();
        void lot;
      }
    }
    await applyLocationDelta(tx, { itemId: movement.itemId, location, delta: reverseDelta });
  } else if (type === "waste" || type === "out" || type === "kitchen") {
    const allocations = parseLotAllocations(movement.lotAllocations);
    if (location === "warehouse") {
      if (allocations.length) {
        await restoreWarehouseLots(tx, allocations);
      } else if (movement.lotId) {
        await restoreWarehouseLots(tx, [{ lotId: movement.lotId, quantity: qtyAbs }]);
      }
    }
    await applyLocationDelta(tx, { itemId: movement.itemId, location, delta: qtyAbs });
  } else if (type === "legacy_backfill" || type === "correction") {
    throw new AppError("VALIDATION_ERROR", `Movement type ${type} cannot be reversed via this API`);
  } else {
    throw new AppError("VALIDATION_ERROR", `Unsupported movement type for reversal: ${type}`);
  }

  return recordMovement(tx, {
    itemId: movement.itemId,
    type: "reversal",
    location,
    quantity: qtyAbs,
    baseQuantity: type === "adjustment" ? -signedBase : qtyAbs,
    unit: movement.unit ?? undefined,
    unitCost: Number(movement.unitCost) || 0,
    note: reason?.trim() || `Reversal of movement #${movementId}`,
    actor: actor.trim(),
    userId: userId ?? null,
    reversalOfId: movementId,
    method: "reversal",
    lotId: movement.lotId ?? null,
    lotAllocations: movement.lotAllocations ?? null,
    fromLocation: ((movement.toLocation as InventoryLocation | null | undefined) ?? null),
    toLocation: ((movement.fromLocation as InventoryLocation | null | undefined) ?? null),
  });
}

/** Typed adjustment with unit conversion. Signed quantity. Warehouse touches lots. */
export async function adjustStock(
  tx: DbTx | typeof db,
  input: {
    itemId: number;
    location: InventoryLocation;
    quantity: number;
    unit?: string;
    note?: string;
    actor: string;
    userId?: number | null;
  },
) {
  const { convertToBaseUnit } = await import("../lib/units");
  const item = await getItemOrThrow(tx, input.itemId);
  assertItemOperable(item);
  const unit = input.unit?.trim() || item.unit;
  const signed = input.quantity;
  const absQty = Math.abs(signed);
  if (!(absQty > 0)) throw new AppError("VALIDATION_ERROR", "Adjustment quantity must be non-zero");
  // convert absolute then re-apply sign (converter requires positive)
  const qtyBase = convertToBaseUnit(absQty, unit, item.unit) * Math.sign(signed);

  let lotId: number | null = null;
  let lotAllocations: string | null = null;

  if (input.location === "warehouse" && qtyBase < 0) {
    const consumed = await consumeWarehouseLots(tx, item.id, Math.abs(qtyBase));
    lotId = consumed.lotId;
    lotAllocations = serializeLotAllocations(consumed.allocations);
  } else if (input.location === "warehouse" && qtyBase > 0) {
    const [lot] = await tx.insert(warehouseLotsTable).values({
      itemId: item.id,
      receiptDate: new Date().toISOString().slice(0, 10),
      brand: item.brand ?? "",
      quantityReceived: qtyBase,
      quantityRemaining: qtyBase,
      costPerUnit: Number(item.costPerUnit) || 0,
      note: input.note ?? "Adjustment",
      actor: input.actor,
    }).returning();
    lotId = lot.id;
    lotAllocations = serializeLotAllocations([{ lotId: lot.id, quantity: qtyBase }]);
  }

  await applyLocationDelta(tx, { itemId: item.id, location: input.location, delta: qtyBase });
  const movement = await recordMovement(tx, {
    itemId: item.id,
    type: "adjustment",
    location: input.location,
    quantity: Math.abs(qtyBase),
    baseQuantity: qtyBase, // signed — required for correct reversal
    unit: item.unit,
    note: input.note ?? "Adjustment",
    actor: input.actor,
    userId: input.userId ?? null,
    method: "adjustment",
    lotId,
    lotAllocations,
  });
  const updated = await getItemOrThrow(tx, item.id);
  return { movement, item: updated, quantity: qtyBase };
}

/** Typed waste with unit conversion. Warehouse waste consumes FIFO lots. */
export async function wasteStock(
  tx: DbTx | typeof db,
  input: {
    itemId: number;
    location: InventoryLocation;
    quantity: number;
    unit?: string;
    note?: string;
    actor: string;
    userId?: number | null;
    reason?: string;
  },
) {
  const { convertToBaseUnit } = await import("../lib/units");
  const item = await getItemOrThrow(tx, input.itemId);
  assertItemOperable(item);
  const unit = input.unit?.trim() || item.unit;
  const qtyBase = convertToBaseUnit(input.quantity, unit, item.unit);

  let lotId: number | null = null;
  let lotAllocations: string | null = null;
  if (input.location === "warehouse") {
    const consumed = await consumeWarehouseLots(tx, item.id, qtyBase);
    lotId = consumed.lotId;
    lotAllocations = serializeLotAllocations(consumed.allocations);
  }

  await applyLocationDelta(tx, { itemId: item.id, location: input.location, delta: -qtyBase });
  const movement = await recordMovement(tx, {
    itemId: item.id,
    type: "waste",
    location: input.location,
    quantity: qtyBase,
    baseQuantity: qtyBase,
    unit: item.unit,
    note: input.note ?? `Waste: ${input.reason ?? "spoilage"}`,
    actor: input.actor,
    userId: input.userId ?? null,
    method: "waste",
    lotId,
    lotAllocations,
  });
  const updated = await getItemOrThrow(tx, item.id);
  return { movement, item: updated, quantity: qtyBase };
}

/** Soft-archive items — preserves movements, lots, waste, purchases history. */
export async function archiveItems(
  tx: DbTx | typeof db,
  itemIds: number[],
  _actor?: string,
) {
  if (!itemIds.length) return [];
  const results = [];
  for (const id of itemIds) {
    const item = await getItemOrThrow(tx, id);
    if (item.archivedAt) {
      results.push(item);
      continue;
    }
    const [updated] = await tx.update(inventoryItemsTable).set({
      archivedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(inventoryItemsTable.id, id)).returning();
    if (updated) results.push(updated);
  }
  return results;
}
