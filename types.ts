
/**
 * Supported order currencies. The application NEVER converts between currencies —
 * revenue and cost are tracked in the order's native currency. Currency conversion
 * is only used to bring the cost side into the order's revenue currency when
 * checking the P/L threshold (see the `conversionRate` field on CustomerOrder).
 *
 * 'L.E.' (Egyptian Pound) is the default for any order that does not explicitly
 * identify a currency.
 */
export type Currency = 'L.E.' | 'USD' | 'EUR' | 'SAR' | 'AED' | 'GBP';

export const DEFAULT_CURRENCY: Currency = 'L.E.';
export const SUPPORTED_CURRENCIES: Currency[] = ['L.E.', 'USD', 'EUR', 'SAR', 'AED', 'GBP'];

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
  WAITING_GOVE = 'WAITING_GOVE',
  FULFILLED = 'FULFILLED'
}

export type UserRole = 'admin' | 'management' | 'order_management' | 'factory' | 'procurement' | 'finance' | 'crm' | 'inventory' | 'Gov.EInvoice' | 'planning' | 'suppliers' | 'shipment' | 'sales' | 'warehouse' | 'logistics';

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  roles: UserRole[];
  permissions?: {
    canViewFinancials?: boolean;
    canApproveTechReview?: boolean;
    canReleaseHub?: boolean;
    canManageUsers?: boolean;
    [key: string]: boolean | undefined;
  };
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
  sandboxAccess?: boolean;
  sandbox?: boolean;
  sandboxOwner?: string;
  sandboxLabel?: string;
}

export interface AuthEnvironment {
  id: string;
  label: string;
  type: 'live' | 'personal' | 'shared';
  owner?: string;
}

export interface AdminSandboxInfo {
  owner: string;
  name: string;
  label: string;
  isSelf: boolean;
  isCurrent: boolean;
  ordersCount?: number;
  usersCount?: number;
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
  secondaryEmail?: string;
  phone: string;
  address: string;
  deliveryAddress?: string;
  location?: string;
  contactName?: string;
  contactPhone?: string;
  contactAddress?: string;
  contactEmail?: string;
  contactName2?: string;
  contactPhone2?: string;
  contactAddress2?: string;
  contactEmail2?: string;
  contactName3?: string;
  contactPhone3?: string;
  contactAddress3?: string;
  contactEmail3?: string;
  paymentTermDays: number;
  isHold?: boolean;
  holdReason?: string;
  appliesWithholdingTax?: boolean;
  minimumMarginPct?: number;
  walletBalance?: number;
  /** Per-project wallet balances (key = project name). `walletBalance` is the aggregate total. */
  walletBalances?: Record<string, number>;
  logs?: LogEntry[];
}

