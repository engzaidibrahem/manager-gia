/**
 * Kitchen stock display + aggregation clarity — gia-v3-test ONLY.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const GUARD = path.resolve(ROOT, "backups/gia-v3-kitchen-qty-prod-guard.json");

describe("V3 Kitchen stock display", () => {
  let dbMod: typeof import("@workspace/db");
  let createPurchase: typeof import("../v3/purchaseService").createPurchase;
  let postOpeningBalance: typeof import("../v3/warehouseService").postOpeningBalance;
  let postWarehouseToKitchen: typeof import("../v3/warehouseService").postWarehouseToKitchen;
  let listKitchenStock: typeof import("../v3/warehouseService").listKitchenStock;
  let resolveKitchenDisplayUnit: typeof import("../v3/warehouseService").resolveKitchenDisplayUnit;

  before(async () => {
    process.chdir(ROOT);
    dbMod = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod);
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "kitchen-display" });

    const pu = await import("../v3/purchaseService");
    const wh = await import("../v3/warehouseService");
    createPurchase = pu.createPurchase;
    postOpeningBalance = wh.postOpeningBalance;
    postWarehouseToKitchen = wh.postWarehouseToKitchen;
    listKitchenStock = wh.listKitchenStock;
    resolveKitchenDisplayUnit = wh.resolveKitchenDisplayUnit;
  });

  after(async () => {
    try {
      await dbMod.closeDatabase();
    } catch {
      /* */
    }
    writeIsolationGuard(GUARD, { suite: "kitchen-display", closed: true });
  });

  it("display unit never shows polluted quantity text like 3 كيلو", () => {
    assert.equal(resolveKitchenDisplayUnit("3 كيلو", "kg"), "kg");
    assert.equal(resolveKitchenDisplayUnit("3 كيلو", null), "kg");
    assert.equal(resolveKitchenDisplayUnit("kg", "kg"), "kg");
  });

  it("KITCHEN_DIRECT 13 then +2 shows stock 15 kg once — not raw as second qty", async () => {
    const a = await createPurchase({
      itemName: "TEST CHICKEN",
      quantityNumeric: 13,
      quantityRaw: "13",
      unitRaw: "kg",
      totalAmount: 550000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "kitchen-qa",
      clientRequestId: "kit-disp-13",
    });
    assert.equal(a.destination, "KITCHEN_DIRECT");
    assert.equal(a.quantityNumeric, 13);

    let kitchen = await listKitchenStock();
    let row = kitchen.find((r) => r.id === a.inventoryItemId);
    assert.ok(row);
    assert.equal(row!.kitchenQty, 13);
    assert.equal(row!.displayUnit, "kg");
    assert.notEqual(row!.displayUnit, "13");
    assert.ok(!/\d/.test(row!.displayUnit) || row!.displayUnit === "kg");

    await createPurchase({
      itemName: "TEST CHICKEN",
      inventoryItemId: a.inventoryItemId,
      quantityNumeric: 2,
      quantityRaw: "2",
      unitRaw: "kg",
      totalAmount: 80000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "kitchen-qa",
      clientRequestId: "kit-disp-2",
    });

    kitchen = await listKitchenStock();
    row = kitchen.find((r) => r.id === a.inventoryItemId);
    assert.equal(row!.kitchenQty, 15);
    assert.equal(row!.displayUnit, "kg");
    // Must not surface last raw quantity as unit/base display confusion
    assert.notEqual(String(row!.baseUnit || ""), "2");
    assert.notEqual(row!.displayUnit, "2 kg");
  });

  it("warehouse transfer 3 + kitchen-direct 2 => kitchen 5, warehouse 17", async () => {
    const open = await postOpeningBalance({
      name: "دجاج تحويل اختبار",
      category: "test",
      baseUnit: "kg",
      quantityRaw: "20",
      quantityNumeric: 20,
      unitRaw: "kg",
      actor: "kitchen-qa",
      clientRequestId: "kit-wh-open",
    });
    const itemId = open.itemId!;

    await postWarehouseToKitchen({
      inventoryItemId: itemId,
      quantityNumeric: 3,
      quantityRaw: "3",
      unitRaw: "kg",
      actor: "kitchen-qa",
      clientRequestId: "kit-wh-out-3",
    });

    let item = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 17);
    assert.equal(Number(item!.kitchenQtyNumeric), 3);

    await createPurchase({
      itemName: "دجاج تحويل اختبار",
      inventoryItemId: itemId,
      quantityNumeric: 2,
      quantityRaw: "2",
      unitRaw: "kg",
      totalAmount: 90000,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "kitchen-qa",
      clientRequestId: "kit-wh-direct-2",
    });

    item = await dbMod.db.query.v3InventoryItemsTable.findFirst({
      where: eq(dbMod.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 17);
    assert.equal(Number(item!.kitchenQtyNumeric), 5);

    const kitchen = await listKitchenStock();
    const row = kitchen.find((r) => r.id === itemId);
    assert.equal(row!.kitchenQty, 5);
    assert.equal(row!.displayUnit, "kg");
  });

  it("polluted baseUnit marks review when mixed with clean kg", async () => {
    // Simulate historical polluted unit then clean kitchen-direct
    const open = await postOpeningBalance({
      name: "دجاج وحدة ملوثة",
      category: "test",
      baseUnit: "3 كيلو",
      quantityRaw: "0",
      quantityNumeric: 0,
      unitRaw: "3 كيلو",
      actor: "kitchen-qa",
      clientRequestId: "kit-pollute-open",
    });
    // Opening alone doesn't put kitchen stock; add transfer with polluted unit + direct kg
    // Need warehouse qty first
    const { postWarehouseIn } = await import("../v3/warehouseService");
    await postWarehouseIn({
      inventoryItemId: open.itemId!,
      quantityNumeric: 5,
      quantityRaw: "5",
      unitRaw: "3 كيلو",
      actor: "kitchen-qa",
      clientRequestId: "kit-pollute-in",
    });
    await postWarehouseToKitchen({
      inventoryItemId: open.itemId!,
      quantityNumeric: 2,
      quantityRaw: "2 فروج",
      unitRaw: "3 كيلو",
      actor: "kitchen-qa",
      clientRequestId: "kit-pollute-out",
    });
    await createPurchase({
      itemName: "دجاج وحدة ملوثة",
      inventoryItemId: open.itemId!,
      quantityNumeric: 13,
      quantityRaw: "13",
      unitRaw: "kg",
      totalAmount: 1,
      paymentStatus: "UNPAID",
      destination: "KITCHEN_DIRECT",
      actor: "kitchen-qa",
      clientRequestId: "kit-pollute-direct",
    });

    const kitchen = await listKitchenStock();
    const row = kitchen.find((r) => r.id === open.itemId);
    assert.equal(row!.kitchenQty, 15);
    assert.equal(row!.displayUnit, "kg");
    assert.equal(row!.unitNeedsReview, true);
  });
});
