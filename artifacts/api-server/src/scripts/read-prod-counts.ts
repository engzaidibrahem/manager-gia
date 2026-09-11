process.chdir("d:/gia-shawarma-manager-self-host");
process.env.DATABASE_URL = "pglite://.data/gia-v3";

async function main() {
  const dbMod = await import("@workspace/db");
  try {
    await dbMod.closeDatabase();
  } catch {
    /* */
  }
  await dbMod.initDatabase();
  const items = await dbMod.db.select().from(dbMod.v3InventoryItemsTable);
  const moves = await dbMod.db.select().from(dbMod.v3WarehouseMovementsTable);
  console.log(
    JSON.stringify(
      {
        db: "gia-v3",
        items: items.length,
        movements: moves.length,
      },
      null,
      2,
    ),
  );
  await dbMod.closeDatabase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
