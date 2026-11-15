export declare const ORDER_CANCEL_ROLES: string[];
export declare const ROLLBACK_TO_LOGGED_DENIED: string;
export declare function canCancelOrder(roles: readonly string[] | undefined | null): boolean;
export declare function canRollbackToLogged(roles: readonly string[] | undefined | null): boolean;
export declare const ROLLBACK_TO_LOGGED_REFUSED_STATES: string[];
export declare function rollbackToLoggedStateRefusal(order: any, orders?: readonly any[] | null): string;
export declare function canRollbackToLoggedState(order: any, orders?: readonly any[] | null): boolean;
