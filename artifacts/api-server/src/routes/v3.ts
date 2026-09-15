import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  createItem,
  ensureItemQrToken,
  ensureMissingQrTokens,
  getItemByQr,
  getWarehouseItemDetail,
  listItemsBrief,
  listKitchenStock,
  listMovements,
  listProducts,
  getProduct,
  listStockAlerts,
  listWarehouseSummary,
  mapStatusQuery,
  postAdjustment,
  postOpeningBalance,
  postWarehouseIn,
  postWarehouseOut,
  postWarehouseToKitchen,
  updateItemMinimum,
  updateProduct,
} from "../v3/warehouseService";
import {
  addProductDuringStocktake,
  cancelStocktake,
  completeStocktake,
  getStocktake,
  getStocktakeProgress,
  listStocktakes,
  saveStocktakeDraft,
  startStocktake,
  upsertStocktakeLine,
} from "../v3/stocktakeService";
import { type Role } from "../auth/roles";
import { requireRole } from "../auth/middleware";
import {
  addPurchasePayment,
  createPurchase,
  listPurchasePayments,
  listPurchases,
  updatePurchase,
  voidPurchase,
} from "../v3/purchaseService";
import { confirmPurchaseImport, validateImportPayload } from "../v3/purchaseImportService";
import {
  getFinanceSummary,
  listCapital,
  listExpenses,
  listIncome,
  postCapital,
  postExpense,
  postIncome,
  voidCapital,
  voidExpense,
  voidIncome,
} from "../v3/financeService";
import {
  addSalaryPayment,
  attendanceSummary,
  createEmployee,
  createOrUpdatePayroll,
  endEmployment,
  getEmployee,
  listAttendance,
  listEmployees,
  listPayroll,
  listSalaryPayments,
  updateEmployee,
  upsertAttendance,
  voidSalaryPayment,
} from "../v3/employeeService";
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

function roleOf(req: Request): Role | null {
  return ((req as Request & { user?: { role?: Role } }).user?.role as Role) || null;
}

function sourceChannelOf(req: Request, fallback = "WEB_ADMIN") {
  const body = (req.body || {}) as { sourceChannel?: string };
  const header = String(req.headers["x-gia-source"] || "").trim();
  return (body.sourceChannel || header || fallback).trim();
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
      status: mapStatusQuery(String(req.query.status || "all")),
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
    const mine = String(req.query.mine || "") === "1";
    const data = await listMovements({
      movementType: type as
        | "OPENING"
        | "WAREHOUSE_IN"
        | "WAREHOUSE_OUT"
        | "WAREHOUSE_TO_KITCHEN"
        | "ADJUSTMENT"
        | undefined,
      inventoryItemId: req.query.itemId ? Number(req.query.itemId) : undefined,
      fromDate: req.query.from ? String(req.query.from) : undefined,
      toDate: req.query.to ? String(req.query.to) : undefined,
      q: String(req.query.q || ""),
      userId: mine ? userIdOf(req) ?? undefined : req.query.userId ? Number(req.query.userId) : undefined,
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
      sourceChannel: sourceChannelOf(req),
      actorRole: roleOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/warehouse/out",
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
        sourceChannel: z.string().optional(),
      })
      .parse(req.body);
    const result = await postWarehouseOut({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
      sourceChannel: sourceChannelOf(req, body.sourceChannel || "WEB_ADMIN"),
      actorRole: roleOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/warehouse/adjust",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        inventoryItemId: z.number().int().positive(),
        quantityNumeric: z.number(),
        quantityRaw: z.string().optional(),
        unitRaw: z.string().optional(),
        notes: z.string().min(1),
        movementDate: z.string().optional(),
        clientRequestId: z.string().optional(),
        sourceChannel: z.string().optional(),
      })
      .parse(req.body);
    const result = await postAdjustment({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
      sourceChannel: sourceChannelOf(req, body.sourceChannel || "WEB_ADMIN"),
      actorRole: roleOf(req),
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
        sourceChannel: z.string().optional(),
      })
      .parse(req.body);
    const result = await postWarehouseToKitchen({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
      sourceChannel: sourceChannelOf(req, body.sourceChannel || "WEB_ADMIN"),
      actorRole: roleOf(req),
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
    const detail = await getWarehouseItemDetail(id);
    res.json(detail);
  }),
);

router.get(
  "/warehouse/items/:id",
  asyncHandler(async (req, res) => {
    const detail = await getWarehouseItemDetail(Number(req.params.id));
    res.json(detail);
  }),
);

