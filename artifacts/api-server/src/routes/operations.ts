import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  attendanceTable,
  dailyArchivesTable,
  dailyPurchasesTable,
  employeesTable,
  expensesTable,
  incomeTable,
  inventoryItemsTable,
  inventoryMovementsTable,
  menuRecipesTable,
  recipeLinesTable,
  warehouseDayArchivesTable,
  warehouseLotsTable,
  wasteRecordsTable,
} from "@workspace/db";

const router: IRouter = Router();
const iso = (value: Date) => value.toISOString();
const newQrToken = () => `gia-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

type Location = "warehouse" | "kitchen";

/** Convert qty in `fromUnit` into inventory item base unit (`itemUnit`). */
export function convertToItemUnit(qty: number, fromUnit: string, itemUnit: string): number {
  const from = fromUnit.trim().toLowerCase();
  const to = itemUnit.trim().toLowerCase();
  if (from === to) return qty;

  const toBase: Record<string, { dim: "mass" | "vol" | "count"; factor: number }> = {
    kg: { dim: "mass", factor: 1000 },
    g: { dim: "mass", factor: 1 },
    gram: { dim: "mass", factor: 1 },
    grams: { dim: "mass", factor: 1 },
    l: { dim: "vol", factor: 1000 },
    liter: { dim: "vol", factor: 1000 },
    litre: { dim: "vol", factor: 1000 },
    ml: { dim: "vol", factor: 1 },
    pcs: { dim: "count", factor: 1 },
    pc: { dim: "count", factor: 1 },
    buah: { dim: "count", factor: 1 },
    unit: { dim: "count", factor: 1 },
  };

  const a = toBase[from];
  const b = toBase[to];
  if (!a || !b || a.dim !== b.dim) {
    // fallback: treat as same unit
    return qty;
  }
  return (qty * a.factor) / b.factor;
}

async function applyLocationDelta(
  tx: typeof db,
  itemId: number,
  location: Location,
  delta: number,
  opts?: { costPerUnit?: number },
) {
  const item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, itemId) });
  if (!item) throw new Error(`Item ${itemId} not found`);
  const field = location === "kitchen" ? "kitchenStock" : "currentStock";
  const next = Number(item[field]) + delta;
  if (next < -0.0001) {
    throw new Error(`Insufficient ${location} stock for ${item.name}`);
  }
  const patch: Record<string, unknown> = {
    [field]: Math.max(0, next),
    updatedAt: new Date(),
  };
  if (opts?.costPerUnit != null && opts.costPerUnit >= 0) {
    patch.costPerUnit = opts.costPerUnit;
  }
  await tx.update(inventoryItemsTable).set(patch).where(eq(inventoryItemsTable.id, itemId));
  return item;
}

const inventoryRowSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  category: z.string().min(1),
  unit: z.string().min(1),
  brand: z.string().optional(),
  variant: z.string().optional(),
  currentStock: z.number().min(0).optional(),
  kitchenStock: z.number().min(0).optional(),
  minimumStock: z.number().min(0),
  costPerUnit: z.number().min(0).optional(),
});

function serializeInv(item: typeof inventoryItemsTable.$inferSelect) {
  return {
    ...item,
    brand: item.brand ?? "",
    variant: item.variant ?? "",
    qrToken: item.qrToken || "",
    updatedAt: iso(item.updatedAt),
  };
}

router.post("/inventory/items/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(inventoryRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(recipeLinesTable).where(inArray(recipeLinesTable.inventoryItemId, parsed.data.deleteIds));
      await tx.delete(wasteRecordsTable).where(inArray(wasteRecordsTable.inventoryItemId, parsed.data.deleteIds));
      await tx.delete(warehouseLotsTable).where(inArray(warehouseLotsTable.itemId, parsed.data.deleteIds));
      await tx.delete(inventoryMovementsTable).where(inArray(inventoryMovementsTable.itemId, parsed.data.deleteIds));
      await tx.delete(inventoryItemsTable).where(inArray(inventoryItemsTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      if (row.id) {
        const existing = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.id) });
        if (!existing) continue;
        const payload = {
          name: row.name,
          category: row.category,
          unit: row.unit,
          brand: row.brand ?? existing.brand ?? "",
          variant: row.variant ?? existing.variant ?? "",
          minimumStock: row.minimumStock,
          costPerUnit: row.costPerUnit ?? existing.costPerUnit,
          // Keep live balances unless explicitly sent (adjustments)
          ...(row.currentStock != null ? { currentStock: row.currentStock } : {}),
          ...(row.kitchenStock != null ? { kitchenStock: row.kitchenStock } : {}),
          updatedAt: new Date(),
          qrToken: existing.qrToken || newQrToken(),
        };
        const [updated] = await tx.update(inventoryItemsTable).set(payload)
          .where(eq(inventoryItemsTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(inventoryItemsTable).values({
          name: row.name,
          category: row.category,
          unit: row.unit,
          brand: row.brand ?? "",
          variant: row.variant ?? "",
          qrToken: newQrToken(),
          currentStock: row.currentStock ?? 0,
          kitchenStock: row.kitchenStock ?? 0,
          minimumStock: row.minimumStock,
          costPerUnit: row.costPerUnit ?? 0,
        }).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved.map(serializeInv));
});

const movementRowSchema = z.object({
  id: z.number().optional(),
  itemId: z.number(),
  type: z.enum(["in", "out", "kitchen", "adjustment", "transfer"]),
  location: z.enum(["warehouse", "kitchen"]).optional(),
  quantity: z.number().positive(),
  note: z.string().optional(),
  actor: z.string().min(1),
});

router.post("/inventory/movements/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(movementRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        await tx.delete(inventoryMovementsTable).where(inArray(inventoryMovementsTable.id, parsed.data.deleteIds));
      }
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.id) continue;
        if (row.type === "transfer") {
          throw new Error("Use /inventory/transfers/bulk-save for transfers");
        }
        const location: Location = row.type === "kitchen"
          ? "kitchen"
          : (row.location ?? "warehouse");
        const delta = row.type === "in" || row.type === "adjustment" ? row.quantity : -row.quantity;
        const item = await applyLocationDelta(tx as typeof db, row.itemId, location, delta);
        const [created] = await tx.insert(inventoryMovementsTable).values({
          itemId: row.itemId,
          type: row.type,
          location,
          quantity: row.quantity,
          note: row.note ?? "",
          actor: row.actor,
        }).returning();
        results.push({ ...created, itemName: item.name, unit: item.unit });
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Bulk save failed" });
  }
});

const transferRowSchema = z.object({
  itemId: z.number(),
  quantity: z.number().positive(),
  actor: z.string().min(1),
  note: z.string().optional(),
  from: z.enum(["warehouse", "kitchen"]).default("warehouse"),
  to: z.enum(["warehouse", "kitchen"]).default("kitchen"),
});

router.post("/inventory/transfers/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(transferRowSchema) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await db.transaction(async (tx) => {
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.from === row.to) throw new Error("Transfer from/to must differ");
        const item = await applyLocationDelta(tx as typeof db, row.itemId, row.from, -row.quantity);
        await applyLocationDelta(tx as typeof db, row.itemId, row.to, row.quantity);
        const [created] = await tx.insert(inventoryMovementsTable).values({
          itemId: row.itemId,
          type: "transfer",
          location: row.to,
          quantity: row.quantity,
          note: row.note ?? `${row.from} → ${row.to}`,
          actor: row.actor,
        }).returning();
        results.push({ ...created, itemName: item.name, unit: item.unit, from: row.from, to: row.to });
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Transfer failed" });
  }
});

function serializeLot(
  lot: typeof warehouseLotsTable.$inferSelect,
  extra?: { itemName?: string; itemUnit?: string; category?: string; qrToken?: string },
) {
  return {
    id: lot.id,
    itemId: lot.itemId,
    receiptDate: lot.receiptDate,
    brand: lot.brand,
    quantityReceived: Number(lot.quantityReceived),
    quantityRemaining: Number(lot.quantityRemaining),
    costPerUnit: Number(lot.costPerUnit),
    note: lot.note,
    actor: lot.actor,
    archiveId: lot.archiveId,
    createdAt: iso(lot.createdAt),
    itemName: extra?.itemName,
    itemUnit: extra?.itemUnit,
    category: extra?.category,
    qrToken: extra?.qrToken,
  };
}



const receiptRowSchema = z.object({
  id: z.number().optional(),
  itemId: z.number(),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  brand: z.string().optional(),
  quantity: z.number().positive(),
  costPerUnit: z.number().min(0).optional(),
  actor: z.string().optional(),
  note: z.string().optional(),
});

router.get("/inventory/receipts", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const filters = date ? [eq(warehouseLotsTable.receiptDate, date)] : [];
  const rows = await db.select({
    lot: warehouseLotsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    category: inventoryItemsTable.category,
    qrToken: inventoryItemsTable.qrToken,
  }).from(warehouseLotsTable)
    .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(warehouseLotsTable.createdAt))
    .limit(500);
  res.json(rows.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken })));
});

router.post("/inventory/receipts/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(receiptRowSchema),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        const doomed = await tx.select().from(warehouseLotsTable).where(inArray(warehouseLotsTable.id, parsed.data.deleteIds));
        for (const lot of doomed) {
          if (lot.archiveId) throw new Error(`Lot #${lot.id} already archived — cannot delete`);
          await applyLocationDelta(tx as typeof db, lot.itemId, "warehouse", -Number(lot.quantityRemaining));
        }
        await tx.delete(warehouseLotsTable).where(inArray(warehouseLotsTable.id, parsed.data.deleteIds));
      }
      const results = [];
      for (const row of parsed.data.rows) {
        const item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.itemId) });
        if (!item) throw new Error(`Item ${row.itemId} not found`);
        const brand = (row.brand ?? item.brand ?? "").trim();
        const cost = row.costPerUnit ?? Number(item.costPerUnit) ?? 0;
        const actor = (row.actor ?? "").trim() || "warehouse";

        if (row.id) {
          const existing = await tx.query.warehouseLotsTable.findFirst({ where: eq(warehouseLotsTable.id, row.id) });
          if (!existing) continue;
          if (existing.archiveId) throw new Error(`Lot #${row.id} already archived — cannot edit`);
          const used = Number(existing.quantityReceived) - Number(existing.quantityRemaining);
          if (row.quantity < used - 0.0001) {
            throw new Error(`Lot #${row.id}: quantity cannot be less than already issued (${used})`);
          }
          const newRemaining = row.quantity - used;
          const delta = newRemaining - Number(existing.quantityRemaining);
          const [updated] = await tx.update(warehouseLotsTable).set({
            itemId: row.itemId,
            receiptDate: row.receiptDate,
            brand,
            quantityReceived: row.quantity,
            quantityRemaining: newRemaining,
            costPerUnit: cost,
            actor,
            note: row.note ?? "",
          }).where(eq(warehouseLotsTable.id, row.id)).returning();
          if (delta !== 0) {
            await applyLocationDelta(tx as typeof db, row.itemId, "warehouse", delta);
          }
          if (cost > 0 || brand) {
            await tx.update(inventoryItemsTable).set({
              ...(cost > 0 ? { costPerUnit: cost } : {}),
              ...(brand ? { brand } : {}),
              updatedAt: new Date(),
            }).where(eq(inventoryItemsTable.id, row.itemId));
          }
          if (updated) {
            results.push(serializeLot(updated, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken }));
          }
        } else {
          const [created] = await tx.insert(warehouseLotsTable).values({
            itemId: row.itemId,
            receiptDate: row.receiptDate,
            brand,
            quantityReceived: row.quantity,
            quantityRemaining: row.quantity,
            costPerUnit: cost,
            actor,
            note: row.note ?? "",
          }).returning();
          await applyLocationDelta(tx as typeof db, row.itemId, "warehouse", row.quantity, cost > 0 ? { costPerUnit: cost } : undefined);
          if (brand) {
            await tx.update(inventoryItemsTable).set({ brand, updatedAt: new Date() }).where(eq(inventoryItemsTable.id, row.itemId));
          }
          await tx.insert(inventoryMovementsTable).values({
            itemId: row.itemId,
            type: "in",
            location: "warehouse",
            quantity: row.quantity,
            note: row.note ?? `Receipt lot #${created.id}${brand ? ` · ${brand}` : ""}`,
            actor,
            lotId: created.id,
          });
          results.push(serializeLot(created, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken }));
        }
      }
      return results;
    });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Receipt save failed" });
  }
});

