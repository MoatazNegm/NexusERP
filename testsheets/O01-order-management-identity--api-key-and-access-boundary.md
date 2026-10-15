# O01 - Order-management identity, API key and access boundary

- **Scenario id / name:** O01 / Order-management identity, API key and access boundary
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Header for all calls: x-api-key: <KEY>
  - Base URL http://localhost:5005/api/v1
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-11. Steps 12-15 UI/credential flows derived from code (login endpoint verified for other users in S01).

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | GET /api/v1/orders with the key. | HTTP 200 and a JSON array of orders (live data, because the key has allowLive=true). | 1 |
| 2 | GET /api/v1/orders with `Authorization: Bearer <KEY>` instead of x-api-key. | HTTP 200, same array. | 1 |
| 3 | GET /api/v1/orders with header x-api-key: nex_invalidkey. | HTTP 401 {"error":"Invalid API key."}. | 1 |
| 4 | GET /api/v1/customers with the key. | HTTP 200, array of customers (used to pick the customer of an order). | 1 |
| 5 | GET /api/v1/contracts with the key. | HTTP 200, array (blanket contracts). | 1 |
| 6 | GET /api/v1/settings with the key. | HTTP 200, array with the system_settings record (needed by the UI for SLA/tax defaults). | 1 |
| 7 | GET /api/v1/modules with the key. | HTTP 200 (module flags used to show/hide menus). | 1 |
| 8 | GET /api/v1/api-keys with the key. | HTTP 403 {"error":"Admin privileges are required to manage API keys."}. | 1 |
| 9 | GET /api/v1/admin/sandboxes with the key. | HTTP 401 {"error":"Unauthorized"} (no admin identity). | 1 |
| 10 | POST /api/v1/users with the key, body {username,name,roles:[admin],password}. | HTTP 403 {"error":"Admin privileges are required to create users."}; no user created. | 1 |
| 11 | POST /api/v1/orders/<unknown id>/dispatch-action with the key. | HTTP 404 {"error":"Order not found"}. | 1 |
| 12 | Log in on the UI as ai_tester with the account password (POST /api/v1/login, environment live). | Login succeeds; response lists roles [order_management] and no password. | 1 |
| 13 | On the UI look at the left menu after login as ai_tester. | Only 'Order Management' and 'Help Center' are shown (UI only). | 1 |
| 14 | Open the Order Management page. | Tabs 'New', 'Logged', 'Blanket', 'Stock' are available (UI only; ManagementTab in OrderManagement.tsx). | 1 |
| 15 | Check the footer version. | Footer shows v1.002_ai (UI only). | 1 |

## Findings (observed behaviour, not fixed)

1. GET /api/v1/orders with NO credential at all (no key, no x-user) returns HTTP 200 with the full live order list; POST /api/v1/orders without credential also created an order (HTTP 201). Authentication is not enforced on the collection routes.
2. The role of the key is not enforced for data routes: the key of an order_management user can read inventory, suppliers, userGroups and users (passwords omitted) and perform finance dispatch actions (see O09).