// ---- Products / QR / Alerts (Phase 9) ----
router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const data = await listProducts({
      q: String(req.query.q || ""),
      active: (String(req.query.active || "all") as "all" | "active" | "inactive"),
      qr: (String(req.query.qr || "all") as "all" | "with" | "missing"),
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 50),
      warehouseOnly: String(req.query.warehouseOnly || "") === "1",
    });
    res.json(data);
  }),
);

/** Reusable partial search for web admin + future mobile (inventory_item_id identity). */
router.get(
  "/products/search",
  asyncHandler(async (req, res) => {
    const data = await listProducts({
      q: String(req.query.q || ""),
      active: "active",
      page: Number(req.query.page || 1),
      pageSize: Math.min(50, Number(req.query.pageSize || 20)),
      warehouseOnly: true,
    });
    res.json({
      rows: data.rows.map((r) => ({
        id: r.id,
        name: r.name,
        baseUnit: r.baseUnit,
        warehouseQtyNumeric: r.warehouseQtyNumeric,
        minimumStock: r.minimumStock,
        stockStatus: r.stockStatus,
        hasQr: r.hasQr,
      })),
      total: data.total,
      page: data.page,
      pageSize: data.pageSize,
    });
  }),
);

router.post(
  "/products",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        category: z.string().optional(),
        baseUnit: z.string().optional(),
        minimumStock: z.number().nullable().optional(),
        shortCode: z.string().nullable().optional(),
      })
      .parse(req.body);
    const row = await createItem(body);
    if (body.shortCode) {
      await updateProduct(row.id, { shortCode: body.shortCode });
    }
    const ensured = await ensureItemQrToken(row.id);
    res.status(201).json(ensured.item);
  }),
);

router.patch(
  "/products/:id",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        category: z.string().optional(),
        baseUnit: z.string().optional(),
        minimumStock: z.number().nullable().optional(),
        shortCode: z.string().nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const row = await updateProduct(id, body);
    res.json(row);
  }),
);

router.post(
  "/products/:id/ensure-qr",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const result = await ensureItemQrToken(Number(req.params.id));
    res.json(result);
  }),
);

router.post(
  "/products/qr/generate-missing",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z.object({ itemIds: z.array(z.number().int().positive()).optional() }).parse(req.body || {});
    const result = await ensureMissingQrTokens(body.itemIds);
    res.json(result);
  }),
);

router.get(
  "/products/by-qr/:token",
  asyncHandler(async (req, res) => {
    const item = await getItemByQr(String(req.params.token));
    res.json(item);
  }),
);

router.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(404).json({ error: "NOT_FOUND", message: "المادة غير موجودة" });
      return;
    }
    res.json(await getProduct(id));
  }),
);

router.get(
  "/stock-alerts",
  asyncHandler(async (_req, res) => {
    res.json(await listStockAlerts());
  }),
);

router.get(
  "/stock-alerts/summary",
  asyncHandler(async (_req, res) => {
    const data = await listStockAlerts();
    res.json(data.summary);
  }),
);

// ---- Stocktake ----
router.get(
  "/stocktakes",
  asyncHandler(async (req, res) => {
    res.json(
      await listStocktakes({
        status: req.query.status ? String(req.query.status) : undefined,
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.pageSize || 20),
      }),
    );
  }),
);

router.post(
  "/stocktakes",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body || {});
    const result = await startStocktake({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.get(
  "/stocktakes/:id",
  asyncHandler(async (req, res) => {
    res.json(await getStocktake(Number(req.params.id)));
  }),
);

router.get(
  "/stocktakes/:id/progress",
  asyncHandler(async (req, res) => {
    res.json(await getStocktakeProgress(Number(req.params.id)));
  }),
);

router.post(
  "/stocktakes/:id/draft",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z.object({ notes: z.string().optional() }).parse(req.body || {});
    const row = await saveStocktakeDraft(Number(req.params.id), {
      notes: body.notes,
      actor: actorOf(req),
    });
    res.json(row);
  }),
);

router.put(
  "/stocktakes/:id/lines/:itemId",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        countedQuantity: z.number().nullable(),
        notes: z.string().optional(),
        minimumStock: z.number().nullable().optional(),
        baseUnit: z.string().optional(),
      })
      .parse(req.body);
    const line = await upsertStocktakeLine(Number(req.params.id), {
      inventoryItemId: Number(req.params.itemId),
      countedQuantity: body.countedQuantity,
      notes: body.notes,
      minimumStock: body.minimumStock,
      baseUnit: body.baseUnit,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.json(line);
  }),
);

