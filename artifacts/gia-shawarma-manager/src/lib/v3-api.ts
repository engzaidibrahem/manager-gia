/** GIA V3 API client — warehouse + purchases + finance + employees. */
import { customFetch } from "@workspace/api-client-react";

type ApiErrLike = {
  status: number;
  data?: { message?: string; error?: string; code?: string } | null;
  message?: string;
};

function isApiErr(err: unknown): err is ApiErrLike {
  return Boolean(
    err &&
      typeof err === "object" &&
      "status" in err &&
      typeof (err as { status: unknown }).status === "number",
  );
}

/**
 * All V3 calls must use the same auth mechanism as the rest of the app:
 * customFetch + Authorization: Bearer <localStorage token>.
 * Raw fetch with credentials:include alone is NOT enough — login stores JWT
 * in localStorage and does not set an auth cookie.
 */
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
    throw new Error(friendlyV3Error(err));
  }
}

/** Map auth / API failures to clear Arabic messages for restaurant staff. */
export function friendlyV3Error(err: unknown): string {
  if (isApiErr(err)) {
    const status = err.status;
    const data = err.data ?? null;
    const serverMsg = (data?.message || "").trim();
    const serverErr = (data?.error || "").trim();

    if (status === 401) {
      return "انتهت جلسة تسجيل الدخول، يرجى تسجيل الدخول مرة أخرى.";
    }
    if (status === 403 || serverErr === "UNAUTHORIZED_OPERATION" || data?.code === "UNAUTHORIZED_OPERATION") {
      return "ليس لديك صلاحية لتنفيذ هذه العملية.";
    }
    if (serverMsg) return serverMsg;
    if (
      serverErr &&
      !/^HTTP\b/i.test(serverErr) &&
      serverErr !== "Authentication required" &&
      serverErr !== "Invalid or expired token"
    ) {
      return serverErr;
    }
    return serverMsg || "حدث خطأ أثناء تنفيذ العملية.";
  }
  if (err instanceof Error) {
    if (/^HTTP\s*401\b/i.test(err.message) || /Authentication required|Invalid or expired token/i.test(err.message)) {
      return "انتهت جلسة تسجيل الدخول، يرجى تسجيل الدخول مرة أخرى.";
    }
    if (/^HTTP\s*403\b/i.test(err.message) || /Forbidden|permission/i.test(err.message)) {
      return "ليس لديك صلاحية لتنفيذ هذه العملية.";
    }
    if (/^HTTP\s*\d+/i.test(err.message)) {
      return "حدث خطأ أثناء تنفيذ العملية.";
    }
    return err.message;
  }
  return "حدث خطأ أثناء تنفيذ العملية.";
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
  isNegative?: boolean;
  reviewReason?: string | null;
};

export type V3Purchase = {
  id: number;
  purchaseDate: string;
  purchaseTime: string;
  itemName: string;
  inventoryItemId: number | null;
  quantityNumeric: number | null;
  quantityRaw: string;
  unitRaw: string;
  unitPrice: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  paymentStatus: string;
  supplier: string;
  purchasedBy: string;
  destination: string;
  notes: string | null;
  status: string;
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
    displayUnit?: string;
    kitchenQty: number;
    lastTransferDate: string | null;
    lastUpdated?: string | null;
    unitNeedsReview?: boolean;
  }> }>("/kitchen");
}

export function createV3Item(body: {
  name: string;
  category?: string;
  baseUnit?: string;
  minimumStock?: number | null;
}) {
  return api<{ item?: { id: number }; id?: number }>("/warehouse/items", { method: "POST", body: JSON.stringify(body) });
}

export function getV3WarehouseItem(id: number) {
  return api<{
    item: V3WarehouseRow;
    movements: Array<Record<string, unknown>>;
  }>(`/warehouse/items/${id}`);
}

export function listV3PurchasePayments(id: number) {
  return api<{ rows: Array<Record<string, unknown>> }>(`/purchases/${id}/payments`);
}

export function listV3Purchases(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: V3Purchase[]; total: number; page: number; pageSize: number }>(`/purchases?${q}`);
}

