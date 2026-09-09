/**
 * Available Capital + Receive Goods core tests (Phase completion).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

const dataDir = path.join(os.tmpdir(), `gia-avail-${process.pid}-${Date.now()}`);
process.env.DATABASE_URL = `pglite:${dataDir}`;

const dbPkg = await import("@workspace/db");
const {
  capitalEntriesTable,
  expensesTable,
  incomeTable,
  inventoryItemsTable,
  purchasePaymentsTable,
  dailyArchivesTable,
  dailyPurchasesTable,
  warehouseLotsTable,
} = dbPkg;

let database: Awaited<ReturnType<typeof dbPkg.initDatabase>>;

const { createCapitalEntry, getAvailableCapitalSummary, voidExpense } = await import("../services/capitalService.ts");
const { receiveGoods } = await import("../services/receiveGoodsService.ts");
const { transferStock } = await import("../services/transferService.ts");
const { assertExpenseNotPurchaseDuplicate } = await import("../services/purchasePaymentService.ts");
const { consumeWarehouseLots } = await import("../services/lotFifo.ts");
const { AppError } = await import("./errors.ts");

describe("Available Capital + Receive Goods", () => {
  before(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    database = await dbPkg.initDatabase();
  });

  after(async () => {
    await dbPkg.closeDatabase();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("T1: capital 10M − paid purchase 8M = available 2M and persists", async () => {
    await database.delete(purchasePaymentsTable);
    await database.delete(expensesTable);
    await database.delete(incomeTable);
    await database.delete(capitalEntriesTable);

    await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10_000_000,
      actor: "Owner",
    });

    const rg = await receiveGoods({
      newItem: { name: `Meat-${Date.now()}`, unit: "kg", category: "test" },
      quantity: 80,
      unitPrice: 100_000,
      supplier: "Supplier X",
      paymentStatus: "paid",
      actor: "Owner",
      clientRequestId: `t1-${Date.now()}`,
    });
    assert.equal(Number(rg.purchase?.totalAmount), 8_000_000);
    assert.ok(rg.payment);
    assert.equal(rg.availableCapital, 2_000_000);

    const again = await getAvailableCapitalSummary();
    assert.equal(again.availableCapital, 2_000_000);
    assert.equal(again.totalPurchasePayments, 8_000_000);
  });

  it("T2: warehouse 10 + receive 20 − issue 8 = 22 persists", async () => {
    const [item] = await database.insert(inventoryItemsTable).values({
      name: `Flour-${Date.now()}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-t2-${Date.now()}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 1,
      costPerUnit: 10000,
    }).returning();

    await receiveGoods({
      inventoryItemId: item!.id,
      quantity: 10,
      unitPrice: 10000,
      supplier: "A",
      paymentStatus: "unpaid",
      actor: "Owner",
    });
    await receiveGoods({
      inventoryItemId: item!.id,
      quantity: 20,
      unitPrice: 10000,
      supplier: "A",
      paymentStatus: "unpaid",
      actor: "Owner",
    });
    let row = await database.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item!.id) });
    assert.equal(Number(row!.currentStock), 30);

    await transferStock({
      itemId: item!.id,
      quantity: 8,
      unit: "kg",
      from: "warehouse",
      to: "kitchen",
      actor: "Chef",
    });
    row = await database.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item!.id) });
    assert.equal(Number(row!.currentStock), 22);
    assert.equal(Number(row!.kitchenStock), 8);
  });

  it("T3: receive creates new product + stock", async () => {
    const name = `NewProd-${Date.now()}`;
    const rg = await receiveGoods({
      newItem: { name, unit: "pcs", category: "test" },
      quantity: 5,
      unitPrice: 1000,
      supplier: "B",
      paymentStatus: "unpaid",
      actor: "Owner",
    });
    assert.ok(rg.createdItem);
    assert.equal(rg.receive.warehouseStock, 5);
  });

  it("T4: issue more than available is rejected", async () => {
    const [item] = await database.insert(inventoryItemsTable).values({
      name: `Low-${Date.now()}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-t4-${Date.now()}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 1,
    }).returning();
    await receiveGoods({
      inventoryItemId: item!.id,
      quantity: 2,
      unitPrice: 1,
      supplier: "C",
      paymentStatus: "unpaid",
      actor: "Owner",
    });
    await assert.rejects(
      () => transferStock({
        itemId: item!.id, quantity: 9, unit: "kg", from: "warehouse", to: "kitchen", actor: "Chef",
      }),
      (err: unknown) => err instanceof AppError,
    );
  });

  it("T5: single paid receive-goods → one payment effect only", async () => {
    const before = await getAvailableCapitalSummary();
    const rg = await receiveGoods({
      newItem: { name: `Once-${Date.now()}`, unit: "kg" },
      quantity: 1,
      unitPrice: 50_000,
      supplier: "D",
      paymentStatus: "paid",
      actor: "Owner",
      clientRequestId: `t5-${Date.now()}`,
    });
    assert.ok(rg.payment);
    const after = await getAvailableCapitalSummary();
    assert.equal(after.totalPurchasePayments, before.totalPurchasePayments + 50_000);
    assert.equal(after.availableCapital, before.availableCapital - 50_000);

    assert.throws(
      () => assertExpenseNotPurchaseDuplicate("purchase", "anything"),
      (err: unknown) => err instanceof AppError,
    );
  });

  it("T6: day archive snapshot does not change available capital", async () => {
    const before = await getAvailableCapitalSummary();
    await database.insert(dailyArchivesTable).values({
      businessDate: `2099-01-${String((Date.now() % 27) + 1).padStart(2, "0")}`,
      closedBy: "Owner",
      notes: "test",
      totalIncome: 0,
      totalExpenses: 0,
      netCash: 0,
      totalPurchases: 0,
      purchaseCount: 0,
      wasteCost: 0,
      kitchenMovements: 0,
      attendanceCount: 0,
      warehouseValue: 0,
      kitchenValue: 0,
      snapshotJson: "{}",
    });
    const after = await getAvailableCapitalSummary();
    assert.equal(after.availableCapital, before.availableCapital);
  });

  it("T7: FIFO still consumes lots even with archiveId set", async () => {
    const [item] = await database.insert(inventoryItemsTable).values({
      name: `LotArch-${Date.now()}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-t7-${Date.now()}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 1,
    }).returning();
    await receiveGoods({
      inventoryItemId: item!.id,
      quantity: 10,
      unitPrice: 1,
      supplier: "E",
      paymentStatus: "unpaid",
      actor: "Owner",
    });
    const lots = await database.query.warehouseLotsTable.findMany({
      where: eq(warehouseLotsTable.itemId, item!.id),
    });
    assert.ok(lots[0]);
    await database.update(warehouseLotsTable)
      .set({ archiveId: 999999 })
      .where(eq(warehouseLotsTable.id, lots[0]!.id));

    await database.transaction(async (tx) => {
      const consumed = await consumeWarehouseLots(tx, item!.id, 3);
      assert.ok(consumed.allocations.length >= 1);
      assert.equal(consumed.allocations[0]!.quantity, 3);
    });
  });

  it("T8: void expense keeps audit and restores available capital", async () => {
    const before = await getAvailableCapitalSummary();
    const [exp] = await database.insert(expensesTable).values({
      expenseDate: "2026-09-09",
      expenseTime: "",
      category: "Rent",
      description: "void-me",
      amount: 1000,
      paidBy: "Owner",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
      status: "active",
    }).returning();
    let mid = await getAvailableCapitalSummary();
    assert.equal(mid.availableCapital, before.availableCapital - 1000);
    await voidExpense(exp!.id, "Owner", "correction");
    const after = await getAvailableCapitalSummary();
    assert.equal(after.availableCapital, before.availableCapital);
    const row = await database.query.expensesTable.findFirst({ where: eq(expensesTable.id, exp!.id) });
    assert.equal(row!.status, "voided");
  });

  it("full scenario: 10M capital → paid 8M → 2M → expense 500k → 1.5M → income 1M → 2.5M", async () => {
    await database.delete(purchasePaymentsTable);
    await database.delete(expensesTable);
    await database.delete(incomeTable);
    await database.delete(capitalEntriesTable);

    await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10_000_000,
      actor: "Owner",
    });

    const rg = await receiveGoods({
      newItem: { name: `ScenarioMeat-${Date.now()}`, unit: "kg", category: "test" },
      quantity: 80,
      unitPrice: 100_000,
      supplier: "Supplier X",
      paymentStatus: "paid",
      actor: "Owner",
      clientRequestId: `full-scenario-${Date.now()}`,
    });
    assert.equal(Number(rg.purchase?.totalAmount), 8_000_000);
    assert.equal(rg.availableCapital, 2_000_000);

    let s = await getAvailableCapitalSummary();
    assert.equal(s.availableCapital, 2_000_000);
    assert.equal(s.totalExpenses, 0);
    assert.equal(s.totalPurchasePayments, 8_000_000);

    const [exp] = await database.insert(expensesTable).values({
      expenseDate: "2026-09-09",
      expenseTime: "",
      category: "Rent",
      description: "operational rent",
      amount: 500_000,
      paidBy: "Owner",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
      status: "active",
    }).returning();
    s = await getAvailableCapitalSummary();
    assert.equal(s.availableCapital, 1_500_000);
    assert.equal(s.totalExpenses, 500_000);

    await database.insert(incomeTable).values({
      incomeDate: "2026-09-09",
      incomeTime: "",
      source: "sales",
      amount: 1_000_000,
      recordedBy: "Owner",
      notes: "",
      status: "active",
    });
    s = await getAvailableCapitalSummary();
    assert.equal(s.availableCapital, 2_500_000);
    assert.equal(s.totalIncome, 1_000_000);

    // purchase must NOT appear inside operational expenses
    assert.equal(s.totalExpenses, 500_000);

    await voidExpense(exp!.id, "Owner", "correction");
    s = await getAvailableCapitalSummary();
    assert.equal(s.availableCapital, 3_000_000);

    const { voidPurchasePayment } = await import("../services/purchasePaymentService.ts");
    assert.ok(rg.payment?.id);
    await voidPurchasePayment({ id: rg.payment!.id, actor: "Owner", reason: "correction" });
    s = await getAvailableCapitalSummary();
    assert.equal(s.availableCapital, 11_000_000);
    assert.equal(s.totalPurchasePayments, 0);

    // stock still present after payment void
    const item = await database.query.inventoryItemsTable.findFirst({
      where: eq(inventoryItemsTable.id, rg.itemId),
    });
    assert.equal(Number(item!.currentStock), 80);
  });

  it("purchase-like historical expenses are excluded from Available Capital (no destroy)", async () => {
    await database.delete(purchasePaymentsTable);
    await database.delete(expensesTable);
    await database.delete(incomeTable);
    await database.delete(capitalEntriesTable);

    await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10_000_000,
      actor: "Owner",
    });

    const [pembelian] = await database.insert(expensesTable).values({
      expenseDate: "2026-09-04",
      expenseTime: "",
      category: "Pembelian / مشتريات",
      description: "Ayam · Supplier",
      amount: 160_000,
      paidBy: "A",
      receivedBy: "-",
      paymentMethod: "Cash",
      notes: "destination:kitchen",
      status: "active",
    }).returning();

    const [shubiBuy] = await database.insert(expensesTable).values({
      expenseDate: "2026-09-06",
      expenseTime: "",
      category: "umum",
      description: "مشتريات من شوبي",
      amount: 2_000_000,
      paidBy: "admin",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
      status: "active",
    }).returning();

    // same-day same-amount sibling (cluster)
    const [shubiShort] = await database.insert(expensesTable).values({
      expenseDate: "2026-09-06",
      expenseTime: "",
      category: "umum",
      description: "شوبي",
      amount: 2_000_000,
      paidBy: "-",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
      status: "active",
    }).returning();

    await database.insert(expensesTable).values({
      expenseDate: "2026-09-06",
      expenseTime: "",
      category: "Rent",
      description: "real rent",
      amount: 100_000,
      paidBy: "admin",
      receivedBy: "-",
      paymentMethod: "Transfer",
      notes: "",
      status: "active",
    });

    const s = await getAvailableCapitalSummary();
    assert.equal(s.totalExpenses, 100_000);
    assert.equal(s.excludedPurchaseLikeTotal, 4_160_000);
    assert.ok((s.suspectedPurchaseExpenses?.length ?? 0) >= 3);
    assert.equal(s.availableCapital, 9_900_000);

    // rows still exist (active) until soft-void remediation
    for (const id of [pembelian!.id, shubiBuy!.id, shubiShort!.id]) {
      const row = await database.query.expensesTable.findFirst({ where: eq(expensesTable.id, id) });
      assert.equal(row!.status, "active");
    }

    const { softVoidSuspectedPurchaseExpenses } = await import("../services/capitalService.ts");
    const rem = await softVoidSuspectedPurchaseExpenses("Owner");
    assert.ok(rem.voidedCount >= 3);
    const after = await getAvailableCapitalSummary();
    assert.equal(after.excludedPurchaseLikeTotal, 0);
    assert.equal(after.totalExpenses, 100_000);
    assert.equal(after.availableCapital, 9_900_000);

    const voided = await database.query.expensesTable.findFirst({ where: eq(expensesTable.id, pembelian!.id) });
    assert.equal(voided!.status, "voided");
    assert.ok(voided!.voidReason);
  });

  it("second paid purchase 500k reduces available further", async () => {
    // Depends on capital still present from T1 setup in same DB; re-seed if wiped
    let s = await getAvailableCapitalSummary();
    if (s.totalCapital < 1) {
      await createCapitalEntry({
        entryDate: "2026-09-01",
        entryType: "initial_capital",
        amount: 10_000_000,
        actor: "Owner",
      });
      s = await getAvailableCapitalSummary();
    }
    const before = s.availableCapital;
    await receiveGoods({
      newItem: { name: `Extra-${Date.now()}`, unit: "kg" },
      quantity: 1,
      unitPrice: 500_000,
      supplier: "F",
      paymentStatus: "paid",
      actor: "Owner",
    });
    const after = await getAvailableCapitalSummary();
    assert.equal(after.availableCapital, before - 500_000);
  });

  it("warehouse vs normal daily purchase: stock only for warehouse; finance once each", async () => {
    await database.delete(purchasePaymentsTable);
    await database.delete(expensesTable);
    await database.delete(incomeTable);
    await database.delete(capitalEntriesTable);

    await createCapitalEntry({
      entryDate: "2026-09-01",
      entryType: "initial_capital",
      amount: 10_000_000,
      actor: "Owner",
    });

    const { recordDailyPurchase, cancelDailyPurchase } = await import("../services/recordDailyPurchaseService.ts");
    const { inventoryMovementsTable } = dbPkg;

    const riceName = `Rice-${Date.now()}`;
    const wh = await recordDailyPurchase({
      destination: "warehouse",
      itemName: riceName,
      category: "bahan",
      quantity: 20,
      unit: "kg",
      unitPrice: 15_000,
      supplier: "Supplier X",
      paymentStatus: "paid",
      actor: "Owner",
      clientRequestId: `wh-${Date.now()}`,
    });
    assert.equal(Number(wh.purchase?.totalAmount), 300_000);
    assert.ok(wh.payment);
    assert.ok(wh.itemId);
    assert.equal(wh.availableCapital, 9_700_000);

    const item = await database.query.inventoryItemsTable.findFirst({
      where: eq(inventoryItemsTable.id, wh.itemId!),
    });
    assert.equal(Number(item!.currentStock), 20);
    const lots = await database.query.warehouseLotsTable.findMany({
      where: eq(warehouseLotsTable.itemId, wh.itemId!),
    });
    assert.ok(lots.length >= 1);
    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, wh.itemId!));
    assert.ok(moves.some((m) => Number(m.quantity) > 0));

    const beforeNormal = await getAvailableCapitalSummary();
    const itemCountBefore = (await database.select().from(inventoryItemsTable)).length;

    const notebook = await recordDailyPurchase({
      destination: "none",
      itemName: `Notebook-${Date.now()}`,
      category: "office",
      quantity: 5,
      unit: "pcs",
      unitPrice: 20_000,
      supplier: "Toko X",
      paymentStatus: "paid",
      actor: "Owner",
      clientRequestId: `norm-${Date.now()}`,
    });
    assert.equal(Number(notebook.purchase?.totalAmount), 100_000);
    assert.ok(notebook.payment);
    assert.equal(notebook.itemId, null);
    assert.equal(notebook.purchase?.destination, "none");
    assert.equal(notebook.availableCapital, beforeNormal.availableCapital - 100_000);

    const itemCountAfter = (await database.select().from(inventoryItemsTable)).length;
    assert.equal(itemCountAfter, itemCountBefore);

    // persist / re-query
    const again = await getAvailableCapitalSummary();
    assert.equal(again.availableCapital, 9_600_000);
    assert.equal(again.totalPurchasePayments, 400_000);

    const listed = await database.select().from(dailyPurchasesTable);
    assert.ok(listed.some((p) => p.id === wh.purchase!.id && p.destination === "warehouse"));
    assert.ok(listed.some((p) => p.id === notebook.purchase!.id && p.destination === "none"));

    // cancel normal restores capital once; no stock side-effects
    await cancelDailyPurchase({ purchaseId: notebook.purchase!.id, actor: "Owner" });
    const afterCancel = await getAvailableCapitalSummary();
    assert.equal(afterCancel.availableCapital, 9_700_000);
    assert.equal(afterCancel.totalPurchasePayments, 300_000);

    // received warehouse cannot be cancelled (no silent dest flip / duplicate risk)
    await assert.rejects(
      () => cancelDailyPurchase({ purchaseId: wh.purchase!.id, actor: "Owner" }),
      (err: unknown) => err instanceof AppError,
    );
  });
});
