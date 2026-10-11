# Operations: deployment, migrations, backups, monitoring

> This guide documents what was built and verified locally. It is **not** a certification of production
> readiness: no load test, penetration test, legal/tax review or real-hardware validation has been done.

## Deployment topologies

| Shop size | Recommended |
|---|---|
| Single branch, 1 server PC/mini-PC in the shop | `npm start` with the embedded PGlite DB, LAN access over HTTP, nightly `npm run db:backup` copied off-site |
| Several branches / cloud | PostgreSQL 15+ (`DATABASE_URL`), one API instance behind HTTPS reverse proxy (Caddy/nginx), `COOKIE_SECURE=true`, `TRUST_PROXY=true` |

The API keeps realtime events and rate-limit counters **in memory**: run a **single API instance**. Scaling
out needs Redis pub/sub for `EventBus` and a shared rate limiter (interfaces are isolated in
`server/src/lib/events.ts` and `server/src/lib/rate-limit.ts`).

## Deployment checklist

1. Node 22+ installed; `npm ci && npm run check` passes on the build machine.
2. `.env` created from `.env.example`; `NODE_ENV=production`; no demo `SEED_*` values.
3. HTTPS terminated by a reverse proxy for anything reachable outside the shop LAN; then
   `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `PUBLIC_BASE_URL=https://…`.
4. Database: PostgreSQL user with rights only on its database; `DATABASE_URL` set; or PGlite dir on a
   disk that is backed up.
5. **Back up first**, then `npm run db:migrate`, then start the new version (`npm start` or a service manager
   such as systemd / NSSM / pm2 with automatic restart).
6. Open the site → first-run setup (or log in), set **ตั้งค่าร้าน** (tax id, VAT mode, service charge,
   PromptPay id, enabled payment methods, receipt header/footer).
7. Create staff, roles and PINs; register POS/KDS tablets and LAN printers (**ระบบ → อุปกรณ์**), test-print.
8. Run `node scripts/smoke.mjs <url>` against a staging copy (it creates a real bill — not on the live DB).
9. Configure uptime monitoring on `GET /api/health` (returns 503 when the DB is unreachable).
10. Schedule backups and **test a restore**.

## Migration procedure & rollback

- Migrations are forward-only SQL files in `server/drizzle/`, applied in order and recorded in
  `drizzle.__drizzle_migrations`. Never edit a migration that has been applied anywhere.
- Upgrade: stop the server → backup → `npm run db:migrate` → start → smoke check.
- **Rollback**: stop the server, restore the pre-upgrade backup, start the previous release. (Down-migrations
  are deliberately not generated; changes are additive so the previous release can usually keep running
  on the new schema, but restoring the backup is the safe path.)

## Backup & restore

**PGlite (embedded):**
```bash
npm run db:backup                       # data/backups/rms-<timestamp>.tar.gz (consistent snapshot)
# restore (server stopped, PGLITE_DIR must be empty or new):
PGLITE_DIR=./data/pglite-restored npm run db:restore -- data/backups/rms-....tar.gz
```
Verified locally: seed → backup → restore into an empty directory → data present.

**PostgreSQL:**
```bash
pg_dump --format=custom --file=rms-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" rms-YYYY-MM-DD.dump
```
Also back up `UPLOAD_DIR` (menu images). Keep at least 7 daily + 4 weekly copies off the server.
Customer PII lives in the database backups: encrypt them at rest and restrict access (PDPA).

## Monitoring & logs

- `GET /api/health` → `{ ok, db }` (200/503).
- Structured JSON logs (pino) on stdout; cookies/authorization headers are redacted; request bodies are not
  logged. Ship stdout to your log system; alert on `level >= 50` (errors).
- Business signals to watch: in-app notifications for printer failures and low stock; Audit Log for voids,
  refunds, discounts, drawer opens; the cash-variance column in reports.

## Security notes (implemented)

- Sessions: random 256-bit tokens, only SHA-256 stored, `HttpOnly; SameSite=Strict` (+`Secure` over HTTPS),
  absolute expiry, revoked on logout/password change/deactivation; WebSocket re-validates sessions.
