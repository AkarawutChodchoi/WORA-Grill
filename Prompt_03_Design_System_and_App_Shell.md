# 03 — Design system and application shell

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
Implement the foundational application shell for the restaurant-management app, following the current framework and design conventions. Do not replace an existing working design system.

Create or refine:
- Responsive app layout with navigation appropriate to the user's role
- Clear page titles, breadcrumbs where useful, global notifications, profile/session menu, and branch selector only if multi-branch support exists
- Reusable buttons, form fields, dialogs, tables, status badges, loading skeletons, empty states, error states, and confirmation patterns
- Consistent spacing, typography, accessible contrast, keyboard navigation, and mobile/tablet behavior
- A minimal, professional restaurant operations visual style; prioritize fast use during busy service rather than decorative complexity

Use realistic but clearly marked demo data only where needed. Connect navigation only to routes that exist; label future modules as unavailable or omit them rather than making fake working screens. Ensure the shell does not expose restricted modules to unauthorized roles, while still enforcing authorization on the server. Add tests for the shell/navigation where the project supports them.
