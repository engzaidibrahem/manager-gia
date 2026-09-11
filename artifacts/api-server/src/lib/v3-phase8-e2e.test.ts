/**
 * PHASE 8 — Full restaurant E2E scenario on gia-v3-test ONLY.
 * Also verifies persistence after close/reopen of DB.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { installV3TestEnv, openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const GUARD = path.resolve(ROOT, "backups/gia-v3-phase8-prod-guard.json");

describe("V3 Phase 8 full restaurant E2E", () => {
  let dbMod: typeof import("@workspace/db");
  let chickenId: number;
  let empId: number;
  let purchaseId: number;
  let payrollId: number;

  before(async () => {
    process.chdir(ROOT);
    dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "phase8-e2e" });
  });

  after(async () => {
    try { await dbMod.closeDatabase(); } catch { /* */ }
    writeIsolationGuard(GUARD, { suite: "phase8-e2e", closed: true });
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
