
import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, ManufacturingComponent, Supplier, OrderStatus, User } from '../types';
import { isStockOrder, getOrderPoType, getPoTypeConfig } from '../utils';

interface ConfirmDialogState {
  isOpen: boolean;
  order: CustomerOrder | null;
  itemId: string;
  compId: string;
  description: string;
}

interface StockReceptionModuleProps {
  currentUser: User;
}

export const StockReceptionModule: React.FC<StockReceptionModuleProps> = ({ currentUser }) => {
  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Custom Confirmation Dialog State
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    order: null,
    itemId: '',
    compId: '',
    description: ''
  });

  const [errorToast, setErrorToast] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      const [orderData, supplierData] = await Promise.all([
        dataService.getOrders(),
        dataService.getSuppliers()
      ]);
      setAllOrders(orderData);
      setSuppliers(supplierData);
      setLoading(false);
    };
    fetchData();
  }, [refreshKey]);

  const supplierMap = useMemo(() => {
    const map = new Map<string, string>();
    suppliers.forEach(s => map.set(s.id, s.name));
    return map;
  }, [suppliers]);

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
    const q = searchQuery.toLowerCase().trim();
    if (!q) return transitComponents;

    const terms = q.split(/\s+/).filter(Boolean);

    return transitComponents.filter(r => {
      const supplierName = (supplierMap.get(r.comp.supplierId || '') || r.comp.supplierName || '').toLowerCase();
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
        orderTypeKeywords,
      ].join(' ').toLowerCase();

      return terms.every(term => searchCorpus.includes(term));
    });
  }, [transitComponents, searchQuery, supplierMap]);

  const initiateReceive = (order: CustomerOrder, item: CustomerOrderItem, comp: ManufacturingComponent) => {
    if (order.status === OrderStatus.IN_HOLD) {
      setErrorToast("Reception blocked: Order is on financial hold.");
      setTimeout(() => setErrorToast(null), 5000);
      return;
    }
    setConfirmDialog({
      isOpen: true,
      order,
      itemId: item.id,
      compId: comp.id,
      description: comp.description
    });
  };

  const handleConfirmReceive = async () => {
    const { order, itemId, compId } = confirmDialog;
    if (!order) return;

    try {
      // Fix: Pass currentUser.username as the fourth argument
      await dataService.receiveComponent(order.id, itemId, compId);
      setRefreshKey(prev => prev + 1);
      setConfirmDialog({ isOpen: false, order: null, itemId: '', compId: '', description: '' });
    } catch (e) {
      setErrorToast("Reception failed. Item may already be processed.");
      setTimeout(() => setErrorToast(null), 5000);
    }
  };

  return (
    <div className="space-y-6">
      {errorToast && (
        <div className="fixed top-4 right-4 z-[100] bg-rose-600 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right-4">
          <i className="fa-solid fa-circle-exclamation"></i>
          <span className="font-bold text-sm">{errorToast}</span>
          <button onClick={() => setErrorToast(null)} className="ml-4 opacity-50 hover:opacity-100"><i className="fa-solid fa-xmark"></i></button>
        </div>
      )}

      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Incoming Stock Reception</h2>
            <p className="text-sm text-slate-500">Warehouse dashboard for verifying and receiving incoming Purchase Orders.</p>
          </div>
          <div className="bg-blue-50 px-4 py-2 rounded-lg border border-blue-100 flex items-center gap-3">
            <i className="fa-solid fa-truck-ramp-box text-blue-600"></i>
            <span className="text-xs font-black text-blue-700 uppercase tracking-widest">
              {transitComponents.length} Expected {selectedSupplierId !== 'all' ? 'from Vendor' : 'Total'}
            </span>
          </div>
        </div>

        <div className="flex flex-col md:flex-row items-center gap-4 p-4 bg-slate-50 rounded-xl border border-slate-100">
          <div className="flex-1 w-full relative">
            <input
              type="text"
              placeholder="Search PO#, component, vendor, order type (trade/manufacturing/blanket/stock)..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 transition-all"
            />
            <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs p-1"
                title="Clear search"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-slate-400 whitespace-nowrap">
            <i className="fa-solid fa-building-shield"></i>
            <span className="text-[10px] font-black uppercase tracking-widest">Vendor Filter</span>
          </div>
          <select
            value={selectedSupplierId}
            onChange={(e) => setSelectedSupplierId(e.target.value)}
            className="w-full md:w-auto min-w-[200px] px-4 py-2.5 border rounded-xl bg-white text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 transition-all border-slate-200"
          >
            <option value="all">View All Vendors (Global)</option>
            {suppliers.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {selectedSupplierId !== 'all' && (
            <button
              onClick={() => setSelectedSupplierId('all')}
              className="px-4 py-2.5 bg-white text-xs font-bold text-red-500 hover:bg-red-50 border border-red-100 rounded-xl transition-all flex items-center gap-2 whitespace-nowrap"
            >
              <i className="fa-solid fa-circle-xmark"></i>
              Reset Filter
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-wider">
              <tr>
                <th className="px-6 py-4 text-white">Item #</th>
                <th className="px-6 py-4 text-white">PO / Ref Number</th>
                <th className="px-6 py-4 text-white">Order Type</th>
                <th className="px-6 py-4 text-white">Supplier (Click to filter)</th>
                <th className="px-6 py-4 text-white">Incoming Component</th>
                <th className="px-6 py-4 text-white">Target Order Line</th>
                <th className="px-6 py-4 text-white text-right">Warehouse Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredTransitComponents.map(({ order, item, comp }) => {
                const orderLocked = order.status === OrderStatus.IN_HOLD;
                const poType = getOrderPoType(order, item, comp);
                const cfg = getPoTypeConfig(poType);
                const isStock = isStockOrder(order) || comp.status === 'ORDERED_FOR_STOCK' || comp.source === 'STOCK';
                const displayPo = comp.poNumber || order.customerReferenceNumber || 'N/A';
                return (
                  <tr key={comp.id} className={`hover:bg-slate-50 transition-colors group ${orderLocked ? 'opacity-70 grayscale-[0.5]' : ''}`}>
                    <td className="px-6 py-4">
                      <div className="font-mono text-[10px] text-blue-600 font-black">{comp.componentNumber || '-'}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-mono text-xs font-black text-blue-600">
                        {displayPo !== 'N/A' ? `#${displayPo}` : 'N/A'}
                      </div>
                      {order.customerReferenceNumber && comp.poNumber && (
                        <div className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">Cust PO: {order.customerReferenceNumber}</div>
                      )}
                      <div className="text-[9px] font-mono font-bold text-slate-400 mt-0.5">Ref: {order.internalOrderNumber}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${cfg.badgeClass} border rounded-lg text-[10px] font-black uppercase tracking-wider whitespace-nowrap`}>
                        <i className={`fa-solid ${cfg.icon} text-[9px]`}></i>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => comp.supplierId && setSelectedSupplierId(comp.supplierId)}
                        className={`text-left group/supp font-bold flex flex-col transition-all ${comp.supplierId ? 'hover:text-blue-600' : 'cursor-default'}`}
                        title={comp.supplierId ? "View all pending items from this supplier" : ""}
                      >
                        <div className="flex items-center gap-2">
                          <i className={`fa-solid fa-industry ${comp.supplierId ? 'text-blue-400 group-hover/supp:text-blue-600' : 'text-slate-300'} text-[10px]`}></i>
                          <span className={comp.supplierId ? 'underline decoration-dotted decoration-blue-200 underline-offset-4 group-hover/supp:decoration-blue-600' : ''}>
                            {comp.supplierId ? (supplierMap.get(comp.supplierId) || 'Unknown Vendor') : 'Unassigned'}
                          </span>
                        </div>
                        <div className="text-[9px] text-slate-400 font-bold uppercase mt-0.5 group-hover/supp:text-blue-400">
                          {comp.supplierId ? 'Quick Filter by Vendor' : 'No Supplier Assigned'}
                        </div>
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-black text-slate-800">{comp.description}</div>
                      <div className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Quantity Expected: {comp.quantity} {comp.unit}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs font-bold text-slate-600 flex items-center gap-2">
                        {orderLocked && <i className="fa-solid fa-lock text-amber-600 text-[10px]"></i>}
                        {isStock ? (
                          <span className="text-amber-600">Internal Stock</span>
                        ) : (
                          <>{order.customerName}</>
                        )}
                      </div>
                      <div className="text-[10px] font-mono font-black text-blue-500">{item.orderNumber}</div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        disabled={orderLocked}
                        onClick={() => initiateReceive(order, item, comp)}
                        className="px-4 py-2 bg-green-600 text-white font-black text-xs uppercase rounded-lg hover:bg-green-700 shadow-lg shadow-green-100 flex items-center gap-2 ml-auto transition-all active:scale-95 disabled:opacity-50 whitespace-nowrap"
                      >
                        {orderLocked ? (
                          <><i className="fa-solid fa-lock"></i> Order on Hold</>
                        ) : isStock ? (
                          <><i className="fa-solid fa-box-open"></i> Receive to Stock</>
                        ) : (
                          <><i className="fa-solid fa-check-double"></i> Receive & Reserve</>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filteredTransitComponents.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-6 py-24 text-center text-slate-300">
                    <i className="fa-solid fa-clipboard-check text-4xl mb-4 opacity-20 block"></i>
                    <div className="font-bold">{searchQuery ? "No matching items found." : "No items currently in transit"}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Custom Confirmation Modal */}
      {confirmDialog.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-md p-8 animate-in zoom-in-95 duration-200 border border-slate-100">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl">
                <i className="fa-solid fa-truck-ramp-box"></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800">Confirm Receipt</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Warehouse Audit Control</p>
              </div>
            </div>

            {confirmDialog.order && (
              <div className="flex items-center justify-between gap-3 p-3.5 bg-slate-50 rounded-2xl border border-slate-100 mb-4">
                <div>
                  <div className="text-[8px] font-black uppercase text-slate-400">PO Number</div>
                  <div className="font-mono text-xs font-black text-blue-600">
                    {confirmDialog.order.customerReferenceNumber ? `#${confirmDialog.order.customerReferenceNumber}` : 'N/A'}
                  </div>
                  {confirmDialog.order.internalOrderNumber && (
                    <div className="text-[8px] font-mono text-slate-400 mt-0.5">Ref: {confirmDialog.order.internalOrderNumber}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[8px] font-black uppercase text-slate-400">Order Type</div>
                  {(() => {
                    const itm = confirmDialog.order?.items?.find(i => i.id === confirmDialog.itemId);
                    const poType = getOrderPoType(confirmDialog.order, itm);
                    const cfg = getPoTypeConfig(poType);
                    return (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 ${cfg.badgeClass} border rounded text-[9px] font-black uppercase`}>
                        <i className={`fa-solid ${cfg.icon} text-[8px]`}></i>
                        {cfg.label}
                      </span>
                    );
                  })()}
                </div>
              </div>
            )}

            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 mb-8">
              <p className="text-sm text-slate-600 leading-relaxed">
                Are you sure you want to confirm physical receipt of <span className="font-bold text-slate-900">"{confirmDialog.description}"</span>?
                <br /><br />
                This will officially reserve the component for its assigned customer order line in the system.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDialog({ isOpen: false, order: null, itemId: '', compId: '', description: '' })}
                className="flex-1 py-3 bg-slate-100 text-slate-600 font-black rounded-xl hover:bg-slate-200 transition-all uppercase text-[10px] tracking-widest"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReceive}
                className="flex-[2] py-3 bg-emerald-600 text-white font-black rounded-xl hover:bg-emerald-700 shadow-lg shadow-emerald-100 transition-all uppercase text-[10px] tracking-widest flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-check"></i>
                Confirm Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};