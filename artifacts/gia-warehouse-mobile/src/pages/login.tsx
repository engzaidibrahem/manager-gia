import { useState } from "react";
import { loginRequest, setSession } from "@/lib/auth";
import { FlashBanner } from "@/components/ui";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password) {
      setError("يرجى إدخال اسم المستخدم وكلمة المرور.");
      return;
    }
    setLoading(true);
    try {
      const res = await loginRequest(username.trim(), password);
      setSession(res.token, res.user);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تسجيل الدخول.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center px-4 py-8 safe-top safe-bottom">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-[hsl(var(--primary))] text-4xl font-black text-[hsl(var(--primary-foreground))] shadow-lg">
          G
        </div>
        <h1 className="text-2xl font-extrabold">مستودع جيا</h1>
        <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">GIA Warehouse — تسجيل الدخول</p>
      </div>

      <FlashBanner message={error} onDismiss={() => setError("")} />

      <form onSubmit={submit} className="card space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-bold">اسم المستخدم</span>
          <input
            className="input-lg"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-bold">كلمة المرور</span>
          <input
            className="input-lg"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn-lg btn-primary" disabled={loading}>
          {loading ? "جاري الدخول..." : "دخول"}
        </button>
      </form>
    </div>
  );
}
