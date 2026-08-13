import re
import os

SERVER_JS_PATH = r"C:\Users\moata\.gemini\antigravity\scratch\NexusERP\server.js"

with open(SERVER_JS_PATH, "r", encoding="utf-8") as f:
    code = f.read()

# 1. Path Helpers and imports
imports_and_helpers = """
import os from 'os';
import AdmZip from 'adm-zip';

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

const getSandboxDbPath = (owner) => path.join(__dirname, `db.sandbox.${sanitizeUsername(owner)}.json`);
const getSandboxUploadsPath = (owner) => path.join(UPLOADS_BASE, 'sandbox', sanitizeUsername(owner));
const getDbPath = (req) => req.sandboxDbPath || DB_PATH;
const isSandbox = (req) => Boolean(req.sandboxDbPath);
"""

# Insert imports at top if not present
if "sanitizeUsername" not in code:
    code = code.replace("import fs from 'fs';", "import fs from 'fs';\n" + imports_and_helpers)

# 2. Synchronous Database Handlers with Migration Safety
old_readdb_writedb = r"// --- DATABASE HANDLERS ---\s*const readDb = \(\) => \{.*?const writeDb = \(data\) => \{.*?\};\s*"
new_readdb_writedb = """// --- DATABASE HANDLERS ---
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
    return db;
  } catch (err) {
    console.error(`[DB] Read error on ${targetPath}:`, err);
    if (fs.existsSync(bakPath)) {
      try { return JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch {}
    }
    return {};
  }
};

const writeDb = (data, customPath = null) => {
  const targetPath = customPath || DB_PATH;
  const bakPath = targetPath + '.local.bak';
  try {
    // Atomic write
    const tmpPath = targetPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, targetPath);
    try { fs.copyFileSync(targetPath, bakPath); } catch {}
    return true;
  } catch (err) {
    console.error(`[DB] Write error on ${targetPath}:`, err);
    return false;
  }
};

const getDb = (req) => readDb(getDbPath(req));
"""
code = re.sub(old_readdb_writedb, new_readdb_writedb, code, flags=re.DOTALL)


# 3. applySchemaMigrations signature drift
code = re.sub(r'const applySchemaMigrations = \(db\) => \{', 'const applySchemaMigrations = (db, targetPath = DB_PATH) => {', code)
code = re.sub(r'writeDb\(db\);\s*\}', 'writeDb(db, targetPath);\n}', code) # Only inside applySchemaMigrations? Wait, easier to do direct replacement

if "const applySchemaMigrations = (db) => {" in code:
    code = code.replace("const applySchemaMigrations = (db) => {", "const applySchemaMigrations = (db, targetPath = DB_PATH) => {")
# Fix writeDb inside applySchemaMigrations
# Find applySchemaMigrations block and replace writeDb
migrations_block_regex = r'(const applySchemaMigrations = \(db, targetPath = DB_PATH\) => \{.*?)(writeDb\(db\);)(.*?^\})'
code = re.sub(migrations_block_regex, r'\1writeDb(db, targetPath);\3', code, flags=re.DOTALL | re.MULTILINE)

# 4. Sandbox Middleware
sandbox_middleware = """
// Sandbox Middleware
app.use((req, res, next) => {
  const username = req.headers['x-user'];
  const sandboxOwner = req.headers['x-sandbox-owner'];

  req.user = username || null;
  req.roles = [];

  if (sandboxOwner && username) {
    const sanitizedOwner = sanitizeUsername(sandboxOwner);
    const sandboxPath = getSandboxDbPath(sanitizedOwner);

    if (fs.existsSync(sandboxPath)) {
      const sandboxDb = readDb(sandboxPath);
      const userEntry = (sandboxDb.users || []).find(u => 
        u.username.toLowerCase() === username.toLowerCase()
      );

      if (userEntry) {
        req.sandboxDbPath = sandboxPath;
        req.sandboxOwner = sanitizedOwner;
        req.roles = userEntry.roles || [];
      } else {
        return res.status(403).json({ error: 'ACCESS_REVOKED', message: 'Access to this sandbox has been revoked.' });
      }
    }
  }
  next();
});
"""
if "// Sandbox Middleware" not in code:
    code = code.replace("app.use(express.json());", "app.use(express.json());\n" + sandbox_middleware)

