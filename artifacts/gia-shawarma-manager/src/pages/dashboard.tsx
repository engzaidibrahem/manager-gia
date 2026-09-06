import { useState } from 'react';
import {
  Activity, AlertTriangle, Archive, ArrowDownLeft, ArrowUpRight, Boxes, Calculator, CalendarDays, CheckCircle2, Coffee, DollarSign,
  ShoppingBag, Trash2, UserCheck,
} from 'lucide-react';
import { Link } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useGetDashboardSummary, useListExpenses, useListIncome, useListInventoryItems,
} from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { closeDayArchive, getDayArchiveStatus } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { formatIDR, shortDate, todayISO } from '@/lib/utils';

function buildHourlyCashFlow(incomes: { amount: number; incomeTime?: string }[], expenses: { amount: number; expenseTime?: string }[]) {
  return Array.from({ length: 17 }, (_, i) => {
    const hour = i + 6;
    const prefix = String(hour).padStart(2, '0');
    const income = incomes.filter((row) => (row.incomeTime || '').startsWith(prefix)).reduce((sum, row) => sum + Number(row.amount), 0);
    const expense = expenses.filter((row) => (row.expenseTime || '').startsWith(prefix)).reduce((sum, row) => sum + Number(row.amount), 0);
    return { hour, income, expense };
  });
}

type SummaryExt = {
  date: string;
  totalIncome: number;
  totalExpenses: number;
  netCash: number;
  lowStockCount: number;
  kitchenMovements: number;
  attendanceCount: number;
  totalPurchases?: number;
  purchaseCount?: number;
  wasteCost?: number;
  recentActivity: { id?: number; kind?: string; title?: string; detail?: string }[];
};

