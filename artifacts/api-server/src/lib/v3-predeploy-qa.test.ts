/**
 * Pre-deployment comprehensive V3 QA — TEST DB ONLY.
 * Exact finance scenario + warehouse/purchase/employee/auth checks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { installV3TestEnv, openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_DIR = path.resolve(ROOT, ".data/gia-v3");
const GUARD = path.resolve(ROOT, "backups/gia-v3-predeploy-qa-prod-guard.json");

describe("V3 Pre-deploy comprehensive QA", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let closeDatabase: typeof import("@workspace/db").closeDatabase;
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let addPurchasePayment: typeof import("../v3/purchaseService").addPurchasePayment;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postWarehouseIn: typeof import("../v3/warehouseService").postWarehouseIn;
  let postWarehouseToKitchen: typeof import("../v3/warehouseService").postWarehouseToKitchen;
  let listWarehouseSummary: typeof import("../v3/warehouseService").listWarehouseSummary;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;
  let postCapital: typeof import("../v3/financeService").postCapital;
  let postIncome: typeof import("../v3/financeService").postIncome;
  let postExpense: typeof import("../v3/financeService").postExpense;
  let getFinanceSummary: typeof import("../v3/financeService").getFinanceSummary;
  let createEmployee: typeof import("../v3/employeeService").createEmployee;
  let upsertAttendance: typeof import("../v3/employeeService").upsertAttendance;
  let createOrUpdatePayroll: typeof import("../v3/employeeService").createOrUpdatePayroll;
  let addSalaryPayment: typeof import("../v3/employeeService").addSalaryPayment;

  before(async () => {
    process.chdir(ROOT);
    const dbMod0 = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod0);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.notEqual(path.resolve(TEST_DIR), path.resolve(PROD_DIR));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "predeploy-qa" });

    db = dbMod0.db;
    tables = dbMod0;
    closeDatabase = dbMod0.closeDatabase;

    const wh = await import("../v3/warehouseService");
    const pu = await import("../v3/purchaseService");
    const fi = await import("../v3/financeService");
    const em = await import("../v3/employeeService");
    postOpeningBalance = wh.postOpeningBalance;
    postWarehouseIn = wh.postWarehouseIn;
    postWarehouseToKitchen = wh.postWarehouseToKitchen;
    listWarehouseSummary = wh.listWarehouseSummary;
    listKitchenStock = wh.listKitchenStock;
    createPurchase = pu.createPurchase;
    addPurchasePayment = pu.addPurchasePayment;
    postCapital = fi.postCapital;
    postIncome = fi.postIncome;
    postExpense = fi.postExpense;
    getFinanceSummary = fi.getFinanceSummary;
    createEmployee = em.createEmployee;
    upsertAttendance = em.upsertAttendance;
    createOrUpdatePayroll = em.createOrUpdatePayroll;
    addSalaryPayment = em.addSalaryPayment;
  });

  after(async () => {
    await closeDatabase();
    writeIsolationGuard(GUARD, { suite: "predeploy-qa", closed: true });
  });

  it("warehouse: new item IN, OUT, zero stays visible, search finds it, over-issue rejected", async () => {
    const open = await postOpeningBalance({
      name: "دجاج QA",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "10",
      quantityNumeric: 10,
      unitRaw: "kg",
      actor: "qa",
      clientRequestId: "pre-open-1",
    });
    const itemId = open.itemId!;

    await postWarehouseIn({
      inventoryItemId: itemId,
      quantityRaw: "5",
      quantityNumeric: 5,
      unitRaw: "kg",
      actor: "qa",
      clientRequestId: "pre-in-1",
    });

    await postWarehouseToKitchen({
      inventoryItemId: itemId,
      quantityRaw: "15",
      quantityNumeric: 15,
      unitRaw: "kg",
      actor: "qa",
      clientRequestId: "pre-out-1",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 0);

    const listed = await listWarehouseSummary({ q: "دجاج QA", page: 1, pageSize: 50 });
    assert.ok(listed.rows.some((r) => r.id === itemId && Number(r.currentWarehouse) === 0));

    await assert.rejects(() =>
      postWarehouseToKitchen({
        inventoryItemId: itemId,
        quantityRaw: "1",
        quantityNumeric: 1,
        unitRaw: "kg",
        actor: "qa",
        clientRequestId: "pre-out-over",
      }),
    );

    // brand-new receipt without prior opening
    const brand = await createPurchase({
      itemName: "صلصة QA جديدة",
      newItem: { name: "صلصة QA جديدة", category: "test", baseUnit: "L" },
      quantityNumeric: 2,
      quantityRaw: "2",
      unitRaw: "L",
      totalAmount: 20000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "qa",
      clientRequestId: "pre-pur-wh-new",
    });
    assert.ok(brand.purchase?.inventoryItemId);
    const sauce = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, brand.purchase!.inventoryItemId!),
    });
    assert.equal(Number(sauce!.warehouseQtyNumeric), 2);
  });

  it("purchases: kitchen-direct visible, consumable no stock, paid/unpaid/partial finance path", async () => {
    const kit = await createPurchase({
      itemName: "خس QA مطبخ",
      quantityNumeric: 4,
      quantityRaw: "4",
      unitRaw: "kg",
      totalAmount: 40000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "qa",
      clientRequestId: "pre-pur-kit",
    });
    assert.ok(kit.purchase?.inventoryItemId);
    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.name === "خس QA مطبخ" && r.kitchenQty === 4));
    const kitItem = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, kit.purchase!.inventoryItemId!),
    });
    assert.equal(Number(kitItem!.warehouseQtyNumeric ?? 0), 0);

    const beforeItems = (await db.select().from(tables.v3InventoryItemsTable)).length;
    const beforeMoves = (await db.select().from(tables.v3WarehouseMovementsTable)).length;
    await createPurchase({
      itemName: "منظفات QA",
      totalAmount: 100000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "qa",
      clientRequestId: "pre-pur-con",
    });
    assert.equal((await db.select().from(tables.v3InventoryItemsTable)).length, beforeItems);
    assert.equal((await db.select().from(tables.v3WarehouseMovementsTable)).length, beforeMoves);
  });

  it("exact finance scenario ends at 9,200,000", async () => {
    await postCapital({
      entryType: "ADD",
      amount: 10_000_000,
      actor: "qa",
      clientRequestId: "pre-fin-cap",
    });

    const paid = await createPurchase({
      itemName: "شراء مدفوع QA",
      totalAmount: 1_000_000,
      paymentStatus: "PAID",
      paidAmount: 1_000_000,
      destination: "CONSUMABLE",
      actor: "qa",
      clientRequestId: "pre-fin-paid",
    });
    assert.equal((await getFinanceSummary()).available, 9_000_000);

    const unpaid = await createPurchase({
      itemName: "شراء آجل QA",
      totalAmount: 2_000_000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "qa",
      clientRequestId: "pre-fin-unpaid",
    });
    assert.equal((await getFinanceSummary()).available, 9_000_000);

    await addPurchasePayment({
      purchaseId: unpaid.purchase!.id,
      amount: 500_000,
      actor: "qa",
      clientRequestId: "pre-fin-partial",
    });
    assert.equal((await getFinanceSummary()).available, 8_500_000);

    await postExpense({
      amount: 300_000,
      category: "ops",
      description: "مصروف QA",
      actor: "qa",
      clientRequestId: "pre-fin-exp",
    });
    assert.equal((await getFinanceSummary()).available, 8_200_000);

    await postIncome({
      amount: 2_000_000,
      description: "دخل QA",
      actor: "qa",
      clientRequestId: "pre-fin-inc",
    });
    assert.equal((await getFinanceSummary()).available, 10_200_000);

    const emp = await createEmployee({
      fullName: "عامل QA",
      salaryType: "MONTHLY",
      salaryAmount: 3_000_000,
      workStartDate: "2026-09-01",
    });
    await upsertAttendance({
      employeeId: emp.id,
      attendanceDate: "2026-09-10",
      status: "PRESENT",
      actor: "qa",
    });
    const pay = await createOrUpdatePayroll({
      employeeId: emp.id,
      year: 2026,
      month: 9,
      baseSalary: 3_000_000,
      manualDeduction: 0,
      manualBonus: 0,
      actor: "qa",
      clientRequestId: "pre-pay-1",
    });
    // unpaid payroll must not reduce available
    assert.equal((await getFinanceSummary()).available, 10_200_000);

    await addSalaryPayment({
      payrollId: pay.payroll!.id,
      amount: 1_000_000,
      actor: "qa",
      clientRequestId: "pre-sal-1",
    });
    assert.equal((await getFinanceSummary()).available, 9_200_000);

    // paid purchase id still exists (sanity)
    assert.ok(paid.purchase?.id);
  });

  it("persistence after close/reopen test DB", async () => {
    await closeDatabase();
    installV3TestEnv();
    const dbMod = await import("@workspace/db");
    await dbMod.initDatabase();
    db = dbMod.db;
    tables = dbMod;
    closeDatabase = dbMod.closeDatabase;
    getFinanceSummary = (await import("../v3/financeService")).getFinanceSummary;
    listKitchenStock = (await import("../v3/warehouseService")).listKitchenStock;

    assert.equal((await getFinanceSummary()).available, 9_200_000);
    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.name === "خس QA مطبخ"));
  });
});
