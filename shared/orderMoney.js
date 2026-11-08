// Shared order money helpers (R34 round 5, validator 4 items 4, 6, 7). ONE implementation for the server (server.js), Cash / Bank
// (shared/cashBank.js), AR / AP (shared/arap.js), stock value (shared/stockValue.js) and the Finance > Ledger tab.

// Item 7: an order of the company itself (customer 'Internal Stock', or a customer PO reference starting with 'STOCK-') is an
// internal stock order: no sale, no receivable, its money is no customer cash.
export const isInternalStockOrder = (o) => {
    if (!o) return false;
    const cust = String(o.customerName || '').trim().toLowerCase();
    const ref = typeof o.customerReferenceNumber === 'string' ? o.customerReferenceNumber.trim().toUpperCase() : '';
    return cust === 'internal stock' || ref.startsWith('STOCK-');
};

// The order rate: prices and customer payments are typed in the order currency; a non-L.E. order is converted at this rate.
export const orderFxRate = (o) => (o && o.currency && o.currency !== 'L.E.' && Number(o.conversionRate) > 0) ? Number(o.conversionRate) : 1;

const r2m = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

// Item 4: a payment that was entered in L.E. on a foreign-currency PO (ledger ADDITION naming the PO, account transfer from / to
// a wallet) keeps the exact L.E. amount in `amountLE`; its `amount` is the order-currency figure (L.E. / rate, rounded to 2
// decimals). Every L.E. figure (Cash / Bank, AR, PO wallet, Ledger tab) uses `amountLE` when it is there, so 5,000 L.E. at rate
// 47.3 stays 5,000.00 L.E. (and not 105.71 x 47.3 = 5,000.08).
export const paymentLE = (p, fx) => {
    if (!p) return 0;
    if (p.amountLE !== undefined && p.amountLE !== null && Number.isFinite(Number(p.amountLE))) return Number(p.amountLE);
    return (Number(p.amount) || 0) * (fx || 1);
};

// The L.E. value of the payments of an order (optionally only some of them).
export const orderPaymentsLE = (order, filter = null) => {
    const fx = orderFxRate(order);
    return r2m((order && order.payments || []).reduce((s, p) => s + ((!filter || filter(p)) ? paymentLE(p, fx) : 0), 0));
};

// R34 round 6 (validator 5, O5): closing a blanket contract (finance decision, ruling R27) settles what was CALLED OFF. The rulings
// (R27 / R28 / R29) say nothing about VAT at the close, so the coder rule is: the contract's own lines are no sale once it is
// closed (its closed value is the called-off gross, carried by the call-offs); the call-offs of a closed contract are realized
// (output VAT and profit on the called-off value only, counted once, whether or not the call-off itself was invoiced).
export const isBlanketRootOrder = (o) => Boolean(o && o.blanketOrder && !o.blanketContractId);
export const isClosedBlanketRoot = (o) => isBlanketRootOrder(o) && Boolean(o.contractClosed);
export const blanketRootOf = (o, orders = []) => {
    if (!o || !o.blanketContractId || !String(o.blanketContractId).trim()) return null;
    const ref = String(o.blanketContractId).trim(); // R34 round 10: a stored reference with stray spaces still names its contract
    return (orders || []).find(p => p && p.blanketOrder && p.status !== 'REJECTED' && (p.id === ref || p.internalOrderNumber === ref || p.customerReferenceNumber === ref)) || null;
};
const INVOICED_STATUSES = ['INVOICED', 'HUB_RELEASED', 'DELIVERED', 'WAITING_GOVE', 'FULFILLED'];
// An order whose sale is realized for the ledger (output VAT, realized profit): invoiced (status or invoice number), or a call-off
// of a closed blanket contract.
export const isRealizedSale = (o, orders = []) => {
    if (!o || o.status === 'REJECTED') return false;
    if (INVOICED_STATUSES.includes(o.status) || Boolean(o.invoiceNumber)) return true;
    const root = blanketRootOf(o, orders);
    return Boolean(root && root.contractClosed);
};
// Do the order's own lines count as a sale (revenue / output VAT)? Not for a closed blanket contract.
export const ownLinesAreSales = (o) => !isClosedBlanketRoot(o);
