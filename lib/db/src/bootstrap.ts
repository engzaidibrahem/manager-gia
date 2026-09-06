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
];

const MIGRATIONS = [
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS kitchen_stock NUMERIC(12, 2) NOT NULL DEFAULT 0`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS qr_token TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT 'warehouse'`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS purchase_id INTEGER`,
  `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot_id INTEGER`,
  `ALTER TABLE daily_purchases ADD COLUMN IF NOT EXISTS destination TEXT NOT NULL DEFAULT 'warehouse'`,
  `UPDATE daily_purchases SET destination = 'warehouse' WHERE add_to_stock = 'yes' AND (destination IS NULL OR destination = '')`,
  `UPDATE daily_purchases SET destination = 'none' WHERE add_to_stock = 'no' AND destination = 'warehouse' AND (inventory_item_id IS NULL)`,
  `UPDATE inventory_items SET qr_token = 'gia-' || id::text || '-' || substr(md5(random()::text || id::text), 1, 12) WHERE qr_token IS NULL OR qr_token = ''`,
];

export async function bootstrapSchema(database: AppDatabase): Promise<void> {
  for (const statement of STATEMENTS) {
    await database.execute(sql.raw(statement));
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
