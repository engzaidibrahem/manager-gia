import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Boxes, Copy, ShoppingBag } from 'lucide-react';
import { Link } from 'wouter';
import { getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import {
  FormField,
  FormSection,
  NumberInput,
  PageHint,
  PrimaryButton,
  SelectInput,
  TextInput,
} from '@/components/FormKit';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import {
  bulkSaveInventory,
  bulkSaveReceipts,
  closeWarehouseArchive,
  getWarehouseArchiveStatus,
  getWarehouseSummary,
  issueToKitchen,
  listLots,
  listReceipts,
  searchInventoryItems,
  type WarehouseLot,
} from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, formatIDR, todayISO } from '@/lib/utils';

type InvRow = {
  _key: string;
  _selected?: boolean;
  id?: number;
  name: string;
  category: string;
  unit: string;
  brand: string;
  currentStock: number | '';
  kitchenStock: number | '';
  minimumStock: number | '';
  costPerUnit: number | '';
  qrToken: string;
};

type ReceiptRow = {
  _key: string;
  _selected?: boolean;
  id?: number;
  itemId: string;
  brand: string;
  quantity: number | '';
  costPerUnit: number | '';
  actor: string;
  note: string;
  archived?: boolean;
};

type SearchHit = {
  id: number;
  name: string;
  category: string;
  unit: string;
  brand: string;
  currentStock: number;
  kitchenStock: number;
  qrToken: string;
};

function blankInv(): InvRow {
  return {
    _key: makeRowKey(), name: '', category: '', unit: 'kg', brand: '',
    currentStock: '', kitchenStock: '', minimumStock: '', costPerUnit: '', qrToken: '',
  };
}

