/**
 * GIA V3 Excel dry-run importer — NO database writes.
 * Source: d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx
 *
 * Usage:
 *   pnpm exec tsx src/scripts/import-gia-v3-excel.ts --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx/xlsx.js");

const EXCEL = "d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx";
const BATCH_KEY = "gia-v3-initial-excel-import-2026-09";

function norm(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function soft(s: string) {
  return norm(s).replace(/[أإآ]/g, "ا");
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

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseWorkbook() {
  const wb = XLSX.readFile(EXCEL);
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inn = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const out = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];

  const sectionHeaders: string[] = [];
  const master: Array<{
    sheetRow: number;
    category: string;
    name: string;
    unit: string;
    openingRaw: string;
    openingNumeric: number | null;
    totalIn: number | null;
    totalOut: number | null;
    currentRaw: unknown;
    currentNumeric: number | null;
  }> = [];

  for (let i = 0; i < wh.length; i++) {
    const r = wh[i]!;
    const cat = norm(String(r[0] ?? ""));
    const name = norm(String(r[1] ?? ""));
    if (!name || name === "المادة") continue;
    if (!cat || cat === "التصنيف" || cat.includes("ظهرت") || cat.includes("جرد المستودع")) {
      if (cat) sectionHeaders.push(cat);
      continue;
    }
    const openingCell = r[3];
    const openingNumeric = asStrictNumeric(openingCell);
    const openingRaw =
      openingNumeric != null ? String(openingNumeric) : String(openingCell ?? "").trim() || "—";
    master.push({
      sheetRow: i + 1,
      category: cat,
      name,
      unit: norm(String(r[2] ?? "")) || "وحدة",
      openingRaw,
      openingNumeric,
      totalIn: asStrictNumeric(r[4]),
      totalOut: asStrictNumeric(r[5]),
      currentRaw: r[6],
      currentNumeric: asStrictNumeric(r[6]),
    });
  }

  type Move = {
    date: string;
    nameRaw: string;
    nameKey: string;
    qtyRaw: string;
    unitRaw: string;
    actor: string;
    note: string;
    digital: number | null;
  };

  const parseMoves = (rows: unknown[][]): Move[] => {
    const list: Move[] = [];
    for (const r of rows) {
      if (typeof r[0] !== "number") continue;
      const nameKey = norm(String(r[6] || r[1] || ""));
      if (!nameKey || nameKey === "المادة") continue;
      list.push({
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

  return { master, inbound: parseMoves(inn), outbound: parseMoves(out), sectionHeaders };
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (!args.has("--dry-run")) {
    console.log("Safety: only --dry-run is allowed in this phase. Refusing apply.");
    console.log("Usage: pnpm exec tsx src/scripts/import-gia-v3-excel.ts --dry-run");
    process.exit(1);
  }

  process.chdir(path.resolve("d:/gia-shawarma-manager-self-host"));
  const hash = sha256(EXCEL);
  const { master, inbound, outbound, sectionHeaders } = parseWorkbook();

  const openingNumeric = master.filter((m) => m.openingNumeric != null).length;
  const openingUnknown = master.filter((m) => m.openingNumeric == null).length;
  const inNumeric = inbound.filter((m) => m.digital != null && m.digital > 0).length;
  const inUnknown = inbound.filter((m) => m.digital == null || !(m.digital > 0)).length;
  const outNumeric = outbound.filter((m) => m.digital != null && m.digital > 0).length;
  const outUnknown = outbound.filter((m) => m.digital == null || !(m.digital > 0)).length;

  // Exact duplicate names in master
  const nameCounts = new Map<string, number>();
  for (const m of master) nameCounts.set(m.name, (nameCounts.get(m.name) || 0) + 1);
  const exactDuplicates = [...nameCounts.entries()].filter(([, c]) => c > 1).map(([n, c]) => ({ name: n, count: c }));

  // Soft spelling variants across master
  const softMap = new Map<string, string[]>();
  for (const m of master) {
    const k = soft(m.name);
    const list = softMap.get(k) || [];
    list.push(m.name);
    softMap.set(k, list);
  }
  const possibleDuplicates = [...softMap.entries()]
    .map(([k, names]) => ({ softKey: k, names: [...new Set(names)] }))
    .filter((x) => x.names.length > 1);

  // Movement names not in master (exact)
  const masterNames = new Set(master.map((m) => m.name));
  const masterSoft = new Map(master.map((m) => [soft(m.name), m.name]));
  const unmappedIn = [...new Set(inbound.map((i) => i.nameKey).filter((n) => !masterNames.has(n)))];
  const unmappedOut = [...new Set(outbound.map((i) => i.nameKey).filter((n) => !masterNames.has(n)))];
  const softMappedIn = unmappedIn.filter((n) => masterSoft.has(soft(n)));
  const softMappedOut = unmappedOut.filter((n) => masterSoft.has(soft(n)));

  // Negative current in sheet while opening non-numeric
  const negativeCurrentWarnings = master
    .filter((m) => m.currentNumeric != null && m.currentNumeric < 0)
    .map((m) => ({
      name: m.name,
      sheetRow: m.sheetRow,
      current: m.currentNumeric,
      openingRaw: m.openingRaw,
      openingNumeric: m.openingNumeric,
      warning: m.openingNumeric == null ? "OPENING_QUANTITY_NOT_NUMERIC" : "NEGATIVE_CURRENT",
    }));

  const report = {
    mode: "DRY_RUN",
    batchKey: BATCH_KEY,
    excelPath: EXCEL,
    excelSha256: hash,
    counts: {
      warehouseSheetRowsScanned: master.length + sectionHeaders.length,
      masterItems: master.length,
      sectionHeadersIgnored: sectionHeaders.length,
      openingRows: master.length,
      openingNumeric,
      openingUnknownNumeric: openingUnknown,
      inboundRows: inbound.length,
      inboundNumeric: inNumeric,
      inboundUnknownOrZeroDigital: inUnknown,
      outboundRows: outbound.length,
      outboundNumeric: outNumeric,
      outboundUnknownOrZeroDigital: outUnknown,
    },
    exactDuplicateNames: exactDuplicates,
    possibleDuplicatesSoftAlef: possibleDuplicates,
    unmappedInboundNames: unmappedIn,
    unmappedOutboundNames: unmappedOut,
    softAlefCouldMapInbound: softMappedIn,
    softAlefCouldMapOutbound: softMappedOut,
    negativeCurrentWarnings,
    sampleUnknownOpenings: master
      .filter((m) => m.openingNumeric == null)
      .slice(0, 15)
      .map((m) => ({ row: m.sheetRow, name: m.name, openingRaw: m.openingRaw, unit: m.unit })),
    note: "No DB writes performed. Soft-alef mapping will NOT be auto-applied without approval.",
  };

  const outPath = path.resolve("d:/gia-shawarma-manager-self-host/backups/gia-v3-excel-dryrun-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${outPath}`);
}

main();
