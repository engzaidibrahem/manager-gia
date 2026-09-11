import { PGlite } from "@electric-sql/pglite";

const dbs = [
  "d:/gia-shawarma-manager-self-host/.data/gia-v3",
  "d:/gia-shawarma-manager-self-host/.data/gia-shawarma",
  "d:/gia-shawarma-manager-self-host/.data/gia-v3-test",
];

for (const dir of dbs) {
  console.log("---", dir);
  const c = new PGlite(dir);
  try {
    const has = await c.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='v3_purchases') AS e",
    );
    console.log("has_purchases", has.rows[0]);
    if ((has.rows[0] as { e: boolean }).e) {
      const rows = await c.query(
        "SELECT id,item_name,status,created_at,total_amount,destination FROM v3_purchases ORDER BY id",
      );
      console.log("count", rows.rows.length);
      for (const r of rows.rows) console.log(JSON.stringify(r));
    }
    try {
      const items = await c.query("SELECT COUNT(*)::int AS c FROM v3_inventory_items");
      console.log("items", items.rows[0]);
    } catch {
      console.log("items n/a");
    }
    try {
      const income = await c.query(
        "SELECT id,status,amount,created_at,notes,void_reason FROM v3_income",
      );
      console.log("income", JSON.stringify(income.rows));
    } catch {
      console.log("income n/a");
    }
  } catch (e) {
    console.log("ERR", (e as Error).message);
  } finally {
    await c.close();
  }
}
