#!/usr/bin/env python3
"""Generates the scenario sheets (.md + .csv) and README.md. Edit data here, then run: python3 gen.py"""
import csv, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
PW = "Nexus#Test2026"
HDR = ["Step No", "Action", "Expected success symptom", "Points"]

SC = []
def sc(id, name, role, pre, data, steps, verified):
    SC.append(dict(id=id, name=name, role=role, pre=pre, data=data, steps=steps, verified=verified))

# ---------------------------------------------------------------- S01
sc("S01", "Login, roles and menu visibility", "admin, then sales1 / planner1 / proc1 / inv1 / fin1 / factory1 / ship1 / crm1 / mgmt1",
   ["Container nexuserp is running (http://<host>:5005); run testsheets/reset-testdata.sh for a clean seed.",
    "Seed users exist (password for all: " + PW + ")."],
   ["admin = roles admin+management; sales1 = order_management; planner1 = planning; proc1 = procurement; inv1 = inventory; fin1 = finance; factory1 = factory; ship1 = shipment; crm1 = crm; mgmt1 = management",
    "New user to create: qa.temp / Temp#12345 / role procurement"],
   [
    ("Open http://<host>:5005/ in a browser.", "Login screen shows Username and Password fields and an environment selector. HTTP 200 for GET /."),
    ("Type username `admin` in the Username field (do not submit yet).", "Environment list appears with 'Live ERP (Production)' and 'My Own Sandbox (Test Admin)'. API: GET /api/v1/auth/environments?username=admin returns both."),
    ("Select 'Live ERP (Production)', enter a WRONG password for admin, press Login.", "Login is refused with message 'Invalid username or password'; you stay on the login screen (API: POST /api/v1/login -> HTTP 401)."),
    ("Enter username `nouser` with any password, environment Live, press Login.", "Same message 'Invalid username or password' (no hint whether the user exists), HTTP 401."),
    ("Enter username `ADMIN` (upper case) with the correct password, environment Live.", "Login succeeds: user names are case-insensitive; response contains roles [admin, management] and NO password field."),
    ("After login as admin, look at the left navigation.", "Items visible: Dashboard, Order Management, Technical Review, Finance Operations, Procurement, Factory Build, Inventory & Hub, Shipment, CRM Contacts, Suppliers, Profitability, Gov.EInvoice, System Audit, Help Center, Settings. ('Minimums' is NOT shown: it needs a group named Managers/superusers)."),
    ("Scroll to the bottom of any page.", "Application version footer (e.g. 1.0001095) is displayed."),
    ("Click logout.", "Login screen is shown again; browser localStorage key `nexus_user` is removed; Back button does not re-enter the app."),
    ("Log in as `sales1`.", "Navigation shows only Order Management and Help Center."),
    ("Log out, log in as `planner1`.", "Navigation shows only Technical Review and Help Center."),
    ("Log out, log in as `proc1`.", "Navigation shows Procurement, Suppliers and Help Center."),
    ("Log out, log in as `inv1`.", "Navigation shows Inventory & Hub and Help Center."),
    ("Log out, log in as `fin1`.", "Navigation shows Finance Operations and Help Center."),
    ("Log out, log in as `factory1`.", "Navigation shows Factory Build and Help Center."),
    ("Log out, log in as `ship1`.", "Navigation shows Shipment and Help Center (module 'shipping' is enabled by the seed)."),
    ("Log out, log in as `crm1`.", "Navigation shows CRM Contacts and Help Center."),
    ("Log out, log in as `mgmt1`.", "Navigation shows Dashboard, Profitability and Help Center."),
    ("Log in as `admin`, open Settings -> user management, add user `qa.temp`, name 'QA Temp', e-mail qa.temp@test.local, password `Temp#12345`, role Procurement, save. (API: POST /api/v1/users as admin)", "User is saved and listed with role procurement; the password is not shown in the list."),
    ("Log out, log in as `qa.temp` / `Temp#12345`.", "Login succeeds; navigation shows Procurement, Suppliers, Help Center."),
    ("Log in as admin, edit `qa.temp`, add role CRM, save. (API: PUT /api/v1/users/:id {roles:[procurement,crm]}); log in again as qa.temp.", "After re-login CRM Contacts is also visible."),
    ("As `sales1` call API GET /api/v1/users (or open Settings via URL/UI).", "UI: no Settings item and any attempt to open it is redirected to the first allowed view (Order Management). API: list is returned WITHOUT password fields."),
    ("As `sales1` call GET /api/v1/api-keys.", "HTTP 403 {\"error\":\"Admin privileges are required to manage API keys.\"}"),
    ("As `sales1` call GET /api/v1/admin/sandboxes.", "HTTP 403 {\"error\":\"Access restricted to administrators.\"}"),
    ("Open Help Center as any role.", "Help Center opens (visible to every role); Developer API card offers the REST API user guide download."),
   ],
   "Live API equivalents run 2026-10-15 against nexuserp: steps 2,3,4,5,9-17 (role lists from login response),18,20,22,23 (HTTP codes and bodies as written). UI-only steps (1,6,7,8,9-17 menu rendering,19,21,24) derived from App.tsx role mapping and not rendered in a browser here.")

