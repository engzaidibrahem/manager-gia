/**
 * PHASE 5.5 — Warehouse final validation investigation (READ ONLY on prod V3).
 * Writes report JSON only. No stock/merge/reimport.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { asc, eq, sql } from "drizzle-orm";

const ROOT = "d:/gia-shawarma-manager-self-host";
const EXCEL = "d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx";
const OUT = path.join(ROOT, "backups", "gia-v3-phase55-validation.json");

const require = createRequire(fileURLToPath(import.meta.url));
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx/xlsx.js");

function norm(s: string) {
  return String(s || "").trim().replace(/\s+/g, " ");
}
function softKey(s: string) {
  return norm(s)
    .replace(/[أإآ]/g, "ا")
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function cellRaw(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return String(v).trim();
}
function asStrictNumeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
  }
  return null;
}
function excelDate(n: unknown): string {
  if (typeof n === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(n ?? "");
}
function lev(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}
function confidence(moveName: string, masterName: string): "HIGH" | "MEDIUM" | "LOW" | "NO_MATCH" {
  const a = softKey(moveName);
  const b = softKey(masterName);
  if (!a || !b) return "NO_MATCH";
  if (a === b) return "HIGH";
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (ratio >= 0.7) return "HIGH";
    if (ratio >= 0.5) return "MEDIUM";
    return "LOW";
  }
  const d = lev(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (d === 1 && maxLen >= 3) return "HIGH";
  if (d === 2 && maxLen >= 5) return "MEDIUM";
  if (d <= 3 && maxLen >= 6 && d / maxLen <= 0.35) return "MEDIUM";
  if (d <= 4 && maxLen >= 8 && d / maxLen <= 0.4) return "LOW";
  return "NO_MATCH";
}

function parseExcel() {
  const wb = XLSX.readFile(EXCEL);
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inn = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const out = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];

  const masterByName = new Map<string, Array<Record<string, unknown>>>();
  const masterByRow = new Map<number, Record<string, unknown>>();
  for (let i = 0; i < wh.length; i++) {
    const r = wh[i]!;
    const cat = cellRaw(r[0]);
    const name = norm(cellRaw(r[1]));
    if (!name || name === "المادة") continue;
    if (!cat || cat === "التصنيف" || cat.includes("ظهرت") || cat.includes("جرد المستودع")) continue;
    const row = {
      excelRow: i + 1,
      category: cat,
      name,
      unit: cellRaw(r[2]),
      openingRaw: cellRaw(r[3]),
      inbound: cellRaw(r[4]),
      outbound: cellRaw(r[5]),
      currentRaw: cellRaw(r[6]),
      openingNumeric: asStrictNumeric(r[3]),
      inboundNumeric: asStrictNumeric(r[4]),
      outboundNumeric: asStrictNumeric(r[5]),
      currentNumeric: asStrictNumeric(r[6]),
    };
    masterByRow.set(i + 1, row);
    const list = masterByName.get(name) || [];
    list.push(row);
    masterByName.set(name, list);
  }

  type Move = { excelRow: number; date: string; nameKey: string; nameRaw: string; qtyRaw: string; unitRaw: string; actor: string; digital: number | null };
  const parseMoves = (rows: unknown[][]): Move[] => {
    const list: Move[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (typeof r[0] !== "number") continue;
      const nameKey = norm(String(r[6] || r[1] || ""));
      if (!nameKey || nameKey === "المادة") continue;
      list.push({
        excelRow: i + 1,
        date: excelDate(r[0]),
        nameKey,
        nameRaw: String(r[1] ?? ""),
        qtyRaw: String(r[2] ?? "").trim(),
        unitRaw: norm(String(r[3] ?? "")),
        actor: norm(String(r[4] ?? "")),
        digital: asStrictNumeric(r[7]),
      });
    }
    return list;
  };

  return { masterByName, masterByRow, inbound: parseMoves(inn), outbound: parseMoves(out) };
}

process.chdir(ROOT);
process.env.DATABASE_URL = "pglite://.data/gia-v3";
const dbMod = await import("@workspace/db");
await dbMod.initDatabase();
const { db, v3InventoryItemsTable, v3WarehouseMovementsTable, v3OpeningBalancesTable } = dbMod;

const excel = parseExcel();
const items = await db.select().from(v3InventoryItemsTable).orderBy(asc(v3InventoryItemsTable.id));
const moves = await db.select().from(v3WarehouseMovementsTable).orderBy(asc(v3WarehouseMovementsTable.movementDate), asc(v3WarehouseMovementsTable.id));
const openings = await db.select().from(v3OpeningBalancesTable);

const movesByItem = new Map<number, typeof moves>();
for (const m of moves) {
  if (m.inventoryItemId == null) continue;
  const list = movesByItem.get(m.inventoryItemId) || [];
  list.push(m);
  movesByItem.set(m.inventoryItemId, list);
}
const openingByItem = new Map(openings.map((o) => [o.inventoryItemId, o]));

function totals(itemId: number) {
  const list = movesByItem.get(itemId) || [];
  let opening = 0;
  let inn = 0;
  let out = 0;
  let hasNullOpening = false;
  let hasNumericOpening = false;
  for (const m of list) {
    if (m.status !== "active") continue;
    if (m.movementType === "OPENING") {
      if (m.quantityNumeric == null) hasNullOpening = true;
      else {
        hasNumericOpening = true;
        opening += Number(m.quantityNumeric);
      }
      continue;
    }
    if (m.quantityNumeric == null) continue;
    if (m.movementType === "WAREHOUSE_IN") inn += Number(m.quantityNumeric);
    if (m.movementType === "WAREHOUSE_TO_KITCHEN") out += Number(m.quantityNumeric);
  }
  const calculated =
    hasNullOpening ? null : hasNumericOpening || inn > 0 || out > 0 ? opening + inn - out : null;
  return { opening, inn, out, calculated, hasNullOpening, hasNumericOpening };
}

// ---- C: classify all 189 ----
type Class =
  | "NUMERIC_VERIFIED"
  | "NEEDS_QUANTITY_REVIEW"
  | "NUMERIC_NEGATIVE_NEEDS_REVIEW"
  | "NULL_BALANCE_NO_OPENING_LEDGER"
  | "OTHER";

const classified = items.map((item) => {
  const t = totals(item.id);
  const cached = item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
  let classification: Class = "OTHER";
  let reason = "";

  if (item.needsQuantityReview || t.hasNullOpening) {
    classification = "NEEDS_QUANTITY_REVIEW";
    reason = "ambiguous/non-numeric opening → warehouse balance intentionally null";
  } else if (cached != null && cached < 0) {
    classification = "NUMERIC_NEGATIVE_NEEDS_REVIEW";
    reason = "numeric ledger computes negative current";
  } else if (cached != null) {
    classification = "NUMERIC_VERIFIED";
    reason = "numeric current available (incl zero)";
  } else {
    // null balance without needsQuantityReview
    const list = movesByItem.get(item.id) || [];
    const hasOpening = list.some((m) => m.movementType === "OPENING");
    const hasAnyNumeric = list.some((m) => m.quantityNumeric != null);
    if (!hasOpening && !hasAnyNumeric) {
      classification = "NULL_BALANCE_NO_OPENING_LEDGER";
      reason = "no opening and no numeric movements → balance null (not in verified/needsQty)";
    } else if (!hasOpening && hasAnyNumeric) {
      classification = "OTHER";
      reason = "unexpected: has numeric moves but null cache";
    } else {
      classification = "OTHER";
      reason = "unexpected null warehouse with opening";
    }
  }

  return {
    id: item.id,
    name: item.name,
    sourceType: item.sourceType,
    sourceExcelRow: item.sourceExcelRow,
    needsQuantityReview: item.needsQuantityReview,
    needsReview: item.needsReview,
    warehouseQtyNumeric: cached,
    classification,
    reason,
    totals: t,
  };
});

const classCounts: Record<string, number> = {};
for (const c of classified) classCounts[c.classification] = (classCounts[c.classification] || 0) + 1;

const unexplainedVs172and14 = classified.filter(
  (c) => c.classification !== "NUMERIC_VERIFIED" && c.classification !== "NEEDS_QUANTITY_REVIEW",
);

// Note: old report counted verified as non-needsQty with non-null — negatives were inside 172.
const numericVerifiedNonNegative = classified.filter((c) => c.classification === "NUMERIC_VERIFIED").length;
const needsQty = classified.filter((c) => c.classification === "NEEDS_QUANTITY_REVIEW").length;
const numericNegative = classified.filter((c) => c.classification === "NUMERIC_NEGATIVE_NEEDS_REVIEW").length;

// ---- A/B: negatives ----
const negatives = classified.filter((c) => c.warehouseQtyNumeric != null && c.warehouseQtyNumeric < 0);

const negativeDetails = negatives.map((n) => {
  const item = items.find((i) => i.id === n.id)!;
  const list = movesByItem.get(n.id) || [];
  const op = openingByItem.get(n.id);
  const hasOpening = list.some((m) => m.movementType === "OPENING");
  const hasIn = list.some((m) => m.movementType === "WAREHOUSE_IN");
  const hasOut = list.some((m) => m.movementType === "WAREHOUSE_TO_KITCHEN");

  // Excel compare by exact name and/or source row
  const excelMasterRows = item.sourceExcelRow
    ? [excel.masterByRow.get(item.sourceExcelRow)].filter(Boolean)
    : excel.masterByName.get(item.name) || [];
  const excelIn = excel.inbound.filter((m) => m.nameKey === item.name);
  const excelOut = excel.outbound.filter((m) => m.nameKey === item.name);

  // Possible name-split: similar master names
  const similarMasters: Array<{ name: string; row: number; conf: string }> = [];
  for (const [name, rows] of excel.masterByName) {
    if (name === item.name) continue;
    const conf = confidence(item.name, name);
    if (conf !== "NO_MATCH") {
      for (const r of rows) similarMasters.push({ name, row: Number(r.excelRow), conf });
    }
  }

  let causeCode: "A" | "B" | "C" | "D" | "E" | "F" = "F";
  let causeText = "";

  if (item.sourceType === "MOVEMENT_CREATED_UNMAPPED" && !hasOpening) {
    if (hasOut && !hasIn) {
      causeCode = "A";
      causeText = "OUT تاريخي بدون Opening (وبدون IN كافٍ) على صنف أُنشئ من اسم حركة غير مطابق";
    } else if (hasOut && hasIn) {
      causeCode = "C";
      causeText = "IN موجود لكن أقل من OUT على صنف movement-created";
    } else {
      causeCode = "F";
      causeText = "سالب بدون تفسير بسيط";
    }
    // Check if Excel had same name on master with opening that we didn't attach
    if (similarMasters.some((s) => s.conf === "HIGH" || s.conf === "MEDIUM")) {
      causeCode = "B";
      causeText =
        "OUT باسم مختلف/غير مطابق لحرفياً عن master opening — فُصل الاسم في V3 فصار OUT على item بلا رصيد افتتاح";
    }
  } else if (item.sourceType === "ORIGINAL_INVENTORY" || item.sourceType === "MOVEMENT_ADDED") {
    const em = excelMasterRows[0] as Record<string, unknown> | undefined;
    const excelCurrent = em?.currentNumeric as number | null | undefined;
    if (excelCurrent != null && excelCurrent < 0) {
      causeCode = "E";
      causeText = "Excel نفسه يظهر current سالب لهذه المادة";
    } else if (hasOut && (!hasIn || n.totals.inn < n.totals.out) && (n.totals.opening === 0 || !hasOpening)) {
      causeCode = "A";
      causeText = "OUT أكبر من opening+in (افتتاح 0 أو غير كافٍ)";
    } else {
      causeCode = "E";
      causeText = "الحساب الرقمي من الحركات المستوردة يعطي سالب (راجع Excel master totals)";
    }
  }

  // Refine: أرز مندي / برتقال often E from Excel
  if (item.name === "برتقال" || item.name === "أرز مندي" || item.name === "صحون بلاستيك و معالق") {
    const em = excelMasterRows[0] as Record<string, unknown> | undefined;
    if (em && asStrictNumeric(em.currentRaw) != null && Number(asStrictNumeric(em.currentRaw)) < 0) {
      causeCode = "E";
      causeText = "Excel current سلبي صراحةً في ورقة المستودع";
    }
  }

  return {
    id: item.id,
    nameExact: item.name,
    sourceType: item.sourceType,
    sourceExcelRow: item.sourceExcelRow,
    isMaster: item.sourceType === "ORIGINAL_INVENTORY" || item.sourceType === "MOVEMENT_ADDED",
    isMovementCreated: item.sourceType === "MOVEMENT_CREATED_UNMAPPED",
    unit: item.baseUnit,
    openingQuantity: op
      ? { numeric: op.quantityNumeric, raw: op.quantityRaw, unit: op.unitRaw }
      : null,
    totalIn: n.totals.inn,
    totalOut: n.totals.out,
    calculatedCurrent: n.totals.calculated,
    cachedCurrent: n.warehouseQtyNumeric,
    causeCode,
    causeText,
    movements: list.map((m) => ({
      id: m.id,
      date: m.movementDate,
      type: m.movementType,
      quantityNumeric: m.quantityNumeric,
      quantityRaw: m.quantityRaw,
      unitRaw: m.unitRaw,
      originalNameRaw: m.originalNameRaw,
      sourceExcelRow: m.sourceExcelRow,
      needsReview: m.needsReview,
    })),
    excel: {
      masterRows: excelMasterRows,
      inboundRows: excelIn,
      outboundRows: excelOut,
      similarMasters,
    },
    excelVsDb: {
      excelCurrentRaw: excelMasterRows[0] ? (excelMasterRows[0] as any).currentRaw : null,
      excelCurrentNumeric: excelMasterRows[0] ? (excelMasterRows[0] as any).currentNumeric : null,
      dbCurrent: n.warehouseQtyNumeric,
      verdict:
        causeCode === "E"
          ? "NEGATIVE_IN_EXCEL_OR_EXCEL_LEDGER"
          : causeCode === "B"
            ? "NAME_SPLIT_IN_V3"
            : causeCode === "A"
              ? "IMPORTER_PRESERVED_HISTORICAL_OUT_WITHOUT_OPENING"
              : "OTHER",
    },
  };
});

// ---- D: 49 unmapped ----
const masterNames = items
  .filter((i) => i.sourceType === "ORIGINAL_INVENTORY" || i.sourceType === "MOVEMENT_ADDED")
  .map((i) => i.name);

const unmapped = items
  .filter((i) => i.sourceType === "MOVEMENT_CREATED_UNMAPPED")
  .map((i) => {
    const list = movesByItem.get(i.id) || [];
    const t = totals(i.id);
    let best: { name: string; confidence: "HIGH" | "MEDIUM" | "LOW" | "NO_MATCH" } = {
      name: "",
      confidence: "NO_MATCH",
    };
    const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, NO_MATCH: 0 };
    for (const mn of masterNames) {
      const c = confidence(i.name, mn);
      if (rank[c] > rank[best.confidence]) best = { name: mn, confidence: c };
    }
    return {
      id: i.id,
      exactName: i.name,
      inCount: list.filter((m) => m.movementType === "WAREHOUSE_IN").length,
      outCount: list.filter((m) => m.movementType === "WAREHOUSE_TO_KITCHEN").length,
      hasOpening: list.some((m) => m.movementType === "OPENING"),
      currentNumeric: i.warehouseQtyNumeric == null ? null : Number(i.warehouseQtyNumeric),
      possibleMasterMatch: best.confidence === "NO_MATCH" ? null : best.name,
      confidence: best.confidence,
    };
  });

// ---- F: zero stock examples ----
const zeros = classified
  .filter((c) => c.warehouseQtyNumeric === 0)
  .slice(0, 5)
  .map((c) => ({ id: c.id, name: c.name, current: 0, sourceType: c.sourceType, isActive: true }));

const report = {
  phase: "5.5",
  mode: "INVESTIGATION_READONLY",
  generatedAt: new Date().toISOString(),
  totals: {
    items: items.length,
    movements: moves.length,
    classCounts,
    sumClasses: Object.values(classCounts).reduce((a, b) => a + b, 0),
    oldReportStyle: {
      note: "Phase5 counted NUMERIC_VERIFIED including negatives (non-null & !needsQuantityReview)",
      numericNonNullAndNotNeedsQty: classified.filter((c) => c.warehouseQtyNumeric != null && !c.needsQuantityReview).length,
      needsQuantityReview: needsQty,
      remainderTo189:
        items.length -
        classified.filter((c) => c.warehouseQtyNumeric != null && !c.needsQuantityReview).length -
        needsQty,
    },
    correctedBreakdown: {
      NUMERIC_VERIFIED_non_negative: numericVerifiedNonNegative,
      NEEDS_QUANTITY_REVIEW: needsQty,
      NUMERIC_NEGATIVE_NEEDS_REVIEW: numericNegative,
      NULL_BALANCE_NO_OPENING_LEDGER: classCounts.NULL_BALANCE_NO_OPENING_LEDGER || 0,
      OTHER: classCounts.OTHER || 0,
      sum:
        numericVerifiedNonNegative +
        needsQty +
        numericNegative +
        (classCounts.NULL_BALANCE_NO_OPENING_LEDGER || 0) +
        (classCounts.OTHER || 0),
    },
  },
  threeUnexplainedPreviously: unexplainedVs172and14,
  negativeBalances: negativeDetails,
  movementCreatedUnmapped: unmapped,
  zeroStockExamples: zeros,
  qaTestRows: items.filter((i) => /qa|test|اختبار/i.test(i.name) || /qa|test/i.test(i.category || "")).map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
  })),
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      wrote: OUT,
      items: items.length,
      classCounts,
      corrected: report.totals.correctedBreakdown,
      oldRemainder: report.totals.oldReportStyle,
      unexplainedNames: unexplainedVs172and14.map((x) => ({ id: x.id, name: x.name, classification: x.classification, reason: x.reason, qty: x.warehouseQtyNumeric })),
      negatives: negativeDetails.map((n) => ({ id: n.id, name: n.nameExact, cause: n.causeCode, current: n.cachedCurrent, source: n.sourceType })),
      unmappedCount: unmapped.length,
      zeros,
      qa: report.qaTestRows.length,
    },
    null,
    2,
  ),
);

await dbMod.closeDatabase();
