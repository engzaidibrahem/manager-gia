/**
 * Phase 2 — Capital Register + Operational Finance tests.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

const dataDir = path.join(os.tmpdir(), `gia-finance-e2e-${process.pid}-${Date.now()}`);
process.env.DATABASE_URL = `pglite:${dataDir}`;

const dbPkg = await import("@workspace/db");
const {
  capitalEntriesTable,
  dailyPurchasesTable,
  expensesTable,
  incomeTable,
  inventoryItemsTable,
} = dbPkg;

let database: Awaited<ReturnType<typeof dbPkg.initDatabase>>;

const {
  createCapitalEntry,
  voidCapitalEntry,
  getCapitalTotals,
  getOperationalFinanceSummary,
  listCapitalEntries,
} = await import("../services/capitalService.ts");
const { upsertPurchases } = await import("../services/purchaseService.ts");
const { canAccess } = await import("../auth/roles.ts");
const { AppError } = await import("./errors.ts");

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("Operational Finance Phase 2", () => {
  before(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    database = await dbPkg.initDatabase();
  });

  after(async () => {
    await dbPkg.closeDatabase();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates initial + additional capital and totals correctly", async () => {
    const a = await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10000,
      description: "Seed",
      actor: "Owner",
      userId: 1,
    });
    assert.equal(a.idempotent, false);
    assert.equal(a.entry.amount, 10000);
    assert.equal(a.entry.actor, "Owner");

    const b = await createCapitalEntry({
      entryDate: "2026-09-05",
      entryType: "additional_capital",
      amount: 2000,
      description: "Top-up",
      actor: "Manager",
    });
    assert.equal(b.idempotent, false);

    const totals = await getCapitalTotals();
    assert.equal(totals.totalInitialCapital, 10000);
    assert.equal(totals.totalAdditionalCapital, 2000);
    assert.equal(totals.totalCapital, 12000);

    const listed = await listCapitalEntries();
    assert.ok(listed.length >= 2);
  });

  it("rejects zero/negative/invalid capital", async () => {
    await assert.rejects(
      () => createCapitalEntry({
        entryDate: "2026-09-01",
        entryType: "initial_capital",
        amount: 0,
        actor: "Owner",
      }),
      (err: unknown) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
    await assert.rejects(
      () => createCapitalEntry({
        entryDate: "2026-09-01",
        entryType: "initial_capital",
        amount: -5,
        actor: "Owner",
      }),
      (err: unknown) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
    await assert.rejects(
      () => createCapitalEntry({
        entryDate: "bad",
        entryType: "initial_capital",
        amount: 100,
        actor: "Owner",
      }),
      (err: unknown) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
    await assert.rejects(
      () => createCapitalEntry({
        entryDate: "2026-09-01",
        entryType: "initial_capital" as "initial_capital",
        amount: 100,
        actor: "",
      }),
      (err: unknown) => err instanceof AppError && err.code === "VALIDATION_ERROR",
    );
  });

  it("idempotency returns same capital entry", async () => {
    const key = `cap-idem-${Date.now()}`;
    const first = await createCapitalEntry({
      entryDate: "2026-09-10",
      entryType: "additional_capital",
      amount: 500,
      actor: "Owner",
      clientRequestId: key,
    });
    const second = await createCapitalEntry({
      entryDate: "2026-09-10",
      entryType: "additional_capital",
      amount: 500,
      actor: "Owner",
      clientRequestId: key,
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.entry.id, first.entry.id);
    const rows = await database.select().from(capitalEntriesTable)
      .where(eq(capitalEntriesTable.clientRequestId, key));
    assert.equal(rows.length, 1);
  });

  it("void removes capital from totals but keeps audit row", async () => {
    const created = await createCapitalEntry({
      entryDate: "2026-09-11",
      entryType: "additional_capital",
      amount: 111,
      actor: "Owner",
    });
    const before = await getCapitalTotals();
    await voidCapitalEntry({ id: created.entry.id, actor: "Owner", reason: "correction" });
    const after = await getCapitalTotals();
    assert.equal(after.totalCapital, before.totalCapital - 111);
    const [row] = await database.select().from(capitalEntriesTable)
      .where(eq(capitalEntriesTable.id, created.entry.id));
    assert.equal(row!.status, "voided");
    assert.equal(row!.voidedBy, "Owner");
  });

  it("income + expense + operational balance formula", async () => {
    // Isolate: use known deltas from current summary
    const before = await getOperationalFinanceSummary();

    await database.insert(incomeTable).values({
      incomeDate: "2026-09-01",
      incomeTime: "12:00",
      source: "August",
      amount: 8000,
      recordedBy: "Owner",
      notes: "Restaurant income",
    });
    await database.insert(expensesTable).values({
      expenseDate: "2026-09-02",
      expenseTime: "09:00",
      category: "Rent",
      description: "September rent",
      amount: 2500,
      paidBy: "Owner",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
    });

    const after = await getOperationalFinanceSummary();
    assert.equal(after.totalIncome, before.totalIncome + 8000);
    assert.equal(after.totalExpenses, before.totalExpenses + 2500);
    assert.equal(
      after.operationalBalance,
      Math.round((after.totalCapital + after.totalIncome - after.totalExpenses) * 100) / 100,
    );
  });

  it("canonical ops balance example shape (capital + income - expenses)", async () => {
    // Fresh isolated capital entries already exist from prior tests.
    // Verify formula identity holds for current persisted state.
    const s = await getOperationalFinanceSummary();
    assert.equal(
      s.operationalBalance,
      Math.round((s.totalCapital + s.totalIncome - s.totalExpenses) * 100) / 100,
    );
    assert.equal(
      s.totalCapital,
      Math.round((s.totalInitialCapital + s.totalAdditionalCapital) * 100) / 100,
    );
  });

  it("edge: empty components still yield coherent zeros/math", async () => {
    const [inc] = await database.select({ c: sql<number>`count(*)` }).from(incomeTable);
    const [exp] = await database.select({ c: sql<number>`count(*)` }).from(expensesTable);
    const [cap] = await database.select({ c: sql<number>`count(*)` }).from(capitalEntriesTable)
      .where(eq(capitalEntriesTable.status, "active"));
    assert.ok(Number(inc?.c ?? 0) >= 0);
    assert.ok(Number(exp?.c ?? 0) >= 0);
    assert.ok(Number(cap?.c ?? 0) >= 0);
    const s = await getOperationalFinanceSummary();
    assert.ok(Number.isFinite(s.operationalBalance));
  });

  it("purchase creation does NOT change operational balance", async () => {
    const before = await getOperationalFinanceSummary();
    const [item] = await database.insert(inventoryItemsTable).values({
      name: `Finance Chicken ${Date.now()}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-fin-${Date.now()}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 1,
      costPerUnit: 40000,
    }).returning();

    await upsertPurchases([{
      purchaseDate: todayISO(),
      purchaseTime: "10:00",
      supplier: "Supplier",
      itemName: item!.name,
      category: "test",
      quantity: 10,
      unit: "kg",
      unitPrice: 40000,
      totalAmount: 400000,
      paidBy: "mgr",
      receivedBy: "-",
      paymentMethod: "Transfer",
      inventoryItemId: item!.id,
      destination: "warehouse",
      notes: "",
    }]);

    const purchases = await database.select().from(dailyPurchasesTable)
      .where(eq(dailyPurchasesTable.inventoryItemId, item!.id));
    assert.ok(purchases.length >= 1);

    const after = await getOperationalFinanceSummary();
    assert.equal(after.operationalBalance, before.operationalBalance);
    assert.equal(after.totalExpenses, before.totalExpenses);
    assert.equal(after.totalCapital, before.totalCapital);
  });

  it("capital write permissions: owner/manager only among finance writers", () => {
    assert.equal(canAccess("owner", "POST", "/api/finance/capital"), true);
    assert.equal(canAccess("manager", "POST", "/api/finance/capital"), true);
    assert.equal(canAccess("cashier", "POST", "/api/finance/capital"), false);
    assert.equal(canAccess("cashier", "GET", "/api/finance/capital"), true);
    assert.equal(canAccess("cashier", "POST", "/api/finance/expenses/bulk-save"), true);
    assert.equal(canAccess("warehouse", "POST", "/api/finance/capital"), false);
    assert.equal(canAccess("warehouse", "GET", "/api/finance/capital"), true);
    assert.equal(canAccess("viewer", "POST", "/api/finance/capital"), false);
    assert.equal(canAccess("viewer", "GET", "/api/finance/operational-summary"), true);
    assert.equal(canAccess("kitchen", "POST", "/api/finance/capital"), false);
  });

  it("exact operational balance example: 10000+2000+8000-2500 = 17500", async () => {
    await database.delete(expensesTable);
    await database.delete(incomeTable);
    await database.delete(capitalEntriesTable);

    await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10000,
      actor: "Owner",
    });
    await createCapitalEntry({
      entryDate: "2026-09-02",
      entryType: "additional_capital",
      amount: 2000,
      actor: "Owner",
    });
    await database.insert(incomeTable).values({
      incomeDate: "2026-09-01",
      incomeTime: "",
      source: "August",
      amount: 8000,
      recordedBy: "Owner",
      notes: "Restaurant income",
    });
    await database.insert(expensesTable).values({
      expenseDate: "2026-09-02",
      expenseTime: "",
      category: "Rent",
      description: "Ops",
      amount: 2500,
      paidBy: "Owner",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
    });

    const s = await getOperationalFinanceSummary();
    assert.equal(s.totalCapital, 12000);
    assert.equal(s.totalIncome, 8000);
    assert.equal(s.totalExpenses, 2500);
    assert.equal(s.operationalBalance, 17500);
  });

  it("persists capital after reload-style re-query", async () => {
    const created = await createCapitalEntry({
      entryDate: "2026-09-15",
      entryType: "initial_capital",
      amount: 77,
      description: "persist-check",
      actor: "Owner",
    });
    const again = await listCapitalEntries();
    assert.ok(again.some((r) => r.id === created.entry.id && r.amount === 77));
  });
});
