import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, CalendarDays, Search } from 'lucide-react';
import { Link } from 'wouter';
import { PageHint, TextInput } from '@/components/FormKit';
import { PageTitle } from '@/components/layout';
import { getWarehouseArchive, listWarehouseArchives, type WarehouseDayArchive, type WarehouseLot } from '@/lib/bulk-api';
import { displayActor } from '@/lib/display-labels';
import { useT, type Lang } from '@/lib/i18n';
import { formatBusinessDate, formatIDR } from '@/lib/utils';

export function WarehouseArchivePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const grouped = useMemo(() => {
    const map = new Map<string, {
      key: string;
      itemName: string;
      itemUnit: string;
      qrToken: string;
      lots: WarehouseLot[];
      totalReceived: number;
      totalRemaining: number;
      totalValue: number;
    }>();
    for (const r of receipts) {
      const key = `${r.itemName}::${r.qrToken || r.itemId || r.id}`;
      const cur = map.get(key) ?? {
        key,
        itemName: String(r.itemName || '—'),
        itemUnit: String(r.itemUnit || ''),
        qrToken: String(r.qrToken || ''),
        lots: [] as WarehouseLot[],
        totalReceived: 0,
        totalRemaining: 0,
        totalValue: 0,
      };
      cur.lots.push(r);
      cur.totalReceived += Number(r.quantityReceived || 0);
      cur.totalRemaining += Number(r.quantityRemaining || 0);
      cur.totalValue += Number(r.quantityReceived || 0) * Number(r.costPerUnit || 0);
      map.set(key, cur);
    }
    return [...map.values()];
  }, [receipts]);

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / GUDANG ARCHIVE"
        title={t('warehouseArchive')}
        description={t('warehouseArchiveDesc')}
        action={(
          <Link href="/archives" className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            {t('archives')}
          </Link>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Arsip gudang per tanggal: lot penerimaan dan saldo. Bukan arsip operasional harian.'
          : 'أرشيف المستودع حسب التاريخ: دفعات الوارد والأرصدة. ليس الأرشيف التشغيلي اليومي.'}
      </PageHint>

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1">
        <Search size={15} className="shrink-0 text-[hsl(var(--muted-foreground))]" />
        <TextInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="border-0 bg-transparent shadow-none hover:border-0 focus:border-0 focus:ring-0"
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
                <span className="font-bold">{formatBusinessDate(row.businessDate, lang === 'id' ? 'id-ID' : 'ar-SA')}</span>
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
                <h2 className="flex items-center gap-2 text-lg font-bold"><Archive size={18} />{formatBusinessDate(archive.businessDate, lang === 'id' ? 'id-ID' : 'ar-SA')}</h2>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  {t('archivedAt')}: {new Date(archive.closedAt).toLocaleString(lang === 'id' ? 'id-ID' : 'ar-SA')} · {t('closedBy')}: {displayActor(archive.closedBy, lang)}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Stat label={lang === 'id' ? 'Jumlah lot' : 'عدد الدفعات'} value={String(archive.receiptCount)} />
                  <Stat label={t('quantity')} value={String(archive.totalQuantity)} />
                  <Stat label={t('totalAmount')} value={formatIDR(archive.totalValue)} />
                </div>
              </section>

              <section className="panel soft-shadow p-5">
                <h3 className="mb-3 font-bold">{lang === 'id' ? 'Penerimaan per item (lot)' : 'الوارد حسب الصنف (دفعات)'}</h3>
                <div className="space-y-3">
                  {grouped.map((g) => {
                    const open = expanded[g.key] ?? g.lots.length === 1;
                    return (
                      <div key={g.key} className="rounded-xl border border-[hsl(var(--border))] p-3">
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 text-start"
                          onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !open }))}
                        >
                          <div>
                            <div className="text-sm font-bold">{g.itemName}</div>
                            <div className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                              {g.lots.length} {lang === 'id' ? 'lot' : 'دفعة'} · {formatIDR(g.totalValue)}
                            </div>
                          </div>
                          <div className="number text-xs font-bold">{g.totalReceived} {g.itemUnit}</div>
                        </button>
                        {open ? (
                          <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[520px] text-start text-xs">
                              <thead>
                                <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
                                  <th className="px-2 py-2 font-semibold">{lang === 'id' ? 'Lot' : 'دفعة'}</th>
                                  <th className="px-2 py-2 font-semibold">{t('brand')}</th>
                                  <th className="px-2 py-2 font-semibold">{t('quantity')}</th>
                                  <th className="px-2 py-2 font-semibold">{t('lotRemaining')}</th>
                                  <th className="px-2 py-2 font-semibold">{t('unitCost')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {g.lots.map((r, idx) => (
                                  <tr key={r.id} className="border-b border-[hsl(var(--border))/.6]">
                                    <td className="px-2 py-2 font-semibold">{lang === 'id' ? `Lot ${idx + 1}` : `دفعة ${idx + 1}`}</td>
                                    <td className="px-2 py-2">{r.brand || '—'}</td>
                                    <td className="number px-2 py-2">{r.quantityReceived} {r.itemUnit}</td>
                                    <td className="number px-2 py-2">{r.quantityRemaining}</td>
                                    <td className="number px-2 py-2">{formatIDR(r.costPerUnit)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {!grouped.length && (
                    <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">{t('noRecords')}</p>
                  )}
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
