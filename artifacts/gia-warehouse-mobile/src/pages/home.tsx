import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { getStockAlerts } from "@/lib/api";
import { isAdmin, type AuthUser } from "@/lib/auth";
import { BigAction, LoadingSpinner, Screen, StatGrid } from "@/components/ui";

export function HomePage({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const admin = isAdmin(user.role);

  const alerts = useQuery({
    queryKey: ["stock-alerts"],
    queryFn: getStockAlerts,
    enabled: admin,
  });

  return (
    <Screen title="مستودع جيا" showLogout onLogout={onLogout}>
      <p className="mb-4 text-sm text-[hsl(var(--muted-foreground))]">
        مرحباً، <span className="font-bold text-[hsl(var(--foreground))]">{user.fullName || user.username}</span>
      </p>

      {admin ? (
        <>
          {alerts.isLoading ? (
            <LoadingSpinner />
          ) : alerts.data ? (
            <div className="mb-5">
              <StatGrid
                items={[
                  { n: alerts.data.summary.total, l: "إجمالي المواد", tone: "" },
                  { n: alerts.data.summary.lowStock, l: "مخزون منخفض", tone: "text-[hsl(var(--warn))]" },
                  { n: alerts.data.summary.outOfStock, l: "نفد", tone: "text-[hsl(var(--danger))]" },
                  { n: alerts.data.summary.reviewRequired, l: "يحتاج مراجعة", tone: "text-amber-700" },
                ]}
              />
            </div>
          ) : null}

          <div className="grid gap-3">
            <BigAction href="/search" title="🔍 البحث عن مادة" subtitle="بحث عربي جزئي" />
            <BigAction href="/scan" title="📷 مسح QR" subtitle="اختياري — ليس إلزامياً للجرد" tone="secondary" />
            <BigAction href="/in" title="➕ إدخال للمستودع" subtitle="استلام مواد" />
            <BigAction href="/out?source=admin" title="➖ إخراج من المستودع" subtitle="صرف مواد" tone="secondary" />
            <BigAction href="/kitchen?source=admin" title="🔄 تحويل للمطبخ" subtitle="من المستودع إلى المطبخ" />
            <BigAction href="/stocktake" title="📋 جرد المستودع" subtitle="الجرد الحقيقي — بحث أولاً" tone="secondary" />
            <BigAction href="/products" title="📦 إدارة المواد" subtitle="إضافة وتعديل" />
            <BigAction href="/alerts" title="⚠️ تنبيهات المخزون" subtitle="نفد · منخفض · مراجعة" tone="secondary" />
            <BigAction href="/movements" title="🧾 سجل الحركات" subtitle="تدقيق كامل" />
            <BigAction href="/qr-labels" title="ملصقات QR" subtitle="بعد الجرد — طباعة" tone="secondary" />
          </div>
        </>
      ) : (
        <div className="grid gap-3">
          <BigAction href="/scan" title="📷 مسح QR" subtitle="الطريقة الأساسية" />
          <BigAction href="/search" title="🔍 البحث عن المادة" subtitle="عند تعطل الكاميرا أو QR" tone="secondary" />
          <BigAction href="/out?source=search" title="➖ إخراج من المستودع" subtitle="بعد اختيار المادة" />
          <BigAction href="/kitchen?source=search" title="🔄 تحويل للمطبخ" subtitle="من المستودع إلى المطبخ" tone="secondary" />
          <BigAction href="/movements" title="🧾 حركاتي اليوم" subtitle="تأكيد العمليات" />
        </div>
      )}

      <p className="mt-6 text-center text-xs text-[hsl(var(--muted-foreground))]">
        <Link href="/search" className="underline">
          بحث سريع
        </Link>
      </p>
    </Screen>
  );
}
