import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FormField, NumberInput, PageHint, PrimaryButton, SecondaryButton, SelectInput, TextInput } from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { listV3Warehouse, statusLabel, type V3WarehouseRow } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";

function formatQty(n: number | null, rawFallback?: string) {
  if (n == null) return rawFallback || "—";
  return String(n);
}

export function V3WarehousePage({ lang }: { lang: Lang }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ["v3-warehouse", q, category, status, page],
    queryFn: () => listV3Warehouse({ q, category, status, page, pageSize: 50 }),
  });

  const rows = query.data?.rows ?? [];
  const categories = query.data?.categories ?? [];
  const total = query.data?.total ?? 0;
  const pageSize = query.data?.pageSize ?? 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const statusText = useMemo(() => (s: V3WarehouseRow["status"]) => statusLabel(s, lang === "id" ? "id" : "ar"), [lang]);

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Gudang" : "المستودع"}
        description={lang === "id"
          ? "Semua bahan gudang, masuk/keluar, dan saldo saat ini."
          : "جميع مواد المستودع وحركات الدخول والخروج والرصيد الحالي."}
      />
      <PageHint>
        {lang === "id"
          ? "Saldo dihitung dari: Opening + Masuk − Keluar dapur. Angka tidak diedit manual."
          : "الرصيد = رصيد الافتتاح + الداخل − الخارج للمطبخ. لا يُعدَّل الرصيد يدوياً."}
      </PageHint>

      <div className="mb-4 flex flex-wrap gap-2">
        <TextInput
          className="max-w-xs"
          placeholder={lang === "id" ? "Cari nama bahan..." : "البحث باسم المادة..."}
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
        />
        <SelectInput className="max-w-[180px]" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
          <option value="">{lang === "id" ? "Semua kategori" : "كل التصنيفات"}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </SelectInput>
        <SelectInput className="max-w-[160px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">{lang === "id" ? "Semua status" : "كل الحالات"}</option>
          <option value="available">{lang === "id" ? "Tersedia" : "متوفر"}</option>
          <option value="low">{lang === "id" ? "Rendah" : "منخفض"}</option>
          <option value="out">{lang === "id" ? "Habis" : "نفد"}</option>
          <option value="unknown">{lang === "id" ? "Belum angka" : "غير رقمي"}</option>
        </SelectInput>
      </div>

      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[960px] border-collapse text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Kategori" : "التصنيف"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Opening" : "رصيد الافتتاح"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Total masuk" : "إجمالي الداخل"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Keluar dapur" : "إجمالي الخارج للمطبخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Saldo sekarang" : "الرصيد الحالي"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Minimum" : "الحد الأدنى"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Status" : "الحالة"}</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada data." : "لا بيانات بعد."}</td></tr>
            ) : rows.map((r) => {
              const rowClass = r.status === "out"
                ? "bg-red-50/80"
                : r.status === "low"
                  ? "bg-amber-50/70"
                  : "";
              return (
                <tr key={r.id} className={`border-b border-[hsl(var(--border)/.5)] ${rowClass}`}>
                  <td className="px-3 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">{r.category || "—"}</td>
                  <td className="px-3 py-2.5 font-semibold">{r.name}</td>
                  <td className="px-3 py-2.5">{r.baseUnit || r.openingUnitRaw || "—"}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {r.openingNumeric != null ? r.openingNumeric : r.openingRaw}
                  </td>
                  <td className="px-3 py-2.5 font-mono">{r.totalIn}</td>
                  <td className="px-3 py-2.5 font-mono">{r.totalOut}</td>
                  <td className="px-3 py-2.5 font-mono font-bold">
                    {formatQty(r.currentWarehouse, statusText(r.status))}
                  </td>
                  <td className="px-3 py-2.5 font-mono">{r.minimumStock ?? "—"}</td>
                  <td className="px-3 py-2.5 text-xs font-bold">{statusText(r.status)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className="text-[hsl(var(--muted-foreground))]">{total} {lang === "id" ? "baris" : "صف"}</span>
        <div className="flex gap-2">
          <SecondaryButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{lang === "id" ? "Sebelumnya" : "السابق"}</SecondaryButton>
          <span className="px-2 py-2 font-mono">{page}/{pages}</span>
          <SecondaryButton disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{lang === "id" ? "Berikutnya" : "التالي"}</SecondaryButton>
        </div>
      </div>
      <Flash message="" />
    </div>
  );
}
