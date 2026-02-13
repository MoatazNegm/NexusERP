
import React, { useState, useMemo, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig } from '../types';
import { STATUS_CONFIG } from '../constants';
import { OrderDetailsModal } from './OrderDetailsModal';

interface OrderReportProps {
  config: AppConfig;
  dashboardFilter?: OrderStatus | null;
}

const getStatusLimit = (status: OrderStatus, settings: any) => {
  switch (status) {
    case OrderStatus.LOGGED: return settings.orderEditTimeLimitHrs;
    case OrderStatus.TECHNICAL_REVIEW: return settings.technicalReviewLimitHrs;
    case OrderStatus.WAITING_SUPPLIERS: return settings.pendingOfferLimitHrs;
    case OrderStatus.WAITING_FACTORY: return settings.waitingFactoryLimitHrs;
    case OrderStatus.MANUFACTURING: return settings.mfgFinishLimitHrs;
    case OrderStatus.TRANSITION_TO_STOCK: return settings.transitToHubLimitHrs;
    case OrderStatus.IN_PRODUCT_HUB: return settings.productHubLimitHrs;
    case OrderStatus.ISSUE_INVOICE: return settings.invoicedLimitHrs;
    case OrderStatus.INVOICED: return settings.hubReleasedLimitHrs;
    case OrderStatus.HUB_RELEASED: return settings.deliveryLimitHrs;
    case OrderStatus.DELIVERY: return settings.deliveredLimitHrs;
    default: return 0;
  }
};

const ThresholdTimer: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = getStatusLimit(order.status, config.settings);
      if (limitHrs === 0) return;
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, config.settings]);

  const limitHrs = getStatusLimit(order.status, config.settings);
  if (limitHrs === 0) return null;

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[8px] font-black uppercase mt-0.5 flex items-center gap-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-emerald-500 opacity-60'}`}>
      <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-hourglass-half'}`}></i>
      {isOver ? `Over ${timeStr}` : `${timeStr} left`}
    </div>
  );
};

