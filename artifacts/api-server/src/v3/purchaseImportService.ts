/**
 * GIA_PURCHASE_IMPORT_V1 — parse/validate Excel rows and confirm batch purchases.
 * Upload/parse MUST NOT write purchases/movements/payments.
 */
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { and, eq } from "drizzle-orm";
import {
  db,
  v3PurchasesTable,
  type V3PaymentStatus,
  type V3PurchaseDestination,
} from "@workspace/db";
import { AppError } from "../lib/errors";
import { createPurchaseInTx } from "./purchaseService";
import type { DbTx } from "./warehouseService";

export const GIA_PURCHASE_IMPORT_SCHEMA = "GIA_PURCHASE_IMPORT_V1";

export const IMPORT_HEADERS = [
  "schema_version",
  "line_no",
  "purchase_date",
  "purchase_time",
  "supplier",
  "invoice_number",
  "item_name",
  "quantity_numeric",
  "quantity_raw",
  "unit_raw",
  "unit_price",
  "total_amount",
  "paid_amount",
  "payment_status",
  "notes",
  "source_image_ref",
] as const;

export type ImportHeader = (typeof IMPORT_HEADERS)[number];

export type ParsedImportRow = {
  schemaVersion: string;
  lineNo: number;
  purchaseDate: string;
  purchaseTime: string;
  supplier: string;
  invoiceNumber: string;
  itemName: string;
  quantityNumeric: number | null;
  quantityRaw: string;
  unitRaw: string;
  unitPrice: number;
  totalAmount: number;
  paidAmountHint: number | null;
  paymentStatusHint: V3PaymentStatus | null;
  notes: string;
  sourceImageRef: string;
  warnings: string[];
  priceMismatch: boolean;
  unclearQuantity: boolean;
};

export type ConfirmImportLine = {
  lineNo: number;
  purchaseDate: string;
  purchaseTime?: string;
  supplier?: string;
  invoiceNumber?: string;
  itemName: string;
  quantityNumeric?: number | null;
  quantityRaw?: string;
  unitRaw?: string;
  unitPrice?: number;
  totalAmount: number;
  notes?: string;
  sourceImageRef?: string;
  destination: V3PurchaseDestination;
  inventoryItemId?: number | null;
  newItem?: { name: string; category?: string; baseUnit?: string; minimumStock?: number | null } | null;
};

function cellStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).trim();
}

function cellNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

function roundMoney(n: number): number {
  return Math.round(n);
}

export function fingerprintBytes(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 24);
}

export function fingerprintRows(rows: Array<Record<string, unknown>>): string {
  const norm = JSON.stringify(rows);
  return createHash("sha256").update(norm).digest("hex").slice(0, 24);
}

