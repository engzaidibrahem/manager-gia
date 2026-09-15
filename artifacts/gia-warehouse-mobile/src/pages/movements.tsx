import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { channelLabel, listMovements, movementTypeLabel, todayISO } from "@/lib/api";
import { getStoredUser, isAdmin } from "@/lib/auth";
import { EmptyState, FlashBanner, LoadingSpinner, Screen } from "@/components/ui";

type MoveRow = Record<string, unknown>;

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

function MoveCard({ row }: { row: MoveRow }) {
  const itemId = Number(row.inventoryItemId ?? row.itemId ?? 0);
  const name = String(row.itemName ?? row.name ?? "—");
  const type = String(row.movementType ?? row.type ?? "—");
  const qty = row.quantityNumeric ?? row.quantityRaw ?? "—";
  const unit = row.unitRaw ?? row.baseUnit ?? "";
  const actor = String(row.actor ?? row.actorName ?? "—");
  const before = row.qtyBefore;
  const after = row.qtyAfter;
  const channel = channelLabel(row.sourceChannel as string | null);
  const moveDate = row.movementDate ?? row.createdAt ?? row.date;

  return (
    <div className="card text-sm">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {itemId > 0 ? (
            <Link href={`/product/${itemId}`} className="font-extrabold text-[hsl(var(--primary))]">
              {name}
            </Link>
          ) : (
            <span className="font-extrabold">{name}</span>
          )}
        </div>
        <span className="shrink-0 text-xs text-[hsl(var(--muted-foreground))]">{fmtDate(moveDate)}</span>
      </div>
      <div className="font-bold">{movementTypeLabel(type)}</div>
      <div className="mt-1 text-[hsl(var(--muted-foreground))]">
        الكمية: {String(qty)} {String(unit)}
      </div>
      <div className="mt-1 text-[hsl(var(--muted-foreground))]">
        {before != null || after != null ? (
          <>الرصيد: {before == null ? "—" : String(before)} → {after == null ? "—" : String(after)}</>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-xs">
        <span>{actor}</span>
        <span>{channel}</span>
      </div>
    </div>
  );
}

export function MovementsPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const itemId = params.get("itemId");
  const user = getStoredUser();
  const admin = isAdmin(user?.role);

  const queryParams: Record<string, string | number> = { pageSize: 50 };
  if (itemId) queryParams.itemId = Number(itemId);
  if (!admin) {
    queryParams.mine = 1;
    queryParams.from = todayISO();
  }

  const moves = useQuery({
    queryKey: ["movements", queryParams],
    queryFn: () => listMovements(queryParams),
  });

  return (
    <Screen title={admin ? "حركات المخزون" : "حركاتي"} backTo="/">
      {moves.error ? (
        <FlashBanner message={moves.error instanceof Error ? moves.error.message : "حدث خطأ"} />
      ) : null}

      {moves.isLoading ? (
        <LoadingSpinner />
      ) : (moves.data?.rows.length ?? 0) === 0 ? (
        <EmptyState message={admin ? "لا توجد حركات" : "لا توجد حركات اليوم"} />
      ) : (
        <div className="space-y-2">
          {moves.data!.rows.map((row) => (
            <MoveCard key={String(row.id)} row={row} />
          ))}
        </div>
      )}
    </Screen>
  );
}
