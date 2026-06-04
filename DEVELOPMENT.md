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
  CRMModule.tsx           # Customers, contacts, opportunities
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

### 5. Role-Based Gating
Every top-level module route checks ModuleGate against the user's role. New features must add their role mapping to constants.tsx.

**Important:** The application reads roles and role mappings from the database (`db.json`), which overrides the frontend constants. When adding or modifying roles, you must update the following files in this order:
1. `types.ts` — Add the new role to the `UserRole` union type.
2. `constants.tsx` — Add the role to `availableRoles` and update `roleMappings`.
3. `server.js` — Update the fallback `availableRoles` and `roleMappings` in the `getSettings()` function.
4. `db.json` — Update the actual database settings object to include the new role and mappings. This is the authoritative source.

### 6. Status-Driven Workflow
Orders progress through a strict enum (OrderStatus in types.ts). Server-side dispatch actions enforce valid transitions. The frontend renders stage-specific UI based on order.status, not derived flags.

### 7. Backup Segregation
Full system archive (/api/v1/full-backup) excludes users and userGroups. Those are backed up separately via /api/v1/backup-users-groups ("Export Identities").

## Adding a New Feature
1. Component: Create components/{Feature}Module.tsx (or Modal.tsx if it's an action).
2. Types: Add interfaces to types.ts. Export runtime helpers alongside interfaces if needed.
3. Service: Add API methods to dataService.ts.
4. Server: Add dispatch action cases to server.js.
5. Constants: Register role mapping in constants.tsx.
6. Database: If the feature involves new roles or settings, update db.json (the authoritative source).
7. Router: Wire the component + ModuleGate into App.tsx.

## Key Files to Read First
- types.ts — Domain model
- server.js (lines 1-300) — Dispatch router + action patterns
- services/dataService.ts — API surface
- constants.tsx — Status colors, role definitions, module config