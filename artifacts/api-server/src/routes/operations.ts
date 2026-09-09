import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  attendanceTable,
  dailyArchivesTable,
  dailyPurchasesTable,
  employeesTable,
  expensesTable,
  incomeTable,
  dailyCashBalancesTable,
  inventoryItemsTable,
  inventoryMovementsTable,
  menuRecipesTable,
  purchasePaymentsTable,
  recipeLinesTable,
  warehouseDayArchivesTable,
  warehouseLotsTable,
  wasteRecordsTable,
} from "@workspace/db";

import {
  assertRecipeLineCompatible,
  computeRecipeLineCost,
  computeRecipeTotals,
  convertToItemUnit,
} from "../lib/recipe-cost";
import { toErrorResponse, AppError } from "../lib/errors";
import { convertToBaseUnit } from "../lib/units";
import {
  reverseMovement,
} from "../services/inventoryService";
import { transferStock } from "../services/transferService";
import { receiveIntoWarehouse, receivePurchase } from "../services/receivingService";
import { upsertPurchases } from "../services/purchaseService";
import { getInventoryValue, getTodayPurchasesSummary } from "../services/financeQueryService";
import { backfillLegacyLots, getLotReconciliationReport } from "../services/lotReconciliation";

const router: IRouter = Router();
const iso = (value: Date) => value.toISOString();
const newQrToken = () => `gia-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

type Location = "warehouse" | "kitchen";

export { convertToItemUnit };

const inventoryRowSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  category: z.string().min(1),
  unit: z.string().min(1),
  brand: z.string().optional(),
  variant: z.string().optional(),
  currentStock: z.number().min(0).optional(),
  kitchenStock: z.number().min(0).optional(),
  minimumStock: z.number().min(0),
  costPerUnit: z.number().min(0).optional(),
});

function serializeInv(item: typeof inventoryItemsTable.$inferSelect) {
  return {
    ...item,
    brand: item.brand ?? "",
    variant: item.variant ?? "",
    qrToken: item.qrToken || "",
    archivedAt: item.archivedAt ? iso(item.archivedAt) : null,
    updatedAt: iso(item.updatedAt),
  };
}

router.post("/inventory/items/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(inventoryRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { archiveItems } = await import("../services/inventoryService");
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        // Soft-archive only — never destroy movements/lots/waste history
        await archiveItems(tx, parsed.data.deleteIds);
      }
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.id) {
          const existing = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.id) });
          if (!existing) continue;
          if (existing.archivedAt) continue; // do not revive via bulk metadata unless explicit unarchive API
          const payload = {
            name: row.name,
            category: row.category,
            unit: row.unit,
            brand: row.brand ?? existing.brand ?? "",
            variant: row.variant ?? existing.variant ?? "",
            minimumStock: row.minimumStock,
            costPerUnit: row.costPerUnit ?? existing.costPerUnit,
            // Stock is Inventory Core only — ignore client stock fields on update
            updatedAt: new Date(),
            qrToken: existing.qrToken || newQrToken(),
          };
          const [updated] = await tx.update(inventoryItemsTable).set(payload)
            .where(eq(inventoryItemsTable.id, row.id)).returning();
          if (updated) results.push(updated);
        } else {
          const [created] = await tx.insert(inventoryItemsTable).values({
            name: row.name,
            category: row.category,
            unit: row.unit,
            brand: row.brand ?? "",
            variant: row.variant ?? "",
            qrToken: newQrToken(),
            currentStock: 0,
            kitchenStock: 0,
            minimumStock: row.minimumStock,
            costPerUnit: row.costPerUnit ?? 0,
          }).returning();
          results.push(created);
        }
      }
      return results;
    });
    res.json(saved.map(serializeInv));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

const movementRowSchema = z.object({
  id: z.number().optional(),
  itemId: z.number(),
  type: z.enum(["in", "out", "kitchen", "adjustment", "transfer"]),
  location: z.enum(["warehouse", "kitchen"]).optional(),
  quantity: z.number().positive(),
  note: z.string().optional(),
  actor: z.string().min(1),
});

router.post("/inventory/movements/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(movementRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    if (parsed.data.deleteIds?.length) {
      res.status(400).json({
        error: "Deleting movements is not allowed. Use POST /inventory/movements/:id/reverse instead.",
        code: "VALIDATION_ERROR",
      });
      return;
    }
    const { actorFrom } = await import("../auth/middleware");
    const { adjustStock } = await import("../services/inventoryService");
    const saved = await db.transaction(async (tx) => {
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.id) continue;
        if (row.type === "transfer") {
          throw new Error("Use /inventory/transfers for transfers");
        }
        const actor = actorFrom(req, row.actor);
        const location: Location = row.type === "kitchen"
          ? "kitchen"
          : (row.location ?? "warehouse");

        if (row.type === "in") {
          const received = await receiveIntoWarehouse({
            itemId: row.itemId,
            quantity: row.quantity,
            note: row.note,
            actor,
            userId: req.user?.id ?? null,
          }, tx);
          results.push({ ...received.movement, itemName: received.item.name, unit: received.item.unit });
          continue;
        }

        const signedQty = row.type === "adjustment" ? row.quantity : -row.quantity;
        const result = await adjustStock(tx, {
          itemId: row.itemId,
          location,
          quantity: signedQty,
          note: row.note ?? row.type,
          actor,
          userId: req.user?.id ?? null,
        });
        results.push({ ...result.movement, itemName: result.item.name, unit: result.item.unit });
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

const transferRowSchema = z.object({
  itemId: z.number().optional(),
  qrToken: z.string().optional(),
  quantity: z.number().positive(),
  unit: z.string().optional(),
  actor: z.string().optional(),
  note: z.string().optional(),
  from: z.enum(["warehouse", "kitchen"]).default("warehouse"),
  to: z.enum(["warehouse", "kitchen"]).default("kitchen"),
  lotId: z.number().optional().nullable(),
  method: z.string().optional(),
});

router.post("/inventory/transfers/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(transferRowSchema) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const results = [];
    for (const row of parsed.data.rows) {
      if (!row.itemId && !row.qrToken) throw new Error("itemId or qrToken required");
      const result = await transferStock({
        itemId: row.itemId,
        qrToken: row.qrToken,
        quantity: row.quantity,
        unit: row.unit,
        from: row.from,
        to: row.to,
        note: row.note,
        actor: actorFrom(req),
        userId: req.user?.id ?? null,
        method: row.method ?? "bulk",
        lotId: row.lotId,
      });
      results.push({
        id: result.movementId,
        itemId: result.itemId,
        type: "transfer",
        location: result.to,
        quantity: result.quantity,
        note: `${result.from} → ${result.to}`,
        actor: actorFrom(req),
        itemName: result.item,
        unit: result.unit,
        from: result.from,
        to: result.to,
        createdAt: result.timestamp,
      });
    }
    res.json(results);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

/** Warehouse Opening Balance — owner/manager only (roles.ts blocks warehouse writes). */
const openingBalanceSchema = z.object({
  lines: z.array(z.object({
    itemId: z.number().int().positive(),
    quantity: z.number().positive(),
    unit: z.string().optional(),
    unitCost: z.number().min(0).optional(),
    brand: z.string().optional(),
    note: z.string().optional(),
  })).min(1),
  asOfDate: z.string().optional(),
  notes: z.string().optional(),
  allowDuplicateItems: z.boolean().optional(),
  clientRequestId: z.string().min(8).max(80).optional(),
});

router.post("/inventory/opening-balance", async (req, res): Promise<void> => {
  const parsed = openingBalanceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  if (body.currentStock != null || body.kitchenStock != null || body.actorId != null || body.actor != null) {
    res.status(400).json({
      error: "Do not send stock balances or actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { postWarehouseOpeningBalance } = await import("../services/openingBalanceService");
    const result = await postWarehouseOpeningBalance({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

/** Canonical single transfer (Web + Mobile). */
router.post("/inventory/transfers", async (req, res): Promise<void> => {
  const parsed = transferRowSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      error: parsed.error.message,
      message: parsed.error.message,
    });
    return;
  }
  // Mobile must not send authoritative stock / actor identity
  const body = req.body as Record<string, unknown>;
  if (
    body.currentStock != null
    || body.kitchenStock != null
    || body.warehouseStock != null
    || body.actorId != null
  ) {
    res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      error: "Do not send stock balances or actorId; the server derives them from inventory + session.",
      message: "Do not send stock balances or actorId; the server derives them from inventory + session.",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const result = await transferStock({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
      method: parsed.data.method ?? (parsed.data.qrToken ? "qr" : "manual"),
    });
    const remainingSourceStock = result.from === "warehouse" ? result.warehouseStock : result.kitchenStock;
    const remainingDestinationStock = result.to === "warehouse" ? result.warehouseStock : result.kitchenStock;
    res.status(201).json({
      success: true,
      item: {
        id: result.itemId,
        name: result.item,
        unit: result.unit,
      },
      source: result.from.toUpperCase(),
      destination: result.to.toUpperCase(),
      quantity: result.quantity,
      unit: result.unit.toUpperCase(),
      remainingSourceStock,
      remainingDestinationStock,
      warehouseStock: result.warehouseStock,
      kitchenStock: result.kitchenStock,
      movementId: result.movementId,
      timestamp: result.timestamp,
    });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json({
      success: false,
      code: mapped.body.code ?? "TRANSFER_FAILED",
      error: mapped.body.error,
      message: mapped.body.error,
      details: mapped.body.details,
    });
  }
});

function serializeLot(
  lot: typeof warehouseLotsTable.$inferSelect,
  extra?: { itemName?: string; itemUnit?: string; category?: string; qrToken?: string },
) {
  return {
    id: lot.id,
    itemId: lot.itemId,
    receiptDate: lot.receiptDate,
    brand: lot.brand,
    quantityReceived: Number(lot.quantityReceived),
    quantityRemaining: Number(lot.quantityRemaining),
    costPerUnit: Number(lot.costPerUnit),
    note: lot.note,
    actor: lot.actor,
    archiveId: lot.archiveId,
    createdAt: iso(lot.createdAt),
    itemName: extra?.itemName,
    itemUnit: extra?.itemUnit,
    category: extra?.category,
    qrToken: extra?.qrToken,
  };
}



const receiptRowSchema = z.object({
  id: z.number().optional(),
  itemId: z.number(),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  brand: z.string().optional(),
  quantity: z.number().positive(),
  costPerUnit: z.number().min(0).optional(),
  actor: z.string().optional(),
  note: z.string().optional(),
});

router.get("/inventory/receipts", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const filters = date ? [eq(warehouseLotsTable.receiptDate, date)] : [];
  const rows = await db.select({
    lot: warehouseLotsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    category: inventoryItemsTable.category,
    qrToken: inventoryItemsTable.qrToken,
  }).from(warehouseLotsTable)
    .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(warehouseLotsTable.createdAt))
    .limit(500);
  res.json(rows.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken })));
});

/** Receiving path A — metadata edits + create via ReceivingService.receiveIntoWarehouse (same domain as purchase receive). */
router.post("/inventory/receipts/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(receiptRowSchema.extend({ unit: z.string().optional() })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.deleteIds?.length) {
    res.status(400).json({
      error: "Deleting receipt lots is not allowed. Use movement reverse / adjustment to correct stock.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const saved = await db.transaction(async (tx) => {
      const results = [];
      for (const row of parsed.data.rows) {
        const item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.itemId) });
        if (!item) throw new Error(`Item ${row.itemId} not found`);
        const brand = (row.brand ?? item.brand ?? "").trim();
        const cost = row.costPerUnit ?? Number(item.costPerUnit) ?? 0;
        const actor = actorFrom(req, row.actor);
        const unit = (row as { unit?: string }).unit?.trim() || item.unit;
        const qtyBase = convertToBaseUnit(row.quantity, unit, item.unit);

        if (row.id) {
          const existing = await tx.query.warehouseLotsTable.findFirst({ where: eq(warehouseLotsTable.id, row.id) });
          if (!existing) continue;
          if (existing.archiveId) throw new Error(`Lot #${row.id} already archived — cannot edit`);
          // Quantity is immutable after receive — use movement reverse/correction for stock fixes
          const qtyChanged = Math.abs(qtyBase - Number(existing.quantityReceived)) > 0.0001;
          if (qtyChanged) {
            throw new AppError(
              "VALIDATION_ERROR",
              `Receipt lot #${row.id} quantity is immutable after receiving. Reverse the original receive movement (or create a correction), then receive again if needed.`,
            );
          }
          const [updated] = await tx.update(warehouseLotsTable).set({
            brand,
            costPerUnit: cost,
            actor,
            note: row.note ?? existing.note ?? "",
            // metadata only — quantityReceived / quantityRemaining unchanged
          }).where(eq(warehouseLotsTable.id, row.id)).returning();
          if (cost > 0 || brand) {
            await tx.update(inventoryItemsTable).set({
              ...(cost > 0 ? { costPerUnit: cost } : {}),
              ...(brand ? { brand } : {}),
              updatedAt: new Date(),
            }).where(eq(inventoryItemsTable.id, row.itemId));
          }
          if (updated) {
            results.push(serializeLot(updated, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken }));
          }
        } else {
          const received = await receiveIntoWarehouse({
            itemId: row.itemId,
            quantity: qtyBase,
            unit: item.unit,
            unitCost: cost,
            brand,
            note: row.note ?? "",
            actor,
            userId: req.user?.id ?? null,
            receiptDate: row.receiptDate,
          }, tx as never);
          if (brand) {
            await tx.update(inventoryItemsTable).set({ brand, updatedAt: new Date() }).where(eq(inventoryItemsTable.id, row.itemId));
          }
          results.push(serializeLot(received.lot, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken }));
        }
      }
      return results;
    });
    res.json(saved);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/inventory/lots", async (req, res): Promise<void> => {
  const itemId = req.query.itemId ? Number(req.query.itemId) : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const onlyRemaining = req.query.remaining !== "0" && req.query.remaining !== "false";
  const filters = [];
  if (itemId && !Number.isNaN(itemId)) filters.push(eq(warehouseLotsTable.itemId, itemId));
  if (onlyRemaining) filters.push(sql`${warehouseLotsTable.quantityRemaining} > 0`);
  const rows = await db.select({
    lot: warehouseLotsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    category: inventoryItemsTable.category,
    qrToken: inventoryItemsTable.qrToken,
  }).from(warehouseLotsTable)
    .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(warehouseLotsTable.receiptDate), desc(warehouseLotsTable.id))
    .limit(300);
  const mapped = rows.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken }));
  const filtered = q
    ? mapped.filter((r) => `${r.itemName} ${r.brand} ${r.category}`.toLowerCase().includes(q))
    : mapped;
  res.json(filtered);
});

