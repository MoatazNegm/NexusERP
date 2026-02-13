
import { AppConfig, OrderStatus, Customer, InventoryItem, Supplier, User, UserGroup, CustomerOrderItem, ManufacturingComponent, CustomerOrder } from './types';

export const INITIAL_CONFIG: AppConfig = {
  modules: {
    orderManagement: true,
    procurement: true,
    crm: true,
    inventory: true,
    technicalReview: true,
    suppliers: true,
    shipping: false,
    reception: true,
    finance: true,
    factory: true
  },
  settings: {
    aiProvider: 'gemini',
    openaiConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4o' },
    emailConfig: {
      smtpServer: 'mail.quickstor.net',
      smtpPort: 465,
      username: 'erpalerts@quickstor.net',
      password: 'YousefNadody123!',
      senderName: 'Nexus System Alert',
      senderEmail: 'erpalerts@quickstor.net',
      useSsl: true
    },
    companyName: 'شراكه خدمات التعبئه',
    companyAddress: 'شارع المصانع أوسيم',
    companyLogo: '',
    orderEditTimeLimitHrs: 1, technicalReviewLimitHrs: 2, pendingOfferLimitHrs: 2, rfpSentLimitHrs: 24, awardedLimitHrs: 8, issuePoLimitHrs: 1, orderedLimitHrs: 72, waitingFactoryLimitHrs: 5, mfgFinishLimitHrs: 1, transitToHubLimitHrs: 2, productHubLimitHrs: 24, invoicedLimitHrs: 1, hubReleasedLimitHrs: 1, deliveryLimitHrs: 3, deliveredLimitHrs: 1080, defaultPaymentSlaDays: 30, minimumMarginPct: 15, loggingDelayThresholdHrs: 1,
    thresholdNotifications: {},
    enableNewOrderAlerts: true,
    newOrderAlertGroupIds: ['grp_super']
  }
};

export const INITIAL_USER_GROUPS: UserGroup[] = [
  {
    id: 'grp_super',
    name: 'Superusers',
    description: 'Full administrative control with access to all system modules and financial data.',
    roles: ['admin', 'management', 'order_management', 'factory', 'procurement', 'finance', 'crm']
  },
  {
    id: 'grp_mgmt',
    name: 'Management',
    description: 'Executive oversight and financial reporting access.',
    roles: ['management', 'finance']
  },
  {
    id: 'grp_ops',
    name: 'Operations Team',
    description: 'Standard access for order handling and manufacturing oversight.',
    roles: ['order_management', 'factory', 'procurement', 'crm']
  }
];

export const DEFAULT_USERS: (User & { password?: string })[] = [
  { id: 'u_1', username: 'admin', name: 'System Administrator', roles: ['admin'], groupIds: ['grp_super'], password: 'admin', email: 'admin@nexus-erp.com' },
  { id: 'u_2', username: 'manager', name: 'Executive Manager', roles: ['management'], groupIds: [], password: 'manager', email: 'exec@nexus-erp.com' },
  { id: 'u_3', username: 'order', name: 'Order Desk', roles: ['order_management'], groupIds: [], password: 'order', email: 'orders@nexus-erp.com' },
  { id: 'u_4', username: 'factory', name: 'Plant Manager', roles: ['factory'], groupIds: [], password: 'factory', email: 'plant@nexus-erp.com' },
  { id: 'u_5', username: 'procurement', name: 'Purchasing Head', roles: ['procurement'], groupIds: [], password: 'procurement', email: 'sourcing@nexus-erp.com' },
  { id: 'u_6', username: 'finance', name: 'Financial Controller', roles: ['finance'], groupIds: [], password: 'finance', email: 'accounts@nexus-erp.com' },
  { id: 'u_7', username: 'crm', name: 'Account Manager', roles: ['crm'], groupIds: [], password: 'crm', email: 'relations@nexus-erp.com' }
];