# ---------------------------------------------------------------- S02
sc("S02", "Master data: customers, suppliers, price lists, inventory SKUs", "crm1, proc1, inv1, admin",
   ["Clean seed (reset-testdata.sh).", "All modules enabled."],
   ["Customer A: 'S02 Acme Industrial' e-mail po@acme.test tax TX-1001 min margin 10; Customer B duplicate: 'S02 Acme Ind (dup)'",
    "Supplier: 'S02 Delta Steel' category Raw material; part CSH-100 'Cast Steel Housing' 100 L.E. lead 7 days",
    "Inventory SKU: BOLT-M8 'M8 Bolt' qty 100, min 20, bin A-01, unit pcs, cost 2"],
   [
    ("Log in as crm1, open CRM Contacts, press Add Customer.", "Add-customer dialog opens."),
    ("Enter name 'S02 Acme Industrial', e-mail po@acme.test, phone +20100000001, tax number TX-1001, address Cairo, minimum profit margin 10; save. (API POST /api/v1/customers)", "Customer appears in the list with an id `customers_<ts>` and log entry 'Entity registered' by crm1; wallet balance 0."),
    ("Add a second customer 'S02 Acme Ind (dup)'.", "Second customer listed (used for the merge test)."),
    ("Edit 'S02 Acme Industrial': set minimum profit margin 20 and phone +2011; save. (API PUT /api/v1/customers/:id)", "List shows margin 20 and the new phone; audit log gains an update entry."),
    ("Toggle customer hold ON with reason 'credit check'. (API POST /api/v1/customers/:id/hold {isHold:true,holdReason})", "Customer shows hold badge; log 'Hold Engaged: credit check'."),
    ("Toggle customer hold OFF.", "Hold badge disappears; isHold=false."),
    ("Merge '(dup)' into 'S02 Acme Industrial' (CRM merge tool; API POST /api/v1/customers/merge {primaryId, secondaryIds:[...]}).", "Message 'Successfully merged 1 customers'; only 'S02 Acme Industrial' remains in the list."),
    ("Log in as proc1, open Suppliers -> Active Suppliers, Add supplier 'S02 Delta Steel', contact Omar, category Raw material. (API POST /api/v1/suppliers)", "Supplier appears with an empty price list."),
    ("Open the supplier, add part: part number CSH-100, description 'Cast Steel Housing', unit cost 100, currency L.E., lead time 7. (API POST /api/v1/suppliers/:id/parts)", "Part is listed in the price list with id `part_<ts>`; supplier log 'Part added to price list: CSH-100'."),
    ("Try to add a second part with part number ' csh-100 ' (different case/whitespace).", "UI: save is blocked with a duplicate part-number validation error. (Known: the raw API does NOT enforce this; the rule is enforced in the UI.)"),
    ("Blacklist the supplier with reason 'quality'. (API POST /api/v1/suppliers/:id/blacklist)", "Supplier shows Blacklisted badge with the reason."),
    ("Remove the blacklist.", "Badge disappears; isBlacklisted=false."),
    ("Log in as admin, Suppliers, edit unit cost of CSH-100 to 110. (API PUT /api/v1/suppliers/:id/parts/:partId)", "Price list shows 110. Inline edit controls are visible ONLY for admin (not for proc1)."),
    ("As admin delete part CSH-100.", "Message 'Part archived to Deleted Suppliers vault'; part disappears from the active supplier and appears under the 'Deleted Suppliers' tab (admin-only) where it is read-only."),
    ("Log in as inv1, open Inventory & Hub, add item: SKU BOLT-M8, description 'M8 Bolt', quantity 100, min stock 20, bin A-01, unit pcs, cost 2. (API POST /api/v1/inventory)", "Item is listed with stock 100 and bin A-01."),
    ("Try to add another item with SKU ' bolt-m8 '.", "UI blocks with a unique-SKU error (case-insensitive, trimmed). (Known: raw API accepts the duplicate.)"),
    ("Edit BOLT-M8: bin location B-07; save. (API PUT /api/v1/inventory/:id)", "Item shows bin B-07."),
    ("Open the item's Stock Card.", "Stock card modal shows the creation entry and the transaction history."),
    ("Click the 'Total Stock' metric card, then 'Free Warehouse Stock'.", "The list filters accordingly and the active card is highlighted."),
    ("Search the inventory list for 'bolt'.", "Only BOLT-M8 is displayed."),
    ("Log in as crm1 and open Suppliers via URL/menu.", "Not available: crm1 has no Suppliers access; user is redirected to CRM Contacts."),
   ],
   "Live API equivalents run 2026-10-15: steps 2,3,4,5,6,7,8,9,10(API accepts duplicate - noted),11,12,13,14,15,16(API accepts duplicate - noted),17. Other steps are UI-only and not rendered in a browser here.")

