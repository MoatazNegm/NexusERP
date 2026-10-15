# S01 - Login, roles and menu visibility

- **Scenario id / name:** S01 / Login, roles and menu visibility
- **Role / user:** admin, then sales1 / planner1 / proc1 / inv1 / fin1 / factory1 / ship1 / crm1 / mgmt1 (password for all seed users: `Nexus#Test2026`)
- **Total points:** 24 (1 point per step, 24 steps)
- **Preconditions:**
  - Container nexuserp is running (http://<host>:5005); run testsheets/reset-testdata.sh for a clean seed.
  - Seed users exist (password for all: Nexus#Test2026).
- **Test data:**
  - admin = roles admin+management; sales1 = order_management; planner1 = planning; proc1 = procurement; inv1 = inventory; fin1 = finance; factory1 = factory; ship1 = shipment; crm1 = crm; mgmt1 = management
  - New user to create: qa.temp / Temp#12345 / role procurement
- **Live verification note:** Live API equivalents run 2026-10-15 against nexuserp: steps 2,3,4,5,9-17 (role lists from login response),18,20,22,23 (HTTP codes and bodies as written). UI-only steps (1,6,7,8,9-17 menu rendering,19,21,24) derived from App.tsx role mapping and not rendered in a browser here.

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | Open http://<host>:5005/ in a browser. | Login screen shows Username and Password fields and an environment selector. HTTP 200 for GET /. | 1 |
| 2 | Type username `admin` in the Username field (do not submit yet). | Environment list appears with 'Live ERP (Production)' and 'My Own Sandbox (Test Admin)'. API: GET /api/v1/auth/environments?username=admin returns both. | 1 |
| 3 | Select 'Live ERP (Production)', enter a WRONG password for admin, press Login. | Login is refused with message 'Invalid username or password'; you stay on the login screen (API: POST /api/v1/login -> HTTP 401). | 1 |
| 4 | Enter username `nouser` with any password, environment Live, press Login. | Same message 'Invalid username or password' (no hint whether the user exists), HTTP 401. | 1 |
| 5 | Enter username `ADMIN` (upper case) with the correct password, environment Live. | Login succeeds: user names are case-insensitive; response contains roles [admin, management] and NO password field. | 1 |
| 6 | After login as admin, look at the left navigation. | Items visible: Dashboard, Order Management, Technical Review, Finance Operations, Procurement, Factory Build, Inventory & Hub, Shipment, CRM Contacts, Suppliers, Profitability, Gov.EInvoice, System Audit, Help Center, Settings. ('Minimums' is NOT shown: it needs a group named Managers/superusers). | 1 |
| 7 | Scroll to the bottom of any page. | Application version footer (e.g. 1.0001095) is displayed. | 1 |
| 8 | Click logout. | Login screen is shown again; browser localStorage key `nexus_user` is removed; Back button does not re-enter the app. | 1 |
| 9 | Log in as `sales1`. | Navigation shows only Order Management and Help Center. | 1 |
| 10 | Log out, log in as `planner1`. | Navigation shows only Technical Review and Help Center. | 1 |
| 11 | Log out, log in as `proc1`. | Navigation shows Procurement, Suppliers and Help Center. | 1 |
| 12 | Log out, log in as `inv1`. | Navigation shows Inventory & Hub and Help Center. | 1 |
| 13 | Log out, log in as `fin1`. | Navigation shows Finance Operations and Help Center. | 1 |
| 14 | Log out, log in as `factory1`. | Navigation shows Factory Build and Help Center. | 1 |
| 15 | Log out, log in as `ship1`. | Navigation shows Shipment and Help Center (module 'shipping' is enabled by the seed). | 1 |
| 16 | Log out, log in as `crm1`. | Navigation shows CRM Contacts and Help Center. | 1 |
| 17 | Log out, log in as `mgmt1`. | Navigation shows Dashboard, Profitability and Help Center. | 1 |
| 18 | Log in as `admin`, open Settings -> user management, add user `qa.temp`, name 'QA Temp', e-mail qa.temp@test.local, password `Temp#12345`, role Procurement, save. (API: POST /api/v1/users as admin) | User is saved and listed with role procurement; the password is not shown in the list. | 1 |
| 19 | Log out, log in as `qa.temp` / `Temp#12345`. | Login succeeds; navigation shows Procurement, Suppliers, Help Center. | 1 |
| 20 | Log in as admin, edit `qa.temp`, add role CRM, save. (API: PUT /api/v1/users/:id {roles:[procurement,crm]}); log in again as qa.temp. | After re-login CRM Contacts is also visible. | 1 |
| 21 | As `sales1` call API GET /api/v1/users (or open Settings via URL/UI). | UI: no Settings item and any attempt to open it is redirected to the first allowed view (Order Management). API: list is returned WITHOUT password fields. | 1 |
| 22 | As `sales1` call GET /api/v1/api-keys. | HTTP 403 {"error":"Admin privileges are required to manage API keys."} | 1 |
| 23 | As `sales1` call GET /api/v1/admin/sandboxes. | HTTP 403 {"error":"Access restricted to administrators."} | 1 |
| 24 | Open Help Center as any role. | Help Center opens (visible to every role); Developer API card offers the REST API user guide download. | 1 |
