/**
 * Purchase destination + edit reconciliation tests.
 * MUST use gia-v3-test only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_DIR = path.resolve(ROOT, ".data/gia-v3");
const GUARD = path.resolve(ROOT, "backups/gia-v3-purchase-edit-prod-guard.json");

describe("V3 Purchase destination + edit", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let closeDatabase: typeof import("@workspace/db").closeDatabase;
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let updatePurchase: typeof import("../v3/purchaseService").updatePurchase;
  let voidPurchase: typeof import("../v3/purchaseService").voidPurchase;
  let addPurchasePayment: typeof import("../v3/purchaseService").addPurchasePayment;
  let listMovements: typeof import("../v3/warehouseService").listMovements;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postCapital: typeof import("../v3/financeService").postCapital;
  let getFinanceSummary: typeof import("../v3/financeService").getFinanceSummary;

  before(async () => {
    process.chdir(ROOT);
    const dbMod0 = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod0);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.ok(!PROD_DIR.endsWith("gia-v3-test"));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "purchase-edit" });

    db = dbMod0.db;
    tables = dbMod0;
    closeDatabase = dbMod0.closeDatabase;

    const wh = await import("../v3/warehouseService");
    const pu = await import("../v3/purchaseService");
    const fi = await import("../v3/financeService");
    postOpeningBalance = wh.postOpeningBalance;
    listMovements = wh.listMovements;
    listKitchenStock = wh.listKitchenStock;
    createPurchase = pu.createPurchase;
    updatePurchase = pu.updatePurchase;
    voidPurchase = pu.voidPurchase;
    addPurchasePayment = pu.addPurchasePayment;
    postCapital = fi.postCapital;
    getFinanceSummary = fi.getFinanceSummary;
  });

  after(async () => {
    await closeDatabase();
    writeIsolationGuard(GUARD, { suite: "purchase-edit", closed: true });
  });

  it("1) WAREHOUSE purchase: movement + stock + inbound list", async () => {
    const open = await postOpeningBalance({
      name: "دجاج تعديل WH",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "100",
      quantityNumeric: 100,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "pe-open-wh",
    });
    const itemId = open.itemId!;

    const result = await createPurchase({
      itemName: "دجاج تعديل WH",
      inventoryItemId: itemId,
      quantityNumeric: 10,
      quantityRaw: "10",
      unitRaw: "kg",
      totalAmount: 500000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "test",
      clientRequestId: "pe-wh-1",
    });

    assert.ok(result.purchase);
    assert.equal(result.purchase!.destination, "WAREHOUSE");
    assert.ok(result.movementId);

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 110);

    const inbound = await listMovements({ movementType: "WAREHOUSE_IN", pageSize: 200 });
    assert.ok(inbound.rows.some((r) => Number(r.purchaseId) === result.purchase!.id));
  });

  it("2) KITCHEN_DIRECT: kitchen up, warehouse unchanged", async () => {
    const open = await postOpeningBalance({
      name: "خس مطبخ",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "pe-open-kit",
    });
    const itemId = open.itemId!;
    const beforeWh = Number(
      (
        await db.query.v3InventoryItemsTable.findFirst({
          where: eq(tables.v3InventoryItemsTable.id, itemId),
        })
      )!.warehouseQtyNumeric,
    );

    const result = await createPurchase({
      itemName: "خس مطبخ",
      inventoryItemId: itemId,
      quantityNumeric: 5,
      quantityRaw: "5",
      unitRaw: "kg",
      totalAmount: 25000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "test",
      clientRequestId: "pe-kit-1",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), beforeWh);
    assert.equal(Number(item!.kitchenQtyNumeric), 5);

    const moves = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(
        and(
          eq(tables.v3WarehouseMovementsTable.purchaseId, result.purchase!.id),
          eq(tables.v3WarehouseMovementsTable.status, "active"),
        ),
      );
    assert.equal(moves.length, 1);
    assert.equal(moves[0]!.movementType, "KITCHEN_DIRECT_IN");

    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.id === itemId && r.kitchenQty >= 5));
  });

  it("3) CONSUMABLE: no stock movements", async () => {
    const result = await createPurchase({
      itemName: "أقلام مكتب",
      quantityNumeric: 2,
      quantityRaw: "2",
      unitRaw: "pcs",
      totalAmount: 15000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: "pe-cons-1",
    });
    assert.equal(result.purchase!.destination, "CONSUMABLE");
    assert.equal(result.movementId ?? null, null);

    const moves = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(eq(tables.v3WarehouseMovementsTable.purchaseId, result.purchase!.id));
    assert.equal(moves.length, 0);
  });

  it("4) edit warehouse qty 10 -> 12 nets +12 not +22", async () => {
    const open = await postOpeningBalance({
      name: "لحم تعديل كمية",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "50",
      quantityNumeric: 50,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "pe-open-qty",
    });
    const itemId = open.itemId!;

    const created = await createPurchase({
      itemName: "لحم تعديل كمية",
      inventoryItemId: itemId,
      quantityNumeric: 10,
      quantityRaw: "10",
      unitRaw: "kg",
      totalAmount: 400000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "test",
      clientRequestId: "pe-qty-1",
    });

    await updatePurchase({
      purchaseId: created.purchase!.id,
      quantityNumeric: 12,
      quantityRaw: "12",
      actor: "editor",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 62);

    const activeIns = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(
        and(
          eq(tables.v3WarehouseMovementsTable.purchaseId, created.purchase!.id),
          eq(tables.v3WarehouseMovementsTable.status, "active"),
          eq(tables.v3WarehouseMovementsTable.movementType, "WAREHOUSE_IN"),
        ),
      );
    assert.equal(activeIns.length, 1);
    assert.equal(Number(activeIns[0]!.quantityNumeric), 12);
  });

  it("5) edit WAREHOUSE -> KITCHEN_DIRECT reconciles both sides", async () => {
    const open = await postOpeningBalance({
      name: "دجاج تحويل وجهة",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "30",
      quantityNumeric: 30,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "pe-open-dest",
    });
    const itemId = open.itemId!;

    const created = await createPurchase({
      itemName: "دجاج تحويل وجهة",
      inventoryItemId: itemId,
      quantityNumeric: 8,
      quantityRaw: "8",
      unitRaw: "kg",
      totalAmount: 320000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "test",
      clientRequestId: "pe-dest-1",
    });

    await updatePurchase({
      purchaseId: created.purchase!.id,
      destination: "KITCHEN_DIRECT",
      quantityNumeric: 8,
      quantityRaw: "8",
      actor: "editor",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 30);
    assert.equal(Number(item!.kitchenQtyNumeric), 8);

    const active = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(
        and(
          eq(tables.v3WarehouseMovementsTable.purchaseId, created.purchase!.id),
          eq(tables.v3WarehouseMovementsTable.status, "active"),
        ),
      );
    assert.equal(active.length, 1);
    assert.equal(active[0]!.movementType, "KITCHEN_DIRECT_IN");
  });

  it("6) edit KITCHEN_DIRECT -> CONSUMABLE removes kitchen effect", async () => {
    const result = await createPurchase({
      itemName: "طماطم تحويل مستهلك",
      quantityNumeric: 4,
      quantityRaw: "4",
      unitRaw: "kg",
      totalAmount: 20000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "test",
      clientRequestId: "pe-kit-cons",
    });
    const itemId = result.purchase!.inventoryItemId!;

    await updatePurchase({
      purchaseId: result.purchase!.id,
      destination: "CONSUMABLE",
      actor: "editor",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.kitchenQtyNumeric || 0), 0);
    assert.equal(Number(item!.warehouseQtyNumeric || 0), 0);

    const active = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(
        and(
          eq(tables.v3WarehouseMovementsTable.purchaseId, result.purchase!.id),
          eq(tables.v3WarehouseMovementsTable.status, "active"),
        ),
      );
    assert.equal(active.length, 0);
  });

  it("7) edit CONSUMABLE -> WAREHOUSE creates inbound once", async () => {
    const open = await postOpeningBalance({
      name: "سكر من مستهلك",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "5",
      quantityNumeric: 5,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "pe-open-cons-wh",
    });
    const itemId = open.itemId!;

    const created = await createPurchase({
      itemName: "سكر من مستهلك",
      quantityNumeric: 3,
      quantityRaw: "3",
      unitRaw: "kg",
      totalAmount: 30000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: "pe-cons-wh",
    });

    await updatePurchase({
      purchaseId: created.purchase!.id,
      destination: "WAREHOUSE",
      inventoryItemId: itemId,
      quantityNumeric: 3,
      quantityRaw: "3",
      actor: "editor",
    });

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 8);

    const active = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(
        and(
          eq(tables.v3WarehouseMovementsTable.purchaseId, created.purchase!.id),
          eq(tables.v3WarehouseMovementsTable.status, "active"),
          eq(tables.v3WarehouseMovementsTable.movementType, "WAREHOUSE_IN"),
        ),
      );
    assert.equal(active.length, 1);
  });

  it("8) edit with payment does not duplicate payments / finance stays correct", async () => {
    await postCapital({
      entryDate: "2026-09-01",
      entryType: "ADD",
      amount: 5_000_000,
      actor: "test",
      clientRequestId: "pe-cap-1",
    });

    const created = await createPurchase({
      itemName: "مستهلك مدفوع",
      quantityNumeric: 1,
      quantityRaw: "1",
      unitRaw: "pcs",
      totalAmount: 100_000,
      paidAmount: 40_000,
      paymentStatus: "PARTIAL",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: "pe-pay-edit",
    });

    const before = await getFinanceSummary();
    const paysBefore = await db
      .select()
      .from(tables.v3PurchasePaymentsTable)
      .where(
        and(
          eq(tables.v3PurchasePaymentsTable.purchaseId, created.purchase!.id),
          eq(tables.v3PurchasePaymentsTable.status, "active"),
        ),
      );
    assert.equal(paysBefore.length, 1);

    await updatePurchase({
      purchaseId: created.purchase!.id,
      totalAmount: 120_000,
      notes: "edited total",
      actor: "editor",
    });

    const paysAfter = await db
      .select()
      .from(tables.v3PurchasePaymentsTable)
      .where(
        and(
          eq(tables.v3PurchasePaymentsTable.purchaseId, created.purchase!.id),
          eq(tables.v3PurchasePaymentsTable.status, "active"),
        ),
      );
    assert.equal(paysAfter.length, 1);
    assert.equal(Number(paysAfter[0]!.amount), 40_000);

    const after = await getFinanceSummary();
    assert.equal(after.totalPurchasePayments, before.totalPurchasePayments);
    assert.equal(after.available, before.available);
  });

  it("9) reject total < already paid", async () => {
    const created = await createPurchase({
      itemName: "رفض إجمالي",
      quantityNumeric: 1,
      quantityRaw: "1",
      totalAmount: 80_000,
      paidAmount: 50_000,
      paymentStatus: "PARTIAL",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: "pe-reject-total",
    });

    await assert.rejects(
      () =>
        updatePurchase({
          purchaseId: created.purchase!.id,
          totalAmount: 40_000,
          actor: "editor",
        }),
      /المدفوع|أقل/,
    );
  });

  it("10) voided purchase cannot be edited", async () => {
    const created = await createPurchase({
      itemName: "ملغى لا يعدل",
      quantityNumeric: 1,
      quantityRaw: "1",
      totalAmount: 10_000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: "pe-void-edit",
    });
    await voidPurchase({
      purchaseId: created.purchase!.id,
      voidedBy: "test",
      voidReason: "اختبار",
    });

    await assert.rejects(
      () =>
        updatePurchase({
          purchaseId: created.purchase!.id,
          notes: "nope",
          actor: "editor",
        }),
      /ملغاة|void/i,
    );
  });
});