# ---------------------------------------------------------------- S03
sc("S03", "Trading order end-to-end: PO to cash (FULFILLED)", "sales1, planner1, proc1, inv1, fin1, ship1",
   ["Clean seed (reset-testdata.sh).", "Customer 'S03 Customer Co' (min margin 10) and supplier 'S03 Supplier Ltd' exist (create in Customers/Suppliers or API)."],
   ["Customer PO ref PO-S03-001, order date today, currency L.E., payment terms 30 days",
    "One TRADING line: 'Heavy Duty Valve Assembly', qty 10, price 450, VAT 14%, unit pcs; component cost 100/unit from PROCUREMENT",
    "Revenue incl. VAT = 10 x 450 x 1.14 = 5,130.00; PO number PO-S03-0001"],
   [
    ("Log in as sales1, Order Management, new order: customer 'S03 Customer Co', PO ref PO-S03-001, line item as in test data (production type Trading, VAT 14%), component source Procurement, cost 100. Save. (API POST /api/v1/orders)", "Order saved; internal number INT-2024-000x assigned; status moves automatically LOGGED -> TECHNICAL_REVIEW (log '[AUTO] Initial Status')."),
    ("As planner1 open Technical Review and select the order.", "Order is in the queue with its SLA counter running."),
    ("Try to finalize the study before accepting the item. (API dispatch-action finalize-study)", "Blocked: 'All items must be accepted before finalizing study'; status stays TECHNICAL_REVIEW."),
    ("Accept item 1 (toggle acceptance).", "Item shows Accepted; log 'Item 1: Accepted'."),
    ("Finalize the study.", "Status becomes WAITING_SUPPLIERS; log 'Technical study finalized and pushed to Procurement'; component status PENDING_OFFER/NEW."),
    ("As proc1 open Procurement, find the order, Send RFP for the component to 'S03 Supplier Ltd'.", "Component status RFP_SENT; log 'Sent RFP batch for 1 components'."),
    ("Award the tender to 'S03 Supplier Ltd' at unit cost 100, lead time 7 days.", "Component status AWARDED; log 'Awarded Tender batch ... to S03 Supplier Ltd'."),
    ("Fetch a PO number (API GET /api/v1/procurement/unique-po-number) or use PO-S03-0001, Issue PO.", "Component status ORDERED with poNumber PO-S03-0001."),
    ("As inv1 open Inventory & Hub / Stock Reception, receive 4 pcs of the component.", "Received qty 4 of 10; order stays WAITING_SUPPLIERS."),
    ("Try to receive 7 more pcs.", "Rejected: 'Cannot receive more than ordered (Left: 6)'."),
    ("Receive the remaining 6 pcs.", "Component status Manufactured, received 10/10; trading goods go straight to the Product Hub; order status IN_PRODUCT_HUB."),
    ("As fin1 open Finance Operations, issue the invoice for the order.", "Status INVOICED; invoice number INV-<yymmdd>-<nnn> assigned."),
    ("As ship1 try to release 10 pcs for delivery before Finance approval.", "Rejected: 'Finance receipt required. Only 0 units are financially cleared'."),
    ("As fin1 approve dispatch receipt for 10 pcs.", "approvedForDispatchQty = 10; status remains INVOICED."),
    ("As ship1 release 10 pcs from the hub.", "Status HUB_RELEASED."),
    ("Mark the 10 pcs as shipped (in transit).", "shippedQty = 10; log 'Items transitioned to IN TRANSIT'."),
    ("Try to confirm delivery without a signed delivery note/POD.", "Rejected: 'Signed Delivery Note is required to confirm delivery.'"),
    ("Upload a POD file and confirm delivery of 10 pcs. (API upload via POST /api/upload-pod then confirm-delivery with podFilePath)", "Order status DELIVERED; delivery record DEL-<ts> with the POD path."),
    ("As fin1 record payment 2,000.00, memo 'S03 first payment'.", "Payment saved with receipt number RCV-...; status stays DELIVERED (partially paid)."),
    ("Record payment 3,130.00, memo 'S03 balance'.", "Fully paid (total 5,130.00); status WAITING_GOVE (awaiting Gov. E-Invoice)."),
    ("As a Gov.EInvoice/finance user attach e-invoice file (API attach-einvoice {einvoiceFile}).", "Status FULFILLED; log 'Gov. E-Invoice Attached ... Order FULFILLED'."),
    ("Wait 70 seconds (one background audit tick) and reload the order.", "Status is still FULFILLED and all logs are intact (regression check for the lost-update bug seen when e-mail alerts are enabled)."),
    ("Open the order details modal and read the audit log.", "Log lists every transition above in order with the acting user for each action."),
   ],
   "FULLY verified live 2026-10-15 via API dispatch-action calls (steps 1-22 in order, outputs in testsheets/verification-S03-api-run.txt). Step 23 read from the log. UI rendering not checked in a browser here. Note: unit/PO ids are generated, so use the ids returned by your own run.")