router.get("/inventory/lots", async (req, res): Promise<void> => {
  const itemId = req.query.itemId ? Number(req.query.itemId) : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const onlyRemaining = req.query.remaining !== "0" && req.query.remaining !== "false";
  const filters = [];
  if (itemId && !Number.isNaN(itemId)) filters.push(eq(warehouseLotsTable.itemId, itemId));
  if (onlyRemaining) filters.push(sql`${warehouseLotsTable.quantityRemaining} > 0`);
  const rows = await db.select({
    lot: warehouseLotsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    category: inventoryItemsTable.category,
    qrToken: inventoryItemsTable.qrToken,
  }).from(warehouseLotsTable)
    .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(warehouseLotsTable.receiptDate), desc(warehouseLotsTable.id))
    .limit(300);
  const mapped = rows.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken }));
  const filtered = q
    ? mapped.filter((r) => `${r.itemName} ${r.brand} ${r.category}`.toLowerCase().includes(q))
    : mapped;
  res.json(filtered);
});

router.get("/inventory/items/by-qr/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token || "").trim();
  if (!token) {
    res.status(400).json({ error: "Missing QR token" });
    return;
  }
  const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.qrToken, token) });
  if (!item) {
    res.status(404).json({ error: "Item not found for QR" });
    return;
  }
  const lots = await db.select().from(warehouseLotsTable)
    .where(and(eq(warehouseLotsTable.itemId, item.id), sql`${warehouseLotsTable.quantityRemaining} > 0`))
    .orderBy(desc(warehouseLotsTable.receiptDate));
  res.json({
    ...serializeInv(item),
    lots: lots.map((lot) => serializeLot(lot, { itemName: item.name, itemUnit: item.unit, category: item.category, qrToken: item.qrToken })),
  });
});

