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
// R34 round 12 (validator 11, defects 1 and 2): ONE link rule. A call-off names its contract in blanketContractId by the contract's id,
// internal number or customer reference; both sides are compared trimmed (a stored reference or contract number with stray spaces
// still links). Every guard, the close action, the drawdown, revenue and AR resolve the link with these helpers.
export const trimRef = (v) => (v === undefined || v === null) ? '' : String(v).trim();
export const refNamesOrder = (ref, p) => {
    const r = trimRef(ref);
    return Boolean(r && p && (trimRef(p.id) === r || trimRef(p.internalOrderNumber) === r || trimRef(p.customerReferenceNumber) === r));
};
// R34 round 13 (validator 12, defects 1 and 5): the link never crosses customers and resolves in a FIXED priority. Only the live
// (non-rejected) blanket contracts (blanketOrder, no blanketContractId of their own) of the call-off's OWN customer (names compared
// trimmed, case-insensitive) are candidates; among them the link names the contract whose id matches, else whose internal number
// matches, else whose customer reference matches. A link that names another customer's contract, a rejected contract or a normal
// order resolves to no contract (the call-off is then an ordinary order); the POST / PUT link refuses it with the reason below.
// ONE rule for the close, the drawdown, the guards, the void take-back, the orders report, AR and the project-name lookups.
export const sameCustomerName = (a, b) => trimRef(a).toLowerCase() === trimRef(b).toLowerCase();
export const isRejectedStatus = (s) => trimRef(s).toUpperCase() === 'REJECTED';
const isBlanketRootShape = (p) => Boolean(p && p.blanketOrder && !trimRef(p.blanketContractId));
export const BLANKET_LINK_KEYS = ['id', 'internalOrderNumber', 'customerReferenceNumber'];
// Returns { root, key } for a valid link, else { root: null, reason, hit } with reason EMPTY | NOT_FOUND | NOT_BLANKET | CANCELLED |
// OTHER_CUSTOMER (hit = the order the reference names, by the same key priority).
export const resolveBlanketLink = (ref, orders = [], customerName = '', excludeId = null) => {
    const r = trimRef(ref);
    if (!r) return { root: null, reason: 'EMPTY', hit: null };
    const list = orders || [];
    const usable = (p) => Boolean(p) && (excludeId === null || excludeId === undefined || p.id !== excludeId);
    const live = (p) => isBlanketRootShape(p) && !isRejectedStatus(p.status) && sameCustomerName(p.customerName, customerName);
    for (const k of BLANKET_LINK_KEYS) {
        const hit = list.find(p => usable(p) && live(p) && trimRef(p[k]) === r);
        if (hit) return { root: hit, key: k };
    }
    for (const k of BLANKET_LINK_KEYS) {
        // a customer reference is free text (many normal POs share one); only a blanket contract counts as a hit by reference
        const cands = list.filter(p => usable(p) && trimRef(p[k]) === r && (k !== 'customerReferenceNumber' || isBlanketRootShape(p)));
        if (!cands.length) continue;
        const own = cands.find(p => sameCustomerName(p.customerName, customerName));
        const liveOther = cands.find(p => isBlanketRootShape(p) && !isRejectedStatus(p.status));
        if (!own && liveOther) return { root: null, reason: 'OTHER_CUSTOMER', hit: liveOther, key: k };
        const pick = own || cands[0];
        if (isBlanketRootShape(pick) && isRejectedStatus(pick.status)) return { root: null, reason: 'CANCELLED', hit: pick, key: k };
        if (!isBlanketRootShape(pick)) return { root: null, reason: 'NOT_BLANKET', hit: pick, key: k };
        return { root: null, reason: 'OTHER_CUSTOMER', hit: pick, key: k };
    }
    return { root: null, reason: 'NOT_FOUND', hit: null };
};
// The user-facing refusal of a link that does not resolve (POST / PUT of a call-off); null when it resolves to a contract.
export const blanketLinkRefusal = (ref, res, customerName) => {
    if (!res || res.root) return null;
    const r = trimRef(ref), h = res.hit;
    if (res.reason === 'EMPTY' || res.reason === 'NOT_FOUND') return `Blanket contract "${r}" not found.`;
    if (res.reason === 'NOT_BLANKET') return `Blanket contract "${r}" is not a blanket order.`;
    if (res.reason === 'CANCELLED') return `Blanket contract "${r}" is cancelled (REJECTED); no call-off can be raised on it or linked to it.`;
    return `Blanket contract "${r}" belongs to customer "${trimRef(h && h.customerName)}"; a call-off of customer "${trimRef(customerName)}" cannot be linked to it (a call-off and its blanket contract must have the same customer).`;
};
export const blanketRootOf = (o, orders = []) => {
    if (!o) return null;
    const ref = trimRef(o.blanketContractId); // R34 round 10: a stored reference with stray spaces still names its contract
    if (!ref) return null;
    return resolveBlanketLink(ref, orders, o.customerName, o.id).root || null;
};
// R34 round 13: the link map (call-off id -> resolved contract id or '') of every live (non-rejected) order with a link; the generic order
// edit and the order create compare it before / after the change, so no change of another order moves or drops a call-off silently.
// A rejected call-off no longer draws on its contract (round 12), so a rename of the contract it named stays allowed.
export const blanketLinkMap = (orders = []) => {
    const m = new Map();
    (orders || []).forEach(c => { if (c && trimRef(c.blanketContractId) && !isRejectedStatus(c.status)) { const r = blanketRootOf(c, orders); m.set(c.id, r ? r.id : ''); } });
    return m;
};
// The call-offs of a blanket contract: the orders whose link resolves (blanketRootOf) to this contract. Rejected call-offs are left
// out unless includeRejected (a rejected call-off no longer draws on the contract).
export const callOffsOfBlanket = (root, orders = [], includeRejected = false) => {
    if (!root || !root.blanketOrder || trimRef(root.blanketContractId)) return [];
    return (orders || []).filter(c => {
        if (!c || c === root || c.id === root.id || !trimRef(c.blanketContractId)) return false;
        if (!includeRejected && isRejectedStatus(c.status)) return false;
        const r = blanketRootOf(c, orders);
        return Boolean(r && (r === root || r.id === root.id));
    });
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
