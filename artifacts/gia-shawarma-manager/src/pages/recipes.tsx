import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator } from 'lucide-react';
import { useListInventoryItems } from '@workspace/api-client-react';
import {
  FormField,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from '@/components/FormKit';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveRecipes, listRecipes, type RecipeComputed } from '@/lib/bulk-api';
import { computeRecipeTotals, tryComputeRecipeLineCost } from '@/lib/recipe-cost';
import { useT, type Lang } from '@/lib/i18n';
import { emptyRows, formatIDR } from '@/lib/utils';

type LineRow = {
  _key: string;
  _selected?: boolean;
  inventoryItemId: string;
  quantity: number | '';
  unit: string;
  yieldPct: number | '';
  notes: string;
};

function blankLine(items: { id: number; unit: string }[]): LineRow {
  return {
    _key: makeRowKey(),
    inventoryItemId: items[0] ? String(items[0].id) : '0',
    quantity: '',
    unit: items[0]?.unit || 'g',
    yieldPct: 100,
    notes: '',
  };
}

function num(v: number | '' | undefined) {
  return v === '' || v == null ? 0 : Number(v);
}

export function RecipesPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const qc = useQueryClient();
  const itemsQuery = useListInventoryItems({});
  const items = itemsQuery.data ?? [];
  const recipesQuery = useQuery({ queryKey: ['recipes'], queryFn: listRecipes });
  const recipes = recipesQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [portions, setPortions] = useState<number | ''>(1);
  const [targetPct, setTargetPct] = useState<number | ''>(30);
  const [selling, setSelling] = useState<number | ''>(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');

  const selected: RecipeComputed | undefined = typeof selectedId === 'number'
    ? recipes.find((r) => r.id === selectedId)
    : undefined;

  useEffect(() => {
    if (selected) {
      setName(selected.name);
      setCategory(selected.category);
      setPortions(selected.portions);
      setTargetPct(selected.targetFoodCostPct);
      setSelling(selected.sellingPrice);
      setNotes(selected.notes ?? '');
      setLines(selected.lines.length
        ? selected.lines.map((l) => ({
          _key: `l-${l.id}`,
          inventoryItemId: String(l.inventoryItemId),
          quantity: l.quantity,
          unit: l.unit,
          yieldPct: l.yieldPct,
          notes: '',
        }))
        : emptyRows(6, () => blankLine(items)));
    } else if (selectedId === 'new') {
      setName('');
      setCategory('');
      setPortions(1);
      setTargetPct(30);
      setSelling(0);
      setNotes('');
      setLines(emptyRows(8, () => blankLine(items)));
    }
  }, [selectedId, selected?.id, items.length]);

  useEffect(() => {
    if (selectedId == null && recipes.length) setSelectedId(recipes[0].id);
  }, [recipes.length]);

  const itemOptions = useMemo(() => [
    { value: '0', label: '—' },
    ...items.map((i) => ({ value: String(i.id), label: `${i.name} · ${formatIDR(i.costPerUnit || 0)}/${i.unit}` })),
  ], [items]);

  const unitOptions = useMemo(() => [
    { value: 'g', label: 'g' },
    { value: 'kg', label: 'kg' },
    { value: 'ml', label: 'ml' },
    { value: 'L', label: 'L' },
    { value: 'pcs', label: 'pcs' },
  ], []);

  const lineCols: ColDef<LineRow>[] = useMemo(() => [
    { key: 'inventoryItemId', label: t('name'), type: 'select', options: itemOptions, width: '240px' },
    { key: 'quantity', label: t('quantity'), type: 'number', min: 0, step: 0.01, width: '100px' },
    { key: 'unit', label: t('unit'), type: 'select', options: unitOptions, width: '90px' },
    { key: 'yieldPct', label: t('yieldPct'), type: 'number', min: 1, max: 100, width: '90px' },
    { key: 'notes', label: t('note'), width: '140px' },
  ], [itemOptions, unitOptions, t]);

  const live = useMemo(() => {
    const detail = lines
      .filter((l) => l.inventoryItemId !== '0' && num(l.quantity) > 0)
      .map((l) => {
        const itemId = Number(l.inventoryItemId);
        const item = items.find((i) => i.id === itemId);
        const savedLine = selected?.lines?.find((sl) => sl.inventoryItemId === itemId);
        if (!item) {
          // Archived / missing catalog item — fall back to persisted API line cost
          if (savedLine && Number(savedLine.lineCost) > 0) {
            return {
              name: savedLine.itemName || `#${itemId}`,
              usedQty: num(l.quantity),
              usedUnit: l.unit,
              convertedQuantity: Number(savedLine.convertedQuantity || 0),
              convertedUnit: savedLine.convertedUnit || savedLine.itemUnit || '',
              costPerUnit: Number(savedLine.costPerUnit || 0),
              lineCost: Number(savedLine.lineCost || 0),
              warning: lang === 'id'
                ? 'Item tidak ada di katalog aktif — memakai biaya tersimpan'
                : 'الصنف غير موجود في المخزون النشط — تُعرض التكلفة المحفوظة',
            };
          }
          return {
            name: '—',
            usedQty: num(l.quantity),
            usedUnit: l.unit,
            convertedQuantity: 0,
            convertedUnit: '',
            costPerUnit: 0,
            lineCost: 0,
            error: lang === 'id' ? 'Item tidak ditemukan di inventori aktif' : 'الصنف غير موجود في المخزون النشط',
          };
        }
        const result = tryComputeRecipeLineCost({
          quantity: num(l.quantity),
          unit: l.unit,
          itemUnit: item.unit,
          costPerUnit: Number(item.costPerUnit || 0),
          yieldPct: num(l.yieldPct) || 100,
        });
        if ('error' in result) {
          if (savedLine && Number(savedLine.lineCost) > 0) {
            return {
              name: item.name,
              usedQty: num(l.quantity),
              usedUnit: l.unit,
              convertedQuantity: Number(savedLine.convertedQuantity || 0),
              convertedUnit: savedLine.convertedUnit || item.unit,
              costPerUnit: Number(savedLine.costPerUnit || item.costPerUnit || 0),
              lineCost: Number(savedLine.lineCost || 0),
              warning: result.error,
            };
          }
          return {
            name: item.name,
            usedQty: num(l.quantity),
            usedUnit: l.unit,
            convertedQuantity: 0,
            convertedUnit: item.unit,
            costPerUnit: Number(item.costPerUnit || 0),
            lineCost: 0,
            error: result.error,
          };
        }
        return {
          name: item.name,
          usedQty: result.quantity,
          usedUnit: result.unit,
          convertedQuantity: result.convertedQuantity,
          convertedUnit: result.convertedUnit,
          costPerUnit: result.costPerUnit,
          lineCost: result.lineCost,
        };
      });

    const hasError = detail.some((d) => d.error);
    const totals = computeRecipeTotals(
      detail.filter((d) => !d.error).map((d) => d.lineCost),
      Math.max(0.01, num(portions) || 1),
      num(selling),
      Math.max(1, num(targetPct) || 30),
    );

    // Prefer persisted API totals when live preview cannot compute (missing items) but recipe is saved
    const useSaved = typeof selectedId === 'number'
      && selected
      && (totals.totalCost === 0 || hasError)
      && Number(selected.totalCost) > 0
      && !detail.some((d) => !d.error && !d.warning && d.lineCost > 0);

    if (useSaved && selected) {
      return {
        totalCost: Number(selected.totalCost),
        costPerPortion: Number(selected.costPerPortion),
        portions: Number(selected.portions),
        suggestedPrice: Number(selected.suggestedPrice),
        foodCostPct: Number(selected.foodCostPct),
        detail,
        hasError,
        usingSaved: true as const,
      };
    }

    return { ...totals, detail, hasError, usingSaved: false as const };
  }, [lines, items, portions, targetPct, selling, selected, selectedId, lang]);

  const handleSave = async () => {
    if (!name.trim()) {
      setFlash(t('saveFailed'));
      return;
    }
    if (live.hasError) {
      setFlash(t('unitMismatch'));
      window.setTimeout(() => setFlash(''), 3000);
      return;
    }
    setSaving(true);
    try {
      const payload = [{
        id: typeof selectedId === 'number' ? selectedId : undefined,
        name: name.trim(),
        category,
        portions: num(portions) || 1,
        targetFoodCostPct: num(targetPct) || 30,
        sellingPrice: num(selling),
        notes,
        lines: lines
          .filter((l) => l.inventoryItemId !== '0' && num(l.quantity) > 0)
          .map((l) => ({
            inventoryItemId: Number(l.inventoryItemId),
            quantity: num(l.quantity),
            unit: l.unit,
            yieldPct: num(l.yieldPct) || 100,
            notes: l.notes,
          })),
      }];
      const saved = await bulkSaveRecipes(payload);
      await recipesQuery.refetch();
      void qc.invalidateQueries({ queryKey: ['recipes'] });
      if (saved[0]?.id) setSelectedId(saved[0].id);
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

  const handleDelete = async () => {
    if (typeof selectedId !== 'number') return;
    if (!window.confirm(lang === 'id' ? 'Hapus resep?' : 'حذف الوصفة؟')) return;
    setSaving(true);
    try {
      await bulkSaveRecipes([], [selectedId]);
      setSelectedId(null);
      await recipesQuery.refetch();
      setFlash(t('deleted'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch {
      setFlash(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const sell = num(selling);

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / RECIPE COST" title={t('recipes')} description={t('recipesDesc')}
        action={<PrimaryButton onClick={() => setSelectedId('new')}>{t('newRecipe')}</PrimaryButton>} />

      <PageHint>
        {lang === 'id'
          ? 'Isi nama resep dan bahan. Biaya porsi dihitung otomatis dari harga stok — tidak mengurangi inventori.'
          : 'أدخل اسم الوصفة والمكوّنات. تكلفة الوجبة تُحسب تلقائياً من أسعار المخزون — دون خصم من المخزون.'}
      </PageHint>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t('totalRecipeCost')} value={formatIDR(live.totalCost)} detail={name || '—'} icon={Calculator} />
        <Metric label={t('portions')} value={String(live.portions)} detail={name || '—'} icon={Calculator} />
        <Metric label={t('costPerPortion')} value={formatIDR(live.costPerPortion)} detail={`${live.portions} ${t('portions')}`} icon={Calculator} tone="primary" />
        <Metric
          label={t('foodCostPct')}
          value={sell > 0 ? `${live.foodCostPct.toFixed(1)}%` : '—'}
          detail={sell > 0 ? t('sellingPrice') : t('sellingPrice')}
          icon={Calculator}
        />
      </div>
      {live.usingSaved ? (
        <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          {lang === 'id'
            ? 'Menampilkan biaya tersimpan dari server karena sebagian bahan tidak ada di inventori aktif.'
            : 'تُعرض التكلفة المحفوظة من الخادم لأن بعض المكوّنات غير موجودة في المخزون النشط.'}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[240px_1fr]">
        <aside className="panel soft-shadow max-h-[560px] overflow-auto p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{t('selectRecipe')}</div>
          {recipes.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelectedId(r.id)}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-xs font-semibold ${selectedId === r.id ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]' : 'hover:bg-[hsl(var(--muted))]'}`}
            >
              <div>{r.name}</div>
              <div className={`mt-0.5 font-mono text-[10px] ${selectedId === r.id ? 'opacity-80' : 'text-[hsl(var(--muted-foreground))]'}`}>{formatIDR(r.costPerPortion)}</div>
            </button>
          ))}
          {!recipes.length && <p className="p-3 text-xs text-[hsl(var(--muted-foreground))]">{t('noRecords')}</p>}
        </aside>

        <section className="space-y-4">
          {(selectedId != null) && (
            <>
              <div className="panel soft-shadow grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <FormField label={t('name')} required>
                  <TextInput value={name} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label={t('category')}>
                  <TextInput value={category} onChange={(e) => setCategory(e.target.value)} />
                </FormField>
                <FormField label={t('portions')} required>
                  <NumberInput min={0.1} step={0.1} value={portions} onChange={(e) => setPortions(e.target.value === '' ? '' : Number(e.target.value))} />
                </FormField>
                <FormField label={t('targetFoodCost')}>
                  <NumberInput min={1} value={targetPct} onChange={(e) => setTargetPct(e.target.value === '' ? '' : Number(e.target.value))} />
                </FormField>
                <FormField label={t('sellingPrice')}>
                  <NumberInput min={0} value={selling} onChange={(e) => setSelling(e.target.value === '' ? '' : Number(e.target.value))} />
                </FormField>
                <FormField label={t('note')}>
                  <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
                </FormField>
                <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
                  <PrimaryButton disabled={saving} onClick={() => void handleSave()}>{saving ? '...' : t('saveAll')}</PrimaryButton>
                  {typeof selectedId === 'number' && (
                    <SecondaryButton disabled={saving} onClick={() => void handleDelete()} className="border-[hsl(var(--destructive))] text-[hsl(var(--destructive))]">
                      {lang === 'ar' ? 'حذف' : 'Hapus'}
                    </SecondaryButton>
                  )}
                </div>
              </div>

              <div>
                <h2 className="mb-2 text-sm font-bold">{t('recipeLines')}</h2>
                <SpreadsheetGrid columns={lineCols} rows={lines} onRowsChange={setLines} onSave={handleSave} saving={saving} lang={lang} t={t} exportFilename={`gia-recipe-${name || 'draft'}`} minHeight="280px" />
              </div>

              <div className="panel soft-shadow overflow-auto p-4">
                <h2 className="mb-3 text-sm font-bold">{t('costBreakdown')}</h2>
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-[hsl(var(--border))] text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                      <th className="pb-2 pr-3 font-bold">{t('name')}</th>
                      <th className="pb-2 pr-3 font-bold">{t('usedQuantity')}</th>
                      <th className="pb-2 pr-3 font-bold">{t('convertedQuantity')}</th>
                      <th className="pb-2 pr-3 font-bold">{t('baseUnit')}</th>
                      <th className="pb-2 pr-3 font-bold">{t('unitCost')}</th>
                      <th className="pb-2 font-bold">{t('lineCost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {live.detail.map((row, idx) => (
                      <tr key={idx} className="border-b border-[hsl(var(--border))]/60">
                        <td className="py-2 pr-3 font-semibold">
                          {row.name}
                          {'error' in row && row.error ? (
                            <div className="mt-0.5 text-[10px] font-medium text-[hsl(var(--destructive))]">{row.error}</div>
                          ) : null}
                          {'warning' in row && row.warning ? (
                            <div className="mt-0.5 text-[10px] font-medium text-amber-700">{row.warning}</div>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 font-mono">{row.usedQty} {row.usedUnit}</td>
                        <td className="py-2 pr-3 font-mono">{row.error ? '—' : row.convertedQuantity}</td>
                        <td className="py-2 pr-3 font-mono">{row.convertedUnit || '—'}</td>
                        <td className="py-2 pr-3 font-mono">{formatIDR(row.costPerUnit)}</td>
                        <td className="py-2 font-mono font-semibold">{row.error ? '—' : formatIDR(row.lineCost)}</td>
                      </tr>
                    ))}
                    {!live.detail.length && (
                      <tr>
                        <td colSpan={6} className="py-4 text-[hsl(var(--muted-foreground))]">{t('noRecords')}</td>
                      </tr>
                    )}
                  </tbody>
                  {live.detail.length > 0 && (
                    <tfoot>
                      <tr className="font-bold">
                        <td className="pt-3" colSpan={5}>{t('totalRecipeCost')}</td>
                        <td className="pt-3 font-mono">{formatIDR(live.totalCost)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
                {sell > 0 && (
                  <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
                    {t('suggestedPrice')}: <span className="font-mono font-semibold text-[hsl(var(--foreground))]">{formatIDR(live.suggestedPrice)}</span>
                    {' · '}
                    {t('foodCostPct')}: <span className="font-mono font-semibold text-[hsl(var(--foreground))]">{live.foodCostPct.toFixed(1)}%</span>
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
      <Flash message={flash} />
    </div>
  );
}
