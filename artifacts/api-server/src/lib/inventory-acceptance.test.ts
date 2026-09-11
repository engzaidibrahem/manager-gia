/**
 * Full restaurant acceptance scenario (domain services + reconcile).
 * Uses isolated PGlite — operational paths only (no direct stock SET).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

const dataDir = path.join(os.tmpdir(), `gia-accept-${process.pid}-${Date.now()}`);
process.env.DATABASE_URL = `pglite:${dataDir}`;

const dbPkg = await import("@workspace/db");
const {
  inventoryItemsTable,
  inventoryMovementsTable,
  warehouseLotsTable,
  dailyPurchasesTable,
} = dbPkg;

let database: Awaited<ReturnType<typeof dbPkg.initDatabase>>;

const { upsertPurchases } = await import("../services/purchaseService.ts");
const { receivePurchase, receiveIntoWarehouse } = await import("../services/receivingService.ts");
const { transferStock } = await import("../services/transferService.ts");
const { reverseMovement, wasteStock, adjustStock } = await import("../services/inventoryService.ts");
const { getLotReconciliationReport } = await import("../services/lotReconciliation.ts");
const {
  computeRecipeLineCost,
  computeRecipeTotals,
} = await import("@workspace/inventory-math/recipe-cost");

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function lotSum(itemId: number) {
  const [row] = await database
    .select({ total: sql<number>`coalesce(sum(${warehouseLotsTable.quantityRemaining}), 0)` })
    .from(warehouseLotsTable)
    .where(eq(warehouseLotsTable.itemId, itemId));
  return Number(row?.total ?? 0);
}

async function refresh(itemId: number) {
  const item = await database.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, itemId) });
  assert.ok(item);
  return item;
}

describe("Full restaurant acceptance scenario", () => {
  before(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    database = await dbPkg.initDatabase();
  });

  after(async () => {
    await dbPkg.closeDatabase();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("Purchase→Receive→Transfer→Waste→Adjust→Recipe→Reconcile with data integrity", async () => {
    const [chicken] = await database.insert(inventoryItemsTable).values({
      name: "Chicken Acceptance",
      category: "protein",
      unit: "kg",
      brand: "",
      variant: "",
      qrToken: `gia-accept-chicken-${Date.now()}`,
      currentStock: 0,
      kitchenStock: 0,
      minimumStock: 10,
      costPerUnit: 40000,
    }).returning();

    // --- Purchase (invoice only) ---
    const [purchase] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "Test Supplier",
      itemName: chicken.name,
      quantity: 20,
      unit: "kg",
      unitPrice: 40000,
      totalAmount: 800000,
      invoiceNumber: "TEST-001",
      inventoryItemId: chicken.id,
      destination: "warehouse",
    }]);
    assert.equal(Number(purchase.totalAmount), 800000);
    let item = await refresh(chicken.id);
    assert.equal(Number(item.currentStock), 0, "Purchase must not change warehouse");
    assert.equal(Number(item.kitchenStock), 0, "Purchase must not change kitchen");
    assert.equal(await lotSum(chicken.id), 0);

    // --- Receive 20 kg ---
    const received = await receivePurchase(purchase.id, {
      quantity: 20, unit: "kg", actor: "warehouse-mgr",
    });
    item = await refresh(chicken.id);
    assert.equal(Number(item.currentStock), 20);
    assert.equal(Number(item.kitchenStock), 0);
    assert.equal(await lotSum(chicken.id), 20);
    const purchaseAfter = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchase.id),
    });
    assert.equal(Number(purchaseAfter?.quantityReceived), 20);
    assert.equal(String(purchaseAfter?.status), "received");
    assert.equal(received.movement.type, "receive");
    assert.ok(received.movement.actor);
    assert.ok(received.movement.lotAllocations);

    // --- Transfer 5 kg WH → Kitchen ---
    const xfer = await transferStock({
      itemId: chicken.id,
      quantity: 5,
      unit: "kg",
      from: "warehouse",
      to: "kitchen",
      actor: "warehouse-mgr",
    });
    item = await refresh(chicken.id);
    assert.equal(Number(item.currentStock), 15);
    assert.equal(Number(item.kitchenStock), 5);
    assert.equal(await lotSum(chicken.id), 15);
    assert.ok(xfer.movementId);

    // --- Kitchen waste 0.5 kg ---
    let wasteMovId = 0;
    await database.transaction(async (tx) => {
      const w = await wasteStock(tx, {
        itemId: chicken.id,
        location: "kitchen",
        quantity: 0.5,
        unit: "kg",
        actor: "chef",
        reason: "prep",
      });
      wasteMovId = w.movement.id;
    });
    item = await refresh(chicken.id);
    assert.equal(Number(item.kitchenStock), 4.5);
    assert.equal(Number(item.currentStock), 15);

    // --- Adjustment +0.5 kg warehouse ---
    let adjMovId = 0;
    await database.transaction(async (tx) => {
      const a = await adjustStock(tx, {
        itemId: chicken.id,
        location: "warehouse",
        quantity: 0.5,
        unit: "kg",
        actor: "mgr",
        note: "count correction +0.5",
      });
      adjMovId = a.movement.id;
      assert.equal(Number(a.movement.baseQuantity), 0.5);
    });
    item = await refresh(chicken.id);
    assert.equal(Number(item.currentStock), 15.5);
    assert.equal(await lotSum(chicken.id), 15.5);

    // Reverse adjustment → back to 15
    await database.transaction(async (tx) => {
      await reverseMovement(tx, adjMovId, "mgr", 1, "undo adj");
    });
    item = await refresh(chicken.id);
    assert.equal(Number(item.currentStock), 15);
    assert.equal(await lotSum(chicken.id), 15);

    // --- Recipe costing (shared SoT) ---
    const garlic = computeRecipeLineCost({
      quantity: 10, unit: "g", itemUnit: "kg", costPerUnit: 10000,
    }).lineCost;
    const coleslaw = computeRecipeLineCost({
      quantity: 20, unit: "g", itemUnit: "kg", costPerUnit: 8000,
    }).lineCost;
    const bread = computeRecipeLineCost({
      quantity: 1, unit: "pcs", itemUnit: "pcs", costPerUnit: 1500,
    }).lineCost;
    const chickLine = computeRecipeLineCost({
      quantity: 100, unit: "g", itemUnit: "kg", costPerUnit: 40000,
    }).lineCost;
    const totals = computeRecipeTotals([garlic, coleslaw, bread, chickLine], 10, 20000);
    assert.equal(totals.totalCost, 5760);
    assert.equal(totals.costPerPortion, 576);
    assert.equal(totals.foodCostPct, 2.88);

    // Recipe math must not mutate stock
    const afterRecipe = await refresh(chicken.id);
    assert.equal(Number(afterRecipe.currentStock), 15);
    assert.equal(Number(afterRecipe.kitchenStock), 4.5);

    // --- Reconciliation: no discrepancies for this item ---
    const report = await getLotReconciliationReport();
    const disc = report.discrepancies.find((d) => d.itemId === chicken.id);
    assert.equal(disc, undefined, `expected NO DISCREPANCIES for chicken, got ${JSON.stringify(disc)}`);
    assert.equal(await lotSum(chicken.id), Number((await refresh(chicken.id)).currentStock));

    // --- Data integrity checks ---
    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, chicken.id));
    assert.ok(moves.some((m) => m.type === "receive"));
    assert.ok(moves.some((m) => m.type === "transfer"));
    assert.ok(moves.some((m) => m.type === "waste" && m.id === wasteMovId));
    assert.ok(moves.some((m) => m.type === "adjustment"));
    assert.ok(moves.some((m) => m.type === "reversal"));
    assert.ok(moves.every((m) => Number(m.quantity) >= 0));
    assert.ok(Number((await refresh(chicken.id)).currentStock) >= 0);
    assert.ok(Number((await refresh(chicken.id)).kitchenStock) >= 0);

    const lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, chicken.id));
    assert.ok(lots.length >= 1);
    assert.ok(lots.every((l) => Number(l.quantityRemaining) >= -0.0001));

    // Purchase still exists (received history preserved)
    const pFinal = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchase.id),
    });
    assert.ok(pFinal);
    assert.equal(Number(pFinal!.quantityReceived), 20);
  });

  it("Shared recipe-cost module: FE preview import === backend SoT", async () => {
    // Both API and FE re-export @workspace/inventory-math — prove one module identity
    const shared = await import("@workspace/inventory-math/recipe-cost");
    const api = await import("../lib/recipe-cost.ts");
    assert.equal(shared.computeRecipeLineCost, api.computeRecipeLineCost);
    assert.equal(shared.computeRecipeTotals, api.computeRecipeTotals);

    const garlic = shared.computeRecipeLineCost({
      quantity: 10, unit: "g", itemUnit: "kg", costPerUnit: 10000,
    }).lineCost;
    const coleslaw = shared.computeRecipeLineCost({
      quantity: 20, unit: "g", itemUnit: "kg", costPerUnit: 8000,
    }).lineCost;
    const bread = shared.computeRecipeLineCost({
      quantity: 1, unit: "pcs", itemUnit: "pcs", costPerUnit: 1500,
    }).lineCost;
    const chicken = shared.computeRecipeLineCost({
      quantity: 100, unit: "g", itemUnit: "kg", costPerUnit: 40000,
    }).lineCost;
    const preview = shared.computeRecipeTotals([garlic, coleslaw, bread, chicken], 10, 20000);
    const authoritative = api.computeRecipeTotals([garlic, coleslaw, bread, chicken], 10, 20000);
    assert.deepEqual(preview, authoritative);
    assert.equal(authoritative.totalCost, 5760);
    assert.equal(authoritative.costPerPortion, 576);
    assert.equal(authoritative.foodCostPct, 2.88);
  });
});
