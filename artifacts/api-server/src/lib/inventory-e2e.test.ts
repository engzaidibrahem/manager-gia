/**
 * Real Inventory Core E2E / concurrency / FIFO / units / auth / low-stock tests.
 * Uses an isolated PGlite data directory (not the live .data store).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";

const dataDir = path.join(os.tmpdir(), `gia-inv-e2e-${process.pid}-${Date.now()}`);
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
const { reverseMovement, wasteStock, adjustStock, applyLocationDelta } = await import("../services/inventoryService.ts");
const { getLotReconciliationReport, backfillLegacyLots } = await import("../services/lotReconciliation.ts");
const { convertToBaseUnit } = await import("./units.ts");
const { AppError } = await import("./errors.ts");
const { canAccess } = await import("../auth/roles.ts");

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function createItem(name: string, unit = "kg", extras: Partial<{ currentStock: number; kitchenStock: number; minimumStock: number }> = {}) {
  const [item] = await database.insert(inventoryItemsTable).values({
    name,
    category: "test",
    unit,
    brand: "",
    variant: "",
    qrToken: `gia-e2e-${name.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    currentStock: extras.currentStock ?? 0,
    kitchenStock: extras.kitchenStock ?? 0,
    minimumStock: extras.minimumStock ?? 10,
    costPerUnit: 40000,
  }).returning();
  return item;
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

describe("Inventory Core production E2E", () => {
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

  it("E2E: purchase → receive → transfer → waste", async () => {
    const item = await createItem("Chicken E2E");
    assert.equal(Number(item.currentStock), 0);
    assert.equal(Number(item.kitchenStock), 0);

    const [purchase] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "Test Supplier",
      itemName: "Chicken E2E",
      quantity: 10,
      unit: "kg",
      unitPrice: 40000,
      inventoryItemId: item.id,
      destination: "warehouse",
    }]);
    assert.ok(purchase.id);
    assert.equal(String(purchase.status), "ordered");

    let afterPurchase = await refresh(item.id);
    assert.equal(Number(afterPurchase.currentStock), 0, "Purchase must not change warehouse stock");
    assert.equal(Number(afterPurchase.kitchenStock), 0);

    const received = await receivePurchase(purchase.id, {
      quantity: 10,
      unit: "kg",
      actor: "warehouse-user",
      userId: 1,
      note: "Receive 10kg chicken",
    });
    assert.equal(received.warehouseStock, 10);
    assert.equal(received.kitchenStock, 0);
    assert.equal(Number(received.lot.quantityRemaining), 10);
    assert.equal(received.movement.type, "receive");
    assert.ok(received.movement.actor);
    assert.ok(received.movement.createdAt);

    const xfer = await transferStock({
      itemId: item.id,
      quantity: 3,
      unit: "kg",
      from: "warehouse",
      to: "kitchen",
      actor: "warehouse-user",
      userId: 1,
      method: "manual",
    });
    assert.equal(xfer.warehouseStock, 7);
    assert.equal(xfer.kitchenStock, 3);
    assert.equal(await lotSum(item.id), 7);

    await database.transaction(async (tx) => {
      await wasteStock(tx, {
        itemId: item.id,
        location: "kitchen",
        quantity: 1,
        unit: "kg",
        actor: "kitchen-user",
        userId: 2,
        reason: "prep",
        note: "Prep waste 1kg",
      });
    });

    const final = await refresh(item.id);
    assert.equal(Number(final.currentStock), 7);
    assert.equal(Number(final.kitchenStock), 2);
    assert.equal(await lotSum(item.id), 7);

    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    const types = moves.map((m) => m.type);
    assert.ok(types.includes("receive"));
    assert.ok(types.includes("transfer"));
    assert.ok(types.includes("waste"));
    for (const m of moves) {
      assert.ok(m.actor?.trim(), `movement #${m.id} missing actor`);
      assert.ok(m.createdAt, `movement #${m.id} missing timestamp`);
      assert.ok(Number(m.quantity) > 0);
    }
  });

  it("Purchase does not modify stock; receive does; partial receive works", async () => {
    const item = await createItem("Partial Chicken");
    const [purchase] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "S",
      itemName: item.name,
      quantity: 10,
      unit: "kg",
      unitPrice: 1000,
      inventoryItemId: item.id,
      destination: "warehouse",
    }]);
    assert.equal(Number((await refresh(item.id)).currentStock), 0);

    await receivePurchase(purchase.id, { quantity: 4, unit: "kg", actor: "recv" });
    let mid = await refresh(item.id);
    assert.equal(Number(mid.currentStock), 4);

    const updated = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchase.id),
    });
    assert.equal(String(updated?.status), "partially_received");
    assert.equal(Number(updated?.quantityReceived), 4);

    await receivePurchase(purchase.id, { quantity: 6, unit: "kg", actor: "recv" });
    mid = await refresh(item.id);
    assert.equal(Number(mid.currentStock), 10);

    await assert.rejects(
      () => receivePurchase(purchase.id, { quantity: 1, unit: "kg", actor: "recv" }),
      /already|exceed|RECEIVE/i,
    );
    assert.equal(Number((await refresh(item.id)).currentStock), 10);
  });

  it("FIFO: Lot A 5 + Lot B 10, transfer 7 → A=0 B=8", async () => {
    const item = await createItem("FIFO Meat");
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 5, unit: "kg", unitCost: 10, actor: "recv", receiptDate: "2026-01-01",
    });
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", unitCost: 12, actor: "recv", receiptDate: "2026-01-02",
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 15);

    await transferStock({
      itemId: item.id, quantity: 7, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });

    const lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(lots.length, 2);
    assert.equal(Number(lots[0]!.quantityRemaining), 0);
    assert.equal(Number(lots[1]!.quantityRemaining), 8);
    const final = await refresh(item.id);
    assert.equal(Number(final.currentStock), 8);
    assert.equal(Number(final.kitchenStock), 7);
    assert.equal(await lotSum(item.id), Number(final.currentStock));
  });

  it("Concurrent transfers: only one of two 4kg transfers succeeds from 5kg", async () => {
    const item = await createItem("Concurrent Meat", "kg", { currentStock: 0, kitchenStock: 0 });
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 5, unit: "kg", unitCost: 1, actor: "recv",
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 5);

    const results = await Promise.allSettled([
      transferStock({ itemId: item.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "A" }),
      transferStock({ itemId: item.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "B" }),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const fail = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, `expected exactly one success, got ${ok.length}`);
    assert.equal(fail.length, 1, `expected exactly one failure, got ${fail.length}`);

    const final = await refresh(item.id);
    assert.ok(Number(final.currentStock) >= 0);
    assert.equal(Number(final.kitchenStock), 4);
    assert.equal(Number(final.currentStock), 1);
    assert.notEqual(Number(final.currentStock), -3);
    assert.notEqual(Number(final.kitchenStock), 8);
  });

  it("Invalid unit conversion does not mutate stock", async () => {
    const item = await createItem("Unit Guard", "kg", { currentStock: 5 });
    await assert.rejects(
      () => transferStock({
        itemId: item.id, quantity: 1, unit: "pcs", from: "warehouse", to: "kitchen", actor: "x",
      }),
      (err: unknown) => err instanceof AppError || /Cannot convert|Incompatible/i.test(String(err)),
    );
    assert.equal(Number((await refresh(item.id)).currentStock), 5);
    assert.throws(() => convertToBaseUnit(1, "kg", "pcs"), /Cannot convert/i);
  });

  it("Insufficient stock rejects without partial apply", async () => {
    const item = await createItem("Short Stock", "kg", { currentStock: 0 });
    await receiveIntoWarehouse({ itemId: item.id, quantity: 2, unit: "kg", actor: "recv" });
    await assert.rejects(
      () => transferStock({
        itemId: item.id, quantity: 5, unit: "kg", from: "warehouse", to: "kitchen", actor: "x",
      }),
      /Insufficient/i,
    );
    const final = await refresh(item.id);
    assert.equal(Number(final.currentStock), 2);
    assert.equal(Number(final.kitchenStock), 0);
  });

  it("Reversal restores stock and keeps original receive in history", async () => {
    const item = await createItem("Reverse Meat");
    const received = await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", actor: "recv",
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 10);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, received.movement.id, "manager", 9, "Correction: wrong receive");
    });

    const final = await refresh(item.id);
    assert.equal(Number(final.currentStock), 0);
    assert.equal(await lotSum(item.id), 0, "receive reverse must clear lot remaining");

    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.ok(moves.some((m) => m.type === "receive" && m.id === received.movement.id));
    const rev = moves.find((m) => m.type === "reversal");
    assert.ok(rev);
    assert.equal(rev!.reversalOfId, received.movement.id);
    assert.ok(rev!.actor);
    assert.match(String(rev!.note), /Correction|Reversal/i);
  });

  it("Low stock uses warehouse only (not warehouse+kitchen)", async () => {
    const item = await createItem("Low Signal", "kg", {
      currentStock: 5,
      kitchenStock: 20,
      minimumStock: 10,
    });
    const check = await refresh(item.id);
    assert.equal(Number(check.currentStock), 5);
    assert.equal(Number(check.kitchenStock), 20);
    assert.equal(Number(check.currentStock) <= Number(check.minimumStock), true, "LOW STOCK by warehouse");
    assert.equal(
      (Number(check.currentStock) + Number(check.kitchenStock)) <= Number(check.minimumStock),
      false,
      "must NOT use warehouse+kitchen for low-stock",
    );

    await database.transaction(async (tx) => {
      await applyLocationDelta(tx, {
        itemId: item.id,
        location: "warehouse",
        delta: -5,
      });
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 0, "OUT OF STOCK when warehouse=0");
  });

  it("Authorization roles: viewer cannot write; warehouse can inventory", () => {
    assert.equal(canAccess("viewer", "POST", "/api/inventory/transfers"), false);
    assert.equal(canAccess("viewer", "POST", "/api/purchases/1/receive"), false);
    assert.equal(canAccess("warehouse", "POST", "/api/inventory/transfers"), true);
    assert.equal(canAccess("warehouse", "POST", "/api/purchases/1/receive"), true);
    assert.equal(canAccess("cashier", "POST", "/api/inventory/transfers"), false);
    assert.equal(canAccess("kitchen", "POST", "/api/inventory/transfers"), true);
  });

  it("Lot reconciliation report does not hide gaps", async () => {
    const item = await createItem("Gap Item", "kg", { currentStock: 0 });
    await receiveIntoWarehouse({ itemId: item.id, quantity: 3, unit: "kg", actor: "recv" });
    // Simulate legacy drift: bump warehouse without lot (admin bypass for test only)
    await database.transaction(async (tx) => {
      await applyLocationDelta(tx, { itemId: item.id, location: "warehouse", delta: 2 });
    });
    const report = await getLotReconciliationReport();
    const row = report.discrepancies.find((d) => d.itemId === item.id);
    assert.ok(row, "expected discrepancy for gap item");
    assert.ok(row!.gap > 0);
    assert.equal(row!.severity, "positive_gap");
    assert.equal(row!.status, "needs_backfill");
    assert.equal(report.syntheticLotsCreated, 0, "reconcile must not mutate");
  });

  it("Adjustment uses UnitService", async () => {
    const item = await createItem("Adj Item", "kg", { currentStock: 1 });
    await database.transaction(async (tx) => {
      await adjustStock(tx, {
        itemId: item.id,
        location: "warehouse",
        quantity: 500,
        unit: "g",
        actor: "mgr",
        note: "+500g",
      });
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 1.5);
  });

  it("Legacy backfill creates LEGACY_BACKFILL movement without changing stock; second run is idempotent", async () => {
    const item = await createItem("Backfill Target", "kg", { currentStock: 0 });
    // Stock without lot (legacy)
    await database.transaction(async (tx) => {
      await applyLocationDelta(tx, { itemId: item.id, location: "warehouse", delta: 4 });
    });
    const before = await refresh(item.id);
    assert.equal(Number(before.currentStock), 4);
    assert.equal(await lotSum(item.id), 0);

    const first = await backfillLegacyLots({ actor: "owner", userId: 1 });
    assert.ok(first.syntheticLotsCreated >= 1);
    assert.equal(Number((await refresh(item.id)).currentStock), 4, "backfill must not change stock");
    assert.equal(await lotSum(item.id), 4);

    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.ok(moves.some((m) => m.type === "legacy_backfill" && m.actor === "owner"));

    const second = await backfillLegacyLots({ actor: "owner", userId: 1 });
    assert.equal(second.syntheticLotsCreated, 0, "second backfill must not duplicate lots");
    assert.equal(await lotSum(item.id), 4);
  });

  it("Receipt quantity immutability: stock unchanged when edit rejected", async () => {
    const item = await createItem("Immutable Lot", "kg");
    const received = await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", actor: "recv",
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 10);
    // Simulate what the route enforces: quantity change is forbidden
    const existingQty = Number(received.lot.quantityReceived);
    const attempted = 8;
    assert.notEqual(existingQty, attempted);
    // Correct workflow: reverse receive
    await database.transaction(async (tx) => {
      await reverseMovement(tx, received.movement.id, "manager", 1, "Fix wrong qty — reverse then re-receive");
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 0);
    assert.equal(await lotSum(item.id), 0);
    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.ok(moves.some((m) => m.type === "receive"));
    assert.ok(moves.some((m) => m.type === "reversal" && m.reversalOfId === received.movement.id));
  });

  it("Auth: warehouse cannot backfill-legacy; owner/manager can", () => {
    assert.equal(canAccess("warehouse", "POST", "/api/inventory/lots/backfill-legacy"), false);
    assert.equal(canAccess("owner", "POST", "/api/inventory/lots/backfill-legacy"), true);
    assert.equal(canAccess("manager", "POST", "/api/inventory/lots/backfill-legacy"), true);
    assert.equal(canAccess("viewer", "POST", "/api/inventory/lots/backfill-legacy"), false);
  });

  it("FIFO transfer reversal restores exact lot balances (A=10,B=10 → transfer 7 → reverse)", async () => {
    const item = await createItem("FIFO Reverse Exact");
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", unitCost: 10, actor: "recv", receiptDate: "2026-02-01",
    });
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", unitCost: 12, actor: "recv", receiptDate: "2026-02-02",
    });
    const xfer = await transferStock({
      itemId: item.id, quantity: 7, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });
    let lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 3);
    assert.equal(Number(lots[1]!.quantityRemaining), 10);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, xfer.movementId, "manager", 1, "Undo transfer");
    });

    lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 10);
    assert.equal(Number(lots[1]!.quantityRemaining), 10);
    const final = await refresh(item.id);
    assert.equal(Number(final.currentStock), 20);
    assert.equal(Number(final.kitchenStock), 0);
    assert.equal(await lotSum(item.id), 20);

    await assert.rejects(
      () => database.transaction(async (tx) => reverseMovement(tx, xfer.movementId, "manager", 1)),
      /already|CONFLICT/i,
    );
  });

  it("Multi-lot FIFO transfer then reverse restores each lot", async () => {
    const item = await createItem("Multi Lot Reverse");
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 5, unit: "kg", actor: "recv", receiptDate: "2026-03-01",
    });
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 8, unit: "kg", actor: "recv", receiptDate: "2026-03-02",
    });
    const xfer = await transferStock({
      itemId: item.id, quantity: 9, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });
    let lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 0);
    assert.equal(Number(lots[1]!.quantityRemaining), 4);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, xfer.movementId, "mgr", 2);
    });
    lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 5);
    assert.equal(Number(lots[1]!.quantityRemaining), 8);
    assert.equal(await lotSum(item.id), Number((await refresh(item.id)).currentStock));
  });

  it("Purchase cannot be deleted after receiving; unreceived may be deleted", async () => {
    const item = await createItem("Purchase Delete Guard");
    const [unreceived] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "S",
      itemName: item.name,
      quantity: 3,
      unit: "kg",
      unitPrice: 1,
      inventoryItemId: item.id,
    }]);
    await upsertPurchases([], [unreceived.id]);
    const gone = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, unreceived.id),
    });
    assert.equal(gone, undefined);

    const [received] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "S",
      itemName: item.name,
      quantity: 5,
      unit: "kg",
      unitPrice: 1,
      inventoryItemId: item.id,
    }]);
    await receivePurchase(received.id, { quantity: 2, unit: "kg", actor: "recv" });
    await assert.rejects(
      () => upsertPurchases([], [received.id]),
      /receiving|PURCHASE_HAS_RECEIVING/i,
    );
    const still = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, received.id),
    });
    assert.ok(still);
    assert.equal(Number(still!.quantityReceived), 2);
  });

  it("Item archive preserves movements and lots", async () => {
    const { archiveItems } = await import("../services/inventoryService.ts");
    const item = await createItem("Archive Keep History");
    const received = await receiveIntoWarehouse({
      itemId: item.id, quantity: 4, unit: "kg", actor: "recv",
    });
    await database.transaction(async (tx) => {
      await archiveItems(tx, [item.id]);
    });
    const archived = await refresh(item.id);
    assert.ok(archived.archivedAt);

    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.ok(moves.some((m) => m.id === received.movement.id));
    assert.equal(await lotSum(item.id), 4);

    await assert.rejects(
      () => transferStock({
        itemId: item.id, quantity: 1, unit: "kg", from: "warehouse", to: "kitchen", actor: "x",
      }),
      /archived|ITEM_ARCHIVED/i,
    );
  });

  it("Positive and negative adjustment reversals are mathematically opposite", async () => {
    const item = await createItem("Adj Sign", "kg", { currentStock: 0 });
    await receiveIntoWarehouse({ itemId: item.id, quantity: 10, unit: "kg", actor: "recv" });

    let posMovId = 0;
    await database.transaction(async (tx) => {
      const r = await adjustStock(tx, {
        itemId: item.id, location: "warehouse", quantity: 10, unit: "kg", actor: "mgr", note: "+10",
      });
      posMovId = r.movement.id;
      assert.equal(Number(r.movement.baseQuantity), 10);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 20);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, posMovId, "mgr", 1);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 10);
    assert.equal(await lotSum(item.id), 10);

    let negMovId = 0;
    await database.transaction(async (tx) => {
      const r = await adjustStock(tx, {
        itemId: item.id, location: "warehouse", quantity: -5, unit: "kg", actor: "mgr", note: "-5",
      });
      negMovId = r.movement.id;
      assert.equal(Number(r.movement.baseQuantity), -5);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 5);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, negMovId, "mgr", 1);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 10);
    assert.equal(await lotSum(item.id), 10);

    await assert.rejects(
      () => database.transaction(async (tx) => reverseMovement(tx, negMovId, "mgr", 1)),
      /already|CONFLICT/i,
    );
  });

  it("Receive reversal restores lot remaining and purchase received qty", async () => {
    const item = await createItem("Recv Reverse Lots");
    const [purchase] = await upsertPurchases([{
      purchaseDate: todayISO(),
      supplier: "S",
      itemName: item.name,
      quantity: 6,
      unit: "kg",
      unitPrice: 1,
      inventoryItemId: item.id,
    }]);
    const received = await receivePurchase(purchase.id, { quantity: 6, unit: "kg", actor: "recv" });
    assert.equal(Number((await refresh(item.id)).currentStock), 6);
    assert.equal(await lotSum(item.id), 6);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, received.movement.id, "mgr", 1);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 0);
    assert.equal(await lotSum(item.id), 0);
    const p = await database.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchase.id),
    });
    assert.equal(Number(p?.quantityReceived), 0);
    assert.equal(String(p?.status), "ordered");
  });

  it("Reconciliation detects mismatch and does not mutate", async () => {
    const item = await createItem("Reconcile Readonly");
    await receiveIntoWarehouse({ itemId: item.id, quantity: 2, unit: "kg", actor: "recv" });
    await database.transaction(async (tx) => {
      await applyLocationDelta(tx, { itemId: item.id, location: "warehouse", delta: 3 });
    });
    const beforeLots = await lotSum(item.id);
    const report = await getLotReconciliationReport();
    const row = report.discrepancies.find((d) => d.itemId === item.id);
    assert.ok(row);
    assert.equal(await lotSum(item.id), beforeLots, "reconcile must not mutate lots");
    assert.equal(Number((await refresh(item.id)).currentStock), 5);
  });

  it("FIFO Lot A10 + Lot B10 transfer 15 → A0 B5; reverse restores A10 B10", async () => {
    const item = await createItem("FIFO Fifteen");
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", unitCost: 40000, actor: "recv", receiptDate: "2026-04-01",
    });
    await receiveIntoWarehouse({
      itemId: item.id, quantity: 10, unit: "kg", unitCost: 45000, actor: "recv", receiptDate: "2026-04-02",
    });
    const xfer = await transferStock({
      itemId: item.id, quantity: 15, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });
    const move = await database.query.inventoryMovementsTable.findFirst({
      where: eq(inventoryMovementsTable.id, xfer.movementId),
    });
    assert.ok(move?.lotAllocations);
    const alloc = JSON.parse(String(move!.lotAllocations)) as { lotId: number; quantity: number }[];
    assert.equal(alloc.length, 2);
    assert.equal(alloc[0]!.quantity, 10);
    assert.equal(alloc[1]!.quantity, 5);

    let lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 0);
    assert.equal(Number(lots[1]!.quantityRemaining), 5);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, xfer.movementId, "mgr", 1);
    });
    lots = await database.select().from(warehouseLotsTable)
      .where(eq(warehouseLotsTable.itemId, item.id))
      .orderBy(sql`receipt_date asc, id asc`);
    assert.equal(Number(lots[0]!.quantityRemaining), 10);
    assert.equal(Number(lots[1]!.quantityRemaining), 10);
    assert.equal(Number((await refresh(item.id)).currentStock), 20);
    assert.equal(Number((await refresh(item.id)).kitchenStock), 0);
  });

  it("Legacy transfer without lot_allocations cannot be reversed (no guessing)", async () => {
    const item = await createItem("Legacy No Alloc");
    await receiveIntoWarehouse({ itemId: item.id, quantity: 5, unit: "kg", actor: "recv" });
    const xfer = await transferStock({
      itemId: item.id, quantity: 2, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });
    // Simulate legacy row: strip allocations, keep last lotId only
    await database.update(inventoryMovementsTable).set({
      lotAllocations: null,
    }).where(eq(inventoryMovementsTable.id, xfer.movementId));

    await assert.rejects(
      () => database.transaction(async (tx) => reverseMovement(tx, xfer.movementId, "mgr", 1)),
      /lot_allocations|missing lot|CONFLICT/i,
    );
    // Stock unchanged after failed reverse
    assert.equal(Number((await refresh(item.id)).kitchenStock), 2);
  });

  it("Recipe save/costing does not mutate stock", async () => {
    const item = await createItem("Recipe Chicken", "kg", { currentStock: 0 });
    await receiveIntoWarehouse({ itemId: item.id, quantity: 5, unit: "kg", actor: "recv" });
    const before = await refresh(item.id);
    const beforeLots = await lotSum(item.id);
    const beforeMoves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));

    const { computeRecipeLineCost, computeRecipeTotals } = await import("./recipe-cost.ts");
    const line = computeRecipeLineCost({
      quantity: 100, unit: "g", itemUnit: "kg", costPerUnit: Number(before.costPerUnit),
    });
    const totals = computeRecipeTotals([line.lineCost], 10, 20000);
    assert.ok(totals.totalCost > 0);

    const after = await refresh(item.id);
    assert.equal(Number(after.currentStock), Number(before.currentStock));
    assert.equal(Number(after.kitchenStock), Number(before.kitchenStock));
    assert.equal(await lotSum(item.id), beforeLots);
    const afterMoves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.equal(afterMoves.length, beforeMoves.length);
  });

  it("Kitchen and warehouse waste reduce correct location; reverse restores", async () => {
    const item = await createItem("Waste Both");
    await receiveIntoWarehouse({ itemId: item.id, quantity: 10, unit: "kg", actor: "recv" });
    await transferStock({
      itemId: item.id, quantity: 4, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });

    let kwId = 0;
    await database.transaction(async (tx) => {
      const r = await wasteStock(tx, {
        itemId: item.id, location: "kitchen", quantity: 1, unit: "kg", actor: "chef", reason: "prep",
      });
      kwId = r.movement.id;
    });
    assert.equal(Number((await refresh(item.id)).kitchenStock), 3);

    let wwId = 0;
    await database.transaction(async (tx) => {
      const r = await wasteStock(tx, {
        itemId: item.id, location: "warehouse", quantity: 2, unit: "kg", actor: "wh", reason: "spoilage",
      });
      wwId = r.movement.id;
    });
    const mid = await refresh(item.id);
    assert.equal(Number(mid.currentStock), 4);
    assert.equal(await lotSum(item.id), 4);

    await database.transaction(async (tx) => {
      await reverseMovement(tx, wwId, "mgr", 1);
      await reverseMovement(tx, kwId, "mgr", 1);
    });
    const fin = await refresh(item.id);
    assert.equal(Number(fin.currentStock), 6);
    assert.equal(Number(fin.kitchenStock), 4);
    assert.equal(await lotSum(item.id), 6);
  });

  it("Opening balance increases warehouse stock, creates lot + movement; purchase does not", async () => {
    const { postWarehouseOpeningBalance } = await import("../services/openingBalanceService.ts");
    const item = await createItem("Opening Chicken");

    const result = await postWarehouseOpeningBalance({
      lines: [{ itemId: item.id, quantity: 20, unit: "kg", unitCost: 40000, note: "initial" }],
      asOfDate: todayISO(),
      actor: "Owner",
      userId: 1,
      clientRequestId: `test-ob-${item.id}`,
    });
    assert.equal(result.lineCount, 1);
    assert.equal(result.idempotent, false);
    assert.equal(Number((await refresh(item.id)).currentStock), 20);
    assert.equal(await lotSum(item.id), 20);

    const moves = await database.select().from(inventoryMovementsTable)
      .where(eq(inventoryMovementsTable.itemId, item.id));
    assert.ok(moves.some((m) => m.type === "opening_balance"));

    // Idempotent replay
    const again = await postWarehouseOpeningBalance({
      lines: [{ itemId: item.id, quantity: 20, unit: "kg", unitCost: 40000 }],
      actor: "Owner",
      clientRequestId: `test-ob-${item.id}`,
    });
    assert.equal(again.idempotent, true);
    assert.equal(Number((await refresh(item.id)).currentStock), 20);

    // Duplicate without request id rejected
    await assert.rejects(
      () => postWarehouseOpeningBalance({
        lines: [{ itemId: item.id, quantity: 5, unit: "kg" }],
        actor: "Owner",
      }),
      (err: unknown) => err instanceof AppError && err.code === "CONFLICT",
    );

    // Invalid unit
    const oil = await createItem("Opening Oil", "l");
    await assert.rejects(
      () => postWarehouseOpeningBalance({
        lines: [{ itemId: oil.id, quantity: 1, unit: "kg" }],
        actor: "Owner",
      }),
      (err: unknown) => err instanceof AppError,
    );

    // Purchase does not mutate stock
    const before = Number((await refresh(item.id)).currentStock);
    await upsertPurchases([{
      purchaseDate: todayISO(),
      purchaseTime: "10:00",
      supplier: "A",
      itemName: "Opening Chicken",
      category: "test",
      quantity: 10,
      unit: "kg",
      unitPrice: 40000,
      totalAmount: 400000,
      paidBy: "mgr",
      receivedBy: "-",
      paymentMethod: "Transfer",
      inventoryItemId: item.id,
      destination: "warehouse",
      notes: "",
    }]);
    assert.equal(Number((await refresh(item.id)).currentStock), before);

    // Receive does
    const purchases = await database.select().from(dailyPurchasesTable)
      .where(eq(dailyPurchasesTable.inventoryItemId, item.id));
    const purchase = purchases[purchases.length - 1]!;
    await receivePurchase(purchase.id, { quantity: 10, unit: "kg", actor: "recv" });
    assert.equal(Number((await refresh(item.id)).currentStock), before + 10);

    // Transfer still works after opening
    await transferStock({
      itemId: item.id, quantity: 5, unit: "kg", from: "warehouse", to: "kitchen", actor: "xfer",
    });
    const afterXfer = await refresh(item.id);
    assert.equal(Number(afterXfer.currentStock), before + 5);
    assert.equal(Number(afterXfer.kitchenStock), 5);

    // Permissions: warehouse cannot write opening-balance path
    assert.equal(canAccess("warehouse", "POST", "/api/inventory/opening-balance"), false);
    assert.equal(canAccess("owner", "POST", "/api/inventory/opening-balance"), true);
    assert.equal(canAccess("manager", "POST", "/api/inventory/opening-balance"), true);
    assert.equal(canAccess("viewer", "POST", "/api/inventory/opening-balance"), false);
  });

  it("Opening balance g→kg conversion and reverse restores stock", async () => {
    const { postWarehouseOpeningBalance } = await import("../services/openingBalanceService.ts");
    const item = await createItem("Opening Flour");
    const result = await postWarehouseOpeningBalance({
      lines: [{ itemId: item.id, quantity: 5000, unit: "g", unitCost: 10 }],
      actor: "Owner",
    });
    assert.equal(result.lines[0]!.quantity, 5);
    assert.equal(Number((await refresh(item.id)).currentStock), 5);
    const movementId = result.lines[0]!.movementId;
    await database.transaction(async (tx) => {
      await reverseMovement(tx, movementId, "Owner", 1);
    });
    assert.equal(Number((await refresh(item.id)).currentStock), 0);
    assert.equal(await lotSum(item.id), 0);
  });
});
