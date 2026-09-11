/**
 * READ-ONLY: inspect DBs that are NOT held by the running API.
 * Does not open artifacts/api-server/.data/gia-v3 while API is live.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT = "d:/gia-shawarma-manager-self-host";

async function inspect(label: string, dataDir: string) {
  const abs = path.resolve(dataDir);
  console.log("\n==========", label, "==========");
  console.log("ABS_PATH=", abs);
  console.log("EXISTS=", fs.existsSync(abs));
  if (!fs.existsSync(abs)) return;

  const client = new PGlite(abs);
  try {
    const q = async (sql: string) => {
      const r = await client.query(sql);
      return r.rows;
    };

    const count = async (table: string) => {
      try {
        const rows = await q(`SELECT COUNT(*)::int AS c FROM ${table}`);
        return (rows[0] as { c: number }).c;
      } catch {
        return "MISSING";
      }
    };

    console.log("v3_inventory_items=", await count("v3_inventory_items"));
    console.log("v3_warehouse_movements=", await count("v3_warehouse_movements"));
    console.log("v3_purchases=", await count("v3_purchases"));
    console.log(
      "v3_purchases_active=",
      await count("v3_purchases").then(async () => {
        try {
          return ((await q(`SELECT COUNT(*)::int AS c FROM v3_purchases WHERE status='active'`))[0] as { c: number }).c;
        } catch {
          return "MISSING";
        }
      }),
    );
    try {
      console.log(
        "v3_purchases_voided=",
        ((await q(`SELECT COUNT(*)::int AS c FROM v3_purchases WHERE status='voided'`))[0] as { c: number }).c,
      );
    } catch {
      console.log("v3_purchases_voided=MISSING");
    }
    console.log("v3_purchase_payments=", await count("v3_purchase_payments"));
    console.log("v3_capital_transactions=", await count("v3_capital_transactions"));
    console.log("v3_income=", await count("v3_income"));
    console.log("v3_expenses=", await count("v3_expenses"));
    console.log("v3_employees=", await count("v3_employees"));
    console.log("v3_attendance=", await count("v3_attendance"));
    console.log("v3_payroll=", await count("v3_payroll"));
    console.log("v3_salary_payments=", await count("v3_salary_payments"));

    try {
      const rows = await q(`
        SELECT id, created_at, purchase_date, item_name, destination,
               total_amount, paid_amount, payment_status, status,
               voided_at, void_reason, actor, purchased_by, notes
        FROM v3_purchases ORDER BY id
      `);
      console.log("PURCHASE_LIST_COUNT=", rows.length);
      for (const r of rows) console.log("PURCHASE", JSON.stringify(r));
    } catch (e) {
      console.log("PURCHASE_LIST=NONE", String((e as Error).message).slice(0, 100));
    }

    try {
      const rows = await q(`
        SELECT id, name, source_type, created_at, warehouse_qty_numeric, kitchen_qty_numeric
        FROM v3_inventory_items
        WHERE created_at >= TIMESTAMPTZ '2026-09-08 17:00:00+00'
        ORDER BY created_at DESC LIMIT 40
      `);
      console.log("RECENT_ITEMS=", rows.length);
      for (const r of rows) console.log("RECENT_ITEM", JSON.stringify(r));
    } catch (e) {
      console.log("RECENT_ITEMS_ERR", String((e as Error).message).slice(0, 100));
    }

    try {
      const rows = await q(`
        SELECT id, movement_type, quantity_raw, movement_date, created_at, actor, purchase_id, status, original_name_raw
        FROM v3_warehouse_movements
        WHERE created_at >= TIMESTAMPTZ '2026-09-08 17:00:00+00'
        ORDER BY created_at DESC LIMIT 60
      `);
      console.log("RECENT_MOVES=", rows.length);
      for (const r of rows) console.log("RECENT_MOVE", JSON.stringify(r));
    } catch (e) {
      console.log("RECENT_MOVES_ERR", String((e as Error).message).slice(0, 100));
    }

    try {
      const rows = await q(`
        SELECT id, entry_type, amount, created_at, actor, status, notes
        FROM v3_capital_transactions ORDER BY id
      `);
      console.log("CAPITAL=", rows.length);
      for (const r of rows) console.log("CAPITAL_ROW", JSON.stringify(r));
    } catch {
      console.log("CAPITAL=NONE");
    }
  } finally {
    await client.close();
  }
}

async function backupPurchases(label: string, dir: string) {
  const abs = path.resolve(dir);
  console.log("\n========== BACKUP", label, "==========");
  console.log("ABS_PATH=", abs);
  if (!fs.existsSync(abs)) {
    console.log("EXISTS=false");
    return;
  }
  const client = new PGlite(abs);
  try {
    const exists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name='v3_purchases'
      ) AS e`);
    const has = Boolean((exists.rows[0] as { e: boolean }).e);
    console.log("HAS_v3_purchases=", has);
    if (!has) {
      console.log("PURCHASES_COUNT=0 (table not created yet in this backup)");
      return;
    }
    const c = await client.query(`SELECT COUNT(*)::int AS c FROM v3_purchases`);
    console.log("PURCHASES_COUNT=", (c.rows[0] as { c: number }).c);
    const rows = await client.query(`
      SELECT id, purchase_date, item_name, destination, total_amount, status, created_at
      FROM v3_purchases ORDER BY id`);
    for (const r of rows.rows) console.log("BACKUP_PURCHASE", JSON.stringify(r));
  } catch (e) {
    console.log("BACKUP_ERR", String((e as Error).message).slice(0, 200));
  } finally {
    await client.close();
  }
}

async function main() {
  const apiPkg = path.join(ROOT, "artifacts/api-server");
  console.log("RESOLVE_IF_API_CWD=", path.resolve(apiPkg, ".data/gia-v3"));
  console.log("RESOLVE_IF_ROOT_CWD=", path.resolve(ROOT, ".data/gia-v3"));

  // Root DB — presumed NOT held by current API (postmaster.pid stale at 02:05)
  await inspect("REPO_ROOT_.data_gia-v3", path.join(ROOT, ".data/gia-v3"));

  await backupPurchases("pre-phase6", path.join(ROOT, "backups/gia-v3.backup-pre-phase6-20260910-003045"));
  await backupPurchases("pre-phase7", path.join(ROOT, "backups/gia-v3.backup-pre-phase7-20260910-005019"));
  await backupPurchases("pre-phase8", path.join(ROOT, "backups/gia-v3.backup-pre-phase8-20260910-010540"));

  // Also check meta files
  for (const f of [
    "BACKUP_META-gia-v3-pre-phase6-20260910-003045.txt",
    "BACKUP_META-gia-v3-pre-phase7-20260910-005019.txt",
    "BACKUP_META-gia-v3-pre-phase8-20260910-010540.txt",
  ]) {
    const p = path.join(ROOT, "backups", f);
    console.log("\nMETA", f);
    if (fs.existsSync(p)) console.log(fs.readFileSync(p, "utf8").slice(0, 800));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