export const OrderReport: React.FC<OrderReportProps> = ({ config, dashboardFilter }) => {
  const [dateFilter, setDateFilter] = useState<'today' | 'yesterday' | 'lastWeek' | 'lastMonth' | 'custom' | 'all'>('all');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<OrderStatus[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<CustomerOrder | null>(null);

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (dashboardFilter) {
      setSelectedStatuses([dashboardFilter]);
    } else {
      setSelectedStatuses([]);
    }
  }, [dashboardFilter]);

  const toggleStatus = (status: OrderStatus) => {
    if (selectedStatuses.includes(status)) {
      setSelectedStatuses(selectedStatuses.filter(s => s !== status));
    } else {
      setSelectedStatuses([...selectedStatuses, status]);
    }
  };

  const filterParams = useMemo(() => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    let baseRange = { startDate: '', endDate: '' };

    switch (dateFilter) {
      case 'today': baseRange = { startDate: todayStr, endDate: todayStr }; break;
      case 'yesterday':
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        baseRange = { startDate: yesterday.toISOString().split('T')[0], endDate: yesterday.toISOString().split('T')[0] };
        break;
      case 'lastWeek':
        const lastWeek = new Date(today);
        lastWeek.setDate(lastWeek.getDate() - 7);
        baseRange = { startDate: lastWeek.toISOString().split('T')[0], endDate: todayStr };
        break;
      case 'lastMonth':
        const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
        baseRange = { startDate: firstDay.toISOString().split('T')[0], endDate: lastDay.toISOString().split('T')[0] };
        break;
      case 'all': baseRange = { startDate: '', endDate: '' }; break;
      case 'custom': baseRange = { startDate: customRange.start, endDate: customRange.end }; break;
    }
    return { ...baseRange, query: searchQuery, statuses: selectedStatuses };
  }, [dateFilter, customRange, searchQuery, selectedStatuses]);

  useEffect(() => {
    const fetchReport = async () => {
      setLoading(true);
      try {
        const data = await dataService.getReport(filterParams);
        setOrders(data);
      } catch (error) {
        console.error("Failed to fetch report:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchReport();
  }, [filterParams]);

  return (
    <div className="space-y-6">
      <div className="space-y-4 p-6 bg-slate-50 border-b border-slate-100">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="flex-1 space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Registry Search</label>
            <div className="relative">
              <input
                type="text"
                className="w-full pl-10 pr-4 py-2.5 border rounded-xl bg-white text-slate-900 outline-none focus:ring-2 focus:ring-blue-500 border-slate-200 text-sm transition-all"
                placeholder="Search by ID, Customer, Items..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Lifecycle range</label>
            <div className="flex gap-1 p-1 bg-white border border-slate-200 rounded-xl overflow-x-auto custom-scrollbar shadow-inner">
              {(['all', 'today', 'yesterday', 'lastWeek', 'lastMonth', 'custom'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setDateFilter(p)}
                  className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all whitespace-nowrap uppercase tracking-tight ${dateFilter === p ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {p.replace(/([A-Z])/g, ' $1')}
                </button>
              ))}
            </div>
          </div>
        </div>

        {dateFilter === 'custom' && (
          <div className="flex gap-4 animate-in slide-in-from-top-2 duration-300 p-4 bg-white rounded-xl border border-slate-200">
            <div className="flex-1 space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">From Date</label>
              <input type="date" className="w-full px-3 py-2 border rounded-lg bg-white text-xs outline-none" value={customRange.start} onChange={e => setCustomRange({ ...customRange, start: e.target.value })} />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">To Date</label>
              <input type="date" className="w-full px-3 py-2 border rounded-lg bg-white text-xs outline-none" value={customRange.end} onChange={e => setCustomRange({ ...customRange, end: e.target.value })} />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Workflow State Filters</label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(STATUS_CONFIG).map(([status, cfg]) => (
              <button
                key={status}
                onClick={() => toggleStatus(status as OrderStatus)}
                className={`px-3 py-1.5 rounded-full text-[9px] font-black uppercase transition-all border flex items-center gap-2 ${selectedStatuses.includes(status as OrderStatus) ? `bg-${cfg.color}-600 text-white border-${cfg.color}-600 shadow-md` : `bg-white text-slate-500 border-slate-200 hover:bg-slate-50`}`}
              >
                <i className={`fa-solid ${cfg.icon} text-[10px]`}></i> {cfg.label}
              </button>
            ))}
            {selectedStatuses.length > 0 && (
              <button onClick={() => setSelectedStatuses([])} className="px-3 py-1.5 rounded-full text-[9px] font-black uppercase text-red-500 hover:bg-red-50 transition-colors">
                Clear All Filters
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden relative min-h-[300px]">
        {loading && (
          <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] z-10 flex flex-col items-center justify-center">
            <i className="fa-solid fa-circle-notch fa-spin text-blue-600 text-2xl mb-2"></i>
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Syncing activity stream...</span>
          </div>
        )}

        <table className="w-full text-left">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-black uppercase text-slate-400 tracking-widest">
            <tr>
              <th className="px-6 py-4">System Logged</th>
              <th className="px-6 py-4">PO Received</th>
              <th className="px-6 py-4">Customer Account</th>
              <th className="px-6 py-4">PO / Internal ID</th>
              <th className="px-6 py-4">Workflow</th>
              <th className="px-6 py-4 text-right">Items</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {orders.map(order => (
              <tr
                key={order.id}
                onClick={() => setSelectedOrder(order)}
                className="hover:bg-blue-50/30 cursor-pointer transition-colors group"
              >
                <td className="px-6 py-4 whitespace-nowrap text-slate-500 text-xs font-medium">
                  {new Date(order.dataEntryTimestamp).toLocaleDateString()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-500 text-xs font-medium">{order.orderDate}</td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <div className="font-bold text-slate-800">{order.customerName}</div>
                    {order.loggingComplianceViolation && (
                      <div className="group/warn relative">
                        <i className="fa-solid fa-triangle-exclamation text-rose-500 text-[10px] animate-pulse"></i>
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-[8px] font-black uppercase rounded opacity-0 group-hover/warn:opacity-100 transition-opacity whitespace-nowrap z-50">
                          Logging Delay Breach
                        </div>
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4">
                  <div className="font-mono text-[10px] text-blue-600 font-bold">{order.internalOrderNumber}</div>
                  <div className="text-[10px] text-slate-400 font-medium">Ref: {order.customerReferenceNumber || 'None'}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="flex flex-col gap-1">
                    <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wider border bg-${STATUS_CONFIG[order.status].color}-50 text-${STATUS_CONFIG[order.status].color}-600 border-${STATUS_CONFIG[order.status].color}-100 flex items-center gap-1.5 w-fit`}>
                      <i className={`fa-solid ${STATUS_CONFIG[order.status].icon} text-[8px]`}></i>
                      {STATUS_CONFIG[order.status].label}
                    </span>
                    <ThresholdTimer order={order} config={config} />
                  </div>
                </td>
                <td className="px-6 py-4 text-right font-black text-slate-300 group-hover:text-blue-500 transition-colors">
                  {order.items.length} <i className="fa-solid fa-chevron-right text-[10px] ml-2 opacity-0 group-hover:opacity-100 transition-opacity"></i>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && orders.length === 0 && (
          <div className="p-20 text-center flex flex-col items-center gap-4 text-slate-400">
            <i className="fa-solid fa-folder-open text-4xl opacity-10"></i>
            <div className="italic text-sm">No operational records match your current criteria.</div>
          </div>
        )}
      </div>

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
};
