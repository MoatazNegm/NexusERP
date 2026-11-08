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
