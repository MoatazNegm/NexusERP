// Stock value for Finance (R34, user order 2026-11-08). Used by the server endpoint /api/v1/finance/position
// (Finance "Balances & stock value" tab and the Dashboard). The rules mirror the Inventory module
// (components/InventoryModule.tsx): component value = quantityInStock x lastCost, product value = quantity x
// product unit value AT COST (real cost per unit, else component cost per unit, else price per unit). Trade items are kept
// apart from component stock, as in Inventory. The product hub counts what is CURRENTLY in the hub (received - dispatched),
// without trading goods that are already counted in the warehouse.

const effQty = (item) => {
    const q = (item && item.alteredQty !== undefined && item.alteredQty !== null) ? item.alteredQty : (item && item.quantity);
    return q || 1;
};
const isStockOrderSV = (order) => {
    if (!order) return false;
    const cust = String(order.customerName || '').trim().toLowerCase();
    const po = typeof order.customerReferenceNumber === 'string' ? order.customerReferenceNumber.trim().toUpperCase() : '';
    return cust === 'internal stock' || po.startsWith('STOCK-');
};
const poTypeSV = (order) => {
    if (isStockOrderSV(order)) return 'Stock';
    if (order && (order.blanketOrder || order.contractId || order.blanketContractId)) return 'Blanket';
    const items = (order && order.items) || [];
    if (items.some(i => ['MANUFACTURING', 'OUTSOURCING'].includes(String(i.productionType || '').toUpperCase().trim()))) return 'Manufacturing';
    if (items.some(i => String(i.productionType || '').toUpperCase().trim() === 'TRADING')) return 'Trade';
    return 'Manufacturing';
};
const findOrderByRef = (orders, ref) => orders.find(o => o.internalOrderNumber === ref || o.customerReferenceNumber === ref);
const isComponentPoLinkedSV = (inv, orders) => {
    if (!inv.orderRef) return false;
    const ref = String(inv.orderRef).trim().toUpperCase();
    if (ref === 'STOCK' || ref.startsWith('STOCK-')) return false;
    const order = findOrderByRef(orders, inv.orderRef);
    if (order && isStockOrderSV(order)) return false;
    return true;
};
const isItemTradeSV = (inv, orders) => {
    if (!inv.orderRef) return false;
    const order = findOrderByRef(orders, inv.orderRef);
    if (!order || isStockOrderSV(order)) return false;
    if (poTypeSV(order) === 'Trade') return true;
    return (order.items || []).some(it => it.productionType === 'TRADING' && (
        (it.components || []).some(c => c.inventoryItemId === inv.id || c.componentNumber === inv.sku || c.description === inv.description) ||
        it.orderNumber === inv.sku || it.description === inv.description));
};
// D3 (supervisor ruling 2026-11-08): finished products are valued at COST: the line's real cost per unit, then the
// component cost per unit, the selling price only as the last fallback (nothing else known).
const productUnitValueSV = (item) => {
    if (item.realCost && item.realCost > 0) return Number(item.realCost);
    const compTotal = (item.components || []).reduce((s, c) => s + ((c.quantity || 0) * (c.unitCost || 0)), 0);
    const q = effQty(item) || 1;
    if (compTotal > 0 && q > 0) return compTotal / q;
    if (item.pricePerUnit && item.pricePerUnit > 0) return Number(item.pricePerUnit);
    return 0;
};
// D2: a trading line's goods that sit in the warehouse (supplier parts received via the warehouse, or warehouse stock
// allocated to the line) are already counted as inventory (trading goods / components) until they are delivered;
// they are not counted again as product-hub stock (server.js transferReceivedItemsToFreeStock subtracts them the same way).
const warehouseBackedQtySV = (item) => (item.components || []).reduce((s, c) => {
    if (c.viaWarehouse) return s + Math.max(0, (Number(c.receivedQty) || 0) - (Number(c.consumedQty) || 0));
    if (c.source === 'STOCK' && c.inventoryItemId) return s + Math.max(0, (Number(c.quantity) || 0) - (Number(c.consumedQty) || 0));
    return s;
}, 0);
const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

