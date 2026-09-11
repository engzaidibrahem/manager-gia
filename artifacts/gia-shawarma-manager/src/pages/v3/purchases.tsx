import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChoiceCard,
  FormField,
  Modal,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  assertPurchaseCommitted,
  destinationLabel,
  listV3Items,
  listV3PurchasePayments,
  listV3Purchases,
  newClientRequestId,
  patchV3Purchase,
  paymentStatusLabel,
  postV3Purchase,
  postV3PurchasePayment,
  todayISO,
  voidV3Purchase,
  type V3Purchase,
} from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";

type Dest = "WAREHOUSE" | "KITCHEN_DIRECT" | "CONSUMABLE" | "";
type PriceAnchor = "unit" | "total";

type PurchaseFormState = {
  purchaseDate: string;
  purchaseTime: string;
  itemName: string;
  inventoryItemId: string;
  useNewItem: boolean;
  newName: string;
  newCategory: string;
  newUnit: string;
  quantityNumeric: string;
  unitRaw: string;
  unitPrice: string;
  totalAmount: string;
  paidAmount: string;
  paymentStatus: "PAID" | "UNPAID" | "PARTIAL";
  supplier: string;
  purchasedBy: string;
  destination: Dest;
  notes: string;
};

function emptyForm(): PurchaseFormState {
  return {
    purchaseDate: todayISO(),
    purchaseTime: "",
    itemName: "",
    inventoryItemId: "",
    useNewItem: false,
    newName: "",
    newCategory: "",
    newUnit: "",
    quantityNumeric: "",
    unitRaw: "",
    unitPrice: "",
    totalAmount: "",
    paidAmount: "",
    paymentStatus: "UNPAID",
    supplier: "",
    purchasedBy: "",
    destination: "",
    notes: "",
  };
}

function formFromPurchase(p: V3Purchase): PurchaseFormState {
  return {
    purchaseDate: p.purchaseDate,
    purchaseTime: p.purchaseTime || "",
    itemName: p.itemName,
    inventoryItemId: p.inventoryItemId ? String(p.inventoryItemId) : "",
    useNewItem: false,
    newName: "",
    newCategory: "",
    newUnit: "",
    quantityNumeric: p.quantityNumeric != null ? String(p.quantityNumeric) : (p.quantityRaw || ""),
    unitRaw: p.unitRaw || "",
    unitPrice: String(p.unitPrice ?? ""),
    totalAmount: String(p.totalAmount ?? ""),
    paidAmount: String(p.paidAmount ?? ""),
    paymentStatus: (p.paymentStatus as "PAID" | "UNPAID" | "PARTIAL") || "UNPAID",
    supplier: p.supplier || "",
    purchasedBy: p.purchasedBy || "",
    destination: (p.destination as Dest) || "",
    notes: p.notes || "",
  };
}

function roundMoney(n: number): number {
  return Math.round(n);
}

async function invalidatePurchaseViews(qc: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["v3-purchases"] }),
    qc.invalidateQueries({ queryKey: ["v3-warehouse"] }),
    qc.invalidateQueries({ queryKey: ["v3-finance"] }),
    qc.invalidateQueries({ queryKey: ["v3-kitchen"] }),
    qc.invalidateQueries({ queryKey: ["v3-in-moves"] }),
    qc.invalidateQueries({ queryKey: ["v3-items-brief"] }),
  ]);
}

