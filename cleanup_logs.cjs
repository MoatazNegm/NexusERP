
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

const userDrivenMessages = [
  'Entity registered',
  'Record updated',
  'Order modified',
  'Technical study finalized',
  'Production Started',
  'Production Finished',
  'Hub Intake',
  'Official Tax Invoice Generated',
  'Shipment Released',
  'Customer Delivery Confirmed',
  'Tender batch',
  'Issued PO batch',
  'Cancelled PO',
  'Payment of',
  'Order placed in STRATEGIC HOLD',
  'Order released from Hold',
  'Margin block manually bypassed',
  'Full payment reconciled',
  'Full payment received',
  'Manufactured ',
  'PO Received at Product Hub',
  'Finance Partial Receipt for Dispatch',
  'Items transitioned to IN TRANSIT',
  'Gov. E-Invoice requested',
  'Gov. E-Invoice Attached'
];

function cleanup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('db.json not found');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  let updatedCount = 0;

  // Function to process logs
  const processLogs = (logs) => {
    if (!logs || !Array.isArray(logs)) return;
    logs.forEach(log => {
      if (log.user === 'System') {
        // Only change if it's NOT an automated alert (no [SYSTEM] or [AUTO])
        const isAutomated = log.message.includes('[SYSTEM]') || log.message.includes('[AUTO]');
        if (!isAutomated) {
          // Check if the message matches known user actions
          const isUserDriven = userDrivenMessages.some(m => log.message.includes(m));
          if (isUserDriven) {
            log.user = 'admin'; // Attribution to main admin for recovery
            updatedCount++;
          }
        }
      }
    });
  };

  // Iterate over all collections that have logs
  const collections = ['orders', 'customers', 'suppliers', 'inventory', 'users', 'userGroups'];
  collections.forEach(col => {
    if (db[col]) {
      db[col].forEach(item => {
        processLogs(item.logs);
        // Also check sub-items like order items
        if (col === 'orders' && item.items) {
          item.items.forEach(orderItem => {
            processLogs(orderItem.logs);
          });
        }
      });
    }
  });

  if (updatedCount > 0) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    console.log(`Successfully recovered ${updatedCount} log entries to 'admin'.`);
  } else {
    console.log('No misattributed logs found for specific user actions.');
  }
}

cleanup();