/** Deterministic supplier key for import idempotency (no fuzzy matching). */
export function normalizeImportSupplier(supplier?: string | null): string {
  return (supplier || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildImportClientRequestId(opts: {
  supplier?: string | null;
  invoiceNumber?: string;
  fileFingerprint: string;
  lineNo: number;
}): string {
  const inv = (opts.invoiceNumber || "").trim();
  if (inv) {
    const supplier = normalizeImportSupplier(opts.supplier);
    return `${GIA_PURCHASE_IMPORT_SCHEMA}:${supplier}:${inv}:${opts.lineNo}`;
  }
  return `${GIA_PURCHASE_IMPORT_SCHEMA}:${opts.fileFingerprint}:${opts.lineNo}`;
}

/** Sequential PARTIAL allocation by line_no. Sum of paid MUST equal invoicePaid. */
export function allocateInvoicePayment(
  lines: Array<{ lineNo: number; totalAmount: number }>,
  paymentStatus: V3PaymentStatus,
  invoicePaidAmount: number,
): Map<number, number> {
  const sorted = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  const out = new Map<number, number>();
  if (paymentStatus === "UNPAID") {
    for (const l of sorted) out.set(l.lineNo, 0);
    return out;
  }
  if (paymentStatus === "PAID") {
    for (const l of sorted) out.set(l.lineNo, roundMoney(l.totalAmount));
    return out;
  }
  let remaining = roundMoney(invoicePaidAmount);
  if (!(remaining >= 0)) throw new AppError("VALIDATION_ERROR", "المبلغ المدفوع للفاتورة غير صالح");
  const invoiceTotal = roundMoney(sorted.reduce((s, l) => s + Number(l.totalAmount), 0));
  if (remaining > invoiceTotal + 1e-9) {
    throw new AppError("VALIDATION_ERROR", "المبلغ المدفوع أكبر من إجمالي الفاتورة");
  }
  for (const l of sorted) {
    const cap = roundMoney(l.totalAmount);
    const pay = Math.min(cap, remaining);
    out.set(l.lineNo, pay);
    remaining -= pay;
  }
  if (remaining !== 0) {
    throw new AppError("VALIDATION_ERROR", "تعذر توزيع الدفع الجزئي بدقة على بنود الفاتورة");
  }
  const sum = [...out.values()].reduce((a, b) => a + b, 0);
  if (sum !== roundMoney(invoicePaidAmount)) {
    throw new AppError("VALIDATION_ERROR", "مجموع الدفع الموزع لا يساوي المدفوع للفاتورة");
  }
  return out;
}

export function parseWorksheetRows(matrix: unknown[][]): ParsedImportRow[] {
  if (!matrix.length) throw new AppError("VALIDATION_ERROR", "ملف Excel فارغ");
  const headerRow = (matrix[0] || []).map((h) => cellStr(h));
  for (let i = 0; i < IMPORT_HEADERS.length; i++) {
    if (headerRow[i] !== IMPORT_HEADERS[i]) {
      throw new AppError(
        "VALIDATION_ERROR",
        `ترويسة Excel غير صحيحة عند العمود ${i + 1}: المتوقع "${IMPORT_HEADERS[i]}"`,
      );
    }
  }

  const rawRows: ParsedImportRow[] = [];
  const lineNos = new Set<number>();

  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const allEmpty = IMPORT_HEADERS.every((_, i) => cellStr(row[i]) === "" && cellNum(row[i]) == null);
    if (allEmpty) continue;

    const schemaVersion = cellStr(row[0]);
    if (schemaVersion !== GIA_PURCHASE_IMPORT_SCHEMA) {
      throw new AppError(
        "VALIDATION_ERROR",
        `schema_version يجب أن يكون ${GIA_PURCHASE_IMPORT_SCHEMA} (سطر Excel ${r + 1})`,
      );
    }

    const lineNo = cellNum(row[1]);
    if (lineNo == null || !Number.isInteger(lineNo) || lineNo < 1) {
      throw new AppError("VALIDATION_ERROR", `line_no غير صالح (سطر Excel ${r + 1})`);
    }
    if (lineNos.has(lineNo)) {
      throw new AppError("VALIDATION_ERROR", `line_no مكرر داخل الملف: ${lineNo}`);
    }
    lineNos.add(lineNo);

    const purchaseDate = cellStr(row[2]);
    if (!isValidISODate(purchaseDate)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `purchase_date يجب أن يكون YYYY-MM-DD (سطر Excel ${r + 1})`,
      );
    }

    const itemName = cellStr(row[6]);
    if (!itemName) {
      throw new AppError("VALIDATION_ERROR", `item_name مطلوب (سطر Excel ${r + 1})`);
    }

    const quantityNumeric = cellNum(row[7]);
    const quantityRaw = cellStr(row[8]);
    const unitRaw = cellStr(row[9]);
    const unitPriceRaw = cellNum(row[10]);
    const totalAmount = cellNum(row[11]);
    if (totalAmount == null || !(totalAmount >= 0) || !Number.isFinite(totalAmount)) {
      throw new AppError("VALIDATION_ERROR", `total_amount غير صالح (سطر Excel ${r + 1})`);
    }
    const unitPrice = unitPriceRaw == null ? 0 : unitPriceRaw;
    if (!(unitPrice >= 0) || !Number.isFinite(unitPrice)) {
      throw new AppError("VALIDATION_ERROR", `unit_price غير صالح (سطر Excel ${r + 1})`);
    }

    const paidHint = cellNum(row[12]);
    if (paidHint != null && (paidHint < 0 || paidHint > totalAmount + 1e-9)) {
      throw new AppError("VALIDATION_ERROR", `paid_amount خارج النطاق (سطر Excel ${r + 1})`);
    }

    const payStatusRaw = cellStr(row[13]).toUpperCase();
    let paymentStatusHint: V3PaymentStatus | null = null;
    if (payStatusRaw) {
      if (!["PAID", "UNPAID", "PARTIAL"].includes(payStatusRaw)) {
        throw new AppError("VALIDATION_ERROR", `payment_status غير صالح (سطر Excel ${r + 1})`);
      }
      paymentStatusHint = payStatusRaw as V3PaymentStatus;
    }

    const warnings: string[] = [];
    let priceMismatch = false;
    if (quantityNumeric != null && unitPriceRaw != null) {
      const expected = roundMoney(quantityNumeric * unitPrice);
      if (expected !== roundMoney(totalAmount)) {
        priceMismatch = true;
        warnings.push("مراجعة السعر مطلوبة");
      }
    }

    const unclearQuantity =
      quantityNumeric == null || !Number.isFinite(quantityNumeric) || !(quantityNumeric > 0);
    if (unclearQuantity) {
      warnings.push("كمية غير واضحة — يلزم تصحيحها قبل وجهة المستودع/المطبخ");
    }

    rawRows.push({
      schemaVersion,
      lineNo,
      purchaseDate,
      purchaseTime: cellStr(row[3]),
      supplier: cellStr(row[4]),
      invoiceNumber: cellStr(row[5]),
      itemName,
      quantityNumeric,
      quantityRaw,
      unitRaw,
      unitPrice: roundMoney(unitPrice),
      totalAmount: roundMoney(totalAmount),
      paidAmountHint: paidHint == null ? null : roundMoney(paidHint),
      paymentStatusHint,
      notes: cellStr(row[14]),
      sourceImageRef: cellStr(row[15]),
      warnings,
      priceMismatch,
      unclearQuantity,
    });
  }

  if (!rawRows.length) throw new AppError("VALIDATION_ERROR", "لا توجد صفوف بيانات في الملف");
  return rawRows.sort((a, b) => a.lineNo - b.lineNo);
}

