// Shared order permission rule used by both client and server (v1.0001227, supervisor ruling 2026-11-11).
// Rolling an order back to LOGGED (Rollback to Logged; reopen of a cancelled order) is allowed only for the roles that
// may cancel the order: the reject-order roles below, plus admin and management (who may do every gated order action).
import { blanketRootOf } from './orderMoney.js';
export const ORDER_CANCEL_ROLES = ['order_management', 'planning', 'sales', 'finance'];
export const ROLLBACK_TO_LOGGED_DENIED = 'no permission to roll the order back to Logged; only the roles that may cancel the order may do it (order management, planning, sales, finance, management, admin)';
export const canCancelOrder = (roles) => {
    const r = Array.isArray(roles) ? roles : [];
    return r.includes('admin') || r.includes('management') || r.some(x => ORDER_CANCEL_ROLES.includes(x));
};
export const canRollbackToLogged = (roles) => canCancelOrder(roles);

// v1.0001233 (supervisor decision 2026-11-15): the state guard of Rollback to Logged. A rollback restarts the order date and the
// Technical Review SLA clock and clears the study, so it is refused (before any change) where it means nothing or would reopen a
// final state:
//  - the order is already LOGGED (a second rollback only reset the SLA clock and the dates), or it was rolled back and still waits for the
//    Order Management update (rolledBackToLogged, whatever status a later action gave it);
//  - the order is a closed blanket contract, or a call-off of a closed blanket contract (the close settlement is final, no reopen path);
//  - the order is FULFILLED (closed; no screen offers a rollback there).
// Every other status keeps its rollback (Technical Review, Negative Margin, In Hold, the procurement / production / delivery states),
// and a cancelled (REJECTED) order is reopened by the same action as before.
// Returns '' when the rollback is allowed, otherwise the refusal text (shown by the UI, answered 400 by the server).
export const ROLLBACK_TO_LOGGED_REFUSED_STATES = ['LOGGED', 'FULFILLED'];
const canonStatus = (v) => (typeof v === 'string' && v.trim()) ? v.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
export const rollbackToLoggedStateRefusal = (order, orders = []) => {
    if (!order) return '';
    const num = order.internalOrderNumber || order.customerReferenceNumber || order.id;
    const st = canonStatus(order.status);
    if (st === 'LOGGED') return `Refused: order ${num} is already in LOGGED status; a rollback to Logged would only restart its order date and Technical Review SLA clock. Nothing was changed.`;
    if (order.rolledBackToLogged && st !== 'REJECTED') return `Refused: order ${num} was already rolled back to Logged and waits for the Order Management update; it cannot be rolled back again. Nothing was changed.`;
    if (order.contractClosed) return `Refused: blanket contract ${num} is closed (the settlement is final); it cannot be rolled back to Logged. Nothing was changed.`;
    const root = blanketRootOf(order, orders || []);
    if (root && root.contractClosed) return `Refused: order ${num} is a call-off of the closed blanket contract ${root.internalOrderNumber || root.id} (the settlement is final); it cannot be rolled back to Logged. Nothing was changed.`;
    if (st === 'FULFILLED') return `Refused: order ${num} is FULFILLED (closed); a fulfilled order cannot be rolled back to Logged. Nothing was changed.`;
    return '';
};
export const canRollbackToLoggedState = (order, orders = []) => !rollbackToLoggedStateRefusal(order, orders);
