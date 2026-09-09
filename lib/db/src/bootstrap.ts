import path from "node:path";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "./schema";

type AppDatabase = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  current_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
  kitchen_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
  minimum_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cost_per_unit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS inventory_movements (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  type TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'warehouse',
  quantity NUMERIC(12, 2) NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  purchase_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  expense_date DATE NOT NULL,
  expense_time TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  paid_by TEXT NOT NULL,
  received_by TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS income (
  id SERIAL PRIMARY KEY,
  income_date DATE NOT NULL,
  income_time TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  recorded_by TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS daily_cash_balances (
  id SERIAL PRIMARY KEY,
  business_date DATE NOT NULL UNIQUE,
  opening_balance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS capital_entries (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  entry_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount NUMERIC(14, 2) NOT NULL,
  actor TEXT NOT NULL,
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  start_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT
)`,
  `CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  attendance_date DATE NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT,
  status TEXT NOT NULL,
  notes TEXT
)`,
  `CREATE TABLE IF NOT EXISTS daily_purchases (
  id SERIAL PRIMARY KEY,
  purchase_date DATE NOT NULL,
  purchase_time TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL,
  unit TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  total_amount NUMERIC(14, 2) NOT NULL,
  paid_by TEXT NOT NULL,
  received_by TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  inventory_item_id INTEGER,
  destination TEXT NOT NULL DEFAULT 'warehouse',
  add_to_stock TEXT NOT NULL DEFAULT 'yes',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS purchase_payments (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES daily_purchases(id),
  amount NUMERIC(14, 2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'Transfer',
  actor TEXT NOT NULL,
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS waste_records (
  id SERIAL PRIMARY KEY,
  waste_date DATE NOT NULL,
  waste_time TEXT NOT NULL DEFAULT '',
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  location TEXT NOT NULL,
  quantity NUMERIC(12, 2) NOT NULL,
  reason TEXT NOT NULL DEFAULT 'spoilage',
  actor TEXT NOT NULL,
  cost_estimate NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS menu_recipes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  portions NUMERIC(12, 2) NOT NULL DEFAULT 1,
  target_food_cost_pct NUMERIC(8, 2) NOT NULL DEFAULT 30,
  selling_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS recipe_lines (
  id SERIAL PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES menu_recipes(id),
  inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity NUMERIC(14, 4) NOT NULL,
  unit TEXT NOT NULL,
  yield_pct NUMERIC(8, 2) NOT NULL DEFAULT 100,
  notes TEXT
)`,
  `CREATE TABLE IF NOT EXISTS daily_archives (
  id SERIAL PRIMARY KEY,
  business_date DATE NOT NULL UNIQUE,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by TEXT NOT NULL DEFAULT '',
  notes TEXT,
  total_income NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_expenses NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_cash NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_purchases NUMERIC(14, 2) NOT NULL DEFAULT 0,
  purchase_count INTEGER NOT NULL DEFAULT 0,
  waste_cost NUMERIC(14, 2) NOT NULL DEFAULT 0,
  kitchen_movements INTEGER NOT NULL DEFAULT 0,
  attendance_count INTEGER NOT NULL DEFAULT 0,
  warehouse_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  kitchen_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL DEFAULT '{}'
)`,
  `CREATE TABLE IF NOT EXISTS warehouse_day_archives (
  id SERIAL PRIMARY KEY,
  business_date DATE NOT NULL UNIQUE,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by TEXT NOT NULL DEFAULT '',
  notes TEXT,
  receipt_count INTEGER NOT NULL DEFAULT 0,
  total_quantity NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_value NUMERIC(14, 2) NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL DEFAULT '{}'
)`,
  `CREATE TABLE IF NOT EXISTS warehouse_lots (
  id SERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  receipt_date DATE NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  quantity_received NUMERIC(12, 2) NOT NULL,
  quantity_remaining NUMERIC(12, 2) NOT NULL,
  cost_per_unit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  note TEXT,
  actor TEXT NOT NULL DEFAULT '',
  archive_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  active TEXT NOT NULL DEFAULT 'yes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
];

const MIGRATIONS = [
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS kitchen_stock NUMERIC(12, 2) NOT NULL DEFAULT 0`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS qr_token TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'warehouse'`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_id INTEGER`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot_id INTEGER`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS from_location TEXT`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS to_location TEXT`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS base_quantity NUMERIC(12, 4)`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit TEXT`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS method TEXT`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS user_id INTEGER`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS reversal_of_id INTEGER`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot_allocations TEXT`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
  `ALTER TABLE daily_purchases ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'warehouse'`,
  `ALTER TABLE daily_purchases ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ordered'`,
  `ALTER TABLE daily_purchases ADD COLUMN IF NOT EXISTS quantity_received NUMERIC(12, 2) NOT NULL DEFAULT 0`,
  `ALTER TABLE daily_purchases ADD COLUMN IF NOT EXISTS invoice_number TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE warehouse_lots ADD COLUMN IF NOT EXISTS purchase_id INTEGER`,
  `UPDATE daily_purchases SET destination = 'warehouse' WHERE add_to_stock = 'yes' AND (destination IS NULL OR destination = '')`,
  `UPDATE daily_purchases SET destination = 'none' WHERE add_to_stock = 'no' AND destination = 'warehouse' AND (inventory_item_id IS NULL)`,
  `UPDATE daily_purchases SET status = 'received', quantity_received = quantity WHERE destination IN ('warehouse','kitchen') AND inventory_item_id IS NOT NULL AND (status IS NULL OR status = 'ordered') AND quantity_received = 0`,
  `UPDATE inventory_items SET qr_token = 'gia-' || id::text || '-' || substr(md5(random()::text || id::text), 1, 12) WHERE qr_token IS NULL OR qr_token = ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attendance_employee_date_uidx ON attendance (employee_id, attendance_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_qr_token_uidx ON inventory_items (qr_token)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS capital_entries_client_request_uidx ON capital_entries (client_request_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS purchase_payments_client_request_uidx ON purchase_payments (client_request_id)`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voided_by TEXT`,
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS void_reason TEXT`,
  `ALTER TABLE income ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE income ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ`,
  `ALTER TABLE income ADD COLUMN IF NOT EXISTS voided_by TEXT`,
  `ALTER TABLE income ADD COLUMN IF NOT EXISTS void_reason TEXT`,
  `CREATE TABLE IF NOT EXISTS purchase_payments (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES daily_purchases(id),
  amount NUMERIC(14, 2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'Transfer',
  actor TEXT NOT NULL,
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  // --- GIA V3 simple warehouse ---
  `CREATE TABLE IF NOT EXISTS v3_inventory_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  base_unit TEXT NOT NULL DEFAULT '',
  minimum_stock NUMERIC(14, 4),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  warehouse_qty_numeric NUMERIC(14, 4),
  kitchen_qty_numeric NUMERIC(14, 4),
  qr_token TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'MANUAL',
  source_excel_row INTEGER,
  original_name_raw TEXT,
  needs_quantity_review BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  import_batch_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_inventory_items_qr_token_uidx ON v3_inventory_items (qr_token)`,
  `CREATE TABLE IF NOT EXISTS v3_opening_balances (
  id SERIAL PRIMARY KEY,
  inventory_item_id INTEGER NOT NULL REFERENCES v3_inventory_items(id),
  balance_date DATE NOT NULL,
  quantity_numeric NUMERIC(14, 4),
  quantity_raw TEXT NOT NULL,
  unit_raw TEXT NOT NULL DEFAULT '',
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  batch_key TEXT,
  movement_id INTEGER,
  source_excel_row INTEGER,
  needs_quantity_review BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS v3_warehouse_movements (
  id SERIAL PRIMARY KEY,
  inventory_item_id INTEGER NOT NULL REFERENCES v3_inventory_items(id),
  movement_type TEXT NOT NULL,
  quantity_numeric NUMERIC(14, 4),
  quantity_raw TEXT NOT NULL,
  unit_raw TEXT NOT NULL DEFAULT '',
  movement_date DATE NOT NULL,
  supplier TEXT,
  receiver TEXT,
  user_id INTEGER,
  actor TEXT NOT NULL DEFAULT '',
  purchase_id INTEGER,
  opening_balance_id INTEGER,
  notes TEXT,
  batch_key TEXT,
  source_excel_row INTEGER,
  original_name_raw TEXT,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_warehouse_movements_client_request_uidx ON v3_warehouse_movements (client_request_id)`,
  // GIA V3 column extensions for existing DBs created before PHASE 5
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'MANUAL'`,
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS source_excel_row INTEGER`,
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS original_name_raw TEXT`,
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS needs_quantity_review BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS import_batch_key TEXT`,
  `ALTER TABLE v3_opening_balances ADD COLUMN IF NOT EXISTS source_excel_row INTEGER`,
  `ALTER TABLE v3_opening_balances ADD COLUMN IF NOT EXISTS needs_quantity_review BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS source_excel_row INTEGER`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS original_name_raw TEXT`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE`,
  // PHASE 6 — purchases + finance
  `CREATE TABLE IF NOT EXISTS v3_purchases (
  id SERIAL PRIMARY KEY,
  purchase_date DATE NOT NULL,
  purchase_time TEXT NOT NULL DEFAULT '',
  item_name TEXT NOT NULL,
  inventory_item_id INTEGER REFERENCES v3_inventory_items(id),
  quantity_numeric NUMERIC(14, 4),
  quantity_raw TEXT NOT NULL DEFAULT '',
  unit_raw TEXT NOT NULL DEFAULT '',
  unit_price NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(14, 2) NOT NULL,
  paid_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  supplier TEXT NOT NULL DEFAULT '',
  purchased_by TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL,
  notes TEXT,
  movement_id INTEGER,
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_purchases_client_request_uidx ON v3_purchases (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_purchase_payments (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES v3_purchases(id),
  amount NUMERIC(14, 2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'نقداً',
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_purchase_payments_client_request_uidx ON v3_purchase_payments (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_capital_transactions (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  entry_type TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_capital_transactions_client_request_uidx ON v3_capital_transactions (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_income (
  id SERIAL PRIMARY KEY,
  income_date DATE NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  received_by TEXT NOT NULL DEFAULT '',
  notes TEXT,
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_income_client_request_uidx ON v3_income (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_expenses (
  id SERIAL PRIMARY KEY,
  expense_date DATE NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL,
  paid_by TEXT NOT NULL DEFAULT '',
  notes TEXT,
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_expenses_client_request_uidx ON v3_expenses (client_request_id)`,
];

export async function bootstrapSchema(database: AppDatabase): Promise<void> {
  for (const statement of STATEMENTS) {
    try {
      await database.execute(sql.raw(statement));
    } catch (err) {
      // Concurrent CREATE TABLE IF NOT EXISTS can race on pg_type unique index (23505).
      const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
        ?? (err as { code?: string })?.code;
      if (code === "23505") continue;
      throw err;
    }
  }
  for (const statement of MIGRATIONS) {
    try {
      await database.execute(sql.raw(statement));
    } catch {
      // ignore migration races / unsupported IF NOT EXISTS quirks
    }
  }
}

export function resolvePgliteDataDir(databaseUrl: string): string {
  let dir = databaseUrl.replace(/^pglite:/i, "").replace(/^file:/i, "");
  dir = dir.replace(/^\/+/, "");
  if (!dir) dir = ".data/gia-shawarma";
  if (!path.isAbsolute(dir)) {
    dir = path.resolve(process.cwd(), dir);
  }
  return dir;
}