export function DashboardPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const date = todayISO();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const summaryQuery = useGetDashboardSummary({ date });
  const lowStockQuery = useListInventoryItems({ lowStockOnly: true });
  const incomeQuery = useListIncome({ date, limit: 200 });
  const expensesQuery = useListExpenses({ date, limit: 200 });
  const statusQuery = useQuery({ queryKey: ['day-archive-status', date], queryFn: () => getDayArchiveStatus(date) });
  const summary = (summaryQuery.data ?? { date, totalIncome: 0, totalExpenses: 0, netCash: 0, lowStockCount: 0, kitchenMovements: 0, attendanceCount: 0, recentActivity: [] }) as SummaryExt;
  const hourly = buildHourlyCashFlow(incomeQuery.data ?? [], expensesQuery.data ?? []);
  const chartMax = Math.max(1, ...hourly.flatMap((row) => [row.income, row.expense]));
  const hasChartData = hourly.some((row) => row.income > 0 || row.expense > 0);
  const archived = Boolean(statusQuery.data?.archived);

  const quickLinks = [
    { href: '/archives', key: 'archives', icon: Archive },
    { href: '/inventory', key: 'warehouse', icon: Boxes },
    { href: '/kitchen', key: 'kitchen', icon: Coffee },
    { href: '/purchases', key: 'purchases', icon: ShoppingBag },
    { href: '/recipes', key: 'recipes', icon: Calculator },
    { href: '/waste', key: 'waste', icon: Trash2 },
    { href: '/finance', key: 'finance', icon: DollarSign },
    { href: '/staff', key: 'staff', icon: UserCheck },
  ];

  async function closeDay() {
    if (!window.confirm(t('closeDayConfirm'))) return;
    setBusy(true);
    try {
      await closeDayArchive({ date, closedBy: 'manager', force: archived });
      setFlash(t('archiveOk'));
      await qc.invalidateQueries({ queryKey: ['day-archive-status', date] });
      await qc.invalidateQueries({ queryKey: ['day-archives'] });
    } catch {
      setFlash(t('archiveFailed'));
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(''), 2800);
    }
  }

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / OPERASIONAL" title={t('dashboard')} description={lang === 'id' ? 'Kontrol operasi — gudang, dapur, pembelian, resep, limbah, kas.' : 'تحكم التشغيل — المستودع، المطبخ، المشتريات، الوصفات، الهدر، النقد.'}
        action={<div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-semibold"><CalendarDays size={15} className="text-[hsl(var(--primary))]" />{shortDate(date)} · {t('today')}</div>} />

      <section className="panel soft-shadow mb-4 flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <Archive size={16} className="text-[hsl(var(--primary))]" />
            {t('closeDay')}
          </h2>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{t('archivesDesc')}</p>
          {archived ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <CheckCircle2 size={14} />
              {t('dayArchived')}
              {statusQuery.data?.closedAt ? ` · ${new Date(statusQuery.data.closedAt).toLocaleTimeString(lang === 'id' ? 'id-ID' : 'ar-SA', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/archives" className="rounded-xl border border-[hsl(var(--border))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            {t('viewArchive')}
          </Link>
          <button
            type="button"
            disabled={busy}
            onClick={closeDay}
            className="rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)] disabled:opacity-60"
          >
            {archived ? t('rearchive') : t('closeDay')}
          </button>
        </div>
      </section>

      {summaryQuery.isError ? (
        <div className="panel p-8 text-center text-sm">{lang === 'id' ? 'Ringkasan belum dapat dimuat.' : 'تعذر تحميل الملخص.'}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            <Metric label={t('income')} value={formatIDR(summary.totalIncome)} detail={lang === 'id' ? 'Penjualan hari ini' : 'مبيعات اليوم'} icon={ArrowUpRight} />
            <Metric label={t('expenses')} value={formatIDR(summary.totalExpenses)} detail={lang === 'id' ? 'Semua pengeluaran' : 'كل المصروفات'} icon={ArrowDownLeft} />
            <Metric label={t('purchasesTotal')} value={formatIDR(summary.totalPurchases ?? 0)} detail={`${summary.purchaseCount ?? 0}`} icon={ShoppingBag} />
            <Metric label={t('netCash')} value={formatIDR(summary.netCash)} detail={lang === 'id' ? 'Posisi kas' : 'وضع النقد'} icon={DollarSign} tone="primary" />
            <Metric label={t('wasteCost')} value={formatIDR(summary.wasteCost ?? 0)} detail={t('today')} icon={Trash2} />
            <Metric label={t('lowStock')} value={String(summary.lowStockCount).padStart(2, '0')} detail={t('warehouseStock')} icon={AlertTriangle} />
            <Metric label={t('kitchenMoves')} value={`${summary.kitchenMovements}`} detail={t('kitchen')} icon={Coffee} />
            <Metric label={t('attendance')} value={`${summary.attendanceCount}`} detail={t('today')} icon={UserCheck} />
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-[1.55fr_1fr]">
            <section className="panel soft-shadow p-5 md:p-6">
              <h2 className="font-bold">{t('cashFlow')}</h2>
              {hasChartData ? (
                <div className="mt-8 flex h-36 items-end gap-1 border-b border-dashed border-[hsl(var(--border))] px-1">
                  {hourly.map((row) => (
                    <div key={row.hour} className="group flex flex-1 flex-col justify-end gap-1">
                      <div className="flex w-full items-end justify-center gap-0.5" style={{ height: '100%' }}>
                        <div className="w-[42%] rounded-t-md bg-[hsl(var(--primary))]" style={{ height: `${Math.max(4, (row.income / chartMax) * 100)}%` }} />
                        <div className="w-[42%] rounded-t-md bg-[hsl(var(--accent))]" style={{ height: `${Math.max(4, (row.expense / chartMax) * 100)}%` }} />
                      </div>
                      <span className="text-center text-[9px] text-[hsl(var(--muted-foreground))]">{row.hour}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="mt-8 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">{t('noDataChart')}</p>}
            </section>
            <section className="panel soft-shadow p-5 md:p-6">
              <h2 className="font-bold">{t('lowStock')}</h2>
              <div className="mt-5 space-y-3">
                {(lowStockQuery.data ?? []).slice(0, 5).map((item) => (
                  <div key={item.id} className="flex items-center justify-between border-b border-[hsl(var(--border))] pb-2 text-sm">
                    <span className="font-semibold">{item.name}</span>
                    <span className="number text-xs">{item.currentStock} {item.unit}</span>
                  </div>
                ))}
                {!lowStockQuery.data?.length && <p className="text-sm text-[hsl(var(--muted-foreground))]">{lang === 'id' ? 'Semua stok aman' : 'كل المخزون آمن'}</p>}
              </div>
            </section>
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <section className="panel soft-shadow p-5 md:p-6">
              <h2 className="font-bold">{t('quickNav')}</h2>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {quickLinks.map(({ href, key, icon: Icon }) => (
                  <Link key={href} href={href} className="rounded-xl border border-[hsl(var(--border))] p-3 hover:border-[hsl(var(--primary)/.45)] hover:bg-[hsl(var(--secondary)/.55)]">
                    <Icon size={18} className="text-[hsl(var(--primary))]" />
                    <span className="mt-2 block text-[11px] font-bold">{t(key)}</span>
                  </Link>
                ))}
              </div>
            </section>
            <section className="panel soft-shadow p-5 md:p-6">
              <h2 className="font-bold">{t('recentActivity')}</h2>
              <div className="mt-4 divide-y divide-[hsl(var(--border))]">
                {(summary.recentActivity ?? []).slice(0, 6).map((item, i) => (
                  <div key={item.id ?? i} className="flex items-center gap-3 py-3">
                    <Activity size={15} className="text-[hsl(var(--primary))]" />
                    <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold">{item.title}</p><p className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">{item.detail}</p></div>
                  </div>
                ))}
                {!summary.recentActivity?.length && <p className="py-6 text-sm text-[hsl(var(--muted-foreground))]">{t('noRecords')}</p>}
              </div>
            </section>
          </div>
        </>
      )}
      <Flash message={flash} />
    </div>
  );
}