export type V3PurchaseCommit = {
  committed: true;
  idempotent?: boolean;
  purchaseId: number;
  inventoryItemId: number | null;
  movementId: number | null;
  destination: string;
  quantityNumeric: number | null;
  paymentStatus: string;
  purchase: V3Purchase & Record<string, unknown>;
};

/** Reject ambiguous/partial API payloads so UI never shows fake success. */
export function assertPurchaseCommitted(
  raw: unknown,
  expectedDestination?: string,
): V3PurchaseCommit {
  const r = raw as Partial<V3PurchaseCommit> | null;
  const purchase = (r?.purchase ?? null) as (V3Purchase & Record<string, unknown>) | null;
  const purchaseId = Number(r?.purchaseId ?? purchase?.id);
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    throw new Error("لم يتم تأكيد حفظ المشتريات من الخادم — لم يُرجع رقم المشتريات.");
  }
  const destination = String(r?.destination ?? purchase?.destination ?? "");
  if (!destination) {
    throw new Error("لم يتم تأكيد وجهة المشتريات من الخادم.");
  }
  if (expectedDestination && destination !== expectedDestination) {
    throw new Error("وجهة المشتريات المحفوظة لا تطابق ما أُرسل.");
  }
  const inventoryItemIdRaw = r?.inventoryItemId ?? purchase?.inventoryItemId ?? null;
  const inventoryItemId =
    inventoryItemIdRaw == null || (typeof inventoryItemIdRaw === "string" && inventoryItemIdRaw === "")
      ? null
      : Number(inventoryItemIdRaw);
  const movementIdRaw = r?.movementId ?? (purchase as { movementId?: number | null } | null)?.movementId ?? null;
  const movementId =
    movementIdRaw == null || (typeof movementIdRaw === "string" && movementIdRaw === "")
      ? null
      : Number(movementIdRaw);

  if (destination === "WAREHOUSE" || destination === "KITCHEN_DIRECT") {
    if (!(inventoryItemId != null && inventoryItemId > 0)) {
      throw new Error("لم يتم تأكيد ربط مادة المخزون بعد الحفظ.");
    }
    if (!(movementId != null && movementId > 0)) {
      throw new Error("لم يتم تأكيد حركة المخزون بعد الحفظ.");
    }
  }
  if (destination === "CONSUMABLE" && movementId != null) {
    throw new Error("استجابة غير متوقعة: مشتريات مستهلكات يجب ألا تُنشئ حركة مخزون.");
  }

  return {
    committed: true,
    idempotent: Boolean(r?.idempotent),
    purchaseId,
    inventoryItemId,
    movementId,
    destination,
    quantityNumeric:
      r?.quantityNumeric != null
        ? Number(r.quantityNumeric)
        : purchase?.quantityNumeric != null
          ? Number(purchase.quantityNumeric)
          : null,
    paymentStatus: String(r?.paymentStatus ?? purchase?.paymentStatus ?? ""),
    purchase: { ...(purchase || ({} as V3Purchase)), id: purchaseId, destination } as V3Purchase &
      Record<string, unknown>,
  };
}

export function assertWarehouseInCommitted(raw: unknown): {
  movementId: number;
  inventoryItemId: number;
} {
  const r = raw as { movement?: { id?: number; inventoryItemId?: number }; item?: { id?: number } } | null;
  const movementId = Number(r?.movement?.id);
  const inventoryItemId = Number(r?.movement?.inventoryItemId ?? r?.item?.id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    throw new Error("لم يتم تأكيد إدخال المستودع من الخادم.");
  }
  if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
    throw new Error("لم يتم تأكيد مادة المستودع من الخادم.");
  }
  return { movementId, inventoryItemId };
}

export function postV3Purchase(body: Record<string, unknown>) {
  return api<V3PurchaseCommit>("/purchases", { method: "POST", body: JSON.stringify(body) });
}

