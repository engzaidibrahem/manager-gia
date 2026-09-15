import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { createProduct, listProducts, searchProducts, statusLabel } from "@/lib/api";
import { FlashBanner, LoadingSpinner, Screen, StatusBadge } from "@/components/ui";

export function ProductsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [minimum, setMinimum] = useState("");
  const [flash, setFlash] = useState("");
  const [matchWarning, setMatchWarning] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery({
    queryKey: ["products-list", debounced],
    queryFn: async () => {
      if (debounced) return searchProducts(debounced, 30);
      return listProducts({ pageSize: 30 });
    },
  });

  type ListRow = {
    id: number;
    name: string;
    baseUnit: string;
    warehouseQtyNumeric?: number | null;
    stockStatus?: string;
  };

  const rows: ListRow[] = list.data?.rows ?? [];

  async function checkMatches() {
    if (!name.trim()) {
      setMatchWarning("");
      return;
    }
    try {
      const res = await searchProducts(name.trim(), 5);
      const exact = res.rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
      if (exact) {
        setMatchWarning(`منتج موجود بنفس الاسم — افتح «${exact.name}» بدلاً من الإنشاء.`);
      } else if (res.rows.length) {
        setMatchWarning(`تطابقات محتملة: ${res.rows.slice(0, 3).map((r) => r.name).join("، ")}`);
      } else {
        setMatchWarning("");
      }
    } catch {
      setMatchWarning("");
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim()) {
      setFlash("الاسم والوحدة مطلوبان.");
      return;
    }
    setCreating(true);
    setFlash("");
    try {
      const p = await createProduct({
        name: name.trim(),
        baseUnit: unit.trim(),
        minimumStock: minimum.trim() === "" ? undefined : Number(minimum),
      });
      setName("");
      setUnit("");
      setMinimum("");
      setMatchWarning("");
      qc.invalidateQueries({ queryKey: ["products-list"] });
      setFlash(`تم إنشاء «${p.name}»`);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : "فشل الإنشاء");
    } finally {
      setCreating(false);
    }
  }


  return (
    <Screen title="المنتجات" backTo="/">
      <Link href="/qr-labels" className="btn-lg btn-secondary mb-4">
        ملصقات QR
      </Link>

      <FlashBanner message={flash} onDismiss={() => setFlash("")} tone={flash.includes("تم") ? "ok" : "danger"} />
      {matchWarning ? <FlashBanner message={matchWarning} tone="warn" /> : null}

      <input
        className="input-lg mb-4"
        placeholder="بحث في القائمة..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {list.isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <div className="card py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">لا توجد منتجات</div>
      ) : (
        <div className="mb-6 space-y-2">
          {rows.map((row) => (
            <Link key={row.id} href={`/product/${row.id}`} className="card block">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-extrabold">{row.name}</div>
                  <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {row.warehouseQtyNumeric == null ? "—" : row.warehouseQtyNumeric} {row.baseUnit}
                  </div>
                </div>
                <StatusBadge
                  status={row.stockStatus ?? "NORMAL"}
                  label={statusLabel(row.stockStatus ?? "NORMAL")}
                />
              </div>
            </Link>
          ))}
        </div>
      )}

      <form onSubmit={create} className="card space-y-3">
        <h2 className="text-sm font-extrabold">إنشاء منتج</h2>
        <label className="block">
          <span className="mb-2 block text-sm font-bold">الاسم *</span>
          <input className="input-lg" value={name} onChange={(e) => setName(e.target.value)} onBlur={checkMatches} />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-bold">الوحدة *</span>
          <input className="input-lg" value={unit} onChange={(e) => setUnit(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-bold">الحد الأدنى</span>
          <input className="input-lg" value={minimum} onChange={(e) => setMinimum(e.target.value)} inputMode="decimal" />
        </label>
        <button type="submit" className="btn-lg btn-primary" disabled={creating}>
          {creating ? "جاري الإنشاء..." : "إنشاء"}
        </button>
      </form>
    </Screen>
  );
}
