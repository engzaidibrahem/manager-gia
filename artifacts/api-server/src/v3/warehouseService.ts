/**
 * GIA V3 warehouse — simple Excel-like ledger.
 * CURRENT = OPENING + IN − OUT (+ ADJUSTMENT)
 * Never invent unit conversions. quantity_numeric may be null.
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  db,
  v3InventoryItemsTable,
  v3OpeningBalancesTable,
  v3WarehouseMovementsTable,
  type V3MovementType,
} from "@workspace/db";
import { AppError } from "../lib/errors";

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newQrToken() {
  return `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parse a value as numeric only when it is clearly a finite number. Never invent. */
export function parseStrictNumeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || Number.isNaN(Number(t))) return null;
    // reject strings with letters / units mixed in
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
  }
  return null;
}

export function stockStatus(
  warehouseQty: number | null,
  minimumStock: number | null | undefined,
): "available" | "low" | "out" | "unknown" {
  if (warehouseQty == null) return "unknown";
  /** Historical negatives must not look like normal "out of stock". */
  if (warehouseQty < 0) return "unknown";
  if (warehouseQty === 0) return "out";
  if (minimumStock != null && Number.isFinite(minimumStock) && warehouseQty <= minimumStock) return "low";
  return "available";
}

export async function recomputeItemBalances(tx: DbTx | typeof db, itemId: number) {
  const rows = await tx
    .select({
      movementType: v3WarehouseMovementsTable.movementType,
      quantityNumeric: v3WarehouseMovementsTable.quantityNumeric,
    })
    .from(v3WarehouseMovementsTable)
    .where(
      and(
        eq(v3WarehouseMovementsTable.inventoryItemId, itemId),
        eq(v3WarehouseMovementsTable.status, "active"),
      ),
    );

  let opening = 0;
  let inn = 0;
  let out = 0;
  let kitchenDirect = 0;
  let adj = 0;
  let hasNullOpening = false;
  let hasNumericOpening = false;
  let hasNumericWhLedger = false;
  let hasNumericKitchen = false;

  for (const r of rows) {
    if (r.movementType === "OPENING") {
      if (r.quantityNumeric == null) {
        hasNullOpening = true;
      } else {
        hasNumericOpening = true;
        opening += Number(r.quantityNumeric);
      }
      continue;
    }
    if (r.quantityNumeric == null) continue;
    const q = Number(r.quantityNumeric);
    if (r.movementType === "WAREHOUSE_IN") {
      hasNumericWhLedger = true;
      inn += q;
    } else if (r.movementType === "WAREHOUSE_TO_KITCHEN") {
      hasNumericWhLedger = true;
      hasNumericKitchen = true;
      out += q;
    } else if (r.movementType === "KITCHEN_DIRECT_IN") {
      hasNumericKitchen = true;
      kitchenDirect += q;
    } else if (r.movementType === "ADJUSTMENT") {
      hasNumericWhLedger = true;
      adj += q;
    }
  }

  /** Never invent warehouse balance when opening is non-numeric (would fake negatives). */
  let warehouse: number | null = null;
  if (hasNullOpening) {
    warehouse = null;
  } else if (hasNumericOpening || hasNumericWhLedger) {
    warehouse = opening + inn - out + adj;
  }

  const kitchen = hasNumericKitchen || out > 0 || kitchenDirect > 0 ? out + kitchenDirect : 0;

  const needsQuantityReview = hasNullOpening;

  await tx
    .update(v3InventoryItemsTable)
    .set({
      warehouseQtyNumeric: warehouse,
      kitchenQtyNumeric: kitchen,
      needsQuantityReview,
      updatedAt: new Date(),
    })
    .where(eq(v3InventoryItemsTable.id, itemId));

  return { warehouseQtyNumeric: warehouse, kitchenQtyNumeric: kitchen, needsQuantityReview };
}

async function findByClientRequest(tx: DbTx | typeof db, clientRequestId?: string) {
  if (!clientRequestId?.trim()) return null;
  return tx.query.v3WarehouseMovementsTable.findFirst({
    where: eq(v3WarehouseMovementsTable.clientRequestId, clientRequestId.trim()),
  });
}

