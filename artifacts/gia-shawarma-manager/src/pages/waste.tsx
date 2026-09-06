import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';
import { getGetDashboardSummaryQueryKey, getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveWaste, listWaste } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, formatIDR, nowTime, todayISO } from '@/lib/utils';

type WasteRow = {
  _key: string;
  _selected?: boolean;
  id?: number;
  wasteDate: string;
  wasteTime: string;
  inventoryItemId: string;
  location: string;
  quantity: number | '';
  reason: string;
  actor: string;
  notes: string;
};

function blank(date: string, items: { id: number }[]): WasteRow {
  return {
    _key: makeRowKey(), wasteDate: date, wasteTime: nowTime(),
    inventoryItemId: items[0] ? String(items[0].id) : '0',
    location: 'kitchen', quantity: '', reason: 'spoilage', actor: '', notes: '',
  };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function WastePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const itemsQuery = useListInventoryItems({});
  const items = itemsQuery.data ?? [];
  const wasteQuery = useQuery({ queryKey: ['waste', date], queryFn: () => listWaste(date) });
  const waste = wasteQuery.data ?? [];
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  const buildRows = useCallback(() => {
    const loaded: WasteRow[] = waste.map((w) => ({
      _key: `id-${w.id}`,
      id: Number(w.id),
      wasteDate: String(w.wasteDate),
      wasteTime: String(w.wasteTime ?? ''),
      inventoryItemId: String(w.inventoryItemId),
      location: String(w.location),
      quantity: Number(w.quantity),
      reason: String(w.reason),
      actor: String(w.actor),
      notes: String(w.notes ?? ''),
    }));
    return [...loaded, ...emptyRows(Math.max(0, 8 - loaded.length), () => blank(date, items))];
  }, [waste, date, items]);

  const { rows, setRows, markDirty, markClean } = useGridSync(
    `${date}-${wasteQuery.dataUpdatedAt}`,
    wasteQuery.isFetched,
    buildRows,
  );

  const itemOptions = useMemo(() => [
    { value: '0', label: '—' },
    ...items.map((i) => ({ value: String(i.id), label: i.name })),
  ], [items]);

  const locOptions = useMemo(() => [
    { value: 'warehouse', label: t('destWarehouse') },
    { value: 'kitchen', label: t('destKitchen') },
  ], [t]);

  const reasonOptions = useMemo(() => [
    { value: 'spoilage', label: t('reasonSpoil') },
    { value: 'prep', label: t('reasonPrep') },
    { value: 'theft', label: t('reasonTheft') },
    { value: 'other', label: t('reasonOther') },
  ], [t]);

  const columns: ColDef<WasteRow>[] = useMemo(() => [
    { key: 'wasteDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'wasteTime', label: t('time'), type: 'time', width: '90px' },
    { key: 'inventoryItemId', label: t('name'), type: 'select', options: itemOptions, width: '180px' },
    { key: 'location', label: t('location'), type: 'select', options: locOptions, width: '120px' },
    { key: 'quantity', label: t('quantity'), type: 'number', min: 0.1, step: 0.1, width: '90px' },
    { key: 'reason', label: t('reason'), type: 'select', options: reasonOptions, width: '130px' },
    { key: 'actor', label: t('actor'), width: '120px' },
    { key: 'notes', label: t('note'), width: '140px' },
  ], [itemOptions, locOptions, reasonOptions, t]);

  const totalCost = waste.reduce((n, w) => n + Number(w.costEstimate ?? 0), 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = rows
        .filter((r) => r.inventoryItemId !== '0' && num(r.quantity) > 0 && r.actor.trim())
        .map(({ _key, _selected, quantity, ...rest }) => ({
          ...rest,
          inventoryItemId: Number(rest.inventoryItemId),
          quantity: num(quantity),
        }));
      await bulkSaveWaste(payload, deleteIds);
      setDeleteIds([]);
      markClean();
      await wasteQuery.refetch();
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) });
      await qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey({ date }) });
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSaving(false);
    }
  };

  const handleRowsChange = (next: Parameters<typeof setRows>[0]) => {
    markDirty();
    setRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDeleteIds((ids) => [...ids, ...removed.map((r) => r.id!).filter((id) => !ids.includes(id))]);
      return resolved;
    });
  };

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / WASTE" title={t('waste')} description={t('wasteDesc')}
        action={<label className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold"><CalendarDays size={15} /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none" /></label>} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Metric label={t('wasteCost')} value={formatIDR(totalCost)} detail={t('today')} icon={Trash2} tone="primary" />
        <Metric label={t('items')} value={String(waste.length)} detail={t('waste')} icon={Trash2} />
      </div>
      <SpreadsheetGrid columns={columns} rows={rows} onRowsChange={handleRowsChange} onSave={handleSave} saving={saving} lang={lang} t={t} exportFilename={`gia-waste-${date}`} minHeight="420px" />
      <Flash message={flash} />
    </div>
  );
}
