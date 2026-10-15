# S05 - Inventory and stock reservation

- **Scenario id / name:** S05 / Inventory and stock reservation
- **Role / user:** inv1, planner1, admin (password for all seed users: `Nexus#Test2026`)
- **Total points:** 15 (1 point per step, 15 steps)
- **Preconditions:**
  - Clean seed.
  - SKU BOLT-M8 with qty 100 exists (see S02 steps 14-15), or create it.
- **Test data:**
  - SKU BOLT-M8, qty 100, min stock 20
  - Order PO ref PO-S05-001 for customer 'S05 Cust', line 'Bracket' qty 10 price 200 VAT 14% Manufacturing
  - Component 'M8 Bolt' qty 30 source STOCK linked to inventory item BOLT-M8
- **Live verification note:** Partially verified live: step 1,2,10 (API PUT) and the adjust deviation; steps 4-5 derived from add-component stock-reservation code (server.js add-component) and not executed. Step 8-9 derived from rollback code, not executed. Mark remaining steps UI-only.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | As inv1 open Inventory & Hub; confirm item BOLT-M8 with stock 100, reserved 0. | Row shows quantityInStock 100, reserved 0 (Free = 100). | 1 |
| 2 | Edit BOLT-M8 minimum stock level to 20 (if not yet 20). | Min level saved. | 1 |
| 3 | As sales1 create order PO-S05-001 (customer 'S05 Cust') with a Manufacturing line 'Bracket' qty 10 price 200 VAT 14%. | Order created; status TECHNICAL_REVIEW. | 1 |
| 4 | As planner1 add component: 'M8 Bolt' qty 30, source STOCK, pick inventory item BOLT-M8. (API add-component with source STOCK and inventoryItemId) | Component added; BOLT-M8 reserved quantity becomes 30; free stock 70. | 1 |
| 5 | As planner1 add another STOCK component of qty 80 for BOLT-M8. | Rejected: 'Insufficient stock: only 70 pcs available (100 in stock, 30 reserved)'. | 1 |
| 6 | Open the Stock Card of BOLT-M8. | Card shows reservation of 30 linked to the order. | 1 |
| 7 | Click the 'Reserved' metric card. | List filters to items with reserved stock; BOLT-M8 shown, active ring on the card. | 1 |
| 8 | Roll the order back to LOGGED (planner1, reason 'wrong spec'). | Status LOGGED with Rolled-Back lock badge in Technical Review; order locked until Order Management updates it. | 1 |
| 9 | As sales1 edit the order (change customer reference or items) and save. (API PUT /api/v1/orders/:id) | rolledBackToLogged flag cleared; Technical Review is unlocked with a fresh SLA clock. | 1 |
| 10 | As admin adjust stock of BOLT-M8 to 90 (edit quantity in Inventory; API PUT /api/v1/inventory/:id {quantityInStock:90}). | Stock shows 90. (Known deviation: API POST /api/v1/inventory/adjust changes the legacy `quantity` field, not quantityInStock.) | 1 |
| 11 | Delete a test SKU created for this sheet (UI delete). | SKU removed from the list. | 1 |
| 12 | Use the universal search with the PO number 'PO-S05-001'. | Inventory/related views filter to items linked to that order reference. | 1 |
| 13 | As inv1 create a second SKU NUT-M8 qty 50 min 10 (API POST /api/v1/inventory). | Item listed with stock 50. | 1 |
| 14 | Sort/search inventory by 'NUT'. | Only NUT-M8 shown. | 1 |
| 15 | Edit NUT-M8 last cost to 1.5 (API PUT). | Cost shows 1.5; item list persists after reload. | 1 |