export async function createItem(input: {
  name: string;
  category?: string;
  baseUnit?: string;
  minimumStock?: number | null;
}) {
  const name = input.name.trim();
  if (!name) throw new AppError("VALIDATION_ERROR", "اسم المادة مطلوب");
  const [row] = await db
    .insert(v3InventoryItemsTable)
    .values({
      name,
      category: (input.category || "").trim(),
      baseUnit: (input.baseUnit || "").trim(),
      minimumStock: input.minimumStock ?? null,
      warehouseQtyNumeric: 0,
      kitchenQtyNumeric: 0,
      qrToken: newQrToken(),
      sourceType: "MANUAL",
    })
    .returning();
  return row;
}

export async function updateItemMinimum(itemId: number, minimumStock: number | null) {
  const [row] = await db
    .update(v3InventoryItemsTable)
    .set({ minimumStock, updatedAt: new Date() })
    .where(eq(v3InventoryItemsTable.id, itemId))
    .returning();
  if (!row) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
  return row;
}

/**
 * Item IDs that have real warehouse ledger activity (not kitchen-direct-only).
 * OPENING / WAREHOUSE_IN / WAREHOUSE_TO_KITCHEN / ADJUSTMENT or an opening_balances row.
 */
export async function loadWarehousePresenceItemIds(
  tx: DbTx | typeof db = db,
): Promise<Set<number>> {
  const ids = new Set<number>();

  const ledger = await tx.execute(sql`
    SELECT DISTINCT inventory_item_id AS id
    FROM v3_warehouse_movements
    WHERE status = 'active'
      AND inventory_item_id IS NOT NULL
      AND movement_type IN ('OPENING', 'WAREHOUSE_IN', 'WAREHOUSE_TO_KITCHEN', 'ADJUSTMENT')
  `);
  const ledgerRows = ((ledger as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(ledger) ? (ledger as Array<Record<string, unknown>>) : [])) as Array<
    Record<string, unknown>
  >;
  for (const r of ledgerRows) {
    const id = Number(r.id);
    if (Number.isFinite(id)) ids.add(id);
  }

  const openings = await tx.select({ id: v3OpeningBalancesTable.inventoryItemId }).from(v3OpeningBalancesTable);
  for (const o of openings) {
    if (o.id != null) ids.add(o.id);
  }

  return ids;
}

/** Warehouse page / pickers: exclude kitchen-direct-only catalog rows with no WH ledger. */
export function isWarehouseCatalogItem(
  item: { id: number; sourceType: string },
  presenceIds: Set<number>,
): boolean {
  if (presenceIds.has(item.id)) return true;
  return item.sourceType !== "KITCHEN_DIRECT";
}

