/**
 * Phase 9 — Product Master / QR / Stocktake / Roles / Alerts
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

describe("V3 Phase 9 warehouse control foundation", () => {
  let db: typeof import("@workspace/db").db;
  let v3InventoryItemsTable: typeof import("@workspace/db").v3InventoryItemsTable;
  let v3WarehouseMovementsTable: typeof import("@workspace/db").v3WarehouseMovementsTable;
  let closeDatabase: typeof import("@workspace/db").closeDatabase;

  let createItem: typeof import("../v3/warehouseService").createItem;
  let ensureItemQrToken: typeof import("../v3/warehouseService").ensureItemQrToken;
  let getItemByQr: typeof import("../v3/warehouseService").getItemByQr;
  let updateItemMinimum: typeof import("../v3/warehouseService").updateItemMinimum;
  let updateProduct: typeof import("../v3/warehouseService").updateProduct;
  let canonicalStockStatus: typeof import("../v3/warehouseService").canonicalStockStatus;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postWarehouseIn: typeof import("../v3/warehouseService").postWarehouseIn;
  let postWarehouseOut: typeof import("../v3/warehouseService").postWarehouseOut;
  let postWarehouseToKitchen: typeof import("../v3/warehouseService").postWarehouseToKitchen;
  let postAdjustment: typeof import("../v3/warehouseService").postAdjustment;
  let listStockAlerts: typeof import("../v3/warehouseService").listStockAlerts;
  let startStocktake: typeof import("../v3/stocktakeService").startStocktake;
  let upsertStocktakeLine: typeof import("../v3/stocktakeService").upsertStocktakeLine;
  let completeStocktake: typeof import("../v3/stocktakeService").completeStocktake;
  let addProductDuringStocktake: typeof import("../v3/stocktakeService").addProductDuringStocktake;
  let getStocktake: typeof import("../v3/stocktakeService").getStocktake;
  let getStocktakeProgress: typeof import("../v3/stocktakeService").getStocktakeProgress;
  let cancelStocktake: typeof import("../v3/stocktakeService").cancelStocktake;
  let listStocktakes: typeof import("../v3/stocktakeService").listStocktakes;
  let listProducts: typeof import("../v3/warehouseService").listProducts;
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;
  let listWarehouseSummary: typeof import("../v3/warehouseService").listWarehouseSummary;

  before(async () => {
    process.chdir(ROOT);
    const dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(path.join(ROOT, "backups/gia-v3-phase9-prod-guard.json"), {
      suite: "v3-phase9",
    });

    db = dbMod.db;
    v3InventoryItemsTable = dbMod.v3InventoryItemsTable;
    v3WarehouseMovementsTable = dbMod.v3WarehouseMovementsTable;
    closeDatabase = dbMod.closeDatabase;

    const wh = await import("../v3/warehouseService");
    createItem = wh.createItem;
    ensureItemQrToken = wh.ensureItemQrToken;
    getItemByQr = wh.getItemByQr;
    updateItemMinimum = wh.updateItemMinimum;
    updateProduct = wh.updateProduct;
    canonicalStockStatus = wh.canonicalStockStatus;
    postOpeningBalance = wh.postOpeningBalance;
    postWarehouseIn = wh.postWarehouseIn;
    postWarehouseOut = wh.postWarehouseOut;
    postWarehouseToKitchen = wh.postWarehouseToKitchen;
    postAdjustment = wh.postAdjustment;
    listStockAlerts = wh.listStockAlerts;
    listKitchenStock = wh.listKitchenStock;
    listWarehouseSummary = wh.listWarehouseSummary;
    listProducts = wh.listProducts;

    const st = await import("../v3/stocktakeService");
    startStocktake = st.startStocktake;
    upsertStocktakeLine = st.upsertStocktakeLine;
    completeStocktake = st.completeStocktake;
    addProductDuringStocktake = st.addProductDuringStocktake;
    getStocktake = st.getStocktake;
    getStocktakeProgress = st.getStocktakeProgress;
    cancelStocktake = st.cancelStocktake;
    listStocktakes = st.listStocktakes;

    createPurchase = (await import("../v3/purchaseService")).createPurchase;
  });

  after(async () => {
    await closeDatabase();
  });

  it("1-2: new product gets QR; existing gets QR without duplicate identity", async () => {
    const item = await createItem({ name: "سكر أبيض اختبار", baseUnit: "kg" });
    assert.ok(item.qrToken.trim());
    const token1 = item.qrToken;
    const again = await ensureItemQrToken(item.id);
    assert.equal(again.created, false);
    assert.equal(again.item.qrToken, token1);
  });

  it("3-4: QR lookup + reprint keeps same identity", async () => {
    const item = await createItem({ name: "طحين شاكرا اختبار", baseUnit: "kg" });
    const found = await getItemByQr(item.qrToken);
    assert.equal(found.id, item.id);
    assert.equal(found.name, item.name);
    const reprint = await ensureItemQrToken(item.id);
    assert.equal(reprint.item.qrToken, item.qrToken);
  });

  it("5-8: stock status NORMAL / LOW / OUT / NULL minimum no false LOW", async () => {
    assert.equal(canonicalStockStatus(20, 10), "NORMAL");
    assert.equal(canonicalStockStatus(8, 10), "LOW_STOCK");
    assert.equal(canonicalStockStatus(0, 10), "OUT_OF_STOCK");
    assert.equal(canonicalStockStatus(5, null), "NORMAL");
    assert.equal(canonicalStockStatus(null, 10), "REVIEW_REQUIRED");
  });

  it("9-10: permissions — staff cannot edit product / complete stocktake paths", () => {
    assert.equal(canAccess("warehouse", "PATCH", "/api/v3/products/1"), false);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/stocktakes/1/complete"), false);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/adjust"), false);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/out"), true);
    assert.equal(canAccess("warehouse", "POST", "/api/v3/warehouse/to-kitchen"), true);
    assert.equal(canAccess("owner", "POST", "/api/v3/stocktakes/1/complete"), true);
  });

  it("11-16: OUT safety, same service QR/manual, idempotency, no negative", async () => {
    const item = await createItem({ name: "زيت اختبار OUT", baseUnit: "L" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "10",
      quantityNumeric: 10,
      unitRaw: "L",
      actor: "tester",
    });

    const outQr = await postWarehouseOut({
      inventoryItemId: item.id,
      quantityRaw: "3",
      quantityNumeric: 3,
      actor: "staff",
      clientRequestId: "out-qr-1",
      sourceChannel: "MOBILE_QR",
    });
    assert.ok(outQr.movement.id);
    assert.equal(outQr.stockStatus, "NORMAL");

    const outSearch = await postWarehouseOut({
      inventoryItemId: item.id,
      quantityRaw: "2",
      quantityNumeric: 2,
      actor: "staff",
      clientRequestId: "out-search-1",
      sourceChannel: "MOBILE_SEARCH",
    });
    assert.ok(outSearch.movement.id);

    const idem = await postWarehouseOut({
      inventoryItemId: item.id,
      quantityRaw: "2",
      quantityNumeric: 2,
      actor: "staff",
      clientRequestId: "out-search-1",
      sourceChannel: "MOBILE_SEARCH",
    });
    assert.equal(idem.idempotent, true);
    assert.equal(idem.movement.id, outSearch.movement.id);

    await assert.rejects(
      () =>
        postWarehouseOut({
          inventoryItemId: item.id,
          quantityRaw: "99",
          quantityNumeric: 99,
          actor: "staff",
          clientRequestId: "out-too-much",
        }),
      /المتاح|INSUFFICIENT|أكبر/,
    );

    const [fresh] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(fresh!.warehouseQtyNumeric), 5);
    assert.ok(Number(fresh!.warehouseQtyNumeric) >= 0);
  });

  it("17-21: stocktake DRAFT no change; COMPLETE adjusts; history kept; new item QR", async () => {
    const item = await createItem({ name: "أرز بسمتي جرد", baseUnit: "kg" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "kg",
      actor: "admin",
    });

    const started = await startStocktake({
      actor: "admin",
      userId: 1,
      clientRequestId: `st-${Date.now()}`,
    });
    const sid = started.stocktake.id;
    assert.ok(sid > 0);

    const [before] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(before!.warehouseQtyNumeric), 20);

    await upsertStocktakeLine(sid, {
      inventoryItemId: item.id,
      countedQuantity: 17,
      actor: "admin",
    });

    const [mid] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(mid!.warehouseQtyNumeric), 20, "DRAFT must not alter stock");

    const added = await addProductDuringStocktake(sid, {
      name: "نشا الذرة جرد جديد",
      baseUnit: "kg",
      countedQuantity: 4,
      actor: "admin",
    });
    assert.ok(added.item.qrToken.trim());

    const preComplete = await getStocktake(sid);
    for (const line of preComplete.lines) {
      if (line.countedQuantity != null) continue;
      await upsertStocktakeLine(sid, {
        inventoryItemId: line.inventoryItemId,
        countedQuantity: line.systemQuantityBefore ?? 0,
        actor: "admin",
      });
    }
    await upsertStocktakeLine(sid, { inventoryItemId: item.id, countedQuantity: 17, actor: "admin" });
    await upsertStocktakeLine(sid, {
      inventoryItemId: added.item.id,
      countedQuantity: 4,
      actor: "admin",
    });

    const completed = await completeStocktake(sid, { actor: "admin", userId: 1, actorRole: "owner" });
    assert.ok(completed.adjustmentsCreated >= 1);

    const [after] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(after!.warehouseQtyNumeric), 17);

    const [newItem] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, added.item.id));
    assert.equal(Number(newItem!.warehouseQtyNumeric), 4);

    const hist = await db
      .select()
      .from(v3WarehouseMovementsTable)
      .where(eq(v3WarehouseMovementsTable.inventoryItemId, item.id));
    assert.ok(hist.some((m) => m.movementType === "OPENING"));
    assert.ok(hist.some((m) => m.movementType === "ADJUSTMENT"));

    const detail = await getStocktake(sid);
    assert.equal(detail.stocktake.status, "COMPLETED");
  });

  it("22-25: purchase import destinations still work (WAREHOUSE / KITCHEN / CONSUMABLE)", async () => {
    const whItem = await createItem({ name: "بهارات ماساكو شراء", baseUnit: "pcs" });
    const pWh = await createPurchase({
      itemName: "بهارات ماساكو شراء",
      inventoryItemId: whItem.id,
      quantityNumeric: 2,
      quantityRaw: "2",
      unitRaw: "pcs",
      totalAmount: 10000,
      destination: "WAREHOUSE",
      actor: "admin",
      clientRequestId: "p9-wh-1",
    });
    assert.ok(pWh.movementId);

    const pKit = await createPurchase({
      itemName: "خضار مطبخ مباشر اختبار",
      quantityNumeric: 3,
      quantityRaw: "3",
      unitRaw: "kg",
      totalAmount: 5000,
      destination: "KITCHEN_DIRECT",
      actor: "admin",
      clientRequestId: "p9-kit-1",
    });
    assert.ok(pKit.movementId);

    const pCon = await createPurchase({
      itemName: "منظف استهلاكي",
      quantityNumeric: 1,
      quantityRaw: "1",
      totalAmount: 2000,
      destination: "CONSUMABLE",
      actor: "admin",
      clientRequestId: "p9-con-1",
    });
    assert.equal(pCon.movementId, null);

    const [whFresh] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, whItem.id));
    // warehouse in without opening may set balance from WAREHOUSE_IN only
    assert.ok(Number(whFresh!.warehouseQtyNumeric) >= 2);

    const kitchen = await listKitchenStock();
    assert.ok(kitchen.some((k) => String(k.name).includes("خضار مطبخ")));
  });

  it("26-28: low-stock after movement + audit fields + admin can adjust", async () => {
    const item = await createItem({ name: "أكياس نفايات 60", baseUnit: "pcs" });
    await updateItemMinimum(item.id, 10);
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "15",
      quantityNumeric: 15,
      actor: "admin",
    });
    const out = await postWarehouseOut({
      inventoryItemId: item.id,
      quantityRaw: "7",
      quantityNumeric: 7,
      actor: "Ahmad",
      actorRole: "warehouse",
      sourceChannel: "MOBILE_QR",
      clientRequestId: "alert-out-1",
      notes: "إخراج عبر QR",
    });
    assert.equal(out.stockStatus, "LOW_STOCK");
    assert.equal(out.movement.sourceChannel, "MOBILE_QR");
    assert.equal(out.movement.actorRole, "warehouse");
    assert.ok(out.movement.qtyBefore != null);
    assert.ok(out.movement.qtyAfter != null);

    const alerts = await listStockAlerts();
    assert.ok(alerts.lowStock.some((r) => r.id === item.id) || alerts.outOfStock.some((r) => r.id === item.id));

    const adj = await postAdjustment({
      inventoryItemId: item.id,
      quantityNumeric: 1,
      notes: "تصحيح يدوي",
      actor: "admin",
      actorRole: "owner",
      sourceChannel: "WEB_ADMIN",
      clientRequestId: "adj-1",
    });
    assert.ok(adj.movement.id);
  });

  it("29: production/test isolation guard file written", () => {
    const guard = path.join(ROOT, "backups/gia-v3-phase9-prod-guard.json");
    assert.ok(fs.existsSync(guard));
    const raw = JSON.parse(fs.readFileSync(guard, "utf8"));
    assert.match(String(raw.databaseUrl || ""), /gia-v3-test/);
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
  });

  it("warehouse summary still lists items after phase9", async () => {
    const summary = await listWarehouseSummary({ page: 1, pageSize: 50 });
    assert.ok(summary.total >= 1);
  });

  it("product search: partial Arabic match by inventory_item_id", async () => {
    const item = await createItem({ name: "سكر أبيض بحث", baseUnit: "kg" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "12",
      quantityNumeric: 12,
      actor: "admin",
    });
    const hits = await listProducts({ q: "سكر", warehouseOnly: true, active: "active" });
    assert.ok(hits.rows.some((r) => r.id === item.id));
    assert.ok(hits.rows.every((r) => typeof r.id === "number"));
  });

  it("stocktake progress counts + blocks complete when NOT_COUNTED remain", async () => {
    const open = await listStocktakes({ status: "IN_PROGRESS" });
    for (const row of open.rows) {
      if (row.status === "DRAFT" || row.status === "IN_PROGRESS") {
        await cancelStocktake(row.id, { actor: "admin", reason: "test cleanup" });
      }
    }

    const a = await createItem({ name: "جرد تقدم أ", baseUnit: "kg" });
    const b = await createItem({ name: "جرد تقدم ب", baseUnit: "kg" });
    await postOpeningBalance({ inventoryItemId: a.id, quantityRaw: "5", quantityNumeric: 5, actor: "admin" });
    await postOpeningBalance({ inventoryItemId: b.id, quantityRaw: "8", quantityNumeric: 8, actor: "admin" });

    const started = await startStocktake({
      actor: "admin",
      clientRequestId: `st-progress-${Date.now()}`,
    });
    const sid = started.stocktake.id;

    await upsertStocktakeLine(sid, { inventoryItemId: a.id, countedQuantity: 5, actor: "admin" });

    const progress = await getStocktakeProgress(sid);
    assert.ok(progress.totalProducts >= 2);
    assert.equal(progress.countedProducts >= 1, true);
    assert.ok(progress.remainingProducts >= 1);
    assert.equal(progress.canComplete, false);
    assert.ok(progress.lines.some((l) => l.countStatus === "NOT_COUNTED"));

    await assert.rejects(
      () => completeStocktake(sid, { actor: "admin", actorRole: "owner" }),
      /لم يُجرَد|NOT|اعتماد/,
    );

    const detail = await getStocktake(sid);
    for (const line of detail.lines) {
      if (line.isActive && line.countedQuantity == null) {
        await upsertStocktakeLine(sid, {
          inventoryItemId: line.inventoryItemId,
          countedQuantity: line.systemQuantityBefore ?? 0,
          actor: "admin",
        });
      }
    }
    const progress2 = await getStocktakeProgress(sid);
    assert.equal(progress2.canComplete, true);
  });

  it("concurrent OUT: only one succeeds when stock insufficient for both", async () => {
    const item = await createItem({ name: "تزامن OUT", baseUnit: "kg" });
    await postOpeningBalance({
      inventoryItemId: item.id,
      quantityRaw: "5",
      quantityNumeric: 5,
      actor: "admin",
    });

    const results = await Promise.allSettled([
      postWarehouseOut({
        inventoryItemId: item.id,
        quantityRaw: "5",
        quantityNumeric: 5,
        actor: "A",
        clientRequestId: `conc-a-${Date.now()}`,
        sourceChannel: "MOBILE_QR",
      }),
      postWarehouseOut({
        inventoryItemId: item.id,
        quantityRaw: "5",
        quantityNumeric: 5,
        actor: "B",
        clientRequestId: `conc-b-${Date.now()}`,
        sourceChannel: "MOBILE_SEARCH",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);

    const [fresh] = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.id, item.id));
    assert.equal(Number(fresh!.warehouseQtyNumeric), 0);
  });
});