export function parseImportWorkbook(buf: Buffer | Uint8Array): {
  rows: ParsedImportRow[];
  fileFingerprint: string;
} {
  const fileFingerprint = fingerprintBytes(buf);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new AppError("VALIDATION_ERROR", "ملف Excel لا يحتوي أوراق");
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  }) as unknown[][];
  return { rows: parseWorksheetRows(matrix), fileFingerprint };
}

export function buildImportMatrix(rows: Array<Record<ImportHeader, unknown>>): unknown[][] {
  return [Array.from(IMPORT_HEADERS), ...rows.map((r) => IMPORT_HEADERS.map((h) => r[h] ?? ""))];
}

export type InvoiceGroupPreview = {
  groupKey: string;
  purchaseDate: string;
  supplier: string;
  invoiceNumber: string;
  lineCount: number;
  invoiceTotal: number;
  paidHintSum: number;
  paymentStatusHint: V3PaymentStatus | null;
  lineNos: number[];
  existingDuplicate: boolean;
};

export async function findExistingInvoiceDuplicates(
  groups: Array<{ supplier: string; invoiceNumber: string }>,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const g of groups) {
    const inv = g.invoiceNumber.trim();
    if (!inv) continue;
    const supplier = g.supplier.trim().toLowerCase();
    const hits = await db
      .select()
      .from(v3PurchasesTable)
      .where(and(eq(v3PurchasesTable.status, "active"), eq(v3PurchasesTable.invoiceNumber, inv)));
    if (hits.some((h) => (h.supplier || "").trim().toLowerCase() === supplier)) {
      keys.add(`${supplier}::${inv}`);
    }
  }
  return keys;
}

