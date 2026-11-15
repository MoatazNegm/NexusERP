// Cash / Bank balance (R34 round 2, validator D1, 2026-11-08). ONE formula for the server (Finance > Initial Balances,
// Balances & Stock Value, Dashboard: GET /api/v1/finance/position) and the Finance > Ledger tab ("Cash in Bank").
// Money enters or leaves the bank only through these events (each one is counted once):
//   + customer cash paid on a PO (order payments x order rate; wallet -> PO transfers and the wallet part of a pay-from-wallet are not cash)
//   + customer advances into a general / project wallet (ledger ADDITION adv_cust_*, money received, applied or not)
//   - customer refunds paid out of a wallet (ledger REFUND; a REFUND that voids a cancelled-PO payment is already
//     covered by the removed payment, so it is not taken twice)
//   + other manual additions to the bank (ledger ADDITION without a PO, not an advance, not a supplier refund, not already an order payment)
//   - supplier payments (gross; a supplier refund is a negative payment, an opening supplier advance is not cash)
//   - other manual costs (ledger COST that is not a supplier payment)
// Opening balances booked on Cash / Bank (ledger OPENING, accountKey BANK) are added by the caller.
// A cancelled (rejected) PO keeps its paid cash in the company (it moved to the customer general wallet), so its
// payments still count until they are voided or refunded.

import { isInternalStockOrder, orderFxRate, paymentLE } from './orderMoney.js';
// R34 round 5 (validator 4, item 7): the internal-stock test is the shared helper (also used by AR, stock value and the server).
const isInternalOrderCB = isInternalStockOrder;
const fxCB = orderFxRate;
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const isVoidRefund = (e) => Boolean(e.voidOfPayment) || String(e.description || '').startsWith('Payment VOIDED');

