import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import { Link } from 'wouter';
import { getGetDashboardSummaryQueryKey, getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import {
  ChoiceCard,
  FormField,
  FormSection,
  Modal,
  NumberInput,
  PageHint,
  PrimaryButton,
  ReadOnlyValue,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/FormKit';
import { Flash, PageTitle } from '@/components/layout';
import {
  cancelDailyPurchase,
  getDayArchiveStatus,
  listPurchases,
  recordDailyPurchase,
} from '@/lib/bulk-api';
import { displayCategory, displayDestination, displayUnit } from '@/lib/display-labels';
import { useT, type Lang } from '@/lib/i18n';
import { formatBusinessDate, formatIDR, todayISO } from '@/lib/utils';

type DestFilter = 'all' | 'warehouse' | 'none';

type Purchase = {
  id: number;
  purchaseDate: string;
  itemName: string;
  category: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalAmount: number;
  supplier: string;
  paymentMethod: string;
  destination: string;
  status: string;
  paymentStatus?: string;
  notes?: string | null;
};

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

function newClientRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `pur-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function PurchasesPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [filter, setFilter] = useState<DestFilter>('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [flash, setFlash] = useState('');
  const [fieldError, setFieldError] = useState('');

  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState('umum');
  const [quantity, setQuantity] = useState<number | ''>('');
  const [unit, setUnit] = useState('kg');
  const [unitPrice, setUnitPrice] = useState<number | ''>('');
  const [supplier, setSupplier] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Transfer');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'unpaid'>('paid');
  const [destination, setDestination] = useState<'warehouse' | 'none'>('warehouse');
  const [inventoryItemId, setInventoryItemId] = useState('0');
  const [notes, setNotes] = useState('');

  const itemsQuery = useListInventoryItems({});
  const items = itemsQuery.data ?? [];
  const purchasesQuery = useQuery({
    queryKey: ['purchases', date],
    queryFn: () => listPurchases(date),
    refetchOnMount: 'always',
  });
  const statusQuery = useQuery({ queryKey: ['day-archive-status', date], queryFn: () => getDayArchiveStatus(date) });

  const purchases = (purchasesQuery.data ?? []) as unknown as Purchase[];
  const archived = Boolean(statusQuery.data?.archived);

  const activePurchases = useMemo(
    () => purchases.filter((p) => String(p.status) !== 'cancelled'),
    [purchases],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activePurchases.filter((p) => {
      const dest = String(p.destination ?? 'none');
      if (filter === 'warehouse' && dest !== 'warehouse' && dest !== 'kitchen') return false;
      if (filter === 'none' && dest !== 'none') return false;
      if (q && !String(p.itemName).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [activePurchases, filter, search]);

  const totalAll = activePurchases.reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const totalWh = activePurchases
    .filter((p) => p.destination === 'warehouse' || p.destination === 'kitchen')
    .reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const totalNormal = activePurchases
    .filter((p) => p.destination === 'none')
    .reduce((s, p) => s + Number(p.totalAmount || 0), 0);

  const lineTotal = num(quantity) * num(unitPrice);

  async function refresh() {
    await Promise.all([
      purchasesQuery.refetch(),
      qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) }),
      qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey({ date }) }),
      qc.invalidateQueries({ queryKey: ['available-summary'] }),
      qc.invalidateQueries({ queryKey: ['day-archive-status', date] }),
    ]);
  }

  function resetForm() {
    setItemName('');
    setCategory('umum');
    setQuantity('');
    setUnit(destination === 'none' ? 'pcs' : 'kg');
    setUnitPrice('');
    setSupplier('');
    setPaymentMethod('Transfer');
    setPaymentStatus('paid');
    setInventoryItemId('0');
    setNotes('');
    setFieldError('');
  }

  function openForm() {
    resetForm();
    setDestination('warehouse');
    setUnit('kg');
    setShowForm(true);
  }

  const handleSave = async () => {
    if (!itemName.trim() || !(num(quantity) > 0) || unitPrice === '' || Number(unitPrice) < 0 || !supplier.trim()) {
      setFieldError(lang === 'id' ? 'Isi nama, qty, harga, dan supplier.' : 'أدخل الاسم والكمية والسعر والمورد.');
      return;
    }
    setSaving(true);
    try {
      const result = await recordDailyPurchase({
        destination,
        itemName: itemName.trim(),
        category: category.trim() || 'umum',
        quantity: num(quantity),
        unit: inventoryItemId !== '0'
          ? (items.find((i) => String(i.id) === inventoryItemId)?.unit || unit)
          : (unit.trim() || (destination === 'none' ? 'pcs' : 'kg')),
        unitPrice: num(unitPrice),
        supplier: supplier.trim(),
        paymentMethod,
        paymentStatus,
        purchaseDate: date,
        notes: notes.trim() || undefined,
        inventoryItemId: destination === 'warehouse' && inventoryItemId !== '0'
          ? Number(inventoryItemId)
          : null,
        clientRequestId: newClientRequestId(),
      });
      resetForm();
      setShowForm(false);
      await refresh();
      const avail = Number((result as { availableCapital?: number }).availableCapital ?? 0);
      setFlash(lang === 'id'
        ? `Tersimpan. Modal tersedia: ${formatIDR(avail)}`
        : `تم الحفظ. رأس المال المتاح: ${formatIDR(avail)}`);
      window.setTimeout(() => setFlash(''), 4000);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (p: Purchase) => {
    if (!window.confirm(t('cancelPurchaseConfirm'))) return;
    setCancellingId(p.id);
    try {
      await cancelDailyPurchase(p.id, lang === 'id' ? 'Dibatalkan dari halaman pembelian' : 'أُلغي من صفحة المشتريات');
      await refresh();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 4500);
    } finally {
      setCancellingId(null);
    }
  };

  const statusLabel = (p: Purchase) => {
    if (p.status === 'cancelled') return lang === 'id' ? 'Dibatalkan' : 'ملغى';
    if (p.paymentStatus === 'paid') return t('paymentPaid');
    return t('paymentUnpaid');
  };

  const canCancel = (p: Purchase) => {
    if (p.status === 'cancelled') return false;
    if (p.status === 'received' || p.status === 'partially_received') return false;
    return true;
  };

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / PEMBELIAN"
        title={t('purchases')}
        action={(
          <label className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold">
            <CalendarDays size={15} />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none" />
          </label>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Catat semua pembelian hari ini, lalu pilih apakah masuk gudang atau pembelian biasa.'
          : 'سجّل هنا كل ما تم شراؤه اليوم، ثم حدد هل يدخل إلى المستودع أم هو شراء عادي.'}
      </PageHint>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={openForm}>{t('addPurchase')}</PrimaryButton>
        <Link href="/archives">
          <SecondaryButton>{t('archives')}</SecondaryButton>
        </Link>
        {archived ? (
          <span className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-700">
            {t('dayArchived')} · {formatBusinessDate(date, lang === 'id' ? 'id-ID' : 'ar-SA')}
          </span>
        ) : null}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <FormSection className="!p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">{t('purchaseTotalToday')}</div>
          <div className="number mt-2 text-xl font-semibold">{formatIDR(totalAll)}</div>
        </FormSection>
        <FormSection className="!p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">{t('purchaseToWarehouse')}</div>
          <div className="number mt-2 text-xl font-semibold">{formatIDR(totalWh)}</div>
        </FormSection>
        <FormSection className="!p-4">
          <div className="text-xs text-[hsl(var(--muted-foreground))]">{t('purchaseNormalTotal')}</div>
          <div className="number mt-2 text-xl font-semibold">{formatIDR(totalNormal)}</div>
        </FormSection>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([
          ['all', t('filterAll')],
          ['warehouse', t('destWarehouse')],
          ['none', t('destNormal')],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-xl px-3 py-2 text-xs font-bold ${filter === key ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]'}`}
          >
            {label}
          </button>
        ))}
        <TextInput
          className="ms-auto max-w-[220px]"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <FormSection>
        {purchasesQuery.isLoading ? (
          <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">...</p>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
            {lang === 'id' ? 'Belum ada pembelian hari ini.' : 'لا مشتريات اليوم.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-start text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  <th className="pb-2 pe-2 font-semibold">{t('date')}</th>
                  <th className="pb-2 pe-2 font-semibold">{lang === 'id' ? 'Nama' : 'اسم المشتريات'}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('category')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('quantity')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('unit')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('unitPrice')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('totalAmount')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('supplier')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('destination')}</th>
                  <th className="pb-2 pe-2 font-semibold">{t('status')}</th>
                  <th className="pb-2 font-semibold">{t('action')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-[hsl(var(--border))]/60">
                    <td className="py-2.5 pe-2 font-mono">{String(p.purchaseDate).slice(0, 10)}</td>
                    <td className="py-2.5 pe-2 font-semibold">{p.itemName}</td>
                    <td className="py-2.5 pe-2">{displayCategory(p.category, lang)}</td>
                    <td className="py-2.5 pe-2 font-mono">{Number(p.quantity)}</td>
                    <td className="py-2.5 pe-2">{displayUnit(p.unit, lang)}</td>
                    <td className="py-2.5 pe-2 font-mono">{formatIDR(Number(p.unitPrice))}</td>
                    <td className="py-2.5 pe-2 font-mono font-bold">{formatIDR(Number(p.totalAmount))}</td>
                    <td className="py-2.5 pe-2">{p.supplier}</td>
                    <td className="py-2.5 pe-2">
                      <span className={`inline-block rounded-lg px-2 py-1 text-[10px] font-bold ${(p.destination === 'warehouse' || p.destination === 'kitchen') ? 'bg-[hsl(var(--secondary))]' : 'bg-[hsl(var(--muted))]'}`}>
                        {displayDestination(String(p.destination), lang)}
                      </span>
                    </td>
                    <td className="py-2.5 pe-2">{statusLabel(p)}</td>
                    <td className="py-2.5">
                      {canCancel(p) ? (
                        <SecondaryButton className="px-2.5 py-1 text-[10px]" disabled={cancellingId === p.id} onClick={() => void handleCancel(p)}>
                          {cancellingId === p.id ? '...' : t('cancelPurchase')}
                        </SecondaryButton>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FormSection>

      {showForm ? (
        <Modal title={t('addPurchase')} onClose={() => setShowForm(false)} wide>
          <div className="mb-4">
            <p className="mb-2 text-xs font-bold text-[hsl(var(--muted-foreground))]">{t('destination')}</p>
            <div className="flex flex-wrap gap-2">
              <ChoiceCard
                selected={destination === 'warehouse'}
                title={t('destWarehouse')}
                subtitle={lang === 'id' ? 'Masuk ke stok gudang' : 'يدخل إلى المخزون'}
                onClick={() => { setDestination('warehouse'); if (unit === 'pcs') setUnit('kg'); }}
              />
              <ChoiceCard
                selected={destination === 'none'}
                title={t('destNormal')}
                subtitle={lang === 'id' ? 'Tidak masuk inventori' : 'لا يدخل للمخزون'}
                onClick={() => { setDestination('none'); setInventoryItemId('0'); setUnit('pcs'); }}
              />
            </div>
            <p className="mt-2 text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">
              {destination === 'warehouse'
                ? (lang === 'id' ? 'Kuantitas ini akan menambah stok gudang.' : 'سيتم إضافة هذه الكمية إلى رصيد المستودع.')
                : (lang === 'id' ? 'Pembelian dicatat saja, tidak muncul di inventori.' : 'سيتم تسجيل الشراء فقط ولن يظهر في المخزون.')}
            </p>
          </div>

          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            {lang === 'id' ? 'Info pembelian' : 'معلومات الشراء'}
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <FormField label={lang === 'id' ? 'Nama pembelian' : 'اسم المشتريات'} required className="sm:col-span-2" error={fieldError}>
              <TextInput value={itemName} placeholder={lang === 'id' ? 'Contoh: beras' : 'مثال: أرز'} onChange={(e) => { setItemName(e.target.value); setFieldError(''); }} />
            </FormField>
            <FormField label={t('category')}>
              <SelectInput value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="umum">{displayCategory('umum', lang)}</option>
                <option value="bahan">{displayCategory('bahan', lang)}</option>
                <option value="daging">{displayCategory('daging', lang)}</option>
                <option value="office">{displayCategory('office', lang)}</option>
                <option value="other">{displayCategory('other', lang)}</option>
              </SelectInput>
            </FormField>
            <FormField label={t('quantity')} required>
              <NumberInput min={0.01} step={0.01} value={quantity} placeholder="0" onChange={(e) => setQuantity(e.target.value === '' ? '' : Number(e.target.value))} />
            </FormField>
            <FormField label={t('unit')}>
              {destination === 'none' ? (
                <SelectInput value={unit} onChange={(e) => setUnit(e.target.value)}>
                  <option value="pcs">{displayUnit('pcs', lang)}</option>
                  <option value="box">{displayUnit('box', lang)}</option>
                  <option value="pack">{displayUnit('pack', lang)}</option>
                  <option value="service">{displayUnit('service', lang)}</option>
                  <option value="other">{lang === 'id' ? 'Lainnya' : 'أخرى'}</option>
                </SelectInput>
              ) : (
                <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} disabled={inventoryItemId !== '0'} placeholder="kg" />
              )}
            </FormField>
            <FormField label={t('unitPrice')} required>
              <NumberInput min={0} step={1} value={unitPrice} placeholder="0" onChange={(e) => setUnitPrice(e.target.value === '' ? '' : Number(e.target.value))} />
            </FormField>
            <FormField label={t('totalAmount')}>
              <ReadOnlyValue>{formatIDR(lineTotal)}</ReadOnlyValue>
            </FormField>
          </div>

          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            {lang === 'id' ? 'Detail' : 'تفاصيل'}
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <FormField label={t('supplier')} required>
              <TextInput value={supplier} placeholder={lang === 'id' ? 'Nama supplier' : 'اسم المورد'} onChange={(e) => setSupplier(e.target.value)} />
            </FormField>
            <FormField label={t('paymentMethod')}>
              <SelectInput value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option value="Transfer">{t('paymentTransfer')}</option>
                <option value="Cash">{t('paymentCash')}</option>
                <option value="QRIS">{t('paymentQris')}</option>
                <option value="Debit">{t('paymentDebit')}</option>
              </SelectInput>
            </FormField>
            <FormField label={t('paymentStatusLabel')}>
              <SelectInput value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as 'paid' | 'unpaid')}>
                <option value="paid">{t('paymentPaid')}</option>
                <option value="unpaid">{t('paymentUnpaid')}</option>
              </SelectInput>
            </FormField>
            <FormField label={t('note')}>
              <TextInput value={notes} placeholder={lang === 'id' ? 'Opsional' : 'اختياري'} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </div>

          {destination === 'warehouse' ? (
            <FormField label={t('existingWarehouseItem')} className="mb-4">
              <SelectInput
                value={inventoryItemId}
                onChange={(e) => {
                  const id = e.target.value;
                  setInventoryItemId(id);
                  const linked = items.find((i) => String(i.id) === id);
                  if (linked) {
                    setItemName(linked.name);
                    setUnit(linked.unit);
                    setCategory(linked.category || category);
                    if (unitPrice === '' || unitPrice === 0) setUnitPrice(Number(linked.costPerUnit || 0));
                  }
                }}
              >
                <option value="0">{t('newWarehouseItem')}</option>
                {items.map((i) => (
                  <option key={i.id} value={String(i.id)}>{i.name} · {displayUnit(i.unit, lang)}</option>
                ))}
              </SelectInput>
            </FormField>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <SecondaryButton onClick={() => setShowForm(false)}>{t('cancel')}</SecondaryButton>
            <PrimaryButton disabled={saving} onClick={() => void handleSave()}>
              {saving ? '...' : (lang === 'id' ? 'Simpan pembelian' : 'حفظ المشتريات')}
            </PrimaryButton>
          </div>
        </Modal>
      ) : null}

      <Flash message={flash} />
    </div>
  );
}