# ---------------------------------------------------------------- S04
sc("S04", "Manufacturing order: BoM, sourcing, production, delivery, payment", "sales1, planner1, proc1, inv1, factory1, fin1, ship1",
   ["Clean seed (reset-testdata.sh).", "Customer 'S04 Beta Trading' and supplier 'S04 Gamma Parts' exist."],
   ["Order PO ref PO-S04-001; line 'Control Panel' qty 5, price 1,000, VAT 14%, production type Manufacturing",
    "BoM component 'PLC Module' qty 5, unit cost 300, source Procurement, supplier 'S04 Gamma Parts', PO PO-S04-0001",
    "Revenue incl. VAT = 5 x 1000 x 1.14 = 5,700.00; payments 2,000 then 3,700"],
   [
    ("As sales1 create order for 'S04 Beta Trading', PO ref PO-S04-001, line 'Control Panel' qty 5 price 1000 VAT 14%, production type Manufacturing, no components. (API POST /api/v1/orders)", "Order created, status TECHNICAL_REVIEW, internal number assigned."),
    ("As planner1 open the order in Technical Review and add a BoM component: 'PLC Module', qty 5, unit cost 300, source Procurement. (API dispatch-action add-component {itemId, component})", "Component listed in the BoM; log 'Component added: PLC Module (PROCUREMENT)'."),
    ("Accept the item.", "Item Accepted."),
    ("Finalize the study.", "Status WAITING_SUPPLIERS; component PENDING_OFFER."),
    ("As proc1 send RFP for PLC Module to 'S04 Gamma Parts'.", "Component RFP_SENT."),
    ("Award tender at 300/unit, lead 5 days.", "Component AWARDED."),
    ("Issue PO PO-S04-0001.", "Component ORDERED, poNumber PO-S04-0001; order stays WAITING_SUPPLIERS."),
    ("As inv1 receive 5 pcs of PLC Module.", "Component RESERVED (received 5/5) for this order; order status WAITING_FACTORY."),
    ("As factory1 open Factory Build and start production.", "Status MANUFACTURING; log 'Production Started: Released to Floor'."),
    ("Try to register manufactured qty 9.", "Rejected: 'Cannot manufacture 9 units. Only 5 units remaining to meet target.'"),
    ("Register manufactured qty 5.", "manufacturedQty 5/5; order auto-transitions to MANUFACTURING_COMPLETED."),
    ("As inv1 receive the 5 finished units into the Product Hub (receive-hub-partial).", "hubReceivedQty 5/5; status IN_PRODUCT_HUB."),
    ("Try to receive 1 more unit into the hub.", "Rejected: only 0 units are ready / manufactured."),
    ("As fin1 issue the invoice.", "Status INVOICED, invoice number assigned."),
    ("Record advance payment 2,000.00 'advance'.", "Payment receipt created; status INVOICED; balance 3,700.00 shown."),
    ("Approve dispatch receipt for 5 units.", "approvedForDispatchQty 5."),
    ("As ship1 release 5 units, then ship 5 units.", "After release status HUB_RELEASED; shippedQty 5."),
    ("Confirm delivery of 5 units with POD path /uploads/pod/s04.pdf.", "Status DELIVERED; delivery record created."),
    ("Record payment 3,700.00 'balance'.", "Fully paid; status WAITING_GOVE."),
    ("Attach e-invoice /uploads/einvoices/s04.pdf.", "Status FULFILLED."),
    ("Open Finance Operations -> order card and expand it.", "Order card shows invoiced amount 5,700, collections 5,700, supplier AP for PLC Module 1,500 (+ 14% input VAT) and realized profit."),
    ("Open Suppliers/Finance supplier AP view for 'S04 Gamma Parts'.", "Committed 1,500.00 and delivered value 1,500.00 are listed for PO-S04-0001."),
   ],
   "Live API run 2026-10-15 of an equivalent order (Control Panel qty 5 / PLC Module 300): steps 1-19 passed with the statuses written. Known deviation seen: consume-factory-component fails with 'Insufficient stock ... Available: 0' after a received procurement component (inventory not credited), so consumption is not a step here. Steps 20-21 (finance cards) are UI-only, not rendered here.")

