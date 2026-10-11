# 13 — Reports: metric definitions

| Metric | Definition |
|---|---|
| Sale | Order with status PAID or CLOSED, dated by its **business date** (branch-local day). Open bills, voided bills and cancelled lines are excluded. |
| Gross / Net / Total | Gross = active lines before discounts; Net = Gross − all discounts; Total = what the customer paid (Net + service + exclusive VAT). |
| Refunds | Reported separately on the day they were made; never netted into the original day's sales (history stays stable). |
| Payment methods | Confirmed payments of the sales minus their refunds. Split/mixed payments count once per method, so methods sum to Total − refunds. |
| Hourly | By payment time in each branch's timezone. |
| Item revenue | Line totals after item-level discounts, before bill-level discounts/service/VAT. |
| Item cost / food cost | Actual recipe cost posted to the stock ledger when items were sent (SALE − SALE_REVERSAL). Items without recipes show "no recipe" instead of zero, and food-cost % is understated until all items have recipes. |
| Menu engineering | Kasavana & Smith: popular if share ≥ 70% of average share; profitable if unit margin ≥ average unit margin (costed items only). |
| Table turnover | Paid dine-in bills ÷ active tables ÷ days in range. |
| Labor cost % | Unavailable until attendance + wage data exist (Prompt 15 provides it via `laborCostProvider`). |
| Tax summary | Output VAT and taxable base per day with receipt number ranges and full tax invoices. Supporting data only — **not** a filed ภ.พ.30 and not a legal/tax compliance claim. |

Exports: CSV (UTF-8 with BOM for Excel, formula-injection neutralised). PDF: browser print view.
Permissions: sales/items/tax → `report.view_sales`; costs & item margins → `report.view_profit`; staff controls → `report.view_staff`; CSV → `report.export`. Multi-branch ranges only include branches where the user holds the permission.
