/**
 * Full warehouse stocktake — DRAFT/IN_PROGRESS never mutate balances.
 * COMPLETE posts audited ADJUSTMENT movements inside one transaction.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  v3InventoryItemsTable,
  v3StocktakeLinesTable,
  v3StocktakesTable,
} from "@workspace/db";
import { AppError } from "../lib/errors";
import {
  createItem,
  ensureItemQrToken,
  isWarehouseCatalogItem,
  loadWarehousePresenceItemIds,
  postAdjustment,
  updateProduct,
} from "./warehouseService";

async function findStocktakeByClient(clientRequestId?: string) {
  if (!clientRequestId?.trim()) return null;
  const rows = await db
    .select()
    .from(v3StocktakesTable)
    .where(eq(v3StocktakesTable.clientRequestId, clientRequestId.trim()))
    .limit(1);
  return rows[0] ?? null;
}

async function getStocktakeRow(id: number) {
  const rows = await db.select().from(v3StocktakesTable).where(eq(v3StocktakesTable.id, id)).limit(1);
  return rows[0] ?? null;
}

async function getStocktakeLine(stocktakeId: number, inventoryItemId: number) {
  const rows = await db
    .select()
    .from(v3StocktakeLinesTable)
    .where(
      and(
        eq(v3StocktakeLinesTable.stocktakeId, stocktakeId),
        eq(v3StocktakeLinesTable.inventoryItemId, inventoryItemId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listStocktakes(opts?: { status?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 20));
  const rows = await db
    .select()
    .from(v3StocktakesTable)
    .orderBy(desc(v3StocktakesTable.id));
  const filtered = opts?.status
    ? rows.filter((r) => r.status === opts.status)
    : rows;
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return { rows: filtered.slice(start, start + pageSize), total, page, pageSize };
}

function lineCountStatus(input: {
  countedQuantity: number | null;
  difference: number | null;
  isActive: boolean;
}): "NOT_COUNTED" | "COUNTED" | "DIFFERENCE" {
  if (input.countedQuantity == null) return "NOT_COUNTED";
  if (input.difference != null && Math.abs(input.difference) > 1e-9) return "DIFFERENCE";
  return "COUNTED";
}

export async function getStocktake(id: number) {
  const sessions = await db.select().from(v3StocktakesTable).where(eq(v3StocktakesTable.id, id)).limit(1);
  const session = sessions[0];
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  const lines = await db
    .select({
      line: v3StocktakeLinesTable,
      itemName: v3InventoryItemsTable.name,
      itemUnit: v3InventoryItemsTable.baseUnit,
      isActive: v3InventoryItemsTable.isActive,
      qrToken: v3InventoryItemsTable.qrToken,
      itemCreatedAt: v3InventoryItemsTable.createdAt,
    })
    .from(v3StocktakeLinesTable)
    .innerJoin(
      v3InventoryItemsTable,
      eq(v3StocktakeLinesTable.inventoryItemId, v3InventoryItemsTable.id),
    )
    .where(eq(v3StocktakeLinesTable.stocktakeId, id))
    .orderBy(v3InventoryItemsTable.name);

  return {
    stocktake: session,
    lines: lines.map((r) => {
      const systemQuantityBefore =
        r.line.systemQuantityBefore == null ? null : Number(r.line.systemQuantityBefore);
      const countedQuantity =
        r.line.countedQuantity == null ? null : Number(r.line.countedQuantity);
      const difference = r.line.difference == null ? null : Number(r.line.difference);
      return {
        ...r.line,
        itemName: r.itemName,
        itemUnit: r.itemUnit,
        isActive: r.isActive,
        qrToken: r.qrToken,
        itemCreatedAt: r.itemCreatedAt,
        systemQuantityBefore,
        countedQuantity,
        difference,
        countStatus: lineCountStatus({
          countedQuantity,
          difference,
          isActive: r.isActive,
        }),
      };
    }),
  };
}

/** Mobile-ready progress summary for an open or completed stocktake session. */
export async function getStocktakeProgress(id: number) {
  const detail = await getStocktake(id);
  const session = detail.stocktake;
  const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : 0;

  const activeLines = detail.lines.filter((l) => l.isActive);
  const countedProducts = activeLines.filter((l) => l.countedQuantity != null).length;
  const remainingProducts = activeLines.length - countedProducts;
  const differencesCount = activeLines.filter(
    (l) => l.countStatus === "DIFFERENCE",
  ).length;
  const newProducts = detail.lines.filter((l) => {
    if (l.countedQuantity == null) return false;
    const createdAt = l.itemCreatedAt ? new Date(l.itemCreatedAt).getTime() : 0;
    return startedAt > 0 && createdAt >= startedAt - 1000;
  }).length;

  return {
    stocktakeId: id,
    status: session.status,
    totalProducts: activeLines.length,
    countedProducts,
    remainingProducts,
    newProducts,
    differencesCount,
    canComplete: remainingProducts === 0 && countedProducts > 0,
    lines: detail.lines.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      itemName: l.itemName,
      itemUnit: l.itemUnit,
      systemQuantityBefore: l.systemQuantityBefore,
      countedQuantity: l.countedQuantity,
      difference: l.difference,
      countStatus: l.countStatus,
      isActive: l.isActive,
      notes: l.notes ?? null,
    })),
  };
}

