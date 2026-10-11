# 01 — Project audit and implementation plan

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
Act as a senior software architect joining an existing restaurant-management application project.

First inspect the repository without making destructive changes. Identify the framework, package manager, app entry points, routing, UI/component system, authentication approach, database/backend, migrations, tests, deployment setup, and current implemented features. Read the supplied restaurant specification carefully.

Create a concise implementation inventory mapping the specification to:
1. Already implemented and working
2. Partially implemented
3. Missing
4. Blocked by external credentials, hardware, or third-party access

Propose a phased implementation plan aligned with the source document:
- MVP: users/permissions, menu, tables, POS, basic payments, receipts/kitchen tickets, shifts, daily sales
- Operations: KDS, QR ordering/waiter flow, bill splitting/merging, offline support
- Cost control: recipes, inventory, stock counts/waste, purchasing, food-cost reports
- Growth: CRM/loyalty, promotions, delivery, reservations/queue, HR
- Scale: branches/central kitchen, accounting integrations, owner dashboard, multi-tenant SaaS if required

Do not code features in this step. Do not assume every module must be included in the first release. Identify the smallest viable MVP, major dependencies, risky assumptions, and a recommended sequence. Produce or update a project plan document in the repository if an appropriate docs location exists. Keep all existing code untouched.
