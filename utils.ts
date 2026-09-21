import { CustomerOrder, CustomerOrderItem, ManufacturingComponent, DEFAULT_CURRENCY, OrderStatus } from './types';

export const getItemEffectiveQty = (item: CustomerOrderItem): number => {
    const qty = item.alteredQty !== undefined && item.alteredQty !== null ? item.alteredQty : item.quantity;
    return qty || 1;
};

export const isStockOrder = (order?: Partial<CustomerOrder> | null): boolean => {
    if (!order) return false;
    const cust = order.customerName?.trim().toLowerCase();
    const po = typeof order.customerReferenceNumber === 'string' ? order.customerReferenceNumber.trim().toUpperCase() : '';
    return cust === 'internal stock' || po.startsWith('STOCK-');
};

export type PoClassification = 'Stock' | 'Blanket' | 'Trade' | 'Manufacturing';

export const getOrderPoType = (
    order?: Partial<CustomerOrder> | null,
    item?: Partial<CustomerOrderItem> | null,
    comp?: Partial<ManufacturingComponent> | null
): PoClassification => {
    if (isStockOrder(order) || comp?.status === 'ORDERED_FOR_STOCK' || comp?.source === 'STOCK') {
        return 'Stock';
    }
    if (order?.blanketOrder || Boolean(order?.contractId) || Boolean(order?.blanketContractId)) {
        return 'Blanket';
    }
    const itemType = (item?.productionType || '').toUpperCase().trim();
    if (itemType === 'TRADING') return 'Trade';
    if (itemType === 'MANUFACTURING' || itemType === 'OUTSOURCING') return 'Manufacturing';

    if (order?.items && order.items.length > 0) {
        const hasMfg = order.items.some(i => {
            const pt = (i.productionType || '').toUpperCase().trim();
            return pt === 'MANUFACTURING' || pt === 'OUTSOURCING';
        });
        if (hasMfg) return 'Manufacturing';

        const hasTrading = order.items.some(i => (i.productionType || '').toUpperCase().trim() === 'TRADING');
        if (hasTrading) return 'Trade';
    }
    return 'Manufacturing';
};

export const getPoTypeConfig = (poType: PoClassification) => {
    switch (poType) {
        case 'Stock':
            return {
                type: 'Stock' as const,
                label: 'Stock Order',
                shortLabel: 'Stock',
                arLabel: 'طلب مخزن',
                arShortLabel: 'مخزون',
                badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
                icon: 'fa-boxes-stacked',
                searchKeywords: 'stock stock-order stock order internal-stock internal stock طلب مخزن'
            };
        case 'Blanket':
            return {
                type: 'Blanket' as const,
                label: 'Blanket Order',
                shortLabel: 'Blanket',
                arLabel: 'عقد إطاري',
                arShortLabel: 'إطاري',
                badgeClass: 'bg-teal-50 text-teal-700 border-teal-200',
                icon: 'fa-layer-group',
                searchKeywords: 'blanket blanket-order blanket order contract عقود عقد عقد توريد'
            };
        case 'Trade':
            return {
                type: 'Trade' as const,
                label: 'Trade Order',
                shortLabel: 'Trade',
                arLabel: 'طلب تجارة',
                arShortLabel: 'تجارة',
                badgeClass: 'bg-cyan-50 text-cyan-700 border-cyan-200',
                icon: 'fa-cart-shopping',
                searchKeywords: 'trade trading trade-order trade order trading-order طلب تجارة تجارة'
            };
        case 'Manufacturing':
        default:
            return {
                type: 'Manufacturing' as const,
                label: 'Manufacturing Order',
                shortLabel: 'Manufacturing',
                arLabel: 'طلب تصنيع',
                arShortLabel: 'تصنيع',
                badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
                icon: 'fa-industry',
                searchKeywords: 'manufacturing mfg mfg-order manufacturing-order تصنيع طلب تصنيع'
            };
    }
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
 * Returns the start timestamp (in ms) for the Technical Review SLA.
 * The Technical Review SLA starts directly after the order is logged (or rolled back to logged)
 * and continues until the order moves out of the technical review list.
 */
export const getTechReviewStartTime = (order: CustomerOrder | null | undefined): number => {
    if (!order) return Date.now();
    if (order.technicalReviewStartedAt) {
        const t = new Date(order.technicalReviewStartedAt).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    const logs = order.logs || [];
    for (let i = logs.length - 1; i >= 0; i--) {
        const l = logs[i];
        const msg = (l.message || '').toLowerCase();
        if (l.status === OrderStatus.LOGGED || msg.includes('rollback to logged') || msg.includes('order acquisition')) {
            const t = new Date(l.timestamp).getTime();
            if (!isNaN(t) && t > 0) return t;
        }
    }
    if (order.dataEntryTimestamp) {
        const t = new Date(order.dataEntryTimestamp).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    if (order.orderDate) {
        const t = new Date(order.orderDate).getTime();
        if (!isNaN(t) && t > 0) return t;
    }
    return Date.now();
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