export async function startStocktake(input: {
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  const existing = await findStocktakeByClient(input.clientRequestId);
  if (existing) return { idempotent: true as const, stocktake: existing };

  const open = await db
    .select()
    .from(v3StocktakesTable)
    .where(inArray(v3StocktakesTable.status, ["DRAFT", "IN_PROGRESS"]))
    .limit(1);
  if (open.length) {
    throw new AppError(
      "CONFLICT",
      `يوجد جرد مفتوح (#${open[0]!.id}) — أكمله أو ألغه قبل بدء جرد جديد`,
      409,
    );
  }

  const [session] = await db
    .insert(v3StocktakesTable)
    .values({
      status: "IN_PROGRESS",
      notes: input.notes?.trim() || null,
      startedBy: input.actor,
      startedByUserId: input.userId ?? null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();

  if (!session?.id) {
    throw new AppError("INTERNAL", "تعذر إنشاء جلسة الجرد", 500);
  }

  const presenceIds = await loadWarehousePresenceItemIds();
  const items = await db
    .select()
    .from(v3InventoryItemsTable)
    .where(eq(v3InventoryItemsTable.isActive, true));

  const catalog = items.filter((i) => isWarehouseCatalogItem(i, presenceIds));
  if (catalog.length) {
    await db.insert(v3StocktakeLinesTable).values(
      catalog.map((item) => ({
        stocktakeId: session.id,
        inventoryItemId: item.id,
        systemQuantityBefore:
          item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric),
        countedQuantity: null,
        difference: null,
        unit: item.baseUnit || "",
      })),
    );
  }

  return { idempotent: false as const, stocktake: session };
}

export async function saveStocktakeDraft(
  stocktakeId: number,
  input: { notes?: string; actor: string },
) {
  const session = await getStocktakeRow(stocktakeId);
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  if (session.status === "COMPLETED" || session.status === "CANCELLED") {
    throw new AppError("VALIDATION_ERROR", "لا يمكن تعديل جرد مكتمل أو ملغى");
  }
  const [updated] = await db
    .update(v3StocktakesTable)
    .set({
      status: "DRAFT",
      notes: input.notes !== undefined ? input.notes.trim() || null : session.notes,
      updatedAt: new Date(),
    })
    .where(eq(v3StocktakesTable.id, stocktakeId))
    .returning();
  return updated!;
}

export async function upsertStocktakeLine(
  stocktakeId: number,
  input: {
    inventoryItemId: number;
    countedQuantity: number | null;
    notes?: string;
    actor: string;
    userId?: number | null;
    /** Review/set minimum during count — does NOT change warehouse qty. */
    minimumStock?: number | null;
    /** Correct unit label only — no silent quantity conversion. */
    baseUnit?: string;
  },
) {
  const session = await getStocktakeRow(stocktakeId);
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  if (session.status === "COMPLETED" || session.status === "CANCELLED") {
    throw new AppError("VALIDATION_ERROR", "لا يمكن تعديل جرد مكتمل أو ملغى");
  }

  let item = await db.query.v3InventoryItemsTable.findFirst({
    where: eq(v3InventoryItemsTable.id, input.inventoryItemId),
  });
  if (!item) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);

  // Meta updates during stocktake (identity/alerts only — never invent qty conversion).
  if (input.minimumStock !== undefined || input.baseUnit !== undefined) {
    const patch: { minimumStock?: number | null; baseUnit?: string } = {};
    if (input.minimumStock !== undefined) patch.minimumStock = input.minimumStock;
    if (input.baseUnit !== undefined) patch.baseUnit = input.baseUnit.trim();
    item = await updateProduct(item.id, patch);
    await ensureItemQrToken(item.id);
    item = (await db.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, input.inventoryItemId),
    }))!;
  }

  const system =
    item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
  const counted = input.countedQuantity;
  if (counted != null && (!Number.isFinite(counted) || counted < 0)) {
    throw new AppError("VALIDATION_ERROR", "الكمية الفعلية غير صالحة");
  }
  const difference =
    counted == null || system == null ? null : Number((counted - system).toFixed(4));

  const existing = await getStocktakeLine(stocktakeId, input.inventoryItemId);

  if (existing) {
    const [row] = await db
      .update(v3StocktakeLinesTable)
      .set({
        systemQuantityBefore: system,
        countedQuantity: counted,
        difference,
        unit: item.baseUnit || existing.unit,
        countedBy: input.actor,
        countedByUserId: input.userId ?? null,
        countedAt: counted == null ? null : new Date(),
        notes: input.notes !== undefined ? input.notes.trim() || null : existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(v3StocktakeLinesTable.id, existing.id))
      .returning();
    return row!;
  }

  const [row] = await db
    .insert(v3StocktakeLinesTable)
    .values({
      stocktakeId,
      inventoryItemId: input.inventoryItemId,
      systemQuantityBefore: system,
      countedQuantity: counted,
      difference,
      unit: item.baseUnit || "",
      countedBy: input.actor,
      countedByUserId: input.userId ?? null,
      countedAt: counted == null ? null : new Date(),
      notes: input.notes?.trim() || null,
    })
    .returning();
  return row!;
}

