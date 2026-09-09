import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHint, TextInput } from "@/components/FormKit";
import { PageTitle } from "@/components/layout";
import { listV3Kitchen } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

export function V3KitchenPage({ lang }: { lang: Lang }) {
  const [q, setQ] = useState("");
  const query = useQuery({ queryKey: ["v3-kitchen"], queryFn: listV3Kitchen });
  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) => r.name.toLowerCase().includes(needle));
  }, [query.data, q]);

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Dapur" : "المطبخ"}
        description={lang === "id"
          ? "Stok dapur saja — bukan saldo gudang."
          : "رصيد المطبخ فقط — وليس رصيد المستودع."}
      />
      <PageHint>
        {lang === "id"
          ? "Angka di sini adalah qty dapur. Gudang punya halaman sendiri."
          : "الأرقام هنا كمية المطبخ الحالية. المستودع له صفحة منفصلة."}
      </PageHint>

      <div className="mb-3">
        <TextInput
          className="max-w-xs"
          placeholder={lang === "id" ? "Cari bahan..." : "بحث باسم المادة..."}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="panel soft-shadow overflow-auto border-[hsl(var(--primary)/.25)]">
        <table className="w-full min-w-[640px] text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--primary)/.08)] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Qty dapur" : "الكمية الحالية في المطبخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Masuk terakhir" : "آخر إدخال"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <EmptyState message={lang === "id" ? "Belum ada stok dapur." : "لا رصيد مطبخ بعد."} />
                </td>
              </tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                <td className="px-3 py-2.5 font-semibold">{r.name}</td>
                <td className="px-3 py-2.5 font-mono text-lg font-bold text-[hsl(var(--primary))]">{r.kitchenQty}</td>
                <td className="px-3 py-2.5">{r.baseUnit || "—"}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{r.lastTransferDate || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
