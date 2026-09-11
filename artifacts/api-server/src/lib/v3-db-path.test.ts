/**
 * Path resolver safety — must never open artifacts/api-server/.data/gia-v3.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertSafePgliteDataDir,
  canonicalV3ProductionDir,
  canonicalV3TestDir,
  findProjectRoot,
  resolvePgliteDataDir,
} from "@workspace/db";

describe("V3 PGlite path resolver", () => {
  it("finds project root and canonical dirs", () => {
    const root = findProjectRoot();
    assert.ok(root.toLowerCase().replace(/\\/g, "/").endsWith("gia-shawarma-manager-self-host"));
    assert.equal(
      path.resolve(canonicalV3ProductionDir()),
      path.resolve(root, ".data", "gia-v3"),
    );
    assert.equal(
      path.resolve(canonicalV3TestDir()),
      path.resolve(root, ".data", "gia-v3-test"),
    );
  });

  it("relative gia-v3 resolves to project-root .data, not cwd", () => {
    const prev = process.cwd();
    try {
      process.chdir(path.join(findProjectRoot(), "artifacts", "api-server"));
      const resolved = resolvePgliteDataDir("pglite://.data/gia-v3");
      assert.equal(path.resolve(resolved), path.resolve(canonicalV3ProductionDir()));
      assert.ok(!resolved.replace(/\\/g, "/").includes("artifacts/api-server/.data"));
    } finally {
      process.chdir(prev);
    }
  });

  it("relative gia-v3-test resolves to project-root test DB", () => {
    const prev = process.cwd();
    try {
      process.chdir(path.join(findProjectRoot(), "artifacts", "api-server"));
      const resolved = resolvePgliteDataDir("pglite://.data/gia-v3-test");
      assert.equal(path.resolve(resolved), path.resolve(canonicalV3TestDir()));
      assert.notEqual(path.resolve(resolved), path.resolve(canonicalV3ProductionDir()));
    } finally {
      process.chdir(prev);
    }
  });

  it("fails fast on artifacts/api-server clone path", () => {
    const bad = path.join(findProjectRoot(), "artifacts", "api-server", ".data", "gia-v3");
    assert.throws(
      () => assertSafePgliteDataDir(bad, "pglite://.data/gia-v3"),
      /REFUSING|artifacts[/\\]api-server/i,
    );
  });
});
