
import React, { useState, useMemo, useEffect } from 'react';
import { CustomerOrder, AppConfig, OrderStatus, Customer, Supplier, LedgerEntry } from '../types';
import { STATUS_CONFIG, getDynamicOrderStatusStyle } from '../constants';
import { dataService } from '../services/dataService';

interface ProfitabilityReportProps {
  orders: CustomerOrder[];
  config: AppConfig;
}

type Period = 'this_year' | 'last_year' | 'last_12_months' | 'all_time';
type MainTab = 'audit' | 'analysis' | 'supplier';

export const ProfitabilityReport: React.FC<ProfitabilityReportProps> = ({ orders, config }) => {
  const [activeTab, setActiveTab] = useState<MainTab>('audit');

  // Tab 1 (Audit) State
  const [isPrintPreview, setIsPrintPreview] = useState(false);

  // Tab 2 (Analysis) State
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('all');
  const [selectedPeriod, setSelectedPeriod] = useState<Period>('this_year');
   const [customers, setCustomers] = useState<Customer[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);

  // Tab 3 (Supplier) State
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>(['all']);
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);
  const [supplierLedger, setSupplierLedger] = useState<any>(null);
  const [spLoading, setSpLoading] = useState(false);
  const [spError, setSpError] = useState('');
  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);

  useEffect(() => {
    dataService.getCustomers().then(setCustomers);
    dataService.getSuppliers().then(setSuppliers);
    dataService.getLedgerEntries().then(setLedgerEntries);
    loadSupplierLedger(['all']);
  }, []);

  const loadSupplierLedger = async (ids: string[]) => {
    if (ids.length === 0) { setSupplierLedger(null); return; }
    setSpLoading(true); setSpError('');
    try {
      const param = ids.includes('all') ? 'all' : ids.join(',');
      const raw = await dataService.getSupplierLedger(param);
      setSupplierLedger({
        ...raw.summary,
        pendingObligations: raw.summary?.totalPending || 0,
        components: raw.components || [],
        payments: raw.payments || [],
        supplier: raw.supplier,
      });
    } catch (e: any) {
      setSpError('Failed to load supplier ledger: ' + e.message);
    } finally {
      setSpLoading(false);
    }
  };

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
      if (order.appliesWithholdingTax) revenue *= 0.99;

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
    const orderDate = new Date(order.orderDate || order.dataEntryTimestamp || Date.now());
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
    if (order.appliesWithholdingTax) revenueExclTax *= 0.99;

    const netProfit = revenueExclTax - totalCostInclTax;
    return { revenueExclTax, totalCostInclTax, netProfit };
  };

  const analysisRange = useMemo(() => getDateRange(selectedPeriod), [selectedPeriod]);
  const companyAnalysisProfit = useMemo(() => orders.reduce((sum, o) => (isOrderInPeriod(o, analysisRange) && o.status !== OrderStatus.REJECTED ? sum + calculateAnalysisMetrics(o).netProfit : sum), 0), [orders, analysisRange]);

  const analysisOrdersFiltered = useMemo(() => orders.filter(o => {
    const custMatch = selectedCustomerId === 'all' || o.customerName === (customers.find(c => c.id === selectedCustomerId)?.name);
    return custMatch && isOrderInPeriod(o, analysisRange) && o.status !== OrderStatus.REJECTED;
  }), [orders, selectedCustomerId, analysisRange, customers]);

  const analysisTotals = useMemo(() => analysisOrdersFiltered.reduce((acc, o) => {
    const m = calculateAnalysisMetrics(o);
    return { revenue: acc.revenue + m.revenueExclTax, cost: acc.cost + m.totalCostInclTax, profit: acc.profit + m.netProfit };
  }, { revenue: 0, cost: 0, profit: 0 }), [analysisOrdersFiltered]);

  const contributionWeight = companyAnalysisProfit > 0 ? (analysisTotals.profit / companyAnalysisProfit) * 100 : 0;

  const totalManualLedgerExpenses = useMemo(() => {
    return ledgerEntries.reduce((sum, entry) => {
      if (entry.type !== 'COST') return sum;
      const entryDate = new Date(entry.date);
      if (analysisRange && (entryDate < analysisRange.start || entryDate > analysisRange.end)) return sum;
      return sum + entry.amount;
    }, 0);
  }, [ledgerEntries, analysisRange]);

  const weightedOverhead = totalManualLedgerExpenses * (contributionWeight / 100);
  const totalProjectExpenses = analysisTotals.cost + weightedOverhead;
  const relevantProfit = analysisTotals.revenue - totalProjectExpenses;
  
  const relevantRoiPct = totalProjectExpenses > 0 
    ? (relevantProfit / totalProjectExpenses) * 100 
    : 0;

  const weightedPlPct = analysisTotals.revenue > 0
    ? (relevantProfit / analysisTotals.revenue) * 100
    : 0;

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
          <button onClick={() => setActiveTab('supplier')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'supplier' ? 'bg-amber-500 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
            <i className="fa-solid fa-truck-field mr-2"></i> Supplier Performance
          </button>
        </div>
        <button
          onClick={() => togglePrint(!isPrintPreview)}
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
                <div className="text-2xl font-black text-emerald-600">{(auditActiveTotals.margin + auditFulfilledTotals.margin).toLocaleString()} <span className="text-xs font-bold opacity-30 text-slate-400">L.E.</span></div>
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
            <div className="bg-emerald-600 p-6 rounded-[2rem] shadow-2xl text-white relative overflow-hidden group">
              <div className="absolute -right-4 -bottom-4 opacity-10 -rotate-12 group-hover:rotate-0 transition-transform">
                <i className="fa-solid fa-scale-balanced text-8xl"></i>
              </div>
              <p className="text-[10px] font-black text-emerald-200 uppercase tracking-widest mb-1">Current Relevant ROI</p>
              <div className="text-4xl font-black">{relevantRoiPct.toFixed(1)}%</div>
              <p className="text-[7px] font-bold text-emerald-100/60 mt-2 uppercase leading-tight">
                Formula: (Total Revenue - Total Expenses) / Total Expenses<br/>
                *Total Expenses = Direct Costs + Weighted Overhead
              </p>
            </div>
            <div className="bg-emerald-700 p-6 rounded-[2rem] shadow-2xl text-white relative overflow-hidden group">
              <div className="absolute -right-4 -bottom-4 opacity-10 rotate-45 group-hover:rotate-0 transition-transform">
                <i className="fa-solid fa-percent text-8xl"></i>
              </div>
              <p className="text-[10px] font-black text-emerald-200 uppercase tracking-widest mb-1">Weighted P/L (%)</p>
              <div className="text-4xl font-black">{weightedPlPct.toFixed(1)}%</div>
              <p className="text-[7px] font-bold text-emerald-100/60 mt-2 uppercase leading-tight">
                Formula: (Total Revenue - Total Expenses) / Total Revenue<br/>
                *Total Expenses = Direct Costs + Weighted Overhead
              </p>
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

      {activeTab === 'supplier' && (
        <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
          <div className={`${isPrintPreview ? 'block' : 'print-only'} mb-8 text-center border-b-2 border-slate-900 pb-6`}>
            <h1 className="text-3xl font-black uppercase tracking-tighter">Supplier Performance Report</h1>
            <p className="text-sm font-bold text-slate-600 mt-1 uppercase tracking-[0.3em]">
              {selectedSupplierIds.includes('all') 
                ? 'ALL SUPPLIERS' 
                : (() => {
                    const names = suppliers.filter(s => selectedSupplierIds.includes(s.id)).map(s => s.name);
                    return names.length > 0 ? names.join(', ') : 'Selected Suppliers';
                  })()}
            </p>
          </div>
          {/* Supplier Selector */}
          <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm flex flex-wrap gap-4 items-center no-print">
            <div className="relative w-full md:w-96">
              <button 
                onClick={() => setShowSupplierDropdown(!showSupplierDropdown)}
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border-2 border-slate-50 rounded-2xl text-[10px] font-black uppercase text-left focus:bg-white focus:border-blue-500 transition-all outline-none text-slate-700 flex justify-between items-center"
              >
                <span>
                  {selectedSupplierIds.includes('all') 
                    ? 'ALL SUPPLIERS' 
                    : selectedSupplierIds.length === 0 
                      ? '-- CHOOSE SUPPLIERS --' 
                      : (() => {
                          const names = suppliers.filter(s => selectedSupplierIds.includes(s.id)).map(s => s.name);
                          if (names.length <= 2) return names.join(', ');
                          return `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
                        })()}
                </span>
                <i className={`fa-solid fa-chevron-${showSupplierDropdown ? 'up' : 'down'} text-[8px]`}></i>
              </button>
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none pb-0.5">
                <i className="fa-solid fa-truck-ramp-box text-xs"></i>
              </div>

              {showSupplierDropdown && (
                <div className="absolute z-50 mt-2 w-full bg-white border border-slate-200 shadow-2xl rounded-2xl p-4 space-y-2 max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
                  <label className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-xl cursor-pointer transition-colors group">
                    <input 
                      type="checkbox" 
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={selectedSupplierIds.includes('all')}
                      onChange={() => {
                        const next = ['all'];
                        setSelectedSupplierIds(next);
                        loadSupplierLedger(next);
                        setShowSupplierDropdown(false);
                      }}
                    />
                    <span className="text-[10px] font-black uppercase text-slate-700 group-hover:text-blue-600">ALL SUPPLIERS</span>
                  </label>
                  <div className="h-px bg-slate-100 my-2"></div>
                  {[...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map(s => (
                    <label key={s.id} className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded-xl cursor-pointer transition-colors group">
                      <input 
                        type="checkbox" 
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        checked={selectedSupplierIds.includes(s.id)}
                        onChange={() => {
                          let next = [...selectedSupplierIds].filter(id => id !== 'all');
                          if (next.includes(s.id)) {
                            next = next.filter(id => id !== s.id);
                          } else {
                            next.push(s.id);
                          }
                          if (next.length === 0) next = [];
                          setSelectedSupplierIds(next);
                          loadSupplierLedger(next);
                        }}
                      />
                      <span className="text-[10px] font-black uppercase text-slate-700 group-hover:text-blue-600">{s.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {selectedSupplierIds.length > 0 && !selectedSupplierIds.includes('all') && (
              <button 
                onClick={() => { setSelectedSupplierIds(['all']); loadSupplierLedger(['all']); }}
                className="text-[8px] font-black uppercase text-blue-600 hover:text-blue-700 underline underline-offset-4"
              >
                Reset to All
              </button>
            )}
          </div>

          {spError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-[2rem] font-bold text-sm">
              <i className="fa-solid fa-circle-exclamation mr-2"></i>{spError}
            </div>
          )}

          {spLoading && (
            <div className="py-12 bg-white rounded-[2rem] border border-slate-200 text-center text-slate-400">
              <i className="fa-solid fa-spinner fa-spin text-2xl text-amber-500 mb-2"></i>
              <div className="text-sm font-bold">Loading supplier ledger...</div>
            </div>
          )}

          {selectedSupplierIds.length > 0 && supplierLedger && !spLoading && (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-6 gap-4 print:grid-cols-6">
                {[
                  { label: 'Total Ordered', value: supplierLedger.totalCommitted, color: 'blue', icon: 'fa-file-contract' },
                  { label: 'Total Received Value', value: supplierLedger.totalDelivered, color: 'emerald', icon: 'fa-truck-ramp-box' },
                  { label: 'Paid to Supplier', value: supplierLedger.totalPaid, color: 'violet', icon: 'fa-money-bill-wave' },
                  { label: 'Received Balance', value: (supplierLedger.totalPaid || 0) - (supplierLedger.totalDelivered || 0), color: ((supplierLedger.totalPaid || 0) - (supplierLedger.totalDelivered || 0)) < 0 ? 'red' : 'emerald', icon: 'fa-scale-balanced', hint: '(Negative means he needs more money for received items)' },
                  { label: 'Future Expected', value: supplierLedger.pendingObligations, color: 'amber', icon: 'fa-hourglass-half', hint: '(Value of items not yet delivered)' },
                  { label: 'Overall Balance', value: (supplierLedger.totalCommitted || 0) - (supplierLedger.totalPaid || 0), color: ((supplierLedger.totalCommitted || 0) - (supplierLedger.totalPaid || 0)) < 0 ? 'red' : 'slate', icon: 'fa-sigma', hint: '(Positive: Owed | Negative: Overpaid)' },
                ].map((card, i) => (
                  <div key={i} className={`p-6 rounded-[2rem] shadow-sm border border-${card.color}-100 bg-${card.color}-50 flex flex-col justify-between`}>
                    <div>
                      <p className={`text-[9px] font-black uppercase tracking-widest text-${card.color}-500 mb-1`}><i className={`fa-solid ${card.icon} mr-1`}></i> {card.label}</p>
                      <div className={`text-xl font-black text-${card.color}-700`}>{(card.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-[10px] opacity-50">L.E.</span></div>
                    </div>
                    {card.hint && <p className={`text-[8px] font-bold text-${card.color}-400 mt-2 italic lowercase`}>{card.hint}</p>}
                  </div>
                ))}
              </div>

              {/* Payment History */}
              {supplierLedger.payments && supplierLedger.payments.length > 0 && (
                <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden pb-4">
                  <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight"><i className="fa-solid fa-clock-rotate-left text-violet-500 mr-2"></i> Payment History</h3>
                    <div className="text-[10px] font-black text-slate-700 bg-slate-50 px-4 py-2 rounded-full border border-slate-100 uppercase tracking-tight">{supplierLedger.payments.length} Payments</div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                      <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b">
                        <tr><th className="px-8 py-4">Date</th><th className="px-8 py-4 text-right">Amount</th><th className="px-8 py-4">Memo</th><th className="px-8 py-4">Recorded By</th><th className="px-8 py-4 w-10"></th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {supplierLedger.payments.map((p: any) => (
                          <React.Fragment key={p.id}>
                            <tr className="hover:bg-slate-50/50 transition-colors cursor-pointer" onClick={() => setExpandedPaymentId(expandedPaymentId === p.id ? null : p.id)}>
                              <td className="px-8 py-4 text-xs font-bold text-slate-600">{new Date(p.date).toLocaleDateString()}</td>
                              <td className="px-8 py-4 text-right font-black text-slate-800">{p.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</td>
                              <td className="px-8 py-4 text-xs font-medium text-slate-500">{p.memo || '-'}</td>
                              <td className="px-8 py-4 text-xs font-bold text-slate-500">{p.user || '-'}</td>
                              <td className="px-8 py-4 text-right"><i className={`fa-solid fa-chevron-${expandedPaymentId === p.id ? 'up' : 'down'} text-slate-400 text-[10px]`}></i></td>
                            </tr>
                            {expandedPaymentId === p.id && p.allocations && p.allocations.length > 0 && (
                              <tr className="bg-slate-50/50">
                                <td colSpan={5} className="px-8 py-4 border-t border-slate-100">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-blue-500 mb-2">FIFO Allocation Breakdown</div>
                                  <table className="w-full text-left">
                                    <thead><tr><th className="px-3 py-2 text-[9px] font-black uppercase text-slate-400">Order#</th><th className="px-3 py-2 text-[9px] font-black uppercase text-slate-400">Item</th><th className="px-3 py-2 text-[9px] font-black uppercase text-slate-400 text-right">Allocated</th></tr></thead>
                                    <tbody>
                                      {p.allocations.map((a: any, ai: number) => (
                                        <tr key={ai} className="border-t border-slate-200/50">
                                          <td className="px-3 py-2 text-xs font-mono font-bold text-blue-600">{a.orderNumber || a.componentNumber || '-'}</td>
                                          <td className="px-3 py-2 text-xs font-medium text-slate-600 truncate max-w-[300px]">{a.description || '-'}</td>
                                          <td className="px-3 py-2 text-xs font-black text-slate-800 text-right">{a.allocatedAmount?.toLocaleString(undefined, {minimumFractionDigits:2})} L.E.</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Component Orders (FIFO) */}
              {supplierLedger.components && supplierLedger.components.length > 0 && (
                <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden pb-4">
                  <div className="p-8 border-b border-slate-100 flex justify-between items-center">
                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight"><i className="fa-solid fa-boxes-stacked text-amber-500 mr-2"></i> Component Orders (FIFO)</h3>
                    <div className="text-[10px] font-black text-slate-700 bg-slate-50 px-4 py-2 rounded-full border border-slate-100 uppercase tracking-tight">{supplierLedger.components.length} Items</div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap">
                      <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b">
                        <tr><th className="px-4 py-4">Order#</th><th className="px-4 py-4">PO#</th><th className="px-4 py-4">Items Desc.</th><th className="px-4 py-4 text-right">Qty</th><th className="px-4 py-4 text-right">Price</th><th className="px-4 py-4 text-right">Total Price</th><th className="px-4 py-4 text-right">Received Qty</th><th className="px-4 py-4 text-right">Received Val</th><th className="px-4 py-4 text-right">Paid/Allocated</th><th className="px-4 py-4 text-right">Status</th></tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {supplierLedger.components.map((c: any, ci: number) => (
                          <tr key={ci} className="hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-4 font-mono font-bold text-blue-600">{c.orderNumber || '-'}</td>
                            <td className="px-4 py-4 font-bold text-slate-500">{c.poNumber || '-'}</td>
                            <td className="px-4 py-4 font-medium text-slate-700 max-w-[200px] truncate">{c.description}</td>
                            <td className="px-4 py-4 font-bold text-slate-700 text-right">{c.quantity}</td>
                            <td className="px-4 py-4 font-bold text-slate-700 text-right">{(c.unitCost || 0).toLocaleString()}</td>
                            <td className="px-4 py-4 font-black text-slate-700 text-right">{(c.totalCost || 0).toLocaleString()}</td>
                            <td className="px-4 py-4 font-bold text-emerald-600 text-right">{c.receivedQty || 0}</td>
                            <td className="px-4 py-4 font-black text-emerald-700 text-right">{(c.deliveredValue || 0).toLocaleString()}</td>
                            <td className="px-4 py-4 font-black text-violet-600 text-right cursor-help" title={`Unallocated Balance: ${Math.max(0, c.totalCost - (c.allocatedPayments || 0)).toLocaleString()}`}>{(c.allocatedPayments || 0).toLocaleString()}</td>
                            <td className="px-4 py-4 text-right"><span className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${c.status === 'CONSUMED' || c.status === 'Manufactured' || c.status === 'RECEIVED' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-amber-50 text-amber-600 border-amber-100'}`}>{c.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