router.get("/inventory/items/search", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const withStock = req.query.withStock !== "0";
  const filters = [];
  if (q) {
    filters.push(sql`(
      lower(${inventoryItemsTable.name}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.category}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.brand}) like ${`%${q.toLowerCase()}%`}
      or lower(${inventoryItemsTable.variant}) like ${`%${q.toLowerCase()}%`}
    )`);
  }
  if (withStock) filters.push(sql`${inventoryItemsTable.currentStock} > 0`);
  const items = await db.select().from(inventoryItemsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(inventoryItemsTable.name))
    .limit(40);
  res.json(items.map(serializeInv));
});

const issueSchema = z.object({
  itemId: z.number().optional(),
  qrToken: z.string().optional(),
  lotId: z.number().optional().nullable(),
  quantity: z.number().positive(),
  actor: z.string().min(1),
  note: z.string().optional(),
});

router.post("/inventory/issue-to-kitchen", async (req, res): Promise<void> => {
  const parsed = issueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      let item = parsed.data.itemId
        ? await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, parsed.data.itemId) })
        : null;
      if (!item && parsed.data.qrToken) {
        item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.qrToken, parsed.data.qrToken) });
      }
      if (!item) throw new Error("Item not found");

      let lotId: number | null = parsed.data.lotId ?? null;
      if (lotId) {
        const lot = await tx.query.warehouseLotsTable.findFirst({ where: eq(warehouseLotsTable.id, lotId) });
        if (!lot || lot.itemId !== item.id) throw new Error("Lot not found for item");
        if (Number(lot.quantityRemaining) < parsed.data.quantity - 0.0001) {
          throw new Error(`Insufficient lot remaining (${lot.quantityRemaining})`);
        }
        await tx.update(warehouseLotsTable).set({
          quantityRemaining: Number(lot.quantityRemaining) - parsed.data.quantity,
        }).where(eq(warehouseLotsTable.id, lot.id));
        await applyLocationDelta(tx as typeof db, item.id, "warehouse", -parsed.data.quantity);
      } else {
        // FIFO across lots if any remain; else deduct item stock only
        const openLots = await tx.select().from(warehouseLotsTable)
          .where(and(eq(warehouseLotsTable.itemId, item.id), sql`${warehouseLotsTable.quantityRemaining} > 0`))
          .orderBy(asc(warehouseLotsTable.receiptDate), asc(warehouseLotsTable.id));
        if (openLots.length) {
          let left = parsed.data.quantity;
          for (const lot of openLots) {
            if (left <= 0) break;
            const take = Math.min(Number(lot.quantityRemaining), left);
            await tx.update(warehouseLotsTable).set({
              quantityRemaining: Number(lot.quantityRemaining) - take,
            }).where(eq(warehouseLotsTable.id, lot.id));
            left -= take;
            if (!lotId) lotId = lot.id;
          }
          if (left > 0.0001) throw new Error("Insufficient warehouse lot stock");
          await applyLocationDelta(tx as typeof db, item.id, "warehouse", -parsed.data.quantity);
        } else {
          await applyLocationDelta(tx as typeof db, item.id, "warehouse", -parsed.data.quantity);
        }
      }

      await applyLocationDelta(tx as typeof db, item.id, "kitchen", parsed.data.quantity);
      const [movement] = await tx.insert(inventoryMovementsTable).values({
        itemId: item.id,
        type: "transfer",
        location: "kitchen",
        quantity: parsed.data.quantity,
        note: parsed.data.note ?? "warehouse → kitchen",
        actor: parsed.data.actor,
        lotId,
      }).returning();

      const refreshed = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, item.id) });
      return {
        movement: { ...movement, createdAt: iso(movement.createdAt) },
        item: refreshed ? serializeInv(refreshed) : serializeInv(item),
        lotId,
      };
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Issue failed" });
  }
});

router.get("/inventory/issues", async (req, res): Promise<void> => {
  const actor = typeof req.query.actor === "string" ? req.query.actor.trim() : "";
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const filters = [eq(inventoryMovementsTable.type, "transfer"), eq(inventoryMovementsTable.location, "kitchen")];
  if (actor) filters.push(eq(inventoryMovementsTable.actor, actor));
  if (date) filters.push(sql`${inventoryMovementsTable.createdAt}::date = ${date}`);
  const rows = await db.select({
    movement: inventoryMovementsTable,
    itemName: inventoryItemsTable.name,
    itemUnit: inventoryItemsTable.unit,
    qrToken: inventoryItemsTable.qrToken,
  }).from(inventoryMovementsTable)
    .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
    .where(and(...filters))
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(200);
  res.json(rows.map(({ movement, itemName, itemUnit, qrToken }) => ({
    ...movement,
    itemName,
    itemUnit,
    qrToken,
    createdAt: iso(movement.createdAt),
  })));
});

function serializeWhArchive(row: typeof warehouseDayArchivesTable.$inferSelect, includeSnapshot = false) {
  let snapshot: unknown;
  if (includeSnapshot) {
    try { snapshot = JSON.parse(row.snapshotJson || "{}"); } catch { snapshot = {}; }
  }
  return {
    id: row.id,
    businessDate: row.businessDate,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    notes: row.notes,
    receiptCount: Number(row.receiptCount),
    totalQuantity: Number(row.totalQuantity),
    totalValue: Number(row.totalValue),
    ...(includeSnapshot ? { snapshot } : {}),
  };
}

