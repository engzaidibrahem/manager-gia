/**
 * One-off import of corrected warehouse Excel into Inventory Core.
 * Source: d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx
 * Does NOT invent unit conversions. Preserves exact item names and notes.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { eq, isNull } from "drizzle-orm";
import {
  closeDatabase,
  db,
  initDatabase,
  inventoryItemsTable,
} from "@workspace/db";
import { archiveItems } from "../services/inventoryService";
import { receiveIntoWarehouse } from "../services/receivingService";
import { transferStock } from "../services/transferService";

const require = createRequire(import.meta.url);
const XLSX = require("../../../../artifacts/gia-shawarma-manager/node_modules/xlsx");

const EXCEL = "d:/gia-files/جرد_المستودع_والمطبخ_مصحح_نهائي.xlsx";
const ACTOR_IMPORT = "استيراد جرد Excel";

type WhItem = {
  category: string;
  name: string;
  unit: string;
  opening: unknown;
  totalIn: number;
  totalOut: number;
  current: number;
  min: number;
  openingText: string;
};

type MoveRow = {
  date: string;
  nameRaw: string;
  nameKey: string;
  qtyRaw: unknown;
  unitRaw: string;
  actor: string;
  note: string;
  digital: number;
};

function norm(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ");
}

function excelDate(n: unknown): string {
  if (typeof n === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return String(n ?? "");
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function unitOrFallback(u: string) {
  const t = norm(u);
  return t || "وحدة";
}

function buildMoveNote(row: MoveRow, kind: "وارد" | "خارج") {
  const parts = [
    `${kind} ${row.date}`,
    `كمية أصلية: ${row.qtyRaw === "" || row.qtyRaw == null ? "—" : String(row.qtyRaw)}`,
    `وحدة أصلية: ${row.unitRaw || "—"}`,
    row.actor ? `مسؤول/مستلم: ${row.actor}` : null,
    row.note ? `ملاحظات: ${row.note}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

function parseWorkbook() {
  const wb = XLSX.readFile(EXCEL);
  const wh = XLSX.utils.sheet_to_json(wb.Sheets["المستودع"], { header: 1, defval: "" }) as unknown[][];
  const inn = XLSX.utils.sheet_to_json(wb.Sheets["إدخال إلى المستودع"], { header: 1, defval: "" }) as unknown[][];
  const out = XLSX.utils.sheet_to_json(wb.Sheets["إخراج إلى المطبخ"], { header: 1, defval: "" }) as unknown[][];

  const items: WhItem[] = [];
  for (const r of wh) {
    const cat = norm(String(r[0] ?? ""));
    const name = norm(String(r[1] ?? ""));
    if (!name || name === "المادة") continue;
    if (!cat || cat === "التصنيف" || cat.includes("ظهرت")) continue;
    const openingNum = asNumber(r[3]);
    items.push({
      category: cat,
      name,
      unit: unitOrFallback(String(r[2] ?? "")),
      opening: r[3],
      totalIn: asNumber(r[4]) ?? 0,
      totalOut: asNumber(r[5]) ?? 0,
      current: asNumber(r[6]) ?? 0,
      min: asNumber(r[7]) ?? 0,
      openingText: openingNum == null ? String(r[3] ?? "").trim() : "",
    });
  }

  const parseMoves = (rows: unknown[][], title: string): MoveRow[] => {
    const outRows: MoveRow[] = [];
    for (const r of rows) {
      if (typeof r[0] !== "number") continue;
      const nameRaw = String(r[1] ?? "");
      const nameKey = norm(String(r[6] || r[1] || ""));
      if (!nameKey || nameKey === "المادة") continue;
      outRows.push({
        date: excelDate(r[0]),
        nameRaw,
        nameKey,
        qtyRaw: r[2],
        unitRaw: norm(String(r[3] ?? "")),
        actor: norm(String(r[4] ?? "")),
        note: String(r[5] ?? "").trim(),
        digital: asNumber(r[7]) ?? 0,
      });
    }
    void title;
    return outRows;
  };

  return {
    items,
    inbound: parseMoves(inn, "in"),
    outbound: parseMoves(out, "out"),
  };
}

function newQrToken() {
  return `gia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  process.chdir(path.resolve("d:/gia-shawarma-manager-self-host"));
  process.env.DATABASE_URL ??= "pglite://.data/gia-shawarma";

  const { items, inbound, outbound } = parseWorkbook();
  console.log(`Parsed WH items=${items.length} inbound=${inbound.length} outbound=${outbound.length}`);

  await initDatabase();

  const existing = await db.query.inventoryItemsTable.findMany({
    where: isNull(inventoryItemsTable.archivedAt),
  });
  if (existing.length) {
    console.log(`Archiving ${existing.length} existing active items (test/old data)...`);
    await db.transaction(async (tx) => {
      await archiveItems(
        tx,
        existing.map((e) => e.id),
      );
    });
  }

  // nameKey -> preferred item id for movements (first created with that name)
  const byName = new Map<string, number>();
  const itemUnit = new Map<number, string>();
  const createdWh: { id: number; it: WhItem }[] = [];
  const descriptiveLog: string[] = [];
  const warnings: string[] = [];

  async function ensureItem(opts: {
    name: string;
    category: string;
    unit: string;
    brand?: string;
    minimumStock?: number;
  }) {
    const key = norm(opts.name);
    const hit = byName.get(key);
    if (hit) return hit;
    const [created] = await db
      .insert(inventoryItemsTable)
      .values({
        name: opts.name,
        category: opts.category,
        unit: unitOrFallback(opts.unit),
        brand: opts.brand ?? "",
        variant: "",
        qrToken: newQrToken(),
        currentStock: 0,
        kitchenStock: 0,
        minimumStock: opts.minimumStock ?? 0,
        costPerUnit: 0,
      })
      .returning();
    byName.set(key, created.id);
    const soft = key.replace(/[أإآ]/g, "ا");
    if (!byName.has(soft)) byName.set(soft, created.id);
    itemUnit.set(created.id, created.unit);
    return created.id;
  }

  // Create warehouse master rows — duplicate names stay as separate items with exact names
  for (const it of items) {
    const brand = it.openingText ? `رصيد بداية الجرد: ${it.openingText}` : "";
    const key = norm(it.name);
    const [created] = await db
      .insert(inventoryItemsTable)
      .values({
        name: it.name,
        category: it.category,
        unit: it.unit,
        brand,
        variant: "",
        qrToken: newQrToken(),
        currentStock: 0,
        kitchenStock: 0,
        minimumStock: it.min,
        costPerUnit: 0,
      })
      .returning();
    createdWh.push({ id: created.id, it });
    if (!byName.has(key)) byName.set(key, created.id);
    const soft = key.replace(/[أإآ]/g, "ا");
    if (!byName.has(soft)) byName.set(soft, created.id);
    itemUnit.set(created.id, created.unit);
  }

  async function resolveId(nameKey: string, category = "أصناف مضافة من الحركة", unit = "وحدة") {
    const key = norm(nameKey);
    if (byName.has(key)) return byName.get(key)!;
    const soft = key.replace(/[أإآ]/g, "ا");
    if (byName.has(soft)) return byName.get(soft)!;
    return ensureItem({ name: key, category, unit });
  }

  // Opening balances per created row (numeric only — text openings on brand)
  for (const { id, it } of createdWh) {
    const openingNum = asNumber(it.opening) ?? 0;
    if (!(openingNum > 0)) continue;
    await receiveIntoWarehouse({
      itemId: id,
      quantity: openingNum,
      unit: itemUnit.get(id),
      note: "رصيد بداية الجرد 26/08/2026",
      actor: ACTOR_IMPORT,
      receiptDate: "2026-08-26",
    });
  }

  // Sheet inbound totals not covered by digital movement rows (e.g. نشاء = 60)
  const digitalInByName = new Map<string, number>();
  for (const r of inbound) {
    if (!(r.digital > 0)) continue;
    digitalInByName.set(r.nameKey, (digitalInByName.get(r.nameKey) || 0) + r.digital);
  }
  const inboundGapDone = new Set<string>();
  for (const { id, it } of createdWh) {
    const key = norm(it.name);
    if (inboundGapDone.has(key)) continue;
    inboundGapDone.add(key);
    const soft = key.replace(/[أإآ]/g, "ا");
    const dig = digitalInByName.get(key) || digitalInByName.get(soft) || 0;
    const gap = it.totalIn - dig;
    if (gap > 0.0001) {
      await receiveIntoWarehouse({
        itemId: id,
        quantity: gap,
        unit: itemUnit.get(id),
        note: `إجمالي المدخل حسب ورقة المستودع (فرق غير مفصّل في سجل الإدخال): ${gap}`,
        actor: ACTOR_IMPORT,
        receiptDate: "2026-08-26",
      });
      warnings.push(`Gap inbound ${it.name}: +${gap} from sheet total`);
    }
  }

  // Replay inbound rows
  for (const row of inbound) {
    if (!(row.digital > 0)) {
      descriptiveLog.push(
        `وارد وصفي بدون رقم: ${row.date} | ${row.nameKey} | qty=${row.qtyRaw} | unit=${row.unitRaw} | ${row.actor} | ${row.note}`,
      );
      await resolveId(row.nameKey, "أصناف مضافة من الحركة", unitOrFallback(row.unitRaw));
      continue;
    }
    const id = await resolveId(row.nameKey, "أصناف مضافة من الحركة", unitOrFallback(row.unitRaw));
    const toKitchen = row.actor.includes("في المطبخ");
    await receiveIntoWarehouse({
      itemId: id,
      quantity: row.digital,
      unit: itemUnit.get(id),
      note: buildMoveNote(row, "وارد"),
      actor: row.actor || ACTOR_IMPORT,
      receiptDate: row.date,
    });
    if (toKitchen) {
      await transferStock({
        itemId: id,
        quantity: row.digital,
        unit: itemUnit.get(id),
        from: "warehouse",
        to: "kitchen",
        note: buildMoveNote(row, "خارج"),
        actor: row.actor || ACTOR_IMPORT,
        method: "import",
      });
    }
  }

  // Sheet outbound gaps (once per name)
  const digitalOutByName = new Map<string, number>();
  for (const r of outbound) {
    if (!(r.digital > 0)) continue;
    digitalOutByName.set(r.nameKey, (digitalOutByName.get(r.nameKey) || 0) + r.digital);
  }
  const outboundGapDone = new Set<string>();
  for (const { id, it } of createdWh) {
    const key = norm(it.name);
    if (outboundGapDone.has(key)) continue;
    outboundGapDone.add(key);
    const soft = key.replace(/[أإآ]/g, "ا");
    const dig = digitalOutByName.get(key) || digitalOutByName.get(soft) || 0;
    const gap = it.totalOut - dig;
    if (gap > 0.0001) {
      const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, id) });
      const have = Number(item?.currentStock || 0);
      if (have + 0.0001 < gap) {
        await receiveIntoWarehouse({
          itemId: id,
          quantity: gap - have,
          unit: itemUnit.get(id),
          note: `تعويض رصيد قبل خارج حسب ورقة المستودع (${it.name})`,
          actor: ACTOR_IMPORT,
          receiptDate: "2026-08-26",
        });
      }
      await transferStock({
        itemId: id,
        quantity: gap,
        unit: itemUnit.get(id),
        from: "warehouse",
        to: "kitchen",
        note: `إجمالي الخارج حسب ورقة المستودع (فرق غير مفصّل): ${gap}`,
        actor: ACTOR_IMPORT,
        method: "import",
      });
      warnings.push(`Gap outbound ${it.name}: ${gap} from sheet total`);
    }
  }

  // Replay outbound
  for (const row of outbound) {
    if (!(row.digital > 0)) {
      descriptiveLog.push(
        `خارج وصفي بدون رقم: ${row.date} | ${row.nameKey} | qty=${row.qtyRaw} | unit=${row.unitRaw} | ${row.actor} | ${row.note}`,
      );
      await resolveId(row.nameKey, "أصناف مضافة من الحركة", unitOrFallback(row.unitRaw));
      continue;
    }
    const id = await resolveId(row.nameKey, "أصناف مضافة من الحركة", unitOrFallback(row.unitRaw));
    const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, id) });
    const have = Number(item?.currentStock || 0);
    if (have + 0.0001 < row.digital) {
      await receiveIntoWarehouse({
        itemId: id,
        quantity: row.digital - have,
        unit: itemUnit.get(id),
        note: `تعويض رصيد قبل تحويل للمطبخ | ${buildMoveNote(row, "خارج")}`,
        actor: ACTOR_IMPORT,
        receiptDate: row.date,
      });
      warnings.push(`Top-up before transfer ${row.nameKey}: need ${row.digital}, had ${have}`);
    }
    await transferStock({
      itemId: id,
      quantity: row.digital,
      unit: itemUnit.get(id),
      from: "warehouse",
      to: "kitchen",
      note: buildMoveNote(row, "خارج"),
      actor: row.actor || ACTOR_IMPORT,
      method: "import",
    });
  }

  // Verify against sheet current (numeric) per created warehouse row
  const active = await db.query.inventoryItemsTable.findMany({
    where: isNull(inventoryItemsTable.archivedAt),
  });
  let match = 0;
  let mismatch = 0;
  for (const { id, it } of createdWh) {
    const row = active.find((a) => a.id === id);
    if (!row) continue;
    const wh = Number(row.currentStock);
    const expected = it.current < 0 ? 0 : it.current; // system cannot hold negative stock
    if (Math.abs(wh - expected) < 0.011) match++;
    else {
      mismatch++;
      warnings.push(
        `BALANCE ${it.name}: sheet ${it.current} → expected operable ${expected}, got WH ${wh} (kitchen ${row.kitchenStock})`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        createdActive: active.length,
        balanceMatch: match,
        balanceMismatch: mismatch,
        warnings: warnings.length,
        descriptiveOnly: descriptiveLog.length,
      },
      null,
      2,
    ),
  );
  if (warnings.length) {
    console.log("--- warnings ---");
    warnings.forEach((w) => console.log(w));
  }
  if (descriptiveLog.length) {
    console.log("--- descriptive rows preserved on brand (no invented qty) ---");
    descriptiveLog.forEach((w) => console.log(w));
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
