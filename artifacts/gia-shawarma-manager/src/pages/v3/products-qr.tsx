import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHint, PrimaryButton, SecondaryButton } from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { generateMissingV3Qr, listV3Products } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

/** Minimal QR via Google Chart API-free: use qrserver for print labels (public). */
function qrImgUrl(token: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(token)}`;
}

export function V3ProductsQrPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [flash, setFlash] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [filter, setFilter] = useState<"all" | "with" | "missing">("all");

  const query = useQuery({
    queryKey: ["v3-products-qr", filter],
    queryFn: () => listV3Products({ qr: filter, active: "active", page: 1, pageSize: 200, warehouseOnly: "1" }),
  });
  const rows = query.data?.rows ?? [];

  const gen = useMutation({
    mutationFn: () => generateMissingV3Qr(selected.length ? selected : undefined),
    onSuccess: (r) => {
      setFlash(lang === "id" ? `QR dibuat: ${r.generated}` : `تم توليد QR: ${r.generated}`);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ["v3-products-qr"] });
    },
    onError: (e: Error) => setFlash(e.message),
  });

  const printRows = useMemo(
    () => rows.filter((r) => selected.includes(r.id) || (selected.length === 0 && r.hasQr)),
    [rows, selected],
  );

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Label QR" : "ملصقات QR"}
        description={lang === "id" ? "QR = identitas produk, bukan stok." : "QR يمثل هوية المنتج وليس الكمية."}
      />
      <Flash message={flash} />
      <PageHint>{lang === "id" ? "Cetak ulang memakai token yang sama." : "إعادة الطباعة تستخدم نفس الرمز."}</PageHint>

      <div className="mb-3 flex flex-wrap gap-2">
        <SecondaryButton onClick={() => setFilter("all")}>{lang === "id" ? "Semua" : "الكل"}</SecondaryButton>
        <SecondaryButton onClick={() => setFilter("with")}>{lang === "id" ? "Punya QR" : "لديها QR"}</SecondaryButton>
        <SecondaryButton onClick={() => setFilter("missing")}>{lang === "id" ? "Tanpa QR" : "بدون QR"}</SecondaryButton>
        <PrimaryButton disabled={gen.isPending} onClick={() => gen.mutate()}>
          {lang === "id" ? "Generate missing" : "توليد QR الناقص"}
        </PrimaryButton>
        <SecondaryButton onClick={() => window.print()}>{lang === "id" ? "Cetak" : "طباعة"}</SecondaryButton>
      </div>

      <div className="panel soft-shadow mb-6 overflow-auto print:hidden">
        <table className="w-full text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold">
            <tr>
              <th className="px-3 py-2" />
              <th className="px-3 py-2 text-start">{lang === "id" ? "Produk" : "المنتج"}</th>
              <th className="px-3 py-2 text-start">QR</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={3}><EmptyState message="—" /></td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.4)]">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(r.id)}
                    onChange={(e) => {
                      setSelected((prev) =>
                        e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id),
                      );
                    }}
                  />
                </td>
                <td className="px-3 py-2 font-semibold">{r.name}</td>
                <td className="px-3 py-2 font-mono text-[10px]">{r.hasQr ? r.qrToken : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3">
        {printRows.filter((r) => r.hasQr).map((r) => (
          <div key={r.id} className="rounded-xl border border-[hsl(var(--border))] bg-white p-4 text-center break-inside-avoid">
            <div className="text-[10px] font-bold tracking-[.2em] text-[hsl(var(--primary))]">GIA</div>
            <div className="mt-1 text-sm font-bold">{r.name}</div>
            <div className="text-xs text-[hsl(var(--muted-foreground))]">{r.baseUnit || "—"}</div>
            {r.shortCode ? <div className="mt-1 font-mono text-[10px]">{r.shortCode}</div> : null}
            <img className="mx-auto mt-3 h-36 w-36" src={qrImgUrl(r.qrToken)} alt={r.name} />
          </div>
        ))}
      </div>
    </div>
  );
}