# ---------------------------------------------------------------- S05
sc("S05", "Inventory and stock reservation", "inv1, planner1, admin",
   ["Clean seed.", "SKU BOLT-M8 with qty 100 exists (see S02 steps 14-15), or create it."],
   ["SKU BOLT-M8, qty 100, min stock 20", "Order PO ref PO-S05-001 for customer 'S05 Cust', line 'Bracket' qty 10 price 200 VAT 14% Manufacturing",
    "Component 'M8 Bolt' qty 30 source STOCK linked to inventory item BOLT-M8"],
   [
    ("As inv1 open Inventory & Hub; confirm item BOLT-M8 with stock 100, reserved 0.", "Row shows quantityInStock 100, reserved 0 (Free = 100)."),
    ("Edit BOLT-M8 minimum stock level to 20 (if not yet 20).", "Min level saved."),
    ("As sales1 create order PO-S05-001 (customer 'S05 Cust') with a Manufacturing line 'Bracket' qty 10 price 200 VAT 14%.", "Order created; status TECHNICAL_REVIEW."),
    ("As planner1 add component: 'M8 Bolt' qty 30, source STOCK, pick inventory item BOLT-M8. (API add-component with source STOCK and inventoryItemId)", "Component added; BOLT-M8 reserved quantity becomes 30; free stock 70."),
    ("As planner1 add another STOCK component of qty 80 for BOLT-M8.", "Rejected: 'Insufficient stock: only 70 pcs available (100 in stock, 30 reserved)'."),
    ("Open the Stock Card of BOLT-M8.", "Card shows reservation of 30 linked to the order."),
    ("Click the 'Reserved' metric card.", "List filters to items with reserved stock; BOLT-M8 shown, active ring on the card."),
    ("Roll the order back to LOGGED (planner1, reason 'wrong spec').", "Status LOGGED with Rolled-Back lock badge in Technical Review; order locked until Order Management updates it."),
    ("As sales1 edit the order (change customer reference or items) and save. (API PUT /api/v1/orders/:id)", "rolledBackToLogged flag cleared; Technical Review is unlocked with a fresh SLA clock."),
    ("As admin adjust stock of BOLT-M8 to 90 (edit quantity in Inventory; API PUT /api/v1/inventory/:id {quantityInStock:90}).", "Stock shows 90. (Known deviation: API POST /api/v1/inventory/adjust changes the legacy `quantity` field, not quantityInStock.)"),
    ("Delete a test SKU created for this sheet (UI delete).", "SKU removed from the list."),
    ("Use the universal search with the PO number 'PO-S05-001'.", "Inventory/related views filter to items linked to that order reference."),
   ],
   "Partially verified live: step 1,2,10 (API PUT) and the adjust deviation; steps 4-5 derived from add-component stock-reservation code (server.js add-component) and not executed. Step 8-9 derived from rollback code, not executed. Mark remaining steps UI-only.")

# ---------------------------------------------------------------- S06
sc("S06", "Finance: payments, customer wallet, supplier payments, ledger", "fin1, crm1, proc1, admin",
   ["Clean seed.", "Customer 'S06 Cust' and supplier 'S06 Supplier' exist; one invoiced order PO-S06-001 (qty 10 x 450, VAT 14% = 5,130) can be produced by running S03 steps 1-12 with S06 names."],
   ["Advance deposit 5,000 ref ADV-1", "Customer payment 2,000 then 3,130", "Supplier payment 100, PO PO-X, ref TRX1", "Manual ledger entry: 'Manual journal' 250 debit account Cash"],
   [
    ("As crm1/fin1 open Customer Accounts & Wallets (Finance) and select 'S06 Cust'.", "Customer wallet shows balance 0.00."),
    ("Record advance payment 5,000 ref ADV-1 note 'deposit'. (API POST /api/v1/customers/:id/advance-payment)", "Wallet balance 5,000; log 'Advance Payment Recorded: 5,000 L.E.'."),
    ("Open project wallets (API GET /api/v1/project-wallets).", "One entry '(General Advance / Future Orders)' balance 5000 with the customer listed."),
    ("Open invoiced order PO-S06-001 in Finance and record payment 2,000.00 using 'Apply from Customer Wallet'.", "Wallet decreases by 2,000 to 3,000; payment recorded with a receipt number."),
    ("Record payment 3,130.00 (cash).", "Total paid 5,130 equals invoice total; order fully paid (status moves to WAITING_GOVE when delivered)."),
    ("Generate the payment receipt PDF for the first payment.", "A PDF named Receipt-<order>-<receipt>.pdf downloads with customer, amount and previous payments."),
    ("Cancel the 3,130 payment with a reason (cancel-payment).", "Payment removed; balance due 3,130 again; log entry for cancellation."),
    ("As proc1/fin1 record a supplier payment: supplier 'S06 Supplier', amount 100, PO PO-X, ref TRX1. (API POST /api/v1/supplierPayments)", "Payment saved with unallocatedAdvance 100 (no matching PO yet)."),
    ("Open the supplier ledger (API GET /api/v1/supplier-ledger/:supplierId).", "Summary shows totalPaid 100 and balance -100 (advance in favour of the company)."),
    ("Add a manual journal entry in General Ledger: 'Manual journal', 250, debit, Cash. (API POST /api/v1/ledger)", "Entry appears in the ledger list with an id `ledger_<ts>`."),
    ("Open the General Ledger balance sheet dashboard.", "Assets and Liabilities+Equity sections are displayed and the variance indicator is zero for the seeded data."),
    ("Search Finance order list with the keyword 'non-project'.", "Only orders without a project name are listed."),
    ("Expand all order cards (Expand All).", "All cards open; Collapse All closes them."),
   ],
   "Verified live 2026-10-15 (API): steps 2,3,8,9,10 (outputs as written). Steps 4-7 and 11-13 rely on code paths read in server.js/FinanceModule and were not executed or rendered here.")

