/**
 * Destination isolation — KITCHEN_DIRECT must never appear as warehouse stock.
 * TEST DB ONLY (.data/gia-v3-test).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_DIR = path.resolve(ROOT, ".data/gia-v3");
const GUARD = path.resolve(ROOT, "backups/gia-v3-destination-isolation-prod-guard.json");

describe("V3 destination isolation (warehouse vs kitchen)", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let closeDatabase: typeof import("@workspace/db").closeDatabase;
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let listWarehouseSummary: typeof import("../v3/warehouseService").listWarehouseSummary;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;
  let listItemsBrief: typeof import("../v3/warehouseService").listItemsBrief;

  before(async () => {
    process.chdir(ROOT);
    const dbMod0 = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod0);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.notEqual(path.resolve(TEST_DIR), path.resolve(PROD_DIR));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "destination-isolation" });

    db = dbMod0.db;
    tables = dbMod0;
    closeDatabase = dbMod0.closeDatabase;

    const wh = await import("../v3/warehouseService");
    const pu = await import("../v3/purchaseService");
    postOpeningBalance = wh.postOpeningBalance;
    listWarehouseSummary = wh.listWarehouseSummary;
    listKitchenStock = wh.listKitchenStock;
    listItemsBrief = wh.listItemsBrief;
    createPurchase = pu.createPurchase;
  });

  after(async () => {
    await closeDatabase();
    writeIsolationGuard(GUARD, { suite: "destination-isolation", closed: true });
  });

  it("A) brand-new KITCHEN_DIRECT: kitchen yes, warehouse list/IN no, stock unchanged", async () => {
    const marker = `عزل مطبخ جديد ${Date.now()}`;
    const beforeWh = await listWarehouseSummary({ q: marker, page: 1, pageSize: 50 });
    assert.equal(beforeWh.rows.length, 0);

    const result = await createPurchase({
      itemName: marker,
      quantityNumeric: 10,
      quantityRaw: "10",
      unitRaw: "kg",
      totalAmount: 100000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "test",
      clientRequestId: `iso-kit-new-${Date.now()}`,
    });

    assert.ok(result.purchase?.id);
    assert.ok(result.purchase?.inventoryItemId);
    assert.ok(result.movementId);

    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, result.purchase!.inventoryItemId!),
    });
    assert.ok(item);
    assert.equal(item!.sourceType, "KITCHEN_DIRECT");
    assert.equal(item!.warehouseQtyNumeric, null);
    assert.equal(Number(item!.kitchenQtyNumeric), 10);

    const moves = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(eq(tables.v3WarehouseMovementsTable.purchaseId, result.purchase!.id));
    assert.equal(moves.length, 1);
    assert.equal(moves[0]!.movementType, "KITCHEN_DIRECT_IN");
    assert.equal(moves.filter((m) => m.movementType === "WAREHOUSE_IN").length, 0);

    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((r) => r.name === marker && r.kitchenQty === 10));

    const wh = await listWarehouseSummary({ q: marker, page: 1, pageSize: 50 });
    assert.equal(
      wh.rows.filter((r) => r.id === result.purchase!.inventoryItemId).length,
      0,
      "kitchen-direct-only item must not appear on warehouse page",
    );

    const brief = await listItemsBrief(marker);
    assert.equal(
      brief.filter((r) => r.id === result.purchase!.inventoryItemId).length,
      0,
      "kitchen-direct-only item must not appear in warehouse pickers",
    );
  });

  it("B) existing warehouse item + KITCHEN_DIRECT: WH qty unchanged, no WAREHOUSE_IN, still listed", async () => {
    const marker = `عزل مستودع قائم ${Date.now()}`;
    const open = await postOpeningBalance({
      name: marker,
      category: "test",
      baseUnit: "kg",
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: `iso-open-${Date.now()}`,
    });
    const itemId = open.itemId!;

    const before = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(before!.warehouseQtyNumeric), 20);

    await createPurchase({
      itemName: marker,
      inventoryItemId: itemId,
      quantityNumeric: 7,
      quantityRaw: "7",
      unitRaw: "kg",
      totalAmount: 70000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "test",
      clientRequestId: `iso-kit-exist-${Date.now()}`,
    });

    const after = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(after!.warehouseQtyNumeric), 20);
    assert.equal(Number(after!.kitchenQtyNumeric), 7);

    const moves = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(eq(tables.v3WarehouseMovementsTable.inventoryItemId, itemId));
    assert.equal(moves.filter((m) => m.movementType === "WAREHOUSE_IN").length, 0);
    assert.ok(moves.some((m) => m.movementType === "KITCHEN_DIRECT_IN"));

    const wh = await listWarehouseSummary({ q: marker, page: 1, pageSize: 50 });
    const row = wh.rows.find((r) => r.id === itemId);
    assert.ok(row, "existing warehouse item must remain on warehouse page");
    assert.equal(Number(row!.currentWarehouse), 20);
    assert.equal(Number(row!.totalIn), 0);
  });

  it("C) WAREHOUSE purchase: WAREHOUSE_IN, warehouse stock up, listed", async () => {
    const marker = `عزل شراء مستودع ${Date.now()}`;
    const result = await createPurchase({
      itemName: marker,
      newItem: { name: marker, category: "test", baseUnit: "kg" },
      quantityNumeric: 5,
      quantityRaw: "5",
      unitRaw: "kg",
      totalAmount: 50000,
      paymentStatus: "UNPAID",
      destination: "WAREHOUSE",
      actor: "test",
      clientRequestId: `iso-wh-${Date.now()}`,
    });

    assert.ok(result.purchase?.inventoryItemId);
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, result.purchase!.inventoryItemId!),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 5);
    assert.equal(Number(item!.kitchenQtyNumeric ?? 0), 0);

    const moves = await db
      .select()
      .from(tables.v3WarehouseMovementsTable)
      .where(eq(tables.v3WarehouseMovementsTable.purchaseId, result.purchase!.id));
    assert.equal(moves.length, 1);
    assert.equal(moves[0]!.movementType, "WAREHOUSE_IN");

    const wh = await listWarehouseSummary({ q: marker, page: 1, pageSize: 50 });
    assert.ok(wh.rows.some((r) => r.id === result.purchase!.inventoryItemId && Number(r.currentWarehouse) === 5));
  });

  it("D) CONSUMABLE: purchase only — no inventory item, no movements", async () => {
    const marker = `عزل استهلاكي ${Date.now()}`;
    const beforeItems = (await db.select().from(tables.v3InventoryItemsTable)).length;
    const beforeMoves = (await db.select().from(tables.v3WarehouseMovementsTable)).length;

    const result = await createPurchase({
      itemName: marker,
      totalAmount: 25000,
      paymentStatus: "UNPAID",
      destination: "CONSUMABLE",
      actor: "test",
      clientRequestId: `iso-con-${Date.now()}`,
    });

    assert.ok(result.purchase?.id);
    assert.equal(result.purchase!.inventoryItemId, null);
    assert.equal(result.movementId, null);
    assert.equal((await db.select().from(tables.v3InventoryItemsTable)).length, beforeItems);
    assert.equal((await db.select().from(tables.v3WarehouseMovementsTable)).length, beforeMoves);

    const wh = await listWarehouseSummary({ q: marker, page: 1, pageSize: 50 });
    assert.equal(wh.rows.length, 0);
    const kitchen = await listKitchenStock();
    assert.equal(kitchen.filter((r) => r.name === marker).length, 0);
  });
});
