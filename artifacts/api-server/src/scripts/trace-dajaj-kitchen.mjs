/**
 * READ-ONLY trace of kitchen stock for دجاج (production API).
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:5000";
const OUT = "d:/gia-shawarma-manager-self-host/backups/gia-v3-kitchen-dajaj-trace.json";

const login = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  })
).json();
const h = { Authorization: `Bearer ${login.token}` };

const hz = await (await fetch(`${BASE}/api/healthz`)).json();
if (!String(hz?.database?.kind || "").includes("production") && hz?.database?.kind !== "v3-production") {
  console.warn("WARN unexpected db kind", hz?.database);
}

const summary = await (
  await fetch(`${BASE}/api/v3/warehouse/summary?page=1&pageSize=200&status=all&q=${encodeURIComponent("دجاج")}`, {
    headers: h,
  })
).json();

const dajaj = summary.rows.find((r) => r.name === "دجاج");
if (!dajaj) {
  throw new Error("دجاج item not found");
}

const detail = await (await fetch(`${BASE}/api/v3/warehouse/items/${dajaj.id}`, { headers: h })).json();
const kitchen = await (await fetch(`${BASE}/api/v3/kitchen`, { headers: h })).json();
const kitRow = kitchen.rows.find((r) => r.id === dajaj.id);
const purchases = await (
  await fetch(`${BASE}/api/v3/purchases?pageSize=100&q=${encodeURIComponent("دجاج")}`, { headers: h })
).json();

const moves = (detail.movements || detail.item?.movements || []).length
  ? detail.movements || detail.item.movements
  : (
      await (
        await fetch(`${BASE}/api/v3/warehouse/movements?itemId=${dajaj.id}&pageSize=200`, { headers: h })
      ).json()
    ).rows;

const active = moves.filter((m) => m.status === "active");
const byType = {};
for (const m of active) {
  byType[m.movementType] = byType[m.movementType] || [];
  byType[m.movementType].push(m);
}

const sum = (arr) => arr.reduce((s, m) => s + (m.quantityNumeric == null ? 0 : Number(m.quantityNumeric)), 0);
const whToKit = sum(byType.WAREHOUSE_TO_KITCHEN || []);
const kitDirect = sum(byType.KITCHEN_DIRECT_IN || []);
const expectedKitchen = whToKit + kitDirect;

const report = {
  health: hz.database,
  item: {
    id: dajaj.id,
    name: dajaj.name,
    baseUnit: dajaj.baseUnit,
    openingRaw: dajaj.openingRaw,
    openingUnitRaw: dajaj.openingUnitRaw,
    openingNumeric: dajaj.openingNumeric,
    kitchenQty: dajaj.kitchenQty,
    currentWarehouse: dajaj.currentWarehouse,
    totalIn: dajaj.totalIn,
    totalOut: dajaj.totalOut,
    sourceType: dajaj.sourceType,
  },
  kitchenPageRow: kitRow || null,
  purchases: purchases.rows,
  movements: moves.map((m) => ({
    id: m.id,
    movementType: m.movementType,
    quantityNumeric: m.quantityNumeric,
    quantityRaw: m.quantityRaw,
    unitRaw: m.unitRaw,
    movementDate: m.movementDate,
    purchaseId: m.purchaseId,
    status: m.status,
    notes: m.notes,
    originalNameRaw: m.originalNameRaw,
  })),
  calc: {
    WAREHOUSE_TO_KITCHEN: whToKit,
    KITCHEN_DIRECT_IN: kitDirect,
    expectedKitchen,
    uiKitchenQty: kitRow?.kitchenQty ?? dajaj.kitchenQty,
    why3Kilo: `baseUnit field on item is "${dajaj.baseUnit}" — Kitchen page unit column renders baseUnit`,
  },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.calc, null, 2));
console.log("movements", report.movements.length);
console.log(
  "types",
  Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.map((m) => ({ id: m.id, qty: m.quantityNumeric, raw: m.quantityRaw, unit: m.unitRaw, date: m.movementDate, purchaseId: m.purchaseId }))])),
);
console.log("item baseUnit=", dajaj.baseUnit, "kitchenQty=", dajaj.kitchenQty);
console.log("purchases", purchases.rows.map((p) => ({ id: p.id, qty: p.quantityNumeric, dest: p.destination, status: p.status })));
