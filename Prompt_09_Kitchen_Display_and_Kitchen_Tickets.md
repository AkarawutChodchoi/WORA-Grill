# 09 — Kitchen display system and kitchen tickets

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
Build the kitchen workflow (KDS) based on the supplied specification.

Features:
- Route order items to kitchen/bar stations based on menu category or explicit item configuration
- Display new orders in real time when the project has WebSocket infrastructure; otherwise use a reliable fallback and document it
- Show table/order number, elapsed time, item quantity, modifiers, notes, allergy warnings, and course/order context
- Item state actions: SENT, PREPARING, READY, SERVED; reject invalid transitions and log relevant actions
- Visual aging indicators for items that exceed configurable preparation targets
- Group identical items for an all-day count only if the interface can still preserve per-order completion tracking
- Allow authorized kitchen staff to mark an item sold out and propagate availability to the POS/QR menu
- Provide a printable kitchen-ticket fallback if a KDS screen or connection is unavailable

Optimize the screen for a kitchen display: large readable text, high contrast, touch-friendly controls, and minimal navigation. Do not claim realtime delivery if it is not implemented. Add tests for routing, item states, station permissions, and sold-out propagation.