router.get("/inventory/lots/reconcile", async (_req, res): Promise<void> => {
  res.json(await getLotReconciliationReport());
});

/** DATA MIGRATION TOOL — owner/manager only. Does not change stock balances. */
router.post("/inventory/lots/backfill-legacy", async (req, res): Promise<void> => {
  const role = req.user?.role;
  if (role !== "owner" && role !== "manager") {
    res.status(403).json({
      success: false,
      code: "UNAUTHORIZED_OPERATION",
      error: "You do not have permission to perform this operation.",
      message: "Legacy backfill is a data-migration tool restricted to owner/manager.",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true" || req.body?.dryRun === true;
    const report = await backfillLegacyLots({
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
      dryRun,
    });
    res.json({ success: true, ...report });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json({ success: false, ...mapped.body, message: mapped.body.error });
  }
});

router.get("/inventory/items/by-qr/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    res.status(400).json({ error: "Missing QR token" });
    return;
  }
  const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.qrToken, token) });
  if (!item) {
    res.status(404).json({ error: "Item not found for QR" });
    return;
  }
  const lots = await db.select().from(warehouseLotsTable)
    .where(and(eq(warehouseLotsTable.itemId, item.id), sql`${warehouseLotsTable.quantityRemaining} > 0`))
    .orderBy(desc(warehouseLotsTable.receiptDate));
  res.json({
    ...serializeInv(item),
    lots: lots.map((lot) => serializeLot(lot, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken })),
  });
});

router.get("/inventory/items/search", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const withStock = req.query.withStock !== "0";
  const filters = [];
  if (q) {
    filters.push(sql`(
      lower(${inventoryItemsTable.name}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.category}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.brand}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.variant}) like ${`%${q.toLowerCase()}%`}
    )`);
  }
  if (withStock) filters.push(sql`${inventoryItemsTable.currentStock} > 0`);
  filters.push(sql`${inventoryItemsTable.archivedAt} IS NULL`);
  const items = await db.select().from(inventoryItemsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(inventoryItemsTable.name))
    .limit(40);
  res.json(items.map(serializeInv));
});

