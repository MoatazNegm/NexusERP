import React, { useState, useMemo, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, InventoryItem, ManufacturingComponent, OrderStatus, Supplier, SupplierPart, AppConfig, CompStatus, User, getItemEffectiveStatus } from '../types';
import { PartHistory } from './PartHistory';

interface TechnicalReviewModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const getCompLimit = (status: CompStatus, settings: any) => {
  switch (status) {
    case 'PENDING_OFFER': return settings.pendingOfferLimitHrs;
    case 'RFP_SENT': return settings.rfpSentLimitHrs;
    case 'AWARDED': return settings.issuePoLimitHrs;
    case 'ORDERED': return settings.orderedLimitHrs;
    default: return 0;
  }
};

const ThresholdDisplay: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = order.status === OrderStatus.LOGGED ? config.settings.orderEditTimeLimitHrs : config.settings.technicalReviewLimitHrs;
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, config.settings]);

  const limitHrs = order.status === OrderStatus.LOGGED ? config.settings.orderEditTimeLimitHrs : config.settings.technicalReviewLimitHrs;
  if (limitHrs === 0) return null;

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 ${isOver ? 'text-rose-500 animate-pulse' : 'text-emerald-500'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-stopwatch'}`}></i>
      {isOver ? `Over S.O.P limit by ${timeStr}` : `Targeted Finish: ${timeStr} remaining`}
    </div>
  );
};

