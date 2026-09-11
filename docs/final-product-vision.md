# Final Product Vision (Phase 2 aligned)

Gia Shawarma Manager is an **internal restaurant management system** for:

Warehouse · Inventory · Opening balances · Purchases · Receiving · Kitchen transfers · Waste · Adjustments · **Operational capital** · Operational expenses · Manually entered income · Operational management summaries · (future) Mobile QR warehouse ops

**Not** POS / cashier sales / customer orders / full accounting ERP / COGS profit engine.

## Excel correction

The product uses **Excel-like tables inside the app** for fast manual entry.

It is **not** an Excel Import System as the main workflow.

## Phase 1 delivered

- Official **Warehouse Opening Balance** (domain + API + UI)
- Warehouse master table filters (category / stock status) + warehouse-only value/low/out metrics
- Purchases grid clarity: invoice ≠ stock; receive separately

See `docs/warehouse-opening-balance.md`.

## Phase 2 delivered (updated)

- Capital Register + **purchase_payments** ledger
- **Available Capital** = Capital + Income − Expenses − Paid purchases
- Atomic **Receive Goods** (purchase + payment + stock + lot + movement)
- Soft-void for expenses/income; FIFO ignores archive lock on remaining lots

See `docs/operational-finance.md`, `docs/mobile-qr-deferred.md`.
