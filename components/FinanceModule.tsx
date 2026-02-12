import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, Customer, Supplier, OrderStatus, AppConfig, User } from '../types';
import { STATUS_CONFIG } from '../constants';

interface FinanceModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

type FinanceTab = 'orders' | 'margins' | 'billing' | 'ar' | 'entities';

const getStatusLimit = (order: CustomerOrder, settings: any) => {
  const status = order.status;
  switch(status) {
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
    case OrderStatus.DELIVERED:
    case OrderStatus.PARTIAL_PAYMENT:
      return (order.paymentSlaDays || settings.defaultPaymentSlaDays) * 24;
    default: return 0;
  }
};

const ThresholdSentinel: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
  const [remaining, setRemaining] = useState<number>(0);
  
  useEffect(() => {
    const calc = () => {
      const limitHrs = getStatusLimit(order, config.settings);
      if (limitHrs === 0) return;
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, config.settings, order.paymentSlaDays]);

  const limitHrs = getStatusLimit(order, config.settings);
  if (limitHrs === 0) return null;

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  
  let timeStr = "";
  if (hrs > 24) {
    const days = Math.floor(hrs / 24);
    const remHrs = hrs % 24;
    timeStr = `${days}d ${remHrs}h`;
  } else {
    timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  }

  return (
    <div className={`text-[9px] font-black uppercase mt-1 flex items-center gap-1.5 ${isOver ? 'text-rose-500 animate-pulse' : 'text-emerald-500'}`}>
      <i className={`fa-solid ${isOver ? 'fa-triangle-exclamation' : 'fa-clock'}`}></i>
      {isOver ? `Term Breached by ${timeStr}` : `${timeStr} left`}
    </div>
  );
};

