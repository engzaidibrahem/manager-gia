import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHint, PrimaryButton, SecondaryButton, TextInput } from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  addV3StocktakeProduct,
  completeV3Stocktake,
  getV3Stocktake,
  listV3Stocktakes,
  saveV3StocktakeDraft,
  startV3Stocktake,
  upsertV3StocktakeLine,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState } from "./v3-ui";

export function V3StocktakePage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [flash, setFlash] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newQty, setNewQty] = useState("");

  const list = useQuery({ queryKey: ["v3-stocktakes"], queryFn: listV3Stocktakes });
  const detail = useQuery({
    queryKey: ["v3-stocktake", activeId],
    queryFn: () => getV3Stocktake(activeId!),
    enabled: activeId != null,
  });

  useEffect(() => {
    const open = (list.data?.rows ?? []).find((r) => r.status === "DRAFT" || r.status === "IN_PROGRESS");
    if (open && activeId == null) setActiveId(Number(open.id));
  }, [list.data, activeId]);

  const lines = useMemo(() => {
    const all = detail.data?.lines ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((l) => l.itemName.toLowerCase().includes(needle));
  }, [detail.data, q]);

  const startMut = useMutation({
    mutationFn: () => startV3Stocktake({ clientRequestId: `st-start-${Date.now()}` }),
    onSuccess: (r) => {
      setActiveId(r.stocktake.id);
      setFlash(lang === "id" ? "Stocktake dimulai" : "بدأ الجرد");
      qc.invalidateQueries({ queryKey: ["v3-stocktakes"] });
    },
    onError: (e: Error) => setFlash(e.message),
  });

  const completeMut = useMutation({
    mutationFn: () => completeV3Stocktake(activeId!),
    onSuccess: () => {
      setFlash(lang === "id" ? "Stocktake selesai — adjustment tercatat" : "تم اعتماد الجرد — سُجّلت التعديلات");
      qc.invalidateQueries({ queryKey: ["v3-stocktake", activeId] });
      qc.invalidateQueries({ queryKey: ["v3-warehouse"] });
      qc.invalidateQueries({ queryKey: ["v3-products"] });
    },
    onError: (e: Error) => setFlash(e.message),
  });

  const status = detail.data?.stocktake.status;
  const editable = status === "DRAFT" || status === "IN_PROGRESS";

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Stocktake" : "جرد المستودع"}
        description={lang === "id"
          ? "DRAFT tidak mengubah stok. Complete membuat ADJUSTMENT."
          : "المسودة لا تغيّر الرصيد. الاعتماد ينشئ حركات ADJUSTMENT."}
      />
      <Flash message={flash} />
      <PageHint>
        {lang === "id"
          ? "Sejarah lama tetap ada. Stocktake hanya koreksi saldo sekarang."
          : "التاريخ القديم يبقى. الجرد يصحّح الرصيد الحالي فقط عبر تعديلات موثّقة."}
      </PageHint>

      <div className="mb-4 flex flex-wrap gap-2">
        <PrimaryButton disabled={startMut.isPending} onClick={() => startMut.mutate()}>
          {lang === "id" ? "Mulai stocktake baru" : "بدء جرد جديد"}
        </PrimaryButton>
        {activeId && editable ? (
          <>
            <SecondaryButton
              onClick={async () => {
                await saveV3StocktakeDraft(activeId);
                setFlash(lang === "id" ? "Draft disimpan" : "تم حفظ المسودة");
                qc.invalidateQueries({ queryKey: ["v3-stocktake", activeId] });
              }}
            >
              {lang === "id" ? "Simpan draft" : "حفظ مسودة"}
            </SecondaryButton>
            <PrimaryButton disabled={completeMut.isPending} onClick={() => completeMut.mutate()}>
              {lang === "id" ? "Selesaikan stocktake" : "اعتماد الجرد"}
            </PrimaryButton>
          </>
        ) : null}
      </div>

      {!activeId ? (
        <EmptyState message={lang === "id" ? "Belum ada sesi aktif" : "لا توجد جلسة جرد نشطة"} />
      ) : (
        <>
          <div className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">
            #{activeId} · {status}
          </div>
          <TextInput className="mb-3 max-w-xs" placeholder={lang === "id" ? "Cari bahan..." : "بحث..."} value={q} onChange={(e) => setQ(e.target.value)} />

          {editable ? (
            <div className="mb-4 grid gap-2 rounded-xl border border-[hsl(var(--border))] p-3 md:grid-cols-4">
              <TextInput placeholder={lang === "id" ? "Produk baru" : "منتج جديد"} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <TextInput placeholder={lang === "id" ? "Satuan" : "الوحدة"} value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
              <TextInput placeholder={lang === "id" ? "Qty fisik" : "الكمية الفعلية"} value={newQty} onChange={(e) => setNewQty(e.target.value)} />
              <SecondaryButton
                disabled={!newName.trim() || newQty === ""}
                onClick={async () => {
                  try {
                    await addV3StocktakeProduct(activeId, {
                      name: newName,
                      baseUnit: newUnit,
                      countedQuantity: Number(newQty),
                    });
                    setNewName("");
                    setNewUnit("");
                    setNewQty("");
                    qc.invalidateQueries({ queryKey: ["v3-stocktake", activeId] });
                  } catch (e) {
                    setFlash(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                {lang === "id" ? "+ Produk baru" : "+ منتج جديد"}
              </SecondaryButton>
            </div>
          ) : null}

          <div className="panel soft-shadow overflow-auto">
            <table className="w-full min-w-[860px] text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
              <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold">
                <tr>
                  <th className="px-3 py-2 text-start">{lang === "id" ? "Produk" : "المادة"}</th>
                  <th className="px-3 py-2 text-start">{lang === "id" ? "Sistem" : "في النظام"}</th>
                  <th className="px-3 py-2 text-start">{lang === "id" ? "Fisik" : "الفعلي"}</th>
                  <th className="px-3 py-2 text-start">{lang === "id" ? "Selisih" : "الفرق"}</th>
                  <th className="px-3 py-2 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-[hsl(var(--border)/.4)]">
                    <td className="px-3 py-2 font-semibold">
                      <Link href={`/warehouse/${l.inventoryItemId}`} className="text-[hsl(var(--primary))]">{l.itemName}</Link>
                    </td>
                    <td className="px-3 py-2 font-mono">{l.systemQuantityBefore ?? "—"}</td>
                    <td className="px-3 py-2">
                      {editable ? (
                        <input
                          className="w-28 rounded border border-[hsl(var(--border))] px-2 py-1 font-mono"
                          defaultValue={l.countedQuantity ?? ""}
                          onBlur={async (e) => {
                            const v = e.target.value.trim();
                            try {
                              await upsertV3StocktakeLine(activeId, l.inventoryItemId, {
                                countedQuantity: v === "" ? null : Number(v),
                              });
                              qc.invalidateQueries({ queryKey: ["v3-stocktake", activeId] });
                            } catch (err) {
                              setFlash(err instanceof Error ? err.message : String(err));
                            }
                          }}
                        />
                      ) : (
                        <span className="font-mono">{l.countedQuantity ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono">{l.difference ?? "—"}</td>
                    <td className="px-3 py-2">{l.itemUnit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
