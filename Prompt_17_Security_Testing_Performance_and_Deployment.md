# 17 — Security, testing, performance and deployment readiness

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
Perform a production-readiness review of the implemented restaurant-management app without replacing its stack or deleting data.

Security and privacy:
- Review authentication, authorization, organization/branch isolation, input validation, rate limiting for public endpoints, CSRF/XSS/SQL injection protections as relevant to the stack, upload validation, and secret handling
- Minimize customer personal data and implement appropriate consent, retention, access, and deletion/export workflows where required by the project
- Ensure sensitive actions and important transaction changes are audited
- Verify payment/webhook handling and prevent duplicate financial actions
- Check that logs do not contain passwords, tokens, payment secrets, or unnecessary personal data

Reliability:
- Review database transactions, indexes, concurrency, idempotency, retry behavior, and backup/restore instructions
- Verify financial totals, tax/service-charge configuration, order state transitions, inventory ledger consistency, and report reconciliation
- Check responsive usability for cashier tablets, kitchen displays, and owner dashboards
- Review performance for menu search, POS order operations, KDS updates, and reports
- Ensure environment variables are documented with safe example values and no real secrets

Testing and delivery:
- Run available lint, type checks, unit tests, integration tests, and production build.
- Add missing high-value tests for permissions, cross-branch isolation, payments, refunds, stock deductions, and report reconciliation.
- Provide a deployment checklist, migration procedure, rollback plan, backup/restore steps, monitoring recommendations, and a list of features requiring external credentials or hardware.
- Fix issues found within reasonable scope; clearly report anything not fixed. Never claim legal, tax, security, or production readiness beyond evidence from completed checks.