export interface SupplierPart {
  id: string;
  partNumber: string;
  description: string;
  price: number;
  currency: string;
  originalSupplierId?: string;
  originalSupplierName?: string;
  deletedAt?: string;
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
  isDeletedSupplier?: boolean;
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

export type CompStatus = 'AVAILABLE' | 'PENDING_OFFER' | 'RFP_SENT' | 'AWARDED' | 'ORDERED' | 'ORDERED_FOR_STOCK' | 'WAITING_CONTRACT_START' | 'RECEIVED' | 'RESERVED' | 'IN_MANUFACTURING' | 'MANUFACTURED' | 'CANCELLED';

export interface ReplacementRequest {
  id: string;
  requestDate: string;
  reason: string;
  originalStartDate: string;
  newStartDate: string;
  remainingDuration: string;
}

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
  contractStartDate?: string;
  originalStartDate?: string;
  replacementHistory?: ReplacementRequest[];
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
  alteredQty?: number;
  alterationComment?: string;
  costSheetFile?: string;
  costSheetFileName?: string;
  costSheetText?: string;
  costSheetEditableCells?: string[];
  costSheetCellColors?: Record<string, string>;
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
  googleDriveLink?: string;
  googleDriveFileId?: string;
  googleDriveFileName?: string;
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
  /**
   * Native currency for this order. Prices, costs, payments and any revenue
   * figure derived from this order are denominated in this currency. Defaults
   * to 'L.E.' if not explicitly set.
   */
  currency?: Currency;
  /**
   * Multiplier used to bring costs (which are denominated in their own PO
   * currency) into the order's revenue currency for the P/L threshold check.
   * Defaults to 1 (i.e. no conversion). Editable from the Finance view.
   */
  conversionRate?: number;
  blanketOrder?: boolean;
  /**
   * Project name associated with a blanket order. Used to identify which
   * project a blanket contract belongs to across Order Management, Procurement,
   * and Technical Review modules.
   */
  projectName?: string;
  /**
   * When a new order is created as a settling order against an existing blanket
   * contract, this holds the blanket contract's order ID (or internal order number).
   * The server auto-sets isSettlingOrder to true for any order carrying this field.
   */
  blanketContractId?: string;
  /**
   * Auto-set by the server when an order is submitted with a blanketContractId.
   * Settling orders appear in Finance with a "Blanket Settling" badge and can be
   * invoiced at any point in the lifecycle.
   */
  isSettlingOrder?: boolean;
  contractId?: string;
}

export interface Contract {
  id: string;
  customerName: string;
  description: string;
  targetLineItems: string;
  receivedDate?: string;
  createdAt?: string;
}

export interface HelpLink {
  url: string;
  description: string;
}

/**
 * Machine / ERP Test Tool API key. The full secret (`key`) is returned ONLY in
 * the create response and is never stored or served back in plaintext.
 */
export interface ApiKey {
  id: string;
  name: string;
  /** Owner user the key authenticates as. */
  username: string;
  /** Leading characters of the secret, for display/identification. */
  prefix: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string | null;
  enabled: boolean;
  /** Present only on the create response. */
  key?: string;
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

export interface GoogleDriveConfig {
  enabled: boolean;
  autoUploadExternalSubmissions: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  folderName: string;
  folderId?: string;
  refreshToken?: string;
  connectedEmail?: string;
  connectedAt?: string;
}

export type StorageBackend = 'google-drive' | 'local-storage';

export interface LocalStorageConfig {
  enabled: boolean;
  autoUploadExternalSubmissions: boolean;
  storageIp: string;
  apiPort: number;
  consolePort: number;
  accessKey: string;
  secretKey?: string;
  bucketName: string;
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
    storageBackend?: StorageBackend;
    googleDriveConfig: GoogleDriveConfig;
    localStorageConfig?: LocalStorageConfig;
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
    ledgerAccounts?: string[];
    ledgerAccountGroups?: Record<string, string[]>; // groupName -> [accountNames]
    availableRoles?: UserRole[];
    helpLinks?: HelpLink[];
    helpVideos?: string[];
    roleMappings?: Record<string, UserRole[]>;
  };
}

export const getItemEffectiveStatus = (item: CustomerOrderItem): string => {
  const comps = item.components || [];
  if (comps.length === 0) return 'NO_COMPONENTS';
  const statuses = comps.map(c => c.status || 'NEW');
  // If any component still needs procurement action
  if (statuses.some(s => ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED', 'WAITING_CONTRACT_START'].includes(s))) return 'WAITING_SUPPLIERS';
  // If all components are reserved/received (ready to manufacture)
  if (statuses.every(s => ['RESERVED', 'RECEIVED', 'CANCELLED', 'ORDERED_FOR_STOCK'].includes(s))) return 'WAITING_FACTORY';
  // If any are actively being manufactured
  if (statuses.some(s => s === 'IN_MANUFACTURING')) return 'MANUFACTURING';
  // If all are manufactured
  if (statuses.every(s => ['MANUFACTURED', 'CANCELLED'].includes(s))) return 'MANUFACTURED';
  return 'MIXED';
};

