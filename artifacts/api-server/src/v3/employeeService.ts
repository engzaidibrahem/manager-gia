/**
 * GIA V3 — Employees, attendance, payroll, salary payments.
 * No automatic absence deduction. Salary payment reduces Available Capital.
 */
import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import {
  db,
  v3AttendanceTable,
  v3EmployeesTable,
  v3PayrollTable,
  v3SalaryPaymentsTable,
} from "@workspace/db";
import { AppError } from "../lib/errors";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function resolvePaymentStatus(net: number, paid: number): "PAID" | "UNPAID" | "PARTIAL" {
  if (paid <= 0) return "UNPAID";
  if (paid + 1e-9 >= net) return "PAID";
  return "PARTIAL";
}

function mapEmployee(r: typeof v3EmployeesTable.$inferSelect) {
  return {
    ...r,
    salaryAmount: Number(r.salaryAmount),
    expectedDailyHours: r.expectedDailyHours == null ? null : Number(r.expectedDailyHours),
  };
}

export async function listEmployees(params: {
  q?: string;
  status?: "all" | "active" | "ended";
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
  const conditions = [];
  if (params.q?.trim()) {
    conditions.push(ilike(v3EmployeesTable.fullName, `%${params.q.trim()}%`));
  }
  if (params.status === "active") conditions.push(eq(v3EmployeesTable.isActive, true));
  if (params.status === "ended") conditions.push(eq(v3EmployeesTable.isActive, false));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(v3EmployeesTable)
    .where(where)
    .orderBy(desc(v3EmployeesTable.isActive), v3EmployeesTable.fullName)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(v3EmployeesTable)
    .where(where);

  return { rows: rows.map(mapEmployee), total: Number(c), page, pageSize };
}

export async function getEmployee(id: number) {
  const row = await db.query.v3EmployeesTable.findFirst({
    where: eq(v3EmployeesTable.id, id),
  });
  if (!row) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود", 404);
  return mapEmployee(row);
}

export async function createEmployee(input: {
  fullName: string;
  phone?: string | null;
  secondaryPhone?: string | null;
  jobTitle?: string;
  salaryAmount: number;
  salaryType: "MONTHLY" | "DAILY";
  workStartDate?: string;
  expectedDailyHours?: number | null;
  notes?: string | null;
}) {
  const name = input.fullName?.trim();
  if (!name) throw new AppError("VALIDATION_ERROR", "اسم الموظف مطلوب");
  if (!["MONTHLY", "DAILY"].includes(input.salaryType)) {
    throw new AppError("VALIDATION_ERROR", "نوع الراتب غير صالح");
  }
  const salary = Number(input.salaryAmount);
  if (!(salary >= 0)) throw new AppError("VALIDATION_ERROR", "الراتب غير صالح");

  const [row] = await db
    .insert(v3EmployeesTable)
    .values({
      fullName: name,
      phone: input.phone?.trim() || null,
      secondaryPhone: input.secondaryPhone?.trim() || null,
      jobTitle: input.jobTitle?.trim() || "",
      salaryAmount: salary,
      salaryType: input.salaryType,
      workStartDate: input.workStartDate || todayISO(),
      expectedDailyHours: input.expectedDailyHours ?? null,
      notes: input.notes || null,
      isActive: true,
    })
    .returning();
  return mapEmployee(row);
}

export async function updateEmployee(
  id: number,
  input: {
    fullName?: string;
    phone?: string | null;
    secondaryPhone?: string | null;
    jobTitle?: string;
    salaryAmount?: number;
    salaryType?: "MONTHLY" | "DAILY";
    workStartDate?: string;
    expectedDailyHours?: number | null;
    notes?: string | null;
  },
) {
  const existing = await getEmployee(id);
  const patch: Partial<typeof v3EmployeesTable.$inferInsert> = { updatedAt: new Date() };
  if (input.fullName != null) {
    const n = input.fullName.trim();
    if (!n) throw new AppError("VALIDATION_ERROR", "اسم الموظف مطلوب");
    patch.fullName = n;
  }
  if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
  if (input.secondaryPhone !== undefined) patch.secondaryPhone = input.secondaryPhone?.trim() || null;
  if (input.jobTitle != null) patch.jobTitle = input.jobTitle.trim();
  if (input.salaryAmount != null) {
    const s = Number(input.salaryAmount);
    if (!(s >= 0)) throw new AppError("VALIDATION_ERROR", "الراتب غير صالح");
    patch.salaryAmount = s;
  }
  if (input.salaryType != null) {
    if (!["MONTHLY", "DAILY"].includes(input.salaryType)) {
      throw new AppError("VALIDATION_ERROR", "نوع الراتب غير صالح");
    }
    patch.salaryType = input.salaryType;
  }
  if (input.workStartDate != null) patch.workStartDate = input.workStartDate;
  if (input.expectedDailyHours !== undefined) patch.expectedDailyHours = input.expectedDailyHours;
  if (input.notes !== undefined) patch.notes = input.notes;

  const [row] = await db
    .update(v3EmployeesTable)
    .set(patch)
    .where(eq(v3EmployeesTable.id, existing.id))
    .returning();
  return mapEmployee(row);
}

export async function endEmployment(id: number, workEndDate?: string) {
  const existing = await getEmployee(id);
  if (!existing.isActive) return existing;
  const [row] = await db
    .update(v3EmployeesTable)
    .set({
      isActive: false,
      workEndDate: workEndDate || todayISO(),
      updatedAt: new Date(),
    })
    .where(eq(v3EmployeesTable.id, id))
    .returning();
  return mapEmployee(row);
}

/** Upsert: one record per employee + date. */
export async function upsertAttendance(input: {
  employeeId: number;
  attendanceDate: string;
  status: "PRESENT" | "ABSENT" | "LEAVE";
  checkInTime?: string | null;
  checkOutTime?: string | null;
  workedHours?: number | null;
  notes?: string | null;
  actor: string;
  userId?: number | null;
}) {
  await getEmployee(input.employeeId);
  if (!["PRESENT", "ABSENT", "LEAVE"].includes(input.status)) {
    throw new AppError("VALIDATION_ERROR", "حالة الحضور غير صالحة");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.attendanceDate)) {
    throw new AppError("VALIDATION_ERROR", "تاريخ الحضور غير صالح");
  }

  const existing = await db.query.v3AttendanceTable.findFirst({
    where: and(
      eq(v3AttendanceTable.employeeId, input.employeeId),
      eq(v3AttendanceTable.attendanceDate, input.attendanceDate),
    ),
  });

  if (existing) {
    const [row] = await db
      .update(v3AttendanceTable)
      .set({
        status: input.status,
        checkInTime: input.checkInTime ?? null,
        checkOutTime: input.checkOutTime ?? null,
        workedHours: input.workedHours ?? null,
        notes: input.notes ?? null,
        actor: input.actor,
        userId: input.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(v3AttendanceTable.id, existing.id))
      .returning();
    return { created: false as const, row: mapAttendance(row) };
  }

  const [row] = await db
    .insert(v3AttendanceTable)
    .values({
      employeeId: input.employeeId,
      attendanceDate: input.attendanceDate,
      status: input.status,
      checkInTime: input.checkInTime ?? null,
      checkOutTime: input.checkOutTime ?? null,
      workedHours: input.workedHours ?? null,
      notes: input.notes ?? null,
      actor: input.actor,
      userId: input.userId ?? null,
    })
    .returning();
  return { created: true as const, row: mapAttendance(row) };
}

function mapAttendance(r: typeof v3AttendanceTable.$inferSelect) {
  return {
    ...r,
    workedHours: r.workedHours == null ? null : Number(r.workedHours),
  };
}

export async function listAttendance(params: {
  employeeId?: number;
  from?: string;
  to?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));
  const conditions = [];
  if (params.employeeId) conditions.push(eq(v3AttendanceTable.employeeId, params.employeeId));
  if (params.from) conditions.push(gte(v3AttendanceTable.attendanceDate, params.from));
  if (params.to) conditions.push(lte(v3AttendanceTable.attendanceDate, params.to));
  if (params.status) conditions.push(eq(v3AttendanceTable.status, params.status));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      attendance: v3AttendanceTable,
      employeeName: v3EmployeesTable.fullName,
    })
    .from(v3AttendanceTable)
    .innerJoin(v3EmployeesTable, eq(v3AttendanceTable.employeeId, v3EmployeesTable.id))
    .where(where)
    .orderBy(desc(v3AttendanceTable.attendanceDate), desc(v3AttendanceTable.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(v3AttendanceTable)
    .where(where);

  return {
    rows: rows.map((r) => ({
      ...mapAttendance(r.attendance),
      employeeName: r.employeeName,
    })),
    total: Number(c),
    page,
    pageSize,
  };
}

export async function attendanceSummary(employeeId: number, year: number, month: number) {
  await getEmployee(employeeId);
  const mm = String(month).padStart(2, "0");
  const from = `${year}-${mm}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;

  const rows = await db
    .select()
    .from(v3AttendanceTable)
    .where(
      and(
        eq(v3AttendanceTable.employeeId, employeeId),
        gte(v3AttendanceTable.attendanceDate, from),
        lte(v3AttendanceTable.attendanceDate, to),
      ),
    );

  let presentDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let totalWorkedHours = 0;
  for (const r of rows) {
    if (r.status === "PRESENT") presentDays += 1;
    else if (r.status === "ABSENT") absentDays += 1;
    else if (r.status === "LEAVE") leaveDays += 1;
    if (r.workedHours != null) totalWorkedHours += Number(r.workedHours);
  }

  return {
    employeeId,
    year,
    month,
    presentDays,
    absentDays,
    leaveDays,
    totalWorkedHours,
    rows: rows.map(mapAttendance),
  };
}

function mapPayroll(r: typeof v3PayrollTable.$inferSelect) {
  return {
    ...r,
    baseSalary: Number(r.baseSalary),
    manualDeduction: Number(r.manualDeduction),
    manualBonus: Number(r.manualBonus),
    netSalary: Number(r.netSalary),
    paidAmount: Number(r.paidAmount),
  };
}

export async function listPayroll(params: {
  employeeId?: number;
  year?: number;
  month?: number;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
  const conditions = [eq(v3PayrollTable.status, "active")];
  if (params.employeeId) conditions.push(eq(v3PayrollTable.employeeId, params.employeeId));
  if (params.year) conditions.push(eq(v3PayrollTable.year, params.year));
  if (params.month) conditions.push(eq(v3PayrollTable.month, params.month));
  const where = and(...conditions);

  const rows = await db
    .select({
      payroll: v3PayrollTable,
      employeeName: v3EmployeesTable.fullName,
      salaryType: v3EmployeesTable.salaryType,
    })
    .from(v3PayrollTable)
    .innerJoin(v3EmployeesTable, eq(v3PayrollTable.employeeId, v3EmployeesTable.id))
    .where(where)
    .orderBy(desc(v3PayrollTable.year), desc(v3PayrollTable.month), desc(v3PayrollTable.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((r) => ({
      ...mapPayroll(r.payroll),
      employeeName: r.employeeName,
      salaryType: r.salaryType,
      remaining: Number(r.payroll.netSalary) - Number(r.payroll.paidAmount),
    })),
    page,
    pageSize,
  };
}

export async function getPayroll(id: number) {
  const row = await db.query.v3PayrollTable.findFirst({
    where: eq(v3PayrollTable.id, id),
  });
  if (!row || row.status !== "active") throw new AppError("PAYROLL_NOT_FOUND", "سجل الراتب غير موجود", 404);
  return mapPayroll(row);
}

export async function createOrUpdatePayroll(input: {
  employeeId: number;
  year: number;
  month: number;
  baseSalary?: number;
  manualDeduction?: number;
  manualBonus?: number;
  notes?: string | null;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
  /** Manager-confirmed net override (e.g. daily). If omitted, computed. */
  confirmedNetSalary?: number;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3PayrollTable.findFirst({
      where: eq(v3PayrollTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) return { idempotent: true as const, payroll: mapPayroll(existing) };
  }

  const emp = await getEmployee(input.employeeId);
  if (!(input.year >= 2000 && input.year <= 2100)) throw new AppError("VALIDATION_ERROR", "السنة غير صالحة");
  if (!(input.month >= 1 && input.month <= 12)) throw new AppError("VALIDATION_ERROR", "الشهر غير صالح");

  const summary = await attendanceSummary(input.employeeId, input.year, input.month);
  const base =
    input.baseSalary != null
      ? Number(input.baseSalary)
      : Number(emp.salaryAmount);
  if (!(base >= 0)) throw new AppError("VALIDATION_ERROR", "الراتب الأساسي غير صالح");

  const deduction = Number(input.manualDeduction ?? 0);
  const bonus = Number(input.manualBonus ?? 0);
  if (deduction < 0 || bonus < 0) throw new AppError("VALIDATION_ERROR", "الخصم أو المكافأة غير صالح");

  let net =
    input.confirmedNetSalary != null
      ? Number(input.confirmedNetSalary)
      : base - deduction + bonus;
  if (!(net >= 0)) throw new AppError("VALIDATION_ERROR", "صافي الراتب غير صالح");

  const suggestedDaily =
    emp.salaryType === "DAILY" ? Number(emp.salaryAmount) * summary.presentDays : null;

  const existing = await db.query.v3PayrollTable.findFirst({
    where: and(
      eq(v3PayrollTable.employeeId, input.employeeId),
      eq(v3PayrollTable.year, input.year),
      eq(v3PayrollTable.month, input.month),
    ),
  });

  if (existing) {
    if (existing.status === "voided") {
      throw new AppError("VALIDATION_ERROR", "سجل الراتب ملغى لهذه الفترة");
    }
    const alreadyPaid = Number(existing.paidAmount);
    if (net + 1e-9 < alreadyPaid) {
      throw new AppError(
        "VALIDATION_ERROR",
        `لا يمكن خفض صافي الراتب إلى أقل من المدفوع (${alreadyPaid.toLocaleString("id-ID")})`,
      );
    }
    const paymentStatus = resolvePaymentStatus(net, alreadyPaid);
    const [row] = await db
      .update(v3PayrollTable)
      .set({
        baseSalary: base,
        absenceDays: summary.absentDays,
        manualDeduction: deduction,
        manualBonus: bonus,
        netSalary: net,
        paymentStatus,
        notes: input.notes ?? existing.notes,
        actor: input.actor,
        userId: input.userId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(v3PayrollTable.id, existing.id))
      .returning();
    return {
      idempotent: false as const,
      payroll: mapPayroll(row),
      attendanceSummary: summary,
      suggestedDaily,
    };
  }

  const [row] = await db
    .insert(v3PayrollTable)
    .values({
      employeeId: input.employeeId,
      year: input.year,
      month: input.month,
      baseSalary: base,
      absenceDays: summary.absentDays,
      manualDeduction: deduction,
      manualBonus: bonus,
      netSalary: net,
      paidAmount: 0,
      paymentStatus: "UNPAID",
      notes: input.notes || null,
      actor: input.actor,
      userId: input.userId ?? null,
      clientRequestId: input.clientRequestId?.trim() || null,
    })
    .returning();

  return {
    idempotent: false as const,
    payroll: mapPayroll(row),
    attendanceSummary: summary,
    suggestedDaily,
  };
}

export async function addSalaryPayment(input: {
  payrollId: number;
  amount: number;
  paymentDate?: string;
  paidBy?: string;
  notes?: string | null;
  actor: string;
  userId?: number | null;
  clientRequestId?: string;
}) {
  if (input.clientRequestId?.trim()) {
    const existing = await db.query.v3SalaryPaymentsTable.findFirst({
      where: eq(v3SalaryPaymentsTable.clientRequestId, input.clientRequestId.trim()),
    });
    if (existing) {
      const payroll = await getPayroll(existing.payrollId);
      return { idempotent: true as const, payment: existing, payroll };
    }
  }

  const amount = Number(input.amount);
  if (!(amount > 0)) throw new AppError("VALIDATION_ERROR", "مبلغ الدفعة يجب أن يكون أكبر من صفر");

  return db.transaction(async (tx) => {
    const payroll = await tx.query.v3PayrollTable.findFirst({
      where: eq(v3PayrollTable.id, input.payrollId),
    });
    if (!payroll || payroll.status !== "active") {
      throw new AppError("PAYROLL_NOT_FOUND", "سجل الراتب غير موجود", 404);
    }
    const net = Number(payroll.netSalary);
    const already = Number(payroll.paidAmount);
    const remaining = net - already;
    if (amount > remaining + 1e-9) {
      throw new AppError("VALIDATION_ERROR", `المبلغ أكبر من المتبقي (${remaining})`);
    }

    const [payment] = await tx
      .insert(v3SalaryPaymentsTable)
      .values({
        payrollId: payroll.id,
        amount,
        paymentDate: input.paymentDate || todayISO(),
        paidBy: input.paidBy?.trim() || input.actor,
        notes: input.notes || null,
        actor: input.actor,
        userId: input.userId ?? null,
        clientRequestId: input.clientRequestId?.trim() || null,
      })
      .returning();

    const newPaid = already + amount;
    const paymentStatus = resolvePaymentStatus(net, newPaid);
    const [updated] = await tx
      .update(v3PayrollTable)
      .set({
        paidAmount: newPaid,
        paymentStatus,
        paymentDate: paymentStatus === "PAID" ? (input.paymentDate || todayISO()) : payroll.paymentDate,
        updatedAt: new Date(),
      })
      .where(eq(v3PayrollTable.id, payroll.id))
      .returning();

    return {
      idempotent: false as const,
      payment,
      payroll: mapPayroll(updated),
      remaining: net - newPaid,
    };
  });
}

export async function listSalaryPayments(payrollId: number) {
  await getPayroll(payrollId);
  const rows = await db
    .select()
    .from(v3SalaryPaymentsTable)
    .where(and(eq(v3SalaryPaymentsTable.payrollId, payrollId), eq(v3SalaryPaymentsTable.status, "active")))
    .orderBy(desc(v3SalaryPaymentsTable.paymentDate), desc(v3SalaryPaymentsTable.id));
  return { rows: rows.map((r) => ({ ...r, amount: Number(r.amount) })) };
}

export async function voidSalaryPayment(input: {
  paymentId: number;
  voidedBy: string;
  voidReason: string;
}) {
  return db.transaction(async (tx) => {
    const payment = await tx.query.v3SalaryPaymentsTable.findFirst({
      where: eq(v3SalaryPaymentsTable.id, input.paymentId),
    });
    if (!payment) throw new AppError("MOVEMENT_NOT_FOUND", "دفعة الراتب غير موجودة", 404);
    if (payment.status === "voided") return { idempotent: true as const };

    await tx
      .update(v3SalaryPaymentsTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        voidedBy: input.voidedBy,
        voidReason: input.voidReason,
      })
      .where(eq(v3SalaryPaymentsTable.id, payment.id));

    const payroll = await tx.query.v3PayrollTable.findFirst({
      where: eq(v3PayrollTable.id, payment.payrollId),
    });
    if (!payroll) throw new AppError("PAYROLL_NOT_FOUND", "سجل الراتب غير موجود", 404);

    const pays = await tx
      .select()
      .from(v3SalaryPaymentsTable)
      .where(
        and(eq(v3SalaryPaymentsTable.payrollId, payroll.id), eq(v3SalaryPaymentsTable.status, "active")),
      );
    const newPaid = pays.reduce((s, p) => s + Number(p.amount), 0);
    const net = Number(payroll.netSalary);
    await tx
      .update(v3PayrollTable)
      .set({
        paidAmount: newPaid,
        paymentStatus: resolvePaymentStatus(net, newPaid),
        paymentDate: resolvePaymentStatus(net, newPaid) === "PAID" ? payroll.paymentDate : null,
        updatedAt: new Date(),
      })
      .where(eq(v3PayrollTable.id, payroll.id));

    return { idempotent: false as const };
  });
}

export async function totalActiveSalaryPayments(): Promise<number> {
  const rows = await db
    .select()
    .from(v3SalaryPaymentsTable)
    .where(eq(v3SalaryPaymentsTable.status, "active"));
  return rows.reduce((s, r) => s + Number(r.amount), 0);
}