# ---------------------------------------------------------------- S07
sc("S07", "Negative and exception cases", "sales1, planner1, proc1, inv1, fin1, ship1, admin",
   ["Clean seed.", "Customer 'S07 Cust' and supplier 'S07 Supplier' exist."],
   ["Order PO-S07-001: line 'Gear Box' qty 2 price 500 VAT 14% Manufacturing", "Any ids are taken from the order you create"],
   [
    ("As sales1 create order PO-S07-001 'Gear Box' qty 2 price 500 (no components).", "Order created, TECHNICAL_REVIEW."),
    ("Create a line item without a unit. (API POST /api/v1/orders)", "Rejected: 'Item 1 unit is required' (HTTP 400)."),
    ("Try to finalize the study with nothing accepted.", "Rejected: 'All items must be accepted before finalizing study'."),
    ("Try release-delivery of 1 unit now.", "Rejected: 'Finance receipt required. Only 0 units are financially cleared.'"),
    ("Try confirm-delivery without POD path.", "Rejected: 'Signed Delivery Note is required to confirm delivery.'"),
    ("Put the order on hold with reason 'customer asked' (API POST /api/v1/orders/:id/hold).", "Hold shown with the reason; status unchanged (LOGGED/TECHNICAL_REVIEW)."),
    ("Release the hold.", "isHold=false."),
    ("Roll back to LOGGED (planner1).", "Status LOGGED; rolledBackToLogged lock badge."),
    ("Reject the order with reason 'cannot supply'.", "Status REJECTED; received goods (if any) are released to free stock with RELEASED_TO_STOCK logs."),
    ("Create an order whose component cost exceeds the price (price 100, component cost 500), issue-PO path.", "Order shows NEGATIVE_MARGIN/margin block; PO issuance blocked until management/admin releases margin."),
    ("As proc1 try to issue a PO for a component that is still RFP_SENT.", "Rejected: 'Cannot issue PO: not all procurement components ... AWARDED' ."),
    ("Over-receive: receive more than ordered (qty left 6, receive 7).", "Rejected: 'Cannot receive more than ordered (Left: 6)'."),
    ("Over-manufacture: register qty larger than remaining target.", "Rejected: 'Cannot manufacture N units. Only M units remaining to meet target.'"),
    ("Approve dispatch for more units than are in the hub.", "Rejected: 'Cannot receipt ... would exceed the items currently available'."),
    ("Ship more units than dispatched.", "Rejected: 'Cannot ship N units ... Only M units are awaiting transit.'"),
    ("Deliver more than shipped.", "Rejected: 'Cannot deliver N units ... in transit on a truck.'"),
    ("Login with a wrong password 3 times.", "Each attempt returns 'Invalid username or password'; no lockout, correct password still works."),
    ("Duplicate customer PO reference for the same customer (create a second order with PO-S07-001).", "Documented rule: must be unique per customer. UI blocks it. (Known: raw API accepted the duplicate in the live run - log as defect if the UI also allows it.)"),
    ("Call POST /api/v1/orders/:id/dispatch-action on an unknown order id.", "HTTP 404 {\"error\":\"Order not found\"}."),
    ("Call DELETE /api/v1/orders/:id.", "Route does not exist (404); permanent removal is only via action hard-delete-order (admin)."),
   ],
   "Verified live 2026-10-15 (API): steps 2,3,4,5,6,7,8,9,12 (receive), 13 (manufacture),19 (404 body); step 18 and 20 observed (duplicate accepted by API; DELETE route 404). Steps 10,11,14-17 are from code reading and not executed.")

