
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');
const SERVER_START_TIME = Date.now();
const FACTORY_PASS = 'YousefNadody!@#2';

// --- MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'uploads', 'pod');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'pod-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

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
    PARTIAL_PAYMENT: 'PARTIAL_PAYMENT',
    FULFILLED: 'FULFILLED'
};

const evaluateMarginStatus = (items, minMargin, currentStatus) => {
    let totalRevenue = 0;
    let totalCost = 0;
    let hasComponents = false;
    let anyAccepted = false;

    (items || []).forEach(it => {
        totalRevenue += ((it.quantity || 0) * (it.pricePerUnit || 0));
        if (it.isAccepted) anyAccepted = true;
        if (it.components && it.components.length > 0) {
            hasComponents = true;
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
    if ((hasComponents || anyAccepted) && currentStatus === OrderStatus.LOGGED) {
        return OrderStatus.TECHNICAL_REVIEW;
    }

    // Priority 3: Recovery from Negative Margin
    if (currentStatus === OrderStatus.NEGATIVE_MARGIN && (!hasComponents || markupPct >= minMargin)) {
        return OrderStatus.TECHNICAL_REVIEW;
    }

    return currentStatus;
};

// --- DATABASE HANDLERS ---
const readDb = () => {
    try {
        if (!fs.existsSync(DB_PATH)) return {};
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

const resolveSettings = (db) => {
    const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0)
        ? db.settings[0]
        : (db.settings || {});

    return {
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
        ...dbSettings
    };
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
                if (comp.inventoryItemId && (comp.source === 'STOCK' || comp.source === 'CONSUMED')) {
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

    // 3. Process Items and Components
    order.items.forEach((item, idx) => {
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

        item.components.forEach((comp, cIdx) => {
            if (!comp.id) comp.id = `c_${Date.now()}_${idx}_${cIdx}`;
            if (!comp.componentNumber) {
                // Generate a friendly component number if missing
                comp.componentNumber = `CMP-${order.internalOrderNumber}-${(item.id || 'ITEM').split('_').pop()}-${cIdx + 1}`;
            }
            if (!comp.status) comp.status = 'NEW';
            if (!comp.statusUpdatedAt) comp.statusUpdatedAt = new Date().toISOString();
        });
    });

    // 4. Force Status Evaluation
    if (!skipStatusEval) {
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
        const minMargin = dbSettings.minimumMarginPct || 15;
        const nextStatus = evaluateMarginStatus(order.items, minMargin, order.status || OrderStatus.LOGGED);

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
                const allReserved = order.items.every(item =>
                    (item.components || []).every(comp => comp.status === 'RESERVED')
                );

                if (allReserved) {
                    const old = order.status;
                    order.status = OrderStatus.WAITING_FACTORY;
                    order.logs.push(createAuditLog(`[AUTO] Procurement Complete: All components reserved. Status moved from ${old} to ${order.status}`, order.status, 'System'));
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

                            // Update both Stock (physical) and Reserved (allocation)
                            invItem.quantityInStock = Math.max(0, currentStock - consumedQty);
                            invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - consumedQty);

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
                    if (comp.status !== 'Manufactured') {
                        comp.status = 'Manufactured';
                        comp.statusUpdatedAt = new Date().toISOString();
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

// Maps OrderStatus â†’ settings config key (hours-based time-in-status thresholds)
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
    'DELIVERED': 'deliveredLimitHrs',
    'PARTIAL_PAYMENT': null  // handled by special payment SLA check
};

// Maps Component CompStatus â†’ settings config key (procurement process thresholds)
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
            const result = await sendEmail(recipientEmails, subject, body, settings.emailConfig);
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
                    const result = await sendEmail(emails, `[NEXUS] New Order: ${order.internalOrderNumber}`, `A new order ${order.internalOrderNumber} has been logged.`, settings.emailConfig);
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
            await sendAlertForOrder(order, `margin_${order.id}`, 'negative_margin', 'minimumMarginPct',
                `[NEXUS] Margin Alert: ${order.internalOrderNumber} below ${settings.minimumMarginPct || 15}%`,
                `Order ${order.internalOrderNumber} has a margin of ${markupPct.toFixed(1)}%, below the minimum threshold of ${settings.minimumMarginPct || 15}%.`);
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
                    const journalKey = `comp_${compThresholdKey}_${order.id}_${item.id}_${comp.id}`;
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
app.use(express.static(path.join(__dirname, 'dist')));

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
    if (!isOverdue && order.status === OrderStatus.WAITING_SUPPLIERS) {
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

    if (col === 'customers' || col === 'suppliers') {
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
const COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'notifications', 'settings', 'modules'];
COLLECTIONS.forEach(col => {
    app.get(`/api/v1/${col}`, getCollection(col));
    app.get(`/api/v1/${col}/:id`, getItemFromCollection(col));
    app.post(`/api/v1/${col}`, addToCollection(col));
    app.put(`/api/v1/${col}/:id`, updateInCollection(col));
    app.delete(`/api/v1/${col}/:id`, deleteFromCollection(col));
});

// SPA Catch-all: Redirect all non-API requests to index.html
app.get('{*path}', (req, res) => {
    if (req.path.startsWith('/api/v1')) return res.status(404).json({ error: "API not found" });
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.post('/api/v1/wipe', (req, res) => {
    const db = readDb();
    const BUSINESS_COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'notifications'];
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
    const updateInventoryItem = (db, comp, action) => {
        if (!db.inventory) db.inventory = [];
        // Try to find existing inventory item by ID (if linked) or Description/PartNumber
        let invItem = db.inventory.find(i => i.id === comp.inventoryItemId);
        if (!invItem) {
            invItem = db.inventory.find(i => (i.partNumber && i.partNumber === comp.componentNumber) || (i.name === comp.description));
        }
        if (action === 'RECEIVE') {
            if (!invItem) {
                invItem = {
                    id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    name: comp.description,
                    sku: comp.componentNumber || `SKU-${Date.now()}`,
                    quantityInStock: 0,
                    quantityReserved: 0,
                    category: 'Uncategorized',
                    unit: 'Unit',
                    minStockLevel: 0,
                    lastUpdated: new Date().toISOString()
                };
                db.inventory.push(invItem);
            }
            comp.inventoryItemId = invItem.id;
            const currentStock = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);
            invItem.quantityInStock = currentStock + (comp.quantity || 0);
            // Migrate legacy
            if (invItem.quantity !== undefined) delete invItem.quantity;

            invItem.quantityReserved = (invItem.quantityReserved || 0) + (comp.quantity || 0);
            invItem.lastUpdated = new Date().toISOString();
            console.log(`[Inventory] Received & Reserved: ${invItem.name}. Qty: ${invItem.quantity}, Rsrv: ${invItem.quantityReserved}`);
        } else if (action === 'RELEASE') {
            if (invItem && (invItem.quantityReserved || 0) > 0) {
                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - (comp.quantity || 0));
                invItem.lastUpdated = new Date().toISOString();
                console.log(`[Inventory] Released Stock: ${invItem.name}. New Rsrv: ${invItem.quantityReserved}`);
            }
        }
    };

    try {
        switch (action) {
            case 'finalize-study':
                if (order.items.some(it => !it.isAccepted)) throw new Error("All items must be accepted before finalizing study");
                order.status = OrderStatus.WAITING_SUPPLIERS;
                order.logs.push(createAuditLog('Technical study finalized and pushed to Procurement', order.status, user));
                break;

            case 'rollback-to-logged':
                const rollbackOld = JSON.parse(JSON.stringify(order));
                order.status = OrderStatus.LOGGED;
                // Clear components and reset item approvals as requested
                order.items.forEach(item => {
                    item.components = [];
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

            case 'reject-order':
                order.status = OrderStatus.REJECTED;
                // Release any reserved inventory back to free stock
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (['RESERVED', 'RECEIVED'].includes(comp.status)) {
                            updateInventoryItem(db, comp, 'RELEASE');
                            comp.status = 'IN_STOCK'; // Or specific status indicating released
                        }
                    });
                });
                order.logs.push(createAuditLog(`ORDER REJECTED: ${payload?.reason || 'Business decision'}`, order.status, user));
                break;

            case 'receive-component':
                const itemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (itemIdx === -1) throw new Error("Item not found");
                const compIdx = order.items[itemIdx].components?.findIndex(c => c.id === payload.compId);
                if (compIdx === -1) throw new Error("Component not found");

                const compToReceive = order.items[itemIdx].components[compIdx];
                updateInventoryItem(db, compToReceive, 'RECEIVE');

                compToReceive.status = 'RESERVED';
                compToReceive.statusUpdatedAt = new Date().toISOString();
                order.logs.push(createAuditLog(`Component Received & Reserved: ${compToReceive.description}`, order.status, user));
                break;

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
                order.payments.push({
                    amount: payload.amount,
                    date: new Date().toISOString(),
                    user,
                    memo: payload.memo || 'Regular payment'
                });
                const totalPaid = order.payments.reduce((s, p) => s + p.amount, 0);
                // Calculate gross revenue to see if fully paid
                let revenue = 0;
                order.items.forEach(it => revenue += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));

                const isLateStage = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.PARTIAL_PAYMENT].includes(order.status);

                if (totalPaid >= revenue) {
                    if (isLateStage) {
                        order.status = OrderStatus.FULFILLED;
                        order.logs.push(createAuditLog(`Full payment reconciled. Order lifecycle FULFILLED.`, order.status, user));
                    } else {
                        order.logs.push(createAuditLog(`Full payment received (Pre-payment). Operational status '${order.status}' retained.`, order.status, user));
                    }
                } else {
                    if (isLateStage) {
                        order.status = OrderStatus.PARTIAL_PAYMENT;
                    }
                    order.logs.push(createAuditLog(`Payment of ${payload.amount} recorded. Bal: ${Math.max(0, revenue - totalPaid).toLocaleString()}`, order.status, user));
                }
                break;

            case 'start-production':
                order.status = OrderStatus.MANUFACTURING;
                order.logs.push(createAuditLog(`Production Started: Released to Floor`, order.status, user));
                break;

            case 'finish-production':
                order.status = OrderStatus.MANUFACTURING_COMPLETED;
                order.logs.push(createAuditLog(`Production Finished: Ready for QC/Hub`, order.status, user));
                break;

            case 'receive-hub':
                order.status = OrderStatus.IN_PRODUCT_HUB;
                order.logs.push(createAuditLog(`PO Received at Product Hub: Ready for Invoicing`, order.status, user));
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

            case 'release-delivery':
                order.status = OrderStatus.HUB_RELEASED;
                order.logs.push(createAuditLog(`Shipment Released from Hub to Logistics Provider`, order.status, user));
                break;

            case 'confirm-delivery':
                if (!payload.podFilePath) throw new Error("Signed Delivery Note is required to confirm delivery.");
                order.status = OrderStatus.DELIVERED;
                order.podFilePath = payload.podFilePath;
                order.logs.push(createAuditLog(`Customer Delivery Confirmed & POD Filed: ${payload.podFilePath}`, order.status, user));
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        // Run through status processor (handles margin evaluation etc)
        // Skip status eval for rollback-to-logged to prevent auto-advancement
        const skipStatusEval = action === 'rollback-to-logged';
        order = processedOrderInternal(order, db, user, false, null, skipStatusEval);

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

app.get('/api/v1/backup', (req, res) => res.json(readDb()));
app.post('/api/v1/restore', (req, res) => {
    const data = req.body;
    const required = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'settings', 'modules'];
    const missing = required.filter(col => !data[col]);

    if (missing.length > 0) {
        return res.status(400).json({ error: `Restore failed: Missing collections: [${missing.join(', ')}]` });
    }

    if (writeDb(data)) {
        console.log(`[System] Database restored manually at ${new Date().toISOString()}`);
        res.json({ message: "Restored" });
    } else {
        res.status(500).json({ error: "Restore failed during file write" });
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
app.post('/api/upload-pod', upload.single('podFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No file uploaded" });
        }
        const relativePath = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
        // Return relative path like "uploads/pod/filename.ext"
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Backend] Running on http://localhost:${PORT}`);
    runThresholdAudit();
    setInterval(runThresholdAudit, 60000);
});
