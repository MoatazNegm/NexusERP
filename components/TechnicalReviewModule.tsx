
import React, { useState, useMemo, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, InventoryItem, ManufacturingComponent, OrderStatus, Supplier, SupplierPart, AppConfig, CompStatus, User } from '../types';

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
  const [compQty, setCompQty] = useState(1);
  const [showCompSuggestions, setShowCompSuggestions] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Rollback state
  const [rollbackReason, setRollbackReason] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async () => {
    const [o, i, s] = await Promise.all([
      dataService.getOrders(),
      dataService.getInventory(),
      dataService.getSuppliers()
    ]);
    setOrders(o);
    setInventory(i);
    setSuppliers(s);

    if (selectedOrder) {
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
    return filtered.sort((a, b) => (a.orderDate || a.dataEntryTimestamp || '').localeCompare(b.orderDate || b.dataEntryTimestamp || ''));
  }, [searchQuery, orders]);

  const invResults = useMemo(() => {
    const q = compSearch.toLowerCase();
    if (!q) return [];
    return inventory.filter(i => (i.description || '').toLowerCase().includes(q) || (i.sku || '').toLowerCase().includes(q));
  }, [compSearch, inventory]);

  const supplierResults = useMemo(() => {
    const q = compSearch.toLowerCase();
    if (!q) return [];
    const results: { supplier: Supplier, part: SupplierPart }[] = [];
    suppliers.forEach(supp => {
      supp.priceList.forEach(part => {
        if ((part.description || '').toLowerCase().includes(q) || (part.partNumber || '').toLowerCase().includes(q)) {
          results.push({ supplier: supp, part });
        }
      });
    });
    return results;
  }, [compSearch, suppliers]);

  const handleAddComponent = async (inv: InventoryItem) => {
    if (!selectedOrder || !selectedItem) return;
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
    setCompSearch('');
    setShowCompSuggestions(false);
    fetchData();
  };

  const handleAddSupplierPart = async (supp: Supplier, part: SupplierPart) => {
    if (!selectedOrder || !selectedItem) return;
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: part.description,
      quantity: compQty,
      unit: 'pcs',
      unitCost: part.price,
      taxPercent: 14,
      source: 'PROCUREMENT',
      supplierId: supp.id,
      supplierPartId: part.id,
      status: 'PENDING_OFFER'
    });
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setCompSearch('');
    setShowCompSuggestions(false);
    fetchData();
  };

  const handleAddCustomProcurement = async () => {
    if (!selectedOrder || !selectedItem || !compSearch.trim()) return;
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: compSearch,
      quantity: compQty,
      unit: 'pcs',
      unitCost: 0,
      taxPercent: 14,
      source: 'PROCUREMENT',
      status: 'PENDING_OFFER'
    });
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setCompSearch('');
    setShowCompSuggestions(false);
    fetchData();
  };

  const handleToggleAcceptance = async (item: CustomerOrderItem) => {
    if (!selectedOrder) return;
    setIsProcessing(true);
    const updated = await dataService.toggleItemAcceptance(selectedOrder.id, item.id);
    setSelectedOrder(updated);
    if (selectedItem?.id === item.id) {
      setSelectedItem(updated.items.find(i => i.id === item.id)!);
    }
    fetchData();
    setIsProcessing(false);
  };

  const handleFinalizeReview = async () => {
    if (!selectedOrder) return;
    setIsProcessing(true);
    try {
      await dataService.finalizeTechnicalReview(selectedOrder.id);
      setSelectedOrder(null);
      setSelectedItem(null);
      fetchData();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsProcessing(false);
    }
  };

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
              <th className="px-8 py-5">PO Identifier</th>
              <th className="px-8 py-5">Customer Entity</th>
              <th className="px-8 py-5">Line Count</th>
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
                    <div className="font-black text-slate-800 text-sm tracking-tight">{o.customerName}</div>
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
                  onClick={() => setRollbackReason('')}
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

                    {!selectedItem.isAccepted && (
                      <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-xl space-y-6">
                        <div className="flex justify-between items-center border-b border-slate-100 pb-4">
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Add Components / Services</h4>
                          <div className="text-[10px] font-bold text-blue-600 uppercase tracking-tight"><i className="fa-solid fa-brain-circuit mr-1"></i> Sourcing Engine Active</div>
                        </div>
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
                          <div className="flex-1 relative space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase ml-1">Search Sourcing Catalogs (Stock or Market)</label>
                            <div className="relative">
                              <input
                                type="text"
                                placeholder="Enter component SKU, Name or Vendor Part ID..."
                                className="w-full p-4 pl-12 border-2 border-slate-100 rounded-2xl text-sm font-bold outline-none focus:border-blue-500 transition-all"
                                value={compSearch}
                                onChange={e => { setCompSearch(e.target.value); setShowCompSuggestions(true); }}
                                onFocus={() => setShowCompSuggestions(true)}
                              />
                              <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"></i>

                              {showCompSuggestions && compSearch.length > 0 && (
                                <div className="absolute top-full left-0 right-0 mt-3 bg-white border border-slate-200 rounded-[2rem] shadow-2xl z-[110] overflow-hidden divide-y divide-slate-50 max-h-80 overflow-y-auto animate-in slide-in-from-top-2 duration-300">
                                  {invResults.map(i => (
                                    <button key={i.id} onMouseDown={() => handleAddComponent(i)} className="w-full text-left p-5 hover:bg-blue-50 flex justify-between items-center group transition-colors">
                                      <div>
                                        <div className="font-black text-slate-800 group-hover:text-blue-600 text-xs">{i.description}</div>
                                        <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase flex gap-4">
                                          <span>SKU: {i.sku}</span>
                                          <span className="text-emerald-600 font-black">Stock: {i.quantityInStock - (i.quantityReserved || 0)}</span>
                                        </div>
                                      </div>
                                      <span className="text-[8px] font-black uppercase px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">In-Stock Catalog</span>
                                    </button>
                                  ))}
                                  {supplierResults.map(({ supplier, part }) => (
                                    <button key={part.id} onMouseDown={() => handleAddSupplierPart(supplier, part)} className="w-full text-left p-5 hover:bg-amber-50 flex justify-between items-center group transition-colors">
                                      <div>
                                        <div className="font-black text-slate-800 group-hover:text-amber-700 text-xs">{part.description}</div>
                                        <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase flex gap-4">
                                          <span>Vendor: {supplier.name}</span>
                                          <span className="text-amber-600 font-black">L.E. {part.price}</span>
                                        </div>
                                      </div>
                                      <span className="text-[8px] font-black uppercase px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">Procurement Market</span>
                                    </button>
                                  ))}
                                  <button
                                    onMouseDown={handleAddCustomProcurement}
                                    className="w-full text-left p-5 bg-slate-900 hover:bg-black text-white flex justify-between items-center transition-all"
                                  >
                                    <div>
                                      <div className="font-black text-xs">Request custom component: "{compSearch}"</div>
                                      <div className="text-[10px] font-bold text-slate-400 mt-1 uppercase">Initialize new sourcing workflow</div>
                                    </div>
                                    <i className="fa-solid fa-plus-circle text-blue-400 text-xl"></i>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
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
                                <div className="font-black text-slate-800 text-xs">{c.description}</div>
                                <div className="font-mono text-[9px] text-blue-500 mt-0.5">{c.componentNumber}</div>
                              </td>
                              <td className="px-6 py-4">
                                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${c.source === 'STOCK' ? 'bg-blue-50 text-blue-600 border-blue-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>{c.source}</span>
                              </td>
                              <td className="px-6 py-4 text-center font-bold text-slate-700">{c.quantity} <span className="text-[10px] text-slate-400 font-normal">{c.unit}</span></td>
                              <td className="px-6 py-4 text-right font-black text-slate-500">{c.unitCost.toLocaleString()}</td>
                              <td className="px-6 py-4 text-right font-black text-slate-900">{(c.quantity * c.unitCost).toLocaleString()}</td>
                              <td className="px-6 py-4 text-right">
                                <button
                                  onClick={() => dataService.removeComponent(selectedOrder.id, selectedItem.id, c.id).then(o => { setSelectedOrder(o); setSelectedItem(o.items.find(it => it.id === selectedItem.id)!); })}
                                  className="p-2 text-slate-300 hover:text-rose-500 transition-colors"
                                >
                                  <i className="fa-solid fa-trash-can"></i>
                                </button>
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
    </div>
  );
};
