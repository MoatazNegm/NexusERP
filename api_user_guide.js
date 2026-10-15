// ============================================================================
// NexusERP RESTful API User Guide & Specification
// Comprehensive documentation covering all business domains, UI functions,
// authentication, sandboxing, and operational state machine dispatch actions.
// ============================================================================

const API_VERSION = 'v1';
const BASE_URL = '/api/v1';

const API_USER_GUIDE_MARKDOWN = `# NexusERP RESTful API User Guide

**Version:** 1.0 (${API_VERSION})  
**Base URL:** \`/api/v1\`  
**Protocol:** HTTP/1.1 & HTTPS  
**Data Format:** \`application/json\` (Multipart for file uploads)

---

## 1. Overview & Architecture

NexusERP provides a complete, programmatic RESTful API that covers every functional capability, field, button, and state transition available across the Web UI. External systems, automated test suites, CI/CD runners, and client scripts can execute all business workflows end-to-end.

### Key Capabilities
- **Order Management & Blanket Orders:** Full lifecycle management from draft/logged order entry through Technical Review, BoM sourcing, production, invoicing, and delivery.
- **Internal Stock Orders:** Dedicated internal stock creation, component allocation, and warehouse auto-fulfillment.
- **Technical Review & BoM Engineering:** Bill-of-Materials composition, component acceptance/rejection, stock component allocation, and cost-sheet analysis.
- **Procurement & Sourcing:** Multi-vendor RFPs, competitive tender awarding, PO issuance, delivery extension amendments, and cancellations.
- **Warehouse & Inventory:** Stock item management, goods reception, Product Hub management, and stock movements.
- **Manufacturing Execution:** Shop floor production tracking, batch consumption, and stage-by-stage progress recording.
- **Shipment & Delivery Logistics:** Release approval, line-item shipping, Proof of Delivery (POD) image upload, and delivery confirmation.
- **Finance & Accounting:** Customer invoicing, payment recording, customer project wallets, supplier payments, tax clearances, WHT certificates, and general ledger entries.
- **CRM & Customer Operations:** Customer directory, merge operations, credit holds, and profitability margins.
- **Suppliers & Vendor Catalogs:** Vendor profiles, part price lists, and compliance blacklisting.
- **Government E-Invoicing:** Document submission, clearance, and PDF/XML attachments.
- **AI Strategic Proxy:** Model invocation for document OCR, intelligent analysis, and data extraction.
- **System Administration & Sandboxes:** User administration, role-based groups, streaming AES-256 encrypted backups, and isolated multi-tenant sandboxes.

---

## 2. Authentication & Identity Headers

Every API request requires client identification. Authentication can be performed using admin-generated API tokens or session headers.

### Supported Headers

| Header | Description | Required | Example |
|---|---|---|---|
| \`x-api-key\` | Secret API token generated in **Settings → API Keys**. | Recommended for machine/API calls | \`nex_K7x9...2A\` |
| \`Authorization\` | Standard Bearer token authentication containing the API key. | Alternative to \`x-api-key\` | \`Bearer nex_K7x9...2A\` |
| \`x-user\` | Username of the calling identity. Auto-populated when using an API token. | Required if not using API token | \`admin\` |
| \`x-sandbox-owner\` | Target sandbox environment owner. | Optional (governed by sandbox security rules) | \`john\` |

---

## 3. Sandboxing & Live Data Protection

NexusERP includes strict safety guards to protect live enterprise production data while providing safe test environments.

### Default Sandbox-Only Enforcement
- **Inherited User Roles:** Every API token generated is automatically granted all the roles of its linked user account (e.g. \`admin\`, \`procurement\`, \`sales\`, \`finance\`, \`warehouse\`, \`logistics\`).
- **Sandbox-Only by Default:** When an API token is created, the **"Allow Live Data Access"** flag is **UNSET (\`false\`) by default**.
- **Enforced Sandbox Routing:** When \`allowLive\` is unset, **ANY call made with this API token is strictly routed to the linked user's private sandbox (\`db.sandbox.<username>.json\`)**.
  - Even if the request did not specify an \`x-sandbox-owner\` header (which normally defaults to live data).
  - Even if the request explicitly requested live data or another environment.
  - The server automatically provisions the user's sandbox file on the first request if it does not already exist.

### Live Data Access (When Checkmark is Set)
- An administrator can check **"Allow Live Data Access"** during API key creation or toggle it on an existing key.
- When \`allowLive: true\`:
  - If no \`x-sandbox-owner\` header is passed, the request operates on **Live ERP Data** (\`db.json\`).
  - If \`x-sandbox-owner: <target>\` is passed, the request routes to that specific team member's sandbox.

---

## 4. Universal User Guide API

To programmatically inspect or download this user guide, use the dedicated user guide endpoint:

### \`GET /api/v1/user-guide\`
Fetches the complete RESTful API user guide.

**Query Parameters:**
- \`format\` (string, optional): \`markdown\` (default), \`json\`, or \`text\`.
- \`download\` (boolean, optional): \`true\` or \`1\` to trigger a file download attachment.

**Example Request:**
\`\`\`bash
curl -H "x-api-key: nex_..." "http://localhost:5005/api/v1/user-guide?format=markdown&download=true" -o NexusERP_API_Guide.md
\`\`\`

### \`GET /api/v1/user-guide/download\`
Direct download link that streams \`NexusERP_RESTful_API_User_Guide.md\` with \`Content-Disposition: attachment\`.

### Client SDK Method:
In frontend components or node scripts:
\`\`\`typescript
import { dataService } from './services/dataService';

// Download markdown user guide in browser:
await dataService.get_user_guide('markdown', true);

// Fetch parsed JSON specification:
const apiGuide = await dataService.get_user_guide('json', false);
\`\`\`

---

## 5. Endpoints by Business Domain

### 5.1. Authentication & API Key Management

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/login\` | Authenticate via username/password or API key. Supports target environments (\`live\`, \`self\`, \`<username>\`). |
| \`GET\` | \`/api/v1/auth/environments\` | List available environments for a given username (\`?username=...\`). |
| \`GET\` | \`/api/v1/api-keys\` | List all active API keys (Admin only). Returns \`id\`, \`name\`, \`username\`, \`prefix\`, \`allowLive\`, \`roles\`, \`enabled\`. |
| \`POST\` | \`/api/v1/api-keys\` | Generate new API key. Body: \`{ name, username?, allowLive?: boolean }\`. Full secret returned only once. |
| \`PUT\` | \`/api/v1/api-keys/:id\` | Update key attributes. Body: \`{ name?, enabled?: boolean, allowLive?: boolean }\`. |
| \`DELETE\` | \`/api/v1/api-keys/:id\` | Revoke an API key immediately. |

---

### 5.2. Order Management & Contracts

#### Standard CRUD
| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/orders\` | Retrieve all orders with calculated health and SLA status. |
| \`GET\` | \`/api/v1/orders/:id\` | Retrieve single order with item details, BoM, and audit log. |
| \`POST\` | \`/api/v1/orders\` | Create new order (standard customer order, internal stock order, or blanket contract). |
| \`PUT\` | \`/api/v1/orders/:id\` | Update order fields. Unlocks Technical Review if rolled back. |
| \`DELETE\` | \`/api/v1/orders/:id\` | Remove order. |
| \`POST\` | \`/api/v1/orders/:id/items\` | Add a line item directly to an existing order. |
| \`PUT\` | \`/api/v1/orders/:id/items/:itemId\` | Update a specific line item in an order. |
| \`DELETE\` | \`/api/v1/orders/:id/items/:itemId\` | Remove a line item from an order. |
| \`POST\` | \`/api/v1/orders/:id/hold\` | Toggle or set hold on an order (\`{ isHold: boolean, holdReason?: string }\`). |

#### Blanket Contracts
| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/contracts\` | List all blanket contract agreements. |
| \`POST\` | \`/api/v1/contracts\` | Create new blanket contract agreement. |
| \`PUT\` | \`/api/v1/contracts/:id\` | Update blanket contract agreement. |
| \`DELETE\` | \`/api/v1/contracts/:id\` | Delete blanket contract agreement (guarded against active linked orders). |

#### Order Dispatch State Machine (\`POST /api/v1/orders/:id/dispatch-action\`)
Every state transition and operational mutation uses this endpoint:
\`\`\`json
{
  "action": "<action-name>",
  "payload": { ... }
}
\`\`\`

**Available Actions:**
- \`finalize-study\`: Finalize Technical Review; transitions order to \`WAITING_SUPPLIERS\`.
- \`rollback-to-logged\`: Rollback order to \`LOGGED\` status for logging team review; freezes Technical Review with lock badge until updated.
- \`toggle-acceptance\`: Toggle item acceptance in Technical Review (\`{ itemId, isAccepted }\`).
- \`set-production-type\`: Switch item production mode (\`{ itemId, productionType: 'MANUFACTURED' | 'TRADING' }\`).
- \`allocate-stock-component\`: Allocate stock components from internal stock orders (\`{ targetItemId, compDescription, quantity, stockOrderId, stockItemId, stockCompId }\`).
- \`add-component\`: Add BoM component to an order item (\`{ itemId, component: { description, quantity, unitCost, unit, ... } }\`).
- \`update-component\`: Update existing BoM component (\`{ itemId, componentId, updates: { ... } }\`).
- \`remove-component\`: Remove component from BoM (\`{ itemId, componentId }\`).
- \`alter-line-item-qty\`: Alter line item quantity with automatic BoM and price scaling (\`{ itemId, newQuantity }\`).
- \`reject-order\`: Reject customer order (\`{ reason }\`); safely releases any received goods to general warehouse stock.
- \`toggle-hold\`: Toggle hold status on order (\`{ isHold, reason }\`).
- \`release-margin\`: Authorize margin breach approval for orders blocked by customer minimum margin policy.
- \`convert-to-stock-order\`: Convert external order into an internal stock replenishment order.
- \`hard-delete-order\`: Permanent deletion (Admin role required).

---

### 5.3. Technical Review & Sourcing BoM

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/upload-cost-sheet\` | Upload binary Excel/PDF cost sheet (\`multipart/form-data\`, field: \`costSheet\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'upload-cost-sheet'\`) | Associate uploaded cost sheet to order item (\`{ itemId, costSheetFile, workingResourceCount, realCost, invoiceTotal, cells }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'update-cost-sheet-text'\`) | Update cost sheet text or metadata notes. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'delete-cost-sheet-record'\`) | Delete latest cost sheet and restore previous revision metrics. |

---

### 5.4. Procurement & Sourcing Operations

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/procurement/history\` | Search cross-order procurement history by \`description\` or \`partNumber\`. |
| \`GET\` | \`/api/v1/procurement/unique-po-number\` | Pre-generate the next unique PO number (\`PO-YYYY-XXXX\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'send-rfp-batch'\`) | Send RFP to selected suppliers (\`{ componentIds, supplierIds, rfpNotes }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'award-tender-batch'\`) | Award winning supplier quotes (\`{ awards: [{ componentId, supplierId, unitCost, currency, deliveryLeadDays }] }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'issue-po-batch'\`) | Generate and issue PO to supplier (\`{ awards: [...], poNumber, paymentTermsDays, downPaymentPct }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'amend-po-extension'\`) | Amend supplier PO delivery date extension (\`{ componentIds, extendedDeliveryDate, amendmentReason }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'cancel-component-po'\`) | Cancel single component PO (\`{ componentId, cancelReason }\`). Safely transfers received items to free warehouse stock. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'cancel-po-batch'\`) | Cancel entire PO batch. Safely transfers received goods to free stock and rolls back order status. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'revert-po'\`) | Revert PO back to awarded/tender state (\`{ poNumber, reason }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'revive-contract'\`) | Revive expired or cancelled component contract. |

---

### 5.5. Warehouse & Inventory Management

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/inventory\` | List all inventory items with quantities, reserved quantities, and bin locations. |
| \`GET\` | \`/api/v1/inventory/:id\` | Retrieve single inventory item and stock card transaction movements. |
| \`POST\` | \`/api/v1/inventory\` | Create new inventory SKU (\`{ name, sku, quantity, minThreshold, binLocation, unitCost }\`). |
| \`PUT\` | \`/api/v1/inventory/:id\` | Update inventory SKU parameters. |
| \`DELETE\` | \`/api/v1/inventory/:id\` | Delete inventory SKU. |
| \`POST\` | \`/api/v1/inventory/adjust\` | Adjust inventory stock levels directly (\`{ id?, sku?, delta: number, reason: string }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'receive-component'\`) | Receive component into warehouse stock (\`{ itemId, componentId, quantityReceived, binLocation, batchNumber }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'receive-hub'\`) | Receive complete trading goods into Product Hub. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'receive-hub-partial'\`) | Receive partial quantity into Product Hub (\`{ itemId, qty }\`). |

---

### 5.6. Manufacturing Execution (Factory)

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'start-production'\`) | Start manufacturing floor execution; moves order to \`MANUFACTURING\`. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'register-manufacturing'\`) | Log production progress, batch notes, or stage completions. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'consume-factory-component'\`) | Record raw material consumption or scrap on factory floor (\`{ componentId, quantityConsumed, scrapQty }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'finish-production'\`) | Finalize production run; transitions order to \`READY_FOR_DELIVERY\`. |

---

### 5.7. Shipping & Logistics

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'release-delivery'\`) | Authorize shipment release. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'approve-dispatch-receipt'\`) | Finance approval for delivery release. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'ship-items'\`) | Mark items as in-transit with carrier & tracking details (\`{ carrier, trackingNumber, dispatchedItems }\`). |
| \`POST\` | \`/api/upload-pod\` | Upload Proof of Delivery (POD) document/photo (\`multipart/form-data\`, field: \`pod\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'confirm-delivery'\`) | Confirm delivery to customer with POD image URL; moves order to \`DELIVERED\`. |

---

### 5.8. Finance, Invoicing & Payments

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'issue-invoice'\`) | Issue formal customer invoice (\`{ invoiceNumber, invoiceDate, taxRate, notes }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'cancel-invoice'\`) | Void customer invoice. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'record-payment'\`) | Record customer payment (\`{ amount, paymentMethod, referenceNumber, receiptNumber, bankAccount }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'cancel-payment'\`) | Cancel previously recorded payment transaction (\`{ paymentId, reason }\`). |
| \`POST\` | \`/api/v1/customers/:id/advance-payment\` | Record advance customer deposit into general project wallet (\`{ amount, referenceNumber, notes }\`). |
| \`GET\` | \`/api/v1/project-wallets\` | Retrieve customer project wallet balances, order allocations, and available credits. |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'settle-blanket-order'\`) | Settle commercial blanket contract against settling order (\`{ settlingOrderId }\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'financial-request'\`) | Submit financial payment/funding request for blanket contract (\`{ memo, amount, settlingOrderId }\`). |
| \`GET\` | \`/api/v1/supplierPayments\` | List supplier payments across all orders. |
| \`POST\` | \`/api/v1/supplierPayments\` | Record supplier payment (\`{ supplierId, amount, poNumber, paymentMethod, referenceNumber }\`). |
| \`GET\` | \`/api/v1/supplier-ledger/:supplierId\` | Retrieve comprehensive transactional ledger for a specific supplier. |
| \`GET\` | \`/api/v1/ledger\` | List general ledger entries. |
| \`POST\` | \`/api/v1/ledger\` | Record manual general ledger journal entry. |
| \`POST\` | \`/api/upload-wht-certificate\` | Upload Withholding Tax (WHT) certificate file (\`multipart/form-data\`). |
| \`POST\` | \`/api/upload-supplier-receipt\` | Upload supplier tax payment receipt (\`multipart/form-data\`). |

---

### 5.9. CRM & Customer Operations

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/customers\` | List all customers with computed wallet balances and overdue indicators. |
| \`GET\` | \`/api/v1/customers/:id\` | Retrieve single customer profile and order history. |
| \`POST\` | \`/api/v1/customers\` | Register new customer profile (\`{ name, email, phone, taxNumber, address, minimumProfitMargin? }\`). |
| \`PUT\` | \`/api/v1/customers/:id\` | Update customer profile, minimum profit margin, or credit limit. |
| \`DELETE\` | \`/api/v1/customers/:id\` | Delete customer record. |
| \`POST\` | \`/api/v1/customers/merge\` | Merge duplicate customer records (\`{ sourceCustomerId, targetCustomerId }\`). |
| \`POST\` | \`/api/v1/customers/:id/hold\` | Toggle credit/operational hold on customer (\`{ isHold: boolean, holdReason?: string }\`). |

---

### 5.10. Suppliers & Price Lists

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/suppliers\` | List all registered suppliers and vendor catalogs. |
| \`POST\` | \`/api/v1/suppliers\` | Register new supplier (\`{ name, contactPerson, email, phone, category, priceList: [] }\`). |
| \`PUT\` | \`/api/v1/suppliers/:id\` | Update supplier details. |
| \`DELETE\` | \`/api/v1/suppliers/:id\` | Delete supplier. |
| \`POST\` | \`/api/v1/suppliers/:id/parts\` | Add catalog part to supplier price list (\`{ partNumber, description, unitCost, currency, leadTimeDays }\`). |
| \`PUT\` | \`/api/v1/suppliers/:id/parts/:partId\` | Update catalog part pricing or parameters. |
| \`DELETE\` | \`/api/v1/suppliers/:id/parts/:partId\` | Remove part from supplier (moves to immutable Deleted Suppliers vault). |
| \`POST\` | \`/api/v1/suppliers/:id/blacklist\` | Blacklist or remove blacklist on vendor (\`{ isBlacklisted: boolean, blacklistReason?: string }\`). |

---

### 5.11. Government E-Invoicing

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'request-einvoice'\`) | Request tax authority e-invoice clearance. |
| \`POST\` | \`/api/upload-einvoice\` | Upload official government XML/PDF e-invoice document (\`multipart/form-data\`). |
| \`POST\` | \`/api/v1/orders/:id/dispatch-action\` (\`action: 'attach-einvoice'\`) | Attach cleared e-invoice document UUID and URL to order (\`{ einvoiceUrl, submissionUuid }\`). |

---

### 5.12. AI Strategic Assistant & OCR

| Method | Endpoint | Description |
|---|---|---|
| \`POST\` | \`/api/v1/ai-proxy/chat\` | Proxy AI model completion requests (Gemini or OpenAI-compatible backends) with OCR scanning support. Body: \`{ endpoint, apiKey, payload }\`. |

---

### 5.13. System Administration & Sandboxes

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/v1/settings\` | Retrieve system thresholds, SLA hours, and configuration (sensitive keys auto-decrypted). |
| \`PUT\` | \`/api/v1/settings/:id\` | Update system settings & thresholds (AES-256 encrypted on save). |
| \`GET\` | \`/api/v1/users\` | List all users with assigned roles and group memberships (passwords omitted). |
| \`POST\` | \`/api/v1/users\` | Create user account (\`{ username, password, name, email, roles, groupIds, liveAccess? }\`). |
| \`PUT\` | \`/api/v1/users/:id\` | Update user profile, roles, or password. Auto-syncs to all sandboxes. |
| \`DELETE\` | \`/api/v1/users/:id\` | Delete user account. |
| \`GET\` | \`/api/v1/userGroups\` | List user groups and granular permission flags. |
| \`POST\` | \`/api/v1/userGroups\` | Create user group (\`{ name, roles, permissions }\`). |
| \`PUT\` | \`/api/v1/userGroups/:id\` | Update user group. |
| \`DELETE\` | \`/api/v1/userGroups/:id\` | Delete user group. |
| \`GET\` | \`/api/v1/admin/sandboxes\` | List all user and team sandboxes with disk size and member counts (Admin only). |
| \`POST\` | \`/api/v1/admin/switch-sandbox\` | Switch admin session into a target sandbox. |
| \`POST\` | \`/api/v1/sandbox/reset\` | Reset current sandbox to initial stub state. |
| \`GET\` | \`/api/v1/sandbox/:owner/members\` | List team members invited to a team sandbox. |
| \`POST\` | \`/api/v1/sandbox/:owner/members\` | Grant sandbox access to user (\`{ username }\`). |
| \`DELETE\` | \`/api/v1/sandbox/:owner/members/:username\` | Revoke sandbox access from user. |
| \`GET\` | \`/api/v1/full-backup\` | Stream full encrypted system backup (\`.nxarchive\` v2 with AES-256-GCM). |
| \`POST\` | \`/api/v1/full-restore\` | Restore full system from backup stream (Admin only). |

---

## 6. Code Examples

### 6.1. Creating an Order (cURL)
\`\`\`bash
curl -X POST http://localhost:5005/api/v1/orders \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: nex_YOUR_API_KEY" \\
  -d '{
    "customerName": "Acme Industrial Corp",
    "customerReferenceNumber": "PO-2026-9912",
    "orderDate": "2026-10-14",
    "status": "LOGGED",
    "currency": "USD",
    "paymentTermsDays": 30,
    "items": [
      {
        "description": "Heavy Duty Valve Assembly",
        "quantity": 10,
        "pricePerUnit": 450.00,
        "unit": "pcs",
        "components": [
          {
            "description": "Cast Steel Housing",
            "quantity": 10,
            "unitCost": 120.00,
            "unit": "pcs",
            "status": "NEW"
          }
        ]
      }
    ]
  }'
\`\`\`

### 6.2. Transitioning Order to Sourcing (Python)
\`\`\`python
import requests

API_KEY = "nex_YOUR_API_KEY"
BASE_URL = "http://localhost:5005/api/v1"
headers = {
    "x-api-key": API_KEY,
    "Content-Type": "application/json"
}

# 1. Finalize Technical Review
order_id = "orders_1740000000000"
response = requests.post(
    f"{BASE_URL}/orders/{order_id}/dispatch-action",
    headers=headers,
    json={"action": "finalize-study", "payload": {}}
)

print(response.json())
\`\`\`

### 6.3. Sourcing with Batch RFP and Tender Award (Node.js)
\`\`\`javascript
const fetch = require('node-fetch');

const headers = {
  'x-api-key': 'nex_YOUR_API_KEY',
  'Content-Type': 'application/json'
};

async function awardSourcing(orderId, componentId, supplierId, unitCost) {
  const res = await fetch(\`http://localhost:5005/api/v1/orders/\${orderId}/dispatch-action\`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'award-tender-batch',
      payload: {
        awards: [{
          componentId,
          supplierId,
          unitCost,
          currency: 'USD',
          deliveryLeadDays: 7
        }]
      }
    })
  });
  return res.json();
}
\`\`\`

---

## 7. Status Reference & Validation Rules

### Order Status Flow
\`\`\`
LOGGED
  ↓ (finalize-study)
WAITING_SUPPLIERS
  ↓ (issue-po-batch)
WAITING_PARTS
  ↓ (receive-component / receive-hub)
WAITING_FACTORY / READY_FOR_PRODUCTION
  ↓ (start-production)
MANUFACTURING
  ↓ (finish-production)
READY_FOR_DELIVERY
  ↓ (ship-items)
IN_TRANSIT
  ↓ (confirm-delivery)
DELIVERED
  ↓ (issue-invoice)
INVOICED
\`\`\`

### Hard Business Validation Rules
1. **Uniqueness:** Customer PO Reference (\`customerReferenceNumber\`) must be unique per customer. Internal Order Number (\`internalOrderNumber\`) must be globally unique across all active orders.
2. **Rollback Lock:** When rolled back to \`LOGGED\` (\`rollback-to-logged\`), Technical Review is locked until the Order Management team updates the order via \`PUT /api/v1/orders/:id\`.
3. **Margin Enforcement:** If an order breaches the customer minimum profit margin, it is blocked with \`isMarginBlocked: true\` and requires \`release-margin\` authorization by a user with \`management\` or \`admin\` role.
4. **Stock Auto-Release:** Cancelling a PO (\`cancel-po-batch\` / \`cancel-component-po\`) or rejecting an order automatically releases any already-received items into general free warehouse stock.
`;

