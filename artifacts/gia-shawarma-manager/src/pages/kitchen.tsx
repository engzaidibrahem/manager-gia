import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';
import { getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveMovements } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { emptyRows, formatIDR, nowTime, todayISO } from '@/lib/utils';

type KitchenRow = {
  _key: string;
  _selected?: boolean;
  itemId: string;
  quantity: number | '';
  actor: string;
  note: string;
};

function blankRow(items: { id: number }[]): KitchenRow {
  return { _key: makeRowKey(), itemId: items[0] ? String(items[0].id) : '0', quantity: '', actor: '', note: '' };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function KitchenPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const itemsQuery = useListInventoryItems({});
  const items = (itemsQuery.data ?? []) as Array<{
    id: number; name: string; unit: string; kitchenStock?: number; costPerUnit?: number;
  }>;
  const [rows, setRows] = useState<KitchenRow[]>(() => emptyRows(15, () => blankRow([])));
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    if (items.length) {
      setRows((prev) => prev.map((r) => (r.itemId === '0' ? { ...r, itemId: String(items[0].id) } : r)));
    }
  }, [items.length]);

  const itemOptions = useMemo(() => [
    { value: '0', label: '—' },
    ...items.map((i) => ({
      value: String(i.id),
      label: `${i.name} · ${t('kitchenStock')} ${i.kitchenStock ?? 0} ${i.unit}`,
    })),
  ], [items, t]);

  const columns: ColDef<KitchenRow>[] = useMemo(() => [
    { key: 'itemId', label: t('name'), type: 'select', options: itemOptions, width: '260px' },
    { key: 'quantity', label: t('quantity'), type: 'number', min: 0.1, step: 0.1, width: '100px' },
    { key: 'actor', label: t('actor'), width: '140px' },
    { key: 'note', label: t('note'), width: '200px' },
  ], [itemOptions, t]);

  const kitchenValue = items.reduce((n, i) => n + (i.kitchenStock ?? 0) * (i.costPerUnit || 0), 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = rows
        .filter((r) => r.itemId !== '0' && num(r.quantity) > 0 && r.actor.trim())
        .map(({ _key, _selected, itemId, quantity, ...rest }) => ({
          ...rest,
          itemId: Number(itemId),
          quantity: num(quantity),
          type: 'kitchen' as const,
          location: 'kitchen' as const,
        }));
      await bulkSaveMovements(payload);
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) });
      setRows(emptyRows(15, () => blankRow(items)));
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / DAPUR" title={t('kitchen')} description={t('kitchenDesc')}
        action={<div className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-semibold">{todayISO()} · {nowTime()}</div>} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Metric label={t('items')} value={String(items.length)} detail={t('kitchenStock')} icon={Coffee} />
        <Metric label={lang === 'id' ? 'Nilai stok dapur' : 'قيمة مخزون المطبخ'} value={formatIDR(kitchenValue)} detail={t('today')} icon={Coffee} tone="primary" />
      </div>
      <SpreadsheetGrid columns={columns} rows={rows} onRowsChange={setRows} onSave={handleSave} saving={saving} lang={lang} t={t} exportFilename="gia-kitchen" minHeight="480px" />
      <Flash message={flash} />
    </div>
  );
}
