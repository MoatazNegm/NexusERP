export interface CashBankBreakdown { customerCashIn: number; advancesIn: number; refundsOut: number; manualAdditions: number; manualCosts: number; supplierCashOut: number; balance: number; }
export declare function computeCashBank(orders?: any[], ledger?: any[], supplierPayments?: any[]): CashBankBreakdown;
