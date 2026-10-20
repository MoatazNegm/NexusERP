
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

const isStockOrder = (order) => {
    if (!order) return false;
    const cust = String(order.customerName || '').trim().toLowerCase();
    const po = typeof order.customerReferenceNumber === 'string' ? order.customerReferenceNumber.trim().toUpperCase() : '';
    return cust === 'internal stock' || po.startsWith('STOCK-');
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

const saveBase64CostSheetToFile = (base64String, req = null) => {
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
    if (statuses.every(s => ['RESERVED', 'RECEIVED', 'CANCELLED', 'ORDERED_FOR_STOCK'].includes(s))) return 'WAITING_FACTORY';
    // If any are actively being manufactured
    if (statuses.some(s => s === 'IN_MANUFACTURING')) return 'MANUFACTURING';
    // If all are manufactured
    if (statuses.every(s => ['MANUFACTURED', 'CANCELLED'].includes(s))) return 'MANUFACTURED';
    return 'MIXED';
};

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
    const safeRate = (Number.isFinite(Number(order.conversionRate)) && Number(order.conversionRate) > 0) ? Number(order.conversionRate) : 1;
    // R22 (C23): costs are L.E.; convert the revenue side only.
    const totalCostInOrderCurrency = totalCost;
    const totalRevenueLE = totalRevenue * safeRate;

    const markupPct = totalCostInOrderCurrency > 0 ? ((totalRevenueLE - totalCostInOrderCurrency) / totalCostInOrderCurrency) * 100 : (totalRevenueLE > 0 ? 100 : 0);
    if (order.marginReleasedSig && order.marginReleasedSig === marginReleaseSig(order.items, minMargin, order.conversionRate)) return true;
    return markupPct >= minMargin;
};

