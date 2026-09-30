import React, { useState, useMemo } from 'react';
import { CustomerOrder, Customer, Supplier, LedgerEntry, OrderStatus } from '../types';
import { dataService } from '../services/dataService';

export interface TaxClearancesViewProps {
  orders: CustomerOrder[];
  customers: Customer[];
  suppliers: Supplier[];
  ledgerEntries: LedgerEntry[];
  supplierPayments: any[];
  currentUser: { username: string; [key: string]: any };
  language: 'ar' | 'en';
  t: (key: string) => string;
  onRefresh: () => Promise<void>;
  getOrderProjectName: (order: CustomerOrder) => string;
  getOrderCurrency: (order: CustomerOrder) => string;
  getItemEffectiveQty: (item: any) => number;
  getItemEffectiveStatus: (item: any) => string;
  getCustomerWalletBalance: (customerName: string) => number;
}

type TaxSubTab = 'clearance_orders' | 'dry_run' | 'gov_ledger';
type SettlementFilter = 'all' | 'unsettled_only' | 'partial_only' | 'settled_only' | 'wht_pending';

interface OrderTaxComputed {
  order: CustomerOrder;
  orderDate: Date;
  netRevenue: number;
  grossRevenue: number;
  outputTax: number;
  inputTax: number;
  netTaxObligation: number;
  whtAmount: number;
  targetRevenue: number;
  currency: string;
  projectName: string;
  isInvoiced: boolean;
  settledAmount: number;
  remainingTax: number;
  settlementStatus: 'settled' | 'partial' | 'unsettled' | 'exempt';
  linkedSettlements: {
    ledgerId: string;
    receiptNumber?: string;
    date: string;
    amount: number;
  }[];
}