function blankReceipt(items: { id: number }[]): ReceiptRow {
  return {
    _key: makeRowKey(),
    itemId: items[0] ? String(items[0].id) : '0',
    brand: '',
    quantity: '',
    costPerUnit: '',
    actor: '',
    note: '',
  };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function InventoryPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const date = todayISO();
  const itemsQuery = useListInventoryItems({});
  const items = (itemsQuery.data ?? []) as Array<{
    id: number; name: string; category: string; unit: string; brand?: string;
    currentStock: number; kitchenStock?: number; minimumStock: number; costPerUnit?: number; qrToken?: string;
  }>;

  const receiptsQuery = useQuery({ queryKey: ['receipts', date], queryFn: () => listReceipts(date) });
  const statusQuery = useQuery({ queryKey: ['warehouse-archive-status', date], queryFn: () => getWarehouseArchiveStatus(date) });
  const summaryQuery = useQuery({ queryKey: ['warehouse-summary'], queryFn: () => getWarehouseSummary() });

  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [receiptDeleteIds, setReceiptDeleteIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [receiptSaving, setReceiptSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [issueBusy, setIssueBusy] = useState(false);
  const [flash, setFlash] = useState('');

  // Smart issue-to-kitchen state
  const [issueQuery, setIssueQuery] = useState('');
  const [issueHits, setIssueHits] = useState<SearchHit[]>([]);
  const [pickedItem, setPickedItem] = useState<SearchHit | null>(null);
  const [lots, setLots] = useState<WarehouseLot[]>([]);
  const [lotId, setLotId] = useState<string>('');
  const [issueQty, setIssueQty] = useState<string>('');
  const [issueActor, setIssueActor] = useState(() => {
    try {
      const u = JSON.parse(localStorage.getItem('gia-auth-user') || 'null') as { fullName?: string; username?: string } | null;
      return u?.fullName || u?.username || '';
    } catch {
      return '';
    }
  });
  const [issueNote, setIssueNote] = useState('');

  const buildRows = useCallback(() => {
    const loaded: InvRow[] = items.map((item) => ({
      _key: `id-${item.id}`,
      id: item.id,
      name: item.name,
      category: item.category,
      unit: item.unit,
      brand: item.brand ?? '',
      currentStock: item.currentStock,
      kitchenStock: item.kitchenStock ?? 0,
      minimumStock: item.minimumStock,
      costPerUnit: item.costPerUnit ?? 0,
      qrToken: item.qrToken ?? '',
    }));
    return [...loaded, ...emptyRows(Math.max(0, 8 - loaded.length), blankInv)];
  }, [items]);

  const { rows, setRows, markDirty, markClean } = useGridSync(
    itemsQuery.dataUpdatedAt,
    itemsQuery.isFetched,
    buildRows,
  );

  const itemOptions = useMemo(() => [
    { value: '0', label: '—' },
    ...items.map((i) => ({ value: String(i.id), label: `${i.name} (${i.unit})` })),
  ], [items]);

  const buildReceiptRows = useCallback(() => {
    const loaded: ReceiptRow[] = (receiptsQuery.data ?? []).map((lot) => ({
      _key: `lot-${lot.id}`,
      id: lot.id,
      itemId: String(lot.itemId),
      brand: lot.brand || '',
      quantity: lot.quantityReceived,
      costPerUnit: lot.costPerUnit,
      actor: lot.actor || '',
      note: lot.note || '',
      archived: Boolean(lot.archiveId),
    }));
    return [...loaded, ...emptyRows(Math.max(0, 6 - loaded.length), () => blankReceipt(items))];
  }, [receiptsQuery.data, items]);

  const {
    rows: receiptRows,
    setRows: setReceiptRows,
    markDirty: markReceiptDirty,
    markClean: markReceiptClean,
  } = useGridSync(receiptsQuery.dataUpdatedAt, receiptsQuery.isFetched, buildReceiptRows);

  const columns: ColDef<InvRow>[] = useMemo(() => [
    { key: 'name', label: t('name'), width: '150px' },
    { key: 'category', label: t('category'), width: '110px' },
    { key: 'brand', label: t('brand'), width: '110px' },
    { key: 'unit', label: t('unit'), width: '70px' },
    { key: 'currentStock', label: t('warehouseStock'), type: 'number', min: 0, step: 0.1, width: '100px', readOnly: true },
    { key: 'kitchenStock', label: t('kitchenStock'), type: 'number', min: 0, step: 0.1, width: '100px', readOnly: true },
    { key: 'minimumStock', label: t('minimum'), type: 'number', min: 0, step: 0.1, width: '90px' },
    { key: 'costPerUnit', label: t('unitCost'), type: 'number', min: 0, width: '110px' },
    { key: 'qrToken', label: t('qrToken'), width: '140px', readOnly: true },
  ], [t]);

  const receiptCols: ColDef<ReceiptRow>[] = useMemo(() => [
    { key: 'itemId', label: t('name'), type: 'select', options: itemOptions, width: '200px' },
    { key: 'brand', label: t('brand'), width: '120px' },
    { key: 'quantity', label: t('receiptQty'), type: 'number', min: 0.01, step: 0.1, width: '100px' },
    { key: 'costPerUnit', label: t('unitCost'), type: 'number', min: 0, width: '110px' },
    { key: 'actor', label: t('actor'), width: '110px' },
    { key: 'note', label: t('note'), width: '140px' },
  ], [itemOptions, t]);

  const [statusFilter, setStatusFilter] = useState<'all' | 'low' | 'out' | 'ok'>('all');
  const [categoryFilter, setCategoryFilter] = useState('');

  const lowCount = items.filter((i) => i.currentStock > 0 && i.currentStock <= i.minimumStock).length;
  const outCount = items.filter((i) => i.currentStock <= 0).length;
  const warehouseValue = items.reduce((n, i) => n + i.currentStock * (i.costPerUnit || 0), 0);
  const archived = Boolean(statusQuery.data?.archived);

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category).filter(Boolean))].sort(),
    [items],
  );

  const displayRows = useMemo(() => {
    // When filtering, still include blank entry rows so user can add items
    const blanks = rows.filter((r) => !r.id && !r.name.trim());
    const data = rows.filter((r) => r.id || r.name.trim());
    const filtered = data.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false;
      const wh = num(r.currentStock);
      const min = num(r.minimumStock);
      if (statusFilter === 'out') return wh <= 0;
      if (statusFilter === 'low') return wh > 0 && wh <= min;
      if (statusFilter === 'ok') return wh > min;
      return true;
    });
    return statusFilter === 'all' && !categoryFilter ? rows : [...filtered, ...blanks];
  }, [rows, categoryFilter, statusFilter]);

  useEffect(() => {
    if (!issueQuery.trim()) {
      setIssueHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      searchInventoryItems(issueQuery.trim(), true)
        .then((rows) => setIssueHits(rows as unknown as SearchHit[]))
        .catch(() => setIssueHits([]));
    }, 220);
    return () => window.clearTimeout(handle);
  }, [issueQuery]);

  useEffect(() => {
    if (window.location.hash !== '#issue-to-kitchen') return;
    const id = window.setTimeout(() => {
      document.getElementById('issue-to-kitchen')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!pickedItem) {
      setLots([]);
      setLotId('');
      return;
    }
    listLots({ itemId: pickedItem.id, remaining: true })
      .then((rows) => {
        setLots(rows);
        setLotId(rows[0] ? String(rows[0].id) : '');
      })
      .catch(() => {
        setLots([]);
        setLotId('');
      });
  }, [pickedItem]);

  const showFlash = (msg: string, ms = 2500) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(''), ms);
  };

  const handleSaveMaster = async () => {
    setSaving(true);
    try {
      const payload = rows.filter((r) => r.name.trim()).map(({ _key, _selected, qrToken: _qr, ...rest }) => ({
        id: rest.id,
        name: rest.name,
        category: rest.category || 'General',
        unit: rest.unit || 'kg',
        brand: rest.brand,
        minimumStock: num(rest.minimumStock),
        costPerUnit: num(rest.costPerUnit),
        // Do not overwrite live stock from master grid (read-only display)
      }));
      await bulkSaveInventory(payload, deleteIds);
      setDeleteIds([]);
      markClean();
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) });
      showFlash(t('saved'));
    } catch {
      showFlash(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const receiptPayload = () => receiptRows
    .filter((r) => r.itemId !== '0' && num(r.quantity) > 0 && !r.archived)
    .map((r) => ({
      id: r.id,
      itemId: Number(r.itemId),
      receiptDate: date,
      brand: r.brand,
      quantity: num(r.quantity),
      costPerUnit: num(r.costPerUnit),
      actor: r.actor || 'warehouse',
      note: r.note,
    }));

  const handleSaveReceipts = async () => {
    setReceiptSaving(true);
    try {
      await bulkSaveReceipts(receiptPayload(), receiptDeleteIds);
      setReceiptDeleteIds([]);
      markReceiptClean();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['receipts', date] }),
        qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) }),
      ]);
      showFlash(t('saved'));
    } catch (err) {
      showFlash(err instanceof Error ? err.message : t('saveFailed'), 3500);
    } finally {
      setReceiptSaving(false);
    }
  };

  const handleCloseWarehouseDay = async () => {
    if (!window.confirm(t('closeWarehouseConfirm'))) return;
    setClosing(true);
    try {
      await closeWarehouseArchive({
        date,
        closedBy: 'warehouse',
        force: archived,
        rows: receiptPayload(),
      });
      setReceiptDeleteIds([]);
      markReceiptClean();
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['receipts', date] }),
        qc.invalidateQueries({ queryKey: ['warehouse-archive-status', date] }),
        qc.invalidateQueries({ queryKey: ['warehouse-archives'] }),
        qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) }),
      ]);
      showFlash(t('warehouseClosedOk'));
    } catch (err) {
      showFlash(err instanceof Error ? err.message : t('archiveFailed'), 3500);
    } finally {
      setClosing(false);
    }
  };

  const handleIssue = async () => {
    if (!pickedItem || !(Number(issueQty) > 0)) {
      showFlash(t('saveFailed'));
      return;
    }
    setIssueBusy(true);
    try {
      await issueToKitchen({
        itemId: pickedItem.id,
        lotId: lotId ? Number(lotId) : null,
        quantity: Number(issueQty),
        actor: issueActor.trim() || 'session',
        note: issueNote || undefined,
      });
      setIssueQuery('');
      setPickedItem(null);
      setIssueQty('');
      setIssueNote('');
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) });
      showFlash(t('saved'));
    } catch (err) {
      showFlash(err instanceof Error ? err.message : t('saveFailed'), 3500);
    } finally {
      setIssueBusy(false);
    }
  };

  const handleMasterRowsChange = (next: Parameters<typeof setRows>[0]) => {
    markDirty();
    setRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDeleteIds((ids) => [...ids, ...removed.map((r) => r.id!).filter((id) => !ids.includes(id))]);
      return resolved;
    });
  };

  const handleReceiptRowsChange = (next: Parameters<typeof setReceiptRows>[0]) => {
    markReceiptDirty();
    setReceiptRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !r.archived && !resolved.find((n) => n._key === r._key));
      setReceiptDeleteIds((ids) => [...ids, ...removed.map((r) => r.id!).filter((id) => !ids.includes(id))]);
      return resolved;
    });
  };

  const copyQr = async (token: string) => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showFlash(t('copyQr'));
    } catch {
      showFlash(token, 4000);
    }
  };

  const selectedLot = lots.find((l) => String(l.id) === lotId);

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / GUDANG"
        title={t('inventory')}
        description={t('inventoryDesc')}
        action={(
          <div className="flex flex-wrap gap-2">
            <Link href="/opening-balance" className="flex items-center gap-2 rounded-xl bg-[hsl(var(--primary))] px-3 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)]">
              {t('openingBalanceStock')}
            </Link>
            <Link href="/warehouse-archive" className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
              <Archive size={15} />{t('openArchive')}
            </Link>
          </div>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Ringkasan di bawah menunjukkan stok saat ini. Ubah jumlah lewat Saldo Awal, Penerimaan, atau Keluar ke dapur — bukan dengan mengedit angka stok langsung.'
          : 'الملخص أدناه يعرض ما لديك الآن. غيّر الكمية عبر الرصيد الافتتاحي أو الوارد أو الإخراج للمطبخ — وليس بتعديل رقم الرصيد مباشرة.'}
      </PageHint>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label={t('items')} value={String(items.length).padStart(2, '0')} detail={t('warehouse')} icon={Boxes} />
        <Metric label={t('lowStock')} value={String(lowCount).padStart(2, '0')} detail={t('warehouseStock')} icon={AlertTriangle} />
        <Metric label={t('outOfStock')} value={String(outCount).padStart(2, '0')} detail={t('warehouseStock')} icon={AlertTriangle} />
        <Metric label={t('stockValue')} value={formatIDR(warehouseValue)} detail={t('warehouseStock')} icon={ShoppingBag} tone="primary" />
      </div>

      <div className="panel soft-shadow mb-5 overflow-auto p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold">{lang === 'id' ? 'Ringkasan gudang (dari DB)' : 'ملخص المستودع (من قاعدة البيانات)'}</h2>
          <Link href="/purchases" className="text-xs font-bold text-[hsl(var(--primary))]">{t('receiveGoods')} →</Link>
        </div>
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]">
              <th className="px-2 py-2 text-start">{t('name')}</th>
              <th className="px-2 py-2 text-start">{t('beginningStock')}</th>
              <th className="px-2 py-2 text-start">{t('incomingStock')}</th>
              <th className="px-2 py-2 text-start">{t('outgoingStock')}</th>
              <th className="px-2 py-2 text-start">{t('waste')}</th>
              <th className="px-2 py-2 text-start">{t('currentBalance')}</th>
              <th className="px-2 py-2 text-start">{t('minimum')}</th>
            </tr>
          </thead>
          <tbody>
            {(summaryQuery.data ?? []).slice(0, 40).map((row) => (
              <tr key={row.id} className="border-b border-[hsl(var(--border)/.4)]">
                <td className="px-2 py-1.5 font-semibold">{row.name}</td>
                <td className="px-2 py-1.5 font-mono">{row.beginning}</td>
                <td className="px-2 py-1.5 font-mono">{row.incoming}</td>
                <td className="px-2 py-1.5 font-mono">{row.outgoing}</td>
                <td className="px-2 py-1.5 font-mono">{row.waste}</td>
                <td className="px-2 py-1.5 font-mono font-bold">{row.current} {row.unit}</td>
                <td className="px-2 py-1.5 font-mono">{row.minimumStock}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(summaryQuery.data?.some((r) => Math.abs(r.lotGap) > 0.01)) ? (
          <p className="mt-2 text-[11px] font-semibold text-[hsl(var(--destructive))]">
            {lang === 'id' ? 'Peringatan: ada selisih stok vs lots — cek stock integrity.' : 'تحذير: يوجد فرق بين الرصيد والدفعات.'}
          </p>
        ) : null}
      </div>

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-[200px] flex-1">
            <h2 className="text-sm font-bold">{t('masterCatalog')}</h2>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{t('masterCatalogDesc')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1.5 text-[11px] font-semibold"
            >
              <option value="">{t('category')}: {lang === 'id' ? 'Semua' : 'الكل'}</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2 py-1.5 text-[11px] font-semibold"
            >
              <option value="all">{t('stockStatus')}: {lang === 'id' ? 'Semua' : 'الكل'}</option>
              <option value="ok">{t('inStock')}</option>
              <option value="low">{t('lowStock')}</option>
              <option value="out">{t('outOfStock')}</option>
            </select>
            <button
              type="button"
              onClick={() => {
                const withQr = rows.find((r) => r.qrToken);
                if (withQr?.qrToken) copyQr(withQr.qrToken);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-[11px] font-bold hover:bg-[hsl(var(--muted))]"
            >
              <Copy size={13} />{t('copyQr')}
            </button>
          </div>
        </div>
        <SpreadsheetGrid
          columns={columns}
          rows={displayRows}
          onRowsChange={(updater) => {
            handleMasterRowsChange((prev) => {
              const visible = displayRows;
              const nextVisible = typeof updater === 'function' ? updater(visible) : updater;
              if (statusFilter === 'all' && !categoryFilter) return nextVisible;
              const byKey = new Map(nextVisible.map((r) => [r._key, r]));
              const merged = prev.map((r) => byKey.get(r._key) ?? r);
              for (const r of nextVisible) {
                if (!merged.some((m) => m._key === r._key)) merged.push(r);
              }
              const keptKeys = new Set(nextVisible.map((r) => r._key));
              // Removals from visible selection
              return merged.filter((r) => {
                const wasVisible = visible.some((v) => v._key === r._key);
                if (!wasVisible) return true;
                return keptKeys.has(r._key);
              });
            });
          }}
          onSave={handleSaveMaster}
          saving={saving}
          lang={lang}
          t={t}
          exportFilename="gia-inventory-master"
          minHeight="360px"
        />
        <p className="mt-2 text-[11px] text-[hsl(var(--muted-foreground))]">
          {lang === 'id'
            ? 'Warehouse Qty bersifat tampilan saja. Ubah stok lewat Saldo Awal / Terima / Transfer / Limbah / Penyesuaian. Low/Out memakai stok gudang saja.'
            : 'رصيد المستودع للعرض فقط. غيّر المخزون عبر الرصيد الافتتاحي / الاستلام / التحويل / الهدر / التسوية. حالة النقص تعتمد على المستودع فقط.'}
        </p>
      </section>
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">{t('dailyReceipts')} · {date}</h2>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{t('dailyReceiptsDesc')}</p>
            {archived ? (
              <p className="mt-1 text-xs font-semibold text-emerald-700">{t('warehouseDayArchived')}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={receiptSaving || archived}
              onClick={handleSaveReceipts}
              className="rounded-xl border border-[hsl(var(--border))] px-4 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))] disabled:opacity-50"
            >
              {t('saveAll')}
            </button>
            <button
              type="button"
              disabled={closing}
              onClick={handleCloseWarehouseDay}
              className="rounded-xl bg-[hsl(var(--primary))] px-4 py-2 text-xs font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)] disabled:opacity-60"
            >
              {archived ? t('rearchive') : t('closeWarehouseDay')}
            </button>
          </div>
        </div>
        <SpreadsheetGrid
          columns={receiptCols}
          rows={receiptRows}
          onRowsChange={handleReceiptRowsChange}
          onSave={handleSaveReceipts}
          saving={receiptSaving}
          lang={lang}
          t={t}
          exportFilename={`gia-receipts-${date}`}
          minHeight="280px"
        />
      </section>

      <FormSection
        id="issue-to-kitchen"
        className="scroll-mt-24 border-2 border-[hsl(var(--primary)/.35)]"
        title={t('issueToKitchen')}
        hint={t('issueToKitchenDesc')}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <FormField label={t('searchItem')} className="relative">
            <TextInput
              value={pickedItem ? `${pickedItem.name} · ${pickedItem.currentStock} ${pickedItem.unit}` : issueQuery}
              onChange={(e) => {
                setPickedItem(null);
                setIssueQuery(e.target.value);
              }}
              placeholder={t('searchItem')}
            />
            {!pickedItem && issueHits.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg">
                {issueHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-start text-xs hover:bg-[hsl(var(--muted))]"
                    onClick={() => {
                      setPickedItem(hit);
                      setIssueQuery('');
                      setIssueHits([]);
                    }}
                  >
                    <span className="font-semibold">{hit.name}{hit.brand ? ` · ${hit.brand}` : ''}</span>
                    <span className="number text-[hsl(var(--muted-foreground))]">{hit.currentStock} {hit.unit}</span>
                  </button>
                ))}
              </div>
            )}
          </FormField>

          <FormField
            label={t('selectLot')}
            hint={selectedLot ? `${t('lotRemaining')}: ${selectedLot.quantityRemaining} · ${t('brand')}: ${selectedLot.brand || '—'}` : undefined}
          >
            {lots.length ? (
              <SelectInput value={lotId} onChange={(e) => setLotId(e.target.value)}>
                {lots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.quantityRemaining} {pickedItem?.unit}
                    {lot.brand ? ` · ${lot.brand}` : ''}
                    {` · ${lot.receiptDate}`}
                  </option>
                ))}
              </SelectInput>
            ) : (
              <p className="rounded-xl border border-dashed border-[hsl(var(--border))] px-3 py-2.5 text-xs text-[hsl(var(--muted-foreground))]">{t('noLots')}</p>
            )}
          </FormField>

          <FormField label={t('quantity')} required>
            <NumberInput min={0.01} step={0.1} value={issueQty} onChange={(e) => setIssueQty(e.target.value)} />
          </FormField>
          <FormField label={t('actor')}>
            <TextInput value={issueActor} onChange={(e) => setIssueActor(e.target.value)} placeholder={lang === 'id' ? 'Nama petugas' : 'اسم المسؤول'} />
          </FormField>
          <FormField label={t('note')} className="lg:col-span-2">
            <TextInput value={issueNote} onChange={(e) => setIssueNote(e.target.value)} />
          </FormField>
        </div>

        <div className="flex justify-end">
          <PrimaryButton disabled={issueBusy || !pickedItem} onClick={handleIssue}>
            {t('issueSave')}
          </PrimaryButton>
        </div>
      </FormSection>

      <Flash message={flash} />
    </div>
  );
}
