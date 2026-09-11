import { getDatabaseRuntimeInfo, initDatabase } from "@workspace/db";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await initDatabase();

const dbInfo = getDatabaseRuntimeInfo();
if (dbInfo?.absolutePath) {
  logger.info({ absolutePath: dbInfo.absolutePath, kind: dbInfo.kind }, "GIA V3 DATABASE");
  // eslint-disable-next-line no-console
  console.log(`\nGIA V3 DATABASE:\n${dbInfo.absolutePath}\n`);
}

const { seedDefaultAdmin } = await import("./auth/seed");
await seedDefaultAdmin();

const { default: app } = await import("./app");
const { closeDatabase } = await import("@workspace/db");

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info(
    {
      port,
      database: dbInfo?.mode === "pglite" ? "pglite (embedded)" : "postgresql",
      databaseKind: dbInfo?.kind,
      databasePath: dbInfo?.absolutePath,
    },
    "Server listening",
  );
});

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown starting — closing HTTP then database");
  // eslint-disable-next-line no-console
  console.log(`\nShutting down gracefully (${signal})…\n`);

  const forceTimer = setTimeout(() => {
    logger.error("Graceful shutdown timed out — exiting");
    process.exit(1);
  }, 15_000);
  forceTimer.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
    });
  } catch (err) {
    logger.warn({ err }, "HTTP server close error (continuing to close DB)");
  }

  try {
    await closeDatabase();
    logger.info("Database closed cleanly");
  } catch (err) {
    logger.error({ err }, "Database close failed");
    process.exit(1);
  }

  clearTimeout(forceTimer);
  process.exit(0);
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
