export declare function isInternalStockOrder(order: any): boolean;
export declare function orderFxRate(order: any): number;
export declare function paymentLE(payment: any, fx?: number): number;
export declare function orderPaymentsLE(order: any, filter?: ((p: any) => boolean) | null): number;
export declare function isBlanketRootOrder(order: any): boolean;
export declare function isClosedBlanketRoot(order: any): boolean;
export declare function blanketRootOf(order: any, orders?: any[]): any | null;
export declare function isRealizedSale(order: any, orders?: any[]): boolean;
export declare function ownLinesAreSales(order: any): boolean;
