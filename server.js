
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

// ... (DB Init logic remains)

const app = express();
const PORT = 3005;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// ... (Serve details) ...

// Backup Endpoint
app.get('/api/v1/backup', (req, res) => {
    const db = readDb();
    // Return the entire DB object (includes users, settings, data, images)
    res.json(db);
});

// Restore Endpoint
app.post('/api/v1/restore', (req, res) => {
    const backupData = req.body;

    // Basic validation
    if (!backupData || typeof backupData !== 'object') {
        return res.status(400).json({ error: "Invalid backup data format" });
    }

    // Safety: Backup current DB before restore ? (Optional, but good practice. Skipped for simplicity as per request "wipes all")

    if (writeDb(backupData)) {
        res.json({ message: "System restored successfully. Reloading..." });
    } else {
        res.status(500).json({ error: "Restore failed to write to disk." });
    }
});

// Serve Static Frontend
app.use(express.static(path.join(__dirname, 'dist')));

// Helper: Hash Password
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};
// Helper: Send Email
const sendEmail = async (to, subject, body, config) => {
    if (!config || !config.smtpServer) {
        console.error("[Email] Configuration missing.");
        return false;
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
            rejectUnauthorized: false // Common fix for corporate/restricted mail servers
        }
    });

    try {
        await transporter.sendMail({
            from: `"${config.senderName}" <${config.senderEmail}>`,
            to: to.join(','),
            subject: subject,
            text: body,
            html: body.replace(/\n/g, '<br>')
        });
        console.log(`[Email] Alert sent to: ${to.join(', ')}`);
        return { success: true };
    } catch (err) {
        console.error("[Email] Send failed:", err.message);
        return { success: false, error: err.message };
    }
};

// Threshold Audit Service
const runThresholdAudit = async () => {
    console.debug(`[Audit] Routine check started at ${new Date().toISOString()}`);
    const db = readDb();
    const orders = db.orders || [];
    const settings = db.settings || {};
    const users = db.users || [];

    let dbChanged = false;

    // thresholdNotifications mapping for logging delay
    const delayThresholdDays = settings.loggingDelayThresholdDays || 1;
    const loggingDelayGroupIds = (settings.thresholdNotifications || {})['logging_delay'] || ['grp_super'];
    const newOrderGroupIds = settings.newOrderAlertGroupIds || ['grp_super'];
    const notifications = db.notifications || [];

    for (const order of orders) {
        if (order.status === 'FULFILLED' || order.status === 'REJECTED') continue;

        // 1. Logging Delay Threshold
        const poDate = new Date(order.orderDate).getTime();
        const entryDate = new Date(order.dataEntryTimestamp).getTime();
        const delayDays = (entryDate - poDate) / (1000 * 60 * 60 * 24);

        if (delayDays > delayThresholdDays) {
            order.loggingComplianceViolation = true;
            dbChanged = true;

            const journalKey = `delay_${order.id}`;
            const alreadySent = notifications.some(n => n.journalKey === journalKey);

            if (!alreadySent) {
                const recipientEmails = users
                    .filter(u => u.groupIds?.some(gid => loggingDelayGroupIds.includes(gid)))
                    .map(u => u.email).filter(e => !!e);

                if (recipientEmails.length > 0) {
                    const result = await sendEmail(
                        recipientEmails,
                        `[NEXUS] Compliance Alert: Logging Delay - ${order.internalOrderNumber}`,
                        `Dear Team,\n\nOrder ${order.internalOrderNumber} for ${order.customerName} has been flagged for a logging delay violation.\n\nPO Date: ${order.orderDate}\nSystem Entry Date: ${new Date(order.dataEntryTimestamp).toLocaleDateString()}\nDelay: ${delayDays.toFixed(1)} days\n\nRegards,\nNexus ERP System`,
                        settings.emailConfig
                    );
                    if (result.success) {
                        notifications.push({ id: `nt_${Date.now()}_${order.id}`, journalKey, orderId: order.id, type: 'logging_delay', sentAt: new Date().toISOString(), recipients: recipientEmails });
                        dbChanged = true;
                    }
                }
            }
        }

        // 2. New Order Alerts (Backend Migration)
        if (settings.enableNewOrderAlerts) {
            const journalKey = `new_order_${order.id}`;
            const alreadySent = notifications.some(n => n.journalKey === journalKey);

            if (!alreadySent) {
                const recipientEmails = users
                    .filter(u => u.groupIds?.some(gid => newOrderGroupIds.includes(gid)))
                    .map(u => u.email).filter(e => !!e);

                if (recipientEmails.length > 0) {
                    const result = await sendEmail(
                        recipientEmails,
                        `[NEXUS] New Order Recorded: ${order.internalOrderNumber}`,
                        `Dear Team,\n\nA new purchase order has been logged in the system.\n\nOrder ID: ${order.internalOrderNumber}\nCustomer: ${order.customerName}\nPO Date: ${order.orderDate}\n\nRegards,\nNexus ERP System`,
                        settings.emailConfig
                    );
                    if (result.success) {
                        notifications.push({ id: `nt_new_${Date.now()}_${order.id}`, journalKey, orderId: order.id, type: 'new_order', sentAt: new Date().toISOString(), recipients: recipientEmails });
                        dbChanged = true;
                    }
                }
            }
        }
    }

    if (dbChanged) {
        db.notifications = notifications;
        writeDb(db);
    }
};

