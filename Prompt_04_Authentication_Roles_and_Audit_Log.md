# 04 — Authentication, permissions and audit log

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
Implement or improve authentication and authorization using the existing project's established approach.

Required roles from the restaurant specification:
- Owner: access to all permitted branches and reports
- Branch Manager: branch-level operations, menu/stock/staff management, approvals
- Cashier: bills, payments, shifts, cash drawer
- Waiter: tables, orders, table moves/merges, bill requests
- Kitchen/Bar: assigned kitchen-station orders, item status changes, sold-out reporting
- Store Keeper: receiving, issuing, stock counts
- Customer: public QR ordering, order status, payment and loyalty functions when those modules exist

Use role-based access control with granular permissions such as order.void, bill.discount, report.view_profit, shift.close, payment.refund, and stock.adjust. Scope access by organization and branch. Enforce permissions in API/server handlers and UI. Sensitive actions (void, discounts beyond allowed limits, refunds, cash drawer opening, stock adjustments) should require appropriate permission and, if supported by the existing product design, manager PIN/approval.

Record important actions in audit_logs with actor, action, target, branch/organization, timestamp, and reason where relevant. Protect authentication flows against common abuse, validate sessions securely, and avoid logging secrets. Do not invent a new authentication provider if one already exists. Include authorization tests for both allowed and denied cases.
