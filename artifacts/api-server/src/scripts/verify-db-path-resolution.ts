import path from "node:path";
import {
  assertSafePgliteDataDir,
  canonicalV3ProductionDir,
  canonicalV3TestDir,
  findProjectRoot,
  resolvePgliteDataDir,
} from "@workspace/db";

const root = findProjectRoot();
const canon = canonicalV3ProductionDir();
console.log("ROOT", root);
console.log("CANON", canon);

process.chdir(path.join(root, "artifacts", "api-server"));
console.log("CWD", process.cwd());
const a = resolvePgliteDataDir("pglite://.data/gia-v3");
console.log("FROM_API_PACKAGE_CWD", a);
console.log("MATCH", path.resolve(a) === path.resolve(canon));

process.chdir(root);
const b = resolvePgliteDataDir("pglite://.data/gia-v3");
console.log("FROM_ROOT_CWD", b);
console.log("MATCH2", path.resolve(b) === path.resolve(canon));

const absUrl = `pglite://${canon.replace(/\\/g, "/")}`;
const c = resolvePgliteDataDir(absUrl);
console.log("FROM_ABS_URL", c);
console.log("MATCH3", path.resolve(c) === path.resolve(canon));

const bad = path.join(root, "artifacts", "api-server", ".data", "gia-v3");
try {
  assertSafePgliteDataDir(bad, "pglite://.data/gia-v3");
  console.log("BAD_SHOULD_FAIL");
  process.exit(1);
} catch (e) {
  console.log("BAD_REJECTED_OK", String((e as Error).message).split("\n")[0]);
}

const test = resolvePgliteDataDir("pglite://.data/gia-v3-test");
console.log("TEST_DB", test);
console.log("TEST_MATCH", path.resolve(test) === path.resolve(canonicalV3TestDir()));
console.log("TEST_NOT_PROD", path.resolve(test) !== path.resolve(canon));
