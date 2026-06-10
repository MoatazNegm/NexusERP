# NexusVSC Development Guide

## Tech Stack
| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + PostCSS |
| Backend | Node.js + Express (server.js) |
| State | React Hooks (useState/useMemo/useEffect) — no external state library |
| Build | Vite (vite.config.ts) |
| I18n | Custom context-based (contexts/LanguageContext.tsx + locales/translations.ts) |
| DB | JSON file-based (db.json) via REST API |

## Directory Layout
`
components/          # Feature modules — one file per major business function
  FinanceModule.tsx       # Invoicing, payments, P&L, tax clearances
  TechnicalReviewModule.tsx  # Part history, BoM review, line-item qty alteration
  OrderManagement.tsx     # Order CRUD, item logging, status workflow
  ProcurementModule.tsx   # POs, supplier contracts, component sourcing
  InventoryModule.tsx     # Stock levels, reservations, manufacturing completion
  ShipmentModule.tsx      # Dispatch, POD, transit tracking
  GovEInvoiceModule.tsx   # Government e-invoice upload/tracking
  CRMModule.tsx           # Customers, contacts, opportunities (supports up to 3 secondary contacts + delivery address)
  FactoryModule.tsx       # Manufacturing floor operations
  DataMaintenance.tsx     # Settings, ledger accounts, thresholds, backups
  {Feature}Modal.tsx      # Action modals (OrderDetails, AddCustomer, etc.)
  SortableTable.tsx       # Reusable sortable/draggable data table
  ModuleGate.tsx          # Role-based access wrapper
  DashboardCard.tsx       # Reusable stat card

services/
  dataService.ts          # Central API client — all backend calls go here

types.ts                  # Shared TypeScript interfaces & enums
utils.ts                  # Runtime utilities (e.g. getItemEffectiveQty)
server.js                 # Express backend — REST API + business logic
constants.tsx             # App-wide constants (status maps, role configs)
contexts/
  LanguageContext.tsx     # I18n provider + hook
locales/
  translations.ts         # Translation keys
scripts/                  # One-off maintenance scripts (.cjs)
public/                   # Static assets served as-is
uploads/                  # User-uploaded files (PODs, invoices)
.postman/                 # Postman API collection and environment definitions
postman/                  # Postman workspace globals and shared resources
`

## Coding Patterns

### 1. Module-Per-Feature Architecture
Each business domain lives in a single large component file (e.g. FinanceModule.tsx). Modules are self-contained: they fetch their own data, manage local state, and render their own UI trees. Shared primitives (SortableTable, DashboardCard, ModuleGate) are extracted only when reused across >1 module.

### 2. Data Service Abstraction
All server communication routes through services/dataService.ts. Backend actions are dispatched as { orderId, action, payload } to a generic dispatchAction() endpoint. Never call fetch() directly from a component.

### 3. Quantity Alteration Convention
When a line item's quantity can be lowered post-creation, use alteredQty + alterationComment on the item. The helper getItemEffectiveQty(item) must be used everywhere revenue, fulfillment, or BoM scaling is calculated. Original quantity is never mutated.

### 4. Modal Action Pattern
User-initiated actions (record payment, issue PO, alter qty) open a local modal with draft state. The modal validates, calls dataService, then triggers a parent refresh via callback. Modals clean up on close.

### 5. Role-Based Gating & Schema Migrations
Every top-level module route checks `ModuleGate` against the user's role. **The actual list of available roles and their module mappings live in `db.json` (the `settings.availableRoles` and `settings.roleMappings` fields).** The frontend pulls them at runtime via API.

**Schema migrations are automated.** When you add or change roles, there is no need to manually edit `db.json` on every machine. Instead, you write a small migration function in `server.js` and bump `CURRENT_SCHEMA_VERSION`. The server automatically upgrades any `db.json` on startup (or after restore) by running the migration chain. Business data (orders, customers, etc.) is never touched.

When adding or modifying roles, follow these steps:
1. `types.ts` — Add the new role to the `UserRole` union type so TypeScript compiles.
2. `constants.tsx` — Add the role to `availableRoles` and update `roleMappings` (used as defaults for fresh installs).
3. `server.js` — **Add a migration function** in the `migrations` array that adds the role to `availableRoles` and sets its `roleMappings`. Then **increment `CURRENT_SCHEMA_VERSION`**.
4. `App.tsx` — If needed, wire the new module route and nav item (only needed for entirely new views, not new roles).

> ⚠️ **Important:** Do not edit `db.json` manually on any machine. The migration system handles it. If you restore an old backup, the server will auto-migrate it on the next startup.

### 6. Dashboard Reporting
The dashboard includes a PDF export feature (executive snapshot, status distribution, critical margin alerts, and customer/supplier summaries) restricted to the `management` role. Export logic lives in `App.tsx` and uses the `jspdf` library.

