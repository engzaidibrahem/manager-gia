import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, DollarSign, Landmark, ShoppingBag, Wallet } from 'lucide-react';
import { Link } from 'wouter';
import {
  getGetDashboardSummaryQueryKey, getListExpensesQueryKey, getListIncomeQueryKey,
  useListExpenses, useListIncome,
} from '@workspace/api-client-react';
import {
  FormField,
  FormSection,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from '@/components/FormKit';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import {
  bulkSaveExpenses,
  bulkSaveIncome,
  createCapitalEntry,
  getAvailableCapitalSummary,
  getCashDay,
  listCapitalEntries,
  remediatePurchaseLikeExpenses,
  voidCapitalEntry,
  voidFinanceExpense,
  voidFinanceIncome,
  saveCashDay,
  type CapitalEntry,
} from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { resolveRows, useGridSync } from '@/lib/use-grid-sync';
import { emptyRows, formatIDR, nowTime, todayISO } from '@/lib/utils';

type ExpenseRow = {
  _key: string; _selected?: boolean; id?: number;
  expenseDate: string; expenseTime: string; category: string; description: string;
  amount: number | ''; paidBy: string; receivedBy: string; paymentMethod: string; notes: string;
};

type IncomeRow = {
  _key: string; _selected?: boolean; id?: number;
  incomeDate: string; incomeTime: string; source: string; amount: number | ''; recordedBy: string; notes: string;
};

type CapitalRow = {
  _key: string; _selected?: boolean; id?: number;
  entryDate: string; entryType: string; description: string; amount: number | ''; actor: string; status?: string;
};

type QuickForm = 'capital' | 'income' | 'expense' | null;

function blankExpense(date: string): ExpenseRow {
  return {
    _key: makeRowKey(),
    expenseDate: date,
    expenseTime: nowTime(),
    category: 'Other',
    description: '',
    amount: '',
    paidBy: '',
    receivedBy: '-',
    paymentMethod: 'Transfer',
    notes: '',
  };
}

function blankIncome(date: string): IncomeRow {
  return { _key: makeRowKey(), incomeDate: date, incomeTime: nowTime(), source: '', amount: '', recordedBy: '', notes: '' };
}

function blankCapital(date: string): CapitalRow {
  return {
    _key: makeRowKey(),
    entryDate: date,
    entryType: 'initial_capital',
    description: '',
    amount: '',
    actor: '',
  };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

function newClientRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `cap-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function FinancePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const expensesQuery = useListExpenses({ date, limit: 500 });
  const incomeQuery = useListIncome({ date, limit: 500 });
  const cashQuery = useQuery({ queryKey: ['cash-day', date], queryFn: () => getCashDay(date) });
  const capitalQuery = useQuery({ queryKey: ['capital-entries'], queryFn: () => listCapitalEntries(false) });
  const opsQuery = useQuery({ queryKey: ['available-summary'], queryFn: () => getAvailableCapitalSummary() });

  const expenses = expensesQuery.data ?? [];
  const incomes = incomeQuery.data ?? [];
  const [delExp, setDelExp] = useState<number[]>([]);
  const [delInc, setDelInc] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [savingCapital, setSavingCapital] = useState(false);
  const [flash, setFlash] = useState('');
  const [opening, setOpening] = useState<number | ''>('');
  const [openingTouched, setOpeningTouched] = useState(false);
  const [quickForm, setQuickForm] = useState<QuickForm>(null);
  const [quickAmount, setQuickAmount] = useState<number | ''>('');
  const [quickNote, setQuickNote] = useState('');
  const [quickCategory, setQuickCategory] = useState('Other');
  const [quickCapitalType, setQuickCapitalType] = useState<'initial_capital' | 'additional_capital'>('initial_capital');
  const [remediating, setRemediating] = useState(false);

  useEffect(() => {
    setOpeningTouched(false);
    setDelExp([]);
    setDelInc([]);
  }, [date]);

  useEffect(() => {
    if (!cashQuery.data || openingTouched) return;
    setOpening(cashQuery.data.openingBalance);
  }, [cashQuery.data, openingTouched]);

  const expSyncKey = `${date}-${expensesQuery.dataUpdatedAt}`;
  const incSyncKey = `${date}-${incomeQuery.dataUpdatedAt}`;
  const capSyncKey = `cap-${capitalQuery.dataUpdatedAt}`;

  const buildExpRows = useCallback((): ExpenseRow[] => [
    ...expenses.map((e): ExpenseRow => ({
      _key: `e-${e.id}`,
      id: e.id,
      expenseDate: e.expenseDate,
      expenseTime: e.expenseTime ?? '',
      category: e.category,
      description: e.description,
      amount: Number(e.amount) as number | '',
      paidBy: e.paidBy,
      receivedBy: e.receivedBy,
      paymentMethod: e.paymentMethod || 'Transfer',
      notes: e.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 6 - expenses.length), () => blankExpense(date)),
  ], [expenses, date]);

  const buildIncRows = useCallback((): IncomeRow[] => [
    ...incomes.map((e): IncomeRow => ({
      _key: `i-${e.id}`,
      id: e.id,
      incomeDate: e.incomeDate,
      incomeTime: e.incomeTime ?? '',
      source: e.source,
      amount: Number(e.amount) as number | '',
      recordedBy: e.recordedBy,
      notes: e.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 4 - incomes.length), () => blankIncome(date)),
  ], [incomes, date]);

  const buildCapRows = useCallback((): CapitalRow[] => {
    const entries = (capitalQuery.data ?? []) as CapitalEntry[];
    return [
      ...entries.map((c): CapitalRow => ({
        _key: `c-${c.id}`,
        id: c.id,
        entryDate: c.entryDate,
        entryType: c.entryType,
        description: c.description ?? '',
        amount: Number(c.amount) as number | '',
        actor: c.actor,
        status: c.status,
      })),
      ...emptyRows(Math.max(0, 4 - entries.length), () => blankCapital(date)),
    ];
  }, [capitalQuery.data, date]);

  const { rows: expRows, setRows: setExpRows, markDirty: markExpDirty, markClean: markExpClean } = useGridSync<ExpenseRow>(
    expSyncKey, expensesQuery.isFetched, buildExpRows,
  );
  const { rows: incRows, setRows: setIncRows, markDirty: markIncDirty, markClean: markIncClean } = useGridSync<IncomeRow>(
    incSyncKey, incomeQuery.isFetched, buildIncRows,
  );
  const { rows: capRows, setRows: setCapRows, markClean: markCapClean } = useGridSync<CapitalRow>(
    capSyncKey, capitalQuery.isFetched, buildCapRows,
  );

  const paymentOptions = useMemo(() => [
    { value: 'Transfer', label: t('paymentTransfer') },
    { value: 'Cash', label: t('paymentCash') },
    { value: 'QRIS', label: t('paymentQris') },
    { value: 'Debit', label: t('paymentDebit') },
  ], [lang, t]);

  const expenseTypeOptions = useMemo(() => [
    { value: 'Rent', label: lang === 'id' ? 'Sewa' : 'إيجار' },
    { value: 'Electricity', label: lang === 'id' ? 'Listrik' : 'كهرباء' },
    { value: 'Maintenance', label: lang === 'id' ? 'Perawatan' : 'صيانة' },
    { value: 'Transport', label: lang === 'id' ? 'Transport' : 'نقل' },
    { value: 'Other', label: lang === 'id' ? 'Lainnya' : 'أخرى' },
  ], [lang]);

  const capitalTypeOptions = useMemo(() => [
    { value: 'initial_capital', label: t('initialCapital') },
    { value: 'additional_capital', label: t('additionalCapital') },
  ], [t]);

  const expCols: ColDef<ExpenseRow>[] = useMemo(() => [
    { key: 'expenseDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'category', label: t('expenseType'), type: 'select', options: expenseTypeOptions, width: '130px' },
    { key: 'description', label: t('description'), width: '200px' },
    { key: 'amount', label: t('amount'), type: 'number', min: 0.01, width: '120px' },
    { key: 'paymentMethod', label: t('paymentMethod'), type: 'select', options: paymentOptions, width: '110px' },
    { key: 'paidBy', label: t('responsible'), width: '120px', readOnly: true },
  ], [expenseTypeOptions, paymentOptions, t]);

  const incCols: ColDef<IncomeRow>[] = useMemo(() => [
    { key: 'incomeDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'source', label: t('incomePeriod'), width: '160px' },
    { key: 'notes', label: t('description'), width: '200px' },
    { key: 'amount', label: t('amount'), type: 'number', min: 0.01, width: '120px' },
    { key: 'recordedBy', label: t('responsible'), width: '120px', readOnly: true },
  ], [t]);

  const capCols: ColDef<CapitalRow>[] = useMemo(() => [
    { key: 'entryDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'entryType', label: t('capitalType'), type: 'select', options: capitalTypeOptions, width: '160px' },
    { key: 'description', label: t('description'), width: '220px' },
    { key: 'amount', label: t('amount'), type: 'number', min: 0.01, width: '130px' },
    { key: 'actor', label: t('responsible'), width: '140px', readOnly: true },
  ], [capitalTypeOptions, t]);

  const liveExpTotal = useMemo(
    () => expRows.filter((r) => r.description.trim() && num(r.amount) > 0).reduce((s, r) => s + num(r.amount), 0),
    [expRows],
  );
  const liveIncTotal = useMemo(
    () => incRows.filter((r) => r.source.trim() && num(r.amount) > 0).reduce((s, r) => s + num(r.amount), 0),
    [incRows],
  );
  const openingN = num(opening);
  const closing = openingN + liveIncTotal - liveExpTotal;
  const suggested = cashQuery.data?.suggestedOpening ?? 0;
  const ops = opsQuery.data;
  const suspected = ops?.suspectedPurchaseExpenses ?? [];

  async function refreshFinance() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: getListExpensesQueryKey({ date, limit: 500 }) }),
      qc.invalidateQueries({ queryKey: getListIncomeQueryKey({ date, limit: 500 }) }),
      qc.invalidateQueries({ queryKey: ['cash-day', date] }),
      qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey({ date }) }),
      qc.invalidateQueries({ queryKey: ['available-summary'] }),
      qc.invalidateQueries({ queryKey: ['capital-entries'] }),
    ]);
  }

  const handleSaveCashAndBooks = async () => {
    setSaving(true);
    try {
      const expPayload = expRows.filter((r) => r.description.trim() && num(r.amount) > 0).map((r) => ({
        id: r.id,
        expenseDate: r.expenseDate || date,
        expenseTime: r.expenseTime,
        category: r.category?.trim() || 'Other',
        description: r.description,
        amount: num(r.amount),
        receivedBy: r.receivedBy?.trim() || '-',
        paymentMethod: r.paymentMethod || 'Transfer',
        notes: r.notes,
      }));
      const incPayload = incRows.filter((r) => r.source.trim() && num(r.amount) > 0).map((r) => ({
        id: r.id,
        incomeDate: r.incomeDate || date,
        incomeTime: r.incomeTime,
        source: r.source,
        amount: num(r.amount),
        notes: r.notes,
      }));
      await Promise.all([
        saveCashDay(date, openingN),
        bulkSaveExpenses(expPayload, delExp),
        bulkSaveIncome(incPayload, delInc),
      ]);
      setDelExp([]); setDelInc([]);
      setOpeningTouched(false);
      markExpClean(); markIncClean();
      await refreshFinance();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : t('saveFailed');
      setFlash(msg);
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCapital = async () => {
    const drafts = capRows.filter((r) => !r.id && num(r.amount) > 0 && (r.entryType === 'initial_capital' || r.entryType === 'additional_capital'));
    if (!drafts.length) {
      setFlash(lang === 'id' ? 'Tidak ada baris modal baru' : 'لا توجد صفوف رأس مال جديدة');
      window.setTimeout(() => setFlash(''), 2500);
      return;
    }
    setSavingCapital(true);
    try {
      for (const row of drafts) {
        await createCapitalEntry({
          entryDate: row.entryDate || date,
          entryType: row.entryType as 'initial_capital' | 'additional_capital',
          amount: num(row.amount),
          description: row.description || undefined,
          clientRequestId: newClientRequestId(),
        });
      }
      markCapClean();
      await refreshFinance();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSavingCapital(false);
    }
  };

  const handleVoidSelectedCapital = async () => {
    const selected = capRows.filter((r) => r._selected && r.id);
    if (!selected.length) return;
    if (!window.confirm(lang === 'id'
      ? `Void ${selected.length} baris modal? Riwayat tetap tersimpan.`
      : `إلغاء ${selected.length} سجل رأس مال؟ السجل يبقى للتدقيق.`)) return;
    setSavingCapital(true);
    try {
      for (const row of selected) {
        await voidCapitalEntry(row.id!, lang === 'id' ? 'Koreksi' : 'تصحيح');
      }
      await refreshFinance();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSavingCapital(false);
    }
  };

  const handleQuickSubmit = async () => {
    const amount = num(quickAmount);
    if (amount <= 0) {
      setFlash(lang === 'id' ? 'Jumlah harus lebih dari 0' : 'يجب أن يكون المبلغ أكبر من صفر');
      window.setTimeout(() => setFlash(''), 2500);
      return;
    }
    setSaving(true);
    try {
      if (quickForm === 'capital') {
        await createCapitalEntry({
          entryDate: date,
          entryType: quickCapitalType,
          amount,
          description: quickNote || undefined,
          clientRequestId: newClientRequestId(),
        });
      } else if (quickForm === 'income') {
        await bulkSaveIncome([{
          incomeDate: date,
          incomeTime: nowTime(),
          source: quickNote.trim() || (lang === 'id' ? 'Pemasukan' : 'دخل'),
          amount,
          notes: '',
        }], []);
      } else if (quickForm === 'expense') {
        await bulkSaveExpenses([{
          expenseDate: date,
          expenseTime: nowTime(),
          category: quickCategory,
          description: quickNote.trim() || (lang === 'id' ? 'Pengeluaran operasional' : 'مصروف تشغيلي'),
          amount,
          receivedBy: '-',
          paymentMethod: 'Transfer',
          notes: '',
        }], []);
      }
      setQuickForm(null);
      setQuickAmount('');
      setQuickNote('');
      await refreshFinance();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 4000);
    } finally {
      setSaving(false);
    }
  };

  const handleRemediate = async () => {
    if (!suspected.length) return;
    if (!window.confirm(lang === 'id'
      ? `Void lembut ${suspected.length} pengeluaran yang tampak sebagai pembelian? Riwayat tetap ada.`
      : `إلغاء ناعم لـ ${suspected.length} مصروف يبدو كمشتريات؟ السجل يبقى.`)) return;
    setRemediating(true);
    try {
      const result = await remediatePurchaseLikeExpenses(
        lang === 'id' ? 'koreksi pembelian ganda' : 'تصحيح ازدواج المشتريات',
      );
      await refreshFinance();
      setFlash(lang === 'id'
        ? `Diperbaiki: ${result.voidedCount} baris (${formatIDR(result.totalVoidedAmount)})`
        : `تم التصحيح: ${result.voidedCount} سجل (${formatIDR(result.totalVoidedAmount)})`);
      window.setTimeout(() => setFlash(''), 3500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 4000);
    } finally {
      setRemediating(false);
    }
  };

  const onExpChange = (next: Parameters<typeof setExpRows>[0]) => {
    markExpDirty();
    setExpRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDelExp((p) => [...p, ...removed.map((r) => r.id!).filter((id) => !p.includes(id))]);
      return resolved;
    });
  };

  const onIncChange = (next: Parameters<typeof setIncRows>[0]) => {
    markIncDirty();
    setIncRows((prev) => {
      const resolved = resolveRows(prev, next);
      const removed = prev.filter((r) => r.id && !resolved.find((n) => n._key === r._key));
      setDelInc((p) => [...p, ...removed.map((r) => r.id!).filter((id) => !p.includes(id))]);
      return resolved;
    });
  };

  const onCapChange = (next: Parameters<typeof setCapRows>[0]) => {
    setCapRows((prev) => {
      const resolved = resolveRows(prev, next);
      return resolved.map((r) => {
        if (!r.id) return r;
        const orig = (capitalQuery.data ?? []).find((c) => c.id === r.id);
        if (!orig) return r;
        return {
          ...r,
          entryDate: orig.entryDate,
          entryType: orig.entryType,
          description: orig.description ?? '',
          amount: Number(orig.amount) as number | '',
          actor: orig.actor,
          status: orig.status,
        };
      });
    });
  };

  const voidSelectedExpenses = async () => {
    const selected = expRows.filter((r) => r._selected && r.id);
    if (!selected.length) return;
    if (!window.confirm(lang === 'id' ? `Void ${selected.length} pengeluaran?` : `إلغاء ${selected.length} مصروف؟`)) return;
    setSaving(true);
    try {
      for (const row of selected) {
        await voidFinanceExpense(row.id!, lang === 'id' ? 'Koreksi' : 'تصحيح');
      }
      await refreshFinance();
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : t('saveFailed'));
      window.setTimeout(() => setFlash(''), 3500);
    } finally {
      setSaving(false);
    }
  };

  const voidSelectedIncome = async () => {
    const selected = incRows.filter((r) => r._selected && r.id);
    if (!selected.length) return;
    if (!window.confirm(lang === 'id' ? `Void ${selected.length} pemasukan?` : `إلغاء ${selected.length} دخل؟`)) return;
    setSaving(true);
    try {
      for (const row of selected) {
        await voidFinanceIncome(row.id!, lang === 'id' ? 'Koreksi' : 'تصحيح');
      }
      await refreshFinance();
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
      <PageTitle
        eyebrow="GIA / FINANCE"
        title={t('finance')}
        description={t('financeDesc')}
        action={(
          <label className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold">
            <CalendarDays size={15} />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none" />
          </label>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Kartu total dihitung otomatis. Gunakan tombol di bawah untuk menambah modal, pemasukan, atau pengeluaran.'
          : 'بطاقات الإجمالي تُحسب تلقائياً. استخدم الأزرار أدناه لإضافة رأس مال أو دخل أو مصروف.'}
      </PageHint>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label={t('totalInitialCapital')} value={formatIDR(ops?.totalCapital ?? 0)} detail={t('registeredCapitalHint')} icon={Landmark} />
        <Metric label={t('totalIncomeAll')} value={formatIDR(ops?.totalIncome ?? 0)} detail={t('registeredIncomeHint')} icon={ArrowUpRight} />
        <Metric label={t('totalExpensesAll')} value={formatIDR(ops?.totalExpenses ?? 0)} detail={t('operationalExpenseHint')} icon={ArrowDownLeft} />
        <Metric label={t('totalPurchasePayments')} value={formatIDR(ops?.totalPurchasePayments ?? 0)} detail={t('purchasePaymentsHint')} icon={ShoppingBag} />
        <Metric label={t('availableCapital')} value={formatIDR(ops?.availableCapital ?? ops?.operationalBalance ?? 0)} detail={t('availableCapitalHint')} icon={DollarSign} tone="primary" />
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <PrimaryButton onClick={() => { setQuickForm('capital'); setQuickCapitalType('initial_capital'); setQuickAmount(''); setQuickNote(''); }}>
          {t('addCapitalAction')}
        </PrimaryButton>
        <SecondaryButton onClick={() => { setQuickForm('income'); setQuickAmount(''); setQuickNote(''); }}>
          {t('addIncomeAction')}
        </SecondaryButton>
        <SecondaryButton onClick={() => { setQuickForm('expense'); setQuickAmount(''); setQuickNote(''); setQuickCategory('Other'); }}>
          {t('addExpenseAction')}
        </SecondaryButton>
        <Link href="/purchases" className="rounded-xl border border-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))] hover:text-[hsl(var(--primary-foreground))]">
          {t('receiveGoodsAction')}
        </Link>
      </div>

      {quickForm ? (
        <FormSection
          className="mb-5"
          title={quickForm === 'capital' ? t('addCapitalAction') : quickForm === 'income' ? t('addIncomeAction') : t('addExpenseAction')}
          hint={lang === 'id'
            ? 'Isi jumlah dan keterangan, lalu simpan. Total di atas akan ikut berubah.'
            : 'أدخل المبلغ والبيان ثم احفظ. ستتحدث الإجماليات أعلاه تلقائياً.'}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {quickForm === 'capital' ? (
              <FormField label={t('capitalType')}>
                <SelectInput value={quickCapitalType} onChange={(e) => setQuickCapitalType(e.target.value as 'initial_capital' | 'additional_capital')}>
                  <option value="initial_capital">{t('initialCapital')}</option>
                  <option value="additional_capital">{t('additionalCapital')}</option>
                </SelectInput>
              </FormField>
            ) : null}
            {quickForm === 'expense' ? (
              <FormField label={t('expenseType')}>
                <SelectInput value={quickCategory} onChange={(e) => setQuickCategory(e.target.value)}>
                  {expenseTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </SelectInput>
              </FormField>
            ) : null}
            <FormField label={t('amount')} required>
              <NumberInput min={0.01} step={1} value={quickAmount} placeholder="0" onChange={(e) => setQuickAmount(e.target.value === '' ? '' : Number(e.target.value))} />
            </FormField>
            <FormField label={t('description')} className={quickForm === 'income' || quickForm === 'capital' ? 'sm:col-span-2' : undefined}>
              <TextInput value={quickNote} onChange={(e) => setQuickNote(e.target.value)} placeholder={quickForm === 'income' ? t('incomePeriod') : t('description')} />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton disabled={saving} onClick={() => void handleQuickSubmit()}>
              {saving ? '...' : t('save')}
            </PrimaryButton>
            <SecondaryButton onClick={() => setQuickForm(null)}>{t('cancel')}</SecondaryButton>
          </div>
        </FormSection>
      ) : null}

      {suspected.length > 0 ? (
        <section className="mb-5 rounded-xl border border-amber-500/40 bg-amber-50 p-4 dark:bg-amber-950/20">
          <p className="text-sm font-semibold">{t('legacyPurchaseExpenseWarn')}</p>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {formatIDR(ops?.excludedPurchaseLikeTotal ?? 0)} · {suspected.length} {lang === 'id' ? 'baris (sudah dikecualikan dari modal tersedia)' : 'سجل (مستثناة من رأس المال المتاح)'}
          </p>
          <button type="button" disabled={remediating} onClick={() => void handleRemediate()} className="mt-3 rounded-xl bg-amber-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-60">
            {remediating ? '...' : t('fixLegacyPurchaseExpenses')}
          </button>
        </section>
      ) : null}

      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold">{t('capitalRegister')}</h2>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{t('capitalRegisterHint')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={savingCapital} onClick={() => void handleVoidSelectedCapital()} className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
              {t('voidCapital')}
            </button>
          </div>
        </div>
        <SpreadsheetGrid
          columns={capCols}
          rows={capRows}
          onRowsChange={onCapChange}
          onSave={() => void handleSaveCapital()}
          saving={savingCapital}
          lang={lang}
          t={t}
          exportFilename="gia-capital-register"
          minHeight="240px"
          saveLabel={t('saveCapital')}
        />
      </section>

      <FormSection className="mb-5" title={t('dailyCashBook')} hint={t('dailyCashVsCapital')}>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Metric label={t('dailyCashOpening')} value={formatIDR(openingN)} detail={t('dailyCashHint')} icon={Wallet} />
          <Metric label={t('dailyInputs')} value={formatIDR(liveIncTotal)} detail={`${incomes.length}`} icon={ArrowUpRight} />
          <Metric label={t('dailyCashClosing')} value={formatIDR(closing)} detail={t('today')} icon={DollarSign} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <FormField label={t('dailyCashOpening')} hint={`${t('suggestedOpening')}: ${formatIDR(suggested)}`}>
            <NumberInput
              min={0}
              step={1}
              value={opening}
              onChange={(e) => {
                setOpeningTouched(true);
                setOpening(e.target.value === '' ? '' : Number(e.target.value));
              }}
            />
          </FormField>
          <SecondaryButton
            className="border-2 border-[hsl(var(--primary))] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))] hover:text-[hsl(var(--primary-foreground))]"
            onClick={() => {
              setOpeningTouched(true);
              setOpening(suggested);
            }}
          >
            {t('applyYesterdayBalance')}
          </SecondaryButton>
          <PrimaryButton disabled={saving} onClick={() => void handleSaveCashAndBooks()}>
            {saving ? '...' : t('saveAll')}
          </PrimaryButton>
        </div>
      </FormSection>

      <div className="space-y-6">
        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold">{t('expenseRegister')}</h2>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{t('expenseRegisterHint')} · {date}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void voidSelectedExpenses()} className="rounded-xl border border-[hsl(var(--border))] px-3 py-1.5 text-xs font-bold">{t('voidRecord')}</button>
              <div className="rounded-lg bg-[hsl(var(--muted))] px-3 py-1.5 font-mono text-xs font-bold">Σ {formatIDR(liveExpTotal)}</div>
            </div>
          </div>
          <SpreadsheetGrid
            columns={expCols}
            rows={expRows}
            onRowsChange={onExpChange}
            onSave={handleSaveCashAndBooks}
            saving={saving}
            lang={lang}
            t={t}
            exportFilename={`gia-expenses-${date}`}
            minHeight="280px"
          />
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold">{t('incomeRegister')}</h2>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{t('incomeRegisterHint')}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void voidSelectedIncome()} className="rounded-xl border border-[hsl(var(--border))] px-3 py-1.5 text-xs font-bold">{t('voidRecord')}</button>
              <div className="rounded-lg bg-[hsl(var(--muted))] px-3 py-1.5 font-mono text-xs font-bold">Σ {formatIDR(liveIncTotal)}</div>
            </div>
          </div>
          <SpreadsheetGrid
            columns={incCols}
            rows={incRows}
            onRowsChange={onIncChange}
            onSave={handleSaveCashAndBooks}
            saving={saving}
            lang={lang}
            t={t}
            exportFilename={`gia-income-${date}`}
            minHeight="220px"
          />
        </section>
      </div>
      <Flash message={flash} />
    </div>
  );
}