router.get("/warehouse-archives", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const rows = await db.select().from(warehouseDayArchivesTable).orderBy(desc(warehouseDayArchivesTable.businessDate)).limit(365);
  if (!q) {
    res.json(rows.map((r) => serializeWhArchive(r, false)));
    return;
  }
  const matched = [];
  for (const row of rows) {
    const ser = serializeWhArchive(row, true);
    const snap = ser.snapshot as { receipts?: { itemName?: string; brand?: string; category?: string }[]; searchText?: string } | undefined;
    const hay = `${row.businessDate} ${row.notes ?? ""} ${snap?.searchText ?? ""} ${(snap?.receipts ?? []).map((r) => `${r.itemName} ${r.brand} ${r.category}`).join(" ")}`.toLowerCase();
    if (hay.includes(q)) matched.push(serializeWhArchive(row, false));
  }
  res.json(matched);
});

router.get("/warehouse-archives/:date", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select().from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "Warehouse day not archived" });
    return;
  }
  res.json(serializeWhArchive(rows[0], true));
});

router.get("/warehouse-archives/:date/status", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  const rows = await db.select({
    id: warehouseDayArchivesTable.id,
    closedAt: warehouseDayArchivesTable.closedAt,
    closedBy: warehouseDayArchivesTable.closedBy,
  }).from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
  res.json({
    date,
    archived: Boolean(rows[0]),
    closedAt: rows[0] ? iso(rows[0].closedAt) : null,
    closedBy: rows[0]?.closedBy ?? null,
  });
});

router.post("/warehouse-archives/close", async (req, res): Promise<void> => {
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    closedBy: z.string().optional(),
    notes: z.string().optional(),
    force: z.boolean().optional(),
    rows: z.array(receiptRowSchema).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const closedBy = (parsed.data.closedBy || "warehouse").trim() || "warehouse";
  const notes = parsed.data.notes?.trim() || null;
  const force = Boolean(parsed.data.force);

  try {
    const archive = await db.transaction(async (tx) => {
      // Optional: save new/updated receipts first (delta stock)
      if (parsed.data.rows?.length) {
        for (const row of parsed.data.rows) {
          const item = await tx.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, row.itemId) });
          if (!item) throw new Error(`Item ${row.itemId} not found`);
          const brand = (row.brand ?? item.brand ?? "").trim();
          const cost = row.costPerUnit ?? Number(item.costPerUnit) ?? 0;
          const actor = (row.actor ?? "").trim() || closedBy;
          if (row.id) {
            const existing = await tx.query.warehouseLotsTable.findFirst({ where: eq(warehouseLotsTable.id, row.id) });
            if (existing && !existing.archiveId) {
              const used = Number(existing.quantityReceived) - Number(existing.quantityRemaining);
              const newRemaining = row.quantity - used;
              const delta = newRemaining - Number(existing.quantityRemaining);
              await tx.update(warehouseLotsTable).set({
                receiptDate: row.receiptDate || date,
                brand,
                quantityReceived: row.quantity,
                quantityRemaining: newRemaining,
                costPerUnit: cost,
                actor,
                note: row.note ?? "",
              }).where(eq(warehouseLotsTable.id, row.id));
              if (delta !== 0) {
                await applyLocationDelta(tx as typeof db, row.itemId, "warehouse", delta);
              }
            }
          } else {
            const [created] = await tx.insert(warehouseLotsTable).values({
              itemId: row.itemId,
              receiptDate: row.receiptDate || date,
              brand,
              quantityReceived: row.quantity,
              quantityRemaining: row.quantity,
              costPerUnit: cost,
              actor,
              note: row.note ?? "",
            }).returning();
            await applyLocationDelta(tx as typeof db, row.itemId, "warehouse", row.quantity, cost > 0 ? { costPerUnit: cost } : undefined);
            if (brand) {
              await tx.update(inventoryItemsTable).set({ brand, updatedAt: new Date() }).where(eq(inventoryItemsTable.id, row.itemId));
            }
            await tx.insert(inventoryMovementsTable).values({
              itemId: row.itemId,
              type: "in",
              location: "warehouse",
              quantity: row.quantity,
              note: row.note ?? `Receipt lot #${created.id}`,
              actor,
              lotId: created.id,
            });
          }
        }
      }

      const existing = await tx.select().from(warehouseDayArchivesTable).where(eq(warehouseDayArchivesTable.businessDate, date)).limit(1);
      if (existing[0] && !force) {
        throw Object.assign(new Error("Warehouse day already archived"), { status: 409, archive: existing[0] });
      }

      const dayLots = await tx.select({
        lot: warehouseLotsTable,
        itemName: inventoryItemsTable.name,
        itemUnit: inventoryItemsTable.unit,
        category: inventoryItemsTable.category,
        qrToken: inventoryItemsTable.qrToken,
      }).from(warehouseLotsTable)
        .innerJoin(inventoryItemsTable, eq(warehouseLotsTable.itemId, inventoryItemsTable.id))
        .where(eq(warehouseLotsTable.receiptDate, date));

      const stockItems = await tx.select().from(inventoryItemsTable).orderBy(asc(inventoryItemsTable.category), asc(inventoryItemsTable.name));
      const receipts = dayLots.map(({ lot, itemName, itemUnit, category, qrToken }) => serializeLot(lot, { itemName, itemUnit, category, qrToken }));
      const totalQuantity = receipts.reduce((s, r) => s + r.quantityReceived, 0);
      const totalValue = receipts.reduce((s, r) => s + r.quantityReceived * r.costPerUnit, 0);
      const snapshot = {
        date,
        receipts,
        stockAtClose: stockItems.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          unit: i.unit,
          brand: i.brand,
          qrToken: i.qrToken,
          currentStock: Number(i.currentStock),
          kitchenStock: Number(i.kitchenStock),
          costPerUnit: Number(i.costPerUnit),
        })),
        searchText: receipts.map((r) => `${r.itemName} ${r.brand} ${r.category}`).join(" "),
      };

      const payload = {
        businessDate: date,
        closedBy,
        notes,
        receiptCount: receipts.length,
        totalQuantity,
        totalValue,
        snapshotJson: JSON.stringify(snapshot),
        closedAt: new Date(),
      };

      let archiveRow: typeof warehouseDayArchivesTable.$inferSelect;
      if (existing[0]) {
        const [updated] = await tx.update(warehouseDayArchivesTable).set(payload)
          .where(eq(warehouseDayArchivesTable.id, existing[0].id)).returning();
        archiveRow = updated!;
      } else {
        const [inserted] = await tx.insert(warehouseDayArchivesTable).values(payload).returning();
        archiveRow = inserted!;
      }

      // Link today's lots to this archive
      if (dayLots.length) {
        await tx.update(warehouseLotsTable)
          .set({ archiveId: archiveRow.id })
          .where(eq(warehouseLotsTable.receiptDate, date));
      }

      return archiveRow;
    });

    res.status(201).json(serializeWhArchive(archive, true));
  } catch (error) {
    const err = error as Error & { status?: number; archive?: typeof warehouseDayArchivesTable.$inferSelect };
    if (err.status === 409 && err.archive) {
      res.status(409).json({ error: err.message, archive: serializeWhArchive(err.archive, false) });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : "Close failed" });
  }
});

