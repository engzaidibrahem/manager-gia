import {
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const inventoryItemsTable = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  unit: text("unit").notNull(),
  brand: text("brand").notNull().default(""),
  variant: text("variant").notNull().default(""),
  qrToken: text("qr_token").notNull().default(""),
  currentStock: numeric("current_stock", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  kitchenStock: numeric("kitchen_stock", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  minimumStock: numeric("minimum_stock", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  costPerUnit: numeric("cost_per_unit", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const inventoryMovementsTable = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => inventoryItemsTable.id),
  type: text("type").notNull(),
  location: text("location").notNull().default("warehouse"),
  quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" }).notNull(),
  note: text("note"),
  actor: text("actor").notNull(),
  purchaseId: integer("purchase_id"),
  lotId: integer("lot_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  expenseDate: date("expense_date", { mode: "string" }).notNull(),
  expenseTime: text("expense_time").notNull().default(""),
  category: text("category").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paidBy: text("paid_by").notNull(),
  receivedBy: text("received_by").notNull(),
  paymentMethod: text("payment_method").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const incomeTable = pgTable("income", {
  id: serial("id").primaryKey(),
  incomeDate: date("income_date", { mode: "string" }).notNull(),
  incomeTime: text("income_time").notNull().default(""),
  source: text("source").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  recordedBy: text("recorded_by").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  role: text("role").notNull(),
  phone: text("phone").notNull().default(""),
  startDate: date("start_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
});

export const attendanceTable = pgTable("attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  attendanceDate: date("attendance_date", { mode: "string" }).notNull(),
  checkIn: text("check_in").notNull(),
  checkOut: text("check_out"),
  status: text("status").notNull(),
  notes: text("notes"),
});

export const dailyPurchasesTable = pgTable("daily_purchases", {
  id: serial("id").primaryKey(),
  purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
  purchaseTime: text("purchase_time").notNull().default(""),
  supplier: text("supplier").notNull(),
  itemName: text("item_name").notNull(),
  category: text("category").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2, mode: "number" }).notNull(),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paidBy: text("paid_by").notNull(),
  receivedBy: text("received_by").notNull(),
  paymentMethod: text("payment_method").notNull(),
  inventoryItemId: integer("inventory_item_id"),
  destination: text("destination").notNull().default("warehouse"),
  addToStock: text("add_to_stock").notNull().default("yes"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const wasteRecordsTable = pgTable("waste_records", {
  id: serial("id").primaryKey(),
  wasteDate: date("waste_date", { mode: "string" }).notNull(),
  wasteTime: text("waste_time").notNull().default(""),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItemsTable.id),
  location: text("location").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" }).notNull(),
  reason: text("reason").notNull().default("spoilage"),
  actor: text("actor").notNull(),
  costEstimate: numeric("cost_estimate", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const menuRecipesTable = pgTable("menu_recipes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default(""),
  portions: numeric("portions", { precision: 12, scale: 2, mode: "number" }).notNull().default(1),
  targetFoodCostPct: numeric("target_food_cost_pct", { precision: 8, scale: 2, mode: "number" }).notNull().default(30),
  sellingPrice: numeric("selling_price", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const recipeLinesTable = pgTable("recipe_lines", {
  id: serial("id").primaryKey(),
  recipeId: integer("recipe_id").notNull().references(() => menuRecipesTable.id),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItemsTable.id),
  quantity: numeric("quantity", { precision: 14, scale: 4, mode: "number" }).notNull(),
  unit: text("unit").notNull(),
  yieldPct: numeric("yield_pct", { precision: 8, scale: 2, mode: "number" }).notNull().default(100),
  notes: text("notes"),
});

/** End-of-day snapshot: purchases, stock adds, kitchen, waste, cash — frozen per business date. */
export const dailyArchivesTable = pgTable("daily_archives", {
  id: serial("id").primaryKey(),
  businessDate: date("business_date", { mode: "string" }).notNull().unique(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedBy: text("closed_by").notNull().default(""),
  notes: text("notes"),
  totalIncome: numeric("total_income", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  totalExpenses: numeric("total_expenses", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  netCash: numeric("net_cash", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  totalPurchases: numeric("total_purchases", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  purchaseCount: integer("purchase_count").notNull().default(0),
  wasteCost: numeric("waste_cost", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  kitchenMovements: integer("kitchen_movements").notNull().default(0),
  attendanceCount: integer("attendance_count").notNull().default(0),
  warehouseValue: numeric("warehouse_value", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  kitchenValue: numeric("kitchen_value", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  snapshotJson: text("snapshot_json").notNull().default("{}"),
});

/** Warehouse receipt-day archive (incoming lots frozen per date). */
export const warehouseDayArchivesTable = pgTable("warehouse_day_archives", {
  id: serial("id").primaryKey(),
  businessDate: date("business_date", { mode: "string" }).notNull().unique(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedBy: text("closed_by").notNull().default(""),
  notes: text("notes"),
  receiptCount: integer("receipt_count").notNull().default(0),
  totalQuantity: numeric("total_quantity", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  totalValue: numeric("total_value", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  snapshotJson: text("snapshot_json").notNull().default("{}"),
});

/** Incoming warehouse lots / batches under a master SKU. */
export const warehouseLotsTable = pgTable("warehouse_lots", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => inventoryItemsTable.id),
  receiptDate: date("receipt_date", { mode: "string" }).notNull(),
  brand: text("brand").notNull().default(""),
  quantityReceived: numeric("quantity_received", { precision: 12, scale: 2, mode: "number" }).notNull(),
  quantityRemaining: numeric("quantity_remaining", { precision: 12, scale: 2, mode: "number" }).notNull(),
  costPerUnit: numeric("cost_per_unit", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
  note: text("note"),
  actor: text("actor").notNull().default(""),
  archiveId: integer("archive_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInventoryItemSchema = createInsertSchema(inventoryItemsTable).omit({ id: true, updatedAt: true });
export const insertInventoryMovementSchema = createInsertSchema(inventoryMovementsTable).omit({ id: true, createdAt: true });
export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, createdAt: true });
export const insertIncomeSchema = createInsertSchema(incomeTable).omit({ id: true, createdAt: true });
export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({ id: true });
export const insertAttendanceSchema = createInsertSchema(attendanceTable).omit({ id: true });
export const insertDailyPurchaseSchema = createInsertSchema(dailyPurchasesTable).omit({ id: true, createdAt: true });
export const insertWasteRecordSchema = createInsertSchema(wasteRecordsTable).omit({ id: true, createdAt: true });
export const insertMenuRecipeSchema = createInsertSchema(menuRecipesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRecipeLineSchema = createInsertSchema(recipeLinesTable).omit({ id: true });
export const insertDailyArchiveSchema = createInsertSchema(dailyArchivesTable).omit({ id: true, closedAt: true });
export const insertWarehouseDayArchiveSchema = createInsertSchema(warehouseDayArchivesTable).omit({ id: true, closedAt: true });
export const insertWarehouseLotSchema = createInsertSchema(warehouseLotsTable).omit({ id: true, createdAt: true });

export type InventoryItem = typeof inventoryItemsTable.$inferSelect;
export type InventoryMovement = typeof inventoryMovementsTable.$inferSelect;
export type Expense = typeof expensesTable.$inferSelect;
export type Income = typeof incomeTable.$inferSelect;
export type Employee = typeof employeesTable.$inferSelect;
export type Attendance = typeof attendanceTable.$inferSelect;
export type DailyPurchase = typeof dailyPurchasesTable.$inferSelect;
export type WasteRecord = typeof wasteRecordsTable.$inferSelect;
export type MenuRecipe = typeof menuRecipesTable.$inferSelect;
export type RecipeLine = typeof recipeLinesTable.$inferSelect;
export type DailyArchive = typeof dailyArchivesTable.$inferSelect;
export type WarehouseDayArchive = typeof warehouseDayArchivesTable.$inferSelect;
export type WarehouseLot = typeof warehouseLotsTable.$inferSelect;
export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export type InsertInventoryMovement = z.infer<typeof insertInventoryMovementSchema>;
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type InsertIncome = z.infer<typeof insertIncomeSchema>;
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type InsertAttendance = z.infer<typeof insertAttendanceSchema>;
export type InsertDailyPurchase = z.infer<typeof insertDailyPurchaseSchema>;
export type InsertWasteRecord = z.infer<typeof insertWasteRecordSchema>;
export type InsertMenuRecipe = z.infer<typeof insertMenuRecipeSchema>;
export type InsertRecipeLine = z.infer<typeof insertRecipeLineSchema>;
export type InsertDailyArchive = z.infer<typeof insertDailyArchiveSchema>;
export type InsertWarehouseDayArchive = z.infer<typeof insertWarehouseDayArchiveSchema>;
export type InsertWarehouseLot = z.infer<typeof insertWarehouseLotSchema>;
