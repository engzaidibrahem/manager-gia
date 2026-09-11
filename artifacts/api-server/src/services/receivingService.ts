/**
 * Receiving — warehouse inbound stock + lot, optionally linked to a purchase.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { dailyPurchasesTable, warehouseLotsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import { convertToBaseUnit } from "../lib/units";
import {
  applyLocationDelta,
  assertItemOperable,
  getItemOrThrow,
  recordMovement,
  type DbTx,
} from "./inventoryService";
import { serializeLotAllocations } from "./lotFifo";

export type ReceiveInput = {
  itemId: number;
  quantity: number;
  unit?: string;
  unitCost?: number;
  brand?: string;
  note?: string;
  actor: string;
  userId?: number | null;
  purchaseId?: number | null;
  receiptDate?: string;
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function receiveIntoWarehouse(input: ReceiveInput, outerTx?: DbTx) {
  const run = async (tx: DbTx | typeof db) => {
    const item = await getItemOrThrow(tx, input.itemId);
    assertItemOperable(item);
    const unit = input.unit?.trim() || item.unit;
    const qtyBase = convertToBaseUnit(input.quantity, unit, item.unit);
    const unitCost = input.unitCost != null ? Number(input.unitCost) : Number(item.costPerUnit) || 0;
    const receiptDate = input.receiptDate || todayISO();

    let purchaseId = input.purchaseId ?? null;
    if (purchaseId) {
      const purchase = await tx.query.dailyPurchasesTable.findFirst({
        where: eq(dailyPurchasesTable.id, purchaseId),
      });
      if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${purchaseId} not found`, 404);
      if (purchase.status === "cancelled") {
        throw new AppError("PURCHASE_CANCELLED", "Cannot receive a cancelled purchase");
      }
      const ordered = Number(purchase.quantity);
      const already = Number(purchase.quantityReceived || 0);
      // Convert receive qty into purchase unit for remaining check when units differ
      let receiveInPurchaseUnit = qtyBase;
      try {
        receiveInPurchaseUnit = convertToBaseUnit(qtyBase, item.unit, purchase.unit);
      } catch {
        receiveInPurchaseUnit = qtyBase;
      }
      if (already + receiveInPurchaseUnit > ordered + 0.0001) {
        throw new AppError(
          "RECEIVE_EXCEEDS_REMAINING",
          `Receive would exceed ordered qty. Ordered ${ordered}, already received ${already}`,
          400,
          { ordered, alreadyReceived: already, attempting: receiveInPurchaseUnit },
        );
      }
      const nextReceived = already + receiveInPurchaseUnit;
      const status = nextReceived + 0.0001 >= ordered ? "received" : "partially_received";
      await tx.update(dailyPurchasesTable).set({
        quantityReceived: nextReceived,
        status,
      }).where(eq(dailyPurchasesTable.id, purchaseId));
    }

    const [lot] = await tx.insert(warehouseLotsTable).values({
      itemId: item.id,
      receiptDate,
      brand: input.brand ?? item.brand ?? "",
      quantityReceived: qtyBase,
      quantityRemaining: qtyBase,
      costPerUnit: unitCost,
      note: input.note ?? "",
      actor: input.actor,
      purchaseId,
    }).returning();

    await applyLocationDelta(tx, {
      itemId: item.id,
      location: "warehouse",
      delta: qtyBase,
      costPerUnit: unitCost,
    });

    const movement = await recordMovement(tx, {
      itemId: item.id,
      type: "receive",
      location: "warehouse",
      quantity: qtyBase,
      baseQuantity: qtyBase,
      unit: item.unit,
      unitCost,
      note: input.note ?? "Receiving",
      actor: input.actor,
      userId: input.userId ?? null,
      purchaseId,
      lotId: lot.id,
      lotAllocations: serializeLotAllocations([{ lotId: lot.id, quantity: qtyBase }]),
      method: "receive",
    });

    const updated = await getItemOrThrow(tx, item.id);
    return {
      success: true as const,
      lot,
      movement,
      item: updated,
      warehouseStock: Number(updated.currentStock),
      kitchenStock: Number(updated.kitchenStock),
      quantity: qtyBase,
      unit: item.unit,
    };
  };

  if (outerTx) return run(outerTx);
  return db.transaction(async (tx) => run(tx));
}

/** Receive against a purchase id (uses purchase qty remaining / unit / cost). */
export async function receivePurchase(
  purchaseId: number,
  input: { quantity: number; unit?: string; note?: string; actor: string; userId?: number | null },
) {
  return db.transaction(async (tx) => {
    const purchase = await tx.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchaseId),
    });
    if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${purchaseId} not found`, 404);
    if (!purchase.inventoryItemId) {
      throw new AppError("VALIDATION_ERROR", "Purchase has no inventory item link");
    }
    if (purchase.status === "cancelled") {
      throw new AppError("PURCHASE_CANCELLED", "Cannot receive a cancelled purchase");
    }
    if (purchase.status === "received") {
      throw new AppError("PURCHASE_ALREADY_RECEIVED", "Purchase is already fully received");
    }

    return receiveIntoWarehouse({
      itemId: purchase.inventoryItemId,
      quantity: input.quantity,
      unit: input.unit || purchase.unit,
      unitCost: Number(purchase.unitPrice) || 0,
      note: input.note ?? `Receive purchase #${purchaseId}: ${purchase.itemName}`,
      actor: input.actor,
      userId: input.userId,
      purchaseId,
      receiptDate: purchase.purchaseDate,
    }, tx);
  });
}
