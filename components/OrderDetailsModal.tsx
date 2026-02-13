
import React, { useState, useEffect } from 'react';
import { CustomerOrder, LogEntry, ManufacturingComponent, OrderStatus } from '../types';
import { STATUS_CONFIG } from '../constants';
import { dataService } from '../services/dataService';

const LogTimeline: React.FC<{ logs: LogEntry[], title?: string }> = ({ logs, title }) => (
  <div className="space-y-4">
    {title && <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
      <i className="fa-solid fa-timeline"></i>
      {title}
    </h5>}
    <div className="relative pl-6 border-l-2 border-slate-100 space-y-6">
      {logs.slice().reverse().map((log, i) => (
        <div key={i} className="relative">
          <div className="absolute -left-[29px] top-1.5 w-3 h-3 rounded-full bg-white border-4 border-blue-500 shadow-sm"></div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[11px] font-black text-slate-800 leading-tight">{log.message}</span>
              <span className="px-2 py-0.5 bg-slate-100 rounded text-[8px] font-black uppercase text-slate-500 border border-slate-200 shrink-0">
                User: {log.user || 'System'}
              </span>
            </div>
            <div className="text-[9px] text-slate-400 font-bold uppercase tracking-tight flex items-center gap-2">
              <i className="fa-solid fa-clock opacity-50"></i>
              {new Date(log.timestamp).toLocaleString()}
              {log.status && <span className="ml-2 text-blue-500">[{log.status}]</span>}
            </div>
            {log.nextStep && (
              <div className="mt-2 p-3 bg-blue-50 rounded-xl border border-blue-100 animate-in slide-in-from-left-1">
                <div className="text-[8px] font-black text-blue-600 uppercase tracking-widest mb-1">Recommended Next Step</div>
                <div className="text-[10px] font-bold text-blue-800 flex items-center gap-2">
                  <i className="fa-solid fa-arrow-right-to-bracket text-blue-400"></i>
                  {log.nextStep}
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
      {logs.length === 0 && <div className="text-[11px] text-slate-400 italic py-8 text-center bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200">No activity recorded yet.</div>}
    </div>
  </div>
);

const BoMTable: React.FC<{ components: ManufacturingComponent[] }> = ({ components }) => {
  const readyCount = components.filter(c => c.status === 'AVAILABLE' || c.status === 'RECEIVED').length;
  const progressPercent = components.length > 0 ? (readyCount / components.length) * 100 : 0;

  return (
    <div className="space-y-4 mt-2">
      <div className="bg-white p-3 rounded-xl border border-slate-100 flex items-center gap-4">
        <div className="flex-1">
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[10px] font-bold text-slate-500 uppercase">Manufacturing Readiness</span>
            <span className="text-[10px] font-black text-blue-600">{readyCount} / {components.length} Ready</span>
          </div>
          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all duration-700 ease-out" style={{ width: `${progressPercent}%` }}></div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold text-slate-400 uppercase">Est. Mfg Cost</div>
          <div className="text-sm font-black text-slate-900">
            {components.reduce((sum, c) => sum + (c.quantity * c.unitCost), 0).toLocaleString()} L.E.
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-100 shadow-sm bg-white">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-slate-50 text-slate-400 font-bold uppercase tracking-widest text-[9px] border-b border-slate-100">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Component / Service</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {components.map((comp) => {
              const isService = comp.unit.toLowerCase() === 'hr' || comp.description.toLowerCase().includes('labor');
              return (
                <tr key={comp.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-4 py-3"><div className="font-mono text-[9px] text-blue-600 font-black">{comp.componentNumber}</div></td>
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><i className={`fa-solid ${isService ? 'fa-user-gear text-indigo-400' : 'fa-box text-amber-400'} text-[10px]`}></i><span className="font-bold text-slate-700">{comp.description}</span></div></td>
                  <td className="px-4 py-3 font-medium text-slate-500">{comp.quantity} <span className="text-[9px] uppercase">{comp.unit}</span></td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-md text-[8px] font-black border uppercase tracking-tighter ${comp.source === 'STOCK' ? 'bg-blue-50 text-blue-600 border-blue-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>{comp.source}</span></td>
                  <td className="px-4 py-3"><div className="flex items-center gap-1.5"><div className={`w-1.5 h-1.5 rounded-full ${comp.status === 'RECEIVED' || comp.status === 'AVAILABLE' || comp.status === 'RESERVED' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-amber-400'}`}></div><span className="text-[9px] font-bold text-slate-500 uppercase">{comp.status.replace('_', ' ')}</span></div></td>
                  <td className="px-4 py-3 text-right font-mono font-black text-slate-900">{comp.unitCost > 0 ? `${(comp.quantity * comp.unitCost).toLocaleString()} L.E.` : 'PENDING'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface OrderDetailsModalProps {
  order: CustomerOrder;
  onClose: () => void;
  delayReason?: string | null;
}

export const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({ order: initialOrder, onClose, delayReason }) => {
  const [order, setOrder] = useState<CustomerOrder>(initialOrder);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<'bom' | 'logs'>('bom');
  const [isOverdue, setIsOverdue] = useState(false);

  useEffect(() => {
    const checkOverdue = async () => {
      const result = await dataService.isCustomerOverdue(order.customerName);
      setIsOverdue(result);
    };
    checkOverdue();
  }, [order.customerName]);

  const totalSalesValue = order.items.reduce((s, i) => s + (i.quantity * i.pricePerUnit), 0);
  const isFinanceBlocked = order.status === OrderStatus.IN_HOLD || isOverdue;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-300">

        {isFinanceBlocked && (
          <div className="bg-amber-600 text-white px-6 py-3 flex items-center justify-between shadow-lg z-10">
            <div className="flex items-center gap-3">
              <i className="fa-solid fa-triangle-exclamation text-xl"></i>
              <div>
                <span className="font-black uppercase tracking-widest text-sm">Financial Control Active</span>
                <p className="text-[10px] font-bold opacity-80 uppercase">
                  {order.status === OrderStatus.IN_HOLD ? `Order paused by Finance: ${order.holdReason || 'No reason provided'}` : 'Customer has overdue payments / Credit Hold.'}
                </p>
              </div>
            </div>
          </div>
        )}

        {delayReason && (
          <div className="bg-rose-50 border-b border-rose-100 px-6 py-4 flex items-center gap-4 animate-in slide-in-from-top-2">
            <div className="w-10 h-10 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg shadow-rose-200">
              <i className="fa-solid fa-clock-rotate-left"></i>
            </div>
            <div>
              <h4 className="text-xs font-black text-rose-900 uppercase tracking-widest">Process Latency Alert</h4>
              <p className="text-sm font-bold text-rose-600">This PO has been in the status of '<span className="uppercase">{STATUS_CONFIG[order.status].label}</span>' for <span className="underline decoration-rose-300 underline-offset-4">{delayReason}</span>.</p>
            </div>
          </div>
        )}

        <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-white">
          <div className="flex items-center gap-5">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-inner bg-${STATUS_CONFIG[order.status].color}-50 text-${STATUS_CONFIG[order.status].color}-600`}>
              <i className={`fa-solid ${STATUS_CONFIG[order.status].icon}`}></i>
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h3 className="text-2xl font-black text-slate-800 tracking-tight">{order.customerName}</h3>
                <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-[10px] font-black uppercase tracking-widest border border-slate-200">
                  {order.internalOrderNumber}
                </span>
                {order.status === OrderStatus.REJECTED && (
                  <span className="bg-red-100 text-red-600 px-3 py-1 rounded-full text-[10px] font-black uppercase border border-red-200">Permanently Closed</span>
                )}
              </div>
              <div className="flex items-center gap-4 mt-1">
                <div className={`text-xs font-bold uppercase tracking-widest text-${STATUS_CONFIG[order.status].color}-600`}>
                  {STATUS_CONFIG[order.status].label} Stage
                </div>
                <div className="w-1 h-1 bg-slate-300 rounded-full"></div>
                <div className="text-xs text-slate-400 font-medium">Ref: {order.customerReferenceNumber}</div>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="w-12 h-12 flex items-center justify-center rounded-2xl bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-slate-800 transition-all active:scale-90"><i className="fa-solid fa-xmark text-lg"></i></button>
        </div>

        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 overflow-y-auto p-8 space-y-10 custom-scrollbar">
            {order.status === OrderStatus.REJECTED && (
              <div className="bg-red-50 border border-red-200 p-6 rounded-2xl flex gap-4">
                <i className="fa-solid fa-circle-exclamation text-red-600 text-xl"></i>
                <div>
                  <h5 className="font-black text-red-900 uppercase tracking-widest text-xs">Closed Workflow: Order Rejected</h5>
                  <p className="text-sm text-red-700 mt-1 italic">"{order.rejectionReason}"</p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 group hover:border-blue-200 transition-colors">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Order Progress</div>
                <div className="flex items-end gap-2"><div className="text-2xl font-black text-slate-800">{order.items.filter(i => i.isAccepted).length}</div><div className="text-sm text-slate-400 font-bold mb-1">/ {order.items.length} Lines Study Complete</div></div>
              </div>
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 group hover:border-emerald-200 transition-colors">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Total Contract Value</div>
                <div className="text-2xl font-black text-emerald-600">{totalSalesValue.toLocaleString()} <span className="text-xs font-bold opacity-60">L.E.</span></div>
              </div>
              <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100 group hover:border-indigo-200 transition-colors">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Logged Date</div>
                <div className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <i className="fa-solid fa-calendar-day text-slate-300"></i>
                  {new Date(order.logs.find(l => l.status === OrderStatus.LOGGED)?.timestamp || order.dataEntryTimestamp).toLocaleDateString()}
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em]">Detailed Line Items</h4>
                <span className="text-[10px] text-slate-400 font-bold italic">Click any item to view manufacturing parts & log history</span>
              </div>
              <div className="space-y-3">
                {order.items.map(item => (
                  <div key={item.id} className={`rounded-2xl border transition-all duration-300 overflow-hidden ${expandedItemId === item.id ? 'border-blue-200 ring-4 ring-blue-50 bg-white' : 'border-slate-200 bg-slate-50/30 hover:bg-white hover:border-slate-300'}`}>
                    <div className="p-5 flex justify-between items-center group cursor-pointer" onClick={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}>
                      <div className="flex-1">
                        <div className="flex items-center gap-3"><div className={`w-2 h-2 rounded-full ${item.isAccepted ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-slate-300'}`}></div><div className="font-mono text-[10px] text-blue-500 font-black uppercase tracking-wider">{item.orderNumber}</div></div>
                        <div className="font-bold text-slate-800 text-lg group-hover:text-blue-600 transition-colors">{item.description}</div>
                        <div className="text-xs text-slate-500 mt-1 flex items-center gap-4"><span className="font-medium">{item.quantity} {item.unit} @ {item.pricePerUnit.toLocaleString()} L.E.</span></div>
                      </div>
                      <div className="text-right flex items-center gap-6">
                        <div className="hidden sm:block"><div className="text-[10px] font-black text-slate-400 uppercase mb-0.5">Line Total</div><div className="font-black text-slate-900 text-lg">{(item.quantity * item.pricePerUnit).toLocaleString()} <span className="text-[10px] opacity-40">L.E.</span></div></div>
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center bg-white border border-slate-200 text-slate-400 transition-transform duration-300 ${expandedItemId === item.id ? 'rotate-180 bg-blue-600 border-blue-600 text-white shadow-lg' : 'group-hover:border-blue-300 group-hover:text-blue-500'}`}><i className="fa-solid fa-chevron-down text-xs"></i></div>
                      </div>
                    </div>
                    {expandedItemId === item.id && (
                      <div className="px-6 pb-6 pt-2 bg-slate-50/50 border-t border-slate-100 animate-in slide-in-from-top-2 duration-300">
                        <div className="flex gap-8 mb-6 border-b border-slate-200">
                          <button onClick={(e) => { e.stopPropagation(); setExpandedTab('bom'); }} className={`pb-3 text-[10px] font-black uppercase tracking-[0.15em] transition-all relative ${expandedTab === 'bom' ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>Manufacturing BoM{expandedTab === 'bom' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full"></div>}</button>
                          <button onClick={(e) => { e.stopPropagation(); setExpandedTab('logs'); }} className={`pb-3 text-[10px] font-black uppercase tracking-[0.15em] transition-all relative ${expandedTab === 'logs' ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600'}`}>Line Item Activity{expandedTab === 'logs' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 rounded-full"></div>}</button>
                        </div>
                        {expandedTab === 'bom' ? (<div className="animate-in fade-in duration-500">{item.components && item.components.length > 0 ? (<BoMTable components={item.components} />) : (<div className="py-12 text-center bg-white rounded-2xl border-2 border-dashed border-slate-100"><div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4"><i className="fa-solid fa-microscope text-2xl text-slate-200"></i></div><p className="text-xs text-slate-400 font-bold uppercase tracking-widest">No manufacturing study complete</p></div>)}</div>) : (<div className="animate-in fade-in duration-500"><div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm"><LogTimeline logs={item.logs} /></div></div>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="w-80 bg-slate-50 border-l border-slate-100 overflow-y-auto p-8 custom-scrollbar">
            <div className="sticky top-0">
              <div className="flex items-center gap-3 mb-8 border-b border-slate-200 pb-4"><div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm text-blue-500"><i className="fa-solid fa-timeline text-xs"></i></div><h4 className="text-[11px] font-black text-slate-600 uppercase tracking-widest">Lifecycle Audit</h4></div>
              <LogTimeline logs={order.logs} />
            </div>
          </div>
        </div>
        <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-between items-center">
          <div className="flex gap-4 text-[10px] font-bold text-slate-400"><span className="flex items-center gap-1.5"><i className="fa-solid fa-circle-check text-green-500"></i> Auto-saved to Cloud</span><span className="flex items-center gap-1.5"><i className="fa-solid fa-shield-halved text-blue-500"></i> Audit logs secured</span></div>
          <button onClick={onClose} className="px-12 py-3 bg-slate-900 text-white font-black text-xs uppercase tracking-[0.2em] rounded-2xl hover:bg-black hover:shadow-xl active:scale-95 transition-all">Close Dashboard</button>
        </div>
      </div>
    </div>
  );
};
