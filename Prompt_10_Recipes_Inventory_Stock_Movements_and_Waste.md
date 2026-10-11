# 10 — Recipes, inventory and stock control

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
Implement recipe and inventory foundations according to the supplied specification.

Features:
- Ingredient records with purchase, storage, and usage units plus explicit unit conversions
- Recipes/BOM linking a menu item to ingredient quantities; support sub-recipes only if practical within the current architecture
- Stock ledger with movement types such as PURCHASE, SALE, TRANSFER_IN, TRANSFER_OUT, WASTE, and ADJUST
- Receive, issue, transfer, stock count, stock adjustment, and waste recording with reasons and audit history
- Reorder points and low-stock alerts
- Lot and expiry-date fields with FIFO/FEFO support if required by the chosen workflow
- Theoretical versus counted stock variance report
- Costing using the selected method documented by the project (e.g. weighted average or FIFO); do not silently mix methods
- Deduct ingredients from sales using recipe quantities at the explicitly selected business event (e.g. order sent or bill paid), and ensure retries cannot deduct twice

Treat stock movements as the source-of-truth ledger. If a cached on-hand quantity is used for performance, reconcile it against the ledger. Validate unit conversions and prevent invalid negative stock unless a documented permission/rule permits it. Include tests for conversion, recipe consumption, waste, stock counts, and idempotent deductions.
