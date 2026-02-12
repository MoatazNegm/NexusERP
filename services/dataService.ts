/// <reference types="vite/client" />
import { Dexie, type Table } from 'dexie';
import {
  CustomerOrder,
  ProcurementLine,
  OrderStatus,
  Customer,
  LogEntry,
  CustomerOrderItem,
  InventoryItem,
  ManufacturingComponent,
  Supplier,
  SupplierPart,
  CompStatus,
  AppConfig,
  Payment,
  UserGroup,
  User,
  UserRole,
  EmailConfig
} from '../types';
import { MOCK_ORDERS, MOCK_CUSTOMERS, MOCK_INVENTORY, MOCK_SUPPLIERS, INITIAL_USER_GROUPS, DEFAULT_USERS, INITIAL_CONFIG } from '../constants';

// Internal Bridge Implementation (Simulating a Private Backend Module)
const _nexusBackendCore = {
  async executeSmtpRelay(payload: any, log: any) {
    // Dynamic loading only when triggered by backend request
    if (!(window as any).Email) {
      log("[Server] Loading SMTP Dispatch Module...", "tx");
      const script = document.createElement('script');
      script.src = "https://smtpjs.com/v3/smtp.js";

      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            script.onload = resolve;
            script.onerror = () => reject(new Error("Network Error: Failed to load SMTP module. Check your internet connection or firewall."));
            document.head.appendChild(script);
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Loading Timeout: SMTP module took too long to load.")), 10000))
        ]);
      } catch (err: any) {
        log(`[Server] FATAL: ${err.message}`, "err");
        throw err;
      }
    }

    log(`[Server] Handshaking: ${payload.Host}:${payload.Port || 465}...`, "tx");
    log(`[Server] Auth Identity: ${payload.Username}`, "tx");

    const response = await (window as any).Email.send({
      Host: payload.Host,
      Username: payload.Username,
      Password: payload.Password,
      To: payload.To,
      From: payload.From,
      Subject: payload.Subject,
      Body: payload.Body
    });

    if (response === "OK") {
      log("[Server] 250 OK: Message accepted for delivery.", "rx");
      return { status: 202, message: "Accepted" };
    } else {
      log(`[Server] 554 Transaction Failed: ${response}`, "err");
      throw new Error(response);
    }
  }
};

class NexusDatabase extends Dexie {
  customers!: Table<Customer, string>;
  orders!: Table<CustomerOrder, string>;
  inventory!: Table<InventoryItem, string>;
  suppliers!: Table<Supplier, string>;
  procurement!: Table<ProcurementLine, string>;
  userGroups!: Table<UserGroup, string>;
  users!: Table<User & { password?: string }, string>;

  constructor() {
    super('NexusERP_DB');
    (this as any).version(3).stores({
      customers: 'id, name, email',
      orders: 'id, internalOrderNumber, customerReferenceNumber, customerName, status, orderDate, invoiceNumber',
      inventory: 'id, sku, description, category',
      suppliers: 'id, name, email',
      procurement: 'id, customerOrderItemId, status',
      userGroups: 'id, name',
      users: 'id, username, name'
    });
  }
}

const db = new NexusDatabase();

const DB_TABLE_NAMES = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users'] as const;
type DBTableTitle = typeof DB_TABLE_NAMES[number];

class DataService {
  private appStartTime = Date.now();
  private readonly FACTORY_PASS = 'YousefNadody!@#2';

