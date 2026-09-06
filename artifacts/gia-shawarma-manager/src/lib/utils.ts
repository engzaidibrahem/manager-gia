import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatIDR(value: number) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(value || 0);
}

export function shortDate(value?: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short' }).format(new Date(value));
}

export function shortDateTime(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  return `${shortDate(value)} · ${new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(parsed)}`;
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function nowTime() {
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

export function emptyRows<T extends Record<string, unknown>>(count: number, factory: () => T): T[] {
  return Array.from({ length: count }, factory);
}

export const inputClass = 'box-border w-full min-w-0 border-0 bg-transparent px-3 py-2 text-sm leading-5 outline-none focus:bg-[hsl(var(--background))] focus:ring-1 focus:ring-inset focus:ring-[hsl(var(--primary)/.35)]';
