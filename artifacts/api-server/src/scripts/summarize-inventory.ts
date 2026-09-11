import path from "node:path";
import { isNull, sql } from "drizzle-orm";
import {
  closeDatabase,
  db,
  initDatabase,
  inventoryItemsTable,
  inventoryMovementsTable,
} from "@workspace/db";

async function main() {
  process.chdir(path.resolve("d:/gia-shawarma-manager-self-host"));
  process.env.DATABASE_URL ??= "pglite://.data/gia-shawarma";
  await initDatabase();
  const active = await db.query.inventoryItemsTable.findMany({
    where: isNull(inventoryItemsTable.archivedAt),
  });
  const byCat: Record<string, number> = {};
  for (const i of active) byCat[i.category] = (byCat[i.category] || 0) + 1;
  const [{ movements }] = await db.select({ movements: sql<number>`count(*)` }).from(inventoryMovementsTable);
  const kitchen = active.filter((i) => Number(i.kitchenStock) > 0);
  console.log(
    JSON.stringify(
      {
        active: active.length,
        movements,
        categories: byCat,
        kitchenItems: kitchen.length,
        kitchenSample: kitchen.slice(0, 12).map((i) => ({
          name: i.name,
          wh: i.currentStock,
          k: i.kitchenStock,
        })),
        toolsSample: active
          .filter((i) => i.category === "أدوات المطبخ")
          .slice(0, 5)
          .map((i) => ({ name: i.name, wh: i.currentStock, unit: i.unit })),
      },
      null,
      2,
    ),
  );
  await closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
