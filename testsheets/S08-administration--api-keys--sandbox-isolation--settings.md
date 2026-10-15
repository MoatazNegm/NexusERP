# S08 - Administration: API keys, sandbox isolation, settings

- **Scenario id / name:** S08 / Administration: API keys, sandbox isolation, settings
- **Role / user:** admin (password for all seed users: `Nexus#Test2026`)
- **Total points:** 17 (1 point per step, 17 steps)
- **Preconditions:**
  - Clean seed.
  - A customer 'S08 Live Cust' exists in Live (create as crm1).
- **Test data:**
  - API key name qa-key (owner admin)
  - Sandbox owner = admin (personal sandbox)
- **Live verification note:** Verified live 2026-10-15 (API): steps 1,2,3,4,5,6,11,13 (guide fetched, 24 KB). Steps 7-10, 12, 14 are UI/sandbox flows not executed here (backup endpoint answered HTTP 400 without parameters).

| Step No | Action | Expected success symptom | Points |
|---|---|---|---|
| 1 | Log in as admin, open Settings -> API Keys, create key 'qa-key' for admin. (API POST /api/v1/api-keys) | Key shown ONCE with prefix nex_...; badge 'Sandbox Only' (allowLive false); roles inherited [admin, management]. | 1 |
| 2 | List keys (GET /api/v1/api-keys). | Entry shows prefix, enabled true, allowLive false and no full secret. | 1 |
| 3 | Call GET /api/v1/customers with header x-api-key. | Returns [] : the key is forced into admin's personal sandbox, live data is not visible. | 1 |
| 4 | POST a customer 'S08 Sandbox Cust' with the key. | Created in the sandbox; Live customer list (x-user: admin) does NOT contain it. | 1 |
| 5 | Toggle 'Allow Live Data Access' on the key (PUT /api/v1/api-keys/:id {allowLive:true}). | Badge becomes 'Live Allowed'; subsequent calls with the key see Live data ('S08 Live Cust'). | 1 |
| 6 | Revoke the key (DELETE /api/v1/api-keys/:id). | Message 'API key revoked.'; using the key again returns HTTP 401. | 1 |
| 7 | Log in choosing 'My Own Sandbox (Test Admin)'. | Persistent sandbox banner shows with Reset Data, Revert to Login State, Exit Sandbox; data of Live is not visible. | 1 |
| 8 | In the sandbox press Reset Data and type RESET. | Sandbox business data cleared; users and groups preserved. | 1 |
| 9 | Try POST /api/v1/wipe while in sandbox mode. | Rejected: 'Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset.' | 1 |
| 10 | Press Exit Sandbox. | Returned to login screen, localStorage cleared. | 1 |
| 11 | As admin open GET /api/v1/admin/sandboxes. | List contains the admin sandbox with size and member count. | 1 |
| 12 | Open Settings -> modules and disable the Shipment module; log in as ship1. | Shipment menu disappears for ship1 (module off); re-enable restores it. | 1 |
| 13 | Download the REST API user guide (Help Center or GET /api/v1/user-guide?format=markdown). | Markdown document 'NexusERP RESTful API User Guide' downloads. | 1 |
| 14 | Create a full backup in Settings -> backups (GET /api/v1/full-backup with needed params). | An encrypted .nxarchive file is downloaded. | 1 |
| 15 | As admin list GET /api/v1/settings. | Settings JSON returned with enableNewOrderAlerts false in the seeded instance. | 1 |
| 16 | Enable new-order alerts with an SMTP host that is unreachable, create an order, and during the 60 s audit change the order (accept item, finalize study). | The order keeps the user change (status WAITING_SUPPLIERS) after the audit finishes: the audit merges only its own log/notification changes (regression for lost-update fix; timing-dependent, see Findings in README). | 1 |
| 17 | Start a fresh container with FACTORY_PASS and SMTP_* unset and read GET /api/v1/settings and try login username factory. | emailConfig.smtpServer is empty (no built-in SMTP account) and the factory emergency login is refused (disabled when FACTORY_PASS is unset). | 1 |
