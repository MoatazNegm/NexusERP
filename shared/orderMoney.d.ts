export declare function isInternalStockOrder(order: any): boolean;
export declare function orderFxRate(order: any): number;
export declare function paymentLE(payment: any, fx?: number): number;
export declare function orderPaymentsLE(order: any, filter?: ((p: any) => boolean) | null): number;
