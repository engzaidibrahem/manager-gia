import { useQuery } from "@tanstack/react-query";
import { PageHint } from "@/components/FormKit";
import { PageTitle } from "@/components/layout";
import { listV3Kitchen } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";

export function V3KitchenPage({ lang }: { lang: Lang }) {
  const query = useQuery({ queryKey: ["v3-kitchen"], queryFn: listV3Kitchen });
  const rows = query.data?.rows ?? [];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Dapur" : "المطبخ"}
        description={lang === "id" ? "Bahan yang sudah ditransfer dari gudang." : "المواد التي وصلت من المستودع."}
      />
      <PageHint>
        {lang === "id"
          ? "Tidak ada produksi kompleks di fase ini — hanya saldo transfer."
          : "لا نظام إنتاج معقد في هذه المرحلة — رصيد التحويلات فقط."}
      </PageHint>

      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[640px] text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Di dapur" : "الكمية في المطبخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Transfer terakhir" : "آخر تحويل"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada stok dapur." : "لا رصيد مطبخ بعد."}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                <td className="px-3 py-2.5 font-semibold">{r.name}</td>
                <td className="px-3 py-2.5 font-mono font-bold text-[hsl(var(--primary))]">{r.kitchenQty}</td>
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
