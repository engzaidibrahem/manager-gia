/**
 * PHASE 5.5 live ops on TEST DB only + production count guard.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = "d:/gia-shawarma-manager-self-host";
const PROD = path.resolve(ROOT, ".data/gia-v3");
const TEST = path.resolve(ROOT, ".data/gia-v3-test");
const GUARD = path.join(ROOT, "backups", "gia-v3-phase55-prod-guard.json");

async function countProd() {
  process.env.DATABASE_URL = "pglite://.data/gia-v3";
  // Must close any prior connection
  const dbMod = await import("@workspace/db");
  if ((dbMod as any).db) {
    try { await dbMod.closeDatabase(); } catch { /* */ }
  }
  await dbMod.initDatabase();
  const items = await dbMod.db.select().from(dbMod.v3InventoryItemsTable);
  const moves = await dbMod.db.select().from(dbMod.v3WarehouseMovementsTable);
  const summary = await (await import("../v3/warehouseService")).listWarehouseSummary({ page: 1, pageSize: 500 });
  await dbMod.closeDatabase();
  return {
    items: items.length,
    movements: moves.length,
    uiTotal: summary.total,
    uiRowsReturned: summary.rows.length,
    zeroVisible: summary.rows.filter((r) => r.currentWarehouse === 0).length,
    negativeAsUnknown: summary.rows.filter((r) => r.isNegative || (r.currentWarehouse != null && r.currentWarehouse < 0)).filter((r) => r.status === "unknown").length,
    qaInUi: summary.rows.filter((r) => /qa|test|اختبار/i.test(r.name)).length,
  };
}

async function runTestDbOps() {
  process.env.DATABASE_URL = "pglite://.data/gia-v3-test";
  if (fs.existsSync(TEST)) fs.rmSync(TEST, { recursive: true, force: true });

  const dbMod = await import("@workspace/db");
  try { await dbMod.closeDatabase(); } catch { /* */ }
  await dbMod.initDatabase();
  assert.ok(fs.existsSync(TEST), "test dir exists");
  assert.ok(!process.env.DATABASE_URL.includes("gia-v3") || process.env.DATABASE_URL.includes("gia-v3-test"));

  const {
    postOpeningBalance,
    postWarehouseIn,
    postWarehouseToKitchen,
    listWarehouseSummary,
  } = await import("../v3/warehouseService");
  const { eq } = await import("drizzle-orm");

  const open = await postOpeningBalance({
    name: "PHASE55 LIVE TEST OIL",
    category: "test",
    baseUnit: "L",
    quantityRaw: "10",
    quantityNumeric: 10,
    unitRaw: "L",
    actor: "phase55",
    clientRequestId: "p55-open",
  });
  const id = open.itemId!;
  await postWarehouseIn({ inventoryItemId: id, quantityRaw: "5", quantityNumeric: 5, unitRaw: "L", actor: "phase55", clientRequestId: "p55-in1" });
  await postWarehouseToKitchen({ inventoryItemId: id, quantityRaw: "4", quantityNumeric: 4, unitRaw: "L", actor: "phase55", clientRequestId: "p55-out1" });

  let item = await dbMod.db.query.v3InventoryItemsTable.findFirst({ where: eq(dbMod.v3InventoryItemsTable.id, id) });
  assert.equal(Number(item!.warehouseQtyNumeric), 11);
  assert.equal(Number(item!.kitchenQtyNumeric), 4);

  await postWarehouseToKitchen({ inventoryItemId: id, quantityRaw: "11", quantityNumeric: 11, unitRaw: "L", actor: "phase55", clientRequestId: "p55-out2" });
  item = await dbMod.db.query.v3InventoryItemsTable.findFirst({ where: eq(dbMod.v3InventoryItemsTable.id, id) });
  assert.equal(Number(item!.warehouseQtyNumeric), 0);
  assert.equal(item!.isActive, true);

  const list = await listWarehouseSummary({ q: "PHASE55 LIVE TEST OIL", page: 1, pageSize: 10 });
  assert.ok(list.rows.some((r) => r.id === id && r.currentWarehouse === 0), "zero stock visible in warehouse list");

  await postWarehouseIn({ inventoryItemId: id, quantityRaw: "7", quantityNumeric: 7, unitRaw: "L", actor: "phase55", clientRequestId: "p55-in2" });
  item = await dbMod.db.query.v3InventoryItemsTable.findFirst({ where: eq(dbMod.v3InventoryItemsTable.id, id) });
  assert.equal(Number(item!.warehouseQtyNumeric), 7);
  assert.equal(Number(item!.kitchenQtyNumeric), 15);

  // Simulate "restart": close + reopen same test DB (do not wipe)
  await dbMod.closeDatabase();
  process.env.DATABASE_URL = "pglite://.data/gia-v3-test";
  await dbMod.initDatabase();
  item = await dbMod.db.query.v3InventoryItemsTable.findFirst({ where: eq(dbMod.v3InventoryItemsTable.id, id) });
  assert.equal(Number(item!.warehouseQtyNumeric), 7);
  assert.equal(Number(item!.kitchenQtyNumeric), 15);

  let rejected = false;
  try {
    await postWarehouseToKitchen({ inventoryItemId: id, quantityRaw: "99", quantityNumeric: 99, unitRaw: "L", actor: "phase55", clientRequestId: "p55-over" });
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  item = await dbMod.db.query.v3InventoryItemsTable.findFirst({ where: eq(dbMod.v3InventoryItemsTable.id, id) });
  assert.equal(Number(item!.warehouseQtyNumeric), 7);

  await dbMod.closeDatabase();
  return {
    pass: true,
    afterRestart: { warehouse: 7, kitchen: 15 },
    overdrawRejected: true,
    zeroVisible: true,
  };
}

process.chdir(ROOT);
const before = await countProd();
fs.writeFileSync(GUARD, JSON.stringify({ before }, null, 2), "utf8");
console.log("BEFORE", before);

const testResults = await runTestDbOps();
console.log("TEST_DB", testResults);

const after = await countProd();
console.log("AFTER", after);

assert.equal(after.items, before.items, "prod items must not change");
assert.equal(after.movements, before.movements, "prod movements must not change");

fs.writeFileSync(GUARD, JSON.stringify({ before, after, testResults, unchanged: true }, null, 2), "utf8");
console.log(JSON.stringify({ before, after, testResults, unchanged: after.items === before.items && after.movements === before.movements }, null, 2));
