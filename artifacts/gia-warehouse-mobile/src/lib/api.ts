/** Mobile V3 API — same Railway PostgreSQL source of truth as Web Admin. */
import { customFetch } from "@workspace/api-client-react";

type ApiErrLike = {
  status: number;
  data?: { message?: string; error?: string; code?: string } | null;
};

function isApiErr(err: unknown): err is ApiErrLike {
  return Boolean(err && typeof err === "object" && "status" in err);
}

export function friendlyError(err: unknown): string {
  if (isApiErr(err)) {
    const msg = (err.data?.message || "").trim();
    if (err.status === 401) return "انتهت جلسة تسجيل الدخول، يرجى تسجيل الدخول مرة أخرى.";
    if (err.status === 403) return "ليس لديك صلاحية لتنفيذ هذه العملية.";
    if (msg) return msg;
    if (err.data?.error) return String(err.data.error);
  }
  if (err instanceof Error) {
    if (/Failed to fetch|NetworkError|network/i.test(err.message)) {
      return "لم يتم تأكيد العملية. تحقق من الاتصال وحاول مجدداً.";
    }
    return err.message;
  }
  return "حدث خطأ أثناء تنفيذ العملية.";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await customFetch<T>(`/api/v3${path}`, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (err) {
    throw new Error(friendlyError(err));
  }
}

export function newClientRequestId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type ProductSearchRow = {
  id: number;
  name: string;
  baseUnit: string;
  warehouseQtyNumeric: number | null;
  minimumStock: number | null;
  stockStatus: string;
  hasQr: boolean;
};

export type ProductDetail = {
  id: number;
  name: string;
  category?: string;
  baseUnit: string;
  shortCode?: string | null;
  minimumStock: number | null;
  isActive?: boolean;
  warehouseQtyNumeric: number | null;
  kitchenQtyNumeric?: number | null;
  qrToken: string;
  hasQr?: boolean;
  stockStatus: string;
};

export type MovementResult = {
  idempotent?: boolean;
  movement?: {
    id: number;
    qtyBefore?: number | null;
    qtyAfter?: number | null;
    sourceChannel?: string | null;
    quantityRaw?: string;
    unitRaw?: string;
  };
  stockStatus?: string;
  balances?: { warehouseQtyNumeric?: number | null };
};

export function searchProducts(q: string, pageSize = 20) {
  const params = new URLSearchParams({ q, pageSize: String(pageSize), page: "1" });
  return api<{ rows: ProductSearchRow[]; total: number }>(`/products/search?${params}`);
}

export function listProducts(params: Record<string, string | number | undefined> = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: ProductDetail[]; total: number }>(`/products?${q}`);
}

export function getProductById(id: number) {
  return api<ProductDetail>(`/products/${id}`);
}

export function getProductByQr(token: string) {
  return api<ProductDetail>(`/products/by-qr/${encodeURIComponent(token)}`);
}

export function createProduct(body: Record<string, unknown>) {
  return api<ProductDetail>("/products", { method: "POST", body: JSON.stringify(body) });
}