export const STATUS_CONFIG: Record<OrderStatus, { label: string, color: string, icon: string }> = {
  [OrderStatus.LOGGED]: { label: 'Logged', color: 'slate', icon: 'fa-file-medical' },
  [OrderStatus.TECHNICAL_REVIEW]: { label: 'Technical Review', color: 'cyan', icon: 'fa-microscope' },
  [OrderStatus.IN_HOLD]: { label: 'In Hold', color: 'amber', icon: 'fa-hand' },
  [OrderStatus.REJECTED]: { label: 'Rejected', color: 'red', icon: 'fa-thumbs-down' },
  [OrderStatus.NEGATIVE_MARGIN]: { label: 'Negative Margin', color: 'rose', icon: 'fa-chart-line-down' },
  [OrderStatus.WAITING_SUPPLIERS]: { label: 'Waiting Suppliers', color: 'orange', icon: 'fa-boxes-packing' },
  [OrderStatus.WAITING_FACTORY]: { label: 'Waiting Factory', color: 'violet', icon: 'fa-stopwatch-20' },
  [OrderStatus.DELIVERY]: { label: 'Transit to customer', color: 'rose', icon: 'fa-truck-ramp-box' },
  [OrderStatus.MANUFACTURING]: { label: 'In Factory', color: 'blue', icon: 'fa-industry' },
  [OrderStatus.MANUFACTURING_COMPLETED]: { label: 'Mfg Finished', color: 'indigo', icon: 'fa-check-double' },
  [OrderStatus.UNDER_TEST]: { label: 'Under Test', color: 'purple', icon: 'fa-flask' },
  [OrderStatus.TRANSITION_TO_STOCK]: { label: 'Transit to Hub', color: 'emerald', icon: 'fa-truck-fast' },
  [OrderStatus.IN_PRODUCT_HUB]: { label: 'In Product Hub', color: 'teal', icon: 'fa-warehouse' },
  [OrderStatus.ISSUE_INVOICE]: { label: 'Issue Invoice', color: 'pink', icon: 'fa-file-signature' },
  [OrderStatus.INVOICED]: { label: 'Invoiced', color: 'teal', icon: 'fa-file-invoice-dollar' },
  [OrderStatus.HUB_RELEASED]: { label: 'Hub Released', color: 'sky', icon: 'fa-dolly' },
  [OrderStatus.DELIVERED]: { label: 'Delivered', color: 'rose', icon: 'fa-handshake' },
  [OrderStatus.PARTIAL_PAYMENT]: { label: 'Partial Payment', color: 'yellow', icon: 'fa-money-bill-transfer' },
  [OrderStatus.FULFILLED]: { label: 'Fulfilled', color: 'green', icon: 'fa-circle-check' }
};

// --- DATA GENERATION UTILS ---
const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

const CUST_POOL = [
  'Global Tech Solutions', 'Cairo Precision Engineering', 'Delta Manufacturing Group',
  'Sinai Mining Corp', 'Alexandria Petrochemicals', 'Red Sea Logistics',
  'Giza Solar Systems', 'Luxor Heavy Industries', 'Port Said Maritime', 'Assiut Cement Co'
];

const ITEM_POOL = [
  'Heavy Duty Pump Assembly', 'Industrial Control Panel V4', 'Conveyor Belt System 50m',
  'CNC Precision Spindle', 'Hydraulic Ram Type-B', 'Custom Transformer 50kVA',
  'Air Filtration Unit', 'Power Distribution Box', 'Mechanical Valve Seal Kit'
];

const COMP_POOL = [
  'Steel Chassis Frame', 'Copper Coils 100m', 'Micro-Controller Unit', 'Rubber Gasket Set',
  'Grade 8 Bolt Set', 'Aluminum Casing', 'Cooling Fan Assembly', 'Hydraulic Fluid 20L'
];

// Helper to generate a standardized order structure
const createOrder = (id: string, index: number, status: OrderStatus, hAgo: number, marginOverride?: number): CustomerOrder => {
  const custName = CUST_POOL[index % CUST_POOL.length];
  const internalID = `INT-2024-${2024 + Math.floor(index / 50)}-${String(index + 100).padStart(4, '0')}`;

  // Logic for generating items
  const items: CustomerOrderItem[] = Array.from({ length: 1 + (index % 3) }).map((_, iIdx) => {
    const revenue = 5000 + (index * 100);
    // If marginOverride is provided, make cost higher than revenue
    const cost = marginOverride ? revenue * (1 + marginOverride / 100) : revenue * 0.7;

    return {
      id: `it_${id}_${iIdx}`,
      orderNumber: `${internalID}-${String(iIdx + 1).padStart(2, '0')}`,
      description: ITEM_POOL[(index + iIdx) % ITEM_POOL.length],
      quantity: 1 + (index % 5),
      unit: 'pcs',
      pricePerUnit: revenue,
      taxPercent: 14,
      isAccepted: status !== OrderStatus.LOGGED && status !== OrderStatus.TECHNICAL_REVIEW,
      logs: [],
      components: Array.from({ length: 2 + (index % 2) }).map((_, cIdx) => ({
        id: `c_${id}_${iIdx}_${cIdx}`,
        componentNumber: `CMP-${index}-${iIdx}-${cIdx}`,
        description: COMP_POOL[(index + cIdx) % COMP_POOL.length],
        quantity: 5,
        unit: 'pcs',
        unitCost: cost / 3, // Distribute cost
        taxPercent: 14,
        source: cIdx === 0 ? 'STOCK' : 'PROCUREMENT',
        status: status === OrderStatus.WAITING_FACTORY ? 'RECEIVED' : (cIdx === 0 ? 'RESERVED' : 'PENDING_OFFER'),
        statusUpdatedAt: hoursAgo(hAgo + 1)
      } as ManufacturingComponent))
    };
  });

  return {
    id: `ord_${id}`,
    internalOrderNumber: internalID,
    customerReferenceNumber: `PO-REF-${1000 + index}`,
    customerName: custName,
    orderDate: daysAgo(Math.floor(hAgo / 24)),
    dataEntryTimestamp: hoursAgo(hAgo),
    status: status,
    paymentSlaDays: 30,
    items,
    logs: [
      { timestamp: hoursAgo(hAgo), message: 'Order initialized by automation engine', status: OrderStatus.LOGGED, user: 'admin' },
      { timestamp: hoursAgo(hAgo - 0.5), message: `Transitioned to state: ${status}`, status: status, user: 'System' }
    ]
  };
};

