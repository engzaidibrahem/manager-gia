import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Shell } from '@/components/layout';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearSession, fetchMe, getStoredToken, getStoredUser, installAuthFetch, type AuthUser } from '@/lib/auth';
import { type Lang } from '@/lib/i18n';
import { DashboardPage } from '@/pages/dashboard';
import { ArchivesPage } from '@/pages/archives';
import { FinancePage } from '@/pages/finance';
import { InventoryPage } from '@/pages/inventory';
import { KitchenPage } from '@/pages/kitchen';
import { LoginPage } from '@/pages/login';
import NotFound from '@/pages/not-found';
import { OpeningBalancePage } from '@/pages/opening-balance';
import { PurchasesPage } from '@/pages/purchases';
import { RecipesPage } from '@/pages/recipes';
import { StaffPage } from '@/pages/staff';
import { WastePage } from '@/pages/waste';
import { WarehouseArchivePage } from '@/pages/warehouse-archive';

const queryClient = new QueryClient();
installAuthFetch();

function AppRouter({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('gia-lang') as Lang) || 'id');
  const changeLang = (value: Lang) => {
    setLang(value);
    localStorage.setItem('gia-lang', value);
  };

  return (
    <Shell lang={lang} setLang={changeLang} user={user} onLogout={onLogout}>
      <ErrorBoundary resetKey={location.pathname}>
        <Switch>
          <Route path="/" component={() => <DashboardPage lang={lang} />} />
          <Route path="/archives" component={() => <ArchivesPage lang={lang} />} />
          <Route path="/inventory" component={() => <InventoryPage lang={lang} />} />
          <Route path="/opening-balance" component={() => <OpeningBalancePage lang={lang} />} />
          <Route path="/warehouse-archive" component={() => <WarehouseArchivePage lang={lang} />} />
          <Route path="/kitchen" component={() => <KitchenPage lang={lang} />} />
          <Route path="/purchases" component={() => <PurchasesPage lang={lang} />} />
          <Route path="/recipes" component={() => <RecipesPage lang={lang} />} />
          <Route path="/waste" component={() => <WastePage lang={lang} />} />
          <Route path="/finance" component={() => <FinancePage lang={lang} />} />
          <Route path="/staff" component={() => <StaffPage lang={lang} />} />
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    </Shell>
  );
}

function App() {
  const [lang] = useState<Lang>(() => (localStorage.getItem('gia-lang') as Lang) || 'id');
  const [user, setUser] = useState<AuthUser | null>(() => (getStoredToken() ? getStoredUser() : null));
  const [checking, setChecking] = useState(Boolean(getStoredToken()));

  useEffect(() => {
    if (!getStoredToken()) {
      setChecking(false);
      return;
    }
    fetchMe()
      .then((res) => setUser(res.user))
      .catch(() => {
        clearSession();
        setUser(null);
      })
      .finally(() => setChecking(false));
  }, []);

  const logout = () => {
    clearSession();
    setUser(null);
    queryClient.clear();
  };

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">…</div>;
  }

  if (!user) {
    return <LoginPage lang={lang} onLoggedIn={() => setUser(getStoredUser())} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AppRouter user={user} onLogout={logout} />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
