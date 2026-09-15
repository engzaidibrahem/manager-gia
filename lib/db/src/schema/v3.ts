import {
  boolean,
  date,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * GIA V3 — simple warehouse ledger (no FIFO/lots/archive).
 * Source of truth = movements. Cached balances updated transactionally.
 */

export const V3_SOURCE_TYPES = [
  "ORIGINAL_INVENTORY",
  "MOVEMENT_ADDED",
  "MOVEMENT_CREATED_UNMAPPED",
  "MANUAL",
  "KITCHEN_DIRECT",
] as const;

export type V3SourceType = (typeof V3_SOURCE_TYPES)[number];

/** How a warehouse mutation was initiated (audit / mobile readiness). */
export const V3_SOURCE_CHANNELS = [
  "WEB_ADMIN",
  "MOBILE_ADMIN",
  "MOBILE_QR",
  "MOBILE_SEARCH",
  "PURCHASE_IMPORT",
  "STOCKTAKE",
  "API",
] as const;
export type V3SourceChannel = (typeof V3_SOURCE_CHANNELS)[number];

export const V3_CANONICAL_STOCK_STATUSES = [
  "NORMAL",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "REVIEW_REQUIRED",
] as const;
export type V3CanonicalStockStatus = (typeof V3_CANONICAL_STOCK_STATUSES)[number];

export const V3_STOCKTAKE_STATUSES = ["DRAFT", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type V3StocktakeStatus = (typeof V3_STOCKTAKE_STATUSES)[number];

export const v3InventoryItemsTable = pgTable("v3_inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default(""),
  baseUnit: text("base_unit").notNull().default(""),
  /** NULL = no low-stock warning */
  minimumStock: numeric("minimum_stock", { precision: 14, scale: 4, mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  /** Cached numeric warehouse balance; NULL = unknown / needs review (never fake 0). */
  warehouseQtyNumeric: numeric("warehouse_qty_numeric", { precision: 14, scale: 4, mode: "number" }),
  kitchenQtyNumeric: numeric("kitchen_qty_numeric", { precision: 14, scale: 4, mode: "number" }),
  qrToken: text("qr_token").notNull().default(""),
  /** Optional short code printed on QR labels (not the QR identity). */
  shortCode: text("short_code"),
  /** ORIGINAL_INVENTORY | MOVEMENT_ADDED | MOVEMENT_CREATED_UNMAPPED | MANUAL | KITCHEN_DIRECT */
  sourceType: text("source_type").notNull().default("MANUAL"),
  sourceExcelRow: integer("source_excel_row"),
  originalNameRaw: text("original_name_raw"),
  needsQuantityReview: boolean("needs_quantity_review").notNull().default(false),
  needsReview: boolean("needs_review").notNull().default(false),
  importBatchKey: text("import_batch_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_inventory_items_qr_token_uidx").on(t.qrToken),
]);

/** Opening balance rows — also mirrored as OPENING movements for the ledger. */
export const v3OpeningBalancesTable = pgTable("v3_opening_balances", {
  id: serial("id").primaryKey(),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => v3InventoryItemsTable.id),
  balanceDate: date("balance_date", { mode: "string" }).notNull(),
  quantityNumeric: numeric("quantity_numeric", { precision: 14, scale: 4, mode: "number" }),
  quantityRaw: text("quantity_raw").notNull(),
  unitRaw: text("unit_raw").notNull().default(""),
  notes: text("notes"),
  createdBy: text("created_by").notNull().default(""),
  userId: integer("user_id"),
  batchKey: text("batch_key"),
  movementId: integer("movement_id"),
  sourceExcelRow: integer("source_excel_row"),
  needsQuantityReview: boolean("needs_quantity_review").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const v3WarehouseMovementsTable = pgTable("v3_warehouse_movements", {
  id: serial("id").primaryKey(),
  /** Nullable for KITCHEN_DIRECT_IN free-text purchases (no warehouse item). */
  inventoryItemId: integer("inventory_item_id").references(() => v3InventoryItemsTable.id),
  /** OPENING | WAREHOUSE_IN | WAREHOUSE_TO_KITCHEN | ADJUSTMENT */
  movementType: text("movement_type").notNull(),
  quantityNumeric: numeric("quantity_numeric", { precision: 14, scale: 4, mode: "number" }),
  quantityRaw: text("quantity_raw").notNull(),
  unitRaw: text("unit_raw").notNull().default(""),
  movementDate: date("movement_date", { mode: "string" }).notNull(),
  supplier: text("supplier"),
  receiver: text("receiver"),
  userId: integer("user_id"),
  actor: text("actor").notNull().default(""),
  purchaseId: integer("purchase_id"),
  openingBalanceId: integer("opening_balance_id"),
  notes: text("notes"),
  batchKey: text("batch_key"),
  sourceExcelRow: integer("source_excel_row"),
  originalNameRaw: text("original_name_raw"),
  needsReview: boolean("needs_review").notNull().default(false),
  /** active | voided */
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  /** WEB_ADMIN | MOBILE_QR | … — how the action was initiated */
  sourceChannel: text("source_channel"),
  /** Warehouse qty snapshot before this movement (audit). */
  qtyBefore: numeric("qty_before", { precision: 14, scale: 4, mode: "number" }),
  /** Warehouse qty snapshot after this movement (audit). */
  qtyAfter: numeric("qty_after", { precision: 14, scale: 4, mode: "number" }),
  itemNameSnapshot: text("item_name_snapshot"),
  actorRole: text("actor_role"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_warehouse_movements_client_request_uidx").on(t.clientRequestId),
]);

/** Full warehouse stocktake session (DRAFT does not alter balances). */
export const v3StocktakesTable = pgTable("v3_stocktakes", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("DRAFT"),
  notes: text("notes"),
  startedBy: text("started_by").notNull().default(""),
  startedByUserId: integer("started_by_user_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedBy: text("completed_by"),
  completedByUserId: integer("completed_by_user_id"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledBy: text("cancelled_by"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_stocktakes_client_request_uidx").on(t.clientRequestId),
]);

export const v3StocktakeLinesTable = pgTable("v3_stocktake_lines", {
  id: serial("id").primaryKey(),
  stocktakeId: integer("stocktake_id").notNull().references(() => v3StocktakesTable.id),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => v3InventoryItemsTable.id),
  systemQuantityBefore: numeric("system_quantity_before", { precision: 14, scale: 4, mode: "number" }),
  countedQuantity: numeric("counted_quantity", { precision: 14, scale: 4, mode: "number" }),
  difference: numeric("difference", { precision: 14, scale: 4, mode: "number" }),
  unit: text("unit").notNull().default(""),
  countedBy: text("counted_by"),
  countedByUserId: integer("counted_by_user_id"),
  countedAt: timestamp("counted_at", { withTimezone: true }),
  notes: text("notes"),
  /** Movement created on COMPLETE (ADJUSTMENT), if any. */
  adjustmentMovementId: integer("adjustment_movement_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_stocktake_lines_stocktake_item_uidx").on(t.stocktakeId, t.inventoryItemId),
]);

export type V3InventoryItem = typeof v3InventoryItemsTable.$inferSelect;
export type V3OpeningBalance = typeof v3OpeningBalancesTable.$inferSelect;
export type V3WarehouseMovement = typeof v3WarehouseMovementsTable.$inferSelect;
export type V3Stocktake = typeof v3StocktakesTable.$inferSelect;
export type V3StocktakeLine = typeof v3StocktakeLinesTable.$inferSelect;

export const V3_MOVEMENT_TYPES = [
  "OPENING",
  "WAREHOUSE_IN",
  "WAREHOUSE_OUT",
  "WAREHOUSE_TO_KITCHEN",
  "KITCHEN_DIRECT_IN",
  "ADJUSTMENT",
] as const;

export type V3MovementType = (typeof V3_MOVEMENT_TYPES)[number];

/** Purchase destinations — user must choose explicitly. */
export const V3_PURCHASE_DESTINATIONS = ["WAREHOUSE", "KITCHEN_DIRECT", "CONSUMABLE"] as const;
export type V3PurchaseDestination = (typeof V3_PURCHASE_DESTINATIONS)[number];

export const V3_PAYMENT_STATUSES = ["PAID", "UNPAID", "PARTIAL"] as const;
export type V3PaymentStatus = (typeof V3_PAYMENT_STATUSES)[number];

export const v3PurchasesTable = pgTable("v3_purchases", {
  id: serial("id").primaryKey(),
  purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
  purchaseTime: text("purchase_time").notNull().default(""),
  itemName: text("item_name").notNull(),
  inventoryItemId: integer("inventory_item_id").references(() => v3InventoryItemsTable.id),
  quantityNumeric: numeric("quantity_numeric", { precision: 14, scale: 4, mode: "number" }),
  quantityRaw: text("quantity_raw").notNull().default(""),
  unitRaw: text("unit_raw").notNull().default(""),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paidAmount: numeric("paid_amount", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("UNPAID"),
  supplier: text("supplier").notNull().default(""),
  /** Optional invoice / reference number from supplier (import + manual). */
  invoiceNumber: text("invoice_number"),
  purchasedBy: text("purchased_by").notNull().default(""),
  /** WAREHOUSE | KITCHEN_DIRECT | CONSUMABLE */
  destination: text("destination").notNull(),
  notes: text("notes"),
  movementId: integer("movement_id"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  /** Last editor (audit); create keeps actor as creator. */
  updatedBy: text("updated_by"),
  /** active | voided */
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_purchases_client_request_uidx").on(t.clientRequestId),
]);

export const v3PurchasePaymentsTable = pgTable("v3_purchase_payments", {
  id: serial("id").primaryKey(),
  purchaseId: integer("purchase_id").notNull().references(() => v3PurchasesTable.id),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paymentDate: date("payment_date", { mode: "string" }).notNull(),
  paymentMethod: text("payment_method").notNull().default("نقداً"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_purchase_payments_client_request_uidx").on(t.clientRequestId),
]);

export const v3CapitalTransactionsTable = pgTable("v3_capital_transactions", {
  id: serial("id").primaryKey(),
  entryDate: date("entry_date", { mode: "string" }).notNull(),
  /** ADD | WITHDRAW | CORRECTION */
  entryType: text("entry_type").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  notes: text("notes"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_capital_transactions_client_request_uidx").on(t.clientRequestId),
]);

export const v3IncomeTable = pgTable("v3_income", {
  id: serial("id").primaryKey(),
  incomeDate: date("income_date", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  receivedBy: text("received_by").notNull().default(""),
  notes: text("notes"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_income_client_request_uidx").on(t.clientRequestId),
]);

export const v3ExpensesTable = pgTable("v3_expenses", {
  id: serial("id").primaryKey(),
  expenseDate: date("expense_date", { mode: "string" }).notNull(),
  category: text("category").notNull().default(""),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paidBy: text("paid_by").notNull().default(""),
  notes: text("notes"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_expenses_client_request_uidx").on(t.clientRequestId),
]);

export type V3Purchase = typeof v3PurchasesTable.$inferSelect;
export type V3PurchasePayment = typeof v3PurchasePaymentsTable.$inferSelect;
export type V3CapitalTransaction = typeof v3CapitalTransactionsTable.$inferSelect;
export type V3Income = typeof v3IncomeTable.$inferSelect;
export type V3Expense = typeof v3ExpensesTable.$inferSelect;

/** PHASE 7 — employees / attendance / payroll */
export const V3_SALARY_TYPES = ["MONTHLY", "DAILY"] as const;
export type V3SalaryType = (typeof V3_SALARY_TYPES)[number];

export const V3_ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LEAVE"] as const;
export type V3AttendanceStatus = (typeof V3_ATTENDANCE_STATUSES)[number];

export const v3EmployeesTable = pgTable("v3_employees", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  secondaryPhone: text("secondary_phone"),
  jobTitle: text("job_title").notNull().default(""),
  salaryAmount: numeric("salary_amount", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  /** MONTHLY | DAILY */
  salaryType: text("salary_type").notNull().default("MONTHLY"),
  workStartDate: date("work_start_date", { mode: "string" }).notNull(),
  workEndDate: date("work_end_date", { mode: "string" }),
  expectedDailyHours: numeric("expected_daily_hours", { precision: 6, scale: 2, mode: "number" }),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const v3AttendanceTable = pgTable("v3_attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => v3EmployeesTable.id),
  attendanceDate: date("attendance_date", { mode: "string" }).notNull(),
  /** PRESENT | ABSENT | LEAVE */
  status: text("status").notNull(),
  checkInTime: text("check_in_time"),
  checkOutTime: text("check_out_time"),
  workedHours: numeric("worked_hours", { precision: 8, scale: 2, mode: "number" }),
  notes: text("notes"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_attendance_employee_date_uidx").on(t.employeeId, t.attendanceDate),
]);

export const v3PayrollTable = pgTable("v3_payroll", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => v3EmployeesTable.id),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  baseSalary: numeric("base_salary", { precision: 14, scale: 2, mode: "number" }).notNull(),
  absenceDays: integer("absence_days").notNull().default(0),
  manualDeduction: numeric("manual_deduction", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  manualBonus: numeric("manual_bonus", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  netSalary: numeric("net_salary", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paidAmount: numeric("paid_amount", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("UNPAID"),
  paymentDate: date("payment_date", { mode: "string" }),
  notes: text("notes"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  uniqueIndex("v3_payroll_employee_period_uidx").on(t.employeeId, t.year, t.month),
  uniqueIndex("v3_payroll_client_request_uidx").on(t.clientRequestId),
]);

export const v3SalaryPaymentsTable = pgTable("v3_salary_payments", {
  id: serial("id").primaryKey(),
  payrollId: integer("payroll_id").notNull().references(() => v3PayrollTable.id),
  amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull(),
  paymentDate: date("payment_date", { mode: "string" }).notNull(),
  paidBy: text("paid_by").notNull().default(""),
  notes: text("notes"),
  actor: text("actor").notNull().default(""),
  userId: integer("user_id"),
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_salary_payments_client_request_uidx").on(t.clientRequestId),
]);

export type V3Employee = typeof v3EmployeesTable.$inferSelect;
export type V3Attendance = typeof v3AttendanceTable.$inferSelect;
export type V3Payroll = typeof v3PayrollTable.$inferSelect;
export type V3SalaryPayment = typeof v3SalaryPaymentsTable.$inferSelect;
