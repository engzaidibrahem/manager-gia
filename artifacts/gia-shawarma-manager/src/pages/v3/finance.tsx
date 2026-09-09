import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField,
  Modal,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import {
  getV3FinanceSummary,
  listV3Capital,
  listV3Expenses,
  listV3Income,
  newClientRequestId,
  postV3Capital,
  postV3Expense,
  postV3Income,
  todayISO,
  voidV3Capital,
  voidV3Expense,
  voidV3Income,
} from "@/lib/v3-api";
import { formatIDR } from "@/lib/utils";
import { type Lang } from "@/lib/i18n";

export function V3FinancePage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"capital-add" | "capital-out" | "income" | "expense" | null>(null);

  const summary = useQuery({ queryKey: ["v3-finance", "summary"], queryFn: getV3FinanceSummary });
  const capital = useQuery({ queryKey: ["v3-finance", "capital"], queryFn: listV3Capital });
  const income = useQuery({ queryKey: ["v3-finance", "income"], queryFn: listV3Income });
  const expenses = useQuery({ queryKey: ["v3-finance", "expenses"], queryFn: listV3Expenses });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ["v3-finance"] });
  };

  const s = summary.data;

  return (
    <div className="fade-up">
      <PageTitle
        eyebrow="GIA V3"
        title={lang === "id" ? "Keuangan" : "المالية"}
        description={lang === "id"
          ? "Buku uang sederhana restoran — bukan ERP."
          : "دفتر مالي بسيط للمطعم — ليس نظام محاسبة ERP."}
      />
      <PageHint>
        {lang === "id"
          ? "Saldo tersedia = Modal + Pemasukan − Pengeluaran − Pembayaran pembelian."
          : "الرصيد المتاح = رأس المال + الدخل − المصروفات − مدفوعات المشتريات."}
      </PageHint>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label={lang === "id" ? "Modal" : "رأس المال"} value={formatIDR(s?.netCapital ?? 0)} />
        <Metric label={lang === "id" ? "Pemasukan" : "الدخل"} value={formatIDR(s?.totalIncome ?? 0)} />
        <Metric label={lang === "id" ? "Pengeluaran" : "المصروفات"} value={formatIDR(s?.totalExpenses ?? 0)} />
        <Metric label={lang === "id" ? "Bayar pembelian" : "المشتريات المدفوعة"} value={formatIDR(s?.totalPurchasePayments ?? 0)} />
        <Metric label={lang === "id" ? "Saldo tersedia" : "الرصيد المتاح"} value={formatIDR(s?.available ?? 0)} emphasize />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <PrimaryButton onClick={() => setModal("capital-add")}>+ {lang === "id" ? "Tambah modal" : "إضافة رأس مال"}</PrimaryButton>
        <SecondaryButton onClick={() => setModal("capital-out")}>+ {lang === "id" ? "Tarik modal" : "سحب من رأس المال"}</SecondaryButton>
        <SecondaryButton onClick={() => setModal("income")}>+ {lang === "id" ? "Pemasukan" : "إضافة دخل"}</SecondaryButton>
        <SecondaryButton onClick={() => setModal("expense")}>+ {lang === "id" ? "Pengeluaran" : "إضافة مصروف"}</SecondaryButton>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      <Section title={lang === "id" ? "Modal" : "رأس المال"}>
        <SimpleTable
          lang={lang}
          cols={[lang === "id" ? "Tanggal" : "التاريخ", lang === "id" ? "Jenis" : "نوع الحركة", lang === "id" ? "Jumlah" : "المبلغ", lang === "id" ? "Oleh" : "بواسطة", lang === "id" ? "Catatan" : "ملاحظات", ""]}
          rows={(capital.data?.rows ?? []).map((r) => [
            String(r.entryDate),
            String(r.entryType),
            formatIDR(Number(r.amount)),
            String(r.actor || "—"),
            String(r.notes || "—"),
            <SecondaryButton key={String(r.id)} className="!px-2 !py-1 text-[11px]" onClick={async () => {
              try {
                await voidV3Capital(Number(r.id), lang === "id" ? "Dibatalkan" : "إلغاء");
                setFlash(lang === "id" ? "Dibatalkan" : "تم الإلغاء");
                await invalidate();
              } catch (e) { setError((e as Error).message); }
            }}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>,
          ])}
        />
      </Section>

      <Section title={lang === "id" ? "Pemasukan" : "الدخل"}>
        <SimpleTable
          lang={lang}
          cols={[lang === "id" ? "Tanggal" : "التاريخ", lang === "id" ? "Deskripsi" : "الوصف", lang === "id" ? "Jumlah" : "المبلغ", lang === "id" ? "Penerima" : "المستلم", lang === "id" ? "Catatan" : "ملاحظات", ""]}
          rows={(income.data?.rows ?? []).map((r) => [
            String(r.incomeDate),
            String(r.description),
            formatIDR(Number(r.amount)),
            String(r.receivedBy || "—"),
            String(r.notes || "—"),
            <SecondaryButton key={String(r.id)} className="!px-2 !py-1 text-[11px]" onClick={async () => {
              try {
                await voidV3Income(Number(r.id), lang === "id" ? "Dibatalkan" : "إلغاء");
                setFlash(lang === "id" ? "Dibatalkan" : "تم الإلغاء");
                await invalidate();
              } catch (e) { setError((e as Error).message); }
            }}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>,
          ])}
        />
      </Section>

      <Section title={lang === "id" ? "Pengeluaran" : "المصروفات"}>
        <SimpleTable
          lang={lang}
          cols={[lang === "id" ? "Tanggal" : "التاريخ", lang === "id" ? "Jenis" : "نوع المصروف", lang === "id" ? "Deskripsi" : "الوصف", lang === "id" ? "Jumlah" : "المبلغ", lang === "id" ? "Pembayar" : "من دفع", ""]}
          rows={(expenses.data?.rows ?? []).map((r) => [
            String(r.expenseDate),
            String(r.category || "—"),
            String(r.description),
            formatIDR(Number(r.amount)),
            String(r.paidBy || "—"),
            <SecondaryButton key={String(r.id)} className="!px-2 !py-1 text-[11px]" onClick={async () => {
              try {
                await voidV3Expense(Number(r.id), lang === "id" ? "Dibatalkan" : "إلغاء");
                setFlash(lang === "id" ? "Dibatalkan" : "تم الإلغاء");
                await invalidate();
              } catch (e) { setError((e as Error).message); }
            }}>{lang === "id" ? "Batal" : "إلغاء"}</SecondaryButton>,
          ])}
        />
      </Section>

      {modal ? (
        <FinanceModal
          lang={lang}
          kind={modal}
          onClose={() => setModal(null)}
          onSaved={async (msg) => {
            setModal(null);
            setFlash(msg);
            setError("");
            await invalidate();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function Metric({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className={`rounded-xl border border-[hsl(var(--border))] px-3 py-3 ${emphasize ? "bg-[hsl(var(--primary)/.08)]" : "bg-[hsl(var(--card))]"}`}>
      <div className="text-[11px] font-bold text-[hsl(var(--muted-foreground))]">{label}</div>
      <div className={`mt-1 font-mono text-base font-bold ${emphasize ? "text-[hsl(var(--primary))]" : ""}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="mb-2 text-sm font-bold">{title}</h2>
      <div className="panel soft-shadow overflow-auto">{children}</div>
    </div>
  );
}

function SimpleTable({ lang, cols, rows }: { lang: Lang; cols: string[]; rows: ReactNode[][] }) {
  return (
    <table className="w-full min-w-[720px] border-collapse text-sm" dir={lang === "ar" ? "rtl" : "ltr"}>
      <thead className="bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
        <tr>{cols.map((c, i) => <th key={i} className="px-3 py-3 text-start">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={cols.length} className="px-3 py-6 text-center text-[hsl(var(--muted-foreground))]">—</td></tr>
        ) : rows.map((r, i) => (
          <tr key={i} className="border-b border-[hsl(var(--border)/.5)]">
            {r.map((cell, j) => <td key={j} className="px-3 py-2.5">{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FinanceModal({
  lang, kind, onClose, onSaved, onError,
}: {
  lang: Lang;
  kind: "capital-add" | "capital-out" | "income" | "expense";
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [person, setPerson] = useState("");
  const [notes, setNotes] = useState("");
  const qc = useQueryClient();

  const title =
    kind === "capital-add" ? (lang === "id" ? "Tambah modal" : "إضافة رأس مال")
      : kind === "capital-out" ? (lang === "id" ? "Tarik modal" : "سحب من رأس المال")
        : kind === "income" ? (lang === "id" ? "Pemasukan" : "إضافة دخل")
          : (lang === "id" ? "Pengeluaran" : "إضافة مصروف");

  const mut = useMutation({
    mutationFn: async () => {
      const a = Number(amount);
      if (!(a > 0)) throw new Error(lang === "id" ? "Jumlah wajib" : "المبلغ مطلوب");
      if (kind === "capital-add" || kind === "capital-out") {
        return postV3Capital({
          entryDate: date,
          entryType: kind === "capital-add" ? "ADD" : "WITHDRAW",
          amount: a,
          notes,
          clientRequestId: newClientRequestId(),
        });
      }
      if (kind === "income") {
        return postV3Income({
          incomeDate: date,
          description,
          amount: a,
          receivedBy: person,
          notes,
          clientRequestId: newClientRequestId(),
        });
      }
      return postV3Expense({
        expenseDate: date,
        category,
        description,
        amount: a,
        paidBy: person,
        notes,
        clientRequestId: newClientRequestId(),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["v3-finance"] });
      onSaved(lang === "id" ? "Tersimpan" : "تم الحفظ");
    },
    onError: (e: Error) => onError(e.message),
  });

  return (
    <Modal title={title} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={lang === "id" ? "Tanggal" : "التاريخ"}>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label={lang === "id" ? "Jumlah" : "المبلغ"}>
          <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        {kind === "income" || kind === "expense" ? (
          <FormField label={lang === "id" ? "Deskripsi" : "الوصف"} className="sm:col-span-2">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        ) : null}
        {kind === "expense" ? (
          <FormField label={lang === "id" ? "Jenis" : "نوع المصروف"}>
            <TextInput value={category} onChange={(e) => setCategory(e.target.value)} />
          </FormField>
        ) : null}
        {kind === "income" || kind === "expense" ? (
          <FormField label={kind === "income" ? (lang === "id" ? "Penerima" : "المستلم") : (lang === "id" ? "Pembayar" : "من دفع")}>
            <TextInput value={person} onChange={(e) => setPerson(e.target.value)} />
          </FormField>
        ) : null}
        <FormField label={lang === "id" ? "Catatan" : "ملاحظات"} className="sm:col-span-2">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{lang === "id" ? "Tutup" : "إغلاق"}</SecondaryButton>
        <PrimaryButton disabled={mut.isPending} onClick={() => mut.mutate()}>{lang === "id" ? "Simpan" : "حفظ"}</PrimaryButton>
      </div>
    </Modal>
  );
}