export type V3ImportValidateResult = {
  schemaVersion: string;
  fileFingerprint: string;
  rowCount: number;
  rows: Array<{
    schemaVersion: string;
    lineNo: number;
    purchaseDate: string;
    purchaseTime: string;
    supplier: string;
    invoiceNumber: string;
    itemName: string;
    quantityNumeric: number | null;
    quantityRaw: string;
    unitRaw: string;
    unitPrice: number;
    totalAmount: number;
    paidAmountHint: number | null;
    paymentStatusHint: "PAID" | "UNPAID" | "PARTIAL" | null;
    notes: string;
    sourceImageRef: string;
    warnings: string[];
    priceMismatch: boolean;
    unclearQuantity: boolean;
  }>;
  groups: Array<{
    groupKey: string;
    purchaseDate: string;
    supplier: string;
    invoiceNumber: string;
    lineCount: number;
    invoiceTotal: number;
    paidHintSum: number;
    paymentStatusHint: "PAID" | "UNPAID" | "PARTIAL" | null;
    lineNos: number[];
    existingDuplicate: boolean;
  }>;
  warnings: Array<{ lineNo: number; warning: string }>;
};

export type V3ImportConfirmResult = {
  completeSuccess: boolean;
  purchasesCreated: number;
  purchasesIdempotent: number;
  warehouseEntries: number;
  kitchenEntries: number;
  consumables: number;
  paymentsCreated: number;
  allocationPreview: Array<{
    lineNo: number;
    totalAmount: number;
    paidAmount: number;
    paymentStatus: string;
  }>;
  lines: Array<Record<string, unknown>>;
  failures: Array<{ lineNo: number; error: string }>;
};

