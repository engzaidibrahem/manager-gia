import { useEffect, useState } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  clearSession,
  fetchMe,
  getStoredToken,
  getStoredUser,
  installAuthFetch,
  isAdmin,
  type AuthUser,
} from "@/lib/auth";
import { LoginPage } from "@/pages/login";
import { HomePage } from "@/pages/home";
import { SearchPage } from "@/pages/search";
import { ScanPage } from "@/pages/scan";
import { ProductPage } from "@/pages/product";
import { OutPage } from "@/pages/out";
import { InPage } from "@/pages/in";
import { KitchenTransferPage } from "@/pages/kitchen";
import { AlertsPage } from "@/pages/alerts";
import { MovementsPage } from "@/pages/movements";
import { ProductsPage } from "@/pages/products";
import { QrLabelsPage } from "@/pages/qr-labels";
import { StocktakeHubPage } from "@/pages/stocktake";
import { StocktakeCountPage } from "@/pages/stocktake-count";
import { LoadingSpinner } from "@/components/ui";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = getStoredUser();
  if (!isAdmin(user?.role)) return <Redirect to="/" />;
  return <>{children}</>;
}

function AuthGate({
  children,
}: {
  children: (props: { user: AuthUser; onLogout: () => void }) => React.ReactNode;
}) {
  const [user, setUser] = useState<AuthUser | null>(getStoredUser);
  const [loading, setLoading] = useState(Boolean(getStoredToken()));
  const [location] = useLocation();

  useEffect(() => {
    installAuthFetch();
    if (!getStoredToken()) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then((r) => setUser(r.user))
      .catch(() => {
        clearSession();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  function handleLoggedIn() {
    setUser(getStoredUser());
  }

  function handleLogout() {
    clearSession();
    setUser(null);
  }

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!user) {
    if (location !== "/") return <Redirect to="/" />;
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  return (
    <>
      {children({ user, onLogout: handleLogout })}
    </>
  );
}

function AppRoutes({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  return (
    <Switch>
      <Route path="/">
        <HomePage user={user} onLogout={onLogout} />
      </Route>
      <Route path="/search">
        <SearchPage />
      </Route>
      <Route path="/scan">
        <ScanPage />
      </Route>
      <Route path="/product/:id">
        <ProductPage />
      </Route>
      <Route path="/out">
        <OutPage />
      </Route>
      <Route path="/kitchen">
        <KitchenTransferPage />
      </Route>
      <Route path="/movements">
        <MovementsPage />
      </Route>

      <Route path="/in">
        <AdminRoute>
          <InPage />
        </AdminRoute>
      </Route>
      <Route path="/alerts">
        <AdminRoute>
          <AlertsPage />
        </AdminRoute>
      </Route>
      <Route path="/products">
        <AdminRoute>
          <ProductsPage />
        </AdminRoute>
      </Route>
      <Route path="/qr-labels">
        <AdminRoute>
          <QrLabelsPage />
        </AdminRoute>
      </Route>
      <Route path="/stocktake">
        <AdminRoute>
          <StocktakeHubPage />
        </AdminRoute>
      </Route>
      <Route path="/stocktake/:id/count/:itemId">
        <AdminRoute>
          <StocktakeCountPage />
        </AdminRoute>
      </Route>

      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        {(auth) => <AppRoutes user={auth.user} onLogout={auth.onLogout} />}
      </AuthGate>
    </QueryClientProvider>
  );
}
