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

export const v3InventoryItemsTable = pgTable("v3_inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default(""),
  baseUnit: text("base_unit").notNull().default(""),
  /** NULL = no low-stock warning */
  minimumStock: numeric("minimum_stock", { precision: 14, scale: 4, mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  /** Cached numeric warehouse balance; NULL means unknown (only raw texts). */
  warehouseQtyNumeric: numeric("warehouse_qty_numeric", { precision: 14, scale: 4, mode: "number" }),
  kitchenQtyNumeric: numeric("kitchen_qty_numeric", { precision: 14, scale: 4, mode: "number" }),
  qrToken: text("qr_token").notNull().default(""),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const v3WarehouseMovementsTable = pgTable("v3_warehouse_movements", {
  id: serial("id").primaryKey(),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => v3InventoryItemsTable.id),
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
  /** active | voided */
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  clientRequestId: text("client_request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("v3_warehouse_movements_client_request_uidx").on(t.clientRequestId),
]);

export type V3InventoryItem = typeof v3InventoryItemsTable.$inferSelect;
export type V3OpeningBalance = typeof v3OpeningBalancesTable.$inferSelect;
export type V3WarehouseMovement = typeof v3WarehouseMovementsTable.$inferSelect;

export const V3_MOVEMENT_TYPES = [
  "OPENING",
  "WAREHOUSE_IN",
  "WAREHOUSE_TO_KITCHEN",
  "ADJUSTMENT",
] as const;

export type V3MovementType = (typeof V3_MOVEMENT_TYPES)[number];