### 7. Status-Driven Workflow
Orders progress through a strict enum (OrderStatus in types.ts). Server-side dispatch actions enforce valid transitions. The frontend renders stage-specific UI based on order.status, not derived flags.

### 8. Backup Segregation
Full system archive (/api/v1/full-backup) excludes users and userGroups. Those are backed up separately via /api/v1/backup-users-groups ("Export Identities").

## Environment & Data Persistence

### `db.json` is Machine-Local
`db.json` contains all live data: users, user groups, settings, orders, customers, and uploaded file references. It is already listed in `.gitignore` and **must never be committed** to version control.

If you accidentally committed it earlier, remove it from git tracking (while keeping your local file):
```bash
git rm --cached db.json
git commit -m "Remove db.json from version control"
```

### How New Environments Are Bootstrapped
When the server starts and `db.json` is missing:
1. It first checks for `db.json.local.bak` (a safety copy created on every start).
2. If no backup exists, it copies `db.stub.json` as the initial database.

### Safe Update Workflow for Production
When pulling a new update on a production or staging machine:
1. Ensure `db.json` is not overwritten by the pull (it is `.gitignored`).
2. **Settings and roles are not automatically migrated.** If the update introduces a new role (e.g., `suppliers`), an admin must log into the application and update the settings via the UI (Settings → Roles), or run a data migration script if provided.
3. `db.stub.json` is the template for fresh installations. It should remain minimal and not contain any production data.

### Cloud Deployments & Persistent Volumes (e.g., Render)
In ephemeral hosting environments (like Render or Docker containers), the local disk is wiped on every deploy/restart. To prevent data loss:
1. **Mount a Persistent Volume:** Add a persistent volume (e.g. at `/data`) in your cloud provider's console.
2. **Set Environment Variables:** Define the following variables to point to the mounted volume:
   - `DB_PATH=/data/db.json` (stores the database settings, users, and orders on the persistent volume)
   - `UPLOADS_PATH=/data/uploads` (stores uploaded files and logos on the persistent volume)
   
This configuration decouples application code updates from your database and file assets.

### `db.stub.json` Template
The `db.stub.json` file should only contain the empty structure for a fresh database. Do not add production data, users, or custom settings to it.

### Sensitive Data Encryption (LLM Tokens, SMTP Password)
Sensitive API keys and passwords are protected using AES-256-CBC encryption at rest in `db.json`. The encryption key is derived from the factory server passphrase (`FACTORY_PASS`) and should **never** be changed once the system is in production, as it would render existing encrypted values unreadable.

**Encrypted fields:**
- `settings.geminiConfig.apiKey`
- `settings.openaiConfig.apiKey`
- `settings.emailConfig.password`

**How it works:**
- **On read (GET /api/v1/settings):** The server decrypts these fields before sending them to the frontend so the app can use the keys.
- **On write (PUT/POST /api/v1/settings):** The server encrypts these fields before saving them to `db.json`.
- **On backup (/api/v1/backup):** Settings remain encrypted in the backup file; they are **not** decrypted for export.
- **On restore (/api/v1/restore):** The server checks if incoming values are already encrypted (skips re-encryption if they are) or encrypts plaintext values. This makes restore idempotent and safe.
- **On full-backup (/api/v1/full-backup):** The entire archive is encrypted with the user's passcode using AES-256-GCM. On full-restore, the archive is decrypted and extracted as-is (settings remain encrypted on disk).

### VITE_BACKEND_URL Configuration
The frontend uses `VITE_BACKEND_URL` to determine the API base URL. It defaults to an empty string, which causes all requests to use relative paths (same origin).

**Development:**
- Vite dev server runs on port `3005` and proxies `/api` to `http://localhost:3006` (see `vite.config.ts`).
- No need to set `VITE_BACKEND_URL` in local development if the backend runs on port `3006`.

**Production (e.g. Render):**
- The Express server (`server.js`) serves the built frontend from `dist/` on the same origin.
- Leave `VITE_BACKEND_URL` unset (or set to `''`). The `render.yaml` `startCommand` is `node server.js`.
- If you ever deploy the frontend and backend on **separate origins**, set `VITE_BACKEND_URL` to the backend origin (e.g. `https://api.example.com`).

## Adding a New Feature
1. Component: Create components/{Feature}Module.tsx (or Modal.tsx if it's an action).
2. Types: Add interfaces to types.ts. Export runtime helpers alongside interfaces if needed.
3. Service: Add API methods to dataService.ts.
4. Server: Add dispatch action cases to server.js.
5. Constants: Register role mapping in constants.tsx.
6. **Database (`db.json`):** If the feature involves new roles or settings, update the actual database settings object. This is the **authoritative runtime source** — if skipped, the feature will not appear on this machine even though the code is correct.
7. Router: Wire the component + ModuleGate into App.tsx.

## Key Files to Read First
- types.ts — Domain model
- server.js (lines 1-300) — Dispatch router + action patterns
- services/dataService.ts — API surface
- constants.tsx — Status colors, role definitions, module config