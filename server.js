
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');
const SERVER_START_TIME = Date.now();
const FACTORY_PASS = 'YousefNadody!@#2';

// --- MULTER CONFIG ---
const podStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'uploads', 'pod');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'pod-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadPod = multer({ storage: podStorage });

const einvoiceStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'uploads', 'einvoices');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'einvoice-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadEInvoice = multer({ storage: einvoiceStorage });

const whtStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'uploads', 'wht_certificates');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'wht-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadWht = multer({ storage: whtStorage });

const OrderStatus = {
    LOGGED: 'LOGGED',
    TECHNICAL_REVIEW: 'TECHNICAL_REVIEW',
    NEGATIVE_MARGIN: 'NEGATIVE_MARGIN',
    IN_HOLD: 'IN_HOLD',
    REJECTED: 'REJECTED',
    WAITING_SUPPLIERS: 'WAITING_SUPPLIERS',
    WAITING_FACTORY: 'WAITING_FACTORY',
    DELIVERY: 'DELIVERY',
    MANUFACTURING: 'MANUFACTURING',
    MANUFACTURING_COMPLETED: 'MANUFACTURING_COMPLETED',
    UNDER_TEST: 'UNDER_TEST',
    TRANSITION_TO_STOCK: 'TRANSITION_TO_STOCK',
    IN_PRODUCT_HUB: 'IN_PRODUCT_HUB',
    ISSUE_INVOICE: 'ISSUE_INVOICE',
    INVOICED: 'INVOICED',
    HUB_RELEASED: 'HUB_RELEASED',
    DELIVERED: 'DELIVERED',
    FULFILLED: 'FULFILLED'
};

// Per-item effective status: determines what workflow stage a line item is in based on its components
const getItemEffectiveStatus = (item) => {
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

const evaluateMarginStatus = (items, minMargin, currentStatus) => {
    let totalRevenue = 0;
    let totalCost = 0;
    let hasComponents = false;
    let hasActiveTechReview = false;
    let anyAccepted = false;

    (items || []).forEach(it => {
        totalRevenue += ((it.quantity || 0) * (it.pricePerUnit || 0));
        if (it.isAccepted) anyAccepted = true;
        if (it.components && it.components.length > 0) {
            hasComponents = true;
            
            if (it.productionType === 'MANUFACTURING' || it.productionType === 'OUTSOURCING') {
                hasActiveTechReview = true;
            } else {
                const isModified = it.components.length > 1 || it.components.some(c => 
                    c.unitCost > 0 || c.supplierId || c.source === 'STOCK' || (c.status && c.status !== 'PENDING_OFFER' && c.status !== 'NEW')
                );
                if (isModified) hasActiveTechReview = true;
            }


            it.components.forEach(c => {
                totalCost += ((c.quantity || 0) * (c.unitCost || 0));
            });
        }
    });

    const marginAmt = totalRevenue - totalCost;
    const markupPct = totalCost > 0 ? (marginAmt / totalCost) * 100 : (totalRevenue > 0 ? 100 : 0);

    // Safeguard: Don't auto-transition terminal or manual statuses
    if ([OrderStatus.REJECTED, OrderStatus.IN_HOLD].includes(currentStatus)) return currentStatus;

    // Priority 1: Margin Protection (if components present)
    if (hasComponents && markupPct < minMargin) return OrderStatus.NEGATIVE_MARGIN;

    // Priority 2: Technical Workflow Transition
    if ((hasActiveTechReview || anyAccepted) && currentStatus === OrderStatus.LOGGED) {
        return OrderStatus.TECHNICAL_REVIEW;
    }

    // Priority 3: Recovery from Negative Margin
    if (currentStatus === OrderStatus.NEGATIVE_MARGIN && (!hasComponents || markupPct >= minMargin)) {
        return (hasActiveTechReview || anyAccepted) ? OrderStatus.TECHNICAL_REVIEW : OrderStatus.LOGGED;
    }

    return currentStatus;
};

const isOrderFullyPaid = (order) => {
    if (!order.payments) return false;
    const totalPaid = order.payments.reduce((s, p) => s + (p.amount || 0), 0);
    let revenue = 0;
    (order.items || []).forEach(it => {
        revenue += ((it.quantity || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100)));
    });

    let targetRevenue = revenue;
    if (order.appliesWithholdingTax) {
        targetRevenue = revenue * 0.99; // Deduct 1% WHT
    }

    return totalPaid >= (targetRevenue - 0.01); // 0.01 for floating point precision
};

const isOrderFullyDelivered = (order) => {
    if (!order.items || order.items.length === 0) return false;
    return order.items.every(i => (i.deliveredQty || 0) >= (i.quantity || 0));
};

// --- DATABASE HANDLERS ---
const readDb = () => {
    try {
        const BAK_PATH = DB_PATH + '.local.bak';

        if (!fs.existsSync(DB_PATH)) {
            // Priority 1: Check if we have a local safety backup (prevents data loss on env reset/git pull)
            if (fs.existsSync(BAK_PATH)) {
                fs.copyFileSync(BAK_PATH, DB_PATH);
                console.log(`[System] CRITICAL: db.json was missing! Restored from local backup (.local.bak) to prevent data loss.`);
            } 
            // Priority 2: Fallback to the production stub if no backup exists
            else {
                const stubPath = path.join(__dirname, 'db.stub.json');
                if (fs.existsSync(stubPath)) {
                    fs.copyFileSync(stubPath, DB_PATH);
                    console.log("[System] Initialized db.json from db.stub.json (no local backup found)");
                } else {
                    return {};
                }
            }
        } else {
            // Create/Refresh the local backup on every successful server start for future safety
            try {
                fs.copyFileSync(DB_PATH, BAK_PATH);
            } catch (e) {
                console.error("Failed to refresh local db backup", e);
            }
        }
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error reading DB:", err);
        return {};
    }
};

const writeDb = (data) => {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error("Error writing DB:", err);
        return false;
    }
};

// --- HELPERS ---
const hashPassword = (pass) => crypto.createHash('sha256').update(pass).digest('hex');

// --- AES-256-CBC CIPHER FOR SENSITIVE SETTINGS ---
const CIPHER_KEY = crypto.createHash('sha256').update(FACTORY_PASS).digest(); // 32 bytes
const CIPHER_PREFIX = 'ENC:';

const encryptValue = (plainText) => {
    if (!plainText || plainText.startsWith(CIPHER_PREFIX)) return plainText; // Already encrypted or empty
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv);
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return CIPHER_PREFIX + iv.toString('hex') + ':' + encrypted;
};

const decryptValue = (encText) => {
    if (!encText || !encText.startsWith(CIPHER_PREFIX)) return encText; // Not encrypted
    try {
        const raw = encText.slice(CIPHER_PREFIX.length);
        const [ivHex, encrypted] = raw.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.error('[Cipher] Decryption failed, returning raw value');
        return encText;
    }
};

// Paths within a settings object that contain sensitive values
const SENSITIVE_PATHS = [
    ['geminiConfig', 'apiKey'],
    ['openaiConfig', 'apiKey'],
    ['emailConfig', 'password']
];

const transformSensitiveFields = (settings, fn) => {
    if (!settings) return settings;
    const copy = JSON.parse(JSON.stringify(settings));
    SENSITIVE_PATHS.forEach(([parent, key]) => {
        if (copy[parent] && copy[parent][key]) {
            copy[parent][key] = fn(copy[parent][key]);
        }
    });
    return copy;
};

const encryptSettings = (settings) => transformSensitiveFields(settings, encryptValue);
const decryptSettings = (settings) => transformSensitiveFields(settings, decryptValue);

const resolveSettings = (db) => {
    const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0)
        ? db.settings[0]
        : (db.settings || {});

    const merged = {
        loggingDelayThresholdDays: 1,
        enableNewOrderAlerts: true,
        newOrderAlertGroupIds: [],
        enableRollbackAlerts: true,
        rollbackAlertGroupIds: [],
        thresholdNotifications: {},
        emailConfig: {
            smtpServer: 'mail.quickstor.net',
            smtpPort: 465,
            username: 'erpalerts@quickstor.net',
            password: 'YousefNadody123!',
            senderName: 'Nexus System Alert',
            senderEmail: 'erpalerts@quickstor.net',
            useSsl: true
        },
        availableRoles: ['admin', 'management', 'order_management', 'factory', 'procurement', 'finance', 'crm', 'inventory', 'Gov.EInvoice', 'planning'],
        roleMappings: {
            dashboard: ['management'],
            orders: ['order_management'],
            technicalReview: ['planning'],
            finance: ['finance'],
            procurement: ['procurement'],
            factory: ['factory'],
            inventory: ['inventory'],
            shipment: ['order_management'],
            crm: ['crm'],
            suppliers: ['procurement'],
            reporting: ['management'],
            govEInvoice: ['Gov.EInvoice']
        },
        ...dbSettings
    };

    // Decrypt sensitive fields for internal use
    return decryptSettings(merged);
};

const getRecipients = (groupIds, db) => {
    if (!groupIds || !Array.isArray(groupIds)) groupIds = [];
    const recipients = [];
    const seenEmails = new Set();
    const userGroups = db.userGroups || [];
    const users = db.users || [];

    groupIds.forEach(gid => {
        const group = userGroups.find(g => g.id === gid);
        const groupName = group ? group.name : gid;
        users.forEach(u => {
            if (u.groupIds?.includes(gid) && u.email && !seenEmails.has(u.email)) {
                recipients.push({ name: u.name || u.username, email: u.email, groupName });
                seenEmails.add(u.email);
            }
        });
    });

    if (recipients.length === 0) {
        users.forEach(u => {
            if (u.roles?.includes('admin') && u.email && !seenEmails.has(u.email)) {
                recipients.push({ name: u.name || u.username, email: u.email, groupName: 'Admin Fallback' });
                seenEmails.add(u.email);
            }
        });
    }
    return recipients;
};

// --- LOGGING & ID HELPERS ---
const createAuditLog = (message, status, user) => ({
    timestamp: new Date().toISOString(),
    message,
    status,
    user
});

const generateInternalOrderNumber = (db) => {
    const orders = db.orders || [];
    const count = orders.length;
    return `INT-2024-${String(count + 1).padStart(4, '0')}`;
};

/**
 * Reconciles inventory reservations based on order component changes.
 * Compares old and new versions of an order and adjusts quantityReserved in db.inventory.
 */
const reconcileInventory = (oldOrder, newOrder, db) => {
    const inventoryUpdates = new Map(); // inventoryId -> quantityDelta

    const getReservedMap = (order) => {
        const map = new Map();
        if (!order) return map;
        (order.items || []).forEach(item => {
            (item.components || []).forEach(comp => {
                if (comp.inventoryItemId && (comp.status === 'RECEIVED' || comp.status === 'RESERVED' || comp.source === 'STOCK') && comp.source !== 'CONSUMED') {
                    const current = map.get(comp.inventoryItemId) || 0;
                    map.set(comp.inventoryItemId, current + (comp.quantity || 0));
                }
            });
        });
        return map;
    };

    const oldMap = getReservedMap(oldOrder);
    const newMap = getReservedMap(newOrder);

    // Find all unique IDs
    const allIds = new Set([...oldMap.keys(), ...newMap.keys()]);

    allIds.forEach(id => {
        const oldQty = oldMap.get(id) || 0;
        const newQty = newMap.get(id) || 0;
        const delta = newQty - oldQty;
        if (delta !== 0) inventoryUpdates.set(id, delta);
    });

    // Apply updates to db.inventory
    if (inventoryUpdates.size > 0 && db.inventory) {
        inventoryUpdates.forEach((delta, id) => {
            const invItem = db.inventory.find(inv => inv.id === id);
            if (invItem) {
                invItem.quantityReserved = (invItem.quantityReserved || 0) + delta;
                console.log(`[Inventory] Reconciled ${invItem.sku}: Delta ${delta}, New Reserved: ${invItem.quantityReserved}`);
            }
        });
        return true;
    }
    return false;
};

// (Global updateInventoryItem definition removed - moved to dispatch-action scope)

// --- INVENTORY HELPERS ---
// (Duplicate updateInventoryItem definition removed)

// --- STOCK REPLENISHMENT LOGIC ---
const handleStockReceipts = (oldOrder, newOrder, db) => {
    if (newOrder.customerName !== 'Internal Stock' || !newOrder.items) return;

    (newOrder.items || []).forEach(item => {
        (item.components || []).forEach(comp => {
            // Find corresponding component in old order to detect status change
            // If new order (oldOrder is null), checks if status is already RECEIVED (unlikely but possible)
            const oldComp = oldOrder
                ? (oldOrder.items.find(i => i.id === item.id)?.components || []).find(c => c.id === comp.id)
                : null;

            const oldStatus = oldComp ? oldComp.status : 'NEW';

            // Trigger on transition to RECEIVED
            if (comp.status === 'RECEIVED' && oldStatus !== 'RECEIVED' && comp.inventoryItemId) {
                const invItem = (db.inventory || []).find(inv => inv.id === comp.inventoryItemId);
                if (invItem) {
                    const qty = Number(comp.quantity) || 0;
                    const cost = Number(comp.unitCost) || 0;

                    invItem.quantityInStock = (Number(invItem.quantityInStock) || 0) + qty;
                    invItem.lastCost = cost; // Update valuation

                    console.log(`[Stock Replenishment] Added ${qty} to ${invItem.sku}. New Stock: ${invItem.quantityInStock}. Cost updated to ${cost}.`);

                    if (!newOrder.logs) newOrder.logs = [];
                    newOrder.logs.push(createAuditLog(
                        `[AUTO] Stock Replenishment: ${qty} units of ${invItem.sku} added to Free Stock. Valuation updated to ${cost}.`,
                        newOrder.status,
                        'System'
                    ));
                }
            }
        });
    });
};

