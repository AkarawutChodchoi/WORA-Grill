# 02 — Architecture & Data Model

## Architecture

```
web/ (React SPA, Vite)                       shared/ (pure TS: money, pricing, states, permissions, zod)
 ├─ Backoffice  /admin/*                        ▲            ▲
 ├─ POS         /pos/*                          │ imported by both sides
 ├─ Waiter      /waiter/*                       │            │
 ├─ KDS         /kds/*                    server/ (Fastify 5)
 └─ QR menu     /m/:token   ── REST /api/* ──▶  ├─ modules/<area>/routes.ts  (HTTP + zod validation + auth)
                ── WS /api/ws ─────────────▶   ├─ modules/<area>/service.ts (business rules, transactions)
                                                ├─ lib/ (auth, rbac, audit, events, errors, rate-limit)
                                                └─ db/ (Drizzle schema, migrations) ──▶ PostgreSQL / PGlite
```

- **Layering:** routes validate input and check permissions, services run business logic inside DB
  transactions, `shared/` holds pure functions (totals, state machines) that are unit-tested.
- **Tenancy:** every business row carries `organization_id` and, where it belongs to a location,
  `branch_id`. Services always filter by the session's organisation and an authorised branch;
  IDs from the client are never trusted on their own (look-ups are `WHERE id = ? AND organization_id = ?`).
- **Realtime:** services publish domain events (`order.created`, `order_item.status_changed`,
  `table.status_changed`, `menu.sold_out`, `call_waiter`, `payment.confirmed`, …) to an in-process
  bus; the WS gateway forwards them to clients subscribed to the same branch.

## Conventions

| Topic | Rule |
|---|---|
| Primary keys | `uuid` (`gen_random_uuid()` default, client may supply for offline/idempotency) |
| Timestamps | `timestamptz`; `created_at`, `updated_at`; soft delete via `archived_at` for master data |
| Money | `integer` satang (`*_satang`), aggregated as `bigint` in SQL |
| Rates | `integer` basis points (`*_bps`) |
| Inventory quantities / costs | `numeric(18,4)` / `numeric(18,6)` handled with decimal.js |
| Enums | `text` + check via Drizzle enum typing and zod (easy to extend without `ALTER TYPE`) |
| Deletion | Transactions (orders, payments, stock movements, audit) are **never deleted**; master data is archived |
| Snapshots | `order_items.name_snapshot`, `unit_price_satang`, modifier snapshots, tax/service settings on the order |

## Entity relationship (all phases)

```
organizations ─┬─ branches ─┬─ zones ── tables                                 (06)
               │            ├─ stations (kitchen/bar)                           (05/09)
               │            ├─ devices                                          (16)
               │            ├─ warehouses                                       (10)
               │            └─ shifts ── cash_movements                         (08)
               ├─ users ── user_roles(branch scope) ── roles ── role_permissions (02/04)
               ├─ sessions, audit_logs                                          (02/04)
               ├─ menu_categories ── menu_items ─┬─ menu_item_prices (channel/branch)    (05)
               │                                 ├─ menu_item_branch (availability/86)   (05)
               │                                 ├─ menu_item_modifier_groups            (05)
               │                                 └─ recipes ── recipe_lines ── ingredients (10)
               ├─ modifier_groups ── modifiers (── recipe for modifier)          (05/10)
               ├─ units, ingredients ── ingredient_units (conversions)           (10)
               ├─ stock_movements (ledger), stock_balances (cache), stock_lots   (10)
               ├─ stock_counts ── stock_count_lines                              (10)
               ├─ suppliers ── supplier_items                                    (11)
               ├─ purchase_requests / purchase_orders ── po_lines ── goods_receipts ── gr_lines, supplier_returns (11)
               ├─ customers ── loyalty_transactions                              (12)
               ├─ promotions ── coupons ── coupon_redemptions                    (12)
               ├─ reservations, waitlist_entries                                 (14)
               ├─ qr_sessions (table tokens), service_requests (call waiter)     (14)
               ├─ employees, schedules, attendance                               (15)
               ├─ stock_transfers ── stock_transfer_lines                        (15)
               └─ notifications, webhook_events, integration_configs             (16)

orders ─┬─ order_items ── order_item_modifiers                                   (07)
        ├─ order_discounts (snapshot of rule/coupon)                             (08/12)
        ├─ payments ── refunds                                                   (08)
        └─ FK: branch_id, table_id, customer_id, shift_id, opened_by, closed_by
order_counters (branch_id, business_date) → order_no                             (07)
```

Each module adds its own tables in its own migration (`server/drizzle/NNNN_<module>.sql`).

## State machines (`shared/src/states.ts`)

```
Order:     OPEN ⇄ BILL_REQUESTED → PAID → CLOSED
           OPEN / BILL_REQUESTED → VOIDED (permission order.void + reason)
           PAID → OPEN only when all payments are refunded (payment.refund)
OrderItem: PENDING → SENT → PREPARING → READY → SERVED
           PENDING/SENT/PREPARING/READY → CANCELLED (reason; after SENT needs order.cancel_item)
           Kitchen may step back one state (PREPARING → SENT, READY → PREPARING) to correct mis-taps.
Table:     AVAILABLE → OCCUPIED → WAITING_FOOD → DINING → BILL_REQUESTED → CLEANING → AVAILABLE
           (derived from the active order where possible; CLEANING → AVAILABLE is manual)
```

## Migrations & rollback

- Generate: `npm run db:generate -- --name <name>` (writes SQL + snapshot to `server/drizzle`).
- Apply: automatically at server start, or `npm run db:migrate`. Applied migrations are tracked in
  `drizzle.__drizzle_migrations`; re-running is a no-op.
- Strategy: **forward-only, additive** migrations (add columns nullable/with defaults, backfill, then
  tighten). Rollback = restore the pre-deploy backup (`docs/operations.md`) or ship a compensating migration.
  Never edit an applied migration file.

## API contract conventions

- JSON over `/api/*`; errors are `{ error: { code, message, details? } }` with proper HTTP status.
- Mutations that create money/stock records accept a client-supplied `id` (UUID) and are idempotent:
  replaying the same request returns the existing record instead of creating a duplicate.
- Session cookie `rms_session` (HttpOnly, SameSite=Strict). Mutating requests must send
  `X-Requested-With: rms` (CSRF defence in depth).
- Branch context: from the session (`branch_id`), switchable via `POST /api/auth/branch` to any branch the
  user is assigned to.