export const STOCK_CATEGORIES = [
    { key: 'product_hub', onHand: true, label: 'Finished products in the product hub', labelAr: 'منتجات تامة في مخزن المنتجات' },
    { key: 'components_po', onHand: true, label: 'Components reserved for customer POs', labelAr: 'مكونات محجوزة لأوامر العملاء' },
    { key: 'components_free', onHand: true, label: 'Free stock (ordered for stock, not tied to a PO)', labelAr: 'مخزون حر (مطلوب للمخزون وغير مرتبط بأمر)' },
    { key: 'trading_goods', onHand: true, label: 'Trading goods in the warehouse', labelAr: 'بضائع تجارية في المخزن' },
    { key: 'transit_po', onHand: false, label: 'In transit for customer POs (ordered, not received)', labelAr: 'في الطريق لأوامر العملاء (مطلوب ولم يستلم)' },
    { key: 'transit_stock', onHand: false, label: 'In transit, ordered for stock (not received)', labelAr: 'في الطريق للمخزون (مطلوب ولم يستلم)' }
];

export const computeStockValue = (inventory = [], orders = []) => {
    const cats = {};
    STOCK_CATEGORIES.forEach(c => { cats[c.key] = { ...c, value: 0, quantity: 0, lines: 0, items: [] }; });
    const add = (key, row) => {
        const c = cats[key];
        c.value += row.value; c.quantity += row.quantity; c.lines += 1;
        c.items.push({ ...row, value: r2(row.value), unitValue: r2(row.unitValue) });
    };
    (inventory || []).forEach(inv => {
        const qty = Number(inv.quantityInStock) || 0;
        const unit = Number(inv.lastCost) || 0;
        if (qty === 0) return;
        const row = { id: inv.id, sku: inv.sku || '', description: inv.description || '', ref: inv.orderRef || 'STOCK', quantity: qty, unitValue: unit, value: qty * unit };
        if (isItemTradeSV(inv, orders)) add('trading_goods', row);
        else if (isComponentPoLinkedSV(inv, orders)) add('components_po', row);
        else add('components_free', row);
    });
    (orders || []).forEach(order => {
        if (order.status === 'REJECTED') return;
        (order.items || []).forEach(item => {
            if (!isStockOrderSV(order)) {
                const inWarehouse = item.productionType === 'TRADING' ? warehouseBackedQtySV(item) : 0;
                const inHub = Math.max(0, (Number(item.hubReceivedQty) || 0) - (Number(item.dispatchedQty) || 0) - inWarehouse);
                if (inHub > 0) {
                    const unit = productUnitValueSV(item);
                    add('product_hub', { id: `${order.id}:${item.id}`, sku: order.internalOrderNumber || '', description: item.description || '', ref: order.customerReferenceNumber || order.internalOrderNumber || '', customerName: order.customerName, quantity: inHub, unitValue: unit, value: inHub * unit });
                }
            }
            (item.components || []).forEach(comp => {
                if (comp.status !== 'ORDERED' && comp.status !== 'ORDERED_FOR_STOCK') return;
                const pending = Math.max(0, (Number(comp.quantity) || 0) - (Number(comp.receivedQty) || 0));
                if (pending <= 0) return;
                const unit = Number(comp.unitCost) || 0;
                const forStock = comp.status === 'ORDERED_FOR_STOCK' || isStockOrderSV(order);
                add(forStock ? 'transit_stock' : 'transit_po', { id: comp.id, sku: comp.componentNumber || comp.partNumber || '', description: comp.description || '', ref: comp.poNumber || order.internalOrderNumber || '', customerName: order.customerName, quantity: pending, unitValue: unit, value: pending * unit });
            });
        });
    });
    const categories = STOCK_CATEGORIES.map(c => { const x = cats[c.key]; return { ...x, value: r2(x.value), quantity: r2(x.quantity) }; });
    const totalOnHand = r2(categories.filter(c => c.onHand).reduce((s, c) => s + c.value, 0));
    const totalInTransit = r2(categories.filter(c => !c.onHand).reduce((s, c) => s + c.value, 0));
    return { categories, totalOnHand, totalInTransit, totalWithTransit: r2(totalOnHand + totalInTransit) };
};
