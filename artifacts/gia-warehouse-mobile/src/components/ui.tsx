import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ArrowRight, Loader2, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "wouter";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function computeStockStatus(qty: number | null, min: number | null): string {
  if (qty == null) return "REVIEW_REQUIRED";
  if (qty <= 0) return "OUT_OF_STOCK";
  if (min != null && qty < min) return "LOW_STOCK";
  return "NORMAL";
}

export function parseQty(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function statusTone(s: string): "ok" | "warn" | "danger" | "review" | "muted" {
  if (s === "NORMAL") return "ok";
  if (s === "LOW_STOCK") return "warn";
  if (s === "OUT_OF_STOCK") return "danger";
  if (s === "REVIEW_REQUIRED") return "review";
  return "muted";
}

const toneClass: Record<string, string> = {
  ok: "bg-[hsl(var(--ok)/0.12)] text-[hsl(var(--ok))]",
  warn: "bg-[hsl(var(--warn)/0.12)] text-[hsl(var(--warn))]",
  danger: "bg-[hsl(var(--danger)/0.12)] text-[hsl(var(--danger))]",
  review: "bg-amber-100 text-amber-800",
  muted: "bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = statusTone(status);
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-bold", toneClass[tone])}>
      {label ?? status}
    </span>
  );
}

export function FlashBanner({
  message,
  tone = "danger",
  onDismiss,
}: {
  message: string;
  tone?: "danger" | "ok" | "warn";
  onDismiss?: () => void;
}) {
  if (!message) return null;
  const colors =
    tone === "ok"
      ? "border-[hsl(var(--ok)/0.35)] bg-[hsl(var(--ok)/0.08)] text-[hsl(var(--ok))]"
      : tone === "warn"
        ? "border-[hsl(var(--warn)/0.35)] bg-[hsl(var(--warn)/0.08)] text-[hsl(var(--warn))]"
        : "border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] text-[hsl(var(--danger))]";
  return (
    <div className={cn("mb-4 rounded-xl border px-4 py-3 text-sm font-semibold", colors)} role="alert">
      <div className="flex items-start justify-between gap-2">
        <span>{message}</span>
        {onDismiss ? (
          <button type="button" className="opacity-70" onClick={onDismiss} aria-label="إغلاق">
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LoadingSpinner({ label = "جاري التحميل..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-[hsl(var(--muted-foreground))]">
      <Loader2 className="h-8 w-8 animate-spin text-[hsl(var(--primary))]" />
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}

export function Screen({
  title,
  backTo,
  onBack,
  showLogout,
  onLogout,
  children,
  footer,
}: {
  title: string;
  backTo?: string;
  onBack?: () => void;
  showLogout?: boolean;
  onLogout?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col px-4 pb-6 safe-top safe-bottom">
      <header className="sticky top-0 z-10 -mx-4 mb-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/0.92)] px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          {backTo ? (
            <Link href={backTo} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
              <ArrowRight className="h-5 w-5" />
            </Link>
          ) : onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--primary))] text-lg font-black text-[hsl(var(--primary-foreground))]">
              G
            </div>
          )}
          <h1 className="min-w-0 flex-1 truncate text-lg font-extrabold">{title}</h1>
          {showLogout && onLogout ? (
            <button
              type="button"
              onClick={onLogout}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] text-[hsl(var(--muted-foreground))]"
              aria-label="تسجيل الخروج"
            >
              <LogOut className="h-5 w-5" />
            </button>
          ) : null}
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {footer ? <footer className="mt-4">{footer}</footer> : null}
    </div>
  );
}

export function BigAction({
  href,
  onClick,
  title,
  subtitle,
  tone = "primary",
}: {
  href?: string;
  onClick?: () => void;
  title: string;
  subtitle?: string;
  tone?: "primary" | "secondary";
}) {
  const className = cn(
    "card block w-full text-start transition active:scale-[0.98]",
    tone === "primary" && "border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.06)]",
  );
  const inner = (
    <>
      <div className="text-base font-extrabold">{title}</div>
      {subtitle ? <div className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{subtitle}</div> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

export function QtyField({
  label,
  value,
  onChange,
  unit,
  hint,
  inputMode = "decimal",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  hint?: string;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-bold">{label}</span>
      <div className="flex gap-2">
        <input
          className="input-lg flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={inputMode}
          autoComplete="off"
        />
        {unit ? (
          <span className="flex min-w-[4rem] items-center justify-center rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 text-sm font-bold">
            {unit}
          </span>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p> : null}
    </label>
  );
}

export function NotesField({
  value,
  onChange,
  label = "ملاحظات",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-bold">{label}</span>
      <textarea
        className="input-lg min-h-[5rem] resize-y"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
      />
    </label>
  );
}

export function StatGrid({ items }: { items: Array<{ n: number | string; l: string; tone?: string }> }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <div key={item.l} className="card stat">
          <div className={cn("n", item.tone)}>{item.n}</div>
          <div className="l">{item.l}</div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="card py-10 text-center text-sm font-semibold text-[hsl(var(--muted-foreground))]">
      {message}
    </div>
  );
}