const processedOrderInternal = (order, db, user, isNew, oldOrder = null, skipStatusEval = false) => {
    // 1. Ensure basic structures
    if (!order.logs) order.logs = [];
    if (!order.items) order.items = [];

    // 2. Handle New Order specific side-effects
    if (isNew) {
        if (!order.internalOrderNumber) order.internalOrderNumber = generateInternalOrderNumber(db);
        if (!order.dataEntryTimestamp) order.dataEntryTimestamp = new Date().toISOString();
        if (order.logs.length === 0) {
            order.logs.push(createAuditLog('Order acquisition recorded', OrderStatus.LOGGED, user));
        }
    }

    // 2.5 Handle Stock Replenishment logic
    handleStockReceipts(oldOrder, order, db);

    // 3. Process Items and Components
    order.items.forEach((item, idx) => {
        if (!item.id) item.id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
        if (!item.logs) item.logs = [];
        if (!item.components) item.components = [];

        // Automation: If BoM changed compared to old order, revoke approval
        if (oldOrder) {
            const oldItem = (oldOrder.items || []).find(i => i.id === item.id);
            if (oldItem) {
                // simple stringify check for BoM change
                const oldComps = JSON.stringify(oldItem.components || []);
                const newComps = JSON.stringify(item.components || []);
                if (oldComps !== newComps && item.isAccepted) {
                    item.isAccepted = false;
                    order.logs.push(createAuditLog(`[AUTO] BoM mutation detected on item ${idx + 1}. Technical approval revoked.`, order.status, 'System'));
                }
            }
        }

        // 3b. Trading Mirror Sync & Defaulting
        if (!item.productionType) {
            item.productionType = 'TRADING';
        }

        if (item.productionType === 'TRADING') {

            // Ensure exactly one component that mirrors the item
            if (!item.components || item.components.length === 0) {
                item.components = [{
                    id: `c_${Date.now()}_${idx}_0`,
                    description: item.description,
                    quantity: item.quantity,
                    unit: item.unit || 'pcs',
                    unitCost: 0,
                    taxPercent: 14,
                    source: 'PROCUREMENT',
                    status: 'PENDING_OFFER',
                    componentNumber: `CMP-${order.internalOrderNumber}-${idx + 1}-1`
                }];
            } else {
                // Mirror sync: Only the first component is active in TRADING
                const comp = item.components[0];
                if (comp.description !== item.description || comp.quantity !== item.quantity) {
                    comp.description = item.description;
                    comp.quantity = item.quantity;
                }
                // Cap at 1 component for TRADING to prevent BoM pollution
                if (item.components.length > 1) {
                    item.components = [item.components[0]];
                }
            }
        }

        item.components.forEach((comp, cIdx) => {
            if (!comp.id) comp.id = `c_${Date.now()}_${idx}_${cIdx}`;
            if (!comp.componentNumber) {
                // Priority: Supplier Part Number -> Generated ID
                if (comp.supplierPartNumber) {
                    comp.componentNumber = comp.supplierPartNumber;
                } else {
                    comp.componentNumber = `CMP-${order.internalOrderNumber}-${idx + 1}-${cIdx + 1}`;
                }
            }
            if (!comp.status) comp.status = 'NEW';
            if (!comp.statusUpdatedAt) comp.statusUpdatedAt = new Date().toISOString();
        });
    });

    // 4. Force Status Evaluation
    if (!skipStatusEval) {
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
        let minMargin = dbSettings.minimumMarginPct || 15;

        // CUSTOMER OVERRIDE: Check if customer has a specific minimum margin
        const customer = db.customers.find(c => c.name === order.customerName);
        if (customer && customer.minimumMarginPct !== undefined && customer.minimumMarginPct !== null) {
            minMargin = customer.minimumMarginPct;
        }

        // Skip margin check for Internal Stock orders (they always have 0 revenue)
        let nextStatus = order.status || OrderStatus.LOGGED;
        if (order.customerName !== 'Internal Stock') {
            nextStatus = evaluateMarginStatus(order.items, minMargin, order.status || OrderStatus.LOGGED);
        } else {
            // For Internal Stock, standard transitions apply (e.g. LOGGED -> TECH REVIEW if components exist)
            // We reuse evaluateMarginStatus logic BUT purely for workflow transitions, ignoring negative margin return
            // Actually, evaluateMarginStatus prioritizes margin check. Let's replicate strict workflow logic here or modify evaluateMarginStatus.
            // Simpler: Just allow negative margin if it's internal stock. 
            const calculatedStatus = evaluateMarginStatus(order.items, minMargin, order.status || OrderStatus.LOGGED);
            if (calculatedStatus === OrderStatus.NEGATIVE_MARGIN) {
                // Fallback: If it blocked on margin, check if it should proceed to Tech Review
                const hasComponents = (order.items || []).some(i => i.components && i.components.length > 0);
                if (hasComponents && order.status === OrderStatus.LOGGED) {
                    nextStatus = OrderStatus.TECHNICAL_REVIEW;
                }
            } else {
                nextStatus = calculatedStatus;
            }
        }

        if (nextStatus !== order.status) {
            const old = order.status || 'NEW';
            order.status = nextStatus;
            // Reset persistent violation flags on status transition
            order.loggingComplianceViolation = false;

            const reason = nextStatus === OrderStatus.NEGATIVE_MARGIN ? 'Margin Protection' : (isNew ? 'Initial Status' : 'Workflow Update');
            order.logs.push(createAuditLog(`[AUTO] ${reason}: Status moved from ${old} to ${nextStatus}`, nextStatus, 'System'));
        }

        // [AUTO] Procurement Complete Auto-Transition
        if (order.status === OrderStatus.WAITING_SUPPLIERS) {
            const hasItems = order.items && order.items.length > 0;
            if (hasItems) {
                // Check if ANY procurement component still needs action
                const anyStillInProcurement = order.items.some(item =>
                    (item.components || []).some(comp =>
                        comp.source === 'PROCUREMENT' && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(comp.status)
                    )
                );

                // Check for Standard Orders (At least one Reserved/Received to allow early manufacturing)
                const anyReservedOrReceived = order.items.some(item =>
                    (item.components || []).some(comp => ['RESERVED', 'RECEIVED', 'IN_STOCK'].includes(comp.status))
                );

                // Check for Stock Orders (Received/In Stock)
                const allReceived = order.items.every(item =>
                    (item.components || []).every(comp => ['RECEIVED', 'IN_STOCK'].includes(comp.status))
                );

                if (order.customerName === 'Internal Stock' && allReceived) {
                    const old = order.status;
                    order.status = OrderStatus.FULFILLED;
                    order.logs.push(createAuditLog(`[AUTO] Stock Replenishment Complete: All items in stock. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                } else if (order.customerName !== 'Internal Stock' && anyReservedOrReceived && !anyStillInProcurement) {
                    // Only transition to WAITING_FACTORY when NO components are still awaiting procurement
                    const old = order.status;
                    order.status = OrderStatus.WAITING_FACTORY;
                    order.logs.push(createAuditLog(`[AUTO] All procurement complete. Manufacturing enabled. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                }
            }
        }

        // [AUTO] Manufacturing Start Logic (Release to Floor)
        if (order.status === OrderStatus.MANUFACTURING) {
            (order.items || []).forEach(item => {
                (item.components || []).forEach(comp => {
                    // Deduct from stock if linked to inventory and not yet consumed
                    // Allow both STOCK and PROCUREMENT sources to be consumed if they have an inventory ID
                    if (comp.inventoryItemId && db.inventory && comp.source !== 'CONSUMED') {
                        const invItem = db.inventory.find(inv => inv.id === comp.inventoryItemId);
                        if (invItem) {
                            const consumedQty = comp.quantity || 0;
                            // Logic: Use quantityInStock (standard) or fallback to quantity (legacy)
                            const currentStock = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);

                            // Update Stock (physical)
                            // Note: quantityReserved will be handled automatically by reconcileInventory 
                            // because we change comp.source to 'CONSUMED' below.
                            invItem.quantityInStock = Math.max(0, currentStock - consumedQty);

                            // Clear legacy field if present to migrate
                            if (invItem.quantity !== undefined) delete invItem.quantity;

                            console.log(`[Inventory] [AUTO_MFG_START] Consumed ${consumedQty} of ${invItem.sku}. New InStock: ${invItem.quantityInStock}, New Reserved: ${invItem.quantityReserved}`);

                            order.logs.push(createAuditLog(
                                `[Inventory] Released ${consumedQty} units of ${invItem.sku} to Factory Floor.`,
                                order.status,
                                'System'
                            ));
                            comp.source = 'CONSUMED';
                        }
                    }
                });
            });
        }

        // [AUTO] Manufacturing Complete Logic
        if (order.status === OrderStatus.MANUFACTURING_COMPLETED) {
            (order.items || []).forEach(item => {
                item.status = 'Manufactured';
                (item.components || []).forEach(comp => {
                    if (comp.status !== OrderStatus.MANUFACTURED) {
                        comp.status = 'Manufactured';
                        comp.statusUpdatedAt = new Date().toISOString();
                    }

                    // AUTO-CONSUME any remaining STOCK components that missed the start trigger or were added later
                    if (comp.inventoryItemId && db.inventory && comp.source !== 'CONSUMED') {
                        const invItem = db.inventory.find(inv => inv.id === comp.inventoryItemId);
                        if (invItem) {
                            const consumedQty = comp.quantity || 0;
                            const currentStock = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);

                            invItem.quantityInStock = Math.max(0, currentStock - consumedQty);
                            // quantityReserved will be handled by reconcileInventory side-effect
                            if (invItem.quantity !== undefined) delete invItem.quantity;
                            
                            comp.source = 'CONSUMED';
                            console.log(`[Inventory] [AUTO_MFG_FINISH] Consumed ${consumedQty} of ${invItem.sku}.`);
                        }
                    }
                });
            });
        }
    }

    return order;
};

