import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute, useSearch } from "wouter";
import {
  ensureProductQr,
  getProductById,
  listMovements,
  qrImgUrl,
  statusLabel,
  updateProduct,
} from "@/lib/api";
import { isAdmin, getStoredUser } from "@/lib/auth";
import {
  BigAction,
  computeStockStatus,
  FlashBanner,
  LoadingSpinner,
  Screen,
  StatusBadge,
} from "@/components/ui";

export function ProductPage() {
  const [, params] = useRoute("/product/:id");
  const search = useSearch();
  const qc = useQueryClient();
  const id = Number(params?.id);
  const from = new URLSearchParams(search).get("from") || "search";
  const user = getStoredUser();
  const admin = isAdmin(user?.role);

  const [flash, setFlash] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editUnit, setEditUnit] = useState("");
  const [editMin, setEditMin] = useState("");
  const [saving, setSaving] = useState(false);

  const product = useQuery({
    queryKey: ["product", id],
    queryFn: () => getProductById(id),
    enabled: Number.isFinite(id) && id > 0,
  });

  const movements = useQuery({
    queryKey: ["product-movements", id],
    queryFn: () => listMovements({ itemId: id, pageSize: 10 }),
    enabled: admin && Number.isFinite(id),
  });

  const detail = product.data;
  const stockStatus = useMemo(() => {
    if (!detail) return "NORMAL";
    if (detail.stockStatus && detail.stockStatus !== "NORMAL") return detail.stockStatus;
    return computeStockStatus(detail.warehouseQtyNumeric, detail.minimumStock);
  }, [detail]);

  const sourceParam = from === "qr" ? "qr" : "search";
  const outHref = `/out?itemId=${id}&source=${admin && from !== "qr" && from !== "search" ? "admin" : sourceParam}`;
  const kitchenHref = `/kitchen?itemId=${id}&source=${admin ? "admin" : "search"}`;

  async function startEdit() {
    if (!detail) return;
    setEditName(detail.name);
    setEditUnit(detail.baseUnit);
    setEditMin(detail.minimumStock == null ? "" : String(detail.minimumStock));
    setEditing(true);
  }

  async function saveEdit() {
    if (!detail) return;
    setSaving(true);
    setFlash("");
    try {
      await updateProduct(id, {
        name: editName.trim(),
        baseUnit: editUnit.trim(),
        minimumStock: editMin.trim() === "" ? null : Number(editMin),
      });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["product", id] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function ensureQr() {
    setFlash("");
    try {
      await ensureProductQr(id);
      qc.invalidateQueries({ queryKey: ["product", id] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل إنشاء QR");
    }
  }

  if (product.isLoading) {
    return (
      <Screen title="المنتج" backTo="/search">
        <LoadingSpinner />
      </Screen>
    );
  }

  if (product.error || !detail) {
    return (
      <Screen title="المنتج" backTo="/search">
        <FlashBanner message={product.error instanceof Error ? product.error.message : "المنتج غير موجود"} />
      </Screen>
    );
  }

  return (
    <Screen title={detail.name} backTo={from === "qr" ? "/scan" : "/search"}>
      <FlashBanner message={flash} onDismiss={() => setFlash("")} />

      <div className="card mb-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <StatusBadge status={stockStatus} label={statusLabel(stockStatus)} />
          {detail.shortCode ? (
            <span className="text-xs font-bold text-[hsl(var(--muted-foreground))]">{detail.shortCode}</span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[hsl(var(--muted-foreground))]">الرصيد</div>
            <div className="text-xl font-extrabold">
              {detail.warehouseQtyNumeric == null ? "—" : detail.warehouseQtyNumeric}
            </div>
          </div>
          <div>
            <div className="text-[hsl(var(--muted-foreground))]">الوحدة</div>
            <div className="text-xl font-extrabold">{detail.baseUnit || "—"}</div>
          </div>
          <div>
            <div className="text-[hsl(var(--muted-foreground))]">الحد الأدنى</div>
            <div className="font-bold">{detail.minimumStock ?? "—"}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        <BigAction href={outHref} title="إخراج" subtitle="صرف من المستودع" />
        {admin ? <BigAction href={`/in?itemId=${id}`} title="إدخال" subtitle="استلام للمستودع" tone="secondary" /> : null}
        <BigAction href={kitchenHref} title="تحويل للمطبخ" subtitle="صرف للمطبخ" tone={admin ? "primary" : "secondary"} />
        {admin ? (
          <>
            <BigAction href={`/movements?itemId=${id}`} title="الحركات" subtitle="آخر العمليات" tone="secondary" />
            <button type="button" className="btn-lg btn-secondary" onClick={startEdit}>
              تعديل البيانات
            </button>
          </>
        ) : null}
      </div>

      {editing ? (
        <div className="card mt-4 space-y-3">
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الاسم</span>
            <input className="input-lg" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الوحدة</span>
            <input className="input-lg" value={editUnit} onChange={(e) => setEditUnit(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-2 block text-sm font-bold">الحد الأدنى</span>
            <input className="input-lg" value={editMin} onChange={(e) => setEditMin(e.target.value)} inputMode="decimal" />
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn-lg btn-primary flex-1" disabled={saving} onClick={saveEdit}>
              حفظ
            </button>
            <button type="button" className="btn-lg btn-secondary flex-1" onClick={() => setEditing(false)}>
              إلغاء
            </button>
          </div>
        </div>
      ) : null}

      <div className="card mt-4 text-center">
        <p className="mb-3 text-sm font-bold">رمز QR</p>
        {detail.qrToken ? (
          <img src={qrImgUrl(detail.qrToken, 180)} alt="QR" className="mx-auto rounded-lg border border-[hsl(var(--border))]" />
        ) : (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">لا يوجد رمز</p>
        )}
        {admin && !detail.qrToken ? (
          <button type="button" className="btn-lg btn-secondary mt-3" onClick={ensureQr}>
            إنشاء QR
          </button>
        ) : null}
      </div>

      {admin && movements.data?.rows.length ? (
        <div className="mt-4 space-y-2">
          <h2 className="text-sm font-bold">آخر الحركات</h2>
          {movements.data.rows.slice(0, 5).map((m) => (
            <div key={String(m.id)} className="card text-xs">
              {String(m.movementType ?? m.type ?? "—")} · {String(m.quantityNumeric ?? m.quantityRaw ?? "—")}
            </div>
          ))}
          <Link href={`/movements?itemId=${id}`} className="block text-center text-sm font-bold text-[hsl(var(--primary))]">
            عرض الكل
          </Link>
        </div>
      ) : null}
    </Screen>
  );
}