export function updateProduct(id: number, body: Record<string, unknown>) {
  return api(`/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function ensureProductQr(id: number) {
  return api<{ item: ProductDetail; created: boolean }>(`/products/${id}/ensure-qr`, {
    method: "POST",
    body: "{}",
  });
}

export function generateMissingQr(itemIds?: number[]) {
  return api<{ generated: number }>("/products/qr/generate-missing", {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}

export function postWarehouseOut(body: Record<string, unknown>) {
  return api<MovementResult>("/warehouse/out", { method: "POST", body: JSON.stringify(body) });
}

export function postWarehouseIn(body: Record<string, unknown>) {
  return api<MovementResult>("/warehouse/in", { method: "POST", body: JSON.stringify(body) });
}

export function postToKitchen(body: Record<string, unknown>) {
  return api<MovementResult>("/warehouse/to-kitchen", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getStockAlerts() {
  return api<{
    summary: {
      total: number;
      normal: number;
      lowStock: number;
      outOfStock: number;
      reviewRequired: number;
      alertCount: number;
    };
    outOfStock: Array<Record<string, unknown>>;
    lowStock: Array<Record<string, unknown>>;
    reviewRequired: Array<Record<string, unknown>>;
  }>("/stock-alerts");
}

export function listMovements(params: Record<string, string | number | undefined> = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: Array<Record<string, unknown>>; total: number }>(`/warehouse/movements?${q}`);
}

export function listStocktakes(status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return api<{ rows: Array<{ id: number; status: string; notes?: string | null }>; total: number }>(
    `/stocktakes${q}`,
  );
}

export function startStocktake(body: Record<string, unknown> = {}) {
  return api<{ stocktake: { id: number; status: string }; idempotent: boolean }>("/stocktakes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getStocktake(id: number) {
  return api<{
    stocktake: { id: number; status: string; notes: string | null };
    lines: Array<{
      id: number;
      inventoryItemId: number;
      itemName: string;
      itemUnit: string;
      systemQuantityBefore: number | null;
      countedQuantity: number | null;
      difference: number | null;
      countStatus?: string;
      isActive?: boolean;
      notes?: string | null;
      qrToken?: string;
    }>;
  }>(`/stocktakes/${id}`);
}

export function getStocktakeProgress(id: number) {
  return api<{
    stocktakeId: number;
    status: string;
    totalProducts: number;
    countedProducts: number;
    remainingProducts: number;
    newProducts: number;
    differencesCount: number;
    canComplete: boolean;
    lines: Array<{
      inventoryItemId: number;
      itemName: string;
      itemUnit: string;
      systemQuantityBefore: number | null;
      countedQuantity: number | null;
      difference: number | null;
      countStatus: string;
      isActive: boolean;
      notes?: string | null;
    }>;
  }>(`/stocktakes/${id}/progress`);
}

export function upsertStocktakeLine(
  stocktakeId: number,
  itemId: number,
  body: Record<string, unknown>,
) {
  return api(`/stocktakes/${stocktakeId}/lines/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function addStocktakeProduct(stocktakeId: number, body: Record<string, unknown>) {
  return api(`/stocktakes/${stocktakeId}/products`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeStocktake(id: number) {
  return api(`/stocktakes/${id}/complete`, { method: "POST", body: "{}" });
}

export function cancelStocktake(id: number, reason?: string) {
  return api(`/stocktakes/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function assertCommitted(result: MovementResult): number {
  const id = result.movement?.id;
  if (!id) {
    throw new Error("لم يتم تأكيد العملية. تحقق من الاتصال وحاول مجدداً.");
  }
  return id;
}

export function statusLabel(s: string) {
  if (s === "NORMAL") return "طبيعي";
  if (s === "LOW_STOCK") return "مخزون منخفض";
  if (s === "OUT_OF_STOCK") return "نفد";
  if (s === "REVIEW_REQUIRED") return "يحتاج مراجعة";
  return s;
}

export function countStatusLabel(s: string) {
  if (s === "NOT_COUNTED") return "لم يتم الجرد";
  if (s === "COUNTED") return "تم الجرد";
  if (s === "DIFFERENCE") return "يوجد اختلاف";
  return s;
}

export function movementTypeLabel(t: string) {
  const map: Record<string, string> = {
    OPENING: "رصيد افتتاحي",
    WAREHOUSE_IN: "إدخال",
    WAREHOUSE_OUT: "إخراج",
    WAREHOUSE_TO_KITCHEN: "تحويل للمطبخ",
    KITCHEN_DIRECT_IN: "دخول مطبخ",
    ADJUSTMENT: "تعديل جرد",
  };
  return map[t] || t;
}

export function channelLabel(c: string | null | undefined) {
  if (!c) return "—";
  if (c === "MOBILE_QR") return "QR";
  if (c === "MOBILE_SEARCH") return "بحث";
  if (c === "MOBILE_ADMIN") return "موبايل أدمن";
  if (c === "WEB_ADMIN") return "ويب";
  if (c === "STOCKTAKE") return "جرد";
  return c;
}

export function qrImgUrl(token: string, size = 180) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(token)}`;
}
