/**
 * READ-ONLY production counts snapshot.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = "d:/gia-shawarma-manager-self-host";
const PROD = path.join(ROOT, ".data/gia-v3");
const OUT = path.join(ROOT, "backups/gia-v3-path-fix-prod-before.json");

async function count(c: PGlite, sql: string) {
  try {
    const r = await c.query(sql);
    return (r.rows[0] as { c: number }).c;
  } catch {
    return null;
  }
}

const c = new PGlite(PROD);
try {
  const snapshot = {
    at: new Date().toISOString(),
    absPath: path.resolve(PROD),
    inventory_items: await count(c, "SELECT COUNT(*)::int AS c FROM v3_inventory_items"),
    warehouse_movements: await count(c, "SELECT COUNT(*)::int AS c FROM v3_warehouse_movements"),
    purchases: await count(c, "SELECT COUNT(*)::int AS c FROM v3_purchases"),
    purchase_payments: await count(c, "SELECT COUNT(*)::int AS c FROM v3_purchase_payments"),
    capital: await count(c, "SELECT COUNT(*)::int AS c FROM v3_capital_transactions"),
    income: await count(c, "SELECT COUNT(*)::int AS c FROM v3_income"),
    expenses: await count(c, "SELECT COUNT(*)::int AS c FROM v3_expenses"),
    employees: await count(c, "SELECT COUNT(*)::int AS c FROM v3_employees"),
    attendance: await count(c, "SELECT COUNT(*)::int AS c FROM v3_attendance"),
    payroll: await count(c, "SELECT COUNT(*)::int AS c FROM v3_payroll"),
    salary_payments: await count(c, "SELECT COUNT(*)::int AS c FROM v3_salary_payments"),
  };
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await c.close();
}
