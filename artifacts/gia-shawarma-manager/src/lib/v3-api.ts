/** GIA V3 API client — warehouse + purchases + finance. */

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
  isNegative?: boolean;
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
    kitchenQty: number;
    lastTransferDate: string | null;
  }> }>("/kitchen");
}

export function createV3Item(body: { name: string; category?: string; baseUnit?: string }) {
  return api("/warehouse/items", { method: "POST", body: JSON.stringify(body) });
}

export function listV3Purchases(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") q.set(k, String(v));
  });
  return api<{ rows: V3Purchase[]; total: number; page: number; pageSize: number }>(`/purchases?${q}`);
}

export function postV3Purchase(body: Record<string, unknown>) {
  return api("/purchases", { method: "POST", body: JSON.stringify(body) });
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
  if (s === "WAREHOUSE") return lang === "id" ? "Gudang" : "المستودع";
  if (s === "KITCHEN_DIRECT") return lang === "id" ? "Dapur langsung" : "المطبخ مباشرة";
  return lang === "id" ? "Konsumsi" : "شراء عادي / مستهلك";
}
