# NexusERP-AI S09 - Reporting, search and history

- **Scenario id / name:** S09 / Reporting, search and history
- **Role / user:** mgmt1, admin, proc1 (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Run S03 first so that at least one FULFILLED order exists.
- **Test data:**
  - Order from S03 (PO-S03-001), part description 'Heavy Duty Valve Assembly'
- **Live verification note:** Verified live 2026-10-15 (API): steps 3,6,14 (reports/orders and procurement history returned the S03 data). Others UI-only and not rendered here.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | As mgmt1 open Dashboard. | Dashboard cards load; status distribution includes the FULFILLED order. | 1 |
| 2 | Open Profitability report. | Report lists the order with revenue, real cost, gross profit and margin %. | 1 |
| 3 | Call GET /api/v1/reports/orders. | JSON with count, totalRevenue, totalRealCost, grossProfit, profitMarginPct and orders[]. | 1 |
| 4 | Export the executive snapshot PDF from the Dashboard (management role). | A PDF with status distribution, critical margin alerts and customer/supplier summaries downloads. | 1 |
| 5 | As proc1 open Part History and search 'Heavy Duty'. | History shows the S03 component with supplier, price 100, quantity 10 and PO number. | 1 |
| 6 | Call GET /api/v1/procurement/history?description=Valve. | Array containing orderNumber, supplierName, price 100, quantity 10 for the S03 order. | 1 |
| 7 | Open Procurement universal search with the PO number PO-S03-0001 and with keyword 'non-project'. | Order card appears for the PO; 'non-project' keeps it (no project name). | 1 |
| 8 | Open System Audit as admin. | System logs are listed (admin only); non-admin users do not see the item. | 1 |
| 9 | Open the order list in Order Management and sort by 'Last Edited'. | Latest edited order appears first; clicking again reverses order. | 1 |
| 10 | Switch the language to Arabic with the language toggle. | UI becomes RTL with Arabic labels; the choice survives a reload. | 1 |
| 11 | Switch back to English. | UI returns to LTR English. | 1 |
| 12 | Open Help Center. | Help links/videos configured in settings are shown as cards; empty state if none. | 1 |
| 13 | Check footer version versus constants.tsx APP_VERSION. | Footer value equals APP_VERSION (1.0001095 at the time of writing). | 1 |
| 14 | Call GET /api/v1/orders and count FULFILLED orders. | Count equals the number visible in Finance 'fulfilled' filter. | 1 |
| 15 | Open Gov.EInvoice module. | FULFILLED/attached e-invoice for the order is listed with its file link. | 1 |
