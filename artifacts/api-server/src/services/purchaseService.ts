/**
 * Purchase records — financial/order lines. Do NOT mutate stock here.
 */

import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { dailyPurchasesTable } from "@workspace/db";
import { AppError } from "../lib/errors";

export type PurchaseWrite = {
  id?: number;
  purchaseDate: string;
  purchaseTime?: string;
  supplier: string;
  itemName: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalAmount?: number;
  paidBy?: string;
  receivedBy?: string;
  paymentMethod?: string;
  inventoryItemId?: number | null;
  notes?: string;
  invoiceNumber?: string;
  destination?: "warehouse" | "kitchen" | "none";
};

export function computePurchaseTotal(quantity: number, unitPrice: number) {
  return Math.round(quantity * unitPrice * 100) / 100;
}

export async function listPurchasesByDate(date?: string) {
  if (date) {
    return db.select().from(dailyPurchasesTable)
      .where(eq(dailyPurchasesTable.purchaseDate, date))
      .orderBy(desc(dailyPurchasesTable.createdAt))
      .limit(500);
  }
  return db.select().from(dailyPurchasesTable)
    .orderBy(desc(dailyPurchasesTable.purchaseDate), desc(dailyPurchasesTable.createdAt))
    .limit(500);
}

/**
 * Delete only never-received purchases.
 * If any quantity was received, hard delete is refused — history must stay.
 */
export async function assertPurchasesDeletable(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], deleteIds: number[]) {
  if (!deleteIds.length) return;
  const rows = await tx.select().from(dailyPurchasesTable)
    .where(inArray(dailyPurchasesTable.id, deleteIds));
  for (const row of rows) {
    const received = Number(row.quantityReceived || 0);
    const status = String(row.status || "");
    if (received > 0.0001 || status === "received" || status === "partially_received") {
      throw new AppError(
        "PURCHASE_HAS_RECEIVING",
        `Cannot delete purchase #${row.id} — it has receiving history (received ${received}). Archive/cancel instead; do not erase received purchases.`,
        409,
        { purchaseId: row.id, quantityReceived: received, status },
      );
    }
  }
  const missing = deleteIds.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    // Allow deleting unknown ids as no-op after filter — still delete what exists
  }
}

export async function cancelPurchase(purchaseId: number) {
  return db.transaction(async (tx) => {
    const purchase = await tx.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchaseId),
    });
    if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${purchaseId} not found`, 404);
    if (Number(purchase.quantityReceived || 0) > 0.0001) {
      throw new AppError(
        "PURCHASE_HAS_RECEIVING",
        `Cannot cancel purchase #${purchaseId} after receiving. Reverse receives first if correction is needed.`,
        409,
      );
    }
    const [updated] = await tx.update(dailyPurchasesTable).set({
      status: "cancelled",
    }).where(eq(dailyPurchasesTable.id, purchaseId)).returning();
    return updated;
  });
}

export async function upsertPurchases(rows: PurchaseWrite[], deleteIds: number[] = []) {
  return db.transaction(async (tx) => {
    if (deleteIds.length) {
      await assertPurchasesDeletable(tx, deleteIds);
      await tx.delete(dailyPurchasesTable).where(inArray(dailyPurchasesTable.id, deleteIds));
    }

    const results = [];
    for (const row of rows) {
      if (!(row.quantity > 0)) throw new AppError("VALIDATION_ERROR", "quantity must be > 0");
      if (!row.itemName?.trim()) throw new AppError("VALIDATION_ERROR", "itemName required");
      const totalAmount = row.totalAmount ?? computePurchaseTotal(row.quantity, row.unitPrice);
      const payload = {
        purchaseDate: row.purchaseDate,
        purchaseTime: row.purchaseTime ?? "",
        supplier: row.supplier.trim() || "-",
        itemName: row.itemName.trim(),
        category: (row.category ?? "").trim() || "General",
        quantity: row.quantity,
        unit: row.unit.trim() || "kg",
        unitPrice: row.unitPrice,
        totalAmount,
        paidBy: (row.paidBy ?? "").trim() || "-",
        receivedBy: (row.receivedBy ?? "").trim() || "-",
        paymentMethod: (row.paymentMethod ?? "Cash").trim() || "Cash",
        inventoryItemId: row.inventoryItemId ?? null,
        destination: row.destination ?? "none",
        addToStock: "no" as const,
        notes: row.notes ?? "",
        invoiceNumber: row.invoiceNumber ?? "",
      };

      if (row.id) {
        const existing = await tx.query.dailyPurchasesTable.findFirst({
          where: eq(dailyPurchasesTable.id, row.id),
        });
        if (!existing) continue;
        const [updated] = await tx.update(dailyPurchasesTable).set({
          ...payload,
          status: existing.status,
          quantityReceived: existing.quantityReceived,
          addToStock: existing.addToStock,
        }).where(eq(dailyPurchasesTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(dailyPurchasesTable).values({
          ...payload,
          quantityReceived: 0,
          status: "ordered",
        }).returning();
        results.push(created);
      }
    }
    return results;
  });
}
