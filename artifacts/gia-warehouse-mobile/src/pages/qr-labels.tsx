import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { generateMissingQr, listProducts, qrImgUrl } from "@/lib/api";
import { FlashBanner, LoadingSpinner, Screen } from "@/components/ui";

export function QrLabelsPage() {
  const qc = useQueryClient();
  const [flash, setFlash] = useState("");
  const [generating, setGenerating] = useState(false);

  const products = useQuery({
    queryKey: ["qr-products"],
    queryFn: () => listProducts({ pageSize: 200, hasQr: "all" }),
  });

  async function genMissing() {
    setGenerating(true);
    setFlash("");
    try {
      const r = await generateMissingQr();
      setFlash(`تم إنشاء ${r.generated} رمز QR`);
      qc.invalidateQueries({ queryKey: ["qr-products"] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل التوليد");
    } finally {
      setGenerating(false);
    }
  }

  function printLabels() {
    window.print();
  }

  const rows = products.data?.rows ?? [];

  return (
    <Screen title="ملصقات QR" backTo="/products">
      <FlashBanner message={flash} onDismiss={() => setFlash("")} tone={flash.includes("تم") ? "ok" : "danger"} />

      <div className="mb-4 flex flex-col gap-2 print:hidden">
        <button type="button" className="btn-lg btn-secondary" disabled={generating} onClick={genMissing}>
          {generating ? "جاري التوليد..." : "توليد الرموز الناقصة"}
        </button>
        <button type="button" className="btn-lg btn-primary" disabled={!rows.length} onClick={printLabels}>
          طباعة الملصقات
        </button>
      </div>

      {products.isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-2 gap-3 print:grid-cols-2">
          {rows.map((p) => (
            <div
              key={p.id}
              className="card flex flex-col items-center break-inside-avoid p-3 text-center print:border print:border-black"
            >
              <div className="text-xs font-black tracking-wide text-[hsl(var(--primary))]">GIA</div>
              <div className="mt-1 line-clamp-2 text-sm font-extrabold">{p.name}</div>
              <div className="text-xs text-[hsl(var(--muted-foreground))]">{p.baseUnit}</div>
              {p.qrToken ? (
                <img
                  src={qrImgUrl(p.qrToken, 120)}
                  alt=""
                  className="my-2 h-[120px] w-[120px]"
                />
              ) : (
                <div className="my-2 flex h-[120px] w-[120px] items-center justify-center bg-[hsl(var(--muted))] text-xs">
                  بدون QR
                </div>
              )}
              {p.shortCode ? (
                <div className="text-xs font-bold">{p.shortCode}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print\\:grid, .print\\:grid * { visibility: visible; }
          header, .print\\:hidden { display: none !important; }
        }
      `}</style>
    </Screen>
  );
}
