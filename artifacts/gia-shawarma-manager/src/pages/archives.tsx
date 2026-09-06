import { useEffect, useState } from 'react';
import { Archive, CalendarDays, CheckCircle2, Package } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flash, PageTitle } from '@/components/layout';
import {
  closeDayArchive, getDayArchive, getDayArchiveStatus, listDayArchives,
} from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { formatIDR, shortDate, todayISO } from '@/lib/utils';

export function ArchivesPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const today = todayISO();
  const [selected, setSelected] = useState(today);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const listQuery = useQuery({ queryKey: ['day-archives'], queryFn: listDayArchives });
  const statusQuery = useQuery({ queryKey: ['day-archive-status', today], queryFn: () => getDayArchiveStatus(today) });
  const detailQuery = useQuery({
    queryKey: ['day-archive', selected],
    queryFn: () => getDayArchive(selected),
    enabled: Boolean(selected) && (listQuery.data?.some((a) => a.businessDate === selected) ?? false),
    retry: false,
  });

  useEffect(() => {
    if (!listQuery.data?.length) return;
    if (!listQuery.data.some((a) => a.businessDate === selected)) {
      setSelected(listQuery.data[0]!.businessDate);
    }
  }, [listQuery.data, selected]);

  const archive = detailQuery.data;
  const todayArchived = Boolean(statusQuery.data?.archived);

  async function closeDay(force = false) {
    if (!force && !window.confirm(t('closeDayConfirm'))) return;
    if (force && !window.confirm(lang === 'id' ? 'Arsip ulang hari ini?' : 'إعادة أرشفة اليوم؟')) return;
    setBusy(true);
    try {
      const row = await closeDayArchive({ date: today, closedBy: 'manager', notes: notes || undefined, force });
      setFlash(t('archiveOk'));
      setSelected(row.businessDate);
      setNotes('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['day-archives'] }),
        qc.invalidateQueries({ queryKey: ['day-archive-status', today] }),
        qc.invalidateQueries({ queryKey: ['day-archive', row.businessDate] }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('archiveFailed');
      setFlash(msg.includes('already') ? t('dayArchived') : t('archiveFailed'));
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(''), 2800);
    }
  }

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / ARCHIVE"
        title={t('archives')}
        description={t('archivesDesc')}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            {todayArchived ? (
              <span className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-700">
                <CheckCircle2 size={15} />{t('dayArchived')} · {shortDate(today)}
              </span>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => closeDay(todayArchived)}
              className="rounded-xl bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)] disabled:opacity-60"
            >
              {todayArchived ? t('rearchive') : t('closeDay')}
            </button>
          </div>
        )}
      />

      <section className="panel soft-shadow mb-4 p-4 md:p-5">
        <label className="block text-xs font-semibold text-[hsl(var(--muted-foreground))]">{lang === 'id' ? 'Catatan penutupan (opsional)' : 'ملاحظة الإغلاق (اختياري)'}</label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="mt-2 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm"
          placeholder={lang === 'id' ? 'Contoh: shift malam selesai, stok dicek' : 'مثال: انتهت وردية المساء، تم جرد المخزون'}
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
        <aside className="panel soft-shadow p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><CalendarDays size={16} />{t('selectDay')}</h2>
          <div className="max-h-[520px] space-y-1 overflow-y-auto">
            {(listQuery.data ?? []).map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected(row.businessDate)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-start text-xs font-semibold ${selected === row.businessDate ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'hover:bg-[hsl(var(--muted))]'}`}
              >
                <span>{shortDate(row.businessDate)}</span>
                <span className="number opacity-80">{formatIDR(row.totalPurchases)}</span>
              </button>
            ))}
            {!listQuery.data?.length && !listQuery.isLoading && (
              <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">{t('noArchives')}</p>
            )}
          </div>
        </aside>

        <div className="space-y-4">
          {archive ? (
            <>
              <section className="panel soft-shadow p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-lg font-bold"><Archive size={18} />{shortDate(archive.businessDate)}</h2>
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {t('archivedAt')}: {new Date(archive.closedAt).toLocaleString(lang === 'id' ? 'id-ID' : 'ar-SA')} · {t('closedBy')}: {archive.closedBy || '—'}
                    </p>
                    {archive.notes ? <p className="mt-2 text-sm">{archive.notes}</p> : null}
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label={t('purchasesTotal')} value={formatIDR(archive.totalPurchases)} hint={`${archive.purchaseCount}`} />
                  <Stat label={t('income')} value={formatIDR(archive.totalIncome)} />
                  <Stat label={t('expenses')} value={formatIDR(archive.totalExpenses)} />
                  <Stat label={t('netCash')} value={formatIDR(archive.netCash)} />
                  <Stat label={t('wasteCost')} value={formatIDR(archive.wasteCost)} />
                  <Stat label={t('kitchenMoves')} value={String(archive.kitchenMovements)} />
                  <Stat label={t('warehouseValue')} value={formatIDR(archive.warehouseValue)} />
                  <Stat label={t('kitchenValue')} value={formatIDR(archive.kitchenValue)} />
                </div>
              </section>

              <DetailTable
                title={t('dayPurchases')}
                empty={t('noRecords')}
                rows={(archive.snapshot?.purchases ?? []) as Record<string, unknown>[]}
                columns={[
                  { key: 'itemName', label: t('name') },
                  { key: 'destination', label: t('destination') },
                  { key: 'quantity', label: t('quantity') },
                  { key: 'totalAmount', label: t('totalAmount'), money: true },
                ]}
              />

              <DetailTable
                title={t('dayMovements')}
                empty={t('noRecords')}
                rows={(archive.snapshot?.movements ?? []) as Record<string, unknown>[]}
                columns={[
                  { key: 'itemName', label: t('name') },
                  { key: 'type', label: t('movementType') },
                  { key: 'location', label: t('location') },
                  { key: 'quantity', label: t('quantity') },
                ]}
              />

              <section className="panel soft-shadow p-5">
                <h3 className="mb-3 flex items-center gap-2 font-bold"><Package size={16} />{t('stockSnapshot')}</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-start text-xs">
                    <thead>
                      <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
                        <th className="px-2 py-2 font-semibold">{t('name')}</th>
                        <th className="px-2 py-2 font-semibold">{t('warehouseStock')}</th>
                        <th className="px-2 py-2 font-semibold">{t('kitchenStock')}</th>
                        <th className="px-2 py-2 font-semibold">{t('unitCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(archive.snapshot?.stockAtClose ?? []).map((item) => (
                        <tr key={item.id} className="border-b border-[hsl(var(--border))/.6]">
                          <td className="px-2 py-2 font-semibold">{item.name}</td>
                          <td className="number px-2 py-2">{item.currentStock} {item.unit}</td>
                          <td className="number px-2 py-2">{item.kitchenStock} {item.unit}</td>
                          <td className="number px-2 py-2">{formatIDR(item.costPerUnit)}</td>
                        </tr>
                      ))}
                      {!archive.snapshot?.stockAtClose?.length && (
                        <tr><td colSpan={4} className="px-2 py-8 text-center text-[hsl(var(--muted-foreground))]">{t('noRecords')}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <section className="panel soft-shadow p-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
              {listQuery.isLoading || detailQuery.isLoading ? '…' : t('noArchives')}
            </section>
          )}
        </div>
      </div>
      <Flash message={flash} />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="number mt-1 text-lg font-semibold">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-[hsl(var(--muted-foreground))]">{hint}</div> : null}
    </div>
  );
}

function DetailTable({
  title, empty, rows, columns,
}: {
  title: string;
  empty: string;
  rows: Record<string, unknown>[];
  columns: { key: string; label: string; money?: boolean }[];
}) {
  return (
    <section className="panel soft-shadow p-5">
      <h3 className="mb-3 font-bold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-start text-xs">
          <thead>
            <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
              {columns.map((c) => <th key={c.key} className="px-2 py-2 font-semibold">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-[hsl(var(--border))/.6]">
                {columns.map((c) => {
                  const raw = row[c.key];
                  const text = c.money ? formatIDR(Number(raw) || 0) : String(raw ?? '—');
                  return <td key={c.key} className={`px-2 py-2 ${c.money ? 'number' : ''}`}>{text}</td>;
                })}
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={columns.length} className="px-2 py-8 text-center text-[hsl(var(--muted-foreground))]">{empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
