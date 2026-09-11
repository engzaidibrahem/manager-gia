/**
 * PostgreSQL acceptance: concurrent race + operational reconcile.
 * Skipped unless real Postgres is reachable (not PGlite).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";

const pgUrl =
  process.env.DATABASE_URL_PG
  || (process.env.DATABASE_URL?.startsWith("postgres") ? process.env.DATABASE_URL : "");

let pgAvailable = false;
let skipReason = "DATABASE_URL_PG not set";

if (pgUrl) {
  process.env.DATABASE_URL = pgUrl;
  try {
    const client = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 2500 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    pgAvailable = true;
  } catch (err) {
    skipReason = `PostgreSQL unreachable: ${err instanceof Error ? err.message : String(err)}`;
    pgAvailable = false;
  }
}

describe("PostgreSQL acceptance + live reconcile", {
  skip: pgAvailable ? false : `POSTGRESQL = NOT VERIFIED — ${skipReason}`,
}, () => {
  const marker = `pg-accept-${Date.now()}`;
  let dbPkg: typeof import("@workspace/db");

  before(async () => {
    dbPkg = await import("@workspace/db");
    await dbPkg.initDatabase();
  });

  after(async () => {
    await dbPkg.closeDatabase().catch(() => undefined);
  });

  it("Concurrent 4+4 from 5kg → one success, stock=1, lots intact", async () => {
    const { db, inventoryItemsTable, warehouseLotsTable } = dbPkg;
    const { receiveIntoWarehouse } = await import("../services/receivingService.ts");
    const { transferStock } = await import("../services/transferService.ts");
    const { getLotReconciliationReport } = await import("../services/lotReconciliation.ts");
    const { eq, sql } = await import("drizzle-orm");

    const [item] = await db.insert(inventoryItemsTable).values({
      name: `PG Concurrent ${marker}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-pg-c-${marker}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 0,
      costPerUnit: 1,
    }).returning();

    await receiveIntoWarehouse({ itemId: item.id, quantity: 5, unit: "kg", actor: "pg" });

    const results = await Promise.allSettled([
      transferStock({ itemId: item.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "A" }),
      transferStock({ itemId: item.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "B" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    const final = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) });
    assert.equal(Number(final?.currentStock), 1);
    assert.equal(Number(final?.kitchenStock), 4);
    assert.ok(Number(final?.currentStock) >= 0);

    const [lotTotal] = await db
      .select({ total: sql<number>`coalesce(sum(${warehouseLotsTable.quantityRemaining}), 0)` })
      .from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id));
    assert.equal(Number(lotTotal?.total ?? 0), 1);

    const report = await getLotReconciliationReport();
    const disc = report.discrepancies.find((d) => d.itemId === item.id);
    assert.equal(disc, undefined, `NO DISCREPANCIES expected, got ${JSON.stringify(disc)}`);
  });

  it("Operational flow then reconcile has no discrepancy", async () => {
    const { db, inventoryItemsTable, warehouseLotsTable } = dbPkg;
    const { upsertPurchases } = await import("../services/purchaseService.ts");
    const { receivePurchase } = await import("../services/receivingService.ts");
    const { transferStock } = await import("../services/transferService.ts");
    const { wasteStock, adjustStock, reverseMovement } = await import("../services/inventoryService.ts");
    const { getLotReconciliationReport } = await import("../services/lotReconciliation.ts");
    const { eq, sql } = await import("drizzle-orm");

    const [item] = await db.insert(inventoryItemsTable).values({
      name: `PG Ops ${marker}`,
      category: "test",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-pg-ops-${marker}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 10,
      costPerUnit: 40000,
    }).returning();

    const [purchase] = await upsertPurchases([{
      purchaseDate: "2026-09-06",
      supplier: "PG",
      itemName: item.name,
      quantity: 20,
      unit: "kg",
      unitPrice: 40000,
      inventoryItemId: item.id,
    }]);
    assert.equal(Number((await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) }))?.currentStock), 0);

    await receivePurchase(purchase.id, { quantity: 20, unit: "kg", actor: "pg" });
    await transferStock({ itemId: item.id, quantity: 5, unit: "kg", from: "warehouse", to: "kitchen", actor: "pg" });
    await db.transaction(async (tx) => {
      await wasteStock(tx, { itemId: item.id, location: "kitchen", quantity: 0.5, unit: "kg", actor: "pg", reason: "prep" });
    });
    let adjId = 0;
    await db.transaction(async (tx) => {
      const a = await adjustStock(tx, {
        itemId: item.id, location: "warehouse", quantity: 0.5, unit: "kg", actor: "pg",
      });
      adjId = a.movement.id;
    });
    await db.transaction(async (tx) => {
      await reverseMovement(tx, adjId, "pg", null, "undo");
    });

    const cur = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) });
    assert.equal(Number(cur?.currentStock), 15);
    assert.equal(Number(cur?.kitchenStock), 4.5);

    const [lotTotal] = await db
      .select({ total: sql<number>`coalesce(sum(${warehouseLotsTable.quantityRemaining}), 0)` })
      .from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id));
    assert.equal(Number(lotTotal?.total ?? 0), Number(cur?.currentStock));

    const report = await getLotReconciliationReport();
    const disc = report.discrepancies.find((d) => d.itemId === item.id);
    assert.equal(disc, undefined, `LIVE RECONCILE NO DISCREPANCIES — ${JSON.stringify(disc)}`);
  });
});
