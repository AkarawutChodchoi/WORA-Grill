# 06 — Table management and floor plan

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
Implement restaurant table management based on the supplied specification.

Features:
- Manage zones/sections and tables, including table name/number, capacity, zone, and active/archive status
- A responsive floor-plan or table-list view appropriate to the current UI; drag-and-drop is optional and must not compromise accessibility
- Real-time or refresh-based table status: available, occupied, waiting for food, dining, bill requested, cleaning
- Open a table with guest count and associate the active order
- Support moving, merging, and splitting table assignments only where order integrity can be preserved
- Show elapsed seating time and waiter/zone assignment when available
- Prevent two active dine-in orders from accidentally claiming the same table unless the existing business rules explicitly allow it
- Enforce branch scope and waiter/manager permissions

Define safe state transitions and handle concurrent updates. Do not create fake realtime behavior; use the project's existing realtime infrastructure if present, otherwise provide a reliable refresh/polling approach and document the limitation. Add tests for table status, concurrency-sensitive actions, and permission checks.
