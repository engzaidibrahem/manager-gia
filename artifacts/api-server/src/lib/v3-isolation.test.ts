/**
 * Hard test/production DB isolation — must never open gia-v3 from test processes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertV3DatabaseAccessPolicy,
  canonicalV3ProductionDatabaseUrl,
  canonicalV3ProductionDir,
  canonicalV3TestDatabaseUrl,
  canonicalV3TestDir,
  detectV3DbAccessMode,
  findProjectRoot,
  getDatabaseRuntimeInfo,
  normalizeFsPath,
} from "@workspace/db";
import { installV3TestEnv, openFreshV3TestDatabase } from "./v3-test-harness";

const ROOT = findProjectRoot();
const PROD = canonicalV3ProductionDir(ROOT);
const TEST = canonicalV3TestDir(ROOT);

describe("V3 hard DB isolation", () => {
  let dbMod: typeof import("@workspace/db");

  before(async () => {
    process.chdir(ROOT);
    installV3TestEnv();
    dbMod = await import("@workspace/db");
    try {
      await dbMod.closeDatabase();
    } catch {
      /* */
    }
  });

  after(async () => {
    installV3TestEnv();
    try {
      await dbMod.closeDatabase();
    } catch {
      /* */
    }
  });

  it("A) test mode + production path => startup FAILS", async () => {
    installV3TestEnv();
    process.env.DATABASE_URL = canonicalV3ProductionDatabaseUrl(ROOT);
    assert.equal(detectV3DbAccessMode(), "test");
    await assert.rejects(
      () => dbMod.initDatabase(),
      /FATAL V3 TEST ISOLATION|refusing to open a non-test/i,
    );
    assert.equal(dbMod.pgliteClient, null);
  });

  it("B) test mode + gia-v3-test => startup succeeds", async () => {
    const opened = await openFreshV3TestDatabase(dbMod);
    assert.equal(normalizeFsPath(opened.testDir), normalizeFsPath(TEST));
    assert.equal(getDatabaseRuntimeInfo()?.kind, "v3-test");
    assert.equal(normalizeFsPath(getDatabaseRuntimeInfo()!.absolutePath!), normalizeFsPath(TEST));
    await dbMod.closeDatabase();
  });

  it("C) production/runtime mode + gia-v3 => policy allows (no open)", () => {
    assert.doesNotThrow(() =>
      assertV3DatabaseAccessPolicy(PROD, canonicalV3ProductionDatabaseUrl(ROOT), "runtime"),
    );
  });

  it("D) production/runtime mode + gia-v3-test => rejected", () => {
    assert.throws(
      () => assertV3DatabaseAccessPolicy(TEST, canonicalV3TestDatabaseUrl(ROOT), "runtime"),
      /FATAL V3 ISOLATION|refusing to open the V3 test database/i,
    );
  });

  it("E) child process from test:v3 still resolves only gia-v3-test", async () => {
    const script = `
import {
  assertV3DatabaseAccessPolicy,
  canonicalV3TestDir,
  detectV3DbAccessMode,
  normalizeFsPath,
  resolvePgliteDataDir,
} from "@workspace/db";

const mode = detectV3DbAccessMode();
if (mode !== "test") throw new Error("expected test mode, got " + mode);
const dir = resolvePgliteDataDir(process.env.DATABASE_URL);
assertV3DatabaseAccessPolicy(dir, process.env.DATABASE_URL, mode);
if (normalizeFsPath(dir) !== normalizeFsPath(canonicalV3TestDir())) {
  throw new Error("child resolved wrong dir: " + dir);
}
console.log("CHILD_OK");
`;
    const result = await runTsxEval(script, {
      V3_TEST_MODE: "true",
      NODE_ENV: "test",
      PORT: "5001",
      DATABASE_URL: canonicalV3TestDatabaseUrl(ROOT),
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /CHILD_OK/);
  });

  it("F) stale shell DATABASE_URL pointing to production cannot override test isolation", async () => {
    installV3TestEnv();
    // Simulate stale production URL leaking from shell while test flags are set
    process.env.DATABASE_URL = "pglite://.data/gia-v3";
    process.env.V3_TEST_MODE = "true";
    await assert.rejects(
      () => dbMod.initDatabase(),
      /FATAL V3 TEST ISOLATION|Stale shell DATABASE_URL/i,
    );
    // Relative prod URL also blocked
    process.env.DATABASE_URL = canonicalV3ProductionDatabaseUrl(ROOT);
    await assert.rejects(() => dbMod.initDatabase(), /FATAL V3 TEST ISOLATION/i);
  });
});

function runTsxEval(
  source: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = path.join(ROOT, "artifacts", "api-server", "src", "lib");
  const file = path.join(dir, `_isolation-child-${Date.now()}.mts`);
  fs.writeFileSync(file, source, "utf8");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", file],
      {
        cwd: path.join(ROOT, "artifacts", "api-server"),
        env: { ...process.env, ...env },
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("exit", (code) => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* */
      }
      resolve({ code, stdout, stderr });
    });
  });
}
