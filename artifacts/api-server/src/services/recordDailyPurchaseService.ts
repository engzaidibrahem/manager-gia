/**
 * Unified "Today's Purchases" recorder.
 *
 * destination=warehouse → existing atomic receiveGoods (stock + lot + optional payment)
 * destination=none     → purchase + optional payment only (no inventory)
 */

import { and, eq } from "drizzle-orm";
import { dailyPurchasesTable, db, purchasePaymentsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import { getAvailableCapitalSummary } from "./capitalService";
import { computePurchaseTotal } from "./purchaseService";
import { postPurchasePaymentInTx, voidPurchasePayment } from "./purchasePaymentService";
import { receiveGoods } from "./receiveGoodsService";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type RecordDailyPurchaseInput = {
  destination: "warehouse" | "none";
  itemName: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  supplier: string;
  paymentMethod?: string;
  paymentStatus?: "paid" | "unpaid";
  purchaseDate?: string;
  purchaseTime?: string;
  notes?: string;
  /** Warehouse only — existing item */
  inventoryItemId?: number | null;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
};

export async function recordDailyPurchase(input: RecordDailyPurchaseInput) {
  const destination = input.destination;
  if (destination !== "warehouse" && destination !== "none") {
    throw new AppError("VALIDATION_ERROR", "destination must be warehouse or none", 400);
  }

  const itemName = (input.itemName || "").trim();
  if (!itemName) throw new AppError("VALIDATION_ERROR", "itemName is required", 400);
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new AppError("VALIDATION_ERROR", "quantity must be positive", 400);
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
    throw new AppError("VALIDATION_ERROR", "unitPrice must be >= 0", 400);
  }
  const actor = (input.actor || "").trim();
  if (!actor) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);

  const unit = (input.unit || "").trim() || "pcs";
  const category = (input.category || "").trim() || "umum";
  const supplier = (input.supplier || "").trim() || "-";
  const paymentStatus = input.paymentStatus ?? "paid";
  const paymentMethod = (input.paymentMethod ?? "Transfer").trim() || "Transfer";
  const purchaseDate = input.purchaseDate || todayISO();
  const clientRequestId = input.clientRequestId?.trim() || undefined;

  if (destination === "warehouse") {
    return receiveGoods({
      inventoryItemId: input.inventoryItemId ?? null,
      newItem: input.inventoryItemId
        ? undefined
        : {
          name: itemName,
          category,
          unit,
          costPerUnit: input.unitPrice,
        },
      quantity: input.quantity,
      unit,
      unitPrice: input.unitPrice,
      supplier,
      paymentMethod,
      paymentStatus,
      purchaseDate,
      purchaseTime: input.purchaseTime ?? nowTime(),
      notes: input.notes,
      actor,
      userId: input.userId ?? null,
      clientRequestId,
    });
  }

  // Normal / consumable — purchase + optional payment, no stock
  const totalAmount = computePurchaseTotal(input.quantity, input.unitPrice);
  const payClientRequestId = clientRequestId ? `pay:${clientRequestId}` : undefined;

  const result = await db.transaction(async (tx) => {
    if (payClientRequestId) {
      const [existingPay] = await tx.select().from(purchasePaymentsTable)
        .where(eq(purchasePaymentsTable.clientRequestId, payClientRequestId))
        .limit(1);
      if (existingPay) {
        const purchase = await tx.query.dailyPurchasesTable.findFirst({
          where: eq(dailyPurchasesTable.id, existingPay.purchaseId),
        });
        return {
          purchase: purchase!,
          payment: {
            ...existingPay,
            amount: Number(existingPay.amount),
            createdAt: existingPay.createdAt instanceof Date
              ? existingPay.createdAt.toISOString()
              : String(existingPay.createdAt),
            voidedAt: existingPay.voidedAt
              ? (existingPay.voidedAt instanceof Date
                ? existingPay.voidedAt.toISOString()
                : String(existingPay.voidedAt))
              : null,
          },
          paymentIdempotent: true as const,
        };
      }
    }

    const [purchase] = await tx.insert(dailyPurchasesTable).values({
      purchaseDate,
      purchaseTime: input.purchaseTime ?? nowTime(),
      supplier,
      itemName,
      category,
      quantity: input.quantity,
      unit,
      unitPrice: input.unitPrice,
      totalAmount,
      paidBy: actor,
      receivedBy: "-",
      paymentMethod,
      inventoryItemId: null,
      destination: "none",
      addToStock: "no",
      status: "ordered",
      quantityReceived: 0,
      invoiceNumber: "",
      notes: input.notes ?? "",
    }).returning();

    let payment = null as Awaited<ReturnType<typeof postPurchasePaymentInTx>>["payment"] | null;
    let paymentIdempotent = false;
    if (paymentStatus === "paid") {
      const payResult = await postPurchasePaymentInTx(tx, {
        purchaseId: purchase!.id,
        amount: totalAmount,
        paymentDate: purchaseDate,
        paymentMethod,
        actor,
        userId: input.userId ?? null,
        notes: input.notes,
        clientRequestId: payClientRequestId,
      });
      payment = payResult.payment;
      paymentIdempotent = payResult.idempotent;
    }

    return { purchase, payment, paymentIdempotent };
  });

  const available = await getAvailableCapitalSummary();
  return {
    success: true as const,
    itemId: null as number | null,
    createdItem: null,
    purchase: result.purchase,
    payment: result.payment,
    paymentIdempotent: result.paymentIdempotent,
    receive: null,
    availableCapital: available.availableCapital,
    availableSummary: available,
  };
}

/**
 * Soft-cancel a purchase that has never been received into warehouse.
 * Voids any active purchase_payment (Available Capital restored once).
 * Does not delete the purchase row.
 */
export async function cancelDailyPurchase(input: {
  purchaseId: number;
  actor: string;
  reason?: string;
}) {
  const actor = (input.actor || "").trim();
  if (!actor) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);

  const purchase = await db.query.dailyPurchasesTable.findFirst({
    where: eq(dailyPurchasesTable.id, input.purchaseId),
  });
  if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${input.purchaseId} not found`, 404);
  if (purchase.status === "cancelled") {
    return { purchase, alreadyCancelled: true as const, paymentVoided: false };
  }
  if (Number(purchase.quantityReceived || 0) > 0.0001 || purchase.status === "received" || purchase.status === "partially_received") {
    throw new AppError(
      "PURCHASE_HAS_RECEIVING",
      "Cannot cancel after warehouse receive. Reverse the receive first, then cancel.",
      409,
    );
  }

  const [activePay] = await db.select().from(purchasePaymentsTable)
    .where(and(
      eq(purchasePaymentsTable.purchaseId, input.purchaseId),
      eq(purchasePaymentsTable.status, "active"),
    ))
    .limit(1);

  let paymentVoided = false;
  if (activePay) {
    await voidPurchasePayment({
      id: activePay.id,
      actor,
      reason: input.reason ?? "purchase cancelled",
    });
    paymentVoided = true;
  }

  const [updated] = await db.update(dailyPurchasesTable).set({
    status: "cancelled",
  }).where(eq(dailyPurchasesTable.id, input.purchaseId)).returning();

  const available = await getAvailableCapitalSummary();
  return {
    purchase: updated ?? purchase,
    alreadyCancelled: false as const,
    paymentVoided,
    availableCapital: available.availableCapital,
  };
}
