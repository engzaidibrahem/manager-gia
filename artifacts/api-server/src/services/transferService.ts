/**
 * Canonical Warehouse ↔ Kitchen transfer (lots/FIFO when leaving warehouse).
 * Concurrency: item row lock (via InventoryService) + lot row locks + conditional lot updates.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { inventoryItemsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import { convertToBaseUnit, type InventoryLocation } from "../lib/units";
import {
  applyLocationDelta,
  assertItemOperable,
  getItemOrThrow,
  recordMovement,
  type DbTx,
} from "./inventoryService";
import { consumeWarehouseLots, serializeLotAllocations } from "./lotFifo";

export type TransferInput = {
  itemId?: number;
  qrToken?: string;
  quantity: number;
  unit?: string;
  from?: InventoryLocation;
  to?: InventoryLocation;
  note?: string;
  actor: string;
  userId?: number | null;
  method?: "manual" | "qr" | "bulk" | string;
  lotId?: number | null;
};

async function resolveItem(tx: DbTx | typeof db, input: TransferInput) {
  if (input.itemId) return getItemOrThrow(tx, input.itemId);
  if (input.qrToken) {
    const item = await tx.query.inventoryItemsTable.findFirst({
      where: eq(inventoryItemsTable.qrToken, input.qrToken),
    });
    if (!item) throw new AppError("ITEM_NOT_FOUND", `No item for QR ${input.qrToken}`, 404);
    return item;
  }
  throw new AppError("VALIDATION_ERROR", "itemId or qrToken required");
}

export async function transferStock(input: TransferInput, outerTx?: DbTx) {
  const from = input.from ?? "warehouse";
  const to = input.to ?? "kitchen";
  if (from === to) {
    throw new AppError("VALIDATION_ERROR", "Transfer from/to must differ");
  }
  if (!input.actor?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Actor is required for transfers");
  }

  const run = async (tx: DbTx | typeof db) => {
    const item = await resolveItem(tx, input);
    assertItemOperable(item);
    const unit = input.unit?.trim() || item.unit;
    const qtyBase = convertToBaseUnit(input.quantity, unit, item.unit);

    let lotId: number | null = null;
    let unitCost = Number(item.costPerUnit) || 0;
    let lotAllocations: string | null = null;

    if (from === "warehouse") {
      const consumed = await consumeWarehouseLots(tx, item.id, qtyBase, input.lotId);
      lotId = consumed.lotId;
      lotAllocations = serializeLotAllocations(consumed.allocations);
      if (consumed.unitCost > 0) unitCost = consumed.unitCost;
    }

    await applyLocationDelta(tx, {
      itemId: item.id,
      location: from,
      delta: -qtyBase,
    });
    await applyLocationDelta(tx, {
      itemId: item.id,
      location: to,
      delta: qtyBase,
    });

    const movement = await recordMovement(tx, {
      itemId: item.id,
      type: "transfer",
      location: to,
      quantity: qtyBase,
      baseQuantity: qtyBase,
      unit: item.unit,
      unitCost,
      note: input.note ?? `${from} → ${to}`,
      actor: input.actor,
      userId: input.userId ?? null,
      lotId,
      lotAllocations,
      fromLocation: from,
      toLocation: to,
      method: input.method ?? "manual",
    });

    const updated = await getItemOrThrow(tx, item.id);
    return {
      success: true as const,
      item: updated.name,
      itemId: updated.id,
      unit: updated.unit,
      warehouseStock: Number(updated.currentStock),
      kitchenStock: Number(updated.kitchenStock),
      movementId: movement.id,
      quantity: qtyBase,
      from,
      to,
      timestamp: movement.createdAt.toISOString(),
    };
  };

  if (outerTx) return run(outerTx);
  return db.transaction(async (tx) => run(tx));
}
