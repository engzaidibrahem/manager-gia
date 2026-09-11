/**
 * Capital Register + Available Capital summary.
 *
 * AvailableCapital =
 *   Σ active capital
 *   + Σ active income
 *   − Σ active expenses
 *   − Σ active purchase_payments
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  capitalEntriesTable,
  db,
  expensesTable,
  incomeTable,
} from "@workspace/db";
import { AppError } from "../lib/errors";
import { getTotalActivePurchasePayments } from "./purchasePaymentService";

export const CAPITAL_TYPES = ["initial_capital", "additional_capital"] as const;
export type CapitalType = (typeof CAPITAL_TYPES)[number];

export type CreateCapitalInput = {
  entryDate: string;
  entryType: CapitalType;
  amount: number;
  description?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
};

export type VoidCapitalInput = {
  id: number;
  actor: string;
  reason?: string;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function assertPositiveAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("VALIDATION_ERROR", "Amount must be a positive number", 400);
  }
}

function assertDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError("VALIDATION_ERROR", "entryDate must be YYYY-MM-DD", 400);
  }
}

function assertType(entryType: string): asserts entryType is CapitalType {
  if (!CAPITAL_TYPES.includes(entryType as CapitalType)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "entryType must be initial_capital or additional_capital",
      400,
    );
  }
}

function serialize(row: typeof capitalEntriesTable.$inferSelect) {
  return {
    ...row,
    amount: Number(row.amount),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    voidedAt: row.voidedAt
      ? (row.voidedAt instanceof Date ? row.voidedAt.toISOString() : String(row.voidedAt))
      : null,
  };
}

export async function listCapitalEntries(opts?: {
  includeVoided?: boolean;
  limit?: number;
}) {
  const limit = opts?.limit ?? 200;
  const rows = opts?.includeVoided
    ? await db.select().from(capitalEntriesTable)
      .orderBy(desc(capitalEntriesTable.entryDate), desc(capitalEntriesTable.id))
      .limit(limit)
    : await db.select().from(capitalEntriesTable)
      .where(eq(capitalEntriesTable.status, "active"))
      .orderBy(desc(capitalEntriesTable.entryDate), desc(capitalEntriesTable.id))
      .limit(limit);
  return rows.map(serialize);
}

export async function createCapitalEntry(input: CreateCapitalInput) {
  assertDate(input.entryDate);
  assertType(input.entryType);
  assertPositiveAmount(input.amount);

  const clientRequestId = input.clientRequestId?.trim() || null;
  const actor = (input.actor || "").trim();
  if (!actor) {
    throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);
  }

  return db.transaction(async (tx) => {
    if (clientRequestId) {
      const existing = await tx.select().from(capitalEntriesTable)
        .where(eq(capitalEntriesTable.clientRequestId, clientRequestId))
        .limit(1);
      if (existing[0]) {
        return { entry: serialize(existing[0]), idempotent: true as const };
      }
    }

    const [row] = await tx.insert(capitalEntriesTable).values({
      entryDate: input.entryDate,
      entryType: input.entryType,
      description: (input.description ?? "").trim(),
      amount: round2(input.amount),
      actor,
      userId: input.userId ?? null,
      status: "active",
      clientRequestId,
    }).returning();

    return { entry: serialize(row!), idempotent: false as const };
  });
}

export async function voidCapitalEntry(input: VoidCapitalInput) {
  const actor = (input.actor || "").trim();
  if (!actor) {
    throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(capitalEntriesTable)
      .where(eq(capitalEntriesTable.id, input.id))
      .limit(1);
    if (!row) {
      throw new AppError("VALIDATION_ERROR", "Capital entry not found", 404);
    }
    if (row.status === "voided") {
      return { entry: serialize(row), alreadyVoided: true as const };
    }

    const [updated] = await tx.update(capitalEntriesTable).set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: actor,
      voidReason: (input.reason ?? "").trim() || "voided",
    }).where(and(
      eq(capitalEntriesTable.id, input.id),
      eq(capitalEntriesTable.status, "active"),
    )).returning();

    return { entry: serialize(updated ?? row), alreadyVoided: false as const };
  });
}

export async function getCapitalTotals() {
  const [initial] = await db
    .select({ total: sql<number>`coalesce(sum(${capitalEntriesTable.amount}), 0)` })
    .from(capitalEntriesTable)
    .where(and(
      eq(capitalEntriesTable.status, "active"),
      eq(capitalEntriesTable.entryType, "initial_capital"),
    ));
  const [additional] = await db
    .select({ total: sql<number>`coalesce(sum(${capitalEntriesTable.amount}), 0)` })
    .from(capitalEntriesTable)
    .where(and(
      eq(capitalEntriesTable.status, "active"),
      eq(capitalEntriesTable.entryType, "additional_capital"),
    ));

  const totalInitialCapital = round2(Number(initial?.total ?? 0));
  const totalAdditionalCapital = round2(Number(additional?.total ?? 0));
  return {
    totalInitialCapital,
    totalAdditionalCapital,
    totalCapital: round2(totalInitialCapital + totalAdditionalCapital),
  };
}

async function sumActiveIncome() {
  const [inc] = await db
    .select({ total: sql<number>`coalesce(sum(${incomeTable.amount}), 0)` })
    .from(incomeTable)
    .where(eq(incomeTable.status, "active"));
  return round2(Number(inc?.total ?? 0));
}

/**
 * Operational expenses only — excludes purchase-like historical rows so
 * Available Capital is not double-counted with purchase_payments / invoices.
 */
