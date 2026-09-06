import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Boxes, Copy, ShoppingBag } from 'lucide-react';
import { Link } from 'wouter';
import { getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import {
  bulkSaveInventory,
  bulkSaveReceipts,
  closeWarehouseArchive,
  getWarehouseArchiveStatus,
  issueToKitchen,
  listLots,
  listReceipts,
  searchInventoryItems,
  type WarehouseLot,
} from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, formatIDR, inputClass, todayISO } from '@/lib/utils';

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
  const [issueActor, setIssueActor] = useState('');
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

  const lowCount = items.filter((i) => i.currentStock <= i.minimumStock).length;
  const stockValue = items.reduce((n, i) => n + (i.currentStock + (i.kitchenStock ?? 0)) * (i.costPerUnit || 0), 0);
  const archived = Boolean(statusQuery.data?.archived);

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
    if (!pickedItem || !issueActor.trim() || !(Number(issueQty) > 0)) {
      showFlash(t('saveFailed'));
      return;
    }
    setIssueBusy(true);
    try {
      await issueToKitchen({
        itemId: pickedItem.id,
        lotId: lotId ? Number(lotId) : null,
        quantity: Number(issueQty),
        actor: issueActor.trim(),
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
        description={t('masterCatalogDesc')}
        action={(
          <Link href="/warehouse-archive" className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            <Archive size={15} />{t('openArchive')}
          </Link>
        )}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label={t('items')} value={String(items.length).padStart(2, '0')} detail={t('warehouse')} icon={Boxes} />
        <Metric label={t('lowStock')} value={String(lowCount).padStart(2, '0')} detail={t('warehouseStock')} icon={AlertTriangle} />
        <Metric label={lang === 'id' ? 'Nilai persediaan' : 'قيمة المخزون'} value={formatIDR(stockValue)} detail={`${t('warehouse')} + ${t('kitchen')}`} icon={ShoppingBag} />
      </div>

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold">{t('masterCatalog')}</h2>
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
        <SpreadsheetGrid
          columns={columns}
          rows={rows}
          onRowsChange={handleMasterRowsChange}
          onSave={handleSaveMaster}
          saving={saving}
          lang={lang}
          t={t}
          exportFilename="gia-inventory-master"
          minHeight="360px"
        />
        <p className="mt-2 text-[11px] text-[hsl(var(--muted-foreground))]">
          {lang === 'id'
            ? 'Klik baris lalu salin kode QR dari kolom QR (untuk label / app nanti).'
            : 'انسخ رمز QR من عمود الرمز لطباعة الملصقات / التطبيق لاحقاً.'}
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

      <section className="panel soft-shadow p-5">
        <h2 className="text-sm font-bold">{t('issueToKitchen')}</h2>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{t('issueToKitchenDesc')}</p>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="relative">
            <label className="mb-1 block text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{t('searchItem')}</label>
            <input
              value={pickedItem ? `${pickedItem.name} · ${pickedItem.currentStock} ${pickedItem.unit}` : issueQuery}
              onChange={(e) => {
                setPickedItem(null);
                setIssueQuery(e.target.value);
              }}
              className={inputClass}
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
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{t('selectLot')}</label>
            {lots.length ? (
              <select value={lotId} onChange={(e) => setLotId(e.target.value)} className={inputClass}>
                {lots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.quantityRemaining} {pickedItem?.unit}
                    {lot.brand ? ` · ${lot.brand}` : ''}
                    {` · ${lot.receiptDate}`}
                  </option>
                ))}
              </select>
            ) : (
              <p className="rounded-xl border border-dashed border-[hsl(var(--border))] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">{t('noLots')}</p>
            )}
            {selectedLot ? (
              <p className="mt-1 text-[11px] text-[hsl(var(--muted-foreground))]">
                {t('lotRemaining')}: {selectedLot.quantityRemaining} · {t('brand')}: {selectedLot.brand || '—'}
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{t('quantity')}</label>
            <input type="number" min={0.01} step={0.1} value={issueQty} onChange={(e) => setIssueQty(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{t('actor')}</label>
            <input value={issueActor} onChange={(e) => setIssueActor(e.target.value)} className={inputClass} placeholder={lang === 'id' ? 'Nama petugas' : 'اسم المسؤول'} />
          </div>
          <div className="lg:col-span-2">
            <label className="mb-1 block text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">{t('note')}</label>
            <input value={issueNote} onChange={(e) => setIssueNote(e.target.value)} className={inputClass} />
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={issueBusy || !pickedItem}
            onClick={handleIssue}
            className="rounded-xl bg-[hsl(var(--primary))] px-5 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)] disabled:opacity-50"
          >
            {t('issueSave')}
          </button>
        </div>
      </section>

      <Flash message={flash} />
    </div>
  );
}
