import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField, FormSection, PageHint, PrimaryButton, SecondaryButton, TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  listV3Movements,
  newClientRequestId,
  postV3WarehouseOut,
  searchV3Products,
  type V3ProductSearchRow,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { parseStrictNumeric } from "./parseQty";
import { EmptyState, StatusBadge, StockBanner } from "./v3-ui";

function statusTone(s: string): "ok" | "warn" | "danger" | "review" | "muted" {
  if (s === "NORMAL") return "ok";
  if (s === "LOW_STOCK") return "warn";
  if (s === "OUT_OF_STOCK") return "danger";
  if (s === "REVIEW_REQUIRED") return "review";
  return "muted";
}

function statusLabel(lang: Lang, s: string) {
  if (lang === "id") {
    if (s === "NORMAL") return "Normal";
    if (s === "LOW_STOCK") return "Rendah";
    if (s === "OUT_OF_STOCK") return "Habis";
    if (s === "REVIEW_REQUIRED") return "Review";
    return s;
  }
  if (s === "NORMAL") return "طبيعي";
  if (s === "LOW_STOCK") return "مخزون منخفض";
  if (s === "OUT_OF_STOCK") return "نفد";
  if (s === "REVIEW_REQUIRED") return "يحتاج مراجعة";
  return s;
}

