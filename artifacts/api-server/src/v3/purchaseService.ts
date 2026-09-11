/**
 * GIA V3 Purchases — simple permanent register (no archives).
 * Destination drives atomic stock effects; edits reverse then re-apply.
 */
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  v3InventoryItemsTable,
  v3PurchasePaymentsTable,
  v3PurchasesTable,
  v3WarehouseMovementsTable,
  type V3PaymentStatus,
  type V3PurchaseDestination,
} from "@workspace/db";
import { AppError } from "../lib/errors";
import { recomputeItemBalances, type DbTx } from "./warehouseService";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolvePaymentStatus(total: number, paid: number): V3PaymentStatus {
  if (paid <= 0) return "UNPAID";
  if (paid + 1e-9 >= total) return "PAID";
  return "PARTIAL";
}

async function findPurchaseByClient(clientRequestId?: string) {
  if (!clientRequestId?.trim()) return null;
  return db.query.v3PurchasesTable.findFirst({
    where: eq(v3PurchasesTable.clientRequestId, clientRequestId.trim()),
  });
}

async function findActiveItemByName(tx: DbTx | typeof db, name: string) {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const rows = await tx
    .select()
    .from(v3InventoryItemsTable)
    .where(eq(v3InventoryItemsTable.isActive, true));
  return rows.find((r) => r.name.trim().toLowerCase() === needle) ?? null;
}

export async function listPurchases(opts: {
  q?: string;
  fromDate?: string;
  toDate?: string;
  destination?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const conditions = [eq(v3PurchasesTable.status, "active")];
  if (opts.fromDate) conditions.push(gte(v3PurchasesTable.purchaseDate, opts.fromDate));
  if (opts.toDate) conditions.push(lte(v3PurchasesTable.purchaseDate, opts.toDate));
  if (opts.destination?.trim()) conditions.push(eq(v3PurchasesTable.destination, opts.destination.trim()));

  const rows = await db
    .select()
    .from(v3PurchasesTable)
    .where(and(...conditions))
    .orderBy(desc(v3PurchasesTable.purchaseDate), desc(v3PurchasesTable.id));

  let filtered = rows;
  if (opts.q?.trim()) {
    const q = opts.q.trim().toLowerCase();
    filtered = rows.filter(
      (r) =>
        r.itemName.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q) ||
        r.purchasedBy.toLowerCase().includes(q) ||
        (r.invoiceNumber || "").toLowerCase().includes(q) ||
        (r.notes || "").toLowerCase().includes(q),
    );
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    rows: filtered.slice(start, start + pageSize).map((r) => ({
      ...r,
      totalAmount: Number(r.totalAmount),
      paidAmount: Number(r.paidAmount),
      unitPrice: Number(r.unitPrice),
      remainingAmount: Number(r.totalAmount) - Number(r.paidAmount),
      quantityNumeric: r.quantityNumeric == null ? null : Number(r.quantityNumeric),
    })),
    total,
    page,
    pageSize,
  };
}

type ResolveInput = {
  dest: V3PurchaseDestination;
  itemName: string;
  inventoryItemId?: number | null;
  newItem?: { name: string; category?: string; baseUnit?: string; minimumStock?: number | null } | null;
  unitRaw: string;
};