router.post(
  "/stocktakes/:id/products",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        baseUnit: z.string().optional(),
        category: z.string().optional(),
        minimumStock: z.number().nullable().optional(),
        countedQuantity: z.number().nonnegative(),
      })
      .parse(req.body);
    const result = await addProductDuringStocktake(Number(req.params.id), {
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(201).json(result);
  }),
);

router.post(
  "/stocktakes/:id/complete",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const result = await completeStocktake(Number(req.params.id), {
      actor: actorOf(req),
      userId: userIdOf(req),
      actorRole: roleOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/stocktakes/:id/cancel",
  requireRole("owner", "manager"),
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().optional() }).parse(req.body || {});
    const result = await cancelStocktake(Number(req.params.id), {
      actor: actorOf(req),
      reason: body.reason,
    });
    res.json(result);
  }),
);

// ---- Purchases ----
router.get(
  "/purchases",
  asyncHandler(async (req, res) => {
    const data = await listPurchases({
      q: String(req.query.q || ""),
      fromDate: req.query.from ? String(req.query.from) : undefined,
      toDate: req.query.to ? String(req.query.to) : undefined,
      destination: req.query.destination ? String(req.query.destination) : undefined,
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.pageSize || 50),
    });
    res.json(data);
  }),
);

router.post(
  "/purchases/import/validate",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        workbookBase64: z.string().optional(),
        fileFingerprint: z.string().optional(),
        rows: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .parse(req.body);

    if (body.workbookBase64) {
      const data = await validateImportPayload({ workbookBase64: body.workbookBase64 });
      res.json(data);
      return;
    }

    // Accept already-shaped rows (tests / advanced clients) or raw Excel-like objects.
    if (body.rows?.length && "lineNo" in body.rows[0]!) {
      const data = await validateImportPayload({
        rows: body.rows as unknown as import("../v3/purchaseImportService").ParsedImportRow[],
        fileFingerprint: body.fileFingerprint,
      });
      res.json(data);
      return;
    }

    throw new AppError("VALIDATION_ERROR", "أرسل workbookBase64 أو صفوف مستوردة صالحة");
  }),
);

router.post(
  "/purchases/import/confirm",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fileFingerprint: z.string().min(1),
        invoicePayments: z.array(
          z.object({
            groupKey: z.string().min(1),
            paymentStatus: z.enum(["PAID", "UNPAID", "PARTIAL"]),
            paidAmount: z.number(),
          }),
        ),
        rows: z.array(
          z.object({
            lineNo: z.number().int().positive(),
            purchaseDate: z.string().min(1),
            purchaseTime: z.string().optional(),
            supplier: z.string().optional(),
            invoiceNumber: z.string().optional(),
            itemName: z.string().min(1),
            quantityNumeric: z.number().nullable().optional(),
            quantityRaw: z.string().optional(),
            unitRaw: z.string().optional(),
            unitPrice: z.number().optional(),
            totalAmount: z.number(),
            notes: z.string().optional(),
            sourceImageRef: z.string().optional(),
            destination: z.enum(["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"]),
            inventoryItemId: z.number().int().positive().nullable().optional(),
            newItem: z
              .object({
                name: z.string().min(1),
                category: z.string().optional(),
                baseUnit: z.string().optional(),
                minimumStock: z.number().nullable().optional(),
              })
              .nullable()
              .optional(),
          }),
        ),
      })
      .parse(req.body);

    const result = await confirmPurchaseImport({
      fileFingerprint: body.fileFingerprint,
      rows: body.rows,
      invoicePayments: body.invoicePayments,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.completeSuccess ? 201 : 400).json(result);
  }),
);