export async function listWarehouseSummary(opts: {
  q?: string;
  category?: string;
  status?: "all" | "available" | "low" | "out" | "unknown";
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const conditions = [eq(v3InventoryItemsTable.isActive, true)];
  if (opts.q?.trim()) {
    conditions.push(ilike(v3InventoryItemsTable.name, `%${opts.q.trim()}%`));
  }
  if (opts.category?.trim()) {
    conditions.push(eq(v3InventoryItemsTable.category, opts.category.trim()));
  }

  const all = await db
    .select()
    .from(v3InventoryItemsTable)
    .where(and(...conditions))
    .orderBy(v3InventoryItemsTable.category, v3InventoryItemsTable.name);

  const presenceIds = await loadWarehousePresenceItemIds();

  // Aggregate movement totals per item for Excel-like columns
  const totals = await db.execute(sql`
    SELECT inventory_item_id AS id,
      COALESCE(SUM(CASE WHEN movement_type = 'OPENING' AND status = 'active' THEN quantity_numeric ELSE 0 END), 0) AS opening,
      COALESCE(SUM(CASE WHEN movement_type = 'WAREHOUSE_IN' AND status = 'active' THEN quantity_numeric ELSE 0 END), 0) AS total_in,
      COALESCE(SUM(CASE WHEN movement_type = 'WAREHOUSE_TO_KITCHEN' AND status = 'active' THEN quantity_numeric ELSE 0 END), 0) AS total_out
    FROM v3_warehouse_movements
    GROUP BY inventory_item_id
  `);
  const totRows = ((totals as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(totals) ? (totals as Array<Record<string, unknown>>) : [])) as Array<Record<string, unknown>>;
  const totMap = new Map<number, { opening: number; totalIn: number; totalOut: number }>();
  for (const r of totRows) {
    totMap.set(Number(r.id), {
      opening: Number(r.opening ?? 0),
      totalIn: Number(r.total_in ?? 0),
      totalOut: Number(r.total_out ?? 0),
    });
  }

  // Opening raw texts (first opening row)
  const openings = await db
    .select()
    .from(v3OpeningBalancesTable)
    .orderBy(v3OpeningBalancesTable.id);
  const openingRaw = new Map<number, { quantityRaw: string; unitRaw: string; quantityNumeric: number | null }>();
  for (const o of openings) {
    if (!openingRaw.has(o.inventoryItemId)) {
      openingRaw.set(o.inventoryItemId, {
        quantityRaw: o.quantityRaw,
        unitRaw: o.unitRaw,
        quantityNumeric: o.quantityNumeric == null ? null : Number(o.quantityNumeric),
      });
    }
  }

  let rows = all
    .filter((item) => isWarehouseCatalogItem(item, presenceIds))
    .map((item) => {
    const t = totMap.get(item.id) || { opening: 0, totalIn: 0, totalOut: 0 };
    const op = openingRaw.get(item.id);
    const needsQuantityReview = Boolean(item.needsQuantityReview);
    const cached = item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
    const isNegative = cached != null && cached < 0;
    const needsReview = Boolean(item.needsReview) || needsQuantityReview || isNegative;
    const current = needsQuantityReview ? null : cached;
    const status =
      needsQuantityReview || isNegative
        ? ("unknown" as const)
        : stockStatus(current, item.minimumStock == null ? null : Number(item.minimumStock));

    let reviewReason: string | null = null;
    if (isNegative) reviewReason = "رصيد تاريخي سالب";
    else if (needsQuantityReview && (op?.quantityNumeric == null) && op?.quantityRaw && op.quantityRaw !== "—") {
      reviewReason = "كمية افتتاح غير واضحة";
    } else if (needsQuantityReview || current == null) {
      if (item.sourceType === "MOVEMENT_CREATED_UNMAPPED") {
        reviewReason = "حركة تاريخية بدون رصيد افتتاح رقمي";
      } else {
        reviewReason = "رصيد غير قابل للحساب";
      }
    } else if (item.needsReview) {
      reviewReason = "حركة تاريخية بدون رصيد افتتاح رقمي";
    }

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      baseUnit: item.baseUnit,
      openingNumeric: op?.quantityNumeric ?? (t.opening || null),
      openingRaw: op?.quantityRaw ?? (t.opening ? String(t.opening) : "—"),
      openingUnitRaw: op?.unitRaw ?? item.baseUnit,
      totalIn: t.totalIn,
      totalOut: t.totalOut,
      currentWarehouse: current,
      minimumStock: item.minimumStock == null ? null : Number(item.minimumStock),
      status,
      kitchenQty: item.kitchenQtyNumeric == null ? null : Number(item.kitchenQtyNumeric),
      qrToken: item.qrToken,
      sourceType: item.sourceType,
      sourceExcelRow: item.sourceExcelRow,
      originalNameRaw: item.originalNameRaw,
      needsQuantityReview,
      needsReview,
      isNegative,
      reviewReason,
    };
  });

  const categories = [...new Set(rows.map((i) => i.category).filter(Boolean))].sort();

  if (opts.status && opts.status !== "all") {
    rows = rows.filter((r) => r.status === opts.status);
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  return { rows: pageRows, total, page, pageSize, categories };
}

/** Single-item warehouse detail + permanent movement history (newest first). */
export async function getWarehouseItemDetail(itemId: number) {
  const summary = await listWarehouseSummary({ page: 1, pageSize: 5000 });
  const item = summary.rows.find((r) => r.id === itemId);
  if (!item) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
  const moves = await listMovements({ inventoryItemId: itemId, page: 1, pageSize: 500 });
  return { item, movements: moves.rows };
}

export async function postOpeningBalance(input: {
  inventoryItemId?: number;
  name?: string;
  category?: string;
  baseUnit?: string;
  balanceDate?: string;
  quantityNumeric?: number | null;
  quantityRaw: string;
  unitRaw?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
  batchKey?: string;
}) {
  const run = async (tx: DbTx) => {
    const existing = await findByClientRequest(tx, input.clientRequestId);
    if (existing) {
      return { idempotent: true as const, movement: existing };
    }

    let itemId = input.inventoryItemId;
    if (!itemId) {
      const name = (input.name || "").trim();
      if (!name) throw new AppError("VALIDATION_ERROR", "المادة مطلوبة");
      const [created] = await tx
        .insert(v3InventoryItemsTable)
        .values({
          name,
          category: (input.category || "").trim(),
          baseUnit: (input.baseUnit || input.unitRaw || "").trim(),
          warehouseQtyNumeric: 0,
          kitchenQtyNumeric: 0,
          qrToken: newQrToken(),
          sourceType: "MANUAL",
        })
        .returning();
      itemId = created.id;
    } else {
      const item = await tx.query.v3InventoryItemsTable.findFirst({
        where: eq(v3InventoryItemsTable.id, itemId),
      });
      if (!item) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
    }

    const resolvedItemId = itemId as number;

    // Prevent accidental duplicate opening for the same item (normal operation).
    const priorOpening = await tx
      .select()
      .from(v3WarehouseMovementsTable)
      .where(
        and(
          eq(v3WarehouseMovementsTable.inventoryItemId, resolvedItemId),
          eq(v3WarehouseMovementsTable.movementType, "OPENING"),
          eq(v3WarehouseMovementsTable.status, "active"),
        ),
      )
      .limit(1);
    if (priorOpening.length > 0) {
      throw new AppError(
        "CONFLICT",
        "هذه المادة لديها رصيد افتتاح مسبقاً. لا تُنشئ افتتاحاً مكرراً — استخدم الإدخال للمستودع لإضافة كمية.",
        409,
      );
    }

    const qtyRaw = String(input.quantityRaw ?? "").trim();
    if (!qtyRaw) throw new AppError("VALIDATION_ERROR", "الكمية مطلوبة");
    const qtyNum =
      input.quantityNumeric === undefined
        ? parseStrictNumeric(qtyRaw)
        : input.quantityNumeric;
    if (qtyNum != null && qtyNum < 0) {
      throw new AppError("VALIDATION_ERROR", "الكمية الرقمية لا تكون سالبة");
    }

    const [opening] = await tx
      .insert(v3OpeningBalancesTable)
      .values({
        inventoryItemId: resolvedItemId,
        balanceDate: input.balanceDate || todayISO(),
        quantityNumeric: qtyNum,
        quantityRaw: qtyRaw,
        unitRaw: (input.unitRaw || "").trim(),
        notes: input.notes || null,
        createdBy: input.actor,
        userId: input.userId ?? null,
        batchKey: input.batchKey || null,
      })
      .returning();

    const [movement] = await tx
      .insert(v3WarehouseMovementsTable)
      .values({
        inventoryItemId: resolvedItemId,
        movementType: "OPENING",
        quantityNumeric: qtyNum,
        quantityRaw: qtyRaw,
        unitRaw: (input.unitRaw || "").trim(),
        movementDate: input.balanceDate || todayISO(),
        actor: input.actor,
        userId: input.userId ?? null,
        openingBalanceId: opening.id,
        notes: input.notes || null,
        batchKey: input.batchKey || null,
        clientRequestId: input.clientRequestId?.trim() || null,
      })
      .returning();

    await tx
      .update(v3OpeningBalancesTable)
      .set({ movementId: movement.id })
      .where(eq(v3OpeningBalancesTable.id, opening.id));

    const balances = await recomputeItemBalances(tx, resolvedItemId);
    return { idempotent: false as const, opening, movement, balances, itemId: resolvedItemId };
  };

  return db.transaction(async (tx) => run(tx));
}

export async function postWarehouseIn(input: {
  inventoryItemId: number;
  movementDate?: string;
  quantityNumeric?: number | null;
  quantityRaw: string;
  unitRaw?: string;
  supplier?: string;
  receiver?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  purchaseId?: number | null;
  clientRequestId?: string;
  batchKey?: string;
}) {
  return postMovement("WAREHOUSE_IN", input);
}

export async function postWarehouseToKitchen(input: {
  inventoryItemId: number;
  movementDate?: string;
  quantityNumeric?: number | null;
  quantityRaw: string;
  unitRaw?: string;
  receiver?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
  batchKey?: string;
  allowHistoricalImport?: boolean;
  needsReview?: boolean;
  sourceExcelRow?: number | null;
  originalNameRaw?: string | null;
}) {
  return postMovement("WAREHOUSE_TO_KITCHEN", input);
}

/** Direct kitchen receipt — does NOT touch warehouse stock. */
export async function postKitchenDirectIn(input: {
  inventoryItemId: number;
  movementDate?: string;
  quantityNumeric?: number | null;
  quantityRaw: string;
  unitRaw?: string;
  supplier?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  purchaseId?: number | null;
  clientRequestId?: string;
  batchKey?: string;
}) {
  return postMovement("KITCHEN_DIRECT_IN", input);
}

async function postMovement(
  movementType: V3MovementType,
  input: {
    inventoryItemId: number;
    movementDate?: string;
    quantityNumeric?: number | null;
    quantityRaw: string;
    unitRaw?: string;
    supplier?: string;
    receiver?: string;
    notes?: string;
    actor: string;
    userId?: number | null;
    purchaseId?: number | null;
    clientRequestId?: string;
    batchKey?: string;
    /** Historical import: allow OUT when available is unknown / insufficient. */
    allowHistoricalImport?: boolean;
    needsReview?: boolean;
    sourceExcelRow?: number | null;
    originalNameRaw?: string | null;
  },
) {
  const run = async (tx: DbTx) => {
    const existing = await findByClientRequest(tx, input.clientRequestId);
    if (existing) return { idempotent: true as const, movement: existing };

    const item = await tx.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, input.inventoryItemId),
    });
    if (!item || !item.isActive) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);

    const qtyRaw = String(input.quantityRaw ?? "").trim();
    if (!qtyRaw) throw new AppError("VALIDATION_ERROR", "الكمية مطلوبة");
    const qtyNum =
      input.quantityNumeric === undefined
        ? parseStrictNumeric(qtyRaw)
        : input.quantityNumeric;

    let needsReview = Boolean(input.needsReview);

    if (movementType === "WAREHOUSE_TO_KITCHEN" && qtyNum != null) {
      if (!(qtyNum > 0)) throw new AppError("VALIDATION_ERROR", "الكمية يجب أن تكون أكبر من صفر");
      const available = item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
      if (!input.allowHistoricalImport) {
        if (available == null) {
          throw new AppError(
            "VALIDATION_ERROR",
            "لا يمكن التحقق من الرصيد رقمياً لهذه المادة — حدّد كمية رقمية للافتتاح/الإدخال أولاً",
          );
        }
        if (qtyNum > available + 1e-9) {
          throw new AppError(
            "INSUFFICIENT_STOCK",
            "الكمية المطلوبة أكبر من الكمية الموجودة في المستودع.",
            400,
            { available, requested: qtyNum },
          );
        }
      } else if (available == null || qtyNum > available + 1e-9) {
        needsReview = true;
      }
    }

    if (
      (movementType === "WAREHOUSE_IN" || movementType === "KITCHEN_DIRECT_IN") &&
      qtyNum != null &&
      !(qtyNum > 0)
    ) {
      throw new AppError("VALIDATION_ERROR", "الكمية يجب أن تكون أكبر من صفر");
    }

    const [movement] = await tx
      .insert(v3WarehouseMovementsTable)
      .values({
        inventoryItemId: item.id,
        movementType,
        quantityNumeric: qtyNum,
        quantityRaw: qtyRaw,
        unitRaw: (input.unitRaw || item.baseUnit || "").trim(),
        movementDate: input.movementDate || todayISO(),
        supplier: input.supplier?.trim() || null,
        receiver: input.receiver?.trim() || null,
        actor: input.actor,
        userId: input.userId ?? null,
        purchaseId: input.purchaseId ?? null,
        notes: input.notes || null,
        batchKey: input.batchKey || null,
        clientRequestId: input.clientRequestId?.trim() || null,
        needsReview,
        sourceExcelRow: input.sourceExcelRow ?? null,
        originalNameRaw: input.originalNameRaw ?? null,
      })
      .returning();

    if (needsReview) {
      await tx
        .update(v3InventoryItemsTable)
        .set({ needsReview: true, updatedAt: new Date() })
        .where(eq(v3InventoryItemsTable.id, item.id));
    }

    const balances = await recomputeItemBalances(tx, item.id);
    const updated = await tx.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, item.id),
    });
    return { idempotent: false as const, movement, balances, item: updated };
  };

  return db.transaction(async (tx) => run(tx));
}

