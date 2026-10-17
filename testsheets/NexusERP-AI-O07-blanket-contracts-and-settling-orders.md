# NexusERP-AI O07 - Blanket contracts and settling orders

- **Scenario id / name:** O07 / Blanket contracts and settling orders
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Contract id 'CTR-OM-1<S>' customer 'OM Cust A<S>' target items 100
  - Blanket order: 'Blanket item' qty 10 price 10
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-7, 13-15. Step 8 (DELETE /contracts) observed HTTP 404: no such route. Steps 9-12 UI-only or not executed.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | POST /api/v1/contracts {id:'CTR-OM-1<S>',customerName,description:'Frame',targetItems:100,receivedDate:today}. | HTTP 201; contract returned with the given id. | 1 |
| 2 | GET /api/v1/contracts. | Contract listed. | 1 |
| 3 | POST /api/v1/orders with blanketOrder true and contractId 'CTR-OM-1<S>'. | HTTP 201; blanketOrder true; status LOGGED. | 1 |
| 4 | POST an order with blanketContractId 'CTR-NONE' (unknown contract). | HTTP 400 'Blanket contract "CTR-NONE" not found.' | 1 |
| 5 | POST an order with blanketContractId = id of the blanket order created in step 3. | HTTP 201; blanketContractId stored on the settling order. (Using the contract id instead returns HTTP 400 'Blanket contract "<id>" not found.': the field expects the blanket ORDER id.) | 1 |
| 6 | GET /api/v1/contracts/<contract id>. | HTTP 200; contract record unchanged by the settling order (fields id, customerName, description, targetItems, receivedDate). | 1 |
| 7 | PUT /api/v1/contracts/<id> {description:'Frame v2'}. | HTTP 200; description updated. | 1 |
| 8 | DELETE /api/v1/contracts/<id>. | Observed HTTP 404 (route not registered); the UI delete of a contract linked to a blanket order is described in code as blocked. | 1 |
| 9 | In the UI open tab 'Blanket' -> sub tab 'New contract', submit with empty id. | Form validation prevents submit (UI only). | 1 |
| 10 | In the UI open 'Logged blanket' sub tab and search the contract id. | Only matching blanket orders are listed (UI only). | 1 |
| 11 | dispatch-action settle-blanket-order with the key (admin/management action). | Record the response (not executed live). | 1 |
| 12 | dispatch-action revive-contract. | Record the response (not executed live). | 1 |
| 13 | Create a stock order via API: customerReferenceNumber 'STOCK-1<S>', price 0. | HTTP 201 LOGGED. | 1 |
| 14 | Try the same stock order with price -1 (customer 'Internal Stock'). | HTTP 400 'Item 1 unit price cannot be negative'. | 1 |
| 15 | Try a non-stock order with price 0 (customer 'STOCK', ref not starting with STOCK-). | HTTP 400 'Item 1 unit price must be a positive number' (the name 'STOCK' alone does not make a stock order). | 1 |

## Findings (observed behaviour, not fixed)

1. DELETE /api/v1/contracts/:id does not exist (HTTP 404), so contracts cannot be deleted through the API.
