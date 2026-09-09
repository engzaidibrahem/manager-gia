# Manual UI QA Checklist — Gia Shawarma Manager

Use with local API + Web (`pnpm run dev:api` / `dev:web` or equivalent).  
Server permissions must still enforce rules — UI hide is not security.

Legend: ☐ pending · ☑ pass · ✗ fail

## Login
- [ ] Load page
- [ ] Valid credentials → dashboard
- [ ] Invalid credentials → error
- [ ] Empty fields → validation
- [ ] Refresh keeps/clears session as designed

## Dashboard
- [ ] Load metrics from API
- [ ] Low stock count uses warehouse only
- [ ] Refresh updates numbers

## Inventory
- [ ] List / search
- [ ] Create item (stock starts 0)
- [ ] Edit metadata (name/min/cost) — stock fields ignored by API
- [ ] Archive item — history preserved; cannot use in new ops
- [ ] Low stock filter
- [ ] Wrong unit on related ops → error

## Purchases
- [ ] Create purchase — stock unchanged
- [ ] Edit invoice metadata
- [ ] Delete unreceived → allowed
- [ ] Delete after receive → rejected
- [ ] Zero/negative qty → rejected
- [ ] Refresh shows DB truth

## Receiving
- [ ] Receive against purchase → WH + lot + movement
- [ ] Partial receive then complete
- [ ] Over-receive → rejected
- [ ] Duplicate full receive → rejected
- [ ] Refresh

## Warehouse / Transfers
- [ ] Transfer WH→Kitchen
- [ ] Insufficient stock → error
- [ ] Wrong unit → error
- [ ] Concurrent/double submit does not oversell (retry after refresh)
- [ ] Refresh stock matches API

## Kitchen
- [ ] Shows kitchen stock
- [ ] Issue/transfer path works
- [ ] Insufficient kitchen stock → error

## Waste
- [ ] Create kitchen waste
- [ ] Create warehouse waste
- [ ] Cannot delete saved waste (immutable)
- [ ] Invalid qty/unit → error
- [ ] Refresh

## Adjustments
- [ ] +qty / −qty via API/UI path
- [ ] Reverse via movement reverse
- [ ] Zero qty → rejected
- [ ] Refresh

## Recipes / Recipe Cost
- [ ] Create/edit recipe lines
- [ ] Preview matches saved API totals after save
- [ ] Invalid unit conversion → error, no save
- [ ] Editing recipe does not change stock
- [ ] Refresh

## Finance / Income / Expenses / Cash
- [ ] Opening cash load/save
- [ ] Closing = opening + income − expenses
- [ ] Purchases shown separately (not in cash formula)
- [ ] Zero/negative amounts handled
- [ ] Refresh

## Staff
- [ ] Employees CRUD
- [ ] Attendance save
- [ ] Refresh

## Permissions (repeat sensitive ops)
- [ ] viewer: read ok, write denied
- [ ] warehouse: inventory/purchases ok; finance write denied
- [ ] kitchen: waste/transfers limited as designed
- [ ] cashier: finance ok; inventory write denied
- [ ] Unauthorized (no token) → 401