router.post(
  "/purchases",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        purchaseDate: z.string().optional(),
        purchaseTime: z.string().optional(),
        itemName: z.string().min(1),
        inventoryItemId: z.number().int().positive().nullable().optional(),
        newItem: z
          .object({
            name: z.string().min(1),
            category: z.string().optional(),
            baseUnit: z.string().optional(),
            minimumStock: z.number().nullable().optional(),
          })
          .nullable()
          .optional(),
        quantityNumeric: z.number().nullable().optional(),
        quantityRaw: z.string().optional(),
        unitRaw: z.string().optional(),
        unitPrice: z.number().optional(),
        totalAmount: z.number(),
        paidAmount: z.number().optional(),
        paymentStatus: z.enum(["PAID", "UNPAID", "PARTIAL"]).optional(),
        supplier: z.string().optional(),
        invoiceNumber: z.string().optional(),
        purchasedBy: z.string().optional(),
        destination: z.enum(["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"]),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await createPurchase({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.patch(
  "/purchases/:id",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        purchaseDate: z.string().optional(),
        purchaseTime: z.string().optional(),
        itemName: z.string().min(1).optional(),
        inventoryItemId: z.number().int().positive().nullable().optional(),
        newItem: z
          .object({
            name: z.string().min(1),
            category: z.string().optional(),
            baseUnit: z.string().optional(),
            minimumStock: z.number().nullable().optional(),
          })
          .nullable()
          .optional(),
        quantityNumeric: z.number().nullable().optional(),
        quantityRaw: z.string().optional(),
        unitRaw: z.string().optional(),
        unitPrice: z.number().optional(),
        totalAmount: z.number().optional(),
        supplier: z.string().optional(),
        purchasedBy: z.string().optional(),
        destination: z.enum(["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"]).optional(),
        notes: z.string().nullable().optional(),
      })
      .parse(req.body);
    const result = await updatePurchase({
      purchaseId: Number(req.params.id),
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.json(result);
  }),
);

router.post(
  "/purchases/:id/payments",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        paymentDate: z.string().optional(),
        paymentMethod: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await addPurchasePayment({
      purchaseId: Number(req.params.id),
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.get(
  "/purchases/:id/payments",
  asyncHandler(async (req, res) => {
    const data = await listPurchasePayments(Number(req.params.id));
    res.json(data);
  }),
);

router.post(
  "/purchases/:id/void",
  asyncHandler(async (req, res) => {
    const body = z.object({ voidReason: z.string().min(1) }).parse(req.body);
    const result = await voidPurchase({
      purchaseId: Number(req.params.id),
      voidedBy: actorOf(req),
      voidReason: body.voidReason,
    });
    res.json(result);
  }),
);

// ---- Finance ----
router.get(
  "/finance/summary",
  asyncHandler(async (_req, res) => {
    res.json(await getFinanceSummary());
  }),
);

router.get(
  "/finance/capital",
  asyncHandler(async (_req, res) => {
    res.json(await listCapital());
  }),
);

router.post(
  "/finance/capital",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        entryDate: z.string().optional(),
        entryType: z.enum(["ADD", "WITHDRAW", "CORRECTION"]),
        amount: z.number().positive(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postCapital({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/finance/capital/:id/void",
  asyncHandler(async (req, res) => {
    const body = z.object({ voidReason: z.string().min(1) }).parse(req.body);
    const result = await voidCapital({
      id: Number(req.params.id),
      voidedBy: actorOf(req),
      voidReason: body.voidReason,
    });
    res.json(result);
  }),
);

router.get(
  "/finance/income",
  asyncHandler(async (_req, res) => {
    res.json(await listIncome());
  }),
);

router.post(
  "/finance/income",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        incomeDate: z.string().optional(),
        description: z.string().min(1),
        amount: z.number().positive(),
        receivedBy: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postIncome({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/finance/income/:id/void",
  asyncHandler(async (req, res) => {
    const body = z.object({ voidReason: z.string().min(1) }).parse(req.body);
    res.json(
      await voidIncome({ id: Number(req.params.id), voidedBy: actorOf(req), voidReason: body.voidReason }),
    );
  }),
);

router.get(
  "/finance/expenses",
  asyncHandler(async (_req, res) => {
    res.json(await listExpenses());
  }),
);

router.post(
  "/finance/expenses",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        expenseDate: z.string().optional(),
        category: z.string().optional(),
        description: z.string().min(1),
        amount: z.number().positive(),
        paidBy: z.string().optional(),
        notes: z.string().optional(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await postExpense({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/finance/expenses/:id/void",
  asyncHandler(async (req, res) => {
    const body = z.object({ voidReason: z.string().min(1) }).parse(req.body);
    res.json(
      await voidExpense({ id: Number(req.params.id), voidedBy: actorOf(req), voidReason: body.voidReason }),
    );
  }),
);

// ---- Employees ----
router.get(
  "/employees",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : "all";
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 50);
    res.json(
      await listEmployees({
        q,
        status: status === "active" || status === "ended" ? status : "all",
        page,
        pageSize,
      }),
    );
  }),
);

router.post(
  "/employees",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fullName: z.string().min(1),
        phone: z.string().optional().nullable(),
        secondaryPhone: z.string().optional().nullable(),
        jobTitle: z.string().optional(),
        salaryAmount: z.number().nonnegative(),
        salaryType: z.enum(["MONTHLY", "DAILY"]),
        workStartDate: z.string().optional(),
        expectedDailyHours: z.number().nullable().optional(),
        notes: z.string().optional().nullable(),
      })
      .parse(req.body);
    const row = await createEmployee(body);
    res.status(201).json({ employee: row });
  }),
);

router.get(
  "/employees/:id",
  asyncHandler(async (req, res) => {
    res.json({ employee: await getEmployee(Number(req.params.id)) });
  }),
);

router.patch(
  "/employees/:id",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        fullName: z.string().optional(),
        phone: z.string().optional().nullable(),
        secondaryPhone: z.string().optional().nullable(),
        jobTitle: z.string().optional(),
        salaryAmount: z.number().nonnegative().optional(),
        salaryType: z.enum(["MONTHLY", "DAILY"]).optional(),
        workStartDate: z.string().optional(),
        expectedDailyHours: z.number().nullable().optional(),
        notes: z.string().optional().nullable(),
      })
      .parse(req.body);
    res.json({ employee: await updateEmployee(Number(req.params.id), body) });
  }),
);

router.post(
  "/employees/:id/end",
  asyncHandler(async (req, res) => {
    const body = z.object({ workEndDate: z.string().optional() }).parse(req.body ?? {});
    res.json({ employee: await endEmployment(Number(req.params.id), body.workEndDate) });
  }),
);

router.get(
  "/employees/:id/attendance-summary",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    res.json(await attendanceSummary(Number(req.params.id), year, month));
  }),
);

