import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const ids = JSON.parse(
  fs.readFileSync("d:/gia-shawarma-manager-self-host/backups/gia-v3-persist-restart-ids.json", "utf8"),
);
const path = "d:/gia-shawarma-manager-self-host/.data/gia-v3-test";
const p = new PGlite(path);
const counts = await p.query(`
  SELECT
    (SELECT COUNT(*)::int FROM v3_purchases) AS purchases,
    (SELECT COUNT(*)::int FROM v3_inventory_items) AS items,
    (SELECT COUNT(*)::int FROM v3_warehouse_movements) AS moves
`);
const wh = await p.query(
  `SELECT id, destination, quantity_numeric, inventory_item_id, movement_id, status
   FROM v3_purchases WHERE id = $1`,
  [ids.whP],
);
const allPur = await p.query(`SELECT id, item_name, destination, status FROM v3_purchases ORDER BY id`);
const out = { path, counts: counts.rows[0], wh: wh.rows[0] ?? null, allPurchases: allPur.rows };
fs.writeFileSync(
  "d:/gia-shawarma-manager-self-host/backups/gia-v3-persist-restart-after-stop.json",
  JSON.stringify(out, null, 2),
  "utf8",
);
console.log(JSON.stringify(out, null, 2));
await p.close();