export function V3WarehouseOutPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<V3ProductSearchRow | null>(null);
  const [qtyRaw, setQtyRaw] = useState("");
  const [notes, setNotes] = useState("");
  const [flash, setFlash] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);

  const searchQuery = useQuery({
    queryKey: ["v3-product-search", search],
    queryFn: () => searchV3Products(search),
    enabled: search.trim().length >= 1 && !selected,
  });

  const moves = useQuery({
    queryKey: ["v3-warehouse-out-moves"],
    queryFn: () => listV3Movements({ type: "WAREHOUSE_OUT", pageSize: 50 }),
  });

  const qtyNum = parseStrictNumeric(qtyRaw);
  const stockUnknown = selected != null && selected.warehouseQtyNumeric == null;
  const reviewBlocked = selected?.stockStatus === "REVIEW_REQUIRED";
  const overStock =
    selected?.warehouseQtyNumeric != null &&
    qtyNum != null &&
    qtyNum > selected.warehouseQtyNumeric + 1e-9;

  const canConfirm = useMemo(
    () =>
      selected != null &&
      qtyRaw.trim() !== "" &&
      qtyNum != null &&
      qtyNum > 0 &&
      !stockUnknown &&
      !reviewBlocked &&
      !overStock &&
      !saving,
    [selected, qtyRaw, qtyNum, stockUnknown, reviewBlocked, overStock, saving],
  );

  function pickProduct(row: V3ProductSearchRow) {
    setSelected(row);
    setSearch("");
    setQtyRaw("");
    setNotes("");
    setSuccess("");
  }

  function clearSelection() {
    setSelected(null);
    setQtyRaw("");
    setNotes("");
    setSuccess("");
  }

  async function confirmOut() {
    if (!selected || !canConfirm) return;
    const clientRequestId = pendingRequestId ?? newClientRequestId();
    if (!pendingRequestId) setPendingRequestId(clientRequestId);
    setSaving(true);
    setFlash("");
    setSuccess("");
    try {
      const result = await postV3WarehouseOut({
        inventoryItemId: selected.id,
        quantityRaw: qtyRaw,
        quantityNumeric: qtyNum,
        unitRaw: selected.baseUnit || undefined,
        notes: notes.trim() || undefined,
        clientRequestId,
        sourceChannel: "WEB_ADMIN",
      }) as {
        idempotent?: boolean;
        movement?: { id: number; qtyBefore?: number | null; qtyAfter?: number | null };
        stockStatus?: string;
        balances?: { warehouseQtyNumeric?: number | null };
      };

      const movementId = result.movement?.id;
      if (!movementId) {
        throw new Error(
          lang === "id"
            ? "Operasi belum dikonfirmasi — cek koneksi."
            : "لم يتم تأكيد العملية — تحقق من الاتصال وحاول مجدداً.",
        );
      }

      const qtyBefore = result.movement?.qtyBefore ?? selected.warehouseQtyNumeric;
      const qtyAfter =
        result.movement?.qtyAfter ??
        result.balances?.warehouseQtyNumeric ??
        (qtyBefore != null && qtyNum != null ? qtyBefore - qtyNum : null);
      const unit = selected.baseUnit || "";
      const status = result.stockStatus ?? selected.stockStatus;

      let msg =
        lang === "id"
          ? `Berhasil keluar ${qtyRaw} ${unit} dari ${selected.name}.`
          : `تم إخراج ${qtyRaw} ${unit} من ${selected.name} بنجاح.`;
      if (qtyBefore != null && qtyAfter != null) {
        msg +=
          lang === "id"
            ? `\nSaldo sebelum: ${qtyBefore} ${unit}\nSaldo sekarang: ${qtyAfter} ${unit}`
            : `\nالرصيد السابق: ${qtyBefore} ${unit}\nالرصيد الحالي: ${qtyAfter} ${unit}`;
      }
      if (status === "LOW_STOCK") {
        msg += lang === "id" ? "\n⚠️ Stok rendah." : "\n⚠️ المخزون أصبح منخفضاً.";
      }
      if (status === "OUT_OF_STOCK") {
        msg += lang === "id" ? "\n⚠️ Stok habis." : "\n⚠️ المنتج نفد من المستودع.";
      }

      setSuccess(msg);
      setQtyRaw("");
      setNotes("");
      setSelected(null);
      setPendingRequestId(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["v3-warehouse-out-moves"] }),
        qc.invalidateQueries({ queryKey: ["v3-warehouse"] }),
        qc.invalidateQueries({ queryKey: ["v3-stock-alerts-nav"] }),
        qc.invalidateQueries({ queryKey: ["v3-stock-alerts"] }),
      ]);
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
        title={lang === "id" ? "Keluar gudang" : "إخراج من المستودع"}
        description={
          lang === "id"
            ? "Admin: cari produk tanpa QR, keluarkan dari gudang."
            : "للأدمن: بحث يدوي عن المنتج وإخراج من المستودع (بدون QR)."
        }
      />
      <Flash message={flash} />
      {success ? (
        <div className="mb-4 whitespace-pre-line rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
          {success}
        </div>
      ) : null}

      <PageHint>
        {lang === "id"
          ? "Menggunakan layanan OUT canonical. Tidak menambah dapur."
          : "يستخدم خدمة الإخراج الموحّدة — لا يزيد المطبخ."}
      </PageHint>

      <FormSection title={lang === "id" ? "Cari produk" : "بحث عن المنتج"}>
        {!selected ? (
          <div className="grid gap-3">
            <TextInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={lang === "id" ? "mis. gula" : "مثلاً: سكر"}
              autoFocus
            />
            {search.trim().length >= 1 ? (
              <div className="divide-y divide-[hsl(var(--border)/.5)] rounded-xl border border-[hsl(var(--border))]">
                {(searchQuery.data?.rows ?? []).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => pickProduct(row)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start hover:bg-[hsl(var(--muted)/.5)]"
                  >
                    <div>
                      <div className="font-semibold">{row.name}</div>
                      <div className="text-xs text-[hsl(var(--muted-foreground))]">
                        {row.warehouseQtyNumeric != null ? `${row.warehouseQtyNumeric} ${row.baseUnit || ""}` : "؟"}
                      </div>
                    </div>
                    <StatusBadge tone={statusTone(row.stockStatus)}>
                      {statusLabel(lang, row.stockStatus)}
                    </StatusBadge>
                  </button>
                ))}
                {!searchQuery.isLoading && !(searchQuery.data?.rows?.length) ? (
                  <div className="px-4 py-6 text-sm text-[hsl(var(--muted-foreground))]">
                    {lang === "id" ? "Tidak ada hasil." : "لا نتائج."}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-bold">{selected.name}</div>
                <div className="mt-1">
                  <StatusBadge tone={statusTone(selected.stockStatus)}>
                    {statusLabel(lang, selected.stockStatus)}
                  </StatusBadge>
                </div>
              </div>
              <SecondaryButton type="button" onClick={clearSelection}>
                {lang === "id" ? "Ganti" : "تغيير"}
              </SecondaryButton>
            </div>

            <StockBanner
              lang={lang}
              label={lang === "id" ? "Saldo gudang" : "الرصيد الحالي"}
              value={selected.warehouseQtyNumeric}
              unknown={stockUnknown}
            />

            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <span className="text-[hsl(var(--muted-foreground))]">
                  {lang === "id" ? "Satuan" : "الوحدة"}:{" "}
                </span>
                <span className="font-semibold">{selected.baseUnit || "—"}</span>
              </div>
              <div>
                <span className="text-[hsl(var(--muted-foreground))]">
                  {lang === "id" ? "Minimum" : "الحد الأدنى"}:{" "}
                </span>
                <span className="font-semibold">
                  {selected.minimumStock != null ? `${selected.minimumStock} ${selected.baseUnit || ""}` : "—"}
                </span>
              </div>
            </div>

            {reviewBlocked ? (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                {lang === "id"
                  ? "Produk butuh review — OUT diblokir."
                  : "المنتج يحتاج مراجعة — الإخراج محظور."}
              </div>
            ) : null}
            {overStock ? (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
                {lang === "id"
                  ? `Hanya ${selected.warehouseQtyNumeric} ${selected.baseUnit || ""} tersedia.`
                  : `الكمية المتاحة في المستودع هي ${selected.warehouseQtyNumeric} ${selected.baseUnit || ""} فقط`}
              </div>
            ) : null}

            <FormField label={lang === "id" ? "Qty keluar" : "الكمية المراد إخراجها"} required>
              <TextInput value={qtyRaw} onChange={(e) => setQtyRaw(e.target.value)} />
            </FormField>
            <FormField label={lang === "id" ? "Catatan / alasan" : "ملاحظة / سبب"}>
              <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
            <div>
              <PrimaryButton type="button" disabled={!canConfirm} onClick={() => void confirmOut()}>
                {saving ? "…" : (lang === "id" ? "Konfirmasi keluar" : "تأكيد الإخراج")}
              </PrimaryButton>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title={lang === "id" ? "Riwayat keluar gudang" : "سجل الإخراج من المستودع"}>
        <div className="overflow-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="pb-2 text-start">{lang === "id" ? "Tanggal" : "التاريخ"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Produk" : "المنتج"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Qty" : "الكمية"}</th>
                <th className="pb-2 text-start">{lang === "id" ? "Catatan" : "ملاحظة"}</th>
              </tr>
            </thead>
            <tbody>
              {(moves.data?.rows ?? []).map((r) => (
                <tr key={String(r.id)} className="border-b border-[hsl(var(--border)/.5)]">
                  <td className="py-2 font-mono text-xs">{String(r.movementDate)}</td>
                  <td className="py-2 font-semibold">{String(r.itemName)}</td>
                  <td className="py-2 font-mono">{String(r.quantityRaw)} {String(r.unitRaw || "")}</td>
                  <td className="py-2 text-xs text-[hsl(var(--muted-foreground))]">{String(r.notes || "—")}</td>
                </tr>
              ))}
              {!moves.data?.rows?.length && !moves.isLoading ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState message={lang === "id" ? "Belum ada keluar gudang." : "لا إخراجات من المستودع بعد."} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </FormSection>
    </div>
  );
}
