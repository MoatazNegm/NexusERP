import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'db_test.json');
if (!fs.existsSync(dbPath)) {
  console.log('db_test.json not found');
  process.exit(0);
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

let migrated = false;

(db.orders || []).forEach(order => {
  (order.items || []).forEach((item, idx) => {
    if (!item.id) {
      item.id = `item_migrated_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`;
      migrated = true;
      console.log(`Migrated item without ID in order ${order.internalOrderNumber} -> ${item.id}`);
    }
  });
});

if (migrated) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  console.log('Migration completed and saved to db_test.json');
} else {
  console.log('No items needed migration.');
}
