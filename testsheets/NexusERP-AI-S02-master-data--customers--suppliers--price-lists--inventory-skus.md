# NexusERP-AI S02 - Master data: customers, suppliers, price lists, inventory SKUs

- **Scenario id / name:** S02 / Master data: customers, suppliers, price lists, inventory SKUs
- **Role / user:** crm1, proc1, inv1, admin (password for all seed users: `Nexus#Test2026`)
- **Total points:** 21 (1 point per step, 21 steps)
- **Preconditions:**
  - Clean seed (reset-testdata.sh).
  - All modules enabled.
- **Test data:**
  - Customer A: 'S02 Acme Industrial' e-mail po@acme.test tax TX-1001 min margin 10; Customer B duplicate: 'S02 Acme Ind (dup)'
  - Supplier: 'S02 Delta Steel' category Raw material; part CSH-100 'Cast Steel Housing' 100 L.E. lead 7 days
  - Inventory SKU: BOLT-M8 'M8 Bolt' qty 100, min 20, bin A-01, unit pcs, cost 2
- **Live verification note:** Live API equivalents run 2026-10-15: steps 2,3,4,5,6,7,8,9,10(API accepts duplicate - noted),11,12,13,14,15,16(API accepts duplicate - noted),17. Other steps are UI-only and not rendered in a browser here.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | Log in as crm1, open CRM Contacts, press Add Customer. | Add-customer dialog opens. | 1 |
| 2 | Enter name 'S02 Acme Industrial', e-mail po@acme.test, phone +20100000001, tax number TX-1001, address Cairo, minimum profit margin 10; save. (API POST /api/v1/customers) | Customer appears in the list with an id `customers_<ts>` and log entry 'Entity registered' by crm1; wallet balance 0. | 1 |
| 3 | Add a second customer 'S02 Acme Ind (dup)'. | Second customer listed (used for the merge test). | 1 |
| 4 | Edit 'S02 Acme Industrial': set minimum profit margin 20 and phone +2011; save. (API PUT /api/v1/customers/:id) | List shows margin 20 and the new phone; audit log gains an update entry. | 1 |
| 5 | Toggle customer hold ON with reason 'credit check'. (API POST /api/v1/customers/:id/hold {isHold:true,holdReason}) | Customer shows hold badge; log 'Hold Engaged: credit check'. | 1 |
| 6 | Toggle customer hold OFF. | Hold badge disappears; isHold=false. | 1 |
| 7 | Merge '(dup)' into 'S02 Acme Industrial' (CRM merge tool; API POST /api/v1/customers/merge {primaryId, secondaryIds:[...]}). | Message 'Successfully merged 1 customers'; only 'S02 Acme Industrial' remains in the list. | 1 |
| 8 | Log in as proc1, open Suppliers -> Active Suppliers, Add supplier 'S02 Delta Steel', contact Omar, category Raw material. (API POST /api/v1/suppliers) | Supplier appears with an empty price list. | 1 |
| 9 | Open the supplier, add part: part number CSH-100, description 'Cast Steel Housing', unit cost 100, currency L.E., lead time 7. (API POST /api/v1/suppliers/:id/parts) | Part is listed in the price list with id `part_<ts>`; supplier log 'Part added to price list: CSH-100'. | 1 |
| 10 | Try to add a second part with part number ' csh-100 ' (different case/whitespace). | UI: save is blocked with a duplicate part-number validation error. (Known: the raw API does NOT enforce this; the rule is enforced in the UI.) | 1 |
| 11 | Blacklist the supplier with reason 'quality'. (API POST /api/v1/suppliers/:id/blacklist) | Supplier shows Blacklisted badge with the reason. | 1 |
| 12 | Remove the blacklist. | Badge disappears; isBlacklisted=false. | 1 |
| 13 | Log in as admin, Suppliers, edit unit cost of CSH-100 to 110. (API PUT /api/v1/suppliers/:id/parts/:partId) | Price list shows 110. Inline edit controls are visible ONLY for admin (not for proc1). | 1 |
| 14 | As admin delete part CSH-100. | Message 'Part archived to Deleted Suppliers vault'; part disappears from the active supplier and appears under the 'Deleted Suppliers' tab (admin-only) where it is read-only. | 1 |
| 15 | Log in as inv1, open Inventory & Hub, add item: SKU BOLT-M8, description 'M8 Bolt', quantity 100, min stock 20, bin A-01, unit pcs, cost 2. (API POST /api/v1/inventory) | Item is listed with stock 100 and bin A-01. | 1 |
| 16 | Try to add another item with SKU ' bolt-m8 '. | UI blocks with a unique-SKU error (case-insensitive, trimmed). (Known: raw API accepts the duplicate.) | 1 |
| 17 | Edit BOLT-M8: bin location B-07; save. (API PUT /api/v1/inventory/:id) | Item shows bin B-07. | 1 |
| 18 | Open the item's Stock Card. | Stock card modal shows the creation entry and the transaction history. | 1 |
| 19 | Click the 'Total Stock' metric card, then 'Free Warehouse Stock'. | The list filters accordingly and the active card is highlighted. | 1 |
| 20 | Search the inventory list for 'bolt'. | Only BOLT-M8 is displayed. | 1 |
| 21 | Log in as crm1 and open Suppliers via URL/menu. | Not available: crm1 has no Suppliers access; user is redirected to CRM Contacts. | 1 |
