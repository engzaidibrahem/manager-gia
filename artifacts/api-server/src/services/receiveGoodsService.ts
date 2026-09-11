/**
 * Atomic Receive Goods:
 * optional create item + purchase + optional payment + warehouse receive.
 * All-or-nothing transaction.
 */

import { eq } from "drizzle-orm";
import { db, dailyPurchasesTable, inventoryItemsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import { getAvailableCapitalSummary } from "./capitalService";
import { computePurchaseTotal } from "./purchaseService";
import { postPurchasePaymentInTx } from "./purchasePaymentService";
import { receiveIntoWarehouse } from "./receivingService";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function newQrToken() {
  return `gia-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export type ReceiveGoodsInput = {
  inventoryItemId?: number | null;
  /** Create item when inventoryItemId omitted */
  newItem?: {
    name: string;
    category?: string;
    unit: string;
    minimumStock?: number;
    costPerUnit?: number;
    brand?: string;
  };
  quantity: number;
  unit?: string;
  unitPrice: number;
  supplier: string;
  paymentMethod?: string;
  paymentStatus?: "paid" | "unpaid";
  purchaseDate?: string;
  purchaseTime?: string;
  receivedBy?: string;
  notes?: string;
  brand?: string;
  invoiceNumber?: string;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
  /** Existing purchase to receive against (optional) */
  purchaseId?: number | null;
};

export async function receiveGoods(input: ReceiveGoodsInput) {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new AppError("VALIDATION_ERROR", "Quantity must be positive", 400);
  }
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) {
    throw new AppError("VALIDATION_ERROR", "Unit price must be >= 0", 400);
  }
  const actor = (input.actor || "").trim();
  if (!actor) throw new AppError("VALIDATION_ERROR", "Authenticated actor is required", 400);

  const paymentStatus = input.paymentStatus ?? "paid";
  const purchaseDate = input.purchaseDate || todayISO();
  const paymentMethod = (input.paymentMethod ?? "Transfer").trim() || "Transfer";
  const clientRequestId = input.clientRequestId?.trim() || undefined;

  const result = await db.transaction(async (tx) => {
    let itemId = input.inventoryItemId ?? null;
    let createdItem = null as typeof inventoryItemsTable.$inferSelect | null;

    if (!itemId) {
      const name = input.newItem?.name?.trim();
      const unit = input.newItem?.unit?.trim();
      if (!name || !unit) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Provide inventoryItemId or newItem.name + newItem.unit",
          400,
        );
      }
      const [item] = await tx.insert(inventoryItemsTable).values({
        name,
        category: (input.newItem?.category ?? "umum").trim() || "umum",
        unit,
        brand: input.newItem?.brand ?? input.brand ?? "",
        variant: "",
        qrToken: newQrToken(),
        currentStock: 0,
        kitchenStock: 0,
        minimumStock: input.newItem?.minimumStock ?? 0,
        costPerUnit: input.newItem?.costPerUnit ?? input.unitPrice,
      }).returning();
      createdItem = item!;
      itemId = item!.id;
    }

    let purchaseId = input.purchaseId ?? null;
    let purchase = null as typeof dailyPurchasesTable.$inferSelect | null;

    if (purchaseId) {
      purchase = await tx.query.dailyPurchasesTable.findFirst({
        where: eq(dailyPurchasesTable.id, purchaseId),
      }) ?? null;
      if (!purchase) throw new AppError("PURCHASE_NOT_FOUND", `Purchase ${purchaseId} not found`, 404);
    } else {
      const itemRow = createdItem
        ?? await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, itemId!) });
      const totalAmount = computePurchaseTotal(input.quantity, input.unitPrice);
      const [createdPurchase] = await tx.insert(dailyPurchasesTable).values({
        purchaseDate,
        purchaseTime: input.purchaseTime ?? nowTime(),
        supplier: input.supplier.trim() || "-",
        itemName: itemRow?.name ?? input.newItem?.name ?? "item",
        category: itemRow?.category ?? input.newItem?.category ?? "umum",
        quantity: input.quantity,
        unit: input.unit?.trim() || itemRow?.unit || input.newItem?.unit || "pcs",
        unitPrice: input.unitPrice,
        totalAmount,
        paidBy: actor,
        receivedBy: (input.receivedBy ?? actor).trim() || actor,
        paymentMethod,
        inventoryItemId: itemId,
        destination: "warehouse",
        addToStock: "no",
        status: "ordered",
        quantityReceived: 0,
        invoiceNumber: input.invoiceNumber ?? "",
        notes: input.notes ?? "",
      }).returning();
      purchase = createdPurchase!;
      purchaseId = createdPurchase!.id;
    }

    const receive = await receiveIntoWarehouse({
      itemId: itemId!,
      quantity: input.quantity,
      unit: input.unit,
      unitCost: input.unitPrice,
      brand: input.brand,
      note: input.notes ?? "Receive goods",
      actor,
      userId: input.userId ?? null,
      purchaseId,
      receiptDate: purchaseDate,
    }, tx);

    let payment = null as Awaited<ReturnType<typeof postPurchasePaymentInTx>>["payment"] | null;
    let paymentIdempotent = false;
    if (paymentStatus === "paid") {
      const amount = Number(purchase!.totalAmount) || computePurchaseTotal(input.quantity, input.unitPrice);
      const payResult = await postPurchasePaymentInTx(tx, {
        purchaseId: purchaseId!,
        amount,
        paymentDate: purchaseDate,
        paymentMethod,
        actor,
        userId: input.userId ?? null,
        notes: input.notes,
        clientRequestId: clientRequestId ? `pay:${clientRequestId}` : undefined,
      });
      payment = payResult.payment;
      paymentIdempotent = payResult.idempotent;
    }

    const refreshedPurchase = await tx.query.dailyPurchasesTable.findFirst({
      where: eq(dailyPurchasesTable.id, purchaseId!),
    });

    return {
      itemId: itemId!,
      createdItem,
      purchase: refreshedPurchase ?? purchase,
      payment,
      paymentIdempotent,
      receive,
    };
  });

  const available = await getAvailableCapitalSummary();
  return {
    success: true as const,
    ...result,
    availableCapital: available.availableCapital,
    availableSummary: available,
  };
}
