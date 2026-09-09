import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  listV3Attendance,
  listV3Employees,
  postV3Attendance,
  todayISO,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";

export function V3AttendancePage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const employees = useQuery({
    queryKey: ["v3-employees", "active-brief"],
    queryFn: () => listV3Employees({ status: "active", pageSize: 200 }),
  });

  const query = useQuery({
    queryKey: ["v3-attendance", date, employeeId, status],
    queryFn: () =>
      listV3Attendance({
        from: date || undefined,
        to: date || undefined,
        employeeId: employeeId ? Number(employeeId) : undefined,
        status: status || undefined,
        pageSize: 100,
      }),
  });

  const rows = query.data?.rows ?? [];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Absensi" : "الحضور"}
        description={lang === "id"
          ? "Catat kehadiran staf hari ini dengan cepat."
          : "سجّل حضور الموظفين بسرعة."}
      />
      <PageHint>
        {lang === "id"
          ? "Satu karyawan = satu catatan per hari. Ubah status untuk koreksi."
          : "موظف واحد = سجل واحد لكل يوم. غيّر الحالة للتصحيح."}
      </PageHint>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <PrimaryButton onClick={() => setOpen(true)}>+ {lang === "id" ? "Catat" : "تسجيل حضور / غياب"}</PrimaryButton>
        <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label={lang === "id" ? "Karyawan" : "الموظف"}>
          <SelectInput value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">{lang === "id" ? "Semua" : "الكل"}</option>
            {(employees.data?.rows ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.fullName}</option>
            ))}
          </SelectInput>
        </FormField>
        <FormField label={lang === "id" ? "Status" : "الحالة"}>
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{lang === "id" ? "Semua" : "الكل"}</option>
            <option value="PRESENT">{lang === "id" ? "Hadir" : "حضور"}</option>
            <option value="ABSENT">{lang === "id" ? "Absen" : "غياب"}</option>
            <option value="LEAVE">{lang === "id" ? "Cuti" : "إجازة"}</option>
          </SelectInput>
        </FormField>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <div className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <table className="min-w-full text-sm">
          <thead className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              {[lang === "id" ? "Tanggal" : "التاريخ", lang === "id" ? "Karyawan" : "الموظف", lang === "id" ? "Status" : "الحالة", lang === "id" ? "Masuk" : "الدخول", lang === "id" ? "Keluar" : "الخروج", lang === "id" ? "Jam" : "ساعات العمل", lang === "id" ? "Catatan" : "ملاحظات"].map((h) => (
                <th key={h} className="px-3 py-2 text-start">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.6)]">
                <td className="px-3 py-2">{r.attendanceDate}</td>
                <td className="px-3 py-2 font-semibold">{r.employeeName}</td>
                <td className="px-3 py-2">{attendanceStatusLabel(r.status, lang)}</td>
                <td className="px-3 py-2">{r.checkInTime || "—"}</td>
                <td className="px-3 py-2">{r.checkOutTime || "—"}</td>
                <td className="px-3 py-2">{r.workedHours ?? "—"}</td>
                <td className="px-3 py-2">{r.notes || "—"}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada data" : "لا توجد سجلات"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {open ? (
        <QuickAttendanceModal
          lang={lang}
          employees={employees.data?.rows ?? []}
          defaultDate={date || todayISO()}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            setFlash(lang === "id" ? "Tersimpan" : "تم الحفظ");
            await qc.invalidateQueries({ queryKey: ["v3-attendance"] });
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function QuickAttendanceModal({
  lang,
  employees,
  defaultDate,
  onClose,
  onSaved,
  onError,
}: {
  lang: Lang;
  employees: Array<{ id: number; fullName: string }>;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    employeeId: employees[0] ? String(employees[0].id) : "",
    attendanceDate: defaultDate,
    status: "PRESENT" as "PRESENT" | "ABSENT" | "LEAVE",
    checkInTime: "",
    checkOutTime: "",
    workedHours: "",
    notes: "",
  });

  const save = useMutation({
    mutationFn: () => {
      if (!form.employeeId) throw new Error(lang === "id" ? "Pilih karyawan" : "اختر الموظف");
      return postV3Attendance({
        employeeId: Number(form.employeeId),
        attendanceDate: form.attendanceDate,
        status: form.status,
        checkInTime: form.checkInTime || null,
        checkOutTime: form.checkOutTime || null,
        workedHours: form.workedHours === "" ? null : Number(form.workedHours),
        notes: form.notes || null,
      });
    },
    onSuccess: () => void onSaved(),
    onError: (e) => onError((e as Error).message),
  });

  return (
    <Modal title={lang === "id" ? "Catat absensi" : "تسجيل حضور / غياب"} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lang === "id" ? "Karyawan" : "الموظف"} required className="sm:col-span-2">
          <SelectInput value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">{lang === "id" ? "Pilih" : "اختر"}</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.fullName}</option>
            ))}
          </SelectInput>
        </FormField>
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
          <TextInput value={form.checkInTime} onChange={(e) => setForm({ ...form, checkInTime: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Keluar" : "وقت الخروج"}>
          <TextInput value={form.checkOutTime} onChange={(e) => setForm({ ...form, checkOutTime: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Jam" : "ساعات العمل"}>
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
