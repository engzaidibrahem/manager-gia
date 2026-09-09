/**
 * Legacy lot backfill + warehouse stock vs open-lots reconciliation.
 *
 * IMPORTANT: This is a DATA MIGRATION tool, not an operational receive endpoint.
 * - Does NOT change currentStock / kitchenStock (balances already exist).
 * - Creates synthetic lots for positive gaps only.
 * - Records a LEGACY_BACKFILL movement for audit (not a real RECEIVE).
 * - Negative gaps are reported only — never auto-destroyed.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { inventoryItemsTable, warehouseLotsTable } from "@workspace/db";
import { AppError } from "../lib/errors";
import { recordMovement, type DbTx } from "./inventoryService";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type LotDiscrepancy = {
  itemId: number;
  itemName: string;
  unit: string;
  warehouseStock: number;
  openLotsTotal: number;
  gap: number;
  severity: "ok" | "positive_gap" | "negative_gap";
  status: "clean" | "needs_backfill" | "manual_review";
  possibleReason: string;
  action: "none" | "created_legacy_lot" | "manual_review" | "skipped_duplicate";
};

export type LotReconcileReport = {
  date: string;
  itemsChecked: number;
  cleanCount: number;
  positiveGapCount: number;
  negativeGapCount: number;
  syntheticLotsCreated: number;
  tool: "reconcile" | "backfill-legacy";
  note: string;
  discrepancies: LotDiscrepancy[];
};

async function openLotsTotal(itemId: number) {
  const [agg] = await db
    .select({ total: sql<number>`coalesce(sum(${warehouseLotsTable.quantityRemaining}), 0)` })
    .from(warehouseLotsTable)
    .where(eq(warehouseLotsTable.itemId, itemId));
  return Number(agg?.total ?? 0);
}

function classify(warehouseStock: number, openLotsTotal: number, itemName: string, unit: string, itemId: number): LotDiscrepancy | null {
  const gap = Math.round((warehouseStock - openLotsTotal) * 10000) / 10000;
  if (Math.abs(gap) <= 0.0001) return null;
  if (gap > 0) {
    return {
      itemId,
      itemName,
      unit,
      warehouseStock,
      openLotsTotal,
      gap,
      severity: "positive_gap",
      status: "needs_backfill",
      possibleReason:
        "Warehouse balance exceeds open lot remaining — likely pre-rearch purchase/inbound without lots, or lot consume mismatch.",
      action: "none",
    };
  }
  return {
    itemId,
    itemName,
    unit,
    warehouseStock,
    openLotsTotal,
    gap,
    severity: "negative_gap",
    status: "manual_review",
    possibleReason:
      "Open lots exceed warehouse balance — do NOT auto-destroy lots. Review transfers/receives/manual edits.",
    action: "manual_review",
  };
}

/** Report only — never mutates stock or lots. */
export async function getLotReconciliationReport(): Promise<LotReconcileReport> {
  const items = await db.select().from(inventoryItemsTable);
  const discrepancies: LotDiscrepancy[] = [];
  let cleanCount = 0;
  for (const item of items) {
    const warehouseStock = Number(item.currentStock);
    const lots = await openLotsTotal(item.id);
    const row = classify(warehouseStock, lots, item.name, item.unit, item.id);
    if (!row) {
      cleanCount += 1;
      continue;
    }
    discrepancies.push(row);
  }
  return {
    date: todayISO(),
    itemsChecked: items.length,
    cleanCount,
    positiveGapCount: discrepancies.filter((d) => d.severity === "positive_gap").length,
    negativeGapCount: discrepancies.filter((d) => d.severity === "negative_gap").length,
    syntheticLotsCreated: 0,
    tool: "reconcile",
    note: "Read-only. No stock or lots were modified. Positive gaps may be backfilled by owner/manager via POST /inventory/lots/backfill-legacy after review.",
    discrepancies,
  };
}

/**
 * Migration tool: for positive gaps only, create a synthetic lot + LEGACY_BACKFILL movement.
 * Does not change warehouse/kitchen balances.
 * Idempotent for a given gap: after success, gap becomes ~0 so a second run creates nothing.
 */
export async function backfillLegacyLots(opts: {
  actor: string;
  userId?: number | null;
  dryRun?: boolean;
}): Promise<LotReconcileReport> {
  if (!opts.actor?.trim()) {
    throw new AppError("VALIDATION_ERROR", "Actor required for legacy backfill");
  }

  const items = await db.select().from(inventoryItemsTable);
  const report: LotReconcileReport = {
    date: todayISO(),
    itemsChecked: items.length,
    cleanCount: 0,
    positiveGapCount: 0,
    negativeGapCount: 0,
    syntheticLotsCreated: 0,
    tool: "backfill-legacy",
    note: opts.dryRun
      ? "DRY RUN — no writes. DATA MIGRATION TOOL only; not a receive operation."
      : "DATA MIGRATION TOOL. Created synthetic lots + LEGACY_BACKFILL movements. Did NOT change stock balances.",
    discrepancies: [],
  };

  for (const item of items) {
    const warehouseStock = Number(item.currentStock);
    const lotsBefore = await openLotsTotal(item.id);
    const classified = classify(warehouseStock, lotsBefore, item.name, item.unit, item.id);
    if (!classified) {
      report.cleanCount += 1;
      continue;
    }
    if (classified.severity === "negative_gap") {
      report.negativeGapCount += 1;
      report.discrepancies.push(classified);
      continue;
    }

    report.positiveGapCount += 1;

    // Guard: if an open legacy-backfill lot already exists for this exact remaining gap note pattern, skip
    const existingLegacy = await db.select().from(warehouseLotsTable).where(and(
      eq(warehouseLotsTable.itemId, item.id),
      sql`${warehouseLotsTable.note} like 'legacy backfill%'`,
      sql`${warehouseLotsTable.quantityRemaining} > 0`,
    ));
    const legacyRemaining = existingLegacy.reduce((s, l) => s + Number(l.quantityRemaining), 0);
    if (legacyRemaining + 0.0001 >= classified.gap && existingLegacy.length) {
      report.discrepancies.push({
        ...classified,
        action: "skipped_duplicate",
        possibleReason: "Open legacy-backfill lot(s) already cover this gap — skipped to prevent duplication.",
      });
      continue;
    }

    if (opts.dryRun) {
      report.discrepancies.push({ ...classified, action: "none" });
      continue;
    }

    await db.transaction(async (tx) => {
      const [lot] = await tx.insert(warehouseLotsTable).values({
        itemId: item.id,
        receiptDate: report.date,
        brand: item.brand || "",
        quantityReceived: classified.gap,
        quantityRemaining: classified.gap,
        costPerUnit: Number(item.costPerUnit) || 0,
        note: `legacy backfill · gap ${classified.gap} ${item.unit} · stock was ${warehouseStock}, lots were ${lotsBefore}`,
        actor: opts.actor,
        purchaseId: null,
      }).returning();

      await recordMovement(tx as DbTx, {
        itemId: item.id,
        type: "legacy_backfill",
        location: "warehouse",
        quantity: classified.gap,
        baseQuantity: classified.gap,
        unit: item.unit,
        unitCost: Number(item.costPerUnit) || 0,
        note: `LEGACY_BACKFILL migration lot #${lot.id} — explains existing warehouse balance; stock unchanged`,
        actor: opts.actor,
        userId: opts.userId ?? null,
        lotId: lot.id,
        method: "legacy_backfill",
      });
    });

    report.syntheticLotsCreated += 1;
    report.discrepancies.push({
      ...classified,
      action: "created_legacy_lot",
      status: "needs_backfill",
    });
  }

  return report;
}
