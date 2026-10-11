# 02 — Architecture and data model

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
Using the audited existing project and the supplied restaurant specification, define the architecture and data model for the next implementation phases. Preserve the current stack unless a concrete blocker justifies a change; explain any proposed change before applying it.

Map the core entities and relationships, adapting names and conventions to the existing database:
organizations, branches, users, roles, permissions, menu_categories, menu_items, modifier_groups, modifiers, ingredients, units/unit_conversions, recipes/recipe_lines, zones, tables, orders, order_items, payments, discounts, shifts, cash_movements, stock_movements, suppliers, purchase_orders/po_lines, customers, loyalty_transactions, promotions/coupons, reservations, waitlist, devices, and audit_logs.

Requirements:
- Define primary keys, foreign keys, indexes, unique constraints, enums/status transitions, timestamps, and deletion/archive behavior.
- Scope records by organization and branch wherever relevant; prevent cross-tenant and cross-branch data leaks.
- Use UUID/ULID if consistent with the project and useful for client-generated/offline IDs.
- Store monetary values safely and snapshot item names/prices/tax-relevant values on order items and finalized bills.
- Treat stock movements as an auditable ledger; do not make a mutable stock total the only source of truth.
- Define order and order-item state machines based on the source document.
- Include migration and rollback strategy appropriate to the current stack.

Implement only foundational schema/types/API contracts that are required now. Do not build every module in this step. Add schema documentation or an entity relationship diagram in a suitable text format if supported by the repository. Run migrations/tests safely and never reset or delete real data.
