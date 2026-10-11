# 01 — Project Audit & Implementation Plan

Source of truth: `สเปกระบบจัดการร้านอาหารแบบละเอียด.md` (referred to as **SPEC**, section numbers like §3.1).

## 1. Audit of the starting repository (2026-10-11)

| Item | Finding |
|---|---|
| Application code | **None.** Folder contained only the SPEC, `README_START_HERE.md`, and 17 prompt files. |
| Git | Not a repository → initialised locally (`git init`), no remote. |
| Toolchain on machine | Node 24.20, npm 11.19, Git 2.55, Python 3.13. **No Docker, no PostgreSQL server, no pnpm.** |
| Framework / DB / auth / tests / deploy | None existed. Everything below is a greenfield decision. |

Because the prompts assume an existing codebase, their "preserve the existing stack" rule is
interpreted as: *choose a stack once (here), then every later prompt preserves it.*

## 2. Technology decisions

| Concern | Decision | Why |
|---|---|---|
| Language | TypeScript everywhere (strict) | One type system for API contracts, money logic and UI. |
| Layout | Single npm package with `server/`, `web/`, `shared/` | One `node_modules`, shared business logic imported by both sides without a publish step. |
| Backend | Node + **Fastify 5** | Fast, schema-friendly, first-class WebSocket/cookie/multipart plugins. SPEC §7 lists Node. |
| Validation | **zod** schemas in `shared/` | Same validation on client and server; server is authoritative. |
| Database | **PostgreSQL** (SPEC §7) via **Drizzle ORM**. Dev/test use **PGlite** (Postgres compiled to WASM, file-persisted); production uses a real Postgres via `DATABASE_URL` + `pg`. | No Postgres/Docker on this machine. PGlite gives genuine Postgres SQL semantics locally, so migrations are identical for prod. |
| Migrations | `drizzle-kit generate` → SQL files in `server/drizzle/`, applied at startup / `npm run db:migrate`. Forward-only; rollback = restore backup or a compensating migration (documented in `docs/operations.md`). | |
| IDs | UUID v4 (`crypto.randomUUID`), client-generatable | SPEC §5 — needed for offline creation and idempotent retries. |
| Money | **Integer satang** (`integer`/`bigint`) everywhere; rates in **basis points** (VAT 7% = 700). | SPEC §5 "never float". |
| Inventory qty/cost | Postgres `numeric` + **decimal.js** | Fractional grams/ml and per-unit costs. |
| Auth | Own implementation: email+password (backoffice) and user-select + 4–6 digit PIN (front of house). Passwords/PINs hashed with Node `scrypt`. Opaque session tokens (hashed in DB) in `HttpOnly; SameSite=Strict` cookies. | SPEC §3.17. No third-party provider required. |
| Authorisation | Granular RBAC permissions (`order.void`, `bill.discount`, …) → roles → user role assignments **scoped to branch**. Manager-PIN approval for sensitive actions. | SPEC §2. |
| Realtime | WebSocket (`@fastify/websocket`) + in-process event bus, branch-scoped channels. Clients also refetch on reconnect. Redis pub/sub documented as the scale-out path. | SPEC §6/§7. |
| Frontend | **React 19 + Vite + React Router 7 + TanStack Query + Tailwind CSS 4**, lucide icons. One SPA with role-aware areas: Backoffice, POS, Waiter, KDS, and public QR menu. | SPEC §7. |
| Offline | Service worker + IndexedDB outbox with client UUIDs (Prompt 16). | SPEC §3.17. |
| Printing | Browser print layouts (receipt / kitchen ticket) + ESC/POS encoder and a TCP:9100 network-printer adapter (needs hardware to verify). | SPEC §7. |
| PromptPay | Generate standard EMVCo PromptPay QR locally; confirmation is **manual by cashier** unless a gateway adapter (Opn/Omise style, webhook-signed) is configured. | Never auto-confirm without a verified source. |
| Tests | **Vitest**: unit tests for shared logic, API integration tests with `fastify.inject` against an in-memory PGlite, a few React Testing Library tests. ESLint + `tsc --noEmit`. | |
| UI language | Staff UI in **Thai** (primary market); QR customer menu supports th/en/zh. | SPEC §3.4. |

## 3. Implementation inventory (SPEC → status at start)

All SPEC items were **Missing** at audit time. The table records the plan for each and whether it is
**blocked by external dependencies** (credentials, hardware, legal review).

