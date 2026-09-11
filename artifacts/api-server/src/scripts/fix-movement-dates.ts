import path from "node:path";
import { eq } from "drizzle-orm";
import { closeDatabase, db, initDatabase, inventoryMovementsTable } from "@workspace/db";

function businessDateFromNote(note: string | null): Date | null {
  if (!note) return null;
  const m = note.match(/(?:خارج|وارد)\s+(\d{4}-\d{2}-\d{2})/);
  if (m) return new Date(`${m[1]}T12:00:00.000Z`);
  if (note.includes("رصيد بداية الجرد 26/08/2026") || note.includes("رصيد بداية الجرد 2026-08-26")) {
    return new Date("2026-08-26T12:00:00.000Z");
  }
  if (note.includes("إجمالي المدخل حسب ورقة المستودع") || note.includes("تعويض رصيد قبل")) {
    return new Date("2026-08-26T12:00:00.000Z");
  }
  if (note.includes("إجمالي الخارج حسب ورقة المستودع")) {
    return new Date("2026-08-28T12:00:00.000Z");
  }
  return null;
}

async function main() {
  process.chdir(path.resolve("d:/gia-shawarma-manager-self-host"));
  process.env.DATABASE_URL ??= "pglite://d:/gia-shawarma-manager-self-host/.data/gia-shawarma";
  await initDatabase();
  const rows = await db.select().from(inventoryMovementsTable);
  let fixed = 0;
  for (const r of rows) {
    const d = businessDateFromNote(r.note);
    if (!d) continue;
    await db.update(inventoryMovementsTable).set({ createdAt: d }).where(eq(inventoryMovementsTable.id, r.id));
    fixed++;
  }
  console.log(JSON.stringify({ total: rows.length, fixed }));
  await closeDatabase();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