# 5 & 6. Auth Environments and Login
auth_endpoints = """
const discoveryCache = new Map();

app.get('/api/v1/auth/environments', (req, res) => {
  const queryUser = String(req.query.username || '').trim().toLowerCase();
  const headerUser = String(req.headers['x-user'] || '').trim().toLowerCase();
  
  const username = (headerUser && headerUser === queryUser) ? queryUser : '';
  if (!username) {
    return res.json({ environments: [{ id: 'live', label: 'Live ERP (Production)', type: 'live' }] });
  }

  const cached = discoveryCache.get(username);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json(cached.data);
  }

  const liveDb = readDb(DB_PATH);
  const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === username);

  if (!liveUser) {
    return res.json({ environments: [{ id: 'live', label: 'Live ERP (Production)', type: 'live' }] });
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
        const db = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
        const hasAccess = (db.users || []).some(u => u.username.toLowerCase() === username);
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

app.post('/api/v1/login', (req, res) => {
  const { username, password, environment } = req.body;
  const targetEnv = environment || 'live';
  const liveDb = readDb(DB_PATH);

  const isFactory = username === 'factory' && (Date.now() - SERVER_START_TIME) < 300000 && password === FACTORY_PASS;
  if (isFactory) {
    if (targetEnv !== 'live') return res.status(403).json({ error: "Factory emergency bypass is only permitted on Live ERP." });
    const factoryUser = (liveDb.users || []).find(u => u.username === 'factory') || { id: 'factory', username: 'factory', name: 'Factory Admin', roles: ['admin'], email: 'factory@nexus.local' };
    const { password: _, ...safe } = factoryUser;
    return res.json(safe);
  }

  if (targetEnv === 'live') {
    const user = (liveDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
    if (!user || user.password !== hashPassword(password)) return res.status(401).json({ error: "Invalid username or password" });
    const { password: _, ...safe } = user;
    return res.json(safe);
  }

  if (targetEnv === 'self' || targetEnv.toLowerCase() === (username || '').toLowerCase()) {
    const liveUser = (liveDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
    if (!liveUser || liveUser.password !== hashPassword(password)) return res.status(401).json({ error: "Invalid username or password" });

    const sandboxPath = getSandboxDbPath(username);
    if (!fs.existsSync(sandboxPath)) {
      const stubPath = path.join(__dirname, 'db.stub.json');
      const stubDb = fs.existsSync(stubPath) ? JSON.parse(fs.readFileSync(stubPath, 'utf8')) : {};
      stubDb.settings = []; stubDb.modules = []; stubDb.orders = []; stubDb.customers = []; stubDb.inventory = []; stubDb.notifications = []; stubDb.contracts = []; stubDb.supplierPayments = [];
      stubDb.userGroups = [
        { id: 'ug_sales', name: 'Sales Department', roles: ['sales'], permissions: { canViewFinancials: false, canApproveTechReview: false, canReleaseHub: false, canManageUsers: false } },
        { id: 'ug_proc', name: 'Procurement Team', roles: ['procurement'], permissions: { canViewFinancials: true, canApproveTechReview: false, canReleaseHub: false, canManageUsers: false } },
        { id: 'ug_wh', name: 'Warehouse & Logistics', roles: ['warehouse', 'logistics'], permissions: { canViewFinancials: false, canApproveTechReview: false, canReleaseHub: true, canManageUsers: false } },
        { id: 'ug_mgmt', name: 'Executive Management', roles: ['admin'], permissions: { canViewFinancials: true, canApproveTechReview: true, canReleaseHub: true, canManageUsers: true } }
      ];
      stubDb.users = [{ ...liveUser, roles: liveUser.roles || [] }];
      writeDb(stubDb, sandboxPath);
    }
    const sandboxDb = readDb(sandboxPath);
    const sandboxUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === username.toLowerCase()) || liveUser;
    const { password: _, ...safe } = sandboxUser;
    return res.json({ ...safe, sandbox: true, sandboxOwner: sanitizeUsername(username), sandboxLabel: `My Own Sandbox (${username})` });
  }

  const ownerSanitized = sanitizeUsername(targetEnv);
  const sandboxPath = getSandboxDbPath(ownerSanitized);
  if (!fs.existsSync(sandboxPath)) return res.status(404).json({ error: "Team sandbox environment not found." });

  const sandboxDb = readDb(sandboxPath);
  const sandboxUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!sandboxUser) return res.status(403).json({ error: "You do not have access to this team sandbox." });
  if (sandboxUser.password !== hashPassword(password)) return res.status(401).json({ error: "Invalid username or password for this sandbox." });

  const ownerUser = (sandboxDb.users || []).find(u => u.username.toLowerCase() === ownerSanitized);
  const { password: _, ...safe } = sandboxUser;
  return res.json({ ...safe, sandbox: true, sandboxOwner: ownerSanitized, sandboxLabel: `${ownerUser?.name || ownerSanitized}'s Team Sandbox` });
});
"""

