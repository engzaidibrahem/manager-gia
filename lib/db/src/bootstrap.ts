import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type * as schema from "./schema";

type AppDatabase = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

/** Walk up from this file until pnpm-workspace.yaml (monorepo root). */
export function findProjectRoot(startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  const override = process.env.GIA_PROJECT_ROOT?.trim();
  if (override) return path.resolve(override);

  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Cannot locate Gia project root (pnpm-workspace.yaml). Set GIA_PROJECT_ROOT to the repo root.",
  );
}

export function canonicalV3ProductionDir(projectRoot = findProjectRoot()): string {
  return path.resolve(projectRoot, ".data", "gia-v3");
}

export function canonicalV3TestDir(projectRoot = findProjectRoot()): string {
  return path.resolve(projectRoot, ".data", "gia-v3-test");
}

export function normalizeFsPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/** Absolute pglite:// URL for the canonical V3 test DB (forward slashes). */
export function canonicalV3TestDatabaseUrl(projectRoot = findProjectRoot()): string {
  return `pglite://${canonicalV3TestDir(projectRoot).replace(/\\/g, "/")}`;
}

/** Absolute pglite:// URL for the canonical V3 production DB. */
export function canonicalV3ProductionDatabaseUrl(projectRoot = findProjectRoot()): string {
  return `pglite://${canonicalV3ProductionDir(projectRoot).replace(/\\/g, "/")}`;
}

export type V3DbAccessMode = "test" | "runtime";

/**
 * Detect whether this process is allowed to open only the V3 test DB.
 * Triggered by V3_TEST_MODE, NODE_ENV=test, or the Node/tsx test runner.
 */
export function detectV3DbAccessMode(): V3DbAccessMode {
  const flag = String(process.env.V3_TEST_MODE || "").trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return "test";
  if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "test") return "test";
  if (isNodeTestRunnerProcess()) return "test";
  return "runtime";
}