# ---------------------------------------------------------------- S08
sc("S08", "Administration: API keys, sandbox isolation, settings", "admin",
   ["Clean seed.", "A customer 'S08 Live Cust' exists in Live (create as crm1)."],
   ["API key name qa-key (owner admin)", "Sandbox owner = admin (personal sandbox)"],
   [
    ("Log in as admin, open Settings -> API Keys, create key 'qa-key' for admin. (API POST /api/v1/api-keys)", "Key shown ONCE with prefix nex_...; badge 'Sandbox Only' (allowLive false); roles inherited [admin, management]."),
    ("List keys (GET /api/v1/api-keys).", "Entry shows prefix, enabled true, allowLive false and no full secret."),
    ("Call GET /api/v1/customers with header x-api-key.", "Returns [] : the key is forced into admin's personal sandbox, live data is not visible."),
    ("POST a customer 'S08 Sandbox Cust' with the key.", "Created in the sandbox; Live customer list (x-user: admin) does NOT contain it."),
    ("Toggle 'Allow Live Data Access' on the key (PUT /api/v1/api-keys/:id {allowLive:true}).", "Badge becomes 'Live Allowed'; subsequent calls with the key see Live data ('S08 Live Cust')."),
    ("Revoke the key (DELETE /api/v1/api-keys/:id).", "Message 'API key revoked.'; using the key again returns HTTP 401."),
    ("Log in choosing 'My Own Sandbox (Test Admin)'.", "Persistent sandbox banner shows with Reset Data, Revert to Login State, Exit Sandbox; data of Live is not visible."),
    ("In the sandbox press Reset Data and type RESET.", "Sandbox business data cleared; users and groups preserved."),
    ("Try POST /api/v1/wipe while in sandbox mode.", "Rejected: 'Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset.'"),
    ("Press Exit Sandbox.", "Returned to login screen, localStorage cleared."),
    ("As admin open GET /api/v1/admin/sandboxes.", "List contains the admin sandbox with size and member count."),
    ("Open Settings -> modules and disable the Shipment module; log in as ship1.", "Shipment menu disappears for ship1 (module off); re-enable restores it."),
    ("Download the REST API user guide (Help Center or GET /api/v1/user-guide?format=markdown).", "Markdown document 'NexusERP RESTful API User Guide' downloads."),
    ("Create a full backup in Settings -> backups (GET /api/v1/full-backup with needed params).", "An encrypted .nxarchive file is downloaded."),
   ],
   "Verified live 2026-10-15 (API): steps 1,2,3,4,5,6,11,13 (guide fetched, 24 KB). Steps 7-10, 12, 14 are UI/sandbox flows not executed here (backup endpoint answered HTTP 400 without parameters).")

# ---------------------------------------------------------------- S09
sc("S09", "Reporting, search and history", "mgmt1, admin, proc1",
   ["Run S03 first so that at least one FULFILLED order exists."],
   ["Order from S03 (PO-S03-001), part description 'Heavy Duty Valve Assembly'"],
   [
    ("As mgmt1 open Dashboard.", "Dashboard cards load; status distribution includes the FULFILLED order."),
    ("Open Profitability report.", "Report lists the order with revenue, real cost, gross profit and margin %."),
    ("Call GET /api/v1/reports/orders.", "JSON with count, totalRevenue, totalRealCost, grossProfit, profitMarginPct and orders[]."),
    ("Export the executive snapshot PDF from the Dashboard (management role).", "A PDF with status distribution, critical margin alerts and customer/supplier summaries downloads."),
    ("As proc1 open Part History and search 'Heavy Duty'.", "History shows the S03 component with supplier, price 100, quantity 10 and PO number."),
    ("Call GET /api/v1/procurement/history?description=Valve.", "Array containing orderNumber, supplierName, price 100, quantity 10 for the S03 order."),
    ("Open Procurement universal search with the PO number PO-S03-0001 and with keyword 'non-project'.", "Order card appears for the PO; 'non-project' keeps it (no project name)."),
    ("Open System Audit as admin.", "System logs are listed (admin only); non-admin users do not see the item."),
    ("Open the order list in Order Management and sort by 'Last Edited'.", "Latest edited order appears first; clicking again reverses order."),
    ("Switch the language to Arabic with the language toggle.", "UI becomes RTL with Arabic labels; the choice survives a reload."),
    ("Switch back to English.", "UI returns to LTR English."),
    ("Open Help Center.", "Help links/videos configured in settings are shown as cards; empty state if none."),
    ("Check footer version versus constants.tsx APP_VERSION.", "Footer value equals APP_VERSION (1.0001095 at the time of writing)."),
    ("Call GET /api/v1/orders and count FULFILLED orders.", "Count equals the number visible in Finance 'fulfilled' filter."),
    ("Open Gov.EInvoice module.", "FULFILLED/attached e-invoice for the order is listed with its file link."),
   ],
   "Verified live 2026-10-15 (API): steps 3,6,14 (reports/orders and procurement history returned the S03 data). Others UI-only and not rendered here.")


def _extra(i,l): 
    for x in SC:
        if x["id"]==i: x["steps"].extend(l)
_extra("S05",[("As inv1 create a second SKU NUT-M8 qty 50 min 10 (API POST /api/v1/inventory).","Item listed with stock 50."),
 ("Sort/search inventory by 'NUT'.","Only NUT-M8 shown."),
 ("Edit NUT-M8 last cost to 1.5 (API PUT).","Cost shows 1.5; item list persists after reload.")])
_extra("S06",[("Open the Finance order list filter 'Unpaid'.","Only orders with a balance due are listed."),
 ("Reload the page and reopen the customer wallet.","Wallet balance persists (server state).")])
_extra("S08",[("As admin list GET /api/v1/settings.","Settings JSON returned with enableNewOrderAlerts false in the seeded instance.")])
_extra("S07",[("As sales1 call POST /api/v1/users with roles [admin].","HTTP 403 'Admin privileges are required to create users.' and no user is created (regression for privilege escalation fix)."),
 ("As sales1 call PUT /api/v1/users/:id with roles [admin] for any user, including sales1's own record.","HTTP 403 'Admin privileges are required to modify users or roles.'")])