router.post("/finance/expenses/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      expenseDate: z.string(),
      expenseTime: z.string().optional(),
      category: z.string().min(1),
      description: z.string().min(1),
      amount: z.number().positive(),
      paidBy: z.string().min(1),
      receivedBy: z.string().min(1),
      paymentMethod: z.string().min(1),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(expensesTable).where(inArray(expensesTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        expenseDate: row.expenseDate,
        expenseTime: row.expenseTime ?? "",
        category: row.category,
        description: row.description,
        amount: row.amount,
        paidBy: row.paidBy,
        receivedBy: row.receivedBy,
        paymentMethod: row.paymentMethod,
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(expensesTable).set(payload).where(eq(expensesTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(expensesTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
});

router.post("/finance/income/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      incomeDate: z.string(),
      incomeTime: z.string().optional(),
      source: z.string().min(1),
      amount: z.number().positive(),
      recordedBy: z.string().min(1),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(incomeTable).where(inArray(incomeTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        incomeDate: row.incomeDate,
        incomeTime: row.incomeTime ?? "",
        source: row.source,
        amount: row.amount,
        recordedBy: row.recordedBy,
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(incomeTable).set(payload).where(eq(incomeTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(incomeTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
});

router.post("/staff/employees/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      fullName: z.string().min(1),
      role: z.string().min(1),
      phone: z.string().optional(),
      startDate: z.string(),
      status: z.enum(["active", "inactive"]).optional(),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(attendanceTable).where(inArray(attendanceTable.employeeId, parsed.data.deleteIds));
      await tx.delete(employeesTable).where(inArray(employeesTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        fullName: row.fullName,
        role: row.role,
        phone: row.phone ?? "",
        startDate: row.startDate,
        status: row.status ?? "active",
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(employeesTable).set(payload).where(eq(employeesTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(employeesTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  res.json(saved);
});

router.post("/staff/attendance/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      employeeId: z.number(),
      attendanceDate: z.string(),
      checkIn: z.string(),
      checkOut: z.string().optional(),
      status: z.enum(["present", "late", "absent", "leave"]),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const saved = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(attendanceTable).where(inArray(attendanceTable.id, parsed.data.deleteIds));
    }
    const results = [];
    for (const row of parsed.data.rows) {
      const payload = {
        employeeId: row.employeeId,
        attendanceDate: row.attendanceDate,
        checkIn: row.checkIn,
        checkOut: row.checkOut ?? "",
        status: row.status,
        notes: row.notes ?? "",
      };
      if (row.id) {
        const [updated] = await tx.update(attendanceTable).set(payload).where(eq(attendanceTable.id, row.id)).returning();
        if (updated) results.push(updated);
      } else {
        const [created] = await tx.insert(attendanceTable).values(payload).returning();
        results.push(created);
      }
    }
    return results;
  });
  const withNames = await Promise.all(saved.map(async (row) => {
    const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, row.employeeId) });
    return { ...row, employeeName: employee?.fullName ?? "" };
  }));
  res.json(withNames);
});

const purchaseRowSchema = z.object({
  id: z.number().optional(),
  purchaseDate: z.string(),
  purchaseTime: z.string().optional(),
  supplier: z.string().min(1),
  itemName: z.string().min(1),
  category: z.string().optional().default(""),
  quantity: z.number().positive(),
  unit: z.string().optional().default("kg"),
  unitPrice: z.number().min(0),
  totalAmount: z.number().min(0).optional(),
  paidBy: z.string().optional().default(""),
  receivedBy: z.string().optional().default(""),
  paymentMethod: z.string().optional().default("Cash"),
  inventoryItemId: z.number().optional().nullable(),
  destination: z.enum(["warehouse", "kitchen", "none"]).optional(),
  addToStock: z.enum(["yes", "no"]).optional(),
  notes: z.string().optional(),
  syncExpense: z.boolean().optional(),
}).transform((row) => ({
  ...row,
  category: row.category.trim() || "General",
  unit: row.unit.trim() || "kg",
  paidBy: row.paidBy.trim() || "Staff",
  receivedBy: row.receivedBy.trim() || "Gudang",
  paymentMethod: row.paymentMethod.trim() || "Cash",
}));

function resolveDestination(row: z.infer<typeof purchaseRowSchema>): "warehouse" | "kitchen" | "none" {
  if (row.destination) return row.destination;
  if (row.addToStock === "no") return "none";
  return "warehouse";
}

router.get("/purchases", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const rows = await db.select().from(dailyPurchasesTable)
    .where(date ? eq(dailyPurchasesTable.purchaseDate, date) : undefined)
    .orderBy(desc(dailyPurchasesTable.purchaseDate), desc(dailyPurchasesTable.createdAt))
    .limit(500);
  res.json(rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
});

router.post("/purchases/bulk-save", async (req, res): Promise<void> => {
  const parsed = z.object({ rows: z.array(purchaseRowSchema), deleteIds: z.array(z.number()).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        const oldRows = await tx.select().from(dailyPurchasesTable).where(inArray(dailyPurchasesTable.id, parsed.data.deleteIds));
        for (const old of oldRows) {
          const dest = (old.destination as "warehouse" | "kitchen" | "none") || (old.addToStock === "no" ? "none" : "warehouse");
          if ((dest === "warehouse" || dest === "kitchen") && old.inventoryItemId) {
            await applyLocationDelta(tx as typeof db, old.inventoryItemId, dest, -Number(old.quantity));
          }
        }
        await tx.delete(inventoryMovementsTable).where(inArray(inventoryMovementsTable.purchaseId, parsed.data.deleteIds));
        await tx.delete(dailyPurchasesTable).where(inArray(dailyPurchasesTable.id, parsed.data.deleteIds));
      }

      const results = [];
      for (const row of parsed.data.rows) {
        const destination = resolveDestination(row);
        if ((destination === "warehouse" || destination === "kitchen") && !row.inventoryItemId) {
          throw new Error(`Purchase "${row.itemName}" needs an inventory item for destination ${destination}`);
        }
        const totalAmount = row.totalAmount ?? row.quantity * row.unitPrice;
        const payload = {
          purchaseDate: row.purchaseDate,
          purchaseTime: row.purchaseTime ?? "",
          supplier: row.supplier,
          itemName: row.itemName,
          category: row.category,
          quantity: row.quantity,
          unit: row.unit,
          unitPrice: row.unitPrice,
          totalAmount,
          paidBy: row.paidBy,
          receivedBy: row.receivedBy,
          paymentMethod: row.paymentMethod,
          inventoryItemId: destination === "none" ? null : (row.inventoryItemId ?? null),
          destination,
          addToStock: destination === "none" ? "no" : "yes",
          notes: row.notes ?? "",
        };

        if (row.id) {
          const existing = await tx.query.dailyPurchasesTable.findFirst({ where: eq(dailyPurchasesTable.id, row.id) });
          if (existing) {
            const oldDest = (existing.destination as Location | "none") || "warehouse";
            if ((oldDest === "warehouse" || oldDest === "kitchen") && existing.inventoryItemId) {
              await applyLocationDelta(tx as typeof db, existing.inventoryItemId, oldDest, -Number(existing.quantity));
            }
            await tx.delete(inventoryMovementsTable).where(eq(inventoryMovementsTable.purchaseId, row.id));
          }
          const [purchase] = await tx.update(dailyPurchasesTable).set(payload).where(eq(dailyPurchasesTable.id, row.id)).returning();
          if ((destination === "warehouse" || destination === "kitchen") && row.inventoryItemId) {
            await applyLocationDelta(tx as typeof db, row.inventoryItemId, destination, row.quantity, { costPerUnit: row.unitPrice });
            await tx.insert(inventoryMovementsTable).values({
              itemId: row.inventoryItemId,
              type: "in",
              location: destination,
              quantity: row.quantity,
              note: `Purchase #${purchase.id}: ${row.supplier}`,
              actor: row.receivedBy,
              purchaseId: purchase.id,
            });
          }
          if (purchase) results.push(purchase);
        } else {
          const [purchase] = await tx.insert(dailyPurchasesTable).values(payload).returning();
          if (row.syncExpense !== false) {
            await tx.insert(expensesTable).values({
              expenseDate: row.purchaseDate,
              expenseTime: row.purchaseTime ?? "",
              category: "Pembelian / مشتريات",
              description: `${row.itemName} · ${row.supplier}`,
              amount: totalAmount,
              paidBy: row.paidBy,
              receivedBy: row.receivedBy,
              paymentMethod: row.paymentMethod,
              notes: `destination:${destination}`,
            });
          }
          if ((destination === "warehouse" || destination === "kitchen") && row.inventoryItemId) {
            await applyLocationDelta(tx as typeof db, row.inventoryItemId, destination, row.quantity, { costPerUnit: row.unitPrice });
            await tx.insert(inventoryMovementsTable).values({
              itemId: row.inventoryItemId,
              type: "in",
              location: destination,
              quantity: row.quantity,
              note: `Purchase #${purchase.id}: ${row.supplier}`,
              actor: row.receivedBy,
              purchaseId: purchase.id,
            });
          }
          if (purchase) results.push(purchase);
        }
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Bulk save failed" });
  }
});

// ——— Waste ———
router.get("/waste", async (req, res): Promise<void> => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const rows = await db.select({
    waste: wasteRecordsTable,
    itemName: inventoryItemsTable.name,
    unit: inventoryItemsTable.unit,
  }).from(wasteRecordsTable)
    .innerJoin(inventoryItemsTable, eq(wasteRecordsTable.inventoryItemId, inventoryItemsTable.id))
    .where(date ? eq(wasteRecordsTable.wasteDate, date) : undefined)
    .orderBy(desc(wasteRecordsTable.createdAt))
    .limit(500);
  res.json(rows.map(({ waste, itemName, unit }) => ({
    ...waste,
    itemName,
    unit,
    createdAt: iso(waste.createdAt),
  })));
});

router.post("/waste/bulk-save", async (req, res): Promise<void> => {
  const schema = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      wasteDate: z.string(),
      wasteTime: z.string().optional(),
      inventoryItemId: z.number(),
      location: z.enum(["warehouse", "kitchen"]),
      quantity: z.number().positive(),
      reason: z.enum(["spoilage", "prep", "theft", "other"]).default("spoilage"),
      actor: z.string().min(1),
      notes: z.string().optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const saved = await db.transaction(async (tx) => {
      if (parsed.data.deleteIds?.length) {
        const old = await tx.select().from(wasteRecordsTable).where(inArray(wasteRecordsTable.id, parsed.data.deleteIds));
        for (const row of old) {
          await applyLocationDelta(tx as typeof db, row.inventoryItemId, row.location as Location, Number(row.quantity));
        }
        await tx.delete(wasteRecordsTable).where(inArray(wasteRecordsTable.id, parsed.data.deleteIds));
      }
      const results = [];
      for (const row of parsed.data.rows) {
        if (row.id) continue;
        const item = await applyLocationDelta(tx as typeof db, row.inventoryItemId, row.location, -row.quantity);
        const costEstimate = row.quantity * Number(item.costPerUnit || 0);
        const [created] = await tx.insert(wasteRecordsTable).values({
          wasteDate: row.wasteDate,
          wasteTime: row.wasteTime ?? "",
          inventoryItemId: row.inventoryItemId,
          location: row.location,
          quantity: row.quantity,
          reason: row.reason,
          actor: row.actor,
          costEstimate,
          notes: row.notes ?? "",
        }).returning();
        await tx.insert(inventoryMovementsTable).values({
          itemId: row.inventoryItemId,
          type: "out",
          location: row.location,
          quantity: row.quantity,
          note: `Waste: ${row.reason}`,
          actor: row.actor,
        });
        results.push({ ...created, itemName: item.name, unit: item.unit });
      }
      return results;
    });
    res.json(saved.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Waste save failed" });
  }
});

// ——— Recipes / plate costing ———
function lineCost(qty: number, unit: string, itemUnit: string, costPerUnit: number, yieldPct: number) {
  const inItemUnit = convertToItemUnit(qty, unit, itemUnit);
  const yieldFactor = Math.max(1, yieldPct || 100) / 100;
  return (inItemUnit * costPerUnit) / yieldFactor;
}

router.get("/recipes", async (_req, res): Promise<void> => {
  const recipes = await db.select().from(menuRecipesTable).orderBy(desc(menuRecipesTable.updatedAt)).limit(200);
  const allLines = await db.select().from(recipeLinesTable);
  const items = await db.select().from(inventoryItemsTable);
  const itemMap = new Map(items.map((i) => [i.id, i]));

  res.json(recipes.map((recipe) => {
    const lines = allLines.filter((l) => l.recipeId === recipe.id).map((line) => {
      const item = itemMap.get(line.inventoryItemId);
      const cost = item
        ? lineCost(Number(line.quantity), line.unit, item.unit, Number(item.costPerUnit || 0), Number(line.yieldPct || 100))
        : 0;
      return {
        ...line,
        itemName: item?.name ?? "",
        itemUnit: item?.unit ?? "",
        costPerUnit: item?.costPerUnit ?? 0,
        lineCost: cost,
      };
    });
    const totalCost = lines.reduce((s, l) => s + l.lineCost, 0);
    const portions = Math.max(0.01, Number(recipe.portions) || 1);
    const costPerPortion = totalCost / portions;
    const targetPct = Math.max(1, Number(recipe.targetFoodCostPct) || 30);
    const suggestedPrice = costPerPortion / (targetPct / 100);
    const selling = Number(recipe.sellingPrice) || 0;
    const foodCostPct = selling > 0 ? (costPerPortion / selling) * 100 : 0;
    return {
      ...recipe,
      createdAt: iso(recipe.createdAt),
      updatedAt: iso(recipe.updatedAt),
      lines,
      totalCost,
      costPerPortion,
      suggestedPrice,
      foodCostPct,
    };
  }));
});

router.post("/recipes/bulk-save", async (req, res): Promise<void> => {
  const lineSchema = z.object({
    id: z.number().optional(),
    inventoryItemId: z.number(),
    quantity: z.number().positive(),
    unit: z.string().min(1),
    yieldPct: z.number().min(1).max(100).optional(),
    notes: z.string().optional(),
  });
  const parsed = z.object({
    rows: z.array(z.object({
      id: z.number().optional(),
      name: z.string().min(1),
      category: z.string().optional(),
      portions: z.number().positive().optional(),
      targetFoodCostPct: z.number().positive().optional(),
      sellingPrice: z.number().min(0).optional(),
      notes: z.string().optional(),
      lines: z.array(lineSchema).optional(),
    })),
    deleteIds: z.array(z.number()).optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const savedIds = await db.transaction(async (tx) => {
    if (parsed.data.deleteIds?.length) {
      await tx.delete(recipeLinesTable).where(inArray(recipeLinesTable.recipeId, parsed.data.deleteIds));
      await tx.delete(menuRecipesTable).where(inArray(menuRecipesTable.id, parsed.data.deleteIds));
    }
    const ids: number[] = [];
    for (const row of parsed.data.rows) {
      const payload = {
        name: row.name,
        category: row.category ?? "",
        portions: row.portions ?? 1,
        targetFoodCostPct: row.targetFoodCostPct ?? 30,
        sellingPrice: row.sellingPrice ?? 0,
        notes: row.notes ?? "",
        updatedAt: new Date(),
      };
      let recipeId = row.id;
      if (recipeId) {
        await tx.update(menuRecipesTable).set(payload).where(eq(menuRecipesTable.id, recipeId));
        if (row.lines) {
          await tx.delete(recipeLinesTable).where(eq(recipeLinesTable.recipeId, recipeId));
        }
      } else {
        const [created] = await tx.insert(menuRecipesTable).values(payload).returning();
        recipeId = created.id;
      }
      if (row.lines?.length) {
        await tx.insert(recipeLinesTable).values(row.lines.map((line) => ({
          recipeId: recipeId!,
          inventoryItemId: line.inventoryItemId,
          quantity: line.quantity,
          unit: line.unit,
          yieldPct: line.yieldPct ?? 100,
          notes: line.notes ?? "",
        })));
      }
      ids.push(recipeId!);
    }
    return ids;
  });

  const all = savedIds.length
    ? await db.select().from(menuRecipesTable).where(inArray(menuRecipesTable.id, savedIds))
    : [];
  const allLines = savedIds.length
    ? await db.select().from(recipeLinesTable).where(inArray(recipeLinesTable.recipeId, savedIds))
    : [];
  const items = await db.select().from(inventoryItemsTable);
  const itemMap = new Map(items.map((i) => [i.id, i]));
  res.json(all.map((recipe) => {
    const lines = allLines.filter((l) => l.recipeId === recipe.id).map((line) => {
      const item = itemMap.get(line.inventoryItemId);
      const cost = item
        ? lineCost(Number(line.quantity), line.unit, item.unit, Number(item.costPerUnit || 0), Number(line.yieldPct || 100))
        : 0;
      return { ...line, itemName: item?.name ?? "", itemUnit: item?.unit ?? "", costPerUnit: item?.costPerUnit ?? 0, lineCost: cost };
    });
    const totalCost = lines.reduce((s, l) => s + l.lineCost, 0);
    const portions = Math.max(0.01, Number(recipe.portions) || 1);
    const costPerPortion = totalCost / portions;
    const targetPct = Math.max(1, Number(recipe.targetFoodCostPct) || 30);
    return {
      ...recipe,
      createdAt: iso(recipe.createdAt),
      updatedAt: iso(recipe.updatedAt),
      lines,
      totalCost,
      costPerPortion,
      suggestedPrice: costPerPortion / (targetPct / 100),
      foodCostPct: Number(recipe.sellingPrice) > 0 ? (costPerPortion / Number(recipe.sellingPrice)) * 100 : 0,
    };
  }));
});

const closeDayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  closedBy: z.string().optional(),
  notes: z.string().optional(),
  force: z.boolean().optional(),
});

function serializeArchive(row: typeof dailyArchivesTable.$inferSelect, includeSnapshot = false) {
  let snapshot: unknown = undefined;
  if (includeSnapshot) {
    try {
      snapshot = JSON.parse(row.snapshotJson || "{}");
    } catch {
      snapshot = {};
    }
  }
  return {
    id: row.id,
    businessDate: row.businessDate,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    notes: row.notes,
    totalIncome: Number(row.totalIncome),
    totalExpenses: Number(row.totalExpenses),
    netCash: Number(row.netCash),
    totalPurchases: Number(row.totalPurchases),
    purchaseCount: Number(row.purchaseCount),
    wasteCost: Number(row.wasteCost),
    kitchenMovements: Number(row.kitchenMovements),
    attendanceCount: Number(row.attendanceCount),
    warehouseValue: Number(row.warehouseValue),
    kitchenValue: Number(row.kitchenValue),
    ...(includeSnapshot ? { snapshot } : {}),
  };
}

async function buildDaySnapshot(date: string) {
  const [incomeRows, expenseRows, purchaseRows, wasteRows, movements, attendanceRows, stockItems] = await Promise.all([
    db.select().from(incomeTable).where(eq(incomeTable.incomeDate, date)).orderBy(desc(incomeTable.createdAt)),
    db.select().from(expensesTable).where(eq(expensesTable.expenseDate, date)).orderBy(desc(expensesTable.createdAt)),
    db.select().from(dailyPurchasesTable).where(eq(dailyPurchasesTable.purchaseDate, date)).orderBy(desc(dailyPurchasesTable.createdAt)),
    db.select().from(wasteRecordsTable).where(eq(wasteRecordsTable.wasteDate, date)).orderBy(desc(wasteRecordsTable.createdAt)),
    db.select({
      movement: inventoryMovementsTable,
      itemName: inventoryItemsTable.name,
      itemUnit: inventoryItemsTable.unit,
    }).from(inventoryMovementsTable)
      .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
      .where(sql`${inventoryMovementsTable.createdAt}::date = ${date}`)
      .orderBy(desc(inventoryMovementsTable.createdAt)),
    db.select({
      attendance: attendanceTable,
      employeeName: employeesTable.fullName,
    }).from(attendanceTable)
      .leftJoin(employeesTable, eq(attendanceTable.employeeId, employeesTable.id))
      .where(eq(attendanceTable.attendanceDate, date)),
    db.select().from(inventoryItemsTable).orderBy(asc(inventoryItemsTable.category), asc(inventoryItemsTable.name)),
  ]);

  const totalIncome = incomeRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalExpenses = expenseRows.reduce((s, r) => s + Number(r.amount), 0);
  const totalPurchases = purchaseRows.reduce((s, r) => s + Number(r.totalAmount), 0);
  const wasteCost = wasteRows.reduce((s, r) => s + Number(r.costEstimate), 0);
  const kitchenMovements = movements.filter((m) => m.movement.type === "kitchen").length;
  const warehouseValue = stockItems.reduce((s, i) => s + Number(i.currentStock) * Number(i.costPerUnit), 0);
  const kitchenValue = stockItems.reduce((s, i) => s + Number(i.kitchenStock) * Number(i.costPerUnit), 0);

  const snapshot = {
    date,
    income: incomeRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    expenses: expenseRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    purchases: purchaseRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    waste: wasteRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    movements: movements.map(({ movement, itemName, itemUnit }) => ({
      ...movement,
      itemName,
      itemUnit,
      createdAt: iso(movement.createdAt),
    })),
    attendance: attendanceRows.map(({ attendance, employeeName }) => ({
      ...attendance,
      employeeName: employeeName ?? "",
    })),
    stockAtClose: stockItems.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      unit: i.unit,
      currentStock: Number(i.currentStock),
      kitchenStock: Number(i.kitchenStock),
      costPerUnit: Number(i.costPerUnit),
      warehouseValue: Number(i.currentStock) * Number(i.costPerUnit),
      kitchenValue: Number(i.kitchenStock) * Number(i.costPerUnit),
    })),
  };

  return {
    totals: {
      totalIncome,
      totalExpenses,
      netCash: totalIncome - totalExpenses,
      totalPurchases,
      purchaseCount: purchaseRows.length,
      wasteCost,
      kitchenMovements,
      attendanceCount: attendanceRows.length,
      warehouseValue,
      kitchenValue,
    },
    snapshot,
  };
}

/** List archived days (newest first). */
router.get("/day-archives", async (_req, res): Promise<void> => {
  const rows = await db.select().from(dailyArchivesTable).orderBy(desc(dailyArchivesTable.businessDate)).limit(120);
  res.json(rows.map((row) => serializeArchive(row, false)));
});

/** Get one archived day with full snapshot. */
router.get("/day-archives/:date", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select().from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "Day not archived" });
    return;
  }
  res.json(serializeArchive(rows[0], true));
});

