import { CustomerOrderItem } from './types';

export const getItemEffectiveQty = (item: CustomerOrderItem): number => {
    if (item.alteredQty !== undefined && item.alteredQty !== null) return item.alteredQty;
    return item.quantity || 0;
};
