import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, Modal, PageHint, PrimaryButton, SecondaryButton, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  listV3Items, listV3Movements, newClientRequestId, postV3Opening, todayISO,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";

export function V3OpeningPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [unit, setUnit] = useState("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [itemId, setItemId] = useState<number | "">("");

  const moves = useQuery({
    queryKey: ["v3-opening-moves"],
    queryFn: () => listV3Movements({ type: "OPENING", pageSize: 100 }),
  });
  const items = useQuery({
    queryKey: ["v3-items-brief"],
    queryFn: () => listV3Items(),
    enabled: open,
  });

  async function save() {
    setSaving(true);
    try {
      if (itemId !== "") {
        const selected = (items.data?.rows ?? []).find((i) => i.id === Number(itemId));
        // Client-side hint: if warehouse already has opening-like stock history, API will also reject.
        if (selected && selected.warehouseQtyNumeric != null) {
          // Still attempt — server enforces duplicate OPENING. Show Arabic if known.
        }
      }
      await postV3Opening({
        inventoryItemId: itemId === "" ? undefined : Number(itemId),
        name: itemId === "" ? name : undefined,
        category: itemId === "" ? category : undefined,
        baseUnit: unit,
        balanceDate: date,
        quantityRaw: qtyRaw,
        quantityNumeric: parseStrictNumeric(qtyRaw),
        unitRaw: unit,
        notes: notes || undefined,
        clientRequestId: newClientRequestId(),
      });
      setOpen(false);
      setName(""); setCategory(""); setUnit(""); setQtyRaw(""); setNotes(""); setItemId("");
      setFlash(lang === "id" ? "Tersimpan" : "تم حفظ رصيد الافتتاح");
      await qc.invalidateQueries({ queryKey: ["v3-opening-moves"] });
      await qc.invalidateQueries({ queryKey: ["v3-warehouse"] });
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
        title={lang === "id" ? "Saldo Awal Gudang" : "رصيد افتتاح المستودع"}
        description={lang === "id" ? "Dasar awal stok. Bukan untuk pembelian harian." : "أساس البداية فقط. ليست للمشتريات اليومية."}
        action={<PrimaryButton onClick={() => setOpen(true)}>{lang === "id" ? "+ Tambah bahan" : "+ إضافة مادة"}</PrimaryButton>}
      />
      <PageHint>
        {lang === "id"
          ? "Simpan teks kuantitas apa adanya. Angka hanya diisi jika jelas numerik."
          : "احفظ نص الكمية كما هو. الرقم فقط إذا كانت الكمية رقمية بوضوح."}
      </PageHint>

      <FormSection>
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="pb-2 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Bahan" : "المادة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Catatan" : "ملاحظات"}</th>
              </tr>
            </thead>
            <tbody>
              {(moves.data?.rows ?? []).map((r) => (
                <tr key={String(r.id)} className="border-b border-[hsl(var(--border)/.5)]">
                  <td className="py-2 font-mono text-xs">{String(r.movementDate)}</td>
                  <td className="py-2 font-semibold">{String(r.itemName)}</td>
                  <td className="py-2 font-mono">{String(r.quantityRaw)}{r.quantityNumeric != null ? ` (${r.quantityNumeric})` : ""}</td>
                  <td className="py-2">{String(r.unitRaw || r.itemUnit || "—")}</td>
                  <td className="py-2 text-xs text-[hsl(var(--muted-foreground))]">{String(r.notes || "—")}</td>
                </tr>
              ))}
              {!moves.data?.rows?.length && !moves.isLoading ? (
                <tr><td colSpan={5} className="py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada opening." : "لا أرصدة افتتاح بعد."}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </FormSection>

      {open ? (
        <Modal title={lang === "id" ? "Tambah saldo awal" : "إضافة رصيد افتتاح"} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <FormField label={lang === "id" ? "Bahan yang sudah ada (opsional)" : "مادة موجودة (اختياري)"}>
              <select
                className="box-border w-full min-h-[44px] rounded-xl border border-[hsl(var(--input))] bg-[hsl(var(--card))] px-3"
                value={itemId === "" ? "" : String(itemId)}
                onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : "")}
              >
                <option value="">{lang === "id" ? "— Bahan baru —" : "— مادة جديدة —"}</option>
                {(items.data?.rows ?? []).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </FormField>
            {itemId !== "" ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                {lang === "id"
                  ? "Jika bahan sudah punya opening, sistem akan menolak duplikat."
                  : "إذا كان للمادة رصيد افتتاح مسبقاً، سيرفض النظام التكرار ويطلب استخدام الإدخال للمستودع."}
              </div>
            ) : (
              <>
                <FormField label={lang === "id" ? "Nama bahan" : "اسم المادة"} required>
                  <TextInput value={name} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label={lang === "id" ? "Kategori" : "التصنيف"}>
                  <TextInput value={category} onChange={(e) => setCategory(e.target.value)} />
                </FormField>
              </>
            )}
            <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Kuantitas (teks asli)" : "الكمية (النص الأصلي)"} required hint={lang === "id" ? "Contoh: 2 atau 3 أكياس صغيرة" : "مثال: 2 أو 3 أكياس صغيرة"}>
              <TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Satuan" : "الوحدة"}>
              <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Catatan" : "ملاحظات"}>
              <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
            <div className="flex justify-end gap-2">
              <SecondaryButton onClick={() => setOpen(false)}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>
              <PrimaryButton disabled={saving || !qtyRaw.trim() || (itemId === "" && !name.trim())} onClick={() => void save()}>
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
