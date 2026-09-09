/**
 * GIA initial data import V2 — sensitive warehouse snapshot.
 * Batch: gia-initial-import-v2-2026-09-09
 *
 * Flow: optional --dry-run | --apply
 *   1) Counts / warnings (always)
 *   2) On --apply: DELETE operational rows (no DROP), then import transactionally
 *   3) Reconcile against GIA_WAREHOUSE_RECONCILIATION.csv
 *
 * Does NOT invent unit conversions, payments, or name merges (except أ/إ/آ ↔ ا linkage).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import {
  closeDatabase,
  dailyArchivesTable,
  dailyPurchasesTable,
  db,
  initDatabase,
  inventoryItemsTable,
  inventoryMovementsTable,
  purchasePaymentsTable,
  recipeLinesTable,
  warehouseDayArchivesTable,
  warehouseLotsTable,
  wasteRecordsTable,
} from "@workspace/db";
import { receiveIntoWarehouse } from "../services/receivingService";
import { transferStock } from "../services/transferService";
import { postWarehouseOpeningBalance } from "../services/openingBalanceService";

const require = createRequire(import.meta.url);
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx/xlsx.js");

const BATCH_KEY = "gia-initial-import-v2-2026-09-09";
const ACTOR = "استيراد جرد Gia V2";
const OPENING_DATE = "2026-08-26";
const EXCEL = "d:/gia-files/جرد_المستودع_النهائي_بنظام_النقل_للمطبخ.xlsx";
const CSV = "d:/gia-files/GIA_WAREHOUSE_RECONCILIATION.csv";
const EXPECTED_EXCEL_SHA =
  "19f13e4d443f8e82576f4146fc70324756cdb3786cf1f522d86bc42ad5420822";
const EXPECTED_CSV_SHA =
  "3730a942efbfab669320462b7c59373c860d7f28ed338d4de3c93caa3e660d74";

type CsvRec = {
  row: number;
  category: string;
  item: string;
  unit: string;
  opening: number;
  totalIn: number;
  lastOut: string;
  after: number;
  expected: number;
  rule: string;
};

type WhItem = {
  sheetRow: number;
  category: string;
  name: string;
  unit: string;
  openingText: string;
  opening: number;
  current: number;
  lastOut: string;
  totalIn: number;
  after: number;
  rule: string;
  min: number;
};

type InRow = {
  idx: number;
  date: string;
  nameRaw: string;
  nameKey: string;
  qtyRaw: unknown;
  unitRaw: string;
  actor: string;
  note: string;
  digital: number;
  supplier: string;
  unitPrice: number | null;
  gross: number | null;
  discount: number | null;
  net: number | null;
  origName: string;
  source: string;
  invoiceNote: string;
};

type OutRow = {
  idx: number;
  date: string;
  nameRaw: string;
  nameKey: string;
  qtyRaw: unknown;
  unitRaw: string;
  actor: string;
  note: string;
  digital: number;
};

type InvRow = {
  idx: number;
  date: string;
  store: string;
  productAr: string;
  nameKey: string;
  origName: string;
  category: string;
  qtyOrig: string;
  digital: number;
  unit: string;
  size: string;
  unitPrice: number | null;
  gross: number | null;
  discount: number | null;
  net: number | null;
  lineType: string;
  entersWh: string;
  notes: string;
  source: string;
};

function norm(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function soft(s: string) {
  return norm(s).replace(/[أإآ]/g, "ا");
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function excelDate(n: unknown): string {
  if (typeof n === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(n ?? "");
}

function parseCsv(text: string): CsvRec[] {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const parts: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (c === '"') {
        q = !q;
        continue;
      }
      if (c === "," && !q) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    return {
      row: Number(parts[0]),
      category: parts[1] || "",
      item: parts[2] || "",
      unit: parts[3] || "",
      opening: Number(parts[4]) || 0,
      totalIn: Number(parts[5]) || 0,
      lastOut: parts[6] || "",
      after: Number(parts[7]) || 0,
      expected: Number(parts[8]) || 0,
      rule: parts[9] || "",
    };
  });
}

async function sha256File(filePath: string) {
  const { createHash } = await import("node:crypto");
  const buf = fs.readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function newQrToken() {
  return `gia-${BATCH_KEY}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildMoveNote(row: { date: string; qtyRaw: unknown; unitRaw: string; actor: string; note: string; nameRaw?: string }, kind: "وارد" | "خارج") {
  return [
    `${BATCH_KEY}`,
    `${kind} ${row.date}`,
    row.nameRaw ? `اسم أصلي: ${row.nameRaw}` : null,
    `كمية أصلية: ${row.qtyRaw === "" || row.qtyRaw == null ? "—" : String(row.qtyRaw)}`,
    `وحدة أصلية: ${row.unitRaw || "—"}`,
    row.actor ? `مسؤول/مستلم: ${row.actor}` : null,
    row.note ? `ملاحظات: ${row.note}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function parseWorkbook() {
  const wb = XLSX.readFile(EXCEL);
  const csv = parseCsv(fs.readFileSync(CSV, "utf8"));
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const items: WhItem[] = [];
  for (let i = 0; i < wh.length; i++) {
    const r = wh[i]!;
    const cat = norm(String(r[0] ?? ""));
    const name = norm(String(r[1] ?? ""));
    if (!name || name === "المادة") continue;
    if (!cat || cat === "التصنيف" || cat.includes("ظهرت")) continue;
    const rec = csv.find((c) => c.row === i + 1);
    const openingText = typeof r[3] === "number" ? "" : String(r[3] ?? "").trim();
    items.push({
      sheetRow: i + 1,
      category: cat,
      name,
      unit: norm(String(r[2] ?? "")) || "وحدة",
      openingText,
      opening: rec ? rec.opening : asNumber(r[3]) ?? 0,
      current: rec ? rec.expected : asNumber(r[6]) ?? 0,
      lastOut: rec ? rec.lastOut : "",
      totalIn: rec ? rec.totalIn : asNumber(r[4]) ?? 0,
      after: rec ? rec.after : 0,
      rule: rec ? rec.rule : "",
      min: asNumber(r[7]) ?? 0,
    });
  }

  const innSheet = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inbound: InRow[] = [];
  for (let i = 0; i < innSheet.length; i++) {
    const r = innSheet[i]!;
    if (typeof r[0] !== "number") continue;
    inbound.push({
      idx: i,
      date: excelDate(r[0]),
      nameRaw: String(r[1] ?? ""),
      nameKey: norm(String(r[6] || r[1] || "")),
      qtyRaw: r[2],
      unitRaw: norm(String(r[3] ?? "")),
      actor: norm(String(r[4] ?? "")),
      note: String(r[5] ?? "").trim(),
      digital: asNumber(r[7]) ?? 0,
      supplier: norm(String(r[8] ?? "")),
      unitPrice: asNumber(r[9]),
      gross: asNumber(r[10]),
      discount: asNumber(r[11]),
      net: asNumber(r[12]),
      origName: String(r[13] ?? "").trim(),
      source: String(r[14] ?? "").trim(),
      invoiceNote: String(r[15] ?? "").trim(),
    });
  }

  const outSheet = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];
  const outbound: OutRow[] = [];
  for (let i = 0; i < outSheet.length; i++) {
    const r = outSheet[i]!;
    if (typeof r[0] !== "number") continue;
    outbound.push({
      idx: i,
      date: excelDate(r[0]),
      nameRaw: String(r[1] ?? ""),
      nameKey: norm(String(r[6] || r[1] || "")),
      qtyRaw: r[2],
      unitRaw: norm(String(r[3] ?? "")),
      actor: norm(String(r[4] ?? "")),
      note: String(r[5] ?? "").trim(),
      digital: asNumber(r[7]) ?? 0,
    });
  }

  const invSheet = XLSX.utils.sheet_to_json(wb.Sheets["تفاصيل الفواتير"], { header: 1, defval: "" }) as unknown[][];
  const invoices: InvRow[] = [];
  for (let i = 1; i < invSheet.length; i++) {
    const r = invSheet[i]!;
    if (!r[2] && !r[3] && !r[4]) continue;
    invoices.push({
      idx: i,
      date: excelDate(r[0]),
      store: norm(String(r[1] ?? "")),
      productAr: norm(String(r[2] ?? "")),
      nameKey: norm(String(r[3] || r[2] || "")),
      origName: String(r[4] ?? "").trim(),
      category: norm(String(r[5] ?? "")),
      qtyOrig: String(r[6] ?? "").trim(),
      digital: asNumber(r[7]) ?? 0,
      unit: norm(String(r[8] ?? "")),
      size: String(r[9] ?? "").trim(),
      unitPrice: asNumber(r[10]),
      gross: asNumber(r[11]),
      discount: asNumber(r[12]),
      net: asNumber(r[13]),
      lineType: norm(String(r[14] ?? "")),
      entersWh: norm(String(r[15] ?? "")),
      notes: String(r[16] ?? "").trim(),
      source: String(r[17] ?? "").trim(),
    });
  }

  return { items, inbound, outbound, invoices, csv };
}

type ItemRef = { id: number; name: string; category: string; unit: string; sheetRow: number; lastOut: string; opening: number };

function pickCandidate(cands: ItemRef[], opts: { date?: string; preferStock?: Map<number, number> }) {
  if (cands.length === 1) return cands[0]!;
  const ranked = [...cands].sort((a, b) => {
    const aLast = opts.date && a.lastOut === opts.date ? 0 : 1;
    const bLast = opts.date && b.lastOut === opts.date ? 0 : 1;
    if (aLast !== bLast) return aLast - bLast;
    const aAdded = a.category.includes("مضافة") ? 1 : 0;
    const bAdded = b.category.includes("مضافة") ? 1 : 0;
    if (aAdded !== bAdded) return aAdded - bAdded;
    const aStock = opts.preferStock?.get(a.id) ?? 0;
    const bStock = opts.preferStock?.get(b.id) ?? 0;
    if (aStock !== bStock) return bStock - aStock;
    if (a.opening !== b.opening) return b.opening - a.opening;
    return a.sheetRow - b.sheetRow;
  });
  return ranked[0]!;
}

async function countRows(tableName: string) {
  const result = await db.execute(sql.raw(`select count(*)::int as c from ${tableName}`));
  const rows = (result as unknown as { rows?: Array<{ c: number }> }).rows
    ?? (Array.isArray(result) ? (result as Array<{ c: number }>) : []);
  return Number(rows[0]?.c ?? 0);
}

async function cleanOperationalData() {
  const names = [
    "purchase_payments",
    "inventory_movements",
    "warehouse_lots",
    "waste_records",
    "recipe_lines",
    "daily_purchases",
    "warehouse_day_archives",
    "daily_archives",
    "inventory_items",
  ] as const;
  const before: Record<string, number> = {};
  for (const n of names) before[n] = await countRows(n);

  await db.transaction(async (tx) => {
    await tx.delete(purchasePaymentsTable);
    await tx.delete(inventoryMovementsTable);
    await tx.delete(warehouseLotsTable);
    await tx.delete(wasteRecordsTable);
    await tx.delete(recipeLinesTable);
    await tx.delete(dailyPurchasesTable);
    await tx.delete(warehouseDayArchivesTable);
    await tx.delete(dailyArchivesTable);
    await tx.delete(inventoryItemsTable);
  });

  const after: Record<string, number> = {};
  for (const n of names) after[n] = await countRows(n);

  return { before, after, deleted: Object.fromEntries(names.map((k) => [k, before[k]! - after[k]!])) };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = !apply || args.has("--dry-run");

  process.chdir(path.resolve("d:/gia-shawarma-manager-self-host"));
  process.env.DATABASE_URL ??= "pglite://.data/gia-shawarma";

  const excelSha = await sha256File(EXCEL);
  const csvSha = await sha256File(CSV);
  if (excelSha !== EXPECTED_EXCEL_SHA) {
    throw new Error(`Excel SHA mismatch: got ${excelSha}, expected ${EXPECTED_EXCEL_SHA}`);
  }
  if (csvSha !== EXPECTED_CSV_SHA) {
    throw new Error(`CSV SHA mismatch: got ${csvSha}, expected ${EXPECTED_CSV_SHA}`);
  }

  const { items, inbound, outbound, invoices, csv } = parseWorkbook();
  const invStock = invoices.filter((i) => i.lineType.includes("صنف") || i.entersWh === "نعم");
  const invNonStock = invoices.filter((i) => !(i.lineType.includes("صنف") || i.entersWh === "نعم"));
  const inDigital = inbound.filter((r) => r.digital > 0);
  const inDesc = inbound.filter((r) => !(r.digital > 0));
  const outDigital = outbound.filter((r) => r.digital > 0);
  const outDesc = outbound.filter((r) => !(r.digital > 0));
  const zeroExpected = items.filter((i) => i.current === 0).length;
  const purchaseLikeInbound = inbound.filter(
    (r) => r.digital > 0 && (r.net != null || r.gross != null || r.unitPrice != null || r.supplier),
  );

  console.log(
    JSON.stringify(
      {
        mode: apply ? "APPLY" : "DRY_RUN",
        batchKey: BATCH_KEY,
        excelSha,
        csvSha,
        counts: {
          warehouseItems: items.length,
          csvRows: csv.length,
          inboundDigital: inDigital.length,
          inboundDescriptive: inDesc.length,
          outboundDigital: outDigital.length,
          outboundDescriptive: outDesc.length,
          invoiceStockRows: invStock.length,
          invoiceNonStockRows: invNonStock.length,
          purchaseLikeInbound: purchaseLikeInbound.length,
          zeroExpectedBalances: zeroExpected,
        },
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to clean + import.");
    return;
  }

  await initDatabase();

  const force = args.has("--force");

  // Idempotency: if this batch already imported, stop (unless --force).
  const existingBatch = await db
    .select({ id: inventoryMovementsTable.id })
    .from(inventoryMovementsTable)
    .where(sql`${inventoryMovementsTable.note} like ${`%${BATCH_KEY}%`}`)
    .limit(1);
  if (existingBatch.length && !force) {
    console.log("Batch already present — aborting to avoid duplication. Use --force to wipe operational data and re-import.");
    await closeDatabase();
    return;
  }

  const cleaned = await cleanOperationalData();
  console.log("CLEANED", JSON.stringify(cleaned, null, 2));

  const warnings: string[] = [];
  const descriptive: string[] = [];
  const byExact = new Map<string, ItemRef[]>();
  const bySoft = new Map<string, ItemRef[]>();
  const itemUnit = new Map<number, string>();
  const created: { id: number; it: WhItem }[] = [];
  const stockHint = new Map<number, number>();

  for (const it of items) {
    const brand = it.openingText ? `رصيد بداية الجرد: ${it.openingText}` : "";
    const [row] = await db
      .insert(inventoryItemsTable)
      .values({
        name: it.name,
        category: it.category,
        unit: it.unit,
        brand,
        variant: `sheetRow:${it.sheetRow}|${BATCH_KEY}`,
        qrToken: newQrToken(),
        currentStock: 0,
        kitchenStock: 0,
        minimumStock: it.min,
        costPerUnit: 0,
      })
      .returning();
    const ref: ItemRef = {
      id: row.id,
      name: it.name,
      category: it.category,
      unit: it.unit,
      sheetRow: it.sheetRow,
      lastOut: it.lastOut,
      opening: it.opening,
    };
    created.push({ id: row.id, it });
    itemUnit.set(row.id, row.unit);
    stockHint.set(row.id, 0);
    const list = byExact.get(it.name) || [];
    list.push(ref);
    byExact.set(it.name, list);
    const sk = soft(it.name);
    const sl = bySoft.get(sk) || [];
    sl.push(ref);
    bySoft.set(sk, sl);
  }

  function resolve(nameKey: string, opts: { date?: string } = {}): ItemRef | null {
    const key = norm(nameKey);
    if (!key) return null;
    const exact = byExact.get(key);
    if (exact?.length) return pickCandidate(exact, { date: opts.date, preferStock: stockHint });
    const softHits = bySoft.get(soft(key));
    if (softHits?.length) return pickCandidate(softHits, { date: opts.date, preferStock: stockHint });
    return null;
  }

  // Opening balances (numeric from CSV / تدقيق only)
  const openingLines = created
    .filter((c) => c.it.opening > 0)
    .map((c) => ({
      itemId: c.id,
      quantity: c.it.opening,
      unit: itemUnit.get(c.id),
      note: c.it.openingText
        ? `${BATCH_KEY} | رصيد بداية الجرد النصي: ${c.it.openingText}`
        : `${BATCH_KEY} | رصيد بداية الجرد`,
      brand: c.it.openingText ? `رصيد بداية الجرد: ${c.it.openingText}` : undefined,
    }));
  if (openingLines.length) {
    await postWarehouseOpeningBalance({
      lines: openingLines,
      asOfDate: OPENING_DATE,
      notes: BATCH_KEY,
      actor: ACTOR,
      allowDuplicateItems: true,
      clientRequestId: BATCH_KEY,
    });
    for (const l of openingLines) stockHint.set(l.itemId, (stockHint.get(l.itemId) || 0) + l.quantity);
  }

  // Chronological events
  type Ev =
    | { kind: "in"; date: string; row: InRow }
    | { kind: "out"; date: string; row: OutRow };
  const events: Ev[] = [];
  for (const row of inbound) events.push({ kind: "in", date: row.date, row });
  for (const row of outbound) events.push({ kind: "out", date: row.date, row });
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "in" ? 0 : 1) - (b.kind === "in" ? 0 : 1));

  const lastOutByItemId = new Map<number, string>();
  for (const { id, it } of created) {
    if (it.lastOut) lastOutByItemId.set(id, it.lastOut);
  }

  let purchasesCreated = 0;
  let receivesCreated = 0;
  let transfersCreated = 0;
  let resetsCreated = 0;
  const resetDone = new Set<string>();
  const dates = [...new Set(events.map((e) => e.date))].sort();

  for (const date of dates) {
    const dayIns = events.filter((e) => e.date === date && e.kind === "in") as Extract<Ev, { kind: "in" }>[];
    const dayOuts = events.filter((e) => e.date === date && e.kind === "out") as Extract<Ev, { kind: "out" }>[];

    for (const ev of dayIns) {
      const row = ev.row;
      if (!(row.digital > 0)) {
        descriptive.push(`وارد وصفي: ${row.date} | ${row.nameKey} | ${row.qtyRaw} | ${row.unitRaw}`);
        continue;
      }
      let ref = resolve(row.nameKey, { date: row.date });
      if (!ref) {
        // Create extra item only for unmatched inbound (invoice/history) — reported later
        const [createdExtra] = await db
          .insert(inventoryItemsTable)
          .values({
            name: row.nameKey,
            category: "أصناف مضافة من الإدخال",
            unit: row.unitRaw || "وحدة",
            brand: "",
            variant: `inbound:${row.idx}|${BATCH_KEY}`,
            qrToken: newQrToken(),
            currentStock: 0,
            kitchenStock: 0,
            minimumStock: 0,
            costPerUnit: row.unitPrice ?? 0,
          })
          .returning();
        ref = {
          id: createdExtra.id,
          name: createdExtra.name,
          category: createdExtra.category,
          unit: createdExtra.unit,
          sheetRow: -1,
          lastOut: "",
          opening: 0,
        };
        itemUnit.set(ref.id, ref.unit);
        stockHint.set(ref.id, 0);
        const list = byExact.get(ref.name) || [];
        list.push(ref);
        byExact.set(ref.name, list);
        const sk = soft(ref.name);
        const sl = bySoft.get(sk) || [];
        sl.push(ref);
        bySoft.set(sk, sl);
        warnings.push(`EXTRA_ITEM_FROM_INBOUND: ${row.nameKey} (not in 202 master)`);
      }

      let purchaseId: number | null = null;
      const hasFinance = row.net != null || row.gross != null || row.unitPrice != null;
      if (hasFinance || row.supplier) {
        const qty = row.digital;
        const unitPrice = row.unitPrice ?? (row.net != null && qty > 0 ? row.net / qty : 0);
        const total = row.net ?? row.gross ?? unitPrice * qty;
        const [pur] = await db
          .insert(dailyPurchasesTable)
          .values({
            purchaseDate: row.date,
            purchaseTime: "",
            supplier: row.supplier || "—",
            itemName: row.origName || row.nameRaw || row.nameKey,
            category: ref.category,
            quantity: qty,
            unit: row.unitRaw || ref.unit,
            unitPrice: unitPrice || 0,
            totalAmount: total || 0,
            paidBy: ACTOR,
            receivedBy: row.actor || ACTOR,
            paymentMethod: "Transfer",
            inventoryItemId: ref.id,
            destination: "warehouse",
            addToStock: "yes",
            status: "ordered",
            quantityReceived: 0,
            invoiceNumber: "",
            notes: [
              BATCH_KEY,
              row.source ? `مصدر: ${row.source}` : null,
              row.discount != null ? `خصم: ${row.discount}` : null,
              row.gross != null ? `إجمالي: ${row.gross}` : null,
              row.net != null ? `صافي: ${row.net}` : null,
              row.invoiceNote || null,
              `كمية أصلية: ${row.qtyRaw ?? "—"}`,
            ]
              .filter(Boolean)
              .join(" | "),
          })
          .returning();
        purchaseId = pur.id;
        purchasesCreated++;
      }

      await receiveIntoWarehouse({
        itemId: ref.id,
        quantity: row.digital,
        unit: itemUnit.get(ref.id),
        unitCost: row.unitPrice ?? undefined,
        note: buildMoveNote(row, "وارد"),
        actor: row.actor || ACTOR,
        purchaseId,
        receiptDate: row.date,
      });
      receivesCreated++;
      stockHint.set(ref.id, (stockHint.get(ref.id) || 0) + row.digital);
    }

    // Non-last outs: exact digital transfers
    for (const ev of dayOuts) {
      const row = ev.row;
      const ref = resolve(row.nameKey, { date: row.date });
      if (!ref) {
        warnings.push(`UNMAPPED_OUT: ${row.date} ${row.nameKey} digital=${row.digital}`);
        continue;
      }
      const last = lastOutByItemId.get(ref.id) || "";
      if (last && row.date === last) {
        // handled in reset pass below; keep original qty in note only
        continue;
      }
      if (!(row.digital > 0)) {
        descriptive.push(`خارج وصفي (غير آخر إخراج): ${row.date} | ${row.nameKey} | ${row.qtyRaw}`);
        continue;
      }
      const have = stockHint.get(ref.id) || 0;
      if (row.digital > have + 1e-9) {
        warnings.push(`OVERDRAW_SKIPPED: ${row.nameKey} ${row.date} need ${row.digital} have ${have}`);
        continue;
      }
      await transferStock({
        itemId: ref.id,
        quantity: row.digital,
        unit: itemUnit.get(ref.id),
        from: "warehouse",
        to: "kitchen",
        note: buildMoveNote(row, "خارج"),
        actor: row.actor || ACTOR,
        method: "import",
      });
      transfersCreated++;
      stockHint.set(ref.id, have - row.digital);
    }

    // RESET for any master item whose CSV lastOut == date
    for (const { id, it } of created) {
      if (!it.lastOut || it.lastOut !== date) continue;
      const key = `${id}|${date}`;
      if (resetDone.has(key)) continue;
      const live = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, id) });
      const have = Number(live?.currentStock || 0);
      const matchingOut = dayOuts.find((e) => {
        const r = resolve(e.row.nameKey, { date });
        return r?.id === id;
      });
      const note = matchingOut
        ? `${buildMoveNote(matchingOut.row, "خارج")} | RESET_AFTER_KITCHEN_OUTPUT (أثر الرصيد=0 دون تعديل الكمية الأصلية في السطر)`
        : `${BATCH_KEY} | خارج ${date} | RESET_AFTER_KITCHEN_OUTPUT حسب CSV (الرصيد يصبح 0)`;
      if (have > 0) {
        await transferStock({
          itemId: id,
          quantity: have,
          unit: itemUnit.get(id),
          from: "warehouse",
          to: "kitchen",
          note,
          actor: matchingOut?.row.actor || ACTOR,
          method: "import",
        });
        transfersCreated++;
        resetsCreated++;
        stockHint.set(id, 0);
      } else {
        descriptive.push(`RESET no-op (already 0): ${it.name} @ ${date}`);
      }
      resetDone.add(key);
    }
  }

  // Non-stock invoice detail rows (financial audit only — no stock)
  let invoiceNonStockNoted = 0;
  for (const inv of invoices) {
    const isStock = inv.entersWh === "نعم" || inv.lineType.includes("صنف");
    if (isStock) continue;
    await db.insert(dailyPurchasesTable).values({
      purchaseDate: inv.date || OPENING_DATE,
      purchaseTime: "",
      supplier: inv.store || "—",
      itemName: inv.origName || inv.productAr || inv.nameKey || "سطر فاتورة غير مخزني",
      category: inv.category || "فاتورة",
      quantity: inv.digital || 0,
      unit: inv.unit || "—",
      unitPrice: inv.unitPrice ?? 0,
      totalAmount: inv.net ?? inv.gross ?? 0,
      paidBy: ACTOR,
      receivedBy: ACTOR,
      paymentMethod: "Transfer",
      inventoryItemId: null,
      destination: "none",
      addToStock: "no",
      status: "ordered",
      quantityReceived: 0,
      invoiceNumber: "",
      notes: [
        BATCH_KEY,
        "NON_STOCK_INVOICE_LINE",
        inv.lineType ? `نوع: ${inv.lineType}` : null,
        inv.discount != null ? `خصم: ${inv.discount}` : null,
        inv.size ? `حجم/وزن: ${inv.size}` : null,
        inv.source ? `مصدر: ${inv.source}` : null,
        inv.notes || null,
      ]
        .filter(Boolean)
        .join(" | "),
    });
    purchasesCreated++;
    invoiceNonStockNoted++;
  }

  // Reconciliation
  const active = await db.query.inventoryItemsTable.findMany();
  const master = active.filter((a) => String(a.variant || "").includes("sheetRow:"));
  let match = 0;
  const mismatches: Array<Record<string, unknown>> = [];
  for (const { id, it } of created) {
    const row = master.find((m) => m.id === id);
    if (!row) continue;
    const got = Number(row.currentStock);
    const expected = it.current;
    if (Math.abs(got - expected) < 0.011) match++;
    else {
      mismatches.push({
        sourceItem: it.name,
        sheetRow: it.sheetRow,
        dbItemId: id,
        expectedCurrentWarehouse: expected,
        actualCurrentWarehouse: got,
        opening: it.opening,
        totalIn: it.totalIn,
        lastKitchenOutputDate: it.lastOut || null,
        inputsAfterLastOutput: it.after,
        rule: it.rule,
        kitchenStock: Number(row.kitchenStock),
        reason: "DB warehouse balance differs from GIA_WAREHOUSE_RECONCILIATION.csv — not auto-fixed",
      });
    }
  }

  const zeroStockVisible = created.filter((c) => {
    const row = master.find((m) => m.id === c.id);
    return row && Number(row.currentStock) === 0;
  }).length;

  const extraItems = active.filter((a) => !String(a.variant || "").includes("sheetRow:")).length;

  const report = {
    batchKey: BATCH_KEY,
    cleaned,
    inserted: {
      warehouseMasterItems: created.length,
      openingLines: openingLines.length,
      receives: receivesCreated,
      kitchenTransfers: transfersCreated,
      resets: resetsCreated,
      purchases: purchasesCreated,
      invoiceNonStockLines: invoiceNonStockNoted,
      extraItemsFromUnmappedInbound: extraItems,
    },
    reconciliation: {
      compared: created.length,
      match,
      mismatch: mismatches.length,
      zeroStockVisible,
      mismatches,
    },
    warnings: warnings.slice(0, 80),
    warningCount: warnings.length,
    descriptiveCount: descriptive.length,
  };

  const reportPath = path.resolve(`d:/gia-shawarma-manager-self-host/backups/import-v2-report-${BATCH_KEY}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report written: ${reportPath}`);

  if (mismatches.length) {
    console.error(`RECONCILIATION FAILED: ${mismatches.length} mismatch(es) — see report`);
    await closeDatabase();
    process.exit(2);
  }

  await closeDatabase();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
