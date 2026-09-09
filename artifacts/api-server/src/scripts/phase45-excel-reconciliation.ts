/**
 * PHASE 4.5 — Excel reconciliation review (READ ONLY).
 * No DB writes. No Excel writes. No merges.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/phase45-excel-reconciliation.ts
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(import.meta.url));
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx/xlsx.js");

const EXCEL = "d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx";
const OUT_JSON = "d:/gia-shawarma-manager-self-host/backups/gia-v3-phase45-reconciliation.json";
const OUT_CSV = "d:/gia-shawarma-manager-self-host/backups/gia-v3-phase45-items-review.csv";

function norm(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function softAlef(s: string) {
  return norm(s).replace(/[أإآ]/g, "ا");
}

/** Soft key for similarity only — NEVER for auto-merge. */
function softKey(s: string) {
  return softAlef(s)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function cellRaw(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return String(v).trim();
}

function excelDate(n: unknown): string {
  if (typeof n === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(n ?? "");
}

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Levenshtein for short Arabic names — review aid only. */
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

type OpeningClass = "SAFE_NUMERIC_EXTRACTION" | "COUNT_WITH_PACKAGE" | "COMPOSITE_OR_AMBIGUOUS" | "NON_QUANTITY_TEXT" | "STRICT_NUMERIC" | "EMPTY";

function classifyOpening(openingRaw: string, unitRaw: string): {
  class: OpeningClass;
  suggestedNumeric: number | null;
  suggestedUnit: string | null;
  note: string;
} {
  const raw = norm(openingRaw);
  if (!raw || raw === "—" || raw === "-") {
    return { class: "EMPTY", suggestedNumeric: null, suggestedUnit: null, note: "empty opening" };
  }
  const strict = asStrictNumeric(raw);
  if (strict != null) {
    return {
      class: "STRICT_NUMERIC",
      suggestedNumeric: strict,
      suggestedUnit: unitRaw || null,
      note: "already pure number in Excel cell",
    };
  }

  // A) "1 كيلو" / "18 لتر" / "780g" / "2 كيس" — leading number + rest
  const mSimple = raw.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (mSimple) {
    const num = Number(mSimple[1]);
    const rest = mSimple[2]!.trim();
    // Composite: weight inside package text
    if (/وزن|كيس\s*\d|\+|g\+|\/|\d+\s*(كجم|كيلو|كغ|لتر|غ|g|kg)/i.test(rest) && /\d/.test(rest)) {
      return {
        class: "COMPOSITE_OR_AMBIGUOUS",
        suggestedNumeric: null,
        suggestedUnit: null,
        note: `composite package/weight text: "${raw}"`,
      };
    }
    // Count with package words
    if (/كيس|أكياس|اكياس|كرتون|علبة|علبات|رول|صينية|صواني|كيس/i.test(rest)) {
      return {
        class: "COUNT_WITH_PACKAGE",
        suggestedNumeric: num,
        suggestedUnit: rest,
        note: `count=${num}; package_raw="${rest}"; do NOT convert to kg`,
      };
    }
    // Safe unit extraction: number + unit word matching base unit-ish
    if (/^(كيلو|كجم|كغ|لتر|غرام|غ|جرام|قطعة|قطع|حبة|حبات|كيس|علبة|رول|كيس)$/i.test(rest) || rest.length <= 12) {
      return {
        class: "SAFE_NUMERIC_EXTRACTION",
        suggestedNumeric: num,
        suggestedUnit: rest,
        note: `extract numeric=${num} unit="${rest}" from opening_raw; keep raw intact`,
      };
    }
    return {
      class: "SAFE_NUMERIC_EXTRACTION",
      suggestedNumeric: num,
      suggestedUnit: rest,
      note: `leading number + text; keep raw`,
    };
  }

  // "780g" glued
  const mGlued = raw.match(/^(\d+(?:\.\d+)?)(g|kg|ml|l|لتر|غ|كجم)$/i);
  if (mGlued) {
    return {
      class: "SAFE_NUMERIC_EXTRACTION",
      suggestedNumeric: Number(mGlued[1]),
      suggestedUnit: mGlued[2]!,
      note: "glued number+unit",
    };
  }

  // Has digits but complex
  if (/\d/.test(raw)) {
    return {
      class: "COMPOSITE_OR_AMBIGUOUS",
      suggestedNumeric: null,
      suggestedUnit: null,
      note: `ambiguous text with digits: "${raw}"`,
    };
  }

  return {
    class: "NON_QUANTITY_TEXT",
    suggestedNumeric: null,
    suggestedUnit: null,
    note: `non-quantity text: "${raw}"`,
  };
}

type RowClass =
  | "REAL_ITEM"
  | "SECTION_HEADER"
  | "EMPTY_OR_FORMATTING_ROW"
  | "DUPLICATE_EXACT"
  | "POSSIBLE_DUPLICATE"
  | "OTHER";

function confidenceFromDistance(moveName: string, masterName: string): "HIGH" | "MEDIUM" | "LOW" | "NO_MATCH" {
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

function bestMasterMatch(moveName: string, masters: { name: string }[]): {
  match: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NO_MATCH";
} {
  let best: { name: string; conf: "HIGH" | "MEDIUM" | "LOW" | "NO_MATCH"; score: number } | null = null;
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, NO_MATCH: 0 };
  for (const m of masters) {
    const conf = confidenceFromDistance(moveName, m.name);
    if (conf === "NO_MATCH") continue;
    const score = rank[conf] * 100 - lev(softKey(moveName), softKey(m.name));
    if (!best || score > best.score) best = { name: m.name, conf, score };
  }
  if (!best) return { match: null, confidence: "NO_MATCH" };
  return { match: best.name, confidence: best.conf };
}

function main() {
  const hash = sha256(EXCEL);
  const wb = XLSX.readFile(EXCEL);
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inn = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const out = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];
  const summarySheet = wb.Sheets["ملخص"]
    ? (XLSX.utils.sheet_to_json(wb.Sheets["ملخص"], { header: 1, defval: "" }) as unknown[][])
    : [];

  // ---- Parse ملخص for claimed count ----
  const summaryMentions: Array<{ row: number; cells: unknown[] }> = [];
  let summaryClaimedCount: number | null = null;
  for (let i = 0; i < summarySheet.length; i++) {
    const row = summarySheet[i]!;
    const joined = row.map((c) => String(c ?? "")).join(" | ");
    if (/115|عدد|صنف|مادة|ملخص/i.test(joined) || row.some((c) => typeof c === "number" && c === 115)) {
      summaryMentions.push({ row: i + 1, cells: row });
    }
    for (const c of row) {
      if (typeof c === "number" && c === 115) summaryClaimedCount = 115;
      if (typeof c === "string" && /\b115\b/.test(c)) summaryClaimedCount = 115;
    }
  }
  // Also scan all cells for item-count like patterns
  for (const row of summarySheet) {
    for (let j = 0; j < row.length; j++) {
      const c = row[j];
      const n = asStrictNumeric(c);
      if (n === 115) summaryClaimedCount = 115;
    }
  }

  // ---- Classify EVERY warehouse sheet row ----
  type MasterCandidate = {
    excelRow: number;
    categoryRaw: string;
    nameRaw: string;
    unitRaw: string;
    openingRaw: string;
    inboundRaw: string;
    outboundRaw: string;
    currentRaw: string;
    minimumRaw: string;
    statusRaw: string;
    openingNumeric: number | null;
    inboundNumeric: number | null;
    outboundNumeric: number | null;
    currentNumeric: number | null;
    minimumNumeric: number | null;
    importerWouldTake: boolean;
    rowClass: RowClass;
    classReason: string;
  };

  const allRows: MasterCandidate[] = [];
  const sectionHeaders: MasterCandidate[] = [];
  const emptyRows: MasterCandidate[] = [];

  for (let i = 0; i < wh.length; i++) {
    const r = wh[i]!;
    const cat = cellRaw(r[0]);
    const name = cellRaw(r[1]);
    const unit = cellRaw(r[2]);
    const openingRaw = cellRaw(r[3]);
    const inboundRaw = cellRaw(r[4]);
    const outboundRaw = cellRaw(r[5]);
    const currentRaw = cellRaw(r[6]);
    const minimumRaw = cellRaw(r[7]);
    const statusRaw = cellRaw(r[8]);

    const base = {
      excelRow: i + 1,
      categoryRaw: cat,
      nameRaw: name,
      unitRaw: unit,
      openingRaw,
      inboundRaw,
      outboundRaw,
      currentRaw,
      minimumRaw,
      statusRaw,
      openingNumeric: asStrictNumeric(r[3]),
      inboundNumeric: asStrictNumeric(r[4]),
      outboundNumeric: asStrictNumeric(r[5]),
      currentNumeric: asStrictNumeric(r[6]),
      minimumNumeric: asStrictNumeric(r[7]),
    };

    const isHeader =
      name === "المادة" ||
      cat === "التصنيف" ||
      (cat.includes("جرد المستودع") && !name) ||
      cat.includes("ظهرت") ||
      /^التصنيف$/i.test(cat);

    const isEmpty = !norm(cat) && !norm(name) && !norm(unit) && !norm(openingRaw);

    // Importer logic (same as dry-run):
    // skip if !name || name==المادة
    // skip if !cat || cat==التصنيف || cat includes ظهرت/جرد
    const importerSkip =
      !norm(name) ||
      name === "المادة" ||
      !norm(cat) ||
      cat === "التصنيف" ||
      cat.includes("ظهرت") ||
      cat.includes("جرد المستودع");

    if (isEmpty) {
      emptyRows.push({
        ...base,
        importerWouldTake: false,
        rowClass: "EMPTY_OR_FORMATTING_ROW",
        classReason: "empty cells",
      });
      continue;
    }

    if (isHeader || (!norm(name) && norm(cat))) {
      const row: MasterCandidate = {
        ...base,
        importerWouldTake: false,
        rowClass: "SECTION_HEADER",
        classReason: !norm(name) ? "category without item name (section/title)" : "header/title row",
      };
      sectionHeaders.push(row);
      allRows.push(row);
      continue;
    }

    if (importerSkip) {
      const row: MasterCandidate = {
        ...base,
        importerWouldTake: false,
        rowClass: "OTHER",
        classReason: "importer skip rule matched",
      };
      allRows.push(row);
      continue;
    }

    allRows.push({
      ...base,
      importerWouldTake: true,
      rowClass: "REAL_ITEM", // may reclassify to DUPLICATE later
      classReason: "has category + item name; treated as master by dry-run importer",
    });
  }

  const importerMaster = allRows.filter((r) => r.importerWouldTake);

  // Exact duplicate names among importer master
  const nameGroups = new Map<string, MasterCandidate[]>();
  for (const m of importerMaster) {
    const k = norm(m.nameRaw);
    const list = nameGroups.get(k) || [];
    list.push(m);
    nameGroups.set(k, list);
  }
  const exactDuplicateGroups: Array<{ name: string; rows: MasterCandidate[] }> = [];
  for (const [name, rows] of nameGroups) {
    if (rows.length > 1) {
      exactDuplicateGroups.push({ name, rows });
      // Mark all but first occurrence as DUPLICATE_EXACT; first stays REAL_ITEM with note
      for (let i = 0; i < rows.length; i++) {
        if (i === 0) {
          rows[i]!.rowClass = "REAL_ITEM";
          rows[i]!.classReason = `first occurrence of exact-duplicate name "${name}" (${rows.length} total)`;
        } else {
          rows[i]!.rowClass = "DUPLICATE_EXACT";
          rows[i]!.classReason = `exact duplicate of name "${name}" (first at row ${rows[0]!.excelRow})`;
        }
      }
    }
  }

  // Soft alef possible duplicates among master (different spelling)
  const softGroups = new Map<string, MasterCandidate[]>();
  for (const m of importerMaster) {
    const k = softAlef(m.nameRaw);
    const list = softGroups.get(k) || [];
    list.push(m);
    softGroups.set(k, list);
  }
  const possibleDuplicateGroups: Array<{ softKey: string; names: string[]; rows: MasterCandidate[] }> = [];
  for (const [sk, rows] of softGroups) {
    const uniqueNames = [...new Set(rows.map((r) => norm(r.nameRaw)))];
    if (uniqueNames.length > 1) {
      possibleDuplicateGroups.push({ softKey: sk, names: uniqueNames, rows });
      for (const r of rows) {
        if (r.rowClass === "REAL_ITEM") {
          r.rowClass = "POSSIBLE_DUPLICATE";
          r.classReason = `soft-alef group "${sk}" with variants: ${uniqueNames.join(" | ")}`;
        }
      }
    }
  }

  // Broader possible variants: also compare across master with lev distance 1-2
  const broaderVariants: Array<{
    name1: string;
    name2: string;
    where1: string[];
    where2: string[];
    qtyUnitHints: string[];
    confidence: "HIGH" | "MEDIUM" | "LOW";
  }> = [];

  // ---- Movements ----
  type Move = {
    date: string;
    nameRaw: string;
    nameKey: string;
    qtyRaw: string;
    unitRaw: string;
    actor: string;
    note: string;
    digital: number | null;
    excelRow: number;
  };

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
        nameRaw: String(r[1] ?? ""),
        nameKey,
        qtyRaw: String(r[2] ?? "").trim(),
        unitRaw: norm(String(r[3] ?? "")),
        actor: norm(String(r[4] ?? "")),
        note: String(r[5] ?? "").trim(),
        digital: asStrictNumeric(r[7]),
      });
    }
    return list;
  };

  const inbound = parseMoves(inn);
  const outbound = parseMoves(out);

  const masterNamesExact = new Set(importerMaster.map((m) => norm(m.nameRaw)));
  const masterForMatch = importerMaster.map((m) => ({ name: norm(m.nameRaw) }));

  // Collect all names from movements for variant discovery
  const allNameOccurrences = new Map<string, Set<string>>();
  const addOcc = (name: string, where: string) => {
    const k = softKey(name);
    if (!k) return;
    const set = allNameOccurrences.get(k) || new Set();
    set.add(`${where}:${name}`);
    allNameOccurrences.set(k, set);
  };
  for (const m of importerMaster) addOcc(m.nameRaw, "master");
  for (const m of inbound) addOcc(m.nameKey, "inbound");
  for (const m of outbound) addOcc(m.nameKey, "outbound");

  // Soft-key groups with different raw spellings
  const softRawMap = new Map<string, Set<string>>();
  const registerName = (name: string) => {
    const sk = softKey(name);
    if (!sk) return;
    const set = softRawMap.get(sk) || new Set();
    set.add(norm(name));
    softRawMap.set(sk, set);
  };
  for (const m of importerMaster) registerName(m.nameRaw);
  for (const m of inbound) registerName(m.nameKey);
  for (const m of outbound) registerName(m.nameKey);

  for (const [sk, names] of softRawMap) {
    const arr = [...names];
    if (arr.length < 2) continue;
    // Pair first two for display (can be more)
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const n1 = arr[i]!;
        const n2 = arr[j]!;
        const where1: string[] = [];
        const where2: string[] = [];
        if (importerMaster.some((m) => norm(m.nameRaw) === n1)) where1.push("master");
        if (inbound.some((m) => m.nameKey === n1)) where1.push("inbound");
        if (outbound.some((m) => m.nameKey === n1)) where1.push("outbound");
        if (importerMaster.some((m) => norm(m.nameRaw) === n2)) where2.push("master");
        if (inbound.some((m) => m.nameKey === n2)) where2.push("inbound");
        if (outbound.some((m) => m.nameKey === n2)) where2.push("outbound");
        const conf: "HIGH" | "MEDIUM" | "LOW" =
          softAlef(n1) === softAlef(n2) ? "HIGH" : confidenceFromDistance(n1, n2) === "HIGH" ? "HIGH" : "MEDIUM";
        broaderVariants.push({
          name1: n1,
          name2: n2,
          where1,
          where2,
          qtyUnitHints: [],
          confidence: conf,
        });
      }
    }
  }

  // Also find near-misses across unmapped vs master (different soft keys)
  const unmappedInNames = [...new Set(inbound.map((i) => i.nameKey).filter((n) => !masterNamesExact.has(n)))];
  const unmappedOutNames = [...new Set(outbound.map((i) => i.nameKey).filter((n) => !masterNamesExact.has(n)))];

  for (const n of [...unmappedInNames, ...unmappedOutNames]) {
    const { match, confidence } = bestMasterMatch(n, masterForMatch);
    if (match && confidence !== "NO_MATCH") {
      const exists = broaderVariants.some(
        (v) =>
          (v.name1 === n && v.name2 === match) || (v.name2 === n && v.name1 === match),
      );
      if (!exists) {
        const where1: string[] = [];
        if (inbound.some((m) => m.nameKey === n)) where1.push("inbound");
        if (outbound.some((m) => m.nameKey === n)) where1.push("outbound");
        broaderVariants.push({
          name1: n,
          name2: match,
          where1,
          where2: ["master"],
          qtyUnitHints: [],
          confidence,
        });
      }
    }
  }

  // Unmapped inbound detail
  const unmappedInboundDetail = inbound
    .filter((m) => !masterNamesExact.has(m.nameKey))
    .map((m) => {
      const { match, confidence } = bestMasterMatch(m.nameKey, masterForMatch);
      return {
        date: m.date,
        excelRow: m.excelRow,
        rawItemName: m.nameKey,
        nameRawCell: m.nameRaw,
        rawQuantity: m.qtyRaw,
        rawUnit: m.unitRaw,
        supplierOrActor: m.actor,
        notes: m.note,
        digital: m.digital,
        possibleMasterMatch: match,
        confidence: confidence === "NO_MATCH" ? "NO_MATCH" : confidence,
      };
    });

  const unmappedOutboundDetail = outbound
    .filter((m) => !masterNamesExact.has(m.nameKey))
    .map((m) => {
      const { match, confidence } = bestMasterMatch(m.nameKey, masterForMatch);
      return {
        date: m.date,
        excelRow: m.excelRow,
        rawItemName: m.nameKey,
        nameRawCell: m.nameRaw,
        rawQuantity: m.qtyRaw,
        rawUnit: m.unitRaw,
        receiverOrActor: m.actor,
        notes: m.note,
        digital: m.digital,
        possibleMasterMatch: match,
        confidence: confidence === "NO_MATCH" ? "NO_MATCH" : confidence,
      };
    });

  // Non-numeric openings (same definition as dry-run: openingNumeric == null)
  const nonNumericOpenings = importerMaster
    .filter((m) => m.openingNumeric == null)
    .map((m) => {
      const cls = classifyOpening(m.openingRaw, m.unitRaw);
      return {
        excelRow: m.excelRow,
        item: m.nameRaw,
        category: m.categoryRaw,
        opening_raw: m.openingRaw,
        unit_raw: m.unitRaw,
        classification: cls.class,
        suggestedNumeric: cls.suggestedNumeric,
        suggestedUnit: cls.suggestedUnit,
        note: cls.note,
      };
    });

  // Current stock validation
  const currentValidation = importerMaster.map((m) => {
    const openingOk = m.openingNumeric != null;
    const inOk = m.inboundNumeric != null;
    const outOk = m.outboundNumeric != null;
    const canCompute = openingOk && inOk && outOk;
    let computable: number | null = null;
    let status: "VERIFIED" | "MISMATCH" | "CURRENT_REQUIRES_REVIEW" = "CURRENT_REQUIRES_REVIEW";
    let note = "";

    if (!openingOk) {
      note = "OPENING_QUANTITY_NOT_NUMERIC — do not treat Excel current as authoritative if formula ignored text opening";
      if (m.currentNumeric != null && m.currentNumeric < 0) {
        note += "; Excel shows NEGATIVE current likely from treating non-numeric opening as 0";
      }
    } else if (!canCompute) {
      note = "inbound or outbound cell not strict-numeric";
    } else {
      computable = (m.openingNumeric as number) + (m.inboundNumeric as number) - (m.outboundNumeric as number);
      if (m.currentNumeric != null && Math.abs(m.currentNumeric - computable) < 1e-9) {
        status = "VERIFIED";
        note = "Excel current matches OPENING+IN-OUT";
      } else if (m.currentNumeric != null) {
        status = "MISMATCH";
        note = `Excel current ${m.currentNumeric} != computable ${computable}`;
      } else {
        status = "CURRENT_REQUIRES_REVIEW";
        note = "Excel current not numeric but computable from ledger cells";
      }
    }

    return {
      excelRow: m.excelRow,
      item: m.nameRaw,
      excelCurrentRaw: m.currentRaw,
      excelCurrentNumeric: m.currentNumeric,
      openingNumeric: m.openingNumeric,
      inboundNumeric: m.inboundNumeric,
      outboundNumeric: m.outboundNumeric,
      computableCurrent: computable,
      status: canCompute && openingOk ? status : "CURRENT_REQUIRES_REVIEW",
      note,
    };
  });

  // Explain 140 vs 115
  const realItems = importerMaster.filter((m) => m.rowClass === "REAL_ITEM").length;
  const dupExactRows = importerMaster.filter((m) => m.rowClass === "DUPLICATE_EXACT").length;
  const possibleDupRows = importerMaster.filter((m) => m.rowClass === "POSSIBLE_DUPLICATE").length;

  // Alternative counts that might explain 115
  const uniqueExactNames = nameGroups.size;
  const uniqueSoftNames = softGroups.size;
  const withNumericOpening = importerMaster.filter((m) => m.openingNumeric != null).length;
  const withNonEmptyOpening = importerMaster.filter((m) => norm(m.openingRaw) && m.openingRaw !== "0").length;
  const withNonZeroCurrent = importerMaster.filter(
    (m) => m.currentNumeric != null && m.currentNumeric !== 0,
  ).length;
  const categories = [...new Set(importerMaster.map((m) => m.categoryRaw))];

  // Count rows in ملخص if it's a list
  let summaryListItemCount = 0;
  const summaryItemNames: string[] = [];
  for (let i = 0; i < summarySheet.length; i++) {
    const r = summarySheet[i]!;
    const maybeName = norm(String(r[0] ?? r[1] ?? ""));
    if (!maybeName || maybeName === "المادة" || maybeName === "التصنيف") continue;
    // heuristic: summary list rows
    if (r.length >= 2 && (asStrictNumeric(r[1]) != null || asStrictNumeric(r[2]) != null)) {
      summaryListItemCount++;
      summaryItemNames.push(maybeName);
    }
  }

  // Definitive: ملخص!B3 formula = COUNTA(المستودع!B3:B117)
  const originalInventoryRows = importerMaster.filter((m) => m.excelRow >= 3 && m.excelRow <= 117);
  const movementAddedRows = importerMaster.filter((m) => m.categoryRaw.includes("مضافة من الحركة"));
  const sectionRow118 = allRows.find(
    (r) => r.excelRow === 118 || (r.categoryRaw.includes("ظهرت") && !norm(r.nameRaw)),
  );

  const explanation140vs115 = {
    importerMasterCount: importerMaster.length,
    summaryClaimedCount: 115,
    summaryFormula: {
      cell: "ملخص!B3",
      label: "عدد أصناف الجرد",
      formula: "COUNTA(المستودع!B3:B117)",
      value: 115,
      meaning: "Counts non-empty cells in warehouse column B only for rows 3..117 (original inventory block). Does NOT include rows after the section banner at row 118.",
    },
    summaryAlsoShows: {
      kitchenTools: { label: "عدد أصناف أدوات المطبخ", value: 61 },
      foodSpices: { label: "عدد المواد الغذائية/البهارات", value: 41 },
      packaging: { label: "عدد أصناف التغليف", value: 8 },
      cleaning: { label: "عدد مواد التنظيف", value: 5 },
      sumCategories: 61 + 41 + 8 + 5,
      movementAdded: { label: "عدد الأصناف المضافة من سجلات الحركة", value: 25 },
      totalIfBothBlocks: 115 + 25,
    },
    warehouseStructure: {
      headerRow: 2,
      originalBlockRows: "3..117",
      originalBlockItemCount: originalInventoryRows.length,
      sectionBannerRow: sectionRow118?.excelRow ?? 118,
      sectionBannerText:
        sectionRow118?.categoryRaw ||
        "أصناف ظهرت في سجلات الحركة ولم تكن موجودة في جرد البداية",
      movementAddedCategory: "أصناف مضافة من الحركة",
      movementAddedRows: "120..144",
      movementAddedItemCount: movementAddedRows.length,
    },
    summaryMentions,
    whyImporterSaid140:
      "Dry-run importer accepted EVERY row with non-empty category + item name, including the 25 'أصناف مضافة من الحركة' rows below the banner. It did not stop at row 117. Row 118 has empty name so dry-run skipped it silently (sectionHeadersIgnored stayed 0 even though it is a section banner).",
    arithmetic: {
      summaryOriginal: 115,
      movementAdded: 25,
      sum: 140,
      matchesImporterMaster: importerMaster.length === 115 + 25,
    },
    categoriesPresent: categories,
    categoryCounts: Object.fromEntries(
      categories.map((c) => [c, importerMaster.filter((m) => m.categoryRaw === c).length]),
    ),
    noteOnOpeningNotZeroCoincidence:
      "openingNotZero also equals 115 because the 25 movement-added rows mostly have opening=0; that is a coincidence with the summary range, not the formula used.",
    conclusion:
      "115 و 140 كلاهما صحيحان لكنهما يقيسان مجموعتين مختلفتين. 115 = أصناف جرد البداية فقط (صفوف 3–117 حسب COUNTA). 140 = 115 + 25 أصنافاً أُضيفت لاحقاً من سجلات الحركة (بعد صف العنوان 118). قبل الاستيراد يجب أن تقرر: هل نستورد الكتلتين معاً (140 صفاً) أم جرد البداية فقط (115) مع ربط الحركات المنفصلة لاحقاً.",
  };

  // Opening class totals
  const openingClassCounts = {
    STRICT_NUMERIC: importerMaster.filter((m) => m.openingNumeric != null).length,
    SAFE_NUMERIC_EXTRACTION: nonNumericOpenings.filter((x) => x.classification === "SAFE_NUMERIC_EXTRACTION").length,
    COUNT_WITH_PACKAGE: nonNumericOpenings.filter((x) => x.classification === "COUNT_WITH_PACKAGE").length,
    COMPOSITE_OR_AMBIGUOUS: nonNumericOpenings.filter((x) => x.classification === "COMPOSITE_OR_AMBIGUOUS").length,
    NON_QUANTITY_TEXT: nonNumericOpenings.filter((x) => x.classification === "NON_QUANTITY_TEXT").length,
    EMPTY: nonNumericOpenings.filter((x) => x.classification === "EMPTY").length,
  };

  const verifiedCurrent = currentValidation.filter((c) => c.status === "VERIFIED").length;
  const mismatchCurrent = currentValidation.filter((c) => c.status === "MISMATCH").length;
  const reviewCurrent = currentValidation.filter((c) => c.status === "CURRENT_REQUIRES_REVIEW").length;

  const schemaProposal = {
    problem:
      "If quantity_numeric=NULL for '3 أكياس صغيرة', stock checks cannot enforce OUT<=available, and UI only shows raw text. User must still manage the item.",
    currentSchema: {
      movements: ["quantity_numeric nullable", "quantity_raw required", "unit_raw required"],
      items: ["warehouse_qty_numeric nullable cache", "base_unit"],
    },
    proposalWithoutBigMigrationNow: {
      keep: "Always persist quantity_raw + unit_raw verbatim from Excel.",
      addOptionalFieldsLater: [
        "quantity_count_numeric — optional package count (e.g. 3) when unit is package text",
        "package_raw — e.g. 'أكياس صغيرة'",
        "quantity_confirmed_by_user — boolean",
        "base_unit_confirmed — user-chosen base unit",
        "conversion_to_base — only when user explicitly sets it",
      ],
      operationalRuleV3FirstImport: [
        "Import ALL master rows with raw preserved.",
        "Set quantity_numeric ONLY when Excel cell is already strict number OR user later confirms SAFE_NUMERIC_EXTRACTION / COUNT_WITH_PACKAGE.",
        "For COUNT_WITH_PACKAGE: allow quantity_numeric = count and unit_raw = package text so ledger math works in package units WITHOUT converting to kg.",
        "For COMPOSITE_OR_AMBIGUOUS: quantity_numeric stays NULL; item remains visible; OUT of numeric amounts rejected until user confirms a working unit.",
        "UI flag: 'بحاجة تحديد كمية رقمية' when warehouse_qty_numeric is NULL.",
        "Never set NULL→0.",
      ],
      doNotImplementInPhase45: true,
    },
  };

  const finalNumbers = {
    REAL_MASTER_ITEMS: importerMaster.length,
    ORIGINAL_INVENTORY_BLOCK_115: originalInventoryRows.length,
    MOVEMENT_ADDED_BLOCK_25: movementAddedRows.length,
    SECTION_OR_INVALID_ROWS: sectionHeaders.length + emptyRows.length,
    EXACT_DUPLICATE_ROWS: dupExactRows,
    EXACT_DUPLICATE_NAME_GROUPS: exactDuplicateGroups.length,
    POSSIBLE_DUPLICATES: possibleDuplicateGroups.length,
    POSSIBLE_NAME_VARIANT_PAIRS: broaderVariants.length,
    UNMAPPED_INBOUND: unmappedInNames.length,
    UNMAPPED_INBOUND_ROWS: unmappedInboundDetail.length,
    UNMAPPED_OUTBOUND: unmappedOutNames.length,
    UNMAPPED_OUTBOUND_ROWS: unmappedOutboundDetail.length,
    SAFE_NUMERIC_OPENINGS:
      openingClassCounts.STRICT_NUMERIC +
      openingClassCounts.SAFE_NUMERIC_EXTRACTION +
      openingClassCounts.COUNT_WITH_PACKAGE,
    AMBIGUOUS_OPENINGS:
      openingClassCounts.COMPOSITE_OR_AMBIGUOUS +
      openingClassCounts.NON_QUANTITY_TEXT +
      openingClassCounts.EMPTY,
    OPENING_BREAKDOWN: openingClassCounts,
    ITEMS_WHOSE_CURRENT_STOCK_CAN_BE_VERIFIED: verifiedCurrent,
    ITEMS_CURRENT_MISMATCH: mismatchCurrent,
    ITEMS_REQUIRING_MANUAL_REVIEW: reviewCurrent + mismatchCurrent,
    IMPORTER_MASTER_140: importerMaster.length,
    SUMMARY_CLAIMED_115: 115,
  };

  const report = {
    phase: "4.5",
    mode: "READ_ONLY_RECONCILIATION",
    excelPath: EXCEL,
    excelSha256: hash,
    generatedAt: new Date().toISOString(),
    noDbWrites: true,
    explanation_140_vs_115: explanation140vs115,
    master_all_140: importerMaster.map((m) => ({
      excelRow: m.excelRow,
      category: m.categoryRaw,
      itemNameExactRaw: m.nameRaw,
      unitExactRaw: m.unitRaw,
      openingExactRaw: m.openingRaw,
      inbound: m.inboundRaw,
      outbound: m.outboundRaw,
      current: m.currentRaw,
      minimum: m.minimumRaw,
      status: m.statusRaw,
      rowClass: m.rowClass,
      classReason: m.classReason,
      openingNumeric: m.openingNumeric,
      inboundNumeric: m.inboundNumeric,
      outboundNumeric: m.outboundNumeric,
      currentNumeric: m.currentNumeric,
    })),
    section_headers_and_non_master: [...sectionHeaders, ...allRows.filter((r) => !r.importerWouldTake && r.rowClass !== "SECTION_HEADER")],
    empty_or_formatting_row_count: emptyRows.length,
    exact_duplicates: exactDuplicateGroups.map((g) => ({
      name: g.name,
      note:
        g.name === "ليمون"
          ? "Both rows in movement-added block with opening 0 — likely true duplicate lines."
          : "Same display name but DIFFERENT opening_raw package texts — may be intentional separate SKUs; DO NOT auto-merge.",
      occurrences: g.rows.map((r) => ({
        excelRow: r.excelRow,
        category: r.categoryRaw,
        unit: r.unitRaw,
        opening: r.openingRaw,
        inbound: r.inboundRaw,
        outbound: r.outboundRaw,
        current: r.currentRaw,
      })),
    })),
    possible_name_variants: broaderVariants,
    possible_duplicates_soft_alef_master: possibleDuplicateGroups.map((g) => ({
      softKey: g.softKey,
      names: g.names,
      rows: g.rows.map((r) => r.excelRow),
    })),
    unmapped_inbound: unmappedInboundDetail,
    unmapped_outbound: unmappedOutboundDetail,
    non_numeric_openings_48: nonNumericOpenings,
    opening_class_counts: openingClassCounts,
    current_stock_validation: currentValidation,
    schema_proposal_for_raw_quantities: schemaProposal,
    final_numbers: finalNumbers,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), "utf8");

  // CSV for human review of master items
  const csvHeader = [
    "excel_row",
    "row_class",
    "category",
    "item_name_raw",
    "unit_raw",
    "opening_raw",
    "opening_numeric",
    "inbound",
    "outbound",
    "current_raw",
    "current_numeric",
    "computable_current",
    "current_status",
    "minimum",
    "status_excel",
    "class_reason",
  ];
  const validationByRow = new Map(currentValidation.map((c) => [c.excelRow, c]));
  const csvLines = [csvHeader.join(",")];
  for (const m of importerMaster) {
    const v = validationByRow.get(m.excelRow);
    csvLines.push(
      [
        m.excelRow,
        m.rowClass,
        m.categoryRaw,
        m.nameRaw,
        m.unitRaw,
        m.openingRaw,
        m.openingNumeric,
        m.inboundRaw,
        m.outboundRaw,
        m.currentRaw,
        m.currentNumeric,
        v?.computableCurrent ?? "",
        v?.status ?? "",
        m.minimumRaw,
        m.statusRaw,
        m.classReason,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  fs.writeFileSync(OUT_CSV, "\uFEFF" + csvLines.join("\n"), "utf8");

  // Console summary
  console.log(JSON.stringify({
    wrote: { OUT_JSON, OUT_CSV },
    final_numbers: finalNumbers,
    opening_class_counts: openingClassCounts,
    exact_duplicates: exactDuplicateGroups.map((g) => ({ name: g.name, count: g.rows.length })),
    explanation_short: explanation140vs115.conclusion,
  }, null, 2));
}

main();
