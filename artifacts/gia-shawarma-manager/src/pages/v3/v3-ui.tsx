/** Shared V3 UI helpers — keep pages visually consistent. */
import type { Lang } from "@/lib/i18n";
import { PrimaryButton } from "@/components/FormKit";

export function StatusBadge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger" | "muted" | "review";
  children: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : tone === "warn"
        ? "bg-orange-50 text-orange-800 border-orange-200"
        : tone === "danger"
          ? "bg-red-50 text-red-800 border-red-200"
          : tone === "review"
            ? "bg-amber-50 text-amber-900 border-amber-200"
            : "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-[hsl(var(--border))]";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${cls}`}>
      {children}
    </span>
  );
}

export function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <p className="text-sm text-[hsl(var(--muted-foreground))]">{message}</p>
      {actionLabel && onAction ? <PrimaryButton onClick={onAction}>{actionLabel}</PrimaryButton> : null}
    </div>
  );
}

export function StockBanner({
  label,
  value,
  unknown,
  lang,
}: {
  label: string;
  value: number | null | undefined;
  unknown?: boolean;
  lang: Lang;
}) {
  const isUnknown = unknown || value == null;
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        isUnknown
          ? "border-amber-300 bg-amber-50 text-amber-950"
          : "border-[hsl(var(--primary)/.35)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--foreground))]"
      }`}
    >
      <div className="text-[11px] font-bold uppercase tracking-wide opacity-80">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">
        {isUnknown
          ? lang === "id"
            ? "Perlu review — stok numerik tidak diketahui"
            : "بحاجة مراجعة — الرصيد الرقمي غير معروف"
          : value}
      </div>
    </div>
  );
}

export function confirmDanger(message: string): boolean {
  return window.confirm(message);
}

export function panelTableClass() {
  return "panel soft-shadow overflow-auto";
}

export function tableClass(minW = "900px") {
  return `w-full min-w-[${minW}] border-collapse text-sm`;
}

export function thClass() {
  return "px-3 py-3 text-start text-[11px] font-bold text-[hsl(var(--muted-foreground))]";
}

export function tdClass() {
  return "px-3 py-2.5";
}
