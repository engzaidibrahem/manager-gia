import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, ReadOnlyValue, SecondaryButton, SelectInput, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { listV3Items, listV3Movements, newClientRequestId, postV3ToKitchen, todayISO } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";

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

  async function save() {
    setSaving(true);
    try {
      await postV3ToKitchen({
        inventoryItemId: Number(itemId),
        movementDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: parseStrictNumeric(qtyRaw),
        unitRaw: unit,
        receiver: receiver || undefined,
        notes: notes || undefined,
        clientRequestId: newClientRequestId(),
      });
      setOpen(false);
      setItemId(""); setQtyRaw(""); setUnit(""); setReceiver(""); setNotes("");
      setFlash(lang === "id" ? "Tersimpan" : "تم الحفظ");
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
        title={lang === "id" ? "Keluar ke Dapur" : "إخراج إلى المطبخ"}
        description={lang === "id" ? "Kurangi gudang, tambah dapur. Item tidak dihapus saat 0." : "ينقص المستودع ويزيد المطبخ. الصنف لا يُحذف عند الصفر."}
        action={<PrimaryButton onClick={() => setOpen(true)}>{lang === "id" ? "+ Keluar dapur" : "+ إخراج إلى المطبخ"}</PrimaryButton>}
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
            </tbody>
          </table>
        </div>
      </FormSection>

      {open ? (
        <Modal title={lang === "id" ? "Keluar ke dapur" : "إخراج إلى المطبخ"} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <FormField label={lang === "id" ? "Bahan" : "المادة"} required>
              <SelectInput value={itemId} onChange={(e) => {
                setItemId(e.target.value);
                const it = items.data?.rows.find((x) => String(x.id) === e.target.value);
                if (it?.baseUnit) setUnit(it.baseUnit);
              }}>
                <option value="">{lang === "id" ? "Pilih..." : "اختر..."}</option>
                {(items.data?.rows ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </SelectInput>
            </FormField>
            <FormField label={lang === "id" ? "Saldo gudang sekarang" : "الرصيد الحالي"}>
              <ReadOnlyValue>
                {selected?.warehouseQtyNumeric == null
                  ? (lang === "id" ? "Belum angka" : "بحاجة تحديد كمية رقمية")
                  : selected.warehouseQtyNumeric}
              </ReadOnlyValue>
            </FormField>
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Qty diminta" : "الكمية المطلوبة"} required><TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Satuan" : "الوحدة"}><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Penerima" : "المستلم"}><TextInput value={receiver} onChange={(e) => setReceiver(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظة"}><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
            <div className="flex justify-end gap-2">
              <SecondaryButton onClick={() => setOpen(false)}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
              <PrimaryButton disabled={saving || !itemId || !qtyRaw.trim()} onClick={() => void save()}>{saving ? "…" : (lang === "id" ? "Simpan" : "حفظ")}</PrimaryButton>
            </div>
          </div>
        </Modal>
      ) : null}
      <Flash message={flash} />
    </div>
  );
}
