import React, { useState, useEffect, useMemo } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, Customer, Supplier, OrderStatus, AppConfig, User } from '../types';
import { STATUS_CONFIG, getDynamicOrderStatusStyle } from '../constants';

interface FinanceModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

type FinanceTab = 'orders' | 'margins' | 'billing' | 'entities' | 'tax_clearances';

const getStatusLimit = (order: CustomerOrder, settings: any) => {
  const status = order.status;
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
    case OrderStatus.DELIVERED:
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
  const [whtPeriod, setWhtPeriod] = useState<'this_year' | 'last_year'>('this_year');
  const [whtSearch, setWhtSearch] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'orderDate', direction: 'desc' });
  const [columnOrder, setColumnOrder] = useState<string[]>(['context', 'date', 'revenue', 'markup', 'status', 'actions']);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  const handleSort = (key: string) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const handleDragStart = (e: React.DragEvent, col: string) => {
    e.dataTransfer.setData('col', col);
  };

  const handleDragOver = (e: React.DragEvent, col: string) => {
    e.preventDefault();
    setDragOverCol(col);
  };

  const handleDrop = (e: React.DragEvent, targetCol: string) => {
    e.preventDefault();
    const sourceCol = e.dataTransfer.getData('col');
    if (sourceCol === targetCol) return;
    setColumnOrder(prev => {
      const newOrder = [...prev];
      const srcIdx = newOrder.indexOf(sourceCol);
      const tgtIdx = newOrder.indexOf(targetCol);
      newOrder.splice(srcIdx, 1);
      newOrder.splice(tgtIdx, 0, sourceCol);
      return newOrder;
    });
    setDragOverCol(null);
  };

  const [decisionModal, setDecisionModal] = useState<{
    type: 'orderHold' | 'orderReject' | 'customerHold' | 'supplierBlacklist' | 'marginRelease' | 'billing' | 'payment' | 'cancelInvoice' | 'cancelPayment' | 'revertToSourcing';
    entityId: string;
    entityName: string;
    currentValue?: boolean;
    extraData?: any;
  } | null>(null);

  const [comment, setComment] = useState('');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [dispatchReceiptInputs, setDispatchReceiptInputs] = useState<Record<string, string>>({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Payment Invoice PDF state
  const [paymentInvoiceData, setPaymentInvoiceData] = useState<{
    order: CustomerOrder;
    paymentAmount: number;
    receiptNumber: string;
    isFinal: boolean;
    previousPayments: { amount: number; date: string; receiptNumber?: string }[];
  } | null>(null);
  const paymentInvoiceRef = React.useRef<HTMLDivElement>(null);
  const [viewPaymentsOrder, setViewPaymentsOrder] = useState<CustomerOrder | null>(null);

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
    const targetRev = order.appliesWithholdingTax ? grossRevenue * 0.99 : grossRevenue;
    return { revenue, grossRevenue, cost, marginPct, markupPct, paid, outstanding: Math.max(0, targetRev - paid) };
  };

  const ordersWithPL = useMemo(() => orders.map(o => ({ ...o, pl: getPL(o) })), [orders]);

  const filteredOrders = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filtered = ordersWithPL.filter(o =>
      (o.internalOrderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q)) &&
      ![OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status)
    );

    const sorted = [...filtered].sort((a: any, b: any) => {
      let valA: any = a[sortConfig.key];
      let valB: any = b[sortConfig.key];

      if (sortConfig.key === 'markupPct' || sortConfig.key === 'grossRevenue' || sortConfig.key === 'paid' || sortConfig.key === 'outstanding') {
        valA = a.pl[sortConfig.key];
        valB = b.pl[sortConfig.key];
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [ordersWithPL, search, sortConfig]);

  const whtOrders = useMemo(() => {
    const q = whtSearch.toLowerCase().trim();
    const now = new Date();
    const year = whtPeriod === 'this_year' ? now.getFullYear() : now.getFullYear() - 1;

    const filtered = orders.filter(o =>
      o.appliesWithholdingTax &&
      o.status === OrderStatus.FULFILLED &&
      (o.customerName.toLowerCase().includes(q) || o.internalOrderNumber.toLowerCase().includes(q)) &&
      new Date(o.orderDate || o.dataEntryTimestamp).getFullYear() === year
    );

    const sorted = [...filtered].sort((a: any, b: any) => {
      const valA = a[sortConfig.key] || '';
      const valB = b[sortConfig.key] || '';
      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [orders, whtSearch, whtPeriod, sortConfig]);

  const handleUploadWHT = async (orderId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsProcessing(true);
    try {
      const formData = new FormData();
      formData.append('whtFile', file);
      const res = await fetch('http://localhost:3005/api/upload-wht-certificate', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        await dataService.updateOrder(orderId, { whtCertificateFile: data.filePath });
        await fetchData();
      } else {
        throw new Error("Upload failed on server");
      }
    } catch (err) {
      alert("Failed to attach Withholding Tax Certificate. Ensure the backend is running and the file is valid.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteDecision = async () => {
    if (!decisionModal) return;
    if (!['billing'].includes(decisionModal.type) && !comment.trim()) { setErrorMsg("Audit memo is mandatory"); return; }

    setIsProcessing(true);
    try {
      switch (decisionModal.type) {
        case 'orderHold': await dataService.setOrderHold(decisionModal.entityId, !decisionModal.currentValue, comment); break;
        case 'orderReject': await dataService.rejectOrder(decisionModal.entityId, comment); break;
        case 'customerHold': await dataService.setCustomerHold(decisionModal.entityId, !decisionModal.currentValue, comment); break;
        case 'supplierBlacklist':
          if (decisionModal.currentValue) await dataService.removeSupplierBlacklist(decisionModal.entityId, comment);
          else await dataService.blacklistSupplier(decisionModal.entityId, comment);
          break;
        case 'marginRelease': await dataService.releaseMarginBlock(decisionModal.entityId, comment); break;
        case 'billing': await dataService.issueInvoice(decisionModal.entityId); break;
        case 'payment': {
          const amt = parseFloat(paymentAmount) || 0;
          if (amt <= 0) throw new Error("Amount must be greater than zero");
          const updatedOrder = await dataService.recordPayment(decisionModal.entityId, amt, comment);
          // Calculate if this is a final payment
          let grossRev = 0;
          updatedOrder.items.forEach((it: any) => grossRev += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));
          const totalPaidNow = (updatedOrder.payments || []).reduce((s: number, p: any) => s + p.amount, 0);
          const lastPayment = updatedOrder.payments[updatedOrder.payments.length - 1];
          const previousPayments = updatedOrder.payments.slice(0, -1);
          setPaymentInvoiceData({
            order: updatedOrder,
            paymentAmount: amt,
            receiptNumber: lastPayment?.receiptNumber || `RCV-${String(updatedOrder.payments.length).padStart(3, '0')}`,
            isFinal: totalPaidNow >= grossRev,
            previousPayments
          });
          break;
        }
        case 'cancelInvoice': await dataService.cancelInvoice(decisionModal.entityId, comment); break;
        case 'cancelPayment': await dataService.cancelPayment(decisionModal.entityId, decisionModal.extraData.index, comment); break;
        case 'revertToSourcing': await dataService.revertInvoicedOrderToSourcing(decisionModal.entityId, comment); break;
      }
      await fetchData();
      closeModals();
    } catch (e: any) {
      setErrorMsg(e.message || "Action failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const closeModals = () => { setDecisionModal(null); setComment(''); setPaymentAmount(''); setDispatchReceiptInputs({}); setErrorMsg(null); };

  const handleInlineDispatchAuth = async (orderId: string, itemId: string) => {
    const qtyStr = dispatchReceiptInputs[itemId];
    const qty = parseFloat(qtyStr);
    if (isNaN(qty) || qty <= 0) {
      alert("Please enter a valid authorization quantity greater than 0.");
      return;
    }
    setIsProcessing(true);
    try {
      await dataService.approveDispatchReceipt(orderId, [{ itemId, qty }], "Inline item-level authorization receipt.");
      setDispatchReceiptInputs(prev => ({ ...prev, [itemId]: '' }));
      await fetchData();
    } catch (e: any) {
      alert(e.message || "Failed to authorize dispatch.");
    } finally {
      setIsProcessing(false);
    }
  };

  const [printOrder, setPrintOrder] = useState<CustomerOrder | null>(null);
  const printOrderRef = React.useRef<HTMLDivElement>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownloadInvoice = async (order: CustomerOrder) => {
    setPrintOrder(order);
    setTimeout(async () => {
      if (!printOrderRef.current) return;
      setIsDownloading(true);
      try {
        const h2c = (await import('html2canvas')).default;
        const canvas = await h2c(printOrderRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
        const imgData = canvas.toDataURL('image/png');
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const imgWidth = pdf.internal.pageSize.getWidth();
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        pdf.save(`Invoice-${order.invoiceNumber || order.internalOrderNumber}.pdf`);
      } catch (e) {
        console.error("PDF Fail", e);
        alert("Failed to generate PDF");
      } finally {
        setIsDownloading(false);
        setPrintOrder(null);
      }
    }, 500);
  };

  const getPrintTotal = () => {
    if (!printOrder) return 0;
    return printOrder.items.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);
  };

  // Auto-trigger payment invoice PDF download when paymentInvoiceData is set
  React.useEffect(() => {
    if (!paymentInvoiceData) return;
    const timer = setTimeout(async () => {
      if (!paymentInvoiceRef.current) return;
      try {
        const h2c = (await import('html2canvas')).default;
        const canvas = await h2c(paymentInvoiceRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
        const imgData = canvas.toDataURL('image/png');
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const imgWidth = pdf.internal.pageSize.getWidth();
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        // Handle multi-page if content is tall
        if (imgHeight > pdf.internal.pageSize.getHeight()) {
          let y = 0;
          const pageHeight = pdf.internal.pageSize.getHeight();
          while (y < imgHeight) {
            if (y > 0) pdf.addPage();
            pdf.addImage(imgData, 'PNG', 0, -y, imgWidth, imgHeight);
            y += pageHeight;
          }
        } else {
          pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        }
        pdf.save(`Receipt-${paymentInvoiceData.order.internalOrderNumber}-${paymentInvoiceData.receiptNumber}.pdf`);
      } catch (e) {
        console.error('Payment Invoice PDF failed:', e);
      } finally {
        setPaymentInvoiceData(null);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [paymentInvoiceData]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Hidden Full Invoice Template */}
      <div className="fixed -left-[3000px] top-0 overflow-visible">
        {printOrder && (
          <div ref={printOrderRef} className="bg-white p-12 text-slate-900" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'none' }}>
            <div className="flex justify-between items-start mb-10">
              <div className="w-24 h-24 border-4 border-slate-800 rounded-full flex items-center justify-center font-black text-2xl tracking-tighter">
                {config.settings.companyLogo ? <img src={config.settings.companyLogo} className="w-full h-full object-contain" /> : 'LOGO'}
              </div>
              <div className="text-right">
                <h1 className="text-3xl font-black mb-1">{config.settings.companyName || 'Nexus ERP'}</h1>
                <p className="text-xl font-bold text-slate-600">{config.settings.companyAddress || 'Cairo, Egypt'}</p>
              </div>
            </div>
            <div className="border-t-2 border-b-2 border-slate-200 py-3 mb-8 flex justify-center items-center">
              <h2 className="text-xl font-black uppercase flex items-center gap-6"><span>TAX INVOICE / فاتورة ضريبية</span></h2>
            </div>
            <div className="grid grid-cols-2 gap-8 mb-10">
              <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                <div className="grid grid-cols-3"><div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">Customer:</div><div className="col-span-2 p-3 font-black text-sm uppercase">{printOrder.customerName}</div></div>
                <div className="grid grid-cols-3"><div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">Invoice No:</div><div className="col-span-2 p-3 font-mono font-black text-blue-600 text-xs">{printOrder.invoiceNumber || 'DRAFT'}</div></div>
              </div>
              <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                <div className="grid grid-cols-3"><div className="col-span-2 p-3 font-black text-sm text-center tracking-widest">{new Date().toLocaleDateString()}</div><div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-xs">Date:</div></div>
                <div className="p-3 bg-slate-50 text-center font-bold text-[10px]">Tax Authority - Cairo</div>
                <div className="grid grid-cols-3"><div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">522 803 435</div><div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-[9px]">Tax ID:</div></div>
              </div>
            </div>
            <div className="border-2 border-slate-900 mb-10 min-h-[400px] flex flex-col">
              <div className="grid grid-cols-12 border-b-2 border-slate-900 bg-slate-50 text-[11px] font-black uppercase text-center">
                <div className="col-span-6 p-3 border-r-2 border-slate-900">Description</div>
                <div className="col-span-1 p-3 border-r-2 border-slate-900">Price</div>
                <div className="col-span-1 p-3 border-r-2 border-slate-900">Qty</div>
                <div className="col-span-2 p-3 border-r-2 border-slate-900">Tax %</div>
                <div className="col-span-2 p-3">Total</div>
              </div>
              {printOrder.items.map(item => (
                <div key={item.id} className="grid grid-cols-12 border-b-2 border-slate-900 text-center font-black text-sm">
                  <div className="col-span-6 p-4 border-r-2 border-slate-900 text-left">{item.description}</div>
                  <div className="col-span-1 p-4 border-r-2 border-slate-900">{item.pricePerUnit.toLocaleString()}</div>
                  <div className="col-span-1 p-4 border-r-2 border-slate-900">{item.quantity}</div>
                  <div className="col-span-2 p-4 border-r-2 border-slate-900">{item.taxPercent}%</div>
                  <div className="col-span-2 p-4">{((item.quantity * item.pricePerUnit) * (1 + item.taxPercent / 100)).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <div className="w-64 border-2 border-slate-900 divide-y-2 divide-slate-900 font-black">
                <div className="grid grid-cols-2 bg-slate-100">
                  <div className="p-3 border-r-2 border-slate-900 text-sm uppercase">GRAND TOTAL</div>
                  <div className="p-3 text-right text-xl">{getPrintTotal().toLocaleString()} L.E.</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hidden Payment Receipt/Invoice Template */}
      <div className="fixed -left-[3000px] top-0 overflow-visible">
        {paymentInvoiceData && (() => {
          const { order: pOrder, paymentAmount: pAmt, receiptNumber: pReceipt, isFinal, previousPayments: prevPay } = paymentInvoiceData;
          // Calculate gross total for proration
          let grossTotal = 0;
          pOrder.items.forEach((it: any) => grossTotal += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));
          const ratio = grossTotal > 0 ? pAmt / grossTotal : 0;
          // Prorate each line item
          const proratedItems = pOrder.items.map((it: any) => {
            const lineGross = it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100));
            const proratedGross = lineGross * ratio;
            const proratedNet = proratedGross / (1 + (it.taxPercent / 100));
            const proratedTax = proratedGross - proratedNet;
            const proratedQty = it.quantity * ratio;
            return { ...it, proratedQty, proratedNet, proratedTax, proratedGross };
          });
          const subtotal = proratedItems.reduce((s: number, it: any) => s + it.proratedNet, 0);
          const totalTax = proratedItems.reduce((s: number, it: any) => s + it.proratedTax, 0);
          const totalPaidBefore = prevPay.reduce((s: number, p: any) => s + p.amount, 0);

          return (
            <div ref={paymentInvoiceRef} className="bg-white p-12 text-slate-900" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'none' }}>
              {/* Header */}
              <div className="flex justify-between items-start mb-10">
                <div className="w-24 h-24 border-4 border-slate-800 rounded-full flex items-center justify-center font-black text-2xl tracking-tighter">
                  {config.settings.companyLogo ? <img src={config.settings.companyLogo} className="w-full h-full object-contain" /> : 'LOGO'}
                </div>
                <div className="text-right">
                  <h1 className="text-3xl font-black mb-1">{config.settings.companyName || 'Nexus ERP'}</h1>
                  <p className="text-xl font-bold text-slate-600">{config.settings.companyAddress || 'Cairo, Egypt'}</p>
                </div>
              </div>

              {/* Title Bar */}
              <div className={`border-t-2 border-b-2 py-3 mb-8 flex justify-center items-center ${isFinal ? 'border-emerald-400 bg-emerald-50' : 'border-blue-400 bg-blue-50'}`}>
                <h2 className={`text-xl font-black uppercase flex items-center gap-6 ${isFinal ? 'text-emerald-800' : 'text-blue-800'}`}>
                  <span>{isFinal ? 'FINAL PAYMENT RECEIPT / إيصال سداد نهائي' : 'PARTIAL PAYMENT RECEIPT / إيصال سداد جزئي'}</span>
                </h2>
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-8 mb-10">
                <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                  <div className="grid grid-cols-3"><div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">Customer:</div><div className="col-span-2 p-3 font-black text-sm uppercase">{pOrder.customerName}</div></div>
                  <div className="grid grid-cols-3"><div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">Invoice No:</div><div className="col-span-2 p-3 font-mono font-black text-blue-600 text-xs">{pOrder.invoiceNumber || 'N/A'}</div></div>
                  <div className="grid grid-cols-3"><div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">Receipt No:</div><div className="col-span-2 p-3 font-mono font-black text-emerald-600 text-xs">{pReceipt}</div></div>
                </div>
                <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                  <div className="grid grid-cols-3"><div className="col-span-2 p-3 font-black text-sm text-center tracking-widest">{new Date().toLocaleDateString()}</div><div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-xs">Date:</div></div>
                  <div className="grid grid-cols-3"><div className="col-span-2 p-3 font-mono font-black text-xs text-center">{pOrder.internalOrderNumber}</div><div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-[9px]">Order Ref:</div></div>
                  <div className="grid grid-cols-3"><div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">522 803 435</div><div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-[9px]">Tax ID:</div></div>
                </div>
              </div>

              {/* Line Items Table */}
              <div className="border-2 border-slate-900 mb-8 flex flex-col">
                <div className="grid grid-cols-12 border-b-2 border-slate-900 bg-slate-50 text-[11px] font-black uppercase text-center">
                  <div className="col-span-5 p-3 border-r-2 border-slate-900">Description</div>
                  <div className="col-span-1 p-3 border-r-2 border-slate-900">Unit Price</div>
                  <div className="col-span-1 p-3 border-r-2 border-slate-900">Qty (Pro-Rata)</div>
                  <div className="col-span-1 p-3 border-r-2 border-slate-900">Tax %</div>
                  <div className="col-span-2 p-3 border-r-2 border-slate-900">Tax Amount</div>
                  <div className="col-span-2 p-3">Line Total</div>
                </div>
                {proratedItems.map((item: any) => (
                  <div key={item.id} className="grid grid-cols-12 border-b border-slate-200 text-center text-sm">
                    <div className="col-span-5 p-3 border-r-2 border-slate-900 text-left font-bold text-xs">{item.description}</div>
                    <div className="col-span-1 p-3 border-r-2 border-slate-900 font-black">{item.pricePerUnit.toLocaleString()}</div>
                    <div className="col-span-1 p-3 border-r-2 border-slate-900 font-black">{item.proratedQty.toFixed(2)}</div>
                    <div className="col-span-1 p-3 border-r-2 border-slate-900 font-bold text-slate-500">{item.taxPercent}%</div>
                    <div className="col-span-2 p-3 border-r-2 border-slate-900 font-black text-amber-700">{item.proratedTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    <div className="col-span-2 p-3 font-black">{item.proratedGross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                  </div>
                ))}
              </div>

              {/* Totals */}
              <div className="flex justify-end mb-8">
                <div className="w-80 border-2 border-slate-900 divide-y-2 divide-slate-900 font-black">
                  <div className="grid grid-cols-2">
                    <div className="p-3 border-r-2 border-slate-900 text-xs uppercase bg-slate-50">Subtotal (Excl. Tax)</div>
                    <div className="p-3 text-right text-sm">{subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                  </div>
                  <div className="grid grid-cols-2">
                    <div className="p-3 border-r-2 border-slate-900 text-xs uppercase bg-slate-50">Total Tax</div>
                    <div className="p-3 text-right text-sm text-amber-700">{totalTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                  </div>
                  <div className={`grid grid-cols-2 ${isFinal ? 'bg-emerald-50' : 'bg-blue-50'}`}>
                    <div className="p-3 border-r-2 border-slate-900 text-sm uppercase">AMOUNT PAID</div>
                    <div className={`p-3 text-right text-xl ${isFinal ? 'text-emerald-700' : 'text-blue-700'}`}>{pAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                  </div>
                </div>
              </div>

              {/* Payment History */}
              {prevPay.length > 0 && (
                <div className="border-t-2 border-slate-200 pt-6 mb-6">
                  <div className="text-xs font-black uppercase text-slate-400 tracking-widest mb-3">Previous Payments on this Order</div>
                  <div className="border border-slate-200 rounded">
                    {prevPay.map((p: any, idx: number) => (
                      <div key={idx} className="flex justify-between px-4 py-2 text-xs font-bold border-b border-slate-100 last:border-0">
                        <span className="text-slate-500">{p.receiptNumber || `#${idx + 1}`} — {new Date(p.date).toLocaleDateString()}</span>
                        <span className="text-slate-800">{p.amount.toLocaleString()} L.E.</span>
                      </div>
                    ))}
                    <div className="flex justify-between px-4 py-2 text-xs font-black bg-slate-50 border-t border-slate-200">
                      <span>Total Previously Paid</span>
                      <span>{totalPaidBefore.toLocaleString()} L.E.</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Balance Summary */}
              <div className="flex justify-between items-center p-4 bg-slate-50 border-2 border-slate-200 rounded mt-4">
                <div className="text-xs font-black uppercase text-slate-500">Order Total: {grossTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })} L.E.</div>
                <div className="text-xs font-black uppercase text-slate-500">Total Paid: {(totalPaidBefore + pAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })} L.E.</div>
                <div className={`text-sm font-black uppercase ${isFinal ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {isFinal ? 'FULLY SETTLED ✓' : `Outstanding: ${Math.max(0, grossTotal - totalPaidBefore - pAmt).toLocaleString(undefined, { minimumFractionDigits: 2 })} L.E.`}
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
        <div className="flex gap-1 p-1 bg-slate-200 rounded-2xl w-fit shadow-inner overflow-x-auto">
          {(['orders', 'margins', 'billing', 'entities', 'tax_clearances'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-8 py-3 rounded-xl text-[10px] whitespace-nowrap font-black uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {tab === 'margins' && orders.some(o => o.status === OrderStatus.NEGATIVE_MARGIN) && <span className="mr-2 w-2 h-2 rounded-full bg-rose-50 inline-block animate-pulse"></span>}
              {tab.replace(/([A-Z_])/g, ' $1').replace('_', ' ')}
            </button>
          ))}
        </div>
        {activeTab === 'tax_clearances' ? (
          <div className="flex gap-4 w-full lg:w-auto">
            <div className="relative group w-40">
              <select className="w-full pl-10 pr-4 py-3 bg-white border-2 border-slate-100 rounded-2xl text-[10px] font-black uppercase appearance-none focus:border-blue-500 transition-all outline-none text-slate-700 shadow-sm" value={whtPeriod} onChange={e => setWhtPeriod(e.target.value as 'this_year' | 'last_year')}>
                <option value="this_year">This Year</option>
                <option value="last_year">Last Year</option>
              </select>
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"><i className="fa-solid fa-calendar text-xs"></i></div>
            </div>
            <div className="relative flex-1 lg:w-64">
              <input
                type="text" placeholder="Search Customer..."
                className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
                value={whtSearch} onChange={e => setWhtSearch(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
            </div>
          </div>
        ) : (
          <div className="relative w-full lg:w-96">
            <input
              type="text" placeholder="Filter Ledger..."
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={search} onChange={e => setSearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
          </div>
        )}
      </div>

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
        <table className="w-full text-left">
          <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-white/5">
            <tr>
              {activeTab === 'entities' ? (
                <>
                  <th className="px-8 py-5 text-white">Operational Context</th>
                  <th className="px-8 py-5 text-white cursor-pointer select-none" onClick={() => handleSort('name')}>
                    Entity Type {sortConfig.key === 'name' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-8 py-5 text-white">Account Status</th>
                  <th className="px-8 py-5 text-white text-right">Credit Action</th>
                </>
              ) : (
                <>
                  {columnOrder.map(col => {
                    if (col === 'context') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-8 py-5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('internalOrderNumber')}>
                        {activeTab === 'tax_clearances' ? 'Tax PO Details' : 'Operational Context'} {sortConfig.key === 'internalOrderNumber' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'date') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-4 py-5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('orderDate')}>
                        {activeTab === 'tax_clearances' ? 'Target Revenue (99%)' : 'Order Date'} {sortConfig.key === 'orderDate' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'revenue') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-8 py-5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('grossRevenue')}>
                        {activeTab === 'tax_clearances' ? 'WHT Value (1%)' : 'Revenue Metrics'} {sortConfig.key === 'grossRevenue' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'markup') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-8 py-5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('markupPct')}>
                        {activeTab === 'tax_clearances' ? 'Clearance Status' : 'Markup Analysis'} {sortConfig.key === 'markupPct' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'status') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-8 py-5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('status')}>
                        {activeTab === 'tax_clearances' ? '-' : 'SLA / Status'} {sortConfig.key === 'status' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'actions') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-8 py-5 text-white text-right transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`}>
                        {activeTab === 'tax_clearances' ? '-' : 'Auth Actions'}
                      </th>
                    );
                    return null;
                  })}
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {activeTab === 'entities' ? (
              <>
                {[...customers].sort((a, b) => {
                  const valA = (a.name || '').toLowerCase();
                  const valB = (b.name || '').toLowerCase();
                  if (sortConfig.key !== 'name') return 0;
                  if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                  if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                  return 0;
                }).map(c => (
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
                {[...suppliers].sort((a, b) => {
                  const valA = (a.name || '').toLowerCase();
                  const valB = (b.name || '').toLowerCase();
                  if (sortConfig.key !== 'name') return 0;
                  if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                  if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                  return 0;
                }).map(s => (
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
            ) : activeTab === 'tax_clearances' ? (
              <>
                {whtOrders.map(o => {
                  let grossRevenue = 0;
                  o.items.forEach(it => grossRevenue += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));
                  const whtAmount = grossRevenue * 0.01;
                  const targetRevenue = grossRevenue * 0.99;

                  return (
                    <tr key={o.id} className="hover:bg-slate-50/80 transition-colors">
                      {columnOrder.map(col => {
                        if (col === 'context') return (
                          <td key={col} className="px-8 py-6">
                            <div className="font-mono text-[10px] font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                            <div className="font-bold text-slate-800 text-sm tracking-tight mt-0.5">{o.customerName}</div>
                            <div className="text-[9px] text-slate-400 font-bold mt-1 uppercase tracking-tighter">{o.orderDate ? new Date(o.orderDate).toLocaleDateString() : 'N/A'}</div>
                          </td>
                        );
                        if (col === 'date' || col === 'revenue' || col === 'markup' || col === 'status' || col === 'actions') {
                          // Tax clearances mapping: date->revenue, revenue->WHT, markup->status
                          if (col === 'date') return <td key={col} className="px-8 py-6 text-sm font-black text-slate-700">{targetRevenue.toLocaleString()} L.E.</td>;
                          if (col === 'revenue') return <td key={col} className="px-8 py-6 text-sm font-black text-amber-600">{whtAmount.toLocaleString()} L.E.</td>;
                          if (col === 'markup') return (
                            <td key={col} className="px-8 py-6 text-right">
                              {o.whtCertificateFile ? (
                                <a href={`http://localhost:3005/${o.whtCertificateFile}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl text-[10px] font-black uppercase hover:bg-emerald-100 transition-all">
                                  <i className="fa-solid fa-file-shield text-base"></i> Tax Cleared
                                </a>
                              ) : (
                                <div className="flex flex-col items-end gap-2">
                                  <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-rose-50 text-rose-600 border border-rose-100 rounded-lg text-[9px] font-black uppercase">
                                    <i className="fa-solid fa-clock"></i> Pending Proof
                                  </span>
                                  <label className="cursor-pointer px-4 py-2 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase hover:bg-black transition-all inline-flex items-center gap-2 shadow-lg shadow-slate-200">
                                    <i className={`fa-solid ${isProcessing ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'}`}></i> Upload Certificate
                                    <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png" disabled={isProcessing} onChange={e => handleUploadWHT(o.id, e)} />
                                  </label>
                                </div>
                              )}
                            </td>
                          );
                          return <td key={col}></td>;
                        }
                        return null;
                      })}
                    </tr>
                  )
                })}
                {whtOrders.length === 0 && (
                  <tr>
                    <td colSpan={columnOrder.length} className="px-8 py-16 text-center text-slate-400 font-bold text-sm uppercase tracking-widest">
                      <i className="fa-solid fa-file-invoice-dollar text-4xl block mb-3 opacity-20"></i>
                      No Tax Clearance Records Found
                    </td>
                  </tr>
                )}
              </>
            ) : filteredOrders.map(o => {
              const pl = (o as any).pl;
              const isBreach = pl.markupPct < config.settings.minimumMarginPct;
              const showRow = activeTab === 'orders' ||
                (activeTab === 'margins' && o.status === OrderStatus.NEGATIVE_MARGIN) ||
                (activeTab === 'billing' && ([OrderStatus.IN_PRODUCT_HUB, OrderStatus.ISSUE_INVOICE].includes(o.status) || o.items.some(i => (i.hubReceivedQty || 0) > (i.approvedForDispatchQty || 0))));

              if (!showRow) return null;

              const isInvoicedOrLater = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED].includes(o.status);

              let totalAuthorizedGross = 0;
              let draftSum = 0;
              o.items.forEach(it => {
                totalAuthorizedGross += (it.approvedForDispatchQty || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
                const draftQty = parseFloat(dispatchReceiptInputs[it.id]) || 0;
                draftSum += draftQty * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
              });

              return (
                <React.Fragment key={o.id}>
                  <tr className={`hover:bg-slate-50/80 transition-colors ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-rose-50/20' : ''}`}>
                    {columnOrder.map(col => {
                      if (col === 'context') return (
                        <td key={col} className="px-8 py-6">
                          <div className="font-mono text-[10px] font-black text-blue-600 uppercase">{o.internalOrderNumber}</div>
                          <div className="font-bold text-slate-800 text-sm tracking-tight mt-0.5">{o.customerName}</div>
                          {o.invoiceNumber && <div className="text-[9px] font-black text-emerald-600 uppercase mt-1">Tax Invoice: {o.invoiceNumber}</div>}
                        </td>
                      );
                      if (col === 'date') return (
                        <td key={col} className="px-4 py-6">
                          <div className="text-xs font-black text-slate-700 uppercase tracking-tighter">
                            {o.orderDate ? new Date(o.orderDate).toLocaleDateString() : 'N/A'}
                          </div>
                          <div className="text-[9px] text-slate-400 font-bold mt-1">Acquisition Date</div>
                        </td>
                      );
                      if (col === 'revenue') return (
                        <td key={col} className="px-8 py-6">
                          <div className="flex items-center gap-2">
                            <div className="font-black text-slate-700 text-xs">Gross: {pl.grossRevenue.toLocaleString()} L.E.</div>
                          </div>
                          <div className="text-[9px] text-slate-400 font-bold mt-1">
                            Paid: {pl.paid.toLocaleString()} L.E. • Bal: {pl.outstanding.toLocaleString()}
                          </div>
                        </td>
                      );
                      if (col === 'markup') return (
                        <td key={col} className="px-8 py-6">
                          <div className={`px-3 py-1.5 rounded-xl border-2 text-[10px] font-black w-fit shadow-sm ${isBreach ? 'bg-rose-50 border-rose-100 text-rose-600' : 'bg-emerald-50 border-emerald-100 text-emerald-600'}`}>
                            {pl.markupPct.toFixed(1)}% Markup
                          </div>
                          <div className="text-[8px] text-slate-400 font-bold mt-1 uppercase tracking-widest">Target: {config.settings.minimumMarginPct}%</div>
                        </td>
                      );
                      if (col === 'status') {
                        const isExceedingPayment = (totalAuthorizedGross + draftSum) > pl.paid + 0.01; // small epsilon for float precision
                        return (
                          <td key={col} className="px-8 py-6">
                            <div className="flex flex-col gap-2">
                              <div className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border w-fit bg-${getDynamicOrderStatusStyle(o, config).color}-50 text-${getDynamicOrderStatusStyle(o, config).color}-600 border-${getDynamicOrderStatusStyle(o, config).color}-100`}>
                                {getDynamicOrderStatusStyle(o, config).label}
                              </div>
                              {isExceedingPayment && (
                                <div className="px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black uppercase rounded animate-pulse flex items-center gap-1 shadow-sm shadow-rose-200">
                                  <i className="fa-solid fa-triangle-exclamation"></i>
                                  Dispatch Exceeds Payment
                                </div>
                              )}
                              <ThresholdSentinel order={o} config={config} />
                            </div>
                          </td>
                        );
                      }
                      if (col === 'actions') return (
                        <td key={col} className="px-8 py-6 text-right">
                          <div className="flex justify-end gap-2 items-center">
                            {isInvoicedOrLater && (
                              <>
                                <button
                                  onClick={() => handleDownloadInvoice(o)}
                                  className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center hover:bg-blue-100 transition-all border border-blue-200"
                                  title="Download Tax Invoice"
                                >
                                  {isDownloading && printOrder?.id === o.id ? <i className="fa-solid fa-circle-notch fa-spin text-xs"></i> : <i className="fa-solid fa-file-arrow-down text-xs"></i>}
                                </button>
                                <button
                                  onClick={() => setDecisionModal({ type: 'cancelInvoice', entityId: o.id, entityName: o.internalOrderNumber })}
                                  className="px-4 py-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg text-[9px] font-black uppercase hover:bg-rose-100 transition-all flex items-center gap-2"
                                  title="Void current invoice and return to Billing stage"
                                >
                                  <i className="fa-solid fa-file-circle-xmark"></i> Void
                                </button>
                              </>
                            )}
                            {o.status === OrderStatus.NEGATIVE_MARGIN && (
                              <button onClick={() => setDecisionModal({ type: 'marginRelease', entityId: o.id, entityName: o.internalOrderNumber })} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-rose-200">Force Auth</button>
                            )}
                            {(o.status === OrderStatus.IN_PRODUCT_HUB || o.status === OrderStatus.ISSUE_INVOICE) && (
                              <button onClick={() => setDecisionModal({ type: 'billing', entityId: o.id, entityName: o.internalOrderNumber })} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-blue-200">Generate Invoice</button>
                            )}
                            <button onClick={() => { setDecisionModal({ type: 'payment', entityId: o.id, entityName: o.internalOrderNumber }); setPaymentAmount(pl.outstanding.toString()); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg shadow-emerald-200">Pay</button>
                            <div className="flex gap-1">
                              {!o.einvoiceRequested && (
                                <button
                                  onClick={async () => {
                                    if (window.confirm(`Request official Gov. E-Invoice for ${o.internalOrderNumber}?`)) {
                                      await dataService.requestEInvoice(o.id);
                                      fetchData();
                                    }
                                  }}
                                  className="px-4 py-2 bg-amber-600 text-white rounded-lg text-[9px] font-black uppercase shadow-lg hover:bg-amber-700 transition-all"
                                  title="Request Gov. E-Invoice"
                                >
                                  <i className="fa-solid fa-file-invoice mr-1"></i> Gov
                                </button>
                              )}
                              {o.einvoiceRequested && !o.einvoiceFile && (
                                <span className="px-2 py-1 bg-amber-50 text-amber-600 border border-amber-200 rounded-lg text-[8px] font-black uppercase flex items-center">
                                  <i className="fa-solid fa-clock mr-1"></i>
                                </span>
                              )}
                              <button onClick={() => setDecisionModal({ type: 'orderHold', entityId: o.id, entityName: o.internalOrderNumber, currentValue: o.status === OrderStatus.IN_HOLD })} className="p-2 text-slate-300 hover:text-amber-500 transition-colors" title="Toggle Hold"><i className="fa-solid fa-hand"></i></button>
                              <button onClick={() => setDecisionModal({ type: 'orderReject', entityId: o.id, entityName: o.internalOrderNumber })} className="p-2 text-slate-300 hover:text-rose-500 transition-colors" title="Reject Order"><i className="fa-solid fa-ban"></i></button>
                            </div>
                          </div>
                        </td>
                      );
                      return null;
                    })}
                  </tr>

                  {/* Inline Line Items for Authorization */}
                  <tr className="bg-slate-50/50 border-b-2 border-slate-100">
                    <td colSpan={columnOrder.length} className="px-8 pb-6 bg-transparent">
                      <div className="bg-white rounded-2xl shadow-inner border border-slate-200 overflow-hidden divide-y divide-slate-100">
                        <div className="px-4 py-2 bg-slate-100 text-[9px] font-black text-slate-400 uppercase tracking-widest grid grid-cols-12 gap-4 items-center">
                          <div className="col-span-5">PO Item Definition</div>
                          <div className="col-span-1 text-center">Hub Rdy</div>
                          <div className="col-span-2 text-center">Authorized</div>
                          <div className="col-span-1 text-center">Shipped</div>
                          <div className="col-span-3 text-right pr-2">Dispatch Autho. Receipt</div>
                        </div>
                        {o.items.map(it => {
                          const inHub = it.hubReceivedQty || 0;
                          const approved = it.approvedForDispatchQty || 0;
                          const dispatched = it.dispatchedQty || 0;
                          const maxAuth = Math.max(0, inHub - approved);

                          const itemGrossPerUnit = (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
                          const draftSumFromOthers = draftSum - ((parseFloat(dispatchReceiptInputs[it.id]) || 0) * itemGrossPerUnit);
                          const availableAmount = pl.paid - totalAuthorizedGross - draftSumFromOthers;
                          const maxAffordablePieces = itemGrossPerUnit > 0 ? Math.max(0, Math.floor(availableAmount / itemGrossPerUnit)) : maxAuth;
                          const finalMaxQty = Math.min(maxAffordablePieces, maxAuth);

                          return (
                            <div key={it.id} className="px-4 py-3 grid grid-cols-12 gap-4 items-center hover:bg-slate-50 transition-colors">
                              <div className="col-span-5">
                                <div className="font-bold text-xs text-slate-800 line-clamp-1">{it.description}</div>
                                <div className="text-[10px] text-slate-500 font-bold mt-0.5">
                                  Tgt: {it.quantity} {it.unit} @ {it.pricePerUnit?.toLocaleString() || 'N/A'} L.E.
                                </div>
                              </div>
                              <div className="col-span-1 text-center font-black text-sky-600 text-xs">{inHub}</div>
                              <div className="col-span-2 text-center text-[10px] font-bold">
                                {approved > 0 ? (
                                  <span className={`px-2 py-0.5 rounded-full ${approved >= inHub ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                    {approved} Auth
                                  </span>
                                ) : (
                                  <span className="text-slate-400 opacity-50 block text-center">None</span>
                                )}
                              </div>
                              <div className="col-span-1 text-center font-black text-slate-400 text-xs">{dispatched}</div>
                              <div className="col-span-3 flex justify-end gap-2 items-center">
                                {maxAuth > 0 ? (
                                  <>
                                    <div className="flex flex-col items-end gap-1">
                                      <input
                                        type="number"
                                        min="0"
                                        max={maxAuth}
                                        placeholder={`Max: ${maxAuth}`}
                                        value={dispatchReceiptInputs[it.id] !== undefined ? dispatchReceiptInputs[it.id] : ''}
                                        onChange={(e) => {
                                          const val = parseFloat(e.target.value);
                                          if (e.target.value === '' || isNaN(val)) {
                                            setDispatchReceiptInputs(p => ({ ...p, [it.id]: e.target.value }));
                                          } else {
                                            setDispatchReceiptInputs(p => ({ ...p, [it.id]: String(Math.min(val, maxAuth)) }));
                                          }
                                        }}
                                        className={`w-20 px-2 py-1.5 text-xs text-center font-bold border-2 rounded-lg outline-none transition-all ${
                                          (parseFloat(dispatchReceiptInputs[it.id]) || 0) > maxAffordablePieces + 0.01 
                                          ? 'border-rose-500 bg-rose-50 text-rose-600 animate-shake' 
                                          : 'border-slate-200 focus:border-indigo-400'
                                        }`}
                                      />
                                      {(parseFloat(dispatchReceiptInputs[it.id]) || 0) > maxAffordablePieces + 0.01 && (
                                        <div className="text-[8px] font-black text-rose-500 uppercase tracking-tighter">
                                          Excess: {((parseFloat(dispatchReceiptInputs[it.id]) || 0) - maxAffordablePieces).toLocaleString()} {it.unit}
                                        </div>
                                      )}
                                    </div>
                                    <button
                                      disabled={isProcessing}
                                      onClick={() => handleInlineDispatchAuth(o.id, it.id)}
                                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[9px] font-black uppercase shadow flex items-center gap-1 disabled:opacity-50"
                                    >
                                      <i className="fa-solid fa-file-signature"></i> Auth
                                    </button>
                                    <button
                                      disabled={isProcessing || finalMaxQty <= 0}
                                      onClick={() => setDispatchReceiptInputs(p => ({ ...p, [it.id]: String(finalMaxQty) }))}
                                      className="px-3 py-1.5 bg-slate-100 hover:bg-emerald-50 text-slate-600 hover:text-emerald-700 border border-slate-200 hover:border-emerald-200 rounded-lg text-[9px] font-black uppercase shadow-sm flex items-center gap-1 disabled:opacity-50 transition-all"
                                      title="Set to max quantity affordable with current partial payment balance"
                                    >
                                      Max Paid
                                    </button>
                                  </>
                                ) : (
                                  <div className="text-[9px] font-black text-emerald-600 uppercase bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-100">Fully Cleared</div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        {
          filteredOrders.length === 0 && !loading && (
            <div className="p-20 text-center flex flex-col items-center gap-3 text-slate-300 italic uppercase font-black tracking-widest text-xs">
              <i className="fa-solid fa-vault text-5xl opacity-10 mb-4"></i>
              Financial queue is empty
            </div>
          )
        }
      </div >

      {decisionModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 border border-slate-100">
            <div className="flex items-center gap-6 mb-8">
              <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-3xl shadow-inner ${decisionModal.type === 'cancelInvoice' || decisionModal.type === 'revertToSourcing' ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600'
                }`}>
                <i className={`fa-solid ${decisionModal.type === 'billing' ? 'fa-file-invoice-dollar' :
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
                className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${decisionModal.type === 'cancelInvoice' ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-100' :
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

      {/* Payment History / Receipts Modal */}
      {
        viewPaymentsOrder && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[110] flex items-center justify-center p-4">
            <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl p-10 animate-in zoom-in-95 border border-slate-100 flex flex-col max-h-[90vh]">
              <div className="flex justify-between items-start mb-8">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 rounded-3xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-3xl shadow-inner">
                    <i className="fa-solid fa-receipt"></i>
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Payment Receipts</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Order: {viewPaymentsOrder.internalOrderNumber}</p>
                  </div>
                </div>
                <button onClick={() => setViewPaymentsOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-all flex items-center justify-center">
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-white z-10 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-4">Receipt #</th>
                      <th className="px-4 py-4">Date</th>
                      <th className="px-4 py-4">Amount</th>
                      <th className="px-4 py-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(viewPaymentsOrder.payments || []).map((p, idx) => {
                      const totalPaidAtThisPoint = viewPaymentsOrder.payments?.slice(0, idx + 1).reduce((s, pay) => s + pay.amount, 0) || 0;
                      let grossSum = 0;
                      viewPaymentsOrder.items.forEach(it => grossSum += (it.quantity * it.pricePerUnit * (1 + (it.taxPercent / 100))));
                      const isClosingPayment = totalPaidAtThisPoint >= grossSum;

                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-5 font-mono text-xs font-black text-blue-600 uppercase">{p.receiptNumber || `RCV-${String(idx + 1).padStart(3, '0')}`}</td>
                          <td className="px-4 py-5 font-bold text-slate-500 text-xs">{new Date(p.date).toLocaleDateString()}</td>
                          <td className="px-4 py-5 font-black text-slate-800">{p.amount.toLocaleString()} L.E.</td>
                          <td className="px-4 py-5 text-right">
                            <button
                              onClick={() => {
                                setPaymentInvoiceData({
                                  order: viewPaymentsOrder,
                                  paymentAmount: p.amount,
                                  receiptNumber: p.receiptNumber || `RCV-${String(idx + 1).padStart(3, '0')}`,
                                  isFinal: isClosingPayment,
                                  previousPayments: viewPaymentsOrder.payments?.slice(0, idx) || []
                                });
                              }}
                              className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 inline-flex items-center justify-center hover:bg-blue-600 hover:text-white transition-all border border-blue-100"
                              title="Download PDF Receipt"
                            >
                              <i className="fa-solid fa-file-arrow-down text-xs"></i>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="mt-8 pt-8 border-t border-slate-100 flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  Total Received: {(viewPaymentsOrder.payments || []).reduce((s, p) => s + p.amount, 0).toLocaleString()} L.E.
                </div>
                <button onClick={() => setViewPaymentsOrder(null)} className="px-8 py-3 bg-slate-900 text-white rounded-xl hover:bg-black transition-all">Close</button>
              </div>
            </div>
          </div>
        )
      }
    </div >
  );
};