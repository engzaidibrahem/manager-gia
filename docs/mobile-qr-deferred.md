# Mobile QR (Phase 10 — deferred)

## Already implemented (backend)

- `inventory_items.qr_token` generated on create
- `GET /api/inventory/items/by-qr/:token` — lookup item + remaining lots
- `POST /api/inventory/issue-to-kitchen` and transfers accept `qrToken`
- Session actor recorded on issue

## Frontend today

- QR token shown/copied on warehouse master grid
- `getItemByQr` helper exists in `bulk-api.ts` but is **not** used
- **No camera / scanner UI**

## Future mobile flow (not built now)

1. Chef scans QR
2. App calls by-qr
3. Enter quantity
4. Confirm → `issue-to-kitchen`
5. Warehouse stock decreases, kitchen increases, movement + actor + datetime persisted
