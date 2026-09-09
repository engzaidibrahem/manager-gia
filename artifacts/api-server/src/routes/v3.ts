import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  createItem,
  getItemByQr,
  listItemsBrief,
  listKitchenStock,
  listMovements,
  listWarehouseSummary,
  postOpeningBalance,
  postWarehouseIn,
  postWarehouseToKitchen,
  updateItemMinimum,
} from "../v3/warehouseService";
import { AppError } from "../lib/errors";

const router: IRouter = Router();

function actorOf(req: Request) {
  return (req as Request & { user?: { fullName?: string; username?: string; id?: number } }).user?.fullName
    || (req as Request & { user?: { username?: string } }).user?.username
    || "user";
}

function userIdOf(req: Request) {
  return (req as Request & { user?: { id?: number } }).user?.id ?? null;
}

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

router.get(
  "/warehouse/summary",
  asyncHandler(async (req, res) => {
    const data = await listWarehouseSummary({
      q: String(req.query.q || ""),
      category: String(req.query.category || ""),
      status: (String(req.query.status || "all") as "all" | "available" | "low" | "out" | "unknown"),
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 50),
    });
    res.json(data);
  }),
);

router.get(
  "/warehouse/items",
  asyncHandler(async (req, res) => {
    const rows = await listItemsBrief(String(req.query.q || ""));
    res.json({ rows });
  }),
);

router.post(
  "/warehouse/items",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        category: z.string().optional(),
        baseUnit: z.string().optional(),
        minimumStock: z.number().nullable().optional(),
      })
      .parse(req.body);
    const row = await createItem(body);
    res.status(201).json(row);
  }),
);

router.patch(
  "/warehouse/items/:id/minimum",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z.object({ minimumStock: z.number().nullable() }).parse(req.body);
    const row = await updateItemMinimum(id, body.minimumStock);
    res.json(row);
  }),
);

router.get(
  "/warehouse/movements",
  asyncHandler(async (req, res) => {
    const type = req.query.type ? String(req.query.type) : undefined;
    const data = await listMovements({
      movementType: type as "OPENING" | "WAREHOUSE_IN" | "WAREHOUSE_TO_KITCHEN" | "ADJUSTMENT" | undefined,
      inventoryItemId: req.query.itemId ? Number(req.query.itemId) : undefined,
      fromDate: req.query.from ? String(req.query.from) : undefined,
      toDate: req.query.to ? String(req.query.to) : undefined,
      q: String(req.query.q || ""),
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 50),
    });
    res.json(data);
  }),
);

router.post(
  "/warehouse/opening",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        inventoryItemId: z.number().int().positive().optional(),
        name: z.string().optional(),
        category: z.string().optional(),
        baseUnit: z.string().optional(),
        balanceDate: z.string().optional(),
        quantityNumeric: z.number().nullable().optional(),
        quantityRaw: z.string().min(1),
        unitRaw: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postOpeningBalance({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/warehouse/in",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        inventoryItemId: z.number().int().positive(),
        movementDate: z.string().optional(),
        quantityNumeric: z.number().nullable().optional(),
        quantityRaw: z.string().min(1),
        unitRaw: z.string().optional(),
        supplier: z.string().optional(),
        receiver: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postWarehouseIn({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/warehouse/to-kitchen",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        inventoryItemId: z.number().int().positive(),
        movementDate: z.string().optional(),
        quantityNumeric: z.number().nullable().optional(),
        quantityRaw: z.string().min(1),
        unitRaw: z.string().optional(),
        receiver: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postWarehouseToKitchen({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.get(
  "/kitchen",
  asyncHandler(async (_req, res) => {
    const rows = await listKitchenStock();
    res.json({ rows });
  }),
);

/** Mobile-ready endpoints (no QR UI in V3 phase 1). */
router.get(
  "/items/by-qr/:token",
  asyncHandler(async (req, res) => {
    const item = await getItemByQr(String(req.params.token));
    res.json(item);
  }),
);

router.get(
  "/items/:id/balance",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const summary = await listWarehouseSummary({ page: 1, pageSize: 500 });
    const row = summary.rows.find((r) => r.id === id);
    if (!row) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
    res.json(row);
  }),
);

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL", message: "خطأ داخلي" });
});

export default router;