const issueSchema = z.object({
  itemId: z.number().optional(),
  qrToken: z.string().optional(),
  lotId: z.number().optional().nullable(),
  quantity: z.number().positive(),
  unit: z.string().optional(),
  actor: z.string().optional(),
  note: z.string().optional(),
});

router.post("/inventory/issue-to-kitchen", async (req, res): Promise<void> => {
  const parsed = issueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const actor = actorFrom(req);
    const result = await transferStock({
      itemId: parsed.data.itemId,
      qrToken: parsed.data.qrToken,
      lotId: parsed.data.lotId,
      quantity: parsed.data.quantity,
      unit: parsed.data.unit,
      from: "warehouse",
      to: "kitchen",
      note: parsed.data.note ?? "warehouse → kitchen",
      actor,
      userId: req.user?.id ?? null,
      method: parsed.data.qrToken ? "qr" : "manual",
    });
    const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, result.itemId) });
    res.status(201).json({
      movement: {
        id: result.movementId,
        itemId: result.itemId,
        type: "transfer",
        location: "kitchen",
        quantity: result.quantity,
        note: result.from + " → " + result.to,
        actor,
        createdAt: result.timestamp,
      },
      item: item ? serializeInv(item) : null,
      lotId: null,
      unitCost: item ? Number(item.costPerUnit) || 0 : 0,
      totalCost: (item ? Number(item.costPerUnit) || 0 : 0) * result.quantity,
      success: result.success,
      warehouseStock: result.warehouseStock,
      kitchenStock: result.kitchenStock,
      movementId: result.movementId,
      quantity: result.quantity,
      from: result.from,
      to: result.to,
      timestamp: result.timestamp,
    });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/inventory/movements/:id/reverse", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid movement id" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const reversal = await db.transaction(async (tx) =>
      reverseMovement(tx, id, actorFrom(req), req.user?.id ?? null),
    );
    res.status(201).json({ ...reversal, createdAt: iso(reversal.createdAt) });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/inventory/items/:id/history", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid item id" });
    return;
  }
  const rows = await db.select().from(inventoryMovementsTable)
    .where(eq(inventoryMovementsTable.itemId, id))
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(200);
  res.json(rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })));
});

router.get("/inventory/low-stock", async (_req, res): Promise<void> => {
  const items = await db.select().from(inventoryItemsTable)
    .where(sql`${inventoryItemsTable.currentStock} <= ${inventoryItemsTable.minimumStock}`)
    .orderBy(asc(inventoryItemsTable.name));
  res.json(items.map(serializeInv));
});

router.post("/inventory/adjustments", async (req, res): Promise<void> => {
  const schema = z.object({
    itemId: z.number(),
    location: z.enum(["warehouse", "kitchen"]),
    quantity: z.number(),
    unit: z.string().optional(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { adjustStock } = await import("../services/inventoryService");
    const actor = actorFrom(req);
    const result = await db.transaction(async (tx) =>
      adjustStock(tx, {
        itemId: parsed.data.itemId,
        location: parsed.data.location,
        quantity: parsed.data.quantity,
        unit: parsed.data.unit,
        note: parsed.data.note,
        actor,
        userId: req.user?.id ?? null,
      }),
    );
    res.status(201).json({
      movement: { ...result.movement, createdAt: iso(result.movement.createdAt) },
      item: serializeInv(result.item),
    });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/inventory/waste", async (req, res): Promise<void> => {
  const schema = z.object({
    inventoryItemId: z.number(),
    location: z.enum(["warehouse", "kitchen"]),
    quantity: z.number().positive(),
    unit: z.string().optional(),
    reason: z.enum(["spoilage", "prep", "theft", "other"]).default("spoilage"),
    note: z.string().optional(),
    wasteDate: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { wasteStock } = await import("../services/inventoryService");
    const actor = actorFrom(req);
    const today = new Date();
    const wasteDate = parsed.data.wasteDate
      || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const saved = await db.transaction(async (tx) => {
      const { movement, item, quantity } = await wasteStock(tx, {
        itemId: parsed.data.inventoryItemId,
        location: parsed.data.location,
        quantity: parsed.data.quantity,
        unit: parsed.data.unit,
        note: parsed.data.note,
        actor,
        userId: req.user?.id ?? null,
        reason: parsed.data.reason,
      });
      const costEstimate = quantity * Number(item.costPerUnit || 0);
      const [created] = await tx.insert(wasteRecordsTable).values({
        wasteDate,
        wasteTime: "",
        inventoryItemId: item.id,
        location: parsed.data.location,
        quantity,
        reason: parsed.data.reason,
        actor,
        costEstimate,
        notes: parsed.data.note ?? "",
      }).returning();
      void movement;
      return { ...created, itemName: item.name, unit: item.unit };
    });
    res.status(201).json({ ...saved, createdAt: iso(saved.createdAt) });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/inventory/issues", async (req, res): Promise<void> => {
  const actor = typeof req.query.actor === "string" ? req.query.actor.trim() : "";
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const filters = [eq(inventoryMovementsTable.type, "transfer"), eq(inventoryMovementsTable.location, "kitchen")];
  if (actor) filters.push(eq(inventoryMovementsTable.actor, actor));
  if (date) filters.push(sql`${inventoryMovementsTable.createdAt}::date = ${date}`);
  const rows = await db.select({
    movement: inventoryMovementsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    qrToken: inventoryItemsTable.qrToken,
  }).from(inventoryMovementsTable)
    .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
    .where(and(...filters))
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(200);
  res.json(rows.map(({ movement, itemName, itemUnit, qrToken }) => ({
    ...movement,
    itemName,
    itemUnit,
    qrToken,
    createdAt: iso(movement.createdAt),
  })));
});

function serializeWhArchive(row: typeof warehouseDayArchivesTable.$inferSelect, includeSnapshot = false) {
  let snapshot: unknown;
  if (includeSnapshot) {
    try { snapshot = JSON.parse(row.snapshotJson || "{}"); } catch { snapshot = {}; }
  }
  return {
    id: row.id,
    businessDate: row.businessDate,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    notes: row.notes,
    receiptCount: Number(row.receiptCount),
    totalQuantity: Number(row.totalQuantity),
    totalValue: Number(row.totalValue),
    ...(includeSnapshot ? { snapshot } : {}),
  };
}

router.get("/warehouse-archives", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const rows = await db.select().from(warehouseDayArchivesTable).orderBy(desc(warehouseDayArchivesTable.businessDate)).limit(365);
  if (!q) {
    res.json(rows.map((r) => serializeWhArchive(r, false)));
    return;
  }
  const matched = [];
  for (const row of rows) {
    const ser = serializeWhArchive(row, true);
    const snap = ser.snapshot as { receipts?: { itemName?: string; brand?: string; category?: string }[]; searchText?: string } | undefined;
    const hay = `${row.businessDate} ${row.notes ?? ""} ${snap?.searchText ?? ""} ${(snap?.receipts ?? []).map((r) => `${r.itemName} ${r.brand} ${r.category}`).join(" ")}`.toLowerCase();
    if (hay.includes(q)) matched.push(serializeWhArchive(row, false));
  }
  res.json(matched);
});

router.get("/warehouse-archives/:date", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select().from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "Warehouse day not archived" });
    return;
  }
  res.json(serializeWhArchive(rows[0], true));
});

router.get("/warehouse-archives/:date/status", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  const rows = await db.select({
    id: warehouseDayArchivesTable.id,
    closedAt: warehouseDayArchivesTable.closedAt,
    closedBy: warehouseDayArchivesTable.closedBy,
  }).from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
  res.json({
    date,
    archived: Boolean(rows[0]),
    closedAt: rows[0] ? iso(rows[0].closedAt) : null,
    closedBy: rows[0]?.closedBy ?? null,
  });
});

