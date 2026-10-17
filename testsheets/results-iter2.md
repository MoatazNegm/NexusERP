# NexusERP-AI results, iteration 2

Tester: AI_1_ERP. Platform app 10, version 1.002_ai. Honest results from the executed UI/API steps; no app code changed.

| Test | Steps | Passed | Failed | Failing steps (one-line cause) |
|---|---|---|---|---|
| O01 order-management-identity - api-key-and- | 15 | 15 | 0 | - |
| O02 customers-as-seen-from-order-management | 15 | 15 | 0 | - |
| O03 create-orders - valid-variants | 16 | 14 | 2 | 13: after Save: success message visible=False (watched 3 s, no message banner appeared; form reset, Logged badge 1; 14: after uploading a PO image: 'EXTRACTION FAILED: GEMINI API KEY IS NOT CONFIGURED. PLEASE CHECK SETTINGS > AI C |
| O04 create-orders - validation-and-boundary- | 19 | 19 | 0 | - |
| O05 edit-order-and-line-items | 15 | 14 | 1 | 14: order INT-2024-0004 status=TECHNICAL_REVIEW: listed in Logged registry=False, lock/frozen message visible=Fals |
| O06 order-lifecycle-controls - hold - rollba | 16 | 15 | 1 | 16: order_management UI: Logged list / resumed order buttons=[('', None), ('', None), ('NEW ORDERS', None), ('BLAN |
| O07 blanket-contracts-and-settling-orders | 15 | 14 | 1 | 9: UI New contract submitted with empty id: contracts 1->2 (validation prevents submit: False; new ids=['CON-3987 |
| O08 listing - search - filtering - reports-a | 15 | 12 | 3 | 12: RESUME RECORD opens edit form (no OrderDetailsModal); visible sections {'TRANSACTION LINE ITEMS': True, 'LOG':; 13: on the resumed order (and Logged list) PDF/export controls=[]; buttons=['', '', 'NEW ORDERS', 'BLANKET ORDERS'; 15: UI Logged rows=5 ['ALL (5)']; API orders in LOGGED/TECHNICAL_REVIEW/NEGATIVE_MARGIN=10 (status LOGGED only=5; |
| O09 permission-denied-and-trust-boundary-che | 15 | 15 | 0 | - |
| S01 login - roles-and-menu-visibility | 24 | 24 | 0 | - |
| S02 master-data - customers - suppliers - pr | 21 | 18 | 3 | 10: Price list editor of the supplier holding the part added in step 9 does not open: page goes blank (body text l; 13: PUT 200 stored unitCost=110; UI price list for admin after opening editor: shows 110=False, body length=0, pag; 19: metric 'Total Stock' present=True; 'Free Warehouse Stock' present=False; cards seen: TOTAL VALUE / PO LINKED V |
| S03 trading-order-end-to-end - po-to-cash -  | 23 | 23 | 0 | - |
| S04 manufacturing-order - bom - sourcing - p | 22 | 19 | 3 | 1: 201 status=LOGGED internal=INT-2024-0001; 21: Finance Operations text has 5,700=False, 1,500=False; buttons=['FINANCE OPERATIONS', 'HELP CENTER', 'EN\nEN\nع; 22: Finance view lists PO-S04-0001=False, 1,500=False |
| S05 inventory-and-stock-reservation | 15 | 10 | 5 | 3: 201 status=LOGGED internal=INT-2024-0001; 4: 200 reserved=60 free=40; 5: 400 {'error': 'Insufficient stock: only 40 pcs available (100 in stock, 60 reserved)'}; 11: after UI trash/confirm: skus=['BOLT-M8', 'TMP-DEL']; dialogs=[]; 12: search by order PO ref: BOLT-M8 listed=False; note: order was edited to PO-S05-001-R in step 9, and rolled bac |
| S06 finance - payments - customer-wallet - s | 15 | 13 | 2 | 14: Unpaid filter present: buttons=['', '', 'EN\nEN\nع', 'ORDERS', 'STOCK ORDERS', 'TRANSACTION HISTORY', 'BLACKLI; 15: after reload wallet shows 3,000=False; API walletBalance=3000; excerpt='CUSTOMERS\n1\nEXCL. INTERNAL STOCK\nIN |
| S07 negative-and-exception-cases | 22 | 21 | 1 | 1: 201 status=LOGGED internal=INT-2024-0001 |
| S08 administration - api-keys - sandbox-isol | 17 | 17 | 0 | - |
| S09 reporting - search-and-history | 15 | 11 | 4 | 5: history controls=['HISTORY']; search input=True; shows part=True, PO=False, supplier=True; excerpt='ust\n\tCMP; 7: procurement search results (order visible): [('PO-S03-0001', True), ('non-project', False)]; 14: API FULFILLED count=1; Finance UI has a fulfilled filter text=False; finance queue empty=True; 15: Admin > Gov.EInvoice portfolio shows 'NO PENDING E-INVOICE REQUESTS' for the FULFILLED order with attached e-i |

Total: 289 passed, 26 failed of 315 steps.
