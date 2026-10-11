# 10 — Recipes & Inventory: decisions

| Topic | Decision |
|---|---|
| Source of truth | `stock_movements` is an append-only ledger. `stock_balances` is a cache (qty + weighted-average cost) updated in the same transaction; `POST /api/inventory/reconcile` rebuilds it and reports drift. |
| Units | Every ingredient has one **base unit** (g, ml, pcs). Other units are explicit per-ingredient conversions (`1 kg = 1000 g`, `1 แผง = 30 pcs`). Unknown units are rejected. The base unit cannot change once movements exist. |
| Costing | **Weighted average only** (assumption A6). Receipts update the average; all outbound movements are valued at the current average. Lots exist for **expiry (FEFO) tracking only** — they never drive cost, so methods are not mixed. |
| Deduction event | Ingredients are deducted **when an order item is sent to the kitchen** (`SALE`), and returned (`SALE_REVERSAL`) if a sent item is cancelled or the bill voided. Food that was actually cooked and thrown away should be recorded separately as waste. |
| Idempotency | Sale movements use keys `SALE:<orderItemId>:<ingredientId>` (unique partial index). Re-sending or retrying cannot deduct twice. Count postings use `COUNT:<countId>:<ingredientId>`. |
| Negative stock | Sales may drive stock negative (the kitchen must not be blocked) and raise a `stock.low` event; manual issue/waste/transfer cannot go below zero (`INSUFFICIENT_STOCK`). Adjustments/counts need `stock.adjust` or manager PIN. |
| Recipes | One recipe per menu item, per modifier (e.g. "extra egg" deducts one egg) and per sub-recipe ingredient. Combos without their own recipe deduct their components' recipes. |
| Sub-recipes | Produced via `POST /api/inventory/produce`: consumes the BOM (`PRODUCTION_OUT`) and adds output (`PRODUCTION_IN`) at the consumed cost ÷ yield. Sales of dishes that use a sub-recipe deduct the sub-recipe ingredient itself. |
| Variance | Stock counts snapshot the theoretical (system) quantity at posting and write `COUNT` movements for the difference; the count sheet shows quantity and value variance. |
| Cost visibility | Average cost/stock value is returned only to users with `report.view_profit` or `inventory.manage`. |
| Warehouses | Each branch gets a default warehouse automatically; extra warehouses (e.g. bar store) can be added. Cross-branch transfers and central kitchen come in Prompt 15. |