  private async hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async deriveKey(passcode: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passcode),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  private async compress(data: string): Promise<Uint8Array> {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  private async decompress(data: Uint8Array): Promise<string> {
    const stream = new Blob([data.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  // Implementation of secure backup export
  async exportSecureBackup(config: AppConfig, passcode: string): Promise<Blob> {
    const backupData: any = {
      config,
      metadata: {
        version: "2.1",
        timestamp: new Date().toISOString(),
        source: "NexusERP Core"
      },
      data: {}
    };

    for (const tableName of DB_TABLE_NAMES) {
      backupData.data[tableName] = await (db as any)[tableName].toArray();
    }

    const json = JSON.stringify(backupData);
    const compressed = await this.compress(json);

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(passcode, salt);

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      compressed.buffer as ArrayBuffer
    );

    const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    result.set(salt, 0);
    result.set(iv, salt.length);
    result.set(new Uint8Array(encrypted), salt.length + iv.length);

    return new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' });
  }

  // Implementation of secure backup restoration
  async importSecureBackup(file: File, passcode: string): Promise<AppConfig> {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    const salt = data.slice(0, 16);
    const iv = data.slice(16, 28);
    const encrypted = data.slice(28);

    const key = await this.deriveKey(passcode, salt);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
        key,
        encrypted.buffer as ArrayBuffer
      );

      const json = await this.decompress(new Uint8Array(decrypted));
      const backup = JSON.parse(json);

      // Support for both old (direct) and new (metadata + data) formats
      const config = backup.config;
      const tablesData = backup.data || backup;

      await (db as any).transaction('rw', DB_TABLE_NAMES.map(name => (db as any)[name]), async () => {
        // Step 1: Purge existing state
        await Promise.all(DB_TABLE_NAMES.map(name => (db as any)[name].clear()));

        // Step 2: Inject backup state
        await Promise.all(DB_TABLE_NAMES.map(name => {
          const tableData = tablesData[name];
          if (tableData && Array.isArray(tableData)) {
            return (db as any)[name].bulkPut(tableData);
          }
          return Promise.resolve();
        }));
      });

      // Integrity Check: Verify that the restoration succeeded
      const checkTasks = DB_TABLE_NAMES.map(async (name) => {
        const count = await (db as any)[name].count();
        const expected = (tablesData[name] || []).length;
        if (count !== expected) {
          console.warn(`[Integrity] Table ${name} count mismatch: got ${count}, expected ${expected}`);
        }
      });
      await Promise.all(checkTasks);

      return config;
    } catch (e) {
      throw new Error("Invalid passcode or corrupted backup file.");
    }
  }

  async createLog(message: string, status?: string, user?: string, nextStep?: string): Promise<LogEntry> {
    return {
      timestamp: new Date().toISOString(),
      message,
      status,
      user: user || 'System',
      nextStep
    };
  }

  /**
   * BACKEND RELAY DISPATCH
   * Refactored: Frontend no longer knows HOW to send mail. 
   * It only knows to call a POST /api/v1/relay/dispatch endpoint.
   */
  async sendEmailRelay(to: string[], subject: string, body: string, config: EmailConfig, onLog?: (msg: string, type: 'tx' | 'rx' | 'err') => void) {
    const log = (msg: string, type: 'tx' | 'rx' | 'err' = 'rx') => {
      if (onLog) onLog(msg, type);
    };

    try {
      log(`API CALL: POST /api/v1/relay/dispatch`, 'tx');
      log(`HEADERS: { "Content-Type": "application/json", "Authorization": "Bearer NEXUS_AUTH_TOKEN" }`, 'tx');

      // Security Policy Check
      if (config.username !== 'erpalerts@quickstor.net') {
        log(`API ERROR 403: Forbidden Identity. Allowed: erpalerts@quickstor.net`, 'err');
        throw new Error("API Authorization Failure: Unauthorized sender.");
      }

      // Real Backend Relay Call
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(`${backendUrl}/api/v1/relay/dispatch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer NEXUS_AUTH_TOKEN'
        },
        body: JSON.stringify({
          Host: config.smtpServer,
          Port: config.smtpPort,
          Username: config.username,
          Password: config.password,
          To: to.join(','),
          From: config.senderEmail,
          Subject: subject,
          Body: body
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const backendResult = await response.json();

      if (!response.ok) {
        throw new Error(backendResult.error || `HTTP ${response.status}`);
      }

      log(`API RESPONSE: ${response.status} ${backendResult.message || 'Accepted'}`, 'rx');
      return true;

    } catch (err: any) {
      log(`API EXCEPTION: ${err.message}`, 'err');
      throw err;
    }
  }

  async sendTestEmail(recipient: string, config: EmailConfig, onLog?: (msg: string, type: 'tx' | 'rx' | 'err') => void) {
    if (!recipient) throw new Error("Target recipient required for test.");
    return await this.sendEmailRelay(
      [recipient],
      `Nexus ERP: Strategic Backend Relay Verification`,
      `This is a REAL email requested via a conceptual POST call to the Nexus Backend. The handshake happened server-side. If you see this, your enterprise relay architecture is vetted.`,
      config,
      onLog
    );
  }

  // --- ENTITY METHODS --- (Standard Implementation)
  async getCustomers() { return db.customers.toArray(); }
  async addCustomer(cust: Omit<Customer, 'id' | 'logs'>, user: string) {
    const id = `cust_${Date.now()}`;
    const newCust: Customer = { ...cust, id, logs: [await this.createLog('Entity registered', undefined, user)] };
    await db.customers.put(newCust);
    return newCust;
  }
  async updateCustomer(id: string, updates: Partial<Customer>, user: string) {
    const cust = await db.customers.get(id);
    if (!cust) throw new Error('Customer not found');
    const updated = { ...cust, ...updates };
    updated.logs.push(await this.createLog('Profile updated', undefined, user));
    await db.customers.put(updated);
    return updated;
  }
  async setCustomerHold(id: string, isHold: boolean, reason: string, user: string) {
    const cust = await db.customers.get(id);
    if (!cust) throw new Error('Customer not found');
    cust.isHold = isHold;
    cust.holdReason = reason;
    cust.logs.push(await this.createLog(`${isHold ? 'Credit Hold Engaged' : 'Credit Released'}: ${reason}`, undefined, user));
    await db.customers.put(cust);
  }
  async isCustomerOverdue(name: string) {
    const cust = await db.customers.where('name').equals(name).first();
    return cust?.isHold || false;
  }

  async getSuppliers() { return db.suppliers.toArray(); }
  async addSupplier(supp: Omit<Supplier, 'id' | 'logs' | 'priceList'>, user: string) {
    const id = `supp_${Date.now()}`;
    const newSupp: Supplier = { ...supp, id, priceList: [], logs: [await this.createLog('Vendor initialized', undefined, user)] };
    await db.suppliers.put(newSupp);
    return newSupp;
  }
  async updateSupplier(id: string, updates: Partial<Supplier>, user: string) {
    const supp = await db.suppliers.get(id);
    if (!supp) throw new Error('Vendor not found');
    const updated = { ...supp, ...updates };
    updated.logs.push(await this.createLog('Vendor profile updated', undefined, user));
    await db.suppliers.put(updated);
    return updated;
  }
  async blacklistSupplier(id: string, reason: string, user: string) {
    const supp = await db.suppliers.get(id);
    if (!supp) throw new Error('Vendor not found');
    supp.isBlacklisted = true;
    supp.blacklistReason = reason;
    supp.logs.push(await this.createLog(`Blacklisted: ${reason}`, undefined, user));
    await db.suppliers.put(supp);
  }
  async removeSupplierBlacklist(id: string, reason: string, user: string) {
    const supp = await db.suppliers.get(id);
    if (!supp) throw new Error('Vendor not found');
    supp.isBlacklisted = false;
    supp.blacklistReason = undefined;
    supp.logs.push(await this.createLog(`Blacklist removed: ${reason}`, undefined, user));
    await db.suppliers.put(supp);
  }
  async addPartToSupplier(id: string, part: Omit<SupplierPart, 'id'>, user: string) {
    const supp = await db.suppliers.get(id);
    if (!supp) throw new Error('Vendor not found');
    supp.priceList.push({ ...part, id: `sp_${Date.now()}` });
    supp.logs.push(await this.createLog(`Part added to catalog: ${part.description}`, undefined, user));
    await db.suppliers.put(supp);
  }
  async removePartFromSupplier(id: string, partId: string, user: string) {
    const supp = await db.suppliers.get(id);
    if (!supp) throw new Error('Vendor not found');
    supp.priceList = supp.priceList.filter(p => p.id !== partId);
    supp.logs.push(await this.createLog(`Removed part ref ${partId}`, undefined, user));
    await db.suppliers.put(supp);
  }

  async getInventory() { return db.inventory.toArray(); }
  async addInventoryItem(item: Omit<InventoryItem, 'id' | 'quantityReserved'>) {
    const id = `inv_${Date.now()}`;
    await db.inventory.put({ ...item, id, quantityReserved: 0 });
  }

  async getOrders() { return db.orders.toArray(); }
  async addOrder(order: Omit<CustomerOrder, 'id' | 'internalOrderNumber' | 'logs'>, user: string, config: AppConfig) {
    const id = `ord_${Date.now()}`;
    const count = await db.orders.count();
    const internalOrderNumber = `INT-2024-${String(count + 1).padStart(4, '0')}`;
    const newOrder: CustomerOrder = {
      ...order,
      id,
      internalOrderNumber,
      logs: [await this.createLog('Order acquisition recorded', OrderStatus.LOGGED, user)]
    };
    await db.orders.put(newOrder);

    // New Order Notification Logic
    if (config.settings.enableNewOrderAlerts) {
      const recipientGroupIds = config.settings.newOrderAlertGroupIds || [];
      if (recipientGroupIds.length > 0) {
        const users = await db.users.toArray();
        const groups = await db.userGroups.toArray();
        const eligibleGroups = groups.filter(g => recipientGroupIds.includes(g.id));
        const groupNames = eligibleGroups.map(g => g.name).join(', ');

        const targetEmails = users
          .filter(u => u.groupIds?.some(gid => recipientGroupIds.includes(gid)))
          .map(u => u.email)
          .filter(em => !!em);

        const uniqueEmails = [...new Set(targetEmails)];

        if (uniqueEmails.length > 0) {
          try {
            await this.sendEmailRelay(
              uniqueEmails,
              `New Order Notification: ${newOrder.internalOrderNumber}`,
              `A new purchase order has been logged in the system.\n\nOrder Details:\n- Internal ID: ${newOrder.internalOrderNumber}\n- PO Reference: ${newOrder.customerReferenceNumber}\n- Customer: ${newOrder.customerName}\n- Date: ${newOrder.orderDate}\n- Logged By: ${user}\n\nAssigned Groups: ${groupNames}`,
              config.settings.emailConfig
            );
          } catch (e) {
            console.error('Failed to send new order notification:', e);
          }
        }
      }
    }

    return newOrder;
  }
  async updateOrder(id: string, updates: Partial<CustomerOrder>, minMarginPct: number, user: string) {
    const order = await db.orders.get(id);
    if (!order) throw new Error('Order not found');
    const updated = { ...order, ...updates };
    updated.logs.push(await this.createLog('Order modified', undefined, user));
    await db.orders.put(updated);
    return updated;
  }
  async toggleItemAcceptance(orderId: string, itemId: string, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    const item = order.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item not found');
    item.isAccepted = !item.isAccepted;
    item.logs.push(await this.createLog(`${item.isAccepted ? 'Tech study approved' : 'Study revoked'}`, undefined, user));
    await db.orders.put(order);
    return order;
  }
  async addComponentToItem(orderId: string, itemId: string, comp: Omit<ManufacturingComponent, 'id' | 'statusUpdatedAt' | 'componentNumber'>, minMarginPct: number, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    const item = order.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item not found');
    const id = `c_${Date.now()}`;
    const componentNumber = `CMP-${order.internalOrderNumber}-${item.id.split('_').pop()}-${(item.components?.length || 0) + 1}`;
    const newComp: ManufacturingComponent = { ...comp, id, componentNumber, statusUpdatedAt: new Date().toISOString() };
    if (!item.components) item.components = [];
    item.components.push(newComp);
    item.logs.push(await this.createLog(`Added component: "${comp.description}"`, undefined, user));
    await db.orders.put(order);
    return order;
  }
  async removeComponent(orderId: string, itemId: string, compId: string, minMarginPct: number, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    const item = order.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item not found');
    item.components = item.components?.filter(c => c.id !== compId);
    item.logs.push(await this.createLog(`Removed component ${compId}`, undefined, user));
    await db.orders.put(order);
    return order;
  }
  async updateComponent(orderId: string, itemId: string, compId: string, updates: Partial<ManufacturingComponent>, minMarginPct: number, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    const item = order.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item not found');
    const comp = item.components?.find(c => c.id === compId);
    if (!comp) throw new Error('Component not found');
    Object.assign(comp, updates);
    comp.statusUpdatedAt = new Date().toISOString();
    await db.orders.put(order);
  }
  async finalizeTechnicalReview(orderId: string, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (!order.items.every(it => it.isAccepted)) throw new Error('Study incomplete');
    order.status = OrderStatus.WAITING_SUPPLIERS;
    order.logs.push(await this.createLog('Technical study finalized.', OrderStatus.WAITING_SUPPLIERS, user));
    await db.orders.put(order);
  }
  async rollbackOrderToLogged(orderId: string, reason: string, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    order.status = OrderStatus.LOGGED;
    order.logs.push(await this.createLog(`Rollback: ${reason}`, OrderStatus.LOGGED, user));
    await db.orders.put(order);
  }
  async getUniquePoNumber() { return `PO-${Date.now().toString().slice(-6)}`; }
  async receiveComponent(orderId: string, itemId: string, compId: string, user: string) {
    const order = await db.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    const item = order.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item not found');
    const comp = item.components?.find(c => c.id === compId);
    if (!comp) throw new Error('Component not found');
    comp.status = 'RECEIVED';
    comp.statusUpdatedAt = new Date().toISOString();
    await db.orders.put(order);
  }
  async startProduction(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.MANUFACTURING;
    order.logs.push(await this.createLog('Production started', OrderStatus.MANUFACTURING, user));
    await db.orders.put(order);
  }
  async finishProduction(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.MANUFACTURING_COMPLETED;
    order.logs.push(await this.createLog('Production finished', OrderStatus.MANUFACTURING_COMPLETED, user));
    await db.orders.put(order);
  }
  async receiveAtProductHub(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.IN_PRODUCT_HUB;
    order.logs.push(await this.createLog('Arrival at Hub', OrderStatus.IN_PRODUCT_HUB, user));
    await db.orders.put(order);
  }
  async issueInvoice(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.INVOICED;
    order.invoiceNumber = `INV-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000)}`;
    order.logs.push(await this.createLog(`Invoice issued: ${order.invoiceNumber}`, OrderStatus.INVOICED, user));
    await db.orders.put(order);
  }
  async releaseForDelivery(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.HUB_RELEASED;
    order.logs.push(await this.createLog('Released for dispatch', OrderStatus.HUB_RELEASED, user));
    await db.orders.put(order);
  }
  async confirmOrderDelivery(id: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.DELIVERED;
    order.logs.push(await this.createLog('Hand-off confirmed', OrderStatus.DELIVERED, user));
    await db.orders.put(order);
  }
  async recordPayment(id: string, amount: number, comment: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    if (!order.payments) order.payments = [];
    order.payments.push({ amount, timestamp: new Date().toISOString(), comment });
    await db.orders.put(order);
  }
  async setOrderHold(id: string, isHold: boolean, reason: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    if (isHold) {
      order.previousStatus = order.status;
      order.status = OrderStatus.IN_HOLD;
      order.holdReason = reason;
      order.logs.push(await this.createLog(`Hold: ${reason}`, OrderStatus.IN_HOLD, user));
    } else {
      const next = order.previousStatus || OrderStatus.LOGGED;
      order.status = next;
      order.previousStatus = undefined;
      order.logs.push(await this.createLog(`Hold released: ${reason}`, next, user));
    }
    await db.orders.put(order);
  }
  async rejectOrder(id: string, reason: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.REJECTED;
    order.rejectionReason = reason;
    order.logs.push(await this.createLog(`Rejected: ${reason}`, OrderStatus.REJECTED, user));
    await db.orders.put(order);
  }
  async releaseMarginBlock(id: string, comment: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    const next = order.previousStatus || OrderStatus.TECHNICAL_REVIEW;
    order.status = next;
    order.previousStatus = undefined;
    order.logs.push(await this.createLog(`Override: ${comment}`, next, user));
    await db.orders.put(order);
  }
  async cancelInvoice(id: string, reason: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.ISSUE_INVOICE;
    order.invoiceNumber = undefined;
    order.logs.push(await this.createLog(`Invoice Voided: ${reason}`, OrderStatus.ISSUE_INVOICE, user));
    await db.orders.put(order);
  }
  async cancelPayment(id: string, index: number, reason: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    if (order.payments) {
      order.payments.splice(index, 1);
      order.logs.push(await this.createLog(`Payment Voided: ${reason}`, undefined, user));
      await db.orders.put(order);
    }
  }
  async revertInvoicedOrderToSourcing(id: string, reason: string, user: string) {
    const order = await db.orders.get(id);
    if (!order) return;
    order.status = OrderStatus.WAITING_SUPPLIERS;
    order.invoiceNumber = undefined;
    order.logs.push(await this.createLog(`Reverted to Sourcing: ${reason}`, OrderStatus.WAITING_SUPPLIERS, user));
    await db.orders.put(order);
  }
  async getReport(params: any) {
    let collection = db.orders.toCollection();
    if (params.startDate) collection = collection.filter(o => o.orderDate >= params.startDate);
    if (params.endDate) collection = collection.filter(o => o.orderDate <= params.endDate);
    if (params.statuses?.length) collection = collection.filter(o => params.statuses.includes(o.status));
    let orders = await collection.toArray();
    if (params.query) {
      const q = params.query.toLowerCase();
      orders = orders.filter(o => o.internalOrderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q));
    }
    return orders;
  }

  async getUserGroups() { return db.userGroups.toArray(); }
  async addUserGroup(group: Omit<UserGroup, 'id'>) {
    await db.userGroups.put({ ...group, id: `grp_${Date.now()}` });
  }
  async updateUserGroup(id: string, updates: Partial<UserGroup>) {
    const group = await db.userGroups.get(id);
    if (group) await db.userGroups.put({ ...group, ...updates });
  }
  async deleteUserGroup(id: string) { await db.userGroups.delete(id); }

  async getUsers() { return db.users.toArray(); }
  async addUser(user: Omit<User, 'id'> & { password?: string }) {
    const hashedPassword = user.password ? await this.hashPassword(user.password) : undefined;
    await db.users.put({ ...user, password: hashedPassword, id: `u_${Date.now()}` });
  }
  async updateUser(id: string, updates: Partial<User & { password?: string }>) {
    const user = await db.users.get(id);
    if (user) {
      const newUpdates = { ...updates };
      if (updates.password) {
        newUpdates.password = await this.hashPassword(updates.password);
      }
      await db.users.put({ ...user, ...newUpdates });
    }
  }
  async deleteUser(id: string) { await db.users.delete(id); }

  async changePassword(userId: string, oldPass: string, newPass: string) {
    const u = await db.users.get(userId);
    if (!u) throw new Error("Identity not found.");

    const oldHash = await this.hashPassword(oldPass);
    if (u.password !== oldHash) throw new Error("Current passcode is incorrect.");

    u.password = await this.hashPassword(newPass);
    await db.users.put(u);
    return true;
  }

  async verifyLogin(username: string, pass: string) {
    const u = await db.users.where('username').equals(username).first();
    const passHash = await this.hashPassword(pass);

    // Dual-Mode Admin Access (1 minute emergency window)
    const isFactoryWindow = (Date.now() - this.appStartTime) < 60000;
    if (username === 'admin' && isFactoryWindow) {
      // 1. Factory Bypass
      if (pass === this.FACTORY_PASS) {
        if (u) {
          const { password, ...safeUser } = u;
          return safeUser as User;
        }
      }
      // 2. Fall-through to normal check allows standard password too
    }

    if (u && u.password === passHash) {
      const { password, ...safeUser } = u;
      return safeUser as User;
    }
    return null;
  }

  async performThresholdAudit(config: AppConfig, log: (msg: string) => void) {
    const orders = await db.orders.toArray();
    const groups = await db.userGroups.toArray();
    const users = await db.users.toArray();
    let notificationsSent = 0;
    let errorsHandled = 0;
    let processed = 0;

    log(`[INIT] Audit initialized. Database contains ${orders.length} orders and ${users.length} users.`);
    log(`[INIT] Scanning for violations against ${Object.keys(config.settings.thresholdNotifications).length} configured compliance rules.`);

    for (const order of orders) {
      processed++;
      try {
        if ([OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(order.status)) {
          continue;
        }

        log(`[SCAN] Order ${order.internalOrderNumber} | Status: ${order.status} (${processed}/${orders.length})`);

        // 1. Check Order-Level Status Threshold
        const statusKeyMap: Partial<Record<OrderStatus, keyof AppConfig['settings']>> = {
          [OrderStatus.LOGGED]: 'orderEditTimeLimitHrs',
          [OrderStatus.TECHNICAL_REVIEW]: 'technicalReviewLimitHrs',
          [OrderStatus.WAITING_FACTORY]: 'waitingFactoryLimitHrs',
          [OrderStatus.MANUFACTURING]: 'mfgFinishLimitHrs',
          [OrderStatus.MANUFACTURING_COMPLETED]: 'transitToHubLimitHrs',
          [OrderStatus.TRANSITION_TO_STOCK]: 'transitToHubLimitHrs',
          [OrderStatus.IN_PRODUCT_HUB]: 'productHubLimitHrs',
          [OrderStatus.ISSUE_INVOICE]: 'invoicedLimitHrs',
          [OrderStatus.INVOICED]: 'hubReleasedLimitHrs',
          [OrderStatus.HUB_RELEASED]: 'deliveryLimitHrs',
          [OrderStatus.DELIVERY]: 'deliveredLimitHrs',
        };

        const configKey = statusKeyMap[order.status];
        if (configKey) {
          const limitHrs = config.settings[configKey] as number;
          const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
          const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
          const elapsedHrs = (Date.now() - startTime) / 3600000;

          if (elapsedHrs > limitHrs) {
            const recipientGroupIds = config.settings.thresholdNotifications[configKey as string] || [];
            if (recipientGroupIds.length > 0) {
              const eligibleGroups = groups.filter(g => recipientGroupIds.includes(g.id));
              const groupNames = eligibleGroups.map(g => g.name).join(', ');

              // Resolve User Emails
              const targetEmails = users
                .filter(u => u.groupIds?.some(gid => recipientGroupIds.includes(gid)))
                .map(u => u.email)
                .filter(em => !!em);

              const uniqueEmails = [...new Set(targetEmails)];

              if (uniqueEmails.length === 0) {
                log(`[ALERT] PO ${order.internalOrderNumber} violation, but NO USERS found in groups: ${groupNames}`);
                continue;
              }

              log(`[RELAY] Invoking network delegate for recipients: ${uniqueEmails.join(', ')}`);

              await this.sendEmailRelay(
                uniqueEmails,
                `Threshold Violation: Order ${order.internalOrderNumber}`,
                `Order ${order.internalOrderNumber} has been in status ${order.status} for ${elapsedHrs.toFixed(1)} hours, exceeding the ${limitHrs}h threshold set in policy.\n\nAssigned Groups: ${groupNames}`,
                config.settings.emailConfig,
                (m, t) => log(`[RELAY-${t.toUpperCase()}] ${m}`)
              );
              log(`[RELAY] Transmission Successful.`);
              notificationsSent++;
            }
          }
        }

        // 2. Check Item-Level / Component Sourcing Thresholds
        if (order.items) {
          for (const item of order.items) {
            if (!item.components) continue;
            for (const comp of item.components) {
              const compKeyMap: Partial<Record<CompStatus, keyof AppConfig['settings']>> = {
                'PENDING_OFFER': 'pendingOfferLimitHrs',
                'RFP_SENT': 'rfpSentLimitHrs',
                'AWARDED': 'awardedLimitHrs',
                'ORDERED': 'orderedLimitHrs',
              };

              const cKey = compKeyMap[comp.status];
              if (cKey) {
                const cLimit = config.settings[cKey] as number;
                const cElapsed = (Date.now() - new Date(comp.statusUpdatedAt).getTime()) / 3600000;

                if (cElapsed > cLimit) {
                  const cGroupsIds = config.settings.thresholdNotifications[cKey as string] || [];
                  if (cGroupsIds.length > 0) {
                    const cEligibleGroups = groups.filter(g => cGroupsIds.includes(g.id));
                    const cGroupNames = cEligibleGroups.map(g => g.name).join(', ');

                    // Resolve User Emails
                    const cTargetEmails = users
                      .filter(u => u.groupIds?.some(gid => cGroupsIds.includes(gid)))
                      .map(u => u.email)
                      .filter(em => !!em);

                    const cUniqueEmails = [...new Set(cTargetEmails)];

                    if (cUniqueEmails.length === 0) {
                      log(`[ALERT] Part ${comp.componentNumber} violation, but NO USERS found in groups: ${cGroupNames}`);
                      continue;
                    }

                    log(`[ALERT] Part ${comp.componentNumber} stalling in ${comp.status} (${cElapsed.toFixed(1)}h > ${cLimit}h).`);
                    log(`[RELAY] Invoking network delegate for recipients: ${cUniqueEmails.join(', ')}`);

                    await this.sendEmailRelay(
                      cUniqueEmails,
                      `Sourcing Delay: Part ${comp.componentNumber}`,
                      `Component ${comp.componentNumber} (Order ${order.internalOrderNumber}) is stalled in ${comp.status} for ${cElapsed.toFixed(1)}h. Threshold: ${cLimit}h.\n\nAssigned Groups: ${cGroupNames}`,
                      config.settings.emailConfig,
                      (m, t) => log(`[RELAY-${t.toUpperCase()}] ${m}`)
                    );
                    log(`[RELAY] Transmission Successful.`);
                    notificationsSent++;
                  }
                }
              }
            }
          }
        }
      } catch (err: any) {
        errorsHandled++;
        log(`[ERROR] Critical failure scanning PO ${order.internalOrderNumber}: ${err.message}`);
      }
    }

    log(`[FINISH] Audit Sweep Completed.`);
    log(`[SUMMARY] Analyzed: ${processed} | Alerts Triggered: ${notificationsSent} | Failures: ${errorsHandled}`);
    return { notificationsSent, errorsHandled };
  }

  // Dummy initialization to satisfy earlier requirements
  async init() {
    const userCount = await db.users.count();
    const orderCount = await db.orders.count();
    if (userCount === 0) {
      const hashedUsers = await Promise.all(DEFAULT_USERS.map(async (u) => ({
        ...u,
        password: u.password ? await this.hashPassword(u.password) : undefined
      })));
      await db.users.bulkPut(hashedUsers);
      await db.userGroups.bulkPut(INITIAL_USER_GROUPS);
    }
    if (orderCount === 0 && !localStorage.getItem('nexus_skip_mock')) {
      await this.loadMockData();
    }
  }

  async loadMockData() {
    return await (db as any).transaction('rw', DB_TABLE_NAMES.map(name => (db as any)[name]), async () => {
      await Promise.all(DB_TABLE_NAMES.map(name => (db as any)[name].clear()));

      const hashedUsers = await Promise.all(DEFAULT_USERS.map(async (u) => ({
        ...u,
        password: u.password ? await this.hashPassword(u.password) : undefined
      })));

      await Promise.all([
        db.customers.bulkPut(MOCK_CUSTOMERS),
        db.suppliers.bulkPut(MOCK_SUPPLIERS),
        db.inventory.bulkPut(MOCK_INVENTORY),
        db.orders.bulkPut(MOCK_ORDERS),
        db.userGroups.bulkPut(INITIAL_USER_GROUPS),
        db.users.bulkPut(hashedUsers)
      ]);
      localStorage.removeItem('nexus_skip_mock');
    });
  }

  async clearAllData() {
    return await (db as any).transaction('rw', DB_TABLE_NAMES.map(name => (db as any)[name]), async () => {
      await Promise.all(DB_TABLE_NAMES.map(name => (db as any)[name].clear()));

      const hashedUsers = await Promise.all(DEFAULT_USERS.map(async (u) => ({
        ...u,
        password: u.password ? await this.hashPassword(u.password) : undefined
      })));

      await Promise.all([
        db.users.bulkPut(hashedUsers),
        db.userGroups.bulkPut(INITIAL_USER_GROUPS)
      ]);
      localStorage.setItem('nexus_skip_mock', 'true');
    });
  }
}

export const dataService = new DataService();
