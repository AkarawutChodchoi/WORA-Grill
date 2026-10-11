# 11 — Purchasing, suppliers and receiving

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
Implement supplier and purchasing workflows that build on the existing inventory model.

Features:
- Supplier directory with contact details, item-specific purchase units/prices, and payment terms when known
- Purchase request (PR) if needed, purchase order (PO), approval, receiving/goods receipt (GR), and supplier return
- Compare ordered versus received quantities and record damaged, missing, or rejected items
- Update stock ledger and inventory cost only when a valid receiving transaction is posted
- Track purchase status and outstanding supplier invoices/payments if accounting support exists
- Suggest replenishment when stock falls below reorder points, using recent consumption if sufficient data exists
- Keep every receipt and stock adjustment traceable to the PO/supplier and responsible user

Do not mark stock as received when an order is merely created. Use transactional database operations where needed to avoid partial receiving records. Add role checks and tests for partial receipts, duplicate posting, supplier returns, and stock-ledger consistency.
