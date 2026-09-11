import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatIDR(value: number) {
  const n = Number(value);
  const amount = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(amount);
  const body = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    numberingSystem: 'latn',
  }).format(abs);
  return amount < 0 ? `-Rp ${body}` : `Rp ${body}`;
}

/** Map Arabic-Indic / Eastern Arabic digits to Western 0-9. Leaves other chars intact. */
export function toWesternDigits(raw: string): string {
  return raw
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function shortDate(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    numberingSystem: 'latn',
  }).format(new Date(value));
}

export function shortDateTime(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  return `${shortDate(value)} · ${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    numberingSystem: 'latn',
  }).format(parsed)}`;
}

export function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format a YYYY-MM-DD business date without timezone shift. */
export function formatBusinessDate(value?: string, locale = 'en-GB') {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return shortDate(value);
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    numberingSystem: 'latn',
  }).format(date);
}

export function nowTime() {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    numberingSystem: 'latn',
  }).format(new Date());
}

export function emptyRows<T extends Record<string, unknown>>(count: number, factory: () => T): T[] {
  return Array.from({ length: count }, factory);
}

/** Visible, obviously editable form controls (standalone forms / modals). */
export const inputClass = [
  'box-border w-full min-h-[44px] min-w-0 rounded-xl',
  'border border-[hsl(var(--input))] bg-[hsl(var(--card))]',
  'px-3 py-2.5 text-sm leading-5 outline-none transition-[border-color,box-shadow,background-color]',
  'placeholder:text-[hsl(var(--muted-foreground)/.65)]',
  'hover:border-[hsl(var(--primary)/.4)]',
  'focus:border-[hsl(var(--primary))] focus:bg-[hsl(var(--background))] focus:ring-2 focus:ring-[hsl(var(--primary)/.16)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ');

/** Calculated / read-only values — clearly not editable. */
export const readOnlyFieldClass = [
  'box-border flex w-full min-h-[44px] min-w-0 items-center rounded-xl',
  'border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted))]',
  'px-3 py-2.5 text-sm font-semibold',
].join(' ');

/** Spreadsheet cells — still look clickable without heavy double borders. */
export const sheetInputClass = [
  'box-border w-full h-10 min-w-0',
  'border border-transparent bg-[hsl(var(--card))]',
  'px-3 text-sm outline-none transition-[border-color,background-color]',
  'hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--background))]',
  'focus:border-[hsl(var(--primary)/.45)] focus:bg-[hsl(var(--background))] focus:ring-1 focus:ring-inset focus:ring-[hsl(var(--primary)/.2)]',
].join(' ');
