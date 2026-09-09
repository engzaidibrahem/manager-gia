/**
 * PHASE 8 — Full restaurant E2E scenario on gia-v3-test ONLY.
 * Also verifies persistence after close/reopen of DB.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const GUARD = path.resolve(ROOT, "backups/gia-v3-phase8-prod-guard.json");

async function countTable(db: typeof import("@workspace/db").db, table: string): Promise<number> {
  const { sql } = await import("drizzle-orm");
  try {
    const res = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table}`));
    const r = res as unknown as { rows?: { c: number }[] } | { c: number }[];
    if (Array.isArray(r)) return Number(r[0]?.c ?? 0);
    return Number(r.rows?.[0]?.c ?? 0);
  } catch {
    return -1;
  }
}

async function snapshotProd(dbMod: typeof import("@workspace/db")) {
  const tables = [
    "v3_inventory_items",
    "v3_warehouse_movements",
    "v3_purchases",
    "v3_purchase_payments",
    "v3_capital_transactions",
    "v3_income",
    "v3_expenses",
    "v3_employees",
    "v3_attendance",
    "v3_payroll",
    "v3_salary_payments",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await countTable(dbMod.db, t);
  return out;
}

describe("V3 Phase 8 full restaurant E2E", () => {
  let dbMod: typeof import("@workspace/db");
  let prodBefore: Record<string, number>;
  let chickenId: number;
  let empId: number;
  let purchaseId: number;
  let payrollId: number;

  before(async () => {
    process.chdir(ROOT);
    process.env.DATABASE_URL = "pglite://.data/gia-v3";
    dbMod = await import("@workspace/db");
    try { await dbMod.closeDatabase(); } catch { /* */ }
    await dbMod.initDatabase();
    prodBefore = await snapshotProd(dbMod);
    fs.writeFileSync(GUARD, JSON.stringify({ before: prodBefore }, null, 2), "utf8");
    await dbMod.closeDatabase();

    process.env.DATABASE_URL = "pglite://.data/gia-v3-test";
    for (let i = 0; i < 5; i++) {
      try {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 4) throw err;
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
    await dbMod.initDatabase();
  });

  after(async () => {
    await dbMod.closeDatabase();
    process.env.DATABASE_URL = "pglite://.data/gia-v3";
    await dbMod.initDatabase();
    const afterCounts = await snapshotProd(dbMod);
    fs.writeFileSync(GUARD, JSON.stringify({ before: prodBefore, after: afterCounts }, null, 2), "utf8");
    for (const k of Object.keys(prodBefore)) {
      assert.equal(afterCounts[k], prodBefore[k], `prod ${k} must not change`);
    }
    await dbMod.closeDatabase();
  });

  it("runs complete restaurant money + stock scenario", async () => {
    const fi = await import("../v3/financeService");
    const wh = await import("../v3/warehouseService");
    const pu = await import("../v3/purchaseService");
    const emp = await import("../v3/employeeService");

    await fi.postCapital({
      entryType: "ADD",
      amount: 10_000_000,
      actor: "p8",
      clientRequestId: "p8-cap",
    });
    let s = await fi.getFinanceSummary();
    assert.equal(s.available, 10_000_000);

    const employee = await emp.createEmployee({
      fullName: "Phase8 Worker",
      salaryAmount: 3_000_000,
      salaryType: "MONTHLY",
      workStartDate: "2026-09-01",
      jobTitle: "طباخ",
    });
    empId = employee.id;

    const open = await wh.postOpeningBalance({
      name: "Chicken",
      category: "meat",
      baseUnit: "kg",
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "kg",
      actor: "p8",
      clientRequestId: "p8-open-chicken",
    });
    chickenId = open.itemId!;

    const purchase = await pu.createPurchase({
      itemName: "Chicken",
      inventoryItemId: chickenId,
      quantityNumeric: 10,
      quantityRaw: "10",
      unitRaw: "kg",
      totalAmount: 1_000_000,
      paymentStatus: "PAID",
      paidAmount: 1_000_000,
      destination: "WAREHOUSE",
      actor: "p8",
      clientRequestId: "p8-pur-chicken",
    });
    purchaseId = purchase.purchase!.id;

    let item = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, chickenId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 30);
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 9_000_000);

    await wh.postWarehouseToKitchen({
      inventoryItemId: chickenId,
      quantityRaw: "5",
      quantityNumeric: 5,
      unitRaw: "kg",
      actor: "p8",
      clientRequestId: "p8-out-5",
    });
    item = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, chickenId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 25);
    assert.equal(Number(item!.kitchenQtyNumeric), 5);

    await pu.createPurchase({
      itemName: "Cleaning",
      totalAmount: 200_000,
      paymentStatus: "PAID",
      paidAmount: 200_000,
      destination: "CONSUMABLE",
      actor: "p8",
      clientRequestId: "p8-pur-clean",
    });
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 8_800_000);

    await fi.postExpense({
      description: "Electricity",
      amount: 300_000,
      actor: "p8",
      clientRequestId: "p8-exp-elec",
    });
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 8_500_000);

    await fi.postIncome({
      description: "Sales",
      amount: 2_000_000,
      actor: "p8",
      clientRequestId: "p8-inc",
    });
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 10_500_000);

    const payroll = await emp.createOrUpdatePayroll({
      employeeId: empId,
      year: 2026,
      month: 9,
      baseSalary: 3_000_000,
      actor: "p8",
      clientRequestId: "p8-payroll",
    });
    payrollId = payroll.payroll.id;
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 10_500_000, "creating payroll must not reduce available");

    await emp.addSalaryPayment({
      payrollId,
      amount: 1_000_000,
      actor: "p8",
      clientRequestId: "p8-sal-pay",
    });
    s = await fi.getFinanceSummary();
    assert.equal(s.available, 9_500_000);
    assert.equal(s.totalExpenses, 300_000);
    assert.equal(s.totalSalaryPayments, 1_000_000);
  });

  it("persists after close/reopen test DB", async () => {
    await dbMod.closeDatabase();
    process.env.DATABASE_URL = "pglite://.data/gia-v3-test";
    await dbMod.initDatabase();

    const fi = await import("../v3/financeService");
    const s = await fi.getFinanceSummary();
    assert.equal(s.available, 9_500_000);

    const item = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, chickenId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 25);
    assert.equal(Number(item!.kitchenQtyNumeric), 5);

    const purchase = await dbMod.db.query.v3PurchasesTable.findFirst({
      where: eq(dbMod.v3PurchasesTable.id, purchaseId),
    });
    assert.equal(Number(purchase!.totalAmount), 1_000_000);

    const payroll = await dbMod.db.query.v3PayrollTable.findFirst({
      where: eq(dbMod.v3PayrollTable.id, payrollId),
    });
    assert.equal(Number(payroll!.paidAmount), 1_000_000);
  });

  it("rejects duplicate opening for same item", async () => {
    const wh = await import("../v3/warehouseService");
    let rejected = false;
    try {
      await wh.postOpeningBalance({
        inventoryItemId: chickenId,
        quantityRaw: "1",
        quantityNumeric: 1,
        unitRaw: "kg",
        actor: "p8",
        clientRequestId: "p8-dup-open",
      });
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true);
  });
});