export async function sumActiveOperationalExpenses() {
  const { expandPurchaseLikeExpenseIds, isPurchaseLikeExpense } = await import(
    "./purchasePaymentService"
  );
  const rows = await db.select().from(expensesTable).where(eq(expensesTable.status, "active"));
  const excludeIds = expandPurchaseLikeExpenseIds(rows);
  let operational = 0;
  let excludedPurchaseLike = 0;
  const suspected: Array<{
    id: number;
    category: string;
    description: string;
    amount: number;
    expenseDate: string;
    reason: string;
  }> = [];

  for (const r of rows) {
    const amount = Number(r.amount);
    if (excludeIds.has(r.id) || isPurchaseLikeExpense(r)) {
      excludedPurchaseLike += amount;
      suspected.push({
        id: r.id,
        category: r.category,
        description: r.description,
        amount,
        expenseDate: r.expenseDate,
        reason: isPurchaseLikeExpense(r)
          ? "purchase_like_category_or_description"
          : "same_day_same_amount_cluster",
      });
      continue;
    }
    operational += amount;
  }

  return {
    totalExpenses: round2(operational),
    excludedPurchaseLikeTotal: round2(excludedPurchaseLike),
    suspectedPurchaseExpenses: suspected,
  };
}

/**
 * Soft-void purchase-like expenses (audit preserved). Does NOT create purchase_payments.
 */
export async function softVoidSuspectedPurchaseExpenses(actor: string, reason?: string) {
  const a = (actor || "").trim();
  if (!a) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);
  const { expandPurchaseLikeExpenseIds } = await import("./purchasePaymentService");
  const rows = await db.select().from(expensesTable).where(eq(expensesTable.status, "active"));
  const ids = [...expandPurchaseLikeExpenseIds(rows)];
  if (!ids.length) {
    return { voidedCount: 0, voidedIds: [] as number[], totalVoidedAmount: 0 };
  }

  const voidReason = (reason ?? "").trim()
    || "legacy_purchase_as_expense — soft-void to prevent double-count with purchases/payments";
  const voided: number[] = [];
  let totalVoidedAmount = 0;

  await db.transaction(async (tx) => {
    for (const id of ids) {
      const [updated] = await tx.update(expensesTable).set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: a,
        voidReason,
      }).where(and(eq(expensesTable.id, id), eq(expensesTable.status, "active"))).returning();
      if (updated) {
        voided.push(id);
        totalVoidedAmount += Number(updated.amount);
      }
    }
  });

  return {
    voidedCount: voided.length,
    voidedIds: voided,
    totalVoidedAmount: round2(totalVoidedAmount),
  };
}

/**
 * Available Capital (persistent management figure):
 * Capital + Income − Operational Expenses − Paid purchase payments.
 */
export async function getAvailableCapitalSummary() {
  const capital = await getCapitalTotals();
  const totalIncome = await sumActiveIncome();
  const expensePart = await sumActiveOperationalExpenses();
  const totalExpenses = expensePart.totalExpenses;
  const totalPurchasePayments = await getTotalActivePurchasePayments();
  const availableCapital = round2(
    capital.totalCapital + totalIncome - totalExpenses - totalPurchasePayments,
  );

  return {
    ...capital,
    totalIncome,
    totalExpenses,
    totalPurchasePayments,
    availableCapital,
    /** @deprecated alias — prefer availableCapital */
    operationalBalance: availableCapital,
    excludedPurchaseLikeTotal: expensePart.excludedPurchaseLikeTotal,
    suspectedPurchaseExpenses: expensePart.suspectedPurchaseExpenses,
    note: "Available Capital = Capital + Income − Operational expenses − Paid purchases. Purchase-like expense rows are excluded (soft-void recommended).",
  };
}

/** @deprecated Use getAvailableCapitalSummary */
export async function getOperationalFinanceSummary() {
  return getAvailableCapitalSummary();
}

export async function voidExpense(id: number, actor: string, reason?: string) {
  const a = actor.trim();
  if (!a) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);
  const [row] = await db.select().from(expensesTable).where(eq(expensesTable.id, id)).limit(1);
  if (!row) throw new AppError("VALIDATION_ERROR", "Expense not found", 404);
  if (row.status === "voided") return { row, alreadyVoided: true as const };
  const [updated] = await db.update(expensesTable).set({
    status: "voided",
    voidedAt: new Date(),
    voidedBy: a,
    voidReason: (reason ?? "").trim() || "voided",
  }).where(and(eq(expensesTable.id, id), eq(expensesTable.status, "active"))).returning();
  return { row: updated ?? row, alreadyVoided: false as const };
}

export async function voidIncome(id: number, actor: string, reason?: string) {
  const a = actor.trim();
  if (!a) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);
  const [row] = await db.select().from(incomeTable).where(eq(incomeTable.id, id)).limit(1);
  if (!row) throw new AppError("VALIDATION_ERROR", "Income not found", 404);
  if (row.status === "voided") return { row, alreadyVoided: true as const };
  const [updated] = await db.update(incomeTable).set({
    status: "voided",
    voidedAt: new Date(),
    voidedBy: a,
    voidReason: (reason ?? "").trim() || "voided",
  }).where(and(eq(incomeTable.id, id), eq(incomeTable.status, "active"))).returning();
  return { row: updated ?? row, alreadyVoided: false as const };
}
