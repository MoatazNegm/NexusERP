// Accounts Receivable / Accounts Payable (R30, R34). ONE implementation for the server (/api/v1/ar, /api/v1/ap,
// Finance > Initial Balances, Balances & Stock Value, Dashboard) and the Finance > Ledger tab (R34 round 3, validator 2
// item 6: the Ledger tab AR/AP are the same figures as /ar, /ap and Initial Balances).
// AR (in L.E.; a foreign-currency order x its rate, round 4 D3) = every open (non-rejected) order: committed gross (net of the 1% withholding the customer keeps; a blanket order commits
//      nothing by itself, its call-offs do) minus the money received on it, plus the customer-level AR openings.
// AP = every ISSUED supplier PO component (not NEW / PENDING_OFFER / RFP_SENT / AWARDED / CANCELLED), gross (net + tax),
//      minus the supplier payments allocated to it, plus the supplier-level AP openings.

import { isInternalStockOrder, orderFxRate, orderPaymentsLE, refNamesOrder, isClosedBlanketRoot, callOffsOfBlanket } from './orderMoney.js';

const REJECTED = 'REJECTED';
const r2w = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const effQtyAP = (item) => {
    const qty = (item && item.alteredQty !== undefined && item.alteredQty !== null) ? item.alteredQty : (item && item.quantity);
    return qty || 1;
};
export const orderWhtAmountAP = (order) => {
    let net = 0;
    (order.items || []).forEach(it => { net += Math.round(((effQtyAP(it) || 0) * (it.pricePerUnit || 0) + Number.EPSILON) * 100) / 100; });
    return Math.round(net) / 100;
};
export const orderCommitmentGrossAP = (order) => {
    if (order.blanketOrder && order.contractClosed && order.closedDeliveredGross !== undefined) return r2w(order.closedDeliveredGross);
    let gross = 0, cost = 0;
    (order.items || []).forEach(it => {
        gross += (effQtyAP(it) || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
        (it.components || []).forEach(c => { cost += (c.quantity || 0) * (c.unitCost || 0); });
    });
    return r2w(gross > 0 ? gross : cost);
};
// money received from the customer on this PO (account transfers in/out of the PO included)
export const orderPaidInAP = (order) => {
    const paid = r2w((order.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    if (order.status === REJECTED) return Math.max(0, r2w(paid - (Number(order.paymentMovedToWallet) || 0)));
    return r2w(paid - (Number(order.surplusMovedToWallet) || 0));
};
// R34 round 4 (validator 3, D3): an order is typed in its own currency; AR (like Cash / Bank and the wallets) is in L.E., so a
// foreign-currency order's commitment and the money received on it are converted at the order rate.
export const orderFxAP = orderFxRate;
// R34 round 5 (validator 4, item 4): the money received on a PO in L.E. Payments entered in L.E. keep their exact L.E. amount
// (amountLE); the money moved from the PO to the customer general wallet (cancelled PO, surplus above the PO gross) is taken off
// at the L.E. value that was credited to the wallet (paymentMovedToWalletLE / surplusMovedToWalletLE, else x the rate).
export const orderPaidInLE = (order) => {
    if (!order) return 0;
    const fx = orderFxRate(order);
    const paidLE = orderPaymentsLE(order);
    const movedLE = (le, oc) => (le !== undefined && le !== null && Number.isFinite(Number(le))) ? Number(le) : (Number(oc) || 0) * fx;
    if (order.status === REJECTED) return Math.max(0, r2w(paidLE - movedLE(order.paymentMovedToWalletLE, order.paymentMovedToWallet)));
    return r2w(paidLE - movedLE(order.surplusMovedToWalletLE, order.surplusMovedToWallet));
};
const orderProjectNameAP = (order, orders = []) => {
    let proj = String((order.projectName || '').trim());
    if (!proj && order.blanketContractId) {
        const parent = orders.find(p => refNamesOrder(order.blanketContractId, p) && p.status !== REJECTED);
        if (parent && parent.projectName) proj = String(parent.projectName).trim();
    }
    return proj;
};

// The receivable committed by one order in L.E. (a blanket contract commits nothing by itself; the 1% withholding is no receivable).
const orderCommittedLE = (o) => o.blanketOrder ? 0 : r2w(r2w(orderCommitmentGrossAP(o) - (o.appliesWithholdingTax ? orderWhtAmountAP(o) : 0)) * orderFxAP(o));
// R34 round 12 (validator 11, defect 5): the money a CLOSED blanket contract keeps after its close (paid - the surplus moved to the
// customer general wallet) is the payment for its call-offs. Per order it is applied to the open call-offs of that contract (same
// customer, in order), up to what each still owes; the contract row shows it as applied. The totals do not change; the call-off of a
// closed contract that the contract money covers shows 0 owing. Returns { covered: Map callOffId -> L.E., applied: Map rootId -> L.E. }.
export const closedContractCoverage = (orders = []) => {
    const covered = new Map(), applied = new Map();
    (orders || []).forEach(root => {
        if (!root || root.status === REJECTED || !isClosedBlanketRoot(root) || isInternalStockOrder(root)) return;
        let avail = r2w(orderPaidInLE(root));
        if (avail <= 0.004) return;
        let used = 0;
        callOffsOfBlanket(root, orders).forEach(c => {
            if (avail <= 0.004 || isInternalStockOrder(c) || String(c.customerName || '') !== String(root.customerName || '')) return;
            const open = r2w(orderCommittedLE(c) - orderPaidInLE(c) - (covered.get(c.id) || 0));
            if (open <= 0.004) return;
            const take = r2w(Math.min(open, avail));
            covered.set(c.id, r2w((covered.get(c.id) || 0) + take));
            avail = r2w(avail - take); used = r2w(used + take);
        });
        if (used > 0.004) applied.set(root.id, used);
    });
    return { covered, applied };
};
// What an order still owes in L.E. after the closed-contract coverage (the byOrder receivable).
export const orderReceivableLE = (order, orders = []) => {
    if (!order || order.status === REJECTED || isInternalStockOrder(order)) return 0;
    const { covered, applied } = closedContractCoverage(orders);
    return r2w(Math.max(0, orderCommittedLE(order) - (orderPaidInLE(order) + (covered.get(order.id) || 0) - (applied.get(order.id) || 0))));
};

export const computeReceivables = (orders = [], ledger = null, customers = null) => {
    const rows = [];
    const cov = closedContractCoverage(orders);
    orders.forEach(o => {
        if (o.status === REJECTED) return;
        // R34 round 3 (item 6): the 'Internal Stock' customer is the company itself (stock orders), never a debtor; its orders are
        // no receivable (Initial Balances never listed that customer, so /ar, Initial Balances and the Ledger tab now agree).
        // R34 round 5 (validator 4, item 7): a customer PO reference 'STOCK-...' is an internal stock order as well (shared helper,
        // the same test as Cash / Bank, stock value and the server).
        if (isInternalStockOrder(o)) return;
        // A blanket order commits nothing by itself: the customer owes what is CALLED OFF (each call-off carries its own amount).
        // The 1% withholding the customer keeps (base NET) is cleared in the Tax tab: it is not a receivable (ruling 2026-10-21 22:08).
        const fx = orderFxAP(o);
        const committedOC = o.blanketOrder ? 0 : r2w(orderCommitmentGrossAP(o) - (o.appliesWithholdingTax ? orderWhtAmountAP(o) : 0));
        const covLE = cov.covered.get(o.id) || 0, appLE = cov.applied.get(o.id) || 0; // R34 round 12: closed-contract coverage
        const paidOC = r2w(orderPaidInAP(o) + (covLE - appLE) / fx);
        const committed = r2w(committedOC * fx), paid = r2w(orderPaidInLE(o) + covLE - appLE);
        const row = { orderId: o.id, internalOrderNumber: o.internalOrderNumber, customerName: o.customerName, projectName: orderProjectNameAP(o, orders) || '(No Project)', status: o.status, blanketOrder: Boolean(o.blanketOrder), committed, paid, receivable: r2w(Math.max(0, committed - paid)), overpaid: r2w(Math.max(0, paid - committed)) };
        if (covLE > 0.004) row.coveredByContract = r2w(covLE);
        if (appLE > 0.004) row.appliedToCallOffs = r2w(appLE);
        if (fx !== 1) Object.assign(row, { currency: o.currency, conversionRate: fx, committedOrderCurrency: committedOC, paidOrderCurrency: paidOC, receivableOrderCurrency: r2w(Math.max(0, committedOC - paidOC)) });
        rows.push(row);
    });
    const group = (keyFn, extra) => { const m = new Map(); rows.forEach(r => { const k = keyFn(r); if (!m.has(k)) m.set(k, { ...extra(r), committed: 0, paid: 0, receivable: 0 }); const e = m.get(k); e.committed = r2w(e.committed + r.committed); e.paid = r2w(e.paid + r.paid); e.receivable = r2w(Math.max(0, e.committed - e.paid)); }); return Array.from(m.values()); };
    const byCustomer = group(r => r.customerName, r => ({ customerName: r.customerName }));
    // R34: opening AR balances (per customer) are added on top of the order-based receivable. M3: the opening is keyed by the
    // customer ID (accountKey AR:<id>); the current customer name is looked up, so a renamed customer keeps its opening.
    // Openings are customer-level (no project, no PO): they are in byCustomer and the total, not in byOrder / byProject.
    if (ledger) {
        const ob = new Map();
        ledger.forEach(l => {
            if (!(l && l.type === 'OPENING' && String(l.accountKey || '').startsWith('AR:'))) return;
            const cid = String(l.accountKey).slice(3);
            const cust = Array.isArray(customers) ? customers.find(c => c && c.id === cid) : null;
            const name = (cust && cust.name) || l.customerName;
            if (!name) return;
            const e0 = ob.get(cid) || { name, customerId: cid, amount: 0 };
            e0.name = name; e0.amount = r2w(e0.amount + (Number(l.amount) || 0));
            ob.set(cid, e0);
        });
        ob.forEach(({ name, customerId, amount }) => {
            let e = byCustomer.find(c => c.customerName === name);
            if (!e) { e = { customerName: name, committed: 0, paid: 0, receivable: 0 }; byCustomer.push(e); }
            e.customerId = customerId;
            e.openingBalance = r2w((e.openingBalance || 0) + amount);
            e.receivable = r2w(e.receivable + amount);
        });
    }
    // every customer row carries its customer ID when the customer record is known (the name is only the display label)
    if (Array.isArray(customers)) byCustomer.forEach(e => { if (!e.customerId) { const c = customers.find(x => x && x.name === e.customerName); if (c && c.id) e.customerId = c.id; } });
    return {
        total: r2w(byCustomer.reduce((s, r) => s + r.receivable, 0)),
        byOrder: rows,
        byCustomer,
        byProject: group(r => r.customerName + '|' + r.projectName, r => ({ customerName: r.customerName, projectName: r.projectName }))
    };
};

// AP: what the company still owes suppliers (gross), per supplier / PO / project. db = { orders, supplierPayments, suppliers, ledger }.
export const computePayables = (db) => {
    const orders = db.orders || [], sps = db.supplierPayments || [];
    const allocPerComp = {}, allocPerOrder = {};
    sps.forEach(sp => {
        (sp.allocations || []).forEach(a => { allocPerComp[a.componentId] = (allocPerComp[a.componentId] || 0) + (Number(a.amount) || 0); });
    });
    const supName = id => (db.suppliers || []).find(s => s.id === id)?.name || 'Unknown';
    const rows = [];
    orders.forEach(o => {
        if (o.status === REJECTED) return;
        const byOrderSupplier = new Map();
        (o.items || []).forEach(it => (it.components || []).forEach(comp => {
            if (!(comp.source === 'PROCUREMENT' || comp.source === 'CONSUMED') || ['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(comp.status)) return;
            const mul = 1 + ((comp.taxPercent !== undefined && comp.taxPercent !== null ? Number(comp.taxPercent) : 14) / 100);
            const committed = ((comp.quantity || 0) + (comp.allocatedQty || 0)) * (comp.unitCost || 0) * mul;
            const k = comp.supplierId || comp.supplierName || '';
            if (!byOrderSupplier.has(k)) byOrderSupplier.set(k, { supplierId: comp.supplierId, supplierName: comp.supplierId ? supName(comp.supplierId) : (comp.supplierName || 'Unknown'), committed: 0, paid: 0 });
            const e = byOrderSupplier.get(k); e.committed += committed; e.paid += Math.min(committed, allocPerComp[comp.id] || 0);
        }));
        let loose = allocPerOrder[o.id] || 0;
        byOrderSupplier.forEach(e => { const take = Math.min(loose, Math.max(0, e.committed - e.paid)); e.paid += take; loose -= take; });
        byOrderSupplier.forEach(e => rows.push({ orderId: o.id, internalOrderNumber: o.internalOrderNumber, projectName: orderProjectNameAP(o, orders) || '(No Project)', customerName: o.customerName, supplierId: e.supplierId, supplierName: e.supplierName, committed: r2w(e.committed), paid: r2w(e.paid), payable: r2w(Math.max(0, e.committed - e.paid)) }));
    });
    const group = (keyFn, extra) => { const m = new Map(); rows.forEach(r => { const k = keyFn(r); if (!m.has(k)) m.set(k, { ...extra(r), committed: 0, paid: 0, payable: 0 }); const e = m.get(k); e.committed = r2w(e.committed + r.committed); e.paid = r2w(e.paid + r.paid); e.payable = r2w(e.payable + r.payable); }); return Array.from(m.values()); };
    // R34: opening AP balances (per supplier) are added on top of the PO-based payable.
    const bySupplier = group(r => r.supplierId || r.supplierName, r => ({ supplierId: r.supplierId, supplierName: r.supplierName }));
    let openingTotal = 0;
    (db.ledger || []).forEach(l => {
        if (!(l && l.type === 'OPENING' && String(l.accountKey || '').startsWith('AP:'))) return;
        const sid = String(l.accountKey).slice(3), amt = Number(l.amount) || 0;
        let e = bySupplier.find(x => x.supplierId === sid);
        if (!e) { e = { supplierId: sid, supplierName: supName(sid), committed: 0, paid: 0, payable: 0 }; bySupplier.push(e); }
        e.openingBalance = r2w((e.openingBalance || 0) + amt);
        e.payable = r2w(e.payable + amt);
        openingTotal += amt;
    });
    return {
        total: r2w(rows.reduce((s, r) => s + r.payable, 0) + openingTotal),
        byOrderSupplier: rows,
        byOrder: group(r => r.orderId, r => ({ orderId: r.orderId, internalOrderNumber: r.internalOrderNumber, projectName: r.projectName })),
        bySupplier,
        byProject: group(r => r.projectName, r => ({ projectName: r.projectName }))
    };
};
