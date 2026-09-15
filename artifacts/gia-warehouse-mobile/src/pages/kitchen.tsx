import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  assertCommitted,
  getProductById,
  newClientRequestId,
  postToKitchen,
  searchProducts,
  statusLabel,
} from "@/lib/api";
import { getStoredUser, isAdmin } from "@/lib/auth";
import {
  computeStockStatus,
  FlashBanner,
  LoadingSpinner,
  NotesField,
  parseQty,
  QtyField,
  Screen,
  StatusBadge,
} from "@/components/ui";

function sourceChannel(source: string | null, admin: boolean): string {
  if (admin && (source === "admin" || !source)) return "MOBILE_ADMIN";
  return "MOBILE_SEARCH";
}

export function KitchenTransferPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const itemId = Number(params.get("itemId"));
  const source = params.get("source");
  const user = getStoredUser();
  const admin = isAdmin(user?.role);
  const [pickQ, setPickQ] = useState("");
  const [debouncedPick, setDebouncedPick] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedPick(pickQ.trim()), 300);
    return () => clearTimeout(t);
  }, [pickQ]);

  const pickSearch = useQuery({
    queryKey: ["kitchen-pick", debouncedPick],
    queryFn: () => searchProducts(debouncedPick),
    enabled: (!Number.isFinite(itemId) || itemId <= 0) && debouncedPick.length >= 1,
  });

  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [flash, setFlash] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const [clientRequestId, setClientRequestId] = useState<string | null>(null);
  const [resultInfo, setResultInfo] = useState<{ before: string; after: string; warn?: string } | null>(null);

  const product = useQuery({
    queryKey: ["product", itemId],
    queryFn: () => getProductById(itemId),
    enabled: Number.isFinite(itemId) && itemId > 0,
  });

  const detail = product.data;
  const qtyNum = parseQty(qty);
  const stockStatus = detail
    ? detail.stockStatus && detail.stockStatus !== "NORMAL"
      ? detail.stockStatus
      : computeStockStatus(detail.warehouseQtyNumeric, detail.minimumStock)
    : "NORMAL";

  const stockUnknown = detail != null && detail.warehouseQtyNumeric == null;
  const reviewBlocked = stockStatus === "REVIEW_REQUIRED";
  const overStock =
    detail?.warehouseQtyNumeric != null && qtyNum != null && qtyNum > detail.warehouseQtyNumeric + 1e-9;

  const canConfirm = useMemo(
    () =>
      detail != null &&
      qty.trim() !== "" &&
      qtyNum != null &&
      qtyNum > 0 &&
      !stockUnknown &&
      !reviewBlocked &&
      !overStock &&
      !pending &&
      !resultInfo,
    [detail, qty, qtyNum, stockUnknown, reviewBlocked, overStock, pending, resultInfo],
  );

  async function confirm() {
    if (!detail || !canConfirm) return;
    const reqId = clientRequestId ?? newClientRequestId();
    if (!clientRequestId) setClientRequestId(reqId);
    setPending(true);
    setFlash("");
    setSuccess("");
    try {
      const result = await postToKitchen({
        inventoryItemId: detail.id,
        quantityRaw: qty,
        quantityNumeric: qtyNum,
        unitRaw: detail.baseUnit || undefined,
        notes: notes.trim() || undefined,
        clientRequestId: reqId,
        sourceChannel: sourceChannel(source, admin),
      });
      assertCommitted(result);
      const before = result.movement?.qtyBefore;
      const after = result.movement?.qtyAfter ?? result.balances?.warehouseQtyNumeric;
      let warn: string | undefined;
      const st = result.stockStatus ?? stockStatus;
      if (st === "LOW_STOCK") warn = "تحذير: المخزون أصبح منخفضاً.";
      if (st === "OUT_OF_STOCK") warn = "تحذير: المخزون نفد.";
      setResultInfo({
        before: before == null ? "—" : String(before),
        after: after == null ? "—" : String(after),
        warn,
      });
      setSuccess("تم التحويل للمطبخ بنجاح.");
      setClientRequestId(null);
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل التحويل");
    } finally {
      setPending(false);
    }
  }

  const backTo = Number.isFinite(itemId) && itemId > 0 ? `/product/${itemId}` : "/";

  if (!Number.isFinite(itemId) || itemId <= 0) {
    return (
      <Screen title="تحويل للمطبخ" backTo="/">
        <p className="mb-3 text-sm text-[hsl(var(--muted-foreground))]">اختر منتجاً للتحويل</p>
        <input
          className="input-lg mb-3"
          placeholder="بحث..."
          value={pickQ}
          onChange={(e) => setPickQ(e.target.value)}
        />
        <div className="space-y-2">
          {(pickSearch.data?.rows ?? []).map((row) => (
            <button
              key={row.id}
              type="button"
              className="card w-full text-start"
              onClick={() => navigate(`/kitchen?itemId=${row.id}&source=${source || "search"}`)}
            >
              <div className="font-bold">{row.name}</div>
              <div className="text-sm text-[hsl(var(--muted-foreground))]">
                {row.warehouseQtyNumeric ?? "—"} {row.baseUnit}
              </div>
            </button>
          ))}
        </div>
        <Link href="/search" className="btn-lg btn-secondary mt-4">
          بحث متقدم
        </Link>
      </Screen>
    );
  }

  if (product.isLoading) {
    return (
      <Screen title="تحويل للمطبخ" backTo={backTo}>
        <LoadingSpinner />
      </Screen>
    );
  }

  if (product.error || !detail) {
    return (
      <Screen title="تحويل للمطبخ" backTo="/search">
        <FlashBanner message={product.error instanceof Error ? product.error.message : "المنتج غير موجود"} />
      </Screen>
    );
  }

  return (
    <Screen title="تحويل للمطبخ" backTo={backTo}>
      <FlashBanner message={flash} onDismiss={() => setFlash("")} />
      {success ? <FlashBanner message={success} tone="ok" /> : null}
      {resultInfo?.warn ? <FlashBanner message={resultInfo.warn} tone="warn" /> : null}

      <div className="card mb-4">
        <div className="mb-2 font-extrabold">{detail.name}</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-[hsl(var(--muted-foreground))]">
            الرصيد: {detail.warehouseQtyNumeric == null ? "—" : detail.warehouseQtyNumeric} {detail.baseUnit}
          </span>
          <StatusBadge status={stockStatus} label={statusLabel(stockStatus)} />
        </div>
      </div>

      {stockUnknown ? (
        <FlashBanner message="الرصيد غير معروف — لا يمكن التحويل." />
      ) : reviewBlocked ? (
        <FlashBanner message="المنتج يحتاج مراجعة." />
      ) : overStock ? (
        <FlashBanner message="الكمية أكبر من الرصيد." />
      ) : null}

      {resultInfo ? (
        <div className="card mb-4 text-center">
          <div className="text-sm text-[hsl(var(--muted-foreground))]">قبل → بعد</div>
          <div className="mt-1 text-2xl font-extrabold">
            {resultInfo.before} → {resultInfo.after}
          </div>
          <Link href={`/product/${itemId}`} className="btn-lg btn-primary mt-4">
            العودة للمنتج
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <QtyField label="الكمية" value={qty} onChange={setQty} unit={detail.baseUnit} />
          <NotesField value={notes} onChange={setNotes} />
          <button type="button" className="btn-lg btn-primary" disabled={!canConfirm} onClick={confirm}>
            {pending ? "جاري التأكيد..." : "تأكيد التحويل"}
          </button>
        </div>
      )}
    </Screen>
  );
}
