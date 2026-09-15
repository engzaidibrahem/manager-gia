import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageHint } from "@/components/FormKit";
import { PageTitle } from "@/components/layout";
import { getV3StockAlerts } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

function Section({
  title,
  rows,
  lang,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
  lang: Lang;
}) {
  return (
    <div className="mb-6">
      <h2 className="mb-2 text-sm font-bold">{title} ({rows.length})</h2>
      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[640px] text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-2 text-start">{lang === "id" ? "Produk" : "المادة"}</th>
              <th className="px-3 py-2 text-start">{lang === "id" ? "Saldo" : "الرصيد"}</th>
              <th className="px-3 py-2 text-start">{lang === "id" ? "Minimum" : "الحد الأدنى"}</th>
              <th className="px-3 py-2 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-2 text-start">{lang === "id" ? "Update" : "آخر حركة"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5}><EmptyState message="—" /></td></tr>
            ) : rows.map((r) => (
              <tr key={String(r.id)} className="border-b border-[hsl(var(--border)/.4)]">
                <td className="px-3 py-2 font-semibold">
                  <Link href={`/warehouse/${r.id}`} className="text-[hsl(var(--primary))]">{String(r.name)}</Link>
                </td>
                <td className="px-3 py-2 font-mono">{r.warehouseQtyNumeric == null ? "—" : String(r.warehouseQtyNumeric)}</td>
                <td className="px-3 py-2 font-mono">{r.minimumStock == null ? "—" : String(r.minimumStock)}</td>
                <td className="px-3 py-2">{String(r.baseUnit || "—")}</td>
                <td className="px-3 py-2 font-mono text-xs">{String(r.lastMovementDate || "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function V3StockAlertsPage({ lang }: { lang: Lang }) {
  const q = useQuery({ queryKey: ["v3-stock-alerts"], queryFn: getV3StockAlerts });
  const s = q.data?.summary;

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Peringatan stok" : "تنبيهات المخزون"}
        description={lang === "id" ? "Habis / rendah / perlu review." : "نفد / منخفض / يحتاج مراجعة."}
      />
      <PageHint>
        <Link href="/warehouse?status=LOW_STOCK" className="font-bold text-[hsl(var(--primary))]">
          {lang === "id" ? "Buka filter LOW_STOCK di gudang" : "فتح فلتر المخزون المنخفض في المستودع"}
        </Link>
      </PageHint>

      {s ? (
        <div className="mb-5 grid gap-2 sm:grid-cols-5">
          <Card label={lang === "id" ? "Total" : "الإجمالي"} value={s.total} />
          <Card label={lang === "id" ? "Normal" : "طبيعي"} value={s.normal} />
          <Card label={lang === "id" ? "Rendah" : "منخفض"} value={s.lowStock} warn />
          <Card label={lang === "id" ? "Habis" : "نفد"} value={s.outOfStock} danger />
          <Card label={lang === "id" ? "Review" : "مراجعة"} value={s.reviewRequired} />
        </div>
      ) : null}

      <Section title={lang === "id" ? "Habis" : "نفد"} rows={q.data?.outOfStock ?? []} lang={lang} />
      <Section title={lang === "id" ? "Rendah" : "منخفض"} rows={q.data?.lowStock ?? []} lang={lang} />
      <Section title={lang === "id" ? "Perlu review" : "يحتاج مراجعة"} rows={q.data?.reviewRequired ?? []} lang={lang} />
    </div>
  );
}

function Card({ label, value, warn, danger }: { label: string; value: number; warn?: boolean; danger?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-3 ${danger ? "border-red-200 bg-red-50" : warn ? "border-orange-200 bg-orange-50" : "border-[hsl(var(--border))] bg-[hsl(var(--card))]"}`}>
      <div className="text-[10px] font-bold text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
