
import React, { useState, useMemo, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, InventoryItem, ManufacturingComponent, Supplier, SupplierPart, User, AppConfig } from '../types';

interface StudyingModuleProps {
  currentUser: User;
  config: AppConfig;
}

export const StudyingModule: React.FC<StudyingModuleProps> = ({ currentUser, config }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null);
  const [selectedItem, setSelectedItem] = useState<CustomerOrderItem | null>(null);
  const [invSearch, setInvSearch] = useState('');
  const [compQty, setCompQty] = useState(1);
  
  const [showOrderSuggestions, setShowOrderSuggestions] = useState(false);
  const [showInvSuggestions, setShowInvSuggestions] = useState(false);

  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      const [orderData, invData, suppData] = await Promise.all([
        dataService.getOrders(),
        dataService.getInventory(),
        dataService.getSuppliers()
      ]);
      setAllOrders(orderData);
      setInventory(invData);
      setSuppliers(suppData);
    };
    fetchData();
  }, [selectedOrder]);

  const filteredOrders = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return allOrders.filter(o => o.customerName.toLowerCase().includes(q) || o.internalOrderNumber.toLowerCase().includes(q));
  }, [searchQuery, allOrders]);

  const invResults = useMemo(() => {
    const q = invSearch.toLowerCase();
    return inventory.filter(i => i.description.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
  }, [invSearch, inventory]);

  const supplierResults = useMemo(() => {
    const q = invSearch.toLowerCase();
    const results: { supplier: Supplier, part: SupplierPart }[] = [];
    suppliers.forEach(supp => {
      supp.priceList.forEach(part => {
        if (part.description.toLowerCase().includes(q) || part.partNumber.toLowerCase().includes(q)) {
          results.push({ supplier: supp, part });
        }
      });
    });
    return results;
  }, [invSearch, suppliers]);

  const handleAddComponent = async (inv: InventoryItem) => {
    if (!selectedOrder || !selectedItem) return;
    
    const available = inv.quantityInStock - (inv.quantityReserved || 0);
    if (compQty > available) {
      alert(`Insufficient available stock! Physical: ${inv.quantityInStock}, Reserved: ${inv.quantityReserved || 0}, Requested: ${compQty}.`);
      return;
    }

    // Fix: Pass minMarginPct as the fourth and currentUser.username as the fifth argument
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: inv.description,
      quantity: compQty,
      unit: inv.unit,
      unitCost: inv.lastCost,
      taxPercent: 14,
      source: 'STOCK',
      inventoryItemId: inv.id,
      status: 'RESERVED'
    }, config.settings.minimumMarginPct, currentUser.username);
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setInvSearch('');
    setShowInvSuggestions(false);
  };

  const handleAddSupplierPart = async (supp: Supplier, part: SupplierPart) => {
    if (!selectedOrder || !selectedItem) return;
    // Fix: Pass minMarginPct as the fourth and currentUser.username as the fifth argument
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: part.description,
      quantity: compQty,
      unit: 'pcs',
      unitCost: part.price,
      taxPercent: 14,
      source: 'PROCUREMENT',
      supplierId: supp.id,
      supplierPartId: part.id,
      status: 'ORDERED'
    }, config.settings.minimumMarginPct, currentUser.username);
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setInvSearch('');
    setShowInvSuggestions(false);
  };

  const handleAddProcurementComp = async () => {
    if (!selectedOrder || !selectedItem || !invSearch) return;
    // Fix: Pass minMarginPct as the fourth and currentUser.username as the fifth argument
    const updated = await dataService.addComponentToItem(selectedOrder.id, selectedItem.id, {
      description: invSearch,
      quantity: compQty,
      unit: 'pcs',
      unitCost: 0,
      taxPercent: 14,
      source: 'PROCUREMENT',
      status: 'PENDING_OFFER'
    }, config.settings.minimumMarginPct, currentUser.username);
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
    setInvSearch('');
    setShowInvSuggestions(false);
  };

  const removeComp = async (cid: string) => {
    if (!selectedOrder || !selectedItem) return;
    // Fix: Pass minMarginPct as the fourth and currentUser.username as the fifth argument
    const updated = await dataService.removeComponent(selectedOrder.id, selectedItem.id, cid, config.settings.minimumMarginPct, currentUser.username);
    setSelectedOrder(updated);
    setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
  };

  const totalCost = useMemo(() => {
    return selectedItem?.components?.reduce((sum, c) => sum + (c.quantity * c.unitCost), 0) || 0;
  }, [selectedItem]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 space-y-4">
        <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm relative">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <i className="fa-solid fa-magnifying-glass text-blue-600"></i>
            Select Order for Study
          </h2>
          <div className="relative">
            <input
              type="text"
              onFocus={() => setShowOrderSuggestions(true)}
              onBlur={() => setTimeout(() => setShowOrderSuggestions(false), 200)}
              className="w-full pl-10 pr-4 py-2 border rounded-lg bg-white outline-none focus:ring-2 focus:ring-blue-100 transition-all"
              placeholder="Search ID or Customer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <i className="fa-solid fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
          </div>
          
          {showOrderSuggestions && (
            <div className="absolute top-[calc(100%-1rem)] left-6 right-6 z-20 bg-white border border-slate-200 rounded-xl shadow-2xl mt-2 overflow-hidden animate-in fade-in slide-in-from-top-1">
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                {filteredOrders.length > 0 ? (
                  filteredOrders.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onMouseDown={() => { setSelectedOrder(o); setSelectedItem(null); setShowOrderSuggestions(false); }}
                      className="w-full text-left p-3 hover:bg-blue-50 transition-colors flex justify-between items-center group"
                    >
                      <div className="overflow-hidden">
                        <div className="font-bold text-xs truncate group-hover:text-blue-700">{o.customerName}</div>
                        <div className="text-[10px] text-slate-400 font-mono italic">Ref: {o.customerReferenceNumber}</div>
                      </div>
                      <span className="text-[10px] font-black text-blue-500">{o.internalOrderNumber}</span>
                    </button>
                  ))
                ) : (
                  <div className="p-4 text-center text-xs text-slate-400 italic">No orders found.</div>
                )}
              </div>
            </div>
          )}
        </div>

        {selectedOrder && (
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm animate-in fade-in slide-in-from-left-2">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Line Items to Study</h3>
            <div className="space-y-2">
              {selectedOrder.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={`w-full text-left p-4 rounded-xl border transition-all flex flex-col gap-1 ${selectedItem?.id === item.id ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-slate-100 bg-slate-50 hover:border-slate-300'}`}
                >
                  <div className="text-[10px] font-mono text-blue-600 font-bold">{item.orderNumber}</div>
                  <div className="font-bold text-slate-800 text-sm leading-tight">{item.description}</div>
                  <div className="flex justify-between items-center mt-2">
                    <span className="text-[10px] font-bold text-slate-400 uppercase">{item.quantity} {item.unit}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter ${item.isAccepted ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'}`}>
                      {item.isAccepted ? 'STUDY COMPLETE' : 'PENDING'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="lg:col-span-2">
        {!selectedItem ? (
          <div className="h-full flex flex-col items-center justify-center p-20 bg-white rounded-2xl border-2 border-dashed border-slate-200 text-slate-400">
             <i className="fa-solid fa-microscope text-5xl mb-6 opacity-20"></i>
             <p className="font-medium">Select a line item to begin technical study and BoM creation.</p>
          </div>
        ) : (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
            <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
              <div className="flex justify-between items-start mb-8">
                <div>
                  <h2 className="text-2xl font-bold text-slate-800">{selectedItem.description}</h2>
                  <div className="text-sm text-slate-500 mt-1">
                    Bill of Materials (BoM) Study
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold text-slate-400 uppercase mb-1">Total Internal Manufacturing Cost</div>
                  <div className="text-3xl font-black text-slate-900">{totalCost.toLocaleString()} <span className="text-sm text-slate-400">L.E.</span></div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50 p-6 rounded-2xl border border-slate-100">
                  <div className="md:col-span-2 space-y-2">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Global Sourcing Engine</label>
                    <div className="flex gap-2">
                       <input 
                         type="number" 
                         className="w-16 px-3 py-2 border rounded-lg text-sm font-bold shadow-sm bg-white text-slate-900"
                         value={compQty}
                         onChange={e => setCompQty(parseInt(e.target.value) || 1)}
                       />
                       <div className="flex-1 relative">
                          <input
                            type="text"
                            onFocus={() => setShowInvSuggestions(true)}
                            onBlur={() => setTimeout(() => setShowInvSuggestions(false), 200)}
                            className="w-full px-4 py-2 border-2 border-blue-100 rounded-lg bg-white outline-none focus:ring-4 focus:ring-blue-50 text-sm transition-all text-slate-900"
                            placeholder="Search inventory SKU or Supplier Price Lists..."
                            value={invSearch}
                            onChange={(e) => setInvSearch(e.target.value)}
                          />
                          {showInvSuggestions && (invResults.length > 0 || supplierResults.length > 0) && (
                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-slate-200 rounded-xl shadow-2xl z-20 overflow-hidden divide-y animate-in slide-in-from-top-1 max-h-[300px] overflow-y-auto">
                              {invResults.map(i => {
                                const netAvailable = i.quantityInStock - (i.quantityReserved || 0);
                                return (
                                  <button
                                    key={i.id}
                                    type="button"
                                    onMouseDown={() => handleAddComponent(i)}
                                    className="w-full text-left p-4 hover:bg-blue-50 flex justify-between items-center group transition-colors"
                                  >
                                    <div>
                                      <div className="text-xs font-bold text-slate-800 group-hover:text-blue-700">
                                          <i className="fa-solid fa-box-open mr-2 opacity-50"></i>{i.description}
                                      </div>
                                      <div className="text-[10px] text-slate-400 flex gap-2 items-center">
                                          <span className="font-mono bg-slate-100 px-1 rounded">{i.sku}</span>
                                          <span className={`${netAvailable <= 0 ? 'text-red-500 font-bold' : ''}`}>Available: {netAvailable} {i.unit}</span>
                                          <span className="text-slate-300">|</span>
                                          <span>Stock: {i.quantityInStock}</span>
                                          <span className="text-green-600 font-bold">Cost: {i.lastCost} L.E.</span>
                                      </div>
                                    </div>
                                    <span className="text-[9px] font-black uppercase bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">IN-STOCK</span>
                                  </button>
                                );
                              })}
                              {supplierResults.map(({ supplier, part }) => (
                                <button
                                  key={part.id}
                                  type="button"
                                  onMouseDown={() => handleAddSupplierPart(supplier, part)}
                                  className="w-full text-left p-4 hover:bg-amber-50 flex justify-between items-center group transition-colors"
                                >
                                  <div>
                                    <div className="text-xs font-bold text-slate-800 group-hover:text-amber-700">
                                        <i className="fa-solid fa-truck-field mr-2 opacity-50"></i>{part.description}
                                    </div>
                                    <div className="text-[10px] text-slate-400 flex gap-2 items-center">
                                        <span className="font-mono bg-slate-100 px-1 rounded">{part.partNumber}</span>
                                        <span>Supplier: {supplier.name}</span>
                                        <span className="text-amber-600 font-black">Offer: {part.price} L.E.</span>
                                    </div>
                                  </div>
                                  <span className="text-[9px] font-black uppercase bg-amber-100 text-amber-700 px-2 py-0.5 rounded">EXTERNAL</span>
                                </button>
                              ))}
                            </div>
                          )}
                       </div>
                       <button
                         onClick={handleAddProcurementComp}
                         className="px-4 py-2 bg-slate-800 text-white font-bold rounded-lg hover:bg-black transition-colors shadow-lg flex items-center gap-2 whitespace-nowrap"
                       >
                         <i className="fa-solid fa-plus"></i>
                         Custom External
                       </button>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-100 shadow-sm">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-900 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      <tr>
                        <th className="px-4 py-3 text-white">Comp ID</th>
                        <th className="px-4 py-3 text-white">Component</th>
                        <th className="px-4 py-3 text-white">Qty</th>
                        <th className="px-4 py-3 text-white">Source</th>
                        <th className="px-4 py-3 text-white">Unit Cost</th>
                        <th className="px-4 py-3 text-white">Total</th>
                        <th className="px-4 py-3 text-white">Status</th>
                        <th className="px-4 py-3 text-white"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedItem.components?.map(c => (
                        <tr key={c.id} className="hover:bg-slate-50/50 group transition-colors">
                          <td className="px-4 py-4">
                            <div className="font-mono text-[10px] text-blue-600 font-black">{c.componentNumber}</div>
                          </td>
                          <td className="px-4 py-4">
                            <div className="font-bold text-slate-800">{c.description}</div>
                            {c.inventoryItemId && <div className="text-[10px] text-slate-400 font-mono italic">RESERVED IN-STOCK #{c.inventoryItemId}</div>}
                            {c.supplierId && <div className="text-[10px] text-amber-600 font-mono italic">SUPPLIER-OFFER REF</div>}
                          </td>
                          <td className="px-4 py-4 font-bold">{c.quantity} <span className="text-[10px] font-normal text-slate-400 uppercase">{c.unit}</span></td>
                          <td className="px-4 py-4">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black border uppercase tracking-wider ${c.source === 'STOCK' ? 'bg-blue-50 text-blue-600 border-blue-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>
                              {c.source}
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            {c.unitCost === 0 ? (
                                <span className="text-[10px] font-bold text-amber-500 italic">Awaiting Offer</span>
                            ) : (
                                <span className="font-bold text-slate-700">{c.unitCost.toLocaleString()} <span className="text-[9px] text-slate-400">L.E.</span></span>
                            )}
                          </td>
                          <td className="px-4 py-4 font-black text-slate-900">
                            {(c.quantity * c.unitCost).toLocaleString()}
                          </td>
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-1.5">
                              <div className={`w-1.5 h-1.5 rounded-full ${c.status === 'AVAILABLE' || c.status === 'RESERVED' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-amber-500'}`}></div>
                              <span className="text-[10px] font-bold text-slate-500 uppercase">{c.status.replace('_', ' ')}</span>
                            </div>
                          </td>
                          <td className="px-4 py-4 text-right">
                             <button onClick={() => removeComp(c.id)} className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 p-2">
                               <i className="fa-solid fa-trash-can"></i>
                             </button>
                          </td>
                        </tr>
                      ))}
                      {(!selectedItem.components || selectedItem.components.length === 0) && (
                        <tr>
                          <td colSpan={8} className="px-4 py-16 text-center text-slate-400">
                            <div className="max-w-xs mx-auto space-y-2">
                                <i className="fa-solid fa-layer-group text-3xl opacity-20 block mb-4"></i>
                                <div className="font-bold text-slate-600">BoM is empty</div>
                                <div className="text-xs">Search inventory or supplier lists to build the manufacturing cost study.</div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="pt-8 flex justify-between items-center border-t border-slate-100">
                   <div className="flex gap-4">
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Internal Components</div>
                            <div className="text-xl font-bold text-slate-800">{selectedItem.components?.filter(c => c.source === 'STOCK').length || 0}</div>
                        </div>
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">External Requirements</div>
                            <div className="text-xl font-bold text-slate-800">{selectedItem.components?.filter(c => c.source === 'PROCUREMENT').length || 0}</div>
                        </div>
                   </div>
                   <button 
                     onClick={async () => {
                        // Fix: Pass currentUser.username as the third argument
                        const updated = await dataService.toggleItemAcceptance(selectedOrder.id, selectedItem.id, currentUser.username);
                        setSelectedOrder(updated);
                        setSelectedItem(updated.items.find(i => i.id === selectedItem.id)!);
                     }}
                     className={`px-8 py-3 rounded-xl font-black uppercase text-xs transition-all flex items-center gap-2 shadow-lg ${selectedItem.isAccepted ? 'bg-red-50 text-red-600 hover:bg-red-100 shadow-red-100' : 'bg-green-600 text-white hover:bg-green-700 shadow-green-100'}`}
                   >
                     <i className={`fa-solid ${selectedItem.isAccepted ? 'fa-rotate-left' : 'fa-check-double'}`}></i>
                     {selectedItem.isAccepted ? 'Revoke Study Approval' : 'Complete Study & Save BoM'}
                   </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
