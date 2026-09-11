import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const TEST = "d:/gia-shawarma-manager-self-host/.data/gia-v3-test";
const OUT = "d:/gia-shawarma-manager-self-host/backups/gia-v3-missing-product-test-db.json";

if (!fs.existsSync(TEST)) {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, reason: "test db missing" }, null, 2));
  console.log("no test db");
  process.exit(0);
}

const p = new PGlite(TEST);
const counts = await p.query(`
  SELECT
    (SELECT COUNT(*)::int FROM v3_inventory_items) AS items,
    (SELECT COUNT(*)::int FROM v3_warehouse_movements) AS moves,
    (SELECT COUNT(*)::int FROM v3_purchases) AS purchases,
    (SELECT COALESCE(MAX(id),0)::int FROM v3_inventory_items) AS max_item_id
`);
const purs = await p.query(`
  SELECT id, item_name, destination, inventory_item_id, movement_id,
         quantity_numeric, status, created_at
  FROM v3_purchases
  ORDER BY id DESC LIMIT 20
`);
const items = await p.query(`
  SELECT id, name, created_at, source_type, warehouse_qty_numeric, kitchen_qty_numeric
  FROM v3_inventory_items
  ORDER BY id DESC LIMIT 20
`);
const kit = await p.query(`
  SELECT id, inventory_item_id, quantity_numeric, purchase_id, status, created_at, original_name_raw
  FROM v3_warehouse_movements
  WHERE movement_type = 'KITCHEN_DIRECT_IN'
  ORDER BY id DESC LIMIT 20
`);
const report = {
  ok: true,
  counts: counts.rows[0],
  latestPurchases: purs.rows,
  latestItems: items.rows,
  kitchenDirectIn: kit.rows,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  counts: report.counts,
  purchases: report.latestPurchases.map((r) => ({
    id: r.id,
    name: r.item_name,
    dest: r.destination,
    qty: r.quantity_numeric,
    itemId: r.inventory_item_id,
    movId: r.movement_id,
    status: r.status,
    at: r.created_at,
  })),
  items: report.latestItems.map((r) => ({
    id: r.id,
    name: r.name,
    src: r.source_type,
    wh: r.warehouse_qty_numeric,
    kit: r.kitchen_qty_numeric,
    at: r.created_at,
  })),
}, null, 2));
await p.close();
