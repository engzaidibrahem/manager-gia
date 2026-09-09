import { useMemo, useState } from "react";
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
  destinationLabel,
  listV3Items,
  listV3Purchases,
  newClientRequestId,
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

export function V3PurchasesPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [destination, setDestination] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [payFor, setPayFor] = useState<V3Purchase | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");

  const [form, setForm] = useState({
    purchaseDate: todayISO(),
    purchaseTime: "",
    itemName: "",
    inventoryItemId: "" as string,
    useNewItem: false,
    newName: "",
    newCategory: "",
    newUnit: "",
    quantityNumeric: "",
    quantityRaw: "",
    unitRaw: "",
    unitPrice: "",
    totalAmount: "",
    paidAmount: "",
    paymentStatus: "UNPAID" as "PAID" | "UNPAID" | "PARTIAL",
    supplier: "",
    purchasedBy: "",
    destination: "" as Dest,
    notes: "",
  });

  const query = useQuery({
    queryKey: ["v3-purchases", q, from, to, destination, page],
    queryFn: () => listV3Purchases({ q, from, to, destination, page, pageSize: 50 }),
  });

  const itemsQ = useQuery({
    queryKey: ["v3-items-brief", form.itemName],
    queryFn: () => listV3Items(form.itemName),
    enabled: open && (form.destination === "WAREHOUSE" || form.destination === "KITCHEN_DIRECT"),
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (query.data?.pageSize ?? 50)));

  const computedTotal = useMemo(() => {
    const qty = Number(form.quantityNumeric);
    const price = Number(form.unitPrice);
    if (Number.isFinite(qty) && Number.isFinite(price) && qty > 0) return qty * price;
    return null;
  }, [form.quantityNumeric, form.unitPrice]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form.destination) throw new Error(lang === "id" ? "Pilih tujuan" : "اختر الوجهة");
      const totalAmount = form.totalAmount !== "" ? Number(form.totalAmount) : (computedTotal ?? 0);
      let paidAmount = Number(form.paidAmount || 0);
      if (form.paymentStatus === "PAID") paidAmount = totalAmount;
      if (form.paymentStatus === "UNPAID") paidAmount = 0;

      return postV3Purchase({
        purchaseDate: form.purchaseDate,
        purchaseTime: form.purchaseTime,
        itemName: form.useNewItem ? form.newName || form.itemName : form.itemName,
        inventoryItemId:
          form.useNewItem || !form.inventoryItemId ? null : Number(form.inventoryItemId),
        newItem: form.useNewItem
          ? {
              name: form.newName || form.itemName,
              category: form.newCategory,
              baseUnit: form.newUnit || form.unitRaw,
            }
          : null,
        quantityNumeric: form.quantityNumeric === "" ? null : Number(form.quantityNumeric),
        quantityRaw: form.quantityRaw || form.quantityNumeric,
        unitRaw: form.unitRaw || form.newUnit,
        unitPrice: Number(form.unitPrice || 0),
        totalAmount,
        paidAmount,
        paymentStatus: form.paymentStatus,
        supplier: form.supplier,
        purchasedBy: form.purchasedBy,
        destination: form.destination,
        notes: form.notes,
        clientRequestId: newClientRequestId(),
      });
    },
    onSuccess: async () => {
      setOpen(false);
      setFlash(lang === "id" ? "Pembelian tersimpan" : "تم حفظ المشتريات");
      setError("");
      await qc.invalidateQueries({ queryKey: ["v3-purchases"] });
      await qc.invalidateQueries({ queryKey: ["v3-warehouse"] });
      await qc.invalidateQueries({ queryKey: ["v3-finance"] });
      await qc.invalidateQueries({ queryKey: ["v3-kitchen"] });
    },
    onError: (e: Error) => setError(e.message),
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
      await qc.invalidateQueries({ queryKey: ["v3-purchases"] });
      await qc.invalidateQueries({ queryKey: ["v3-warehouse"] });
      await qc.invalidateQueries({ queryKey: ["v3-finance"] });
      await qc.invalidateQueries({ queryKey: ["v3-kitchen"] });
    },
    onError: (e: Error) => setError(e.message),
  });

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
          ? "Pilih tujuan dengan jelas: Gudang / Dapur langsung / Konsumsi."
          : "اختر الوجهة بوضوح: المستودع / المطبخ مباشرة / شراء عادي."}
      </PageHint>

      <div className="mb-4 flex flex-wrap gap-2">
        <PrimaryButton onClick={() => { setOpen(true); setError(""); }}>+ {lang === "id" ? "Tambah pembelian" : "إضافة مشتريات"}</PrimaryButton>
        <TextInput className="max-w-xs" placeholder={lang === "id" ? "Cari..." : "بحث..."} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <TextInput type="date" className="max-w-[150px]" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
        <TextInput type="date" className="max-w-[150px]" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
        <SelectInput className="max-w-[180px]" value={destination} onChange={(e) => { setDestination(e.target.value); setPage(1); }}>
          <option value="">{lang === "id" ? "Semua tujuan" : "كل الوجهات"}</option>
          <option value="WAREHOUSE">{destinationLabel("WAREHOUSE", lang === "id" ? "id" : "ar")}</option>
          <option value="KITCHEN_DIRECT">{destinationLabel("KITCHEN_DIRECT", lang === "id" ? "id" : "ar")}</option>
          <option value="CONSUMABLE">{destinationLabel("CONSUMABLE", lang === "id" ? "id" : "ar")}</option>
        </SelectInput>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
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
              <th className="px-3 py-3 text-start">{lang === "id" ? "Catatan" : "ملاحظات"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Aksi" : "إجراءات"}</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={12} className="px-3 py-8 text-center">…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">{lang === "id" ? "Belum ada." : "لا بيانات بعد."}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                <td className="px-3 py-2.5 font-mono text-xs">{r.purchaseDate}</td>
                <td className="px-3 py-2.5 font-semibold">{r.itemName}</td>
                <td className="px-3 py-2.5 font-mono">{r.quantityNumeric ?? r.quantityRaw}</td>
                <td className="px-3 py-2.5">{r.unitRaw || "—"}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{formatIDR(r.unitPrice)}</td>
                <td className="px-3 py-2.5 font-mono font-bold">{formatIDR(r.totalAmount)}</td>
                <td className="px-3 py-2.5">{r.supplier || "—"}</td>
                <td className="px-3 py-2.5">{r.purchasedBy || "—"}</td>
                <td className="px-3 py-2.5 text-xs">{destinationLabel(r.destination, lang === "id" ? "id" : "ar")}</td>
                <td className="px-3 py-2.5 text-xs">
                  <div className="font-bold">{paymentStatusLabel(r.paymentStatus, lang === "id" ? "id" : "ar")}</div>
                  <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{formatIDR(r.paidAmount)} / {formatIDR(r.totalAmount)}</div>
                </td>
                <td className="px-3 py-2.5 text-xs">{r.notes || "—"}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {r.paymentStatus !== "PAID" ? (
                      <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => setPayFor(r)}>
                        {lang === "id" ? "Bayar" : "دفع"}
                      </SecondaryButton>
                    ) : null}
                    <SecondaryButton className="!px-2 !py-1 text-[11px]" onClick={() => {
                      if (confirm(lang === "id" ? "Batalkan pembelian?" : "إلغاء هذه المشتريات؟")) voidMut.mutate(r.id);
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
        <Modal title={lang === "id" ? "Tambah pembelian" : "إضافة مشتريات"} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <ChoiceCard
                selected={form.destination === "WAREHOUSE"}
                title={lang === "id" ? "Gudang" : "المستودع"}
                subtitle={lang === "id" ? "Masuk ke stok gudang." : "تُسجل وتُضاف الكمية إلى المستودع."}
                onClick={() => setForm((f) => ({ ...f, destination: "WAREHOUSE" }))}
              />
              <ChoiceCard
                selected={form.destination === "KITCHEN_DIRECT"}
                title={lang === "id" ? "Dapur langsung" : "المطبخ مباشرة"}
                subtitle={lang === "id" ? "Langsung ke dapur, tanpa gudang." : "تدخل المطبخ مباشرة دون المرور بالمستودع."}
                onClick={() => setForm((f) => ({ ...f, destination: "KITCHEN_DIRECT" }))}
              />
              <ChoiceCard
                selected={form.destination === "CONSUMABLE"}
                title={lang === "id" ? "Konsumsi" : "شراء عادي / مستهلك"}
                subtitle={lang === "id" ? "Catat saja, tanpa stok." : "تُسجل كمشتريات فقط ولا تدخل المخزون."}
                onClick={() => setForm((f) => ({ ...f, destination: "CONSUMABLE" }))}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
                <TextInput type="date" value={form.purchaseDate} onChange={(e) => setForm((f) => ({ ...f, purchaseDate: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Jam" : "الوقت"}>
                <TextInput value={form.purchaseTime} onChange={(e) => setForm((f) => ({ ...f, purchaseTime: e.target.value }))} placeholder="10:30" />
              </FormField>
              <FormField label={lang === "id" ? "Nama / tujuan" : "المادة / الغرض"} className="sm:col-span-2">
                <TextInput value={form.itemName} onChange={(e) => setForm((f) => ({ ...f, itemName: e.target.value }))} />
              </FormField>
            </div>

            {(form.destination === "WAREHOUSE" || form.destination === "KITCHEN_DIRECT") ? (
              <div className="rounded-xl border border-[hsl(var(--border))] p-3">
                <div className="mb-2 flex flex-wrap gap-2">
                  <SecondaryButton type="button" onClick={() => setForm((f) => ({ ...f, useNewItem: false }))}>
                    {lang === "id" ? "Pilih bahan ada" : "اختيار مادة موجودة"}
                  </SecondaryButton>
                  <SecondaryButton type="button" onClick={() => setForm((f) => ({ ...f, useNewItem: true }))}>
                    + {lang === "id" ? "Bahan baru" : "إضافة مادة جديدة"}
                  </SecondaryButton>
                </div>
                {form.useNewItem ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <TextInput placeholder={lang === "id" ? "Nama" : "اسم المادة"} value={form.newName} onChange={(e) => setForm((f) => ({ ...f, newName: e.target.value }))} />
                    <TextInput placeholder={lang === "id" ? "Kategori" : "التصنيف"} value={form.newCategory} onChange={(e) => setForm((f) => ({ ...f, newCategory: e.target.value }))} />
                    <TextInput placeholder={lang === "id" ? "Satuan" : "الوحدة"} value={form.newUnit} onChange={(e) => setForm((f) => ({ ...f, newUnit: e.target.value }))} />
                  </div>
                ) : (
                  <SelectInput value={form.inventoryItemId} onChange={(e) => setForm((f) => ({ ...f, inventoryItemId: e.target.value }))}>
                    <option value="">{lang === "id" ? "Pilih bahan..." : "اختر المادة..."}</option>
                    {(itemsQ.data?.rows ?? []).map((i) => (
                      <option key={i.id} value={i.id}>{i.name}</option>
                    ))}
                  </SelectInput>
                )}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label={lang === "id" ? "Qty angka" : "الكمية"}>
                <NumberInput value={form.quantityNumeric} onChange={(e) => setForm((f) => ({ ...f, quantityNumeric: e.target.value, totalAmount: "" }))} />
              </FormField>
              <FormField label={lang === "id" ? "Qty teks" : "الكمية نصاً"}>
                <TextInput value={form.quantityRaw} onChange={(e) => setForm((f) => ({ ...f, quantityRaw: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Satuan" : "الوحدة"}>
                <TextInput value={form.unitRaw} onChange={(e) => setForm((f) => ({ ...f, unitRaw: e.target.value }))} />
              </FormField>
              <FormField label={lang === "id" ? "Harga satuan" : "سعر الوحدة"}>
                <NumberInput value={form.unitPrice} onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value, totalAmount: "" }))} />
              </FormField>
              <FormField label={lang === "id" ? "Total" : "الإجمالي"}>
                <NumberInput
                  value={form.totalAmount !== "" ? form.totalAmount : (computedTotal != null ? String(computedTotal) : "")}
                  onChange={(e) => setForm((f) => ({ ...f, totalAmount: e.target.value }))}
                />
              </FormField>
              <FormField label={lang === "id" ? "Status bayar" : "حالة الدفع"}>
                <SelectInput value={form.paymentStatus} onChange={(e) => setForm((f) => ({ ...f, paymentStatus: e.target.value as typeof f.paymentStatus }))}>
                  <option value="UNPAID">{paymentStatusLabel("UNPAID", lang === "id" ? "id" : "ar")}</option>
                  <option value="PARTIAL">{paymentStatusLabel("PARTIAL", lang === "id" ? "id" : "ar")}</option>
                  <option value="PAID">{paymentStatusLabel("PAID", lang === "id" ? "id" : "ar")}</option>
                </SelectInput>
              </FormField>
              {form.paymentStatus === "PARTIAL" ? (
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
              <SecondaryButton onClick={() => setOpen(false)}>{lang === "id" ? "Tutup" : "إغلاق"}</SecondaryButton>
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
    </div>
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
        <PrimaryButton disabled={pending} onClick={() => onPay(Number(amount))}>{lang === "id" ? "Bayar" : "دفع"}</PrimaryButton>
      </div>
    </Modal>
  );
}
