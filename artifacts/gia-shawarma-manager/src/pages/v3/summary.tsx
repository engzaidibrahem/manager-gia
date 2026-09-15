import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageHint, SecondaryButton } from "@/components/FormKit";
import { Metric, PageTitle } from "@/components/layout";
import { getV3FinanceSummary, getV3StockAlerts, listV3Kitchen, listV3Warehouse } from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";
import { Boxes, AlertTriangle, Coffee, Wallet } from "lucide-react";

export function V3SummaryPage({ lang }: { lang: Lang }) {
  const wh = useQuery({ queryKey: ["v3-warehouse", "summary-home"], queryFn: () => listV3Warehouse({ page: 1, pageSize: 500 }) });
  const kit = useQuery({ queryKey: ["v3-kitchen"], queryFn: listV3Kitchen });
  const fin = useQuery({ queryKey: ["v3-finance", "summary"], queryFn: getV3FinanceSummary });
  const alerts = useQuery({ queryKey: ["v3-stock-alerts"], queryFn: getV3StockAlerts });
  const rows = wh.data?.rows ?? [];
  const s = alerts.data?.summary;
  const low = s?.lowStock ?? rows.filter((r) => r.status === "low" || r.status === "out").length;
  const review = s?.reviewRequired ?? rows.filter((r) => r.status === "unknown").length;
  const out = s?.outOfStock ?? rows.filter((r) => r.status === "out").length;

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Ringkasan" : "ملخص"}
        description={lang === "id" ? "Sistem restoran sederhana untuk operasional harian." : "نظام مطعم بسيط للتشغيل اليومي."}
      />
      <PageHint>
        {lang === "id"
          ? "Gudang, pembelian, keuangan, dan karyawan dalam satu tempat."
          : "المستودع والمشتريات والمالية والموظفون في مكان واحد."}
      </PageHint>

      {(s?.alertCount ?? 0) > 0 ? (
        <Link href="/stock-alerts" className="mb-4 flex items-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-bold text-orange-900">
          <AlertTriangle size={16} />
          {lang === "id"
            ? `${s!.alertCount} bahan perlu perhatian`
            : `⚠️ ${s!.alertCount} مادة وصلت للحد الأدنى / نفدت`}
        </Link>
      ) : null}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label={lang === "id" ? "Bahan gudang" : "مواد المستودع"} value={String(s?.total ?? wh.data?.total ?? rows.length)} icon={Boxes} />
        <Metric label={lang === "id" ? "Normal" : "طبيعي"} value={String(s?.normal ?? "—")} icon={Boxes} />
        <Metric label={lang === "id" ? "Rendah" : "منخفض"} value={String(low)} icon={AlertTriangle} />
        <Metric label={lang === "id" ? "Habis" : "نفد"} value={String(out)} icon={AlertTriangle} />
        <Metric label={lang === "id" ? "Perlu review" : "بحاجة مراجعة"} value={String(review)} icon={AlertTriangle} />
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Metric label={lang === "id" ? "Di dapur" : "في المطبخ"} value={String(kit.data?.rows.length ?? 0)} icon={Coffee} tone="primary" />
        <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))]">
            <Wallet size={14} /> {lang === "id" ? "Saldo tersedia" : "الرصيد المتاح"}
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{formatIDR(fin.data?.available ?? 0)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/warehouse"><SecondaryButton>{lang === "id" ? "Gudang" : "المستودع"}</SecondaryButton></Link>
        <Link href="/products"><SecondaryButton>{lang === "id" ? "Produk" : "المنتجات"}</SecondaryButton></Link>
        <Link href="/stocktake"><SecondaryButton>{lang === "id" ? "Stocktake" : "الجرد"}</SecondaryButton></Link>
        <Link href="/stock-alerts"><SecondaryButton>{lang === "id" ? "Peringatan" : "تنبيهات"}</SecondaryButton></Link>
        <Link href="/purchases"><SecondaryButton>{lang === "id" ? "Pembelian" : "المشتريات"}</SecondaryButton></Link>
        <Link href="/finance"><SecondaryButton>{lang === "id" ? "Keuangan" : "المالية"}</SecondaryButton></Link>
      </div>
    </div>
  );
}
