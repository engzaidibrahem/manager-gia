/**
 * Warehouse lot FIFO consume / restore — shared by Transfer, Waste, Adjustment, Reversal.
 */

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, warehouseLotsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import type { DbTx } from "./inventoryService";

export type LotAllocation = { lotId: number; quantity: number };

export function serializeLotAllocations(allocations: LotAllocation[]): string | null {
  if (!allocations.length) return null;
  return JSON.stringify(allocations);
}

export function parseLotAllocations(raw: string | null | undefined): LotAllocation[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        lotId: Number((row as { lotId?: unknown }).lotId),
        quantity: Number((row as { quantity?: unknown }).quantity),
      }))
      .filter((row) => Number.isFinite(row.lotId) && row.lotId > 0 && Number.isFinite(row.quantity) && row.quantity > 0);
  } catch {
    return [];
  }
}

/** Consume warehouse lots FIFO (or preferred lot). Returns exact allocations for audit/reversal. */
export async function consumeWarehouseLots(
  tx: DbTx | typeof db,
  itemId: number,
  qtyBase: number,
  preferredLotId?: number | null,
): Promise<{ lotId: number | null; unitCost: number; allocations: LotAllocation[] }> {
  let remaining = qtyBase;
  const allocations: LotAllocation[] = [];
  let lastLotId: number | null = null;
  let unitCost = 0;
  const unitHint = "units";

  await tx.execute(sql`
    SELECT id FROM warehouse_lots
    WHERE item_id = ${itemId} AND quantity_remaining > 0
    ORDER BY receipt_date ASC, id ASC
    FOR UPDATE
  `);

  if (preferredLotId) {
    const lot = await tx.query.warehouseLotsTable.findFirst({
      where: and(eq(warehouseLotsTable.id, preferredLotId), eq(warehouseLotsTable.itemId, itemId)),
    });
    if (!lot) throw new AppError("LOT_NOT_FOUND", `Lot ${preferredLotId} not found`, 404);
    const avail = Number(lot.quantityRemaining);
    if (avail + 0.0001 < remaining) {
      throw new AppError(
        "INSUFFICIENT_STOCK",
        `Insufficient warehouse stock. Available: ${avail} ${unitHint}, requested: ${remaining} ${unitHint}.`,
        400,
        { lotId: preferredLotId, available: avail, requested: remaining },
      );
    }
    const [updated] = await tx.update(warehouseLotsTable).set({
      quantityRemaining: sql`${warehouseLotsTable.quantityRemaining} - ${remaining}`,
    }).where(and(
      eq(warehouseLotsTable.id, lot.id),
      sql`${warehouseLotsTable.quantityRemaining} >= ${remaining} - 0.0001`,
    )).returning();
    if (!updated) {
      throw new AppError("INSUFFICIENT_STOCK", `Lot ${preferredLotId} could not be consumed (concurrent update)`);
    }
    return {
      lotId: lot.id,
      unitCost: Number(lot.costPerUnit) || 0,
      allocations: [{ lotId: lot.id, quantity: remaining }],
    };
  }

  const lots = await tx.select().from(warehouseLotsTable)
    .where(and(
      eq(warehouseLotsTable.itemId, itemId),
      gt(warehouseLotsTable.quantityRemaining, 0),
    ))
    .orderBy(asc(warehouseLotsTable.receiptDate), asc(warehouseLotsTable.id));

  if (!lots.length) {
    return { lotId: null, unitCost: 0, allocations: [] };
  }

  const totalLot = lots.reduce((s, l) => s + Number(l.quantityRemaining), 0);
  if (totalLot + 0.0001 < remaining) {
    throw new AppError(
      "INSUFFICIENT_STOCK",
      `Insufficient warehouse stock. Available: ${totalLot} (lots), requested: ${remaining}.`,
      400,
      { availableLots: totalLot, requested: remaining },
    );
  }

  for (const lot of lots) {
    if (remaining <= 0.0001) break;
    const avail = Number(lot.quantityRemaining);
    const take = Math.min(avail, remaining);
    if (take <= 0) continue;
    const [updated] = await tx.update(warehouseLotsTable).set({
      quantityRemaining: sql`${warehouseLotsTable.quantityRemaining} - ${take}`,
    }).where(and(
      eq(warehouseLotsTable.id, lot.id),
      sql`${warehouseLotsTable.quantityRemaining} >= ${take} - 0.0001`,
    )).returning();
    if (!updated) {
      throw new AppError("INSUFFICIENT_STOCK", "Concurrent lot update failed — retry the transfer");
    }
    allocations.push({ lotId: lot.id, quantity: take });
    lastLotId = lot.id;
    unitCost = Number(lot.costPerUnit) || unitCost;
    remaining -= take;
  }

  if (remaining > 0.0001) {
    throw new AppError(
      "INSUFFICIENT_STOCK",
      `Insufficient warehouse stock after FIFO. Remaining unmet: ${remaining}.`,
    );
  }

  return { lotId: lastLotId, unitCost, allocations };
}

/** Restore exact lot quantities from a prior FIFO consume (reversal). */
export async function restoreWarehouseLots(
  tx: DbTx | typeof db,
  allocations: LotAllocation[],
) {
  if (!allocations.length) return;

  for (const alloc of allocations) {
    await tx.execute(sql`SELECT id FROM warehouse_lots WHERE id = ${alloc.lotId} FOR UPDATE`);
    const [updated] = await tx.update(warehouseLotsTable).set({
      quantityRemaining: sql`${warehouseLotsTable.quantityRemaining} + ${alloc.quantity}`,
    }).where(eq(warehouseLotsTable.id, alloc.lotId)).returning();
    if (!updated) {
      throw new AppError(
        "LOT_NOT_FOUND",
        `Cannot restore lot #${alloc.lotId} — lot missing (history integrity failure)`,
        409,
      );
    }
  }
}

/** Reduce a receive lot remaining for receive-reversal (fails if partially consumed beyond remaining). */
export async function reverseReceiveLot(
  tx: DbTx | typeof db,
  lotId: number,
  qtyBase: number,
) {
  await tx.execute(sql`SELECT id FROM warehouse_lots WHERE id = ${lotId} FOR UPDATE`);
  const lot = await tx.query.warehouseLotsTable.findFirst({
    where: eq(warehouseLotsTable.id, lotId),
  });
  if (!lot) {
    throw new AppError("LOT_NOT_FOUND", `Lot ${lotId} not found for receive reversal`, 404);
  }
  const remaining = Number(lot.quantityRemaining);
  if (remaining + 0.0001 < qtyBase) {
    throw new AppError(
      "CONFLICT",
      `Cannot reverse receive: lot #${lotId} was partially consumed (remaining ${remaining}, need ${qtyBase}). Reverse outbound movements first.`,
      409,
      { lotId, remaining, requested: qtyBase },
    );
  }
  const [updated] = await tx.update(warehouseLotsTable).set({
    quantityRemaining: sql`${warehouseLotsTable.quantityRemaining} - ${qtyBase}`,
  }).where(and(
    eq(warehouseLotsTable.id, lotId),
    sql`${warehouseLotsTable.quantityRemaining} >= ${qtyBase} - 0.0001`,
  )).returning();
  if (!updated) {
    throw new AppError("CONFLICT", `Concurrent update prevented receive reversal for lot #${lotId}`, 409);
  }
  return updated;
}