const sendEmail = async (to, subject, body, config) => {
    if (!config || !config.smtpServer) {
        console.warn("[Email] Configuration missing.");
        return { success: false, error: "SMTP configuration missing" };
    }

    const transporter = nodemailer.createTransport({
        host: config.smtpServer,
        port: config.smtpPort,
        secure: config.useSsl,
        auth: {
            user: config.username,
            pass: config.password,
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    try {
        await transporter.sendMail({
            from: `"${config.senderName}" <${config.senderEmail}>`,
            to: Array.isArray(to) ? to.join(',') : to,
            subject: subject,
            text: body,
            html: body.replace(/\n/g, '<br>')
        });
        console.log(`[Email] Alert sent to: ${to}`);
        return { success: true };
    } catch (err) {
        console.error("[Email] Send failed:", err.message);
        return { success: false, error: err.message };
    }
};

// --- AUDIT SERVICE ---

// Maps OrderStatus Ã¢â€ â€™ settings config key (hours-based time-in-status thresholds)
const STATUS_TO_THRESHOLD = {
    'LOGGED': 'orderEditTimeLimitHrs',
    'TECHNICAL_REVIEW': 'technicalReviewLimitHrs',
    'NEGATIVE_MARGIN': 'pendingOfferLimitHrs',
    'IN_HOLD': null, // event-based, not time-based
    'WAITING_SUPPLIERS': 'pendingOfferLimitHrs',
    'WAITING_FACTORY': 'waitingFactoryLimitHrs',
    'MANUFACTURING': 'mfgFinishLimitHrs',
    'MANUFACTURING_COMPLETED': 'mfgFinishLimitHrs',
    'UNDER_TEST': null, // skipped for now
    'TRANSITION_TO_STOCK': 'transitToHubLimitHrs',
    'IN_PRODUCT_HUB': 'productHubLimitHrs',
    'ISSUE_INVOICE': 'invoicedLimitHrs',
    'INVOICED': 'hubReleasedLimitHrs',
    'HUB_RELEASED': 'deliveryLimitHrs',
    'DELIVERY': 'deliveredLimitHrs',
    'PARTIAL_DELIVERY': 'deliveredLimitHrs',
    'DELIVERED': 'deliveredLimitHrs',
    'PARTIAL_PAYMENT': null  // handled by special payment SLA check
};

// Maps Component CompStatus Ã¢â€ â€™ settings config key (procurement process thresholds)
const COMP_STATUS_TO_THRESHOLD = {
    'PENDING_OFFER': 'pendingOfferLimitHrs',
    'RFP_SENT': 'rfpSentLimitHrs',
    'AWARDED': 'awardedLimitHrs',
    'ORDERED': 'orderedLimitHrs'
};

// Human-friendly labels for email subjects and logs
const THRESHOLD_LABELS = {
    orderEditTimeLimitHrs: 'Order Draft Window',
    technicalReviewLimitHrs: 'Tech Review Limit',
    pendingOfferLimitHrs: 'Pending Offer Limit',
    rfpSentLimitHrs: 'RFP Response Window',
    awardedLimitHrs: 'Award Review',
    issuePoLimitHrs: 'Issue PO Window',
    orderedLimitHrs: 'Supplier Fulfillment',
    waitingFactoryLimitHrs: 'Waiting Factory',
    mfgFinishLimitHrs: 'Manufacturing Run',
    transitToHubLimitHrs: 'Transit to Hub',
    productHubLimitHrs: 'Hub Processing',
    invoicedLimitHrs: 'Invoice Generation',
    hubReleasedLimitHrs: 'Hub Release Sync',
    deliveryLimitHrs: 'Delivery Transit',
    govEInvoiceLimitHrs: 'Gov. E-Invoice Request',
    deliveredLimitHrs: 'Post-Delivery Archiving',
    loggingDelayThresholdDays: 'Logging Delay (Compliance)',
    minimumMarginPct: 'Negative Margin',
    defaultPaymentSlaDays: 'Payment SLA Overdue'
};

const runThresholdAudit = async () => {
    console.debug(`[Audit] Routine check started at ${new Date().toISOString()}`);
    const db = readDb();
    const orders = db.orders || [];
    const notifications = db.notifications || [];
    const settings = resolveSettings(db);

    let dbChanged = false;

    // --- Generic alert dispatcher (deduplicates all notification logic) ---
    const sendAlertForOrder = async (order, journalKey, alertType, thresholdKey, subject, body) => {
        const alreadySent = notifications.some(n => n.journalKey === journalKey);
        if (alreadySent) return;

        const groupIds = settings.thresholdNotifications?.[thresholdKey] || [];
        if (groupIds.length === 0) return; // no groups assigned, skip silently

        const recipients = getRecipients(groupIds, db);
        if (!order.logs) order.logs = [];
        const label = THRESHOLD_LABELS[thresholdKey] || thresholdKey;

        if (recipients.length > 0) {
            const recipientEmails = recipients.map(r => r.email);

            const contextBlock = `\n\n--------------------------------------------------\n` +
                `Order Context:\n` +
                `Internal Ref: ${order.internalOrderNumber}\n` +
                `Customer: ${order.customerName}\n` +
                `PO Reference: ${order.customerReferenceNumber || 'N/A'}\n` +
                `--------------------------------------------------`;

            const fullBody = body + contextBlock;

            const result = await sendEmail(recipientEmails, subject, fullBody, settings.emailConfig);
            if (result.success) {
                notifications.push({ id: `nt_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, journalKey, orderId: order.id, type: alertType, sentAt: new Date().toISOString(), recipients: recipientEmails });
                recipients.forEach(r => {
                    order.logs.push({ timestamp: new Date().toISOString(), message: `[SYSTEM] ${label} Alert Sent to ${r.name} (${r.email}) via group: ${r.groupName}`, status: order.status, user: 'System' });
                });
                dbChanged = true;
            }
        } else {
            order.logs.push({ timestamp: new Date().toISOString(), message: `[SYSTEM] [ALERT_FAILED] No recipients for ${label} alert. Groups: ${groupIds.join(', ')}`, status: order.status, user: 'System' });
            notifications.push({ id: `nt_err_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, journalKey, orderId: order.id, type: `${alertType}_error`, sentAt: new Date().toISOString(), recipients: [] });
            dbChanged = true;
        }
    };

    // --- Process each order ---
    for (const order of orders) {
        if (order.status === 'FULFILLED' || order.status === 'REJECTED') continue;

        // A0. Gov. E-Invoice SLA (3-hr threshold)
        if (order.einvoiceRequested && !order.einvoiceFile) {
            const limitHrs = settings.govEInvoiceLimitHrs || 3;
            const requestLog = [...(order.logs || [])].reverse().find(l => l.message === 'Gov. E-Invoice requested');
            if (requestLog) {
                const elapsedHrs = (Date.now() - new Date(requestLog.timestamp).getTime()) / (1000 * 60 * 60);
                if (elapsedHrs > limitHrs) {
                    await sendAlertForOrder(order, `einvoice_sla_${order.id}`, 'einvoice_sla', 'govEInvoiceLimitHrs',
                        `[NEXUS] E-Invoice SLA Overdue: ${order.internalOrderNumber}`,
                        `Order ${order.internalOrderNumber} has a pending Gov. E-Invoice request for ${elapsedHrs.toFixed(1)} hours, exceeding the ${limitHrs}h threshold.`);
                }
            }
        }

        // A1. Logging Delay (PO date vs data entry date, in days) - Only for LOGGED orders
        if (order.status === OrderStatus.LOGGED) {
            const delayThresholdDays = settings.loggingDelayThresholdDays || 1;
            const poDate = new Date(order.orderDate).getTime();
            const entryDate = new Date(order.dataEntryTimestamp).getTime();
            const delayDays = (entryDate - poDate) / (1000 * 60 * 60 * 24);
            if (delayDays > delayThresholdDays) {
                if (!order.loggingComplianceViolation) { order.loggingComplianceViolation = true; dbChanged = true; }
                await sendAlertForOrder(order, `delay_${order.id}`, 'logging_delay', 'loggingDelayThresholdDays',
                    `[NEXUS] Compliance Alert: Logging Delay - ${order.internalOrderNumber}`,
                    `Order ${order.internalOrderNumber} was logged ${delayDays.toFixed(1)} days after the PO date, exceeding the ${delayThresholdDays}-day threshold.`);
            }
        }

        // A2. New Order Alert
        if (settings.enableNewOrderAlerts) {
            const jk = `new_order_${order.id}`;
            if (!notifications.some(n => n.journalKey === jk)) {
                const groupIds = settings.newOrderAlertGroupIds || [];
                const recipients = getRecipients(groupIds, db);
                if (!order.logs) order.logs = [];
                if (recipients.length > 0) {
                    const emails = recipients.map(r => r.email);

                    const contextBlock = `\n\n--------------------------------------------------\n` +
                        `Order Context:\n` +
                        `Internal Ref: ${order.internalOrderNumber}\n` +
                        `Customer: ${order.customerName}\n` +
                        `PO Reference: ${order.customerReferenceNumber || 'N/A'}\n` +
                        `--------------------------------------------------`;

                    const body = `A new order ${order.internalOrderNumber} has been logged.` + contextBlock;

                    const result = await sendEmail(emails, `[NEXUS] New Order: ${order.internalOrderNumber}`, body, settings.emailConfig);
                    if (result.success) {
                        notifications.push({ id: `nt_n_${Date.now()}`, journalKey: jk, orderId: order.id, type: 'new_order', sentAt: new Date().toISOString(), recipients: emails });
                        recipients.forEach(r => { order.logs.push({ timestamp: new Date().toISOString(), message: `[SYSTEM] New Order Notification Sent to ${r.name} (${r.email}) via group: ${r.groupName}`, status: order.status, user: 'System' }); });
                        dbChanged = true;
                    }
                } else {
                    order.logs.push({ timestamp: new Date().toISOString(), message: `[SYSTEM] [ALERT_FAILED] No recipients for new order alert. Groups: ${groupIds.join(', ')}`, status: order.status, user: 'System' });
                    notifications.push({ id: `nt_err_n_${Date.now()}`, journalKey: jk, orderId: order.id, type: 'new_order_error', sentAt: new Date().toISOString(), recipients: [] });
                    dbChanged = true;
                }
            }
        }

        // A3. IN_HOLD notification (event-based, like new order alert)
        if (order.status === 'IN_HOLD') {
            await sendAlertForOrder(order, `in_hold_${order.id}`, 'in_hold', 'pendingOfferLimitHrs',
                `[NEXUS] Order On Hold: ${order.internalOrderNumber}`,
                `Order ${order.internalOrderNumber} has been placed ON HOLD. Customer: ${order.customerName}.`);
        }

        // A4. Negative Margin (status-based, not time-based)
        if (order.status === 'NEGATIVE_MARGIN') {
            let totalRevenue = 0, totalCost = 0;
            (order.items || []).forEach(it => {
                totalRevenue += (it.quantity * it.pricePerUnit);
                (it.components || []).forEach(c => { totalCost += (c.quantity * (c.unitCost || 0)); });
            });
            const markupPct = totalCost > 0 ? ((totalRevenue - totalCost) / totalCost) * 100 : (totalRevenue > 0 ? 100 : 0);

            let effectiveMin = settings.minimumMarginPct || 15;
            const customer = db.customers.find(c => c.name === order.customerName);
            if (customer && customer.minimumMarginPct !== undefined && customer.minimumMarginPct !== null) {
                effectiveMin = customer.minimumMarginPct;
            }

            await sendAlertForOrder(order, `margin_${order.id}`, 'negative_margin', 'minimumMarginPct',
                `[NEXUS] Margin Alert: ${order.internalOrderNumber} below ${effectiveMin}%`,
                `Order ${order.internalOrderNumber} has a margin of ${markupPct.toFixed(1)}%, below the minimum threshold of ${effectiveMin}%.`);
        }

        // A5. Payment SLA Overdue (days since invoice)
        if (order.status === 'INVOICED' || order.status === 'DELIVERED' || order.status === 'PARTIAL_PAYMENT') {
            const slaDays = order.paymentSlaDays || settings.defaultPaymentSlaDays || 30;
            const invoiceLog = [...(order.logs || [])].reverse().find(l => l.status === 'INVOICED' || l.status === 'DELIVERED');
            if (invoiceLog) {
                const daysSince = (Date.now() - new Date(invoiceLog.timestamp).getTime()) / (1000 * 60 * 60 * 24);
                if (daysSince > slaDays) {
                    await sendAlertForOrder(order, `payment_sla_${order.id}`, 'payment_sla', 'defaultPaymentSlaDays',
                        `[NEXUS] Payment Overdue: ${order.internalOrderNumber}`,
                        `Order ${order.internalOrderNumber} is ${daysSince.toFixed(0)} days since invoice, exceeding the SLA of ${slaDays} days.`);
                }
            }
        }

        // A6. Delivery Deadline Check
        if (settings.enableDeliveryAlerts && order.targetDeliveryDate && ![OrderStatus.DELIVERED, OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(order.status)) {
            const warningDays = settings.deliveryWarningDays ?? 5;
            const targetTime = new Date(order.targetDeliveryDate).getTime();

            // Use current date but midnight to be fair on day comparison
            const now = new Date();
            now.setUTCHours(0, 0, 0, 0);

            const diffDays = Math.ceil((targetTime - now.getTime()) / (1000 * 60 * 60 * 24));

            if (diffDays < 0) {
                // Deadline Passed
                await sendAlertForOrder(order, `delivery_passed_${order.id}`, 'delivery_passed', 'deliveryWarningDays', // reuse warning limit config key for groups
                    `[NEXUS] Delivery Deadline Passed: ${order.internalOrderNumber}`,
                    `Order ${order.internalOrderNumber} has passed its target delivery date of ${order.targetDeliveryDate}. It is currently ${Math.abs(diffDays)} days overdue.`);
            } else if (diffDays <= warningDays) {
                // Approaching Deadline
                await sendAlertForOrder(order, `delivery_warning_${diffDays}_${order.id}`, 'delivery_warning', 'deliveryWarningDays',
                    `[NEXUS] Delivery Deadline Approaching: ${order.internalOrderNumber}`,
                    `Order ${order.internalOrderNumber} is approaching its target delivery date of ${order.targetDeliveryDate}. It is due in ${diffDays} days.`);
            }
        }

        // B. DYNAMIC: Order-level time-in-status threshold checks
        const thresholdKey = STATUS_TO_THRESHOLD[order.status];
        if (thresholdKey) {
            const limitHrs = settings[thresholdKey];
            const groupIds = settings.thresholdNotifications?.[thresholdKey] || [];
            if (limitHrs > 0 && groupIds.length > 0) {
                const lastStatusLog = [...(order.logs || [])].reverse().find(l => l.status === order.status);
                const statusEnteredAt = lastStatusLog ? new Date(lastStatusLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
                const elapsedHrs = (Date.now() - statusEnteredAt) / (1000 * 60 * 60);
                if (elapsedHrs > limitHrs) {
                    const label = THRESHOLD_LABELS[thresholdKey] || thresholdKey;
                    await sendAlertForOrder(order, `threshold_${thresholdKey}_${order.id}`, `threshold_${thresholdKey}`, thresholdKey,
                        `[NEXUS] ${label} Exceeded: ${order.internalOrderNumber}`,
                        `Order ${order.internalOrderNumber} has been in "${order.status}" for ${elapsedHrs.toFixed(1)} hours, exceeding the ${limitHrs}h limit (${label}).`);
                }
            }
        }

        // B2. Line-item-aware threshold checks (for mixed status orders)
        for (const item of (order.items || [])) {
            const effectiveStatus = getItemEffectiveStatus(item);
            // Only check if the item's effective status differs from the overall order status and isn't MIXED or NO_COMPONENTS
            if (effectiveStatus !== order.status && !['MIXED', 'NO_COMPONENTS'].includes(effectiveStatus)) {
                const itemThresholdKey = STATUS_TO_THRESHOLD[effectiveStatus];
                if (itemThresholdKey) {
                    const limitHrs = settings[itemThresholdKey];
                    const groupIds = settings.thresholdNotifications?.[itemThresholdKey] || [];
                    if (limitHrs > 0 && groupIds.length > 0) {
                        // For items we use strict component-level timing, taking the latest status entry among its components
                        const latestCompTime = Math.max(...(item.components || []).map(c => 
                            c.statusUpdatedAt ? new Date(c.statusUpdatedAt).getTime() : 0
                        ));
                        if (latestCompTime > 0) {
                            const elapsedHrs = (Date.now() - latestCompTime) / (1000 * 60 * 60);
                            if (elapsedHrs > limitHrs) {
                                const label = THRESHOLD_LABELS[itemThresholdKey] || itemThresholdKey;
                                const itemJournalKey = `item_threshold_${itemThresholdKey}_${order.id}_${item.id}`;
                                await sendAlertForOrder(order, itemJournalKey, `item_threshold_${itemThresholdKey}`, itemThresholdKey,
                                    `[NEXUS] ${label} Exceeded (Line Item): ${order.internalOrderNumber}`,
                                    `Line Item "${item.description}" in order ${order.internalOrderNumber} has effectively been in "${effectiveStatus}" for ${elapsedHrs.toFixed(1)} hours, exceeding the ${limitHrs}h limit (${label}).`);
                            }
                        }
                    }
                }
            }
        }

        // C. DYNAMIC: Component-level procurement threshold checks
        for (const item of (order.items || [])) {
            for (const comp of (item.components || [])) {
                const compThresholdKey = COMP_STATUS_TO_THRESHOLD[comp.status];
                if (!compThresholdKey) continue;

                const limitHrs = settings[compThresholdKey];
                const groupIds = settings.thresholdNotifications?.[compThresholdKey] || [];
                if (!limitHrs || limitHrs <= 0 || groupIds.length === 0) continue;

                const statusEnteredAt = comp.statusUpdatedAt ? new Date(comp.statusUpdatedAt).getTime() : (comp.procurementStartedAt ? new Date(comp.procurementStartedAt).getTime() : 0);
                if (statusEnteredAt === 0) continue;

                const elapsedHrs = (Date.now() - statusEnteredAt) / (1000 * 60 * 60);
                if (elapsedHrs > limitHrs) {
                    const label = THRESHOLD_LABELS[compThresholdKey] || compThresholdKey;
                    // For Supplier Fulfillment (ORDERED status), make alerts recurring once per day
                    const dateSuffix = compThresholdKey === 'orderedLimitHrs' ? `_${new Date().toISOString().split('T')[0]}` : '';
                    const journalKey = `comp_${compThresholdKey}_${order.id}_${item.id}_${comp.id}${dateSuffix}`;
                    await sendAlertForOrder(order, journalKey, `comp_${compThresholdKey}`, compThresholdKey,
                        `[NEXUS] ${label} Exceeded: ${order.internalOrderNumber} / ${comp.componentNumber || comp.description}`,
                        `Component "${comp.description}" (${comp.componentNumber || 'N/A'}) in order ${order.internalOrderNumber}, item "${item.description}", ` +
                        `has been in "${comp.status}" for ${elapsedHrs.toFixed(1)} hours, exceeding the ${limitHrs}h limit (${label}).`);
                }
            }
        }
    }

    if (dbChanged) {
        db.notifications = notifications;
        writeDb(db);
    }
};

// --- APP SETUP ---
const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
// Crash Logger for debugging frontend blank screens
app.get('/api/log-crash', (req, res) => {
    console.log('\n\nðŸš¨ FRONTEND CRASH ðŸš¨\n', req.query.err, '\n\n');
    res.send('ok');
});

app.use(express.static(path.join(__dirname, 'dist')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- HEALTH CHECK HELPER ---
const calculateOrderHealth = (order, settings) => {
    let isOverdue = false;

    // 1. Check Order Level Threshold
    const limitKey = STATUS_TO_THRESHOLD[order.status];
    if (limitKey) {
        const limitHrs = settings[limitKey];
        if (limitHrs > 0) {
            const logs = order.logs || [];
            let earliestLog = null;
            // Iterate backwards to find the start of the current status block
            for (let i = logs.length - 1; i >= 0; i--) {
                if (logs[i].status === order.status) {
                    earliestLog = logs[i];
                } else {
                    break;
                }
            }
            const statusEnteredAt = earliestLog ? new Date(earliestLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
            const elapsedHrs = (Date.now() - statusEnteredAt) / (1000 * 60 * 60);



            if (elapsedHrs > limitHrs) isOverdue = true;
        }
    }

    // 2. Check Component Level Thresholds (Procurement)
    if (!isOverdue) {
        for (const item of (order.items || [])) {
            for (const comp of (item.components || [])) {
                const compLimitKey = COMP_STATUS_TO_THRESHOLD[comp.status];
                if (compLimitKey) {
                    const limitHrs = settings[compLimitKey];
                    if (limitHrs > 0) {
                        const statusEnteredAt = comp.statusUpdatedAt ? new Date(comp.statusUpdatedAt).getTime() : (comp.procurementStartedAt ? new Date(comp.procurementStartedAt).getTime() : 0);
                        if (statusEnteredAt > 0) {
                            const elapsedHrs = (Date.now() - statusEnteredAt) / (1000 * 60 * 60);
                            if (elapsedHrs > limitHrs) {
                                isOverdue = true;
                                break;
                            }
                        }
                    }
                }
            }
            if (isOverdue) break;
        }
    }

    return { ...order, isOverdue };
};

// --- GENERIC CRUD ---
const getCollection = (col) => (req, res) => {
    const db = readDb();
    if (col === 'users') return res.json((db[col] || []).map(({ password, ...u }) => u));

    if (col === 'orders') {
        const settings = resolveSettings(db);
        return res.json((db[col] || []).map(o => calculateOrderHealth(o, settings)));
    }

    // Decrypt sensitive settings before sending to frontend
    if (col === 'settings') {
        return res.json((db[col] || []).map(s => decryptSettings(s)));
    }

    res.json(db[col] || []);
};

const getItemFromCollection = (col) => (req, res) => {
    const db = readDb();
    const item = (db[col] || []).find(it => it.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (col === 'users') {
        const { password, ...safe } = item;
        return res.json(safe);
    }
    if (col === 'orders') {
        const settings = resolveSettings(db);
        return res.json(calculateOrderHealth(item, settings));
    }
    res.json(item);
};

const addToCollection = (col) => (req, res) => {
    const db = readDb();
    if (!db[col]) db[col] = [];

    // Specialized validation for orders: prevent duplicate PO IDs
    if (col === 'orders' && req.body.customerReferenceNumber) {
        const poId = req.body.customerReferenceNumber.trim().toLowerCase();
        // Check for duplicates, but ignore REJECTED orders
        const isDuplicate = db[col].some(o =>
            o.customerReferenceNumber?.trim().toLowerCase() === poId &&
            o.status !== 'REJECTED'
        );
        if (isDuplicate) {
            return res.status(400).json({ error: `Duplicate PO ID: "${req.body.customerReferenceNumber}" already exists.` });
        }
    }

    let newItem = { id: `${col}_${Date.now()}`, ...req.body };
    const user = req.headers['x-user'] || 'System';

    if (col === 'users' && newItem.password) newItem.password = hashPassword(newItem.password);

    if (col === 'orders') {
        newItem = processedOrderInternal(newItem, db, user, true, null);
        reconcileInventory(null, newItem, db);
    }

    if (['customers', 'suppliers', 'inventory', 'users', 'userGroups', 'settings'].includes(col)) {
        if (!newItem.logs) newItem.logs = [createAuditLog('Entity registered', undefined, user)];
        if (col === 'suppliers' && !newItem.priceList) newItem.priceList = [];
    }

    db[col].push(newItem);
    if (writeDb(db)) res.status(201).json(col === 'users' ? (({ password, ...u }) => u)(newItem) : newItem);
    else res.status(500).json({ error: "Write failed" });
};

const updateInCollection = (col) => (req, res) => {
    const db = readDb();
    if (!db[col]) return res.status(404).json({ error: "Not found" });
    const index = db[col].findIndex(it => it.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Item not found" });

    const user = req.headers['x-user'] || 'System';
    const oldItem = db[col][index];
    let updated = { ...oldItem, ...req.body };

    if (col === 'users' && req.body.password) updated.password = hashPassword(req.body.password);

    // Encrypt sensitive settings before storing
    if (col === 'settings') {
        updated = encryptSettings(updated);
    }

    if (col === 'orders') {
        updated = processedOrderInternal(updated, db, user, false, oldItem);
        reconcileInventory(oldItem, updated, db);
        if (!req.body.status) {
            updated.logs.push(createAuditLog('Order modified', updated.status, user));
        }
    }

    if (col === 'customers' || col === 'suppliers') {
        if (!updated.logs) updated.logs = [];
        updated.logs.push(createAuditLog('Profile updated', undefined, user));

        if (updated.isHold !== oldItem.isHold) {
            updated.logs.push(createAuditLog(`${updated.isHold ? 'Hold Engaged' : 'Hold Released'}: ${updated.holdReason || 'Manual update'}`, undefined, user));
        }
        if (updated.isBlacklisted !== oldItem.isBlacklisted) {
            updated.logs.push(createAuditLog(`${updated.isBlacklisted ? 'Blacklisted' : 'Blacklist Removed'}: ${updated.blacklistReason || 'Manual update'}`, undefined, user));
        }
    }

    if (['inventory', 'users', 'userGroups', 'settings'].includes(col)) {
        if (!updated.logs) updated.logs = [];
        updated.logs.push(createAuditLog('Record updated', undefined, user));
    }

    db[col][index] = updated;
    if (writeDb(db)) res.json(col === 'users' ? (({ password, ...u }) => u)(updated) : updated);
    else res.status(500).json({ error: "Update failed" });
};

const deleteFromCollection = (col) => (req, res) => {
    const db = readDb();
    if (!db[col]) return res.status(404).json({ error: "Not found" });
    db[col] = db[col].filter(it => it.id !== req.params.id);
    if (writeDb(db)) res.json({ message: "Deleted" });
    else res.status(500).json({ error: "Delete failed" });
};

// --- ROUTES ---
app.get('/api/v1/procurement/history', (req, res) => {
    const { description, partNumber } = req.query;
    if (!description && !partNumber) return res.status(400).json({ error: "Search criteria required" });

    const db = readDb();
    const history = [];

    (db.orders || []).forEach(order => {
        (order.items || []).forEach(item => {
            (item.components || []).forEach(comp => {
                // Focus on ordered/fulfilled components
                if (!['ORDERED', 'RECEIVED', 'RESERVED', 'CONSUMED', 'Manufactured'].includes(comp.status)) return;

                const matchDesc = description && comp.description?.toLowerCase().includes(description.toLowerCase());
                const matchPart = partNumber && (
                    comp.componentNumber?.toLowerCase().includes(partNumber.toLowerCase()) ||
                    comp.supplierPartNumber?.toLowerCase().includes(partNumber.toLowerCase())
                );

                if (matchDesc || matchPart) {
                    const supplier = (db.suppliers || []).find(s => s.id === comp.supplierId);
                    history.push({
                        date: comp.statusUpdatedAt || order.orderDate,
                        price: comp.unitCost,
                        quantity: comp.quantity,
                        supplierName: supplier ? supplier.name : (comp.supplierName || 'Unknown'),
                        orderNumber: order.internalOrderNumber,
                        poNumber: comp.poNumber
                    });
                }
            });
        });
    });

    // Sort by date descending
    history.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(history.slice(0, 20)); // Limit to last 20 records
});

app.post('/api/v1/customers/merge', (req, res) => {
    try {
        const { primaryId, secondaryIds } = req.body;
        console.log(`[Merge] Attempting to merge clusters into ${primaryId}. Secondaries:`, secondaryIds);

        if (!primaryId || !secondaryIds || !Array.isArray(secondaryIds)) {
            return res.status(400).json({ error: "Missing merge parameters" });
        }

        const db = readDb();
        const primary = db.customers.find(c => c.id === primaryId);
        if (!primary) return res.status(404).json({ error: "Primary customer not found" });

        const user = req.headers['x-user'] || 'System';
        const secondaryNames = [];
        const deletedIds = [];

        // Identify secondary customers and their names
        secondaryIds.forEach(id => {
            const idx = db.customers.findIndex(c => c.id === id);
            if (idx !== -1) {
                secondaryNames.push(db.customers[idx].name);
                deletedIds.push(id);
                db.customers.splice(idx, 1);
            }
        });

        if (deletedIds.length === 0) return res.status(400).json({ error: "No valid secondary customers found" });

        // Migrate Orders
        let ordersMigrated = 0;
        db.orders.forEach(order => {
            if (secondaryNames.includes(order.customerName)) {
                order.customerName = primary.name;
                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(`Customer record migrated to ${primary.name} due to merge`, order.status, user));
                ordersMigrated++;
            }
        });

        // Audit log for primary customer
        if (!primary.logs) primary.logs = [];
        primary.logs.push(createAuditLog(`Merged ${deletedIds.length} duplicate records. Migrated ${ordersMigrated} orders.`, undefined, user));

        if (writeDb(db)) {
            console.log(`[Merge] Success. Deleted ${deletedIds.length} records, migrated ${ordersMigrated} orders.`);
            res.json({
                message: `Successfully merged ${deletedIds.length} customers and migrated ${ordersMigrated} orders.`,
                deletedIds
            });
        } else {
            console.error(`[Merge] Database write failed.`);
            res.status(500).json({ error: "Failed to save changes to database" });
        }
    } catch (e) {
        console.error(`[Merge] UNEXPECTED ERROR:`, e);
        res.status(500).json({ error: `Server error: ${e.message}` });
    }
});

const COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'notifications', 'settings', 'modules', 'ledger'];
COLLECTIONS.forEach(col => {
    app.get(`/api/v1/${col}`, getCollection(col));
    app.get(`/api/v1/${col}/:id`, getItemFromCollection(col));
    app.post(`/api/v1/${col}`, addToCollection(col));
    app.put(`/api/v1/${col}/:id`, updateInCollection(col));
    app.delete(`/api/v1/${col}/:id`, deleteFromCollection(col));
});


app.post('/api/v1/wipe', (req, res) => {
    const db = readDb();
    const BUSINESS_COLLECTIONS = ['orders', 'inventory', 'procurement', 'notifications'];
    BUSINESS_COLLECTIONS.forEach(col => {
        db[col] = [];
    });
    if (writeDb(db)) res.json({ message: "Wipe successful" });
    else res.status(500).json({ error: "Wipe failed" });
});

app.post('/api/v1/orders/:id/dispatch-action', async (req, res) => {
    const { action, payload } = req.body;
    const db = readDb();
    const index = db.orders.findIndex(it => it.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Order not found" });

    const user = req.headers['x-user'] || 'System';
    let order = db.orders[index];
    const oldStatus = order.status;
    const settings = resolveSettings(db);

    // --- LOCAL HELPER TO FIX SCOPE ISSUES ---
    const updateInventoryItem = (db, comp, action, order, receiveQty) => {
        if (!db.inventory) db.inventory = [];
        // Try to find existing inventory item by ID (if linked) or Description/PartNumber
        let invItem = db.inventory.find(i => i.id === comp.inventoryItemId);
        if (!invItem) {
            invItem = db.inventory.find(i => (i.sku && i.sku === comp.componentNumber) || (i.description === comp.description));
        }
        if (action === 'RECEIVE') {
            const qtyToIncr = receiveQty !== undefined ? receiveQty : (comp.quantity || 0);
            if (!invItem) {
                invItem = {
                    id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    description: comp.description,
                    sku: comp.componentNumber || `SKU-${Date.now()}`,
                    quantityInStock: 0,
                    quantityReserved: 0,
                    category: 'Uncategorized',
                    unit: comp.unit || 'Unit',
                    lastCost: comp.unitCost || 0,
                    minStockLevel: 0,
                    lastUpdated: new Date().toISOString()
                };
                db.inventory.push(invItem);
            }
            comp.inventoryItemId = invItem.id;
            const currentStock = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);
            invItem.quantityInStock = currentStock + qtyToIncr;
            // Migrate legacy
            if (invItem.quantity !== undefined) delete invItem.quantity;
            invItem.lastCost = comp.unitCost || invItem.lastCost || 0;
            invItem.lastUpdated = new Date().toISOString();
            invItem.poNumber = comp.poNumber;
            invItem.orderRef = order.internalOrderNumber;
            console.log(`[Inventory] Received: ${invItem.description}. Incoming: ${qtyToIncr}. Stock: ${invItem.quantityInStock}, Rsrv: ${invItem.quantityReserved}`);
        } else if (action === 'RELEASE') {
            if (invItem && (invItem.quantityReserved || 0) > 0) {
                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - (comp.quantity || 0));
                invItem.lastUpdated = new Date().toISOString();
                console.log(`[Inventory] Released Stock: ${invItem.description}. New Rsrv: ${invItem.quantityReserved}`);
            }
        }
    };

    try {
        // Save a copy of the order BEFORE any modifications for proper reconciliation
        const oldOrder = JSON.parse(JSON.stringify(order));

        switch (action) {
            case 'finalize-study':
                if (order.items.some(it => !it.isAccepted)) throw new Error("All items must be accepted before finalizing study");
                order.status = OrderStatus.WAITING_SUPPLIERS;
                order.logs.push(createAuditLog('Technical study finalized and pushed to Procurement', order.status, user));
                break;

            case 'rollback-to-logged':
                const rollbackOld = JSON.parse(JSON.stringify(order));
                order.status = OrderStatus.LOGGED;
                // Clear components and reset item approvals, but PRESERVE ORDERED_FOR_STOCK components
                // (these are in-transit to stock and will be received via Reception)
                order.items.forEach(item => {
                    item.components = (item.components || []).filter(c => c.status === 'ORDERED_FOR_STOCK');
                    item.isAccepted = false;
                });
                reconcileInventory(rollbackOld, order, db);
                order.logs.push(createAuditLog(`Rollback to Registry: ${payload?.reason || 'Manual rollback'} (BoM cleared & stock released)`, order.status, user));

                // Notification for Rollback
                if (settings && settings.enableRollbackAlerts) {
                    const groupIds = settings.rollbackAlertGroupIds || [];
                    const recipients = getRecipients(groupIds, db);
                    if (recipients.length > 0) {
                        const emails = recipients.map(r => r.email);
                        const emailRes = await sendEmail(emails, `[NEXUS] PO Rollback: ${order.internalOrderNumber}`,
                            `Order ${order.internalOrderNumber} has been rolled back from ${oldStatus} to LOGGED status.\nReason: ${payload?.reason || 'Manual rollback'}`,
                            settings.emailConfig);

                        if (emailRes.success) {
                            recipients.forEach(r => {
                                order.logs.push(createAuditLog(`[SYSTEM] Rollback Alert Sent to ${r.name} (${r.email}) via group: ${r.groupName}`, order.status, 'System'));
                            });
                        } else {
                            order.logs.push(createAuditLog(`[SYSTEM] Rollback Alert Failed: ${emailRes.error}`, order.status, 'System'));
                        }
                    }
                }
                break;

            case 'hard-delete-order':
                const userHeader = req.headers['x-user'] || 'System';
                console.log(`[AUTH-DEBUG] Hard Delete requested by user: "${userHeader}" (Resolved User: "${user}")`);
                
                let isAuthorized = false;
                // Shortcut: If username literally contains admin or manager, it's often a superuser setup
                if (user.toLowerCase().includes('admin') || user.toLowerCase().includes('manager')) {
                    isAuthorized = true;
                } else {
                    // Formal check in DB - case insensitive lookup
                    const lowerUser = user.toLowerCase();
                    const caller = (db.users || []).find(u => 
                        (u.username && u.username.toLowerCase() === lowerUser) || 
                        (u.name && u.name.toLowerCase() === lowerUser)
                    );
                    if (caller && (caller.roles.some(r => r.toLowerCase() === 'admin') || caller.roles.some(r => r.toLowerCase() === 'management'))) {
                        isAuthorized = true;
                    }
                }

                if (!isAuthorized) {
                    console.error(`[AUTH-FAILURE] Unauthorized hard-delete attempt by "${user}"`);
                    throw new Error("Unauthorized: Only superusers or management can hard delete an order");
                }

                // 1. Revert Inventory
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        const invItem = (db.inventory || []).find(i => i.id === comp.inventoryItemId);
                        if (invItem) {
                            if (comp.source === 'STOCK' && ['RESERVED', 'AVAILABLE'].includes(comp.status)) {
                                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - (comp.quantity || 0));
                            } else if (['RECEIVED', 'IN_STOCK', 'CONSUMED', 'Manufactured'].includes(comp.status)) {
                                if (comp.receivedQty && comp.receivedQty > 0) {
                                    invItem.quantityInStock = Math.max(0, (invItem.quantityInStock || 0) - comp.receivedQty);
                                }
                                if (comp.consumedQty && comp.consumedQty > 0) {
                                    invItem.quantityInStock = (invItem.quantityInStock || 0) + comp.consumedQty;
                                }
                            }
                            invItem.lastUpdated = new Date().toISOString();
                        }
                    });
                });

                // 2. Revert Supplier Payments allocated to this order
                if (db.supplierPayments) {
                    db.supplierPayments = db.supplierPayments.filter(payment => {
                        const hasOurOrder = payment.allocations?.some(a => a.orderId === order.id);
                        const hasOtherOrder = payment.allocations?.some(a => a.orderId !== order.id);
                        
                        if (hasOurOrder && !hasOtherOrder) {
                            return false; // Deleted entirely as it was exclusively for this PO
                        } else if (hasOurOrder && hasOtherOrder) {
                            const ourAmount = payment.allocations
                                .filter(a => a.orderId === order.id)
                                .reduce((sum, a) => sum + a.amount, 0);
                            payment.amount = Math.max(0, payment.amount - ourAmount);
                            payment.allocations = payment.allocations.filter(a => a.orderId !== order.id);
                            return payment.amount > 0;
                        }
                        return true;
                    });
                }

                // 3. Delete order and related traces completely
                db.orders = db.orders.filter(o => o.id !== order.id);
                if (db.notifications) {
                    db.notifications = db.notifications.filter(n => n.orderId !== order.id);
                }

                if (writeDb(db)) return res.json({ message: "Order permanently deleted" });
                else throw new Error("Database write failed");

            case 'reject-order':
                const today = new Date().toISOString().split('T')[0];
                const oldInternal = order.internalOrderNumber || '';
                const oldCustRef = order.customerReferenceNumber || '';
                
                // Rename both internal and customer reference numbers
                order.internalOrderNumber = `rej_${today}_${oldInternal}`;
                order.customerReferenceNumber = `rej_${today}_${oldCustRef}`;
                
                order.status = OrderStatus.REJECTED;
                // Release any reserved inventory back to free stock
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (['RESERVED', 'RECEIVED'].includes(comp.status)) {
                            updateInventoryItem(db, comp, 'RELEASE', order);
                            comp.status = 'IN_STOCK'; // Or specific status indicating released
                        }
                    });
                });
                order.logs.push(createAuditLog(`ORDER REJECTED: ${payload?.reason || 'Business decision'}. PO renamed from ${oldInternal} to ${order.internalOrderNumber}`, order.status, user));
                break;

            case 'toggle-acceptance': {
                const taItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (taItemIdx === -1) throw new Error("Item not found");
                const taItem = order.items[taItemIdx];
                taItem.isAccepted = !taItem.isAccepted;
                order.logs.push(createAuditLog(`Item ${taItem.orderNumber}: ${taItem.isAccepted ? 'Accepted' : 'Acceptance Revoked'}`, order.status, user));
                break;
            }

            case 'set-production-type': {
                const sptItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (sptItemIdx === -1) throw new Error("Item not found");
                const sptItem = order.items[sptItemIdx];
                const newType = payload.type; // 'MANUFACTURING' | 'TRADING' | 'OUTSOURCING'
                const oldType = sptItem.productionType || 'TRADING';
                
                sptItem.productionType = newType;
                
                if (newType === 'TRADING') {
                    // Release any existing reservations before clearing for Trading
                    (sptItem.components || []).forEach(comp => {
                        if (comp.source === 'STOCK' && comp.inventoryItemId && ['RESERVED', 'AVAILABLE'].includes(comp.status)) {
                            const invItem = (db.inventory || []).find(i => i.id === comp.inventoryItemId);
                            if (invItem) {
                                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - comp.quantity);
                                invItem.lastUpdated = new Date().toISOString();
                            }
                        }
                    });
                    // Clear components; processedOrderInternal will recreate the mirrored one automatically
                    sptItem.components = [];
                    order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to TRADING. Mirror sync enabled.`, order.status, user));
                } else {
                    if (oldType === 'TRADING') {
                        // The user switched OUT of TRADING. We must wipe the default mirror entry that was added.
                        sptItem.components = [];
                        order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to ${newType}. Removed TRADING mirror component.`, order.status, user));
                    } else {
                        order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to ${newType}.`, order.status, user));
                    }
                }

                break;
            }


            case 'receive-component': {
                const itemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (itemIdx === -1) throw new Error("Item not found");
                const compIdx = order.items[itemIdx].components?.findIndex(c => c.id === payload.compId);
                if (compIdx === -1) throw new Error("Component not found");

                const compToReceive = order.items[itemIdx].components[compIdx];
                const totalOrdered = compToReceive.quantity || 0;
                const alreadyReceived = compToReceive.receivedQty || 0;
                const leftToReceive = totalOrdered - alreadyReceived;

                const qtyToProcess = payload.qty !== undefined ? parseFloat(payload.qty) : leftToReceive;

                if (isNaN(qtyToProcess) || qtyToProcess <= 0) throw new Error("Invalid quantity received");
                if (qtyToProcess > leftToReceive) throw new Error(`Cannot receive more than ordered (Left: ${leftToReceive})`);

                updateInventoryItem(db, compToReceive, 'RECEIVE', order, qtyToProcess);

                compToReceive.receivedQty = alreadyReceived + qtyToProcess;
                if (compToReceive.receivedQty >= totalOrdered) {
                    compToReceive.status = order.customerName === 'Internal Stock' ? 'RECEIVED' : 'RESERVED';
                }
                compToReceive.statusUpdatedAt = new Date().toISOString();
                order.logs.push(createAuditLog(`Component Receipt: ${qtyToProcess} ${compToReceive.unit} of ${compToReceive.description} (Total Received: ${compToReceive.receivedQty}/${totalOrdered})`, order.status, user));
                break;
            }

            case 'convert-to-stock-order': {
                // Mark a component as ordered for stock â€” no inventory entry yet
                // The inventory entry will be created when the part is physically received via Reception
                const ctsItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ctsItemIdx === -1) throw new Error("Item not found");
                const ctsCompIdx = order.items[ctsItemIdx].components?.findIndex(c => c.id === payload.compId);
                if (ctsCompIdx === -1) throw new Error("Component not found");

                const ctsComp = order.items[ctsItemIdx].components[ctsCompIdx];
                ctsComp.status = 'ORDERED_FOR_STOCK';
                ctsComp.statusUpdatedAt = new Date().toISOString();
                order.logs.push(createAuditLog(`Component "${ctsComp.description}" converted to stock order (PO: ${ctsComp.poNumber || 'N/A'}) â€” awaiting supplier delivery via Reception`, order.status, user));
                break;
            }

            case 'add-component': {
                // Atomically add a component to an item with optional stock reservation
                const acItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (acItemIdx === -1) throw new Error("Item not found");
                const acItem = order.items[acItemIdx];
                if (!acItem.components) acItem.components = [];

                const newComp = {
                    id: `comp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    ...payload.component,
                    statusUpdatedAt: new Date().toISOString()
                };

                // Generate component number ONLY if not provided
                if (!newComp.componentNumber) {
                    // Priority: Supplier Part Number -> Generated ID
                    if (newComp.supplierPartNumber) {
                        newComp.componentNumber = newComp.supplierPartNumber;
                    } else {
                        const compCount = acItem.components.length;
                        newComp.componentNumber = `CMP-${order.internalOrderNumber}-${acItemIdx}-${compCount + 1}`;
                    }
                }

                // If STOCK source, check availability and reserve
                if (newComp.source === 'STOCK' && newComp.inventoryItemId) {
                    const invItem = (db.inventory || []).find(i => i.id === newComp.inventoryItemId);
                    if (invItem) {
                        const available = (invItem.quantityInStock || 0) - (invItem.quantityReserved || 0);
                        if (newComp.quantity > available) {
                            throw new Error(`Insufficient stock: only ${available} ${invItem.unit} available (${invItem.quantityInStock} in stock, ${invItem.quantityReserved || 0} reserved)`);
                        }
                        invItem.quantityReserved = (invItem.quantityReserved || 0) + newComp.quantity;
                        invItem.lastUpdated = new Date().toISOString();
                    }
                }

                acItem.components.push(newComp);
                order.logs.push(createAuditLog(`Component added: ${newComp.description} (${newComp.source})`, order.status, user));
                break;
            }

            case 'remove-component': {
                // Atomically remove a component and release any stock reservation
                const rcItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (rcItemIdx === -1) throw new Error("Item not found");
                const rcItem = order.items[rcItemIdx];
                const rcComp = rcItem.components?.find(c => c.id === payload.compId);
                if (!rcComp) throw new Error("Component not found");

                // Release reservation if STOCK component
                if (rcComp.source === 'STOCK' && rcComp.inventoryItemId && ['RESERVED', 'AVAILABLE'].includes(rcComp.status)) {
                    const invItem = (db.inventory || []).find(i => i.id === rcComp.inventoryItemId);
                    if (invItem) {
                        invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - rcComp.quantity);
                        invItem.lastUpdated = new Date().toISOString();
                    }
                }

                rcItem.components = rcItem.components?.filter(c => c.id !== payload.compId);
                order.logs.push(createAuditLog(`Component removed: ${rcComp.description}`, order.status, user));
                break;
            }

            case 'update-component': {
                // Atomically update component fields
                const ucItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ucItemIdx === -1) throw new Error("Item not found");
                const ucComp = order.items[ucItemIdx].components?.find(c => c.id === payload.compId);
                if (!ucComp) throw new Error("Component not found");
                Object.assign(ucComp, payload.updates);
                order.logs.push(createAuditLog(`Component updated: ${ucComp.description}`, order.status, user));
                break;
            }

            case 'cancel-component-po': {
                // Cancel a supplier PO and reset component for re-procurement
                const ccItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ccItemIdx === -1) throw new Error("Item not found");
                const ccComp = order.items[ccItemIdx].components?.find(c => c.id === payload.compId);
                if (!ccComp) throw new Error("Component not found");
                const oldPoNumber = ccComp.poNumber || 'N/A';
                const oldSupplier = ccComp.supplierName || ccComp.supplierId || 'N/A';
                // Reset to PENDING_OFFER so it re-enters the procurement pipeline
                ccComp.status = 'PENDING_OFFER';
                ccComp.statusUpdatedAt = new Date().toISOString();
                ccComp.procurementStartedAt = new Date().toISOString();
                // Clear supplier-related fields
                delete ccComp.supplierId;
                delete ccComp.supplierName;
                delete ccComp.poNumber;
                delete ccComp.awardId;
                delete ccComp.sendPoId;
                delete ccComp.rfpId;
                delete ccComp.rfpSupplierIds;
                ccComp.unitCost = 0;
                order.logs.push(createAuditLog(`Supplier PO cancelled for: ${ccComp.description} (PO: ${oldPoNumber}, Supplier: ${oldSupplier}). Component reset to PENDING_OFFER for re-procurement.`, order.status, user));
                // If order was past WAITING_SUPPLIERS, revert it since a component now needs procurement
                if ([OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING].includes(order.status)) {
                    const old = order.status;
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog(`[AUTO] Order reverted from ${old} to WAITING_SUPPLIERS: component requires re-procurement.`, order.status, 'System'));
                }
                break;
            }

            case 'send-rfp-batch': {
                const rfpId = Math.random().toString(36).substring(2, 9);
                if (!payload.components || !Array.isArray(payload.components)) throw new Error("components array required");

                let updatedCount = 0;
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (payload.components.includes(comp.id)) {
                            comp.status = 'RFP_SENT';
                            comp.rfpId = rfpId;
                            comp.statusUpdatedAt = new Date().toISOString();
                            updatedCount++;
                        }
                    });
                });
                order.logs.push(createAuditLog(`Sent RFP batch for ${updatedCount} components (RFP ID: ${rfpId})`, order.status, user));
                break;
            }

            case 'award-tender-batch': {
                const awardId = Math.random().toString(36).substring(2, 9);
                if (!payload.components || !Array.isArray(payload.components)) throw new Error("components array required");

                let updatedCount = 0;
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        const targetComponent = payload.components.find(c => c.id === comp.id);
                        if (targetComponent) {
                            comp.status = 'AWARDED';
                            comp.awardId = awardId;
                            comp.supplierId = payload.supplierId;
                            comp.supplierName = payload.supplierName;
                            comp.unitCost = targetComponent.unitCost || 0;
                            comp.taxPercent = payload.taxPercent || 14;
                            comp.leadTimeDays = payload.leadTimeDays;
                            comp.statusUpdatedAt = new Date().toISOString();
                            updatedCount++;
                        }
                    });
                });
                order.logs.push(createAuditLog(`Awarded Tender batch for ${updatedCount} components to ${payload.supplierName || payload.supplierId} (Award ID: ${awardId})`, order.status, user));
                break;
            }

            case 'issue-po-batch': {
                const sendPoId = Math.random().toString(36).substring(2, 9);
                if (!payload.components || !Array.isArray(payload.components)) throw new Error("components array required");

                let updatedCount = 0;
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (payload.components.includes(comp.id)) {
                            comp.status = 'ORDERED';
                            comp.sendPoId = sendPoId;
                            comp.poNumber = payload.poNumber;
                            comp.procurementStartedAt = new Date().toISOString();
                            comp.statusUpdatedAt = new Date().toISOString();
                            updatedCount++;
                        }
                    });
                });
                order.logs.push(createAuditLog(`Issued PO batch ${payload.poNumber} for ${updatedCount} components (PO Group ID: ${sendPoId})`, order.status, user));
                break;
            }

            case 'cancel-po-batch': {
                if (!payload.sendPoId) throw new Error("sendPoId required");
                let updatedCount = 0;
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (comp.sendPoId === payload.sendPoId && comp.status === 'ORDERED') {
                            comp.status = 'AWARDED';
                            delete comp.sendPoId;
                            delete comp.poNumber;
                            comp.statusUpdatedAt = new Date().toISOString();
                            updatedCount++;
                        }
                    });
                });
                order.logs.push(createAuditLog(`Cancelled PO batch for ${updatedCount} components (Former Group ID: ${payload.sendPoId})`, order.status, user));
                break;
            }

            case 'cancel-payment':
                if (!order.payments || !order.payments[payload.index]) throw new Error("Payment index not found");
                const [removed] = order.payments.splice(payload.index, 1);
                order.logs.push(createAuditLog(`Payment of ${removed.amount} VOIDED: ${payload.reason || 'Correction'}`, order.status, user));
                break;

            case 'toggle-hold':
                const isHold = payload?.hold;
                if (isHold) {
                    order.statusBeforeHold = order.status;
                    order.status = OrderStatus.IN_HOLD;
                    order.logs.push(createAuditLog(`Order placed in STRATEGIC HOLD: ${payload?.reason || 'No reason provided'}`, order.status, user));
                } else {
                    order.status = order.statusBeforeHold || OrderStatus.LOGGED;
                    order.logs.push(createAuditLog(`Order released from Hold to ${order.status}`, order.status, user));
                    delete order.statusBeforeHold;
                }
                break;

            case 'release-margin':
                if (order.status !== OrderStatus.NEGATIVE_MARGIN) throw new Error("Order does not have a margin block");
                order.status = OrderStatus.WAITING_SUPPLIERS; // Return to procurement flow
                order.logs.push(createAuditLog(`Margin block manually bypassed: ${payload?.reason || 'Management overrides'}`, order.status, user));
                break;

            case 'record-payment':
                if (!order.payments) order.payments = [];
                const paymentIndex = order.payments.length + 1;
                const receiptNumber = `RCV-${String(paymentIndex).padStart(3, '0')}`;
                order.payments.push({
                    amount: payload.amount,
                    date: new Date().toISOString(),
                    user,
                    memo: payload.memo || 'Regular payment',
                    receiptNumber
                });
                const totalPaid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
                const fullyPaid = isOrderFullyPaid(order);
                const fullyDelivered = isOrderFullyDelivered(order);
                const isLateStage = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED].includes(order.status);

                if (fullyPaid) {
                    if (isLateStage && fullyDelivered) {
                        order.status = OrderStatus.FULFILLED;
                        order.logs.push(createAuditLog(`Full payment reconciled${order.appliesWithholdingTax ? ' (with 1% WHT deducted)' : ''} & Delivery complete. Order lifecycle FULFILLED.`, order.status, user));
                    } else if (isLateStage && !fullyDelivered) {
                        order.logs.push(createAuditLog(`Full payment reconciled. Awaiting final delivery completion to FULFILL.`, order.status, user));
                    } else {
                        order.logs.push(createAuditLog(`Full payment received (Pre-payment)${order.appliesWithholdingTax ? ' (with 1% WHT deducted)' : ''}. Operational status '${order.status}' retained.`, order.status, user));
                    }
                } else {
                    let revenue = 0;
                    order.items.forEach(it => revenue += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));
                    let targetRevenue = revenue * (order.appliesWithholdingTax ? 0.99 : 1);
                    order.logs.push(createAuditLog(`Payment of ${payload.amount} recorded. Bal: ${Math.max(0, targetRevenue - totalPaid).toLocaleString()}`, order.status, user));
                }
                break;

            case 'start-production':
                order.status = OrderStatus.MANUFACTURING;
                order.logs.push(createAuditLog(`Production Started: Released to Floor`, order.status, user));
                break;

            case 'register-manufacturing':
                if (!payload.itemId || payload.qty === undefined) throw new Error("Item ID and quantity required");
                const mItem = order.items.find(i => i.id === payload.itemId);
                if (!mItem) throw new Error("Item not found");

                const prevQty = mItem.manufacturedQty || 0;
                const targetQty = mItem.quantity;
                const maxMfg = Math.max(0, targetQty - prevQty);

                if (payload.qty > maxMfg) {
                    throw new Error(`Cannot manufacture ${payload.qty} units. Only ${maxMfg} units remaining to meet target.`);
                }

                const actualPayloadQty = payload.qty;
                if (actualPayloadQty <= 0) break;

                mItem.manufacturedQty = prevQty + actualPayloadQty;
                order.logs.push(createAuditLog(`Manufactured ${actualPayloadQty} ${mItem.unit} of ${mItem.description} (${mItem.manufacturedQty}/${targetQty})`, order.status, user));

                // Component Release Logic: If fully manufactured and user confirmed release
                if (mItem.manufacturedQty >= targetQty && payload.confirmRelease) {
                    (mItem.components || []).forEach(comp => {
                        const allocated = comp.quantity || 0;
                        const consumed = comp.consumedQty || 0;
                        const remaining = Math.max(0, allocated - consumed);

                        if (remaining > 0) {
                            if (comp.source === 'STOCK' && comp.inventoryItemId) {
                                // Release reservation
                                const invItem = (db.inventory || []).find(inv => inv.id === comp.inventoryItemId);
                                if (invItem) {
                                    invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - remaining);
                                    invItem.lastUpdated = new Date().toISOString();
                                }
                            } else if (comp.source === 'PROCUREMENT' && (comp.status === 'RESERVED' || comp.status === 'RECEIVED')) {
                                // Return procurement to general stock
                                updateInventoryItem(db, comp, 'RECEIVE', order, remaining);
                            }
                            
                            // Adjust quantity to match consumed to preserve history
                            comp.quantity = consumed;
                            order.logs.push(createAuditLog(`[Factory] Released ${remaining.toFixed(2)} units of ${comp.description} back to stock.`, order.status, user));
                        }
                    });
                }

                // Auto-transition if all items are fully manufactured
                if (order.items.every(i => (i.manufacturedQty || 0) >= i.quantity)) {
                    order.status = OrderStatus.MANUFACTURING_COMPLETED;
                    order.logs.push(createAuditLog(`All items manufactured. Auto-transitioned to Ready for QC/Hub`, order.status, user));
                }
                break;

            case 'consume-factory-component':
                if (!payload.itemId || !payload.compId || !payload.qty) throw new Error("Item ID, Component ID and quantity required");
                const cfcItem = order.items.find(i => i.id === payload.itemId);
                if (!cfcItem) throw new Error("Item not found");
                const cfcComp = (cfcItem.components || []).find(c => c.id === payload.compId);
                if (!cfcComp) throw new Error("Component not found");

                const cfcTotalAllocated = cfcComp.quantity || 0;
                const cfcAlreadyConsumed = cfcComp.consumedQty || 0;
                const cfcRemaining = Math.max(0, cfcTotalAllocated - cfcAlreadyConsumed);

                if (payload.qty > cfcRemaining) {
                    throw new Error(`Cannot consume ${payload.qty} units. Only ${cfcRemaining} units remaining in allocation.`);
                }
                const cfcConsumedQty = payload.qty;
                if (cfcConsumedQty <= 0) throw new Error("Quantity must be greater than zero");

                // Deduct from inventory
                if (cfcComp.inventoryItemId && db.inventory) {
                    const cfcInvItem = db.inventory.find(inv => inv.id === cfcComp.inventoryItemId);
                    if (cfcInvItem) {
                        const currentStock = cfcInvItem.quantityInStock !== undefined ? cfcInvItem.quantityInStock : (cfcInvItem.quantity || 0);
                        if (cfcConsumedQty > currentStock) {
                            throw new Error(`Insufficient stock for component ${cfcComp.description}. Available: ${currentStock}, Requested: ${cfcConsumedQty}`);
                        }
                        cfcInvItem.quantityInStock = Math.max(0, currentStock - cfcConsumedQty);
                        if (cfcInvItem.quantity !== undefined) delete cfcInvItem.quantity;
                        console.log(`[Inventory] [CONSUME_COMP] Consumed ${cfcConsumedQty.toFixed(2)} of ${cfcInvItem.sku}. InStock: ${cfcInvItem.quantityInStock.toFixed(2)}, Reserved: ${cfcInvItem.quantityReserved.toFixed(2)}`);
                    }
                }

                cfcComp.consumedQty = cfcAlreadyConsumed + cfcConsumedQty;
                order.logs.push(createAuditLog(
                    `[Factory] Consumed ${cfcConsumedQty.toFixed(2)} units of ${cfcComp.description}. (${cfcComp.consumedQty.toFixed(2)}/${cfcTotalAllocated} total)`,
                    order.status,
                    user
                ));

                if (cfcComp.consumedQty >= cfcTotalAllocated) {
                    cfcComp.source = 'CONSUMED';
                }
                break;

            case 'finish-production':
                order.status = OrderStatus.MANUFACTURING_COMPLETED;
                order.logs.push(createAuditLog(`Production Finished: Ready for QC/Hub`, order.status, user));
                break;

            case 'receive-hub':
                order.status = OrderStatus.IN_PRODUCT_HUB;
                order.logs.push(createAuditLog(`PO Received at Product Hub: Ready for Invoicing`, order.status, user));
                break;

            case 'receive-hub-partial':
                if (!payload.receipts || !Array.isArray(payload.receipts)) throw new Error("Receipts array required");

                let intakeDetails = [];
                for (const rcpt of payload.receipts) {
                    const hItem = order.items.find(i => i.id === rcpt.itemId);
                    if (hItem && rcpt.qty > 0) {
                        const mfd = hItem.manufacturedQty || 0;
                        const alreadyHub = hItem.hubReceivedQty || 0;
                        const maxReceive = Math.max(0, mfd - alreadyHub);

                        if (rcpt.qty > maxReceive) {
                            throw new Error(`Cannot receive ${rcpt.qty} units of ${hItem.description}. Only ${maxReceive} units are ready / manufactured.`);
                        }

                        hItem.hubReceivedQty = alreadyHub + rcpt.qty;
                        intakeDetails.push(`${rcpt.qty} ${hItem.unit} of ${hItem.description}`);
                    }
                }
                if (intakeDetails.length > 0) {
                    order.logs.push(createAuditLog(`Hub Intake: ${intakeDetails.join(', ')}`, order.status, user));
                }

                // Auto-transition if all items are fully received by hub
                if (order.items.every(i => (i.hubReceivedQty || 0) >= i.quantity)) {
                    order.status = OrderStatus.IN_PRODUCT_HUB;
                    order.logs.push(createAuditLog(`All items received at Hub. Auto-transitioned to Ready for Invoicing`, order.status, user));
                }
                break;

            case 'issue-invoice':
                order.status = OrderStatus.INVOICED;
                if (!order.invoiceNumber) {
                    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
                    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    order.invoiceNumber = `INV-${datePart}-${randomPart}`;
                }
                order.logs.push(createAuditLog(`Official Tax Invoice Generated: ${order.invoiceNumber}`, order.status, user));
                break;

            case 'approve-dispatch-receipt': {
                // Finance adding receipt for dispatch
                if (!payload.items || !Array.isArray(payload.items)) throw new Error("Items array required");

                let approvalDetails = [];
                for (const reqItem of payload.items) {
                    const oItem = order.items.find(i => i.id === reqItem.itemId);
                    if (oItem && reqItem.qty > 0) {
                        const currentApproved = oItem.approvedForDispatchQty || 0;
                        const totalWillBeApproved = currentApproved + reqItem.qty;

                        const hubReceived = oItem.hubReceivedQty || 0;
                        if (totalWillBeApproved > hubReceived) {
                            throw new Error(`Cannot receipt ${reqItem.qty} for ${oItem.description}. The total authorized amount (${totalWillBeApproved}) would exceed the items currently available in the hub (${hubReceived}).`);
                        }

                        oItem.approvedForDispatchQty = totalWillBeApproved;
                        approvalDetails.push(`${reqItem.qty} ${oItem.unit} of ${oItem.description}`);
                    }
                }
                if (approvalDetails.length > 0) {
                    order.logs.push(createAuditLog(`Finance Partial Receipt for Dispatch: ${approvalDetails.join(', ')}`, order.status, user));
                }
                break;
            }

            case 'release-delivery': {
                // Shipment dispatching goods
                if (!payload.items || !Array.isArray(payload.items)) throw new Error("Items array required to dispatch.");

                let dispatchDetails = [];
                for (const dItem of payload.items) {
                    const oItem = order.items.find(i => i.id === dItem.itemId);
                    if (oItem && dItem.qty > 0) {
                        const dispatched = oItem.dispatchedQty || 0;
                        const approved = oItem.approvedForDispatchQty || 0;
                        const inHub = oItem.hubReceivedQty || 0;

                        if (dItem.qty > (approved - dispatched)) {
                            throw new Error(`Cannot dispatch ${dItem.qty} units of ${oItem.description}. Finance receipt required. Only ${approved - dispatched} units are financially cleared.`);
                        }
                        if (dItem.qty > (inHub - dispatched)) {
                            throw new Error(`Cannot dispatch ${dItem.qty} units of ${oItem.description}. Only ${inHub - dispatched} units available in hub.`);
                        }

                        oItem.dispatchedQty = dispatched + dItem.qty;
                        dispatchDetails.push(`${dItem.qty} ${oItem.unit} of ${oItem.description}`);
                    }
                }

                if (dispatchDetails.length === 0) throw new Error("No valid items to dispatch.");

                // If ALL items are fully dispatched, move to HUB_RELEASED. Otherwise, keep INVOICED or PARTIAL status.
                const allDispatched = order.items.every(i => (i.dispatchedQty || 0) >= i.quantity);
                if (allDispatched) {
                    order.status = OrderStatus.HUB_RELEASED;
                }

                order.logs.push(createAuditLog(`Shipment Released from Hub: ${dispatchDetails.join(', ')}`, order.status, user));
                break;
            }

            case 'ship-items': {
                // Moving items from Dispatched (at loading dock) to Shipped (on truck)
                if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
                    throw new Error("Items array is required to start transit.");
                }

                let shipDetails = [];
                for (const sItem of payload.items) {
                    const oItem = order.items.find(i => i.id === sItem.itemId);
                    if (oItem && sItem.qty > 0) {
                        const shipped = oItem.shippedQty || 0;
                        const dispatched = oItem.dispatchedQty || 0;

                        if (sItem.qty > (dispatched - shipped)) {
                            throw new Error(`Cannot ship ${sItem.qty} units of ${oItem.description}. Only ${dispatched - shipped} units are awaiting transit.`);
                        }

                        oItem.shippedQty = shipped + sItem.qty;
                        shipDetails.push(`${sItem.qty} ${oItem.unit} of ${oItem.description}`);
                    }
                }

                order.logs.push(createAuditLog(`Items transitioned to IN TRANSIT: ${shipDetails.join(', ')}`, order.status, user));
                break;
            }

            case 'confirm-delivery': {
                if (!payload.podFilePath) throw new Error("Signed Delivery Note is required to confirm delivery.");
                if (!payload.items || !Array.isArray(payload.items) || payload.items.length === 0) {
                    throw new Error("Items array is required to confirm partial/full delivery");
                }

                if (!order.deliveries) order.deliveries = [];
                const deliveryId = `DEL-${Date.now()}`;

                let deliveryDetails = [];
                for (const dItem of payload.items) {
                    const oItem = order.items.find(i => i.id === dItem.itemId);
                    if (oItem && dItem.qty > 0) {
                        const delivered = oItem.deliveredQty || 0;
                        const shipped = oItem.shippedQty || 0;

                        if (dItem.qty > (shipped - delivered)) {
                            throw new Error(`Cannot deliver ${dItem.qty} units of ${oItem.description}. Only ${shipped - delivered} units are in transit on a truck.`);
                        }

                        oItem.deliveredQty = delivered + dItem.qty;
                        deliveryDetails.push(`${dItem.qty} ${oItem.unit} of ${oItem.description}`);
                    }
                }

                order.deliveries.push({
                    id: deliveryId,
                    date: new Date().toISOString(),
                    items: payload.items,
                    podFilePath: payload.podFilePath
                });

                const allItemsDelivered = isOrderFullyDelivered(order);
                const fullyPaid = isOrderFullyPaid(order);

                if (allItemsDelivered) {
                    if (order.einvoiceRequested && !order.einvoiceFile) {
                        order.status = OrderStatus.DELIVERED;
                    } else if (fullyPaid) {
                        order.status = OrderStatus.FULFILLED;
                    } else {
                        // All delivered but not paid -> move to DELIVERED status
                        order.status = OrderStatus.DELIVERED;
                    }
                }

                order.logs.push(createAuditLog(`Customer Delivery Confirmed (${allItemsDelivered ? 'Complete' : 'Partial'}) & POD Filed: ${payload.podFilePath}${allItemsDelivered && !fullyPaid ? ' (Awaiting full payment to FULFILL)' : ''}`, order.status, user));
                break;
            }

            case 'request-einvoice':
                order.einvoiceRequested = true;
                order.logs.push(createAuditLog('Gov. E-Invoice requested', order.status, user));
                break;

            case 'attach-einvoice': {
                if (!payload.einvoiceFile) throw new Error("E-Invoice file is required.");
                order.einvoiceFile = payload.einvoiceFile;

                const fullyDel = isOrderFullyDelivered(order);
                const fullyPaid_ = isOrderFullyPaid(order);
                if (fullyDel && fullyPaid_) {
                    order.status = OrderStatus.FULFILLED;
                } else if (fullyDel && order.status === OrderStatus.DELIVERED) {
                    // Stay in DELIVERED until paid
                }

                order.logs.push(createAuditLog(`Gov. E-Invoice Attached: ${payload.einvoiceFile}${fullyDel && !fullyPaid_ ? ' (Awaiting full payment to FULFILL)' : ''}`, order.status, user));
                break;
            }

            case 'void-action':
                // Generic audit logging without status change
                if (payload.message) {
                    order.logs.push(createAuditLog(payload.message, order.status, user));
                }
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        // Run through status processor (handles margin evaluation etc)
        // Skip status eval for rollback-to-logged to prevent auto-advancement
        const skipStatusEval = action === 'rollback-to-logged';
        order = processedOrderInternal(order, db, user, false, oldOrder, skipStatusEval);
        reconcileInventory(oldOrder, order, db);

        db.orders[index] = order;
        if (writeDb(db)) {
            res.json(order);
        } else {
            res.status(500).json({ error: "Failed to save data" });
        }
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/v1/backup', (req, res) => {
    const db = readDb();
    // Decrypt settings for export so the backup contains usable data
    if (db.settings && Array.isArray(db.settings)) {
        db.settings = db.settings.map(s => decryptSettings(s));
    }
    res.json(db);
});

