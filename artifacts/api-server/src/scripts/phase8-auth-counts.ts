import { sql } from "drizzle-orm";

process.chdir("d:/gia-shawarma-manager-self-host");
process.env.DATABASE_URL = "pglite://.data/gia-v3";
const dbMod = await import("@workspace/db");
await dbMod.initDatabase();

async function scalar(q: string): Promise<number> {
  const res = await dbMod.db.execute(sql.raw(q));
  const r = res as unknown as { rows?: { c: number }[] } | { c: number }[];
  if (Array.isArray(r)) return Number(r[0]?.c ?? 0);
  return Number(r.rows?.[0]?.c ?? 0);
}

const report = {
  inventory_items: await scalar("SELECT count(*)::int AS c FROM v3_inventory_items"),
  warehouse_movements: await scalar("SELECT count(*)::int AS c FROM v3_warehouse_movements"),
  purchases_active: await scalar("SELECT count(*)::int AS c FROM v3_purchases WHERE status = 'active'"),
  purchases_voided: await scalar("SELECT count(*)::int AS c FROM v3_purchases WHERE status = 'voided'"),
  income_active: await scalar("SELECT count(*)::int AS c FROM v3_income WHERE status = 'active'"),
  income_voided: await scalar("SELECT count(*)::int AS c FROM v3_income WHERE status = 'voided'"),
};
console.log(JSON.stringify(report, null, 2));
await dbMod.closeDatabase();
