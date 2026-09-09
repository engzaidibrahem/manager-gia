/**
 * GIA V3 Excel import — PHASE 5
 *
 * Usage:
 *   pnpm exec tsx src/scripts/import-gia-v3-excel.ts --dry-run
 *   pnpm exec tsx src/scripts/import-gia-v3-excel.ts --apply
 *
 * Rules (user decisions):
 * - Import all 140 master rows (115 original + 25 movement-added)
 * - Keep exact duplicate names as separate items (keyed by excel row)
 * - Unmapped movement names → new MOVEMENT_CREATED_UNMAPPED items (exact raw, no fuzzy merge)
 * - Movements only from movement sheets (never from master totals columns)
 * - Historical OUT may import even when stock unknown
 * - Idempotent via batch + client_request_id
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";

const require = createRequire(fileURLToPath(import.meta.url));
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx/xlsx.js");

const EXCEL = "d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx";
const BATCH_KEY = "gia-v3-initial-excel-import-2026-09";
const OPENING_DATE = "2026-08-26";
const ROOT = "d:/gia-shawarma-manager-self-host";
const PROD_DB = path.join(ROOT, ".data", "gia-v3");
const REPORT_PATH = path.join(ROOT, "backups", "gia-v3-phase5-import-report.json");

function norm(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
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

function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function newQrToken() {
  return `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type QtyClass = "STRICT_NUMERIC" | "SAFE_NUMERIC_EXTRACTION" | "COUNT_WITH_PACKAGE" | "COMPOSITE_OR_AMBIGUOUS" | "NON_QUANTITY_TEXT" | "EMPTY";

function classifyQuantity(openingRaw: string, unitHint: string): {
  class: QtyClass;
  quantityNumeric: number | null;
  unitRaw: string;
  needsQuantityReview: boolean;
} {
  const raw = norm(openingRaw);
  const unitFallback = norm(unitHint);
  if (!raw || raw === "—" || raw === "-") {
    return { class: "EMPTY", quantityNumeric: null, unitRaw: unitFallback, needsQuantityReview: true };
  }
  const strict = asStrictNumeric(raw);
  if (strict != null) {
    return { class: "STRICT_NUMERIC", quantityNumeric: strict, unitRaw: unitFallback, needsQuantityReview: false };
  }
  const mSimple = raw.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (mSimple) {
    const num = Number(mSimple[1]);
    const rest = mSimple[2]!.trim();
    if (/وزن|كيس\s*\d|\+|g\+|\/|\d+\s*(كجم|كيلو|كغ|لتر|غ|g|kg)/i.test(rest) && /\d/.test(rest)) {
      return { class: "COMPOSITE_OR_AMBIGUOUS", quantityNumeric: null, unitRaw: unitFallback || rest, needsQuantityReview: true };
    }
    if (/كيس|أكياس|اكياس|كرتون|علبة|علبات|رول|صينية|صواني|ظروف/i.test(rest)) {
      return { class: "COUNT_WITH_PACKAGE", quantityNumeric: num, unitRaw: rest, needsQuantityReview: false };
    }
    return { class: "SAFE_NUMERIC_EXTRACTION", quantityNumeric: num, unitRaw: rest, needsQuantityReview: false };
  }
  const mGlued = raw.match(/^(\d+(?:\.\d+)?)(g|kg|ml|l|لتر|غ|كجم)$/i);
  if (mGlued) {
    return {
      class: "SAFE_NUMERIC_EXTRACTION",
      quantityNumeric: Number(mGlued[1]),
      unitRaw: mGlued[2]!,
      needsQuantityReview: false,
    };
  }
  if (/\d/.test(raw)) {
    return { class: "COMPOSITE_OR_AMBIGUOUS", quantityNumeric: null, unitRaw: unitFallback, needsQuantityReview: true };
  }
  return { class: "NON_QUANTITY_TEXT", quantityNumeric: null, unitRaw: unitFallback || raw, needsQuantityReview: true };
}

function classifyMovementQty(qtyRaw: string, unitRaw: string, digital: number | null) {
  if (digital != null && Number.isFinite(digital) && digital > 0) {
    return { quantityNumeric: digital, unitRaw: norm(unitRaw), needsReview: false, quantityRaw: qtyRaw || String(digital) };
  }
  if (digital === 0) {
    // zero digital with empty/other text — keep raw, numeric 0 only if qty is clearly 0
    const strict = asStrictNumeric(qtyRaw);
    if (strict === 0) {
      return { quantityNumeric: 0, unitRaw: norm(unitRaw), needsReview: false, quantityRaw: qtyRaw || "0" };
    }
  }
  const cls = classifyQuantity(qtyRaw || "", unitRaw);
  return {
    quantityNumeric: cls.quantityNumeric,
    unitRaw: cls.unitRaw || norm(unitRaw),
    needsReview: cls.needsQuantityReview,
    quantityRaw: qtyRaw?.trim() ? qtyRaw.trim() : "(فارغ في Excel)",
  };
}

type MasterRow = {
  excelRow: number;
  category: string;
  name: string;
  unit: string;
  openingRaw: string;
  sourceType: "ORIGINAL_INVENTORY" | "MOVEMENT_ADDED";
};

type MoveRow = {
  excelRow: number;
  date: string;
  nameRaw: string;
  nameKey: string;
  qtyRaw: string;
  unitRaw: string;
  actor: string;
  note: string;
  digital: number | null;
};

function parseWorkbook() {
  const wb = XLSX.readFile(EXCEL);
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inn = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const out = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];

  const master: MasterRow[] = [];
  for (let i = 0; i < wh.length; i++) {
    const r = wh[i]!;
    const cat = cellRaw(r[0]);
    const name = cellRaw(r[1]);
    if (!norm(name) || name === "المادة") continue;
    if (!norm(cat) || cat === "التصنيف" || cat.includes("ظهرت") || cat.includes("جرد المستودع")) continue;
    const excelRow = i + 1;
    master.push({
      excelRow,
      category: cat,
      name: norm(name),
      unit: norm(cellRaw(r[2])) || "",
      openingRaw: cellRaw(r[3]),
      sourceType: cat.includes("مضافة من الحركة") ? "MOVEMENT_ADDED" : "ORIGINAL_INVENTORY",
    });
  }

  const parseMoves = (rows: unknown[][]): MoveRow[] => {
    const list: MoveRow[] = [];
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

  return { master, inbound: parseMoves(inn), outbound: parseMoves(out) };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isApply = args.has("--apply");
  const isDryRun = args.has("--dry-run") || !isApply;

  process.chdir(ROOT);
  const hash = sha256(EXCEL);
  const { master, inbound, outbound } = parseWorkbook();

  if (isDryRun && !isApply) {
    console.log(JSON.stringify({
      mode: "DRY_RUN",
      batchKey: BATCH_KEY,
      master: master.length,
      inbound: inbound.length,
      outbound: outbound.length,
      note: "Use --apply to write to gia-v3",
    }, null, 2));
    return;
  }

  // ---- APPLY ----
  process.env.DATABASE_URL = "pglite://.data/gia-v3";

  // Backup before write
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
  const backupDir = path.join(ROOT, "backups", `gia-v3.backup-pre-import-${stamp}`);
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  if (fs.existsSync(PROD_DB)) {
    fs.cpSync(PROD_DB, backupDir, { recursive: true });
  } else {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(ROOT, "backups", `BACKUP_META-gia-v3-pre-import-${stamp}.txt`),
    `source=${PROD_DB}\nbackup=${backupDir}\nbatch=${BATCH_KEY}\nexcelSha256=${hash}\n`,
    "utf8",
  );

  const dbMod = await import("@workspace/db");
  await dbMod.initDatabase();
  const {
    db,
    v3InventoryItemsTable,
    v3OpeningBalancesTable,
    v3WarehouseMovementsTable,
  } = dbMod;
  const { recomputeItemBalances } = await import("../v3/warehouseService");

  const stats = {
    mode: "APPLY",
    batchKey: BATCH_KEY,
    excelPath: EXCEL,
    excelSha256: hash,
    backupPath: backupDir,
    dbPath: PROD_DB,
    masterRowsImported: 0,
    masterRowsIdempotent: 0,
    openingMovementsImported: 0,
    openingMovementsIdempotent: 0,
    warehouseInImported: 0,
    warehouseInIdempotent: 0,
    warehouseOutImported: 0,
    warehouseOutIdempotent: 0,
    movementCreatedItems: 0,
    movementCreatedIdempotent: 0,
    sourceRowsDropped: 0,
    duplicateMovementImports: 0,
    preservedExactDuplicateNames: [] as string[],
    movementCreatedUnmappedNames: [] as string[],
    needsReviewItems: [] as Array<{ id: number; name: string; reason: string; openingRaw?: string }>,
    reconciliation: [] as Array<Record<string, unknown>>,
    warnings: [] as string[],
  };

  // Detect exact duplicate names among master
  const nameCounts = new Map<string, number>();
  for (const m of master) nameCounts.set(m.name, (nameCounts.get(m.name) || 0) + 1);
  stats.preservedExactDuplicateNames = [...nameCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n);

  /** Map exact name → item ids (ordered by excel row). Never fuzzy. */
  const nameToItemIds = new Map<string, number[]>();
  const rowToItemId = new Map<number, number>();

  async function findMovementByClient(clientRequestId: string) {
    return db.query.v3WarehouseMovementsTable.findFirst({
      where: eq(v3WarehouseMovementsTable.clientRequestId, clientRequestId),
    });
  }

  async function findItemByBatchRow(excelRow: number) {
    const rows = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.importBatchKey, BATCH_KEY));
    return rows.find((r) => r.sourceExcelRow === excelRow) || null;
  }

  async function findUnmappedItem(name: string) {
    const rows = await db
      .select()
      .from(v3InventoryItemsTable)
      .where(eq(v3InventoryItemsTable.importBatchKey, BATCH_KEY));
    return (
      rows.find(
        (r) =>
          r.sourceType === "MOVEMENT_CREATED_UNMAPPED" &&
          (r.originalNameRaw === name || r.name === name),
      ) || null
    );
  }

  // ---- 1) Master items + openings (NOT master IN/OUT totals) ----
  for (const m of master) {
    const itemClient = `${BATCH_KEY}:item:row:${m.excelRow}`;
    const openClient = `${BATCH_KEY}:opening:row:${m.excelRow}`;
    const qty = classifyQuantity(m.openingRaw, m.unit);
    const quantityRaw = m.openingRaw?.trim() ? m.openingRaw.trim() : "0";
    const baseUnit = qty.unitRaw || m.unit || "";

    let item = await findItemByBatchRow(m.excelRow);
    if (!item) {
      // also idempotent if opening movement exists
      const existingOpen = await findMovementByClient(openClient);
      if (existingOpen) {
        item = (await db.query.v3InventoryItemsTable.findFirst({
          where: eq(v3InventoryItemsTable.id, existingOpen.inventoryItemId),
        }))!;
        stats.masterRowsIdempotent++;
      } else {
        const [created] = await db
          .insert(v3InventoryItemsTable)
          .values({
            name: m.name,
            category: m.category,
            baseUnit,
            minimumStock: null,
            warehouseQtyNumeric: null,
            kitchenQtyNumeric: 0,
            qrToken: newQrToken(),
            sourceType: m.sourceType,
            sourceExcelRow: m.excelRow,
            originalNameRaw: m.name,
            needsQuantityReview: qty.needsQuantityReview,
            needsReview: qty.needsQuantityReview,
            importBatchKey: BATCH_KEY,
          })
          .returning();
        item = created;
        stats.masterRowsImported++;
      }
    } else {
      stats.masterRowsIdempotent++;
    }

    rowToItemId.set(m.excelRow, item.id);
    const list = nameToItemIds.get(m.name) || [];
    if (!list.includes(item.id)) list.push(item.id);
    nameToItemIds.set(m.name, list);

    const existingOpenMov = await findMovementByClient(openClient);
    if (existingOpenMov) {
      stats.openingMovementsIdempotent++;
      stats.duplicateMovementImports += 0;
    } else {
      const [opening] = await db
        .insert(v3OpeningBalancesTable)
        .values({
          inventoryItemId: item.id,
          balanceDate: OPENING_DATE,
          quantityNumeric: qty.quantityNumeric,
          quantityRaw,
          unitRaw: baseUnit,
          notes: `Excel row ${m.excelRow}; class=${qty.class}`,
          createdBy: "excel-import",
          batchKey: BATCH_KEY,
          sourceExcelRow: m.excelRow,
          needsQuantityReview: qty.needsQuantityReview,
        })
        .returning();

      const [movement] = await db
        .insert(v3WarehouseMovementsTable)
        .values({
          inventoryItemId: item.id,
          movementType: "OPENING",
          quantityNumeric: qty.quantityNumeric,
          quantityRaw,
          unitRaw: baseUnit,
          movementDate: OPENING_DATE,
          actor: "excel-import",
          openingBalanceId: opening.id,
          notes: `Excel master opening row ${m.excelRow}`,
          batchKey: BATCH_KEY,
          sourceExcelRow: m.excelRow,
          originalNameRaw: m.name,
          needsReview: qty.needsQuantityReview,
          clientRequestId: openClient,
        })
        .returning();

      await db
        .update(v3OpeningBalancesTable)
        .set({ movementId: movement.id })
        .where(eq(v3OpeningBalancesTable.id, opening.id));

      stats.openingMovementsImported++;
    }

    stats.reconciliation.push({
      source: "master",
      excelRow: m.excelRow,
      name: m.name,
      sourceType: m.sourceType,
      itemId: item.id,
      openingClass: qty.class,
      quantityNumeric: qty.quantityNumeric,
      quantityRaw,
    });
  }

  async function resolveItemForMovementName(nameKey: string): Promise<{
    itemId: number;
    createdUnmapped: boolean;
    ambiguousMatch: boolean;
  }> {
    const exact = nameToItemIds.get(nameKey);
    if (exact && exact.length >= 1) {
      return { itemId: exact[0]!, createdUnmapped: false, ambiguousMatch: exact.length > 1 };
    }
    // Also check DB for already-created unmapped (idempotent re-run)
    let unmapped = await findUnmappedItem(nameKey);
    if (unmapped) {
      const list = nameToItemIds.get(nameKey) || [];
      if (!list.includes(unmapped.id)) {
        list.push(unmapped.id);
        nameToItemIds.set(nameKey, list);
      }
      return { itemId: unmapped.id, createdUnmapped: false, ambiguousMatch: false };
    }

    const [created] = await db
      .insert(v3InventoryItemsTable)
      .values({
        name: nameKey,
        category: "أصناف من الحركات (غير مطابقة)",
        baseUnit: "",
        minimumStock: null,
        warehouseQtyNumeric: null,
        kitchenQtyNumeric: 0,
        qrToken: newQrToken(),
        sourceType: "MOVEMENT_CREATED_UNMAPPED",
        sourceExcelRow: null,
        originalNameRaw: nameKey,
        needsQuantityReview: false,
        needsReview: true,
        importBatchKey: BATCH_KEY,
      })
      .returning();

    nameToItemIds.set(nameKey, [created.id]);
    stats.movementCreatedItems++;
    stats.movementCreatedUnmappedNames.push(nameKey);
    return { itemId: created.id, createdUnmapped: true, ambiguousMatch: false };
  }

  // ---- 2) Inbound movements (sheet only) ----
  for (const mv of inbound) {
    const clientId = `${BATCH_KEY}:in:row:${mv.excelRow}`;
    const existing = await findMovementByClient(clientId);
    if (existing) {
      stats.warehouseInIdempotent++;
      continue;
    }

    const resolved = await resolveItemForMovementName(mv.nameKey);
    if (resolved.ambiguousMatch) {
      stats.warnings.push(`IN row ${mv.excelRow}: exact name "${mv.nameKey}" matches multiple master items; attached to first id=${resolved.itemId}`);
    }
    const q = classifyMovementQty(mv.qtyRaw, mv.unitRaw, mv.digital);

    await db.insert(v3WarehouseMovementsTable).values({
      inventoryItemId: resolved.itemId,
      movementType: "WAREHOUSE_IN",
      quantityNumeric: q.quantityNumeric,
      quantityRaw: q.quantityRaw,
      unitRaw: q.unitRaw,
      movementDate: mv.date || OPENING_DATE,
      supplier: mv.actor || null,
      receiver: null,
      actor: mv.actor || "excel-import",
      notes: mv.note || null,
      batchKey: BATCH_KEY,
      sourceExcelRow: mv.excelRow,
      originalNameRaw: mv.nameKey,
      needsReview: q.needsReview || resolved.createdUnmapped,
      clientRequestId: clientId,
    });

    if (resolved.createdUnmapped || q.needsReview) {
      await db
        .update(v3InventoryItemsTable)
        .set({ needsReview: true, updatedAt: new Date() })
        .where(eq(v3InventoryItemsTable.id, resolved.itemId));
    }

    stats.warehouseInImported++;
    stats.reconciliation.push({
      source: "inbound",
      excelRow: mv.excelRow,
      name: mv.nameKey,
      itemId: resolved.itemId,
      createdUnmapped: resolved.createdUnmapped,
      quantityNumeric: q.quantityNumeric,
      quantityRaw: q.quantityRaw,
    });
  }

  // ---- 3) Outbound movements (sheet only, historical — never drop) ----
  for (const mv of outbound) {
    const clientId = `${BATCH_KEY}:out:row:${mv.excelRow}`;
    const existing = await findMovementByClient(clientId);
    if (existing) {
      stats.warehouseOutIdempotent++;
      continue;
    }

    const resolved = await resolveItemForMovementName(mv.nameKey);
    if (resolved.ambiguousMatch) {
      stats.warnings.push(`OUT row ${mv.excelRow}: exact name "${mv.nameKey}" matches multiple master items; attached to first id=${resolved.itemId}`);
    }
    const q = classifyMovementQty(mv.qtyRaw, mv.unitRaw, mv.digital);

    // Historical: always insert; mark needs_review if quantity unknown or stock can't be verified
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, resolved.itemId),
    });
    const available = item?.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
    const stockUnsafe =
      available == null ||
      (q.quantityNumeric != null && q.quantityNumeric > available + 1e-9) ||
      q.quantityNumeric == null;

    await db.insert(v3WarehouseMovementsTable).values({
      inventoryItemId: resolved.itemId,
      movementType: "WAREHOUSE_TO_KITCHEN",
      quantityNumeric: q.quantityNumeric,
      quantityRaw: q.quantityRaw,
      unitRaw: q.unitRaw,
      movementDate: mv.date || OPENING_DATE,
      receiver: mv.actor || null,
      actor: mv.actor || "excel-import",
      notes: mv.note || (stockUnsafe ? "historical import — stock review" : null),
      batchKey: BATCH_KEY,
      sourceExcelRow: mv.excelRow,
      originalNameRaw: mv.nameKey,
      needsReview: stockUnsafe || resolved.createdUnmapped || q.needsReview,
      clientRequestId: clientId,
    });

    if (stockUnsafe || resolved.createdUnmapped || q.needsReview) {
      await db
        .update(v3InventoryItemsTable)
        .set({ needsReview: true, updatedAt: new Date() })
        .where(eq(v3InventoryItemsTable.id, resolved.itemId));
    }

    stats.warehouseOutImported++;
    stats.reconciliation.push({
      source: "outbound",
      excelRow: mv.excelRow,
      name: mv.nameKey,
      itemId: resolved.itemId,
      createdUnmapped: resolved.createdUnmapped,
      quantityNumeric: q.quantityNumeric,
      quantityRaw: q.quantityRaw,
      stockUnsafe,
    });
  }

  // ---- 4) Recompute all item balances ----
  const allItems = await db.select().from(v3InventoryItemsTable).where(eq(v3InventoryItemsTable.importBatchKey, BATCH_KEY));
  for (const item of allItems) {
    await recomputeItemBalances(db, item.id);
  }

  // ---- 5) Final counts / reconciliation summary ----
  const finalItems = await db.select().from(v3InventoryItemsTable);
  const finalMoves = await db.select().from(v3WarehouseMovementsTable).where(eq(v3WarehouseMovementsTable.batchKey, BATCH_KEY));
  const openings = finalMoves.filter((m) => m.movementType === "OPENING");
  const inns = finalMoves.filter((m) => m.movementType === "WAREHOUSE_IN");
  const outs = finalMoves.filter((m) => m.movementType === "WAREHOUSE_TO_KITCHEN");

  const needsQty = finalItems.filter((i) => i.needsQuantityReview);
  const verified = finalItems.filter((i) => !i.needsQuantityReview && i.warehouseQtyNumeric != null);
  const negatives = finalItems.filter((i) => i.warehouseQtyNumeric != null && Number(i.warehouseQtyNumeric) < 0);
  const unmappedItems = finalItems.filter((i) => i.sourceType === "MOVEMENT_CREATED_UNMAPPED");
  const qaLeak = finalItems.filter(
    (i) => /qa|test|اختبار/i.test(i.name) || /qa|test/i.test(i.category || ""),
  );

  // Source dropped check
  const expectedMaster = master.length;
  const expectedIn = inbound.length;
  const expectedOut = outbound.length;
  const importedMasterRows = finalItems.filter(
    (i) =>
      i.importBatchKey === BATCH_KEY &&
      (i.sourceType === "ORIGINAL_INVENTORY" || i.sourceType === "MOVEMENT_ADDED"),
  ).length;
  const sourceDropped =
    Math.max(0, expectedMaster - importedMasterRows) +
    Math.max(0, expectedIn - inns.length) +
    Math.max(0, expectedOut - outs.length);

  stats.sourceRowsDropped = sourceDropped;

  // Idempotent re-count: client ids unique
  const clientIds = finalMoves.map((m) => m.clientRequestId).filter(Boolean) as string[];
  const uniqueClients = new Set(clientIds);
  stats.duplicateMovementImports = clientIds.length - uniqueClients.size;

  stats.needsReviewItems = finalItems
    .filter((i) => i.needsQuantityReview || i.needsReview)
    .map((i) => ({
      id: i.id,
      name: i.name,
      reason: i.needsQuantityReview ? "needs_quantity_review" : "needs_review",
      openingRaw: i.originalNameRaw || undefined,
    }));

  // Enrich needs-review with opening raw
  const openingByItem = new Map<number, string>();
  for (const o of await db.select().from(v3OpeningBalancesTable)) {
    if (!openingByItem.has(o.inventoryItemId)) openingByItem.set(o.inventoryItemId, o.quantityRaw);
  }
  for (const row of stats.needsReviewItems) {
    row.openingRaw = openingByItem.get(row.id);
  }

  const summary = {
    ...stats,
    movementCreatedUnmappedNames: [...new Set(stats.movementCreatedUnmappedNames)],
    final: {
      masterRowsImported: importedMasterRows,
      movementCreatedItems: unmappedItems.length,
      totalV3InventoryItems: finalItems.length,
      openingMovements: openings.length,
      warehouseIn: inns.length,
      warehouseToKitchen: outs.length,
      itemsNumericVerifiedCurrent: verified.length,
      itemsRequiringQuantityReview: needsQty.length,
      exactDuplicatesPreservedGroups: stats.preservedExactDuplicateNames.length,
      unmappedNamesPreserved: unmappedItems.length,
      sourceRowsDropped: sourceDropped,
      duplicateMovementImports: stats.duplicateMovementImports,
      reconciliationMismatches: [] as string[],
      negativeNumericWarehouseBalances: negatives.map((n) => ({
        id: n.id,
        name: n.name,
        qty: Number(n.warehouseQtyNumeric),
      })),
      testQaRecordsInProd: qaLeak.length,
    },
    expected: {
      master: expectedMaster,
      inbound: expectedIn,
      outbound: expectedOut,
    },
  };

  // Mismatch checks
  if (importedMasterRows !== 140) {
    summary.final.reconciliationMismatches.push(`master items ${importedMasterRows} != 140`);
  }
  if (inns.length !== expectedIn) {
    summary.final.reconciliationMismatches.push(`inbound ${inns.length} != ${expectedIn}`);
  }
  if (outs.length !== expectedOut) {
    summary.final.reconciliationMismatches.push(`outbound ${outs.length} != ${expectedOut}`);
  }
  if (sourceDropped !== 0) {
    summary.final.reconciliationMismatches.push(`sourceRowsDropped=${sourceDropped}`);
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({
    backupPath: backupDir,
    report: REPORT_PATH,
    final: summary.final,
    preservedExactDuplicateNames: summary.preservedExactDuplicateNames,
    movementCreatedUnmappedNames: summary.movementCreatedUnmappedNames,
    warnings: summary.warnings.slice(0, 20),
  }, null, 2));

  await dbMod.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
