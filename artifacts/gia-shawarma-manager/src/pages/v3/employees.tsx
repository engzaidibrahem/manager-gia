import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
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
  endV3Employee,
  listV3Employees,
  newClientRequestId,
  patchV3Employee,
  postV3Employee,
  salaryTypeLabel,
  todayISO,
  type V3Employee,
} from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";

export function V3EmployeesPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "ended">("all");
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<V3Employee | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const query = useQuery({
    queryKey: ["v3-employees", q, status],
    queryFn: () => listV3Employees({ q, status, pageSize: 100 }),
  });

  const rows = query.data?.rows ?? [];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Karyawan & Gaji" : "الموظفون والرواتب"}
        description={lang === "id"
          ? "Data karyawan, absensi, dan gaji — sederhana."
          : "بيانات الموظفين والحضور والرواتب — بسيط."}
      />
      <PageHint>
        {lang === "id"
          ? "Tidak ada penghapusan keras. Akhiri kerja = nonaktif + tanggal selesai."
          : "لا حذف نهائي. إنهاء العمل = تعطيل + تاريخ انتهاء."}
      </PageHint>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <PrimaryButton onClick={() => { setEdit(null); setOpen(true); }}>
          + {lang === "id" ? "Tambah karyawan" : "إضافة موظف"}
        </PrimaryButton>
        <FormField label={lang === "id" ? "Cari nama" : "بحث باسم الموظف"} className="min-w-[200px] flex-1">
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="..." />
        </FormField>
        <FormField label={lang === "id" ? "Status" : "الحالة"}>
          <SelectInput value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">{lang === "id" ? "Semua" : "الكل"}</option>
            <option value="active">{lang === "id" ? "Aktif" : "يعمل"}</option>
            <option value="ended">{lang === "id" ? "Selesai" : "انتهى عمله"}</option>
          </SelectInput>
        </FormField>
        <Link href="/attendance" className="rounded-xl border border-[hsl(var(--border))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))]">
          {lang === "id" ? "Absensi" : "الحضور"}
        </Link>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <div className="overflow-x-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <table className="min-w-full text-sm">
          <thead className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] text-[11px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <tr>
              {[
                lang === "id" ? "Nama" : "الاسم",
                lang === "id" ? "Telepon" : "رقم الهاتف",
                lang === "id" ? "Jabatan" : "الوظيفة",
                lang === "id" ? "Jenis gaji" : "نوع الراتب",
                lang === "id" ? "Gaji" : "الراتب",
                lang === "id" ? "Mulai" : "تاريخ البدء",
                lang === "id" ? "Selesai" : "تاريخ الانتهاء",
                lang === "id" ? "Jam" : "ساعات العمل",
                lang === "id" ? "Status" : "الحالة",
                lang === "id" ? "Aksi" : "إجراءات",
              ].map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 text-start">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.6)]">
                <td className="px-3 py-2 font-semibold">{r.fullName}</td>
                <td className="px-3 py-2">{r.phone || "—"}</td>
                <td className="px-3 py-2">{r.jobTitle || "—"}</td>
                <td className="px-3 py-2">{salaryTypeLabel(r.salaryType, lang)}</td>
                <td className="px-3 py-2 font-mono text-xs">{formatIDR(r.salaryAmount)}</td>
                <td className="px-3 py-2">{r.workStartDate}</td>
                <td className="px-3 py-2">{r.workEndDate || "—"}</td>
                <td className="px-3 py-2">{r.expectedDailyHours ?? "—"}</td>
                <td className="px-3 py-2">{r.isActive ? (lang === "id" ? "Aktif" : "يعمل") : (lang === "id" ? "Selesai" : "انتهى عمله")}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Link href={`/employees/${r.id}`} className="rounded border border-[hsl(var(--border))] px-2 py-1 text-[11px] font-bold hover:bg-[hsl(var(--muted))]">
                      {lang === "id" ? "Lihat" : "عرض"}
                    </Link>
                    <button type="button" className="rounded border border-[hsl(var(--border))] px-2 py-1 text-[11px] font-bold hover:bg-[hsl(var(--muted))]" onClick={() => { setEdit(r); setOpen(true); }}>
                      {lang === "id" ? "Ubah" : "تعديل"}
                    </button>
                    {r.isActive ? (
                      <button
                        type="button"
                        className="rounded border border-red-200 px-2 py-1 text-[11px] font-bold text-red-700 hover:bg-red-50"
                        onClick={async () => {
                          if (!confirm(lang === "id" ? "Akhiri kerja karyawan?" : "إنهاء عمل هذا الموظف؟")) return;
                          try {
                            await endV3Employee(r.id);
                            setFlash(lang === "id" ? "Selesai" : "تم إنهاء العمل");
                            await qc.invalidateQueries({ queryKey: ["v3-employees"] });
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        {lang === "id" ? "Akhiri" : "إنهاء العمل"}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada karyawan" : "لا يوجد موظفون بعد"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {open ? (
        <EmployeeForm
          lang={lang}
          initial={edit}
          onClose={() => setOpen(false)}
          onSaved={async () => {
            setOpen(false);
            setFlash(lang === "id" ? "Tersimpan" : "تم الحفظ");
            await qc.invalidateQueries({ queryKey: ["v3-employees"] });
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function EmployeeForm({
  lang,
  initial,
  onClose,
  onSaved,
  onError,
}: {
  lang: Lang;
  initial: V3Employee | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    fullName: initial?.fullName ?? "",
    phone: initial?.phone ?? "",
    secondaryPhone: initial?.secondaryPhone ?? "",
    jobTitle: initial?.jobTitle ?? "",
    salaryAmount: initial ? String(initial.salaryAmount) : "",
    salaryType: (initial?.salaryType ?? "MONTHLY") as "MONTHLY" | "DAILY",
    workStartDate: initial?.workStartDate ?? todayISO(),
    expectedDailyHours: initial?.expectedDailyHours != null ? String(initial.expectedDailyHours) : "",
    notes: initial?.notes ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        fullName: form.fullName,
        phone: form.phone || null,
        secondaryPhone: form.secondaryPhone || null,
        jobTitle: form.jobTitle,
        salaryAmount: Number(form.salaryAmount || 0),
        salaryType: form.salaryType,
        workStartDate: form.workStartDate,
        expectedDailyHours: form.expectedDailyHours === "" ? null : Number(form.expectedDailyHours),
        notes: form.notes || null,
        clientRequestId: newClientRequestId(),
      };
      if (initial) return patchV3Employee(initial.id, body);
      return postV3Employee(body);
    },
    onSuccess: () => void onSaved(),
    onError: (e) => onError((e as Error).message),
  });

  return (
    <Modal title={initial ? (lang === "id" ? "Ubah karyawan" : "تعديل موظف") : (lang === "id" ? "Tambah karyawan" : "إضافة موظف")} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lang === "id" ? "Nama lengkap" : "الاسم الكامل"} required className="sm:col-span-2">
          <TextInput value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Telepon" : "رقم الهاتف"}>
          <TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Telepon 2" : "هاتف ثانٍ"}>
          <TextInput value={form.secondaryPhone} onChange={(e) => setForm({ ...form, secondaryPhone: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Jabatan" : "الوظيفة"}>
          <TextInput value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Jenis gaji" : "نوع الراتب"}>
          <SelectInput value={form.salaryType} onChange={(e) => setForm({ ...form, salaryType: e.target.value as "MONTHLY" | "DAILY" })}>
            <option value="MONTHLY">{lang === "id" ? "Bulanan" : "شهري"}</option>
            <option value="DAILY">{lang === "id" ? "Harian" : "يومي"}</option>
          </SelectInput>
        </FormField>
        <FormField label={lang === "id" ? "Gaji / tarif" : "الراتب / الأجر"} required>
          <NumberInput value={form.salaryAmount} onChange={(e) => setForm({ ...form, salaryAmount: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Mulai kerja" : "تاريخ البدء"}>
          <TextInput type="date" value={form.workStartDate} onChange={(e) => setForm({ ...form, workStartDate: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Jam kerja / hari" : "ساعات العمل المتوقعة"}>
          <NumberInput value={form.expectedDailyHours} onChange={(e) => setForm({ ...form, expectedDailyHours: e.target.value })} />
        </FormField>
        <FormField label={lang === "id" ? "Catatan" : "ملاحظات"} className="sm:col-span-2">
          <TextInput value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
        <PrimaryButton disabled={save.isPending} onClick={() => save.mutate()}>
          {lang === "id" ? "Simpan" : "حفظ"}
        </PrimaryButton>
      </div>
    </Modal>
  );
}