export async function listMovements(opts: {
  movementType?: V3MovementType | V3MovementType[];
  inventoryItemId?: number;
  fromDate?: string;
  toDate?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const conditions = [eq(v3WarehouseMovementsTable.status, "active")];
  if (opts.inventoryItemId) {
    conditions.push(eq(v3WarehouseMovementsTable.inventoryItemId, opts.inventoryItemId));
  }
  if (opts.movementType) {
    const types = Array.isArray(opts.movementType) ? opts.movementType : [opts.movementType];
    if (types.length === 1) {
      conditions.push(eq(v3WarehouseMovementsTable.movementType, types[0]!));
    } else {
      conditions.push(
        or(...types.map((t) => eq(v3WarehouseMovementsTable.movementType, t)))!,
      );
    }
  }
  if (opts.fromDate) {
    conditions.push(sql`${v3WarehouseMovementsTable.movementDate} >= ${opts.fromDate}`);
  }
  if (opts.toDate) {
    conditions.push(sql`${v3WarehouseMovementsTable.movementDate} <= ${opts.toDate}`);
  }

  const rows = await db
    .select({
      movement: v3WarehouseMovementsTable,
      itemName: v3InventoryItemsTable.name,
      itemUnit: v3InventoryItemsTable.baseUnit,
      category: v3InventoryItemsTable.category,
    })
    .from(v3WarehouseMovementsTable)
    .leftJoin(
      v3InventoryItemsTable,
      eq(v3WarehouseMovementsTable.inventoryItemId, v3InventoryItemsTable.id),
    )
    .where(and(...conditions))
    .orderBy(desc(v3WarehouseMovementsTable.movementDate), desc(v3WarehouseMovementsTable.id));

  let filtered = rows;
  if (opts.q?.trim()) {
    const q = opts.q.trim().toLowerCase();
    filtered = rows.filter((r) => {
      const name = (r.itemName || r.movement.originalNameRaw || "").toLowerCase();
      return name.includes(q);
    });
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize).map((r) => ({
      ...r.movement,
      itemName: r.itemName || r.movement.originalNameRaw || "",
      itemUnit: r.itemUnit || r.movement.unitRaw || "",
      category: r.category || "",
    })),
    total,
    page,
    pageSize,
  };
}

