# Inventory Architecture — Gia Shawarma Manager

## Principles

1. **ONE Inventory Core** — Web and Mobile call the same API / business services. No client-side stock math.
2. **No stock change without a domain transaction** — `RECEIVE`, `TRANSFER`, `ADJUSTMENT`, `WASTE`, `REVERSAL`.
3. **Locations** — `WAREHOUSE` (`currentStock`) and `KITCHEN` (`kitchenStock`).
4. **Purchase ≠ Receiving ≠ Transfer ≠ Expense ≠ Capital**.
5. **Recipe costing never mutates stock**.
6. **Strict unit conversion** — no silent fallback on incompatible units.
7. **Audit trail** — movements are append-only; correct via REVERSAL.
8. **Day / warehouse archive is a snapshot**, not a second inventory source of truth.
9. **Concurrency** — item + lot rows locked with `SELECT … FOR UPDATE` and conditional `UPDATE … WHERE stock + delta >= 0`.

## Flow

```text
Purchase (invoice / ordered)
    ↓
Receiving (POST /api/purchases/:id/receive)
    ↓
Warehouse stock + lot + RECEIVE movement
    ↓
Transfer WH → Kitchen (POST /api/inventory/transfers)  — FIFO lots internal
    ↓
Kitchen
    ↓
Waste / prep consumption (POST /api/inventory/waste)
```

```text
Web / Mobile
    ↓
Express API (auth + roles)
    ↓
Domain services
    ↓
PostgreSQL / PGlite
```

## Service layer

| Service | Responsibility |
|---------|----------------|
| `lib/units.ts` | Strict unit conversion (KG↔G, L↔ML, PCS↔PCS) |
| `services/inventoryService.ts` | Sole stock writer, movements, reverse, adjust, waste |
| `services/transferService.ts` | WH↔Kitchen + FIFO lot consume |
| `services/receivingService.ts` | Warehouse inbound + lot (+ purchase link) |
| `services/purchaseService.ts` | Purchase CRUD — **no stock** |
| `services/financeQueryService.ts` | Purchases-today + inventory value |
| `services/lotReconciliation.ts` | Report gaps; optional legacy lot backfill (admin) |

## Units

Allowed: KG↔G, L↔ML, PCS↔PCS.  
Forbidden: KG↔PCS, KG↔L, L↔PCS.  
Failure → clear validation error; **no stock mutation**.

## FIFO

Internal only. Oldest open `warehouse_lots` by `receipt_date`, `id`.  
Invariant: `SUM(quantity_remaining)` ≈ `currentStock` (within tolerance).

**`archive_id` on lots is snapshot linkage only.** Lots with remaining quantity remain consumable after warehouse day close (FIFO does not exclude archived lots).

## Receipt lot immutability

After a lot is created via Receiving, **quantityReceived / quantityRemaining cannot be edited**.

Allowed metadata edits: brand, cost, note, actor.

To fix a wrong quantity: reverse the original RECEIVE movement, then receive again.

## Legacy backfill

`POST /api/inventory/lots/backfill-legacy` is a **DATA MIGRATION TOOL** (owner/manager only).

- Does **not** change `currentStock` / `kitchenStock`
- Creates synthetic lots for **positive gaps only**
- Writes a `legacy_backfill` movement (not `receive`)
- Idempotent when gap already covered by open legacy lots
- Negative gaps: report only — never auto-destroy

`GET /api/inventory/lots/reconcile` is read-only and never mutates.

## Movements / reversal

- Ledger is append-only.
- `DELETE` of movements / receipt lots / waste records that would silently rewrite history is **rejected**.
- Correction: `POST /api/inventory/movements/:id/reverse` with session actor + optional reason + `reversalOfId`.

## Permissions

- Actor identity comes from authenticated session (`actorFrom(req)`), not client body.
- Roles enforced server-side (`requireAuth` + `requirePermission`).
- Frontend hiding buttons is not sufficient.

## Low stock

Uses **warehouse** `currentStock` vs `minimumStock` only.  
Do **not** add kitchen stock into the replenishment signal.  
`currentStock = 0` → OUT OF STOCK.

## Finance

- Cash day: `opening + income − expenses`.
- Purchases are **not** auto-expenses and do **not** drive capital carry.
- Inventory value is a display metric, not capital.

## QR / Mobile

Same endpoints as web:

| Method | Path |
|--------|------|
| GET | `/api/inventory/items/by-qr/:token` |
| POST | `/api/inventory/transfers` |
| POST | `/api/purchases/:id/receive` |
| POST | `/api/inventory/waste` |
| POST | `/api/inventory/adjustments` |
| POST | `/api/inventory/movements/:id/reverse` |
| GET | `/api/inventory/low-stock` |
| GET | `/api/inventory/items/:id/history` |

Auth: `Authorization: Bearer <token>`.  
Response includes updated stocks + `movementId` + timestamp. No stock math on client.

## Canonical vs legacy adapters

| Endpoint | Implementation |
|----------|----------------|
| `POST /inventory/transfers` | TransferService |
| `POST /inventory/transfers/bulk-save` | TransferService |
| `POST /inventory/issue-to-kitchen` | TransferService |
| `POST /purchases/:id/receive` | ReceivingService |
| `POST /inventory/receipts/bulk-save` (create) | ReceivingService |
| `POST /purchases/bulk-save` | PurchaseService (no stock) |
| `POST /inventory/adjustments` | InventoryService.adjustStock |
| `POST /inventory/waste` | InventoryService.wasteStock |
| `POST /inventory/movements/:id/reverse` | InventoryService.reverseMovement |

## Concurrency

- Item row: `SELECT id FROM inventory_items WHERE id = ? FOR UPDATE`
- Lots: `SELECT … FROM warehouse_lots … FOR UPDATE`
- Stock update: conditional `WHERE stock + delta >= 0 RETURNING`

Verified under PGlite with two concurrent 4kg transfers from 5kg (exactly one succeeds).  
**PostgreSQL production** should be verified with `pnpm run dev:db` + `DATABASE_URL=postgresql://…` — same SQL locking semantics.

## Testing

```bash
cd artifacts/api-server && pnpm test
```

Covers: E2E purchase→receive→transfer→waste, partial receive, FIFO, concurrent transfers, units, insufficient stock, reversal, low-stock warehouse-only, auth roles, lot gap report, adjustment units.

## Forbidden stock writers

Outside Inventory Core / Receiving / Transfer:

- Item PATCH / bulk-save must not set `currentStock` / `kitchenStock`
- Purchase save must not change stock
- Movement / lot / waste hard-delete that rewrites balances is rejected
