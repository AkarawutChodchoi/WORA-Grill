# 16 — Integrations, offline mode, notifications & devices

## What is implemented and how it is enabled

| Capability | Status | Enable with | Verified by |
|---|---|---|---|
| Static PromptPay QR (EMVCo, generated locally) | Working; **cashier confirms** with bank reference | Branch setting `promptPayId` + enable PROMPTPAY | Unit tests (CRC/payload) |
| PromptPay via Opn Payments (Omise) with auto-confirmation | Adapter + signed webhook; **disabled** until configured | `OPN_SECRET_KEY`, `OPN_WEBHOOK_SECRET` | Tests with a fake gateway + real HMAC verification. **Needs a real Opn account and sandbox test before go-live** (verify header names/format against current provider docs). |
| Webhook safety | HMAC verification, 10-min replay window, `webhook_events` idempotency, charge re-fetched from provider before money is marked received, amount must match | — | Tests (forged, early, replay) |
| Delivery platforms (GrabFood, LINE MAN, ShopeeFood) | Normalised order webhook `/api/webhooks/delivery/:provider` (HMAC `X-Signature`), idempotent by event id + external order id, lands in POS & KDS | `DELIVERY_WEBHOOK_SECRET` + a partner middleware | Tests. **Official partner API access is required**; menu/sold-out sync to platforms and GP reports are not implemented. Items with required modifiers are rejected (manual entry). |
| LINE staff alerts (low stock, web bookings) | Messaging API push; disabled until configured | `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_NOTIFY_TO` | Tests with mocked fetch. Customer marketing via LINE stays off (needs consent flows). |
| In-app notifications | Bell in the header, per-permission broadcast, read tracking | — | Tests |
| Receipt / kitchen printers | ESC/POS with Thai TIS-620, LAN TCP 9100, per-station kitchen printers (auto on send), drawer kick after cash sale, test page, failure → notification + browser-print fallback | ระบบ → อุปกรณ์ → เพิ่มเครื่องพิมพ์ | Tests against a local TCP socket. **Needs physical printer validation** (code page value differs by brand). |
| Cash drawer | Kick via receipt printer; no-sale open requires `cash.open_drawer` or manager PIN, audited | Printer with "ต่อลิ้นชักเงิน" | Byte-level test |
| Customer display, EDC terminal | **Not integrated** (no hardware SDK). EDC is recorded as CARD with approval code. | — | — |
| Email | **Not configured** (no SMTP). Reports export as CSV/PDF. | — | — |

## Offline mode

- **Service worker** (`web/public/sw.js`, production builds): app shell + hashed assets cache-first; read APIs (menu, tables, active orders, order detail, settings, me) network-first with cached fallback marked `x-offline-cache: 1`. Writes are never cached. Logout clears cached data.
- **Outbox** (`web/src/lib/outbox.ts`, IndexedDB): when the network is down, only idempotent POS writes are queued — open takeaway bill, add lines, send to kitchen, **cash** payments. Card/QR/transfer cannot be taken offline.
- Every queued write carries client-generated ids (order, line, payment), so retries never duplicate orders, payments or stock deductions.
- Sync: on `online`, on any successful API call, and every 15 s. Network errors/5xx/401/429 → retry later; other 4xx (e.g. bill already paid, table taken) → **FAILED** for a person to review; later steps of the same bill are held back so they cannot apply out of order.
- Offline cash payments are stored server-side with `offline_recorded_at` and are shown in the UI as *"บันทึกในเครื่อง ยังไม่ยืนยัน"* until synced — never as confirmed.
- Limitations: opening a dine-in table, voids, discounts, refunds and anything needing a manager PIN require a connection. Without a cached copy, an order never loaded on that device cannot be opened offline.
