/**
 * PHASE 7 — Employees + Attendance + Payroll tests.
 * MUST use gia-v3-test only. Never touch gia-v3.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { AppError } from "./errors";

const ROOT = path.resolve("d:/gia-shawarma-manager-self-host");
const TEST_DIR = path.resolve(ROOT, ".data/gia-v3-test");
const GUARD = path.resolve(ROOT, "backups/gia-v3-phase7-prod-guard.json");

async function countTable(db: typeof import("@workspace/db").db, table: string): Promise<number> {
  const { sql } = await import("drizzle-orm");
  try {
    const res = await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table}`));
    const r = res as { rows?: { c: number }[] } | { c: number }[];
    if (Array.isArray(r)) return Number(r[0]?.c ?? 0);
    return Number(r.rows?.[0]?.c ?? 0);
  } catch {
    return -1;
  }
}

async function snapshotProd(dbMod: typeof import("@workspace/db")) {
  return {
    inventory_items: await countTable(dbMod.db, "v3_inventory_items"),
    warehouse_movements: await countTable(dbMod.db, "v3_warehouse_movements"),
    purchases: await countTable(dbMod.db, "v3_purchases"),
    purchase_payments: await countTable(dbMod.db, "v3_purchase_payments"),
    capital_transactions: await countTable(dbMod.db, "v3_capital_transactions"),
    income: await countTable(dbMod.db, "v3_income"),
    expenses: await countTable(dbMod.db, "v3_expenses"),
    employees: await countTable(dbMod.db, "v3_employees"),
    attendance: await countTable(dbMod.db, "v3_attendance"),
    payroll: await countTable(dbMod.db, "v3_payroll"),
    salary_payments: await countTable(dbMod.db, "v3_salary_payments"),
  };
}

describe("V3 Employees + Attendance + Payroll", () => {
  let db: typeof import("@workspace/db").db;
  let tables: typeof import("@workspace/db");
  let closeDatabase: typeof import("@workspace/db").closeDatabase;
  let createEmployee: typeof import("../v3/employeeService").createEmployee;
  let upsertAttendance: typeof import("../v3/employeeService").upsertAttendance;
  let attendanceSummary: typeof import("../v3/employeeService").attendanceSummary;
  let createOrUpdatePayroll: typeof import("../v3/employeeService").createOrUpdatePayroll;
  let addSalaryPayment: typeof import("../v3/employeeService").addSalaryPayment;
  let postCapital: typeof import("../v3/financeService").postCapital;
  let getFinanceSummary: typeof import("../v3/financeService").getFinanceSummary;
  let prodBefore: Awaited<ReturnType<typeof snapshotProd>>;

  before(async () => {
    process.chdir(ROOT);

    process.env.DATABASE_URL = "pglite://.data/gia-v3";
    const dbMod0 = await import("@workspace/db");
    try {
      await dbMod0.closeDatabase();
    } catch {
      /* */
    }
    await dbMod0.initDatabase();
    prodBefore = await snapshotProd(dbMod0);
    fs.writeFileSync(GUARD, JSON.stringify({ before: prodBefore }, null, 2), "utf8");
    await dbMod0.closeDatabase();

    process.env.DATABASE_URL = "pglite://.data/gia-v3-test";
    for (let i = 0; i < 5; i++) {
      try {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 4) throw err;
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
    }
    await dbMod0.initDatabase();

    db = dbMod0.db;
    tables = dbMod0;
    closeDatabase = dbMod0.closeDatabase;

    const emp = await import("../v3/employeeService");
    const fi = await import("../v3/financeService");
    createEmployee = emp.createEmployee;
    upsertAttendance = emp.upsertAttendance;
    attendanceSummary = emp.attendanceSummary;
    createOrUpdatePayroll = emp.createOrUpdatePayroll;
    addSalaryPayment = emp.addSalaryPayment;
    postCapital = fi.postCapital;
    getFinanceSummary = fi.getFinanceSummary;
  });

  after(async () => {
    await closeDatabase();
    process.env.DATABASE_URL = "pglite://.data/gia-v3";
    const dbMod = await import("@workspace/db");
    await dbMod.initDatabase();
    const afterCounts = await snapshotProd(dbMod);
    fs.writeFileSync(GUARD, JSON.stringify({ before: prodBefore, after: afterCounts }, null, 2), "utf8");
    for (const key of Object.keys(prodBefore) as (keyof typeof prodBefore)[]) {
      assert.equal(afterCounts[key], prodBefore[key], `prod ${key} must not change`);
    }
    const qa = await dbMod.db.execute(
      (await import("drizzle-orm")).sql`SELECT count(*)::int AS c FROM v3_employees WHERE full_name ILIKE '%test%' OR full_name ILIKE '%qa%' OR full_name ILIKE '%أحمد اختبار%'`,
    );
    const qaCount = Array.isArray(qa) ? Number((qa as { c: number }[])[0]?.c ?? 0) : Number((qa as { rows: { c: number }[] }).rows[0]?.c ?? 0);
    assert.equal(qaCount, 0, "no QA/test employees in production");
    await dbMod.closeDatabase();
  });

  it("A) create monthly employee Ahmed 5,000,000", async () => {
    const emp = await createEmployee({
      fullName: "Ahmed",
      jobTitle: "طباخ",
      salaryAmount: 5_000_000,
      salaryType: "MONTHLY",
      workStartDate: "2026-09-01",
    });
    assert.equal(emp.fullName, "Ahmed");
    assert.equal(emp.salaryAmount, 5_000_000);
    assert.equal(emp.salaryType, "MONTHLY");
    assert.equal(emp.isActive, true);
  });

  it("B) attendance upsert and summary correction", async () => {
    const emp = await db.query.v3EmployeesTable.findFirst({
      where: eq(tables.v3EmployeesTable.fullName, "Ahmed"),
    });
    assert.ok(emp);

    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-01",
      status: "PRESENT",
      workedHours: 8,
      actor: "test",
    });
    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-02",
      status: "PRESENT",
      workedHours: 8,
      actor: "test",
    });
    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-03",
      status: "ABSENT",
      actor: "test",
    });

    let sum = await attendanceSummary(emp!.id, 2026, 9);
    assert.equal(sum.presentDays, 2);
    assert.equal(sum.absentDays, 1);

    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-03",
      status: "PRESENT",
      workedHours: 8,
      actor: "test",
    });
    sum = await attendanceSummary(emp!.id, 2026, 9);
    assert.equal(sum.presentDays, 3);
    assert.equal(sum.absentDays, 0);

    const rows = await db
      .select()
      .from(tables.v3AttendanceTable)
      .where(
        and(
          eq(tables.v3AttendanceTable.employeeId, emp!.id),
          eq(tables.v3AttendanceTable.attendanceDate, "2026-09-03"),
        ),
      );
    assert.equal(rows.length, 1);
  });

  it("C) monthly payroll net = base - manual deduction + bonus (no auto absence cut)", async () => {
    const emp = await db.query.v3EmployeesTable.findFirst({
      where: eq(tables.v3EmployeesTable.fullName, "Ahmed"),
    });
    // Record 2 absences informationally for another period feel — use days 4-5 ABSENT for display
    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-04",
      status: "ABSENT",
      actor: "test",
    });
    await upsertAttendance({
      employeeId: emp!.id,
      attendanceDate: "2026-09-05",
      status: "ABSENT",
      actor: "test",
    });

    const result = await createOrUpdatePayroll({
      employeeId: emp!.id,
      year: 2026,
      month: 9,
      baseSalary: 5_000_000,
      manualDeduction: 300_000,
      manualBonus: 100_000,
      actor: "test",
      clientRequestId: "p7-payroll-ahmed-sep",
    });
    assert.equal(result.payroll.netSalary, 4_800_000);
    assert.equal(result.payroll.absenceDays, 2);
    assert.equal(result.payroll.manualDeduction, 300_000);
    // Creating payroll must NOT reduce available
    await postCapital({
      entryType: "ADD",
      amount: 10_000_000,
      actor: "test",
      clientRequestId: "p7-cap-for-salary",
    });
    const beforePay = await getFinanceSummary();
    // payroll already created — available unchanged by payroll itself
    assert.ok(beforePay.available >= 10_000_000 - 1); // at least capital (other tests may add)
  });

  it("D+E) partial then full salary payment reduces available exactly", async () => {
    const payroll = await db.query.v3PayrollTable.findFirst({
      where: eq(tables.v3PayrollTable.clientRequestId, "p7-payroll-ahmed-sep"),
    });
    assert.ok(payroll);
    const before = await getFinanceSummary();

    const p1 = await addSalaryPayment({
      payrollId: payroll!.id,
      amount: 1_800_000,
      actor: "test",
      clientRequestId: "p7-sal-pay-1",
    });
    assert.equal(p1.remaining, 3_000_000);
    let mid = await getFinanceSummary();
    assert.equal(mid.available, before.available - 1_800_000);
    assert.equal(mid.totalSalaryPayments, before.totalSalaryPayments + 1_800_000);
    // Must not also inflate expenses
    assert.equal(mid.totalExpenses, before.totalExpenses);

    const p2 = await addSalaryPayment({
      payrollId: payroll!.id,
      amount: 3_000_000,
      actor: "test",
      clientRequestId: "p7-sal-pay-2",
    });
    assert.equal(p2.remaining, 0);
    assert.equal(p2.payroll.paymentStatus, "PAID");
    const after = await getFinanceSummary();
    assert.equal(after.available, before.available - 4_800_000);
    assert.equal(after.totalExpenses, before.totalExpenses);
  });

  it("F) daily employee suggested amount only — no auto payroll", async () => {
    const emp = await createEmployee({
      fullName: "Daily Worker",
      salaryAmount: 150_000,
      salaryType: "DAILY",
      workStartDate: "2026-09-01",
      jobTitle: "مساعد",
    });
    for (let d = 1; d <= 10; d++) {
      await upsertAttendance({
        employeeId: emp.id,
        attendanceDate: `2026-09-${String(d).padStart(2, "0")}`,
        status: "PRESENT",
        actor: "test",
      });
    }
    const sum = await attendanceSummary(emp.id, 2026, 9);
    assert.equal(sum.presentDays, 10);
    const suggested = emp.salaryAmount * sum.presentDays;
    assert.equal(suggested, 1_500_000);

    const beforePayroll = await db.select().from(tables.v3PayrollTable);
    const beforePays = await db.select().from(tables.v3SalaryPaymentsTable);
    // No automatic payroll/payment created by attendance alone
    const auto = beforePayroll.filter((p) => p.employeeId === emp.id);
    assert.equal(auto.length, 0);
    void beforePays;
  });

  it("G) reject net salary below already-paid amount", async () => {
    const emp = await createEmployee({
      fullName: "Safety Emp",
      salaryAmount: 3_000_000,
      salaryType: "MONTHLY",
      workStartDate: "2026-08-01",
    });
    const pr = await createOrUpdatePayroll({
      employeeId: emp.id,
      year: 2026,
      month: 8,
      baseSalary: 3_000_000,
      actor: "test",
      clientRequestId: "p7-safety-payroll",
    });
    await addSalaryPayment({
      payrollId: pr.payroll.id,
      amount: 2_000_000,
      actor: "test",
      clientRequestId: "p7-safety-pay",
    });

    let rejected = false;
    try {
      await createOrUpdatePayroll({
        employeeId: emp.id,
        year: 2026,
        month: 8,
        baseSalary: 1_500_000,
        confirmedNetSalary: 1_500_000,
        actor: "test",
      });
    } catch (e) {
      rejected = true;
      assert.ok(e instanceof AppError);
      assert.match((e as Error).message, /أقل من المدفوع|VALIDATION/);
    }
    assert.equal(rejected, true);
  });

  it("salary create unpaid does not reduce available (example 10M → payroll 3M)", async () => {
    await postCapital({
      entryType: "ADD",
      amount: 10_000_000,
      actor: "test",
      clientRequestId: "p7-ex-cap",
    });
    const before = await getFinanceSummary();
    const emp = await createEmployee({
      fullName: "Example Emp",
      salaryAmount: 3_000_000,
      salaryType: "MONTHLY",
      workStartDate: "2026-07-01",
    });
    await createOrUpdatePayroll({
      employeeId: emp.id,
      year: 2026,
      month: 7,
      baseSalary: 3_000_000,
      actor: "test",
      clientRequestId: "p7-ex-payroll",
    });
    const mid = await getFinanceSummary();
    assert.equal(mid.available, before.available);

    const pr = await db.query.v3PayrollTable.findFirst({
      where: eq(tables.v3PayrollTable.clientRequestId, "p7-ex-payroll"),
    });
    await addSalaryPayment({
      payrollId: pr!.id,
      amount: 1_000_000,
      actor: "test",
      clientRequestId: "p7-ex-pay1",
    });
    let s = await getFinanceSummary();
    assert.equal(s.available, before.available - 1_000_000);
    await addSalaryPayment({
      payrollId: pr!.id,
      amount: 2_000_000,
      actor: "test",
      clientRequestId: "p7-ex-pay2",
    });
    s = await getFinanceSummary();
    assert.equal(s.available, before.available - 3_000_000);
  });
});