// --- API ROUTES ---
const readDb = () => {
    try {
        if (!fs.existsSync(DB_PATH)) {
            return {};
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

// --- GENERIC CRUD HANDLERS ---
const getCollection = (collectionName) => (req, res) => {
    const db = readDb();
    // Security: Don't return passwords for users collection
    if (collectionName === 'users') {
        const users = db[collectionName] || [];
        const safeUsers = users.map(({ password, ...u }) => u);
        return res.json(safeUsers);
    }
    res.json(db[collectionName] || []);
};

const addToCollection = (collectionName) => (req, res) => {
    const db = readDb();
    const collection = db[collectionName] || [];
    let newItem = req.body;

    // Auto-generate ID if missing
    if (!newItem.id) newItem.id = `${collectionName}_${Date.now()}`;

    // Security: Hash password for new users
    if (collectionName === 'users' && newItem.password) {
        newItem.password = hashPassword(newItem.password);
    }

    collection.push(newItem);
    db[collectionName] = collection;

    if (writeDb(db)) {
        // Return without password
        if (collectionName === 'users') {
            const { password, ...safeItem } = newItem;
            res.status(201).json(safeItem);
        } else {
            res.status(201).json(newItem);
        }
    } else {
        res.status(500).json({ error: "Failed to save item" });
    }
};

const updateInCollection = (collectionName) => (req, res) => {
    const db = readDb();
    const collection = db[collectionName] || [];
    const { id } = req.params;
    const updates = req.body;

    const index = collection.findIndex(item => item.id === id);
    if (index === -1) return res.status(404).json({ error: "Item not found" });

    let updatedItem = { ...collection[index], ...updates };

    // Security: Hash password if updating user password
    if (collectionName === 'users' && updates.password) {
        updatedItem.password = hashPassword(updates.password);
    }

    collection[index] = updatedItem;
    db[collectionName] = collection;

    if (writeDb(db)) {
        if (collectionName === 'users') {
            const { password, ...safeItem } = updatedItem;
            res.json(safeItem);
        } else {
            res.json(updatedItem);
        }
    } else {
        res.status(500).json({ error: "Failed to update item" });
    }
};

const deleteFromCollection = (collectionName) => (req, res) => {
    const db = readDb();
    const collection = db[collectionName] || [];
    const { id } = req.params;

    const newCollection = collection.filter(item => item.id !== id);
    if (newCollection.length === collection.length) return res.status(404).json({ error: "Item not found" });

    db[collectionName] = newCollection;

    if (writeDb(db)) {
        res.status(200).json({ message: "Deleted successfully" });
    } else {
        res.status(500).json({ error: "Failed to delete item" });
    }
};

// --- API ROUTES ---
const COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'notifications'];

COLLECTIONS.forEach(col => {
    app.get(`/api/v1/${col}`, getCollection(col));
    app.post(`/api/v1/${col}`, addToCollection(col));
    app.put(`/api/v1/${col}/:id`, updateInCollection(col));
    app.delete(`/api/v1/${col}/:id`, deleteFromCollection(col));
});

// Email Relay Endpoint (for UI Testing)
app.post('/api/v1/relay/dispatch', async (req, res) => {
    const { Host, Port, Username, Password, To, From, Subject, Body } = req.body;

    const config = {
        smtpServer: Host,
        smtpPort: Port,
        username: Username,
        password: Password,
        senderName: 'Nexus ERP Test',
        senderEmail: From || Username,
        useSsl: Port === 465
    };

    const toList = Array.isArray(To) ? To : [To];
    const result = await sendEmail(toList, Subject, Body, config);

    if (result.success) {
        res.json({ message: 'Email sent successfully' });
    } else {
        res.status(500).json({ error: result.error || 'Failed to send email' });
    }
});

// Auth Endpoint
app.post('/api/v1/login', (req, res) => {
    const { username, password } = req.body;
    const db = readDb();
    const users = db.users || [];
    const user = users.find(u => u.username === username);

    // 1. Factory Reset Check
    // 5 minutes window (300,000 ms)
    const isFactoryWindow = (Date.now() - SERVER_START_TIME) < 300000;

    // User is now 'factory', ensuring it's hidden from DB listings (unless someone names a user 'factory')
    if (username === 'factory' && isFactoryWindow && password === FACTORY_PASS) {
        if (user) {
            const { password: _, ...safeUser } = user;
            return res.json(safeUser);
        } else {
            // Fail-safe: Synthetic Admin
            return res.json({
                id: 'temp_admin_factory',
                username: 'factory',
                name: 'System Factory Lead',
                roles: ['admin'],
                email: 'system@nexus.local',
                firstName: 'System',
                lastName: 'Factory'
            });
        }
    }

    // 2. Standard Auth
    if (user && user.password === hashPassword(password)) {
        const { password: _, ...safeUser } = user;
        return res.json(safeUser);
    }

    res.status(401).json({ error: "Invalid credentials" });
});

// Change Password Endpoint
app.post('/api/v1/change-password', (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    const db = readDb();
    const users = db.users || [];
    const index = users.findIndex(u => u.id === userId);

    if (index === -1) return res.status(404).json({ error: "User not found" });

    const user = users[index];
    if (user.password !== hashPassword(oldPassword)) {
        return res.status(401).json({ error: "Incorrect current password" });
    }

    user.password = hashPassword(newPassword);
    db.users = users;

    if (writeDb(db)) {
        res.json({ message: "Password updated successfully" });
    } else {
        res.status(500).json({ error: "Failed to update password" });
    }
});

// Special: Init DB with default data (for migration/testing)
app.post('/api/v1/init-defaults', (req, res) => {
    const db = readDb();
    if (Object.keys(db).length === 0 || req.body.force) {
        let defaults = req.body.defaults || {};

        // Security: Hash default users' passwords
        if (defaults.users && Array.isArray(defaults.users)) {
            defaults.users = defaults.users.map(u => ({
                ...u,
                password: u.password ? hashPassword(u.password) : undefined
            }));
        }

        if (writeDb({ ...db, ...defaults })) {
            res.json({ message: "Defaults initialized" });
        } else {
            res.status(500).json({ error: "Failed to write defaults" });
        }
    } else {
        res.status(400).json({ message: "DB not empty" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Backend] Nexus Engine & Frontend running on http://localhost:${PORT}`);

    // Initial Audit on Start
    runThresholdAudit();

    // Scheduled Audit every 1 minute
    setInterval(runThresholdAudit, 60000);
});
