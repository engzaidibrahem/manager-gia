import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { searchProducts, statusLabel } from "@/lib/api";
import { EmptyState, FlashBanner, LoadingSpinner, Screen, StatusBadge } from "@/components/ui";

export function SearchPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    queryKey: ["product-search", debounced],
    queryFn: () => searchProducts(debounced),
    enabled: debounced.length >= 1,
  });

  return (
    <Screen title="بحث عن منتج" backTo="/">
      <Link href="/scan" className="btn-lg btn-secondary mb-4">
        مسح QR
      </Link>

      <input
        className="input-lg mb-4"
        placeholder="اسم المنتج..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />

      {search.error ? (
        <FlashBanner message={search.error instanceof Error ? search.error.message : "حدث خطأ"} />
      ) : null}

      {!debounced ? (
        <EmptyState message="اكتب اسم المنتج للبحث" />
      ) : search.isLoading ? (
        <LoadingSpinner />
      ) : (search.data?.rows.length ?? 0) === 0 ? (
        <EmptyState message="لا توجد نتائج" />
      ) : (
        <div className="space-y-2">
          {search.data!.rows.map((row) => (
            <Link
              key={row.id}
              href={`/product/${row.id}?from=search`}
              className="card block transition active:scale-[0.99]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-extrabold">{row.name}</div>
                  <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {row.warehouseQtyNumeric == null ? "—" : row.warehouseQtyNumeric} {row.baseUnit}
                  </div>
                </div>
                <StatusBadge status={row.stockStatus} label={statusLabel(row.stockStatus)} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </Screen>
  );
}