/** Check if a date is already archived (lightweight). */
router.get("/day-archives/:date/status", async (req, res): Promise<void> => {
  const date = String(req.params.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const rows = await db.select({
    id: dailyArchivesTable.id,
    closedAt: dailyArchivesTable.closedAt,
    closedBy: dailyArchivesTable.closedBy,
  }).from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  res.json({
    date,
    archived: Boolean(rows[0]),
    closedAt: rows[0] ? iso(rows[0].closedAt) : null,
    closedBy: rows[0]?.closedBy ?? null,
  });
});

/**
 * End-of-day archive: freeze purchases, stock movements, waste, cash, and stock balances for the day.
 * Does not delete live data — creates a read-only snapshot. Use force=true to re-archive.
 */
router.post("/day-archives/close", async (req, res): Promise<void> => {
  const parsed = closeDayBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const closedBy = (parsed.data.closedBy || "manager").trim() || "manager";
  const notes = parsed.data.notes?.trim() || null;
  const force = Boolean(parsed.data.force);

  const existing = await db.select().from(dailyArchivesTable).where(eq(dailyArchivesTable.businessDate, date)).limit(1);
  if (existing[0] && !force) {
    res.status(409).json({
      error: "Day already archived",
      archive: serializeArchive(existing[0], false),
    });
    return;
  }

  const { totals, snapshot } = await buildDaySnapshot(date);
  const payload = {
    businessDate: date,
    closedBy,
    notes,
    totalIncome: totals.totalIncome,
    totalExpenses: totals.totalExpenses,
    netCash: totals.netCash,
    totalPurchases: totals.totalPurchases,
    purchaseCount: totals.purchaseCount,
    wasteCost: totals.wasteCost,
    kitchenMovements: totals.kitchenMovements,
    attendanceCount: totals.attendanceCount,
    warehouseValue: totals.warehouseValue,
    kitchenValue: totals.kitchenValue,
    snapshotJson: JSON.stringify(snapshot),
  };

  let row: typeof dailyArchivesTable.$inferSelect;
  if (existing[0]) {
    const updated = await db.update(dailyArchivesTable)
      .set({ ...payload, closedAt: new Date() })
      .where(eq(dailyArchivesTable.id, existing[0].id))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await db.insert(dailyArchivesTable).values(payload).returning();
    row = inserted[0]!;
  }

  res.status(existing[0] ? 200 : 201).json(serializeArchive(row, true));
});

export default router;
