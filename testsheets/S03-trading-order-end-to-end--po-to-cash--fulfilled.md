# S03 - Trading order end-to-end: PO to cash (FULFILLED)

- **Scenario id / name:** S03 / Trading order end-to-end: PO to cash (FULFILLED)
- **Role / user:** sales1, planner1, proc1, inv1, fin1, ship1 (password for all seed users: `Nexus#Test2026`)
- **Total points:** 23 (1 point per step, 23 steps)
- **Preconditions:**
  - Clean seed (reset-testdata.sh).
  - Customer 'S03 Customer Co' (min margin 10) and supplier 'S03 Supplier Ltd' exist (create in Customers/Suppliers or API).
- **Test data:**
  - Customer PO ref PO-S03-001, order date today, currency L.E., payment terms 30 days
  - One TRADING line: 'Heavy Duty Valve Assembly', qty 10, price 450, VAT 14%, unit pcs; component cost 100/unit from PROCUREMENT
  - Revenue incl. VAT = 10 x 450 x 1.14 = 5,130.00; PO number PO-S03-0001
- **Live verification note:** FULLY verified live 2026-10-15 via API dispatch-action calls (steps 1-22 in order, outputs in testsheets/verification-S03-api-run.txt). Step 23 read from the log. UI rendering not checked in a browser here. Note: unit/PO ids are generated, so use the ids returned by your own run.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | Log in as sales1, Order Management, new order: customer 'S03 Customer Co', PO ref PO-S03-001, line item as in test data (production type Trading, VAT 14%), component source Procurement, cost 100. Save. (API POST /api/v1/orders) | Order saved; internal number INT-2024-000x assigned; status moves automatically LOGGED -> TECHNICAL_REVIEW (log '[AUTO] Initial Status'). | 1 |
| 2 | As planner1 open Technical Review and select the order. | Order is in the queue with its SLA counter running. | 1 |
| 3 | Try to finalize the study before accepting the item. (API dispatch-action finalize-study) | Blocked: 'All items must be accepted before finalizing study'; status stays TECHNICAL_REVIEW. | 1 |
| 4 | Accept item 1 (toggle acceptance). | Item shows Accepted; log 'Item 1: Accepted'. | 1 |
| 5 | Finalize the study. | Status becomes WAITING_SUPPLIERS; log 'Technical study finalized and pushed to Procurement'; component status PENDING_OFFER/NEW. | 1 |
| 6 | As proc1 open Procurement, find the order, Send RFP for the component to 'S03 Supplier Ltd'. | Component status RFP_SENT; log 'Sent RFP batch for 1 components'. | 1 |
| 7 | Award the tender to 'S03 Supplier Ltd' at unit cost 100, lead time 7 days. | Component status AWARDED; log 'Awarded Tender batch ... to S03 Supplier Ltd'. | 1 |
| 8 | Fetch a PO number (API GET /api/v1/procurement/unique-po-number) or use PO-S03-0001, Issue PO. | Component status ORDERED with poNumber PO-S03-0001. | 1 |
| 9 | As inv1 open Inventory & Hub / Stock Reception, receive 4 pcs of the component. | Received qty 4 of 10; order stays WAITING_SUPPLIERS. | 1 |
| 10 | Try to receive 7 more pcs. | Rejected: 'Cannot receive more than ordered (Left: 6)'. | 1 |
| 11 | Receive the remaining 6 pcs. | Component status Manufactured, received 10/10; trading goods go straight to the Product Hub; order status IN_PRODUCT_HUB. | 1 |
| 12 | As fin1 open Finance Operations, issue the invoice for the order. | Status INVOICED; invoice number INV-<yymmdd>-<nnn> assigned. | 1 |
| 13 | As ship1 try to release 10 pcs for delivery before Finance approval. | Rejected: 'Finance receipt required. Only 0 units are financially cleared'. | 1 |
| 14 | As fin1 approve dispatch receipt for 10 pcs. | approvedForDispatchQty = 10; status remains INVOICED. | 1 |
| 15 | As ship1 release 10 pcs from the hub. | Status HUB_RELEASED. | 1 |
| 16 | Mark the 10 pcs as shipped (in transit). | shippedQty = 10; log 'Items transitioned to IN TRANSIT'. | 1 |
| 17 | Try to confirm delivery without a signed delivery note/POD. | Rejected: 'Signed Delivery Note is required to confirm delivery.' | 1 |
| 18 | Upload a POD file and confirm delivery of 10 pcs. (API upload via POST /api/upload-pod then confirm-delivery with podFilePath) | Order status DELIVERED; delivery record DEL-<ts> with the POD path. | 1 |
| 19 | As fin1 record payment 2,000.00, memo 'S03 first payment'. | Payment saved with receipt number RCV-...; status stays DELIVERED (partially paid). | 1 |
| 20 | Record payment 3,130.00, memo 'S03 balance'. | Fully paid (total 5,130.00); status WAITING_GOVE (awaiting Gov. E-Invoice). | 1 |
| 21 | As a Gov.EInvoice/finance user attach e-invoice file (API attach-einvoice {einvoiceFile}). | Status FULFILLED; log 'Gov. E-Invoice Attached ... Order FULFILLED'. | 1 |
| 22 | Wait 70 seconds (one background audit tick) and reload the order. | Status is still FULFILLED and all logs are intact (regression check for the lost-update bug seen when e-mail alerts are enabled). | 1 |
| 23 | Open the order details modal and read the audit log. | Log lists every transition above in order with the acting user for each action. | 1 |
