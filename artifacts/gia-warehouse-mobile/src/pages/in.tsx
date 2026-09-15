import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import {
  assertCommitted,
  createProduct,
  getProductById,
  newClientRequestId,
  postWarehouseIn,
  searchProducts,
  statusLabel,
} from "@/lib/api";
import {
  FlashBanner,
  LoadingSpinner,
  NotesField,
  parseQty,
  QtyField,
  Screen,
  StatusBadge,
} from "@/components/ui";

export function InPage() {
  const search = useSearch();
  const presetId = Number(new URLSearchParams(search).get("itemId"));

  const [mode, setMode] = useState<"search" | "create">("search");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(Number.isFinite(presetId) && presetId > 0 ? presetId : null);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newMin, setNewMin] = useState("");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [flash, setFlash] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const [matchWarning, setMatchWarning] = useState("");

  const searchQ = useQuery({
    queryKey: ["in-search", q],
    queryFn: () => searchProducts(q),
    enabled: mode === "search" && q.trim().length >= 1 && selectedId == null,
  });

  const product = useQuery({
    queryKey: ["product", selectedId],
    queryFn: () => getProductById(selectedId!),
    enabled: selectedId != null,
  });

  const qtyNum = parseQty(qty);
  const canConfirm = useMemo(() => {
    if (pending || success) return false;
    if (mode === "create") {
      return newName.trim() !== "" && newUnit.trim() !== "" && qtyNum != null && qtyNum > 0;
    }
    return selectedId != null && qtyNum != null && qtyNum > 0;
  }, [mode, newName, newUnit, qtyNum, selectedId, pending, success]);

  async function checkCreateMatches() {
    if (!newName.trim()) return;
    try {
      const res = await searchProducts(newName.trim(), 5);
      const hit = res.rows.find((r) => r.name.toLowerCase() === newName.trim().toLowerCase());
      if (hit) {
        setMatchWarning(`يوجد منتج مشابه: «${hit.name}» — يُفضّل اختياره بدلاً من الإنشاء.`);
      } else if (res.rows.length > 0) {
        setMatchWarning(`منتجات قريبة: ${res.rows.slice(0, 3).map((r) => r.name).join("، ")}`);
      } else {
        setMatchWarning("");
      }
    } catch {
      setMatchWarning("");
    }
  }

  async function confirm() {
    if (!canConfirm) return;
    setPending(true);
    setFlash("");
    try {
      let itemId = selectedId;
      if (mode === "create") {
        const created = await createProduct({
          name: newName.trim(),
          baseUnit: newUnit.trim(),
          minimumStock: newMin.trim() === "" ? undefined : Number(newMin),
        });
        itemId = created.id;
      }
      if (itemId == null) throw new Error("لم يُحدد المنتج.");

      const result = await postWarehouseIn({
        inventoryItemId: itemId,
        quantityRaw: qty,
        quantityNumeric: qtyNum,
        unitRaw: mode === "create" ? newUnit.trim() : product.data?.baseUnit,
        notes: notes.trim() || undefined,
        clientRequestId: newClientRequestId(),
        sourceChannel: "MOBILE_ADMIN",
      });
      assertCommitted(result);
      setSuccess(`تم الإدخال بنجاح — الرصيد: ${result.balances?.warehouseQtyNumeric ?? result.movement?.qtyAfter ?? "—"}`);
      setQty("");
      setNotes("");
      if (mode === "create") {
        setNewName("");
        setNewUnit("");
        setNewMin("");
        setMode("search");
      }
      setSelectedId(itemId);
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل الإدخال");
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen title="إدخال للمستودع" backTo="/">
      <FlashBanner message={flash} onDismiss={() => setFlash("")} />
      {success ? <FlashBanner message={success} tone="ok" /> : null}

      <div className="mb-4 flex gap-2">
        <button
          type="button"
          className={`btn-lg flex-1 ${mode === "search" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => {
            setMode("search");
            setMatchWarning("");
          }}
        >
          منتج موجود
        </button>
        <button
          type="button"
          className={`btn-lg flex-1 ${mode === "create" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => {
            setMode("create");
            setSelectedId(null);
          }}
        >
          منتج جديد
        </button>
      </div>

      {mode === "search" ? (
        <>
          {selectedId && product.data ? (
            <div className="card mb-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-extrabold">{product.data.name}</div>
                  <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {product.data.warehouseQtyNumeric ?? "—"} {product.data.baseUnit}
                  </div>
                </div>
                <StatusBadge status={product.data.stockStatus} label={statusLabel(product.data.stockStatus)} />
              </div>
              <button type="button" className="btn-lg btn-secondary mt-3" onClick={() => setSelectedId(null)}>
                تغيير المنتج
              </button>
            </div>
          ) : (
            <>
              <input
                className="input-lg mb-3"
                placeholder="بحث..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {searchQ.isLoading ? <LoadingSpinner /> : null}
              <div className="space-y-2">
                {(searchQ.data?.rows ?? []).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="card w-full text-start"
                    onClick={() => {
                      setSelectedId(row.id);
                      setQ("");
                    }}
                  >
                    <div className="font-bold">{row.name}</div>
                    <div className="text-sm text-[hsl(var(--muted-foreground))]">
                      {row.warehouseQtyNumeric ?? "—"} {row.baseUnit}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="card mb-4 space-y-3">
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الاسم *</span>
            <input
              className="input-lg"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={checkCreateMatches}
            />
          </label>
          {matchWarning ? <FlashBanner message={matchWarning} tone="warn" /> : null}
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الوحدة *</span>
            <input className="input-lg" value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الحد الأدنى</span>
            <input className="input-lg" value={newMin} onChange={(e) => setNewMin(e.target.value)} inputMode="decimal" />
          </label>
        </div>
      )}

      <div className="space-y-4">
        <QtyField
          label="الكمية"
          value={qty}
          onChange={setQty}
          unit={mode === "create" ? newUnit : product.data?.baseUnit}
        />
        <NotesField value={notes} onChange={setNotes} />
        <button type="button" className="btn-lg btn-primary" disabled={!canConfirm} onClick={confirm}>
          {pending ? "جاري الإدخال..." : "تأكيد الإدخال"}
        </button>
        {selectedId ? (
          <Link href={`/product/${selectedId}`} className="btn-lg btn-secondary">
            عرض المنتج
          </Link>
        ) : null}
      </div>
    </Screen>
  );
}
