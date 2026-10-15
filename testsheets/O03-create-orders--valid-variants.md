# O03 - Create orders: valid variants

- **Scenario id / name:** O03 / Create orders: valid variants
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 16 (1 point per step, 16 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Customer 'OM Cust A<S>' (from O02)
  - Trade item: 'Valve A' qty 10 price 450 unit pcs VAT 14 TRADING
  - Manufacturing item: 'Panel' qty 2 price 500 with component 'PLC' qty 2 cost 100 PROCUREMENT
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-12, 16 (the 3-line order created NEGATIVE_MARGIN). UI-only steps 13-15 derived from OrderManagement.tsx.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | POST /api/v1/orders {customerName,customerReferenceNumber:'OM-T-001<S>',orderDate:today,currency:'L.E.',paymentTermsDays:30,items:[Valve A]}. | HTTP 201; internalOrderNumber INT-2024-000n; status LOGGED; log 'Order acquisition recorded'; item receives id and a mirror component. | 1 |
| 2 | GET /api/v1/orders/<id> for the new order. | Same order; logs length 1. | 1 |
| 3 | POST an order with a Manufacturing item with one PROCUREMENT component. | HTTP 201; status TECHNICAL_REVIEW (component present). | 1 |
| 4 | POST an order with 3 line items (2 trading, 1 manufacturing). | HTTP 201; items length 3. Status is NEGATIVE_MARGIN when cost exceeds price (observed with prices 10/20/30). | 1 |
| 5 | POST an order with currency USD and conversionRate 50. | HTTP 201; currency USD, conversionRate 50 stored. | 1 |
| 6 | POST an order with appliesWithholdingTax true. | HTTP 201; flag stored true. | 1 |
| 7 | POST an order with targetDeliveryDays 15. | HTTP 201; targetDeliveryDays 15 stored (targetDeliveryDate computed by the UI, null via API). | 1 |
| 8 | POST an order with projectName 'Project X'. | HTTP 201; projectName stored (visible in project wallets and Finance grouping). | 1 |
| 9 | POST an order whose reference and description contain < > & " ' characters. | HTTP 201; characters stored verbatim (UI must escape on display). | 1 |
| 10 | POST an order with item discountPercent 10. | HTTP 201; discountPercent stored (observed field kept on item; totals not recalculated by the API on creation). | 1 |
| 11 | POST an order with the same PO reference for a DIFFERENT customer. | HTTP 201 (uniqueness is per customer + PO reference). | 1 |
| 12 | POST an order with customerReferenceNumber 'STOCK-1<S>' and unit price 0. | HTTP 201: references starting with STOCK- (or customer 'Internal Stock') are stock orders and allow price 0. | 1 |
| 13 | In the UI choose tab 'New', fill customer, PO ref, date, items, press Save. | Success message with the new internal order number (UI only). | 1 |
| 14 | In the UI upload a PO file (PDF/image) to prefill by AI scan. | Form fields are prefilled from the document (UI only; needs AI provider settings). | 1 |
| 15 | In the UI add 2 items, then remove the first one before saving. | Only the remaining item is saved (UI only). | 1 |
| 16 | GET /api/v1/orders and count the orders created in this sheet. | All created orders present with unique internal order numbers. | 1 |

## Findings (observed behaviour, not fixed)

1. Trade orders stay LOGGED while manufacturing orders with a component start in TECHNICAL_REVIEW (observed); check this is the intended rule.
2. Total/revenue fields are not returned on the order object by POST (totals are computed in reports), so 'total value' cannot be asserted from the create response.
