import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageHint, SecondaryButton } from "@/components/FormKit";
import { Metric, PageTitle } from "@/components/layout";
import { getV3FinanceSummary, listV3Kitchen, listV3Warehouse } from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";
import { Boxes, AlertTriangle, Coffee, Wallet } from "lucide-react";

export function V3SummaryPage({ lang }: { lang: Lang }) {
  const wh = useQuery({ queryKey: ["v3-warehouse", "summary-home"], queryFn: () => listV3Warehouse({ page: 1, pageSize: 500 }) });
  const kit = useQuery({ queryKey: ["v3-kitchen"], queryFn: listV3Kitchen });
  const fin = useQuery({ queryKey: ["v3-finance", "summary"], queryFn: getV3FinanceSummary });
  const rows = wh.data?.rows ?? [];
  const low = rows.filter((r) => r.status === "low" || r.status === "out").length;
  const review = rows.filter((r) => r.status === "unknown").length;

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

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={lang === "id" ? "Bahan gudang" : "مواد المستودع"} value={String(wh.data?.total ?? rows.length)} icon={Boxes} />
        <Metric label={lang === "id" ? "Rendah / Habis" : "منخفض / نفد"} value={String(low)} icon={AlertTriangle} />
        <Metric label={lang === "id" ? "Perlu review" : "بحاجة مراجعة"} value={String(review)} icon={AlertTriangle} />
        <Metric label={lang === "id" ? "Di dapur" : "في المطبخ"} value={String(kit.data?.rows.length ?? 0)} icon={Coffee} tone="primary" />
      </div>

      <div className="mb-5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-bold text-[hsl(var(--muted-foreground))]">
          <Wallet size={14} /> {lang === "id" ? "Saldo tersedia" : "الرصيد المتاح"}
        </div>
        <div className="mt-1 text-2xl font-bold tabular-nums">{formatIDR(fin.data?.available ?? 0)}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/warehouse"><SecondaryButton>{lang === "id" ? "Gudang" : "المستودع"}</SecondaryButton></Link>
        <Link href="/purchases"><SecondaryButton>{lang === "id" ? "Pembelian" : "المشتريات"}</SecondaryButton></Link>
        <Link href="/finance"><SecondaryButton>{lang === "id" ? "Keuangan" : "المالية"}</SecondaryButton></Link>
        <Link href="/employees"><SecondaryButton>{lang === "id" ? "Karyawan" : "الموظفون"}</SecondaryButton></Link>
        <Link href="/attendance"><SecondaryButton>{lang === "id" ? "Absensi" : "الحضور"}</SecondaryButton></Link>
      </div>
    </div>
  );
}
