import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, SecondaryButton, SelectInput, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { listV3Items, listV3Movements, newClientRequestId, postV3WarehouseIn, todayISO } from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";

export function V3WarehouseInPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemId, setItemId] = useState("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(todayISO());
  const [supplier, setSupplier] = useState("");
  const [receiver, setReceiver] = useState("");
  const [notes, setNotes] = useState("");

  const moves = useQuery({
    queryKey: ["v3-in-moves"],
    queryFn: () => listV3Movements({ type: "WAREHOUSE_IN", pageSize: 100 }),
  });
  const items = useQuery({ queryKey: ["v3-items-brief"], queryFn: () => listV3Items(), enabled: open });

  async function save() {
    setSaving(true);
    try {
      await postV3WarehouseIn({
        inventoryItemId: Number(itemId),
        movementDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: parseStrictNumeric(qtyRaw),
        unitRaw: unit,
        supplier: supplier || undefined,
        receiver: receiver || undefined,
        notes: notes || undefined,
        clientRequestId: newClientRequestId(),
      });
      setOpen(false);
      setItemId(""); setQtyRaw(""); setUnit(""); setSupplier(""); setReceiver(""); setNotes("");
      setFlash(lang === "id" ? "Tersimpan" : "تم الحفظ");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["v3-in-moves"] }),
        qc.invalidateQueries({ queryKey: ["v3-warehouse"] }),
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
        title={lang === "id" ? "Masuk ke Gudang" : "إدخال إلى المستودع"}
        description={lang === "id" ? "Catat barang masuk. Menambah saldo gudang." : "سجّل دخول المواد. يزيد رصيد المستودع."}
        action={<PrimaryButton onClick={() => setOpen(true)}>{lang === "id" ? "+ Masuk gudang" : "+ إدخال إلى المستودع"}</PrimaryButton>}
      />
      <PageHint>
        {lang === "id" ? "Satu baris = satu WAREHOUSE_IN." : "كل صف = حركة إدخال واحدة WAREHOUSE_IN."}
      </PageHint>

      <FormSection>
        <div className="overflow-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="pb-2 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Supplier" : "المورد"}</th>
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
                  <td className="py-2">{String(r.supplier || "—")}</td>
                  <td className="py-2">{String(r.receiver || "—")}</td>
                  <td className="py-2 text-xs text-[hsl(var(--muted-foreground))]">{String(r.notes || "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FormSection>

      {open ? (
        <Modal title={lang === "id" ? "Masuk gudang" : "إدخال إلى المستودع"} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <FormField label={lang === "id" ? "Bahan" : "المادة"} required>
              <SelectInput value={itemId} onChange={(e) => {
                setItemId(e.target.value);
                const it = items.data?.rows.find((x) => String(x.id) === e.target.value);
                if (it?.baseUnit) setUnit(it.baseUnit);
              }}>
                <option value="">{lang === "id" ? "Pilih..." : "اختر..."}</option>
                {(items.data?.rows ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}{i.warehouseQtyNumeric != null ? ` (${i.warehouseQtyNumeric})` : ""}</option>
                ))}
              </SelectInput>
            </FormField>
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Kuantitas" : "الكمية"} required><TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Satuan" : "الوحدة"}><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Supplier" : "المورد"}><TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Penerima" : "المستلم"}><TextInput value={receiver} onChange={(e) => setReceiver(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
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
