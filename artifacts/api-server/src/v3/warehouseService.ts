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
  if (warehouseQty <= 0) return "out";
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
  let adj = 0;
  let hasAnyNumeric = false;

  for (const r of rows) {
    if (r.quantityNumeric == null) continue;
    hasAnyNumeric = true;
    const q = Number(r.quantityNumeric);
    if (r.movementType === "OPENING") opening += q;
    else if (r.movementType === "WAREHOUSE_IN") inn += q;
    else if (r.movementType === "WAREHOUSE_TO_KITCHEN") out += q;
    else if (r.movementType === "ADJUSTMENT") adj += q;
  }

  const warehouse = hasAnyNumeric ? opening + inn - out + adj : null;
  const kitchen = hasAnyNumeric ? out : null;

  await tx
    .update(v3InventoryItemsTable)
    .set({
      warehouseQtyNumeric: warehouse,
      kitchenQtyNumeric: kitchen,
      updatedAt: new Date(),
    })
    .where(eq(v3InventoryItemsTable.id, itemId));

  return { warehouseQtyNumeric: warehouse, kitchenQtyNumeric: kitchen };
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

  let rows = all.map((item) => {
    const t = totMap.get(item.id) || { opening: 0, totalIn: 0, totalOut: 0 };
    const op = openingRaw.get(item.id);
    const current = item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
    const status = stockStatus(current, item.minimumStock == null ? null : Number(item.minimumStock));
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
    };
  });

  if (opts.status && opts.status !== "all") {
    rows = rows.filter((r) => r.status === opts.status);
  }

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const categories = [...new Set(all.map((i) => i.category).filter(Boolean))].sort();

  return { rows: pageRows, total, page, pageSize, categories };
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

    const qtyRaw = String(input.quantityRaw ?? "").trim();
    if (!qtyRaw) throw new AppError("VALIDATION_ERROR", "الكمية مطلوبة");
    const qtyNum =
      input.quantityNumeric === undefined
        ? parseStrictNumeric(qtyRaw)
        : input.quantityNumeric;
    if (qtyNum != null && !(qtyNum > 0)) {
      throw new AppError("VALIDATION_ERROR", "الكمية الرقمية يجب أن تكون أكبر من صفر");
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
    return { idempotent: false as const, opening, movement, balances, itemId: resolvedItemId };  };

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
}) {
  return postMovement("WAREHOUSE_TO_KITCHEN", input);
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

    if (movementType === "WAREHOUSE_TO_KITCHEN" && qtyNum != null) {
      if (!(qtyNum > 0)) throw new AppError("VALIDATION_ERROR", "الكمية يجب أن تكون أكبر من صفر");
      const available = item.warehouseQtyNumeric == null ? null : Number(item.warehouseQtyNumeric);
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
    }

    if ((movementType === "WAREHOUSE_IN" || movementType === "ADJUSTMENT") && qtyNum != null && !(qtyNum > 0) && movementType === "WAREHOUSE_IN") {
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
      })
      .returning();

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
    .innerJoin(
      v3InventoryItemsTable,
      eq(v3WarehouseMovementsTable.inventoryItemId, v3InventoryItemsTable.id),
    )
    .where(and(...conditions))
    .orderBy(desc(v3WarehouseMovementsTable.movementDate), desc(v3WarehouseMovementsTable.id));

  let filtered = rows;
  if (opts.q?.trim()) {
    const q = opts.q.trim().toLowerCase();
    filtered = rows.filter((r) => r.itemName.toLowerCase().includes(q));
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize).map((r) => ({
      ...r.movement,
      itemName: r.itemName,
      itemUnit: r.itemUnit,
      category: r.category,
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

  const lastOut = await db.execute(sql`
    SELECT DISTINCT ON (inventory_item_id)
      inventory_item_id AS id,
      movement_date AS last_date,
      quantity_raw,
      unit_raw
    FROM v3_warehouse_movements
    WHERE movement_type = 'WAREHOUSE_TO_KITCHEN' AND status = 'active'
    ORDER BY inventory_item_id, movement_date DESC, id DESC
  `);
  const lastRows = ((lastOut as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (Array.isArray(lastOut) ? (lastOut as Array<Record<string, unknown>>) : [])) as Array<Record<string, unknown>>;
  const lastMap = new Map(lastRows.map((r) => [Number(r.id), r]));

  return items
    .filter((i) => Number(i.kitchenQtyNumeric || 0) > 0)
    .map((i) => {
      const last = lastMap.get(i.id);
      return {
        id: i.id,
        name: i.name,
        category: i.category,
        baseUnit: i.baseUnit,
        kitchenQty: Number(i.kitchenQtyNumeric || 0),
        lastTransferDate: last?.last_date ? String(last.last_date) : null,
        lastQuantityRaw: last?.quantity_raw ? String(last.quantity_raw) : null,
        lastUnitRaw: last?.unit_raw ? String(last.unit_raw) : null,
      };
    });
}

/** Mobile-ready: get item by QR token without building QR UI. */
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
  return db
    .select({
      id: v3InventoryItemsTable.id,
      name: v3InventoryItemsTable.name,
      category: v3InventoryItemsTable.category,
      baseUnit: v3InventoryItemsTable.baseUnit,
      warehouseQtyNumeric: v3InventoryItemsTable.warehouseQtyNumeric,
    })
    .from(v3InventoryItemsTable)
    .where(and(...conditions))
    .orderBy(v3InventoryItemsTable.name)
    .limit(100);
}
