import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { getStockAlerts, statusLabel } from "@/lib/api";
import { EmptyState, FlashBanner, LoadingSpinner, Screen, StatusBadge } from "@/components/ui";

type AlertRow = Record<string, unknown>;

function rowId(row: AlertRow): number {
  return Number(row.id ?? row.inventoryItemId ?? 0);
}

function rowName(row: AlertRow): string {
  return String(row.name ?? row.itemName ?? "—");
}

function rowQty(row: AlertRow): string {
  const q = row.warehouseQtyNumeric ?? row.qty;
  return q == null ? "—" : String(q);
}

function rowUnit(row: AlertRow): string {
  return String(row.baseUnit ?? row.unit ?? "");
}

function rowStatus(row: AlertRow): string {
  return String(row.stockStatus ?? row.status ?? "REVIEW_REQUIRED");
}

function AlertSection({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: AlertRow[];
  tone: "danger" | "warn" | "review";
}) {
  if (!rows.length) return null;
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-extrabold">{title}</h2>
      <div className="space-y-2">
        {rows.map((row) => {
          const id = rowId(row);
          return (
            <Link key={id} href={`/product/${id}`} className="card block">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{rowName(row)}</div>
                  <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                    {rowQty(row)} {rowUnit(row)}
                  </div>
                </div>
                <StatusBadge status={rowStatus(row)} label={statusLabel(rowStatus(row))} />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export function AlertsPage() {
  const alerts = useQuery({
    queryKey: ["stock-alerts"],
    queryFn: getStockAlerts,
  });

  return (
    <Screen title="تنبيهات المخزون" backTo="/">
      {alerts.error ? (
        <FlashBanner message={alerts.error instanceof Error ? alerts.error.message : "حدث خطأ"} />
      ) : null}

      {alerts.isLoading ? (
        <LoadingSpinner />
      ) : !alerts.data ? (
        <EmptyState message="لا توجد بيانات" />
      ) : alerts.data.summary.alertCount === 0 ? (
        <EmptyState message="لا توجد تنبيهات حالياً" />
      ) : (
        <>
          <AlertSection title="نفد المخزون" rows={alerts.data.outOfStock} tone="danger" />
          <AlertSection title="مخزون منخفض" rows={alerts.data.lowStock} tone="warn" />
          <AlertSection title="يحتاج مراجعة" rows={alerts.data.reviewRequired} tone="review" />
        </>
      )}
    </Screen>
  );
}
