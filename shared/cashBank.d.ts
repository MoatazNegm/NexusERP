export interface CashBankBreakdown { customerCashIn: number; advancesIn: number; refundsOut: number; manualAdditions: number; manualCosts: number; supplierCashOut: number; balance: number; }
export declare function computeCashBank(orders?: any[], ledger?: any[], supplierPayments?: any[]): CashBankBreakdown;
export interface CashBankMovement { date: string; amount: number; source: string; description: string; ref: string; }
export declare function cashBankMovements(orders?: any[], ledger?: any[], supplierPayments?: any[]): CashBankMovement[];
export declare function legacyVoidOrigin(led: any[], e: any, byId: Map<string, any>, paymentLedgerIds?: Iterable<string>): string | null;
