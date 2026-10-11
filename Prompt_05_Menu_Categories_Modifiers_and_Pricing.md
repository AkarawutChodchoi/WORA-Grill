# 05 — Menu, categories, modifiers and pricing

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
Build the menu-management module using the supplied restaurant specification and existing project patterns.

Features:
- Create, view, edit, archive, search, and reorder menu categories and menu items
- Item fields: localized names where supported, description, image, price, availability, tags/allergens, and kitchen station/category routing
- Modifier groups and modifiers with required/optional selection, minimum/maximum selection rules, and price adjustments
- Optional combo/set items and time-based availability if practical for the current phase
- Support branch-specific and sales-channel-specific prices when the data model supports them
- Mark an item sold out and propagate its availability to POS/QR ordering where those modules exist
- Validate prices and modifier selections on the server, not only in the browser
- Use safe image upload/storage conventions already present in the project

Do not implement inventory deductions in this step unless recipe/stock functionality already exists. Keep menu changes from rewriting historical orders: use item/price snapshots when orders are created. Include clear admin forms, validation messages, empty/loading/error states, and tests for pricing and modifier rules.
