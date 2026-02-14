
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
  PARTIAL_PAYMENT = 'PARTIAL_PAYMENT',
  FULFILLED = 'FULFILLED'
}

export type UserRole = 'admin' | 'management' | 'order_management' | 'factory' | 'procurement' | 'finance' | 'crm';

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
  timestamp: string;
  comment?: string;
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

export type CompStatus = 'AVAILABLE' | 'PENDING_OFFER' | 'RFP_SENT' | 'AWARDED' | 'ORDERED' | 'RECEIVED' | 'RESERVED' | 'IN_MANUFACTURING' | 'MANUFACTURED';

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
  rfpSupplierIds?: string[];
  status?: CompStatus;
  statusUpdatedAt?: string;
  procurementStartedAt?: string;
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
}

export interface InventoryItem {
  id: string;
  sku: string;
  description: string;
  quantityInStock: number;
  quantityReserved: number;
  unit: string;
  lastCost: number;
  category: string;
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
  loggingComplianceViolation?: boolean;
}

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
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
  };
  settings: {
    aiProvider: AIProvider;
    openaiConfig: OpenAIConfig;
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
    deliveredLimitHrs: number;
    defaultPaymentSlaDays: number;
    minimumMarginPct: number;
    loggingDelayThresholdDays: number;
    thresholdNotifications: Record<string, string[]>;
    enableNewOrderAlerts: boolean;
    newOrderAlertGroupIds: string[];
  };
}
