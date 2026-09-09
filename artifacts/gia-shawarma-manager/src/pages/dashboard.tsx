import { useState } from 'react';
import { AlertTriangle, Boxes } from 'lucide-react';
import { Link } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useGetDashboardSummary, useListInventoryItems,
} from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { closeDayArchive, getDayArchiveStatus } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { formatIDR, formatBusinessDate, todayISO } from '@/lib/utils';

type SummaryExt = {
  date: string;
  totalIncome: number;
  totalExpenses: number;
  lowStockCount: number;
  totalPurchases?: number;
  availableCapital?: number;
  operationalBalance?: number;
};

export function DashboardPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const date = todayISO();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const summaryQuery = useGetDashboardSummary({ date });
  const lowStockQuery = useListInventoryItems({ lowStockOnly: true });
  const statusQuery = useQuery({ queryKey: ['day-archive-status', date], queryFn: () => getDayArchiveStatus(date) });
  const summary: SummaryExt = {
    date,
    totalIncome: 0,
    totalExpenses: 0,
    lowStockCount: 0,
    ...(summaryQuery.data ?? {}),
  };
  const archived = Boolean(statusQuery.data?.archived);
  const lowStockItems = (lowStockQuery.data ?? []).slice(0, 8);

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
      <PageTitle
        eyebrow="GIA / OPERASIONAL"
        title={t('dashboard')}
        description={lang === 'id' ? 'Ringkasan harian restoran.' : 'ملخص التشغيل اليومي.'}
        action={(
          <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-semibold">
            {formatBusinessDate(date, lang === 'id' ? 'id-ID' : 'ar-SA')}
          </div>
        )}
      />

      {summaryQuery.isError ? (
        <div className="panel p-8 text-center text-sm">{lang === 'id' ? 'Ringkasan belum dapat dimuat.' : 'تعذر تحميل الملخص.'}</div>
      ) : (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Metric
              label={t('availableCapital')}
              value={formatIDR(summary.availableCapital ?? summary.operationalBalance ?? 0)}
              detail={t('availableCapitalHint')}
              icon={Boxes}
              tone="primary"
            />
            <Metric label={t('purchasesTotal')} value={formatIDR(summary.totalPurchases ?? 0)} detail={t('today')} icon={Boxes} />
            <Metric label={t('expenses')} value={formatIDR(summary.totalExpenses)} detail={t('today')} icon={Boxes} />
            <Metric label={t('income')} value={formatIDR(summary.totalIncome)} detail={t('today')} icon={Boxes} />
            <Metric label={t('lowStock')} value={String(summary.lowStockCount)} detail={t('warehouse')} icon={AlertTriangle} />
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <Link href="/finance" className="btn-primary rounded-xl px-4 py-2.5 text-xs font-bold">{t('finance')}</Link>
            <Link href="/purchases" className="rounded-xl border border-[hsl(var(--border))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))]">{t('addPurchase')}</Link>
            <Link href="/inventory" className="rounded-xl border border-[hsl(var(--border))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))]">
              {lang === 'id' ? 'Lihat gudang' : 'عرض المستودع'}
            </Link>
            <button type="button" disabled={busy} onClick={() => void closeDay()} className="rounded-xl border border-[hsl(var(--border))] px-4 py-2.5 text-xs font-bold hover:bg-[hsl(var(--muted))] disabled:opacity-60">
              {archived ? t('rearchive') : t('closeDay')}
            </button>
          </div>

          <section className="panel soft-shadow p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-bold">{lang === 'id' ? 'Bahan yang perlu perhatian' : 'مواد تحتاج انتباه'}</h2>
              <Link href="/inventory" className="text-xs font-bold text-[hsl(var(--primary))]">
                {lang === 'id' ? 'Lihat gudang' : 'عرض المستودع'}
              </Link>
            </div>
            <div className="space-y-3">
              {lowStockItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between border-b border-[hsl(var(--border))] pb-2 text-sm">
                  <span className="font-semibold">{item.name}</span>
                  <span className="number text-xs">{item.currentStock} {item.unit}</span>
                </div>
              ))}
              {!lowStockItems.length && (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {lang === 'id' ? 'Semua stok aman' : 'كل المخزون آمن'}
                </p>
              )}
            </div>
          </section>
        </>
      )}
      <Flash message={flash} />
    </div>
  );
}
