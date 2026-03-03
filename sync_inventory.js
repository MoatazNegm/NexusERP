import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, 'db.json');

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

const getReservedMap = (order) => {
    const map = new Map();
    if (!order) return map;
    (order.items || []).forEach(item => {
        (item.components || []).forEach(comp => {
            if (comp.inventoryItemId && (comp.source === 'STOCK' || comp.source === 'CONSUMED' || comp.status === 'RECEIVED')) {
                const current = map.get(comp.inventoryItemId) || 0;
                map.set(comp.inventoryItemId, current + (comp.quantity || 0));
            }
        });
    });
    return map;
};

const runSync = () => {
    console.log("Starting full inventory reservation sync...");
    const db = readDb();

    if (!db.inventory) {
        console.log("No inventory found.");
        return;
    }

    // Reset all reservations to 0 first
    db.inventory.forEach(inv => {
        inv.quantityReserved = 0;
    });

    // Run through all orders and sum reservations
    const overallMap = new Map();
    (db.orders || []).forEach(order => {
        if (order.status !== 'REJECTED' && order.status !== 'FULFILLED') {
            const orderMap = getReservedMap(order);
            orderMap.forEach((qty, id) => {
                const current = overallMap.get(id) || 0;
                overallMap.set(id, current + qty);
            });

            // Retroactively add PO and Order info to inventory items from RECEIVED components
            (order.items || []).forEach(item => {
                (item.components || []).forEach(comp => {
                    if (comp.inventoryItemId && comp.status === 'RECEIVED') {
                        const invItem = db.inventory.find(inv => inv.id === comp.inventoryItemId);
                        if (invItem) {
                            if (comp.poNumber) invItem.poNumber = comp.poNumber;
                            invItem.orderRef = order.internalOrderNumber;
                        }
                    }
                });
            });
        }
    });

    // Apply the summed reservations to inventory
    overallMap.forEach((qty, id) => {
        const invItem = db.inventory.find(inv => inv.id === id);
        if (invItem) {
            invItem.quantityReserved = qty;
        }
    });

    if (writeDb(db)) {
        console.log("Inventory successfully synchronized.");
    } else {
        console.error("Failed to write updated database.");
    }
};

runSync();