export async function addProductDuringStocktake(
  stocktakeId: number,
  input: {
    name: string;
    baseUnit?: string;
    category?: string;
    minimumStock?: number | null;
    countedQuantity: number;
    actor: string;
    userId?: number | null;
  },
) {
  const session = await getStocktakeRow(stocktakeId);
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  if (session.status === "COMPLETED" || session.status === "CANCELLED") {
    throw new AppError("VALIDATION_ERROR", "لا يمكن إضافة منتج لجرد مكتمل أو ملغى");
  }
  if (!(Number(input.countedQuantity) >= 0)) {
    throw new AppError("VALIDATION_ERROR", "الكمية الفعلية مطلوبة");
  }

  const item = await createItem({
    name: input.name,
    baseUnit: input.baseUnit,
    category: input.category,
    minimumStock: input.minimumStock ?? null,
  });
  await ensureItemQrToken(item.id);

  const line = await upsertStocktakeLine(stocktakeId, {
    inventoryItemId: item.id,
    countedQuantity: Number(input.countedQuantity),
    actor: input.actor,
    userId: input.userId,
  });

  return { item, line };
}

export async function cancelStocktake(
  stocktakeId: number,
  input: { actor: string; reason?: string },
) {
  const session = await getStocktakeRow(stocktakeId);
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  if (session.status === "COMPLETED") {
    throw new AppError("VALIDATION_ERROR", "لا يمكن إلغاء جرد مكتمل");
  }
  if (session.status === "CANCELLED") return { idempotent: true as const, stocktake: session };

  const [updated] = await db
    .update(v3StocktakesTable)
    .set({
      status: "CANCELLED",
      cancelledBy: input.actor,
      cancelledAt: new Date(),
      notes: [session.notes, input.reason ? `إلغاء: ${input.reason}` : ""]
        .filter(Boolean)
        .join("\n") || null,
      updatedAt: new Date(),
    })
    .where(eq(v3StocktakesTable.id, stocktakeId))
    .returning();
  return { idempotent: false as const, stocktake: updated! };
}