export const FinanceModule: React.FC<FinanceModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [activeTab, setActiveTab] = useState<FinanceTab>('orders');
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [decisionModal, setDecisionModal] = useState<{
    type: 'orderHold' | 'orderReject' | 'customerHold' | 'supplierBlacklist' | 'marginRelease' | 'billing' | 'payment' | 'cancelInvoice' | 'cancelPayment' | 'revertToSourcing';
    entityId: string;
    entityName: string;
    currentValue?: boolean;
    extraData?: any;
  } | null>(null);
  
  const [comment, setComment] = useState('');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  const fetchData = async () => {
    try {
        const [o, c, s] = await Promise.all([
            dataService.getOrders(),
            dataService.getCustomers(),
            dataService.getSuppliers()
        ]);
        setOrders(o);
        setCustomers(c);
        setSuppliers(s);
    } catch (e) {
        console.error("Finance sync error:", e);
    } finally {
        setLoading(false);
    }
  };

  const getPL = (order: CustomerOrder) => {
    let revenue = 0;
    let grossRevenue = 0;
    let cost = 0;
    order.items.forEach(it => {
        const lineNet = it.quantity * it.pricePerUnit;
        revenue += lineNet;
        grossRevenue += lineNet * (1 + (it.taxPercent / 100));
        it.components?.forEach(c => cost += (c.quantity * (c.unitCost || 0)));
    });
    const paid = (order.payments || []).reduce((s, p) => s + p.amount, 0);
    const marginPct = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;
    const markupPct = cost > 0 ? ((revenue - cost) / cost) * 100 : (revenue > 0 ? 100 : 0);
    return { revenue, grossRevenue, cost, marginPct, markupPct, paid, outstanding: Math.max(0, grossRevenue - paid) };
  };

  const ordersWithPL = useMemo(() => orders.map(o => ({ ...o, pl: getPL(o) })), [orders]);

  const filteredOrders = useMemo(() => {
    const q = search.toLowerCase().trim();
    return ordersWithPL.filter(o => 
        (o.internalOrderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q)) &&
        ![OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status)
    );
  }, [ordersWithPL, search]);

  const handleExecuteDecision = async () => {
    if (!decisionModal) return;
    if (!['billing'].includes(decisionModal.type) && !comment.trim()) { setErrorMsg("Audit memo is mandatory"); return; }

    setIsProcessing(true);
    try {
        switch (decisionModal.type) {
            case 'orderHold': await dataService.setOrderHold(decisionModal.entityId, !decisionModal.currentValue, comment, currentUser.username); break;
            case 'orderReject': await dataService.rejectOrder(decisionModal.entityId, comment, currentUser.username); break;
            case 'customerHold': await dataService.setCustomerHold(decisionModal.entityId, !decisionModal.currentValue, comment, currentUser.username); break;
            case 'supplierBlacklist': 
                if (decisionModal.currentValue) await dataService.removeSupplierBlacklist(decisionModal.entityId, comment, currentUser.username);
                else await dataService.blacklistSupplier(decisionModal.entityId, comment, currentUser.username);
                break;
            case 'marginRelease': await dataService.releaseMarginBlock(decisionModal.entityId, comment, currentUser.username); break;
            case 'billing': await dataService.issueInvoice(decisionModal.entityId, currentUser.username); break;
            case 'payment': 
                const amt = parseFloat(paymentAmount) || 0;
                if (amt <= 0) throw new Error("Amount must be greater than zero");
                await dataService.recordPayment(decisionModal.entityId, amt, comment, currentUser.username); 
                break;
            case 'cancelInvoice': await dataService.cancelInvoice(decisionModal.entityId, comment, currentUser.username); break;
            case 'cancelPayment': await dataService.cancelPayment(decisionModal.entityId, decisionModal.extraData.index, comment, currentUser.username); break;
            case 'revertToSourcing': await dataService.revertInvoicedOrderToSourcing(decisionModal.entityId, comment, currentUser.username); break;
        }
        await fetchData();
        closeModals();
    } catch (e: any) {
        setErrorMsg(e.message || "Action failed");
    } finally {
        setIsProcessing(false);
    }
  };

  const closeModals = () => { setDecisionModal(null); setComment(''); setPaymentAmount(''); setErrorMsg(null); };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
        <div className="flex gap-1 p-1 bg-slate-200 rounded-2xl w-fit shadow-inner">
          {(['orders', 'margins', 'billing', 'ar', 'entities'] as const).map(tab => (
            <button 
              key={tab} 
              onClick={() => setActiveTab(tab)}
              className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {tab === 'margins' && orders.some(o => o.status === OrderStatus.NEGATIVE_MARGIN) && <span className="mr-2 w-2 h-2 rounded-full bg-rose-500 inline-block animate-pulse"></span>}
              {tab.replace(/([A-Z])/g, ' $1')}
            </button>
          ))}
        </div>
        <div className="relative w-full lg:w-96">
            <input 
              type="text" placeholder="Filter Ledger..." 
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={search} onChange={e => setSearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
        </div>
      </div>

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
        <table className="w-full text-left">
          <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-white/5">
            <tr>
              <th className="px-8 py-5 text-white">Operational Context</th>
              {activeTab === 'entities' ? (
                <>
                  <th className="px-8 py-5 text-white">Entity Type</th>
                  <th className="px-8 py-5 text-white">Account Status</th>
                  <th className="px-8 py-5 text-white text-right">Credit Action</th>
                </>
              ) : (
                <>
                  <th className="px-8 py-5 text-white">Revenue Metrics</th>
                  <th className="px-8 py-5 text-white">Markup Analysis</th>
                  <th className="px-8 py-5 text-white">SLA / Status</th>
                  <th className="px-8 py-5 text-white text-right">Auth Actions</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {activeTab === 'entities' ? (
                <>
                  {customers.map(c => (
                    <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-8 py-6">
                        <div className="font-black text-slate-800">{c.name}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Customer Account</div>
                      </td>
                      <td className="px-8 py-6 text-xs font-bold text-slate-500 uppercase tracking-tighter">Client Relations</td>
                      <td className="px-8 py-6">
                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${c.isHold ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                           {c.isHold ? 'CREDIT HOLD' : 'ACCOUNT ACTIVE'}
                        </span>
                      </td>
                      <td className="px-8 py-6 text-right">
                        <button onClick={() => setDecisionModal({ type: 'customerHold', entityId: c.id, entityName: c.name, currentValue: c.isHold })} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${c.isHold ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-rose-600 text-white hover:bg-rose-700'}`}>
                           {c.isHold ? 'Release Hold' : 'Engage Credit Hold'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {suppliers.map(s => (
                    <tr key={s.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-8 py-6">
                        <div className="font-black text-slate-800">{s.name}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">Vendor Entity</div>
                      </td>
                      <td className="px-8 py-6 text-xs font-bold text-slate-500 uppercase tracking-tighter">Supply Chain</td>
                      <td className="px-8 py-6">
                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${s.isBlacklisted ? 'bg-slate-900 text-white border-black' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                           {s.isBlacklisted ? 'BLACKLISTED' : 'APPROVED VENDOR'}
                        </span>
                      </td>
                      <td className="px-8 py-6 text-right">
                        <button onClick={() => setDecisionModal({ type: 'supplierBlacklist', entityId: s.id, entityName: s.name, currentValue: s.isBlacklisted })} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${s.isBlacklisted ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-900 text-white hover:bg-black'}`}>
                           {s.isBlacklisted ? 'Restore Vendor' : 'Blacklist Vendor'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </>
            ) : filteredOrders.map(o => {
                const pl = o.pl;
                const isBreach = pl.markupPct < config.settings.minimumMarginPct;
                const showRow = activeTab === 'orders' || 
                                (activeTab === 'margins' && o.status === OrderStatus.NEGATIVE_MARGIN) ||
                                (activeTab === 'billing' && [OrderStatus.IN_PRODUCT_HUB, OrderStatus.ISSUE_INVOICE].includes(o.status)) ||
                                (activeTab === 'ar' && [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.PARTIAL_PAYMENT].includes(o.status));

                if (!showRow) return null;

                const isInvoicedOrLater = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.PARTIAL_PAYMENT].includes(o.status);

                return (
                  <tr key={o.id} className={`hover:bg-slate-50/80 transition-colors ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-rose-50/20' : ''}`}>
                    <td className="px-8 py-6">
                       <div className="font-mono text-[10px] font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                       <div className="font-bold text-slate-800 text-sm tracking-tight mt-0.5">{o.customerName}</div>
                       {o.invoiceNumber && <div className="text-[9px] font-black text-emerald-600 uppercase mt-1">Tax Invoice: {o.invoiceNumber}</div>}
                    </td>
                    <td className="px-8 py-6">
                       <div className="font-black text-slate-700 text-xs">Gross: {pl.grossRevenue.toLocaleString()} L.E.</div>
                       <div className="text-[10px] text-slate-400 font-bold mt-1">Paid: {pl.paid.toLocaleString()} • Bal: {pl.outstanding.toLocaleString()}</div>
                    </td>
                    <td className="px-8 py-6">
                       <div className={`inline-flex px-2 py-0.5 rounded text-[10px] font-black ${isBreach ? 'bg-rose-600 text-white shadow-sm animate-pulse' : 'bg-emerald-100 text-emerald-800'}`}>
                          {pl.markupPct.toFixed(1)}% Markup
                       </div>
                       <div className="text-[9px] text-slate-400 font-bold uppercase mt-1">Target: {config.settings.minimumMarginPct}%</div>
                    </td>
                    <td className="px-8 py-6">
                       <div className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border w-fit bg-${STATUS_CONFIG[o.status].color}-50 text-${STATUS_CONFIG[o.status].color}-600 border-${STATUS_CONFIG[o.status].color}-100`}>
                          {STATUS_CONFIG[o.status].label}
                       </div>
                       <ThresholdSentinel order={o} config={config} />
                    </td>
                    <td className="px-8 py-6 text-right">
                       <div className="flex gap-2 justify-end items-center">
                          {isInvoicedOrLater && (
                            <button 
                              onClick={() => setDecisionModal({ type: 'cancelInvoice', entityId: o.id, entityName: o.internalOrderNumber })}
                              className="px-4 py-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg text-[9px] font-black uppercase hover:bg-rose-100 transition-all flex items-center gap-2"
                              title="Void current invoice and return to Billing stage"
                            >
                               <i className="fa-solid fa-file-circle-xmark"></i> Void Invoice
                            </button>
                          )}
                          
                          {o.status === OrderStatus.NEGATIVE_MARGIN && (
                             <button onClick={() => setDecisionModal({ type: 'marginRelease', entityId: o.id, entityName: o.internalOrderNumber })} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-rose-200">Force Authorization</button>
                          )}
                          {(o.status === OrderStatus.IN_PRODUCT_HUB || o.status === OrderStatus.ISSUE_INVOICE) && (
                             <button onClick={() => setDecisionModal({ type: 'billing', entityId: o.id, entityName: o.internalOrderNumber })} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-blue-200">Generate Invoice</button>
                          )}
                          {[OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED, OrderStatus.PARTIAL_PAYMENT].includes(o.status) && (
                             <button onClick={() => { setDecisionModal({ type: 'payment', entityId: o.id, entityName: o.internalOrderNumber }); setPaymentAmount(pl.outstanding.toString()); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-emerald-200">Collect Payment</button>
                          )}
                          <div className="flex gap-1">
                             <button onClick={() => setDecisionModal({ type: 'orderHold', entityId: o.id, entityName: o.internalOrderNumber, currentValue: o.status === OrderStatus.IN_HOLD })} className="p-2 text-slate-300 hover:text-amber-500 transition-colors" title="Toggle Hold"><i className="fa-solid fa-hand"></i></button>
                             <button onClick={() => setDecisionModal({ type: 'orderReject', entityId: o.id, entityName: o.internalOrderNumber })} className="p-2 text-slate-300 hover:text-rose-500 transition-colors" title="Reject Order"><i className="fa-solid fa-ban"></i></button>
                          </div>
                       </div>
                    </td>
                  </tr>
                );
            })}
          </tbody>
        </table>
        {filteredOrders.length === 0 && !loading && (
          <div className="p-20 text-center flex flex-col items-center gap-3 text-slate-300 italic uppercase font-black tracking-widest text-xs">
             <i className="fa-solid fa-vault text-5xl opacity-10 mb-4"></i>
             Financial queue is empty
          </div>
        )}
      </div>

      {decisionModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
           <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 border border-slate-100">
              <div className="flex items-center gap-6 mb-8">
                 <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-3xl shadow-inner ${
                    decisionModal.type === 'cancelInvoice' || decisionModal.type === 'revertToSourcing' ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600'
                 }`}>
                    <i className={`fa-solid ${
                        decisionModal.type === 'billing' ? 'fa-file-invoice-dollar' : 
                        decisionModal.type === 'payment' ? 'fa-money-bill-transfer' : 
                        decisionModal.type === 'marginRelease' ? 'fa-chart-line-down' : 
                        decisionModal.type === 'cancelInvoice' ? 'fa-file-circle-xmark' :
                        decisionModal.type === 'revertToSourcing' ? 'fa-rotate-left' : 'fa-shield-halved'
                    }`}></i>
                 </div>
                 <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                        {decisionModal.type === 'cancelInvoice' ? 'Void Official Invoice' : 
                         decisionModal.type === 'revertToSourcing' ? 'Strategic Lifecycle Revert' : 
                         decisionModal.type.replace(/([A-Z])/g, ' $1') + ' Task'}
                    </h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Target: {decisionModal.entityName}</p>
                 </div>
              </div>

              {errorMsg && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3 animate-pulse"><i className="fa-solid fa-circle-exclamation"></i>{errorMsg}</div>}

              <div className="space-y-6">
                 {decisionModal.type === 'cancelInvoice' && (
                    <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100 mb-2">
                        <p className="text-xs font-bold text-rose-800 leading-relaxed">
                            Critical: Voiding this invoice will remove the Tax Invoice number and return the order to the <strong>Issue Invoice</strong> stage. This action is permanent and recorded for audit purposes.
                        </p>
                    </div>
                 )}
                 {decisionModal.type === 'revertToSourcing' && (
                    <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100 mb-2">
                        <p className="text-xs font-bold text-amber-800 leading-relaxed">
                            Warning: This action will <strong>void the existing invoice</strong> and return the order to Procurement. Components will be reset to "RFP Sent" status to allow re-awarding.
                        </p>
                    </div>
                 )}
                 {decisionModal.type === 'payment' && (
                    <div className="space-y-1.5">
                       <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Payment Collection Amount (L.E.)</label>
                       <input 
                         type="number" step="any" autoFocus
                         className="w-full p-4 border rounded-2xl bg-slate-50 font-black text-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                         value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)}
                       />
                    </div>
                 )}
                 <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Governance Audit Memo / Comment</label>
                    <textarea 
                      placeholder="Enter specific reasoning for this action..."
                      className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white h-24"
                      value={comment} onChange={e => setComment(e.target.value)}
                    />
                 </div>
              </div>

              <div className="mt-10 flex gap-3">
                 <button onClick={closeModals} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200">Abort</button>
                 <button 
                   onClick={handleExecuteDecision} disabled={isProcessing}
                   className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${
                       decisionModal.type === 'cancelInvoice' ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-100' :
                       decisionModal.type === 'revertToSourcing' ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-100' : 
                       'bg-slate-900 text-white hover:bg-black'
                   }`}
                 >
                    {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check-double"></i>}
                    {decisionModal.type === 'cancelInvoice' ? 'Void & Re-Issue' : 
                     decisionModal.type === 'revertToSourcing' ? 'Commit Revert' : 'Commit Authorization'}
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};