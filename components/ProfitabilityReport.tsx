
import React, { useState, useMemo, useEffect } from 'react';
import { CustomerOrder, AppConfig, OrderStatus } from '../types';
import { STATUS_CONFIG } from '../constants';

interface ProfitabilityReportProps {
  orders: CustomerOrder[];
  config: AppConfig;
}

export const ProfitabilityReport: React.FC<ProfitabilityReportProps> = ({ orders, config }) => {
  const [isPrintPreview, setIsPrintPreview] = useState(false);

  // Split logic: Active vs Fulfilled
  const openOrders = useMemo(() => {
    return orders.filter(o => o.status !== OrderStatus.FULFILLED && o.status !== OrderStatus.REJECTED);
  }, [orders]);

  const fulfilledOrders = useMemo(() => {
    return orders.filter(o => o.status === OrderStatus.FULFILLED);
  }, [orders]);

  const processData = (orderList: CustomerOrder[]) => {
    return orderList.map(order => {
      let revenue = 0;
      let cost = 0;
      let hasPendingCosts = false;

      order.items.forEach(item => {
        revenue += (item.quantity * item.pricePerUnit);
        item.components?.forEach(comp => {
          const componentTotal = comp.quantity * (comp.unitCost || 0);
          cost += componentTotal;
          if (comp.unitCost === 0 && comp.source === 'PROCUREMENT') {
            hasPendingCosts = true;
          }
        });
      });

      const marginAmt = revenue - cost;
      const marginPctOnSales = revenue > 0 ? (marginAmt / revenue) * 100 : 0;
      const markupPct = cost > 0 ? (marginAmt / cost) * 100 : (revenue > 0 ? 100 : 0);
      
      const isBelowThreshold = markupPct < config.settings.minimumMarginPct;

      return {
        id: order.id,
        internalOrderNumber: order.internalOrderNumber,
        customerName: order.customerName,
        status: order.status,
        revenue,
        cost,
        marginAmt,
        marginPctOnSales,
        markupPct,
        hasPendingCosts,
        isBelowThreshold
      };
    });
  };

  const activeReportData = useMemo(() => processData(openOrders), [openOrders, config.settings.minimumMarginPct]);
  const fulfilledReportData = useMemo(() => processData(fulfilledOrders), [fulfilledOrders, config.settings.minimumMarginPct]);

  const activeTotals = useMemo(() => {
    return activeReportData.reduce((acc, curr) => ({
      revenue: acc.revenue + curr.revenue,
      cost: acc.cost + curr.cost,
      margin: acc.margin + curr.marginAmt
    }), { revenue: 0, cost: 0, margin: 0 });
  }, [activeReportData]);

  const fulfilledTotals = useMemo(() => {
    return fulfilledReportData.reduce((acc, curr) => ({
      revenue: acc.revenue + curr.revenue,
      cost: acc.cost + curr.cost,
      margin: acc.margin + curr.marginAmt
    }), { revenue: 0, cost: 0, margin: 0 });
  }, [fulfilledReportData]);

  const globalTotals = {
    revenue: activeTotals.revenue + fulfilledTotals.revenue,
    margin: activeTotals.margin + fulfilledTotals.margin
  };

  const togglePrintMode = (active: boolean) => {
    setIsPrintPreview(active);
    if (active) {
      document.body.classList.add('force-print-mode');
      setTimeout(() => {
        try {
          window.print();
        } catch (e) {
          console.warn("Scripted print blocked by sandbox. User must use Ctrl+P.");
        }
      }, 300);
    } else {
      document.body.classList.remove('force-print-mode');
    }
  };

  useEffect(() => {
    return () => document.body.classList.remove('force-print-mode');
  }, []);

  return (
    <div className="space-y-10 pb-20">
      <div className="flex justify-between items-center no-print">
        <div>
          <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Financial Profitability Audit</h3>
          <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Global P&L and realized margin ledger</p>
        </div>
        <div className="flex gap-2">
          {isPrintPreview ? (
            <button 
              type="button"
              onClick={() => togglePrintMode(false)}
              className="px-6 py-2.5 bg-slate-100 text-slate-600 font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-slate-200 shadow-sm transition-all flex items-center gap-2"
            >
              <i className="fa-solid fa-arrow-left"></i>
              Exit Print Preview
            </button>
          ) : (
            <button 
              type="button"
              onClick={() => togglePrintMode(true)}
              className="px-6 py-2.5 bg-slate-900 text-white font-black text-[10px] uppercase tracking-widest rounded-xl hover:bg-black shadow-xl transition-all flex items-center gap-2"
            >
              <i className="fa-solid fa-file-pdf"></i>
              Export Financial Audit
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 no-print">
         <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Portfolio Gross Value</div>
            <div className="text-2xl font-black text-slate-800">{globalTotals.revenue.toLocaleString()} <span className="text-xs font-bold opacity-30">L.E.</span></div>
         </div>
         <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Realized & Projected Margin</div>
            <div className="text-2xl font-black text-emerald-600">+{globalTotals.margin.toLocaleString()} <span className="text-xs font-bold opacity-30 text-slate-400">L.E.</span></div>
         </div>
         <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Average Portfolio Yield</div>
            <div className="text-2xl font-black text-blue-600">{globalTotals.revenue > 0 ? ((globalTotals.margin / globalTotals.revenue) * 100).toFixed(2) : '0.00'}%</div>
         </div>
      </div>

      {isPrintPreview && (
        <div className="no-print p-4 bg-blue-600 text-white rounded-2xl shadow-xl flex items-center justify-between gap-4 animate-in slide-in-from-top-4">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center">
              <i className="fa-solid fa-print"></i>
            </div>
            <div>
              <p className="text-sm font-bold">Print Preview Mode Active</p>
              <p className="text-[10px] opacity-80 uppercase tracking-tight font-medium">Standard financial audit format engaged.</p>
            </div>
          </div>
        </div>
      )}

      {/* Print Header */}
      <div className={`${isPrintPreview ? 'block' : 'print-only'} mb-8 text-center border-b-2 border-slate-900 pb-6`}>
        <h1 className="text-3xl font-black uppercase tracking-tighter">Nexus ERP Financial Audit</h1>
        <p className="text-sm font-bold text-slate-600 mt-1 uppercase tracking-[0.3em]">Comprehensive Profitability Analysis</p>
        <div className="flex justify-center gap-8 mt-4 text-[10px] font-black text-slate-400">
          <span>AUDIT DATE: {new Date().toLocaleDateString()}</span>
          <span>SYSTEM THRESHOLD: {config.settings.minimumMarginPct}%</span>
          <span>TOTAL POs IN SCOPE: {activeReportData.length + fulfilledReportData.length}</span>
        </div>
      </div>

      {/* ACTIVE PO SECTION */}
      <div className="space-y-4">
        <div className="flex items-center gap-3 px-2">
           <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center text-xs shadow-lg shadow-blue-100">
             <i className="fa-solid fa-chart-line"></i>
           </div>
           <h4 className="text-sm font-black text-slate-800 uppercase tracking-tight">Active Pipeline (Projected Margins)</h4>
        </div>
        
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden print-card">
          <table className="w-full text-left text-sm border-collapse">
            <thead className="bg-slate-50 print-bg-fix text-[9px] font-black uppercase text-slate-400 tracking-widest border-b">
              <tr>
                <th className="px-4 py-4">PO Identifier</th>
                <th className="px-4 py-4">Customer</th>
                <th className="px-4 py-4 text-right">Revenue</th>
                <th className="px-4 py-4 text-right">Exp. Cost</th>
                <th className="px-4 py-4 text-right">Exp. Margin</th>
                <th className="px-4 py-4 text-center">Sales %</th>
                <th className="px-4 py-4 text-center">Markup %</th>
                <th className="px-4 py-4 text-right no-print">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeReportData.map((data) => (
                <tr key={data.id} className={`group hover:bg-slate-50 transition-colors ${data.isBelowThreshold ? 'bg-rose-50/30' : ''}`}>
                  <td className="px-4 py-4">
                    <div className="font-mono font-black text-blue-600 text-xs">{data.internalOrderNumber}</div>
                    {data.hasPendingCosts && (
                      <div className="text-[8px] font-black text-amber-600 uppercase mt-1 flex items-center gap-1">
                        <i className="fa-solid fa-clock"></i> Pending Costs
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4 font-bold text-slate-800 text-xs truncate max-w-[150px]">{data.customerName}</td>
                  <td className="px-4 py-4 text-right font-black text-slate-700 text-xs">{data.revenue.toLocaleString()}</td>
                  <td className="px-4 py-4 text-right font-bold text-slate-500 text-xs">{data.cost.toLocaleString()}</td>
                  <td className="px-4 py-4 text-right font-black text-slate-900 text-xs">
                    <span className={data.marginAmt < 0 ? 'text-rose-600' : 'text-emerald-700'}>
                      {data.marginAmt.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className="font-bold text-slate-600 text-xs">{data.marginPctOnSales.toFixed(1)}%</div>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className={`inline-flex px-2 py-0.5 rounded text-[10px] font-black ${data.isBelowThreshold ? 'bg-rose-600 text-white' : 'bg-emerald-100 text-emerald-800'}`}>
                      {data.markupPct.toFixed(1)}%
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right no-print">
                     <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-${STATUS_CONFIG[data.status].color}-50 text-${STATUS_CONFIG[data.status].color}-600 border-${STATUS_CONFIG[data.status].color}-100`}>
                       {STATUS_CONFIG[data.status].label}
                     </span>
                  </td>
                </tr>
              ))}
              {activeReportData.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-300 italic text-xs">No active orders in pipeline.</td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-slate-900 text-white print-bg-fix border-t-2 border-slate-900">
              <tr className="font-black text-xs">
                <td colSpan={2} className="px-4 py-6 text-right uppercase tracking-[0.2em] text-slate-400">Pipeline Totals</td>
                <td className="px-4 py-6 text-right">{activeTotals.revenue.toLocaleString()}</td>
                <td className="px-4 py-6 text-right">{activeTotals.cost.toLocaleString()}</td>
                <td className="px-4 py-6 text-right text-blue-400">{activeTotals.margin.toLocaleString()}</td>
                <td colSpan={3} className="px-4 py-6 text-right">
                  <div className="text-[10px] text-slate-400 uppercase tracking-widest">
                    Pipeline Yield: {(activeTotals.revenue > 0 ? (activeTotals.margin / activeTotals.revenue) * 100 : 0).toFixed(2)}%
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* FULFILLED PO SECTION */}
      <div className="space-y-4 page-break">
        <div className="flex items-center gap-3 px-2">
           <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center text-xs shadow-lg shadow-emerald-100">
             <i className="fa-solid fa-circle-check"></i>
           </div>
           <h4 className="text-sm font-black text-slate-800 uppercase tracking-tight">Realized Performance (Fulfilled Archive)</h4>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden print-card">
          <table className="w-full text-left text-sm border-collapse">
            <thead className="bg-emerald-50 print-bg-fix text-[9px] font-black uppercase text-emerald-600 tracking-widest border-b border-emerald-100">
              <tr>
                <th className="px-4 py-4">PO Identifier</th>
                <th className="px-4 py-4">Customer</th>
                <th className="px-4 py-4 text-right">Final Revenue</th>
                <th className="px-4 py-4 text-right">Final Cost</th>
                <th className="px-4 py-4 text-right">Net Profit</th>
                <th className="px-4 py-4 text-center">Sales %</th>
                <th className="px-4 py-4 text-center">Markup %</th>
                <th className="px-4 py-4 text-right no-print">Terminal State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fulfilledReportData.map((data) => (
                <tr key={data.id} className="group hover:bg-emerald-50/20 transition-colors">
                  <td className="px-4 py-4">
                    <div className="font-mono font-black text-emerald-600 text-xs">{data.internalOrderNumber}</div>
                  </td>
                  <td className="px-4 py-4 font-bold text-slate-800 text-xs truncate max-w-[150px]">{data.customerName}</td>
                  <td className="px-4 py-4 text-right font-black text-slate-700 text-xs">{data.revenue.toLocaleString()}</td>
                  <td className="px-4 py-4 text-right font-bold text-slate-500 text-xs">{data.cost.toLocaleString()}</td>
                  <td className="px-4 py-4 text-right font-black text-emerald-700 text-xs">
                    {data.marginAmt.toLocaleString()}
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className="font-bold text-slate-600 text-xs">{data.marginPctOnSales.toFixed(1)}%</div>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className="inline-flex px-2 py-0.5 rounded text-[10px] font-black bg-emerald-100 text-emerald-800">
                      {data.markupPct.toFixed(1)}%
                    </div>
                  </td>
                  <td className="px-4 py-4 text-right no-print">
                     <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded border bg-emerald-50 text-emerald-600 border-emerald-100">
                       FULFILLED
                     </span>
                  </td>
                </tr>
              ))}
              {fulfilledReportData.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-300 italic text-xs">No historical fulfilled data available.</td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-emerald-900 text-white print-bg-fix border-t-2 border-emerald-900">
              <tr className="font-black text-xs">
                <td colSpan={2} className="px-4 py-6 text-right uppercase tracking-[0.2em] text-emerald-200">Historical Totals</td>
                <td className="px-4 py-6 text-right">{fulfilledTotals.revenue.toLocaleString()}</td>
                <td className="px-4 py-6 text-right">{fulfilledTotals.cost.toLocaleString()}</td>
                <td className="px-4 py-6 text-right text-emerald-400">{fulfilledTotals.margin.toLocaleString()}</td>
                <td colSpan={3} className="px-4 py-6 text-right">
                  <div className="text-[10px] text-emerald-200 uppercase tracking-widest">
                    Realized Yield: {(fulfilledTotals.revenue > 0 ? (fulfilledTotals.margin / fulfilledTotals.revenue) * 100 : 0).toFixed(2)}%
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="bg-blue-50/50 p-6 rounded-2xl border border-blue-100 no-print">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
             <i className="fa-solid fa-circle-info"></i>
          </div>
          <div className="space-y-1">
             <h4 className="text-xs font-black text-blue-900 uppercase">Calculation Methodology</h4>
             <p className="text-[11px] text-blue-800 leading-relaxed font-medium">
               Markup % is calculated as (Revenue - Cost) / Cost. Fulfilled POs represent completed commercial cycles where full revenue has been recognized and all costs are final.
             </p>
          </div>
        </div>
      </div>
    </div>
  );
};
