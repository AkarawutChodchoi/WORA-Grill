# ระบบจัดการร้านอาหาร — Restaurant Management System

Full restaurant operations system built from `สเปกระบบจัดการร้านอาหารแบบละเอียด.md`:
POS (dine-in / takeaway / delivery), floor plan & tables, kitchen display (KDS), menu with modifiers and
branch/channel pricing, payments (cash, card/EDC, transfer, PromptPay), shifts & cash drawer with X/Z
reports, receipts & tax invoices, recipes & inventory ledger, purchasing, CRM/loyalty/promotions,
reports & dashboard, reservations/queue, QR self-ordering, staff scheduling/attendance, multi-branch &
central kitchen, notifications, LAN printers and offline mode.

Progress per implementation prompt: [`PROGRESS.md`](PROGRESS.md). Design decisions: [`docs/`](docs).

## Stack

TypeScript everywhere · **Fastify 5** API · **React 19 + Vite + Tailwind 4** SPA · **PostgreSQL** via Drizzle ORM
(embedded **PGlite** when no `DATABASE_URL` is set) · WebSocket realtime · Vitest.
Money is stored as integer satang; inventory quantities as `numeric`.

```
server/   API (modules/<area>/routes.ts + service.ts), db schema + migrations (server/drizzle)
web/      SPA: back office, POS, KDS, waiter, guest QR menu, queue & booking pages
shared/   Pure business logic shared by both sides (money, totals, promotions, PromptPay, permissions)
docs/     Plan, data model, module decisions, operations guide
```

## Requirements

- Node.js **22+** (developed on 24) and npm
- Optional: PostgreSQL 15+ for production (otherwise the embedded PGlite database is used)

## Quick start (development)

```bash
npm install
cp .env.example .env            # then set NODE_ENV=development
npm run db:migrate              # creates ./data/pglite and applies migrations
npm run db:seed                 # optional DEMO restaurant; prints the generated owner password + staff PINs
npm run dev                     # API on :3000, web on http://localhost:5173
```

Without seeding, open http://localhost:5173 — the first-run screen creates your organisation, first branch
and owner account.

Front-of-house tablets: sign in as a manager, go to **ระบบ → อุปกรณ์**, register the device as POS/Waiter/KDS,
then staff switch users with their PIN at `/pin`.

## Production

```bash
npm ci
npm run build                   # dist/web (SPA) + dist/server (bundled API)
npm run db:migrate              # always before starting a new version
npm start                       # serves API + SPA on PORT
```

See **[docs/operations.md](docs/operations.md)** for HTTPS, PostgreSQL, backups/restore, rollback,
monitoring and the deployment checklist.

## Database & migrations

- Schema: `server/src/db/schema/*.ts`. Migrations: `server/drizzle/NNNN_*.sql` (forward-only).
- Create a migration after changing the schema: `npm run db:generate -- --name <change>`.
- Apply: `npm run db:migrate` (also runs automatically when the server starts). Re-running is a no-op.
- Backups (PGlite): `npm run db:backup` → `data/backups/*.tar.gz`; restore with `npm run db:restore -- <file>`
  into an empty `PGLITE_DIR`. PostgreSQL: `pg_dump` / `pg_restore` (docs/operations.md).

## Environment variables

All documented in [`.env.example`](.env.example) (safe example values only). Integrations stay disabled
until their variables are set.

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Listen address |
| `DATABASE_URL` | PostgreSQL connection string; empty → embedded PGlite in `PGLITE_DIR` |
| `UPLOAD_DIR` | Menu images |
| `SESSION_TTL_HOURS` | Session lifetime |
| `COOKIE_SECURE` | `true` behind HTTPS (Secure cookies, HSTS, CSP upgrade) |
| `TRUST_PROXY` | `true` only behind your own reverse proxy |
| `PUBLIC_BASE_URL` | Base URL printed in QR codes |
| `OPN_SECRET_KEY`, `OPN_WEBHOOK_SECRET` | PromptPay auto-confirmation via Opn Payments |
| `DELIVERY_WEBHOOK_SECRET` | HMAC secret for the delivery-platform order webhook |
| `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_NOTIFY_TO` | LINE staff alerts |
| `AUTO_KITCHEN_PRINT` | Auto-print kitchen tickets to LAN printers |
| `SEED_*` | Demo seed only |

## Quality checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest: unit + API integration tests on an in-memory Postgres
npm run build
npm run check       # all of the above
node scripts/smoke.mjs http://localhost:3000   # end-to-end flow against a running server (SMOKE_PASSWORD=...)
```

## Roles (default)

เจ้าของ (Owner), ผู้จัดการสาขา (Manager), แคชเชียร์ (Cashier), พนักงานเสิร์ฟ (Waiter), ครัว/บาร์ (Kitchen),
สโตร์ (Store keeper). Permissions are granular (`order.void`, `bill.discount`, `report.view_profit`, …) and
assigned per branch; custom roles can be created in **ระบบ → บทบาท**. Sensitive actions accept a manager PIN.

## Known limitations

See the "requires external configuration" list in [docs/operations.md](docs/operations.md#features-that-need-external-credentials-or-hardware).
