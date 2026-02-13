
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
const runThresholdAudit = async () => {
    console.debug(`[Audit] Routine check started at ${new Date().toISOString()}`);
    const db = readDb();
    const orders = db.orders || [];
    const users = db.users || [];
    const notifications = db.notifications || [];

    // settings could be an object or a single-item array in db.json
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

    const getRecipients = (groupIds) => {
        if (!groupIds || !Array.isArray(groupIds)) groupIds = [];

        console.debug(`[Audit] getRecipients called with groupIds: [${groupIds.join(', ')}]`);
        console.debug(`[Audit] Available userGroups: [${userGroups.map(g => `${g.id}(${g.name})`).join(', ')}]`);
        console.debug(`[Audit] Available users: [${users.map(u => `${u.username}(groups:${(u.groupIds || []).join('+')})`).join(', ')}]`);

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

        console.debug(`[Audit] Found ${recipients.length} recipients from groups: [${recipients.map(r => `${r.name}(${r.groupName})`).join(', ')}]`);

        if (recipients.length === 0) {
            users.forEach(u => {
                if (u.roles?.includes('admin') && u.email && !seenEmails.has(u.email)) {
                    recipients.push({ name: u.name || u.username, email: u.email, groupName: 'Admin Fallback' });
                    seenEmails.add(u.email);
                }
            });
            if (recipients.length > 0) {
                console.debug(`[Audit] Fallback to admins for groups: [${groupIds.join(', ')}]`);
            }
        }
        return recipients;
    };

    for (const order of orders) {
        if (order.status === 'FULFILLED' || order.status === 'REJECTED') continue;

        // 1. Logging Delay
        const delayThresholdDays = settings.loggingDelayThresholdDays || 1;
        const poDate = new Date(order.orderDate).getTime();
        const entryDate = new Date(order.dataEntryTimestamp).getTime();
        const delayDays = (entryDate - poDate) / (1000 * 60 * 60 * 24);

        if (delayDays > delayThresholdDays) {
            if (!order.loggingComplianceViolation) {
                order.loggingComplianceViolation = true;
                dbChanged = true;
            }

            const journalKey = `delay_${order.id}`;
            const alreadySent = notifications.some(n => n.journalKey === journalKey);

            if (!alreadySent) {
                const groupIds = settings.thresholdNotifications?.['loggingDelayThresholdDays'] || [];
                const recipients = getRecipients(groupIds);

                if (recipients.length > 0) {
                    const recipientEmails = recipients.map(r => r.email);
                    const result = await sendEmail(recipientEmails, `[NEXUS] Compliance Alert: Logging Delay - ${order.internalOrderNumber}`,
                        `Order ${order.internalOrderNumber} delayed by ${delayDays.toFixed(1)} days.`, settings.emailConfig);

                    if (result.success) {
                        notifications.push({ id: `nt_d_${Date.now()}`, journalKey, orderId: order.id, type: 'logging_delay', sentAt: new Date().toISOString(), recipients: recipientEmails });
                        if (!order.logs) order.logs = [];

                        // Per-user granular logging
                        recipients.forEach(r => {
                            order.logs.push({
                                timestamp: new Date().toISOString(),
                                message: `[SYSTEM] Compliance Alert Sent to ${r.name} (${r.email}) via group: ${r.groupName}`,
                                status: order.status,
                                user: 'System'
                            });
                        });
                        dbChanged = true;
                    }
                } else {
                    // Record failure in audit log
                    if (!order.logs) order.logs = [];
                    order.logs.push({
                        timestamp: new Date().toISOString(),
                        message: `[SYSTEM] [ALERT_FAILED] No recipients found for logging delay alert. Assigned groups: ${groupIds.join(', ')}`,
                        status: order.status,
                        user: 'System'
                    });
                    // Still journal it to avoid spamming the log every 1 minute
                    notifications.push({ id: `nt_err_d_${Date.now()}`, journalKey, orderId: order.id, type: 'logging_delay_error', sentAt: new Date().toISOString(), recipients: [] });
                    dbChanged = true;
                }
            }
        }

        // 2. New Order
        if (settings.enableNewOrderAlerts) {
            const journalKey = `new_order_${order.id}`;
            const alreadySent = notifications.some(n => n.journalKey === journalKey);
            if (!alreadySent) {
                const groupIds = settings.newOrderAlertGroupIds || [];
                const recipients = getRecipients(groupIds);
                if (recipients.length > 0) {
                    const recipientEmails = recipients.map(r => r.email);
                    const result = await sendEmail(recipientEmails, `[NEXUS] New Order: ${order.internalOrderNumber}`,
                        `A new order ${order.internalOrderNumber} has been logged.`, settings.emailConfig);

                    if (result.success) {
                        notifications.push({ id: `nt_n_${Date.now()}`, journalKey, orderId: order.id, type: 'new_order', sentAt: new Date().toISOString(), recipients: recipientEmails });
                        if (!order.logs) order.logs = [];

                        // Per-user granular logging
                        recipients.forEach(r => {
                            order.logs.push({
                                timestamp: new Date().toISOString(),
                                message: `[SYSTEM] New Order Notification Sent to ${r.name} (${r.email}) via group: ${r.groupName}`,
                                status: order.status,
                                user: 'System'
                            });
                        });
                        dbChanged = true;
                    }
                } else {
                    // Record failure in audit log
                    if (!order.logs) order.logs = [];
                    order.logs.push({
                        timestamp: new Date().toISOString(),
                        message: `[SYSTEM] [ALERT_FAILED] No recipients found for new order alert. Assigned groups: ${groupIds.join(', ')}`,
                        status: order.status,
                        user: 'System'
                    });
                    // Still journal it to avoid spamming the log every 1 minute
                    notifications.push({ id: `nt_err_n_${Date.now()}`, journalKey, orderId: order.id, type: 'new_order_error', sentAt: new Date().toISOString(), recipients: [] });
                    dbChanged = true;
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

    const newItem = { id: `${col}_${Date.now()}`, ...req.body };
    if (col === 'users' && newItem.password) newItem.password = hashPassword(newItem.password);
    db[col].push(newItem);
    if (writeDb(db)) res.status(201).json(col === 'users' ? (({ password, ...u }) => u)(newItem) : newItem);
    else res.status(500).json({ error: "Write failed" });
};

const updateInCollection = (col) => (req, res) => {
    const db = readDb();
    if (!db[col]) return res.status(404).json({ error: "Not found" });
    const index = db[col].findIndex(it => it.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: "Item not found" });
    const updated = { ...db[col][index], ...req.body };
    if (col === 'users' && req.body.password) updated.password = hashPassword(req.body.password);
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
app.get('*', (req, res) => {
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
    if (writeDb(req.body)) res.json({ message: "Restored" });
    else res.status(500).json({ error: "Restore failed" });
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
