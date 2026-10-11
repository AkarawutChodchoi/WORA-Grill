# 16 — Integrations, offline mode, notifications and devices

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
Audit which external integrations and hardware capabilities are actually supported by the existing project, then implement only those that can be configured and tested.

Potential integrations from the source specification:
- PromptPay/payment gateway through a supported provider
- LINE Messaging API and push notifications
- Delivery platforms such as GrabFood, LINE MAN, ShopeeFood, or other providers only when official API access and credentials exist
- Receipt/kitchen printers using the project's compatible ESC/POS or print-service approach
- Cash drawer, customer display, EDC, and other peripherals where hardware access is available

Offline mode:
- Keep core POS actions usable during network interruption only if the current architecture can support it safely.
- Store local pending actions in IndexedDB/SQLite or the existing local persistence layer; assign stable IDs and queue changes for sync.
- Define conflict resolution, idempotency, retry behavior, and a visible sync status.
- Never silently report an offline payment as confirmed. Clearly distinguish locally recorded from server-confirmed transactions.
- Prevent duplicate orders/payments/stock deductions when sync retries.

Notifications and devices:
- Device registration and station/branch association
- Useful in-app notifications and optional email/push/LINE only when configured
- Safe handling of webhook signatures, secrets, retries, and audit events

Do not fake successful third-party connections. Use adapters/interfaces and documented environment variables. Add integration tests with mocks and state what requires real credentials or physical hardware.