// --- MOCK DATA EXPORTS ---

export const MOCK_CUSTOMERS: Customer[] = CUST_POOL.map((name, i) => ({
  id: `cust_${i}`,
  name,
  email: `procurement@${name.toLowerCase().replace(/ /g, '-')}.com`,
  phone: `+20-10-555-${String(i).padStart(4, '0')}`,
  address: `Industrial Zone ${i + 1}, Cairo`,
  paymentTermDays: 30 + (i * 5),
  isHold: i === 2, // Every 3rd customer has a hold for diversity
  holdReason: i === 2 ? 'Overdue payments on historical account' : undefined,
  logs: [{ timestamp: hoursAgo(100), message: 'Account synchronized' }]
}));

export const MOCK_SUPPLIERS: Supplier[] = [
  { id: 'supp_1', name: 'Industrial Parts Co.', email: 'orders@ind-parts.com', phone: '+1-555-9000', address: '101 Supply Rd', logs: [], priceList: [] },
  { id: 'supp_2', name: 'Elite Electrics Ltd', email: 'sales@elite-elec.com', phone: '+20-2-7777-6666', address: 'Nasr City', logs: [], priceList: [] },
  { id: 'supp_3', name: 'Delta Steel Mills', email: 'steel@delta.com', phone: '+20-10-1234-5678', address: 'Helwan', logs: [], priceList: [] }
];

export const MOCK_INVENTORY: InventoryItem[] = [
  { id: 'inv_1', sku: 'ST-BRG-44', description: 'Ball Bearing 44mm', quantityInStock: 250, quantityReserved: 40, unit: 'pcs', lastCost: 120, category: 'Mechanical' },
  { id: 'inv_2', sku: 'ST-CAB-25', description: 'Shielded Cable 25mm', quantityInStock: 1200, quantityReserved: 300, unit: 'm', lastCost: 45, category: 'Electrical' },
  { id: 'inv_3', sku: 'ST-PL-G', description: 'Industrial Grade Gasket', quantityInStock: 50, quantityReserved: 10, unit: 'pcs', lastCost: 85, category: 'Mechanical' }
];

// Generate 100 orders distributed across all statuses
const generatedOrders: CustomerOrder[] = [];

// 1. LOGGED (15) - 5 are overdue (>1hr)
for (let i = 0; i < 15; i++) {
  generatedOrders.push(createOrder(`logged_${i}`, i, OrderStatus.LOGGED, i < 5 ? 5 : 0.5));
}

// 2. TECHNICAL_REVIEW (15) - 5 are overdue (>2hrs)
for (let i = 0; i < 15; i++) {
  generatedOrders.push(createOrder(`tech_${i}`, i + 15, OrderStatus.TECHNICAL_REVIEW, i < 5 ? 10 : 1));
}

// 3. NEGATIVE_MARGIN (10) - Severe Alerts
const marginReasons = ['Raw material surcharge peak', 'Calculation error in logistics markup', 'Vendor price list out-of-sync', 'Scope creep in engineering'];
for (let i = 0; i < 10; i++) {
  const o = createOrder(`neg_${i}`, i + 30, OrderStatus.NEGATIVE_MARGIN, 24, 25); // 25% negative
  o.logs.push({ timestamp: hoursAgo(1), message: `CRITICAL ALERT: Negative Margin identified. Reason: ${marginReasons[i % marginReasons.length]}`, user: 'System' });
  generatedOrders.push(o);
}

// 4. IN_HOLD (5) - Risk Alerts
for (let i = 0; i < 5; i++) {
  const o = createOrder(`hold_${i}`, i + 40, OrderStatus.IN_HOLD, 12);
  o.holdReason = "Finance review: Account credit limit reached";
  generatedOrders.push(o);
}

// 5. WAITING_SUPPLIERS (15)
for (let i = 0; i < 15; i++) {
  generatedOrders.push(createOrder(`wait_supp_${i}`, i + 45, OrderStatus.WAITING_SUPPLIERS, 48));
}

// 6. MANUFACTURING (15)
for (let i = 0; i < 15; i++) {
  generatedOrders.push(createOrder(`mfg_${i}`, i + 60, OrderStatus.MANUFACTURING, 72));
}

// 7. IN_PRODUCT_HUB (10)
for (let i = 0; i < 10; i++) {
  generatedOrders.push(createOrder(`hub_${i}`, i + 75, OrderStatus.IN_PRODUCT_HUB, 120));
}

// 8. INVOICED / AR (10)
for (let i = 0; i < 10; i++) {
  const o = createOrder(`inv_${i}`, i + 85, OrderStatus.INVOICED, 150);
  o.invoiceNumber = `INV-2024-DATA-${i + 1000}`;
  generatedOrders.push(o);
}

// 9. FULFILLED (5)
for (let i = 0; i < 5; i++) {
  generatedOrders.push(createOrder(`done_${i}`, i + 95, OrderStatus.FULFILLED, 500));
}

export const MOCK_ORDERS: CustomerOrder[] = generatedOrders;