export function isNodeTestRunnerProcess(): boolean {
  if (process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"))) return true;
  if (process.argv.includes("--test")) return true;
  const nodeOpts = String(process.env.NODE_OPTIONS || "");
  if (/(?:^|\s)--test(?:-|\s|$)/.test(nodeOpts)) return true;
  // tsx --test often appears as argv entry
  if (process.argv.some((a) => a === "--test" || a.endsWith("/tsx") || a.endsWith("\\tsx"))) {
    if (process.argv.includes("--test")) return true;
  }
  return false;
}

/**
 * Hard isolation policy — call BEFORE opening PGlite.
 * Test mode: ONLY exact canonical gia-v3-test. Stale production DATABASE_URL ⇒ fatal.
 * Runtime mode: refuse gia-v3-test unless V3_TEST_MODE (already covered by detect).
 */
export function assertV3DatabaseAccessPolicy(
  dataDir: string,
  databaseUrl: string,
  mode: V3DbAccessMode = detectV3DbAccessMode(),
): void {
  const root = findProjectRoot();
  const prod = normalizeFsPath(canonicalV3ProductionDir(root));
  const test = normalizeFsPath(canonicalV3TestDir(root));
  const norm = normalizeFsPath(dataDir);
  const url = String(databaseUrl || "");

  if (mode === "test") {
    if (norm !== test) {
      throw new Error(
        [
          "FATAL V3 TEST ISOLATION: refusing to open a non-test database from a test process.",
          `Mode: test (V3_TEST_MODE / NODE_ENV=test / test runner)`,
          `Resolved path: ${path.resolve(dataDir)}`,
          `Required path: ${canonicalV3TestDir(root)}`,
          `DATABASE_URL: ${url}`,
          "Stale shell DATABASE_URL pointing at production cannot override test isolation.",
        ].join("\n"),
      );
    }
    return;
  }

  // runtime (production API / normal app)
  if (norm === test) {
    throw new Error(
      [
        "FATAL V3 ISOLATION: refusing to open the V3 test database outside test mode.",
        `Resolved path: ${path.resolve(dataDir)}`,
        "Set V3_TEST_MODE=true (and use gia-v3-test) for automated tests only.",
        `Production DB: ${canonicalV3ProductionDir(root)}`,
      ].join("\n"),
    );
  }

  // Extra belt: URL says test but path somehow did not match test leaf
  if (/\bgia-v3-test\b/i.test(url) && norm !== test) {
    throw new Error(`FATAL V3 ISOLATION: test DATABASE_URL did not resolve to canonical test dir (${dataDir})`);
  }
}

function pathLooksLike(dir: string, leaf: string): boolean {
  const n = normalizeFsPath(dir);
  return n.endsWith(`/${leaf.toLowerCase()}`) || n.endsWith(`\\${leaf.toLowerCase()}`);
}

/**
 * Refuse cwd-relative clones under artifacts/api-server and enforce canonical V3 paths.
 */
export function assertSafePgliteDataDir(dataDir: string, databaseUrl: string): void {
  const abs = path.resolve(dataDir);
  const norm = normalizeFsPath(abs);
  const root = findProjectRoot();
  const prod = normalizeFsPath(canonicalV3ProductionDir(root));
  const test = normalizeFsPath(canonicalV3TestDir(root));

  if (norm.includes("/artifacts/api-server/.data/") || norm.includes("\\artifacts\\api-server\\.data\\")) {
    throw new Error(
      [
        "REFUSING TO OPEN DATABASE under artifacts/api-server/.data/",
        `Resolved: ${abs}`,
        `This is an unintended cwd-relative clone.`,
        `Canonical V3 production DB: ${canonicalV3ProductionDir(root)}`,
        `Canonical V3 test DB: ${canonicalV3TestDir(root)}`,
      ].join("\n"),
    );
  }

  const url = databaseUrl.toLowerCase();
  const wantsTest = url.includes("gia-v3-test") || pathLooksLike(abs, "gia-v3-test");
  const wantsProd =
    !wantsTest && (url.includes("gia-v3") || pathLooksLike(abs, "gia-v3"));

  if (wantsProd && norm !== prod) {
    throw new Error(
      [
        "REFUSING TO OPEN NON-CANONICAL V3 PRODUCTION DATABASE",
        `Resolved: ${abs}`,
        `Required: ${canonicalV3ProductionDir(root)}`,
        "Set DATABASE_URL=pglite://.data/gia-v3 (resolved from project root) or the absolute canonical path.",
      ].join("\n"),
    );
  }

  if (wantsTest && norm !== test) {
    throw new Error(
      [
        "REFUSING TO OPEN NON-CANONICAL V3 TEST DATABASE",
        `Resolved: ${abs}`,
        `Required: ${canonicalV3TestDir(root)}`,
        "Tests must use .data/gia-v3-test under the project root — never production.",
      ].join("\n"),
    );
  }

  if (wantsTest && norm === prod) {
    throw new Error(`REFUSING: test database URL resolved to production path ${abs}`);
  }
}

/**
 * Resolve PGlite data directory.
 * Relative paths are resolved against the monorepo project root — NEVER process.cwd().
 */
export function resolvePgliteDataDir(databaseUrl: string): string {
  let dir = databaseUrl.replace(/^pglite:/i, "").replace(/^file:/i, "");
  // pglite://.data/gia-v3  or  pglite:///D:/...  or  pglite://D:/...
  dir = dir.replace(/^\/\//, "");
  if (dir.startsWith("/") && /^\/[A-Za-z]:[\\/]/.test(dir)) {
    // "/D:/path" from URL parsing — strip leading slash on Windows drive paths
    dir = dir.slice(1);
  } else {
    dir = dir.replace(/^\/+/, "");
  }
  if (!dir) dir = ".data/gia-shawarma";

  const root = findProjectRoot();
  if (!path.isAbsolute(dir)) {
    dir = path.resolve(root, dir);
  } else {
    dir = path.resolve(dir);
  }

  assertSafePgliteDataDir(dir, databaseUrl);
  return dir;
}

export type DatabaseRuntimeInfo = {
  mode: "pglite" | "postgresql";
  kind: "v3-production" | "v3-test" | "legacy-or-other" | "postgresql";
  absolutePath: string | null;
  databaseUrlRedacted: string;
};

let lastRuntimeInfo: DatabaseRuntimeInfo | null = null;

export function getDatabaseRuntimeInfo(): DatabaseRuntimeInfo | null {
  return lastRuntimeInfo;
}

export function setDatabaseRuntimeInfo(info: DatabaseRuntimeInfo): void {
  lastRuntimeInfo = info;
}

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
  inventory_item_id INTEGER REFERENCES v3_inventory_items(id),
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
  `ALTER TABLE v3_warehouse_movements ALTER COLUMN inventory_item_id DROP NOT NULL`,
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
  `ALTER TABLE v3_purchases ADD COLUMN IF NOT EXISTS updated_by TEXT`,
  `ALTER TABLE v3_purchases ADD COLUMN IF NOT EXISTS invoice_number TEXT`,
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
  // PHASE 7 — employees + attendance + payroll
  `CREATE TABLE IF NOT EXISTS v3_employees (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  secondary_phone TEXT,
  job_title TEXT NOT NULL DEFAULT '',
  salary_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  salary_type TEXT NOT NULL DEFAULT 'MONTHLY',
  work_start_date DATE NOT NULL,
  work_end_date DATE,
  expected_daily_hours NUMERIC(6, 2),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE TABLE IF NOT EXISTS v3_attendance (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES v3_employees(id),
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL,
  check_in_time TEXT,
  check_out_time TEXT,
  worked_hours NUMERIC(8, 2),
  notes TEXT,
  actor TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_attendance_employee_date_uidx ON v3_attendance (employee_id, attendance_date)`,
  `CREATE TABLE IF NOT EXISTS v3_payroll (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES v3_employees(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  base_salary NUMERIC(14, 2) NOT NULL,
  absence_days INTEGER NOT NULL DEFAULT 0,
  manual_deduction NUMERIC(14, 2) NOT NULL DEFAULT 0,
  manual_bonus NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_salary NUMERIC(14, 2) NOT NULL,
  paid_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  payment_date DATE,
  notes TEXT,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_payroll_employee_period_uidx ON v3_payroll (employee_id, year, month)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_payroll_client_request_uidx ON v3_payroll (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_salary_payments (
  id SERIAL PRIMARY KEY,
  payroll_id INTEGER NOT NULL REFERENCES v3_payroll(id),
  amount NUMERIC(14, 2) NOT NULL,
  payment_date DATE NOT NULL,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_salary_payments_client_request_uidx ON v3_salary_payments (client_request_id)`,
  // PHASE 9 — product short code + movement audit + stocktakes
  `ALTER TABLE v3_inventory_items ADD COLUMN IF NOT EXISTS short_code TEXT`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS source_channel TEXT`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS qty_before NUMERIC(14, 4)`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS qty_after NUMERIC(14, 4)`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS item_name_snapshot TEXT`,
  `ALTER TABLE v3_warehouse_movements ADD COLUMN IF NOT EXISTS actor_role TEXT`,
  `CREATE TABLE IF NOT EXISTS v3_stocktakes (
  id SERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  notes TEXT,
  started_by TEXT NOT NULL DEFAULT '',
  started_by_user_id INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_by TEXT,
  completed_by_user_id INTEGER,
  completed_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ,
  client_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_stocktakes_client_request_uidx ON v3_stocktakes (client_request_id)`,
  `CREATE TABLE IF NOT EXISTS v3_stocktake_lines (
  id SERIAL PRIMARY KEY,
  stocktake_id INTEGER NOT NULL REFERENCES v3_stocktakes(id),
  inventory_item_id INTEGER NOT NULL REFERENCES v3_inventory_items(id),
  system_quantity_before NUMERIC(14, 4),
  counted_quantity NUMERIC(14, 4),
  difference NUMERIC(14, 4),
  unit TEXT NOT NULL DEFAULT '',
  counted_by TEXT,
  counted_by_user_id INTEGER,
  counted_at TIMESTAMPTZ,
  notes TEXT,
  adjustment_movement_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS v3_stocktake_lines_stocktake_item_uidx ON v3_stocktake_lines (stocktake_id, inventory_item_id)`,
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

  // PHASE 9 — ensure every inventory item has a stable unique QR token (additive backfill).
  try {
    const missing = await database.execute(sql`
      SELECT id FROM v3_inventory_items
      WHERE qr_token IS NULL OR TRIM(qr_token) = ''
      ORDER BY id
    `);
    const rows = ((missing as unknown as { rows?: Array<{ id: number }> }).rows
      ?? (Array.isArray(missing) ? (missing as Array<{ id: number }>) : [])) as Array<{ id: number }>;
    for (const r of rows) {
      const token = `v3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${r.id}`;
      await database.execute(sql`
        UPDATE v3_inventory_items
        SET qr_token = ${token}, updated_at = NOW()
        WHERE id = ${r.id} AND (qr_token IS NULL OR TRIM(qr_token) = '')
      `);
    }
  } catch {
    // ignore on race / empty DB
  }
}




