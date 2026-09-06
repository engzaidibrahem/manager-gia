import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator } from 'lucide-react';
import { useListInventoryItems } from '@workspace/api-client-react';
import { Flash, Metric, PageTitle } from '@/components/layout';
import { makeRowKey, SpreadsheetGrid, type ColDef } from '@/components/SpreadsheetGrid';
import { bulkSaveRecipes, listRecipes, type RecipeComputed } from '@/lib/bulk-api';
import { useT, type Lang } from '@/lib/i18n';
import { emptyRows, formatIDR, inputClass } from '@/lib/utils';

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
    const portionsN = Math.max(0.01, num(portions) || 1);
    const target = Math.max(1, num(targetPct) || 30);
    let total = 0;
    const detail = lines.filter((l) => l.inventoryItemId !== '0' && num(l.quantity) > 0).map((l) => {
      const item = items.find((i) => i.id === Number(l.inventoryItemId));
      if (!item) return null;
      const from = String(l.unit).toLowerCase();
      const to = item.unit.toLowerCase();
      const factors: Record<string, { dim: string; f: number }> = {
        kg: { dim: 'm', f: 1000 }, g: { dim: 'm', f: 1 },
        l: { dim: 'v', f: 1000 }, liter: { dim: 'v', f: 1000 }, ml: { dim: 'v', f: 1 },
        pcs: { dim: 'c', f: 1 }, pc: { dim: 'c', f: 1 },
      };
      const a = factors[from];
      const b = factors[to];
      let qty = num(l.quantity);
      if (a && b && a.dim === b.dim) qty = (qty * a.f) / b.f;
      const yieldF = Math.max(1, num(l.yieldPct) || 100) / 100;
      const cost = (qty * (item.costPerUnit || 0)) / yieldF;
      total += cost;
      return { name: item.name, cost };
    }).filter(Boolean);
    const costPerPortion = total / portionsN;
    const suggested = costPerPortion / (target / 100);
    const sell = num(selling);
    const foodPct = sell > 0 ? (costPerPortion / sell) * 100 : 0;
    return { total, costPerPortion, suggested, foodPct, detail };
  }, [lines, items, portions, targetPct, selling]);

  const handleSave = async () => {
    if (!name.trim()) {
      setFlash(t('saveFailed'));
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
      if (saved[0]?.id) setSelectedId(saved[0].id);
      setFlash(t('saved'));
      window.setTimeout(() => setFlash(''), 2500);
    } catch {
      setFlash(t('saveFailed'));
      window.setTimeout(() => setFlash(''), 2500);
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

  return (
    <div className="fade-up">
      <PageTitle eyebrow="GIA / RECIPE COST" title={t('recipes')} description={t('recipesDesc')}
        action={<button type="button" onClick={() => setSelectedId('new')} className="btn-primary rounded-xl px-4 py-2.5 text-xs font-bold">{t('newRecipe')}</button>} />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t('totalRecipeCost')} value={formatIDR(live.total)} detail={name || '—'} icon={Calculator} />
        <Metric label={t('costPerPortion')} value={formatIDR(live.costPerPortion)} detail={`${num(portions) || 1} ${t('portions')}`} icon={Calculator} />
        <Metric label={t('suggestedPrice')} value={formatIDR(live.suggested)} detail={`${num(targetPct) || 30}%`} icon={Calculator} tone="primary" />
        <Metric label={t('foodCostPct')} value={`${live.foodPct.toFixed(1)}%`} detail={t('sellingPrice')} icon={Calculator} />
      </div>

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
                <label className="block text-xs font-semibold"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('name')}</span>
                  <input className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="block text-xs font-semibold"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('category')}</span>
                  <input className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={category} onChange={(e) => setCategory(e.target.value)} />
                </label>
                <label className="block text-xs font-semibold"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('portions')}</span>
                  <input type="number" min={0.1} step={0.1} className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={portions} onChange={(e) => setPortions(e.target.value === '' ? '' : Number(e.target.value))} />
                </label>
                <label className="block text-xs font-semibold"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('targetFoodCost')}</span>
                  <input type="number" min={1} className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={targetPct} onChange={(e) => setTargetPct(e.target.value === '' ? '' : Number(e.target.value))} />
                </label>
                <label className="block text-xs font-semibold"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('sellingPrice')}</span>
                  <input type="number" min={0} className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={selling} onChange={(e) => setSelling(e.target.value === '' ? '' : Number(e.target.value))} />
                </label>
                <label className="block text-xs font-semibold sm:col-span-2 lg:col-span-1"><span className="mb-1 block text-[hsl(var(--muted-foreground))]">{t('note')}</span>
                  <input className={`${inputClass} rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]`} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </label>
                <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
                  <button type="button" disabled={saving} onClick={() => void handleSave()} className="btn-primary rounded-xl px-4 py-2 text-xs font-bold">{saving ? '...' : t('saveAll')}</button>
                  {typeof selectedId === 'number' && (
                    <button type="button" disabled={saving} onClick={() => void handleDelete()} className="rounded-xl border border-[hsl(var(--destructive))] px-4 py-2 text-xs font-bold text-[hsl(var(--destructive))]">{t('deleted').includes('حذف') || lang === 'ar' ? 'حذف' : 'Hapus'}</button>
                  )}
                </div>
              </div>

              <div>
                <h2 className="mb-2 text-sm font-bold">{t('recipeLines')}</h2>
                <SpreadsheetGrid columns={lineCols} rows={lines} onRowsChange={setLines} onSave={handleSave} saving={saving} lang={lang} t={t} exportFilename={`gia-recipe-${name || 'draft'}`} minHeight="360px" />
              </div>
            </>
          )}
        </section>
      </div>
      <Flash message={flash} />
    </div>
  );
}
