// Shared order permission rule used by both client and server (v1.0001227, supervisor ruling 2026-11-11).
// Rolling an order back to LOGGED (Rollback to Logged; reopen of a cancelled order) is allowed only for the roles that
// may cancel the order: the reject-order roles below, plus admin and management (who may do every gated order action).
export const ORDER_CANCEL_ROLES = ['order_management', 'planning', 'sales', 'finance'];
export const ROLLBACK_TO_LOGGED_DENIED = 'no permission to roll the order back to Logged; only the roles that may cancel the order may do it (order management, planning, sales, finance, management, admin)';
export const canCancelOrder = (roles) => {
    const r = Array.isArray(roles) ? roles : [];
    return r.includes('admin') || r.includes('management') || r.some(x => ORDER_CANCEL_ROLES.includes(x));
};
export const canRollbackToLogged = (roles) => canCancelOrder(roles);
