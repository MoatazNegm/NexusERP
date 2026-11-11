export declare const ORDER_CANCEL_ROLES: string[];
export declare const ROLLBACK_TO_LOGGED_DENIED: string;
export declare function canCancelOrder(roles: readonly string[] | undefined | null): boolean;
export declare function canRollbackToLogged(roles: readonly string[] | undefined | null): boolean;
