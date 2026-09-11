import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField,
  PageHint,
  PrimaryButton,
  SelectInput,
  TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  listV3Attendance,
  listV3Employees,
  postV3Attendance,
  todayISO,
  type V3Employee,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

type RowDraft = {
  status: "" | "PRESENT" | "ABSENT" | "LEAVE";
  checkInTime: string;
  checkOutTime: string;
  workedHours: string;
  notes: string;
  dirty: boolean;
};

export function V3AttendancePage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({});

  const employees = useQuery({
    queryKey: ["v3-employees", "active-att"],
    queryFn: () => listV3Employees({ status: "active", pageSize: 200 }),
  });

  const existing = useQuery({
    queryKey: ["v3-attendance-day", date],
    queryFn: () => listV3Attendance({ from: date, to: date, pageSize: 200 }),
  });

  const byEmp = useMemo(() => {
    const m = new Map<number, (typeof existing.data extends { rows: infer R } ? R : never) extends Array<infer U> ? U : never>();
    for (const r of existing.data?.rows ?? []) m.set(r.employeeId, r as never);
    return m;
  }, [existing.data]);

  const rows = useMemo(() => {
    return (employees.data?.rows ?? []).map((emp: V3Employee) => {
      const cur = byEmp.get(emp.id) as
        | {
            status: string;
            checkInTime: string | null;
            checkOutTime: string | null;
            workedHours: number | null;
            notes: string | null;
          }
        | undefined;
      const d = drafts[emp.id];
      return {
        emp,
        status: (d?.status ?? cur?.status ?? "") as RowDraft["status"],
        checkInTime: d?.checkInTime ?? cur?.checkInTime ?? "",
        checkOutTime: d?.checkOutTime ?? cur?.checkOutTime ?? "",
        workedHours: d?.workedHours ?? (cur?.workedHours != null ? String(cur.workedHours) : ""),
        notes: d?.notes ?? cur?.notes ?? "",
        dirty: Boolean(d?.dirty),
        hasRecord: Boolean(cur),
      };
    });
  }, [employees.data, byEmp, drafts]);

  function setDraft(id: number, patch: Partial<RowDraft>) {
    setDrafts((prev) => {
      const cur = prev[id] ?? {
        status: "",
        checkInTime: "",
        checkOutTime: "",
        workedHours: "",
        notes: "",
        dirty: false,
      };
      return { ...prev, [id]: { ...cur, ...patch, dirty: true } };
    });
  }

  const saveAll = useMutation({
    mutationFn: async () => {
      const dirty = rows.filter((r) => r.dirty && r.status);
      if (!dirty.length) throw new Error(lang === "id" ? "Tidak ada perubahan" : "لا تغييرات للحفظ");
      for (const r of dirty) {
        await postV3Attendance({
          employeeId: r.emp.id,
          attendanceDate: date,
          status: r.status,
          checkInTime: r.checkInTime || null,
          checkOutTime: r.checkOutTime || null,
          workedHours: r.workedHours === "" ? null : Number(r.workedHours),
          notes: r.notes || null,
        });
      }
      return dirty.length;
    },
    onSuccess: async (n) => {
      setDrafts({});
      setFlash(lang === "id" ? `${n} tersimpan` : `تم حفظ ${n} سجل`);
      setError("");
      await qc.invalidateQueries({ queryKey: ["v3-attendance"] });
      await qc.invalidateQueries({ queryKey: ["v3-attendance-day"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Absensi" : "الحضور"}
        description={lang === "id"
          ? "Catat status staf untuk satu hari dengan cepat."
          : "سجّل حالة الموظفين ليوم واحد بسرعة."}
      />
      <PageHint>
        {lang === "id"
          ? "Satu karyawan = satu catatan per hari. Ubah status untuk koreksi."
          : "موظف واحد = سجل واحد لكل يوم. غيّر الحالة للتصحيح دون تكرار."}
      </PageHint>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
          <TextInput type="date" value={date} onChange={(e) => { setDate(e.target.value); setDrafts({}); }} />
        </FormField>
        <PrimaryButton disabled={saveAll.isPending} onClick={() => saveAll.mutate()}>
          {lang === "id" ? "Simpan perubahan hari ini" : "حفظ تغييرات اليوم"}
        </PrimaryButton>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Karyawan" : "الموظف"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Status" : "الحالة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Masuk" : "الدخول"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Keluar" : "الخروج"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Jam" : "ساعات العمل"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Catatan" : "ملاحظات"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState message={lang === "id" ? "Belum ada karyawan aktif." : "لا يوجد موظفون نشطون بعد."} />
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.emp.id} className={`border-b border-[hsl(var(--border)/.5)] ${r.dirty ? "bg-sky-50/50" : ""}`}>
                  <td className="px-3 py-2 font-semibold">
                    {r.emp.fullName}
                    {r.hasRecord ? (
                      <span className="ms-2 text-[10px] font-normal text-[hsl(var(--muted-foreground))]">
                        {lang === "id" ? "tersimpan" : "مسجّل"}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <SelectInput
                      value={r.status}
                      onChange={(e) => setDraft(r.emp.id, { status: e.target.value as RowDraft["status"] })}
                    >
                      <option value="">{lang === "id" ? "—" : "—"}</option>
                      <option value="PRESENT">{lang === "id" ? "Hadir" : "حضور"}</option>
                      <option value="ABSENT">{lang === "id" ? "Absen" : "غياب"}</option>
                      <option value="LEAVE">{lang === "id" ? "Cuti" : "إجازة"}</option>
                    </SelectInput>
                  </td>
                  <td className="px-3 py-2">
                    <TextInput value={r.checkInTime} placeholder="08:00" onChange={(e) => setDraft(r.emp.id, { checkInTime: e.target.value })} />
                  </td>
                  <td className="px-3 py-2">
                    <TextInput value={r.checkOutTime} placeholder="16:00" onChange={(e) => setDraft(r.emp.id, { checkOutTime: e.target.value })} />
                  </td>
                  <td className="px-3 py-2">
                    <TextInput value={r.workedHours} onChange={(e) => setDraft(r.emp.id, { workedHours: e.target.value })} />
                  </td>
                  <td className="px-3 py-2">
                    <TextInput value={r.notes} onChange={(e) => setDraft(r.emp.id, { notes: e.target.value })} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
