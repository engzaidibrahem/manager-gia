import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import {
  getProductById,
  getStocktakeProgress,
  upsertStocktakeLine,
} from "@/lib/api";
import {
  FlashBanner,
  LoadingSpinner,
  NotesField,
  QtyField,
  Screen,
} from "@/components/ui";

export function StocktakeCountPage() {
  const [, params] = useRoute("/stocktake/:id/count/:itemId");
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const stocktakeId = Number(params?.id);
  const itemId = Number(params?.itemId);

  const [physicalQty, setPhysicalQty] = useState("");
  const [unit, setUnit] = useState("");
  const [minimum, setMinimum] = useState("");
  const [notes, setNotes] = useState("");
  const [flash, setFlash] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const progress = useQuery({
    queryKey: ["stocktake-progress", stocktakeId],
    queryFn: () => getStocktakeProgress(stocktakeId),
    enabled: Number.isFinite(stocktakeId) && stocktakeId > 0,
  });

  const line = progress.data?.lines.find((l) => l.inventoryItemId === itemId);

  useEffect(() => {
    if (!line) return;
    setUnit(line.itemUnit || "");
    setPhysicalQty(line.countedQuantity == null ? "" : String(line.countedQuantity));
    setNotes(line.notes || "");
    setSaved(false);
  }, [line?.inventoryItemId, line?.countedQuantity, line?.itemUnit, line?.notes]);

  const productMeta = useQuery({
    queryKey: ["product", itemId],
    queryFn: () => getProductById(itemId),
    enabled: Number.isFinite(itemId) && itemId > 0,
  });

  useEffect(() => {
    if (productMeta.data?.minimumStock != null) {
      setMinimum(String(productMeta.data.minimumStock));
    }
  }, [productMeta.data?.id, productMeta.data?.minimumStock]);

  async function save(andNext: boolean) {
    if (!line || physicalQty.trim() === "") {
      setFlash("أدخل الكمية الفعلية.");
      return;
    }
    const counted = Number(physicalQty);
    if (!Number.isFinite(counted)) {
      setFlash("كمية غير صالحة.");
      return;
    }

    setPending(true);
    setFlash("");
    setSaved(false);
    try {
      await upsertStocktakeLine(stocktakeId, itemId, {
        countedQuantity: counted,
        baseUnit: unit.trim() || line.itemUnit,
        minimumStock: minimum.trim() === "" ? undefined : Number(minimum),
        notes: notes.trim() || undefined,
      });
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ["stocktake-progress", stocktakeId] });

      if (andNext) {
        const refreshed = await getStocktakeProgress(stocktakeId);
        const nextId =
          refreshed.lines
            .slice(refreshed.lines.findIndex((l) => l.inventoryItemId === itemId) + 1)
            .find((l) => l.countStatus === "NOT_COUNTED")?.inventoryItemId ??
          refreshed.lines.find((l) => l.countStatus === "NOT_COUNTED" && l.inventoryItemId !== itemId)
            ?.inventoryItemId ??
          null;

        if (nextId) {
          navigate(`/stocktake/${stocktakeId}/count/${nextId}`);
          setPhysicalQty("");
          setNotes("");
          setSaved(false);
        } else {
          navigate("/stocktake");
        }
      }
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "فشل الحفظ");
    } finally {
      setPending(false);
    }
  }

  if (!Number.isFinite(stocktakeId) || !Number.isFinite(itemId)) {
    return (
      <Screen title="عدّ سريع" backTo="/stocktake">
        <FlashBanner message="رابط غير صالح." />
      </Screen>
    );
  }

  if (progress.isLoading) {
    return (
      <Screen title="عدّ سريع" backTo="/stocktake">
        <LoadingSpinner />
      </Screen>
    );
  }

  if (!line) {
    return (
      <Screen title="عدّ سريع" backTo="/stocktake">
        <FlashBanner message="البند غير موجود في الجرد." />
      </Screen>
    );
  }

  return (
    <Screen title={line.itemName} backTo="/stocktake">
      <FlashBanner message={flash} onDismiss={() => setFlash("")} />
      {saved ? <FlashBanner message="تم الحفظ على الخادم" tone="ok" /> : null}

      <div className="card mb-4">
        <div className="text-sm text-[hsl(var(--muted-foreground))]">في النظام</div>
        <div className="text-3xl font-extrabold">
          {line.systemQuantityBefore == null ? "—" : line.systemQuantityBefore}
        </div>
      </div>

      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-bold">الوحدة</span>
          <input className="input-lg" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </label>

        <QtyField
          label="الكمية الفعلية"
          value={physicalQty}
          onChange={setPhysicalQty}
          unit={unit}
        />

        <label className="block">
          <span className="mb-2 block text-sm font-bold">الحد الأدنى</span>
          <input
            className="input-lg"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
            inputMode="decimal"
            placeholder="اختياري"
          />
        </label>

        <NotesField value={notes} onChange={setNotes} />

        <button
          type="button"
          className="btn-lg btn-primary"
          disabled={pending}
          onClick={() => save(true)}
        >
          {pending ? "جاري الحفظ..." : "حفظ والتالي"}
        </button>
        <button
          type="button"
          className="btn-lg btn-secondary"
          disabled={pending}
          onClick={() => save(false)}
        >
          حفظ فقط
        </button>
      </div>
    </Screen>
  );
}
