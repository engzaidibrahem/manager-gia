import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const PROD = "d:/gia-shawarma-manager-self-host/.data/gia-v3";
const CORRUPT = "d:/gia-shawarma-manager-self-host/.data/gia-v3.corrupt-20260910-purchase-edit";
const OUT = "d:/gia-shawarma-manager-self-host/backups/gia-v3-missing-product-investigation.json";

async function dump(label, path) {
  if (!fs.existsSync(path)) {
    return { label, ok: false, reason: "path missing", path };
  }
  try {
    const p = new PGlite(path);
    const counts = await p.query(`
      SELECT
        (SELECT COUNT(*)::int FROM v3_inventory_items) AS items,
        (SELECT COUNT(*)::int FROM v3_warehouse_movements) AS moves,
        (SELECT COUNT(*)::int FROM v3_purchases) AS purchases,
        (SELECT COALESCE(MAX(id),0)::int FROM v3_inventory_items) AS max_item_id,
        (SELECT COALESCE(MAX(id),0)::int FROM v3_warehouse_movements) AS max_move_id,
        (SELECT COALESCE(MAX(id),0)::int FROM v3_purchases) AS max_purchase_id
    `);
    const latestItems = await p.query(`
      SELECT id, name, created_at, is_active,
             warehouse_qty_numeric, kitchen_qty_numeric, source_type, original_name_raw
      FROM v3_inventory_items
      ORDER BY id DESC
      LIMIT 20
    `);
    const latestPurchases = await p.query(`
      SELECT id, item_name, destination, inventory_item_id, movement_id,
             quantity_numeric, quantity_raw, status, created_at, updated_at, voided_at
      FROM v3_purchases
      ORDER BY id DESC
      LIMIT 20
    `);
    const latestMovements = await p.query(`
      SELECT id, inventory_item_id, movement_type, quantity_numeric, purchase_id,
             status, created_at, movement_date, original_name_raw, notes
      FROM v3_warehouse_movements
      ORDER BY id DESC
      LIMIT 25
    `);
    const kitDirect = await p.query(`
      SELECT id, inventory_item_id, quantity_numeric, purchase_id, status, created_at, original_name_raw
      FROM v3_warehouse_movements
      WHERE movement_type = 'KITCHEN_DIRECT_IN'
      ORDER BY id DESC
      LIMIT 20
    `);
    const purchaseLinked = await p.query(`
      SELECT id, inventory_item_id, movement_type, quantity_numeric, purchase_id, status, created_at
      FROM v3_warehouse_movements
      WHERE purchase_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 20
    `);
    const recentByCreated = await p.query(`
      SELECT id, name, created_at, source_type
      FROM v3_inventory_items
      WHERE created_at >= '2026-09-10'
      ORDER BY created_at DESC, id DESC
      LIMIT 30
    `);
    await p.close();
    return {
      label,
      ok: true,
      path,
      counts: counts.rows[0],
      latestItems: latestItems.rows,
      latestPurchases: latestPurchases.rows,
      latestMovements: latestMovements.rows,
      kitchenDirectIn: kitDirect.rows,
      purchaseLinkedMovements: purchaseLinked.rows,
      itemsCreatedOnOrAfterSep10: recentByCreated.rows,
    };
  } catch (e) {
    return { label, ok: false, path, reason: String(e && e.message ? e.message : e) };
  }
}

const report = {
  at: new Date().toISOString(),
  production: await dump("production", PROD),
  corrupt: await dump("corrupt-pre-restore", CORRUPT),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(OUT);
console.log(
  JSON.stringify(
    {
      prodOk: report.production.ok,
      corruptOk: report.corrupt.ok,
      prodCounts: report.production.counts,
      corruptCounts: report.corrupt.counts,
      prodPurchases: report.production.latestPurchases?.length,
      corruptPurchases: report.corrupt.latestPurchases?.length,
      prodRecentItems: report.production.itemsCreatedOnOrAfterSep10?.length,
      corruptRecentItems: report.corrupt.itemsCreatedOnOrAfterSep10?.length,
      corruptReason: report.corrupt.reason,
    },
    null,
    2,
  ),
);
