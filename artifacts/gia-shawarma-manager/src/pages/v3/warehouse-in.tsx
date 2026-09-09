import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, SecondaryButton, SelectInput, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  createV3Item, listV3Items, listV3Movements, newClientRequestId, postV3WarehouseIn, todayISO,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";
import { EmptyState } from "./v3-ui";

export function V3WarehouseInPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemId, setItemId] = useState("");
  const [useNew, setUseNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
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
      const qtyNum = parseStrictNumeric(qtyRaw);
      if (qtyNum != null && !(qtyNum > 0)) {
        throw new Error(lang === "id" ? "Qty harus > 0" : "الكمية يجب أن تكون أكبر من صفر");
      }
      let inventoryItemId = itemId ? Number(itemId) : 0;
      if (useNew) {
        const created = await createV3Item({
          name: newName,
          category: newCategory,
          baseUnit: unit,
        });
        inventoryItemId = Number((created as { id?: number }).id ?? (created as { item?: { id: number } }).item?.id);
      }
      if (!inventoryItemId) throw new Error(lang === "id" ? "Pilih bahan" : "اختر المادة");

      const result = await postV3WarehouseIn({
        inventoryItemId,
        movementDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: qtyNum,
        unitRaw: unit,
        supplier: supplier || undefined,
        receiver: receiver || undefined,
        notes: notes || undefined,
        clientRequestId: newClientRequestId(),
      }) as { balances?: { warehouseQtyNumeric?: number | null }; item?: { warehouseQtyNumeric?: number | null } };

      const bal =
        result.balances?.warehouseQtyNumeric ??
        result.item?.warehouseQtyNumeric;
      setOpen(false);
      setItemId(""); setUseNew(false); setNewName(""); setNewCategory("");
      setQtyRaw(""); setUnit(""); setSupplier(""); setReceiver(""); setNotes("");
      setFlash(
        bal != null
          ? (lang === "id" ? `Tersimpan. Saldo gudang sekarang: ${bal}` : `تم الحفظ. رصيد المستودع الآن: ${bal}`)
          : (lang === "id" ? "Tersimpan" : "تم الحفظ"),
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["v3-in-moves"] }),
        qc.invalidateQueries({ queryKey: ["v3-warehouse"] }),
        qc.invalidateQueries({ queryKey: ["v3-items-brief"] }),
      ]);
      window.setTimeout(() => setFlash(""), 4000);
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
        title={lang === "id" ? "Masuk ke Gudang" : "إدخال للمستودع"}
        description={lang === "id" ? "Catat barang masuk. Menambah saldo gudang." : "سجّل دخول المواد. يزيد رصيد المستودع."}
        action={<PrimaryButton onClick={() => setOpen(true)}>{lang === "id" ? "+ Masuk gudang" : "+ إدخال للمستودع"}</PrimaryButton>}
      />
      <PageHint>
        {lang === "id" ? "Satu baris = satu masuk gudang." : "كل صف = حركة إدخال واحدة للمستودع."}
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
              {!moves.data?.rows?.length && !moves.isLoading ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      message={lang === "id" ? "Belum ada masuk gudang." : "لا إدخالات للمستودع بعد."}
                      actionLabel={lang === "id" ? "+ Masuk gudang" : "+ إدخال للمستودع"}
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
        <Modal title={lang === "id" ? "Masuk gudang" : "إدخال للمستودع"} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <SecondaryButton className={!useNew ? "!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]" : ""} onClick={() => setUseNew(false)}>
                {lang === "id" ? "Bahan ada" : "مادة موجودة"}
              </SecondaryButton>
              <SecondaryButton className={useNew ? "!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]" : ""} onClick={() => setUseNew(true)}>
                + {lang === "id" ? "Bahan baru" : "إضافة مادة جديدة"}
              </SecondaryButton>
            </div>
            {useNew ? (
              <>
                <FormField label={lang === "id" ? "Nama" : "اسم المادة"} required>
                  <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} />
                </FormField>
                <FormField label={lang === "id" ? "Kategori" : "التصنيف"}>
                  <TextInput value={newCategory} onChange={(e) => setNewCategory(e.target.value)} />
                </FormField>
              </>
            ) : (
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
            )}
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Kuantitas" : "الكمية"} required><TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Satuan" : "الوحدة"}><TextInput value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Supplier" : "المورد"}><TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Penerima" : "المستلم"}><TextInput value={receiver} onChange={(e) => setReceiver(e.target.value)} /></FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
            <div className="flex justify-end gap-2">
              <SecondaryButton onClick={() => setOpen(false)}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
              <PrimaryButton
                disabled={saving || !qtyRaw.trim() || (useNew ? !newName.trim() : !itemId)}
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
