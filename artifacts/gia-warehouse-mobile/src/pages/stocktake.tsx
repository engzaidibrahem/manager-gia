import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  addStocktakeProduct,
  completeStocktake,
  getStocktakeProgress,
  countStatusLabel,
  listStocktakes,
  startStocktake,
} from "@/lib/api";
import {
  BigAction,
  EmptyState,
  FlashBanner,
  LoadingSpinner,
  Screen,
} from "@/components/ui";

type Filter = "all" | "remaining" | "counted" | "differences";

export function StocktakeHubPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [flash, setFlash] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("remaining");
  const [searchQ, setSearchQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newQty, setNewQty] = useState("");
  const [starting, setStarting] = useState(false);
  const [completing, setCompleting] = useState(false);

  const list = useQuery({
    queryKey: ["stocktakes"],
    queryFn: () => listStocktakes(),
  });

  useEffect(() => {
    const open = (list.data?.rows ?? []).find((r) => r.status === "DRAFT" || r.status === "IN_PROGRESS");
    if (open) setActiveId(open.id);
  }, [list.data]);

  const progress = useQuery({
    queryKey: ["stocktake-progress", activeId],
    queryFn: () => getStocktakeProgress(activeId!),
    enabled: activeId != null,
    refetchInterval: 15_000,
  });

  const filteredLines = useMemo(() => {
    const lines = progress.data?.lines ?? [];
    const needle = searchQ.trim().toLowerCase();
    return lines.filter((line) => {
      if (needle && !line.itemName.toLowerCase().includes(needle)) return false;
      if (filter === "remaining") return line.countStatus === "NOT_COUNTED";
      if (filter === "counted") return line.countStatus === "COUNTED";
      if (filter === "differences") return line.difference != null && line.difference !== 0;
      return true;
    });
  }, [progress.data, filter, searchQ]);

  async function handleStart() {
    setStarting(true);
    setFlash("");
    try {
      const r = await startStocktake({ clientRequestId: `st-${Date.now()}` });
      setActiveId(r.stocktake.id);
      qc.invalidateQueries({ queryKey: ["stocktakes"] });
      qc.invalidateQueries({ queryKey: ["stocktake-progress", r.stocktake.id] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل بدء الجرد");
    } finally {
      setStarting(false);
    }
  }

  async function handleComplete() {
    if (!activeId || !progress.data) return;
    if (progress.data.remainingProducts > 0) {
      setFlash(
        `لا يمكن اعتماد الجرد. يوجد ${progress.data.remainingProducts} مواد لم يتم جردها.`,
      );
      setFilter("remaining");
      return;
    }
    const ok = window.confirm(
      `اعتماد الجرد؟\nإجمالي: ${progress.data.totalProducts}\nتم الجرد: ${progress.data.countedProducts}\nاختلافات: ${progress.data.differencesCount}\nمواد جديدة: ${progress.data.newProducts}`,
    );
    if (!ok) return;
    setCompleting(true);
    setFlash("");
    try {
      await completeStocktake(activeId);
      setFlash("تم اعتماد الجرد بنجاح.");
      setActiveId(null);
      qc.invalidateQueries({ queryKey: ["stocktakes"] });
      qc.invalidateQueries({ queryKey: ["stocktake-progress", activeId] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل الاعتماد");
    } finally {
      setCompleting(false);
    }
  }

  async function handleAddProduct() {
    if (!activeId || !newName.trim()) return;
    setFlash("");
    try {
      await addStocktakeProduct(activeId, {
        name: newName.trim(),
        baseUnit: newUnit.trim() || undefined,
        countedQuantity: Number(newQty),
      });
      setNewName("");
      setNewUnit("");
      setNewQty("");
      setShowAdd(false);
      qc.invalidateQueries({ queryKey: ["stocktake-progress", activeId] });
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل الإضافة");
    }
  }

  function goCount(itemId: number) {
    if (!activeId) return;
    navigate(`/stocktake/${activeId}/count/${itemId}`);
  }

  const p = progress.data;

  return (
    <Screen title="جرد المستودع" backTo="/">
      <FlashBanner message={flash} onDismiss={() => setFlash("")} tone={flash.includes("تم") ? "ok" : "danger"} />

      {!activeId ? (
        <div className="space-y-4">
          {list.isLoading ? (
            <LoadingSpinner />
          ) : (
            <>
              <EmptyState message="لا توجد جلسة جرد مفتوحة — الجرد الحقيقي يبدأ بالبحث اليدوي (بدون QR إلزامي)" />
              <button type="button" className="btn-lg btn-primary" disabled={starting} onClick={handleStart}>
                {starting ? "جاري البدء..." : "بدء جرد جديد"}
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mb-3 rounded-xl border border-[hsl(var(--ok)/0.3)] bg-[hsl(var(--ok)/0.08)] px-4 py-3 text-sm font-bold text-[hsl(var(--ok))]">
            يوجد جرد غير مكتمل — يمكنك المتابعة من أي جهاز بعد تسجيل الدخول
          </div>
          <div className="card mb-4">
            <div className="mb-2 text-sm font-bold">جلسة #{activeId} · {p?.status ?? "..."}</div>
            {p ? (
              <>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div>
                    <div className="text-lg font-extrabold">{p.totalProducts}</div>
                    <div className="text-[hsl(var(--muted-foreground))]">إجمالي</div>
                  </div>
                  <div>
                    <div className="text-lg font-extrabold">{p.countedProducts}</div>
                    <div className="text-[hsl(var(--muted-foreground))]">تم الجرد</div>
                  </div>
                  <div>
                    <div className="text-lg font-extrabold text-[hsl(var(--warn))]">{p.remainingProducts}</div>
                    <div className="text-[hsl(var(--muted-foreground))]">متبقي</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
                  <div>
                    <div className="font-extrabold">{p.differencesCount}</div>
                    <div className="text-[hsl(var(--muted-foreground))]">اختلافات</div>
                  </div>
                  <div>
                    <div className="font-extrabold">{p.newProducts}</div>
                    <div className="text-[hsl(var(--muted-foreground))]">مواد جديدة</div>
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                  <div
                    className="h-full rounded-full bg-[hsl(var(--primary))] transition-all"
                    style={{
                      width: `${p.totalProducts ? Math.round((p.countedProducts / p.totalProducts) * 100) : 0}%`,
                    }}
                  />
                </div>
              </>
            ) : (
              <LoadingSpinner label="تحميل التقدم..." />
            )}
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <BigAction href="/search" title="بحث" subtitle="عن منتج" tone="secondary" />
            <BigAction href="/scan" title="مسح QR" subtitle="إضافة سريعة" tone="secondary" />
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            {(["remaining", "all", "counted", "differences"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                  filter === f
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
                }`}
                onClick={() => setFilter(f)}
              >
                {f === "remaining"
                  ? "المتبقي"
                  : f === "counted"
                    ? "تم الجرد"
                    : f === "differences"
                      ? "اختلافات"
                      : "الكل"}
              </button>
            ))}
          </div>

          <input
            className="input-lg mb-3"
            placeholder="بحث في قائمة الجرد..."
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />

          <button type="button" className="btn-lg btn-secondary mb-3" onClick={() => setShowAdd(true)}>
            + إضافة منتج للجرد
          </button>

          {progress.isLoading ? (
            <LoadingSpinner />
          ) : filteredLines.length === 0 ? (
            <EmptyState message="لا توجد بنود في هذا الفلتر" />
          ) : (
            <div className="space-y-2">
              {filteredLines.map((line) => (
                <button
                  key={line.inventoryItemId}
                  type="button"
                  className="card w-full text-start"
                  onClick={() => goCount(line.inventoryItemId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-extrabold">{line.itemName}</div>
                      <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                        نظام: {line.systemQuantityBefore ?? "—"} · فعلي: {line.countedQuantity ?? "—"}
                      </div>
                    </div>
                    <span className="text-xs font-bold">{countStatusLabel(line.countStatus)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {p && p.remainingProducts === 0 ? (
            <div className="card mt-4">
              <h2 className="mb-2 font-extrabold">ملخص الاعتماد</h2>
              <p className="mb-3 text-sm text-[hsl(var(--muted-foreground))]">
                {p.differencesCount} اختلاف · {p.countedProducts} منتج مجرد
              </p>
              <button
                type="button"
                className="btn-lg btn-primary"
                disabled={completing || !p.canComplete}
                onClick={handleComplete}
              >
                {completing ? "جاري الاعتماد..." : "اعتماد الجرد"}
              </button>
            </div>
          ) : p && p.remainingProducts > 0 ? (
            <p className="mt-4 text-center text-sm font-semibold text-[hsl(var(--warn))]">
              متبقي {p.remainingProducts} — أكمل الجرد قبل الاعتماد
            </p>
          ) : null}
        </>
      )}

      {showAdd ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40 p-4" onClick={() => setShowAdd(false)}>
          <div className="card w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 font-extrabold">إضافة منتج</h2>
            <div className="space-y-3">
              <input
                className="input-lg"
                placeholder="اسم المنتج"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className="input-lg"
                placeholder="الوحدة"
                value={newUnit}
                onChange={(e) => setNewUnit(e.target.value)}
              />
              <input
                className="input-lg"
                placeholder="الكمية الفعلية"
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                inputMode="decimal"
              />
              <button
                type="button"
                className="btn-lg btn-primary"
                disabled={!newName.trim() || newQty.trim() === "" || !Number.isFinite(Number(newQty))}
                onClick={handleAddProduct}
              >
                إضافة
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Screen>
  );
}
