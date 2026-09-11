/**
 * GIA_PURCHASE_IMPORT_V1 regression tests — TEST DB ONLY.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDatabaseRuntimeInfo } from "@workspace/db";
import { openFreshV3TestDatabase, writeIsolationGuard } from "./v3-test-harness";
import {
  allocateInvoicePayment,
  buildImportMatrix,
  confirmPurchaseImport,
  GIA_PURCHASE_IMPORT_SCHEMA,
  IMPORT_HEADERS,
  parseImportWorkbook,
  parseWorksheetRows,
  type ImportHeader,
} from "../v3/purchaseImportService";
import { listWarehouseSummary, listKitchenStock, postOpeningBalance } from "../v3/warehouseService";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const PROD_DIR = path.resolve(ROOT, ".data/gia-v3");
const GUARD = path.resolve(ROOT, "backups/gia-v3-purchase-import-prod-guard.json");

function row(
  overrides: Partial<Record<ImportHeader, unknown>> & { line_no: number; item_name: string; total_amount: number },
): Record<ImportHeader, unknown> {
  const base: Record<ImportHeader, unknown> = {
    schema_version: GIA_PURCHASE_IMPORT_SCHEMA,
    line_no: overrides.line_no,
    purchase_date: "2026-09-10",
    purchase_time: "",
    supplier: "Supplier Test",
    invoice_number: "INV-TEST-1",
    item_name: overrides.item_name,
    quantity_numeric: 1,
    quantity_raw: "1",
    unit_raw: "kg",
    unit_price: overrides.total_amount,
    total_amount: overrides.total_amount,
    paid_amount: "",
    payment_status: "",
    notes: "",
    source_image_ref: "img.jpg",
  };
  return { ...base, ...overrides };
}

function workbookFromRows(rows: Array<Record<ImportHeader, unknown>>): Buffer {
  const matrix = buildImportMatrix(rows);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(wb, ws, "import");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("V3 GIA_PURCHASE_IMPORT_V1", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let closeDatabase: typeof import("@workspace/db").closeDatabase;

  before(async () => {
    process.chdir(ROOT);
    const dbMod0 = await import("@workspace/db");
    await openFreshV3TestDatabase(dbMod0);
    assert.ok(fs.existsSync(TEST_DIR));
    assert.notEqual(path.resolve(TEST_DIR), path.resolve(PROD_DIR));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    writeIsolationGuard(GUARD, { suite: "purchase-import" });
    db = dbMod0.db;
    tables = dbMod0;
    closeDatabase = dbMod0.closeDatabase;
  });

  after(async () => {
    await closeDatabase();
    writeIsolationGuard(GUARD, { suite: "purchase-import", closed: true });
  });

  it("1) valid 100-line Excel parse", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({
        line_no: i + 1,
        item_name: `مادة ${i + 1}`,
        total_amount: 1000 * (i + 1),
        quantity_numeric: i + 1,
        unit_price: 1000,
      }),
    );
    // fix price match for each
    for (const r of rows) {
      r.unit_price = 1000;
      r.quantity_numeric = Number(r.line_no);
      r.total_amount = 1000 * Number(r.line_no);
    }
    const buf = workbookFromRows(rows);
    const parsed = parseImportWorkbook(buf);
    assert.equal(parsed.rows.length, 100);
    assert.ok(parsed.fileFingerprint.length >= 8);
  });

  it("2) invalid schema version rejected", () => {
    assert.throws(() => {
      parseWorksheetRows([
        Array.from(IMPORT_HEADERS),
        [
          "WRONG_SCHEMA",
          1,
          "2026-09-10",
          "",
          "S",
          "I",
          "Item",
          1,
          "1",
          "kg",
          10,
          10,
          "",
          "",
          "",
          "",
        ],
      ]);
    }, /schema_version/);
  });

  it("3) duplicate line_no rejected", () => {
    assert.throws(() => {
      parseWorksheetRows(
        buildImportMatrix([
          row({ line_no: 1, item_name: "A", total_amount: 10 }),
          row({ line_no: 1, item_name: "B", total_amount: 20 }),
        ]),
      );
    }, /مكرر/);
  });

  it("4) invalid date rejected", () => {
    assert.throws(() => {
      parseWorksheetRows(
        buildImportMatrix([row({ line_no: 1, item_name: "A", total_amount: 10, purchase_date: "10/09/2026" })]),
      );
    }, /YYYY-MM-DD/);
  });

  it("5) missing item name rejected", () => {
    assert.throws(() => {
      parseWorksheetRows(buildImportMatrix([row({ line_no: 1, item_name: "   ", total_amount: 10 })]));
    }, /item_name/);
  });

  it("6) price mismatch flagged, not auto-fixed", () => {
    const parsed = parseWorksheetRows(
      buildImportMatrix([
        row({
          line_no: 1,
          item_name: "Mismatch",
          quantity_numeric: 2,
          unit_price: 1000,
          total_amount: 2500,
        }),
      ]),
    );
    assert.equal(parsed[0]!.priceMismatch, true);
    assert.ok(parsed[0]!.warnings.includes("مراجعة السعر مطلوبة"));
    assert.equal(parsed[0]!.totalAmount, 2500);
    assert.equal(parsed[0]!.unitPrice, 1000);
  });

  it("7) unclear quantity can preview but cannot confirm to warehouse", async () => {
    const parsed = parseWorksheetRows(
      buildImportMatrix([
        row({
          line_no: 1,
          item_name: "Unclear Qty",
          quantity_numeric: "",
          quantity_raw: "بضع كيلو",
          unit_price: 0,
          total_amount: 5000,
          invoice_number: "INV-QTY",
        }),
      ]),
    );
    assert.equal(parsed[0]!.unclearQuantity, true);
    const fp = "fp-unclear-qty";
    const res = await confirmPurchaseImport({
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: "inv:INV-QTY", paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          itemName: "Unclear Qty",
          quantityNumeric: null,
          quantityRaw: "بضع كيلو",
          totalAmount: 5000,
          invoiceNumber: "INV-QTY",
          destination: "WAREHOUSE",
          newItem: { name: "Unclear Qty", baseUnit: "kg" },
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, false);
  });

  it("8) warehouse import changes warehouse only", async () => {
    const inv = `INV-WH-${Date.now()}`;
    const fp = `fp-wh-${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "S",
          invoiceNumber: inv,
          itemName: `WH Item ${Date.now()}`,
          quantityNumeric: 4,
          unitRaw: "kg",
          unitPrice: 1000,
          totalAmount: 4000,
          destination: "WAREHOUSE",
          newItem: { name: `WH Item ${Date.now()}`, baseUnit: "kg" },
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    assert.equal(res.warehouseEntries, 1);
    const itemId = Number(res.lines[0]!.inventoryItemId);
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 4);
    assert.equal(Number(item!.kitchenQtyNumeric ?? 0), 0);
  });

  it("9) kitchen import changes kitchen only", async () => {
    const name = `Kit Import ${Date.now()}`;
    const inv = `INV-KIT-${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: `fp-kit-${Date.now()}`,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "S",
          invoiceNumber: inv,
          itemName: name,
          quantityNumeric: 6,
          unitRaw: "kg",
          totalAmount: 6000,
          destination: "KITCHEN_DIRECT",
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    assert.equal(res.kitchenEntries, 1);
    const itemId = Number(res.lines[0]!.inventoryItemId);
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, itemId),
    });
    assert.equal(item!.warehouseQtyNumeric, null);
    assert.equal(Number(item!.kitchenQtyNumeric), 6);
    const wh = await listWarehouseSummary({ q: name, page: 1, pageSize: 50 });
    assert.equal(wh.rows.filter((r) => r.id === itemId).length, 0);
    const kit = await listKitchenStock();
    assert.ok(kit.some((r) => r.name === name && r.kitchenQty === 6));
  });

  it("10) consumable changes neither stock", async () => {
    const beforeItems = (await db.select().from(tables.v3InventoryItemsTable)).length;
    const beforeMoves = (await db.select().from(tables.v3WarehouseMovementsTable)).length;
    const inv = `INV-CON-${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: `fp-con-${Date.now()}`,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          itemName: "منظف",
          totalAmount: 20000,
          destination: "CONSUMABLE",
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    assert.equal(res.consumables, 1);
    assert.equal((await db.select().from(tables.v3InventoryItemsTable)).length, beforeItems);
    assert.equal((await db.select().from(tables.v3WarehouseMovementsTable)).length, beforeMoves);
  });

  it("11) existing warehouse item matching", async () => {
    const name = `Match WH ${Date.now()}`;
    const open = await postOpeningBalance({
      name,
      category: "test",
      baseUnit: "kg",
      quantityRaw: "10",
      quantityNumeric: 10,
      unitRaw: "kg",
      actor: "test",
      clientRequestId: `imp-open-${Date.now()}`,
    });
    const inv = `INV-MATCH-${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: `fp-match-${Date.now()}`,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          itemName: name,
          quantityNumeric: 3,
          unitRaw: "kg",
          totalAmount: 3000,
          destination: "WAREHOUSE",
          inventoryItemId: open.itemId!,
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    assert.equal(res.lines[0]!.inventoryItemId, open.itemId);
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, open.itemId!),
    });
    assert.equal(Number(item!.warehouseQtyNumeric), 13);
  });

  it("12) new warehouse item creation", async () => {
    const name = `Brand New WH ${Date.now()}`;
    const inv = `INV-NEW-${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: `fp-new-${Date.now()}`,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          itemName: name,
          quantityNumeric: 2,
          unitRaw: "L",
          totalAmount: 2000,
          destination: "WAREHOUSE",
          newItem: { name, category: "test", baseUnit: "L" },
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(tables.v3InventoryItemsTable.id, res.lines[0]!.inventoryItemId!),
    });
    assert.equal(item!.name, name);
    assert.equal(Number(item!.warehouseQtyNumeric), 2);
  });

  it("13-15) PAID / UNPAID / PARTIAL allocation", () => {
    const lines = [
      { lineNo: 1, totalAmount: 100 },
      { lineNo: 2, totalAmount: 200 },
      { lineNo: 3, totalAmount: 300 },
    ];
    const unpaid = allocateInvoicePayment(lines, "UNPAID", 0);
    assert.deepEqual([...unpaid.values()], [0, 0, 0]);
    const paid = allocateInvoicePayment(lines, "PAID", 600);
    assert.deepEqual([...paid.values()], [100, 200, 300]);
    const partial = allocateInvoicePayment(lines, "PARTIAL", 250);
    assert.equal(partial.get(1), 100);
    assert.equal(partial.get(2), 150);
    assert.equal(partial.get(3), 0);
    assert.equal([...partial.values()].reduce((a, b) => a + b, 0), 250);
  });

  it("16) repeated confirm cannot duplicate data", async () => {
    const name = `Idem ${Date.now()}`;
    const inv = `INV-IDEM-${Date.now()}`;
    const fp = `fp-idem-${Date.now()}`;
    const payload = {
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID" as const, paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "Supplier Idem",
          invoiceNumber: inv,
          itemName: name,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 1000,
          destination: "WAREHOUSE" as const,
          newItem: { name, baseUnit: "kg" },
        },
      ],
      actor: "test",
    };
    const first = await confirmPurchaseImport(payload);
    assert.equal(first.completeSuccess, true);
    assert.equal(first.purchasesCreated, 1);
    const second = await confirmPurchaseImport(payload);
    assert.equal(second.completeSuccess, true);
    assert.equal(second.purchasesIdempotent, 1);
    const purchases = await db
      .select()
      .from(tables.v3PurchasesTable)
      .where(eq(tables.v3PurchasesTable.invoiceNumber, inv));
    assert.equal(purchases.length, 1);
  });

  it("16a) same supplier + invoice + line_no is idempotent", async () => {
    const inv = `INV-SAME-SUP-${Date.now()}`;
    const fp = `fp-same-sup-${Date.now()}`;
    const name = `Same Sup ${Date.now()}`;
    const payload = {
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID" as const, paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "  Acme   Foods  ",
          invoiceNumber: inv,
          itemName: name,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 1000,
          destination: "WAREHOUSE" as const,
          newItem: { name, baseUnit: "kg" },
        },
      ],
      actor: "test",
    };
    const first = await confirmPurchaseImport(payload);
    assert.equal(first.completeSuccess, true);
    // whitespace/case-normalized supplier must still collide
    const second = await confirmPurchaseImport({
      ...payload,
      rows: [{ ...payload.rows[0]!, supplier: "acme foods" }],
    });
    assert.equal(second.completeSuccess, true);
    assert.equal(second.purchasesIdempotent, 1);
    const purchases = await db
      .select()
      .from(tables.v3PurchasesTable)
      .where(eq(tables.v3PurchasesTable.invoiceNumber, inv));
    assert.equal(purchases.length, 1);
  });

  it("16b) different supplier + same invoice + line_no creates separate purchases", async () => {
    const inv = `INV-DIFF-SUP-${Date.now()}`;
    const fp = `fp-diff-sup-${Date.now()}`;
    const nameA = `Diff Sup A ${Date.now()}`;
    const nameB = `Diff Sup B ${Date.now()}`;
    const base = {
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID" as const, paidAmount: 0 }],
      actor: "test",
    };
    const a = await confirmPurchaseImport({
      ...base,
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "Supplier Alpha",
          invoiceNumber: inv,
          itemName: nameA,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 1000,
          destination: "WAREHOUSE",
          newItem: { name: nameA, baseUnit: "kg" },
        },
      ],
    });
    const b = await confirmPurchaseImport({
      ...base,
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "Supplier Beta",
          invoiceNumber: inv,
          itemName: nameB,
          quantityNumeric: 2,
          unitRaw: "kg",
          totalAmount: 2000,
          destination: "WAREHOUSE",
          newItem: { name: nameB, baseUnit: "kg" },
        },
      ],
    });
    assert.equal(a.completeSuccess, true);
    assert.equal(b.completeSuccess, true);
    assert.equal(a.purchasesCreated, 1);
    assert.equal(b.purchasesCreated, 1);
    assert.equal(b.purchasesIdempotent, 0);
    const purchases = await db
      .select()
      .from(tables.v3PurchasesTable)
      .where(eq(tables.v3PurchasesTable.invoiceNumber, inv));
    assert.equal(purchases.length, 2);
  });

  it("16c) missing invoice_number uses fileFingerprint fallback", async () => {
    const fp = `fp-no-inv-${Date.now()}`;
    const name = `No Inv ${Date.now()}`;
    const groupKey = `sup:NoInvSupplier|2026-09-10`;
    const payload = {
      fileFingerprint: fp,
      invoicePayments: [{ groupKey, paymentStatus: "UNPAID" as const, paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          supplier: "NoInvSupplier",
          invoiceNumber: "",
          itemName: name,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 1000,
          destination: "WAREHOUSE" as const,
          newItem: { name, baseUnit: "kg" },
        },
      ],
      actor: "test",
    };
    const first = await confirmPurchaseImport(payload);
    assert.equal(first.completeSuccess, true);
    assert.equal(first.purchasesCreated, 1);
    const second = await confirmPurchaseImport(payload);
    assert.equal(second.completeSuccess, true);
    assert.equal(second.purchasesIdempotent, 1);
    assert.equal(second.lines[0]!.purchaseId, first.lines[0]!.purchaseId);
  });

  it("17) mixed-destination invoice", async () => {
    const inv = `INV-MIX-${Date.now()}`;
    const fp = `fp-mix-${Date.now()}`;
    const whName = `Mix WH ${Date.now()}`;
    const kitName = `Mix Kit ${Date.now()}`;
    const res = await confirmPurchaseImport({
      fileFingerprint: fp,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "PAID", paidAmount: 9000 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          supplier: "MixSup",
          itemName: whName,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 3000,
          destination: "WAREHOUSE",
          newItem: { name: whName, baseUnit: "kg" },
        },
        {
          lineNo: 2,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          supplier: "MixSup",
          itemName: kitName,
          quantityNumeric: 2,
          unitRaw: "kg",
          totalAmount: 4000,
          destination: "KITCHEN_DIRECT",
        },
        {
          lineNo: 3,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          supplier: "MixSup",
          itemName: "غاز",
          totalAmount: 2000,
          destination: "CONSUMABLE",
        },
      ],
      actor: "test",
    });
    assert.equal(res.completeSuccess, true);
    assert.equal(res.warehouseEntries, 1);
    assert.equal(res.kitchenEntries, 1);
    assert.equal(res.consumables, 1);
    assert.equal(res.paymentsCreated, 3);
  });

  it("18) failed row does not produce false complete success", async () => {
    const inv = `INV-FAIL-${Date.now()}`;
    const before = (await db.select().from(tables.v3PurchasesTable)).length;
    const res = await confirmPurchaseImport({
      fileFingerprint: `fp-fail-${Date.now()}`,
      invoicePayments: [{ groupKey: `inv:${inv}`, paymentStatus: "UNPAID", paidAmount: 0 }],
      rows: [
        {
          lineNo: 1,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          itemName: `Ok Before Fail ${Date.now()}`,
          quantityNumeric: 1,
          unitRaw: "kg",
          totalAmount: 1000,
          destination: "WAREHOUSE",
          newItem: { name: `Ok Before Fail ${Date.now()}`, baseUnit: "kg" },
        },
        {
          lineNo: 2,
          purchaseDate: "2026-09-10",
          invoiceNumber: inv,
          itemName: "Bad Qty",
          quantityNumeric: null,
          totalAmount: 1000,
          destination: "WAREHOUSE",
          newItem: { name: "Bad Qty", baseUnit: "kg" },
        },
      ],
      actor: "test",
    });
    // Pre-validation throws before transaction for unclear qty — or completeSuccess false
    assert.equal(res.completeSuccess, false);
    assert.equal((await db.select().from(tables.v3PurchasesTable)).length, before);
  });
});
