
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
  const [processingId, setProcessingId] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, [refreshKey]);

  const fetchOrders = async () => {
    const all = await dataService.getOrders();
    setOrders(all.filter(o => [OrderStatus.WAITING_FACTORY, OrderStatus.MANUFACTURING].includes(o.status)));
  };

  const handleAction = async (id: string, next: 'start' | 'finish') => {
    setProcessingId(id);
    if (next === 'start') await dataService.startProduction(id);
    else await dataService.finishProduction(id);
    await fetchOrders();
    setProcessingId(null);
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
            <div key={o.id} className="p-6 bg-slate-50 border border-slate-100 rounded-3xl group hover:border-blue-400 transition-all">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="font-mono text-xs font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                  <div className="text-lg font-black text-slate-800 tracking-tight">{o.customerName}</div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border ${o.status === OrderStatus.MANUFACTURING ? 'bg-blue-600 text-white border-blue-700' : 'bg-white text-slate-400 border-slate-200'}`}>
                  {o.status === OrderStatus.MANUFACTURING ? 'Building' : 'Staged'}
                </span>
              </div>
              <div className="flex justify-between items-center pt-4 border-t border-slate-200">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{o.items.length} Positions</div>
                <button
                  onClick={() => handleAction(o.id, o.status === OrderStatus.MANUFACTURING ? 'finish' : 'start')}
                  disabled={processingId === o.id}
                  className="px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg shadow-slate-900/20 hover:bg-black transition-all"
                >
                  {processingId === o.id ? <i className="fa-solid fa-spinner fa-spin"></i> : (o.status === OrderStatus.MANUFACTURING ? 'Finalize Fabrication' : 'Release to Floor')}
                </button>
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
