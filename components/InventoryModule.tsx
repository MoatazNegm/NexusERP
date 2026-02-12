
import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { InventoryItem, CustomerOrder, Supplier, OrderStatus, CustomerOrderItem, ManufacturingComponent, AppConfig, User } from '../types';

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
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 mt-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-hourglass'}`}></i>
      {isOver ? `Overdue by ${timeStr}` : `SLA: ${timeStr} left`}
    </div>
  );
};

export const InventoryModule: React.FC<InventoryModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [activeTab, setActiveTab] = useState<InventoryTab>('inventory');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });

  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('all');
  const [processingId, setProcessingId] = useState<string | null>(null);

  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [receivedQtyInput, setReceivedQtyInput] = useState<string>('');

  useEffect(() => {
    loadData();
  }, [refreshKey, activeTab]);

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

  const transitComponents = useMemo(() => {
    const list: { order: CustomerOrder, item: CustomerOrderItem, comp: ManufacturingComponent }[] = [];
    allOrders.forEach(order => {
        order.items.forEach(item => {
            item.components?.forEach(comp => {
                if (comp.status === 'ORDERED') {
                    if (selectedSupplierId === 'all' || comp.supplierId === selectedSupplierId) {
                        list.push({ order, item, comp });
                    }
                }
            });
        });
    });
    return list;
  }, [allOrders, selectedSupplierId]);

  const finishedGoodsAwaitingHub = useMemo(() => {
    return allOrders.filter(o => o.status === OrderStatus.MANUFACTURING_COMPLETED);
  }, [allOrders]);

  const invoicedAwaitingDispatch = useMemo(() => {
    return allOrders.filter(o => o.status === OrderStatus.INVOICED);
  }, [allOrders]);

  const recentDispatches = useMemo(() => {
    return allOrders.filter(o => [OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.FULFILLED].includes(o.status))
                   .sort((a, b) => b.dataEntryTimestamp.localeCompare(a.dataEntryTimestamp))
                   .slice(0, 10);
  }, [allOrders]);

  const goodsInHubReadyForInvoice = useMemo(() => {
    return allOrders.filter(o => o.status === OrderStatus.IN_PRODUCT_HUB);
  }, [allOrders]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    await dataService.addInventoryItem(newItem);
    await loadData();
    setIsAdding(false);
    setNewItem({ sku: '', description: '', quantityInStock: 0, unit: 'pcs', lastCost: 0, category: 'Mechanical' });
  };

  const executeMaterialReception = async () => {
    if (!pendingConfirm || !pendingConfirm.comp || !pendingConfirm.item) return;
    const { order, item, comp } = pendingConfirm;
    
    if (parseFloat(receivedQtyInput) !== comp.quantity) {
      return;
    }

    setProcessingId(comp.id);
    try {
        await dataService.receiveComponent(order.id, item.id, comp.id, currentUser.username);
        await loadData();
        setPendingConfirm(null);
        setReceivedQtyInput('');
    } catch (e) {
        alert("Reception failed.");
    } finally {
        setProcessingId(null);
    }
  };

  const executeHubReception = async (orderId: string) => {
    setProcessingId(orderId);
    try {
      await dataService.receiveAtProductHub(orderId, currentUser.username);
      await loadData();
    } catch (e: any) {
      alert(e.message || "Failed to receive PO at Hub.");
    } finally {
      setProcessingId(null);
    }
  };

  const executeDispatchRelease = async (orderId: string) => {
    setProcessingId(orderId);
    try {
      await dataService.releaseForDelivery(orderId, currentUser.username);
      await loadData();
    } catch (e: any) {
      alert(e.message || "Dispatch authorization failed.");
    } finally {
      setProcessingId(null);
    }
  };

  const isConfirmationAllowed = useMemo(() => {
    if (!pendingConfirm) return false;
    if (pendingConfirm.type !== 'material') return true;
    return parseFloat(receivedQtyInput) === (pendingConfirm.comp?.quantity || 0);
  }, [pendingConfirm, receivedQtyInput]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1 p-1 bg-slate-200 rounded-2xl w-fit">
        {(['inventory', 'reception', 'hub', 'dispatch'] as const).map(tab => (
          <button 
            key={tab} 
            onClick={() => setActiveTab(tab)}
            className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {tab === 'reception' && transitComponents.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-rose-500 text-white rounded-full">{transitComponents.length}</span>}
            {tab === 'hub' && finishedGoodsAwaitingHub.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-amber-500 text-white rounded-full">{finishedGoodsAwaitingHub.length}</span>}
            {tab === 'dispatch' && invoicedAwaitingDispatch.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-sky-500 text-white rounded-full animate-bounce">{invoicedAwaitingDispatch.length}</span>}
            {tab.replace(/([A-Z])/g, ' $1')}
          </button>
        ))}
      </div>

      {activeTab === 'inventory' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex justify-between items-center">
            <div><h3 className="text-xl font-black text-slate-800">Physical Stock</h3></div>
            <button onClick={() => setIsAdding(!isAdding)} className="px-6 py-3 bg-slate-900 text-white rounded-xl font-black text-[10px] uppercase shadow-lg hover:bg-black transition-all">Add Item</button>
          </div>
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b">
              <tr>
                <th className="px-8 py-4">SKU / Description</th>
                <th className="px-8 py-4">In Stock</th>
                <th className="px-8 py-4">Reserved</th>
                <th className="px-8 py-4">Available</th>
                <th className="px-8 py-4 text-right">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-8 py-6">
                    <div className="font-mono text-[10px] font-black text-blue-600">{item.sku}</div>
                    <div className="font-bold text-slate-800">{item.description}</div>
                  </td>
                  <td className="px-8 py-6 font-bold">{item.quantityInStock} {item.unit}</td>
                  <td className="px-8 py-6 text-amber-600 font-bold">{item.quantityReserved || 0}</td>
                  <td className="px-8 py-6 font-black text-blue-600">{item.quantityInStock - (item.quantityReserved || 0)}</td>
                  <td className="px-8 py-6 text-right font-black text-slate-900">{(item.quantityInStock * item.lastCost).toLocaleString()} L.E.</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'reception' && (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div>
              <h3 className="text-xl font-black text-slate-800">Warehouse Materials Intake</h3>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Pending physical arrival of components</p>
            </div>
            <select 
              value={selectedSupplierId} 
              onChange={e => setSelectedSupplierId(e.target.value)}
              className="px-4 py-2 bg-white border rounded-xl text-[10px] font-black uppercase tracking-widest outline-none focus:ring-4 focus:ring-blue-50"
            >
              <option value="all">Global (All Vendors)</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <table className="w-full text-left">
            <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest">
              <tr>
                <th className="px-8 py-4 text-white">Vendor</th>
                <th className="px-8 py-4 text-white">Component Descriptor</th>
                <th className="px-8 py-4 text-white text-center">Expected Qty</th>
                <th className="px-8 py-4 text-white text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {transitComponents.map(({ order, item, comp }) => (
                <tr key={comp.id} className={`hover:bg-slate-50 transition-colors ${order.status === OrderStatus.IN_HOLD ? 'opacity-50 grayscale' : ''}`}>
                  <td className="px-8 py-6">
                    <div className="font-black text-slate-800 text-xs">{suppliers.find(s => s.id === comp.supplierId)?.name || 'N/A'}</div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase mt-1">Ref: {order.internalOrderNumber}</div>
                  </td>
                  <td className="px-8 py-6 font-bold text-slate-700 text-xs">{comp.description}</td>
                  <td className="px-8 py-6 text-center font-black text-slate-900 text-xs">{comp.quantity} <span className="text-slate-400 font-bold">{comp.unit}</span></td>
                  <td className="px-8 py-6 text-right">
                    <button 
                      onClick={() => { setPendingConfirm({ type: 'material', order, item, comp }); setReceivedQtyInput(''); }}
                      className="px-6 py-3 bg-emerald-600 text-white font-black text-[10px] uppercase rounded-xl shadow-lg hover:bg-emerald-700 transition-all"
                    >
                      Process Reception
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'hub' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
               <div>
                  <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Product Hub Intake</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Finished Goods Awaiting Hub Logging</p>
               </div>
               <div className="px-4 py-2 bg-amber-50 text-amber-600 border border-amber-100 rounded-xl text-[10px] font-black uppercase tracking-tighter">
                  {finishedGoodsAwaitingHub.length} Orders Finished in Factory
               </div>
            </div>
            <table className="w-full text-left">
               <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                  <tr>
                    <th className="px-8 py-4 text-white">Reference ID</th>
                    <th className="px-8 py-4 text-white">Customer Account</th>
                    <th className="px-8 py-4 text-white">Logistics SLA</th>
                    <th className="px-8 py-4 text-white text-right">Action</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50">
                  {finishedGoodsAwaitingHub.map(order => (
                    <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                       <td className="px-8 py-6 font-mono text-xs font-black text-blue-600">{order.internalOrderNumber}</td>
                       <td className="px-8 py-6 font-black text-slate-800">{order.customerName}</td>
                       <td className="px-8 py-6">
                          <ThresholdTimer order={order} limitHrs={config.settings.transitToHubLimitHrs} />
                       </td>
                       <td className="px-8 py-6 text-right">
                          <button 
                            disabled={processingId === order.id}
                            onClick={() => executeHubReception(order.id)}
                            className="px-6 py-3 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 ml-auto shadow-lg shadow-blue-100"
                          >
                             {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-warehouse"></i>}
                             Confirm Hub Intake
                          </button>
                       </td>
                    </tr>
                  ))}
                  {finishedGoodsAwaitingHub.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-8 py-16 text-center text-slate-300 italic text-xs font-black uppercase tracking-widest">No pending intake from plant.</td>
                    </tr>
                  )}
               </tbody>
            </table>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-80">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
               <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">Staged Assets (Awaiting Invoicing)</h3>
            </div>
            <table className="w-full text-left">
               <tbody className="divide-y divide-slate-50">
                  {goodsInHubReadyForInvoice.map(order => (
                    <tr key={order.id} className="hover:bg-slate-50 transition-colors">
                       <td className="px-8 py-4 font-mono text-[10px] font-black text-slate-400">{order.internalOrderNumber}</td>
                       <td className="px-8 py-4 font-bold text-slate-500 text-xs">{order.customerName}</td>
                       <td className="px-8 py-4 text-right">
                          <span className="px-3 py-1 bg-slate-100 text-slate-400 text-[8px] font-black uppercase rounded border">Ready for Finance</span>
                       </td>
                    </tr>
                  ))}
                  {goodsInHubReadyForInvoice.length === 0 && (
                    <tr>
                       <td colSpan={3} className="px-8 py-8 text-center text-slate-200 italic text-[10px] font-black uppercase">Hub storage currently empty.</td>
                    </tr>
                  )}
               </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'dispatch' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
               <div>
                  <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Final Dispatch & Logistics</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Invoiced Orders Ready for Delivery Authorization</p>
               </div>
               <div className="px-4 py-2 bg-sky-50 text-sky-600 border border-sky-100 rounded-xl text-[10px] font-black uppercase tracking-tighter animate-pulse">
                  {invoicedAwaitingDispatch.length} Awaiting Dispatch
               </div>
            </div>
            <table className="w-full text-left">
               <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                  <tr>
                    <th className="px-8 py-4 text-white">Tracking Context</th>
                    <th className="px-8 py-4 text-white">Invoice Identification</th>
                    <th className="px-8 py-4 text-white">Dispatch SLA</th>
                    <th className="px-8 py-4 text-white text-right">Action Authorization</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50">
                  {invoicedAwaitingDispatch.map(order => (
                    <tr key={order.id} className="hover:bg-sky-50/40 transition-colors group">
                       <td className="px-8 py-6">
                          <div className="font-black text-slate-800 text-sm">{order.customerName}</div>
                          <div className="font-mono text-[10px] text-blue-600 font-bold uppercase mt-1 tracking-widest">{order.internalOrderNumber}</div>
                       </td>
                       <td className="px-8 py-6">
                          <div className="inline-flex flex-col gap-1.5">
                             <span className="px-2.5 py-1 bg-emerald-50 text-emerald-700 text-[9px] font-black uppercase rounded border border-emerald-100 flex items-center gap-2">
                               <i className="fa-solid fa-file-invoice-dollar"></i>
                               Tax Invoice: {order.invoiceNumber}
                             </span>
                             <div className="text-[8px] font-black text-rose-500 uppercase flex items-center gap-1.5 animate-pulse">
                               <i className="fa-solid fa-triangle-exclamation"></i>
                               Dispatch goods with physical invoice
                             </div>
                          </div>
                       </td>
                       <td className="px-8 py-6">
                          <ThresholdTimer order={order} limitHrs={config.settings.hubReleasedLimitHrs} />
                       </td>
                       <td className="px-8 py-6 text-right">
                          <div className="flex flex-col items-end gap-2">
                             <button 
                               disabled={processingId === order.id}
                               onClick={() => executeDispatchRelease(order.id)}
                               className="px-6 py-3 bg-slate-900 text-white font-black text-[10px] uppercase rounded-xl hover:bg-black transition-all flex items-center gap-2 shadow-lg shadow-slate-200"
                             >
                                {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-truck-ramp-box"></i>}
                                Authorize Dispatch & Release
                             </button>
                             <p className="text-[8px] text-slate-400 font-bold uppercase pr-1 italic opacity-0 group-hover:opacity-100 transition-opacity">Attach physical Tax Invoice to manifest</p>
                          </div>
                       </td>
                    </tr>
                  ))}
                  {invoicedAwaitingDispatch.length === 0 && (
                    <tr>
                       <td colSpan={4} className="px-8 py-20 text-center">
                          <div className="flex flex-col items-center gap-4 text-slate-300">
                             <i className="fa-solid fa-truck-fast text-5xl opacity-10"></i>
                             <p className="text-xs font-black uppercase tracking-[0.3em]">Logistics Pipeline Clear</p>
                          </div>
                       </td>
                    </tr>
                  )}
               </tbody>
            </table>
          </div>

          {recentDispatches.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden opacity-60">
              <div className="p-8 border-b border-slate-100 bg-slate-50/50">
                 <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Recent Logistics Departures</h3>
              </div>
              <table className="w-full text-left">
                 <tbody className="divide-y divide-slate-50 text-sm">
                    {recentDispatches.map(order => (
                      <tr key={order.id}>
                         <td className="px-8 py-4 font-mono text-[10px] text-slate-400">{order.internalOrderNumber}</td>
                         <td className="px-8 py-4 font-bold text-slate-500 text-xs">{order.customerName}</td>
                         <td className="px-8 py-4 text-right">
                            <span className="px-3 py-1 bg-slate-50 text-slate-400 text-[8px] font-black uppercase rounded border">Released to Logistics</span>
                         </td>
                      </tr>
                    ))}
                 </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {pendingConfirm && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-8 animate-in zoom-in-95">
            <div className="flex items-center gap-4 mb-6">
               <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl shadow-inner"><i className="fa-solid fa-truck-ramp-box"></i></div>
               <div><h3 className="text-xl font-black text-slate-800">Verification Gate</h3><p className="text-[10px] font-black text-slate-400 uppercase">Input exact received quantity</p></div>
            </div>
            <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 mb-8 space-y-6">
              <div className="text-center">
                 <div className="text-[10px] font-black text-slate-400 uppercase mb-2">Expected Quantity</div>
                 <div className="text-3xl font-black text-slate-800">{pendingConfirm.comp?.quantity} <span className="text-sm font-bold text-slate-400">{pendingConfirm.comp?.unit}</span></div>
              </div>
              <div className="space-y-1">
                 <label className="text-[9px] font-black text-blue-600 uppercase ml-1">Physical Count Input</label>
                 <input 
                   type="number" step="any" autoFocus
                   className="w-full p-4 border-2 border-white bg-white rounded-2xl text-center text-2xl font-black focus:border-blue-500 outline-none shadow-sm"
                   placeholder="0.00" value={receivedQtyInput} onChange={e => setReceivedQtyInput(e.target.value)}
                 />
                 {receivedQtyInput && parseFloat(receivedQtyInput) !== pendingConfirm.comp?.quantity && (
                    <div className="text-[9px] font-black text-rose-500 uppercase mt-2 text-center flex items-center justify-center gap-2 animate-pulse"><i className="fa-solid fa-triangle-exclamation"></i> Mismatch Detected</div>
                 )}
              </div>
            </div>
            <div className="flex gap-2">
               <button onClick={() => setPendingConfirm(null)} className="flex-1 py-4 bg-slate-100 text-slate-400 font-black rounded-2xl text-[10px] uppercase">Cancel</button>
               <button 
                onClick={executeMaterialReception} disabled={!isConfirmationAllowed}
                className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all ${isConfirmationAllowed ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale'}`}
               >Confirm Receipt</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
