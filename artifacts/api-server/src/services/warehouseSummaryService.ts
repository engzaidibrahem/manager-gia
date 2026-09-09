/**
 * Warehouse period summary — movement aggregates + live current stock.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  inventoryItemsTable,
  inventoryMovementsTable,
  warehouseLotsTable,
} from "@workspace/db";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const RECEIVE_TYPES = ["receive", "opening_balance", "in"] as const;
const ISSUE_TYPES = ["transfer"] as const;
const WASTE_TYPES = ["waste"] as const;
const ADJUST_TYPES = ["adjustment"] as const;

export async function getWarehouseSummary(opts?: { from?: string; to?: string }) {
  const items = await db.select().from(inventoryItemsTable)
    .where(sql`${inventoryItemsTable.archivedAt} IS NULL`)
    .orderBy(inventoryItemsTable.name);

  const movements = await db.select().from(inventoryMovementsTable)
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(5000);

  const from = opts?.from;
  const to = opts?.to;

  const inRange = (createdAt: Date | string) => {
    const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
    const day = iso.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  };

  const lastByItem = new Map<number, typeof movements[0]>();
  const agg = new Map<number, {
    incoming: number;
    outgoing: number;
    waste: number;
    adjustments: number;
  }>();

  for (const m of movements) {
    if (!lastByItem.has(m.itemId)) lastByItem.set(m.itemId, m);
    if (!inRange(m.createdAt)) continue;
    const bucket = agg.get(m.itemId) ?? { incoming: 0, outgoing: 0, waste: 0, adjustments: 0 };
    const qty = Math.abs(Number(m.baseQuantity ?? m.quantity) || 0);
    const type = String(m.type);
    if ((RECEIVE_TYPES as readonly string[]).includes(type)) bucket.incoming += qty;
    else if ((ISSUE_TYPES as readonly string[]).includes(type) && m.toLocation === "kitchen") bucket.outgoing += qty;
    else if ((ISSUE_TYPES as readonly string[]).includes(type) && m.location === "kitchen" && !m.toLocation) bucket.outgoing += qty;
    else if ((WASTE_TYPES as readonly string[]).includes(type) && m.location === "warehouse") bucket.waste += qty;
    else if ((ADJUST_TYPES as readonly string[]).includes(type) && m.location === "warehouse") {
      bucket.adjustments += Number(m.quantity) || 0;
    }
    agg.set(m.itemId, bucket);
  }

  const lotRows = await db
    .select({
      itemId: warehouseLotsTable.itemId,
      remaining: sql<number>`coalesce(sum(${warehouseLotsTable.quantityRemaining}), 0)`,
    })
    .from(warehouseLotsTable)
    .groupBy(warehouseLotsTable.itemId);
  const lotMap = new Map(lotRows.map((r) => [r.itemId, Number(r.remaining)]));

  return items.map((item) => {
    const a = agg.get(item.id) ?? { incoming: 0, outgoing: 0, waste: 0, adjustments: 0 };
    const current = Number(item.currentStock) || 0;
    const lotRemaining = lotMap.get(item.id) ?? 0;
    const last = lastByItem.get(item.id);
    const beginning = round2(current - a.incoming + a.outgoing + a.waste - a.adjustments);
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      unit: item.unit,
      beginning,
      incoming: round2(a.incoming),
      outgoing: round2(a.outgoing),
      waste: round2(a.waste),
      adjustments: round2(a.adjustments),
      current,
      kitchenStock: Number(item.kitchenStock) || 0,
      minimumStock: Number(item.minimumStock) || 0,
      costPerUnit: Number(item.costPerUnit) || 0,
      lotRemaining: round2(lotRemaining),
      lotGap: round2(current - lotRemaining),
      lastMovementAt: last?.createdAt
        ? (last.createdAt instanceof Date ? last.createdAt.toISOString() : String(last.createdAt))
        : null,
      lastMovementType: last?.type ?? null,
      lastActor: last?.actor ?? null,
      qrToken: item.qrToken,
    };
  });
}

export async function getStockIntegrityReport() {
  const summary = await getWarehouseSummary();
  const mismatches = summary.filter((r) => Math.abs(r.lotGap) > 0.01);
  return {
    itemCount: summary.length,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 100),
    note: "Operational SoT is inventory_items.current_stock. Lots should match within tolerance.",
  };
}
