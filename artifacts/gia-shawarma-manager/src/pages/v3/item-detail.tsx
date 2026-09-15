import { Link, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PageHint } from "@/components/FormKit";
import { PageTitle } from "@/components/layout";
import { getV3WarehouseItem, statusLabel } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { StatusBadge } from "./v3-ui";

function movementLabel(t: string, lang: Lang) {
  if (t === "OPENING") return lang === "id" ? "Opening" : "رصيد افتتاح";
  if (t === "WAREHOUSE_IN") return lang === "id" ? "Masuk gudang" : "إدخال للمستودع";
  if (t === "WAREHOUSE_TO_KITCHEN") return lang === "id" ? "Keluar dapur" : "إخراج للمطبخ";
  if (t === "KITCHEN_DIRECT_IN") return lang === "id" ? "Masuk dapur langsung" : "دخول مطبخ مباشر";
  return t;
}

export function V3ItemDetailPage({ lang }: { lang: Lang }) {
  const [, params] = useRoute("/warehouse/:id");
  const id = Number(params?.id);
  const q = useQuery({
    queryKey: ["v3-item-detail", id],
    queryFn: () => getV3WarehouseItem(id),
    enabled: Number.isFinite(id) && id > 0,
  });

  const item = q.data?.item;
  const moves = q.data?.movements ?? [];

  if (q.isLoading) return <div className="p-6 text-sm text-[hsl(var(--muted-foreground))]">…</div>;
  if (!item) {
    return <div className="p-6 text-sm text-red-700">{lang === "id" ? "Tidak ditemukan" : "المادة غير موجودة"}</div>;
  }

  const review = Boolean(item.needsReview || item.needsQuantityReview || item.isNegative || item.status === "unknown");

  return (
    <div className="fade-up">
      <div className="mb-3">
        <Link href="/warehouse" className="text-xs font-bold text-[hsl(var(--primary))]">
          ← {lang === "id" ? "Kembali ke gudang" : "رجوع للمستودع"}
        </Link>
      </div>
      <PageTitle
        eyebrow="GIA V3"
        title={item.name}
        description={`${item.category || "—"} · ${item.baseUnit || item.openingUnitRaw || "—"}`}
      />
      <PageHint>
        {lang === "id"
          ? "Riwayat permanen. Saldo tidak diedit manual."
          : "سجل دائم للحركات. الرصيد لا يُعدَّل يدوياً."}
      </PageHint>

      <div className="mb-5 grid gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Info label={lang === "id" ? "Kategori" : "التصنيف"} value={item.category || "—"} />
        <Info label={lang === "id" ? "Satuan" : "الوحدة"} value={item.baseUnit || item.openingUnitRaw || "—"} />
        <Info label="QR" value={String((item as { qrToken?: string }).qrToken || "—")} />
        <Info
          label={lang === "id" ? "Opening" : "رصيد الافتتاح"}
          value={item.openingNumeric != null ? String(item.openingNumeric) : item.openingRaw}
        />
        <Info label={lang === "id" ? "Total masuk" : "إجمالي الإدخال"} value={String(item.totalIn)} />
        <Info label={lang === "id" ? "Keluar dapur" : "إجمالي الإخراج للمطبخ"} value={String(item.totalOut)} />
        <Info
          label={lang === "id" ? "Saldo sekarang" : "الرصيد الحالي"}
          value={
            review
              ? (lang === "id" ? "Perlu review" : "بحاجة مراجعة")
              : String(item.currentWarehouse ?? "—")
          }
        />
        <Info label={lang === "id" ? "Minimum" : "الحد الأدنى"} value={item.minimumStock == null ? "—" : String(item.minimumStock)} />
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            {lang === "id" ? "Status" : "الحالة"}
          </div>
          <div className="mt-1">
            <StatusBadge tone={review ? "review" : item.status === "out" ? "danger" : item.status === "low" ? "warn" : "ok"}>
              {statusLabel(item.status, lang === "id" ? "id" : "ar", review)}
            </StatusBadge>
          </div>
          {item.reviewReason ? (
            <div className="mt-1 text-xs text-amber-900">{item.reviewReason}</div>
          ) : null}
        </div>
      </div>

      <h2 className="mb-2 text-sm font-bold">{lang === "id" ? "Riwayat mutasi" : "سجل الحركات"}</h2>
      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[800px] border-collapse text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Jenis" : "نوع الحركة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Oleh" : "المسؤول"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Catatan" : "ملاحظات"}</th>
            </tr>
          </thead>
          <tbody>
            {moves.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">
                  {lang === "id" ? "Belum ada mutasi." : "لا حركات بعد."}
                </td>
              </tr>
            ) : (
              moves.map((m) => (
                <tr key={String(m.id)} className="border-b border-[hsl(var(--border)/.5)]">
                  <td className="px-3 py-2.5 font-mono text-xs">{String(m.movementDate)}</td>
                  <td className="px-3 py-2.5">{movementLabel(String(m.movementType), lang)}</td>
                  <td className="px-3 py-2.5 font-mono">
                    {m.quantityNumeric != null ? String(m.quantityNumeric) : String(m.quantityRaw)}
                  </td>
                  <td className="px-3 py-2.5">{String(m.unitRaw || "—")}</td>
                  <td className="px-3 py-2.5">{String(m.actor || "—")}</td>
                  <td className="px-3 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">{String(m.notes || "—")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
