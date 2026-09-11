import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, SecondaryButton, SelectInput, TextInput, NumberInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  assertWarehouseInCommitted,
  createV3Item, listV3Items, listV3Movements, newClientRequestId, postV3WarehouseIn, todayISO,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";
import { EmptyState } from "./v3-ui";

export function V3WarehouseInPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [itemId, setItemId] = useState("");
  const [useNew, setUseNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newMinimum, setNewMinimum] = useState("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(todayISO());
  const [supplier, setSupplier] = useState("");
  const [receiver, setReceiver] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");

  const moves = useQuery({
    queryKey: ["v3-in-moves"],
    queryFn: () => listV3Movements({ type: "WAREHOUSE_IN", pageSize: 100 }),
  });
  const items = useQuery({ queryKey: ["v3-items-brief"], queryFn: () => listV3Items(), enabled: open });

  function openForm() {
    setError("");
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const qtyNum = parseStrictNumeric(qtyRaw);
      if (qtyNum != null && !(qtyNum > 0)) {
        throw new Error(lang === "id" ? "Qty harus > 0" : "الكمية يجب أن تكون أكبر من صفر");
      }
      let inventoryItemId = itemId ? Number(itemId) : 0;
      if (useNew) {
        if (!newName.trim()) throw new Error(lang === "id" ? "Nama wajib" : "اسم المادة مطلوب");
      const created = await createV3Item({
          name: newName.trim(),
          category: newCategory,
          baseUnit: unit,
          minimumStock: newMinimum.trim() === "" ? null : Number(newMinimum),
        });
        inventoryItemId = Number((created as { id?: number }).id ?? (created as { item?: { id: number } }).item?.id);
        if (!Number.isFinite(inventoryItemId) || inventoryItemId <= 0) {
          throw new Error(lang === "id" ? "Gagal membuat bahan baru" : "فشل إنشاء المادة الجديدة — لم يُرجع الخادم رقم المادة.");
        }
        if (newMinimum.trim() !== "") {
          // minimum is optional; createItem may not accept it — keep in notes if needed
        }
      }
      if (!inventoryItemId) throw new Error(lang === "id" ? "Pilih bahan" : "اختر المادة");

      const noteParts = [notes.trim()];
      if (price.trim()) noteParts.push(lang === "id" ? `Harga: ${price}` : `السعر: ${price}`);
      if (useNew && newMinimum.trim()) {
        noteParts.push(lang === "id" ? `Min: ${newMinimum}` : `الحد الأدنى: ${newMinimum}`);
      }

      const result = await postV3WarehouseIn({
        inventoryItemId,
        movementDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: qtyNum,
        unitRaw: unit,
        supplier: supplier || undefined,
        receiver: receiver || undefined,
        notes: noteParts.filter(Boolean).join(" — ") || undefined,
        clientRequestId: newClientRequestId(),
      });
      assertWarehouseInCommitted(result);

      const bal =
        (result as { balances?: { warehouseQtyNumeric?: number | null }; item?: { warehouseQtyNumeric?: number | null } })
          .balances?.warehouseQtyNumeric ??
        (result as { item?: { warehouseQtyNumeric?: number | null } }).item?.warehouseQtyNumeric;
      setOpen(false);
      setItemId(""); setUseNew(false); setNewName(""); setNewCategory(""); setNewMinimum("");
      setQtyRaw(""); setUnit(""); setSupplier(""); setReceiver(""); setPrice(""); setNotes("");
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
      // Keep form open with values; do not clear or show success.
      setError(e instanceof Error ? e.message : "Error");
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
        action={
          <PrimaryButton type="button" onClick={openForm}>
            {lang === "id" ? "+ Masuk gudang" : "+ إدخال للمستودع"}
          </PrimaryButton>
        }
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
                      onAction={openForm}
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
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>

            <div className="flex flex-wrap gap-2">
              <SecondaryButton
                type="button"
                className={!useNew ? "!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]" : ""}
                onClick={() => setUseNew(false)}
              >
                {lang === "id" ? "Pilih bahan ada" : "اختيار مادة موجودة"}
              </SecondaryButton>
              <SecondaryButton
                type="button"
                className={useNew ? "!bg-[hsl(var(--primary))] !text-[hsl(var(--primary-foreground))]" : ""}
                onClick={() => { setUseNew(true); setItemId(""); }}
              >
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
                <FormField label={lang === "id" ? "Satuan" : "الوحدة"}>
                  <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} />
                </FormField>
                <FormField label={lang === "id" ? "Min (opsional)" : "الحد الأدنى (اختياري)"}>
                  <NumberInput value={newMinimum} onChange={(e) => setNewMinimum(e.target.value)} />
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

            <FormField label={lang === "id" ? "Kuantitas" : "الكمية"} required>
              <TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} />
            </FormField>
            {!useNew ? (
              <FormField label={lang === "id" ? "Satuan" : "الوحدة"}>
                <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} />
              </FormField>
            ) : null}
            <FormField label={lang === "id" ? "Supplier" : "المورد"}>
              <TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Penerima" : "المستلم"}>
              <TextInput value={receiver} onChange={(e) => setReceiver(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Harga (opsional)" : "السعر (اختياري)"}>
              <NumberInput value={price} onChange={(e) => setPrice(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}>
              <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>

            {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}

            <div className="flex justify-end gap-2">
              <SecondaryButton type="button" onClick={() => setOpen(false)}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
              <PrimaryButton
                type="button"
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
