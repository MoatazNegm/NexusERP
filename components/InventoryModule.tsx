
import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { InventoryItem, CustomerOrder, Supplier, OrderStatus, CustomerOrderItem, ManufacturingComponent, AppConfig, User } from '../types';
import { getItemEffectiveQty, isStockOrder, getOrderPoType, getPoTypeConfig, PoClassification } from '../utils';
import { SortableTable, ColumnDef } from './SortableTable';
import { useLanguage, LanguageProvider } from '../contexts/LanguageContext';
import { LanguageToggle } from './LanguageToggle';

type InventoryTab = 'inventory' | 'reception' | 'hub' | 'dispatch';

interface ConfirmState {
  type: 'material' | 'hub' | 'dispatch';
  order: CustomerOrder;
  item?: CustomerOrderItem;
  comp?: ManufacturingComponent;
}

interface InventoryModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const ThresholdTimer: React.FC<{ order: CustomerOrder, limitHrs: number }> = ({ order, limitHrs }) => {
  const { language } = useLanguage();
  const isAr = language === 'ar';
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, limitHrs]);

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}${isAr ? 'س' : 'h'} ${mins}${isAr ? 'د' : 'm'}` : `${mins}${isAr ? 'د' : 'm'}`;

  return (
    <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 mt-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-hourglass'}`}></i>
      {isOver ? (isAr ? `متأخر بمقدار ${timeStr}` : `Overdue by ${timeStr}`) : (isAr ? `المتبقي: ${timeStr}` : `SLA: ${timeStr} left`)}
    </div>
  );
};

// Helper: check if a component is linked to a customer PO
const isComponentPoLinked = (inv: InventoryItem, orders: CustomerOrder[]): boolean => {
  if (!inv.orderRef) return false;
  const ref = inv.orderRef.trim().toUpperCase();
  if (ref === 'STOCK' || ref.startsWith('STOCK-')) return false;
  const order = orders.find(o => o.internalOrderNumber === inv.orderRef || o.customerReferenceNumber === inv.orderRef);
  if (order && isStockOrder(order)) return false;
  return true;
};

// Helper: check if a component belongs to a trade order/item (must not appear in component stock)
const isItemTrade = (inv: InventoryItem, orders: CustomerOrder[]): boolean => {
  if (!inv.orderRef) return false;
  const order = orders.find(o => o.internalOrderNumber === inv.orderRef || o.customerReferenceNumber === inv.orderRef);
  if (order) {
    if (isStockOrder(order)) return false;
    if (getOrderPoType(order) === 'Trade') return true;
    const hasTrade = order.items.some(it =>
      it.productionType === 'TRADING' &&
      (it.components?.some(c => c.inventoryItemId === inv.id || c.componentNumber === inv.sku || c.description === inv.description) ||
       it.orderNumber === inv.sku || it.description === inv.description)
    );
    if (hasTrade) return true;
  }
  return false;
};

// Helper: unit value for a finished product item in product stock (hub)
const getProductUnitValue = (item: CustomerOrderItem): number => {
  if (item.pricePerUnit && item.pricePerUnit > 0) return item.pricePerUnit;
  if (item.realCost && item.realCost > 0) return item.realCost;
  const compTotal = (item.components || []).reduce((s, c) => s + ((c.quantity || 0) * (c.unitCost || 0)), 0);
  const effQty = getItemEffectiveQty(item) || 1;
  if (compTotal > 0 && effQty > 0) return compTotal / effQty;
  return 0;
};

// Helper: check if a product in product stock is linked to a customer PO
const isProductPoLinked = (order: CustomerOrder): boolean => {
  return !isStockOrder(order);
};

export interface TotalStockItem {
  id: string;
  stockType: 'Component' | 'Product';
  identifier: string;
  description: string;
  orderRef: string;
  poNumber?: string;
  customerName: string;
  poClassification: PoClassification;
  isPoLinked: boolean;
  quantityInStock: number;
  quantityReserved: number;
  unit: string;
  unitValue: number;
  totalValue: number;
}

export interface StockCardMovement {
  id: string;
  date: string;
  action: 'ORDERED' | 'RECEIVED' | 'RESERVED' | 'RELEASED' | 'DISPATCHED' | 'AUDIT';
  label: string;
  quantity: number;
  unit: string;
  poNumber?: string;
  orderRef?: string;
  customerName?: string;
  supplierName?: string;
  user?: string;
  notes?: string;
  badgeClass: string;
  icon: string;
}

export interface StockCardItemData {
  id: string;
  stockType: 'Component' | 'Product';
  partNumber: string;
  description: string;
  category?: string;
  unit: string;
  poNumber?: string;
  orderRef: string;
  customerName: string;
  isPoLinked: boolean;
  poClassification: PoClassification;
  quantityInStock: number;
  quantityReserved: number;
  quantityAvailable: number;
  unitValue: number;
  totalValue: number;
  orderedDate?: string;
  orderedQty?: number;
  receivedDate?: string;
  receivedQty?: number;
  invItem?: InventoryItem;
  order?: CustomerOrder;
  orderItem?: CustomerOrderItem;
  movements: StockCardMovement[];
}

