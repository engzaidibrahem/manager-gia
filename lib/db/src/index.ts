import { mkdirSync } from "node:fs";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as schema from "./schema";
import { bootstrapSchema, resolvePgliteDataDir } from "./bootstrap";

const { Pool } = pg;

type AppDatabase = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const databaseUrl = process.env.DATABASE_URL;
const usePglite = databaseUrl.startsWith("pglite:") || databaseUrl.startsWith("file:");

export let db!: AppDatabase;
export let pool: pg.Pool | null = null;
export let pgliteClient: PGlite | null = null;

export async function initDatabase(): Promise<AppDatabase> {
  if (db) return db;

  if (usePglite) {
    const dataDir = resolvePgliteDataDir(databaseUrl);
    mkdirSync(dataDir, { recursive: true });
    pgliteClient = new PGlite(dataDir);
    db = drizzlePglite(pgliteClient, { schema });
  } else {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzleNodePg(pool, { schema });
  }

  await bootstrapSchema(db);
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  db = undefined as unknown as AppDatabase;
}

export * from "./schema";