async function resolveInventoryForDestination(
  tx: DbTx | typeof db,
  input: ResolveInput,
): Promise<{ inventoryItemId: number | null; resolvedName: string }> {
  const dest = input.dest;
  let inventoryItemId: number | null = null;
  let resolvedName = (input.itemName || input.newItem?.name || "").trim();

  if (dest === "CONSUMABLE") {
    if (!resolvedName) {
      throw new AppError("VALIDATION_ERROR", "اسم المادة / الغرض مطلوب");
    }
    return { inventoryItemId: null, resolvedName };
  }

  if (dest === "WAREHOUSE") {
    if (input.newItem?.name?.trim()) {
      const existing = await findActiveItemByName(tx, input.newItem.name);
      if (existing) {
        inventoryItemId = existing.id;
        resolvedName = existing.name;
      } else {
        const [created] = await tx
          .insert(v3InventoryItemsTable)
          .values({
            name: input.newItem.name.trim(),
            category: (input.newItem.category || "").trim(),
            baseUnit: (input.newItem.baseUnit || input.unitRaw || "").trim(),
            minimumStock: input.newItem.minimumStock ?? null,
            warehouseQtyNumeric: 0,
            kitchenQtyNumeric: 0,
            qrToken: `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            sourceType: "MANUAL",
          })
          .returning();
        inventoryItemId = created.id;
        resolvedName = created.name;
      }
    } else if (input.inventoryItemId) {
      const item = await tx.query.v3InventoryItemsTable.findFirst({
        where: eq(v3InventoryItemsTable.id, input.inventoryItemId),
      });
      if (!item || !item.isActive) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
      inventoryItemId = item.id;
      resolvedName = resolvedName || item.name;
    } else if (resolvedName) {
      const existing = await findActiveItemByName(tx, resolvedName);
      if (existing) {
        inventoryItemId = existing.id;
        resolvedName = existing.name;
      } else {
        const [created] = await tx
          .insert(v3InventoryItemsTable)
          .values({
            name: resolvedName,
            category: "",
            baseUnit: input.unitRaw || "",
            minimumStock: null,
            warehouseQtyNumeric: 0,
            kitchenQtyNumeric: 0,
            qrToken: `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            sourceType: "MANUAL",
          })
          .returning();
        inventoryItemId = created.id;
        resolvedName = created.name;
      }
    } else {
      throw new AppError(
        "VALIDATION_ERROR",
        "اختر مادة موجودة أو أضف مادة جديدة لمشتريات المستودع",
      );
    }
    return { inventoryItemId, resolvedName };
  }

  // KITCHEN_DIRECT
  if (!resolvedName && !input.inventoryItemId) {
    throw new AppError("VALIDATION_ERROR", "اسم المادة مطلوب");
  }
  if (input.inventoryItemId) {
    const item = await tx.query.v3InventoryItemsTable.findFirst({
      where: eq(v3InventoryItemsTable.id, input.inventoryItemId),
    });
    if (!item || !item.isActive) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
    inventoryItemId = item.id;
    resolvedName = resolvedName || item.name;
  } else {
    const existing = await findActiveItemByName(tx, resolvedName);
    if (existing) {
      inventoryItemId = existing.id;
      resolvedName = existing.name;
    } else {
      const [created] = await tx
        .insert(v3InventoryItemsTable)
        .values({
          name: resolvedName,
          category: (input.newItem?.category || "").trim(),
          baseUnit: (input.newItem?.baseUnit || input.unitRaw || "").trim(),
          minimumStock: input.newItem?.minimumStock ?? null,
          // Kitchen-only identity: no warehouse stock until a real WH ledger exists.
          warehouseQtyNumeric: null,
          kitchenQtyNumeric: 0,
          qrToken: `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          sourceType: "KITCHEN_DIRECT",
          originalNameRaw: resolvedName,
        })
        .returning();
      inventoryItemId = created.id;
    }
  }
  return { inventoryItemId, resolvedName };
}

async function voidActivePurchaseMovements(
  tx: DbTx | typeof db,
  purchaseId: number,
  movementId: number | null | undefined,
  voidedBy: string,
  voidReason: string,
) {
  const touched = new Set<number>();

  const byPurchase = await tx
    .select()
    .from(v3WarehouseMovementsTable)
    .where(
      and(
        eq(v3WarehouseMovementsTable.purchaseId, purchaseId),
        eq(v3WarehouseMovementsTable.status, "active"),
      ),
    );

  const extra =
    movementId != null
      ? await tx.query.v3WarehouseMovementsTable.findFirst({
          where: and(
            eq(v3WarehouseMovementsTable.id, movementId),
            eq(v3WarehouseMovementsTable.status, "active"),
          ),
        })
      : null;

  const all = [...byPurchase];
  if (extra && !all.some((m) => m.id === extra.id)) all.push(extra);

  for (const mov of all) {
    await tx
      .update(v3WarehouseMovementsTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy,
        voidReason,
      })
      .where(eq(v3WarehouseMovementsTable.id, mov.id));
    if (mov.inventoryItemId != null) touched.add(mov.inventoryItemId);
  }

  for (const itemId of touched) {
    await recomputeItemBalances(tx as unknown as DbTx, itemId);
  }

  return touched;
}

async function applyDestinationStockEffect(
  tx: DbTx | typeof db,
  opts: {
    dest: V3PurchaseDestination;
    purchaseId: number;
    inventoryItemId: number | null;
    resolvedName: string;
    qtyNum: number | null;
    qtyRaw: string;
    unitRaw: string;
    purchaseDate: string;
    supplier: string;
    actor: string;
    userId?: number | null;
    notes?: string | null;
    clientRequestId?: string | null;
  },
): Promise<number | null> {
  const { dest, inventoryItemId, qtyNum } = opts;

  if (dest === "CONSUMABLE") return null;

  if (qtyNum == null || !(qtyNum > 0)) {
    throw new AppError(
      "VALIDATION_ERROR",
      dest === "WAREHOUSE" ? "كمية رقمية مطلوبة لإضافة المستودع" : "كمية رقمية مطلوبة لإضافة المطبخ",
    );
  }
  if (inventoryItemId == null) {
    throw new AppError(
      "VALIDATION_ERROR",
      dest === "WAREHOUSE" ? "تعذر ربط مادة المستودع" : "تعذر إنشاء مادة المطبخ",
    );
  }

  const movementType = dest === "WAREHOUSE" ? "WAREHOUSE_IN" : "KITCHEN_DIRECT_IN";
  const suffix = dest === "WAREHOUSE" ? "wh-in" : "kit-in";
  const defaultNotes =
    dest === "WAREHOUSE"
      ? `مشتريات #${opts.purchaseId}`
      : `مشتريات مطبخ مباشرة #${opts.purchaseId}`;

  const [mov] = await tx
    .insert(v3WarehouseMovementsTable)
    .values({
      inventoryItemId,
      movementType,
      quantityNumeric: qtyNum,
      quantityRaw: opts.qtyRaw || String(qtyNum),
      unitRaw: opts.unitRaw,
      movementDate: opts.purchaseDate,
      supplier: opts.supplier || null,
      actor: opts.actor,
      userId: opts.userId ?? null,
      purchaseId: opts.purchaseId,
      originalNameRaw: dest === "KITCHEN_DIRECT" ? opts.resolvedName : null,
      notes: opts.notes || defaultNotes,
      clientRequestId: opts.clientRequestId?.trim()
        ? `${opts.clientRequestId.trim()}:${suffix}:${Date.now()}`
        : null,
    })
    .returning();

  await recomputeItemBalances(tx as unknown as DbTx, inventoryItemId);
  return mov.id;
}

export type CreatePurchaseInput = {
  purchaseDate?: string;
  purchaseTime?: string;
  itemName: string;
  inventoryItemId?: number | null;
  newItem?: { name: string; category?: string; baseUnit?: string; minimumStock?: number | null } | null;
  quantityNumeric?: number | null;
  quantityRaw?: string;
  unitRaw?: string;
  unitPrice?: number;
  totalAmount: number;
  paidAmount?: number;
  paymentStatus?: V3PaymentStatus;
  supplier?: string;
  invoiceNumber?: string | null;
  purchasedBy?: string;
  destination: V3PurchaseDestination;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
};

export type CreatePurchaseResult = {
  idempotent: boolean;
  committed: true;
  purchase: typeof v3PurchasesTable.$inferSelect;
  purchaseId: number;
  inventoryItemId: number | null;
  movementId: number | null;
  destination: string;
  quantityNumeric: number | null;
  paymentStatus: string;
};

async function findPurchaseByClientInTx(tx: DbTx | typeof db, clientRequestId?: string) {
  if (!clientRequestId?.trim()) return null;
  return tx.query.v3PurchasesTable.findFirst({
    where: eq(v3PurchasesTable.clientRequestId, clientRequestId.trim()),
  });
}

/** Create purchase inside an existing transaction (batch import). */
export async function createPurchaseInTx(
  tx: DbTx,
  input: CreatePurchaseInput,
): Promise<CreatePurchaseResult> {
  const existing = await findPurchaseByClientInTx(tx, input.clientRequestId);
  if (existing) {
    return {
      idempotent: true,
      committed: true as const,
      purchase: existing,
      purchaseId: existing.id,
      inventoryItemId: existing.inventoryItemId ?? null,
      movementId: existing.movementId ?? null,
      destination: existing.destination,
      quantityNumeric: existing.quantityNumeric == null ? null : Number(existing.quantityNumeric),
      paymentStatus: existing.paymentStatus,
    };
  }

  const dest = input.destination;
  if (!["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"].includes(dest)) {
    throw new AppError("VALIDATION_ERROR", "يجب اختيار وجهة المشتريات بوضوح");
  }

  const itemName = (input.itemName || input.newItem?.name || "").trim();
  if (dest !== "WAREHOUSE" && !itemName) {
    throw new AppError(
      "VALIDATION_ERROR",
      dest === "CONSUMABLE" ? "اسم المادة / الغرض مطلوب" : "اسم المادة مطلوب",
    );
  }
  if (
    dest === "WAREHOUSE" &&
    !itemName &&
    !input.inventoryItemId &&
    !input.newItem?.name?.trim()
  ) {
    throw new AppError("VALIDATION_ERROR", "اختر مادة موجودة أو أضف مادة جديدة لمشتريات المستودع");
  }

  const total = Number(input.totalAmount);
  if (!(total >= 0) || !Number.isFinite(total)) {
    throw new AppError("VALIDATION_ERROR", "الإجمالي غير صالح");
  }

  let paid = input.paidAmount != null ? Number(input.paidAmount) : 0;
  if (input.paymentStatus === "PAID") paid = total;
  if (input.paymentStatus === "UNPAID") paid = 0;
  if (paid < 0 || paid > total + 1e-9) {
    throw new AppError("VALIDATION_ERROR", "المبلغ المدفوع غير صالح");
  }
  const paymentStatus = resolvePaymentStatus(total, paid);

  const qtyRaw = (input.quantityRaw || (input.quantityNumeric != null ? String(input.quantityNumeric) : "")).trim();
  const unitRaw = (input.unitRaw || "").trim();
  const qtyNum = input.quantityNumeric === undefined ? null : input.quantityNumeric;

  if ((dest === "WAREHOUSE" || dest === "KITCHEN_DIRECT") && (qtyNum == null || !(qtyNum > 0))) {
    throw new AppError("VALIDATION_ERROR", "كمية المخزون يجب أن تكون أكبر من صفر");
  }

  const { inventoryItemId, resolvedName } = await resolveInventoryForDestination(tx, {
    dest,
    itemName,
    inventoryItemId: input.inventoryItemId,
    newItem: input.newItem,
    unitRaw,
  });

  const invoiceNumber = (input.invoiceNumber || "").trim() || null;

  const [purchase] = await tx
    .insert(v3PurchasesTable)
    .values({
      purchaseDate: input.purchaseDate || todayISO(),
      purchaseTime: input.purchaseTime || "",
      itemName: resolvedName,
      inventoryItemId,
      quantityNumeric: qtyNum,
      quantityRaw: qtyRaw || (qtyNum != null ? String(qtyNum) : ""),
      unitRaw,
      unitPrice: Number(input.unitPrice || 0),
      totalAmount: total,
      paidAmount: paid,
      paymentStatus,
      supplier: (input.supplier || "").trim(),
      invoiceNumber,
      purchasedBy: (input.purchasedBy || input.actor || "").trim(),
      destination: dest,
      notes: input.notes || null,
      actor: input.actor,
      userId: input.userId ?? null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();

  const movementId = await applyDestinationStockEffect(tx, {
    dest,
    purchaseId: purchase.id,
    inventoryItemId,
    resolvedName,
    qtyNum,
    qtyRaw,
    unitRaw,
    purchaseDate: input.purchaseDate || todayISO(),
    supplier: (input.supplier || "").trim(),
    actor: input.actor,
    userId: input.userId,
    notes: input.notes,
    clientRequestId: input.clientRequestId,
  });

  if (paid > 0) {
    await tx.insert(v3PurchasePaymentsTable).values({
      purchaseId: purchase.id,
      amount: paid,
      paymentDate: input.purchaseDate || todayISO(),
      paymentMethod: "نقداً",
      actor: input.actor,
      userId: input.userId ?? null,
      notes: "دفعة عند إنشاء المشتريات",
      clientRequestId: input.clientRequestId?.trim()
        ? `${input.clientRequestId.trim()}:pay-init`
        : null,
    });
  }

  if (movementId) {
    await tx
      .update(v3PurchasesTable)
      .set({ movementId, updatedAt: new Date() })
      .where(eq(v3PurchasesTable.id, purchase.id));
  }

  const finalPurchase = await tx.query.v3PurchasesTable.findFirst({
    where: eq(v3PurchasesTable.id, purchase.id),
  });
  if (!finalPurchase?.id) {
    throw new AppError("VALIDATION_ERROR", "تعذر تأكيد حفظ المشتريات بعد الالتزام", 500);
  }
  if (
    (dest === "WAREHOUSE" || dest === "KITCHEN_DIRECT") &&
    (movementId == null || finalPurchase.inventoryItemId == null)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "تعذر تأكيد حركة المخزون المرتبطة بالمشتريات",
      500,
    );
  }

  return {
    idempotent: false,
    committed: true as const,
    purchase: finalPurchase,
    purchaseId: finalPurchase.id,
    inventoryItemId: finalPurchase.inventoryItemId ?? null,
    movementId: movementId ?? finalPurchase.movementId ?? null,
    destination: finalPurchase.destination,
    quantityNumeric:
      finalPurchase.quantityNumeric == null ? null : Number(finalPurchase.quantityNumeric),
    paymentStatus: finalPurchase.paymentStatus,
  };
}

export async function createPurchase(input: CreatePurchaseInput): Promise<CreatePurchaseResult> {
  const existing = await findPurchaseByClient(input.clientRequestId);
  if (existing) {
    return {
      idempotent: true,
      committed: true as const,
      purchase: existing,
      purchaseId: existing.id,
      inventoryItemId: existing.inventoryItemId ?? null,
      movementId: existing.movementId ?? null,
      destination: existing.destination,
      quantityNumeric: existing.quantityNumeric == null ? null : Number(existing.quantityNumeric),
      paymentStatus: existing.paymentStatus,
    };
  }
  return db.transaction(async (tx) => createPurchaseInTx(tx as unknown as DbTx, input));
}

export async function updatePurchase(input: {
  purchaseId: number;
  purchaseDate?: string;
  purchaseTime?: string;
  itemName?: string;
  inventoryItemId?: number | null;
  newItem?: { name: string; category?: string; baseUnit?: string; minimumStock?: number | null } | null;
  quantityNumeric?: number | null;
  quantityRaw?: string;
  unitRaw?: string;
  unitPrice?: number;
  totalAmount?: number;
  supplier?: string;
  purchasedBy?: string;
  destination?: V3PurchaseDestination;
  notes?: string | null;
  actor: string;
  userId?: number | null;
}) {
  return db.transaction(async (tx) => {
    const purchase = await tx.query.v3PurchasesTable.findFirst({
      where: eq(v3PurchasesTable.id, input.purchaseId),
    });
    if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", "المشتريات غير موجودة", 404);
    if (purchase.status === "voided") {
      throw new AppError("VALIDATION_ERROR", "لا يمكن تعديل مشتريات ملغاة", 400);
    }

    const dest = (input.destination ?? purchase.destination) as V3PurchaseDestination;
    if (!["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"].includes(dest)) {
      throw new AppError("VALIDATION_ERROR", "يجب اختيار وجهة المشتريات بوضوح");
    }

    const total =
      input.totalAmount !== undefined ? Number(input.totalAmount) : Number(purchase.totalAmount);
    if (!(total >= 0) || !Number.isFinite(total)) {
      throw new AppError("VALIDATION_ERROR", "الإجمالي غير صالح");
    }

    const paid = Number(purchase.paidAmount);
    if (total + 1e-9 < paid) {
      throw new AppError(
        "VALIDATION_ERROR",
        `الإجمالي لا يمكن أن يكون أقل من المدفوع بالفعل (${paid})`,
      );
    }
    const paymentStatus = resolvePaymentStatus(total, paid);

    const qtyNum =
      input.quantityNumeric !== undefined
        ? input.quantityNumeric
        : purchase.quantityNumeric == null
          ? null
          : Number(purchase.quantityNumeric);
    const qtyRaw =
      input.quantityRaw !== undefined
        ? input.quantityRaw.trim()
        : purchase.quantityRaw || (qtyNum != null ? String(qtyNum) : "");
    const unitRaw =
      input.unitRaw !== undefined ? input.unitRaw.trim() : (purchase.unitRaw || "").trim();
    const itemName = (
      input.itemName ??
      input.newItem?.name ??
      purchase.itemName
    ).trim();

    if ((dest === "WAREHOUSE" || dest === "KITCHEN_DIRECT") && (qtyNum == null || !(qtyNum > 0))) {
      throw new AppError("VALIDATION_ERROR", "كمية المخزون يجب أن تكون أكبر من صفر");
    }

    // 1) Reverse previous stock effect explicitly (audit-preserving void).
    await voidActivePurchaseMovements(
      tx,
      purchase.id,
      purchase.movementId,
      input.actor,
      `تعديل مشتريات #${purchase.id}`,
    );

    // 2) Resolve inventory for the new destination.
    const { inventoryItemId, resolvedName } = await resolveInventoryForDestination(tx, {
      dest,
      itemName,
      inventoryItemId:
        input.inventoryItemId !== undefined ? input.inventoryItemId : purchase.inventoryItemId,
      newItem: input.newItem,
      unitRaw,
    });

    const purchaseDate = input.purchaseDate || purchase.purchaseDate;
    const supplier =
      input.supplier !== undefined ? input.supplier.trim() : (purchase.supplier || "").trim();
    const notes = input.notes !== undefined ? input.notes : purchase.notes;

    // 3) Apply new stock effect once.
    const movementId = await applyDestinationStockEffect(tx, {
      dest,
      purchaseId: purchase.id,
      inventoryItemId,
      resolvedName,
      qtyNum,
      qtyRaw,
      unitRaw,
      purchaseDate,
      supplier,
      actor: input.actor,
      userId: input.userId,
      notes,
      clientRequestId: `edit-p${purchase.id}`,
    });

    const [updated] = await tx
      .update(v3PurchasesTable)
      .set({
        purchaseDate,
        purchaseTime:
          input.purchaseTime !== undefined ? input.purchaseTime : purchase.purchaseTime,
        itemName: resolvedName,
        inventoryItemId,
        quantityNumeric: qtyNum,
        quantityRaw: qtyRaw || (qtyNum != null ? String(qtyNum) : ""),
        unitRaw,
        unitPrice:
          input.unitPrice !== undefined ? Number(input.unitPrice) : Number(purchase.unitPrice),
        totalAmount: total,
        paymentStatus,
        // paidAmount unchanged — payment ledger remains canonical
        supplier,
        purchasedBy:
          input.purchasedBy !== undefined
            ? input.purchasedBy.trim()
            : purchase.purchasedBy,
        destination: dest,
        notes: notes ?? null,
        movementId,
        updatedBy: input.actor,
        userId: input.userId ?? purchase.userId,
        updatedAt: new Date(),
      })
      .where(eq(v3PurchasesTable.id, purchase.id))
      .returning();

    return {
      committed: true as const,
      purchase: {
        ...updated,
        totalAmount: Number(updated.totalAmount),
        paidAmount: Number(updated.paidAmount),
        unitPrice: Number(updated.unitPrice),
        remainingAmount: Number(updated.totalAmount) - Number(updated.paidAmount),
        quantityNumeric: updated.quantityNumeric == null ? null : Number(updated.quantityNumeric),
      },
      purchaseId: updated.id,
      inventoryItemId: updated.inventoryItemId ?? null,
      movementId,
      destination: updated.destination,
      quantityNumeric: updated.quantityNumeric == null ? null : Number(updated.quantityNumeric),
      paymentStatus: updated.paymentStatus,
    };
  });
}

export async function addPurchasePayment(input: {
  purchaseId: number;
  amount: number;
  paymentDate?: string;
  paymentMethod?: string;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3PurchasePaymentsTable.findFirst({
      where: eq(v3PurchasePaymentsTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) return { idempotent: true as const, payment: existing };
  }

  const amount = Number(input.amount);
  if (!(amount > 0)) throw new AppError("VALIDATION_ERROR", "مبلغ الدفع يجب أن يكون أكبر من صفر");

  return db.transaction(async (tx) => {
    const purchase = await tx.query.v3PurchasesTable.findFirst({
      where: eq(v3PurchasesTable.id, input.purchaseId),
    });
    if (!purchase || purchase.status !== "active") {
      throw new AppError("PURCHASE_NOT_FOUND", "المشتريات غير موجودة", 404);
    }
    const total = Number(purchase.totalAmount);
    const already = Number(purchase.paidAmount);
    const remaining = total - already;
    if (amount > remaining + 1e-9) {
      throw new AppError("VALIDATION_ERROR", `المبلغ أكبر من المتبقي (${remaining})`);
    }

    const [payment] = await tx
      .insert(v3PurchasePaymentsTable)
      .values({
        purchaseId: purchase.id,
        amount,
        paymentDate: input.paymentDate || todayISO(),
        paymentMethod: input.paymentMethod || "نقداً",
        actor: input.actor,
        userId: input.userId ?? null,
        notes: input.notes || null,
        clientRequestId: input.clientRequestId?.trim() || null,
      })
      .returning();

    const newPaid = already + amount;
    const paymentStatus = resolvePaymentStatus(total, newPaid);
    await tx
      .update(v3PurchasesTable)
      .set({ paidAmount: newPaid, paymentStatus, updatedAt: new Date() })
      .where(eq(v3PurchasesTable.id, purchase.id));

    return { idempotent: false as const, payment, paidAmount: newPaid, paymentStatus, remaining: total - newPaid };
  });
}

export async function voidPurchase(input: {
  purchaseId: number;
  voidedBy: string;
  voidReason: string;
}) {
  return db.transaction(async (tx) => {
    const purchase = await tx.query.v3PurchasesTable.findFirst({
      where: eq(v3PurchasesTable.id, input.purchaseId),
    });
    if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", "المشتريات غير موجودة", 404);
    if (purchase.status === "voided") return { idempotent: true as const, purchase };

    const pays = await tx
      .select()
      .from(v3PurchasePaymentsTable)
      .where(
        and(
          eq(v3PurchasePaymentsTable.purchaseId, purchase.id),
          eq(v3PurchasePaymentsTable.status, "active"),
        ),
      );
    for (const p of pays) {
      await tx
        .update(v3PurchasePaymentsTable)
        .set({
          status: "voided",
          voidedAt: new Date(),
          voidedBy: input.voidedBy,
          voidReason: input.voidReason,
        })
        .where(eq(v3PurchasePaymentsTable.id, p.id));
    }

    await voidActivePurchaseMovements(
      tx,
      purchase.id,
      purchase.movementId,
      input.voidedBy,
      input.voidReason || "إلغاء مشتريات",
    );

    const [updated] = await tx
      .update(v3PurchasesTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: input.voidedBy,
        voidReason: input.voidReason,
        paidAmount: 0,
        paymentStatus: "UNPAID",
        updatedAt: new Date(),
      })
      .where(eq(v3PurchasesTable.id, purchase.id))
      .returning();

    return { idempotent: false as const, purchase: updated };
  });
}

export async function listPurchasePayments(purchaseId: number) {
  const rows = await db
    .select()
    .from(v3PurchasePaymentsTable)
    .where(
      and(
        eq(v3PurchasePaymentsTable.purchaseId, purchaseId),
        eq(v3PurchasePaymentsTable.status, "active"),
      ),
    )
    .orderBy(desc(v3PurchasePaymentsTable.paymentDate), desc(v3PurchasePaymentsTable.id));
  return {
    rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })),
  };
}

/** Active warehouse effect attributable to a purchase (WAREHOUSE_IN only). */
export async function sumActiveWarehouseInForPurchase(purchaseId: number) {
  const rows = await db
    .select({
      qty: sql<number>`coalesce(sum(${v3WarehouseMovementsTable.quantityNumeric}), 0)`,
    })
    .from(v3WarehouseMovementsTable)
    .where(
      and(
        eq(v3WarehouseMovementsTable.purchaseId, purchaseId),
        eq(v3WarehouseMovementsTable.status, "active"),
        eq(v3WarehouseMovementsTable.movementType, "WAREHOUSE_IN"),
      ),
    );
  return Number(rows[0]?.qty ?? 0);
}

export async function sumActiveKitchenInForPurchase(purchaseId: number) {
  const rows = await db
    .select({
      qty: sql<number>`coalesce(sum(${v3WarehouseMovementsTable.quantityNumeric}), 0)`,
    })
    .from(v3WarehouseMovementsTable)
    .where(
      and(
        eq(v3WarehouseMovementsTable.purchaseId, purchaseId),
        eq(v3WarehouseMovementsTable.status, "active"),
        eq(v3WarehouseMovementsTable.movementType, "KITCHEN_DIRECT_IN"),
      ),
    );
  return Number(rows[0]?.qty ?? 0);
}
