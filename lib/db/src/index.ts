import { mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as schema from "./schema/index";
import {
  assertV3DatabaseAccessPolicy,
  bootstrapSchema,
  canonicalV3ProductionDir,
  canonicalV3TestDir,
  detectV3DbAccessMode,
  resolvePgliteDataDir,
  setDatabaseRuntimeInfo,
  type DatabaseRuntimeInfo,
} from "./bootstrap";

const { Pool } = pg;

type AppDatabase = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export let db!: AppDatabase;
export let pool: pg.Pool | null = null;
export let pgliteClient: PGlite | null = null;

function classifyPgliteDir(dataDir: string): DatabaseRuntimeInfo["kind"] {
  const n = path.resolve(dataDir).replace(/\\/g, "/").toLowerCase();
  if (n === canonicalV3ProductionDir().replace(/\\/g, "/").toLowerCase()) return "v3-production";
  if (n === canonicalV3TestDir().replace(/\\/g, "/").toLowerCase()) return "v3-test";
  return "legacy-or-other";
}

/** Read URL at init time (not module load) so tests can force gia-v3-test safely. */
export async function initDatabase(): Promise<AppDatabase> {
  if (db) return db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set. Did you forget to provision a database?");
  }

  const usePglite = databaseUrl.startsWith("pglite:") || databaseUrl.startsWith("file:");

  if (usePglite) {
    const dataDir = resolvePgliteDataDir(databaseUrl);
    // Extra belt: never allow test URL onto production path
    if (databaseUrl.includes("gia-v3-test")) {
      const norm = dataDir.replace(/\\/g, "/").toLowerCase();
      const prod = canonicalV3ProductionDir().replace(/\\/g, "/").toLowerCase();
      if (norm === prod || (!norm.endsWith("/gia-v3-test") && !norm.endsWith("gia-v3-test"))) {
        throw new Error(`Refusing init: test URL resolved to ${dataDir}`);
      }
    }

    // Hard failsafe: test processes cannot open production (or any non-test path).
    // Runtime processes cannot open gia-v3-test without V3_TEST_MODE.
    assertV3DatabaseAccessPolicy(dataDir, databaseUrl, detectV3DbAccessMode());

    setDatabaseRuntimeInfo({
      mode: "pglite",
      kind: classifyPgliteDir(dataDir),
      absolutePath: dataDir,
      databaseUrlRedacted: databaseUrl.replace(/\/\/.*@/, "//***@"),
    });

    // eslint-disable-next-line no-console
    console.log(`\nGIA V3 DATABASE:\n${dataDir}\n`);

    mkdirSync(dataDir, { recursive: true });
    pgliteClient = new PGlite(dataDir);
    db = drizzlePglite(pgliteClient, { schema });
  } else {
    setDatabaseRuntimeInfo({
      mode: "postgresql",
      kind: "postgresql",
      absolutePath: null,
      databaseUrlRedacted: databaseUrl.replace(/\/\/.*@/, "//***@"),
    });
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
export {
  findProjectRoot,
  canonicalV3ProductionDir,
  canonicalV3TestDir,
  canonicalV3TestDatabaseUrl,
  canonicalV3ProductionDatabaseUrl,
  resolvePgliteDataDir,
  assertSafePgliteDataDir,
  assertV3DatabaseAccessPolicy,
  detectV3DbAccessMode,
  isNodeTestRunnerProcess,
  getDatabaseRuntimeInfo,
  normalizeFsPath,
} from "./bootstrap";
