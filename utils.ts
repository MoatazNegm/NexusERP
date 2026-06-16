import { CustomerOrderItem, OrderStatus } from './types';

export const getItemEffectiveQty = (item: CustomerOrderItem): number => {
    const qty = item.alteredQty !== undefined && item.alteredQty !== null ? item.alteredQty : item.quantity;
    return qty || 1;
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
