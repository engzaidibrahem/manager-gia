/**
 * Launch Gia V3 API with the canonical absolute production DB path.
 * Works regardless of process.cwd() / pnpm --filter package directory.
 * Forwards SIGINT/SIGTERM so the child can close PGlite cleanly.
 *
 * Production always uses PORT 5000 — never inherits stale test PORT=5001.
 * Clears V3_TEST_MODE so production cannot open under test isolation rules.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbAbs = path.resolve(root, ".data", "gia-v3");
const dbUrl = `pglite://${dbAbs.replace(/\\/g, "/")}`;

const mode = process.argv[2] || "start"; // start | build-start

const env = {
  ...process.env,
  DATABASE_URL: dbUrl,
  // Force production port — do not inherit stale PORT=5001 from test shells
  PORT: "5000",
  AUTH_SECRET: process.env.AUTH_SECRET || "gia-dev-secret",
  // Never start production API in test isolation mode
  V3_TEST_MODE: "false",
  NODE_ENV: process.env.NODE_ENV === "test" ? "development" : process.env.NODE_ENV,
};

console.log("GIA V3 DATABASE (launcher):");
console.log(dbAbs);
console.log("DATABASE_URL=", dbUrl);
console.log("PORT=", env.PORT, "(forced production)");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm.cmd", args, {
      cwd: root,
      env,
      stdio: "inherit",
      shell: true,
      windowsHide: true,
    });

    const forward = (signal) => {
      try {
        if (child.pid) {
          child.kill(signal);
        }
      } catch {
        /* ignore */
      }
    };
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));

    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") resolve(undefined);
      else reject(new Error(`pnpm ${args.join(" ")} exited ${code}`));
    });
  });
}

if (mode === "build-start") {
  await run(["--filter", "@workspace/api-server", "run", "build"]);
  await run(["--filter", "@workspace/api-server", "run", "start"]);
} else if (mode === "start") {
  await run(["--filter", "@workspace/api-server", "run", "start"]);
} else if (mode === "print") {
  process.exit(0);
} else {
  console.error("Usage: node scripts/start-v3-api.mjs [build-start|start|print]");
  process.exit(1);
}
