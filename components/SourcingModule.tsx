import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig, User, Customer, CustomerOrderItem } from '../types';
import { getItemEffectiveQty, getOrderConversionRate, getOrderPoType, getPoTypeConfig } from '../utils';
import { useLanguage, LanguageProvider } from '../contexts/LanguageContext';
import { LanguageToggle } from './LanguageToggle';

interface SourcingModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const SourcingModuleInner: React.FC<SourcingModuleProps> = ({ config, refreshKey, currentUser }) => {
  const { t, language } = useLanguage();
  const isAr = language === 'ar';

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'READY_HUB' | 'PARTIAL_AUTH' | 'FULLY_AUTH' | 'NO_CLEARANCE'>('ALL');
  const [expandedOrderIds, setExpandedOrderIds] = useState<Record<string, boolean>>({});
  const [showCustomerStatusDrawer, setShowCustomerStatusDrawer] = useState<string | null>(null);

  // Inputs for dispatch authorization: [itemId]: string quantity
  const [dispatchReceiptInputs, setDispatchReceiptInputs] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [allOrders, allCustomers] = await Promise.all([
        dataService.getOrders(),
        dataService.getCustomers()
      ]);
      setOrders(allOrders);
      setCustomers(allCustomers);
    } catch (err: any) {
      console.error('Failed to load sourcing data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  // Financial status calculation per order
  const getOrderFinancials = useCallback((order: CustomerOrder) => {
    let grossRevenue = 0;
    let netRevenue = 0;
    let outputTax = 0;

    (order.items || []).forEach(it => {
      const lineNet = getItemEffectiveQty(it) * (it.pricePerUnit || 0);
      netRevenue += lineNet;
      const taxRate = it.taxPercent !== undefined ? it.taxPercent : 14;
      const lineTax = lineNet * (taxRate / 100);
      outputTax += lineTax;
      grossRevenue += lineNet + lineTax;
    });

    const targetRev = order.appliesWithholdingTax ? grossRevenue * 0.99 : grossRevenue;
    const paid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const balance = Math.max(0, targetRev - paid);
    const coveragePct = targetRev > 0 ? Math.min(100, Math.round((paid / targetRev) * 100)) : 0;

    return {
      grossRevenue,
      netRevenue,
      targetRev,
      paid,
      balance,
      coveragePct,
      currency: order.currency || 'L.E.'
    };
  }, []);

  // Aggregated customer financial status across all non-rejected orders
  const getCustomerOverallFinancials = useCallback((customerName: string) => {
    const custOrders = orders.filter(o => 
      o.customerName?.trim().toLowerCase() === customerName.trim().toLowerCase() && 
      o.status !== OrderStatus.REJECTED && 
      (o.status as string) !== 'REJECTED'
    );

    let totalGrossRevenue = 0;
    let totalTargetRev = 0;
    let totalPaid = 0;

    custOrders.forEach(o => {
      const fin = getOrderFinancials(o);
      totalGrossRevenue += fin.grossRevenue;
      totalTargetRev += fin.targetRev;
      totalPaid += fin.paid;
    });

    const totalBalance = Math.max(0, totalTargetRev - totalPaid);
    const matchedCustomer = customers.find(c => c.name?.trim().toLowerCase() === customerName.trim().toLowerCase());
    const walletBalance = matchedCustomer?.walletBalance || 0;

    return {
      ordersCount: custOrders.length,
      totalGrossRevenue,
      totalPaid,
      totalBalance,
      walletBalance,
      currency: 'L.E.'
    };
  }, [orders, customers, getOrderFinancials]);

  // Filter orders eligible for Delivery Authorization (active orders in pipeline or with hub/dispatch items)
  const eligibleOrders = useMemo(() => {
    return orders.filter(o => {
      if (o.status === OrderStatus.REJECTED || (o.status as string) === 'REJECTED') return false;
      if (o.customerName?.trim().toLowerCase() === 'internal stock') return false;
      if (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-')) return false;

      // Include all open orders in the pipeline or orders with items in hub/authorized
      const isFulfilled = o.status === OrderStatus.FULFILLED || (o.status as string) === 'FULFILLED';
      if (isFulfilled) {
        return (o.items || []).some(it => (it.hubReceivedQty || 0) > 0 || (it.approvedForDispatchQty || 0) > 0);
      }
      return true;
    });
  }, [orders]);

  // Overall KPIs
  const kpis = useMemo(() => {
    let hubReadyOrdersCount = 0;
    let totalHubUnits = 0;
    let totalAuthorizedUnits = 0;
    let totalPendingClearance = 0;
    let totalHubGrossValue = 0;

    eligibleOrders.forEach(o => {
      let orderHasPending = false;
      (o.items || []).forEach(it => {
        const inHub = it.hubReceivedQty || 0;
        const auth = it.approvedForDispatchQty || 0;
        const pending = Math.max(0, inHub - auth);
        const grossUnit = (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));

        totalHubUnits += inHub;
        totalAuthorizedUnits += auth;
        totalPendingClearance += pending;
        totalHubGrossValue += inHub * grossUnit;

        if (pending > 0) orderHasPending = true;
      });

      if (orderHasPending) hubReadyOrdersCount++;
    });

    return {
      hubReadyOrdersCount,
      totalHubUnits,
      totalAuthorizedUnits,
      totalPendingClearance,
      totalHubGrossValue
    };
  }, [eligibleOrders]);

  // Filtered orders based on user controls
  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();

    return eligibleOrders.filter(o => {
      // Customer filter
      if (selectedCustomerId !== 'ALL') {
        const cust = customers.find(c => c.id === selectedCustomerId);
        if (cust && o.customerName?.trim().toLowerCase() !== cust.name?.trim().toLowerCase()) {
          return false;
        }
      }

      // Status filter
      if (statusFilter === 'READY_HUB') {
        const hasPending = (o.items || []).some(it => ((it.hubReceivedQty || 0) - (it.approvedForDispatchQty || 0)) > 0);
        if (!hasPending) return false;
      } else if (statusFilter === 'PARTIAL_AUTH') {
        const isPartial = (o.items || []).some(it => (it.approvedForDispatchQty || 0) > 0 && (it.approvedForDispatchQty || 0) < (it.hubReceivedQty || 0));
        if (!isPartial) return false;
      } else if (statusFilter === 'FULLY_AUTH') {
        const isFullyAuth = (o.items || []).length > 0 && (o.items || []).every(it => (it.approvedForDispatchQty || 0) >= (it.hubReceivedQty || 0) && (it.hubReceivedQty || 0) > 0);
        if (!isFullyAuth) return false;
      } else if (statusFilter === 'NO_CLEARANCE') {
        const totalHub = (o.items || []).reduce((s, it) => s + (it.hubReceivedQty || 0), 0);
        const totalApproved = (o.items || []).reduce((s, it) => s + (it.approvedForDispatchQty || 0), 0);
        if (totalHub > 0 || totalApproved > 0) return false;
      }

      // Text search
      if (!q) return true;
      const matchInternal = o.internalOrderNumber?.toLowerCase().includes(q);
      const matchPo = o.customerReferenceNumber?.toLowerCase().includes(q);
      const matchCustomer = o.customerName?.toLowerCase().includes(q);
      const matchProject = o.projectName?.toLowerCase().includes(q);
      const matchItem = (o.items || []).some(it => it.description?.toLowerCase().includes(q));

      return matchInternal || matchPo || matchCustomer || matchProject || matchItem;
    }).sort((a, b) => {
      const tA = new Date(a.orderDate || a.dataEntryTimestamp || 0).getTime();
      const tB = new Date(b.orderDate || b.dataEntryTimestamp || 0).getTime();
      return tB - tA;
    });
  }, [eligibleOrders, search, selectedCustomerId, statusFilter, customers]);

  const toggleOrderExpand = (orderId: string) => {
    setExpandedOrderIds(prev => ({ ...prev, [orderId]: !prev[orderId] }));
  };

  const handleExpandAll = () => {
    const next: Record<string, boolean> = {};
    filteredOrders.forEach(o => { next[o.id] = true; });
    setExpandedOrderIds(next);
  };

  const handleCollapseAll = () => {
    setExpandedOrderIds({});
  };

  // Perform dispatch receipt authorization
  const handleAuthorizeDispatch = async (order: CustomerOrder, item: CustomerOrderItem, bypassSuggested: boolean) => {
    const qtyStr = dispatchReceiptInputs[item.id];
    const qty = parseFloat(qtyStr);

    if (isNaN(qty) || qty <= 0) {
      alert(isAr ? 'يرجى إدخال كمية اعتماد صالحة أكبر من 0' : 'Please enter a valid authorization quantity greater than 0.');
      return;
    }

    const inHub = item.hubReceivedQty || 0;
    const currentApproved = item.approvedForDispatchQty || 0;
    const maxAuth = Math.max(0, inHub - currentApproved);

    if (qty > maxAuth) {
      alert(isAr ? `لا يمكن اعتماد كمية (${qty}) تتجاوز الجاهز بالمركز (${maxAuth}).` : `Cannot authorize ${qty} units. Exceeds items available in hub (${maxAuth}).`);
      return;
    }

    setIsProcessing(true);
    setMessage(null);
    try {
      const note = bypassSuggested 
        ? 'Sourcing authorized delivery with manual bypass of suggested downpayment coverage.'
        : 'Sourcing authorized delivery within downpayment coverage limit.';

      await dataService.approveDispatchReceipt(order.id, [{ itemId: item.id, qty, bypass: bypassSuggested } as any], note);
      
      setMessage({
        type: 'success',
        text: isAr 
          ? `تم اعتماد تسليم ${qty} ${item.unit || 'قطع'} للبند "${item.description}" بنجاح!` 
          : `Successfully authorized ${qty} ${item.unit || 'units'} of "${item.description}" for delivery!`
      });

      // Clear input
      setDispatchReceiptInputs(prev => ({ ...prev, [item.id]: '' }));
      await fetchData();
    } catch (e: any) {
      setMessage({ type: 'error', text: e.message || 'Failed to authorize delivery.' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-16" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-gradient-to-tr from-sky-600 to-indigo-600 rounded-2xl flex items-center justify-center text-white text-2xl shadow-lg shadow-sky-200">
            <i className="fa-solid fa-dolly"></i>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                {isAr ? 'إدارة التسليمات واعتماد الشحن (تسليمات)' : 'Delivery & Sourcing Authorizations (Taslemat)'}
              </h1>
              <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-sky-100 text-sky-700 border border-sky-200">
                {isAr ? 'تسليمات' : 'Sourcing Hub'}
              </span>
            </div>
            <p className="text-xs font-bold text-slate-400 mt-1">
              {isAr ? 'متابعة جاهزية البضائع بالمركز واعتماد أذون التسليم بناءً على دفعات العملاء' : 'Monitor hub readiness and authorize delivery releases based on customer payments'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch md:self-auto">
          <LanguageToggle />
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5"
            title={isAr ? 'تحديث' : 'Refresh'}
          >
            <i className={`fa-solid fa-rotate ${loading ? 'fa-spin text-sky-600' : ''}`}></i>
            <span className="hidden sm:inline">{isAr ? 'تحديث' : 'Refresh'}</span>
          </button>
          <button
            onClick={handleExpandAll}
            className="px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition-colors"
          >
            {isAr ? 'توسيع الكل' : 'Expand All'}
          </button>
          <button
            onClick={handleCollapseAll}
            className="px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-xs font-bold transition-colors"
          >
            {isAr ? 'طي الكل' : 'Collapse All'}
          </button>
        </div>
      </div>

      {/* Notification Banner */}
      {message && (
        <div className={`p-4 rounded-2xl border flex items-center justify-between gap-3 animate-in slide-in-from-top-2 duration-300 ${
          message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
          message.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800' :
          'bg-sky-50 border-sky-200 text-sky-800'
        }`}>
          <div className="flex items-center gap-3">
            <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check text-emerald-600' : message.type === 'error' ? 'fa-triangle-exclamation text-rose-600' : 'fa-circle-info text-sky-600'} text-lg`}></i>
            <span className="text-xs font-bold">{message.text}</span>
          </div>
          <button onClick={() => setMessage(null)} className="text-slate-400 hover:text-slate-600 p-1">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      {/* Top 4 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Tile 1: Hub Ready Orders */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {isAr ? 'طلبات بها بضاعة بالمركز' : 'Orders Ready in Hub'}
            </p>
            <h3 className="text-2xl font-black text-slate-800 mt-1">{kpis.hubReadyOrdersCount}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-0.5">
              <span>{isAr ? 'القيمة الإجمالية:' : 'Total Value:'} </span>
              {kpis.totalHubGrossValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} {isAr ? 'ج.م' : 'L.E.'}
            </p>
          </div>
          <div className="w-12 h-12 bg-sky-50 text-sky-600 rounded-2xl flex items-center justify-center text-xl">
            <i className="fa-solid fa-boxes-packing"></i>
          </div>
        </div>

        {/* Tile 2: Total Units in Hub */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {isAr ? 'إجمالي القطع بالمركز' : 'Total Units in Hub'}
            </p>
            <h3 className="text-2xl font-black text-sky-600 mt-1">{kpis.totalHubUnits.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-0.5">
              {isAr ? 'بالمخزن بانتظار الاعتماد' : 'In product hub awaiting release'}
            </p>
          </div>
          <div className="w-12 h-12 bg-sky-50 text-sky-600 rounded-2xl flex items-center justify-center text-xl">
            <i className="fa-solid fa-warehouse"></i>
          </div>
        </div>

        {/* Tile 3: Total Authorized Units */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {isAr ? 'إجمالي المعتمد للتسليم' : 'Total Authorized for Release'}
            </p>
            <h3 className="text-2xl font-black text-emerald-600 mt-1">{kpis.totalAuthorizedUnits.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-0.5">
              {isAr ? 'مصرح بشحنها للعميل' : 'Cleared for shipment to client'}
            </p>
          </div>
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center text-xl">
            <i className="fa-solid fa-file-circle-check"></i>
          </div>
        </div>

        {/* Tile 4: Pending Clearance Decision */}
        <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              {isAr ? 'بانتظار قرار الاعتماد' : 'Awaiting Authorization'}
            </p>
            <h3 className="text-2xl font-black text-amber-600 mt-1">{kpis.totalPendingClearance.toLocaleString()}</h3>
            <p className="text-[10px] font-bold text-slate-400 mt-0.5">
              {isAr ? 'جاهزة وتتطلب قرار التسليم' : 'In hub awaiting clearance decision'}
            </p>
          </div>
          <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center text-xl">
            <i className="fa-solid fa-hourglass-half"></i>
          </div>
        </div>
      </div>

      {/* Filter and Search Toolbar */}
      <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
          {/* Universal Search */}
          <div className="relative flex-1 w-full">
            <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={isAr ? 'ابحث برقم أمر الشراء، الطلب الداخلي، العميل، البند، المشروع...' : 'Search PO, internal #, customer, item, project...'}
              className="w-full pl-11 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-700 outline-none focus:bg-white focus:border-sky-500 focus:ring-4 focus:ring-sky-100 transition-all"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1">
                <i className="fa-solid fa-circle-xmark"></i>
              </button>
            )}
          </div>

          {/* Customer Filter */}
          <div className="w-full md:w-64">
            <select
              value={selectedCustomerId}
              onChange={e => setSelectedCustomerId(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-700 outline-none focus:bg-white focus:border-sky-500 transition-all cursor-pointer"
            >
              <option value="ALL">{isAr ? 'جميع العملاء' : 'All Customers'}</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Status Pill Filters */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 mr-2">
            {isAr ? 'تصفية الحالة:' : 'Filter Status:'}
          </span>
          {[
            { id: 'ALL', label: isAr ? 'جميع الطلبات' : 'All Orders' },
            { id: 'READY_HUB', label: isAr ? 'بانتظار الاعتماد (جاهز)' : 'Pending Clearance (In Hub)' },
            { id: 'PARTIAL_AUTH', label: isAr ? 'معتمد جزئياً' : 'Partially Cleared' },
            { id: 'FULLY_AUTH', label: isAr ? 'مكتمل الاعتماد' : 'Fully Cleared' },
            { id: 'NO_CLEARANCE', label: isAr ? 'لا يوجد اعتماد بعد' : 'No Clearance Yet' }
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id as any)}
              className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
                statusFilter === f.id 
                  ? 'bg-sky-600 text-white shadow-md shadow-sky-200' 
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.label}
            </button>
          ))}
          <span className="text-[10px] font-bold text-slate-400 ml-auto">
            {isAr ? `إجمالي النتائج: ${filteredOrders.length}` : `Showing ${filteredOrders.length} orders`}
          </span>
        </div>
      </div>

      {/* Orders List */}
      <div className="space-y-4">
        {filteredOrders.length === 0 ? (
          <div className="bg-white p-16 rounded-3xl border border-slate-200 text-center space-y-3">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 mx-auto text-2xl">
              <i className="fa-solid fa-boxes-stacked"></i>
            </div>
            <h4 className="text-sm font-black uppercase tracking-wider text-slate-700">
              {isAr ? 'لا توجد طلبات بانتظار اعتماد التسليم حالياً' : 'No orders pending delivery authorization'}
            </h4>
            <p className="text-xs font-medium text-slate-400 max-w-md mx-auto">
              {isAr ? 'تظهر هنا أوامر الشراء التي وصلت منتجاتها إلى المركز (Product Hub) لاعتماد تسليمها للعميل بناءً على الدفعات وموافقة التسليمات.' : 'Customer orders with items received in the Product Hub appear here for delivery release based on payment coverage and sourcing decisions.'}
            </p>
          </div>
        ) : (
          filteredOrders.map(order => {
            const isExpanded = Boolean(expandedOrderIds[order.id]);
            const orderFin = getOrderFinancials(order);
            const custOverall = getCustomerOverallFinancials(order.customerName);
            const poType = getOrderPoType(order);
            const poConfig = getPoTypeConfig(poType);

            // Compute total already authorized gross on this order
            let totalAuthorizedGross = 0;
            let currentDraftSum = 0;

            (order.items || []).forEach(it => {
              const grossUnit = (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
              totalAuthorizedGross += (it.approvedForDispatchQty || 0) * grossUnit;
              const draftQty = parseFloat(dispatchReceiptInputs[it.id]) || 0;
              currentDraftSum += draftQty * grossUnit;
            });

            return (
              <div 
                key={order.id} 
                className={`bg-white rounded-3xl border transition-all duration-200 overflow-hidden shadow-sm ${
                  isExpanded ? 'border-sky-300 ring-2 ring-sky-100 shadow-md' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                {/* Order Header Summary Bar */}
                <div 
                  onClick={() => toggleOrderExpand(order.id)}
                  className="p-5 cursor-pointer select-none flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 hover:bg-slate-50/60 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-xs font-black text-sky-700 bg-sky-50 px-2.5 py-1 rounded-xl border border-sky-200">
                      {order.internalOrderNumber}
                    </span>

                    {order.customerReferenceNumber && (
                      <span className="font-mono text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-xl border border-slate-200">
                        {isAr ? 'أمر شراء:' : 'PO:'} {order.customerReferenceNumber}
                      </span>
                    )}

                    <span className="text-sm font-black text-slate-800">
                      {order.customerName}
                    </span>

                    {order.projectName && (
                      <span className="px-2 py-0.5 rounded-lg bg-violet-50 text-violet-700 border border-violet-200 text-[10px] font-bold">
                        <i className="fa-solid fa-diagram-project mr-1"></i> {order.projectName}
                      </span>
                    )}

                    <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase border ${poConfig.badgeClass}`}>
                      <i className={`fa-solid ${poConfig.icon} mr-1`}></i> {poConfig.shortLabel}
                    </span>

                    {(() => {
                      const totalOrderHub = (order.items || []).reduce((s, it) => s + (it.hubReceivedQty || 0), 0);
                      const totalOrderApproved = (order.items || []).reduce((s, it) => s + (it.approvedForDispatchQty || 0), 0);
                      const totalOrderPending = (order.items || []).reduce((s, it) => s + Math.max(0, (it.hubReceivedQty || 0) - (it.approvedForDispatchQty || 0)), 0);

                      let cBadge = {
                        text: isAr ? 'لا يوجد اعتماد بعد' : 'No clearance yet',
                        cls: 'bg-slate-100 text-slate-500 border-slate-200',
                        icon: 'fa-hourglass-start'
                      };

                      if (totalOrderHub > 0 || totalOrderApproved > 0) {
                        if (totalOrderPending > 0) {
                          if (totalOrderApproved > 0) {
                            cBadge = {
                              text: isAr ? 'معتمد جزئياً' : 'Partially Cleared',
                              cls: 'bg-amber-50 text-amber-800 border-amber-200',
                              icon: 'fa-clock-rotate-left'
                            };
                          } else {
                            cBadge = {
                              text: isAr ? 'بانتظار الاعتماد' : 'Pending Clearance',
                              cls: 'bg-sky-50 text-sky-800 border-sky-200',
                              icon: 'fa-boxes-packing'
                            };
                          }
                        } else {
                          cBadge = {
                            text: isAr ? 'مكتمل الاعتماد والتسليم' : 'Fully Cleared',
                            cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
                            icon: 'fa-circle-check'
                          };
                        }
                      }

                      return (
                        <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase border flex items-center gap-1 ${cBadge.cls}`}>
                          <i className={`fa-solid ${cBadge.icon}`}></i> {cBadge.text}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Financial Snapshot Badges for this Order */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="px-3 py-1 bg-slate-50 rounded-xl border border-slate-200 text-[10px] font-bold text-slate-600">
                      <span>{isAr ? 'قيمة الأمر:' : 'Order Total:'} </span>
                      <strong className="text-slate-900">{orderFin.grossRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</strong>
                    </div>

                    <div className="px-3 py-1 bg-emerald-50 rounded-xl border border-emerald-200 text-[10px] font-bold text-emerald-800">
                      <span>{isAr ? 'المدفوع:' : 'Paid:'} </span>
                      <strong className="text-emerald-900">{orderFin.paid.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</strong>
                    </div>

                    <div className="px-3 py-1 bg-amber-50 rounded-xl border border-amber-200 text-[10px] font-bold text-amber-800">
                      <span>{isAr ? 'المتبقي:' : 'Left:'} </span>
                      <strong className="text-amber-900">{orderFin.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</strong>
                    </div>

                    <div className={`px-2.5 py-1 rounded-xl text-[10px] font-black uppercase ${
                      orderFin.coveragePct >= 100 ? 'bg-emerald-100 text-emerald-800' :
                      orderFin.coveragePct >= 50 ? 'bg-sky-100 text-sky-800' : 'bg-rose-100 text-rose-800'
                    }`}>
                      {orderFin.coveragePct}% {isAr ? 'تغطية' : 'Covered'}
                    </div>

                    <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 text-xs">
                      <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}`}></i>
                    </div>
                  </div>
                </div>

                {/* Expanded Details Body */}
                {isExpanded && (
                  <div className="px-6 pb-6 pt-2 border-t border-slate-100 space-y-6 bg-slate-50/40">
                    {/* Order Financials & Customer Overall Status Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Customer Status for this Order */}
                      <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2.5">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-[10px] font-black uppercase tracking-wider text-sky-700 flex items-center gap-1.5">
                            <i className="fa-solid fa-receipt"></i> {isAr ? 'الموقف المالي لأمر الشراء هذا' : 'Financial Status for this Order'}
                          </span>
                          <span className="text-[9px] font-mono font-bold text-slate-400">
                            PO #{order.customerReferenceNumber || order.internalOrderNumber}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-slate-50 rounded-xl">
                            <span className="text-[9px] font-bold text-slate-400 uppercase block">{isAr ? 'إجمالي الأمر' : 'Order Total'}</span>
                            <span className="text-xs font-black text-slate-800">{orderFin.grossRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</span>
                          </div>
                          <div className="p-2 bg-emerald-50 rounded-xl">
                            <span className="text-[9px] font-bold text-emerald-600 uppercase block">{isAr ? 'المدفوع للأمر' : 'Paid on Order'}</span>
                            <span className="text-xs font-black text-emerald-700">{orderFin.paid.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</span>
                          </div>
                          <div className="p-2 bg-rose-50 rounded-xl">
                            <span className="text-[9px] font-bold text-rose-600 uppercase block">{isAr ? 'المتبقي من الأمر' : 'Balance Due'}</span>
                            <span className="text-xs font-black text-rose-700">{orderFin.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} {orderFin.currency}</span>
                          </div>
                        </div>
                        <p className="text-[10px] font-bold text-slate-500">
                          {isAr ? 'نسبة تغطية الدفعة المقدمة:' : 'Downpayment Coverage:'} <strong className="text-sky-700">{orderFin.coveragePct}%</strong> {isAr ? `(متبقي غير مدفوع: ${orderFin.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${orderFin.currency})` : `(Unpaid balance: ${orderFin.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${orderFin.currency})`}
                        </p>
                      </div>

                      {/* Overall Customer Status */}
                      <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2.5">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-[10px] font-black uppercase tracking-wider text-indigo-700 flex items-center gap-1.5">
                            <i className="fa-solid fa-building-user"></i> {isAr ? 'الموقف المالي العام للعميل' : 'Overall Customer Financial Status'}
                          </span>
                          <span className="text-[9px] font-bold text-slate-500">
                            {order.customerName} ({custOverall.ordersCount} {isAr ? 'طلبات' : 'POs'})
                          </span>
                        </div>
                        <div className="grid grid-cols-4 gap-2 text-center">
                          <div className="p-2 bg-slate-50 rounded-xl">
                            <span className="text-[8px] font-bold text-slate-400 uppercase block">{isAr ? 'إجمالي الفواتير' : 'Invoiced'}</span>
                            <span className="text-xs font-black text-slate-800">{custOverall.totalGrossRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="p-2 bg-emerald-50 rounded-xl">
                            <span className="text-[8px] font-bold text-emerald-600 uppercase block">{isAr ? 'إجمالي المحصل' : 'Collected'}</span>
                            <span className="text-xs font-black text-emerald-700">{custOverall.totalPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="p-2 bg-amber-50 rounded-xl">
                            <span className="text-[8px] font-bold text-amber-600 uppercase block">{isAr ? 'إجمالي المديونية' : 'Total AR'}</span>
                            <span className="text-xs font-black text-amber-700">{custOverall.totalBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                          <div className="p-2 bg-violet-50 rounded-xl">
                            <span className="text-[8px] font-bold text-violet-600 uppercase block">{isAr ? 'رصيد المحفظة' : 'Wallet Deposit'}</span>
                            <span className="text-xs font-black text-violet-700">{custOverall.walletBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                          </div>
                        </div>
                        <p className="text-[10px] font-bold text-slate-500">
                          {isAr ? 'الرصيد المتاح بالمحفظة/الدفعات المقدمة:' : 'Customer available wallet credit:'} <strong className="text-violet-700">{custOverall.walletBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} {isAr ? 'ج.م' : 'L.E.'}</strong>
                        </p>
                      </div>
                    </div>

                    {/* Line Items for Dispatch Authorization Table */}
                    <div className="bg-white rounded-2xl shadow-xs border border-slate-200 overflow-hidden divide-y divide-slate-100">
                      <div className="px-4 py-2.5 bg-slate-100 text-[9px] font-black text-slate-500 uppercase tracking-wider grid grid-cols-12 gap-3 items-center">
                        <div className="col-span-4">{isAr ? 'بند أمر الشراء والمواصفات' : 'PO Line Item & Details'}</div>
                        <div className="col-span-1 text-center">{isAr ? 'جاهز بالمركز' : 'Ready in Hub'}</div>
                        <div className="col-span-2 text-center">{isAr ? 'معتمد للتسليم' : 'Authorized for Release'}</div>
                        <div className="col-span-1 text-center">{isAr ? 'تم الشحن' : 'Shipped'}</div>
                        <div className="col-span-4 text-end">{isAr ? 'إجراء اعتماد التسليم' : 'Delivery Clearance Action'}</div>
                      </div>

                      {(order.items || []).map(item => {
                        const inHub = item.hubReceivedQty || 0;
                        const approved = item.approvedForDispatchQty || 0;
                        const dispatched = item.dispatchedQty || 0;
                        const maxAuth = Math.max(0, inHub - approved);

                        const itemGrossPerUnit = (item.pricePerUnit || 0) * (1 + ((item.taxPercent || 0) / 100));
                        
                        // Remaining paid downpayment after other lines
                        const draftSumFromOthers = currentDraftSum - ((parseFloat(dispatchReceiptInputs[item.id]) || 0) * itemGrossPerUnit);
                        const availablePaidForOrder = orderFin.paid - totalAuthorizedGross - draftSumFromOthers;
                        const maxAffordablePieces = itemGrossPerUnit > 0 ? Math.max(0, Math.floor(availablePaidForOrder / itemGrossPerUnit)) : maxAuth;
                        const finalSuggestedMax = Math.min(maxAffordablePieces, maxAuth);

                        const enteredQty = parseFloat(dispatchReceiptInputs[item.id]) || 0;
                        const isBypassingSuggested = enteredQty > finalSuggestedMax + 0.001;

                        return (
                          <div key={item.id} className="px-4 py-3.5 grid grid-cols-12 gap-3 items-center hover:bg-slate-50/80 transition-colors">
                            {/* Item definition */}
                            <div className="col-span-4">
                              <div className="font-bold text-xs text-slate-800 line-clamp-1">{item.description}</div>
                              <div className="text-[10px] text-slate-400 font-bold mt-0.5">
                                {isAr ? 'المستهدف:' : 'Target:'} {getItemEffectiveQty(item)} {item.unit || 'pcs'} @ {item.pricePerUnit?.toLocaleString() || 'N/A'} {orderFin.currency}
                              </div>
                            </div>

                            {/* Hub Ready */}
                            <div className="col-span-1 text-center font-black text-sky-600 text-xs">
                              {inHub} {item.unit || 'pcs'}
                            </div>

                            {/* Already Authorized */}
                            <div className="col-span-2 text-center text-[10px] font-bold">
                              {approved > 0 ? (
                                <span className={`px-2 py-0.5 rounded-full ${approved >= inHub ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                                  {approved} {isAr ? 'معتمد' : 'Auth'}
                                </span>
                              ) : (
                                <span className="text-slate-400 text-xs">{isAr ? 'لا يوجد' : 'None'}</span>
                              )}
                            </div>

                            {/* Shipped */}
                            <div className="col-span-1 text-center font-bold text-slate-500 text-xs">
                              {dispatched}
                            </div>

                            {/* Authorization Controls */}
                            <div className="col-span-4 flex flex-col sm:flex-row items-end sm:items-center justify-end gap-2">
                              {maxAuth > 0 ? (
                                <>
                                  <div className="flex flex-col items-end gap-1">
                                    <input
                                      type="number"
                                      min="0"
                                      max={maxAuth}
                                      value={dispatchReceiptInputs[item.id] !== undefined ? dispatchReceiptInputs[item.id] : ''}
                                      onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        if (e.target.value === '' || isNaN(val)) {
                                          setDispatchReceiptInputs(p => ({ ...p, [item.id]: e.target.value }));
                                        } else {
                                          setDispatchReceiptInputs(p => ({ ...p, [item.id]: String(Math.min(val, maxAuth)) }));
                                        }
                                      }}
                                      placeholder={isAr ? `الحد: ${maxAuth}` : `Max: ${maxAuth}`}
                                      className={`w-24 px-2.5 py-1.5 text-xs text-center font-black border-2 rounded-xl outline-none transition-all ${
                                        isBypassingSuggested 
                                          ? 'border-amber-500 bg-amber-50/70 text-amber-900 focus:border-amber-600' 
                                          : 'border-slate-200 focus:border-sky-500 focus:bg-white'
                                      }`}
                                    />
                                    {isBypassingSuggested && (
                                      <span className="text-[8px] font-black text-amber-600 uppercase tracking-tighter">
                                        {isAr ? 'تجاوز المقترح:' : 'Bypassing Limit:'} +{(enteredQty - finalSuggestedMax).toFixed(0)} {item.unit}
                                      </span>
                                    )}
                                  </div>

                                  {/* Quick Buttons */}
                                  <div className="flex items-center gap-1">
                                    <button
                                      disabled={isProcessing || finalSuggestedMax <= 0}
                                      onClick={() => setDispatchReceiptInputs(p => ({ ...p, [item.id]: String(finalSuggestedMax) }))}
                                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-emerald-50 text-slate-700 hover:text-emerald-800 border border-slate-200 hover:border-emerald-300 rounded-xl text-[9px] font-black uppercase transition-all disabled:opacity-40"
                                      title={isAr ? `تعيين لأقصى كمية مغطاة بالدفعة المسددة (${finalSuggestedMax})` : `Set to max affordable with paid downpayment (${finalSuggestedMax})`}
                                    >
                                      {isAr ? 'الحد الأقصى المدفوع' : 'Max Paid'}
                                    </button>

                                    <button
                                      disabled={isProcessing || maxAuth <= 0}
                                      onClick={() => setDispatchReceiptInputs(p => ({ ...p, [item.id]: String(maxAuth) }))}
                                      className="px-2.5 py-1.5 bg-slate-100 hover:bg-amber-50 text-slate-700 hover:text-amber-800 border border-slate-200 hover:border-amber-300 rounded-xl text-[9px] font-black uppercase transition-all disabled:opacity-40"
                                      title={isAr ? `اعتماد كامل الجاهز بالمركز (${maxAuth}) وتجاوز مقترح الدفعة` : `Authorize all ready in hub (${maxAuth}) bypassing suggested limit`}
                                    >
                                      {isAr ? 'كامل الجاهز بالمركز' : 'All in Hub'}
                                    </button>

                                    <button
                                      disabled={isProcessing || enteredQty <= 0}
                                      onClick={() => handleAuthorizeDispatch(order, item, isBypassingSuggested)}
                                      className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase text-white shadow-md flex items-center gap-1 disabled:opacity-40 transition-all ${
                                        isBypassingSuggested ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-200' : 'bg-sky-600 hover:bg-sky-700 shadow-sky-200'
                                      }`}
                                    >
                                      <i className="fa-solid fa-file-signature"></i>
                                      {isAr ? 'اعتماد التسليم' : 'Authorize'}
                                    </button>
                                  </div>
                                </>
                              ) : inHub <= 0 && approved <= 0 ? (
                                <div className="text-[10px] font-black text-slate-500 uppercase bg-slate-100 px-3 py-1.5 rounded-xl border border-slate-200 flex items-center gap-1">
                                  <i className="fa-solid fa-hourglass-start text-slate-400"></i> {isAr ? 'لا يوجد اعتماد بعد' : 'No clearance yet'}
                                </div>
                              ) : (
                                <div className="text-[10px] font-black text-emerald-700 uppercase bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200 flex items-center gap-1">
                                  <i className="fa-solid fa-circle-check mr-1"></i> {isAr ? 'مكتمل الاعتماد والتسليم' : 'Fully Cleared'}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export const SourcingModule: React.FC<SourcingModuleProps> = (props) => (
  <LanguageProvider pageId="sourcing">
    <SourcingModuleInner {...props} />
  </LanguageProvider>
);
export default SourcingModule;
