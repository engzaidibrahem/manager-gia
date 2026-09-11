/**
 * GIA V3 warehouse tests — MUST use isolated test DB only.
 * DATABASE_URL is forced to pglite://.data/gia-v3-test BEFORE initDatabase.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { openFreshV3TestDatabase } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_V3 = path.resolve(ROOT, ".data/gia-v3");

describe("V3 Warehouse ledger", () => {
  let db: typeof import("@workspace/db").db;
  let v3InventoryItemsTable: typeof import("@workspace/db").v3InventoryItemsTable;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postWarehouseIn: typeof import("../v3/warehouseService").postWarehouseIn;
  let postWarehouseToKitchen: typeof import("../v3/warehouseService").postWarehouseToKitchen;
  let stockStatus: typeof import("../v3/warehouseService").stockStatus;
  let updateItemMinimum: typeof import("../v3/warehouseService").updateItemMinimum;
  let closeDatabase: typeof import("@workspace/db").closeDatabase;

  before(async () => {
    process.chdir(ROOT);
    const dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.ok(fs.existsSync(TEST_DIR), "test DB dir must exist after init");
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    assert.notEqual(path.resolve(TEST_DIR), path.resolve(PROD_V3));

    db = dbMod.db;
    v3InventoryItemsTable = dbMod.v3InventoryItemsTable;
    closeDatabase = dbMod.closeDatabase;

    const svc = await import("../v3/warehouseService");
    postOpeningBalance = svc.postOpeningBalance;
    postWarehouseIn = svc.postWarehouseIn;
    postWarehouseToKitchen = svc.postWarehouseToKitchen;
    stockStatus = svc.stockStatus;
    updateItemMinimum = svc.updateItemMinimum;
  });

  after(async () => {
    await closeDatabase();
  });

  it("1-5: opening + in + out + drain to zero + restock; item stays", async () => {
    const open = await postOpeningBalance({
      name: "زيت اختبار",
      category: "test",
      baseUnit: "لتر",
      quantityRaw: "10",
      quantityNumeric: 10,
      unitRaw: "لتر",
      actor: "test",
      clientRequestId: "t-open-1",
    });
    assert.equal(open.idempotent, false);
    const itemId = open.itemId!;

    let item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, itemId) });
    assert.equal(Number(item!.warehouseQtyNumeric), 10);

    await postWarehouseIn({
      inventoryItemId: itemId,
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "لتر",
      actor: "test",
      clientRequestId: "t-in-1",
    });
    item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, itemId) });
    assert.equal(Number(item!.warehouseQtyNumeric), 30);

    await postWarehouseToKitchen({
      inventoryItemId: itemId,
      quantityRaw: "5",
      quantityNumeric: 5,
      unitRaw: "لتر",
      actor: "test",
      clientRequestId: "t-out-1",
    });
    item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, itemId) });
    assert.equal(Number(item!.warehouseQtyNumeric), 25);
    assert.equal(Number(item!.kitchenQtyNumeric), 5);

    await postWarehouseToKitchen({
      inventoryItemId: itemId,
      quantityRaw: "25",
      quantityNumeric: 25,
      unitRaw: "لتر",
      actor: "test",
      clientRequestId: "t-out-2",
    });
    item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, itemId) });
    assert.equal(Number(item!.warehouseQtyNumeric), 0);
    assert.equal(item!.isActive, true);
    assert.equal(Number(item!.kitchenQtyNumeric), 30);

    await postWarehouseIn({
      inventoryItemId: itemId,
      quantityRaw: "10",
      quantityNumeric: 10,
      unitRaw: "لتر",
      actor: "test",
      clientRequestId: "t-in-2",
    });
    item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, itemId) });
    assert.equal(Number(item!.warehouseQtyNumeric), 10);
    assert.equal(Number(item!.kitchenQtyNumeric), 30);
  });

  it("6: reject OUT > available", async () => {
    const open = await postOpeningBalance({
      name: "سكر اختبار",
      category: "test",
      baseUnit: "كيس",
      quantityRaw: "5",
      quantityNumeric: 5,
      unitRaw: "كيس",
      actor: "test",
      clientRequestId: "t-open-2",
    });
    let threw = false;
    try {
      await postWarehouseToKitchen({
        inventoryItemId: open.itemId!,
        quantityRaw: "6",
        quantityNumeric: 6,
        unitRaw: "كيس",
        actor: "test",
        clientRequestId: "t-out-over",
      });
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /أكبر من الكمية|INSUFFICIENT|available/i);
    }
    assert.equal(threw, true);
    const item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, open.itemId!) });
    assert.equal(Number(item!.warehouseQtyNumeric), 5);
  });

  it("7-9: zero visible; low only when minimum set; null minimum no fake warning", async () => {
    assert.equal(stockStatus(0, null), "out");
    assert.equal(stockStatus(-1, null), "unknown");
    assert.equal(stockStatus(4, 5), "low");
    assert.equal(stockStatus(4, null), "available");
    assert.equal(stockStatus(null, 5), "unknown");

    const open = await postOpeningBalance({
      name: "ملح اختبار",
      category: "test",
      baseUnit: "كيس",
      quantityRaw: "4",
      quantityNumeric: 4,
      unitRaw: "كيس",
      actor: "test",
      clientRequestId: "t-open-3",
    });
    let item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, open.itemId!) });
    assert.equal(stockStatus(Number(item!.warehouseQtyNumeric), item!.minimumStock == null ? null : Number(item!.minimumStock)), "available");

    await updateItemMinimum(open.itemId!, 5);
    item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, open.itemId!) });
    assert.equal(stockStatus(Number(item!.warehouseQtyNumeric), Number(item!.minimumStock)), "low");
  });

  it("idempotent clientRequestId does not double stock", async () => {
    const a = await postOpeningBalance({
      name: "طحين اختبار",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "2",
      quantityNumeric: 2,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "t-idem-open",
    });
    const b = await postOpeningBalance({
      name: "طحين اختبار",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "2",
      quantityNumeric: 2,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: "t-idem-open",
    });
    assert.equal(b.idempotent, true);
    const item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, a.itemId!) });
    assert.equal(Number(item!.warehouseQtyNumeric), 2);
  });

  it("non-numeric opening stored as raw; numeric balance stays null until numeric moves", async () => {
    const open = await postOpeningBalance({
      name: "بهارات نص",
      category: "test",
      baseUnit: "كما ورد",
      quantityRaw: "3 أكياس صغيرة",
      quantityNumeric: null,
      unitRaw: "كما ورد في الجرد",
      actor: "test",
      clientRequestId: "t-raw-open",
    });
    const item = await db.query.v3InventoryItemsTable.findFirst({ where: eq(v3InventoryItemsTable.id, open.itemId!) });
    assert.equal(item!.warehouseQtyNumeric, null);
  });
});
