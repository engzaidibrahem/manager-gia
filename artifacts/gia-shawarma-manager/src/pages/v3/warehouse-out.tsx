import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, SecondaryButton, SelectInput, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { listV3Items, listV3Movements, newClientRequestId, postV3ToKitchen, todayISO } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";
import { EmptyState, StockBanner } from "./v3-ui";

export function V3WarehouseOutPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemId, setItemId] = useState("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(todayISO());
  const [receiver, setReceiver] = useState("");
  const [notes, setNotes] = useState("");

  const moves = useQuery({
    queryKey: ["v3-out-moves"],
    queryFn: () => listV3Movements({ type: "WAREHOUSE_TO_KITCHEN", pageSize: 100 }),
  });
  const items = useQuery({ queryKey: ["v3-items-brief"], queryFn: () => listV3Items(), enabled: open });

  const selected = useMemo(
    () => items.data?.rows.find((x) => String(x.id) === itemId),
    [items.data, itemId],
  );

  const stockUnknown = selected != null && selected.warehouseQtyNumeric == null;
  const qtyNum = parseStrictNumeric(qtyRaw);
  const overStock =
    selected?.warehouseQtyNumeric != null &&
    qtyNum != null &&
    qtyNum > selected.warehouseQtyNumeric + 1e-9;

  async function save() {
    setSaving(true);
    try {
      if (stockUnknown) {
        throw new Error(
          lang === "id"
            ? "Stok numerik tidak diketahui — tidak bisa keluar."
            : "الرصيد الرقمي غير معروف — لا يمكن الإخراج. راجع المادة أولاً.",
        );
      }
      if (qtyNum == null || !(qtyNum > 0)) {
        throw new Error(lang === "id" ? "Qty harus angka > 0" : "الكمية يجب أن تكون رقماً أكبر من صفر");
      }
      if (overStock) {
        throw new Error(lang === "id" ? "Qty melebihi saldo" : "الكمية المطلوبة أكبر من المتوفر في المستودع");
      }
      await postV3ToKitchen({
        inventoryItemId: Number(itemId),
        movementDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: qtyNum,
        unitRaw: unit,
        receiver: receiver || undefined,
        notes: notes || undefined,
        clientRequestId: newClientRequestId(),
      });
      setOpen(false);
      setItemId(""); setQtyRaw(""); setUnit(""); setReceiver(""); setNotes("");
      setFlash(lang === "id" ? "Tersimpan" : "تم الإخراج إلى المطبخ");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["v3-out-moves"] }),
        qc.invalidateQueries({ queryKey: ["v3-warehouse"] }),
        qc.invalidateQueries({ queryKey: ["v3-kitchen"] }),
      ]);
      window.setTimeout(() => setFlash(""), 2500);
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Keluar ke Dapur" : "إخراج للمطبخ"}
        description={lang === "id" ? "Kurangi gudang, tambah dapur. Item tidak dihapus saat 0." : "ينقص المستودع ويزيد المطبخ. الصنف لا يُحذف عند الصفر."}
        action={<PrimaryButton type="button" onClick={() => setOpen(true)}>{lang === "id" ? "+ Keluar dapur" : "+ إخراج للمطبخ"}</PrimaryButton>}
      />
      <PageHint>
        {lang === "id"
          ? "Jika qty numerik > saldo, sistem menolak."
          : "إذا كانت الكمية الرقمية أكبر من الرصيد، يُرفض الطلب."}
      </PageHint>

      <FormSection>
        <div className="overflow-auto">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="pb-2 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Penerima" : "المستلم"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Catatan" : "الملاحظات"}</th>
              </tr>
            </thead>
            <tbody>
              {(moves.data?.rows ?? []).map((r) => (
                <tr key={String(r.id)} className="border-b border-[hsl(var(--border)/.5)]">
                  <td className="py-2 font-mono text-xs">{String(r.movementDate)}</td>
                  <td className="py-2 font-semibold">{String(r.itemName)}</td>
                  <td className="py-2 font-mono">{String(r.quantityRaw)}</td>
                  <td className="py-2">{String(r.unitRaw || "—")}</td>
                  <td className="py-2">{String(r.receiver || "—")}</td>
                  <td className="py-2 text-xs text-[hsl(var(--muted-foreground))]">{String(r.notes || "—")}</td>
                </tr>
              ))}
              {!moves.data?.rows?.length && !moves.isLoading ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      message={lang === "id" ? "Belum ada keluar dapur." : "لا إخراجات للمطبخ بعد."}
                      actionLabel={lang === "id" ? "+ Keluar dapur" : "+ إخراج للمطبخ"}
                      onAction={() => setOpen(true)}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </FormSection>

      {open ? (
        <Modal title={lang === "id" ? "Keluar ke dapur" : "إخراج للمطبخ"} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <FormField label={lang === "id" ? "Bahan" : "المادة"} required>
              <SelectInput value={itemId} onChange={(e) => {
                setItemId(e.target.value);
                const it = items.data?.rows.find((x) => String(x.id) === e.target.value);
                if (it?.baseUnit) setUnit(it.baseUnit);
              }}>
                <option value="">{lang === "id" ? "Pilih..." : "اختر..."}</option>
                {(items.data?.rows ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}{i.warehouseQtyNumeric != null ? ` — ${i.warehouseQtyNumeric}` : " — ؟"}
                  </option>
                ))}
              </SelectInput>
            </FormField>
            {selected ? (
              <StockBanner
                lang={lang}
                label={lang === "id" ? "Tersedia di gudang" : "المتوفر في المستودع"}
                value={selected.warehouseQtyNumeric}
                unknown={stockUnknown}
              />
            ) : null}
            {overStock ? (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
                {lang === "id" ? "Qty melebihi saldo tersedia." : "الكمية أكبر من المتوفر في المستودع."}
              </div>
            ) : null}
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Qty diminta" : "الكمية"} required><TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Satuan" : "الوحدة"}><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Penerima" : "المستلم"}><TextInput value={receiver} onChange={(e) => setReceiver(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظة"}><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
            <div className="flex justify-end gap-2">
              <SecondaryButton onClick={() => setOpen(false)}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
              <PrimaryButton
                disabled={saving || !itemId || !qtyRaw.trim() || stockUnknown || overStock}
                onClick={() => void save()}
              >
                {saving ? "…" : (lang === "id" ? "Simpan" : "حفظ")}
              </PrimaryButton>
            </div>
          </div>
        </Modal>
      ) : null}
      <Flash message={flash} />
    </div>
  );
}
