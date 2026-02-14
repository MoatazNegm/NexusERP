
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');
const SERVER_START_TIME = Date.now();
const FACTORY_PASS = 'YousefNadody!@#2';

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

    (items || []).forEach(it => {
        totalRevenue += ((it.quantity || 0) * (it.pricePerUnit || 0));
        if (it.components && it.components.length > 0) {
            hasComponents = true;
            it.components.forEach(c => {
                totalCost += ((c.quantity || 0) * (c.unitCost || 0));
            });
        }
    });

    const marginAmt = totalRevenue - totalCost;
    const markupPct = totalCost > 0 ? (marginAmt / totalCost) * 100 : (totalRevenue > 0 ? 100 : 0);

    // Priority 1: Margin Protection
    if (markupPct < minMargin) return OrderStatus.NEGATIVE_MARGIN;

    // Priority 2: Technical Workflow Transition
    if (hasComponents && currentStatus === OrderStatus.LOGGED) {
        return OrderStatus.TECHNICAL_REVIEW;
    }

    // Priority 3: Recovery from Negative Margin
    if (currentStatus === OrderStatus.NEGATIVE_MARGIN) {
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
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
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
    const users = db.users || [];
    const notifications = db.notifications || [];

    const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0)
        ? db.settings[0]
        : (db.settings || {});

    const settings = {
        loggingDelayThresholdDays: 1,
        enableNewOrderAlerts: true,
        newOrderAlertGroupIds: [],
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

    let dbChanged = false;
    const userGroups = db.userGroups || [];

    // --- Recipient resolution (with admin fallback) ---
    const getRecipients = (groupIds) => {
        if (!groupIds || !Array.isArray(groupIds)) groupIds = [];
        const recipients = [];
        const seenEmails = new Set();

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

    // --- Generic alert dispatcher (deduplicates all notification logic) ---
    const sendAlertForOrder = async (order, journalKey, alertType, thresholdKey, subject, body) => {
        const alreadySent = notifications.some(n => n.journalKey === journalKey);
        if (alreadySent) return;

        const groupIds = settings.thresholdNotifications?.[thresholdKey] || [];
        if (groupIds.length === 0) return; // no groups assigned, skip silently

        const recipients = getRecipients(groupIds);
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

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // A. SPECIAL CHECKS (non-time-in-status)
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

        // A1. Logging Delay (PO date vs data entry date, in days)
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

        // A2. New Order Alert
        if (settings.enableNewOrderAlerts) {
            const jk = `new_order_${order.id}`;
            if (!notifications.some(n => n.journalKey === jk)) {
                const groupIds = settings.newOrderAlertGroupIds || [];
                const recipients = getRecipients(groupIds);
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

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // B. DYNAMIC: Order-level time-in-status threshold checks
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
        // C. DYNAMIC: Component-level procurement threshold checks
        // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

// --- GENERIC CRUD ---
const getCollection = (col) => (req, res) => {
    const db = readDb();
    if (col === 'users') return res.json((db[col] || []).map(({ password, ...u }) => u));
    res.json(db[col] || []);
};

const addToCollection = (col) => (req, res) => {
    const db = readDb();
    if (!db[col]) db[col] = [];

    // Specialized validation for orders: prevent duplicate PO IDs
    if (col === 'orders' && req.body.customerReferenceNumber) {
        const poId = req.body.customerReferenceNumber.trim().toLowerCase();
        const isDuplicate = db[col].some(o => o.customerReferenceNumber?.trim().toLowerCase() === poId);
        if (isDuplicate) {
            return res.status(400).json({ error: `Duplicate PO ID: "${req.body.customerReferenceNumber}" already exists.` });
        }
    }

    let newItem = { id: `${col}_${Date.now()}`, ...req.body };
    if (col === 'users' && newItem.password) newItem.password = hashPassword(newItem.password);

    if (col === 'orders') {
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
        const minMargin = dbSettings.minimumMarginPct || 15;

        // Lazy init logs
        if (!newItem.logs) newItem.logs = [];
        (newItem.items || []).forEach(it => { if (!it.logs) it.logs = []; });

        const nextStatus = evaluateMarginStatus(newItem.items, minMargin, newItem.status || OrderStatus.LOGGED);
        if (nextStatus !== newItem.status) {
            const old = newItem.status || 'NEW';
            newItem.status = nextStatus;
            const reason = nextStatus === OrderStatus.NEGATIVE_MARGIN ? 'Margin Protection' : 'Technical Study Initialization';
            newItem.logs.push({ timestamp: new Date().toISOString(), message: `[AUTO] ${reason}: Status moved from ${old} to ${nextStatus}`, status: nextStatus, user: 'System' });
        }
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
    let updated = { ...db[col][index], ...req.body };
    if (col === 'users' && req.body.password) updated.password = hashPassword(req.body.password);

    if (col === 'orders') {
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
        const minMargin = dbSettings.minimumMarginPct || 15;

        // Lazy init logs
        if (!updated.logs) updated.logs = [];
        (updated.items || []).forEach(it => { if (!it.logs) it.logs = []; });

        const nextStatus = evaluateMarginStatus(updated.items, minMargin, updated.status);
        if (nextStatus !== updated.status) {
            const old = updated.status;
            updated.status = nextStatus;
            const reason = nextStatus === OrderStatus.NEGATIVE_MARGIN ? 'Margin Protection' : 'Workflow Update';
            updated.logs.push({ timestamp: new Date().toISOString(), message: `[AUTO] ${reason}: Status moved from ${old} to ${nextStatus}`, status: nextStatus, user: 'System' });
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Backend] Running on http://localhost:${PORT}`);
    runThresholdAudit();
    setInterval(runThresholdAudit, 60000);
});