// ---- Attendance ----
router.get(
  "/attendance",
  asyncHandler(async (req, res) => {
    res.json(
      await listAttendance({
        employeeId: req.query.employeeId ? Number(req.query.employeeId) : undefined,
        from: typeof req.query.from === "string" ? req.query.from : undefined,
        to: typeof req.query.to === "string" ? req.query.to : undefined,
        status: typeof req.query.status === "string" ? req.query.status : undefined,
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.pageSize || 50),
      }),
    );
  }),
);

router.post(
  "/attendance",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        employeeId: z.number().int().positive(),
        attendanceDate: z.string().min(8),
        status: z.enum(["PRESENT", "ABSENT", "LEAVE"]),
        checkInTime: z.string().optional().nullable(),
        checkOutTime: z.string().optional().nullable(),
        workedHours: z.number().nullable().optional(),
        notes: z.string().optional().nullable(),
      })
      .parse(req.body);
    const result = await upsertAttendance({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.created ? 201 : 200).json(result);
  }),
);

// ---- Payroll ----
router.get(
  "/payroll",
  asyncHandler(async (req, res) => {
    res.json(
      await listPayroll({
        employeeId: req.query.employeeId ? Number(req.query.employeeId) : undefined,
        year: req.query.year ? Number(req.query.year) : undefined,
        month: req.query.month ? Number(req.query.month) : undefined,
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.pageSize || 50),
      }),
    );
  }),
);

router.post(
  "/payroll",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        employeeId: z.number().int().positive(),
        year: z.number().int(),
        month: z.number().int().min(1).max(12),
        baseSalary: z.number().nonnegative().optional(),
        manualDeduction: z.number().nonnegative().optional(),
        manualBonus: z.number().nonnegative().optional(),
        confirmedNetSalary: z.number().nonnegative().optional(),
        notes: z.string().optional().nullable(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await createOrUpdatePayroll({
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.get(
  "/payroll/:id/payments",
  asyncHandler(async (req, res) => {
    res.json(await listSalaryPayments(Number(req.params.id)));
  }),
);

router.post(
  "/payroll/:id/payments",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        amount: z.number().positive(),
        paymentDate: z.string().optional(),
        paidBy: z.string().optional(),
        notes: z.string().optional().nullable(),
        clientRequestId: z.string().optional(),
      })
      .parse(req.body);
    const result = await addSalaryPayment({
      payrollId: Number(req.params.id),
      ...body,
      actor: actorOf(req),
      userId: userIdOf(req),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }),
);

router.post(
  "/salary-payments/:id/void",
  asyncHandler(async (req, res) => {
    const body = z.object({ voidReason: z.string().min(1) }).parse(req.body);
    res.json(
      await voidSalaryPayment({
        paymentId: Number(req.params.id),
        voidedBy: actorOf(req),
        voidReason: body.voidReason,
      }),
    );
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
