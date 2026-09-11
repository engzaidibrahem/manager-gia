/**
 * Purchase payments ledger — paid purchases reduce Available Capital.
 * Never auto-insert into expenses (prevents double counting).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { dailyPurchasesTable, db, purchasePaymentsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import type { DbTx } from "./inventoryService";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function serialize(row: typeof purchasePaymentsTable.$inferSelect) {
  return {
    ...row,
    amount: Number(row.amount),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    voidedAt: row.voidedAt
      ? (row.voidedAt instanceof Date ? row.voidedAt.toISOString() : String(row.voidedAt))
      : null,
  };
}

export type PostPurchasePaymentInput = {
  purchaseId: number;
  amount: number;
  paymentDate: string;
  paymentMethod?: string;
  actor: string;
  userId?: number | null;
  notes?: string;
  clientRequestId?: string;
};

export async function findActivePaymentForPurchase(tx: DbTx | typeof db, purchaseId: number) {
  const rows = await tx.select().from(purchasePaymentsTable)
    .where(and(
      eq(purchasePaymentsTable.purchaseId, purchaseId),
      eq(purchasePaymentsTable.status, "active"),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/** Post payment inside an existing transaction (used by receive-goods). */
export async function postPurchasePaymentInTx(tx: DbTx, input: PostPurchasePaymentInput) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new AppError("VALIDATION_ERROR", "Payment amount must be positive", 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
    throw new AppError("VALIDATION_ERROR", "paymentDate must be YYYY-MM-DD", 400);
  }
  const actor = (input.actor || "").trim();
  if (!actor) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);

  const clientRequestId = input.clientRequestId?.trim() || null;
  if (clientRequestId) {
    const existing = await tx.select().from(purchasePaymentsTable)
      .where(eq(purchasePaymentsTable.clientRequestId, clientRequestId))
      .limit(1);
    if (existing[0]) {
      return { payment: serialize(existing[0]), idempotent: true as const };
    }
  }

  const purchase = await tx.query.dailyPurchasesTable.findFirst({
    where: eq(dailyPurchasesTable.id, input.purchaseId),
  });
  if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${input.purchaseId} not found`, 404);
  if (purchase.status === "cancelled") {
    throw new AppError("PURCHASE_CANCELLED", "Cannot pay a cancelled purchase");
  }

  const active = await findActivePaymentForPurchase(tx, input.purchaseId);
  if (active) {
    throw new AppError(
      "CONFLICT",
      "This purchase already has an active payment. Void it before posting another.",
      409,
      { paymentId: active.id },
    );
  }

  const [row] = await tx.insert(purchasePaymentsTable).values({
    purchaseId: input.purchaseId,
    amount: round2(input.amount),
    paymentDate: input.paymentDate,
    paymentMethod: (input.paymentMethod ?? "Transfer").trim() || "Transfer",
    actor,
    userId: input.userId ?? null,
    status: "active",
    clientRequestId,
    notes: (input.notes ?? "").trim(),
  }).returning();

  return { payment: serialize(row!), idempotent: false as const };
}

export async function postPurchasePayment(input: PostPurchasePaymentInput) {
  return db.transaction(async (tx) => postPurchasePaymentInTx(tx, input));
}

export async function voidPurchasePayment(input: {
  id: number;
  actor: string;
  reason?: string;
}) {
  const actor = (input.actor || "").trim();
  if (!actor) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(purchasePaymentsTable)
      .where(eq(purchasePaymentsTable.id, input.id))
      .limit(1);
    if (!row) throw new AppError("VALIDATION_ERROR", "Purchase payment not found", 404);
    if (row.status === "voided") {
      return { payment: serialize(row), alreadyVoided: true as const };
    }
    const [updated] = await tx.update(purchasePaymentsTable).set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: actor,
      voidReason: (input.reason ?? "").trim() || "voided",
    }).where(and(
      eq(purchasePaymentsTable.id, input.id),
      eq(purchasePaymentsTable.status, "active"),
    )).returning();
    return { payment: serialize(updated ?? row), alreadyVoided: false as const };
  });
}

export async function listPurchasePayments(opts?: { includeVoided?: boolean; limit?: number }) {
  const limit = opts?.limit ?? 200;
  const rows = opts?.includeVoided
    ? await db.select().from(purchasePaymentsTable)
      .orderBy(desc(purchasePaymentsTable.paymentDate), desc(purchasePaymentsTable.id))
      .limit(limit)
    : await db.select().from(purchasePaymentsTable)
      .where(eq(purchasePaymentsTable.status, "active"))
      .orderBy(desc(purchasePaymentsTable.paymentDate), desc(purchasePaymentsTable.id))
      .limit(limit);
  return rows.map(serialize);
}

export async function getTotalActivePurchasePayments(tx?: DbTx | typeof db) {
  const database = tx ?? db;
  const [row] = await database
    .select({ total: sql<number>`coalesce(sum(${purchasePaymentsTable.amount}), 0)` })
    .from(purchasePaymentsTable)
    .where(eq(purchasePaymentsTable.status, "active"));
  return round2(Number(row?.total ?? 0));
}

/** Categories that must not be used to re-post purchase cost as an expense. */
export const FORBIDDEN_PURCHASE_EXPENSE_CATEGORIES = new Set([
  "purchase",
  "purchases",
  "pembelian",
  "مشتريات",
  "purchase payment",
  "purchase_payment",
]);

const OBVIOUS_OPERATIONAL_CATEGORIES = new Set([
  "rent",
  "electricity",
  "maintenance",
  "transport",
  "salary",
  "salaries",
  "wage",
  "wages",
  "other",
  "sewa",
  "listrik",
  "perawatan",
  "إيجار",
  "كهرباء",
  "صيانة",
  "نقل",
  "رواتب",
]);

/**
 * True when an expense row is (or was) a purchase cost booked as an expense.
 * Historical data often used category "Pembelian / مشتريات" or descriptions like "مشتريات من …".
 */
export function isPurchaseLikeExpense(input: {
  category?: string | null;
  description?: string | null;
  notes?: string | null;
}): boolean {
  const cat = (input.category ?? "").trim().toLowerCase();
  const desc = (input.description ?? "").trim().toLowerCase();
  const notes = (input.notes ?? "").trim().toLowerCase();

  if (FORBIDDEN_PURCHASE_EXPENSE_CATEGORIES.has(cat)) return true;
  if (/pembelian|purchase|مشتريات/.test(cat)) return true;
  if (/مشتريات|مشترياات|pembelian|\bpurchase\b/.test(desc)) return true;
  if (notes.startsWith("destination:")) return true;
  return false;
}

type ExpenseLikeRow = {
  id: number;
  category: string;
  description: string;
  notes?: string | null;
  amount: number | string;
  expenseDate: string;
  status?: string | null;
};

/**
 * Expand purchase-like detection to same-day / same-amount siblings
 * (e.g. "شوبي" next to "مشتريات من شوبي" for Rp 2,000,000).
 * Does not destroy rows — callers soft-void or exclude from operational totals.
 */
export function expandPurchaseLikeExpenseIds(rows: ExpenseLikeRow[]): Set<number> {
  const active = rows.filter((r) => (r.status ?? "active") === "active");
  const ids = new Set<number>();
  for (const r of active) {
    if (isPurchaseLikeExpense(r)) ids.add(r.id);
  }
  const anchors = active.filter((r) => ids.has(r.id));
  for (const pl of anchors) {
    const amt = Number(pl.amount);
    for (const r of active) {
      if (ids.has(r.id)) continue;
      if (r.expenseDate !== pl.expenseDate) continue;
      if (Number(r.amount) !== amt) continue;
      const cat = r.category.trim().toLowerCase();
      if (OBVIOUS_OPERATIONAL_CATEGORIES.has(cat)) continue;
      const d = r.description.trim();
      if (d.length > 48) continue;
      if (/rent|electric|salary|sewa|listrik|إيجار|كهرباء|راتب/i.test(d)) continue;
      ids.add(r.id);
    }
  }
  return ids;
}

export function assertExpenseNotPurchaseDuplicate(category: string, description: string) {
  if (isPurchaseLikeExpense({ category, description })) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Do not record purchases as expenses. Use Receive Goods / purchase payment so Available Capital is not double-counted.",
      400,
    );
  }
  const desc = description.trim().toLowerCase();
  if (/\bpurchase\s*payment\b|دفع\s*مشتريات|pembayaran\s*pembelian/.test(desc)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Description looks like a purchase payment. Post payment via purchases, not expenses.",
      400,
    );
  }
}