_extra("S08",[("Enable new-order alerts with an SMTP host that is unreachable, create an order, and during the 60 s audit change the order (accept item, finalize study).","The order keeps the user change (status WAITING_SUPPLIERS) after the audit finishes: the audit merges only its own log/notification changes (regression for lost-update fix; timing-dependent, see Findings in README)."),
 ("Start a fresh container with FACTORY_PASS and SMTP_* unset and read GET /api/v1/settings and try login username factory.","emailConfig.smtpServer is empty (no built-in SMTP account) and the factory emergency login is refused (disabled when FACTORY_PASS is unset).")])

def md_escape(s): return s.replace("|", "\\|")

def write(sc_):
    n = len(sc_["steps"])
    base = os.path.join(HERE, f"{sc_['id']}-" + "".join(c if c.isalnum() else "-" for c in sc_["name"]).strip("-").lower())
    lines = [f"# {sc_['id']} - {sc_['name']}", "",
             f"- **Scenario id / name:** {sc_['id']} / {sc_['name']}",
             f"- **Role / user:** {sc_['role']} (password for all seed users: `{PW}`)",
             f"- **Total points:** {n} (1 point per step, {n} steps)",
             "- **Preconditions:**"] + [f"  - {p}" for p in sc_["pre"]] + ["- **Test data:**"] + [f"  - {d}" for d in sc_["data"]] + \
            [f"- **Live verification note:** {sc_['verified']}", "", "| " + " | ".join(HDR) + " |", "|---|---|---|---|"]
    rows = []
    for i, (a, e) in enumerate(sc_["steps"], 1):
        lines.append(f"| {i} | {md_escape(a)} | {md_escape(e)} | 1 |")
        rows.append([i, a, e, 1])
    open(base + ".md", "w").write("\n".join(lines) + "\n")
    with open(base + ".csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(HDR); w.writerows(rows)
    return os.path.basename(base), n

idx = []
for s in SC:
    b, n = write(s); idx.append((s["id"], s["name"], b, n))
tot = sum(n for *_, n in idx)
r = ["# NexusERP test sheets (AI_testing, app version v1.001_ai)", "",
     "Scenario sheets for the NexusERP app (branch NexusVSC + AI_testing). One Markdown file and one CSV per scenario, columns: Step No | Action | Expected success symptom | Points (1 per step).", "",
     "| Scenario | Name | Sheet (.md / .csv) | Steps | Points |", "|---|---|---|---|---|"]
for i, nm, b, n in idx:
    r.append(f"| {i} | {nm} | {b}.md / {b}.csv | {n} | {n} |")
r += [f"| | **Total** | | **{tot}** | **{tot}** |", "",
      "## Running the app", "",
      "```bash",
      "# one time (host): dependencies and frontend build (cache under /home)",
      "cd /home/erp/NexusERP && npm_config_cache=/home/erp/npmcache npm ci && npm run build",
      "# start (no image is built: uses local ubuntu:22.04 + host node; data in /home/erp/data)",
      "docker compose -f docker-compose.nexuserp.yml up -d",
      "# clean seed (10 users, modules on, e-mail alerts off)",
      "bash testsheets/reset-testdata.sh",
      "```", "",
      "- URL: http://<host>:5005/ (container `nexuserp`, port 5005, API under /api/v1).",
      f"- Seed users, all with password `{PW}`: admin (admin+management), sales1, planner1, proc1, inv1, fin1, factory1, ship1, crm1, mgmt1.",
      "- Use API calls with header `x-user: <username>` (see testsheets/api.sh).",
      "- Seed disables outbound e-mail alerts: the shipped defaults point to an external SMTP server.",
      "", "## Known application findings while preparing the sheets", "",
      "1. FIXED (1.001_ai): lost update in the periodic audit job; it now merges only its own deltas into a fresh read.",
      "2. POST /api/v1/inventory/adjust changes legacy `quantity`, not `quantityInStock` (log says 'from 0 to 0').",
      "3. API does not enforce unique customer name, unique SKU, unique supplier part number or unique customer PO ref (UI-only checks).",
      "4. FIXED (1.001_ai): only admins can create/modify/delete users or change roles (identity is still a trusted x-user header). Hardcoded FACTORY_PASS and SMTP defaults removed: use env FACTORY_PASS, NEXUS_CIPHER_SECRET, SMTP_*.",
      "5. consume-factory-component reports 'Insufficient stock ... Available: 0' right after a procurement component was received.",
      "6. User guide payloads differ from the code (send-rfp-batch needs `components` + `rfpSupplierIds`; award needs `components[{id,unitCost}]`, `supplierId`; issue-po-batch needs `components` + `poNumber`; receive-component needs `compId` + `qty`; hub receipt needs `receipts[]`; shipping actions need `items[{itemId,qty}]`).",
      "7. Shipment module is OFF in the app default config (constants.tsx); the seed turns it on."]
open(os.path.join(HERE, "README.md"), "w").write("\n".join(r) + "\n")
print(idx, tot)