app.get('/api/v1/full-backup', (req, res) => {
    try {
        const password = req.query.password;
        if (!password) {
            return res.status(400).json({ error: "Password is required for secure system export." });
        }

        const zip = new AdmZip();

        // Add database
        if (fs.existsSync(DB_PATH)) {
            zip.addLocalFile(DB_PATH);
        }

        // Add uploads directory
        const uploadsDir = path.join(__dirname, 'uploads');
        if (fs.existsSync(uploadsDir)) {
            zip.addLocalFolder(uploadsDir, 'uploads');
        }

        const rawBuffer = zip.toBuffer();

        // Encrypt the entire zip buffer with AES-256-GCM
        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

        const encrypted = Buffer.concat([cipher.update(rawBuffer), cipher.final()]);
        const authTag = cipher.getAuthTag();

        // Format: [16 bytes salt] [12 bytes IV] [16 bytes AuthTag] [Encrypted Payload]
        const finalBuffer = Buffer.concat([salt, iv, authTag, encrypted]);

        const date = new Date().toISOString().slice(0, 10);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename=nexus-full-archive-${date}.nxarchive`);
        res.send(finalBuffer);
    } catch (err) {
        console.error("Full secure backup failed:", err);
        res.status(500).json({ error: "Full secure backup failed" });
    }
});

app.post('/api/v1/restore', (req, res) => {
    const data = req.body;
    const required = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'settings', 'modules'];
    const missing = required.filter(col => !data[col]);

    if (missing.length > 0) {
        return res.status(400).json({ error: `Restore failed: Missing collections: [${missing.join(', ')}]` });
    }

    // Encrypt sensitive settings on restore (in case backup had plain-text keys)
    if (data.settings && Array.isArray(data.settings)) {
        data.settings = data.settings.map(s => encryptSettings(s));
    }

    if (writeDb(data)) {
        console.log(`[System] Database restored manually at ${new Date().toISOString()}`);
        res.json({ message: "Restored" });
    } else {
        res.status(500).json({ error: "Restore failed during file write" });
    }
});

const restoreUpload = multer({ storage: multer.memoryStorage() });
app.post('/api/v1/full-restore', restoreUpload.single('archive'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No archive file uploaded" });

        const password = req.body.password;
        if (!password) {
            return res.status(400).json({ error: "Password is required to restore secure archive." });
        }

        const fileBuffer = req.file.buffer;

        // Minimum size: 16 (salt) + 12 (iv) + 16 (authTag) = 44 bytes
        if (fileBuffer.length < 44) {
            return res.status(400).json({ error: "Invalid archive format." });
        }

        const salt = fileBuffer.subarray(0, 16);
        const iv = fileBuffer.subarray(16, 28);
        const authTag = fileBuffer.subarray(28, 44);
        const encrypted = fileBuffer.subarray(44);

        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        let rawBuffer;
        try {
            rawBuffer = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        } catch (decryptErr) {
            console.error("Decryption failed:", decryptErr);
            return res.status(401).json({ error: "Decryption failed. Incorrect password or corrupted archive." });
        }

        const zip = new AdmZip(rawBuffer);
        const entries = zip.getEntries();

        // Basic verification
        const hasDb = entries.some(e => e.entryName === 'db.json');
        if (!hasDb) return res.status(400).json({ error: "Invalid archive: db.json missing" });

        // Unpack everything to root
        zip.extractAllTo(__dirname, true);

        console.log(`[System] Full system restore completed at ${new Date().toISOString()}`);
        res.json({ message: "Full system restored successfully" });
    } catch (err) {
        console.error("Full restore failed:", err);
        res.status(500).json({ error: "Full restore failed: " + err.message });
    }
});

app.post('/api/v1/relay/dispatch', async (req, res) => {
    const { Host, Port, Username, Password, To, From, Subject, Body } = req.body;
    const result = await sendEmail(To, Subject, Body, { smtpServer: Host, smtpPort: Port, username: Username, password: Password, senderName: 'Nexus Relay', senderEmail: From || Username, useSsl: Port === 465 });
    if (result.success) res.json({ message: "Sent" });
    else res.status(500).json({ error: result.error });
});

app.post('/api/v1/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDb();
    const user = (db.users || []).find(u => u.username === username);
    const isFactory = username === 'factory' && (Date.now() - SERVER_START_TIME) < 300000 && password === FACTORY_PASS;

    if (isFactory) return res.json(user || { id: 'factory', username: 'factory', name: 'Factory Admin', roles: ['admin'], email: 'factory@nexus.local' });
    if (user && user.password === hashPassword(password)) {
        const { password: _, ...safe } = user;
        return res.json(safe);
    }
    res.status(401).json({ error: "Auth failed" });
});

app.post('/api/v1/init-defaults', (req, res) => {
    const db = readDb();
    if (Object.keys(db).length === 0 || req.body.force) {
        const dd = req.body.defaults || {};
        if (dd.users) dd.users = dd.users.map(u => u.password ? { ...u, password: hashPassword(u.password) } : u);
        if (writeDb({ ...db, ...dd })) res.json({ message: "Initialized" });
        else res.status(500).json({ error: "Failed" });
    } else res.status(400).json({ message: "NotEmpty" });
});

// --- FILE UPLOAD ENDPOINT ---
app.post('/api/upload-pod', uploadPod.single('podFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-einvoice', uploadEInvoice.single('einvoiceFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-wht-certificate', uploadWht.single('whtFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

// ==================== SUPPLIER PAYMENTS ====================

// GET all supplier payments
app.get('/api/v1/supplierPayments', (req, res) => {
    const db = readDb();
    res.json(db.supplierPayments || []);
});

// POST record a supplier payment with FIFO allocation
app.post('/api/v1/supplierPayments', (req, res) => {
    try {
        const db = readDb();
        const user = req.headers['x-user'] || 'System';
        const { supplierId, amount, memo, date } = req.body;
        if (!supplierId || !amount || amount <= 0) {
            return res.status(400).json({ error: "supplierId and a positive amount are required" });
        }

        const supplier = (db.suppliers || []).find(s => s.id === supplierId);
        if (!supplier) return res.status(404).json({ error: "Supplier not found" });

        // Gather all PROCUREMENT components for this supplier across all orders, sorted FIFO
        const componentEntries = [];
        (db.orders || []).forEach(order => {
            order.items.forEach(item => {
                (item.components || []).forEach(comp => {
                    if (comp.source === 'PROCUREMENT' && comp.supplierId === supplierId &&
                        ['ORDERED', 'ORDERED_FOR_STOCK', 'RECEIVED', 'RESERVED', 'IN_MANUFACTURING', 'MANUFACTURED'].includes(comp.status)) {
                        componentEntries.push({
                            componentId: comp.id,
                            orderId: order.id,
                            orderNumber: order.internalOrderNumber,
                            itemDescription: comp.description,
                            totalCost: (comp.quantity || 0) * (comp.unitCost || 0),
                            procurementStartedAt: comp.procurementStartedAt || comp.statusUpdatedAt || order.dataEntryTimestamp
                        });
                    }
                });
            });
        });

        // Sort FIFO by procurement start date
        componentEntries.sort((a, b) => new Date(a.procurementStartedAt).getTime() - new Date(b.procurementStartedAt).getTime());

        // Calculate already-allocated amounts per component from previous payments
        const previousAllocations = {};
        (db.supplierPayments || []).forEach(payment => {
            if (payment.supplierId === supplierId) {
                payment.allocations.forEach(alloc => {
                    previousAllocations[alloc.componentId] = (previousAllocations[alloc.componentId] || 0) + alloc.amount;
                });
            }
        });

        // FIFO allocate the new payment
        let remaining = amount;
        const allocations = [];
        for (const entry of componentEntries) {
            if (remaining <= 0) break;
            const alreadyAllocated = previousAllocations[entry.componentId] || 0;
            const unallocated = Math.max(0, entry.totalCost - alreadyAllocated);
            if (unallocated <= 0) continue;

            const allocAmount = Math.min(remaining, unallocated);
            allocations.push({
                componentId: entry.componentId,
                orderId: entry.orderId,
                orderNumber: entry.orderNumber,
                itemDescription: entry.itemDescription,
                amount: Math.round(allocAmount * 100) / 100
            });
            remaining -= allocAmount;
        }

        // Create the payment record
        const paymentRecord = {
            id: `sp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            supplierId,
            supplierName: supplier.name,
            amount,
            date: date ? new Date(date).toISOString() : new Date().toISOString(),
            memo: memo || '',
            user,
            allocations
        };

        if (!db.supplierPayments) db.supplierPayments = [];
        db.supplierPayments.push(paymentRecord);
        writeDb(db);

        res.json(paymentRecord);
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record supplier payment" });
    }
});

