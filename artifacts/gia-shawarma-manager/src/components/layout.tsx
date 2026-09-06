import { type ReactNode, useState } from 'react';
import {
  Archive, Boxes, Calculator, ChevronRight, Coffee, DollarSign, Globe2, LayoutDashboard, Menu, PackageSearch, ShieldCheck, ShoppingBag, Trash2, UsersRound, X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useT, type Lang } from '@/lib/i18n';

type IconType = typeof LayoutDashboard;

export function Shell({ children, lang, setLang }: { children: ReactNode; lang: Lang; setLang: (value: Lang) => void }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const t = useT(lang);
  const nav: { href: string; key: string; icon: IconType }[] = [
    { href: '/', key: 'dashboard', icon: LayoutDashboard },
    { href: '/archives', key: 'archives', icon: Archive },
    { href: '/inventory', key: 'inventory', icon: Boxes },
    { href: '/warehouse-archive', key: 'warehouseArchive', icon: PackageSearch },
    { href: '/kitchen', key: 'kitchen', icon: Coffee },
    { href: '/purchases', key: 'purchases', icon: ShoppingBag },
    { href: '/recipes', key: 'recipes', icon: Calculator },
    { href: '/waste', key: 'waste', icon: Trash2 },
    { href: '/finance', key: 'finance', icon: DollarSign },
    { href: '/staff', key: 'staff', icon: UsersRound },
  ];
  return (
    <div className={`app-shell grain ${lang === 'ar' ? 'rtl' : ''}`}>
      <aside className={`sidebar-grid fixed inset-y-0 z-40 w-[248px] border-r border-[hsl(var(--border))] bg-[hsl(var(--card)/.96)] px-4 py-5 backdrop-blur-sm transition-transform md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} ${lang === 'ar' ? 'right-0 border-l border-r-0 md:translate-x-0' : 'left-0'}`}>
        <div className="flex items-center justify-between px-2">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_4px_0_hsl(17_78%_32%)]"><span className="text-lg font-bold">G</span></span>
            <span><span className="block text-[15px] font-bold tracking-tight">Gia Shawarma</span><span className="block text-[10px] font-medium uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">Manager</span></span>
          </Link>
          <button onClick={() => setMobileOpen(false)} className="rounded-lg p-1 md:hidden"><X size={18} /></button>
        </div>
        <div className="mt-8 px-2 text-[10px] font-bold uppercase tracking-[.18em] text-[hsl(var(--muted-foreground))]">{lang === 'id' ? 'Operasional' : 'التشغيل'}</div>
        <nav className="mt-3 space-y-1 pb-36">
          {nav.map(({ href, key, icon: Icon }) => {
            const active = location === href;
            return (
              <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`nav-item flex items-center gap-3 rounded-xl px-3 py-3 text-[13px] font-semibold ${active ? 'bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)]' : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]'}`}>
                <Icon size={17} strokeWidth={active ? 2.5 : 1.8} /><span>{t(key)}</span>{active && <ChevronRight size={14} className="ml-auto rtl:rotate-180" />}
              </Link>
            );
          })}
        </nav>
        <div className="absolute bottom-5 left-4 right-4">
          <div className="mb-3 rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3">
            <div className="flex items-start gap-2 text-xs font-semibold leading-snug text-[hsl(var(--foreground))]">
              <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[hsl(var(--primary))]" />
              <span>{lang === 'id' ? 'Kontrol biaya & stok harian' : 'ضبط التكلفة والمخزون يومياً'}</span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[hsl(var(--muted-foreground))]">
              {lang === 'id'
                ? 'Isi gudang → beli → transfer dapur → hitung resep.'
                : 'عبّئ المستودع ← اشترِ ← حوّل للمطبخ ← احسب الوصفة.'}
            </p>
          </div>
          <button onClick={() => setLang(lang === 'id' ? 'ar' : 'id')} className="flex w-full items-center justify-between rounded-xl border border-[hsl(var(--border))] px-3 py-2.5 text-xs font-semibold hover:bg-[hsl(var(--muted))]">
            <span className="flex items-center gap-2"><Globe2 size={15} />{t('languages')}</span><span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))]">{lang === 'id' ? 'ID' : 'AR'}</span>
          </button>
        </div>
      </aside>
      <div className={`${lang === 'ar' ? 'md:mr-[248px]' : 'md:ml-[248px]'}`}>
        <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-[hsl(var(--border))] bg-[hsl(var(--background)/.88)] px-4 backdrop-blur-md md:px-8">
          <button onClick={() => setMobileOpen(true)} className="rounded-xl border border-[hsl(var(--border))] p-2 md:hidden"><Menu size={19} /></button>
          <div className="hidden text-xs text-[hsl(var(--muted-foreground))] md:block"><span className="font-mono">{new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'ar-SA', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</span></div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setLang(lang === 'id' ? 'ar' : 'id')} className="flex items-center gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]"><Globe2 size={15} />{lang === 'id' ? 'عربي' : 'ID'}</button>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[hsl(var(--accent))] text-xs font-bold text-[hsl(var(--accent-foreground))]">RS</div>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] p-4 pb-12 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div>
        <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" />{eyebrow}</div>
        <h1 className="display text-3xl font-bold text-[hsl(var(--foreground))] md:text-[38px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-[hsl(var(--muted-foreground))]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Metric({ label, value, detail, icon: Icon, tone = 'default' }: { label: string; value: string; detail: string; icon: IconType; tone?: string }) {
  return (
    <div style={tone === 'primary' ? { backgroundColor: 'hsl(var(--primary))', borderColor: 'hsl(var(--primary))' } : undefined} className={`panel soft-shadow relative overflow-hidden p-5 ${tone === 'primary' ? 'text-[hsl(var(--primary-foreground))]' : ''}`}>
      <div className="flex items-start justify-between">
        <span className={`text-xs font-semibold ${tone === 'primary' ? 'text-[hsl(var(--primary-foreground)/.72)]' : 'text-[hsl(var(--muted-foreground))]'}`}>{label}</span>
        <span className={`rounded-lg p-2 ${tone === 'primary' ? 'bg-[hsl(var(--primary-foreground)/.12)]' : 'bg-[hsl(var(--secondary))]'}`}><Icon size={16} /></span>
      </div>
      <div className={`number mt-4 text-2xl font-semibold ${tone === 'primary' ? '' : 'text-[hsl(var(--foreground))]'}`}>{value}</div>
      <div className={`mt-2 text-xs ${tone === 'primary' ? 'text-[hsl(var(--primary-foreground)/.68)]' : 'text-[hsl(var(--muted-foreground))]'}`}>{detail}</div>
    </div>
  );
}

export function Flash({ message }: { message: string }) {
  if (!message) return null;
  return <div className="fixed bottom-5 right-5 z-[60] rounded-xl bg-[hsl(var(--foreground))] px-4 py-3 text-xs font-bold text-[hsl(var(--background))] shadow-xl">{message}</div>;
}
