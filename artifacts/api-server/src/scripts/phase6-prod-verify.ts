/**
 * One-shot: migrate gia-v3 schema (bootstrap) and print warehouse counts.
 * NEVER points at gia-v3-test.
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

process.chdir("d:/gia-shawarma-manager-self-host");
process.env.DATABASE_URL = "pglite://.data/gia-v3";

const dbMod = await import("@workspace/db");
await dbMod.initDatabase();

const items = await dbMod.db.select().from(dbMod.v3InventoryItemsTable);
const moves = await dbMod.db.select().from(dbMod.v3WarehouseMovementsTable);
const tables = await dbMod.db.execute(
  sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'v3_%' ORDER BY 1`,
);
const purchases = await dbMod.db.execute(sql`SELECT count(*)::int AS c FROM v3_purchases`);
const capital = await dbMod.db.execute(sql`SELECT count(*)::int AS c FROM v3_capital_transactions`);
const income = await dbMod.db.execute(sql`SELECT count(*)::int AS c FROM v3_income`);
const expenses = await dbMod.db.execute(sql`SELECT count(*)::int AS c FROM v3_expenses`);
const qa = await dbMod.db.execute(
  sql`SELECT count(*)::int AS c FROM v3_inventory_items WHERE name ILIKE '%qa%' OR name ILIKE '%test%' OR category ILIKE '%test%'`,
);

function countOf(res: unknown): number {
  const r = res as { rows?: { c: number }[] } | { c: number }[];
  if (Array.isArray(r)) return Number(r[0]?.c ?? 0);
  return Number(r.rows?.[0]?.c ?? 0);
}

function tableNames(res: unknown): string[] {
  const r = res as { rows?: { tablename: string }[] } | { tablename: string }[];
  if (Array.isArray(r)) return r.map((x) => x.tablename);
  return (r.rows ?? []).map((x) => x.tablename);
}

const report = {
  items: items.length,
  movements: moves.length,
  qaOrTestItems: countOf(qa),
  purchases: countOf(purchases),
  capital: countOf(capital),
  income: countOf(income),
  expenses: countOf(expenses),
  tables: tableNames(tables),
};

const out = path.resolve("d:/gia-shawarma-manager-self-host/backups/gia-v3-phase6-prod-verify.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
await dbMod.closeDatabase();
