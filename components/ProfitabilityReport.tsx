
import React, { useState, useMemo, useEffect } from 'react';
import { CustomerOrder, AppConfig, OrderStatus, Customer } from '../types';
import { STATUS_CONFIG, getDynamicOrderStatusStyle } from '../constants';
import { dataService } from '../services/dataService';

interface ProfitabilityReportProps {
  orders: CustomerOrder[];
  config: AppConfig;
}

type Period = 'this_year' | 'last_year' | 'last_12_months' | 'all_time';
type MainTab = 'audit' | 'analysis';

export const ProfitabilityReport: React.FC<ProfitabilityReportProps> = ({ orders, config }) => {
  const [activeTab, setActiveTab] = useState<MainTab>('audit');

  // Tab 1 (Audit) State
  const [isPrintPreview, setIsPrintPreview] = useState(false);

  // Tab 2 (Analysis) State
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('all');
  const [selectedPeriod, setSelectedPeriod] = useState<Period>('this_year');
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    dataService.getCustomers().then(setCustomers);
  }, []);

  // --- LOGIC FOR TAB 1: FINANCIAL AUDIT (ORIGINAL) ---
  const auditOpenOrders = useMemo(() => orders.filter(o => o.status !== OrderStatus.FULFILLED && o.status !== OrderStatus.REJECTED), [orders]);
  const auditFulfilledOrders = useMemo(() => orders.filter(o => o.status === OrderStatus.FULFILLED), [orders]);

  const processAuditData = (orderList: CustomerOrder[]) => {
    return orderList.map(order => {
      let revenue = 0;
      let cost = 0;
      let hasPendingCosts = false;
      order.items.forEach(item => {
        revenue += (item.quantity * item.pricePerUnit);
        item.components?.forEach(comp => {
          const componentTotal = comp.quantity * (comp.unitCost || 0);
          cost += componentTotal;
          if (comp.unitCost === 0 && comp.source === 'PROCUREMENT') hasPendingCosts = true;
        });
      });
      const marginAmt = revenue - cost;
      const marginPctOnSales = revenue > 0 ? (marginAmt / revenue) * 100 : 0;
      const markupPct = cost > 0 ? (marginAmt / cost) * 100 : (revenue > 0 ? 100 : 0);
      const isBelowThreshold = markupPct < config.settings.minimumMarginPct;
      return { id: order.id, internalOrderNumber: order.internalOrderNumber, customerName: order.customerName, status: order.status, revenue, cost, marginAmt, marginPctOnSales, markupPct, hasPendingCosts, isBelowThreshold, _originalOrder: order };
    });
  };

  const activeAuditData = useMemo(() => processAuditData(auditOpenOrders), [auditOpenOrders, config.settings.minimumMarginPct]);
  const fulfilledAuditData = useMemo(() => processAuditData(auditFulfilledOrders), [auditFulfilledOrders, config.settings.minimumMarginPct]);

  const auditActiveTotals = useMemo(() => activeAuditData.reduce((acc, curr) => ({ revenue: acc.revenue + curr.revenue, cost: acc.cost + curr.cost, margin: acc.margin + curr.marginAmt }), { revenue: 0, cost: 0, margin: 0 }), [activeAuditData]);
  const auditFulfilledTotals = useMemo(() => fulfilledAuditData.reduce((acc, curr) => ({ revenue: acc.revenue + curr.revenue, cost: acc.cost + curr.cost, margin: acc.margin + curr.marginAmt }), { revenue: 0, cost: 0, margin: 0 }), [fulfilledAuditData]);

  // --- LOGIC FOR TAB 2: CUSTOMER ANALYSIS (NEW) ---
  const getDateRange = (period: Period) => {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    switch (period) {
      case 'this_year': start.setMonth(0, 1); start.setHours(0, 0, 0, 0); break;
      case 'last_year': start.setFullYear(now.getFullYear() - 1, 0, 1); start.setHours(0, 0, 0, 0); end.setFullYear(now.getFullYear() - 1, 11, 31); end.setHours(23, 59, 59, 999); break;
      case 'last_12_months': start.setFullYear(now.getFullYear() - 1); break;
      case 'all_time': return null;
    }
    return { start, end };
  };

  const isOrderInPeriod = (order: CustomerOrder, range: { start: Date, end: Date } | null) => {
    if (!range) return true;
    const orderDate = new Date(order.poDate || order.receivedAt || Date.now());
    return orderDate >= range.start && orderDate <= range.end;
  };

  const calculateAnalysisMetrics = (order: CustomerOrder) => {
    let revenueExclTax = 0;
    let totalCostInclTax = 0;
    order.items.forEach(item => {
      revenueExclTax += (item.quantity * item.pricePerUnit);
      item.components?.forEach(comp => {
        const taxVal = (comp.taxPercent || 0) / 100;
        totalCostInclTax += (comp.quantity * (comp.unitCost || 0) * (1 + taxVal));
      });
    });
    const netProfit = revenueExclTax - totalCostInclTax;
    return { revenueExclTax, totalCostInclTax, netProfit };
  };

  const analysisRange = useMemo(() => getDateRange(selectedPeriod), [selectedPeriod]);
  const companyAnalysisProfit = useMemo(() => orders.reduce((sum, o) => (isOrderInPeriod(o, analysisRange) && o.status !== OrderStatus.REJECTED ? sum + calculateAnalysisMetrics(o).netProfit : sum), 0), [orders, analysisRange]);

  const analysisOrdersFiltered = useMemo(() => orders.filter(o => {
    const custMatch = selectedCustomerId === 'all' || o.customerId === selectedCustomerId || o.customerName === (customers.find(c => c.id === selectedCustomerId)?.name);
    return custMatch && isOrderInPeriod(o, analysisRange) && o.status !== OrderStatus.REJECTED;
  }), [orders, selectedCustomerId, analysisRange, customers]);

  const analysisTotals = useMemo(() => analysisOrdersFiltered.reduce((acc, o) => {
    const m = calculateAnalysisMetrics(o);
    return { revenue: acc.revenue + m.revenueExclTax, cost: acc.cost + m.totalCostInclTax, profit: acc.profit + m.netProfit };
  }, { revenue: 0, cost: 0, profit: 0 }), [analysisOrdersFiltered]);

  const contributionWeight = companyAnalysisProfit > 0 ? (analysisTotals.profit / companyAnalysisProfit) * 100 : 0;

  // --- RENDERING HELPERS ---
  const togglePrint = (active: boolean) => {
    setIsPrintPreview(active);
    if (active) {
      document.body.classList.add('force-print-mode');
      setTimeout(() => window.print(), 300);
    } else {
      document.body.classList.remove('force-print-mode');
    }
  };

  return (
    <div className="space-y-8 pb-20 animate-in fade-in duration-500">
      {/* Top Nav & Print */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 no-print">
        <div className="flex bg-white p-1 rounded-2xl border border-slate-200 shadow-sm">
          <button onClick={() => setActiveTab('audit')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'audit' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
            <i className="fa-solid fa-list-check mr-2"></i> Financial Audit
          </button>
          <button onClick={() => setActiveTab('analysis')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'analysis' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
            <i className="fa-solid fa-chart-pie mr-2"></i> Customer Performance
          </button>
        </div>
        <button
          onClick={() => activeTab === 'audit' ? togglePrint(!isPrintPreview) : window.print()}
          className="px-6 py-3 bg-white border border-slate-200 text-slate-900 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all shadow-sm flex items-center gap-2"
        >
          <i className="fa-solid fa-file-pdf"></i> {isPrintPreview ? 'Exit Preview' : 'Export Report'}
        </button>
      </div>

      {activeTab === 'audit' && (
        <div className="space-y-10">
          <div className="no-print space-y-4 font-bold">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Portfolio Gross Value</div>
                <div className="text-2xl font-black text-slate-800">{(auditActiveTotals.revenue + auditFulfilledTotals.revenue).toLocaleString()} <span className="text-xs font-bold opacity-30">L.E.</span></div>
              </div>
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Realized Margin</div>
                <div className="text-2xl font-black text-emerald-600">+{(auditActiveTotals.margin + auditFulfilledTotals.margin).toLocaleString()} <span className="text-xs font-bold opacity-30 text-slate-400">L.E.</span></div>
              </div>
              <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Global Audit Yield</div>
                <div className="text-2xl font-black text-blue-600">{(auditActiveTotals.revenue + auditFulfilledTotals.revenue) > 0 ? (((auditActiveTotals.margin + auditFulfilledTotals.margin) / (auditActiveTotals.revenue + auditFulfilledTotals.revenue)) * 100).toFixed(2) : '0.0'}%</div>
              </div>
            </div>
          </div>

          <div className={`${isPrintPreview ? 'block' : 'print-only'} mb-8 text-center border-b-2 border-slate-900 pb-6`}>
            <h1 className="text-3xl font-black uppercase tracking-tighter">Nexus ERP Financial Audit</h1>
            <p className="text-sm font-bold text-slate-600 mt-1 uppercase tracking-[0.3em]">Comprehensive Profitability Analysis</p>
          </div>

          <div className="space-y-12">
            {[{ label: 'Active Pipeline (Projected Margins)', data: activeAuditData, totals: auditActiveTotals, icon: 'fa-chart-line', theme: 'blue' }, { label: 'Realized Performance (Fulfilled Archive)', data: fulfilledAuditData, totals: auditFulfilledTotals, icon: 'fa-circle-check', theme: 'emerald' }].map((sec, idx) => (
              <div key={idx} className="space-y-4">
                <div className="flex items-center gap-3 px-2">
                  <div className={`w-8 h-8 rounded-lg bg-${sec.theme}-600 text-white flex items-center justify-center text-xs shadow-lg shadow-${sec.theme}-100`}>
                    <i className={`fa-solid ${sec.icon}`}></i>
                  </div>
                  <h4 className="text-sm font-black text-slate-800 uppercase tracking-tight">{sec.label}</h4>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden print-card">
                  <table className="w-full text-left text-sm border-collapse">
                    <thead className={`bg-${sec.theme}-50 text-[9px] font-black uppercase text-${sec.theme}-600 tracking-widest border-b`}>
                      <tr>
                        <th className="px-4 py-4">PO Identifier</th>
                        <th className="px-4 py-4">Customer</th>
                        <th className="px-4 py-4 text-right">Revenue</th>
                        <th className="px-4 py-4 text-right">Cost</th>
                        <th className="px-4 py-4 text-right">Margin</th>
                        <th className="px-4 py-4 text-center">Sales %</th>
                        <th className="px-4 py-4 text-center">Markup %</th>
                        <th className="px-4 py-4 text-right no-print">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sec.data.map((d) => (
                        <tr key={d.id} className={`group hover:bg-slate-50 transition-colors ${d.isBelowThreshold ? 'bg-rose-50/30' : ''}`}>
                          <td className="px-4 py-4 font-mono font-black text-blue-600 text-xs">
                            {d.internalOrderNumber}
                            {d.hasPendingCosts && (
                              <div className="text-[8px] font-black text-amber-600 uppercase mt-1 flex items-center gap-1">
                                <i className="fa-solid fa-clock"></i> Pending
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-800 text-xs truncate max-w-[150px]">{d.customerName}</td>
                          <td className="px-4 py-4 text-right font-black text-slate-700 text-xs">{d.revenue.toLocaleString()}</td>
                          <td className="px-4 py-4 text-right font-bold text-slate-500 text-xs">{d.cost.toLocaleString()}</td>
                          <td className={`px-4 py-4 text-right font-black text-xs ${d.marginAmt < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{d.marginAmt.toLocaleString()}</td>
                          <td className="px-4 py-4 text-center font-bold text-slate-600 text-xs">{d.marginPctOnSales.toFixed(1)}%</td>
                          <td className="px-4 py-4 text-center"><div className={`inline-flex px-2 py-0.5 rounded text-[10px] font-black ${d.isBelowThreshold ? 'bg-rose-600 text-white' : 'bg-emerald-100 text-emerald-800'}`}>{d.markupPct.toFixed(1)}%</div></td>
                          <td className="px-4 py-4 text-right no-print">
                            <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-${getDynamicOrderStatusStyle(d._originalOrder, config).color}-50 text-${getDynamicOrderStatusStyle(d._originalOrder, config).color}-600 border-${getDynamicOrderStatusStyle(d._originalOrder, config).color}-100`}>
                              {getDynamicOrderStatusStyle(d._originalOrder, config).label}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className={`bg-slate-900 text-white border-t-2 border-slate-900`}>
                      <tr className="font-black text-xs">
                        <td colSpan={2} className="px-4 py-6 text-right uppercase tracking-[0.2em] text-slate-400">Section Totals</td>
                        <td className="px-4 py-6 text-right">{sec.totals.revenue.toLocaleString()}</td>
                        <td className="px-4 py-6 text-right">{sec.totals.cost.toLocaleString()}</td>
                        <td className="px-4 py-6 text-right text-blue-400">{sec.totals.margin.toLocaleString()}</td>
                        <td colSpan={3} className="px-4 py-6 text-right text-[10px] text-slate-400 uppercase tracking-widest">Yield: {(sec.totals.revenue > 0 ? (sec.totals.margin / sec.totals.revenue) * 100 : 0).toFixed(2)}%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'analysis' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          {/* Controls Bar */}
          <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm flex flex-wrap gap-4 items-center no-print">
            <div className="relative group w-full md:w-64">
              <select className="w-full pl-10 pr-4 py-3 bg-slate-50 border-2 border-slate-50 rounded-2xl text-[10px] font-black uppercase appearance-none focus:bg-white focus:border-blue-500 transition-all outline-none text-slate-700" value={selectedCustomerId} onChange={e => setSelectedCustomerId(e.target.value)}>
                <option value="all">Global Portfolio</option>
                {[...customers].sort((a, b) => a.name.localeCompare(b.name)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"><i className="fa-solid fa-building text-xs"></i></div>
            </div>
            <div className="relative group w-full md:w-48">
              <select className="w-full pl-10 pr-4 py-3 bg-slate-50 border-2 border-slate-50 rounded-2xl text-[10px] font-black uppercase appearance-none focus:bg-white focus:border-blue-500 transition-all outline-none text-slate-700" value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value as Period)}>
                <option value="this_year">This Year</option>
                <option value="last_year">Last Year</option>
                <option value="last_12_months">Rolling 12M</option>
                <option value="all_time">All Time</option>
              </select>
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"><i className="fa-solid fa-calendar text-xs"></i></div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Revenue (Excl Tax)</p>
              <div className="text-2xl font-black text-slate-800">{analysisTotals.revenue.toLocaleString()} <span className="text-[10px] opacity-30">L.E.</span></div>
            </div>
            <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total Cost (Incl Tax)</p>
              <div className="text-2xl font-black text-slate-800">{analysisTotals.cost.toLocaleString()} <span className="text-[10px] opacity-30">L.E.</span></div>
            </div>
            <div className={`p-6 rounded-[2rem] shadow-2xl text-white ${analysisTotals.profit >= 0 ? 'bg-slate-900' : 'bg-rose-900'} transition-all`}>
              <p className="text-[10px] font-black opacity-40 uppercase tracking-widest mb-1">Net Portfolio Profit</p>
              <div className="text-2xl font-black">{analysisTotals.profit.toLocaleString()} <span className="text-[10px] opacity-30">L.E.</span></div>
            </div>
            <div className="bg-indigo-600 p-6 rounded-[2rem] shadow-2xl text-white relative overflow-hidden group">
              <div className="absolute -right-4 -bottom-4 opacity-10 rotate-12 group-hover:rotate-0 transition-transform">
                <i className="fa-solid fa-award text-8xl"></i>
              </div>
              <p className="text-[10px] font-black text-indigo-200 uppercase tracking-widest mb-1">Company Profit Weight</p>
              <div className="text-4xl font-black">{contributionWeight.toFixed(1)}%</div>
            </div>
          </div>

          <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden pb-4 transition-all">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
              <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Period Transactions Ledger</h3>
              <div className="text-[10px] font-black text-slate-700 bg-slate-50 px-4 py-2 rounded-full border border-slate-100 uppercase tracking-tight"> {analysisOrdersFiltered.length} Records </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b">
                  <tr><th className="px-8 py-5">PO Identifier</th><th className="px-8 py-5 text-right">Revenue (Excl Tax)</th><th className="px-8 py-5 text-right">Cost (Incl Tax)</th><th className="px-8 py-5 text-right">Net Profit</th><th className="px-8 py-5 text-center">Margin %</th><th className="px-8 py-5 text-right">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analysisOrdersFiltered.map(o => {
                    const m = calculateAnalysisMetrics(o);
                    return (
                      <tr key={o.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-8 py-5 whitespace-nowrap"><div className="font-mono font-black text-blue-600 text-xs">{o.internalOrderNumber}</div><div className="text-[8px] font-bold text-slate-400 mt-1 uppercase italic">{o.customerName}</div></td>
                        <td className="px-8 py-5 text-right font-black text-slate-700 text-xs">{m.revenueExclTax.toLocaleString()}</td>
                        <td className="px-8 py-5 text-right font-bold text-slate-500 text-xs">{m.totalCostInclTax.toLocaleString()}</td>
                        <td className={`px-8 py-5 text-right font-black text-xs ${m.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{m.netProfit.toLocaleString()}</td>
                        <td className="px-8 py-5 text-center"><div className="inline-flex px-3 py-1 rounded bg-slate-100 text-[10px] font-black text-slate-700">{(m.revenueExclTax > 0 ? (m.netProfit / m.revenueExclTax) * 100 : 0).toFixed(1)}%</div></td>
                        <td className="px-8 py-5 text-right"><span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-${getDynamicOrderStatusStyle(o, config).color}-50 text-${getDynamicOrderStatusStyle(o, config).color}-600 border-${getDynamicOrderStatusStyle(o, config).color}-100`}>{getDynamicOrderStatusStyle(o, config).label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
