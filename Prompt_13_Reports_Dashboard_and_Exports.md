# 13 — Reports, dashboard and exports

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
Implement reporting and owner/manager dashboards using real data from the application. Do not populate production-looking dashboards with fabricated metrics.

Reports from the supplied specification:
- Sales by day/week/month, channel, payment method, and hour
- Best/worst-selling menu items and menu profitability when recipe costs are available
- Average bill and spend per guest, table turnover when table data is available
- Food-cost percentage, inventory variance, waste, and labor-cost percentage when relevant data exists
- Voids, discounts, refunds by staff member, and cashier cash variance
- Tax summaries only to the extent supported by the configured tax and transaction data

Requirements:
- Date-range and branch filters with timezone-aware boundaries
- Consistent treatment of cancelled/voided/refunded transactions and discounts
- Aggregations must match source transactions and avoid double-counting split payments or order items
- Permission checks for sensitive reports such as profit and staff performance
- Clear empty states, definitions of metrics, and drill-down to underlying records where appropriate
- CSV/Excel/PDF export only using libraries and formats supported by the current project; prevent spreadsheet formula injection in CSV exports

Do not claim legal/tax compliance merely because a report exists. Document any report whose accuracy depends on missing cost, tax, or payment data. Add tests comparing report totals to known transaction fixtures.
