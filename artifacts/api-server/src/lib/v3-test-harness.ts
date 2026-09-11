/**
 * Shared V3 test bootstrap — always forces gia-v3-test. Never opens production.
 */
import fs from "node:fs";
import path from "node:path";
import {
  canonicalV3TestDatabaseUrl,
  canonicalV3TestDir,
  findProjectRoot,
  getDatabaseRuntimeInfo,
} from "@workspace/db";

export function installV3TestEnv(): { root: string; testDir: string; databaseUrl: string } {
  const root = findProjectRoot();
  const testDir = canonicalV3TestDir(root);
  const databaseUrl = canonicalV3TestDatabaseUrl(root);
  process.env.V3_TEST_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.PORT = "5001";
  process.env.DATABASE_URL = databaseUrl;
  return { root, testDir, databaseUrl };
}

export async function openFreshV3TestDatabase(
  dbMod: typeof import("@workspace/db"),
): Promise<{ root: string; testDir: string; databaseUrl: string }> {
  const installed = installV3TestEnv();
  try {
    await dbMod.closeDatabase();
  } catch {
    /* */
  }
  for (let i = 0; i < 5; i++) {
    try {
      if (fs.existsSync(installed.testDir)) {
        fs.rmSync(installed.testDir, { recursive: true, force: true });
      }
      break;
    } catch (err) {
      if (i === 4) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  await dbMod.initDatabase();
  const info = getDatabaseRuntimeInfo();
  if (info?.kind !== "v3-test") {
    throw new Error(`Expected v3-test runtime, got ${JSON.stringify(info)}`);
  }
  if (path.resolve(info.absolutePath || "") !== path.resolve(installed.testDir)) {
    throw new Error(`Test DB path mismatch: ${info.absolutePath}`);
  }
  return installed;
}

export function writeIsolationGuard(guardPath: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(guardPath), { recursive: true });
  fs.writeFileSync(
    guardPath,
    JSON.stringify(
      {
        isolation: "V3_TEST_MODE — production DB never opened by this suite",
        databaseUrl: process.env.DATABASE_URL,
        runtime: getDatabaseRuntimeInfo(),
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
}