export const TechnicalReviewModule: React.FC<TechnicalReviewModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null);
  const [selectedItem, setSelectedItem] = useState<CustomerOrderItem | null>(null);
  const [compSearch, setCompSearch] = useState('');
  const [partNumSearch, setPartNumSearch] = useState('');
  const [compQty, setCompQty] = useState(1);
  const [compDurationVal, setCompDurationVal] = useState<number | string>('');
  const [compDurationUnit, setCompDurationUnit] = useState<'Months' | 'Years'>('Months');
  const [compScope, setCompScope] = useState('');
  const [showCompSuggestions, setShowCompSuggestions] = useState(false);

  const [isProcessing, setIsProcessing] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'orderDate', direction: 'asc' });


  // Rollback state
  const [rollbackReason, setRollbackReason] = useState<string | null>(null);

  // Procurement resolution state (for ordered components during rollback)
  type CompResolution = 'CANCEL_PO' | 'RECEIVE_TO_STOCK';
  interface OrderedCompRecord {
    itemId: string;
    itemDesc: string;
    compId: string;
    compDesc: string;
    componentNumber?: string;
    supplierName?: string;
    quantity: number;
    status: string;
  }
  const [orderedComponents, setOrderedComponents] = useState<OrderedCompRecord[] | null>(null);
  const [componentResolutions, setComponentResolutions] = useState<Record<string, CompResolution>>({});
  
  // Edit component state
  const [editingComp, setEditingComp] = useState<ManufacturingComponent | null>(null);
  const [editQty, setEditQty] = useState<number | string>(1);
  const [editDesc, setEditDesc] = useState('');
  const [editComponentNumber, setEditComponentNumber] = useState('');
  const [editContractNumber, setEditContractNumber] = useState('');
  const [editContractStartDate, setEditContractStartDate] = useState('');
  const [editDurationVal, setEditDurationVal] = useState<number | string>('');
  const [editDurationUnit, setEditDurationUnit] = useState<'Months' | 'Years'>('Months');
  const [editScope, setEditScope] = useState('');

  // History state
  const [compHistory, setCompHistory] = useState<any[] | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'review' | 'history'>('review');

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async (keepSelection = true) => {
    const [o, i, s] = await Promise.all([
      dataService.getOrders(),
      dataService.getInventory(),
      dataService.getSuppliers()
    ]);
    setOrders(o);
    setInventory(i);
    setSuppliers(s);

    if (keepSelection && selectedOrder) {
      const updatedOrder = o.find(x => x.id === selectedOrder.id);
      if (updatedOrder) {
        setSelectedOrder(updatedOrder);
        if (selectedItem) {
          const updatedItem = updatedOrder.items.find(x => x.id === selectedItem.id);
          if (updatedItem) setSelectedItem(updatedItem);
        }
      }
    }
  };

  const queueOrders = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    let filtered = orders.filter(o => {
      const isReviewable = [OrderStatus.LOGGED, OrderStatus.TECHNICAL_REVIEW, OrderStatus.NEGATIVE_MARGIN].includes(o.status);
      if (!isReviewable) return false;

      if (!q) return true;
      const matchPO = (o.internalOrderNumber || '').toLowerCase().includes(q);
      const matchCustomer = (o.customerName || '').toLowerCase().includes(q);
      const matchRef = (o.customerReferenceNumber || '').toLowerCase().includes(q);
      const matchItems = o.items.some(it => (it.description || '').toLowerCase().includes(q));

      return matchPO || matchCustomer || matchRef || matchItems;
    });

    return filtered.sort((a, b) => {
      let aVal: any = '';
      let bVal: any = '';

      switch (sortConfig.key) {
        case 'id':
          aVal = a.internalOrderNumber || '';
          bVal = b.internalOrderNumber || '';
          break;
        case 'orderDate':
          aVal = a.orderDate || a.dataEntryTimestamp || '';
          bVal = b.orderDate || b.dataEntryTimestamp || '';
          break;
        case 'customer':
          aVal = a.customerName || '';
          bVal = b.customerName || '';
          break;
        case 'lineCount':
          aVal = a.items.length;
          bVal = b.items.length;
          break;
        default:
          aVal = a.orderDate || a.dataEntryTimestamp || '';
          bVal = b.orderDate || b.dataEntryTimestamp || '';
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [searchQuery, orders, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ column }: { column: string }) => {
    if (sortConfig.key !== column) return <i className="fa-solid fa-sort ml-2 opacity-20 group-hover:opacity-100 transition-opacity"></i>;
    return <i className={`fa-solid fa-sort-${sortConfig.direction === 'asc' ? 'up' : 'down'} ml-2 text-blue-600`}></i>;
  };


  const historyData = useMemo(() => {
    const history: Record<string, {
      description: string;
      componentNumber?: string;
      prices: { price: number; date: string; supplierId?: string; supplierName?: string }[];
      orders: { id: string; orderNo: string; orderDate: string; receivedDate?: string }[];
    }> = {};

    orders.forEach(o => {
      o.items.forEach(it => {
        it.components?.forEach(c => {
          const key = (c.description || '').toLowerCase().trim();
          if (!key) return;
          if (!history[key]) {
            history[key] = {
              description: c.description,
              componentNumber: c.componentNumber,
              prices: [],
              orders: []
            };
          }
          const supp = suppliers.find(s => s.id === c.supplierId);
          history[key].prices.push({
            price: c.unitCost,
            date: o.orderDate || o.dataEntryTimestamp || '',
            supplierId: c.supplierId,
            supplierName: supp?.name
          });
          history[key].orders.push({
            id: o.id,
            orderNo: o.internalOrderNumber || '',
            orderDate: o.orderDate || '',
            receivedDate: c.status === 'RECEIVED' ? c.statusUpdatedAt : undefined
          });
        });
      });
    });
    return history;
  }, [orders, suppliers]);

  const historyResults = useMemo(() => {
    if (selectedItem?.productionType === 'OUTSOURCING') return [];
    const descQuery = compSearch.toLowerCase().trim();
    const partQuery = partNumSearch.toLowerCase().trim();
    if (!descQuery && !partQuery) return [];

    return Object.values(historyData).filter(h => {
      const descMatch = descQuery ? h.description.toLowerCase().includes(descQuery) : true;
      const partMatch = partQuery ? (h.componentNumber || '').toLowerCase().includes(partQuery) : true;
      return descMatch && partMatch;
    });
  }, [compSearch, partNumSearch, historyData]);

  const generateContractNumber = (item?: CustomerOrderItem, comp?: ManufacturingComponent, hint?: string) => {
    if (hint && hint.trim()) return hint.trim();
    const rawBase = comp?.componentNumber || item?.id || 'OUTSRC';
    const base = rawBase.slice(-6).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'OUTSRC';
    const timeCode = `${Date.now() % 100000}`.padStart(5, '0');
    const randomCode = Math.floor(Math.random() * 900) + 100;
    return `CTR-${base}-${timeCode}-${randomCode}`;
  };

  const invResults = useMemo(() => {
    if (selectedItem?.productionType === 'OUTSOURCING') return [];
    const descQuery = compSearch.toLowerCase();
    const partQuery = partNumSearch.toLowerCase();
    if (!descQuery && !partQuery) return [];
    return inventory.filter(i => {
      const descMatch = descQuery ? (i.description || '').toLowerCase().includes(descQuery) : true;
      const partMatch = partQuery ? (i.sku || '').toLowerCase().includes(partQuery) : true;
      return descMatch && partMatch;
    });
  }, [compSearch, partNumSearch, inventory]);

  const supplierResults = useMemo(() => {
    if (selectedItem?.productionType === 'OUTSOURCING') return [];
    const descQuery = compSearch.toLowerCase();
    const partQuery = partNumSearch.toLowerCase();
    if (!descQuery && !partQuery) return [];

    const results: { supplier: Supplier, part: SupplierPart }[] = [];
    suppliers.forEach(supp => {
      supp.priceList.forEach(part => {
        const descMatch = descQuery ? (part.description || '').toLowerCase().includes(descQuery) : true;
        const partMatch = partQuery ? (part.partNumber || '').toLowerCase().includes(partQuery) : true;
        if (descMatch && partMatch) {
          results.push({ supplier: supp, part });
        }
      });
    });
    return results;
  }, [compSearch, partNumSearch, suppliers]);

  const openHistory = async (name: string, sku?: string) => {
    setIsHistoryLoading(true);
    try {
      const history = await dataService.getComponentHistory(name, sku);
      setCompHistory(history);
    } catch (e) {
      alert("Failed to load history.");
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const handleAddComponent = async (inv: InventoryItem) => {
    if (!selectedOrder || !selectedItem) return;
    const available = inv.quantityInStock - (inv.quantityReserved || 0);

    try {
      if (compQty <= available) {
        // Full stock availability
        const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
          description: inv.description,
          quantity: compQty,
          unit: inv.unit,
          unitCost: inv.lastCost,
          taxPercent: 14,
          source: 'STOCK',
          inventoryItemId: inv.id,
          status: 'RESERVED'
        });
        setSelectedOrder(updated);
        setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
      } else {
        // Partial stock or Out of stock
        let currentOrder = selectedOrder;

        // 1. Reserve what's available
        if (available > 0) {
          currentOrder = await dataService.addComponentToItem(currentOrder.id, selectedItem.id, {
            description: inv.description,
            quantity: available,
            unit: inv.unit,
            unitCost: inv.lastCost,
            taxPercent: 14,
            source: 'STOCK',
            inventoryItemId: inv.id,
            status: 'RESERVED'
          });
        }

        // 2. Procure the rest
        const remainder = compQty - (available > 0 ? available : 0);
        const finalDuration = compDurationVal ? `${compDurationVal} ${compDurationUnit}` : '';
        const finalOrder = await dataService.addComponentToItem(currentOrder.id, selectedItem.id, {
          description: inv.description,
          quantity: remainder,
          unit: inv.unit,
          unitCost: inv.lastCost,
          taxPercent: 14,
          source: 'PROCUREMENT',
          status: 'PENDING_OFFER',
          contractNumber: selectedItem.productionType === 'OUTSOURCING' ? generateContractNumber(selectedItem, undefined, partNumSearch.trim()) : undefined,
          contractDuration: finalDuration,
          scopeOfWork: compScope || inv.description
        });

        setSelectedOrder(finalOrder);
        setSelectedItem(finalOrder.items.find(i => i.id === selectedItem.id)!);
      }

      setCompSearch('');
      setPartNumSearch('');
      setCompDurationVal('');
      setCompDurationUnit('Months');
      setCompScope('');
      setShowCompSuggestions(false);
      fetchData();
    } catch (e: any) {
      alert(e.message || 'Failed to add component');
    }
  };


  const handleAddSupplierPart = async (supp: Supplier, part: SupplierPart) => {
    if (!selectedOrder || !selectedItem) return;
    const finalDuration = compDurationVal ? `${compDurationVal} ${compDurationUnit}` : '';
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: part.description,
      quantity: compQty,
      unit: 'pcs',
      unitCost: part.price,
      taxPercent: 14,
      source: 'PROCUREMENT',
      supplierId: supp.id,
      supplierPartId: part.id,
      supplierPartNumber: part.partNumber,
      contractNumber: selectedItem.productionType === 'OUTSOURCING' ? generateContractNumber(selectedItem, undefined, part.partNumber) : undefined,
      contractDuration: finalDuration,
      scopeOfWork: compScope || part.description,
      status: 'PENDING_OFFER'
    });
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setCompSearch('');
    setPartNumSearch('');
    setCompDurationVal('');
    setCompDurationUnit('Months');
    setCompScope('');
    setShowCompSuggestions(false);
    fetchData();
  };


  const handleAddCustomProcurement = async () => {
    if (!selectedOrder || !selectedItem || (!compSearch.trim() && !partNumSearch.trim())) return;
    
    // Validation: Unique contract ID check for Outsourcing
    if (selectedItem.productionType === 'OUTSOURCING' && partNumSearch.trim()) {
      const isDuplicate = orders.some(o => 
        o.items?.some(it => 
          it.components?.some(c => c.contractNumber?.toLowerCase() === partNumSearch.trim().toLowerCase())
        )
      );
      if (isDuplicate) {
        alert(`Error: The Contract / Ref Num "${partNumSearch.trim()}" is already assigned to another contract in the system.`);
        return;
      }
    }

    const finalDuration = compDurationVal ? `${compDurationVal} ${compDurationUnit}` : '';
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: compSearch.trim() || 'Custom Part',
      quantity: compQty,
      unit: 'pcs',
      unitCost: 0,
      taxPercent: 14,
      source: 'PROCUREMENT',
      status: 'PENDING_OFFER',
      supplierPartNumber: partNumSearch.trim() || undefined,
      contractNumber: selectedItem.productionType === 'OUTSOURCING' ? generateContractNumber(selectedItem, undefined, partNumSearch.trim()) : undefined,
      contractDuration: finalDuration,
      scopeOfWork: compScope || compSearch.trim()
    });
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setCompSearch('');
    setPartNumSearch('');
    setCompDurationVal('');
    setCompDurationUnit('Months');
    setCompScope('');
    setShowCompSuggestions(false);
    fetchData();
  };
  const handleToggleAcceptance = async (item: CustomerOrderItem) => {
    if (!selectedOrder) return;
    setIsProcessing(true);
    try {
      const updated = await dataService.toggleItemAcceptance(selectedOrder.id, item.id);
      setSelectedOrder(updated);
      setSelectedItem(updated.items.find((i: any) => i.id === item.id) || null);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const startEditingComponent = (comp: ManufacturingComponent) => {
    setEditingComp(comp);
    setEditQty(comp.quantity);
    setEditDesc(comp.description);
    setEditComponentNumber(comp.componentNumber || '');
    setEditContractNumber(comp.contractNumber || generateContractNumber(selectedItem, comp));
    setEditContractStartDate(comp.contractStartDate || '');
    
    if (selectedItem?.productionType === 'OUTSOURCING') {
      const parts = comp.contractDuration ? comp.contractDuration.split(' ') : ['','Months'];
      setEditDurationVal(parts[0]);
      setEditDurationUnit((parts[1] || 'Months') as 'Months' | 'Years');
      setEditScope(comp.scopeOfWork || '');
    }
  };

  const handleUpdateComponent = async () => {
    if (!selectedOrder || !selectedItem || !editingComp) return;
    
    setIsProcessing(true);
    try {
      const updates: any = {
        quantity: Number(editQty),
        description: editDesc,
        componentNumber: editComponentNumber
      };
      
      if (selectedItem.productionType === 'OUTSOURCING') {
        const dVal = editDurationVal || 0;
        updates.contractDuration = `${dVal} ${editDurationUnit}`;
        updates.scopeOfWork = editScope;
        updates.contractNumber = generateContractNumber(selectedItem, editingComp, editContractNumber);
        if (editContractStartDate) {
          updates.contractStartDate = editContractStartDate;
        }
      }
      
      const updatedOrder = await dataService.updateComponent(selectedOrder.id, selectedItem.id, editingComp.id, updates);
      setSelectedOrder(updatedOrder);
      const newItem = updatedOrder.items.find((i: any) => i.id === selectedItem.id);
      if (newItem) setSelectedItem(newItem);
      setEditingComp(null);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFinalizeReview = async () => {
    if (!selectedOrder) return;
    setIsProcessing(true);
    try {
      await dataService.finalizeTechnicalReview(selectedOrder.id);
      setSelectedOrder(null);
      setSelectedItem(null);
      fetchData(false);
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsProcessing(false);
    }
  };

  // Step 1: Check for outstanding ORDERED components before rollback
  const handleInitiateRollback = () => {
    if (!selectedOrder) return;
    const found: OrderedCompRecord[] = [];
    selectedOrder.items.forEach(item => {
      (item.components || []).forEach(comp => {
        if (comp.status === 'ORDERED' || comp.status === 'AWARDED') {
          const supplier = suppliers.find(s => s.id === comp.supplierId);
          found.push({
            itemId: item.id,
            itemDesc: item.description,
            compId: comp.id,
            compDesc: comp.description,
            componentNumber: comp.componentNumber,
            supplierName: supplier?.name || 'Unknown Supplier',
            quantity: comp.quantity,
            status: comp.status
          });
        }
      });
    });

    if (found.length > 0) {
      // Show resolution dialog first
      const defaultResolutions: Record<string, CompResolution> = {};
      found.forEach(c => { defaultResolutions[c.compId] = 'CANCEL_PO'; });
      setOrderedComponents(found);
      setComponentResolutions(defaultResolutions);
    } else {
      // No outstanding POs, go straight to rollback reason
      setRollbackReason('');
    }
  };

  // Step 2: Confirm resolutions & proceed to rollback reason dialog
  const handleConfirmResolutions = async () => {
    if (!selectedOrder || !orderedComponents) return;
    setIsProcessing(true);
    try {
      // Apply each resolution via dispatch actions
      for (const rec of orderedComponents) {
        const resolution = componentResolutions[rec.compId];
        if (resolution === 'RECEIVE_TO_STOCK') {
          await dataService.dispatchAction(selectedOrder.id, 'convert-to-stock-order', { itemId: rec.itemId, compId: rec.compId });
        } else {
          // CANCEL_PO: just update component status to CANCELLED via a PUT on the order
          // We'll update the component's status gracefully by sending a patch
          await dataService.cancelComponentPo(selectedOrder.id, rec.itemId, rec.compId);
        }
      }
      setOrderedComponents(null);
      // Advance to rollback reason
      setRollbackReason('');
    } catch (e: any) {
      alert(`Failed to apply resolutions: ${e.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Step 3: Execute the actual rollback
  const handleRollback = async () => {
    if (!selectedOrder || !rollbackReason) return;
    setIsProcessing(true);
    try {
      await dataService.rollbackOrderToLogged(selectedOrder.id, rollbackReason);
      setSelectedOrder(null);
      setSelectedItem(null);
      setRollbackReason(null);
      fetchData();
    } catch (e: any) {
      alert("Rollback failed.");
    } finally {
      setIsProcessing(false);
    }
  };

  const orderFinancials = useMemo(() => {
    if (!selectedOrder) return { revenue: 0, cost: 0, marginPct: 0, isViolated: false };

    let totalRevenue = 0;
    let totalCost = 0;

    selectedOrder.items.forEach(it => {
      totalRevenue += (it.quantity * it.pricePerUnit);
      it.components?.forEach(c => {
        totalCost += (c.quantity * (c.unitCost || 0));
      });
    });

    const marginAmt = totalRevenue - totalCost;
    const markupPct = totalCost > 0 ? (marginAmt / totalCost) * 100 : (totalRevenue > 0 ? 100 : 0);
    const isViolated = markupPct < config.settings.minimumMarginPct;

    return {
      revenue: totalRevenue,
      cost: totalCost,
      marginPct: markupPct,
      isViolated
    };
  }, [selectedOrder, config.settings.minimumMarginPct]);

  const allItemsAccepted = selectedOrder?.items.every(it => it.isAccepted) || false;

  return (
    <div className="space-y-6">
      {/* Tab Bar */}
      <div className="flex gap-1 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 w-fit">
        <button
          onClick={() => setActiveTab('review')}
          className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'review' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-50'}`}
        >
          <i className="fa-solid fa-microscope mr-2"></i> Review Queue
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'history' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-50'}`}
        >
          <i className="fa-solid fa-clock-rotate-left mr-2"></i> Part History
        </button>
      </div>

      {activeTab === 'history' ? (
        <PartHistory orders={orders} suppliers={suppliers} />
      ) : (
        <>
          <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-6">
            <div>
              <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Technical Workflow Registry</h2>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">FIFO Review Queue • {queueOrders.length} Records Pending Engineering Study</p>
            </div>
            <div className="relative w-full md:w-96">
              <input
                type="text"
                placeholder="Search Registry..."
                className="w-full px-5 py-4 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 transition-all font-bold text-sm"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 text-lg"></i>
            </div>
          </div>

          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                <tr>
                  <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('id')}>
                    PO Identifier <SortIcon column="id" />
                  </th>
                  <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('orderDate')}>
                    PO Received <SortIcon column="orderDate" />
                  </th>
                  <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('customer')}>
                    Customer Entity <SortIcon column="customer" />
                  </th>
                  <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('lineCount')}>
                    Line Count <SortIcon column="lineCount" />
                  </th>
                  <th className="px-8 py-5">SLA Threshold</th>
                  <th className="px-8 py-5 text-right">BoM Status</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-50">
                {queueOrders.map(o => {
                  const acceptedCount = o.items.filter(it => it.isAccepted).length;
                  const progress = (acceptedCount / o.items.length) * 100;

                  return (
                    <tr
                      key={o.id}
                      onClick={() => { setSelectedOrder(o); if (o.items.length > 0) setSelectedItem(o.items[0]); }}
                      className={`hover:bg-blue-50/40 cursor-pointer transition-all group ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-rose-50/30' : ''}`}
                    >
                      <td className="px-8 py-6">
                        <div className="font-mono text-xs font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Ref: {o.customerReferenceNumber || 'N/A'}</div>
                      </td>
                      <td className="px-8 py-6">
                        <div className="text-xs font-black text-slate-700">{o.orderDate ? new Date(o.orderDate).toLocaleDateString() : 'N/A'}</div>
                        <div className="text-[9px] text-slate-400 font-bold uppercase mt-1">FIFO Rank</div>
                      </td>

                      <td className="px-8 py-6">
                        <div className="font-black text-slate-800 text-sm tracking-tight">{o.customerName}</div>
                        {o.status === OrderStatus.WAITING_SUPPLIERS && (() => {
                          const itemsInFactoryCount = o.items.filter(i => {
                            const eff = getItemEffectiveStatus(i);
                            return ['WAITING_FACTORY', 'MANUFACTURING', 'MANUFACTURED'].includes(eff);
                          }).length;
                          return itemsInFactoryCount > 0 ? (
                            <div className="text-[9px] font-bold text-orange-600 mt-1 uppercase" title={`${itemsInFactoryCount} of ${o.items.length} line items have all components ready for the factory.`}>
                              <i className="fa-solid fa-bolt mr-1"></i> {itemsInFactoryCount}/{o.items.length} Items Factory-Ready
                            </div>
                          ) : null;
                        })()}
                      </td>
                      <td className="px-8 py-6">
                        <div className="text-xs font-black text-slate-600">{o.items.length} Positions</div>
                      </td>
                      <td className="px-8 py-6">
                        <ThresholdDisplay order={o} config={config} />
                      </td>
                      <td className="px-8 py-6">
                        <div className="flex items-center gap-4 justify-end">
                          {o.status === OrderStatus.NEGATIVE_MARGIN && (
                            <span className="px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black uppercase rounded animate-pulse">Margin Breach</span>
                          )}
                          <div className="flex-1 max-w-[100px] h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full transition-all duration-700 ${progress === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }}></div>
                          </div>
                          <span className="text-[10px] font-black text-slate-400">{acceptedCount}/{o.items.length}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {queueOrders.length === 0 && (
              <div className="p-20 text-center flex flex-col items-center gap-4 text-slate-300">
                <i className="fa-solid fa-clipboard-check text-6xl opacity-10"></i>
                <p className="font-black text-xs uppercase tracking-[0.3em]">Engineering Queue Clear</p>
              </div>
            )}
          </div>

          {selectedOrder && (
            <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-xl z-[100] flex items-center justify-center p-4 md:p-12 overflow-hidden animate-in fade-in duration-300">
              <div className="bg-white w-full max-w-7xl h-full rounded-[3rem] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-500 border border-white/20">

                <div className="px-8 py-5 bg-slate-900 text-white flex justify-between items-center shrink-0">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center text-xl shadow-xl">
                      <i className="fa-solid fa-microscope"></i>
                    </div>
                    <div>
                      <div className="text-[9px] font-black uppercase tracking-[0.3em] text-blue-400 mb-0.5 leading-none">Active Engineering Study</div>
                      <h3 className="text-xl font-black tracking-tight leading-tight">{selectedOrder.customerName}</h3>
                      <div className="text-[9px] font-bold text-slate-400 mt-0.5 uppercase flex items-center gap-2">
                        <span className="bg-slate-800 px-2 py-0.5 rounded leading-none">ID: {selectedOrder.internalOrderNumber}</span>
                        <span className="bg-slate-800 px-2 py-0.5 rounded leading-none">PO: {selectedOrder.customerReferenceNumber}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleInitiateRollback}
                      className="px-4 py-2 bg-rose-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-rose-700 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-rotate-left"></i> Rollback to Logged Registry
                    </button>
                    <button
                      onClick={() => { setSelectedOrder(null); setSelectedItem(null); }}
                      className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center transition-all text-white"
                    >
                      <i className="fa-solid fa-xmark text-base"></i>
                    </button>
                  </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                  <div className="w-80 bg-slate-50 border-r border-slate-100 flex flex-col overflow-hidden">
                    <div className="p-6 border-b border-slate-200">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Order Positions</h4>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                      {selectedOrder.items.map(item => {
                        const itemCost = item.components?.reduce((s, c) => s + (c.quantity * c.unitCost), 0) || 0;
                        const itemRev = item.quantity * item.pricePerUnit;
                        const isItemNegative = itemRev > 0 && itemCost > itemRev;

                        return (
                          <button
                            key={item.id}
                            onClick={() => setSelectedItem(item)}
                            className={`w-full text-left p-5 rounded-2xl border transition-all flex flex-col gap-1 relative overflow-hidden group ${selectedItem?.id === item.id ? 'bg-indigo-600 border-indigo-700 shadow-xl' : 'bg-white border-slate-100 hover:border-slate-300'}`}
                          >
                            <div className="flex justify-between items-center mb-1">
                              <span className={`text-[8px] font-mono font-black uppercase ${selectedItem?.id === item.id ? 'text-indigo-200' : 'text-blue-500'}`}>{item.orderNumber}</span>
                              {item.isAccepted && <i className={`fa-solid fa-circle-check text-[10px] ${selectedItem?.id === item.id ? 'text-white' : 'text-emerald-500'}`}></i>}
                            </div>
                            <div className={`text-sm font-black tracking-tight leading-tight ${selectedItem?.id === item.id ? 'text-white' : 'text-slate-800'}`}>{item.description}</div>
                            {isItemNegative && (
                              <div className="mt-1 text-[8px] font-black text-rose-500 uppercase bg-rose-50 px-1.5 py-0.5 rounded border border-rose-100">Profitability Integrity Breach</div>
                            )}
                            <div className={`text-[9px] font-bold mt-2 flex justify-between ${selectedItem?.id === item.id ? 'text-indigo-200' : 'text-slate-400'}`}>
                              <span>{item.quantity} {item.unit}</span>
                              <span className="uppercase">{item.isAccepted ? 'Ready' : 'In Study'}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-10 space-y-8 custom-scrollbar bg-slate-50/30">
                    {selectedItem ? (
                      <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-right-4 duration-500">
                        <div className="flex justify-between items-end border-b-2 border-slate-100 pb-6">
                          <div>
                            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Studying Line Item</h4>
                            <h2 className="text-3xl font-black text-slate-800 tracking-tight">{selectedItem.description}</h2>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Accumulated BoM Cost</p>
                            <div className="text-4xl font-black text-slate-900">
                              {selectedItem.components?.reduce((s, c) => s + (c.quantity * c.unitCost), 0).toLocaleString()} <span className="text-sm font-bold opacity-30">L.E.</span>
                            </div>
                          </div>
                        </div>

                        {(!selectedItem.isAccepted || (selectedItem.productionType === 'MANUFACTURING' || selectedItem.productionType === 'OUTSOURCING')) && (

                          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-xl space-y-6">
                            <div className="flex justify-between items-center border-b border-slate-100 pb-4">
                              <div className="flex items-center gap-6">
                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Workflow Mode</h4>
                                <div className="flex bg-slate-100 p-1 rounded-xl">
                                  <button
                                    onClick={() => dataService.setProductionType(selectedOrder.id, selectedItem.id, 'TRADING').then(o => { 
                                      setSelectedOrder(o); 
                                      setSelectedItem(o.items.find(it => it.id === selectedItem.id)!); 
                                    })}
                                    className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${selectedItem.productionType === 'TRADING' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                  >
                                    <i className="fa-solid fa-cart-shopping mr-2"></i> Trading
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (selectedItem.productionType === 'TRADING' && selectedItem.components?.length) {
                                        if (!confirm("Switching to Outsourcing will remove the automatically generated mirror component. Continue?")) return;
                                      }
                                      dataService.setProductionType(selectedOrder.id, selectedItem.id, 'OUTSOURCING').then(o => { 
                                        setSelectedOrder(o); 
                                        setSelectedItem(o.items.find(it => it.id === selectedItem.id)!); 
                                      });
                                    }}
                                    className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${selectedItem.productionType === 'OUTSOURCING' ? 'bg-white text-violet-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                  >
                                    <i className="fa-solid fa-handshake mr-2"></i> Outsourcing
                                  </button>
                                  <button
                                    onClick={() => {
                                      if (selectedItem.productionType === 'TRADING' && selectedItem.components?.length) {
                                        if (!confirm("Switching to Manufacturing will remove the automatically generated mirror component. Continue?")) return;
                                      }
                                      dataService.setProductionType(selectedOrder.id, selectedItem.id, 'MANUFACTURING').then(o => { 
                                        setSelectedOrder(o); 
                                        setSelectedItem(o.items.find(it => it.id === selectedItem.id)!); 
                                      });
                                    }}
                                    className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase transition-all ${selectedItem.productionType === 'MANUFACTURING' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                                  >
                                    <i className="fa-solid fa-gears mr-2"></i> Manufacturing
                                  </button>
                                </div>
                              </div>
                              <div className="text-[10px] font-bold text-blue-600 uppercase tracking-tight">
                                <i className="fa-solid fa-brain-circuit mr-1"></i> {selectedItem.productionType === 'TRADING' ? 'Trading Mirror Active' : 'Sourcing Engine Active'}
                              </div>

                            </div>
                            
                            {(selectedItem.productionType === 'MANUFACTURING' || selectedItem.productionType === 'OUTSOURCING') && (

                              <div className="flex justify-between items-center border-b border-slate-100 pb-4">
                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Add Components / Services</h4>
                              </div>
                            )}
                            <div className="flex flex-col md:flex-row gap-4">
                              <div className="w-full md:w-24 space-y-1.5">
                                <label className="text-[9px] font-black text-slate-400 uppercase ml-1">Quantity</label>
                                <input
                                  type="number"
                                  className="w-full p-4 border-2 border-slate-100 rounded-2xl text-sm font-black outline-none focus:border-blue-500 transition-all text-center"
                                  value={compQty}
                                  onChange={e => setCompQty(parseInt(e.target.value) || 1)}
                                />
                              </div>
                              <div className="flex-1 space-y-1.5">
                                <label className={`text-[9px] font-black uppercase ml-1 transition-all ${selectedItem.productionType === 'OUTSOURCING' ? 'text-violet-600' : 'text-slate-400'}`}>
                                  {selectedItem.productionType === 'OUTSOURCING' ? 'Contract / Ref Num' : 'Search Sourcing Catalogs (Stock or Market)'}
                                </label>
                                <div className="flex gap-2 relative">
                                  <input
                                    type="text"
                                    placeholder={selectedItem.productionType === 'OUTSOURCING' ? 'Contract Number...' : 'Mfr. Part Number...'}
                                    className={`w-1/3 p-4 border-2 rounded-2xl text-sm font-mono outline-none transition-all placeholder:font-sans placeholder:text-slate-300 ${selectedItem.productionType === 'OUTSOURCING' ? 'border-violet-100 text-violet-800 focus:border-violet-500' : 'border-blue-50 text-blue-800 focus:border-blue-500'}`}
                                    value={partNumSearch}
                                    onChange={e => { setPartNumSearch(e.target.value); setShowCompSuggestions(true); }}
                                    onFocus={() => setShowCompSuggestions(true)}
                                  />
                                  <div className="absolute -bottom-4 left-1 text-[8px] font-bold text-slate-400 uppercase">Auto-generated ID if left blank</div>
                                  <div className="relative flex-1 group">
                                    <textarea
                                      placeholder={selectedItem.productionType === 'OUTSOURCING' ? "Enter Service or Contract Description (Required)..." : "Enter component SKU or Name..."}
                                      className="w-full p-4 pl-12 border-2 border-slate-100 rounded-2xl text-sm font-bold outline-none focus:border-blue-500 transition-all resize-none min-h-[58px]"
                                      rows={1}
                                      value={compSearch}
                                      onChange={e => { setCompSearch(e.target.value); if(selectedItem.productionType !== 'OUTSOURCING') setShowCompSuggestions(true); }}
                                      onFocus={() => { if(selectedItem.productionType !== 'OUTSOURCING') setShowCompSuggestions(true); }}
                                    />
                                    <i className="fa-solid fa-search absolute left-4 top-5 text-slate-300"></i>
                                  </div>

                                  {showCompSuggestions && selectedItem.productionType !== 'OUTSOURCING' && (invResults.length > 0 || historyResults.length > 0 || supplierResults.length > 0 || (compSearch || partNumSearch)) && (
                                    <div className="absolute top-14 left-0 right-0 mt-3 bg-white border border-slate-200 rounded-[2rem] shadow-2xl z-[110] overflow-hidden divide-y divide-slate-50 max-h-80 overflow-y-auto animate-in slide-in-from-top-2 duration-300">
                                      {invResults.map(i => {
                                        const available = i.quantityInStock - (i.quantityReserved || 0);
                                        const isLow = available > 0 && available <= compQty;
                                        const isOut = available <= 0;
                                        return (
                                          <button key={i.id} onMouseDown={() => handleAddComponent(i)} className={`w-full text-left p-5 hover:bg-blue-50 flex justify-between items-center group transition-colors ${isOut ? 'opacity-50' : ''}`}>
                                            <div>
                                              <div className="font-black text-slate-800 group-hover:text-blue-600 text-xs">{i.description}</div>
                                              <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase flex gap-4">
                                                <span>SKU: {i.sku}</span>
                                                <span className={`font-black ${isOut ? 'text-rose-500' : isLow ? 'text-amber-500' : 'text-emerald-600'}`}>
                                                  Available: {available} {i.unit}
                                                </span>
                                                {(i.quantityReserved || 0) > 0 && (
                                                  <span className="text-blue-500">Reserved: {i.quantityReserved}</span>
                                                )}
                                              </div>
                                            </div>
                                            <div className="flex flex-col items-end gap-1">
                                              <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full ${isOut ? 'bg-rose-100 text-rose-600' : 'bg-blue-100 text-blue-700'}`}>
                                                {isOut ? 'Out of Stock' : 'In-Stock Catalog'}
                                              </span>
                                              <div className="text-[9px] font-black text-slate-800">L.E. {i.lastCost?.toLocaleString()}</div>
                                            </div>
                                          </button>
                                        );
                                      })}
                                      {historyResults.map(h => {
                                        const lastPrice = h.prices[h.prices.length - 1];
                                        const lastOrder = h.orders[h.orders.length - 1];
                                        return (
                                          <button
                                            key={h.description + lastOrder?.orderNo}
                                            onMouseDown={() => {
                                              setCompSearch(h.description);
                                              if (h.componentNumber) setPartNumSearch(h.componentNumber);
                                              setShowCompSuggestions(false);
                                            }}
                                            className="w-full text-left p-5 hover:bg-slate-50 flex justify-between items-center group transition-colors border-l-4 border-slate-300"
                                          >
                                            <div>
                                              <div className="font-black text-slate-800 group-hover:text-blue-600 text-xs">{h.description}</div>
                                              <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase flex gap-4 flex-wrap">
                                                <span>Part: {h.componentNumber || 'N/A'}</span>
                                                <span className="text-blue-600">Last Price: L.E. {lastPrice?.price?.toLocaleString()} ({lastPrice?.supplierName || 'N/A'})</span>
                                                <span>History: Ordered {lastOrder?.orderDate || 'N/A'}{lastOrder?.receivedDate ? ` • Received ${new Date(lastOrder.receivedDate).toLocaleDateString()}` : ''}</span>
                                              </div>
                                            </div>
                                            <div className="flex flex-col items-end gap-1">
                                              <span className="text-[8px] font-black uppercase px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full">Historical Library</span>
                                              <div className="text-[9px] font-black text-slate-400 italic">Found in {h.orders.length} past orders</div>
                                            </div>
                                          </button>
                                        );
                                      })}
                                      {supplierResults.map(({ supplier, part }) => (
                                        <button key={part.id} onMouseDown={() => handleAddSupplierPart(supplier, part)} className="w-full text-left p-5 hover:bg-amber-50 flex justify-between items-center group transition-colors">
                                          <div>
                                            <div className="font-black text-slate-800 group-hover:text-amber-700 text-xs">{part.description}</div>
                                            <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase flex gap-4">
                                              <span>Vendor: {supplier.name}</span>
                                              <span className="text-amber-600 font-black">L.E. {part.price?.toLocaleString()}</span>
                                            </div>
                                          </div>
                                          <div className="flex flex-col items-end gap-1">
                                            <span className="text-[8px] font-black uppercase px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">Procurement Market</span>
                                            <button
                                              onMouseDown={(e) => { e.stopPropagation(); openHistory(part.description, part.partNumber); }}
                                              className="text-[9px] font-black text-blue-600 hover:underline"
                                            >
                                              View History
                                            </button>
                                          </div>
                                        </button>
                                      ))}
                                      <button
                                        onMouseDown={handleAddCustomProcurement}
                                        disabled={
                                          selectedItem.productionType === 'OUTSOURCING' 
                                            ? (!compSearch.trim() || !compDurationVal || !compScope.trim())
                                            : (!compSearch.trim() && !partNumSearch.trim())
                                        }
                                        className="w-full text-left p-5 bg-slate-900 hover:bg-black text-white flex justify-between items-center transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                      >
                                        <div>
                                          <div className="font-black text-xs">Request custom component: "{compSearch || 'Custom Part'}"</div>
                                          <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase">Initialize new sourcing workflow</div>
                                        </div>
                                        <i className="fa-solid fa-plus-circle text-blue-400 text-xl"></i>
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>

                            {selectedItem.productionType === 'OUTSOURCING' && (
                              <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-300 w-full mt-4">
                                <div className="flex flex-col md:flex-row gap-4">
                                <div className="w-full md:w-32 space-y-1.5 px-1">
                                  <div className="flex justify-between items-center ml-1">
                                    <label className="text-[9px] font-black text-violet-400 uppercase">
                                      Duration {!compDurationVal && <span className="text-rose-500">*</span>}
                                    </label>
                                    <div className="flex bg-violet-50 p-0.5 rounded-lg border border-violet-100 scale-90 origin-right shrink-0">
                                      <button
                                        onClick={() => {
                                          if (compDurationUnit === 'Years' && compDurationVal) {
                                            const v = parseFloat(compDurationVal.toString());
                                            setCompDurationVal(Math.round(v * 12));
                                          }
                                          setCompDurationUnit('Months');
                                        }}
                                        className={`px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase transition-all ${compDurationUnit === 'Months' ? 'bg-white text-violet-600 shadow-sm border border-violet-100' : 'text-slate-400 hover:text-slate-600'}`}
                                      >
                                        Mo
                                      </button>
                                      <button
                                        onClick={() => {
                                          if (compDurationUnit === 'Months' && compDurationVal) {
                                            const v = parseInt(compDurationVal.toString());
                                            setCompDurationVal(parseFloat((v / 12).toFixed(2)));
                                          }
                                          setCompDurationUnit('Years');
                                        }}
                                        className={`px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase transition-all ${compDurationUnit === 'Years' ? 'bg-white text-violet-600 shadow-sm border border-violet-100' : 'text-slate-400 hover:text-slate-600'}`}
                                      >
                                        Yr
                                      </button>
                                    </div>
                                  </div>
                                  <input
                                    type="number"
                                    placeholder="0"
                                    step={compDurationUnit === 'Months' ? "1" : "0.01"}
                                    className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-black outline-none focus:border-violet-500 transition-all bg-violet-50/20 text-center"
                                    value={compDurationVal}
                                    onChange={e => {
                                      const raw = e.target.value;
                                      if (compDurationUnit === 'Months') {
                                        setCompDurationVal(parseInt(raw) || '');
                                      } else {
                                        setCompDurationVal(parseFloat(raw) || '');
                                      }
                                    }}
                                  />
                                </div>
                                <div className="flex-1 space-y-1.5 px-1">
                                  <label className="text-[9px] font-black text-violet-400 uppercase ml-1">
                                    Scope of Work Summary {!compScope.trim() && <span className="text-rose-500">*</span>}
                                  </label>
                                  <textarea
                                    placeholder="Detailed scope (Required)..."
                                    className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-bold outline-none focus:border-violet-500 transition-all bg-violet-50/20 resize-none h-[58px]"
                                    value={compScope}
                                    onChange={e => setCompScope(e.target.value)}
                                  />
                                </div>
                              </div>

                              <div className="px-1">
                                <button
                                  onClick={handleAddCustomProcurement}
                                  disabled={!compSearch.trim() || !compDurationVal || !compScope.trim()}
                                  className="w-full py-5 bg-violet-600 hover:bg-violet-700 text-white rounded-[2rem] font-black uppercase text-xs tracking-[0.2em] shadow-xl shadow-violet-100 transition-all active:scale-95 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  <i className="fa-solid fa-plus-circle"></i>
                                  Submit Outsourced Service to BoM
                                </button>
                              </div>
                            </div>
                          )}

                            {selectedItem.productionType === 'TRADING' && (
                              <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600">
                                    <i className="fa-solid fa-repeat animate-spin-slow"></i>
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-black text-blue-900 uppercase">Trading Mode Active</div>
                                    <div className="text-xs text-blue-600 font-medium italic">Component is automatically mirrored from the line item descriptor.</div>
                                  </div>
                                </div>
                                <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest bg-white px-3 py-1 rounded-lg border border-blue-50">Locked for Trading</div>
                              </div>
                            )}

                          </div>
                        )}

                        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
                          <div className="p-6 bg-slate-900 text-slate-400 text-[10px] font-black uppercase tracking-widest flex justify-between items-center">
                            <span>Bill of Materials (BoM) Study</span>
                            {selectedItem.isAccepted && <span className="text-emerald-400 flex items-center gap-2"><i className="fa-solid fa-lock"></i> Accepted Configuration</span>}
                          </div>
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 border-b border-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                              <tr>
                                <th className="px-6 py-4">Component Descriptor</th>
                                <th className="px-6 py-4">Source</th>
                                <th className="px-6 py-4 text-center">Qty</th>
                                <th className="px-6 py-4 text-right">Unit Cost</th>
                                <th className="px-6 py-4 text-right">Subtotal</th>
                                <th className="px-6 py-4 w-10"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {selectedItem.components?.map(c => (
                                <tr key={c.id} className="group hover:bg-slate-50/50 transition-colors">
                                  <td className="px-6 py-4">
                                    <div className="font-black text-slate-800 text-xs">
                                      {selectedItem.productionType === 'OUTSOURCING' && c.scopeOfWork ? c.scopeOfWork : c.description}
                                    </div>
                                    <div className="flex flex-col gap-0.5 mt-1">
                                      <div className="font-mono text-[9px] text-blue-500">
                                        {selectedItem.productionType === 'OUTSOURCING' ? (c.contractNumber || c.componentNumber) : c.componentNumber}
                                      </div>
                                      {selectedItem.productionType === 'OUTSOURCING' && c.contractDuration && (
                                        <div className="text-[8px] font-black text-violet-600 uppercase bg-violet-50 px-2 py-0.5 rounded-lg w-fit mt-1">Duration: {c.contractDuration}</div>
                                      )}
                                      {selectedItem.productionType !== 'OUTSOURCING' && c.supplierPartNumber && c.supplierPartNumber !== c.componentNumber && (
                                        <div className="font-mono text-[9px] text-amber-600 font-bold uppercase tracking-widest">MFR P/N: {c.supplierPartNumber}</div>
                                      )}
                                    </div>

                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${c.source === 'STOCK' ? 'bg-blue-50 text-blue-600 border-blue-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>{c.source}</span>
                                  </td>
                                  <td className="px-6 py-4 text-center font-bold text-slate-700">{c.quantity} <span className="text-[10px] text-slate-400 font-normal">{c.unit}</span></td>
                                  <td className="px-6 py-4 text-right font-black text-slate-500">{c.unitCost.toLocaleString()}</td>
                                  <td className="px-6 py-4 text-right font-black text-slate-900">{(c.quantity * c.unitCost).toLocaleString()}</td>
                                  <td className="px-6 py-4 text-right">
                                    <div className="flex justify-end gap-2">
                                      <button
                                        onClick={() => startEditingComponent(c)}
                                        className="p-2 text-slate-300 hover:text-blue-500 transition-colors"
                                      >
                                        <i className="fa-solid fa-pen-to-square"></i>
                                      </button>
                                      <button
                                        onClick={() => dataService.removeComponent(selectedOrder.id, selectedItem.id, c.id).then(o => { setSelectedOrder(o); setSelectedItem(o.items.find(it => it.id === selectedItem.id)!); })}
                                        className="p-2 text-slate-300 hover:text-rose-500 transition-colors"
                                      >
                                        <i className="fa-solid fa-trash-can"></i>
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                              {(!selectedItem.components || selectedItem.components.length === 0) && (
                                <tr>
                                  <td colSpan={6} className="px-6 py-16 text-center">
                                    <div className="flex flex-col items-center gap-3 text-slate-300">
                                      <i className="fa-solid fa-layer-group text-3xl opacity-20"></i>
                                      <p className="font-black text-[9px] uppercase tracking-[0.2em]">BoM is currently empty</p>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        <div className="pt-10 flex flex-col items-center gap-6 border-t-2 border-slate-100">
                          <div className="flex justify-between items-center w-full">
                            <div className="flex gap-6">
                              <div className="text-center">
                                <div className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">BoM Weight</div>
                                <div className="text-lg font-black text-slate-800">{selectedItem.components?.length || 0} Items</div>
                              </div>
                              <div className="w-px h-10 bg-slate-200"></div>
                              <div className="text-center">
                                <div className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Position Status</div>
                                <div className={`text-[10px] font-black uppercase px-3 py-1 rounded-full mt-1 ${selectedItem.isAccepted ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {selectedItem.isAccepted ? 'Line Ready' : 'In Study'}
                                </div>
                              </div>
                            </div>

                            <button
                              disabled={isProcessing}
                              onClick={() => handleToggleAcceptance(selectedItem)}
                              className={`px-12 py-5 rounded-3xl font-black uppercase text-[10px] tracking-[0.2em] transition-all shadow-xl active:scale-95 flex items-center gap-3 ${selectedItem.isAccepted ? 'bg-rose-50 text-rose-600 border-2 border-rose-200' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                            >
                              {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className={`fa-solid ${selectedItem.isAccepted ? 'fa-rotate-left' : 'fa-check'}`}></i>}
                              {selectedItem.isAccepted ? 'Revoke Approval' : 'Approve Position'}
                            </button>
                          </div>

                          {allItemsAccepted && (
                            <div className={`w-full p-8 rounded-[2.5rem] shadow-2xl animate-in slide-in-from-bottom-4 duration-500 flex flex-col md:flex-row justify-between items-center gap-6 text-white ${orderFinancials.isViolated ? 'bg-rose-600' : 'bg-blue-600'}`}>
                              <div className="flex items-center gap-6">
                                <div className="w-16 h-16 rounded-3xl bg-white/20 flex items-center justify-center text-3xl shrink-0">
                                  <i className={`fa-solid ${orderFinancials.isViolated ? 'fa-triangle-exclamation animate-pulse' : 'fa-shield-check'}`}></i>
                                </div>
                                <div>
                                  <h4 className="text-lg font-black tracking-tight">{orderFinancials.isViolated ? 'Profitability Integrity Breach' : 'Full Engineering Authorization'}</h4>
                                  <p className="text-xs font-medium opacity-80 mt-1">
                                    {orderFinancials.isViolated
                                      ? `Order cannot be finalized due to profitability integrity breach. Please review BoM components or escalate for commercial adjustment.`
                                      : `All ${selectedOrder.items.length} line items have been technically vetted. System ready for workflow transition.`}
                                  </p>
                                </div>
                              </div>
                              <button
                                disabled={isProcessing || orderFinancials.isViolated}
                                onClick={handleFinalizeReview}
                                className={`px-12 py-5 rounded-[2rem] font-black uppercase text-xs tracking-[0.2em] transition-all shadow-xl active:scale-95 flex items-center gap-3 ${orderFinancials.isViolated ? 'bg-rose-900/40 text-rose-200 cursor-not-allowed border border-rose-400/30' : 'bg-white text-blue-600 hover:bg-blue-50'}`}
                              >
                                {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : (orderFinancials.isViolated ? <i className="fa-solid fa-lock"></i> : <i className="fa-solid fa-paper-plane"></i>)}
                                {orderFinancials.isViolated ? 'Blocked: Profitability Breach' : 'Finalize Review & Route PO'}
                              </button>
                            </div>
                          )}
                        </div>

                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center p-20 text-slate-300">
                        <i className="fa-solid fa-arrow-left text-4xl mb-4 animate-bounce-x"></i>
                        <h4 className="font-black text-sm uppercase tracking-[0.3em]">Select Line Position</h4>
                        <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-widest">Awaiting Engineering context selection</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* --- STEP 1: Procurement Resolution Modal (ORDERED components) --- */}
          {orderedComponents && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
              <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl p-10 animate-in zoom-in-95 duration-200 border border-slate-100">
                <div className="flex items-center gap-6 mb-8">
                  <div className="w-16 h-16 rounded-3xl bg-amber-50 text-amber-600 flex items-center justify-center text-3xl shadow-inner">
                    <i className="fa-solid fa-triangle-exclamation"></i>
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Outstanding Supplier POs Detected</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                      {orderedComponents.length} Component{orderedComponents.length > 1 ? 's' : ''} — Resolve before rollback
                    </p>
                  </div>
                </div>

                <p className="text-sm text-slate-500 font-medium leading-relaxed mb-6">
                  The following components already have issued supplier POs. You must decide the fate of each before rolling back this order:
                </p>

                <div className="space-y-3 max-h-72 overflow-y-auto custom-scrollbar pr-2">
                  {orderedComponents.map(rec => (
                    <div key={rec.compId} className="bg-slate-50 border border-slate-100 rounded-2xl p-5">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <div className="font-black text-slate-800 text-sm">{rec.compDesc}</div>
                          <div className="text-[10px] font-bold text-slate-400 uppercase mt-0.5 flex gap-3">
                            <span>Ref: {rec.componentNumber || 'N/A'}</span>
                            <span>Supplier: {rec.supplierName}</span>
                            <span>Qty: {rec.quantity}</span>
                          </div>
                          <div className="text-[9px] font-bold text-amber-600 uppercase bg-amber-50 px-2 py-0.5 rounded mt-1.5 w-fit border border-amber-100">Awaiting Delivery</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setComponentResolutions(prev => ({ ...prev, [rec.compId]: 'CANCEL_PO' }))}
                          className={`px-4 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest border-2 transition-all flex items-center justify-center gap-2 ${componentResolutions[rec.compId] === 'CANCEL_PO'
                            ? 'bg-rose-600 text-white border-rose-600 shadow-lg'
                            : 'bg-white text-rose-600 border-rose-200 hover:border-rose-400'
                            }`}
                        >
                          <i className="fa-solid fa-ban"></i> Cancel Supplier PO
                        </button>
                        <button
                          onClick={() => setComponentResolutions(prev => ({ ...prev, [rec.compId]: 'RECEIVE_TO_STOCK' }))}
                          className={`px-4 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest border-2 transition-all flex items-center justify-center gap-2 ${componentResolutions[rec.compId] === 'RECEIVE_TO_STOCK'
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-lg'
                            : 'bg-white text-emerald-600 border-emerald-200 hover:border-emerald-400'
                            }`}
                        >
                          <i className="fa-solid fa-boxes-stacked"></i> Receive to Stock
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-8 flex gap-3">
                  <button
                    onClick={() => { setOrderedComponents(null); setComponentResolutions({}); }}
                    className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200"
                  >
                    Abort
                  </button>
                  <button
                    disabled={isProcessing}
                    onClick={handleConfirmResolutions}
                    className="flex-[2] py-4 bg-amber-500 text-white font-black rounded-2xl uppercase text-[10px] tracking-widest shadow-xl shadow-amber-200 hover:bg-amber-600 transition-all flex items-center justify-center gap-2"
                  >
                    {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-arrow-right"></i>}
                    Confirm Resolutions & Continue
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* --- STEP 2: Rollback Reason Modal --- */}
          {rollbackReason !== null && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
              <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 duration-200 border border-slate-100">
                <div className="flex items-center gap-6 mb-8">
                  <div className="w-16 h-16 rounded-3xl bg-rose-50 text-rose-600 flex items-center justify-center text-3xl shadow-inner"><i className="fa-solid fa-rotate-left"></i></div>
                  <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">PO Workflow Rollback</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Reverting to logged state</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <p className="text-sm text-slate-500 font-medium leading-relaxed">This will pull the order out of Engineering Review and move it back to the Logged Registry. This action is tracked in the permanent audit logs.</p>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Reason for Rollback</label>
                    <textarea
                      className="w-full p-4 border rounded-2xl bg-slate-50 font-bold text-sm outline-none focus:ring-4 focus:ring-rose-50 h-32"
                      placeholder="e.g. Fundamental entry error, Customer requested scope change..."
                      value={rollbackReason} onChange={e => setRollbackReason(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-8 flex gap-3">
                  <button onClick={() => setRollbackReason(null)} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200">Abort</button>
                  <button
                    disabled={!rollbackReason.trim() || isProcessing}
                    onClick={handleRollback}
                    className="flex-[2] py-4 bg-rose-600 text-white font-black rounded-2xl uppercase text-[10px] tracking-widest shadow-xl shadow-rose-200 hover:bg-rose-700 transition-all flex items-center justify-center gap-2"
                  >
                    {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check"></i>}
                    Confirm Rollback
                  </button>
                </div>
              </div>
            </div>
          )}

          {compHistory && (
            <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[300] flex items-center justify-center p-4">
              <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl p-10 animate-in zoom-in-95 duration-300">
                <div className="flex justify-between items-center mb-8">
                  <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Component Purchase History</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Found {compHistory.length} previous instances</p>
                  </div>
                  <button onClick={() => setCompHistory(null)} className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 hover:bg-rose-50 hover:text-rose-500 transition-all">
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>

                <div className="overflow-hidden border border-slate-100 rounded-3xl">
                  <table className="w-full text-left">
                    <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                      <tr>
                        <th className="px-6 py-4">Date</th>
                        <th className="px-6 py-4">Supplier</th>
                        <th className="px-6 py-4">Qty</th>
                        <th className="px-6 py-4 text-right">Unit Price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {compHistory.map((h, idx) => (
                        <tr key={idx} className="hover:bg-blue-50/30 transition-colors">
                          <td className="px-6 py-4">
                            <div className="text-[10px] font-bold text-slate-500">{new Date(h.date).toLocaleDateString()}</div>
                            <div className="text-[8px] font-black text-blue-600 uppercase mt-0.5">{h.orderNumber}</div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-xs font-black text-slate-800 uppercase tracking-tight">{h.supplierName}</div>
                            <div className="text-[8px] font-bold text-slate-400 uppercase mt-0.5">PO: {h.poNumber}</div>
                          </td>
                          <td className="px-6 py-4 text-xs font-bold text-slate-600">{h.quantity}</td>
                          <td className="px-6 py-4 text-right">
                            <div className="text-sm font-black text-slate-800">{h.price.toLocaleString()} <span className="text-[9px] text-slate-400">L.E.</span></div>
                          </td>
                        </tr>
                      ))}
                      {compHistory.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-6 py-12 text-center text-[10px] font-black uppercase text-slate-300 italic tracking-[0.2em]">
                            No historical records found for this component
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-8 flex justify-end">
                  <button onClick={() => setCompHistory(null)} className="px-8 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg shadow-slate-200">Close History</button>
                </div>
              </div>
            </div>
          )}

          {isHistoryLoading && (
            <div className="fixed inset-0 z-[350] bg-white/50 backdrop-blur-[2px] flex items-center justify-center">
              <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}

          {editingComp && (
            <div className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
              <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-300">
                <div className="p-8 border-b-2 border-slate-50 flex justify-between items-center bg-slate-50/50">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 tracking-tight">Edit BoM Component</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Component Ref: {editingComp.componentNumber}</p>
                  </div>
                  <button onClick={() => setEditingComp(null)} className="w-10 h-10 rounded-2xl bg-white shadow-sm flex items-center justify-center text-slate-400 hover:text-rose-500 transition-all active:scale-90">
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>

                <div className="p-8 space-y-6">
                  <div className="flex gap-4">
                    <div className="w-32 space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Quantity</label>
                      <input 
                        type="number"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl text-sm font-black outline-none focus:border-blue-500 transition-all text-center"
                        value={editQty}
                        onChange={e => setEditQty(e.target.value)}
                      />
                    </div>
                    <div className="flex-1 space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Description</label>
                      <input 
                        type="text"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl text-sm font-bold outline-none focus:border-blue-500 transition-all"
                        value={editDesc}
                        onChange={e => setEditDesc(e.target.value)}
                      />
                    </div>
                  </div>

                  {selectedItem?.productionType !== 'OUTSOURCING' && (
                    <div className="space-y-2 animate-in slide-in-from-top-4 duration-500">
                      <label className="text-[10px] font-black text-slate-400 uppercase ml-1">Manufacturer ID / Part Number</label>
                      <input 
                        type="text"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl text-sm font-mono outline-none focus:border-blue-500 transition-all bg-slate-50/30"
                        value={editComponentNumber}
                        onChange={e => setEditComponentNumber(e.target.value)}
                        placeholder="CMP-..."
                      />
                    </div>
                  )}

                  {selectedItem?.productionType === 'OUTSOURCING' && (
                    <div className="space-y-6 animate-in slide-in-from-top-4 duration-500">
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-[9px] font-black text-violet-400 uppercase ml-1">Service / Contract ID</label>
                          <input
                            type="text"
                            className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-black outline-none focus:border-violet-500 transition-all bg-violet-50/20"
                            value={editContractNumber}
                            onChange={e => setEditContractNumber(e.target.value)}
                            placeholder="Contract number or service reference"
                          />
                          <div className="text-[8px] text-slate-500 uppercase tracking-[0.2em]">Auto-generated if left blank</div>
                        </div>
                        <div className="space-y-2">
                          <label className="text-[9px] font-black text-violet-400 uppercase ml-1">Contract Start Date</label>
                          <input
                            type="date"
                            className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-black outline-none focus:border-violet-500 transition-all bg-violet-50/20"
                            value={editContractStartDate}
                            onChange={e => setEditContractStartDate(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col md:flex-row gap-4">
                        <div className="w-full md:w-32 space-y-1.5">
                          <div className="flex justify-between items-center ml-1">
                            <label className="text-[9px] font-black text-violet-400 uppercase">Duration</label>
                            <div className="flex bg-violet-50 p-0.5 rounded-lg border border-violet-100 scale-90 origin-right shrink-0">
                              <button
                                onClick={() => {
                                  if (editDurationUnit === 'Years' && editDurationVal) {
                                    setEditDurationVal(Math.round(Number(editDurationVal) * 12));
                                  }
                                  setEditDurationUnit('Months');
                                }}
                                className={`px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase transition-all ${editDurationUnit === 'Months' ? 'bg-white text-violet-600 shadow-sm border border-violet-100' : 'text-slate-400 hover:text-slate-600'}`}
                              >
                                Mo
                              </button>
                              <button
                                onClick={() => {
                                  if (editDurationUnit === 'Months' && editDurationVal) {
                                    setEditDurationVal(parseFloat((Number(editDurationVal) / 12).toFixed(2)));
                                  }
                                  setEditDurationUnit('Years');
                                }}
                                className={`px-1.5 py-0.5 rounded-md text-[8px] font-black uppercase transition-all ${editDurationUnit === 'Years' ? 'bg-white text-violet-600 shadow-sm border border-violet-100' : 'text-slate-400 hover:text-slate-600'}`}
                              >
                                Yr
                              </button>
                            </div>
                          </div>
                          <input
                            type="number"
                            step={editDurationUnit === 'Months' ? "1" : "0.01"}
                            className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-black outline-none focus:border-violet-500 transition-all bg-violet-50/20 text-center"
                            value={editDurationVal}
                            onChange={e => setEditDurationVal(e.target.value)}
                          />
                        </div>
                        <div className="flex-1 space-y-1.5">
                          <label className="text-[9px] font-black text-violet-400 uppercase ml-1">Scope of Work Summary</label>
                          <textarea
                            placeholder="Detailed scope..."
                            className="w-full p-4 border-2 border-violet-50 rounded-2xl text-sm font-bold outline-none focus:border-violet-500 transition-all bg-violet-50/20 resize-none h-[58px]"
                            value={editScope}
                            onChange={e => setEditScope(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-8 bg-slate-50 border-t-2 border-slate-100 flex justify-end gap-4">
                  <button onClick={() => setEditingComp(null)} className="px-8 py-4 font-black uppercase text-[10px] tracking-widest text-slate-400 hover:text-slate-600 transition-colors">Cancel</button>
                  <button 
                    onClick={handleUpdateComponent}
                    disabled={isProcessing}
                    className="px-12 py-4 bg-blue-600 text-white rounded-[1.5rem] font-black uppercase text-[10px] tracking-[0.2em] shadow-xl shadow-blue-200 hover:bg-blue-700 active:scale-95 transition-all flex items-center gap-2"
                  >
                    {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-cloud-arrow-up"></i>}
                    Update Component
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
