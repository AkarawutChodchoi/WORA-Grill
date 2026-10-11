# 07 — POS, order creation and order items

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
Implement the core POS order workflow from the supplied restaurant specification.

Required sales channels: dine-in, takeaway, delivery, and any supported delivery-platform channels already configured. Build a fast order screen with category navigation, item search, item selection, modifiers, quantity editing, notes/allergy notes, and a visible running subtotal. Support adding more items to an open order.

Business rules:
- Validate menu availability, prices, modifiers, quantities, table/branch ownership, and permissions on the server.
- Save item name, unit price, selected modifiers, and other essential values as snapshots so later menu edits do not alter historical orders.
- Follow the documented order states: OPEN → BILL_REQUESTED → PAID → CLOSED, with VOIDED only under permitted conditions; item states include PENDING → SENT → PREPARING → READY → SERVED, with CANCELLED requiring a reason.
- Preserve a clear distinction between saving a draft order and sending items to the kitchen.
- Prevent duplicate submissions and duplicate order items caused by repeated clicks or network retries.
- Keep tax, service charge, discount, and payment calculations in a dedicated tested business-logic layer; follow existing configuration rather than hardcoding assumptions.
- Require a reason and proper authorization for void/cancel operations.

Do not implement actual payment gateway integration here. Integrate with table management and menu modules already present. Add tests for order totals, state transitions, duplicate requests, modifiers, and authorization.
