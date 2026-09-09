/**
 * GIA V3 Simple Finance — capital + income + expenses + purchase payments.
 * AVAILABLE = net capital + income − expenses − purchase payments
 */
import { desc, eq } from "drizzle-orm";
import {
  db,
  v3CapitalTransactionsTable,
  v3ExpensesTable,
  v3IncomeTable,
  v3PurchasePaymentsTable,
} from "@workspace/db";
import { AppError } from "../lib/errors";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function getFinanceSummary() {
  const [capitalRows, incomeRows, expenseRows, paymentRows] = await Promise.all([
    db.select().from(v3CapitalTransactionsTable).where(eq(v3CapitalTransactionsTable.status, "active")),
    db.select().from(v3IncomeTable).where(eq(v3IncomeTable.status, "active")),
    db.select().from(v3ExpensesTable).where(eq(v3ExpensesTable.status, "active")),
    db.select().from(v3PurchasePaymentsTable).where(eq(v3PurchasePaymentsTable.status, "active")),
  ]);

  let netCapital = 0;
  for (const c of capitalRows) {
    const a = Number(c.amount);
    if (c.entryType === "ADD") netCapital += a;
    else if (c.entryType === "WITHDRAW") netCapital -= a;
    else if (c.entryType === "CORRECTION") netCapital += a;
  }

  const totalIncome = incomeRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalPurchasePayments = paymentRows.reduce((s, r) => s + Number(r.amount), 0);
  const available = netCapital + totalIncome - totalExpenses - totalPurchasePayments;

  return {
    netCapital,
    totalIncome,
    totalExpenses,
    totalPurchasePayments,
    available,
  };
}

export async function listCapital() {
  const rows = await db
    .select()
    .from(v3CapitalTransactionsTable)
    .where(eq(v3CapitalTransactionsTable.status, "active"))
    .orderBy(desc(v3CapitalTransactionsTable.entryDate), desc(v3CapitalTransactionsTable.id));
  return { rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

export async function postCapital(input: {
  entryDate?: string;
  entryType: "ADD" | "WITHDRAW" | "CORRECTION";
  amount: number;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3CapitalTransactionsTable.findFirst({
      where: eq(v3CapitalTransactionsTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) return { idempotent: true as const, row: existing };
  }
  const amount = Number(input.amount);
  if (!(amount > 0)) throw new AppError("VALIDATION_ERROR", "المبلغ يجب أن يكون أكبر من صفر");
  if (!["ADD", "WITHDRAW", "CORRECTION"].includes(input.entryType)) {
    throw new AppError("VALIDATION_ERROR", "نوع حركة رأس المال غير صالح");
  }

  const [row] = await db
    .insert(v3CapitalTransactionsTable)
    .values({
      entryDate: input.entryDate || todayISO(),
      entryType: input.entryType,
      amount,
      actor: input.actor,
      userId: input.userId ?? null,
      notes: input.notes || null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();
  return { idempotent: false as const, row };
}

export async function voidCapital(input: { id: number; voidedBy: string; voidReason: string }) {
  const row = await db.query.v3CapitalTransactionsTable.findFirst({
    where: eq(v3CapitalTransactionsTable.id, input.id),
  });
  if (!row) throw new AppError("MOVEMENT_NOT_FOUND", "الحركة غير موجودة", 404);
  if (row.status === "voided") return { idempotent: true as const, row };
  const [updated] = await db
    .update(v3CapitalTransactionsTable)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.voidReason,
    })
    .where(eq(v3CapitalTransactionsTable.id, input.id))
    .returning();
  return { idempotent: false as const, row: updated };
}

export async function listIncome() {
  const rows = await db
    .select()
    .from(v3IncomeTable)
    .where(eq(v3IncomeTable.status, "active"))
    .orderBy(desc(v3IncomeTable.incomeDate), desc(v3IncomeTable.id));
  return { rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

export async function postIncome(input: {
  incomeDate?: string;
  description: string;
  amount: number;
  receivedBy?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3IncomeTable.findFirst({
      where: eq(v3IncomeTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) return { idempotent: true as const, row: existing };
  }
  const amount = Number(input.amount);
  if (!(amount > 0)) throw new AppError("VALIDATION_ERROR", "المبلغ يجب أن يكون أكبر من صفر");
  const description = input.description.trim();
  if (!description) throw new AppError("VALIDATION_ERROR", "الوصف مطلوب");

  const [row] = await db
    .insert(v3IncomeTable)
    .values({
      incomeDate: input.incomeDate || todayISO(),
      description,
      amount,
      receivedBy: (input.receivedBy || "").trim(),
      notes: input.notes || null,
      actor: input.actor,
      userId: input.userId ?? null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();
  return { idempotent: false as const, row };
}

export async function voidIncome(input: { id: number; voidedBy: string; voidReason: string }) {
  const row = await db.query.v3IncomeTable.findFirst({ where: eq(v3IncomeTable.id, input.id) });
  if (!row) throw new AppError("MOVEMENT_NOT_FOUND", "السجل غير موجود", 404);
  if (row.status === "voided") return { idempotent: true as const, row };
  const [updated] = await db
    .update(v3IncomeTable)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.voidReason,
    })
    .where(eq(v3IncomeTable.id, input.id))
    .returning();
  return { idempotent: false as const, row: updated };
}

export async function listExpenses() {
  const rows = await db
    .select()
    .from(v3ExpensesTable)
    .where(eq(v3ExpensesTable.status, "active"))
    .orderBy(desc(v3ExpensesTable.expenseDate), desc(v3ExpensesTable.id));
  return { rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

export async function postExpense(input: {
  expenseDate?: string;
  category?: string;
  description: string;
  amount: number;
  paidBy?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3ExpensesTable.findFirst({
      where: eq(v3ExpensesTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) return { idempotent: true as const, row: existing };
  }
  const amount = Number(input.amount);
  if (!(amount > 0)) throw new AppError("VALIDATION_ERROR", "المبلغ يجب أن يكون أكبر من صفر");
  const description = input.description.trim();
  if (!description) throw new AppError("VALIDATION_ERROR", "الوصف مطلوب");

  const [row] = await db
    .insert(v3ExpensesTable)
    .values({
      expenseDate: input.expenseDate || todayISO(),
      category: (input.category || "").trim(),
      description,
      amount,
      paidBy: (input.paidBy || "").trim(),
      notes: input.notes || null,
      actor: input.actor,
      userId: input.userId ?? null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();
  return { idempotent: false as const, row };
}

export async function voidExpense(input: { id: number; voidedBy: string; voidReason: string }) {
  const row = await db.query.v3ExpensesTable.findFirst({ where: eq(v3ExpensesTable.id, input.id) });
  if (!row) throw new AppError("MOVEMENT_NOT_FOUND", "السجل غير موجود", 404);
  if (row.status === "voided") return { idempotent: true as const, row };
  const [updated] = await db
    .update(v3ExpensesTable)
    .set({
      status: "voided",
      voidedAt: new Date(),
      voidedBy: input.voidedBy,
      voidReason: input.voidReason,
    })
    .where(eq(v3ExpensesTable.id, input.id))
    .returning();
  return { idempotent: false as const, row: updated };
}
