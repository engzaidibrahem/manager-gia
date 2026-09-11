import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import {
  FormField,
  Modal,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  attendanceStatusLabel,
  getV3AttendanceSummary,
  getV3Employee,
  listV3Attendance,
  listV3Payroll,
  newClientRequestId,
  paymentStatusLabel,
  postV3Attendance,
  postV3Payroll,
  postV3SalaryPayment,
  salaryTypeLabel,
  todayISO,
} from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";

export function V3EmployeeDetailPage({ lang }: { lang: Lang }) {
  const [, params] = useRoute("/employees/:id");
  const id = Number(params?.id);
  const qc = useQueryClient();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [attOpen, setAttOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [salaryPayFor, setSalaryPayFor] = useState<number | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const empQ = useQuery({
    queryKey: ["v3-employee", id],
    queryFn: () => getV3Employee(id),
    enabled: Number.isFinite(id) && id > 0,
  });
  const summaryQ = useQuery({
    queryKey: ["v3-att-sum", id, year, month],
    queryFn: () => getV3AttendanceSummary(id, year, month),
    enabled: Number.isFinite(id) && id > 0,
  });
  const attQ = useQuery({
    queryKey: ["v3-att-emp", id, year, month],
    queryFn: () => {
      const mm = String(month).padStart(2, "0");
      const last = new Date(year, month, 0).getDate();
      return listV3Attendance({
        employeeId: id,
        from: `${year}-${mm}-01`,
        to: `${year}-${mm}-${String(last).padStart(2, "0")}`,
        pageSize: 100,
      });
    },
    enabled: Number.isFinite(id) && id > 0,
  });
  const payrollQ = useQuery({
    queryKey: ["v3-payroll-emp", id],
    queryFn: () => listV3Payroll({ employeeId: id, pageSize: 50 }),
    enabled: Number.isFinite(id) && id > 0,
  });

  const emp = empQ.data?.employee;
  const sum = summaryQ.data;

  const suggestedDaily = useMemo(() => {
    if (!emp || emp.salaryType !== "DAILY" || !sum) return null;
    return emp.salaryAmount * sum.presentDays;
  }, [emp, sum]);

  if (!emp && empQ.isLoading) {
    return <div className="p-6 text-sm text-[hsl(var(--muted-foreground))]">...</div>;
  }
  if (!emp) {
    return <div className="p-6 text-sm text-red-700">{lang === "id" ? "Tidak ditemukan" : "غير موجود"}</div>;
  }

  return (
    <div className="fade-up">
      <div className="mb-3">
        <Link href="/employees" className="text-xs font-bold text-[hsl(var(--primary))]">
          ← {lang === "id" ? "Kembali" : "رجوع"}
        </Link>
      </div>
      <PageTitle
        eyebrow="GIA V3"
        title={emp.fullName}
        description={`${salaryTypeLabel(emp.salaryType, lang)} · ${formatIDR(emp.salaryAmount)} · ${emp.jobTitle || "—"}`}
      />
      <PageHint>
        {lang === "id"
          ? "Absensi informatif. Potongan gaji hanya manual."
          : "الحضور معلوماتي. خصم الراتب يدوي فقط."}
      </PageHint>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <section className="mb-6 overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4">
        <h2 className="mb-3 text-sm font-bold">{lang === "id" ? "Data karyawan" : "بيانات الموظف"}</h2>
        <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Info label={lang === "id" ? "Telepon" : "الهاتف"} value={emp.phone || "—"} />
          <Info label={lang === "id" ? "Telepon 2" : "هاتف ثانٍ"} value={emp.secondaryPhone || "—"} />
          <Info label={lang === "id" ? "Mulai" : "تاريخ البدء"} value={emp.workStartDate} />
          <Info label={lang === "id" ? "Selesai" : "تاريخ الانتهاء"} value={emp.workEndDate || "—"} />
          <Info label={lang === "id" ? "Jam / hari" : "ساعات العمل"} value={emp.expectedDailyHours ?? "—"} />
          <Info label={lang === "id" ? "Status" : "الحالة"} value={emp.isActive ? (lang === "id" ? "Aktif" : "يعمل") : (lang === "id" ? "Selesai" : "انتهى عمله")} />
          <Info label={lang === "id" ? "Catatan" : "ملاحظات"} value={emp.notes || "—"} />
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <h2 className="me-auto text-sm font-bold">{lang === "id" ? "Absensi" : "الحضور والغياب"}</h2>
          <FormField label={lang === "id" ? "Tahun" : "السنة"}>
            <NumberInput value={String(year)} onChange={(e) => setYear(Number(e.target.value) || year)} />
          </FormField>
          <FormField label={lang === "id" ? "Bulan" : "الشهر"}>
            <NumberInput value={String(month)} onChange={(e) => setMonth(Number(e.target.value) || month)} />
          </FormField>
          <PrimaryButton onClick={() => setAttOpen(true)}>+ {lang === "id" ? "Catat absensi" : "تسجيل حضور / غياب"}</PrimaryButton>
        </div>
        <div className="mb-3 grid gap-2 sm:grid-cols-4">
          <Mini label={lang === "id" ? "Hadir" : "أيام الحضور"} value={sum?.presentDays ?? 0} />
          <Mini label={lang === "id" ? "Absen" : "أيام الغياب"} value={sum?.absentDays ?? 0} />
          <Mini label={lang === "id" ? "Cuti" : "أيام الإجازة"} value={sum?.leaveDays ?? 0} />
          <Mini label={lang === "id" ? "Jam tercatat" : "إجمالي ساعات العمل المسجلة"} value={sum?.totalWorkedHours ?? 0} />
        </div>
        <SimpleAttTable lang={lang} rows={attQ.data?.rows ?? []} />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="me-auto text-sm font-bold">{lang === "id" ? "Gaji" : "الرواتب"}</h2>
          <PrimaryButton onClick={() => setPayOpen(true)}>+ {lang === "id" ? "Buat / ubah payroll" : "إنشاء / تعديل راتب الشهر"}</PrimaryButton>
        </div>
        {suggestedDaily != null ? (
          <p className="mb-2 text-xs text-[hsl(var(--muted-foreground))]">
            {lang === "id" ? "Usulan" : "مبلغ مقترح"}: {formatIDR(suggestedDaily)}
            {" "}({formatIDR(emp.salaryAmount)} × {sum?.presentDays ?? 0} {lang === "id" ? "hari hadir" : "أيام حضور"})
          </p>
        ) : null}
        <div className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <table className="min-w-full text-sm">
            <thead className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                {[lang === "id" ? "Periode" : "الفترة", lang === "id" ? "Dasar" : "الأساسي", lang === "id" ? "Absen" : "غياب", lang === "id" ? "Potongan" : "خصم يدوي", lang === "id" ? "Bonus" : "مكافأة", lang === "id" ? "Netto" : "الصافي", lang === "id" ? "Dibayar" : "المدفوع", lang === "id" ? "Status" : "الحالة", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 text-start">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(payrollQ.data?.rows ?? []).map((r) => (
                <tr key={r.id} className="border-b border-[hsl(var(--border)/.6)]">
                  <td className="px-3 py-2">{r.year}-{String(r.month).padStart(2, "0")}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatIDR(r.baseSalary)}</td>
                  <td className="px-3 py-2">{r.absenceDays}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatIDR(r.manualDeduction)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatIDR(r.manualBonus)}</td>
                  <td className="px-3 py-2 font-mono text-xs font-semibold">{formatIDR(r.netSalary)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatIDR(r.paidAmount)}</td>
                  <td className="px-3 py-2">{paymentStatusLabel(r.paymentStatus, lang)}</td>
                  <td className="px-3 py-2">
                    {r.remaining > 0 ? (
                      <button type="button" className="rounded border border-[hsl(var(--border))] px-2 py-1 text-[11px] font-bold" onClick={() => setSalaryPayFor(r.id)}>
                        + {lang === "id" ? "Bayar" : "تسجيل دفعة راتب"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!(payrollQ.data?.rows?.length) ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada payroll" : "لا يوجد رواتب بعد"}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {attOpen ? (
        <AttendanceModal
          lang={lang}
          employeeId={id}
          onClose={() => setAttOpen(false)}
          onSaved={async () => {
            setAttOpen(false);
            setFlash(lang === "id" ? "Absensi tersimpan" : "تم حفظ الحضور");
            await qc.invalidateQueries({ queryKey: ["v3-att"] });
            await qc.invalidateQueries({ queryKey: ["v3-att-sum"] });
            await qc.invalidateQueries({ queryKey: ["v3-att-emp"] });
          }}
          onError={setError}
        />
      ) : null}

      {payOpen ? (
        <PayrollModal
          lang={lang}
          employeeId={id}
          year={year}
          month={month}
          defaultBase={emp.salaryAmount}
          absenceDays={sum?.absentDays ?? 0}
          suggestedDaily={suggestedDaily}
          salaryType={emp.salaryType}
          onClose={() => setPayOpen(false)}
          onSaved={async () => {
            setPayOpen(false);
            setFlash(lang === "id" ? "Payroll tersimpan" : "تم حفظ الراتب");
            await qc.invalidateQueries({ queryKey: ["v3-payroll-emp"] });
            await qc.invalidateQueries({ queryKey: ["v3-finance"] });
          }}
          onError={setError}
        />
      ) : null}

      {salaryPayFor != null ? (
        <SalaryPayModal
          lang={lang}
          payrollId={salaryPayFor}
          onClose={() => setSalaryPayFor(null)}
          onSaved={async () => {
            setSalaryPayFor(null);
            setFlash(lang === "id" ? "Pembayaran tersimpan" : "تم تسجيل الدفعة");
            await qc.invalidateQueries({ queryKey: ["v3-payroll-emp"] });
            await qc.invalidateQueries({ queryKey: ["v3-finance"] });
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2">
      <div className="text-[10px] font-bold text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function SimpleAttTable({
  lang,
  rows,
}: {
  lang: Lang;
  rows: Array<{
    attendanceDate: string;
    status: string;
    checkInTime: string | null;
    checkOutTime: string | null;
    workedHours: number | null;
    notes: string | null;
  }>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <table className="min-w-full text-sm">
        <thead className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
          <tr>
            {[lang === "id" ? "Tanggal" : "التاريخ", lang === "id" ? "Status" : "الحالة", lang === "id" ? "Masuk" : "الدخول", lang === "id" ? "Keluar" : "الخروج", lang === "id" ? "Jam" : "ساعات العمل", lang === "id" ? "Catatan" : "ملاحظات"].map((h) => (
              <th key={h} className="px-3 py-2 text-start">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.attendanceDate}-${r.status}`} className="border-b border-[hsl(var(--border)/.6)]">
              <td className="px-3 py-2">{r.attendanceDate}</td>
              <td className="px-3 py-2">{attendanceStatusLabel(r.status, lang)}</td>
              <td className="px-3 py-2">{r.checkInTime || "—"}</td>
              <td className="px-3 py-2">{r.checkOutTime || "—"}</td>
              <td className="px-3 py-2">{r.workedHours ?? "—"}</td>
              <td className="px-3 py-2">{r.notes || "—"}</td>
            </tr>
          ))}
          {!rows.length ? (
            <tr><td colSpan={6} className="px-3 py-6 text-center text-[hsl(var(--muted-foreground))]">—</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function AttendanceModal({
  lang,
  employeeId,
  onClose,
  onSaved,
  onError,
}: {
  lang: Lang;
  employeeId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    attendanceDate: todayISO(),
    status: "PRESENT" as "PRESENT" | "ABSENT" | "LEAVE",
    checkInTime: "",
    checkOutTime: "",
    workedHours: "",
    notes: "",
  });
  const save = useMutation({
    mutationFn: () =>
      postV3Attendance({
        employeeId,
        attendanceDate: form.attendanceDate,
        status: form.status,
        checkInTime: form.checkInTime || null,
        checkOutTime: form.checkOutTime || null,
        workedHours: form.workedHours === "" ? null : Number(form.workedHours),
        notes: form.notes || null,
      }),
    onSuccess: () => void onSaved(),
    onError: (e) => onError((e as Error).message),
  });
  return (
    <Modal title={lang === "id" ? "Catat absensi" : "تسجيل حضور / غياب"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lang === "id" ? "Tanggal" : "التاريخ"} required>
          <TextInput type="date" value={form.attendanceDate} onChange={(e) => setForm({ ...form, attendanceDate: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Status" : "الحالة"} required>
          <SelectInput value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as typeof form.status })}>
            <option value="PRESENT">{lang === "id" ? "Hadir" : "حضور"}</option>
            <option value="ABSENT">{lang === "id" ? "Absen" : "غياب"}</option>
            <option value="LEAVE">{lang === "id" ? "Cuti" : "إجازة"}</option>
          </SelectInput>
        </FormField>
        <FormField label={lang === "id" ? "Masuk" : "وقت الدخول"}>
          <TextInput value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} placeholder="08:00" />
        </FormField>
        <FormField label={lang === "id" ? "Keluar" : "وقت الخروج"}>
          <TextInput value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} placeholder="16:00" />
        </FormField>
        <FormField label={lang === "id" ? "Jam kerja" : "عدد ساعات العمل"}>
          <NumberInput value={form.workedHours} onChange={(e) => setForm({ ...form, workedHours: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}>
          <TextInput value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
        <PrimaryButton disabled={save.isPending} onClick={() => save.mutate()}>{lang === "id" ? "Simpan" : "حفظ"}</PrimaryButton>
      </div>
    </Modal>
  );
}

function PayrollModal({
  lang,
  employeeId,
  year,
  month,
  defaultBase,
  absenceDays,
  suggestedDaily,
  salaryType,
  onClose,
  onSaved,
  onError,
}: {
  lang: Lang;
  employeeId: number;
  year: number;
  month: number;
  defaultBase: number;
  absenceDays: number;
  suggestedDaily: number | null;
  salaryType: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    baseSalary: String(defaultBase),
    manualDeduction: "0",
    manualBonus: "0",
    confirmedNet: suggestedDaily != null ? String(suggestedDaily) : "",
    notes: "",
  });
  const computed = Number(form.baseSalary || 0) - Number(form.manualDeduction || 0) + Number(form.manualBonus || 0);

  const save = useMutation({
    mutationFn: () =>
      postV3Payroll({
        employeeId,
        year,
        month,
        baseSalary: Number(form.baseSalary || 0),
        manualDeduction: Number(form.manualDeduction || 0),
        manualBonus: Number(form.manualBonus || 0),
        confirmedNetSalary:
          salaryType === "DAILY" && form.confirmedNet !== ""
            ? Number(form.confirmedNet)
            : undefined,
        notes: form.notes || null,
        clientRequestId: newClientRequestId(),
      }),
    onSuccess: () => void onSaved(),
    onError: (e) => onError((e as Error).message),
  });

  return (
    <Modal title={lang === "id" ? "Payroll bulanan" : "راتب الشهر"} onClose={onClose}>
      <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
        {year}-{String(month).padStart(2, "0")} · {lang === "id" ? "Absen" : "غياب"}: {absenceDays} {lang === "id" ? "(info saja)" : "(معلومات فقط)"}
      </p>
      {suggestedDaily != null ? (
        <p className="mb-3 rounded-lg bg-[hsl(var(--muted))] px-3 py-2 text-sm">
          {lang === "id" ? "Usulan" : "مبلغ مقترح"}: <strong>{formatIDR(suggestedDaily)}</strong>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lang === "id" ? "Gaji dasar" : "الراتب الأساسي"}>
          <NumberInput value={form.baseSalary} onChange={(e) => setForm({ ...form, baseSalary: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Potongan manual" : "خصم يدوي"}>
          <NumberInput value={form.manualDeduction} onChange={(e) => setForm({ ...form, manualDeduction: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Bonus manual" : "مكافأة يدوية"}>
          <NumberInput value={form.manualBonus} onChange={(e) => setForm({ ...form, manualBonus: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Netto dihitung" : "الصافي المحسوب"}>
          <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2 font-mono text-sm">{formatIDR(computed)}</div>
        </FormField>
        {salaryType === "DAILY" ? (
          <FormField label={lang === "id" ? "Konfirmasi jumlah" : "تأكيد المبلغ"} className="sm:col-span-2" required>
            <NumberInput value={form.confirmedNet} onChange={(e) => setForm({ ...form, confirmedNet: e.target.value })} />
          </FormField>
        ) : null}
        <FormField label={lang === "id" ? "Catatan" : "ملاحظات"} className="sm:col-span-2">
          <TextInput value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
        <PrimaryButton disabled={save.isPending} onClick={() => save.mutate()}>{lang === "id" ? "Simpan" : "حفظ"}</PrimaryButton>
      </div>
    </Modal>
  );
}

function SalaryPayModal({
  lang,
  payrollId,
  onClose,
  onSaved,
  onError,
}: {
  lang: Lang;
  payrollId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [paidBy, setPaidBy] = useState("");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () =>
      postV3SalaryPayment(payrollId, {
        amount: Number(amount),
        paymentDate,
        paidBy,
        notes: notes || null,
        clientRequestId: newClientRequestId(),
      }),
    onSuccess: () => void onSaved(),
    onError: (e) => onError((e as Error).message),
  });
  return (
    <Modal title={lang === "id" ? "Bayar gaji" : "تسجيل دفعة راتب"} onClose={onClose}>
      <div className="grid gap-3">
        <FormField label={lang === "id" ? "Jumlah" : "المبلغ"} required>
          <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
          <TextInput type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
        </FormField>
        <FormField label={lang === "id" ? "Dibayar oleh" : "من دفع"}>
          <TextInput value={paidBy} onChange={(e) => setPaidBy(e.target.value)} />
        </FormField>
        <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}>
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
        <PrimaryButton disabled={save.isPending} onClick={() => save.mutate()}>{lang === "id" ? "Simpan" : "حفظ"}</PrimaryButton>
      </div>
    </Modal>
  );
}
