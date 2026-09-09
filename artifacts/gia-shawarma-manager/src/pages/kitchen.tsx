import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { useListInventoryItems } from '@workspace/api-client-react';
import { PageHint, PrimaryButton } from '@/components/FormKit';
import { PageTitle } from '@/components/layout';
import { listIssues } from '@/lib/bulk-api';
import { displayActor, displayCategory, displayUnit } from '@/lib/display-labels';
import { useT, type Lang } from '@/lib/i18n';
import { todayISO } from '@/lib/utils';

function movementBusinessDate(row: { createdAt?: string; note?: string | null }): string {
  const note = row.note || '';
  const m = note.match(/(?:خارج|وارد)\s+(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  if (row.createdAt) return String(row.createdAt).slice(0, 10);
  return '—';
}

type InvItem = {
  id: number;
  name: string;
  category: string;
  unit: string;
  currentStock?: number;
  kitchenStock?: number;
};

type IssueRow = {
  id: number;
  itemName?: string;
  itemUnit?: string;
  quantity: number;
  actor: string;
  note?: string | null;
  createdAt?: string;
};

export function KitchenPage({ lang }: { lang: Lang }) {
  const t = useT(lang);
  const itemsQuery = useListInventoryItems({});
  const issuesQuery = useQuery({
    queryKey: ['inventory-issues'],
    queryFn: () => listIssues(),
  });

  const items = (itemsQuery.data ?? []) as InvItem[];
  const kitchenItems = useMemo(
    () => items
      .filter((i) => Number(i.kitchenStock ?? 0) > 0)
      .sort((a, b) => a.name.localeCompare(b.name, lang === 'ar' ? 'ar' : 'id')),
    [items, lang],
  );
  const issues = (issuesQuery.data ?? []) as IssueRow[];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA / DAPUR"
        title={t('kitchen')}
        description={t('kitchenDesc')}
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/inventory#issue-to-kitchen">
              <PrimaryButton>{t('issueToKitchen')}</PrimaryButton>
            </Link>
            <div className="rounded-xl border border-[hsl(var(--border))] px-3 py-2 text-xs font-semibold">{todayISO()}</div>
          </div>
        )}
      />

      <PageHint>
        {lang === 'id'
          ? 'Halaman ini hanya menampilkan stok dapur. Untuk menambah bahan, gunakan tombol «Keluar ke dapur».'
          : 'هذه الصفحة تعرض رصيد المطبخ فقط. لإضافة مواد استخدم زر «إخراج إلى المطبخ».'}
      </PageHint>

      <section className="panel soft-shadow mb-5 overflow-hidden">
        <div className="border-b border-[hsl(var(--border))] px-4 py-3">
          <h2 className="text-sm font-bold">{lang === 'id' ? 'Stok dapur' : 'رصيد المطبخ'}</h2>
        </div>
        <div className="overflow-auto" style={{ maxHeight: '420px' }}>
          <table className="w-full min-w-[640px] border-collapse text-sm" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <thead className="sticky top-0 bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="px-3 py-3 text-start">{lang === 'id' ? 'Bahan' : 'المادة'}</th>
                <th className="px-3 py-3 text-start">{lang === 'id' ? 'Di dapur' : 'الكمية في المطبخ'}</th>
                <th className="px-3 py-3 text-start">{t('unit')}</th>
                <th className="px-3 py-3 text-start">{lang === 'id' ? 'Sisa gudang' : 'المتبقي في المستودع'}</th>
              </tr>
            </thead>
            <tbody>
              {kitchenItems.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
                    {lang === 'id' ? 'Belum ada stok dapur.' : 'لا يوجد رصيد مطبخ بعد.'}
                  </td>
                </tr>
              ) : kitchenItems.map((i) => (
                <tr key={i.id} className="border-b border-[hsl(var(--border)/.6)]">
                  <td className="px-3 py-2.5">
                    <div className="font-semibold">{i.name}</div>
                    <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{displayCategory(i.category, lang)}</div>
                  </td>
                  <td className="px-3 py-2.5 font-bold text-[hsl(var(--primary))]">{Number(i.kitchenStock ?? 0)}</td>
                  <td className="px-3 py-2.5">{displayUnit(i.unit, lang)}</td>
                  <td className="px-3 py-2.5">{Number(i.currentStock ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel soft-shadow overflow-hidden">
        <div className="border-b border-[hsl(var(--border))] px-4 py-3">
          <h2 className="text-sm font-bold">{lang === 'id' ? 'Riwayat transfer ke dapur' : 'سجل التحويلات إلى المطبخ'}</h2>
        </div>
        <div className="overflow-auto" style={{ maxHeight: '480px' }}>
          <table className="w-full min-w-[720px] border-collapse text-sm" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <thead className="sticky top-0 bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
              <tr>
                <th className="px-3 py-3 text-start">{t('date')}</th>
                <th className="px-3 py-3 text-start">{lang === 'id' ? 'Bahan' : 'المادة'}</th>
                <th className="px-3 py-3 text-start">{t('quantity')}</th>
                <th className="px-3 py-3 text-start">{t('unit')}</th>
                <th className="px-3 py-3 text-start">{lang === 'id' ? 'Petugas' : 'المسؤول'}</th>
              </tr>
            </thead>
            <tbody>
              {issues.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
                    {lang === 'id' ? 'Belum ada riwayat.' : 'لا يوجد سجل بعد.'}
                  </td>
                </tr>
              ) : issues.map((row) => (
                <tr key={row.id} className="border-b border-[hsl(var(--border)/.6)]">
                  <td className="px-3 py-2.5 whitespace-nowrap font-semibold">{movementBusinessDate(row)}</td>
                  <td className="px-3 py-2.5 font-semibold">{row.itemName ?? '—'}</td>
                  <td className="px-3 py-2.5 font-bold">{Number(row.quantity)}</td>
                  <td className="px-3 py-2.5">{displayUnit(row.itemUnit, lang)}</td>
                  <td className="px-3 py-2.5">{displayActor(row.actor, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