router.post("/warehouse-archives/close", async (req, res): Promise<void> => {
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    closedBy: z.string().optional(),
    notes: z.string().optional(),
    force: z.boolean().optional(),
    rows: z.array(receiptRowSchema).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const { actorFrom } = await import("../auth/middleware");
  const closedBy = actorFrom(req, parsed.data.closedBy);
  const notes = parsed.data.notes?.trim() || null;
  const force = Boolean(parsed.data.force);

  try {
    const archive = await db.transaction(async (tx) => {
      // Optional: persist any pending receipt rows via ReceivingService (no raw stock writes)
      if (parsed.data.rows?.length) {
        const { receiveIntoWarehouse } = await import("../services/receivingService");
        for (const row of parsed.data.rows) {
          if (row.id) {
            // Edits of archived/open lots: quantity immutable (same rule as receipts bulk-save)
            const existing = await tx.query.warehouseLotsTable.findFirst({ where: eq(warehouseLotsTable.id, row.id) });
            if (!existing || existing.archiveId) continue;
            const item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.itemId) });
            if (!item) throw new Error(`Item ${row.itemId} not found`);
            const qtyBase = convertToBaseUnit(row.quantity, item.unit, item.unit);
            if (Math.abs(qtyBase - Number(existing.quantityReceived)) > 0.0001) {
              throw new AppError(
                "VALIDATION_ERROR",
                `Receipt lot #${row.id} quantity is immutable after receiving. Reverse the original receive, then receive again if needed.`,
              );
            }
            await tx.update(warehouseLotsTable).set({
              brand: (row.brand ?? item.brand ?? "").trim(),
              costPerUnit: row.costPerUnit ?? Number(item.costPerUnit) ?? 0,
              actor: actorFrom(req, closedBy),
              note: row.note ?? existing.note ?? "",
            }).where(eq(warehouseLotsTable.id, row.id));
          } else {
            await receiveIntoWarehouse({
              itemId: row.itemId,
              quantity: row.quantity,
              unitCost: row.costPerUnit,
              brand: row.brand,
              note: row.note ?? "",
              actor: actorFrom(req, closedBy),
              userId: req.user?.id ?? null,
              receiptDate: row.receiptDate || date,
            }, tx as never);
          }
        }
      }

      const existing = await tx.select().from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
      if (existing[0] && !force) {
        throw Object.assign(new Error("Warehouse day already archived"), { status: 409, archive: existing[0] });
      }

      const dayLots = await tx.select({
        lot: warehouseLotsTable,
        itemName: inventoryItemsTable.name,
        itemUnit: inventoryItemsTable.unit,
        category: inventoryItemsTable.category,
        qrToken: inventoryItemsTable.qrToken,
      }).from(warehouseLotsTable)
        .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
        .where(eq(warehouseLotsTable.receiptDate, date));

      const stockItems = await tx.select().from(inventoryItemsTable).orderBy(asc(inventoryItemsTable.category), asc(inventoryItemsTable.name));
      const receipts = dayLots.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken }));
      const totalQuantity = receipts.reduce((s, r) => s + r.quantityReceived, 0);
      const totalValue = receipts.reduce((s, r) => s + r.quantityReceived * r.costPerUnit, 0);
      const snapshot = {
        date,
        receipts,
        stockAtClose: stockItems.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          unit: i.unit,
          brand: i.brand,
          qrToken: i.qrToken,
          currentStock: Number(i.currentStock),
          kitchenStock: Number(i.kitchenStock),
          costPerUnit: Number(i.costPerUnit),
        })),
        searchText: receipts.map((r) => `${r.itemName} ${r.brand} ${r.category}`).join(" "),
      };

      const payload = {
        businessDate: date,
        closedBy,
        notes,
        receiptCount: receipts.length,
        totalQuantity,
        totalValue,
        snapshotJson: JSON.stringify(snapshot),
        closedAt: new Date(),
      };

      let archiveRow: typeof warehouseDayArchivesTable.$inferSelect;
      if (existing[0]) {
        const [updated] = await tx.update(warehouseDayArchivesTable).set(payload)
          .where(eq(warehouseDayArchivesTable.id, existing[0].id)).returning();
        archiveRow = updated!;
      } else {
        const [inserted] = await tx.insert(warehouseDayArchivesTable).values(payload).returning();
        archiveRow = inserted!;
      }

      // Link today's lots to this archive
      if (dayLots.length) {
        await tx.update(warehouseLotsTable)
          .set({ archiveId: archiveRow.id })
          .where(eq(warehouseLotsTable.receiptDate, date));
      }

      return archiveRow;
    });

    res.status(201).json(serializeWhArchive(archive, true));
  } catch (error) {
    const err = error as Error & { status?: number; archive?: typeof warehouseDayArchivesTable.$inferSelect };
    if (err.status === 409 && err.archive) {
      res.status(409).json({ error: err.message, archive: serializeWhArchive(err.archive, false) });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Close failed" });
  }
});

