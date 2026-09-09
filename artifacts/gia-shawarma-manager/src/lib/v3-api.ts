/** GIA V3 API client — warehouse only (phase 1). */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v3${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `HTTP ${res.status}`);
  }
  return data as T;
}

export type V3WarehouseRow = {
  id: number;
  name: string;
  category: string;
  baseUnit: string;
  openingNumeric: number | null;
  openingRaw: string;
  openingUnitRaw: string;
  totalIn: number;
  totalOut: number;
  currentWarehouse: number | null;
  minimumStock: number | null;
  status: "available" | "low" | "out" | "unknown";
  kitchenQty: number | null;
  sourceType?: string;
  sourceExcelRow?: number | null;
  originalNameRaw?: string | null;
  needsQuantityReview?: boolean;
  needsReview?: boolean;
};

export function listV3Warehouse(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: V3WarehouseRow[]; total: number; page: number; pageSize: number; categories: string[] }>(
    `/warehouse/summary?${q}`,
  );
}

export function listV3Items(q = "") {
  return api<{ rows: Array<{ id: number; name: string; category: string; baseUnit: string; warehouseQtyNumeric: number | null }> }>(
    `/warehouse/items?q=${encodeURIComponent(q)}`,
  );
}

export function postV3Opening(body: Record<string, unknown>) {
  return api("/warehouse/opening", { method: "POST", body: JSON.stringify(body) });
}

export function postV3WarehouseIn(body: Record<string, unknown>) {
  return api("/warehouse/in", { method: "POST", body: JSON.stringify(body) });
}

export function postV3ToKitchen(body: Record<string, unknown>) {
  return api("/warehouse/to-kitchen", { method: "POST", body: JSON.stringify(body) });
}

export function listV3Movements(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: Array<Record<string, unknown>>; total: number }>(`/warehouse/movements?${q}`);
}

export function listV3Kitchen() {
  return api<{ rows: Array<{
    id: number;
    name: string;
    category: string;
    baseUnit: string;
    kitchenQty: number;
    lastTransferDate: string | null;
  }> }>("/kitchen");
}

export function createV3Item(body: { name: string; category?: string; baseUnit?: string }) {
  return api("/warehouse/items", { method: "POST", body: JSON.stringify(body) });
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function newClientRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `v3-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function statusLabel(status: V3WarehouseRow["status"], lang: "ar" | "id", needsReview?: boolean) {
  if (needsReview || status === "unknown") {
    return lang === "id" ? "Perlu review" : "بحاجة مراجعة";
  }
  if (lang === "id") {
    if (status === "out") return "Habis";
    if (status === "low") return "Rendah";
    if (status === "available") return "Tersedia";
    return "Perlu review";
  }
  if (status === "out") return "نفد";
  if (status === "low") return "منخفض";
  if (status === "available") return "متوفر";
  return "بحاجة مراجعة";
}
