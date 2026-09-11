/** GIA_PURCHASE_IMPORT_V1 — Excel upload → review → confirm. */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FormField,
  NumberInput,
  PageHint,
  PrimaryButton,
  SecondaryButton,
  SelectInput,
  TextInput,
} from "@/components/FormKit";
import { Flash, PageTitle } from "@/components/layout";
import { type Lang } from "@/lib/i18n";
import { formatIDR } from "@/lib/utils";
import {
  confirmV3PurchaseImport,
  destinationLabel,
  listV3Items,
  paymentStatusLabel,
  validateV3PurchaseImport,
  type V3ImportConfirmResult,
  type V3ImportValidateResult,
} from "@/lib/v3-api";

type Dest = "WAREHOUSE" | "KITCHEN_DIRECT" | "CONSUMABLE" | "";

type ReviewRow = V3ImportValidateResult["rows"][number] & {
  destination: Dest;
  selected: boolean;
  inventoryItemId: string;
  useNewItem: boolean;
  newCategory: string;
};

type GroupPay = {
  paymentStatus: "PAID" | "UNPAID" | "PARTIAL";
  paidAmount: string;
};

function roundMoney(n: number) {
  return Math.round(n);
}

export function V3PurchaseImportPage({ lang }: { lang: Lang }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [groups, setGroups] = useState<V3ImportValidateResult["groups"]>([]);
  const [groupPay, setGroupPay] = useState<Record<string, GroupPay>>({});
  const [result, setResult] = useState<V3ImportConfirmResult | null>(null);
  const [step, setStep] = useState<"upload" | "review" | "done">("upload");

  const itemsQ = useQuery({
    queryKey: ["v3-items-brief-import"],
    queryFn: () => listV3Items(""),
    enabled: step === "review",
  });

  const validateMut = useMutation({
    mutationFn: (workbookBase64: string) => validateV3PurchaseImport({ workbookBase64 }),
    onSuccess: (data) => {
      setFingerprint(data.fileFingerprint);
      setGroups(data.groups);
      setRows(
        data.rows.map((r) => ({
          ...r,
          destination: "" as Dest,
          selected: false,
          inventoryItemId: "",
          useNewItem: true,
          newCategory: "",
        })),
      );
      const pay: Record<string, GroupPay> = {};
      for (const g of data.groups) {
        const status = g.paymentStatusHint || "UNPAID";
        pay[g.groupKey] = {
          paymentStatus: status,
          paidAmount:
            status === "PAID"
              ? String(g.invoiceTotal)
              : status === "PARTIAL"
                ? String(g.paidHintSum || 0)
                : "0",
        };
      }
      setGroupPay(pay);
      setResult(null);
      setStep("review");
      setFlash(lang === "id" ? "File divalidasi — tinjau sebelum konfirmasi" : "تم التحقق — راجع قبل التأكيد");
      setError("");
    },
    onError: (e: Error) => setError(e.message),
  });

  const confirmMut = useMutation({
    mutationFn: async () => {
      for (const r of rows) {
        if (!r.destination) throw new Error(`اختر الوجهة للسطر ${r.lineNo}`);
        if (
          (r.destination === "WAREHOUSE" || r.destination === "KITCHEN_DIRECT") &&
          (r.quantityNumeric == null || !(Number(r.quantityNumeric) > 0))
        ) {
          throw new Error(`صحّح الكمية قبل تأكيد المستودع/المطبخ (سطر ${r.lineNo})`);
        }
      }
      const invoicePayments = groups.map((g) => {
        const p = groupPay[g.groupKey] || { paymentStatus: "UNPAID" as const, paidAmount: "0" };
        let paidAmount = Number(p.paidAmount || 0);
        if (p.paymentStatus === "PAID") paidAmount = g.invoiceTotal;
        if (p.paymentStatus === "UNPAID") paidAmount = 0;
        return { groupKey: g.groupKey, paymentStatus: p.paymentStatus, paidAmount: roundMoney(paidAmount) };
      });
      return confirmV3PurchaseImport({
        fileFingerprint: fingerprint,
        invoicePayments,
        rows: rows.map((r) => ({
          lineNo: r.lineNo,
          purchaseDate: r.purchaseDate,
          purchaseTime: r.purchaseTime,
          supplier: r.supplier,
          invoiceNumber: r.invoiceNumber,
          itemName: r.itemName,
          quantityNumeric: r.quantityNumeric,
          quantityRaw: r.quantityRaw,
          unitRaw: r.unitRaw,
          unitPrice: r.unitPrice,
          totalAmount: r.totalAmount,
          notes: r.notes,
          sourceImageRef: r.sourceImageRef,
          destination: r.destination,
          inventoryItemId:
            r.destination === "WAREHOUSE" && !r.useNewItem && r.inventoryItemId
              ? Number(r.inventoryItemId)
              : null,
          newItem:
            r.destination === "WAREHOUSE" && r.useNewItem
              ? { name: r.itemName, category: r.newCategory, baseUnit: r.unitRaw }
              : null,
        })),
      });
    },
    onSuccess: async (res) => {
      setResult(res);
      if (res.completeSuccess) {
        setStep("done");
        setFlash(lang === "id" ? "Impor berhasil" : "تم الاستيراد بنجاح");
        await qc.invalidateQueries({ queryKey: ["v3-purchases"] });
        await qc.invalidateQueries({ queryKey: ["v3-warehouse"] });
        await qc.invalidateQueries({ queryKey: ["v3-kitchen"] });
        await qc.invalidateQueries({ queryKey: ["v3-finance"] });
      } else {
        setError(res.failures.map((f) => f.error).join(" · ") || "فشل الاستيراد");
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const allocationPreview = useMemo(() => {
    const out: Array<{ lineNo: number; paid: number; total: number; status: string }> = [];
    for (const g of groups) {
      const p = groupPay[g.groupKey] || { paymentStatus: "UNPAID" as const, paidAmount: "0" };
      const lines = rows
        .filter((r) => g.lineNos.includes(r.lineNo))
        .sort((a, b) => a.lineNo - b.lineNo);
      if (p.paymentStatus === "UNPAID") {
        for (const l of lines) out.push({ lineNo: l.lineNo, paid: 0, total: l.totalAmount, status: "UNPAID" });
      } else if (p.paymentStatus === "PAID") {
        for (const l of lines) out.push({ lineNo: l.lineNo, paid: l.totalAmount, total: l.totalAmount, status: "PAID" });
      } else {
        let rem = roundMoney(Number(p.paidAmount || 0));
        for (const l of lines) {
          const pay = Math.min(l.totalAmount, rem);
          rem -= pay;
          out.push({
            lineNo: l.lineNo,
            paid: pay,
            total: l.totalAmount,
            status: pay <= 0 ? "UNPAID" : pay >= l.totalAmount ? "PAID" : "PARTIAL",
          });
        }
      }
    }
    return out;
  }, [groups, groupPay, rows]);

  async function onFile(file: File | null) {
    if (!file) return;
    setError("");
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const b64 = btoa(binary);
    validateMut.mutate(b64);
  }

  function setSelectedDest(dest: Dest) {
    setRows((prev) => prev.map((r) => (r.selected ? { ...r, destination: dest } : r)));
  }

  return (
    <div className="fade-up" dir="rtl">
      <PageTitle
        eyebrow="GIA V3"
        title="استيراد مشتريات من Excel"
        description="GIA_PURCHASE_IMPORT_V1 — رفع → مراجعة → تصنيف الوجهة → تأكيد"
      />
      <PageHint>
        رفع الملف لا ينشئ مشتريات أو حركات مخزون. التأكيد فقط بعد اختيار الوجهة ومراجعة الدفع.
      </PageHint>

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/purchases">
          <SecondaryButton type="button">← العودة للمشتريات</SecondaryButton>
        </Link>
      </div>

      {error ? <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}
      <Flash message={flash} />

      {step === "upload" ? (
        <div className="panel soft-shadow p-4">
          <FormField label="ملف Excel (.xlsx)">
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void onFile(e.target.files?.[0] || null)}
            />
          </FormField>
          {validateMut.isPending ? <p className="mt-2 text-sm">جاري التحقق…</p> : null}
        </div>
      ) : null}

      {step === "review" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <SecondaryButton type="button" onClick={() => setRows((p) => p.map((r) => ({ ...r, selected: true })))}>
              تحديد الكل
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => setSelectedDest("WAREHOUSE")}>
              المحدد → مستودع
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => setSelectedDest("KITCHEN_DIRECT")}>
              المحدد → مطبخ
            </SecondaryButton>
            <SecondaryButton type="button" onClick={() => setSelectedDest("CONSUMABLE")}>
              المحدد → مستهلكات
            </SecondaryButton>
          </div>

          {groups.map((g) => {
            const pay = groupPay[g.groupKey] || { paymentStatus: "UNPAID" as const, paidAmount: "0" };
            const groupRows = rows.filter((r) => g.lineNos.includes(r.lineNo));
            return (
              <div key={g.groupKey} className="panel soft-shadow overflow-hidden">
                <div className="border-b border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-4 py-3">
                  <div className="flex flex-wrap gap-4 text-sm">
                    <div>التاريخ: <b>{g.purchaseDate}</b></div>
                    <div className="flex items-center gap-2">
                      المورد:
                      <TextInput
                        className="max-w-[180px]"
                        value={g.supplier}
                        onChange={(e) => {
                          const supplier = e.target.value;
                          setGroups((prev) =>
                            prev.map((x) => (x.groupKey === g.groupKey ? { ...x, supplier } : x)),
                          );
                          setRows((prev) =>
                            prev.map((x) =>
                              g.lineNos.includes(x.lineNo) ? { ...x, supplier } : x,
                            ),
                          );
                        }}
                      />
                    </div>
                    <div>رقم الفاتورة: <b>{g.invoiceNumber || "—"}</b></div>
                    <div>عدد البنود: <b>{g.lineCount}</b></div>
                    <div>إجمالي الفاتورة: <b>{formatIDR(g.invoiceTotal)}</b></div>
                  </div>
                  {g.existingDuplicate ? (
                    <p className="mt-2 text-xs font-bold text-amber-800">
                      تحذير: توجد مشتريات مؤكدة سابقاً لنفس المورد + رقم الفاتورة
                    </p>
                  ) : null}
                  <div className="mt-3 grid max-w-xl gap-2 sm:grid-cols-2">
                    <FormField label="حالة دفع الفاتورة">
                      <SelectInput
                        value={pay.paymentStatus}
                        onChange={(e) => {
                          const paymentStatus = e.target.value as GroupPay["paymentStatus"];
                          setGroupPay((prev) => ({
                            ...prev,
                            [g.groupKey]: {
                              paymentStatus,
                              paidAmount:
                                paymentStatus === "PAID"
                                  ? String(g.invoiceTotal)
                                  : paymentStatus === "UNPAID"
                                    ? "0"
                                    : prev[g.groupKey]?.paidAmount || "0",
                            },
                          }));
                        }}
                      >
                        <option value="UNPAID">{paymentStatusLabel("UNPAID", "ar")}</option>
                        <option value="PARTIAL">{paymentStatusLabel("PARTIAL", "ar")}</option>
                        <option value="PAID">{paymentStatusLabel("PAID", "ar")}</option>
                      </SelectInput>
                    </FormField>
                    {pay.paymentStatus === "PARTIAL" ? (
                      <FormField label="المدفوع للفاتورة">
                        <NumberInput
                          value={pay.paidAmount}
                          onChange={(e) =>
                            setGroupPay((prev) => ({
                              ...prev,
                              [g.groupKey]: { ...pay, paidAmount: e.target.value },
                            }))
                          }
                        />
                      </FormField>
                    ) : null}
                  </div>
                </div>

                <div className="overflow-auto">
                  <table className="w-full min-w-[1100px] border-collapse text-sm">
                    <thead className="text-[11px] text-[hsl(var(--muted-foreground))]">
                      <tr>
                        <th className="px-2 py-2">✓</th>
                        <th className="px-2 py-2">#</th>
                        <th className="px-2 py-2">المادة</th>
                        <th className="px-2 py-2">كمية</th>
                        <th className="px-2 py-2">وحدة</th>
                        <th className="px-2 py-2">سعر</th>
                        <th className="px-2 py-2">إجمالي</th>
                        <th className="px-2 py-2">ملاحظات</th>
                        <th className="px-2 py-2">تحذيرات</th>
                        <th className="px-2 py-2">الوجهة</th>
                        <th className="px-2 py-2">ربط المستودع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupRows.map((r) => (
                        <tr key={r.lineNo} className="border-t border-[hsl(var(--border)/.5)] align-top">
                          <td className="px-2 py-2">
                            <input
                              type="checkbox"
                              checked={r.selected}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo ? { ...x, selected: e.target.checked } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2 font-mono text-xs">{r.lineNo}</td>
                          <td className="px-2 py-2">
                            <TextInput
                              value={r.itemName}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo ? { ...x, itemName: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput
                              value={r.quantityNumeric == null ? "" : String(r.quantityNumeric)}
                              onChange={(e) => {
                                const v = e.target.value.trim();
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo
                                      ? {
                                          ...x,
                                          quantityNumeric: v === "" ? null : Number(v),
                                          unclearQuantity: v === "" || !(Number(v) > 0),
                                        }
                                      : x,
                                  ),
                                );
                              }}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <TextInput
                              value={r.unitRaw}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo ? { ...x, unitRaw: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput
                              value={String(r.unitPrice)}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo
                                      ? { ...x, unitPrice: roundMoney(Number(e.target.value || 0)) }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2">
                            <NumberInput
                              value={String(r.totalAmount)}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo
                                      ? { ...x, totalAmount: roundMoney(Number(e.target.value || 0)) }
                                      : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2">
                            <TextInput
                              value={r.notes}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo ? { ...x, notes: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-2 text-xs text-amber-800">
                            {r.warnings.join(" · ") || "—"}
                            {r.supplier !== undefined ? null : null}
                          </td>
                          <td className="px-2 py-2">
                            <SelectInput
                              value={r.destination}
                              onChange={(e) =>
                                setRows((prev) =>
                                  prev.map((x) =>
                                    x.lineNo === r.lineNo
                                      ? { ...x, destination: e.target.value as Dest }
                                      : x,
                                  ),
                                )
                              }
                            >
                              <option value="">— اختر —</option>
                              <option value="WAREHOUSE">{destinationLabel("WAREHOUSE", "ar")}</option>
                              <option value="KITCHEN_DIRECT">{destinationLabel("KITCHEN_DIRECT", "ar")}</option>
                              <option value="CONSUMABLE">{destinationLabel("CONSUMABLE", "ar")}</option>
                            </SelectInput>
                          </td>
                          <td className="px-2 py-2">
                            {r.destination === "WAREHOUSE" ? (
                              <div className="space-y-1">
                                <SelectInput
                                  value={r.useNewItem ? "new" : "exist"}
                                  onChange={(e) =>
                                    setRows((prev) =>
                                      prev.map((x) =>
                                        x.lineNo === r.lineNo
                                          ? { ...x, useNewItem: e.target.value === "new" }
                                          : x,
                                      ),
                                    )
                                  }
                                >
                                  <option value="new">مادة جديدة</option>
                                  <option value="exist">مادة موجودة</option>
                                </SelectInput>
                                {r.useNewItem ? (
                                  <TextInput
                                    placeholder="تصنيف"
                                    value={r.newCategory}
                                    onChange={(e) =>
                                      setRows((prev) =>
                                        prev.map((x) =>
                                          x.lineNo === r.lineNo ? { ...x, newCategory: e.target.value } : x,
                                        ),
                                      )
                                    }
                                  />
                                ) : (
                                  <SelectInput
                                    value={r.inventoryItemId}
                                    onChange={(e) =>
                                      setRows((prev) =>
                                        prev.map((x) =>
                                          x.lineNo === r.lineNo
                                            ? { ...x, inventoryItemId: e.target.value }
                                            : x,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="">— اختر مادة —</option>
                                    {(itemsQ.data?.rows ?? []).map((it) => (
                                      <option key={it.id} value={String(it.id)}>
                                        {it.name}
                                      </option>
                                    ))}
                                  </SelectInput>
                                )}
                              </div>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

          <div className="panel soft-shadow p-4">
            <h3 className="mb-2 font-bold">ملخص توزيع الدفع قبل التأكيد</h3>
            <div className="overflow-auto">
              <table className="w-full min-w-[500px] text-sm">
                <thead>
                  <tr className="text-[11px] text-[hsl(var(--muted-foreground))]">
                    <th className="px-2 py-1 text-start">السطر</th>
                    <th className="px-2 py-1 text-start">الإجمالي</th>
                    <th className="px-2 py-1 text-start">المدفوع</th>
                    <th className="px-2 py-1 text-start">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationPreview.map((a) => (
                    <tr key={a.lineNo} className="border-t border-[hsl(var(--border)/.4)]">
                      <td className="px-2 py-1 font-mono">{a.lineNo}</td>
                      <td className="px-2 py-1">{formatIDR(a.total)}</td>
                      <td className="px-2 py-1">{formatIDR(a.paid)}</td>
                      <td className="px-2 py-1">{paymentStatusLabel(a.status, "ar")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <PrimaryButton
              type="button"
              disabled={confirmMut.isPending}
              onClick={() => confirmMut.mutate()}
            >
              {confirmMut.isPending ? "جاري التأكيد…" : "تأكيد الاستيراد"}
            </PrimaryButton>
            <SecondaryButton
              type="button"
              onClick={() => {
                setStep("upload");
                setRows([]);
                setGroups([]);
                setResult(null);
              }}
            >
              رفع ملف آخر
            </SecondaryButton>
          </div>
          {lang === "id" ? <p className="text-xs text-[hsl(var(--muted-foreground))]">Arabic-first review UI</p> : null}
        </div>
      ) : null}

      {step === "done" && result ? (
        <div className="panel soft-shadow space-y-2 p-4 text-sm">
          <h3 className="text-lg font-bold">نتيجة الاستيراد</h3>
          <div>مشتريات جديدة: <b>{result.purchasesCreated}</b></div>
          <div>مكررة (idempotent): <b>{result.purchasesIdempotent}</b></div>
          <div>مستودع: <b>{result.warehouseEntries}</b></div>
          <div>مطبخ: <b>{result.kitchenEntries}</b></div>
          <div>مستهلكات: <b>{result.consumables}</b></div>
          <div>دفعات: <b>{result.paymentsCreated}</b></div>
          <div className="pt-2">
            <Link href="/purchases">
              <PrimaryButton type="button">فتح المشتريات</PrimaryButton>
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
