# O04 - Create orders: validation and boundary values

- **Scenario id / name:** O04 / Create orders: validation and boundary values
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 19 (1 point per step, 19 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Each step is one POST /api/v1/orders using customer 'OM Cust A<S>' and a fresh PO reference unless stated
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-19.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | Item quantity 0. | HTTP 400 'Item 1 quantity must be a positive number'. | 1 |
| 2 | Item quantity -1. | HTTP 400 same message. | 1 |
| 3 | Item quantity 'abc'. | HTTP 400 same message. | 1 |
| 4 | Item price 0 (non-stock customer). | HTTP 400 'Item 1 unit price must be a positive number'. | 1 |
| 5 | Item price -5. | HTTP 400 same message. | 1 |
| 6 | Item without unit. | HTTP 400 'Item 1 unit is required'. | 1 |
| 7 | Component unit cost 0. | HTTP 400 'Item 1 component 1 unit cost must be a positive number'. | 1 |
| 8 | Component quantity 0. | HTTP 400 'Item 1 component 1 quantity must be a positive number'. | 1 |
| 9 | Fractional quantity 0.5. | Observed HTTP 201 (accepted). | 1 |
| 10 | Very large quantity 1,000,000,000. | Observed HTTP 201 (accepted, no upper bound). | 1 |
| 11 | Empty items array []. | Observed HTTP 201: an order with no line items is created. | 1 |
| 12 | No customerName. | Observed HTTP 201: order without customer is created. | 1 |
| 13 | Empty customerReferenceNumber. | Observed HTTP 201: order with empty PO reference is created. | 1 |
| 14 | orderDate 'not-a-date'. | Observed HTTP 201 and orderDate stored as 'not-a-date'. | 1 |
| 15 | currency 'XXX' (unsupported). | Observed HTTP 201, currency stored as XXX. | 1 |
| 16 | Repeat an existing PO reference for the same customer. | HTTP 400 'Duplicate PO reference "<ref>" already exists for customer "<name>".' | 1 |
| 17 | Repeat the PO reference with different letter case. | HTTP 400 duplicate message (comparison is case-insensitive). | 1 |
| 18 | Repeat the customer name with extra spaces and different case. | HTTP 400 duplicate message (trim + case-insensitive). | 1 |
| 19 | Reuse the PO reference of a REJECTED order of the same customer. | HTTP 201 (rejected orders are ignored by the uniqueness rule). | 1 |

## Findings (observed behaviour, not fixed)

1. Server accepts: empty items, missing customer, empty PO reference, invalid date, unsupported currency (UI form blocks some of them). The user should decide which of these must become errors.
2. Quantity validation is correct, but fractional and extremely large quantities are accepted.