const buildStockCardData = (
  type: 'Component' | 'Product',
  rawItem: InventoryItem | { order: CustomerOrder; item: CustomerOrderItem; hubQty: number; mfdQty: number; target: number } | TotalStockItem,
  allOrders: CustomerOrder[],
  suppliers: Supplier[],
  inventoryItems: InventoryItem[]
): StockCardItemData => {
  let id = '';
  let partNumber = '';
  let description = '';
  let category = '';
  let unit = 'pcs';
  let poNumber = '';
  let orderRef = '';
  let customerName = '';
  let isPoLinked = false;
  let poClassification: PoClassification = 'Stock';
  let quantityInStock = 0;
  let quantityReserved = 0;
  let unitValue = 0;
  let invItem: InventoryItem | undefined;
  let matchedOrder: CustomerOrder | undefined;
  let matchedOrderItem: CustomerOrderItem | undefined;

  // Handle TotalStockItem forwarding
  if ('stockType' in rawItem && 'identifier' in rawItem) {
    const tot = rawItem as TotalStockItem;
    if (tot.stockType === 'Component') {
      const foundInv = inventoryItems.find(i => `comp-${i.id}` === tot.id || i.sku === tot.identifier || i.description === tot.description);
      if (foundInv) {
        return buildStockCardData('Component', foundInv, allOrders, suppliers, inventoryItems);
      }
      type = 'Component';
      id = tot.id;
      partNumber = tot.identifier;
      description = tot.description;
      unit = tot.unit;
      poNumber = tot.poNumber || '';
      orderRef = tot.orderRef;
      customerName = tot.customerName;
      isPoLinked = tot.isPoLinked;
      poClassification = tot.poClassification;
      quantityInStock = tot.quantityInStock;
      quantityReserved = tot.quantityReserved;
      unitValue = tot.unitValue;
    } else {
      const ord = allOrders.find(o => o.customerReferenceNumber === tot.orderRef || o.internalOrderNumber === tot.orderRef);
      const itm = ord?.items?.find(i => i.description === tot.description || ord.internalOrderNumber === tot.identifier);
      if (ord && itm) {
        return buildStockCardData('Product', { order: ord, item: itm, hubQty: tot.quantityInStock, mfdQty: itm.manufacturedQty || 0, target: getItemEffectiveQty(itm) }, allOrders, suppliers, inventoryItems);
      }
      type = 'Product';
      id = tot.id;
      partNumber = tot.identifier;
      description = tot.description;
      unit = tot.unit;
      poNumber = tot.poNumber || '';
      orderRef = tot.orderRef;
      customerName = tot.customerName;
      isPoLinked = tot.isPoLinked;
      poClassification = tot.poClassification;
      quantityInStock = tot.quantityInStock;
      quantityReserved = tot.quantityReserved;
      unitValue = tot.unitValue;
    }
  } else if (type === 'Component') {
    const inv = rawItem as InventoryItem;
    invItem = inv;
    id = `comp-${inv.id}`;
    partNumber = inv.sku || 'N/A';
    description = inv.description;
    category = inv.category || 'Mechanical';
    unit = inv.unit || 'pcs';
    poNumber = inv.poNumber || '';
    orderRef = inv.orderRef || 'STOCK';
    matchedOrder = inv.orderRef ? allOrders.find(o => o.internalOrderNumber === inv.orderRef || o.customerReferenceNumber === inv.orderRef) : undefined;
    isPoLinked = isComponentPoLinked(inv, allOrders);
    poClassification = matchedOrder ? getOrderPoType(matchedOrder) : (isPoLinked ? 'Manufacturing' : 'Stock');
    quantityInStock = Number(inv.quantityInStock) || 0;
    quantityReserved = Number(inv.quantityReserved) || 0;
    unitValue = Number(inv.lastCost) || 0;
    customerName = matchedOrder ? (isStockOrder(matchedOrder) ? 'Internal Stock' : matchedOrder.customerName) : (isPoLinked ? 'Customer Order' : 'Internal Stock');
  } else if (type === 'Product') {
    const p = rawItem as { order: CustomerOrder; item: CustomerOrderItem; hubQty: number; mfdQty: number; target: number };
    matchedOrder = p.order;
    matchedOrderItem = p.item;
    id = `prod-${p.order.id}-${p.item.id}`;
    partNumber = p.order.internalOrderNumber || p.item.orderNumber || 'PRODUCT';
    description = p.item.description;
    category = 'Finished Product';
    unit = p.item.unit || 'pcs';
    poNumber = p.order.customerReferenceNumber || '';
    orderRef = p.order.internalOrderNumber || p.order.customerReferenceNumber || 'N/A';
    customerName = p.order.customerName;
    isPoLinked = isProductPoLinked(p.order);
    poClassification = getOrderPoType(p.order, p.item);
    quantityInStock = p.hubQty || 0;
    quantityReserved = isPoLinked ? quantityInStock : 0;
    unitValue = getProductUnitValue(p.item);
  }

  const quantityAvailable = Math.max(0, quantityInStock - quantityReserved);
  const totalValue = quantityInStock * unitValue;
  const movements: StockCardMovement[] = [];

  if (type === 'Component') {
    const matchedComponents: { order: CustomerOrder; item: CustomerOrderItem; comp: ManufacturingComponent }[] = [];
    allOrders.forEach(o => {
      (o.items || []).forEach(it => {
        (it.components || []).forEach(c => {
          const isMatch =
            (invItem && c.inventoryItemId === invItem.id) ||
            (c.componentNumber && partNumber && partNumber !== 'N/A' && c.componentNumber.trim().toLowerCase() === partNumber.trim().toLowerCase()) ||
            (c.description && description && c.description.trim().toLowerCase() === description.trim().toLowerCase()) ||
            (c.poNumber && poNumber && c.poNumber.trim().toUpperCase() === poNumber.trim().toUpperCase()) ||
            (orderRef && orderRef !== 'STOCK' && (o.internalOrderNumber === orderRef || o.customerReferenceNumber === orderRef));
          if (isMatch) {
            matchedComponents.push({ order: o, item: it, comp: c });
          }
        });
      });
    });

    matchedComponents.forEach(({ order, comp }, idx) => {
      const orderDate = comp.procurementStartedAt || order.dataEntryTimestamp || order.orderDate;
      const supp = suppliers.find(s => s.id === comp.supplierId);
      const suppName = comp.supplierName || supp?.name || 'Assigned Vendor';
      if (orderDate && (comp.quantity || 0) > 0) {
        movements.push({
          id: `ord-${order.id}-${comp.id || idx}`,
          date: orderDate,
          action: 'ORDERED',
          label: 'PO Issued / Ordered',
          quantity: comp.quantity || 0,
          unit: comp.unit || unit,
          poNumber: comp.poNumber || order.customerReferenceNumber,
          orderRef: order.internalOrderNumber,
          customerName: isStockOrder(order) ? 'Internal Stock' : order.customerName,
          supplierName: suppName,
          user: (order.logs || []).find(l => (l.message || '').toLowerCase().includes('po') || (l.message || '').toLowerCase().includes('acquisition'))?.user || 'Procurement',
          notes: `Procured for ${order.internalOrderNumber || 'Stock'} (${isStockOrder(order) ? 'Internal Stock' : order.customerName})`,
          badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
          icon: 'fa-file-invoice'
        });
      }

      const receiptLogs = (order.logs || []).filter(l => {
        const msg = (l.message || '').toLowerCase();
        const hasReceipt = msg.includes('receipt') || msg.includes('received');
        const descMatch = description && msg.includes(description.trim().toLowerCase().slice(0, 15));
        const pnMatch = partNumber && partNumber !== 'N/A' && msg.includes(partNumber.trim().toLowerCase());
        const compDescMatch = comp.description && msg.includes(comp.description.trim().toLowerCase().slice(0, 15));
        return hasReceipt && (descMatch || pnMatch || compDescMatch || msg.includes('trading component receipt') || msg.includes('component receipt'));
      });

      if (receiptLogs.length > 0) {
        receiptLogs.forEach((l, lIdx) => {
          const qtyMatch = l.message.match(/(\d+(?:\.\d+)?)\s*(?:pcs|pieces|unit|kg|m|meter)?/i);
          const parsedQty = qtyMatch ? parseFloat(qtyMatch[1]) : (comp.receivedQty || quantityInStock);
          movements.push({
            id: `rcv-log-${order.id}-${idx}-${lIdx}`,
            date: l.timestamp,
            action: 'RECEIVED',
            label: 'Received into Stock',
            quantity: parsedQty,
            unit: comp.unit || unit,
            poNumber: comp.poNumber || order.customerReferenceNumber,
            orderRef: order.internalOrderNumber,
            customerName: isStockOrder(order) ? 'Internal Stock' : order.customerName,
            user: l.user || 'Warehouse Reception',
            notes: l.message,
            badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
            icon: 'fa-truck-ramp-box'
          });
        });
      } else if ((comp.receivedQty || 0) > 0) {
        const rcvDate = comp.statusUpdatedAt || order.statusUpdatedAt || order.dataEntryTimestamp || new Date().toISOString();
        movements.push({
          id: `rcv-${order.id}-${comp.id || idx}`,
          date: rcvDate,
          action: 'RECEIVED',
          label: 'Received into Stock',
          quantity: comp.receivedQty || 0,
          unit: comp.unit || unit,
          poNumber: comp.poNumber || order.customerReferenceNumber,
          orderRef: order.internalOrderNumber,
          customerName: isStockOrder(order) ? 'Internal Stock' : order.customerName,
          user: 'Warehouse Reception',
          notes: `Received from Reception into warehouse stock from PO ${comp.poNumber || 'N/A'}`,
          badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: 'fa-truck-ramp-box'
        });
      }

      if (comp.status === 'RESERVED' && !isStockOrder(order)) {
        movements.push({
          id: `rsrv-${order.id}-${comp.id || idx}`,
          date: comp.statusUpdatedAt || order.statusUpdatedAt || new Date().toISOString(),
          action: 'RESERVED',
          label: 'Reserved for Production',
          quantity: comp.quantity || 0,
          unit: comp.unit || unit,
          orderRef: order.internalOrderNumber,
          customerName: order.customerName,
          user: 'System',
          notes: `Reserved for customer order ${order.internalOrderNumber} (${order.customerName})`,
          badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
          icon: 'fa-lock'
        });
      }

      if ((comp.consumedQty || 0) > 0) {
        movements.push({
          id: `cnsm-${order.id}-${comp.id || idx}`,
          date: comp.statusUpdatedAt || order.statusUpdatedAt || new Date().toISOString(),
          action: 'RELEASED',
          label: 'Consumed in Production',
          quantity: comp.consumedQty || 0,
          unit: comp.unit || unit,
          orderRef: order.internalOrderNumber,
          customerName: order.customerName,
          user: 'Factory Floor',
          notes: `Consumed for order production of ${order.internalOrderNumber}`,
          badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
          icon: 'fa-dolly'
        });
      }
    });

    if (invItem && invItem.logs && invItem.logs.length > 0) {
      invItem.logs.forEach((l, lIdx) => {
        const qtyMatch = l.message.match(/Received (\d+(?:\.\d+)?)/i);
        const qty = qtyMatch ? parseFloat(qtyMatch[1]) : quantityInStock;
        movements.push({
          id: `inv-log-${lIdx}`,
          date: l.timestamp,
          action: 'RECEIVED',
          label: 'Reception Delivery',
          quantity: qty,
          unit: unit,
          poNumber: poNumber,
          orderRef: orderRef,
          user: l.user || 'System',
          notes: l.message,
          badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: 'fa-clipboard-check'
        });
      });
    }

    if (movements.length === 0 && quantityInStock > 0) {
      movements.push({
        id: `init-${id}`,
        date: invItem?.lastUpdated || new Date().toISOString(),
        action: 'RECEIVED',
        label: 'Stock Opening Balance',
        quantity: quantityInStock,
        unit: unit,
        poNumber: poNumber || 'INITIAL',
        orderRef: orderRef,
        customerName: customerName,
        user: 'Inventory Audit',
        notes: `Recorded stock balance of ${quantityInStock} ${unit}`,
        badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        icon: 'fa-boxes-stacked'
      });
    }
  } else if (type === 'Product' && matchedOrder && matchedOrderItem) {
    const order = matchedOrder;
    const item = matchedOrderItem;

    movements.push({
      id: `ord-prod-${order.id}-${item.id}`,
      date: order.dataEntryTimestamp || order.orderDate || new Date().toISOString(),
      action: 'ORDERED',
      label: 'Customer PO Booked',
      quantity: getItemEffectiveQty(item),
      unit: item.unit || unit,
      poNumber: order.customerReferenceNumber,
      orderRef: order.internalOrderNumber,
      customerName: order.customerName,
      user: (order.logs || []).find(l => (l.message || '').toLowerCase().includes('acquisition'))?.user || 'Sales',
      notes: `Order booked for ${order.customerName} (PO: ${order.customerReferenceNumber})`,
      badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
      icon: 'fa-file-invoice'
    });

    const hubQty = item.hubReceivedQty || 0;
    if (hubQty > 0) {
      const hubLogs = (order.logs || []).filter(l => {
        const m = (l.message || '').toLowerCase();
        return m.includes('hub') || m.includes('trading component receipt') || m.includes('manufactured');
      });

      if (hubLogs.length > 0) {
        hubLogs.forEach((l, lIdx) => {
          const qtyMatch = l.message.match(/(\d+(?:\.\d+)?)\s*(?:pcs|pieces|unit)?/i);
          const parsedQty = qtyMatch ? parseFloat(qtyMatch[1]) : hubQty;
          movements.push({
            id: `hub-log-${order.id}-${lIdx}`,
            date: l.timestamp,
            action: 'RECEIVED',
            label: item.productionType === 'TRADING' ? 'Trade Goods Received to Hub' : 'Finished Goods Moved to Hub',
            quantity: parsedQty,
            unit: item.unit || unit,
            poNumber: order.customerReferenceNumber,
            orderRef: order.internalOrderNumber,
            customerName: order.customerName,
            user: l.user || 'Product Hub',
            notes: l.message,
            badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
            icon: 'fa-warehouse'
          });
        });
      } else {
        movements.push({
          id: `hub-rcv-${order.id}-${item.id}`,
          date: order.statusUpdatedAt || order.dataEntryTimestamp || new Date().toISOString(),
          action: 'RECEIVED',
          label: 'Received into Product Stock (Hub)',
          quantity: hubQty,
          unit: item.unit || unit,
          poNumber: order.customerReferenceNumber,
          orderRef: order.internalOrderNumber,
          customerName: order.customerName,
          user: 'Product Hub',
          notes: `Goods received into Product Hub ready for invoicing and dispatch`,
          badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          icon: 'fa-warehouse'
        });
      }
    }

    if ((item.dispatchedQty || 0) > 0) {
      movements.push({
        id: `disp-${order.id}-${item.id}`,
        date: (order.logs || []).find(l => (l.message || '').toLowerCase().includes('dispatch'))?.timestamp || order.statusUpdatedAt || new Date().toISOString(),
        action: 'DISPATCHED',
        label: 'Dispatched to Customer',
        quantity: item.dispatchedQty || 0,
        unit: item.unit || unit,
        poNumber: order.customerReferenceNumber,
        orderRef: order.internalOrderNumber,
        customerName: order.customerName,
        user: 'Logistics',
        notes: `Dispatched to ${order.customerName} against PO ${order.customerReferenceNumber}`,
        badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
        icon: 'fa-truck-fast'
      });
    }
  }

  const seen = new Set<string>();
  const uniqueMovements: StockCardMovement[] = [];
  movements.forEach(m => {
    const key = `${m.action}-${m.date}-${m.quantity}-${m.poNumber || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMovements.push(m);
    }
  });

  uniqueMovements.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const orderedList = uniqueMovements.filter(m => m.action === 'ORDERED');
  const oldestOrdered = orderedList[orderedList.length - 1];
  const receivedList = uniqueMovements.filter(m => m.action === 'RECEIVED');
  const latestReceived = receivedList[0];

  const totalOrderedQty = orderedList.reduce((s, m) => s + m.quantity, 0);
  const totalReceivedQty = receivedList.reduce((s, m) => s + m.quantity, 0);

  return {
    id,
    stockType: type,
    partNumber,
    description,
    category,
    unit,
    poNumber,
    orderRef,
    customerName,
    isPoLinked,
    poClassification,
    quantityInStock,
    quantityReserved,
    quantityAvailable,
    unitValue,
    totalValue,
    orderedDate: oldestOrdered?.date,
    orderedQty: totalOrderedQty > 0 ? totalOrderedQty : undefined,
    receivedDate: latestReceived?.date,
    receivedQty: totalReceivedQty > 0 ? totalReceivedQty : quantityInStock,
    invItem,
    order: matchedOrder,
    orderItem: matchedOrderItem,
    movements: uniqueMovements
  };
};

const ItemStockCardModal: React.FC<{
  data: StockCardItemData | null;
  onClose: () => void;
}> = ({ data, onClose }) => {
  if (!data) return null;
  const { t, language } = useLanguage();
  const isAr = language === 'ar';
  const cfg = getPoTypeConfig(data.poClassification);

  const formatDate = (iso?: string) => {
    if (!iso) return 'N/A';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(isAr ? 'ar-EG' : undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return iso;
    }
  };

  const getMovementLabel = (m: StockCardMovement) => {
    if (!isAr) return m.label;
    if (m.action === 'ORDERED') {
      if (m.label.includes('PO Issued')) return t('inventory.movementLabels.ORDERED');
      if (m.label.includes('Customer PO Booked')) return t('inventory.movementLabels.customerPoBooked');
    }
    if (m.action === 'RECEIVED') {
      if (m.label.includes('Received into Stock')) return t('inventory.movementLabels.RECEIVED');
      if (m.label.includes('Reception Delivery')) return t('inventory.movementLabels.receptionDelivery');
      if (m.label.includes('Opening Balance')) return t('inventory.movementLabels.openingBalance');
      if (m.label.includes('Trade Goods Received')) return t('inventory.movementLabels.tradeHubReceive');
      if (m.label.includes('Finished Goods Moved')) return t('inventory.movementLabels.goodsHub');
      if (m.label.includes('Product Stock')) return t('inventory.movementLabels.productHub');
    }
    if (m.action === 'RESERVED') return t('inventory.movementLabels.RESERVED');
    if (m.action === 'RELEASED') return t('inventory.movementLabels.RELEASED');
    if (m.action === 'DISPATCHED') return t('inventory.movementLabels.DISPATCHED');
    return m.label;
  };

  const getMovementUser = (user?: string) => {
    if (!isAr || !user) return user;
    if (user === 'Procurement') return t('inventory.movementUsers.Procurement');
    if (user === 'Warehouse Reception') return t('inventory.movementUsers.warehouseReception');
    if (user === 'Factory Floor') return t('inventory.movementUsers.factoryFloor');
    if (user === 'System') return t('inventory.movementUsers.system');
    if (user === 'Sales') return t('inventory.movementUsers.sales');
    if (user === 'Product Hub') return t('inventory.movementUsers.productHub');
    if (user === 'Logistics') return t('inventory.movementUsers.logistics');
    if (user === 'Inventory Audit') return t('inventory.movementUsers.inventoryAudit');
    return user;
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-150 my-auto" dir={isAr ? 'rtl' : 'ltr'}>
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white flex items-start justify-between gap-4 border-b border-slate-800">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-blue-500/20 border border-blue-400/30 text-blue-400 flex items-center justify-center text-2xl shrink-0 mt-0.5">
              <i className={data.stockType === 'Component' ? 'fa-solid fa-microchip' : 'fa-solid fa-cube'}></i>
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-blue-400">
                  {t('inventory.labels.stockCardBadge')}
                </span>
                <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase bg-white/10 text-white border border-white/20">
                  {isAr ? (data.stockType === 'Component' ? 'مخزون المكونات' : 'مخزون المنتجات') : `${data.stockType} Stock`}
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`}>
                  <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                  {isAr ? cfg.arLabel : cfg.label}
                </span>
                {data.isPoLinked ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
                    <i className="fa-solid fa-link text-[7px]"></i> {t('inventory.labels.poLinked')}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                    <i className="fa-solid fa-boxes-stacked text-[7px]"></i> {t('inventory.labels.stocked')}
                  </span>
                )}
              </div>
              <h2 className="text-xl font-black text-white tracking-tight flex items-center gap-2.5 flex-wrap">
                <span className="font-mono text-blue-300">{data.partNumber}</span>
                <span className="text-slate-400 font-normal">|</span>
                <span className="text-slate-100">{data.description}</span>
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white flex items-center justify-center transition-all shrink-0"
            title={t('inventory.actions.close')}
          >
            <i className="fa-solid fa-xmark text-lg"></i>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-50/50">
          
          {/* 4 Key Balance Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[9px] font-black uppercase text-slate-400">{t('inventory.stockCard.currentStock')}</div>
              <div className="text-xl font-black text-slate-900 mt-0.5">
                {data.quantityInStock.toLocaleString()} <span className="text-xs text-slate-400 font-bold">{data.unit}</span>
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[9px] font-black uppercase text-amber-500">{t('inventory.stockCard.reservedQty')}</div>
              <div className="text-xl font-black text-amber-600 mt-0.5">
                {data.quantityReserved.toLocaleString()} <span className="text-xs text-slate-400 font-bold">{data.unit}</span>
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[9px] font-black uppercase text-blue-500">{t('inventory.stockCard.availableQty')}</div>
              <div className="text-xl font-black text-blue-600 mt-0.5">
                {data.quantityAvailable.toLocaleString()} <span className="text-xs text-slate-400 font-bold">{data.unit}</span>
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[9px] font-black uppercase text-emerald-600">{t('inventory.labels.totalValue')}</div>
              <div className="text-lg font-black text-emerald-700 font-mono mt-0.5">
                {data.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}
              </div>
              <div className="text-[8px] font-bold text-slate-400">
                @ {data.unitValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'} / {data.unit}
              </div>
            </div>
          </div>

          {/* Primary Info & Dates Summary Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="text-[10px] font-black uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
              <i className="fa-solid fa-circle-info text-blue-500"></i>
              {t('inventory.stockCard.itemSpecifications')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.partSkuNumber')}</div>
                <div className="text-xs font-black font-mono text-blue-600 mt-0.5">{data.partNumber}</div>
              </div>
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.description')}</div>
                <div className="text-xs font-bold text-slate-800 mt-0.5">{data.description}</div>
              </div>
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.linkedCustomer')}</div>
                <div className="text-xs font-black text-slate-800 mt-0.5 flex items-center gap-1.5">
                  <i className="fa-solid fa-building text-slate-400 text-[10px]"></i>
                  {data.customerName || t('inventory.labels.internalStock')}
                </div>
              </div>
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{isAr ? 'رقم أمر الشراء المرتبط' : 'Linked PO Number'}</div>
                <div className="text-xs font-black font-mono text-slate-800 mt-0.5">
                  {data.poNumber ? `#${data.poNumber}` : 'N/A'}
                </div>
              </div>
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.orderRef')}</div>
                <div className="text-xs font-bold text-slate-700 mt-0.5">{data.orderRef}</div>
              </div>
              <div>
                <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.category')}</div>
                <div className="text-xs font-bold text-slate-700 mt-0.5">{data.category || t('inventory.labels.mechanical')}</div>
              </div>

              {/* Specific Date Highlights requested by user */}
              <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-100">
                <div className="text-[8px] font-black uppercase text-indigo-700 flex items-center gap-1">
                  <i className="fa-solid fa-calendar-plus text-[9px]"></i>
                  {t('inventory.stockCard.whenOrdered')}
                </div>
                <div className="text-xs font-black text-indigo-900 mt-0.5">
                  {formatDate(data.orderedDate)}
                </div>
                {data.orderedQty !== undefined && (
                  <div className="text-[9px] font-bold text-indigo-600 mt-0.5">
                    {t('inventory.stockCard.orderedQty')}: {data.orderedQty.toLocaleString()} {data.unit}
                  </div>
                )}
              </div>

              <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-100">
                <div className="text-[8px] font-black uppercase text-emerald-700 flex items-center gap-1">
                  <i className="fa-solid fa-truck-ramp-box text-[9px]"></i>
                  {t('inventory.stockCard.whenReceived')}
                </div>
                <div className="text-xs font-black text-emerald-900 mt-0.5">
                  {formatDate(data.receivedDate)}
                </div>
                {data.receivedQty !== undefined && (
                  <div className="text-[9px] font-bold text-emerald-600 mt-0.5">
                    {t('inventory.stockCard.receivedQty')}: {data.receivedQty.toLocaleString()} {data.unit}
                  </div>
                )}
              </div>

              <div className="p-3 bg-slate-100 rounded-xl border border-slate-200">
                <div className="text-[8px] font-black uppercase text-slate-600 flex items-center gap-1">
                  <i className="fa-solid fa-scale-balanced text-[9px]"></i>
                  {t('inventory.stockCard.stockClassification')}
                </div>
                <div className="text-xs font-black text-slate-800 mt-0.5">
                  {data.isPoLinked ? t('inventory.stockCard.customerLinkedPo') : t('inventory.stockCard.warehouseStock')}
                </div>
              </div>
            </div>
          </div>

          {/* Chronological Action History Ledger (Dates & Processed Quantities) */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider flex items-center gap-2">
                  <i className="fa-solid fa-timeline text-blue-600"></i>
                  {t('inventory.stockCard.movementsTitle')}
                </h3>
                <p className="text-[9px] font-bold text-slate-400 mt-0.5">
                  {t('inventory.stockCard.movementsSubtitle')}
                </p>
              </div>
              <span className="px-2.5 py-1 bg-slate-100 text-slate-600 rounded-full text-[10px] font-black">
                {isAr ? `${data.movements.length} إجراءات مسجلة` : `${data.movements.length} Action${data.movements.length === 1 ? '' : 's'} Recorded`}
              </span>
            </div>

            {data.movements.length === 0 ? (
              <div className="p-8 text-center text-slate-400 italic text-xs font-bold">
                {t('inventory.stockCard.noMovements')}
              </div>
            ) : (
              <div className="space-y-3">
                {data.movements.map((m, idx) => (
                  <div
                    key={m.id || idx}
                    className="p-4 rounded-2xl border border-slate-100 bg-slate-50/60 hover:bg-slate-50 hover:border-slate-300 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 text-sm shrink-0 shadow-2xs mt-0.5">
                        <i className={`fa-solid ${m.icon}`}></i>
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className={`px-2 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${m.badgeClass}`}>
                            {getMovementLabel(m)}
                          </span>
                          <span className="text-[10px] font-mono font-bold text-slate-500">
                            {formatDate(m.date)}
                          </span>
                          {m.user && (
                            <span className="text-[9px] font-bold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                              {t('inventory.stockCard.byUser')}: {getMovementUser(m.user)}
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-bold text-slate-700">
                          {m.notes || getMovementLabel(m)}
                        </div>
                        <div className="flex items-center gap-3 text-[9px] font-bold text-slate-400 mt-1 flex-wrap">
                          {m.poNumber && <span>{t('inventory.labels.po')}: #{m.poNumber}</span>}
                          {m.orderRef && <span>{t('inventory.labels.order')}: {m.orderRef}</span>}
                          {m.customerName && <span>{isAr ? 'الطرف:' : 'Party:'} {m.customerName}</span>}
                          {m.supplierName && <span>{t('inventory.labels.vendor')}: {m.supplierName}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0 bg-white px-4 py-2 rounded-xl border border-slate-200 self-end md:self-center">
                      <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.stockCard.qtyProcessed')}</div>
                      <div className={`text-base font-black font-mono ${
                        m.action === 'RECEIVED' ? 'text-emerald-600' :
                        m.action === 'ORDERED' ? 'text-indigo-600' :
                        m.action === 'RESERVED' ? 'text-amber-600' :
                        m.action === 'DISPATCHED' || m.action === 'RELEASED' ? 'text-rose-600' : 'text-slate-800'
                      }`}>
                        {m.action === 'RECEIVED' ? '+' : m.action === 'RELEASED' || m.action === 'DISPATCHED' ? '-' : ''}
                        {m.quantity.toLocaleString()} <span className="text-xs font-bold">{m.unit}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-between">
          <div className="text-[10px] font-bold text-slate-500">
            {t('inventory.stockCard.footer')}
          </div>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-slate-900 hover:bg-black text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all"
          >
            {t('inventory.actions.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

const ReceptionCountdown: React.FC<{ targetDate?: string }> = ({ targetDate }) => {
  if (!targetDate) return null;
  const { language } = useLanguage();
  const isAr = language === 'ar';

  const target = new Date(targetDate).getTime();
  const now = new Date().getTime();
  const diff = target - now;
  const isOver = diff < 0;
  const absRemaining = Math.abs(diff);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}${isAr ? 'س' : 'h'} ${mins}${isAr ? 'د' : 'm'}` : `${mins}${isAr ? 'د' : 'm'}`;

  return (
    <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 mt-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-hourglass'}`}></i>
      {isOver ? (isAr ? `متأخر بمقدار ${timeStr}` : `Overdue by ${timeStr}`) : (isAr ? `المتبقي: ${timeStr}` : `SLA: ${timeStr} left`)}
    </div>
  );
};

const InventoryModuleInner: React.FC<InventoryModuleProps> = ({ config, refreshKey, currentUser }) => {
  const { t, language } = useLanguage();
  const isAr = language === 'ar';
  const [activeTab, setActiveTab] = useState<InventoryTab>('inventory');
  const [inventorySubTab, setInventorySubTab] = useState<InventorySubTab>('component-stock');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [selectedStockCardItem, setSelectedStockCardItem] = useState<StockCardItemData | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });

  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('all');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [receptionSearchQuery, setReceptionSearchQuery] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [receivedQtyInput, setReceivedQtyInput] = useState<string>('');
  const [hubInputs, setHubInputs] = useState<Record<string, string>>({});

  const [printingOrder, setPrintingOrder] = useState<CustomerOrder | null>(null); // Kept for future if needed, but currently unused
  // Delivery confirmation moved to Shipment module

  useEffect(() => {
    loadData();
  }, [refreshKey, activeTab]);

  const [pendingDispatch, setPendingDispatch] = useState<CustomerOrder | null>(null);
  const [dispatchInputs, setDispatchInputs] = useState<Record<string, string>>({});

  const loadData = async () => {
    const [invData, orderData, suppData] = await Promise.all([
      dataService.getInventory(),
      dataService.getOrders(),
      dataService.getSuppliers()
    ]);
    setItems(invData);
    setAllOrders(orderData);
    setSuppliers(suppData);
    setLoading(false);
  };

  const openComponentStockCard = (inv: InventoryItem) => {
    setSelectedStockCardItem(buildStockCardData('Component', inv, allOrders, suppliers, items));
  };

  const openProductStockCard = (p: { order: CustomerOrder; item: CustomerOrderItem; hubQty: number; mfdQty: number; target: number }) => {
    setSelectedStockCardItem(buildStockCardData('Product', p, allOrders, suppliers, items));
  };

  const openTotalStockCard = (tot: TotalStockItem) => {
    setSelectedStockCardItem(buildStockCardData(tot.stockType, tot, allOrders, suppliers, items));
  };

  // Component Stock Items: Filter out any items related to Trade orders
  const componentStockItems = useMemo(() => {
    return items.filter(inv => !isItemTrade(inv, allOrders));
  }, [items, allOrders]);

  const transitComponents = useMemo(() => {
    const list: { order: CustomerOrder, item: CustomerOrderItem, comp: ManufacturingComponent }[] = [];
    allOrders.forEach(order => {
      if (order.status === OrderStatus.REJECTED) return;
      order.items.forEach(item => {
        item.components?.forEach(comp => {
          if (comp.status === 'ORDERED' || comp.status === 'ORDERED_FOR_STOCK') {
            if (selectedSupplierId === 'all' || comp.supplierId === selectedSupplierId) {
              list.push({ order, item, comp });
            }
          }
        });
      });
    });
    return list;
  }, [allOrders, selectedSupplierId]);

  const filteredTransitComponents = useMemo(() => {
    const q = receptionSearchQuery.toLowerCase().trim();
    if (!q) return transitComponents;

    const terms = q.split(/\s+/).filter(Boolean);

    return transitComponents.filter(r => {
      const supplier = suppliers.find(s => s.id === r.comp.supplierId);
      const supplierName = (supplier?.name || r.comp.supplierName || '').toLowerCase();
      const compDesc = (r.comp.description || '').toLowerCase();
      const compNum = (r.comp.componentNumber || '').toLowerCase();
      const supplierPartNum = (r.comp.supplierPartNumber || '').toLowerCase();
      const itemDesc = (r.item?.description || '').toLowerCase();
      const itemNum = (r.item?.orderNumber || '').toLowerCase();
      const internalOrderNum = (r.order.internalOrderNumber || '').toLowerCase();
      const customerPo = (r.order.customerReferenceNumber || '').toLowerCase();
      const compPo = (r.comp.poNumber || '').toLowerCase();
      const customerName = (r.order.customerName || '').toLowerCase();
      const qtyStr = String(r.comp.quantity ?? '');
      const unitStr = (r.comp.unit || '').toLowerCase();
      const qtyWithUnit = `${qtyStr} ${unitStr}`.toLowerCase();
      const rcvdQtyStr = String(r.comp.receivedQty ?? '');

      const poType = getOrderPoType(r.order, r.item, r.comp);
      const poCfg = getPoTypeConfig(poType);
      const orderTypeKeywords = `${poCfg.searchKeywords} normal standard`;

      const searchCorpus = [
        supplierName,
        compDesc,
        compNum,
        supplierPartNum,
        itemDesc,
        itemNum,
        internalOrderNum,
        customerPo,
        compPo,
        customerName,
        qtyStr,
        unitStr,
        qtyWithUnit,
        rcvdQtyStr,
        orderTypeKeywords,
      ].join(' ').toLowerCase();

      return terms.every(term => searchCorpus.includes(term));
    });
  }, [transitComponents, receptionSearchQuery, suppliers]);

  const finishedGoodsAwaitingHub = useMemo(() => {
    return allOrders.filter(o =>
      !isStockOrder(o) && (
        o.status === OrderStatus.MANUFACTURING_COMPLETED ||
        (o.status === OrderStatus.MANUFACTURING && o.items.some(i => (i.manufacturedQty || 0) > (i.hubReceivedQty || 0)))
      )
    );
  }, [allOrders]);

  const invoicedAwaitingDispatch = useMemo(() => {
    return allOrders.filter(o => {
      if (isStockOrder(o)) return false;
      if ([OrderStatus.REJECTED, OrderStatus.IN_HOLD].includes(o.status)) return false;
      return o.items.some(i => (i.approvedForDispatchQty || 0) > (i.dispatchedQty || 0));
    });
  }, [allOrders]);

  const recentDispatches = useMemo(() => {
    return allOrders.filter(o => [OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.FULFILLED].includes(o.status))
      .sort((a, b) => b.dataEntryTimestamp.localeCompare(a.dataEntryTimestamp))
      .slice(0, 10);
  }, [allOrders]);

  const goodsInHubReadyForInvoice = useMemo(() => {
    return allOrders.filter(o => !isStockOrder(o) && o.status === OrderStatus.IN_PRODUCT_HUB);
  }, [allOrders]);

  const hubStorageItems = useMemo(() => {
    const list: { order: CustomerOrder, item: CustomerOrderItem, hubQty: number, mfdQty: number, target: number, allMfgDone: boolean }[] = [];
    allOrders.forEach(order => {
      if (isStockOrder(order)) return;
      const allDone = order.items.every(i => (i.manufacturedQty || 0) >= getItemEffectiveQty(i));
      order.items.forEach(item => {
        const hubQty = item.hubReceivedQty || 0;
        if (hubQty > 0) {
          list.push({
            order,
            item,
            hubQty,
            mfdQty: item.manufacturedQty || 0,
            target: getItemEffectiveQty(item),
            allMfgDone: allDone
          });
        }
      });
    });
    return list;
  }, [allOrders]);

  // Unified Total Stock Items (combining Component Stock and Product Stock)
  const totalStockItems = useMemo<TotalStockItem[]>(() => {
    const compRows: TotalStockItem[] = componentStockItems.map(inv => {
      const order = inv.orderRef ? allOrders.find(o => o.internalOrderNumber === inv.orderRef || o.customerReferenceNumber === inv.orderRef) : undefined;
      const isPoLinked = isComponentPoLinked(inv, allOrders);
      const qty = Number(inv.quantityInStock) || 0;
      const rsrv = Number(inv.quantityReserved) || 0;
      const unitVal = Number(inv.lastCost) || 0;
      const poClass: PoClassification = order ? getOrderPoType(order) : (isPoLinked ? 'Manufacturing' : 'Stock');

      return {
        id: `comp-${inv.id}`,
        stockType: 'Component',
        identifier: inv.sku || 'N/A',
        description: inv.description,
        orderRef: inv.orderRef || 'STOCK',
        poNumber: inv.poNumber,
        customerName: order ? order.customerName : (isPoLinked ? 'Customer Order' : 'Internal Stock'),
        poClassification: poClass,
        isPoLinked,
        quantityInStock: qty,
        quantityReserved: rsrv,
        unit: inv.unit || 'pcs',
        unitValue: unitVal,
        totalValue: qty * unitVal
      };
    });

    const prodRows: TotalStockItem[] = hubStorageItems.map(p => {
      const isPoLinked = isProductPoLinked(p.order);
      const qty = p.hubQty || 0;
      const rsrv = isPoLinked ? qty : 0;
      const unitVal = getProductUnitValue(p.item);
      const poClass = getOrderPoType(p.order, p.item);

      return {
        id: `prod-${p.order.id}-${p.item.id}`,
        stockType: 'Product',
        identifier: p.order.internalOrderNumber || p.item.orderNumber || 'PRODUCT',
        description: p.item.description,
        orderRef: p.order.customerReferenceNumber || p.order.internalOrderNumber || 'N/A',
        poNumber: p.order.customerReferenceNumber,
        customerName: p.order.customerName,
        poClassification: poClass,
        isPoLinked,
        quantityInStock: qty,
        quantityReserved: rsrv,
        unit: p.item.unit || 'pcs',
        unitValue: unitVal,
        totalValue: qty * unitVal
      };
    });

    return [...compRows, ...prodRows];
  }, [componentStockItems, hubStorageItems, allOrders]);

  // Tab Metrics: Total Value, PO Linked Value, Reserved Value, Stocked Value
  const componentMetrics = useMemo(() => {
    let totalVal = 0;
    let poLinkedVal = 0;
    let reservedVal = 0;
    let stockedVal = 0;

    componentStockItems.forEach(item => {
      const qty = Number(item.quantityInStock) || 0;
      const rsrv = Number(item.quantityReserved) || 0;
      const cost = Number(item.lastCost) || 0;
      const itemVal = qty * cost;
      const itemRsrv = rsrv * cost;

      totalVal += itemVal;
      reservedVal += itemRsrv;

      if (isComponentPoLinked(item, allOrders)) {
        poLinkedVal += itemVal;
      } else {
        stockedVal += itemVal;
      }
    });

    return { totalVal, poLinkedVal, reservedVal, stockedVal };
  }, [componentStockItems, allOrders]);

  const productMetrics = useMemo(() => {
    let totalVal = 0;
    let poLinkedVal = 0;
    let reservedVal = 0;
    let stockedVal = 0;

    hubStorageItems.forEach(p => {
      const qty = p.hubQty || 0;
      const unitVal = getProductUnitValue(p.item);
      const itemVal = qty * unitVal;

      totalVal += itemVal;

      if (isProductPoLinked(p.order)) {
        poLinkedVal += itemVal;
        reservedVal += itemVal;
      } else {
        stockedVal += itemVal;
      }
    });

    return { totalVal, poLinkedVal, reservedVal, stockedVal };
  }, [hubStorageItems]);

  const totalStockMetrics = useMemo(() => {
    return {
      totalVal: componentMetrics.totalVal + productMetrics.totalVal,
      poLinkedVal: componentMetrics.poLinkedVal + productMetrics.poLinkedVal,
      reservedVal: componentMetrics.reservedVal + productMetrics.reservedVal,
      stockedVal: componentMetrics.stockedVal + productMetrics.stockedVal,
    };
  }, [componentMetrics, productMetrics]);

  const activeMetrics = useMemo(() => {
    if (inventorySubTab === 'component-stock') return componentMetrics;
    if (inventorySubTab === 'product-stock') return productMetrics;
    return totalStockMetrics;
  }, [inventorySubTab, componentMetrics, productMetrics, totalStockMetrics]);

  const filteredComponentItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return componentStockItems;
    return componentStockItems.filter(i => {
      const order = i.orderRef ? allOrders.find(o => o.internalOrderNumber === i.orderRef || o.customerReferenceNumber === i.orderRef) : undefined;
      const poType = order ? getOrderPoType(order) : 'Stock';
      const poCfg = getPoTypeConfig(poType);
      const isPoLinked = isComponentPoLinked(i, allOrders);
      const typeStr = isPoLinked ? 'po linked customer' : 'stocked stock unlinked';
      const matchKeywords = typeof poCfg.searchKeywords === 'string'
        ? poCfg.searchKeywords.toLowerCase().includes(q)
        : Array.isArray(poCfg.searchKeywords)
        ? (poCfg.searchKeywords as string[]).some(k => (k || '').toLowerCase().includes(q))
        : false;
      return (
        (i.sku || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.poNumber || '').toLowerCase().includes(q) ||
        (i.orderRef || '').toLowerCase().includes(q) ||
        (order?.customerName || '').toLowerCase().includes(q) ||
        typeStr.includes(q) ||
        matchKeywords
      );
    });
  }, [componentStockItems, searchQuery, allOrders]);

  const filteredProductItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return hubStorageItems;
    return hubStorageItems.filter(p => {
      const poType = getOrderPoType(p.order, p.item);
      const poCfg = getPoTypeConfig(poType);
      const isPoLinked = isProductPoLinked(p.order);
      const typeStr = isPoLinked ? 'po linked customer' : 'stocked stock unlinked';
      const matchKeywords = typeof poCfg.searchKeywords === 'string'
        ? poCfg.searchKeywords.toLowerCase().includes(q)
        : Array.isArray(poCfg.searchKeywords)
        ? (poCfg.searchKeywords as string[]).some(k => (k || '').toLowerCase().includes(q))
        : false;
      return (
        (p.order.internalOrderNumber || '').toLowerCase().includes(q) ||
        (p.order.customerReferenceNumber || '').toLowerCase().includes(q) ||
        (p.order.customerName || '').toLowerCase().includes(q) ||
        (p.item.description || '').toLowerCase().includes(q) ||
        typeStr.includes(q) ||
        matchKeywords
      );
    });
  }, [hubStorageItems, searchQuery]);

  const filteredTotalStockItems = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return totalStockItems;
    return totalStockItems.filter(r => {
      const poCfg = getPoTypeConfig(r.poClassification);
      const stockTypeStr = r.stockType.toLowerCase();
      const linkTypeStr = r.isPoLinked ? 'po linked customer' : 'stocked stock unlinked';
      const matchKeywords = typeof poCfg.searchKeywords === 'string'
        ? poCfg.searchKeywords.toLowerCase().includes(q)
        : Array.isArray(poCfg.searchKeywords)
        ? (poCfg.searchKeywords as string[]).some(k => (k || '').toLowerCase().includes(q))
        : false;
      return (
        r.identifier.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.orderRef.toLowerCase().includes(q) ||
        (r.poNumber || '').toLowerCase().includes(q) ||
        r.customerName.toLowerCase().includes(q) ||
        stockTypeStr.includes(q) ||
        linkTypeStr.includes(q) ||
        matchKeywords
      );
    });
  }, [totalStockItems, searchQuery]);

  // Flattened rows for Hub Intake table (no rowSpan needed)
  type HubIntakeRow = { order: CustomerOrder; item: CustomerOrderItem; mfd: number; hub: number; readyForIntake: number; isFallback: boolean };
  const hubIntakeRows = useMemo<HubIntakeRow[]>(() => {
    const rows: HubIntakeRow[] = [];
    finishedGoodsAwaitingHub.forEach(order => {
      const hasItemLevel = order.items.some(i => (i.manufacturedQty || 0) > (i.hubReceivedQty || 0));
      if (!hasItemLevel && order.status === OrderStatus.MANUFACTURING_COMPLETED) {
        // Fallback row for legacy orders
        order.items.forEach(item => {
          const qty = getItemEffectiveQty(item);
          rows.push({ order, item, mfd: qty, hub: 0, readyForIntake: qty, isFallback: true });
        });
      } else {
        order.items.forEach(item => {
          const mfd = item.manufacturedQty || 0;
          const hub = item.hubReceivedQty || 0;
          if (mfd > hub) {
            rows.push({ order, item, mfd, hub, readyForIntake: mfd - hub, isFallback: false });
          }
        });
      }
    });
    return rows;
  }, [finishedGoodsAwaitingHub]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSku = newItem.sku.trim();
    if (trimmedSku) {
      const isDuplicate = items.some(i => (i.sku || '').trim().toLowerCase() === trimmedSku.toLowerCase());
      if (isDuplicate) {
        alert(t('inventory.alerts.skuExists', { sku: trimmedSku }));
        return;
      }
    }
    await dataService.addInventoryItem({ ...newItem, sku: trimmedSku, description: newItem.description.trim() });
    await loadData();
    setIsAdding(false);
    setNewItem({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });
  };

  const executeMaterialReception = async () => {
    if (!pendingConfirm || !pendingConfirm.comp || !pendingConfirm.item) return;
    const { order, item, comp } = pendingConfirm;

    const leftToReceive = (comp.quantity || 0) - (comp.receivedQty || 0);
    const qtyToReceive = parseFloat(receivedQtyInput);
    if (isNaN(qtyToReceive) || qtyToReceive <= 0 || qtyToReceive > leftToReceive) {
      return;
    }

    setProcessingId(comp.id);
    try {
      await dataService.receiveComponent(order.id, item.id, comp.id, qtyToReceive);
      await loadData();
      setPendingConfirm(null);
      setReceivedQtyInput('');
    } catch (e) {
      alert(t('inventory.alerts.receptionFailed'));
    } finally {
      setProcessingId(null);
    }
  };

  const executeHubReception = async (orderId: string) => {
    setProcessingId(orderId);
    try {
      await dataService.receiveAtProductHub(orderId);
      await loadData();
    } catch (e: any) {
      alert(e.message || t('inventory.alerts.hubReceiveFailed'));
    } finally {
      setProcessingId(null);
    }
  };

  const executePartialHubReception = async () => {
    if (!pendingConfirm || pendingConfirm.type !== 'hub') return;
    const orderId = pendingConfirm.order.id;

    const receipts = pendingConfirm.order.items.map(item => ({
      itemId: item.id,
      qty: parseFloat(hubInputs[item.id] || '0')
    })).filter(r => !isNaN(r.qty) && r.qty > 0);

    if (receipts.length === 0) {
      alert(t('inventory.alerts.noIntakeQty'));
      return;
    }

    setProcessingId(orderId);
    try {
      await dataService.receivePartialHub(orderId, receipts);
      await loadData();
      setPendingConfirm(null);
      setHubInputs({});
    } catch (e: any) {
      alert(e.message || t('inventory.alerts.partialHubFailed'));
    } finally {
      setProcessingId(null);
    }
  };

  const executeDispatchRelease = async () => {
    if (!pendingDispatch) return;
    const orderId = pendingDispatch.id;
    setProcessingId(orderId);
    try {
      const itemsPayload = Object.entries(dispatchInputs)
        .map(([itemId, qtyStr]) => ({ itemId, qty: parseFloat(qtyStr) || 0 }))
        .filter(item => item.qty > 0);

      if (itemsPayload.length === 0) throw new Error(t('inventory.alerts.dispatchZero'));

      // Strict Validation: Ensure no item exceeds max
      for (const pItem of itemsPayload) {
        const item = pendingDispatch.items.find(i => i.id === pItem.itemId);
        if (item) {
          const inHub = (item.hubReceivedQty || 0) - (item.dispatchedQty || 0);
          const approved = (item.approvedForDispatchQty || 0) - (item.dispatchedQty || 0);
          const max = Math.max(0, Math.min(inHub, approved));
          if (pItem.qty > max) {
            throw new Error(t('inventory.alerts.dispatchQtyExceeds', { item: item.description, max }));
          }
        }
      }

      await dataService.dispatchAction(orderId, 'release-delivery', { items: itemsPayload });
      await loadData();
      setPendingDispatch(null);
      setDispatchInputs({});
    } catch (e: any) {
      alert(e.message || t('inventory.alerts.dispatchFailed'));
    } finally {
      setProcessingId(null);
    }
  };

  // handlePodUpload removed, handled by ShipmentModule

  const isConfirmationAllowed = useMemo(() => {
    if (!pendingConfirm) return false;
    if (pendingConfirm.type !== 'material') return true;
    const leftToReceive = (pendingConfirm.comp?.quantity || 0) - (pendingConfirm.comp?.receivedQty || 0);
    const inputQty = parseFloat(receivedQtyInput);
    return !isNaN(inputQty) && inputQty > 0 && inputQty <= leftToReceive;
  }, [pendingConfirm, receivedQtyInput]);

  return (
    <div className="space-y-6" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-3">
        <LanguageToggle />
        <div className="flex flex-wrap gap-1 p-1 bg-slate-200 rounded-2xl w-fit">
          {(['inventory', 'reception', 'hub', 'dispatch'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {tab === 'reception' && transitComponents.length > 0 && <span className={`${isAr ? 'ml-2' : 'mr-2'} px-1.5 py-0.5 bg-rose-500 text-white rounded-full`}>{transitComponents.length}</span>}
              {tab === 'hub' && finishedGoodsAwaitingHub.length > 0 && <span className={`${isAr ? 'ml-2' : 'mr-2'} px-1.5 py-0.5 bg-amber-500 text-white rounded-full`}>{finishedGoodsAwaitingHub.length}</span>}
              {tab === 'dispatch' && invoicedAwaitingDispatch.length > 0 && <span className={`${isAr ? 'ml-2' : 'mr-2'} px-1.5 py-0.5 bg-sky-500 text-white rounded-full animate-bounce`}>{invoicedAwaitingDispatch.length}</span>}
              {tab === 'inventory' ? t('inventory.tabs.inventory') : tab === 'reception' ? t('inventory.tabs.reception') : tab === 'hub' ? t('inventory.tabs.hub') : t('inventory.tabs.dispatch')}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'inventory' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex gap-1 p-1 bg-slate-100 rounded-xl">
                <button
                  onClick={() => setInventorySubTab('component-stock')}
                  className={`px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${inventorySubTab === 'component-stock' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className={`fa-solid fa-boxes-stacked ${isAr ? 'ml-1.5' : 'mr-1.5'}`}></i>{t('inventory.subTabs.componentStock')}
                  {componentStockItems.length > 0 && <span className={`${isAr ? 'mr-1.5' : 'ml-1.5'} px-1.5 py-0.5 bg-blue-500 text-white rounded-full text-[8px]`}>{componentStockItems.length}</span>}
                </button>
                <button
                  onClick={() => setInventorySubTab('product-stock')}
                  className={`px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${inventorySubTab === 'product-stock' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className={`fa-solid fa-warehouse ${isAr ? 'ml-1.5' : 'mr-1.5'}`}></i>{t('inventory.subTabs.productStock')}
                  {hubStorageItems.length > 0 && <span className={`${isAr ? 'mr-1.5' : 'ml-1.5'} px-1.5 py-0.5 bg-emerald-500 text-white rounded-full text-[8px]`}>{hubStorageItems.length}</span>}
                </button>
                <button
                  onClick={() => setInventorySubTab('total-stock')}
                  className={`px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${inventorySubTab === 'total-stock' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className={`fa-solid fa-layer-group ${isAr ? 'ml-1.5' : 'mr-1.5'}`}></i>{t('inventory.subTabs.totalStock')}
                  {totalStockItems.length > 0 && <span className={`${isAr ? 'mr-1.5' : 'ml-1.5'} px-1.5 py-0.5 bg-slate-700 text-white rounded-full text-[8px]`}>{totalStockItems.length}</span>}
                </button>
              </div>
            </div>

            <div className="flex-1 max-w-md relative mx-4">
              <input
                type="text"
                placeholder={
                  inventorySubTab === 'component-stock'
                    ? t('inventory.search.componentPlaceholder')
                    : inventorySubTab === 'product-stock'
                    ? t('inventory.search.productPlaceholder')
                    : t('inventory.search.totalPlaceholder')
                }
                className={`w-full px-5 py-2.5 ${isAr ? 'pr-11 pl-10' : 'pl-11 pr-10'} bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 transition-all font-bold text-xs`}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              <i className={`fa-solid fa-magnifying-glass absolute ${isAr ? 'right-4' : 'left-4'} top-1/2 -translate-y-1/2 text-slate-400 text-sm`}></i>
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className={`absolute ${isAr ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs p-1`}
                  title={t('inventory.search.clear')}
                >
                  <i className="fa-solid fa-xmark"></i>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                <button
                  onClick={() => setViewMode('cards')}
                  className={`px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${viewMode === 'cards' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-400 hover:text-slate-600'}`}
                  title={t('inventory.viewMode.cardViewTitle')}
                >
                  <i className="fa-solid fa-grip"></i>
                  <span>{t('inventory.viewMode.cards')}</span>
                </button>
                <button
                  onClick={() => setViewMode('table')}
                  className={`px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 ${viewMode === 'table' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-400 hover:text-slate-600'}`}
                  title={t('inventory.viewMode.tableViewTitle')}
                >
                  <i className="fa-solid fa-table-list"></i>
                  <span>{t('inventory.viewMode.table')}</span>
                </button>
              </div>

              {inventorySubTab === 'component-stock' && (
                <button onClick={() => setIsAdding(!isAdding)} className="px-6 py-2.5 bg-slate-900 text-white rounded-xl font-black text-[10px] uppercase shadow-lg hover:bg-black transition-all shrink-0">
                  <i className={`fa-solid fa-plus ${isAr ? 'ml-1.5' : 'mr-1.5'}`}></i>{t('inventory.actions.addItem')}
                </button>
              )}
            </div>
          </div>

          {/* 4 Universal Value Metrics for the Active Tab */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 p-6 bg-slate-50/70 border-b border-slate-100">
            {/* 1. Total Value */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
                <i className="fa-solid fa-vault"></i>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-black uppercase tracking-wider text-slate-400">{t('inventory.metrics.totalValue')}</div>
                <div className="text-base font-black text-slate-900 font-mono truncate">
                  {isAr ? '' : 'L.E. '}{activeMetrics.totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{isAr ? ' ج.م.' : ''}
                </div>
                <div className="text-[8px] font-bold text-slate-400 truncate">{t('inventory.metrics.totalValueHint')}</div>
              </div>
            </div>

            {/* 2. PO Linked Value */}
            <div className="bg-white p-4 rounded-2xl border border-indigo-100 shadow-xs flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl shrink-0">
                <i className="fa-solid fa-link"></i>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-black uppercase tracking-wider text-indigo-600">{t('inventory.metrics.poLinkedValue')}</div>
                <div className="text-base font-black text-indigo-900 font-mono truncate">
                  {isAr ? '' : 'L.E. '}{activeMetrics.poLinkedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{isAr ? ' ج.م.' : ''}
                </div>
                <div className="text-[8px] font-bold text-indigo-400 truncate">{t('inventory.metrics.poLinkedValueHint')}</div>
              </div>
            </div>

            {/* 3. Reserved Value */}
            <div className="bg-white p-4 rounded-2xl border border-amber-100 shadow-xs flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-xl shrink-0">
                <i className="fa-solid fa-lock"></i>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-black uppercase tracking-wider text-amber-600">{t('inventory.metrics.reservedValue')}</div>
                <div className="text-base font-black text-amber-900 font-mono truncate">
                  {isAr ? '' : 'L.E. '}{activeMetrics.reservedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{isAr ? ' ج.م.' : ''}
                </div>
                <div className="text-[8px] font-bold text-amber-400 truncate">{t('inventory.metrics.reservedValueHint')}</div>
              </div>
            </div>

            {/* 4. Stocked Value */}
            <div className="bg-white p-4 rounded-2xl border border-emerald-100 shadow-xs flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl shrink-0">
                <i className="fa-solid fa-boxes-stacked"></i>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-black uppercase tracking-wider text-emerald-600">{t('inventory.metrics.stockedValue')}</div>
                <div className="text-base font-black text-emerald-900 font-mono truncate">
                  {isAr ? '' : 'L.E. '}{activeMetrics.stockedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{isAr ? ' ج.م.' : ''}
                </div>
                <div className="text-[8px] font-bold text-emerald-400 truncate">{t('inventory.metrics.stockedValueHint')}</div>
              </div>
            </div>
          </div>

          {/* SubTab 1: Component Stock */}
          {inventorySubTab === 'component-stock' && (
            viewMode === 'cards' ? (
              <div className="p-6">
                {filteredComponentItems.length === 0 ? (
                  <div className="p-16 text-center text-slate-300 italic text-xs font-black uppercase tracking-widest bg-slate-50/50 rounded-2xl border border-slate-100">
                    <i className="fa-solid fa-boxes-stacked text-3xl mb-3 opacity-30 block"></i>
                    {isAr ? 'لا توجد بنود في مخزون المكونات.' : 'No component stock items found.'}
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {filteredComponentItems.map(r => {
                      const order = r.orderRef ? allOrders.find(o => o.internalOrderNumber === r.orderRef || o.customerReferenceNumber === r.orderRef) : undefined;
                      const isPoLinked = isComponentPoLinked(r, allOrders);
                      const poType = order ? getOrderPoType(order) : 'Stock';
                      const cfg = getPoTypeConfig(poType);
                      const inStock = r.quantityInStock || 0;
                      const rsrv = r.quantityReserved || 0;
                      const avail = Math.max(0, inStock - rsrv);
                      const cost = r.lastCost || 0;
                      const totalVal = inStock * cost;

                      return (
                        <div
                          key={r.id}
                          onClick={() => openComponentStockCard(r)}
                          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs hover:shadow-md hover:border-blue-400 cursor-pointer transition-all flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4 group relative overflow-hidden"
                        >
                          <div className="absolute top-0 left-0 bottom-0 w-1.5 bg-gradient-to-b from-blue-500 to-indigo-500 opacity-90 group-hover:w-2.5 transition-all"></div>

                          {/* Left: SKU, Badges, Description, Category, Customer/PO Context */}
                          <div className={`min-w-0 flex-[1.6] ${isAr ? 'pr-2' : 'pl-2'} space-y-1.5`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-black text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-lg border border-blue-200 shadow-2xs">
                                {r.sku}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`} title={cfg.tooltip}>
                                <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                                {isAr ? cfg.arShortLabel : cfg.shortLabel}
                              </span>
                              {isPoLinked ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  <i className="fa-solid fa-link text-[7px]"></i> {t('inventory.labels.poLinked')}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <i className="fa-solid fa-boxes-stacked text-[7px]"></i> {t('inventory.labels.stocked')}
                                </span>
                              )}
                              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                                &bull; {r.category || t('inventory.labels.mechanical')}
                              </span>
                            </div>

                            <h4 className="font-black text-slate-800 text-sm group-hover:text-blue-600 transition-colors line-clamp-1" title={r.description}>
                              {r.description}
                            </h4>

                            <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500 flex-wrap">
                              <span>
                                <span className="text-slate-400 font-normal">{t('inventory.labels.po')}:</span> <strong className="font-mono text-slate-800">{r.poNumber ? `#${r.poNumber}` : 'N/A'}</strong>
                              </span>
                              <span>&bull;</span>
                              <span>
                                <span className="text-slate-400 font-normal">{t('inventory.labels.order')}:</span> <strong className="text-slate-800">{r.orderRef || 'STOCK'}</strong>
                              </span>
                              <span>&bull;</span>
                              <span className="flex items-center gap-1">
                                <i className="fa-solid fa-building text-slate-400 text-[9px]"></i>
                                <strong className="text-slate-800">{order ? (isStockOrder(order) ? t('inventory.labels.internalStock') : order.customerName) : (r.orderRef || t('inventory.labels.internalStock'))}</strong>
                              </span>
                            </div>
                          </div>

                          {/* Middle: In Stock, Reserved, Available Badges */}
                          <div className="shrink-0 flex items-center gap-3 bg-slate-50/90 p-2.5 sm:px-4 sm:py-2.5 rounded-2xl border border-slate-100 self-start xl:self-center">
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.inStock')}</div>
                              <div className="text-sm font-black text-slate-900">{inStock.toLocaleString()}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                            <div className="h-7 w-px bg-slate-200"></div>
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-amber-500">{t('inventory.labels.reserved')}</div>
                              <div className={`text-sm font-black ${rsrv > 0 ? 'text-amber-600' : 'text-slate-300'}`}>{rsrv.toLocaleString()}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                            <div className="h-7 w-px bg-slate-200"></div>
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-blue-500">{t('inventory.labels.available')}</div>
                              <div className="text-sm font-black text-blue-600">{avail.toLocaleString()}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                          </div>

                          {/* Right: Total Value & Open Stock Card button */}
                          <div className={`shrink-0 flex items-center justify-between xl:justify-end gap-5 ${isAr ? 'pr-2' : 'pl-2'} border-t xl:border-t-0 pt-3 xl:pt-0 border-slate-100`}>
                            <div className={isAr ? 'text-right xl:text-left' : 'text-left xl:text-right'}>
                              <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.totalValue')}</div>
                              <div className="text-sm font-black text-slate-900 font-mono">
                                {totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}
                              </div>
                              <div className="text-[8px] font-bold text-slate-400">
                                @ {cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'} / {r.unit}
                              </div>
                            </div>

                            <button
                              onClick={(e) => { e.stopPropagation(); openComponentStockCard(r); }}
                              className="px-4 py-2 bg-slate-900 hover:bg-blue-600 text-white rounded-xl text-[10px] font-black uppercase tracking-wider shadow-xs transition-all flex items-center gap-2 group-hover:bg-blue-600 shrink-0"
                            >
                              <i className="fa-solid fa-id-card"></i>
                              <span>{t('inventory.actions.stockCard')}</span>
                              <i className={`fa-solid ${isAr ? 'fa-chevron-left' : 'fa-chevron-right'} text-[9px] text-white/70 group-hover:translate-x-0.5 transition-transform`}></i>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <SortableTable<InventoryItem>
                storageKey="inv-component-stock"
                theadClassName="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b"
                data={filteredComponentItems}
                rowKey={(r) => r.id}
                onRowClick={(r) => openComponentStockCard(r)}
                emptyMessage={isAr ? 'لا توجد بنود في مخزون المكونات.' : 'No component stock items.'}
                columns={[
                  {
                    key: 'sku',
                    label: t('inventory.labels.skuDescription'),
                    sortValue: r => r.sku || r.description,
                    render: r => (
                      <>
                        <div className="font-mono text-[10px] font-black text-blue-600">{r.sku}</div>
                        <div className="font-bold text-slate-800 text-xs">{r.description}</div>
                        <div className="text-[9px] text-slate-400 font-medium uppercase">{r.category}</div>
                      </>
                    )
                  },
                  {
                    key: 'po',
                    label: t('inventory.labels.poContext'),
                    sortValue: r => r.poNumber || r.orderRef || '',
                    render: r => {
                      const order = r.orderRef ? allOrders.find(o => o.internalOrderNumber === r.orderRef || o.customerReferenceNumber === r.orderRef) : undefined;
                      const isPoLinked = isComponentPoLinked(r, allOrders);
                      const poType = order ? getOrderPoType(order) : 'Stock';
                      const cfg = getPoTypeConfig(poType);
                      return (
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] font-black text-slate-900 uppercase font-mono">#{r.poNumber || 'N/A'}</span>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`} title={cfg.tooltip}>
                              <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                              {isAr ? cfg.arShortLabel : cfg.shortLabel}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[9px] font-bold text-slate-500 uppercase">{r.orderRef || 'STOCK'}</span>
                            {isPoLinked ? (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
                                <i className="fa-solid fa-link text-[6px]"></i> {t('inventory.labels.poLinked')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[7px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                <i className="fa-solid fa-boxes-stacked text-[6px]"></i> {t('inventory.labels.stocked')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    }
                  },
                  { key: 'inStock', label: t('inventory.labels.inStock'), sortValue: r => r.quantityInStock, render: r => <span className="font-bold text-slate-900">{r.quantityInStock.toLocaleString()} {r.unit}</span> },
                  { key: 'reserved', label: t('inventory.labels.reserved'), sortValue: r => r.quantityReserved || 0, render: r => <span className={`font-bold ${(r.quantityReserved || 0) > 0 ? 'text-amber-600' : 'text-slate-300'}`}>{(r.quantityReserved || 0).toLocaleString()}</span> },
                  { key: 'available', label: t('inventory.labels.available'), sortValue: r => (r.quantityInStock || 0) - (r.quantityReserved || 0), render: r => <span className="font-black text-blue-600">{((r.quantityInStock || 0) - (r.quantityReserved || 0)).toLocaleString()}</span> },
                  { key: 'unitCost', label: t('inventory.labels.unitCost'), headerClassName: 'text-right', cellClassName: 'text-right', sortValue: r => r.lastCost || 0, render: r => <span className="font-bold text-slate-600">{(r.lastCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span> },
                  { key: 'value', label: t('inventory.labels.totalValue'), headerClassName: 'px-8 py-4 text-right', cellClassName: 'px-8 py-6 text-right', sortValue: r => (r.quantityInStock || 0) * (r.lastCost || 0), render: r => <span className="font-black text-slate-900 font-mono">{((r.quantityInStock || 0) * (r.lastCost || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span> },
                  {
                    key: 'cardAction',
                    label: t('inventory.actions.stockCard'),
                    headerClassName: 'px-6 py-4 text-center',
                    cellClassName: 'px-6 py-6 text-center',
                    sortable: false,
                    render: r => (
                      <button
                        onClick={(e) => { e.stopPropagation(); openComponentStockCard(r); }}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-700 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 mx-auto"
                      >
                        <i className="fa-solid fa-id-card"></i>
                        <span>{t('inventory.actions.card')}</span>
                      </button>
                    )
                  }
                ]}
              />
            )
          )}

          {/* SubTab 2: Product Stock */}
          {inventorySubTab === 'product-stock' && (
            viewMode === 'cards' ? (
              <div className="p-6">
                {filteredProductItems.length === 0 ? (
                  <div className="p-16 text-center text-slate-300 italic text-xs font-black uppercase tracking-widest bg-slate-50/50 rounded-2xl border border-slate-100">
                    <i className="fa-solid fa-warehouse text-3xl mb-3 opacity-30 block"></i>
                    {isAr ? 'لا توجد سلع تامة الصنع في مخزون المنتجات حالياً.' : 'No finished goods currently in product stock.'}
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {filteredProductItems.map(p => {
                      const poType = getOrderPoType(p.order, p.item);
                      const cfg = getPoTypeConfig(poType);
                      const isPoLinked = isProductPoLinked(p.order);
                      const unitVal = getProductUnitValue(p.item);
                      const totalVal = p.hubQty * unitVal;

                      return (
                        <div
                          key={`${p.order.id}-${p.item.id}`}
                          onClick={() => openProductStockCard(p)}
                          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs hover:shadow-md hover:border-emerald-400 cursor-pointer transition-all flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4 group relative overflow-hidden"
                        >
                          <div className="absolute top-0 left-0 bottom-0 w-1.5 bg-gradient-to-b from-emerald-500 to-teal-500 opacity-90 group-hover:w-2.5 transition-all"></div>

                          {/* Left: Reference, Badges, Item Description, Customer & PO */}
                          <div className={`min-w-0 flex-[1.6] ${isAr ? 'pr-2' : 'pl-2'} space-y-1.5`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-black text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-lg border border-emerald-200 shadow-2xs">
                                {p.order.internalOrderNumber}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`} title={isAr ? cfg.arLabel : cfg.label}>
                                <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                                {isAr ? cfg.arShortLabel : cfg.shortLabel}
                              </span>
                              {isPoLinked ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  <i className="fa-solid fa-link text-[7px]"></i> {t('inventory.labels.poLinked')}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <i className="fa-solid fa-boxes-stacked text-[7px]"></i> {t('inventory.labels.stocked')}
                                </span>
                              )}
                              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                                &bull; {p.item.productionType === 'TRADING' ? (isAr ? 'تجارة' : 'TRADING') : (isAr ? 'تصنيع' : 'MANUFACTURING')}
                              </span>
                            </div>

                            <h4 className="font-black text-slate-900 text-sm group-hover:text-emerald-600 transition-colors line-clamp-1" title={p.item.description}>
                              {p.item.description}
                            </h4>

                            <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500 flex-wrap">
                              <span className="flex items-center gap-1">
                                <i className="fa-solid fa-building text-slate-400 text-[9px]"></i>
                                <strong className="text-slate-800">{p.order.customerName}</strong>
                              </span>
                              <span>&bull;</span>
                              <span>
                                <span className="text-slate-400 font-normal">{t('inventory.labels.customerPo')}:</span> <strong className="font-mono text-slate-800">#{p.order.customerReferenceNumber || 'N/A'}</strong>
                              </span>
                              <span>&bull;</span>
                              <span>
                                <span className="text-slate-400 font-normal">{t('inventory.labels.orderTarget')}:</span> <strong className="text-slate-800">{p.target.toLocaleString()} {p.item.unit}</strong>
                              </span>
                            </div>
                          </div>

                          {/* Middle: In Product Stock & Fulfillment Status */}
                          <div className="shrink-0 flex items-center gap-4 bg-emerald-50/60 p-2.5 sm:px-4 sm:py-2.5 rounded-2xl border border-emerald-100 self-start xl:self-center min-w-[220px]">
                            <div className="w-9 h-9 rounded-xl bg-white border border-emerald-200 text-emerald-600 flex items-center justify-center text-base shrink-0 shadow-2xs">
                              <i className="fa-solid fa-warehouse"></i>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between text-[8px] font-black uppercase text-emerald-800">
                                <span>{t('inventory.labels.inProductStock')}</span>
                                <span>{Math.round(Math.min(100, (p.hubQty / (p.target || 1)) * 100))}%</span>
                              </div>
                              <div className="text-sm font-black text-emerald-700 font-mono">
                                {p.hubQty.toLocaleString()} <span className="text-xs font-bold text-emerald-600">{p.item.unit}</span>
                              </div>
                              <div className="w-full bg-emerald-200/70 rounded-full h-1 mt-1 overflow-hidden">
                                <div
                                  className={`h-full ${p.hubQty >= p.target ? 'bg-emerald-600' : 'bg-blue-600'}`}
                                  style={{ width: `${Math.min(100, (p.hubQty / (p.target || 1)) * 100)}%` }}
                                ></div>
                              </div>
                            </div>
                          </div>

                          {/* Right: Total Value & Open Stock Card button */}
                          <div className={`shrink-0 flex items-center justify-between xl:justify-end gap-5 ${isAr ? 'pr-2' : 'pl-2'} border-t xl:border-t-0 pt-3 xl:pt-0 border-slate-100`}>
                            <div className={isAr ? 'text-right xl:text-left' : 'text-left xl:text-right'}>
                              <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.totalValue')}</div>
                              <div className="text-sm font-black text-emerald-800 font-mono">
                                {totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}
                              </div>
                              <div className="text-[8px] font-bold text-slate-400">
                                @ {unitVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'} / {p.item.unit}
                              </div>
                            </div>

                            <button
                              onClick={(e) => { e.stopPropagation(); openProductStockCard(p); }}
                              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-[10px] font-black uppercase tracking-wider shadow-xs transition-all flex items-center gap-2 shrink-0"
                            >
                              <i className="fa-solid fa-id-card"></i>
                              <span>{t('inventory.actions.stockCard')}</span>
                              <i className={`fa-solid ${isAr ? 'fa-chevron-left' : 'fa-chevron-right'} text-[9px] text-white/70 group-hover:translate-x-0.5 transition-transform`}></i>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <SortableTable
                storageKey="inv-product-stock"
                theadClassName="bg-emerald-900 text-[10px] font-black uppercase text-emerald-300 tracking-widest"
                rowClassName="hover:bg-emerald-50/30 transition-colors"
                data={filteredProductItems}
                rowKey={(r) => `${r.order.id}-${r.item.id}`}
                onRowClick={(r) => openProductStockCard(r)}
                emptyMessage={isAr ? 'لا توجد سلع تامة الصنع في مخزون المنتجات حالياً.' : 'No finished goods currently in product stock.'}
                columns={[
                  {
                    key: 'poRef',
                    label: t('inventory.labels.poReference'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.order.internalOrderNumber,
                    render: r => {
                      const poType = getOrderPoType(r.order, r.item);
                      const cfg = getPoTypeConfig(poType);
                      return (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-black text-blue-600">{r.order.internalOrderNumber}</span>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${cfg.badgeClass} border text-[8px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap`} title={isAr ? cfg.arLabel : cfg.label}>
                              <i className={`fa-solid ${cfg.icon} text-[8px]`}></i> {isAr ? cfg.arShortLabel : cfg.shortLabel}
                            </span>
                          </div>
                          <div className="text-[9px] text-slate-400 mt-0.5">{r.order.customerReferenceNumber}</div>
                        </>
                      );
                    }
                  },
                  {
                    key: 'customer',
                    label: t('inventory.labels.customerClass'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.order.customerName,
                    render: r => {
                      const isPoLinked = isProductPoLinked(r.order);
                      return (
                        <div>
                          <div className="font-bold text-slate-800 text-sm">{r.order.customerName}</div>
                          <div className="mt-1">
                            {isPoLinked ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[7px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
                                <i className="fa-solid fa-link text-[6px]"></i> {t('inventory.labels.poLinked')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[7px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                <i className="fa-solid fa-boxes-stacked text-[6px]"></i> {t('inventory.labels.stocked')}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    }
                  },
                  { key: 'lineItem', label: t('inventory.labels.productItem'), headerClassName: 'px-8 py-4 text-white', sortValue: r => r.item.description, render: r => (<><div className="font-bold text-slate-700 text-xs">{r.item.description}</div><div className="text-[9px] text-slate-400 mt-0.5">{t('inventory.labels.orderQty')}: {r.target} {r.item.unit}</div></>) },
                  { key: 'inHub', label: t('inventory.labels.inProductStock'), headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.hubQty, render: r => (<><div className="font-black text-emerald-600 text-sm">{r.hubQty.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                  {
                    key: 'mfdTarget',
                    label: t('inventory.labels.fulfillmentTarget'),
                    headerClassName: 'px-8 py-4 text-white text-center',
                    cellClassName: 'px-8 py-6 text-center',
                    sortValue: r => r.hubQty / (r.target || 1),
                    render: r => {
                      if (r.item.productionType === 'TRADING') {
                        return (
                          <div>
                            <div className="font-black text-cyan-700 text-sm">{r.hubQty.toLocaleString()} / {r.target.toLocaleString()}</div>
                            <span className="text-[8px] font-black px-1.5 py-0.5 bg-cyan-50 text-cyan-700 border border-cyan-200 rounded uppercase">{t('inventory.labels.tradeReceived')}</span>
                          </div>
                        );
                      }
                      return (
                        <>
                          <div className="font-black text-slate-700 text-sm">{r.mfdQty.toLocaleString()} / {r.target.toLocaleString()}</div>
                          <div className="w-full bg-slate-100 rounded-full h-1 mt-1">
                            <div className={`h-1 rounded-full ${r.mfdQty >= r.target ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, (r.mfdQty / (r.target || 1)) * 100)}%` }}></div>
                          </div>
                        </>
                      );
                    }
                  },
                  {
                    key: 'unitVal',
                    label: t('inventory.labels.unitValue'),
                    headerClassName: 'px-8 py-4 text-white text-right',
                    cellClassName: 'px-8 py-6 text-right',
                    sortValue: r => getProductUnitValue(r.item),
                    render: r => <span className="font-bold text-slate-700">{getProductUnitValue(r.item).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span>
                  },
                  {
                    key: 'totalVal',
                    label: t('inventory.labels.totalValue'),
                    headerClassName: 'px-8 py-4 text-white text-right',
                    cellClassName: 'px-8 py-6 text-right',
                    sortValue: r => r.hubQty * getProductUnitValue(r.item),
                    render: r => <span className="font-black text-emerald-700 font-mono text-sm">{(r.hubQty * getProductUnitValue(r.item)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span>
                  },
                  {
                    key: 'cardAction',
                    label: t('inventory.actions.stockCard'),
                    headerClassName: 'px-6 py-4 text-white text-center',
                    cellClassName: 'px-6 py-6 text-center',
                    sortable: false,
                    render: r => (
                      <button
                        onClick={(e) => { e.stopPropagation(); openProductStockCard(r); }}
                        className="px-3 py-1.5 bg-emerald-100 hover:bg-emerald-700 hover:text-white text-emerald-800 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 mx-auto"
                      >
                        <i className="fa-solid fa-id-card"></i>
                        <span>{t('inventory.actions.card')}</span>
                      </button>
                    )
                  }
                ]}
              />
            )
          )}

          {/* SubTab 3: Total Stock */}
          {inventorySubTab === 'total-stock' && (
            viewMode === 'cards' ? (
              <div className="p-6">
                {filteredTotalStockItems.length === 0 ? (
                  <div className="p-16 text-center text-slate-300 italic text-xs font-black uppercase tracking-widest bg-slate-50/50 rounded-2xl border border-slate-100">
                    <i className="fa-solid fa-layer-group text-3xl mb-3 opacity-30 block"></i>
                    {isAr ? 'لم يتم العثور على بنود مخزون.' : 'No stock items found.'}
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {filteredTotalStockItems.map(r => {
                      const cfg = getPoTypeConfig(r.poClassification);

                      return (
                        <div
                          key={r.id}
                          onClick={() => openTotalStockCard(r)}
                          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs hover:shadow-md hover:border-slate-400 cursor-pointer transition-all flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4 group relative overflow-hidden"
                        >
                          <div className={`absolute top-0 left-0 bottom-0 w-1.5 ${r.stockType === 'Component' ? 'bg-gradient-to-b from-blue-500 to-indigo-500' : 'bg-gradient-to-b from-emerald-500 to-teal-500'} opacity-90 group-hover:w-2.5 transition-all`}></div>

                          {/* Left: Stock Type badge, Identifier, PO badge, Description, Context */}
                          <div className={`min-w-0 flex-[1.6] ${isAr ? 'pr-2' : 'pl-2'} space-y-1.5`}>
                            <div className="flex items-center gap-2 flex-wrap">
                              {r.stockType === 'Component' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-blue-50 text-blue-700 border border-blue-200">
                                  <i className="fa-solid fa-microchip text-[7px]"></i> {t('inventory.labels.component')}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <i className="fa-solid fa-cube text-[7px]"></i> {t('inventory.labels.product')}
                                </span>
                              )}
                              <span className="font-mono text-xs font-black text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 shadow-2xs">
                                {r.identifier}
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`} title={cfg.tooltip}>
                                <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                                {isAr ? cfg.arShortLabel : cfg.shortLabel}
                              </span>
                              {r.isPoLinked ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  <i className="fa-solid fa-link text-[7px]"></i> {t('inventory.labels.poLinked')}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200">
                                  <i className="fa-solid fa-boxes-stacked text-[7px]"></i> {t('inventory.labels.stocked')}
                                </span>
                              )}
                            </div>

                            <h4 className="font-black text-slate-900 text-sm group-hover:text-blue-600 transition-colors line-clamp-1" title={r.description}>
                              {r.description}
                            </h4>

                            <div className="flex items-center gap-3 text-[10px] font-bold text-slate-500 flex-wrap">
                              <span>
                                <span className="text-slate-400 font-normal">{isAr ? 'أمر الشراء / المرجع:' : 'PO / Ref:'}</span> <strong className="font-mono text-slate-800">#{r.poNumber || r.orderRef}</strong>
                              </span>
                              <span>&bull;</span>
                              <span className="flex items-center gap-1">
                                <i className="fa-solid fa-building text-slate-400 text-[9px]"></i>
                                <strong className="text-slate-800">{r.customerName}</strong>
                              </span>
                            </div>
                          </div>

                          {/* Middle: In Stock & Reserved */}
                          <div className="shrink-0 flex items-center gap-3 bg-slate-50/90 p-2.5 sm:px-4 sm:py-2.5 rounded-2xl border border-slate-100 self-start xl:self-center">
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.inStock')}</div>
                              <div className="text-sm font-black text-slate-900">{r.quantityInStock.toLocaleString()}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                            <div className="h-7 w-px bg-slate-200"></div>
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-amber-500">{t('inventory.labels.reserved')}</div>
                              <div className={`text-sm font-black ${r.quantityReserved > 0 ? 'text-amber-600' : 'text-slate-300'}`}>{r.quantityReserved > 0 ? r.quantityReserved.toLocaleString() : '0'}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                            <div className="h-7 w-px bg-slate-200"></div>
                            <div className="text-center px-2">
                              <div className="text-[8px] font-black uppercase text-blue-500">{t('inventory.labels.available')}</div>
                              <div className="text-sm font-black text-blue-600">{Math.max(0, r.quantityInStock - r.quantityReserved).toLocaleString()}</div>
                              <div className="text-[8px] text-slate-400 font-bold">{r.unit}</div>
                            </div>
                          </div>

                          {/* Right: Total Value & Open Stock Card button */}
                          <div className={`shrink-0 flex items-center justify-between xl:justify-end gap-5 ${isAr ? 'pr-2' : 'pl-2'} border-t xl:border-t-0 pt-3 xl:pt-0 border-slate-100`}>
                            <div className={isAr ? 'text-right xl:text-left' : 'text-left xl:text-right'}>
                              <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.totalValue')}</div>
                              <div className="text-sm font-black text-slate-900 font-mono">
                                {r.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}
                              </div>
                              <div className="text-[8px] font-bold text-slate-400">
                                @ {r.unitValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'} / {r.unit}
                              </div>
                            </div>

                            <button
                              onClick={(e) => { e.stopPropagation(); openTotalStockCard(r); }}
                              className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-wider shadow-xs transition-all flex items-center gap-2 shrink-0"
                            >
                              <i className="fa-solid fa-id-card"></i>
                              <span>{t('inventory.actions.stockCard')}</span>
                              <i className={`fa-solid ${isAr ? 'fa-chevron-left' : 'fa-chevron-right'} text-[9px] text-white/70 group-hover:translate-x-0.5 transition-transform`}></i>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <SortableTable<TotalStockItem>
                storageKey="inv-total-stock"
                theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-300 tracking-widest"
                rowClassName="hover:bg-slate-50 transition-colors"
                data={filteredTotalStockItems}
                rowKey={(r) => r.id}
                onRowClick={(r) => openTotalStockCard(r)}
                emptyMessage={isAr ? 'لم يتم العثور على بنود مخزون.' : 'No stock items found.'}
                columns={[
                  {
                    key: 'stockType',
                    label: t('inventory.labels.stockType'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.stockType,
                    render: r => (
                      r.stockType === 'Component' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-blue-50 text-blue-700 border border-blue-200 whitespace-nowrap">
                          <i className="fa-solid fa-microchip text-[7px]"></i> {t('inventory.labels.component')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">
                          <i className="fa-solid fa-cube text-[7px]"></i> {t('inventory.labels.product')}
                        </span>
                      )
                    )
                  },
                  {
                    key: 'sku',
                    label: t('inventory.labels.skuItemDescription'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.identifier || r.description,
                    render: r => (
                      <>
                        <div className="font-mono text-[10px] font-black text-blue-600">{r.identifier}</div>
                        <div className="font-bold text-slate-800 text-xs truncate max-w-[240px]" title={r.description}>{r.description}</div>
                      </>
                    )
                  },
                  {
                    key: 'orderRef',
                    label: t('inventory.labels.poContext'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.orderRef,
                    render: r => {
                      const cfg = getPoTypeConfig(r.poClassification);
                      return (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] font-black text-slate-900 uppercase font-mono">#{r.orderRef}</span>
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-black border uppercase tracking-wider ${cfg.badgeClass}`} title={cfg.tooltip}>
                              <i className={`fa-solid ${cfg.icon} text-[7px]`}></i>
                              {isAr ? cfg.arShortLabel : cfg.shortLabel}
                            </span>
                          </div>
                          <div className="text-[9px] text-slate-500 font-bold uppercase truncate max-w-[180px]">{r.customerName}</div>
                        </div>
                      );
                    }
                  },
                  {
                    key: 'class',
                    label: t('inventory.labels.stockClass'),
                    headerClassName: 'px-8 py-4 text-white',
                    sortValue: r => r.isPoLinked ? 1 : 0,
                    render: r => (
                      r.isPoLinked ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-indigo-50 text-indigo-700 border border-indigo-200 whitespace-nowrap">
                          <i className="fa-solid fa-link text-[7px]"></i> {t('inventory.labels.poLinked')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">
                          <i className="fa-solid fa-boxes-stacked text-[7px]"></i> {t('inventory.labels.stocked')}
                        </span>
                      )
                    )
                  },
                  {
                    key: 'inStock',
                    label: isAr ? 'في المخزون / المركز' : 'In Stock / Hub',
                    headerClassName: 'px-8 py-4 text-white text-center',
                    cellClassName: 'px-8 py-6 text-center',
                    sortValue: r => r.quantityInStock,
                    render: r => <span className="font-black text-slate-900">{r.quantityInStock.toLocaleString()} {r.unit}</span>
                  },
                  {
                    key: 'reserved',
                    label: t('inventory.labels.reserved'),
                    headerClassName: 'px-8 py-4 text-white text-center',
                    cellClassName: 'px-8 py-6 text-center',
                    sortValue: r => r.quantityReserved,
                    render: r => <span className={`font-bold ${r.quantityReserved > 0 ? 'text-amber-600' : 'text-slate-300'}`}>{r.quantityReserved > 0 ? r.quantityReserved.toLocaleString() : '0'}</span>
                  },
                  {
                    key: 'unitVal',
                    label: t('inventory.labels.unitValue'),
                    headerClassName: 'px-8 py-4 text-white text-right',
                    cellClassName: 'px-8 py-6 text-right',
                    sortValue: r => r.unitValue,
                    render: r => <span className="font-bold text-slate-600">{r.unitValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span>
                  },
                  {
                    key: 'totalVal',
                    label: t('inventory.labels.totalValue'),
                    headerClassName: 'px-8 py-4 text-white text-right',
                    cellClassName: 'px-8 py-6 text-right',
                    sortValue: r => r.totalValue,
                    render: r => <span className="font-black text-slate-900 font-mono">{r.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {isAr ? 'ج.م.' : 'L.E.'}</span>
                  },
                  {
                    key: 'cardAction',
                    label: t('inventory.actions.stockCard'),
                    headerClassName: 'px-6 py-4 text-white text-center',
                    cellClassName: 'px-6 py-6 text-center',
                    sortable: false,
                    render: r => (
                      <button
                        onClick={(e) => { e.stopPropagation(); openTotalStockCard(r); }}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 mx-auto"
                      >
                        <i className="fa-solid fa-id-card"></i>
                        <span>{t('inventory.actions.card')}</span>
                      </button>
                    )
                  }
                ]}
              />
            )
          )}
        </div>
      )}

      {activeTab === 'reception' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-50/50">
            <div>
              <h3 className="text-xl font-black text-slate-800">{t('inventory.reception.title')}</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">{t('inventory.reception.subtitle')}</p>
            </div>
            <div className="flex flex-1 max-w-xl items-center gap-3 w-full md:w-auto">
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder={t('inventory.search.receptionPlaceholder')}
                  className={`w-full px-5 py-2.5 ${isAr ? 'pr-11 pl-10' : 'pl-11 pr-10'} bg-white border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 transition-all font-bold text-sm`}
                  value={receptionSearchQuery}
                  onChange={e => setReceptionSearchQuery(e.target.value)}
                />
                <i className={`fa-solid fa-magnifying-glass absolute ${isAr ? 'right-4' : 'left-4'} top-1/2 -translate-y-1/2 text-slate-400 text-sm`}></i>
                {receptionSearchQuery && (
                  <button
                    onClick={() => setReceptionSearchQuery('')}
                    className={`absolute ${isAr ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs p-1`}
                    title={t('inventory.search.clear')}
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                )}
              </div>
              <select
                value={selectedSupplierId}
                onChange={e => setSelectedSupplierId(e.target.value)}
                className="px-4 py-2.5 bg-white border border-slate-200 rounded-2xl text-[10px] font-black uppercase tracking-widest outline-none focus:ring-4 focus:ring-blue-50 whitespace-nowrap"
              >
                <option value="all">{t('inventory.reception.globalVendors')}</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <SortableTable
            storageKey="inv-reception"
            theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
            data={filteredTransitComponents}
            rowKey={(r) => r.comp.id || `${r.order.id}-${r.item.id}-${r.comp.description}`}
            rowClassName={(r) => `hover:bg-slate-50 transition-colors ${r.order.status === OrderStatus.IN_HOLD ? 'opacity-50 grayscale' : ''}`}
            emptyMessage={receptionSearchQuery ? t('inventory.reception.emptySearch') : t('inventory.reception.emptyNoSearch')}
            columns={[
              {
                key: 'poNumber',
                label: t('inventory.labels.poNumber'),
                headerClassName: 'px-8 py-4 text-white',
                sortValue: r => r.comp.poNumber || r.order.customerReferenceNumber || r.order.internalOrderNumber || '',
                render: r => {
                  const displayPo = r.comp.poNumber || r.order.customerReferenceNumber || 'N/A';
                  return (
                    <>
                      <div className="font-mono text-xs font-black text-blue-600">
                        {displayPo !== 'N/A' ? `#${displayPo}` : 'N/A'}
                      </div>
                      {r.order.customerReferenceNumber && r.comp.poNumber && (
                        <div className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">
                          {t('inventory.labels.custPo')}: {r.order.customerReferenceNumber}
                        </div>
                      )}
                      <div className="text-[9px] font-mono font-bold text-slate-400 mt-0.5">
                        {t('inventory.labels.ref')}: {r.order.internalOrderNumber}
                      </div>
                    </>
                  );
                }
              },
              {
                key: 'orderType',
                label: t('inventory.labels.orderType'),
                headerClassName: 'px-8 py-4 text-white text-center',
                cellClassName: 'px-8 py-6 text-center',
                sortValue: r => getOrderPoType(r.order, r.item, r.comp),
                render: r => {
                  const poType = getOrderPoType(r.order, r.item, r.comp);
                  const cfg = getPoTypeConfig(poType);
                  return (
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 ${cfg.badgeClass} border rounded-lg text-[10px] font-black uppercase tracking-wider whitespace-nowrap shadow-sm`}>
                      <i className={`fa-solid ${cfg.icon} text-[9px]`}></i>
                      {isAr ? cfg.arLabel : cfg.label}
                    </span>
                  );
                }
              },
              {
                key: 'vendor',
                label: t('inventory.labels.vendor'),
                headerClassName: 'px-8 py-4 text-white',
                sortValue: r => suppliers.find(s => s.id === r.comp.supplierId)?.name || r.comp.supplierName || '',
                render: r => {
                  const supplierName = suppliers.find(s => s.id === r.comp.supplierId)?.name || r.comp.supplierName || 'N/A';
                  const isStock = isStockOrder(r.order) || r.comp.status === 'ORDERED_FOR_STOCK' || r.comp.source === 'STOCK';
                  return (
                    <>
                      <div className="font-black text-slate-800 text-xs">{supplierName}</div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase mt-1">
                        {isStock ? t('inventory.labels.internalStock') : (r.order.customerName || 'N/A')}
                      </div>
                    </>
                  );
                }
              },
              {
                key: 'component',
                label: t('inventory.labels.componentDescriptor'),
                headerClassName: 'px-8 py-4 text-white',
                sortValue: r => r.comp.description,
                render: r => (
                  <>
                    <div className="font-bold text-slate-700 text-xs">{r.comp.description}</div>
                    {(r.comp.componentNumber || r.comp.supplierPartNumber) && (
                      <div className="text-[9px] font-mono text-slate-400 mt-0.5">
                        {t('inventory.labels.part')}: {r.comp.componentNumber || r.comp.supplierPartNumber}
                      </div>
                    )}
                  </>
                )
              },
              {
                key: 'expectedQty',
                label: t('inventory.labels.expectedQty'),
                headerClassName: 'px-8 py-4 text-white text-center',
                cellClassName: 'px-8 py-6 text-center',
                sortValue: r => r.comp.quantity,
                render: r => (
                  <>
                    <span className="font-black text-slate-900 text-xs">
                      {r.comp.quantity} <span className="text-slate-400 font-bold">{r.comp.unit}</span>
                    </span>
                    {(r.comp.receivedQty || 0) > 0 && (
                      <div className="text-[9px] font-bold text-emerald-600 mt-0.5">
                        {isAr ? 'المستلم:' : 'Rcvd:'} {r.comp.receivedQty} {r.comp.unit}
                      </div>
                    )}
                  </>
                )
              },
              {
                key: 'action',
                label: t('inventory.labels.action'),
                headerClassName: 'px-8 py-4 text-white text-right',
                cellClassName: 'px-8 py-6 text-right',
                sortable: false,
                render: r => (
                  <button
                    onClick={() => {
                      setPendingConfirm({ type: 'material', order: r.order, item: r.item, comp: r.comp });
                      setReceivedQtyInput('');
                    }}
                    className="px-6 py-3 bg-emerald-600 text-white font-black text-[10px] uppercase rounded-xl shadow-lg hover:bg-emerald-700 transition-all whitespace-nowrap"
                  >
                    {t('inventory.actions.processReception')}
                  </button>
                )
              },
            ]}
          />
        </div>
      )}

      {activeTab === 'hub' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">{t('inventory.hub.title')}</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">{t('inventory.hub.subtitle')}</p>
              </div>
              <div className="px-4 py-2 bg-amber-50 text-amber-600 border border-amber-100 rounded-xl text-[10px] font-black uppercase tracking-tighter">
                {isAr ? `${finishedGoodsAwaitingHub.length} طلبات منتهية في المصنع` : `${finishedGoodsAwaitingHub.length} Orders Finished in Factory`}
              </div>
            </div>
            <SortableTable<HubIntakeRow>
              storageKey="inv-hub-intake"
              theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
              rowClassName="hover:bg-amber-50/30 transition-colors"
              data={hubIntakeRows}
              rowKey={(r) => `${r.order.id}-${r.item.id}`}
              emptyMessage={t('inventory.hub.empty')}
              columns={[
                {
                  key: 'refCustomer',
                  label: isAr ? 'المرجع / العميل' : 'Reference / Customer',
                  headerClassName: 'px-8 py-4 text-white',
                  sortValue: r => r.order.internalOrderNumber,
                  render: r => {
                    const poType = getOrderPoType(r.order, r.item);
                    const cfg = getPoTypeConfig(poType);
                    return (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-black text-blue-600">{r.order.internalOrderNumber}</span>
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${cfg.badgeClass} border text-[8px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap`} title={isAr ? cfg.arLabel : cfg.label}>
                            <i className={`fa-solid ${cfg.icon} text-[8px]`}></i> {isAr ? cfg.arShortLabel : cfg.shortLabel}
                          </span>
                        </div>
                        <div className="font-bold text-slate-800 text-sm mt-0.5">{r.order.customerName}</div>
                        <div className="text-[9px] font-bold text-slate-400 mt-1">{r.order.status === OrderStatus.MANUFACTURING_COMPLETED ? (isAr ? 'اكتمل التصنيع' : 'MFG Complete') : (isAr ? 'قيد الإنتاج' : 'In Production')}</div>
                      </>
                    );
                  }
                },
                { key: 'lineItem', label: isAr ? 'بند الطلب' : 'Line Item', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.item.description, render: r => (<><div className="font-bold text-slate-700 text-xs">{r.item.description}</div><div className="text-[9px] text-slate-400 mt-0.5">{isAr ? 'الهدف:' : 'Target:'} {getItemEffectiveQty(r.item)} {r.item.unit}</div></>) },
                { key: 'manufactured', label: isAr ? 'المصنّع' : 'Manufactured', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.mfd, render: r => (<><div className="font-black text-blue-600 text-sm">{r.mfd.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'inHub', label: isAr ? 'في المركز' : 'In Hub', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.hub, render: r => (<><div className="font-black text-emerald-600 text-sm">{r.hub.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'readyIntake', label: isAr ? 'جاهز للاستلام' : 'Ready for Intake', headerClassName: 'px-8 py-4 text-white text-center', cellClassName: 'px-8 py-6 text-center', sortValue: r => r.readyForIntake, render: r => (<><div className="font-black text-amber-600 text-sm">{r.readyForIntake.toLocaleString()}</div><div className="text-[9px] text-slate-400">{r.item.unit}</div></>) },
                { key: 'sla', label: isAr ? 'اتفاقية مستوى الخدمة' : 'SLA', headerClassName: 'px-8 py-4 text-white', sortable: false, render: r => <ThresholdTimer order={r.order} limitHrs={config.settings.transitToHubLimitHrs} /> },
                {
                  key: 'action', label: t('inventory.labels.action'), headerClassName: `px-8 py-4 text-white ${isAr ? 'text-left' : 'text-right'}`, cellClassName: `px-8 py-6 ${isAr ? 'text-left' : 'text-right'}`, sortable: false, render: r => (
                    <button
                      disabled={processingId === r.order.id}
                      onClick={() => {
                        if (r.isFallback) {
                          executeHubReception(r.order.id);
                        } else {
                          const initialInputs: Record<string, string> = {};
                          r.order.items.forEach(i => {
                            const max = (i.manufacturedQty || 0) - (i.hubReceivedQty || 0);
                            if (max > 0) initialInputs[i.id] = String(max);
                          });
                          setHubInputs(initialInputs);
                          setPendingConfirm({ type: 'hub', order: r.order });
                        }
                      }}
                      className={`px-5 py-2.5 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 ${isAr ? 'mr-auto' : 'ml-auto'} shadow-lg shadow-blue-100`}
                    >
                      {processingId === r.order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-warehouse"></i>}
                      {r.isFallback ? (isAr ? 'استلام الكل' : 'Intake All') : (isAr ? 'تأكيد استلام المركز' : 'Confirm Hub Intake')}
                    </button>
                  )
                },
              ]}
            />
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-80">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">{isAr ? 'الأصول المجهزة (في انتظار الفوترة)' : 'Staged Assets (Awaiting Invoicing)'}</h3>
            </div>
            <SortableTable<CustomerOrder>
              storageKey="inv-staged-assets"
              data={goodsInHubReadyForInvoice}
              rowKey={(r) => r.id}
              emptyMessage={isAr ? 'مستودع المركز فارغ حالياً.' : 'Hub storage currently empty.'}
              columns={[
                { key: 'ref', label: t('inventory.labels.ref'), sortValue: r => r.internalOrderNumber, cellClassName: 'px-8 py-4', render: r => <span className="font-mono text-[10px] font-black text-slate-400">{r.internalOrderNumber}</span> },
                { key: 'customer', label: isAr ? 'العميل' : 'Customer', sortValue: r => r.customerName, cellClassName: 'px-8 py-4', render: r => <span className="font-bold text-slate-500 text-xs">{r.customerName}</span> },
                { key: 'status', label: isAr ? 'الحالة' : 'Status', cellClassName: `px-8 py-4 ${isAr ? 'text-left' : 'text-right'}`, sortable: false, render: () => <span className="px-3 py-1 bg-slate-100 text-slate-400 text-[8px] font-black uppercase rounded border">{isAr ? 'جاهز للمالية' : 'Ready for Finance'}</span> },
              ]}
            />
          </div>
        </div>
      )}

      {activeTab === 'dispatch' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">{isAr ? 'الشحن النهائي واللوجستيات' : 'Final Dispatch & Logistics'}</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">{isAr ? 'الطلبات المفوترة الجاهزة لتفويض التسليم' : 'Invoiced Orders Ready for Delivery Authorization'}</p>
              </div>
              <div className="px-4 py-2 bg-sky-50 text-sky-600 border border-sky-100 rounded-xl text-[10px] font-black uppercase tracking-tighter animate-pulse">
                {isAr ? `${invoicedAwaitingDispatch.length} في انتظار الإرسال` : `${invoicedAwaitingDispatch.length} Awaiting Dispatch`}
              </div>
            </div>
            <SortableTable<CustomerOrder>
              storageKey="inv-dispatch"
              theadClassName="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest"
              rowClassName="hover:bg-sky-50/40 transition-colors group"
              data={invoicedAwaitingDispatch}
              rowKey={(r) => r.id}
              emptyMessage={isAr ? 'خط اللوجستيات خالٍ' : 'Logistics Pipeline Clear'}
              columns={[
                { key: 'tracking', label: isAr ? 'سياق التتبع' : 'Tracking Context', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.customerName, render: r => (<><div className="font-black text-slate-800 text-sm">{r.customerName}</div><div className="font-mono text-[10px] text-blue-600 font-bold uppercase mt-1 tracking-widest">{r.internalOrderNumber}</div></>) },
                { key: 'invoice', label: isAr ? 'بيانات الفاتورة' : 'Invoice Identification', headerClassName: 'px-8 py-4 text-white', sortValue: r => r.invoiceNumber || '', render: r => (<div className="inline-flex flex-col gap-1.5"><span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-[9px] font-black uppercase rounded border border-emerald-100 flex items-center gap-2"><i className="fa-solid fa-file-invoice-dollar"></i>{isAr ? 'فاتورة ضريبية:' : 'Tax Invoice:'} {r.invoiceNumber}</span><div className="text-[8px] font-black text-rose-500 uppercase flex items-center gap-1.5 animate-pulse"><i className="fa-solid fa-triangle-exclamation"></i>{isAr ? 'إرسال البضائع مع الفاتورة المادية' : 'Dispatch goods with physical invoice'}</div></div>) },
                {
                  key: 'readyItems', label: isAr ? 'الأصول القابلة للإرسال' : 'Dispatchable Assets', headerClassName: 'px-8 py-4 text-white', sortable: false, render: r => {
                    const readyItems = r.items.filter(i => {
                      const inHub = (i.hubReceivedQty || 0) - (i.dispatchedQty || 0);
                      const approved = (i.approvedForDispatchQty || 0) - (i.dispatchedQty || 0);
                      return Math.min(inHub, approved) > 0;
                    });
                    if (readyItems.length === 0) return <span className="text-[10px] font-bold text-slate-300 italic">{isAr ? 'لا توجد بنود معتمدة للإفراج' : 'No items cleared for release'}</span>;
                    return (
                      <div className="space-y-1">
                        {readyItems.map(i => {
                          const inHub = (i.hubReceivedQty || 0) - (i.dispatchedQty || 0);
                          const approved = (i.approvedForDispatchQty || 0) - (i.dispatchedQty || 0);
                          const max = Math.max(0, Math.min(inHub, approved));
                          return (
                            <div key={i.id} className="flex items-center justify-between gap-3 bg-white/50 p-1.5 rounded-lg border border-slate-100/50">
                              <span className="text-[10px] font-bold text-slate-600 truncate max-w-[120px]">{i.description}</span>
                              <span className="px-2 py-0.5 bg-sky-100 text-sky-700 text-[9px] font-black rounded-full whitespace-nowrap">{max} {i.unit}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                },
                { key: 'dispatchSla', label: isAr ? 'اتفاقية مستوى خدمة الإرسال' : 'Dispatch SLA', headerClassName: 'px-8 py-4 text-white', sortable: false, render: r => <ThresholdTimer order={r} limitHrs={config.settings.hubReleasedLimitHrs} /> },
                {
                  key: 'action', label: isAr ? 'تفويض الإجراء' : 'Action Authorization', headerClassName: `px-8 py-4 text-white ${isAr ? 'text-left' : 'text-right'}`, cellClassName: `px-8 py-6 ${isAr ? 'text-left' : 'text-right'}`, sortable: false, render: r => (
                    <div className={`flex flex-col ${isAr ? 'items-start' : 'items-end'} gap-2`}>
                      <button disabled={processingId === r.id} onClick={() => { setPendingDispatch(r); setDispatchInputs({}); }} className="px-6 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl hover:bg-black transition-all flex items-center gap-2 shadow-lg shadow-slate-200">
                        {processingId === r.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-truck-ramp-box"></i>}
                        {isAr ? 'تهيئة الإرسال' : 'Configure Dispatch'}
                      </button>
                      <p className={`text-[8px] text-slate-400 font-bold uppercase ${isAr ? 'pl-1' : 'pr-1'} italic opacity-0 group-hover:opacity-100 transition-opacity`}>{isAr ? 'إرفاق الفاتورة الضريبية المادية بالبيان' : 'Attach physical Tax Invoice to manifest'}</p>
                    </div>
                  )
                },
              ]}
            />
          </div>

          {recentDispatches.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-60">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">{isAr ? 'الإرسالات اللوجستية الأخيرة' : 'Recent Logistics Departures'}</h3>
              </div>
              <SortableTable<CustomerOrder>
                storageKey="inv-recent-dispatches"
                theadClassName="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b"
                data={recentDispatches}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'ref', label: t('inventory.labels.ref'), sortValue: r => r.internalOrderNumber, cellClassName: 'px-8 py-4', render: r => <span className="font-mono text-[10px] text-slate-400">{r.internalOrderNumber}</span> },
                  { key: 'customer', label: isAr ? 'العميل' : 'Customer', sortValue: r => r.customerName, cellClassName: 'px-8 py-4', render: r => <span className="font-bold text-slate-500 text-xs">{r.customerName}</span> },
                  {
                    key: 'actions', label: t('inventory.labels.action'), cellClassName: `px-8 py-4 ${isAr ? 'text-left' : 'text-right'}`, sortable: false, render: r => (
                      <div className={`flex items-center ${isAr ? 'justify-start' : 'justify-end'} gap-2`}>
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">{isAr ? 'تم التسليم للوجستيات' : 'Handed to Logistics'}</span>
                      </div>
                    )
                  },
                ]}
              />
            </div>
          )}
        </div>
      )}

      {pendingConfirm && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div dir={isAr ? 'rtl' : 'ltr'} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 animate-in zoom-in-95">
            {pendingConfirm.type === 'material' && (
              <>
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-truck-ramp-box"></i></div>
                  <div><h3 className="text-xl font-black text-slate-800">{isAr ? 'بوابة التحقق' : 'Verification Gate'}</h3><p className="text-[10px] font-black text-slate-400 uppercase">{isAr ? 'أدخل الكمية المستلمة الفعلية بدقة' : 'Input exact received quantity'}</p></div>
                </div>
                <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 mb-8 space-y-6">
                  <div className="flex items-center justify-between gap-3 p-3.5 bg-white rounded-2xl border border-slate-200/80 shadow-sm">
                    <div>
                      <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.poNumber')}</div>
                      <div className="font-mono text-xs font-black text-blue-600">
                        {pendingConfirm.comp?.poNumber ? `#${pendingConfirm.comp.poNumber}` : (pendingConfirm.order.customerReferenceNumber ? `#${pendingConfirm.order.customerReferenceNumber}` : 'N/A')}
                      </div>
                      {pendingConfirm.order.internalOrderNumber && (
                        <div className="text-[8px] font-mono text-slate-400 mt-0.5">{isAr ? 'مرجع: ' : 'Ref: '}{pendingConfirm.order.internalOrderNumber}</div>
                      )}
                    </div>
                    <div className={isAr ? 'text-left' : 'text-right'}>
                      <div className="text-[8px] font-black uppercase text-slate-400">{t('inventory.labels.orderType')}</div>
                      {(() => {
                        const poType = getOrderPoType(pendingConfirm.order, pendingConfirm.item, pendingConfirm.comp);
                        const cfg = getPoTypeConfig(poType);
                        return (
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 ${cfg.badgeClass} border rounded-lg text-[9px] font-black uppercase tracking-wider`} title={isAr ? cfg.arLabel : cfg.label}>
                            <i className={`fa-solid ${cfg.icon} text-[8px]`}></i>
                            {isAr ? cfg.arShortLabel : cfg.label}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-black text-slate-400 uppercase mb-2 text-center">{isAr ? 'حالة الاستلام' : 'Receipt Status'}</div>
                    <div className="flex justify-center items-center gap-8">
                      <div>
                        <div className="text-[8px] font-black text-slate-400 uppercase">{isAr ? 'المطلوب' : 'Ordered'}</div>
                        <div className="text-xl font-black text-slate-800">{pendingConfirm.comp?.quantity}</div>
                      </div>
                      <div className="h-8 w-px bg-slate-200"></div>
                      <div>
                        <div className="text-[8px] font-black text-emerald-500 uppercase">{t('inventory.labels.received')}</div>
                        <div className="text-xl font-black text-emerald-600">{pendingConfirm.comp?.receivedQty || 0}</div>
                      </div>
                      <div className="h-8 w-px bg-slate-200"></div>
                      <div>
                        <div className="text-[8px] font-black text-amber-500 uppercase">{isAr ? 'المتبقي' : 'Left'}</div>
                        <div className="text-xl font-black text-amber-600">{(pendingConfirm.comp?.quantity || 0) - (pendingConfirm.comp?.receivedQty || 0)}</div>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className={`text-[9px] font-black text-blue-600 uppercase ${isAr ? 'mr-1' : 'ml-1'}`}>{isAr ? 'إدخال العدد الفعلي' : 'Physical Count Input'}</label>
                    <input
                      type="number" step="any" autoFocus
                      className="w-full p-4 border-2 border-white bg-white rounded-2xl text-center text-2xl font-black focus:border-blue-500 outline-none shadow-sm"
                      placeholder="0.00" value={receivedQtyInput} onChange={e => setReceivedQtyInput(e.target.value)}
                    />
                    {receivedQtyInput && parseFloat(receivedQtyInput) > ((pendingConfirm.comp?.quantity || 0) - (pendingConfirm.comp?.receivedQty || 0)) && (
                      <div className="text-[9px] font-black text-rose-500 uppercase mt-2 text-center flex items-center justify-center gap-2 animate-pulse"><i className="fa-solid fa-triangle-exclamation"></i> {isAr ? 'يتجاوز الكمية المطلوبة' : 'Exceeds Ordered Quantity'}</div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPendingConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">{t('common.cancel')}</button>
                  <button
                    onClick={executeMaterialReception} disabled={!isConfirmationAllowed}
                    className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all ${isConfirmationAllowed ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale'}`}
                  >{isAr ? 'تأكيد الاستلام' : 'Confirm Receipt'}</button>
                </div>
              </>
            )}
            {pendingConfirm.type === 'hub' && (
              <>
                <div className="flex items-center gap-4 mb-6">
                  <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-boxes-packing"></i></div>
                  <div><h3 className="text-xl font-black text-slate-800">{isAr ? 'التحقق من استلام المركز' : 'Hub Intake Validation'}</h3><p className="text-[10px] font-black text-slate-400 uppercase">{isAr ? 'تأكيد البنود المستلمة من المصنع' : 'Confirm items received from plant'}</p></div>
                </div>
                <div className={`max-h-[50vh] overflow-y-auto mb-8 ${isAr ? 'pl-2' : 'pr-2'} space-y-3 custom-scrollbar`}>
                  {pendingConfirm.order.items.map(item => {
                    const mfd = item.manufacturedQty || 0;
                    const hub = item.hubReceivedQty || 0;
                    const max = mfd - hub;
                    if (max <= 0) return null;

                    return (
                      <div key={item.id} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center gap-4">
                        <div className="flex-1">
                          <div className="font-bold text-slate-700 text-sm mb-1">{item.description}</div>
                          <div className="text-[9px] font-black uppercase text-amber-600">{isAr ? `قابل للاستلام: ${max} ${item.unit}` : `Receivable: ${max} ${item.unit}`}</div>
                        </div>
                        <div className="w-24">
                          <input
                            type="number"
                            min={0}
                            max={max}
                            value={hubInputs[item.id] !== undefined ? hubInputs[item.id] : ''}
                            onChange={e => {
                              const val = parseFloat(e.target.value);
                              if (e.target.value === '' || isNaN(val)) {
                                setHubInputs(p => ({ ...p, [item.id]: e.target.value }));
                              } else {
                                const clamped = Math.min(val, max);
                                setHubInputs(p => ({ ...p, [item.id]: String(clamped) }));
                              }
                            }}
                            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-black text-center focus:border-amber-500 outline-none"
                            placeholder="0"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPendingConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">{t('common.cancel')}</button>
                  <button
                    onClick={executePartialHubReception}
                    className="flex-[2] py-4 bg-amber-500 text-white rounded-2xl font-black text-[10px] uppercase shadow-xl hover:bg-amber-600 transition-all"
                  >{isAr ? 'تأكيد الاستلام' : 'Confirm Intake'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Dispatch Configuration Modal */}
      {pendingDispatch && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div dir={isAr ? 'rtl' : 'ltr'} className="bg-white rounded-[2rem] shadow-2xl w-full max-w-xl p-8 animate-in zoom-in-95 border-2 border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-2 bg-sky-500"></div>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-sky-50 text-sky-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-truck-ramp-box"></i></div>
              <div>
                <h3 className="text-xl font-black text-slate-800 tracking-tight uppercase">{isAr ? 'تهيئة الإرسال' : 'Configure Dispatch'}</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{pendingDispatch.internalOrderNumber}</p>
              </div>
            </div>

            <div className={`max-h-[50vh] overflow-y-auto mb-8 ${isAr ? 'pl-2' : 'pr-2'} space-y-3 custom-scrollbar`}>
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-rose-800 text-xs font-bold flex gap-2 items-start">
                <i className="fa-solid fa-circle-info mt-0.5"></i>
                <div>{isAr ? 'الكميات مقيدة بدقة بإيصالات تفويض المالية والتوافر الفعلي في المركز.' : 'Quantities are strictly limited by Finance Authorization Receipts and actual Hub Physical Availability.'}</div>
              </div>
              {pendingDispatch.items.map(item => {
                const inHub = (item.hubReceivedQty || 0) - (item.dispatchedQty || 0);
                const approved = (item.approvedForDispatchQty || 0) - (item.dispatchedQty || 0);
                const max = Math.max(0, Math.min(inHub, approved));

                if (max <= 0 && ((item.dispatchedQty || 0) >= getItemEffectiveQty(item))) return null;

                return (
                  <div key={item.id} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex items-center gap-4">
                    <div className="flex-1">
                      <div className="font-bold text-slate-700 text-sm mb-1">{item.description}</div>
                      <div className="flex gap-4">
                        <div className="text-[9px] font-black uppercase text-slate-500">{isAr ? 'متاح بالمركز: ' : 'Hub Avail: '}<span className="text-sky-600">{inHub}</span></div>
                        <div className="text-[9px] font-black uppercase text-slate-500">{isAr ? 'تفويض المالية: ' : 'Finance Auth: '}<span className={approved > 0 ? 'text-emerald-600' : 'text-rose-600'}>{approved}</span></div>
                      </div>
                    </div>
                    <div className="w-24">
                      <input
                        type="number"
                        min={0}
                        max={max}
                        value={dispatchInputs[item.id] !== undefined ? dispatchInputs[item.id] : ''}
                        onChange={e => {
                          const val = parseFloat(e.target.value);
                          if (e.target.value === '' || isNaN(val)) {
                            setDispatchInputs(p => ({ ...p, [item.id]: e.target.value }));
                          } else {
                            setDispatchInputs(p => ({ ...p, [item.id]: e.target.value }));
                          }
                        }}
                        disabled={max <= 0}
                        className={`w-full px-3 py-2 bg-white border rounded-xl text-sm font-black text-center focus:border-sky-500 outline-none disabled:bg-slate-100 disabled:opacity-50 transition-colors ${parseFloat(dispatchInputs[item.id]) > max ? 'border-rose-500 text-rose-600 bg-rose-50 animate-pulse' : 'border-slate-200 text-slate-700'}`}
                        placeholder="0"
                      />
                      {parseFloat(dispatchInputs[item.id]) > max && (
                        <div className="text-[7px] font-black text-rose-500 uppercase mt-1 text-center leading-none">{isAr ? 'تجاوز الحد' : 'Limit Exceeded'}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setPendingDispatch(null); setDispatchInputs({}); }} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">{t('common.cancel')}</button>
              <button
                onClick={executeDispatchRelease}
                disabled={processingId === pendingDispatch.id || Object.entries(dispatchInputs).some(([id, val]) => {
                  const item = pendingDispatch.items.find(i => i.id === id);
                  if (!item) return false;
                  const inHub = (item.hubReceivedQty || 0) - (item.dispatchedQty || 0);
                  const approved = (item.approvedForDispatchQty || 0) - (item.dispatchedQty || 0);
                  const max = Math.max(0, Math.min(inHub, approved));
                  return parseFloat(val) > max;
                })}
                className="flex-[2] py-4 bg-sky-500 text-white rounded-2xl font-black text-[10px] uppercase shadow-xl hover:bg-sky-600 transition-all disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed"
              >
                {processingId === pendingDispatch.id ? <i className={`fa-solid fa-spinner fa-spin ${isAr ? 'ml-2' : 'mr-2'}`}></i> : null}
                {isAr ? 'اعتماد وإرسال المحدد' : 'Finalize & Dispatch Selected'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div dir={isAr ? 'rtl' : 'ltr'} className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-8 animate-in zoom-in-95 border-2 border-slate-100 relative">
            <div className="flex items-center justify-between pb-6 border-b border-slate-100 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg shadow-inner">
                  <i className="fa-solid fa-box-open"></i>
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-800">{t('inventory.addItemForm.title')}</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{isAr ? 'إضافة صنف جديد للمخزون' : 'Register new stock catalog entry'}</p>
                </div>
              </div>
              <button
                onClick={() => setIsAdding(false)}
                className="w-9 h-9 rounded-xl bg-slate-100 text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-all flex items-center justify-center text-sm"
                title={t('common.close')}
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.sku')}</label>
                <input
                  type="text"
                  required
                  value={newItem.sku}
                  onChange={e => setNewItem({ ...newItem, sku: e.target.value })}
                  placeholder={t('inventory.addItemForm.skuPlaceholder')}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.description')}</label>
                <input
                  type="text"
                  required
                  value={newItem.description}
                  onChange={e => setNewItem({ ...newItem, description: e.target.value })}
                  placeholder={t('inventory.addItemForm.descriptionPlaceholder')}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.quantity')}</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={newItem.quantityInStock}
                    onChange={e => setNewItem({ ...newItem, quantityInStock: parseFloat(e.target.value) || 0 })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.unit')}</label>
                  <input
                    type="text"
                    required
                    value={newItem.unit}
                    onChange={e => setNewItem({ ...newItem, unit: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.lastCost')}</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={newItem.lastCost}
                    onChange={e => setNewItem({ ...newItem, lastCost: parseFloat(e.target.value) || 0 })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1.5">{t('inventory.addItemForm.category')}</label>
                  <select
                    value={newItem.category}
                    onChange={e => setNewItem({ ...newItem, category: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:bg-white focus:border-blue-500 outline-none transition-all"
                  >
                    <option value="Mechanical">{isAr ? 'ميكانيكي' : 'Mechanical'}</option>
                    <option value="Electrical">{isAr ? 'كهربائي' : 'Electrical'}</option>
                    <option value="Raw Material">{isAr ? 'مواد خام' : 'Raw Material'}</option>
                    <option value="Packaging">{isAr ? 'تغليف' : 'Packaging'}</option>
                    <option value="Finished Product">{isAr ? 'منتج نهائي' : 'Finished Product'}</option>
                    <option value="Other">{isAr ? 'أخرى' : 'Other'}</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="flex-1 py-3.5 bg-slate-100 text-slate-600 hover:bg-slate-200 font-black rounded-2xl text-[10px] uppercase transition-all"
                >
                  {t('inventory.addItemForm.cancel')}
                </button>
                <button
                  type="submit"
                  className="flex-[2] py-3.5 bg-blue-600 text-white hover:bg-blue-700 font-black rounded-2xl text-[10px] uppercase shadow-lg shadow-blue-200 transition-all"
                >
                  {t('inventory.addItemForm.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Item Stock Card Modal */}
      <ItemStockCardModal
        data={selectedStockCardItem}
        onClose={() => setSelectedStockCardItem(null)}
      />

    </div>
  );
};

export const InventoryModule: React.FC<InventoryModuleProps> = (props) => (
  <LanguageProvider pageId="inventory">
    <InventoryModuleInner {...props} />
  </LanguageProvider>
);
