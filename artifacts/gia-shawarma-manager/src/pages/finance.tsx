import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, DollarSign } from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey, getListExpensesQueryKey, getListIncomeQueryKey,
  useListExpenses, useListIncome,
} from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveExpenses, bulkSaveIncome } from '@/lib/bulk-api';
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

function blankExpense(date: string): ExpenseRow {
  return { _key: makeRowKey(), expenseDate: date, expenseTime: nowTime(), category: '', description: '', amount: '', paidBy: '', receivedBy: '', paymentMethod: 'Cash', notes: '' };
}

function blankIncome(date: string): IncomeRow {
  return { _key: makeRowKey(), incomeDate: date, incomeTime: nowTime(), source: '', amount: '', recordedBy: '', notes: '' };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function FinancePage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const expensesQuery = useListExpenses({ date, limit: 500 });
  const incomeQuery = useListIncome({ date, limit: 500 });
  const expenses = expensesQuery.data ?? [];
  const incomes = incomeQuery.data ?? [];
  const [delExp, setDelExp] = useState<number[]>([]);
  const [delInc, setDelInc] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  const expSyncKey = `${date}-${expensesQuery.dataUpdatedAt}`;
  const incSyncKey = `${date}-${incomeQuery.dataUpdatedAt}`;

  const buildExpRows = useCallback(() => [
    ...expenses.map((e) => ({
      _key: `e-${e.id}`, id: e.id, expenseDate: e.expenseDate, expenseTime: e.expenseTime ?? '',
      category: e.category, description: e.description, amount: Number(e.amount) as number | '',
      paidBy: e.paidBy, receivedBy: e.receivedBy, paymentMethod: e.paymentMethod, notes: e.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 8 - expenses.length), () => blankExpense(date)),
  ], [expenses, date]);

  const buildIncRows = useCallback(() => [
    ...incomes.map((e) => ({
      _key: `i-${e.id}`, id: e.id, incomeDate: e.incomeDate, incomeTime: e.incomeTime ?? '',
      source: e.source, amount: Number(e.amount) as number | '', recordedBy: e.recordedBy, notes: e.notes ?? '',
    })),
    ...emptyRows(Math.max(0, 8 - incomes.length), () => blankIncome(date)),
  ], [incomes, date]);

  const { rows: expRows, setRows: setExpRows, markDirty: markExpDirty, markClean: markExpClean } = useGridSync(
    expSyncKey, expensesQuery.isFetched, buildExpRows,
  );
  const { rows: incRows, setRows: setIncRows, markDirty: markIncDirty, markClean: markIncClean } = useGridSync(
    incSyncKey, incomeQuery.isFetched, buildIncRows,
  );

  const paymentOptions = useMemo(() => [
    { value: 'Cash', label: t('paymentCash') }, { value: 'Transfer', label: t('paymentTransfer') },
    { value: 'QRIS', label: t('paymentQris') }, { value: 'Debit', label: t('paymentDebit') },
  ], [lang, t]);

  const expCols: ColDef<ExpenseRow>[] = useMemo(() => [
    { key: 'expenseDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'expenseTime', label: t('time'), type: 'time', width: '90px' },
    { key: 'category', label: t('category'), width: '110px' },
    { key: 'description', label: t('description'), width: '160px' },
    { key: 'amount', label: t('totalAmount'), type: 'number', min: 0, width: '110px' },
    { key: 'paidBy', label: t('paidBy'), width: '110px' },
    { key: 'receivedBy', label: t('receivedBy'), width: '110px' },
    { key: 'paymentMethod', label: t('paymentMethod'), type: 'select', options: paymentOptions, width: '100px' },
    { key: 'notes', label: t('note'), width: '120px' },
  ], [paymentOptions, t]);

  const incCols: ColDef<IncomeRow>[] = useMemo(() => [
    { key: 'incomeDate', label: t('date'), type: 'date', width: '120px' },
    { key: 'incomeTime', label: t('time'), type: 'time', width: '90px' },
    { key: 'source', label: t('source'), width: '160px' },
    { key: 'amount', label: t('totalAmount'), type: 'number', min: 0, width: '110px' },
    { key: 'recordedBy', label: t('recordedBy'), width: '130px' },
    { key: 'notes', label: t('note'), width: '140px' },
  ], [t]);

  const totalExp = expenses.reduce((n, e) => n + Number(e.amount), 0);
  const totalInc = incomes.reduce((n, e) => n + Number(e.amount), 0);

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const expPayload = expRows.filter((r) => r.description.trim() && num(r.amount) > 0).map(({ _key, _selected, amount, ...rest }) => ({
        ...rest, amount: num(amount),
      }));
      const incPayload = incRows.filter((r) => r.source.trim() && num(r.amount) > 0).map(({ _key, _selected, amount, ...rest }) => ({
        ...rest, amount: num(amount),
      }));
      await Promise.all([bulkSaveExpenses(expPayload, delExp), bulkSaveIncome(incPayload, delInc)]);
      setDelExp([]); setDelInc([]);
      markExpClean(); markIncClean();
      await qc.invalidateQueries({ queryKey: getListExpensesQueryKey({ date, limit: 500 }) });
      await qc.invalidateQueries({ queryKey: getListIncomeQueryKey({ date, limit: 500 }) });
      await qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey({ date }) });
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch {
      setFlash(t('saveFailed'));
      window.setTimeout(() => setFlash(''), 2500);
    } finally {
      setSaving(false);
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

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / KAS" title={t('finance')} description={t('financeDesc')}
        action={<label className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold"><CalendarDays size={15} /><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none" /></label>} />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Metric label={t('income')} value={formatIDR(totalInc)} detail={`${incomes.length} ${lang === 'id' ? 'transaksi' : 'معاملات'}`} icon={ArrowUpRight} />
        <Metric label={t('expenses')} value={formatIDR(totalExp)} detail={`${expenses.length} ${lang === 'id' ? 'transaksi' : 'معاملات'}`} icon={ArrowDownLeft} />
        <Metric label={t('netCash')} value={formatIDR(totalInc - totalExp)} detail={t('today')} icon={DollarSign} tone="primary" />
      </div>
      <div className="space-y-6">
        <section>
          <h2 className="mb-3 text-sm font-bold">{t('income')}</h2>
          <SpreadsheetGrid columns={incCols} rows={incRows} onRowsChange={onIncChange} onSave={handleSaveAll} saving={saving} lang={lang} t={t} exportFilename={`gia-income-${date}`} minHeight="320px" />
        </section>
        <section>
          <h2 className="mb-3 text-sm font-bold">{t('expenses')}</h2>
          <SpreadsheetGrid columns={expCols} rows={expRows} onRowsChange={onExpChange} onSave={handleSaveAll} saving={saving} lang={lang} t={t} exportFilename={`gia-expenses-${date}`} minHeight="320px" />
        </section>
      </div>
      <Flash message={flash} />
    </div>
  );
}
