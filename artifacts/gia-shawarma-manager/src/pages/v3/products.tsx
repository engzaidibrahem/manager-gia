import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHint, PrimaryButton, SecondaryButton, TextInput } from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  createV3Product,
  ensureV3ProductQr,
  listV3Products,
  updateV3Product,
} from "@/lib/v3-api";
import { type Lang } from "@/lib/i18n";
import { EmptyState, StatusBadge } from "./v3-ui";

function statusTone(s: string): "ok" | "warn" | "danger" | "review" | "muted" {
  if (s === "NORMAL") return "ok";
  if (s === "LOW_STOCK") return "warn";
  if (s === "OUT_OF_STOCK") return "danger";
  if (s === "REVIEW_REQUIRED") return "review";
  return "muted";
}

function statusAr(s: string) {
  if (s === "NORMAL") return "طبيعي";
  if (s === "LOW_STOCK") return "منخفض";
  if (s === "OUT_OF_STOCK") return "نفد";
  if (s === "REVIEW_REQUIRED") return "مراجعة";
  return s;
}

export function V3ProductsPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [flash, setFlash] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [min, setMin] = useState("");

  const query = useQuery({
    queryKey: ["v3-products", q],
    queryFn: () => listV3Products({ q, active: "all", page: 1, pageSize: 200, warehouseOnly: "1" }),
  });

  const createMut = useMutation({
    mutationFn: () =>
      createV3Product({
        name,
        baseUnit: unit,
        minimumStock: min.trim() === "" ? null : Number(min),
      }),
    onSuccess: () => {
      setName("");
      setUnit("");
      setMin("");
      setFlash(lang === "id" ? "Produk dibuat + QR" : "تم إنشاء المنتج مع QR");
      qc.invalidateQueries({ queryKey: ["v3-products"] });
    },
    onError: (e: Error) => setFlash(e.message),
  });

  const rows = query.data?.rows ?? [];

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Produk" : "المنتجات"}
        description={lang === "id" ? "Master produk + QR + minimum." : "سجل المنتجات والـ QR والحد الأدنى."}
        action={
          <div className="flex gap-2">
            <Link href="/products/qr"><SecondaryButton>{lang === "id" ? "QR" : "ملصقات QR"}</SecondaryButton></Link>
            <Link href="/stock-alerts"><SecondaryButton>{lang === "id" ? "Peringatan" : "تنبيهات"}</SecondaryButton></Link>
          </div>
        }
      />
      <Flash message={flash} />
      <PageHint>
        {lang === "id"
          ? "Nonaktifkan = soft disable. Riwayat tidak dihapus."
          : "التعطيل لا يحذف التاريخ. QR ثابت لكل منتج."}
      </PageHint>

      <div className="mb-4 grid gap-2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 md:grid-cols-4">
        <TextInput placeholder={lang === "id" ? "Nama" : "اسم المنتج"} value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput placeholder={lang === "id" ? "Satuan" : "الوحدة"} value={unit} onChange={(e) => setUnit(e.target.value)} />
        <TextInput placeholder={lang === "id" ? "Minimum" : "الحد الأدنى"} value={min} onChange={(e) => setMin(e.target.value)} />
        <PrimaryButton disabled={!name.trim() || createMut.isPending} onClick={() => createMut.mutate()}>
          {lang === "id" ? "+ Produk" : "+ منتج جديد"}
        </PrimaryButton>
      </div>

      <TextInput className="mb-3 max-w-xs" placeholder={lang === "id" ? "Cari..." : "بحث..."} value={q} onChange={(e) => setQ(e.target.value)} />

      <div className="panel soft-shadow overflow-auto">
        <table className="w-full min-w-[900px] text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
          <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Produk" : "المنتج"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Satuan" : "الوحدة"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Saldo" : "الرصيد"}</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Minimum" : "الحد الأدنى"}</th>
              <th className="px-3 py-3 text-start">QR</th>
              <th className="px-3 py-3 text-start">{lang === "id" ? "Status" : "الحالة"}</th>
              <th className="px-3 py-3 text-start" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7}><EmptyState message={lang === "id" ? "Belum ada produk" : "لا منتجات بعد"} /></td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="border-b border-[hsl(var(--border)/.5)]">
                <td className="px-3 py-2.5 font-semibold">
                  <Link href={`/warehouse/${r.id}`} className="text-[hsl(var(--primary))]">{r.name}</Link>
                  {!r.isActive ? <span className="ms-2 text-[11px] text-red-700">معطّل</span> : null}
                </td>
                <td className="px-3 py-2.5">{r.baseUnit || "—"}</td>
                <td className="px-3 py-2.5 font-mono">{r.warehouseQtyNumeric ?? "—"}</td>
                <td className="px-3 py-2.5">
                  <input
                    className="w-24 rounded border border-[hsl(var(--border))] px-2 py-1 font-mono text-xs"
                    defaultValue={r.minimumStock ?? ""}
                    onBlur={async (e) => {
                      const v = e.target.value.trim();
                      try {
                        await updateV3Product(r.id, { minimumStock: v === "" ? null : Number(v) });
                        qc.invalidateQueries({ queryKey: ["v3-products"] });
                      } catch (err) {
                        setFlash(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  />
                </td>
                <td className="px-3 py-2.5 font-mono text-[10px]">
                  {r.hasQr ? r.qrToken.slice(0, 14) + "…" : (
                    <button
                      type="button"
                      className="text-[hsl(var(--primary))]"
                      onClick={async () => {
                        await ensureV3ProductQr(r.id);
                        qc.invalidateQueries({ queryKey: ["v3-products"] });
                      }}
                    >
                      Generate
                    </button>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge tone={statusTone(r.stockStatus)}>{statusAr(r.stockStatus)}</StatusBadge>
                </td>
                <td className="px-3 py-2.5">
                  <button
                    type="button"
                    className="text-xs font-bold text-[hsl(var(--muted-foreground))]"
                    onClick={async () => {
                      await updateV3Product(r.id, { isActive: !r.isActive });
                      qc.invalidateQueries({ queryKey: ["v3-products"] });
                    }}
                  >
                    {r.isActive ? (lang === "id" ? "Nonaktif" : "تعطيل") : (lang === "id" ? "Aktifkan" : "تفعيل")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
