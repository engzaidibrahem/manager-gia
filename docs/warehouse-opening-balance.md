# Warehouse Opening Balance

## Business purpose

Record **physical stock that already exists** when the system starts (or when initializing an item), without silently editing `currentStock`.

This is **not** day-to-day receiving from a supplier, and **not** a cash-book opening balance.

Excel-like tables inside the app are used for entry. There is **no** Excel-import product workflow.

## API

`POST /api/inventory/opening-balance`

**Auth:** session required. Writes allowed for **owner** / **manager** only (`roles.ts` blocks warehouse/kitchen/viewer writes on this path).

**Body (do not send actor / stock fields):**

```json
{
  "lines": [
    { "itemId": 1, "quantity": 50, "unit": "kg", "unitCost": 40000, "note": "Initial" }
  ],
  "asOfDate": "2026-09-07",
  "notes": "Batch note",
  "clientRequestId": "uuid-optional-idempotency-key"
}
```

Actor and `userId` come from the authenticated session (`actorFrom`).

## Domain service

`postWarehouseOpeningBalance` in `artifacts/api-server/src/services/openingBalanceService.ts`

For each line (atomic transaction):

1. Validate item operable + unit conversion via shared `convertToBaseUnit`
2. Insert `warehouse_lots` (opening lot, no purchase link)
3. `applyLocationDelta(+qty, warehouse)` — sole stock writer
4. `recordMovement(type: "opening_balance", method: opening_balance[:clientRequestId])`

## Database effect

| Table | Effect |
|-------|--------|
| `inventory_items.current_stock` | +qty (base unit) |
| `warehouse_lots` | new lot with remaining = received |
| `inventory_movements` | `opening_balance` row + lot allocations |

## Duplicate handling

- Same `clientRequestId` → **idempotent** (200, no double stock)
- Item already has an unreverted `opening_balance` movement → **409 CONFLICT** (reverse first, or do not resubmit)
- Duplicate `itemId` inside one request → validation error

## Corrections

Do **not** delete opening movements. Use `POST /api/inventory/movements/:id/reverse` (same lot restore path as receive).

## Permissions

| Role | Opening balance write |
|------|------------------------|
| owner / manager | yes |
| warehouse / kitchen / cashier / viewer | no |

## UI

Route: `/opening-balance` — Excel-like grid + confirmation dialog.

Create master items first on **Gudang & Stok** if needed. Warehouse qty there remains **read-only**.
