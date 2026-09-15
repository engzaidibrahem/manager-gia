/**
 * Phase 10 — Mobile PWA readiness (roles, product by id, stocktake meta, mine movements)
 * MUST use gia-v3-test only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { canAccess } from "../auth/roles";
import { openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");

describe("V3 Phase 10 mobile PWA readiness", () => {
  let db: typeof import("@workspace/db").db;
  let v3InventoryItemsTable: typeof import("@workspace/db").v3InventoryItemsTable;
  let closeDatabase: typeof import("@workspace/db").closeDatabase;

  let createItem: typeof import("../v3/warehouseService").createItem;
  let getProduct: typeof import("../v3/warehouseService").getProduct;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postWarehouseOut: typeof import("../v3/warehouseService").postWarehouseOut;
  let listMovements: typeof import("../v3/warehouseService").listMovements;
  let startStocktake: typeof import("../v3/stocktakeService").startStocktake;
  let upsertStocktakeLine: typeof import("../v3/stocktakeService").upsertStocktakeLine;
  let getStocktakeProgress: typeof import("../v3/stocktakeService").getStocktakeProgress;
  let cancelStocktake: typeof import("../v3/stocktakeService").cancelStocktake;
  let listStocktakes: typeof import("../v3/stocktakeService").listStocktakes;
  let listProducts: typeof import("../v3/warehouseService").listProducts;

  before(async () => {
    process.chdir(ROOT);
    const dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(path.join(ROOT, "backups/gia-v3-phase10-prod-guard.json"), {
      suite: "v3-phase10",
    });

    db = dbMod.db;
    v3InventoryItemsTable = dbMod.v3InventoryItemsTable;
    closeDatabase = dbMod.closeDatabase;

    const wh = await import("../v3/warehouseService");
    createItem = wh.createItem;
    getProduct = wh.getProduct;
    postOpeningBalance = wh.postOpeningBalance;
    postWarehouseOut = wh.postWarehouseOut;
    listMovements = wh.listMovements;
    listProducts = wh.listProducts;

    const st = await import("../v3/stocktakeService");
    startStocktake = st.startStocktake;
    upsertStocktakeLine = st.upsertStocktakeLine;
    getStocktakeProgress = st.getStocktakeProgress;
    cancelStocktake = st.cancelStocktake;
    listStocktakes = st.listStocktakes;
  });

  after(async () => {
    await closeDatabase();
  });

  it("mobile roles: staff out/kitchen allowed; stocktake/products denied", () => {
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/out"), true);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/to-kitchen"), true);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/in"), false);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/stocktakes"), false);
    assert.equal(canAccess("warehouse", "PATCH", "/api/v3/products/1"), false);
    assert.equal(canAccess("owner", "POST", "/api/v3/stocktakes"), true);
  });

  it("getProduct + Arabic search for mobile", async () => {
    const item = await createItem({ name: "سكر موبايل اختبار", baseUnit: "kg", minimumStock: 3 });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "10",
      quantityNumeric: 10,
      actor: "admin",
    });
    const p = await getProduct(item.id);
    assert.equal(p.id, item.id);
    assert.ok(p.qrToken.trim());
    assert.equal(p.stockStatus, "NORMAL");
    const hits = await listProducts({ q: "سكر", warehouseOnly: true, active: "active" });
    assert.ok(hits.rows.some((r) => r.id === item.id));
  });

  it("stocktake line can update minimum + unit without changing qty", async () => {
    for (const row of (await listStocktakes()).rows) {
      if (row.status === "DRAFT" || row.status === "IN_PROGRESS") {
        await cancelStocktake(row.id, { actor: "admin", reason: "cleanup" });
      }
    }
    const item = await createItem({ name: "دقيق جرد موبايل", baseUnit: "kg" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "20",
      quantityNumeric: 20,
      actor: "admin",
    });
    const started = await startStocktake({ actor: "admin", clientRequestId: `p10-${Date.now()}` });
    const sid = started.stocktake.id;
    await upsertStocktakeLine(sid, {
      inventoryItemId: item.id,
      countedQuantity: 18,
      minimumStock: 5,
      baseUnit: "kg",
      actor: "admin",
    });
    const [fresh] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(fresh!.warehouseQtyNumeric), 20, "qty unchanged until complete");
    assert.equal(Number(fresh!.minimumStock), 5);
    assert.equal(fresh!.baseUnit, "kg");

    const progress = await getStocktakeProgress(sid);
    assert.ok(progress.countedProducts >= 1);
    assert.equal(typeof progress.remainingProducts, "number");
  });

  it("mine movements filter by userId", async () => {
    const item = await createItem({ name: "زيت حركاتي", baseUnit: "L" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "6",
      quantityNumeric: 6,
      actor: "admin",
    });
    await postWarehouseOut({
      inventoryItemId: item.id,
      quantityRaw: "1",
      quantityNumeric: 1,
      actor: "StaffA",
      userId: 42,
      clientRequestId: `mine-${Date.now()}`,
      sourceChannel: "MOBILE_SEARCH",
    });
    const mine = await listMovements({ userId: 42, pageSize: 20 });
    assert.ok(mine.rows.some((r) => Number(r.userId) === 42));
  });

  it("isolation guard for phase10", () => {
    const guard = path.join(ROOT, "backups/gia-v3-phase10-prod-guard.json");
    assert.ok(fs.existsSync(guard));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
  });
});
