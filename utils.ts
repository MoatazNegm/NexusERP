import { CustomerOrder, CustomerOrderItem, ManufacturingComponent, DEFAULT_CURRENCY, OrderStatus } from './types';
import html2canvas, { Options } from 'html2canvas';

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

/**
 * Robust wrapper around html2canvas that sanitizes modern color functions (oklch, oklab, lch, lab, color)
 * to standard rgba/rgb colors using an in-memory canvas context, and neutralizes letter-spacing on Arabic text
 * to prevent cursive ligatures from breaking.
 */
export const safeHtml2Canvas = async (element: HTMLElement, options: Partial<Options> = {}): Promise<HTMLCanvasElement> => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('Browser environment required for safeHtml2Canvas');
    }

    let cvs: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
        cvs = document.createElement('canvas');
        cvs.width = 1;
        cvs.height = 1;
        ctx = cvs.getContext('2d', { willReadFrequently: true });
    } catch {}

    const oklchToRgb = (str: string): string => {
        if (!str || typeof str !== 'string') return str;
        if (!str.includes('oklch') && !str.includes('oklab') && !str.includes('lch') && !str.includes('lab') && !str.includes('color(')) {
            return str;
        }
        return str.replace(
            /oklch\([^)]+\)|oklab\([^)]+\)|lch\([^)]+\)|lab\([^)]+\)|color\([^)]+\)/gi,
            (match) => {
                try {
                    if (!ctx) return match;
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = match;
                    ctx.fillRect(0, 0, 1, 1);
                    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
                    return `rgba(${r},${g},${b},${a / 255})`;
                } catch {
                    return match;
                }
            }
        );
    };

    const createStyleProxy = (origGetComputedStyle: typeof window.getComputedStyle, targetWindow: Window) => {
        return function(el: Element, pseudo?: string | null) {
            const cs = origGetComputedStyle.call(targetWindow, el, pseudo);
            return new Proxy(cs, {
                get(target: any, prop: string | symbol) {
                    // Never allow letter-spacing on Arabic text (prevents html2canvas from splitting cursive Arabic letters)
                    if (prop === 'letterSpacing') {
                        if (el && el.textContent && /[\u0600-\u06FF]/.test(el.textContent)) {
                            return '0px';
                        }
                    }
                    if (prop === 'getPropertyValue') {
                        return function(property: string) {
                            if (property === 'letter-spacing' && el && el.textContent && /[\u0600-\u06FF]/.test(el.textContent)) {
                                return '0px';
                            }
                            const res = target.getPropertyValue(property);
                            return typeof res === 'string' ? oklchToRgb(res) : res;
                        };
                    }
                    const val = target[prop];
                    if (typeof val === 'string') {
                        return oklchToRgb(val);
                    }
                    if (typeof val === 'function') {
                        return val.bind(target);
                    }
                    return val;
                }
            });
        };
    };

    const origWinGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = createStyleProxy(origWinGetComputedStyle, window);

    const userOnClone = options.onclone;

    try {
        return await html2canvas(element, {
            ...options,
            onclone: (clonedDoc: Document, el: HTMLElement) => {
                try {
                    const clonedWin = clonedDoc.defaultView || window;
                    clonedWin.getComputedStyle = createStyleProxy(clonedWin.getComputedStyle, clonedWin);
                } catch {}

                try {
                    const allEls = clonedDoc.querySelectorAll('*');
                    allEls.forEach((node) => {
                        const htmlEl = node as HTMLElement;
                        if (htmlEl.style) {
                            for (let i = 0; i < htmlEl.style.length; i++) {
                                const prop = htmlEl.style[i];
                                const val = htmlEl.style.getPropertyValue(prop);
                                if (val && (val.includes('oklch') || val.includes('oklab') || val.includes('lch') || val.includes('lab') || val.includes('color('))) {
                                    htmlEl.style.setProperty(prop, oklchToRgb(val));
                                }
                            }
                        }
                    });
                } catch {}

                if (typeof userOnClone === 'function') {
                    userOnClone(clonedDoc, el);
                }
            }
        });
    } finally {
        window.getComputedStyle = origWinGetComputedStyle;
    }
};