# Replace old login endpoint
old_login_regex = r"app\.post\('/api/v1/login', \(req, res\) => \{.*?(?=\napp\.)"
code = re.sub(old_login_regex, auth_endpoints + "\n", code, flags=re.DOTALL)


# 7 & 8. Multer & static serving
multer_replacement = """
const makeStorage = (subDir, prefix) => multer.diskStorage({
  destination: function (req, file, cb) {
    const base = req.sandboxOwner ? getSandboxUploadsPath(req.sandboxOwner) : UPLOADS_BASE;
    const dir = path.join(base, subDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${prefix}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const uploadPod = multer({ storage: makeStorage('pod', 'pod') });
const uploadEInvoice = multer({ storage: makeStorage('einvoices', 'einvoice') });
const uploadWht = multer({ storage: makeStorage('wht_certificates', 'wht') });
const restoreUpload = multer({ storage: multer.memoryStorage() });

app.use('/uploads', cors(), (req, res, next) => {
  const reqUrl = req.originalUrl || req.url;
  if (reqUrl.startsWith('/uploads/sandbox/')) {
    const parts = reqUrl.replace('/uploads/sandbox/', '').split('?')[0].split('/');
    const targetOwner = parts[0];
    const effectiveOwner = req.sandboxOwner; // Fixed: removed ?u=alice backdoor
    if (!effectiveOwner || sanitizeUsername(effectiveOwner) !== targetOwner) {
      return res.status(403).json({ error: "Access to foreign sandbox uploads denied." });
    }
  }
  next();
});
app.use('/uploads', express.static(UPLOADS_BASE));
"""

old_multer_regex = r"const storagePod = multer\.diskStorage\(\{.*?(?=// --- INITIALIZATION ---)"
code = re.sub(old_multer_regex, multer_replacement + "\n", code, flags=re.DOTALL)
# Also remove any old app.use('/uploads', express.static) if present further down
code = re.sub(r"app\.use\('/uploads', express\.static.*?;\n", "", code)


# 9. sendEmail
old_email = r"const sendEmail = async \(to, subject, body, config\) => \{"
new_email = """const sendEmail = async (to, subject, body, config, req = null) => {
  if (req && isSandbox(req)) {
    console.log(`[Sandbox Email Simulated] To: ${JSON.stringify(to)} | Subject: ${subject}`);
    return { success: true, simulated: true };
  }
"""
code = code.replace(old_email, new_email)

# Replace sendEmail calls
code = re.sub(r'sendEmail\((.*?), (.*?), (.*?), (.*?)\)', r'sendEmail(\1, \2, \3, \4, req)', code)

# Fix relay endpoint
relay_endpoint = """app.post('/api/v1/relay/dispatch', async (req, res) => {
  const { Host, Port, Username, Password, To, From, Subject, Body } = req.body;
  const result = await sendEmail(To, Subject, Body, {
    smtpServer: Host, smtpPort: Port, username: Username, password: Password,
    senderName: 'Nexus Relay', senderEmail: From || Username, useSsl: Port === 465
  }, req);
  if (result.success) res.json({ message: "Sent" });
  else res.status(500).json({ error: result.error });
});"""
code = re.sub(r"app\.post\('/api/v1/relay/dispatch', async \(req, res\) => \{.*?(?=\napp\.)", relay_endpoint + "\n", code, flags=re.DOTALL)

