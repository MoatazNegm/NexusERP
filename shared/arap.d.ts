export declare function computeReceivables(orders?: any[], ledger?: any[] | null, customers?: any[] | null): { total: number; byOrder: any[]; byCustomer: any[]; byProject: any[] };
export declare function computePayables(db: { orders?: any[]; supplierPayments?: any[]; suppliers?: any[]; ledger?: any[] }): { total: number; byOrderSupplier: any[]; byOrder: any[]; bySupplier: any[]; byProject: any[] };
export declare function orderPaidInAP(order: any): number;
export declare function orderWhtAmountAP(order: any): number;
export declare function orderCommitmentGrossAP(order: any): number;
export declare function orderFxAP(order: any): number;
