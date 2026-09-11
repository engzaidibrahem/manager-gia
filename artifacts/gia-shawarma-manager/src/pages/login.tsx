import { useState } from 'react';
import { type Lang } from '@/lib/i18n';
import { loginRequest, setSession } from '@/lib/auth';

export function LoginPage({ lang, onLoggedIn }: { lang: Lang; onLoggedIn: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await loginRequest(username.trim(), password);
      setSession(res.token, res.user);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : (lang === 'id' ? 'Login gagal' : 'فشل تسجيل الدخول'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(var(--background))] px-4">
      <form onSubmit={submit} className="panel soft-shadow w-full max-w-md p-6 md:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[hsl(var(--primary))] text-lg font-bold text-[hsl(var(--primary-foreground))]">G</div>
          <h1 className="display text-2xl font-bold">Gia Shawarma</h1>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {lang === 'id' ? 'Masuk ke sistem operasional' : 'تسجيل الدخول لنظام التشغيل'}
          </p>
        </div>
        <label className="mb-1 block text-xs font-semibold">{lang === 'id' ? 'Username' : 'اسم المستخدم'}</label>
        <input
          className="mb-3 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/.35)]"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <label className="mb-1 block text-xs font-semibold">{lang === 'id' ? 'Password' : 'كلمة المرور'}</label>
        <input
          type="password"
          className="mb-4 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/.35)]"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error ? <p className="mb-3 text-xs font-semibold text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-[hsl(var(--primary))] py-2.5 text-sm font-bold text-[hsl(var(--primary-foreground))] shadow-[0_3px_0_hsl(17_78%_32%)] disabled:opacity-60"
        >
          {busy ? '…' : (lang === 'id' ? 'Masuk' : 'دخول')}
        </button>
        <p className="mt-4 text-center text-[11px] text-[hsl(var(--muted-foreground))]">
          {lang === 'id'
            ? 'Gunakan kredensial admin dari environment (AUTH_ADMIN_*). Jangan gunakan password default di production.'
            : 'استخدم بيانات الأدمن من متغيرات البيئة (AUTH_ADMIN_*). لا تستخدم كلمة مرور افتراضية في الإنتاج.'}
        </p>
      </form>
    </div>
  );
}
