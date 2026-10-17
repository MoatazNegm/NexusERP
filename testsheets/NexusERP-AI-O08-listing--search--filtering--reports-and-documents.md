# NexusERP-AI O08 - Listing, search, filtering, reports and documents

- **Scenario id / name:** O08 / Listing, search, filtering, reports and documents
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - At least 10 orders exist (run O03/O04 first)
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-8. UI steps derived from code.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | GET /api/v1/orders. | HTTP 200; array; each order has id, customerName, customerReferenceNumber, internalOrderNumber, status, items, logs. | 1 |
| 2 | GET /api/v1/orders?status=LOGGED. | Observed: query parameter ignored; all orders returned (server has no filter). | 1 |
| 3 | GET /api/v1/orders?limit=2&page=1. | Observed: paging parameters ignored; all orders returned. | 1 |
| 4 | GET /api/v1/orders?customerName=<name>. | Observed: parameter ignored; all orders returned. | 1 |
| 5 | GET /api/v1/orders/<id>. | One order incl. computed health fields. | 1 |
| 6 | GET /api/v1/reports/orders. | HTTP 200; JSON with count,totalRevenue,totalRealCost,grossProfit,profitMarginPct,orders[]. | 1 |
| 7 | GET /api/v1/procurement/unique-po-number. | HTTP 200 {poNumber:'PO-2026-1001'}. | 1 |
| 8 | GET /api/v1/user-guide?format=markdown. | HTTP 200 Markdown text. | 1 |
| 9 | In the UI tab 'Logged', type a PO reference in the search box. | Only matching orders listed (UI only). | 1 |
| 10 | In the UI tab 'Logged', choose the type filter (trade, manufacturing, blanket, stock, standard). | List filters by order type (UI only, loggedFilterType). | 1 |
| 11 | In the UI click a column header in the Logged table. | Rows sort ascending, second click descending (SortableTable; UI only). | 1 |
| 12 | In the UI open an order's details (OrderDetailsModal). | Details, items, logs and delivery data are visible (UI only). | 1 |
| 13 | In the UI export the order as PDF (OrderReport / jsPDF). | A PDF of the order downloads (UI only). | 1 |
| 14 | POST /api/upload-pod with a small PDF as podFile. | Observed in S03 flow: file stored under /uploads/pod and path returned (document upload belongs to shipment/finance). | 1 |
| 15 | GET /api/v1/orders and compare count with the UI Logged list. | UI count equals the number of orders in LOGGED/TECHNICAL_REVIEW etc. for the tab filters (UI only). | 1 |

## Findings (observed behaviour, not fixed)

1. GET /api/v1/orders has no server-side filter, search or paging: every call returns the complete order list including logs (size grows with data).
