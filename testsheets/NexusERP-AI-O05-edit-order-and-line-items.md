# NexusERP-AI O05 - Edit order and line items

- **Scenario id / name:** O05 / Edit order and line items
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Order created from O03 step 1 (10 x 450). Names below use <ORDER_ID>, <ITEM_ID>.
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-12, 15 (user shown is the key owner). UI steps 13-14 derived from code.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | PUT /api/v1/orders/<ORDER_ID> {customerReferenceNumber:'OM-T-001-REV<S>'}. | HTTP 200; PO reference changed. | 1 |
| 2 | PUT with a PO reference used by another order of the same customer. | HTTP 400 duplicate PO reference message. | 1 |
| 3 | PUT /orders/<ID> {items:[ ... quantity 0 ...]}. | Observed HTTP 200 and quantity stored as 1 (coerced, not rejected). | 1 |
| 4 | POST /api/v1/orders/<ID>/items {description:'Added line',quantity:3,pricePerUnit:50,unit:'pcs'}. | HTTP 201; items length increases by 1; log 'Line item added: ...'. | 1 |
| 5 | POST /orders/<ID>/items without unit. | HTTP 400 'Item description and unit are required'. | 1 |
| 6 | PUT /orders/<ID>/items/<ITEM_ID> {quantity:12}. | HTTP 200; quantity 12; log 'Line item updated'. | 1 |
| 7 | PUT /orders/<ID>/items/<ITEM_ID> {quantity:-3}. | Observed HTTP 200 and quantity coerced to 1 (not rejected). | 1 |
| 8 | PUT /orders/<ID>/items/nope. | HTTP 404 'Order item not found'. | 1 |
| 9 | DELETE /orders/<ID>/items/nope. | HTTP 404 'Order item not found'. | 1 |
| 10 | DELETE /orders/<ID>/items/<ITEM_ID> for an existing item. | HTTP 200; item removed; log 'Line item removed: ...'. | 1 |
| 11 | DELETE /api/v1/orders/<ID>. | HTTP 404 (no such route); order deletion only exists as hard-delete-order for admin/management. | 1 |
| 12 | PUT /orders/<ID> {status:'FULFILLED'}. | Observed HTTP 200 and the order status becomes FULFILLED (see Findings). | 1 |
| 13 | In the UI open tab 'Logged', press Edit on an order, change quantity and Save. | Order list updates; edit blocked ('frozen') once the order is beyond technical review (UI only, editStatus.isFrozen). | 1 |
| 14 | In the UI edit an order that is in a status after TECHNICAL_REVIEW. | Edit controls are disabled and a lock message is shown (UI only). | 1 |
| 15 | GET the order after the edits. | Logs show every edit in chronological order with user 'ai_tester' (or System for key calls). | 1 |

## Findings (observed behaviour, not fixed)

1. PUT /api/v1/orders/:id accepts any field including status (a PUT with status FULFILLED moved an order to FULFILLED without any workflow).
2. Zero or negative quantity on edit is silently coerced to 1 instead of rejected (create rejects them).
3. Deleting the last item or all items is not blocked.
