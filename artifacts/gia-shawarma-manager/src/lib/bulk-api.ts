import { customFetch } from '@workspace/api-client-react';

export async function bulkSaveInventory(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/inventory/items/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

/** @deprecated Direct movement bulk-save bypasses typed services — use transferStock / adjustments / waste / reverse APIs. */
export async function bulkSaveMovements(_rows: unknown[], _deleteIds: number[] = []): Promise<never> {
  throw new Error('bulkSaveMovements is removed. Use POST /api/inventory/transfers, /adjustments, /waste, or /movements/:id/reverse.');
}

/** @deprecated Prefer transferStock() which posts to the canonical TransferService endpoint. */
export async function bulkSaveTransfers(_rows: unknown[]): Promise<never> {
  throw new Error('bulkSaveTransfers is removed. Use transferStock() → POST /api/inventory/transfers.');
}

export async function transferStock(body: {
  itemId?: number;
  qrToken?: string;
  quantity: number;
  unit?: string;
  from?: 'warehouse' | 'kitchen';
  to?: 'warehouse' | 'kitchen';
  note?: string;
  lotId?: number | null;
  method?: string;
}) {
  return customFetch<Record<string, unknown>>('/api/inventory/transfers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function bulkSaveExpenses(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/finance/expenses/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function bulkSaveIncome(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/finance/income/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export type CashDay = {
  date: string;
  openingBalance: number;
  suggestedOpening: number;
  isManual: boolean;
  notes: string;
  totalIncome: number;
  totalExpenses: number;
  totalPurchases: number;
  closingBalance: number;
  tomorrowDate?: string;
  tomorrowOpening?: number;
};

export async function getCashDay(date: string) {
  return customFetch<CashDay>(`/api/finance/cash-day?date=${encodeURIComponent(date)}`);
}

export async function saveCashDay(date: string, openingBalance: number, notes = '') {
  return customFetch<CashDay>('/api/finance/cash-day', {
    method: 'PUT',
    body: JSON.stringify({ date, openingBalance, notes }),
  });
}

export async function getFinancePurchasesToday(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return customFetch<{ date: string; count: number; totalCost: number; rows: Record<string, unknown>[] }>(
    `/api/finance/purchases/today${qs}`,
  );
}

export async function getFinanceInventoryValue() {
  return customFetch<{ warehouseValue: number; kitchenValue: number; totalValue: number; itemCount: number }>(
    '/api/finance/inventory-value',
  );
}

export type CapitalEntry = {
  id: number;
  entryDate: string;
  entryType: 'initial_capital' | 'additional_capital';
  description: string;
  amount: number;
  actor: string;
  status: string;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  clientRequestId?: string | null;
  createdAt: string;
};

export type OperationalSummary = {
  totalInitialCapital: number;
  totalAdditionalCapital: number;
  totalCapital: number;
  totalIncome: number;
  totalExpenses: number;
  totalPurchasePayments?: number;
  availableCapital?: number;
  operationalBalance: number;
  excludedPurchaseLikeTotal?: number;
  suspectedPurchaseExpenses?: Array<{
    id: number;
    category: string;
    description: string;
    amount: number;
    expenseDate: string;
    reason: string;
  }>;
  note?: string;
};

export async function listCapitalEntries(includeVoided = false) {
  const qs = includeVoided ? '?includeVoided=1' : '';
  return customFetch<CapitalEntry[]>(`/api/finance/capital${qs}`);
}

export async function createCapitalEntry(body: {
  entryDate: string;
  entryType: 'initial_capital' | 'additional_capital';
  amount: number;
  description?: string;
  clientRequestId?: string;
}) {
  return customFetch<{ entry: CapitalEntry; idempotent: boolean }>('/api/finance/capital', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function voidCapitalEntry(id: number, reason?: string) {
  return customFetch<{ entry: CapitalEntry; alreadyVoided: boolean }>(`/api/finance/capital/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function voidFinanceExpense(id: number, reason?: string) {
  return customFetch<{ alreadyVoided: boolean }>(`/api/finance/expenses/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function voidFinanceIncome(id: number, reason?: string) {
  return customFetch<{ alreadyVoided: boolean }>(`/api/finance/income/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function remediatePurchaseLikeExpenses(reason?: string) {
  return customFetch<{
    voidedCount: number;
    voidedIds: number[];
    totalVoidedAmount: number;
    summary: OperationalSummary;
  }>('/api/finance/expenses/remediate-purchase-duplicates', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getOperationalFinanceSummary() {
  return customFetch<OperationalSummary>('/api/finance/available-summary');
}

export async function getAvailableCapitalSummary() {
  return customFetch<OperationalSummary & {
    totalPurchasePayments: number;
    availableCapital: number;
  }>('/api/finance/available-summary');
}

export async function receiveGoods(body: {
  inventoryItemId?: number | null;
  newItem?: { name: string; category?: string; unit: string; minimumStock?: number; costPerUnit?: number; brand?: string };
  quantity: number;
  unit?: string;
  unitPrice: number;
  supplier: string;
  paymentMethod?: string;
  paymentStatus?: 'paid' | 'unpaid';
  purchaseDate?: string;
  notes?: string;
  clientRequestId?: string;
  purchaseId?: number | null;
}) {
  return customFetch<Record<string, unknown>>('/api/purchases/receive-goods', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function recordDailyPurchase(body: {
  destination: 'warehouse' | 'none';
  itemName: string;
  category?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  supplier: string;
  paymentMethod?: string;
  paymentStatus?: 'paid' | 'unpaid';
  purchaseDate?: string;
  notes?: string;
  inventoryItemId?: number | null;
  clientRequestId?: string;
}) {
  return customFetch<Record<string, unknown>>('/api/purchases/record', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function cancelDailyPurchase(id: number, reason?: string) {
  return customFetch<Record<string, unknown>>(`/api/purchases/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function getWarehouseSummary(from?: string, to?: string) {
  const sp = new URLSearchParams();
  if (from) sp.set('from', from);
  if (to) sp.set('to', to);
  const qs = sp.toString() ? `?${sp}` : '';
  return customFetch<Array<{
    id: number;
    name: string;
    category: string;
    unit: string;
    beginning: number;
    incoming: number;
    outgoing: number;
    waste: number;
    current: number;
    minimumStock: number;
    costPerUnit: number;
    lotGap: number;
    lastMovementAt: string | null;
    lastActor: string | null;
  }>>(`/api/inventory/warehouse-summary${qs}`);
}

export async function bulkSaveEmployees(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/staff/employees/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function bulkSaveAttendance(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/staff/attendance/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function listPurchases(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return customFetch<Record<string, unknown>[]>(`/api/purchases${qs}`);
}

export async function bulkSavePurchases(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/purchases/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function receivePurchase(purchaseId: number, body: { quantity: number; unit?: string; note?: string }) {
  return customFetch<Record<string, unknown>>(`/api/purchases/${purchaseId}/receive`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listWaste(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return customFetch<Record<string, unknown>[]>(`/api/waste${qs}`);
}

export async function bulkSaveWaste(rows: unknown[]) {
  return customFetch<unknown[]>('/api/waste/bulk-save', { method: 'POST', body: JSON.stringify({ rows }) });
}

export async function postInventoryWaste(body: {
  inventoryItemId: number;
  location: 'warehouse' | 'kitchen';
  quantity: number;
  unit?: string;
  reason?: 'spoilage' | 'prep' | 'theft' | 'other';
  note?: string;
  wasteDate?: string;
}) {
  return customFetch<Record<string, unknown>>('/api/inventory/waste', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export type RecipeComputed = {
  id: number;
  name: string;
  category: string;
  portions: number;
  targetFoodCostPct: number;
  sellingPrice: number;
  notes?: string;
  lines: {
    id: number;
    inventoryItemId: number;
    quantity: number;
    unit: string;
    yieldPct: number;
    itemName: string;
    itemUnit: string;
    convertedQuantity: number;
    convertedUnit: string;
    costPerUnit: number;
    lineCost: number;
    error?: string;
  }[];
  totalCost: number;
  costPerPortion: number;
  suggestedPrice: number;
  foodCostPct: number;
};

export async function listRecipes() {
  return customFetch<RecipeComputed[]>('/api/recipes');
}

export async function bulkSaveRecipes(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<RecipeComputed[]>('/api/recipes/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export type DayArchiveSummary = {
  id: number;
  businessDate: string;
  closedAt: string;
  closedBy: string;
  notes?: string | null;
  totalIncome: number;
  totalExpenses: number;
  netCash: number;
  totalPurchases: number;
  purchaseCount: number;
  wasteCost: number;
  kitchenMovements: number;
  attendanceCount: number;
  warehouseValue: number;
  kitchenValue: number;
  snapshot?: {
    date: string;
    purchases: Record<string, unknown>[];
    movements: Record<string, unknown>[];
    waste: Record<string, unknown>[];
    income: Record<string, unknown>[];
    expenses: Record<string, unknown>[];
    attendance: Record<string, unknown>[];
    stockAtClose: {
      id: number;
      name: string;
      category: string;
      unit: string;
      currentStock: number;
      kitchenStock: number;
      costPerUnit: number;
      warehouseValue: number;
      kitchenValue: number;
    }[];
  };
};

export async function listDayArchives() {
  return customFetch<DayArchiveSummary[]>('/api/day-archives');
}

export async function getDayArchive(date: string) {
  return customFetch<DayArchiveSummary>(`/api/day-archives/${encodeURIComponent(date)}`);
}

export async function getDayArchiveStatus(date: string) {
  return customFetch<{ date: string; archived: boolean; closedAt: string | null; closedBy: string | null }>(
    `/api/day-archives/${encodeURIComponent(date)}/status`,
  );
}

export async function closeDayArchive(body: { date?: string; closedBy?: string; notes?: string; force?: boolean } = {}) {
  return customFetch<DayArchiveSummary>('/api/day-archives/close', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export type WarehouseLot = {
  id: number;
  itemId: number;
  receiptDate: string;
  brand: string;
  quantityReceived: number;
  quantityRemaining: number;
  costPerUnit: number;
  note?: string | null;
  actor: string;
  archiveId?: number | null;
  createdAt: string;
  itemName?: string;
  itemUnit?: string;
  category?: string;
  qrToken?: string;
};

export type WarehouseDayArchive = {
  id: number;
  businessDate: string;
  closedAt: string;
  closedBy: string;
  notes?: string | null;
  receiptCount: number;
  totalQuantity: number;
  totalValue: number;
  snapshot?: {
    date: string;
    receipts: WarehouseLot[];
    stockAtClose: Record<string, unknown>[];
    searchText?: string;
  };
};

export async function listReceipts(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return customFetch<WarehouseLot[]>(`/api/inventory/receipts${qs}`);
}

export async function bulkSaveReceipts(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<WarehouseLot[]>('/api/inventory/receipts/bulk-save', {
    method: 'POST',
    body: JSON.stringify({ rows, deleteIds }),
  });
}

export async function listLots(params: { itemId?: number; q?: string; remaining?: boolean } = {}) {
  const sp = new URLSearchParams();
  if (params.itemId) sp.set('itemId', String(params.itemId));
  if (params.q) sp.set('q', params.q);
  if (params.remaining === false) sp.set('remaining', '0');
  const qs = sp.toString() ? `?${sp}` : '';
  return customFetch<WarehouseLot[]>(`/api/inventory/lots${qs}`);
}

export async function searchInventoryItems(q: string, withStock = true) {
  const sp = new URLSearchParams({ q });
  if (!withStock) sp.set('withStock', '0');
  return customFetch<Record<string, unknown>[]>(`/api/inventory/items/search?${sp}`);
}

export async function getItemByQr(token: string) {
  return customFetch<Record<string, unknown> & { lots: WarehouseLot[] }>(`/api/inventory/items/by-qr/${encodeURIComponent(token)}`);
}

export async function issueToKitchen(body: {
  itemId?: number;
  qrToken?: string;
  lotId?: number | null;
  quantity: number;
  actor: string;
  note?: string;
}) {
  return customFetch<{ movement: Record<string, unknown>; item: Record<string, unknown>; lotId: number | null }>(
    '/api/inventory/issue-to-kitchen',
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export type OpeningBalanceResult = {
  success: boolean;
  idempotent: boolean;
  clientRequestId: string | null;
  asOfDate: string;
  lineCount: number;
  totalValue: number;
  lines: Array<{
    itemId: number;
    itemName: string;
    quantity: number;
    unit: string;
    unitCost: number;
    lotId: number;
    movementId: number;
    warehouseStock: number;
  }>;
};

export async function postOpeningBalance(body: {
  lines: Array<{
    itemId: number;
    quantity: number;
    unit?: string;
    unitCost?: number;
    brand?: string;
    note?: string;
  }>;
  asOfDate?: string;
  notes?: string;
  allowDuplicateItems?: boolean;
  clientRequestId?: string;
}) {
  return customFetch<OpeningBalanceResult>('/api/inventory/opening-balance', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listIssues(params: { actor?: string; date?: string } = {}) {
  const sp = new URLSearchParams();
  if (params.actor) sp.set('actor', params.actor);
  if (params.date) sp.set('date', params.date);
  const qs = sp.toString() ? `?${sp}` : '';
  return customFetch<Record<string, unknown>[]>(`/api/inventory/issues${qs}`);
}

export async function listWarehouseArchives(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return customFetch<WarehouseDayArchive[]>(`/api/warehouse-archives${qs}`);
}

export async function getWarehouseArchive(date: string) {
  return customFetch<WarehouseDayArchive>(`/api/warehouse-archives/${encodeURIComponent(date)}`);
}

export async function getWarehouseArchiveStatus(date: string) {
  return customFetch<{ date: string; archived: boolean; closedAt: string | null; closedBy: string | null }>(
    `/api/warehouse-archives/${encodeURIComponent(date)}/status`,
  );
}

export async function closeWarehouseArchive(body: {
  date?: string;
  closedBy?: string;
  notes?: string;
  force?: boolean;
  rows?: unknown[];
} = {}) {
  return customFetch<WarehouseDayArchive>('/api/warehouse-archives/close', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
