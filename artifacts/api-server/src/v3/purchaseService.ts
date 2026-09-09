/**
 * GIA V3 Purchases — simple permanent register (no archives).
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
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

export async function createPurchase(input: {
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
  purchasedBy?: string;
  destination: V3PurchaseDestination;
  notes?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  const existing = await findPurchaseByClient(input.clientRequestId);
  if (existing) return { idempotent: true as const, purchase: existing };

  const dest = input.destination;
  if (!["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"].includes(dest)) {
    throw new AppError("VALIDATION_ERROR", "يجب اختيار وجهة المشتريات بوضوح");
  }

  const itemName = (input.itemName || input.newItem?.name || "").trim();
  if (!itemName) throw new AppError("VALIDATION_ERROR", "اسم المادة / الغرض مطلوب");

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

  if ((dest === "WAREHOUSE" || dest === "KITCHEN_DIRECT") && qtyNum != null && !(qtyNum > 0)) {
    throw new AppError("VALIDATION_ERROR", "كمية المخزون يجب أن تكون أكبر من صفر");
  }

  return db.transaction(async (tx) => {
    let inventoryItemId = input.inventoryItemId ?? null;

    if (dest === "WAREHOUSE" || dest === "KITCHEN_DIRECT") {
      if (input.newItem?.name?.trim()) {
        const [created] = await tx
          .insert(v3InventoryItemsTable)
          .values({
            name: input.newItem.name.trim(),
            category: (input.newItem.category || "").trim(),
            baseUnit: (input.newItem.baseUnit || unitRaw || "").trim(),
            minimumStock: input.newItem.minimumStock ?? null,
            warehouseQtyNumeric: 0,
            kitchenQtyNumeric: 0,
            qrToken: `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            sourceType: "MANUAL",
          })
          .returning();
        inventoryItemId = created.id;
      } else if (inventoryItemId) {
        const item = await tx.query.v3InventoryItemsTable.findFirst({
          where: eq(v3InventoryItemsTable.id, inventoryItemId),
        });
        if (!item || !item.isActive) throw new AppError("ITEM_NOT_FOUND", "المادة غير موجودة", 404);
      } else {
        throw new AppError(
          "VALIDATION_ERROR",
          "اختر مادة موجودة أو أضف مادة جديدة للمشتريات التي تدخل المخزون/المطبخ",
        );
      }
    }

    const [purchase] = await tx
      .insert(v3PurchasesTable)
      .values({
        purchaseDate: input.purchaseDate || todayISO(),
        purchaseTime: input.purchaseTime || "",
        itemName,
        inventoryItemId,
        quantityNumeric: qtyNum,
        quantityRaw: qtyRaw || (qtyNum != null ? String(qtyNum) : ""),
        unitRaw,
        unitPrice: Number(input.unitPrice || 0),
        totalAmount: total,
        paidAmount: paid,
        paymentStatus,
        supplier: (input.supplier || "").trim(),
        purchasedBy: (input.purchasedBy || input.actor || "").trim(),
        destination: dest,
        notes: input.notes || null,
        actor: input.actor,
        userId: input.userId ?? null,
        clientRequestId: input.clientRequestId?.trim() || null,
      })
      .returning();

    let movementId: number | null = null;

    if (dest === "WAREHOUSE" && inventoryItemId) {
      if (qtyNum == null || !(qtyNum > 0)) {
        throw new AppError("VALIDATION_ERROR", "كمية رقمية مطلوبة لإضافة المستودع");
      }
      const [mov] = await tx
        .insert(v3WarehouseMovementsTable)
        .values({
          inventoryItemId,
          movementType: "WAREHOUSE_IN",
          quantityNumeric: qtyNum,
          quantityRaw: qtyRaw || String(qtyNum),
          unitRaw: unitRaw,
          movementDate: input.purchaseDate || todayISO(),
          supplier: (input.supplier || "").trim() || null,
          actor: input.actor,
          userId: input.userId ?? null,
          purchaseId: purchase.id,
          notes: input.notes || `مشتريات #${purchase.id}`,
          clientRequestId: input.clientRequestId?.trim()
            ? `${input.clientRequestId.trim()}:wh-in`
            : null,
        })
        .returning();
      movementId = mov.id;
      await recomputeItemBalances(tx as unknown as DbTx, inventoryItemId);
    }

    if (dest === "KITCHEN_DIRECT" && inventoryItemId) {
      if (qtyNum == null || !(qtyNum > 0)) {
        throw new AppError("VALIDATION_ERROR", "كمية رقمية مطلوبة لإضافة المطبخ");
      }
      const [mov] = await tx
        .insert(v3WarehouseMovementsTable)
        .values({
          inventoryItemId,
          movementType: "KITCHEN_DIRECT_IN",
          quantityNumeric: qtyNum,
          quantityRaw: qtyRaw || String(qtyNum),
          unitRaw: unitRaw,
          movementDate: input.purchaseDate || todayISO(),
          supplier: (input.supplier || "").trim() || null,
          actor: input.actor,
          userId: input.userId ?? null,
          purchaseId: purchase.id,
          notes: input.notes || `مشتريات مطبخ مباشرة #${purchase.id}`,
          clientRequestId: input.clientRequestId?.trim()
            ? `${input.clientRequestId.trim()}:kit-in`
            : null,
        })
        .returning();
      movementId = mov.id;
      await recomputeItemBalances(tx as unknown as DbTx, inventoryItemId);
    }

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

    return { idempotent: false as const, purchase: finalPurchase, movementId };
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

    // Void active payments (restores available capital)
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

    if (purchase.movementId) {
      const mov = await tx.query.v3WarehouseMovementsTable.findFirst({
        where: eq(v3WarehouseMovementsTable.id, purchase.movementId),
      });
      if (mov && mov.status === "active") {
        await tx
          .update(v3WarehouseMovementsTable)
          .set({
            status: "voided",
            voidedAt: new Date(),
            voidedBy: input.voidedBy,
            voidReason: input.voidReason || "إلغاء مشتريات",
          })
          .where(eq(v3WarehouseMovementsTable.id, mov.id));
        await recomputeItemBalances(tx as unknown as DbTx, mov.inventoryItemId);
      }
    }

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
