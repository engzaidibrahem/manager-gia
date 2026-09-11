import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Shell } from '@/components/layout';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearSession, fetchMe, getStoredToken, getStoredUser, installAuthFetch, type AuthUser } from '@/lib/auth';
import { type Lang } from '@/lib/i18n';
import { LoginPage } from '@/pages/login';
import NotFound from '@/pages/not-found';
import { V3SummaryPage } from '@/pages/v3/summary';
import { V3WarehousePage } from '@/pages/v3/warehouse';
import { V3OpeningPage } from '@/pages/v3/opening';
import { V3WarehouseInPage } from '@/pages/v3/warehouse-in';
import { V3WarehouseOutPage } from '@/pages/v3/warehouse-out';
import { V3KitchenPage } from '@/pages/v3/kitchen';
import { V3PurchasesPage } from '@/pages/v3/purchases';
import { V3PurchaseImportPage } from '@/pages/v3/purchase-import';
import { V3FinancePage } from '@/pages/v3/finance';
import { V3EmployeesPage } from '@/pages/v3/employees';
import { V3EmployeeDetailPage } from '@/pages/v3/employee-detail';
import { V3AttendancePage } from '@/pages/v3/attendance';
import { V3ItemDetailPage } from '@/pages/v3/item-detail';

const queryClient = new QueryClient();
installAuthFetch();

function AppRouter({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('gia-lang') as Lang) || 'ar');
  const [location] = useLocation();
  const changeLang = (value: Lang) => {
    setLang(value);
    localStorage.setItem('gia-lang', value);
  };

  return (
    <Shell lang={lang} setLang={changeLang} user={user} onLogout={onLogout}>
      {/* Stable route children — avoid `component={() => ...}` which remounts and wipes modal state */}
      <ErrorBoundary resetKey={location}>
        <Switch>
          <Route path="/"><V3SummaryPage lang={lang} /></Route>
          <Route path="/warehouse/:id"><V3ItemDetailPage lang={lang} /></Route>
          <Route path="/warehouse"><V3WarehousePage lang={lang} /></Route>
          <Route path="/inventory"><V3WarehousePage lang={lang} /></Route>
          <Route path="/opening"><V3OpeningPage lang={lang} /></Route>
          <Route path="/opening-balance"><V3OpeningPage lang={lang} /></Route>
          <Route path="/warehouse-in"><V3WarehouseInPage lang={lang} /></Route>
          <Route path="/warehouse-out"><V3WarehouseOutPage lang={lang} /></Route>
          <Route path="/warehouse-to-kitchen"><V3WarehouseOutPage lang={lang} /></Route>
          <Route path="/kitchen"><V3KitchenPage lang={lang} /></Route>
          <Route path="/purchases/import"><V3PurchaseImportPage lang={lang} /></Route>
          <Route path="/purchases"><V3PurchasesPage lang={lang} /></Route>
          <Route path="/finance"><V3FinancePage lang={lang} /></Route>
          <Route path="/employees/:id"><V3EmployeeDetailPage lang={lang} /></Route>
          <Route path="/employees"><V3EmployeesPage lang={lang} /></Route>
          <Route path="/attendance"><V3AttendancePage lang={lang} /></Route>
          <Route><NotFound /></Route>
        </Switch>
      </ErrorBoundary>
    </Shell>
  );
}

function App() {
  const [lang] = useState<Lang>(() => (localStorage.getItem('gia-lang') as Lang) || 'ar');
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