export const computeCashBank = (orders = [], ledger = [], supplierPayments = []) => {
    const led = Array.isArray(ledger) ? ledger : [];
    const byId = new Map();
    (orders || []).forEach(o => { if (o && o.id) byId.set(o.id, o); });
    // the wallet part of a pay-from-wallet payment: ledger TRANSFER wallet -> PO with the receipt of that payment (L.E.)
    // R34 round 7 (validator 6, defect 7): only while the payment with that receipt still exists on the order; a VOIDED pay-from-wallet
    // payment gave its wallet part back to the customer wallet (the advance money stays in Cash / Bank), so its TRANSFER no longer
    // takes anything off the order cash.
    const walletPartByOrder = new Map();
    led.forEach(e => {
        if (!e || e.type !== 'TRANSFER' || !e.orderId || !e.receiptNumber) return;
        const o = byId.get(e.orderId);
        if (o && !(o.payments || []).some(p => p && p.receiptNumber && String(p.receiptNumber) === String(e.receiptNumber))) return;
        walletPartByOrder.set(e.orderId, (walletPartByOrder.get(e.orderId) || 0) + (Number(e.amount) || 0));
    });
    // R34 round 3 (validator 2, item 1): order payments are typed in the ORDER currency, so they are converted at the order rate;
    // the wallet part (ledger TRANSFER) is already in L.E. Example: USD PO at rate 50, 100 USD paid in cash -> +5,000.00 L.E.
    // Item 2: the ledger ADDITION entries that were turned into an order payment (payment.ledgerEntryId) are counted once, as
    // that order payment, never again as a manual addition.
    let customerCashIn = 0;
    const paymentLedgerIds = new Set();
    (orders || []).forEach(o => {
        if (!o) return;
        (o.payments || []).forEach(p => { if (p && p.ledgerEntryId) paymentLedgerIds.add(p.ledgerEntryId); });
        if (isInternalOrderCB(o)) return;
        // R34 round 5 (validator 4, item 4): a payment entered in L.E. keeps its exact L.E. amount (amountLE), see shared/orderMoney.js
        const fx = fxCB(o);
        const cashLE = (o.payments || []).reduce((s, p) => s + (p && !p.transfer ? paymentLE(p, fx) : 0), 0);
        const walletPartLE = walletPartByOrder.get(o.id) || 0;
        customerCashIn += cashLE - walletPartLE;
    });
    const advancesIn = led.filter(e => e && e.type === 'ADDITION' && String(e.id || '').startsWith('adv_cust_')).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const refundsOut = led.filter(e => e && e.type === 'REFUND' && !isVoidRefund(e)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    // R34 round 4 (validator 3, D2): an ADDITION is an order payment (counted above) only when its orderId names an EXISTING order
    // or the entry is linked to an order payment (payment.ledgerEntryId); an orderId that matches no order is still bank money.
    const isOrderPaymentEntry = (e) => (e.orderId && byId.has(e.orderId)) || (e.id && paymentLedgerIds.has(e.id));
    const manualAdditions = led.filter(e => e && e.type === 'ADDITION' && !String(e.id || '').startsWith('adv_cust_') && !isOrderPaymentEntry(e) && e.category !== 'Supplier Refund').reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const manualCosts = led.filter(e => e && e.type === 'COST' && !String(e.id || '').startsWith('sp_ledg_') && e.category !== 'Supplier Payment').reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const supplierCashOut = (supplierPayments || []).reduce((s, p) => s + (p && !p.isOpening ? (Number(p.amount) || 0) : 0), 0);
    const balance = customerCashIn + advancesIn - refundsOut + manualAdditions - supplierCashOut - manualCosts;
    return {
        customerCashIn: r2(customerCashIn),
        advancesIn: r2(advancesIn),
        refundsOut: r2(refundsOut),
        manualAdditions: r2(manualAdditions),
        manualCosts: r2(manualCosts),
        supplierCashOut: r2(supplierCashOut),
        balance: r2(balance)
    };
};

// R35 (user order 2026-11-15): the SAME events as computeCashBank, one dated row each, for Finance > Account Status
// (money in / out of Cash / Bank in a date range). Every rule above is applied unchanged; the rows add up to
// computeCashBank(...).balance (proved by the R35 sheets). Rows: { date, amount (+ in, - out), source, description, ref }.
// The wallet part of a pay-from-wallet payment is taken off the payment that carries its receipt (same day), so a payment
// that was partly paid from the wallet shows only its cash part.
export const cashBankMovements = (orders = [], ledger = [], supplierPayments = []) => {
    const led = Array.isArray(ledger) ? ledger : [];
    const rows = [];
    const byId = new Map();
    (orders || []).forEach(o => { if (o && o.id) byId.set(o.id, o); });
    const walletPart = new Map(); // orderId|receipt -> L.E.
    led.forEach(e => {
        if (!e || e.type !== 'TRANSFER' || !e.orderId || !e.receiptNumber) return;
        const o = byId.get(e.orderId);
        if (o && !(o.payments || []).some(p => p && p.receiptNumber && String(p.receiptNumber) === String(e.receiptNumber))) return;
        const k = `${e.orderId}|${e.receiptNumber}`;
        walletPart.set(k, (walletPart.get(k) || 0) + (Number(e.amount) || 0));
    });
    const paymentLedgerIds = new Set();
    (orders || []).forEach(o => {
        if (!o) return;
        (o.payments || []).forEach(p => { if (p && p.ledgerEntryId) paymentLedgerIds.add(p.ledgerEntryId); });
        if (isInternalOrderCB(o)) return;
        const fx = fxCB(o);
        const taken = new Set();
        (o.payments || []).forEach(p => {
            if (!p || p.transfer) return;
            let amt = paymentLE(p, fx);
            const k = p.receiptNumber ? `${o.id}|${p.receiptNumber}` : null;
            if (k && walletPart.has(k) && !taken.has(k)) { amt -= walletPart.get(k); taken.add(k); }
            if (Math.abs(amt) > 0.004) rows.push({ date: p.date || o.orderDate || '', amount: r2(amt), source: 'ORDER_PAYMENT', description: `Customer payment ${o.customerName || ''} - PO ${o.internalOrderNumber || o.id}${p.receiptNumber ? ' (' + p.receiptNumber + ')' : ''}`, ref: o.internalOrderNumber || o.id });
        });
        // a wallet part whose receipt is on no cash payment of the order (only a transfer payment carries it) still comes off the order cash
        walletPart.forEach((v, k) => {
            if (taken.has(k) || !k.startsWith(`${o.id}|`)) return;
            const e = led.find(x => x && x.type === 'TRANSFER' && x.orderId === o.id && `${x.orderId}|${x.receiptNumber}` === k);
            if (Math.abs(v) > 0.004) rows.push({ date: (e && e.date) || '', amount: r2(-v), source: 'ORDER_PAYMENT', description: `Wallet part of a payment - PO ${o.internalOrderNumber || o.id}`, ref: o.internalOrderNumber || o.id });
        });
    });
    const isOrderPaymentEntry = (e) => (e.orderId && byId.has(e.orderId)) || (e.id && paymentLedgerIds.has(e.id));
    led.forEach(e => {
        if (!e) return;
        const amt = Number(e.amount) || 0;
        const base = { date: e.date || '', description: e.description || e.category || e.type, ref: e.id };
        if (e.type === 'ADDITION' && String(e.id || '').startsWith('adv_cust_')) rows.push({ ...base, amount: r2(amt), source: 'CUSTOMER_ADVANCE' });
        else if (e.type === 'REFUND' && !isVoidRefund(e)) rows.push({ ...base, amount: r2(-amt), source: 'CUSTOMER_REFUND' });
        else if (e.type === 'ADDITION' && !String(e.id || '').startsWith('adv_cust_') && !isOrderPaymentEntry(e) && e.category !== 'Supplier Refund') rows.push({ ...base, amount: r2(amt), source: 'LEDGER_ADDITION' });
        else if (e.type === 'COST' && !String(e.id || '').startsWith('sp_ledg_') && e.category !== 'Supplier Payment') rows.push({ ...base, amount: r2(-amt), source: 'LEDGER_COST' });
    });
    (supplierPayments || []).forEach(p => {
        if (!p || p.isOpening) return;
        const amt = Number(p.amount) || 0;
        if (Math.abs(amt) > 0.004) rows.push({ date: p.date || '', amount: r2(-amt), source: amt < 0 ? 'SUPPLIER_REFUND' : 'SUPPLIER_PAYMENT', description: `${amt < 0 ? 'Supplier refund' : 'Supplier payment'} ${p.supplierName || ''}${p.poNumber ? ' - PO ' + p.poNumber : ''}${p.memo ? ' - ' + p.memo : ''}`, ref: p.id });
    });
    return rows.filter(r => Math.abs(r.amount) > 0.004);
};
