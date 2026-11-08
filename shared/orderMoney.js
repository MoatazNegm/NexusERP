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
