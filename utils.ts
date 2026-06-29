import { CustomerOrder, CustomerOrderItem, DEFAULT_CURRENCY, OrderStatus } from './types';

export const getItemEffectiveQty = (item: CustomerOrderItem): number => {
    const qty = item.alteredQty !== undefined && item.alteredQty !== null ? item.alteredQty : item.quantity;
    return qty || 1;
};

/**
 * Returns the native currency for a customer order, defaulting to 'L.E.'
 * when the order was created before the currency feature existed.
 */
export const getOrderCurrency = (order: CustomerOrder | null | undefined): string => {
    return order?.currency || DEFAULT_CURRENCY;
};

/**
 * Returns the conversion rate used to bring costs (denominated in PO currency)
 * into the order's revenue currency for the P/L threshold check. Defaults to 1
 * (no conversion) when the rate is missing or non-finite.
 */
export const getOrderConversionRate = (order: CustomerOrder | null | undefined): number => {
    const r = Number(order?.conversionRate);
    if (!Number.isFinite(r) || r <= 0) return 1;
    return r;
};

export const getStatusLimitHours = (status: OrderStatus, settings: any): number => {
    switch (status) {
        case OrderStatus.LOGGED: return settings.orderEditTimeLimitHrs;
        case OrderStatus.NEGATIVE_MARGIN: return settings.pendingOfferLimitHrs;
        case OrderStatus.TECHNICAL_REVIEW: return settings.technicalReviewLimitHrs;
        case OrderStatus.WAITING_SUPPLIERS: return settings.pendingOfferLimitHrs;
        case OrderStatus.WAITING_FACTORY: return settings.waitingFactoryLimitHrs;
        case OrderStatus.MANUFACTURING: return settings.mfgFinishLimitHrs;
        case OrderStatus.TRANSITION_TO_STOCK: return settings.transitToHubLimitHrs;
        case OrderStatus.IN_PRODUCT_HUB: return settings.productHubLimitHrs;
        case OrderStatus.ISSUE_INVOICE: return settings.invoicedLimitHrs;
        case OrderStatus.INVOICED: return settings.hubReleasedLimitHrs;
        case OrderStatus.HUB_RELEASED: return settings.deliveryLimitHrs;
        case OrderStatus.DELIVERY: return settings.deliveredLimitHrs;
        default: return 0;
    }
};
