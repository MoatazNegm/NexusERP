import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig, User } from '../types';
import { STATUS_CONFIG } from '../constants';

interface FactoryModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

export const FactoryModule: React.FC<FactoryModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [inventoryState, setInventoryState] = useState<any[]>([]);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [mfgInputs, setMfgInputs] = useState<Record<string, string>>({});
  const [mfgCompInputs, setMfgCompInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchOrders();
  }, [refreshKey]);

  const fetchOrders = async () => {
    const [allOrders, allInv] = await Promise.all([
      dataService.getOrders(),
      dataService.getInventory()
    ]);
    setOrders(allOrders.filter(o => [OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING].includes(o.status)));
    setInventoryState(allInv);
  };

  const handleAction = async (id: string, next: 'start' | 'finish') => {
    setProcessingId(id);
    if (next === 'start') await dataService.startProduction(id);
    else await dataService.finishProduction(id);
    await fetchOrders();
    setProcessingId(null);
  };

  const handleRegisterMfg = async (orderId: string, itemId: string) => {
    const qtyStr = mfgInputs[`${orderId}-${itemId}`];
    if (!qtyStr) return;
    const qty = parseFloat(qtyStr);
    if (isNaN(qty) || qty <= 0) return;

    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    setProcessingId(`${orderId}-${itemId}`);
    try {
      // Auto-start production if still in STAGED status
      if (order.status === OrderStatus.WAITING_FACTORY) {
        await dataService.startProduction(orderId);
      }
      await dataService.registerManufacturing(orderId, itemId, qty);
      setMfgInputs(prev => ({ ...prev, [`${orderId}-${itemId}`]: '' }));
      await fetchOrders();
    } catch (e: any) {
      alert("Failed to register manufacturing: " + e.message);
    } finally {
      setProcessingId(null);
    }
  };

  const handleConsumeComponent = async (orderId: string, itemId: string, compId: string) => {
    const compInputKey = `${orderId}-${itemId}-${compId}`;
    const qtyStr = mfgCompInputs[compInputKey];
    if (!qtyStr) return;
    const qty = parseFloat(qtyStr);
    if (isNaN(qty) || qty <= 0) return;

    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    setProcessingId(compInputKey);
    try {
      // Auto-start production if still in STAGED status
      if (order.status === OrderStatus.WAITING_FACTORY) {
        await dataService.startProduction(orderId);
      }
      await dataService.consumeFactoryComponent(orderId, itemId, compId, qty);
      setMfgCompInputs(prev => ({ ...prev, [compInputKey]: '' }));
      await fetchOrders();
    } catch (e: any) {
      alert("Failed to consume component: " + e.message);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="mb-8">
          <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Plant Operations Hub</h3>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Active manufacturing floor control</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {orders.map(o => (
            <div key={o.id} className="p-6 bg-slate-50 border border-slate-100 rounded-3xl group hover:border-blue-400 transition-all flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="font-mono text-xs font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                  <div className="text-lg font-black text-slate-800 tracking-tight">{o.customerName}</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border ${o.status === OrderStatus.MANUFACTURING ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-slate-400 border-slate-200'}`}>
                  {o.status === OrderStatus.MANUFACTURING ? 'Building' : 'Staged'}
                </span>
              </div>

              <div className="flex-1 mb-4 flex flex-col gap-2">
                <div className="text-[10px] font-black text-slate-800 uppercase tracking-widest border-b border-slate-200 pb-2 mb-2">Production Lines</div>
                {o.items.map(item => {
                  const target = item.quantity;
                  const current = item.manufacturedQty || 0;
                  const isComplete = current >= target;
                  const inputKey = `${o.id}-${item.id}`;
                  const isProcessingThis = processingId === inputKey;

                  return (
                    <div key={item.id} className="bg-white p-4 rounded-2xl border border-slate-100 flex flex-col gap-3">
                      <div className="flex justify-between items-start">
                        <div className="font-bold text-slate-700 text-sm">{item.description}</div>
                        <div className="text-right">
                          <div className="text-[10px] font-black uppercase text-slate-400">Target</div>
                          <div className="text-sm font-black text-slate-900">{target} <span className="text-[10px] font-bold text-slate-400">{item.unit}</span></div>
                          {!isComplete && (
                            <div className="text-[9px] font-black text-amber-600 mt-0.5">Remaining: {(target - current).toLocaleString()}</div>
                          )}
                        </div>
                      </div>

                      {/* Display Components (BoM) */}
                      {item.components && item.components.length > 0 && (
                        <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 mt-1">
                          <div className="text-[9px] font-black uppercase text-slate-400 tracking-widest mb-2 flex justify-between px-1">
                            <span>Bill of Materials</span>
                            <span>Consumed Qty</span>
                          </div>
                          <div className="space-y-1.5">
                            {item.components.map(comp => {
                              const compInputKey = `${o.id}-${item.id}-${comp.id}`;
                              const compAllocated = comp.quantity || 0;
                              const compConsumed = comp.consumedQty || 0;

                              // Find actual stock in inventory
                              const invItem = inventoryState.find(inv => inv.id === comp.inventoryItemId);
                              const actualStock = invItem ? (invItem.quantityInStock !== undefined ? invItem.quantityInStock : (invItem.quantity || 0)) : 0;

                              const compRemaining = Math.max(0, compAllocated - compConsumed);
                              const maxPossibleToConsume = Math.min(compRemaining, actualStock);
                              const compDone = compRemaining <= 0;
                              return (
                                <div key={comp.id} className={`flex justify-between items-center bg-white p-2 rounded-lg border shadow-sm ${compDone ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-100'}`}>
                                  <div className="flex-1 min-w-0 pr-2">
                                    <div className="font-bold text-slate-700 truncate text-xs">{comp.description}</div>
                                    <div className="flex gap-2 text-[9px] font-mono mt-0.5">
                                      {comp.componentNumber && <span className="text-blue-600">{comp.componentNumber}</span>}
                                      {comp.supplierPartNumber && <span className="text-amber-600">{comp.supplierPartNumber}</span>}
                                    </div>
                                    <div className="text-[9px] mt-0.5">
                                      <span className="text-slate-400">Allocated: {compAllocated.toLocaleString()}</span>
                                      <span className="mx-1 text-slate-300">·</span>
                                      <span className="text-blue-600">Used: {compConsumed.toLocaleString()}</span>
                                      <span className="mx-1 text-slate-300">·</span>
                                      <span className={compDone ? 'text-emerald-600 font-bold' : 'text-amber-600 font-bold'}>Left: {compRemaining.toLocaleString()}</span>
                                      {!compDone && <span className={`ml-2 font-black ${actualStock < compRemaining ? 'text-rose-500' : 'text-slate-500'}`}>(Stock: {actualStock.toLocaleString()})</span>}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1 flex-none shrink-0">
                                    {!compDone ? (
                                      <>
                                        <input
                                          type="number"
                                          placeholder="Qty"
                                          min={0}
                                          max={maxPossibleToConsume}
                                          value={mfgCompInputs[compInputKey] || ''}
                                          onChange={(e) => {
                                            const val = parseFloat(e.target.value);
                                            if (e.target.value === '' || isNaN(val)) {
                                              setMfgCompInputs(prev => ({ ...prev, [compInputKey]: e.target.value }));
                                            } else {
                                              const clamped = Math.min(val, maxPossibleToConsume);
                                              setMfgCompInputs(prev => ({ ...prev, [compInputKey]: String(clamped) }));
                                            }
                                          }}
                                          disabled={processingId === compInputKey || actualStock <= 0}
                                          className="w-20 px-2 py-1 bg-slate-50 border border-slate-200 rounded text-xs font-black text-right focus:border-blue-500 outline-none disabled:opacity-50"
                                        />
                                        <span className="text-[9px] text-slate-400 font-sans w-6">{comp.unit || 'pcs'}</span>
                                        <button
                                          onClick={() => handleConsumeComponent(o.id, item.id, comp.id!)}
                                          disabled={processingId === compInputKey || !mfgCompInputs[compInputKey]}
                                          className="w-7 h-7 flex items-center justify-center bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
                                          title="Consume this component from stock"
                                        >
                                          {processingId === compInputKey ? <i className="fa-solid fa-spinner fa-spin text-[10px]"></i> : <i className="fa-solid fa-arrow-down text-[10px]"></i>}
                                        </button>
                                      </>
                                    ) : (
                                      <span className="text-[9px] font-black text-emerald-600 uppercase"><i className="fa-solid fa-check-double mr-1"></i>Done</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-3 pt-3 border-t border-slate-50">
                        <div className="flex-1">
                          <div className="text-[9px] font-black uppercase text-blue-600 mb-1">Mfd: {current} / {target} <span className="text-amber-600 ml-1">(Remaining: {(target - current).toLocaleString()})</span></div>
                          <div className="w-full bg-slate-100 rounded-full h-1.5">
                            <div className={`h-1.5 rounded-full ${isComplete ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, (current / target) * 100)}%` }}></div>
                          </div>
                        </div>
                        {!isComplete && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              placeholder="Qty"
                              min={0}
                              max={target - current}
                              value={mfgInputs[inputKey] || ''}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                const maxAllowed = target - current;
                                if (e.target.value === '' || isNaN(val)) {
                                  setMfgInputs(p => ({ ...p, [inputKey]: e.target.value }));
                                } else {
                                  const clamped = Math.min(val, maxAllowed);
                                  setMfgInputs(p => ({ ...p, [inputKey]: String(clamped) }));
                                }
                              }}
                              className="w-16 px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-black text-center focus:border-blue-500 outline-none"
                            />
                            <button
                              onClick={() => handleRegisterMfg(o.id, item.id)}
                              disabled={isProcessingThis || !mfgInputs[inputKey]}
                              className="w-8 h-8 flex items-center justify-center bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                              {isProcessingThis ? <i className="fa-solid fa-spinner fa-spin text-xs"></i> : <i className="fa-solid fa-check text-xs"></i>}
                            </button>
                          </div>
                        )}
                        {isComplete && (
                          <div className="flex-none px-3 py-1 bg-emerald-50 text-emerald-600 rounded drop-shadow-sm text-[10px] font-black uppercase">
                            <i className="fa-solid fa-check-double mr-1"></i> Done
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-between items-center pt-4 border-t border-slate-200 mt-auto">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{o.items.length} Positions</div>
                {o.status === OrderStatus.WAITING_FACTORY && (
                  <button
                    onClick={() => handleAction(o.id, 'start')}
                    disabled={processingId === o.id}
                    className="px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-black transition-all"
                  >
                    {processingId === o.id ? <i className="fa-solid fa-spinner fa-spin"></i> : 'Release to Floor'}
                  </button>
                )}
                {o.status === OrderStatus.MANUFACTURING && (
                  <button
                    onClick={() => handleAction(o.id, 'finish')}
                    disabled={processingId === o.id}
                    className="px-6 py-3 bg-white text-rose-600 border border-rose-200 rounded-xl text-[10px] font-black uppercase shadow-sm hover:bg-rose-50 transition-all"
                    title="Manually force completion of entire order"
                  >
                    {processingId === o.id ? <i className="fa-solid fa-spinner fa-spin"></i> : 'Force Finalize'}
                  </button>
                )}
              </div>
            </div>
          ))}
          {orders.length === 0 && (
            <div className="md:col-span-2 p-20 text-center text-slate-300 italic font-black uppercase tracking-[0.3em] text-xs">No active production runs.</div>
          )}
        </div>
      </div>
    </div>
  );
};