| SPEC area | Plan (prompt) | External blocker? |
|---|---|---|
| §2 Roles & RBAC, PIN, audit log | 04 | — |
| §3.7 Menu, categories, modifiers, channel/branch prices, sold-out | 05 | Image storage is local disk (S3 adapter later) |
| §3.2 Tables, zones, floor plan, status, move/merge | 06 | — |
| §3.1 POS orders, items, courses, hold/fire, notes, void | 07 | — |
| §3.1 Payments, discounts, service/VAT, split, shifts, X/Z report, receipts | 08 | Card/EDC & e-wallet need provider; printer hardware |
| §3.6 KDS stations, timers, all-day count, expo, 86 | 09 | Kitchen printer hardware |
| §3.7–3.8 Recipes/BOM, sub-recipes, inventory ledger, counts, waste, lots | 10 | — |
| §3.9 Suppliers, PR→PO→GR, returns, reorder suggestions | 11 | — |
| §3.12–3.13 CRM, loyalty, tiers, coupons, promotions | 12 | LINE OA / SMS for campaigns |
| §3.14 Reports, dashboard, exports | 13 | Tax reports are not a legal guarantee |
| §3.3–3.4 Reservations, waitlist, QR ordering | 14 | SMS/LINE reminders |
| §3.11, §3.16 Staff, schedules, attendance, multi-branch, transfers | 15 | Payroll/SSO/WHT need compliance review → **out of scope** |
| §3.10 Delivery platforms, §3.17 devices, offline, notifications | 16 | Grab/LINE MAN/Shopee APIs need partner access; LINE credentials; hardware |
| §3.15 Accounting integrations, e-Tax invoice | Not planned (adapter note only) | FlowAccount/PEAK/RD e-Tax credentials and certification |
| Hardening, tests, deployment docs | 17 | Real production infra |

## 4. Phases (SPEC §8) and sequence

1. **MVP** — 02 data model, 03 shell, 04 auth/RBAC, 05 menu, 06 tables, 07 POS, 08 payments/shifts/receipts (+ daily sales in 08's X/Z reports).
2. **Operations** — 09 KDS; bill split/merge (07/08); QR ordering (14); offline (16).
3. **Cost control** — 10 recipes/inventory, 11 purchasing, food-cost reports (13).
4. **Growth** — 12 CRM/loyalty/promotions, 14 reservations/queue, 15 staff.
5. **Scale** — 15 multi-branch & transfers, 16 integrations, 17 readiness.

Prompts are executed in numeric order; each ends with tests + typecheck + build and a local git commit.

## 5. Smallest viable MVP

One organisation, one branch, Owner/Manager/Cashier/Waiter/Kitchen roles, menu with modifiers,
table open/close, POS order → kitchen ticket, cash + PromptPay (manual confirm) payment with
service charge and VAT, receipt print view, shift open/close with X/Z report.

## 6. Key dependencies

- Orders depend on menu (snapshots) and tables; payments depend on order totals; KDS depends on order item states.
- Stock deduction depends on recipes **and** a chosen deduction event (decision: **when items are sent to the kitchen**, reversed on cancellation — see Prompt 10 doc).
- Promotions depend on the order totals pipeline; reports depend on everything.

## 7. Risky assumptions (documented, smallest sensible choice)

| # | Assumption |
|---|---|
| A1 | VAT mode (inclusive/exclusive) and service charge % are **branch settings**; default VAT 7% exclusive, service charge 10%, service charge is VAT-able (Thai common practice). |
| A2 | Service charge applies to dine-in only by default (configurable). |
| A3 | Rounding: totals rounded to whole satang (half-up); optional cash rounding is not implemented. |
| A4 | Business day is the calendar day in the branch timezone (default `Asia/Bangkok`). Bill numbers reset per business day. |
| A5 | Static PromptPay QR cannot be auto-verified; a cashier with `payment.confirm_transfer` must confirm. |
| A6 | Inventory costing method: **weighted average** (one method, not mixed). |
| A7 | Negative stock is allowed for SALE deductions (kitchen must not be blocked) but flagged; manual issues/adjustments cannot go negative without `stock.adjust`. |
| A8 | Loyalty: earn rate and tiers are org settings; disabled until configured. |
| A9 | Payroll, social-security, withholding tax, OT rules are out of scope (Prompt 15 rule). |

## 8. Progress tracking

See `PROGRESS.md` at repo root — updated at the end of every prompt.