export function validateV3PurchaseImport(body: {
  workbookBase64?: string;
  fileFingerprint?: string;
  rows?: unknown[];
}) {
  return api<V3ImportValidateResult>("/purchases/import/validate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function confirmV3PurchaseImport(body: Record<string, unknown>) {
  return customFetch<V3ImportConfirmResult>(`/api/v3/purchases/import/confirm`, {
    credentials: "include",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    // 400 with structured failure payload is still useful for the UI.
    if (isApiErr(err) && err.data && typeof err.data === "object" && "completeSuccess" in (err.data as object)) {
      return err.data as V3ImportConfirmResult;
    }
    throw new Error(friendlyV3Error(err));
  });
}

export function patchV3Purchase(id: number, body: Record<string, unknown>) {
  return api<{ committed?: boolean; purchaseId?: number; purchase?: V3Purchase }>(
    `/purchases/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function postV3PurchasePayment(id: number, body: Record<string, unknown>) {
  return api(`/purchases/${id}/payments`, { method: "POST", body: JSON.stringify(body) });
}

export function voidV3Purchase(id: number, voidReason: string) {
  return api(`/purchases/${id}/void`, { method: "POST", body: JSON.stringify({ voidReason }) });
}

export function getV3FinanceSummary() {
  return api<{
    netCapital: number;
    totalIncome: number;
    totalExpenses: number;
    totalPurchasePayments: number;
    totalSalaryPayments: number;
    available: number;
  }>("/finance/summary");
}

export function listV3Capital() {
  return api<{ rows: Array<Record<string, unknown>> }>("/finance/capital");
}

export function postV3Capital(body: Record<string, unknown>) {
  return api("/finance/capital", { method: "POST", body: JSON.stringify(body) });
}

export function voidV3Capital(id: number, voidReason: string) {
  return api(`/finance/capital/${id}/void`, { method: "POST", body: JSON.stringify({ voidReason }) });
}

export function listV3Income() {
  return api<{ rows: Array<Record<string, unknown>> }>("/finance/income");
}

export function postV3Income(body: Record<string, unknown>) {
  return api("/finance/income", { method: "POST", body: JSON.stringify(body) });
}

export function voidV3Income(id: number, voidReason: string) {
  return api(`/finance/income/${id}/void`, { method: "POST", body: JSON.stringify({ voidReason }) });
}

export function listV3Expenses() {
  return api<{ rows: Array<Record<string, unknown>> }>("/finance/expenses");
}

export function postV3Expense(body: Record<string, unknown>) {
  return api("/finance/expenses", { method: "POST", body: JSON.stringify(body) });
}

export function voidV3Expense(id: number, voidReason: string) {
  return api(`/finance/expenses/${id}/void`, { method: "POST", body: JSON.stringify({ voidReason }) });
}

export type V3Employee = {
  id: number;
  fullName: string;
  phone: string | null;
  secondaryPhone: string | null;
  jobTitle: string;
  salaryAmount: number;
  salaryType: "MONTHLY" | "DAILY";
  workStartDate: string;
  workEndDate: string | null;
  expectedDailyHours: number | null;
  notes: string | null;
  isActive: boolean;
};

export function listV3Employees(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: V3Employee[]; total: number; page: number; pageSize: number }>(`/employees?${q}`);
}

export function getV3Employee(id: number) {
  return api<{ employee: V3Employee }>(`/employees/${id}`);
}

export function postV3Employee(body: Record<string, unknown>) {
  return api<{ employee: V3Employee }>("/employees", { method: "POST", body: JSON.stringify(body) });
}

export function patchV3Employee(id: number, body: Record<string, unknown>) {
  return api<{ employee: V3Employee }>(`/employees/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function endV3Employee(id: number, workEndDate?: string) {
  return api<{ employee: V3Employee }>(`/employees/${id}/end`, {
    method: "POST",
    body: JSON.stringify({ workEndDate }),
  });
}

export function listV3Attendance(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{
    rows: Array<{
      id: number;
      employeeId: number;
      employeeName: string;
      attendanceDate: string;
      status: string;
      checkInTime: string | null;
      checkOutTime: string | null;
      workedHours: number | null;
      notes: string | null;
    }>;
    total: number;
  }>(`/attendance?${q}`);
}

export function postV3Attendance(body: Record<string, unknown>) {
  return api("/attendance", { method: "POST", body: JSON.stringify(body) });
}

export function getV3AttendanceSummary(employeeId: number, year: number, month: number) {
  return api<{
    presentDays: number;
    absentDays: number;
    leaveDays: number;
    totalWorkedHours: number;
  }>(`/employees/${employeeId}/attendance-summary?year=${year}&month=${month}`);
}

export function listV3Payroll(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{
    rows: Array<{
      id: number;
      employeeId: number;
      employeeName: string;
      year: number;
      month: number;
      baseSalary: number;
      absenceDays: number;
      manualDeduction: number;
      manualBonus: number;
      netSalary: number;
      paidAmount: number;
      remaining: number;
      paymentStatus: string;
      notes: string | null;
    }>;
  }>(`/payroll?${q}`);
}

export function postV3Payroll(body: Record<string, unknown>) {
  return api("/payroll", { method: "POST", body: JSON.stringify(body) });
}

export function postV3SalaryPayment(payrollId: number, body: Record<string, unknown>) {
  return api(`/payroll/${payrollId}/payments`, { method: "POST", body: JSON.stringify(body) });
}

export function listV3SalaryPayments(payrollId: number) {
  return api<{ rows: Array<Record<string, unknown>> }>(`/payroll/${payrollId}/payments`);
}

export function salaryTypeLabel(s: string, lang: "ar" | "id") {
  if (s === "DAILY") return lang === "id" ? "Harian" : "يومي";
  return lang === "id" ? "Bulanan" : "شهري";
}

export function attendanceStatusLabel(s: string, lang: "ar" | "id") {
  if (s === "PRESENT") return lang === "id" ? "Hadir" : "حضور";
  if (s === "ABSENT") return lang === "id" ? "Absen" : "غياب";
  return lang === "id" ? "Cuti" : "إجازة";
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

export function paymentStatusLabel(s: string, lang: "ar" | "id") {
  if (s === "PAID") return lang === "id" ? "Lunas" : "مدفوع";
  if (s === "PARTIAL") return lang === "id" ? "Sebagian" : "مدفوع جزئياً";
  return lang === "id" ? "Belum bayar" : "غير مدفوع";
}

export function destinationLabel(s: string, lang: "ar" | "id") {
  if (s === "WAREHOUSE") return lang === "id" ? "Ke gudang" : "للمستودع";
  if (s === "KITCHEN_DIRECT") return lang === "id" ? "Ke dapur langsung" : "للمطبخ مباشرة";
  return lang === "id" ? "Pembelian saja / konsumsi" : "مشتريات فقط / مستهلكات";
}
