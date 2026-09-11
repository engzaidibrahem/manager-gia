# Operational Finance (Available Capital)

## Available Capital (source of truth)

```text
AvailableCapital =
  Σ active capital_entries
  + Σ active income
  − Σ active operational expenses (excluding purchase-like)
  − Σ active purchase_payments
```

All values are persisted in PostgreSQL/PGlite. Reloading the app does not reset them.

## Purchase payments

Paid purchases reduce Available Capital via `purchase_payments`.

- Posted by **Receive Goods** when `paymentStatus=paid` (default)
- Or via `POST /api/finance/purchase-payments`
- Soft-void only (`POST .../void`)
- **Never** auto-inserted into `expenses` (prevents double counting)

Unpaid purchases update warehouse stock on receive but do **not** reduce Available Capital until paid.

### Historical purchase-as-expense rows

Older data sometimes booked purchases into `expenses` (category containing `Pembelian`/`مشتريات`, descriptions with `مشتريات`, or notes `destination:…`).

Those rows are **excluded** from operational expense totals automatically, listed on `available-summary` as `suspectedPurchaseExpenses`, and can be soft-voided via `POST /api/finance/expenses/remediate-purchase-duplicates` (audit kept; no `purchase_payments` invented).

## Capital vs daily cash

| Concept | Table | Meaning |
|---------|-------|---------|
| Capital | `capital_entries` | Restaurant operational capital |
| Available Capital | derived | Capital + income − expenses − purchase payments |
| Daily cash opening | `daily_cash_balances` | Cash-drawer day book only |

## Soft void

Expenses and income use `status=active|voided` instead of hard delete on API paths.

## APIs

- `GET /api/finance/available-summary`
- `GET /api/finance/operational-summary` (alias)
- `POST /api/finance/expenses/remediate-purchase-duplicates`
- `POST /api/purchases/receive-goods` — atomic purchase + payment + receive
- Capital create/void unchanged