router.post("/finance/expenses/bulk-save", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      expenseDate: z.string(),
      expenseTime: z.string().optional(),
      category: z.string().optional(),
      description: z.string().min(1),
      amount: z.number().positive(),
      paidBy: z.string().optional(),
      receivedBy: z.string().optional(),
      paymentMethod: z.string().min(1),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { assertExpenseNotPurchaseDuplicate } = await import("../services/purchasePaymentService");
    const sessionActor = actorFrom(req);
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        await tx.update(expensesTable).set({
          status: "voided",
          voidedAt: new Date(),
          voidedBy: sessionActor,
          voidReason: "voided via bulk-save",
        }).where(inArray(expensesTable.id, parsed.data.deleteIds));
      }
      const results = [];
      for (const row of parsed.data.rows) {
        const category = (row.category?.trim() || "Other");
        assertExpenseNotPurchaseDuplicate(category, row.description);
        const payload = {
          expenseDate: row.expenseDate,
          expenseTime: row.expenseTime ?? "",
          category,
          description: row.description,
          amount: row.amount,
          paidBy: sessionActor,
          receivedBy: (row.receivedBy?.trim() || "-"),
          paymentMethod: row.paymentMethod,
          notes: row.notes ?? "",
          status: "active" as const,
        };
        if (row.id) {
          const existing = await tx.select().from(expensesTable).where(eq(expensesTable.id, row.id)).limit(1);
          const keepActor = existing[0]?.paidBy || sessionActor;
          const [updated] = await tx.update(expensesTable).set({
            ...payload,
            paidBy: keepActor,
          }).where(eq(expensesTable.id, row.id)).returning();
          if (updated) results.push(updated);
        } else {
          const [created] = await tx.insert(expensesTable).values(payload).returning();
          results.push(created);
        }
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

function shiftDateISO(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function dayAmountSum(
  kind: "expense" | "income" | "purchase",
  date: string,
): Promise<number> {
  if (kind === "expense") {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${expensesTable.amount}), 0)` })
      .from(expensesTable)
      .where(and(eq(expensesTable.expenseDate, date), eq(expensesTable.status, "active")));
    return Number(row?.total ?? 0);
  }
  if (kind === "purchase") {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${dailyPurchasesTable.totalAmount}), 0)` })
      .from(dailyPurchasesTable)
      .where(eq(dailyPurchasesTable.purchaseDate, date));
    return Number(row?.total ?? 0);
  }
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${incomeTable.amount}), 0)` })
    .from(incomeTable)
    .where(and(eq(incomeTable.incomeDate, date), eq(incomeTable.status, "active")));
  return Number(row?.total ?? 0);
}

async function resolveOpeningBalance(date: string): Promise<{
  openingBalance: number;
  suggestedOpening: number;
  isManual: boolean;
  notes: string;
}> {
  const prev = shiftDateISO(date, -1);
  const [prevBalance] = await db.select().from(dailyCashBalancesTable).where(eq(dailyCashBalancesTable.businessDate, prev)).limit(1);
  const prevOpening = prevBalance ? Number(prevBalance.openingBalance) : 0;
  // Carry-forward from cash book: yesterday opening + income − expenses (purchases are NOT capital)
  const prevIncome = await dayAmountSum("income", prev);
  const prevExpenses = await dayAmountSum("expense", prev);
  const suggestedOpening = Math.round((prevOpening + prevIncome - prevExpenses) * 100) / 100;

  const [current] = await db.select().from(dailyCashBalancesTable).where(eq(dailyCashBalancesTable.businessDate, date)).limit(1);
  if (current) {
    return {
      openingBalance: Number(current.openingBalance),
      suggestedOpening,
      isManual: true,
      notes: current.notes ?? "",
    };
  }
  return {
    openingBalance: suggestedOpening,
    suggestedOpening,
    isManual: false,
    notes: "",
  };
}

async function upsertOpeningBalance(date: string, openingBalance: number, notes?: string) {
  const existing = await db.select().from(dailyCashBalancesTable).where(eq(dailyCashBalancesTable.businessDate, date)).limit(1);
  if (existing[0]) {
    const [row] = await db.update(dailyCashBalancesTable).set({
      openingBalance,
      notes: notes ?? existing[0].notes ?? "",
      updatedAt: new Date(),
    }).where(eq(dailyCashBalancesTable.businessDate, date)).returning();
    return row;
  }
  const [row] = await db.insert(dailyCashBalancesTable).values({
    businessDate: date,
    openingBalance,
    notes: notes ?? "",
  }).returning();
  return row;
}

/** Persist today opening; cash book closing = opening + income − expenses (purchases reported separately). */
async function saveCashDayWithCarry(date: string, openingBalance: number, notes?: string) {
  const row = await upsertOpeningBalance(date, openingBalance, notes);
  const totalPurchases = await dayAmountSum("purchase", date);
  const totalIncome = await dayAmountSum("income", date);
  const totalExpenses = await dayAmountSum("expense", date);
  const closingBalance = Math.round((Number(row.openingBalance) + totalIncome - totalExpenses) * 100) / 100;
  const tomorrow = shiftDateISO(date, 1);
  await upsertOpeningBalance(tomorrow, closingBalance);
  const balance = await resolveOpeningBalance(date);
  return {
    date,
    openingBalance: Number(row.openingBalance),
    suggestedOpening: balance.suggestedOpening,
    isManual: true,
    notes: row.notes ?? "",
    totalIncome,
    totalExpenses,
    totalPurchases,
    closingBalance,
    tomorrowOpening: closingBalance,
    tomorrowDate: tomorrow,
  };
}

router.get("/finance/cash-day", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    return;
  }
  try {
    const balance = await resolveOpeningBalance(date);
    const totalIncome = await dayAmountSum("income", date);
    const totalExpenses = await dayAmountSum("expense", date);
    const totalPurchases = await dayAmountSum("purchase", date);
    const closingBalance = Math.round((balance.openingBalance + totalIncome - totalExpenses) * 100) / 100;
    res.json({
      date,
      ...balance,
      totalIncome,
      totalExpenses,
      totalPurchases,
      closingBalance,
      tomorrowDate: shiftDateISO(date, 1),
      tomorrowOpening: closingBalance,
      note: "Daily cash drawer book for this date. Opening here is NOT restaurant capital. Purchases are listed for reference and do not reduce closing cash.",
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "cash-day failed" });
  }
});

router.put("/finance/cash-day", async (req, res): Promise<void> => {
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    openingBalance: z.number(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await saveCashDayWithCarry(parsed.data.date, parsed.data.openingBalance, parsed.data.notes);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "cash-day save failed" });
  }
});

router.post("/finance/income/bulk-save", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      incomeDate: z.string(),
      incomeTime: z.string().optional(),
      source: z.string().min(1),
      amount: z.number().positive(),
      recordedBy: z.string().optional(),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { actorFrom } = await import("../auth/middleware");
  const sessionActor = actorFrom(req);
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.update(incomeTable).set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: sessionActor,
        voidReason: "voided via bulk-save",
      }).where(inArray(incomeTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        incomeDate: row.incomeDate,
        incomeTime: row.incomeTime ?? "",
        source: row.source,
        amount: row.amount,
        recordedBy: sessionActor,
        notes: row.notes ?? "",
        status: "active" as const,
      };
      if (row.id) {
        const existing = await tx.select().from(incomeTable).where(eq(incomeTable.id, row.id)).limit(1);
        const keepActor = existing[0]?.recordedBy || sessionActor;
        const [updated] = await tx.update(incomeTable).set({
          ...payload,
          recordedBy: keepActor,
        }).where(eq(incomeTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(incomeTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
});

const capitalCreateSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryType: z.enum(["initial_capital", "additional_capital"]),
  amount: z.number().positive(),
  description: z.string().optional(),
  clientRequestId: z.string().min(1).max(120).optional(),
});

router.get("/finance/capital", async (req, res): Promise<void> => {
  try {
    const includeVoided = req.query.includeVoided === "1" || req.query.includeVoided === "true";
    const { listCapitalEntries } = await import("../services/capitalService");
    const rows = await listCapitalEntries({ includeVoided, limit: 500 });
    res.json(rows);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/capital", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null || body.responsible != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const parsed = capitalCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { createCapitalEntry } = await import("../services/capitalService");
    const result = await createCapitalEntry({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/capital/:id/void", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid capital entry id", code: "VALIDATION_ERROR" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { voidCapitalEntry } = await import("../services/capitalService");
    const result = await voidCapitalEntry({
      id,
      actor: actorFrom(req),
      reason,
    });
    res.json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/finance/operational-summary", async (_req, res): Promise<void> => {
  try {
    const { getAvailableCapitalSummary } = await import("../services/capitalService");
    const summary = await getAvailableCapitalSummary();
    res.json(summary);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/finance/available-summary", async (_req, res): Promise<void> => {
  try {
    const { getAvailableCapitalSummary } = await import("../services/capitalService");
    const summary = await getAvailableCapitalSummary();
    res.json(summary);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

/**
 * Soft-void historical expenses that look like purchases (audit kept).
 * Does NOT create purchase_payments and does NOT delete rows.
 */
router.post("/finance/expenses/remediate-purchase-duplicates", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { softVoidSuspectedPurchaseExpenses, getAvailableCapitalSummary } = await import("../services/capitalService");
    const result = await softVoidSuspectedPurchaseExpenses(
      actorFrom(req),
      typeof body.reason === "string" ? body.reason : undefined,
    );
    const summary = await getAvailableCapitalSummary();
    res.json({ ...result, summary });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/expenses/:id/void", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid expense id" });
    return;
  }
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { voidExpense } = await import("../services/capitalService");
    const result = await voidExpense(id, actorFrom(req), typeof body.reason === "string" ? body.reason : undefined);
    res.json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/income/:id/void", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid income id" });
    return;
  }
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { voidIncome } = await import("../services/capitalService");
    const result = await voidIncome(id, actorFrom(req), typeof body.reason === "string" ? body.reason : undefined);
    res.json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/finance/purchase-payments", async (req, res): Promise<void> => {
  try {
    const includeVoided = req.query.includeVoided === "1" || req.query.includeVoided === "true";
    const { listPurchasePayments } = await import("../services/purchasePaymentService");
    res.json(await listPurchasePayments({ includeVoided, limit: 500 }));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/purchase-payments", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({ error: "Do not send actor identity; the server uses the authenticated session.", code: "VALIDATION_ERROR" });
    return;
  }
  const parsed = z.object({
    purchaseId: z.number().int().positive(),
    amount: z.number().positive(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    paymentMethod: z.string().optional(),
    notes: z.string().optional(),
    clientRequestId: z.string().min(1).max(120).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { postPurchasePayment } = await import("../services/purchasePaymentService");
    const result = await postPurchasePayment({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/finance/purchase-payments/:id/void", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid payment id", code: "VALIDATION_ERROR" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({ error: "Do not send actor identity; the server uses the authenticated session.", code: "VALIDATION_ERROR" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { voidPurchasePayment } = await import("../services/purchasePaymentService");
    const result = await voidPurchasePayment({
      id,
      actor: actorFrom(req),
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    res.json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/purchases/receive-goods", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null || body.currentStock != null) {
    res.status(400).json({
      error: "Do not send actor identity or stock balances; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const parsed = z.object({
    inventoryItemId: z.number().int().positive().optional().nullable(),
    newItem: z.object({
      name: z.string().min(1),
      category: z.string().optional(),
      unit: z.string().min(1),
      minimumStock: z.number().optional(),
      costPerUnit: z.number().optional(),
      brand: z.string().optional(),
    }).optional(),
    quantity: z.number().positive(),
    unit: z.string().optional(),
    unitPrice: z.number().min(0),
    supplier: z.string().min(1),
    paymentMethod: z.string().optional(),
    paymentStatus: z.enum(["paid", "unpaid"]).optional(),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    purchaseTime: z.string().optional(),
    receivedBy: z.string().optional(),
    notes: z.string().optional(),
    brand: z.string().optional(),
    invoiceNumber: z.string().optional(),
    clientRequestId: z.string().min(1).max(120).optional(),
    purchaseId: z.number().int().positive().optional().nullable(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { receiveGoods } = await import("../services/receiveGoodsService");
    const result = await receiveGoods({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(201).json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

/**
 * Unified today's purchase entry:
 * destination=warehouse → receive goods (stock + payment)
 * destination=none → purchase + payment only (no inventory)
 */
router.post("/purchases/record", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  if (body.actor != null || body.actorId != null || body.currentStock != null) {
    res.status(400).json({
      error: "Do not send actor identity or stock balances; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  const parsed = z.object({
    destination: z.enum(["warehouse", "none"]),
    itemName: z.string().min(1),
    category: z.string().optional(),
    quantity: z.number().positive(),
    unit: z.string().min(1),
    unitPrice: z.number().min(0),
    supplier: z.string().min(1),
    paymentMethod: z.string().optional(),
    paymentStatus: z.enum(["paid", "unpaid"]).optional(),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    purchaseTime: z.string().optional(),
    notes: z.string().optional(),
    inventoryItemId: z.number().int().positive().optional().nullable(),
    clientRequestId: z.string().min(1).max(120).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message, code: "VALIDATION_ERROR" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { recordDailyPurchase } = await import("../services/recordDailyPurchaseService");
    const result = await recordDailyPurchase({
      ...parsed.data,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(201).json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/purchases/:id/cancel", async (req, res): Promise<void> => {
  const purchaseId = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: "Invalid purchase id" });
    return;
  }
  if (body.actor != null || body.actorId != null) {
    res.status(400).json({
      error: "Do not send actor identity; the server uses the authenticated session.",
      code: "VALIDATION_ERROR",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { cancelDailyPurchase } = await import("../services/recordDailyPurchaseService");
    const result = await cancelDailyPurchase({
      purchaseId,
      actor: actorFrom(req),
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    res.json(result);
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/inventory/warehouse-summary", async (req, res): Promise<void> => {
  try {
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const { getWarehouseSummary } = await import("../services/warehouseSummaryService");
    res.json(await getWarehouseSummary({ from, to }));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/inventory/stock-integrity", async (_req, res): Promise<void> => {
  try {
    const { getStockIntegrityReport } = await import("../services/warehouseSummaryService");
    res.json(await getStockIntegrityReport());
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.post("/staff/employees/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      fullName: z.string().min(1),
      role: z.string().min(1),
      phone: z.string().optional(),
      startDate: z.string(),
      status: z.enum(["active", "inactive"]).optional(),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(attendanceTable).where(inArray(attendanceTable.employeeId, parsed.data.deleteIds));
      await tx.delete(employeesTable).where(inArray(employeesTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        fullName: row.fullName,
        role: row.role,
        phone: row.phone ?? "",
        startDate: row.startDate,
        status: row.status ?? "active",
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(employeesTable).set(payload).where(eq(employeesTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(employeesTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved);
});

router.post("/staff/attendance/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      employeeId: z.number(),
      attendanceDate: z.string(),
      checkIn: z.string(),
      checkOut: z.string().optional(),
      status: z.enum(["present", "late", "absent", "leave"]),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(attendanceTable).where(inArray(attendanceTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        employeeId: row.employeeId,
        attendanceDate: row.attendanceDate,
        checkIn: row.checkIn,
        checkOut: row.checkOut ?? "",
        status: row.status,
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(attendanceTable).set(payload).where(eq(attendanceTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(attendanceTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  const withNames = await Promise.all(saved.map(async (row) => {
    const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, row.employeeId) });
    return { ...row, employeeName: employee?.fullName ?? "" };
  }));
  res.json(withNames);
});

const purchaseRowSchema = z.object({
  id: z.number().optional(),
  purchaseDate: z.string(),
  purchaseTime: z.string().optional(),
  supplier: z.string().min(1).optional().default("-"),
  itemName: z.string().min(1),
  category: z.string().optional().default(""),
  quantity: z.number().positive(),
  unit: z.string().optional().default("kg"),
  unitPrice: z.number().min(0),
  totalAmount: z.number().min(0).optional(),
  paidBy: z.string().optional().default(""),
  receivedBy: z.string().optional().default(""),
  paymentMethod: z.string().optional().default("Cash"),
  inventoryItemId: z.number().optional().nullable(),
  destination: z.enum(["warehouse", "kitchen", "none"]).optional(),
  addToStock: z.enum(["yes", "no"]).optional(),
  notes: z.string().optional(),
  syncExpense: z.boolean().optional(),
}).transform((row) => ({
  ...row,
  supplier: (row.supplier ?? "-").trim() || "-",
  category: (row.category ?? "").trim() || "General",
  unit: (row.unit ?? "kg").trim() || "kg",
  paidBy: (row.paidBy ?? "").trim() || "Staff",
  receivedBy: (row.receivedBy ?? "").trim() || "Gudang",
  paymentMethod: (row.paymentMethod ?? "Cash").trim() || "Cash",
}));

function resolveDestination(row: z.infer<typeof purchaseRowSchema>): "warehouse" | "kitchen" | "none" {
  if (row.destination) return row.destination;
  if (row.addToStock === "no") return "none";
  return "warehouse";
}

router.get("/purchases", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const rows = await db.select().from(dailyPurchasesTable)
    .where(date ? eq(dailyPurchasesTable.purchaseDate, date) : undefined)
    .orderBy(desc(dailyPurchasesTable.purchaseDate), desc(dailyPurchasesTable.createdAt))
    .limit(500);

  const ids = rows.map((r) => r.id);
  const payments = ids.length
    ? await db.select().from(purchasePaymentsTable)
      .where(and(
        inArray(purchasePaymentsTable.purchaseId, ids),
        eq(purchasePaymentsTable.status, "active"),
      ))
    : [];
  const payByPurchase = new Map(payments.map((p) => [p.purchaseId, p]));

  res.json(rows.map((row) => {
    const pay = payByPurchase.get(row.id);
    return {
      ...row,
      createdAt: iso(row.createdAt),
      paymentStatus: pay ? "paid" : "unpaid",
      activePaymentId: pay?.id ?? null,
      activePaymentAmount: pay ? Number(pay.amount) : null,
    };
  }));
});

router.post("/purchases/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(purchaseRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await upsertPurchases(
      parsed.data.rows.map((row) => {
        const destination = resolveDestination(row);
        return {
          id: row.id,
          purchaseDate: row.purchaseDate,
          purchaseTime: row.purchaseTime,
          supplier: row.supplier,
          itemName: row.itemName,
          category: row.category,
          quantity: row.quantity,
          unit: row.unit,
          unitPrice: row.unitPrice,
          totalAmount: row.totalAmount,
          paidBy: row.paidBy,
          receivedBy: row.receivedBy,
          paymentMethod: row.paymentMethod,
          inventoryItemId: destination === "none" ? null : (row.inventoryItemId ?? null),
          destination,
          notes: row.notes,
        };
      }),
      parsed.data.deleteIds ?? [],
    );
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

/** Receive against a purchase — creates warehouse stock + lot. Purchase alone does not. */
router.post("/purchases/:id/receive", async (req, res): Promise<void> => {
  const purchaseId = Number(req.params.id);
  const schema = z.object({
    quantity: z.number().positive(),
    unit: z.string().optional(),
    note: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!Number.isFinite(purchaseId) || !parsed.success) {
    res.status(400).json({ error: parsed.success === false ? parsed.error.message : "Invalid purchase id" });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const result = await receivePurchase(purchaseId, {
      quantity: parsed.data.quantity,
      unit: parsed.data.unit,
      note: parsed.data.note,
      actor: actorFrom(req),
      userId: req.user?.id ?? null,
    });
    res.status(201).json({
      success: true,
      purchaseId,
      quantity: result.quantity,
      unit: result.unit,
      lotId: result.lot.id,
      movementId: result.movement.id,
      warehouseStock: result.warehouseStock,
      kitchenStock: result.kitchenStock,
      item: serializeInv(result.item),
    });
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

router.get("/finance/purchases/today", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string"
    ? req.query.date
    : (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
  const summary = await getTodayPurchasesSummary(date);
  res.json({
    ...summary,
    rows: summary.rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
  });
});

router.get("/finance/inventory-value", async (_req, res): Promise<void> => {
  res.json(await getInventoryValue());
});

// ——— Waste ———
router.get("/waste", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const rows = await db.select({
    waste: wasteRecordsTable,
    itemName: inventoryItemsTable.name,
    unit: inventoryItemsTable.unit,
  }).from(wasteRecordsTable)
    .innerJoin(inventoryItemsTable, eq(wasteRecordsTable.inventoryItemId, inventoryItemsTable.id))
    .where(date ? eq(wasteRecordsTable.wasteDate, date) : undefined)
    .orderBy(desc(wasteRecordsTable.createdAt))
    .limit(500);
  res.json(rows.map(({ waste, itemName, unit }) => ({
    ...waste,
    itemName,
    unit,
    createdAt: iso(waste.createdAt),
  })));
});

router.post("/waste/bulk-save", async (req, res): Promise<void> => {
  const schema = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      wasteDate: z.string(),
      wasteTime: z.string().optional(),
      inventoryItemId: z.number(),
      location: z.enum(["warehouse", "kitchen"]),
      quantity: z.number().positive(),
      unit: z.string().optional(),
      reason: z.enum(["spoilage", "prep", "theft", "other"]).default("spoilage"),
      actor: z.string().min(1),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.deleteIds?.length) {
    res.status(400).json({
      error: "Waste records are immutable. Corrections require POST /inventory/movements/:id/reverse (append-only audit).",
      code: "WASTE_IMMUTABLE",
    });
    return;
  }
  try {
    const { actorFrom } = await import("../auth/middleware");
    const { wasteStock } = await import("../services/inventoryService");
    const saved = await db.transaction(async (tx) => {
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.id) continue;
        const actor = actorFrom(req, row.actor);
        const { movement, item, quantity } = await wasteStock(tx, {
          itemId: row.inventoryItemId,
          location: row.location,
          quantity: row.quantity,
          unit: row.unit,
          note: row.notes,
          actor,
          userId: req.user?.id ?? null,
          reason: row.reason,
        });
        const costEstimate = quantity * Number(item.costPerUnit || 0);
        const [created] = await tx.insert(wasteRecordsTable).values({
          wasteDate: row.wasteDate,
          wasteTime: row.wasteTime ?? "",
          inventoryItemId: row.inventoryItemId,
          location: row.location,
          quantity,
          reason: row.reason,
          actor,
          costEstimate,
          notes: row.notes ?? "",
        }).returning();
        void movement;
        results.push({ ...created, itemName: item.name, unit: item.unit });
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    const mapped = toErrorResponse(error);
    res.status(mapped.status).json(mapped.body);
  }
});

// ——— Recipes / plate costing ———
function serializeRecipeComputed(
  recipe: typeof menuRecipesTable.$inferSelect,
  linesRaw: (typeof recipeLinesTable.$inferSelect)[],
  itemMap: Map<number, typeof inventoryItemsTable.$inferSelect>,
) {
  const lines = linesRaw.map((line) => {
    const item = itemMap.get(line.inventoryItemId);
    if (!item) {
      return {
        id: line.id,
        inventoryItemId: line.inventoryItemId,
        quantity: Number(line.quantity),
        unit: line.unit,
        yieldPct: Number(line.yieldPct || 100),
        notes: line.notes,
        itemName: "",
        itemUnit: "",
        convertedQuantity: 0,
        convertedUnit: "",
        costPerUnit: 0,
        lineCost: 0,
        error: "Inventory item not found",
      };
    }
    try {
      const breakdown = computeRecipeLineCost({
        quantity: Number(line.quantity),
        unit: line.unit,
        itemUnit: item.unit,
        costPerUnit: Number(item.costPerUnit || 0),
        yieldPct: Number(line.yieldPct || 100),
      });
      return {
        id: line.id,
        inventoryItemId: line.inventoryItemId,
        quantity: breakdown.quantity,
        unit: breakdown.unit,
        yieldPct: breakdown.yieldPct,
        notes: line.notes,
        itemName: item.name,
        itemUnit: item.unit,
        convertedQuantity: breakdown.convertedQuantity,
        convertedUnit: breakdown.convertedUnit,
        costPerUnit: breakdown.costPerUnit,
        lineCost: breakdown.lineCost,
      };
    } catch (e) {
      return {
        id: line.id,
        inventoryItemId: line.inventoryItemId,
        quantity: Number(line.quantity),
        unit: line.unit,
        yieldPct: Number(line.yieldPct || 100),
        notes: line.notes,
        itemName: item.name,
        itemUnit: item.unit,
        convertedQuantity: 0,
        convertedUnit: item.unit,
        costPerUnit: Number(item.costPerUnit || 0),
        lineCost: 0,
        error: e instanceof Error ? e.message : "Invalid line",
      };
    }
  });
  const totals = computeRecipeTotals(
    lines.map((l) => l.lineCost),
    Number(recipe.portions) || 1,
    Number(recipe.sellingPrice) || 0,
    Number(recipe.targetFoodCostPct) || 30,
  );
  return {
    ...recipe,
    createdAt: iso(recipe.createdAt),
    updatedAt: iso(recipe.updatedAt),
    lines,
    totalCost: totals.totalCost,
    costPerPortion: totals.costPerPortion,
    suggestedPrice: totals.suggestedPrice,
    foodCostPct: totals.foodCostPct,
  };
}

router.get("/recipes", async (_req, res): Promise<void> => {
  const recipes = await db.select().from(menuRecipesTable).orderBy(desc(menuRecipesTable.updatedAt)).limit(200);
  const allLines = await db.select().from(recipeLinesTable);
  const items = await db.select().from(inventoryItemsTable);
  const itemMap = new Map(items.map((i) => [i.id, i]));
  res.json(recipes.map((recipe) => serializeRecipeComputed(
    recipe,
    allLines.filter((l) => l.recipeId === recipe.id),
    itemMap,
  )));
});

router.post("/recipes/bulk-save", async (req, res): Promise<void> => {
  const lineSchema = z.object({
    id: z.number().optional(),
    inventoryItemId: z.number(),
    quantity: z.number().positive(),
    unit: z.string().min(1),
    yieldPct: z.number().gt(0).max(100).optional(),
    notes: z.string().optional(),
  });
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      name: z.string().min(1),
      category: z.string().optional(),
      portions: z.number().positive().optional(),
      targetFoodCostPct: z.number().positive().optional(),
      sellingPrice: z.number().min(0).optional(),
      notes: z.string().optional(),
      lines: z.array(lineSchema).optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    // Pre-validate units against inventory before writing (no stock mutation)
    const items = await db.select().from(inventoryItemsTable);
    const itemMap = new Map(items.map((i) => [i.id, i]));
    for (const row of parsed.data.rows) {
      for (const line of row.lines ?? []) {
        const item = itemMap.get(line.inventoryItemId);
        if (!item) {
          throw new Error(`Inventory item ${line.inventoryItemId} not found`);
        }
        assertRecipeLineCompatible(line.quantity, line.unit, item.unit, line.yieldPct ?? 100);
      }
    }

    const savedIds = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        await tx.delete(recipeLinesTable).where(inArray(recipeLinesTable.recipeId, parsed.data.deleteIds));
        await tx.delete(menuRecipesTable).where(inArray(menuRecipesTable.id, parsed.data.deleteIds));
      }
      const ids: number[] = [];
      for (const row of parsed.data.rows) {
        const payload = {
          name: row.name,
          category: row.category ?? "",
          portions: row.portions ?? 1,
          targetFoodCostPct: row.targetFoodCostPct ?? 30,
          sellingPrice: row.sellingPrice ?? 0,
          notes: row.notes ?? "",
          updatedAt: new Date(),
        };
        let recipeId = row.id;
        if (recipeId) {
          await tx.update(menuRecipesTable).set(payload).where(eq(menuRecipesTable.id, recipeId));
          if (row.lines) {
            await tx.delete(recipeLinesTable).where(eq(recipeLinesTable.recipeId, recipeId));
          }
        } else {
          const [created] = await tx.insert(menuRecipesTable).values(payload).returning();
          recipeId = created.id;
        }
        if (row.lines?.length) {
          await tx.insert(recipeLinesTable).values(row.lines.map((line) => ({
            recipeId: recipeId!,
            inventoryItemId: line.inventoryItemId,
            quantity: line.quantity,
            unit: line.unit,
            yieldPct: line.yieldPct ?? 100,
            notes: line.notes ?? "",
          })));
        }
        ids.push(recipeId!);
      }
      return ids;
    });

    const all = savedIds.length
      ? await db.select().from(menuRecipesTable).where(inArray(menuRecipesTable.id, savedIds))
      : [];
    const allLines = savedIds.length
      ? await db.select().from(recipeLinesTable).where(inArray(recipeLinesTable.recipeId, savedIds))
      : [];
    const itemsAfter = await db.select().from(inventoryItemsTable);
    const mapAfter = new Map(itemsAfter.map((i) => [i.id, i]));
    res.json(all.map((recipe) => serializeRecipeComputed(
      recipe,
      allLines.filter((l) => l.recipeId === recipe.id),
      mapAfter,
    )));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Recipe save failed" });
  }
});

const closeDayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  closedBy: z.string().optional(),
  notes: z.string().optional(),
  force: z.boolean().optional(),
});

function serializeArchive(row: typeof dailyArchivesTable.$inferSelect, includeSnapshot = false) {
  let snapshot: unknown = undefined;
  if (includeSnapshot) {
    try {
      snapshot = JSON.parse(row.snapshotJson || "{}");
    } catch {
      snapshot = {};
    }
  }
  return {
    id: row.id,
    businessDate: row.businessDate,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    notes: row.notes,
    totalIncome: Number(row.totalIncome),
    totalExpenses: Number(row.totalExpenses),
    netCash: Number(row.netCash),
    totalPurchases: Number(row.totalPurchases),
    purchaseCount: Number(row.purchaseCount),
    wasteCost: Number(row.wasteCost),
    kitchenMovements: Number(row.kitchenMovements),
    attendanceCount: Number(row.attendanceCount),
    warehouseValue: Number(row.warehouseValue),
    kitchenValue: Number(row.kitchenValue),
    ...(includeSnapshot ? { snapshot } : {}),
  };
}

async function buildDaySnapshot(date: string) {
  const [incomeRows, expenseRows, purchaseRows, wasteRows, movements, attendanceRows, stockItems, cashDay] = await Promise.all([
    db.select().from(incomeTable).where(eq(incomeTable.incomeDate, date)).orderBy(desc(incomeTable.createdAt)),
    db.select().from(expensesTable).where(eq(expensesTable.expenseDate, date)).orderBy(desc(expensesTable.createdAt)),
    db.select().from(dailyPurchasesTable).where(eq(dailyPurchasesTable.purchaseDate, date)).orderBy(desc(dailyPurchasesTable.createdAt)),
    db.select().from(wasteRecordsTable).where(eq(wasteRecordsTable.wasteDate, date)).orderBy(desc(wasteRecordsTable.createdAt)),
    db.select({
      movement: inventoryMovementsTable,
      itemName: inventoryItemsTable.name,
      itemUnit: inventoryItemsTable.unit,
    }).from(inventoryMovementsTable)
      .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
      .where(sql`${inventoryMovementsTable.createdAt}::date = ${date}`)
      .orderBy(desc(inventoryMovementsTable.createdAt)),
    db.select({
      attendance: attendanceTable,
      employeeName: employeesTable.fullName,
    }).from(attendanceTable)
      .leftJoin(employeesTable, eq(attendanceTable.employeeId, employeesTable.id))
      .where(eq(attendanceTable.attendanceDate, date)),
    db.select().from(inventoryItemsTable).orderBy(asc(inventoryItemsTable.category), asc(inventoryItemsTable.name)),
    resolveOpeningBalance(date),
  ]);

  const totalIncome = incomeRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalPurchases = purchaseRows.reduce((s, r) => s + Number(r.totalAmount), 0);
  const wasteCost = wasteRows.reduce((s, r) => s + Number(r.costEstimate), 0);
  const kitchenMovements = movements.filter((m) =>
    m.movement.type === "kitchen"
    || (m.movement.type === "transfer" && m.movement.location === "kitchen"),
  ).length;
  const warehouseValue = stockItems.reduce((s, i) => s + Number(i.currentStock) * Number(i.costPerUnit), 0);
  const kitchenValue = stockItems.reduce((s, i) => s + Number(i.kitchenStock) * Number(i.costPerUnit), 0);
  const closingBalance = Math.round((cashDay.openingBalance + totalIncome - totalExpenses) * 100) / 100;

  const snapshot = {
    date,
    cash: {
      openingBalance: cashDay.openingBalance,
      suggestedOpening: cashDay.suggestedOpening,
      closingBalance,
      totalIncome,
      totalExpenses,
      totalPurchases,
      tomorrowOpening: closingBalance,
    },
    income: incomeRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    expenses: expenseRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    purchases: purchaseRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    waste: wasteRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    movements: movements.map(({ movement, itemName, itemUnit }) => ({
      ...movement,
      itemName,
      itemUnit,
      createdAt: iso(movement.createdAt),
    })),
    attendance: attendanceRows.map(({ attendance, employeeName }) => ({
      ...attendance,
      employeeName: employeeName ?? "",
    })),
    stockAtClose: stockItems.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      unit: i.unit,
      currentStock: Number(i.currentStock),
      kitchenStock: Number(i.kitchenStock),
      costPerUnit: Number(i.costPerUnit),
      warehouseValue: Number(i.currentStock) * Number(i.costPerUnit),
      kitchenValue: Number(i.kitchenStock) * Number(i.costPerUnit),
    })),
  };

  return {
    totals: {
      totalIncome,
      totalExpenses,
      netCash: totalIncome - totalExpenses,
      totalPurchases,
      purchaseCount: purchaseRows.length,
      wasteCost,
      kitchenMovements,
      attendanceCount: attendanceRows.length,
      warehouseValue,
      kitchenValue,
    },
    snapshot,
  };
}

/** List archived days (newest first). */
router.get("/day-archives", async (_req, res): Promise<void> => {
  const rows = await db.select().from(dailyArchivesTable).orderBy(desc(dailyArchivesTable.businessDate)).limit(120);
  res.json(rows.map((row) => serializeArchive(row, false)));
});

/** Get one archived day with full snapshot. */
router.get("/day-archives/:date", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select().from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "Day not archived" });
    return;
  }
  res.json(serializeArchive(rows[0], true));
});

/** Check if a date is already archived (lightweight). */
router.get("/day-archives/:date/status", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select({
    id: dailyArchivesTable.id,
    closedAt: dailyArchivesTable.closedAt,
    closedBy: dailyArchivesTable.closedBy,
  }).from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  res.json({
    date,
    archived: Boolean(rows[0]),
    closedAt: rows[0] ? iso(rows[0].closedAt) : null,
    closedBy: rows[0]?.closedBy ?? null,
  });
});

/**
 * End-of-day archive: freeze purchases, stock movements, waste, cash, and stock balances for the day.
 * Does not delete live data — creates a read-only snapshot. Use force=true to re-archive.
 */
router.post("/day-archives/close", async (req, res): Promise<void> => {
  const parsed = closeDayBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const { actorFrom } = await import("../auth/middleware");
  const closedBy = actorFrom(req, parsed.data.closedBy);
  const notes = parsed.data.notes?.trim() || null;
  const force = Boolean(parsed.data.force);

  const existing = await db.select().from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  if (existing[0] && !force) {
    res.status(409).json({
      error: "Day already archived",
      archive: serializeArchive(existing[0], false),
    });
    return;
  }

  const { totals, snapshot } = await buildDaySnapshot(date);
  const payload = {
    businessDate: date,
    closedBy,
    notes,
    totalIncome: totals.totalIncome,
    totalExpenses: totals.totalExpenses,
    netCash: totals.netCash,
    totalPurchases: totals.totalPurchases,
    purchaseCount: totals.purchaseCount,
    wasteCost: totals.wasteCost,
    kitchenMovements: totals.kitchenMovements,
    attendanceCount: totals.attendanceCount,
    warehouseValue: totals.warehouseValue,
    kitchenValue: totals.kitchenValue,
    snapshotJson: JSON.stringify(snapshot),
  };

  let row: typeof dailyArchivesTable.$inferSelect;
  if (existing[0]) {
    const updated = await db.update(dailyArchivesTable)
      .set({ ...payload, closedAt: new Date() })
      .where(eq(dailyArchivesTable.id, existing[0].id))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await db.insert(dailyArchivesTable).values(payload).returning();
    row = inserted[0]!;
  }

  res.status(existing[0] ? 200 : 201).json(serializeArchive(row, true));
});

export default router;