export const TaxClearancesView: React.FC<TaxClearancesViewProps> = ({
  orders,
  customers,
  suppliers,
  ledgerEntries,
  supplierPayments,
  currentUser,
  language,
  t,
  onRefresh,
  getOrderProjectName,
  getOrderCurrency,
  getItemEffectiveQty,
  getItemEffectiveStatus,
  getCustomerWalletBalance
}) => {
  // Navigation & Filtering State
  const [activeSubTab, setActiveSubTab] = useState<TaxSubTab>('clearance_orders');
  const [period, setPeriod] = useState<'this_year' | 'last_year' | 'all_time'>('this_year');
  const [search, setSearch] = useState('');
  const [settlementFilter, setSettlementFilter] = useState<SettlementFilter>('all');
  const [sortKey, setSortKey] = useState<string>('orderDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // WHT Upload State
  const [uploadingOrderId, setUploadingOrderId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Record Tax Payment Modal State
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [payAmount, setPayAmount] = useState<string>('');
  const [payDate, setPayDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [payReceiptNo, setPayReceiptNo] = useState<string>('');
  const [payFromAccount, setPayFromAccount] = useState<string>('Cash/Bank');
  const [payMemo, setPayMemo] = useState<string>('');
  const [payReceiptFile, setPayReceiptFile] = useState<File | null>(null);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);
  const [paymentModalError, setPaymentModalError] = useState<string | null>(null);

  // Dry Run Simulator State
  const [dryRunAmountInput, setDryRunAmountInput] = useState<string>('50000');

  // Identify Government Tax Settlement Payments from General Ledger
  const govTaxPayments = useMemo(() => {
    return (ledgerEntries || [])
      .filter(e => {
        if (e.type !== 'COST') return false;
        const cat = (e.category || '').toLowerCase();
        const toAcc = (e.toAccount || '').toLowerCase();
        const desc = (e.description || '').toLowerCase();
        return (
          cat === 'tax settlement' ||
          cat === 'tax payment' ||
          cat.includes('tax') ||
          cat.includes('ضرائب') ||
          toAcc.includes('tax') ||
          toAcc.includes('ضرائب') ||
          desc.includes('tax settlement') ||
          desc.includes('tax authority') ||
          desc.includes('سداد ضرائب') ||
          desc.includes('مصلحة الضرائب')
        );
      })
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [ledgerEntries]);

  // Total government tax payments recorded in the ledger
  const totalGovTaxPaidAllTime = useMemo(() => {
    return govTaxPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  }, [govTaxPayments]);

  // FIFO Engine: compute tax breakdown and sequential FIFO settlement for all orders
  const { allComputedOrders, paymentAllocations, totalUnallocatedGovCash } = useMemo(() => {
    // 1. Filter eligible commercial orders (exclude stock orders and rejected)
    const eligibleOrders = orders.filter(o => {
      if (o.status === OrderStatus.REJECTED) return false;
      if (o.customerName === 'Internal Stock') return false;
      if (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-')) return false;
      return true;
    });

    // 2. Sort chronologically (oldest first for standard FIFO settlement)
    const sorted = [...eligibleOrders].sort((a, b) => {
      const timeA = new Date(a.orderDate || a.dataEntryTimestamp).getTime();
      const timeB = new Date(b.orderDate || b.dataEntryTimestamp).getTime();
      return timeA - timeB;
    });

    // 3. Prepare FIFO payment pool from Ledger tax payments
    const pool = govTaxPayments.map(p => ({
      ledgerId: p.id,
      receiptNumber: p.receiptNumber,
      date: p.date,
      totalAmount: Number(p.amount) || 0,
      remaining: Number(p.amount) || 0,
      description: p.description,
      ordersSettled: [] as { orderId: string; orderNumber: string; amount: number }[]
    }));

    let poolIdx = 0;

    // 4. Compute each order's taxes and consume payments in FIFO sequence
    const computed: OrderTaxComputed[] = sorted.map(o => {
      let netRevenue = 0;
      let outputTax = 0;
      let netCost = 0;
      let inputTax = 0;

      (o.items || []).forEach(it => {
        const qty = getItemEffectiveQty(it);
        const price = Number(it.pricePerUnit) || 0;
        const lineNet = qty * price;
        netRevenue += lineNet;
        const taxRate = it.taxPercent !== undefined ? Number(it.taxPercent) : 14;
        outputTax += lineNet * (taxRate / 100);

        (it.components || []).forEach(c => {
          const cQty = Number(c.quantity) || 0;
          const cCost = Number(c.unitCost) || 0;
          const cNet = cQty * cCost;
          netCost += cNet;
          const cTaxRate = c.taxPercent !== undefined ? Number(c.taxPercent) : 0;
          inputTax += cNet * (cTaxRate / 100);
        });
      });

      const rate = Number(o.conversionRate) || 1;
      inputTax = inputTax * rate;
      const grossRevenue = netRevenue + outputTax;
      const whtAmount = o.appliesWithholdingTax ? grossRevenue * 0.01 : 0;
      const targetRevenue = grossRevenue - whtAmount;
      const netTaxObligation = Math.max(0, outputTax - inputTax);

      const isInvoiced = [
        OrderStatus.INVOICED,
        OrderStatus.HUB_RELEASED,
        OrderStatus.DELIVERED,
        OrderStatus.WAITING_GOVE,
        OrderStatus.FULFILLED
      ].includes(o.status) || Boolean(o.invoiceNumber);

      let needed = netTaxObligation;
      const linkedSettlements: OrderTaxComputed['linkedSettlements'] = [];

      if (netTaxObligation > 0) {
        while (needed > 0 && poolIdx < pool.length) {
          const currentPayment = pool[poolIdx];
          if (currentPayment.remaining <= 0) {
            poolIdx++;
            continue;
          }
          const take = Math.min(needed, currentPayment.remaining);
          currentPayment.remaining -= take;
          needed -= take;

          linkedSettlements.push({
            ledgerId: currentPayment.ledgerId,
            receiptNumber: currentPayment.receiptNumber,
            date: currentPayment.date,
            amount: take
          });

          currentPayment.ordersSettled.push({
            orderId: o.id,
            orderNumber: o.internalOrderNumber || o.customerReferenceNumber || o.id,
            amount: take
          });

          if (currentPayment.remaining <= 0) {
            poolIdx++;
          }
        }
      }

      const settledAmount = netTaxObligation - needed;
      const remainingTax = needed;

      let settlementStatus: OrderTaxComputed['settlementStatus'] = 'unsettled';
      if (netTaxObligation === 0) {
        settlementStatus = 'exempt';
      } else if (remainingTax === 0) {
        settlementStatus = 'settled';
      } else if (settledAmount > 0) {
        settlementStatus = 'partial';
      }

      return {
        order: o,
        orderDate: new Date(o.orderDate || o.dataEntryTimestamp),
        netRevenue,
        grossRevenue,
        outputTax,
        inputTax,
        netTaxObligation,
        whtAmount,
        targetRevenue,
        currency: getOrderCurrency(o),
        projectName: getOrderProjectName(o),
        isInvoiced,
        settledAmount,
        remainingTax,
        settlementStatus,
        linkedSettlements
      };
    });

    const unallocatedCash = pool.reduce((sum, p) => sum + p.remaining, 0);

    return {
      allComputedOrders: computed,
      paymentAllocations: pool,
      totalUnallocatedGovCash: unallocatedCash
    };
  }, [orders, govTaxPayments, getItemEffectiveQty, getOrderCurrency, getOrderProjectName]);

  // Helper: check if a date matches the active period filter
  const matchesPeriod = (date: Date) => {
    const now = new Date();
    const currentYear = now.getFullYear();
    if (period === 'this_year') return date.getFullYear() === currentYear;
    if (period === 'last_year') return date.getFullYear() === currentYear - 1;
    return true; // all_time
  };

  // Period-filtered orders
  const periodFilteredOrders = useMemo(() => {
    return allComputedOrders.filter(co => matchesPeriod(co.orderDate));
  }, [allComputedOrders, period]);

  // Executive Summary Metrics (Dynamic based on selected period)
  const summaryMetrics = useMemo(() => {
    let totalOutputTax = 0;
    let totalInputTax = 0;
    let totalNetTaxObligation = 0;
    let totalSettledTax = 0;
    let totalRemainingTax = 0;
    let totalWhtValue = 0;

    periodFilteredOrders.forEach(co => {
      totalOutputTax += co.outputTax;
      totalInputTax += co.inputTax;
      totalNetTaxObligation += co.netTaxObligation;
      totalSettledTax += co.settledAmount;
      totalRemainingTax += co.remainingTax;
      totalWhtValue += co.whtAmount;
    });

    // Period-filtered gov payments
    const periodGovPayments = govTaxPayments.filter(p => matchesPeriod(new Date(p.date)));
    const totalGovPaymentsPeriod = periodGovPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    // Net tax position for the period: Output VAT - Input VAT - Tax Payments to Gov
    const netTaxPosition = totalNetTaxObligation - totalGovPaymentsPeriod;

    return {
      totalOutputTax,
      totalInputTax,
      totalNetTaxObligation,
      totalSettledTax,
      totalRemainingTax,
      totalWhtValue,
      totalGovPaymentsPeriod,
      netTaxPosition,
      ordersCount: periodFilteredOrders.length,
      settledCount: periodFilteredOrders.filter(o => o.settlementStatus === 'settled').length,
      partialCount: periodFilteredOrders.filter(o => o.settlementStatus === 'partial').length,
      unsettledCount: periodFilteredOrders.filter(o => o.settlementStatus === 'unsettled').length
    };
  }, [periodFilteredOrders, govTaxPayments, period]);

  // Search and status-filtered orders for the main table
  const displayedOrders = useMemo(() => {
    const q = search.toLowerCase().trim();

    const filtered = periodFilteredOrders.filter(co => {
      // Settlement Filter
      if (settlementFilter === 'unsettled_only' && co.settlementStatus !== 'unsettled' && co.settlementStatus !== 'partial') return false;
      if (settlementFilter === 'partial_only' && co.settlementStatus !== 'partial') return false;
      if (settlementFilter === 'settled_only' && co.settlementStatus !== 'settled') return false;
      if (settlementFilter === 'wht_pending' && (co.order.whtCertificateFile || !co.order.appliesWithholdingTax)) return false;

      // Text Search
      if (!q) return true;
      const orderNo = (co.order.internalOrderNumber || '').toLowerCase();
      const poRef = (co.order.customerReferenceNumber || '').toLowerCase();
      const customer = (co.order.customerName || '').toLowerCase();
      const invoice = (co.order.invoiceNumber || '').toLowerCase();
      const project = (co.projectName || '').toLowerCase();

      return (
        orderNo.includes(q) ||
        poRef.includes(q) ||
        customer.includes(q) ||
        invoice.includes(q) ||
        project.includes(q)
      );
    });

    // Sorting
    return [...filtered].sort((a, b) => {
      let valA: any = '';
      let valB: any = '';

      if (sortKey === 'orderDate') {
        valA = a.orderDate.getTime();
        valB = b.orderDate.getTime();
      } else if (sortKey === 'internalOrderNumber') {
        valA = a.order.internalOrderNumber || '';
        valB = b.order.internalOrderNumber || '';
      } else if (sortKey === 'customerName') {
        valA = a.order.customerName || '';
        valB = b.order.customerName || '';
      } else if (sortKey === 'grossRevenue') {
        valA = a.grossRevenue;
        valB = b.grossRevenue;
      } else if (sortKey === 'netTaxObligation') {
        valA = a.netTaxObligation;
        valB = b.netTaxObligation;
      } else if (sortKey === 'remainingTax') {
        valA = a.remainingTax;
        valB = b.remainingTax;
      }

      if (valA < valB) return sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [periodFilteredOrders, search, settlementFilter, sortKey, sortDir]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // Upload WHT Certificate Handler
  const handleUploadWHT = async (orderId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingOrderId(orderId);
    setUploadError(null);
    try {
      const data = await dataService.uploadWhtCertificate(file);
      if (data && data.success) {
        await dataService.updateOrder(orderId, { whtCertificateFile: data.filePath });
        await onRefresh();
      } else {
        throw new Error(data?.error || 'Upload failed');
      }
    } catch (err: any) {
      setUploadError(err.message || 'Failed to upload WHT certificate');
    } finally {
      setUploadingOrderId(null);
    }
  };

  // Submit Government Tax Payment Modal
  const handleSubmitTaxPayment = async () => {
    const amt = parseFloat(payAmount);
    if (isNaN(amt) || amt <= 0) {
      setPaymentModalError(language === 'ar' ? 'يرجى إدخال مبلغ سداد ضريبي صحيح وأكبر من الصفر' : 'Please enter a valid positive tax payment amount');
      return;
    }

    setIsSubmittingPayment(true);
    setPaymentModalError(null);
    try {
      let receiptFilePath: string | undefined = undefined;
      if (payReceiptFile) {
        const uploadRes = await dataService.uploadWhtCertificate(payReceiptFile);
        if (uploadRes && uploadRes.filePath) {
          receiptFilePath = uploadRes.filePath;
        }
      }

      await dataService.recordTaxSettlement(
        amt,
        payMemo.trim() || (language === 'ar' ? 'سداد لمصلحة الضرائب المصرية' : 'Tax Authority Settlement'),
        payDate,
        payReceiptNo.trim() || undefined,
        payFromAccount,
        receiptFilePath
      );

      setShowPaymentModal(false);
      setPayAmount('');
      setPayReceiptNo('');
      setPayMemo('');
      setPayReceiptFile(null);
      await onRefresh();
    } catch (err: any) {
      setPaymentModalError(err.message || 'Failed to record tax settlement');
    } finally {
      setIsSubmittingPayment(false);
    }
  };

  // Dry Run Simulation Engine
  const dryRunSimulation = useMemo(() => {
    const simAmount = Math.max(0, parseFloat(dryRunAmountInput) || 0);

    // Take all orders that have remaining tax debt, in chronological order
    const pendingOrders = allComputedOrders
      .filter(co => co.remainingTax > 0)
      .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime());

    const totalOutstandingDebt = pendingOrders.reduce((s, o) => s + o.remainingTax, 0);

    let remainingCash = simAmount;
    let simulatedFullySettledCount = 0;
    let simulatedPartiallySettledCount = 0;
    let simulatedUnsettledCount = 0;

    const simulatedRows = pendingOrders.map(co => {
      const currentDebt = co.remainingTax;
      const simAllocated = Math.min(remainingCash, currentDebt);
      const projectedBalance = currentDebt - simAllocated;
      remainingCash -= simAllocated;

      let projectedStatus: 'sim_settled' | 'sim_partial' | 'sim_unsettled' = 'sim_unsettled';
      if (projectedBalance === 0) {
        projectedStatus = 'sim_settled';
        simulatedFullySettledCount++;
      } else if (simAllocated > 0) {
        projectedStatus = 'sim_partial';
        simulatedPartiallySettledCount++;
      } else {
        simulatedUnsettledCount++;
      }

      const coveragePct = currentDebt > 0 ? (simAllocated / currentDebt) * 100 : 100;

      return {
        ...co,
        currentDebt,
        simAllocated,
        projectedBalance,
        projectedStatus,
        coveragePct
      };
    });

    const totalSimulatedSettled = simAmount - remainingCash;
    const projectedRemainingDebt = Math.max(0, totalOutstandingDebt - totalSimulatedSettled);
    const overallCoveragePct = totalOutstandingDebt > 0 ? (totalSimulatedSettled / totalOutstandingDebt) * 100 : 100;

    return {
      simAmount,
      totalOutstandingDebt,
      totalSimulatedSettled,
      projectedRemainingDebt,
      overallCoveragePct,
      simulatedFullySettledCount,
      simulatedPartiallySettledCount,
      simulatedUnsettledCount,
      unallocatedRemittance: remainingCash,
      simulatedRows
    };
  }, [allComputedOrders, dryRunAmountInput]);

  return (
    <div className="space-y-6 animate-in fade-in duration-300" dir={language === 'ar' ? 'rtl' : 'ltr'}>
      {/* Top Banner & Title Section */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-700 text-white flex items-center justify-center text-2xl shadow-md shrink-0">
            <i className="fa-solid fa-scale-balanced"></i>
          </div>
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-black text-slate-900 tracking-tight">
                {language === 'ar' ? 'التخليص الضريبي والموقف المالي للضرائب' : 'Tax Clearances & VAT Settlements'}
              </h1>
              <span className="px-2.5 py-0.5 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-black uppercase tracking-wider">
                {language === 'ar' ? 'مصلحة الضرائب المصرية • ETA' : 'ETA Compliant • FIFO'}
              </span>
            </div>
            <p className="text-xs text-slate-500 font-medium mt-1">
              {language === 'ar'
                ? 'مطابقة ضريبة القيمة المضافة (14%)، تسوية المدخلات والمخرجات، سداد الضرائب وفق أقدمية الأوامر (FIFO)، ومحاكاة السداد قبل الإقرار'
                : 'Reconcile Output VAT (14%), Deductible Input VAT, FIFO Government Tax Settlements & Pre-filing Dry Run Simulator'}
            </p>
          </div>
        </div>

        {/* Sub-tab Navigation Buttons & Primary Action */}
        <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto justify-end">
          <div className="flex items-center gap-1 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
            <button
              type="button"
              onClick={() => setActiveSubTab('clearance_orders')}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'clearance_orders' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <i className="fa-solid fa-list-check text-xs"></i>
              <span>{language === 'ar' ? 'أوامر الشراء والتسوية' : 'Orders & FIFO'}</span>
              <span className="px-1.5 py-0.2 rounded-md bg-indigo-100 text-indigo-800 text-[9px] font-bold">
                {summaryMetrics.ordersCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab('dry_run')}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'dry_run' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <i className="fa-solid fa-flask text-xs text-amber-500"></i>
              <span>{language === 'ar' ? 'محاكاة السداد (تجربة افتراضية)' : 'Payment Dry Run'}</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab('gov_ledger')}
              className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 cursor-pointer ${
                activeSubTab === 'gov_ledger' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <i className="fa-solid fa-landmark text-xs text-purple-600"></i>
              <span>{language === 'ar' ? 'سجل سدادات الحكومة' : 'Gov Tax Payments'}</span>
              <span className="px-1.5 py-0.2 rounded-md bg-purple-100 text-purple-800 text-[9px] font-bold">
                {govTaxPayments.length}
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setPayAmount(summaryMetrics.netTaxPosition > 0 ? summaryMetrics.netTaxPosition.toFixed(2) : '');
              setShowPaymentModal(true);
            }}
            className="px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-black uppercase transition-all shadow-md shadow-slate-200 flex items-center gap-2 cursor-pointer shrink-0"
          >
            <i className="fa-solid fa-plus-circle text-emerald-400"></i>
            <span>{language === 'ar' ? 'سداد لمصلحة الضرائب' : 'Record Tax Payment'}</span>
          </button>
        </div>
      </div>

      {/* 4 Executive KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Output VAT Billed */}
        <div className="bg-gradient-to-br from-blue-50/70 to-indigo-50/40 rounded-3xl p-5 border border-blue-200 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-blue-900 flex items-center gap-1.5">
              <i className="fa-solid fa-file-invoice text-blue-600"></i>
              {language === 'ar' ? 'ضريبة المخرجات (المبيعات)' : 'Output VAT (Billed)'}
            </span>
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-blue-100 text-blue-800">
              14% VAT
            </span>
          </div>
          <div className="text-2xl font-black text-blue-950 font-mono">
            {summaryMetrics.totalOutputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
            <span className="text-xs font-bold">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
          </div>
          <div className="text-[11px] text-blue-700/80 font-medium mt-1 flex items-center justify-between">
            <span>{language === 'ar' ? `محسوبة على ${summaryMetrics.ordersCount} طلب` : `On ${summaryMetrics.ordersCount} customer POs`}</span>
            <span className="text-[9px] text-blue-600 font-bold">{language === 'ar' ? 'إجمالي المحصل' : 'Total Output'}</span>
          </div>
        </div>

        {/* Card 2: Input VAT Deductible */}
        <div className="bg-gradient-to-br from-emerald-50/70 to-teal-50/40 rounded-3xl p-5 border border-emerald-200 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-emerald-900 flex items-center gap-1.5">
              <i className="fa-solid fa-truck-ramp-box text-emerald-600"></i>
              {language === 'ar' ? 'ضريبة المدخلات (الموردين)' : 'Input VAT (Deductible)'}
            </span>
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-emerald-100 text-emerald-800">
              {language === 'ar' ? 'خصم ضريبي' : 'Tax Credit'}
            </span>
          </div>
          <div className="text-2xl font-black text-emerald-950 font-mono">
            -{summaryMetrics.totalInputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
            <span className="text-xs font-bold">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
          </div>
          <div className="text-[11px] text-emerald-700/80 font-medium mt-1 flex items-center justify-between">
            <span>{language === 'ar' ? 'ضريبة مدفوعة لمشتريات الموردين' : 'Paid on supplier parts'}</span>
            <span className="text-[9px] text-emerald-600 font-bold">{language === 'ar' ? 'تخصم بالكامل' : '100% Offset'}</span>
          </div>
        </div>

        {/* Card 3: Government Tax Settlements Paid */}
        <div className="bg-gradient-to-br from-purple-50/70 to-fuchsia-50/40 rounded-3xl p-5 border border-purple-200 shadow-xs relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-purple-900 flex items-center gap-1.5">
              <i className="fa-solid fa-landmark text-purple-600"></i>
              {language === 'ar' ? 'المسدد لمصلحة الضرائب' : 'Gov Tax Settlements'}
            </span>
            <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-purple-100 text-purple-800">
              {language === 'ar' ? 'مسجل بالدفتر' : 'In Ledger'}
            </span>
          </div>
          <div className="text-2xl font-black text-purple-950 font-mono">
            {summaryMetrics.totalGovPaymentsPeriod.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
            <span className="text-xs font-bold">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
          </div>
          <div className="text-[11px] text-purple-700/80 font-medium mt-1 flex items-center justify-between">
            <span>
              {language === 'ar'
                ? `${govTaxPayments.length} سدادات فعلية`
                : `${govTaxPayments.length} bank payments`}
            </span>
            <span className="text-[9px] text-purple-600 font-bold">
              {language === 'ar' ? 'تسوية FIFO' : 'FIFO Applied'}
            </span>
          </div>
        </div>

        {/* Card 4: Net Tax Liability Due to Authority */}
        <div className={`rounded-3xl p-5 border shadow-xs relative overflow-hidden ${
          summaryMetrics.netTaxPosition > 0
            ? 'bg-gradient-to-br from-amber-50/80 to-rose-50/40 border-amber-300'
            : 'bg-gradient-to-br from-teal-50/80 to-emerald-50/40 border-teal-300'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 ${
              summaryMetrics.netTaxPosition > 0 ? 'text-amber-950' : 'text-teal-950'
            }`}>
              <i className="fa-solid fa-coins"></i>
              {language === 'ar' ? 'صافي الموقف الضريبي المستحق' : 'Net Tax Due to Authority'}
            </span>
            <span className={`px-2 py-0.5 rounded-md text-[9px] font-black uppercase ${
              summaryMetrics.netTaxPosition > 0
                ? 'bg-amber-200 text-amber-900'
                : 'bg-teal-200 text-teal-900'
            }`}>
              {summaryMetrics.netTaxPosition > 0
                ? (language === 'ar' ? 'واجب السداد' : 'Payable')
                : (language === 'ar' ? 'رصيد دائن' : 'Credit Balance')}
            </span>
          </div>
          <div className={`text-2xl font-black font-mono ${
            summaryMetrics.netTaxPosition > 0 ? 'text-amber-950' : 'text-teal-950'
          }`}>
            {summaryMetrics.netTaxPosition > 0 ? '+' : ''}
            {summaryMetrics.netTaxPosition.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
            <span className="text-xs font-bold">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
          </div>
          <div className={`text-[11px] font-medium mt-1 flex items-center justify-between ${
            summaryMetrics.netTaxPosition > 0 ? 'text-amber-800' : 'text-teal-800'
          }`}>
            <span>{language === 'ar' ? 'المتبقي للسداد: المخرجات - المدخلات - السدادات' : 'Out - In - Gov Settlements'}</span>
            <span className="font-bold text-[9px] font-mono">
              {summaryMetrics.unsettledCount} {language === 'ar' ? 'طلب معلق' : 'due POs'}
            </span>
          </div>
        </div>
      </div>

      {/* SUB-TAB 1: ORDERS & FIFO SETTLEMENT */}
      {activeSubTab === 'clearance_orders' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-6">
          {/* Controls Bar: Filters & Search */}
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              {/* Period Dropdown */}
              <div className="relative group w-44">
                <select
                  value={period}
                  onChange={e => setPeriod(e.target.value as any)}
                  className="w-full pl-9 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-black uppercase text-slate-700 outline-none focus:border-indigo-500 shadow-2xs appearance-none transition-all cursor-pointer"
                >
                  <option value="this_year">{language === 'ar' ? 'هذا العام (2026)' : 'This Year (2026)'}</option>
                  <option value="last_year">{language === 'ar' ? 'العام السابق (2025)' : 'Last Year (2025)'}</option>
                  <option value="all_time">{language === 'ar' ? 'كل الفترات (تاريخي)' : 'All Time (Historical)'}</option>
                </select>
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                  <i className="fa-solid fa-calendar-days text-xs"></i>
                </div>
              </div>

              {/* Settlement Status Filter */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-2xl border border-slate-200">
                <button
                  type="button"
                  onClick={() => setSettlementFilter('all')}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer ${
                    settlementFilter === 'all' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {language === 'ar' ? 'الكل' : 'All'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettlementFilter('unsettled_only')}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer flex items-center gap-1.5 ${
                    settlementFilter === 'unsettled_only' ? 'bg-rose-50 text-rose-700 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                  {language === 'ar' ? 'غير مسددة' : 'Unsettled'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettlementFilter('partial_only')}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer flex items-center gap-1.5 ${
                    settlementFilter === 'partial_only' ? 'bg-amber-50 text-amber-700 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                  {language === 'ar' ? 'مسددة جزئياً' : 'Partial'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettlementFilter('settled_only')}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer flex items-center gap-1.5 ${
                    settlementFilter === 'settled_only' ? 'bg-emerald-50 text-emerald-700 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  {language === 'ar' ? 'مسددة بالكامل' : 'Settled'}
                </button>
                <button
                  type="button"
                  onClick={() => setSettlementFilter('wht_pending')}
                  className={`px-3 py-1.5 rounded-xl text-[11px] font-black uppercase transition-all cursor-pointer flex items-center gap-1.5 ${
                    settlementFilter === 'wht_pending' ? 'bg-indigo-50 text-indigo-700 shadow-2xs' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <i className="fa-solid fa-file-shield text-xs text-indigo-600"></i>
                  {language === 'ar' ? 'شهادة الخصم معلقة' : 'WHT Pending'}
                </button>
              </div>
            </div>

            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={language === 'ar' ? 'بحث برقم الطلب، العميل، أمر الشراء، الفاتورة، أو المشروع...' : 'Search Order #, PO, Customer, Invoice, Project...'}
                className="w-full px-4 py-2.5 pl-10 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-800 placeholder-slate-400 outline-none focus:border-indigo-500 shadow-2xs transition-all"
              />
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                <i className="fa-solid fa-magnifying-glass text-xs"></i>
              </div>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <i className="fa-solid fa-times-circle text-xs"></i>
                </button>
              )}
            </div>
          </div>

          {/* FIFO Status Legend Banner */}
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-black text-slate-700 uppercase tracking-wider text-[10px]">
                {language === 'ar' ? 'منهجية التسوية FIFO:' : 'FIFO Settlement Methodology:'}
              </span>
              <span className="text-slate-500 font-medium">
                {language === 'ar'
                  ? 'يتم سداد التزامات ضرائب الأوامر بتسلسل زمني من الأقدم إلى الأحدث فور تسجيل السداد الحكومي بدفتر الأستاذ.'
                  : 'PO tax obligations are cleared chronologically from oldest to newest as tax remittances are posted to the General Ledger.'}
              </span>
            </div>
            {totalUnallocatedGovCash > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-purple-100 text-purple-800 rounded-xl font-bold text-[10px]">
                <i className="fa-solid fa-circle-check text-purple-600"></i>
                <span>
                  {language === 'ar'
                    ? `فائض سدادات غير مخصص: ${totalUnallocatedGovCash.toLocaleString()} ج.م`
                    : `Unallocated Tax Surplus: ${totalUnallocatedGovCash.toLocaleString()} L.E.`}
                </span>
              </div>
            )}
          </div>

          {/* Master Tax Clearances Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-200 shadow-2xs">
            <table className="w-full text-start text-xs">
              <thead className="bg-slate-900 text-slate-400 text-[10px] font-black uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-start cursor-pointer select-none text-white" onClick={() => handleSort('internalOrderNumber')}>
                    {language === 'ar' ? 'تفاصيل الطلب والعميل' : 'Order Context & Customer'} {sortKey === 'internalOrderNumber' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-3 py-3 text-start cursor-pointer select-none text-white" onClick={() => handleSort('orderDate')}>
                    {language === 'ar' ? 'التاريخ والفاتورة' : 'Date / Invoice'} {sortKey === 'orderDate' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-3 py-3 text-end cursor-pointer select-none text-white" onClick={() => handleSort('grossRevenue')}>
                    {language === 'ar' ? 'قيمة الطلب الإجمالية' : 'Gross PO'} {sortKey === 'grossRevenue' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-3 py-3 text-end text-white">
                    {language === 'ar' ? 'المخرجات (14%)' : 'Output VAT'}
                  </th>
                  <th className="px-3 py-3 text-end text-white">
                    {language === 'ar' ? 'المدخلات (مخصومة)' : 'Input VAT'}
                  </th>
                  <th className="px-3 py-3 text-end cursor-pointer select-none text-white" onClick={() => handleSort('netTaxObligation')}>
                    {language === 'ar' ? 'صافي الالتزام' : 'Net Obligation'} {sortKey === 'netTaxObligation' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-3 py-3 text-end text-white">
                    {language === 'ar' ? 'المسدد (FIFO)' : 'Settled (FIFO)'}
                  </th>
                  <th className="px-3 py-3 text-end cursor-pointer select-none text-white" onClick={() => handleSort('remainingTax')}>
                    {language === 'ar' ? 'المتبقي للسداد' : 'Remaining Due'} {sortKey === 'remainingTax' ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-3 py-3 text-center text-white">
                    {language === 'ar' ? 'حالة التسوية' : 'Settlement Status'}
                  </th>
                  <th className="px-3 py-3 text-center text-white">
                    {language === 'ar' ? 'شهادة الخصم ن.41' : 'WHT Cert (1%)'}
                  </th>
                  <th className="px-3 py-3 text-center text-white">
                    {language === 'ar' ? 'التفاصيل' : 'Details'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {displayedOrders.map((co, idx) => {
                  const isExpanded = expandedOrderId === co.order.id;
                  const isEven = idx % 2 === 1;

                  return (
                    <React.Fragment key={co.order.id}>
                      <tr className={`${isEven ? 'bg-slate-50/50' : 'bg-white'} hover:bg-indigo-50/40 transition-colors`}>
                        {/* 1. Context & Customer */}
                        <td className="px-4 py-3.5">
                          <div className="font-mono text-[11px] font-black text-indigo-600 flex items-center gap-2 flex-wrap">
                            <span>{co.order.internalOrderNumber}</span>
                            {co.order.customerReferenceNumber && (
                              <span className="text-slate-500 font-bold text-[9px] bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                                {language === 'ar' ? 'أمر شراء:' : 'PO:'} {co.order.customerReferenceNumber}
                              </span>
                            )}
                            {co.projectName ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-black uppercase">
                                <i className="fa-solid fa-diagram-project text-[8px]"></i>
                                {co.projectName}
                              </span>
                            ) : null}
                          </div>
                          <div className="font-bold text-slate-800 text-xs mt-1 flex items-center gap-2">
                            <span>{co.order.customerName}</span>
                            {(() => {
                              const bal = getCustomerWalletBalance(co.order.customerName);
                              if (bal !== 0) {
                                return (
                                  <span className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border ${
                                    bal > 0 ? 'bg-teal-50 text-teal-700 border-teal-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                                  }`}>
                                    {bal > 0 ? `+${bal.toLocaleString()} ج.م` : `-${Math.abs(bal).toLocaleString()} ج.م`}
                                  </span>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        </td>

                        {/* 2. Date & Invoice */}
                        <td className="px-3 py-3.5">
                          <div className="text-slate-700 font-bold text-xs">
                            {co.orderDate.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}
                          </div>
                          <div className="mt-0.5">
                            {co.order.invoiceNumber ? (
                              <span className="inline-flex items-center gap-1 text-[9px] font-mono font-black text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                                <i className="fa-solid fa-file-invoice text-[8px]"></i>
                                {co.order.invoiceNumber}
                              </span>
                            ) : (
                              <span className="text-[9px] text-slate-400 font-semibold uppercase">
                                {language === 'ar' ? 'قيد الفوترة' : 'Uninvoiced'}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* 3. Gross PO Value */}
                        <td className="px-3 py-3.5 text-end font-mono font-bold text-slate-800">
                          {co.grossRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                          <span className="text-[10px] text-slate-500">{co.currency === 'L.E.' && language === 'ar' ? 'ج.م' : co.currency}</span>
                        </td>

                        {/* 4. Output VAT (14%) */}
                        <td className="px-3 py-3.5 text-end font-mono font-bold text-blue-700">
                          +{co.outputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>

                        {/* 5. Input VAT */}
                        <td className="px-3 py-3.5 text-end font-mono font-bold text-emerald-700">
                          -{co.inputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>

                        {/* 6. Net Obligation */}
                        <td className="px-3 py-3.5 text-end font-mono font-black text-indigo-900">
                          {co.netTaxObligation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>

                        {/* 7. Settled FIFO */}
                        <td className="px-3 py-3.5 text-end font-mono font-bold text-purple-700">
                          {co.settledAmount > 0 ? (
                            <div className="flex flex-col items-end">
                              <span>+{co.settledAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              {co.linkedSettlements.length > 0 && (
                                <span className="text-[9px] text-purple-600 font-bold bg-purple-50 px-1 rounded">
                                  {co.linkedSettlements.length} {language === 'ar' ? 'سدادات بالدفتر' : 'GL links'}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-300">0.00</span>
                          )}
                        </td>

                        {/* 8. Remaining Due */}
                        <td className="px-3 py-3.5 text-end font-mono font-black">
                          <span className={co.remainingTax > 0 ? 'text-rose-600' : 'text-emerald-600'}>
                            {co.remainingTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </td>

                        {/* 9. Settlement Status Badge */}
                        <td className="px-3 py-3.5 text-center">
                          {co.settlementStatus === 'settled' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase shadow-2xs">
                              <i className="fa-solid fa-check-circle text-emerald-500"></i>
                              {language === 'ar' ? 'مسدد بالكامل' : 'Fully Settled'}
                            </span>
                          )}
                          {co.settlementStatus === 'partial' && (
                            <div className="flex flex-col items-center gap-1">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-black uppercase">
                                <i className="fa-solid fa-clock-rotate-left text-amber-500"></i>
                                {language === 'ar' ? 'مسدد جزئياً' : 'Partial'}
                              </span>
                              <div className="w-16 bg-slate-200 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-amber-500 h-1.5 rounded-full"
                                  style={{ width: `${Math.min(100, (co.settledAmount / Math.max(1, co.netTaxObligation)) * 100)}%` }}
                                ></div>
                              </div>
                            </div>
                          )}
                          {co.settlementStatus === 'unsettled' && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-black uppercase">
                              <i className="fa-solid fa-hourglass-half text-rose-500"></i>
                              {language === 'ar' ? 'غير مسدد' : 'Unsettled'}
                            </span>
                          )}
                          {co.settlementStatus === 'exempt' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 text-[9px] font-bold uppercase">
                              {language === 'ar' ? 'معفى / متوازن' : 'Zero Net Tax'}
                            </span>
                          )}
                        </td>

                        {/* 10. WHT Certificate (1%) */}
                        <td className="px-3 py-3.5 text-center">
                          {co.order.appliesWithholdingTax ? (
                            co.order.whtCertificateFile ? (
                              <a
                                href={`${import.meta.env.VITE_BACKEND_URL || ''}/${co.order.whtCertificateFile.replace(/^[\/\\]+/, '')}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-xl text-[9px] font-black uppercase hover:bg-emerald-100 transition-all cursor-pointer"
                              >
                                <i className="fa-solid fa-file-shield text-xs"></i>
                                {language === 'ar' ? 'تم التخليص' : 'Cleared'}
                              </a>
                            ) : (
                              <label className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-900 hover:bg-black text-white rounded-xl text-[9px] font-black uppercase cursor-pointer transition-all shadow-2xs">
                                <i className={`fa-solid ${uploadingOrderId === co.order.id ? 'fa-spinner fa-spin' : 'fa-upload'}`}></i>
                                <span>{language === 'ar' ? 'رفع ن.41' : 'Upload'}</span>
                                <input
                                  type="file"
                                  className="hidden"
                                  accept=".pdf,.jpg,.jpeg,.png"
                                  disabled={uploadingOrderId === co.order.id}
                                  onChange={e => handleUploadWHT(co.order.id, e)}
                                />
                              </label>
                            )
                          ) : (
                            <span className="text-[9px] text-slate-400 font-medium">
                              {language === 'ar' ? 'لا ينطبق' : 'N/A'}
                            </span>
                          )}
                        </td>

                        {/* 11. Details Toggle Button */}
                        <td className="px-3 py-3.5 text-center">
                          <button
                            type="button"
                            onClick={() => setExpandedOrderId(isExpanded ? null : co.order.id)}
                            className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-indigo-100 text-slate-600 hover:text-indigo-700 transition-all flex items-center justify-center text-xs cursor-pointer"
                            title={language === 'ar' ? 'عرض تفاصيل الضرائب والبنود' : 'View tax audit details'}
                          >
                            <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}`}></i>
                          </button>
                        </td>
                      </tr>

                      {/* Expandable Audit Row */}
                      {isExpanded && (
                        <tr className="bg-indigo-50/30 border-y border-indigo-100">
                          <td colSpan={11} className="p-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                              {/* Pillar 1: Output VAT Breakdown */}
                              <div className="bg-white p-3.5 rounded-2xl border border-indigo-100 space-y-2">
                                <div className="font-black text-indigo-900 text-[11px] uppercase tracking-wider flex items-center gap-1.5 border-b border-indigo-50 pb-1.5">
                                  <i className="fa-solid fa-receipt text-blue-600"></i>
                                  {language === 'ar' ? 'بنود المبيعات وضريبة المخرجات' : 'Sales Items & Output VAT'}
                                </div>
                                <div className="space-y-1">
                                  {(co.order.items || []).map((it, iIdx) => {
                                    const qty = getItemEffectiveQty(it);
                                    const net = qty * (Number(it.pricePerUnit) || 0);
                                    const rate = it.taxPercent !== undefined ? Number(it.taxPercent) : 14;
                                    const tax = net * (rate / 100);
                                    return (
                                      <div key={iIdx} className="flex justify-between items-center text-[10px] py-1 border-b border-slate-50">
                                        <span className="text-slate-700 font-bold truncate max-w-[160px]">{it.description || `Item #${iIdx + 1}`}</span>
                                        <span className="font-mono text-slate-900">{tax.toFixed(2)} ج.م ({rate}%)</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>

                              {/* Pillar 2: Sourced Input VAT Breakdown */}
                              <div className="bg-white p-3.5 rounded-2xl border border-indigo-100 space-y-2">
                                <div className="font-black text-emerald-900 text-[11px] uppercase tracking-wider flex items-center gap-1.5 border-b border-emerald-50 pb-1.5">
                                  <i className="fa-solid fa-boxes-stacked text-emerald-600"></i>
                                  {language === 'ar' ? 'مكونات الشراء وضريبة المدخلات' : 'Sourced Input VAT Credit'}
                                </div>
                                <div className="space-y-1">
                                  {(co.order.items || []).flatMap(it => it.components || []).length > 0 ? (
                                    (co.order.items || []).flatMap(it => it.components || []).slice(0, 5).map((comp, cIdx) => {
                                      const cQty = Number(comp.quantity) || 0;
                                      const cCost = Number(comp.unitCost) || 0;
                                      const cNet = cQty * cCost;
                                      const cRate = comp.taxPercent !== undefined ? Number(comp.taxPercent) : 0;
                                      const cTax = cNet * (cRate / 100);
                                      return (
                                        <div key={cIdx} className="flex justify-between items-center text-[10px] py-1 border-b border-slate-50">
                                          <span className="text-slate-700 font-medium truncate max-w-[160px]">{comp.description || `Part #${cIdx + 1}`}</span>
                                          <span className="font-mono text-emerald-700">-{cTax.toFixed(2)} ج.م ({cRate}%)</span>
                                        </div>
                                      );
                                    })
                                  ) : (
                                    <div className="text-[10px] text-slate-400 italic py-2">
                                      {language === 'ar' ? 'لا توجد مكونات شراء مسجلة بضريبة مدخلات' : 'No components with input tax registered'}
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Pillar 3: FIFO Settlement Audit Trail */}
                              <div className="bg-white p-3.5 rounded-2xl border border-indigo-100 space-y-2">
                                <div className="font-black text-purple-900 text-[11px] uppercase tracking-wider flex items-center gap-1.5 border-b border-purple-50 pb-1.5">
                                  <i className="fa-solid fa-link text-purple-600"></i>
                                  {language === 'ar' ? 'سجل التسوية التراكمية (FIFO بالدفتر)' : 'FIFO Ledger Settlement Links'}
                                </div>
                                <div className="space-y-1.5">
                                  {co.linkedSettlements.length > 0 ? (
                                    co.linkedSettlements.map((link, lIdx) => (
                                      <div key={lIdx} className="p-2 rounded-xl bg-purple-50/60 border border-purple-100 text-[10px] space-y-0.5">
                                        <div className="flex justify-between font-mono font-black text-purple-900">
                                          <span>{link.receiptNumber ? `إيصال #${link.receiptNumber}` : link.ledgerId}</span>
                                          <span>+{link.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م</span>
                                        </div>
                                        <div className="text-slate-500 text-[9px]">
                                          {new Date(link.date).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')} • {language === 'ar' ? 'سداد حكومي مسجل بالدفتر' : 'Gov Tax Settlement in GL'}
                                        </div>
                                      </div>
                                    ))
                                  ) : (
                                    <div className="text-[10px] text-rose-600 font-bold bg-rose-50 p-2.5 rounded-xl border border-rose-100">
                                      <i className="fa-solid fa-hourglass-half mr-1 ml-1"></i>
                                      {language === 'ar' ? 'بانتظار سداد ضريبي مسجل بالدفتر لتسوية هذا الطلب' : 'Awaiting general ledger tax payment to settle this PO'}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {displayedOrders.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-16 text-center text-slate-400 font-bold text-xs uppercase tracking-wider">
                      <i className="fa-solid fa-file-invoice-dollar text-4xl block mb-2 opacity-25"></i>
                      {language === 'ar' ? 'لا توجد أوامر مطابقة لمعايير البحث والتصفية الضريبية' : 'No orders found matching the tax clearance filters'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: DRY RUN PAYMENT SIMULATOR */}
      {activeSubTab === 'dry_run' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-6">
          {/* Simulation Header Notice Banner */}
          <div className="p-5 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-amber-500 text-white flex items-center justify-center text-xl shrink-0 shadow-sm">
                <i className="fa-solid fa-flask"></i>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-black text-amber-950 text-sm uppercase tracking-wide">
                    {language === 'ar' ? 'محاكاة سداد الضرائب (تجربة افتراضية بدون تعديل البيانات)' : 'Tax Settlement Simulator (Non-Destructive Dry Run)'}
                  </h3>
                  <span className="px-2 py-0.5 rounded-md bg-amber-200 text-amber-900 text-[9px] font-black uppercase">
                    {language === 'ar' ? 'وضع المحاكاة' : 'Simulation Only'}
                  </span>
                </div>
                <p className="text-xs text-amber-800 font-medium mt-0.5">
                  {language === 'ar'
                    ? 'أدخل مبلغ السداد المقترح لمصلحة الضرائب لترى بالكامل أي أوامر الشراء سيتم تسويتها وفقاً لمبدأ FIFO، ونسبة تغطية الديون الضريبية، دون أي تأثير على قاعدة البيانات.'
                    : 'Input a proposed tax payment to simulate exact FIFO clearance across unsettled PO tax liabilities, analyze coverage ratios, and plan remittances without modifying the database.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setPayAmount(dryRunSimulation.simAmount > 0 ? dryRunSimulation.simAmount.toFixed(2) : '');
                setPayMemo(language === 'ar' ? `سداد ضريبي كما تمت محاكاته (${dryRunSimulation.simulatedFullySettledCount} طلب مسدد)` : `Tax settlement as simulated (${dryRunSimulation.simulatedFullySettledCount} orders cleared)`);
                setShowPaymentModal(true);
              }}
              className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-black uppercase transition-all shadow-sm flex items-center gap-2 cursor-pointer shrink-0"
            >
              <i className="fa-solid fa-check-double"></i>
              <span>{language === 'ar' ? 'تنفيذ هذا السداد بالدفتر الآن' : 'Execute in General Ledger'}</span>
            </button>
          </div>

          {/* Interactive Amount Input & Presets */}
          <div className="bg-slate-50 p-5 rounded-2xl border border-slate-200 space-y-4">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-slate-800 mb-1">
                  {language === 'ar' ? 'مبلغ السداد المقترح لمصلحة الضرائب (ج.م):' : 'Proposed Tax Remittance Amount (L.E.):'}
                </label>
                <div className="text-[11px] text-slate-500">
                  {language === 'ar'
                    ? `إجمالي الديون الضريبية غير المسددة حالياً: ${dryRunSimulation.totalOutstandingDebt.toLocaleString(undefined, { minimumFractionDigits: 2 })} ج.م`
                    : `Total unsettled tax obligations across all active POs: ${dryRunSimulation.totalOutstandingDebt.toLocaleString(undefined, { minimumFractionDigits: 2 })} L.E.`}
                </div>
              </div>

              {/* Input field with currency indicator */}
              <div className="relative w-full md:w-72">
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={dryRunAmountInput}
                  onChange={e => setDryRunAmountInput(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-4 py-3 pl-12 bg-white border-2 border-amber-300 rounded-2xl text-lg font-black font-mono text-slate-900 outline-none focus:border-amber-500 shadow-xs"
                />
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-xs pointer-events-none">
                  {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>
            </div>

            {/* Quick Preset Buttons */}
            <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-200">
              <span className="text-[10px] font-black uppercase text-slate-500">
                {language === 'ar' ? 'خيارات سريعة:' : 'Quick Presets:'}
              </span>
              <button
                type="button"
                onClick={() => setDryRunAmountInput(dryRunSimulation.totalOutstandingDebt.toFixed(2))}
                className="px-3 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 shadow-2xs cursor-pointer transition-all"
              >
                {language === 'ar' ? 'سداد كامل المديونية (100%)' : 'Settle 100% Debt'}
              </button>
              <button
                type="button"
                onClick={() => setDryRunAmountInput((dryRunSimulation.totalOutstandingDebt * 0.5).toFixed(2))}
                className="px-3 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 shadow-2xs cursor-pointer transition-all"
              >
                {language === 'ar' ? 'سداد 50% من المديونية' : 'Settle 50% Debt'}
              </button>
              <button
                type="button"
                onClick={() => setDryRunAmountInput('25000')}
                className="px-3 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 shadow-2xs cursor-pointer transition-all font-mono"
              >
                25,000 ج.م
              </button>
              <button
                type="button"
                onClick={() => setDryRunAmountInput('50000')}
                className="px-3 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 shadow-2xs cursor-pointer transition-all font-mono"
              >
                50,000 ج.م
              </button>
              <button
                type="button"
                onClick={() => setDryRunAmountInput('100000')}
                className="px-3 py-1 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 shadow-2xs cursor-pointer transition-all font-mono"
              >
                100,000 ج.م
              </button>
              <button
                type="button"
                onClick={() => setDryRunAmountInput('0')}
                className="px-3 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-bold shadow-2xs cursor-pointer transition-all"
              >
                {language === 'ar' ? 'تفريغ' : 'Reset'}
              </button>
            </div>
          </div>

          {/* Simulation Outcome KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-1">
              <span className="text-[10px] font-black uppercase text-slate-500">
                {language === 'ar' ? 'المبلغ المستهلك بالمحاكاة' : 'Simulated Allocation'}
              </span>
              <div className="text-xl font-black font-mono text-indigo-900">
                {dryRunSimulation.totalSimulatedSettled.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                <span className="text-xs">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
              </div>
              <div className="text-[10px] text-indigo-600 font-bold">
                {dryRunSimulation.overallCoveragePct.toFixed(1)}% {language === 'ar' ? 'من إجمالي المديونية' : 'of total tax debt'}
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-1">
              <span className="text-[10px] font-black uppercase text-slate-500">
                {language === 'ar' ? 'المتبقي بعد السداد الافتراضي' : 'Projected Residual Debt'}
              </span>
              <div className="text-xl font-black font-mono text-rose-700">
                {dryRunSimulation.projectedRemainingDebt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                <span className="text-xs">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
              </div>
              <div className="text-[10px] text-slate-500">
                {language === 'ar' ? 'ديون ضريبية متبقية' : 'Remaining liability'}
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-1">
              <span className="text-[10px] font-black uppercase text-slate-500">
                {language === 'ar' ? 'أوامر تسوى بالكامل (100%)' : 'Fully Settled Orders'}
              </span>
              <div className="text-xl font-black font-mono text-emerald-700">
                {dryRunSimulation.simulatedFullySettledCount}{' '}
                <span className="text-xs font-bold text-slate-600">{language === 'ar' ? 'طلب' : 'orders'}</span>
              </div>
              <div className="text-[10px] text-emerald-600 font-bold">
                {language === 'ar' ? 'تخليص ضريبي كامل' : '100% Tax Cleared'}
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-1">
              <span className="text-[10px] font-black uppercase text-slate-500">
                {language === 'ar' ? 'فائض السداد غير المخصص' : 'Unallocated Surplus'}
              </span>
              <div className="text-xl font-black font-mono text-purple-700">
                {dryRunSimulation.unallocatedRemittance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                <span className="text-xs">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
              </div>
              <div className="text-[10px] text-purple-600 font-bold">
                {language === 'ar' ? 'رصيد دائن لدى المصلحة' : 'Authority Credit'}
              </div>
            </div>
          </div>

          {/* Simulation Progress Bar */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-bold text-slate-700">
              <span>{language === 'ar' ? 'مؤشر تغطية الديون الضريبية بالمحاكاة:' : 'Simulated Debt Clearance Progress:'}</span>
              <span className="font-mono">{dryRunSimulation.overallCoveragePct.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200">
              <div
                className="bg-gradient-to-r from-indigo-500 to-emerald-500 h-3 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, dryRunSimulation.overallCoveragePct)}%` }}
              ></div>
            </div>
          </div>

          {/* Simulation Detailed Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full text-start text-xs">
              <thead className="bg-slate-900 text-slate-400 text-[10px] font-black uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-start text-white">{language === 'ar' ? 'الطلب والعميل' : 'Order Context'}</th>
                  <th className="px-3 py-3 text-start text-white">{language === 'ar' ? 'التاريخ' : 'Date'}</th>
                  <th className="px-3 py-3 text-end text-white">{language === 'ar' ? 'المديونية الحالية' : 'Current Debt'}</th>
                  <th className="px-3 py-3 text-end text-white">{language === 'ar' ? 'المخصص بالمحاكاة' : 'Simulated Alloc.'}</th>
                  <th className="px-3 py-3 text-end text-white">{language === 'ar' ? 'الرصيد بعد السداد' : 'Projected Balance'}</th>
                  <th className="px-3 py-3 text-center text-white">{language === 'ar' ? 'الحالة المتوقعة' : 'Projected Status'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {dryRunSimulation.simulatedRows.map((row, rIdx) => {
                  const isEven = rIdx % 2 === 1;

                  return (
                    <tr key={row.order.id} className={`${isEven ? 'bg-slate-50/50' : 'bg-white'} hover:bg-amber-50/40 transition-colors`}>
                      <td className="px-4 py-3">
                        <div className="font-mono text-[11px] font-black text-indigo-700 flex items-center gap-2">
                          <span>{row.order.internalOrderNumber}</span>
                          {row.order.customerReferenceNumber && (
                            <span className="text-slate-500 text-[9px] bg-slate-100 px-1 rounded">PO: {row.order.customerReferenceNumber}</span>
                          )}
                        </div>
                        <div className="font-bold text-slate-800 text-xs mt-0.5">{row.order.customerName}</div>
                      </td>
                      <td className="px-3 py-3 text-slate-600 font-bold">
                        {row.orderDate.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}
                      </td>
                      <td className="px-3 py-3 text-end font-mono font-bold text-slate-700">
                        {row.currentDebt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-3 text-end font-mono font-black text-indigo-700">
                        +{row.simAllocated.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-3 text-end font-mono font-bold">
                        <span className={row.projectedBalance === 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          {row.projectedBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-center">
                        {row.projectedStatus === 'sim_settled' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black uppercase">
                            <i className="fa-solid fa-sparkles text-emerald-500"></i>
                            {language === 'ar' ? '✨ يسوى بالكامل' : '✨ Fully Cleared'}
                          </span>
                        )}
                        {row.projectedStatus === 'sim_partial' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 text-[9px] font-black uppercase">
                            <i className="fa-solid fa-clock text-amber-500"></i>
                            {language === 'ar' ? `يسوى جزئياً (${row.coveragePct.toFixed(0)}%)` : `Partial (${row.coveragePct.toFixed(0)}%)`}
                          </span>
                        )}
                        {row.projectedStatus === 'sim_unsettled' && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 text-[9px] font-medium uppercase">
                            {language === 'ar' ? 'يظل معلقاً' : 'Remains Unsettled'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {dryRunSimulation.simulatedRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400 font-bold text-xs uppercase tracking-wider">
                      <i className="fa-solid fa-shield-check text-4xl block mb-2 text-emerald-500 opacity-60"></i>
                      {language === 'ar' ? 'جميع أوامر الشراء مسددة ضريبياً بالكامل! لا توجد ديون ضريبية معلقة.' : 'All customer PO taxes are already 100% settled! No outstanding tax debt.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: GOVERNMENT TAX SETTLEMENTS LEDGER */}
      {activeSubTab === 'gov_ledger' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4 border-b border-slate-100 pb-4">
            <div>
              <h3 className="font-black text-slate-900 text-sm uppercase tracking-wide">
                {language === 'ar' ? 'سجل سدادات مصلحة الضرائب بالدفتر العام' : 'General Ledger Government Tax Settlements'}
              </h3>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                {language === 'ar'
                  ? 'سجل القيود المحاسبية الدائنة المسددة فعلياً لمصلحة الضرائب المصرية والمربوطة تلقائياً بأوامر الشراء وفق مبدأ FIFO'
                  : 'Official tax remittance journal entries recorded in the General Ledger and linked to PO tax clearances via FIFO.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setPayAmount('');
                setShowPaymentModal(true);
              }}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-black uppercase transition-all shadow-sm flex items-center gap-2 cursor-pointer"
            >
              <i className="fa-solid fa-plus-circle text-emerald-400"></i>
              <span>{language === 'ar' ? 'تسجيل سداد جديد' : 'Record New Tax Payment'}</span>
            </button>
          </div>

          {/* Ledger Table */}
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full text-start text-xs">
              <thead className="bg-slate-900 text-slate-400 text-[10px] font-black uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-start text-white">{language === 'ar' ? 'التاريخ ورقم القيد' : 'Date / Entry ID'}</th>
                  <th className="px-3 py-3 text-start text-white">{language === 'ar' ? 'رقم الإيصال / الإقرار' : 'Receipt / Ref #'}</th>
                  <th className="px-3 py-3 text-start text-white">{language === 'ar' ? 'البيان والملاحظات' : 'Description / Memo'}</th>
                  <th className="px-3 py-3 text-start text-white">{language === 'ar' ? 'حساب السداد' : 'From Account'}</th>
                  <th className="px-3 py-3 text-end text-white">{language === 'ar' ? 'المبلغ المسدد' : 'Amount Paid'}</th>
                  <th className="px-3 py-3 text-center text-white">{language === 'ar' ? 'الأوامر المسواة' : 'POs Settled (FIFO)'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {govTaxPayments.map((p, idx) => {
                  const alloc = paymentAllocations.find(a => a.ledgerId === p.id);
                  const settledCount = alloc ? alloc.ordersSettled.length : 0;
                  const remaining = alloc ? alloc.remaining : 0;
                  const isEven = idx % 2 === 1;

                  return (
                    <tr key={p.id} className={`${isEven ? 'bg-slate-50/50' : 'bg-white'} hover:bg-purple-50/40 transition-colors`}>
                      <td className="px-4 py-3.5">
                        <div className="font-bold text-slate-800 text-xs">
                          {new Date(p.date).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}
                        </div>
                        <div className="font-mono text-[9px] text-slate-400 mt-0.5">{p.id}</div>
                      </td>
                      <td className="px-3 py-3.5 font-mono font-bold text-indigo-700">
                        {p.receiptNumber ? (
                          <span className="bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                            #{p.receiptNumber}
                          </span>
                        ) : (
                          <span className="text-slate-400 font-normal italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 text-slate-700 font-medium max-w-xs truncate">
                        {p.description}
                      </td>
                      <td className="px-3 py-3.5">
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold">
                          {p.fromAccount || 'Cash/Bank'}
                        </span>
                      </td>
                      <td className="px-3 py-3.5 text-end font-mono font-black text-purple-950 text-sm">
                        {Number(p.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                        <span className="text-xs font-bold">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
                      </td>
                      <td className="px-3 py-3.5 text-center">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="px-2 py-0.5 rounded-lg bg-purple-100 text-purple-800 text-[10px] font-black">
                            {settledCount} {language === 'ar' ? 'أوامر شراء مسواة' : 'POs Cleared'}
                          </span>
                          {remaining > 0 && (
                            <span className="text-[9px] text-emerald-600 font-bold">
                              {language === 'ar' ? `فائض: ${remaining.toLocaleString()} ج.م` : `Surplus: ${remaining.toLocaleString()} L.E.`}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {govTaxPayments.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-16 text-center text-slate-400 font-bold text-xs uppercase tracking-wider">
                      <i className="fa-solid fa-landmark text-4xl block mb-2 opacity-25"></i>
                      {language === 'ar' ? 'لم يتم تسجيل أي سدادات ضريبية لمصلحة الضرائب بالدفتر العام حتى الآن' : 'No government tax settlement payments recorded in General Ledger yet'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: RECORD TAX SETTLEMENT TO GOVERNMENT */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 text-purple-400 border border-purple-500/30 flex items-center justify-center text-lg">
                  <i className="fa-solid fa-landmark"></i>
                </div>
                <div>
                  <h3 className="font-black text-sm uppercase tracking-wide">
                    {language === 'ar' ? 'تسجيل سداد لمصلحة الضرائب المصرية' : 'Record Tax Remittance to ETA'}
                  </h3>
                  <div className="text-[10px] text-slate-400">
                    {language === 'ar' ? 'قيد محاسبي بدفتر الأستاذ وتسوية أوامر الشراء بنظام FIFO' : 'General Ledger Entry & Automatic FIFO PO Clearance'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPaymentModal(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center transition-all cursor-pointer"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4">
              {paymentModalError && (
                <div className="p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold flex items-center gap-2">
                  <i className="fa-solid fa-triangle-exclamation"></i>
                  <span>{paymentModalError}</span>
                </div>
              )}

              {/* Amount Field */}
              <div>
                <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                  {language === 'ar' ? 'مبلغ السداد الضريبي (ج.م) *' : 'Tax Payment Amount (L.E.) *'}
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={payAmount}
                  onChange={e => setPayAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-4 py-2.5 bg-slate-50 border-2 border-slate-200 rounded-2xl text-lg font-black font-mono text-slate-900 outline-none focus:border-indigo-500"
                />
              </div>

              {/* Payment Date & Reference */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                    {language === 'ar' ? 'تاريخ السداد *' : 'Payment Date *'}
                  </label>
                  <input
                    type="date"
                    value={payDate}
                    onChange={e => setPayDate(e.target.value)}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                    {language === 'ar' ? 'رقم إيصال السداد / المرجع' : 'Filing / Receipt Reference #'}
                  </label>
                  <input
                    type="text"
                    value={payReceiptNo}
                    onChange={e => setPayReceiptNo(e.target.value)}
                    placeholder={language === 'ar' ? 'مثال: ETA-2026-0391' : 'e.g. ETA-2026-0391'}
                    className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              {/* Payment Account */}
              <div>
                <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                  {language === 'ar' ? 'حساب السداد البنكي / الخزينة' : 'From Bank Account / Source'}
                </label>
                <select
                  value={payFromAccount}
                  onChange={e => setPayFromAccount(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-800 outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value="Cash/Bank">{language === 'ar' ? 'النقدية بالبنك (Cash/Bank)' : 'Cash / Bank Account'}</option>
                  <option value="CIB Bank Account">{language === 'ar' ? 'البنك التجاري الدولي (CIB)' : 'CIB Bank Account'}</option>
                  <option value="NBE Bank Account">{language === 'ar' ? 'البنك الأهلي المصري (NBE)' : 'NBE Bank Account'}</option>
                  <option value="Company Treasury">{language === 'ar' ? 'خزينة الشركة الرئيسية' : 'Company Treasury'}</option>
                </select>
              </div>

              {/* Memo / Description */}
              <div>
                <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                  {language === 'ar' ? 'البيان والملاحظات' : 'Filing Description / Memo'}
                </label>
                <input
                  type="text"
                  value={payMemo}
                  onChange={e => setPayMemo(e.target.value)}
                  placeholder={language === 'ar' ? 'سداد إقرار القيمة المضافة / تسوية الضرائب المستحقة' : 'Monthly VAT Declaration Settlement'}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-2xl text-xs font-bold text-slate-900 outline-none focus:border-indigo-500"
                />
              </div>

              {/* Optional Receipt Upload */}
              <div>
                <label className="block text-xs font-black uppercase text-slate-700 mb-1">
                  {language === 'ar' ? 'إرفاق إيصال السداد الرسمي (اختياري)' : 'Attach Official Tax Receipt (Optional)'}
                </label>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={e => setPayReceiptFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-black file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowPaymentModal(false)}
                disabled={isSubmittingPayment}
                className="px-5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-600 text-xs font-black uppercase transition-all cursor-pointer"
              >
                {language === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleSubmitTaxPayment}
                disabled={isSubmittingPayment}
                className="px-6 py-2.5 rounded-xl bg-slate-900 hover:bg-black text-white text-xs font-black uppercase transition-all shadow-md flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isSubmittingPayment ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i>
                    <span>{language === 'ar' ? 'جاري التسجيل...' : 'Recording...'}</span>
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-check"></i>
                    <span>{language === 'ar' ? 'تأكيد وقيد بالدفتر' : 'Confirm & Post to Ledger'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