// GET supplier ledger (balance, delivered, pending, payments)
app.get('/api/v1/supplier-ledger/:supplierId', (req, res) => {
    try {
        const db = readDb();
        const { supplierId: rawId } = req.params;
        const isAll = rawId === 'all';
        const selectedIds = isAll ? [] : rawId.split(',');
        
        // Find supplier names for the response
        let supplierInfo = { id: rawId, name: isAll ? "All Suppliers" : "" };
        if (!isAll) {
            const suppliers = (db.suppliers || []).filter(s => selectedIds.includes(s.id));
            if (suppliers.length === 0) return res.status(404).json({ error: "No valid suppliers found" });
            supplierInfo.name = suppliers.map(s => s.name).join(', ');
        }

        // Gather all components for the selected supplier(s)
        const components = [];
        (db.orders || []).forEach(order => {
            order.items.forEach(item => {
                (item.components || []).forEach(comp => {
                    const matchesSupplier = isAll || selectedIds.includes(comp.supplierId);
                    if (matchesSupplier && (comp.source === 'PROCUREMENT' || comp.source === 'CONSUMED') &&
                        !['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(comp.status)) {
                        const totalCost = (comp.quantity || 0) * (comp.unitCost || 0);
                        const receivedQty = comp.receivedQty || 0;
                        const deliveredValue = receivedQty * (comp.unitCost || 0);
                        const pendingQty = Math.max(0, (comp.quantity || 0) - receivedQty);
                        const pendingValue = pendingQty * (comp.unitCost || 0);

                        components.push({
                            componentId: comp.id,
                            supplierId: comp.supplierId,
                            supplierName: (db.suppliers || []).find(s => s.id === comp.supplierId)?.name || 'Unknown',
                            orderId: order.id,
                            orderNumber: order.internalOrderNumber,
                            description: comp.description,
                            poNumber: comp.poNumber,
                            quantity: comp.quantity,
                            unitCost: comp.unitCost,
                            totalCost,
                            receivedQty,
                            deliveredValue,
                            pendingQty,
                            pendingValue,
                            status: comp.status,
                            procurementStartedAt: comp.procurementStartedAt || comp.statusUpdatedAt || order.dataEntryTimestamp
                        });
                    }
                });
            });
        });

        // Sort FIFO
        components.sort((a, b) => new Date(a.procurementStartedAt).getTime() - new Date(b.procurementStartedAt).getTime());

        // Calculate already-allocated amounts per component
        const allocatedPerComponent = {};
        (db.supplierPayments || []).forEach(payment => {
            const matchesSupplier = isAll || selectedIds.includes(payment.supplierId);
            if (matchesSupplier) {
                (payment.allocations || []).forEach(alloc => {
                    allocatedPerComponent[alloc.componentId] = (allocatedPerComponent[alloc.componentId] || 0) + alloc.amount;
                });
            }
        });

        // Enrich components with allocated amounts
        components.forEach(c => {
            c.allocatedPayments = allocatedPerComponent[c.componentId] || 0;
            c.unallocatedBalance = Math.max(0, c.totalCost - c.allocatedPayments);
        });

        // Get all payments for the selected supplier(s)
        const payments = (db.supplierPayments || []).filter(p => isAll || selectedIds.includes(p.supplierId));

        // Summary
        const totalCommitted = components.reduce((s, c) => s + c.totalCost, 0);
        const totalDelivered = components.reduce((s, c) => s + c.deliveredValue, 0);
        const totalPending = components.reduce((s, c) => s + c.pendingValue, 0);
        const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
        const balance = totalDelivered - totalPaid;
        const overallBalance = totalCommitted - totalPaid;

        res.json({
            supplier: supplierInfo,
            summary: { totalCommitted, totalDelivered, totalPending, totalPaid, balance, overallBalance },
            components,
            payments
        });
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to compute supplier ledger" });
    }
});

// SPA Catch-all: Redirect all non-API requests to index.html
app.get('{*path}', (req, res) => {
    if (req.path.startsWith('/api/v1')) return res.status(404).json({ error: "API not found" });
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Backend] Running on http://localhost:${PORT}`);
    runThresholdAudit();
    setInterval(runThresholdAudit, 60000);
});
