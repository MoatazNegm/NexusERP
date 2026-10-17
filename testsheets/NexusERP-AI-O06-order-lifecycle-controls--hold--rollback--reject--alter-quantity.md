# NexusERP-AI O06 - Order lifecycle controls: hold, rollback, reject, alter quantity

- **Scenario id / name:** O06 / Order lifecycle controls: hold, rollback, reject, alter quantity
- **Role / user:** ai_tester (role order_management; the 'Order Management' menu, view `orders` in App.tsx) (password for all seed users: `Nexus#Test2026`)
- **Total points:** 16 (1 point per step, 16 steps)
- **Preconditions:**
  - Container nexuserp running on http://<host>:5005; user `ai_tester` (roles: order_management only) and its API key exist (admin created them via Settings -> API Keys / POST /api/v1/api-keys, then allowLive=true).
  - API key of user ai_tester (role order_management only, allowLive true) is in /root/topstor/AI_erp (first line); send it as header `x-api-key: <KEY>` (or `Authorization: Bearer <KEY>`). Never write the key into a sheet.
  - Customer used below is created by the sheet itself; every PO reference is made unique with a run suffix <S> (e.g. HHMMSS) because live data is not cleaned between runs.
- **Test data:**
  - Order X: 'Valve' qty 10 price 450 (status LOGGED)
  - Order Y: manufacturing order (status TECHNICAL_REVIEW)
- **Live verification note:** Verified live 2026-10-15 via API: steps 1-15. Step 16 derived from code.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | POST /orders/<X>/hold {isHold:true,holdReason:'customer asked'}. | HTTP 200; isHold true; log 'Hold Engaged: customer asked'; status unchanged (LOGGED). | 1 |
| 2 | POST /orders/<X>/hold {isHold:false}. | HTTP 200; isHold false; log 'Hold Released'. | 1 |
| 3 | POST /orders/<X>/hold {} (empty body). | HTTP 200; hold flag toggled (true) with reason 'Manual hold applied via API'. | 1 |
| 4 | dispatch-action toggle-hold {hold:true,reason:'strategic'}. | HTTP 200; status IN_HOLD; log 'Order placed in STRATEGIC HOLD: strategic'. | 1 |
| 5 | dispatch-action toggle-hold {hold:false}. | HTTP 200; status back to previous (LOGGED). | 1 |
| 6 | dispatch-action rollback-to-logged {reason:'wrong spec'}. | HTTP 200; status LOGGED; rolledBackToLogged true; dataEntryTimestamp reset. | 1 |
| 7 | PUT /orders/<X> {orderDate:today} after the rollback. | HTTP 200; rolledBackToLogged flag cleared; technical review SLA restarted. | 1 |
| 8 | alter-line-item-qty {itemId,newQty:5,reason}. | HTTP 200; item alteredQty 5, quantity stays 10. | 1 |
| 9 | alter-line-item-qty with newQty 11 (above original 10). | HTTP 400 'Cannot increase quantity above original order quantity (10).' | 1 |
| 10 | alter-line-item-qty with newQty 0. | Observed HTTP 200 and alteredQty 0 (accepted). | 1 |
| 11 | alter-line-item-qty with newQty equal to the original (10). | HTTP 200; alteredQty removed (restored). | 1 |
| 12 | dispatch-action reject-order {reason:'cannot supply'} on order Y. | HTTP 200; status REJECTED; internalOrderNumber renamed 'rej_<date>_INT-...'; customer PO renamed 'rej_<date>_<ref>'. | 1 |
| 13 | Create a new order with the PO reference of the rejected order Y. | HTTP 201 (reference is free again). | 1 |
| 14 | dispatch-action hard-delete-order with the key. | HTTP 400 'Unauthorized: Only superusers or management can hard delete an order'. | 1 |
| 15 | dispatch-action with an unknown action name. | HTTP 400 'Unknown action: <name>'. | 1 |
| 16 | In the UI press Reject on a Logged order and confirm with a reason. | Order disappears from Logged list and shows as REJECTED (UI only). | 1 |

## Findings (observed behaviour, not fixed)

1. alter-line-item-qty accepts newQty 0.
2. toggle-hold via dispatch-action changes the status to IN_HOLD, while POST /orders/:id/hold only sets isHold: two different hold mechanisms.
