# NexusERP test sheets (AI_testing, app version v1.001_ai)

Scenario sheets for the NexusERP app (branch NexusVSC + AI_testing). One Markdown file and one CSV per scenario, columns: Step No | Action | Expected success symptom | Points (1 per step).

| Scenario | Name | Sheet (.md / .csv) | Steps | Points |
|---|---|---|---|---|
| S01 | Login, roles and menu visibility | S01-login--roles-and-menu-visibility.md / S01-login--roles-and-menu-visibility.csv | 24 | 24 |
| S02 | Master data: customers, suppliers, price lists, inventory SKUs | S02-master-data--customers--suppliers--price-lists--inventory-skus.md / S02-master-data--customers--suppliers--price-lists--inventory-skus.csv | 21 | 21 |
| S03 | Trading order end-to-end: PO to cash (FULFILLED) | S03-trading-order-end-to-end--po-to-cash--fulfilled.md / S03-trading-order-end-to-end--po-to-cash--fulfilled.csv | 23 | 23 |
| S04 | Manufacturing order: BoM, sourcing, production, delivery, payment | S04-manufacturing-order--bom--sourcing--production--delivery--payment.md / S04-manufacturing-order--bom--sourcing--production--delivery--payment.csv | 22 | 22 |
| S05 | Inventory and stock reservation | S05-inventory-and-stock-reservation.md / S05-inventory-and-stock-reservation.csv | 15 | 15 |
| S06 | Finance: payments, customer wallet, supplier payments, ledger | S06-finance--payments--customer-wallet--supplier-payments--ledger.md / S06-finance--payments--customer-wallet--supplier-payments--ledger.csv | 15 | 15 |
| S07 | Negative and exception cases | S07-negative-and-exception-cases.md / S07-negative-and-exception-cases.csv | 22 | 22 |
| S08 | Administration: API keys, sandbox isolation, settings | S08-administration--api-keys--sandbox-isolation--settings.md / S08-administration--api-keys--sandbox-isolation--settings.csv | 17 | 17 |
| S09 | Reporting, search and history | S09-reporting--search-and-history.md / S09-reporting--search-and-history.csv | 15 | 15 |
| | **Total** | | **174** | **174** |

## Running the app

```bash
# one time (host): dependencies and frontend build (cache under /home)
cd /home/erp/NexusERP && npm_config_cache=/home/erp/npmcache npm ci && npm run build
# start (no image is built: uses local ubuntu:22.04 + host node; data in /home/erp/data)
docker compose -f docker-compose.nexuserp.yml up -d
# clean seed (10 users, modules on, e-mail alerts off)
bash testsheets/reset-testdata.sh
```

- URL: http://<host>:5005/ (container `nexuserp`, port 5005, API under /api/v1).
- Seed users, all with password `Nexus#Test2026`: admin (admin+management), sales1, planner1, proc1, inv1, fin1, factory1, ship1, crm1, mgmt1.
- Use API calls with header `x-user: <username>` (see testsheets/api.sh).
- Seed disables outbound e-mail alerts: the shipped defaults point to an external SMTP server.

## Known application findings while preparing the sheets

1. FIXED (1.001_ai): lost update in the periodic audit job; it now merges only its own deltas into a fresh read.
2. POST /api/v1/inventory/adjust changes legacy `quantity`, not `quantityInStock` (log says 'from 0 to 0').
3. API does not enforce unique customer name, unique SKU, unique supplier part number or unique customer PO ref (UI-only checks).
4. FIXED (1.001_ai): only admins can create/modify/delete users or change roles (identity is still a trusted x-user header). Hardcoded FACTORY_PASS and SMTP defaults removed: use env FACTORY_PASS, NEXUS_CIPHER_SECRET, SMTP_*.
5. consume-factory-component reports 'Insufficient stock ... Available: 0' right after a procurement component was received.
6. User guide payloads differ from the code (send-rfp-batch needs `components` + `rfpSupplierIds`; award needs `components[{id,unitCost}]`, `supplierId`; issue-po-batch needs `components` + `poNumber`; receive-component needs `compId` + `qty`; hub receipt needs `receipts[]`; shipping actions need `items[{itemId,qty}]`).
7. Shipment module is OFF in the app default config (constants.tsx); the seed turns it on.
