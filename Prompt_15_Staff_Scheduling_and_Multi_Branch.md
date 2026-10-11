# 15 — Staff management and multi-branch foundations

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
Implement staff administration and multi-branch support incrementally, based on the existing data model and project scope.

Staff features:
- Employee profile, role, branch assignment, active/inactive status, and wage basis (hourly/daily/monthly) if needed
- Shift scheduling and attendance records
- PIN-based quick switching only if the current authentication model supports it securely
- Overtime, lateness, leave, payroll, social security, and withholding-tax calculations must remain out of scope unless the business rules and local compliance requirements have been separately specified and reviewed
- Tips/service-charge distribution and staff sales metrics only when the underlying records and policy are defined

Multi-branch features:
- Organization and branch context, branch-scoped users and records, branch selector for authorized users, central menu with branch overrides, and branch-filtered reports
- Prevent any user from accessing another organization or unauthorized branch by changing IDs or API parameters
- Add branch stock transfers and central kitchen workflows only after inventory transactions are stable
- Keep organization-level settings separate from branch-level settings

Migrate existing single-branch data safely if needed; do not break existing records or assume all current users should gain access to all branches. Add tests for branch isolation, role assignments, scheduling, and access denial.