export async function listKitchenStock() {
  const items = await db
    .select()
    .from(v3InventoryItemsTable)
    .where(eq(v3InventoryItemsTable.isActive, true))
    .orderBy(v3InventoryItemsTable.name);

  const lastIn = await db.execute(sql`
    SELECT DISTINCT ON (inventory_item_id)
      inventory_item_id AS id,
      movement_date AS last_date,
      quantity_raw,
      unit_raw
    FROM v3_warehouse_movements
    WHERE movement_type IN ('WAREHOUSE_TO_KITCHEN', 'KITCHEN_DIRECT_IN')
      AND status = 'active'
      AND inventory_item_id IS NOT NULL
    ORDER BY inventory_item_id, movement_date DESC, id DESC
  `);
  const lastRows = ((lastIn as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(lastIn) ? (lastIn as Array<Record<string, unknown>>) : [])) as Array<Record<string, unknown>>;
  const lastMap = new Map(lastRows.map((r) => [Number(r.id), r]));

  // Distinct unit_raw values among kitchen-affecting movements (for review flags).
  const unitMix = await db.execute(sql`
    SELECT inventory_item_id AS id, unit_raw
    FROM v3_warehouse_movements
    WHERE movement_type IN ('WAREHOUSE_TO_KITCHEN', 'KITCHEN_DIRECT_IN')
      AND status = 'active'
      AND inventory_item_id IS NOT NULL
      AND NULLIF(TRIM(unit_raw), '') IS NOT NULL
  `);
  const mixRows = ((unitMix as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(unitMix) ? (unitMix as Array<Record<string, unknown>>) : [])) as Array<Record<string, unknown>>;
  const mixMap = new Map<number, string[]>();
  for (const r of mixRows) {
    const id = Number(r.id);
    const u = String(r.unit_raw || "").trim();
    if (!u) continue;
    const list = mixMap.get(id) || [];
    if (!list.includes(u)) list.push(u);
    mixMap.set(id, list);
  }

  const fromItems = items
    .filter((i) => Number(i.kitchenQtyNumeric || 0) > 0)
    .map((i) => {
      const last = lastMap.get(i.id);
      const lastUnitRaw = last?.unit_raw ? String(last.unit_raw) : null;
      const unitKeys = (mixMap.get(i.id) || []).map(normalizeKitchenUnitKey);
      const distinctKeys = [...new Set(unitKeys.filter((k): k is string => Boolean(k)))];
      const hasAmbiguous = (mixMap.get(i.id) || []).some((u) => normalizeKitchenUnitKey(u) == null);
      const unitNeedsReview = hasAmbiguous || distinctKeys.length > 1;
      const displayUnit = resolveKitchenDisplayUnit(i.baseUnit, lastUnitRaw);

      return {
        id: i.id,
        name: i.name,
        category: i.category,
        /** Catalog unit as stored (may be polluted historical text like "3 كيلو"). */
        baseUnit: i.baseUnit,
        /** Clean unit for the stock page — never a second quantity. */
        displayUnit,
        kitchenQty: Number(i.kitchenQtyNumeric || 0),
        lastTransferDate: last?.last_date ? String(last.last_date) : null,
        lastUpdated: last?.last_date ? String(last.last_date) : null,
        unitNeedsReview,
        source: "ITEM" as const,
      };
    });

  // Legacy / edge free-text kitchen-direct rows (no inventory_item_id) must still show.
  const freeText = await db.execute(sql`
    SELECT
      COALESCE(NULLIF(TRIM(original_name_raw), ''), '—') AS name,
      COALESCE(SUM(quantity_numeric), 0) AS kitchen_qty,
      MAX(movement_date) AS last_date,
      MAX(unit_raw) AS unit_raw
    FROM v3_warehouse_movements
    WHERE movement_type = 'KITCHEN_DIRECT_IN'
      AND status = 'active'
      AND inventory_item_id IS NULL
      AND quantity_numeric IS NOT NULL
    GROUP BY COALESCE(NULLIF(TRIM(original_name_raw), ''), '—')
    HAVING COALESCE(SUM(quantity_numeric), 0) > 0
  `);
  const freeRows = ((freeText as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(freeText) ? (freeText as Array<Record<string, unknown>>) : [])) as Array<Record<string, unknown>>;

  const fromFree = freeRows.map((r, idx) => {
    const unitRaw = r.unit_raw ? String(r.unit_raw) : "";
    return {
      id: -1000 - idx,
      name: String(r.name || "—"),
      category: "",
      baseUnit: unitRaw,
      displayUnit: resolveKitchenDisplayUnit("", unitRaw),
      kitchenQty: Number(r.kitchen_qty || 0),
      lastTransferDate: r.last_date ? String(r.last_date) : null,
      lastUpdated: r.last_date ? String(r.last_date) : null,
      unitNeedsReview: normalizeKitchenUnitKey(unitRaw) == null && Boolean(unitRaw.trim()),
      source: "FREE_TEXT" as const,
    };
  });

  return [...fromItems, ...fromFree].sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

/** Normalize kitchen units for compatibility checks. Digits ⇒ ambiguous (e.g. "3 كيلو"). */
export function normalizeKitchenUnitKey(unit: string | null | undefined): string | null {
  const s = String(unit || "").trim().toLowerCase();
  if (!s) return null;
  if (/\d/.test(s)) return null;
  const compact = s.replace(/\s+/g, "");
  if (["kg", "كيلو", "كغ", "كجم", "كilo", "kilogram", "كيلوغرام"].includes(compact) || compact.includes("كيلو")) {
    return "kg";
  }
  if (["l", "liter", "litre", "لتر", "ليتر"].includes(compact) || compact.includes("لتر")) {
    return "l";
  }
  if (["pcs", "pc", "piece", "قطعة", "حبة", "حبه", "قطعة"].includes(compact)) {
    return "pcs";
  }
  if (["g", "gram", "غرام", "جم"].includes(compact)) return "g";
  return compact;
}

/**
 * Prefer a clean unit for the Kitchen stock page.
 * Never surface polluted catalog values like "3 كيلو" as if they were a second stock qty.
 */
export function resolveKitchenDisplayUnit(
  baseUnit: string | null | undefined,
  lastUnitRaw: string | null | undefined,
): string {
  const last = String(lastUnitRaw || "").trim();
  const base = String(baseUnit || "").trim();
  if (last && normalizeKitchenUnitKey(last)) {
    const key = normalizeKitchenUnitKey(last)!;
    if (key === "kg") return "kg";
    if (key === "l") return "L";
    return last;
  }
  if (base && normalizeKitchenUnitKey(base)) return base;
  // Polluted "3 كيلو" → extract trailing unit word if possible
  for (const candidate of [last, base]) {
    if (!candidate) continue;
    const m = candidate.match(/(?:^|\s)(kg|كيلو|كغ|كجم|لتر|ليتر|قطعة|حبة|g|غرام)\s*$/i);
    if (m?.[1]) {
      const key = normalizeKitchenUnitKey(m[1]);
      if (key === "kg") return "kg";
      if (key === "l") return "L";
      return m[1];
    }
  }
  if (last && !/\d/.test(last)) return last;
  return "—";
}

export async function voidMovement(input: {
  movementId: number;
  voidedBy: string;
  voidReason: string;
}) {
  return db.transaction(async (tx) => {
    const mov = await tx.query.v3WarehouseMovementsTable.findFirst({
      where: eq(v3WarehouseMovementsTable.id, input.movementId),
    });
    if (!mov) throw new AppError("MOVEMENT_NOT_FOUND", "الحركة غير موجودة", 404);
    if (mov.status === "voided") return { idempotent: true as const, movement: mov };
    const [updated] = await tx
      .update(v3WarehouseMovementsTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: input.voidedBy,
        voidReason: input.voidReason,
      })
      .where(eq(v3WarehouseMovementsTable.id, input.movementId))
      .returning();
    if (mov.inventoryItemId != null) {
      await recomputeItemBalances(tx, mov.inventoryItemId);
    }
    return { idempotent: false as const, movement: updated };
  });
}
export async function getItemByQr(qrToken: string) {
  const item = await db.query.v3InventoryItemsTable.findFirst({
    where: eq(v3InventoryItemsTable.qrToken, qrToken),
  });
  if (!item) throw new AppError("ITEM_NOT_FOUND", "لا يوجد صنف لهذا الرمز", 404);
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    baseUnit: item.baseUnit,
    warehouseQtyNumeric: item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric),
    kitchenQtyNumeric: item.kitchenQtyNumeric == null ? null : Number(item.kitchenQtyNumeric),
    status: stockStatus(
      item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric),
      item.minimumStock == null ? null : Number(item.minimumStock),
    ),
    qrToken: item.qrToken,
  };
}

export async function listItemsBrief(q?: string) {
  const conditions = [eq(v3InventoryItemsTable.isActive, true)];
  if (q?.trim()) conditions.push(ilike(v3InventoryItemsTable.name, `%${q.trim()}%`));
  const presenceIds = await loadWarehousePresenceItemIds();
  const rows = await db
    .select({
      id: v3InventoryItemsTable.id,
      name: v3InventoryItemsTable.name,
      category: v3InventoryItemsTable.category,
      baseUnit: v3InventoryItemsTable.baseUnit,
      warehouseQtyNumeric: v3InventoryItemsTable.warehouseQtyNumeric,
      sourceType: v3InventoryItemsTable.sourceType,
    })
    .from(v3InventoryItemsTable)
    .where(and(...conditions))
    .orderBy(v3InventoryItemsTable.name)
    .limit(300);
  return rows
    .filter((r) => isWarehouseCatalogItem(r, presenceIds))
    .slice(0, 100)
    .map(({ sourceType: _sourceType, ...rest }) => rest);
}
