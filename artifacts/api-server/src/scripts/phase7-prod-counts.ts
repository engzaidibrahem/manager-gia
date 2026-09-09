/**
 * Record production counts before Phase 7 schema/tests.
 */
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";

process.chdir("d:/gia-shawarma-manager-self-host");
process.env.DATABASE_URL = "pglite://.data/gia-v3";

const dbMod = await import("@workspace/db");
await dbMod.initDatabase();

async function count(table: string): Promise<number> {
  try {
    const res = await dbMod.db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table}`));
    const r = res as unknown as { rows?: { c: number }[] } | { c: number }[];
    if (Array.isArray(r)) return Number(r[0]?.c ?? 0);
    return Number(r.rows?.[0]?.c ?? 0);
  } catch {
    return -1; // table may not exist yet
  }
}

const report = {
  when: new Date().toISOString(),
  inventory_items: await count("v3_inventory_items"),
  warehouse_movements: await count("v3_warehouse_movements"),
  purchases: await count("v3_purchases"),
  purchase_payments: await count("v3_purchase_payments"),
  capital_transactions: await count("v3_capital_transactions"),
  income: await count("v3_income"),
  expenses: await count("v3_expenses"),
  employees: await count("v3_employees"),
  attendance: await count("v3_attendance"),
  payroll: await count("v3_payroll"),
  salary_payments: await count("v3_salary_payments"),
};

const out = path.resolve("d:/gia-shawarma-manager-self-host/backups/gia-v3-phase7-prod-before.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
await dbMod.closeDatabase();
