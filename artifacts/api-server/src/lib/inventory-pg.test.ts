/**
 * PostgreSQL-only concurrency gate.
 *
 * SKIPPED unless a real Postgres server is reachable.
 * Does not alter production code paths.
 *
 *   pnpm run dev:db
 *   pnpm --filter @workspace/api-server run test:pg
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const pgUrl =
  process.env.DATABASE_URL_PG
  || (process.env.DATABASE_URL?.startsWith("postgres") ? process.env.DATABASE_URL : "");

let pgAvailable = false;
let skipReason = "DATABASE_URL_PG not set (Docker Postgres not configured for this run)";

if (pgUrl) {
  process.env.DATABASE_URL = pgUrl; // must be set before @workspace/db init
  try {
    const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 2500 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    pgAvailable = true;
  } catch (err) {
    skipReason = `PostgreSQL unreachable at configured URL: ${err instanceof Error ? err.message : String(err)}`;
    pgAvailable = false;
  }
}

describe("PostgreSQL Inventory Core (real server)", {
  skip: pgAvailable ? false : `POSTGRESQL CONCURRENCY = NOT VERIFIED — ${skipReason}`,
}, () => {
  const marker = `pg-${Date.now()}`;
  let dbPkg: typeof import("@workspace/db");

  before(async () => {
    dbPkg = await import("@workspace/db");
    await dbPkg.initDatabase();
  });

  after(async () => {
    await dbPkg.closeDatabase().catch(() => undefined);
  });

  it("Purchase → Receive → Transfer → concurrent safety on PostgreSQL", async () => {
    const { db, inventoryItemsTable } = dbPkg;
    const { upsertPurchases } = await import("../services/purchaseService.ts");
    const { receivePurchase, receiveIntoWarehouse } = await import("../services/receivingService.ts");
    const { transferStock } = await import("../services/transferService.ts");
    const { wasteStock, reverseMovement } = await import("../services/inventoryService.ts");
    const { eq } = await import("drizzle-orm");

    const [item] = await db.insert(inventoryItemsTable).values({
      name: `PG Chicken ${marker}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-pg-${marker}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 40000,
    }).returning();

    const [purchase] = await upsertPurchases([{
      purchaseDate: "2026-09-06",
      supplier: "PG",
      itemName: item.name,
      quantity: 10,
      unit: "kg",
      unitPrice: 40000,
      inventoryItemId: item.id,
      destination: "warehouse",
    }]);
    let cur = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) });
    assert.equal(Number(cur?.currentStock), 0);

    await receivePurchase(purchase.id, { quantity: 10, unit: "kg", actor: "pg" });
    cur = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) });
    assert.equal(Number(cur?.currentStock), 10);

    // FIFO setup on a second item
    const [fifo] = await db.insert(inventoryItemsTable).values({
      name: `PG FIFO ${marker}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-pg-fifo-${marker}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 1,
    }).returning();
    await receiveIntoWarehouse({ itemId: fifo.id, quantity: 5, unit: "kg", actor: "pg", receiptDate: "2026-01-01" });
    await receiveIntoWarehouse({ itemId: fifo.id, quantity: 10, unit: "kg", actor: "pg", receiptDate: "2026-01-02" });
    const fifoXfer = await transferStock({ itemId: fifo.id, quantity: 7, unit: "kg", from: "warehouse", to: "kitchen", actor: "pg" });
    const fifoFinal = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, fifo.id) });
    assert.equal(Number(fifoFinal?.currentStock), 8);
    assert.equal(Number(fifoFinal?.kitchenStock), 7);

    await db.transaction(async (tx) => {
      await reverseMovement(tx, fifoXfer.movementId, "pg", null, "pg fifo reverse");
    });
    const fifoAfterRev = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, fifo.id) });
    assert.equal(Number(fifoAfterRev?.currentStock), 15);
    assert.equal(Number(fifoAfterRev?.kitchenStock), 0);
    const { warehouseLotsTable } = dbPkg;
    const { sql } = await import("drizzle-orm");
    const lots = await db.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, fifo.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 5);
    assert.equal(Number(lots[1]!.quantityRemaining), 10);

    // Concurrent: reset dedicated item to 5kg warehouse
    const [race] = await db.insert(inventoryItemsTable).values({
      name: `PG Race ${marker}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-pg-race-${marker}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 1,
    }).returning();
    await receiveIntoWarehouse({ itemId: race.id, quantity: 5, unit: "kg", actor: "pg" });

    const results = await Promise.allSettled([
      transferStock({ itemId: race.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "A" }),
      transferStock({ itemId: race.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "B" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const raceFinal = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, race.id) });
    assert.equal(Number(raceFinal?.currentStock), 1);
    assert.equal(Number(raceFinal?.kitchenStock), 4);

    // Waste + reverse smoke
    await db.transaction(async (tx) => {
      await wasteStock(tx, { itemId: race.id, location: "kitchen", quantity: 1, unit: "kg", actor: "pg", reason: "prep" });
    });
    const afterWaste = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, race.id) });
    assert.equal(Number(afterWaste?.kitchenStock), 3);

    const recv = await receiveIntoWarehouse({ itemId: item.id, quantity: 1, unit: "kg", actor: "pg" });
    await db.transaction(async (tx) => {
      await reverseMovement(tx, recv.movement.id, "pg", null, "pg reverse");
    });
  });
});
