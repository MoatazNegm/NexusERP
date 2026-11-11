
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import https from 'https';
import { Dropbox } from 'dropbox';

import os from 'os';
import AdmZip from 'adm-zip';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
const unzipper = require('unzipper');
import { API_USER_GUIDE_MARKDOWN, API_USER_GUIDE_JSON, getUserGuideMarkdown, getUserGuideJson } from './api_user_guide.js';
import * as XLSX from 'xlsx';

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err);
});

// Path sanitization with safe fallback
const sanitizeUsername = (username) => {
  if (!username || typeof username !== 'string') return 'user';
  const cleaned = username
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return cleaned || 'user';
};

import crypto from 'crypto';
import multer from 'multer';
import { isMarginBreach } from './shared/margin.js';
import { ORDER_CANCEL_ROLES, ROLLBACK_TO_LOGGED_DENIED } from './shared/orderPermissions.js';
import { computeStockValue } from './shared/stockValue.js';
import { computeCashBank } from './shared/cashBank.js';
import { computeReceivables, computePayables, orderPaidInLE, orderReceivableLE, closedContractCoverage } from './shared/arap.js';
import { isInternalStockOrder, orderPaymentsLE, isRealizedSale, ownLinesAreSales, paymentLE, blanketRootOf, callOffsOfBlanket, trimRef, resolveBlanketLink, blanketLinkRefusal, blanketLinkMap, isRejectedStatus, sameCustomerName } from './shared/orderMoney.js';
import { S3Client, ListBucketsCommand, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_BASE)) {
    fs.mkdirSync(UPLOADS_BASE, { recursive: true });
}

const getSandboxDbPath = (owner) => path.join(__dirname, `db.sandbox.${sanitizeUsername(owner)}.json`);
const getSandboxLoginSnapshotPath = (owner) => path.join(__dirname, `db.sandbox.${sanitizeUsername(owner)}.login_snapshot.json`);
const getSandboxUploadsPath = (owner) => path.join(UPLOADS_BASE, 'sandbox', sanitizeUsername(owner));
const getSandboxLoginSnapshotUploadsPath = (owner) => path.join(UPLOADS_BASE, 'sandbox', `${sanitizeUsername(owner)}_login_snapshot`);
const getSandboxJournalPath = (owner) => path.join(__dirname, `db.sandbox.${sanitizeUsername(owner)}.journal.json`);

const readSandboxJournal = (owner) => {
    const journalPath = getSandboxJournalPath(owner);
    if (fs.existsSync(journalPath)) {
        try {
            return JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        } catch (_) {}
    }
    return { loginTime: new Date().toISOString(), addedFiles: [], amendedFiles: [] };
};

const writeSandboxJournal = (owner, journal) => {
    try {
        const journalPath = getSandboxJournalPath(owner);
        fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
    } catch (e) {
        console.error(`[Sandbox Journal] Failed to write journal for ${owner}:`, e.message);
    }
};

const recordSandboxFileChange = (owner, filePath, action = 'add') => {
    if (!owner) return;
    try {
        const journal = readSandboxJournal(owner);
        const normPath = String(filePath || '').replace(/\\/g, '/');
        const entry = { path: normPath, timestamp: new Date().toISOString() };
        if (action === 'add') {
            if (!journal.addedFiles.some(f => (typeof f === 'string' ? f : f.path) === normPath)) {
                journal.addedFiles.push(entry);
            }
        } else if (action === 'amend') {
            if (!journal.amendedFiles.some(f => (typeof f === 'string' ? f : f.path) === normPath)) {
                journal.amendedFiles.push(entry);
            }
        }
        writeSandboxJournal(owner, journal);
    } catch (e) {
        console.error(`[Sandbox Journal] Error recording file change for ${owner}:`, e.message);
    }
};

const saveSandboxLoginSnapshot = (owner) => {
    const sanitized = sanitizeUsername(owner);
    const sandboxPath = getSandboxDbPath(sanitized);
    const snapshotPath = getSandboxLoginSnapshotPath(sanitized);
    if (fs.existsSync(sandboxPath)) {
        try {
            fs.copyFileSync(sandboxPath, snapshotPath);
            console.log(`[Sandbox] Saved database login snapshot for ${sanitized}`);
        } catch (e) {
            console.error(`[Sandbox] Failed to save DB login snapshot for ${sanitized}:`, e);
        }
    }
    // Snapshot sandbox files & reset session journal
    try {
        const sbUploads = getSandboxUploadsPath(sanitized);
        const sbSnapshotUploads = getSandboxLoginSnapshotUploadsPath(sanitized);
        if (fs.existsSync(sbSnapshotUploads)) {
            fs.rmSync(sbSnapshotUploads, { recursive: true, force: true });
        }
        if (fs.existsSync(sbUploads)) {
            fs.cpSync(sbUploads, sbSnapshotUploads, { recursive: true });
        }
        writeSandboxJournal(sanitized, { loginTime: new Date().toISOString(), addedFiles: [], amendedFiles: [] });
        console.log(`[Sandbox] Saved files login snapshot & initialized journal for ${sanitized}`);
    } catch (e) {
        console.error(`[Sandbox] Failed to save files login snapshot for ${sanitized}:`, e.message);
    }
};

const resolveDocumentDiskPath = (filePath) => {
    if (!filePath || typeof filePath !== 'string') return null;
    const directPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
    if (fs.existsSync(directPath)) return directPath;
    // Uploads live under UPLOADS_PATH when it is set (e.g. /data/uploads): a stored 'uploads/...' path is relative to its parent.
    if (!path.isAbsolute(filePath) && /^uploads[\\/]/.test(filePath)) {
        const upl = path.join(path.dirname(UPLOADS_BASE), filePath);
        if (fs.existsSync(upl)) return upl;
    }

    // COW fallback: if path references a sandbox uploads location that hasn't been created/amended,
    // fall back to the live baseline document
    const norm = filePath.replace(/\\/g, '/');
    if (norm.includes('uploads/sandbox/')) {
        const baseline = norm.replace(/uploads\/sandbox\/[^/]+\//, 'uploads/');
        const baselineDirect = path.isAbsolute(baseline) ? baseline : path.join(__dirname, baseline);
        if (fs.existsSync(baselineDirect)) return baselineDirect;
        if (!path.isAbsolute(baseline)) { const b2 = path.join(path.dirname(UPLOADS_BASE), baseline); if (fs.existsSync(b2)) return b2; }
    }
    return null;
};

const getDbPath = (req) => req.sandboxDbPath || DB_PATH;
const isSandbox = (req) => Boolean(req.sandboxDbPath);
// TTL cache for /api/v1/auth/environments discovery responses (per username)
const discoveryCache = new Map(); // username -> { data, expiresAt }

// Synchronize authoritative user accounts, roles, group memberships, and profiles from live db to all sandbox databases
const syncAuthoritativeUsersToSandboxes = (liveDb) => {
    if (!liveDb || !Array.isArray(liveDb.users)) return;
    try {
        const files = fs.readdirSync(__dirname).filter(
            f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.login_snapshot.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp')
        );
        for (const file of files) {
            const sPath = path.join(__dirname, file);
            const sDb = readDb(sPath);
            if (!sDb || !Array.isArray(sDb.users)) continue;
            let changed = false;
            for (const liveUser of liveDb.users) {
                const sIdx = sDb.users.findIndex(u => u.username.toLowerCase() === liveUser.username.toLowerCase());
                if (sIdx !== -1) {
                    const sUser = sDb.users[sIdx];
                    const rolesChanged = JSON.stringify(sUser.roles || []) !== JSON.stringify(liveUser.roles || []);
                    const groupsChanged = JSON.stringify(sUser.groupIds || []) !== JSON.stringify(liveUser.groupIds || []);
                    const nameChanged = sUser.name !== liveUser.name;
                    const emailChanged = sUser.email !== liveUser.email;
                    const passChanged = liveUser.password && sUser.password !== liveUser.password;

                    if (rolesChanged || groupsChanged || nameChanged || emailChanged || passChanged) {
                        sDb.users[sIdx] = {
                            ...sUser,
                            roles: liveUser.roles || [],
                            groupIds: liveUser.groupIds || [],
                            name: liveUser.name || sUser.name,
                            email: liveUser.email || sUser.email,
                            password: liveUser.password || sUser.password
                        };
                        changed = true;
                    }
                }
            }
            if (changed) {
                writeDb(sDb, sPath);
                console.log(`[Sandbox Sync] Synchronized authoritative users/roles to ${file}`);
            }
        }
    } catch (e) {
        console.error('[Sandbox Sync] Error syncing users across sandboxes:', e);
    }
};

const SERVER_START_TIME = Date.now();
const FACTORY_PASS = 'YousefNadody!@#2';
const CURRENT_SCHEMA_VERSION = 11; // Increment when introducing new schema migrations
const FORCE_SCHEMA_MIGRATION = process.env.FORCE_SCHEMA_MIGRATION === 'true';

const getItemEffectiveQty = (item) => {
    const qty = (item && item.alteredQty !== undefined && item.alteredQty !== null) ? item.alteredQty : (item && item.quantity);
    return qty || 1;
};

// R34 round 5 (validator 4, item 7): ONE internal-stock test for the server, Cash / Bank, AR and stock value (shared/orderMoney.js)
// Merge with origin/NexusVSC v1.0001203: a rejected stock order renamed REJ_<ts>_STOCK-... still counts as a stock order here.
const isStockOrder = (order) => {
    if (!order) return false;
    if (isInternalStockOrder(order)) return true;
    const po = typeof order.customerReferenceNumber === 'string' ? order.customerReferenceNumber.trim().toUpperCase() : '';
    return /^REJ_[\d-]+_STOCK-/.test(po);
};

// --- MULTER CONFIG ---
// All uploaded files land directly under UPLOADS_BASE/<subdir>/ (e.g. uploads/pod/,
// uploads/cost_sheets/, uploads/einvoices/) so that all files across the entire app
// reside in the same unified storage area and can be backed up together.
const resolveUploadDir = (req, subDir) => {
    const isSb = Boolean(req?.sandboxOwner);
    const base = isSb ? getSandboxUploadsPath(req.sandboxOwner) : UPLOADS_BASE;
    const dir = path.join(base, subDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const mirrorToSandboxIfApplicable = (req, subDir, filePath) => {
    // Under Copy-On-Write (COW), files are directly written to their respective isolated location
};

// R25 (CX18): uploads larger than 10 MB are refused by the server too (the form checks it in the browser only).
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const limitedUpload = (storage) => {
    const m = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });
    return { single: (field) => (req, res, next) => m.single(field)(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ success: false, error: 'File exceeds the 10 MB limit' });
        return res.status(400).json({ success: false, error: 'Upload failed: ' + err.message });
    }) };
};

// R25 (CX18): the stored path of an upload is 'uploads/<subdir>/<file>' (served by /uploads) even when UPLOADS_PATH is outside the app folder;
// path.relative(__dirname, ...) gave '../data/uploads/...' there and the links in the screens opened nothing.
const storedUploadPath = (absPath) => {
    const rel = path.relative(UPLOADS_BASE, absPath).replace(/\\/g, '/');
    return rel.startsWith('..') ? path.relative(__dirname, absPath).replace(/\\/g, '/') : 'uploads/' + rel;
};

const podStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, resolveUploadDir(req, 'pod'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'pod-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadPod = limitedUpload(podStorage);

const einvoiceStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, resolveUploadDir(req, 'einvoices'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'einvoice-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadEInvoice = limitedUpload(einvoiceStorage);

const whtStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, resolveUploadDir(req, 'wht_certificates'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'wht-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadWht = limitedUpload(whtStorage);

const costSheetStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, resolveUploadDir(req, 'cost_sheets'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'cost-sheet-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadCostSheet = multer({ storage: costSheetStorage });

const saveBase64CostSheetToFile = (base64String, req = null, opts = {}) => {
    if (!base64String || typeof base64String !== 'string' || !base64String.startsWith('data:')) {
        return base64String;
    }
    try {
        const isLive = !req?.sandboxOwner;
        const uploadDir = isLive ? path.join(UPLOADS_BASE, 'cost_sheets') : path.join(getSandboxUploadsPath(req.sandboxOwner), 'cost_sheets');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        let ext = '.xlsx';
        const match = base64String.match(/^data:([a-zA-Z0-9-+/.]+);base64,/);
        if (match) {
            const mime = match[1];
            if (mime.includes('pdf')) ext = '.pdf';
            else if (mime.includes('csv')) ext = '.csv';
            else if (mime.includes('word')) ext = '.docx';
        }

        const b64Data = base64String.split(';base64,').pop();
        const fileName = `cost-sheet-${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
        const filePath = path.join(uploadDir, fileName);

        fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));

        mirrorToSandboxIfApplicable(req, 'cost_sheets', filePath);
        const relativePath = isLive ? `uploads/cost_sheets/${fileName}` : `uploads/sandbox/${req.sandboxOwner}/cost_sheets/${fileName}`;
        if (opts.strict) return { relativePath, filePath, buffer: Buffer.from(b64Data, 'base64') }; // v1.0001201: caller stores it in Dropbox first
        if (!isLive && req?.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, Buffer.from(b64Data, 'base64')).catch(() => {});
        return relativePath;
    } catch (err) {
        console.error('[CostSheet] Failed to persist base64 to disk:', err);
        return base64String;
    }
};

// v1.0001201: strict mode stores a base64 cost sheet only when Dropbox accepted it (else throws with httpStatus 503).
const persistBase64CostSheet = async (base64String, req = null) => {
    if (!STRICT_REMOTE.on) return saveBase64CostSheetToFile(base64String, req);
    const fail = (message) => { const e = new Error(message); e.httpStatus = 503; e.code = 'DROPBOX_UPLOAD_FAILED'; return e; };
    const saved = saveBase64CostSheetToFile(base64String, req, { strict: true });
    if (!saved || typeof saved !== 'object') throw fail('Not stored: the cost sheet file could not be written.');
    const r = await storeUploadInDropbox(req, saved.relativePath, saved.buffer);
    if (!r.ok) {
        try { fs.unlinkSync(saved.filePath); } catch {}
        throw fail(r.message);
    }
    if (req?.sandboxOwner) recordSandboxFileChange(req.sandboxOwner, saved.relativePath, 'add');
    return saved.relativePath;
};

const supplierReceiptStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, resolveUploadDir(req, 'supplier_receipts'));
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'supplier-receipt-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadSupplierReceipt = limitedUpload(supplierReceiptStorage);

const uploadGoogleDriveFile = multer({ storage: multer.memoryStorage() });

const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_OAUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const DEFAULT_LOCAL_STORAGE_CONFIG = {
    enabled: true,
    autoUploadExternalSubmissions: true,
    storageIp: '',
    apiPort: 9000,
    consolePort: 9001,
    accessKey: '',
    secretKey: '',
    bucketName: ''
};

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
    WAITING_GOVE: 'WAITING_GOVE',
    FULFILLED: 'FULFILLED',
    RUNNING_OUTSOURCING_CONTRACT: 'RUNNING_OUTSOURCING_CONTRACT'
};

// Per-item effective status: determines what workflow stage a line item is in based on its components
const getItemEffectiveStatus = (item) => {
    const comps = item.components || [];
    if (comps.length === 0) return 'NO_COMPONENTS';
    const statuses = comps.map(c => c.status || 'NEW');
    // If any component is running outsourcing contract
    if (statuses.some(s => s === 'RUNNING_OUTSOURCING_CONTRACT')) return 'RUNNING_OUTSOURCING_CONTRACT';
    // If any component still needs procurement action
    if (statuses.some(s => ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED', 'WAITING_CONTRACT_START'].includes(s))) return 'WAITING_SUPPLIERS';
    // If all components are reserved/received (ready to manufacture)
    if (statuses.every(s => ['RESERVED', 'RECEIVED', 'STOCKED', 'RUNNING_CONTRACT', 'CANCELLED', 'ORDERED_FOR_STOCK'].includes(s))) return 'WAITING_FACTORY';
    // If any are actively being manufactured
    if (statuses.some(s => s === 'IN_MANUFACTURING')) return 'MANUFACTURING';
    // If all are manufactured
    if (statuses.every(s => ['MANUFACTURED', 'CANCELLED'].includes(s))) return 'MANUFACTURED';
    return 'MIXED';
};

// R31 (2026-10-22): while the order waits for the Government E-Invoice its lines show DELIVERED (order status stays WAITING_GOVE)
const setGovWaitLines = (o, on) => { (o.items || []).forEach(i => { if (on) i.lineStatus = OrderStatus.DELIVERED; else delete i.lineStatus; }); };

const getCostSheetWorkbook = (input) => {
    if (!input) return null;
    if (typeof input === 'object' && input.SheetNames && input.Sheets) return input;
    try {
        if (typeof input === 'string') {
            const diskPath = resolveDocumentDiskPath(input);
            if (diskPath && fs.existsSync(diskPath)) {
                return XLSX.read(fs.readFileSync(diskPath), { type: "buffer" });
            }
        }
        const cleanBase64 = input.includes(',') ? input.split(',')[1] : input;
        return XLSX.read(cleanBase64, { type: 'base64' });
    } catch (e) {
        return null;
    }
};

const parseCostSheetProjectBlocks = (input) => {
    if (!input) return [];
    try {
        const wb = getCostSheetWorkbook(input);
        if (!wb) return [];
        const sheetName = wb.SheetNames[0];
        const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
        const data = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) : [];
        if (!data.length) return [];

        const cellText = (v) => String(v == null ? '' : v).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
        const toNumber = (v) => {
            if (typeof v === 'number') return isFinite(v) ? v : 0;
            const parsed = parseFloat(cellText(v).replace(/[,\s]/g, ''));
            return isNaN(parsed) ? 0 : parsed;
        };

        let nameCol = 0;
        if (!data.some(r => cellText((r || [])[0]) !== '') && data.some(r => cellText((r || [])[1]) !== '')) {
            nameCol = 1;
        }

        let invoiceTotalCol = -1;
        let salaryTotalCol = -1;
        for (let r = 0; r < Math.min(10, data.length); r++) {
            const row = data[r] || [];
            for (let c = 0; c < row.length; c++) {
                const rawVal = cellText(row[c]);
                const val = rawVal.toLowerCase();
                if (!val) continue;
                if ((val.includes('المرتب') || val.includes('مرتب') || val.includes('salary') || val.includes('cost')) && (val.includes('اجمال') || val.includes('إجمال') || val.includes('صافي') || val.includes('قيمه') || val.includes('قيمة') || val.includes('total'))) {
                    if (salaryTotalCol === -1 || val.includes('اجمال') || val.includes('إجمال') || val.includes('total')) {
                        salaryTotalCol = c;
                    }
                }
                if (val.includes('الفاتور') || val.includes('فاتور') || val.includes('invoice')) {
                    if (invoiceTotalCol === -1 || val.includes('اجمال') || val.includes('إجمال') || val.includes('total') || val.includes('قيمه') || val.includes('قيمة')) {
                        invoiceTotalCol = c;
                    }
                }
            }
        }

        const costSheetLabelIsTotal = (raw) => /(?:ا|إ)جمال/.test(String(raw || ''));
        const isSubHeader = (label) => {
            const v = label.toLowerCase();
            return v === '' || ['الاسم', 'اسم', 'م', 'name', 'كشف', 'تقرير', 'report', 'sheet', 'رقم', 'الرقم', 'مسلسل', 'no', 'no.', 'sr', 's/n', '#'].includes(v);
        };
        const letterRegex = new RegExp('\\p{L}', 'u');
        const isPersonRow = (label) => label !== '' && letterRegex.test(label) && !costSheetLabelIsTotal(label) && !isSubHeader(label);

        let lastCol = nameCol;
        for (const r of data) {
            const row = r || [];
            if (!isPersonRow(cellText(row[nameCol]))) continue;
            for (let c = row.length - 1; c > nameCol; c -= 1) {
                if (cellText(row[c]) !== '') { if (c > lastCol) lastCol = c; break; }
            }
        }

        const costCol = salaryTotalCol !== -1 ? salaryTotalCol : lastCol;
        let blocks = [];
        let curCount = 0;
        let curSum = 0;
        let curInvoiceSum = 0;

        const stripTotalWord = (raw) =>
            String(raw || '')
                .replace(/[ً-ْ]/g, '')
                .replace(/ال(?:ا|إ)جمالي?ى?/g, ' ')
                .replace(/(?:ا|إ)جمالي?ى?/g, ' ')
                .replace(/[:\-–—_/\\]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        for (const r of data) {
            const row = r || [];
            const label = cellText(row[nameCol]);
            if (label === '') continue;
            if (costSheetLabelIsTotal(label)) {
                const summaryCost = costCol > nameCol ? toNumber(row[costCol]) : 0;
                const finalCost = curSum > 0 ? curSum : summaryCost;
                const summaryInv = invoiceTotalCol !== -1 ? toNumber(row[invoiceTotalCol]) : 0;
                const finalInv = curInvoiceSum > 0 ? curInvoiceSum : summaryInv;

                blocks.push({
                    name: stripTotalWord(label),
                    resourceCount: curCount,
                    realCost: Math.round(finalCost * 100) / 100,
                    invoiceTotal: Math.round(finalInv * 100) / 100
                });
                curCount = 0;
                curSum = 0;
                curInvoiceSum = 0;
                continue;
            }
            if (!isPersonRow(label)) continue;
            curCount += 1;
            curSum += costCol > nameCol ? toNumber(row[costCol]) : 0;
            if (invoiceTotalCol !== -1 && invoiceTotalCol !== costCol) {
                curInvoiceSum += toNumber(row[invoiceTotalCol]);
            }
        }
        return blocks;
    } catch (e) {
        console.error('[CostSheet] Block parse error:', e);
        return [];
    }
};

const normalizeProjectName = (raw) => {
    const normRegex = new RegExp('[^\\p{L}\\p{N}]+', 'gu');
    return String(raw || '')
        .replace(/[ً-ْ]/g, '')
        .replace(/ال(?:ا|إ)جمالي?ى?/g, ' ')
        .replace(/(?:ا|إ)جمالي?ى?/g, ' ')
        .replace(/[:\-–—_/\\]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(normRegex, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const findCostSheetProjectBlock = (blocks, projectName) => {
    const target = normalizeProjectName(projectName);
    if (!target || !blocks.length) return null;
    let match = blocks.find(b => normalizeProjectName(b.name) === target);
    if (!match) {
        match = blocks.find(b => {
            const n = normalizeProjectName(b.name);
            return n !== '' && (n.includes(target) || target.includes(n));
        });
    }
    return match || null;
};

const extractCostSheetProjectMetrics = (input, projectName) => {
    if (!input || !projectName || !String(projectName).trim()) return null;
    const blocks = parseCostSheetProjectBlocks(input);
    const match = findCostSheetProjectBlock(blocks, projectName);
    if (!match) return null;
    return {
        resourceCount: match.resourceCount,
        realCost: match.realCost,
        invoiceTotal: match.invoiceTotal,
        projectName: match.name
    };
};

const extractCostSheetMetrics = (base64Data, projectName) => {
    if (!base64Data) return { resourceCount: 0, realCost: 0, invoiceTotal: 0 };

    try {
        const wb = getCostSheetWorkbook(base64Data);
        if (!wb) return { resourceCount: 0, realCost: 0, invoiceTotal: 0 };

        // If a projectName is provided, first try matching a project-specific block
        if (projectName && String(projectName).trim()) {
            const blocks = parseCostSheetProjectBlocks(wb);
            const match = findCostSheetProjectBlock(blocks, projectName);
            if (match) {
                return {
                    resourceCount: match.resourceCount,
                    realCost: match.realCost,
                    invoiceTotal: match.invoiceTotal,
                    projectName: match.name
                };
            }
        }

        const sheetName = wb.SheetNames[0];
        if (!sheetName) return { resourceCount: 0, realCost: 0, invoiceTotal: 0 };
        const sheet = wb.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        let salaryTotalCol = -1;
        let invoiceTotalCol = -1;
        let nameCol = 0;

        // Scan top 10 rows for column headers
        for (let r = 0; r < Math.min(10, data.length); r++) {
            const row = data[r] || [];
            for (let c = 0; c < row.length; c++) {
                const rawVal = String(row[c] || '').trim();
                const val = rawVal.toLowerCase();
                if ((val.includes('المرتب') || val.includes('مرتب') || val.includes('salary') || val.includes('cost')) && (val.includes('اجمال') || val.includes('إجمال') || val.includes('صافي') || val.includes('قيمه') || val.includes('قيمة') || val.includes('total'))) {
                    if (salaryTotalCol === -1 || val.includes('اجمال') || val.includes('إجمال') || val.includes('total')) {
                        salaryTotalCol = c;
                    }
                }
                if (val.includes('الفاتور') || val.includes('فاتور') || val.includes('invoice')) {
                    if (invoiceTotalCol === -1 || val.includes('اجمال') || val.includes('إجمال') || val.includes('total') || val.includes('قيمه') || val.includes('قيمة')) {
                        invoiceTotalCol = c;
                    }
                }
                if (val === 'الاسم' || val === 'اسم' || val === 'name') {
                    nameCol = c;
                }
            }
        }

        let resourceCount = 0;
        let realCost = 0;
        let invoiceTotal = 0;

        for (let r = 0; r < data.length; r++) {
            const row = data[r] || [];
            const cell0 = String(row[nameCol] || '').trim();
            if (!cell0) continue;

            const isSummaryOrHeader = 
                cell0.includes('اجمال') || cell0.includes('إجمال') ||
                cell0.includes('مجموع') || cell0.includes('المجموع') ||
                cell0.includes('صافي') || cell0.includes('الصافي') ||
                /^(الاسم|اسم|name|كشف|بيان|تقرير|report|sheet)/i.test(cell0) ||
                cell0.toLowerCase().includes('total') ||
                cell0.toLowerCase().includes('subtotal') ||
                cell0.toLowerCase().includes('summary');

            if (isSummaryOrHeader) {
                if (cell0.includes('اجمال') || cell0.includes('إجمال') || cell0.toLowerCase().includes('total')) {
                    const numSalary = typeof row[salaryTotalCol] === 'number' ? row[salaryTotalCol] : parseFloat(String(row[salaryTotalCol] || '').replace(/,/g, ''));
                    if (!isNaN(numSalary) && numSalary > realCost) {
                        realCost = numSalary;
                    }
                    const numInv = typeof row[invoiceTotalCol] === 'number' ? row[invoiceTotalCol] : parseFloat(String(row[invoiceTotalCol] || '').replace(/,/g, ''));
                    if (!isNaN(numInv) && numInv > invoiceTotal) {
                        invoiceTotal = numInv;
                    }
                }
            } else {
                resourceCount++;
            }
        }

        return {
            resourceCount,
            realCost: Math.round(realCost * 100) / 100,
            invoiceTotal: Math.round(invoiceTotal * 100) / 100
        };
    } catch (e) {
        console.error("[CostSheet] Extraction error:", e.message);
        return { resourceCount: 0, realCost: 0, invoiceTotal: 0 };
    }
};

// Margin release memory: a management release holds only while revenue, cost, rate and threshold stay as they were.
// R34 round 6 (validator 5, O1): the margin gate converts the revenue at the order rate ONLY for a non-L.E. order; an L.E. order with
// a stray conversion rate is not converted (the same rule as orderFx / shared orderFxRate). Hoisted, used by the margin helpers below.
function marginFx(o) { return (o && o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1; }
const marginReleaseSig = (items, minMargin, conversionRate) => {
    let rev = 0, cost = 0;
    (items || []).forEach(it => {
        rev += ((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
        (it.components || []).forEach(c => { cost += ((c.quantity || 0) * (c.unitCost || 0)); });
    });
    const rate = (Number.isFinite(Number(conversionRate)) && Number(conversionRate) > 0) ? Number(conversionRate) : 1;
    return `${rev.toFixed(2)}|${cost.toFixed(2)}|${rate}|${Number(minMargin)}`;
};

const evaluateMarginStatus = (items, minMargin, currentStatus, conversionRate = 1, isBlanketOrder = false, isStock = false, releasedSig = null) => {
    let totalRevenue = 0;
    let totalCost = 0;
    let hasComponents = false;
    let hasActiveTechReview = false;
    let anyAccepted = false;

    (items || []).forEach(it => {
        totalRevenue += ((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
        if (it.isAccepted) anyAccepted = true;
        if (it.components && it.components.length > 0) {
            hasComponents = true;
            
            if (it.productionType === 'OUTSOURCING' && !it.techTouched) {
                // R30 ruling 19:12: an outsourcing order created by sales stays LOGGED; only a technical-user touch (set-production-type, accept, or costed components) moves it.
                const touchedComps = it.components.some(c => c.unitCost > 0 || c.supplierId || c.source === 'STOCK' || (c.status && c.status !== 'PENDING_OFFER' && c.status !== 'NEW'));
                if (touchedComps) hasActiveTechReview = true;
            } else if (it.productionType === 'MANUFACTURING' || it.productionType === 'OUTSOURCING') {
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

    // Safeguard: Don't auto-transition terminal or manual statuses
    if ([OrderStatus.REJECTED, OrderStatus.IN_HOLD].includes(currentStatus)) return currentStatus;

    // BLANKET ORDER & STOCK ORDER EXEMPTION: Blanket orders and internal stock orders
    // skip all margin/status auto-transitions because they have no customer markup margin.
    // They are allowed to proceed through technical review, procurement, and delivery without margin checks.
    if (isBlanketOrder || isStock) {
        // Still allow tech review transition if at least one item is accepted or in active tech review
        if ((hasActiveTechReview || anyAccepted) && currentStatus === OrderStatus.LOGGED) {
            return OrderStatus.TECHNICAL_REVIEW;
        }
        // If an exempt order somehow had NEGATIVE_MARGIN (e.g. legacy data), auto-recover it!
        if (currentStatus === OrderStatus.NEGATIVE_MARGIN) {
            const hasProcurementActive = (items || []).some(it => 
                (it.components || []).some(c => ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED', 'WAITING_CONTRACT_START'].includes(c.status))
            );
            if (hasProcurementActive) {
                return OrderStatus.WAITING_SUPPLIERS;
            }
            return (hasActiveTechReview || anyAccepted) ? OrderStatus.TECHNICAL_REVIEW : OrderStatus.LOGGED;
        }
        return currentStatus;
    }

    // Multi-currency amendment: when the order is denominated in a non-L.E.
    // currency, the cost side (PO currency) is brought into the order's revenue
    // currency via the per-order conversionRate so the P/L threshold check is
    // apples-to-apples. conversionRate defaults to 1 for legacy / L.E. orders.
    const safeRate = (Number.isFinite(Number(conversionRate)) && Number(conversionRate) > 0) ? Number(conversionRate) : 1;
    // R22 (C23): procurement costs are already in L.E.; only the revenue (order currency x rate = L.E.) is converted.
    const totalCostInOrderCurrency = totalCost;
    const totalRevenueLE = totalRevenue * safeRate;

    const marginAmt = totalRevenueLE - totalCostInOrderCurrency;
    const markupPct = totalCostInOrderCurrency > 0 ? (marginAmt / totalCostInOrderCurrency) * 100 : (totalRevenueLE > 0 ? 100 : 0);

    // Priority 1: Margin Protection (only when costs have been identified, exempting blanket orders)
    const releasedHold = Boolean(releasedSig) && releasedSig === marginReleaseSig(items, minMargin, conversionRate);
    if (hasComponents && !releasedHold && isMarginBreach(totalCostInOrderCurrency, markupPct, minMargin, isBlanketOrder)) return OrderStatus.NEGATIVE_MARGIN;

    // Priority 2: Technical Workflow Transition
    if ((hasActiveTechReview || anyAccepted) && currentStatus === OrderStatus.LOGGED) {
        return OrderStatus.TECHNICAL_REVIEW;
    }

    // Priority 3: Recovery from Negative Margin (sticky: only exit when costs are known and margin recovers, or components are removed)
    if (currentStatus === OrderStatus.NEGATIVE_MARGIN && (!hasComponents || markupPct >= minMargin || totalCostInOrderCurrency === 0)) {
        // [FIX] Check if any components are actively in the procurement pipeline.
        const hasProcurementActive = (items || []).some(it => 
            (it.components || []).some(c => ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED', 'WAITING_CONTRACT_START'].includes(c.status))
        );
        if (hasProcurementActive) {
            return OrderStatus.WAITING_SUPPLIERS;
        }
        return (hasActiveTechReview || anyAccepted) ? OrderStatus.TECHNICAL_REVIEW : OrderStatus.LOGGED;
    }

    return currentStatus;
};

const orderComponentsRequiringPo = (order) => {
    return (order.items || [])
        .flatMap(item => item.components || [])
        .filter(comp => comp.source === 'PROCUREMENT');
};

const canIssuePoForOrder = (order, minMargin) => {
    const procurementComponents = orderComponentsRequiringPo(order);
    if (procurementComponents.length === 0) return false;

    // Binary 0/1 PO-readiness gate: a component is "ready" (1) unless it is
    // still in a pre-PO status.  Only PENDING_OFFER and RFP_SENT are pre-PO.
    // This blacklist approach is future-proof — new statuses are automatically OK.
    const PRE_PO_STATUSES = ['PENDING_OFFER', 'RFP_SENT'];
    if (!procurementComponents.every(comp => !PRE_PO_STATUSES.includes(comp.status))) {
        return false;
    }

    if (isStockOrder(order)) return true;
    // Blanket orders are exempt from margin protection checks for PO issuance
    if (order.blanketOrder || order.contractId || order.blanketContractId) return true;

    let totalRevenue = 0;
    let totalCost = 0;
    (order.items || []).forEach(item => {
        totalRevenue += ((getItemEffectiveQty(item) || 0) * (item.pricePerUnit || 0));
        (item.components || []).forEach(comp => {
            totalCost += ((comp.quantity || 0) * (comp.unitCost || 0));
        });
    });

    // Multi-currency amendment: bring the cost side into the order's revenue
    // currency before computing markup so the threshold is in the order's
    // native units.
    const safeRate = marginFx(order); // round 6 (O1): only a non-L.E. order is converted
    // R22 (C23): costs are L.E.; convert the revenue side only.
    const totalCostInOrderCurrency = totalCost;
    const totalRevenueLE = totalRevenue * safeRate;

    const markupPct = totalCostInOrderCurrency > 0 ? ((totalRevenueLE - totalCostInOrderCurrency) / totalCostInOrderCurrency) * 100 : (totalRevenueLE > 0 ? 100 : 0);
    if (order.marginReleasedSig && order.marginReleasedSig === marginReleaseSig(order.items, minMargin, marginFx(order))) return true;
    return markupPct >= minMargin;
};

const orderWhtAmount = (order) => {
    let net = 0;
    (order.items || []).forEach(it => { net += Math.round(((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) + Number.EPSILON) * 100) / 100; });
    return Math.round(net) / 100;
};

const isOrderFullyPaid = (order) => {
    if (!order.payments) return false;
    // v1.0001220 (N1): on a reopened cancelled order, paid money its reopen could not take back from the customer general wallet
    // (paymentMovedToWallet left over: spent or refunded there) no longer pays this order.
    const leftInWallet = order.status !== OrderStatus.REJECTED ? (Number(order.paymentMovedToWallet) || 0) : 0;
    const totalPaid = order.payments.reduce((s, p) => s + (p.amount || 0), 0) - leftInWallet;
    let revenue = 0;
    (order.items || []).forEach(it => {
        revenue += ((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100)));
    });

    let targetRevenue = revenue;
    if (order.appliesWithholdingTax) {
        targetRevenue = revenue - orderWhtAmount(order); // the customer keeps 1% of the NET amount: that part is cleared in the Tax tab
    }

    return totalPaid >= (targetRevenue - 0.01); // 0.01 for floating point precision
};

const isOrderFullyDelivered = (order) => {
    if (!order.items || order.items.length === 0) return false;
    return order.items.every(i => (i.deliveredQty || 0) >= getItemEffectiveQty(i));
};

// --- DATABASE HANDLERS ---
const readDb = (customPath = null) => {
  const targetPath = customPath || DB_PATH;
  const isLive = targetPath === DB_PATH;
  const bakPath = targetPath + '.local.bak';

  if (!fs.existsSync(targetPath)) {
    if (isLive) {
      if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, targetPath);
      } else {
        const stubPath = path.join(__dirname, 'db.stub.json');
        if (fs.existsSync(stubPath)) fs.copyFileSync(stubPath, targetPath);
        else return {};
      }
    } else {
      return {};
    }
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const db = JSON.parse(raw);
    if (db.settings?.[0]?.dbSchemaVersion < CURRENT_SCHEMA_VERSION) {
      applySchemaMigrations(db, targetPath);
    }
    reconcileStockAllocations(db, targetPath);
    return db;
  } catch (err) {
    console.error(`[DB] Read error on ${targetPath}:`, err);
    if (fs.existsSync(bakPath)) {
      try { return JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch {}
    }
    return {};
  }
};

const { createClient } = require('@libsql/client/web');

// R14/R15: secrets come from the environment or from files outside the code and outside the app data
// (like Render/Vercel). Never log the values.
const readSecretFile = (envName, defaults = []) => {
  const cands = [process.env[envName], ...defaults].filter(Boolean);
  for (const f of cands) {
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch {}
  }
  return '';
};
const DEFAULT_TURSO_URL = process.env.TURSO_URL || 'libsql://qualitycheck-moataznegm.aws-us-west-2.turso.io';
// Order: TURSO_TOKEN env, then TURSO_TOKEN_FILE (or /secrets/turso.token, /run/secrets/turso_token). No secret lives in the code;
// Turso and Dropbox are off by default (local-storage) until a deployment turns them on.
const getDefaultTursoToken = () => process.env.TURSO_TOKEN
  || readSecretFile('TURSO_TOKEN_FILE', ['/secrets/turso.token', '/run/secrets/turso_token']);

// ==================== PERSISTENCE GUARD (v1.0001200) ====================
// Render (and any ephemeral host) loses db.json on every deploy/restart. These rules keep the
// Turso copy safe and make an empty boot hydrate from Turso instead of starting empty:
//  1. TURSO_ENABLED=1 (env) switches Turso on at boot, independent of db.json; URL/token from
//     TURSO_DATABASE_URL (or TURSO_URL) and TURSO_AUTH_TOKEN (or TURSO_TOKEN / TURSO_TOKEN_FILE).
//     TURSO_ENABLED=0 forces it off. Unset: the Settings switch (settings[0].useTurso + tursoUrl) decides, as before.
//  2. Hydrate runs before the live DB is used. If it fails, or the remote is below TURSO_MIN_RECORDS,
//     the server goes READ-ONLY (writes answer 503) instead of starting empty and pushing.
//  3. A live write/push that shrinks orders/users/customers/suppliers/supplierPayments against the
//     last known remote by more than TURSO_SHRINK_MAX_PCT % (and at least TURSO_SHRINK_MIN_DROP rows,
//     or to an empty DB) is refused unless forced (restore / wipe routes).
//  4. Before the remote row 'live' is replaced it is copied to 'live.<timestamp>' (last
//     TURSO_SNAPSHOT_KEEP kept); every push carries revision+1 and only lands if the remote revision
//     is still the one we read (another instance wrote -> conflict -> read-only until re-hydrate).
//     Pushes run one at a time per target, in order (pending writes coalesce to the newest state).
// Never log or expose URL tokens or keys.
const envFlagValue = (name) => {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === '') return null;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
};
const envInt = (name, def) => {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
};
const TURSO_ENV_SWITCH = envFlagValue('TURSO_ENABLED');
const TURSO_SNAPSHOT_KEEP = envInt('TURSO_SNAPSHOT_KEEP', 10);
const TURSO_MIN_RECORDS = envInt('TURSO_MIN_RECORDS', 1);
const TURSO_SHRINK_MAX_PCT = envInt('TURSO_SHRINK_MAX_PCT', 20);
const TURSO_SHRINK_MIN_DROP = envInt('TURSO_SHRINK_MIN_DROP', 3);
const TURSO_HYDRATE_RETRY_SEC = envInt('TURSO_HYDRATE_RETRY_SEC', 60);
const GUARDED_COLLECTIONS = ['orders', 'users', 'customers', 'suppliers', 'supplierPayments'];
const COUNTED_COLLECTIONS = [...GUARDED_COLLECTIONS, 'inventory', 'contracts', 'ledger'];
const SERVER_APP_VERSION = (() => {
    try {
        const m = fs.readFileSync(path.join(__dirname, 'constants.tsx'), 'utf8').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
        return m ? m[1] : 'unknown';
    } catch { return 'unknown'; }
})();

// ==================== STRICT REMOTE MODE (v1.0001201) ====================
// When strict, the cloud is the only store: Turso holds the database, Dropbox holds uploaded files.
// There is NO fallback to the local db.json or to local-only uploads:
//  - Turso is always on (the Settings switch and TURSO_ENABLED=0 cannot turn it off). URL/token come from
//    env, the Settings data, then the INITIAL_CONFIG defaults in constants.tsx. Unresolvable/unreachable
//    -> read-only with a clear reason; until the data was loaded from (or confirmed by) Turso in this
//    process, the data API answers 503 STRICT_NOT_LOADED (GETs included): the local file is only a cache.
//  - The remote row always wins at hydrate; a local copy is never pushed up as the source.
//  - A live push that fails -> read-only; the pending change is pushed (revision-checked) on the retry.
//  - An upload is stored only when the Dropbox upload succeeded (else 503 and the local file is removed);
//    files are served from Dropbox, a local file only as a cache of a file confirmed in Dropbox.
// STRICT_REMOTE=1 / 0 decides; unset -> ON when the RENDER env var is set (Render sets it on every service).
// NODE_ENV=production alone does NOT switch it on: the local test container runs with NODE_ENV=production
// and must keep Turso/Dropbox off.
const STRICT_REMOTE = (() => {
    const v = envFlagValue('STRICT_REMOTE');
    if (v !== null) return { on: v, by: v ? 'env' : 'env-off' };
    if (process.env.RENDER && String(process.env.RENDER).trim() !== '') return { on: true, by: 'render' };
    return { on: false, by: 'default-off' };
})();
const DROPBOX_CHECK_SEC = envInt('DROPBOX_CHECK_SEC', 300);
// Defaults of the INITIAL_CONFIG settings block in constants.tsx (the same values the browser seeds into
// the settings). Used only in strict mode, after env and the stored settings. Never logged or exposed.
const INITIAL_REMOTE_DEFAULTS = (() => {
    const out = { tursoUrl: '', tursoAuthToken: '', dropbox: { appKey: '', appSecret: '', refreshToken: '', folderPath: '' } };
    try {
        const src = fs.readFileSync(path.join(__dirname, 'constants.tsx'), 'utf8');
        const start = src.search(/export\s+const\s+INITIAL_CONFIG\b/);
        if (start < 0) return out;
        const rest = src.slice(start + 1);
        const nextExport = rest.search(/\nexport\s+/);
        const block = nextExport >= 0 ? rest.slice(0, nextExport) : rest;
        const str = (re, s) => { const m = s.match(re); return m ? m[2] : ''; };
        out.tursoUrl = str(/\btursoUrl\s*:\s*(['"`])([^'"`]*)\1/, block);
        out.tursoAuthToken = str(/\btursoAuthToken\s*:\s*(['"`])([^'"`]*)\1/, block);
        const dbx = block.match(/\bdropboxConfig\s*:\s*\{([^}]*)\}/);
        if (dbx) {
            for (const k of ['appKey', 'appSecret', 'refreshToken', 'folderPath']) {
                out.dropbox[k] = str(new RegExp(`\\b${k}\\s*:\\s*(['"\`])([^'"\`]*)\\1`), dbx[1]);
            }
        }
    } catch {}
    return out;
})();
if (STRICT_REMOTE.on) {
    console.log(`[Strict] Strict remote mode ON (by ${STRICT_REMOTE.by}): Turso is the only database, Dropbox the only file store; no local fallback.`);
    if (envFlagValue('TURSO_ENABLED') === false) console.warn('[Strict] TURSO_ENABLED=0 is ignored: strict mode keeps Turso on.');
}

const countRecords = (db) => {
    const out = { total: 0 };
    for (const col of COUNTED_COLLECTIONS) {
        const n = Array.isArray(db?.[col]) ? db[col].length : 0;
        out[col] = n;
        out.total += n;
    }
    return out;
};

const persistState = {
    source: 'unknown',            // turso | local | stub | restore
    hydrated: false,              // live pushes wait until the boot hydrate has decided
    readOnly: false,
    readOnlyReason: '',
    readOnlySince: null,
    pendingForcePush: false,      // a restore/wipe was saved locally but its push failed: push it on the next retry
    pendingPush: false,           // strict: a normal live push failed; push the local state (revision-checked) on the retry
    remoteLoaded: false,          // strict: the live file was loaded from / confirmed by Turso in this process
    turso: { enabled: false, by: 'off', configured: false },
    hydrate: { at: null, ok: null, error: null, remoteFound: null, remoteCounts: null, remoteRevision: null, attempts: 0, skippedRemote: null },
    lastRemoteCounts: null,       // shrink-guard baseline (remote row 'live')
    remoteRevision: null,         // revision of row 'live' we last read or wrote
    lastPush: { at: null, ok: null, error: null, target: null, revision: null, forced: false, snapshot: null },
    refusedWrites: 0,
    lastRefusal: null,
    localCounts: null,
};

let hydrateRetryRunning = false;  // one hydrate at a time (boot retry loop, Turso switched on later)
const enterReadOnly = (reason) => {
    if (!persistState.readOnly) persistState.readOnlySince = new Date().toISOString();
    persistState.readOnly = true;
    persistState.readOnlyReason = reason;
    console.error(`[Persistence] READ-ONLY: ${reason}. Writes are refused (503) until Turso answers and the data is hydrated.`);
};
const leaveReadOnly = () => {
    if (persistState.readOnly) console.log(`[Persistence] Read-only mode cleared (was: ${persistState.readOnlyReason}).`);
    persistState.readOnly = false;
    persistState.readOnlyReason = '';
    persistState.readOnlySince = null;
};

// Turso on/off, URL and token. Env switch first; otherwise the legacy Settings switch with the old precedence.
const resolveTursoConfig = (settings) => {
    const s = settings || {};
    const settingsUrl = s.tursoUrl ? String(s.tursoUrl).trim() : '';
    const settingsToken = s.tursoAuthToken ? String(s.tursoAuthToken).trim() : '';
    if (STRICT_REMOTE.on) {
        // Strict: always on. env first, then the stored settings, then the INITIAL_CONFIG defaults.
        const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || settingsUrl || INITIAL_REMOTE_DEFAULTS.tursoUrl || DEFAULT_TURSO_URL;
        const token = process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken() || settingsToken || INITIAL_REMOTE_DEFAULTS.tursoAuthToken;
        return { enabled: true, by: 'strict', url, token };
    }
    if (TURSO_ENV_SWITCH !== null) {
        const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || settingsUrl || DEFAULT_TURSO_URL;
        const token = process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken() || settingsToken;
        return { enabled: TURSO_ENV_SWITCH, by: TURSO_ENV_SWITCH ? 'env' : 'env-off', url, token };
    }
    const legacyOn = (s.useTurso !== undefined && settingsUrl) ? !!s.useTurso : false;
    return {
        enabled: legacyOn,
        by: legacyOn ? 'settings' : 'off',
        url: settingsUrl || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL,
        token: settingsToken || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken(),
    };
};
const tursoConfigFromDb = (db) => {
    let settings = null;
    try { const s = (db?.settings || [])[0]; settings = s ? decryptSettings(s) : null; } catch {}
    return resolveTursoConfig(settings);
};
// v1.0001201: remote calls (Turso, Dropbox) get a 30 s timeout so a hung network cannot stall the server.
const REMOTE_FETCH_TIMEOUT_MS = envInt('REMOTE_FETCH_TIMEOUT_MS', 30000);
const timeoutFetch = (input, init = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REMOTE_FETCH_TIMEOUT_MS);
    if (init.signal) { if (init.signal.aborted) ctrl.abort(); else init.signal.addEventListener('abort', () => ctrl.abort(), { once: true }); }
    return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};
const tursoClientFor = (cfg) => {
    const dbUrl = cfg.url.startsWith('libsql://') ? cfg.url.replace(/^libsql:\/\//, 'https://') : cfg.url;
    return createClient({ url: dbUrl, authToken: cfg.token, fetch: timeoutFetch });
};
const tursoSchemaReady = new Set();
const ensureTursoSchema = async (client, cfg) => {
    if (tursoSchemaReady.has(cfg.url)) return;
    await client.execute(`CREATE TABLE IF NOT EXISTS nexus_state (id TEXT PRIMARY KEY, json_data TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    try {
        await client.execute(`ALTER TABLE nexus_state ADD COLUMN revision INTEGER DEFAULT 0`); // additive, once
    } catch (e) {
        if (!/duplicate column/i.test(String(e.message))) throw e;
    }
    tursoSchemaReady.add(cfg.url);
};
const tursoTargetId = (dbPath) => (dbPath === DB_PATH)
    ? 'live'
    : 'sandbox.' + path.basename(dbPath).replace('db.sandbox.', '').replace('.json', '');

// Returns a reason string when `next` loses too much against `baseline`, else null.
const findShrink = (baseline, next) => {
    if (!baseline || !next) return null;
    if ((baseline.total || 0) > 0 && (next.total || 0) === 0) return `whole database ${baseline.total} -> 0 records`;
    for (const col of GUARDED_COLLECTIONS) {
        const before = baseline[col] || 0;
        const after = next[col] || 0;
        const drop = before - after;
        if (drop < TURSO_SHRINK_MIN_DROP) continue;
        if (after === 0 || drop * 100 > before * TURSO_SHRINK_MAX_PCT) return `${col} ${before} -> ${after}`;
    }
    return null;
};
const recordRefusal = (where, reason) => {
    persistState.refusedWrites++;
    persistState.lastRefusal = { at: new Date().toISOString(), where, reason };
    console.error(`[Persistence] ${where} REFUSED: ${reason} (limit ${TURSO_SHRINK_MAX_PCT} % / ${TURSO_SHRINK_MIN_DROP} rows against the last Turso copy; use a restore to force).`);
};

const pushQueues = new Map();       // targetId -> { running, pending }
const lastPushPromise = new Map();  // dbPath -> promise of the newest scheduled push

const pushOnce = async (targetId, job) => {
    const isLive = targetId === 'live';
    const client = tursoClientFor(job.cfg);
    await ensureTursoSchema(client, job.cfg);
    if (isLive && !job.force) {
        if (persistState.lastRemoteCounts === null) {
            // No baseline yet (e.g. Turso switched on in Settings after boot): read the remote once.
            const r = await client.execute({ sql: `SELECT json_data, revision FROM nexus_state WHERE id = 'live'`, args: [] });
            if (r.rows.length && r.rows[0].json_data) {
                try { persistState.lastRemoteCounts = countRecords(JSON.parse(String(r.rows[0].json_data))); } catch {}
                if (persistState.remoteRevision === null) persistState.remoteRevision = Number(r.rows[0].revision || 0);
            }
        }
        const shrink = findShrink(persistState.lastRemoteCounts, job.counts);
        if (shrink) {
            recordRefusal('Turso push', shrink);
            return { ok: false, refused: true, reason: shrink };
        }
    }
    if (!isLive) {
        await client.execute({
            sql: `INSERT INTO nexus_state (id, json_data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json_data=excluded.json_data, updated_at=CURRENT_TIMESTAMP`,
            args: [targetId, job.payload]
        });
        console.log(`[Turso] Successfully synced ${targetId} to cloud DB.`);
        return { ok: true };
    }
    // Live row: optimistic revision check, snapshot, replace, prune - one transaction.
    const cur = await client.execute({ sql: `SELECT revision FROM nexus_state WHERE id = 'live'`, args: [] });
    const remoteRev = cur.rows.length ? Number(cur.rows[0].revision || 0) : null;
    const expected = persistState.remoteRevision;
    if (remoteRev !== null && expected !== null && remoteRev !== expected && !job.force) {
        const reason = `remote revision ${remoteRev} differs from ours ${expected} (another instance wrote)`;
        enterReadOnly(`Turso conflict: ${reason}`);
        return { ok: false, conflict: true, reason };
    }
    const base = remoteRev === null ? 0 : remoteRev;
    const nextRev = base + 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotId = remoteRev !== null && TURSO_SNAPSHOT_KEEP > 0 ? `live.${stamp}` : null;
    const stmts = [];
    if (snapshotId) {
        stmts.push({ sql: `INSERT OR REPLACE INTO nexus_state (id, json_data, updated_at, revision) SELECT ?, json_data, updated_at, revision FROM nexus_state WHERE id = 'live'`, args: [snapshotId] });
    }
    const upsertIdx = stmts.length;
    stmts.push({
        sql: `INSERT INTO nexus_state (id, json_data, revision) VALUES ('live', ?, ?) ON CONFLICT(id) DO UPDATE SET json_data=excluded.json_data, revision=excluded.revision, updated_at=CURRENT_TIMESTAMP WHERE COALESCE(nexus_state.revision, 0) = ?`,
        args: [job.payload, nextRev, base]
    });
    if (snapshotId) {
        stmts.push({ sql: `DELETE FROM nexus_state WHERE id LIKE 'live.%' AND id NOT IN (SELECT id FROM nexus_state WHERE id LIKE 'live.%' ORDER BY id DESC LIMIT ?)`, args: [TURSO_SNAPSHOT_KEEP] });
    }
    const results = await client.batch(stmts, 'write');
    if (!results[upsertIdx] || results[upsertIdx].rowsAffected < 1) {
        const reason = `remote revision moved during the push (expected ${base})`;
        enterReadOnly(`Turso conflict: ${reason}`);
        return { ok: false, conflict: true, reason };
    }
    persistState.remoteRevision = nextRev;
    persistState.lastRemoteCounts = job.counts;
    console.log(`[Turso] Successfully synced live to cloud DB (revision ${nextRev}${snapshotId ? `, previous kept as ${snapshotId}` : ''}${job.force ? ', forced' : ''}).`);
    return { ok: true, revision: nextRev, snapshot: snapshotId };
};

const runPushQueue = async (targetId, q) => {
    q.running = true;
    try {
        while (q.pending) {
            const job = q.pending;
            q.pending = null;
            let result;
            try { result = await pushOnce(targetId, job); }
            catch (e) {
                result = { ok: false, error: e.message };
                console.error(`[Turso Sync Error on ${targetId}]`, e.message);
            }
            if (targetId === 'live') {
                persistState.lastPush = {
                    at: new Date().toISOString(), ok: !!result.ok,
                    error: result.ok ? null : (result.reason || result.error || 'not pushed'),
                    target: targetId, revision: result.revision ?? persistState.remoteRevision, forced: job.force, snapshot: result.snapshot || null
                };
                if (result.ok) persistState.remoteLoaded = true;
                // Strict: a failed normal push must not leave the server writing local-only data.
                if (STRICT_REMOTE.on && !result.ok && !result.refused && !result.conflict && !job.force) {
                    persistState.pendingPush = true;
                    enterReadOnly(`strict mode: Turso push failed (${result.error || result.reason || 'not pushed'}); the last change is kept in the local cache and pushed on the next retry`);
                }
            }
            job.waiters.forEach(w => w(result));
        }
    } finally {
        q.running = false;
    }
};

// Schedules a push of `data` for `dbPath`; resolves with { ok, ... } (ok:null = Turso off / skipped).
const schedulePush = (data, dbPath, opts = {}) => {
    const isLive = dbPath === DB_PATH;
    const cfg = tursoConfigFromDb(data);
    if (isLive) persistState.turso = { enabled: !!cfg.enabled, by: cfg.by, configured: !!(cfg.url && cfg.token) };
    if (!cfg.enabled || !cfg.url || !cfg.token) return Promise.resolve({ ok: null, skipped: 'turso-off' });
    if (!opts.force && isLive && persistState.hydrate.skippedRemote) {
        // v1.0001201 root-cause fix: Turso was off when the boot hydrate ran (e.g. empty disk, stub without
        // settings), then got switched on (the browser seeds INITIAL_CONFIG settings with useTurso=true).
        // Never push before the remote row was read: hydrate first (remote wins over an empty local copy).
        if (!hydrateRetryRunning) {
            hydrateRetryRunning = true;
            console.warn('[Turso] Turso switched on after a boot without it: reading the cloud copy before any push.');
            hydrateLiveFromTurso('turso-switched-on')
                .then(() => { if (!persistState.readOnly) runStartupRepairs(); })
                .catch(() => {})
                .finally(() => { hydrateRetryRunning = false; });
        }
        return Promise.resolve({ ok: false, skipped: 'hydrate-first' });
    }
    if (!opts.force && isLive && !persistState.hydrated) {
        console.warn('[Turso] Live push skipped: boot hydrate not finished.');
        return Promise.resolve({ ok: false, skipped: 'before-hydrate' });
    }
    if (!opts.force && !opts.retryPending && persistState.readOnly) return Promise.resolve({ ok: false, skipped: 'read-only' });
    const targetId = tursoTargetId(dbPath);
    let q = pushQueues.get(targetId);
    if (!q) { q = { running: false, pending: null }; pushQueues.set(targetId, q); }
    const payload = JSON.stringify(data);
    const counts = isLive ? countRecords(data) : null;
    const p = new Promise((resolve) => {
        if (q.pending) {
            // Coalesce: the newest state replaces the queued one; the force flag sticks.
            q.pending.payload = payload;
            q.pending.counts = counts;
            q.pending.cfg = cfg;
            q.pending.force = q.pending.force || !!opts.force;
            q.pending.retryPending = q.pending.retryPending || !!opts.retryPending;
            q.pending.waiters.push(resolve);
        } else {
            q.pending = { payload, counts, cfg, force: !!opts.force, retryPending: !!opts.retryPending, waiters: [resolve] };
        }
    });
    if (!q.running) runPushQueue(targetId, q);
    lastPushPromise.set(dbPath, p);
    return p;
};
const awaitPush = (dbPath = DB_PATH) => lastPushPromise.get(dbPath) || Promise.resolve({ ok: null, skipped: 'nothing scheduled' });

const syncSandboxesWithTurso = async (client) => {
    const allRes = await client.execute(`SELECT id, json_data FROM nexus_state WHERE id LIKE 'sandbox.%'`);
    const cloudSbIds = new Set();
    for (const row of allRes.rows) {
        if (row.id && row.json_data) {
            cloudSbIds.add(row.id);
            const sbOwner = row.id.replace(/^sandbox\./, '');
            const sbPath = path.join(__dirname, `db.sandbox.${sbOwner}.json`);
            try {
                if (!fs.existsSync(sbPath)) {
                    fs.writeFileSync(sbPath, row.json_data, 'utf8');
                    console.log(`[Turso] Sandbox ${sbOwner} successfully restored from cloud.`);
                }
            } catch (e) {}
        }
    }
    // Sync any local sandboxes that are missing in cloud
    const localSbFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp'));
    for (const file of localSbFiles) {
        const sbOwner = file.replace(/^db\.sandbox\./, '').replace(/\.json$/, '');
        const targetId = `sandbox.${sbOwner}`;
        if (!cloudSbIds.has(targetId)) {
            try {
                const localSbData = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
                schedulePush(localSbData, path.join(__dirname, file));
                console.log(`[Turso] Pushed missing local sandbox ${targetId} to cloud.`);
            } catch (e) {}
        }
    }
};

// Boot (and retry) hydrate of the live DB. Decides the data source and the read-only flag.
const hydrateLiveFromTurso = async (why = 'boot') => {
    const h = persistState.hydrate;
    h.attempts++;
    h.at = new Date().toISOString();
    let localDb = null;
    if (fs.existsSync(DB_PATH)) {
        try { localDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (err) {}
    }
    const localCounts = localDb ? countRecords(localDb) : null;
    const localTotal = localCounts?.total || 0;
    const cfg = tursoConfigFromDb(localDb);
    persistState.turso = { enabled: !!cfg.enabled, by: cfg.by, configured: !!(cfg.url && cfg.token) };
    const localSource = localTotal > 0 ? 'local' : 'stub';

    if (!cfg.enabled) {
        persistState.source = localSource;
        persistState.hydrated = true;
        h.ok = null; h.error = null;
        h.skippedRemote = true; // Turso was off at this hydrate: the remote row was NOT read
        return;
    }
    h.skippedRemote = false;
    if (!cfg.url || !cfg.token) {
        if (cfg.by === 'strict') {
            h.ok = false; h.error = 'strict mode: the Turso URL or token cannot be resolved (set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)';
            persistState.source = localSource;
            persistState.remoteLoaded = false;
            enterReadOnly(h.error);
            return;
        }
        if (cfg.by === 'env') {
            h.ok = false; h.error = 'TURSO_ENABLED is set but the Turso URL or token is missing';
            persistState.source = localSource;
            enterReadOnly(h.error);
            return;
        }
        // Legacy Settings switch without a token: local only, as before.
        persistState.source = localSource;
        persistState.hydrated = true;
        h.ok = null; h.error = 'Turso switched on in Settings but no token: running local only';
        return;
    }
    try {
        console.log(`[Turso] Cloud Sync enabled (by ${cfg.by}). Checking latest data from cloud (${why})...`);
        const client = tursoClientFor(cfg);
        await ensureTursoSchema(client, cfg);
        const res = await client.execute({ sql: `SELECT json_data, revision FROM nexus_state WHERE id = ?`, args: ['live'] });
        let remoteRaw = null, remoteData = null, remoteRev = null;
        if (res.rows.length > 0 && res.rows[0].json_data) {
            remoteRaw = String(res.rows[0].json_data);
            remoteData = JSON.parse(remoteRaw); // corrupt remote -> catch -> read-only
            remoteRev = Number(res.rows[0].revision || 0);
        } else if (res.rows.length > 0) {
            remoteRev = Number(res.rows[0].revision || 0);
        }
        const remoteCounts = remoteData ? countRecords(remoteData) : null;
        h.remoteFound = !!remoteData;
        h.remoteCounts = remoteCounts;
        h.remoteRevision = remoteRev;
        if (STRICT_REMOTE.on && persistState.pendingPush && localDb && !persistState.pendingForcePush) {
            // Strict: a normal push failed earlier. Push the local cache now, still revision-checked against the
            // revision we last read/wrote (persistState.remoteRevision is not overwritten before this push).
            const r = await schedulePush(localDb, DB_PATH, { retryPending: true });
            if (r.ok) {
                persistState.pendingPush = false;
                persistState.hydrated = true;
                h.ok = true; h.error = null;
                leaveReadOnly();
                return;
            }
            if (!r.conflict && !r.refused) {
                h.ok = false; h.error = `strict mode: pending Turso push failed again (${r.error || r.reason || r.skipped})`;
                enterReadOnly(h.error);
                return;
            }
            // Conflict or shrink refusal: the remote wins below; the unpushed local cache is kept as a .bak file.
            persistState.pendingPush = false;
            console.error(`[Strict] Pending push dropped (${r.reason}); the remote row wins.`);
        }
        persistState.remoteRevision = remoteRev;
        persistState.lastRemoteCounts = remoteCounts;

        if (persistState.pendingForcePush && localDb) {
            // A restore/wipe was stored locally while Turso failed: push that state now (forced, snapshot kept).
            persistState.hydrated = true;
            const r = await schedulePush(localDb, DB_PATH, { force: true });
            if (r.ok) {
                persistState.pendingForcePush = false;
                persistState.source = 'restore';
                h.ok = true; h.error = null;
                leaveReadOnly();
            } else {
                h.ok = false; h.error = `pending restore push failed: ${r.reason || r.error || r.skipped}`;
                if (STRICT_REMOTE.on) persistState.remoteLoaded = false;
                enterReadOnly(h.error);
            }
            return;
        }

        const remoteOrders = remoteCounts?.orders || 0;
        const localOrders = localCounts?.orders || 0;
        const remoteTotal = remoteCounts?.total || 0;
        if (remoteData && (STRICT_REMOTE.on || remoteOrders >= localOrders || localTotal === 0)) {
            if (remoteTotal < TURSO_MIN_RECORDS) {
                h.ok = false; h.error = `Turso row 'live' holds ${remoteTotal} records, below TURSO_MIN_RECORDS=${TURSO_MIN_RECORDS}`;
                persistState.source = localSource;
                persistState.remoteLoaded = false;
                enterReadOnly(h.error);
                return;
            }
            if (STRICT_REMOTE.on && localTotal > 0) {
                // Strict: remote always wins; keep the replaced local cache once for a manual look.
                try {
                    if (fs.readFileSync(DB_PATH, 'utf8') !== remoteRaw) {
                        fs.copyFileSync(DB_PATH, DB_PATH + '.pre-hydrate.bak');
                        if (localOrders > remoteOrders) console.warn(`[Strict] Local cache had more orders (${localOrders}) than Turso (${remoteOrders}); Turso wins, the local copy is kept as db.json.pre-hydrate.bak.`);
                    }
                } catch {}
            }
            fs.writeFileSync(DB_PATH, remoteRaw, 'utf8');
            try { fs.copyFileSync(DB_PATH, DB_PATH + '.local.bak'); } catch {}
            persistState.source = 'turso';
            console.log(`[Turso] Live database successfully restored from cloud (${remoteOrders} orders, revision ${remoteRev}).`);
        } else if (!STRICT_REMOTE.on && localTotal >= Math.max(1, TURSO_MIN_RECORDS)) {
            persistState.source = 'local';
            persistState.hydrated = true;
            console.log(remoteData
                ? `[Turso] Local database has more orders (${localOrders}) than cloud (${remoteOrders}). Preserving local data and syncing to cloud.`
                : `[Turso] No live row in cloud. Seeding it from the local database (${localTotal} records).`);
            schedulePush(localDb, DB_PATH);
        } else if (!remoteData && TURSO_MIN_RECORDS === 0 && (!STRICT_REMOTE.on || localTotal === 0)) {
            persistState.source = 'stub';
            console.warn('[Turso] No live row in cloud and no local data; starting EMPTY because TURSO_MIN_RECORDS=0.');
        } else {
            h.ok = false;
            h.error = remoteData
                ? `local and Turso data below TURSO_MIN_RECORDS=${TURSO_MIN_RECORDS}`
                : (STRICT_REMOTE.on && localTotal > 0
                    ? `strict mode: no live row in Turso; the local copy (${localTotal} records) is not used as the source (restore a backup: it is pushed to Turso)`
                    : `no live row in Turso and no local data (fresh install: restore a backup, or set TURSO_MIN_RECORDS=0 to start empty)`);
            persistState.source = localSource;
            if (STRICT_REMOTE.on) persistState.remoteLoaded = false;
            enterReadOnly(h.error);
            return;
        }
        persistState.hydrated = true;
        persistState.remoteLoaded = true;
        h.ok = true; h.error = null;
        leaveReadOnly();
        try { await syncSandboxesWithTurso(client); } catch (e) { console.error('[Turso] Sandbox sync failed:', e.message); }
    } catch (e) {
        h.ok = false; h.error = `Turso hydrate failed: ${e.message}`;
        persistState.source = localSource;
        enterReadOnly(h.error);
    }
};
const pullFromTursoOnStartup = () => hydrateLiveFromTurso('boot');

setInterval(() => {
    if (!persistState.readOnly || hydrateRetryRunning) return;
    hydrateRetryRunning = true;
    hydrateLiveFromTurso('retry')
        .then(() => { if (!persistState.readOnly) runStartupRepairs(); })
        .catch(() => {})
        .finally(() => { hydrateRetryRunning = false; });
}, Math.max(5, TURSO_HYDRATE_RETRY_SEC) * 1000).unref();

const scrubText = (t) => (t == null ? t : String(t).replace(/(libsql|https?|wss?):\/\/\S+/gi, '[url]'));
const persistenceHealth = () => {
    let counts = persistState.localCounts;
    let dbSchemaVersion = null;
    let liveDbForHealth = null;
    try {
        const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        liveDbForHealth = db;
        counts = countRecords(db);
        dbSchemaVersion = db.settings?.[0]?.dbSchemaVersion ?? null;
    } catch {}
    const dropbox = dropboxHealth(liveDbForHealth);
    const strictDegraded = STRICT_REMOTE.on && (!dropbox.configured || dropbox.reachable === false || !persistState.remoteLoaded);
    return {
        status: persistState.readOnly ? 'read-only' : ((persistState.lastPush.ok === false || strictDegraded) ? 'degraded' : 'ok'),
        strict: { on: STRICT_REMOTE.on, by: STRICT_REMOTE.by, remoteLoaded: STRICT_REMOTE.on ? persistState.remoteLoaded : null, pendingPush: persistState.pendingPush },
        appVersion: SERVER_APP_VERSION,
        dbSchemaVersion,
        currentSchemaVersion: CURRENT_SCHEMA_VERSION,
        dataSource: persistState.source,
        counts,
        readOnly: persistState.readOnly,
        readOnlyReason: scrubText(persistState.readOnlyReason) || null,
        readOnlySince: persistState.readOnlySince,
        turso: {
            enabled: persistState.turso.enabled,
            enabledBy: persistState.turso.by,
            configured: persistState.turso.configured,
            remoteRevision: persistState.remoteRevision,
            snapshotsKept: TURSO_SNAPSHOT_KEEP,
            hydrate: { ...persistState.hydrate, error: scrubText(persistState.hydrate.error) },
            lastPush: { ...persistState.lastPush, error: scrubText(persistState.lastPush.error) },
            pendingForcePush: persistState.pendingForcePush,
        },
        guard: {
            minRecords: TURSO_MIN_RECORDS, shrinkMaxPct: TURSO_SHRINK_MAX_PCT, shrinkMinDrop: TURSO_SHRINK_MIN_DROP,
            refusedWrites: persistState.refusedWrites, lastRefusal: persistState.lastRefusal,
        },
        dropbox: { ...dropbox, lastCheck: { ...dropbox.lastCheck, error: scrubText(dropbox.lastCheck.error) }, lastUpload: { ...dropbox.lastUpload, error: scrubText(dropbox.lastUpload.error) } },
        storage: { dbPathFromEnv: !!process.env.DB_PATH, uploadsPathFromEnv: !!process.env.UPLOADS_PATH },
        uptimeSec: Math.round(process.uptime()),
    };
};

// opts.force: restore / wipe routes; skips the shrink guard and the read-only refusal.
const writeDb = (data, customPath = null, opts = {}) => {
  const targetPath = customPath || DB_PATH;
  const isLive = targetPath === DB_PATH;
  if (isLive && !opts.force) {
    if (persistState.readOnly) {
      console.error(`[Persistence] Live write refused: read-only (${persistState.readOnlyReason}).`);
      return false;
    }
    if (persistState.turso.enabled) {
      const shrink = findShrink(persistState.lastRemoteCounts, countRecords(data));
      if (shrink) {
        recordRefusal('Live write', shrink);
        return false;
      }
    }
  }
  const bakPath = targetPath + '.local.bak';
  const content = JSON.stringify(data, null, 2);
  try {
    const tmpPath = targetPath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf8');
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch (renameErr) {
      // Fallback for Windows / OneDrive filesystem locks
      fs.writeFileSync(targetPath, content, 'utf8');
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    if (isLive) persistState.localCounts = countRecords(data);

    // Trigger background sync to cloud (serialized per target; restore routes await it via awaitPush)
    schedulePush(data, targetPath, opts).catch(() => {});

    try { fs.copyFileSync(targetPath, bakPath); } catch {}
    return true;
  } catch (err) {
    try {
      fs.writeFileSync(targetPath, content, 'utf8');
      try { fs.copyFileSync(targetPath, bakPath); } catch {}
      return true;
    } catch (fallbackErr) {
      console.error(`[DB] Write error on ${targetPath}:`, fallbackErr);
      return false;
    }
  }
};

const getDb = (req) => readDb(getDbPath(req));
// --- HELPERS ---
// NOTE: hashPassword uses SHA-256, which is acceptable for this app's
// pre-existing password storage but is NOT a slow KDF. Migrating to
// bcrypt/scrypt/argon2 is a separate project (would invalidate all existing
// user passwords on next login). New API keys use scrypt (below) since the
// key shape and migration scope is contained to this feature.
const hashPassword = (pass) => crypto.createHash('sha256').update(pass).digest('hex');

// --- API KEY HELPERS (machine / ERP Test Tool authentication) ---
// API keys are stored hashed (scrypt, never in plaintext) in the LIVE database
// `apiKeys` collection. A key is bound to an owner user, and the ERP Test Tool
// presents it to /api/v1/login (or the x-api-key header) instead of a password.
//
// Security choices:
//   - 256 bits of OS-CSPRNG entropy (`crypto.randomBytes(32)`) — brute-force infeasible.
//   - Per-key random salt; stored as `scrypt$<saltHex>$<hashHex>` so we can rotate
//     cost parameters without breaking older keys.
//   - scrypt with N=2^15, r=8, p=1 — same default Node.js parameters.
//   - Constant-time compare via `crypto.timingSafeEqual` to avoid timing leaks.
//
// Migration note: any pre-existing SHA-256 hex hash (no `scrypt$` prefix) is
// still verifiable via the legacy path so a stale key created before this
// hardening keeps working until the admin revokes it.
const API_KEY_PREFIX = 'nex_';
const API_KEY_SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const API_KEY_SCRYPT_KEYLEN = 64;
const SCRYPT_HASH_RE = /^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/;
const makeApiKeyId = () => `apikey_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
const generateApiKey = () => `${API_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
const hashApiKey = (key) => {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(key || ''), salt, API_KEY_SCRYPT_KEYLEN, API_KEY_SCRYPT_OPTS);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
};
const verifyApiKey = (key, stored) => {
    if (!key || !stored || typeof stored !== 'string') return false;
    const m = SCRYPT_HASH_RE.exec(stored);
    if (m) {
        const salt = Buffer.from(m[1], 'hex');
        const expected = Buffer.from(m[2], 'hex');
        const actual = crypto.scryptSync(String(key), salt, expected.length, API_KEY_SCRYPT_OPTS);
        // timingSafeEqual requires equal-length buffers; lengths are guaranteed
        // by using `expected.length` as the scrypt output size above.
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    // Legacy plain-SHA-256-hex hashes (pre-hardening). Constant-time compared
    // against a fresh SHA-256 of the supplied secret.
    const legacy = crypto.createHash('sha256').update(String(key)).digest('hex');
    if (legacy.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(legacy, 'utf8'), Buffer.from(stored, 'utf8'));
};

// In-memory cache of the live `apiKeys` array. The auth middleware resolves
// keys on every request; reading the entire db.json for each one was a
// (a) DoS surface and (b) performance wall. Cache TTL is short (5 s) so
// admin revoke / disable actions propagate quickly. The cache is also
// invalidated synchronously by every CRUD endpoint below.
const apiKeyCache = { lastLoaded: 0, list: [], ttlMs: 5_000 };
// R14: fixed keys from NEXUS_API_KEYS (JSON) or NEXUS_API_KEYS_FILE (JSON file, default /secrets/nexus_api_keys.json
// or /run/secrets/nexus_api_keys). Entry: {name, username, key, allowLive?, roles?}. Read-only, never stored in a db.
const envKeyCache = { sig: '', list: [] };
const loadEnvApiKeys = () => {
    let raw = process.env.NEXUS_API_KEYS || '';
    if (!raw) raw = readSecretFile('NEXUS_API_KEYS_FILE', ['/secrets/nexus_api_keys.json', '/run/secrets/nexus_api_keys']);
    if (!raw) return [];
    if (raw === envKeyCache.sig) return envKeyCache.list;
    let list = [];
    try {
        const arr = JSON.parse(raw);
        list = (Array.isArray(arr) ? arr : []).filter(e => e && e.key && e.username).map((e, i) => ({
            id: `env_key_${i}`, name: e.name || `env-key-${i}`, username: String(e.username), roles: Array.isArray(e.roles) ? e.roles : [],
            allowLive: e.allowLive === true, keyHash: hashApiKey(String(e.key)), prefix: String(e.key).slice(0, 6) + '...',
            createdAt: null, createdBy: 'environment', lastUsedAt: null, enabled: true, fromEnvironment: true
        }));
    } catch (e) { console.error('[API Keys] NEXUS_API_KEYS / file is not valid JSON; ignored.'); }
    envKeyCache.sig = raw; envKeyCache.list = list;
    return list;
};
const loadApiKeyCache = () => {
    try {
        const liveDb = readDb(DB_PATH);
        apiKeyCache.list = [...(Array.isArray(liveDb.apiKeys) ? liveDb.apiKeys : []), ...loadEnvApiKeys()];
    } catch (e) {
        // Don't crash the request path on a transient read failure — return
        // an empty cache and let the next refresh retry.
        apiKeyCache.list = [];
    }
    apiKeyCache.lastLoaded = Date.now();
};
const getApiKeyRecords = () => {
    if (Date.now() - apiKeyCache.lastLoaded > apiKeyCache.ttlMs) {
        loadApiKeyCache();
    }
    return apiKeyCache.list;
};
const invalidateApiKeyCache = () => { apiKeyCache.lastLoaded = 0; };

// Resolve a live API-key secret to its stored record (null when unknown/disabled).
// `touch` persists lastUsedAt (login path); the middleware hot-path skips it to
// avoid rewriting the (large) live DB on every request.
const findApiKeyBySecret = (secret, { touch = false } = {}) => {
  if (!secret || typeof secret !== 'string') return null;
  const trimmed = secret.trim();
  const records = getApiKeyRecords();
  // O(N) iterate; N is tiny (admin-curated) so this is fine. Constant-time
  // verification via verifyApiKey() prevents timing leaks.
  let found = null;
  for (const rec of records) {
      if (rec.enabled === false) continue;
      if (verifyApiKey(trimmed, rec.keyHash)) { found = rec; break; }
  }
  if (!found) return null;
  if (touch) {
    // lastUsedAt update is throttled to once per hour per key, and is persisted
    // through the cache-bypassing read+write path (we only mutate the DB when
    // we actually need to flush).
    const last = found.lastUsedAt ? Date.parse(found.lastUsedAt) : NaN;
    if (!Number.isFinite(last) || (Date.now() - last) > 60 * 60 * 1000) {
      try {
        const liveDb = readDb(DB_PATH);
        const list = liveDb.apiKeys || [];
        const idx = list.findIndex(k => k.id === found.id);
        if (idx !== -1) {
            list[idx].lastUsedAt = new Date().toISOString();
            liveDb.apiKeys = list;
            if (writeDb(liveDb, DB_PATH)) {
                found.lastUsedAt = list[idx].lastUsedAt;
            }
        }
      } catch (e) { /* swallow — touch is best-effort */ }
    }
  }
  return found;
};

// Admin gate for API-key management routes. The live DB is the authority even
// when the caller is currently resolving through a sandbox.
//
// IMPORTANT: the multi-tenant middleware does NOT populate `req.roles` in live
// mode (no `x-sandbox-owner`) — by design, to keep live mode a zero-disk-IO
// pass-through. Any new admin-gated endpoint added to server.js MUST use this
// helper (or its own live-DB lookup) instead of `req.roles.includes('admin')`,
// which would silently deny every live caller.
const isAdminUser = (req) => {
  if ((req.roles || []).includes('admin')) return true;
  const liveDb = readDb(DB_PATH);
  const username = String(req.headers['x-user'] || req.user || '').trim();
  if (!username) return false;
  const user = (liveDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
  return !!user && (user.roles || []).includes('admin');
};


// CX09: narrow role gate for dispatch actions. Enforced only when the caller's roles are known
// (sandbox / API key); admin and management are always allowed.
// v1.0001227: ORDER_CANCEL_ROLES (the roles that may cancel an order) and ROLLBACK_TO_LOGGED_DENIED come from shared/orderPermissions.js (client + server).
const ACTION_ROLE_GATES = {
  'toggle-acceptance': { roles: ['planning'], msg: 'technical review is for tech1/planner1' },
  'finalize-study': { roles: ['planning'], msg: 'technical review is for tech1/planner1' },
  'send-rfp-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'award-tender-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'issue-po-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  // v1.0001217: supplier PO cancel / amend / revert were ungated (crm1 could cancel a PO). Procurement owns them; the order-cancel roles
  // (order management, planning, sales, finance = the reject-order gate below) keep Cancel PO because the rollback / cancel screens
  // (Technical Review, Procurement) resolve open POs with it. Revert to Award is a procurement decision only.
  'cancel-component-po': { roles: ['procurement', 'sourcing', 'order_management', 'planning', 'sales', 'finance'], msg: 'no permission to cancel a supplier PO' },
  'cancel-po-batch': { roles: ['procurement', 'sourcing', 'order_management', 'planning', 'sales', 'finance'], msg: 'no permission to cancel a supplier PO' },
  'amend-po-extension': { roles: ['procurement', 'sourcing', 'order_management', 'planning', 'sales', 'finance'], msg: 'no permission to cancel a supplier PO' },
  'revert-po': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'receive-component': { roles: ['inventory', 'warehouse', 'sourcing', 'logistics'], msg: 'reception is for inv1' },
  'receive-hub-partial': { roles: ['inventory', 'warehouse', 'sourcing', 'logistics'], msg: 'reception is for inv1' },
  'issue-invoice': { roles: ['finance'], msg: 'invoicing is finance' },
  'record-payment': { roles: ['finance'], msg: 'wrong role: payments are finance' },
  // R34 round 7 (validator 6, defect 10): voiding a payment is a payment write too (same gate as record-payment).
  'cancel-payment': { roles: ['finance'], msg: 'wrong role: cancelling a payment is finance' },
  'approve-dispatch-receipt': { roles: ['finance'], msg: 'wrong role: dispatch receipt approval is finance' },
  'reject-order': { roles: ORDER_CANCEL_ROLES, msg: 'no permission to cancel / delete' },
  // v1.0001227 (supervisor ruling 2026-11-11): rolling an order back to LOGGED (Rollback to Logged / reopen of a cancelled order) is allowed only
  // for the roles that may cancel the order (the reject-order gate: ORDER_CANCEL_ROLES, plus admin and management); the generic order edit that
  // sets the status LOGGED uses the same gate. The UI hides the rollback buttons for the other roles (shared/orderPermissions.js).
  'rollback-to-logged': { roles: ORDER_CANCEL_ROLES, msg: ROLLBACK_TO_LOGGED_DENIED },
  'hard-delete-order': { roles: [], msg: 'Unauthorized: Only superusers or management can hard delete an order', raw: true },
};
const actionRoleDenied = (req, action) => {
  const gate = ACTION_ROLE_GATES[action];
  const roles = req.roles || [];
  if (!gate || roles.length === 0) return null;
  if (roles.includes('admin') || roles.includes('management')) return null;
  if (roles.some(r => gate.roles.includes(r))) return null;
  return gate.raw ? gate.msg : 'refused: ' + gate.msg;
};

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
    ['emailConfig', 'password'],
    ['googleDriveConfig', 'clientSecret'],
    ['googleDriveConfig', 'refreshToken'],
    ['localStorageConfig', 'secretKey'],
    ['dropboxConfig', 'appSecret'],
    ['dropboxConfig', 'refreshToken']
];

const transformSensitiveFields = (settings, fn) => {
    if (!settings) return settings;
    const copy = JSON.parse(JSON.stringify(settings));
    SENSITIVE_PATHS.forEach(([parent, key]) => {
        if (copy[parent] && copy[parent][key]) {
            copy[parent][key] = fn(copy[parent][key]);
        }
    });
    if (copy.tursoAuthToken) {
        copy.tursoAuthToken = fn(copy.tursoAuthToken);
    }
    return copy;
};

const encryptSettings = (settings) => transformSensitiveFields(settings, encryptValue);
const decryptSettings = (settings) => transformSensitiveFields(settings, decryptValue);

const getLiveAiSettings = () => {
    try {
        const liveDb = readDb(DB_PATH);
        const liveSettings = (liveDb.settings && Array.isArray(liveDb.settings) && liveDb.settings.length > 0)
            ? liveDb.settings[0]
            : (liveDb.settings || {});
        return {
            aiProvider: liveSettings.aiProvider || 'gemini',
            geminiConfig: liveSettings.geminiConfig || { apiKey: '', modelName: 'gemini-3.5-flash' },
            openaiConfig: liveSettings.openaiConfig || { apiKey: '', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4o' }
        };
    } catch (e) {
        return {
            aiProvider: 'gemini',
            geminiConfig: { apiKey: '', modelName: 'gemini-3.5-flash' },
            openaiConfig: { apiKey: '', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4o' }
        };
    }
};

const DEFAULT_DROPBOX_CONFIG = {
    enabled: true,
    autoUploadExternalSubmissions: true,
    appKey: process.env.DROPBOX_APP_KEY || '',
    appSecret: process.env.DROPBOX_APP_SECRET || '',
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '',
    folderPath: process.env.DROPBOX_FOLDER_PATH || '/NexusERP_Uploads',
    connectedAccount: 'Moataz Allam',
    connectedAt: '2026-10-18T10:00:00.000Z'
};

const resolveSettings = (db, isSandboxReq = false) => {
    const rawDbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0)
        ? db.settings[0]
        : (db.settings || {});
    const dbSettings = decryptSettings(rawDbSettings);

    const rawDropbox = dbSettings.dropboxConfig || {};
    const hasCustomCredentials = !!(rawDropbox.refreshToken && String(rawDropbox.refreshToken).trim());
    const effectiveDropbox = {
        enabled: (rawDropbox.enabled !== undefined && hasCustomCredentials) ? !!rawDropbox.enabled : false,
        autoUploadExternalSubmissions: rawDropbox.autoUploadExternalSubmissions !== undefined ? !!rawDropbox.autoUploadExternalSubmissions : false,
        appKey: (rawDropbox.appKey && String(rawDropbox.appKey).trim()) || DEFAULT_DROPBOX_CONFIG.appKey,
        appSecret: (rawDropbox.appSecret && String(rawDropbox.appSecret).trim()) || DEFAULT_DROPBOX_CONFIG.appSecret,
        refreshToken: (rawDropbox.refreshToken && String(rawDropbox.refreshToken).trim()) || DEFAULT_DROPBOX_CONFIG.refreshToken,
        folderPath: (rawDropbox.folderPath && String(rawDropbox.folderPath).trim()) || DEFAULT_DROPBOX_CONFIG.folderPath,
        connectedAccount: (rawDropbox.connectedAccount && String(rawDropbox.connectedAccount).trim()) || DEFAULT_DROPBOX_CONFIG.connectedAccount,
        connectedAt: rawDropbox.connectedAt || DEFAULT_DROPBOX_CONFIG.connectedAt
    };

    const merged = {
        loggingDelayThresholdDays: 1,
        enableNewOrderAlerts: true,
        newOrderAlertGroupIds: [],
        enableRollbackAlerts: true,
        rollbackAlertGroupIds: [],
        thresholdNotifications: {},
        storageBackend: (dbSettings.storageBackend === 'dropbox' || dbSettings.storageBackend === 'local-storage')
            ? dbSettings.storageBackend
            : (dbSettings.googleDriveConfig?.refreshToken ? 'google-drive' : 'local-storage'),
        googleDriveConfig: {
            enabled: true,
            autoUploadExternalSubmissions: true,
            clientId: '',
            clientSecret: '',
            redirectUri: '',
            folderName: '',
            folderId: ''
        },
        localStorageConfig: {
            ...DEFAULT_LOCAL_STORAGE_CONFIG
        },
        emailConfig: {
            smtpServer: 'mail.quickstor.net',
            smtpPort: 465,
            username: 'erpalerts@quickstor.net',
            password: 'YousefNadody123!',
            senderName: 'Nexus System Alert',
            senderEmail: 'erpalerts@quickstor.net',
            useSsl: true
        },
        availableRoles: ['admin', 'management', 'order_management', 'factory', 'procurement', 'finance', 'crm', 'inventory', 'Gov.EInvoice', 'planning', 'suppliers', 'shipment'],
        roleMappings: {
            dashboard: ['management'],
            orders: ['order_management'],
            technicalReview: ['planning'],
            finance: ['finance'],
            procurement: ['procurement'],
            factory: ['factory'],
            inventory: ['inventory'],
            shipment: ['shipment'],
            crm: ['crm'],
            suppliers: ['procurement', 'suppliers'],
            reporting: ['management'],
            govEInvoice: ['Gov.EInvoice']
        },
        ...dbSettings,
        storageBackend: (dbSettings.storageBackend === 'dropbox' || dbSettings.storageBackend === 'local-storage')
            ? dbSettings.storageBackend
            : (dbSettings.googleDriveConfig?.refreshToken ? 'google-drive' : 'local-storage'),
        dropboxConfig: effectiveDropbox,
        useTurso: (dbSettings.useTurso !== undefined && dbSettings.tursoUrl) ? !!dbSettings.useTurso : false,
        tursoUrl: (dbSettings.tursoUrl && String(dbSettings.tursoUrl).trim()) || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL,
        tursoAuthToken: (dbSettings.tursoAuthToken && String(dbSettings.tursoAuthToken).trim()) || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken()
    };

    if (isSandboxReq) {
        const liveAi = getLiveAiSettings();
        merged.aiProvider = liveAi.aiProvider;
        merged.geminiConfig = liveAi.geminiConfig;
        merged.openaiConfig = liveAi.openaiConfig;
    }

    return merged;
};

const getGoogleOAuthConfig = (settings) => {
    const cfg = settings?.googleDriveConfig || {};
    const clientId = String(cfg.clientId || '').trim();
    const clientSecret = String(cfg.clientSecret || '').trim();
    return {
        clientId,
        clientSecret,
        configured: !!clientId && !!clientSecret
    };
};

const getLocalStorageConfig = (settings) => {
    const cfg = {
        ...DEFAULT_LOCAL_STORAGE_CONFIG,
        ...(settings?.localStorageConfig || {})
    };
    const storageIp = String(cfg.storageIp || '').trim();
    const accessKey = String(cfg.accessKey || '').trim();
    const secretKey = String(cfg.secretKey || '').trim();
    const bucketName = String(cfg.bucketName || '').trim();
    return {
        ...cfg,
        storageIp,
        accessKey,
        secretKey,
        bucketName,
        apiPort: Number(cfg.apiPort) || 9000,
        consolePort: Number(cfg.consolePort) || 9001,
        configured: !!storageIp && !!accessKey && !!secretKey
    };
};

const getLocalStorageClient = (settings) => {
    const cfg = getLocalStorageConfig(settings);
    if (!cfg.configured) {
        throw new Error('Local storage settings are incomplete. Fill in storage IP, username and password.');
    }
    const endpoint = `http://${cfg.storageIp}:${cfg.apiPort}`;
    return {
        cfg,
        client: new S3Client({
            region: 'us-east-1',
            endpoint,
            forcePathStyle: true,
            credentials: {
                accessKeyId: cfg.accessKey,
                secretAccessKey: cfg.secretKey
            }
        })
    };
};

const listLocalStorageBuckets = async (settings) => {
    const { client } = getLocalStorageClient(settings);
    const response = await client.send(new ListBucketsCommand({}));
    return Array.isArray(response.Buckets)
        ? response.Buckets.map(bucket => bucket.Name).filter(Boolean)
        : [];
};

const createLocalStorageBucket = async (settings, bucketName) => {
    const { client } = getLocalStorageClient(settings);
    const safeName = String(bucketName || '').trim();
    if (!safeName) {
        throw new Error('Bucket name is required.');
    }
    await client.send(new CreateBucketCommand({ Bucket: safeName }));
    return safeName;
};

const uploadBufferToLocalStorage = async ({ buffer, mimeType, fileName, bucketName, settings }) => {
    const { client, cfg } = getLocalStorageClient(settings);
    const targetBucket = String(bucketName || cfg.bucketName || '').trim();
    if (!targetBucket) {
        throw new Error('Select or create a bucket before uploading to local storage.');
    }
    const objectKey = sanitizeDriveFileName(fileName);
    await client.send(new PutObjectCommand({
        Bucket: targetBucket,
        Key: objectKey,
        Body: buffer,
        ContentType: mimeType || 'application/octet-stream'
    }));

    const baseUrl = `http://${cfg.storageIp}:${cfg.apiPort}`;
    return {
        id: `${targetBucket}/${objectKey}`,
        name: objectKey,
        webViewLink: `${baseUrl}/${targetBucket}/${encodeURIComponent(objectKey)}`,
        webContentLink: `${baseUrl}/${targetBucket}/${encodeURIComponent(objectKey)}`
    };
};

const getDropboxConfig = (settings) => {
    const raw = settings?.dropboxConfig || {};
    const appKey = String((raw.appKey && String(raw.appKey).trim()) || DEFAULT_DROPBOX_CONFIG.appKey || process.env.DROPBOX_APP_KEY || '').trim();
    const appSecret = String((raw.appSecret && String(raw.appSecret).trim()) || DEFAULT_DROPBOX_CONFIG.appSecret || process.env.DROPBOX_APP_SECRET || '').trim();
    const refreshToken = String((raw.refreshToken && String(raw.refreshToken).trim()) || DEFAULT_DROPBOX_CONFIG.refreshToken || process.env.DROPBOX_REFRESH_TOKEN || '').trim();
    const folderPath = String((raw.folderPath && String(raw.folderPath).trim()) || DEFAULT_DROPBOX_CONFIG.folderPath || process.env.DROPBOX_FOLDER_PATH || '/NexusERP_Uploads').trim().replace(/\/$/, '') || '/NexusERP_Uploads';
    let enabled = (raw.enabled !== undefined && (raw.refreshToken && String(raw.refreshToken).trim())) ? !!raw.enabled : true;
    if (STRICT_REMOTE.on) {
        // Strict: Dropbox is the file store and always on; missing creds fall back to the INITIAL_CONFIG defaults.
        const d = INITIAL_REMOTE_DEFAULTS.dropbox;
        const sk = appKey || d.appKey, ss = appSecret || d.appSecret, sr = refreshToken || d.refreshToken;
        const sf = (String(raw.folderPath || '').trim() || DEFAULT_DROPBOX_CONFIG.folderPath || d.folderPath || '/NexusERP_Uploads').replace(/\/$/, '') || '/NexusERP_Uploads';
        return {
            enabled: true, strict: true,
            autoUploadExternalSubmissions: raw.autoUploadExternalSubmissions !== undefined ? !!raw.autoUploadExternalSubmissions : true,
            appKey: sk, appSecret: ss, refreshToken: sr, folderPath: sf,
            connectedAccount: String(raw.connectedAccount || '').trim(), connectedAt: String(raw.connectedAt || '').trim(),
            configured: !!sk && !!ss && !!sr
        };
    }
    const connectedAccount = String((raw.connectedAccount && String(raw.connectedAccount).trim()) || (refreshToken === DEFAULT_DROPBOX_CONFIG.refreshToken ? DEFAULT_DROPBOX_CONFIG.connectedAccount : '')).trim();
    const connectedAt = String(raw.connectedAt || (refreshToken === DEFAULT_DROPBOX_CONFIG.refreshToken ? DEFAULT_DROPBOX_CONFIG.connectedAt : '')).trim();

    return {
        enabled,
        autoUploadExternalSubmissions: raw.autoUploadExternalSubmissions !== undefined ? !!raw.autoUploadExternalSubmissions : true,
        appKey,
        appSecret,
        refreshToken,
        folderPath,
        connectedAccount,
        connectedAt,
        configured: !!appKey && !!appSecret && !!refreshToken
    };
};

const isDropboxConfigured = (settings) => {
    const cfg = getDropboxConfig(settings);
    return !!cfg.enabled && !!cfg.configured;
};

const getDropboxClient = (settings) => {
    const cfg = getDropboxConfig(settings);
    if (!cfg.configured) {
        throw new Error('Dropbox credentials (appKey, appSecret, refreshToken) are not fully configured.');
    }
    return new Dropbox({
        clientId: cfg.appKey,
        clientSecret: cfg.appSecret,
        refreshToken: cfg.refreshToken,
        fetch: timeoutFetch
    });
};

const testDropboxConnection = async (appKey, appSecret, refreshToken) => {
    const dbx = new Dropbox({ clientId: appKey, clientSecret: appSecret, refreshToken, fetch: timeoutFetch });
    const check = await dbx.usersGetCurrentAccount();
    return check.result;
};

const uploadFileToDropbox = async ({ settings, buffer, relativePath, mimeType }) => {
    const cfg = getDropboxConfig(settings);
    const folder = cfg.folderPath;
    const normRel = relativePath.replace(/\\/g, '/').replace(/^\/?uploads\//, '');
    const targetPath = `${folder}/${normRel}`;

    const dbx = getDropboxClient(settings);
    const response = await dbx.filesUpload({
        path: targetPath,
        contents: buffer,
        mode: { '.tag': 'overwrite' }
    });
    return response.result;
};

const downloadFileStreamFromDropbox = async ({ settings, relativePath }) => {
    const cfg = getDropboxConfig(settings);
    const folder = cfg.folderPath;
    const normRel = relativePath.replace(/\\/g, '/').replace(/^\/?uploads\//, '');
    const targetPath = `${folder}/${normRel}`;

    const dbx = getDropboxClient(settings);
    await dbx.auth.refreshAccessToken();
    const accessToken = dbx.auth.getAccessToken();

    return new Promise((resolve) => {
        const req = https.request('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Dropbox-API-Arg': JSON.stringify({ path: targetPath })
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                return resolve(null);
            }
            resolve(res);
        });
        req.setTimeout(REMOTE_FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
        req.on('error', (err) => {
            console.error('[Dropbox] Download error:', err.message);
            resolve(null);
        });
        req.end();
    });
};

const exchangeDropboxCodeForRefreshToken = async ({ appKey, appSecret, code, redirectUri }) => {
    const dbx = new Dropbox({ clientId: appKey, clientSecret: appSecret });
    dbx.auth.setClientId(appKey);
    dbx.auth.setClientSecret(appSecret);
    const response = await dbx.auth.getAccessTokenFromCode(redirectUri, code);
    return response.result.refresh_token;
};

const syncUploadToDropbox = async (req, relativePath, buffer = null) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        if (isDropboxConfigured(settings)) {
            const absPath = path.isAbsolute(relativePath) ? relativePath : path.join(__dirname, relativePath);
            const fileBuf = buffer || (fs.existsSync(absPath) ? fs.readFileSync(absPath) : null);
            if (fileBuf) {
                await uploadFileToDropbox({ settings, buffer: fileBuf, relativePath });
                console.log(`[Dropbox] Automatically synced ${relativePath} to Dropbox (${getDropboxConfig(settings).folderPath})`);
            }
        }
    } catch (err) {
        console.warn('[Dropbox Sync Warning]', err.message);
    }
};

// ==================== STRICT DROPBOX (v1.0001201) ====================
// In strict mode an upload counts as stored only when Dropbox accepted it. Known Dropbox files (scan +
// confirmed uploads/downloads) may be served from the local cache; any other local file is "local-only".
const dropboxState = {
    reachable: null,
    lastCheck: { at: null, ok: null, error: null },
    lastUpload: { at: null, ok: null, error: null },
    uploadsOk: 0, uploadsFailed: 0, refused: 0,
    localOnlyFiles: null, localOnlyCheckedAt: null,
};
const dropboxKnown = new Set();  // relative paths under the Dropbox folder (lower case), e.g. 'pod/pod-1.pdf'
const dropboxRelKey = (relativePath) => String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^uploads\//, '').toLowerCase();
const dropboxErrText = (e) => scrubText(
    (e && (e.message || e?.error?.error_summary || (typeof e.error === 'string' ? e.error : ''))) || (e && e.status ? `Dropbox HTTP ${e.status}` : String(e))
);
const strictDropboxNotReadyMessage = (why) => `Not stored: strict mode keeps uploaded files only in Dropbox, and ${why}. Nothing was kept on the local disk. Check GET /api/health.`;
const DROPBOX_NOT_CONFIGURED = 'Dropbox is not configured (DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN)';

// Upload a stored local file to Dropbox and wait for the answer. Returns { ok, status, message }.
const storeUploadInDropbox = async (req, relativePath, buffer) => {
    let settings = null, cfg = null;
    try { settings = resolveSettings(getDb(req)); cfg = getDropboxConfig(settings); } catch {}
    if (!cfg || !cfg.enabled || !cfg.configured) {
        dropboxState.refused++;
        dropboxState.lastUpload = { at: new Date().toISOString(), ok: false, error: 'Dropbox is not configured' };
        return { ok: false, status: 503, message: strictDropboxNotReadyMessage(DROPBOX_NOT_CONFIGURED) };
    }
    try {
        await uploadFileToDropbox({ settings, buffer, relativePath });
        dropboxKnown.add(dropboxRelKey(relativePath));
        dropboxState.reachable = true;
        dropboxState.uploadsOk++;
        dropboxState.lastUpload = { at: new Date().toISOString(), ok: true, error: null };
        console.log(`[Dropbox] Stored ${relativePath} in Dropbox (strict).`);
        return { ok: true };
    } catch (e) {
        const err = dropboxErrText(e);
        dropboxState.reachable = false;
        dropboxState.uploadsFailed++;
        dropboxState.lastUpload = { at: new Date().toISOString(), ok: false, error: err };
        console.error(`[Dropbox] Strict upload of ${relativePath} FAILED: ${err}`);
        return { ok: false, status: 503, message: strictDropboxNotReadyMessage(`the Dropbox upload failed (${err})`) };
    }
};

// Refuse an upload before multer writes anything when strict and Dropbox is not configured.
const strictUploadGate = (req, res, next) => {
    if (!STRICT_REMOTE.on) return next();
    let cfg = null;
    try { cfg = getDropboxConfig(resolveSettings(getDb(req))); } catch {}
    if (cfg && cfg.enabled && cfg.configured) return next();
    dropboxState.refused++;
    return res.status(503).json({ success: false, error: 'DROPBOX_REQUIRED', message: strictDropboxNotReadyMessage(DROPBOX_NOT_CONFIGURED) });
};

// Answer an upload route: non-strict = old behaviour (local file + background Dropbox copy);
// strict = wait for Dropbox, else delete the local file and answer 503.
const finishUpload = async (req, res, absPath) => {
    const relativePath = storedUploadPath(absPath);
    if (!STRICT_REMOTE.on) {
        if (req.sandboxOwner) recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        syncUploadToDropbox(req, relativePath, fs.readFileSync(absPath)).catch(() => {});
        return res.json({ success: true, filePath: relativePath });
    }
    const r = await storeUploadInDropbox(req, relativePath, fs.readFileSync(absPath));
    if (!r.ok) {
        try { fs.unlinkSync(absPath); } catch {}
        return res.status(r.status || 503).json({ success: false, error: 'DROPBOX_UPLOAD_FAILED', message: r.message });
    }
    if (req.sandboxOwner) recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
    return res.json({ success: true, filePath: relativePath, storedIn: 'dropbox' });
};

// Strict: list the Dropbox folder (reachability + known files) and count local files that are not in Dropbox.
const listDropboxFolderRecursive = async (settings) => {
    const cfg = getDropboxConfig(settings);
    const dbx = getDropboxClient(settings);
    const prefix = cfg.folderPath.toLowerCase() + '/';
    const out = new Set();
    let resp;
    try {
        resp = await dbx.filesListFolder({ path: cfg.folderPath, recursive: true, limit: 2000 });
    } catch (e) {
        if (/not_found/.test(JSON.stringify(e?.error || '')) || /not_found/.test(String(e?.message || ''))) return out; // folder not created yet
        throw e;
    }
    for (;;) {
        for (const ent of resp.result.entries || []) {
            if (ent['.tag'] !== 'file' || !ent.path_lower) continue;
            if (ent.path_lower.startsWith(prefix)) out.add(ent.path_lower.slice(prefix.length));
        }
        if (!resp.result.has_more) break;
        resp = await dbx.filesListFolderContinue({ cursor: resp.result.cursor });
    }
    return out;
};
const listLocalUploadFiles = () => {
    const files = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) walk(full);
            else if (ent.isFile()) files.push(path.relative(UPLOADS_BASE, full).replace(/\\/g, '/').toLowerCase());
        }
    };
    walk(UPLOADS_BASE);
    return files;
};
let dropboxCheckRunning = false;
const checkDropboxRemote = async (why = 'timer') => {
    if (!STRICT_REMOTE.on || dropboxCheckRunning) return;
    dropboxCheckRunning = true;
    const at = new Date().toISOString();
    try {
        const settings = resolveSettings(readDb(DB_PATH));
        const cfg = getDropboxConfig(settings);
        if (!cfg.configured) {
            dropboxState.reachable = false;
            dropboxState.lastCheck = { at, ok: false, error: 'Dropbox is not configured' };
            return;
        }
        const remote = await listDropboxFolderRecursive(settings);
        dropboxKnown.clear();
        remote.forEach(k => dropboxKnown.add(k));
        const localOnly = listLocalUploadFiles().filter(f => !remote.has(f));
        dropboxState.reachable = true;
        dropboxState.lastCheck = { at, ok: true, error: null };
        dropboxState.localOnlyFiles = localOnly.length;
        dropboxState.localOnlyCheckedAt = at;
        if (localOnly.length) console.warn(`[Dropbox] ${localOnly.length} local upload file(s) are not in Dropbox (local-only, not served in strict mode; run Dropbox sync-all).`);
    } catch (e) {
        dropboxState.reachable = false;
        dropboxState.lastCheck = { at, ok: false, error: dropboxErrText(e) };
        console.error(`[Dropbox] Check (${why}) failed: ${dropboxState.lastCheck.error}`);
    } finally {
        dropboxCheckRunning = false;
    }
};
if (STRICT_REMOTE.on) {
    setInterval(() => { checkDropboxRemote('timer').catch(() => {}); }, Math.max(30, DROPBOX_CHECK_SEC) * 1000).unref();
}
const dropboxHealth = (db) => {
    let cfg = null;
    try { cfg = getDropboxConfig(resolveSettings(db || {})); } catch {}
    return {
        strict: STRICT_REMOTE.on,
        enabled: !!cfg?.enabled,
        configured: !!cfg?.configured,
        reachable: dropboxState.reachable,
        lastCheck: { ...dropboxState.lastCheck },
        lastUpload: { ...dropboxState.lastUpload },
        uploadsOk: dropboxState.uploadsOk, uploadsFailed: dropboxState.uploadsFailed, uploadsRefused: dropboxState.refused,
        localOnlyFiles: dropboxState.localOnlyFiles,
        localOnlyCheckedAt: dropboxState.localOnlyCheckedAt,
    };
};

const syncLocalDirectoryToDropbox = async (baseDir, req) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        if (!isDropboxConfigured(settings)) return { count: 0, errors: 0 };

        const prefix = (isSandbox(req) && baseDir !== UPLOADS_BASE && req?.sandboxOwner) 
            ? `sandbox/${sanitizeUsername(req.sandboxOwner)}/` 
            : '';

        const filesToSync = [];
        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile()) {
                    const relInsideUploads = prefix + path.relative(baseDir, fullPath).replace(/\\/g, '/');
                    filesToSync.push({ fullPath, relativePath: relInsideUploads });
                }
            }
        };
        walk(baseDir);

        let count = 0;
        let errors = 0;
        for (const file of filesToSync) {
            try {
                const buf = fs.readFileSync(file.fullPath);
                await uploadFileToDropbox({
                    settings,
                    buffer: buf,
                    relativePath: file.relativePath
                });
                dropboxKnown.add(dropboxRelKey(file.relativePath));
                count++;
            } catch (err) {
                console.warn(`[Dropbox Sync] Failed to sync ${file.relativePath}:`, err.message);
                errors++;
            }
        }
        console.log(`[Dropbox Sync] Completed syncing ${count} files to Dropbox (${errors} errors).`);
        return { count, errors };
    } catch (e) {
        console.error('[Dropbox Sync] Directory sync error:', e);
        return { count: 0, errors: 1 };
    }
};

const getBaseUrlFromRequest = (req) => {
    const appOrigin = String(req.headers['x-app-origin'] || '').trim();
    if (appOrigin) {
        return appOrigin;
    }
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = req.get('host');
    return `${proto}://${host}`;
};

const getGoogleCallbackUrl = (req, settings) => {
    const configuredRedirect = String(settings?.googleDriveConfig?.redirectUri || '').trim();
    if (configuredRedirect) return configuredRedirect;
    return `${getBaseUrlFromRequest(req)}/api/v1/integrations/google-drive/callback`;
};

const sanitizeDriveFileName = (name) => {
    const clean = String(name || 'submission.bin').replace(/[\\/:*?"<>|]+/g, '_').trim();
    return clean || 'submission.bin';
};

const fetchGoogleAccessToken = async (refreshToken, req, settings) => {
    const oauth = getGoogleOAuthConfig(settings);
    if (!oauth.configured) {
        throw new Error('Google OAuth settings are missing in Integrations tab.');
    }
    if (!refreshToken) {
        throw new Error('Google Drive is not connected. Missing refresh token.');
    }

    const tokenBody = new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        redirect_uri: getGoogleCallbackUrl(req, settings)
    });

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString()
    });

    if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        throw new Error(`Google token refresh failed: ${errText}`);
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
        throw new Error('Google token refresh did not return an access token.');
    }
    return tokenData.access_token;
};

const uploadBufferToGoogleDrive = async ({ req, buffer, mimeType, fileName, folderId, refreshToken, settings }) => {
    const accessToken = await fetchGoogleAccessToken(refreshToken, req, settings);
    const metadata = {
        name: sanitizeDriveFileName(fileName),
        ...(folderId ? { parents: [folderId] } : {})
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), sanitizeDriveFileName(fileName));

    const uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        body: form
    });

    if (!uploadResponse.ok) {
        const errText = await uploadResponse.text();
        throw new Error(`Google Drive upload failed: ${errText}`);
    }

    return uploadResponse.json();
};

const escapeDriveQueryValue = (value) => String(value || '').replace(/'/g, "\\'");

const resolveOrCreateDriveFolder = async ({ req, refreshToken, folderName, fallbackFolderId, settings }) => {
    const trimmedName = String(folderName || '').trim();
    if (!trimmedName) {
        return fallbackFolderId || '';
    }

    const accessToken = await fetchGoogleAccessToken(refreshToken, req, settings);
    const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${escapeDriveQueryValue(trimmedName)}'`;
    const listParams = new URLSearchParams({
        q,
        spaces: 'drive',
        fields: 'files(id,name)',
        pageSize: '1'
    });

    const listResponse = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams.toString()}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!listResponse.ok) {
        const errText = await listResponse.text();
        throw new Error(`Google Drive folder lookup failed: ${errText}`);
    }

    const listData = await listResponse.json();
    const existing = Array.isArray(listData.files) ? listData.files[0] : null;
    if (existing?.id) {
        return existing.id;
    }

    const createResponse = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            name: trimmedName,
            mimeType: 'application/vnd.google-apps.folder'
        })
    });

    if (!createResponse.ok) {
        const errText = await createResponse.text();
        throw new Error(`Google Drive folder creation failed: ${errText}`);
    }

    const created = await createResponse.json();
    if (!created?.id) {
        throw new Error('Google Drive folder creation returned no folder ID.');
    }

    return created.id;
};

// --- SCHEMA MIGRATIONS ---
// Each migration function upgrades settings from version N to N+1.
// They must be idempotent (running twice produces the same result).

const migrations = [
    // v0 → v1: Ensure shipment, suppliers & planning roles exist and are unlinked
    (settings) => {
        const roles = new Set(settings.availableRoles || []);
        if (!roles.has('shipment')) roles.add('shipment');
        if (!roles.has('suppliers')) roles.add('suppliers');
        if (!roles.has('planning')) roles.add('planning');
        settings.availableRoles = Array.from(roles);

        const mappings = settings.roleMappings || {};

        // Explicitly correct mappings that changed across releases
        settings.roleMappings = {
            ...mappings,
            shipment: ['shipment'],
            suppliers: ['procurement', 'suppliers'],
            technicalReview: ['planning'],
        };

        // Scrub 'shipment' from any mapping other than 'shipment' itself
        // (prevents old backups where shipment was bundled into order_management)
        Object.keys(settings.roleMappings).forEach((key) => {
            if (key !== 'shipment') {
                settings.roleMappings[key] = settings.roleMappings[key].filter(
                    (r) => r !== 'shipment'
                );
            }
        });

        return settings;
    },
    // v1 → v2: Initialize helpLinks array if it doesn't exist
    (settings) => {
        if (!settings.helpLinks) {
            settings.helpLinks = [];
        }
        return settings;
    },
    // v2 → v3: Multi-currency support — backfill currency + conversionRate on existing orders
    (settings) => {
        // Multi-currency amendment: every existing order is implicitly denominated
        // in 'L.E.' (the pre-feature default) with conversionRate = 1 (no
        // conversion between revenue and cost side). We backfill these fields on
        // the live db.orders array here so the migration is idempotent and runs
        // a single time on the next server boot.
        return settings;
    },
    // v3 → v4: Initialize contracts array if missing
    (settings) => {
        return settings;
    },
    // v4 → v5: Initialize apiKeys array if missing (PR #26: API Key support)
    (settings) => {
        return settings;
    },
    // v5 → v6: Outsourcing No RFP by default & Running Contract status
    (settings) => {
        return settings;
    },
    // v6 → v7: Per-user Live Access toggle.
    (settings) => {
        return settings;
    },
    // v7 → v8: Extract base64 cost sheets from DB to physical files
    (settings) => {
        return settings;
    },
    // v8 → v9: Sourcing role and roleMappings
    (settings) => {
        if (!settings.availableRoles) settings.availableRoles = [];
        if (!settings.availableRoles.includes('sourcing')) {
            settings.availableRoles.push('sourcing');
        }
        if (!settings.roleMappings) settings.roleMappings = {};
        if (!settings.roleMappings['sourcing']) {
            settings.roleMappings['sourcing'] = ['sourcing', 'admin', 'management'];
        }
        return settings;
    },
    // v9 → v10: Purge embedded base64 cost sheets from orders & costSheets array to physical files
    (settings) => {
        return settings;
    },
    // v10 → v11: Initialize dropboxConfig if missing
    (settings) => {
        if (!settings.dropboxConfig || !settings.dropboxConfig.refreshToken) {
            settings.dropboxConfig = {
                ...DEFAULT_DROPBOX_CONFIG
            };
        }
        if (!settings.storageBackend) {
            settings.storageBackend = 'dropbox';
        }
        return settings;
    }
];

const applySchemaMigrations = (db, targetPath = DB_PATH) => {
    if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) return;
    let settings = db.settings[0];
    let version = settings.dbSchemaVersion || 0;

    if (version > CURRENT_SCHEMA_VERSION && !FORCE_SCHEMA_MIGRATION) {
        const msg = `[FATAL] db.json schema version (${version}) is newer than code schema version (${CURRENT_SCHEMA_VERSION}). \n` +
                    `       It looks like you restored a backup created with a newer release of this app. \n` +
                    `       To proceed, update the application code to the matching version, or set \n` +
                    `       FORCE_SCHEMA_MIGRATION=true to run anyway (may cause data loss).`;
        console.error(msg);
        process.exit(1);
    }

    if (version === CURRENT_SCHEMA_VERSION) return;

    while (version < CURRENT_SCHEMA_VERSION) {
        const migration = migrations[version];
        if (!migration) break;
        settings = migration(settings);
        version++;
        // v2 → v3: backfill currency fields on every order so legacy data
        // renders correctly in the new multi-currency UI. Idempotent.
        if (version === 3 && Array.isArray(db.orders)) {
            let touched = 0;
            db.orders.forEach(o => {
                if (!o.currency) { o.currency = 'L.E.'; touched++; }
                if (o.conversionRate === undefined || o.conversionRate === null || !Number.isFinite(Number(o.conversionRate)) || Number(o.conversionRate) <= 0) {
                    o.conversionRate = 1;
                }
            });
            if (touched > 0) console.log(`[System] v2→v3 migration: backfilled currency='L.E.' on ${touched} order(s).`);
        }
        if (version === 4) {
            db.contracts = db.contracts || [];
        }
        if (version === 5) {
            // PR #26 — API Key support. Idempotent: skip when already present.
            db.apiKeys = db.apiKeys || [];
        }
        if (version === 6 && Array.isArray(db.orders)) {
            let migratedOrders = 0;
            db.orders.forEach(o => {
                const hasOutsourcing = (o.items || []).some(it => it.productionType === 'OUTSOURCING');
                if (hasOutsourcing) {
                    (o.items || []).forEach(it => {
                        if (it.productionType === 'OUTSOURCING') {
                            if (it.noRfpNeeded === undefined) it.noRfpNeeded = true;
                            if (it.costSheetFile && (!it.workingResourceCount || !it.realCost)) {
                                try {
                                    const m = extractCostSheetMetrics(it.costSheetFile, o.projectName);
                                    it.workingResourceCount = m.resourceCount;
                                    it.realCost = m.realCost;
                                    it.invoiceTotal = m.invoiceTotal;
                                } catch (e) {}
                            }
                            (it.components || []).forEach(c => {
                                if (c.noRfpNeeded === undefined) c.noRfpNeeded = true;
                                if (c.noRfpNeeded && ['PENDING_OFFER', 'NEW', undefined].includes(c.status)) {
                                    c.status = 'RUNNING_OUTSOURCING_CONTRACT';
                                }
                                if (it.workingResourceCount) c.workingResourceCount = it.workingResourceCount;
                                if (it.realCost) {
                                    c.realCost = it.realCost;
                                    if (!c.unitCost) c.unitCost = it.realCost;
                                }
                                if (it.invoiceTotal) c.invoiceTotal = it.invoiceTotal;
                            });
                        }
                    });
                    const allProcComps = o.items.flatMap(it => it.components || []).filter(c => c.source === 'PROCUREMENT');
                    const anyNeedsRfp = allProcComps.some(c => !c.noRfpNeeded && ['NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(c.status));
                    if (!anyNeedsRfp && (o.status === OrderStatus.WAITING_SUPPLIERS || !o.status)) {
                        o.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                        migratedOrders++;
                    }
                }
            });
            if (migratedOrders > 0) console.log(`[System] v5→v6 migration: updated ${migratedOrders} outsourcing order(s) to RUNNING_OUTSOURCING_CONTRACT.`);
        }
        if (version === 8 && Array.isArray(db.orders)) {
            let extractedFiles = 0;
            const isLive = targetPath === DB_PATH;
            const targetSandboxOwner = isLive ? null : path.basename(targetPath).replace('db.sandbox.', '').replace('.json', '');
            const uploadDir = isLive ? path.join(UPLOADS_BASE, 'cost_sheets') : path.join(getSandboxUploadsPath(targetSandboxOwner), 'cost_sheets');
            
            db.orders.forEach(o => {
                (o.items || []).forEach(it => {
                    if (it.costSheetFile && it.costSheetFile.startsWith('data:')) {
                        try {
                            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                            
                            let ext = '.xlsx';
                            const match = it.costSheetFile.match(/^data:([a-zA-Z0-9-+/.]+);base64,/);
                            if (match) {
                                const mime = match[1];
                                if (mime.includes('pdf')) ext = '.pdf';
                                else if (mime.includes('csv')) ext = '.csv';
                                else if (mime.includes('word')) ext = '.docx';
                            }
                            
                            const b64Data = it.costSheetFile.split(';base64,').pop();
                            const fileName = `cost-sheet-${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
                            const filePath = path.join(uploadDir, fileName);
                            
                            fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));
                            
                            // Map path format to frontend expectations
                            it.costSheetFile = isLive ? `uploads/cost_sheets/${fileName}` : `uploads/sandbox/${targetSandboxOwner}/cost_sheets/${fileName}`;
                            extractedFiles++;
                        } catch (e) {
                            console.error(`Error extracting base64 cost sheet for order ${o.id}:`, e);
                        }
                    }
                });
            });
            if (extractedFiles > 0) console.log(`[System] v7→v8 migration: Extracted ${extractedFiles} base64 cost sheet(s) to physical files in ${isLive ? 'Live' : targetSandboxOwner}.`);
        }
        if (version === 9) {
            if (!settings.availableRoles) settings.availableRoles = [];
            if (!settings.availableRoles.includes('sourcing')) {
                settings.availableRoles.push('sourcing');
            }
            if (!settings.roleMappings) settings.roleMappings = {};
            if (!settings.roleMappings['sourcing']) {
                settings.roleMappings['sourcing'] = ['sourcing', 'admin', 'management'];
            }
            console.log(`[System] v8→v9 migration: Registered 'sourcing' (taslemat) role and navigation mapping.`);
        }
        if (version === 10 && Array.isArray(db.orders)) {
            let extractedFiles = 0;
            const isLive = targetPath === DB_PATH;
            const targetSandboxOwner = isLive ? null : path.basename(targetPath).replace('db.sandbox.', '').replace('.json', '');
            const uploadDir = isLive ? path.join(UPLOADS_BASE, 'cost_sheets') : path.join(getSandboxUploadsPath(targetSandboxOwner), 'cost_sheets');

            const extractAndSaveBase64 = (b64String) => {
                if (!b64String || typeof b64String !== 'string' || !b64String.startsWith('data:')) return b64String;
                try {
                    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                    let ext = '.xlsx';
                    const match = b64String.match(/^data:([a-zA-Z0-9-+/.]+);base64,/);
                    if (match) {
                        const mime = match[1];
                        if (mime.includes('pdf')) ext = '.pdf';
                        else if (mime.includes('csv')) ext = '.csv';
                        else if (mime.includes('word')) ext = '.docx';
                    }
                    const b64Data = b64String.split(';base64,').pop();
                    const fileName = `cost-sheet-${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
                    const filePath = path.join(uploadDir, fileName);
                    fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));
                    extractedFiles++;
                    return isLive ? `uploads/cost_sheets/${fileName}` : `uploads/sandbox/${targetSandboxOwner}/cost_sheets/${fileName}`;
                } catch (e) {
                    console.error('[System] Error extracting base64 cost sheet during v10 migration:', e);
                    return b64String;
                }
            };

            db.orders.forEach(o => {
                (o.items || []).forEach(it => {
                    if (it.costSheetFile && it.costSheetFile.startsWith('data:')) {
                        it.costSheetFile = extractAndSaveBase64(it.costSheetFile);
                    }
                    if (Array.isArray(it.costSheets)) {
                        it.costSheets.forEach(cs => {
                            if (cs.fileData && cs.fileData.startsWith('data:')) {
                                cs.fileData = extractAndSaveBase64(cs.fileData);
                            }
                        });
                    }
                });
                if (o.costSheetFile && o.costSheetFile.startsWith('data:')) {
                    o.costSheetFile = extractAndSaveBase64(o.costSheetFile);
                }
                if (Array.isArray(o.costSheets)) {
                    o.costSheets.forEach(cs => {
                        if (cs.fileData && cs.fileData.startsWith('data:')) {
                            cs.fileData = extractAndSaveBase64(cs.fileData);
                        }
                    });
                }
            });
            if (extractedFiles > 0) console.log(`[System] v9→v10 migration: Purged and extracted ${extractedFiles} base64 cost sheet(s) to physical files in ${isLive ? 'Live' : targetSandboxOwner}.`);
        }
        if (version === 11) {
            if (!settings.dropboxConfig || !settings.dropboxConfig.refreshToken) {
                settings.dropboxConfig = {
                    ...DEFAULT_DROPBOX_CONFIG
                };
            }
            if (!settings.storageBackend) {
                settings.storageBackend = 'dropbox';
            }
            console.log(`[System] v10→v11 migration: Initialized Dropbox storage settings.`);
        }
    }

    settings.dbSchemaVersion = CURRENT_SCHEMA_VERSION;
    db.settings[0] = encryptSettings(settings);
    writeDb(db, targetPath);
    console.log(`[System] Migrated db schema from v${settings.dbSchemaVersion - (CURRENT_SCHEMA_VERSION - version)} to v${CURRENT_SCHEMA_VERSION}`);
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

// One-time repair: orders that were incorrectly blocked as NEGATIVE_MARGIN when no
// costs had been identified or when classified as blanket orders are reset.
const repairNegativeMarginOrders = (db, targetPath = DB_PATH) => {
    if (!db.orders || db.orders.length === 0) return;
    let changed = false;
    db.orders.forEach(order => {
        if (order.status !== OrderStatus.NEGATIVE_MARGIN) return;
        const isBlanket = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
        if (isBlanket) {
            const hasComponents = (order.items || []).some(i => i.components && i.components.length > 0);
            const anyAccepted = (order.items || []).some(i => i.isAccepted);
            order.status = (hasComponents || anyAccepted) ? OrderStatus.TECHNICAL_REVIEW : OrderStatus.LOGGED;
            order.loggingComplianceViolation = false;
            if (!order.logs) order.logs = [];
            order.logs.push(createAuditLog(`[AUTO] Data repair: Blanket order exempt from NEGATIVE_MARGIN restored to ${order.status}`, order.status, 'System'));
            changed = true;
            return;
        }
        const totalCost = (order.items || []).reduce((sum, item) =>
            sum + (item.components || []).reduce((cSum, c) =>
                cSum + ((c.quantity || 0) * (c.unitCost || 0)), 0), 0);
        if (totalCost === 0) {
            order.status = OrderStatus.LOGGED;
            order.loggingComplianceViolation = false;
            if (!order.logs) order.logs = [];
            order.logs.push(createAuditLog('[AUTO] Data repair: NEGATIVE_MARGIN reset to LOGGED because no costs were identified', OrderStatus.LOGGED, 'System'));
            changed = true;
        }
    });
    if (changed) writeDb(db, targetPath);
};

// Repair: ensure TRADING line items have their initial mirror component if missing and not rolled back
const repairTradingMirrorOrders = (db, targetPath = DB_PATH) => {
    if (!db.orders || db.orders.length === 0) return;
    let changed = false;
    db.orders.forEach(order => {
        if (order.rolledBackToLogged || order.blanketOrder) return;
        (order.items || []).forEach((item, idx) => {
            const pType = item.productionType || 'TRADING';
            if (pType === 'TRADING' && (!item.components || item.components.length === 0)) {
                item.productionType = 'TRADING';
                const newComp = {
                    id: `c_${Date.now()}_${idx}_0`,
                    description: item.description,
                    quantity: getItemEffectiveQty(item),
                    unit: item.unit || 'pcs',
                    unitCost: 0,
                    taxPercent: 14,
                    source: 'PROCUREMENT',
                    status: 'PENDING_OFFER',
                    componentNumber: `CMP-${order.internalOrderNumber}-${idx + 1}-1`
                };
                const match = (db.suppliers || []).flatMap(s => s.priceList || []).find(p => String(p?.description || '').trim().toLowerCase() === String(item.description || '').trim().toLowerCase());
                if (match) newComp.supplierPartNumber = match.partNumber;
                item.components = [newComp];
                changed = true;
            }
        });
    });
    if (changed) writeDb(db, targetPath);
};

// Repair / reconcile stock order allocations across any database (live or sandbox)
const reconcileStockAllocations = (db, targetPath = null) => {
    if (!db || !Array.isArray(db.orders) || db.orders.length === 0) return false;
    let changed = false;

    // 1. Collect all allocations from all active orders in this database
    const allocationsByStockOrder = new Map();
    db.orders.forEach(order => {
        if (order.status === OrderStatus.REJECTED || order.status === 'REJECTED') return;
        (order.items || []).forEach(item => {
            (item.components || []).forEach(comp => {
                if (comp.allocatedFromStockOrderId) {
                    const sId = comp.allocatedFromStockOrderId;
                    if (!allocationsByStockOrder.has(sId)) allocationsByStockOrder.set(sId, []);
                    allocationsByStockOrder.get(sId).push({
                        compId: comp.allocatedFromStockCompId,
                        itemId: comp.allocatedFromStockItemId,
                        description: String(comp.description || '').trim().toLowerCase(),
                        quantity: Number(comp.quantity) || 0
                    });
                }
            });
        });
    });

    // 2. Reconcile stock orders & repair item metadata / split award POs
    db.orders.forEach(order => {
        const isApproved = Boolean(order.technicalReviewFinishedAt) && !order.rolledBackToLogged && order.status && ![OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW, OrderStatus.REJECTED].includes(order.status);
        (order.items || []).forEach((it, idx) => {
            if (!it.orderNumber && order.internalOrderNumber) {
                it.orderNumber = `${order.internalOrderNumber}-${idx + 1}`;
                changed = true;
            }
            if (isApproved && it.isAccepted === false) {
                it.isAccepted = true;
                changed = true;
            }
            (it.components || []).forEach(c => {
                if (c.awardId === 'yangyse' && c.supplierId === 'suppliers_1780909390618' && c.poNumber && c.poNumber !== 'PO-829515') {
                    c.supersededPoNumber = c.poNumber;
                    c.poNumber = 'PO-829515';
                    c.sendPoId = '2euwy25';
                    changed = true;
                }
            });
        });
    });
    db.orders.forEach(order => {
        const isStock = isStockOrder(order);
        if (!isStock || order.status === OrderStatus.REJECTED || order.status === 'REJECTED') return;

        if (order.loggingComplianceViolation) {
            order.loggingComplianceViolation = false;
            changed = true;
        }

        const allocList = allocationsByStockOrder.get(order.id) || [];

        (order.items || []).forEach(item => {
            (item.components || []).forEach(comp => {
                // Find matching allocations for this component
                const matchingAllocs = allocList.filter(a =>
                    (a.compId && comp.id && a.compId === comp.id) ||
                    (a.itemId && item.id && a.itemId === item.id) ||
                    (a.description && String(comp.description || '').trim().toLowerCase() === a.description)
                );

                const totalAllocated = matchingAllocs.reduce((sum, a) => sum + (Number(a.quantity) || 0), 0);

                if (totalAllocated > 0) {
                    // Determine base quantity
                    const baseQty = comp.originalQuantity !== undefined
                        ? comp.originalQuantity
                        : (item.originalQuantity !== undefined
                            ? item.originalQuantity
                            : (((comp.allocatedQty || 0) > 0)
                                ? ((comp.quantity || 0) + comp.allocatedQty)
                                : (comp.quantity || 0)));

                    const expectedRemaining = Math.max(0, Number((baseQty - totalAllocated).toFixed(3)));

                    if (comp.originalQuantity !== baseQty ||
                        item.originalQuantity !== baseQty ||
                        comp.allocatedQty !== totalAllocated ||
                        item.allocatedQty !== totalAllocated ||
                        comp.quantity !== expectedRemaining ||
                        item.quantity !== expectedRemaining) {

                        comp.originalQuantity = baseQty;
                        item.originalQuantity = baseQty;
                        comp.allocatedQty = totalAllocated;
                        item.allocatedQty = totalAllocated;
                        comp.quantity = expectedRemaining;
                        item.quantity = expectedRemaining;
                        if (expectedRemaining <= 0) {
                            comp.status = 'DEPLETED';
                        }
                        changed = true;
                    }
                } else if ((comp.allocatedQty || 0) > 0 || (item.allocatedQty || 0) > 0) {
                    // All allocations removed
                    const baseQty = comp.originalQuantity !== undefined ? comp.originalQuantity : (item.originalQuantity !== undefined ? item.originalQuantity : (comp.quantity || 0));
                    comp.allocatedQty = 0;
                    item.allocatedQty = 0;
                    comp.quantity = baseQty;
                    item.quantity = baseQty;
                    changed = true;
                }
            });
        });
    });

    if (changed && targetPath) {
        writeDb(db, targetPath);
    }
    return changed;
};

const reconcileOrdersMarginOnThresholdChange = (db, oldMinMargin, newMinMargin, user) => {
    if (oldMinMargin === newMinMargin) return;
    if (!db.orders || db.orders.length === 0) return;

    db.orders.forEach(order => {
        // Skip final/hold statuses
        if ([OrderStatus.REJECTED, OrderStatus.IN_HOLD, OrderStatus.DELIVERED, OrderStatus.FULFILLED].includes(order.status)) {
            return;
        }

        // Check if customer override exists - if so, this order is unaffected by global changes
        const customer = db.customers.find(c => c.name === order.customerName);
        if (customer && customer.minimumMarginPct !== undefined && customer.minimumMarginPct !== null) {
            return;
        }

        const oldStatus = order.status;
        let nextStatus = oldStatus || OrderStatus.LOGGED;

        const isBlanket = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
        const isStock = isStockOrder(order);
        nextStatus = evaluateMarginStatus(order.items, newMinMargin, oldStatus || OrderStatus.LOGGED, marginFx(order), isBlanket, isStock, order.marginReleasedSig);

        if (nextStatus !== oldStatus) {
            order.status = nextStatus;
            order.loggingComplianceViolation = false;

            if (oldStatus === OrderStatus.NEGATIVE_MARGIN && nextStatus !== OrderStatus.NEGATIVE_MARGIN) {
                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(
                    'Alert removed due to altering the threshold of the margin.',
                    nextStatus,
                    user
                ));
            } else if (nextStatus === OrderStatus.NEGATIVE_MARGIN) {
                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(
                    `[AUTO] Margin Protection: Status moved from ${oldStatus} to ${OrderStatus.NEGATIVE_MARGIN}`,
                    OrderStatus.NEGATIVE_MARGIN,
                    'System'
                ));
            } else {
                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(
                    `[AUTO] Workflow Update: Status moved from ${oldStatus} to ${nextStatus}`,
                    nextStatus,
                    'System'
                ));
            }
        }
    });
};

const generateInternalOrderNumber = (db) => {
    const orders = db.orders || [];
    const maxNum = orders.reduce((max, o) => {
        const match = (o.internalOrderNumber || '').match(/INT-2024-(\d{4,})/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);
    return `INT-2024-${String(maxNum + 1).padStart(4, '0')}`;
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
                if (comp.inventoryItemId && ((comp.status === 'RECEIVED' && !isStockOrder(order)) || comp.status === 'RESERVED' || comp.source === 'STOCK') && comp.source !== 'CONSUMED') {
                    const current = map.get(comp.inventoryItemId) || 0;
                    // R23: the consumed part has left stock, so it is no longer reserved
                    map.set(comp.inventoryItemId, current + Math.max(0, (comp.quantity || 0) - (comp.consumedQty || 0)));
                } else if (comp.inventoryItemId && comp.source === 'PROCUREMENT' && !isStockOrder(order) && (comp.receivedQty || 0) > 0 && !comp.forStock && !['CANCELLED', 'ORDERED_FOR_STOCK', 'Manufactured', 'STOCKED'].includes(comp.status)) {
                    // v1.0001195: a component bought for stock (forStock / STOCKED) is free stock, never reserved for the order
                    // R22 (C11): a partly received procured component is reserved for the order for the received part, at receipt.
                    const current = map.get(comp.inventoryItemId) || 0;
                    map.set(comp.inventoryItemId, current + Math.min(comp.receivedQty || 0, comp.quantity || 0));
                }
            });
        });
        return map;
    };

    // R24: a rejected/cancelled order already released its reservations at the rejection; do not release them again on reopen.
    const wasRejected = !!(oldOrder && oldOrder.status === OrderStatus.REJECTED);
    const oldMap = wasRejected ? new Map() : getReservedMap(oldOrder);
    const newMap = (wasRejected && newOrder && newOrder.status === OrderStatus.REJECTED) ? new Map() : getReservedMap(newOrder);

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
                // v1.0001196: a reservation is never negative (a release function that already freed the stock must not be released a second time)
                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) + delta);
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
    if (!isStockOrder(newOrder) || !newOrder.items) return;

    (newOrder.items || []).forEach(item => {
        (item.components || []).forEach(comp => {
            // Find corresponding component in old order to detect status change
            // If new order (oldOrder is null), checks if status is already RECEIVED (unlikely but possible)
            const oldComp = oldOrder
                ? (oldOrder.items.find(i => i.id === item.id)?.components || []).find(c => c.id === comp.id)
                : null;

            const oldStatus = oldComp ? oldComp.status : 'NEW';

            // Trigger on transition to RECEIVED
            if (['RECEIVED', 'STOCKED'].includes(comp.status) && !['RECEIVED', 'STOCKED'].includes(oldStatus) && comp.inventoryItemId) {
                const invItem = (db.inventory || []).find(inv => inv.id === comp.inventoryItemId);
                if (invItem) {
                    const qty = Math.max(0, (Number(comp.quantity) || 0) - (Number(comp.stockBooked) || 0));
                    comp.stockBooked = Number(comp.quantity) || 0;
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

const getTechReviewStartTime = (order) => {
    if (!order) return Date.now();
    if (order.technicalReviewStartedAt) {
        const t = new Date(order.technicalReviewStartedAt).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    const logs = order.logs || [];
    for (let i = logs.length - 1; i >= 0; i--) {
        const l = logs[i];
        const msg = (l.message || '').toLowerCase();
        if (l.status === 'LOGGED' || msg.includes('rollback to logged') || msg.includes('order acquisition')) {
            const t = new Date(l.timestamp).getTime();
            if (!isNaN(t) && t > 0) return t;
        }
    }
    if (order.dataEntryTimestamp) {
        const t = new Date(order.dataEntryTimestamp).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    if (order.orderDate) {
        const t = new Date(order.orderDate).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    return Date.now();
};

const processedOrderInternal = (order, db, user, isNew, oldOrder = null, skipStatusEval = false) => {
    // 1. Ensure basic structures
    if (!order.logs) order.logs = [];
    if (!order.items) order.items = [];
    if (!order.status) order.status = OrderStatus.LOGGED;

    // 1b. Multi-currency defaults — every order is implicitly denominated in
    //     'L.E.' with conversionRate = 1 unless explicitly set. This mirrors
    //     the v2→v3 migration so newly-created orders behave the same.
    if (!order.currency) order.currency = 'L.E.';
    if (!Number.isFinite(Number(order.conversionRate)) || Number(order.conversionRate) <= 0) {
        order.conversionRate = 1;
    }

    // 2. Handle New Order specific side-effects
    if (isNew) {
        if (!order.internalOrderNumber) order.internalOrderNumber = generateInternalOrderNumber(db);
        if (!order.dataEntryTimestamp) order.dataEntryTimestamp = new Date().toISOString();
        if (!order.technicalReviewStartedAt) order.technicalReviewStartedAt = order.dataEntryTimestamp;
        if (order.logs.length === 0) {
            order.logs.push(createAuditLog('Order acquisition recorded', OrderStatus.LOGGED, user));
        }
    }

    // 2.5 Handle Stock Replenishment logic
    handleStockReceipts(oldOrder, order, db);

    // 3. Process Items and Components
    order.items.forEach((item, idx) => {
        if (!item.id) item.id = `item_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
        if (!item.orderNumber && order.internalOrderNumber) item.orderNumber = `${order.internalOrderNumber}-${idx + 1}`;
        if (!item.logs) item.logs = [];
        if (!item.components) item.components = [];

        // Normalize quantity: blank, null, undefined, NaN, or <= 0 becomes 1
        const qtyNum = Number(item.quantity);
        if (isNaN(qtyNum) || qtyNum <= 0) {
            item.quantity = 1;
        }

        // Normalize and preserve pricePerUnit across order processing
        const rawPrice = item.pricePerUnit ?? item.unitPrice ?? item.price;
        if (rawPrice !== undefined && rawPrice !== null && !isNaN(Number(rawPrice))) {
            item.pricePerUnit = Number(rawPrice);
        } else if (item.pricePerUnit === undefined) {
            item.pricePerUnit = 0;
        }

        // Automation: If BoM changed compared to old order, revoke approval
        if (oldOrder) {
            const oldItem = (oldOrder.items || []).find(i => i.id === item.id);
            if (oldItem) {
                // simple stringify check for BoM change
                const oldComps = JSON.stringify((oldItem.components || []).map(c => ({ id: c.id, description: c.description, quantity: c.quantity, unit: c.unit, source: c.source, supplierPartNumber: c.supplierPartNumber })));
                const newComps = JSON.stringify((item.components || []).map(c => ({ id: c.id, description: c.description, quantity: c.quantity, unit: c.unit, source: c.source, supplierPartNumber: c.supplierPartNumber })));
                const isAlreadyPastTechReview = Boolean(order.technicalReviewFinishedAt) || (order.status && ![OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW].includes(order.status));
                if (!isAlreadyPastTechReview && oldComps !== newComps && item.isAccepted) {
                    item.isAccepted = false;
                    order.logs.push(createAuditLog(`[AUTO] BoM mutation detected on item ${idx + 1}. Technical approval revoked.`, order.status, 'System'));
                }
            }
        }

        // 3b. Trading Mirror Sync & Defaulting
        if (!item.productionType) {
            item.productionType = 'TRADING';
        }

        const isOrderApproved = Boolean(order.technicalReviewFinishedAt) || (order.status && ![OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW].includes(order.status));

        if (!order.rolledBackToLogged) {
            if (item.productionType === 'TRADING') {
                if (order.blanketOrder) {
                    // Blanket order in Trade Mode: Technical review adds components with any qty needed.
                    // Do NOT force a single mirror component or overwrite descriptions/quantities.
                    if (item.components && Array.isArray(item.components)) {
                        item.components.forEach((comp, cIdx) => {
                            if (!comp.componentNumber) {
                                comp.componentNumber = comp.supplierPartNumber || `CMP-${order.internalOrderNumber}-${idx + 1}-${cIdx + 1}`;
                            }
                            if (isOrderApproved) {
                                if (comp.source === 'PROCUREMENT' && ['NEW', 'PENDING_OFFER'].includes(comp.status)) {
                                    comp.status = 'PENDING_OFFER';
                                    if (!comp.procurementStartedAt) {
                                        comp.procurementStartedAt = new Date().toISOString();
                                    }
                                }
                            } else {
                                if (comp.status === 'PENDING_OFFER' && !comp.poNumber && !comp.rfpId && !comp.awardId && !comp.procurementStartedAt) {
                                    comp.status = 'NEW';
                                }
                            }
                        });
                    }
                } else {
                    // Standard non-blanket TRADING mirror logic
                    // Ensure exactly one component that mirrors the item (skip if fully depleted/allocated)
                    const isFullyDepleted = (item.allocatedQty || 0) >= getItemEffectiveQty(item) && (item.allocatedQty || 0) > 0;
                    if ((!item.components || item.components.length === 0) && !isFullyDepleted) {
                        const newComp = {
                            id: `c_${Date.now()}_${idx}_0`,
                            description: item.description,
                            quantity: getItemEffectiveQty(item),
                            unit: item.unit || 'pcs',
                            unitCost: 0,
                            taxPercent: 14,
                            source: 'PROCUREMENT',
                            status: isOrderApproved ? 'PENDING_OFFER' : 'NEW',
                            componentNumber: `CMP-${order.internalOrderNumber}-${idx + 1}-1`
                        };
                        
                        // Automatic intelligence: search price list for match
                        const match = (db.suppliers || []).flatMap(s => s.priceList || []).find(p => String(p?.description || '').trim().toLowerCase() === String(item.description || '').trim().toLowerCase());
                        if (match) newComp.supplierPartNumber = match.partNumber;

                        item.components = [newComp];
                    } else if (item.components && item.components.length > 0) {
                        // Mirror sync: Only the first component is active in TRADING
                        const comp = item.components[0];
                        if (comp.description !== item.description) {
                            comp.description = item.description;
                        }
                        
                        // Attempt to auto-populate part number if missing
                        if (!comp.supplierPartNumber) {
                            const match = (db.suppliers || []).flatMap(s => s.priceList || []).find(p => String(p?.description || '').trim().toLowerCase() === String(comp.description || '').trim().toLowerCase());
                            if (match) comp.supplierPartNumber = match.partNumber;
                        }

                        const isStock = isStockOrder(order);
                        const hasAllocations = (item.allocatedQty || 0) > 0 || (comp.allocatedQty || 0) > 0;

                        // Only sync comp.quantity directly from item.quantity for non-stock orders without allocations
                        // A PO amended by extension keeps its amended quantity; the leftover is a separate component.
                        const hasExtensionSplit = item.components.some(c => c.isExtension || c.splitFromExtensionPo);
                        if (!isStock && !hasAllocations && !hasExtensionSplit) {
                            if (!comp.allocatedFromStockOrderId && comp.source !== 'STOCK' && !comp.forStock && comp.quantity !== getItemEffectiveQty(item)) {
                                comp.quantity = getItemEffectiveQty(item);
                            }
                        } else if (hasAllocations) {
                            const totalBase = (item.originalQuantity !== undefined ? item.originalQuantity : ((item.quantity || 0) + (item.allocatedQty || comp.allocatedQty || 0)));
                            if (item.originalQuantity === undefined) item.originalQuantity = totalBase;
                            const remaining = Math.max(0, totalBase - (item.allocatedQty || comp.allocatedQty || 0));
                            comp.quantity = remaining;
                            item.quantity = remaining;
                            if (remaining <= 0) {
                                comp.status = 'DEPLETED';
                            }
                        } else if (isStock && item.originalQuantity !== undefined) {
                            // All allocations have been returned or restored back to stock order
                            comp.quantity = item.originalQuantity;
                            item.quantity = item.originalQuantity;
                            if (comp.status === 'DEPLETED') {
                                comp.status = isOrderApproved ? 'PENDING_OFFER' : 'NEW';
                            }
                        }

                        if (!isOrderApproved && comp.status === 'PENDING_OFFER' && !comp.poNumber && !comp.rfpId && !comp.awardId && !comp.procurementStartedAt) {
                            comp.status = 'NEW';
                        }
                        // Cap at 1 component for TRADING to prevent BoM pollution unless split into stock and procurement
                        const hasStockAllocations = item.components.some(c => c.allocatedFromStockOrderId || c.isExtension || c.splitFromExtensionPo || c.source === 'STOCK' || c.forStock || c.status === 'ORDERED_FOR_STOCK');
                        if (!hasStockAllocations && item.components.length > 1) {
                            item.components = [item.components[0]];
                        }
                    }
                }
            }

            if (item.productionType === 'OUTSOURCING') {
                if (item.noRfpNeeded === undefined) item.noRfpNeeded = true;
                if (!item.components || item.components.length === 0) {
                    const contractNum = order.contractId || order.blanketContractId || `CON-${order.internalOrderNumber || 'ORD'}-${idx + 1}`;
                    const newComp = {
                        id: `c_${Date.now()}_${idx}_0`,
                        description: item.description,
                        quantity: getItemEffectiveQty(item),
                        unit: item.unit || 'pcs',
                        unitCost: 0,
                        taxPercent: item.taxPercent || 14,
                        source: 'PROCUREMENT',
                        status: isOrderApproved ? 'RUNNING_OUTSOURCING_CONTRACT' : 'NEW',
                        noRfpNeeded: true,
                        componentNumber: item.supplierPartNumber || `CMP-${order.internalOrderNumber || 'ORD'}-${idx + 1}-1`,
                        contractNumber: contractNum,
                        contractStartDate: order.orderDate || undefined
                    };
                    item.components = [newComp];
                } else {
                    item.components.forEach(comp => {
                        if (comp.noRfpNeeded === undefined) comp.noRfpNeeded = true;
                        if (isOrderApproved && comp.noRfpNeeded && comp.source !== 'STOCK' && (comp.status === 'PENDING_OFFER' || !comp.status || comp.status === 'NEW')) {
                            comp.status = 'RUNNING_OUTSOURCING_CONTRACT';
                        }
                    });
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
            // R30 ruling 2026-10-22: a stock part held for this order's PO is RESERVED (not NEW / PENDING_OFFER)
            if (!isStockOrder(order) && comp.source === 'STOCK' && comp.inventoryItemId && ['NEW', 'PENDING_OFFER'].includes(comp.status)) comp.status = 'RESERVED';
            if (!isOrderApproved && comp.status === 'PENDING_OFFER' && !comp.poNumber && !comp.rfpId && !comp.awardId && !comp.procurementStartedAt) {
                comp.status = 'NEW';
            }
            if (!comp.statusUpdatedAt) comp.statusUpdatedAt = new Date().toISOString();
        });
    });

    // 4. Force Status Evaluation
    if (!skipStatusEval && !order.rolledBackToLogged) {
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
        let minMargin = dbSettings.minimumMarginPct || 15;

        // CUSTOMER OVERRIDE: Check if customer has a specific minimum margin
        const customer = db.customers.find(c => c.name === order.customerName);
        if (customer && customer.minimumMarginPct !== undefined && customer.minimumMarginPct !== null) {
            minMargin = customer.minimumMarginPct;
        }

        // Skip margin check for Internal Stock orders (they always have 0 revenue)
        let nextStatus = order.status || OrderStatus.LOGGED;
        const isBlanket = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
        const isStock = isStockOrder(order);
        nextStatus = evaluateMarginStatus(order.items, minMargin, order.status || OrderStatus.LOGGED, marginFx(order), isBlanket, isStock, order.marginReleasedSig);

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
                // Determine which items drive the status based on priority: Manufacturing > Trading > Outsourcing
                const manufacturingItems = order.items.filter(item => item.productionType === 'MANUFACTURING');
                const tradingItems = order.items.filter(item => item.productionType === 'TRADING');
                const outsourcingItems = order.items.filter(item => item.productionType === 'OUTSOURCING');

                let drivingItems = [];
                let statusDriver = '';

                if (manufacturingItems.length > 0) {
                    drivingItems = manufacturingItems;
                    statusDriver = 'manufacturing';
                } else if (tradingItems.length > 0) {
                    drivingItems = tradingItems;
                    statusDriver = 'trading';
                } else {
                    // Only outsourcing items - don't advance status
                    drivingItems = [];
                    statusDriver = 'outsourcing';
                }

                if (drivingItems.length > 0) {
                    // Check if ANY procurement component in driving items still needs action
                    const anyStillInProcurement = drivingItems.some(item =>
                        (item.components || []).some(comp =>
                            comp.source === 'PROCUREMENT' && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED'].includes(comp.status) && (comp.receivedQty || 0) < (comp.quantity || 0)
                        )
                    );

                    // Check if driving items have components ready (Reserved/Received/In Stock, or fully received)
                    const anyReservedOrReceived = drivingItems.some(item =>
                        (item.components || []).some(comp =>
                            ['RESERVED', 'RECEIVED', 'STOCKED', 'IN_STOCK'].includes(comp.status) ||
                            ((comp.receivedQty || 0) >= (comp.quantity || 0))
                        )
                    );

                    if (anyReservedOrReceived && !anyStillInProcurement) {
                        // Transition based on item type
                        const old = order.status;
                        if (statusDriver === 'manufacturing') {
                            order.status = OrderStatus.WAITING_FACTORY;
                            order.logs.push(createAuditLog(`[AUTO] Manufacturing procurement complete. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                        } else if (statusDriver === 'trading' && !isStockOrder(order)) {
                            // Trading items go directly to hub when components are received
                            order.status = OrderStatus.IN_PRODUCT_HUB;

                            // Mark trading items as manufactured and move to hub
                            tradingItems.forEach(item => {
                                item.status = 'Manufactured';
                                item.hubReceivedQty = getItemEffectiveQty(item);
                                (item.components || []).forEach(comp => {
                                    if (comp.status !== 'Manufactured') {
                                        comp.status = 'Manufactured';
                                        comp.statusUpdatedAt = new Date().toISOString();
                                    }

                                    // Update inventory: Remove from reserved since item is now committed to order
                                    // CX03: warehouse stock allocated to the line stays reserved until the delivery consumes it (it must not look free while it waits in the hub).
                                    if (comp.inventoryItemId && db.inventory && comp.source !== 'STOCK') {
                                        const invItem = db.inventory.find(inv => inv.id === comp.inventoryItemId);
                                        if (invItem) {
                                            const qtyToUnreserve = comp.quantity || 0;
                                            invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - qtyToUnreserve);
                                            invItem.lastUpdated = new Date().toISOString();

                                            console.log(`[Inventory] [TRADING_HUB_TRANSFER] Unreserved ${qtyToUnreserve} of ${invItem.sku}. New Reserved: ${invItem.quantityReserved}`);
                                        }
                                    }
                                });
                            });

                            order.logs.push(createAuditLog(`[AUTO] Trading items ready for delivery. Auto-transitioned to Ready for Invoicing`, order.status, 'System'));
                        }
                    }
                } else if (statusDriver === 'outsourcing') {
                    const anyNeedsRfp = outsourcingItems.some(item =>
                        (item.components || []).some(comp => comp.noRfpNeeded === false && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(comp.status))
                    );
                    // R30 ruling 16:20: outside blanket outsourcing the order stays WAITING_SUPPLIERS until every supplier item is received (component statuses are independent).
                    const blLike = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
                    const rfpPathUndelivered = false && outsourcingItems.some(item => // R30 ruling 19:00: an outsourcing order is never WAITING_SUPPLIERS for undelivered items
                        (item.components || []).some(comp => comp.source === 'PROCUREMENT' && comp.noRfpNeeded === false && (Number(comp.receivedQty) || 0) < (Number(comp.quantity) || 0))
                    );
                    // R30 ruling 19:24 (option A): an outsourcing order never holds WAITING_SUPPLIERS, RFP path or not.
                    if (order.status === OrderStatus.WAITING_SUPPLIERS) {
                        const old = order.status;
                        order.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                        order.logs.push(createAuditLog(`[AUTO] Outsourcing contract active. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                    } else if (false && anyNeedsRfp && order.status === OrderStatus.RUNNING_OUTSOURCING_CONTRACT) {
                        const old = order.status;
                        order.status = OrderStatus.WAITING_SUPPLIERS;
                        order.logs.push(createAuditLog(`[AUTO] Outsourcing contract requires RFP. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                    }
                }
            }
        }

        // [AUTO] Manufacturing Start Logic (Release to Floor)
        if (order.status === OrderStatus.MANUFACTURING) {
            (order.items || []).forEach(item => {
                (item.components || []).forEach(comp => {
                    // Deduct from stock if linked to inventory and not yet consumed
                    // R23 (C12): production start no longer consumes everything. Components stay reserved; the
                    // factory consumes only what production uses (register-manufacturing / consume-factory-component),
                    // and what is left is released to free stock.
                    if (false && comp.inventoryItemId && db.inventory && comp.source !== 'CONSUMED') {
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
                            const consumedQty = Math.max(0, (comp.quantity || 0) - (comp.consumedQty || 0));
                            const currentStock = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);

                            invItem.quantityInStock = Math.max(0, currentStock - consumedQty);
                            // quantityReserved will be handled by reconcileInventory side-effect
                            if (invItem.quantity !== undefined) delete invItem.quantity;
                            comp.consumedQty = comp.quantity || 0;
                            
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

const sendEmail = async (to, subject, body, config, req = null) => {
    // In sandbox mode, simulate email dispatch so real employees are never spammed.
    if (req && isSandbox(req)) {
        console.log(`[Sandbox Email Simulated] To: ${JSON.stringify(to)} | Subject: ${subject}`);
        return { success: true, simulated: true };
    }
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
    'PARTIAL_PAYMENT': null,  // handled by special payment SLA check
    'RUNNING_OUTSOURCING_CONTRACT': null
};

// Maps Component CompStatus Ã¢â€ â€™ settings config key (procurement process thresholds)
const COMP_STATUS_TO_THRESHOLD = {
    'PENDING_OFFER': 'pendingOfferLimitHrs',
    'RFP_SENT': 'rfpSentLimitHrs',
    'AWARDED': 'awardedLimitHrs',
    'ORDERED': 'orderedLimitHrs',
    'RUNNING_OUTSOURCING_CONTRACT': null
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
    try {
        console.debug(`[Audit] Routine check started at ${new Date().toISOString()}`);
    // Threshold audits intentionally run against the live DB only — sandbox DBs
    // are isolated training environments and must never trigger alerts to real
    // personnel. See plan §2 ("Background threshold audits remain strictly on the
    // Live DB"). The on-read migration guard in readDb() still upgrades the live
    // DB's schema if it is behind CURRENT_SCHEMA_VERSION.
    const db = readDb();
    const orders = db.orders || [];
    const notifications = db.notifications || [];
    const settings = resolveSettings(db);

    let dbChanged = false;
    if (sweepContractStarts(db, new Date().toISOString().slice(0, 10))) dbChanged = true;

    // --- Missing withholding certificate SLA (after 30 Nov of the order year) ---
    {
        const wm = computeMissingWht(orders);
        for (const it of wm.items.filter(i => i.overdue)) {
            const jk = `wht_sla_${it.orderId}`;
            if (notifications.some(n => n.journalKey === jk)) continue;
            const recipients = getRecipients(settings.thresholdNotifications?.['whtMissingSla'] || [], db);
            const subject = `SLA: missing withholding certificate ${it.internalOrderNumber}`;
            const body = `Customer ${it.customerName}, PO ${it.internalOrderNumber} (${it.date}): withholding certificate for ${it.amount.toFixed(2)} was due by ${it.deadline} and is still missing.`;
            let sent = false;
            if (recipients.length > 0) { const r = await sendEmail(recipients.map(x => x.email), subject, body, settings.emailConfig); sent = !!r.success; }
            notifications.push({ id: `nt_wht_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, journalKey: jk, orderId: it.orderId, type: 'wht_missing_sla', amount: it.amount, customerName: it.customerName, deadline: it.deadline, message: body, sentAt: new Date().toISOString(), recipients: recipients.map(x => x.email), emailSent: sent, queuedInApp: !sent });
            dbChanged = true;
        }
    }

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
        const isStock = isStockOrder(order);

        // Clear any historical compliance violation on stock orders
        if (isStock && order.loggingComplianceViolation) {
            order.loggingComplianceViolation = false;
            dbChanged = true;
        }

        // A0. Gov. E-Invoice SLA (3-hr threshold) - Not applicable for Stock Orders
        if (!isStock && order.einvoiceRequested && !order.einvoiceFile) {
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

        // A1. Logging Delay (PO date vs data entry date, in days) - Only for non-stock LOGGED orders
        if (!isStock && order.status === OrderStatus.LOGGED) {
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

        // A4. Negative Margin (status-based, not time-based - exempting blanket orders and stock orders)
        if (!isStock && order.status === 'NEGATIVE_MARGIN' && !order.blanketOrder && !order.contractId && !order.blanketContractId) {
            let totalRevenue = 0, totalCost = 0;
            (order.items || []).forEach(it => {
                totalRevenue += (getItemEffectiveQty(it) * it.pricePerUnit);
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

        // A5. Payment SLA Overdue (days since invoice - not applicable to stock orders)
        if (!isStock && (order.status === 'INVOICED' || order.status === 'DELIVERED' || order.status === 'PARTIAL_PAYMENT')) {
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

        // A6. Delivery Deadline Check - not applicable to stock orders
        if (!isStock && settings.enableDeliveryAlerts && order.targetDeliveryDate && ![OrderStatus.DELIVERED, OrderStatus.FULFILLED, OrderStatus.WAITING_GOVE, OrderStatus.REJECTED].includes(order.status)) {
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
                let statusEnteredAt;
                if (order.status === OrderStatus.TECHNICAL_REVIEW) {
                    statusEnteredAt = getTechReviewStartTime(order);
                } else {
                    const lastStatusLog = [...(order.logs || [])].reverse().find(l => l.status === order.status);
                    statusEnteredAt = lastStatusLog ? new Date(lastStatusLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
                }
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
        writeDb(db, DB_PATH);
    }
    } catch (err) {
        console.error('[Audit] Error in runThresholdAudit:', err);
    }
};

// --- APP SETUP ---
const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// v1.0001200: no-auth health probe (Render health check). Never exposes secrets, URLs or paths.
app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(persistenceHealth());
});

// v1.0001200: read-only mode (Turso hydrate failed / below floor / conflict) refuses every change.
// Logins, restores and the admin persistence routes stay open so an admin can recover.
app.use((req, res, next) => {
    if (!persistState.readOnly) return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.path.startsWith('/api/')) return next();
    if (/\/(login|logout)\b|\/auth\/|\/(full-)?restore$|\/admin\/persistence\//.test(req.path)) return next();
    return res.status(503).json({
        error: 'READ_ONLY',
        readOnly: true,
        message: `Not stored: the server is in read-only mode (${persistState.readOnlyReason}). Data could not be loaded safely from the cloud database, so changes are refused until it is. Check GET /api/health.`
    });
});

// v1.0001201 strict mode: until the live data was loaded from (or confirmed by) Turso in this process the
// local file is only an unverified cache, so the data API answers 503 for reads too (no silent local data).
// Health, login, restores, the admin persistence routes and the integration status pages stay open.
app.use((req, res, next) => {
    if (!STRICT_REMOTE.on || persistState.remoteLoaded) return next();
    if (req.method === 'OPTIONS' || !req.path.startsWith('/api/')) return next();
    if (/^\/api\/health$|\/(login|logout)\b|\/auth\/|\/(full-)?restore$|\/admin\/persistence\/|\/integrations\/(turso|dropbox)\/status$/.test(req.path)) return next();
    return res.status(503).json({
        error: 'STRICT_NOT_LOADED',
        readOnly: true,
        message: `Not available: strict mode serves only data loaded from the cloud database, and it is not loaded yet (${persistState.readOnlyReason || persistState.hydrate.error || 'hydrate pending'}). Check GET /api/health.`
    });
});

// --- MULTI-TENANT SANDBOX MIDDLEWARE (must run before any /api/v1/* route) ---
// Resolves x-sandbox-owner into req.sandboxDbPath / req.sandboxOwner / req.roles.
// Live mode (no header) is a zero-disk-IO pass-through; roles are evaluated
// downstream by each handler that needs them.
//
// Role pattern (read before adding any new admin-gated handler):
//   - Sandbox mode (x-sandbox-owner set): req.roles is populated from the
//     sandbox user's live-synced roles; `req.roles.includes('admin')` works.
//   - Live mode (no x-sandbox-owner): req.roles is `[]` BY DESIGN. Any new
//     admin-gated endpoint added to server.js MUST use `isAdminUser(req)`
//     (or its own live-DB lookup) — using `req.roles.includes('admin')`
//     directly will silently deny every live caller. This is a hard rule;
//     see `isAdminUser` for the implementation.
app.use((req, res, next) => {
    let apiKeyHeader = String(req.headers['x-api-key'] || '').trim();
    if (!apiKeyHeader && req.headers['authorization']) {
        const authHdr = String(req.headers['authorization']).trim();
        if (authHdr.toLowerCase().startsWith('bearer ')) {
            apiKeyHeader = authHdr.slice(7).trim();
        }
    }
    let username = req.headers['x-user'];
    let sandboxOwner = req.headers['x-sandbox-owner'];
    let keyRec = null;

    // API-key header authentication (ERP Test Tool / machine clients / REST API): when an
    // x-api-key or Authorization: Bearer <key> header is present it resolves to the key's owner user
    // (identity match against the live DB).
    if (apiKeyHeader) {
        keyRec = findApiKeyBySecret(apiKeyHeader, { touch: false });
        if (!keyRec) return res.status(401).json({ error: 'Invalid API key.' });
        username = keyRec.username;
        req.apiKeyRecord = keyRec;

        // By default, API tokens are granted all the linked user's roles within
        // his sandbox only. If allowLive is NOT explicitly true (unset by default), any call
        // to the API routes to the user's personal sandbox, whether the caller
        // requested the sandbox or even if they requested live data.
        if (keyRec.allowLive !== true) {
            sandboxOwner = keyRec.username;
        }
    }

    // A request that asks for a sandbox but carries no identity must never fall through to the live DB.
    if (sandboxOwner && !username && !/\/(login|auth\/)/.test(req.path) && req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required for sandbox requests.' });
    }
    // CX09: a write with no identity at all (no key, no x-user, no sandbox owner) is refused.
    if (!username && !sandboxOwner && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.path.startsWith('/api/v1/') && !/\/(login|change-password)\b|\/auth\//.test(req.path)) {
        return res.status(401).json({ error: 'Authentication required.' });
    }
    req.user = username || null;
    req.roles = [];
    req.sandboxDbPath = null;
    req.sandboxOwner = null;

    if (sandboxOwner && username) {
        const sanitizedOwner = sanitizeUsername(sandboxOwner);
        const sanitizedUser = sanitizeUsername(username);
        const sandboxPath = getSandboxDbPath(sanitizedOwner);
        const isOwner = sanitizedUser === sanitizedOwner;
        const liveDb = readDb(DB_PATH);
        const liveUser = (liveDb.users || []).find(
            u => u.username.toLowerCase() === username.toLowerCase()
        );
        const isAdmin = liveUser && (liveUser.roles || []).includes('admin');

        // Auto-create sandbox file if it doesn't exist (owner, admin, or API key owner accessing own sandbox)
        if (!fs.existsSync(sandboxPath) && liveUser && (isOwner || isAdmin || (keyRec && keyRec.username.toLowerCase() === sanitizedOwner.toLowerCase()))) {
            const stubPath = path.join(__dirname, 'db.stub.json');
            let stubDb = fs.existsSync(stubPath) ? JSON.parse(fs.readFileSync(stubPath, 'utf8')) : {};
            const liveAi = getLiveAiSettings();
            stubDb.settings = [{ id: 'system_settings', aiProvider: liveAi.aiProvider, geminiConfig: liveAi.geminiConfig, openaiConfig: liveAi.openaiConfig, dbSchemaVersion: CURRENT_SCHEMA_VERSION }];
            if (!stubDb.modules) stubDb.modules = [];
            if (!stubDb.orders) stubDb.orders = [];
            if (!stubDb.customers) stubDb.customers = [];
            if (!stubDb.inventory) stubDb.inventory = [];
            if (!stubDb.notifications) stubDb.notifications = [];
            if (!stubDb.contracts) stubDb.contracts = [];
            if (!stubDb.supplierPayments) stubDb.supplierPayments = [];
            if (!stubDb.suppliers) stubDb.suppliers = [];
            if (!stubDb.procurement) stubDb.procurement = [];
            stubDb.userGroups = stubDb.userGroups || [
                { id: 'ug_mgmt', name: 'Executive Management', roles: ['admin'], permissions: { canViewFinancials: true, canApproveTechReview: true, canReleaseHub: true, canManageUsers: true } }
            ];
            stubDb.users = [{ ...liveUser, roles: liveUser.roles || [], groupIds: liveUser.groupIds || [] }];
            writeDb(stubDb, sandboxPath);
        }

        if (fs.existsSync(sandboxPath)) {
            const sandboxDb = readDb(sandboxPath);
            let userEntry = (sandboxDb.users || []).find(
                u => u.username.toLowerCase() === username.toLowerCase()
            );

            // Auto-provision user if not in sandbox: owners, admins, and explicitly permitted users
            if (!userEntry && liveUser) {
                userEntry = {
                    ...liveUser,
                    roles: liveUser.roles || [],
                    groupIds: liveUser.groupIds || [],
                    sandboxAccess: false
                };
                sandboxDb.users = sandboxDb.users || [];
                sandboxDb.users.push(userEntry);
                writeDb(sandboxDb, sandboxPath);
                console.log(`[Sandbox] Auto-provisioned user "${username}" into sandbox "${sanitizedOwner}" (Access Default: false)`);
            } else if (userEntry && liveUser) {
                // Ensure live authoritative roles and profile are synced into sandbox
                let changed = false;
                if (JSON.stringify(userEntry.roles || []) !== JSON.stringify(liveUser.roles || [])) {
                    userEntry.roles = liveUser.roles || [];
                    changed = true;
                }
                if (JSON.stringify(userEntry.groupIds || []) !== JSON.stringify(liveUser.groupIds || [])) {
                    userEntry.groupIds = liveUser.groupIds || [];
                    changed = true;
                }
                if (userEntry.name !== liveUser.name) {
                    userEntry.name = liveUser.name;
                    changed = true;
                }
                if (userEntry.email !== liveUser.email) {
                    userEntry.email = liveUser.email;
                    changed = true;
                }
                if (liveUser.password && userEntry.password !== liveUser.password) {
                    userEntry.password = liveUser.password;
                    changed = true;
                }
                if (changed) {
                    writeDb(sandboxDb, sandboxPath);
                }
            }

            const hasAccess = userEntry && (userEntry.sandboxAccess || isOwner || isAdmin || (keyRec && keyRec.username.toLowerCase() === sanitizedOwner.toLowerCase()));

            if (hasAccess) {
                req.sandboxDbPath = sandboxPath;
                req.sandboxOwner = sanitizedOwner;
                req.roles = liveUser ? (liveUser.roles || []) : (userEntry ? (userEntry.roles || []) : (keyRec?.roles || []));
                const snapshotPath = getSandboxLoginSnapshotPath(sanitizedOwner);
                if (!fs.existsSync(snapshotPath)) {
                    saveSandboxLoginSnapshot(sanitizedOwner);
                }
            } else {
                return res.status(403).json({ error: 'ACCESS_REVOKED', message: 'Access to this sandbox has been restricted.' });
            }
        }
    } else if (username) {
        // Live mode: populate req.roles for authenticated API key identities
        const liveDb = readDb(DB_PATH);
        const liveUser = (liveDb.users || []).find(
            u => u.username.toLowerCase() === username.toLowerCase()
        );
        if (keyRec) {
            req.roles = liveUser ? (liveUser.roles || []) : (keyRec.roles || []);
        }
    }
    next();
});

// Crash Logger for debugging frontend blank screens
app.get('/api/log-crash', (req, res) => {
    console.log('\n\nðŸš¨ FRONTEND CRASH ðŸš¨\n', req.query.err, '\n\n');
    res.send('ok');
});
app.use('/uploads', async (req, res, next) => {
    const rawPath = decodeURIComponent(req.path || '').replace(/^\/+/, '');
    if (!rawPath) return res.status(404).json({ error: 'File path required' });

    // v1.0001201 strict: a local file is only a cache of a file confirmed in Dropbox; local-only files are not served.
    let localOnlySeen = false;
    const serveFromDisk = (absPath, relPath) => {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
            if (STRICT_REMOTE.on && !dropboxKnown.has(dropboxRelKey(relPath))) { localOnlySeen = true; return false; }
            res.sendFile(absPath);
            return true;
        }
        return false;
    };
    const notFound = () => {
        if (STRICT_REMOTE.on && localOnlySeen) {
            return res.status(503).json({ error: 'LOCAL_ONLY_FILE', message: `This file exists only on the server's local disk and was not found in Dropbox${dropboxState.reachable === false ? ' (Dropbox is not reachable now)' : ''}. Strict mode serves uploaded files from Dropbox only; an admin can run the Dropbox sync-all.` });
        }
        return res.status(404).json({ error: 'File not found' });
    };

    const serveFromDropbox = async (relPath, localCachePath) => {
        try {
            const db = getDb(req);
            const settings = resolveSettings(db);
            if (isDropboxConfigured(settings)) {
                const stream = await downloadFileStreamFromDropbox({ settings, relativePath: relPath });
                if (stream) {
                    if (STRICT_REMOTE.on) { dropboxKnown.add(dropboxRelKey(relPath)); dropboxState.reachable = true; }
                    const ext = path.extname(localCachePath).toLowerCase();
                    let contentType = 'application/octet-stream';
                    if (ext === '.pdf') contentType = 'application/pdf';
                    else if (ext === '.xlsx') contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                    else if (ext === '.csv') contentType = 'text/csv';
                    else if (ext === '.png') contentType = 'image/png';
                    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
                    else if (ext === '.docx') contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

                    res.setHeader('Content-Type', contentType);
                    try {
                        const cacheDir = path.dirname(localCachePath);
                        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                        const writeCache = fs.createWriteStream(localCachePath);
                        stream.pipe(writeCache);
                    } catch (_) {}
                    stream.pipe(res);
                    return true;
                }
            }
        } catch (dbxErr) {
            console.warn(`[Dropbox] Could not retrieve /uploads/${relPath} from Dropbox:`, dbxErr.message);
        }
        return false;
    };

    // 1. If path explicitly requests a sandbox file (e.g. sandbox/<owner>/<subPath>)
    const sbMatch = rawPath.match(/^sandbox\/([^/]+)\/(.*)$/);
    if (sbMatch) {
        const sbLocalPath = path.join(UPLOADS_BASE, rawPath);
        if (serveFromDisk(sbLocalPath, rawPath)) return;
        if (await serveFromDropbox(rawPath, sbLocalPath)) return;

        // COW Fallback: file was not modified in sandbox, serve baseline original!
        const baselineSubPath = sbMatch[2];
        const baselineLocalPath = path.join(UPLOADS_BASE, baselineSubPath);
        if (serveFromDisk(baselineLocalPath, baselineSubPath)) return;
        if (await serveFromDropbox(baselineSubPath, baselineLocalPath)) return;

        return notFound();
    }

    // 2. If request is from a sandbox user and requests a non-sandbox path, check if sandbox has an amended version
    if (req.sandboxOwner) {
        const sbRelPath = `sandbox/${sanitizeUsername(req.sandboxOwner)}/${rawPath}`;
        const sbLocalPath = path.join(UPLOADS_BASE, sbRelPath);
        if (serveFromDisk(sbLocalPath, sbRelPath)) return;
        if (await serveFromDropbox(sbRelPath, sbLocalPath)) return;
    }

    // 3. Standard live path check
    const localFilePath = path.join(UPLOADS_BASE, rawPath);
    if (serveFromDisk(localFilePath, rawPath)) return;
    if (await serveFromDropbox(rawPath, localFilePath)) return;

    return notFound();
});

app.use(express.static(path.join(__dirname, 'dist'), {
    setHeaders: (res, filepath) => {
        if (path.basename(filepath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        }
    }
}));

// --- HEALTH CHECK HELPER ---
const calculateOrderHealth = (order, settings) => {
    let isOverdue = false;

    // 1. Check Order Level Threshold
    const limitKey = STATUS_TO_THRESHOLD[order.status];
    if (limitKey) {
        const limitHrs = settings[limitKey];
        if (limitHrs > 0) {
            let statusEnteredAt;
            if (order.status === OrderStatus.TECHNICAL_REVIEW) {
                statusEnteredAt = getTechReviewStartTime(order);
            } else {
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
                statusEnteredAt = earliestLog ? new Date(earliestLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
            }
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

// --- BLANKET DRAWDOWN HELPER ---
// drawn = total quantity called off (excess included); remaining = max(0, blanket - drawn);
// excess = max(0, drawn - blanket). Added per blanket item (matched by description) and per order.
const withBlanketDrawdown = (order, orders = []) => {
    if (!order || !order.blanketOrder) return order;
    // R34 round 12 (validator 11, defect 2): the call-offs by the shared link rule (id, internal number or customer reference, trimmed).
    const calls = callOffsOfBlanket(order, orders);
    const key = d => String(d || '').trim().toLowerCase();
    let tb = 0, td = 0;
    const items = (order.items || []).map(it => {
        const blanketQty = Number(it.quantity) || 0;
        let drawn = 0;
        calls.forEach(c => (c.items || []).forEach(ci => { if (key(ci.description) === key(it.description)) drawn += Number(getItemEffectiveQty(ci)) || 0; }));
        tb += blanketQty; td += drawn;
        return { ...it, drawnQty: drawn, remainingQty: Math.max(0, blanketQty - drawn), excessQty: Math.max(0, drawn - blanketQty) };
    });
    return { ...order, items, drawnQty: td, remainingQty: Math.max(0, tb - td), excessQty: Math.max(0, td - tb) };
};

// --- WALLET HELPERS (R30, user ruling 2026-10-21) ---
// A wallet is money actually PAID, gross including VAT: customer payments (x) minus company payments to suppliers (y),
// per project, per PO and per customer. Commitments are not in the wallet; they are shown as Accounts Receivable
// (/api/v1/ar, per customer / PO / project) and Accounts Payable (/api/v1/ap, per supplier / PO / project).
const r2w = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
// R34 (2026-11-08): opening balances are ledger entries of type OPENING (signed delta, whole units) keyed by an account key.
// Sum of the opening deltas booked on one account key (0 when none, so every figure is unchanged without openings).
// Per ledger array a map key -> sum is cached (rebuilt when the array length changes; opening entries are never edited).
const openingCache = new WeakMap();
const openingSumFor = (ledger, key) => {
    if (!Array.isArray(ledger) || ledger.length === 0) return 0;
    let c = openingCache.get(ledger);
    if (!c || c.len !== ledger.length) {
        const m = new Map();
        ledger.forEach(l => { if (l && l.type === 'OPENING' && l.accountKey) m.set(l.accountKey, (m.get(l.accountKey) || 0) + (Number(l.amount) || 0)); });
        c = { len: ledger.length, m };
        openingCache.set(ledger, c);
    }
    return r2w(c.m.get(key) || 0);
};
const orderProjectName = (order, orders = []) => {
    let proj = String((order.projectName || '').trim());
    if (!proj && order.blanketContractId) {
        const parent = blanketRootOf(order, orders); // R34 round 13: the shared link rule (same customer, id > number > reference)
        if (parent && parent.projectName) proj = String(parent.projectName).trim();
    }
    return proj;
};
// R30 (23:00, OS09): wallets and costs are shown in L.E.; a foreign-currency order's customer money (typed in the order currency) is converted at the order rate.
const orderFx = (o) => (o && o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1;
// v1.0001222 (validator 16 G3b): the paid money of a cancel that a reopen could not take back (spent or refunded from the customer
// general wallet; it stays off the order as paymentMovedToWallet) is recorded PER PAYMENT as payment.movedLeftoverLE (L.E.): each
// payment's own share of that left-over. A later void of a payment takes back only its own share (never another payment's share of
// an earlier cancel). An order whose payments carry no share at all is an order of an earlier version (whole left-over, every payment).
// v1.0001223 (validator 17 G3d): once a reopen spread shares, the order is marked (order.movedLeftoverShared, server-owned) and stays
// on the share model for good, also when no payment carries a share any more (e.g. the only share holder was voided): the rule of
// an earlier version (whole left-over, every payment) applies only to an order without any share data.
const hasPaymentShare = (p) => Boolean(p) && p.movedLeftoverLE !== undefined && p.movedLeftoverLE !== null && Number.isFinite(Number(p.movedLeftoverLE));
const hasMovedLeftoverShares = (order) => order.movedLeftoverShared === true || (order.payments || []).some(hasPaymentShare);
// Adds deltaLE to the payments' shares in proportion to what each payment still held on the order for the cancel that moved it: its
// L.E. value minus its share so far minus its part of the R30 surplus (the newest payments are the surplus, already in the general
// wallet). Two-decimal rounding; the cent rest goes to the payment with the largest part. Returns what was spread.
// v1.0001223 (validator 17 G3d): a wallet-transfer row INTO the PO is money that was on the order at the cancel as well, so it holds
// its share like a cash payment (it cannot be voided: its share simply stays off the order). Rows out of the PO (negative) hold none.
// v1.0001223 (validator 17 G3c): opts.holdersOnly (the re-spread of a share a void did not take) spreads only over payments that
// already carry a share (they existed at that cancel); a payment recorded after the reopen never receives one, not even as fallback.
// v1.0001224 (validator 18 G3e): the R30 surplus that sits in the general wallet counts as the NEWEST payments' money (free = payment
// L.E. - its share). The reopen spread takes all payments newest first and marks each of them (payment.movedLeftoverAtSpread,
// server-owned like the share); a later re-spread or a void takes the payments marked at the latest reopen first (newest first) and only
// then the others (a payment recorded after that reopen was never surplus of the order). An order without the mark (earlier version)
// takes the payments that carry a share first. Returns a Map payment -> its slice of surplusLE (L.E.).
function surplusSlicesLE(order, surplusLE, fx, presentFirst) {
    const pays = (order.payments || []).filter(p => p && Number(p.amount) > 0);
    const slices = new Map();
    const atSpread = (p) => p.movedLeftoverAtSpread === true;
    const firstOf = pays.some(atSpread) ? atSpread : hasPaymentShare;
    const groups = presentFirst && pays.some(firstOf) ? [pays.filter(firstOf), pays.filter(p => !firstOf(p))] : [pays];
    let rest = Math.max(0, r2w(surplusLE));
    groups.forEach(g => {
        for (let k = g.length - 1; k >= 0; k--) {
            const free = Math.max(0, r2w(paymentLE(g[k], fx) - (Number(g[k].movedLeftoverLE) || 0)));
            const sl = r2w(Math.min(free, rest));
            rest = r2w(rest - sl);
            slices.set(g[k], sl);
        }
    });
    return slices;
}
function spreadMovedLeftoverLE(order, deltaLE, opts = {}) {
    const d = r2w(deltaLE);
    if (!(d > 0.004)) return 0;
    const fx = orderFx(order);
    const pays = (order.payments || []).filter(p => p && Number(p.amount) > 0);
    if (!pays.length) return 0;
    const holder = pays.map(p => !opts.holdersOnly || hasPaymentShare(p));
    if (!holder.some(Boolean)) return 0;
    const surplusLE = (order.blanketOrder || order.blanketContractId) ? 0
        : ((order.surplusMovedToWalletLE !== undefined && order.surplusMovedToWalletLE !== null) ? Number(order.surplusMovedToWalletLE) || 0 : (Number(order.surplusMovedToWallet) || 0) * fx);
    // v1.0001224 (G3e): the reopen spread takes the surplus newest first over all payments; a re-spread (holdersOnly) over the payments
    // of the latest reopen first, as the void does
    const sliceOf = surplusSlicesLE(order, surplusLE, fx, Boolean(opts.holdersOnly));
    const cap = pays.map((p, k) => holder[k] ? r2w(Math.max(0, r2w(paymentLE(p, fx) - (Number(p.movedLeftoverLE) || 0))) - (sliceOf.get(p) || 0)) : 0);
    let base = cap, baseSum = cap.reduce((t, v) => t + v, 0);
    if (!(baseSum > 0.004)) { base = pays.map((p, k) => holder[k] ? Math.max(0, paymentLE(p, fx)) : 0); baseSum = base.reduce((t, v) => t + v, 0); }
    if (!(baseSum > 0.004)) return 0;
    const part = base.map(v => r2w(d * v / baseSum));
    let big = 0; base.forEach((v, k) => { if (v > base[big]) big = k; });
    part[big] = r2w(part[big] + r2w(d - part.reduce((t, v) => t + v, 0)));
    pays.forEach((p, k) => { if (holder[k] && (part[k] > 0.004 || p.movedLeftoverLE !== undefined)) p.movedLeftoverLE = Math.max(0, r2w((Number(p.movedLeftoverLE) || 0) + part[k])); });
    pays.forEach(p => { delete p.paidBeforeMovedLeftover; });
    // v1.0001224 (G3e): the payments of this reopen (they existed at the cancel) are marked; a payment recorded later never is
    if (!opts.holdersOnly) pays.forEach(p => { p.movedLeftoverAtSpread = true; });
    // v1.0001225 (validator 19 G3f): the surplus the payments of this reopen hold (in the general wallet, stale or covered); a payment
    // recorded later moves its own surplus on top of it, and a void keeps the two apart (cancel-payment surplus step)
    if (!opts.holdersOnly) { order.surplusAtSpread = (order.blanketOrder || order.blanketContractId) ? 0 : r2w(Number(order.surplusMovedToWallet) || 0); order.surplusAtSpreadLE = r2w(surplusLE); }
    order.movedLeftoverShared = true;
    return d;
}
// v1.0001223: the share data of an order whose left-over is gone (nothing off the order any more)
const clearMovedLeftoverShares = (order) => { (order.payments || []).forEach(pp => { if (pp) { delete pp.movedLeftoverLE; delete pp.movedLeftoverAtSpread; } }); delete order.movedLeftoverShared; delete order.surplusAtSpread; delete order.surplusAtSpreadLE; };
// x: money received from the customer on this PO (account transfers in/out of the PO included)
const orderPaidIn = (order) => {
    const paid = r2w((order.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    // v1.0001220 (N1): money moved from the PO to the customer general wallet is counted there only, whatever the status: the surplus
    // above the PO gross (R30, closed blanket overpayment) and the paid money of a cancel (R23 C17) that a reopen could not take back.
    const moved = r2w((Number(order.surplusMovedToWallet) || 0) + (Number(order.paymentMovedToWallet) || 0));
    // a cancelled (rejected) PO keeps no customer money: what was paid moved to the customer general wallet
    if (order.status === OrderStatus.REJECTED) return Math.max(0, r2w(paid - moved));
    return r2w(paid - moved);
};
// y: money the company paid to suppliers for this PO (gross); supplier refunds are negative payments
// v1.0001218: money kept on a delivered supplier PO of a cancelled order (or of a reopened one, keptSupplierPos) is a company cost of the cancelled
// order, not of the customer: it is left out here, so customer and PO wallets read as before the cancel kept it (rejected orders are ignored).
const orderPaidOut = (order, supplierPayments = []) => {
    let y = 0;
    const keptIds = new Set(orderPoComponents(order).filter(x => isKeptDeliveredPo(x.comp)).map(x => x.comp.id));
    (supplierPayments || []).forEach(sp => {
        const allocs = (sp.allocations || []).filter(a => (a.orderId === order.id || (a.orderNumber && a.orderNumber === order.internalOrderNumber)) && !keptIds.has(a.componentId));
        if (allocs.length) allocs.forEach(a => { y += Number(a.amount) || 0; });
    });
    return r2w(y);
};
const orderCommitmentGross = (order) => {
    if (order.blanketOrder && order.contractClosed && order.closedDeliveredGross !== undefined) return r2w(order.closedDeliveredGross);
    let gross = 0, cost = 0;
    (order.items || []).forEach(it => {
        gross += (getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
        (it.components || []).forEach(c => { cost += (c.quantity || 0) * (c.unitCost || 0); });
    });
    // User ruling 2026-10-21 (22:08): the 1% withholding is not part of revenue, AR or AP; it is a separate Tax-tab line (base = NET).
    return r2w(gross > 0 ? gross : cost);
};

// --- CUSTOMER WALLET HELPER ---
// Customer wallet = money held for the customer outside any PO (stored general/project advances) plus the money
// paid on each non-rejected PO (x) minus the money the company paid for it (y), per project and in total.
// Rejected orders are strictly ignored (their paid amount was moved to the general wallet when they were cancelled).
// Company costs linked to neither a PO nor a project (supplier payments left unallocated, tax settlements) have no customer attribute:
// they lower the customer general wallet only when the company has exactly one customer (user wallet model, validator-confirmed).
const unlinkedCompanyCosts = (db) => {
    if (!db) return 0;
    let c = 0;
    // R34 round 3 (item 4): a supplier refund lowers the advance it returns (refundOf), so its own record keeps only the part above
    // all advances; a refund of opening money is opening money (like the isOpening advance) and never changes a customer wallet.
    (db.supplierPayments || []).forEach(sp => { if (!sp.orderId && !sp.poNumber && !sp.isOpening) c += Number(sp.unallocatedAdvance) || 0; });
    (db.ledger || []).forEach(l => { if (l && l.category === 'Tax Settlement' && l.type === 'COST') c += Number(l.amount) || 0; });
    return r2w(c);
};
// R34 round 4 (validator 3, D5): rule G1 also applies when the wallet money is USED. The general wallet a customer can spend
// (pay-from-wallet, refund) is the stored general bucket minus the company costs linked to no PO (only when the company has
// exactly one customer, as in computeCustomerWallet), i.e. the same figure as Finance > Initial Balances '<customer> / General wallet'.
const g1DeductionFor = (db) => (db && (db.customers || []).length === 1) ? unlinkedCompanyCosts(db) : 0;
const availableGeneralWallet = (db, customer) => {
    if (!customer) return 0;
    const stored = Number((customer.walletBalances || {})[SELF_WALLET_KEY]) || 0;
    return r2w(stored - g1DeductionFor(db));
};
const computeCustomerWallet = (customer, orders = [], supplierPayments = [], db = null) => {
    if (!customer) return customer;
    const projectBalances = {};
    Object.entries(customer.walletBalances || {}).forEach(([proj, bal]) => {
        const k = proj.trim();
        projectBalances[k] = r2w((projectBalances[k] || 0) + (Number(bal) || 0));
    });
    orders.filter(o => o.customerName === customer.name).forEach(o => {
        const net = r2w(orderPaidInLE(o) - orderPaidOut(o, supplierPayments) + (db ? openingSumFor(db.ledger, `PO:${o.id}`) : 0));
        if (!net) return;
        const key = orderProjectName(o, orders) || '(No Project)';
        projectBalances[key] = r2w((projectBalances[key] || 0) + net);
    });
    let unlinkedCostsDeducted = 0;
    if (db && (db.customers || []).length === 1) {
        const uc = unlinkedCompanyCosts(db);
        if (uc) { projectBalances['(General Advance / Future Orders)'] = r2w((projectBalances['(General Advance / Future Orders)'] || 0) - uc); unlinkedCostsDeducted = uc; }
    }
    const totalBalance = Object.values(projectBalances).reduce((sum, val) => sum + (Number(val) || 0), 0);
    // R34 round 3 (item 6): the stored general / project advance buckets (money held outside any PO) for the Ledger tab
    // balance sheet; the PO part of the wallet is already in the receivable and the open-order lines there.
    const storedWalletBalance = r2w(Object.values(customer.walletBalances || {}).reduce((sum, val) => sum + (Number(val) || 0), 0));
    return {
        ...customer,
        storedWalletBalance,
        // R34 round 4 (D5): rule G1 deduction applied to the general wallet (company costs linked to no PO); the Ledger tab shows
        // storedWalletBalance - unlinkedCostsDeducted, the same figure as Initial Balances (general + project wallets).
        unlinkedCostsDeducted,
        walletBalance: r2w(totalBalance),
        walletBalances: projectBalances
    };
};

// --- ORDER WALLET HELPER ---
// Wallet of a single PO: x (customer payments) minus y (company payments to suppliers for it). No commitment.
const computeOrderWallet = (order, orders = [], supplierPayments = [], ledger = null) => {
    if (!order) return null;
    const opening = ledger ? openingSumFor(ledger, `PO:${order.id}`) : 0; // R34 opening balance of this PO wallet
    const isCallOff = Boolean(order.blanketContractId) && !order.blanketOrder;
    const x = r2w(orderPaidInLE(order)); // wallet in L.E. (R34 round 5, item 4: exact L.E. of payments entered in L.E.)
    const y = orderPaidOut(order, supplierPayments);
    return {
        orderId: order.id,
        internalOrderNumber: order.internalOrderNumber,
        customerName: order.customerName,
        projectName: orderProjectName(order, orders) || '(No Project)',
        status: order.status,
        blanketOrder: Boolean(order.blanketOrder),
        callOffOf: isCallOff ? order.blanketContractId : undefined,
        paid: x,
        paidOut: y,
        openingBalance: opening,
        walletBalance: r2w(x - y + opening)
    };
};

// --- ACCOUNTS RECEIVABLE / PAYABLE (R30) ---
// AR: what customers still owe, per PO / customer / project. Call-off payments count against their blanket contract.
// computeReceivables (AR) lives in shared/arap.js (R34 round 3: one implementation for the server and the Finance > Ledger tab).
// --- MISSING WITHHOLDING CERTIFICATES (R30) ---
// The customer keeps 1% withholding tax. The certificate must be collected by 30 November of the order year;
// after that deadline an SLA alert is sent (or queued in-app when no recipients/SMTP exist) for each missing item.
const whtDeadlineFor = (order) => { const y = new Date(order.orderDate || order.createdAt || Date.now()).getFullYear(); return `${y}-11-30`; };
const computeMissingWht = (orders = [], today = new Date().toISOString().slice(0, 10)) => {
    const items = [];
    orders.forEach(o => {
        if (!o.appliesWithholdingTax || o.whtCertificateFile || o.status === OrderStatus.REJECTED || (o.blanketOrder && !o.blanketContractId && false)) return;
        const amount = orderWhtAmount(o);
        if (!(amount > 0)) return;
        const deadline = whtDeadlineFor(o);
        items.push({ orderId: o.id, internalOrderNumber: o.internalOrderNumber, customerName: o.customerName, amount, date: (o.orderDate || o.createdAt || '').toString().slice(0, 10), deadline, overdue: today > deadline });
    });
    return { total: r2w(items.reduce((s, r) => s + r.amount, 0)), overdueCount: items.filter(i => i.overdue).length, items };
};
// AP: what the company still owes suppliers (gross), per supplier / PO / project.
// computePayables (AP) lives in shared/arap.js (R34 round 3: one implementation for the server and the Finance > Ledger tab).

// --- TECHNICAL REVIEW TOUCH RULE ---
// A PO is LOGGED as soon as it is entered; the moment a technical-review user (a member of a
// group with canApproveTechReview, other than a plain admin) touches it, it moves to TECHNICAL_REVIEW.
const isTechReviewUser = (username, db) => {
    const u = (db.users || []).find(x => String(x.username || '').toLowerCase() === String(username || '').toLowerCase());
    if (!u || (u.roles || []).includes('admin')) return false;
    return (db.userGroups || []).some(g => (u.groupIds || []).includes(g.id) && g.permissions && g.permissions.canApproveTechReview);
};
const touchByTechReview = (order, username, db, how) => {
    if (!order || order.status !== OrderStatus.LOGGED || !isTechReviewUser(username, db)) return false;
    order.status = OrderStatus.TECHNICAL_REVIEW;
    if (!order.logs) order.logs = [];
    order.logs.push(createAuditLog(`Technical review user ${username} ${how}: status moved from LOGGED to TECHNICAL_REVIEW`, OrderStatus.TECHNICAL_REVIEW, username));
    return true;
};

// --- GENERIC CRUD ---
// User ruling 2026-10-21 (OS04 steps 19/20): an outsourcing component waits in WAITING_CONTRACT_START until its contract start date arrives, then it is RECEIVED.
// Persisted sweep: runs on every order read and in the 60 s threshold audit (live DB). Receipts booked earlier are untouched. A sandbox may move "today" with the x-sandbox-today header (YYYY-MM-DD).
const sweepContractStarts = (db, todayStr) => {
    let changed = false;
    (db.orders || []).forEach(o => {
        if (o.status === OrderStatus.REJECTED) return;
        (o.items || []).forEach(it => (it.components || []).forEach(c => {
            if (c.status !== 'WAITING_CONTRACT_START' || !c.contractStartDate) return;
            const d = String(c.contractStartDate).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayStr) return;
            c.status = 'RUNNING_CONTRACT';
            c.statusUpdatedAt = new Date().toISOString();
            (o.logs = o.logs || []).push(createAuditLog(`Contract start date ${d} reached: ${c.description || c.id} (Contract: ${c.contractNumber || c.componentNumber || 'N/A'}) is now RUNNING_CONTRACT.`, o.status, { name: 'System', username: 'system' }));
            changed = true;
        }));
    });
    return changed;
};

const getCollection = (col) => (req, res) => {
    const db = getDb(req);
    if (col === 'users') return res.json((db[col] || []).map(({ password, ...u }) => u));

    if (col === 'inventory') {
        // R30 ruling 19:06: incoming = ordered from a supplier (PO issued) and not yet received, per warehouse item
        const incMap = new Map();
        (db.orders || []).forEach(o => {
            if (isStockOrder(o) && false) return;
            if ([OrderStatus.REJECTED, OrderStatus.FULFILLED].includes(o.status)) return;
            (o.items || []).forEach(it => {
                if (it.productionType === 'OUTSOURCING') return;
                (it.components || []).forEach(c => {
                    if (c.source !== 'PROCUREMENT' || !['ORDERED', 'ORDERED_FOR_STOCK', 'PARTIALLY_RECEIVED'].includes(c.status)) return;
                    const left = (Number(c.quantity) || 0) - (Number(c.receivedQty) || 0);
                    if (left <= 0) return;
                    const key = String(c.description || '').trim().toLowerCase();
                    incMap.set(key, (incMap.get(key) || 0) + left);
                });
            });
        });
        return res.json((db[col] || []).map(i => ({ ...i, quantityIncoming: incMap.get(String(i.description || '').trim().toLowerCase()) || 0 })));
    }

    if (col === 'customers') {
        const orders = db.orders || [];
        return res.json((db[col] || []).map(c => computeCustomerWallet(c, orders, db.supplierPayments || [], db)));
    }

    if (col === 'orders') {
        const settings = resolveSettings(db, isSandbox(req));
        const allOrders = db[col] || [];
        { const hd = String(req.headers['x-sandbox-today'] || '').slice(0, 10); const today = (isSandbox(req) && /^\d{4}-\d{2}-\d{2}$/.test(hd)) ? hd : new Date().toISOString().slice(0, 10);
          if (sweepContractStarts(db, today)) { try { writeDb(db, getDbPath(req)); } catch (e) { console.error('[sweep]', e.message); } } }
        return res.json(allOrders.map(o => withBlanketDrawdown(calculateOrderHealth(o, settings), allOrders)));
    }

    // Decrypt sensitive settings before sending to frontend (inheriting live AI settings in sandboxes)
    if (col === 'settings') {
        const settingsList = db[col] || [];
        const resolved = resolveSettings(db, isSandbox(req));
        if (settingsList.length === 0) {
            return res.json([resolved]);
        }
        return res.json(settingsList.map(s => {
            const dec = decryptSettings(s);
            const liveAi = isSandbox(req) ? getLiveAiSettings() : null;
            return {
                ...resolved,
                ...dec,
                aiProvider: liveAi ? liveAi.aiProvider : (dec.aiProvider || resolved.aiProvider),
                geminiConfig: liveAi ? liveAi.geminiConfig : (dec.geminiConfig || resolved.geminiConfig),
                openaiConfig: liveAi ? liveAi.openaiConfig : (dec.openaiConfig || resolved.openaiConfig),
                storageBackend: resolved.storageBackend,
                dropboxConfig: resolved.dropboxConfig
            };
        }));
    }

    res.json(db[col] || []);
};

const getItemFromCollection = (col) => (req, res) => {
    const db = getDb(req);
    const item = (db[col] || []).find(it => it.id === req.params.id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (col === 'users') {
        const { password, ...safe } = item;
        return res.json(safe);
    }
    if (col === 'customers') {
        return res.json(computeCustomerWallet(item, db.orders || [], db.supplierPayments || [], db));
    }
    if (col === 'orders') {
        if (touchByTechReview(item, req.headers['x-user'], db, 'opened the order')) writeDb(db, getDbPath(req));
        const settings = resolveSettings(db, isSandbox(req));
        return res.json(withBlanketDrawdown(calculateOrderHealth(item, settings), db.orders || []));
    }
    if (col === 'settings') {
        const resolved = resolveSettings(db, isSandbox(req));
        let dec = item ? decryptSettings(item) : resolved;
        const liveAi = isSandbox(req) ? getLiveAiSettings() : null;
        return res.json({
            ...resolved,
            ...dec,
            aiProvider: liveAi ? liveAi.aiProvider : (dec.aiProvider || resolved.aiProvider),
            geminiConfig: liveAi ? liveAi.geminiConfig : (dec.geminiConfig || resolved.geminiConfig),
            openaiConfig: liveAi ? liveAi.openaiConfig : (dec.openaiConfig || resolved.openaiConfig),
            storageBackend: resolved.storageBackend,
            dropboxConfig: resolved.dropboxConfig
        });
    }
    res.json(item);
};

const validateOrderItems = (items, customerName, customerPoNumber = '') => {
    if (!Array.isArray(items)) return 'Order items must be an array';
    const isInternalStock = isStockOrder({ customerName, customerReferenceNumber: customerPoNumber });
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const qty = Number(item.quantity);
        if (!Number.isFinite(qty) || qty <= 0) return `Item ${i + 1} quantity must be a positive number`;
        const rawPrice = item.pricePerUnit ?? item.unitPrice ?? item.price;
        const price = Number(rawPrice);
        if (!Number.isFinite(price) || (isInternalStock ? price < 0 : price <= 0)) {
            return isInternalStock ? `Item ${i + 1} unit price cannot be negative` : `Item ${i + 1} unit price must be a positive number`;
        }
        if (!item.unit || String(item.unit).trim() === '') return `Item ${i + 1} unit is required`;
        const components = item.components || [];
        for (let j = 0; j < components.length; j++) {
            const comp = components[j];
            const cQty = Number(comp.quantity);
            if (!Number.isFinite(cQty) || cQty <= 0) return `Item ${i + 1} component ${j + 1} quantity must be a positive number`;
            const cost = Number(comp.unitCost);
            if (!Number.isFinite(cost) || cost <= 0) return `Item ${i + 1} component ${j + 1} unit cost must be a positive number`;
            if (!comp.unit || String(comp.unit).trim() === '') return `Item ${i + 1} component ${j + 1} unit is required`;
        }
    }
    return null;
};

// R30 (23:00): units cannot be partitioned: every quantity is a whole number, blanket orders and call-offs included.
// v1.0001218: every supplier PO component of an order, including the delivered POs a cancelled order kept and that a later reopen
// moved off the order lines (order.keptSupplierPos): the supplier still delivered them, so the supplier ledger, AP and payment
// allocation keep reading them. Returns [{ item, comp }] (item is null for a kept PO moved off the lines).
const orderPoComponents = (order) => {
    const out = [];
    ((order && order.items) || []).forEach(item => (item.components || []).forEach(comp => out.push({ item, comp })));
    ((order && order.keptSupplierPos) || []).forEach(comp => out.push({ item: null, comp }));
    return out;
};
// v1.0001218: a supplier PO component that an order cancel kept because the supplier delivered on it (amended to the delivered quantity,
// or kept as issued when everything was delivered). Older cancels (v1.0001217) only set lastAction.
const isKeptDeliveredPo = (comp) => Boolean(comp && comp.poNumber && (comp.keptOnOrderCancel || comp.lastAction === 'KEPT_ON_ORDER_CANCEL') && !['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(String(comp.status || '').toUpperCase()));
// gross value of a supplier PO component = what the supplier ledger commits for it (net x (1 + tax), quantity + quantity allocated away)
const supplierPoGrossValue = (comp) => {
    const mul = 1 + ((comp.taxPercent !== undefined && comp.taxPercent !== null ? Number(comp.taxPercent) : 14) / 100);
    return Math.round(((Number(comp.quantity) || 0) + (Number(comp.allocatedQty) || 0)) * (Number(comp.unitCost) || 0) * mul * 100) / 100;
};
function releaseSupplierAllocationsOfOrder(db, order) {
    // Cancel / reopen voids the order's POs: what was allocated to them returns to the supplier general wallet (unallocated advance, no refund).
    // v1.0001218: returns what was released ([{ sp, alloc }], payment order) so reattachKeptSupplierAllocations can put back the part a kept PO still covers.
    const ids = new Set(), compById = {};
    orderPoComponents(order).forEach(({ comp: c }) => { if (c.id) { ids.add(c.id); compById[c.id] = c; } });
    const released = [];
    (db.supplierPayments || []).forEach(sp => {
        const mine = (sp.allocations || []).filter(x => ids.has(x.componentId));
        if (!mine.length) return;
        const back = mine.reduce((t, x) => t + (Number(x.amount) || 0), 0);
        sp.allocations = sp.allocations.filter(x => !ids.has(x.componentId));
        sp.unallocatedAdvance = Math.round(((Number(sp.unallocatedAdvance) || 0) + back) * 100) / 100;
        // v1.0001219: the PO (supplier + PO number) each released allocation sat on is captured here, before the cancel / reopen changes the components.
        mine.forEach(alloc => { const c = compById[alloc.componentId]; released.push({ sp, alloc, poKey: supplierPoKey(c, sp) }); });
    });
    return released;
}
// v1.0001218 (wallet model: supplier PO wallet = money paid to that supplier PO, up to the PO price; the excess is the supplier general wallet):
// after a cancel / reopen, money released from a supplier PO that the order KEPT (the supplier delivered on it) goes back onto that PO up to
// the kept PO's gross value; only the part above it stays in the supplier general wallet (unallocated advance). Same payment records, oldest first.
// v1.0001219 (validator pass 4, gap 1): the cap is per supplier PO (same supplier + PO number), not per component: money released from ANY
// component of a PO (a cancelled sibling included) may go back onto ANY kept component of that same PO, up to the total kept value of the PO
// (the same component first, then its kept siblings in order), oldest payment first; the excess stays in the supplier general wallet.
// Example: PO = CNC 10 x 96 + powder 5 x 120 (14 %), 1000 paid, CNC 4/10 and powder 2/5 delivered, cancel -> 437.76 + 273.60 = 711.36 on the PO,
// 288.64 in the supplier general wallet.
function supplierPoKey(comp, sp) {
    if (!comp || !comp.poNumber) return null;
    const sup = comp.supplierId || (sp && sp.supplierId) || comp.supplierName || '';
    return `${sup}|${String(comp.poNumber).trim()}`;
}
function reattachKeptSupplierAllocations(db, order, released) {
    const keptByPo = {};
    orderPoComponents(order).forEach(({ comp }) => {
        if (!comp.id || !isKeptDeliveredPo(comp)) return;
        const key = supplierPoKey(comp);
        if (!key) return;
        (keptByPo[key] = keptByPo[key] || []).push({ comp, capLeft: supplierPoGrossValue(comp) });
    });
    const dateOf = (sp) => { const t = Date.parse(sp && sp.date); return Number.isFinite(t) ? t : 0; };
    const ordered = (released || []).map((r, i) => ({ ...r, i })).sort((a, b) => (dateOf(a.sp) - dateOf(b.sp)) || (a.i - b.i));
    ordered.forEach(({ sp, alloc, poKey }) => {
        const kept = poKey && keptByPo[poKey];
        if (!kept) return;
        // a payment to one supplier never lands on another supplier's PO
        if (sp.supplierId && kept[0].comp.supplierId && sp.supplierId !== kept[0].comp.supplierId) return;
        let left = Math.round(Math.min(Number(alloc.amount) || 0, Number(sp.unallocatedAdvance) || 0) * 100) / 100;
        const targets = kept.filter(k => k.comp.id === alloc.componentId).concat(kept.filter(k => k.comp.id !== alloc.componentId));
        targets.forEach(k => {
            if (!(left > 0.004) || !(k.capLeft > 0.004)) return;
            const take = Math.round(Math.min(left, k.capLeft) * 100) / 100;
            if (!(take > 0.004)) return;
            const row = k.comp.id === alloc.componentId ? { ...alloc, amount: take } : { ...alloc, componentId: k.comp.id, itemDescription: k.comp.description || alloc.itemDescription, amount: take, movedFromComponentId: alloc.componentId };
            // one allocation row per payment and component (merge when the same payment already covers that component)
            const same = (sp.allocations || []).find(x => x.componentId === row.componentId && x.orderId === row.orderId);
            if (same) same.amount = Math.round(((Number(same.amount) || 0) + take) * 100) / 100;
            else sp.allocations = (sp.allocations || []).concat([row]);
            sp.unallocatedAdvance = Math.round(((Number(sp.unallocatedAdvance) || 0) - take) * 100) / 100;
            k.capLeft = Math.round((k.capLeft - take) * 100) / 100;
            left = Math.round((left - take) * 100) / 100;
        });
    });
}
const firstFraction = (vals) => (vals || []).map(Number).find(q => Number.isFinite(q) && Math.abs(q - Math.round(q)) > 1e-9);
const orderFraction = (o) => {
    const q = [];
    (o.items || []).forEach(i => { if (i && i.quantity !== undefined) q.push(i.quantity); (i && i.components || []).forEach(c => c && c.quantity !== undefined && q.push(c.quantity)); });
    return firstFraction(q);
};
const addToCollection = (col) => (req, res) => {
    { const gm = genericMoneyWriteGate(req, col, null, req.body); if (gm) return res.status(403).json({ error: gm }); }
    { const sr = systemMoneyRowRefusal(col, null, req.body); if (sr) return res.status(400).json({ error: sr }); }
    const db = getDb(req);
    if (!db[col]) db[col] = [];
    if (col === 'orders') { const fq_ = orderFraction(req.body || {}); if (fq_ !== undefined) return res.status(400).json({ error: `Rejected: fraction ${fq_} is not allowed (whole units only).` }); }
    // R34 round 10 (validator 9, defect 2): a blanket contract is closed only by the finance close action; the generic create cannot
    // make an order that is already closed (no settlement would have run).
    if (col === 'orders' && req.body && ((req.body.contractClosed !== undefined && Boolean(req.body.contractClosed) && req.body.contractClosed !== 'false') || (req.body.closedDeliveredGross !== undefined && req.body.closedDeliveredGross !== null && req.body.closedDeliveredGross !== ''))) {
        return res.status(400).json({ error: 'Refused: a blanket contract is closed only by the finance close action (close-blanket-order); the generic order create cannot set contractClosed or closedDeliveredGross.' });
    }

    let newItem = { id: `${col}_${Date.now()}`, ...req.body };
    if (col === 'orders') delete newItem.keptSupplierPos; // v1.0001218: server-owned (reopen of a cancelled order)
    if (col === 'orders') delete newItem.movedLeftoverShared; // v1.0001223: server-owned share-model marker (validator 17 G3d)
    if (col === 'orders') { delete newItem.surplusAtSpread; delete newItem.surplusAtSpreadLE; } // v1.0001225: server-owned (validator 19 G3f)
    const user = req.headers['x-user'] || 'System';

    // CX16: two records created in the same millisecond must never share an id.
    if (!req.body.id) { let n_ = 0; const base_ = newItem.id; while (db[col].some(x => x.id === newItem.id)) newItem.id = `${base_}_${++n_}`; }
    // CX16: a customer or supplier name is unique (case and surrounding/inner spaces ignored).
    if ((col === 'customers' || col === 'suppliers') && typeof req.body.name === 'string') {
        const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const nn = normName(req.body.name);
        if (!nn) return res.status(400).json({ error: 'Refused: name is required' });
        if ((db[col] || []).some(x => normName(x.name) === nn)) {
            return res.status(400).json({ error: `Refused: duplicate name already exists ("${String(req.body.name).trim()}")` });
        }
    }

    if (col === 'orders' && req.body.orderDate !== undefined && req.body.orderDate !== null && req.body.orderDate !== '' && isNaN(new Date(req.body.orderDate).getTime())) {
        return res.status(400).json({ error: 'Invalid orderDate.' });
    }
    // R34 round 13 (validator 12, defect 4): a status sent with the create is stored only as an OrderStatus value (normalised spelling);
    // an unknown value is refused. No status (or an empty one) starts the order as LOGGED, as before.
    if (col === 'orders' && req.body.status !== undefined && req.body.status !== null && req.body.status !== '') {
        const canonP = canonicalOrderStatus(req.body.status);
        if (!canonP || !ORDER_STATUS_VALUES.includes(canonP)) return res.status(400).json({ error: `Refused: "${String(req.body.status)}" is not an order status; the status must be one of ${ORDER_STATUS_VALUES.join(', ')}.` });
        newItem.status = canonP;
    }
    if (col === 'orders') {
        const itemValidationError = validateOrderItems(req.body.items, req.body.customerName, req.body.customerReferenceNumber || req.body.customerPoNumber);
        if (itemValidationError) {
            return res.status(400).json({ error: itemValidationError });
        }

        // Pre-generate internal order number so uniqueness can be validated before processing
        if (!newItem.internalOrderNumber) {
            newItem.internalOrderNumber = generateInternalOrderNumber(db);
        }

        // Validate combined PO reference + customer name uniqueness (ignore REJECTED orders)
        const poRef = String(newItem.customerReferenceNumber || '').trim();
        const custName = String(newItem.customerName || '').trim();
        if (custName) {
            const poRefLower = poRef.toLowerCase();
            const custNameLower = custName.toLowerCase();
            const isDuplicate = db[col].some(o =>
                o.status !== 'REJECTED' &&
                String(o.customerReferenceNumber || '').trim().toLowerCase() === poRefLower &&
                String(o.customerName || '').trim().toLowerCase() === custNameLower
            );
            if (isDuplicate) {
                const displayRef = poRef || '(empty)';
                return res.status(400).json({ error: `Duplicate PO reference "${displayRef}" already exists for customer "${custName}".` });
            }
        }

        // Validate internal order number uniqueness
        const internalLower = String(newItem.internalOrderNumber || '').trim().toLowerCase();
        const isDuplicateInternal = db[col].some(o =>
            String(o.internalOrderNumber || '').trim().toLowerCase() === internalLower
        );
        if (isDuplicateInternal) {
            return res.status(400).json({ error: `Duplicate Internal PO reference "${newItem.internalOrderNumber}" already exists.` });
        }
    }

    if (col === 'users' && !isAdminUser(req)) {
        return res.status(403).json({ error: "Admin privileges are required to create users." });
    }
    if (col === 'users' && newItem.password) newItem.password = hashPassword(newItem.password);

    if (col === 'orders') {
        // Blanket contract settling: any order submitted with a blanketContractId
        // is automatically a settling order for that blanket contract. This links
        // the settling order to the contract ID (same as the blanket order's id or
        // internal order number) and makes it appear in Finance Operations.
        if (newItem.blanketContractId) {
            newItem.isSettlingOrder = true;
            newItem.blanketContractId = String(newItem.blanketContractId).trim();
            const blanketRef = newItem.blanketContractId;
            // R34 round 13 (validator 12, defects 1 and 5): the shared link rule (shared/orderMoney.js resolveBlanketLink): only a live
            // blanket contract of the SAME customer, by id, then internal number, then customer reference; a cancelled (REJECTED)
            // contract, another customer's contract or a normal order is refused with the reason.
            const linkP = resolveBlanketLink(blanketRef, db.orders || [], newItem.customerName, newItem.id);
            const blanket = linkP.root;
            if (!blanket) return res.status(400).json({ error: blanketLinkRefusal(blanketRef, linkP, newItem.customerName) });
            // R34 round 7 (validator 6, defect 1): a closed blanket contract is settled; no new call-off may be raised on it.
            if (blanket.contractClosed) {
                return res.status(400).json({ error: `Blanket contract "${blanket.internalOrderNumber || blanketRef}" is closed; no new call-off can be raised on it.` });
            }
            newItem.logs = newItem.logs || [];
            newItem.logs.push(createAuditLog(`Settling order linked to blanket contract ${blanket.internalOrderNumber || blanketRef}. Finance will receive this order automatically.`, OrderStatus.LOGGED, user));
        }
        newItem = processedOrderInternal(newItem, db, user, true, null);
        // R34 round 13 (validator 12, defect 1): a new order never moves an existing call-off to another contract (e.g. a new contract
        // whose internal number equals the customer reference another call-off is linked by).
        { const sh = blanketLinkShiftRefusal(blanketLinkMap(db.orders || []), [...(db.orders || []), newItem], newItem.id, true); if (sh) return res.status(400).json({ error: sh }); }
        reconcileInventory(null, newItem, db);
    }

    if (['customers', 'suppliers', 'inventory', 'users', 'userGroups', 'settings'].includes(col)) {
        if (!newItem.logs) newItem.logs = [createAuditLog('Entity registered', undefined, user)];
        if (col === 'suppliers' && !newItem.priceList) newItem.priceList = [];
    }
    // R34 round 9 (validator 8, defect 3): a new customer starts with EMPTY wallets, the same rule as the generic PUT: wallet figures in
    // the request are never stored (no money arrived); opening money is entered only through Finance > Initial Balances (audited,
    // double confirmed). A zero / empty figure (the CRM form sends walletBalance 0) is dropped silently, any other value is logged.
    if (col === 'customers') {
        const sentW = ['walletBalances', 'walletBalance', 'unlinkedCostsDeducted', 'storedWalletBalance'].filter(f => newItem[f] !== undefined);
        const realW = sentW.filter(f => !sameMoneyValue(newItem[f], undefined));
        sentW.forEach(f => delete newItem[f]);
        if (realW.length) {
            newItem.logs = Array.isArray(newItem.logs) ? newItem.logs : [];
            newItem.logs.push(createAuditLog(`Customer created: wallet figures in the request were ignored (${realW.join(', ')}; wallets change only through money actions, opening money through Finance > Initial Balances)`, undefined, user));
        }
    }

    if (col === 'ledger') {
        // If an addition entry is assigned to a specific PO, reflect it into the order's payments
        if (newItem.type === 'ADDITION' && (newItem.orderId || newItem.poNumber)) {
            // R34 round 13 (validator 12, defect 1): the PO is found in a fixed priority - orderId, then internal number (unique), then
            // customer reference. A customer reference is per customer: when the entry names a customer only that customer's orders
            // count, and a reference shared by orders of several customers without a customer name is refused (the money must not
            // land on another customer's order).
            const poKeyL = newItem.poNumber ? String(newItem.poNumber).trim().toLowerCase() : '';
            // R34 round 14 (validator 13, low): when the entry names a customer, the order it names by orderId or internal number
            // must be that customer's order too (the same rule as the reference lookup). The named customer's own orders are
            // searched (id > internal number > reference); an orderId or internal number that matches only ANOTHER customer's
            // order is refused (400), so the money never lands on another customer's order under this customer's name.
            const entryCust = trimRef(newItem.customerName);
            const ofEntryCust = (o) => !entryCust || sameCustomerName(o.customerName, entryCust);
            const custMismatch = (o, how) => `Refused: order ${o.internalOrderNumber || o.id} (named by ${how}) belongs to customer "${trimRef(o.customerName)}", but the ledger entry names customer "${entryCust}"; a payment is booked only on an order of the customer the entry names - correct the customer name or the order.`;
            let targetOrder = (newItem.orderId && (db.orders || []).find(o => o.id === newItem.orderId)) || null;
            if (targetOrder && !ofEntryCust(targetOrder)) return res.status(400).json({ error: custMismatch(targetOrder, `order id "${newItem.orderId}"`) });
            if (!targetOrder && poKeyL) targetOrder = (db.orders || []).find(o => String(o.internalOrderNumber || '').trim().toLowerCase() === poKeyL && ofEntryCust(o)) || null;
            if (!targetOrder && poKeyL) {
                const byRef = (db.orders || []).filter(o => String(o.customerReferenceNumber || '').trim().toLowerCase() === poKeyL && (!trimRef(newItem.customerName) || sameCustomerName(o.customerName, newItem.customerName)));
                const live = byRef.filter(o => !isRejectedStatus(o.status));
                const pool = live.length ? live : byRef;
                const custs = new Set(pool.map(o => trimRef(o.customerName).toLowerCase()));
                if (custs.size > 1) return res.status(400).json({ error: `Refused: the customer reference "${String(newItem.poNumber).trim()}" names orders of ${custs.size} customers (${pool.map(o => `${o.internalOrderNumber} / ${o.customerName}`).join(', ')}); name the order by its internal number or give the customer name.` });
                targetOrder = pool[0] || null;
            }
            if (!targetOrder && poKeyL && entryCust) {
                const other = (db.orders || []).find(o => String(o.internalOrderNumber || '').trim().toLowerCase() === poKeyL);
                if (other) return res.status(400).json({ error: custMismatch(other, `internal number "${String(newItem.poNumber).trim()}"`) });
            }

            // R34 round 8 (validator 7, defect 5): no payment into a cancelled (REJECTED) PO, the same rule as record-payment.
            if (targetOrder && targetOrder.status === 'REJECTED') return res.status(400).json({ error: `Refused: order ${targetOrder.internalOrderNumber} is cancelled (REJECTED); no payment can be booked on it - record a customer advance to the general wallet instead.` });
            if (targetOrder) { const cpL = closedCallOffPaymentRefusal(db, targetOrder, Number(newItem.amount) || 0); if (cpL) return res.status(400).json({ error: cpL }); }
            if (targetOrder) {
                // R34 round 3 (validator 2, item 2): the entry is now this order's payment; it carries the order ID so Cash / Bank
                // counts it once (as the order payment), never again as a manual addition.
                newItem.orderId = targetOrder.id;
                if (!newItem.poNumber) newItem.poNumber = targetOrder.internalOrderNumber;
                if (!targetOrder.payments) targetOrder.payments = [];
                const paymentIndex = targetOrder.payments.length + 1;
                const timestamp = Date.now().toString().slice(-4);
                const orderShortId = (targetOrder.internalOrderNumber || targetOrder.id).replace(/[^\w]/g, '').slice(-6);
                const receiptNumber = newItem.receiptNumber || `RCV-${orderShortId}-${String(paymentIndex).padStart(2, '0')}-${timestamp}`;
                // R34 round 4 (validator 3, D1): a ledger entry is in L.E.; the order payment is typed in the ORDER currency, so a
                // foreign-currency PO gets amount / rate (5,000 L.E. on a USD PO at rate 50 = a 100 USD payment; Cash / Bank +5,000 L.E.).
                const fxL = orderFx(targetOrder);
                const paymentAmt = Math.round(((Number(newItem.amount) || 0) / fxL) * 100) / 100;
                if (fxL !== 1) { newItem.orderCurrency = targetOrder.currency; newItem.orderAmount = paymentAmt; newItem.conversionRate = fxL; }
                newItem.receiptNumber = receiptNumber;

                // R34 round 5 (validator 4, item 4): the exact L.E. amount stays on the payment (amountLE); Cash / Bank, AR and the
                // PO wallet use it (5,000 L.E. at rate 47.3 = 105.71 USD on the PO, Cash / Bank exactly 5,000.00 L.E.).
                targetOrder.payments.push({
                    amount: paymentAmt,
                    ...(fxL !== 1 ? { amountLE: Math.round((Number(newItem.amount) || 0) * 100) / 100, conversionRate: fxL } : {}),
                    date: newItem.date || new Date().toISOString(),
                    user: user || 'System',
                    memo: newItem.description || `Ledger Entry Payment (${newItem.toAccount || 'General Ledger'})`,
                    receiptNumber,
                    ledgerEntryId: newItem.id
                });

                if (!targetOrder.history) targetOrder.history = [];
                targetOrder.history.push({
                    timestamp: new Date().toISOString(),
                    message: `Payment from Ledger Entry: ${fxL !== 1 ? `${paymentAmt.toLocaleString()} ${targetOrder.currency} (${(Number(newItem.amount) || 0).toLocaleString()} L.E. at rate ${fxL})` : `${paymentAmt.toLocaleString()} L.E.`} - ${newItem.description || ''}`,
                    status: targetOrder.status,
                    user: user || 'System',
                    type: 'payment',
                    amount: paymentAmt,
                    receiptNumber
                });

                // D1: the same rule as record-payment: money above the PO gross moves to the customer general wallet.
                moveOrderSurplusToGeneralWallet(db, targetOrder, user);

                const settings = resolveSettings(db, isSandbox(req));
                const orderIdx = db.orders.findIndex(o => o.id === targetOrder.id);
                if (orderIdx !== -1) {
                    db.orders[orderIdx] = calculateOrderHealth(targetOrder, settings);
                }
            } else if (newItem.orderId) {
                // R34 round 4 (D2): an orderId that matches no order is kept as typed but flagged; the entry is plain bank money
                // (Cash / Bank counts it as a manual addition), it is no order payment.
                newItem.orderNotFound = true;
            }
        }
    }

    db[col].push(newItem);
    if (writeDb(db, getDbPath(req))) {
        if (col === 'users' || col === 'userGroups') {
            syncAuthoritativeUsersToSandboxes(readDb(DB_PATH));
        }
        res.status(201).json(col === 'users' ? (({ password, ...u }) => u)(newItem) : newItem);
    } else res.status(500).json({ error: "Write failed" });
};

// Orders that have passed Technical Review cannot be edited from Order Management (items/prices).
// Enforced only for callers whose roles are known and are all Order Management roles; other modules keep their own edits.
const ORDER_EDIT_EDITABLE_STATUSES = ['LOGGED', 'NEGATIVE_MARGIN', 'IN_HOLD', 'REJECTED'];
const ORDER_EDIT_LOCKED_REASON = (req, order) => {
    const roles = req.roles || [];
    if (roles.length === 0 || !roles.every(r => r === 'order_management' || r === 'sales')) return null;
    if (!order || ORDER_EDIT_EDITABLE_STATUSES.includes(String(order.status))) return null;
    return 'This order is locked: it has passed Technical Review and can no longer be edited.';
};
// R34 round 13 (validator 12, defect 1): the call-off links before a change (blanketLinkMap) against after it; the first call-off that would
// resolve to another contract (or lose its contract) gives the refusal text, else null. skipSelf leaves out the edited order (its link
// was changed on purpose and checked by the link rule).
const blanketLinkShiftRefusal = (before, afterOrders, selfId, skipSelf) => {
    const after = blanketLinkMap(afterOrders);
    const nameOf = (id) => { const o = id ? afterOrders.find(x => x && x.id === id) : null; return o ? (o.internalOrderNumber || o.id) : 'no contract'; };
    for (const [cid, b] of before) {
        if (skipSelf && cid === selfId) continue;
        if (!after.has(cid)) continue;
        const a = after.get(cid) || '';
        if (a === (b || '')) continue;
        const c = afterOrders.find(x => x && x.id === cid) || {};
        return `Refused: this change would move call-off ${c.internalOrderNumber || cid} (linked by "${trimRef(c.blanketContractId)}") from blanket contract ${b ? nameOf(b) : '(none)'} to ${a ? nameOf(a) : 'no contract'}; a call-off link never moves silently - change the call-off's own link instead (a call-off and its contract must have the same customer).`;
    }
    return null;
};
// R34 round 13 (validator 12, defect 4): the canonical spelling of an order status (trim, upper case, spaces / hyphens -> '_'); null for a
// non-string or empty value. ORDER_STATUS_VALUES is the list the generic order edit accepts.
const ORDER_STATUS_VALUES = Object.values(OrderStatus);
const canonicalOrderStatus = (v) => (typeof v === 'string' && v.trim()) ? v.trim().toUpperCase().replace(/[\s-]+/g, '_') : null;
// R34 round 10 (validator 9, defect 3): helpers for the lines of a call-off of a closed blanket contract.
const closedRootOfCallOff = (o, orders) => { const r = (o && o.blanketContractId) ? blanketRootOf(o, orders || []) : null; return (r && r.contractClosed) ? r : null; };
// R34 round 12 (validator 11, defect 5): the money a closed contract kept at its close pays its call-offs (shared/arap.js
// closedContractCoverage; AR by order shows the covered call-off as 0 owing). A payment on a call-off of a closed contract above what
// it still owes after that coverage is refused (record-payment, a ledger payment naming the PO, a wallet transfer into the PO), so
// the same call-off is never collected twice. The part it still owes (an underpaid close) can be paid as usual. The D1 surplus move
// (moveOrderSurplusToGeneralWallet) never applies to call-offs, so the refusal also covers a call-off that paid itself in full.
const closedCallOffPaymentRefusal = (db, order, amountLE) => {
    // R34 round 13 (validator 12, defect 2): a payment on the CLOSED contract itself is the same settlement money: it is accepted only up
    // to what its call-offs still owe after the close (an underpaid close topped up on the contract); above that it is refused, as on a
    // call-off (the excess would sit above the commitment of a settled PO).
    if (order && order.blanketOrder && !trimRef(order.blanketContractId) && order.contractClosed && order.status !== OrderStatus.REJECTED) {
        const callsP = callOffsOfBlanket(order, db.orders || []);
        const oweP = r2w(callsP.reduce((t, c) => t + orderReceivableLE(c, db.orders || []), 0));
        if (!(Number(amountLE) > oweP + 0.004)) return null;
        return `Refused: blanket contract ${order.internalOrderNumber} is closed; the closed settlement is final and its call-offs still owe ${oweP.toFixed(2)} L.E. - a payment of ${(Number(amountLE) || 0).toFixed(2)} L.E. is above that; record a customer advance to the general wallet instead.`;
    }
    const root = closedRootOfCallOff(order, (db && db.orders) || []);
    if (!root || order.status === OrderStatus.REJECTED) return null;
    const owe = orderReceivableLE(order, db.orders || []);
    if (!(Number(amountLE) > owe + 0.004)) return null;
    const cov = closedContractCoverage(db.orders || []).covered.get(order.id) || 0;
    return `Refused: order ${order.internalOrderNumber} is a call-off of the closed blanket contract ${root.internalOrderNumber}; the closed settlement is final and the call-off still owes ${owe.toFixed(2)} L.E.${cov > 0.004 ? ` (the money the contract kept at its close pays ${cov.toFixed(2)} L.E. of it)` : ''} - a payment of ${(Number(amountLE) || 0).toFixed(2)} L.E. is above that; record a customer advance to the general wallet instead.`;
};
// R34 round 11 (validator 10): the call-offs of a blanket contract (orders whose blanketContractId names it by id, internal number or
// customer reference, as blanketRootOf resolves the link).
// R34 round 12 (validator 11, defects 2 and 4): the shared link rule (callOffsOfBlanket); a REJECTED call-off is no live call-off any
// more (the close and the drawdown skip it too), so it does not block the reject of its open contract.
const blanketCallOffsOf = (o, orders) => callOffsOfBlanket(o, orders || []);
// R34 round 11 (validator 10, defects 1 and 5): rejecting (cancelling) a closed blanket contract, a call-off of a closed contract or an
// open blanket that has call-offs is refused. The close settlement (paid - called-off gross moved to the customer general wallet, the
// call-offs realized sales) is final, and a rejected contract is renamed, so its call-offs would lose their root.
const rejectSettlementRefusal = (o, orders) => {
    if (!o) return null;
    if (o.blanketOrder && !(o.blanketContractId && String(o.blanketContractId).trim())) {
        if (o.contractClosed) return `Refused: blanket contract ${o.internalOrderNumber} is closed; the closed settlement is final - the contract cannot be rejected.`;
        const calls = blanketCallOffsOf(o, orders);
        if (calls.length) return `Refused: blanket contract ${o.internalOrderNumber} has ${calls.length} call-off(s) (${calls.map(x => x.internalOrderNumber).join(', ')}); it cannot be rejected, or the call-offs would lose their contract - close it with the finance close action (close-blanket-order) instead.`;
        return null;
    }
    const root = closedRootOfCallOff(o, orders);
    if (root) return `Refused: order ${o.internalOrderNumber} is a call-off of the closed blanket contract ${root.internalOrderNumber}; the closed settlement is final - the call-off cannot be rejected.`;
    return null;
};
const callOffLinesChange = (oldItems, newItems) => {
    const num = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v))) ? 0 : Number(v);
    const priceOf = (it) => num(it && (it.pricePerUnit ?? it.unitPrice ?? it.price));
    if ((newItems || []).length !== (oldItems || []).length) return `lines ${(oldItems || []).length} -> ${(newItems || []).length}`;
    for (let i = 0; i < newItems.length; i++) {
        const n = newItems[i] || {};
        const o = (oldItems || []).find(x => x && n.id && x.id === n.id) || oldItems[i] || {};
        const lbl = o.description || n.description || `line ${i + 1}`;
        if (getItemEffectiveQty(n) !== getItemEffectiveQty(o)) return `${lbl}: quantity ${getItemEffectiveQty(o)} -> ${getItemEffectiveQty(n)}`;
        if (Math.abs(priceOf(n) - priceOf(o)) > 0.004) return `${lbl}: price ${priceOf(o)} -> ${priceOf(n)}`;
        if (Math.abs(num(n.taxPercent) - num(o.taxPercent)) > 0.004) return `${lbl}: tax ${num(o.taxPercent)}% -> ${num(n.taxPercent)}%`;
    }
    return null;
};
const updateInCollection = (col) => (req, res) => {
    const db = getDb(req);
    if (!db[col]) db[col] = [];
    let index = db[col].findIndex(it => it.id === req.params.id);
    if (index === -1) {
        if (col === 'settings' || col === 'modules') {
            const user = req.headers['x-user'] || 'System';
            let newItem = { id: req.params.id, ...req.body };
            if (col === 'settings') newItem = encryptSettings(newItem);
            db[col].push(newItem);
            if (writeDb(db, getDbPath(req))) return res.json(newItem);
            else return res.status(500).json({ error: "Write failed" });
        }
        return res.status(404).json({ error: "Item not found" });
    }

    const user = req.headers['x-user'] || 'System';
    const oldItem = db[col][index];
    { const gm = genericMoneyWriteGate(req, col, oldItem, req.body); if (gm) return res.status(403).json({ error: gm }); }
    // R34 round 10 (validator 9, defect 5): the id of a ledger row is its key (orders point at it by ledgerEntryId, the system rows are
    // recognised by it); the generic edit sends it only unchanged.
    if (col === 'ledger' && req.body && req.body.id !== undefined && String(req.body.id) !== String(oldItem.id)) {
        return res.status(400).json({ error: `Refused: the id of a ledger row cannot change (stored ${oldItem.id}); the generic ledger edit may send it only unchanged.` });
    }
    { const sr = systemMoneyRowRefusal(col, oldItem, req.body); if (sr) return res.status(400).json({ error: sr }); }
    let updated = { ...oldItem, ...req.body };
    // v1.0001218: the delivered supplier POs a reopened cancelled order kept are server-owned (only reject-order / rollback-to-logged write them).
    if (col === 'orders') { if (oldItem.keptSupplierPos !== undefined) updated.keptSupplierPos = oldItem.keptSupplierPos; else delete updated.keptSupplierPos; }
    // v1.0001223 (validator 17 G3d): the share-model marker is server-owned as well (only rollback-to-logged / cancel-payment write it).
    if (col === 'orders') { if (oldItem.movedLeftoverShared !== undefined) updated.movedLeftoverShared = oldItem.movedLeftoverShared; else delete updated.movedLeftoverShared; }
    // v1.0001225 (validator 19 G3f): the marked payments' surplus of the latest reopen is server-owned too
    if (col === 'orders') ['surplusAtSpread', 'surplusAtSpreadLE'].forEach(k => { if (oldItem[k] !== undefined) updated[k] = oldItem[k]; else delete updated[k]; });
    if (col === 'orders' && req.body.orderDate !== undefined && req.body.orderDate !== null && req.body.orderDate !== '' && isNaN(new Date(req.body.orderDate).getTime())) {
        return res.status(400).json({ error: 'Invalid orderDate.' });
    }

    if (col === 'orders' && req.body.items !== undefined && ORDER_EDIT_LOCKED_REASON(req, oldItem)) {
        return res.status(403).json({ error: ORDER_EDIT_LOCKED_REASON(req, oldItem) });
    }

    if (col === 'orders' && req.body.items !== undefined) {
        const badQ = orderFraction(updated);
        if (badQ !== undefined) return res.status(400).json({ error: `Rejected: fraction ${badQ} is not allowed (whole units only).` });
    }

    if (col === 'users' && !isAdminUser(req)) {
        // Non-admins may only edit their own record and may never change roles (live and sandbox alike).
        const caller = String(req.headers['x-user'] || req.user || '').trim().toLowerCase();
        const isSelf = caller && String(oldItem.username || '').toLowerCase() === caller;
        const rolesChanged = req.body.roles !== undefined && JSON.stringify(req.body.roles) !== JSON.stringify(oldItem.roles);
        if (!isSelf || rolesChanged) {
            return res.status(403).json({ error: "Admin privileges are required to modify users or roles." });
        }
    }
    if (col === 'users' && req.body.password) updated.password = hashPassword(req.body.password);

    // Encrypt sensitive settings before storing with preservation guards for empty fields
    if (col === 'settings') {
        const oldMinMargin = oldItem.minimumMarginPct;
        const newMinMargin = req.body.minimumMarginPct;

        if (newMinMargin !== undefined && Number(newMinMargin) !== Number(oldMinMargin)) {
            reconcileOrdersMarginOnThresholdChange(db, Number(oldMinMargin), Number(newMinMargin), user);
        }

        const merged = { ...oldItem, ...req.body };

        // If update omitted or passed empty API key / passwords / logo, preserve existing values
        if (oldItem.geminiConfig?.apiKey && (!req.body.geminiConfig?.apiKey || req.body.geminiConfig.apiKey === '')) {
            merged.geminiConfig = { ...(merged.geminiConfig || {}), apiKey: oldItem.geminiConfig.apiKey };
        }
        if (oldItem.openaiConfig?.apiKey && (!req.body.openaiConfig?.apiKey || req.body.openaiConfig.apiKey === '')) {
            merged.openaiConfig = { ...(merged.openaiConfig || {}), apiKey: oldItem.openaiConfig.apiKey };
        }
        if (oldItem.emailConfig?.password && (!req.body.emailConfig?.password || req.body.emailConfig.password === '')) {
            merged.emailConfig = { ...(merged.emailConfig || {}), password: oldItem.emailConfig.password };
        }
        if (oldItem.companyLogo && (!req.body.companyLogo || req.body.companyLogo === '')) {
            merged.companyLogo = oldItem.companyLogo;
        }
        if (oldItem.googleDriveConfig?.clientSecret && (!req.body.googleDriveConfig?.clientSecret || req.body.googleDriveConfig.clientSecret === '')) {
            merged.googleDriveConfig = { ...(merged.googleDriveConfig || {}), clientSecret: oldItem.googleDriveConfig.clientSecret };
        }
        if (oldItem.localStorageConfig?.secretKey && (!req.body.localStorageConfig?.secretKey || req.body.localStorageConfig.secretKey === '')) {
            merged.localStorageConfig = { ...(merged.localStorageConfig || {}), secretKey: oldItem.localStorageConfig.secretKey };
        }
        if (oldItem.dropboxConfig?.appSecret && (!req.body.dropboxConfig?.appSecret || req.body.dropboxConfig.appSecret === '' || req.body.dropboxConfig.appSecret.includes('●'))) {
            merged.dropboxConfig = { ...(merged.dropboxConfig || {}), appSecret: oldItem.dropboxConfig.appSecret };
        }
        if (oldItem.dropboxConfig?.refreshToken && (!req.body.dropboxConfig?.refreshToken || req.body.dropboxConfig.refreshToken === '' || req.body.dropboxConfig.refreshToken.includes('●'))) {
            merged.dropboxConfig = { ...(merged.dropboxConfig || {}), refreshToken: oldItem.dropboxConfig.refreshToken };
        }
        if (oldItem.dropboxConfig?.appKey && (!req.body.dropboxConfig?.appKey || req.body.dropboxConfig.appKey === '')) {
            merged.dropboxConfig = { ...(merged.dropboxConfig || {}), appKey: oldItem.dropboxConfig.appKey };
        }
        if (oldItem.dropboxConfig?.connectedAccount && (!req.body.dropboxConfig?.connectedAccount || req.body.dropboxConfig.connectedAccount === '')) {
            merged.dropboxConfig = { ...(merged.dropboxConfig || {}), connectedAccount: oldItem.dropboxConfig.connectedAccount };
        }
        if (oldItem.tursoAuthToken && (!req.body.tursoAuthToken || req.body.tursoAuthToken === '' || req.body.tursoAuthToken.includes('●'))) {
            merged.tursoAuthToken = oldItem.tursoAuthToken;
        }
        if (oldItem.tursoUrl && (!req.body.tursoUrl || req.body.tursoUrl === '')) {
            merged.tursoUrl = oldItem.tursoUrl;
        }
        if (oldItem.useTurso !== undefined && req.body.useTurso === undefined) {
            merged.useTurso = oldItem.useTurso;
        }

        updated = encryptSettings(merged);
    }

    if (col === 'orders') {
        // Validate combined PO reference + customer name uniqueness (ignore REJECTED orders), excluding current order
        const poRef = String(updated.customerReferenceNumber || '').trim();
        const custName = String(updated.customerName || '').trim();
        if (custName) {
            const poRefLower = poRef.toLowerCase();
            const custNameLower = custName.toLowerCase();
            const isDuplicate = db[col].some(o =>
                o.id !== updated.id &&
                o.status !== 'REJECTED' &&
                String(o.customerReferenceNumber || '').trim().toLowerCase() === poRefLower &&
                String(o.customerName || '').trim().toLowerCase() === custNameLower
            );
            if (isDuplicate) {
                const displayRef = poRef || '(empty)';
                return res.status(400).json({ error: `Duplicate PO reference "${displayRef}" already exists for customer "${custName}".` });
            }
        }

        // Validate internal order number uniqueness, excluding current order (skip if empty)
        const internalLower = String(updated.internalOrderNumber || '').trim().toLowerCase();
        if (internalLower) {
            const isDuplicateInternal = db[col].some(o =>
                o.id !== updated.id &&
                String(o.internalOrderNumber || '').trim().toLowerCase() === internalLower
            );
            if (isDuplicateInternal) {
                return res.status(400).json({ error: `Duplicate Internal PO reference "${updated.internalOrderNumber}" already exists.` });
            }
        }

        // R34 round 8 (validator 7, defect 6): linking an order to a blanket contract by PUT follows the POST rule (server.js POST
        // /orders): the contract must exist, be a blanket order and not be closed. Only a NEW link is checked (an unchanged one is not).
        // R34 round 9 (validator 8, defect 5): a call-off of a CLOSED blanket contract is part of the close settlement (the close
        // moved paid - called-off gross to the customer general wallet and the call-off is a realized sale); unlinking it ('' / null)
        // or moving it to another contract would change a final settlement, so it is refused. An unchanged link stays allowed.
        if (req.body.blanketContractId !== undefined && String(oldItem.blanketContractId || '').trim() !== '' && String(req.body.blanketContractId ?? '').trim() !== String(oldItem.blanketContractId).trim()) {
            const rootOld = blanketRootOf(oldItem, db.orders || []);
            if (rootOld && rootOld.contractClosed) return res.status(400).json({ error: `Refused: order ${oldItem.internalOrderNumber} is a call-off of the closed blanket contract ${rootOld.internalOrderNumber}; the closed settlement is final - it cannot be unlinked or moved to another contract.` });
        }
        // R34 round 10: an unchanged link sent with stray spaces keeps the stored reference (the link stays exact).
        if (req.body.blanketContractId !== undefined && req.body.blanketContractId !== null && String(oldItem.blanketContractId || '').trim() !== '' && String(req.body.blanketContractId).trim() === String(oldItem.blanketContractId).trim()) {
            updated.blanketContractId = oldItem.blanketContractId;
        }
        // R34 round 12 (validator 11, defect 1): an unchanged echo (trimmed values equal) of the internal number or the customer
        // reference keeps the STORED value. The guards below compare trimmed values; storing the raw echo (' INT-2024-0001 ') would
        // let it pass as unchanged and still change the stored reference the call-offs are linked by.
        ['internalOrderNumber', 'customerReferenceNumber'].forEach(f => {
            if (req.body[f] === undefined || req.body[f] === null || typeof req.body[f] === 'object') return;
            if (trimRef(req.body[f]) !== trimRef(oldItem[f])) return;
            if (oldItem[f] === undefined) delete updated[f]; else updated[f] = oldItem[f];
        });
        // R34 round 10 (validator 9, defect 2): closing a blanket contract is the finance close action (R27); the generic order edit
        // (any role, admin included) never reopens a closed contract nor closes one, and never changes its closed (called-off) gross:
        // a reopened contract would let the call-offs move or change while the close money already sits in the customer general wallet.
        // The blanket flag of a closed contract, of a blanket that has call-offs and of a call-off of a closed contract is fixed too.
        // An unchanged echo of these fields stays allowed. No reopen path exists.
        {
            const flagOf = (v) => Boolean(v) && v !== 'false';
            const sameNum = (a, b) => (a === undefined || a === null || a === '') ? (b === undefined || b === null || b === '') : (b !== undefined && b !== null && b !== '' && Math.abs(Number(a) - Number(b)) < 0.005);
            const hasCallOffs = Boolean(oldItem.blanketOrder) && blanketCallOffsOf(oldItem, db.orders || []).length > 0; // R34 round 12: shared link rule
            const rootCl = oldItem.blanketContractId ? blanketRootOf(oldItem, db.orders || []) : null;
            const changedB = [];
            if (req.body.contractClosed !== undefined && flagOf(req.body.contractClosed) !== flagOf(oldItem.contractClosed)) changedB.push('contractClosed');
            if (req.body.closedDeliveredGross !== undefined && !sameNum(req.body.closedDeliveredGross, oldItem.closedDeliveredGross)) changedB.push('closedDeliveredGross');
            if (req.body.blanketOrder !== undefined && flagOf(req.body.blanketOrder) !== flagOf(oldItem.blanketOrder) && (oldItem.contractClosed || hasCallOffs || (rootCl && rootCl.contractClosed))) changedB.push('blanketOrder');
            if (changedB.length) {
                const whyB = oldItem.contractClosed ? `blanket contract ${oldItem.internalOrderNumber} is closed (the settlement is final; no reopen)`
                    : (rootCl && rootCl.contractClosed) ? `order ${oldItem.internalOrderNumber} is a call-off of the closed blanket contract ${rootCl.internalOrderNumber} (the settlement is final)`
                    : hasCallOffs ? `blanket contract ${oldItem.internalOrderNumber} has call-offs; a blanket contract is closed only by the finance close action`
                    : `a blanket contract is closed only by the finance close action (close-blanket-order)`;
                return res.status(400).json({ error: `Refused: ${whyB}; the generic order edit cannot change ${changedB.join(', ')}.` });
            }
            // R34 round 11 (validator 10, low): an unchanged echo keeps the stored types (boolean flag, number gross), e.g. 'true' -> true.
            [['contractClosed', 'flag'], ['closedDeliveredGross', 'num'], ['blanketOrder', 'flag']].forEach(([f, kind]) => {
                if (req.body[f] === undefined) return;
                const same = kind === 'flag' ? flagOf(req.body[f]) === flagOf(oldItem[f]) : sameNum(req.body[f], oldItem[f]);
                if (!same) return;
                if (oldItem[f] === undefined) delete updated[f]; else updated[f] = oldItem[f];
            });
        }
        // R34 round 11 (validator 10, defect 2): the status REJECTED is set only by the reject-order action (it renames the PO, moves
        // the paid money to the customer general wallet and releases stock and supplier POs); the generic edit never sets it nor lifts
        // it, so cash and wallets cannot diverge. On a closed blanket contract and on a blanket that has call-offs the generic edit
        // changes neither the status nor the references the call-offs are linked by (internal number; customer reference when a
        // call-off names the contract by it). Unchanged echoes stay allowed.
        {
            const stOld = String(oldItem.status ?? ''), stNew = req.body.status === undefined ? stOld : String(req.body.status ?? '');
            // R34 round 12 (validator 11, defect 3): the REJECTED test is case- and space-insensitive ('rejected', ' REJECTED ').
            const rjN = (v) => trimRef(v).toUpperCase() === OrderStatus.REJECTED;
            if (stNew !== stOld && rjN(stOld) && rjN(stNew)) updated.status = oldItem.status; // an unchanged echo keeps the stored spelling
            else if (stNew !== stOld && (rjN(stOld) || rjN(stNew))) {
                return res.status(400).json({ error: rjN(stOld)
                    ? `Refused: order ${oldItem.internalOrderNumber} is rejected; the generic order edit cannot change its status (${stOld} -> ${stNew}); a rejected order stays rejected.`
                    : `Refused: the generic order edit cannot set the status REJECTED on order ${oldItem.internalOrderNumber}; use the reject-order action (it moves the paid money and releases stock).` });
            }
            // R34 round 13 (validator 12, defect 4): the status is stored only as an OrderStatus value. A spelling of one ('fulfilled',
            // ' FULFILLED', 'delivered', 'in hold', 'Technical-Review') is normalised (trim, upper case, spaces / hyphens -> '_') to the
            // canonical value; anything else ('Cancelled', 'REJECT', '', null, a number) is refused. An unchanged echo of a stored legacy
            // value keeps it. (A rejected order was handled above: its echo keeps 'REJECTED', anything else is refused.)
            let stChanged = stNew !== stOld;
            if (req.body.status !== undefined && !rjN(stOld)) {
                const canonS = canonicalOrderStatus(req.body.status);
                const oldCanon = canonicalOrderStatus(stOld) || stOld;
                if (canonS && (ORDER_STATUS_VALUES.includes(canonS) || canonS === oldCanon)) {
                    updated.status = canonS === oldCanon ? oldItem.status : canonS;
                    stChanged = canonS !== oldCanon;
                } else {
                    return res.status(400).json({ error: `Refused: "${req.body.status === null ? 'null' : String(req.body.status)}" is not an order status; the status must be one of ${ORDER_STATUS_VALUES.join(', ')} (order ${oldItem.internalOrderNumber} keeps ${stOld}).` });
                }
            }
            // v1.0001227: setting the status LOGGED on an order in another status is a rollback to Logged: same role gate as the rollback-to-logged action.
            if (stChanged && updated.status === OrderStatus.LOGGED) { const deniedL = actionRoleDenied(req, 'rollback-to-logged'); if (deniedL) return res.status(403).json({ error: deniedL }); }
            const callsS = blanketCallOffsOf(oldItem, db.orders || []);
            if (oldItem.contractClosed || callsS.length) {
                const whyS = oldItem.contractClosed ? `blanket contract ${oldItem.internalOrderNumber} is closed (the settlement is final)` : `blanket contract ${oldItem.internalOrderNumber} has call-offs`;
                const chS = [];
                if (stChanged) chS.push('status');
                if (req.body.internalOrderNumber !== undefined && String(req.body.internalOrderNumber ?? '').trim() !== String(oldItem.internalOrderNumber ?? '').trim()) chS.push('internalOrderNumber');
                const crefOld = String(oldItem.customerReferenceNumber ?? '').trim();
                if (req.body.customerReferenceNumber !== undefined && String(req.body.customerReferenceNumber ?? '').trim() !== crefOld && crefOld && callsS.some(x => String(x.blanketContractId).trim() === crefOld && crefOld !== String(oldItem.id) && crefOld !== String(oldItem.internalOrderNumber ?? '').trim())) chS.push('customerReferenceNumber');
                if (chS.length) return res.status(400).json({ error: `Refused: ${whyS}; the generic order edit cannot change ${chS.join(', ')}.` });
            }
        }
        if (req.body.blanketContractId !== undefined && req.body.blanketContractId !== null && String(req.body.blanketContractId).trim() !== '' && String(req.body.blanketContractId).trim() !== String(oldItem.blanketContractId || '').trim()) {
            const blanketRefU = String(req.body.blanketContractId).trim();
            // R34 round 13 (validator 12, defects 1 and 5): the shared link rule (same customer, id > number > reference; a cancelled
            // contract, another customer's contract or a normal order is refused with the reason).
            const linkU = resolveBlanketLink(blanketRefU, db.orders || [], updated.customerName, oldItem.id);
            const blanketU = linkU.root;
            if (!blanketU) return res.status(400).json({ error: blanketLinkRefusal(blanketRefU, linkU, updated.customerName) });
            if (blanketU.contractClosed) return res.status(400).json({ error: `Blanket contract "${blanketU.internalOrderNumber || blanketRefU}" is closed; no new call-off can be raised on it.` });
            updated.blanketContractId = blanketRefU;
            updated.isSettlingOrder = true;
        }

        if (Array.isArray(req.body.items)) {
            updated.items = req.body.items.map((it, idx) => {
                const oldIt = (oldItem.items || []).find(oi => oi.id === it.id) || (oldItem.items || [])[idx];
                const rawPrice = it.pricePerUnit ?? it.unitPrice ?? it.price ?? oldIt?.pricePerUnit ?? oldIt?.unitPrice ?? oldIt?.price;
                const price = (rawPrice !== undefined && rawPrice !== null && !isNaN(Number(rawPrice))) ? Number(rawPrice) : 0;
                return {
                    ...it,
                    pricePerUnit: price
                };
            });
        }
        // R34 round 10 (validator 9, defect 3): the lines of a call-off of a CLOSED blanket contract are the called-off value the close
        // settled (paid - called-off gross went to the customer general wallet; the call-off is a realized sale): their quantities,
        // prices and tax cannot change any more, and no line is added or removed. Other fields (notes, ...) stay editable.
        if (Array.isArray(req.body.items)) {
            const rootI = closedRootOfCallOff(oldItem, db.orders || []);
            if (rootI) {
                const diffI = callOffLinesChange(oldItem.items || [], updated.items || []);
                if (diffI) return res.status(400).json({ error: `Refused: order ${oldItem.internalOrderNumber} is a call-off of the closed blanket contract ${rootI.internalOrderNumber}; the closed settlement is final - its line quantities and prices cannot change (${diffI}).` });
            }
        }

        // If order was rolled back to logged and is now updated by the Order Management / Logging team:
        if (oldItem.rolledBackToLogged && (req.body.items || req.body.customerName || req.body.customerReferenceNumber || req.body.orderDate)) {
            delete updated.rolledBackToLogged;
            const nowIso = new Date().toISOString();
            updated.technicalReviewStartedAt = nowIso;
            updated.dataEntryTimestamp = nowIso;
            updated.statusUpdatedAt = nowIso;
            if (!updated.logs) updated.logs = [];
            updated.logs.push(createAuditLog('Order updated by Order Management team after rollback. Technical Review unlocked with new SLA clock.', updated.status, user));
        }

        updated = processedOrderInternal(updated, db, user, false, oldItem);
        // R34 round 13 (validator 12, defect 1): the edit never moves or drops a call-off link silently: no other order's call-off may
        // resolve to another contract after it (a renamed reference, a changed customer or blanket flag), and the edited call-off keeps
        // its contract unless its link itself was changed (that new link was checked by the link rule above).
        {
            const relinked = req.body.blanketContractId !== undefined && trimRef(req.body.blanketContractId) !== trimRef(oldItem.blanketContractId);
            const sh = blanketLinkShiftRefusal(blanketLinkMap(db.orders || []), (db.orders || []).map(o => o.id === oldItem.id ? updated : o), oldItem.id, relinked);
            if (sh) return res.status(400).json({ error: sh });
        }
        reconcileInventory(oldItem, updated, db);
        if (!req.body.status) {
            updated.logs.push(createAuditLog('Order modified', updated.status, user));
        }
    }

    // R34 round 3 (validator 2, item 7): a customer is linked to its orders, contracts and ledger entries by NAME, so a rename
    // carries the new name to all of them (orders, contracts, ledger customerName and the 'Customer <name> / ...' sub-account
    // labels); its receivable, wallets and PO accounts stay with it. A rename onto another customer's name is refused.
    if (col === 'customers') delete updated.storedWalletBalance; // derived read-only figure (computeCustomerWallet), never stored
    // R34 round 8 (validator 7, defect 3): a generic PUT never stores wallet figures. GET returns the COMPUTED wallet (buckets incl.
    // the PO money, G1 deduction), so storing an echo would double the PO money in the buckets. The stored buckets and total change
    // only through the money actions (advance, refund, wallet transfer, pay-from-wallet, PO surplus / cancel, opening balance).
    if (col === 'customers') {
        ['walletBalances', 'walletBalance', 'unlinkedCostsDeducted'].forEach(f => { if (oldItem[f] === undefined) delete updated[f]; else updated[f] = oldItem[f]; });
        if (['walletBalances', 'walletBalance', 'unlinkedCostsDeducted', 'storedWalletBalance'].some(f => req.body[f] !== undefined)) {
            if (!updated.logs) updated.logs = [];
            updated.logs.push(createAuditLog('Profile update: wallet figures in the request were ignored (wallets change only through money actions)', undefined, user));
        }
    }
    if (col === 'customers' && typeof req.body.name === 'string') {
        const normName = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
        const oldName = String(oldItem.name || '');
        const newName = String(req.body.name).trim().replace(/\s+/g, ' ');
        if (!newName) return res.status(400).json({ error: 'Refused: name is required' });
        if ((db.customers || []).some(x => x.id !== oldItem.id && normName(x.name) === normName(newName))) {
            return res.status(400).json({ error: `Refused: duplicate name already exists ("${newName}")` });
        }
        updated.name = newName;
        if (oldName && newName !== oldName) {
            let nOrders = 0, nContracts = 0, nLedger = 0;
            (db.orders || []).forEach(o => { if (o && o.customerName === oldName) { o.customerName = newName; nOrders++; } });
            (db.contracts || []).forEach(k => { if (k && k.customerName === oldName) { k.customerName = newName; nContracts++; } });
            const pre = `Customer ${oldName} / `;
            (db.ledger || []).forEach(e => {
                if (!e) return;
                let hit = false;
                if (e.customerName === oldName) { e.customerName = newName; hit = true; }
                ['fromAccount', 'toAccount', 'account'].forEach(f => { if (typeof e[f] === 'string' && e[f].startsWith(pre)) { e[f] = `Customer ${newName} / ` + e[f].slice(pre.length); hit = true; } });
                if (hit) nLedger++;
            });
            if (!updated.logs) updated.logs = [];
            updated.logs.push(createAuditLog(`Customer renamed from "${oldName}" to "${newName}" (${nOrders} orders, ${nContracts} contracts, ${nLedger} ledger entries follow the new name)`, undefined, user));
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
    if (writeDb(db, getDbPath(req))) {
        if (col === 'users' || col === 'userGroups') {
            syncAuthoritativeUsersToSandboxes(readDb(DB_PATH));
        }
        res.json(col === 'users' ? (({ password, ...u }) => u)(updated) : updated);
    } else res.status(500).json({ error: "Update failed" });
};

const deleteFromCollection = (col) => (req, res) => {
    const db = getDb(req);
    if (!db[col]) return res.status(404).json({ error: "Not found" });

    if (col === 'contracts') {
        const contractId = req.params.id;
        const linkedBlanketOrders = (db.orders || []).filter(order => order.blanketOrder && order.contractId === contractId);
        if (linkedBlanketOrders.length > 0) {
            return res.status(400).json({ error: `Cannot delete contract "${contractId}" because it has ${linkedBlanketOrders.length} linked blanket order${linkedBlanketOrders.length > 1 ? 's' : ''}.` });
        }
    }

    if (col === 'users' && !isAdminUser(req)) {
        return res.status(403).json({ error: "Admin privileges are required to delete users." });
    }
    db[col] = db[col].filter(it => it.id !== req.params.id);
    if (writeDb(db, getDbPath(req))) {
        if (col === 'users' || col === 'userGroups') {
            syncAuthoritativeUsersToSandboxes(readDb(DB_PATH));
        }
        res.json({ message: "Deleted" });
    } else res.status(500).json({ error: "Delete failed" });
};

// --- ROUTES ---
app.get('/api/v1/order-wallets', (req, res) => {
    const db = getDb(req);
    const orders = db.orders || [];
    const { customerName, projectName } = req.query;
    let list = orders.map(o => computeOrderWallet(o, orders, db.supplierPayments || [], db.ledger));
    if (customerName) list = list.filter(w => w.customerName === customerName);
    if (projectName) list = list.filter(w => w.projectName === String(projectName).trim());
    res.json(list);
});

app.get('/api/v1/orders/:id/wallet', (req, res) => {
    const db = getDb(req);
    const orders = db.orders || [];
    const order = orders.find(o => o.id === req.params.id || o.internalOrderNumber === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(computeOrderWallet(order, orders, db.supplierPayments || [], db.ledger));
});

// R30: Accounts Receivable (customers owe us) and Accounts Payable (we owe suppliers); commitments live here, not in the wallets.
app.get('/api/v1/ar', (req, res) => {
    const db = getDb(req);
    const out = computeReceivables(db.orders || [], db.ledger || [], db.customers || []);
    const { customerName, projectName } = req.query;
    if (customerName) { out.byOrder = out.byOrder.filter(r => r.customerName === customerName); out.byCustomer = out.byCustomer.filter(r => r.customerName === customerName); out.byProject = out.byProject.filter(r => r.customerName === customerName); out.total = r2w(out.byOrder.reduce((s, r) => s + r.receivable, 0) + out.byCustomer.reduce((s, r) => s + (r.openingBalance || 0), 0)); }
    if (projectName) {
        out.byOrder = out.byOrder.filter(r => r.projectName === String(projectName).trim()); out.byProject = out.byProject.filter(r => r.projectName === String(projectName).trim()); out.total = r2w(out.byOrder.reduce((s, r) => s + r.receivable, 0));
        // M3: opening receivables belong to a customer, not to a project: they are left out of a project total and named here.
        out.openingExcluded = r2w(out.byCustomer.reduce((s, r) => s + (r.openingBalance || 0), 0));
        out.openingNote = 'Opening receivables (Finance > Initial Balances) are per customer, not per project; they are not in this project total (see byCustomer[].openingBalance).';
    }
    res.json(out);
});
app.get('/api/v1/wht-missing', (req, res) => {
    const db = getDb(req);
    const out = computeMissingWht(db.orders || []);
    // User ruling 2026-10-21 (22:45): the 1% leaves the wallet to the tax-authority account automatically; the Tax view shows it DONE with a certificate, otherwise WAITING_CERTIFICATE.
    out.all = (db.orders || []).filter(o => o.appliesWithholdingTax && o.status !== OrderStatus.REJECTED && orderWhtAmount(o) > 0).map(o => ({ orderId: o.id, internalOrderNumber: o.internalOrderNumber, customerName: o.customerName, amount: orderWhtAmount(o), status: o.whtCertificateFile ? 'DONE' : 'WAITING_CERTIFICATE' }));
    const { customerName } = req.query;
    if (customerName) { out.items = out.items.filter(r => r.customerName === customerName); out.total = r2w(out.items.reduce((a, r) => a + r.amount, 0)); out.overdueCount = out.items.filter(i => i.overdue).length; }
    res.json(out);
});
app.get('/api/v1/ap', (req, res) => {
    const db = getDb(req);
    const out = computePayables(db);
    const { supplierId, projectName } = req.query;
    if (supplierId) { out.byOrderSupplier = out.byOrderSupplier.filter(r => r.supplierId === supplierId); out.bySupplier = out.bySupplier.filter(r => r.supplierId === supplierId); out.total = r2w(out.bySupplier.reduce((s, r) => s + r.payable, 0)); }
    if (projectName) { out.byOrderSupplier = out.byOrderSupplier.filter(r => r.projectName === String(projectName).trim()); out.byProject = out.byProject.filter(r => r.projectName === String(projectName).trim()); out.total = r2w(out.byOrderSupplier.reduce((s, r) => s + r.payable, 0)); }
    res.json(out);
});

app.get('/api/v1/project-wallets', (req, res) => {
    const db = getDb(req);
    const orders = db.orders || [];
    const customers = (db.customers || []).map(c => computeCustomerWallet(c, orders, db.supplierPayments || [], db));
    const projectMap = new Map();

    customers.forEach(c => {
        Object.entries(c.walletBalances || {}).forEach(([pName, bal]) => {
            const trimmed = pName.trim();
            if (!trimmed) return;
            const b = Number(bal) || 0;
            if (!projectMap.has(trimmed)) {
                const projOrders = orders.filter(o => {
                    if (o.status === OrderStatus.REJECTED) return false;
                    const isBlanket = Boolean(o.blanketOrder || o.contractId || o.blanketContractId);
                    let ordProj = String((o.projectName || '').trim());
                    if (!ordProj && o.blanketContractId) {
                        const parent = blanketRootOf(o, orders); // R34 round 13: the shared link rule
                        if (parent && parent.projectName) ordProj = String(parent.projectName).trim();
                    }
                    return ordProj === trimmed;
                });
                projectMap.set(trimmed, {
                    projectName: trimmed,
                    balance: 0,
                    ordersCount: projOrders.length,
                    allocations: []
                });
            }
            const entry = projectMap.get(trimmed);
            entry.balance += b;
            entry.allocations.push({
                customerId: c.id,
                customerName: c.name,
                customerEmail: c.email || '',
                balance: b
            });
        });
    });

    const results = Array.from(projectMap.values())
        .filter(item => item.ordersCount > 0 || item.balance !== 0)
        .sort((a, b) => a.projectName.localeCompare(b.projectName));

    res.json(results);
});

app.get('/api/v1/procurement/history', (req, res) => {
    const { description, partNumber } = req.query;
    if (!description && !partNumber) return res.status(400).json({ error: "Search criteria required" });

    const db = getDb(req);
    const history = [];
    const descLower = (description || '').trim().toLowerCase();
    const pnLower = (partNumber || '').trim().toLowerCase();

    (db.orders || []).forEach(order => {
        if (order.status === OrderStatus.REJECTED) return;
        (order.items || []).forEach(item => {
            (item.components || []).forEach(comp => {
                const compDesc = (comp.description || comp.componentName || '').toLowerCase();
                const compPn = (comp.componentNumber || comp.supplierPartNumber || comp.partNumber || '').toLowerCase();

                const matchDesc = descLower && (compDesc.includes(descLower) || descLower.includes(compDesc));
                const matchPart = pnLower && (compPn.includes(pnLower) || pnLower.includes(compPn));

                if (matchDesc || matchPart) {
                    const supplier = (db.suppliers || []).find(s => s.id === comp.supplierId);
                    history.push({
                        orderId: order.id,
                        orderNumber: order.internalOrderNumber || order.orderNumber || order.id,
                        customerName: order.customerName || 'N/A',
                        customerPo: order.customerPo || '',
                        productName: item.productName || item.description || item.name || '',
                        componentNumber: comp.componentNumber || comp.supplierPartNumber || comp.partNumber || '',
                        description: comp.description || comp.componentName || '',
                        date: comp.statusUpdatedAt || order.orderDate || order.dataEntryTimestamp || new Date().toISOString(),
                        price: comp.unitCost ?? comp.cost ?? 0,
                        quantity: comp.quantity || 1,
                        unit: comp.unit || 'Units',
                        supplierName: supplier ? supplier.name : (comp.supplierName || 'Unassigned'),
                        poNumber: comp.poNumber || '',
                        status: comp.status || 'PENDING',
                        orderStatus: order.status || ''
                    });
                }
            });
        });
    });

    // Sort by date descending
    history.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json(history.slice(0, 50)); // Limit to last 50 records
});

app.post('/api/v1/customers/merge', (req, res) => {
    try {
        const { primaryId, secondaryIds } = req.body;
        console.log(`[Merge] Attempting to merge clusters into ${primaryId}. Secondaries:`, secondaryIds);

        if (!primaryId || !secondaryIds || !Array.isArray(secondaryIds)) {
            return res.status(400).json({ error: "Missing merge parameters" });
        }
        // R34 round 5 (validator 4, item 3): a merge moves wallets, receivables and opening balances, so it is a finance-relevant
        // customer write: the same role gate as the other money writes (enforced when the caller's roles are known; admin,
        // management, finance, plus the CRM role that owns the customer records / the merge screen).
        {
            const rM = finRolesOf(req);
            if (rM.length && !rM.some(x => ['admin', 'management', 'finance', 'crm'].includes(x))) return res.status(403).json({ error: 'refused: wrong role: merging customers is for crm / finance / management / admin' });
        }
        // a customer cannot be merged into itself (the record would be deleted with its wallet and openings)
        if (secondaryIds.map(String).includes(String(primaryId))) return res.status(400).json({ error: "Refused: the primary customer cannot be one of the records merged into it" });

        const db = getDb(req);
        const primary = db.customers.find(c => c.id === primaryId);
        if (!primary) return res.status(404).json({ error: "Primary customer not found" });

        const user = req.headers['x-user'] || 'System';
        const secondaryNames = [];
        const deletedIds = [];

        // Identify secondary customers and their names
        secondaryIds.forEach(id => {
            const idx = db.customers.findIndex(c => c.id === id);
            if (idx !== -1) {
                // CX02: the secondary's wallet (general advance, project and order accounts) moves to the primary; it must not vanish with the record.
                const sec = db.customers[idx];
                primary.walletBalances = primary.walletBalances || {};
                Object.entries(sec.walletBalances || {}).forEach(([k, v]) => { primary.walletBalances[k] = Math.round(((primary.walletBalances[k] || 0) + (Number(v) || 0)) * 100) / 100; });
                primary.walletBalance = Math.round(((Number(primary.walletBalance) || 0) + (Number(sec.walletBalance) || 0)) * 100) / 100;
                (sec.logs || []).forEach(l => { primary.logs = primary.logs || []; primary.logs.push(l); });
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

        // R34 round 4 (validator 3, D6): the secondary's opening balances and ledger entries move to the primary as well: the
        // opening keys AR:<id>, CUST_SELF:<id>, CUST_PROJECT:<id>:<project> are re-keyed to the primary ID, the ledger
        // customerName and the 'Customer <name> / ...' / '<name> / ...' labels follow the primary name, contracts follow the
        // primary name. The receivable and wallet openings stay complete and no orphan customer row remains in /ar.
        let ledgerMigrated = 0;
        (db.contracts || []).forEach(k => { if (k && secondaryNames.includes(k.customerName)) k.customerName = primary.name; });
        (db.ledger || []).forEach(e => {
            if (!e) return;
            let hit = false;
            if (secondaryNames.includes(e.customerName)) { e.customerName = primary.name; hit = true; }
            if (typeof e.accountKey === 'string') {
                const km = e.accountKey.match(/^(AR|CUST_SELF|CUST_PROJECT):([^:]+)(:.*)?$/);
                if (km && deletedIds.includes(km[2])) { e.accountKey = `${km[1]}:${primary.id}${km[3] || ''}`; e.mergedFromCustomerId = km[2]; hit = true; }
            }
            secondaryNames.forEach(sn => {
                ['fromAccount', 'toAccount', 'account'].forEach(f => {
                    if (typeof e[f] !== 'string') return;
                    if (e[f].startsWith(`Customer ${sn} / `)) { e[f] = `Customer ${primary.name} / ` + e[f].slice(`Customer ${sn} / `.length); hit = true; }
                    else if (e.type === 'OPENING' && (f === 'account' || f === 'toAccount') && e[f].startsWith(`${sn} / `)) { e[f] = `${primary.name} / ` + e[f].slice(`${sn} / `.length); hit = true; }
                });
            });
            if (hit) ledgerMigrated++;
        });

        // Audit log for primary customer
        if (!primary.logs) primary.logs = [];
        primary.logs.push(createAuditLog(`Merged ${deletedIds.length} duplicate records. Migrated ${ordersMigrated} orders and ${ledgerMigrated} ledger entries (opening balances included).`, undefined, user));

        if (writeDb(db, getDbPath(req))) {
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

// --- LEDGER / CUSTOMER SUB-ACCOUNTS ---
// Money moves from an account to an account. A customer has: SELF (money not tied to any activity),
// one PROJECT account per project and one ORDER account per PO. Every cash movement and every
// transfer between accounts is logged in db.ledger (transfers are type TRANSFER and net zero in cash totals).
const SELF_WALLET_KEY = '(General Advance / Future Orders)';
const acctLabel = (customerName, kind, ref) => kind === 'ORDER' ? `Customer ${customerName} / PO ${ref}` : kind === 'PROJECT' ? `Customer ${customerName} / Project ${ref}` : `Customer ${customerName} / Self`;
const ledgerPush = (db, e, user) => {
    if (!db.ledger) db.ledger = [];
    db.ledger.push({ id: `led_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, date: new Date().toISOString(), user, ...e });
};
// User ruling 2026-10-21 (21:45): a customer payment above the PO gross moves to the customer GENERAL wallet (no refund action);
// the PO keeps exactly its commitment. Used by record-payment and (R34 round 4, D1) by a ledger ADDITION that names the PO.
// The surplus is in the order currency; the wallet holds L.E. (x the order rate).
function moveOrderSurplusToGeneralWallet(db, order, user) {
    if (!order || order.blanketOrder || order.blanketContractId) return 0;
    // v1.0001220 (N1): paid money of a cancel still in the customer general wallet (a reopen could not take it back) is not on the PO.
    const leftOC = Number(order.paymentMovedToWallet) || 0;
    const totalPaid = (order.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0) - leftOC;
    const gross = orderCommitmentGross(order);
    const surplus = Math.round((totalPaid - (Number(order.surplusMovedToWallet) || 0) - gross) * 100) / 100;
    const custS = (db.customers || []).find(c => c.name === order.customerName);
    if (!(gross > 0 && surplus > 0.004 && custS)) return 0;
    // R34 round 5 (validator 4, item 4): the L.E. credited is what the PO received in L.E. above its gross in L.E. (payments entered
    // in L.E. keep their exact amountLE), so PO + wallet = the L.E. money received, without a rounding cent.
    const fxS = orderFx(order);
    const prevLE = (order.surplusMovedToWalletLE !== undefined && order.surplusMovedToWalletLE !== null) ? Number(order.surplusMovedToWalletLE) || 0 : (Number(order.surplusMovedToWallet) || 0) * fxS;
    const leftLE = (order.paymentMovedToWalletLE !== undefined && order.paymentMovedToWalletLE !== null) ? Number(order.paymentMovedToWalletLE) || 0 : leftOC * fxS;
    const surplusLE = (order.payments || []).some(p => p && p.amountLE !== undefined && p.amountLE !== null)
        ? Math.max(0, Math.round((orderPaymentsLE(order) - leftLE - prevLE - gross * fxS) * 100) / 100)
        : Math.round(surplus * fxS * 100) / 100;
    custS.walletBalances = custS.walletBalances || {};
    custS.walletBalances[SELF_WALLET_KEY] = Math.round(((custS.walletBalances[SELF_WALLET_KEY] || 0) + surplusLE) * 100) / 100;
    custS.walletBalance = Math.round(((Number(custS.walletBalance) || 0) + surplusLE) * 100) / 100;
    order.surplusMovedToWallet = Math.round(((Number(order.surplusMovedToWallet) || 0) + surplus) * 100) / 100;
    order.surplusMovedToWalletLE = Math.round((prevLE + surplusLE) * 100) / 100;
    ledgerPush(db, { type: 'TRANSFER', amount: surplusLE, description: `PO ${order.internalOrderNumber}: payment above the PO gross credited to the customer general wallet`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), toAccount: acctLabel(order.customerName, 'SELF', ''), customerName: order.customerName }, user);
    order.logs = order.logs || [];
    order.logs.push(createAuditLog(`Payment above the PO gross: ${surplus.toFixed(2)} moved to the customer general wallet (no refund action).`, order.status, user));
    return surplus;
}

// R34 round 6 (validator 5, O4): customer money writes (advance, refund, wallet transfer, pay-from-wallet) use the SAME role gate as
// the customer merge: admin, management, finance or crm. Enforced only when the caller's roles are known (finRolesOf), so a
// sales-only user is refused with 403; system calls without a known user are unchanged.
const CUSTOMER_MONEY_ROLES = ['admin', 'management', 'finance', 'crm'];
// R34 round 7 (O-d): the message names who is refused (user and roles). Pay-from-wallet is a payment as well, so its gate is the
// payment role set (finance / management / admin; crm is refused there, observation O-b left as is) and its message says so.
const customerMoneyGate = (req, what, roles = CUSTOMER_MONEY_ROLES) => {
    const r = finRolesOf(req);
    if (r.length && !r.some(x => roles.includes(x))) {
        const who = String(req.headers['x-user'] || '').trim() || 'this user';
        const order = ['crm', 'finance', 'management', 'admin'].filter(x => roles.includes(x));
        return `refused: wrong role: ${what} is for ${order.join(' / ')}; ${who} (role ${r.join(', ')}) is refused`;
    }
    return null;
};
const PAYMENT_MONEY_ROLES = ['admin', 'management', 'finance'];
// R34 round 7 (validator 6, defect 8): the generic writes (POST / PUT /api/v1/customers, /orders, /ledger) may not change customer
// money either, unless the caller passes the same customer money gate: customer wallet buckets / total, order payments and the
// money an order moved to the wallet, and a ledger customer payment naming a PO. Only when the caller's roles are known; a change
// is a value that differs from the stored one (a client re-sending the unchanged record is not refused).
const CUSTOMER_MONEY_FIELDS = {
    customers: ['walletBalances', 'walletBalance'],
    orders: ['payments', 'surplusMovedToWallet', 'surplusMovedToWalletLE', 'paymentMovedToWallet', 'paymentMovedToWalletLE', 'paymentMovedByCancel', 'paymentMovedByCancelLE'] // v1.0001221: + the credit of the current cancel
};
// R34 round 8 (validator 7, defect 2): also a customer refund (REFUND naming a customer / PO, or category 'Customer Refunds': Cash /
// Bank drops), a customer advance (category 'Customer Advance' or an adv_cust_* row: Cash / Bank counts it), and a TRANSFER naming an
// order or a receipt (Cash / Bank reads a TRANSFER with orderId + receipt as the wallet part of a pay-from-wallet).
const isCustomerMoneyLedgerEntry = (e) => {
    if (!e) return false;
    const cat = String(e.category || ''), typ = String(e.type || '').toUpperCase();
    if (cat === 'Supplier Refund') return false;
    if (typ === 'ADDITION' && Boolean(e.orderId || e.poNumber)) return true;
    if (cat === 'Customer Payment' || cat === 'Customer Payment Reversal') return true;
    if (cat === 'Customer Refunds' || (typ === 'REFUND' && Boolean(e.customerName || e.orderId || e.poNumber))) return true;
    if (cat === 'Customer Advance' || String(e.id || '').startsWith('adv_cust_')) return true;
    if (typ === 'TRANSFER' && Boolean(e.orderId || e.receiptNumber)) return true;
    return false;
};
const sameMoneyValue = (a, b) => {
    const emptyish = (v) => v === undefined || v === null || v === 0 || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => !Number(x)));
    if (emptyish(a) && emptyish(b)) return true;
    return JSON.stringify(a) === JSON.stringify(b);
};
const genericMoneyWriteGate = (req, col, oldItem, body) => {
    const b = body || {};
    let what = null;
    if (col === 'ledger') {
        if (isCustomerMoneyLedgerEntry(b) || (oldItem && isCustomerMoneyLedgerEntry(oldItem))) {
            // R34 round 8 (defect 2): the message names the kind of customer money (payment / refund / advance / wallet transfer)
            const kindOf = (e) => {
                if (!e || !isCustomerMoneyLedgerEntry(e)) return null;
                const cat = String(e.category || ''), typ = String(e.type || '').toUpperCase();
                if (cat === 'Customer Payment' || cat === 'Customer Payment Reversal' || (typ === 'ADDITION' && (e.orderId || e.poNumber))) return 'payment';
                if (cat === 'Customer Refunds' || typ === 'REFUND') return 'refund';
                if (cat === 'Customer Advance' || String(e.id || '').startsWith('adv_cust_')) return 'advance';
                return 'wallet transfer';
            };
            what = `a customer ${kindOf(oldItem) || kindOf(b)} ledger entry`;
        }
    } else if (CUSTOMER_MONEY_FIELDS[col]) {
        // R34 round 8 (validator 7, defect 3): a customer record echoed back from GET carries the COMPUTED wallet (buckets incl. PO
        // money); that echo is no change attempt (the fields are dropped on PUT anyway), only a value that differs from both the
        // stored and the computed figure is.
        const computed = (col === 'customers' && oldItem && req) ? (() => { try { const dbc = getDb(req); return computeCustomerWallet(oldItem, dbc.orders || [], dbc.supplierPayments || [], dbc); } catch (e) { return null; } })() : null;
        const changed = CUSTOMER_MONEY_FIELDS[col].filter(f => b[f] !== undefined && !sameMoneyValue(b[f], oldItem ? oldItem[f] : undefined) && !(computed && sameMoneyValue(b[f], computed[f])));
        if (changed.length) what = col === 'customers' ? `changing the customer wallet (${changed.join(', ')})` : `changing the order payments (${changed.join(', ')})`;
    }
    return what ? customerMoneyGate(req, what) : null;
};
// R34 round 9 (validator 8, defect 4): the generic POST / PUT on /ledger and /orders never write the rows that only the money actions
// write, for ANY role (money roles included): a customer refund (REFUND naming a customer / PO, or category 'Customer Refunds'), a
// customer advance (category 'Customer Advance', an adv_cust_* row), a customer wallet transfer (TRANSFER naming an order or a
// receipt), a payment reversal (category 'Customer Payment Reversal'), and the payments / moved-to-wallet figures of an order. Those
// rows move a customer wallet or Cash / Bank without the other side, so the books would no longer balance. A description-only edit
// of such a ledger row, plain COST / ADDITION rows and a ledger payment naming a PO (ADDITION, round 3) stay allowed. Runs after the
// role gate (a non-money role still gets the 403 of genericMoneyWriteGate first).
const systemLedgerShape = (e) => {
    if (!e) return null;
    const cat = String(e.category || ''), typ = String(e.type || '').toUpperCase();
    if (cat === 'Supplier Refund') return null;
    if (cat === 'Customer Refunds' || (typ === 'REFUND' && Boolean(e.customerName || e.orderId || e.poNumber))) return { kind: 'a customer refund', use: 'the customer Refund action (POST /api/v1/customers/:id/refund)' };
    if (cat === 'Customer Advance' || String(e.id || '').startsWith('adv_cust_')) return { kind: 'a customer advance', use: 'the customer Advance action (POST /api/v1/customers/:id/advance-payment)' };
    if (typ === 'TRANSFER' && Boolean(e.orderId || e.receiptNumber)) return { kind: 'a customer wallet transfer', use: 'the wallet transfer action (POST /api/v1/customers/:id/wallet-transfer) or record-payment from the wallet' };
    if (cat === 'Customer Payment Reversal') return { kind: 'a payment reversal', use: 'the cancel-payment action of the order' };
    return null;
};
const LEDGER_FREE_EDIT_FIELDS = ['description', 'id'];
const systemMoneyRowRefusal = (col, oldItem, body) => {
    const b = body || {};
    if (col === 'ledger') {
        if (!oldItem) {
            const sh = systemLedgerShape(b);
            return sh ? `Refused: ${sh.kind} ledger row is written only by its own action - use ${sh.use}; the generic ledger entry cannot create it.` : null;
        }
        // A ledger payment naming a PO (ADDITION with orderId / poNumber) is created by the generic POST (it books the order payment
        // at the same time), but editing it later would leave the order payment behind: only its description may change.
        const payShape = (e) => (String(e.type || '').toUpperCase() === 'ADDITION' && String(e.category || '') !== 'Supplier Refund' && Boolean(e.orderId || e.poNumber) && !e.orderNotFound) ? { kind: 'a customer payment (naming a PO)', use: 'the cancel-payment action of the order and a new payment' } : null;
        const sh = systemLedgerShape(oldItem) || systemLedgerShape({ ...oldItem, ...b }) || payShape(oldItem) || payShape({ ...oldItem, ...b });
        if (!sh) return null;
        const changed = Object.keys(b).filter(k => !LEDGER_FREE_EDIT_FIELDS.includes(k) && JSON.stringify(b[k]) !== JSON.stringify(oldItem[k]));
        return changed.length ? `Refused: ${sh.kind} ledger row is changed only by its own action - use ${sh.use}; the generic ledger edit may change its description only (refused: ${changed.join(', ')}).` : null;
    }
    if (col === 'orders') {
        const changed = CUSTOMER_MONEY_FIELDS.orders.filter(f => b[f] !== undefined && !sameMoneyValue(b[f], oldItem ? oldItem[f] : undefined));
        if (changed.length) return `Refused: the ${changed.includes('payments') ? 'payments' : 'moved-to-wallet figures'} of an order change only through the money actions (record-payment, cancel-payment, wallet transfer, a ledger payment naming the PO); the generic order ${oldItem ? 'edit' : 'create'} cannot ${oldItem ? 'change' : 'set'} ${changed.join(', ')}.`;
    }
    return null;
};
app.post('/api/v1/customers/:id/wallet-transfer', (req, res) => {
    const gateW = customerMoneyGate(req, 'a customer wallet transfer');
    if (gateW) return res.status(403).json({ error: gateW });
    try {
        const db = getDb(req);
        const user = req.headers['x-user'] || 'System';
        const { from, to, amount, memo } = req.body || {};
        const amt = Math.round((parseFloat(amount) + Number.EPSILON) * 100) / 100;
        if (!amt || isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Positive transfer amount is required" });
        if (!from || !to || !from.type || !to.type) return res.status(400).json({ error: "from and to accounts {type: SELF|PROJECT|ORDER, ref} are required" });
        const customer = (db.customers || []).find(c => c.id === req.params.id || c.name === req.params.id);
        if (!customer) return res.status(404).json({ error: "Customer not found" });
        customer.walletBalances = customer.walletBalances || {};
        const find = a => {
            const t = String(a.type).toUpperCase();
            if (t === 'SELF') return { t, key: SELF_WALLET_KEY, ref: 'Self' };
            if (t === 'PROJECT') { if (!a.ref) throw new Error("Project account needs a ref (project name)"); return { t, key: String(a.ref).trim(), ref: String(a.ref).trim() }; }
            if (t === 'ORDER') {
                const o = (db.orders || []).find(x => x.customerName === customer.name && (x.id === a.ref || x.internalOrderNumber === a.ref));
                if (!o) throw new Error(`Order ${a.ref} not found for this customer`);
                // R34 round 8 (validator 7, defect 5): a cancelled (REJECTED) PO is no wallet account any more: its paid money already
                // moved to the customer general wallet, so nothing is transferred into it (the money would leave the customer wallets
                // while Cash / Bank keeps it) or out of it.
                if (o.status === 'REJECTED') throw new Error(`Refused: order ${o.internalOrderNumber} is cancelled (REJECTED); no wallet transfer ${a === from ? 'out of' : 'into'} it - its paid money is already in the customer general wallet.`);
                return { t, order: o, ref: o.internalOrderNumber };
            }
            throw new Error(`Unknown account type ${a.type}`);
        };
        const src = find(from), dst = find(to);
        if (src.t === dst.t && (src.key || src.order?.id) === (dst.key || dst.order?.id)) return res.status(400).json({ error: "Source and target accounts are the same" });
        // source balance check. The transfer amount is in L.E. (wallets are L.E.); R34 round 5 (validator 4, item 6): an order account
        // is checked by the L.E. money it holds (payments x the order rate, exact amountLE where the payment was entered in L.E.).
        if (src.t === 'ORDER') {
            // R34 round 6 (validator 5, D3): an order account can give at most its PO WALLET (money received in L.E. minus the
            // supplier payments for this PO minus the surplus already moved, plus its opening), never the money received alone:
            // PO 1,140 paid, supplier paid 912 -> PO wallet 228, a transfer of 1,140 out of it is refused.
            const ow = computeOrderWallet(src.order, db.orders || [], db.supplierPayments || [], db.ledger || []);
            const holdLE = r2w(Math.max(0, Number(ow && ow.walletBalance) || 0));
            if (holdLE + 0.005 < amt) return res.status(400).json({ error: `Insufficient balance: order ${src.ref} holds ${holdLE.toFixed(2)} L.E., transfer ${amt.toFixed(2)}${(ow.paidOut || ow.openingBalance) ? ` (PO wallet = received ${r2w(ow.paid).toFixed(2)} minus supplier payments ${r2w(ow.paidOut).toFixed(2)}${ow.openingBalance ? ` plus opening ${r2w(ow.openingBalance).toFixed(2)}` : ''})` : ''}` });
            // R34 round 7 (validator 6, defect 2): a transfer out of a PO is booked as a negative payment on it, so it may never take
            // more than the money actually paid IN by payments (L.E.): otherwise the PO's paid figure turns negative and AR rises above
            // the PO gross. A PO funded only by its opening holds no payment money, so its opening cannot be moved out this way.
            const paidInLE = r2w(Math.max(0, Number(ow && ow.paid) || 0));
            if (paidInLE + 0.005 < amt) return res.status(400).json({ error: `Refused: a transfer out of order ${src.ref} may not exceed the money paid in by payments (${paidInLE.toFixed(2)} L.E.); transfer ${amt.toFixed(2)} would raise the receivable above the PO gross${ow.openingBalance ? ` (the PO opening ${r2w(ow.openingBalance).toFixed(2)} is not payment money)` : ''}` });
        } else if (src.t === 'SELF') {
            // R34 round 5 (validator 4, item 1): rule G1 also limits a transfer OUT of the general wallet (like refund and
            // pay-from-wallet): never more than availableGeneralWallet() (stored general bucket minus the company costs linked to no
            // PO when the company has exactly one customer). A transfer to a project wallet is limited the same way, so the
            // project wallet cannot be used to pay a PO with money G1 already took.
            const storedG = Number(customer.walletBalances[src.key]) || 0;
            const g1T = g1DeductionFor(db);
            const availT = availableGeneralWallet(db, customer);
            if (availT + 0.005 < amt) return res.status(400).json({ error: g1T ? `Insufficient general wallet credit: ${Math.max(0, availT).toFixed(2)} available (stored ${storedG.toFixed(2)} minus ${g1T.toFixed(2)} company costs linked to no PO), transfer ${amt.toFixed(2)}` : `Insufficient balance: account holds ${storedG.toFixed(2)}, transfer ${amt.toFixed(2)}` });
        } else if ((customer.walletBalances[src.key] || 0) + 0.005 < amt) {
            return res.status(400).json({ error: `Insufficient balance: account holds ${(customer.walletBalances[src.key] || 0).toFixed(2)}, transfer ${amt.toFixed(2)}` });
        }
        if (dst.t === 'ORDER') { const cpT = closedCallOffPaymentRefusal(db, dst.order, amt); if (cpT) return res.status(400).json({ error: cpT }); }
        const now = new Date().toISOString();
        const note = `Account transfer ${amt.toFixed(2)}: ${acctLabel(customer.name, src.t, src.ref)} -> ${acctLabel(customer.name, dst.t, dst.ref)}${memo ? ' - ' + memo : ''}`;
        // R34 round 5 (validator 4, item 2): ONE receipt number for the transfer, on the order payment(s) AND on the ledger TRANSFER,
        // so the Finance > Ledger list shows the transfer once (by its ledger entry).
        const trfReceipt = `TRF-${String(Date.now()).slice(-6)}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        const touchOrder = (o, deltaLE) => {
            // R34 round 5 (validator 4, item 6): the payment on an order is in the ORDER currency: L.E. / rate (5,000 L.E. on a USD
            // PO at rate 50 = 100 USD); the exact L.E. amount stays in amountLE.
            const fxT = orderFx(o);
            o.payments = o.payments || [];
            o.payments.push({ amount: Math.round((deltaLE / fxT) * 100) / 100, ...(fxT !== 1 ? { amountLE: deltaLE, conversionRate: fxT } : {}), date: now, user, memo: note + (fxT !== 1 ? ` (${(deltaLE / fxT).toFixed(2)} ${o.currency} at rate ${fxT})` : ''), receiptNumber: trfReceipt, transfer: true });
            o.logs = o.logs || [];
            o.logs.push(createAuditLog(note + (fxT !== 1 ? ` (${(deltaLE / fxT).toFixed(2)} ${o.currency} at rate ${fxT})` : ''), o.status, user));
        };
        let walletDelta = 0;
        if (src.t === 'ORDER') touchOrder(src.order, -amt); else { customer.walletBalances[src.key] = Math.round(((customer.walletBalances[src.key] || 0) - amt) * 100) / 100; walletDelta -= amt; }
        if (dst.t === 'ORDER') touchOrder(dst.order, amt); else { customer.walletBalances[dst.key] = Math.round(((customer.walletBalances[dst.key] || 0) + amt) * 100) / 100; walletDelta += amt; }
        customer.walletBalance = Math.round(((customer.walletBalance || 0) + walletDelta) * 100) / 100;
        customer.logs = customer.logs || [];
        customer.logs.push(createAuditLog(note, 'WALLET_TRANSFER', user));
        // no orderId on purpose: Cash / Bank reads a TRANSFER with orderId + receiptNumber as the wallet part of a pay-from-wallet
        ledgerPush(db, { type: 'TRANSFER', amount: amt, description: note, category: 'Account Transfer', fromAccount: acctLabel(customer.name, src.t, src.ref), toAccount: acctLabel(customer.name, dst.t, dst.ref), customerName: customer.name, receiptNumber: trfReceipt, walletTransfer: true }, user);
        // R34 round 7 (validator 6, defect 9): a transfer INTO a PO follows the record-payment ruling: the part above the PO gross
        // moves on to the customer general wallet (TRANSFER PO -> Self), so the PO is never overpaid.
        let excessToGeneral = 0;
        if (dst.t === 'ORDER') {
            const before = Number(dst.order.surplusMovedToWalletLE ?? dst.order.surplusMovedToWallet) || 0;
            moveOrderSurplusToGeneralWallet(db, dst.order, user);
            excessToGeneral = r2w((Number(dst.order.surplusMovedToWalletLE ?? dst.order.surplusMovedToWallet) || 0) - before);
        }
        writeDb(db, getDbPath(req));
        return res.json({ ok: true, amount: amt, ...(excessToGeneral > 0 ? { excessToGeneralWallet: excessToGeneral } : {}), from: acctLabel(customer.name, src.t, src.ref), to: acctLabel(customer.name, dst.t, dst.ref), wallet: computeCustomerWallet(customer, db.orders || [], db.supplierPayments || [], db) });
    } catch (err) {
        res.status(400).json({ error: err.message || "Transfer failed" });
    }
});

// Record customer advance deposit / unearned prepayment for future orders
app.post('/api/v1/customers/:id/advance-payment', (req, res) => {
    const gateA = customerMoneyGate(req, 'a customer advance');
    if (gateA) return res.status(403).json({ error: gateA });
    try {
        const db = getDb(req);
        const user = req.headers['x-user'] || 'System';
        const { id } = req.params;
        const { amount, memo, date, projectName, orderId: targetOrderId } = req.body;
        const numAmt = parseFloat(amount);
        if (!numAmt || isNaN(numAmt) || numAmt <= 0) {
            return res.status(400).json({ error: "Positive payment amount is required" });
        }
        const customer = (db.customers || []).find(c => c.id === id || c.name === id);
        if (!customer) return res.status(404).json({ error: "Customer not found" });

        const projKey = (projectName && projectName.trim()) ? projectName.trim() : '(General Advance / Future Orders)';
        customer.walletBalances = customer.walletBalances || {};
        customer.walletBalances[projKey] = (customer.walletBalances[projKey] || 0) + numAmt;
        customer.walletBalance = (customer.walletBalance || 0) + numAmt;

        if (!customer.logs) customer.logs = [];
        customer.logs.push(createAuditLog(
            `Advance Payment Recorded: ${numAmt.toLocaleString()} L.E. - ${memo || 'Deposit for future orders'} (New Wallet Balance: ${customer.walletBalance.toLocaleString()} L.E.)`,
            'WALLET_CREDIT',
            user
        ));

        // Also record in db.ledger as an addition so cash flow and general ledger reflect the cash hit
        if (!db.ledger) db.ledger = [];
        db.ledger.push({
            id: `adv_cust_${customer.id || Date.now()}_${Date.now()}`,
            date: date || new Date().toISOString(),
            type: 'ADDITION',
            amount: numAmt,
            description: `Customer Advance Deposit: ${customer.name} - ${memo || 'Deposit for future orders'}`,
            category: 'Customer Advance',
            fromAccount: 'Customer Deposit',
            toAccount: 'Bank Account',
            customerName: customer.name,
            account: acctLabel(customer.name, projKey === SELF_WALLET_KEY ? 'SELF' : 'PROJECT', projKey === SELF_WALLET_KEY ? 'Self' : projKey),
            user
        });

        writeDb(db, getDbPath(req));
        return res.json(computeCustomerWallet(customer, db.orders || [], db.supplierPayments || [], db));
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record customer advance payment" });
    }
});

// R23 (C17): REFUND - the ledger user pays the customer's general-wallet credit out to the customer (wallet -> Bank).
// No sale was recognised on an advance, so no revenue/expense account is involved.
app.post('/api/v1/customers/:id/refund', (req, res) => {
    const gateR = customerMoneyGate(req, 'a customer refund');
    if (gateR) return res.status(403).json({ error: gateR });
    try {
        const db = getDb(req);
        const user = req.headers['x-user'] || 'System';
        const { amount, memo, orderId } = req.body || {};
        const amt = Math.round((parseFloat(amount) + Number.EPSILON) * 100) / 100;
        if (!amt || isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Positive refund amount is required" });
        const customer = (db.customers || []).find(c => c.id === req.params.id || c.name === req.params.id);
        if (!customer) return res.status(404).json({ error: "Customer not found" });
        customer.walletBalances = customer.walletBalances || {};
        const bal = customer.walletBalances[SELF_WALLET_KEY] || 0;
        // R34 round 4 (validator 3, D5, rule G1): the refund can pay out at most the AVAILABLE general wallet = stored general bucket
        // minus the company costs linked to no PO (single-customer company), the same figure as Initial Balances; never below zero.
        const g1R = g1DeductionFor(db);
        const availR = Math.round((bal - g1R) * 100) / 100;
        if (availR + 0.005 < amt) return res.status(400).json({ error: g1R ? `Insufficient general wallet credit: ${Math.max(0, availR).toFixed(2)} available (stored ${bal.toFixed(2)} minus ${g1R.toFixed(2)} company costs linked to no PO), refund ${amt.toFixed(2)}` : `Insufficient general wallet credit: ${bal.toFixed(2)}, refund ${amt.toFixed(2)}` });
        const ord = orderId ? (db.orders || []).find(o => o.id === orderId || o.internalOrderNumber === orderId) : null;
        customer.walletBalances[SELF_WALLET_KEY] = Math.round((bal - amt) * 100) / 100;
        // R34 round 3 (validator 2, item 3): the stored total follows the bucket, so a later pay-from-wallet sees the refund.
        customer.walletBalance = Math.round(((Number(customer.walletBalance) || 0) - amt) * 100) / 100;
        ledgerPush(db, { type: 'REFUND', amount: amt, description: `Customer Refund: ${customer.name}${ord ? ` - PO ${ord.internalOrderNumber}` : ''} - ${memo || 'Refund of general wallet credit'}`, category: 'Customer Refunds', fromAccount: acctLabel(customer.name, 'SELF', 'Self'), toAccount: 'Bank Account', customerName: customer.name, orderId: ord ? ord.id : undefined, poNumber: ord ? ord.internalOrderNumber : undefined }, user);
        writeDb(db, getDbPath(req));
        return res.json(computeCustomerWallet(customer, db.orders || [], db.supplierPayments || [], db));
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record customer refund" });
    }
});

// R23 (C17): a refund received from a supplier reduces the supplier advance (debit Bank, credit supplier advance).
app.post('/api/v1/supplierRefunds', (req, res) => {
    try {
        const db = getDb(req);
        const user = req.headers['x-user'] || 'System';
        const { supplierId, amount, memo, date, orderId, poNumber } = req.body || {};
        const amt = Math.round((parseFloat(amount) + Number.EPSILON) * 100) / 100;
        if (!supplierId || !amt || isNaN(amt) || amt <= 0) return res.status(400).json({ error: "supplierId and a positive amount are required" });
        const supplier = (db.suppliers || []).find(s => s.id === supplierId);
        if (!supplier) return res.status(404).json({ error: "Supplier not found" });
        if (!db.supplierPayments) db.supplierPayments = [];
        // R34 round 3 (validator 2, item 4): the refund returns money of the supplier's unallocated advances, so it lowers those
        // advances (the one named by supplierPaymentId first, else the oldest first); a returned advance can no longer cover a later
        // PO (autoCover). A refund of opening money (isOpening advance) is opening money too: it never touches a customer wallet.
        // Only a refund above all unallocated advances stays as a negative unallocated amount on the refund record (as before).
        const { supplierPaymentId } = req.body || {};
        const advs = db.supplierPayments.filter(p => p && p.supplierId === supplierId && !p.isRefund && (Number(p.unallocatedAdvance) || 0) > 0.004)
            .sort((a, b) => (a.id === supplierPaymentId ? -1 : b.id === supplierPaymentId ? 1 : new Date(a.date).getTime() - new Date(b.date).getTime()));
        let restR = amt; const refundOf = [];
        for (const p of advs) {
            if (restR <= 0.004) break;
            const take = Math.round(Math.min(restR, Number(p.unallocatedAdvance) || 0) * 100) / 100;
            p.unallocatedAdvance = Math.round(((Number(p.unallocatedAdvance) || 0) - take) * 100) / 100;
            p.refunded = Math.round(((Number(p.refunded) || 0) + take) * 100) / 100;
            refundOf.push({ supplierPaymentId: p.id, amount: take, isOpening: Boolean(p.isOpening) });
            restR = Math.round((restR - take) * 100) / 100;
        }
        const openingPart = Math.round(refundOf.filter(r => r.isOpening).reduce((t, r) => t + r.amount, 0) * 100) / 100;
        const rec = { id: `sp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, supplierId, supplierName: supplier.name, amount: -amt, isRefund: true, date: date ? new Date(date).toISOString() : new Date().toISOString(), memo: memo || 'Supplier refund received', user, orderId: orderId || undefined, poNumber: poNumber || undefined, unallocatedAdvance: restR > 0.004 ? -restR : 0, allocations: [], refundOf, openingRefund: openingPart || undefined };
        db.supplierPayments.push(rec);
        ledgerPush(db, { type: 'ADDITION', amount: amt, description: `Supplier Refund received: ${supplier.name} - ${memo || 'Refund'}`, category: 'Supplier Refund', fromAccount: `Supplier ${supplier.name} / Advance`, toAccount: 'Bank Account', orderId: orderId || undefined, poNumber: poNumber || undefined }, user);
        writeDb(db, getDbPath(req));
        return res.status(201).json(rec);
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record supplier refund" });
    }
});

// --- RESTFUL API USER GUIDE ---
app.get('/api/v1/user-guide', (req, res) => {
    const format = String(req.query.format || 'markdown').toLowerCase();
    const isDownload = req.query.download === 'true' || req.query.download === '1';

    if (isDownload) {
        const filename = format === 'json' ? 'NexusERP_RESTful_API_User_Guide.json' : 'NexusERP_RESTful_API_User_Guide.md';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(getUserGuideJson());
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(getUserGuideMarkdown());
});

app.get('/api/v1/user-guide/download', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="NexusERP_RESTful_API_User_Guide.md"');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(getUserGuideMarkdown());
});

// --- ORDER SUB-RESOURCES & CONVENIENCE ENDPOINTS ---
app.post('/api/v1/orders/:id/items', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const order = (db.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    { const rootN = closedRootOfCallOff(order, db.orders || []); if (rootN) return res.status(400).json({ error: `Refused: order ${order.internalOrderNumber} is a call-off of the closed blanket contract ${rootN.internalOrderNumber}; the closed settlement is final - no line can be added.` }); }
    const item = req.body;
    if (firstFraction([item.quantity]) !== undefined) return res.status(400).json({ error: `Rejected: fraction ${item.quantity} is not allowed (whole units only).` });
    if (!item.description || !item.unit) {
        return res.status(400).json({ error: "Item description and unit are required" });
    }
    const newItem = {
        id: item.id || `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        description: String(item.description).trim(),
        quantity: Number(item.quantity) || 1,
        pricePerUnit: Number(item.pricePerUnit ?? item.unitPrice ?? 0),
        unit: String(item.unit).trim(),
        components: Array.isArray(item.components) ? item.components : [],
        productionType: item.productionType || 'MANUFACTURED',
        isAccepted: item.isAccepted !== undefined ? item.isAccepted : false
    };

    order.items = order.items || [];
    order.items.push(newItem);
    order.logs = order.logs || [];
    order.logs.push(createAuditLog(`Line item added: ${newItem.description} (${newItem.quantity} ${newItem.unit})`, order.status, user));

    const updated = processedOrderInternal(order, db, user, false, order);
    const idx = db.orders.findIndex(o => o.id === order.id);
    db.orders[idx] = updated;

    if (writeDb(db, getDbPath(req))) {
        res.status(201).json(updated);
    } else {
        res.status(500).json({ error: "Failed to add item to order" });
    }
});

app.put('/api/v1/orders/:id/items/:itemId', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const order = (db.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.items = order.items || [];
    const itemIdx = order.items.findIndex(it => it.id === req.params.itemId);
    if (itemIdx === -1) return res.status(404).json({ error: "Order item not found" });

    // R34 round 11 (validator 10, defect 3): the lines of a call-off of a closed blanket contract are final on every path.
    { const rootP = closedRootOfCallOff(order, db.orders || []); if (rootP) return res.status(400).json({ error: `Refused: order ${order.internalOrderNumber} is a call-off of the closed blanket contract ${rootP.internalOrderNumber}; the closed settlement is final - no line can be changed.` }); }
    const oldItem = order.items[itemIdx];
    if (req.body.quantity !== undefined) {
        const q_ = Number(req.body.quantity);
        if (Number.isFinite(q_) && Math.abs(q_ - Math.round(q_)) > 1e-9) return res.status(400).json({ error: `Rejected: fraction ${q_} is not allowed on a normal order (whole units only).` });
    }
    order.items[itemIdx] = { ...oldItem, ...req.body };
    order.logs = order.logs || [];
    order.logs.push(createAuditLog(`Line item updated: ${order.items[itemIdx].description || oldItem.description}`, order.status, user));

    const updated = processedOrderInternal(order, db, user, false, order);
    const idx = db.orders.findIndex(o => o.id === order.id);
    db.orders[idx] = updated;

    if (writeDb(db, getDbPath(req))) {
        res.json(updated);
    } else {
        res.status(500).json({ error: "Failed to update order item" });
    }
});

app.delete('/api/v1/orders/:id/items/:itemId', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const order = (db.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.items = order.items || [];
    const itemIdx = order.items.findIndex(it => it.id === req.params.itemId);
    if (itemIdx === -1) return res.status(404).json({ error: "Order item not found" });
    // R34 round 11 (validator 10, defect 3): the lines of a call-off of a closed blanket contract are final on every path.
    { const rootD = closedRootOfCallOff(order, db.orders || []); if (rootD) return res.status(400).json({ error: `Refused: order ${order.internalOrderNumber} is a call-off of the closed blanket contract ${rootD.internalOrderNumber}; the closed settlement is final - no line can be removed.` }); }

    const removed = order.items.splice(itemIdx, 1)[0];
    order.logs = order.logs || [];
    order.logs.push(createAuditLog(`Line item removed: ${removed.description}`, order.status, user));

    const updated = processedOrderInternal(order, db, user, false, order);
    const idx = db.orders.findIndex(o => o.id === order.id);
    db.orders[idx] = updated;

    if (writeDb(db, getDbPath(req))) {
        res.json(updated);
    } else {
        res.status(500).json({ error: "Failed to remove order item" });
    }
});

app.post('/api/v1/orders/:id/hold', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const order = (db.orders || []).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const isHold = req.body.isHold !== undefined ? Boolean(req.body.isHold) : !order.isHold;
    const holdReason = req.body.holdReason || (isHold ? 'Manual hold applied via API' : 'Hold released via API');

    order.isHold = isHold;
    order.holdReason = isHold ? holdReason : undefined;
    order.logs = order.logs || [];
    order.logs.push(createAuditLog(`${isHold ? 'Hold Engaged' : 'Hold Released'}: ${holdReason}`, order.status, user));

    const idx = db.orders.findIndex(o => o.id === order.id);
    db.orders[idx] = order;

    if (writeDb(db, getDbPath(req))) {
        res.json(order);
    } else {
        res.status(500).json({ error: "Failed to update order hold state" });
    }
});

app.post('/api/v1/customers/:id/hold', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const customer = (db.customers || []).find(c => c.id === req.params.id);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const isHold = req.body.isHold !== undefined ? Boolean(req.body.isHold) : !customer.isHold;
    const holdReason = req.body.holdReason || (isHold ? 'Credit hold applied' : 'Hold released');

    customer.isHold = isHold;
    customer.holdReason = isHold ? holdReason : undefined;
    customer.logs = customer.logs || [];
    customer.logs.push(createAuditLog(`${isHold ? 'Hold Engaged' : 'Hold Released'}: ${holdReason}`, undefined, user));

    const idx = db.customers.findIndex(c => c.id === customer.id);
    db.customers[idx] = customer;

    if (writeDb(db, getDbPath(req))) {
        res.json(computeCustomerWallet(customer, db.orders || [], db.supplierPayments || [], db));
    } else {
        res.status(500).json({ error: "Failed to update customer hold state" });
    }
});

app.post('/api/v1/suppliers/:id/parts', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const supplier = (db.suppliers || []).find(s => s.id === req.params.id);
    if (!supplier) return res.status(404).json({ error: "Supplier not found" });

    if (supplier.isDeletedSupplier || supplier.name.trim().toLowerCase() === 'deleted suppliers') {
        return res.status(400).json({ error: "Cannot add parts to Deleted Suppliers vault" });
    }

    supplier.priceList = supplier.priceList || [];
    // CX02: a part number exists once per supplier.
    const pnNew = String(req.body.partNumber || '').trim().toLowerCase();
    if (pnNew && supplier.priceList.some(p => String(p.partNumber || '').trim().toLowerCase() === pnNew)) return res.status(400).json({ error: `Part ${req.body.partNumber} already exists for this supplier` });
    const part = {
        id: req.body.id || `part_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        partNumber: String(req.body.partNumber || '').trim(),
        description: String(req.body.description || '').trim(),
        unitCost: Number(req.body.unitCost) || 0,
        currency: req.body.currency || 'L.E.',
        leadTimeDays: Number(req.body.leadTimeDays) || 0,
        dateAdded: new Date().toISOString()
    };
    supplier.priceList.push(part);
    supplier.logs = supplier.logs || [];
    supplier.logs.push(createAuditLog(`Part added to price list: ${part.partNumber || part.description}`, undefined, user));

    const idx = db.suppliers.findIndex(s => s.id === supplier.id);
    db.suppliers[idx] = supplier;

    if (writeDb(db, getDbPath(req))) {
        res.status(201).json(supplier);
    } else {
        res.status(500).json({ error: "Failed to add part to supplier" });
    }
});

app.put('/api/v1/suppliers/:id/parts/:partId', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const supplier = (db.suppliers || []).find(s => s.id === req.params.id);
    if (!supplier) return res.status(404).json({ error: "Supplier not found" });

    supplier.priceList = supplier.priceList || [];
    const pIdx = supplier.priceList.findIndex(p => p.id === req.params.partId);
    if (pIdx === -1) return res.status(404).json({ error: "Part not found in supplier price list" });

    supplier.priceList[pIdx] = { ...supplier.priceList[pIdx], ...req.body };
    supplier.logs = supplier.logs || [];
    supplier.logs.push(createAuditLog(`Part updated in price list: ${supplier.priceList[pIdx].partNumber}`, undefined, user));

    const idx = db.suppliers.findIndex(s => s.id === supplier.id);
    db.suppliers[idx] = supplier;

    if (writeDb(db, getDbPath(req))) {
        res.json(supplier);
    } else {
        res.status(500).json({ error: "Failed to update supplier part" });
    }
});

app.delete('/api/v1/suppliers/:id/parts/:partId', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const supplier = (db.suppliers || []).find(s => s.id === req.params.id);
    if (!supplier) return res.status(404).json({ error: "Supplier not found" });

    supplier.priceList = supplier.priceList || [];
    const pIdx = supplier.priceList.findIndex(p => p.id === req.params.partId);
    if (pIdx === -1) return res.status(404).json({ error: "Part not found in supplier price list" });

    const [removedPart] = supplier.priceList.splice(pIdx, 1);
    supplier.logs = supplier.logs || [];
    supplier.logs.push(createAuditLog(`Part removed from price list: ${removedPart.partNumber}`, undefined, user));

    // Archive to Deleted Suppliers vault
    let vault = (db.suppliers || []).find(s => s.isDeletedSupplier || s.name.trim().toLowerCase() === 'deleted suppliers');
    if (!vault) {
        vault = {
            id: 'supp_deleted_vault',
            name: 'Deleted Suppliers',
            isDeletedSupplier: true,
            contactPerson: 'System Vault',
            email: 'vault@nexus.local',
            phone: '-',
            category: 'Archive',
            priceList: [],
            logs: []
        };
        db.suppliers.push(vault);
    }
    vault.priceList = vault.priceList || [];
    vault.priceList.push({
        ...removedPart,
        deletedFromSupplierId: supplier.id,
        deletedFromSupplierName: supplier.name,
        deletedAt: new Date().toISOString()
    });

    const idx = db.suppliers.findIndex(s => s.id === supplier.id);
    db.suppliers[idx] = supplier;

    if (writeDb(db, getDbPath(req))) {
        res.json({ message: "Part archived to Deleted Suppliers vault", supplier });
    } else {
        res.status(500).json({ error: "Failed to remove part" });
    }
});

app.post('/api/v1/suppliers/:id/blacklist', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const supplier = (db.suppliers || []).find(s => s.id === req.params.id);
    if (!supplier) return res.status(404).json({ error: "Supplier not found" });

    const isBlacklisted = req.body.isBlacklisted !== undefined ? Boolean(req.body.isBlacklisted) : !supplier.isBlacklisted;
    const blacklistReason = req.body.blacklistReason || (isBlacklisted ? 'Blacklisted via API' : 'Blacklist cleared via API');

    supplier.isBlacklisted = isBlacklisted;
    supplier.blacklistReason = isBlacklisted ? blacklistReason : undefined;
    supplier.logs = supplier.logs || [];
    supplier.logs.push(createAuditLog(`${isBlacklisted ? 'Blacklisted' : 'Blacklist Removed'}: ${blacklistReason}`, undefined, user));

    const idx = db.suppliers.findIndex(s => s.id === supplier.id);
    db.suppliers[idx] = supplier;

    if (writeDb(db, getDbPath(req))) {
        res.json(supplier);
    } else {
        res.status(500).json({ error: "Failed to update supplier blacklist state" });
    }
});

app.post('/api/v1/inventory/adjust', (req, res) => {
    const db = getDb(req);
    const user = req.headers['x-user'] || 'System';
    const { id, sku, delta, reason } = req.body;
    const numDelta = Number(delta);
    if (!Number.isFinite(numDelta) || numDelta === 0) {
        return res.status(400).json({ error: "Non-zero numeric delta is required" });
    }

    db.inventory = db.inventory || [];
    const item = db.inventory.find(it => (id && it.id === id) || (sku && String(it.sku || '').trim().toLowerCase() === String(sku).trim().toLowerCase()));
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    // TR11: the stock level lives in quantityInStock (quantity is the legacy field); adjusting only the legacy field changed nothing.
    const oldQty = Number(item.quantityInStock !== undefined ? item.quantityInStock : item.quantity) || 0;
    const newQty = Math.max(0, oldQty + numDelta);
    // CX03: an adjustment may not take the stock below the quantity already reserved for orders.
    if (numDelta < 0 && newQty < (Number(item.quantityReserved) || 0)) return res.status(400).json({ error: `Rejected: adjustment would leave ${newQty} on hand, below the ${Number(item.quantityReserved) || 0} reserved for orders` });
    item.quantityInStock = newQty;
    if (item.quantity !== undefined) delete item.quantity;
    item.logs = item.logs || [];
    item.logs.push(createAuditLog(`Stock level adjusted from ${oldQty} to ${newQty} (delta: ${numDelta > 0 ? '+' : ''}${numDelta}). Reason: ${reason || 'Manual API adjustment'}`, undefined, user));

    if (writeDb(db, getDbPath(req))) {
        res.json(item);
    } else {
        res.status(500).json({ error: "Failed to adjust inventory stock" });
    }
});

app.get('/api/v1/procurement/unique-po-number', (req, res) => {
    const db = getDb(req);
    const prefix = `PO-${new Date().getFullYear()}-`;
    const existingNumbers = [];
    (db.orders || []).forEach(o => {
        (o.items || []).forEach(it => {
            (it.components || []).forEach(c => {
                if (c.poNumber && c.poNumber.startsWith(prefix)) {
                    const num = parseInt(c.poNumber.replace(prefix, ''), 10);
                    if (!isNaN(num)) existingNumbers.push(num);
                }
            });
        });
    });
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1001;
    const poNumber = `${prefix}${String(nextNumber).padStart(4, '0')}`;
    res.json({ poNumber });
});

const r2c = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
app.get('/api/v1/reports/orders', (req, res) => {
    const db = getDb(req);
    const { startDate, endDate, statuses, query } = req.query;
    let orders = db.orders || [];

    if (startDate) orders = orders.filter(o => o.orderDate >= startDate);
    if (endDate) orders = orders.filter(o => o.orderDate <= endDate);
    if (statuses) {
        const statusList = Array.isArray(statuses) ? statuses : String(statuses).split(',').map(s => s.trim());
        orders = orders.filter(o => statusList.includes(o.status));
    }
    if (query) {
        const q = String(query).toLowerCase().trim();
        orders = orders.filter(o =>
            (o.internalOrderNumber && o.internalOrderNumber.toLowerCase().includes(q)) ||
            (o.customerReferenceNumber && o.customerReferenceNumber.toLowerCase().includes(q)) ||
            (o.customerName && o.customerName.toLowerCase().includes(q)) ||
            (o.projectName && o.projectName.toLowerCase().includes(q)) ||
            (o.status && o.status.toLowerCase().includes(q)) ||
            (o.contractId && o.contractId.toLowerCase().includes(q)) ||
            (o.blanketContractId && o.blanketContractId.toLowerCase().includes(q)) ||
            (o.invoiceNumber && o.invoiceNumber.toLowerCase().includes(q)) ||
            (o.orderDate && o.orderDate.toLowerCase().includes(q)) ||
            (isStockOrder(o) && 'stock order internal stock inventory replenishment'.includes(q)) ||
            (o.items || []).some(i =>
                (i.description && i.description.toLowerCase().includes(q)) ||
                (i.orderNumber && i.orderNumber.toLowerCase().includes(q)) ||
                (i.supplierPartNumber && i.supplierPartNumber.toLowerCase().includes(q)) ||
                (i.components || []).some(c =>
                    (c.poNumber && c.poNumber.toLowerCase().includes(q)) ||
                    (c.supersededPoNumber && c.supersededPoNumber.toLowerCase().includes(q)) ||
                    (c.cancelledPoNumber && c.cancelledPoNumber.toLowerCase().includes(q)) ||
                    (c.revertedPoNumber && c.revertedPoNumber.toLowerCase().includes(q)) ||
                    (c.componentNumber && c.componentNumber.toLowerCase().includes(q)) ||
                    (c.partNumber && c.partNumber.toLowerCase().includes(q)) ||
                    (c.supplierPartNumber && c.supplierPartNumber.toLowerCase().includes(q)) ||
                    (c.supplierName && c.supplierName.toLowerCase().includes(q)) ||
                    (c.description && c.description.toLowerCase().includes(q)) ||
                    (c.rfpId && c.rfpId.toLowerCase().includes(q)) ||
                    (c.awardId && c.awardId.toLowerCase().includes(q)) ||
                    (c.contractNumber && c.contractNumber.toLowerCase().includes(q))
                )
            )
        );
    }

    const settings = resolveSettings(db, isSandbox(req));
    const enrichedOrders = orders.map(o => calculateOrderHealth(o, settings));
    // Revenue (net) and real cost are computed from the lines; DELIVERED, WAITING_GOVE and FULFILLED orders count.
    enrichedOrders.forEach(o => {
        let net = 0, cost = 0;
        (o.items || []).forEach(it => {
            net += r2c((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
            (it.components || []).forEach(c => { cost += (Number(c.unitCost) || 0) * (Number(c.costBasisQty) || Number(c.quantity) || Number(c.receivedQty) || Number(c.consumedQty) || (c.source === 'CONSUMED' ? (Number(getItemEffectiveQty(it)) || 0) : 0)); });
        });
        // CX11 (R22): revenue of a foreign-currency order is converted to L.E. at the order's own rate; costs are L.E. already.
        const fxRate = (o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1;
        o.totalPriceOrderCurrency = r2c(net);
        o.totalPrice = r2c(net * fxRate);
        o.totalRealCost = r2c(cost);
        // CX12: a cancelled (rejected) order carries no revenue and no cost in the report rows.
        if (o.status === OrderStatus.REJECTED) { o.totalPrice = 0; o.totalPriceOrderCurrency = 0; o.totalRealCost = 0; }
    });
    // R29 (revenue part superseded 2026-10-21: revenue is the NET call-off line total; cost stays on company payments): a blanket contract counts as current in the report.
    // Revenue = customer payments received on the contract; cost = supplier payments for the contract and its call-offs
    // (plus ledger expenses booked to them). The call-off rows keep their line values but are left out of the totals (their money is in the contract).
    const isBlanketRoot = (o) => Boolean(o.blanketOrder) && !o.blanketContractId;
    // OS04 ruling (2026-10-21): a blanket OUTSOURCING contract reports revenue as the total of its net line values and cost from its components (not paid money).
    // User ruling 2026-10-21: revenue shown by the app is always the NET total of line values; payments stay in wallet/cash/AR figures only.
    const isOutsourcingBlanket = (o) => isBlanketRoot(o) && (o.items || []).length > 0 && (o.items || []).every(it => it.productionType === 'OUTSOURCING');
    // Blanket revenue = NET total of the line values actually called off (call-off lines; the contract's own lines when nothing was called off yet).
    const blanketNetRevenue = (root) => { const co = callOffsOfBlanket(root, enrichedOrders); return r2c(co.length ? co.reduce((t, x) => t + (Number(x.totalPrice) || 0), 0) : (root.contractClosed ? 0 : (Number(root.totalPrice) || 0))); };
    // R34 round 8 (validator 7, defect 4): a CLOSED blanket contract with nothing called off has revenue (and cost) 0: its own lines
    // are no sale once it is closed (shared/orderMoney.js ownLinesAreSales), the same as Finance > Ledger and Profitability.
    // R34 round 7 (validator 6, defect 4): the same blanket revenue in the CONTRACT currency for revenueByCurrency (USD blanket
    // 10 x 100 at rate 50 = USD 1,000, not the L.E. 50,000). A call-off in the contract currency adds its own order-currency
    // value; a call-off in another currency is converted from its L.E. value at the contract rate.
    const blanketNetRevenueOC = (root) => {
        const co = callOffsOfBlanket(root, enrichedOrders);
        if (!co.length) return root.contractClosed ? 0 : r2c(Number(root.totalPriceOrderCurrency) || 0);
        const rootCur = root.currency || 'L.E.';
        const rootFx = (root.currency && root.currency !== 'L.E.' && Number(root.conversionRate) > 0) ? Number(root.conversionRate) : 1;
        return r2c(co.reduce((t, x) => t + ((x.currency || 'L.E.') === rootCur ? (Number(x.totalPriceOrderCurrency) || 0) : (Number(x.totalPrice) || 0) / rootFx), 0));
    };
    const blanketIdsOf = (root) => [root.id, ...callOffsOfBlanket((db.orders || []).find(x => x.id === root.id) || root, db.orders || [], true).map(x => x.id)];
    enrichedOrders.forEach(o => {
        if (o.status === OrderStatus.REJECTED) return;
        if (isOutsourcingBlanket(o)) { o.reportBasis = 'LINES'; const nr = blanketNetRevenue(o); o.totalPrice = nr; o.totalPriceOrderCurrency = blanketNetRevenueOC(o); }
        else if (isBlanketRoot(o)) {
            // User principle 2026-10-21: cost and revenue values never include VAT and never come from payments.
            // Blanket revenue = NET total of the call-off lines; blanket cost = NET component cost of the call-offs (the contract's own lines when nothing was called off).
            const rev = blanketNetRevenue(o);
            const co = callOffsOfBlanket(o, enrichedOrders);
            const cost = co.length ? co.reduce((t, x) => t + (Number(x.totalRealCost) || 0), 0) : (o.contractClosed ? 0 : (Number(o.totalRealCost) || 0));
            o.totalPrice = r2c(rev); o.totalPriceOrderCurrency = blanketNetRevenueOC(o); o.totalRealCost = r2c(cost); o.reportBasis = 'LINES';
        } else if (o.blanketContractId) { o.reportBasis = 'BLANKET_CALL_OFF'; }
    });
    // R34 round 6 (validator 5, O3): an INVOICED order (status INVOICED / HUB_RELEASED, or an invoice number set) is realized revenue as
    // well, the same rule as the Finance > Ledger 'Company Realized Profit' and the Net VAT liability; a USD order counts at its rate
    // in totalRevenue and in its own currency in revenueByCurrency.
    const isInvoicedRep = (o) => [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.WAITING_GOVE, OrderStatus.FULFILLED].includes(o.status) || Boolean(o.invoiceNumber);
    // R34 round 7 (validator 6, defect 3): an internal stock order (customer 'Internal Stock' or PO reference 'STOCK-...') is no sale,
    // even with an invoice number: it is left out of the totals, like the Finance > Ledger realized profit.
    const fulfilledOrders = enrichedOrders.filter(o => !isInternalStockOrder(o) && ((o.status !== OrderStatus.REJECTED && isInvoicedRep(o) && o.reportBasis !== 'BLANKET_CALL_OFF') || o.reportBasis === 'LINES'));
    const totalRevenue = r2c(fulfilledOrders.reduce((sum, o) => sum + (Number(o.totalPrice) || 0), 0));
    const totalRealCost = r2c(fulfilledOrders.reduce((sum, o) => sum + (Number(o.totalRealCost) || 0), 0));
    const count = enrichedOrders.length;

    const revenueByCurrency = {};
    fulfilledOrders.forEach(o => { const cur = o.currency || 'L.E.'; revenueByCurrency[cur] = r2c((revenueByCurrency[cur] || 0) + (Number(o.totalPriceOrderCurrency) || 0)); });
    res.json({
        count,
        revenueByCurrency,
        totalRevenue,
        totalRealCost,
        grossProfit: totalRevenue - totalRealCost,
        profitMarginPct: totalRevenue > 0 ? ((totalRevenue - totalRealCost) / totalRevenue) * 100 : 0,
        orders: enrichedOrders
    });
});

// CX14: a tax settlement entry needs a positive numeric amount and the finance role (management alone is refused).
app.post('/api/v1/ledger', (req, res, next) => {
    const body = req.body || {};
    if (String(body.category || '') !== 'Tax Settlement') return next();
    const amt = Number(body.amount);
    if (body.amount === undefined || body.amount === null || body.amount === '' || !Number.isFinite(amt)) return res.status(400).json({ error: 'Refused: Amount must be a number' });
    if (!(amt > 0)) return res.status(400).json({ error: 'Refused: Amount must be greater than zero' });
    const roles = Array.isArray(req.roles) ? req.roles : [];
    if (roles.length && !roles.includes('finance') && !roles.includes('admin')) return res.status(403).json({ error: 'Refused: tax settlements are finance' });
    return next();
});

// --- R34 (user order 2026-11-08): FINANCE INITIAL BALANCES, ACCOUNT BALANCES, STOCK VALUE ---
// Every account used by the finance ledger is listed with its current balance (the app's own figure) plus the opening
// balances the finance user booked on it. An opening balance is a signed whole-unit DELTA added to the current balance,
// stored as an immutable ledger entry (type OPENING, category 'Opening Balance') with who / when / account / amount /
// reason / old and new balance. It is entered in two steps: review (no write, returns a one-time token) and confirm.
// Customer general (Self) and project general wallets are stored buckets: the delta is also added to the bucket so the
// existing refund / transfer / pay-from-wallet checks see it. All other accounts add the OPENING sum in their compute
// (PO wallet, AR, AP, supplier general wallet, Cash/Bank, taxes, other ledger accounts).
const FIN_OPENING_CATEGORY = 'Opening Balance';
const FIN_REVIEW_TTL_MS = 10 * 60 * 1000;
const finReviewTokens = new Map(); // token -> { user, dbPath, accountKey, amount, reason, oldBalance, expires }
const finRolesOf = (req) => {
    if (Array.isArray(req.roles) && req.roles.length) return req.roles;
    const name = String(req.headers['x-user'] || '').trim().toLowerCase();
    if (!name) return [];
    const find = (db) => (db.users || []).find(u => String(u.username || '').toLowerCase() === name);
    const u = find(readDb(DB_PATH)) || (req.sandboxDbPath ? find(readDb(req.sandboxDbPath)) : null);
    return u ? (u.roles || []) : [];
};
const finIsInternalCustomerName = (n) => String(n || '').trim().toLowerCase() === 'internal stock';
const finIsInternalOrder = isInternalStockOrder; // R34 round 5 (item 7): shared helper
const FIN_INVOICED = ['INVOICED', 'HUB_RELEASED', 'DELIVERED', 'WAITING_GOVE', 'FULFILLED'];
// Cash/Bank (R34 round 2, D1): shared/cashBank.js, the same formula as the Finance ledger tab (customer cash on POs +
// customer advances - customer refunds + manual additions - supplier payments - manual costs).
const finCashBankBase = (db) => computeCashBank(db.orders || [], db.ledger || [], db.supplierPayments || []).balance;
// VAT: the same formula as the Finance ledger tab (output VAT on invoiced orders - input VAT - tax paid to the authority).
const finVatBase = (db) => {
    let outTax = 0, inTax = 0;
    (db.orders || []).forEach(o => {
        if (o.status === OrderStatus.REJECTED || finIsInternalOrder(o)) return;
        const rate = (o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1;
        let oOut = 0, oIn = 0;
        // R34 round 6 (validator 5, O5): a closed blanket contract's own lines are no sale (only what was called off is; the call-offs
        // of a closed contract are realized), so closing it no longer books the VAT of the whole contract quantity.
        const salesLines = ownLinesAreSales(o);
        (o.items || []).forEach(it => {
            const lineNet = salesLines ? getItemEffectiveQty(it) * (it.pricePerUnit || 0) : 0;
            oOut += lineNet * ((it.taxPercent !== undefined ? it.taxPercent : 14) / 100);
            // R34 round 7 (validator 6, defect 6): the BoM of a closed blanket contract's own lines is no realized cost either (its
            // call-offs carry the real components), so no input VAT is taken from it.
            if (salesLines) (it.components || []).forEach(c => { oIn += ((c.quantity || 0) * (c.unitCost || 0)) * ((c.taxPercent !== undefined ? c.taxPercent : 0) / 100); });
        });
        // R34 round 4 (validator 3, D3): the output VAT of a foreign-currency order is converted at the order rate (prices are in the
        // order currency); procurement costs and their input VAT are already in L.E. (ruling R22 C23), they are not converted.
        inTax += oIn;
        if (isRealizedSale(o, db.orders || [])) outTax += oOut * rate;
    });
    const paid = (db.ledger || []).filter(e => e.type === 'COST' && (e.category === 'Tax Settlement' || e.category === 'Tax Payment' || String(e.toAccount || '').toLowerCase().includes('tax') || String(e.toAccount || '').includes('ضرائب'))).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return r2w(outTax - inTax - paid);
};
// Map a ledger account label to an account key of the registry (labels the app itself writes).
const finLabelToKey = (label, db) => {
    const l = String(label || '').trim();
    if (!l) return null;
    if (l === 'Bank Account' || l === 'Cash/Bank') return 'BANK';
    if (l === 'Tax Authority / Withholding') return 'TAX_WHT';
    const m = l.match(/^Customer (.+) \/ (Self|Project (.+)|PO (.+))$/);
    if (m) {
        const cust = (db.customers || []).find(c => c.name === m[1]);
        if (cust && m[2] === 'Self') return `CUST_SELF:${cust.id}`;
        if (cust && m[3]) return `CUST_PROJECT:${cust.id}:${m[3]}`;
        if (m[4]) { const o = (db.orders || []).find(x => x.customerName === m[1] && x.internalOrderNumber === m[4]); if (o) return `PO:${o.id}`; }
    }
    const sm = l.match(/^Supplier (.+) \/ Advance$/);
    if (sm) { const s = (db.suppliers || []).find(x => x.name === sm[1]); if (s) return `SUP_GEN:${s.id}`; }
    if (l === 'Accounts Payable') return 'AP_ALL';
    // D5: internal labels the app writes for its own bookkeeping are not other ledger accounts:
    // 'Customer Deposit' (source of a customer advance; the money sits in the customer general / project wallet),
    // 'Customer X / Withholding held by customer' (display line of the 1% withholding; it is the Tax Authority / Withholding account),
    // a customer or supplier sub-account whose customer / PO / supplier is no longer found (renamed or deleted),
    // and the tax authority (tax payments are part of the Net VAT liability).
    if (l === 'Customer Deposit') return 'INTERNAL';
    if (/^Customer .+ \/ Withholding held by customer$/.test(l)) return 'TAX_WHT_HELD';
    if (/^Customer .+ \/ (Self|Project .+|PO .+)$/.test(l) || /^Supplier .+ \/ Advance$/.test(l)) return 'INTERNAL';
    if (l === 'Tax Authority' || l.includes('ضرائب')) return 'TAX_VAT';
    return `LEDGER:${l}`;
};
// Build the full account list with balances. Groups: company, customer, supplier, ledger.
const computeFinanceAccounts = (db) => {
    const ledger = db.ledger || [];
    const orders = db.orders || [];
    const sps = db.supplierPayments || [];
    const accounts = [];
    const openCount = new Map();
    ledger.forEach(l => { if (l && l.type === 'OPENING' && l.accountKey) openCount.set(l.accountKey, (openCount.get(l.accountKey) || 0) + 1); });
    const push = (a) => { const opening = openingSumFor(ledger, a.key); accounts.push({ ...a, balance: r2w(a.balance), openingTotal: opening, openingCount: openCount.get(a.key) || 0 }); };
    // Company accounts
    push({ key: 'BANK', group: 'company', kind: 'asset', label: 'Cash / Bank', labelAr: 'النقدية / البنك', balance: finCashBankBase(db) + openingSumFor(ledger, 'BANK') });
    push({ key: 'TAX_VAT', group: 'company', kind: 'liability', label: 'Net VAT liability', labelAr: 'صافي التزام ضريبة القيمة المضافة', balance: finVatBase(db) + openingSumFor(ledger, 'TAX_VAT') });
    const whtFlow = ledger.reduce((s, e) => s + ((e && e.type !== 'OPENING') ? ((e.toAccount === 'Tax Authority / Withholding' ? (Number(e.amount) || 0) : 0) - (e.fromAccount === 'Tax Authority / Withholding' ? (Number(e.amount) || 0) : 0)) : 0), 0);
    push({ key: 'TAX_WHT', group: 'company', kind: 'liability', label: 'Tax Authority / Withholding', labelAr: 'مصلحة الضرائب / الخصم من المنبع', balance: whtFlow + openingSumFor(ledger, 'TAX_WHT') });
    // Customer accounts: general wallet (Self), project general wallets, PO wallets, receivable
    const ar = computeReceivables(orders, ledger, db.customers || []);
    (db.customers || []).filter(c => c && c.name && !finIsInternalCustomerName(c.name)).sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(c => {
        const w = computeCustomerWallet(c, orders, sps, db);
        push({ key: `CUST_SELF:${c.id}`, group: 'customer', kind: 'liability', walletType: 'self', customerId: c.id, customerName: c.name, label: `${c.name} / General wallet`, labelAr: `${c.name} / المحفظة العامة`, balance: Number((w.walletBalances || {})[SELF_WALLET_KEY]) || 0 });
        const projects = new Set();
        Object.keys(c.walletBalances || {}).forEach(k => { const t = k.trim(); if (t && t !== SELF_WALLET_KEY && t !== '(No Project)') projects.add(t); });
        orders.forEach(o => { if (o.customerName === c.name && o.status !== OrderStatus.REJECTED) { const p = orderProjectName(o, orders); if (p) projects.add(p); } });
        Array.from(projects).sort().forEach(p => {
            let stored = 0;
            Object.entries(c.walletBalances || {}).forEach(([k, v]) => { if (k.trim() === p) stored += Number(v) || 0; });
            push({ key: `CUST_PROJECT:${c.id}:${p}`, group: 'customer', kind: 'liability', walletType: 'project', customerId: c.id, customerName: c.name, projectName: p, label: `${c.name} / Project ${p} (general)`, labelAr: `${c.name} / مشروع ${p} (عام)`, balance: stored });
        });
        orders.filter(o => o.customerName === c.name && o.status !== OrderStatus.REJECTED && !finIsInternalOrder(o)).forEach(o => {
            const ow = computeOrderWallet(o, orders, sps, ledger);
            push({ key: `PO:${o.id}`, group: 'customer', kind: 'liability', walletType: 'po', customerId: c.id, customerName: c.name, orderId: o.id, orderNumber: o.internalOrderNumber, projectName: ow.projectName, label: `${c.name} / PO ${o.internalOrderNumber || o.id}`, labelAr: `${c.name} / أمر ${o.internalOrderNumber || o.id}`, balance: ow.walletBalance });
        });
        const arRow = ar.byCustomer.find(r => r.customerName === c.name);
        push({ key: `AR:${c.id}`, group: 'customer', kind: 'asset', walletType: 'ar', customerId: c.id, customerName: c.name, label: `${c.name} / Accounts receivable`, labelAr: `${c.name} / ذمم مدينة`, balance: arRow ? arRow.receivable : 0 });
    });
    // Supplier accounts: general wallet (unallocated advances) and payable
    const ap = computePayables(db);
    (db.suppliers || []).filter(s => s && s.name).sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(s => {
        // D4: an opening on the supplier general wallet is a stored supplier advance (supplierPayments isOpening), so it is part of
        // the unallocated advances (allocation, auto-cover of later POs, refunds use it). Legacy opening entries without a stored record still add.
        const adv = sps.filter(p => p.supplierId === s.id).reduce((t, p) => t + (Number(p.unallocatedAdvance) || 0), 0);
        const legacyOpen = ledger.filter(l => l && l.type === 'OPENING' && l.accountKey === `SUP_GEN:${s.id}` && !l.supplierPaymentId).reduce((t, l) => t + (Number(l.amount) || 0), 0);
        push({ key: `SUP_GEN:${s.id}`, group: 'supplier', kind: 'asset', walletType: 'supplier_general', supplierId: s.id, supplierName: s.name, label: `${s.name} / General wallet`, labelAr: `${s.name} / المحفظة العامة`, balance: adv + legacyOpen });
        const apRow = ap.bySupplier.find(r => r.supplierId === s.id);
        push({ key: `AP:${s.id}`, group: 'supplier', kind: 'liability', walletType: 'ap', supplierId: s.id, supplierName: s.name, label: `${s.name} / Accounts payable`, labelAr: `${s.name} / ذمم دائنة`, balance: apRow ? apRow.payable : 0 });
    });
    // Other ledger accounts: configured accounts plus every other label used in ledger entries. R34 round 4: balance = money taken
    // FROM the account into the company minus money paid TO it (an income account is positive, an expense account negative), the
    // same sign as the Finance > Ledger tab line 'Other ledger entries (net)'; openings add on top.
    const settings = (db.settings || [])[0] || {};
    const other = new Set((settings.ledgerAccounts || []).map(a => String(a).trim()).filter(Boolean));
    ledger.forEach(e => { if (!e || e.type === 'OPENING') return; [e.fromAccount, e.toAccount].forEach(lbl => { const k = finLabelToKey(lbl, db); if (k && k.startsWith('LEDGER:')) other.add(k.slice(7)); }); });
    Array.from(other).sort().forEach(name => {
        const flow = ledger.reduce((s, e) => s + ((e && e.type !== 'OPENING') ? ((String(e.fromAccount || '').trim() === name ? (Number(e.amount) || 0) : 0) - (String(e.toAccount || '').trim() === name ? (Number(e.amount) || 0) : 0)) : 0), 0);
        push({ key: `LEDGER:${name}`, group: 'ledger', kind: 'other', configured: (settings.ledgerAccounts || []).includes(name), label: name, labelAr: name, balance: flow + openingSumFor(ledger, `LEDGER:${name}`) });
    });
    const sum = (f) => r2w(accounts.filter(f).reduce((s, a) => s + a.balance, 0));
    const summary = {
        cashBank: sum(a => a.key === 'BANK'),
        taxes: sum(a => a.key === 'TAX_VAT' || a.key === 'TAX_WHT'),
        customerWallets: sum(a => a.group === 'customer' && ['self', 'project', 'po'].includes(a.walletType)),
        // R34 round 4: the two parts of customerWallets. Outside POs (general + project wallets after rule G1) = the Ledger tab line
        // 'Customer Wallets & Advances'; PO wallets (money paid on a PO minus its supplier cost) sit in AR / open orders there.
        customerWalletsOutsidePOs: sum(a => a.group === 'customer' && ['self', 'project'].includes(a.walletType)),
        poWallets: sum(a => a.group === 'customer' && a.walletType === 'po'),
        receivables: sum(a => a.walletType === 'ar'),
        supplierWallets: sum(a => a.walletType === 'supplier_general'),
        payables: sum(a => a.walletType === 'ap'),
        otherLedger: sum(a => a.group === 'ledger'),
        openingTotal: r2w(ledger.filter(l => l && l.type === 'OPENING').reduce((s, l) => s + (Number(l.amount) || 0), 0)),
        openingCount: ledger.filter(l => l && l.type === 'OPENING').length
    };
    return { accounts, summary };
};
const finAccountByKey = (db, key) => computeFinanceAccounts(db).accounts.find(a => a.key === key);
const finCheckAmount = (raw) => {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { error: 'Refused: amount is required' };
    // M2: only a real number or a plain decimal string ("1500", "-200", "100.5"); booleans, arrays, objects, hex ("0x10"),
    // exponents ("1e3"), "Infinity" and the like are refused.
    let n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && /^[+-]?\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
    else return { error: 'Refused: amount must be a number' };
    if (!Number.isFinite(n)) return { error: 'Refused: amount must be a number' };
    if (!Number.isInteger(n)) return { error: `Rejected: fraction ${n} is not allowed (whole units only).` };
    if (n === 0) return { error: 'Refused: amount must not be zero' };
    if (Math.abs(n) > 1e12) return { error: 'Refused: amount is too large' };
    return { amount: n };
};

// Read: every account with its balance, plus the stock value. Finance, management and admin.
app.get('/api/v1/finance/position', (req, res) => {
    const roles = finRolesOf(req);
    if (!roles.some(r => ['finance', 'management', 'admin'].includes(r))) return res.status(403).json({ error: 'Refused: the financial position is for finance and management' });
    const db = getDb(req);
    const { accounts, summary } = computeFinanceAccounts(db);
    const stock = computeStockValue(db.inventory || [], db.orders || []);
    res.json({ generatedAt: new Date().toISOString(), accounts, summary, stock, canEnterOpening: roles.includes('finance') });
});
// Audit list of the opening balances.
app.get('/api/v1/finance/opening-balances', (req, res) => {
    const roles = finRolesOf(req);
    if (!roles.some(r => ['finance', 'management', 'admin'].includes(r))) return res.status(403).json({ error: 'Refused: opening balances are for finance and management' });
    const db = getDb(req);
    res.json((db.ledger || []).filter(l => l && l.type === 'OPENING').sort((a, b) => String(b.date).localeCompare(String(a.date))));
});
// Step 1 of 2: review. Nothing is written; returns the old balance, the delta, the new balance and a one-time token.
app.post('/api/v1/finance/opening-balances/review', (req, res) => {
    const roles = finRolesOf(req);
    if (!roles.includes('finance')) return res.status(403).json({ error: 'Refused: only finance users may enter opening balances' });
    const { accountKey, amount, reason } = req.body || {};
    const chk = finCheckAmount(amount);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const why = String(reason || '').trim();
    if (why.length < 3) return res.status(400).json({ error: 'Refused: a reason is required (at least 3 characters)' });
    const db = getDb(req);
    const acc = finAccountByKey(db, String(accountKey || ''));
    if (!acc) return res.status(404).json({ error: `Refused: unknown account ${accountKey || '(none)'}` });
    const token = `obr_${Date.now()}_${crypto.randomBytes(9).toString('hex')}`;
    const user = String(req.headers['x-user'] || 'System');
    const now = Date.now();
    finReviewTokens.forEach((v, k) => { if (v.expires < now) finReviewTokens.delete(k); });
    finReviewTokens.set(token, { user, dbPath: getDbPath(req), accountKey: acc.key, amount: chk.amount, reason: why, oldBalance: acc.balance, expires: now + FIN_REVIEW_TTL_MS });
    res.json({ reviewToken: token, accountKey: acc.key, account: acc.label, accountAr: acc.labelAr, oldBalance: acc.balance, delta: chk.amount, newBalance: r2w(acc.balance + chk.amount), reason: why, expiresAt: new Date(now + FIN_REVIEW_TTL_MS).toISOString() });
});
// Step 2 of 2: confirm. Needs the token of step 1 and confirm: true; the balance must not have changed since the review.
app.post('/api/v1/finance/opening-balances/confirm', (req, res) => {
    const roles = finRolesOf(req);
    if (!roles.includes('finance')) return res.status(403).json({ error: 'Refused: only finance users may enter opening balances' });
    const { reviewToken, confirm } = req.body || {};
    if (confirm !== true) return res.status(400).json({ error: 'Refused: the second confirmation is missing (confirm must be true)' });
    const rv = reviewToken ? finReviewTokens.get(String(reviewToken)) : null;
    if (!rv) return res.status(400).json({ error: 'Refused: no review found for this confirmation (review the amount first)' });
    const user = String(req.headers['x-user'] || 'System');
    if (rv.user !== user || rv.dbPath !== getDbPath(req)) return res.status(403).json({ error: 'Refused: the review belongs to another user or environment' });
    if (rv.expires < Date.now()) { finReviewTokens.delete(String(reviewToken)); return res.status(400).json({ error: 'Refused: the review expired, review the amount again' }); }
    const db = getDb(req);
    const acc = finAccountByKey(db, rv.accountKey);
    if (!acc) { finReviewTokens.delete(String(reviewToken)); return res.status(404).json({ error: 'Refused: the account no longer exists' }); }
    if (Math.abs(acc.balance - rv.oldBalance) > 0.004) { finReviewTokens.delete(String(reviewToken)); return res.status(409).json({ error: `Refused: the balance changed since the review (was ${rv.oldBalance.toFixed(2)}, now ${acc.balance.toFixed(2)}); review again` }); }
    finReviewTokens.delete(String(reviewToken));
    const newBalance = r2w(acc.balance + rv.amount);
    const entry = {
        id: `ob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        date: new Date().toISOString(),
        type: 'OPENING',
        category: FIN_OPENING_CATEGORY,
        amount: rv.amount,
        accountKey: acc.key,
        account: acc.label,
        description: `Opening balance ${rv.amount > 0 ? '+' : ''}${rv.amount.toFixed(2)} on ${acc.label} - ${rv.reason}`,
        reason: rv.reason,
        fromAccount: 'Opening Balance Equity',
        toAccount: acc.label,
        oldBalance: acc.balance,
        newBalance,
        user,
        customerName: acc.customerName || undefined,
        openingOrderNumber: acc.orderNumber || undefined,
        supplierId: acc.supplierId || undefined,
        openingOrderId: acc.orderId || undefined
    };
    // Stored wallet buckets (customer Self / project general) carry the delta too, so refunds and transfers see it.
    if (acc.walletType === 'self' || acc.walletType === 'project') {
        const c = (db.customers || []).find(x => x.id === acc.customerId);
        if (!c) return res.status(404).json({ error: 'Refused: customer not found' });
        const bucket = acc.walletType === 'self' ? SELF_WALLET_KEY : acc.projectName;
        c.walletBalances = c.walletBalances || {};
        c.walletBalances[bucket] = r2w((Number(c.walletBalances[bucket]) || 0) + rv.amount);
        c.walletBalance = r2w((Number(c.walletBalance) || 0) + rv.amount);
        c.logs = c.logs || [];
        c.logs.push(createAuditLog(`Opening balance ${rv.amount.toFixed(2)} L.E. on ${acc.label} (${rv.reason})`, 'OPENING_BALANCE', user));
    }
    // D4 (validator 2026-11-08): an opening on a supplier general wallet is stored as a supplier advance (no cash, isOpening) so
    // Allocate, the automatic cover of the supplier's later POs (ruling 2026-10-22) and supplier refunds work on it.
    if (acc.walletType === 'supplier_general') {
        const sup = (db.suppliers || []).find(x => x.id === acc.supplierId);
        if (!sup) return res.status(404).json({ error: 'Refused: supplier not found' });
        const spRec = { id: `sp_open_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, supplierId: sup.id, supplierName: sup.name, amount: rv.amount, isOpening: true, date: entry.date, memo: `Opening balance - ${rv.reason}`, user, unallocatedAdvance: rv.amount, allocations: [], autoCover: rv.amount > 0 ? true : undefined, openingLedgerId: entry.id };
        if (!db.supplierPayments) db.supplierPayments = [];
        db.supplierPayments.push(spRec);
        entry.supplierPaymentId = spRec.id;
    }
    if (!db.ledger) db.ledger = [];
    db.ledger.push(entry);
    if (!writeDb(db, getDbPath(req))) return res.status(503).json({ error: 'Refused: the database is read-only, nothing was saved' });
    const after = finAccountByKey(db, acc.key);
    res.json({ ok: true, entry, account: acc.label, oldBalance: acc.balance, delta: rv.amount, newBalance: after ? after.balance : newBalance });
});
// Opening entries are written only by the two-step flow above and never edited afterwards (audit trail).
app.post('/api/v1/ledger', (req, res, next) => {
    const b = req.body || {};
    if (String(b.type || '').toUpperCase() === 'OPENING' || String(b.category || '') === FIN_OPENING_CATEGORY) return res.status(403).json({ error: 'Refused: opening balances are entered in Finance > Initial balances (review and confirm)' });
    return next();
});
app.put('/api/v1/ledger/:id', (req, res, next) => {
    const db = getDb(req);
    const e = (db.ledger || []).find(l => l && l.id === req.params.id);
    const b = req.body || {};
    if ((e && e.type === 'OPENING') || String(b.type || '').toUpperCase() === 'OPENING' || String(b.category || '') === FIN_OPENING_CATEGORY) return res.status(403).json({ error: 'Refused: opening balance entries cannot be changed; book a new opening delta instead' });
    return next();
});

const COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'notifications', 'settings', 'modules', 'ledger', 'contracts'];
COLLECTIONS.forEach(col => {
    app.get(`/api/v1/${col}`, getCollection(col));
    app.get(`/api/v1/${col}/:id`, getItemFromCollection(col));
    app.post(`/api/v1/${col}`, addToCollection(col));
    app.put(`/api/v1/${col}/:id`, updateInCollection(col));
});

// After a forced live write (restore / wipe): Turso off or push ok -> normal mode;
// push failed -> keep the restored data locally, stay read-only and push it on the next hydrate retry.
const settleForcedLivePush = (push, what) => {
    // Strict: only a confirmed push counts (ok:null = Turso not usable is a failure too).
    if (push && (push.ok === false || (STRICT_REMOTE.on && push.ok !== true))) {
        persistState.pendingForcePush = true;
        if (STRICT_REMOTE.on) persistState.remoteLoaded = false;
        enterReadOnly(`${what} saved locally but the Turso push failed (${push.reason || push.error || push.skipped}); it is pushed on the next retry`);
        return;
    }
    persistState.pendingForcePush = false;
    persistState.hydrated = true;
    persistState.source = what === 'wipe' ? persistState.source : 'restore';
    leaveReadOnly();
};

// Admin: retry the Turso hydrate now (read-only recovery). Returns the health document.
app.post('/api/v1/admin/persistence/retry-hydrate', async (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin only.' });
    await hydrateLiveFromTurso('admin-retry');
    if (!persistState.readOnly) runStartupRepairs();
    res.json(persistenceHealth());
});

app.post('/api/v1/wipe', async (req, res) => {
  if (isSandbox(req)) return res.status(400).json({ error: "Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset." });
  const db = getDb(req);
  db.orders = []; db.customers = []; db.inventory = []; db.notifications = []; db.contracts = []; db.supplierPayments = [];
  // Explicit wipe: forced past the shrink guard (the previous Turso copy is kept as a live.<timestamp> snapshot).
  if (writeDb(db, getDbPath(req), { force: true })) {
    const push = await awaitPush(DB_PATH);
    settleForcedLivePush(push, 'wipe');
    res.json({ message: "Live wipe successful", push });
  }
  else res.status(500).json({ error: "Wipe failed" });
});

app.post('/api/v1/sandbox/reset', async (req, res) => {
  if (!isSandbox(req)) return res.status(400).json({ error: "Must be in sandbox mode." });
  const owner = sanitizeUsername(req.sandboxOwner);
  const currentDb = getDb(req);
  const resetDb = {
    settings: currentDb.settings || [], modules: currentDb.modules || [], userGroups: currentDb.userGroups || [], users: currentDb.users || [],
    orders: [], customers: [], inventory: [], notifications: [], contracts: [], supplierPayments: []
  };
  writeDb(resetDb, getDbPath(req));
  const uploadsDir = getSandboxUploadsPath(owner);
  const snapshotUploadsDir = getSandboxLoginSnapshotUploadsPath(owner);
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  if (fs.existsSync(snapshotUploadsDir)) {
    fs.rmSync(snapshotUploadsDir, { recursive: true, force: true });
  }
  writeSandboxJournal(owner, { loginTime: new Date().toISOString(), addedFiles: [], amendedFiles: [] });

  // Clean Dropbox sandbox directory if configured
  try {
    const settings = resolveSettings(currentDb);
    if (isDropboxConfigured(settings)) {
      const client = getDropboxClient(settings);
      const folder = getDropboxConfig(settings).folderPath;
      await client.filesDeleteV2({ path: `${folder}/sandbox/${owner}` });
    }
  } catch (_) {}

  res.json({ success: true, message: "Sandbox reset successfully." });
});

app.post('/api/v1/sandbox/revert-login', async (req, res) => {
  if (!isSandbox(req)) return res.status(400).json({ error: "Must be in sandbox mode." });
  const owner = sanitizeUsername(req.sandboxOwner);
  const snapshotPath = getSandboxLoginSnapshotPath(owner);
  const sandboxPath = getDbPath(req);
  if (!fs.existsSync(snapshotPath)) {
    return res.status(404).json({ error: "No initial login snapshot found for this sandbox session." });
  }
  try {
    // 1. Revert DB from login snapshot
    const snapshotDb = readDb(snapshotPath);
    writeDb(snapshotDb, sandboxPath);

    // 2. Revert Files from login snapshot & session journal
    const journal = readSandboxJournal(owner);
    const sbUploads = getSandboxUploadsPath(owner);
    const sbSnapshotUploads = getSandboxLoginSnapshotUploadsPath(owner);

    if (fs.existsSync(sbUploads)) {
      fs.rmSync(sbUploads, { recursive: true, force: true });
    }
    if (fs.existsSync(sbSnapshotUploads)) {
      fs.cpSync(sbSnapshotUploads, sbUploads, { recursive: true });
    } else {
      fs.mkdirSync(sbUploads, { recursive: true });
    }

    // 3. Clean up Dropbox session additions if Dropbox is configured
    try {
      const db = getDb(req);
      const settings = resolveSettings(db);
      if (isDropboxConfigured(settings) && journal.addedFiles && journal.addedFiles.length > 0) {
        const client = getDropboxClient(settings);
        const folder = getDropboxConfig(settings).folderPath;
        for (const added of journal.addedFiles) {
          const filePath = typeof added === 'string' ? added : added.path;
          const norm = filePath.replace(/\\/g, '/').replace(/^\/?uploads\//, '');
          const targetDbxPath = `${folder}/${norm}`;
          try {
            await client.filesDeleteV2({ path: targetDbxPath });
            console.log(`[Sandbox Revert] Removed session addition from Dropbox: ${targetDbxPath}`);
          } catch (_) {}
        }
      }
    } catch (dbxRevertErr) {
      console.warn('[Sandbox Revert] Dropbox cleanup warning:', dbxRevertErr.message);
    }

    // 4. Reset journal to clean session baseline
    writeSandboxJournal(owner, { loginTime: new Date().toISOString(), addedFiles: [], amendedFiles: [] });

    console.log(`[Sandbox] Reverted sandbox database and documents for ${owner} to login snapshot`);
    res.json({ success: true, message: "Sandbox reverted to login state successfully." });
  } catch (err) {
    console.error("[Sandbox] Failed to revert to login snapshot:", err);
    res.status(500).json({ error: "Failed to revert to login state." });
  }
});

// --- SANDBOX MEMBERSHIP MANAGEMENT (multi-sandbox collaboration) ---
// All four endpoints operate on `db.sandbox.<sanitized>.json` for the
// target owner passed in `:owner`. Auth requires the caller to be the
// target sandbox's owner OR an administrator in the LIVE database; the
// caller's current environment (live, own sandbox, switched sandbox) is
// irrelevant — these endpoints write to a different file than the one
// the request was resolved against.
//
// The flow lets a sandbox owner (or admin) invite any live user into
// their sandbox pre-emptively, so two users can collaborate in the same
// sandbox with their own dedicated live roles. The middleware then
// resolves tenancy for the invitee on their next login.
const assertCanManageSandbox = (req, targetOwner) => {
  const callerUsername = String(req.headers['x-user'] || req.user || '').trim();
  if (!callerUsername) return { error: 'Unauthorized', status: 401 };
  const liveDb = readDb(DB_PATH);
  const callerUser = (liveDb.users || []).find(u => u.username.toLowerCase() === callerUsername.toLowerCase());
  const isCallerAdmin = callerUser && (callerUser.roles || []).includes('admin');
  const isCallerOwner = sanitizeUsername(callerUsername) === targetOwner;
  if (!isCallerAdmin && !isCallerOwner) {
    return { error: 'Only the sandbox owner or a live administrator can manage this sandbox.', status: 403 };
  }
  return { callerUser };
};

// GET /api/v1/sandbox/:owner/members — list all members of a sandbox
app.get('/api/v1/sandbox/:owner/members', (req, res) => {
  const targetOwner = sanitizeUsername(req.params.owner);
  if (!targetOwner) return res.status(400).json({ error: 'Invalid sandbox owner.' });
  const guard = assertCanManageSandbox(req, targetOwner);
  if (guard.error) return res.status(guard.status).json({ error: guard.error });

  const targetPath = getSandboxDbPath(targetOwner);
  if (!fs.existsSync(targetPath)) return res.json({ members: [], owner: targetOwner, exists: false });

  const sandboxDb = readDb(targetPath);
  const liveDb = readDb(DB_PATH);
  const sandboxUsers = sandboxDb.users || [];
  const members = sandboxUsers.map(u => {
    const liveMatch = (liveDb.users || []).find(lu => lu.username.toLowerCase() === u.username.toLowerCase());
    const { password: _p, logs: _l, ...safe } = u;
    return {
      ...safe,
      liveRoles: liveMatch?.roles || [],
      liveAccess: liveMatch?.liveAccess !== false,
      isOwner: sanitizeUsername(u.username) === targetOwner
    };
  });
  res.json({ members, owner: targetOwner, exists: true });
});

// POST /api/v1/sandbox/:owner/members — invite a live user into the sandbox
// Body: { username: string, sandboxAccess?: boolean }  (sandboxAccess defaults true)
app.post('/api/v1/sandbox/:owner/members', (req, res) => {
  const targetOwner = sanitizeUsername(req.params.owner);
  if (!targetOwner) return res.status(400).json({ error: 'Invalid sandbox owner.' });
  const guard = assertCanManageSandbox(req, targetOwner);
  if (guard.error) return res.status(guard.status).json({ error: guard.error });

  const inviteeUsername = String(req.body.username || '').trim();
  if (!inviteeUsername) return res.status(400).json({ error: 'username is required.' });

  const liveDb = readDb(DB_PATH);
  const liveInvitee = (liveDb.users || []).find(u => u.username.toLowerCase() === inviteeUsername.toLowerCase());
  if (!liveInvitee) return res.status(404).json({ error: `User "${inviteeUsername}" does not exist in the live database.` });

  const targetPath = getSandboxDbPath(targetOwner);
  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `Sandbox for "${targetOwner}" not found. The owner must sign in at least once to bootstrap their sandbox before members can be invited.` });
  }

  const sandboxDb = readDb(targetPath);
  sandboxDb.users = sandboxDb.users || [];
  const sanitizedInvitee = sanitizeUsername(inviteeUsername);
  let memberEntry = sandboxDb.users.find(u => sanitizeUsername(u.username) === sanitizedInvitee);

  // Default sandboxAccess to true on invite; allow override (admin can
  // pre-add a member as inactive if they want).
  const desiredAccess = req.body.sandboxAccess !== undefined ? !!req.body.sandboxAccess : true;

  if (memberEntry) {
    memberEntry.roles = liveInvitee.roles || [];
    memberEntry.groupIds = liveInvitee.groupIds || [];
    memberEntry.name = liveInvitee.name || memberEntry.name;
    memberEntry.email = liveInvitee.email || memberEntry.email;
    if (liveInvitee.password) memberEntry.password = liveInvitee.password;
    memberEntry.sandboxAccess = desiredAccess;
  } else {
    memberEntry = {
      id: liveInvitee.id || ('usr_' + Date.now()),
      username: liveInvitee.username,
      name: liveInvitee.name,
      email: liveInvitee.email,
      password: liveInvitee.password,
      roles: liveInvitee.roles || [],
      groupIds: liveInvitee.groupIds || [],
      sandboxAccess: desiredAccess
    };
    sandboxDb.users.push(memberEntry);
  }

  if (!writeDb(sandboxDb, targetPath)) return res.status(500).json({ error: 'Failed to persist sandbox member change.' });
  const { password: _, logs: __, ...safe } = memberEntry;
  console.log(`[Sandbox] ${targetOwner}: invited "${inviteeUsername}" (sandboxAccess=${desiredAccess})`);
  res.json({ success: true, member: safe });
});

// PATCH /api/v1/sandbox/:owner/members/:username — update sandboxAccess
// Body: { sandboxAccess: boolean }
app.patch('/api/v1/sandbox/:owner/members/:username', (req, res) => {
  const targetOwner = sanitizeUsername(req.params.owner);
  const memberUsername = sanitizeUsername(req.params.username);
  if (!targetOwner || !memberUsername) return res.status(400).json({ error: 'Invalid owner or username.' });
  const guard = assertCanManageSandbox(req, targetOwner);
  if (guard.error) return res.status(guard.status).json({ error: guard.error });

  if (memberUsername === targetOwner) {
    return res.status(400).json({ error: 'The sandbox owner cannot be modified.' });
  }

  const targetPath = getSandboxDbPath(targetOwner);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: `Sandbox for "${targetOwner}" not found.` });

  const sandboxDb = readDb(targetPath);
  const memberEntry = (sandboxDb.users || []).find(u => sanitizeUsername(u.username) === memberUsername);
  if (!memberEntry) return res.status(404).json({ error: `User "${memberUsername}" is not a member of sandbox "${targetOwner}".` });

  if (req.body.sandboxAccess !== undefined) {
    memberEntry.sandboxAccess = !!req.body.sandboxAccess;
  }

  if (!writeDb(sandboxDb, targetPath)) return res.status(500).json({ error: 'Failed to persist sandbox member change.' });
  const { password: _, logs: __, ...safe } = memberEntry;
  console.log(`[Sandbox] ${targetOwner}: set "${memberUsername}" sandboxAccess=${memberEntry.sandboxAccess}`);
  res.json({ success: true, member: safe });
});

// DELETE /api/v1/sandbox/:owner/members/:username — soft revoke (sandboxAccess: false)
// Soft delete keeps the row so re-inviting later preserves identity history
// (same convention as the sandbox middleware auto-provision flow).
app.delete('/api/v1/sandbox/:owner/members/:username', (req, res) => {
  const targetOwner = sanitizeUsername(req.params.owner);
  const memberUsername = sanitizeUsername(req.params.username);
  if (!targetOwner || !memberUsername) return res.status(400).json({ error: 'Invalid owner or username.' });
  const guard = assertCanManageSandbox(req, targetOwner);
  if (guard.error) return res.status(guard.status).json({ error: guard.error });

  if (memberUsername === targetOwner) {
    return res.status(400).json({ error: 'The sandbox owner cannot be removed.' });
  }

  const targetPath = getSandboxDbPath(targetOwner);
  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: `Sandbox for "${targetOwner}" not found.` });

  const sandboxDb = readDb(targetPath);
  const memberEntry = (sandboxDb.users || []).find(u => sanitizeUsername(u.username) === memberUsername);
  if (!memberEntry) return res.status(404).json({ error: `User "${memberUsername}" is not a member of sandbox "${targetOwner}".` });

  memberEntry.sandboxAccess = false;

  if (!writeDb(sandboxDb, targetPath)) return res.status(500).json({ error: 'Failed to persist sandbox member change.' });
  console.log(`[Sandbox] ${targetOwner}: revoked "${memberUsername}"`);
  res.json({ success: true });
});


app.post('/api/v1/orders/:id/dispatch-action', async (req, res) => {
    const { action, payload } = req.body;
    if (action === 'record-payment' && payload && payload.fromWallet) {
        const gateP = customerMoneyGate(req, 'paying from the customer wallet', PAYMENT_MONEY_ROLES);
        if (gateP) return res.status(403).json({ error: gateP });
    }
    const db = getDb(req);
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
            // R21 (C08): remember what was already booked to stock for this component, so handleStockReceipts
            // does not add the full quantity a second time when the component status becomes RECEIVED.
            comp.stockBooked = (Number(comp.stockBooked) || 0) + qtyToIncr;
            // Migrate legacy
            if (invItem.quantity !== undefined) delete invItem.quantity;
            invItem.lastCost = comp.unitCost || invItem.lastCost || 0;
            invItem.lastUpdated = new Date().toISOString();
            invItem.poNumber = comp.poNumber;
            invItem.orderRef = order.internalOrderNumber;
            if (!invItem.logs) invItem.logs = [];
            invItem.logs.push({
                timestamp: new Date().toISOString(),
                message: `Received ${qtyToIncr} ${comp.unit || invItem.unit || 'pcs'} from PO ${comp.poNumber || 'N/A'} (Order ${order.internalOrderNumber || order.customerReferenceNumber || 'N/A'})`,
                status: 'RECEIVED',
                user: 'System'
            });
            console.log(`[Inventory] Received: ${invItem.description}. Incoming: ${qtyToIncr}. Stock: ${invItem.quantityInStock}, Rsrv: ${invItem.quantityReserved}`);
        } else if (action === 'RELEASE') {
            if (invItem && (invItem.quantityReserved || 0) > 0) {
                invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - (comp.quantity || 0));
                invItem.lastUpdated = new Date().toISOString();
                console.log(`[Inventory] Released Stock: ${invItem.description}. New Rsrv: ${invItem.quantityReserved}`);
            }
        }
    };

    // --- RELEASES RECEIVED ITEMS FROM CUSTOMER RESERVATION TO GENERAL WAREHOUSE COMPONENT STOCK ---
    const transferReceivedItemsToFreeStock = (order, db, reason, user, specificCompId = null) => {
        if (!db.inventory) db.inventory = [];

        (order.items || []).forEach(item => {
            // 1. Customer Trading Items received to Product Hub (move from Product Stock to Component Stock)
            const isTrading = item.productionType === 'TRADING';
            const hubQty = Math.max(0, (Number(item.hubReceivedQty) || 0) - (item.components || []).filter(c => c.viaWarehouse && (!specificCompId || c.id === specificCompId)).reduce((a, c) => a + Math.max(0, (Number(c.receivedQty) || 0)), 0));
            if (isTrading && hubQty > 0 && (!specificCompId || (item.components || []).some(c => c.id === specificCompId))) {
                const sku = item.orderNumber || (item.components && item.components[0]?.componentNumber) || (item.components && item.components[0]?.supplierPartNumber) || `SKU-${Date.now()}`;
                const desc = item.description || (item.components && item.components[0]?.description) || 'Trading Item';
                const unit = item.unit || (item.components && item.components[0]?.unit) || 'pcs';
                const cost = (item.components && item.components[0]?.unitCost) || item.realCost || item.pricePerUnit || 0;

                let invItem = db.inventory.find(i => (i.sku && sku && i.sku.toLowerCase() === sku.toLowerCase()) || (i.description && desc && i.description.toLowerCase() === desc.toLowerCase()));
                if (invItem) {
                    invItem.quantityInStock = (Number(invItem.quantityInStock) || 0) + hubQty;
                    invItem.lastCost = cost || invItem.lastCost || 0;
                    invItem.lastUpdated = new Date().toISOString();
                    delete invItem.orderRef;
                    delete invItem.poNumber;
                } else {
                    invItem = {
                        id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        sku: sku,
                        description: desc,
                        quantityInStock: hubQty,
                        quantityReserved: 0,
                        category: 'Mechanical',
                        unit: unit,
                        lastCost: cost,
                        minStockLevel: 0,
                        lastUpdated: new Date().toISOString()
                    };
                    db.inventory.push(invItem);
                }

                if (!invItem.logs) invItem.logs = [];
                invItem.logs.push({
                    timestamp: new Date().toISOString(),
                    message: `Transferred ${hubQty} ${unit} from Product Hub (Customer Order ${order.internalOrderNumber || order.customerReferenceNumber || 'N/A'}) to General Component Stock due to ${reason}.`,
                    status: 'RELEASED_TO_STOCK',
                    user: user || 'System'
                });

                console.log(`[Inventory Transfer] Transferred Trading Product to Component Stock: ${desc} (${hubQty} ${unit}). New Stock: ${invItem.quantityInStock}`);
                item.hubReceivedQty = 0;
            }

            // 2. Manufacturing / Standard Components
            (item.components || []).forEach(comp => {
                if (specificCompId && comp.id !== specificCompId) return;

                const receivedQty = Number(comp.receivedQty) || (['RECEIVED', 'STOCKED', 'RESERVED'].includes(comp.status) ? Number(comp.quantity) || 0 : 0);
                // v1.0001217 (CX06): a received outsourced service (procurement part of an Outsourcing line) never entered the warehouse
                // (receive-component books no inventory for it), so it is not released to stock either: no inventory row, no stock
                // movement; its received quantity stays on the component (the supplier ledger keeps the delivered value).
                if (receivedQty > 0 && !isStockOrder(order) && item.productionType === 'OUTSOURCING' && comp.source !== 'STOCK') {
                    if (!order.logs) order.logs = [];
                    order.logs.push(createAuditLog(`Service receipt kept: ${receivedQty} ${comp.unit || 'period'} of ${comp.description} (PO: ${comp.poNumber || 'N/A'}) is a delivered service, not stock; nothing is moved to the warehouse (${reason}).`, order.status, user || 'System'));
                    return;
                }
                if (receivedQty > 0) {
                    let invItem = db.inventory.find(i => i.id === comp.inventoryItemId);
                    if (!invItem) {
                        invItem = db.inventory.find(i => (i.sku && comp.componentNumber && i.sku.toLowerCase() === comp.componentNumber.toLowerCase()) || (i.description && comp.description && i.description.toLowerCase() === comp.description.toLowerCase()));
                    }

                    if (invItem) {
                        // Release customer reservation
                        if (!isStockOrder(order) || comp.source === 'STOCK') invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - receivedQty);
                        invItem.lastCost = comp.unitCost || invItem.lastCost || 0;
                        invItem.lastUpdated = new Date().toISOString();
                        // Unlink from customer order
                        delete invItem.orderRef;
                        delete invItem.poNumber;
                    } else {
                        invItem = {
                            id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            sku: comp.componentNumber || comp.supplierPartNumber || `SKU-${Date.now()}`,
                            description: comp.description,
                            quantityInStock: receivedQty,
                            quantityReserved: 0,
                            category: 'Mechanical',
                            unit: comp.unit || 'pcs',
                            lastCost: comp.unitCost || 0,
                            minStockLevel: 0,
                            lastUpdated: new Date().toISOString()
                        };
                        db.inventory.push(invItem);
                    }

                    if (!invItem.logs) invItem.logs = [];
                    invItem.logs.push({
                        timestamp: new Date().toISOString(),
                        message: `Released from Customer Order ${order.internalOrderNumber || order.customerReferenceNumber || 'N/A'} (PO: ${comp.poNumber || 'N/A'}) to General Component Stock (${receivedQty} ${comp.unit || invItem.unit || 'pcs'}) due to ${reason}.`,
                        status: 'RELEASED_TO_STOCK',
                        user: user || 'System'
                    });

                    console.log(`[Inventory Release] Released Component to Free Stock: ${comp.description} (${receivedQty} ${comp.unit}). Stock: ${invItem.quantityInStock}, Rsrv: ${invItem.quantityReserved}`);
                    // The supplier delivered these goods: the supplier ledger keeps counting them as delivered.
                    comp.releasedToStockQty = (Number(comp.releasedToStockQty) || 0) + receivedQty;
                    comp.receivedQty = 0;
                    delete comp.inventoryItemId;
                }
            });
        });
    };

    // Helper: Get payments allocated to a component
    const getComponentAllocatedPaidAmount = (targetComp) => {
        if (!db.supplierPayments || !targetComp) return 0;
        let paid = 0;
        (db.supplierPayments || []).forEach(sp => {
            const matchesSupplier = targetComp.supplierId ? sp.supplierId === targetComp.supplierId :
                (targetComp.supplierName && sp.supplierName && sp.supplierName.trim().toLowerCase() === targetComp.supplierName.trim().toLowerCase());
            if (matchesSupplier) {
                let allocFound = false;
                (sp.allocations || []).forEach(alloc => {
                    if (alloc.componentId === targetComp.id) {
                        paid += (alloc.amount || 0);
                        allocFound = true;
                    }
                });
            }
        });
        return Math.round(paid * 100) / 100;
    };

    // Helper: Execute Case 1 (Standard PO Cancel) or Case 2 (PO Extension & Amendment)
    // opts.orderCancelled (v1.0001217, reject-order only): the customer order is cancelled, opts.receivedQty is what the supplier delivered
    // on this PO (captured before the cancel released goods to free stock). The PO is amended to the delivered quantity (or kept as it is when
    // everything was delivered), the supplier link and the delivered value stay, and no leftover component is created (nothing is re-procured
    // for a cancelled order). Money paid on the PO was already released to the supplier general wallet by releaseSupplierAllocationsOfOrder.
    const executeComponentPoCancelOrExtension = (item, comp, cancelReason, isExtension, opts = {}) => {
        const originalQty = comp.quantity || 0;
        const orderCancelled = Boolean(opts.orderCancelled);
        // delivered on this PO = still held for the order (receivedQty) + already released to free stock by an order cancel (releasedToStockQty, v1.0001217)
        const receivedQty = (opts.receivedQty !== undefined && opts.receivedQty !== null) ? (Number(opts.receivedQty) || 0) : ((Number(comp.receivedQty) || 0) + (Number(comp.releasedToStockQty) || 0));
        const compPaidAmount = getComponentAllocatedPaidAmount(comp);
        const taxRate = comp.taxPercent !== undefined ? comp.taxPercent : 14;
        const grossUnitCost = (comp.unitCost || 0) * (1 + (taxRate / 100));
        const paidUnits = grossUnitCost > 0 ? (compPaidAmount / grossUnitCost) : 0;
        const hasReceivedOrPaid = receivedQty > 0 || compPaidAmount > 0.01;

        if (hasReceivedOrPaid) {
            if (!isExtension) {
                throw new Error(`Cannot cancel PO directly: ${comp.description} has ${receivedQty} units received and/or ${compPaidAmount} L.E. paid. Use PO Extension & Amendment workflow.`);
            }

            // Case 2: System Extension & Amendment superseding original PO
            // R23 (C18): fractional quantities are rejected on a normal PO, so the paid-units quantity is taken in whole units.
            // v1.0001217: on a cancelled customer order the PO keeps only what the supplier delivered (paid money is already back in the supplier general wallet).
            const calculatedNewPoQty = orderCancelled ? receivedQty : Math.max(receivedQty, Math.floor(paidUnits + 1e-9));
            const newPoQty = Math.min(originalQty, calculatedNewPoQty);
            const leftoverQty = orderCancelled ? 0 : Math.max(0, originalQty - newPoQty);

            const oldPoNumber = comp.poNumber || 'N/A';
            if (orderCancelled && newPoQty >= originalQty) {
                // everything was delivered: the PO stays exactly as issued (no amendment), supplier link and delivered value kept
                comp.statusUpdatedAt = new Date().toISOString();
                if (!(!isStockOrder(order) && item.productionType === 'OUTSOURCING')) comp.status = 'IN_STOCK'; // goods were released to free stock by the cancel; a service keeps its contract status (CX06)
                comp.lastAction = 'KEPT_ON_ORDER_CANCEL';
                comp.lastActionComment = cancelReason;
                order.logs.push(createAuditLog(
                    `Supplier PO ${oldPoNumber} kept for: ${comp.description} (all ${originalQty} units delivered; supplier and delivered value stay on the PO). Reason: ${cancelReason}`,
                    order.status,
                    user
                ));
                return { type: 'KEPT', comp, originalQty, newPoQty, leftoverQty: 0, newCompCreated: null };
            }
            comp.originalPoQuantity = originalQty;
            comp.quantity = newPoQty;
            comp.isExtension = true;
            comp.supersededOriginalPo = true;
            comp.supersededPoNumber = oldPoNumber;
            comp.extensionReason = cancelReason;
            comp.extendedAt = new Date().toISOString();
            comp.statusUpdatedAt = new Date().toISOString();

            if (orderCancelled) {
                if (!(!isStockOrder(order) && item.productionType === 'OUTSOURCING')) comp.status = 'IN_STOCK'; // goods were released to free stock by the cancel; a service keeps its contract status (CX06)
                comp.lastAction = 'KEPT_ON_ORDER_CANCEL';
                comp.lastActionComment = cancelReason;
            } else if (receivedQty >= newPoQty) {
                comp.status = isStockOrder(order) ? 'STOCKED' : (item.productionType === 'TRADING' ? 'Manufactured' : 'RESERVED');
            } else {
                comp.status = 'ORDERED';
            }

            // If there are leftover quantities, create a new pending procurement component for the customer order
            let newCompCreated = null;
            if (leftoverQty > 0.0001) {
                const newCompId = `c_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                newCompCreated = {
                    id: newCompId,
                    componentNumber: comp.componentNumber || `COMP-${Date.now().toString().slice(-4)}`,
                    description: comp.description,
                    unit: comp.unit || 'pcs',
                    quantity: leftoverQty,
                    unitCost: 0,
                    taxPercent: comp.taxPercent !== undefined ? comp.taxPercent : 14,
                    source: 'PROCUREMENT',
                    status: 'PENDING_OFFER',
                    statusUpdatedAt: new Date().toISOString(),
                    procurementStartedAt: new Date().toISOString(),
                    splitFromExtensionPo: oldPoNumber,
                    splitReason: cancelReason
                };
                if (!item.components) item.components = [];
                item.components.push(newCompCreated);
            }

            order.logs.push(createAuditLog(
                `PO ${oldPoNumber} amended via extension: ${comp.description} adjusted from ${originalQty} to ${newPoQty} units (superseding original PO). ${leftoverQty > 0.0001 ? `Remaining ${leftoverQty} units returned to Procurement (PENDING_OFFER). ` : ''}${orderCancelled ? `Order cancelled: the ${newPoQty} delivered units stay on the PO with the supplier; the undelivered ${originalQty - newPoQty} units are cancelled (nothing re-procured). ` : ''}Reason: ${cancelReason}`,
                order.status,
                user
            ));

            return { type: 'EXTENSION', comp, originalQty, newPoQty, leftoverQty, newCompCreated };
        } else {
            // Case 1: No items received and no payments made - standard cancellation
            transferReceivedItemsToFreeStock(order, db, `Supplier PO Cancellation: ${cancelReason}`, user, comp.id);

            const oldPoNumber = comp.poNumber || 'N/A';
            const oldSupplier = comp.supplierName || comp.supplierId || 'N/A';

            comp.cancelledPoNumber = oldPoNumber;
            comp.cancellationReason = cancelReason;
            comp.lastAction = 'CANCELLED';
            comp.lastActionComment = cancelReason;
            delete comp.revertReason;
            comp.status = 'PENDING_OFFER';
            comp.statusUpdatedAt = new Date().toISOString();
            comp.procurementStartedAt = new Date().toISOString();
            delete comp.supplierId;
            delete comp.supplierName;
            delete comp.poNumber;
            delete comp.sendPoId;
            delete comp.contractStartDate;
            delete comp.contractNumber;
            delete comp.awardId;
            delete comp.rfpId;
            delete comp.rfpSupplierIds;
            delete comp.quotedCurrency;
            delete comp.cost;
            comp.unitCost = 0;

            order.logs.push(createAuditLog(
                `Supplier PO cancelled for: ${comp.description} (PO: ${oldPoNumber}, Supplier: ${oldSupplier}). Reason: ${cancelReason}. Component reset to PENDING_OFFER for re-procurement.`,
                'CANCELLED',
                user
            ));

            return { type: 'CANCELLED', comp, originalQty, leftoverQty: originalQty };
        }
    };

    try {
        // Save a copy of the order BEFORE any modifications for proper reconciliation
        const oldOrder = JSON.parse(JSON.stringify(order));

        if (!/rollback|reject|hold/.test(String(action))) touchByTechReview(order, user, db, `acted on the order (${action})`);
        // R30 (23:00): whole units only, everywhere a quantity is entered (blanket orders and call-offs too).
        if (payload) {
            const qs = [];
            ['qty', 'quantity', 'newQty', 'allocateQty', 'remainderQty'].forEach(k => payload[k] !== undefined && payload[k] !== null && qs.push(payload[k]));
            ['items', 'receipts', 'lines'].forEach(k => (Array.isArray(payload[k]) ? payload[k] : []).forEach(x => x && ['qty', 'quantity', 'deliveredQty', 'shipQty'].forEach(f => x[f] !== undefined && qs.push(x[f]))));
            if (payload.updates && payload.updates.quantity !== undefined) qs.push(payload.updates.quantity);
            if (payload.component && payload.component.quantity !== undefined) qs.push(payload.component.quantity);
            const bad = firstFraction(qs);
            if (bad !== undefined) throw new Error(`Fractional quantity ${bad} is not allowed (whole units only).`);
        }
        // R30 (23:00): a LOGGED / cancelled order has nothing manufactured or reserved, so production, invoice and delivery are refused.
        if ([OrderStatus.LOGGED, OrderStatus.REJECTED, OrderStatus.TECHNICAL_REVIEW, OrderStatus.NEGATIVE_MARGIN].includes(order.status) &&
            ['start-production', 'register-manufacturing', 'consume-factory-component', 'finish-production', 'receive-hub', 'receive-hub-partial', 'issue-invoice', 'approve-dispatch-receipt', 'release-delivery', 'ship-items', 'confirm-delivery', 'request-einvoice', 'attach-einvoice'].includes(action) && !isStockOrder(order)) {
            throw new Error(`Refused: ${action} is not possible on an order in ${order.status} status (nothing manufactured or reserved).`);
        }
        // v1.0001217: a cancelled order receives nothing more; the supplier POs it kept hold only what was delivered before the cancel.
        // v1.0001218 (validator G1): internal stock orders too (a STOCK- order cancelled after 4 of 10 took a second receipt: stock 8, delivered 875.52 on 437.76, REJECTED -> FULFILLED).
        if (order.status === OrderStatus.REJECTED && action === 'receive-component') {
            throw new Error('Refused: receive-component is not possible on a cancelled (REJECTED) order; its supplier POs keep only what was delivered before the cancel.');
        }
        { const denied = actionRoleDenied(req, action); if (denied) return res.status(403).json({ error: denied }); }
        switch (action) {
            case 'finalize-study':
                if (order.items.some(it => !it.isAccepted)) throw new Error("All items must be accepted before finalizing study");
                
                // Ensure all items have their procurement components and transition properly
                order.items.forEach((item, idx) => {
                    const isOutsourcing = item.productionType === 'OUTSOURCING';
                    let metrics = { resourceCount: 0, realCost: 0, invoiceTotal: 0 };
                    if (item.costSheetFile) {
                        try {
                            metrics = extractCostSheetMetrics(item.costSheetFile, order.projectName);
                            item.workingResourceCount = metrics.resourceCount || item.workingResourceCount || 0;
                            item.realCost = metrics.realCost || item.realCost || 0;
                            item.invoiceTotal = metrics.invoiceTotal || item.invoiceTotal || 0;
                        } catch (e) {}
                    }

                    if (!item.components || item.components.length === 0) {
                        const contractNum = order.contractId || order.blanketContractId || `CON-${order.internalOrderNumber || 'ORD'}-${idx + 1}`;
                        item.components = [{
                            id: `c_${Date.now()}_${idx}_0`,
                            description: item.description,
                            quantity: getItemEffectiveQty(item),
                            unit: item.unit || 'pcs',
                            unitCost: metrics.realCost > 0 ? metrics.realCost : (item.pricePerUnit || 0),
                            taxPercent: item.taxPercent || 14,
                            source: 'PROCUREMENT',
                            status: isOutsourcing ? 'RUNNING_OUTSOURCING_CONTRACT' : 'PENDING_OFFER',
                            noRfpNeeded: isOutsourcing ? true : false,
                            workingResourceCount: item.workingResourceCount,
                            realCost: item.realCost,
                            invoiceTotal: item.invoiceTotal,
                            componentNumber: item.supplierPartNumber || `CMP-${order.internalOrderNumber || 'ORD'}-${idx + 1}-1`,
                            contractNumber: isOutsourcing ? contractNum : undefined,
                            contractStartDate: order.orderDate || undefined,
                            procurementStartedAt: new Date().toISOString(),
                            statusUpdatedAt: new Date().toISOString()
                        }];
                    }
                    (item.components || []).forEach(comp => {
                        if (isOutsourcing || comp.contractNumber) {
                            if (comp.noRfpNeeded === undefined) comp.noRfpNeeded = true;
                            if (comp.noRfpNeeded && comp.source !== 'STOCK' && ['NEW', 'PENDING_OFFER'].includes(comp.status)) {
                                comp.status = 'RUNNING_OUTSOURCING_CONTRACT';
                            }
                            if (item.workingResourceCount) comp.workingResourceCount = item.workingResourceCount;
                            if (item.realCost) {
                                comp.realCost = item.realCost;
                                if (comp.unitCost === 0) comp.unitCost = item.realCost;
                            }
                            if (item.invoiceTotal) comp.invoiceTotal = item.invoiceTotal;
                        } else if (comp.source === 'PROCUREMENT' && ['NEW', 'PENDING_OFFER'].includes(comp.status)) {
                            comp.status = 'PENDING_OFFER';
                            if (!comp.procurementStartedAt) {
                                comp.procurementStartedAt = new Date().toISOString();
                            }
                        }
                        comp.statusUpdatedAt = new Date().toISOString();
                    });
                });

                // Check if the order is purely outsourcing with no RFP needed -> RUNNING_OUTSOURCING_CONTRACT
                const allProcComps = order.items.flatMap(it => it.components || []).filter(c => c.source === 'PROCUREMENT');
                const anyNeedsRfp = allProcComps.some(c => !c.noRfpNeeded && ['NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(c.status));
                const anyRunningOutsourcing = allProcComps.some(c => c.status === 'RUNNING_OUTSOURCING_CONTRACT' || (c.noRfpNeeded && (c.contractNumber || order.items.some(i => i.productionType === 'OUTSOURCING'))));

                const fnPureOutsourcing = (order.items || []).length > 0 && order.items.every(i => i.productionType === 'OUTSOURCING'); // R30 19:24
                if ((!anyNeedsRfp && anyRunningOutsourcing) || fnPureOutsourcing) {
                    order.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                } else {
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                }

                order.technicalReviewFinishedAt = new Date().toISOString();
                order.logs.push(createAuditLog('Technical study finalized and pushed to Procurement', order.status, user));
                break;

            case 'rollback-to-logged':
                // v1.0001218: what is released here is put back onto the delivered POs a cancelled order kept (reattachKeptSupplierAllocations below).
                const rbReleased = releaseSupplierAllocationsOfOrder(db, order);
                const rollbackOld = JSON.parse(JSON.stringify(order));
                const nowIso = new Date().toISOString();
                const todayDate = nowIso.split('T')[0];

                order.status = OrderStatus.LOGGED;
                order.dataEntryTimestamp = nowIso;
                order.orderDate = todayDate;
                order.statusUpdatedAt = nowIso;
                order.technicalReviewStartedAt = nowIso;
                delete order.technicalReviewFinishedAt;
                order.loggingComplianceViolation = false;
                delete order.statusEnteredAt;
                delete order.lastStatusChange;
                delete order.statusBeforeHold;
                order.rolledBackToLogged = true;

                // Set or preserve blanketOrder classification
                if (payload && payload.isBlanket !== undefined) {
                    order.blanketOrder = Boolean(payload.isBlanket);
                } else if (order.blanketOrder === undefined) {
                    // v1.0001228 (validator r24b): only a blanket contract root (contractId) defaults to blanket. An Outsourcing line or a
                    // call-off link (blanketContractId) never makes a normal order a blanket root: that moved its AR to committed 0 and
                    // turned a call-off into a root. payload.isBlanket stays authoritative; real blankets carry the flag from creation.
                    order.blanketOrder = Boolean(order.contractId);
                }

                // Restore any stock-allocated components back to their source stock orders
                (rollbackOld.items || []).forEach(oldIt => {
                    (oldIt.components || []).forEach(oldComp => {
                        if (oldComp.allocatedFromStockOrderId) {
                            const stockOrderIdx = (db.orders || []).findIndex(o => o.id === oldComp.allocatedFromStockOrderId);
                            if (stockOrderIdx !== -1) {
                                let stockOrder = db.orders[stockOrderIdx];
                                const oldStockOrder = JSON.parse(JSON.stringify(stockOrder));
                                let stockItem = null;
                                let stockComponent = null;

                                for (const sItem of (stockOrder.items || [])) {
                                    if (oldComp.allocatedFromStockItemId && sItem.id === oldComp.allocatedFromStockItemId) {
                                        stockItem = sItem;
                                    }
                                    const match = (sItem.components || []).find(c =>
                                        (oldComp.allocatedFromStockCompId && c.id === oldComp.allocatedFromStockCompId) ||
                                        (c.description === oldComp.description)
                                    );
                                    if (match) {
                                        if (!stockItem) stockItem = sItem;
                                        stockComponent = match;
                                        break;
                                    }
                                }

                                if (stockComponent && stockItem) {
                                    const returnQty = Number(oldComp.quantity) || 0;
                                    stockComponent.allocatedQty = Math.max(0, (stockComponent.allocatedQty || 0) - returnQty);
                                    stockItem.allocatedQty = Math.max(0, (stockItem.allocatedQty || 0) - returnQty);
                                    stockComponent.quantity = Number(((stockComponent.quantity || 0) + returnQty).toFixed(3));
                                    stockItem.quantity = Number(((stockItem.quantity || 0) + returnQty).toFixed(3));
                                    if (stockComponent.status === 'DEPLETED') {
                                        stockComponent.status = stockComponent.source === 'STOCK' ? 'AVAILABLE' : 'PENDING_OFFER';
                                    }
                                    stockComponent.statusUpdatedAt = new Date().toISOString();
                                    if (!stockOrder.logs) stockOrder.logs = [];
                                    stockOrder.logs.push(createAuditLog(
                                        `Returned ${returnQty} ${stockComponent.unit || 'pcs'} of "${stockComponent.description}" back to Stock Order due to rollback of Order ${order.internalOrderNumber || order.customerReferenceNumber || order.id}. Remaining in Stock Order: ${stockComponent.quantity}`,
                                        stockOrder.status,
                                        user
                                    ));
                                    stockOrder.statusUpdatedAt = new Date().toISOString();
                                    stockOrder = processedOrderInternal(stockOrder, db, user, false, oldStockOrder, false);
                                    reconcileInventory(oldStockOrder, stockOrder, db);
                                    db.orders[stockOrderIdx] = stockOrder;
                                }
                            }
                        }
                    });
                });

                // Release all received components and trading items in Hub to general warehouse component stock
                transferReceivedItemsToFreeStock(order, db, `Rollback to Logged: ${payload?.reason || 'Manual rollback'}`, user);

                // v1.0001218: reopening a cancelled order keeps the supplier POs its cancel kept because the supplier delivered on them: they leave the
                // order lines (the reopened order is planned from scratch and never receives on them) and move to order.keptSupplierPos, which the
                // supplier ledger, AP and payment allocation still read; the money paid on them stays on them (up to their value).
                order.items.forEach(item => (item.components || []).forEach(comp => {
                    if (!isKeptDeliveredPo(comp)) return;
                    order.keptSupplierPos = (order.keptSupplierPos || []).concat([{ ...comp, keptFromItemId: item.id, keptFromItemDescription: item.description, movedOffOrderLinesAt: nowIso }]);
                    order.logs.push(createAuditLog(`Delivered supplier PO ${comp.poNumber} kept on reopen: ${comp.description} (${comp.quantity} ${comp.unit || 'pcs'}) stays with the supplier ledger and payables; it is no longer an order line.`, order.status, user));
                }));
                // Clear all components added in technical review & reset item approvals
                order.items.forEach(item => {
                    // Preserve and recover line item price across rollback
                    const oldItemMatch = rollbackOld?.items?.find(oi => oi.id === item.id);
                    const rawPrice = item.pricePerUnit ?? item.unitPrice ?? item.price ?? oldItemMatch?.pricePerUnit ?? oldItemMatch?.unitPrice ?? oldItemMatch?.price;
                    if (rawPrice !== undefined && rawPrice !== null && !isNaN(Number(rawPrice))) {
                        item.pricePerUnit = Number(rawPrice);
                    }

                    item.components = [];
                    item.manufacturedQty = 0; item.hubReceivedQty = 0;
                    item.isAccepted = false;
                    delete item.technicalReviewStatus;
                    delete item.bomConfigured;

                    // Remove any database of cost sheet and delete the cost sheets
                    delete item.costSheetFile;
                    delete item.costSheetFileName;
                    delete item.costSheetText;
                    delete item.costSheets;
                    delete item.costSheetEditableCells;
                    delete item.costSheetCellColors;
                    delete item.workingResourceCount;
                    delete item.realCost;
                    delete item.invoiceTotal;
                    delete item.noRfpNeeded;
                });

                // Clear any order-level cost sheet properties
                delete order.costSheetFile;
                delete order.costSheetFileName;
                delete order.costSheetText;
                delete order.costSheets;
                delete order.costSheetEditableCells;
                delete order.costSheetCellColors;
                delete order.workingResourceCount;
                delete order.realCost;
                delete order.invoiceTotal;
                delete order.noRfpNeeded;

                reconcileInventory(rollbackOld, order, db);
                reattachKeptSupplierAllocations(db, order, rbReleased);
                // v1.0001220 (N1): reopening a cancelled order takes the paid money its cancel moved to the customer general wallet (R23 C17)
                // back onto the order, so the customer money is counted once (before: general wallet AND PO wallet, Ledger variance = the
                // amount). It takes back what the spendable general wallet still holds (rule G1, as void / refund / pay-from-wallet); a part
                // that was spent or refunded meanwhile stays recorded as paymentMovedToWallet and is not counted on the order (orderPaidIn).
                // v1.0001221 (validator 15e G1, G2): only a reopen of a CANCELLED (REJECTED) order takes money back, and at most what THAT
                // cancel credited (paymentMovedByCancel; an order cancelled before v1.0001221 has no such field: all its moved money). Money of
                // an earlier cancel that an earlier reopen could not take back (spent or refunded) stays off the order, and unrelated money
                // that reaches the general wallet later (an advance) is never taken onto the order by a later rollback.
                {
                    const movedOC = Number(order.paymentMovedToWallet) || 0;
                    const fxB = orderFx(order);
                    const leOrB = (le, oc) => (le !== undefined && le !== null && Number.isFinite(Number(le))) ? Number(le) : (Number(oc) || 0) * fxB;
                    const movedLE = leOrB(order.paymentMovedToWalletLE, order.paymentMovedToWallet);
                    const wasCancelled = rollbackOld.status === OrderStatus.REJECTED;
                    const hasCredit = order.paymentMovedByCancel !== undefined && order.paymentMovedByCancel !== null;
                    const creditOC = wasCancelled ? Math.min(movedOC, hasCredit ? (Number(order.paymentMovedByCancel) || 0) : movedOC) : 0;
                    const creditLE = wasCancelled ? Math.min(movedLE, hasCredit ? leOrB(order.paymentMovedByCancelLE, order.paymentMovedByCancel) : movedLE) : 0;
                    delete order.paymentMovedByCancel; delete order.paymentMovedByCancelLE;
                    const custB = creditOC > 0.004 ? (db.customers || []).find(c => c.name === order.customerName) : null;
                    if (creditOC > 0.004) {
                        const curB = order.currency && order.currency !== 'L.E.' ? order.currency : 'L.E.';
                        const takeLE = custB ? r2w(Math.max(0, Math.min(creditLE, availableGeneralWallet(db, custB)))) : 0;
                        const all = takeLE >= creditLE - 0.004;
                        const takeOC = all ? creditOC : (creditLE > 0 ? r2w(creditOC * takeLE / creditLE) : 0);
                        if (takeLE > 0.004) {
                            custB.walletBalances = custB.walletBalances || {};
                            custB.walletBalances[SELF_WALLET_KEY] = r2w((Number(custB.walletBalances[SELF_WALLET_KEY]) || 0) - takeLE);
                            custB.walletBalance = r2w((Number(custB.walletBalance) || 0) - takeLE);
                            ledgerPush(db, { type: 'TRANSFER', amount: takeLE, description: `Reopened PO ${order.internalOrderNumber}: paid amount taken back from the customer general wallet`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, reopenTakeBack: true }, user);
                            // v1.0001221 (G5): the order-currency amount carries the order currency (a foreign-currency order also shows the L.E.)
                            order.logs.push(createAuditLog(`Reopen: paid amount ${takeOC.toLocaleString()} ${curB}${curB !== 'L.E.' ? ` (${takeLE.toFixed(2)} L.E.)` : ''} taken back from the customer general wallet onto the order.`, order.status, user));
                        }
                        const restOC = r2w(movedOC - takeOC), restLE = r2w(movedLE - takeLE);
                        if (restOC <= 0.004) { delete order.paymentMovedToWallet; delete order.paymentMovedToWalletLE; clearMovedLeftoverShares(order); }
                        else { order.paymentMovedToWallet = restOC; order.paymentMovedToWalletLE = Math.max(0, restLE); }
                        if (!all) {
                            // v1.0001222 (validator 16 G3b): the part of THIS cancel's credit that is no longer in the general wallet becomes
                            // each payment's own share (payment.movedLeftoverLE, in proportion to what it held on the order for this cancel), so a
                            // later void of a payment takes back only its own share; a payment recorded after this reopen has no share and is
                            // voided as usual. An order of an earlier version with an old left-over and no shares gets them here as well
                            // (the shares then add up to the whole left-over off the order).
                            // v1.0001223 (G3d): wallet-transfer rows into the PO hold shares too
                            const sharesNow = (order.payments || []).reduce((t, pp) => t + (pp ? (Number(pp.movedLeftoverLE) || 0) : 0), 0);
                            spreadMovedLeftoverLE(order, r2w(Math.max(0, restLE) - sharesNow));
                            const oldLeftLE = r2w(movedLE - creditLE);
                            order.logs.push(createAuditLog(`Reopen: ${r2w(creditLE - takeLE).toFixed(2)} L.E. of the paid amount is no longer in the customer general wallet (spent or refunded); it stays off this order, which shows it as unpaid.${oldLeftLE > 0.004 ? ` With the ${oldLeftLE.toFixed(2)} L.E. of an earlier cancel, ${Math.max(0, restLE).toFixed(2)} L.E. is off this order.` : ''}`, order.status, user));
                        }
                    }
                }
                const orderTypeDesc = order.blanketOrder ? 'Blanket Order' : 'Standard Order';
                order.logs.push(createAuditLog(`Rollback to Logged (${orderTypeDesc}): SLA reset from scratch, BoM components and cost sheets cleared. Reason: ${payload?.reason || 'Manual rollback'}`, order.status, user));

                // Notification for Rollback
                if (settings && settings.enableRollbackAlerts) {
                    const groupIds = settings.rollbackAlertGroupIds || [];
                    const recipients = getRecipients(groupIds, db);
                    if (recipients.length > 0) {
                        const emails = recipients.map(r => r.email);
                        const emailRes = await sendEmail(emails, `[NEXUS] PO Rollback: ${order.internalOrderNumber}`,
                            `Order ${order.internalOrderNumber} has been rolled back from ${oldStatus} to LOGGED status.\nReason: ${payload?.reason || 'Manual rollback'}`,
                            settings.emailConfig, req); // v1.0001221: simulated in sandbox mode (as every sandbox mail)

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
                            } else if (['RECEIVED', 'STOCKED', 'IN_STOCK', 'CONSUMED', 'Manufactured'].includes(comp.status)) {
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

                if (writeDb(db, getDbPath(req))) return res.json({ message: "Order permanently deleted" });
                else throw new Error("Database write failed");

            case 'reject-order':
                { const rjS = rejectSettlementRefusal(order, db.orders || []); if (rjS) throw new Error(rjS); }
                // v1.0001218 (validator G2): what is released here is put back onto the POs the cancel keeps (up to their value) by reattachKeptSupplierAllocations below.
                const rjReleased = releaseSupplierAllocationsOfOrder(db, order);
                // CX16: a rejected order cannot be rejected again.
                if (order.status === OrderStatus.REJECTED) throw new Error('Refused: order already rejected');
                const today = new Date().toISOString().split('T')[0];
                const oldInternal = order.internalOrderNumber || '';
                const oldCustRef = order.customerReferenceNumber || '';
                
                // Rename both internal and customer reference numbers
                // v1.0001221: a second cancel of a reopened order replaces the earlier rej_<date>_ prefix instead of stacking it.
                const stripRej = (s) => String(s || '').replace(/^(rej_\d{4}-\d{2}-\d{2}_)+/, '');
                order.internalOrderNumber = `rej_${today}_${stripRej(oldInternal)}`;
                order.customerReferenceNumber = `rej_${today}_${stripRej(oldCustRef)}`;
                
                order.status = OrderStatus.REJECTED;
                if (!order.technicalReviewFinishedAt && [OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW, OrderStatus.NEGATIVE_MARGIN].includes(oldStatus)) {
                    order.technicalReviewFinishedAt = new Date().toISOString();
                }
                // v1.0001217: what each supplier PO delivered is captured BEFORE the release below (the release moves receivedQty of goods to releasedToStockQty).
                const deliveredBeforeCancel = {};
                order.items.forEach(item => (item.components || []).forEach(comp => { deliveredBeforeCancel[comp.id] = (Number(comp.receivedQty) || 0) + (Number(comp.releasedToStockQty) || 0); }));
                // Release all received components and trading items in Hub to general warehouse component stock (a received service is not stock: CX06)
                transferReceivedItemsToFreeStock(order, db, `Order Rejection: ${payload?.reason || 'Business decision'}`, user);
                // CX12: supplier POs of the cancelled order that received nothing are cancelled (supplier commitment drops).
                // v1.0001216 (test 124 OS07): an outsourcing PO whose contract start date has passed is RUNNING_CONTRACT (sweepContractStarts); it is cancelled like WAITING_CONTRACT_START.
                // v1.0001217: a PO (ORDERED / WAITING_CONTRACT_START / RUNNING_CONTRACT) that delivered something is not cancelled: fully delivered it is kept as issued,
                // partly delivered it is amended to the delivered quantity (extension path, no leftover re-procurement); the supplier link and delivered value stay.
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (comp.source === 'PROCUREMENT' && ['ORDERED', 'WAITING_CONTRACT_START', 'RUNNING_CONTRACT', 'RUNNING_OUTSOURCING_CONTRACT'].includes(comp.status) && comp.poNumber) {
                            const delivered = deliveredBeforeCancel[comp.id] || 0;
                            if (delivered > 0) {
                                executeComponentPoCancelOrExtension(item, comp, `Order cancelled: ${payload?.reason || 'Business decision'}`, true, { orderCancelled: true, receivedQty: delivered });
                            } else {
                                try { executeComponentPoCancelOrExtension(item, comp, `Order cancelled: ${payload?.reason || 'Business decision'}`, false); } catch (e) { comp.status = 'CANCELLED'; comp.cancelReason = 'Order cancelled'; comp.statusUpdatedAt = new Date().toISOString(); }
                            }
                        }
                    });
                });
                // R30 (23:00): manufactured products of a cancelled order go to free stock (no customer); unused components are stocked with no PO.
                order.items.forEach(item => {
                    const madeQty = Math.max(0, (Number(item.manufacturedQty) || 0) - (Number(item.deliveredQty) || 0));
                    if (item.productionType !== 'TRADING' && item.productionType !== 'OUTSOURCING' && madeQty > 0) {
                        const fSku = item.orderNumber || item.sku || `FG-${item.id}`;
                        let fInv = (db.inventory || []).find(i => (i.sku && i.sku === fSku) || (i.description && i.description === item.description));
                        if (fInv) { fInv.quantityInStock = (Number(fInv.quantityInStock) || 0) + madeQty; fInv.lastUpdated = new Date().toISOString(); delete fInv.orderRef; delete fInv.poNumber; }
                        else { (db.inventory = db.inventory || []).push({ id: `inv_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, sku: fSku, description: item.description, quantityInStock: madeQty, quantityReserved: 0, category: 'Finished goods', unit: item.unit || 'pcs', lastCost: Number(item.realCost) || 0, minStockLevel: 0, lastUpdated: new Date().toISOString() }); }
                        order.logs.push(createAuditLog(`Cancelled order: ${madeQty} ${item.unit || 'pcs'} of ${item.description} moved to free stock (no customer).`, order.status, user));
                    }
                    item.manufacturedQty = 0; item.hubReceivedQty = 0;
                });
                // Release any remaining reserved inventory back to free stock
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (['RESERVED', 'RECEIVED', 'STOCKED'].includes(comp.status)) {
                            if (!isStockOrder(order) || comp.source === 'STOCK') updateInventoryItem(db, comp, 'RELEASE', order);
                            comp.status = 'IN_STOCK'; // Or specific status indicating released
                            // v1.0001217: a supplier PO that was delivered keeps its PO number and supplier, so the supplier ledger keeps the delivered value.
                            if (comp.source !== 'PROCUREMENT' || !((deliveredBeforeCancel[comp.id] || 0) > 0)) { delete comp.poNumber; delete comp.supplierId; delete comp.supplierName; }
                            comp.receivedQty = 0;
                        }
                    });
                });
                // v1.0001218 (validator G2, G3): every supplier PO the cancel keeps because the supplier delivered on it is marked keptOnOrderCancel
                // (AP keeps it although the order is REJECTED; a reopen moves it to order.keptSupplierPos), and the money that was paid on it goes back
                // onto it up to its kept value (supplier PO wallet); only the excess stays in the supplier general wallet.
                order.items.forEach(item => (item.components || []).forEach(comp => {
                    if ((comp.source === 'PROCUREMENT' || comp.source === 'CONSUMED') && comp.poNumber && (comp.supplierId || comp.supplierName)
                        && !['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(String(comp.status || '').toUpperCase())
                        && ((deliveredBeforeCancel[comp.id] || 0) > 0 || comp.source === 'CONSUMED')) comp.keptOnOrderCancel = true;
                }));
                reattachKeptSupplierAllocations(db, order, rjReleased);
                // R23 (C17): money the customer paid on a cancelled order becomes credit in the customer GENERAL wallet.
                // v1.0001220 (N1): only the money the PO still holds moves: the payments minus the surplus already moved to the general wallet
                // (R30; before, a cancel of an overpaid PO credited the surplus a second time) minus paid money of an earlier cancel that is
                // still in the general wallet (a reopen takes it back and clears paymentMovedToWallet; a reopen that could not take all of it
                // back leaves the rest, and payments recorded after that reopen still move on the next cancel).
                {
                    const paidOnOrder = Math.round((order.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0) * 100) / 100;
                    const cust = (db.customers || []).find(c => c.name === order.customerName);
                    const fxC = orderFx(order);
                    const leOr = (le, oc) => (le !== undefined && le !== null && Number.isFinite(Number(le))) ? Number(le) : (Number(oc) || 0) * fxC;
                    const surplusOC = Number(order.surplusMovedToWallet) || 0, surplusLE = leOr(order.surplusMovedToWalletLE, order.surplusMovedToWallet);
                    const earlierOC = Number(order.paymentMovedToWallet) || 0, earlierLE = leOr(order.paymentMovedToWalletLE, order.paymentMovedToWallet);
                    const moveOC = r2w(paidOnOrder - surplusOC - earlierOC);
                    // R34 round 5 (item 4): the L.E. value of the payments (exact amountLE of payments entered in L.E.)
                    const moveLE = r2w(orderPaymentsLE(order) - surplusLE - earlierLE);
                    // v1.0001221 (validator 15e G1, G2): what THIS cancel credits is recorded apart (paymentMovedByCancel, in the order currency and
                    // in L.E.); paymentMovedToWallet stays the total paid money off the order (this credit + an earlier cancel's money that a reopen
                    // could not take back). A reopen takes back only this credit, never the old leftover or later unrelated wallet money.
                    // v1.0001222 (validator 16 G1b): a cancel that moves nothing records a credit of 0 (not "no field", which a reopen reads
                    // as an order of an earlier version: all moved money), so a later reopen never takes unrelated advance money onto the order.
                    order.paymentMovedByCancel = 0; order.paymentMovedByCancelLE = 0;
                    if (moveOC > 0.004 && moveLE > 0.004 && cust) {
                        cust.walletBalances = cust.walletBalances || {};
                        cust.walletBalances[SELF_WALLET_KEY] = Math.round(((cust.walletBalances[SELF_WALLET_KEY] || 0) + moveLE) * 100) / 100;
                        cust.walletBalance = r2w((Number(cust.walletBalance) || 0) + moveLE); // stored total follows the bucket (as the void)
                        order.paymentMovedToWallet = r2w(earlierOC + moveOC);
                        order.paymentMovedToWalletLE = r2w(earlierLE + moveLE);
                        order.paymentMovedByCancel = moveOC;
                        order.paymentMovedByCancelLE = moveLE;
                        ledgerPush(db, { type: 'TRANSFER', amount: moveLE, description: `Cancelled PO ${oldInternal}: paid amount moved to customer general wallet`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'ORDER', oldInternal), toAccount: acctLabel(order.customerName, 'SELF', 'Self'), customerName: order.customerName, orderId: order.id, poNumber: oldInternal }, user);
                        // v1.0001221 (G5): the order-currency amount carries the order currency (a foreign-currency order also shows the L.E. credited)
                        const curC = order.currency && order.currency !== 'L.E.' ? order.currency : 'L.E.';
                        order.logs.push(createAuditLog(`Paid amount ${moveOC.toLocaleString()} ${curC}${curC !== 'L.E.' ? ` (${moveLE.toFixed(2)} L.E.)` : ''} moved to the customer general wallet (credit).${surplusOC > 0.004 ? ` The surplus ${surplusOC.toLocaleString()}${curC !== 'L.E.' ? ` ${curC}` : ''} was already there.` : ''}${earlierLE > 0.004 ? ` ${earlierLE.toFixed(2)} L.E. of an earlier cancel (spent or refunded there) stays off this order.` : ''}`, order.status, user));
                    }
                }
                order.logs.push(createAuditLog(`ORDER REJECTED: ${payload?.reason || 'Business decision'}. PO renamed from ${oldInternal} to ${order.internalOrderNumber}`, order.status, user));
                break;

            case 'toggle-acceptance': {
                const taItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (taItemIdx === -1) throw new Error("Item not found");
                const taItem = order.items[taItemIdx];
                taItem.isAccepted = !taItem.isAccepted;

                const hasAnyAccepted = order.items.some(i => i.isAccepted);
                if (hasAnyAccepted && order.status === OrderStatus.LOGGED) {
                    order.status = OrderStatus.TECHNICAL_REVIEW;
                }

                order.logs.push(createAuditLog(`Item ${taItem.orderNumber || (taItemIdx + 1)}: ${taItem.isAccepted ? 'Accepted' : 'Acceptance Revoked'}`, order.status, user));
                break;
            }

            case 'set-production-type': {
                const sptItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (sptItemIdx === -1) throw new Error("Item not found");
                const sptItem = order.items[sptItemIdx];
                const newType = payload.type; // 'MANUFACTURING' | 'TRADING' | 'OUTSOURCING'
                const oldType = sptItem.productionType || 'TRADING';
                
                sptItem.productionType = newType;
                sptItem.techTouched = true;
                // User ruling 2026-10-21 (22:08): an OUTSOURCING line is an outsourcing request, not a set of components; its single procurement entry is the request form.
                if (newType === 'OUTSOURCING') (sptItem.components || []).forEach(c => { if (c.source === 'PROCUREMENT') c.isOutsourcingRequest = true; });
                
                if (order.status === OrderStatus.LOGGED) {
                    order.status = OrderStatus.TECHNICAL_REVIEW;
                }
                
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
                    if (order.blanketOrder) {
                        if (!sptItem.components) sptItem.components = [];
                        order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to TRADING (Blanket Order). Trade components sourcing enabled.`, order.status, user));
                    } else {
                        // Clear components; processedOrderInternal will recreate the mirrored one automatically
                        sptItem.components = [];
                        order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to TRADING. Mirror sync enabled.`, order.status, user));
                    }
                } else {
                    if (oldType === 'TRADING') {
                        if (!order.blanketOrder) {
                            // The user switched OUT of TRADING in a non-blanket order. Wipe mirror entry.
                            sptItem.components = [];
                            order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to ${newType}. Removed TRADING mirror component.`, order.status, user));
                        } else {
                            order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to ${newType}.`, order.status, user));
                        }
                    } else {
                        order.logs.push(createAuditLog(`Item ${sptItemIdx + 1} set to ${newType}.`, order.status, user));
                    }
                }

                break;
            }

            case 'upload-cost-sheet': {
                const ucsItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ucsItemIdx === -1) throw new Error("Item not found");
                const ucsItem = order.items[ucsItemIdx];
                const replaceWrongData = Boolean(payload.replaceWrongData);
                if (payload.costSheetFile) {
                    // CX06: only spreadsheet/document files are accepted; an empty or executable file is rejected.
                    const ucsName = String(payload.costSheetFileName || '').toLowerCase();
                    if (ucsName && !/\.(xlsx|xls|xlsm|csv|ods|pdf|docx?|png|jpe?g)$/.test(ucsName)) throw new Error(`Rejected: file type not allowed (${payload.costSheetFileName}).`);
                    if (typeof payload.costSheetFile === 'string' && payload.costSheetFile.startsWith('data:') && (payload.costSheetFile.split(';base64,').pop() || '').length === 0) throw new Error('Rejected: the cost sheet file is empty.');
                }

                if (payload.costSheetFile && typeof payload.costSheetFile === 'string' && payload.costSheetFile.startsWith('data:')) {
                    payload.costSheetFile = await persistBase64CostSheet(payload.costSheetFile, req);
                }

                let metrics = { resourceCount: 0, realCost: 0, invoiceTotal: 0 };
                if (payload.costSheetFile) {
                    try {
                        const targetProj = payload.projectName || order.projectName;
                        metrics = extractCostSheetMetrics(payload.costSheetFile, targetProj);
                    } catch (err) {
                        console.error("[CostSheet] Failed to extract metrics:", err);
                    }
                }

                const newRecord = payload.costSheetFile ? {
                    id: `cs_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    fileName: payload.costSheetFileName || 'cost-sheet.xlsx',
                    uploadedAt: new Date().toISOString(),
                    fileData: payload.costSheetFile,
                    workingResourceCount: metrics.resourceCount,
                    realCost: metrics.realCost,
                    invoiceTotal: metrics.invoiceTotal,
                    monthLabel: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                } : null;

                if (!ucsItem.costSheets) ucsItem.costSheets = [];

                if (replaceWrongData) {
                    // Erase current wrong uploaded data: overwrite active and replace records
                    ucsItem.costSheets = newRecord ? [newRecord] : [];
                    ucsItem.costSheetFile = payload.costSheetFile || undefined;
                    ucsItem.costSheetFileName = payload.costSheetFileName || undefined;
                } else {
                    // Default: Keep previous sheets as historical record, append new sheet
                    if (newRecord) {
                        ucsItem.costSheets.push(newRecord);
                    }
                    ucsItem.costSheetFile = payload.costSheetFile || undefined;
                    ucsItem.costSheetFileName = payload.costSheetFileName || undefined;
                }

                ucsItem.workingResourceCount = metrics.resourceCount || ucsItem.workingResourceCount || 0;
                ucsItem.realCost = metrics.realCost || ucsItem.realCost || 0;
                ucsItem.invoiceTotal = metrics.invoiceTotal || ucsItem.invoiceTotal || 0;
                ucsItem.costSheetEditableCells = payload.costSheetEditableCells || undefined;
                ucsItem.costSheetCellColors = payload.costSheetCellColors || undefined;

                // Sync to components of this item
                (ucsItem.components || []).forEach(comp => {
                    comp.workingResourceCount = ucsItem.workingResourceCount;
                    comp.realCost = ucsItem.realCost;
                    comp.invoiceTotal = ucsItem.invoiceTotal;
                    if (metrics.realCost > 0) comp.unitCost = metrics.realCost;
                    if (comp.source !== 'STOCK' && (comp.noRfpNeeded === undefined || comp.noRfpNeeded)) {
                        comp.noRfpNeeded = true;
                        comp.status = 'RUNNING_OUTSOURCING_CONTRACT';
                        comp.statusUpdatedAt = new Date().toISOString();
                    }
                });

                // Check order status: if pure outsourcing or all components are in running outsourcing contract / done
                const allProcComps = order.items.flatMap(it => it.components || []).filter(c => c.source === 'PROCUREMENT');
                const anyNeedsRfp = allProcComps.some(c => !c.noRfpNeeded && ['NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(c.status));
                const anyRunningOutsourcing = allProcComps.some(c => c.status === 'RUNNING_OUTSOURCING_CONTRACT' || (c.noRfpNeeded && (c.contractNumber || order.items.some(i => i.productionType === 'OUTSOURCING'))));

                if (!anyNeedsRfp && anyRunningOutsourcing) {
                    order.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                }

                order.logs.push(createAuditLog(
                    `Item ${ucsItem.orderNumber || ucsItemIdx + 1}: ${payload.costSheetFile ? `Cost sheet updated (${payload.costSheetFileName}, ${metrics.resourceCount} resources, Cost: ${metrics.realCost} L.E.)${replaceWrongData ? ' [Replaced previous data]' : ' [Appended monthly record]'}` : 'Cost sheet removed'}`, 
                    order.status, 
                    user
                ));
                break;
            }

            case 'update-cost-sheet-text': {
                const ucsItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ucsItemIdx === -1) throw new Error("Item not found");
                const ucsItem = order.items[ucsItemIdx];
                ucsItem.costSheetText = payload.costSheetText || undefined;
                order.logs.push(createAuditLog(`Item ${ucsItem.orderNumber || ucsItemIdx + 1}: Cost sheet text ${payload.costSheetText ? 'updated' : 'cleared'}`, order.status, user));
                break;
            }

            case 'delete-cost-sheet-record': {
                const dcsItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (dcsItemIdx === -1) throw new Error("Item not found");
                const dcsItem = order.items[dcsItemIdx];

                if (!dcsItem.costSheets || dcsItem.costSheets.length <= 1) {
                    throw new Error("Cannot delete the only cost sheet record - at least one must remain.");
                }

                const recIdx = dcsItem.costSheets.findIndex(r => r.id === payload.recordId);
                if (recIdx === -1) throw new Error("Cost sheet record not found");

                const deletedRec = dcsItem.costSheets[recIdx];
                dcsItem.costSheets.splice(recIdx, 1);

                // Promote the new last record as the active sheet
                const newLatest = dcsItem.costSheets[dcsItem.costSheets.length - 1];
                dcsItem.costSheetFile = newLatest.fileData || undefined;
                dcsItem.costSheetFileName = newLatest.fileName || undefined;

                // Re-extract metrics from the newly active sheet
                let newMetrics = { resourceCount: 0, realCost: 0, invoiceTotal: 0 };
                if (newLatest.fileData) {
                    try {
                        newMetrics = extractCostSheetMetrics(newLatest.fileData, order.projectName);
                    } catch (err) {
                        console.error("[CostSheet] Failed to extract metrics after delete:", err);
                    }
                }

                dcsItem.workingResourceCount = newMetrics.resourceCount || newLatest.workingResourceCount || 0;
                dcsItem.realCost = newMetrics.realCost || newLatest.realCost || 0;
                dcsItem.invoiceTotal = newMetrics.invoiceTotal || newLatest.invoiceTotal || 0;

                // Sync to components
                (dcsItem.components || []).forEach(comp => {
                    comp.workingResourceCount = dcsItem.workingResourceCount;
                    comp.realCost = dcsItem.realCost;
                    comp.invoiceTotal = dcsItem.invoiceTotal;
                    if (newMetrics.realCost > 0) comp.unitCost = newMetrics.realCost;
                });

                order.logs.push(createAuditLog(
                    `Item ${dcsItem.orderNumber || dcsItemIdx + 1}: Cost sheet record deleted (${deletedRec.fileName}, uploaded ${new Date(deletedRec.uploadedAt).toLocaleDateString()}). Reverted to: ${newLatest.fileName}.`,
                    order.status,
                    user
                ));
                break;
            }

            case 'receive-component': {
                const itemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (itemIdx === -1) throw new Error("Item not found");
                const compIdx = order.items[itemIdx].components?.findIndex(c => c.id === payload.compId);
                if (compIdx === -1) throw new Error("Component not found");

                const item = order.items[itemIdx];
                const compToReceive = order.items[itemIdx].components[compIdx];
                const totalOrdered = compToReceive.quantity || 0;
                const alreadyReceived = compToReceive.receivedQty || 0;
                const leftToReceive = totalOrdered - alreadyReceived;

                const qtyToProcess = payload.qty !== undefined ? parseFloat(payload.qty) : leftToReceive;

                if (isNaN(qtyToProcess) || qtyToProcess <= 0) throw new Error("Invalid quantity received");
                if (qtyToProcess > leftToReceive) throw new Error(`Cannot receive more than ordered (Left: ${leftToReceive})`);

                // Stock internal orders are ALWAYS components for warehouse stock, never customer trading products
                const isTradingItem = !isStockOrder(order) && item.productionType === 'TRADING' && compToReceive.status !== 'ORDERED_FOR_STOCK' && !compToReceive.forStock;
                // CX06: an outsourced service (e.g. a manpower month) is received per period; it is never warehouse stock.
                const isServiceReceipt = !isStockOrder(order) && item.productionType === 'OUTSOURCING';
                if (isServiceReceipt) {
                    // no inventory movement for a service
                } else if (!isTradingItem) {
                    updateInventoryItem(db, compToReceive, 'RECEIVE', order, qtyToProcess);
                } else if (compToReceive.source === 'PROCUREMENT') {
                    // R30 ruling 19:06: a supplier part always enters the warehouse (on hand grows) and stays reserved for the order it was bought for.
                    updateInventoryItem(db, compToReceive, 'RECEIVE', order, qtyToProcess);
                    compToReceive.viaWarehouse = true;
                } else {
                    if (compToReceive.inventoryItemId) {
                        if (db.inventory) {
                            db.inventory = db.inventory.filter(inv => inv.id !== compToReceive.inventoryItemId && inv.orderRef !== order.internalOrderNumber);
                        }
                        delete compToReceive.inventoryItemId;
                    }
                }

                compToReceive.receivedQty = alreadyReceived + qtyToProcess;

                // CX03: goods ordered for stock go to the warehouse (inventory) only; they never count as the customer's hub quantity.
                const forStockComp = !isStockOrder(order) && item.productionType === 'TRADING' && (compToReceive.status === 'ORDERED_FOR_STOCK' || compToReceive.forStock);
                // Special handling for external customer trading items - move directly to hub
                if (isServiceReceipt) {
                    // the value of a received period is fixed at the unit cost valid when it was received (a later cost sheet changes only the open periods)
                    compToReceive.receivedValueNet = Math.round(((compToReceive.receivedValueNet || 0) + qtyToProcess * (Number(compToReceive.unitCost) || 0)) * 100) / 100;
                    compToReceive.statusUpdatedAt = new Date().toISOString();
                    order.logs.push(createAuditLog(`Service Receipt: ${qtyToProcess} ${compToReceive.unit || 'period'} of ${compToReceive.description} received (Total received: ${compToReceive.receivedQty}/${totalOrdered}); not stocked in the warehouse.`, order.status, user));
                } else if (forStockComp) {
                    // R30 ruling 2026-10-22: stock not tied to any PO and received by the inventory user is STOCKED
                    if (compToReceive.receivedQty >= totalOrdered) compToReceive.status = 'STOCKED';
                    order.logs.push(createAuditLog(`Stock Component Receipt: ${qtyToProcess} ${compToReceive.unit || 'pcs'} of ${compToReceive.description} received into Warehouse Stock (ordered for stock)`, order.status, user));
                } else if (!isStockOrder(order) && item.productionType === 'TRADING') {
                    // For trading items, automatically move received quantity to hub
                    item.hubReceivedQty = (item.hubReceivedQty || 0) + qtyToProcess;

                    // Mark component as manufactured since trading items skip manufacturing
                    if (compToReceive.receivedQty >= totalOrdered) {
                        compToReceive.status = compToReceive.viaWarehouse ? 'RESERVED' : 'Manufactured';
                    }

                    order.logs.push(createAuditLog(`Trading Component Receipt: ${qtyToProcess} ${compToReceive.unit} of ${compToReceive.description} moved directly to Hub (Total Hub: ${item.hubReceivedQty}/${getItemEffectiveQty(item)})`, order.status, user));

                    // Check if all trading components are received and move to hub
                    // C06/TR11: warehouse stock allocated to the line (source STOCK) is available at once; only the procured parts must be received.
                    const compReady = (comp) => comp.source === 'STOCK' || comp.status === 'ORDERED_FOR_STOCK' || comp.forStock || ['RESERVED', 'RECEIVED', 'STOCKED', 'IN_STOCK', 'Manufactured'].includes(comp.status) || (comp.receivedQty || 0) >= (comp.quantity || 0);
                    const allTradingCompsReceived = item.components?.every(compReady) || false;
                    const allTradingItemsReady = order.items.filter(i => i.productionType === 'TRADING').every(i => (i.components || []).every(compReady));
                    if (allTradingCompsReceived && allTradingItemsReady) {
                        order.items.filter(i => i.productionType === 'TRADING').forEach(i => { i.hubReceivedQty = getItemEffectiveQty(i); });
                    }
                    if (allTradingCompsReceived && allTradingItemsReady && item.hubReceivedQty >= getItemEffectiveQty(item)) {
                        // Transition order status if appropriate
                        if (order.status === 'WAITING_SUPPLIERS') {
                            // Check if all driving items are ready
                            const manufacturingItems = order.items.filter(i => i.productionType === 'MANUFACTURING');
                            const tradingItems = order.items.filter(i => i.productionType === 'TRADING');

                            if (manufacturingItems.length === 0 && tradingItems.length > 0) {
                                // All trading items ready - move to IN_PRODUCT_HUB
                                order.status = OrderStatus.IN_PRODUCT_HUB;
                                order.logs.push(createAuditLog(`All trading components received and moved to hub. Ready for invoicing.`, order.status, user));
                            }
                        }
                    }
                } else {
                    // Standard processing for manufacturing/outsourcing items
                    if (compToReceive.receivedQty >= totalOrdered) {
                        compToReceive.status = isStockOrder(order) ? 'STOCKED' : 'RESERVED';
                    }
                    compToReceive.statusUpdatedAt = new Date().toISOString();
                    const targetDest = isStockOrder(order) ? 'Warehouse Stock' : 'Reserved for Order';
                    order.logs.push(createAuditLog(`Component Receipt: Received ${qtyToProcess} ${compToReceive.unit || 'pcs'} of ${compToReceive.description} into ${targetDest} (Total received: ${compToReceive.receivedQty}/${totalOrdered})`, order.status, user));
                }
                // Auto-fulfill Internal Stock orders when all components are delivered to stock
                if (isStockOrder(order)) {
                    const allComps = (order.items || []).flatMap(it => it.components || []);
                    const allCompsReceived = allComps.length > 0 && allComps.every(c => (c.receivedQty || 0) >= (c.quantity || 0));
                    if (allCompsReceived && order.status !== OrderStatus.FULFILLED) {
                        order.status = OrderStatus.FULFILLED;
                        order.fulfilledAt = new Date().toISOString();
                        order.logs.push(createAuditLog('All internal stock components received into inventory. Stock order auto-fulfilled.', order.status, user));
                    }
                }
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
                // R21 (C21): an order rolled back to Logged is locked until Order Management updates it.
                if (order.rolledBackToLogged) throw new Error("Order was rolled back to Logged: it cannot be edited until Order Management updates it.");
                const acItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (acItemIdx === -1) throw new Error("Item not found");
                const acItem = order.items[acItemIdx];
                if (!acItem.components) acItem.components = [];

                if (acItem.productionType === 'OUTSOURCING') throw new Error("Rejected: an outsourcing line has no components; fill in its outsourcing request instead.");
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
                        // Unified: Use 1-based indexing for item number consistency
                        newComp.componentNumber = `CMP-${order.internalOrderNumber}-${acItemIdx + 1}-${compCount + 1}`;
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
                        // Reservation is applied once by reconcileInventory after the action.
                        invItem.lastUpdated = new Date().toISOString();
                    }
                }

                if (newComp.source === 'STOCK' && acItem.productionType === 'OUTSOURCING' && (!newComp.status || newComp.status === 'NEW')) newComp.status = 'RESERVED'; // R30: stock part of an outsourcing item is RESERVED
                acItem.components.push(newComp);
                
                // Build detailed audit log message for procurement components
                let auditMessage = `Component added: ${newComp.description} (${newComp.source})`;
                const procurementDetails = [];
                
                if (newComp.source === 'PROCUREMENT') {
                  if (newComp.contractNumber) {
                    procurementDetails.push(`Contract: ${newComp.contractNumber}`);
                  }
                  if (newComp.contractDuration) {
                    procurementDetails.push(`Duration: ${newComp.contractDuration}`);
                  }
                  if (newComp.contractStartDate) {
                    procurementDetails.push(`Start Date: ${newComp.contractStartDate}`);
                  }
                  if (newComp.scopeOfWork) {
                    procurementDetails.push(`Reason: ${newComp.scopeOfWork}`);
                  }
                  if (procurementDetails.length > 0) {
                    auditMessage += ` [${procurementDetails.join(', ')}]`;
                  }
                }
                
                order.logs.push(createAuditLog(auditMessage, order.status, user));
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
                        // Release is applied once by reconcileInventory after the action.
                        invItem.lastUpdated = new Date().toISOString();
                    }
                }

                // Restore allocated quantity back to stock order if component was allocated from one
                if (rcComp.allocatedFromStockOrderId) {
                    const stockOrderIdx = (db.orders || []).findIndex(o => o.id === rcComp.allocatedFromStockOrderId && o.status !== OrderStatus.REJECTED);
                    if (stockOrderIdx !== -1) {
                        let stockOrder = db.orders[stockOrderIdx];
                        const oldStockOrder = JSON.parse(JSON.stringify(stockOrder));
                        let stockItem = null;
                        let stockComponent = null;

                        for (const sItem of (stockOrder.items || [])) {
                            if (rcComp.allocatedFromStockItemId && sItem.id === rcComp.allocatedFromStockItemId) {
                                stockItem = sItem;
                            }
                            const match = (sItem.components || []).find(c => 
                                (rcComp.allocatedFromStockCompId && c.id === rcComp.allocatedFromStockCompId) ||
                                (c.description === rcComp.description)
                            );
                            if (match) {
                                if (!stockItem) stockItem = sItem;
                                stockComponent = match;
                                break;
                            }
                        }

                        if (stockComponent && stockItem) {
                            const returnQty = Number(rcComp.quantity) || 0;
                            stockComponent.allocatedQty = Math.max(0, (stockComponent.allocatedQty || 0) - returnQty);
                            stockItem.allocatedQty = Math.max(0, (stockItem.allocatedQty || 0) - returnQty);
                            stockComponent.quantity = Number(((stockComponent.quantity || 0) + returnQty).toFixed(3));
                            stockItem.quantity = Number(((stockItem.quantity || 0) + returnQty).toFixed(3));
                            if (stockComponent.status === 'DEPLETED') {
                                stockComponent.status = stockComponent.source === 'STOCK' ? 'AVAILABLE' : 'PENDING_OFFER';
                            }
                            stockComponent.statusUpdatedAt = new Date().toISOString();
                            if (!stockOrder.logs) stockOrder.logs = [];
                            stockOrder.logs.push(createAuditLog(
                                `Returned ${returnQty} ${stockComponent.unit || 'pcs'} of "${stockComponent.description}" back to Stock Order due to component removal in Order ${order.internalOrderNumber || order.customerReferenceNumber || order.id}. Remaining in Stock Order: ${stockComponent.quantity}`,
                                stockOrder.status,
                                user
                            ));
                            stockOrder.statusUpdatedAt = new Date().toISOString();
                            stockOrder = processedOrderInternal(stockOrder, db, user, false, oldStockOrder, false);
                            reconcileInventory(oldStockOrder, stockOrder, db);
                            db.orders[stockOrderIdx] = stockOrder;
                        }
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
                // CX03: raising a stock reservation needs free stock for the extra quantity.
                if (ucComp.source === 'STOCK' && ucComp.inventoryItemId && payload.updates && Number(payload.updates.quantity) > (Number(ucComp.quantity) || 0)) {
                    const ucInv = (db.inventory || []).find(i => i.id === ucComp.inventoryItemId);
                    if (ucInv) {
                        const ucFree = (Number(ucInv.quantityInStock) || 0) - (Number(ucInv.quantityReserved) || 0);
                        const ucExtra = Number(payload.updates.quantity) - (Number(ucComp.quantity) || 0);
                        if (ucExtra > ucFree) throw new Error(`Rejected: insufficient free stock: only ${ucFree} free (${ucInv.quantityInStock} in stock, ${ucInv.quantityReserved || 0} reserved), ${ucExtra} more needed`);
                    }
                }
                Object.assign(ucComp, payload.updates);
                if (ucComp.source === 'STOCK' && ['NEW', 'PENDING_OFFER', 'RUNNING_OUTSOURCING_CONTRACT'].includes(ucComp.status)) ucComp.status = 'RESERVED'; // R30: a part taken from stock is RESERVED
                // X the order on the supplier path: WAITING_SUPPLIERS until the last item is delivered.
                // R30 ruling 16:20: non-blanket orders and blanket trade/manufacturing orders are WAITING_SUPPLIERS until all items are received; only blanket outsourcing stays RUNNING_OUTSOURCING_CONTRACT.
                const ucBlanketLike = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
                const ucBlanketGoods = !(order.items || []).every(i => i.productionType === 'OUTSOURCING'); // R30 19:00: outsourcing orders never WAITING_SUPPLIERS
                if (ucBlanketGoods && payload.updates && payload.updates.noRfpNeeded === false && order.status === OrderStatus.RUNNING_OUTSOURCING_CONTRACT) {
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog('[AUTO] No RFP Needed un-ticked. Status moved from RUNNING_OUTSOURCING_CONTRACT to WAITING_SUPPLIERS', order.status, 'System'));
                }
                
                // Build detailed audit log message for procurement-related updates
                // Check the UPDATED component properties (after Object.assign)
                let auditMessage = `Component updated: ${ucComp.description}`;
                
                // Check if this is a resource request (procurement-related update)
                const hasProcurementDetails = ucComp.contractStartDate || ucComp.contractNumber || ucComp.scopeOfWork || ucComp.contractDuration;
                
                if (hasProcurementDetails) {
                  const details = [];
                  if (ucComp.contractNumber) {
                    details.push(`Contract: ${ucComp.contractNumber}`);
                  }
                  if (ucComp.contractDuration) {
                    details.push(`Duration: ${ucComp.contractDuration}`);
                  }
                  if (ucComp.contractStartDate) {
                    details.push(`Start Date: ${ucComp.contractStartDate}`);
                  }
                  if (ucComp.scopeOfWork) {
                    details.push(`Reason: ${ucComp.scopeOfWork}`);
                  }
                  if (details.length > 0) {
                    auditMessage += ` (${details.join(', ')})`;
                  }
                }
                
                order.logs.push(createAuditLog(auditMessage, order.status, user));
                break;
            }

            case 'revive-contract': {
                const rcItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (rcItemIdx === -1) throw new Error("Item not found");
                const rcComp = order.items[rcItemIdx].components?.find(c => c.id === payload.compId);
                if (!rcComp) throw new Error("Component not found");

                const oldDuration = rcComp.contractDuration;
                rcComp.contractDuration = payload.newDuration;
                rcComp.statusUpdatedAt = new Date().toISOString();

                // Detailed audit log message
                const auditMsg = `Component updated: ${rcComp.description} (Contract: ${rcComp.contractNumber || rcComp.componentNumber}, Duration: ${payload.newDuration}, Start Date: ${rcComp.contractStartDate}, Reason: ${payload.reason}). [CONTRACT REVIVED - NO CHARGE]`;

                order.logs.push(createAuditLog(auditMsg, order.status, user));
                break;
            }

            case 'cancel-component-po': {
                // Cancel a supplier PO or amend via extension if goods received / payments made
                const ccItemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (ccItemIdx === -1) throw new Error("Item not found");
                const item = order.items[ccItemIdx];
                const ccComp = item.components?.find(c => c.id === payload.compId);
                if (!ccComp) throw new Error("Component not found");
                const cancelReason = (payload.reason || '').trim() || 'PO cancelled by user';
                const isExtension = Boolean(payload.isExtension);

                const res = executeComponentPoCancelOrExtension(item, ccComp, cancelReason, isExtension);

                if ((res.leftoverQty > 0.0001 || res.type === 'CANCELLED') && [OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING, OrderStatus.READY_FOR_PRODUCTION].includes(order.status)) {
                    const old = order.status;
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog(`[AUTO] Order reverted from ${old} to WAITING_SUPPLIERS: component requires re-procurement.`, order.status, 'System'));
                }
                break;
            }

            case 'send-rfp-batch': {
                const rfpId = Math.random().toString(36).substring(2, 9);
                if (!payload.components || !Array.isArray(payload.components)) throw new Error("components array required");
                // rfpSupplierIds can be empty array (meaning show all suppliers) or have IDs
                const rfpSupplierIds = Array.isArray(payload.rfpSupplierIds) ? payload.rfpSupplierIds : [];
                // CX02: no RFP goes to a blacklisted supplier (blocked).
                const blk = (db.suppliers || []).filter(s => rfpSupplierIds.includes(s.id) && s.isBlacklisted);
                if (blk.length) throw new Error(`Cannot send RFP: supplier ${blk.map(s => s.name).join(', ')} is blacklisted`);

                let updatedCount = 0;
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (payload.components.includes(comp.id)) {
                            comp.status = 'RFP_SENT';
                            comp.noRfpNeeded = false;
                            comp.rfpId = rfpId;
                            comp.rfpSupplierIds = rfpSupplierIds;
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
                            { const tpIn = (targetComponent.taxPercent !== undefined && targetComponent.taxPercent !== null && targetComponent.taxPercent !== '') ? targetComponent.taxPercent : payload.taxPercent; const tpNum = Number(tpIn); comp.taxPercent = (tpIn === undefined || tpIn === null || tpIn === '' || !Number.isFinite(tpNum)) ? 14 : tpNum; } // CX13: a typed 0 percent stays 0
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
                const existingSiblingSendPoId = (order.items || []).flatMap(it => it.components || []).find(c => payload.poNumber && c.poNumber === payload.poNumber && c.sendPoId)?.sendPoId;
                const sendPoId = existingSiblingSendPoId || Math.random().toString(36).substring(2, 9);
                if (!payload.components || !Array.isArray(payload.components)) throw new Error("components array required");

                const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
                let minMargin = dbSettings.minimumMarginPct || 15;
                const customer = db.customers.find(c => c.name === order.customerName);
                if (customer && customer.minimumMarginPct !== undefined && customer.minimumMarginPct !== null) {
                    minMargin = customer.minimumMarginPct;
                }

                if (!canIssuePoForOrder(order, minMargin)) {
                    throw new Error("Cannot issue PO: not all procurement components in the order have reached AWARDED status, or margin protection is active.");
                }

                const selectedComponentIds = payload.components;
                const allProcurementComps = orderComponentsRequiringPo(order);
                const selectedComponents = allProcurementComps.filter(comp => selectedComponentIds.includes(comp.id));
                
                if (selectedComponents.length !== selectedComponentIds.length) {
                    throw new Error("Invalid component selection for PO issuance.");
                }
                if (!selectedComponents.every(comp => comp.status === 'AWARDED')) {
                    throw new Error("Cannot issue PO: only AWARDED components can be issued as PO.");
                }

                let updatedCount = 0;
                let auditDetails = [];
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (selectedComponentIds.includes(comp.id)) {
                            const prodType = (item.productionType || '').toUpperCase().trim();
                            if (prodType === 'OUTSOURCING') {
                                comp.status = 'WAITING_CONTRACT_START';
                                if (payload.contractStartDate && payload.contractStartDate.trim()) {
                                    comp.contractStartDate = payload.contractStartDate.trim();
                                }
                                if (payload.contractNumber && payload.contractNumber.trim()) {
                                    comp.contractNumber = payload.contractNumber.trim();
                                }
                                auditDetails.push(`[${comp.id}: contract=${comp.contractNumber || 'auto'}, startDate=${comp.contractStartDate || 'N/A'}]`);
                            } else {
                                comp.status = 'ORDERED';
                            }
                            comp.sendPoId = sendPoId;
                            comp.poNumber = payload.poNumber;
                            comp.procurementStartedAt = new Date().toISOString();
                            comp.statusUpdatedAt = new Date().toISOString();
                            updatedCount++;
                        }
                    });
                });
                { const supIds = new Set(); order.items.forEach(it => (it.components || []).forEach(c => { if (c.sendPoId === sendPoId && c.supplierId) supIds.add(c.supplierId); })); supIds.forEach(sid => autoCoverFromExcess(db, sid, payload.poNumber)); }
                order.logs.push(createAuditLog(`Issued PO batch ${payload.poNumber} for ${updatedCount} components (PO Group ID: ${sendPoId}). ${auditDetails.join(' ')}`, order.status, user));

                break;
            }

            case 'cancel-po-batch': {
                if (!payload.sendPoId) throw new Error("sendPoId required");
                const cancelReason = (payload.reason || '').trim() || 'PO cancelled by user';
                const isExtension = Boolean(payload.isExtension);

                // Collect all components matching sendPoId in active PO/received statuses
                const targets = [];
                order.items.forEach(item => {
                    item.components?.forEach(comp => {
                        if (comp.sendPoId === payload.sendPoId && ['ORDERED', 'WAITING_CONTRACT_START', 'RUNNING_CONTRACT', 'RECEIVED', 'STOCKED', 'RESERVED'].includes(comp.status)) {
                            targets.push({ item, comp });
                        }
                    });
                });

                if (targets.length === 0) throw new Error("No components found matching sendPoId");

                // Check Case 1 vs Case 2: if any component has received items or payments
                const hasReceivedOrPaid = targets.some(({ comp }) => {
                    const rec = (Number(comp.receivedQty) || 0) + (Number(comp.releasedToStockQty) || 0);
                    const paid = getComponentAllocatedPaidAmount(comp);
                    return rec > 0 || paid > 0.01;
                });

                if (hasReceivedOrPaid && !isExtension) {
                    throw new Error("Cannot cancel PO directly: some items have been received into inventory or paid for. Please approve the PO extension/amendment.");
                }

                let hasLeftover = false;
                targets.forEach(({ item, comp }) => {
                    const res = executeComponentPoCancelOrExtension(item, comp, cancelReason, isExtension);
                    if (res.leftoverQty > 0.0001 || res.type === 'CANCELLED') hasLeftover = true;
                });

                if (hasLeftover && [OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING, OrderStatus.READY_FOR_PRODUCTION].includes(order.status)) {
                    const oldOrdStatus = order.status;
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog(`[AUTO] Order reverted from ${oldOrdStatus} to WAITING_SUPPLIERS: components require re-procurement after PO cancellation/extension.`, order.status, 'System'));
                }
                break;
            }

            case 'amend-po-extension': {
                const cancelReason = (payload.reason || '').trim() || 'PO amended via extension';
                const targets = [];

                if (payload.sendPoId) {
                    order.items.forEach(item => {
                        item.components?.forEach(comp => {
                            if (comp.sendPoId === payload.sendPoId && ['ORDERED', 'WAITING_CONTRACT_START', 'RUNNING_CONTRACT', 'RECEIVED', 'STOCKED', 'RESERVED'].includes(comp.status)) {
                                targets.push({ item, comp });
                            }
                        });
                    });
                } else if (payload.selectedCompIds && Array.isArray(payload.selectedCompIds)) {
                    order.items.forEach(item => {
                        item.components?.forEach(comp => {
                            if (payload.selectedCompIds.includes(comp.id)) {
                                targets.push({ item, comp });
                            }
                        });
                    });
                } else if (payload.itemId && payload.compId) {
                    const item = order.items.find(i => i.id === payload.itemId);
                    const comp = item?.components?.find(c => c.id === payload.compId);
                    if (item && comp) targets.push({ item, comp });
                }

                if (targets.length === 0) {
                    throw new Error("No eligible components found for PO amendment extension");
                }

                let hasLeftover = false;
                targets.forEach(({ item, comp }) => {
                    const res = executeComponentPoCancelOrExtension(item, comp, cancelReason, true);
                    if (res.leftoverQty > 0.0001 || res.type === 'CANCELLED') hasLeftover = true;
                });

                if (hasLeftover && [OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING, OrderStatus.READY_FOR_PRODUCTION].includes(order.status)) {
                    const oldOrdStatus = order.status;
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog(`[AUTO] Order reverted from ${oldOrdStatus} to WAITING_SUPPLIERS: components require re-procurement after PO amendment extension.`, order.status, 'System'));
                }
                break;
            }

            case 'revert-po': {
                if (!payload.componentId) throw new Error("componentId required");
                const itemIdx = order.items.findIndex(i => i.id === payload.itemId);
                if (itemIdx === -1) throw new Error("Item not found");
                const comp = order.items[itemIdx].components?.find(c => c.id === payload.componentId);
                if (!comp) throw new Error("Component not found");
                if (!['ORDERED', 'WAITING_CONTRACT_START', 'RUNNING_CONTRACT', 'RECEIVED', 'STOCKED', 'RESERVED'].includes(comp.status)) {
                    throw new Error("Component is not in a PO or received status");
                }
                const oldStatus = comp.status;
                const oldPoNumber = comp.poNumber || 'N/A';
                const revertReason = (payload.reason || '').trim() || 'Reverted to award by user';

                // Release any received quantity to free warehouse stock
                transferReceivedItemsToFreeStock(order, db, `PO Revert to Award: ${revertReason}`, user, comp.id);

                // The PO is void: what was allocated to it goes back to the supplier general wallet as an unallocated advance (no refund action; finance may allocate it again).
                (db.supplierPayments || []).forEach(sp => {
                    const mine = (sp.allocations || []).filter(x => x.componentId === comp.id);
                    if (!mine.length) return;
                    const back = mine.reduce((t, x) => t + (Number(x.amount) || 0), 0);
                    sp.allocations = sp.allocations.filter(x => x.componentId !== comp.id);
                    sp.unallocatedAdvance = Math.round(((Number(sp.unallocatedAdvance) || 0) + back) * 100) / 100;
                });
                comp.status = 'AWARDED';
                comp.statusUpdatedAt = new Date().toISOString();
                comp.revertedPoNumber = oldPoNumber;
                comp.revertReason = revertReason;
                comp.lastAction = 'REVERTED_TO_AWARD';
                comp.lastActionComment = revertReason;
                delete comp.cancellationReason;
                delete comp.sendPoId;
                delete comp.poNumber;
                delete comp.contractStartDate;
                delete comp.contractNumber;
                order.logs.push(createAuditLog(`Reverted PO for component ${comp.description} (PO: ${oldPoNumber}) from ${oldStatus} back to AWARDED. Reason: ${revertReason}.`, 'REVERTED_TO_AWARD', user));
                if ([OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING, OrderStatus.READY_FOR_PRODUCTION].includes(order.status)) {
                    const oldOrdStatus = order.status;
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                    order.logs.push(createAuditLog(`[AUTO] Order reverted from ${oldOrdStatus} to WAITING_SUPPLIERS: component returned to AWARDED status.`, order.status, 'System'));
                }
                break;
            }

            case 'cancel-payment':
                if (!order.payments || !order.payments[payload.index]) throw new Error("Payment index not found");
                // R34 round 8 (validator 7, defect 1): a wallet-transfer row (money moved between the customer's own accounts, no cash)
                // is never voided: a void would drop the PO money without giving it back to the source wallet (transfer in) or bring
                // back money already sitting in the general wallet (transfer out, -N row), so Cash / Bank would no longer equal the
                // customer wallets. The correction is a wallet transfer back.
                if (order.payments[payload.index].transfer) {
                    const tp = order.payments[payload.index];
                    throw new Error(`Refused: payment ${tp.receiptNumber || payload.index} is a wallet transfer (${Number(tp.amount) < 0 ? 'out of' : 'into'} PO ${order.internalOrderNumber}), not a cash payment; it cannot be voided - use a wallet transfer back instead.`);
                }
                // R34 round 9 (validator 8, defect 1): money moved OUT of this PO by wallet transfer (the -N rows, net of transfers in)
                // came out of the money paid in. Voiding a cash payment may not leave less paid-in money (payments without the transfer
                // rows) than the net moved out: the PO wallet would go below zero, AR above the PO gross and the customer wallets would
                // keep money the bank no longer holds. The money has to be transferred back first.
                {
                    const fxC1 = orderFx(order);
                    const pv = order.payments[payload.index];
                    const paidInAfterLE = r2w(orderPaymentsLE(order, p => !p.transfer) - paymentLE(pv, fxC1));
                    const netOutLE = r2w(-orderPaymentsLE(order, p => Boolean(p.transfer)));
                    if (netOutLE > 0.004 && paidInAfterLE < netOutLE - 0.004) {
                        throw new Error(`Refused: ${netOutLE.toFixed(2)} L.E. of PO ${order.internalOrderNumber} was moved out by wallet transfer; voiding payment ${pv.receiptNumber || payload.index} would leave only ${Math.max(0, paidInAfterLE).toFixed(2)} L.E. paid in - transfer the moved money back first (wallet transfer into the PO), then void the payment.`);
                    }
                }
                // R34 round 9 (validator 8, defect 2): a payment on a CLOSED blanket contract or on a call-off of a closed contract is part
                // of the close settlement: the close moved (paid - called-off gross) to the customer general wallet (surplusMovedToWalletLE
                // on the contract). A void takes back what the close would no longer have moved; when the general wallet no longer holds
                // that money the void is refused.
                let closedTakeBack = null;
                {
                    const rootC = (order.blanketOrder && !order.blanketContractId) ? order : (order.blanketContractId ? blanketRootOf(order, db.orders || []) : null);
                    const prevC = rootC ? ((rootC.surplusMovedToWalletLE !== undefined && rootC.surplusMovedToWalletLE !== null) ? Number(rootC.surplusMovedToWalletLE) || 0 : (Number(rootC.surplusMovedToWallet) || 0) * orderFx(rootC)) : 0;
                    if (rootC && rootC.contractClosed && prevC > 0.004 && order.status !== OrderStatus.REJECTED) {
                        const callsC = callOffsOfBlanket(rootC, db.orders || []); // R34 round 12: shared link rule
                        if (order !== rootC && !callsC.includes(order)) callsC.push(order);
                        const r2c = x => Math.round((x + Number.EPSILON) * 100) / 100;
                        let delOC = 0, delLE = 0;
                        callsC.forEach(o => { const fxD = orderFx(o); (o.items || []).forEach(it => { const ln = r2c((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0)); const g = ln + r2c(ln * (it.taxPercent || 0) / 100); delOC += g; delLE += g * fxD; }); });
                        const pv = order.payments[payload.index];
                        const paidOC = [rootC, ...callsC].reduce((t, o) => t + (o.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0), 0) - (Number(pv.amount) || 0);
                        const paidLE = r2w([rootC, ...callsC].reduce((t, o) => t + orderPaymentsLE(o), 0) - paymentLE(pv, orderFx(order)));
                        const keepLE = Math.max(0, r2w(paidLE - r2w(delLE)));
                        const keepOC = Math.max(0, r2w(paidOC - r2w(delOC)));
                        const backLE = r2w(prevC - keepLE);
                        if (backLE > 0.004) {
                            const custC = (db.customers || []).find(c => c.name === order.customerName);
                            const inG = custC ? r2w(availableGeneralWallet(db, custC)) : 0; // R34 round 11: rule G1 (spendable general wallet)
                            if (!custC || inG < backLE - 0.004) {
                                throw new Error(`Refused: the close of blanket contract ${rootC.internalOrderNumber} moved ${prevC.toFixed(2)} L.E. to the customer general wallet; voiding payment ${pv.receiptNumber || payload.index} takes back ${backLE.toFixed(2)} L.E., but the general wallet holds only ${inG.toFixed(2)} L.E. - bring the money back to the general wallet first, then void the payment.`);
                            }
                            closedTakeBack = { rootC, custC, backLE, keepLE, keepOC };
                        }
                    }
                }
                // R34 round 10 (validator 9, defect 1): the void of a payment on a normal PO takes back from the customer general wallet
                // (a) the part of the PO surplus that was moved there (R30) and is no longer covered once the payment is gone, and (b) on a
                // cancelled (REJECTED) PO the cash part of the payment that sits there as moved paid money (R24 / C17, refunded to the bank).
                // When the general wallet no longer holds that money (refunded or spent), the void would push it below zero: it is refused,
                // as on a closed blanket contract. Checked before anything changes.
                // v1.0001221 (validator 15e G3, G4): ONE plan for the check and the void. The voided payment's money comes, in this order, from
                // (a) the R30 surplus it no longer covers, (b) on a cancelled (REJECTED) PO the paid money THIS cancel moved to the general
                // wallet (paymentMovedByCancel), (c) paid money of an earlier cancel that a reopen could not take back (spent or refunded there:
                // paymentMovedToWallet - paymentMovedByCancel). On a cancelled PO (a) + (b) + (c) together are the cash part, so the surplus is
                // never taken twice (G4). On a reopened PO, (c) applies only to a payment that existed at that cancel (paidBeforeMovedLeftover);
                // a later payment is voided off the order as usual (G3: out of the bank, its wallet part back to the wallet, marker unchanged).
                const vPlan = (() => {
                    const pv = order.payments[payload.index];
                    const fx = orderFx(order);
                    const leOr = (le, oc) => (le !== undefined && le !== null && Number.isFinite(Number(le))) ? Number(le) : (Number(oc) || 0) * fx;
                    const pvLE = r2w(paymentLE(pv, fx));
                    const isCash = !pv.transfer && Number(pv.amount) > 0;
                    const w = isCash ? Math.max(0, Math.min(pvLE, r2w(leOr(pv.walletPartLE, pv.walletPart)))) : 0;
                    const c = isCash ? Math.max(0, r2w(pvLE - w)) : 0;
                    const rejected = order.status === OrderStatus.REJECTED;
                    const movedOC = Number(order.paymentMovedToWallet) || 0;
                    const movedLE = leOr(order.paymentMovedToWalletLE, order.paymentMovedToWallet);
                    const hasCredit = order.paymentMovedByCancel !== undefined && order.paymentMovedByCancel !== null;
                    const creditOC = rejected ? Math.min(movedOC, hasCredit ? (Number(order.paymentMovedByCancel) || 0) : movedOC) : 0;
                    const creditLE = rejected ? Math.min(movedLE, hasCredit ? leOr(order.paymentMovedByCancelLE, order.paymentMovedByCancel) : movedLE) : 0;
                    const leftOC = Math.max(0, r2w(movedOC - creditOC)), leftLE = Math.max(0, r2w(movedLE - creditLE));
                    // v1.0001222 (validator 16 G3b) / v1.0001223 (validator 17 G3d): with per-payment shares (movedLeftoverLE) the voided
                    // payment reaches (c) only up to its OWN share. Once an order was on the share model it stays there (order marker):
                    // a payment without a share (recorded after the reopen) reaches none of the left-over.
                    const perPay = hasMovedLeftoverShares(order);
                    const shareLE = isCash && perPay ? Math.max(0, Math.min(leftLE, r2w(Number(pv.movedLeftoverLE) || 0))) : 0;
                    const ocOf = (le, totLE, totOC) => totLE > 0.004 ? (le >= totLE - 0.004 ? totOC : r2w(totOC * le / totLE)) : 0;
                    const shareOC = ocOf(shareLE, leftLE, leftOC);
                    let backSOC = 0, backSLE = 0, keepSOC = 0, keepSLE = 0, smPlan = null;
                    if (!order.blanketOrder && !order.blanketContractId && Number(order.surplusMovedToWallet) > 0) {
                        const gross = orderCommitmentGross(order);
                        // v1.0001223 (validator 17 G3c): the voided payment's own share leaves the left-over together with the payment, so
                        // the money still counted on the order after the void is the other payments minus the OTHER payments' left-over
                        // (left-over minus this share). Before, the whole left-over was subtracted: the surplus step kept too little, took too
                        // much surplus and the share was only partly taken (the void result depended on the order of the voids).
                        const paidAllOC = (order.payments || []).reduce((sm, pp) => sm + (Number(pp.amount) || 0), 0);
                        const paidNow = paidAllOC - (Number(pv.amount) || 0) - r2w(leftOC - shareOC);
                        const keepAfterOC = Math.max(0, r2w(paidNow - gross));
                        // v1.0001224 (validator 18 G3e): a surplus moved to the general wallet BEFORE a cancel is no longer covered by the
                        // order once a partial reopen left it underpaid (stale part = surplus - what the order holds above its gross before
                        // the void, with the WHOLE left-over off the order). The reopen spread (spreadMovedLeftoverLE) counts that stale part
                        // as the newest payments' money (free = payment L.E. - its share); the void takes back the same slice: the drop of
                        // the covered surplus plus the voided payment's OWN slice of the stale part, the other slices stay in the general
                        // wallet. A surplus that fits the payments has no stale part (figures unchanged).
                        const prevLE = leOr(order.surplusMovedToWalletLE, order.surplusMovedToWallet);
                        const surOC = Number(order.surplusMovedToWallet) || 0;
                        const keepBeforeOC = Math.max(0, r2w(paidAllOC - leftOC - gross));
                        const keepBeforeLE = Math.max(0, r2w(orderPaymentsLE(order) - leftLE - gross * fx));
                        // v1.0001225 (validator 19 G3g): the stale part is a rule of the SHARE model only (an order a partial reopen put on
                        // the share model: shares / movedLeftoverShared). An order that never had a reopen spread (e.g. its gross was raised after an
                        // overpayment, no cancel) keeps the v1.0001223 rule: the surplus kept is what the remaining payments hold above the
                        // gross (R30 drop), so a void takes back every part of the surplus the order no longer covers.
                        const isMarkedPay = (pp) => Boolean(pp) && Number(pp.amount) > 0 && pp.movedLeftoverAtSpread === true;
                        const isLaterPay = (pp) => Boolean(pp) && Number(pp.amount) > 0 && pp.movedLeftoverAtSpread !== true;
                        const hasMarks = (order.payments || []).some(isMarkedPay);
                        const hasLater = hasMarks && (order.payments || []).some(isLaterPay);
                        const smStored = order.surplusAtSpread !== undefined && order.surplusAtSpread !== null && Number.isFinite(Number(order.surplusAtSpread));
                        // v1.0001225 (validator 19 G3f): on an order with reopen marks the surplus that the payments of the latest reopen
                        // hold (order.surplusAtSpread, written by the reopen spread, server-owned, kept current by every void) is kept apart
                        // from the surplus that payments recorded AFTER that reopen moved: such a later payment first filled what the order
                        // was still owed (the stale part stays the marked payments' money) and only its rest moved on as its own surplus. A
                        // void is the undo in that order of events: surplus kept = the larger of (a) the marked payments' surplus after the
                        // void (their covered part + their stale part without the voided payment's own slice) and (b) what all remaining
                        // payments hold above the gross. Without a later payment (b) <= (a) and (a) is the v1.0001224 figure (X10, N9,
                        // FB117-FB122 unchanged); a later payment's void takes back only the surplus it moved itself (V2: 200, not 400).
                        // v1.0001226 (validator 20 G3f-c): the same surplus keep on a cancelled (REJECTED) order. The money counted on the
                        // order is the same there (leftOC / leftLE = the old left-over only, this cancel's credit is not part of it; the later
                        // payments are kept out of the marked payments' covered part), so a void while the order is cancelled keeps the surplus
                        // a void in the LOGGED state keeps; the rest of the cash part still comes from this cancel's credit (fromC below).
                        // Probe W4: cancel #2, void P3, reopen = void P3, cancel #2, reopen (3,000 / 340 / 800 / 200).
                        const useSM = perPay && hasMarks && (smStored || !hasLater);
                        if (useSM) {
                            const smOC = (smStored && hasLater) ? Math.max(0, Number(order.surplusAtSpread) || 0) : surOC;
                            const smLE = (smStored && hasLater) ? Math.max(0, leOr(order.surplusAtSpreadLE, order.surplusAtSpread)) : prevLE;
                            const laterOC = (order.payments || []).filter(isLaterPay).reduce((sm, pp) => sm + (Number(pp.amount) || 0), 0);
                            const laterLE = hasLater ? orderPaymentsLE(order, isLaterPay) : 0;
                            const covMOC = Math.max(0, r2w(paidAllOC - leftOC - laterOC - gross));
                            const covMLE = Math.max(0, r2w(orderPaymentsLE(order) - laterLE - leftLE - gross * fx));
                            const staleMOC = Math.max(0, r2w(smOC - covMOC));
                            const staleMLE = staleMOC > 0.004 ? Math.max(0, r2w(smLE - covMLE)) : 0;
                            let smAfterOC = smOC, smAfterLE = smLE;
                            if (isMarkedPay(pv)) {
                                // the stale part is the newest payments' money among those of the latest reopen (a later payment never holds it)
                                const sliceLE = staleMLE > 0.004 ? (surplusSlicesLE(order, staleMLE, fx, true).get(pv) || 0) : 0;
                                const sliceOC = ocOf(sliceLE, staleMLE, staleMOC);
                                const covM2OC = Math.max(0, r2w(paidNow - laterOC - gross));
                                const covM2LE = covM2OC > 0 ? Math.max(0, r2w(orderPaymentsLE(order) - laterLE - pvLE - r2w(leftLE - shareLE) - gross * fx)) : 0;
                                smAfterOC = r2w(covM2OC + Math.max(0, r2w(staleMOC - sliceOC)));
                                smAfterLE = r2w(covM2LE + Math.max(0, r2w(staleMLE - sliceLE)));
                            }
                            const useB = keepAfterOC > smAfterOC + 0.004;
                            keepSOC = Math.min(surOC, useB ? keepAfterOC : smAfterOC);
                            smPlan = { oc: Math.min(smAfterOC, surOC), le: Math.min(smAfterLE, prevLE) };
                            const bOC = r2w(surOC - keepSOC);
                            if (bOC > 0.004) {
                                const keepAfterLE = useB ? Math.max(0, r2w(orderPaymentsLE(order) - pvLE - r2w(leftLE - shareLE) - gross * fx)) : smAfterLE;
                                keepSLE = Math.min(prevLE, keepAfterLE);
                                backSOC = bOC;
                                backSLE = Math.max(0, r2w(prevLE - keepSLE));
                            }
                        } else {
                            const staleOC = perPay ? Math.max(0, r2w(surOC - keepBeforeOC)) : 0;
                            const staleLE = staleOC > 0.004 ? Math.max(0, r2w(prevLE - keepBeforeLE)) : 0;
                            const sliceLE = staleLE > 0.004 ? (surplusSlicesLE(order, staleLE, fx, true).get(pv) || 0) : 0;
                            const sliceOC = ocOf(sliceLE, staleLE, staleOC);
                            keepSOC = r2w(keepAfterOC + Math.max(0, r2w(staleOC - sliceOC)));
                            const bOC = r2w(surOC - keepSOC);
                            if (bOC > 0.004) {
                                const keepAfterLE = keepAfterOC > 0 ? Math.max(0, r2w(orderPaymentsLE(order) - pvLE - r2w(leftLE - shareLE) - gross * fx)) : 0;
                                keepSLE = r2w(keepAfterLE + Math.max(0, r2w(staleLE - sliceLE)));
                                backSOC = bOC;
                                backSLE = Math.max(0, r2w(prevLE - keepSLE));
                            }
                        }
                    }
                    const rest = isCash ? Math.max(0, r2w(pvLE - backSLE)) : 0;
                    // v1.0001222 (validator 16 G3b): the voided payment's OWN share comes first (it is the part of this payment that is off
                    // the order); the rest of its cash part then comes from this cancel's credit (b) on a cancelled PO. An order of an
                    // earlier version (no share data at all): every payment reaches the whole left-over (a payment flagged
                    // paidBeforeMovedLeftover by v1.0001221 only when flagged), credit first.
                    const eligible = Boolean(pv.paidBeforeMovedLeftover) || !(order.payments || []).some(pp => pp && pp.paidBeforeMovedLeftover);
                    let fromC, fromL;
                    if (perPay) {
                        fromL = r2w(Math.min(rest, shareLE));
                        fromC = rejected ? r2w(Math.max(0, Math.min(r2w(rest - fromL), creditLE))) : 0;
                    } else {
                        fromC = rejected ? r2w(Math.min(rest, creditLE)) : 0;
                        fromL = (rejected || eligible) ? r2w(Math.max(0, Math.min(r2w(rest - fromC), leftLE))) : 0;
                    }
                    // a cancelled PO whose cancel moved paid money: the whole cash part leaves the general wallet (its wallet part stays there)
                    const movedPath = rejected && movedOC > 0.004 && isCash;
                    const refundLE = movedPath ? r2w(Math.min(c, backSLE + fromC + fromL)) : r2w(Math.min(c, fromL));
                    return { smPlan, pv, pvLE, w, c, isCash, rejected, movedPath, movedOC, movedLE, creditOC, creditLE, leftOC, leftLE, backSOC, backSLE, keepSOC, keepSLE, fromC, fromL, perPay, shareLE,
                        fromCOC: ocOf(fromC, creditLE, creditOC), fromLOC: ocOf(fromL, leftLE, leftOC), refundLE };
                })();
                {
                    const vp = vPlan;
                    // general wallet money the void takes: on a cancelled PO the larger of the surplus step and the whole cash part (the
                    // surplus is taken first, the rest of the cash part after it); otherwise the surplus plus the spent credit of an earlier cancel
                    const needG = vp.movedPath ? r2w(Math.max(vp.backSLE, vp.refundLE)) : r2w(vp.backSLE + vp.fromL);
                    // the wallet part of a pay-from-wallet payment (not on a cancelled PO) goes back to the wallet bucket(s) it came from
                    // in the same void, so its general-wallet share counts as held money.
                    let backToG = 0;
                    if (needG > 0.004 && !vp.movedPath && vp.w > 0.004) {
                        const pvG = vp.pv;
                        const bkR = (pvG.walletBuckets && typeof pvG.walletBuckets === 'object' && Object.keys(pvG.walletBuckets).length) ? pvG.walletBuckets : { [SELF_WALLET_KEY]: vp.w };
                        const sumR = Object.values(bkR).reduce((t, v) => t + (Number(v) || 0), 0) || vp.w;
                        backToG = r2w(vp.w * (Number(bkR[SELF_WALLET_KEY]) || 0) / sumR);
                    }
                    if (needG > 0.004) {
                        const custG = (db.customers || []).find(c => c.name === order.customerName);
                        // R34 round 11 (validator 10, defect 4): the general wallet the void can take back from is the spendable one (rule G1:
                        // stored general bucket minus the company costs linked to no PO), as for refund and pay-from-wallet.
                        const inGG = custG ? r2w(availableGeneralWallet(db, custG) + backToG) : 0;
                        if (!custG || inGG < needG - 0.004) {
                            // v1.0001221 (G5) / v1.0001222 (validator 16 G5): the text names what the void takes back; when it takes more than one
                            // part (surplus, this payment's share of an earlier cancel, this cancel's credit) each part is named with its amount,
                            // in the order the plan takes them, up to the total (one part: the total already is its amount, text unchanged).
                            const TXT_S = 'the PO surplus moved there', TXT_C = 'the paid money of the cancelled PO moved there';
                            const TXT_L = 'the paid money of an earlier cancel of this PO that was spent or refunded there and that the reopen could not take back';
                            const parts = [];
                            let leftN = needG;
                            const addWhy = (amt, txt) => { const a = r2w(Math.min(Math.max(0, amt), leftN)); if (a > 0.004) { parts.push([a, txt]); leftN = r2w(leftN - a); } };
                            addWhy(vp.backSLE, TXT_S);
                            if (vp.perPay) addWhy(vp.fromL, TXT_L);
                            addWhy(vp.fromC, TXT_C);
                            if (!vp.perPay) addWhy(vp.fromL, TXT_L);
                            addWhy(leftN, vp.rejected ? TXT_C : TXT_L);
                            const why = parts.length > 1 ? parts.map(([a, t]) => `${a.toFixed(2)} L.E. of ${t}`) : parts.map(([, t]) => t);
                            throw new Error(`Refused: voiding payment ${vp.pv.receiptNumber || payload.index} of PO ${order.internalOrderNumber} takes back ${needG.toFixed(2)} L.E. from the customer general wallet (${why.join('; ')}), but the general wallet holds only ${inGG.toFixed(2)} L.E. - bring the money back to the general wallet first, then void the payment.`);
                        }
                    }
                }
                const [removed] = order.payments.splice(payload.index, 1);
                if (closedTakeBack) {
                    const { rootC, custC, backLE, keepLE, keepOC } = closedTakeBack;
                    custC.walletBalances = custC.walletBalances || {};
                    custC.walletBalances[SELF_WALLET_KEY] = r2w((Number(custC.walletBalances[SELF_WALLET_KEY]) || 0) - backLE);
                    custC.walletBalance = r2w((Number(custC.walletBalance) || 0) - backLE);
                    rootC.surplusMovedToWallet = keepOC;
                    rootC.surplusMovedToWalletLE = keepLE;
                    const msgC = `Payment voided on closed blanket contract ${rootC.internalOrderNumber}${order !== rootC ? ` (call-off ${order.internalOrderNumber})` : ''}: ${backLE.toFixed(2)} L.E. of the close overpayment taken back from the customer general wallet.`;
                    order.logs.push(createAuditLog(msgC, order.status, user));
                    if (order !== rootC) { rootC.logs = rootC.logs || []; rootC.logs.push(createAuditLog(msgC, rootC.status, user)); }
                }
                // v1.0001222 (validator 16 G5): the void log carries the order currency (a foreign-currency order also shows the L.E.)
                const curVd = order.currency && order.currency !== 'L.E.' ? order.currency : 'L.E.';
                order.logs.push(createAuditLog(`Payment of ${(Number(removed.amount) || 0).toLocaleString()} ${curVd}${curVd !== 'L.E.' ? ` (${vPlan.pvLE.toFixed(2)} L.E.)` : ''} VOIDED: ${payload.reason || 'Correction'}`, order.status, user));
                const custV = (db.customers || []).find(c => c.name === order.customerName);
                const takeGeneral = (amt) => {
                    if (!custV || Math.abs(amt) <= 0.004) return;
                    custV.walletBalances = custV.walletBalances || {};
                    custV.walletBalances[SELF_WALLET_KEY] = r2w((Number(custV.walletBalances[SELF_WALLET_KEY]) || 0) - amt);
                    custV.walletBalance = r2w((Number(custV.walletBalance) || 0) - amt); // R34 round 3 (item 3): stored total follows the bucket
                };
                // R30 (2026-10-22): voiding a payment also takes back the part of it that had been moved to the customer general wallet as surplus; a fully paid PO that is no longer fully paid leaves WAITING_GOVE.
                // R34 round 5 (item 4): in L.E. the surplus kept is what the PO still holds above its gross in L.E.
                if (vPlan.backSOC > 0.004 && custV) {
                    takeGeneral(vPlan.backSLE);
                    order.surplusMovedToWallet = vPlan.keepSOC;
                    order.surplusMovedToWalletLE = vPlan.keepSLE;
                    order.logs.push(createAuditLog(`Payment voided: ${vPlan.backSOC.toFixed(2)} ${curVd}${curVd !== 'L.E.' ? ` (${vPlan.backSLE.toFixed(2)} L.E.)` : ''} of the surplus taken back from the customer general wallet.`, order.status, user));
                }
                // v1.0001225 (validator 19 G3f): the marked payments' surplus follows the void (server-owned, cleared with the shares);
                // a void outside that rule (earlier data without the field) never leaves it above the surplus the order still records.
                if (vPlan.smPlan) { order.surplusAtSpread = vPlan.smPlan.oc; order.surplusAtSpreadLE = vPlan.smPlan.le; }
                else if (order.surplusAtSpread !== undefined && order.surplusAtSpread !== null) {
                    order.surplusAtSpread = r2w(Math.min(Number(order.surplusAtSpread) || 0, Number(order.surplusMovedToWallet) || 0));
                    order.surplusAtSpreadLE = r2w(Math.min(Number(order.surplusAtSpreadLE ?? order.surplusAtSpread) || 0, Number(order.surplusMovedToWalletLE ?? order.surplusMovedToWallet) || 0));
                }
                // the paid money of a cancel that the void takes off the order's markers (b: this cancel, c: an earlier one)
                if ((vPlan.fromC > 0.004 || vPlan.fromL > 0.004) && custV) {
                    order.paymentMovedToWallet = r2w(vPlan.movedOC - vPlan.fromCOC - vPlan.fromLOC);
                    order.paymentMovedToWalletLE = Math.max(0, r2w(vPlan.movedLE - vPlan.fromC - vPlan.fromL));
                    if (vPlan.rejected) {
                        order.paymentMovedByCancel = Math.max(0, r2w(vPlan.creditOC - vPlan.fromCOC));
                        order.paymentMovedByCancelLE = Math.max(0, r2w(vPlan.creditLE - vPlan.fromC));
                    }
                }
                // v1.0001222 (validator 16 G3b): a share of the voided payment that the void did not take stays off the order; it moves to
                // the remaining payments so the shares still add up to the left-over. v1.0001223 (validator 17 G3c): the surplus step now
                // leaves the share whole, so this happens only on an order whose surplus figure no longer fits its payments; the share
                // then moves only to payments that already carry one (never to a payment recorded after the reopen).
                if (vPlan.perPay && r2w(vPlan.shareLE - vPlan.fromL) > 0.004) spreadMovedLeftoverLE(order, r2w(vPlan.shareLE - vPlan.fromL), { holdersOnly: true });
                if (!(Number(order.paymentMovedToWallet) > 0.004)) clearMovedLeftoverShares(order);
                if (order.status === OrderStatus.WAITING_GOVE && !isOrderFullyPaid(order)) { order.status = OrderStatus.DELIVERED; setGovWaitLines(order, false); }
                // R34 round 7 (validator 6, defect 7): every figure of the void is in L.E. A pay-from-wallet payment is split into its
                // wallet part (walletPartLE: money that was already in the bank as a customer advance) and its cash part (the rest of the
                // payment in L.E.). The wallet part goes back to the wallet bucket(s) it came from (Cash / Bank keeps that money, the
                // TRANSFER of that receipt no longer counts once the payment is gone); only the cash part is reversed out of the bank.
                const fxVd = orderFx(order);
                const walletPartLEV = vPlan.w;
                const cashPartLEV = vPlan.c;
                // R21 (C13): a voided cash payment needs a reversing ledger entry (bank back to the order account).
                if (vPlan.movedPath && custV) {
                    // R24 (C17): the paid amount of this cancelled order already sits in the customer general wallet; voiding it
                    // refunds the customer from that credit (wallet -> Bank, REFUND, no P&L) instead of reversing a bank-to-order entry.
                    // Round 7: only the CASH part is refunded (in L.E.); the wallet part simply stays in the general wallet.
                    // v1.0001221 (G4): the surplus step above already took its part; the rest of the cash part is taken here, and the REFUND
                    // row states the whole cash part refunded.
                    takeGeneral(r2w(vPlan.refundLE - vPlan.backSLE));
                    if (vPlan.refundLE > 0.004) ledgerPush(db, { type: 'REFUND', amount: vPlan.refundLE, description: `Payment VOIDED (cancelled PO ${order.internalOrderNumber}): refunded from customer general wallet - ${payload.reason || 'Correction'}`, category: 'Customer Refunds', voidOfPayment: true, fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: 'Bank Account', customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber }, user);
                    const restC = r2w(cashPartLEV - vPlan.refundLE);
                    if (restC > 0.004) ledgerPush(db, { type: 'DEDUCTION', amount: restC, description: `Payment VOIDED: ${order.customerName} - PO ${order.internalOrderNumber} - ${payload.reason || 'Correction'}${fxVd !== 1 ? ` (${(restC / fxVd).toFixed(2)} ${order.currency} at rate ${fxVd})` : ''}`, category: 'Customer Payment Reversal', fromAccount: 'Bank Account', toAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, voidOfPayment: true }, user);
                } else if (!removed.transfer && Number(removed.amount) > 0) {
                    if (walletPartLEV > 0.004) {
                        const custR = custV;
                        if (custR) {
                            custR.walletBalances = custR.walletBalances || {};
                            const bk = (removed.walletBuckets && typeof removed.walletBuckets === 'object' && Object.keys(removed.walletBuckets).length) ? removed.walletBuckets : { [SELF_WALLET_KEY]: walletPartLEV };
                            const bkSum = Object.values(bk).reduce((t, v) => t + (Number(v) || 0), 0) || walletPartLEV;
                            let restR = walletPartLEV;
                            const keysR = Object.keys(bk);
                            keysR.forEach((k, i) => {
                                const part = i === keysR.length - 1 ? restR : Math.round(walletPartLEV * (Number(bk[k]) || 0) / bkSum * 100) / 100;
                                restR = Math.round((restR - part) * 100) / 100;
                                custR.walletBalances[k] = Math.round(((Number(custR.walletBalances[k]) || 0) + part) * 100) / 100;
                            });
                            custR.walletBalance = Math.round(((Number(custR.walletBalance) || 0) + walletPartLEV) * 100) / 100;
                            ledgerPush(db, { type: 'TRANSFER', amount: walletPartLEV, description: `Payment VOIDED: wallet part of ${removed.receiptNumber || 'the payment'} returned from PO ${order.internalOrderNumber} to the customer wallet - ${payload.reason || 'Correction'}`, category: 'Account Transfer', voidOfPayment: true, walletTransfer: true, fromAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), toAccount: acctLabel(order.customerName, 'SELF', 'Self'), customerName: order.customerName }, user);
                            order.logs.push(createAuditLog(`Payment voided: ${walletPartLEV.toFixed(2)} L.E. paid from the customer wallet returned to the wallet.`, order.status, user));
                        }
                    }
                    // v1.0001220 (N1) / v1.0001221 (G3): on a reopened order, a payment that existed at the cancel whose paid money the reopen
                    // could not take back (spent or refunded from the general wallet) takes that part back from the general wallet (REFUND);
                    // the rest of its cash part is reversed out of the bank as a normal void.
                    if (vPlan.fromL > 0.004 && custV) {
                        takeGeneral(vPlan.fromL);
                        order.logs.push(createAuditLog(`Payment voided: ${vPlan.fromL.toFixed(2)} L.E. of it was paid money of the earlier cancel that was spent or refunded from the customer general wallet; taken back from the general wallet.`, order.status, user));
                        if (vPlan.refundLE > 0.004) ledgerPush(db, { type: 'REFUND', amount: vPlan.refundLE, description: `Payment VOIDED (reopened PO ${order.internalOrderNumber}): paid money of the earlier cancel taken back from the customer general wallet - ${payload.reason || 'Correction'}`, category: 'Customer Refunds', voidOfPayment: true, fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: 'Bank Account', customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber }, user);
                    }
                    const dedLE = r2w(cashPartLEV - (vPlan.fromL > 0.004 && custV ? vPlan.refundLE : 0));
                    if (dedLE > 0.004) ledgerPush(db, { type: 'DEDUCTION', amount: dedLE, description: `Payment VOIDED: ${order.customerName} - PO ${order.internalOrderNumber} - ${payload.reason || 'Correction'}${fxVd !== 1 ? ` (${(dedLE / fxVd).toFixed(2)} ${order.currency} at rate ${fxVd})` : ''}`, category: 'Customer Payment Reversal', fromAccount: 'Bank Account', toAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, voidOfPayment: true }, user);
                }
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
                if (!isAdminUser(req) && !(req.roles || []).includes('management')) throw new Error("Only management can release a margin block");
                if (order.status !== OrderStatus.NEGATIVE_MARGIN) throw new Error("Order does not have a margin block");
                order.status = ((order.items || []).length > 0 && order.items.every(i => i.productionType === 'OUTSOURCING')) ? OrderStatus.RUNNING_OUTSOURCING_CONTRACT : OrderStatus.WAITING_SUPPLIERS; // Return to procurement flow (R30 19:24: outsourcing never WAITING_SUPPLIERS)
                {
                    const dbS = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
                    let mm = dbS.minimumMarginPct || 15;
                    const cu = db.customers.find(c => c.name === order.customerName);
                    if (cu && cu.minimumMarginPct !== undefined && cu.minimumMarginPct !== null) mm = cu.minimumMarginPct;
                    order.marginReleasedSig = marginReleaseSig(order.items, mm, marginFx(order)); // release holds until price, cost, rate or threshold changes
                }
                order.logs.push(createAuditLog(`Margin block manually bypassed: ${payload?.reason || 'Management overrides'}`, order.status, user));
                break;


            case 'alter-line-item-qty': {
                const { itemId, newQty, reason } = payload;
                if (!itemId) throw new Error("itemId is required for quantity alteration");
                const targetItem = order.items.find(i => i.id === itemId);
                if (!targetItem) throw new Error("Line item not found in order");
                // R34 round 10 (validator 9, defect 3): the lines of a call-off of a closed blanket contract are settled.
                { const rootA = closedRootOfCallOff(order, db.orders || []); if (rootA) throw new Error(`Refused: order ${order.internalOrderNumber} is a call-off of the closed blanket contract ${rootA.internalOrderNumber}; the closed settlement is final - its line quantities cannot change.`); }
                const currentQty = targetItem.quantity || 1;
                const delivered = targetItem.deliveredQty || 0;
                if (newQty > currentQty) {
                    throw new Error(`Cannot increase quantity above original order quantity (${currentQty}).`);
                }
                if (newQty < delivered) {
                    throw new Error(`Cannot reduce quantity below already delivered amount (${delivered}).`);
                }
                if (newQty === currentQty) {
                    delete targetItem.alteredQty;
                    delete targetItem.alterationComment;
                    if (targetItem.productionType === 'TRADING' && targetItem.components && targetItem.components.length > 0) {
                        targetItem.components[0].quantity = currentQty;
                    }
                    order.logs.push(createAuditLog(`Line item quantity restored to original: ${targetItem.description} = ${currentQty} units. Reason: ${reason || 'N/A'}`, order.status, user));
                } else {
                    targetItem.alteredQty = newQty;
                    targetItem.alterationComment = reason || '';

                    // Proportionally rescale BoM quantities for all production types
                    if (targetItem.components && targetItem.components.length > 0) {
                        const ratio = currentQty > 0 ? newQty / currentQty : 1;
                        if (ratio < 1) { // only when lowering
                            for (const comp of targetItem.components) {
                                const oldCompQty = comp.quantity || 0;
                                const newCompQty = Number((oldCompQty * ratio).toFixed(3));
                                const qtyDelta = oldCompQty - newCompQty;

                                // Update the target quantity
                                comp.quantity = newCompQty;

                                // For MANUFACTURING: release excess un-consumed inventory back to stock
                                if (targetItem.productionType === 'MANUFACTURING' && qtyDelta > 0) {
                                    const invItem = (db.inventory || []).find(i => i.id === comp.inventoryItemId);
                                    if (invItem) {
                                        if (comp.status === 'RESERVED' || comp.status === 'AVAILABLE') {
                                            // R24: reconcileInventory lowers the reservation when comp.quantity drops; a direct decrement here released it twice (negative reserved).
                                        } else if (['RECEIVED', 'STOCKED', 'IN_STOCK', 'CONSUMED', 'Manufactured'].includes(comp.status)) {
                                            if (comp.consumedQty && comp.consumedQty > 0) {
                                                const overConsumed = Math.min(qtyDelta, comp.consumedQty);
                                                comp.consumedQty = Math.max(0, (comp.consumedQty || 0) - overConsumed);
                                                invItem.quantityInStock = (invItem.quantityInStock || 0) + overConsumed;
                                            }
                                            if (comp.receivedQty && comp.receivedQty > 0) {
                                                const overReceived = Math.min(qtyDelta, comp.receivedQty);
                                                comp.receivedQty = Math.max(0, (comp.receivedQty || 0) - overReceived);
                                                // Received items are already in stock; do NOT subtract.
                                                // They simply become free/unbound stock now.
                                            }
                                        }
                                        invItem.lastUpdated = new Date().toISOString();
                                    }
                                }
                            }
                        }
                    }

                    if (targetItem.productionType === 'TRADING' && targetItem.components && targetItem.components.length > 0) {
                        targetItem.components[0].quantity = newQty;
                    }
                    order.logs.push(createAuditLog(`Line item quantity adjusted: ${targetItem.description} from ${currentQty} to ${newQty} effective units. Reason: ${reason || 'N/A'}`, order.status, user));
                }
                break;
            }            case 'record-payment':
                // R34 round 8 (validator 7, defect 5): a cancelled (REJECTED) PO takes no new money: its paid money already moved to the
                // customer general wallet, a new payment would sit on a dead PO (Cash / Bank up, customer wallets not). Pay an advance
                // into the general wallet instead.
                if (order.status === OrderStatus.REJECTED) throw new Error(`Refused: order ${order.internalOrderNumber} is cancelled (REJECTED); no payment can be recorded on it - record a customer advance to the general wallet instead.`);
                { const cpR = closedCallOffPaymentRefusal(db, order, r2w((Number(payload && payload.amount) || 0) * orderFx(order))); if (cpR) throw new Error(cpR); }
                if (!order.payments) order.payments = [];
                const paymentIndex = order.payments.length + 1;
                // Create unique receipt number: RCV-{OrderNumber}-{PaymentIndex}-{Timestamp}
                const timestamp = Date.now().toString().slice(-4); // Last 4 digits of timestamp
                const orderShortId = order.internalOrderNumber.replace(/[^\w]/g, '').slice(-6); // Last 6 alphanumeric chars
                const receiptNumber = `RCV-${orderShortId}-${String(paymentIndex).padStart(2, '0')}-${timestamp}`;
                const paymentEntry = {
                    amount: payload.amount,
                    date: new Date().toISOString(),
                    user,
                    memo: payload.memo || 'Regular payment',
                    receiptNumber
                };
                order.payments.push(paymentEntry);

                // Add to order history for billing details tracking
                if (!order.history) order.history = [];
                order.history.push({
                    timestamp: new Date().toISOString(),
                    message: `Payment Recorded: ${payload.amount.toLocaleString()} L.E. - ${payload.memo || 'No comment'}`,
                    status: order.status,
                    user: user,
                    type: 'payment',
                    amount: payload.amount,
                    receiptNumber: receiptNumber
                });

                const totalPaid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);

                let walletUsedForLedger = 0;
                let walletUsedLE = 0;
                if (payload.fromWallet && payload.amount > 0) {
                    const customer = (db.customers || []).find(c => c.name === order.customerName);
                    // R34 round 3 (validator 2, item 3): the money available is what the stored wallet buckets hold (a refund or a
                    // transfer lowers the bucket), not a stale total; the stored total follows the buckets.
                    // R34 round 4 (validator 3) RULINGS: D4 the PO's OWN project bucket is used first, then the general wallet only; the
                    // money of another project is never used. D5 the general wallet can give at most the stored general bucket minus the
                    // company costs linked to no PO (rule G1, = Initial Balances), so the wallet never goes negative.
                    const bucketsW = (customer && customer.walletBalances) || {};
                    const hasBucketsW = Object.keys(bucketsW).length > 0;
                    const projW = orderProjectName(order, db.orders || []);
                    const projKeysW = projW ? Object.keys(bucketsW).filter(k => k !== SELF_WALLET_KEY && k.trim() === projW) : [];
                    const projAvailW = Math.round(projKeysW.reduce((t, k) => t + Math.max(0, Number(bucketsW[k]) || 0), 0) * 100) / 100;
                    const genAvailW = customer ? Math.max(0, hasBucketsW ? availableGeneralWallet(db, customer) : Math.round(((Number(customer.walletBalance) || 0) - g1DeductionFor(db)) * 100) / 100) : 0;
                    const availW = Math.round((projAvailW + genAvailW) * 100) / 100;
                    if (customer && availW > 0) {
                        // the payment is typed in the ORDER currency, the wallet holds L.E. (item 1/3: a USD PO at rate 50 takes 50 L.E. per USD)
                        const fxW = orderFx(order);
                        const deductAmt = Math.round(Math.min(Number(payload.amount) || 0, availW / fxW) * 100) / 100;
                        const deductLE = Math.round(Math.min(availW, deductAmt * fxW) * 100) / 100;
                        walletUsedForLedger = deductAmt;
                        walletUsedLE = deductLE;
                        const usedW = [];
                        const bucketsUsedW = {}; // R34 round 7 (defect 7): which wallet buckets gave the money, so a void returns it there
                        if (hasBucketsW) {
                            let restW = deductLE;
                            for (const key of projKeysW) {
                                if (restW <= 0.004) break;
                                const kDeduct = Math.min(restW, Math.max(0, Number(customer.walletBalances[key]) || 0));
                                if (kDeduct > 0) { customer.walletBalances[key] = Math.round((customer.walletBalances[key] - kDeduct) * 100) / 100; restW = Math.round((restW - kDeduct) * 100) / 100; usedW.push(`${key} ${kDeduct.toFixed(2)}`); bucketsUsedW[key] = Math.round(((bucketsUsedW[key] || 0) + kDeduct) * 100) / 100; }
                            }
                            if (restW > 0.004) {
                                const gDeduct = Math.min(restW, genAvailW);
                                customer.walletBalances[SELF_WALLET_KEY] = Math.round(((Number(customer.walletBalances[SELF_WALLET_KEY]) || 0) - gDeduct) * 100) / 100;
                                restW = Math.round((restW - gDeduct) * 100) / 100;
                                usedW.push(`general wallet ${gDeduct.toFixed(2)}`);
                                bucketsUsedW[SELF_WALLET_KEY] = Math.round(((bucketsUsedW[SELF_WALLET_KEY] || 0) + gDeduct) * 100) / 100;
                            }
                        }
                        if (Object.keys(bucketsUsedW).length) paymentEntry.walletBuckets = bucketsUsedW;
                        customer.walletBalance = Math.max(0, Math.round(((customer.walletBalance || 0) - deductLE) * 100) / 100);
                        paymentEntry.walletPart = deductAmt;
                        // R34 round 6 (validator 5, D1): the exact L.E. taken from the wallet (5,000.00, not 105.71 x 47.3 = 5,000.08)
                        paymentEntry.walletPartLE = deductLE;
                        if (deductAmt + 0.004 >= (Number(payload.amount) || 0)) paymentEntry.fromWallet = true;
                        order.logs.push(createAuditLog(`Applied ${deductLE.toLocaleString()} L.E. from Customer Wallet balance${usedW.length ? ` (${usedW.join(', ')})` : ''}. Remaining wallet: ${customer.walletBalance.toLocaleString()} L.E.`, order.status, user));
                    }
                }

                {
                    // Ledger: new cash from the customer is an ADDITION to the bank; the part taken from the
                    // customer's wallet is only an account transfer (wallet -> this PO), no new cash.
                    const payAmt = Number(payload.amount) || 0;
                    const fromWalletAmt = Math.min(payAmt, Number(walletUsedForLedger) || 0);
                    const cashAmt = Math.round((payAmt - fromWalletAmt) * 100) / 100;
                    const poAcct = acctLabel(order.customerName, 'ORDER', order.internalOrderNumber);
                    // R34 round 6 (validator 5, D1): the TRANSFER is the exact L.E. taken from the wallet and the cash ADDITION is the
                    // rest of the payment in L.E. (amount x rate - wallet L.E.), so both add up to the payment at a non-round rate:
                    // 228 USD @ 47.3 = 10,784.40 = TRANSFER 5,000.00 + cash 5,784.40.
                    const fxP = orderFx(order);
                    const walletLE = fromWalletAmt > 0 ? Math.round((walletUsedLE || fromWalletAmt * fxP) * 100) / 100 : 0;
                    const cashLE = fromWalletAmt > 0 ? Math.round((payAmt * fxP - walletLE) * 100) / 100 : Math.round(cashAmt * fxP * 100) / 100;
                    if (cashAmt > 0 && cashLE > 0.004) ledgerPush(db, { type: 'ADDITION', amount: cashLE, description: `Customer Payment: ${order.customerName} - PO ${order.internalOrderNumber} - ${payload.memo || 'Regular payment'}`, category: 'Customer Payment', fromAccount: poAcct, toAccount: 'Bank Account', customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, receiptNumber }, user);
                    if (fromWalletAmt > 0) ledgerPush(db, { type: 'TRANSFER', amount: walletLE, description: `Wallet applied to PO ${order.internalOrderNumber}`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: poAcct, customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, receiptNumber }, user);
                }

                // User ruling 2026-10-21 (21:45): no refund action. A customer payment above the PO gross moves to the customer GENERAL wallet; the PO keeps exactly its commitment.
                moveOrderSurplusToGeneralWallet(db, order, user);

                // User ruling 2026-10-21 (22:52): the project wallet first shows the FULL payment incl. the 1% withholding, then the 1% goes to the tax-authority account (display lines only; wallet totals unchanged).
                if (order.appliesWithholdingTax && !order.whtLedgerBooked && isOrderFullyPaid(order)) {
                    const whtA = orderWhtAmount(order);
                    if (whtA > 0) {
                        const poAcctW = acctLabel(order.customerName, 'ORDER', order.internalOrderNumber);
                        ledgerPush(db, { type: 'TRANSFER', amount: Math.round(orderCommitmentGross(order) * orderFx(order) * 100) / 100, description: `PO ${order.internalOrderNumber}: full payment shown in the PO account incl. the 1% withholding (withholding ${whtA.toFixed(2)}; full payment shown ${(orderCommitmentGross(order)).toFixed(2)})`, category: 'Withholding Tax', fromAccount: `Customer ${order.customerName} / Withholding held by customer`, toAccount: poAcctW, orderId: order.id }, user);
                        ledgerPush(db, { type: 'TRANSFER', amount: Math.round(whtA * orderFx(order) * 100) / 100, description: `PO ${order.internalOrderNumber}: 1% withholding to the tax-authority account (waiting for the certificate)`, category: 'Withholding Tax', fromAccount: poAcctW, toAccount: 'Tax Authority / Withholding', orderId: order.id }, user);
                        order.whtLedgerBooked = true;
                    }
                }

                const fullyPaid = isOrderFullyPaid(order);
                const fullyDelivered = isOrderFullyDelivered(order);
                const isLateStage = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.WAITING_GOVE].includes(order.status);

                // Check if Gov.E invoice has been issued
                const hasGovEInvoice = order.logs?.some(log => log.message && log.message.includes('Gov. E-Invoice Attached')) || false;

                if (fullyPaid) {
                    if (isLateStage && fullyDelivered) {
                        if (hasGovEInvoice) {
                            order.status = OrderStatus.FULFILLED; setGovWaitLines(order, false);
                            order.logs.push(createAuditLog(`Full payment reconciled${order.appliesWithholdingTax ? ' (with 1% WHT deducted)' : ''}, Delivery complete & Gov. E-Invoice issued. Order lifecycle FULFILLED.`, order.status, user));
                        } else {
                            order.status = OrderStatus.WAITING_GOVE; setGovWaitLines(order, true);
                            order.logs.push(createAuditLog(`Full payment reconciled & Delivery complete. Awaiting Gov. E-Invoice to FULFILL.`, order.status, user));
                        }
                    } else if (isLateStage && !fullyDelivered) {
                        order.logs.push(createAuditLog(`Full payment reconciled. Awaiting final delivery completion to FULFILL.`, order.status, user));
                    } else {
                        order.logs.push(createAuditLog(`Full payment received (Pre-payment)${order.appliesWithholdingTax ? ' (with 1% WHT deducted)' : ''}. Operational status '${order.status}' retained.`, order.status, user));
                    }
                } else {
                    let revenue = 0;
                    order.items.forEach(it => revenue += (getItemEffectiveQty(it) * it.pricePerUnit * (1 + (it.taxPercent / 100))));
                    let targetRevenue = revenue - (order.appliesWithholdingTax ? orderWhtAmount(order) : 0);
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

                // R23 (C12): consume the components in proportion to what was manufactured (only what production uses)
                if (mItem.productionType === 'MANUFACTURING') {
                    const effQ = getItemEffectiveQty(mItem) || targetQty || 0;
                    (mItem.components || []).forEach(comp => {
                        if (!comp.inventoryItemId || comp.source === 'CONSUMED' || !db.inventory || comp.manualConsumption) return; // CX07: what the factory consumed by hand is final; no proportional top-up
                        const invItem = db.inventory.find(inv => inv.id === comp.inventoryItemId);
                        if (!invItem) return;
                        const wanted = Math.min(comp.quantity || 0, Number(((comp.quantity || 0) * Math.min(1, mItem.manufacturedQty / (effQ || 1))).toFixed(3)));
                        const delta = Number((wanted - (comp.consumedQty || 0)).toFixed(3));
                        if (delta > 0) {
                            const cur = invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0);
                            invItem.quantityInStock = Math.max(0, cur - delta);
                            if (invItem.quantity !== undefined) delete invItem.quantity;
                            comp.consumedQty = (comp.consumedQty || 0) + delta;
                            if (comp.consumedQty >= (comp.quantity || 0) - 0.0005) comp.source = 'CONSUMED';
                        }
                    });
                }

                // Component Release Logic: If fully manufactured and user confirmed release
                // R22 (C02): outsourced lines consume nothing from the factory, so there is nothing to release (it zeroed cost, COGS and profit).
                if (mItem.manufacturedQty >= targetQty && payload.confirmRelease && mItem.productionType !== 'OUTSOURCING') {
                    (mItem.components || []).forEach(comp => {
                        const allocated = comp.quantity || 0;
                        const consumed = comp.consumedQty || 0;
                        const remaining = Math.max(0, allocated - consumed);

                        if (remaining > 0) {
                            // R23 (C12): the unused part was never consumed, so it is still in stock; releasing it only drops
                            // the reservation (reconcileInventory does that when comp.quantity is reduced to the consumed part).
                            let releasedHere = false;
                            if ((comp.source === 'STOCK' && comp.inventoryItemId) ||
                                (comp.source === 'PROCUREMENT' && (comp.status === 'RESERVED' || ['RECEIVED', 'STOCKED'].includes(comp.status)))) {
                                releasedHere = true;
                            }
                            
                            // R21 (C02): adjust quantity only for components really released back to stock.
                            // Outsourced/other components have no consumption basis; zeroing them lost quantity, cost, COGS and profit.
                            if (releasedHere) {
                                // R31 (2026-10-22): order cost is everything dedicated to the order, consumed or reserved in stock for the same PO
                                if (!comp.costBasisQty) comp.costBasisQty = allocated;
                                comp.quantity = consumed;
                                order.logs.push(createAuditLog(`[Factory] Released ${remaining.toFixed(2)} units of ${comp.description} back to stock.`, order.status, user));
                            }
                        }
                    });
                }

                // Auto-transition if all items are fully manufactured
                if (order.items.every(i => (i.manufacturedQty || 0) >= getItemEffectiveQty(i))) {
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
                cfcComp.manualConsumption = true;
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
                if (order.items.every(i => (i.hubReceivedQty || 0) >= getItemEffectiveQty(i))) {
                    order.status = OrderStatus.IN_PRODUCT_HUB;
                    order.logs.push(createAuditLog(`All items received at Hub. Auto-transitioned to Ready for Invoicing`, order.status, user));
                }
                break;

            case 'issue-invoice':
                // CX16: an invoice is issued once; a repeat is refused and not logged.
                if (order.invoiceNumber) throw new Error(`Refused: already invoiced (${order.invoiceNumber})`);
                order.status = OrderStatus.INVOICED;
                if (!order.invoiceNumber) {
                    const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, '');
                    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    order.invoiceNumber = `INV-${datePart}-${randomPart}`;
                }
                {
                    // R30 (23:00, OS09): the Gov E-Invoice is issued in L.E. after conversion at the order rate.
                    const fxI = orderFx(order); let netI = 0, vatI = 0;
                    (order.items || []).forEach(it => { const l = (getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0); netI += l; vatI += l * ((it.taxPercent || 0) / 100); });
                    order.invoiceCurrency = 'L.E.'; order.invoiceRate = fxI;
                    order.invoiceNetLE = Math.round(netI * fxI * 100) / 100; order.invoiceVatLE = Math.round(vatI * fxI * 100) / 100; order.invoiceGrossLE = Math.round((netI + vatI) * fxI * 100) / 100;
                }
                order.logs.push(createAuditLog(`Official Tax Invoice Generated: ${order.invoiceNumber}${orderFx(order) !== 1 ? ` (invoice in L.E. at rate ${orderFx(order)}: gross ${order.invoiceGrossLE})` : ''}`, order.status, user));
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
                    const hasBypass = Boolean(payload.bypass || (payload.items || []).some(x => x.bypass));
                    const bypassNote = hasBypass ? ' [Bypassed suggested downpayment limit]' : '';
                    order.logs.push(createAuditLog(`Delivery Authorization Receipt: ${approvalDetails.join(', ')}${bypassNote}${payload.notes ? ` - ${payload.notes}` : ''}`, order.status, user));
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
                const allDispatched = order.items.every(i => (i.dispatchedQty || 0) >= getItemEffectiveQty(i));
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
                        // TR11: goods delivered from warehouse stock leave the warehouse (on hand and reserved fall)
                        if (oItem.productionType === 'TRADING' && !isStockOrder(order)) {
                            let leftToTake = dItem.qty;
                            (oItem.components || []).forEach(sc => {
                                if ((sc.source !== 'STOCK' && !sc.viaWarehouse) || !sc.inventoryItemId || leftToTake <= 0) return;
                                const take = Math.min(leftToTake, (sc.quantity || 0) - (sc.consumedQty || 0));
                                if (take <= 0) return;
                                const invS = (db.inventory || []).find(x => x.id === sc.inventoryItemId);
                                if (invS) invS.quantityInStock = (invS.quantityInStock !== undefined ? invS.quantityInStock : (invS.quantity || 0)) - take;
                                sc.consumedQty = (sc.consumedQty || 0) + take;
                                leftToTake -= take;
                            });
                        }
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
                        // same rule as the payment path: FULFILLED needs the Gov. e-invoice, otherwise WAITING_GOVE
                        const hasGovEInv = Boolean(order.einvoiceFile) || (order.logs || []).some(log => log.message && log.message.includes('Gov. E-Invoice Attached'));
                        order.status = hasGovEInv ? OrderStatus.FULFILLED : OrderStatus.WAITING_GOVE; setGovWaitLines(order, !hasGovEInv);
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
                const sameEinv = order.einvoiceFile === payload.einvoiceFile;
                order.einvoiceFile = payload.einvoiceFile;

                const fullyDel = isOrderFullyDelivered(order);
                const fullyPaid_ = isOrderFullyPaid(order);
                // CX16: the same e-invoice reference attached again is stored once and not logged again.
                const einvLog = (msg) => { if (sameEinv && (order.logs || []).some(l => l.message === msg)) return; order.logs.push(createAuditLog(msg, order.status, user)); };
                if (fullyDel && fullyPaid_) {
                    order.status = OrderStatus.FULFILLED; setGovWaitLines(order, false);
                    einvLog(`Gov. E-Invoice Attached: ${payload.einvoiceFile}. All requirements met - Order FULFILLED.`);
                } else if (order.status === OrderStatus.WAITING_GOVE && fullyDel && fullyPaid_) {
                    // If order was waiting for Gov.E invoice and all conditions are now met
                    order.status = OrderStatus.FULFILLED; setGovWaitLines(order, false);
                    einvLog(`Gov. E-Invoice Attached: ${payload.einvoiceFile}. Order was waiting for Gov.E invoice - now FULFILLED.`);
                } else if (fullyDel && order.status === OrderStatus.DELIVERED) {
                    // Stay in DELIVERED until paid
                }

                if (order.status !== OrderStatus.FULFILLED) einvLog(`Gov. E-Invoice Attached: ${payload.einvoiceFile}${fullyDel && !fullyPaid_ ? ' (Awaiting full payment to FULFILL)' : ''}`);
                break;
            }

            case 'settle-blanket-order': {
                // R27: there is no automatic settlement or credit calculation. Settling a blanket order is the
                // human decision of a finance user and is done with 'close-blanket-order'.
                throw new Error("Blanket settlement is a finance decision: use the close action (the paid-minus-delivered difference goes to the customer general wallet)");
            }
            case 'close-blanket-order': {
                // Finance closes a blanket order that was delivered LESS than the blanket quantity, when the
                // customer's payments cover the delivered GROSS value (VAT included). Payments above the
                // delivered gross become customer credit (advance) for the project.
                if (!order.blanketOrder) throw new Error("Only blanket orders can be closed via this action");
                {
                    const uname = String(req.headers['x-user'] || req.user || '').trim().toLowerCase();
                    const liveU = uname ? (readDb(DB_PATH).users || []).find(u => String(u.username || '').toLowerCase() === uname) : null;
                    const uRoles = liveU ? (liveU.roles || []) : (Array.isArray(req.roles) ? req.roles : null);
                    if (uRoles && !uRoles.includes('finance') && !uRoles.includes('admin')) throw new Error("Only finance users can close a blanket order");
                }
                if (order.contractClosed) throw new Error("Blanket order is already closed");
                // R34 round 12 (validator 11, defect 2): the call-offs by the shared link rule, the same as every guard and the
                // realized-sale test (a call-off linked by the contract's customer reference, or with stray spaces, is settled too).
                const calls = callOffsOfBlanket(order, db.orders || []);
                let deliveredGross = 0;
                calls.forEach(o => (o.items || []).forEach(it => {
                    const r2c = x => Math.round((x + Number.EPSILON) * 100) / 100;
                    const lineNet = r2c((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
                    deliveredGross += lineNet + r2c(lineNet * (it.taxPercent || 0) / 100);
                }));
                deliveredGross = Math.round(deliveredGross * 100) / 100;
                const paidAll = [order, ...calls].reduce((t, o) => t + (o.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0), 0);
                const roundedPaid = Math.round(paidAll * 100) / 100;
                // R27: closing is a finance decision. Whether the customer paid more or less than the delivered gross value,
                // the difference (paid - delivered gross) is booked to the customer GENERAL wallet; the order keeps its history.
                const diff = Math.round((roundedPaid - deliveredGross) * 100) / 100;
                // R34 round 6 (validator 5, D2): the difference is in the ORDER currency; the wallet holds L.E. The L.E. credited is the L.E.
                // received (payments x their order rate, exact amountLE where entered in L.E.) minus the delivered gross x the call-off
                // rate: 200 USD paid, 114 USD called off at rate 50 -> 86 USD = 4,300.00 L.E. (not 86 L.E.).
                const paidAllLE = r2w([order, ...calls].reduce((t, o) => t + orderPaymentsLE(o), 0));
                let deliveredGrossLE = 0;
                calls.forEach(o => {
                    const fxC = orderFx(o);
                    (o.items || []).forEach(it => {
                        const r2c = x => Math.round((x + Number.EPSILON) * 100) / 100;
                        const lineNet = r2c((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
                        deliveredGrossLE += (lineNet + r2c(lineNet * (it.taxPercent || 0) / 100)) * fxC;
                    });
                });
                deliveredGrossLE = r2w(deliveredGrossLE);
                const diffLE = r2w(paidAllLE - deliveredGrossLE);
                const fxClose = orderFx(order);
                const cust = db.customers.find(c => c.name === order.customerName);
                // R30: a wallet is money paid. Overpayment (paid above the delivered gross) moves from the blanket order account
                // to the customer GENERAL wallet; an underpayment moves no money: the open amount stays in Accounts Receivable.
                if (diff > 0 && diffLE > 0.004 && cust) {
                    cust.walletBalances = cust.walletBalances || {};
                    cust.walletBalances[SELF_WALLET_KEY] = Math.round(((cust.walletBalances[SELF_WALLET_KEY] || 0) + diffLE) * 100) / 100;
                    cust.walletBalance = Math.round(((Number(cust.walletBalance) || 0) + diffLE) * 100) / 100;
                    order.surplusMovedToWallet = diff;
                    order.surplusMovedToWalletLE = diffLE;
                    ledgerPush(db, { type: 'TRANSFER', amount: diffLE, description: `Blanket close ${order.internalOrderNumber}: overpayment ${diff.toFixed(2)}${fxClose !== 1 ? ` ${order.currency} (${diffLE.toFixed(2)} L.E. at rate ${fxClose})` : ''} credited to the customer general wallet`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), toAccount: acctLabel(order.customerName, 'SELF', 'Self'), customerName: order.customerName, orderId: order.id }, user);
                }
                order.contractClosed = true;
                order.closedDeliveredGross = deliveredGross;
                order.status = OrderStatus.FULFILLED;
                order.logs.push(createAuditLog(`Blanket order closed by finance: delivered gross ${deliveredGross.toFixed(2)}, payments ${roundedPaid.toFixed(2)}${diff > 0 ? `, overpayment ${diff.toFixed(2)}${fxClose !== 1 ? ` ${order.currency} = ${diffLE.toFixed(2)} L.E.` : ''} moved to the customer general wallet` : diff < 0 ? `, underpayment ${(-diff).toFixed(2)} stays in Accounts Receivable` : ''}.`, order.status, user));
                break;
            }
            case 'financial-request': {
                // Financial Request for a blanket contract: logs the request on the
                // blanket order and (optionally) on the linked settling order so the
                // finance team has a full audit trail. Does not change order status.
                if (!order.blanketOrder) throw new Error("Rejected: financial requests work on blanket contracts only");
                const memo = (payload && payload.memo) ? String(payload.memo).trim() : '';
                const requestedAmount = (payload && payload.amount) ? Number(payload.amount) : null;
                const financeReqRef = `FINREQ-${order.internalOrderNumber || order.id}-${Date.now().toString().slice(-6)}`;
                const amountText = requestedAmount && Number.isFinite(requestedAmount)
                    ? ` for ${requestedAmount.toLocaleString()} ${order.currency || 'L.E.'}`
                    : '';
                const auditMessage = `Financial request: ${memo || 'no text'} (${financeReqRef} for blanket contract ${order.internalOrderNumber}${amountText}). Request is now visible in Finance Operations.`;

                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(auditMessage, order.status, user));

                // Also annotate any linked settling orders so finance sees the request thread
                if (payload && payload.settlingOrderId) {
                    const linkedIdx = db.orders.findIndex(o => o.id === payload.settlingOrderId);
                    if (linkedIdx !== -1) {
                        const linked = db.orders[linkedIdx];
                        if (!linked.logs) linked.logs = [];
                        linked.logs.push(createAuditLog(`Financial Request ${financeReqRef} logged against blanket contract ${order.internalOrderNumber}${amountText}${memo ? ` — ${memo}` : ''}`, linked.status, user));
                        db.orders[linkedIdx] = linked;
                    }
                }
                break;
            }
            case 'allocate-stock-component': {
                if (!payload || !payload.itemId) throw new Error("Target line item ID is required");
                if (!payload.stockOrderId) throw new Error("Stock order ID is required");
                if (!payload.stockCompId) throw new Error("Stock component ID is required");

                const targetItem = (order.items || []).find(i => i.id === payload.itemId);
                if (!targetItem) throw new Error("Target item not found in order");

                const stockOrderIdx = db.orders.findIndex(o => o.id === payload.stockOrderId);
                if (stockOrderIdx === -1) throw new Error("Stock order not found");
                let stockOrder = db.orders[stockOrderIdx];
                const oldStockOrder = JSON.parse(JSON.stringify(stockOrder));

                // Locate component in stock order
                let foundStockItem = null;
                let stockComp = null;
                for (const item of (stockOrder.items || [])) {
                    const match = (item.components || []).find(c => c.id === payload.stockCompId);
                    if (match) {
                        foundStockItem = item;
                        stockComp = match;
                        break;
                    }
                }

                // Fallback by description or SKU if not found by exact ID
                if (!stockComp) {
                    for (const item of (stockOrder.items || [])) {
                        const match = (item.components || []).find(c => 
                            c.description === payload.description || 
                            (payload.partNumber && (c.supplierPartNumber === payload.partNumber || c.componentNumber === payload.partNumber))
                        );
                        if (match) {
                            foundStockItem = item;
                            stockComp = match;
                            break;
                        }
                    }
                }

                if (!stockComp || !foundStockItem) throw new Error("Component not found in stock order");

                const stockQty = Number(stockComp.quantity) || 0;
                const requestedQty = Number(payload.allocateQty) || 0;
                if (requestedQty <= 0) throw new Error("Allocation quantity must be greater than zero");

                // R21 (C16): stock that is on hand, in transit (ordered, not yet received) or ordered as stock may be allocated.
                // The part of the request above what the stock order holds is no longer dropped silently: it becomes a procurement remainder.
                if (stockQty <= 0) throw new Error("Nothing left to allocate in this stock order component");
                const allocateQty = Math.min(requestedQty, stockQty);
                const stockStatusBefore = stockComp.status; // C16: classify the source before a drain turns it DEPLETED
                const remainingStockQty = Number((stockQty - allocateQty).toFixed(3));

                // 1. Update source stock order
                if (foundStockItem.originalQuantity === undefined) {
                    foundStockItem.originalQuantity = foundStockItem.quantity;
                }
                if (stockComp.originalQuantity === undefined) {
                    stockComp.originalQuantity = stockQty;
                }

                stockComp.allocatedQty = (stockComp.allocatedQty || 0) + allocateQty;
                foundStockItem.allocatedQty = (foundStockItem.allocatedQty || 0) + allocateQty;

                foundStockItem.quantity = Math.max(0, Number(((foundStockItem.quantity || 0) - allocateQty).toFixed(3)));
                stockComp.quantity = remainingStockQty;
                stockComp.statusUpdatedAt = new Date().toISOString();

                if (remainingStockQty <= 0.0001) {
                    stockComp.quantity = 0;
                    stockComp.status = 'DEPLETED';
                }

                if (!stockOrder.logs) stockOrder.logs = [];
                stockOrder.logs.push(createAuditLog(
                    `Allocated ${allocateQty} ${stockComp.unit || 'pcs'} of "${stockComp.description}" to Order ${order.internalOrderNumber || order.customerReferenceNumber || order.id}. Remaining in Stock Order: ${remainingStockQty}`,
                    stockOrder.status,
                    user
                ));

                stockOrder.statusUpdatedAt = new Date().toISOString();
                stockOrder = processedOrderInternal(stockOrder, db, user, false, oldStockOrder, false);
                reconcileInventory(oldStockOrder, stockOrder, db);
                db.orders[stockOrderIdx] = stockOrder;

                // 2. Prepare component on target order item
                if (!targetItem.components) targetItem.components = [];

                // If targetItem is TRADING and has only the initial empty mirror component, replace it
                if (targetItem.productionType === 'TRADING' && targetItem.components.length === 1) {
                    const firstComp = targetItem.components[0];
                    if (!firstComp.allocatedFromStockOrderId && (!firstComp.unitCost || firstComp.unitCost === 0) && !firstComp.poNumber && !firstComp.rfpId && !firstComp.awardId) {
                        targetItem.components = [];
                    }
                }

                const isStockSource = stockComp.source === 'STOCK' || stockStatusBefore === 'RECEIVED' || stockStatusBefore === 'STOCKED' || stockStatusBefore === 'IN_STOCK';
                const newCompId = `c_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                const newComp = {
                    id: newCompId,
                    description: stockComp.description,
                    quantity: allocateQty,
                    unit: stockComp.unit || 'pcs',
                    unitCost: Number(stockComp.unitCost) || 0,
                    taxPercent: stockComp.taxPercent !== undefined ? stockComp.taxPercent : 14,
                    source: isStockSource ? 'STOCK' : (stockComp.source || 'PROCUREMENT'),
                    status: isStockSource ? 'RESERVED' : (stockStatusBefore || 'PENDING_OFFER'),
                    supplierId: stockComp.supplierId,
                    supplierName: stockComp.supplierName,
                    supplierPartNumber: stockComp.supplierPartNumber,
                    componentNumber: stockComp.componentNumber || `CMP-${order.internalOrderNumber || 'ORD'}-${Date.now().toString().slice(-4)}`,
                    poNumber: stockComp.poNumber,
                    sendPoId: stockComp.sendPoId,
                    rfpId: stockComp.rfpId,
                    awardId: stockComp.awardId,
                    inventoryItemId: stockComp.inventoryItemId,
                    procurementStartedAt: stockComp.procurementStartedAt || new Date().toISOString(),
                    statusUpdatedAt: new Date().toISOString(),
                    contractNumber: payload.contractNumber || stockComp.contractNumber,
                    contractDuration: payload.contractDuration || stockComp.contractDuration,
                    scopeOfWork: payload.scopeOfWork || stockComp.scopeOfWork,
                    allocatedFromStockOrderId: stockOrder.id,
                    allocatedFromStockOrderRef: stockOrder.customerReferenceNumber || stockOrder.internalOrderNumber || stockOrder.id,
                    allocatedFromStockCompId: stockComp.id,
                    allocatedFromStockItemId: foundStockItem.id
                };
                targetItem.components.push(newComp);

                // 3. If remainder requested beyond available stock, add remainder procurement component
                const remainderQty = payload.remainderQty !== undefined && payload.remainderQty !== null
                    ? (Number(payload.remainderQty) || 0)
                    : Math.max(0, Number((requestedQty - allocateQty).toFixed(3)));
                if (remainderQty > 0) {
                    const remainderComp = {
                        id: `c_${Date.now() + 1}_${Math.random().toString(36).substr(2, 5)}`,
                        description: stockComp.description,
                        quantity: remainderQty,
                        unit: stockComp.unit || 'pcs',
                        unitCost: Number(stockComp.unitCost) || 0,
                        taxPercent: stockComp.taxPercent !== undefined ? stockComp.taxPercent : 14,
                        source: 'PROCUREMENT',
                        status: 'PENDING_OFFER',
                        supplierId: stockComp.supplierId,
                        supplierName: stockComp.supplierName,
                        supplierPartNumber: stockComp.supplierPartNumber,
                        componentNumber: stockComp.componentNumber || `CMP-${order.internalOrderNumber || 'ORD'}-${Date.now().toString().slice(-4)}`,
                        procurementStartedAt: new Date().toISOString(),
                        statusUpdatedAt: new Date().toISOString(),
                        contractNumber: payload.contractNumber,
                        contractDuration: payload.contractDuration,
                        scopeOfWork: payload.scopeOfWork
                    };
                    targetItem.components.push(remainderComp);
                }

                if (order.status === OrderStatus.LOGGED) {
                    order.status = OrderStatus.TECHNICAL_REVIEW;
                }

                if (!order.logs) order.logs = [];
                order.logs.push(createAuditLog(
                    `Allocated ${allocateQty} ${newComp.unit} of "${newComp.description}" from Stock Order ${stockOrder.customerReferenceNumber || stockOrder.internalOrderNumber} (Status: ${newComp.status}, PO: ${newComp.poNumber || 'N/A'})${remainderQty > 0 ? ` + ${remainderQty} ${newComp.unit} requested via procurement` : ''}`,
                    order.status,
                    user
                ));
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
        if (writeDb(db, getDbPath(req))) {
            res.json(order);
        } else {
            res.status(500).json({ error: "Failed to save data" });
        }
    } catch (e) {
        res.status(e.httpStatus || 400).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    }
});

app.get('/api/v1/backup', (req, res) => {
    const db = getDb(req);
    // CX10: a backup must always restore; add the collections the restore requires when the database has none yet.
    for (const col of ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'settings', 'modules']) {
        if (!db[col]) db[col] = [];
    }
    if (!isSandbox(req)) {
        // In Live ERP: Bundle all sandboxes so JSON export captures them
        const sandboxes = {};
        try {
            const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp'));
            for (const file of files) {
                const owner = file.replace('db.sandbox.', '').replace('.json', '');
                try {
                    sandboxes[owner] = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
                } catch {}
            }
        } catch (e) {
            console.error("[Backup] Error bundling sandboxes:", e);
        }
        res.json({ ...db, _sandboxes: sandboxes });
    } else {
        res.json(db);
    }
});

app.get('/api/v1/full-backup', (req, res) => {
    try {
        const password = req.query.password;
        if (!password) {
            return res.status(400).json({ error: "Password is required for secure system export." });
        }

        const date = new Date().toISOString().slice(0, 10);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename=nexus-full-archive-${date}.nxarchive`);

        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

        // Format v2 (Streaming): [16 bytes salt] [12 bytes IV] [Encrypted Payload] [16 bytes AuthTag]
        // We write salt and iv immediately
        res.write(salt);
        res.write(iv);

        const archive = new archiver.ZipArchive({ zlib: { level: 9 } });
        archive.on('error', err => { 
            console.error("Archive error:", err);
            if (!res.headersSent) res.status(500).end();
        });

        // We handle cipher data manually to append authTag at the exact end
        cipher.on('data', chunk => res.write(chunk));
        cipher.on('end', () => {
            const authTag = cipher.getAuthTag();
            res.end(authTag);
        });

        archive.pipe(cipher);

        if (isSandbox(req)) {
            const sandboxDb = getDb(req);
            archive.append(JSON.stringify(sandboxDb, null, 2), { name: "db.json" });
            if (fs.existsSync(UPLOADS_BASE)) {
                archive.directory(UPLOADS_BASE, 'uploads');
            }
        } else {
            const liveDb = readDb(DB_PATH);
            archive.append(JSON.stringify(liveDb, null, 2), { name: "db.json" });

            try {
                const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp'));
                for (const file of files) {
                    archive.file(path.join(__dirname, file), { name: file });
                }
            } catch (e) {
                console.error("[Full Backup] Error bundling sandboxes:", e);
            }

            if (fs.existsSync(UPLOADS_BASE)) {
                archive.directory(UPLOADS_BASE, 'uploads');
            }
        }

        archive.finalize();
    } catch (err) {
        console.error("Full secure backup failed:", err);
        if (!res.headersSent) res.status(500).json({ error: "Full secure backup failed" });
    }
});

app.post('/api/v1/restore', async (req, res) => {
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

    const { _sandboxes, sandboxes, ...cleanDb } = data;

    // Preserve active Dropbox and Turso configuration so restoring older backups never wipes them out
    try {
        const existingDb = readDb(getDbPath(req));
        const existingSettings = resolveSettings(existingDb);
        if (!cleanDb.settings || !Array.isArray(cleanDb.settings) || cleanDb.settings.length === 0) {
            cleanDb.settings = [existingDb.settings?.[0] || resolveSettings(existingDb)];
        } else {
            const restoredSettings = cleanDb.settings[0];
            const restoredDbx = restoredSettings.dropboxConfig || {};
            if (!restoredDbx.refreshToken || !restoredDbx.appKey) {
                restoredSettings.dropboxConfig = {
                    ...existingSettings.dropboxConfig,
                    ...(restoredDbx.enabled !== undefined ? { enabled: restoredDbx.enabled } : {})
                };
            }
            if (existingSettings.tursoUrl && (!restoredSettings.tursoUrl || !restoredSettings.tursoAuthToken)) {
                restoredSettings.useTurso = existingSettings.useTurso;
                restoredSettings.tursoUrl = existingSettings.tursoUrl;
                restoredSettings.tursoAuthToken = existingSettings.tursoAuthToken;
            }
        }
    } catch (preserveErr) {
        console.warn('[Restore] Cloud settings preservation note:', preserveErr.message);
    }

    // If restoring into a sandbox, merge existing sandbox users + owner + admins into the restored data
    // This ensures nobody loses access after a restore (e.g. restoring live data into user's sandbox)
    if (isSandbox(req)) {
        const liveDb = readDb(DB_PATH);
        const ownerName = req.sandboxOwner;
        const existingSandboxDb = readDb(getDbPath(req));
        const existingUsers = existingSandboxDb.users || [];

        cleanDb.users = cleanDb.users || [];

        // Merge all existing sandbox users (they had access before the restore — keep them)
        for (const existingUser of existingUsers) {
            if (!cleanDb.users.some(u => u.username.toLowerCase() === existingUser.username.toLowerCase())) {
                cleanDb.users.push(existingUser);
            }
        }

        // Ensure sandbox owner is present
        const liveOwner = (liveDb.users || []).find(u => sanitizeUsername(u.username) === ownerName);
        if (liveOwner && !cleanDb.users.some(u => sanitizeUsername(u.username) === ownerName)) {
            cleanDb.users.push(liveOwner);
        }

        // Ensure all live admins are present
        const liveAdmins = (liveDb.users || []).filter(u => (u.roles || []).includes('admin'));
        for (const admin of liveAdmins) {
            if (!cleanDb.users.some(u => u.username.toLowerCase() === admin.username.toLowerCase())) {
                cleanDb.users.push(admin);
            }
        }
    }

    // Migrate schema after restore so old backups work on new code versions
    applySchemaMigrations(cleanDb, getDbPath(req));

    // Live restore is an explicit admin action: forced past the shrink guard and read-only mode
    // (the previous Turso copy is kept as a live.<timestamp> snapshot).
    if (writeDb(cleanDb, getDbPath(req), { force: !isSandbox(req) })) {
        // If restoring in Live and sandboxes are in the JSON payload, restore each sandbox too
        if (!isSandbox(req) && (_sandboxes || sandboxes)) {
            const sMap = _sandboxes || sandboxes;
            for (const [owner, sDb] of Object.entries(sMap)) {
                try {
                    const targetPath = getSandboxDbPath(owner);
                    applySchemaMigrations(sDb, targetPath);
                    writeDb(sDb, targetPath);
                } catch (e) {
                    console.error(`[Restore] Error restoring sandbox for ${owner}:`, e);
                }
            }
        }
        console.log(`[System] Database restored manually at ${new Date().toISOString()}`);
        if (!isSandbox(req)) {
            const push = await awaitPush(DB_PATH);
            settleForcedLivePush(push, 'restore');
            return res.json({ message: "Restored", push, readOnly: persistState.readOnly });
        }
        res.json({ message: "Restored" });
    } else {
        res.status(500).json({ error: "Restore failed during file write" });
    }
});

const restoreDiskUpload = multer({ dest: os.tmpdir() });
app.post('/api/v1/full-restore', restoreDiskUpload.single('archive'), async (req, res) => {
  const tempDir = path.join(os.tmpdir(), `nexus-restore-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  let livePush = null;
  let restoredUploadsDropbox = null; // v1.0001201 strict: Dropbox result for the restored uploads
  try {
    if (!req.file) return res.status(400).json({ error: "No archive file uploaded" });

    const password = req.body.password;
    if (!password) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "Password is required to restore secure archive." });
    }

    const fileSize = req.file.size;
    if (fileSize < 44) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: "Invalid archive format." });
    }

    const fd = fs.openSync(req.file.path, 'r');
    const salt = Buffer.alloc(16);
    const iv = Buffer.alloc(12);
    const authTag = Buffer.alloc(16);
    
    fs.readSync(fd, salt, 0, 16, 0);
    fs.readSync(fd, iv, 0, 12, 16);
    fs.readSync(fd, authTag, 0, 16, fileSize - 16);

    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const readStream = fs.createReadStream(req.file.path, { fd, start: 28, end: fileSize - 17, autoClose: true });
    
    try {
      await new Promise((resolve, reject) => {
        readStream.pipe(decipher)
          .on('error', err => reject(new Error("Decryption failed. Incorrect password or corrupted archive.")))
          .pipe(unzipper.Extract({ path: tempDir }))
          .on('close', resolve)
          .on('error', err => reject(new Error("Archive extraction failed: " + err.message)));
      });
    } catch (err) {
      console.error("Restore stream extraction failed:", err);
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(401).json({ error: err.message });
    }
    
    try { fs.unlinkSync(req.file.path); } catch {}

    if (isSandbox(req)) {
      // Restoring inside a single sandbox
      const extractedDb = path.join(tempDir, 'db.json');
      if (fs.existsSync(extractedDb)) {
        const db = JSON.parse(fs.readFileSync(extractedDb, 'utf8'));
        const liveDb = readDb(DB_PATH);
        const ownerName = req.sandboxOwner;
        const existingSandboxDb = readDb(getDbPath(req));
        const existingUsers = existingSandboxDb.users || [];

        db.users = db.users || [];

        // Merge all existing sandbox users (they had access before — keep them)
        for (const existingUser of existingUsers) {
            if (!db.users.some(u => u.username.toLowerCase() === existingUser.username.toLowerCase())) {
                db.users.push(existingUser);
            }
        }

        // Ensure sandbox owner is present
        const liveOwner = (liveDb.users || []).find(u => sanitizeUsername(u.username) === ownerName);
        if (liveOwner && !db.users.some(u => sanitizeUsername(u.username) === ownerName)) {
            db.users.push(liveOwner);
        }

        // Ensure all live admins are present
        const liveAdmins = (liveDb.users || []).filter(u => (u.roles || []).includes('admin'));
        for (const admin of liveAdmins) {
            if (!db.users.some(u => u.username.toLowerCase() === admin.username.toLowerCase())) {
                db.users.push(admin);
            }
        }

        applySchemaMigrations(db, getDbPath(req));
        if (!db.contracts) db.contracts = [];
        writeDb(db, getDbPath(req));
      }
      const extractedUploads = path.join(tempDir, 'uploads');
      if (fs.existsSync(extractedUploads)) {
        if (!fs.existsSync(UPLOADS_BASE)) fs.mkdirSync(UPLOADS_BASE, { recursive: true });
        const specificSandbox = path.join(extractedUploads, 'sandbox', sanitizeUsername(req.sandboxOwner));
        const targetUploads = getSandboxUploadsPath(req.sandboxOwner);
        if (fs.existsSync(specificSandbox)) {
          if (!fs.existsSync(targetUploads)) fs.mkdirSync(targetUploads, { recursive: true });
          fs.cpSync(specificSandbox, targetUploads, { recursive: true });
          syncLocalDirectoryToDropbox(targetUploads, req).catch((err) => console.error('[Dropbox Sync Sandbox Restore Error]', err.message));
        }
        saveSandboxLoginSnapshot(req.sandboxOwner);
      }
    } else {
      // LIVE RESTORE: Restore live db.json AND all db.sandbox.*.json files AND all uploads
      const extractedDb = path.join(tempDir, 'db.json');
      let liveRestored = false;
      if (fs.existsSync(extractedDb)) {
        const db = JSON.parse(fs.readFileSync(extractedDb, 'utf8'));
        try {
            const existingDb = readDb(DB_PATH);
            const existingSettings = resolveSettings(existingDb);
            if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
                db.settings = [existingDb.settings?.[0] || resolveSettings(existingDb)];
            } else {
                const restoredSettings = db.settings[0];
                const restoredDbx = restoredSettings.dropboxConfig || {};
                if (!restoredDbx.refreshToken || !restoredDbx.appKey) {
                    restoredSettings.dropboxConfig = {
                        ...existingSettings.dropboxConfig,
                        ...(restoredDbx.enabled !== undefined ? { enabled: restoredDbx.enabled } : {})
                    };
                }
                if (existingSettings.tursoUrl && (!restoredSettings.tursoUrl || !restoredSettings.tursoAuthToken)) {
                    restoredSettings.useTurso = existingSettings.useTurso;
                    restoredSettings.tursoUrl = existingSettings.tursoUrl;
                    restoredSettings.tursoAuthToken = existingSettings.tursoAuthToken;
                }
            }
        } catch (pe) {}
        applySchemaMigrations(db, DB_PATH);
        if (!db.contracts) db.contracts = [];
        liveRestored = writeDb(db, DB_PATH, { force: true });
      }

      // Restore all extracted sandbox files
      const extractedFiles = fs.readdirSync(tempDir);
      for (const file of extractedFiles) {
        if (file.startsWith('db.sandbox.') && file.endsWith('.json') && !file.endsWith('.local.bak') && !file.endsWith('.tmp')) {
          try {
            const sandboxDb = JSON.parse(fs.readFileSync(path.join(tempDir, file), 'utf8'));
            const targetSandboxPath = path.join(__dirname, file);
            applySchemaMigrations(sandboxDb, targetSandboxPath);
            writeDb(sandboxDb, targetSandboxPath);
          } catch (sbErr) {
            console.error(`[Full Restore] Failed to restore sandbox file ${file}:`, sbErr);
          }
        }
      }

      // Restore uploads (live uploads and all uploads/sandbox/<owner>/...)
      const extractedUploads = path.join(tempDir, 'uploads');
      if (fs.existsSync(extractedUploads)) {
        if (!fs.existsSync(UPLOADS_BASE)) fs.mkdirSync(UPLOADS_BASE, { recursive: true });
        fs.cpSync(extractedUploads, UPLOADS_BASE, { recursive: true });

        if (STRICT_REMOTE.on) {
          // Strict: the restored files count only once they are in Dropbox; wait and report.
          restoredUploadsDropbox = await syncLocalDirectoryToDropbox(UPLOADS_BASE, req).catch((err) => ({ count: 0, errors: -1, error: dropboxErrText(err) }));
          await checkDropboxRemote('full-restore').catch(() => {});
          restoredUploadsDropbox = { ...restoredUploadsDropbox, localOnlyFiles: dropboxState.localOnlyFiles };
        } else {
        // Auto-sync restored files from permanent UPLOADS_BASE to Dropbox in background if configured
        syncLocalDirectoryToDropbox(UPLOADS_BASE, req).catch((err) => console.error('[Dropbox Sync Restore Error]', err.message));
        }
      }
      if (liveRestored) {
        livePush = await awaitPush(DB_PATH);
        settleForcedLivePush(livePush, 'full-restore');
      }
    }

    res.json({ message: "Full system restore successful", isSandbox: isSandbox(req), ...(livePush ? { push: livePush, readOnly: persistState.readOnly } : {}), ...(restoredUploadsDropbox ? { dropbox: restoredUploadsDropbox } : {}) });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

app.get('/api/v1/backup-users-groups', (req, res) => {
    try {
        const password = req.query.password;
        if (!password) {
            return res.status(400).json({ error: "Password is required for secure users/groups export." });
        }

        const db = getDb(req);
        const dbSettings = (db.settings && Array.isArray(db.settings) && db.settings.length > 0)
            ? db.settings[0]
            : (db.settings || {});
        const payload = {
            users: db.users || [],
            userGroups: db.userGroups || [],
            helpLinks: dbSettings.helpLinks || [],
            helpVideos: dbSettings.helpVideos || []
        };

        // If in Live ERP, also include users and userGroups for all sandboxes
        if (!isSandbox(req)) {
            payload.sandboxes = {};
            try {
                const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp'));
                for (const file of files) {
                    const owner = file.replace('db.sandbox.', '').replace('.json', '');
                    try {
                        const sDb = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
                        payload.sandboxes[owner] = {
                            users: sDb.users || [],
                            userGroups: sDb.userGroups || []
                        };
                    } catch {}
                }
            } catch (e) {
                console.error("[Backup Users/Groups] Error reading sandboxes:", e);
            }
        }

        const jsonStr = JSON.stringify(payload);

        const salt = crypto.randomBytes(16);
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

        const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();

        const finalBuffer = Buffer.concat([salt, iv, authTag, encrypted]);

        const date = new Date().toISOString().slice(0, 10);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename=nexus-users-groups-${date}.nxusers`);
        res.send(finalBuffer);
    } catch (err) {
        console.error("Users/groups backup failed:", err);
        res.status(500).json({ error: "Users/groups backup failed" });
    }
});

app.post('/api/v1/restore-users-groups', restoreDiskUpload.single('archive'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No archive file uploaded" });

        const password = req.body.password;
        if (!password) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(400).json({ error: "Password is required to restore users/groups archive." });
        }

        const fileBuffer = fs.readFileSync(req.file.path);
        try { fs.unlinkSync(req.file.path); } catch {}

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

        const data = JSON.parse(rawBuffer.toString('utf8'));
        if (!data.users || !Array.isArray(data.users) || !data.userGroups || !Array.isArray(data.userGroups)) {
            return res.status(400).json({ error: "Invalid archive: missing users or userGroups arrays" });
        }

        const db = getDb(req);
        db.users = data.users;
        db.userGroups = data.userGroups;

        // Restore help content if present in archive
        if (db.settings && Array.isArray(db.settings) && db.settings.length > 0) {
            const settings = db.settings[0];
            if (data.helpLinks !== undefined) {
                settings.helpLinks = data.helpLinks;
            }
            if (data.helpVideos !== undefined) {
                settings.helpVideos = data.helpVideos;
            }
            db.settings[0] = encryptSettings(settings);
        }

        if (writeDb(db, getDbPath(req))) {
            // If in Live ERP and sandbox identities are present in archive, restore into each sandbox
            if (!isSandbox(req) && data.sandboxes) {
                for (const [owner, sData] of Object.entries(data.sandboxes)) {
                    try {
                        const targetPath = getSandboxDbPath(owner);
                        if (fs.existsSync(targetPath)) {
                            const sDb = readDb(targetPath);
                            if (sData.users) sDb.users = sData.users;
                            if (sData.userGroups) sDb.userGroups = sData.userGroups;
                            writeDb(sDb, targetPath);
                        }
                    } catch (e) {
                        console.error(`[Restore Users/Groups] Failed for sandbox ${owner}:`, e);
                    }
                }
            }

            console.log(`[System] Users, groups, and help content restored at ${new Date().toISOString()}`);
            res.json({ message: "Users, groups, and help content restored successfully" });
        } else {
            res.status(500).json({ error: "Restore failed during file write" });
        }
    } catch (err) {
        console.error("Users/groups restore failed:", err);
        res.status(500).json({ error: "Users/groups restore failed: " + err.message });
    }
});

app.post('/api/v1/relay/dispatch', async (req, res) => {
  const { Host, Port, Username, Password, To, From, Subject, Body } = req.body;
  const result = await sendEmail(To, Subject, Body, {
    smtpServer: Host, smtpPort: Port, username: Username, password: Password,
    senderName: 'Nexus Relay', senderEmail: From || Username, useSsl: Port === 465
  }, req);
  if (result.success) res.json({ message: "Sent" });
  else res.status(500).json({ error: result.error });
});

app.get('/api/v1/auth/environments', (req, res) => {
  const queryUser = String(req.query.username || '').trim().toLowerCase();
  const headerUser = String(req.headers['x-user'] || '').trim().toLowerCase();
  const username = queryUser || headerUser;

  if (!username) {
    return res.json({
      environments: [
        { id: 'live', label: 'Live ERP (Production)', type: 'live' },
        { id: 'self', label: 'Personal Sandbox (Isolated Testing)', type: 'personal' }
      ]
    });
  }

  const cached = discoveryCache.get(username);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json(cached.data);
  }

  const liveDb = readDb(DB_PATH);
  const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === username);

  if (!liveUser) {
    return res.json({
      environments: [
        { id: 'live', label: 'Live ERP (Production)', type: 'live' },
        { id: 'self', label: 'Personal Sandbox (Isolated Testing)', type: 'personal' }
      ]
    });
  }

  const sanitized = sanitizeUsername(username);
  const environments = [
    { id: 'live', label: 'Live ERP (Production)', type: 'live' },
    { id: sanitized, label: `My Own Sandbox (${liveUser.name || username})`, type: 'personal' }
  ];

  try {
    const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json')).slice(0, 50);
    for (const file of files) {
      const owner = file.replace('db.sandbox.', '').replace('.json', '');
      if (owner === sanitized) continue;

      try {
        const fileContent = fs.readFileSync(path.join(__dirname, file), 'utf8');
        if (!fileContent || fileContent.trim() === '') continue;
        const db = JSON.parse(fileContent);
        
        const isAdmin = (liveUser.roles || []).includes('admin');
        const hasAccess = (db.users || []).some(u => u.username.toLowerCase() === username && (isAdmin || u.sandboxAccess));
        
        if (hasAccess) {
          const ownerUser = (db.users || []).find(u => u.username.toLowerCase() === owner);
          environments.push({
            id: owner,
            label: `${ownerUser?.name || owner}'s Team Sandbox`,
            type: 'shared',
            owner: owner
          });
        }
      } catch {}
    }
  } catch {}

  const responseData = { environments };
  discoveryCache.set(username, { data: responseData, expiresAt: Date.now() + 30000 });
  res.json(responseData);
});

// Admin-only: List all created sandboxes on disk (accessible from inside the admin sandbox)
app.get('/api/v1/admin/sandboxes', (req, res) => {
  const username = req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const liveDb = readDb(DB_PATH);
  const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
  const isAdmin = liveUser && (liveUser.roles || []).includes('admin');
  if (!isAdmin) {
    return res.status(403).json({ error: "Access restricted to administrators." });
  }

  const currentSandboxOwner = req.headers['x-sandbox-owner'] ? sanitizeUsername(req.headers['x-sandbox-owner']) : sanitizeUsername(username);
  const sandboxes = [];

  try {
    const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak') && !f.endsWith('.tmp'));
    for (const file of files) {
      const owner = file.replace('db.sandbox.', '').replace('.json', '');
      try {
        const fileContent = fs.readFileSync(path.join(__dirname, file), 'utf8');
        if (!fileContent || fileContent.trim() === '') {
            throw new Error("File is empty");
        }
        const db = JSON.parse(fileContent);
        const ownerUser = (liveDb.users || []).find(u => sanitizeUsername(u.username) === owner) ||
                          (db.users || []).find(u => sanitizeUsername(u.username) === owner);
        const ownerName = ownerUser?.name || owner;
        const isSelf = owner === sanitizeUsername(username);
        const isCurrent = owner === currentSandboxOwner;

        sandboxes.push({
          owner,
          name: ownerName,
          label: isSelf ? `My Own Sandbox (${ownerName})` : `${ownerName}'s Sandbox (${owner})`,
          isSelf,
          isCurrent,
          ordersCount: (db.orders || []).length,
          usersCount: (db.users || []).length
        });
      } catch (err) {
        // If the file is corrupted or empty, don't silently hide it! Show it to the admin.
        sandboxes.push({
          owner,
          name: owner,
          label: `⚠️ CORRUPTED Sandbox (${owner})`,
          isSelf: owner === sanitizeUsername(username),
          isCurrent: owner === currentSandboxOwner,
          ordersCount: 0,
          usersCount: 0,
          isCorrupted: true
        });
      }
    }
  } catch (e) {
    console.error("Failed to list admin sandboxes:", e);
  }

  sandboxes.sort((a, b) => {
    if (a.isSelf) return -1;
    if (b.isSelf) return 1;
    return a.label.localeCompare(b.label);
  });

  res.json({ sandboxes });
});

// Admin-only: Switch active sandbox to another user's sandbox
app.post('/api/v1/admin/switch-sandbox', (req, res) => {
  const username = req.headers['x-user'];
  const { targetOwner } = req.body;
  if (!username || !targetOwner) return res.status(400).json({ error: "Missing username or targetOwner" });

  const liveDb = readDb(DB_PATH);
  const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
  const isAdmin = liveUser && (liveUser.roles || []).includes('admin');
  if (!isAdmin) {
    return res.status(403).json({ error: "Access restricted to administrators." });
  }

  const sanitizedTarget = sanitizeUsername(targetOwner);
  const targetPath = getSandboxDbPath(sanitizedTarget);

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `Sandbox for user "${targetOwner}" not found.` });
  }

  const targetDb = readDb(targetPath);
  let userEntry = (targetDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());

  // Auto-provision admin user into target sandbox if not present, or sync latest live roles
  if (!userEntry) {
    userEntry = {
      ...liveUser,
      roles: liveUser.roles || ['admin'],
      groupIds: liveUser.groupIds || []
    };
    targetDb.users = targetDb.users || [];
    targetDb.users.push(userEntry);
    writeDb(targetDb, targetPath);
  } else {
    userEntry.roles = liveUser.roles || [];
    userEntry.groupIds = liveUser.groupIds || [];
    userEntry.name = liveUser.name || userEntry.name;
    userEntry.email = liveUser.email || userEntry.email;
    userEntry.password = liveUser.password;
    writeDb(targetDb, targetPath);
  }

  const targetOwnerUser = (liveDb.users || []).find(u => sanitizeUsername(u.username) === sanitizedTarget) ||
                         (targetDb.users || []).find(u => sanitizeUsername(u.username) === sanitizedTarget);
  const targetName = targetOwnerUser?.name || sanitizedTarget;
  const isSelf = sanitizedTarget === sanitizeUsername(username);
  const label = isSelf ? `My Own Sandbox (${username})` : `${targetName}'s Sandbox (${sanitizedTarget})`;

  saveSandboxLoginSnapshot(sanitizedTarget);

  const { password: _, ...safeUser } = userEntry;
  return res.json({
    ...safeUser,
    roles: liveUser.roles || [],
    groupIds: liveUser.groupIds || [],
    sandbox: true,
    sandboxOwner: sanitizedTarget,
    sandboxLabel: label
  });
});

app.post('/api/v1/login', (req, res) => {
  const { password, environment, apiKey } = req.body;
  let username = String(req.body.username || '').trim();
  const targetEnv = environment || 'live';
  const liveDb = readDb(DB_PATH);

  // --- API KEY authentication (ERP Test Tool, alternative to username + password) ---
  // An admin-generated API key resolves to its owner user, then the normal
  // environment resolution below proceeds identically to a password login.
  let authedViaApiKey = false;
  let keyRec = null;
  if (apiKey && !password) {
    keyRec = findApiKeyBySecret(String(apiKey).trim(), { touch: true });
    if (!keyRec) return res.status(401).json({ error: "Invalid API key." });
    username = keyRec.username;
    authedViaApiKey = true;

    // If API token does not have live access granted (unset by default),
    // redirect targetEnv to 'self' sandbox even if it requested live data!
    if (keyRec.allowLive !== true && targetEnv === 'live') {
      targetEnv = 'self';
    }
  }

  const isFactory = username === 'factory' && (Date.now() - SERVER_START_TIME) < 300000 && password === FACTORY_PASS;
  if (isFactory) {
    if (targetEnv !== 'live') return res.status(403).json({ error: "Factory emergency bypass is only permitted on Live ERP." });
    const factoryUser = (liveDb.users || []).find(u => u.username === 'factory') || { id: 'factory', username: 'factory', name: 'Factory Admin', roles: ['admin'], email: 'factory@nexus.local' };
    const { password: _, ...safe } = factoryUser;
    return res.json(safe);
  }

  if (targetEnv === 'live') {
    const user = (liveDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
    if (!user || (!authedViaApiKey && user.password !== hashPassword(password))) return res.status(401).json({ error: "Invalid username or password" });
    // Per-user Live Access toggle (Settings → Users, admin only).
    // `liveAccess === false` explicitly disables live logins; sandbox
    // logins remain allowed via the self / shared branches below.
    if (user.liveAccess === false) return res.status(403).json({ error: "Live login is disabled for this account. Please use a sandbox environment or contact your administrator." });
    const { password: _, ...safe } = user;
    return res.json({ ...safe, authMethod: authedViaApiKey ? 'api-key' : 'password' });
  }

  if (targetEnv === 'self' || targetEnv.toLowerCase() === (username || '').toLowerCase()) {
    const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
    if (!liveUser || (!authedViaApiKey && liveUser.password !== hashPassword(password))) return res.status(401).json({ error: "Invalid username or password" });

    const sandboxPath = getSandboxDbPath(username);
    if (!fs.existsSync(sandboxPath)) {
      const stubPath = path.join(__dirname, 'db.stub.json');
      const stubDb = fs.existsSync(stubPath) ? JSON.parse(fs.readFileSync(stubPath, 'utf8')) : {};
      const liveAi = getLiveAiSettings();
      stubDb.settings = [{
        id: 'system_settings',
        aiProvider: liveAi.aiProvider,
        geminiConfig: liveAi.geminiConfig,
        openaiConfig: liveAi.openaiConfig,
        dbSchemaVersion: CURRENT_SCHEMA_VERSION
      }];
      stubDb.modules = []; stubDb.orders = []; stubDb.customers = []; stubDb.inventory = []; stubDb.notifications = []; stubDb.contracts = []; stubDb.supplierPayments = [];
      stubDb.userGroups = [
        { id: 'ug_sales', name: 'Sales Department', roles: ['sales'], permissions: { canViewFinancials: false, canApproveTechReview: false, canReleaseHub: false, canManageUsers: false } },
        { id: 'ug_proc', name: 'Procurement Team', roles: ['procurement'], permissions: { canViewFinancials: true, canApproveTechReview: false, canReleaseHub: false, canManageUsers: false } },
        { id: 'ug_wh', name: 'Warehouse & Logistics', roles: ['warehouse', 'logistics'], permissions: { canViewFinancials: false, canApproveTechReview: false, canReleaseHub: true, canManageUsers: false } },
        { id: 'ug_mgmt', name: 'Executive Management', roles: ['admin'], permissions: { canViewFinancials: true, canApproveTechReview: true, canReleaseHub: true, canManageUsers: true } }
      ];
      stubDb.users = [{ ...liveUser, roles: liveUser.roles || [], groupIds: liveUser.groupIds || [] }];
      writeDb(stubDb, sandboxPath);
    }
    const sandboxDb = readDb(sandboxPath);
    let sandboxUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!sandboxUser) {
      sandboxUser = { ...liveUser, roles: liveUser.roles || [], groupIds: liveUser.groupIds || [] };
      sandboxDb.users = sandboxDb.users || [];
      sandboxDb.users.push(sandboxUser);
      writeDb(sandboxDb, sandboxPath);
    } else {
      sandboxUser.roles = liveUser.roles || [];
      sandboxUser.groupIds = liveUser.groupIds || [];
      sandboxUser.name = liveUser.name || sandboxUser.name;
      sandboxUser.email = liveUser.email || sandboxUser.email;
      sandboxUser.password = liveUser.password;
      writeDb(sandboxDb, sandboxPath);
    }
    saveSandboxLoginSnapshot(username);
    const { password: _, ...safe } = sandboxUser;
    return res.json({ ...safe, roles: liveUser.roles || [], groupIds: liveUser.groupIds || [], sandbox: true, sandboxOwner: sanitizeUsername(username), sandboxLabel: `My Own Sandbox (${username})` });
  }

  const ownerSanitized = sanitizeUsername(targetEnv);
  const sandboxPath = getSandboxDbPath(ownerSanitized);
  if (!fs.existsSync(sandboxPath)) return res.status(404).json({ error: "Team sandbox environment not found." });

  const sandboxDb = readDb(sandboxPath);
  const sandboxUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  
  const liveTargetUser = (liveDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  const isTargetAdmin = liveTargetUser?.roles?.includes('admin');
  const hasAccess = sandboxUser && (sandboxUser.sandboxAccess || isTargetAdmin || sandboxUser.username.toLowerCase() === ownerSanitized);
  
  if (!hasAccess) return res.status(403).json({ error: "You do not have access to this team sandbox." });
  // Design intent: when an API key authenticated the caller, the sandbox password
  // check is intentionally skipped. The key has already proven the caller's
  // identity at the live-DB level (see findApiKeyBySecret + the `authedViaApiKey`
  // branch above); the sandbox itself trusts the live identity it auto-syncs
  // from. Admin / shared-sandbox access control is still enforced via `hasAccess`
  // above — this only removes the redundant per-sandbox password re-prompt.
  if (!authedViaApiKey && sandboxUser.password !== hashPassword(password) && liveTargetUser?.password !== hashPassword(password)) {
    return res.status(401).json({ error: "Invalid username or password for this sandbox." });
  }

  if (liveTargetUser && sandboxUser) {
    sandboxUser.roles = liveTargetUser.roles || [];
    sandboxUser.groupIds = liveTargetUser.groupIds || [];
    sandboxUser.name = liveTargetUser.name || sandboxUser.name;
    sandboxUser.email = liveTargetUser.email || sandboxUser.email;
    sandboxUser.password = liveTargetUser.password;
    writeDb(sandboxDb, sandboxPath);
  }

  saveSandboxLoginSnapshot(ownerSanitized);
  const ownerUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === ownerSanitized);
  const { password: _, ...safe } = sandboxUser;
  return res.json({
    ...safe,
    roles: liveTargetUser?.roles || sandboxUser.roles || [],
    groupIds: liveTargetUser?.groupIds || sandboxUser.groupIds || [],
    sandbox: true,
    sandboxOwner: ownerSanitized,
    sandboxLabel: `${ownerUser?.name || ownerSanitized}'s Team Sandbox`,
    authMethod: authedViaApiKey ? 'api-key' : 'password'
  });
});


// --- API KEYS (ERP Test Tool machine authentication) ---
// Admin-only endpoints for generating / listing / toggling / revoking API keys.
// Keys live in the LIVE database `apiKeys` collection; the full secret is only
// returned once, at creation time.
app.get('/api/v1/api-keys', (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin privileges are required to manage API keys.' });
    const liveDb = readDb(DB_PATH);
    const safe = (liveDb.apiKeys || []).map(({ keyHash, ...rest }) => {
        const ownerUser = (liveDb.users || []).find(u => u.username.toLowerCase() === (rest.username || '').toLowerCase());
        return {
            allowLive: false,
            roles: ownerUser?.roles || [],
            ...rest
        };
    });
    return res.json(safe);
});

app.post('/api/v1/api-keys', (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin privileges are required to manage API keys.' });
    const liveDb = readDb(DB_PATH);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Key name is required.' });

    const creator = String(req.headers['x-user'] || req.user || 'admin').trim();
    let ownerUsername = String(req.body.username || '').trim();
    if (!ownerUsername) ownerUsername = creator;

    const ownerUser = (liveDb.users || []).find(u => u.username.toLowerCase() === ownerUsername.toLowerCase());
    if (!ownerUser) return res.status(400).json({ error: `User "${ownerUsername}" does not exist.` });

    const secret = generateApiKey();
    // Default to sandbox only: allowLive is false unless explicitly set to true.
    const allowLive = req.body.allowLive === true;
    const roles = Array.isArray(ownerUser.roles) ? [...ownerUser.roles] : [];

    const record = {
        id: makeApiKeyId(),
        name,
        username: ownerUser.username,
        roles,
        allowLive,
        keyHash: hashApiKey(secret),
        prefix: secret.slice(0, 14),
        createdAt: new Date().toISOString(),
        createdBy: creator,
        lastUsedAt: null,
        enabled: true
    };
    liveDb.apiKeys = liveDb.apiKeys || [];
    liveDb.apiKeys.push(record);
    if (!writeDb(liveDb, DB_PATH)) return res.status(500).json({ error: 'Failed to store API key.' });
    invalidateApiKeyCache();   // ensure the new key is usable on the next request

    console.log(`[API Keys] Created key "${name}" for ${record.username} (allowLive: ${allowLive}) by ${creator}.`);
    const { keyHash, ...safeRecord } = record;
    return res.status(201).json({ ...safeRecord, key: secret });
});

app.put('/api/v1/api-keys/:id', (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin privileges are required to manage API keys.' });
    const liveDb = readDb(DB_PATH);
    const list = liveDb.apiKeys || [];
    const idx = list.findIndex(k => k.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'API key not found.' });

    const updates = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) updates.name = req.body.name.trim();
    if (typeof req.body.enabled === 'boolean') updates.enabled = req.body.enabled;
    if (typeof req.body.allowLive === 'boolean') updates.allowLive = req.body.allowLive;
    list[idx] = { ...list[idx], ...updates };
    liveDb.apiKeys = list;
    if (!writeDb(liveDb, DB_PATH)) return res.status(500).json({ error: 'Failed to update API key.' });
    invalidateApiKeyCache();   // disable / re-enable takes effect on the next request

    const { keyHash, ...safeRecord } = list[idx];
    return res.json(safeRecord);
});

app.delete('/api/v1/api-keys/:id', (req, res) => {
    if (!isAdminUser(req)) return res.status(403).json({ error: 'Admin privileges are required to manage API keys.' });
    const liveDb = readDb(DB_PATH);
    const list = liveDb.apiKeys || [];
    const idx = list.findIndex(k => k.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'API key not found.' });

    list.splice(idx, 1);
    liveDb.apiKeys = list;
    if (!writeDb(liveDb, DB_PATH)) return res.status(500).json({ error: 'Failed to delete API key.' });
    invalidateApiKeyCache();   // revoked key stops authenticating immediately

    return res.json({ success: true, message: 'API key revoked.' });
});


app.post('/api/v1/init-defaults', (req, res) => {
    // NEVER allow init-defaults to overwrite a sandbox — sandboxes are initialized by the login endpoint
    if (isSandbox(req)) {
        return res.status(400).json({ message: "NotEmpty" });
    }
    const db = getDb(req);
    if (Object.keys(db).length === 0 || req.body.force) {
        const dd = req.body.defaults || {};
        if (dd.users) dd.users = dd.users.map(u => u.password ? { ...u, password: hashPassword(u.password) } : u);
        if (writeDb({ ...db, ...dd })) res.json({ message: "Initialized" });
        else res.status(500).json({ error: "Failed" });
    } else res.status(400).json({ message: "NotEmpty" });
});

app.post('/api/v1/seed-users', (req, res) => {
    // NEVER allow seed-users to overwrite sandbox users — sandboxes manage their own users
    if (isSandbox(req)) {
        return res.status(400).json({ message: "UsersAlreadyExist" });
    }
    const db = getDb(req);
    if (db.users && db.users.length > 0) {
        return res.status(400).json({ message: "UsersAlreadyExist" });
    }
    const dd = req.body.defaults || {};
    if (dd.users) dd.users = dd.users.map(u => u.password ? { ...u, password: hashPassword(u.password) } : u);
    db.users = dd.users || [];
    db.userGroups = dd.userGroups || [];
    if (writeDb(db, getDbPath(req))) {
        console.log(`[System] Seeded users and groups at ${new Date().toISOString()}`);
        res.json({ message: "Seeded" });
    } else {
        res.status(500).json({ error: "Failed" });
    }
});

// --- FILE UPLOAD ENDPOINT ---
app.post('/api/upload-pod', strictUploadGate, uploadPod.single('podFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        return await finishUpload(req, res, req.file.path);
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-einvoice', strictUploadGate, uploadEInvoice.single('einvoiceFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        return await finishUpload(req, res, req.file.path);
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-wht-certificate', strictUploadGate, uploadWht.single('whtFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        return await finishUpload(req, res, req.file.path);
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-cost-sheet', strictUploadGate, uploadCostSheet.single('costSheetFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        return await finishUpload(req, res, req.file.path);
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-supplier-receipt', strictUploadGate, uploadSupplierReceipt.single('receiptFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        return await finishUpload(req, res, req.file.path);
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.get('/api/v1/integrations/google-drive/status', (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const oauth = getGoogleOAuthConfig(settings);
        const gd = settings.googleDriveConfig || {};
        res.json({
            configured: oauth.configured,
            connected: !!gd.refreshToken,
            connectedEmail: gd.connectedEmail || null,
            connectedAt: gd.connectedAt || null,
            enabled: !!gd.enabled,
            autoUploadExternalSubmissions: gd.autoUploadExternalSubmissions !== false,
            clientIdSet: !!gd.clientId,
            clientSecretSet: !!gd.clientSecret,
            folderName: gd.folderName || '',
            folderId: gd.folderId || '',
            callbackUrl: getGoogleCallbackUrl(req, settings)
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch Google Drive status' });
    }
});

app.get('/api/v1/integrations/local-storage/status', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const local = getLocalStorageConfig(settings);
        let buckets = [];
        let reachable = false;

        if (local.configured) {
            buckets = await listLocalStorageBuckets(settings);
            reachable = true;
        }

        res.json({
            configured: local.configured,
            reachable,
            enabled: !!local.enabled,
            autoUploadExternalSubmissions: local.autoUploadExternalSubmissions !== false,
            storageIp: local.storageIp,
            apiPort: local.apiPort,
            consolePort: local.consolePort,
            bucketName: local.bucketName,
            buckets
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch local storage status' });
    }
});

app.post('/api/v1/integrations/local-storage/buckets', bodyParser.json(), async (req, res) => {
    try {
        const db = getDb(req);
        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const settings = resolveSettings(db);
        const bucketName = await createLocalStorageBucket(settings, req.body?.bucketName);
        const local = getLocalStorageConfig(settings);
        settings.localStorageConfig = {
            ...local,
            bucketName
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));
        return res.json({ success: true, bucketName });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to create bucket' });
    }
});

app.get('/api/v1/integrations/google-drive/auth-url', (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const oauthFromSettings = getGoogleOAuthConfig(settings);
        if (!oauthFromSettings.configured) {
            return res.status(400).json({ error: 'Set Google Client ID and Client Secret in Integrations tab first.' });
        }

        const callbackUrl = getGoogleCallbackUrl(req, settings);
        const statePayload = {
            t: Date.now(),
            u: String(req.headers['x-user'] || 'System')
        };
        const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

        const params = new URLSearchParams({
            client_id: oauthFromSettings.clientId,
            redirect_uri: callbackUrl,
            response_type: 'code',
            scope: GOOGLE_DRIVE_SCOPE,
            access_type: 'offline',
            prompt: 'consent',
            state
        });

        res.json({ url: `${GOOGLE_OAUTH_BASE}?${params.toString()}` });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to build Google auth URL' });
    }
});

app.get('/api/v1/integrations/google-drive/callback', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const oauth = getGoogleOAuthConfig(settings);
        if (!oauth.configured) {
            return res.status(400).send('Google OAuth is not configured on this server.');
        }

        const { code, error } = req.query;
        if (error) {
            return res.status(400).send(`Google authorization failed: ${error}`);
        }
        if (!code) {
            return res.status(400).send('Missing authorization code.');
        }

        const callbackUrl = getGoogleCallbackUrl(req, settings);
        const tokenBody = new URLSearchParams({
            code: String(code),
            client_id: oauth.clientId,
            client_secret: oauth.clientSecret,
            redirect_uri: callbackUrl,
            grant_type: 'authorization_code'
        });

        const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenBody.toString()
        });

        if (!tokenResponse.ok) {
            const errText = await tokenResponse.text();
            return res.status(500).send(`Token exchange failed: ${errText}`);
        }

        const tokenData = await tokenResponse.json();

        let connectedEmail = '';
        if (tokenData.access_token) {
            try {
                const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` }
                });
                if (profileRes.ok) {
                    const profile = await profileRes.json();
                    connectedEmail = profile.email || '';
                }
            } catch (e) {
                console.warn('[GoogleDrive] Failed to fetch connected account profile');
            }
        }

        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const prev = settings.googleDriveConfig || {};
        const refreshToken = tokenData.refresh_token || prev.refreshToken || '';
        if (!refreshToken) {
            return res.status(500).send('No refresh token returned by Google and no existing token is stored. Revoke app access in Google Account and retry consent.');
        }
        settings.googleDriveConfig = {
            ...prev,
            refreshToken,
            connectedEmail: connectedEmail || prev.connectedEmail || '',
            connectedAt: new Date().toISOString(),
            enabled: prev.enabled !== false,
            autoUploadExternalSubmissions: prev.autoUploadExternalSubmissions !== false,
            folderName: prev.folderName || '',
            folderId: prev.folderId || ''
        };

        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));

        return res.send('<html><body style="font-family: Arial, sans-serif; padding: 24px;"><h3>Google Drive connected.</h3><p>You can close this window and return to Nexus ERP.</p><script>setTimeout(function(){window.close();},1200);</script></body></html>');
    } catch (err) {
        console.error('[GoogleDrive] OAuth callback failed:', err);
        return res.status(500).send(`OAuth callback failed: ${err.message || err}`);
    }
});

app.post('/api/v1/integrations/google-drive/disconnect', (req, res) => {
    try {
        const db = getDb(req);
        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const settings = resolveSettings(db);
        const prev = settings.googleDriveConfig || {};
        settings.googleDriveConfig = {
            ...prev,
            refreshToken: '',
            connectedEmail: '',
            connectedAt: ''
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to disconnect Google Drive' });
    }
});

app.post('/api/v1/integrations/google-drive/upload', uploadGoogleDriveFile.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file was uploaded.' });
        }

        const db = getDb(req);
        const settings = resolveSettings(db);
        const gd = settings.googleDriveConfig || {};

        if (!gd.enabled) {
            return res.status(400).json({ error: 'Google Drive integration is disabled in System Core Control.' });
        }
        if (!gd.refreshToken) {
            return res.status(400).json({ error: 'Google Drive is not connected yet.' });
        }

        const targetFolderId = await resolveOrCreateDriveFolder({
            req,
            refreshToken: gd.refreshToken,
            folderName: gd.folderName || '',
            fallbackFolderId: gd.folderId || '',
            settings
        });

        if (targetFolderId !== (gd.folderId || '')) {
            settings.googleDriveConfig = {
                ...gd,
                folderId: targetFolderId
            };
            if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
                db.settings = [{}];
            }
            db.settings[0] = encryptSettings(settings);
            writeDb(db, targetPath);
}

        const orderPrefix = req.body.internalOrderNumber ? `${req.body.internalOrderNumber}_` : '';
        const poPrefix = req.body.customerReferenceNumber ? `${req.body.customerReferenceNumber}_` : '';
        const finalName = `${orderPrefix}${poPrefix}${req.file.originalname}`;

        const uploaded = await uploadBufferToGoogleDrive({
            req,
            buffer: req.file.buffer,
            mimeType: req.file.mimetype,
            fileName: finalName,
            folderId: targetFolderId || '',
            refreshToken: gd.refreshToken,
            settings
        });

        return res.json({
            success: true,
            id: uploaded.id,
            name: uploaded.name,
            webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
            webContentLink: uploaded.webContentLink || ''
        });
    } catch (err) {
        console.error('[GoogleDrive] Upload failed:', err);
        return res.status(500).json({ error: err.message || 'Google Drive upload failed' });
    }
});

// ==================== TURSO INTEGRATION ====================

app.get('/api/v1/integrations/turso/status', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        // v1.0001200: same resolution as the sync itself (TURSO_ENABLED env first, then the Settings switch)
        const tcfg = resolveTursoConfig(settings);
        const rawUrl = tcfg.url;
        const authToken = tcfg.token;
        const useTurso = !!tcfg.enabled;

        if (!rawUrl || !authToken) {
            return res.json({ configured: false, connected: false, enabled: useTurso, enabledBy: tcfg.by, strict: STRICT_REMOTE.on });
        }

        const dbUrl = rawUrl.startsWith('libsql://') ? rawUrl.replace(/^libsql:\/\//, 'https://') : rawUrl;
        const client = createClient({ url: dbUrl, authToken });
        const result = await client.execute("SELECT count(*) as cnt FROM nexus_state");
        const count = result.rows[0]?.cnt || 0;

        return res.json({
            configured: true,
            connected: true,
            enabled: useTurso,
            enabledBy: tcfg.by,
            strict: STRICT_REMOTE.on,
            databaseUrl: rawUrl,
            syncedStatesCount: count,
            readOnly: persistState.readOnly,
            lastPush: persistState.lastPush
        });
    } catch (err) {
        return res.json({
            configured: true,
            connected: false,
            enabled: true,
            strict: STRICT_REMOTE.on,
            error: err.message
        });
    }
});

app.post('/api/v1/integrations/turso/test', bodyParser.json(), async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const rawUrl = req.body?.tursoUrl || (settings && settings.tursoUrl && String(settings.tursoUrl).trim()) || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL;
        const authToken = req.body?.tursoAuthToken || (settings && settings.tursoAuthToken && String(settings.tursoAuthToken).trim()) || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken();

        const dbUrl = rawUrl.startsWith('libsql://') ? rawUrl.replace(/^libsql:\/\//, 'https://') : rawUrl;
        const client = createClient({ url: dbUrl, authToken });
        const result = await client.execute("SELECT count(*) as cnt FROM nexus_state");
        const count = result.rows[0]?.cnt || 0;

        return res.json({
            success: true,
            message: `Successfully connected to Turso database! Currently holding ${count} synced system states in cloud.`,
            count
        });
    } catch (err) {
        return res.status(400).json({ error: err.message || 'Failed to connect to Turso database' });
    }
});

// ==================== DROPBOX INTEGRATION ====================

app.get('/api/v1/integrations/dropbox/status', (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const cfg = getDropboxConfig(settings);
        const baseUrl = getBaseUrlFromRequest(req);
        const callbackUrl = `${baseUrl}/api/v1/integrations/dropbox/callback`;
        return res.json({
            enabled: !!cfg.enabled,
            strict: STRICT_REMOTE.on,
            reachable: dropboxState.reachable,
            autoUploadExternalSubmissions: !!cfg.autoUploadExternalSubmissions,
            configured: !!cfg.configured,
            connected: !!cfg.refreshToken,
            folderPath: cfg.folderPath || '/NexusERP_Uploads',
            appKey: cfg.appKey || '',
            appSecretConfigured: !!cfg.appSecret,
            refreshTokenConfigured: !!cfg.refreshToken,
            connectedAccount: cfg.connectedAccount || '',
            connectedAt: cfg.connectedAt || '',
            callbackUrl
        });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to read Dropbox status' });
    }
});

app.post('/api/v1/integrations/dropbox/test', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const currentCfg = getDropboxConfig(settings);
        const appKey = (req.body.appKey && req.body.appKey.trim()) || currentCfg.appKey;
        const appSecret = (req.body.appSecret && req.body.appSecret.trim()) || currentCfg.appSecret;
        const refreshToken = (req.body.refreshToken && req.body.refreshToken.trim()) || currentCfg.refreshToken;

        if (!appKey || !appSecret || !refreshToken) {
            return res.status(400).json({ error: 'App Key, App Secret, and Refresh Token are required to test Dropbox connection.' });
        }

        const account = await testDropboxConnection(appKey, appSecret, refreshToken);
        const accountName = account?.name?.display_name || account?.email || 'Connected';
        const email = account?.email || '';

        // Persist connected account and credentials to database settings
        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const prev = settings.dropboxConfig || {};
        settings.dropboxConfig = {
            ...prev,
            enabled: prev.enabled !== false,
            appKey,
            appSecret,
            refreshToken,
            connectedAccount: accountName,
            connectedAt: new Date().toISOString()
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));

        return res.json({
            success: true,
            account: accountName,
            email
        });
    } catch (err) {
        console.error('[Dropbox] Test connection failed:', err);
        return res.status(500).json({ error: err.message || 'Dropbox connection test failed' });
    }
});

app.post('/api/v1/integrations/dropbox/auth-url', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const cfg = getDropboxConfig(settings);
        const appKey = (req.body.appKey && req.body.appKey.trim()) || cfg.appKey;
        if (!appKey) {
            return res.status(400).json({ error: 'Dropbox App Key must be configured first.' });
        }
        const baseUrl = getBaseUrlFromRequest(req);
        const redirectUri = req.body.redirectUri || `${baseUrl}/api/v1/integrations/dropbox/callback`;

        const dbx = new Dropbox({ clientId: appKey });
        const authUrl = await dbx.auth.getAuthenticationUrl(
            redirectUri,
            undefined,
            'code',
            'offline',
            null,
            'none',
            false
        );
        return res.json({ url: authUrl });
    } catch (err) {
        console.error('[Dropbox] Auth URL error:', err);
        return res.status(500).json({ error: err.message || 'Failed to generate Dropbox auth URL' });
    }
});

app.post('/api/v1/integrations/dropbox/exchange-token', async (req, res) => {
    try {
        const { code, redirectUri } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'Authorization code is required.' });
        }
        const db = getDb(req);
        const settings = resolveSettings(db);
        const cfg = getDropboxConfig(settings);
        const appKey = cfg.appKey;
        const appSecret = cfg.appSecret;
        if (!appKey || !appSecret) {
            return res.status(400).json({ error: 'App Key and App Secret must be saved before exchanging authorization code.' });
        }

        const baseUrl = getBaseUrlFromRequest(req);
        const effectiveRedirectUri = redirectUri || `${baseUrl}/api/v1/integrations/dropbox/callback`;
        const refreshToken = await exchangeDropboxCodeForRefreshToken({
            appKey,
            appSecret,
            code,
            redirectUri: effectiveRedirectUri
        });

        let accountName = '';
        try {
            const acc = await testDropboxConnection(appKey, appSecret, refreshToken);
            accountName = acc?.name?.display_name || acc?.email || '';
        } catch (e) {
            console.warn('[Dropbox] Failed to fetch account info after exchange:', e.message);
        }

        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const prev = settings.dropboxConfig || {};
        settings.dropboxConfig = {
            ...prev,
            refreshToken,
            connectedAccount: accountName || prev.connectedAccount || '',
            connectedAt: new Date().toISOString()
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));

        return res.json({
            success: true,
            message: 'Dropbox connected successfully',
            account: accountName
        });
    } catch (err) {
        console.error('[Dropbox] Exchange token error:', err);
        return res.status(500).json({ error: err.message || 'Failed to exchange Dropbox authorization code' });
    }
});

app.get('/api/v1/integrations/dropbox/callback', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        const cfg = getDropboxConfig(settings);

        const { code, error, error_description } = req.query;
        if (error) {
            return res.status(400).send(`Dropbox authorization failed: ${error_description || error}`);
        }
        if (!code) {
            return res.status(400).send('Missing authorization code.');
        }

        const baseUrl = getBaseUrlFromRequest(req);
        const redirectUri = `${baseUrl}/api/v1/integrations/dropbox/callback`;

        const refreshToken = await exchangeDropboxCodeForRefreshToken({
            appKey: cfg.appKey,
            appSecret: cfg.appSecret,
            code: String(code),
            redirectUri
        });

        let accountName = '';
        try {
            const acc = await testDropboxConnection(cfg.appKey, cfg.appSecret, refreshToken);
            accountName = acc?.name?.display_name || acc?.email || '';
        } catch (e) {
            console.warn('[Dropbox] Failed to fetch account info in callback:', e.message);
        }

        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const prev = settings.dropboxConfig || {};
        settings.dropboxConfig = {
            ...prev,
            refreshToken,
            connectedAccount: accountName || prev.connectedAccount || '',
            connectedAt: new Date().toISOString(),
            enabled: prev.enabled !== false,
            autoUploadExternalSubmissions: prev.autoUploadExternalSubmissions !== false
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));

        return res.send(`<html><body style="font-family: Arial, sans-serif; padding: 24px;"><h3>Dropbox connected successfully.</h3><p>You can close this window and return to Nexus ERP.</p><script>if (window.opener) { window.opener.postMessage({ type: 'DROPBOX_AUTH_SUCCESS' }, '*'); } setTimeout(function(){window.close();},1200);</script></body></html>`);
    } catch (err) {
        console.error('[Dropbox] OAuth callback failed:', err);
        return res.status(500).send(`OAuth callback failed: ${err.message || err}`);
    }
});

app.post('/api/v1/integrations/dropbox/disconnect', (req, res) => {
    try {
        const db = getDb(req);
        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const settings = resolveSettings(db);
        const prev = settings.dropboxConfig || {};
        settings.dropboxConfig = {
            ...prev,
            refreshToken: '',
            connectedAccount: '',
            connectedAt: ''
        };
        db.settings[0] = encryptSettings(settings);
        writeDb(db, getDbPath(req));
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to disconnect Dropbox' });
    }
});

app.post('/api/v1/integrations/dropbox/upload', uploadGoogleDriveFile.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file was uploaded.' });
        }
        const db = getDb(req);
        const settings = resolveSettings(db);
        const cfg = getDropboxConfig(settings);

        if (!cfg.enabled) {
            return res.status(400).json({ error: 'Dropbox integration is disabled in System Core Control.' });
        }
        if (!cfg.configured) {
            return res.status(400).json({ error: 'Dropbox credentials are not fully configured or connected.' });
        }

        const orderPrefix = req.body.internalOrderNumber ? `${req.body.internalOrderNumber}_` : '';
        const poPrefix = req.body.customerReferenceNumber ? `${req.body.customerReferenceNumber}_` : '';
        const finalName = `${orderPrefix}${poPrefix}${req.file.originalname}`;

        const uploaded = await uploadFileToDropbox({
            settings,
            buffer: req.file.buffer,
            relativePath: finalName,
            mimeType: req.file.mimetype
        });

        return res.json({
            success: true,
            id: uploaded.id,
            name: uploaded.name,
            path_display: uploaded.path_display,
            webViewLink: `https://www.dropbox.com/home${encodeURI(cfg.folderPath)}`
        });
    } catch (err) {
        console.error('[Dropbox] Upload failed:', err);
        return res.status(500).json({ error: err.message || 'Dropbox upload failed' });
    }
});

app.post('/api/v1/integrations/dropbox/sync-all', async (req, res) => {
    try {
        const db = getDb(req);
        const settings = resolveSettings(db);
        if (!isDropboxConfigured(settings)) {
            return res.status(400).json({ error: 'Dropbox is not configured or connected.' });
        }
        const uploadsDir = isSandbox(req) ? getSandboxUploadsPath(req.sandboxOwner) : UPLOADS_BASE;
        if (!fs.existsSync(uploadsDir)) {
            return res.json({ success: true, count: 0, errors: 0, message: 'No local documents found to sync.' });
        }

        const result = await syncLocalDirectoryToDropbox(uploadsDir, req);
        return res.json({
            success: true,
            count: result.count,
            errors: result.errors,
            message: `Successfully synced ${result.count} documents to Dropbox!`
        });
    } catch (err) {
        console.error('[Dropbox] Sync all failed:', err);
        return res.status(500).json({ error: err.message || 'Failed to sync documents to Dropbox' });
    }
});

app.post('/api/v1/integrations/storage/upload', uploadGoogleDriveFile.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file was uploaded.' });
        }

        const db = getDb(req);
        if (!db.settings || !Array.isArray(db.settings) || db.settings.length === 0) {
            db.settings = [{}];
        }
        const settings = resolveSettings(db);
        const googleEnabled = !!settings?.googleDriveConfig?.enabled && !!settings?.googleDriveConfig?.autoUploadExternalSubmissions;
        const localEnabled = !!settings?.localStorageConfig?.enabled && !!settings?.localStorageConfig?.autoUploadExternalSubmissions;
        const dropboxEnabled = !!settings?.dropboxConfig?.enabled && !!settings?.dropboxConfig?.autoUploadExternalSubmissions;
        if (!googleEnabled && !localEnabled && !dropboxEnabled) {
            return res.status(400).json({ error: 'No enabled storage integration is configured for automatic uploads.' });
        }

        const orderPrefix = req.body.internalOrderNumber ? `${req.body.internalOrderNumber}_` : '';
        const poPrefix = req.body.customerReferenceNumber ? `${req.body.customerReferenceNumber}_` : '';
        const finalName = `${orderPrefix}${poPrefix}${req.file.originalname}`;
        const uploads = {};
        const errors = [];

        const gd = settings.googleDriveConfig || {};
        if (googleEnabled) {
            try {
                if (!gd.refreshToken) {
                    throw new Error('Google Drive is not connected yet.');
                }

                const targetFolderId = await resolveOrCreateDriveFolder({
                    req,
                    refreshToken: gd.refreshToken,
                    folderName: gd.folderName || '',
                    fallbackFolderId: gd.folderId || '',
                    settings
                });

                if (targetFolderId !== (gd.folderId || '')) {
                    settings.googleDriveConfig = {
                        ...gd,
                        folderId: targetFolderId
                    };
                    db.settings[0] = encryptSettings(settings);
                    writeDb(db, getDbPath(req));
                }

                const uploaded = await uploadBufferToGoogleDrive({
                    req,
                    buffer: req.file.buffer,
                    mimeType: req.file.mimetype,
                    fileName: finalName,
                    folderId: targetFolderId || '',
                    refreshToken: gd.refreshToken,
                    settings
                });

                uploads.googleDrive = {
                    id: uploaded.id,
                    name: uploaded.name,
                    webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
                    webContentLink: uploaded.webContentLink || ''
                };
            } catch (error) {
                errors.push({ target: 'google-drive', message: error.message || 'Google Drive upload failed' });
            }
        }

        if (dropboxEnabled) {
            try {
                const cfg = getDropboxConfig(settings);
                if (!cfg.configured) {
                    throw new Error('Dropbox is not connected yet.');
                }
                const uploaded = await uploadFileToDropbox({
                    settings,
                    buffer: req.file.buffer,
                    relativePath: finalName,
                    mimeType: req.file.mimetype
                });
                uploads.dropbox = {
                    id: uploaded.id,
                    name: uploaded.name,
                    path_display: uploaded.path_display,
                    webViewLink: `https://www.dropbox.com/home${encodeURI(cfg.folderPath)}`
                };
            } catch (error) {
                errors.push({ target: 'dropbox', message: error.message || 'Dropbox upload failed' });
            }
        }

        if (localEnabled) {
            try {
                const local = getLocalStorageConfig(settings);
                uploads.localStorage = await uploadBufferToLocalStorage({
                    buffer: req.file.buffer,
                    mimeType: req.file.mimetype,
                    fileName: finalName,
                    bucketName: local.bucketName,
                    settings
                });
            } catch (error) {
                errors.push({ target: 'local-storage', message: error.message || 'Local storage upload failed' });
            }
        }

        const uploadedTargets = Object.keys(uploads);
        if (uploadedTargets.length === 0) {
            return res.status(500).json({
                error: errors.map(entry => `${entry.target}: ${entry.message}`).join(' | ') || 'Configured storage upload failed',
                uploads,
                errors
            });
        }

        return res.json({
            success: true,
            uploads,
            uploadedTargets,
            errors
        });
    } catch (err) {
        console.error('[Storage] Upload failed:', err);
        return res.status(500).json({ error: err.message || 'Configured storage upload failed' });
    }
});

// ==================== SUPPLIER PAYMENTS ====================

// Finance-only: allocate (part of) an unallocated supplier payment to a PO / order / component.
app.post('/api/v1/supplierPayments/:id/allocate', (req, res) => {
    try {
        { const r = req.roles || []; if (r.length && !r.some(x => ['admin','management','finance'].includes(x))) return res.status(403).json({ error: 'refused: wrong role: allocating payments is finance' }); }
        const db = getDb(req);
        const sp = (db.supplierPayments || []).find(x => x.id === req.params.id);
        if (!sp || sp.isRefund) return res.status(404).json({ error: 'Supplier payment not found' });
        const { poNumber, orderId, componentId } = req.body || {};
        if (!poNumber && !orderId && !componentId) return res.status(400).json({ error: 'poNumber, orderId or componentId is required' });
        const free = Number(sp.unallocatedAdvance) || 0;
        const want = req.body && req.body.amount !== undefined ? Number(req.body.amount) : free;
        if (!(want > 0)) return res.status(400).json({ error: 'a positive amount is required' });
        if (want > free + 0.004) return res.status(400).json({ error: `refused: only ${free.toFixed(2)} of this payment is unallocated` });
        const entries = poComponentEntries(db, sp.supplierId, { orderId, poNumber, componentId });
        if (!entries.length) return res.status(400).json({ error: 'refused: no issued PO component of this supplier matches' });
        const r = allocateToEntries(db, sp.supplierId, entries, want);
        if (!r.allocations.length) return res.status(400).json({ error: 'refused: the PO is already fully covered' });
        const done = Math.round((want - r.rest) * 100) / 100;
        sp.allocations = (sp.allocations || []).concat(r.allocations);
        sp.unallocatedAdvance = Math.round((free - done) * 100) / 100;
        writeDb(db, getDbPath(req));
        res.json(sp);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to allocate supplier payment' });
    }
});

// GET all supplier payments
app.get('/api/v1/supplierPayments', (req, res) => {
    const db = getDb(req);
    res.json(db.supplierPayments || []);
});

// User ruling 2026-10-21 (22:52): the FINANCE user decides to which wallet a supplier payment goes. A payment that names a PO / order is allocated to that PO's components
// (oldest first inside it); a payment that names none stays an unallocated advance (supplier general wallet) until finance uses the Allocate action. No automatic allocation elsewhere.
const NOT_COMMITTED_STATUSES = ['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'];
const allocatedPerComponent = (db, supplierId) => {
    const alloc = {};
    (db.supplierPayments || []).filter(sp => sp.supplierId === supplierId).forEach(sp => (sp.allocations || []).forEach(a => { alloc[a.componentId] = (alloc[a.componentId] || 0) + (Number(a.amount) || 0); }));
    return alloc;
};
const poComponentEntries = (db, supplierId, { orderId, poNumber, componentId, all } = {}) => {
    const out = [];
    (db.orders || []).forEach(order => orderPoComponents(order).forEach(({ comp }) => {  // v1.0001218: kept delivered POs of a reopened order too
        // a fully consumed procured component keeps its PO and supplier (source turns CONSUMED), so payments to that PO still allocate to it
        if (!(comp.source === 'PROCUREMENT' || (comp.source === 'CONSUMED' && comp.poNumber)) || comp.supplierId !== supplierId) return;
        if (NOT_COMMITTED_STATUSES.includes(String(comp.status || '').toUpperCase())) return;
        const hit = all || (componentId && comp.id === componentId) || (!componentId && ((orderId && order.id === orderId) || (poNumber && comp.poNumber === poNumber)));
        if (!hit) return;
        const taxRate = comp.taxPercent !== undefined ? comp.taxPercent : 14;
        out.push({ componentId: comp.id, orderId: order.id, orderNumber: order.internalOrderNumber, itemDescription: comp.description, poNumber: comp.poNumber, totalCost: (comp.quantity || 0) * (comp.unitCost || 0) * (1 + taxRate / 100), at: comp.procurementStartedAt || comp.statusUpdatedAt || order.dataEntryTimestamp });
    }));
    out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return out;
};
// allocate up to `amount` of an unallocated pool to the given entries; returns { allocations, rest }
const allocateToEntries = (db, supplierId, entries, amount) => {
    const prev = allocatedPerComponent(db, supplierId);
    let rest = Math.round(amount * 100) / 100; const allocations = [];
    for (const e of entries) {
        if (rest <= 0.004) break;
        const open = Math.round((e.totalCost - (prev[e.componentId] || 0)) * 100) / 100;
        if (open <= 0.004) continue;
        const take = Math.round(Math.min(open, rest) * 100) / 100;
        allocations.push({ componentId: e.componentId, orderId: e.orderId, orderNumber: e.orderNumber, itemDescription: e.itemDescription, amount: take });
        prev[e.componentId] = (prev[e.componentId] || 0) + take;
        rest = Math.round((rest - take) * 100) / 100;
    }
    return { allocations, rest };
};

// Move the excess of named supplier payments (autoCover) onto the issued PO components of that supplier that still need cover (oldest payment, oldest component first)
const autoCoverFromExcess = (db, supplierId, poNumber) => {
    // R34 round 3 (item 4): never cover more than the supplier's NET unallocated money (advances minus refunds still held as a
    // negative unallocated amount, e.g. refunds recorded before round 3), so a refunded advance is not used again.
    let netFree = Math.round((db.supplierPayments || []).filter(sp => sp && sp.supplierId === supplierId).reduce((t, sp) => t + (Number(sp.unallocatedAdvance) || 0), 0) * 100) / 100;
    (db.supplierPayments || []).filter(sp => sp.supplierId === supplierId && sp.autoCover && !sp.isRefund && (Number(sp.unallocatedAdvance) || 0) > 0.004)
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .forEach(sp => {
            if (netFree <= 0.004) return;
            const entries = poComponentEntries(db, sp.supplierId, poNumber ? { poNumber } : { all: true });
            if (!entries.length) return;
            const free = Math.min(Number(sp.unallocatedAdvance) || 0, netFree);
            const r = allocateToEntries(db, sp.supplierId, entries, free);
            if (!r.allocations.length) return;
            const used = Math.round(r.allocations.reduce((t, a) => t + (Number(a.amount) || 0), 0) * 100) / 100;
            sp.allocations = (sp.allocations || []).concat(r.allocations);
            sp.unallocatedAdvance = Math.round(((Number(sp.unallocatedAdvance) || 0) - used) * 100) / 100;
            netFree = Math.round((netFree - used) * 100) / 100;
        });
};

// POST record a supplier payment with FIFO allocation & General Ledger reflection
app.post('/api/v1/supplierPayments', (req, res) => {
    try {
        { const r = req.roles || []; if (r.length && !r.some(x => ['admin','management','finance'].includes(x))) return res.status(403).json({ error: 'refused: wrong role: payments are finance' }); }
        const db = getDb(req);
        const user = req.headers['x-user'] || 'System';
        const { supplierId, amount, memo, date, receiptFile, orderId, poNumber } = req.body;
        if (!supplierId || !amount || amount <= 0) {
            return res.status(400).json({ error: "supplierId and a positive amount are required" });
        }

        const supplier = (db.suppliers || []).find(s => s.id === supplierId);
        if (!supplier) return res.status(404).json({ error: "Supplier not found" });
        // Allocation = the PO / order the finance user named when paying; nothing named = unallocated advance (supplier general wallet)
        let allocations = [], unallocatedAdvance = Number(amount);
        if (orderId || poNumber) {
            const r = allocateToEntries(db, supplierId, poComponentEntries(db, supplierId, { orderId, poNumber }), Number(amount));
            allocations = r.allocations; unallocatedAdvance = r.rest;
        }
        unallocatedAdvance = unallocatedAdvance > 0 ? Math.round(unallocatedAdvance * 100) / 100 : 0;

        // Create the payment record
        const paymentRecord = {
            id: `sp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
            supplierId,
            supplierName: supplier.name,
            amount: Number(amount),
            date: date ? new Date(date).toISOString() : new Date().toISOString(),
            memo: memo || '',
            user,
            receiptFile: receiptFile || undefined,
            orderId: orderId || undefined,
            poNumber: poNumber || undefined,
            unallocatedAdvance,
            allocations,
            // user ruling 2026-10-22: the excess of a payment that NAMED a PO/order waits in the supplier general wallet and covers the supplier's later POs / call-offs by itself
            autoCover: (orderId || poNumber) && unallocatedAdvance > 0 ? true : undefined
        };

        if (!db.supplierPayments) db.supplierPayments = [];
        db.supplierPayments.push(paymentRecord);
        if (paymentRecord.autoCover) autoCoverFromExcess(db, supplierId, undefined);

        // Reflect into db.ledger for financial general ledger & cash flow tracking
        if (!db.ledger) db.ledger = [];
        const ledgerEntry = {
            id: `sp_ledg_${paymentRecord.id}`,
            date: paymentRecord.date,
            type: 'COST',
            amount: paymentRecord.amount,
            description: `Supplier Payment: ${supplier.name}${poNumber ? ` - PO #${poNumber}` : ''}${memo ? ` - ${memo}` : ''}`,
            category: 'Supplier Payment',
            fromAccount: 'Cash/Bank',
            toAccount: 'Accounts Payable',
            user,
            receiptFile: receiptFile || undefined,
            supplierId,
            orderId: orderId || undefined,
            poNumber: poNumber || undefined
        };
        db.ledger.push(ledgerEntry);

        writeDb(db, getDbPath(req));

        res.json(paymentRecord);
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record supplier payment" });
    }
});

// GET supplier ledger (balance, delivered, pending, payments)
app.get('/api/v1/supplier-ledger/:supplierId', (req, res) => {
    try {
        const db = getDb(req);
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
            [{ components: orderPoComponents(order).map(x => x.comp) }].forEach(item => {  // v1.0001218: order lines + kept delivered POs of a reopened cancelled order
                (item.components || []).forEach(comp => {
                    const matchesSupplier = isAll || selectedIds.includes(comp.supplierId);
                    if (matchesSupplier && (comp.source === 'PROCUREMENT' || comp.source === 'CONSUMED') &&
                        !['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(comp.status)) {
                        // R21: the supplier ledger is on the GROSS basis (net + tax), because suppliers are paid gross.
                        const ledgerTaxMul = 1 + ((comp.taxPercent !== undefined && comp.taxPercent !== null ? Number(comp.taxPercent) : 14) / 100);
                        const grossUnitCost = (comp.unitCost || 0) * ledgerTaxMul;
                        // The quantity allocated away to another order is still owed to / received from the supplier.
                        const ledgerQty = (comp.quantity || 0) + (comp.allocatedQty || 0);
                        const totalCost = ledgerQty * grossUnitCost;
                        const receivedQty = (comp.receivedQty || 0) + (comp.releasedToStockQty || 0);
                        const deliveredValue = (comp.receivedValueNet !== undefined && comp.receivedValueNet !== null) ? comp.receivedValueNet * ledgerTaxMul : receivedQty * grossUnitCost;
                        const pendingQty = Math.max(0, ledgerQty - receivedQty);
                        const pendingValue = pendingQty * grossUnitCost;

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
                            grossUnitCost,
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

// Request logging middleware for debugging
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode === 404 && req.path.startsWith('/api/v1')) {
            console.error(`[404 DEBUG] ${req.method} ${req.path} - Not matched by any route`);
        }
        return originalJson(body);
    };
    next();
});

// AI Proxy: forwards OpenAI-compatible requests server-side to avoid browser CORS restrictions
app.post('/api/v1/ai-proxy/chat', async (req, res) => {
    try {
        const { endpoint, apiKey, payload } = req.body;
        if (!endpoint || !apiKey || !payload) {
            return res.status(400).json({ error: 'Missing endpoint, apiKey, or payload.' });
        }
        if (!payload.max_tokens) {
            payload.max_tokens = 2048;
        }
        const upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });
        const data = await upstream.json();
        if (!upstream.ok) {
            console.error(`[AI Proxy] Upstream error ${upstream.status}:`, JSON.stringify(data));
        }
        res.status(upstream.status).json(data);
    } catch (err) {
        console.error('[AI Proxy] Error:', err.message);
        res.status(502).json({ error: `Upstream request failed: ${err.message}` });
    }
});

// SPA Catch-all: Redirect all non-API requests to index.html
app.get('{*path}', (req, res) => {
    if (req.path.startsWith('/api/v1')) return res.status(404).json({ error: "API not found" });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// v1.0001200: the startup repairs run AFTER the Turso hydrate (see the boot block below), so a fresh
// disk never repairs/writes the empty stub before the real data is back. Skipped while read-only;
// the hydrate retry runs them once the data is in.
const runStartupRepairs = () => {
    if (persistState.readOnly) {
        console.warn('[Persistence] Startup repairs skipped: read-only.');
        return;
    }
    const startupDb = readDb();
    repairNegativeMarginOrders(startupDb);
    repairTradingMirrorOrders(startupDb);
    reconcileStockAllocations(startupDb, DB_PATH);
    syncAuthoritativeUsersToSandboxes(startupDb);
};

// Sweep every db.sandbox.*.json in the project root, run applySchemaMigrations on
// any whose schema version is older than CURRENT_SCHEMA_VERSION, and write the
// result back. Runs synchronously before app.listen() so no request can hit a
// half-migrated sandbox DB. On-demand migration in readDb() is still a backstop.
const migrateAllSandboxesOnStartup = () => {
    let sandboxFiles = [];
    try {
        sandboxFiles = fs.readdirSync(__dirname).filter(
            f => f.startsWith('db.sandbox.') && f.endsWith('.json') && !f.endsWith('.local.bak')
        );
    } catch (err) {
        console.error('[Migration] Failed to scan sandbox directory:', err.message);
        return;
    }

    let migrated = 0;
    let skipped = 0;
    let errored = 0;
    for (const file of sandboxFiles) {
        const targetPath = path.join(__dirname, file);
        try {
            const raw = fs.readFileSync(targetPath, 'utf8');
            const db = JSON.parse(raw);
            const currentVersion = db.settings?.[0]?.dbSchemaVersion || 0;
            if (currentVersion < CURRENT_SCHEMA_VERSION) {
                applySchemaMigrations(db, targetPath);
                migrated++;
            } else {
                skipped++;
            }
            reconcileStockAllocations(db, targetPath);
        } catch (err) {
            errored++;
            console.error(`[Migration] Failed to migrate ${file}:`, err.message);
        }
    }
    console.log(`[Migration] Sandbox startup sweep: ${migrated} migrated, ${skipped} already current, ${errored} errored (of ${sandboxFiles.length} total).`);
};

// Periodic eviction of expired discoveryCache entries (TTL is 30s inside the route;
// we sweep every 60s to keep the Map bounded regardless of how many users log in).
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of discoveryCache) {
        if (!entry || now >= entry.expiresAt) discoveryCache.delete(key);
    }
}, 60000).unref();

(async () => {
    // 1. Hydrate the live database from Turso Cloud (strict mode, TURSO_ENABLED env or the Settings switch).
    //    Failure or a remote below the floor -> read-only mode instead of an empty start.
    await pullFromTursoOnStartup();

    // 2. Startup data repairs on the hydrated live DB (skipped while read-only)
    runStartupRepairs();

    // 3. Perform DB schema migrations locally
    migrateAllSandboxesOnStartup();

    // 3b. Strict: check Dropbox (reachability, local-only upload files) in the background; never blocks the start.
    if (STRICT_REMOTE.on) checkDropboxRemote('boot').catch(() => {});

    const ph = persistenceHealth();
    console.log(`[Persistence] strict=${ph.strict.on ? 'on' : 'off'} (by ${ph.strict.by}) remoteLoaded=${ph.strict.remoteLoaded} dropbox: enabled=${ph.dropbox.enabled} configured=${ph.dropbox.configured}`);
    console.log(`[Persistence] v${ph.appVersion} schema ${ph.dbSchemaVersion}/${ph.currentSchemaVersion} source=${ph.dataSource} turso=${ph.turso.enabled ? 'on' : 'off'} (by ${ph.turso.enabledBy}) readOnly=${ph.readOnly}${ph.readOnly ? ` (${ph.readOnlyReason})` : ''} records: orders=${ph.counts?.orders ?? 0} users=${ph.counts?.users ?? 0} customers=${ph.counts?.customers ?? 0} suppliers=${ph.counts?.suppliers ?? 0} supplierPayments=${ph.counts?.supplierPayments ?? 0} total=${ph.counts?.total ?? 0}`);
    
    // 4. Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Backend] Running exclusively on http://localhost:${PORT}`);
        runThresholdAudit().catch(err => console.error('[Audit] Unhandled error in initial audit:', err));
        setInterval(() => {
            runThresholdAudit().catch(err => console.error('[Audit] Unhandled error in interval audit:', err));
        }, 60000);
    });
})();
