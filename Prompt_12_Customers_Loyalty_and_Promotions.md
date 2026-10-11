# 12 — Customer CRM, loyalty and promotions

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
Implement customer relationship management, loyalty, and promotion foundations from the supplied specification.

Customer features:
- Customer profile with only necessary contact details, order history, preferences, and consent fields
- Loyalty point accrual/redemption with a transaction ledger, expiry rules only if configured, and protection against double crediting
- Membership tiers and birthday rewards only where the business rules are explicitly configured
- Coupons/vouchers and gift-card/stored-value support only if the current project scope includes the associated accounting controls
- Promotion rules for percentage/fixed discounts, buy-X-get-Y, minimum spend, time/day/branch/channel/member restrictions, usage limits, and stacking rules

Rules:
- Validate every promotion and redemption on the server.
- Snapshot applied discounts and rule identifiers on the order.
- Do not expose customer personal data unnecessarily; collect consent for marketing communications and follow applicable privacy requirements.
- Prevent repeated redemption or point manipulation with idempotency and transaction-safe logic.
- Keep campaign delivery integrations (LINE/SMS/email) disabled until credentials and consent flows are configured.

Add tests for eligibility, expiry/usage limits, stacking, loyalty accrual/redemption, and privacy/permission boundaries.
