import { Router, type IRouter } from "express";
import { getDatabaseRuntimeInfo } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const dbInfo = getDatabaseRuntimeInfo();
  res.json({
    status: "ok",
    database: dbInfo
      ? {
          mode: dbInfo.mode === "pglite" && dbInfo.kind === "v3-production"
            ? "V3"
            : dbInfo.mode === "pglite" && dbInfo.kind === "v3-test"
              ? "V3-TEST"
              : dbInfo.mode === "postgresql"
                ? "POSTGRESQL"
                : dbInfo.kind,
          kind: dbInfo.kind,
          absolutePath: dbInfo.absolutePath,
        }
      : null,
  });
});

export default router;
