# NexusERP-AI results, iteration 1

Tester: AI_1_ERP. Platform app 10, version 1.002_ai. Honest results from the executed UI/API steps; no app code changed.

| Test | Steps | Passed | Failed | Failing steps (one-line cause) |
|---|---|---|---|---|
| O01 order-management-identity - api-key-and- | 15 | 15 | 0 | - |
| O02 customers-as-seen-from-order-management | 15 | 15 | 0 | - |
| O03 create-orders - valid-variants | 16 | 14 | 2 | 13: Save in UI (tab New, PO UI-<S>, customer, 1 line item 3 x 100) created the order (API shows it, Logged badge 1; 14: Uploaded a PNG as PO file: UI shows 'EXTRACTION FAILED: GEMINI API KEY IS NOT CONFIGURED. PLEASE CHECK SETTING |
| O04 create-orders - validation-and-boundary- | 19 | 19 | 0 | - |
| O05 edit-order-and-line-items | 15 | 14 | 1 | 14: order INT-2024-0004 status=TECHNICAL_REVIEW: listed in Logged registry=False, lock/frozen message visible=Fals |
| O06 order-lifecycle-controls - hold - rollba | 16 | 15 | 1 | 16: order_management UI: Logged list / resumed order buttons=[('', None), ('', None), ('NEW ORDERS', None), ('BLAN |
| O07 blanket-contracts-and-settling-orders | 15 | 14 | 1 | 9: UI New contract submitted with empty id: contracts 1->2 (validation prevents submit: False; new ids=['CON-2315 |
| O08 listing - search - filtering - reports-a | 15 | 12 | 3 | 12: RESUME RECORD opens edit form (no OrderDetailsModal); visible sections {'TRANSACTION LINE ITEMS': True, 'LOG':; 13: on the resumed order (and Logged list) PDF/export controls=[]; buttons=['', '', 'NEW ORDERS', 'BLANKET ORDERS'; 15: UI Logged rows=5 ['ALL (5)']; API orders in LOGGED/TECHNICAL_REVIEW/NEGATIVE_MARGIN=10 (status LOGGED only=5; |
| O09 permission-denied-and-trust-boundary-che | 15 | 15 | 0 | - |
| S01 login - roles-and-menu-visibility | 24 | 24 | 0 | - |
| S02 master-data - customers - suppliers - pr | 21 | 18 | 3 | 10: Price list editor of the supplier holding the part added in step 9 does not open: page goes blank (body text l; 13: PUT 200 stored unitCost=110; UI price list for admin after opening editor: shows 110=False, body length=0, pag; 19: metric 'Total Stock' present=True; 'Free Warehouse Stock' present=False; cards seen: TOTAL VALUE / PO LINKED V |
| S03 trading-order-end-to-end - po-to-cash -  | 23 | 23 | 0 | - |
| S04 manufacturing-order - bom - sourcing - p | 22 | 19 | 3 | 1: POST /api/v1/orders as sales1 returned 201 with internal number INT-2024-0001 but status LOGGED, not TECHNICAL; 21: Finance Operations > Orders tab for fully FULFILLED order shows '0 ORDERS ... FINANCIAL QUEUE IS EMPTY': no or; 22: Finance > Suppliers AP & Reporting lists PO-S04-0001 for S04 Gamma Parts: committed NET 1,500 L.E. shown, but |
| S05 inventory-and-stock-reservation | 15 | 10 | 5 | 3: POST /api/v1/orders as sales1 with a no-component Manufacturing line returned 201 but status LOGGED, not TECHN; 4: add-component STOCK qty 30 for BOLT-M8 (order in LOGGED state) -> inventory quantityReserved=60 (free 40), exp; 5: Second STOCK add-component (qty 80) is rejected, but with 'only 40 pcs available (100 in stock, 60 reserved)'; 11: Inventory & Hub UI (card and table views, item detail, stock card) has no delete/trash control for a SKU; item; 12: search by order PO ref: BOLT-M8 listed=False; note: order was edited to PO-S05-001-R in step 9, and rolled bac |
| S06 finance - payments - customer-wallet - s | 15 | 13 | 2 | 14: Finance Orders tab has no 'Unpaid' filter: no filter buttons or select options besides tabs and search; only '; 15: After reload Finance > Customer Accounts & Wallets shows 'Advances / Wallets 6,000 L.E.' for S06 Cust while AP |
| S07 negative-and-exception-cases | 22 | 21 | 1 | 1: POST /api/v1/orders as sales1, no-component Manufacturing line, returned 201 with status LOGGED, not TECHNICAL |
| S08 administration - api-keys - sandbox-isol | 17 | 17 | 0 | - |
| S09 reporting - search-and-history | 15 | 11 | 4 | 5: Procurement > History (Part & Component History) search 'Heavy Duty' shows part, supplier S09 Supplier, price; 7: Procurement universal search: PO number PO-S03-0001 shows the order card, but keyword 'non-project' hides it (; 14: API FULFILLED count 1, but Finance Operations has no 'fulfilled' filter and its orders queue shows 'FINANCIAL; 15: Admin > Gov.EInvoice portfolio shows 'NO PENDING E-INVOICE REQUESTS' for the FULFILLED order with attached e-i |

Total: 289 passed, 26 failed of 315 steps.