/**
 * Complete stocktake: for each counted line, post ADJUSTMENT = counted - system.
 * Uncounted lines are skipped (no silent zeroing).
 */
export async function completeStocktake(
  stocktakeId: number,
  input: { actor: string; userId?: number | null; actorRole?: string | null },
) {
  const session = await getStocktakeRow(stocktakeId);
  if (!session) throw new AppError("NOT_FOUND", "جلسة الجرد غير موجودة", 404);
  if (session.status === "COMPLETED") return { idempotent: true as const, stocktake: session };
  if (session.status === "CANCELLED") {
    throw new AppError("VALIDATION_ERROR", "لا يمكن اعتماد جرد ملغى");
  }

  const detail = await getStocktake(stocktakeId);
  const activeLines = detail.lines.filter((l) => l.isActive);
  const uncounted = activeLines.filter((l) => l.countedQuantity == null);
  if (uncounted.length) {
    throw new AppError(
      "VALIDATION_ERROR",
      `لا يمكن اعتماد الجرد — ${uncounted.length} منتج نشط لم يُجرَد بعد. أكمل الجرد أو استبعد المنتجات صراحةً.`,
      400,
      { uncountedCount: uncounted.length, uncountedItemIds: uncounted.map((l) => l.inventoryItemId) },
    );
  }

  const counted = detail.lines.filter((l) => l.countedQuantity != null);
  if (!counted.length) {
    throw new AppError("VALIDATION_ERROR", "لا توجد كميات مجرودة للاعتماد");
  }

  const lines = await db
    .select()
    .from(v3StocktakeLinesTable)
    .where(eq(v3StocktakeLinesTable.stocktakeId, stocktakeId));

  const adjustments: Array<{ lineId: number; movementId: number; difference: number }> = [];

  // Sequential + idempotent clientRequestIds (no nested transactions).
  for (const line of counted) {
    const item = await db.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, line.inventoryItemId),
    });
    if (!item) continue;

    const systemNow =
      item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
    const countedQty = Number(line.countedQuantity);
    if (systemNow == null) {
      throw new AppError(
        "VALIDATION_ERROR",
        `المادة «${item.name}» رصيدها غير رقمي — صحّحها قبل اعتماد الجرد`,
      );
    }

    const diff = Number((countedQty - systemNow).toFixed(4));
    let movementId: number | null = null;
    if (Math.abs(diff) > 1e-9) {
      const result = await postAdjustment({
        inventoryItemId: item.id,
        quantityNumeric: diff,
        quantityRaw: String(diff),
        unitRaw: item.baseUnit || line.unit || "",
        notes: `اعتماد جرد #${stocktakeId}`,
        actor: input.actor,
        userId: input.userId,
        clientRequestId: `stocktake:${stocktakeId}:item:${item.id}:adj`,
        sourceChannel: "STOCKTAKE",
        actorRole: input.actorRole || null,
      });
      movementId = result.movement.id;
      adjustments.push({ lineId: line.id, movementId, difference: diff });
    }

    await db
      .update(v3StocktakeLinesTable)
      .set({
        systemQuantityBefore: systemNow,
        countedQuantity: countedQty,
        difference: diff,
        adjustmentMovementId: movementId,
        updatedAt: new Date(),
      })
      .where(eq(v3StocktakeLinesTable.id, line.id));
  }

  await db
    .update(v3StocktakesTable)
    .set({
      status: "COMPLETED",
      completedBy: input.actor,
      completedByUserId: input.userId ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(v3StocktakesTable.id, stocktakeId));

  const fresh = await getStocktake(stocktakeId);
  return {
    idempotent: false as const,
    stocktake: fresh.stocktake,
    lines: fresh.lines,
    adjustmentsCreated: adjustments.length,
    adjustments,
  };
}
