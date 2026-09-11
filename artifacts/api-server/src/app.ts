import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DestinationStream, Logger } from "pino";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAuth, requirePermission } from "./auth/middleware";

/**
 * pino-http ships CJS typings that break under TS "bundler" resolution on Vercel
 * (`import` / `import { pinoHttp }` → "not callable"). Load via createRequire instead.
 */
const require = createRequire(import.meta.url);
type PinoHttpFactory = (opts?: {
  logger?: Logger;
  serializers?: {
    req?: (req: IncomingMessage & { id?: unknown }) => unknown;
    res?: (res: ServerResponse) => unknown;
  };
}, stream?: DestinationStream) => (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;
const pinoHttp = require("pino-http") as PinoHttpFactory;

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: IncomingMessage & { id?: unknown }) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

function isPublicApi(req: Request): boolean {
  const full = (req.originalUrl || req.url || "").split("?")[0] || "";
  if (req.method === "OPTIONS") return true;
  if (full.endsWith("/healthz")) return true;
  if (full.endsWith("/auth/login")) return true;
  return false;
}

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (isPublicApi(req)) return next();
  return requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    return requirePermission(req, res, next);
  });
});

app.use("/api", router);

export default app;
