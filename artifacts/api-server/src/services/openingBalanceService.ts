/**
 * Warehouse Opening Balance — formal initial warehouse stock.
 * Reuses Inventory Core: applyLocationDelta + warehouse_lots + recordMovement.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, inventoryMovementsTable, warehouseLotsTable } from "@workspace/db";
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

export type OpeningBalanceLineInput = {
  itemId: number;
  quantity: number;
  unit?: string;
  unitCost?: number;
  brand?: string;
  note?: string;
};

export type OpeningBalanceInput = {
  lines: OpeningBalanceLineInput[];
  asOfDate?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  /** When true, allow another opening line on an item that already has one. Default false. */
  allowDuplicateItems?: boolean;
  /** Idempotency key — repeating the same key returns prior result without double stock. */
  clientRequestId?: string;
};

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function findExistingRequestBatch(tx: DbTx | typeof db, clientRequestId: string) {
  return tx
    .select()
    .from(inventoryMovementsTable)
    .where(
      and(
        eq(inventoryMovementsTable.type, "opening_balance"),
        eq(inventoryMovementsTable.method, `opening_balance:${clientRequestId}`),
      ),
    )
    .limit(200);
}

async function unrevertedOpeningItemIds(tx: DbTx | typeof db, itemIds: number[]) {
  if (!itemIds.length) return new Set<number>();
  const openings = await tx
    .select({
      id: inventoryMovementsTable.id,
      itemId: inventoryMovementsTable.itemId,
    })
    .from(inventoryMovementsTable)
    .where(
      and(
        eq(inventoryMovementsTable.type, "opening_balance"),
        inArray(inventoryMovementsTable.itemId, itemIds),
      ),
    );

  if (!openings.length) return new Set<number>();

  const openingIds = openings.map((o) => o.id);
  const reversals = await tx
    .select({ reversalOfId: inventoryMovementsTable.reversalOfId })
    .from(inventoryMovementsTable)
    .where(
      and(
        eq(inventoryMovementsTable.type, "reversal"),
        inArray(inventoryMovementsTable.reversalOfId, openingIds),
      ),
    );
  const reversed = new Set(
    reversals.map((r) => r.reversalOfId).filter((id): id is number => id != null),
  );

  const blocked = new Set<number>();
  for (const o of openings) {
    if (!reversed.has(o.id)) blocked.add(o.itemId);
  }
  return blocked;
}

export async function postWarehouseOpeningBalance(input: OpeningBalanceInput, outerTx?: DbTx) {
  if (!input.actor?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Actor is required for opening balance");
  }
  const lines = (input.lines || []).filter((l) => l && Number(l.quantity) > 0);
  if (!lines.length) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one opening balance line with quantity > 0 is required",
    );
  }

  const run = async (tx: DbTx | typeof db) => {
    const clientRequestId = input.clientRequestId?.trim();
    if (clientRequestId) {
      const existing = await findExistingRequestBatch(tx, clientRequestId);
      if (existing.length) {
        return {
          success: true as const,
          idempotent: true,
          clientRequestId,
          asOfDate: input.asOfDate || todayISO(),
          lineCount: existing.length,
          totalValue: existing.reduce(
            (n, m) => n + Number(m.quantity) * Number(m.unitCost || 0),
            0,
          ),
          lines: existing.map((m) => ({
            itemId: m.itemId,
            itemName: "",
            quantity: Number(m.baseQuantity ?? m.quantity),
            unit: m.unit || "",
            unitCost: Number(m.unitCost || 0),
            lotId: m.lotId ?? 0,
            movementId: m.id,
            warehouseStock: 0,
          })),
          movements: existing,
        };
      }
    }

    const itemIds = lines.map((l) => l.itemId);
    if (!input.allowDuplicateItems) {
      const blocked = await unrevertedOpeningItemIds(tx, itemIds);
      if (blocked.size) {
        throw new AppError(
          "CONFLICT",
          `Opening balance already recorded for item(s): ${[...blocked].join(", ")}. Reverse the prior opening movement before submitting again.`,
          409,
          { itemIds: [...blocked] },
        );
      }
    }

    const seen = new Set<number>();
    for (const line of lines) {
      if (seen.has(line.itemId)) {
        throw new AppError(
          "VALIDATION_ERROR",
          `Duplicate itemId ${line.itemId} in the same opening balance request`,
        );
      }
      seen.add(line.itemId);
    }

    const asOfDate = input.asOfDate || todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      throw new AppError("VALIDATION_ERROR", "asOfDate must be YYYY-MM-DD");
    }

    const method = clientRequestId ? `opening_balance:${clientRequestId}` : "opening_balance";
    const results: Array<{
      itemId: number;
      itemName: string;
      quantity: number;
      unit: string;
      unitCost: number;
      lotId: number;
      movementId: number;
      warehouseStock: number;
    }> = [];

    let totalValue = 0;

    for (const line of lines) {
      const item = await getItemOrThrow(tx, line.itemId);
      assertItemOperable(item);
      const unit = line.unit?.trim() || item.unit;
      const qtyBase = convertToBaseUnit(Number(line.quantity), unit, item.unit);
      const unitCost =
        line.unitCost != null ? Number(line.unitCost) : Number(item.costPerUnit) || 0;
      if (!(unitCost >= 0) || !Number.isFinite(unitCost)) {
        throw new AppError("VALIDATION_ERROR", `Invalid unit cost for item #${item.id}`);
      }

      const noteParts = [
        "Warehouse opening balance",
        asOfDate,
        input.notes?.trim() || null,
        line.note?.trim() || null,
      ].filter(Boolean);

      const [lot] = await tx
        .insert(warehouseLotsTable)
        .values({
          itemId: item.id,
          receiptDate: asOfDate,
          brand: line.brand ?? item.brand ?? "",
          quantityReceived: qtyBase,
          quantityRemaining: qtyBase,
          costPerUnit: unitCost,
          note: noteParts.join(" | "),
          actor: input.actor.trim(),
          purchaseId: null,
        })
        .returning();

      await applyLocationDelta(tx, {
        itemId: item.id,
        location: "warehouse",
        delta: qtyBase,
        costPerUnit: unitCost,
      });

      const movement = await recordMovement(tx, {
        itemId: item.id,
        type: "opening_balance",
        location: "warehouse",
        quantity: qtyBase,
        baseQuantity: qtyBase,
        unit: item.unit,
        unitCost,
        note: noteParts.join(" | "),
        actor: input.actor.trim(),
        userId: input.userId ?? null,
        lotId: lot.id,
        lotAllocations: serializeLotAllocations([{ lotId: lot.id, quantity: qtyBase }]),
        method,
      });

      const updated = await getItemOrThrow(tx, item.id);
      totalValue += qtyBase * unitCost;
      results.push({
        itemId: item.id,
        itemName: item.name,
        quantity: qtyBase,
        unit: item.unit,
        unitCost,
        lotId: lot.id,
        movementId: movement.id,
        warehouseStock: Number(updated.currentStock),
      });
    }

    return {
      success: true as const,
      idempotent: false,
      clientRequestId: clientRequestId || null,
      asOfDate,
      lineCount: results.length,
      totalValue,
      lines: results,
    };
  };

  if (outerTx) return run(outerTx);
  return db.transaction(async (tx) => run(tx));
}

export async function countActiveOpeningBalances() {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(inventoryMovementsTable)
    .where(eq(inventoryMovementsTable.type, "opening_balance"));
  return Number(row?.c ?? 0);
}