export function groupImportRows(rows: ParsedImportRow[]): InvoiceGroupPreview[] {
  const map = new Map<string, ParsedImportRow[]>();
  for (const r of rows) {
    const key = r.invoiceNumber.trim()
      ? `inv:${r.invoiceNumber.trim()}`
      : `sup:${r.supplier.trim()}|${r.purchaseDate}`;
    const list = map.get(key) || [];
    list.push(r);
    map.set(key, list);
  }
  return [...map.entries()].map(([groupKey, list]) => {
    const invoiceTotal = list.reduce((s, x) => s + x.totalAmount, 0);
    const paidHintSum = list.reduce((s, x) => s + (x.paidAmountHint ?? 0), 0);
    const statuses = [...new Set(list.map((x) => x.paymentStatusHint).filter(Boolean))];
    return {
      groupKey,
      purchaseDate: list[0]!.purchaseDate,
      supplier: list[0]!.supplier,
      invoiceNumber: list[0]!.invoiceNumber,
      lineCount: list.length,
      invoiceTotal,
      paidHintSum,
      paymentStatusHint: (statuses.length === 1 ? statuses[0] : null) as V3PaymentStatus | null,
      lineNos: list.map((x) => x.lineNo),
      existingDuplicate: false,
    };
  });
}

export async function validateImportPayload(opts: {
  rows?: ParsedImportRow[];
  workbookBase64?: string;
  fileFingerprint?: string;
}) {
  let rows: ParsedImportRow[];
  let fileFingerprint: string;
  if (opts.workbookBase64) {
    const buf = Buffer.from(opts.workbookBase64, "base64");
    const parsed = parseImportWorkbook(buf);
    rows = parsed.rows;
    fileFingerprint = parsed.fileFingerprint;
  } else if (opts.rows?.length) {
    rows = opts.rows;
    fileFingerprint =
      opts.fileFingerprint ||
      fingerprintRows(opts.rows as unknown as Array<Record<string, unknown>>);
  } else {
    throw new AppError("VALIDATION_ERROR", "لا توجد بيانات للاستيراد");
  }

  const groups = groupImportRows(rows);
  const dupKeys = await findExistingInvoiceDuplicates(
    groups.map((g) => ({ supplier: g.supplier, invoiceNumber: g.invoiceNumber })),
  );
  for (const g of groups) {
    const k = `${g.supplier.trim().toLowerCase()}::${g.invoiceNumber.trim()}`;
    g.existingDuplicate = Boolean(g.invoiceNumber.trim() && dupKeys.has(k));
  }

  return {
    schemaVersion: GIA_PURCHASE_IMPORT_SCHEMA,
    fileFingerprint,
    rowCount: rows.length,
    rows,
    groups,
    warnings: rows.flatMap((r) => r.warnings.map((w) => ({ lineNo: r.lineNo, warning: w }))),
  };
}

