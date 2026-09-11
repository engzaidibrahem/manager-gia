import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { getListInventoryItemsQueryKey, useListInventoryItems } from '@workspace/api-client-react';
import {
  FormField,
  FormSection,
  Modal,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/FormKit';
import { Flash, PageTitle } from '@/components/layout';
import { postOpeningBalance } from '@/lib/bulk-api';
import { displayCategory, displayUnit } from '@/lib/display-labels';
import { useT, type Lang } from '@/lib/i18n';
import { formatIDR, todayISO } from '@/lib/utils';

type OpeningLine = {
  key: string;
  itemId: string;
  quantity: number | '';
  unitCost: number | '';
  note: string;
};

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

function newClientRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `ob-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function newKey() {
  return `ob-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function OpeningBalancePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const itemsQuery = useListInventoryItems({});
  const items = (itemsQuery.data ?? []) as Array<{
    id: number;
    name: string;
    category: string;
    unit: string;
    costPerUnit?: number;
    currentStock?: number;
  }>;

  const [lines, setLines] = useState<OpeningLine[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [asOfDate, setAsOfDate] = useState(todayISO());
  const [batchNotes, setBatchNotes] = useState('');
  const [itemId, setItemId] = useState('0');
  const [quantity, setQuantity] = useState<number | ''>('');
  const [unitCost, setUnitCost] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [flash, setFlash] = useState('');
  const [clientRequestId] = useState(newClientRequestId);
  const [fieldError, setFieldError] = useState('');

  const itemById = useMemo(() => new Map(items.map((i) => [String(i.id), i])), [items]);
  const selectedItem = itemById.get(itemId);

  const prepared = useMemo(() => lines
    .filter((r) => r.itemId !== '0' && num(r.quantity) > 0)
    .map((r) => {
      const item = itemById.get(r.itemId);
      const qty = num(r.quantity);
      const cost = num(r.unitCost);
      return {
        key: r.key,
        itemId: Number(r.itemId),
        name: item?.name ?? `#${r.itemId}`,
        category: item?.category ?? '',
        unit: item?.unit ?? '',
        quantity: qty,
        unitCost: cost,
        total: qty * cost,
        note: r.note,
      };
    }), [lines, itemById]);

  const grandTotal = prepared.reduce((n, r) => n + r.total, 0);
  const emptyCatalog = !itemsQuery.isLoading && items.length === 0;
  const lineValue = num(quantity) * num(unitCost);

  const openForm = () => {
    const first = items[0];
    setItemId(first ? String(first.id) : '0');
    setQuantity('');
    setUnitCost(first?.costPerUnit ?? '');
    setNote('');
    setFieldError('');
    setShowForm(true);
  };

  const addToList = () => {
    if (itemId === '0' || !(num(quantity) > 0)) {
      setFieldError(lang === 'id' ? 'Pilih bahan dan isi kuantitas.' : 'اختر مادة وأدخل الكمية.');
      return;
    }
    setLines((prev) => [...prev, {
      key: newKey(),
      itemId,
      quantity,
      unitCost: unitCost === '' ? 0 : unitCost,
      note,
    }]);
    setShowForm(false);
  };

  const handleConfirm = async () => {
    setSaving(true);
    try {
      const result = await postOpeningBalance({
        lines: prepared.map((p) => ({
          itemId: p.itemId,
          quantity: p.quantity,
          unit: p.unit,
          unitCost: p.unitCost,
          note: p.note || undefined,
        })),
        asOfDate,
        notes: batchNotes || undefined,
        clientRequestId,
      });
      setConfirmOpen(false);
      setLines([]);
      await qc.invalidateQueries({ queryKey: getListInventoryItemsQueryKey({}) });
      setFlash(lang === 'id'
        ? `Tersimpan: ${result.lineCount} item · ${formatIDR(result.totalValue)}`
        : `تم الحفظ: ${result.lineCount} صنف · ${formatIDR(result.totalValue)}`);
      window.setTimeout(() => setFlash(''), 4000);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / OPENING"
        title={t('openingBalanceStock')}
        action={(
          <Link href="/inventory" className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            {t('inventory')}
          </Link>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Gunakan halaman ini sekali untuk mencatat bahan dan kuantitas yang sudah ada di gudang saat mulai memakai sistem.'
          : 'استخدم هذه الصفحة مرة واحدة لتسجيل المواد والكميات الموجودة فعليًا في المستودع عند بدء استخدام النظام.'}
      </PageHint>
      <p className="mb-5 text-xs font-semibold text-[hsl(var(--muted-foreground))]">
        {lang === 'id'
          ? 'Setelah saldo awal tersimpan, gunakan «Pembelian Harian» untuk barang baru.'
          : 'بعد تسجيل رصيد الافتتاح، استخدم «مشتريات اليوم» لإضافة أي بضاعة جديدة.'}
      </p>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PrimaryButton onClick={openForm} disabled={emptyCatalog}>
          {lang === 'id' ? '+ Tambah bahan' : '+ إضافة مادة'}
        </PrimaryButton>
        <FormField label={t('date')} className="min-w-[160px]">
          <TextInput type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </FormField>
        <div className="ms-auto rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 text-sm font-bold">
          {formatIDR(grandTotal)}
        </div>
      </div>

      <FormSection title={lang === 'id' ? 'Daftar saldo awal' : 'قائمة رصيد الافتتاح'}>
        {lines.length === 0 ? (
          <p className="py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
            {lang === 'id' ? 'Belum ada bahan. Tekan + Tambah bahan.' : 'لا مواد بعد. اضغط + إضافة مادة.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-start text-xs">
              <thead>
                <tr className="border-b border-[hsl(var(--border))] text-[10px] uppercase text-[hsl(var(--muted-foreground))]">
                  <th className="pb-2 pe-2">{lang === 'id' ? 'Bahan' : 'المادة'}</th>
                  <th className="pb-2 pe-2">{t('quantity')}</th>
                  <th className="pb-2 pe-2">{t('unit')}</th>
                  <th className="pb-2 pe-2">{t('unitCost')}</th>
                  <th className="pb-2 pe-2">{lang === 'id' ? 'Total nilai' : 'إجمالي القيمة'}</th>
                  <th className="pb-2 pe-2">{t('status')}</th>
                  <th className="pb-2">{t('action')}</th>
                </tr>
              </thead>
              <tbody>
                {prepared.map((p) => (
                  <tr key={p.key} className="border-b border-[hsl(var(--border))]/60">
                    <td className="py-2.5 pe-2 font-semibold">
                      {p.name}
                      <div className="text-[10px] font-normal text-[hsl(var(--muted-foreground))]">{displayCategory(p.category, lang)}</div>
                    </td>
                    <td className="py-2.5 pe-2 font-mono">{p.quantity}</td>
                    <td className="py-2.5 pe-2">{displayUnit(p.unit, lang)}</td>
                    <td className="py-2.5 pe-2 font-mono">{formatIDR(p.unitCost)}</td>
                    <td className="py-2.5 pe-2 font-mono font-bold">{formatIDR(p.total)}</td>
                    <td className="py-2.5 pe-2">{lang === 'id' ? 'Siap disimpan' : 'جاهز للحفظ'}</td>
                    <td className="py-2.5">
                      <SecondaryButton className="px-2.5 py-1 text-[10px]" onClick={() => setLines((prev) => prev.filter((r) => r.key !== p.key))}>
                        {t('cancel')}
                      </SecondaryButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {prepared.length > 0 ? (
          <div className="flex justify-end pt-2">
            <PrimaryButton onClick={() => setConfirmOpen(true)}>{t('reviewConfirm')}</PrimaryButton>
          </div>
        ) : null}
      </FormSection>

      {showForm ? (
        <Modal title={lang === 'id' ? 'Tambah bahan ke saldo awal' : 'إضافة مادة إلى رصيد الافتتاح'} onClose={() => setShowForm(false)}>
          <div className="space-y-3">
            <FormField label={lang === 'id' ? 'Bahan' : 'المادة'} required error={fieldError}>
              <SelectInput
                value={itemId}
                onChange={(e) => {
                  const id = e.target.value;
                  setItemId(id);
                  const linked = itemById.get(id);
                  if (linked) setUnitCost(linked.costPerUnit ?? '');
                  setFieldError('');
                }}
              >
                <option value="0">{lang === 'id' ? 'Pilih bahan…' : 'اختر مادة…'}</option>
                {items.map((i) => (
                  <option key={i.id} value={String(i.id)}>{i.name} · {displayCategory(i.category, lang)}</option>
                ))}
              </SelectInput>
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('quantity')} required>
                <NumberInput min={0.01} step={0.01} value={quantity} placeholder="0" onChange={(e) => setQuantity(e.target.value === '' ? '' : Number(e.target.value))} />
              </FormField>
              <FormField label={t('unit')}>
                <div className="flex min-h-[44px] items-center rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 text-sm font-semibold">
                  {displayUnit(selectedItem?.unit, lang)}
                </div>
              </FormField>
              <FormField label={t('unitCost')}>
                <NumberInput min={0} step={1} value={unitCost} placeholder="0" onChange={(e) => setUnitCost(e.target.value === '' ? '' : Number(e.target.value))} />
              </FormField>
              <FormField label={lang === 'id' ? 'Nilai' : 'القيمة'}>
                <div className="number flex min-h-[44px] items-center rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-3 text-sm font-bold">
                  {formatIDR(lineValue)}
                </div>
              </FormField>
            </div>
            <FormField label={`${t('note')} (${lang === 'id' ? 'opsional' : 'اختياري'})`}>
              <TextInput value={note} placeholder={lang === 'id' ? 'Catatan…' : 'ملاحظة…'} onChange={(e) => setNote(e.target.value)} />
            </FormField>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <SecondaryButton onClick={() => setShowForm(false)}>{t('cancel')}</SecondaryButton>
              <PrimaryButton onClick={addToList}>{lang === 'id' ? 'Simpan & tambah' : 'حفظ وإضافة'}</PrimaryButton>
            </div>
          </div>
        </Modal>
      ) : null}

      {confirmOpen ? (
        <Modal title={t('confirmOpeningBalance')} onClose={() => setConfirmOpen(false)}>
          <p className="mb-3 text-xs text-[hsl(var(--muted-foreground))]">{asOfDate} · {prepared.length} · {formatIDR(grandTotal)}</p>
          <FormField label={t('note')}>
            <TextInput value={batchNotes} onChange={(e) => setBatchNotes(e.target.value)} placeholder={lang === 'id' ? 'Catatan batch (opsional)' : 'ملاحظة (اختياري)'} />
          </FormField>
          <ul className="mt-3 max-h-52 space-y-1 overflow-auto text-sm">
            {prepared.map((p) => (
              <li key={p.key} className="flex justify-between gap-2 border-b border-[hsl(var(--border)/.5)] py-1.5">
                <span className="font-semibold">{p.name}</span>
                <span className="number whitespace-nowrap">{p.quantity} {displayUnit(p.unit, lang)} · {formatIDR(p.total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <SecondaryButton onClick={() => setConfirmOpen(false)}>{t('cancel')}</SecondaryButton>
            <PrimaryButton disabled={saving} onClick={() => void handleConfirm()}>{saving ? '...' : t('submitOpeningBalance')}</PrimaryButton>
          </div>
        </Modal>
      ) : null}

      <Flash message={flash} />
    </div>
  );
}
