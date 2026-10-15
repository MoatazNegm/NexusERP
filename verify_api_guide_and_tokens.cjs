const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 5055;
const BASE_URL = `http://localhost:${TEST_PORT}/api/v1`;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  console.log('--- STARTING SERVER ON PORT', TEST_PORT, '---');
  const serverProc = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', (d) => {
    // console.log('[Server stdout]', d.toString());
  });
  serverProc.stderr.on('data', (d) => {
    console.error('[Server stderr]', d.toString());
  });

  // Wait for server to bind
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE_URL}/user-guide?format=json`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch (e) {
      // waiting
    }
  }

  if (!ready) {
    serverProc.kill();
    throw new Error('Server failed to start on port ' + TEST_PORT);
  }
  console.log('✓ Server is up and responding on port', TEST_PORT);

  try {
    // ------------------------------------------------------------------------
    // TEST 1: User Guide Endpoint
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 1: User Guide Endpoints ---');
    // 1.1 JSON format
    const guideJsonRes = await fetch(`${BASE_URL}/user-guide?format=json`);
    if (!guideJsonRes.ok) throw new Error('Failed to get user guide JSON');
    const guideJson = await guideJsonRes.json();
    if (!guideJson.endpoints || guideJson.endpoints.length === 0) {
      throw new Error('User guide JSON missing endpoints');
    }
    console.log('✓ User Guide JSON returned successfully with', guideJson.endpoints.length, 'domain catalogs');

    // 1.2 Markdown format & download header
    const guideMdRes = await fetch(`${BASE_URL}/user-guide?format=markdown&download=true`);
    const contentDisposition = guideMdRes.headers.get('content-disposition');
    if (!contentDisposition || !contentDisposition.includes('NexusERP_RESTful_API_User_Guide.md')) {
      throw new Error('User guide download header missing or incorrect: ' + contentDisposition);
    }
    const guideMdText = await guideMdRes.text();
    if (!guideMdText.includes('NexusERP RESTful API User Guide')) {
      throw new Error('User guide Markdown text missing title');
    }
    console.log('✓ User Guide Markdown returned with download attachment header (size:', guideMdText.length, 'bytes)');

    // 1.3 /user-guide/download dedicated route
    const guideDlRes = await fetch(`${BASE_URL}/user-guide/download`);
    if (!guideDlRes.headers.get('content-disposition')?.includes('NexusERP_RESTful_API_User_Guide.md')) {
      throw new Error('Dedicated /user-guide/download header incorrect');
    }
    console.log('✓ Dedicated /user-guide/download route works');

    // ------------------------------------------------------------------------
    // TEST 2: API Keys - Default Sandbox Routing & Role Granting
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 2: API Keys (Sandbox by Default) ---');
    // Create an API key with allowLive unset / default (false)
    const createKeyRes = await fetch(`${BASE_URL}/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user': 'admin'
      },
      body: JSON.stringify({
        name: 'Test Sandbox Key',
        username: 'admin',
        allowLive: false
      })
    });
    if (!createKeyRes.ok) {
      const err = await createKeyRes.text();
      throw new Error('Failed to create API key: ' + err);
    }
    const keyData = await createKeyRes.json();
    console.log('✓ Created API Key:', keyData.name, 'prefix:', keyData.prefix, 'allowLive:', keyData.allowLive);

    if (keyData.allowLive !== false) {
      throw new Error('Expected allowLive to be false by default');
    }
    if (!Array.isArray(keyData.roles) || !keyData.roles.includes('admin')) {
      throw new Error('Expected API key to inherit admin roles: ' + JSON.stringify(keyData.roles));
    }
    console.log('✓ API Key successfully inherited owner roles:', keyData.roles);

    // Call API using this key WITHOUT any x-sandbox-owner header (requesting what would normally be live)
    // Make a mutation: Create a dummy customer
    const testCustName = 'Sandbox Only Customer ' + Date.now();
    const custRes = await fetch(`${BASE_URL}/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        name: testCustName,
        email: 'test@sandbox.local',
        phone: '123456'
      })
    });
    if (!custRes.ok) {
      const err = await custRes.text();
      throw new Error('Failed to create customer using sandbox API key: ' + err);
    }
    const createdCust = await custRes.json();
    console.log('✓ Created customer via API key:', createdCust.name);

    // Verify: The customer MUST exist in admin's sandbox DB, and MUST NOT exist in live db.json!
    const liveDbRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'db.json'), 'utf8'));
    const liveCustExists = (liveDbRaw.customers || []).some(c => c.name === testCustName);
    if (liveCustExists) {
      throw new Error('SECURITY VIOLATION: Customer was written to live db.json when API key has allowLive: false!');
    }
    console.log('✓ Verified: Customer is NOT present in live db.json (Live data protected!)');

    const adminSandboxPath = path.join(__dirname, 'db.sandbox.admin.json');
    if (!fs.existsSync(adminSandboxPath)) {
      throw new Error('Expected db.sandbox.admin.json to exist!');
    }
    const sandboxDbRaw = JSON.parse(fs.readFileSync(adminSandboxPath, 'utf8'));
    const sandboxCustExists = (sandboxDbRaw.customers || []).some(c => c.name === testCustName);
    if (!sandboxCustExists) {
      throw new Error('Customer was not found in admin sandbox DB!');
    }
    console.log('✓ Verified: Customer was strictly routed and stored in admin sandbox DB!');

    // ------------------------------------------------------------------------
    // TEST 3: API Keys - Live Data Allowed when Checkmark is Set
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 3: API Keys (Live Access when Checkmark is Set) ---');
    // Create an API key with allowLive = true
    const createLiveKeyRes = await fetch(`${BASE_URL}/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user': 'admin'
      },
      body: JSON.stringify({
        name: 'Test Live Key',
        username: 'admin',
        allowLive: true
      })
    });
    if (!createLiveKeyRes.ok) {
      throw new Error('Failed to create live API key');
    }
    const liveKeyData = await createLiveKeyRes.json();
    if (liveKeyData.allowLive !== true) {
      throw new Error('Expected allowLive to be true');
    }
    console.log('✓ Created Live-Enabled API Key:', liveKeyData.name, 'allowLive:', liveKeyData.allowLive);

    // Call API using live key without x-sandbox-owner header
    const liveCustName = 'Live Allowed Customer ' + Date.now();
    const liveCustRes = await fetch(`${BASE_URL}/customers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${liveKeyData.key}` // also test Authorization: Bearer
      },
      body: JSON.stringify({
        name: liveCustName,
        email: 'live@nexus.local',
        phone: '999888'
      })
    });
    if (!liveCustRes.ok) {
      throw new Error('Failed to create customer using live API key');
    }
    console.log('✓ Customer created using Authorization: Bearer live key');

    // Verify it IS in live db.json
    const liveDbAfter = JSON.parse(fs.readFileSync(path.join(__dirname, 'db.json'), 'utf8'));
    const liveCreated = (liveDbAfter.customers || []).find(c => c.name === liveCustName);
    if (!liveCreated) {
      throw new Error('Customer not found in live db.json despite allowLive: true');
    }
    console.log('✓ Verified: Customer was written to live db.json when allowLive: true');

    // Clean up live customer
    await fetch(`${BASE_URL}/customers/${liveCreated.id}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': liveKeyData.key
      }
    });
    console.log('✓ Cleaned up test live customer');

    // ------------------------------------------------------------------------
    // TEST 4: Sub-resource & Convenience Endpoints
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: Sub-resource Endpoints ---');

    // 4.1 Unique PO number
    const poRes = await fetch(`${BASE_URL}/procurement/unique-po-number`, {
      headers: { 'x-api-key': liveKeyData.key }
    });
    const poData = await poRes.json();
    if (!poData.poNumber || !poData.poNumber.startsWith('PO-')) {
      throw new Error('Invalid unique PO number response: ' + JSON.stringify(poData));
    }
    console.log('✓ Unique PO number generated:', poData.poNumber);

    // 4.2 Reports endpoint
    const reportRes = await fetch(`${BASE_URL}/reports/orders`, {
      headers: { 'x-api-key': liveKeyData.key }
    });
    const reportData = await reportRes.json();
    if (typeof reportData.totalRevenue !== 'number' || !Array.isArray(reportData.orders)) {
      throw new Error('Invalid reports response: ' + JSON.stringify(reportData));
    }
    console.log('✓ Order reports returned:', reportData.count, 'orders, revenue:', reportData.totalRevenue);

    // 4.3 Order item sub-resource: Create an order in sandbox, add item, update item, remove item
    const orderRes = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key // sandbox key
      },
      body: JSON.stringify({
        customerName: 'API Test Client',
        customerReferenceNumber: 'PO-TEST-' + Date.now(),
        orderDate: '2026-10-14',
        status: 'LOGGED',
        items: [{
          description: 'Initial Item',
          quantity: 2,
          pricePerUnit: 100,
          unit: 'pcs'
        }]
      })
    });
    if (!orderRes.ok) {
      throw new Error('Failed to create order: ' + await orderRes.text());
    }
    const orderObj = await orderRes.json();
    console.log('✓ Created test order:', orderObj.internalOrderNumber);

    // Add item
    const addItemRes = await fetch(`${BASE_URL}/orders/${orderObj.id}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        description: 'Sub-resource Added Item',
        quantity: 5,
        pricePerUnit: 50,
        unit: 'pcs'
      })
    });
    if (!addItemRes.ok) throw new Error('Failed to add item via sub-resource');
    const orderWithAdded = await addItemRes.json();
    const addedItem = orderWithAdded.items.find(i => i.description === 'Sub-resource Added Item');
    if (!addedItem) throw new Error('Added item not found in order');
    console.log('✓ Added item via POST /orders/:id/items');

    // Update item
    const updateItemRes = await fetch(`${BASE_URL}/orders/${orderObj.id}/items/${addedItem.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        quantity: 8
      })
    });
    if (!updateItemRes.ok) throw new Error('Failed to update item via sub-resource');
    const orderWithUpdated = await updateItemRes.json();
    const updatedItem = orderWithUpdated.items.find(i => i.id === addedItem.id);
    if (updatedItem.quantity !== 8) throw new Error('Item quantity was not updated');
    console.log('✓ Updated item via PUT /orders/:id/items/:itemId');

    // Remove item
    const deleteItemRes = await fetch(`${BASE_URL}/orders/${orderObj.id}/items/${addedItem.id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': keyData.key }
    });
    if (!deleteItemRes.ok) throw new Error('Failed to delete item via sub-resource');
    const orderWithDeleted = await deleteItemRes.json();
    if (orderWithDeleted.items.some(i => i.id === addedItem.id)) {
      throw new Error('Item was not removed');
    }
    console.log('✓ Deleted item via DELETE /orders/:id/items/:itemId');

    // Order hold
    const holdRes = await fetch(`${BASE_URL}/orders/${orderObj.id}/hold`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({ isHold: true, holdReason: 'Testing hold API' })
    });
    const heldOrder = await holdRes.json();
    if (!heldOrder.isHold) throw new Error('Order hold was not engaged');
    console.log('✓ Order hold engaged via POST /orders/:id/hold');

    // 4.4 Inventory stock adjustment
    const invRes = await fetch(`${BASE_URL}/inventory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        name: 'Adjust Test Item',
        sku: 'SKU-ADJ-' + Date.now(),
        quantity: 10,
        unitCost: 20
      })
    });
    const invItem = await invRes.json();
    const adjRes = await fetch(`${BASE_URL}/inventory/adjust`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        id: invItem.id,
        delta: 15,
        reason: 'Restock via API'
      })
    });
    const adjustedItem = await adjRes.json();
    if (adjustedItem.quantity !== 25) {
      throw new Error('Stock adjustment failed: expected 25, got ' + adjustedItem.quantity);
    }
    console.log('✓ Inventory adjusted via POST /inventory/adjust (from 10 to 25)');

    // 4.5 Supplier parts & blacklist sub-resources
    const suppRes = await fetch(`${BASE_URL}/suppliers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        name: 'Parts Test Supplier ' + Date.now(),
        contactPerson: 'Alice',
        email: 'alice@parts.com',
        phone: '123'
      })
    });
    const supplier = await suppRes.json();

    // Add part
    const addPartRes = await fetch(`${BASE_URL}/suppliers/${supplier.id}/parts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({
        partNumber: 'PN-1001',
        description: 'Test Bolt',
        unitCost: 5.5
      })
    });
    const suppWithPart = await addPartRes.json();
    const addedPart = suppWithPart.priceList.find(p => p.partNumber === 'PN-1001');
    if (!addedPart) throw new Error('Part not found in supplier priceList');
    console.log('✓ Added part via POST /suppliers/:id/parts');

    // Blacklist supplier
    const blRes = await fetch(`${BASE_URL}/suppliers/${supplier.id}/blacklist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyData.key
      },
      body: JSON.stringify({ isBlacklisted: true, blacklistReason: 'Compliance check' })
    });
    const blSupp = await blRes.json();
    if (!blSupp.isBlacklisted) throw new Error('Supplier blacklist failed');
    console.log('✓ Blacklisted supplier via POST /suppliers/:id/blacklist');

    // Clean up created API keys
    await fetch(`${BASE_URL}/api-keys/${keyData.id}`, { method: 'DELETE', headers: { 'x-user': 'admin' } });
    await fetch(`${BASE_URL}/api-keys/${liveKeyData.id}`, { method: 'DELETE', headers: { 'x-user': 'admin' } });
    console.log('✓ Revoked test API keys');

    console.log('\n========================================');
    console.log('ALL API USER GUIDE & TOKEN TESTS PASSED!');
    console.log('========================================');
  } finally {
    serverProc.kill();
  }
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