export async function confirmPurchaseImport(input: {
  fileFingerprint: string;
  rows: ConfirmImportLine[];
  invoicePayments: Array<{
    groupKey: string;
    paymentStatus: V3PaymentStatus;
    paidAmount: number;
  }>;
  actor: string;
  userId?: number | null;
}) {
  const emptyFail = (msg: string, lineNo = -1) => ({
    completeSuccess: false as const,
    purchasesCreated: 0,
    purchasesIdempotent: 0,
    warehouseEntries: 0,
    kitchenEntries: 0,
    consumables: 0,
    paymentsCreated: 0,
    allocationPreview: [] as Array<{
      lineNo: number;
      totalAmount: number;
      paidAmount: number;
      paymentStatus: string;
    }>,
    lines: [] as Array<{
      lineNo: number;
      purchaseId: number;
      destination: string;
      movementId: number | null;
      inventoryItemId: number | null;
      idempotent: boolean;
      paidAmount: number;
    }>,
    failures: [{ lineNo, error: msg }],
  });

  try {
    if (!input.rows.length) throw new AppError("VALIDATION_ERROR", "لا توجد صفوف للتأكيد");
    if (!input.fileFingerprint?.trim()) {
      throw new AppError("VALIDATION_ERROR", "fileFingerprint مطلوب");
    }

    for (const r of input.rows) {
      if (!r.destination || !["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"].includes(r.destination)) {
        throw new AppError("VALIDATION_ERROR", `يجب اختيار الوجهة للسطر ${r.lineNo}`);
      }
      if (!r.itemName?.trim()) {
        throw new AppError("VALIDATION_ERROR", `اسم المادة مطلوب للسطر ${r.lineNo}`);
      }
      if (!(Number(r.totalAmount) >= 0) || !Number.isFinite(Number(r.totalAmount))) {
        throw new AppError("VALIDATION_ERROR", `إجمالي غير صالح للسطر ${r.lineNo}`);
      }
      if (
        (r.destination === "WAREHOUSE" || r.destination === "KITCHEN_DIRECT") &&
        (r.quantityNumeric == null || !(Number(r.quantityNumeric) > 0))
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          `كمية صالحة > 0 مطلوبة قبل تأكيد المستودع/المطبخ (سطر ${r.lineNo})`,
        );
      }
      if (r.destination === "WAREHOUSE") {
        const hasExisting = r.inventoryItemId != null && r.inventoryItemId > 0;
        const hasNew = Boolean(r.newItem?.name?.trim() || r.itemName.trim());
        if (!hasExisting && !hasNew) {
          throw new AppError("VALIDATION_ERROR", `اختر مادة مستودع أو أنشئ واحدة (سطر ${r.lineNo})`);
        }
      }
    }

    const asParsed: ParsedImportRow[] = input.rows.map((r) => ({
      schemaVersion: GIA_PURCHASE_IMPORT_SCHEMA,
      lineNo: r.lineNo,
      purchaseDate: r.purchaseDate,
      purchaseTime: r.purchaseTime || "",
      supplier: r.supplier || "",
      invoiceNumber: r.invoiceNumber || "",
      itemName: r.itemName,
      quantityNumeric: r.quantityNumeric ?? null,
      quantityRaw: r.quantityRaw || "",
      unitRaw: r.unitRaw || "",
      unitPrice: roundMoney(Number(r.unitPrice || 0)),
      totalAmount: roundMoney(Number(r.totalAmount)),
      paidAmountHint: null,
      paymentStatusHint: null,
      notes: r.notes || "",
      sourceImageRef: r.sourceImageRef || "",
      warnings: [],
      priceMismatch: false,
      unclearQuantity: r.quantityNumeric == null || !(Number(r.quantityNumeric) > 0),
    }));
    const groups = groupImportRows(asParsed);
    const payByGroup = new Map(input.invoicePayments.map((p) => [p.groupKey, p]));

    const paidByLine = new Map<number, number>();
    const statusByLine = new Map<number, V3PaymentStatus>();
    for (const g of groups) {
      const pay = payByGroup.get(g.groupKey);
      if (!pay) {
        throw new AppError("VALIDATION_ERROR", `قرار الدفع ناقص لمجموعة الفاتورة ${g.groupKey}`);
      }
      const lines = input.rows
        .filter((r) => g.lineNos.includes(r.lineNo))
        .map((r) => ({ lineNo: r.lineNo, totalAmount: roundMoney(Number(r.totalAmount)) }));
      const alloc = allocateInvoicePayment(
        lines,
        pay.paymentStatus,
        roundMoney(Number(pay.paidAmount)),
      );
      for (const [lineNo, amount] of alloc) {
        paidByLine.set(lineNo, amount);
        const lineTotal = lines.find((l) => l.lineNo === lineNo)?.totalAmount ?? 0;
        statusByLine.set(
          lineNo,
          amount <= 0 ? "UNPAID" : amount + 1e-9 >= lineTotal ? "PAID" : "PARTIAL",
        );
      }
    }

    const allocationPreview = input.rows.map((r) => ({
      lineNo: r.lineNo,
      totalAmount: roundMoney(Number(r.totalAmount)),
      paidAmount: paidByLine.get(r.lineNo) ?? 0,
      paymentStatus: statusByLine.get(r.lineNo) ?? "UNPAID",
    }));

    type LineOk = {
      lineNo: number;
      purchaseId: number;
      destination: string;
      movementId: number | null;
      inventoryItemId: number | null;
      idempotent: boolean;
      paidAmount: number;
    };

    try {
      const results = await db.transaction(async (tx) => {
        const out: LineOk[] = [];
        for (const r of [...input.rows].sort((a, b) => a.lineNo - b.lineNo)) {
          const clientRequestId = buildImportClientRequestId({
            supplier: r.supplier,
            invoiceNumber: r.invoiceNumber,
            fileFingerprint: input.fileFingerprint,
            lineNo: r.lineNo,
          });
          const paidAmount = paidByLine.get(r.lineNo) ?? 0;
          const paymentStatus = statusByLine.get(r.lineNo) ?? "UNPAID";
          try {
            const created = await createPurchaseInTx(tx as unknown as DbTx, {
              purchaseDate: r.purchaseDate,
              purchaseTime: r.purchaseTime || "",
              itemName: r.itemName.trim(),
              inventoryItemId: r.inventoryItemId,
              newItem:
                r.destination === "WAREHOUSE" && r.newItem?.name?.trim()
                  ? r.newItem
                  : r.destination === "WAREHOUSE" && !r.inventoryItemId
                    ? {
                        name: r.itemName.trim(),
                        baseUnit: r.unitRaw || "",
                      }
                    : null,
              quantityNumeric: r.quantityNumeric ?? null,
              quantityRaw:
                r.quantityRaw || (r.quantityNumeric != null ? String(r.quantityNumeric) : ""),
              unitRaw: r.unitRaw || "",
              unitPrice: roundMoney(Number(r.unitPrice || 0)),
              totalAmount: roundMoney(Number(r.totalAmount)),
              paidAmount,
              paymentStatus,
              supplier: r.supplier || "",
              invoiceNumber: r.invoiceNumber || null,
              destination: r.destination,
              notes:
                [r.notes || "", r.sourceImageRef ? `[source_image_ref=${r.sourceImageRef}]` : ""]
                  .filter(Boolean)
                  .join("\n") || undefined,
              actor: input.actor,
              userId: input.userId,
              clientRequestId,
            });
            out.push({
              lineNo: r.lineNo,
              purchaseId: created.purchaseId,
              destination: created.destination,
              movementId: created.movementId,
              inventoryItemId: created.inventoryItemId,
              idempotent: created.idempotent,
              paidAmount,
            });
          } catch (err) {
            const msg =
              err instanceof AppError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err);
            throw new AppError("VALIDATION_ERROR", `فشل السطر ${r.lineNo}: ${msg}`, 400);
          }
        }
        return out;
      });

      return {
        completeSuccess: true as const,
        purchasesCreated: results.filter((r) => !r.idempotent).length,
        purchasesIdempotent: results.filter((r) => r.idempotent).length,
        warehouseEntries: results.filter((r) => r.destination === "WAREHOUSE").length,
        kitchenEntries: results.filter((r) => r.destination === "KITCHEN_DIRECT").length,
        consumables: results.filter((r) => r.destination === "CONSUMABLE").length,
        paymentsCreated: results.filter((r) => r.paidAmount > 0 && !r.idempotent).length,
        allocationPreview,
        lines: results,
        failures: [] as Array<{ lineNo: number; error: string }>,
      };
    } catch (err) {
      const msg =
        err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
      const lineMatch = /فشل السطر (\d+)|سطر (\d+)/.exec(msg);
      return {
        completeSuccess: false as const,
        purchasesCreated: 0,
        purchasesIdempotent: 0,
        warehouseEntries: 0,
        kitchenEntries: 0,
        consumables: 0,
        paymentsCreated: 0,
        allocationPreview,
        lines: [] as LineOk[],
        failures: [
          {
            lineNo: lineMatch ? Number(lineMatch[1] || lineMatch[2]) : -1,
            error: msg,
          },
        ],
      };
    }
  } catch (err) {
    const msg =
      err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
    const lineMatch = /سطر (\d+)/.exec(msg);
    return emptyFail(msg, lineMatch ? Number(lineMatch[1]) : -1);
  }
}
