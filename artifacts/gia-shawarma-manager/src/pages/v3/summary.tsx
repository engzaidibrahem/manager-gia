import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageHint, SecondaryButton } from "@/components/FormKit";
import { Metric, PageTitle } from "@/components/layout";
import { listV3Kitchen, listV3Warehouse } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { Boxes, AlertTriangle, Coffee } from "lucide-react";

export function V3SummaryPage({ lang }: { lang: Lang }) {
  const wh = useQuery({ queryKey: ["v3-warehouse", "summary-home"], queryFn: () => listV3Warehouse({ page: 1, pageSize: 500 }) });
  const kit = useQuery({ queryKey: ["v3-kitchen"], queryFn: listV3Kitchen });
  const rows = wh.data?.rows ?? [];
  const low = rows.filter((r) => r.status === "low" || r.status === "out").length;

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Ringkasan" : "ملخص"}
        description={lang === "id" ? "Sistem restoran sederhana — mulai dari gudang." : "نظام مطعم بسيط — ابدأ من المستودع."}
      />
      <PageHint>
        {lang === "id"
          ? "V3 fokus gudang dulu. Pembelian/keuangan/karyawan menyusul setelah gudang lulus."
          : "V3 يركز على المستودع أولاً. المشتريات والمالية والموظفون بعد نجاح المستودع."}
      </PageHint>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label={lang === "id" ? "Bahan gudang" : "مواد المستودع"} value={String(rows.length)} icon={Boxes} />
        <Metric label={lang === "id" ? "Rendah / Habis" : "منخفض / نفد"} value={String(low)} icon={AlertTriangle} />
        <Metric label={lang === "id" ? "Di dapur" : "في المطبخ"} value={String(kit.data?.rows.length ?? 0)} icon={Coffee} tone="primary" />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/warehouse"><SecondaryButton>{lang === "id" ? "Gudang" : "المستودع"}</SecondaryButton></Link>
        <Link href="/opening"><SecondaryButton>{lang === "id" ? "Saldo awal" : "رصيد الافتتاح"}</SecondaryButton></Link>
        <Link href="/warehouse-in"><SecondaryButton>{lang === "id" ? "Masuk" : "إدخال"}</SecondaryButton></Link>
        <Link href="/warehouse-out"><SecondaryButton>{lang === "id" ? "Keluar dapur" : "إخراج مطبخ"}</SecondaryButton></Link>
        <Link href="/kitchen"><SecondaryButton>{lang === "id" ? "Dapur" : "المطبخ"}</SecondaryButton></Link>
      </div>
    </div>
  );
}