export function V3PurchasesPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [destination, setDestination] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<V3Purchase | null>(null);
  const [payFor, setPayFor] = useState<V3Purchase | null>(null);
  const [detail, setDetail] = useState<V3Purchase | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [priceAnchor, setPriceAnchor] = useState<PriceAnchor>("unit");
  const [form, setForm] = useState<PurchaseFormState>(emptyForm);

  const query = useQuery({
    queryKey: ["v3-purchases", q, from, to, destination, page],
    queryFn: () => listV3Purchases({ q, from, to, destination, page, pageSize: 50 }),
  });

  const itemsQ = useQuery({
    queryKey: ["v3-items-brief", form.itemName, form.newName],
    queryFn: () => listV3Items(form.useNewItem ? form.newName : form.itemName),
    enabled: open && form.destination === "WAREHOUSE",
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (query.data?.pageSize ?? 50)));

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setPriceAnchor("unit");
    setError("");
    setOpen(true);
  }

  function openEdit(p: V3Purchase) {
    if (p.status === "voided") return;
    setDetail(null);
    setEditing(p);
    setForm(formFromPurchase(p));
    setPriceAnchor("unit");
    setError("");
    setOpen(true);
  }

  function applyQtyChange(qtyStr: string) {
    setForm((f) => {
      const qty = Number(qtyStr);
      if (!(Number.isFinite(qty) && qty > 0)) {
        return { ...f, quantityNumeric: qtyStr };
      }
      if (priceAnchor === "unit") {
        const unit = Number(f.unitPrice);
        if (Number.isFinite(unit)) {
          return { ...f, quantityNumeric: qtyStr, totalAmount: String(roundMoney(qty * unit)) };
        }
      } else {
        const tot = Number(f.totalAmount);
        if (Number.isFinite(tot)) {
          return { ...f, quantityNumeric: qtyStr, unitPrice: String(roundMoney(tot / qty)) };
        }
      }
      return { ...f, quantityNumeric: qtyStr };
    });
  }

  function applyUnitPriceChange(priceStr: string) {
    setPriceAnchor("unit");
    setForm((f) => {
      const unit = Number(priceStr);
      const qty = Number(f.quantityNumeric);
      if (Number.isFinite(unit) && Number.isFinite(qty) && qty > 0) {
        return { ...f, unitPrice: priceStr, totalAmount: String(roundMoney(qty * unit)) };
      }
      return { ...f, unitPrice: priceStr };
    });
  }

  function applyTotalChange(totalStr: string) {
    setPriceAnchor("total");
    setForm((f) => {
      const tot = Number(totalStr);
      const qty = Number(f.quantityNumeric);
      if (Number.isFinite(tot) && Number.isFinite(qty) && qty > 0) {
        return { ...f, totalAmount: totalStr, unitPrice: String(roundMoney(tot / qty)) };
      }
      return { ...f, totalAmount: totalStr };
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const mode: "edit" | "create" = editing ? "edit" : "create";
      if (!form.destination) throw new Error(lang === "id" ? "Pilih tujuan" : "اختر الوجهة");
      const qty = Number(form.quantityNumeric);
      const unitPrice = Number(form.unitPrice || 0);
      let totalAmount = Number(form.totalAmount || 0);
      if (Number.isFinite(qty) && qty > 0 && Number.isFinite(unitPrice) && form.totalAmount === "") {
        totalAmount = roundMoney(qty * unitPrice);
      }
      if (!(Number.isFinite(totalAmount) && totalAmount >= 0)) {
        throw new Error(lang === "id" ? "Total tidak valid" : "الإجمالي غير صالح");
      }

      const isWarehouse = form.destination === "WAREHOUSE";
      const itemName = isWarehouse
        ? (form.useNewItem ? form.newName : form.itemName)
        : form.itemName;
      if (!itemName.trim()) {
        throw new Error(
          form.destination === "CONSUMABLE"
            ? (lang === "id" ? "Nama / tujuan wajib" : "اسم المادة / الغرض مطلوب")
            : (lang === "id" ? "Nama bahan wajib" : "اسم المادة مطلوب"),
        );
      }
      if (isWarehouse && !form.useNewItem && !form.inventoryItemId && !editing) {
        throw new Error(lang === "id" ? "Pilih bahan gudang" : "اختر مادة المستودع");
      }
      if (isWarehouse && form.useNewItem && !form.newName.trim()) {
        throw new Error(lang === "id" ? "Nama bahan baru wajib" : "اسم المادة الجديدة مطلوب");
      }

      if (editing) {
        if (editing.paidAmount > 0 && totalAmount + 1e-9 < editing.paidAmount) {
          throw new Error(
            lang === "id"
              ? `Total tidak boleh kurang dari yang sudah dibayar (${editing.paidAmount})`
              : `الإجمالي لا يمكن أن يكون أقل من المدفوع بالفعل (${editing.paidAmount})`,
          );
        }
        await patchV3Purchase(editing.id, {
          purchaseDate: form.purchaseDate,
          purchaseTime: form.purchaseTime,
          itemName: itemName.trim(),
          inventoryItemId:
            isWarehouse && !form.useNewItem && form.inventoryItemId
              ? Number(form.inventoryItemId)
              : (isWarehouse && editing.inventoryItemId ? editing.inventoryItemId : null),
          newItem:
            isWarehouse && form.useNewItem
              ? {
                  name: form.newName.trim(),
                  category: form.newCategory,
                  baseUnit: form.newUnit || form.unitRaw,
                }
              : null,
          quantityNumeric: form.quantityNumeric === "" ? null : qty,
          quantityRaw: form.quantityNumeric,
          unitRaw: form.unitRaw || form.newUnit,
          unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
          totalAmount,
          supplier: form.supplier,
          purchasedBy: form.purchasedBy,
          destination: form.destination,
          notes: form.notes,
        }).then((raw) => {
          const id = Number((raw as { purchaseId?: number; purchase?: { id?: number } })?.purchaseId
            ?? (raw as { purchase?: { id?: number } })?.purchase?.id);
          if (!Number.isFinite(id) || id <= 0) {
            throw new Error("لم يتم تأكيد تعديل المشتريات من الخادم.");
          }
        });
        return mode;
      }

      let paidAmount = Number(form.paidAmount || 0);
      if (form.paymentStatus === "PAID") paidAmount = totalAmount;
      if (form.paymentStatus === "UNPAID") paidAmount = 0;

      const raw = await postV3Purchase({
        purchaseDate: form.purchaseDate,
        purchaseTime: form.purchaseTime,
        itemName: itemName.trim(),
        inventoryItemId:
          isWarehouse && !form.useNewItem && form.inventoryItemId
            ? Number(form.inventoryItemId)
            : null,
        newItem:
          isWarehouse && form.useNewItem
            ? {
                name: form.newName.trim(),
                category: form.newCategory,
                baseUnit: form.newUnit || form.unitRaw,
              }
            : null,
        quantityNumeric: form.quantityNumeric === "" ? null : qty,
        quantityRaw: form.quantityNumeric,
        unitRaw: form.unitRaw || form.newUnit,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
        totalAmount,
        paidAmount,
        paymentStatus: form.paymentStatus,
        supplier: form.supplier,
        purchasedBy: form.purchasedBy,
        destination: form.destination,
        notes: form.notes,
        clientRequestId: newClientRequestId(),
      });
      assertPurchaseCommitted(raw, form.destination);
      return mode;
    },
    onSuccess: async (mode) => {
      setOpen(false);
      setEditing(null);
      setFlash(mode === "edit"
        ? (lang === "id" ? "Pembelian diperbarui" : "تم تحديث المشتريات")
        : (lang === "id" ? "Pembelian tersimpan" : "تم حفظ المشتريات"));
      setError("");
      await invalidatePurchaseViews(qc);
    },
    onError: (e: Error) => {
      // Keep modal/form open with entered values; never fake success.
      setError(e.message || (lang === "id" ? "Gagal menyimpan" : "فشل الحفظ"));
    },
  });

  const payMut = useMutation({
    mutationFn: async ({ id, amount }: { id: number; amount: number }) =>
      postV3PurchasePayment(id, { amount, clientRequestId: newClientRequestId() }),
    onSuccess: async () => {
      setPayFor(null);
      setFlash(lang === "id" ? "Pembayaran tercatat" : "تم تسجيل الدفع");
      await qc.invalidateQueries({ queryKey: ["v3-purchases"] });
      await qc.invalidateQueries({ queryKey: ["v3-finance"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const voidMut = useMutation({
    mutationFn: (id: number) => voidV3Purchase(id, lang === "id" ? "Dibatalkan dari UI" : "إلغاء من الواجهة"),
    onSuccess: async () => {
      setFlash(lang === "id" ? "Pembelian dibatalkan" : "تم إلغاء المشتريات");
      await invalidatePurchaseViews(qc);
    },
    onError: (e: Error) => setError(e.message),
  });

  const isEdit = Boolean(editing);

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Pembelian" : "المشتريات"}
        description={lang === "id"
          ? "Register pembelian permanen — filter tanggal, tanpa arsip harian."
          : "سجل مشتريات دائم — فلترة بالتاريخ، بدون أرشيف يومي."}
      />
      <PageHint>
        {lang === "id"
          ? "Pilih tujuan dengan jelas: Ke gudang / Ke dapur langsung / Pembelian saja."
          : "اختر الوجهة بوضوح: للمستودع / للمطبخ مباشرة / مشتريات فقط / مستهلكات."}
      </PageHint>

      <div className="mb-4 flex flex-wrap gap-2">
        <PrimaryButton onClick={openCreate}>+ {lang === "id" ? "Tambah pembelian" : "إضافة مشتريات"}</PrimaryButton>
        <TextInput className="max-w-xs" placeholder={lang === "id" ? "Cari..." : "بحث..."} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <TextInput type="date" className="max-w-[150px]" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <TextInput type="date" className="max-w-[150px]" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <SelectInput className="max-w-[220px]" value={destination} onChange={(e) => { setDestination(e.target.value); setPage(1); }}>
          <option value="">{lang === "id" ? "Semua tujuan" : "كل الوجهات"}</option>
          <option value="WAREHOUSE">{destinationLabel("WAREHOUSE", lang === "id" ? "id" : "ar")}</option>
          <option value="KITCHEN_DIRECT">{destinationLabel("KITCHEN_DIRECT", lang === "id" ? "id" : "ar")}</option>
          <option value="CONSUMABLE">{destinationLabel("CONSUMABLE", lang === "id" ? "id" : "ar")}</option>
        </SelectInput>
      </div>

      {error && !open ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[1100px] border-collapse text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Bahan/Tujuan" : "المادة / الغرض"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Harga" : "سعر الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Total" : "الإجمالي"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Supplier" : "المورد"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Oleh" : "من قام بالشراء"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Tujuan" : "الوجهة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Bayar" : "حالة الدفع"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Dibayar" : "المدفوع"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Sisa" : "المتبقي"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Catatan" : "ملاحظات"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Aksi" : "إجراءات"}</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={14} className="px-3 py-8 text-center">…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={14} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada pembelian." : "لا توجد مشتريات بعد."}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                <td className="px-3 py-2.5 font-mono text-xs">{r.purchaseDate}</td>
                <td className="px-3 py-2.5 font-semibold">
                  <button type="button" className="text-start text-[hsl(var(--primary))] hover:underline" onClick={() => setDetail(r)}>
                    {r.itemName}
                  </button>
                </td>
                <td className="px-3 py-2.5 font-mono">{r.quantityNumeric ?? r.quantityRaw}</td>
                <td className="px-3 py-2.5">{r.unitRaw || "—"}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{formatIDR(r.unitPrice)}</td>
                <td className="px-3 py-2.5 font-mono font-bold">{formatIDR(r.totalAmount)}</td>
                <td className="px-3 py-2.5">{r.supplier || "—"}</td>
                <td className="px-3 py-2.5">{r.purchasedBy || "—"}</td>
                <td className="px-3 py-2.5 text-xs">{destinationLabel(r.destination, lang === "id" ? "id" : "ar")}</td>
                <td className="px-3 py-2.5 text-xs font-bold">{paymentStatusLabel(r.paymentStatus, lang === "id" ? "id" : "ar")}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{formatIDR(r.paidAmount)}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{formatIDR(r.remainingAmount)}</td>
                <td className="px-3 py-2.5 text-xs">{r.notes || "—"}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => setDetail(r)}>
                      {lang === "id" ? "Detail" : "عرض التفاصيل"}
                    </SecondaryButton>
                    {r.status !== "voided" ? (
                      <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => openEdit(r)}>
                        {lang === "id" ? "Edit" : "تعديل"}
                      </SecondaryButton>
                    ) : null}
                    {r.paymentStatus !== "PAID" ? (
                      <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => setPayFor(r)}>
                        {lang === "id" ? "Bayar" : "دفع"}
                      </SecondaryButton>
                    ) : null}
                    <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => {
                      if (confirm(lang === "id"
                        ? "Batalkan pembelian? Stok terkait akan dibatalkan jika aman."
                        : "إلغاء هذه المشتريات؟ سيتم عكس حركة المخزون المرتبطة إن أمكن، وستُلغى الدفعات.")) voidMut.mutate(r.id);
                    }}>
                      {lang === "id" ? "Batal" : "إلغاء"}
                    </SecondaryButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs">
        <span>{total} {lang === "id" ? "baris" : "صف"}</span>
        <div className="flex gap-2">
          <SecondaryButton disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{lang === "id" ? "Sebelumnya" : "السابق"}</SecondaryButton>
          <span className="px-2 py-2 font-mono">{page}/{pages}</span>
          <SecondaryButton disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{lang === "id" ? "Berikutnya" : "التالي"}</SecondaryButton>
        </div>
      </div>

      {open ? (
        <Modal
          title={
            isEdit
              ? (lang === "id" ? "Edit pembelian" : "تعديل المشتريات")
              : (lang === "id" ? "Tambah pembelian" : "إضافة مشتريات")
          }
          onClose={() => { setOpen(false); setEditing(null); }}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <ChoiceCard
                selected={form.destination === "WAREHOUSE"}
                title={lang === "id" ? "Ke gudang" : "للمستودع"}
                subtitle={lang === "id" ? "Masuk ke stok gudang + riwayat masuk." : "تُضاف للمستودع وتظهر في إدخال المستودع."}
                onClick={() => setForm((f) => ({
                  ...f,
                  destination: "WAREHOUSE",
                  useNewItem: false,
                  newName: "",
                }))}
              />
              <ChoiceCard
                selected={form.destination === "KITCHEN_DIRECT"}
                title={lang === "id" ? "Ke dapur langsung" : "للمطبخ مباشرة"}
                subtitle={lang === "id" ? "Langsung ke dapur, tanpa gudang." : "تدخل المطبخ مباشرة دون زيادة المستودع."}
                onClick={() => setForm((f) => ({
                  ...f,
                  destination: "KITCHEN_DIRECT",
                  inventoryItemId: "",
                  useNewItem: false,
                  newName: "",
                }))}
              />
              <ChoiceCard
                selected={form.destination === "CONSUMABLE"}
                title={lang === "id" ? "Pembelian saja / konsumsi" : "مشتريات فقط / مستهلكات"}
                subtitle={lang === "id" ? "Catat saja, tanpa stok." : "تُسجل كمشتريات فقط — بدون مستودع أو مطبخ."}
                onClick={() => setForm((f) => ({
                  ...f,
                  destination: "CONSUMABLE",
                  inventoryItemId: "",
                  useNewItem: false,
                  newName: "",
                }))}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
                <TextInput type="date" value={form.purchaseDate} onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Jam" : "الوقت"}>
                <TextInput value={form.purchaseTime} onChange={(e) => setForm((f) => ({ ...f, purchaseTime: e.target.value }))} placeholder="10:30" />
              </FormField>
            </div>

            {form.destination === "WAREHOUSE" ? (
              <div className="rounded-xl border border-[hsl(var(--border))] p-3">
                <div className="mb-2 flex flex-wrap gap-2">
                  <SecondaryButton type="button" onClick={() => setForm((f) => ({ ...f, useNewItem: false }))}>
                    {lang === "id" ? "Pilih bahan ada" : "اختيار مادة موجودة"}
                  </SecondaryButton>
                  <SecondaryButton type="button" onClick={() => setForm((f) => ({ ...f, useNewItem: true, inventoryItemId: "" }))}>
                    + {lang === "id" ? "Bahan baru" : "إضافة مادة جديدة"}
                  </SecondaryButton>
                </div>
                {form.useNewItem ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <TextInput placeholder={lang === "id" ? "Nama" : "اسم المادة"} value={form.newName} onChange={(e) => setForm((f) => ({ ...f, newName: e.target.value, itemName: e.target.value }))} />
                    <TextInput placeholder={lang === "id" ? "Kategori" : "التصنيف"} value={form.newCategory} onChange={(e) => setForm((f) => ({ ...f, newCategory: e.target.value }))} />
                    <TextInput placeholder={lang === "id" ? "Satuan" : "الوحدة"} value={form.newUnit} onChange={(e) => setForm((f) => ({ ...f, newUnit: e.target.value }))} />
                  </div>
                ) : (
                  <SelectInput
                    value={form.inventoryItemId}
                    onChange={(e) => {
                      const id = e.target.value;
                      const found = (itemsQ.data?.rows ?? []).find((i) => String(i.id) === id);
                      setForm((f) => ({
                        ...f,
                        inventoryItemId: id,
                        itemName: found?.name || f.itemName,
                        unitRaw: found?.baseUnit || f.unitRaw,
                      }));
                    }}
                  >
                    <option value="">{lang === "id" ? "Pilih bahan..." : "اختر المادة..."}</option>
                    {(itemsQ.data?.rows ?? []).map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </SelectInput>
                )}
              </div>
            ) : null}

            {form.destination === "KITCHEN_DIRECT" ? (
              <FormField label={lang === "id" ? "Nama bahan" : "اسم المادة"}>
                <TextInput value={form.itemName} onChange={(e) => setForm((f) => ({ ...f, itemName: e.target.value }))} />
              </FormField>
            ) : null}

            {form.destination === "CONSUMABLE" ? (
              <FormField label={lang === "id" ? "Nama / tujuan" : "اسم المادة / الغرض"}>
                <TextInput value={form.itemName} onChange={(e) => setForm((f) => ({ ...f, itemName: e.target.value }))} />
              </FormField>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label={lang === "id" ? "Kuantitas" : "الكمية"} required>
                <NumberInput value={form.quantityNumeric} onChange={(e) => applyQtyChange(e.target.value)} />
              </FormField>
              <FormField label={lang === "id" ? "Satuan" : "الوحدة"}>
                <TextInput value={form.unitRaw} onChange={(e) => setForm((f) => ({ ...f, unitRaw: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Harga satuan" : "سعر الوحدة"}>
                <NumberInput value={form.unitPrice} onChange={(e) => applyUnitPriceChange(e.target.value)} />
              </FormField>
              <FormField
                label={lang === "id" ? "Total" : "الإجمالي"}
                hint={
                  form.totalAmount !== ""
                    ? formatIDR(Number(form.totalAmount) || 0)
                    : (lang === "id" ? "Dihitung otomatis" : "يُحسب تلقائياً")
                }
              >
                <NumberInput value={form.totalAmount} onChange={(e) => applyTotalChange(e.target.value)} />
              </FormField>
              {!isEdit ? (
                <FormField label={lang === "id" ? "Status bayar" : "حالة الدفع"}>
                  <SelectInput value={form.paymentStatus} onChange={(e) => setForm((f) => ({ ...f, paymentStatus: e.target.value as typeof f.paymentStatus }))}>
                    <option value="UNPAID">{paymentStatusLabel("UNPAID", lang === "id" ? "id" : "ar")}</option>
                    <option value="PARTIAL">{paymentStatusLabel("PARTIAL", lang === "id" ? "id" : "ar")}</option>
                    <option value="PAID">{paymentStatusLabel("PAID", lang === "id" ? "id" : "ar")}</option>
                  </SelectInput>
                </FormField>
              ) : (
                <FormField label={lang === "id" ? "Sudah dibayar" : "المدفوع (ثابت)"}>
                  <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/.4)] px-3 py-2 font-mono text-sm">
                    {formatIDR(editing?.paidAmount ?? 0)}
                  </div>
                </FormField>
              )}
              {!isEdit && form.paymentStatus === "PARTIAL" ? (
                <FormField label={lang === "id" ? "Dibayar" : "المدفوع"}>
                  <NumberInput value={form.paidAmount} onChange={(e) => setForm((f) => ({ ...f, paidAmount: e.target.value }))} />
                </FormField>
              ) : null}
              <FormField label={lang === "id" ? "Supplier" : "المورد"}>
                <TextInput value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Dibeli oleh" : "من قام بالشراء"}>
                <TextInput value={form.purchasedBy} onChange={(e) => setForm((f) => ({ ...f, purchasedBy: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Catatan" : "ملاحظات"} className="sm:col-span-3">
                <TextInput value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </FormField>
            </div>

            {error ? <div className="text-sm text-red-700">{error}</div> : null}
            <div className="flex justify-end gap-2">
              <SecondaryButton onClick={() => { setOpen(false); setEditing(null); }}>{lang === "id" ? "Tutup" : "إغلاق"}</SecondaryButton>
              <PrimaryButton disabled={save.isPending} onClick={() => save.mutate()}>
                {lang === "id" ? "Simpan" : "حفظ"}
              </PrimaryButton>
            </div>
          </div>
        </Modal>
      ) : null}

      {payFor ? (
        <PayModal
          lang={lang}
          purchase={payFor}
          onClose={() => setPayFor(null)}
          onPay={(amount) => payMut.mutate({ id: payFor.id, amount })}
          pending={payMut.isPending}
        />
      ) : null}

      {detail ? (
        <PurchaseDetailModal
          lang={lang}
          purchase={detail}
          onClose={() => setDetail(null)}
          onEdit={() => openEdit(detail)}
        />
      ) : null}
    </div>
  );
}

function PurchaseDetailModal({
  lang, purchase, onClose, onEdit,
}: {
  lang: Lang;
  purchase: V3Purchase;
  onClose: () => void;
  onEdit: () => void;
}) {
  const pays = useQuery({
    queryKey: ["v3-purchase-pays", purchase.id],
    queryFn: () => listV3PurchasePayments(purchase.id),
  });
  const canEdit = purchase.status !== "voided";
  return (
    <Modal title={lang === "id" ? "Detail pembelian" : "تفاصيل المشتريات"} onClose={onClose}>
      <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Tanggal" : "التاريخ"}: </span>{purchase.purchaseDate} {purchase.purchaseTime}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Bahan" : "المادة / الغرض"}: </span><b>{purchase.itemName}</b></div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Qty" : "الكمية"}: </span>{purchase.quantityNumeric ?? purchase.quantityRaw} {purchase.unitRaw}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Harga" : "سعر الوحدة"}: </span>{formatIDR(purchase.unitPrice)}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Total" : "الإجمالي"}: </span><b>{formatIDR(purchase.totalAmount)}</b></div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Supplier" : "المورد"}: </span>{purchase.supplier || "—"}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Oleh" : "من قام بالشراء"}: </span>{purchase.purchasedBy || "—"}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Tujuan" : "الوجهة"}: </span>{destinationLabel(purchase.destination, lang === "id" ? "id" : "ar")}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Status" : "حالة الدفع"}: </span>{paymentStatusLabel(purchase.paymentStatus, lang === "id" ? "id" : "ar")}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Dibayar" : "المدفوع"}: </span>{formatIDR(purchase.paidAmount)}</div>
        <div><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Sisa" : "المتبقي"}: </span>{formatIDR(purchase.remainingAmount)}</div>
        <div className="sm:col-span-2"><span className="text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Catatan" : "ملاحظات"}: </span>{purchase.notes || "—"}</div>
      </div>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
        {lang === "id" ? "Riwayat pembayaran" : "سجل الدفعات"}
      </h3>
      <div className="overflow-auto rounded-lg border border-[hsl(var(--border))]">
        <table className="w-full text-sm">
          <thead className="bg-[hsl(var(--muted))] text-[11px]">
            <tr>
              <th className="px-2 py-2 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
              <th className="px-2 py-2 text-start">{lang === "id" ? "Jumlah" : "المبلغ"}</th>
              <th className="px-2 py-2 text-start">{lang === "id" ? "Oleh" : "بواسطة"}</th>
            </tr>
          </thead>
          <tbody>
            {(pays.data?.rows ?? []).map((p) => (
              <tr key={String(p.id)} className="border-t border-[hsl(var(--border))]">
                <td className="px-2 py-2">{String(p.paymentDate)}</td>
                <td className="px-2 py-2 font-mono">{formatIDR(Number(p.amount))}</td>
                <td className="px-2 py-2">{String(p.actor || "—")}</td>
              </tr>
            ))}
            {!pays.data?.rows?.length ? (
              <tr><td colSpan={3} className="px-2 py-4 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada pembayaran" : "لا دفعات بعد"}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {canEdit ? (
          <PrimaryButton onClick={onEdit}>{lang === "id" ? "Edit" : "تعديل"}</PrimaryButton>
        ) : null}
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Tutup" : "إغلاق"}</SecondaryButton>
      </div>
    </Modal>
  );
}

function PayModal({
  lang, purchase, onClose, onPay, pending,
}: {
  lang: Lang;
  purchase: V3Purchase;
  onClose: () => void;
  onPay: (amount: number) => void;
  pending: boolean;
}) {
  const remaining = purchase.remainingAmount;
  const [amount, setAmount] = useState(String(remaining));
  return (
    <Modal title={lang === "id" ? "Bayar pembelian" : "دفع المشتريات"} onClose={onClose}>
      <p className="mb-3 text-sm">{purchase.itemName} — {lang === "id" ? "Sisa" : "المتبقي"}: <b>{formatIDR(remaining)}</b></p>
      <FormField label={lang === "id" ? "Jumlah" : "المبلغ"}>
        <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} />
      </FormField>
      <div className="mt-3 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Tutup" : "إغلاق"}</SecondaryButton>
        <PrimaryButton disabled={pending} onClick={() => onPay(Number(amount))}>
          {lang === "id" ? "Simpan" : "حفظ"}
        </PrimaryButton>
      </div>
    </Modal>
  );
}
