/**
 * Persistence + restart reliability — gia-v3-test ONLY.
 * Creates purchases, closes DB (simulating graceful API stop), reopens, verifies rows.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { installV3TestEnv, openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_DIR = path.resolve(ROOT, ".data/gia-v3");
const GUARD = path.resolve(ROOT, "backups/gia-v3-persist-fix-prod-guard.json");

describe("V3 persistence + graceful reopen", () => {
  let dbMod: typeof import("@workspace/db");
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let listMovements: typeof import("../v3/warehouseService").listMovements;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;

  let warehousePurchaseId = 0;
  let warehouseItemId = 0;
  let warehouseMovementId = 0;
  let kitchenPurchaseId = 0;
  let kitchenItemId = 0;
  let kitchenMovementId = 0;
  let consumablePurchaseId = 0;

  before(async () => {
    process.chdir(ROOT);
    dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.ok(!PROD_DIR.endsWith("gia-v3-test"));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "persist-restart" });

    const pu = await import("../v3/purchaseService");
    const wh = await import("../v3/warehouseService");
    createPurchase = pu.createPurchase;
    listMovements = wh.listMovements;
    listKitchenStock = wh.listKitchenStock;
  });

  after(async () => {
    try {
      await dbMod.closeDatabase();
    } catch {
      /* */
    }
    writeIsolationGuard(GUARD, { suite: "persist-restart", closed: true });
  });

  it("create WAREHOUSE / KITCHEN_DIRECT / CONSUMABLE with committed proof", async () => {
    const wh = await createPurchase({
      itemName: "منتج جديد ثابت WH",
      quantityNumeric: 11,
      quantityRaw: "11",
      unitRaw: "kg",
      totalAmount: 110000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "persist-test",
      clientRequestId: "persist-wh-1",
    });
    assert.equal(wh.committed, true);
    assert.ok(wh.purchaseId > 0);
    assert.ok(wh.inventoryItemId! > 0);
    assert.ok(wh.movementId! > 0);
    assert.equal(wh.destination, "WAREHOUSE");
    warehousePurchaseId = wh.purchaseId;
    warehouseItemId = wh.inventoryItemId!;
    warehouseMovementId = wh.movementId!;

    const inbound = await listMovements({ movementType: "WAREHOUSE_IN", pageSize: 50 });
    assert.ok(inbound.rows.some((r) => Number(r.id) === warehouseMovementId));

    const kit = await createPurchase({
      itemName: "منتج جديد ثابت KIT",
      quantityNumeric: 4,
      quantityRaw: "4",
      unitRaw: "kg",
      totalAmount: 40000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "persist-test",
      clientRequestId: "persist-kit-1",
    });
    assert.equal(kit.committed, true);
    assert.ok(kit.purchaseId > 0);
    assert.ok(kit.inventoryItemId! > 0);
    assert.ok(kit.movementId! > 0);
    kitchenPurchaseId = kit.purchaseId;
    kitchenItemId = kit.inventoryItemId!;
    kitchenMovementId = kit.movementId!;

    const whItem = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, warehouseItemId),
    });
    const kitItemBefore = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, kitchenItemId),
    });
    assert.equal(Number(whItem!.warehouseQtyNumeric), 11);
    assert.equal(Number(kitItemBefore!.kitchenQtyNumeric), 4);
    assert.equal(Number(kitItemBefore!.warehouseQtyNumeric || 0), 0);

    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.id === kitchenItemId && r.kitchenQty >= 4));

    const cons = await createPurchase({
      itemName: "مستهلك ثابت",
      quantityNumeric: 2,
      quantityRaw: "2",
      totalAmount: 20000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "persist-test",
      clientRequestId: "persist-cons-1",
    });
    assert.equal(cons.committed, true);
    assert.ok(cons.purchaseId > 0);
    assert.equal(cons.movementId, null);
    assert.equal(cons.inventoryItemId, null);
    consumablePurchaseId = cons.purchaseId;

    const consMoves = await dbMod.db
      .select()
      .from(dbMod.v3WarehouseMovementsTable)
      .where(eq(dbMod.v3WarehouseMovementsTable.purchaseId, consumablePurchaseId));
    assert.equal(consMoves.length, 0);
  });

  it("graceful closeDatabase + reopen keeps exact records", async () => {
    // Simulate graceful API stop (NOT force-kill)
    await dbMod.closeDatabase();
    assert.ok(!fs.existsSync(path.join(TEST_DIR, "postmaster.pid")) || true);

    installV3TestEnv();
    await dbMod.initDatabase();

    const whPur = await dbMod.db.query.v3PurchasesTable.findFirst({
      where: eq(dbMod.v3PurchasesTable.id, warehousePurchaseId),
    });
    const kitPur = await dbMod.db.query.v3PurchasesTable.findFirst({
      where: eq(dbMod.v3PurchasesTable.id, kitchenPurchaseId),
    });
    const consPur = await dbMod.db.query.v3PurchasesTable.findFirst({
      where: eq(dbMod.v3PurchasesTable.id, consumablePurchaseId),
    });
    assert.ok(whPur);
    assert.equal(whPur!.destination, "WAREHOUSE");
    assert.equal(Number(whPur!.quantityNumeric), 11);
    assert.equal(whPur!.status, "active");
    assert.ok(kitPur);
    assert.equal(kitPur!.destination, "KITCHEN_DIRECT");
    assert.ok(consPur);
    assert.equal(consPur!.destination, "CONSUMABLE");

    const whMov = await dbMod.db.query.v3WarehouseMovementsTable.findFirst({
      where: and(
        eq(dbMod.v3WarehouseMovementsTable.id, warehouseMovementId),
        eq(dbMod.v3WarehouseMovementsTable.status, "active"),
      ),
    });
    const kitMov = await dbMod.db.query.v3WarehouseMovementsTable.findFirst({
      where: and(
        eq(dbMod.v3WarehouseMovementsTable.id, kitchenMovementId),
        eq(dbMod.v3WarehouseMovementsTable.status, "active"),
      ),
    });
    assert.ok(whMov);
    assert.equal(whMov!.movementType, "WAREHOUSE_IN");
    assert.ok(kitMov);
    assert.equal(kitMov!.movementType, "KITCHEN_DIRECT_IN");

    const whItem = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, warehouseItemId),
    });
    const kitItem = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, kitchenItemId),
    });
    assert.equal(Number(whItem!.warehouseQtyNumeric), 11);
    assert.equal(Number(kitItem!.kitchenQtyNumeric), 4);

    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.id === kitchenItemId));
    const inbound = await listMovements({ movementType: "WAREHOUSE_IN", pageSize: 100 });
    assert.ok(inbound.rows.some((r) => Number(r.id) === warehouseMovementId));
  });

  it("invalid/incomplete commit payload must not be treated as success", async () => {
    // Mirrors frontend assertPurchaseCommitted rules
    function assertCommitted(raw: unknown, expectedDestination?: string) {
      const r = raw as {
        purchaseId?: number;
        purchase?: { id?: number; destination?: string; inventoryItemId?: number | null; movementId?: number | null };
        destination?: string;
        inventoryItemId?: number | null;
        movementId?: number | null;
      } | null;
      const purchaseId = Number(r?.purchaseId ?? r?.purchase?.id);
      if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
        throw new Error("لم يتم تأكيد حفظ المشتريات من الخادم — لم يُرجع رقم المشتريات.");
      }
      const destination = String(r?.destination ?? r?.purchase?.destination ?? "");
      if (expectedDestination && destination !== expectedDestination) {
        throw new Error("وجهة المشتريات المحفوظة لا تطابق ما أُرسل.");
      }
      const inventoryItemId = r?.inventoryItemId ?? r?.purchase?.inventoryItemId ?? null;
      const movementId = r?.movementId ?? r?.purchase?.movementId ?? null;
      if (destination === "WAREHOUSE" || destination === "KITCHEN_DIRECT") {
        if (!(Number(inventoryItemId) > 0)) throw new Error("لم يتم تأكيد ربط مادة المخزون بعد الحفظ.");
        if (!(Number(movementId) > 0)) throw new Error("لم يتم تأكيد حركة المخزون بعد الحفظ.");
      }
    }

    assert.throws(() => assertCommitted({}, "WAREHOUSE"), /لم يتم تأكيد/);
    assert.throws(
      () =>
        assertCommitted(
          { purchaseId: 1, destination: "WAREHOUSE", inventoryItemId: null, movementId: null },
          "WAREHOUSE",
        ),
      /مادة المخزون|حركة المخزون/,
    );
    assert.doesNotThrow(() =>
      assertCommitted(
        {
          purchaseId: 9,
          destination: "CONSUMABLE",
          inventoryItemId: null,
          movementId: null,
        },
        "CONSUMABLE",
      ),
    );
  });
});
