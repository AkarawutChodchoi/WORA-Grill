# 08 — Payments, shifts, cash drawer and receipts

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
Implement the basic payment and cashier-shift workflow for the restaurant POS.

Payment methods should be modeled so the system can support cash, PromptPay, card/EDC, e-wallet, vouchers/coupons, loyalty redemption, and mixed payment, but only activate methods that are configured and genuinely supported. Do not pretend a payment is confirmed based solely on a customer-facing screenshot or client request.

Features:
- Record one or multiple payment entries against an order and prevent overpayment unless a documented business rule allows it
- Cash tendered and change due, with safe monetary arithmetic
- Configurable discount, service-charge, and VAT calculations based on store settings; support inclusive/exclusive tax only when the current requirements and configuration define the behavior
- Refund workflow with permission checks, reason, audit log, and reference to the original payment
- Cashier shift open with starting float; pay-in/pay-out entries with reasons; shift close with expected cash, counted cash, and variance
- X-Report during a shift and Z-Report at close, using actual recorded transactions
- Receipt and kitchen-ticket print views or printer integration compatible with the existing project; if hardware is not configured, provide a printable layout and document the limitation

Do not store raw card details or secrets. Treat payment callbacks/webhooks idempotently and verify signatures if a gateway is integrated. Add tests for split/mixed payments, change, refunds, shift variance, and totals.
