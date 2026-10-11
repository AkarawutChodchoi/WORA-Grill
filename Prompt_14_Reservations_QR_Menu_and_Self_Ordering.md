# 14 — Reservations, waitlist, QR menu and self-ordering

PROJECT CONTEXT
Build a restaurant management application by extending the existing codebase. The primary requirements source is the supplied file “สเปกระบบจัดการร้านอาหารแบบละเอียด.md”.

GLOBAL RULES FOR EVERY STEP
- Work inside the existing project and preserve its current structure, framework, coding conventions, and working features.
- Do not recreate the app from scratch, replace the stack, or remove existing functionality unless explicitly necessary and approved.
- Before editing, inspect the relevant files, package scripts, environment configuration, routes, database schema, and existing UI patterns.
- Treat the provided file “สเปกระบบจัดการร้านอาหารแบบละเอียด.md” as the primary product specification. If a requirement is not specified, make the smallest sensible assumption and document it; do not silently invent complex business rules.
- Implement only the scope of this prompt and the dependencies strictly required for it. Do not attempt future phases early.
- Reuse existing components and utilities. Keep code modular, typed where the project supports typing, and consistent with the codebase.
- Never hardcode secrets, API keys, credentials, or production customer data. Use environment variables and safe examples.
- Validate permissions on the server/API as well as in the UI. Hiding a button is not authorization.
- For money, use decimal-safe arithmetic or integer minor units; never use binary floating-point for financial calculations.
- Preserve historical transaction values with snapshots where relevant. Record important actions in an audit trail.
- Include loading, empty, error, success, and validation states. Make layouts responsive and accessible.
- Add or update tests for changed behavior. Run the available lint, type-check, test, and build commands when possible.
- Do not claim a test passed unless you actually ran it. If blocked, report the exact blocker.
- At the end, summarize changed files, database migrations, environment variables, tests run/results, known limitations, and the recommended next prompt.

TASK FOR THIS STEP
Implement customer-facing table reservations, queue/waitlist, and QR ordering in the order that fits the existing project. If these are too large for one change, complete the simplest cohesive portion first and clearly identify what remains.

Reservation/waitlist:
- Reservation date/time, party size, preferred zone, contact details, deposit status when configured, notes, and statuses including cancellation/no-show
- Walk-in queue with queue number, party size, wait estimate only if calculated from real data, and call-next workflow
- Prevent obvious booking conflicts while allowing configured seating duration and table capacity rules

QR menu/self-ordering:
- Public mobile-friendly menu with photos, prices, allergen notes, language support where configured, cart, modifiers, notes, order confirmation, and order status
- Use table-bound, expiring/rotatable tokens or another secure mechanism so a QR code cannot freely place orders against arbitrary tables
- Validate current item availability and prices on the server
- Send orders to the established order/KDS workflow and require staff approval if configured
- Customer call-waiter and request-bill actions should create visible operational events, not just UI animations
- Show payment options only when actual payment configuration is available

Protect public endpoints against spam and unauthorized access. Do not expose internal staff or customer data. Add tests for reservation conflicts, QR token scope/expiry, cart pricing, and duplicate submissions.
