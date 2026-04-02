
export enum OrderStatus {
  LOGGED = 'LOGGED',
  TECHNICAL_REVIEW = 'TECHNICAL_REVIEW',
  IN_HOLD = 'IN_HOLD',
  REJECTED = 'REJECTED',
  NEGATIVE_MARGIN = 'NEGATIVE_MARGIN',
  WAITING_SUPPLIERS = 'WAITING_SUPPLIERS',
  WAITING_FACTORY = 'WAITING_FACTORY',
  DELIVERY = 'DELIVERY',
  MANUFACTURING = 'MANUFACTURING',
  MANUFACTURING_COMPLETED = 'MANUFACTURING_COMPLETED',
  UNDER_TEST = 'UNDER_TEST',
  TRANSITION_TO_STOCK = 'TRANSITION_TO_STOCK',
  IN_PRODUCT_HUB = 'IN_PRODUCT_HUB',
  ISSUE_INVOICE = 'ISSUE_INVOICE',
  INVOICED = 'INVOICED',
  HUB_RELEASED = 'HUB_RELEASED',
  DELIVERED = 'DELIVERED',
  FULFILLED = 'FULFILLED'
}

export type UserRole = 'admin' | 'management' | 'order_management' | 'factory' | 'procurement' | 'finance' | 'crm' | 'inventory' | 'Gov.EInvoice' | 'planning';

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  roles: UserRole[];
}

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  roles: UserRole[];
  groupIds?: string[];
  avatar?: string;
  logs?: LogEntry[];
}

export type AIProvider = 'gemini' | 'openai';

export interface LogEntry {
  timestamp: string;
  message: string;
  status?: string;
  user?: string;
  nextStep?: string;
}

export interface Payment {
  amount: number;
  date: string;
  user: string;
  memo: string;
  receiptNumber: string;
}

export interface Customer {
  id?: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  location?: string;
  contactName?: string;
  contactPhone?: string;
  contactAddress?: string;
  contactEmail?: string;
  paymentTermDays: number;
  isHold?: boolean;
  holdReason?: string;
  appliesWithholdingTax?: boolean;
  minimumMarginPct?: number;
  logs?: LogEntry[];
}

export interface SupplierPart {
  id: string;
  partNumber: string;
  description: string;
  price: number;
  currency: string;
}

export interface Supplier {
  id?: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  location?: string;
  contactName?: string;
  contactPhone?: string;
  contactAddress?: string;
  contactEmail?: string;
  isBlacklisted?: boolean;
  blacklistReason?: string;
  priceList?: SupplierPart[];
  logs?: LogEntry[];
}

export interface SupplierPaymentAllocation {
  componentId: string;
  orderId: string;
  orderNumber: string;
  itemDescription: string;
  amount: number;
}

export interface SupplierPayment {
  id: string;
  supplierId: string;
  supplierName: string;
  amount: number;
  date: string;
  memo: string;
  user: string;
  allocations: SupplierPaymentAllocation[];
}

export interface LedgerEntry {
  id: string;
  date: string;
  type: 'COST' | 'ADDITION';
  amount: number;
  description: string;
  category?: string;
  user: string;
}

export type CompStatus = 'AVAILABLE' | 'PENDING_OFFER' | 'RFP_SENT' | 'AWARDED' | 'ORDERED' | 'ORDERED_FOR_STOCK' | 'RECEIVED' | 'RESERVED' | 'IN_MANUFACTURING' | 'MANUFACTURED' | 'CANCELLED';

export interface ManufacturingComponent {
  id?: string;
  componentNumber?: string;
  poNumber?: string;
  description: string;
  quantity: number;
  unit: string;
  unitCost: number;
  taxPercent: number;
  source: 'STOCK' | 'PROCUREMENT';
  inventoryItemId?: string;
  supplierId?: string;
  supplierPartId?: string;
  supplierPartNumber?: string;
  rfpSupplierIds?: string[];
  rfpId?: string;
  awardId?: string;
  sendPoId?: string;
  status?: CompStatus;
  statusUpdatedAt?: string;
  procurementStartedAt?: string;
  consumedQty?: number;
  receivedQty?: number;
  contractNumber?: string;
  contractDuration?: string;
  scopeOfWork?: string;
}


export interface CustomerOrderItem {
  id: string;
  orderNumber: string;
  description: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  taxPercent: number;
  logs: LogEntry[];
  isAccepted?: boolean;
  components?: ManufacturingComponent[];
  productionType?: 'MANUFACTURING' | 'TRADING' | 'OUTSOURCING';
  manufacturedQty?: number;
  hubReceivedQty?: number;
  approvedForDispatchQty?: number;
  dispatchedQty?: number;
  shippedQty?: number;
  deliveredQty?: number;
}