const isOrderFullyPaid = (order) => {
    if (!order.payments) return false;
    const totalPaid = order.payments.reduce((s, p) => s + (p.amount || 0), 0);
    let revenue = 0;
    (order.items || []).forEach(it => {
        revenue += ((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100)));
    });

    let targetRevenue = revenue;
    if (order.appliesWithholdingTax) {
        targetRevenue = revenue * 0.99; // Deduct 1% WHT
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

const pushToTursoAsync = async (data, dbPath) => {
    try {
        const isLive = (dbPath === DB_PATH);
        const settingsList = data.settings || [];
        const settings = settingsList[0] ? decryptSettings(settingsList[0]) : null;
        
        const rawUrl = (settings && settings.tursoUrl && String(settings.tursoUrl).trim()) || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL;
        const authToken = (settings && settings.tursoAuthToken && String(settings.tursoAuthToken).trim()) || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken();
        const useTurso = (settings && settings.useTurso !== undefined && settings.tursoUrl) ? !!settings.useTurso : false;

        if (useTurso && rawUrl && authToken) {
            const targetId = isLive ? 'live' : 'sandbox.' + path.basename(dbPath).replace('db.sandbox.', '').replace('.json', '');
            
            const dbUrl = rawUrl.startsWith('libsql://') 
              ? rawUrl.replace(/^libsql:\/\//, 'https://') 
              : rawUrl;
              
            const client = createClient({ url: dbUrl, authToken });
            await client.execute(`CREATE TABLE IF NOT EXISTS nexus_state (id TEXT PRIMARY KEY, json_data TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            await client.execute({
                sql: `INSERT INTO nexus_state (id, json_data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json_data=excluded.json_data, updated_at=CURRENT_TIMESTAMP`,
                args: [targetId, JSON.stringify(data)]
            });
            console.log(`[Turso] Successfully synced ${targetId} to cloud DB.`);
        }
    } catch (e) {
        console.error(`[Turso Sync Error on ${dbPath}]`, e.message);
    }
};

const pullFromTursoOnStartup = async () => {
    try {
        let settings = null;
        let localDb = null;
        if (fs.existsSync(DB_PATH)) {
            try {
                localDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
                const settingsList = localDb.settings || [];
                settings = settingsList[0] ? decryptSettings(settingsList[0]) : null;
            } catch (err) {}
        }
        
        const rawUrl = (settings && settings.tursoUrl && String(settings.tursoUrl).trim()) || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL;
        const authToken = (settings && settings.tursoAuthToken && String(settings.tursoAuthToken).trim()) || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken();
        const useTurso = (settings && settings.useTurso !== undefined && settings.tursoUrl) ? !!settings.useTurso : false;

        if (useTurso && rawUrl && authToken) {
            console.log("[Turso] Cloud Sync enabled. Checking latest data from cloud on startup...");
            const dbUrl = rawUrl.startsWith('libsql://') 
              ? rawUrl.replace(/^libsql:\/\//, 'https://') 
              : rawUrl;
              
            const client = createClient({ url: dbUrl, authToken });
            await client.execute(`CREATE TABLE IF NOT EXISTS nexus_state (id TEXT PRIMARY KEY, json_data TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            
            const res = await client.execute({ sql: `SELECT json_data FROM nexus_state WHERE id = ?`, args: ['live'] });
            if (res.rows.length > 0 && res.rows[0].json_data) {
                try {
                    const remoteData = JSON.parse(res.rows[0].json_data);
                    const localOrdersCount = (localDb?.orders || []).length;
                    const remoteOrdersCount = (remoteData?.orders || []).length;
                    if (remoteOrdersCount >= localOrdersCount || !localDb || localOrdersCount === 0) {
                        fs.writeFileSync(DB_PATH, res.rows[0].json_data, 'utf8');
                        console.log(`[Turso] Live database successfully restored from cloud (${remoteOrdersCount} orders).`);
                    } else {
                        console.log(`[Turso] Local database has more orders (${localOrdersCount}) than cloud (${remoteOrdersCount}). Preserving local data and syncing to cloud.`);
                        pushToTursoAsync(localDb, DB_PATH);
                    }
                } catch (parseErr) {
                    fs.writeFileSync(DB_PATH, res.rows[0].json_data, 'utf8');
                }
            }
            
            const allRes = await client.execute(`SELECT id, json_data FROM nexus_state WHERE id LIKE 'sandbox.%'`);
            const cloudSbIds = new Set();
            for (const row of allRes.rows) {
                if (row.id && row.json_data) {
                    cloudSbIds.add(row.id);
                    const sbOwner = row.id.replace(/^sandbox\./, '');
                    const sbPath = path.join(__dirname, `db.sandbox.${sbOwner}.json`);
                    try {
                        const localExists = fs.existsSync(sbPath);
                        if (!localExists) {
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
                        pushToTursoAsync(localSbData, path.join(__dirname, file));
                        console.log(`[Turso] Pushed missing local sandbox ${targetId} to cloud.`);
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        console.error("[Turso] Startup pull failed:", e.message);
    }
};

const writeDb = (data, customPath = null) => {
  const targetPath = customPath || DB_PATH;
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
    
    // Trigger background sync to cloud
    pushToTursoAsync(data, targetPath).catch(() => {});

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
const ACTION_ROLE_GATES = {
  'toggle-acceptance': { roles: ['planning'], msg: 'technical review is for tech1/planner1' },
  'finalize-study': { roles: ['planning'], msg: 'technical review is for tech1/planner1' },
  'send-rfp-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'award-tender-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'issue-po-batch': { roles: ['procurement', 'sourcing'], msg: 'procurement role required' },
  'receive-component': { roles: ['inventory', 'warehouse', 'sourcing', 'logistics'], msg: 'reception is for inv1' },
  'receive-hub-partial': { roles: ['inventory', 'warehouse', 'sourcing', 'logistics'], msg: 'reception is for inv1' },
  'issue-invoice': { roles: ['finance'], msg: 'invoicing is finance' },
  'record-payment': { roles: ['finance'], msg: 'wrong role: payments are finance' },
  'approve-dispatch-receipt': { roles: ['finance'], msg: 'wrong role: dispatch receipt approval is finance' },
  'reject-order': { roles: ['order_management', 'planning', 'sales'], msg: 'no permission to cancel / delete' },
  'hard-delete-order': { roles: [], msg: 'no permission to cancel / delete' },
};
const actionRoleDenied = (req, action) => {
  const gate = ACTION_ROLE_GATES[action];
  const roles = req.roles || [];
  if (!gate || roles.length === 0) return null;
  if (roles.includes('admin') || roles.includes('management')) return null;
  if (roles.some(r => gate.roles.includes(r))) return null;
  return 'refused: ' + gate.msg;
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
    const enabled = (raw.enabled !== undefined && (raw.refreshToken && String(raw.refreshToken).trim())) ? !!raw.enabled : true;
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
        refreshToken: cfg.refreshToken
    });
};

const testDropboxConnection = async (appKey, appSecret, refreshToken) => {
    const dbx = new Dropbox({ clientId: appKey, clientSecret: appSecret, refreshToken });
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

    // 2. Reconcile stock orders
    db.orders.forEach(order => {
        const isStock = isStockOrder(order);
        if (!isStock) return;

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
        nextStatus = evaluateMarginStatus(order.items, newMinMargin, oldStatus || OrderStatus.LOGGED, order.conversionRate, isBlanket, isStock, order.marginReleasedSig);

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
                } else if (comp.inventoryItemId && comp.source === 'PROCUREMENT' && !isStockOrder(order) && (comp.receivedQty || 0) > 0 && !['CANCELLED', 'ORDERED_FOR_STOCK', 'Manufactured'].includes(comp.status)) {
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
            if (comp.status === 'RECEIVED' && oldStatus !== 'RECEIVED' && comp.inventoryItemId) {
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
                        if (isOrderApproved && comp.noRfpNeeded && (comp.status === 'PENDING_OFFER' || !comp.status || comp.status === 'NEW')) {
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
        nextStatus = evaluateMarginStatus(order.items, minMargin, order.status || OrderStatus.LOGGED, order.conversionRate, isBlanket, isStock, order.marginReleasedSig);

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
                            ['RESERVED', 'RECEIVED', 'IN_STOCK'].includes(comp.status) ||
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
                    if (!anyNeedsRfp && order.status === OrderStatus.WAITING_SUPPLIERS) {
                        const old = order.status;
                        order.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                        order.logs.push(createAuditLog(`[AUTO] Outsourcing contract active. Status moved from ${old} to ${order.status}`, order.status, 'System'));
                    } else if (anyNeedsRfp && order.status === OrderStatus.RUNNING_OUTSOURCING_CONTRACT) {
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

    const serveFromDisk = (absPath) => {
        if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
            res.sendFile(absPath);
            return true;
        }
        return false;
    };

    const serveFromDropbox = async (relPath, localCachePath) => {
        try {
            const db = getDb(req);
            const settings = resolveSettings(db);
            if (isDropboxConfigured(settings)) {
                const stream = await downloadFileStreamFromDropbox({ settings, relativePath: relPath });
                if (stream) {
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
        if (serveFromDisk(sbLocalPath)) return;
        if (await serveFromDropbox(rawPath, sbLocalPath)) return;

        // COW Fallback: file was not modified in sandbox, serve baseline original!
        const baselineSubPath = sbMatch[2];
        const baselineLocalPath = path.join(UPLOADS_BASE, baselineSubPath);
        if (serveFromDisk(baselineLocalPath)) return;
        if (await serveFromDropbox(baselineSubPath, baselineLocalPath)) return;

        return res.status(404).json({ error: 'File not found' });
    }

    // 2. If request is from a sandbox user and requests a non-sandbox path, check if sandbox has an amended version
    if (req.sandboxOwner) {
        const sbRelPath = `sandbox/${sanitizeUsername(req.sandboxOwner)}/${rawPath}`;
        const sbLocalPath = path.join(UPLOADS_BASE, sbRelPath);
        if (serveFromDisk(sbLocalPath)) return;
        if (await serveFromDropbox(sbRelPath, sbLocalPath)) return;
    }

    // 3. Standard live path check
    const localFilePath = path.join(UPLOADS_BASE, rawPath);
    if (serveFromDisk(localFilePath)) return;
    if (await serveFromDropbox(rawPath, localFilePath)) return;

    return res.status(404).json({ error: 'File not found' });
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
    const refs = [order.id, order.internalOrderNumber].filter(Boolean);
    const calls = orders.filter(o => o.blanketContractId && refs.includes(o.blanketContractId) && o.status !== OrderStatus.REJECTED);
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

// --- CUSTOMER WALLET HELPER ---
// Calculates customer wallet balances (per-project and aggregate total).
// Blanket orders where the customer has not been invoiced or has not paid yet
// generate a negative wallet balance (debt: paid - commitment) until paid/settled.
// Rejected orders are strictly ignored and must never affect wallets.
const computeCustomerWallet = (customer, orders = []) => {
    if (!customer) return customer;

    // Collect all valid project names from non-rejected blanket orders across all orders
    const validProjects = new Set();
    orders.forEach(o => {
        if (o.status === OrderStatus.REJECTED) return;
        if (o.blanketOrder || o.contractId || o.blanketContractId) {
            let proj = String((o.projectName || '').trim());
            if (!proj && o.blanketContractId) {
                const parent = orders.find(p => (p.id === o.blanketContractId || p.internalOrderNumber === o.blanketContractId || p.customerReferenceNumber === o.blanketContractId) && p.status !== OrderStatus.REJECTED);
                if (parent && parent.projectName) proj = String(parent.projectName).trim();
            }
            if (proj) validProjects.add(proj);
        }
    });

    const projectBalances = {};
    if (customer.walletBalances) {
        Object.entries(customer.walletBalances).forEach(([proj, bal]) => {
            const trimmed = proj.trim();
            if (validProjects.has(trimmed) || trimmed.startsWith('(') || !validProjects.size) {
                projectBalances[trimmed] = Number(bal) || 0;
            }
        });
    }

    // Active blanket orders for this customer (strictly not rejected)
    const custBlanketOrders = orders.filter(o =>
        o.customerName === customer.name &&
        Boolean(o.blanketOrder || o.contractId || o.blanketContractId) &&
        o.status !== OrderStatus.REJECTED
    );

    custBlanketOrders.forEach(o => {
        // If the blanket order is fulfilled/settled, its settlement difference is already in projectBalances
        if (o.status === OrderStatus.FULFILLED) return;
        // Call-off (settling) orders of a blanket contract add nothing to the wallet: the open
        // blanket commitment already covers them, and any excess is a receivable, not wallet debt.
        if (o.blanketContractId && !o.blanketOrder) return;

        let orderGross = 0;
        let orderCost = 0;
        (o.items || []).forEach(it => {
            orderGross += (getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
            (it.components || []).forEach(c => {
                orderCost += (c.quantity || 0) * (c.unitCost || 0);
            });
        });
        if (o.appliesWithholdingTax) orderGross *= 0.99;

        const paid = (o.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
        const commitment = orderGross > 0 ? orderGross : orderCost;

        // When not invoiced or not fully paid, customer owes the unpaid amount (negative wallet / debt)
        if (commitment > 0) {
            const balanceDelta = paid - commitment; // Negative if paid < commitment (debt)
            let proj = String((o.projectName || '').trim());
            if (!proj && o.blanketContractId) {
                const parent = orders.find(p => (p.id === o.blanketContractId || p.internalOrderNumber === o.blanketContractId || p.customerReferenceNumber === o.blanketContractId) && p.status !== OrderStatus.REJECTED);
                if (parent && parent.projectName) proj = String(parent.projectName).trim();
            }
            const projectKey = proj || '(No Project)';
            projectBalances[projectKey] = (projectBalances[projectKey] || 0) + balanceDelta;
        }
    });

    const totalBalance = Object.values(projectBalances).reduce((sum, val) => sum + (Number(val) || 0), 0);
    return {
        ...customer,
        walletBalance: Math.round(totalBalance * 100) / 100,
        walletBalances: projectBalances
    };
};

// --- ORDER WALLET HELPER ---
// Wallet of a single order: what the customer committed to (gross), what was paid, the balance
// (paid - committed, negative = debt) and any settlement credit/debit from settled call-offs.
// Rejected orders and call-offs of a blanket contract carry no wallet of their own.
const computeOrderWallet = (order, orders = []) => {
    if (!order) return null;
    let gross = 0, cost = 0;
    (order.items || []).forEach(it => {
        gross += (getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
        (it.components || []).forEach(c => { cost += (c.quantity || 0) * (c.unitCost || 0); });
    });
    if (order.appliesWithholdingTax) gross *= 0.99;
    const paid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const commitment = gross > 0 ? gross : cost;
    const settlement = Object.values(order.settledCallOffs || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const isCallOff = Boolean(order.blanketContractId) && !order.blanketOrder;
    const rejected = order.status === OrderStatus.REJECTED;
    let projectName = String((order.projectName || '').trim());
    if (!projectName && order.blanketContractId) {
        const parent = orders.find(p => (p.id === order.blanketContractId || p.internalOrderNumber === order.blanketContractId || p.customerReferenceNumber === order.blanketContractId) && p.status !== OrderStatus.REJECTED);
        if (parent && parent.projectName) projectName = String(parent.projectName).trim();
    }
    const r = x => Math.round(x * 100) / 100;
    return {
        orderId: order.id,
        internalOrderNumber: order.internalOrderNumber,
        customerName: order.customerName,
        projectName: projectName || '(No Project)',
        status: order.status,
        blanketOrder: Boolean(order.blanketOrder),
        callOffOf: isCallOff ? order.blanketContractId : undefined,
        committed: rejected || isCallOff ? 0 : r(commitment),
        paid: rejected ? 0 : r(paid),
        settlement: r(settlement),
        walletBalance: rejected || isCallOff ? 0 : r(paid - commitment + settlement)
    };
};

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
const getCollection = (col) => (req, res) => {
    const db = getDb(req);
    if (col === 'users') return res.json((db[col] || []).map(({ password, ...u }) => u));

    if (col === 'customers') {
        const orders = db.orders || [];
        return res.json((db[col] || []).map(c => computeCustomerWallet(c, orders)));
    }

    if (col === 'orders') {
        const settings = resolveSettings(db, isSandbox(req));
        const allOrders = db[col] || [];
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
        return res.json(computeCustomerWallet(item, db.orders || []));
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

const addToCollection = (col) => (req, res) => {
    const db = getDb(req);
    if (!db[col]) db[col] = [];

    let newItem = { id: `${col}_${Date.now()}`, ...req.body };
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
            const blanket = db.orders.find(o =>
                o.id === blanketRef || o.internalOrderNumber === blanketRef
            );
            if (blanket && !blanket.blanketOrder) {
                return res.status(400).json({ error: `Blanket contract "${blanketRef}" is not a blanket order.` });
            }
            if (!blanket) {
                return res.status(400).json({ error: `Blanket contract "${blanketRef}" not found.` });
            }
            newItem.logs = newItem.logs || [];
            newItem.logs.push(createAuditLog(`Settling order linked to blanket contract ${blanket.internalOrderNumber || blanketRef}. Finance will receive this order automatically.`, OrderStatus.LOGGED, user));
        }
        newItem = processedOrderInternal(newItem, db, user, true, null);
        reconcileInventory(null, newItem, db);
    }

    if (['customers', 'suppliers', 'inventory', 'users', 'userGroups', 'settings'].includes(col)) {
        if (!newItem.logs) newItem.logs = [createAuditLog('Entity registered', undefined, user)];
        if (col === 'suppliers' && !newItem.priceList) newItem.priceList = [];
    }

    if (col === 'ledger') {
        // If an addition entry is assigned to a specific PO, reflect it into the order's payments
        if (newItem.type === 'ADDITION' && (newItem.orderId || newItem.poNumber)) {
            const targetOrder = (db.orders || []).find(o =>
                (newItem.orderId && o.id === newItem.orderId) ||
                (newItem.poNumber && (
                    String(o.customerReferenceNumber || '').trim().toLowerCase() === String(newItem.poNumber).trim().toLowerCase() ||
                    String(o.internalOrderNumber || '').trim().toLowerCase() === String(newItem.poNumber).trim().toLowerCase()
                ))
            );

            if (targetOrder) {
                if (!targetOrder.payments) targetOrder.payments = [];
                const paymentIndex = targetOrder.payments.length + 1;
                const timestamp = Date.now().toString().slice(-4);
                const orderShortId = (targetOrder.internalOrderNumber || targetOrder.id).replace(/[^\w]/g, '').slice(-6);
                const receiptNumber = newItem.receiptNumber || `RCV-${orderShortId}-${String(paymentIndex).padStart(2, '0')}-${timestamp}`;
                const paymentAmt = Number(newItem.amount) || 0;

                targetOrder.payments.push({
                    amount: paymentAmt,
                    date: newItem.date || new Date().toISOString(),
                    user: user || 'System',
                    memo: newItem.description || `Ledger Entry Payment (${newItem.toAccount || 'General Ledger'})`,
                    receiptNumber,
                    ledgerEntryId: newItem.id
                });

                if (!targetOrder.history) targetOrder.history = [];
                targetOrder.history.push({
                    timestamp: new Date().toISOString(),
                    message: `Payment from Ledger Entry: ${paymentAmt.toLocaleString()} L.E. - ${newItem.description || ''}`,
                    status: targetOrder.status,
                    user: user || 'System',
                    type: 'payment',
                    amount: paymentAmt,
                    receiptNumber
                });

                const settings = resolveSettings(db, isSandbox(req));
                const orderIdx = db.orders.findIndex(o => o.id === targetOrder.id);
                if (orderIdx !== -1) {
                    db.orders[orderIdx] = calculateOrderHealth(targetOrder, settings);
                }
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
    let updated = { ...oldItem, ...req.body };
    if (col === 'orders' && req.body.orderDate !== undefined && req.body.orderDate !== null && req.body.orderDate !== '' && isNaN(new Date(req.body.orderDate).getTime())) {
        return res.status(400).json({ error: 'Invalid orderDate.' });
    }

    if (col === 'orders' && req.body.items !== undefined && !(updated.blanketOrder || updated.contractId || updated.blanketContractId)) {
        // R23 (C18): a normal PO takes whole quantities only; blanket orders and their call-offs may carry fractions.
        const badQ = (updated.items || []).map(i => Number(i.quantity)).find(q => Number.isFinite(q) && Math.abs(q - Math.round(q)) > 1e-9);
        if (badQ !== undefined) return res.status(400).json({ error: `Rejected: fraction ${badQ} is not allowed on a normal order (whole units only).` });
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
    let list = orders.map(o => computeOrderWallet(o, orders));
    if (customerName) list = list.filter(w => w.customerName === customerName);
    if (projectName) list = list.filter(w => w.projectName === String(projectName).trim());
    res.json(list);
});

app.get('/api/v1/orders/:id/wallet', (req, res) => {
    const db = getDb(req);
    const orders = db.orders || [];
    const order = orders.find(o => o.id === req.params.id || o.internalOrderNumber === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(computeOrderWallet(order, orders));
});

app.get('/api/v1/project-wallets', (req, res) => {
    const db = getDb(req);
    const orders = db.orders || [];
    const customers = (db.customers || []).map(c => computeCustomerWallet(c, orders));
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
                        const parent = orders.find(p => (p.id === o.blanketContractId || p.internalOrderNumber === o.blanketContractId || p.customerReferenceNumber === o.blanketContractId) && p.status !== OrderStatus.REJECTED);
                        if (parent && parent.projectName) ordProj = String(parent.projectName).trim();
                    }
                    return isBlanket && ordProj === trimmed;
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

        // Audit log for primary customer
        if (!primary.logs) primary.logs = [];
        primary.logs.push(createAuditLog(`Merged ${deletedIds.length} duplicate records. Migrated ${ordersMigrated} orders.`, undefined, user));

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

app.post('/api/v1/customers/:id/wallet-transfer', (req, res) => {
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
                return { t, order: o, ref: o.internalOrderNumber };
            }
            throw new Error(`Unknown account type ${a.type}`);
        };
        const src = find(from), dst = find(to);
        if (src.t === dst.t && (src.key || src.order?.id) === (dst.key || dst.order?.id)) return res.status(400).json({ error: "Source and target accounts are the same" });
        // source balance check
        if (src.t === 'ORDER') {
            const paid = (src.order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
            if (paid + 0.005 < amt) return res.status(400).json({ error: `Insufficient balance: order ${src.ref} holds ${paid.toFixed(2)}, transfer ${amt.toFixed(2)}` });
        } else if ((customer.walletBalances[src.key] || 0) + 0.005 < amt) {
            return res.status(400).json({ error: `Insufficient balance: account holds ${(customer.walletBalances[src.key] || 0).toFixed(2)}, transfer ${amt.toFixed(2)}` });
        }
        const now = new Date().toISOString();
        const note = `Account transfer ${amt.toFixed(2)}: ${acctLabel(customer.name, src.t, src.ref)} -> ${acctLabel(customer.name, dst.t, dst.ref)}${memo ? ' - ' + memo : ''}`;
        const touchOrder = (o, delta) => {
            o.payments = o.payments || [];
            o.payments.push({ amount: delta, date: now, user, memo: note, receiptNumber: `TRF-${String(Date.now()).slice(-6)}`, transfer: true });
            o.logs = o.logs || [];
            o.logs.push(createAuditLog(note, o.status, user));
        };
        let walletDelta = 0;
        if (src.t === 'ORDER') touchOrder(src.order, -amt); else { customer.walletBalances[src.key] = Math.round(((customer.walletBalances[src.key] || 0) - amt) * 100) / 100; walletDelta -= amt; }
        if (dst.t === 'ORDER') touchOrder(dst.order, amt); else { customer.walletBalances[dst.key] = Math.round(((customer.walletBalances[dst.key] || 0) + amt) * 100) / 100; walletDelta += amt; }
        customer.walletBalance = Math.round(((customer.walletBalance || 0) + walletDelta) * 100) / 100;
        customer.logs = customer.logs || [];
        customer.logs.push(createAuditLog(note, 'WALLET_TRANSFER', user));
        ledgerPush(db, { type: 'TRANSFER', amount: amt, description: note, category: 'Account Transfer', fromAccount: acctLabel(customer.name, src.t, src.ref), toAccount: acctLabel(customer.name, dst.t, dst.ref), customerName: customer.name }, user);
        writeDb(db, getDbPath(req));
        return res.json({ ok: true, amount: amt, from: acctLabel(customer.name, src.t, src.ref), to: acctLabel(customer.name, dst.t, dst.ref), wallet: computeCustomerWallet(customer, db.orders || []) });
    } catch (err) {
        res.status(400).json({ error: err.message || "Transfer failed" });
    }
});

// Record customer advance deposit / unearned prepayment for future orders
app.post('/api/v1/customers/:id/advance-payment', (req, res) => {
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
        return res.json(computeCustomerWallet(customer, db.orders || []));
    } catch (err) {
        res.status(500).json({ error: err.message || "Failed to record customer advance payment" });
    }
});

// R23 (C17): REFUND - the ledger user pays the customer's general-wallet credit out to the customer (wallet -> Bank).
// No sale was recognised on an advance, so no revenue/expense account is involved.
app.post('/api/v1/customers/:id/refund', (req, res) => {
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
        if (bal + 0.005 < amt) return res.status(400).json({ error: `Insufficient general wallet credit: ${bal.toFixed(2)}, refund ${amt.toFixed(2)}` });
        const ord = orderId ? (db.orders || []).find(o => o.id === orderId || o.internalOrderNumber === orderId) : null;
        customer.walletBalances[SELF_WALLET_KEY] = Math.round((bal - amt) * 100) / 100;
        ledgerPush(db, { type: 'REFUND', amount: amt, description: `Customer Refund: ${customer.name}${ord ? ` - PO ${ord.internalOrderNumber}` : ''} - ${memo || 'Refund of general wallet credit'}`, category: 'Customer Refunds', fromAccount: acctLabel(customer.name, 'SELF', 'Self'), toAccount: 'Bank Account', customerName: customer.name, orderId: ord ? ord.id : undefined, poNumber: ord ? ord.internalOrderNumber : undefined }, user);
        writeDb(db, getDbPath(req));
        return res.json(computeCustomerWallet(customer, db.orders || []));
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
        const rec = { id: `sp_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`, supplierId, supplierName: supplier.name, amount: -amt, isRefund: true, date: date ? new Date(date).toISOString() : new Date().toISOString(), memo: memo || 'Supplier refund received', user, orderId: orderId || undefined, poNumber: poNumber || undefined, unallocatedAdvance: -amt, allocations: [] };
        if (!db.supplierPayments) db.supplierPayments = [];
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

    const item = req.body;
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

    const oldItem = order.items[itemIdx];
    if (req.body.quantity !== undefined && !(order.blanketOrder || order.contractId || order.blanketContractId)) {
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
        res.json(computeCustomerWallet(customer, db.orders || []));
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
            (o.projectName && o.projectName.toLowerCase().includes(q))
        );
    }

    const settings = resolveSettings(db, isSandbox(req));
    const enrichedOrders = orders.map(o => calculateOrderHealth(o, settings));
    // Revenue (net) and real cost are computed from the lines; only FULFILLED orders count.
    enrichedOrders.forEach(o => {
        let net = 0, cost = 0;
        (o.items || []).forEach(it => {
            net += r2c((getItemEffectiveQty(it) || 0) * (it.pricePerUnit || 0));
            (it.components || []).forEach(c => { cost += (Number(c.unitCost) || 0) * (Number(c.quantity) || Number(c.receivedQty) || Number(c.consumedQty) || (c.source === 'CONSUMED' ? (Number(getItemEffectiveQty(it)) || 0) : 0)); });
        });
        // CX11 (R22): revenue of a foreign-currency order is converted to L.E. at the order's own rate; costs are L.E. already.
        const fxRate = (o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1;
        o.totalPriceOrderCurrency = r2c(net);
        o.totalPrice = r2c(net * fxRate);
        o.totalRealCost = r2c(cost);
        // CX12: a cancelled (rejected) order carries no revenue and no cost in the report rows.
        if (o.status === OrderStatus.REJECTED) { o.totalPrice = 0; o.totalPriceOrderCurrency = 0; o.totalRealCost = 0; }
    });
    // R29: a blanket contract counts as current in the report; its revenue and cost follow PAID money (not fulfilment).
    // Revenue = customer payments received on the contract; cost = supplier payments for the contract and its call-offs
    // (plus ledger expenses booked to them). The call-offs carry no revenue/cost of their own in the totals.
    const isBlanketRoot = (o) => Boolean(o.blanketOrder) && !o.blanketContractId;
    const blanketIdsOf = (root) => (db.orders || []).filter(x => x.id === root.id || (x.blanketContractId && (x.blanketContractId === root.internalOrderNumber || x.blanketContractId === root.id || x.blanketContractId === root.customerReferenceNumber))).map(x => x.id);
    enrichedOrders.forEach(o => {
        if (o.status === OrderStatus.REJECTED) return;
        if (isBlanketRoot(o)) {
            const ids = new Set(blanketIdsOf(o));
            const rev = (db.orders || []).filter(x => ids.has(x.id)).reduce((t, x) => t + (x.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0);
            let cost = 0;
            const grp = (db.orders || []).filter(x => ids.has(x.id));
            const compIds = new Set(), poNums = new Set();
            grp.forEach(x => (x.items || []).forEach(it => (it.components || []).forEach(c => { if (c.id) compIds.add(c.id); if (c.poNumber) poNums.add(c.poNumber); })));
            // company payments to the PO financial account (supplier payments of the contract and its call-offs)
            (db.supplierPayments || []).forEach(sp => { if (ids.has(sp.orderId) || (sp.poNumber && poNums.has(sp.poNumber)) || (sp.allocations || []).some(al => compIds.has(al.componentId))) cost += Number(sp.amount) || 0; });
            // plus company payments from other general accounts booked to the contract (salaries, transportation, ...)
            (db.ledger || []).forEach(l => { if ((l.type === 'COST' || l.type === 'EXPENSE') && l.category !== 'Supplier Payment' && ids.has(l.orderId)) cost += Number(l.amount) || 0; });
            o.totalPrice = r2c(rev); o.totalPriceOrderCurrency = r2c(rev); o.totalRealCost = r2c(cost); o.reportBasis = 'PAID';
        } else if (o.blanketContractId) { o.totalPrice = 0; o.totalPriceOrderCurrency = 0; o.totalRealCost = 0; o.reportBasis = 'BLANKET_CALL_OFF'; }
    });
    const fulfilledOrders = enrichedOrders.filter(o => o.status === OrderStatus.FULFILLED || o.reportBasis === 'PAID');
    const totalRevenue = r2c(fulfilledOrders.reduce((sum, o) => sum + (Number(o.totalPrice) || 0), 0));
    const totalRealCost = r2c(fulfilledOrders.reduce((sum, o) => sum + (Number(o.totalRealCost) || 0), 0));
    const count = enrichedOrders.length;

    res.json({
        count,
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

const COLLECTIONS = ['customers', 'orders', 'inventory', 'suppliers', 'procurement', 'userGroups', 'users', 'notifications', 'settings', 'modules', 'ledger', 'contracts'];
COLLECTIONS.forEach(col => {
    app.get(`/api/v1/${col}`, getCollection(col));
    app.get(`/api/v1/${col}/:id`, getItemFromCollection(col));
    app.post(`/api/v1/${col}`, addToCollection(col));
    app.put(`/api/v1/${col}/:id`, updateInCollection(col));
});

app.post('/api/v1/wipe', (req, res) => {
  if (isSandbox(req)) return res.status(400).json({ error: "Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset." });
  const db = getDb(req);
  db.orders = []; db.customers = []; db.inventory = []; db.notifications = []; db.contracts = []; db.supplierPayments = [];
  if (writeDb(db, getDbPath(req))) res.json({ message: "Live wipe successful" });
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
            const hubQty = Number(item.hubReceivedQty) || 0;
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

                const receivedQty = Number(comp.receivedQty) || (['RECEIVED', 'RESERVED'].includes(comp.status) ? Number(comp.quantity) || 0 : 0);
                if (receivedQty > 0) {
                    let invItem = db.inventory.find(i => i.id === comp.inventoryItemId);
                    if (!invItem) {
                        invItem = db.inventory.find(i => (i.sku && comp.componentNumber && i.sku.toLowerCase() === comp.componentNumber.toLowerCase()) || (i.description && comp.description && i.description.toLowerCase() === comp.description.toLowerCase()));
                    }

                    if (invItem) {
                        // Release customer reservation
                        invItem.quantityReserved = Math.max(0, (invItem.quantityReserved || 0) - receivedQty);
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
                if (!allocFound && (!sp.allocations || sp.allocations.length === 0) && sp.orderId === order.id && (sp.poNumber === targetComp.poNumber || !sp.poNumber)) {
                    paid += (sp.amount || 0);
                }
            }
        });
        return Math.round(paid * 100) / 100;
    };

    // Helper: Execute Case 1 (Standard PO Cancel) or Case 2 (PO Extension & Amendment)
    const executeComponentPoCancelOrExtension = (item, comp, cancelReason, isExtension) => {
        const originalQty = comp.quantity || 0;
        const receivedQty = comp.receivedQty || 0;
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
            const calculatedNewPoQty = Math.max(receivedQty, Math.floor(paidUnits + 1e-9));
            const newPoQty = Math.min(originalQty, calculatedNewPoQty);
            const leftoverQty = Math.max(0, originalQty - newPoQty);

            const oldPoNumber = comp.poNumber || 'N/A';
            comp.originalPoQuantity = originalQty;
            comp.quantity = newPoQty;
            comp.isExtension = true;
            comp.supersededOriginalPo = true;
            comp.supersededPoNumber = oldPoNumber;
            comp.extensionReason = cancelReason;
            comp.extendedAt = new Date().toISOString();
            comp.statusUpdatedAt = new Date().toISOString();

            if (receivedQty >= newPoQty) {
                comp.status = isStockOrder(order) ? 'RECEIVED' : (item.productionType === 'TRADING' ? 'Manufactured' : 'RESERVED');
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
                `PO ${oldPoNumber} amended via extension: ${comp.description} adjusted from ${originalQty} to ${newPoQty} units (superseding original PO). ${leftoverQty > 0.0001 ? `Remaining ${leftoverQty} units returned to Procurement (PENDING_OFFER). ` : ''}Reason: ${cancelReason}`,
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
        // R23 (C18): a normal PO takes whole quantities only; blanket orders (and their call-offs) may carry fractions.
        {
            const qtyActions = ['receive-component', 'receive-hub-partial', 'approve-dispatch-receipt', 'release-delivery', 'ship-items', 'confirm-delivery', 'register-manufacturing'];
            const isBlanketLike = Boolean(order.blanketOrder || order.contractId || order.blanketContractId);
            if (qtyActions.includes(action) && !isBlanketLike && payload) {
                const qs = [];
                if (payload.qty !== undefined) qs.push(payload.qty);
                (payload.items || []).forEach(x => x && x.qty !== undefined && qs.push(x.qty));
                (payload.receipts || []).forEach(x => x && x.qty !== undefined && qs.push(x.qty));
                const bad = qs.find(q => Number.isFinite(Number(q)) && Math.abs(Number(q) - Math.round(Number(q))) > 1e-9);
                if (bad !== undefined) throw new Error(`Fractional quantity ${bad} is not allowed on a normal PO (whole units only).`);
            }
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
                            if (comp.noRfpNeeded && ['NEW', 'PENDING_OFFER'].includes(comp.status)) {
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

                if (!anyNeedsRfp && anyRunningOutsourcing) {
                    order.status = OrderStatus.RUNNING_OUTSOURCING_CONTRACT;
                } else {
                    order.status = OrderStatus.WAITING_SUPPLIERS;
                }

                order.technicalReviewFinishedAt = new Date().toISOString();
                order.logs.push(createAuditLog('Technical study finalized and pushed to Procurement', order.status, user));
                break;

            case 'rollback-to-logged':
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
                    order.blanketOrder = Boolean(order.contractId || order.blanketContractId || (order.items && order.items.some(i => i.productionType === 'OUTSOURCING')));
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

                // Clear all components added in technical review & reset item approvals
                order.items.forEach(item => {
                    // Preserve and recover line item price across rollback
                    const oldItemMatch = rollbackOld?.items?.find(oi => oi.id === item.id);
                    const rawPrice = item.pricePerUnit ?? item.unitPrice ?? item.price ?? oldItemMatch?.pricePerUnit ?? oldItemMatch?.unitPrice ?? oldItemMatch?.price;
                    if (rawPrice !== undefined && rawPrice !== null && !isNaN(Number(rawPrice))) {
                        item.pricePerUnit = Number(rawPrice);
                    }

                    item.components = [];
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

                if (writeDb(db, getDbPath(req))) return res.json({ message: "Order permanently deleted" });
                else throw new Error("Database write failed");

            case 'reject-order':
                // CX16: a rejected order cannot be rejected again.
                if (order.status === OrderStatus.REJECTED) throw new Error('Refused: order already rejected');
                const today = new Date().toISOString().split('T')[0];
                const oldInternal = order.internalOrderNumber || '';
                const oldCustRef = order.customerReferenceNumber || '';
                
                // Rename both internal and customer reference numbers
                order.internalOrderNumber = `rej_${today}_${oldInternal}`;
                order.customerReferenceNumber = `rej_${today}_${oldCustRef}`;
                
                order.status = OrderStatus.REJECTED;
                if (!order.technicalReviewFinishedAt && [OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW, OrderStatus.NEGATIVE_MARGIN].includes(oldStatus)) {
                    order.technicalReviewFinishedAt = new Date().toISOString();
                }
                // Release all received components and trading items in Hub to general warehouse component stock
                transferReceivedItemsToFreeStock(order, db, `Order Rejection: ${payload?.reason || 'Business decision'}`, user);
                // CX12: supplier POs of the cancelled order that received nothing are cancelled (supplier commitment drops).
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (comp.source === 'PROCUREMENT' && ['ORDERED', 'WAITING_CONTRACT_START', 'RUNNING_OUTSOURCING_CONTRACT'].includes(comp.status) && !(Number(comp.receivedQty) > 0) && comp.poNumber) {
                            try { executeComponentPoCancelOrExtension(item, comp, `Order cancelled: ${payload?.reason || 'Business decision'}`, false); } catch (e) { comp.status = 'CANCELLED'; comp.cancelReason = 'Order cancelled'; comp.statusUpdatedAt = new Date().toISOString(); }
                        }
                    });
                });
                // Release any remaining reserved inventory back to free stock
                order.items.forEach(item => {
                    (item.components || []).forEach(comp => {
                        if (['RESERVED', 'RECEIVED'].includes(comp.status)) {
                            updateInventoryItem(db, comp, 'RELEASE', order);
                            comp.status = 'IN_STOCK'; // Or specific status indicating released
                        }
                    });
                });
                // R23 (C17): money the customer paid on a cancelled order becomes credit in the customer GENERAL wallet.
                {
                    const paidOnOrder = Math.round((order.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0) * 100) / 100;
                    const cust = (db.customers || []).find(c => c.name === order.customerName);
                    if (paidOnOrder > 0 && cust && !order.paymentMovedToWallet) {
                        cust.walletBalances = cust.walletBalances || {};
                        cust.walletBalances[SELF_WALLET_KEY] = Math.round(((cust.walletBalances[SELF_WALLET_KEY] || 0) + paidOnOrder) * 100) / 100;
                        order.paymentMovedToWallet = paidOnOrder;
                        ledgerPush(db, { type: 'TRANSFER', amount: paidOnOrder, description: `Cancelled PO ${oldInternal}: paid amount moved to customer general wallet`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'ORDER', oldInternal), toAccount: acctLabel(order.customerName, 'SELF', 'Self'), customerName: order.customerName, orderId: order.id, poNumber: oldInternal }, user);
                        order.logs.push(createAuditLog(`Paid amount ${paidOnOrder.toLocaleString()} L.E. moved to the customer general wallet (credit).`, order.status, user));
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
                    payload.costSheetFile = saveBase64CostSheetToFile(payload.costSheetFile, req);
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
                    if (comp.noRfpNeeded === undefined || comp.noRfpNeeded) {
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
                    order.logs.push(createAuditLog(`Stock Component Receipt: ${qtyToProcess} ${compToReceive.unit || 'pcs'} of ${compToReceive.description} received into Warehouse Stock (ordered for stock)`, order.status, user));
                } else if (!isStockOrder(order) && item.productionType === 'TRADING') {
                    // For trading items, automatically move received quantity to hub
                    item.hubReceivedQty = (item.hubReceivedQty || 0) + qtyToProcess;

                    // Mark component as manufactured since trading items skip manufacturing
                    if (compToReceive.receivedQty >= totalOrdered) {
                        compToReceive.status = 'Manufactured';
                    }

                    order.logs.push(createAuditLog(`Trading Component Receipt: ${qtyToProcess} ${compToReceive.unit} of ${compToReceive.description} moved directly to Hub (Total Hub: ${item.hubReceivedQty}/${getItemEffectiveQty(item)})`, order.status, user));

                    // Check if all trading components are received and move to hub
                    // C06/TR11: warehouse stock allocated to the line (source STOCK) is available at once; only the procured parts must be received.
                    const compReady = (comp) => comp.source === 'STOCK' || comp.status === 'ORDERED_FOR_STOCK' || comp.forStock || ['RESERVED', 'RECEIVED', 'IN_STOCK', 'Manufactured'].includes(comp.status) || (comp.receivedQty || 0) >= (comp.quantity || 0);
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
                        compToReceive.status = isStockOrder(order) ? 'RECEIVED' : 'RESERVED';
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
                    const stockOrderIdx = (db.orders || []).findIndex(o => o.id === rcComp.allocatedFromStockOrderId);
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
                const sendPoId = Math.random().toString(36).substring(2, 9);
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
                        if (comp.sendPoId === payload.sendPoId && ['ORDERED', 'WAITING_CONTRACT_START', 'RECEIVED', 'RESERVED'].includes(comp.status)) {
                            targets.push({ item, comp });
                        }
                    });
                });

                if (targets.length === 0) throw new Error("No components found matching sendPoId");

                // Check Case 1 vs Case 2: if any component has received items or payments
                const hasReceivedOrPaid = targets.some(({ comp }) => {
                    const rec = comp.receivedQty || 0;
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
                            if (comp.sendPoId === payload.sendPoId && ['ORDERED', 'WAITING_CONTRACT_START', 'RECEIVED', 'RESERVED'].includes(comp.status)) {
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
                if (!['ORDERED', 'WAITING_CONTRACT_START', 'RECEIVED', 'RESERVED'].includes(comp.status)) {
                    throw new Error("Component is not in a PO or received status");
                }
                const oldStatus = comp.status;
                const oldPoNumber = comp.poNumber || 'N/A';
                const revertReason = (payload.reason || '').trim() || 'Reverted to award by user';

                // Release any received quantity to free warehouse stock
                transferReceivedItemsToFreeStock(order, db, `PO Revert to Award: ${revertReason}`, user, comp.id);

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
                const [removed] = order.payments.splice(payload.index, 1);
                order.logs.push(createAuditLog(`Payment of ${removed.amount} VOIDED: ${payload.reason || 'Correction'}`, order.status, user));
                // R21 (C13): a voided cash payment needs a reversing ledger entry (bank back to the order account).
                const movedToWallet = Number(order.paymentMovedToWallet) || 0;
                const custW = movedToWallet > 0 ? (db.customers || []).find(c => c.name === order.customerName) : null;
                if (custW && !removed.transfer && Number(removed.amount) > 0) {
                    // R24 (C17): the paid amount of this cancelled order already sits in the customer general wallet; voiding it
                    // refunds the customer from that credit (wallet -> Bank, REFUND, no P&L) instead of reversing a bank-to-order entry.
                    const take = Math.min(Number(removed.amount), movedToWallet);
                    custW.walletBalances = custW.walletBalances || {};
                    custW.walletBalances[SELF_WALLET_KEY] = Math.round(((custW.walletBalances[SELF_WALLET_KEY] || 0) - take) * 100) / 100;
                    order.paymentMovedToWallet = Math.round((movedToWallet - take) * 100) / 100;
                    ledgerPush(db, { type: 'REFUND', amount: take, description: `Payment VOIDED (cancelled PO ${order.internalOrderNumber}): refunded from customer general wallet - ${payload.reason || 'Correction'}`, category: 'Customer Refunds', fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: 'Bank Account', customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber }, user);
                } else if (!removed.transfer && Number(removed.amount) > 0) {
                    ledgerPush(db, { type: 'DEDUCTION', amount: Number(removed.amount), description: `Payment VOIDED: ${order.customerName} - PO ${order.internalOrderNumber} - ${payload.reason || 'Correction'}`, category: 'Customer Payment Reversal', fromAccount: 'Bank Account', toAccount: acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber }, user);
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
                order.status = OrderStatus.WAITING_SUPPLIERS; // Return to procurement flow
                {
                    const dbS = (db.settings && Array.isArray(db.settings) && db.settings.length > 0) ? db.settings[0] : (db.settings || {});
                    let mm = dbS.minimumMarginPct || 15;
                    const cu = db.customers.find(c => c.name === order.customerName);
                    if (cu && cu.minimumMarginPct !== undefined && cu.minimumMarginPct !== null) mm = cu.minimumMarginPct;
                    order.marginReleasedSig = marginReleaseSig(order.items, mm, order.conversionRate); // release holds until price, cost, rate or threshold changes
                }
                order.logs.push(createAuditLog(`Margin block manually bypassed: ${payload?.reason || 'Management overrides'}`, order.status, user));
                break;


            case 'alter-line-item-qty': {
                const { itemId, newQty, reason } = payload;
                if (!itemId) throw new Error("itemId is required for quantity alteration");
                const targetItem = order.items.find(i => i.id === itemId);
                if (!targetItem) throw new Error("Line item not found in order");
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
                                        } else if (['RECEIVED', 'IN_STOCK', 'CONSUMED', 'Manufactured'].includes(comp.status)) {
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
                if (payload.fromWallet && payload.amount > 0) {
                    const customer = (db.customers || []).find(c => c.name === order.customerName);
                    if (customer && (customer.walletBalance || 0) > 0) {
                        const deductAmt = Math.min(payload.amount, customer.walletBalance);
                        walletUsedForLedger = deductAmt;
                        customer.walletBalance = Math.max(0, (customer.walletBalance || 0) - deductAmt);
                        if (customer.walletBalances) {
                            for (const key of Object.keys(customer.walletBalances)) {
                                if (customer.walletBalances[key] > 0) {
                                    const kDeduct = Math.min(deductAmt, customer.walletBalances[key]);
                                    customer.walletBalances[key] -= kDeduct;
                                    break;
                                }
                            }
                        }
                        order.logs.push(createAuditLog(`Applied ${deductAmt.toLocaleString()} L.E. from Customer Wallet balance. Remaining wallet: ${customer.walletBalance.toLocaleString()} L.E.`, order.status, user));
                    }
                }

                {
                    // Ledger: new cash from the customer is an ADDITION to the bank; the part taken from the
                    // customer's wallet is only an account transfer (wallet -> this PO), no new cash.
                    const payAmt = Number(payload.amount) || 0;
                    const fromWalletAmt = Math.min(payAmt, Number(walletUsedForLedger) || 0);
                    const cashAmt = Math.round((payAmt - fromWalletAmt) * 100) / 100;
                    const poAcct = acctLabel(order.customerName, 'ORDER', order.internalOrderNumber);
                    if (cashAmt > 0) ledgerPush(db, { type: 'ADDITION', amount: cashAmt, description: `Customer Payment: ${order.customerName} - PO ${order.internalOrderNumber} - ${payload.memo || 'Regular payment'}`, category: 'Customer Payment', fromAccount: poAcct, toAccount: 'Bank Account', customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, receiptNumber }, user);
                    if (fromWalletAmt > 0) ledgerPush(db, { type: 'TRANSFER', amount: fromWalletAmt, description: `Wallet applied to PO ${order.internalOrderNumber}`, category: 'Account Transfer', fromAccount: acctLabel(order.customerName, 'SELF', 'Self'), toAccount: poAcct, customerName: order.customerName, orderId: order.id, poNumber: order.internalOrderNumber, receiptNumber }, user);
                }

                const fullyPaid = isOrderFullyPaid(order);
                const fullyDelivered = isOrderFullyDelivered(order);
                const isLateStage = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.WAITING_GOVE].includes(order.status);

                // Check if Gov.E invoice has been issued
                const hasGovEInvoice = order.logs?.some(log => log.message && log.message.includes('Gov. E-Invoice Attached')) || false;

                if (fullyPaid) {
                    if (isLateStage && fullyDelivered) {
                        if (hasGovEInvoice) {
                            order.status = OrderStatus.FULFILLED;
                            order.logs.push(createAuditLog(`Full payment reconciled${order.appliesWithholdingTax ? ' (with 1% WHT deducted)' : ''}, Delivery complete & Gov. E-Invoice issued. Order lifecycle FULFILLED.`, order.status, user));
                        } else {
                            order.status = OrderStatus.WAITING_GOVE;
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
                                (comp.source === 'PROCUREMENT' && (comp.status === 'RESERVED' || comp.status === 'RECEIVED'))) {
                                releasedHere = true;
                            }
                            
                            // R21 (C02): adjust quantity only for components really released back to stock.
                            // Outsourced/other components have no consumption basis; zeroing them lost quantity, cost, COGS and profit.
                            if (releasedHere) {
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
                                if (sc.source !== 'STOCK' || !sc.inventoryItemId || leftToTake <= 0) return;
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
                        order.status = hasGovEInv ? OrderStatus.FULFILLED : OrderStatus.WAITING_GOVE;
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
                    order.status = OrderStatus.FULFILLED;
                    einvLog(`Gov. E-Invoice Attached: ${payload.einvoiceFile}. All requirements met - Order FULFILLED.`);
                } else if (order.status === OrderStatus.WAITING_GOVE && fullyDel && fullyPaid_) {
                    // If order was waiting for Gov.E invoice and all conditions are now met
                    order.status = OrderStatus.FULFILLED;
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
                const refs = [order.id, order.internalOrderNumber].filter(Boolean);
                const calls = db.orders.filter(o => o.blanketContractId && refs.includes(o.blanketContractId) && o.status !== OrderStatus.REJECTED);
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
                const cust = db.customers.find(c => c.name === order.customerName);
                if (diff !== 0 && cust) {
                    cust.walletBalances = cust.walletBalances || {};
                    cust.walletBalances[SELF_WALLET_KEY] = Math.round(((cust.walletBalances[SELF_WALLET_KEY] || 0) + diff) * 100) / 100;
                    cust.walletBalance = (cust.walletBalance || 0) + diff;
                    ledgerPush(db, { type: 'TRANSFER', amount: Math.abs(diff), description: `Blanket close ${order.internalOrderNumber}: ${diff > 0 ? 'overpayment credited to' : 'underpayment debited from'} the customer general wallet`, category: 'Account Transfer', fromAccount: diff > 0 ? acctLabel(order.customerName, 'ORDER', order.internalOrderNumber) : acctLabel(order.customerName, 'GENERAL'), toAccount: diff > 0 ? acctLabel(order.customerName, 'GENERAL') : acctLabel(order.customerName, 'ORDER', order.internalOrderNumber), customerName: order.customerName, orderId: order.id }, user);
                }
                order.contractClosed = true;
                order.closedDeliveredGross = deliveredGross;
                order.status = OrderStatus.FULFILLED;
                order.logs.push(createAuditLog(`Blanket order closed by finance: delivered gross ${deliveredGross.toFixed(2)}, payments ${roundedPaid.toFixed(2)}${diff !== 0 ? `, difference ${diff.toFixed(2)} booked to the customer general wallet` : ''}.`, order.status, user));
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

                const isStockSource = stockComp.source === 'STOCK' || stockStatusBefore === 'RECEIVED' || stockStatusBefore === 'IN_STOCK';
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
        res.status(400).json({ error: e.message });
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

    if (writeDb(cleanDb, getDbPath(req))) {
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
        res.json({ message: "Restored" });
    } else {
        res.status(500).json({ error: "Restore failed during file write" });
    }
});

const restoreDiskUpload = multer({ dest: os.tmpdir() });
app.post('/api/v1/full-restore', restoreDiskUpload.single('archive'), async (req, res) => {
  const tempDir = path.join(os.tmpdir(), `nexus-restore-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tempDir, { recursive: true });
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
        writeDb(db, DB_PATH);
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

        // Auto-sync restored files from permanent UPLOADS_BASE to Dropbox in background if configured
        syncLocalDirectoryToDropbox(UPLOADS_BASE, req).catch((err) => console.error('[Dropbox Sync Restore Error]', err.message));
      }
    }

    res.json({ message: "Full system restore successful", isSandbox: isSandbox(req) });
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
app.post('/api/upload-pod', uploadPod.single('podFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = storedUploadPath(req.file.path);
        if (req.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, fs.readFileSync(req.file.path)).catch(() => {});
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-einvoice', uploadEInvoice.single('einvoiceFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = storedUploadPath(req.file.path);
        if (req.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, fs.readFileSync(req.file.path)).catch(() => {});
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-wht-certificate', uploadWht.single('whtFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = storedUploadPath(req.file.path);
        if (req.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, fs.readFileSync(req.file.path)).catch(() => {});
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-cost-sheet', uploadCostSheet.single('costSheetFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = storedUploadPath(req.file.path);
        if (req.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, fs.readFileSync(req.file.path)).catch(() => {});
        res.json({ success: true, filePath: relativePath });
    } catch (err) {
        res.status(500).json({ success: false, error: "Upload failed" });
    }
});

app.post('/api/upload-supplier-receipt', uploadSupplierReceipt.single('receiptFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file" });
        const relativePath = storedUploadPath(req.file.path);
        if (req.sandboxOwner) {
            recordSandboxFileChange(req.sandboxOwner, relativePath, 'add');
        }
        syncUploadToDropbox(req, relativePath, fs.readFileSync(req.file.path)).catch(() => {});
        res.json({ success: true, filePath: relativePath });
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
        const rawUrl = (settings && settings.tursoUrl && String(settings.tursoUrl).trim()) || process.env.TURSO_DATABASE_URL || DEFAULT_TURSO_URL;
        const authToken = (settings && settings.tursoAuthToken && String(settings.tursoAuthToken).trim()) || process.env.TURSO_AUTH_TOKEN || getDefaultTursoToken();
        const useTurso = (settings && settings.useTurso !== undefined && settings.tursoUrl) ? !!settings.useTurso : false;

        if (!rawUrl || !authToken) {
            return res.json({ configured: false, connected: false, enabled: useTurso });
        }

        const dbUrl = rawUrl.startsWith('libsql://') ? rawUrl.replace(/^libsql:\/\//, 'https://') : rawUrl;
        const client = createClient({ url: dbUrl, authToken });
        const result = await client.execute("SELECT count(*) as cnt FROM nexus_state");
        const count = result.rows[0]?.cnt || 0;

        return res.json({
            configured: true,
            connected: true,
            enabled: useTurso,
            databaseUrl: rawUrl,
            syncedStatesCount: count
        });
    } catch (err) {
        return res.json({
            configured: true,
            connected: false,
            enabled: true,
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

// GET all supplier payments
app.get('/api/v1/supplierPayments', (req, res) => {
    const db = getDb(req);
    res.json(db.supplierPayments || []);
});

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

        // Gather all PROCUREMENT components for this supplier across all orders
        const componentEntries = [];
        (db.orders || []).forEach(order => {
            order.items.forEach(item => {
                (item.components || []).forEach(comp => {
                    if (comp.source === 'PROCUREMENT' && comp.supplierId === supplierId &&
                        ['ORDERED', 'ORDERED_FOR_STOCK', 'RECEIVED', 'RESERVED', 'IN_MANUFACTURING', 'MANUFACTURED'].includes(comp.status)) {
                        const isTarget = Boolean((orderId && order.id === orderId) || (poNumber && comp.poNumber === poNumber));
                        const taxRate = comp.taxPercent !== undefined ? comp.taxPercent : 14;
                        const netCost = (comp.quantity || 0) * (comp.unitCost || 0);
                        const grossCost = netCost * (1 + (taxRate / 100));

                        componentEntries.push({
                            componentId: comp.id,
                            orderId: order.id,
                            orderNumber: order.internalOrderNumber,
                            itemDescription: comp.description,
                            poNumber: comp.poNumber,
                            totalCost: grossCost,
                            procurementStartedAt: comp.procurementStartedAt || comp.statusUpdatedAt || order.dataEntryTimestamp,
                            isTarget
                        });
                    }
                });
            });
        });

        // Sort: target PO components first, then FIFO by procurement start date
        componentEntries.sort((a, b) => {
            if (a.isTarget && !b.isTarget) return -1;
            if (!a.isTarget && b.isTarget) return 1;
            return new Date(a.procurementStartedAt).getTime() - new Date(b.procurementStartedAt).getTime();
        });

        // Calculate already-allocated amounts per component from previous payments
        const previousAllocations = {};
        (db.supplierPayments || []).forEach(payment => {
            if (payment.supplierId === supplierId) {
                (payment.allocations || []).forEach(alloc => {
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

        const unallocatedAdvance = remaining > 0 ? Math.round(remaining * 100) / 100 : 0;

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
            allocations
        };

        if (!db.supplierPayments) db.supplierPayments = [];
        db.supplierPayments.push(paymentRecord);

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
            order.items.forEach(item => {
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

const startupDb = readDb();
repairNegativeMarginOrders(startupDb);
repairTradingMirrorOrders(startupDb);
reconcileStockAllocations(startupDb, DB_PATH);
syncAuthoritativeUsersToSandboxes(startupDb);

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
    // 1. Pull latest database state from Turso Cloud (if enabled in settings)
    await pullFromTursoOnStartup();
    
    // 2. Perform DB schema migrations locally
    migrateAllSandboxesOnStartup();
    
    // 3. Start Express server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Backend] Running exclusively on http://localhost:${PORT}`);
        runThresholdAudit().catch(err => console.error('[Audit] Unhandled error in initial audit:', err));
        setInterval(() => {
            runThresholdAudit().catch(err => console.error('[Audit] Unhandled error in interval audit:', err));
        }, 60000);
    });
})();