- CSRF: SameSite=Strict + mandatory `X-Requested-With` header on every non-GET API call (webhooks excepted,
  they use HMAC signatures).
- Passwords/PINs: scrypt; login, PIN sign-in **and manager-approval PINs** lock for 15 min after 5 failures
  (failed approvals are audited); per-IP rate limits on auth, public QR, booking and queue endpoints.
  `TRUST_PROXY` is a hop count — never trust every X-Forwarded-For hop.
- Revoking a terminal immediately ends the PIN sessions opened on it.
- Money safety: void/merge/split/discount/promotions are refused while any payment is confirmed **or pending**;
  gateway charges reserve the amount under a row lock; payment ids, goods-receipt ids, return ids and
  manual stock receipts are idempotent; supplier returns are capped by received minus already returned.
- Webhooks: a failed event is re-processed when the provider retries (only PROCESSED/IGNORED are treated
  as duplicates); money that arrives on a closed bill is recorded and raises a refund notification.
- Loyalty: refunds claw back earned points proportionally (balance may go negative).
- Authorisation on every route (permissions + organisation/branch scoping); privilege-escalation guard on
  role grants; manager-PIN approvals for void/cancel/discount override/refund/drawer/stock adjust.
- Input validation with zod; integer money; uploads checked by magic bytes and size; CSV formula-injection
  neutralised; CSP, `nosniff`, `frame-ancestors 'none'`.
- PDPA: consent timestamps, masked phone numbers in lists, export & anonymise tools (owner permission).
  Retention period setting exists in org settings but **automatic deletion is not scheduled** — run the
  anonymise action per request or add a scheduled job.

## Features that need external credentials or hardware

| Feature | What is needed |
|---|---|
| PromptPay auto-confirmation | Opn Payments merchant account (`OPN_SECRET_KEY`, `OPN_WEBHOOK_SECRET`); sandbox verification of webhook format |
| Other gateways (2C2P, GB Prime Pay) | New adapter implementing `PaymentGateway` |
| GrabFood / LINE MAN / ShopeeFood | Partner API access + middleware posting to `/api/webhooks/delivery/:provider`; menu/86 sync and GP reports not built |
| LINE alerts | LINE OA channel token + target id |
| Customer marketing (LINE/SMS/email) | Provider + consent-based sending flow (not built; audience counts only) |
| Receipt/kitchen printers, cash drawer | Physical ESC/POS LAN printers; confirm the TIS-620 code page number per model |
| EDC card terminals, customer display, Bluetooth printers, kiosk hardware | Vendor SDKs — not integrated (EDC payments recorded manually with approval code) |
| e-Tax Invoice / accounting export (FlowAccount, PEAK, Express) | Provider credentials and certification — not built |
| Payroll, OT, social security, withholding tax, tips | Business rules and compliance review — intentionally out of scope |
| Email reports | SMTP provider — not built (CSV/PDF export instead) |

## Independent review (Prompt 17)

An independent read-only security review of the server found 13 issues (2 high, 5 medium, 6 low); all were
fixed and each has a regression test in `server/test/review-fixes.test.ts`. No cross-tenant IDOR, SQL
injection, XSS or upload issues were found. Latent multi-organisation gaps (delivery branch lookup by code,
customer ids on reservations/coupons) were also closed although the product currently runs one
organisation per deployment.

## Known gaps / follow-ups

- Single-instance realtime and rate limiting (see above).
- UI was verified by type checks, component tests, a production build and API-level end-to-end smoke tests;
  it was **not** visually reviewed in a real browser on tablets/KDS screens in this environment — do a
  hands-on UX pass on target devices.
- No load/performance test was run; queries are indexed for branch/date access, and report queries scan
  per date range (fine for single restaurants; consider materialised daily summaries for large chains).
- Dev-only `npm audit` findings (drizzle-kit's bundled esbuild dev server) do not affect production builds.