export interface InventoryItem {
  id: string;
  sku: string;
  description: string;
  category: string;
  quantityInStock: number;
  quantityReserved?: number;
  unit: string;
  lastCost: number;
  location?: string;
  poNumber?: string;
  orderRef?: string;
  logs?: LogEntry[];
}

export interface ProcurementLine {
  id: string;
  customerOrderItemId: string;
  componentId?: string;
  itemDescription: string;
  quantity: number;
  status: 'ORDERED' | 'RECEIVED' | 'PENDING';
  logs: LogEntry[];
}

export interface CustomerOrder {
  id: string;
  internalOrderNumber?: string;
  customerReferenceNumber: string;
  customerName: string;
  orderDate: string;
  dataEntryTimestamp?: string;
  status?: OrderStatus;
  previousStatus?: OrderStatus;
  invoiceNumber?: string;
  paymentSlaDays: number;
  items: CustomerOrderItem[];
  logs?: LogEntry[];
  payments?: Payment[];
  rejectionReason?: string;
  holdReason?: string;
  financeOverride?: {
    user: string;
    comment: string;
    timestamp: string;
    type: 'HOLD_RELEASE' | 'MARGIN_RELEASE';
  };
  deliveries?: { id: string, date: string, items: { itemId: string, qty: number }[], podFilePath?: string }[];
  loggingComplianceViolation?: boolean;
  isOverdue?: boolean;
  einvoiceRequested?: boolean;
  einvoiceFile?: string;
  targetDeliveryDays?: number;
  targetDeliveryDate?: string;
  appliesWithholdingTax?: boolean;
  whtCertificateFile?: string;
}

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  modelName: string;
}

export interface GeminiConfig {
  apiKey: string;
  modelName: string;
}

export interface EmailConfig {
  smtpServer: string;
  smtpPort: number;
  username: string;
  password?: string;
  senderName: string;
  senderEmail: string;
  useSsl: boolean;
}

export interface AppConfig {
  modules: {
    orderManagement: boolean;
    procurement: boolean;
    crm: boolean;
    inventory: boolean;
    technicalReview: boolean;
    suppliers: boolean;
    shipping: boolean;
    reception: boolean;
    finance: boolean;
    factory: boolean;
    govEInvoice?: boolean;
  };
  settings: {
    aiProvider: AIProvider;
    openaiConfig: OpenAIConfig;
    geminiConfig: GeminiConfig;
    emailConfig: EmailConfig;
    companyName: string;
    companyAddress: string;
    companyLogo: string;
    orderEditTimeLimitHrs: number;
    technicalReviewLimitHrs: number;
    pendingOfferLimitHrs: number;
    rfpSentLimitHrs: number;
    awardedLimitHrs: number;
    issuePoLimitHrs: number;
    orderedLimitHrs: number;
    waitingFactoryLimitHrs: number;
    mfgFinishLimitHrs: number;
    transitToHubLimitHrs: number;
    productHubLimitHrs: number;
    invoicedLimitHrs: number;
    hubReleasedLimitHrs: number;
    deliveryLimitHrs: number;
    govEInvoiceLimitHrs: number;
    deliveredLimitHrs: number;
    defaultPaymentSlaDays: number;
    minimumMarginPct: number;
    loggingDelayThresholdDays: number;
    thresholdNotifications: Record<string, string[]>;
    enableNewOrderAlerts: boolean;
    newOrderAlertGroupIds: string[];
    enableRollbackAlerts: boolean;
    rollbackAlertGroupIds: string[];
    enableDeliveryAlerts: boolean;
    deliveryAlertGroupIds: string[];
    deliveryWarningDays: number;
    chartConfig?: {
      theme: 'neutral' | 'dark' | 'forest' | 'base';
      primaryColor?: string; // Hex code for main elements
      backgroundColor?: string; // Hex code for background (if base theme)
      textColor?: string; // Hex code for text elements
    };
    availableRoles?: UserRole[];
    roleMappings?: Record<string, UserRole[]>;
  };
}

export const getItemEffectiveStatus = (item: CustomerOrderItem): string => {
  const comps = item.components || [];
  if (comps.length === 0) return 'NO_COMPONENTS';
  const statuses = comps.map(c => c.status || 'NEW');
  // If any component still needs procurement action
  if (statuses.some(s => ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED'].includes(s))) return 'WAITING_SUPPLIERS';
  // If all components are reserved/received (ready to manufacture)
  if (statuses.every(s => ['RESERVED', 'RECEIVED', 'CANCELLED', 'ORDERED_FOR_STOCK'].includes(s))) return 'WAITING_FACTORY';
  // If any are actively being manufactured
  if (statuses.some(s => s === 'IN_MANUFACTURING')) return 'MANUFACTURING';
  // If all are manufactured
  if (statuses.every(s => ['MANUFACTURED', 'CANCELLED'].includes(s))) return 'MANUFACTURED';
  return 'MIXED';
};