# 10 & 11. wipe and reset
wipe_endpoint = """
app.post('/api/v1/wipe', (req, res) => {
  if (isSandbox(req)) return res.status(400).json({ error: "Direct wipe is disabled in sandbox mode. Use /api/v1/sandbox/reset." });
  const db = getDb(req);
  db.orders = []; db.customers = []; db.inventory = []; db.notifications = []; db.contracts = []; db.supplierPayments = [];
  if (writeDb(db, getDbPath(req))) res.json({ message: "Live wipe successful" });
  else res.status(500).json({ error: "Wipe failed" });
});

app.post('/api/v1/sandbox/reset', (req, res) => {
  if (!isSandbox(req)) return res.status(400).json({ error: "Must be in sandbox mode." });
  const currentDb = getDb(req);
  const resetDb = {
    settings: currentDb.settings || [], modules: currentDb.modules || [], userGroups: currentDb.userGroups || [], users: currentDb.users || [],
    orders: [], customers: [], inventory: [], notifications: [], contracts: [], supplierPayments: []
  };
  writeDb(resetDb, getDbPath(req));
  const uploadsDir = getSandboxUploadsPath(req.sandboxOwner);
  if (fs.existsSync(uploadsDir)) {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  res.json({ success: true, message: "Sandbox reset successfully." });
});
"""
code = re.sub(r"app\.post\('/api/v1/wipe', \(req, res\) => \{.*?(?=\napp\.)", wipe_endpoint + "\n", code, flags=re.DOTALL)

# Refactor full-restore
full_restore = """app.post('/api/v1/full-restore', restoreUpload.single('archive'), (req, res) => {
  const tempDir = path.join(os.tmpdir(), `nexus-restore-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const zip = new AdmZip(req.file.buffer);
    zip.extractAllTo(tempDir, true);
    const extractedDb = path.join(tempDir, 'db.json');
    if (fs.existsSync(extractedDb)) {
      const db = JSON.parse(fs.readFileSync(extractedDb, 'utf8'));
      applySchemaMigrations(db, getDbPath(req));
      writeDb(db, getDbPath(req));
    }
    const extractedUploads = path.join(tempDir, 'uploads');
    if (fs.existsSync(extractedUploads)) {
      const targetUploads = isSandbox(req) ? getSandboxUploadsPath(req.sandboxOwner) : UPLOADS_BASE;
      if (!fs.existsSync(targetUploads)) fs.mkdirSync(targetUploads, { recursive: true });
      fs.cpSync(extractedUploads, targetUploads, { recursive: true });
    }
    res.json({ message: "Full system restore successful", isSandbox: isSandbox(req) });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});"""
code = re.sub(r"app\.post\('/api/v1/full-restore', restoreUpload\.single\('archive'\), \(req, res\) => \{.*?(?=\napp\.)", full_restore + "\n", code, flags=re.DOTALL)


# 15. migrateAllSandboxesOnStartup
migrate_sandboxes = """
const migrateAllSandboxesOnStartup = () => {
    try {
        const files = fs.readdirSync(__dirname).filter(f => f.startsWith('db.sandbox.') && f.endsWith('.json'));
        for (const file of files) {
            try {
                const targetPath = path.join(__dirname, file);
                const db = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
                applySchemaMigrations(db, targetPath);
            } catch (e) {
                console.error(`Failed to migrate sandbox DB ${file}:`, e);
            }
        }
    } catch (e) {
        console.error("Failed to list sandbox directories:", e);
    }
};
"""
if "migrateAllSandboxesOnStartup" not in code:
    code = code.replace("app.listen(PORT, () => {", migrate_sandboxes + "\n    migrateAllSandboxesOnStartup();\n    app.listen(PORT, () => {")


# 1, 10. Replace global readDb() and writeDb(db) with getDb(req) and writeDb(db, getDbPath(req))
def endpoint_replacer(match):
    block = match.group(0)
    # Don't replace if it's already using getDb(req) or if it's the login endpoint (handled)
    if "api/v1/login" in block or "auth/environments" in block or "sandbox/reset" in block or "/api/v1/wipe" in block or "api/v1/full-restore" in block or "api/v1/relay/dispatch" in block:
        return block
    # replace readDb()
    block = re.sub(r'(?<!function )readDb\(\)', 'getDb(req)', block)
    # replace writeDb(db)
    block = re.sub(r'writeDb\(([^,]+?)\)', r'writeDb(\1, getDbPath(req))', block)
    # replace writeDb(data) or anything inside
    return block

# We apply this to every app.get/post/put/delete and helper functions like getCollection
code = re.sub(r'(app\.(get|post|put|delete)\(.*?\{.*?\n\}\);)', endpoint_replacer, code, flags=re.DOTALL)
code = re.sub(r'(const (getCollection|getItemFromCollection|addToCollection|updateInCollection|deleteFromCollection) = .*?\{.*?\n\};)', endpoint_replacer, code, flags=re.DOTALL)

with open(SERVER_JS_PATH, "w", encoding="utf-8") as f:
    f.write(code)
print("Refactoring complete.")
