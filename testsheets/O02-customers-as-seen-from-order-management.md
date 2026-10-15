# O02 - Customers as seen from Order Management

- **Scenario id / name:** O02 / Customers as seen from Order Management
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Customer: 'OM Cust A<S>', e-mail a@om.test, tax number TX-1, address Cairo, min margin 10
  - Second customer name left empty for the boundary check
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-9, 12-15. Steps 10-11 UI only.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | POST /api/v1/customers {name:'OM Cust A<S>',email,taxNumber,address,minProfitMargin:10}. | HTTP 201, id customers_<ts>, log 'Entity registered'. | 1 |
| 2 | GET /api/v1/customers and find the new customer. | Customer is listed with the entered e-mail/tax number. | 1 |
| 3 | PUT /api/v1/customers/<id> {phone:'+20100'}. | HTTP 200; phone updated; other fields preserved. | 1 |
| 4 | POST /api/v1/customers/<id>/hold {isHold:true,holdReason:'credit'}. | HTTP 200, isHold true. | 1 |
| 5 | Create an order for the customer that is on hold (POST /api/v1/orders). | Observed: HTTP 201 (the API does NOT block orders for a customer on hold); UI behaviour to be confirmed by the user. | 1 |
| 6 | POST /api/v1/customers/<id>/hold {isHold:false}. | HTTP 200, isHold false. | 1 |
| 7 | GET /api/v1/customers/<id>. | HTTP 200; customer plus computed walletBalance and walletBalances. | 1 |
| 8 | GET /api/v1/customers/customers_000. | HTTP 404 {"error":"Item not found"}. | 1 |
| 9 | POST /api/v1/customers {name:''}. | Observed: HTTP 201 and a customer with an empty name is created (no server validation). | 1 |
| 10 | In the UI type a customer name in the order form that does not exist. | 'Add customer' prompt appears (AddCustomerModal) and the customer is created on save (UI only). | 1 |
| 11 | In the UI open the customer dropdown and type part of a name. | List filters while typing (UI only). | 1 |
| 12 | GET /api/v1/project-wallets. | HTTP 200; customer advance balances grouped per project. | 1 |
| 13 | POST /api/v1/customers/<id>/advance-payment {amount:100,referenceNumber:'ADV',notes:'x'}. | HTTP 200; GET /api/v1/project-wallets then lists '(General Advance / Future Orders)' with balance 100 for the customer. | 1 |
| 14 | POST /api/v1/customers/merge {primaryId,secondaryIds:[]} with the key. | Observed HTTP 400 {"error":"No valid secondary customers found"} (merge is reachable for this role although it is a CRM function). | 1 |
| 15 | DELETE /api/v1/customers/<id>. | HTTP 404 (route does not exist). | 1 |

## Findings (observed behaviour, not fixed)

1. POST /api/v1/customers accepts an empty name.
2. An order can be created for a customer that is on hold (API level).
