import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ShoppingBag } from 'lucide-react';
import { Link } from 'wouter';
import { getGetDashboardSummaryQueryKey, getListExpensesQueryKey, getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSavePurchases, listPurchases } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, formatIDR, nowTime, todayISO } from '@/lib/utils';

type PurchaseRow = {
  _key: string;
  _selected?: boolean;
  id?: number;
  purchaseDate: string;
  purchaseTime: string;
  supplier: string;
  itemName: string;
  category: string;
  quantity: number | '';
  unit: string;
  unitPrice: number | '';
  paidBy: string;
  receivedBy: string;
  paymentMethod: string;
  inventoryItemId: string;
  destination: string;
  notes: string;
};

function blankRow(date: string): PurchaseRow {
  return {
    _key: makeRowKey(), purchaseDate: date, purchaseTime: nowTime(), supplier: '', itemName: '', category: '',
    quantity: '', unit: 'kg', unitPrice: '', paidBy: 'Staff', receivedBy: 'Gudang', paymentMethod: 'Cash',
    inventoryItemId: '0', destination: 'warehouse', notes: '',
  };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function PurchasesPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const itemsQuery = useListInventoryItems({});
  const items = itemsQuery.data ?? [];
  const purchasesQuery = useQuery({ queryKey: ['purchases', date], queryFn: () => listPurchases(date) });
  const purchases = purchasesQuery.data ?? [];
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  const buildRows = useCallback(() => {
    const loaded: PurchaseRow[] = purchases.map((p) => ({
      _key: `id-${p.id}`,
      id: Number(p.id),
      purchaseDate: String(p.purchaseDate),
      purchaseTime: String(p.purchaseTime ?? ''),
      supplier: String(p.supplier),
      itemName: String(p.itemName),
      category: String(p.category),
      quantity: Number(p.quantity),
      unit: String(p.unit),
      unitPrice: Number(p.unitPrice),
      paidBy: String(p.paidBy || 'Staff'),
      receivedBy: String(p.receivedBy || 'Gudang'),
      paymentMethod: String(p.paymentMethod),
      inventoryItemId: String(p.inventoryItemId ?? '0'),
      destination: String(p.destination ?? (p.addToStock === 'no' ? 'none' : 'warehouse')),
      notes: String(p.notes ?? ''),
    }));
    return [...loaded, ...emptyRows(Math.max(0, 10 - loaded.length), () => blankRow(date))];
  }, [purchases, date]);

  const { rows, setRows, markDirty, markClean } = useGridSync(
    `${date}-${purchasesQuery.dataUpdatedAt}`,
    purchasesQuery.isFetched,
    buildRows,
  );

  const paymentOptions = useMemo(() => [
    { value: 'Cash', label: t('paymentCash') },
    { value: 'Transfer', label: t('paymentTransfer') },
    { value: 'QRIS', label: t('paymentQris') },
    { value: 'Debit', label: t('paymentDebit') },
  ], [lang, t]);

  const destOptions = useMemo(() => [
    { value: 'warehouse', label: t('destWarehouse') },
    { value: 'kitchen', label: t('destKitchen') },
    { value: 'none', label: t('destNone') },
  ], [t]);

  const itemOptions = useMemo(() => [
    { value: '0', label: '—' },
    ...items.map((i) => ({ value: String(i.id), label: `${i.name} (${i.unit})` })),
  ], [items]);

  const itemById = useMemo(() => {
    const map = new Map(items.map((i) => [String(i.id), i]));
    return map;
  }, [items]);

  const columns: ColDef<PurchaseRow>[] = useMemo(() => [
    { key: 'purchaseDate', label: t('date'), type: 'date', width: '130px' },
    { key: 'purchaseTime', label: t('time'), type: 'time', width: '90px' },
    { key: 'supplier', label: t('supplier'), width: '120px' },
    { key: 'itemName', label: t('name'), width: '140px' },
    { key: 'category', label: t('category'), width: '100px' },
    { key: 'quantity', label: t('quantity'), type: 'number', min: 0, step: 0.1, width: '80px' },
    { key: 'unit', label: t('unit'), width: '70px' },
    { key: 'unitPrice', label: t('unitPrice'), type: 'number', min: 0, width: '100px' },
    { key: 'destination', label: t('destination'), type: 'select', options: destOptions, width: '140px' },
    { key: 'inventoryItemId', label: t('itemRef'), type: 'select', options: itemOptions, width: '160px' },
    { key: 'paidBy', label: t('paidBy'), width: '100px' },
    { key: 'receivedBy', label: t('receivedBy'), width: '100px' },
    { key: 'paymentMethod', label: t('paymentMethod'), type: 'select', options: paymentOptions, width: '100px' },
    { key: 'notes', label: t('note'), width: '120px' },
  ], [destOptions, itemOptions, paymentOptions, t]);

  const total = purchases.reduce((n, p) => n + Number(p.totalAmount ?? 0), 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      const incomplete = rows.filter((r) => r.itemName.trim() && r.supplier.trim() && r.destination !== 'none' && r.inventoryItemId === '0');
      if (incomplete.length) {
        setFlash(lang === 'id'
          ? 'Pilih referensi item gudang untuk baris yang masuk stok.'
          : 'اختر مرجع صنف المستودع للصفوف التي تدخل المخزون.');
        window.setTimeout(() => setFlash(''), 4000);
        setSaving(false);
        return;
      }

      const payload = rows
        .filter((r) => r.itemName.trim() && r.supplier.trim())
        .map(({ _key, _selected, quantity, unitPrice, ...rest }) => {
          const linked = rest.inventoryItemId !== '0' ? itemById.get(rest.inventoryItemId) : undefined;
          const category = rest.category.trim() || linked?.category || (lang === 'id' ? 'Umum' : 'عام');
          const paidBy = rest.paidBy.trim() || 'Staff';
          const receivedBy = rest.receivedBy.trim() || 'Gudang';
          return {
            ...rest,
            category,
            paidBy,
            receivedBy,
            unit: rest.unit.trim() || linked?.unit || 'kg',
            quantity: num(quantity),
            unitPrice: num(unitPrice),
            inventoryItemId: rest.destination !== 'none' && rest.inventoryItemId !== '0'
              ? Number(rest.inventoryItemId)
              : undefined,
            totalAmount: num(quantity) * num(unitPrice),
            syncExpense: !rest.id,
          };
        });
      await bulkSavePurchases(payload, deleteIds);
      setDeleteIds([]);
      markClean();
      await purchasesQuery.refetch();
      await qc.invalidateQueries({ queryKey: getListExpensesQueryKey({ date, limit: 200 }) });
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

      // When inventory item is chosen, auto-fill name / category / unit / price if empty
      return resolved.map((row, i) => {
        const before = prev[i];
        if (!before || before.inventoryItemId === row.inventoryItemId || row.inventoryItemId === '0') return row;
        const linked = itemById.get(row.inventoryItemId);
        if (!linked) return row;
        return {
          ...row,
          itemName: row.itemName.trim() || linked.name,
          category: row.category.trim() || linked.category,
          unit: linked.unit || row.unit,
          unitPrice: row.unitPrice === '' || row.unitPrice === 0
            ? (linked.costPerUnit ?? row.unitPrice)
            : row.unitPrice,
        };
      });
    });
  };

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / PEMBELIAN" title={t('purchases')} description={t('purchasesDesc')}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold"><CalendarDays size={15} /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none" /></label>
            <Link href="/archives" className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">{t('archives')}</Link>
          </div>
        )} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <Metric label={t('purchasesTotal')} value={formatIDR(total)} detail={t('today')} icon={ShoppingBag} tone="primary" />
        <Metric label={t('purchaseCount')} value={String(purchases.length)} detail={t('destination')} icon={ShoppingBag} />
      </div>
      <SpreadsheetGrid columns={columns} rows={rows} onRowsChange={handleRowsChange} onSave={handleSave} saving={saving} lang={lang} t={t} exportFilename={`gia-purchases-${date}`} minHeight="520px" />
      <Flash message={flash} />
    </div>
  );
}
