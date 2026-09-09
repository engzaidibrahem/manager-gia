import { initDatabase } from "@workspace/db";
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

const { seedDefaultAdmin } = await import("./auth/seed");
await seedDefaultAdmin();

const { default: app } = await import("./app");

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, database: process.env.DATABASE_URL?.startsWith("pglite:") ? "pglite (embedded)" : "postgresql" }, "Server listening");
});
