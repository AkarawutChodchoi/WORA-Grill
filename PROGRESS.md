# Implementation Progress

Status legend: ✅ implemented & verified (tests/typecheck/build run) · 🟡 partial (see notes) · ⬜ not started

| # | Prompt | Status | Notes |
|---|---|---|---|
| 01 | Project audit & plan | ✅ | `docs/01-implementation-plan.md` |
| 02 | Architecture & data model | ✅ | `docs/02-data-model.md`, core schema + migration 0000 |
| 03 | Design system & app shell | ✅ | Tokens in `web/src/styles.css`, UI kit `web/src/components/ui`, role-filtered shell `web/src/layouts/AppLayout.tsx` |
| 04 | Auth, roles, audit log | ✅ | Email+password, PIN on paired devices, RBAC w/ branch scope, manager-PIN approval, lockout, CSRF header, audit log UI |
| 05 | Menu, modifiers, pricing | ✅ | Categories/items/modifier groups/combos, th/en/zh names, branch+channel prices, time windows, 86 propagation event, image upload w/ magic-byte check, stations |
| 06 | Tables & floor plan | ✅ | Zones, tables, drag/keyboard floor-plan editor, derived statuses, open/move/join/unjoin with row locks + partial unique index, WebSocket gateway + polling fallback |
| 07 | POS orders | ✅ | Tested totals engine (shared/pricing.ts), idempotent client-id lines, draft vs send, hold/fire courses, cancel/void w/ reason+approval, split/merge, barcode entry, POS screen |
| 08 | Payments, shifts, receipts | ✅ | Cash/card/transfer/PromptPay (local EMVCo QR, manual confirm), mixed + split-by-people, no overpay, idempotent payment ids, refunds w/ approval, discount ceiling+override, shifts, pay-in/out, X/Z with variance, receipt + abbreviated/full tax invoice print views, branch settings page |
| 09 | KDS | ✅ | Station routing by category/item, WS + polling, aging colours from settings, all-day count, expo/served, undo step, device→station lock, 86 dialog, recall, beep on new ticket, printable per-station kitchen slips, ready-to-serve toasts |
| 10 | Recipes & inventory | ✅ | Ledger + cached balances w/ reconcile, explicit unit conversions, weighted-avg cost, FEFO lots, recipes for items/modifiers/sub-recipes, idempotent deduction on send + reversal on cancel, receive/issue/waste/adjust/transfer/produce, counts with variance, low-stock + expiry alerts, food cost %. See docs/10-inventory.md |
| 11 | Purchasing | ⬜ | |
| 12 | CRM, loyalty, promotions | ⬜ | |
| 13 | Reports & dashboard | ⬜ | |
| 14 | Reservations, QR ordering | ⬜ | |
| 15 | Staff & multi-branch | ⬜ | |
| 16 | Integrations, offline, devices | ⬜ | |
| 17 | Security, testing, deployment | ⬜ | |
