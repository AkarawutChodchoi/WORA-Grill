# Restaurant Management App — Sequential AI Coding Prompts

## Purpose
These Markdown prompts turn the restaurant-management specification into a staged implementation workflow for an AI coding agent.

## How to use
1. Open your existing restaurant app project in your coding agent.
2. Provide `สเปกระบบจัดการร้านอาหารแบบละเอียด.md` as context if the agent cannot already read it.
3. Start with [`Prompt_01_Project_Audit_and_Implementation_Plan.md`](Prompt_01_Project_Audit_and_Implementation_Plan.md).
4. Run one prompt at a time, review the code changes, run the app/tests, and back up or commit before moving on.
5. Continue in numerical order. Resolve blockers before continuing.

## Important
- Prompts instruct the agent to inspect and preserve the existing codebase rather than recreating it.
- The framework and database are not assumed; the agent must inspect the project first.
- External payment, delivery, printer, LINE, and hardware integrations must not be presented as functional until configured and verified.
- Prompt 01 is planning only; Prompt 02 establishes foundations; later prompts add modules in dependency order.
- Prompt 17 is a readiness review, not a guarantee of production readiness.

## Prompt sequence
1. Project audit and implementation plan
2. Architecture and data model
3. Design system and application shell
4. Authentication, permissions and audit log
5. Menu, categories, modifiers and pricing
6. Table management and floor plan
7. POS, order creation and order items
8. Payments, shifts, cash drawer and receipts
9. Kitchen display system and kitchen tickets
10. Recipes, inventory and stock control
11. Purchasing, suppliers and receiving
12. Customer CRM, loyalty and promotions
13. Reports, dashboard and exports
14. Reservations, waitlist, QR menu and self-ordering
15. Staff management and multi-branch foundations
16. Integrations, offline mode, notifications and devices
17. Security, testing, performance and deployment readiness