const API_USER_GUIDE_JSON = {
  title: 'NexusERP RESTful API Specification & User Guide',
  version: '1.0',
  apiVersion: API_VERSION,
  baseUrl: BASE_URL,
  authentication: {
    methods: [
      { type: 'Header', name: 'x-api-key', description: 'Secret API token generated in Settings > API Keys' },
      { type: 'Bearer', name: 'Authorization', description: 'Bearer <api-key> format' },
      { type: 'Header', name: 'x-user', description: 'Username header for authenticated identity' },
      { type: 'Header', name: 'x-sandbox-owner', description: 'Multi-tenant sandbox routing header' }
    ],
    sandboxing: {
      defaultMode: 'sandbox_only',
      description: 'API tokens inherit all roles of the linked user account but operate strictly in the user sandbox by default unless allowLive is explicitly checked.',
      liveDataFlag: 'allowLive'
    }
  },
  endpoints: [
    {
      domain: 'System Documentation',
      routes: [
        { method: 'GET', path: '/api/v1/user-guide', description: 'Returns complete RESTful API user guide in markdown, JSON, or downloadable file' },
        { method: 'GET', path: '/api/v1/user-guide/download', description: 'Direct file download of user guide attachment' }
      ]
    },
    {
      domain: 'Authentication & API Keys',
      routes: [
        { method: 'POST', path: '/api/v1/login', description: 'Authenticate user via password or API key for target environment' },
        { method: 'GET', path: '/api/v1/auth/environments', description: 'List available environments for user' },
        { method: 'GET', path: '/api/v1/api-keys', description: 'List API keys with allowLive status and roles' },
        { method: 'POST', path: '/api/v1/api-keys', description: 'Generate API key with allowLive checkbox (default false)' },
        { method: 'PUT', path: '/api/v1/api-keys/:id', description: 'Toggle enabled or allowLive state on API key' },
        { method: 'DELETE', path: '/api/v1/api-keys/:id', description: 'Revoke API key' }
      ]
    },
    {
      domain: 'Orders & Contracts',
      routes: [
        { method: 'GET', path: '/api/v1/orders', description: 'List orders' },
        { method: 'GET', path: '/api/v1/orders/:id', description: 'Get order details' },
        { method: 'POST', path: '/api/v1/orders', description: 'Create order (standard, stock, blanket, settling)' },
        { method: 'PUT', path: '/api/v1/orders/:id', description: 'Update order' },
        { method: 'DELETE', path: '/api/v1/orders/:id', description: 'Delete order' },
        { method: 'POST', path: '/api/v1/orders/:id/dispatch-action', description: 'Execute state machine dispatch actions' },
        { method: 'POST', path: '/api/v1/orders/:id/items', description: 'Add line item' },
        { method: 'PUT', path: '/api/v1/orders/:id/items/:itemId', description: 'Update line item' },
        { method: 'DELETE', path: '/api/v1/orders/:id/items/:itemId', description: 'Delete line item' },
        { method: 'POST', path: '/api/v1/orders/:id/hold', description: 'Toggle order hold' },
        { method: 'GET', path: '/api/v1/contracts', description: 'List blanket contracts' },
        { method: 'POST', path: '/api/v1/contracts', description: 'Create blanket contract' },
        { method: 'PUT', path: '/api/v1/contracts/:id', description: 'Update blanket contract' },
        { method: 'DELETE', path: '/api/v1/contracts/:id', description: 'Delete blanket contract' }
      ]
    },
    {
      domain: 'Procurement',
      routes: [
        { method: 'GET', path: '/api/v1/procurement/history', description: 'Cross-order sourcing history' },
        { method: 'GET', path: '/api/v1/procurement/unique-po-number', description: 'Generate next PO number' }
      ]
    },
    {
      domain: 'Inventory & Warehouse',
      routes: [
        { method: 'GET', path: '/api/v1/inventory', description: 'List inventory' },
        { method: 'POST', path: '/api/v1/inventory', description: 'Create SKU' },
        { method: 'PUT', path: '/api/v1/inventory/:id', description: 'Update SKU' },
        { method: 'DELETE', path: '/api/v1/inventory/:id', description: 'Delete SKU' },
        { method: 'POST', path: '/api/v1/inventory/adjust', description: 'Adjust stock levels' }
      ]
    },
    {
      domain: 'Finance & Payments',
      routes: [
        { method: 'GET', path: '/api/v1/project-wallets', description: 'Customer project wallet balances' },
        { method: 'POST', path: '/api/v1/customers/:id/advance-payment', description: 'Record advance deposit' },
        { method: 'GET', path: '/api/v1/supplierPayments', description: 'List supplier payments' },
        { method: 'POST', path: '/api/v1/supplierPayments', description: 'Record supplier payment' },
        { method: 'GET', path: '/api/v1/supplier-ledger/:supplierId', description: 'Get supplier transaction ledger' },
        { method: 'GET', path: '/api/v1/ledger', description: 'General ledger entries' },
        { method: 'POST', path: '/api/v1/ledger', description: 'Create ledger entry' }
      ]
    },
    {
      domain: 'CRM & Customers',
      routes: [
        { method: 'GET', path: '/api/v1/customers', description: 'List customers' },
        { method: 'POST', path: '/api/v1/customers', description: 'Create customer' },
        { method: 'PUT', path: '/api/v1/customers/:id', description: 'Update customer' },
        { method: 'DELETE', path: '/api/v1/customers/:id', description: 'Delete customer' },
        { method: 'POST', path: '/api/v1/customers/merge', description: 'Merge customers' },
        { method: 'POST', path: '/api/v1/customers/:id/hold', description: 'Toggle customer hold' }
      ]
    },
    {
      domain: 'Suppliers',
      routes: [
        { method: 'GET', path: '/api/v1/suppliers', description: 'List suppliers' },
        { method: 'POST', path: '/api/v1/suppliers', description: 'Create supplier' },
        { method: 'PUT', path: '/api/v1/suppliers/:id', description: 'Update supplier' },
        { method: 'DELETE', path: '/api/v1/suppliers/:id', description: 'Delete supplier' },
        { method: 'POST', path: '/api/v1/suppliers/:id/parts', description: 'Add part to supplier price list' },
        { method: 'PUT', path: '/api/v1/suppliers/:id/parts/:partId', description: 'Update part in supplier price list' },
        { method: 'DELETE', path: '/api/v1/suppliers/:id/parts/:partId', description: 'Remove part from supplier price list' },
        { method: 'POST', path: '/api/v1/suppliers/:id/blacklist', description: 'Toggle supplier blacklist' }
      ]
    },
    {
      domain: 'AI & File Uploads',
      routes: [
        { method: 'POST', path: '/api/v1/ai-proxy/chat', description: 'AI chat and OCR scanning proxy' },
        { method: 'POST', path: '/api/upload-pod', description: 'Upload Proof of Delivery' },
        { method: 'POST', path: '/api/upload-einvoice', description: 'Upload government e-invoice' },
        { method: 'POST', path: '/api/upload-wht-certificate', description: 'Upload Withholding Tax certificate' },
        { method: 'POST', path: '/api/upload-cost-sheet', description: 'Upload Technical Review cost sheet' },
        { method: 'POST', path: '/api/upload-supplier-receipt', description: 'Upload supplier payment receipt' }
      ]
    },
    {
      domain: 'System Administration',
      routes: [
        { method: 'GET', path: '/api/v1/users', description: 'List users' },
        { method: 'POST', path: '/api/v1/users', description: 'Create user' },
        { method: 'PUT', path: '/api/v1/users/:id', description: 'Update user' },
        { method: 'DELETE', path: '/api/v1/users/:id', description: 'Delete user' },
        { method: 'GET', path: '/api/v1/userGroups', description: 'List user groups' },
        { method: 'POST', path: '/api/v1/userGroups', description: 'Create user group' },
        { method: 'PUT', path: '/api/v1/userGroups/:id', description: 'Update user group' },
        { method: 'DELETE', path: '/api/v1/userGroups/:id', description: 'Delete user group' },
        { method: 'GET', path: '/api/v1/full-backup', description: 'Export full encrypted system backup' },
        { method: 'POST', path: '/api/v1/full-restore', description: 'Import full system backup' }
      ]
    }
  ]
};

function getUserGuideMarkdown() {
  return API_USER_GUIDE_MARKDOWN;
}

function getUserGuideJson() {
  return API_USER_GUIDE_JSON;
}

export {
  API_USER_GUIDE_MARKDOWN,
  API_USER_GUIDE_JSON,
  getUserGuideMarkdown,
  getUserGuideJson
};
