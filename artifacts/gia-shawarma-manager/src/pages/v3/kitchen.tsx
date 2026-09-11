import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHint, TextInput } from "@/components/FormKit";
import { PageTitle } from "@/components/layout";
import { listV3Kitchen } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

function formatKitchenQty(n: number): string {
  // Western digits, trim useless trailing zeros
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10000) / 10000;
  return String(rounded);
}

/** Clean unit for Kitchen stock page — never use polluted baseUnit / raw qty text. */
function kitchenUnitLabel(displayUnit?: string | null): string {
  const preferred = String(displayUnit || "").trim();
  if (!preferred) return "—";
  // Reject any value that embeds a quantity (e.g. "3 كيلو", "2 kg")
  if (/\d/.test(preferred)) return "—";
  return preferred;
}

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
          ? "Saldo dapur saat ini (bukan daftar gerakan)."
          : "رصيد المطبخ الحالي لكل مادة — وليس عدد الحركات."}
      />
      <PageHint>
        {lang === "id"
          ? "Satu angka = stok dapur sekarang. Riwayat gerakan ada di detail bahan."
          : "رقم واحد = الرصيد الحالي في المطبخ. تفاصيل الحركات في صفحة المادة."}
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
              <th className="px-3 py-3 text-start">{lang === "id" ? "Saldo dapur" : "الرصيد في المطبخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Update terakhir" : "آخر تحديث"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <EmptyState message={lang === "id" ? "Belum ada stok dapur." : "لا رصيد مطبخ بعد."} />
                </td>
              </tr>
            ) : rows.map((r) => {
              const unit = kitchenUnitLabel(r.displayUnit);
              return (
                <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                  <td className="px-3 py-2.5 font-semibold">
                    {r.name}
                    {r.unitNeedsReview ? (
                      <div className="mt-0.5 text-[11px] font-normal text-amber-800">
                        {lang === "id"
                          ? "Satuan historis perlu review"
                          : "وحدة تاريخية تحتاج مراجعة"}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-lg font-bold text-[hsl(var(--primary))] tabular-nums">
                    {formatKitchenQty(r.kitchenQty)}
                    {unit && unit !== "—" ? (
                      <span className="ms-1 text-sm font-semibold text-[hsl(var(--foreground))]">{unit}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">{unit}</td>
                  <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                    {r.lastUpdated || r.lastTransferDate || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
