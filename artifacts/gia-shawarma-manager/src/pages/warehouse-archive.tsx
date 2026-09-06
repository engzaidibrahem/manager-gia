import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, CalendarDays, Search } from 'lucide-react';
import { Link } from 'wouter';
import { PageTitle } from '@/components/layout';
import { getWarehouseArchive, listWarehouseArchives, type WarehouseDayArchive, type WarehouseLot } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { formatIDR, shortDate } from '@/lib/utils';

export function WarehouseArchivePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const listQuery = useQuery({
    queryKey: ['warehouse-archives', debounced],
    queryFn: () => listWarehouseArchives(debounced || undefined),
  });

  useEffect(() => {
    if (!listQuery.data?.length) return;
    if (!listQuery.data.some((a) => a.businessDate === selected)) {
      setSelected(listQuery.data[0]!.businessDate);
    }
  }, [listQuery.data, selected]);

  const detailQuery = useQuery({
    queryKey: ['warehouse-archive', selected],
    queryFn: () => getWarehouseArchive(selected),
    enabled: Boolean(selected) && Boolean(listQuery.data?.some((a) => a.businessDate === selected)),
    retry: false,
  });

  const archive = detailQuery.data as WarehouseDayArchive | undefined;
  const receipts = (archive?.snapshot?.receipts ?? []) as WarehouseLot[];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / GUDANG ARCHIVE"
        title={t('warehouseArchive')}
        description={t('warehouseArchiveDesc')}
        action={(
          <Link href="/inventory" className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            ← {t('inventory')}
          </Link>
        )}
      />

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2">
        <Search size={15} className="text-[hsl(var(--muted-foreground))]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full bg-transparent text-sm outline-none"
          placeholder={t('searchArchive')}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
        <aside className="panel soft-shadow p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><CalendarDays size={16} />{t('selectDay')}</h2>
          <div className="max-h-[560px] space-y-1 overflow-y-auto">
            {(listQuery.data ?? []).map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected(row.businessDate)}
                className={`flex w-full flex-col rounded-xl px-3 py-2.5 text-start text-xs ${selected === row.businessDate ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'hover:bg-[hsl(var(--muted))]'}`}
              >
                <span className="font-bold">{shortDate(row.businessDate)}</span>
                <span className="mt-0.5 opacity-80">{row.receiptCount} · {formatIDR(row.totalValue)}</span>
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
                <h2 className="flex items-center gap-2 text-lg font-bold"><Archive size={18} />{shortDate(archive.businessDate)}</h2>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  {t('archivedAt')}: {new Date(archive.closedAt).toLocaleString(lang === 'id' ? 'id-ID' : 'ar-SA')} · {t('closedBy')}: {archive.closedBy || '—'}
                </p>
                {archive.notes ? <p className="mt-2 text-sm">{archive.notes}</p> : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Stat label={t('purchaseCount')} value={String(archive.receiptCount)} />
                  <Stat label={t('quantity')} value={String(archive.totalQuantity)} />
                  <Stat label={t('totalAmount')} value={formatIDR(archive.totalValue)} />
                </div>
              </section>

              <section className="panel soft-shadow p-5">
                <h3 className="mb-3 font-bold">{t('dailyReceipts')}</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-start text-xs">
                    <thead>
                      <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
                        <th className="px-2 py-2 font-semibold">{t('name')}</th>
                        <th className="px-2 py-2 font-semibold">{t('brand')}</th>
                        <th className="px-2 py-2 font-semibold">{t('quantity')}</th>
                        <th className="px-2 py-2 font-semibold">{t('lotRemaining')}</th>
                        <th className="px-2 py-2 font-semibold">{t('unitCost')}</th>
                        <th className="px-2 py-2 font-semibold">{t('qrToken')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipts.map((r) => (
                        <tr key={r.id} className="border-b border-[hsl(var(--border))/.6]">
                          <td className="px-2 py-2 font-semibold">{r.itemName}</td>
                          <td className="px-2 py-2">{r.brand || '—'}</td>
                          <td className="number px-2 py-2">{r.quantityReceived} {r.itemUnit}</td>
                          <td className="number px-2 py-2">{r.quantityRemaining}</td>
                          <td className="number px-2 py-2">{formatIDR(r.costPerUnit)}</td>
                          <td className="px-2 py-2 font-mono text-[10px]">{r.qrToken || '—'}</td>
                        </tr>
                      ))}
                      {!receipts.length && (
                        <tr><td colSpan={6} className="px-2 py-8 text-center text-[hsl(var(--muted-foreground))]">{t('noRecords')}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="panel soft-shadow p-5">
                <h3 className="mb-3 font-bold">{t('stockSnapshot')}</h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-start text-xs">
                    <thead>
                      <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
                        <th className="px-2 py-2 font-semibold">{t('name')}</th>
                        <th className="px-2 py-2 font-semibold">{t('warehouseStock')}</th>
                        <th className="px-2 py-2 font-semibold">{t('kitchenStock')}</th>
                        <th className="px-2 py-2 font-semibold">{t('qrToken')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(archive.snapshot?.stockAtClose ?? []).map((item) => {
                        const row = item as {
                          id: number; name: string; unit: string; currentStock: number; kitchenStock: number; qrToken?: string;
                        };
                        return (
                          <tr key={row.id} className="border-b border-[hsl(var(--border))/.6]">
                            <td className="px-2 py-2 font-semibold">{row.name}</td>
                            <td className="number px-2 py-2">{row.currentStock} {row.unit}</td>
                            <td className="number px-2 py-2">{row.kitchenStock} {row.unit}</td>
                            <td className="px-2 py-2 font-mono text-[10px]">{row.qrToken || '—'}</td>
                          </tr>
                        );
                      })}
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className="number mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
