import { customFetch } from '@workspace/api-client-react';

export async function bulkSaveInventory(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/inventory/items/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function bulkSaveMovements(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/inventory/movements/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function bulkSaveTransfers(rows: unknown[]) {
  return customFetch<unknown[]>('/api/inventory/transfers/bulk-save', { method: 'POST', body: JSON.stringify({ rows }) });
}

export async function bulkSaveExpenses(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/finance/expenses/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
}

export async function bulkSaveIncome(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/finance/income/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
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

export async function listWaste(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return customFetch<Record<string, unknown>[]>(`/api/waste${qs}`);
}

export async function bulkSaveWaste(rows: unknown[], deleteIds: number[] = []) {
  return customFetch<unknown[]>('/api/waste/bulk-save', { method: 'POST', body: JSON.stringify({ rows, deleteIds }) });
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
    costPerUnit: number;
    lineCost: number;
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
