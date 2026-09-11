/**
 * Finance queries — operational figures from persisted records.
 * Daily cash ≠ capital. Purchases ≠ expenses.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  dailyPurchasesTable,
  expensesTable,
  incomeTable,
  inventoryItemsTable,
} from "@workspace/db";
import { getOperationalFinanceSummary } from "./capitalService";

export async function getTodayPurchasesSummary(date: string) {
  const rows = await db.select().from(dailyPurchasesTable)
    .where(eq(dailyPurchasesTable.purchaseDate, date));
  const total = rows.reduce((s, r) => s + Number(r.totalAmount), 0);
  return {
    date,
    count: rows.length,
    totalCost: Math.round(total * 100) / 100,
    rows,
  };
}

export async function getInventoryValue() {
  const items = await db.select().from(inventoryItemsTable);
  let warehouseValue = 0;
  let kitchenValue = 0;
  for (const item of items) {
    const cost = Number(item.costPerUnit) || 0;
    warehouseValue += Number(item.currentStock) * cost;
    kitchenValue += Number(item.kitchenStock) * cost;
  }
  return {
    warehouseValue: Math.round(warehouseValue * 100) / 100,
    kitchenValue: Math.round(kitchenValue * 100) / 100,
    totalValue: Math.round((warehouseValue + kitchenValue) * 100) / 100,
    itemCount: items.length,
  };
}

export async function getDayCashBooks(date: string) {
  const [exp] = await db
    .select({ total: sql<number>`coalesce(sum(${expensesTable.amount}), 0)` })
    .from(expensesTable)
    .where(eq(expensesTable.expenseDate, date));
  const [inc] = await db
    .select({ total: sql<number>`coalesce(sum(${incomeTable.amount}), 0)` })
    .from(incomeTable)
    .where(eq(incomeTable.incomeDate, date));
  const purchases = await getTodayPurchasesSummary(date);
  return {
    date,
    totalExpenses: Number(exp?.total ?? 0),
    totalIncome: Number(inc?.total ?? 0),
    totalPurchases: purchases.totalCost,
    purchaseCount: purchases.count,
    note: "Daily cash book for the date. Purchases are invoices (not auto-expenses). Inventory value is not capital.",
  };
}

export { getOperationalFinanceSummary };
