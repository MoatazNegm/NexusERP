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

/**
 * Calculates relevance score for auto-complete search across parts, descriptions, and vendors.
 * Exact part number matches score highest (1000), followed by part number prefix (800),
 * description prefix (600), part number substring (400), description substring (200),
 * and vendor name substring (100).
 */
export const calculateCatalogMatchScore = (partNumber?: string, description?: string, vendorName?: string, query?: string): number => {
    if (!query) return 0;
    const q = query.toLowerCase().trim();
    if (!q) return 0;
    const p = (partNumber || '').toLowerCase().trim();
    const d = (description || '').toLowerCase().trim();
    const v = (vendorName || '').toLowerCase().trim();

    const qClean = q.replace(/[\s\-_]/g, '');
    const pClean = p.replace(/[\s\-_]/g, '');

    if (p === q || (qClean && pClean === qClean)) return 1000;
    if (p.startsWith(q) || (qClean && pClean.startsWith(qClean))) return 800;
    if (d.startsWith(q)) return 600;
    if (p.includes(q) || (qClean && pClean.includes(qClean))) return 400;
    if (d.includes(q)) return 200;
    if (v.includes(q)) return 100;
    return 0;
};

