# S07 - Negative and exception cases

- **Scenario id / name:** S07 / Negative and exception cases
- **Role / user:** sales1, planner1, proc1, inv1, fin1, ship1, admin (password for all seed users: `Nexus#Test2026`)
- **Total points:** 20 (1 point per step, 20 steps)
- **Preconditions:**
  - Clean seed.
  - Customer 'S07 Cust' and supplier 'S07 Supplier' exist.
- **Test data:**
  - Order PO-S07-001: line 'Gear Box' qty 2 price 500 VAT 14% Manufacturing
  - Any ids are taken from the order you create
- **Live verification note:** Verified live 2026-10-15 (API): steps 2,3,4,5,6,7,8,9,12 (receive), 13 (manufacture),19 (404 body); step 18 and 20 observed (duplicate accepted by API; DELETE route 404). Steps 10,11,14-17 are from code reading and not executed.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | As sales1 create order PO-S07-001 'Gear Box' qty 2 price 500 (no components). | Order created, TECHNICAL_REVIEW. | 1 |
| 2 | Create a line item without a unit. (API POST /api/v1/orders) | Rejected: 'Item 1 unit is required' (HTTP 400). | 1 |
| 3 | Try to finalize the study with nothing accepted. | Rejected: 'All items must be accepted before finalizing study'. | 1 |
| 4 | Try release-delivery of 1 unit now. | Rejected: 'Finance receipt required. Only 0 units are financially cleared.' | 1 |
| 5 | Try confirm-delivery without POD path. | Rejected: 'Signed Delivery Note is required to confirm delivery.' | 1 |
| 6 | Put the order on hold with reason 'customer asked' (API POST /api/v1/orders/:id/hold). | Hold shown with the reason; status unchanged (LOGGED/TECHNICAL_REVIEW). | 1 |
| 7 | Release the hold. | isHold=false. | 1 |
| 8 | Roll back to LOGGED (planner1). | Status LOGGED; rolledBackToLogged lock badge. | 1 |
| 9 | Reject the order with reason 'cannot supply'. | Status REJECTED; received goods (if any) are released to free stock with RELEASED_TO_STOCK logs. | 1 |
| 10 | Create an order whose component cost exceeds the price (price 100, component cost 500), issue-PO path. | Order shows NEGATIVE_MARGIN/margin block; PO issuance blocked until management/admin releases margin. | 1 |
| 11 | As proc1 try to issue a PO for a component that is still RFP_SENT. | Rejected: 'Cannot issue PO: not all procurement components ... AWARDED' . | 1 |
| 12 | Over-receive: receive more than ordered (qty left 6, receive 7). | Rejected: 'Cannot receive more than ordered (Left: 6)'. | 1 |
| 13 | Over-manufacture: register qty larger than remaining target. | Rejected: 'Cannot manufacture N units. Only M units remaining to meet target.' | 1 |
| 14 | Approve dispatch for more units than are in the hub. | Rejected: 'Cannot receipt ... would exceed the items currently available'. | 1 |
| 15 | Ship more units than dispatched. | Rejected: 'Cannot ship N units ... Only M units are awaiting transit.' | 1 |
| 16 | Deliver more than shipped. | Rejected: 'Cannot deliver N units ... in transit on a truck.' | 1 |
| 17 | Login with a wrong password 3 times. | Each attempt returns 'Invalid username or password'; no lockout, correct password still works. | 1 |
| 18 | Duplicate customer PO reference for the same customer (create a second order with PO-S07-001). | Documented rule: must be unique per customer. UI blocks it. (Known: raw API accepted the duplicate in the live run - log as defect if the UI also allows it.) | 1 |
| 19 | Call POST /api/v1/orders/:id/dispatch-action on an unknown order id. | HTTP 404 {"error":"Order not found"}. | 1 |
| 20 | Call DELETE /api/v1/orders/:id. | Route does not exist (404); permanent removal is only via action hard-delete-order (admin). | 1 |
