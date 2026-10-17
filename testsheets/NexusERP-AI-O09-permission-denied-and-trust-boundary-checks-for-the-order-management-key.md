# NexusERP-AI O09 - Permission denied and trust-boundary checks for the order-management key

- **Scenario id / name:** O09 / Permission denied and trust-boundary checks for the order-management key
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Order Z created in the sheet (LOGGED)
- **Live verification note:** Verified live 2026-10-15: steps 1-11. Steps 12-13 destructive/need admin; 14-15 UI only.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | dispatch-action hard-delete-order with the key. | HTTP 400 'Unauthorized: Only superusers or management can hard delete an order' (expected: the role must NOT hard delete). | 1 |
| 2 | POST /api/v1/users with roles [admin] using the key. | HTTP 403 'Admin privileges are required to create users.' | 1 |
| 3 | GET /api/v1/api-keys using the key. | HTTP 403. | 1 |
| 4 | Add header x-sandbox-owner: admin to POST /api/v1/orders with the key. | HTTP 403 {error:'ACCESS_REVOKED'} (cannot write into another user's sandbox). | 1 |
| 5 | dispatch-action issue-invoice with the key on a LOGGED order. | Observed HTTP 200 (accepted). Expected by role design: must be denied (finance role). | 1 |
| 6 | dispatch-action record-payment {amount:10} with the key. | Observed HTTP 200 (accepted). Expected: denied. | 1 |
| 7 | dispatch-action toggle-acceptance (planning action) with the key. | Observed HTTP 200 (accepted). Expected: denied (planning role). | 1 |
| 8 | GET /api/v1/inventory, /suppliers, /userGroups with the key. | Observed HTTP 200 for all (role does not restrict reads). | 1 |
| 9 | GET /api/v1/orders with no credential. | Observed HTTP 200 with data (expected: 401). | 1 |
| 10 | POST /api/v1/orders with no credential. | Observed HTTP 201 order created (expected: 401). | 1 |
| 11 | Send x-user: ai_tester only (no key). | Observed HTTP 200: identity is a trusted header. | 1 |
| 12 | Revoke the key (admin DELETE /api/v1/api-keys/<id>) and repeat step 1 of O01. | HTTP 401 Invalid API key (verify last; re-create the key afterwards). | 1 |
| 13 | Change ai_tester roles to [] and repeat an order create with the key. | Record behaviour (key roles come from the user record). | 1 |
| 14 | Log in on the UI as ai_tester and open /#settings by changing the view. | Redirect to Order Management; Settings not accessible (UI only). | 1 |
| 15 | Try to open the Finance view via URL manipulation as ai_tester. | Redirect to Order Management (UI only). | 1 |

## Findings (observed behaviour, not fixed)

1. Finance and planning dispatch actions (issue-invoice, record-payment, toggle-acceptance) are executed for an order_management key: role separation is only enforced in the UI menu.
2. Unauthenticated reads and writes succeed on the collection routes (orders, customers).
3. hard-delete-order authorisation also grants rights to any user whose NAME contains 'admin' or 'manager'.
