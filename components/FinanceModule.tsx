import React, { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { dataService } from '../services/dataService';
import { CustomerOrder, Customer, Supplier, OrderStatus, AppConfig, User, getItemEffectiveStatus, CustomerOrderItem, ManufacturingComponent, CostSheetRecord } from '../types';
import { getItemEffectiveQty, getOrderConversionRate, getOrderCurrency, getStatusLimitHours, getTechReviewStartTime, getOrderPoType, getPoTypeConfig } from '../utils';
import { isMarginBreach } from '../shared/margin';
import { STATUS_CONFIG, getDynamicOrderStatusStyle } from '../constants';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { useLanguage, LanguageProvider } from '../contexts/LanguageContext';
import { LanguageToggle } from './LanguageToggle';
import { SortableTable, ColumnDef } from './SortableTable';
import { extractCostSheetMetrics, extractCostSheetProjectMetrics } from './ProcurementModule';
import { TaxClearancesView } from './TaxClearancesView';

// Converts SVG data URL to PNG data URL for html2canvas compatibility
const rasterizeLogo = (logoDataUrl: string): Promise<string> => {
  return new Promise((resolve) => {
    if (!logoDataUrl || !logoDataUrl.startsWith('data:image/svg')) {
      resolve(logoDataUrl);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous'; 
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const targetWidth = 1000;
      const ratio = (img.naturalHeight / img.naturalWidth) || 0.5;
      canvas.width = targetWidth;
      canvas.height = targetWidth * ratio;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } else {
        resolve(logoDataUrl);
      }
    };
    img.onerror = () => resolve(logoDataUrl);
    img.src = logoDataUrl;
  });
};

interface FinanceModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

type FinanceTab = 'orders' | 'stock_orders' | 'history' | 'blacklist_hold' | 'tax_clearances' | 'supplier_reporting' | 'ledger' | 'contracts' | 'customer_wallets' | 'project_wallets' | 'blanket_history';

const getStatusLimit = (order: CustomerOrder, settings: any) => {
  if (order.status === OrderStatus.DELIVERED) {
    return (order.paymentSlaDays || settings.defaultPaymentSlaDays) * 24;
  }
  return getStatusLimitHours(order.status, settings);
};

const ThresholdSentinel: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = getStatusLimit(order, config.settings);
      if (limitHrs === 0) return;
      const lastLog = [...order.logs].reverse().find(l => l.status === order.status);
      const startTime = order.status === OrderStatus.TECHNICAL_REVIEW
        ? getTechReviewStartTime(order)
        : (lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime());
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

interface OrdersKPICardProps {
  title: string;
  balloonTitle: string;
  icon: string;
  iconColor: string;
  bgBorderColor?: string;
  textColor: string;
  value: string;
  subtext: string;
  badge?: string;
  badgeClass?: string;
  description: string;
  formula?: string;
  alignBalloon?: 'left' | 'right' | 'center';
}

const OrdersKPICard: React.FC<OrdersKPICardProps> = ({
  title,
  balloonTitle,
  icon,
  iconColor,
  bgBorderColor = "bg-white border-slate-200",
  textColor,
  value,
  subtext,
  badge,
  badgeClass = "bg-slate-100 text-slate-600",
  description,
  formula,
  alignBalloon = 'center'
}) => {
  const getBalloonAlignment = () => {
    if (alignBalloon === 'left') {
      return {
        pos: 'left-0 sm:-left-2',
        arrow: 'left-4'
      };
    }
    if (alignBalloon === 'right') {
      return {
        pos: 'right-0 sm:-right-2',
        arrow: 'right-4'
      };
    }
    return {
      pos: 'left-1/2 -translate-x-1/2',
      arrow: 'left-1/2 -translate-x-1/2'
    };
  };

  const { pos: balloonPos, arrow: arrowPos } = getBalloonAlignment();

  return (
    <div className={`p-3 sm:p-3.5 rounded-2xl border shadow-xs transition-all relative overflow-visible hover:z-[70] ${bgBorderColor}`}>
      <div className="flex items-start justify-between gap-1.5 mb-1.5 min-h-[28px]">
        <div className="flex items-start gap-1.5 min-w-0 flex-1">
          <i className={`${icon} ${iconColor} text-[10px] mt-0.5 shrink-0`}></i>
          <span 
            className="text-[8.5px] sm:text-[9px] font-bold text-slate-700 leading-tight tracking-tight break-words line-clamp-2"
            title={title}
          >
            {title}
          </span>
        </div>
        {/* Help Balloon Tooltip */}
        <div className="relative group/help inline-flex shrink-0 mt-0.5">
          <span
            className="text-slate-400 hover:text-blue-600 transition-colors p-0.5 focus:outline-none cursor-help"
            title={description}
          >
            <i className="fa-solid fa-circle-question text-[10px]"></i>
          </span>
          <div className={`absolute bottom-full ${balloonPos} mb-2.5 hidden group-hover/help:block w-72 p-3 bg-slate-900/95 backdrop-blur-md text-white text-[11px] font-medium leading-relaxed rounded-2xl shadow-2xl z-[100] pointer-events-none border border-slate-700/80 normal-case text-start`}>
            <div className="font-bold text-white text-[10px] uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <i className="fa-solid fa-circle-info text-blue-400"></i>
              <span>{balloonTitle}</span>
            </div>
            <div className="text-slate-200 text-[10.5px] leading-snug">
              {description}
            </div>
            {formula && (
              <div className="text-[9px] font-mono text-blue-300 mt-2 pt-2 border-t border-slate-800">
                {formula}
              </div>
            )}
            <div className={`absolute top-full ${arrowPos} border-4 border-transparent border-t-slate-900/95`}></div>
          </div>
        </div>
      </div>

      <div className={`text-base sm:text-lg font-black font-mono tracking-tight ${textColor} truncate`} title={value}>
        {value}
      </div>

      <div className="text-[8px] font-bold text-slate-400 mt-1 uppercase truncate flex items-center justify-between gap-1">
        <span className="truncate" title={subtext}>{subtext}</span>
        {badge && (
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-black shrink-0 ${badgeClass}`}>
            {badge}
          </span>
        )}
      </div>
    </div>
  );
};

interface GeneralLedgerViewProps {
  entries: any[];
  orders: CustomerOrder[];
  customers?: Customer[];
  suppliers?: Supplier[];
  supplierPayments: any[];
  onRefresh: () => void;
  currentUser: User;
  searchQuery: string;
  ledgerAccounts?: string[];
  config: AppConfig;
}

const GeneralLedgerView: React.FC<GeneralLedgerViewProps> = ({ entries, orders, customers = [], suppliers = [], supplierPayments, onRefresh, currentUser, searchQuery, ledgerAccounts = [], config }) => {
  const { t, language } = useLanguage();
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [type, setType] = useState<'COST' | 'ADDITION'>('COST');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Compute Company Enterprise Balance Sheet & Double-Entry Financial Position
  const companyFinancials = useMemo(() => {
    let customerCashIn = 0;
    let totalAR = 0;
    let totalWIP = 0;
    let totalRealizedProfit = 0;
    let totalProjectedProfit = 0;
    let totalOutputTax = 0;
    let totalInputTax = 0;

    orders.forEach(o => {
      if (o.status === OrderStatus.REJECTED) return;
      if (o.customerName === 'Internal Stock' || (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-'))) return;

      const rate = getOrderConversionRate(o);
      const paid = (o.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
      customerCashIn += paid;

      let netRevenue = 0;
      let orderOutputTax = 0;
      let netCost = 0;
      let orderInputTax = 0;

      (o.items || []).forEach(it => {
        const lineNet = getItemEffectiveQty(it) * (it.pricePerUnit || 0);
        netRevenue += lineNet;
        const itTax = it.taxPercent !== undefined ? it.taxPercent : 14;
        orderOutputTax += lineNet * (itTax / 100);

        (it.components || []).forEach(c => {
          const cNet = (c.quantity || 0) * (c.unitCost || 0);
          netCost += cNet;
          const cTax = c.taxPercent !== undefined ? c.taxPercent : 0;
          orderInputTax += cNet * (cTax / 100);
        });
      });

      const costInOrderCurrency = netCost * rate;
      const grossRevenue = o.appliesWithholdingTax ? (netRevenue + orderOutputTax) * 0.99 : (netRevenue + orderOutputTax);
      const isInvoiced = [
        OrderStatus.INVOICED,
        OrderStatus.HUB_RELEASED,
        OrderStatus.DELIVERED,
        OrderStatus.WAITING_GOVE,
        OrderStatus.FULFILLED
      ].includes(o.status) || Boolean(o.invoiceNumber);

      const projProfit = netRevenue - costInOrderCurrency;
      totalProjectedProfit += projProfit;
      totalInputTax += orderInputTax * rate;

      if (isInvoiced) {
        totalRealizedProfit += projProfit;
        totalAR += Math.max(0, grossRevenue - paid);
        totalOutputTax += orderOutputTax;
      } else {
        totalWIP += costInOrderCurrency;
      }
    });

    const supplierCashOut = (supplierPayments || []).reduce((s, p) => s + (p.amount || 0), 0);

    const manualAdditions = entries.filter(e => e.type === 'ADDITION' && !e.id?.startsWith('adv_cust_')).reduce((s, e) => s + (e.amount || 0), 0);
    const manualCosts = entries.filter(e => e.type === 'COST' && !e.id?.startsWith('sp_ledg_') && e.category !== 'Supplier Payment').reduce((s, e) => s + (e.amount || 0), 0);

    const netCashInBank = (customerCashIn + manualAdditions) - (supplierCashOut + manualCosts);

    // Total Supplier Committed Gross Cost across all orders
    let totalSupplierCommitted = 0;
    orders.forEach(o => {
      if (o.status === OrderStatus.REJECTED) return;
      const rate = getOrderConversionRate(o);
      (o.items || []).forEach(it => {
        (it.components || []).forEach(c => {
          const cNet = (c.quantity || 0) * (c.unitCost || 0);
          const cTax = c.taxPercent !== undefined ? c.taxPercent : 0;
          totalSupplierCommitted += (cNet + (cNet * (cTax / 100))) * rate;
        });
      });
    });

    const totalSupplierAP = Math.max(0, totalSupplierCommitted - supplierCashOut);

    // Customer Wallets (Prepaid liabilities / unearned revenue)
    let totalCustomerWallets = 0;
    (customers || []).forEach(c => {
      if (c.name.trim().toLowerCase() === 'internal stock') return;
      const bal = Number(c.walletBalance || 0);
      if (bal > 0) totalCustomerWallets += bal;
    });

    orders.forEach(o => {
      if (o.status === OrderStatus.REJECTED || o.customerName === 'Internal Stock') return;
      const paid = (o.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
      const isInvoiced = [
        OrderStatus.INVOICED,
        OrderStatus.HUB_RELEASED,
        OrderStatus.DELIVERED,
        OrderStatus.WAITING_GOVE,
        OrderStatus.FULFILLED
      ].includes(o.status) || Boolean(o.invoiceNumber);

      if (!isInvoiced && paid > 0) {
        totalCustomerWallets += paid;
      }
    });

    const govTaxPaid = entries
      .filter(e => e.type === 'COST' && (
        e.category === 'Tax Settlement' ||
        e.category === 'Tax Payment' ||
        e.toAccount?.toLowerCase().includes('tax') ||
        e.toAccount?.includes('ضرائب')
      ))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const netTaxLiability = (totalOutputTax - totalInputTax) - govTaxPaid;

    const totalAssets = netCashInBank + totalAR + totalWIP;
    const totalLiabilitiesAndProfit = totalSupplierAP + totalCustomerWallets + netTaxLiability + totalRealizedProfit;
    const variance = Math.abs(totalAssets - totalLiabilitiesAndProfit);
    const isBalanced = variance < 5.0;

    return {
      customerCashIn,
      supplierCashOut,
      manualAdditions,
      manualCosts,
      netCashInBank,
      totalAR,
      totalWIP,
      totalAssets,
      totalSupplierCommitted,
      totalSupplierAP,
      totalCustomerWallets,
      totalOutputTax,
      totalInputTax,
      netTaxLiability,
      totalRealizedProfit,
      totalProjectedProfit,
      totalLiabilitiesAndProfit,
      variance,
      isBalanced
    };
  }, [orders, supplierPayments, entries, customers]);

  const unifiedEntries = useMemo(() => {
    const all: any[] = [];

    // Helper function to get account groups (returns all groups for an account)
    const getAccountGroup = (accountName: string, config: any) => {
      const groups = config.settings?.ledgerAccountGroups || {};
      const accountGroups = [];
      for (const [groupName, accounts] of Object.entries(groups)) {
        if (accounts.includes(accountName)) {
          accountGroups.push(groupName);
        }
      }
      return accountGroups.length > 0 ? accountGroups : null;
    };

    // 1. Manual entries
    entries.forEach(e => {
      if (e.id?.startsWith('sp_ledg_') || e.category === 'Supplier Payment') return;
      const fromGroup = getAccountGroup(e.fromAccount || e.category, config);
      const toGroup = getAccountGroup(e.toAccount, config);
      all.push({
        ...e,
        source: 'Manual',
        fromGroup,
        toGroup
      });
    });

    // 2. Customer payments (these don't have from/to accounts, so they stay as-is)
    orders.forEach(o => {
      (o.payments || []).forEach((p, idx) => {
        all.push({
          id: `cust_${o.id}_${idx}`,
          date: p.date,
          type: 'ADDITION',
          amount: p.amount,
          description: `Payment: ${o.customerName}`,
          category: o.internalOrderNumber,
          user: p.user || 'System',
          source: 'Customer',
          fromGroup: null,
          toGroup: null
        });
      });
    });

    // 3. Supplier payments (these don't have from/to accounts, so they stay as-is)
    supplierPayments.forEach(sp => {
      all.push({
        id: `supp_${sp.id}`,
        date: sp.date,
        type: 'COST',
        amount: sp.amount,
        description: `Paid: ${sp.supplierName}`,
        category: sp.memo || 'Supplier Payment',
        user: sp.user || 'System',
        source: 'Supplier',
        fromGroup: null,
        toGroup: null
      });
    });

    return all;
  }, [entries, orders, supplierPayments, config]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return unifiedEntries;
    return unifiedEntries.filter(e => {
      // Create a comprehensive searchable string with all displayed data
      const searchableText = [
        e.description || '',
        e.category || '',
        e.fromAccount || '',
        e.toAccount || '',
        e.fromGroup || '',
        e.toGroup || '',
        e.amount?.toString() || '',
        e.type || '',
        e.user || '',
        e.source || '',
        new Date(e.date).toLocaleDateString(),
        e.receiptNumber || ''
      ].join(' ').toLowerCase();

      return searchableText.includes(q);
    });
  }, [unifiedEntries, searchQuery]);

  const totals = useMemo(() => {
    return filteredEntries.reduce((acc, curr) => {
      if (curr.type === 'ADDITION') acc.additions += curr.amount;
      else acc.costs += curr.amount;
      return acc;
    }, { additions: 0, costs: 0 });
  }, [filteredEntries]);

  const handleAddEntry = async () => {
    if (!amount || !description || !fromAccount || !toAccount) { setError('Amount, description, from account, and to account are mandatory'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid positive amount'); return; }

    setLoading(true);
    setError(null);
    try {
      await dataService.addLedgerEntry({
        date: new Date().toISOString(),
        type,
        amount: amt,
        description,
        fromAccount,
        toAccount,
        user: currentUser.username
      });
      setShowAddModal(false);
      setAmount('');
      setDescription('');
      setFromAccount('');
      setToAccount('');
      onRefresh();
    } catch (e: any) {
      setError(e.message || 'Failed to add entry');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Enterprise Financial Position & Double-Entry Accounting Verification */}
      <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 text-white rounded-[2.5rem] p-8 border border-slate-800 shadow-2xl space-y-6">
        {/* Verification Banner */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b border-white/10 pb-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center text-xl shrink-0">
              <i className="fa-solid fa-scale-balanced"></i>
            </div>
            <div>
              <div className="text-xs font-black uppercase tracking-widest text-blue-400">
                {language === 'ar' ? 'الميزانية العمومية للشركة وموقف القيد المزدوج' : 'Company Balance Sheet & Double-Entry Position'}
              </div>
              <div className="text-sm font-bold text-slate-300">
                {language === 'ar' ? (
                  <>معادلة المحاسبة الأساسية: <span className="font-mono text-white">الأصول = الخصوم + حقوق الملكية والأرباح</span></>
                ) : (
                  <>Fundamental Accounting Equation: <span className="font-mono text-white">Assets = Liabilities + Equity & Profit</span></>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {companyFinancials.isBalanced ? (
              <div className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-black uppercase tracking-wider shadow-lg shadow-emerald-950/40">
                <i className="fa-solid fa-shield-check text-base"></i>
                <span>
                  {language === 'ar'
                    ? `المعادلة متوازنة (${companyFinancials.totalAssets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م)`
                    : `Equation Balanced (${companyFinancials.totalAssets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.)`}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-black uppercase tracking-wider">
                <i className="fa-solid fa-triangle-exclamation text-base"></i>
                <span>
                  {language === 'ar'
                    ? `فارق: ${companyFinancials.variance.toFixed(2)} ج.م`
                    : `Variance: ${companyFinancials.variance.toFixed(2)} L.E.`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Dual Balanced Columns: Assets vs Liabilities & Profit */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ASSETS (DEBITS) */}
          <div className="bg-white/5 border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-emerald-400">
                <i className="fa-solid fa-vault"></i>
                <span>{language === 'ar' ? 'أصول الشركة (مدين)' : 'Company Assets (Debit)'}</span>
              </div>
              <div className="text-xl font-black text-emerald-300 font-mono">
                {companyFinancials.totalAssets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-building-columns"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'النقد في البنك / أموال سائلة' : 'Cash in Bank / Liquid Funds'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? `مقبوضات العملاء (${companyFinancials.customerCashIn.toLocaleString()}) - مدفوعات الموردين (${companyFinancials.supplierCashOut.toLocaleString()}) + صافي التسويات اليدوية (${(companyFinancials.manualAdditions - companyFinancials.manualCosts).toLocaleString()})`
                        : `Customer In (${companyFinancials.customerCashIn.toLocaleString()}) - Supplier Out (${companyFinancials.supplierCashOut.toLocaleString()}) + Net Manual ({(companyFinancials.manualAdditions - companyFinancials.manualCosts).toLocaleString()})`}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-emerald-300">
                  {companyFinancials.netCashInBank.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>

              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-file-invoice"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'حسابات العملاء المدينة (AR)' : 'Customer Accounts Receivable (AR)'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? 'ديون مستحقة غير محصلة على جميع فواتير العملاء الصادرة رسمياً'
                        : 'Uncollected debt on all officially issued customer invoices'}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-sky-300">
                  {companyFinancials.totalAR.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>

              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-dolly"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'مخزون قيد التشغيل (WIP)' : 'Work In Progress (WIP Inventory)'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? 'تكاليف التوريد المتكبدة للطلبات قيد التنفيذ قبل إصدار الفاتورة'
                        : 'Sourced costs incurred for orders currently in progress before invoicing'}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-amber-300">
                  {companyFinancials.totalWIP.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>
            </div>
          </div>

          {/* LIABILITIES + PROFIT (CREDITS) */}
          <div className="bg-white/5 border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-white/10 pb-3">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-rose-400">
                <i className="fa-solid fa-hand-holding-dollar"></i>
                <span>{language === 'ar' ? 'الخصوم وحقوق الملكية / الأرباح (دائن)' : 'Liabilities & Equity / Profit (Credit)'}</span>
              </div>
              <div className="text-xl font-black text-rose-300 font-mono">
                {companyFinancials.totalLiabilitiesAndProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span className="text-xs">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-truck-ramp-box"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'حسابات الموردين الدائنة (AP)' : 'Supplier Accounts Payable (AP)'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? 'إجمالي المستحق للموردين عن أوامر الشراء المعمدة/المستلمة عبر كافة الطلبات'
                        : 'Total owed to suppliers for awarded/received POs across all orders'}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-rose-300">
                  {companyFinancials.totalSupplierAP.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>

              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-teal-500/20 text-teal-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-wallet"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'محافظ ودفعات العملاء المقدمة' : 'Customer Wallets & Advances'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? 'دفعات نقدية مقدمة محتجزة قبل الفوترة أو للطلبات المستقبلية'
                        : 'Unearned customer advance prepayments held before invoicing or for future orders'}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-teal-300">
                  {companyFinancials.totalCustomerWallets.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>

              <div className="flex justify-between items-center p-3 rounded-2xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-landmark"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'صافي التزام ضريبة القيمة المضافة (14%)' : 'Net Tax Liability (VAT 14%)'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? `ضريبة المخرجات على فواتير العملاء (${companyFinancials.totalOutputTax.toLocaleString()}) - ضريبة المدخلات المخصومة (${companyFinancials.totalInputTax.toLocaleString()})`
                        : `Output VAT billed to customers (${companyFinancials.totalOutputTax.toLocaleString()}) - Deductible Input VAT (${companyFinancials.totalInputTax.toLocaleString()})`}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-indigo-300">
                  {companyFinancials.netTaxLiability.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>

              <div className="flex justify-between items-center p-3 rounded-2xl bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-violet-500/20 text-violet-400 flex items-center justify-center text-xs">
                    <i className="fa-solid fa-chart-line"></i>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">
                      {language === 'ar' ? 'أرباح الشركة المحققة' : 'Company Realized Profit'}
                    </div>
                    <div className="text-[9px] text-slate-400">
                      {language === 'ar'
                        ? `صافي الأرباح المعترف بها على الطلبات المفوترة (المتوقع في المسار: ${companyFinancials.totalProjectedProfit.toLocaleString()} ج.م)`
                        : `Net profit recognized on all invoiced orders (Pipeline Projected: ${companyFinancials.totalProjectedProfit.toLocaleString()} L.E.)`}
                    </div>
                  </div>
                </div>
                <div className="text-end font-mono font-black text-sm text-violet-300">
                  +{companyFinancials.totalRealizedProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-emerald-50 border border-emerald-100 p-6 rounded-[2rem] shadow-sm">
          <div className="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-2 flex items-center gap-2">
            <i className="fa-solid fa-plus-circle"></i> {t('finance.ledger.totalAdditions')}
          </div>
          <div className="text-3xl font-black text-emerald-800 tracking-tight">
            {totals.additions.toLocaleString()} <span className="text-sm">L.E.</span>
          </div>
        </div>
        <div className="bg-rose-50 border border-rose-100 p-6 rounded-[2rem] shadow-sm">
          <div className="text-[10px] font-black uppercase tracking-widest text-rose-600 mb-2 flex items-center gap-2">
            <i className="fa-solid fa-minus-circle"></i> {t('finance.ledger.totalCosts')}
          </div>
          <div className="text-3xl font-black text-rose-800 tracking-tight">
            {totals.costs.toLocaleString()} <span className="text-sm">L.E.</span>
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-100 p-6 rounded-[2rem] shadow-sm">
          <div className="text-[10px] font-black uppercase tracking-widest text-blue-600 mb-2 flex items-center gap-2">
            <i className="fa-solid fa-scale-balanced"></i> {t('finance.ledger.netBalance')}
          </div>
          <div className="text-3xl font-black text-blue-800 tracking-tight">
            {(totals.additions - totals.costs).toLocaleString()} <span className="text-sm">{language === 'ar' ? 'ج.م' : 'L.E.'}</span>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
          <i className="fa-solid fa-book text-slate-400"></i> {t("finance.ledger.title")}
        </h3>
        <button 
          onClick={() => setShowAddModal(true)}
          className="px-6 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all shadow-lg flex items-center gap-2"
        >
          <i className="fa-solid fa-plus"></i> {t("finance.ledger.addEntry")}
        </button>
      </div>

      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
          <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
            <tr>
              <th className="px-8 py-5">{t('finance.ledger.date')}</th>
              <th className="px-8 py-5">{t('finance.ledger.description')}</th>
              <th className="px-8 py-5">{t('finance.ledger.fromAccount')}</th>
              <th className="px-8 py-5">{t('finance.ledger.toAccount')}</th>
              <th className="px-8 py-5">{t('finance.ledger.source')}</th>
              <th className="px-8 py-5">{t('finance.ledger.type')}</th>
              <th className="px-8 py-5 text-end">{t('finance.ledger.amount')}</th>
              <th className="px-8 py-5">{t('finance.ledger.user')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredEntries.map(entry => (
              <tr key={entry.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="px-8 py-5 text-xs font-bold text-slate-500">
                  {new Date(entry.date).toLocaleDateString()}
                </td>
                <td className="px-8 py-5">
                  <div className="font-black text-slate-800 text-sm">{entry.description}</div>
                </td>
                <td className="px-8 py-5">
                  <div className="text-xs font-bold text-blue-600 uppercase">
                    {entry.fromAccount || entry.category || '-'}
                    {entry.fromGroup && Array.isArray(entry.fromGroup) && (
                      <div className="text-[9px] text-blue-500 font-medium mt-0.5">
                        {entry.fromGroup.slice(0, 2).join(', ')}
                        {entry.fromGroup.length > 2 && '...'}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-8 py-5">
                  <div className="text-xs font-bold text-emerald-600 uppercase">
                    {entry.toAccount || '-'}
                    {entry.toGroup && Array.isArray(entry.toGroup) && (
                      <div className="text-[9px] text-emerald-500 font-medium mt-0.5">
                        {entry.toGroup.slice(0, 2).join(', ')}
                        {entry.toGroup.length > 2 && '...'}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-8 py-5">
                  <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${
                    entry.source === 'Manual' ? 'bg-blue-50 text-blue-600 border-blue-100' :
                    entry.source === 'Customer' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                    'bg-rose-50 text-rose-600 border-rose-100'
                  }`}>
                    {entry.source === 'Manual' ? (language === 'ar' ? 'يدوي' : 'Manual') :
                     entry.source === 'Customer' ? (language === 'ar' ? 'عميل' : 'Customer') :
                     entry.source === 'Supplier' ? (language === 'ar' ? 'مورد' : 'Supplier') : entry.source}
                  </span>
                </td>
                <td className="px-8 py-5">
                  <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${
                    entry.type === 'ADDITION' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                    'bg-rose-50 text-rose-600 border-rose-100'
                  }`}>
                    {entry.type === 'ADDITION' ? (language === 'ar' ? 'إضافة' : 'ADDITION') : (language === 'ar' ? 'تكلفة' : 'COST')}
                  </span>
                </td>
                <td className="px-8 py-5 text-end font-black text-slate-800 text-sm">
                  {entry.amount.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </td>
                <td className="px-8 py-5 text-xs font-bold text-slate-500">
                  {entry.user}
                </td>
              </tr>
            ))}
            {filteredEntries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-8 py-20 text-center text-slate-300 italic font-black uppercase tracking-widest text-xs">
                  {t("finance.ledger.noRecords")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 border border-slate-100">
            <div className="flex items-center gap-6 mb-8">
              <div className="w-16 h-16 rounded-3xl bg-blue-50 text-blue-600 flex items-center justify-center text-3xl shadow-inner">
                <i className="fa-solid fa-file-invoice-dollar"></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">{t('finance.ledger.addEntry')}</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{language === 'ar' ? 'تسجيل حركة محاسبية جديدة' : t('messages.loading')}</p>
              </div>
            </div>

            {error && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3"><i className="fa-solid fa-circle-exclamation"></i>{error}</div>}

            <div className="space-y-6">
              <div className="flex gap-4">
                <button 
                  onClick={() => setType('COST')}
                  className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 ${
                    type === 'COST' ? 'bg-rose-50 border-rose-500 text-rose-700' : 'bg-slate-50 border-slate-100 text-slate-400'
                  }`}
                >
                  <i className="fa-solid fa-minus-circle mr-2"></i> {t("finance.ledger.costExpense")}
                </button>
                <button 
                  onClick={() => setType('ADDITION')}
                  className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 ${
                    type === 'ADDITION' ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'bg-slate-50 border-slate-100 text-slate-400'
                  }`}
                >
                  <i className="fa-solid fa-plus-circle mr-2"></i> {t("finance.ledger.additionIncome")}
                </button>
              </div>

              <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{t('common.amount')} ({language === 'ar' ? 'ج.م' : 'L.E.'})</label>
                <input 
                  type="number" step="0.01" autoFocus
                  className="w-full p-4 border rounded-2xl bg-slate-50 font-black text-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                  value={amount} onChange={e => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{t('common.description')}</label>
                <input 
                  type="text"
                  className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                  value={description} onChange={e => setDescription(e.target.value)}
                  placeholder={t("finance.ledger.whatIsThisFor")}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{t("finance.ledger.fromAccountLabel")}</label>
                  <select
                    className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                    value={fromAccount} onChange={e => setFromAccount(e.target.value)}
                  >
                    <option value="">{t("finance.ledger.selectAccount")}</option>
                    {/* Grouped accounts - accounts can appear in multiple groups */}
                    {ledgerAccounts.map(account => {
                      const accountGroups = (() => {
                        const groups = [];
                        for (const [gName, accounts] of Object.entries(config.settings.ledgerAccountGroups || {})) {
                          if (accounts.includes(account)) groups.push(gName);
                        }
                        return groups.length > 0 ? groups : [language === 'ar' ? 'غير مصنف' : 'Ungrouped'];
                      })();

                      return (
                        <option key={account} value={account}>
                          {account} ({accountGroups.slice(0, 2).join(', ')}{accountGroups.length > 2 ? '...' : ''})
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{t("finance.ledger.toAccountLabel")}</label>
                  <select
                    className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                    value={toAccount} onChange={e => setToAccount(e.target.value)}
                  >
                    <option value="">{t("finance.ledger.selectAccount")}</option>
                    {/* Grouped accounts - accounts can appear in multiple groups */}
                    {ledgerAccounts.map(account => {
                      const accountGroups = (() => {
                        const groups = [];
                        for (const [gName, accounts] of Object.entries(config.settings.ledgerAccountGroups || {})) {
                          if (accounts.includes(account)) groups.push(gName);
                        }
                        return groups.length > 0 ? groups : [language === 'ar' ? 'غير مصنف' : 'Ungrouped'];
                      })();

                      return (
                        <option key={account} value={account}>
                          {account} ({accountGroups.slice(0, 2).join(', ')}{accountGroups.length > 2 ? '...' : ''})
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>
            </div>

            <div className="mt-10 flex gap-3">
              <button 
                onClick={() => setShowAddModal(false)} 
                className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200"
              >
                {t('common.cancel')}
              </button>
              <button 
                onClick={handleAddEntry} 
                disabled={loading}
                className="flex-[2] py-4 bg-slate-900 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 hover:bg-black transition-all"
              >
                {loading ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check"></i>}
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FinanceModuleInner: React.FC<FinanceModuleProps> = ({ config, refreshKey, currentUser }) => {
  const { t, language } = useLanguage();
  const [activeTab, setActiveTab] = useState<FinanceTab>('orders');
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<any[]>([]);
  const [contracts, setContracts] = useState<any[]>([]);
  const [contractSearch, setContractSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [blanketHistorySearch, setBlanketHistorySearch] = useState('');
  const [customerWalletSearch, setCustomerWalletSearch] = useState('');
  const [projectWalletSearch, setProjectWalletSearch] = useState('');
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'orderDate', direction: 'desc' });
  const [columnOrder, setColumnOrder] = useState<string[]>(['context', 'date', 'currency', 'revenue', 'markup', 'status', 'actions']);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [rasterizedLogo, setRasterizedLogo] = useState<string>('');

  // Pre-rasterize SVG logo to PNG for html2canvas compatibility
  useEffect(() => {
    if (config.settings.companyLogo) {
      rasterizeLogo(config.settings.companyLogo).then(setRasterizedLogo);
    }
  }, [config.settings.companyLogo]);

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
  const [expandedOrderIds, setExpandedOrderIds] = useState<Record<string, boolean>>({});
  const [expandedProjectHistoryIds, setExpandedProjectHistoryIds] = useState<Set<string>>(new Set());
  const [costSheetModalData, setCostSheetModalData] = useState<{ fileName: string; fileData: string; orderTitle: string } | null>(null);
  const [costSheetActiveSheetIndex, setCostSheetActiveSheetIndex] = useState<number>(0);

  const toggleOrderExpand = (orderId: string) => {
    setExpandedOrderIds(prev => ({
      ...prev,
      [orderId]: !prev[orderId]
    }));
  };

  const toggleProjectHistory = (groupId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedProjectHistoryIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleToggleExpandAll = () => {
    const allExpanded = filteredOrders.length > 0 && filteredOrders.every(o => expandedOrderIds[o.id]);
    if (allExpanded) {
      setExpandedOrderIds({});
    } else {
      const next: Record<string, boolean> = {};
      filteredOrders.forEach(o => { next[o.id] = true; });
      groupedFinanceOrderItems.forEach(item => {
        if (item.type === 'blanket_project_group') {
          next[item.groupId] = true;
        }
      });
      setExpandedOrderIds(next);
    }
  };

  // Supplier Payments state
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>(['all']);
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);
  const [supplierLedger, setSupplierLedger] = useState<any>(null);
  const [spAmount, setSpAmount] = useState('');
  const [spMemo, setSpMemo] = useState('');
  const [spDate, setSpDate] = useState(new Date().toISOString().split('T')[0]);
  const [spLoading, setSpLoading] = useState(false);
  const [spError, setSpError] = useState<string | null>(null);
  const [expandedPaymentId, setExpandedPaymentId] = useState<string | null>(null);

  const generatePaymentRef = () => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `PAY-${dateStr}-${rand}`;
  };

  // Customer Accounts & Advance Prepayment State
  const [useCustomerWallet, setUseCustomerWallet] = useState(false);
  const [customerViewMode, setCustomerViewMode] = useState<'all_accounts' | 'blanket_settlements'>('all_accounts');
  const [customerAccountSearch, setCustomerAccountSearch] = useState('');
  const [advanceModalCustomer, setAdvanceModalCustomer] = useState<{ id: string; name: string; walletBalance?: number; walletBalances?: Record<string, number> } | null>(null);
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceMemo, setAdvanceMemo] = useState('');
  const [advanceDate, setAdvanceDate] = useState(new Date().toISOString().split('T')[0]);
  const [advanceProject, setAdvanceProject] = useState('');
  const [advanceLoading, setAdvanceLoading] = useState(false);
  const [expandedCustomerIds, setExpandedCustomerIds] = useState<Record<string, boolean>>({});
  const [supplierSearchQuery, setSupplierSearchQuery] = useState('');

  // Supplier PO Orders Master View & Payment Modal State
  const [supplierPoViewMode, setSupplierPoViewMode] = useState<'orders' | 'statements'>('orders');
  const [expandedSupplierPoIds, setExpandedSupplierPoIds] = useState<Record<string, boolean>>({});
  const [supplierPoSearchQuery, setSupplierPoSearchQuery] = useState('');
  const [supplierPoStatusFilter, setSupplierPoStatusFilter] = useState<'all' | 'ALL_RECEIVED' | 'PARTIALLY_RECEIVED' | 'PENDING_DELIVERY'>('all');
  const [supplierPoPaymentFilter, setSupplierPoPaymentFilter] = useState<'all' | 'due' | 'settled' | 'overpaid'>('all');
  const [supplierPoPaymentModal, setSupplierPoPaymentModal] = useState<{
    po: any;
    amount: string;
    date: string;
    memo: string;
    receiptFile: string | null;
    receiptFileName: string | null;
    doubleConfirmed: boolean;
    error: string | null;
    loading: boolean;
  } | null>(null);

  // Payment Invoice PDF state
  const [isDownloadingReceipt, setIsDownloadingReceipt] = useState(false);

  // Function to generate receipt PDF for a specific payment from history or on demand
  const generateReceiptPDF = async (order: CustomerOrder, paymentEntry: any) => {
    try {
      // Find the payment in the order's payments array, or fallback to paymentEntry directly
      const payment = (order.payments && Array.isArray(order.payments))
        ? (order.payments.find(p => paymentEntry.receiptNumber && p.receiptNumber === paymentEntry.receiptNumber) ||
           order.payments.find(p => p.amount === paymentEntry.amount && p.date === paymentEntry.date) ||
           paymentEntry)
        : paymentEntry;

      if (!payment || typeof payment.amount !== 'number') {
        alert("Payment data not found or invalid");
        return;
      }

      // Find previous payments (all payments before this one)
      const paymentIndex = (order.payments && Array.isArray(order.payments))
        ? order.payments.findIndex(p => (payment.receiptNumber && p.receiptNumber === payment.receiptNumber) || (p.amount === payment.amount && p.date === payment.date))
        : -1;
      const safeIndex = paymentIndex >= 0 ? paymentIndex : (order.payments?.length || 0);
      const previousPayments = order.payments?.slice(0, safeIndex) || [];

      // Calculate if this is the final payment
      let grossRev = 0;
      (order.items || []).forEach(it => grossRev += (getItemEffectiveQty(it) * it.pricePerUnit * (1 + (it.taxPercent / 100))));
      const totalPaidIncludingThis = previousPayments.reduce((s, p) => s + p.amount, 0) + payment.amount;
      const isFinal = totalPaidIncludingThis >= grossRev;

      const orderShortId = (order.internalOrderNumber || 'ORDER').replace(/[^\w]/g, '').slice(-6);
      const safeReceiptNum = payment.receiptNumber || `RCV-${orderShortId}-${String(safeIndex + 1).padStart(2, '0')}-${Date.now().toString().slice(-4)}`;

      // Set up the PDF data
      const pdfData = {
        order: order,
        paymentAmount: payment.amount,
        receiptNumber: safeReceiptNum,
        isFinal: isFinal,
        previousPayments: previousPayments
      };

      // Trigger PDF generation
      setIsDownloadingReceipt(true);
      setPaymentInvoiceData(pdfData);
    } catch (e) {
      console.error('Failed to generate receipt PDF:', e);
      setIsDownloadingReceipt(false);
      alert("Failed to generate receipt PDF. Please try again.");
    }
  };

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

  // Load supplier ledger once on mount (not on every refreshKey poll)
  useEffect(() => {
    loadSupplierLedger(['all']);
  }, []);

  const fetchData = async () => {
    try {
      const [o, c, s, l, sp, con] = await Promise.all([
        dataService.getOrders(),
        dataService.getCustomers(),
        dataService.getSuppliers(),
        dataService.getLedgerEntries(),
        dataService.getSupplierPayments(),
        dataService.getContracts()
      ]);
      setOrders(o);
      setCustomers(c);
      setSuppliers(s);
      setLedgerEntries(l);
      setSupplierPayments(sp);
      setContracts(con);
    } catch (e) {
      console.error("Finance sync error:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadSupplierLedger = async (ids: string[]) => {
    if (ids.length === 0) { setSupplierLedger(null); return; }
    setSpLoading(true);
    setSpError(null);
    try {
      const param = ids.includes('all') ? 'all' : ids.join(',');
      const raw = await dataService.getSupplierLedger(param);
      // Flatten the response so UI can read summary fields directly
      setSupplierLedger({
        ...raw.summary,
        pendingObligations: raw.summary?.totalPending || 0,
        components: raw.components || [],
        payments: raw.payments || [],
        supplier: raw.supplier,
      });
    } catch (e: any) {
      setSpError(e.message || 'Failed to load supplier ledger');
    } finally {
      setSpLoading(false);
    }
  };

  const handleRecordPayment = async () => {
    const singleId = selectedSupplierIds.length === 1 ? selectedSupplierIds[0] : null;
    if (!singleId || singleId === 'all' || !spAmount) return;
    const amount = parseFloat(spAmount);
    if (isNaN(amount) || amount <= 0) { setSpError('Enter a valid amount'); return; }
    setSpLoading(true);
    setSpError(null);
    try {
      await dataService.recordSupplierPayment(singleId, amount, spMemo, spDate);
      setSpAmount('');
      setSpMemo(generatePaymentRef());
      await loadSupplierLedger(selectedSupplierIds);
      await fetchData();
    } catch (e: any) {
      setSpError(e.message || 'Failed to record payment');
    } finally {
      setSpLoading(false);
    }
  };

  const toggleSupplierPoExpand = (poId: string) => {
    setExpandedSupplierPoIds(prev => ({
      ...prev,
      [poId]: !prev[poId]
    }));
  };

  const handleToggleExpandAllSupplierPos = () => {
    const allExpanded = filteredSupplierPOs.length > 0 && filteredSupplierPOs.every(po => expandedSupplierPoIds[po.id]);
    if (allExpanded) {
      setExpandedSupplierPoIds({});
    } else {
      const next: Record<string, boolean> = {};
      filteredSupplierPOs.forEach(po => { next[po.id] = true; });
      setExpandedSupplierPoIds(next);
    }
  };

  const openSupplierPoPaymentModal = (po: any) => {
    const defaultAmount = po.balanceDue > 0 ? po.balanceDue.toString() : '';
    setSupplierPoPaymentModal({
      po,
      amount: defaultAmount,
      date: new Date().toISOString().split('T')[0],
      memo: `SP-${po.poNumber !== 'N/A' ? po.poNumber : po.orderNumber}`,
      receiptFile: null,
      receiptFileName: null,
      doubleConfirmed: false,
      error: null,
      loading: false
    });
  };

  const handleSupplierPoReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert("File size exceeds 10MB limit.");
      return;
    }
    setSupplierPoPaymentModal(prev => prev ? { ...prev, loading: true, error: null } : null);
    try {
      const res = await dataService.uploadSupplierReceipt(file);
      if (res && res.success && res.filePath) {
        setSupplierPoPaymentModal(prev => prev ? {
          ...prev,
          receiptFile: res.filePath,
          receiptFileName: file.name,
          loading: false
        } : null);
      } else {
        throw new Error(res?.error || 'Upload failed');
      }
    } catch (err: any) {
      setSupplierPoPaymentModal(prev => prev ? {
        ...prev,
        loading: false,
        error: err.message || 'Failed to upload receipt file'
      } : null);
    }
  };

  const handleSupplierPoPaymentSubmit = async () => {
    if (!supplierPoPaymentModal) return;
    const { po, amount, date, memo, receiptFile, doubleConfirmed } = supplierPoPaymentModal;
    const numAmt = parseFloat(amount);
    if (isNaN(numAmt) || numAmt <= 0) {
      setSupplierPoPaymentModal(prev => prev ? { ...prev, error: 'Please enter a valid positive payment amount.' } : null);
      return;
    }

    const isOverpaying = po.balanceDue > 0 && numAmt > po.balanceDue + 0.01;
    if (isOverpaying && !doubleConfirmed) {
      setSupplierPoPaymentModal(prev => prev ? { ...prev, error: 'Please check the box to confirm you want to make an overpayment.' } : null);
      return;
    }

    setSupplierPoPaymentModal(prev => prev ? { ...prev, loading: true, error: null } : null);
    try {
      await dataService.recordSupplierPayment(
        po.supplierId,
        numAmt,
        memo || `Payment for PO ${po.poNumber}`,
        date,
        receiptFile || undefined,
        po.orderId,
        po.poNumber !== 'N/A' ? po.poNumber : undefined
      );

      await fetchData();
      if (selectedSupplierIds.length > 0) {
        await loadSupplierLedger(selectedSupplierIds);
      }
      setSupplierPoPaymentModal(null);
    } catch (err: any) {
      setSupplierPoPaymentModal(prev => prev ? { ...prev, loading: false, error: err.message || 'Payment recording failed.' } : null);
    }
  };

  const downloadOrViewSupplierReceipt = (receiptData: string, filename?: string) => {
    const link = document.createElement('a');
    if (receiptData.startsWith('data:')) {
      link.href = receiptData;
    } else {
      const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
      link.href = receiptData.startsWith('/') ? `${backendUrl}${receiptData}` : `${backendUrl}/${receiptData}`;
    }
    link.download = filename || 'supplier-receipt';
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getPL = useCallback((order: CustomerOrder) => {
    let revenue = 0;
    let grossRevenue = 0;
    let cost = 0;
    let outputTax = 0;
    let inputTax = 0;
    let grossSourcedCost = 0;

    order.items.forEach(it => {
      const lineNet = getItemEffectiveQty(it) * (it.pricePerUnit || 0);
      revenue += lineNet;
      const taxRate = it.taxPercent !== undefined ? it.taxPercent : 14;
      const lineTax = lineNet * (taxRate / 100);
      outputTax += lineTax;
      grossRevenue += lineNet + lineTax;

      (it.components || []).forEach(c => {
        const cNet = (c.quantity || 0) * (c.unitCost || 0);
        cost += cNet;
        const cTaxRate = c.taxPercent !== undefined ? c.taxPercent : 0;
        const cTax = cNet * (cTaxRate / 100);
        inputTax += cTax;
        grossSourcedCost += (cNet + cTax);
      });
    });

    const rate = getOrderConversionRate(order);
    const costInOrderCurrency = cost * rate;
    const grossCostInOrderCurrency = grossSourcedCost * rate;
    const paid = (order.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const marginPct = revenue > 0 ? ((revenue - costInOrderCurrency) / revenue) * 100 : 0;
    const markupPct = costInOrderCurrency > 0 ? ((revenue - costInOrderCurrency) / costInOrderCurrency) * 100 : (revenue > 0 ? 100 : 0);
    const targetRev = order.appliesWithholdingTax ? grossRevenue * 0.99 : grossRevenue;

    const isInvoiced = [
      OrderStatus.INVOICED,
      OrderStatus.HUB_RELEASED,
      OrderStatus.DELIVERED,
      OrderStatus.WAITING_GOVE,
      OrderStatus.FULFILLED
    ].includes(order.status) || Boolean(order.invoiceNumber);

    // Output Tax recognized upon invoicing (0 if pre-invoiced)
    const recognizedOutputTax = isInvoiced ? outputTax : 0;
    // Net Tax Owed for this order = Output Tax (liability) - Input Tax (credit)
    const netTaxOwed = recognizedOutputTax - inputTax;

    // Customer AR (Unpaid debt on issued invoice) & Advance Prepayment (Pre-invoice cash or overpayment)
    const customerAR = isInvoiced ? Math.max(0, targetRev - paid) : 0;
    const customerAdvance = isInvoiced ? Math.max(0, paid - targetRev) : paid;

    // Supplier payments disbursed to this order via allocation
    const supplierPaidForOrder = (supplierPayments || []).reduce((s, sp) => {
      const allocs = (sp.allocations || []).filter((a: any) => a.orderId === order.id);
      return s + allocs.reduce((sum: number, a: any) => sum + (a.amount || 0), 0);
    }, 0);

    // Supplier AP (Unpaid supplier obligation for this order)
    const supplierAP = Math.max(0, grossCostInOrderCurrency - supplierPaidForOrder);

    // Work In Progress (WIP) asset vs Cost of Goods Sold (COGS)
    const wip = isInvoiced ? 0 : costInOrderCurrency;
    const cogs = isInvoiced ? costInOrderCurrency : 0;

    // Projected Profit (pipeline estimate) vs Realized Profit (officially recognized on invoice)
    const projectedProfit = revenue - costInOrderCurrency;
    const realizedProfit = isInvoiced ? projectedProfit : 0;

    // Double-Entry Balance Equation Check:
    // Assets (Debit): Cash Collected + Customer AR + WIP
    // Liabilities & Profit (Credit): Supplier AP + Customer Advance + Net Tax Owed + Realized Profit
    const poAssets = paid + customerAR + wip;
    const poLiabilitiesAndProfit = supplierAP + customerAdvance + netTaxOwed + realizedProfit;
    const poVariance = Math.abs(poAssets - poLiabilitiesAndProfit);
    const isPoBalanced = poVariance < 0.05;

    return {
      revenue,
      grossRevenue,
      targetRev,
      cost,
      costInOrderCurrency,
      conversionRate: rate,
      currency: getOrderCurrency(order),
      paid,
      outstanding: Math.max(0, targetRev - paid),
      marginPct,
      markupPct,
      // Enterprise Financials:
      isInvoiced,
      outputTax,
      inputTax,
      recognizedOutputTax,
      netTaxOwed,
      grossSourcedCost,
      grossCostInOrderCurrency,
      customerAR,
      customerAdvance,
      supplierPaidForOrder,
      supplierAP,
      wip,
      cogs,
      projectedProfit,
      realizedProfit,
      poAssets,
      poLiabilitiesAndProfit,
      poVariance,
      isPoBalanced
    };
  }, [supplierPayments]);

  const getOrderProjectName = useCallback((order: CustomerOrder): string => {
    if (order.projectName && order.projectName.trim() !== '') {
      return order.projectName.trim();
    }
    if (order.blanketContractId) {
      const parent = orders.find(p => (p.id === order.blanketContractId || p.internalOrderNumber === order.blanketContractId || p.customerReferenceNumber === order.blanketContractId) && p.status !== OrderStatus.REJECTED);
      if (parent?.projectName && parent.projectName.trim() !== '') {
        return parent.projectName.trim();
      }
    }
    const legacy = (order as any).project || (order as any).project_name || (order as any).projectName || '';
    return typeof legacy === 'string' ? legacy.trim() : '';
  }, [orders]);

  const customerAnalytics = useMemo(() => {
    return (customers || [])
      .filter(c => c && c.name && c.name.trim().toLowerCase() !== 'internal stock')
      .map(c => {
        const cOrders = orders.filter(o => 
          o.customerName === c.name && 
          o.status !== OrderStatus.REJECTED && 
          (o.status as string) !== 'REJECTED'
        );
        let totalQuotedGross = 0;
        let totalInvoicedGross = 0;
        let totalInvoicedNet = 0;
        let totalPaid = 0;
        let totalAR = 0;
        let totalAdvances = 0;
        let totalRealizedProfit = 0;
        let totalProjectedProfit = 0;
        let totalWip = 0;
        let totalOutputTax = 0;

        cOrders.forEach(o => {
          const pl = getPL(o);
          totalQuotedGross += pl.grossRevenue;
          totalPaid += pl.paid;
          totalProjectedProfit += pl.projectedProfit;
          if (pl.isInvoiced) {
            totalInvoicedGross += pl.grossRevenue;
            totalInvoicedNet += pl.revenue;
            totalAR += pl.customerAR;
            totalRealizedProfit += pl.realizedProfit;
            totalOutputTax += pl.outputTax;
          } else {
            totalAdvances += pl.customerAdvance;
            totalWip += pl.wip;
          }
        });

        const generalWallet = Number(c.walletBalance || 0);
        const projectWalletsTotal = Object.values(c.walletBalances || {}).reduce((s, v) => s + (Number(v) || 0), 0);
        const combinedWalletBalance = generalWallet + projectWalletsTotal;

        let status: 'ar_due' | 'credit_balance' | 'settled' | 'no_orders' = 'no_orders';
        if (cOrders.length > 0) {
          if (totalAR > 0.01) status = 'ar_due';
          else if (combinedWalletBalance > 0.01 || totalAdvances > 0.01) status = 'credit_balance';
          else status = 'settled';
        } else if (combinedWalletBalance > 0.01) {
          status = 'credit_balance';
        }

        return {
          customer: c,
          orders: cOrders,
          orderCount: cOrders.length,
          totalQuotedGross,
          totalInvoicedGross,
          totalInvoicedNet,
          totalPaid,
          totalAR,
          totalAdvances,
          generalWallet,
          projectWalletsTotal,
          combinedWalletBalance,
          totalRealizedProfit,
          totalProjectedProfit,
          totalWip,
          totalOutputTax,
          status
        };
      });
  }, [customers, orders, getPL]);

  const supplierAnalytics = useMemo(() => {
    const compBySupplier: Record<string, { totalCommitted: number; totalDelivered: number; inputTax: number; compCount: number }> = {};
    (orders || []).forEach(o => {
      (o.items || []).forEach(it => {
        (it.components || []).forEach(c => {
          if (!c.supplierId && !c.supplierName) return;
          const sKey = (c.supplierId || c.supplierName || 'unknown').toLowerCase();
          if (!compBySupplier[sKey]) {
            compBySupplier[sKey] = { totalCommitted: 0, totalDelivered: 0, inputTax: 0, compCount: 0 };
          }
          const net = (c.quantity || 0) * (c.unitCost || 0);
          const taxRate = c.taxPercent !== undefined ? c.taxPercent : 0;
          const tax = net * (taxRate / 100);
          const gross = net + tax;
          const recQty = c.receivedQty || 0;
          const delNet = recQty * (c.unitCost || 0);
          const delGross = delNet * (1 + (taxRate / 100));

          compBySupplier[sKey].totalCommitted += gross;
          compBySupplier[sKey].totalDelivered += delGross;
          compBySupplier[sKey].inputTax += tax;
          compBySupplier[sKey].compCount += 1;
        });
      });
    });

    const payBySupplier: Record<string, number> = {};
    (supplierPayments || []).forEach(sp => {
      const sKey = (sp.supplierId || 'unknown').toLowerCase();
      payBySupplier[sKey] = (payBySupplier[sKey] || 0) + (sp.amount || 0);
    });

    return (suppliers || []).map(s => {
      const sIdKey = (s.id || '').toLowerCase();
      const sNameKey = (s.name || '').toLowerCase();
      const cData = compBySupplier[sIdKey] || compBySupplier[sNameKey] || { totalCommitted: 0, totalDelivered: 0, inputTax: 0, compCount: 0 };
      const paid = payBySupplier[sIdKey] || 0;
      const committed = cData.totalCommitted;
      const delivered = cData.totalDelivered;
      const fulfilledAP = Math.max(0, delivered - paid);
      const totalAP = Math.max(0, committed - paid);
      const overpaid = Math.max(0, paid - committed);

      let status: 'overpaid' | 'settled' | 'payment_due' | 'committed' | 'no_orders' = 'no_orders';
      if (committed > 0) {
        if (paid > committed + 0.01) status = 'overpaid';
        else if (totalAP <= 0.01) status = 'settled';
        else if (paid < delivered - 0.01) status = 'payment_due';
        else status = 'committed';
      }

      return {
        supplier: s,
        committed,
        delivered,
        paid,
        fulfilledAP,
        totalAP,
        overpaid,
        inputTax: cData.inputTax,
        compCount: cData.compCount,
        status
      };
    });
  }, [suppliers, orders, supplierPayments]);

  // Master aggregation of Supplier Purchase Orders across all active customer orders
  const supplierPOsList = useMemo(() => {
    const posMap = new Map<string, {
      id: string;
      orderId: string;
      orderNumber: string;
      customerReferenceNumber: string;
      customerName: string;
      supplierId: string;
      supplierName: string;
      poNumber: string;
      components: any[];
      netValue: number;
      taxAmount: number;
      grossTotal: number;
      totalOrderedQty: number;
      totalReceivedQty: number;
      receivedComponentsCount: number;
      totalComponentsCount: number;
      receiptStatus: 'ALL_RECEIVED' | 'PARTIALLY_RECEIVED' | 'PENDING_DELIVERY';
      paidAmount: number;
      balanceDue: number;
      isOverpaid: boolean;
      isSettled: boolean;
      payments: any[];
    }>();

    (orders || []).forEach(o => {
      if (o.status === OrderStatus.REJECTED) return;
      (o.items || []).forEach(it => {
        (it.components || []).forEach(c => {
          if (!c.supplierId && !c.supplierName) return;
          if (['CANCELLED', 'NEW', 'PENDING_OFFER', 'RFP_SENT', 'AWARDED'].includes(c.status)) return;

          const sId = c.supplierId || (suppliers || []).find(s => s.name?.trim().toLowerCase() === c.supplierName?.trim().toLowerCase())?.id || 'unknown';
          const sName = c.supplierName || (suppliers || []).find(s => s.id === c.supplierId)?.name || 'Unknown Supplier';
          const poNum = (c.poNumber || '').trim() || 'NO_PO';
          const groupKey = `${o.id}__${sId}__${poNum}`;

          const net = (c.quantity || 0) * (c.unitCost || 0);
          const taxRate = c.taxPercent !== undefined ? c.taxPercent : 14;
          const tax = net * (taxRate / 100);
          const gross = net + tax;
          const recQty = c.receivedQty || 0;
          const isRec = c.status === 'RECEIVED' || (recQty >= (c.quantity || 0) && (c.quantity || 0) > 0);

          if (!posMap.has(groupKey)) {
            posMap.set(groupKey, {
              id: groupKey,
              orderId: o.id,
              orderNumber: o.internalOrderNumber,
              customerReferenceNumber: o.customerReferenceNumber || o.internalOrderNumber,
              customerName: o.customerName,
              supplierId: sId,
              supplierName: sName,
              poNumber: poNum === 'NO_PO' ? 'N/A' : poNum,
              components: [],
              netValue: 0,
              taxAmount: 0,
              grossTotal: 0,
              totalOrderedQty: 0,
              totalReceivedQty: 0,
              receivedComponentsCount: 0,
              totalComponentsCount: 0,
              receiptStatus: 'PENDING_DELIVERY',
              paidAmount: 0,
              balanceDue: 0,
              isOverpaid: false,
              isSettled: false,
              payments: []
            });
          }

          const po = posMap.get(groupKey)!;
          po.components.push({
            ...c,
            parentItemDesc: it.description,
            netCost: net,
            taxRate,
            taxAmount: tax,
            grossCost: gross,
            receivedQty: recQty,
            isReceived: isRec
          });
          po.netValue += net;
          po.taxAmount += tax;
          po.grossTotal += gross;
          po.totalOrderedQty += (c.quantity || 0);
          po.totalReceivedQty += recQty;
          po.totalComponentsCount += 1;
          if (isRec) po.receivedComponentsCount += 1;
        });
      });
    });

    // Compute fulfillment status and allocate payments per PO
    return Array.from(posMap.values()).map(po => {
      // 1. Receipt status
      if (po.totalComponentsCount > 0 && po.receivedComponentsCount === po.totalComponentsCount) {
        po.receiptStatus = 'ALL_RECEIVED';
      } else if (po.totalReceivedQty >= po.totalOrderedQty && po.totalOrderedQty > 0) {
        po.receiptStatus = 'ALL_RECEIVED';
      } else if (po.totalReceivedQty > 0 || po.receivedComponentsCount > 0) {
        po.receiptStatus = 'PARTIALLY_RECEIVED';
      } else {
        po.receiptStatus = 'PENDING_DELIVERY';
      }

      // 2. Payments & Allocations
      const compIds = new Set(po.components.map(c => c.id));
      let paid = 0;
      const matchedPayments: any[] = [];

      (supplierPayments || []).forEach(sp => {
        const matchesSupplier = sp.supplierId === po.supplierId || sp.supplierName?.toLowerCase() === po.supplierName.toLowerCase();
        if (!matchesSupplier) return;

        let allocSum = 0;
        (sp.allocations || []).forEach(a => {
          if (compIds.has(a.componentId)) {
            allocSum += (a.amount || 0);
          }
        });

        if (allocSum > 0) {
          paid += allocSum;
          matchedPayments.push({
            ...sp,
            allocatedToThisPo: allocSum
          });
        } else if ((!sp.allocations || sp.allocations.length === 0) && sp.orderId === po.orderId && (sp.poNumber === po.poNumber || po.poNumber === 'N/A')) {
          paid += (sp.amount || 0);
          matchedPayments.push({
            ...sp,
            allocatedToThisPo: sp.amount
          });
        }
      });

      po.paidAmount = Math.round(paid * 100) / 100;
      po.balanceDue = Math.max(0, Math.round((po.grossTotal - po.paidAmount) * 100) / 100);
      po.isSettled = po.grossTotal > 0 && po.paidAmount >= po.grossTotal - 0.05;
      po.isOverpaid = po.paidAmount > po.grossTotal + 0.05;
      po.payments = matchedPayments;

      return po;
    }).sort((a, b) => b.orderNumber.localeCompare(a.orderNumber));
  }, [orders, suppliers, supplierPayments]);

  const filteredSupplierPOs = useMemo(() => {
    return supplierPOsList.filter(po => {
      // Search filter
      if (supplierPoSearchQuery.trim()) {
        const q = supplierPoSearchQuery.toLowerCase().trim();
        const matches =
          po.customerReferenceNumber.toLowerCase().includes(q) ||
          po.orderNumber.toLowerCase().includes(q) ||
          po.customerName.toLowerCase().includes(q) ||
          po.poNumber.toLowerCase().includes(q) ||
          po.supplierName.toLowerCase().includes(q) ||
          po.components.some(c => (c.description || '').toLowerCase().includes(q));
        if (!matches) return false;
      }

      // Status filter
      if (supplierPoStatusFilter !== 'all') {
        if (po.receiptStatus !== supplierPoStatusFilter) return false;
      }

      // Payment filter
      if (supplierPoPaymentFilter !== 'all') {
        if (supplierPoPaymentFilter === 'due' && po.isSettled) return false;
        if (supplierPoPaymentFilter === 'settled' && !po.isSettled) return false;
        if (supplierPoPaymentFilter === 'overpaid' && !po.isOverpaid) return false;
      }

      return true;
    });
  }, [supplierPOsList, supplierPoSearchQuery, supplierPoStatusFilter, supplierPoPaymentFilter]);

  const supplierPoSummaryMetrics = useMemo(() => {
    return supplierPOsList.reduce((acc, po) => {
      acc.totalCount += 1;
      acc.totalNetValue += po.netValue;
      acc.totalTax += po.taxAmount;
      acc.totalGross += po.grossTotal;
      acc.totalPaid += po.paidAmount;
      acc.totalBalanceDue += po.balanceDue;
      if (po.receiptStatus === 'ALL_RECEIVED') acc.allReceivedCount += 1;
      if (po.receiptStatus === 'PARTIALLY_RECEIVED') acc.partialReceivedCount += 1;
      if (po.receiptStatus === 'PENDING_DELIVERY') acc.pendingDeliveryCount += 1;
      return acc;
    }, {
      totalCount: 0,
      totalNetValue: 0,
      totalTax: 0,
      totalGross: 0,
      totalPaid: 0,
      totalBalanceDue: 0,
      allReceivedCount: 0,
      partialReceivedCount: 0,
      pendingDeliveryCount: 0
    });
  }, [supplierPOsList]);

  const handleRecordCustomerAdvance = async () => {
    if (!advanceModalCustomer) return;
    const amt = parseFloat(advanceAmount);
    if (!amt || amt <= 0) {
      alert("Please enter a valid prepayment amount.");
      return;
    }
    setAdvanceLoading(true);
    try {
      await dataService.recordCustomerAdvancePayment(
        advanceModalCustomer.id,
        amt,
        advanceMemo.trim() || 'Customer advance deposit (prepayment)',
        advanceDate,
        advanceProject.trim() || undefined
      );
      setAdvanceModalCustomer(null);
      setAdvanceAmount('');
      setAdvanceMemo('');
      setAdvanceProject('');
      await fetchData();
    } catch (err: any) {
      alert(err.message || "Failed to record customer advance prepayment");
    } finally {
      setAdvanceLoading(false);
    }
  };

  const isOrderBlanket = useCallback((order: CustomerOrder): boolean =>
    !!(order.blanketOrder || order.contractId || order.blanketContractId), []);

  // Mirrors ProcurementModule's "No RFP Needed" determination (minus its
  // session-local checkbox-override cache, which isn't visible outside that
  // module) so the Orders tab can tell whether procurement still needs to run
  // an RFP for this order before treating it as Blanket in the badge below.
  const isOrderNoRfpNeeded = useCallback((order: CustomerOrder): boolean => {
    const procComponents = (order.items || []).flatMap(it => it.components || []).filter(c => c.source === 'PROCUREMENT');
    if (procComponents.length > 0 && procComponents.every(c => c.noRfpNeeded === false)) return false;
    const isOutsourcing = (order.items || []).some(i => i.productionType === 'OUTSOURCING');
    if (isOutsourcing) return true;
    return (order.items || []).some(i => Boolean(i.costSheetFile || i.costSheetText));
  }, []);

  // The order's most recently uploaded outsourcing cost sheet ("last month's" sheet):
  // the latest entry in an item's costSheets history, falling back to the item's
  // current attached file when no history array has been recorded yet.
  const getBlanketOrderLatestCostSheet = useCallback((order: CustomerOrder): { fileName: string; fileData: string; uploadedAt?: string } | null => {
    const items = order.items || [];
    const targetItem =
      items.find(i => (i.costSheets || []).length > 0) ||
      items.find(i => i.costSheetFile) ||
      items.find(i => i.productionType === 'OUTSOURCING') ||
      null;
    if (!targetItem) return null;
    const history = targetItem.costSheets || [];
    if (history.length > 0) {
      const latest = history[history.length - 1];
      if (latest.fileData) {
        return { fileName: latest.fileName || 'cost-sheet.xlsx', fileData: latest.fileData, uploadedAt: latest.uploadedAt };
      }
    }
    if (targetItem.costSheetFile) {
      return { fileName: targetItem.costSheetFileName || 'cost-sheet.xlsx', fileData: targetItem.costSheetFile };
    }
    return null;
  }, []);

  const getCustomerWalletBalance = useCallback((customerName?: string): number => {
    if (!customerName) return 0;
    const target = customerName.trim().toLowerCase();
    const cust = customers.find(c => c.name.trim().toLowerCase() === target);
    return Number(cust?.walletBalance || 0);
  }, [customers]);

  const getProjectWalletBalance = useCallback((projectName: string, customerName?: string): number => {
    if (!projectName) return 0;
    const targetProj = projectName.trim().toLowerCase();

    // If customerName provided, prioritize that customer's project wallet balance
    if (customerName) {
      const cust = customers.find(c => c.name.trim().toLowerCase() === customerName.trim().toLowerCase());
      if (cust?.walletBalances) {
        for (const [pName, bal] of Object.entries(cust.walletBalances)) {
          if (pName.trim().toLowerCase() === targetProj) {
            return Number(bal) || 0;
          }
        }
      }
    }

    // Aggregate across all customers for this project name
    let totalProjBal = 0;
    let matched = false;
    for (const c of customers) {
      if (c.walletBalances) {
        for (const [pName, bal] of Object.entries(c.walletBalances)) {
          if (pName.trim().toLowerCase() === targetProj) {
            totalProjBal += Number(bal) || 0;
            matched = true;
          }
        }
      }
    }
    if (matched) return totalProjBal;
    return 0;
  }, [customers]);

  const projectWallets = useMemo(() => {
    const q = projectWalletSearch.trim().toLowerCase();
    const map = new Map<string, {
      projectName: string;
      totalBalance: number;
      allocations: { customer: Customer; balance: number }[];
      orders: CustomerOrder[];
    }>();

    customers.forEach(c => {
      const projMap = c.walletBalances || {};
      Object.entries(projMap).forEach(([proj, bal]) => {
        const pName = proj.trim();
        if (!pName) return;
        const b = Number(bal) || 0;
        if (!map.has(pName)) {
          const projOrders = orders.filter(o => o.status !== OrderStatus.REJECTED && getOrderProjectName(o) === pName && isOrderBlanket(o));
          map.set(pName, {
            projectName: pName,
            totalBalance: 0,
            allocations: [],
            orders: projOrders
          });
        }
        const entry = map.get(pName)!;
        entry.totalBalance += b;
        entry.allocations.push({ customer: c, balance: b });
      });
    });

    // Also include any blanket project that has active non-rejected orders even if balance is currently 0
    orders.forEach(o => {
      if (o.status !== OrderStatus.REJECTED && isOrderBlanket(o)) {
        const pName = getOrderProjectName(o);
        if (pName && !map.has(pName)) {
          const projOrders = orders.filter(ord => ord.status !== OrderStatus.REJECTED && getOrderProjectName(ord) === pName && isOrderBlanket(ord));
          if (projOrders.length > 0) {
            map.set(pName, {
              projectName: pName,
              totalBalance: 0,
              allocations: [],
              orders: projOrders
            });
          }
        }
      }
    });

    return Array.from(map.values())
      .filter(item => item.orders.length > 0 || item.totalBalance !== 0)
      .filter(item => {
        if (!q) return true;
        return (
          item.projectName.toLowerCase().includes(q) ||
          item.allocations.some(a => a.customer.name.toLowerCase().includes(q)) ||
          item.orders.some(o =>
            (o.customerReferenceNumber || '').toLowerCase().includes(q) ||
            (o.internalOrderNumber || '').toLowerCase().includes(q) ||
            (o.customerName || '').toLowerCase().includes(q)
          )
        );
      })
      .sort((a, b) => a.projectName.localeCompare(b.projectName));
  }, [customers, orders, projectWalletSearch, getOrderProjectName, isOrderBlanket]);

  const blanketOrdersByMonth = useMemo(() => {
    const q = blanketHistorySearch.trim().toLowerCase();
    const filtered = orders.filter(o => isOrderBlanket(o) && o.status !== OrderStatus.REJECTED).filter(o => {
      if (!q) return true;
      const proj = getOrderProjectName(o).toLowerCase();
      const contract = (o.contractId || o.blanketContractId || '').toLowerCase();
      return (
        (o.internalOrderNumber || '').toLowerCase().includes(q) ||
        (o.customerReferenceNumber || '').toLowerCase().includes(q) ||
        (o.customerName || '').toLowerCase().includes(q) ||
        contract.includes(q) ||
        proj.includes(q)
      );
    });

    const groups = new Map<string, { label: string; orders: CustomerOrder[] }>();
    for (const o of filtered) {
      const dateStr = o.orderDate || o.dataEntryTimestamp;
      const d = dateStr ? new Date(dateStr) : null;
      const valid = d && !isNaN(d.getTime());
      const key = valid ? `${d!.getFullYear()}-${String(d!.getMonth() + 1).padStart(2, '0')}` : 'undated';
      const label = valid ? d!.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : (t('finance.blanketHistory.undatedMonth') || 'Undated');
      if (!groups.has(key)) groups.set(key, { label, orders: [] });
      groups.get(key)!.orders.push(o);
    }

    return Array.from(groups.entries())
      .sort(([keyA], [keyB]) => {
        if (keyA === 'undated') return 1;
        if (keyB === 'undated') return -1;
        return keyB.localeCompare(keyA); // most recent month first
      })
      .map(([key, val]) => ({
        key,
        label: val.label,
        orders: [...val.orders].sort((a, b) =>
          new Date(b.orderDate || b.dataEntryTimestamp || 0).getTime() - new Date(a.orderDate || a.dataEntryTimestamp || 0).getTime()
        ),
      }));
  }, [orders, blanketHistorySearch, isOrderBlanket, getOrderProjectName, t]);

  const downloadCostSheetFile = (fileData: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = fileData;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const openCostSheetModal = (order: CustomerOrder, targetItem?: CustomerOrderItem | null) => {
    const item = targetItem || (order.items || []).find(i => i.costSheetFile) || (order.items || [])[0];
    if (!item?.costSheetFile) return;
    setCostSheetModalData({
      fileName: item.costSheetFileName || `CostSheet-${order.internalOrderNumber || order.customerReferenceNumber}.xlsx`,
      fileData: item.costSheetFile,
      orderTitle: `${order.internalOrderNumber || ''} ${order.customerReferenceNumber ? `(PO: ${order.customerReferenceNumber})` : ''}`
    });
  };

  const stockOrders = useMemo(() => {
    return orders.filter(o =>
      o.status !== OrderStatus.REJECTED &&
      (o.customerName === 'Internal Stock' || (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-')))
    );
  }, [orders]);

  const filteredStockOrders = useMemo(() => {
    const q = search.toLowerCase().trim();
    return stockOrders.filter(o => {
      if (!q) return true;
      if ((o.internalOrderNumber || '').toLowerCase().includes(q)) return true;
      if ((o.customerReferenceNumber || '').toLowerCase().includes(q)) return true;
      if ((o.status || '').toLowerCase().includes(q)) return true;
      for (const item of (o.items || [])) {
        if ((item.description || '').toLowerCase().includes(q)) return true;
        for (const comp of (item.components || [])) {
          if ((comp.description || '').toLowerCase().includes(q)) return true;
          if ((comp.componentNumber || '').toLowerCase().includes(q)) return true;
          if ((comp.supplierPartNumber || '').toLowerCase().includes(q)) return true;
          if ((comp.supplierName || '').toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }, [stockOrders, search]);

  // Map total allocated quantities from stock orders across all active non-rejected orders
  const stockAllocationMap = useMemo(() => {
    const map = new Map<string, number>();
    orders.forEach(order => {
      if (order.status === OrderStatus.REJECTED || (order.status as string) === 'REJECTED') return;
      (order.items || []).forEach(item => {
        (item.components || []).forEach(comp => {
          if (comp.allocatedFromStockOrderId) {
            const qty = Number(comp.quantity) || 0;
            const sCompId = comp.allocatedFromStockCompId;
            const descKey = `${comp.allocatedFromStockOrderId}:::${String(comp.description || '').trim().toLowerCase()}`;
            if (sCompId) map.set(sCompId, (map.get(sCompId) || 0) + qty);
            map.set(descKey, (map.get(descKey) || 0) + qty);
          }
        });
      });
    });
    return map;
  }, [orders]);

  const getStockCompRemainingQty = useCallback((orderId: string, item: any, comp: any): number => {
    const descKey = `${orderId}:::${String(comp.description || '').trim().toLowerCase()}`;
    const allocatedTotal = (comp.id && stockAllocationMap.get(comp.id)) || stockAllocationMap.get(descKey) || (comp.allocatedQty || 0);
    if (allocatedTotal > 0) {
      const baseQty = comp.originalQuantity !== undefined
        ? comp.originalQuantity
        : (item.originalQuantity !== undefined
          ? item.originalQuantity
          : (((comp.allocatedQty || 0) > 0)
            ? ((Number(comp.quantity) || 0) + comp.allocatedQty)
            : (Number(comp.quantity) || 0)));
      return Math.max(0, Number((baseQty - allocatedTotal).toFixed(3)));
    }
    return Number(comp.quantity) || 0;
  }, [stockAllocationMap]);

  const getStockCompAllocatedQty = useCallback((orderId: string, item: any, comp: any): number => {
    const descKey = `${orderId}:::${String(comp.description || '').trim().toLowerCase()}`;
    return (comp.id && stockAllocationMap.get(comp.id)) || stockAllocationMap.get(descKey) || (comp.allocatedQty || 0);
  }, [stockAllocationMap]);

  const getStockCompCategory = useCallback((comp: any, remainingQty: number): 'inside_stock' | 'in_transition' | 'not_ordered' => {
    const isReceived = comp.status === 'RECEIVED' || comp.status === 'IN_STOCK' || (comp.receivedQty !== undefined && comp.receivedQty >= remainingQty && remainingQty > 0);
    if (isReceived) return 'inside_stock';
    const isOrdered = comp.status === 'ORDERED' || Boolean(comp.poNumber) || Boolean(comp.sendPoId);
    if (isOrdered) return 'in_transition';
    return 'not_ordered';
  }, []);

  const getStockCompReceivedQty = useCallback((orderId: string, item: any, comp: any): number => {
    const remainingQty = getStockCompRemainingQty(orderId, item, comp);
    if (remainingQty <= 0) return 0;
    const statusUpper = String(comp.status || '').toUpperCase();
    if (statusUpper === 'RECEIVED' || statusUpper === 'IN_STOCK') {
      const rec = comp.receivedQty !== undefined ? Number(comp.receivedQty) : remainingQty;
      return Math.max(0, Math.min(remainingQty, rec));
    }
    if (comp.receivedQty !== undefined && Number(comp.receivedQty) > 0) {
      return Math.max(0, Math.min(remainingQty, Number(comp.receivedQty)));
    }
    return 0;
  }, [getStockCompRemainingQty]);

  const stockStats = useMemo(() => {
    let grandTotalInventoryValue = 0; // Physically received in inventory only!
    let totalCommittedPipeline = 0;   // In inventory + in transit + pending
    let insideStockValue = 0;
    let inTransitionValue = 0;
    let notOrderedValue = 0;

    let insideStockCount = 0;
    let inTransitionCount = 0;
    let notOrderedCount = 0;
    let totalComponentsCount = 0;
    let fulfilledOrdersCount = 0;
    let activeOrdersCount = 0;

    stockOrders.forEach(o => {
      if (o.status === OrderStatus.REJECTED) return; // already filtered, extra guard
      if (o.status === OrderStatus.FULFILLED) fulfilledOrdersCount++;
      else activeOrdersCount++;

      (o.items || []).forEach(it => {
        (it.components || []).forEach(c => {
          if (c.status === 'CANCELLED') return;
          const remainingQty = getStockCompRemainingQty(o.id, it, c);
          const unitCost = Number(c.unitCost) || 0;
          const receivedQty = getStockCompReceivedQty(o.id, it, c);
          const receivedVal = receivedQty * unitCost;
          const unreceivedQty = Math.max(0, remainingQty - receivedQty);
          const unreceivedVal = unreceivedQty * unitCost;

          totalComponentsCount++;

          // DYNAMIC RULE: ONLY ADD TO GRAND TOTAL OF INVENTORY IF RECEIVED IN INVENTORY!
          if (receivedQty > 0) {
            grandTotalInventoryValue += receivedVal;
            insideStockValue += receivedVal;
            insideStockCount++;
          }

          const cat = getStockCompCategory(c, remainingQty);
          if (cat === 'inside_stock') {
            if (receivedQty === 0 && unreceivedQty > 0) {
              grandTotalInventoryValue += unreceivedVal;
              insideStockValue += unreceivedVal;
              insideStockCount++;
            }
          } else if (cat === 'in_transition') {
            inTransitionValue += unreceivedVal;
            inTransitionCount++;
          } else {
            notOrderedValue += unreceivedVal;
            notOrderedCount++;
          }

          totalCommittedPipeline += (remainingQty * unitCost);
        });
      });
    });

    return {
      totalOrders: stockOrders.length,
      activeOrdersCount,
      fulfilledOrdersCount,
      totalStockValue: grandTotalInventoryValue, // Strictly received inventory!
      grandTotalInventoryValue,
      totalCommittedPipeline,
      totalComponentsCount,
      insideStockValue,
      insideStockCount,
      inTransitionValue,
      inTransitionCount,
      notOrderedValue,
      notOrderedCount
    };
  }, [stockOrders, getStockCompRemainingQty, getStockCompReceivedQty, getStockCompCategory]);

  const ordersWithPL = useMemo(() => orders.map(o => ({ ...o, pl: getPL(o) })), [orders, getPL]);

  const filteredOrders = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filtered = ordersWithPL.filter(o => {
      if (o.customerName === 'Internal Stock' || (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-'))) return false;
      if ([OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status)) return false;
      if (!q) return true;

      // 1. Internal order number & Customer PO reference
      if ((o.internalOrderNumber || '').toLowerCase().includes(q)) return true;
      if ((o.customerReferenceNumber || '').toLowerCase().includes(q)) return true;

      // 2. Customer name
      if ((o.customerName || '').toLowerCase().includes(q)) return true;

      // 3. Invoice number
      if ((o.invoiceNumber || '').toLowerCase().includes(q)) return true;

      // 4. Contract & Project Name search (supports matching any part of project name, 'project', or 'non-project')
      if ((o.contractId || '').toLowerCase().includes(q)) return true;
      if ((o.blanketContractId || '').toLowerCase().includes(q)) return true;

      const proj = getOrderProjectName(o).toLowerCase();
      const hasProj = Boolean(proj);

      if (hasProj) {
        if (proj.includes(q)) return true;
        if (`project: ${proj}`.includes(q)) return true;
        if (`project ${proj}`.includes(q)) return true;
        if (q === 'project' || q === 'projects' || (q.length >= 3 && 'project'.includes(q))) return true;
        const tokens = q.split(/\s+/).filter(Boolean);
        if (tokens.length > 1 && tokens.every(tok => proj.includes(tok))) return true;
      } else {
        if ('non-project non project nonproject non_project'.includes(q) || q === 'non' || q === 'non-project' || q === 'non project') return true;
      }

      // 5. Dates
      const orderDateRaw = (o.orderDate || '').toLowerCase();
      const orderDateFormatted = o.orderDate ? new Date(o.orderDate).toLocaleDateString().toLowerCase() : '';
      if (orderDateRaw.includes(q) || orderDateFormatted.includes(q)) return true;

      // 6. Status & Currency
      if ((o.status || '').toLowerCase().includes(q)) return true;
      if (getOrderCurrency(o).toLowerCase().includes(q)) return true;

      // 7. Line Items & components
      for (const item of (o.items || [])) {
        if ((item.description || '').toLowerCase().includes(q)) return true;
        for (const comp of (item.components || [])) {
          if ((comp.description || '').toLowerCase().includes(q)) return true;
          if ((comp.componentNumber || '').toLowerCase().includes(q)) return true;
        }
      }

      return false;
    });

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
  }, [ordersWithPL, search, sortConfig, getOrderProjectName]);

  const ordersSummaryMetrics = useMemo(() => {
    let totalGrossRevenue = 0;
    let totalNetRevenue = 0;
    let totalPaid = 0;
    let totalCustomerAR = 0;
    let totalWIP = 0;
    let totalSupplierAP = 0;
    let totalCustomerAdvances = 0;
    let totalRecognizedOutputTax = 0;
    let totalInputTax = 0;
    let totalNetTaxOwed = 0;
    let totalRealizedProfit = 0;
    let totalProjectedProfit = 0;
    let totalAssets = 0;
    let totalLiabilitiesAndProfit = 0;
    let balancedOrdersCount = 0;
    const totalOrdersCount = filteredOrders.length;

    filteredOrders.forEach(o => {
      const pl = (o as any).pl || getPL(o);
      totalGrossRevenue += (pl.grossRevenue || 0);
      totalNetRevenue += (pl.revenue || 0);
      totalPaid += (pl.paid || 0);
      totalCustomerAR += (pl.customerAR || 0);
      totalWIP += (pl.wip || 0);
      totalSupplierAP += (pl.supplierAP || 0);
      totalCustomerAdvances += (pl.customerAdvance || 0);
      totalRecognizedOutputTax += (pl.recognizedOutputTax || 0);
      totalInputTax += (pl.inputTax || 0);
      totalNetTaxOwed += (pl.netTaxOwed || 0);
      totalRealizedProfit += (pl.realizedProfit || 0);
      totalProjectedProfit += (pl.projectedProfit || 0);
      totalAssets += (pl.poAssets || 0);
      totalLiabilitiesAndProfit += (pl.poLiabilitiesAndProfit || 0);
      if (pl.isPoBalanced) {
        balancedOrdersCount++;
      }
    });

    const totalVariance = Math.abs(totalAssets - totalLiabilitiesAndProfit);
    const isOverallBalanced = totalVariance < 1.0;

    return {
      totalGrossRevenue,
      totalNetRevenue,
      totalPaid,
      totalCustomerAR,
      totalWIP,
      totalSupplierAP,
      totalCustomerAdvances,
      totalRecognizedOutputTax,
      totalInputTax,
      totalNetTaxOwed,
      totalRealizedProfit,
      totalProjectedProfit,
      totalAssets,
      totalLiabilitiesAndProfit,
      totalVariance,
      isOverallBalanced,
      balancedOrdersCount,
      totalOrdersCount
    };
  }, [filteredOrders, getPL]);

  type FinanceOrderDisplayItem =
    | {
        type: 'standard';
        order: CustomerOrder;
        orderIdx: number;
      }
    | {
        type: 'blanket_project_group';
        groupId: string;
        projectName: string;
        latestOrder: CustomerOrder;
        orders: CustomerOrder[];
        firstOrderIndex: number;
      }
    | {
        type: 'blanket_single';
        order: CustomerOrder;
        orderIdx: number;
      };

  const groupedFinanceOrderItems = useMemo<FinanceOrderDisplayItem[]>(() => {
    const items: FinanceOrderDisplayItem[] = [];
    const processedProjects = new Set<string>();

    filteredOrders.forEach((o, idx) => {
      const isBlanket = isOrderBlanket(o);
      const projName = getOrderProjectName(o);

      if (isBlanket && projName) {
        const normProj = projName.toLowerCase().trim();
        if (processedProjects.has(normProj)) {
          // Already grouped with the first sorted order of this project!
          return;
        }
        processedProjects.add(normProj);

        // Find all blanket orders matching this project name from filteredOrders
        const matchingOrders = filteredOrders.filter(
          other => isOrderBlanket(other) && getOrderProjectName(other).toLowerCase().trim() === normProj
        );

        // Sort matching orders by date descending so the latest order is at index 0
        const sortedByDate = [...matchingOrders].sort((a, b) => {
          const tA = new Date(a.orderDate || a.dataEntryTimestamp || 0).getTime();
          const tB = new Date(b.orderDate || b.dataEntryTimestamp || 0).getTime();
          return tB - tA;
        });

        const latestOrder = sortedByDate[0] || o;

        items.push({
          type: 'blanket_project_group',
          groupId: `proj_blanket_${normProj.replace(/\s+/g, '_')}`,
          projectName: projName,
          latestOrder,
          orders: sortedByDate,
          firstOrderIndex: idx,
        });
      } else if (isBlanket && !projName) {
        items.push({
          type: 'blanket_single',
          order: o,
          orderIdx: idx,
        });
      } else {
        items.push({
          type: 'standard',
          order: o,
          orderIdx: idx,
        });
      }
    });

    return items;
  }, [filteredOrders, isOrderBlanket, getOrderProjectName]);


  const handleRecordAndGenerateReceipt = async () => {
    if (!decisionModal || decisionModal.type !== 'payment') return;
    const amt = parseFloat(paymentAmount) || 0;
    if (amt <= 0) {
      setErrorMsg("Amount must be greater than zero");
      return;
    }

    setIsProcessing(true);
    try {
      const updatedOrder = await dataService.recordPayment(decisionModal.entityId, amt, comment.trim() || 'Payment received', useCustomerWallet);
      let grossRev = 0;
      (updatedOrder.items || []).forEach((it: any) => grossRev += (getItemEffectiveQty(it) * it.pricePerUnit * (1 + (it.taxPercent / 100))));
      const totalPaidNow = (updatedOrder.payments || []).reduce((s: number, p: any) => s + p.amount, 0);
      const lastPayment = updatedOrder.payments?.[updatedOrder.payments.length - 1];
      const previousPayments = updatedOrder.payments?.slice(0, -1) || [];

      setIsDownloadingReceipt(true);
      setPaymentInvoiceData({
        order: updatedOrder,
        paymentAmount: amt,
        receiptNumber: lastPayment?.receiptNumber || `RCV-${(updatedOrder.internalOrderNumber || '').replace(/[^\w]/g, '').slice(-6)}-${String(updatedOrder.payments?.length || 1).padStart(2, '0')}-${Date.now().toString().slice(-4)}`,
        isFinal: totalPaidNow >= grossRev,
        previousPayments
      });

      await fetchData();
      closeModals();
    } catch (e: any) {
      setErrorMsg(e.message || "Action failed");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecuteDecision = async () => {
    if (!decisionModal) return;
    if (!['billing', 'payment'].includes(decisionModal.type) && !comment.trim()) { setErrorMsg("Audit memo is mandatory"); return; }

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
          await dataService.recordPayment(decisionModal.entityId, amt, comment.trim() || 'Payment received', useCustomerWallet);
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

  const closeModals = () => { setDecisionModal(null); setComment(''); setPaymentAmount(''); setDispatchReceiptInputs({}); setErrorMsg(null); setUseCustomerWallet(false); };

  // --- Blanket Contracts (Finance Operations) state & handlers ---
  const [settleModal, setSettleModal] = useState<{ contract: CustomerOrder } | null>(null);
  const [settleOrderId, setSettleOrderId] = useState('');
  const [finReqModal, setFinReqModal] = useState<{ contract: CustomerOrder } | null>(null);
  const [finReqMemo, setFinReqMemo] = useState('');
  const [finReqAmount, setFinReqAmount] = useState('');
  const [finReqTarget, setFinReqTarget] = useState('');
  const [contractMsg, setContractMsg] = useState<string | null>(null);

  const blanketSettlingOrders = useMemo(() => {
    const map: Record<string, CustomerOrder[]> = {};
    orders.forEach(o => {
      if (o.isSettlingOrder && o.blanketContractId) {
        const key = o.blanketContractId;
        if (!map[key]) map[key] = [];
        map[key].push(o);
      }
    });
    return map;
  }, [orders]);

  const handleSettleBlanket = async () => {
    if (!settleModal || !settleOrderId.trim()) { setContractMsg('Enter the settling order ID'); return; }
    setContractMsg(null);
    try {
      const target = settleOrderId.trim();
      // Accept either the internal order number or the raw record ID
      const linked = orders.find(o => o.id === target || o.internalOrderNumber === target);
      if (!linked) { setContractMsg('Settling order not found'); return; }
      await dataService.settleBlanketOrder(settleModal.contract.id, linked.id);
      setSettleModal(null);
      setSettleOrderId('');
      await fetchData();
    } catch (e: any) {
      setContractMsg(e.message || 'Settlement failed');
    }
  };

  const handleFinancialRequest = async () => {
    if (!finReqModal) return;
    setContractMsg(null);
    try {
      const amount = finReqAmount ? parseFloat(finReqAmount) : undefined;
      const targetId = finReqTarget
        ? (orders.find(o => o.id === finReqTarget || o.internalOrderNumber === finReqTarget)?.id || finReqTarget)
        : undefined;
      await dataService.financialRequest(finReqModal.contract.id, finReqMemo, amount, targetId);
      setFinReqModal(null);
      setFinReqMemo('');
      setFinReqAmount('');
      setFinReqTarget('');
      await fetchData();
      alert('Financial Request logged successfully. It is now visible in Finance Operations.');
    } catch (e: any) {
      setContractMsg(e.message || 'Failed to log financial request');
    }
  };

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

  // html2canvas v1 does not support modern CSS color functions (oklch/oklab/lch/lab/color)
  // which Tailwind CSS 4 uses by default.
  // safeHtml2Canvas wraps html2canvas:
  // 1. Proxies window.getComputedStyle and the cloned iframe's getComputedStyle during capture
  // 2. Converts any oklch(...) to valid rgba(...) via Canvas 2D 8-bit rasterization (getImageData)
  // 3. Cleanly restores window.getComputedStyle in finally
  const safeHtml2Canvas = async (
    element: HTMLElement,
    options: any = {}
  ): Promise<HTMLCanvasElement> => {
    let cvs: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      cvs = document.createElement('canvas');
      cvs.width = 1;
      cvs.height = 1;
      ctx = cvs.getContext('2d', { willReadFrequently: true });
    } catch {}

    const oklchToRgb = (str: string): string => {
      if (!str || typeof str !== 'string') return str;
      if (!str.includes('oklch') && !str.includes('oklab') && !str.includes('lch') && !str.includes('lab') && !str.includes('color(')) {
        return str;
      }
      return str.replace(
        /oklch\([^)]+\)|oklab\([^)]+\)|lch\([^)]+\)|lab\([^)]+\)|color\([^)]+\)/gi,
        (match) => {
          try {
            if (!ctx) return match;
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = match;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return `rgba(${r},${g},${b},${a / 255})`;
          } catch {
            return match;
          }
        }
      );
    };

    const createStyleProxy = (origGetComputedStyle: typeof window.getComputedStyle, targetWindow: Window) => {
      return function(el: Element, pseudo?: string | null) {
        const cs = origGetComputedStyle.call(targetWindow, el, pseudo);
        return new Proxy(cs, {
          get(target: any, prop: string | symbol) {
            // Never allow letter-spacing on Arabic text (prevents html2canvas from splitting cursive Arabic letters)
            if (prop === 'letterSpacing') {
              if (el && el.textContent && /[\u0600-\u06FF]/.test(el.textContent)) {
                return '0px';
              }
            }
            if (prop === 'getPropertyValue') {
              return function(property: string) {
                if (property === 'letter-spacing' && el && el.textContent && /[\u0600-\u06FF]/.test(el.textContent)) {
                  return '0px';
                }
                const res = target.getPropertyValue(property);
                return typeof res === 'string' ? oklchToRgb(res) : res;
              };
            }
            const val = target[prop];
            if (typeof val === 'string') {
              return oklchToRgb(val);
            }
            if (typeof val === 'function') {
              return val.bind(target);
            }
            return val;
          }
        });
      };
    };

    const origWinGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = createStyleProxy(origWinGetComputedStyle, window);

    const userOnClone = options.onclone;

    try {
      return await html2canvas(element, {
        ...options,
        onclone: (clonedDoc: Document, el: HTMLElement) => {
          try {
            const clonedWin = clonedDoc.defaultView || window;
            clonedWin.getComputedStyle = createStyleProxy(clonedWin.getComputedStyle, clonedWin);
          } catch {}

          if (typeof userOnClone === 'function') {
            userOnClone(clonedDoc, el);
          }
        }
      });
    } finally {
      window.getComputedStyle = origWinGetComputedStyle;
    }
  };

  const handleDownloadInvoice = async (order: CustomerOrder) => {
    setPrintOrder(order);
    setTimeout(async () => {
      if (!printOrderRef.current) return;
      setIsDownloading(true);
      try {
        const canvas = await safeHtml2Canvas(printOrderRef.current, {
          scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false,
        });
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const imgWidth = pdf.internal.pageSize.getWidth();
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        pdf.save(`Invoice-${order.invoiceNumber || order.internalOrderNumber}.pdf`);
      } catch (e) {
        console.error("PDF Fail", e);
        alert("Failed to generate PDF. Check console for details.");
      } finally {
        setIsDownloading(false);
        setPrintOrder(null);
      }
    }, 600);
  };

  const getPrintTotal = () => {
    if (!printOrder) return 0;
    return printOrder.items.reduce((sum, item) => sum + (getItemEffectiveQty(item) * item.pricePerUnit), 0);
  };


  // Auto-trigger payment invoice PDF download when paymentInvoiceData is set
  React.useEffect(() => {
    if (!paymentInvoiceData) return;
    setIsDownloadingReceipt(true);
    const timer = setTimeout(async () => {
      const el = paymentInvoiceRef.current;
      if (!el) {
        console.warn('Payment invoice ref not found in DOM');
        setIsDownloadingReceipt(false);
        setPaymentInvoiceData(null);
        return;
      }
      try {
        const canvas = await safeHtml2Canvas(el, {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
        });
        const imgData = canvas.toDataURL('image/png');
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
        const safeOrderNum = (paymentInvoiceData.order?.internalOrderNumber || 'Order').replace(/[^\w-]/g, '_');
        const safeReceiptNum = (paymentInvoiceData.receiptNumber || 'Receipt').replace(/[^\w-]/g, '_');
        pdf.save(`Receipt-${safeOrderNum}-${safeReceiptNum}.pdf`);
      } catch (e) {
        console.error('Payment Invoice PDF failed:', e);
        alert("Failed to generate Receipt PDF. Check console for details.");
      } finally {
        setIsDownloadingReceipt(false);
        setPaymentInvoiceData(null);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [paymentInvoiceData]);

  const contractColumns: ColumnDef<any>[] = [
    {
      key: 'id',
      label: language === 'ar' ? 'رقم العقد' : 'Contract ID',
      sortable: true,
      sortValue: (c) => c.id,
      render: (c) => (
        <div>
          <span className="font-mono text-xs font-black text-teal-600 uppercase">{c.id}</span>
          <div className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">{c.description}</div>
        </div>
      )
    },
    {
      key: 'customerName',
      label: language === 'ar' ? 'اسم العميل' : 'Customer Name',
      sortable: true,
      sortValue: (c) => c.customerName,
      render: (c) => <span className="font-bold text-slate-800 text-sm">{c.customerName}</span>
    },
    {
      key: 'settlingOrders',
      label: language === 'ar' ? 'طلبات التسوية' : 'Settling Orders',
      sortable: true,
      sortValue: (c) => {
        const linked = orders.filter(o => o.blanketOrder && o.contractId === c.id && o.status !== OrderStatus.REJECTED);
        return linked.length;
      },
      render: (c) => {
        const linked = orders.filter(o => o.blanketOrder && o.contractId === c.id && o.status !== OrderStatus.REJECTED);
        return (
          <div className="space-y-1">
            {linked.length > 0 ? (
              <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded text-[9px] font-black uppercase inline-flex items-center gap-1">
                <i className="fa-solid fa-link"></i> {linked.length} {language === 'ar' ? (linked.length === 1 ? 'طلب إطاري' : 'طلبات إطارية') : `Blanket Order${linked.length > 1 ? 's' : ''}`}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 italic">
                {language === 'ar' ? 'لا توجد طلبات إطارية مرتبطة' : 'No linked blanket orders'}
              </span>
            )}
            {linked.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {linked.map(bo => (
                  <span key={bo.id} className="text-[9px] font-mono font-bold bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                    {bo.internalOrderNumber}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }
    },
    {
      key: 'receivedDate',
      label: language === 'ar' ? 'تاريخ العقد' : 'Contract Date',
      sortable: true,
      sortValue: (c) => c.receivedDate || c.createdAt || '',
      render: (c) => (
        <span className="text-xs font-bold text-slate-600">
          {new Date(c.receivedDate || c.createdAt || new Date()).toLocaleDateString()}
        </span>
      )
    },
    {
      key: 'actions',
      label: language === 'ar' ? 'الإجراء' : 'Action',
      sortable: false,
      render: (c) => {
        const linked = orders.filter(o => o.blanketOrder && o.contractId === c.id && ![OrderStatus.FULFILLED, OrderStatus.REJECTED].includes(o.status as OrderStatus));
        if (linked.length === 0) {
          return (
            <span className="text-[10px] text-slate-400 italic">
              {language === 'ar' ? 'لا توجد طلبات إطارية نشطة للتسوية' : 'No active blanket orders to settle'}
            </span>
          );
        }
        return (
          <div className="space-y-2">
            {linked.map(bo => (
              <div key={bo.id} className="flex items-center justify-between gap-3 bg-slate-50 p-2 rounded-xl border border-slate-100">
                <span className="font-mono text-[9px] font-black text-slate-600">{bo.internalOrderNumber}</span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => { setFinReqModal({ contract: bo }); setContractMsg(null); }}
                    className="px-2.5 py-1.5 bg-slate-900 hover:bg-black text-white rounded-lg text-[9px] font-black uppercase flex items-center gap-1 transition-all"
                    title={language === 'ar' ? 'تسجيل طلب مالي لهذا العقد الإطاري' : 'Log a Financial Request for this blanket contract'}
                  >
                    <i className="fa-solid fa-file-invoice-dollar"></i> {language === 'ar' ? 'طلب مالي' : 'Request'}
                  </button>
                  <button
                    onClick={() => { setSettleModal({ contract: bo }); setContractMsg(null); setSettleOrderId(''); }}
                    className="px-2.5 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[9px] font-black uppercase flex items-center gap-1 transition-all"
                    title={language === 'ar' ? 'تسوية هذا العقد الإطاري مقابل طلب تسوية' : 'Settle this blanket contract against a settling order'}
                  >
                    <i className="fa-solid fa-scale-balanced"></i> {language === 'ar' ? 'تسوية' : 'Settle'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      }
    }
  ];

  const sortedAndFilteredContracts = useMemo(() => {
    let result = [...contracts].sort((a, b) => {
      const da = new Date(a.receivedDate || a.createdAt || 0).getTime();
      const db = new Date(b.receivedDate || b.createdAt || 0).getTime();
      return da - db;
    });

    if (contractSearch.trim()) {
      const q = contractSearch.toLowerCase().trim();
      result = result.filter(c => {
        const linked = orders.filter(o => o.blanketOrder && o.contractId === c.id && o.status !== OrderStatus.REJECTED);
        const linkedMatch = linked.some(bo => 
          bo.internalOrderNumber?.toLowerCase().includes(q) ||
          bo.customerReferenceNumber?.toLowerCase().includes(q)
        );
        const dateStr = new Date(c.receivedDate || c.createdAt || '').toLocaleDateString();
        return (
          c.id.toLowerCase().includes(q) ||
          c.customerName.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q) ||
          (c.targetLineItems || '').toLowerCase().includes(q) ||
          dateStr.includes(q) ||
          linkedMatch
        );
      });
    }

    return result;
  }, [contracts, contractSearch, orders]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
        {/* Hidden Full Invoice Template */}
        <div className="fixed -left-[3000px] top-0 overflow-visible">
          {printOrder && (
            <div ref={printOrderRef} className="p-12" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'normal', direction: 'ltr', backgroundColor: '#ffffff', color: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '40px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {rasterizedLogo && (
                    <div style={{ height: '64px', display: 'flex', alignItems: 'flex-start' }}>
                      <img src={rasterizedLogo} alt="Company Logo" style={{ maxHeight: '100%', maxWidth: '200px', objectFit: 'contain' }} />
                    </div>
                  )}
                  <div style={{ direction: 'rtl', textAlign: 'right', alignSelf: 'flex-start' }}>
                    <div style={{ fontSize: '20px', fontWeight: 900, color: '#0f172a' }}>{config.settings.companyName || 'Nexus ERP'}</div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569', whiteSpace: 'pre-line', lineHeight: '1.6' }}>{config.settings.companyAddress || 'Cairo, Egypt'}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                </div>
              </div>
              <div className="border-t-2 border-b-2 py-3 mb-8 flex justify-center items-center" style={{ borderColor: '#e2e8f0' }}>
                <h2 className="text-xl font-black uppercase flex items-center gap-6" style={{ color: '#0f172a' }}><span>TAX INVOICE / فاتورة ضريبية</span></h2>
              </div>
              <div className="grid grid-cols-2 gap-8 mb-10">
                <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-3">
                    <div className="col-span-1 p-3 border-r-2 font-bold text-xs text-end" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a' }}>Customer:</div>
                    <div className="col-span-2 p-3 font-black text-sm uppercase" style={{ color: '#0f172a' }}>{printOrder.customerName}</div>
                  </div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-1 p-3 border-r-2 font-bold text-xs text-end" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a' }}>Invoice No:</div>
                    <div className="col-span-2 p-3 font-mono font-black text-xs" style={{ color: '#2563eb' }}>{printOrder.invoiceNumber || 'DRAFT'}</div>
                  </div>
                </div>
                <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-3">
                    <div className="col-span-2 p-3 font-black text-sm text-center tracking-widest" style={{ color: '#0f172a' }}>{new Date().toLocaleDateString()}</div>
                    <div className="col-span-1 p-3 border-l-2 font-bold text-xs" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a' }}>Date:</div>
                  </div>
                  <div className="p-3 text-center font-bold text-[10px]" style={{ backgroundColor: '#f8fafc', color: '#0f172a' }}>Tax Authority - Cairo</div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest" style={{ color: '#0f172a' }}>522 803 435</div>
                    <div className="col-span-1 p-3 border-l-2 font-bold text-[9px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a' }}>Tax ID:</div>
                  </div>
                </div>
              </div>
              <div className="border-2 mb-10 min-h-[400px] flex flex-col" style={{ borderColor: '#0f172a' }}>
                <div className="grid grid-cols-12 border-b-2 text-[11px] font-black uppercase text-center" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a' }}>
                  <div className="col-span-6 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>{t("finance.billing.description") || "Description"}</div>
                  <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>{t("common.price") || "Price"}</div>
                  <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>{t("finance.billing.qty") || "Qty"}</div>
                  <div className="col-span-2 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>{t("finance.billing.taxPercent") || "Tax %"}</div>
                  <div className="col-span-2 p-3">Total</div>
                </div>
                {printOrder.items.map(item => (
                  <div key={item.id} className="grid grid-cols-12 border-b-2 text-center font-black text-sm" style={{ borderColor: '#0f172a', color: '#0f172a' }}>
                    <div className="col-span-6 p-4 border-r-2 text-start" style={{ borderColor: '#0f172a' }}>{item.description}</div>
                    <div className="col-span-1 p-4 border-r-2" style={{ borderColor: '#0f172a' }}>{item.pricePerUnit.toLocaleString()}</div>
                    <div className="col-span-1 p-4 border-r-2" style={{ borderColor: '#0f172a' }}>{getItemEffectiveQty(item)}</div>
                    <div className="col-span-2 p-4 border-r-2" style={{ borderColor: '#0f172a' }}>{item.taxPercent}%</div>
                    <div className="col-span-2 p-4">{((getItemEffectiveQty(item) * item.pricePerUnit) * (1 + item.taxPercent / 100)).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <div className="w-64 border-2 divide-y-2 font-black" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-2" style={{ backgroundColor: '#f1f5f9' }}>
                    <div className="p-3 border-r-2 text-sm uppercase" style={{ borderColor: '#0f172a', color: '#0f172a' }}>GRAND TOTAL</div>
                    <div className="p-3 text-end text-xl" style={{ color: '#0f172a' }}>{getPrintTotal().toLocaleString()} {getOrderCurrency(printOrder)}</div>
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
          // Calculate gross total
          let grossTotal = 0;
          pOrder.items.forEach((it: any) => grossTotal += (getItemEffectiveQty(it) * it.pricePerUnit * (1 + (it.taxPercent / 100))));
          const totalPaidBefore = prevPay.reduce((s: number, p: any) => s + p.amount, 0);
          const totalPaidOverall = totalPaidBefore + pAmt;
          const remainingBalance = Math.max(0, grossTotal - totalPaidOverall);
          const pCurrency = getOrderCurrency(pOrder);
          const isCustomerArabic = /[\u0600-\u06FF]/.test(pOrder.customerName || '');

          return (
            <div ref={paymentInvoiceRef} className="p-10" style={{ width: '800px', minHeight: '750px', fontVariantLigatures: 'normal', direction: 'ltr', backgroundColor: '#ffffff', color: '#0f172a', fontFamily: "'Segoe UI', Tahoma, Arial, sans-serif" }}>
              {/* Header: Left = Logo & Company Info, Right = Receipt Title Badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  {rasterizedLogo && (
                    <div style={{ height: '64px', display: 'flex', alignItems: 'flex-start' }}>
                      <img src={rasterizedLogo} alt="Company Logo" style={{ maxHeight: '100%', maxWidth: '200px', objectFit: 'contain' }} />
                    </div>
                  )}
                  <div style={{ direction: 'ltr', textAlign: 'left', alignSelf: 'flex-start' }}>
                    <div style={{ fontSize: '20px', fontWeight: 900, color: '#0f172a', letterSpacing: 0 }}>{config.settings.companyName || 'Nexus ERP'}</div>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569', whiteSpace: 'pre-line', lineHeight: '1.6', letterSpacing: 0 }}>{config.settings.companyAddress || 'Cairo, Egypt'}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="border-2 px-4 py-2.5 rounded-xl flex items-center justify-center" style={{ borderColor: isFinal ? '#34d399' : '#60a5fa', backgroundColor: isFinal ? '#ecfdf5' : '#eff6ff' }}>
                    <h2 className="text-sm font-black flex items-center gap-2" style={{ color: isFinal ? '#065f46' : '#1e40af' }}>
                      <span style={{ letterSpacing: '0.5px' }}>{isFinal ? 'FINAL PAYMENT RECEIPT' : 'PARTIAL PAYMENT RECEIPT'}</span>
                      <span style={{ color: isFinal ? '#6ee7b7' : '#93c5fd', margin: '0 4px' }}>/</span>
                      <span style={{ letterSpacing: 0 }}>{isFinal ? 'إيصال سداد نهائي' : 'إيصال سداد جزئي'}</span>
                    </h2>
                  </div>
                </div>
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-8 mb-6">
                <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-3">
                    <div className="col-span-1 p-2.5 border-r-2 font-bold text-xs text-end" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Customer:</div>
                    <div className="col-span-2 p-2.5 font-black text-sm uppercase" style={{ color: '#0f172a' }}>
                      {pOrder.customerName}
                    </div>
                  </div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-1 p-2.5 border-r-2 font-bold text-xs text-end" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Invoice No:</div>
                    <div className="col-span-2 p-2.5 font-mono font-black text-xs" style={{ color: '#2563eb' }}>{pOrder.invoiceNumber || 'N/A'}</div>
                  </div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-1 p-2.5 border-r-2 font-bold text-xs text-end" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Receipt No:</div>
                    <div className="col-span-2 p-2.5 font-mono font-black text-xs" style={{ color: '#059669' }}>{pReceipt}</div>
                  </div>
                </div>
                <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-3">
                    <div className="col-span-2 p-2.5 font-black text-sm text-center" style={{ color: '#0f172a', letterSpacing: 0 }}>{new Date().toLocaleDateString()}</div>
                    <div className="col-span-1 p-2.5 border-l-2 font-bold text-xs" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Date:</div>
                  </div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-2 p-2.5 font-mono font-black text-xs text-center" style={{ color: '#0f172a' }}>{pOrder.internalOrderNumber}</div>
                    <div className="col-span-1 p-2.5 border-l-2 font-bold text-[9px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Order Ref:</div>
                  </div>
                  <div className="grid grid-cols-3">
                    <div className="col-span-2 p-2.5 font-mono font-black text-xs text-center" style={{ color: '#0f172a', letterSpacing: '0.5px' }}>522 803 435</div>
                    <div className="col-span-1 p-2.5 border-l-2 font-bold text-[9px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#0f172a', letterSpacing: 0 }}>Tax ID:</div>
                  </div>
                </div>
              </div>

              {/* Payment Announcement Statement: Side-by-Side English & Arabic */}
              <div className="p-5 rounded-2xl mb-6 border-2" style={{ backgroundColor: isFinal ? '#f0fdf4' : '#f0f9ff', borderColor: isFinal ? '#86efac' : '#bae6fd' }}>
                <div className="grid grid-cols-2 gap-6 divide-x" style={{ borderColor: isFinal ? '#bbf7d0' : '#bae6fd' }}>
                  {/* English Column (Left) */}
                  <div style={{ direction: 'ltr', textAlign: 'left' }} className="pr-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px]" style={{ backgroundColor: isFinal ? '#16a34a' : '#0284c7', color: '#ffffff' }}>✓</div>
                      <span className="text-xs font-black uppercase" style={{ color: isFinal ? '#14532d' : '#0c4a6e' }}>Official Payment Statement</span>
                    </div>
                    <div className="text-xs font-bold text-slate-800 leading-relaxed">
                      Received with thanks from <span className="font-black text-slate-900 underline" style={{ textDecorationColor: isFinal ? '#86efac' : '#7dd3fc', direction: isCustomerArabic ? 'rtl' : 'ltr', display: 'inline-block' }}>{pOrder.customerName}</span> the amount of <span className="font-black" style={{ color: isFinal ? '#15803d' : '#0369a1' }}>{pAmt.toLocaleString(undefined, { minimumFractionDigits: 2 })} {pCurrency}</span> as payment for Order Ref: <span className="font-mono font-black text-slate-900">{pOrder.internalOrderNumber}</span>.
                    </div>
                  </div>
                  {/* Arabic Column (Right) */}
                  <div dir="rtl" style={{ textAlign: 'right', letterSpacing: 0 }} className="pl-5">
                    <div className="flex items-center gap-2 mb-2 justify-start">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px]" style={{ backgroundColor: isFinal ? '#16a34a' : '#0284c7', color: '#ffffff' }}>✓</div>
                      <span className="text-xs font-black" style={{ color: isFinal ? '#14532d' : '#0c4a6e', letterSpacing: 0 }}>إشعار استلام سداد معتمد</span>
                    </div>
                    <div className="text-xs font-bold text-slate-800 leading-relaxed space-y-1" style={{ letterSpacing: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: '8px' }}>
                        <span style={{ color: isFinal ? '#15803d' : '#0369a1', whiteSpace: 'nowrap', letterSpacing: 0 }}>وصلنا من السادة:</span>
                        <span
                          dir={isCustomerArabic ? 'rtl' : 'ltr'}
                          className="font-black text-slate-900"
                          style={{ display: 'inline-block', direction: isCustomerArabic ? 'rtl' : 'ltr' }}
                        >
                          {pOrder.customerName}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: '8px' }}>
                        <span style={{ color: isFinal ? '#15803d' : '#0369a1', whiteSpace: 'nowrap', letterSpacing: 0 }}>سداداً لأمر البيع:</span>
                        <span className="font-mono font-black text-slate-900" style={{ direction: 'ltr' }}>{pOrder.internalOrderNumber}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-start', gap: '8px' }}>
                        <span style={{ color: isFinal ? '#15803d' : '#0369a1', whiteSpace: 'nowrap', letterSpacing: 0 }}>مبلغ وقدره:</span>
                        <span className="font-black" style={{ color: isFinal ? '#15803d' : '#0369a1', direction: 'ltr' }}>{pAmt.toLocaleString(undefined, { minimumFractionDigits: 2 })} {pCurrency}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Financial Status Summary: Order Value, Total Paid, Remaining Left */}
              <div className="border-2 rounded-2xl overflow-hidden mb-6" style={{ borderColor: '#0f172a' }}>
                <div className="grid grid-cols-3 divide-x-2 text-center" style={{ borderColor: '#0f172a' }}>
                  {/* Order Value */}
                  <div className="p-4" style={{ backgroundColor: '#f8fafc' }}>
                    <div className="text-[10px] font-black uppercase text-slate-500 mb-1" style={{ letterSpacing: '0.5px' }}>
                      ORDER VALUE (INCL. TAXES)
                    </div>
                    <div className="text-[11px] font-bold text-slate-500 mb-1.5" style={{ letterSpacing: 0 }}>إجمالي قيمة الطلب شامل الضريبة</div>
                    <div className="text-xl font-black" style={{ color: '#0f172a' }}>
                      {grossTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs font-bold text-slate-500">{pCurrency}</span>
                    </div>
                  </div>

                  {/* Total Paid Overall */}
                  <div className="p-4" style={{ backgroundColor: '#f8fafc' }}>
                    <div className="text-[10px] font-black uppercase text-slate-500 mb-1" style={{ letterSpacing: '0.5px' }}>
                      TOTAL PAID TO DATE
                    </div>
                    <div className="text-[11px] font-bold text-slate-500 mb-1.5" style={{ letterSpacing: 0 }}>إجمالي المسدد حتى تاريخه</div>
                    <div className="text-xl font-black text-emerald-700">
                      {totalPaidOverall.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs font-bold text-slate-500">{pCurrency}</span>
                    </div>
                    {totalPaidBefore > 0 && (
                      <div className="text-[9px] font-bold text-slate-500 mt-0.5">
                        (Previous: {totalPaidBefore.toLocaleString()} + Current: {pAmt.toLocaleString()})
                      </div>
                    )}
                  </div>

                  {/* Left / Remaining */}
                  <div className="p-4" style={{ backgroundColor: isFinal || remainingBalance <= 0 ? '#ecfdf5' : '#fff7ed' }}>
                    <div className="text-[10px] font-black uppercase mb-1" style={{ color: isFinal || remainingBalance <= 0 ? '#065f46' : '#9a3412', letterSpacing: '0.5px' }}>
                      REMAINING BALANCE (LEFT)
                    </div>
                    <div className="text-[11px] font-bold mb-1.5" style={{ color: isFinal || remainingBalance <= 0 ? '#059669' : '#c2410c', letterSpacing: 0 }}>
                      المبلغ المتبقي
                    </div>
                    <div className="text-xl font-black" style={{ color: isFinal || remainingBalance <= 0 ? '#059669' : '#ea580c' }}>
                      {isFinal || remainingBalance <= 0 ? '0.00' : remainingBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs font-bold text-slate-500">{pCurrency}</span>
                    </div>
                    {isFinal || remainingBalance <= 0 ? (
                      <div className="text-[9px] font-black uppercase text-emerald-700 mt-0.5" style={{ letterSpacing: 0 }}>✓ FULLY SETTLED / مسدد بالكامل</div>
                    ) : (
                      <div className="text-[9px] font-bold text-amber-700 mt-0.5">Pending Balance</div>
                    )}
                  </div>
                </div>

                {/* Highlighted Current Payment Bar */}
                <div className="flex justify-between items-center px-6 py-3.5 border-t-2" style={{ borderColor: '#0f172a', backgroundColor: isFinal ? '#dcfce7' : '#e0f2fe' }}>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-black uppercase" style={{ color: isFinal ? '#166534' : '#075985' }}>
                      <span style={{ letterSpacing: '0.5px' }}>THIS RECEIPT AMOUNT</span>
                      <span style={{ color: isFinal ? '#86efac' : '#93c5fd', margin: '0 4px' }}>/</span>
                      <span style={{ letterSpacing: 0 }}>قيمة هذا الإيصال</span>
                    </span>
                    <span className="font-mono text-xs font-bold text-slate-600">({pReceipt})</span>
                  </div>
                  <div className="text-2xl font-black" style={{ color: isFinal ? '#15803d' : '#0369a1' }}>
                    {pAmt.toLocaleString(undefined, { minimumFractionDigits: 2 })} {pCurrency}
                  </div>
                </div>
              </div>

              {/* Payment History (if any) */}
              {prevPay.length > 0 && (
                <div className="border-t-2 pt-4 mb-4" style={{ borderColor: '#e2e8f0' }}>
                  <div className="text-xs font-black uppercase mb-2" style={{ color: '#94a3b8', letterSpacing: '0.5px' }}>Previous Payments on this Order</div>
                  <div className="border rounded-xl overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
                    {prevPay.map((p: any, idx: number) => (
                      <div key={idx} className="flex justify-between px-4 py-2 text-xs font-bold border-b last:border-0" style={{ borderColor: '#f1f5f9' }}>
                        <span style={{ color: '#64748b' }}>{p.receiptNumber || `#${idx + 1}`} — {new Date(p.date).toLocaleDateString()}</span>
                        <span style={{ color: '#1e293b' }}>{p.amount.toLocaleString()} {pCurrency}</span>
                      </div>
                    ))}
                    <div className="flex justify-between px-4 py-2 text-xs font-black border-t" style={{ backgroundColor: '#f8fafc', borderColor: '#e2e8f0', color: '#0f172a' }}>
                      <span>{t("finance.orders.totalPreviouslyPaid") || "Total Previously Paid"}</span>
                      <span>{totalPaidBefore.toLocaleString()} {pCurrency}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Signatures & Stamp */}
              <div className="grid grid-cols-2 gap-12 mt-10 pt-6 border-t-2" style={{ borderColor: '#e2e8f0' }}>
                <div className="text-center space-y-10">
                  <div className="text-xs font-black uppercase" style={{ color: '#64748b' }}>
                    <span style={{ letterSpacing: '0.5px' }}>Accountant</span>
                    <span style={{ margin: '0 4px', color: '#94a3b8' }}>/</span>
                    <span style={{ letterSpacing: 0 }}>المحاسب المسؤول</span>
                  </div>
                  <div className="border-b-2 w-48 mx-auto" style={{ borderColor: '#94a3b8' }}></div>
                </div>
                <div className="text-center space-y-10">
                  <div className="text-xs font-black uppercase" style={{ color: '#64748b' }}>
                    <span style={{ letterSpacing: '0.5px' }}>Authorized Signature & Stamp</span>
                    <span style={{ margin: '0 4px', color: '#94a3b8' }}>/</span>
                    <span style={{ letterSpacing: 0 }}>الاعتماد والختم</span>
                  </div>
                  <div className="border-b-2 w-48 mx-auto" style={{ borderColor: '#94a3b8' }}></div>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-6 w-full">
        <div className="flex flex-col md:flex-row items-start md:items-center gap-4 w-full xl:w-auto overflow-hidden">
          <LanguageToggle />
          <div className="flex gap-1 p-1 bg-slate-200 rounded-2xl w-full shadow-inner overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          {(['orders', 'stock_orders', 'history', 'blacklist_hold', 'tax_clearances', 'supplier_reporting', 'ledger', 'contracts', 'blanket_history', 'customer_wallets', 'project_wallets'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 rounded-xl text-[10px] whitespace-nowrap font-black uppercase tracking-widest transition-all shrink-0 ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              {t(`finance.tabs.${tab}`) !== `finance.tabs.${tab}` ? t(`finance.tabs.${tab}`) :
               tab.replace(/([A-Z_])/g, ' $1').replace('_', ' ')}
            </button>
          ))}
          </div>
        </div>
        {activeTab === 'tax_clearances' ? null : activeTab === 'history' ? (
          <div className="relative w-full xl:w-96">
            <input
              type="text" placeholder={t("finance.history.searchHistory") || (language === 'ar' ? 'بحث في سجل المعاملات...' : "Search transaction history...")}
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={historySearch} onChange={e => setHistorySearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
          </div>
        ) : activeTab === 'ledger' ? (
          <div className="w-full xl:w-96">
            <div className="relative">
              <input
                type="text" placeholder={t("finance.history.searchHistory") || (language === 'ar' ? 'بحث في دفتر الأستاذ...' : "Search ledger...")}
                className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
                value={search} onChange={e => setSearch(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
            </div>
            <div className="text-xs text-slate-500 mt-1 px-1">
              {language === 'ar' ? 'ابحث في الأوصاف، أسماء الحسابات، المجموعات، المبالغ، التواريخ، وتفاصيل المعاملات' : 'Search through descriptions, account names, groups, amounts, dates, and transaction details'}
            </div>
          </div>
        ) : activeTab === 'blanket_history' ? (
          <div className="relative w-full xl:w-96">
            <input
              type="text" placeholder={language === 'ar' ? 'ابحث في الطلبات الإطارية، العقود، المشاريع...' : "Search blanket orders, contracts, projects..."}
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={blanketHistorySearch} onChange={e => setBlanketHistorySearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
          </div>
        ) : activeTab === 'customer_wallets' ? (
          <div className="relative w-full xl:w-96">
            <input
              type="text" placeholder={language === 'ar' ? 'ابحث باسم العميل، المشروع، البريد...' : "Search customer, project name, email..."}
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={customerWalletSearch} onChange={e => setCustomerWalletSearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
          </div>
        ) : activeTab === 'project_wallets' ? (
          <div className="relative w-full xl:w-96">
            <input
              type="text" placeholder={language === 'ar' ? 'ابحث باسم المشروع، العميل، رقم الطلب...' : "Search project name, customer, order #..."}
              className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
              value={projectWalletSearch} onChange={e => setProjectWalletSearch(e.target.value)}
            />
            <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
          </div>
        ) : (
          <div className="flex items-center gap-3 w-full xl:w-auto">
            {activeTab === 'orders' && filteredOrders.length > 0 && (
              <button
                onClick={handleToggleExpandAll}
                className="px-3.5 py-3 bg-white border-2 border-slate-100 rounded-2xl text-[10px] font-black uppercase text-slate-600 hover:text-blue-600 hover:border-blue-200 transition-all shadow-sm flex items-center gap-2 shrink-0"
                title={filteredOrders.every(o => expandedOrderIds[o.id]) ? (language === 'ar' ? 'طي جميع البنود' : 'Collapse All Items') : (language === 'ar' ? 'توسيع جميع البنود' : 'Expand All Items')}
              >
                <i className={`fa-solid ${filteredOrders.every(o => expandedOrderIds[o.id]) ? 'fa-compress' : 'fa-expand'} text-xs`}></i>
                <span>{filteredOrders.every(o => expandedOrderIds[o.id]) ? (language === 'ar' ? 'طي الكل' : 'Collapse All') : (language === 'ar' ? 'توسيع الكل' : 'Expand All')}</span>
              </button>
            )}
            <div className="relative w-full xl:w-96">
              <input
                type="text" placeholder={activeTab === 'stock_orders' ? (language === 'ar' ? 'ابحث بأمر المخزون، كود المكون، الوصف...' : "Search stock PO, component SKU, description...") : (language === 'ar' ? 'ابحث بالرقم، أمر الشراء، العميل، المشروع...' : (t("finance.orders.searchOrders") || "Search ID, PO, customer, project (or 'non-project')..."))}
                className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
                value={search} onChange={e => setSearch(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
            </div>
          </div>
        )}
      </div>

      {activeTab === 'ledger' && (
        <GeneralLedgerView
          entries={ledgerEntries}
          orders={orders}
          customers={customers}
          suppliers={suppliers}
          supplierPayments={supplierPayments}
          onRefresh={fetchData}
          currentUser={currentUser}
          searchQuery={search}
          ledgerAccounts={config.settings.ledgerAccounts || []}
          config={config}
        />
      )}

      {/* Blanket Contracts Tab — SAP/Oracle-style framework agreements */}
      {activeTab === 'contracts' && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
          <div className="px-8 pt-8 pb-4 flex items-center justify-between flex-wrap gap-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-teal-100 text-teal-700 flex items-center justify-center">
                <i className="fa-solid fa-file-contract text-xl"></i>
              </div>
              <div>
                <div className="font-black text-slate-800 uppercase tracking-widest text-lg">
                  {language === 'ar' ? 'العقود الإطارية' : 'Blanket Contracts'}
                </div>
                <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">
                  {language === 'ar' ? 'اتفاقيات إطارية — ترتبط طلبات التسوية برقم العقد' : 'Framework agreements — settling orders link to the contract ID'}
                </div>
              </div>
            </div>
            {/* Search Input Box */}
            <div className="relative w-full md:w-80">
              <input
                type="text"
                className="w-full pl-10 pr-4 py-2 border-2 border-slate-100 rounded-xl bg-slate-50 text-xs font-bold outline-none focus:bg-white focus:border-teal-500 transition-all shadow-inner"
                placeholder={language === 'ar' ? 'ابحث برقم العقد، العميل، إلخ...' : "Search contract ID, customer, etc..."}
                value={contractSearch}
                onChange={e => setContractSearch(e.target.value)}
              />
              <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-400 text-xs"></i>
            </div>
          </div>
          {contractMsg && (
            <div className="mx-8 mt-4 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3">
              <i className="fa-solid fa-circle-exclamation"></i>{contractMsg}
            </div>
          )}
          <div className="overflow-x-auto">
            <SortableTable
              columns={contractColumns}
              data={sortedAndFilteredContracts}
              rowKey={(c) => c.id}
              emptyMessage={language === 'ar' ? 'لم يتم العثور على عقود إطارية نشطة' : "No active blanket contracts found"}
              storageKey="finance-contracts-table"
            />
          </div>
        </div>
      )}

      {/* Blanket History Tab — blanket orders grouped by month, with each order's latest cost sheet */}
      {activeTab === 'blanket_history' && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
          <div className="px-8 pt-8 pb-4 flex items-center gap-3 border-b border-slate-100">
            <div className="w-12 h-12 rounded-2xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
              <i className="fa-solid fa-calendar-days text-xl"></i>
            </div>
            <div>
              <div className="font-black text-slate-800 uppercase tracking-widest text-lg">{t('finance.blanketHistory.title') || 'Blanket Orders History'}</div>
              <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">{t('finance.blanketHistory.subtitle') || "Blanket orders grouped by month, with each order's latest cost sheet"}</div>
            </div>
          </div>

          <div className="p-8 space-y-8">
            {blanketOrdersByMonth.length === 0 && (
              <div className="text-center py-16">
                <i className="fa-solid fa-calendar-xmark text-4xl block mb-3 text-slate-200"></i>
                <div className="text-slate-400 font-bold text-sm uppercase tracking-widest">{t('finance.blanketHistory.noOrders') || 'No blanket orders found'}</div>
              </div>
            )}
            {blanketOrdersByMonth.map(group => (
              <div key={group.key} className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="text-sm font-black text-slate-800 uppercase tracking-widest">{group.label}</div>
                  <div className="h-px flex-1 bg-slate-100"></div>
                  <span className="text-[9px] font-black uppercase text-slate-400 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200 whitespace-nowrap">
                    {group.orders.length === 1
                      ? (t('finance.blanketHistory.orderCountSingular') || '1 order')
                      : (t('finance.blanketHistory.ordersCount', { count: String(group.orders.length) }) || `${group.orders.length} orders`)}
                  </span>
                </div>
                <div className="overflow-x-auto rounded-2xl border border-slate-200">
                  <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                    <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                      <tr>
                        <th className="px-5 py-3">{t('finance.blanketHistory.order') || 'Order'}</th>
                        <th className="px-5 py-3">{t('finance.blanketHistory.customer') || 'Customer'}</th>
                        <th className="px-5 py-3">{t('finance.blanketHistory.contract') || 'Contract'}</th>
                        <th className="px-5 py-3">{t('finance.blanketHistory.status') || 'Status'}</th>
                        <th className="px-5 py-3 text-end">{t('finance.blanketHistory.costSheet') || 'Cost Sheet'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {group.orders.map(o => {
                        const sheet = getBlanketOrderLatestCostSheet(o);
                        const proj = getOrderProjectName(o);
                        const contractRef = o.contractId || o.blanketContractId;
                        return (
                          <tr key={o.id} className="hover:bg-slate-50/70 transition-colors">
                            <td className="px-5 py-3">
                              <div className="font-mono text-xs font-black text-blue-600">{o.internalOrderNumber}</div>
                              {o.customerReferenceNumber && (
                                <div className="text-[9px] text-slate-400 font-bold mt-0.5">PO: {o.customerReferenceNumber}</div>
                              )}
                              {proj && (
                                <div className="text-[9px] text-violet-600 font-bold mt-0.5 inline-flex items-center gap-1">
                                  <i className="fa-solid fa-diagram-project"></i>{proj}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-3"><span className="font-bold text-slate-700 text-sm">{o.customerName}</span></td>
                            <td className="px-5 py-3">
                              {contractRef ? (
                                <span className="font-mono text-[10px] font-black text-teal-600 uppercase">{contractRef}</span>
                              ) : (
                                <span className="text-[10px] text-slate-300 italic">—</span>
                              )}
                            </td>
                            <td className="px-5 py-3">
                              <span className="px-2 py-1 rounded-lg text-[9px] font-black uppercase bg-slate-100 text-slate-600 border border-slate-200 whitespace-nowrap">
                                {o.status}
                              </span>
                            </td>
                            <td className="px-5 py-3 text-end">
                              {sheet ? (
                                <button
                                  onClick={() => downloadCostSheetFile(sheet.fileData, sheet.fileName)}
                                  className="px-3 py-1.5 rounded-lg text-[9px] font-black uppercase bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all inline-flex items-center gap-1.5 whitespace-nowrap"
                                  title={sheet.uploadedAt ? `Uploaded ${new Date(sheet.uploadedAt).toLocaleDateString()}` : 'Download the latest cost sheet on file'}
                                >
                                  <i className="fa-solid fa-file-excel"></i>
                                  {t('finance.blanketHistory.downloadCostSheet') || 'Download Cost Sheet'}
                                </button>
                              ) : (
                                <span className="text-[10px] text-slate-300 italic">{t('finance.blanketHistory.noCostSheet') || 'No cost sheet'}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer Wallets Tab — wallet balances moved from CRM to Finance Operations */}
      {activeTab === 'customer_wallets' && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh] space-y-6">
          <div className="px-8 pt-8 pb-4 flex items-center justify-between gap-4 flex-wrap border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center text-xl shadow-inner">
                <i className="fa-solid fa-wallet"></i>
              </div>
              <div>
                <div className="font-black text-slate-800 uppercase tracking-widest text-lg">
                  {language === 'ar' ? 'حسابات ومحافظ العملاء' : 'Customer Accounts & Wallets'}
                </div>
                <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">
                  {language === 'ar' ? 'مستحقات العملاء، الدفعات المقدمة، الربحية وتسويات العقود الإطارية' : 'Enterprise Customer AR, Advances, Profitability & Blanket Settlements'}
                </div>
              </div>
            </div>

            {/* Sub-view toggles */}
            <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
              <button
                type="button"
                onClick={() => setCustomerViewMode('all_accounts')}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-1.5 cursor-pointer ${
                  customerViewMode === 'all_accounts' ? 'bg-white text-emerald-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <i className="fa-solid fa-building-columns text-xs"></i>
                <span>{language === 'ar' ? 'جميع حسابات العملاء' : 'All Customer Accounts'}</span>
              </button>
              <button
                type="button"
                onClick={() => setCustomerViewMode('blanket_settlements')}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-1.5 cursor-pointer ${
                  customerViewMode === 'blanket_settlements' ? 'bg-white text-emerald-700 shadow-xs' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <i className="fa-solid fa-handshake text-xs"></i>
                <span>{language === 'ar' ? 'تسويات العقود الإطارية' : 'Blanket Settlements'}</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('project_wallets')}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase transition-all text-slate-500 hover:text-slate-800 flex items-center gap-1.5 cursor-pointer"
              >
                <i className="fa-solid fa-diagram-project text-xs"></i>
                <span>{language === 'ar' ? 'حسب المشروع' : 'By Project'}</span>
              </button>
            </div>
          </div>

          {/* ALL CUSTOMER ACCOUNTS VIEW */}
          {customerViewMode === 'all_accounts' && (
            <div className="px-8 pb-8 space-y-6">
              {/* 6 Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-slate-400 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-users text-slate-500"></i> {language === 'ar' ? 'العملاء النشطون' : 'Active Customers'}
                  </div>
                  <div className="text-xl font-black text-slate-800 font-mono">
                    {customerAnalytics.length}
                  </div>
                  <div className="text-[8px] font-bold text-slate-400 mt-1 uppercase">
                    {language === 'ar' ? 'باستثناء المخزون الداخلي' : 'Excl. Internal Stock'}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-blue-50 border border-blue-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-blue-700 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-file-invoice text-blue-600"></i> {language === 'ar' ? 'المبيعات المفوترة' : 'Invoiced Sales'}
                  </div>
                  <div className="text-xl font-black text-blue-900 font-mono">
                    {customerAnalytics.reduce((s, c) => s + c.totalInvoicedGross, 0).toLocaleString()}
                  </div>
                  <div className="text-[8px] font-bold text-blue-600 mt-1 uppercase">
                    {language === 'ar' ? `صافي: ${customerAnalytics.reduce((s, c) => s + c.totalInvoicedNet, 0).toLocaleString()} ج.م` : `Net: ${customerAnalytics.reduce((s, c) => s + c.totalInvoicedNet, 0).toLocaleString()} L.E.`}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-emerald-700 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-money-bill-wave text-emerald-600"></i> {language === 'ar' ? 'التحصيلات النقدية' : 'Cash Collections'}
                  </div>
                  <div className="text-xl font-black text-emerald-900 font-mono">
                    {customerAnalytics.reduce((s, c) => s + c.totalPaid, 0).toLocaleString()}
                  </div>
                  <div className="text-[8px] font-bold text-emerald-600 mt-1 uppercase">
                    {language === 'ar' ? 'المحصل حتى تاريخه (ج.م)' : 'Paid to Date (L.E.)'}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-rose-700 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-circle-exclamation text-rose-600"></i> {language === 'ar' ? 'مستحقات العملاء (AR)' : 'Customer AR (Due)'}
                  </div>
                  <div className="text-xl font-black text-rose-900 font-mono">
                    {customerAnalytics.reduce((s, c) => s + c.totalAR, 0).toLocaleString()}
                  </div>
                  <div className="text-[8px] font-bold text-rose-600 mt-1 uppercase">
                    {language === 'ar' ? 'فواتير قيد السداد' : 'Outstanding Invoices'}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-teal-50 border border-teal-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-teal-700 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-wallet text-teal-600"></i> {language === 'ar' ? 'الدفعات المقدمة والمحافظ' : 'Advances / Wallets'}
                  </div>
                  <div className="text-xl font-black text-teal-900 font-mono">
                    {customerAnalytics.reduce((s, c) => s + c.combinedWalletBalance, 0).toLocaleString()}
                  </div>
                  <div className="text-[8px] font-bold text-teal-600 mt-1 uppercase">
                    {language === 'ar' ? 'دفعات مقدمة محتجزة' : 'Prepayments Held'}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-indigo-50 border border-indigo-200">
                  <div className="text-[9px] font-black uppercase tracking-wider text-indigo-700 mb-1 flex items-center gap-1.5">
                    <i className="fa-solid fa-chart-line text-indigo-600"></i> {language === 'ar' ? 'الأرباح المحققة' : 'Realized Profit'}
                  </div>
                  <div className="text-xl font-black text-indigo-900 font-mono">
                    {customerAnalytics.reduce((s, c) => s + c.totalRealizedProfit, 0).toLocaleString()}
                  </div>
                  <div className="text-[8px] font-bold text-indigo-600 mt-1 uppercase">
                    {language === 'ar' ? `تقديري: ${customerAnalytics.reduce((s, c) => s + c.totalProjectedProfit, 0).toLocaleString()} ج.م` : `Est: ${customerAnalytics.reduce((s, c) => s + c.totalProjectedProfit, 0).toLocaleString()} L.E.`}
                  </div>
                </div>
              </div>

              {/* Search bar */}
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="relative w-full md:w-96">
                  <input
                    type="text"
                    placeholder={language === 'ar' ? 'ابحث باسم العميل، البريد، المشروع...' : "Search customer name, email, project..."}
                    className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm text-xs"
                    value={customerAccountSearch}
                    onChange={e => setCustomerAccountSearch(e.target.value)}
                  />
                  <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"></i>
                </div>
              </div>

              {/* Customer Accounts Master Table */}
              <div className="overflow-x-auto rounded-3xl border border-slate-200 shadow-xs">
                <table className="w-full text-start text-xs" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                  <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                    <tr>
                      <th className="px-6 py-4">{language === 'ar' ? 'كيان العميل' : 'Customer Entity'}</th>
                      <th className="px-4 py-4 text-center">{language === 'ar' ? 'الطلبات' : 'Orders'}</th>
                      <th className="px-5 py-4 text-end">{language === 'ar' ? 'المبيعات المفوترة' : 'Invoiced Sales'}</th>
                      <th className="px-5 py-4 text-end">{language === 'ar' ? 'المحصل حتى تاريخه' : 'Paid to Date'}</th>
                      <th className="px-5 py-4 text-end">{language === 'ar' ? 'مستحقات العملاء (AR)' : 'Customer AR (Due)'}</th>
                      <th className="px-5 py-4 text-end">{language === 'ar' ? 'المحفظة / الدفعات' : 'Wallet / Advances'}</th>
                      <th className="px-5 py-4 text-end">{language === 'ar' ? 'الأرباح المحققة' : 'Realized Profit'}</th>
                      <th className="px-4 py-4 text-center">{language === 'ar' ? 'الحالة' : 'Status'}</th>
                      <th className="px-6 py-4 text-end">{language === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {customerAnalytics
                      .filter(ca => {
                        if (!customerAccountSearch) return true;
                        const q = customerAccountSearch.toLowerCase().trim();
                        return (
                          ca.customer.name.toLowerCase().includes(q) ||
                          (ca.customer.email || '').toLowerCase().includes(q) ||
                          ca.orders.some(o => (o.projectName || '').toLowerCase().includes(q) || (o.internalOrderNumber || '').toLowerCase().includes(q))
                        );
                      })
                      .map(ca => {
                        const isExpanded = Boolean(expandedCustomerIds[ca.customer.id]);
                        return (
                          <React.Fragment key={ca.customer.id}>
                            <tr className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 font-black">
                                    <i className="fa-solid fa-building"></i>
                                  </div>
                                  <div>
                                    <div className="font-black text-slate-800 text-sm">{ca.customer.name}</div>
                                    <div className="text-[10px] text-slate-400 font-bold">{ca.customer.email || ca.customer.phone || 'N/A'}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-4 text-center">
                                <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700 font-mono font-bold text-xs">
                                  {ca.orderCount}
                                </span>
                              </td>
                              <td className="px-5 py-4 text-end font-mono">
                                <div className="font-black text-slate-800">{ca.totalInvoicedGross.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}</div>
                                <div className="text-[9px] text-slate-400 font-bold">{language === 'ar' ? 'صافي:' : 'Net:'} {ca.totalInvoicedNet.toLocaleString()}</div>
                              </td>
                              <td className="px-5 py-4 text-end font-mono font-bold text-emerald-700">
                                {ca.totalPaid.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>
                              <td className="px-5 py-4 text-end font-mono">
                                {ca.totalAR > 0 ? (
                                  <span className="px-2.5 py-1 rounded-xl bg-rose-50 text-rose-700 border border-rose-200 font-black inline-flex items-center gap-1">
                                    {ca.totalAR.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                  </span>
                                ) : (
                                  <span className="text-emerald-700 font-bold">0.00 {language === 'ar' ? 'ج.م' : 'L.E.'}</span>
                                )}
                              </td>
                              <td className="px-5 py-4 text-end font-mono">
                                {ca.combinedWalletBalance > 0 ? (
                                  <span className="px-2.5 py-1 rounded-xl bg-teal-50 text-teal-700 border border-teal-200 font-black inline-flex items-center gap-1">
                                    <i className="fa-solid fa-wallet text-[9px]"></i>
                                    {ca.combinedWalletBalance.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">0.00 {language === 'ar' ? 'ج.م' : 'L.E.'}</span>
                                )}
                              </td>
                              <td className="px-5 py-4 text-end font-mono">
                                <div className="font-black text-emerald-800">{ca.totalRealizedProfit.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}</div>
                                <div className="text-[9px] text-slate-400 font-bold">{language === 'ar' ? 'تقديري:' : 'Est:'} {ca.totalProjectedProfit.toLocaleString()}</div>
                              </td>
                              <td className="px-4 py-4 text-center">
                                <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase border ${
                                  ca.status === 'ar_due' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                                  ca.status === 'credit_balance' ? 'bg-teal-50 text-teal-700 border-teal-200' :
                                  ca.status === 'settled' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                                  'bg-slate-50 text-slate-500 border-slate-200'
                                }`}>
                                  {ca.status === 'ar_due' ? (language === 'ar' ? 'مستحق سداد' : 'AR Due') :
                                   ca.status === 'credit_balance' ? (language === 'ar' ? 'رصيد دائن متاح' : 'Credit Available') :
                                   ca.status === 'settled' ? (language === 'ar' ? 'تمت التسوية ✓' : 'Settled ✓') : (language === 'ar' ? 'لا توجد طلبات' : 'No Orders')}
                                </span>
                              </td>
                              <td className="px-6 py-4 text-end">
                                <div className="flex justify-end items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setAdvanceModalCustomer(ca.customer)}
                                    className="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all inline-flex items-center gap-1 cursor-pointer"
                                    title={language === 'ar' ? 'إيداع دفعة مقدمة في محفظة العميل' : "Deposit advance prepayment to customer wallet"}
                                  >
                                    <i className="fa-solid fa-plus text-[8px]"></i>
                                    <span>{language === 'ar' ? 'إيداع دفعة' : 'Deposit Adv'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setExpandedCustomerIds(prev => ({ ...prev, [ca.customer.id]: !prev[ca.customer.id] }))}
                                    className="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase bg-slate-100 border border-slate-200 text-slate-600 hover:bg-slate-200 transition-all inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <span>{language === 'ar' ? `الطلبات (${ca.orderCount})` : `Orders (${ca.orderCount})`}</span>
                                    <i className={`fa-solid fa-chevron-${isExpanded ? 'up' : 'down'} text-[8px]`}></i>
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {/* Expanded Customer Order Breakdown */}
                            {isExpanded && (
                              <tr className="bg-slate-50/70 border-b border-slate-100">
                                <td colSpan={9} className="px-8 py-5">
                                  <div className="bg-white rounded-2xl border border-slate-200 shadow-inner overflow-hidden">
                                    <div className="px-5 py-3 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                                      <span className="text-[10px] font-black uppercase text-slate-600 tracking-wider">
                                        {language === 'ar' ? `سجل الطلبات والتفصيل المالي: ${ca.customer.name}` : `Order History & Financial Breakdown: ${ca.customer.name}`}
                                      </span>
                                      <span className="text-[9px] font-bold text-slate-400">
                                        {language === 'ar' ? `إجمالي الطلبات: ${ca.orders.length}` : `Total Orders: ${ca.orders.length}`}
                                      </span>
                                    </div>
                                    {ca.orders.length === 0 ? (
                                      <div className="py-6 text-center text-slate-400 font-bold text-xs uppercase tracking-widest">
                                        {language === 'ar' ? 'لا توجد طلبات نشطة لهذا العميل' : 'No active orders found for this customer'}
                                      </div>
                                    ) : (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-start text-xs" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                                          <thead className="bg-slate-50 text-[8px] font-black uppercase text-slate-400 tracking-widest">
                                            <tr>
                                              <th className="px-4 py-2.5">{language === 'ar' ? 'الطلب / المرجع' : 'Order / Ref'}</th>
                                              <th className="px-4 py-2.5">{language === 'ar' ? 'المشروع' : 'Project'}</th>
                                              <th className="px-4 py-2.5">{language === 'ar' ? 'الحالة' : 'Status'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'صافي العرض' : 'Quoted Net'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'الإجمالي الشامل' : 'Total Gross'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'المدفوع' : 'Paid'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'مستحقات العميل' : 'Customer AR'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'أصل WIP' : 'WIP Asset'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'الربح المحقق' : 'Realized Profit'}</th>
                                              <th className="px-4 py-2.5 text-end">{language === 'ar' ? 'الضريبة (14%)' : 'VAT (14%)'}</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                                            {ca.orders.map(o => {
                                              const pl = getPL(o);
                                              return (
                                                <tr key={o.id} className="hover:bg-slate-50/70 transition-colors">
                                                  <td className="px-4 py-2.5">
                                                    <div className="font-mono font-black text-blue-600">{o.internalOrderNumber}</div>
                                                    {o.customerReferenceNumber && (
                                                      <div className="text-[8px] text-slate-400">PO: {o.customerReferenceNumber}</div>
                                                    )}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-slate-500">
                                                    {getOrderProjectName(o) || '—'}
                                                  </td>
                                                  <td className="px-4 py-2.5">
                                                    <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase bg-slate-100 text-slate-600 border border-slate-200">
                                                      {o.status}
                                                    </span>
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono">
                                                    {pl.revenue.toLocaleString()} {pl.currency}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono font-black text-slate-800">
                                                    {pl.grossRevenue.toLocaleString()} {pl.currency}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono text-emerald-700">
                                                    {pl.paid.toLocaleString()} {pl.currency}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono">
                                                    {pl.customerAR > 0 ? (
                                                      <span className="text-rose-600 font-black">{pl.customerAR.toLocaleString()} {pl.currency}</span>
                                                    ) : (
                                                      <span className="text-emerald-700">0.00</span>
                                                    )}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono text-amber-700">
                                                    {pl.wip > 0 ? pl.wip.toLocaleString() : '0.00'}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono text-emerald-800 font-black">
                                                    {pl.realizedProfit.toLocaleString()} {pl.currency}
                                                  </td>
                                                  <td className="px-4 py-2.5 text-end font-mono text-purple-700">
                                                    {pl.outputTax.toFixed(2)}
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* BLANKET SETTLEMENTS VIEW */}
          {customerViewMode === 'blanket_settlements' && (
            <div className="px-8 pb-8 space-y-4">
            {customers
              .filter(c => {
                if (c.name.trim().toLowerCase() === 'internal stock') return false;
                if (!customerWalletSearch) return true;
                const q = customerWalletSearch.toLowerCase().trim();
                return (
                  c.name.toLowerCase().includes(q) ||
                  (c.email || '').toLowerCase().includes(q) ||
                  Object.keys(c.walletBalances || {}).some(p => p.toLowerCase().includes(q))
                );
              })
              .map(c => {
                const projectMap = c.walletBalances || {};
                let projects = Object.entries(projectMap)
                  .filter(([project, bal]) => {
                    const balance = Number(bal) || 0;
                    if (balance === 0) return false;
                    return orders.some(o =>
                      o.status !== OrderStatus.REJECTED &&
                      isOrderBlanket(o) &&
                      getOrderProjectName(o).toLowerCase().trim() === project.toLowerCase().trim()
                    );
                  })
                  .map(([project, bal]) => ({ project, balance: Number(bal) || 0 }));
                // Legacy fallback: if a customer only has an aggregate wallet-balance
                // (pre-existing data), surface it under an unspecified bucket.
                const legacy = Number(c.walletBalance || 0);
                if (projects.length === 0 && legacy !== 0) {
                  projects = [{ project: language === 'ar' ? 'مخصص (سابق)' : 'Allocated (Legacy)', balance: legacy }];
                }
                const customerTotal = projects.reduce((s, p) => s + p.balance, 0);
                const hasBalance = customerTotal !== 0 || legacy !== 0;
                return { customer: c, projects, customerTotal, hasBalance };
              })
              .filter(x => x.hasBalance)
              .map(({ customer, projects, customerTotal }) => (
                <div key={customer.id} className={`border rounded-3xl overflow-hidden ${customerTotal < 0 ? 'border-rose-200' : 'border-slate-200'}`}>
                  {/* Customer header */}
                  <div className={`flex items-center justify-between gap-4 px-6 py-4 ${customerTotal < 0 ? 'bg-rose-900' : 'bg-slate-900'}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${customerTotal < 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                        <i className="fa-solid fa-building"></i>
                      </div>
                      <div className="min-w-0">
                        <div className="font-black text-white text-sm truncate">{customer.name}</div>
                        <div className="text-[10px] text-slate-400 font-bold truncate">{customer.email || 'N/A'}</div>
                      </div>
                    </div>
                    <div className="text-end shrink-0">
                      <div className="text-[9px] font-black uppercase text-slate-400 tracking-widest">
                        {customerTotal < 0 ? (language === 'ar' ? 'إجمالي الدين' : 'Total Debt') : (language === 'ar' ? 'إجمالي المحفظة' : 'Total Wallet')}
                      </div>
                      <div className={`text-lg font-black ${customerTotal < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {customerTotal.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                        {customerTotal < 0 && <span className="text-[9px] font-black ml-1.5 opacity-70 uppercase tracking-wider">{language === 'ar' ? '(دين)' : '(Debt)'}</span>}
                      </div>
                    </div>
                  </div>
                  {/* Nested project rows */}
                  {projects.length === 0 ? (
                    <div className="px-6 py-4 text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                      {language === 'ar' ? 'لا توجد تخصيصات لمحافظ المشاريع' : 'No project wallet allocations'}
                    </div>
                  ) : (
                    <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                      <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                        <tr>
                          <th className="px-6 py-3">{language === 'ar' ? 'المشروع' : 'Project'}</th>
                          <th className="px-6 py-3 text-end">{language === 'ar' ? 'رصيد المحفظة' : 'Wallet Balance'}</th>
                          <th className="px-6 py-3">{language === 'ar' ? 'الحالة' : 'Status'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {projects.map(({ project, balance }) => (
                          <tr key={project} className={`transition-colors ${balance < 0 ? 'hover:bg-rose-50/60 bg-rose-50/30' : 'hover:bg-slate-50/80'}`}>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2.5">
                                <i className={`fa-solid fa-diagram-project ${balance < 0 ? 'text-rose-300' : 'text-slate-300'}`}></i>
                                <span className="font-bold text-slate-700 text-sm">{project}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-end">
                              <span className={`inline-flex items-center gap-2 text-sm font-black px-4 py-2 rounded-xl border ${
                                balance > 0
                                  ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                  : balance < 0
                                  ? 'text-rose-700 bg-rose-50 border-rose-200'
                                  : 'text-slate-500 bg-slate-50 border-slate-200'
                              }`}>
                                <i className={`fa-solid fa-wallet ${balance > 0 ? 'text-emerald-500' : balance < 0 ? 'text-rose-500' : 'text-slate-400'}`}></i>
                                {balance.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase border ${
                                balance > 0
                                  ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                                  : balance < 0
                                  ? 'bg-rose-50 text-rose-600 border-rose-200'
                                  : 'bg-slate-100 text-slate-500 border-slate-200'
                              }`}>
                                {balance > 0 ? (language === 'ar' ? 'رصيد دائن متاح' : 'Credit Available') : balance < 0 ? (language === 'ar' ? 'دين / غير مفوتر' : 'Debt / Uninvoiced') : (language === 'ar' ? 'رصيد صفري' : 'Zero Balance')}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            {customers.filter(c => {
              const projectNonZero = (c.walletBalances && Object.values(c.walletBalances).some(v => (Number(v) || 0) !== 0)) || false;
              return projectNonZero || (c.walletBalance && c.walletBalance !== 0);
            }).length === 0 && (
              <div className="text-center py-16">
                <i className="fa-solid fa-wallet text-4xl block mb-3 text-slate-200"></i>
                <div className="text-slate-400 font-bold text-sm uppercase tracking-widest">{language === 'ar' ? 'لم يتم العثور على أرصدة لمحافظ العملاء' : 'No customer wallet balances found'}</div>
              </div>
            )}
          </div>
        )}
      </div>
    )}

      {/* Project Wallets Tab — wallet balances grouped by project */}
      {activeTab === 'project_wallets' && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
          <div className="px-8 pt-8 pb-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center">
                <i className="fa-solid fa-diagram-project text-xl"></i>
              </div>
              <div>
                <div className="font-black text-slate-800 uppercase tracking-widest text-lg">
                  {language === 'ar' ? 'محافظ المشاريع' : 'Project Wallets'}
                </div>
                <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">
                  {language === 'ar' ? 'أرصدة الدائن والمدين للمحافظ مجمعة حسب المشروع من تسويات العقود الإطارية' : 'Wallet credit and debt balances aggregated by project from blanket contract settlements'}
                </div>
              </div>
            </div>

            {/* Quick Toggle between Customer Wallets and Project Wallets */}
            <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
              <button
                onClick={() => setActiveTab('customer_wallets')}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase transition-all text-slate-500 hover:text-slate-800 flex items-center gap-1.5"
              >
                <i className="fa-solid fa-building text-xs"></i>
                <span>{language === 'ar' ? 'حسب العميل' : 'By Customer'}</span>
              </button>
              <button
                onClick={() => setActiveTab('project_wallets')}
                className="px-4 py-2 rounded-xl text-xs font-black uppercase transition-all bg-white text-violet-700 shadow-xs flex items-center gap-1.5"
              >
                <i className="fa-solid fa-diagram-project text-xs"></i>
                <span>{language === 'ar' ? 'حسب المشروع' : 'By Project'}</span>
              </button>
            </div>
          </div>

          <div className="px-8 pb-8 space-y-4">
            {projectWallets.map(item => {
              const isDebt = item.totalBalance < 0;
              return (
                <div key={item.projectName} className={`border rounded-3xl overflow-hidden ${isDebt ? 'border-rose-200' : 'border-slate-200'}`}>
                  {/* Project Header */}
                  <div className={`flex items-center justify-between gap-4 px-6 py-4 ${isDebt ? 'bg-rose-900' : 'bg-slate-900'}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isDebt ? 'bg-rose-500/20 text-rose-300' : 'bg-violet-500/20 text-violet-300'}`}>
                        <i className="fa-solid fa-diagram-project"></i>
                      </div>
                      <div className="min-w-0">
                        <div className="font-black text-white text-base truncate flex items-center gap-2">
                          <span>{item.projectName}</span>
                          <span className="px-2 py-0.5 rounded-md bg-white/10 text-white/80 font-sans text-[10px] font-black uppercase tracking-wider">
                            {item.orders.length} {item.orders.length === 1 ? (language === 'ar' ? 'طلب إطاري' : 'Blanket Order') : (language === 'ar' ? 'طلبات إطارية' : 'Blanket Orders')}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-bold truncate mt-0.5">
                          {item.allocations.length > 0 ? (
                            <span>{language === 'ar' ? 'العميل (العملاء):' : 'Customer(s):'} {item.allocations.map(a => a.customer.name).join(', ')}</span>
                          ) : (
                            <span>{language === 'ar' ? 'لا توجد تخصيصات للعملاء' : 'No customer allocations'}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-end shrink-0">
                      <div className="text-[9px] font-black uppercase text-slate-400 tracking-widest">
                        {isDebt ? (language === 'ar' ? 'إجمالي دين المشروع' : 'Total Project Debt') : (language === 'ar' ? 'إجمالي محفظة المشروع' : 'Total Project Wallet')}
                      </div>
                      <div className={`text-lg font-black font-mono ${isDebt ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {item.totalBalance > 0 ? `+${item.totalBalance.toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : item.totalBalance < 0 ? `-${Math.abs(item.totalBalance).toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : `0.00 ${language === 'ar' ? 'ج.م' : 'L.E.'}`}
                        {isDebt && <span className="text-[9px] font-black ml-1.5 opacity-70 uppercase font-sans tracking-wider">{language === 'ar' ? '(دين)' : '(Debt)'}</span>}
                      </div>
                    </div>
                  </div>

                  {/* Customer Allocations Table */}
                  <div className="p-6 bg-slate-50/50 space-y-4">
                    <div className="text-[10px] font-black uppercase text-slate-500 tracking-wider">
                      {language === 'ar' ? 'تخصيصات العملاء والطلبات الإطارية للمشروع' : 'Customer Allocations & Project Blanket Orders'}
                    </div>
                    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
                      <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                        <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                          <tr>
                            <th className="px-6 py-3">{language === 'ar' ? 'العميل' : 'Customer'}</th>
                            <th className="px-6 py-3">{language === 'ar' ? 'الطلبات الإطارية المرتبطة' : 'Related Blanket Orders'}</th>
                            <th className="px-6 py-3 text-end">{language === 'ar' ? 'رصيد محفظة المشروع' : 'Project Wallet Balance'}</th>
                            <th className="px-6 py-3 text-end">{language === 'ar' ? 'إجمالي محفظة العميل' : 'Customer Total Wallet'}</th>
                            <th className="px-6 py-3">{language === 'ar' ? 'الحالة' : 'Status'}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {item.allocations.length > 0 ? (
                            item.allocations.map(({ customer, balance }) => {
                              const custOrders = item.orders.filter(o => o.customerName === customer.name);
                              const custTotal = customer.walletBalance || 0;
                              return (
                                <tr key={customer.id} className={`transition-colors ${balance < 0 ? 'bg-rose-50/30 hover:bg-rose-50/60' : 'hover:bg-slate-50/80'}`}>
                                  <td className="px-6 py-4">
                                    <div className="font-bold text-slate-800 text-xs">{customer.name}</div>
                                    <div className="text-[10px] text-slate-400 font-medium">{customer.email || 'N/A'}</div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      {custOrders.length > 0 ? (
                                        custOrders.map(ord => (
                                          <span
                                            key={ord.id}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[9px] font-mono font-bold text-slate-700"
                                            title={`PO: ${ord.customerReferenceNumber || 'N/A'} | Status: ${ord.status}`}
                                          >
                                            <i className="fa-solid fa-file-lines text-[8px] text-slate-400"></i>
                                            <span>{ord.internalOrderNumber}</span>
                                            {ord.customerReferenceNumber && (
                                              <span className="text-slate-400">({ord.customerReferenceNumber})</span>
                                            )}
                                          </span>
                                        ))
                                      ) : (
                                        <span className="text-[10px] text-slate-400 italic">{language === 'ar' ? 'لا توجد طلبات محددة مرتبطة' : 'No specific orders linked'}</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-end">
                                    <span className={`inline-flex items-center gap-1.5 text-xs font-black px-3 py-1.5 rounded-xl border font-mono ${
                                      balance > 0
                                        ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                        : balance < 0
                                        ? 'text-rose-700 bg-rose-50 border-rose-200'
                                        : 'text-slate-500 bg-slate-50 border-slate-200'
                                    }`}>
                                      <i className={`fa-solid fa-wallet text-[10px] ${balance > 0 ? 'text-emerald-500' : balance < 0 ? 'text-rose-500' : 'text-slate-400'}`}></i>
                                      {balance > 0 ? `+${balance.toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : balance < 0 ? `-${Math.abs(balance).toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : `0.00 ${language === 'ar' ? 'ج.م' : 'L.E.'}`}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-end">
                                    <span className={`text-xs font-bold font-mono ${custTotal < 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                                      {custTotal > 0 ? `+${custTotal.toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : custTotal < 0 ? `-${Math.abs(custTotal).toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'} ${language === 'ar' ? '(دين)' : '(Debt)'}` : `0.00 ${language === 'ar' ? 'ج.م' : 'L.E.'}`}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase border ${
                                      balance > 0
                                        ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                                        : balance < 0
                                        ? 'bg-rose-50 text-rose-600 border-rose-200'
                                        : 'bg-slate-100 text-slate-500 border-slate-200'
                                    }`}>
                                      {balance > 0 ? (language === 'ar' ? 'رصيد دائن متاح' : 'Credit Available') : balance < 0 ? (language === 'ar' ? 'دين / غير مفوتر' : 'Debt / Uninvoiced') : (language === 'ar' ? 'رصيد صفري' : 'Zero Balance')}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })
                          ) : (
                            <tr>
                              <td colSpan={5} className="px-6 py-6 text-center text-slate-400 font-bold text-xs uppercase tracking-wider">
                                {language === 'ar' ? 'لا توجد تخصيصات للعملاء مسجلة لهذا المشروع' : 'No customer allocations recorded for this project'}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })}

            {projectWallets.length === 0 && (
              <div className="text-center py-16">
                <i className="fa-solid fa-diagram-project text-4xl block mb-3 text-slate-200"></i>
                <div className="text-slate-400 font-bold text-sm uppercase tracking-widest">{language === 'ar' ? 'لم يتم العثور على تخصيصات لمحافظ المشاريع' : 'No project wallet allocations found'}</div>
              </div>
            )}
          </div>
        </div>
      )}


      {activeTab === 'supplier_reporting' ? (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh] p-8 space-y-8">
          {/* Header & View Mode Switcher */}
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b border-slate-100 pb-6">
            <div>
              <h1 className="text-2xl font-black uppercase tracking-tight text-slate-800 flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 border border-blue-200 flex items-center justify-center text-lg shrink-0">
                  <i className="fa-solid fa-truck-ramp-box"></i>
                </div>
                <span>{language === 'ar' ? 'أوامر شراء الموردين والمدفوعات' : 'Supplier Purchase Orders & AP Master'}</span>
              </h1>
              <p className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-wider">
                {language === 'ar' ? 'متابعة أوامر الشراء، استلام البنود، مدفوعات الموردين، والتسوية المالية الفورية' : 'Track Supplier POs, Inbound Receiving, Supplier Disbursements & Direct Settlement'}
              </p>
            </div>

            {/* View Mode Switcher Pills */}
            <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 shadow-inner">
              <button
                type="button"
                onClick={() => setSupplierPoViewMode('orders')}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 cursor-pointer ${
                  supplierPoViewMode === 'orders'
                    ? 'bg-white text-blue-700 shadow-sm border border-slate-200'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <i className="fa-solid fa-file-invoice-dollar text-xs"></i>
                <span>{language === 'ar' ? 'أوامر شراء الموردين' : 'Supplier PO Orders'}</span>
                <span className="px-1.5 py-0.5 rounded-md text-[9px] bg-blue-50 text-blue-700 font-mono font-bold">
                  {supplierPOsList.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSupplierPoViewMode('statements')}
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase transition-all flex items-center gap-2 cursor-pointer ${
                  supplierPoViewMode === 'statements'
                    ? 'bg-white text-blue-700 shadow-sm border border-slate-200'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <i className="fa-solid fa-building-columns text-xs"></i>
                <span>{language === 'ar' ? 'كشوف حسابات الموردين' : 'Supplier Accounts & Ledgers'}</span>
                <span className="px-1.5 py-0.5 rounded-md text-[9px] bg-slate-200 text-slate-700 font-mono font-bold">
                  {suppliers.length}
                </span>
              </button>
            </div>
          </div>

          {/* Supplier Financial KPI Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <div className="p-4 rounded-2xl bg-blue-50/70 border border-blue-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-blue-700 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-file-invoice text-blue-600"></i>
                <span>{language === 'ar' ? 'إجمالي قيمة المشتريات' : 'Committed POs (Gross)'}</span>
              </div>
              <div className="text-xl font-black text-blue-950 font-mono">
                {supplierPoSummaryMetrics.totalGross.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[8px] font-bold text-blue-600 mt-1 uppercase">
                {language === 'ar' ? `صافي: ${supplierPoSummaryMetrics.totalNetValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} ج.م` : `Net: ${supplierPoSummaryMetrics.totalNetValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} L.E.`}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-purple-50/70 border border-purple-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-purple-700 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-receipt text-purple-600"></i>
                <span>{language === 'ar' ? 'ضريبة المدخلات (14%)' : 'Input VAT (14%)'}</span>
              </div>
              <div className="text-xl font-black text-purple-950 font-mono">
                {supplierPoSummaryMetrics.totalTax.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[8px] font-bold text-purple-600 mt-1 uppercase">
                {language === 'ar' ? 'ضريبة مدخلات قابلة للخصم' : 'Recoverable Tax Credit'}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-teal-50/70 border border-teal-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-teal-700 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-boxes-stacked text-teal-600"></i>
                <span>{language === 'ar' ? 'القيمة المستلمة بالمخزن' : 'Delivered Value'}</span>
              </div>
              <div className="text-xl font-black text-teal-950 font-mono">
                {supplierAnalytics.reduce((s, x) => s + x.delivered, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[8px] font-bold text-teal-600 mt-1 uppercase">
                {language === 'ar' ? 'بضائع مستلمة فعلياً' : 'Physical Receipt at Hub'}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-emerald-50/70 border border-emerald-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-emerald-700 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-money-bill-transfer text-emerald-600"></i>
                <span>{language === 'ar' ? 'المدفوع للموردين' : 'Paid to Suppliers'}</span>
              </div>
              <div className="text-xl font-black text-emerald-950 font-mono">
                {supplierPoSummaryMetrics.totalPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[8px] font-bold text-emerald-600 mt-1 uppercase">
                {language === 'ar' ? 'إجمالي المدفوعات المسجلة (ج.م)' : 'Recorded Disbursements (L.E.)'}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-rose-50/70 border border-rose-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-rose-700 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-clock-rotate-left text-rose-600"></i>
                <span>{language === 'ar' ? 'رصيد الموردين المستحق' : 'Open AP Balance (Due)'}</span>
              </div>
              <div className="text-xl font-black text-rose-950 font-mono">
                {supplierPoSummaryMetrics.totalBalanceDue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[8px] font-bold text-rose-600 mt-1 uppercase">
                {language === 'ar' ? 'ديون مستحقة السداد (ج.م)' : 'Outstanding Liabilities (L.E.)'}
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 shadow-xs">
              <div className="text-[9px] font-black uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1.5">
                <i className="fa-solid fa-list-check text-slate-600"></i>
                <span>{language === 'ar' ? 'حالة التوريد والاستلام' : 'Fulfillment Status'}</span>
              </div>
              <div className="text-xl font-black text-slate-900 font-mono">
                {supplierPoSummaryMetrics.allReceivedCount} / {supplierPoSummaryMetrics.totalCount}
              </div>
              <div className="text-[8px] font-bold text-slate-500 mt-1 uppercase">
                {supplierPoSummaryMetrics.partialReceivedCount} {language === 'ar' ? 'جزئي' : 'Partial'} • {supplierPoSummaryMetrics.pendingDeliveryCount} {language === 'ar' ? 'قيد التوريد' : 'Pending'}
              </div>
            </div>
          </div>

          {/* VIEW MODE 1: SUPPLIER PURCHASE ORDERS MASTER TABLE */}
          {supplierPoViewMode === 'orders' && (
            <div className="space-y-4">
              {/* Controls Bar */}
              <div className="flex flex-col lg:flex-row justify-between items-stretch lg:items-center gap-4 bg-slate-50/80 p-4 rounded-2xl border border-slate-200">
                {/* Search Box */}
                <div className="relative flex-1 max-w-md">
                  <input
                    type="text"
                    placeholder={language === 'ar' ? 'ابحث برقم أمر شراء العميل، أمر المورد، اسم المورد، البند...' : 'Search Customer PO #, Supplier PO #, Supplier, Item...'}
                    className="w-full px-4 py-2.5 pl-10 bg-white border border-slate-200 rounded-xl outline-none focus:border-blue-500 font-bold transition-all text-xs shadow-xs"
                    value={supplierPoSearchQuery}
                    onChange={e => setSupplierPoSearchQuery(e.target.value)}
                  />
                  <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                  {supplierPoSearchQuery && (
                    <button
                      onClick={() => setSupplierPoSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  )}
                </div>

                {/* Filters */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Fulfillment Filter */}
                  <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 shadow-2xs">
                    {(['all', 'ALL_RECEIVED', 'PARTIALLY_RECEIVED', 'PENDING_DELIVERY'] as const).map(st => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setSupplierPoStatusFilter(st)}
                        className={`px-2.5 py-1 rounded-lg text-[9px] font-black uppercase transition-all ${
                          supplierPoStatusFilter === st
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {st === 'all' ? (language === 'ar' ? 'كل الاستلام' : 'All Receiving') :
                         st === 'ALL_RECEIVED' ? (language === 'ar' ? 'مستلم بالكامل' : 'All Received') :
                         st === 'PARTIALLY_RECEIVED' ? (language === 'ar' ? 'جزئي' : 'Partial') : (language === 'ar' ? 'قيد التوريد' : 'Pending')}
                      </button>
                    ))}
                  </div>

                  {/* Payment Filter */}
                  <select
                    value={supplierPoPaymentFilter}
                    onChange={e => setSupplierPoPaymentFilter(e.target.value as any)}
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:border-blue-500 shadow-2xs"
                  >
                    <option value="all">{language === 'ar' ? 'كل التسويات' : 'All Settlements'}</option>
                    <option value="due">{language === 'ar' ? 'مستحق سداد' : 'Payment Due'}</option>
                    <option value="settled">{language === 'ar' ? 'مسوى / مسدد' : 'Settled / Paid'}</option>
                    <option value="overpaid">{language === 'ar' ? 'مدفوع بالزيادة' : 'Overpaid'}</option>
                  </select>

                  {/* Expand / Collapse All */}
                  <button
                    type="button"
                    onClick={handleToggleExpandAllSupplierPos}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 transition-all inline-flex items-center gap-1.5 shadow-2xs cursor-pointer"
                  >
                    <i className={`fa-solid fa-${filteredSupplierPOs.length > 0 && filteredSupplierPOs.every(po => expandedSupplierPoIds[po.id]) ? 'chevron-up' : 'chevron-down'} text-[10px]`}></i>
                    <span>
                      {filteredSupplierPOs.length > 0 && filteredSupplierPOs.every(po => expandedSupplierPoIds[po.id])
                        ? (language === 'ar' ? 'طي الكل' : 'Collapse All')
                        : (language === 'ar' ? 'توسيع الكل' : 'Expand All')}
                    </span>
                  </button>
                </div>
              </div>

              {/* Supplier POs Table */}
              <div className="overflow-x-auto rounded-3xl border border-slate-200 shadow-xs">
                <table className="w-full text-start text-xs" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                  <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-200">
                    <tr>
                      <th className="w-8 px-3 py-3.5 text-center"></th>
                      <th className="px-5 py-3.5 text-start">{language === 'ar' ? 'أمر شراء العميل' : 'Customer PO #'}</th>
                      <th className="px-5 py-3.5 text-start">{language === 'ar' ? 'أمر شراء المورد' : 'Supplier PO #'}</th>
                      <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'القيمة (صافي)' : 'Value (Net)'}</th>
                      <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'الضريبة (14%)' : 'Tax (14%)'}</th>
                      <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'الإجمالي (شامل)' : 'Total (Gross)'}</th>
                      <th className="px-5 py-3.5 text-center">{language === 'ar' ? 'حالة الاستلام' : 'Receipt Status'}</th>
                      <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'المدفوع / رصيد المورد' : 'Paid / AP Balance'}</th>
                      <th className="px-6 py-3.5 text-end">{language === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                    {filteredSupplierPOs.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-16 text-center text-slate-400">
                          <i className="fa-solid fa-inbox text-4xl mb-3 text-slate-300"></i>
                          <div className="text-xs uppercase font-black tracking-widest">{language === 'ar' ? 'لم يتم العثور على أوامر شراء موردين' : 'No Supplier Purchase Orders Found'}</div>
                          <div className="text-[10px] text-slate-400 mt-1 font-medium">{language === 'ar' ? 'جرب تعديل كلمات البحث أو الفلاتر' : 'Try adjusting your search query or filters'}</div>
                        </td>
                      </tr>
                    ) : (
                      filteredSupplierPOs.map((po, poIdx) => {
                        const isExpanded = Boolean(expandedSupplierPoIds[po.id]);
                        const isEven = poIdx % 2 === 1;
                        const rowBg = isExpanded ? 'bg-blue-50/40' : isEven ? 'bg-slate-50/50' : 'bg-white';

                        return (
                          <React.Fragment key={po.id}>
                            <tr
                              onClick={() => toggleSupplierPoExpand(po.id)}
                              className={`${rowBg} hover:bg-blue-50/60 transition-colors cursor-pointer select-none border-b border-slate-100`}
                            >
                              {/* Chevron */}
                              <td className="px-3 py-4 text-center">
                                <i className={`fa-solid fa-chevron-${isExpanded ? 'down' : 'right'} text-slate-400 text-xs transition-transform`}></i>
                              </td>

                              {/* Customer PO # */}
                              <td className="px-5 py-4">
                                <div className="font-mono text-xs font-black text-slate-800">
                                  {po.customerReferenceNumber}
                                </div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="font-mono text-[9px] text-blue-600 font-bold bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                                    {po.orderNumber}
                                  </span>
                                  <span className="text-[9px] text-slate-400 truncate max-w-[140px]" title={po.customerName}>
                                    {po.customerName}
                                  </span>
                                </div>
                              </td>

                              {/* Supplier PO # */}
                              <td className="px-5 py-4">
                                <div className="inline-flex items-center gap-1.5 font-mono text-xs font-black text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                                  <i className="fa-solid fa-file-contract text-[10px]"></i>
                                  <span>{po.poNumber}</span>
                                </div>
                                <div className="text-xs font-bold text-slate-700 mt-1 flex items-center gap-1">
                                  <i className="fa-solid fa-truck text-[9px] text-slate-400"></i>
                                  <span>{po.supplierName}</span>
                                </div>
                              </td>

                              {/* Value (Net) */}
                              <td className="px-5 py-4 text-end font-mono text-xs font-bold text-slate-700">
                                {po.netValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>

                              {/* Tax (14%) */}
                              <td className="px-5 py-4 text-end font-mono text-xs font-bold text-purple-700">
                                {po.taxAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>

                              {/* Total (Gross) */}
                              <td className="px-5 py-4 text-end font-mono text-sm font-black text-slate-900">
                                {po.grossTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>

                              {/* Delivery / Receipt Status */}
                              <td className="px-5 py-4 text-center">
                                {po.receiptStatus === 'ALL_RECEIVED' ? (
                                  <div>
                                    <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1 shadow-2xs">
                                      <i className="fa-solid fa-circle-check text-emerald-600"></i>
                                      <span>{language === 'ar' ? 'مستلم بالكامل' : 'All Received'} ({po.receivedComponentsCount}/{po.totalComponentsCount})</span>
                                    </span>
                                    <div className="text-[8px] font-mono text-slate-400 mt-0.5">
                                      {po.totalReceivedQty.toLocaleString()} / {po.totalOrderedQty.toLocaleString()} {language === 'ar' ? 'وحدة' : 'units'}
                                    </div>
                                  </div>
                                ) : po.receiptStatus === 'PARTIALLY_RECEIVED' ? (
                                  <div>
                                    <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1 shadow-2xs">
                                      <i className="fa-solid fa-boxes-packing text-amber-600"></i>
                                      <span>{language === 'ar' ? 'جزئي' : 'Partial'} ({po.receivedComponentsCount}/{po.totalComponentsCount})</span>
                                    </span>
                                    <div className="text-[8px] font-mono text-amber-700 mt-0.5 font-bold">
                                      {po.totalReceivedQty.toLocaleString()} / {po.totalOrderedQty.toLocaleString()} {language === 'ar' ? 'وحدة' : 'units'}
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <span className="px-2.5 py-1 rounded-full text-[9px] font-black uppercase bg-slate-100 text-slate-500 border border-slate-200 inline-flex items-center gap-1 shadow-2xs">
                                      <i className="fa-solid fa-clock text-slate-400"></i>
                                      <span>{language === 'ar' ? 'قيد التوريد' : 'Pending Delivery'} ({po.receivedComponentsCount}/{po.totalComponentsCount})</span>
                                    </span>
                                    <div className="text-[8px] font-mono text-slate-400 mt-0.5">
                                      0 / {po.totalOrderedQty.toLocaleString()} {language === 'ar' ? 'وحدة' : 'units'}
                                    </div>
                                  </div>
                                )}
                              </td>

                              {/* Paid / AP Balance */}
                              <td className="px-5 py-4 text-end">
                                <div className="text-xs font-mono font-bold text-emerald-700">
                                  {language === 'ar' ? 'المدفوع:' : 'Paid:'} {po.paidAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                </div>
                                <div className="mt-0.5">
                                  {po.isSettled ? (
                                    <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 inline-block">
                                      {language === 'ar' ? 'تمت التسوية ✓' : 'Settled ✓'}
                                    </span>
                                  ) : po.isOverpaid ? (
                                    <span className="px-2 py-0.5 rounded-md text-[9px] font-black uppercase bg-blue-50 text-blue-700 border border-blue-200 inline-block font-mono">
                                      {language === 'ar' ? 'مدفوع بالزيادة' : 'Overpaid'} +{(po.paidAmount - po.grossTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                    </span>
                                  ) : (
                                    <span className="text-xs font-mono font-black text-rose-700">
                                      {language === 'ar' ? 'مستحق:' : 'Due:'} {po.balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Actions */}
                              <td className="px-6 py-4 text-end">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openSupplierPoPaymentModal(po);
                                  }}
                                  className={`px-3.5 py-2 rounded-xl text-[10px] font-black uppercase transition-all inline-flex items-center gap-1.5 shadow-sm cursor-pointer whitespace-nowrap ${
                                    po.isSettled
                                      ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                                      : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-200'
                                  }`}
                                >
                                  <i className="fa-solid fa-credit-card text-[9px]"></i>
                                  <span>{po.isSettled ? (language === 'ar' ? 'إضافة دفعة' : 'Add Payment') : (language === 'ar' ? 'سداد للمورد' : 'Pay Supplier')}</span>
                                </button>
                              </td>
                            </tr>

                            {/* EXPANDABLE ACCORDION: COMPONENTS & PAYMENTS */}
                            {isExpanded && (
                              <tr className="bg-slate-50/70 border-b border-slate-200">
                                <td colSpan={9} className="p-6 space-y-5 animate-in fade-in duration-200">
                                  {/* Subtable Header */}
                                  <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-slate-200">
                                    <div className="flex items-center gap-2">
                                      <i className="fa-solid fa-layer-group text-blue-600 text-xs"></i>
                                      <span className="text-xs font-black uppercase tracking-wider text-slate-800">
                                        {language === 'ar' ? 'تفصيل مكونات أمر شراء المورد' : 'Supplier PO Components Breakdown'} ({po.components.length} {language === 'ar' ? 'بنود' : 'Items'})
                                      </span>
                                    </div>
                                    <div className="text-[10px] font-bold text-slate-400">
                                      {language === 'ar' ? 'المورد:' : 'Supplier:'} <span className="text-slate-700 font-black">{po.supplierName}</span> • {language === 'ar' ? 'أمر الشراء:' : 'PO #:'} <span className="font-mono text-blue-700 font-bold">{po.poNumber}</span>
                                    </div>
                                  </div>

                                  {/* Components Breakdown Table */}
                                  <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-xs">
                                    <table className="w-full text-start text-xs">
                                      <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-200">
                                        <tr>
                                          <th className="px-5 py-3 text-start">{language === 'ar' ? 'وصف المكون' : 'Component Description'}</th>
                                          <th className="px-5 py-3 text-start">{language === 'ar' ? 'بند طلب العميل' : 'Parent Order Item'}</th>
                                          <th className="px-5 py-3 text-end">{language === 'ar' ? 'سعر الوحدة' : 'Unit Cost'}</th>
                                          <th className="px-5 py-3 text-center">{language === 'ar' ? 'الكمية المطلوبة' : 'Ordered Qty'}</th>
                                          <th className="px-5 py-3 text-end">{language === 'ar' ? 'القيمة الصافية' : 'Net Value'}</th>
                                          <th className="px-5 py-3 text-end">{language === 'ar' ? 'الضريبة (14%)' : 'Tax (14%)'}</th>
                                          <th className="px-5 py-3 text-end">{language === 'ar' ? 'الإجمالي الشامل' : 'Total Gross'}</th>
                                          <th className="px-5 py-3 text-center">{language === 'ar' ? 'حالة وكمية الاستلام' : 'Received Status & Qty'}</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                                        {po.components.map((c: any, cIdx: number) => {
                                          const recQty = c.receivedQty || 0;
                                          const isFull = recQty >= (c.quantity || 0) && (c.quantity || 0) > 0;
                                          const isPart = recQty > 0 && !isFull;

                                          return (
                                            <tr key={c.id || cIdx} className="hover:bg-slate-50/70 transition-colors">
                                              <td className="px-5 py-3">
                                                <div className="font-black text-slate-800">{c.description}</div>
                                                {c.status && (
                                                  <span className="text-[8px] font-mono uppercase text-slate-400 tracking-wider">
                                                    {language === 'ar' ? 'الحالة:' : 'Status:'} {c.status}
                                                  </span>
                                                )}
                                              </td>
                                              <td className="px-5 py-3 text-slate-500 max-w-xs truncate" title={c.parentItemDesc}>
                                                {c.parentItemDesc || '-'}
                                              </td>
                                              <td className="px-5 py-3 text-end font-mono text-slate-600">
                                                {(c.unitCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                              </td>
                                              <td className="px-5 py-3 text-center font-mono">
                                                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                                                  {(c.quantity || 0).toLocaleString()}
                                                </span>
                                              </td>
                                              <td className="px-5 py-3 text-end font-mono text-slate-700">
                                                {(c.netCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                              </td>
                                              <td className="px-5 py-3 text-end font-mono text-purple-700">
                                                {(c.taxAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                              </td>
                                              <td className="px-5 py-3 text-end font-mono font-black text-slate-900">
                                                {(c.grossCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                              </td>
                                              <td className="px-5 py-3 text-center">
                                                {isFull ? (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1 font-mono">
                                                    <i className="fa-solid fa-check"></i>
                                                    <span>{recQty.toLocaleString()} / {(c.quantity || 0).toLocaleString()} (100%)</span>
                                                  </span>
                                                ) : isPart ? (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-amber-50 text-amber-700 border border-amber-200 inline-flex items-center gap-1 font-mono">
                                                    <i className="fa-solid fa-clock"></i>
                                                    <span>{recQty.toLocaleString()} / {(c.quantity || 0).toLocaleString()} ({Math.round((recQty / (c.quantity || 1)) * 100)}%)</span>
                                                  </span>
                                                ) : (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-slate-100 text-slate-500 border border-slate-200 inline-flex items-center gap-1 font-mono">
                                                    <i className="fa-solid fa-hourglass-start"></i>
                                                    <span>0 / {(c.quantity || 0).toLocaleString()} (0%)</span>
                                                  </span>
                                                )}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>

                                  {/* Payment History for this PO */}
                                  <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-xs">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <i className="fa-solid fa-clock-rotate-left text-emerald-600 text-xs"></i>
                                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-700">
                                          {language === 'ar' ? 'المدفوعات والإيصالات المرفقة' : 'Disbursements & Receipts Attached'} ({po.payments.length})
                                        </span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => openSupplierPoPaymentModal(po)}
                                        className="text-[9px] font-black uppercase text-emerald-700 hover:text-emerald-800 underline inline-flex items-center gap-1 cursor-pointer"
                                      >
                                        <i className="fa-solid fa-plus text-[8px]"></i>
                                        <span>{language === 'ar' ? 'إضافة دفعة جديدة' : 'Add New Payment'}</span>
                                      </button>
                                    </div>

                                    {po.payments.length === 0 ? (
                                      <div className="text-center py-4 text-slate-400 text-xs italic">
                                        {language === 'ar' ? 'لا توجد مدفوعات مسجلة بعد لأمر الشراء هذا.' : 'No payments recorded yet for this Purchase Order.'}
                                      </div>
                                    ) : (
                                      <div className="divide-y divide-slate-100 text-xs">
                                        {po.payments.map((p: any, pIdx: number) => (
                                          <div key={p.id || pIdx} className="py-2.5 flex items-center justify-between flex-wrap gap-2">
                                            <div className="flex items-center gap-3">
                                              <div className="w-7 h-7 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center font-bold text-xs">
                                                <i className="fa-solid fa-receipt"></i>
                                              </div>
                                              <div>
                                                <div className="font-mono font-black text-slate-800">
                                                  {(p.allocatedToThisPo || p.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                                </div>
                                                <div className="text-[9px] text-slate-400">
                                                  {new Date(p.date).toLocaleDateString()} • {language === 'ar' ? 'المرجع:' : 'Ref:'} {p.memo || (language === 'ar' ? 'سداد مورد' : 'Supplier Payment')} • {language === 'ar' ? 'المستخدم:' : 'User:'} {p.user || (language === 'ar' ? 'النظام' : 'System')}
                                                </div>
                                              </div>
                                            </div>

                                            {p.receiptFile && (
                                              <button
                                                type="button"
                                                onClick={() => downloadOrViewSupplierReceipt(p.receiptFile, `receipt-${po.poNumber}`)}
                                                className="px-3 py-1.5 rounded-lg text-[9px] font-black uppercase bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all inline-flex items-center gap-1.5 cursor-pointer shadow-2xs"
                                              >
                                                <i className="fa-solid fa-paperclip text-emerald-600"></i>
                                                <span>{language === 'ar' ? 'عرض الإيصال/الفاتورة المرفقة' : 'View Attached Receipt/Invoice'}</span>
                                              </button>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VIEW MODE 2: SUPPLIER ACCOUNTS & LEDGER STATEMENTS */}
          {supplierPoViewMode === 'statements' && (
            <div className="space-y-6">
              {/* Single Selection Banner */}
              {selectedSupplierIds.length === 1 && selectedSupplierIds[0] !== 'all' && (
                <div className="flex items-center justify-between p-4 bg-blue-50 border border-blue-200 rounded-2xl flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">
                      <i className="fa-solid fa-truck"></i>
                    </div>
                    <div>
                      <div className="text-sm font-black text-blue-900">
                        {language === 'ar' ? 'دفتر أستاذ المورد:' : 'Supplier AP Ledger:'} {(suppliers || []).find(s => s.id === selectedSupplierIds[0])?.name || (language === 'ar' ? 'المورد المحدد' : 'Selected Supplier')}
                      </div>
                      <div className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">
                        {language === 'ar' ? 'عرض تفاصيل حساب مورد منفرد وسداد المستحقات' : 'Viewing Single Supplier Account Detail & Payment Dispatch'}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSupplierIds(['all']);
                      loadSupplierLedger(['all']);
                    }}
                    className="px-4 py-2 rounded-xl text-xs font-black uppercase bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 transition-all inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
                  >
                    <i className="fa-solid fa-arrow-left"></i>
                    <span>{language === 'ar' ? 'عرض جدول حسابات الموردين' : 'View All Suppliers AP Table'}</span>
                  </button>
                </div>
              )}

              {/* All Suppliers Accounts Payable (AP) Master Table */}
              {(selectedSupplierIds.includes('all') || selectedSupplierIds.length === 0 || selectedSupplierIds.length > 1) && (
                <div className="space-y-4">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black uppercase tracking-tight text-slate-800">
                        {language === 'ar' ? 'جدول حسابات الموردين والدائنين (AP)' : 'All Suppliers Accounts Payable (AP) Master Table'}
                      </span>
                      <span className="text-[9px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full uppercase">
                        {supplierAnalytics.length} {language === 'ar' ? 'حساب' : 'Accounts'}
                      </span>
                    </div>
                    <div className="relative w-full md:w-80">
                      <input
                        type="text"
                        placeholder={language === 'ar' ? 'ابحث باسم المورد، بيانات الاتصال...' : 'Search supplier name, contact...'}
                        className="w-full px-4 py-2.5 pl-10 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 font-bold transition-all text-xs"
                        value={supplierSearchQuery}
                        onChange={e => setSupplierSearchQuery(e.target.value)}
                      />
                      <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-3xl border border-slate-200 shadow-xs">
                    <table className="w-full text-start text-xs" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                      <thead className="bg-slate-100 text-[9px] font-black uppercase text-slate-400 tracking-widest">
                        <tr>
                          <th className="px-6 py-3.5">{language === 'ar' ? 'اسم المورد وبيانات الاتصال' : 'Supplier Name & Contact'}</th>
                          <th className="px-4 py-3.5 text-center">{language === 'ar' ? 'المكونات' : 'Components'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'الأوامر المعتمدة' : 'Committed POs'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'القيمة المستلمة' : 'Delivered Value'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'المدفوع حتى تاريخه' : 'Paid to Date'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'مستحق السداد (بضاعة مستلمة)' : 'Fulfilled AP (Due)'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'إجمالي رصيد الدائنين' : 'Total Open AP'}</th>
                          <th className="px-5 py-3.5 text-end">{language === 'ar' ? 'ضريبة المدخلات (14%)' : 'Input VAT (14%)'}</th>
                          <th className="px-4 py-3.5 text-center">{language === 'ar' ? 'الحالة' : 'Status'}</th>
                          <th className="px-6 py-3.5 text-end">{language === 'ar' ? 'الإجراءات' : 'Actions'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                        {supplierAnalytics
                          .filter(sa => {
                            if (!supplierSearchQuery) return true;
                            const q = supplierSearchQuery.toLowerCase().trim();
                            return (
                              sa.supplier.name.toLowerCase().includes(q) ||
                              (sa.supplier.email || '').toLowerCase().includes(q) ||
                              (sa.supplier.phone || '').toLowerCase().includes(q)
                            );
                          })
                          .map(sa => (
                            <tr key={sa.supplier.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-6 py-3.5">
                                <div className="font-black text-slate-800 text-sm">{sa.supplier.name}</div>
                                <div className="text-[10px] text-slate-400 font-normal">{sa.supplier.email || sa.supplier.phone || 'N/A'}</div>
                              </td>
                              <td className="px-4 py-3.5 text-center font-mono">
                                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs">
                                  {sa.compCount}
                                </span>
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono">
                                {sa.committed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono">
                                {sa.delivered.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono text-emerald-700 font-black">
                                {sa.paid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono">
                                {sa.fulfilledAP > 0 ? (
                                  <span className="px-2 py-0.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 font-black">
                                    {sa.fulfilledAP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                  </span>
                                ) : (
                                  <span className="text-emerald-700 font-bold">0.00</span>
                                )}
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono">
                                {sa.totalAP > 0 ? (
                                  <span className="text-slate-800 font-black">
                                    {sa.totalAP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                                  </span>
                                ) : (
                                  <span className="text-emerald-700">0.00</span>
                                )}
                              </td>
                              <td className="px-5 py-3.5 text-end font-mono text-purple-700">
                                {sa.inputTax.toFixed(2)} {language === 'ar' ? 'ج.م' : 'L.E.'}
                              </td>
                              <td className="px-4 py-3.5 text-center">
                                <span className={`px-2.5 py-0.5 rounded-full text-[8px] font-black uppercase border ${
                                  sa.status === 'overpaid' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                                  sa.status === 'settled' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                                  sa.status === 'payment_due' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                                  sa.status === 'committed' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                  'bg-slate-50 text-slate-400 border-slate-200'
                                }`}>
                                  {sa.status === 'overpaid' ? (language === 'ar' ? 'مدفوع بالزيادة' : 'Overpaid') :
                                   sa.status === 'settled' ? (language === 'ar' ? 'تمت التسوية ✓' : 'Settled ✓') :
                                   sa.status === 'payment_due' ? (language === 'ar' ? 'مستحق سداد' : 'Payment Due') :
                                   sa.status === 'committed' ? (language === 'ar' ? 'قيد التوريد' : 'In Production') : (language === 'ar' ? 'لا توجد أوامر' : 'No Orders')}
                                </span>
                              </td>
                              <td className="px-6 py-3.5 text-end">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedSupplierIds([sa.supplier.id]);
                                    loadSupplierLedger([sa.supplier.id]);
                                    setSpMemo(generatePaymentRef());
                                  }}
                                  className="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 transition-all inline-flex items-center gap-1.5 cursor-pointer shadow-xs"
                                >
                                  <i className="fa-solid fa-credit-card text-[8px]"></i>
                                  <span>{language === 'ar' ? 'كشف الحساب' : 'Statement'}</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Supplier Selector */}
              <div className="flex flex-col lg:flex-row gap-6 items-start">
                <div className="flex-1 w-full">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 block">{t('finance.supplier.selectSupplier')}</label>
                  <div className="relative w-full md:w-96">
                    <button
                      onClick={() => setShowSupplierDropdown(!showSupplierDropdown)}
                      className="w-full px-5 py-3 bg-white border-2 border-slate-200 rounded-2xl font-bold text-sm outline-none focus:border-blue-500 transition-all text-start flex justify-between items-center"
                    >
                      <span>
                        {selectedSupplierIds.includes('all')
                          ? t('finance.supplier.allSuppliers')
                          : selectedSupplierIds.length === 0
                            ? `-- ${t('finance.supplier.selectSupplier')} --`
                            : (() => {
                                if (!suppliers) return `-- ${t('finance.supplier.selectSupplier')} --`;
                                const names = (suppliers || []).filter(s => s && selectedSupplierIds.includes(s.id)).map(s => s.name);
                                if (names.length === 0) return `${selectedSupplierIds.length} ${t('finance.supplier.selectSupplier')}`;
                                if (names.length <= 2) return names.join(', ');
                                return `${names.slice(0, 2).join(', ')} + ${names.length - 2} more`;
                              })()}
                      </span>
                      <i className={`fa-solid fa-chevron-${showSupplierDropdown ? 'up' : 'down'} text-[10px] text-slate-400`}></i>
                    </button>

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
                              setSpMemo(generatePaymentRef());
                            }}
                          />
                          <span className="text-[10px] font-black uppercase text-slate-700 group-hover:text-blue-600">{t("finance.supplier.allSuppliers") || "ALL SUPPLIERS"}</span>
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
                                if (next.length === 1) setSpMemo(generatePaymentRef());
                              }}
                            />
                            <span className="text-[10px] font-black uppercase text-slate-700 group-hover:text-blue-600">{s.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {spError && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-3 rounded-2xl font-bold text-sm">
                  <i className="fa-solid fa-circle-exclamation mr-2"></i>{spError}
                </div>
              )}

              {spLoading && (
                <div className="py-12 text-center text-slate-400">
                  <i className="fa-solid fa-spinner fa-spin text-2xl text-blue-500 mb-2"></i>
                  <div className="text-sm font-bold">{t("finance.supplier.loadingLedger") || (language === 'ar' ? 'جاري تحميل دفتر أستاذ المورد...' : 'Loading supplier ledger...')}</div>
                </div>
              )}

              {selectedSupplierIds.length > 0 && supplierLedger && !spLoading && (
                <div className="space-y-8 animate-in fade-in duration-500">
                  {/* Record New Payment - Only for single selection */}
                  {selectedSupplierIds.length === 1 && selectedSupplierIds[0] !== 'all' && (
                    <div className="bg-slate-50 rounded-2xl border border-slate-200 p-6 space-y-4 shadow-inner">
                      <h3 className="text-sm font-black text-slate-700 uppercase tracking-tight flex items-center gap-2">
                        <i className="fa-solid fa-credit-card text-blue-500"></i> {language === 'ar' ? 'تسجيل سداد جديد' : 'Record New Payment'}
                      </h3>
                      {supplierLedger.balance <= 0 && (
                        <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-2 rounded-xl text-xs font-bold">
                          <i className="fa-solid fa-check-circle mr-1"></i> {language === 'ar' ? 'هذا المورد مسدد بالكامل أو مدفوع بالزيادة.' : 'This supplier is fully paid or overpaid.'}
                        </div>
                      )}
                      <div className="flex flex-col lg:flex-row gap-4">
                        <div className="flex-1">
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">{t("common.date") || "Date"}</label>
                          <input
                            type="date"
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl font-bold text-sm outline-none focus:border-blue-500 transition-all"
                            value={spDate} onChange={e => setSpDate(e.target.value)}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">{language === 'ar' ? 'المبلغ (ج.م)' : 'Amount (L.E.)'}</label>
                          <input
                            type="number" step="0.01" placeholder="0.00"
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl font-bold text-sm outline-none focus:border-blue-500 transition-all"
                            value={spAmount} onChange={e => setSpAmount(e.target.value)}
                          />
                          {spAmount && parseFloat(spAmount) > supplierLedger.balance && supplierLedger.balance > 0 && (
                            <div className="text-[10px] font-bold text-amber-600 mt-1">
                              <i className="fa-solid fa-triangle-exclamation mr-1"></i> {language === 'ar' ? 'يتجاوز الرصيد المستحق بمقدار' : 'Exceeds outstanding balance by'} {(parseFloat(spAmount) - supplierLedger.balance).toFixed(2)} {language === 'ar' ? 'ج.م' : 'L.E.'}
                            </div>
                          )}
                        </div>
                        <div className="flex-2 lg:w-1/3">
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">{language === 'ar' ? 'مرجع السداد / البيان' : 'Payment Reference / Memo'}</label>
                          <input
                            type="text" placeholder={language === 'ar' ? 'مرجع السداد أو البيان...' : 'Payment reference...'}
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl font-bold text-sm outline-none focus:border-blue-500 transition-all"
                            value={spMemo} onChange={e => setSpMemo(e.target.value)}
                          />
                        </div>
                        <div className="flex items-end">
                          <button
                            onClick={handleRecordPayment}
                            disabled={spLoading || !spAmount}
                            className={`px-8 py-4 rounded-xl font-black text-xs uppercase tracking-widest transition-all shadow-lg ${
                              spLoading || !spAmount ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-200'
                            }`}
                          >
                             {spLoading ? <i className="fa-solid fa-spinner fa-spin mr-2"></i> : <i className="fa-solid fa-paper-plane mr-2"></i>}
                             {language === 'ar' ? 'تسجيل' : 'Record'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Summary Cards */}
                  <div className="grid grid-cols-6 gap-4">
                    {[
                      { label: t('finance.supplier.totalOrdered'), value: supplierLedger.totalCommitted, color: 'blue', icon: 'fa-file-contract' },
                      { label: t('finance.supplier.totalReceivedValue'), value: supplierLedger.totalDelivered, color: 'emerald', icon: 'fa-truck-ramp-box' },
                      { label: t('finance.supplier.paidToSupplier'), value: supplierLedger.totalPaid, color: 'violet', icon: 'fa-money-bill-wave' },
                      {
                        label: t('finance.supplier.receivedBalance'),
                        value: (supplierLedger.totalPaid || 0) - (supplierLedger.totalDelivered || 0),
                        color: ((supplierLedger.totalPaid || 0) - (supplierLedger.totalDelivered || 0)) < 0 ? 'red' : 'emerald',
                        icon: 'fa-scale-balanced',
                        hint: language === 'ar' ? '(القيمة السالبة تعني أنه يحتاج أموالاً لبنود مستلمة)' : '(Negative means he needs more money for received items)'
                      },
                      { label: t('finance.supplier.futureExpectedPayment'), value: supplierLedger.pendingObligations, color: 'amber', icon: 'fa-hourglass-half', hint: language === 'ar' ? '(قيمة البنود التي لم يتم تسليمها بعد)' : '(Value of items not yet delivered)' },
                      {
                        label: t('finance.supplier.overallBalance'),
                        value: (supplierLedger.totalCommitted || 0) - (supplierLedger.totalPaid || 0),
                        color: ((supplierLedger.totalCommitted || 0) - (supplierLedger.totalPaid || 0)) < 0 ? 'red' : 'slate',
                        icon: 'fa-sigma',
                        hint: language === 'ar' ? '(موجب: مستحق | سالب: مدفوع بالزيادة)' : '(Positive: Owed | Negative: Overpaid)'
                      },
                    ].map((card, i) => (
                      <div key={i} className={`rounded-2xl border p-5 bg-${card.color}-50 border-${card.color}-100 flex flex-col justify-between`}>
                        <div>
                          <div className={`text-[10px] font-black uppercase tracking-widest text-${card.color}-400 mb-2 flex items-center gap-2`}>
                            <i className={`fa-solid ${card.icon}`}></i> {card.label}
                          </div>
                          <div className={`text-xl font-black text-${card.color}-700 tracking-tight`}>
                            {(card.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                          </div>
                        </div>
                        {card.hint && (
                          <div className={`text-[8px] font-bold text-${card.color}-400 mt-2 italic lowercase`}>
                            {card.hint}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Payment History */}
                  {supplierLedger.payments && supplierLedger.payments.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-black text-slate-700 uppercase tracking-tight flex items-center gap-2">
                        <i className="fa-solid fa-clock-rotate-left text-violet-500"></i> {t("finance.supplier.paymentHistory")}
                      </h3>
                      <div className="border border-slate-200 rounded-2xl overflow-x-auto">
                        <table className="w-full text-start">
                          <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                            <tr>
                              <th className="px-6 py-4">{t("common.date") || "Date"}</th>
                              <th className="px-6 py-4">{t("common.amount") || "Amount"}</th>
                              <th className="px-6 py-4">{t("common.memo") || "Memo"}</th>
                              <th className="px-6 py-4">{t("common.recordedBy") || "Recorded By"}</th>
                              <th className="px-6 py-4 w-10"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 italic">
                            {supplierLedger.payments.map((p: any) => (
                              <React.Fragment key={p.id}>
                                <tr className="hover:bg-slate-50/50 transition-colors cursor-pointer" onClick={() => setExpandedPaymentId(expandedPaymentId === p.id ? null : p.id)}>
                                  <td className="px-6 py-4 text-xs font-bold text-slate-600">{new Date(p.date).toLocaleDateString()}</td>
                                  <td className="px-6 py-4 text-sm font-black text-slate-800">{(p.amount || 0).toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}</td>
                                  <td className="px-6 py-4 text-xs font-medium text-slate-500 truncate max-w-xs">{p.memo || '-'}</td>
                                  <td className="px-6 py-4 text-xs font-bold text-slate-500 uppercase">{p.user || '-'}</td>
                                  <td className="px-6 py-4 text-end">
                                    <i className={`fa-solid fa-chevron-${expandedPaymentId === p.id ? 'up' : 'down'} text-slate-400 text-[10px]`}></i>
                                  </td>
                                </tr>
                                {expandedPaymentId === p.id && p.allocations && p.allocations.length > 0 && (
                                  <tr>
                                    <td colSpan={5} className="bg-slate-50/50 px-8 py-6">
                                      <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4 flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                                        {t("finance.ledger.paymentAllocation")}
                                      </div>
                                      <div className="bg-white border rounded-xl overflow-hidden shadow-sm">
                                        <table className="w-full text-start">
                                          <thead>
                                            <tr className="bg-slate-50 border-b border-slate-100 text-[9px] font-black uppercase text-slate-400 italic">
                                              <th className="px-4 py-3">{t("finance.supplier.poNumber")}</th>
                                              <th className="px-4 py-3">{t("finance.billing.description") || "Description"}</th>
                                              <th className="px-4 py-3 text-end">{t("finance.supplier.allocatedAmount") || "Allocated Amt"}</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-slate-50">
                                            {p.allocations.map((a: any, ai: number) => (
                                              <tr key={ai} className="hover:bg-slate-50/50 transition-colors text-xs font-bold">
                                                <td className="px-4 py-3 font-mono text-blue-600 uppercase">{a.orderNumber || '-'}</td>
                                                <td className="px-4 py-3 text-slate-600">{a.description}</td>
                                                <td className="px-4 py-3 text-end text-slate-800">{a.amount.toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
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

                  {/* Ledger Components */}
                  {supplierLedger.components && supplierLedger.components.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-black text-slate-700 uppercase tracking-tight flex items-center gap-2">
                        <i className="fa-solid fa-list-check text-emerald-500"></i> {t("finance.ledger.financialLedger")}
                      </h3>
                      <div className="border border-slate-200 rounded-2xl overflow-x-auto bg-white shadow-sm">
                        <table className="w-full text-start text-sm whitespace-nowrap">
                          <thead className="bg-slate-50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                            <tr>
                              <th className="px-6 py-4">{t("finance.supplier.poNumber")}</th>
                              <th className="px-6 py-4">{t("finance.billing.description") || "Description"}</th>
                              <th className="px-6 py-4 text-end">{t("finance.billing.qty") || "Qty"}</th>
                              <th className="px-6 py-4 text-end">{t("finance.supplier.unitCostLabel")}</th>
                              <th className="px-6 py-4 text-end">{t("finance.supplier.totalPO") || "Total (PO)"}</th>
                              <th className="px-6 py-4 text-end">{t("finance.supplier.deliveryValue") || "Deliv. Val"}</th>
                              <th className="px-6 py-4 text-end">{t("finance.supplier.allocated") || "Allocated"}</th>
                              <th className="px-6 py-4 text-end">{t("finance.supplier.balance") || "Balance"}</th>
                              <th className="px-6 py-4">{t("common.status") || "Status"}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {supplierLedger.components.map((c: any, ci: number) => (
                              <tr key={ci} className="hover:bg-slate-50 transition-colors group">
                                <td className="px-6 py-4">
                                  <div className="font-mono font-black text-blue-600 text-xs uppercase">{c.poNumber || 'N/A'}</div>
                                  <div className="text-[8px] font-bold text-slate-400 mt-0.5 uppercase tracking-tighter">{c.orderNumber}</div>
                                </td>
                                <td className="px-6 py-4">
                                  <div className="font-bold text-slate-800 text-xs truncate max-w-[200px]" title={c.description}>{c.description}</div>
                                  <div className="text-[8px] font-bold text-slate-400 uppercase italic mt-0.5">{c.supplierName}</div>
                                </td>
                                <td className="px-6 py-4 text-end font-bold text-slate-600">{c.quantity}</td>
                                <td className="px-6 py-4 text-end font-bold text-slate-500 text-xs">{(c.unitCost || 0).toLocaleString()}</td>
                                <td className="px-6 py-4 text-end font-black text-slate-800">{(c.totalCost || 0).toLocaleString()}</td>
                                <td className="px-6 py-4 text-end font-bold text-emerald-600 text-xs">{(c.deliveredValue || 0).toLocaleString()}</td>
                                <td className="px-6 py-4 text-end font-black text-violet-600 text-xs">{(c.allocatedPayments || 0).toLocaleString()}</td>
                                <td className="px-6 py-4 text-end font-black text-rose-600">{((c.totalCost || 0) - (c.allocatedPayments || 0)).toLocaleString()}</td>
                                <td className="px-6 py-4 text-xs font-black uppercase tracking-widest italic text-slate-400">{c.status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {selectedSupplierIds.length > 0 && !supplierLedger && !spLoading && (
                <div className="py-16 text-center text-slate-400">
                  <i className="fa-solid fa-box-open text-4xl mb-4"></i>
                  <div className="font-bold text-sm uppercase tracking-widest">{t("finance.supplier.noLedgerData") || (language === 'ar' ? 'لم يتم العثور على بيانات دفتر الأستاذ' : 'No detailed ledger data found')}</div>
                </div>
              )}
            </div>
          )}

          {/* PAYMENT POPUP MODAL (WITH FILE UPLOAD, OVERPAYMENT DETECTION & DOUBLE CONFIRMATION) */}
          {supplierPoPaymentModal && (
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200">
              <div className="bg-white rounded-[2rem] border border-slate-200 shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[92vh]">
                {/* Modal Header */}
                <div className="px-7 py-5 bg-gradient-to-r from-slate-900 to-indigo-950 text-white flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center text-lg">
                      <i className="fa-solid fa-money-bill-transfer"></i>
                    </div>
                    <div>
                      <h3 className="text-base font-black uppercase tracking-tight">{language === 'ar' ? 'تسجيل سداد للمورد' : 'Record Supplier Payment'}</h3>
                      <p className="text-[10px] text-slate-300 font-bold uppercase tracking-wider">
                        {language === 'ar' ? 'صرف وترحيل مباشر لدفتر الأستاذ العام وتسوية حسابات الدائنين' : 'Direct General Ledger Disbursement & AP Settlement'}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSupplierPoPaymentModal(null)}
                    className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-xs transition-colors cursor-pointer"
                  >
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>

                {/* Modal Body */}
                <div className="p-7 space-y-5 overflow-y-auto">
                  {/* PO Info Card */}
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <div>
                        <span className="text-[9px] font-black uppercase text-slate-400 block tracking-wider">{language === 'ar' ? 'المورد' : 'Supplier'}</span>
                        <span className="font-black text-slate-800 text-sm">{supplierPoPaymentModal.po.supplierName}</span>
                      </div>
                      <div className="text-end">
                        <span className="text-[9px] font-black uppercase text-slate-400 block tracking-wider">{language === 'ar' ? 'أمر شراء المورد' : 'Supplier PO #'}</span>
                        <span className="font-mono font-black text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 inline-block text-xs">
                          {supplierPoPaymentModal.po.poNumber}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200/60">
                      <div>
                        <span className="text-[9px] font-black uppercase text-slate-400 block tracking-wider">{language === 'ar' ? 'أمر شراء العميل' : 'Customer PO #'}</span>
                        <span className="font-mono font-bold text-slate-700">{supplierPoPaymentModal.po.customerReferenceNumber}</span>
                      </div>
                      <div className="text-end">
                        <span className="text-[9px] font-black uppercase text-slate-400 block tracking-wider">{language === 'ar' ? 'الطلب الداخلي' : 'Internal Order'}</span>
                        <span className="font-mono font-bold text-slate-600">{supplierPoPaymentModal.po.orderNumber}</span>
                      </div>
                    </div>

                    {/* Financial Summary Badges */}
                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200/60 text-center">
                      <div className="bg-white p-2 rounded-xl border border-slate-200">
                        <div className="text-[8px] font-black uppercase text-slate-400">{language === 'ar' ? 'إجمالي الأمر' : 'Total PO'}</div>
                        <div className="font-mono font-black text-slate-800 text-xs mt-0.5">
                          {supplierPoPaymentModal.po.grossTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                        </div>
                      </div>
                      <div className="bg-white p-2 rounded-xl border border-slate-200">
                        <div className="text-[8px] font-black uppercase text-emerald-600">{language === 'ar' ? 'المدفوع حتى تاريخه' : 'Paid to Date'}</div>
                        <div className="font-mono font-black text-emerald-700 text-xs mt-0.5">
                          {supplierPoPaymentModal.po.paidAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                        </div>
                      </div>
                      <div className="bg-white p-2 rounded-xl border border-slate-200">
                        <div className="text-[8px] font-black uppercase text-rose-600">{language === 'ar' ? 'الرصيد المتبقي' : 'Open Balance'}</div>
                        <div className="font-mono font-black text-rose-700 text-xs mt-0.5">
                          {supplierPoPaymentModal.po.balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'ج.م' : 'L.E.'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Payment Amount Input */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-700">
                        {language === 'ar' ? 'مبلغ السداد (ج.م)' : 'Payment Amount (L.E.)'} <span className="text-rose-500">*</span>
                      </label>
                      {supplierPoPaymentModal.po.balanceDue > 0 && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setSupplierPoPaymentModal(prev => prev ? {
                              ...prev,
                              amount: prev.po.balanceDue.toString()
                            } : null)}
                            className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors cursor-pointer"
                          >
                            {language === 'ar' ? 'كامل الرصيد' : 'Full Balance'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setSupplierPoPaymentModal(prev => prev ? {
                              ...prev,
                              amount: (Math.round((prev.po.balanceDue / 2) * 100) / 100).toString()
                            } : null)}
                            className="px-2 py-0.5 rounded text-[9px] font-black uppercase bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors cursor-pointer"
                          >
                            50%
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={supplierPoPaymentModal.amount}
                        onChange={e => {
                          const val = e.target.value;
                          setSupplierPoPaymentModal(prev => prev ? {
                            ...prev,
                            amount: val,
                            error: null,
                            doubleConfirmed: false
                          } : null);
                        }}
                        className="w-full px-4 py-3 bg-slate-50 border-2 border-slate-200 rounded-xl font-mono font-black text-base text-slate-900 outline-none focus:border-blue-500 focus:bg-white transition-all shadow-inner"
                      />
                      <span className="absolute right-4 top-1/2 -translate-y-1/2 font-black text-xs text-slate-400">
                        {language === 'ar' ? 'ج.م' : 'L.E.'}
                      </span>
                    </div>
                  </div>

                  {/* OVERPAYMENT WARNING & MANDATORY DOUBLE CONFIRMATION */}
                  {(() => {
                    const numAmt = parseFloat(supplierPoPaymentModal.amount);
                    const bal = supplierPoPaymentModal.po.balanceDue;
                    const isOverpaying = !isNaN(numAmt) && bal > 0 && numAmt > bal + 0.01;
                    const diff = isOverpaying ? (numAmt - bal).toFixed(2) : '0.00';

                    if (!isOverpaying) return null;

                    return (
                      <div className="p-4 bg-amber-50 border-2 border-amber-300 rounded-2xl space-y-3 animate-in fade-in duration-200 text-amber-950">
                        <div className="flex items-center gap-2">
                          <i className="fa-solid fa-triangle-exclamation text-amber-600 text-base"></i>
                          <span className="font-black text-xs uppercase tracking-tight">
                            {language === 'ar' ? 'إشعار تحذيري بزيادة السداد عن القيمة المستحقة' : 'Overpayment Warning Notice'}
                          </span>
                        </div>
                        <p className="text-xs font-bold leading-relaxed text-amber-900">
                          {language === 'ar' ? (
                            <>
                              لقد قمت بإدخال مبلغ <span className="font-mono font-black">{numAmt.toLocaleString()} ج.م</span>، وهو أعلى بمقدار <span className="font-mono font-black text-rose-700">{diff} ج.م</span> من رصيد أمر الشراء المتبقي البالغ <span className="font-mono font-black">{bal.toLocaleString()} ج.م</span>.
                              سيتم تسجيل المبلغ الزائد كدفعة مقدمة غير مخصصة في الحساب الدائن للمورد <span className="font-black">{supplierPoPaymentModal.po.supplierName}</span> بدفتر الأستاذ العام.
                            </>
                          ) : (
                            <>
                              You entered <span className="font-mono font-black">{numAmt.toLocaleString()} L.E.</span>, which is <span className="font-mono font-black text-rose-700">{diff} L.E.</span> higher than the remaining PO balance of <span className="font-mono font-black">{bal.toLocaleString()} L.E.</span>
                              The excess amount will be registered as an unallocated advance credit with <span className="font-black">{supplierPoPaymentModal.po.supplierName}</span> on their General Ledger.
                            </>
                          )}
                        </p>
                        <label className="flex items-start gap-3 p-2 bg-amber-100/60 rounded-xl cursor-pointer select-none border border-amber-200">
                          <input
                            type="checkbox"
                            checked={supplierPoPaymentModal.doubleConfirmed}
                            onChange={e => setSupplierPoPaymentModal(prev => prev ? {
                              ...prev,
                              doubleConfirmed: e.target.checked,
                              error: null
                            } : null)}
                            className="w-4 h-4 mt-0.5 rounded border-amber-400 text-amber-600 focus:ring-amber-500 cursor-pointer"
                          />
                          <span className="text-[11px] font-black uppercase text-amber-950">
                            {language === 'ar'
                              ? `أؤكد صراحةً سداد هذه الزيادة البالغة ${diff} ج.م ليتم إيداعها كرصيد دفعات مقدمة / دائن للمورد.`
                              : `I explicitly double-confirm this overpayment of ${diff} L.E. to be held as advance balance / supplier credit.`}
                          </span>
                        </label>
                      </div>
                    );
                  })()}

                  {/* Payment Date & Memo Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                        {language === 'ar' ? 'تاريخ السداد' : 'Payment Date'}
                      </label>
                      <input
                        type="date"
                        value={supplierPoPaymentModal.date}
                        onChange={e => setSupplierPoPaymentModal(prev => prev ? {
                          ...prev,
                          date: e.target.value
                        } : null)}
                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-xs outline-none focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                        {language === 'ar' ? 'مرجع السداد / البيان' : 'Payment Reference / Memo'}
                      </label>
                      <input
                        type="text"
                        value={supplierPoPaymentModal.memo}
                        onChange={e => setSupplierPoPaymentModal(prev => prev ? {
                          ...prev,
                          memo: e.target.value
                        } : null)}
                        placeholder={language === 'ar' ? 'رقم الإيصال أو الوصف...' : 'Ref # or description...'}
                        className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl font-bold text-xs outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  {/* Upload Receipt / Invoice */}
                  <div>
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-700 mb-1.5 block flex items-center justify-between">
                      <span>{language === 'ar' ? 'رفع إيصال / فاتورة المورد (اختياري)' : 'Upload Receipt / Invoice (Optional)'}</span>
                      <span className="text-slate-400 font-normal text-[9px]">PDF, PNG, JPG (Max 10MB)</span>
                    </label>

                    {supplierPoPaymentModal.receiptFile ? (
                      <div className="flex items-center justify-between p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                        <div className="flex items-center gap-2.5">
                          <i className="fa-solid fa-file-invoice text-emerald-600 text-lg"></i>
                          <div>
                            <div className="text-xs font-black text-emerald-900 truncate max-w-xs">
                              {supplierPoPaymentModal.receiptFileName || (language === 'ar' ? 'تم إرفاق ملف الإيصال' : 'Receipt File Attached')}
                            </div>
                            <div className="text-[9px] text-emerald-600 font-bold uppercase">
                              {language === 'ar' ? 'تم الإرفاق وجاهز للترحيل' : 'Attached & Ready to Post'}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSupplierPoPaymentModal(prev => prev ? {
                            ...prev,
                            receiptFile: null,
                            receiptFileName: null
                          } : null)}
                          className="px-2 py-1 rounded text-[10px] font-black uppercase bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 transition-colors"
                        >
                          {language === 'ar' ? 'إزالة' : 'Remove'}
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-200 hover:border-blue-400 bg-slate-50/60 hover:bg-blue-50/30 rounded-2xl cursor-pointer transition-all group">
                        <i className="fa-solid fa-cloud-arrow-up text-xl text-slate-400 group-hover:text-blue-500 transition-colors mb-1"></i>
                        <span className="text-xs font-black text-slate-600 group-hover:text-blue-700">
                          {language === 'ar' ? 'انقر لاختيار ملف الإيصال أو الفاتورة' : 'Click to select receipt or invoice file'}
                        </span>
                        <span className="text-[9px] text-slate-400 mt-0.5">
                          {language === 'ar' ? 'سيتم تشفير المستند وربطه بقيد دفتر الأستاذ العام' : 'Document will be encrypted & linked to general ledger entry'}
                        </span>
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          onChange={handleSupplierPoReceiptUpload}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>

                  {/* Error Banner */}
                  {supplierPoPaymentModal.error && (
                    <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold rounded-xl flex items-center gap-2">
                      <i className="fa-solid fa-circle-exclamation text-rose-500"></i>
                      <span>{supplierPoPaymentModal.error}</span>
                    </div>
                  )}
                </div>

                {/* Modal Footer */}
                <div className="px-7 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setSupplierPoPaymentModal(null)}
                    disabled={supplierPoPaymentModal.loading}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer"
                  >
                    {language === 'ar' ? 'إلغاء' : 'Cancel'}
                  </button>

                  <button
                    type="button"
                    onClick={handleSupplierPoPaymentSubmit}
                    disabled={
                      supplierPoPaymentModal.loading ||
                      !supplierPoPaymentModal.amount ||
                      (parseFloat(supplierPoPaymentModal.amount) > supplierPoPaymentModal.po.balanceDue &&
                       supplierPoPaymentModal.po.balanceDue > 0 &&
                       !supplierPoPaymentModal.doubleConfirmed)
                    }
                    className={`px-7 py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-lg flex items-center gap-2 ${
                      supplierPoPaymentModal.loading ||
                      !supplierPoPaymentModal.amount ||
                      (parseFloat(supplierPoPaymentModal.amount) > supplierPoPaymentModal.po.balanceDue &&
                       supplierPoPaymentModal.po.balanceDue > 0 &&
                       !supplierPoPaymentModal.doubleConfirmed)
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-200 cursor-pointer'
                    }`}
                  >
                    {supplierPoPaymentModal.loading ? (
                      <>
                        <i className="fa-solid fa-spinner fa-spin"></i>
                        <span>{language === 'ar' ? 'جاري ترحيل السداد...' : 'Posting Payment...'}</span>
                      </>
                    ) : (
                      <>
                        <i className="fa-solid fa-paper-plane"></i>
                        <span>{language === 'ar' ? 'تأكيد وترحيل لدفتر الأستاذ' : 'Confirm & Post to Ledger'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === 'tax_clearances' ? (
        <TaxClearancesView
          orders={orders}
          customers={customers}
          suppliers={suppliers}
          ledgerEntries={ledgerEntries}
          supplierPayments={supplierPayments}
          currentUser={currentUser}
          language={language}
          t={t}
          onRefresh={fetchData}
          getOrderProjectName={getOrderProjectName}
          getOrderCurrency={getOrderCurrency}
          getItemEffectiveQty={getItemEffectiveQty}
          getItemEffectiveStatus={getItemEffectiveStatus}
          getCustomerWalletBalance={getCustomerWalletBalance}
        />
      ) : activeTab !== 'ledger' && activeTab !== 'history' && activeTab !== 'contracts' && activeTab !== 'customer_wallets' && activeTab !== 'blanket_history' && activeTab !== 'stock_orders' ? (
      <div className="space-y-4">
        {activeTab === 'orders' && (
          <div className="space-y-3">
            {/* Header bar */}
            <div className="flex items-center justify-between gap-3 px-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black uppercase tracking-wider text-slate-700">
                  {language === 'ar' ? 'ملخص المركز المالي للطلبات النشطة' : 'Active Orders Financial Summary'}
                </span>
                <span className="text-[9px] font-bold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full uppercase">
                  {ordersSummaryMetrics.totalOrdersCount} {ordersSummaryMetrics.totalOrdersCount === 1 ? (language === 'ar' ? 'طلب' : 'Order') : (language === 'ar' ? 'طلبات' : 'Orders')}
                </span>
              </div>
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest hidden sm:block">
                {language === 'ar' ? 'معادلة التوازن: الأصول = الخصوم + الأرباح المحققة' : 'Equation: Assets = Liabilities + Realized Equity'}
              </div>
            </div>

            {/* 8 KPI Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2.5 sm:gap-3">
              {/* 1. Committed Gross Revenue */}
              <OrdersKPICard
                title={language === 'ar' ? 'قيمة الطلبات الإجمالية' : 'Committed Gross PO'}
                balloonTitle={language === 'ar' ? 'إجمالي قيمة الطلبات (شامل الضريبة)' : 'Total Committed PO Value (Gross / Inc. Tax)'}
                icon="fa-solid fa-file-invoice-dollar"
                iconColor="text-blue-600"
                bgBorderColor="bg-blue-50/70 border-blue-200"
                textColor="text-blue-950"
                value={`${ordersSummaryMetrics.totalGrossRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? `صافي: ${ordersSummaryMetrics.totalNetRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} ج.م` : `Net: ${ordersSummaryMetrics.totalNetRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} L.E.`}
                badge={language === 'ar' ? `${ordersSummaryMetrics.totalOrdersCount} أوامر شراء` : `${ordersSummaryMetrics.totalOrdersCount} POs`}
                badgeClass="bg-blue-100 text-blue-700"
                description={language === 'ar' ? 'إجمالي القيمة المالية لجميع أوامر شراء العملاء النشطة في خط الأنابيب، شاملاً ضريبة المبيعات 14% (ضريبة المخرجات).' : 'Total gross monetary value of all active customer Purchase Orders in the pipeline, inclusive of 14% sales tax (Output VAT).'}
                formula={language === 'ar' ? 'المعادلة: Σ (كمية البند × سعر الوحدة × 1.14)' : 'Formula: Σ (Item Qty × Unit Price × 1.14)'}
                alignBalloon="left"
              />

              {/* 2. Collections (PAID) */}
              <OrdersKPICard
                title={language === 'ar' ? 'التحصيلات النقدية' : 'Collections (Paid)'}
                balloonTitle={language === 'ar' ? 'التحصيلات النقدية المستلمة' : 'Customer Collections Received (Paid)'}
                icon="fa-solid fa-money-bill-transfer"
                iconColor="text-emerald-600"
                bgBorderColor="bg-emerald-50/70 border-emerald-200"
                textColor="text-emerald-950"
                value={`${ordersSummaryMetrics.totalPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? `محصل: ${((ordersSummaryMetrics.totalPaid / Math.max(1, ordersSummaryMetrics.totalGrossRevenue)) * 100).toFixed(1)}%` : `${((ordersSummaryMetrics.totalPaid / Math.max(1, ordersSummaryMetrics.totalGrossRevenue)) * 100).toFixed(1)}% Collected`}
                badge={language === 'ar' ? 'نقد وبنك' : 'Cash In'}
                badgeClass="bg-emerald-100 text-emerald-700"
                description={language === 'ar' ? 'إجمالي المدفوعات والتحصيلات النقدية والبنكية المستلمة فعلياً من العملاء مقابل هذه الأوامر النشطة حتى تاريخه.' : 'Actual cash and bank payments received from customers against these active purchase orders to date.'}
                formula={language === 'ar' ? 'المعادلة: Σ (مقبوضات العملاء المسجلة)' : 'Formula: Σ (Recorded Customer Receipts)'}
                alignBalloon="left"
              />

              {/* 3. Customer AR Due */}
              <OrdersKPICard
                title={language === 'ar' ? 'مستحقات العملاء (AR)' : 'Customer AR Due'}
                balloonTitle={language === 'ar' ? 'الذمم المدينة المستحقة على العملاء' : 'Outstanding Customer Receivables (AR)'}
                icon="fa-solid fa-clock-rotate-left"
                iconColor="text-amber-600"
                bgBorderColor="bg-amber-50/70 border-amber-200"
                textColor="text-amber-950"
                value={`${ordersSummaryMetrics.totalCustomerAR.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? 'فواتير قيد السداد' : 'Due on Invoices'}
                badge={language === 'ar' ? 'مدينون' : 'Receivable'}
                badgeClass="bg-amber-100 text-amber-700"
                description={language === 'ar' ? 'الذمم المدينة المستحقة نظاماً على العملاء بموجب فواتير ضريبية صادرة قيد الانتظار للتحصيل النقدي.' : 'Legally due receivables owed by customers for officially issued tax invoices awaiting cash collection.'}
                formula={language === 'ar' ? 'المعادلة: Σ (الفواتير الصادرة - المقبوضات)' : 'Formula: Σ (Invoiced Gross - Collected Cash)'}
                alignBalloon="left"
              />

              {/* 4. WIP Inventory Asset */}
              <OrdersKPICard
                title={language === 'ar' ? 'مخزون قيد التشغيل (WIP)' : 'WIP Inventory Asset'}
                balloonTitle={language === 'ar' ? 'أصل المخزون قيد التشغيل (WIP)' : 'Work-In-Progress Inventory Asset'}
                icon="fa-solid fa-boxes-stacked"
                iconColor="text-sky-600"
                bgBorderColor="bg-sky-50/70 border-sky-200"
                textColor="text-sky-950"
                value={`${ordersSummaryMetrics.totalWIP.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? 'تكاليف ما قبل الفوترة' : 'Pre-Invoice Sourced'}
                badge={language === 'ar' ? 'أصل' : 'Asset'}
                badgeClass="bg-sky-100 text-sky-700"
                description={language === 'ar' ? 'أصل المخزون قيد التشغيل: تكاليف الشراء والتصنيع المحملة على أوامر جارية قبل إصدار الفاتورة الضريبية للعميل. تتحول إلى تكلفة بضاعة مباعة (COGS) فور الفوترة.' : 'Work-In-Progress Asset: Sourced procurement and manufacturing costs incurred for orders currently in progress before issuing customer invoices. Transforms into COGS upon invoicing.'}
                formula={language === 'ar' ? 'المعادلة: Σ (تكاليف الشراء للأوامر غير المفوترة)' : 'Formula: Σ (Sourced Costs on Uninvoiced Orders)'}
                alignBalloon="center"
              />

              {/* 5. Committed Supplier AP */}
              <OrdersKPICard
                title={language === 'ar' ? 'مستحقات الموردين (AP)' : 'Committed Supplier AP'}
                balloonTitle={language === 'ar' ? 'حسابات الموردين الدائنة الملتزم بها' : 'Committed Supplier Accounts Payable'}
                icon="fa-solid fa-truck-ramp-box"
                iconColor="text-purple-600"
                bgBorderColor="bg-purple-50/70 border-purple-200"
                textColor="text-purple-950"
                value={`${ordersSummaryMetrics.totalSupplierAP.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? 'التزامات للموردين' : 'Owed for Sourced Parts'}
                badge={language === 'ar' ? 'دائنون' : 'Payable'}
                badgeClass="bg-purple-100 text-purple-700"
                description={language === 'ar' ? 'حسابات الموردين الدائنة: إجمالي الالتزامات المستحقة أو الملتزم بها للموردين عن المكونات والخدمات المنفذة لهذه الأوامر.' : 'Accounts Payable: Total obligations committed or owed to suppliers for materials, components, and outsourced services across active orders.'}
                formula={language === 'ar' ? 'المعادلة: Σ (إجمالي تكلفة الشراء - سدادات الموردين)' : 'Formula: Σ (Gross Sourced Cost - Supplier Payments)'}
                alignBalloon="center"
              />

              {/* 6. Customer Advances (Adv) */}
              <OrdersKPICard
                title={language === 'ar' ? 'دفعات مقدمة (Adv)' : 'Customer Advances (Adv)'}
                balloonTitle={language === 'ar' ? 'الدفعات المقدمة من العملاء' : 'Customer Advance Prepayments Held'}
                icon="fa-solid fa-vault"
                iconColor="text-indigo-600"
                bgBorderColor="bg-indigo-50/70 border-indigo-200"
                textColor="text-indigo-950"
                value={`${ordersSummaryMetrics.totalCustomerAdvances.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? 'إيراد غير مكتسب' : 'Unearned Revenue Liab'}
                badge={language === 'ar' ? 'التزام' : 'Liability'}
                badgeClass="bg-indigo-100 text-indigo-700"
                description={language === 'ar' ? 'الدفعات المقدمة: مبالغ نقدية محصلة من العملاء قبل إصدار الفواتير الضريبية، وتسجل كالتزام في الميزانية لحين التسليم وإصدار الفاتورة.' : 'Customer Prepayments: Unearned cash collected from customers prior to tax invoice generation, held as a balance sheet liability until delivery and billing.'}
                formula={language === 'ar' ? 'المعادلة: Σ (مقبوضات الأوامر غير المفوترة)' : 'Formula: Σ (Pre-Invoice Cash Collections)'}
                alignBalloon="right"
              />

              {/* 7. Net VAT Balance */}
              <OrdersKPICard
                title={language === 'ar' ? 'رصيد القيمة المضافة' : 'Net VAT Balance (ETA)'}
                balloonTitle={language === 'ar' ? 'صافي تسوية ضريبة القيمة المضافة' : 'Net VAT Settlement Position'}
                icon="fa-solid fa-landmark"
                iconColor="text-teal-600"
                bgBorderColor="bg-teal-50/70 border-teal-200"
                textColor="text-teal-950"
                value={`${ordersSummaryMetrics.totalNetTaxOwed >= 0 ? '+' : ''}${ordersSummaryMetrics.totalNetTaxOwed.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                subtext={language === 'ar' ? `مخرجات: ${ordersSummaryMetrics.totalRecognizedOutputTax.toLocaleString(undefined, { maximumFractionDigits: 0 })} | مدخلات: ${ordersSummaryMetrics.totalInputTax.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `Out: ${ordersSummaryMetrics.totalRecognizedOutputTax.toLocaleString(undefined, { maximumFractionDigits: 0 })} | In: ${ordersSummaryMetrics.totalInputTax.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
                badge={ordersSummaryMetrics.totalNetTaxOwed >= 0 ? (language === 'ar' ? 'مستحق سداد' : 'Payable') : (language === 'ar' ? 'رصيد دائن' : 'Credit')}
                badgeClass={ordersSummaryMetrics.totalNetTaxOwed >= 0 ? 'bg-amber-100 text-amber-700' : 'bg-teal-100 text-teal-700'}
                description={language === 'ar' ? 'موقف ضريبة القيمة المضافة: ضريبة المخرجات المحققة من فواتير العملاء مخصوماً منها ضريبة المدخلات من فواتير الموردين. القيمة الموجبة تعني ضريبة واجبة السداد لمصلحة الضرائب، والسالبة تعني رصيد دائن مسترد.' : 'Net VAT Position: Recognized Output Tax billed to customers minus deductible Input Tax paid on supplier purchases. Positive indicates tax payable to Egyptian Tax Authority; negative indicates refundable tax credit.'}
                formula={language === 'ar' ? 'المعادلة: ضريبة المخرجات المحققة - ضريبة المدخلات المخصومة' : 'Formula: Recognized Output VAT - Deductible Input VAT'}
                alignBalloon="right"
              />

              {/* 8. Double-Entry Variance */}
              <OrdersKPICard
                title={language === 'ar' ? 'مطابقة القيد المزدوج' : 'Double-Entry Variance'}
                balloonTitle={language === 'ar' ? 'توازن القيد المزدوج والأرباح المحققة' : 'Double-Entry Equilibrium & Variance'}
                icon="fa-solid fa-scale-balanced"
                iconColor={ordersSummaryMetrics.isOverallBalanced ? 'text-emerald-600' : 'text-rose-600'}
                bgBorderColor={ordersSummaryMetrics.isOverallBalanced ? 'bg-emerald-50/70 border-emerald-300' : 'bg-rose-50/70 border-rose-300'}
                textColor={ordersSummaryMetrics.isOverallBalanced ? 'text-emerald-950' : 'text-rose-950'}
                value={ordersSummaryMetrics.isOverallBalanced ? (language === 'ar' ? 'فارق 0.00 ✓ متطابق' : '0.00 Variance ✓') : (language === 'ar' ? `فارق ${ordersSummaryMetrics.totalVariance.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : `${ordersSummaryMetrics.totalVariance.toLocaleString(undefined, { maximumFractionDigits: 0 })} Variance`)}
                subtext={language === 'ar' ? `أرباح محققة: +${ordersSummaryMetrics.totalRealizedProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })} ج.م` : `Realized Profit: +${ordersSummaryMetrics.totalRealizedProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })} L.E.`}
                badge={language === 'ar' ? `${ordersSummaryMetrics.balancedOrdersCount}/${ordersSummaryMetrics.totalOrdersCount} متطابق` : `${ordersSummaryMetrics.balancedOrdersCount}/${ordersSummaryMetrics.totalOrdersCount} OK`}
                badgeClass={ordersSummaryMetrics.isOverallBalanced ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}
                description={language === 'ar' ? 'مطابقة القيد المزدوج: التحقق من معادلة التوازن المحاسبي (الأصول = الخصوم + الربح المحقق). التباين 0.00 يؤكد توازن الدفاتر المحاسبية بالكامل.' : 'Double-Entry Verification: Checks that Total Assets (Cash + AR + WIP) exactly equal Total Liabilities + Realized Equity (AP + Advances + Net VAT + Realized Profit). A variance of 0.00 mathematically proves balanced books.'}
                formula={language === 'ar' ? 'المعادلة: الأصول (نقدية+مدينون+WIP) = الخصوم (دائنون+دفعات+ضريبة) + الربح' : 'Equation: Assets (Cash + AR + WIP) === Liab (AP + Adv + Tax) + Realized Profit'}
                alignBalloon="right"
              />
            </div>
          </div>
        )}

        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-x-auto min-h-[60vh]">
        <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
          <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-white/5">
            <tr>
              {activeTab === 'blacklist_hold' ? (
                <>
                  <th className="px-4 py-3.5 text-white">{t("finance.orders.operationalContext") || "Operational Context"}</th>
                  <th className="px-4 py-3.5 text-white cursor-pointer select-none" onClick={() => handleSort('name')}>
                    {t("finance.entities.entityType")} {sortConfig.key === 'name' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                  </th>
                  <th className="px-4 py-3.5 text-white">{t("finance.orders.accountStatus") || "Account Status"}</th>
                  <th className="px-4 py-3.5 text-white text-end">{t("finance.orders.creditAction") || "Credit Action"}</th>
                </>
              ) : (
                <>
                  {columnOrder.map(col => {
                    if (col === 'context') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-4 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('internalOrderNumber')}>
                        {t("finance.orders.operationalContext") || 'Operational Context'} {sortConfig.key === 'internalOrderNumber' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'date') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-3 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('orderDate')}>
                        {t("finance.orders.orderDate") || 'Order Date'} {sortConfig.key === 'orderDate' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'currency') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-2.5 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('currency')}>
                        {language === 'ar' ? 'العملة' : 'Currency'} {sortConfig.key === 'currency' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'revenue') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-3.5 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('grossRevenue')}>
                        {t("finance.orders.revenueMetrics") || 'Revenue Metrics'} {sortConfig.key === 'grossRevenue' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'markup') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-3 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('markupPct')}>
                        {t("finance.orders.markupAnalysis") || 'Markup Analysis'} {sortConfig.key === 'markupPct' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'status') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-3 py-3.5 text-white cursor-pointer select-none transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`} onClick={() => handleSort('status')}>
                        {t("finance.orders.slaStatus") || 'SLA / Status'} {sortConfig.key === 'status' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '⇅'}
                      </th>
                    );
                    if (col === 'actions') return (
                      <th key={col} draggable onDragStart={e => handleDragStart(e, col)} onDragOver={e => handleDragOver(e, col)} onDrop={e => handleDrop(e, col)} className={`px-4 py-3.5 text-white text-right transition-all ${dragOverCol === col ? 'bg-white/10' : ''}`}>
                        {t("finance.orders.authActions") || 'Auth Actions'}
                      </th>
                    );
                    return null;
                  })}
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {activeTab === 'blacklist_hold' ? (
              <>
                {[...customers].filter(c => c.name.trim().toLowerCase() !== 'internal stock').sort((a, b) => {
                  const valA = (a.name || '').toLowerCase();
                  const valB = (b.name || '').toLowerCase();
                  if (sortConfig.key !== 'name') return 0;
                  if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                  if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                  return 0;
                }).map(c => (
                  <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-4">
                      <div className="font-black text-slate-800">{c.name}</div>
                      <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">{t("finance.orders.customerAccount") || "Customer Account"}</div>
                    </td>
                    <td className="px-4 py-4 text-xs font-bold text-slate-500 uppercase tracking-tighter">{t("finance.entities.clientRelations")}</td>
                    <td className="px-4 py-4">
                      <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${c.isHold ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                        {c.isHold ? t("finance.entities.creditHold") : t("finance.entities.accountActive")}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-end">
                      <button onClick={() => setDecisionModal({ type: 'customerHold', entityId: c.id, entityName: c.name, currentValue: c.isHold })} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${c.isHold ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-rose-600 text-white hover:bg-rose-700'}`}>
                        {c.isHold ? t("finance.entities.releaseHold") : t("finance.entities.engageCreditHold")}
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
                    <td className="px-4 py-4">
                      <div className="font-black text-slate-800">{s.name}</div>
                      <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">{language === 'ar' ? 'حساب المورد' : 'Vendor Account'}</div>
                    </td>
                    <td className="px-4 py-4 text-xs font-bold text-slate-500 uppercase tracking-tighter">{t("finance.entities.vendorRelations")}</td>
                    <td className="px-4 py-4">
                      <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${s.isHold ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                        {s.isHold ? t("finance.entities.creditHold") : t("finance.entities.accountActive")}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-end">
                      <button onClick={() => setDecisionModal({ type: 'supplierHold', entityId: s.id, entityName: s.name, currentValue: s.isHold })} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${s.isHold ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-rose-600 text-white hover:bg-rose-700'}`}>
                        {s.isHold ? t("finance.entities.releaseHold") : t("finance.entities.engageCreditHold")}
                      </button>
                    </td>
                  </tr>
                ))}
              </>
            ) : (() => {
              const renderOrderRowContent = (o: CustomerOrder, orderIdx: number) => {
                const pl = (o as any).pl || getPL(o);
                const isBlanketOrder = !!(o.blanketOrder || o.contractId || o.blanketContractId);
                const showBlanketBadge = isBlanketOrder && isOrderNoRfpNeeded(o);
                const isBreach = !isBlanketOrder && isMarginBreach(pl.costInOrderCurrency ?? pl.cost, pl.markupPct, config.settings.minimumMarginPct);
                const showRow = activeTab === 'orders';

                if (!showRow) return null;

                const isInvoicedOrLater = [OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.DELIVERED].includes(o.status);

                let totalAuthorizedGross = 0;
                let draftSum = 0;
                o.items.forEach(it => {
                  totalAuthorizedGross += (it.approvedForDispatchQty || 0) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
                  const draftQty = parseFloat(dispatchReceiptInputs[it.id]) || 0;
                  draftSum += draftQty * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100));
                });

                const isExpanded = Boolean(expandedOrderIds[o.id]);
                const isEvenRow = orderIdx % 2 === 1;
                const rowBg = o.status === OrderStatus.NEGATIVE_MARGIN
                  ? 'bg-rose-50/30'
                  : isExpanded
                  ? 'bg-blue-50/30'
                  : isEvenRow
                  ? 'bg-slate-100/60'
                  : 'bg-white';

                return (
                  <React.Fragment key={o.id}>
                    <tr 
                      onClick={() => toggleOrderExpand(o.id)}
                      className={`${rowBg} hover:bg-blue-50/60 transition-colors cursor-pointer select-none border-b border-slate-100`}
                    >
                      {columnOrder.map(col => {
                        if (col === 'context') return (
                          <td key={col} className="px-4 py-3">
                            <div className="font-mono text-[10px] font-black text-blue-600 uppercase flex items-center gap-2 flex-nowrap whitespace-nowrap">
                              <span className="whitespace-nowrap shrink-0">{o.internalOrderNumber}</span>
                              {o.customerReferenceNumber && (
                                <span className="text-slate-500 font-bold normal-case text-[9px] bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200 whitespace-nowrap shrink-0">
                                  {language === 'ar' ? 'أمر شراء:' : 'PO:'} {o.customerReferenceNumber}
                                </span>
                              )}
                              {(() => {
                                const proj = getOrderProjectName(o);
                                return proj ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap shrink-0">
                                    <i className="fa-solid fa-diagram-project text-[9px] text-violet-500"></i>
                                    {language === 'ar' ? 'مشروع:' : 'Project:'} {proj}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200 text-[9px] font-bold uppercase tracking-tight whitespace-nowrap shrink-0">
                                    <i className="fa-solid fa-folder-minus text-[9px] text-slate-400"></i>
                                    {language === 'ar' ? 'بدون مشروع' : 'Non-Project'}
                                  </span>
                                );
                              })()}
                              {(() => {
                                const poType = showBlanketBadge ? 'Blanket' : getOrderPoType(o);
                                const cfg = getPoTypeConfig(poType);
                                return (
                                  <span
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${cfg.badgeClass} border text-[9px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap shrink-0`}
                                    title={cfg.label}
                                  >
                                    <i className={`fa-solid ${cfg.icon} text-[8px]`}></i> {cfg.shortLabel}
                                  </span>
                                );
                              })()}
                            </div>
                            <div className="font-bold text-slate-800 text-sm tracking-tight mt-1 flex items-center gap-2 flex-wrap">
                              <span>{o.customerName}</span>
                              {o.items.some(i => getItemEffectiveStatus(i) !== o.status && !['MIXED', 'NO_COMPONENTS'].includes(getItemEffectiveStatus(i))) && (
                                <span className="px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded text-[8px] uppercase font-bold" title="Mixed Line-Item Statuses">{language === 'ar' ? 'مختلط' : 'Mixed'}</span>
                              )}
                              <span className="text-[9px] text-slate-500 font-bold uppercase inline-flex items-center gap-1.5 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200 whitespace-nowrap shrink-0">
                                <span className="whitespace-nowrap">{o.items.length} {o.items.length === 1 ? (language === 'ar' ? 'بند' : 'item') : (language === 'ar' ? 'بنود' : 'items')}</span>
                                <span className="text-slate-300">•</span>
                                <span className="text-blue-600 font-black inline-flex items-center gap-1 hover:text-blue-700 whitespace-nowrap">
                                  {isExpanded ? (language === 'ar' ? 'انقر للطي' : 'Click to collapse') : (language === 'ar' ? 'توسيع لعرض المكونات' : 'Expand to show components')}
                                  <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px]`}></i>
                                </span>
                              </span>
                              {!isBlanketOrder && (() => {
                                const custWallet = getCustomerWalletBalance(o.customerName);
                                return (
                                  <span
                                    className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-tight border shadow-2xs ${
                                      custWallet > 0
                                        ? 'bg-teal-50 border-teal-200 text-teal-800'
                                        : custWallet < 0
                                        ? 'bg-rose-50 border-rose-200 text-rose-800'
                                        : 'bg-slate-50 border-slate-200 text-slate-600'
                                    }`}
                                    title={`Customer Wallet for ${o.customerName}: ${custWallet.toLocaleString()} L.E.`}
                                  >
                                    <i className={`fa-solid fa-user-tag text-[8px] ${custWallet > 0 ? 'text-teal-600' : custWallet < 0 ? 'text-rose-600' : 'text-slate-400'}`}></i>
                                    <span>{language === 'ar' ? 'محفظة العميل:' : 'Customer Wallet:'}</span>
                                    <span className="font-mono font-black">
                                      {custWallet > 0 ? (language === 'ar' ? `+${custWallet.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م` : `+${custWallet.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.`) : custWallet < 0 ? (language === 'ar' ? `-${Math.abs(custWallet).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م (دين)` : `-${Math.abs(custWallet).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E. (Debt)`) : (language === 'ar' ? '0.00 ج.م' : '0.00 L.E.')}
                                    </span>
                                  </span>
                                );
                              })()}
                            </div>
                            {(o.isSettlingOrder || o.blanketContractId || o.invoiceNumber) && (
                              <div className="mt-1 flex items-center gap-2 flex-wrap text-[9px]">
                                {o.isSettlingOrder && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded text-[8px] font-black uppercase">
                                    <i className="fa-solid fa-link"></i> {language === 'ar' ? 'تسوية إطارية' : 'Blanket Settling'}
                                  </span>
                                )}
                                {o.blanketContractId && (
                                  <span className="font-mono font-black text-indigo-500 uppercase">{language === 'ar' ? 'العقد:' : 'Contract:'} {o.blanketContractId}</span>
                                )}
                                {o.invoiceNumber && (
                                  <span className="font-black text-emerald-600 uppercase">{language === 'ar' ? 'فاتورة ضريبية:' : 'Tax Invoice:'} {o.invoiceNumber}</span>
                                )}
                              </div>
                            )}
                          </td>
                        );
                        if (col === 'date') return (
                          <td key={col} className="px-3 py-4">
                            <div className="text-xs font-black text-slate-700 uppercase tracking-tighter">
                              {o.orderDate ? new Date(o.orderDate).toLocaleDateString() : 'N/A'}
                            </div>
                            <div className="text-[9px] text-slate-400 font-bold mt-1">{t("finance.tax.acquisitionDate") || "Acquisition Date"}</div>
                          </td>
                        );
                        if (col === 'currency') return (
                          <td key={col} className="px-2.5 py-4" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-1">
                              <span className="px-2 py-0.5 rounded-md bg-slate-900 text-white text-[9px] font-black uppercase">{pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                              <div className="text-[8px] text-slate-400 font-bold uppercase tracking-widest leading-tight">
                                <div>{language === 'ar' ? 'تحويل' : 'Conv.'}</div>
                                <input
                                  type="number"
                                  step="any"
                                  min="0"
                                  className="w-16 px-1 py-0.5 mt-0.5 border border-slate-200 rounded-md text-[9px] font-black text-slate-700 outline-none focus:border-blue-500"
                                  defaultValue={pl.conversionRate}
                                  title="Multiplier to bring PO cost into the order's revenue currency. Used only for the P/L threshold check. Default 1 = no conversion."
                                  onBlur={async (e) => {
                                    const v = parseFloat(e.target.value);
                                    const next = (!Number.isFinite(v) || v <= 0) ? 1 : v;
                                    if (next === pl.conversionRate) return;
                                    try {
                                      await dataService.updateOrder(o.id, { conversionRate: next });
                                      await fetchData();
                                    } catch (err) {
                                      // ignore
                                    }
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                        );
                        if (col === 'revenue') return (
                          <td key={col} className="px-3.5 py-4">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-black text-slate-800 text-xs">
                                  {pl.grossRevenue.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}
                                </span>
                                <span className="text-[9px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.2 rounded" title="Contract / Quoted Net Revenue excluding VAT">
                                  {language === 'ar' ? 'الصافي:' : 'Net:'} {pl.revenue.toLocaleString()}
                                </span>
                              </div>
                              <div className="text-[9px] font-bold flex items-center gap-1.5 flex-wrap">
                                {pl.paid > 0 ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setViewPaymentsOrder(o);
                                    }}
                                    className="text-emerald-700 hover:text-emerald-900 font-black inline-flex items-center gap-1 hover:underline cursor-pointer bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/60"
                                    title="Click to view payment history & download receipts"
                                  >
                                    <span>{language === 'ar' ? 'المدفوع:' : 'Paid:'} {pl.paid.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                    <i className="fa-solid fa-receipt text-[8px]"></i>
                                  </button>
                                ) : (
                                  <span className="text-slate-400">{language === 'ar' ? 'المدفوع: 0' : 'Paid: 0'}</span>
                                )}
                                <span>•</span>
                                {pl.isInvoiced ? (
                                  pl.customerAR > 0 ? (
                                    <span className="text-rose-600 font-black bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200/60" title="Accounts Receivable (Unpaid debt on invoice)">
                                      {language === 'ar' ? 'مستحق:' : 'AR:'} {pl.customerAR.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}
                                    </span>
                                  ) : (
                                    <span className="text-emerald-600 font-black bg-emerald-50 px-1.5 py-0.5 rounded">
                                      {language === 'ar' ? 'مدفوع بالكامل ✓' : 'Paid in Full ✓'}
                                    </span>
                                  )
                                ) : (
                                  pl.customerAdvance > 0 ? (
                                    <span className="text-blue-600 font-black bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200/60" title="Advance Prepayment received prior to issuing official invoice (Held as liability)">
                                      {language === 'ar' ? 'دفعة مقدمة:' : 'Adv:'} {pl.customerAdvance.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400 font-semibold">{language === 'ar' ? 'غير مفوتر' : 'Uninvoiced'}</span>
                                  )
                                )}
                              </div>
                              <div className="text-[8px] text-slate-400 font-bold flex items-center gap-1 flex-wrap">
                                <span>{language === 'ar' ? 'الضريبة:' : 'VAT:'} {pl.outputTax.toFixed(2)}</span>
                                <span className={`px-1 py-0.2 rounded text-[7px] font-black uppercase ${pl.isInvoiced ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                                  {pl.isInvoiced ? (language === 'ar' ? 'معترف بها' : 'Recognized') : (language === 'ar' ? 'تقديرية' : 'Quoted')}
                                </span>
                              </div>
                            </div>
                          </td>
                        );
                        if (col === 'markup') return (
                          <td key={col} className="px-3 py-4">
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <div className={`px-2 py-0.5 rounded-lg border text-[10px] font-black shadow-xs ${isBreach ? 'bg-rose-50 border-rose-200 text-rose-600' : 'bg-emerald-50 border-emerald-200 text-emerald-600'}`}>
                                  {pl.markupPct.toFixed(1)}% {language === 'ar' ? 'هامش إضافة' : 'Markup'}
                                </div>
                                <span className="text-[9px] font-bold text-slate-400">({pl.marginPct.toFixed(1)}% {language === 'ar' ? 'ربحية' : 'Mgn'})</span>
                              </div>
                              <div className="text-[9px] font-bold flex items-center gap-1 flex-wrap">
                                {pl.isInvoiced ? (
                                  <span className="text-emerald-700 font-black bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/60 flex items-center gap-1" title="Realized Profit recognized upon issuing invoice">
                                    <i className="fa-solid fa-circle-check text-[8px]"></i>
                                    {language === 'ar' ? 'الربح:' : 'Profit:'} {pl.realizedProfit.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}
                                  </span>
                                ) : (
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <span className="text-amber-700 font-black bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200/60" title="Pre-invoicing costs held in Work In Progress (WIP) inventory asset">
                                      {language === 'ar' ? 'قيد التشغيل:' : 'WIP:'} {pl.wip.toLocaleString()}
                                    </span>
                                    <span className="text-slate-500 text-[8px]" title="Projected pipeline profit upon invoicing">
                                      {language === 'ar' ? 'متوقع:' : 'Est:'} {pl.projectedProfit.toLocaleString()}
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="text-[8px] text-slate-400 font-bold flex items-center gap-1 flex-wrap">
                                <span>{language === 'ar' ? 'دائنو الموردين:' : 'Supp. AP:'} {pl.supplierAP.toLocaleString()}</span>
                                {pl.isPoBalanced && (
                                  <span className="text-emerald-600 text-[8px] ml-auto font-black" title="Double-entry balance verified: Assets = Liabilities + Profit">
                                    <i className="fa-solid fa-shield-halved"></i> {language === 'ar' ? 'متوازن' : 'Balanced'}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                        );
                        if (col === 'status') {
                          const isExceedingPayment = (totalAuthorizedGross + draftSum) > pl.paid + 0.01;
                          return (
                            <td key={col} className="px-3 py-4">
                              <div className="flex flex-col gap-1.5">
                                <div className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border w-fit bg-${getDynamicOrderStatusStyle(o, config).color}-50 text-${getDynamicOrderStatusStyle(o, config).color}-600 border-${getDynamicOrderStatusStyle(o, config).color}-100`}>
                                  {getDynamicOrderStatusStyle(o, config).label}
                                </div>
                                {isExceedingPayment && (
                                  <div className="px-2 py-0.5 bg-rose-600 text-white text-[8px] font-black uppercase rounded animate-pulse flex items-center gap-1 shadow-sm shadow-rose-200">
                                    <i className="fa-solid fa-triangle-exclamation"></i>
                                    {language === 'ar' ? 'التسليم يتجاوز المدفوع' : 'Dispatch Exceeds Payment'}
                                  </div>
                                )}
                                <ThresholdSentinel order={o} config={config} />
                              </div>
                            </td>
                          );
                        }
                        if (col === 'actions') return (
                          <td key={col} className="px-3 py-3 text-end" onClick={e => e.stopPropagation()}>
                            <div className="flex justify-end gap-1.5 items-center flex-nowrap">
                              {isInvoicedOrLater && (
                                <>
                                  <button
                                    onClick={() => handleDownloadInvoice(o)}
                                    className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center hover:bg-blue-100 transition-all border border-blue-200 shrink-0"
                                    title="Download Tax Invoice"
                                  >
                                    {isDownloading && printOrder?.id === o.id ? <i className="fa-solid fa-circle-notch fa-spin text-xs"></i> : <i className="fa-solid fa-file-arrow-down text-xs"></i>}
                                  </button>
                                  <button
                                    onClick={() => setDecisionModal({ type: 'cancelInvoice', entityId: o.id, entityName: o.internalOrderNumber })}
                                    className="w-8 h-8 bg-rose-50 text-rose-600 border border-rose-200 rounded-lg text-[8px] font-black uppercase hover:bg-rose-100 transition-all flex flex-col items-center justify-center text-center leading-none shrink-0"
                                    title="Void current invoice and return to Billing stage"
                                  >
                                    <i className="fa-solid fa-file-circle-xmark text-[10px] mb-0.5"></i>
                                    <span>{language === 'ar' ? 'إلغاء' : 'Void'}</span>
                                  </button>
                                </>
                              )}
                              {o.status === OrderStatus.NEGATIVE_MARGIN && (
                                <button
                                  onClick={() => setDecisionModal({ type: 'marginRelease', entityId: o.id, entityName: o.internalOrderNumber })}
                                  className="px-1.5 py-1 min-h-[32px] bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[8px] font-black uppercase shadow-sm shadow-rose-200 shrink-0 flex flex-col items-center justify-center text-center leading-tight"
                                  title="Force Margin Authorization"
                                >
                                  <span>{language === 'ar' ? 'اعتماد' : 'Force'}</span>
                                  <span>{language === 'ar' ? 'إجباري' : 'Auth'}</span>
                                </button>
                              )}
                              <button
                                onClick={() => setDecisionModal({ type: 'billing', entityId: o.id, entityName: o.internalOrderNumber })}
                                className="px-2 py-1 min-h-[32px] bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[8px] font-black uppercase shadow-sm shadow-blue-200 shrink-0 flex flex-col items-center justify-center text-center leading-tight transition-all"
                                title="Generate Tax Invoice"
                              >
                                <i className="fa-solid fa-file-invoice text-[9px]"></i>
                                <span className="mt-0.5">{language === 'ar' ? 'إصدار' : 'Generate'}</span>
                                <span>{language === 'ar' ? 'فاتورة' : 'Invoice'}</span>
                              </button>
                              <button
                                onClick={() => {
                                  setDecisionModal({ type: 'payment', entityId: o.id, entityName: o.internalOrderNumber });
                                  setPaymentAmount(pl.outstanding > 0 ? pl.outstanding.toFixed(2) : '');
                                }}
                                className="px-2 py-1 min-h-[32px] bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[8px] font-black uppercase shadow-sm shadow-emerald-200 shrink-0 flex flex-col items-center justify-center text-center leading-tight transition-all cursor-pointer"
                                title={t("finance.orders.receivePayment") || "Receive Payment"}
                              >
                                <i className="fa-solid fa-money-bill-wave text-[9px]"></i>
                                <span className="mt-0.5">{language === 'ar' ? 'استلام' : 'Receive'}</span>
                                <span>{language === 'ar' ? 'دفعة' : 'Payment'}</span>
                              </button>
                              <div className="flex gap-1 items-center shrink-0">
                                {!o.einvoiceRequested && (
                                  <button
                                    onClick={async () => {
                                      if (window.confirm(`Request official Gov. E-Invoice for ${o.internalOrderNumber}?`)) {
                                        await dataService.requestEInvoice(o.id);
                                        fetchData();
                                      }
                                    }}
                                    className="w-8 h-8 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[8px] font-black uppercase shadow-sm transition-all shrink-0 flex flex-col items-center justify-center text-center leading-none"
                                    title="Request Gov. E-Invoice"
                                  >
                                    <i className="fa-solid fa-landmark text-[10px] mb-0.5"></i>
                                    <span>{language === 'ar' ? 'حكومي' : 'Gov'}</span>
                                  </button>
                                )}
                                {o.einvoiceRequested && !o.einvoiceFile && (
                                  <span className="w-8 h-8 bg-amber-50 text-amber-600 border border-amber-200 rounded-lg text-[8px] font-black uppercase flex items-center justify-center shrink-0" title="Gov Invoice Requested">
                                    <i className="fa-solid fa-clock"></i>
                                  </span>
                                )}
                                <button onClick={() => setDecisionModal({ type: 'orderHold', entityId: o.id, entityName: o.internalOrderNumber, currentValue: o.status === OrderStatus.IN_HOLD })} className="p-1 text-slate-300 hover:text-amber-500 transition-colors shrink-0" title="Toggle Hold"><i className="fa-solid fa-hand text-xs"></i></button>
                                <button onClick={() => setDecisionModal({ type: 'orderReject', entityId: o.id, entityName: o.internalOrderNumber })} className="p-1 text-slate-300 hover:text-rose-500 transition-colors shrink-0" title="Reject Order"><i className="fa-solid fa-ban text-xs"></i></button>
                              </div>
                            </div>
                          </td>
                        );
                        return null;
                      })}
                    </tr>

                    {/* Inline Line Items for Authorization - collapsible */}
                    {isExpanded && (
                      <tr className="bg-slate-50/50 border-b-2 border-slate-100">
                        <td colSpan={columnOrder.length} className="px-8 pb-6 bg-transparent" onClick={e => e.stopPropagation()}>
                          <div className="space-y-6">
                            {(() => {
                              const orderComponents = (o.items || []).flatMap(it => 
                                (it.components || []).map(c => ({ ...c, parentItemDesc: it.description }))
                              );
                              return (
                                <>
                                  {/* Double-Entry Ledger Card */}
                                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-4">
                                    <div className="flex items-center justify-between flex-wrap gap-4 border-b border-slate-100 pb-4">
                                      <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-lg">
                                          <i className="fa-solid fa-scale-balanced"></i>
                                        </div>
                                        <div>
                                          <div className="text-sm font-black text-slate-800 uppercase tracking-tight">
                                            {language === 'ar' ? 'توازن القيد المزدوج ودفتر ضريبة القيمة المضافة لأمر الشراء' : 'PO Double-Entry Accounting Balance & VAT Ledger'}
                                          </div>
                                          <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                                            {language === 'ar' ? `المعادلة: الأصول (${pl.poAssets.toFixed(2)}) = الخصوم + الأرباح (${pl.poLiabilitiesAndProfit.toFixed(2)}) • الطلب: ${o.internalOrderNumber}` : `Equation: Assets (${pl.poAssets.toFixed(2)}) = Liabilities + Profit (${pl.poLiabilitiesAndProfit.toFixed(2)}) • Order: ${o.internalOrderNumber}`}
                                          </div>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-2">
                                        {pl.isPoBalanced ? (
                                          <span className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-black inline-flex items-center gap-1.5 shadow-xs">
                                            <i className="fa-solid fa-shield-halved"></i>
                                            <span>{language === 'ar' ? `متوازن (الفارق: 0.00 ${pl.currency === 'L.E.' ? 'ج.م' : pl.currency})` : `Balanced (Variance: 0.00 ${pl.currency})`}</span>
                                          </span>
                                        ) : (
                                          <span className="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs font-black inline-flex items-center gap-1.5 shadow-xs">
                                            <i className="fa-solid fa-triangle-exclamation"></i>
                                            <span>{language === 'ar' ? `فارق: ${pl.poVariance.toFixed(2)} ${pl.currency === 'L.E.' ? 'ج.م' : pl.currency}` : `Variance: ${pl.poVariance.toFixed(2)} ${pl.currency}`}</span>
                                          </span>
                                        )}
                                        <span className={`px-2.5 py-1.5 rounded-xl text-xs font-black uppercase border ${pl.isInvoiced ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                                          {pl.isInvoiced ? (language === 'ar' ? 'مفوتر / محقق' : 'Invoiced / Realized') : (language === 'ar' ? 'مرحلة ما قبل الفاتورة / WIP' : 'Pre-Invoice / WIP Stage')}
                                        </span>
                                      </div>
                                    </div>

                                    {/* 4 Pillars Grid */}
                                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                                      {/* Pillar 1: Assets */}
                                      <div className="p-4 rounded-2xl bg-blue-50/50 border border-blue-100 flex flex-col justify-between">
                                        <div>
                                          <div className="text-[9px] font-black uppercase tracking-wider text-blue-700 flex items-center justify-between mb-2">
                                            <span>{language === 'ar' ? '1. أصول أمر الشراء (مدين)' : '1. PO Assets (Debit)'}</span>
                                            <i className="fa-solid fa-vault"></i>
                                          </div>
                                          <div className="space-y-1.5 text-xs">
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'المحصل نقداً:' : 'Cash Collected:'}</span>
                                              <span className="font-mono font-bold">{pl.paid.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'مستحقات العملاء (AR):' : 'Customer AR:'}</span>
                                              <span className="font-mono font-bold text-rose-600">{pl.customerAR.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'مخزون قيد التشغيل (WIP):' : 'WIP Inventory Asset:'}</span>
                                              <span className="font-mono font-bold text-amber-600">{pl.wip.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="mt-3 pt-2.5 border-t border-blue-200 flex justify-between items-center">
                                          <span className="text-[10px] font-black uppercase text-blue-900">{language === 'ar' ? 'إجمالي الأصول' : 'Total Assets'}</span>
                                          <span className="font-mono font-black text-sm text-blue-950">{pl.poAssets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                        </div>
                                      </div>

                                      {/* Pillar 2: Liabilities */}
                                      <div className="p-4 rounded-2xl bg-rose-50/50 border border-rose-100 flex flex-col justify-between">
                                        <div>
                                          <div className="text-[9px] font-black uppercase tracking-wider text-rose-700 flex items-center justify-between mb-2">
                                            <span>{language === 'ar' ? '2. خصوم أمر الشراء (دائن)' : '2. PO Liabilities (Credit)'}</span>
                                            <i className="fa-solid fa-hand-holding-dollar"></i>
                                          </div>
                                          <div className="space-y-1.5 text-xs">
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'مستحقات الموردين (غير مسددة):' : 'Supplier AP (Unpaid):'}</span>
                                              <span className="font-mono font-bold text-rose-700">{pl.supplierAP.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'دفعات مقدمة من العميل:' : 'Customer Advance:'}</span>
                                              <span className="font-mono font-bold text-blue-700">{pl.customerAdvance.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'صافي الضريبة الواجبة لمصلحة الضرائب:' : 'Net VAT Owed to Gov:'}</span>
                                              <span className="font-mono font-bold text-purple-700">{pl.netTaxOwed.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="mt-3 pt-2.5 border-t border-rose-200 flex justify-between items-center">
                                          <span className="text-[10px] font-black uppercase text-rose-900">{language === 'ar' ? 'إجمالي الخصوم' : 'Total Liabilities'}</span>
                                          <span className="font-mono font-black text-sm text-rose-950">{(pl.supplierAP + pl.customerAdvance + pl.netTaxOwed).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                        </div>
                                      </div>

                                      {/* Pillar 3: Profit & Equity */}
                                      <div className="p-4 rounded-2xl bg-emerald-50/50 border border-emerald-100 flex flex-col justify-between">
                                        <div>
                                          <div className="text-[9px] font-black uppercase tracking-wider text-emerald-700 flex items-center justify-between mb-2">
                                            <span>{language === 'ar' ? '3. الأرباح وحقوق الملكية' : '3. Profit & Equity'}</span>
                                            <i className="fa-solid fa-chart-line"></i>
                                          </div>
                                          <div className="space-y-1.5 text-xs">
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'الربح المحقق:' : 'Realized Profit:'}</span>
                                              <span className="font-mono font-bold text-emerald-700">{pl.realizedProfit.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'الهامش المتوقع:' : 'Projected Margin:'}</span>
                                              <span className="font-mono font-bold text-slate-500">{pl.projectedProfit.toLocaleString()} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'الاعتراف بالإيراد:' : 'Recognition:'}</span>
                                              <span className={`text-[9px] font-black uppercase ${pl.isInvoiced ? 'text-emerald-700' : 'text-amber-700'}`}>
                                                {pl.isInvoiced ? (language === 'ar' ? 'مفوتر في الأرباح والخسائر' : 'Invoiced to P&L') : (language === 'ar' ? 'مؤجل في WIP' : 'Deferred in WIP')}
                                              </span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="mt-3 pt-2.5 border-t border-emerald-200 flex justify-between items-center">
                                          <span className="text-[10px] font-black uppercase text-emerald-900">{language === 'ar' ? 'الخصوم + الأرباح' : 'Liab + Profit'}</span>
                                          <span className="font-mono font-black text-sm text-emerald-950">{pl.poLiabilitiesAndProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}</span>
                                        </div>
                                      </div>

                                      {/* Pillar 4: Tax Ledger */}
                                      <div className="p-4 rounded-2xl bg-purple-50/50 border border-purple-100 flex flex-col justify-between">
                                        <div>
                                          <div className="text-[9px] font-black uppercase tracking-wider text-purple-700 flex items-center justify-between mb-2">
                                            <span>{language === 'ar' ? '4. دفتر الضرائب (القيمة المضافة 14%)' : '4. Tax Ledger (VAT 14%)'}</span>
                                            <i className="fa-solid fa-receipt"></i>
                                          </div>
                                          <div className="space-y-1.5 text-xs">
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'ضريبة المخرجات (العميل):' : 'Output Tax (Customer):'}</span>
                                              <span className="font-mono font-bold">{pl.outputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'ضريبة المدخلات (المورد):' : 'Input Tax (Supplier):'}</span>
                                              <span className="font-mono font-bold text-emerald-700">-{pl.inputTax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                            </div>
                                            <div className="flex justify-between items-center text-slate-600">
                                              <span>{language === 'ar' ? 'الموقف الضريبي:' : 'Tax Status:'}</span>
                                              <span className="text-[9px] font-black uppercase text-purple-700">
                                                {pl.isInvoiced ? (language === 'ar' ? 'معترف بها' : 'Recognized') : (language === 'ar' ? 'تقديرية / قبل الضريبة' : 'Quoted / Pre-Tax')}
                                              </span>
                                            </div>
                                          </div>
                                        </div>
                                        <div className="mt-3 pt-2.5 border-t border-purple-200 flex justify-between items-center">
                                          <span className="text-[10px] font-black uppercase text-purple-900">{language === 'ar' ? 'صافي تسوية الضريبة' : 'Net Tax Settlement'}</span>
                                          <span className={`font-mono font-black text-sm ${pl.netTaxOwed >= 0 ? 'text-purple-950' : 'text-emerald-700'}`}>
                                            {pl.netTaxOwed >= 0 ? `${pl.netTaxOwed.toFixed(2)} ${pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}` : `${language === 'ar' ? 'رصيد دائن:' : 'Credit:'} ${Math.abs(pl.netTaxOwed).toFixed(2)} ${pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}`}
                                          </span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Sourced Components Breakdown & Supplier AP Table */}
                                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                                    <div className="px-6 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2">
                                      <div className="flex items-center gap-2">
                                        <i className="fa-solid fa-dolly text-slate-500 text-xs"></i>
                                        <span className="text-xs font-black uppercase tracking-wider text-slate-700">
                                          {language === 'ar' ? `المكونات الموردة ومستحقات الموردين (${orderComponents.length})` : `Sourced Components & Supplier AP (${orderComponents.length})`}
                                        </span>
                                      </div>
                                      <span className="text-[10px] font-bold text-slate-400">
                                        {language === 'ar' ? `إجمالي التكلفة الموردة: ${pl.grossCostInOrderCurrency.toLocaleString()} ${pl.currency === 'L.E.' ? 'ج.م' : pl.currency} • مستحقات الموردين: ${pl.supplierAP.toLocaleString()} ${pl.currency === 'L.E.' ? 'ج.م' : pl.currency}` : `Sourced Gross Cost: ${pl.grossCostInOrderCurrency.toLocaleString()} ${pl.currency} • Supplier AP: ${pl.supplierAP.toLocaleString()} ${pl.currency}`}
                                      </span>
                                    </div>

                                    {orderComponents.length === 0 ? (
                                      <div className="px-6 py-6 text-center text-xs text-slate-400 font-bold uppercase tracking-wider">
                                        {language === 'ar' ? `لا توجد مكونات مشتراة بعد. (تكلفة الطلب التقديرية: ${pl.costInOrderCurrency.toLocaleString()} ${pl.currency === 'L.E.' ? 'ج.م' : pl.currency})` : `No procurement components sourced yet. (Estimated order cost: ${pl.costInOrderCurrency.toLocaleString()} ${pl.currency})`}
                                      </div>
                                    ) : (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-start text-xs">
                                          <thead className="bg-slate-100 text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                            <tr>
                                              <th className="px-5 py-2.5 text-start">{language === 'ar' ? 'وصف المكون' : 'Component Description'}</th>
                                              <th className="px-5 py-2.5 text-start">{language === 'ar' ? 'بند طلب العميل' : 'Target PO Item'}</th>
                                              <th className="px-5 py-2.5 text-start">{language === 'ar' ? 'المورد' : 'Supplier'}</th>
                                              <th className="px-5 py-2.5 text-center">{language === 'ar' ? 'الكمية' : 'Qty'}</th>
                                              <th className="px-5 py-2.5 text-end">{language === 'ar' ? 'سعر الوحدة' : 'Unit Cost'}</th>
                                              <th className="px-5 py-2.5 text-end">{language === 'ar' ? 'صافي التكلفة' : 'Net Sourced'}</th>
                                              <th className="px-5 py-2.5 text-end">{language === 'ar' ? 'ضريبة المدخلات (14%)' : 'Input VAT (14%)'}</th>
                                              <th className="px-5 py-2.5 text-end">{language === 'ar' ? 'إجمالي التكلفة' : 'Gross Sourced'}</th>
                                              <th className="px-5 py-2.5 text-center">{language === 'ar' ? 'المرحلة' : 'Stage'}</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-slate-100 font-bold text-slate-700">
                                            {orderComponents.map((c, cIdx) => {
                                              const cNet = (c.quantity || 0) * (c.unitCost || 0);
                                              const cTaxRate = c.taxPercent !== undefined ? c.taxPercent : 0;
                                              const cTax = cNet * (cTaxRate / 100);
                                              const cGross = cNet + cTax;
                                              return (
                                                <tr key={c.id || cIdx} className="hover:bg-slate-50/70 transition-colors">
                                                  <td className="px-5 py-3">
                                                    <div className="font-black text-slate-800">{c.description}</div>
                                                    {c.poNumber && <div className="text-[9px] font-mono text-slate-400">{language === 'ar' ? 'أمر شراء:' : 'PO:'} {c.poNumber}</div>}
                                                  </td>
                                                  <td className="px-5 py-3 text-slate-500 max-w-[150px] truncate" title={c.parentItemDesc}>
                                                    {c.parentItemDesc}
                                                  </td>
                                                  <td className="px-5 py-3">
                                                    <span className="font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                                                      {c.supplierName || (language === 'ar' ? 'غير محدد' : 'Unknown')}
                                                    </span>
                                                  </td>
                                                  <td className="px-5 py-3 text-center font-mono">
                                                    {c.quantity} {c.unit}
                                                  </td>
                                                  <td className="px-5 py-3 text-end font-mono">
                                                    {(c.unitCost || 0).toLocaleString()}
                                                  </td>
                                                  <td className="px-5 py-3 text-end font-mono">
                                                    {cNet.toLocaleString()}
                                                  </td>
                                                  <td className="px-5 py-3 text-end font-mono text-emerald-700">
                                                    {cTax > 0 ? `+${cTax.toFixed(2)} (${cTaxRate}%)` : '0.00'}
                                                  </td>
                                                  <td className="px-5 py-3 text-end font-mono font-black text-slate-800">
                                                    {cGross.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                  </td>
                                                  <td className="px-5 py-3 text-center">
                                                    <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${pl.isInvoiced ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                                      {pl.isInvoiced ? (language === 'ar' ? 'تكلفة مبيعات (COGS)' : 'COGS Expense') : (language === 'ar' ? 'مخزون قيد التشغيل (WIP)' : 'WIP Inventory')}
                                                    </span>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </>
                              );
                            })()}

                            {/* Line Items for Dispatch Authorization */}
                            <div className="bg-white rounded-2xl shadow-inner border border-slate-200 overflow-hidden divide-y divide-slate-100">
                              <div className="px-4 py-2 bg-slate-100 text-[9px] font-black text-slate-400 uppercase tracking-widest grid grid-cols-12 gap-4 items-center">
                              <div className="col-span-5">{t("finance.poItemDefinition") || (language === 'ar' ? 'بند أمر الشراء' : "PO Item Definition")}</div>
                              <div className="col-span-1 text-center">{t("finance.orders.hubReady") || (language === 'ar' ? 'جاهز بالمركز' : "Hub Rdy")}</div>
                              <div className="col-span-2 text-center">{t("finance.orders.authorized") || (language === 'ar' ? 'معتمد' : "Authorized")}</div>
                              <div className="col-span-1 text-center">{t("finance.orders.shipped") || (language === 'ar' ? 'تم الشحن' : "Shipped")}</div>
                              <div className="col-span-3 text-end pr-2">{t("finance.orders.dispatchReceipt") || (language === 'ar' ? 'إيصال اعتماد التسليم' : "Dispatch Autho. Receipt")}</div>
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
                                      {language === 'ar' ? 'المستهدف:' : 'Tgt:'} {getItemEffectiveQty(it)} {it.unit} @ {it.pricePerUnit?.toLocaleString() || 'N/A'} {pl.currency === 'L.E.' && language === 'ar' ? 'ج.م' : pl.currency}
                                    </div>
                                  </div>
                                  <div className="col-span-1 text-center font-black text-sky-600 text-xs">{inHub}</div>
                                  <div className="col-span-2 text-center text-[10px] font-bold">
                                    {approved > 0 ? (
                                      <span className={`px-2 py-0.5 rounded-full ${approved >= inHub ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                                        {approved} {language === 'ar' ? 'معتمد' : 'Auth'}
                                      </span>
                                    ) : (
                                      <span className="text-slate-400 opacity-50 block text-center">{language === 'ar' ? 'لا يوجد' : 'None'}</span>
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
                                            placeholder={language === 'ar' ? `الحد: ${maxAuth}` : `Max: ${maxAuth}`}
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
                                              {language === 'ar' ? 'الزيادة:' : 'Excess:'} {((parseFloat(dispatchReceiptInputs[it.id]) || 0) - maxAffordablePieces).toLocaleString()} {it.unit}
                                            </div>
                                          )}
                                        </div>
                                        <button
                                          disabled={isProcessing}
                                          onClick={() => handleInlineDispatchAuth(o.id, it.id)}
                                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[9px] font-black uppercase shadow flex items-center gap-1 disabled:opacity-50"
                                        >
                                          <i className="fa-solid fa-file-signature"></i> {language === 'ar' ? 'اعتماد' : 'Auth'}
                                        </button>
                                        <button
                                          disabled={isProcessing || finalMaxQty <= 0}
                                          onClick={() => setDispatchReceiptInputs(p => ({ ...p, [it.id]: String(finalMaxQty) }))}
                                          className="px-3 py-1.5 bg-slate-100 hover:bg-emerald-50 text-slate-600 hover:text-emerald-700 border border-slate-200 hover:border-emerald-200 rounded-lg text-[9px] font-black uppercase shadow-sm flex items-center gap-1 disabled:opacity-50 transition-all"
                                          title={language === 'ar' ? "تعيين لأقصى كمية يمكن تغطيتها بالدفعة الجزئية الحالية" : "Set to max quantity affordable with current partial payment balance"}
                                        >
                                          {language === 'ar' ? 'الحد الأقصى المدفوع' : 'Max Paid'}
                                        </button>
                                      </>
                                    ) : (
                                      <div className="text-[9px] font-black text-emerald-600 uppercase bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-100">{language === 'ar' ? 'مكتمل التخليص' : 'Fully Cleared'}</div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              };

              const renderBlanketCard = (group: { groupId: string; projectName: string; latestOrder: CustomerOrder; orders: CustomerOrder[]; isProjectConsolidated: boolean }) => {
                const groupOrders = (group.orders && group.orders.length > 0 ? group.orders : [group.latestOrder])
                  .filter(o => o.status !== OrderStatus.REJECTED && (o.status as string) !== 'REJECTED');
                if (groupOrders.length === 0) return null;
                const latestOrder = groupOrders[0];
                const isExpanded = Boolean(expandedOrderIds[group.groupId]);
                const isHistoryExpanded = expandedProjectHistoryIds.has(group.groupId);
                const projName = group.projectName || getOrderProjectName(latestOrder);

                let targetItem: CustomerOrderItem | null = null;
                for (const ord of groupOrders) {
                  const f = (ord.items || []).find(it => it.costSheetFile);
                  if (f) { targetItem = f; break; }
                }
                if (!targetItem) {
                  for (const ord of groupOrders) {
                    const f = (ord.items || []).find(it => it.productionType === 'OUTSOURCING');
                    if (f) { targetItem = f; break; }
                  }
                }
                if (!targetItem) {
                  targetItem = latestOrder.items?.[0] || groupOrders[0]?.items?.[0] || null;
                }

                const outsourcingMetrics = (() => {
                  if (!targetItem) return { resourceCount: 0, realCost: 0, invoiceTotal: 0, sheetProjectName: '', projectMissing: false };
                  let count = targetItem.workingResourceCount || 0;
                  let cost = targetItem.realCost || 0;
                  let inv = targetItem.invoiceTotal || 0;
                  let sheetProjectName = '';
                  let matchedProjectBlock = false;
                  let projectMissing = false;

                  if (projName && targetItem.costSheetFile) {
                    const projMetrics = extractCostSheetProjectMetrics(targetItem.costSheetFile, projName);
                    if (projMetrics) {
                      count = projMetrics.resourceCount;
                      cost = projMetrics.realCost;
                      inv = projMetrics.invoiceTotal;
                      sheetProjectName = projMetrics.projectName;
                      matchedProjectBlock = true;
                    } else {
                      count = 0;
                      cost = 0;
                      inv = 0;
                      projectMissing = true;
                    }
                  }

                  if (!matchedProjectBlock && !projectMissing && (!count || !cost || !inv) && targetItem.costSheetFile) {
                    const extracted = extractCostSheetMetrics(targetItem.costSheetFile);
                    if (!count) count = extracted.resourceCount;
                    if (!cost) cost = extracted.realCost;
                    if (!inv) inv = extracted.invoiceTotal;
                  }

                  return { resourceCount: count, realCost: cost, invoiceTotal: inv, sheetProjectName, projectMissing };
                })();

                return (
                  <tr key={group.groupId} className="border-b border-slate-200 bg-slate-50/40">
                    <td colSpan={columnOrder.length} className="p-4" onClick={(e) => e.stopPropagation()}>
                      <div className="bg-gradient-to-b from-slate-50 to-white rounded-[2rem] border border-slate-200 overflow-hidden transition-all shadow-sm">
                        {/* Order Header */}
                        <div 
                          onClick={() => toggleOrderExpand(group.groupId)}
                          className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-6 bg-slate-100/80 border-b border-slate-200 cursor-pointer hover:bg-slate-200/60 transition-all select-none group"
                        >
                          <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg transition-all shadow-sm ${
                              isExpanded ? 'bg-blue-600 text-white shadow-blue-200' : 'bg-white text-blue-600 group-hover:bg-blue-50'
                            }`}>
                              <i className={`fa-solid ${isExpanded ? 'fa-folder-open' : 'fa-folder'} text-base`}></i>
                            </div>
                            <div>
                              <div className="font-mono text-[11px] font-black text-blue-600 tracking-widest flex items-center flex-nowrap gap-2 whitespace-nowrap">
                                {group.isProjectConsolidated ? (
                                  <>
                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-100 text-violet-800 border border-violet-300 font-sans text-xs font-black shadow-xs whitespace-nowrap shrink-0">
                                      <i className="fa-solid fa-diagram-project text-violet-600"></i>
                                      {language === 'ar' ? 'مشروع:' : 'Project:'} <strong>{projName}</strong>
                                    </span>
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 border border-teal-200 text-[9px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap shrink-0" title="Consolidated Blanket Project Orders">
                                      <i className="fa-solid fa-layer-group text-[8px]"></i> {language === 'ar' ? `مشروع إطاري (${groupOrders.length} ${groupOrders.length === 1 ? 'طلب' : 'طلبات'})` : `Blanket Project (${groupOrders.length} ${groupOrders.length === 1 ? 'Order' : 'Orders'})`}
                                    </span>
                                  </>
                                ) : (
                                  <>
                                    <span className="whitespace-nowrap shrink-0">{latestOrder.internalOrderNumber}</span>
                                    {latestOrder.customerReferenceNumber && (
                                      <span className="text-[10px] font-bold text-slate-600 bg-slate-200/80 px-2 py-0.5 rounded-lg border border-slate-300 font-mono tracking-normal whitespace-nowrap shrink-0" title="Customer PO Reference">
                                        {language === 'ar' ? 'أمر شراء:' : 'PO:'} <span className="text-slate-900 font-black">{latestOrder.customerReferenceNumber}</span>
                                      </span>
                                    )}
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 border border-teal-200 text-[9px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap shrink-0" title="Blanket Contract Order">
                                      <i className="fa-solid fa-layer-group text-[8px]"></i> {language === 'ar' ? 'إطاري' : 'Blanket'}
                                    </span>
                                    {projName ? (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-black uppercase tracking-tight shadow-xs whitespace-nowrap shrink-0" title={`Project Name: ${projName}`}>
                                        <i className="fa-solid fa-diagram-project text-violet-500"></i> {language === 'ar' ? 'مشروع:' : 'Project:'} <strong className="text-violet-700">{projName}</strong>
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200 text-[9px] font-bold uppercase tracking-tight whitespace-nowrap shrink-0" title="Non-Project Order">
                                        <i className="fa-solid fa-folder-minus text-slate-400"></i> {language === 'ar' ? 'بدون مشروع' : 'Non-Project'}
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                              <div className="font-black text-slate-800 text-sm mt-1 flex items-center gap-2 flex-wrap">
                                <span>{latestOrder.customerName}</span>
                                <span className="text-[9px] text-slate-500 font-bold uppercase inline-flex items-center gap-1.5 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200 whitespace-nowrap shrink-0">
                                  <span className="whitespace-nowrap">{groupOrders.length} {groupOrders.length === 1 ? (language === 'ar' ? 'طلب' : 'Order') : (language === 'ar' ? 'طلبات' : 'Orders')}</span>
                                  <span className="text-slate-300">•</span>
                                  <span className="text-blue-600 font-black flex items-center gap-1 hover:text-blue-700 whitespace-nowrap">
                                    {isExpanded ? (language === 'ar' ? 'انقر للطي' : 'Click to collapse') : (language === 'ar' ? 'توسيع لعرض الطلبات والتفاصيل المالية' : 'Expand to show orders & financial details')}
                                    <i className={`fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px]`}></i>
                                  </span>
                                </span>
                              </div>

                              {/* Quick info of latest order & dropdown link to show project orders history subcard */}
                              {group.isProjectConsolidated && (
                                <div className="mt-2.5 flex items-center gap-2.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
                                  <div className="inline-flex items-center gap-2 bg-white/90 border border-slate-200 px-3 py-1 rounded-xl text-[10px] shadow-2xs font-mono">
                                    <span className="text-[8px] font-black uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded tracking-wider font-sans">
                                      ★ {language === 'ar' ? 'أحدث أمر شراء' : 'Latest PO'}
                                    </span>
                                    <span className="font-black text-slate-900" title="Customer PO Number">
                                      {latestOrder.customerReferenceNumber || 'N/A'}
                                    </span>
                                    <span className="text-slate-300 font-sans">•</span>
                                    <span className="text-slate-600" title="Internal Order Number">
                                      {language === 'ar' ? 'داخلي:' : 'Int:'} <strong className="text-slate-800">{latestOrder.internalOrderNumber}</strong>
                                    </span>
                                    <span className="text-slate-300 font-sans">•</span>
                                    <span className="text-slate-600" title="PO Received Date">
                                      {language === 'ar' ? 'استلام:' : 'Recv:'} <strong className="text-slate-800">
                                        {latestOrder.orderDate ? new Date(latestOrder.orderDate).toLocaleDateString() : (latestOrder.dataEntryTimestamp ? new Date(latestOrder.dataEntryTimestamp).toLocaleDateString() : 'N/A')}
                                      </strong>
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={(e) => toggleProjectHistory(group.groupId, e)}
                                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer shadow-xs ${
                                      isHistoryExpanded
                                        ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                                        : 'bg-white border border-blue-200 text-blue-700 hover:bg-blue-50'
                                    }`}
                                    title="Click to open/close project orders history subcard"
                                  >
                                    <i className="fa-solid fa-clock-rotate-left text-[9px]"></i>
                                    <span>{language === 'ar' ? `سجل طلبات المشروع (${groupOrders.length})` : `Project Orders History (${groupOrders.length})`}</span>
                                    <i className={`fa-solid ${isHistoryExpanded ? 'fa-chevron-up' : 'fa-chevron-down'} text-[8px] ml-0.5`}></i>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-3 flex-wrap" onClick={(e) => e.stopPropagation()}>
                            {/* PO Acquisition Date */}
                            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl text-slate-700">
                              <i className="fa-solid fa-calendar-day text-purple-600 text-xs"></i>
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black uppercase tracking-wider text-slate-400 leading-none">
                                  {language === 'ar' ? 'تاريخ أمر الشراء' : 'PO Date'}
                                </span>
                                <span className="text-[11px] font-black mt-0.5">
                                  {latestOrder.orderDate ? new Date(latestOrder.orderDate).toLocaleDateString() : (latestOrder.dataEntryTimestamp ? new Date(latestOrder.dataEntryTimestamp).toLocaleDateString() : 'N/A')}
                                </span>
                              </div>
                            </div>

                            {/* Working Number of Resources */}
                            <div
                              className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-xl text-emerald-900 shadow-xs"
                              title={
                                outsourcingMetrics.projectMissing
                                  ? `Project "${projName}" is not in the uploaded cost sheet.`
                                  : outsourcingMetrics.sheetProjectName
                                    ? `From cost sheet project "${outsourcingMetrics.sheetProjectName}" (اجمالى block)`
                                    : undefined
                              }
                            >
                              <i className="fa-solid fa-users text-emerald-600 text-xs"></i>
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black uppercase tracking-wider text-emerald-700 leading-none">
                                  {language === 'ar' ? 'الموارد العاملة' : 'Working Resources'}
                                </span>
                                <span className="text-[11px] font-black mt-0.5">
                                  {outsourcingMetrics.resourceCount > 0 ? (language === 'ar' ? `${outsourcingMetrics.resourceCount} أفراد` : `${outsourcingMetrics.resourceCount} Persons`) : '—'}
                                </span>
                              </div>
                            </div>

                            {/* Total Real Cost to Company */}
                            <div
                              className="flex items-center gap-2 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-xl text-blue-900 shadow-xs"
                              title={
                                outsourcingMetrics.projectMissing
                                  ? `Project "${projName}" is not in the uploaded cost sheet.`
                                  : outsourcingMetrics.sheetProjectName
                                    ? `Sum of project "${outsourcingMetrics.sheetProjectName}" person rows (cost column)`
                                    : undefined
                              }
                            >
                              <i className="fa-solid fa-coins text-blue-600 text-xs"></i>
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black uppercase tracking-wider text-blue-700 leading-none">
                                  {language === 'ar' ? 'التكلفة الفعلية' : 'Real Cost'}
                                </span>
                                <span className="text-[11px] font-black mt-0.5">
                                  {outsourcingMetrics.realCost > 0 ? `${outsourcingMetrics.realCost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : '—'}
                                </span>
                              </div>
                            </div>

                            {/* Total Invoice (اجمالي الفاتورة) - EXTRA ADDITION */}
                            <div
                              className="flex items-center gap-2 bg-violet-50 border border-violet-200 px-3 py-1.5 rounded-xl text-violet-900 shadow-xs"
                              title={
                                outsourcingMetrics.projectMissing
                                  ? `Project "${projName}" is not in the uploaded cost sheet.`
                                  : outsourcingMetrics.sheetProjectName
                                    ? `Total invoice from column "اجمالي الفاتورة" of project "${outsourcingMetrics.sheetProjectName}"`
                                    : 'Total invoice from column "اجمالي الفاتورة"'
                              }
                            >
                              <i className="fa-solid fa-file-invoice-dollar text-violet-600 text-xs"></i>
                              <div className="flex flex-col">
                                <span className="text-[8px] font-black uppercase tracking-wider text-violet-700 leading-none">
                                  {language === 'ar' ? 'إجمالي الفاتورة' : 'Total Invoice'}
                                </span>
                                <span className="text-[11px] font-black mt-0.5">
                                  {outsourcingMetrics.invoiceTotal > 0 ? `${outsourcingMetrics.invoiceTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : '—'}
                                </span>
                              </div>
                            </div>

                            {/* Project Wallet */}
                            {(() => {
                              const projWalletBal = getProjectWalletBalance(projName, latestOrder.customerName);
                              return (
                                <div
                                  className={`flex items-center gap-2 border px-3 py-1.5 rounded-xl shadow-xs ${
                                    projWalletBal > 0
                                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                                      : projWalletBal < 0
                                      ? 'bg-rose-50 border-rose-200 text-rose-900'
                                      : 'bg-slate-50 border-slate-200 text-slate-700'
                                  }`}
                                  title={`Wallet balance allocated for project "${projName}": ${projWalletBal.toLocaleString()} L.E.`}
                                >
                                  <i className={`fa-solid fa-wallet text-xs ${projWalletBal > 0 ? 'text-emerald-600' : projWalletBal < 0 ? 'text-rose-600' : 'text-slate-400'}`}></i>
                                  <div className="flex flex-col">
                                    <span className={`text-[8px] font-black uppercase tracking-wider leading-none ${projWalletBal > 0 ? 'text-emerald-700' : projWalletBal < 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                                      {language === 'ar' ? 'محفظة المشروع' : 'Project Wallet'}
                                    </span>
                                    <span className="text-[11px] font-black mt-0.5 font-mono">
                                      {projWalletBal > 0 ? `+${projWalletBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : projWalletBal < 0 ? `-${Math.abs(projWalletBal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : `0.00 ${language === 'ar' ? 'ج.م' : 'L.E.'}`}
                                      {projWalletBal < 0 && <span className="text-[8px] font-black ml-1 text-rose-600 uppercase font-sans">{language === 'ar' ? '(دين)' : '(Debt)'}</span>}
                                    </span>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Customer Wallet */}
                            {(() => {
                              const custWalletBal = getCustomerWalletBalance(latestOrder.customerName);
                              return (
                                <div
                                  className={`flex items-center gap-2 border px-3 py-1.5 rounded-xl shadow-xs ${
                                    custWalletBal > 0
                                      ? 'bg-teal-50 border-teal-200 text-teal-900'
                                      : custWalletBal < 0
                                      ? 'bg-rose-50 border-rose-200 text-rose-900'
                                      : 'bg-slate-50 border-slate-200 text-slate-700'
                                  }`}
                                  title={`Total Customer Wallet balance for "${latestOrder.customerName}": ${custWalletBal.toLocaleString()} L.E.`}
                                >
                                  <i className={`fa-solid fa-user-tag text-xs ${custWalletBal > 0 ? 'text-teal-600' : custWalletBal < 0 ? 'text-rose-600' : 'text-slate-400'}`}></i>
                                  <div className="flex flex-col">
                                    <span className={`text-[8px] font-black uppercase tracking-wider leading-none ${custWalletBal > 0 ? 'text-teal-700' : custWalletBal < 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                                      {language === 'ar' ? 'محفظة العميل' : 'Customer Wallet'}
                                    </span>
                                    <span className="text-[11px] font-black mt-0.5 font-mono">
                                      {custWalletBal > 0 ? `+${custWalletBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : custWalletBal < 0 ? `-${Math.abs(custWalletBal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${language === 'ar' ? 'ج.م' : 'L.E.'}` : `0.00 ${language === 'ar' ? 'ج.م' : 'L.E.'}`}
                                      {custWalletBal < 0 && <span className="text-[8px] font-black ml-1 text-rose-600 uppercase font-sans">{language === 'ar' ? '(دين)' : '(Debt)'}</span>}
                                    </span>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* View & Download Sheet */}
                            <div className="flex items-center gap-1.5">
                              {targetItem?.costSheetFile && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadCostSheetFile(
                                      targetItem.costSheetFile!,
                                      targetItem.costSheetFileName || `CostSheet-${latestOrder.internalOrderNumber || latestOrder.customerReferenceNumber}.xlsx`
                                    );
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-[9px] font-black uppercase bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-all flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                  title="Download current Excel cost sheet"
                                >
                                  <i className="fa-solid fa-file-excel text-emerald-600"></i>
                                  <span>{language === 'ar' ? 'تحميل' : 'Download'}</span>
                                </button>
                              )}

                              {targetItem?.costSheetFile && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openCostSheetModal(latestOrder, targetItem);
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-[9px] font-black uppercase bg-violet-50 border border-violet-200 text-violet-700 hover:bg-violet-100 transition-all flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                  title="Open interactive spreadsheet viewer"
                                >
                                  <i className="fa-solid fa-table-cells text-violet-600"></i>
                                  <span>{language === 'ar' ? 'عرض الشيت' : 'View Sheet'}</span>
                                </button>
                              )}
                            </div>

                            {/* Sheet History Chips (Current Month Only) */}
                            {targetItem?.costSheets && targetItem.costSheets.length >= 1 && (() => {
                              const allSheets = targetItem.costSheets!;
                              const now = new Date();
                              const curMonth = now.getMonth();
                              const curYear = now.getFullYear();

                              // Filter to show ONLY history of cost sheets uploaded/modified in the current calendar month
                              const currentMonthSheets = allSheets.filter(rec => {
                                if (!rec.uploadedAt) return false;
                                const d = new Date(rec.uploadedAt);
                                return !isNaN(d.getTime()) && d.getMonth() === curMonth && d.getFullYear() === curYear;
                              });

                              const curMonthLabel = now.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', year: 'numeric' });
                              const latestCurrentMonthIdx = currentMonthSheets.length - 1;

                              return (
                                <div className="flex flex-col gap-1.5 bg-slate-50 px-2.5 py-2 rounded-xl border border-slate-200">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-black text-[8px] text-slate-500 flex items-center gap-1.5 uppercase tracking-wider">
                                      <i className="fa-solid fa-clock-rotate-left text-slate-400"></i>
                                      {language === 'ar' ? `سجل كشوف التكاليف (${curMonthLabel})` : `Cost Sheet History (${curMonthLabel})`}
                                    </span>
                                    <span className="text-[7px] font-bold text-slate-400 uppercase tracking-widest">
                                      {language === 'ar' ? 'الشهر الحالي فقط' : 'Current Month Only'}
                                    </span>
                                  </div>
                                  {currentMonthSheets.length > 0 ? (
                                    <div className="flex items-start gap-1.5 flex-wrap">
                                      {currentMonthSheets.map((rec, rIdx) => {
                                        const isLatestInMonth = rIdx === latestCurrentMonthIdx;
                                        return (
                                          <div key={rec.id || rIdx} className="flex flex-col items-center gap-0.5">
                                            {isLatestInMonth && (
                                              <span className="text-[7px] font-black uppercase tracking-wider text-emerald-600 leading-none px-1">
                                                ★ {language === 'ar' ? 'الأحدث' : 'Latest'}
                                              </span>
                                            )}
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (rec.fileData) {
                                                  downloadCostSheetFile(rec.fileData, rec.fileName);
                                                }
                                              }}
                                              className={`px-2 py-1 rounded-lg font-mono text-[8px] transition-colors flex items-center gap-1 ${
                                                isLatestInMonth
                                                  ? 'bg-emerald-50 border-2 border-emerald-400 text-emerald-800 ring-2 ring-emerald-200 shadow-sm hover:bg-emerald-100'
                                                  : 'bg-white border border-slate-200 hover:border-purple-300 text-purple-700 hover:bg-purple-50'
                                              }`}
                                              title={`Uploaded: ${new Date(rec.uploadedAt).toLocaleDateString()} | ${rec.workingResourceCount || 0} resources, ${rec.realCost || 0} LE. Click to download.`}
                                            >
                                              {isLatestInMonth && <i className="fa-solid fa-file-excel text-emerald-600 text-[8px]"></i>}
                                              {rec.fileName} ({new Date(rec.uploadedAt).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric' })})
                                            </button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div className="text-[8px] text-slate-400 italic py-0.5">
                                      {language === 'ar' ? `لا توجد كشوف تكاليف مرفوعة/معدلة هذا الشهر (${curMonthLabel})` : `No cost sheets uploaded/modified this month (${curMonthLabel})`}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        {/* ── PROJECT ORDERS HISTORY DROPDOWN SUBCARD ── */}
                        {group.isProjectConsolidated && isHistoryExpanded && (() => {
                          const allProjectSheetsMap = new Map<string, CostSheetRecord>();
                          groupOrders.forEach(ord => {
                            (ord.items || []).forEach(it => {
                              (it.costSheets || []).forEach(cs => {
                                const key = cs.id || `${cs.fileName}_${cs.uploadedAt}`;
                                if (!allProjectSheetsMap.has(key)) allProjectSheetsMap.set(key, cs);
                              });
                              if (it.costSheetFile && (!it.costSheets || it.costSheets.length === 0)) {
                                const key = `${it.costSheetFileName || 'sheet'}_${ord.dataEntryTimestamp || ''}`;
                                if (!allProjectSheetsMap.has(key)) {
                                  allProjectSheetsMap.set(key, {
                                    id: key,
                                    fileName: it.costSheetFileName || 'CostSheet.xlsx',
                                    uploadedAt: ord.dataEntryTimestamp || ord.orderDate || new Date().toISOString(),
                                    fileData: it.costSheetFile,
                                    workingResourceCount: it.workingResourceCount,
                                    realCost: it.realCost
                                  });
                                }
                              }
                            });
                          });
                          const allProjectSheets = Array.from(allProjectSheetsMap.values());

                          return (
                            <div className="p-5 bg-slate-50/95 border-b border-slate-200 animate-in fade-in slide-in-from-top-2 duration-200">
                              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                  <i className="fa-solid fa-layer-group text-blue-600 text-xs"></i>
                                  <span className="text-[11px] font-black uppercase text-slate-800 tracking-wider">
                                    {language === 'ar' ? `سجل طلبات المشروع — ${projName} (${groupOrders.length} ${groupOrders.length === 1 ? 'طلب' : 'طلبات'})` : `Project Orders History — ${projName} (${groupOrders.length} ${groupOrders.length === 1 ? 'Order' : 'Orders'})`}
                                  </span>
                                </div>
                                <span className="text-[9px] text-slate-500 font-bold">
                                  {language === 'ar' ? 'عرض كافة طلبات هذا المشروع وكشوف التكاليف المرفوعة خلال شهر كل أمر شراء' : "Showing all orders in this project & cost sheets uploaded during each order's PO month"}
                                </span>
                              </div>

                              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
                                <div className="grid grid-cols-12 gap-3 px-4 py-2.5 bg-slate-100/80 border-b border-slate-200 text-[9px] font-black uppercase text-slate-600 tracking-wider">
                                  <div className="col-span-3">{language === 'ar' ? 'رقم أمر شراء العميل' : 'Customer PO Number'}</div>
                                  <div className="col-span-2">{language === 'ar' ? 'رقم الطلب الداخلي #' : 'Internal Order #'}</div>
                                  <div className="col-span-2">{language === 'ar' ? 'تاريخ الاستلام' : 'Received Date'}</div>
                                  <div className="col-span-5">{language === 'ar' ? 'كشوف التكاليف المرفوعة بشهر أمر الشراء' : 'Cost Sheets Uploaded in PO Month'}</div>
                                </div>

                                <div className="divide-y divide-slate-100">
                                  {groupOrders.map(ord => {
                                    const isOrdLatest = ord.id === latestOrder.id;
                                    const poDateRaw = ord.orderDate || ord.dataEntryTimestamp;
                                    const poDate = poDateRaw ? new Date(poDateRaw) : null;
                                    const poValid = Boolean(poDate && !isNaN(poDate.getTime()));
                                    const poMonth = poValid && poDate ? poDate.getMonth() : -1;
                                    const poYear = poValid && poDate ? poDate.getFullYear() : -1;

                                    const monthSheets = poValid
                                      ? allProjectSheets.filter(cs => {
                                          if (!cs.uploadedAt) return false;
                                          const d = new Date(cs.uploadedAt);
                                          return !isNaN(d.getTime()) && d.getMonth() === poMonth && d.getFullYear() === poYear;
                                        })
                                      : [];

                                    return (
                                      <div key={ord.id} className={`grid grid-cols-12 gap-3 px-4 py-3 items-center text-xs transition-all ${isOrdLatest ? 'bg-blue-50/40' : 'hover:bg-slate-50'}`}>
                                        {/* PO Number */}
                                        <div className="col-span-3 flex items-center gap-2 flex-wrap">
                                          <span className="font-mono font-black text-slate-900 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 text-[11px]">
                                            {ord.customerReferenceNumber || '—'}
                                          </span>
                                          {isOrdLatest && (
                                            <span className="text-[8px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-300 px-1.5 py-0.5 rounded leading-none">
                                              ★ {language === 'ar' ? 'الأحدث' : 'Latest'}
                                            </span>
                                          )}
                                        </div>

                                        {/* Internal Order # */}
                                        <div className="col-span-2 font-mono font-bold text-blue-700 text-[11px]">
                                          {ord.internalOrderNumber || '—'}
                                        </div>

                                        {/* Received Date */}
                                        <div className="col-span-2 text-[11px] font-medium text-slate-700">
                                          {poValid && poDate ? poDate.toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                                        </div>

                                        {/* Cost Sheets Uploaded in PO Month */}
                                        <div className="col-span-5 flex items-center gap-2 flex-wrap">
                                          {monthSheets.length > 0 ? (
                                            monthSheets.map((cs, csIdx) => (
                                              <button
                                                key={cs.id || csIdx}
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  if (cs.fileData) {
                                                    downloadCostSheetFile(cs.fileData, cs.fileName || `CostSheet-${ord.internalOrderNumber || ord.customerReferenceNumber}.xlsx`);
                                                  }
                                                }}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-300 text-emerald-800 text-[10px] font-black hover:bg-emerald-100 transition-all cursor-pointer shadow-2xs group/btn"
                                                title={`Uploaded: ${new Date(cs.uploadedAt).toLocaleDateString()} | ${cs.workingResourceCount || 0} resources, ${cs.realCost || 0} LE. Click to download.`}
                                              >
                                                <i className="fa-solid fa-file-excel text-emerald-600 group-hover/btn:scale-110 transition-transform"></i>
                                                <span className="truncate max-w-[140px]">{cs.fileName}</span>
                                                <span className="text-[8px] text-emerald-700 opacity-80 font-mono">
                                                  ({new Date(cs.uploadedAt).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric' })})
                                                </span>
                                                <i className="fa-solid fa-download text-[8px] text-emerald-600 ml-0.5"></i>
                                              </button>
                                            ))
                                          ) : (
                                            <span className="text-[10px] text-slate-400 italic">{language === 'ar' ? 'لا توجد كشوف تكاليف في هذا الشهر' : 'No cost sheets in this month'}</span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* ── EXPANDED ORDERS & FINANCIAL DETAILS ── */}
                        {isExpanded && (
                          <div className="p-6 bg-slate-50/70 border-t border-slate-200 space-y-4">
                            <div className="flex items-center justify-between">
                              <div className="font-mono text-xs font-black uppercase text-slate-700 tracking-wider flex items-center gap-2">
                                <i className="fa-solid fa-list-check text-blue-600"></i>
                                <span>{language === 'ar' ? `طلبات المشروع والاعتمادات المالية (${groupOrders.length})` : `Project Orders & Financial Authorizations (${groupOrders.length})`}</span>
                              </div>
                              <span className="text-[10px] text-slate-500 font-bold">
                                {language === 'ar' ? 'إدارة الفواتير والمدفوعات وإيصالات التسليم لكل طلب في هذا المشروع' : 'Manage invoices, payments, and dispatch receipts for each order in this project'}
                              </span>
                            </div>

                            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-xs">
                              <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                                <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-white/5">
                                  <tr>
                                    {columnOrder.map(col => {
                                      if (col === 'context') return <th key={col} className="px-4 py-3 text-white">{language === 'ar' ? 'تفاصيل الطلب' : 'Order Details'}</th>;
                                      if (col === 'date') return <th key={col} className="px-3 py-3 text-white">{language === 'ar' ? 'تاريخ أمر الشراء' : 'PO Date'}</th>;
                                      if (col === 'currency') return <th key={col} className="px-2.5 py-3 text-white">{language === 'ar' ? 'العملة' : 'Currency'}</th>;
                                      if (col === 'revenue') return <th key={col} className="px-3.5 py-3 text-white">{language === 'ar' ? 'مؤشرات الإيراد' : 'Revenue Metrics'}</th>;
                                      if (col === 'markup') return <th key={col} className="px-3 py-3 text-white">{language === 'ar' ? 'هامش الإضافة' : 'Markup'}</th>;
                                      if (col === 'status') return <th key={col} className="px-3 py-3 text-white">{language === 'ar' ? 'الحالة' : 'Status'}</th>;
                                      if (col === 'actions') return <th key={col} className="px-4 py-3 text-white text-end">{language === 'ar' ? 'إجراءات الاعتماد' : 'Auth Actions'}</th>;
                                      return null;
                                    })}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                  {groupOrders.map((ord, subIdx) => renderOrderRowContent(ord, subIdx))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              };

              if (activeTab === 'orders') {
                return groupedFinanceOrderItems.map((item, itemIdx) => {
                  if (item.type === 'blanket_project_group') {
                    return renderBlanketCard({
                      groupId: item.groupId,
                      projectName: item.projectName,
                      latestOrder: item.latestOrder,
                      orders: item.orders,
                      isProjectConsolidated: true
                    });
                  }
                  if (item.type === 'blanket_single') {
                    return renderBlanketCard({
                      groupId: item.order.id,
                      projectName: getOrderProjectName(item.order),
                      latestOrder: item.order,
                      orders: [item.order],
                      isProjectConsolidated: false
                    });
                  }
                  return renderOrderRowContent(item.order, item.orderIdx);
                });
              }

              return filteredOrders.map((o, orderIdx) => renderOrderRowContent(o, orderIdx));
            })()}
          </tbody>
        </table>
        {
          filteredOrders.length === 0 && !loading && (
            <div className="p-20 text-center flex flex-col items-center gap-3 text-slate-300 italic uppercase font-black tracking-widest text-xs">
              <i className="fa-solid fa-vault text-5xl opacity-10 mb-4"></i>
              {language === 'ar' ? 'قائمة العمليات المالية فارغة' : 'Financial queue is empty'}
            </div>
          )
        }

      </div>
    </div>
    ) : null}

      {/* History Tab Content - Read-only transaction history only */}
      {activeTab === 'history' ? (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
          <div className="p-8">
            <div className="flex items-center gap-3 mb-8">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-600 flex items-center justify-center">
                <i className="fa-solid fa-history text-xl"></i>
              </div>
              <div>
                <div className="font-black text-slate-800 uppercase tracking-widest text-lg">
                  {language === 'ar' ? 'سجل العمليات المالية' : 'Financial Transaction History'}
                </div>
                <div className="text-[10px] text-slate-500 font-bold uppercase mt-1">
                  {language === 'ar' ? 'عرض للقراءة فقط لكافة الأنشطة والتغييرات المالية' : 'Read-only view of all financial activities and changes'}
                </div>
                <div className="text-[8px] text-slate-400 font-bold uppercase mt-1">
                  {language === 'ar' ? 'لا توجد أزرار تشغيلية - للعرض فقط' : 'No operational buttons - view only'}
                </div>
              </div>
            </div>

            {/* Sorting Controls */}
            <div className="flex gap-4 mb-6">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-600 uppercase tracking-widest">
                  {language === 'ar' ? 'ترتيب حسب:' : 'Sort by:'}
                </span>
                <select
                  value={sortConfig.key}
                  onChange={(e) => setSortConfig({ key: e.target.value, direction: sortConfig.direction })}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium focus:border-blue-500 outline-none"
                >
                  <option value="timestamp">{t("finance.history.dateTime") || (language === 'ar' ? 'التاريخ والوقت' : 'Date / Time')}</option>
                  <option value="orderNumber">{t("finance.history.poNumber") || (language === 'ar' ? 'رقم أمر الشراء' : 'PO Number')}</option>
                  <option value="customerName">{t("finance.history.customer") || (language === 'ar' ? 'العميل' : 'Customer')}</option>
                  <option value="type">{t("finance.history.transactionType") || (language === 'ar' ? 'نوع المعاملة' : 'Transaction Type')}</option>
                  <option value="amount">{t("common.amount") || (language === 'ar' ? 'المبلغ' : "Amount")}</option>
                  <option value="revenue">{t("finance.history.poRevenue") || (language === 'ar' ? 'إيراد أمر الشراء' : 'PO Revenue')}</option>
                </select>
                <button
                  onClick={() => setSortConfig({ ...sortConfig, direction: sortConfig.direction === 'asc' ? 'desc' : 'asc' })}
                  className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium hover:bg-slate-100 transition-all"
                >
                  {sortConfig.direction === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>

            {/* Read-only Transaction History - No Operational Buttons */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center">
                  <i className="fa-solid fa-info-circle"></i>
                </div>
                <div>
                  <div className="text-sm font-bold text-amber-800 uppercase tracking-widest">
                    {language === 'ar' ? 'عرض السجل (للقراءة فقط)' : 'Read-Only History View'}
                  </div>
                  <div className="text-xs text-amber-700 mt-1">
                    {language === 'ar' ? 'يعرض هذا التبويب سجل المعاملات المالية فقط. لإدارة الطلبات، يرجى الانتقال إلى تبويب الطلبات أو الفوترة.' : 'This tab shows only financial transaction records. For order management, use the Orders or Billing Details tabs.'}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {(() => {
                let allHistoryEntries = [];

                // Collect order history entries (only financial transactions)
                orders.forEach(o => {
                  if (o.status === OrderStatus.REJECTED || o.customerName === 'Internal Stock' || (typeof o.customerReferenceNumber === 'string' && o.customerReferenceNumber.startsWith('STOCK-'))) return;
                  // Include custom history entries (only payment-related)
                  if (o.history && Array.isArray(o.history)) {
                    o.history.forEach(entry => {
                      // Only include payment history entries
                      if (entry.type === 'payment') {
                        allHistoryEntries.push({
                          orderId: o.id,
                          orderNumber: o.internalOrderNumber,
                          customerReferenceNumber: o.customerReferenceNumber,
                          customerName: o.customerName,
                          orderStatus: o.status,
                          ...entry
                        });
                      }
                    });
                  }

                  // Include only financial transaction logs (payments, invoices, authorizations)
                  if (o.logs && Array.isArray(o.logs)) {
                    o.logs.forEach(log => {
                      const message = log.message || '';

                      // Only include pure financial transactions - payments, invoices, and finance authorizations
                      const isFinancialTransaction =
                        (message.includes('Payment of') && message.includes('recorded')) ||
                        (message.includes('Official Tax Invoice Generated')) ||
                        (message.includes('Gov. E-Invoice requested') || message.includes('Gov. E-Invoice Attached')) ||
                        (message.includes('Finance Partial Receipt for Dispatch')) ||
                        (message.includes('Full payment reconciled')) ||
                        (message.includes('Payment recorded:') && message.includes('L.E.'));

                      if (isFinancialTransaction && !message.includes('[SYSTEM]') && !message.includes('[AUTO]')) {
                        allHistoryEntries.push({
                          orderId: o.id,
                          orderNumber: o.internalOrderNumber,
                          customerReferenceNumber: o.customerReferenceNumber,
                          customerName: o.customerName,
                          orderStatus: log.status || o.status,
                          type: message.includes('Payment') ? 'payment' :
                                message.includes('Invoice') ? 'invoice' :
                                message.includes('Finance') ? 'authorization' :
                                'transaction',
                          message: message,
                          timestamp: log.timestamp,
                          user: log.user || 'System'
                        });
                      }
                    });
                  }

                  // Include payments from the payments array (as separate entries)
                  if (o.payments && Array.isArray(o.payments)) {
                    o.payments.forEach((payment, idx) => {
                      allHistoryEntries.push({
                        orderId: o.id,
                        orderNumber: o.internalOrderNumber,
                        customerReferenceNumber: o.customerReferenceNumber,
                        customerName: o.customerName,
                        orderStatus: o.status,
                        type: 'payment',
                        amount: payment.amount,
                        message: language === 'ar' ? `تم تسجيل دفعة: ${payment.amount.toLocaleString()} ${getOrderCurrency(o) === 'L.E.' ? 'ج.م' : getOrderCurrency(o)}` : `Payment recorded: ${payment.amount.toLocaleString()} ${getOrderCurrency(o)}`,
                        timestamp: payment.date || new Date().toISOString(),
                        user: payment.user || 'System',
                        receiptNumber: payment.receiptNumber || `RCV-${o.internalOrderNumber ? o.internalOrderNumber.replace(/[^\w]/g, '').slice(-6) : '000000'}-${String(idx + 1).padStart(2, '0')}-${Date.now().toString().slice(-4)}`
                      });
                    });
                  }
                });

                // Filter by search term if provided
                if (historySearch.trim()) {
                  const searchTerm = historySearch.trim().toLowerCase();
                  allHistoryEntries = allHistoryEntries.filter(entry => {
                    const searchableText = [
                      entry.orderNumber || '',
                      entry.customerReferenceNumber || '',
                      entry.customerName || '',
                      entry.orderStatus || '',
                      entry.type || '',
                      entry.message || '',
                      entry.amount ? entry.amount.toString() : '',
                      entry.receiptNumber || '',
                      entry.user || '',
                      new Date(entry.timestamp).toLocaleString()
                    ].join(' ').toLowerCase();

                    return searchableText.includes(searchTerm);
                  });
                }

                // Sort based on current sort configuration
                allHistoryEntries.sort((a, b) => {
                  let valA, valB;

                  switch (sortConfig.key) {
                    case 'timestamp':
                      valA = new Date(a.timestamp).getTime();
                      valB = new Date(b.timestamp).getTime();
                      break;
                    case 'orderNumber':
                      valA = (a.orderNumber || '').toLowerCase();
                      valB = (b.orderNumber || '').toLowerCase();
                      break;
                    case 'customerName':
                      valA = (a.customerName || '').toLowerCase();
                      valB = (b.customerName || '').toLowerCase();
                      break;
                    case 'type':
                      valA = a.type || '';
                      valB = b.type || '';
                      break;
                    case 'amount':
                      valA = a.amount || 0;
                      valB = b.amount || 0;
                      break;
                    case 'revenue':
                      // Get revenue from the corresponding order
                      const orderA = orders.find(o => o.id === a.orderId);
                      const orderB = orders.find(o => o.id === b.orderId);
                      valA = orderA ? (orderA.items?.reduce((sum, item) =>
                        sum + (getItemEffectiveQty(item) * item.pricePerUnit * (1 + (item.taxPercent / 100))), 0) || 0) : 0;
                      valB = orderB ? (orderB.items?.reduce((sum, item) =>
                        sum + (getItemEffectiveQty(item) * item.pricePerUnit * (1 + (item.taxPercent / 100))), 0) || 0) : 0;
                      break;
                    default:
                      valA = new Date(a.timestamp).getTime();
                      valB = new Date(b.timestamp).getTime();
                  }

                  if (typeof valA === 'string' && typeof valB === 'string') {
                    if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
                    if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
                  } else if (typeof valA === 'number' && typeof valB === 'number') {
                    return sortConfig.direction === 'asc' ? valA - valB : valB - valA;
                  }

                  return 0;
                });

                if (allHistoryEntries.length === 0) {
                  return (
                    <div className="text-center py-20 text-slate-400 italic">
                      <i className="fa-solid fa-receipt text-5xl mb-4 opacity-20"></i>
                      <div className="text-sm font-bold uppercase tracking-widest">{language === 'ar' ? 'لم يتم العثور على معاملات مالية' : 'No financial transactions found'}</div>
                      <div className="text-xs font-medium mt-2">{language === 'ar' ? 'ستظهر أنشطة المدفوعات والفواتير هنا' : 'Payment and invoice activities will appear here'}</div>
                    </div>
                  );
                }

                return allHistoryEntries.map((entry, idx) => {
                  const order = orders.find(o => o.id === entry.orderId);
                  return (
                    <div key={`${entry.orderId}-${entry.timestamp}-${idx}`} className="bg-slate-50 rounded-xl border border-slate-200 p-6 hover:bg-white hover:shadow-sm transition-all">
                      <div className="flex items-start justify-between gap-6">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${
                              entry.type === 'payment' ? 'bg-emerald-100 text-emerald-600' :
                              entry.type === 'invoice' ? 'bg-blue-100 text-blue-600' :
                              entry.type === 'authorization' ? 'bg-amber-100 text-amber-600' :
                              'bg-slate-100 text-slate-600'
                            }`}>
                              <i className={`fa-solid ${
                                entry.type === 'payment' ? 'fa-money-bill-wave' :
                                entry.type === 'invoice' ? 'fa-file-invoice' :
                                entry.type === 'authorization' ? 'fa-check-circle' :
                                'fa-circle-info'
                              }`}></i>
                            </div>
                            <div>
                              <div className="font-black text-slate-800 text-base uppercase tracking-tight">
                                {entry.type === 'payment' ? `${entry.amount?.toLocaleString()} ${language === 'ar' ? 'ج.م' : 'L.E.'} ${language === 'ar' ? 'دفعة مسددة' : 'Payment'}` :
                                 entry.type === 'invoice' ? (language === 'ar' ? 'تم إصدار الفاتورة الضريبية' : 'Tax Invoice Generated') :
                                 entry.type === 'authorization' ? (language === 'ar' ? 'اعتماد مالي' : 'Finance Authorization') :
                                 (t("finance.history.financialTransaction") || (language === 'ar' ? 'معاملة مالية' : 'Financial Transaction'))}
                              </div>
                              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-2 flex-wrap">
                                <span>{entry.orderNumber}</span>
                                {entry.customerReferenceNumber && (
                                  <span className="text-slate-400 font-bold normal-case text-[9px] bg-slate-200/60 px-1 py-0.5 rounded">
                                    {language === 'ar' ? 'أمر شراء:' : 'PO:'} {entry.customerReferenceNumber}
                                  </span>
                                )}
                                <span>•</span>
                                <span>{entry.customerName}</span>
                                <span>•</span>
                                <span>{entry.orderStatus?.replace(/_/g, ' ')}</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-sm text-slate-700 font-medium leading-relaxed mb-3">
                            {entry.message}
                          </div>
                          {entry.receiptNumber && (
                            <div className="text-xs font-bold text-emerald-600 uppercase tracking-widest bg-emerald-50 px-3 py-1 rounded-lg inline-block">
                              {language === 'ar' ? 'إيصال:' : 'Receipt:'} {entry.receiptNumber}
                            </div>
                          )}
                        </div>
                        <div className="flex items-start justify-end gap-3">
                          <div className="text-end">
                            <div className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">
                              {new Date(entry.timestamp).toLocaleString(language === 'ar' ? 'ar-EG' : 'en-US')}
                            </div>
                            <div className="text-xs font-bold text-slate-600 mt-1">
                              {entry.user}
                            </div>
                          </div>
                          {/* Only show receipt download for payment entries - no other operational buttons */}
                          {entry.type === 'payment' && entry.receiptNumber && order && (
                            <button
                              onClick={() => generateReceiptPDF(order, entry)}
                              className="px-3 py-2 bg-blue-600 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-blue-700 transition-all flex items-center gap-1"
                              title={language === 'ar' ? "تحميل إيصال PDF" : "Download Receipt PDF"}
                            >
                              <i className="fa-solid fa-file-pdf"></i>
                              {language === 'ar' ? 'إيصال استلام' : 'Receipt'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'stock_orders' && (
        <div className="space-y-6">
          {/* Header Notice Banner with Grand Total Stock Value */}
          <div className="bg-gradient-to-r from-emerald-900 via-slate-900 to-slate-900 text-white p-8 rounded-[2.5rem] shadow-xl relative overflow-hidden">
            <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-black uppercase tracking-widest mb-3 border border-emerald-500/30">
                  <i className="fa-solid fa-boxes-stacked"></i> {language === 'ar' ? 'عمليات تعزيز وتغذية المخزون الداخلي' : 'Internal Stock Replenishment Operations'}
                </div>
                <h3 className="text-2xl font-black tracking-tight">
                  {language === 'ar' ? 'دفتر تقييم وجرد المخزون ومستودعات الشركة' : 'Warehouse Inventory & Stock Valuation Ledger'}
                </h3>
                <p className="text-xs text-slate-300 font-medium max-w-2xl mt-1 leading-relaxed">
                  {language === 'ar' 
                    ? 'تُخصص أوامر المخزون حصرياً لتعزيز الرصيد الاحتياطي للمستودعات وتوريدات المخزون الداخلي. هذه الأوامر لا تحمل إيراد عميل (0)، ومعفاة تماماً من الفوترة الضريبية، ولا ترتبط بمحافظ عملاء، وتعكس ديناميكياً قيم المكونات المنقولة.'
                    : 'Stock orders are dedicated exclusively to warehouse buffer replenishment and internal stock sourcing. These orders carry 0 customer revenue, are completely exempt from billing/tax invoicing, have no customer wallet, and dynamically reflect transferred component values.'}
                </p>
              </div>
              <div className="text-start md:text-end bg-white/5 backdrop-blur-sm px-6 py-4 rounded-3xl border border-white/10 shrink-0">
                <div className="text-[10px] font-black uppercase text-emerald-400 tracking-widest flex items-center gap-1.5 md:justify-end">
                  <i className="fa-solid fa-vault"></i> {language === 'ar' ? 'إجمالي قيمة المخزون الكلية' : 'Grand Total Inventory Value'}
                </div>
                <div className="text-3xl font-black text-white mt-1 font-mono">
                  {language === 'ar' ? 'ج.م' : 'L.E.'} {stockStats.grandTotalInventoryValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[10px] font-bold text-slate-300 mt-0.5">
                  {stockStats.insideStockCount} {language === 'ar' ? 'مكونات مستلمة بمستودع المركز' : 'received components in warehouse hub'}
                  {stockStats.inTransitionValue > 0 && (
                    <span className="text-cyan-300 ml-1">
                      · {language === 'ar' ? 'ج.م' : 'L.E.'} {stockStats.inTransitionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'في الطريق' : 'in transit'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 3-Way Split Cards + Total Stock Orders */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 1. Inside Stock */}
            <div className="bg-white p-6 rounded-[2rem] border-2 border-emerald-100 shadow-sm flex items-center gap-4 hover:border-emerald-200 transition-all">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl shrink-0">
                <i className="fa-solid fa-circle-check"></i>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-emerald-700 uppercase tracking-widest flex items-center gap-1">
                  <span>{language === 'ar' ? 'داخل المخزون (بالمستودع)' : 'Inside Inventory (Stock)'}</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
                </div>
                <div className="text-xl font-black text-slate-900 font-mono mt-0.5 truncate">
                  {language === 'ar' ? 'ج.م' : 'L.E.'} {stockStats.insideStockValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[10px] font-bold text-slate-500 mt-0.5">
                  {stockStats.insideStockCount} {language === 'ar' ? 'مكونات مستلمة بالمستودع' : 'received components in warehouse'}
                </div>
              </div>
            </div>

            {/* 2. In Transition */}
            <div className="bg-white p-6 rounded-[2rem] border-2 border-cyan-100 shadow-sm flex items-center gap-4 hover:border-cyan-200 transition-all">
              <div className="w-14 h-14 rounded-2xl bg-cyan-50 text-cyan-700 flex items-center justify-center text-2xl shrink-0">
                <i className="fa-solid fa-truck-fast"></i>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-cyan-700 uppercase tracking-widest flex items-center gap-1">
                  <span>{language === 'ar' ? 'قيد التوريد (في الطريق)' : 'In Transition (On The Way)'}</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 inline-block"></span>
                </div>
                <div className="text-xl font-black text-slate-900 font-mono mt-0.5 truncate">
                  {language === 'ar' ? 'ج.م' : 'L.E.'} {stockStats.inTransitionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[10px] font-bold text-slate-500 mt-0.5">
                  {stockStats.inTransitionCount} {language === 'ar' ? 'بأمر شراء صادر، بانتظار الاستلام' : 'ordered via PO, pending receipt'}
                </div>
              </div>
            </div>

            {/* 3. Not Ordered Yet */}
            <div className="bg-white p-6 rounded-[2rem] border-2 border-amber-100 shadow-sm flex items-center gap-4 hover:border-amber-200 transition-all">
              <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center text-2xl shrink-0">
                <i className="fa-solid fa-clock-rotate-left"></i>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-amber-700 uppercase tracking-widest flex items-center gap-1">
                  <span>{language === 'ar' ? 'لم يتم طلبه بعد' : 'Not Ordered Yet'}</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block"></span>
                </div>
                <div className="text-xl font-black text-slate-900 font-mono mt-0.5 truncate">
                  {language === 'ar' ? 'ج.م' : 'L.E.'} {stockStats.notOrderedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div className="text-[10px] font-bold text-slate-500 mt-0.5">
                  {stockStats.notOrderedCount} {language === 'ar' ? 'في مرحلة الدراسة / العروض / الترسية' : 'in study / RFP / award phase'}
                </div>
              </div>
            </div>

            {/* 4. Total Stock Orders */}
            <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl shrink-0">
                <i className="fa-solid fa-clipboard-list"></i>
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {language === 'ar' ? 'طلبات المخزون' : 'Stock Orders'}
                </div>
                <div className="text-xl font-black text-slate-900 font-mono mt-0.5">{stockStats.totalOrders}</div>
                <div className="text-[10px] font-bold text-slate-500 mt-0.5">
                  {stockStats.activeOrdersCount} {language === 'ar' ? 'نشط' : 'Active'} · {stockStats.fulfilledOrdersCount} {language === 'ar' ? 'مكتمل' : 'Fulfilled'}
                </div>
              </div>
            </div>
          </div>

          {/* Stock Orders List */}
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <i className="fa-solid fa-layer-group text-emerald-400"></i>
                <span className="text-xs font-black uppercase tracking-widest">
                  {language === 'ar' ? `أوامر تعزيز المخزون (${filteredStockOrders.length})` : `Stock Replenishment Orders (${filteredStockOrders.length})`}
                </span>
              </div>
              {filteredStockOrders.length > 0 && (
                <button
                  onClick={() => {
                    const allExpanded = filteredStockOrders.every(o => expandedOrderIds[o.id]);
                    filteredStockOrders.forEach(o => {
                      setExpandedOrderIds(prev => ({ ...prev, [o.id]: !allExpanded }));
                    });
                  }}
                  className="text-[10px] font-black uppercase text-slate-300 hover:text-white transition-colors"
                >
                  {filteredStockOrders.every(o => expandedOrderIds[o.id]) ? (language === 'ar' ? 'طي الكل' : 'Collapse All') : (language === 'ar' ? 'توسيع الكل' : 'Expand All')}
                </button>
              )}
            </div>

            {filteredStockOrders.length === 0 ? (
              <div className="p-20 text-center">
                <div className="w-16 h-16 rounded-3xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-4 text-2xl">
                  <i className="fa-solid fa-box-open"></i>
                </div>
                <h4 className="text-sm font-black text-slate-700 uppercase tracking-wide">
                  {language === 'ar' ? 'لم يتم العثور على أوامر مخزون' : 'No Stock Orders Found'}
                </h4>
                <p className="text-xs text-slate-400 font-medium mt-1">
                  {search ? (language === 'ar' ? 'لا توجد أوامر مخزون تطابق استعلام البحث الحالي.' : 'No stock orders match your current search query.') : (language === 'ar' ? 'أنشئ أوامر مخزون من إدارة الطلبات ← تبويب أوامر المخزون.' : 'Create stock orders under Order Management → Stock Orders tab.')}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredStockOrders.map(order => {
                  const isExpanded = !!expandedOrderIds[order.id];
                  const allComps = (order.items || []).flatMap(it =>
                    (it.components || []).map(c => {
                      const remQty = getStockCompRemainingQty(order.id, it, c);
                      const allocQty = getStockCompAllocatedQty(order.id, it, c);
                      const recQty = getStockCompReceivedQty(order.id, it, c);
                      const unitCost = Number(c.unitCost) || 0;
                      const cat = getStockCompCategory(c, remQty);
                      const unreceivedQty = Math.max(0, remQty - recQty);
                      const inTransitVal = cat === 'in_transition' ? unreceivedQty * unitCost : 0;
                      const notOrderedVal = cat === 'not_ordered' ? unreceivedQty * unitCost : 0;
                      return {
                        ...c,
                        remainingQty: remQty,
                        allocatedQty: allocQty,
                        receivedQty: recQty,
                        inventoryVal: recQty * unitCost,
                        inTransitVal,
                        notOrderedVal,
                        category: cat
                      };
                    })
                  );
                  const totalOrderInventoryVal = allComps.reduce((sum, c) => sum + c.inventoryVal, 0);
                  const totalOrderInTransitVal = allComps.reduce((sum, c) => sum + c.inTransitVal, 0);
                  const totalOrderNotOrderedVal = allComps.reduce((sum, c) => sum + c.notOrderedVal, 0);
                  const receivedComps = allComps.filter(c => c.receivedQty > 0 || c.category === 'inside_stock').length;
                  const isFulfilled = order.status === OrderStatus.FULFILLED;
                  const hasReceived = receivedComps > 0;
                  const hasInTransit = allComps.some(c => c.category === 'in_transition');

                  return (
                    <div key={order.id} className="transition-colors hover:bg-slate-50/50">
                      {/* Order Row Header */}
                      <div
                        onClick={() => toggleOrderExpand(order.id)}
                        className="p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4 cursor-pointer select-none"
                      >
                        <div className="flex items-start lg:items-center gap-4">
                          <button
                            className="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center text-xs shrink-0 transition-all"
                            onClick={(e) => { e.stopPropagation(); toggleOrderExpand(order.id); }}
                          >
                            <i className={`fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'}`}></i>
                          </button>
                          <div>
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-mono font-black text-sm text-slate-900">
                                {order.internalOrderNumber || order.customerReferenceNumber}
                              </span>
                              <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200">
                                {language === 'ar' ? 'أمر شراء:' : 'PO:'} {order.customerReferenceNumber}
                              </span>
                              <span className="px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-slate-100 text-slate-600">
                                {language === 'ar' ? 'مخزون داخلي' : 'Internal Stock'}
                              </span>
                              {order.orderDate && (
                                <span className="text-[10px] font-bold text-slate-400">
                                  <i className="fa-regular fa-calendar mr-1"></i>
                                  {new Date(order.orderDate).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 font-medium mt-1">
                              {order.items.length} {language === 'ar' ? (order.items.length === 1 ? 'بند' : 'بنود') : (order.items.length !== 1 ? 'Line Items' : 'Line Item')} · {allComps.length} {language === 'ar' ? (allComps.length === 1 ? 'مكون مورد' : 'مكونات موردة') : (allComps.length !== 1 ? 'Sourced Components' : 'Sourced Component')}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-6 self-end lg:self-center">
                          {/* Progress Indicator */}
                          <div className="text-right">
                            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">
                              {language === 'ar' ? 'معدل الاستلام' : 'Receiving Progress'}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-black ${isFulfilled ? 'text-emerald-600' : 'text-blue-600'}`}>
                                {receivedComps} / {allComps.length} {language === 'ar' ? 'بالمخزن' : 'In Stock'}
                              </span>
                              <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase ${
                                isFulfilled
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : hasReceived
                                    ? 'bg-blue-100 text-blue-700'
                                    : hasInTransit
                                      ? 'bg-cyan-100 text-cyan-800'
                                      : 'bg-amber-100 text-amber-800'
                              }`}>
                                {isFulfilled
                                  ? (language === 'ar' ? 'مكتمل التوريد ✓' : 'Fulfilled ✓')
                                  : hasReceived
                                    ? (language === 'ar' ? 'مستلم جزئياً بالمخزن' : 'Partially In Stock')
                                    : hasInTransit
                                      ? (language === 'ar' ? 'في الطريق (صدر أمر شراء)' : 'In Transit (PO Issued)')
                                      : (language === 'ar' ? 'لم يتم طلبه بعد' : 'Not Ordered Yet')}
                              </span>
                            </div>
                          </div>

                          {/* Current Stock Inventory Value */}
                          <div className="text-right min-w-36">
                            <div className="text-[9px] font-black uppercase tracking-widest text-emerald-600 mb-1">
                              {language === 'ar' ? 'قيمة المخزون' : 'Inventory Value'}
                            </div>
                            <div className="text-sm font-black text-slate-900 font-mono">
                              {language === 'ar' ? 'ج.م' : 'L.E.'} {totalOrderInventoryVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                            {totalOrderInTransitVal > 0 && (
                              <div className="text-[8px] font-bold text-cyan-600 mt-0.5">
                                (+ {language === 'ar' ? 'ج.م' : 'L.E.'} {totalOrderInTransitVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'في الطريق' : 'in transit'})
                              </div>
                            )}
                            {totalOrderNotOrderedVal > 0 && (
                              <div className="text-[8px] font-bold text-amber-600 mt-0.5">
                                (+ {language === 'ar' ? 'ج.م' : 'L.E.'} {totalOrderNotOrderedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'لم يُطلب بعد' : 'not ordered yet'})
                              </div>
                            )}
                          </div>

                          {/* Status Badge */}
                          <div className="min-w-28 text-end">
                            <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider inline-block ${
                              order.status === OrderStatus.FULFILLED ? 'bg-emerald-600 text-white shadow-sm' :
                              order.status === OrderStatus.WAITING_SUPPLIERS ? 'bg-amber-100 text-amber-800' :
                              order.status === OrderStatus.TECHNICAL_REVIEW ? 'bg-indigo-100 text-indigo-800' :
                              order.status === OrderStatus.LOGGED ? 'bg-slate-100 text-slate-700' :
                              'bg-blue-100 text-blue-800'
                            }`}>
                              {order.status}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Expanded Line Items & Component Breakdown */}
                      {isExpanded && (
                        <div className="px-8 pb-8 pt-2 bg-slate-50/70 border-t border-slate-100">
                          <div className="space-y-4">
                            {order.items.map((item, itemIdx) => (
                              <div key={item.id || itemIdx} className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
                                <div className="flex justify-between items-center mb-3">
                                  <div>
                                    <div className="text-xs font-black text-slate-800 uppercase flex items-center gap-2">
                                      <span className="w-5 h-5 rounded-md bg-slate-100 text-slate-600 flex items-center justify-center text-[10px]">
                                        {itemIdx + 1}
                                      </span>
                                      <span>{item.description}</span>
                                    </div>
                                    <div className="text-[10px] font-bold text-slate-400 mt-0.5 ml-7">
                                      {language === 'ar' ? 'المطلوب:' : 'Requested:'} {item.quantity} {item.unit || (language === 'ar' ? 'قطعة' : 'pcs')} · {language === 'ar' ? 'الإنتاج:' : 'Production:'} {item.productionType || 'MANUFACTURING'}
                                    </div>
                                  </div>
                                </div>

                                {/* Components Table with per-component Current Stock Value */}
                                {item.components && item.components.length > 0 ? (
                                  <div className="ml-7 overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                      <thead>
                                        <tr className="border-b border-slate-100 text-[9px] font-black uppercase text-slate-400">
                                          <th className="py-2">{language === 'ar' ? 'المكون / كود الصنف' : 'Component / SKU'}</th>
                                          <th className="py-2">{language === 'ar' ? 'تصنيف المخزون' : 'Stock Category'}</th>
                                          <th className="py-2">{language === 'ar' ? 'المورد' : 'Supplier'}</th>
                                          <th className="py-2 text-right">{language === 'ar' ? 'الكمية المتبقية' : 'Remaining Qty'}</th>
                                          <th className="py-2 text-right">{language === 'ar' ? 'الكمية المستلمة' : 'Received Qty'}</th>
                                          <th className="py-2 text-right">{language === 'ar' ? 'سعر الوحدة' : 'Unit Cost'}</th>
                                          <th className="py-2 text-right text-emerald-700">{language === 'ar' ? 'قيمة المخزون الحالية' : 'Current Stock Value'}</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-50 font-medium">
                                        {item.components.map((comp, compIdx) => {
                                          const remainingQty = getStockCompRemainingQty(order.id, item, comp);
                                          const allocatedQty = getStockCompAllocatedQty(order.id, item, comp);
                                          const receivedInStockQty = getStockCompReceivedQty(order.id, item, comp);
                                          const unitCost = Number(comp.unitCost) || 0;
                                          const currentInventoryVal = receivedInStockQty * unitCost;
                                          const cat = getStockCompCategory(comp, remainingQty);
                                          const unreceivedQty = Math.max(0, remainingQty - receivedInStockQty);
                                          const inTransitVal = cat === 'in_transition' ? unreceivedQty * unitCost : 0;
                                          const notOrderedVal = cat === 'not_ordered' ? unreceivedQty * unitCost : 0;
                                          const partNum = comp.supplierPartNumber || comp.componentNumber || '—';

                                          return (
                                            <tr key={comp.id || compIdx} className="hover:bg-slate-50">
                                              <td className="py-2.5 pr-4">
                                                <div className="font-bold text-slate-800">{comp.description}</div>
                                                <div className="text-[10px] font-mono text-slate-400">SKU: {partNum}</div>
                                              </td>
                                              <td className="py-2.5 pr-4">
                                                {cat === 'inside_stock' ? (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase inline-flex items-center gap-1 bg-emerald-100 text-emerald-800 border border-emerald-200">
                                                    <i className="fa-solid fa-circle-check text-emerald-600"></i> {language === 'ar' ? 'داخل المخزون' : 'Inside Stock'}
                                                  </span>
                                                ) : cat === 'in_transition' ? (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase inline-flex items-center gap-1 bg-cyan-100 text-cyan-800 border border-cyan-200">
                                                    <i className="fa-solid fa-truck-fast text-cyan-600"></i> {language === 'ar' ? 'في الطريق' : 'In Transition'} {comp.poNumber ? `(${comp.poNumber})` : ''}
                                                  </span>
                                                ) : (
                                                  <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase inline-flex items-center gap-1 bg-amber-100 text-amber-800 border border-amber-200">
                                                    <i className="fa-solid fa-clock-rotate-left text-amber-600"></i> {language === 'ar' ? 'لم يُطلب' : 'Not Ordered'} ({comp.status || 'NEW'})
                                                  </span>
                                                )}
                                              </td>
                                              <td className="py-2.5 pr-4 text-slate-600 font-bold">
                                                {comp.supplierName || '—'}
                                              </td>
                                              <td className="py-2.5 pr-4 text-right font-bold text-slate-700">
                                                <div>{remainingQty} {comp.unit || (language === 'ar' ? 'قطعة' : 'pcs')}</div>
                                                {allocatedQty > 0 && (
                                                  <div className="text-[8px] text-teal-600 font-bold tracking-tight">
                                                    {language === 'ar' ? `(${allocatedQty} مخصص لأوامر شراء)` : `(${allocatedQty} allocated to POs)`}
                                                  </div>
                                                )}
                                              </td>
                                              <td className="py-2.5 pr-4 text-right font-black">
                                                <span className={receivedInStockQty > 0 ? 'text-emerald-600 font-bold' : 'text-slate-400 font-medium'}>
                                                  {receivedInStockQty}
                                                </span>
                                              </td>
                                              <td className="py-2.5 pr-4 text-right text-slate-700 font-mono">
                                                {language === 'ar' ? 'ج.م' : 'L.E.'} {unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                              </td>
                                              <td className="py-2.5 text-right font-black font-mono">
                                                {receivedInStockQty > 0 ? (
                                                  <>
                                                    <div className="text-emerald-700">
                                                      {language === 'ar' ? 'ج.م' : 'L.E.'} {currentInventoryVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                    </div>
                                                    {inTransitVal > 0 && (
                                                      <div className="text-[8px] font-bold text-cyan-600">
                                                        (+ {language === 'ar' ? 'ج.م' : 'L.E.'} {inTransitVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'في الطريق' : 'in transit'})
                                                      </div>
                                                    )}
                                                    {notOrderedVal > 0 && (
                                                      <div className="text-[8px] font-bold text-amber-600">
                                                        (+ {language === 'ar' ? 'ج.م' : 'L.E.'} {notOrderedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {language === 'ar' ? 'لم يُطلب بعد' : 'not ordered yet'})
                                                      </div>
                                                    )}
                                                  </>
                                                ) : (
                                                  <>
                                                    <div className="text-slate-400 font-medium">{language === 'ar' ? 'ج.م 0.00' : 'L.E. 0.00'}</div>
                                                    {cat === 'in_transition' ? (
                                                      <div className="text-[8px] font-bold text-cyan-600 uppercase tracking-tight">
                                                        {language === 'ar' ? 'في الطريق' : 'In Transition'} ({language === 'ar' ? 'ج.م' : 'L.E.'} {inTransitVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                                                      </div>
                                                    ) : (
                                                      <div className="text-[8px] font-bold text-amber-600 uppercase tracking-tight">
                                                        {language === 'ar' ? 'لم يُطلب' : 'Not Ordered'} ({comp.status || 'NEW'})
                                                      </div>
                                                    )}
                                                  </>
                                                )}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="ml-7 text-xs text-slate-400 italic py-2">
                                    {language === 'ar' ? 'لم يتم تحديد مكونات بعد (بانتظار دراسة المراجعة الفنية).' : 'No components defined yet (pending Technical Review study).'}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {decisionModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className={`bg-white rounded-[2.5rem] shadow-2xl w-full p-8 md:p-10 animate-in zoom-in-95 border border-slate-100 max-h-[92vh] overflow-y-auto ${decisionModal.type === 'payment' ? 'max-w-2xl' : 'max-w-lg'}`}>
            <div className="flex items-center gap-6 mb-8">
              <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-3xl shadow-inner ${
                decisionModal.type === 'payment' ? 'bg-emerald-50 text-emerald-600' :
                decisionModal.type === 'cancelInvoice' || decisionModal.type === 'revertToSourcing' ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600'
                }`}>
                <i className={`fa-solid ${
                  decisionModal.type === 'billing' ? 'fa-file-invoice-dollar' :
                  decisionModal.type === 'payment' ? 'fa-receipt' :
                    decisionModal.type === 'marginRelease' ? 'fa-chart-line-down' :
                      decisionModal.type === 'cancelInvoice' ? 'fa-file-circle-xmark' :
                        decisionModal.type === 'revertToSourcing' ? 'fa-rotate-left' : 'fa-shield-halved'
                  }`}></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  {decisionModal.type === 'payment' ? (t("finance.orders.receivePayment") || (language === 'ar' ? 'استلام دفعة' : "Receive Payment")) :
                    decisionModal.type === 'cancelInvoice' ? (language === 'ar' ? 'إلغاء الفاتورة الضريبية الرسمية' : 'Void Official Invoice') :
                    decisionModal.type === 'revertToSourcing' ? (language === 'ar' ? 'إرجاع استراتيجي لمرحلة التوريد' : 'Strategic Lifecycle Revert') :
                      decisionModal.type.replace(/([A-Z])/g, ' $1') + ' Task'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{language === 'ar' ? 'الهدف:' : 'Target:'} {decisionModal.entityName}</p>
              </div>
            </div>

            {errorMsg && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3 animate-pulse"><i className="fa-solid fa-circle-exclamation"></i>{errorMsg}</div>}

            {decisionModal.type === 'payment' ? (() => {
              const paymentOrder = orders.find(o => o.id === decisionModal.entityId);
              let grossSum = 0;
              ((paymentOrder?.items) || []).forEach(it => grossSum += (getItemEffectiveQty(it) * (it.pricePerUnit || 0) * (1 + ((it.taxPercent || 0) / 100))));
              const totalPaid = ((paymentOrder?.payments) || []).reduce((s: number, p: any) => s + (p.amount || 0), 0);
              const outstanding = Math.max(0, grossSum - totalPaid);
              const pCurr = paymentOrder ? getOrderCurrency(paymentOrder) : 'L.E.';
              const displayCurr = pCurr === 'L.E.' && language === 'ar' ? 'ج.م' : pCurr;
              const prevPayments = paymentOrder?.payments || [];
              const isFullySettled = outstanding <= 0.01;

              return (
                <div className="space-y-6">
                  {/* Order Context Details */}
                  {paymentOrder && (
                    <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col gap-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-black px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200">
                            {paymentOrder.internalOrderNumber}
                          </span>
                          {paymentOrder.customerReferenceNumber && (
                            <span className="font-mono text-[10px] text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                              {language === 'ar' ? 'أمر شراء:' : 'PO:'} {paymentOrder.customerReferenceNumber}
                            </span>
                          )}
                        </div>
                        <span className={`text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full border ${isFullySettled ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'}`}>
                          {isFullySettled ? (language === 'ar' ? 'تمت التسوية بالكامل ✓' : 'Fully Settled ✓') : (language === 'ar' ? 'مستحق سداد' : 'Payment Due')}
                        </span>
                      </div>
                      <div className="text-sm font-black text-slate-800">
                        {paymentOrder.customerName}
                      </div>
                    </div>
                  )}

                  {/* Financial Metrics Cards */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200">
                      <div className="text-[9px] font-black uppercase text-slate-400 tracking-wider">
                        {language === 'ar' ? 'الإجمالي الشامل' : 'Total Gross'}
                      </div>
                      <div className="text-sm font-black text-slate-800 mt-1 font-mono">
                        {grossSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className="text-[8px] font-bold text-slate-400 mt-0.5">{displayCurr}</div>
                    </div>

                    <div className="p-3.5 bg-emerald-50/60 rounded-2xl border border-emerald-200/80">
                      <div className="text-[9px] font-black uppercase text-emerald-700 tracking-wider">
                        {language === 'ar' ? 'إجمالي المسدد' : 'Total Paid'}
                      </div>
                      <div className="text-sm font-black text-emerald-800 mt-1 font-mono">
                        {totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className="text-[8px] font-bold text-emerald-600 mt-0.5">{displayCurr}</div>
                    </div>

                    <div className={`p-3.5 rounded-2xl border ${outstanding > 0 ? 'bg-amber-50/70 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                      <div className={`text-[9px] font-black uppercase tracking-wider ${outstanding > 0 ? 'text-amber-800' : 'text-slate-400'}`}>
                        {language === 'ar' ? 'المتبقي المستحق' : 'Outstanding'}
                      </div>
                      <div className={`text-sm font-black mt-1 font-mono ${outstanding > 0 ? 'text-amber-900' : 'text-slate-700'}`}>
                        {outstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <div className={`text-[8px] font-bold mt-0.5 ${outstanding > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{displayCurr}</div>
                    </div>
                  </div>

                  {/* Previous Payments & Receipts List */}
                  {prevPayments.length > 0 && (
                    <div className="border border-slate-200 rounded-2xl overflow-hidden bg-white">
                      <div className="px-4 py-2.5 bg-slate-100/80 border-b border-slate-200 flex justify-between items-center">
                        <span className="text-[10px] font-black uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                          <i className="fa-solid fa-clock-rotate-left text-blue-600"></i>
                          <span>{t("finance.orders.paymentHistoryReceipts") || (language === 'ar' ? 'سجل المدفوعات والإيصالات' : "Payment History / Receipts")} ({prevPayments.length})</span>
                        </span>
                        <span className="text-[9px] text-slate-500 font-bold">
                          {t("finance.orders.regenerateReceiptHint") || (language === 'ar' ? 'انقر أدناه لإعادة إصدار إيصال PDF' : "Click below to regenerate receipt PDF")}
                        </span>
                      </div>
                      <div className="max-h-44 overflow-y-auto divide-y divide-slate-100">
                        {prevPayments.map((p: any, pIdx: number) => {
                          const rcvNum = p.receiptNumber || `RCV-${(paymentOrder?.internalOrderNumber || '').replace(/[^\w]/g, '').slice(-6)}-${String(pIdx + 1).padStart(2, '0')}`;
                          return (
                            <div key={pIdx} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors">
                              <div className="flex flex-col">
                                <span className="font-mono text-xs font-black text-blue-700">{rcvNum}</span>
                                <span className="text-[9px] font-bold text-slate-400">
                                  {p.date ? new Date(p.date).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US') : 'N/A'} {p.memo ? `• ${p.memo}` : ''}
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <span className="font-black text-slate-800 text-xs font-mono">
                                  {(Number(p.amount) || 0).toLocaleString()} {displayCurr}
                                </span>
                                {paymentOrder && (
                                  <button
                                    type="button"
                                    disabled={isDownloadingReceipt}
                                    onClick={() => generateReceiptPDF(paymentOrder, p)}
                                    className="px-2.5 py-1.5 bg-blue-50 hover:bg-blue-600 text-blue-700 hover:text-white rounded-lg text-[9px] font-black uppercase transition-all border border-blue-200 flex items-center gap-1 cursor-pointer"
                                    title={language === 'ar' ? "تحميل إيصال PDF لهذه الدفعة" : "Download PDF Receipt for this payment"}
                                  >
                                    {isDownloadingReceipt ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-file-pdf"></i>}
                                    <span>{t("finance.orders.generateReceipt") || (language === 'ar' ? 'إصدار إيصال' : "Generate Receipt")}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Customer Wallet Balance Credit (if available) */}
                  {paymentOrder && (() => {
                    const customerObj = customers.find(c => c.name === paymentOrder.customerName);
                    const generalWallet = Number(customerObj?.walletBalance || 0);
                    const projName = getOrderProjectName(paymentOrder);
                    const projectWallet = Number(customerObj?.walletBalances?.[projName] || 0);
                    const totalCustomerWallet = generalWallet + projectWallet;

                    if (totalCustomerWallet <= 0) return null;

                    return (
                      <div className="p-3.5 bg-emerald-50 rounded-2xl border border-emerald-200 flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                            <i className="fa-solid fa-wallet"></i>
                          </div>
                          <div>
                            <div className="text-xs font-black text-emerald-900">
                              {language === 'ar' ? 'رصيد دائن متاح بمحفظة العميل' : 'Customer Wallet Credit Available'}
                            </div>
                            <div className="text-[10px] text-emerald-700 font-bold">
                              {totalCustomerWallet.toLocaleString()} {displayCurr} {language === 'ar' ? 'متاح بالحساب' : 'available on account'}
                            </div>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer bg-white px-3 py-1.5 rounded-xl border border-emerald-300 hover:border-emerald-400 transition-all shadow-xs">
                          <input
                            type="checkbox"
                            checked={useCustomerWallet}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setUseCustomerWallet(checked);
                              if (checked) {
                                const maxApplicable = Math.min(outstanding, totalCustomerWallet);
                                setPaymentAmount(maxApplicable.toFixed(2));
                                if (!comment) setComment(language === 'ar' ? `تسوية من رصيد محفظة العميل (${projName || 'دفعة مقدمة'})` : `Settled from customer wallet credit (${projName || 'Advance Prepayment'})`);
                              }
                            }}
                            className="w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500"
                          />
                          <span className="text-[10px] font-black uppercase text-emerald-900">
                            {language === 'ar' ? 'استخدام من المحفظة' : 'Apply from Wallet'}
                          </span>
                        </label>
                      </div>
                    );
                  })()}

                  {/* Receive New Payment Form */}
                  <div className="space-y-4 pt-2 border-t border-slate-100">
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <label className="text-[10px] font-black text-slate-600 uppercase tracking-widest ml-1">
                          {t("finance.orders.receivePayment") || (language === 'ar' ? 'مبلغ الدفعة المستلمة' : "Receive Payment Amount")} ({displayCurr})
                        </label>
                        {outstanding > 0 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount(outstanding.toFixed(2))}
                            className="text-[9px] font-black text-blue-600 hover:text-blue-800 uppercase tracking-wider hover:underline cursor-pointer"
                          >
                            {language === 'ar' ? `تعيين كامل الرصيد (${outstanding.toLocaleString()} ${displayCurr})` : `Set Full Balance (${outstanding.toLocaleString()} ${pCurr})`}
                          </button>
                        )}
                      </div>
                      <input
                        type="number" step="any" min="0" autoFocus
                        className="w-full p-3.5 border-2 rounded-2xl bg-slate-50 font-black text-xl outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-500 focus:bg-white transition-all font-mono"
                        placeholder="0.00"
                        value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-600 uppercase tracking-widest ml-1">
                        {t("finance.orders.paymentMemo") || (language === 'ar' ? 'بيان / مرجع السداد' : "Payment Memo / Reference")}
                      </label>
                      <input
                        type="text"
                        placeholder={t("finance.ledger.whatIsThisFor") || (language === 'ar' ? 'مرجع تحويل بنكي، شيك #، إيصال نقدي...' : "Bank transfer ref, check #, cash receipt...")}
                        className="w-full p-3.5 border-2 rounded-2xl bg-slate-50 text-xs font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 focus:bg-white transition-all"
                        value={comment} onChange={e => setComment(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Action Buttons inside Payment Modal */}
                  <div className="mt-8 flex gap-2.5 flex-wrap items-center">
                    <button
                      type="button"
                      onClick={closeModals}
                      className="px-5 py-3.5 bg-slate-100 text-slate-500 hover:bg-slate-200 font-black rounded-2xl uppercase text-[10px] tracking-widest transition-all cursor-pointer"
                    >
                      {t("common.cancel") || (language === 'ar' ? 'إلغاء' : "Cancel")}
                    </button>

                    <div className="flex-1 flex gap-2 justify-end items-center flex-wrap">
                      {prevPayments.length > 0 && paymentOrder && (
                        <button
                          type="button"
                          disabled={isDownloadingReceipt}
                          onClick={() => generateReceiptPDF(paymentOrder, prevPayments[prevPayments.length - 1])}
                          className="px-4 py-3.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-black rounded-2xl uppercase text-[10px] tracking-wider transition-all flex items-center gap-1.5 cursor-pointer"
                          title={language === 'ar' ? "إصدار إيصال لأحدث دفعة" : "Generate receipt for latest payment"}
                        >
                          {isDownloadingReceipt ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-file-pdf"></i>}
                          <span>{t("finance.orders.latestReceipt") || (language === 'ar' ? 'أحدث إيصال' : "Latest Receipt")}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleExecuteDecision}
                        disabled={isProcessing || isDownloadingReceipt || !paymentAmount || parseFloat(paymentAmount) <= 0}
                        className="px-4 py-3.5 bg-slate-800 hover:bg-slate-900 text-white font-black rounded-2xl uppercase text-[10px] tracking-wider transition-all disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
                        title={language === 'ar' ? "حفظ الدفعة دون تحميل إيصال PDF" : "Save payment without downloading PDF receipt"}
                      >
                        {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check"></i>}
                        <span>{t("finance.orders.recordOnly") || (language === 'ar' ? 'تسجيل فقط' : "Record Only")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleRecordAndGenerateReceipt}
                        disabled={isProcessing || isDownloadingReceipt || !paymentAmount || parseFloat(paymentAmount) <= 0}
                        className="py-3.5 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-2xl uppercase text-[10px] tracking-wider shadow-lg shadow-emerald-200 transition-all disabled:opacity-40 flex items-center justify-center gap-2 cursor-pointer"
                        title={language === 'ar' ? "تسجيل الدفعة وإصدار إيصال PDF الرسمي" : "Record payment and generate the official PDF receipt"}
                      >
                        {isProcessing || isDownloadingReceipt ? (
                          <i className="fa-solid fa-circle-notch fa-spin"></i>
                        ) : (
                          <i className="fa-solid fa-file-invoice-dollar text-sm"></i>
                        )}
                        <span>{t("finance.orders.generateReceipt") || (language === 'ar' ? 'إصدار إيصال' : "Generate Receipt")}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })() : (
              <>
                <div className="space-y-6">
                  {decisionModal.type === 'cancelInvoice' && (
                    <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100 mb-2">
                      <p className="text-xs font-bold text-rose-800 leading-relaxed">
                        {language === 'ar' 
                          ? 'تنبيه حرج: سيؤدي إلغاء هذه الفاتورة إلى حذف رقم الفاتورة الضريبية وإرجاع الطلب إلى مرحلة إصدار الفاتورة. هذا الإجراء نهائي ويتم تسجيله لأغراض التدقيق.'
                          : 'Critical: Voiding this invoice will remove the Tax Invoice number and return the order to the Issue Invoice stage. This action is permanent and recorded for audit purposes.'}
                      </p>
                    </div>
                  )}
                  {decisionModal.type === 'orderReject' && (
                    <div className="p-4 bg-rose-50 rounded-2xl border border-rose-100 mb-2 space-y-2">
                      <p className="text-xs font-bold text-rose-800 leading-relaxed">
                        {language === 'ar' ? 'تحذير: سيؤدي رفض هذا الطلب إلى تعيين حالته كـ مرفوض.' : 'Warning: Rejecting this order will mark it as REJECTED.'}
                      </p>
                      <p className="text-xs font-bold text-rose-900 leading-relaxed bg-rose-100/60 p-2.5 rounded-xl border border-rose-200">
                        <i className="fa-solid fa-boxes-stacked mr-1.5 text-rose-700"></i>
                        {t('finance.orders.stockReleaseNotice', language === 'ar' ? 'تنبيه: البنود المستلمة (مكونات أو منتجات مخزنية) ستفقد حجز العميل وتُنقل إلى المخزون العام.' : 'Notice: Received items (components or product stock) will lose customer reservation and be moved to general component stock.')}
                      </p>
                    </div>
                  )}
                  {decisionModal.type === 'revertToSourcing' && (
                    <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100 mb-2 space-y-2">
                      <p className="text-xs font-bold text-amber-800 leading-relaxed">
                        {language === 'ar'
                          ? 'تحذير: سيؤدي هذا الإجراء إلى إلغاء الفاتورة الحالية وإرجاع الطلب إلى المشتريات، وستتم إعادة تعيين المكونات لحالة "تم إرسال طلب عروض الأسعار" لإعادة الترسية.'
                          : 'Warning: This action will void the existing invoice and return the order to Procurement. Components will be reset to "RFP Sent" status to allow re-awarding.'}
                      </p>
                      <p className="text-xs font-bold text-amber-900 leading-relaxed bg-amber-100/60 p-2.5 rounded-xl border border-amber-200">
                        <i className="fa-solid fa-boxes-stacked mr-1.5 text-amber-700"></i>
                        {t('finance.orders.stockReleaseNotice', language === 'ar' ? 'تنبيه: البنود المستلمة (مكونات أو منتجات مخزنية) ستفقد حجز العميل وتُنقل إلى المخزون العام.' : 'Notice: Received items (components or product stock) will lose customer reservation and be moved to general component stock.')}
                      </p>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{t("finance.orders.paymentMemo") || (language === 'ar' ? 'بيان / مرجع السداد' : "Payment Memo / Reference")}</label>
                    <textarea
                      placeholder={t("finance.ledger.whatIsThisFor") || (language === 'ar' ? 'البيان / الغرض...' : "What is this for?")}
                      className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white h-24"
                      value={comment} onChange={e => setComment(e.target.value)}
                    />
                  </div>
                </div>

                <div className="mt-10 flex gap-3">
                  <button onClick={closeModals} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200">{t("common.cancel") || (language === 'ar' ? 'إلغاء' : "Cancel")}</button>
                  <button
                    onClick={handleExecuteDecision} disabled={isProcessing}
                    className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${decisionModal.type === 'cancelInvoice' ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-100' :
                      decisionModal.type === 'revertToSourcing' ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-100' :
                        'bg-slate-900 text-white hover:bg-black'
                      }`}
                  >
                    {isProcessing ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check-double"></i>}
                    {decisionModal.type === 'cancelInvoice' ? (t('finance.orders.cancelInvoice') || (language === 'ar' ? 'إلغاء الفاتورة' : 'Cancel Invoice')) :
                      decisionModal.type === 'revertToSourcing' ? (t('finance.orders.revertToSourcing') || (language === 'ar' ? 'إرجاع للتوريد' : 'Revert to Sourcing')) : (t('finance.orders.authActions') || (language === 'ar' ? 'اعتماد' : 'Authorize'))}
                  </button>
                </div>
              </>
            )}
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
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">{t("finance.orders.previousPayments") || (language === 'ar' ? 'المدفوعات السابقة' : 'Previous Payments')}</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{language === 'ar' ? 'الطلب:' : 'Order:'} {viewPaymentsOrder.internalOrderNumber}</p>
                  </div>
                </div>
                <button onClick={() => setViewPaymentsOrder(null)} className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-all flex items-center justify-center">
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                <table className="w-full text-start" dir={language === 'ar' ? 'rtl' : 'ltr'}>
                  <thead className="sticky top-0 bg-white z-10 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-4">{t("finance.ledger.receipt") || (language === 'ar' ? 'الإيصال' : 'Receipt')} #</th>
                      <th className="px-4 py-4">{t("common.date") || (language === 'ar' ? 'التاريخ' : "Date")}</th>
                      <th className="px-4 py-4">{t("common.amount") || (language === 'ar' ? 'المبلغ' : "Amount")}</th>
                      <th className="px-4 py-4 text-end">{t("finance.orders.authActions") || (language === 'ar' ? 'الإجراء' : "Auth Actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {(viewPaymentsOrder.payments || []).map((p, idx) => {
                      const totalPaidAtThisPoint = viewPaymentsOrder.payments?.slice(0, idx + 1).reduce((s, pay) => s + pay.amount, 0) || 0;
                      let grossSum = 0;
                      viewPaymentsOrder.items.forEach(it => grossSum += (getItemEffectiveQty(it) * it.pricePerUnit * (1 + (it.taxPercent / 100))));
                      const isClosingPayment = totalPaidAtThisPoint >= grossSum;
                      const orderCurr = getOrderCurrency(viewPaymentsOrder);
                      const displayCurr = orderCurr === 'L.E.' && language === 'ar' ? 'ج.م' : orderCurr;

                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-5 font-mono text-xs font-black text-blue-600 uppercase">{p.receiptNumber || `RCV-${(viewPaymentsOrder.internalOrderNumber || '').replace(/[^\w]/g, '').slice(-6)}-${String(idx + 1).padStart(2, '0')}-${Date.now().toString().slice(-4)}`}</td>
                          <td className="px-4 py-5 font-bold text-slate-500 text-xs">{new Date(p.date).toLocaleDateString(language === 'ar' ? 'ar-EG' : 'en-US')}</td>
                          <td className="px-4 py-5 font-black text-slate-800">{p.amount.toLocaleString()} {displayCurr}</td>
                          <td className="px-4 py-5 text-end">
                            <button
                              onClick={() => {
                                generateReceiptPDF(viewPaymentsOrder, p);
                              }}
                              disabled={isDownloadingReceipt}
                              className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black text-[10px] uppercase shadow-sm inline-flex items-center gap-1.5 transition-all cursor-pointer"
                              title={t("finance.orders.generateReceipt") || (language === 'ar' ? 'إصدار إيصال' : "Generate Receipt")}
                            >
                              {isDownloadingReceipt ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-file-pdf"></i>}
                              <span>{t("finance.orders.generateReceipt") || (language === 'ar' ? 'إصدار إيصال' : "Generate Receipt")}</span>
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
                  {language === 'ar' ? 'إجمالي المقبوضات:' : 'Total Received:'} {(viewPaymentsOrder.payments || []).reduce((s, p) => s + p.amount, 0).toLocaleString()} {getOrderCurrency(viewPaymentsOrder) === 'L.E.' && language === 'ar' ? 'ج.م' : getOrderCurrency(viewPaymentsOrder)}
                </div>
                <button onClick={() => setViewPaymentsOrder(null)} className="px-8 py-3 bg-slate-900 text-white rounded-xl hover:bg-black transition-all">{t("common.close") || (language === 'ar' ? 'إغلاق' : "Close")}</button>
              </div>
            </div>
          </div>
        )
      }

      {/* Settle Blanket Contract Modal */}
      {settleModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[120] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 border border-slate-100">
            <div className="flex items-center gap-6 mb-8">
              <div className="w-16 h-16 rounded-3xl bg-teal-50 text-teal-600 flex items-center justify-center text-3xl shadow-inner">
                <i className="fa-solid fa-scale-balanced"></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  {language === 'ar' ? 'تسوية العقد الإطاري' : 'Settle Blanket Contract'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {language === 'ar' ? 'العقد:' : 'Contract:'} {settleModal.contract.internalOrderNumber}
                </p>
              </div>
            </div>

            {contractMsg && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3"><i className="fa-solid fa-circle-exclamation"></i>{contractMsg}</div>}

            <div className="space-y-6">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                  {language === 'ar' ? 'معرف الطلب المراد تسويته / الرقم الداخلي' : 'Settling Order ID / Internal Number'}
                </label>
                <input
                  type="text" autoFocus
                  className="w-full p-4 border rounded-2xl bg-slate-50 font-black text-lg outline-none focus:ring-4 focus:ring-teal-50 focus:bg-white"
                  placeholder={language === 'ar' ? 'مثال: INT-2024-0001 أو معرف سجل الطلب' : 'e.g. INT-2024-0001 or order record ID'}
                  value={settleOrderId} onChange={e => setSettleOrderId(e.target.value)}
                />
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">
                  {language === 'ar' ? 'سيقارن العقد الإطاري بنود الطلب حسب الوصف ويودع في المحفظة أي فارق في السعر.' : 'The blanket contract will compare line items by description and credit the wallet with any price difference.'}
                </p>
              </div>
            </div>

            <div className="mt-10 flex gap-3">
              <button onClick={() => { setSettleModal(null); setContractMsg(null); }} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200">{t("common.cancel") || (language === 'ar' ? 'إلغاء' : "Cancel")}</button>
              <button
                onClick={handleSettleBlanket}
                className="flex-[2] py-4 bg-teal-600 hover:bg-teal-700 text-white rounded-2xl font-black text-[10px] uppercase shadow-xl flex items-center justify-center gap-2 transition-all"
              >
                <i className="fa-solid fa-check-double"></i>
                {language === 'ar' ? 'تسوية العقد' : 'Settle Contract'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Financial Request Modal for Blanket Contracts */}
      {finReqModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[120] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-10 animate-in zoom-in-95 border border-slate-100">
            <div className="flex items-center gap-6 mb-8">
              <div className="w-16 h-16 rounded-3xl bg-slate-900 text-white flex items-center justify-center text-3xl shadow-inner">
                <i className="fa-solid fa-file-invoice-dollar"></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  {language === 'ar' ? 'طلب مالي' : 'Financial Request'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {language === 'ar' ? 'العقد:' : 'Contract:'} {finReqModal.contract.internalOrderNumber}
                </p>
              </div>
            </div>

            {contractMsg && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3"><i className="fa-solid fa-circle-exclamation"></i>{contractMsg}</div>}

            <div className="space-y-6">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                  {language === 'ar' ? 'المبلغ المطلوب (اختياري)' : 'Requested Amount (Optional)'}
                </label>
                <input
                  type="number" step="any"
                  className="w-full p-4 border rounded-2xl bg-slate-50 font-black text-lg outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                  placeholder="0.00"
                  value={finReqAmount} onChange={e => setFinReqAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                  {language === 'ar' ? 'ربط طلب التسوية (اختياري)' : 'Link Settling Order (Optional)'}
                </label>
                <input
                  type="text"
                  className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                  placeholder={language === 'ar' ? 'معرف طلب التسوية أو رقمه الداخلي' : 'Settling order ID or internal number'}
                  value={finReqTarget} onChange={e => setFinReqTarget(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">
                  {language === 'ar' ? 'البيان / الغرض' : 'Memo / Purpose'}
                </label>
                <textarea
                  className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white h-24"
                  placeholder={language === 'ar' ? 'وصف الطلب المالي...' : 'Describe the financial request...'}
                  value={finReqMemo} onChange={e => setFinReqMemo(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-10 flex gap-3">
              <button onClick={() => { setFinReqModal(null); setContractMsg(null); }} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200">{t("common.cancel") || (language === 'ar' ? 'إلغاء' : "Cancel")}</button>
              <button
                onClick={handleFinancialRequest}
                className="flex-[2] py-4 bg-slate-900 hover:bg-black text-white rounded-2xl font-black text-[10px] uppercase shadow-xl flex items-center justify-center gap-2 transition-all"
              >
                <i className="fa-solid fa-file-arrow-down"></i>
                {language === 'ar' ? 'تسجيل الطلب المالي' : 'Log Financial Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Spreadsheet Viewer Modal */}
      {costSheetModalData && (() => {
        let sheetNames: string[] = [];
        let sheetData: any[][] = [];
        let parseError: string | null = null;

        try {
          const raw = costSheetModalData.fileData.includes(',')
            ? costSheetModalData.fileData.split(',')[1]
            : costSheetModalData.fileData;
          const wb = XLSX.read(raw, { type: 'base64' });
          sheetNames = wb.SheetNames || [];
          const activeIndex = Math.min(costSheetActiveSheetIndex, Math.max(0, sheetNames.length - 1));
          const activeName = sheetNames[activeIndex];
          if (activeName && wb.Sheets[activeName]) {
            sheetData = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[activeName], { header: 1, defval: '' });
          }
        } catch (err: any) {
          parseError = err?.message || (language === 'ar' ? 'فشل تحليل ملف جدول البيانات.' : 'Failed to parse spreadsheet file.');
        }

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
            <div className="bg-white w-full max-w-6xl max-h-[90vh] rounded-[2.5rem] shadow-2xl border border-slate-200 flex flex-col overflow-hidden animate-scaleUp">
              {/* Header */}
              <div className="px-8 py-6 bg-slate-900 text-white flex items-center justify-between border-b border-white/10 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xl border border-emerald-500/30">
                    <i className="fa-solid fa-file-excel"></i>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-black tracking-tight">{costSheetModalData.fileName}</h3>
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-black uppercase tracking-wider border border-emerald-500/30">
                        {language === 'ar' ? 'مستعرض جدول البيانات' : 'Spreadsheet Viewer'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 font-medium mt-0.5">
                      {costSheetModalData.orderTitle}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => downloadCostSheetFile(costSheetModalData.fileData, costSheetModalData.fileName)}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 shadow-lg shadow-emerald-900/20"
                    title={language === 'ar' ? "تحميل ملف Excel" : "Download Excel file"}
                  >
                    <i className="fa-solid fa-download"></i>
                    <span>{language === 'ar' ? 'تحميل' : 'Download'}</span>
                  </button>
                  <button
                    onClick={() => {
                      setCostSheetModalData(null);
                      setCostSheetActiveSheetIndex(0);
                    }}
                    className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white flex items-center justify-center transition-all"
                    title={language === 'ar' ? "إغلاق" : "Close"}
                  >
                    <i className="fa-solid fa-xmark text-lg"></i>
                  </button>
                </div>
              </div>

              {/* Sheet Tabs if multiple sheets */}
              {sheetNames.length > 1 && (
                <div className="px-8 py-2.5 bg-slate-100 border-b border-slate-200 flex items-center gap-2 overflow-x-auto shrink-0">
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider mr-2">
                    {language === 'ar' ? 'أوراق العمل:' : 'Sheets:'}
                  </span>
                  {sheetNames.map((name, idx) => {
                    const isActive = idx === costSheetActiveSheetIndex;
                    return (
                      <button
                        key={name}
                        onClick={() => setCostSheetActiveSheetIndex(idx)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wide transition-all ${
                          isActive
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'bg-white text-slate-600 hover:bg-slate-200 border border-slate-300/60'
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Spreadsheet Content */}
              <div className="flex-1 overflow-auto p-6 bg-slate-50 min-h-[300px]">
                {parseError ? (
                  <div className="h-full flex flex-col items-center justify-center p-12 text-center">
                    <div className="w-16 h-16 rounded-3xl bg-rose-50 text-rose-500 flex items-center justify-center text-2xl mb-4 border border-rose-200">
                      <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div className="text-sm font-black uppercase text-slate-800 tracking-wider">
                      {language === 'ar' ? 'فشل تحميل جدول البيانات' : 'Failed to Load Spreadsheet'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 max-w-md">{parseError}</div>
                  </div>
                ) : sheetData.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center p-12 text-center">
                    <div className="w-16 h-16 rounded-3xl bg-slate-100 text-slate-400 flex items-center justify-center text-2xl mb-4">
                      <i className="fa-solid fa-table-cells-large"></i>
                    </div>
                    <div className="text-sm font-black uppercase text-slate-700 tracking-wider">
                      {language === 'ar' ? 'ورقة العمل فارغة' : 'Sheet is Empty'}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      {language === 'ar' ? 'لا تحتوي ورقة العمل هذه على أي صفوف أو أعمدة مرئية.' : 'This sheet contains no visible rows or columns.'}
                    </div>
                  </div>
                ) : (
                  <div className="border border-slate-300 rounded-2xl overflow-hidden bg-white shadow-xs">
                    <div className="overflow-x-auto max-h-[60vh]">
                      <table className="w-full text-left border-collapse font-sans text-xs">
                        <tbody>
                          {sheetData.map((row, rIdx) => {
                            const isHeaderRow = rIdx === 0;
                            return (
                              <tr
                                key={rIdx}
                                className={`border-b border-slate-200 transition-colors ${
                                  isHeaderRow
                                    ? 'bg-slate-900 text-white font-black sticky top-0 shadow-xs z-10'
                                    : rIdx % 2 === 0
                                      ? 'bg-white hover:bg-blue-50/40'
                                      : 'bg-slate-50/70 hover:bg-blue-50/40'
                                }`}
                              >
                                <td className={`px-3 py-2 text-center text-[10px] font-mono border-r select-none ${
                                  isHeaderRow ? 'bg-slate-950 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-400 border-slate-200 font-bold'
                                }`}>
                                  {rIdx + 1}
                                </td>
                                {Array.isArray(row) && row.map((cell, cIdx) => (
                                  <td
                                    key={cIdx}
                                    className={`px-3 py-2 border-r border-slate-200 text-slate-800 whitespace-nowrap ${
                                      isHeaderRow ? 'text-white font-black tracking-wider border-slate-800' : ''
                                    }`}
                                  >
                                    {cell !== null && cell !== undefined ? String(cell) : ''}
                                  </td>
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-8 py-4 bg-white border-t border-slate-200 flex items-center justify-between shrink-0">
                <div className="text-xs font-bold text-slate-400 flex items-center gap-2">
                  <i className="fa-solid fa-info-circle text-blue-500"></i>
                  <span>{language === 'ar' ? `عرض ${sheetData.length} صف` : `Showing ${sheetData.length} row(s)`}</span>
                </div>
                <button
                  onClick={() => {
                    setCostSheetModalData(null);
                    setCostSheetActiveSheetIndex(0);
                  }}
                  className="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-black rounded-xl uppercase text-xs tracking-wider transition-all"
                >
                  {language === 'ar' ? 'إغلاق' : 'Close'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Customer Advance Prepayment Modal */}
      {advanceModalCustomer && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg p-8 md:p-10 animate-in zoom-in-95 border border-slate-100 space-y-6">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-2xl shadow-inner">
                <i className="fa-solid fa-hand-holding-dollar"></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  {language === 'ar' ? 'تسجيل دفعة مقدمة من العميل' : 'Record Customer Advance'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {language === 'ar' ? `إيداع دفعة غير مكتسبة بحساب ${advanceModalCustomer.name}` : `Deposit unearned prepayment to ${advanceModalCustomer.name}`}
                </p>
              </div>
            </div>

            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 text-xs">
              <div className="flex justify-between items-center text-slate-600 mb-1">
                <span>{language === 'ar' ? 'العميل:' : 'Customer:'}</span>
                <span className="font-black text-slate-800">{advanceModalCustomer.name}</span>
              </div>
              <div className="flex justify-between items-center text-slate-600">
                <span>{language === 'ar' ? 'رصيد المحفظة الحالي:' : 'Current Wallet Balance:'}</span>
                <span className="font-mono font-bold text-emerald-700">
                  {((advanceModalCustomer.walletBalance || 0) + Object.values(advanceModalCustomer.walletBalances || {}).reduce((s, v) => s + (Number(v) || 0), 0)).toLocaleString()} {language === 'ar' ? 'ج.م' : 'L.E.'}
                </span>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                  {language === 'ar' ? 'مبلغ الإيداع (ج.م)' : 'Deposit Amount (L.E.)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  autoFocus
                  placeholder="0.00"
                  className="w-full p-3.5 border-2 rounded-2xl bg-slate-50 font-black text-xl outline-none focus:ring-4 focus:ring-emerald-50 focus:border-emerald-500 focus:bg-white transition-all font-mono"
                  value={advanceAmount}
                  onChange={e => setAdvanceAmount(e.target.value)}
                />
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                  {language === 'ar' ? 'تاريخ الدفعة' : 'Payment Date'}
                </label>
                <input
                  type="date"
                  className="w-full p-3.5 border-2 border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-emerald-500 transition-all"
                  value={advanceDate}
                  onChange={e => setAdvanceDate(e.target.value)}
                />
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                  {language === 'ar' ? 'مرجع السداد / البيان' : 'Payment Reference / Memo'}
                </label>
                <input
                  type="text"
                  placeholder={language === 'ar' ? 'مثال: تحويل بنكي مرجع #12345، شيك #...' : 'e.g. Bank transfer ref #12345, check #...'}
                  className="w-full p-3.5 border-2 border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-emerald-500 transition-all"
                  value={advanceMemo}
                  onChange={e => setAdvanceMemo(e.target.value)}
                />
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">
                  {language === 'ar' ? 'تخصيص لمشروع (اختياري)' : 'Project Allocation (Optional)'}
                </label>
                <input
                  type="text"
                  placeholder={language === 'ar' ? 'اتركه فارغاً لدفعة عامة / طلبات مستقبلية' : 'Leave empty for general advance / future orders'}
                  className="w-full p-3.5 border-2 border-slate-200 rounded-2xl text-xs font-bold outline-none focus:border-emerald-500 transition-all"
                  value={advanceProject}
                  onChange={e => setAdvanceProject(e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => {
                  setAdvanceModalCustomer(null);
                  setAdvanceAmount('');
                  setAdvanceMemo('');
                  setAdvanceProject('');
                }}
                className="px-6 py-3.5 bg-slate-100 text-slate-600 hover:bg-slate-200 font-black rounded-2xl uppercase text-[10px] tracking-widest transition-all cursor-pointer"
              >
                {language === 'ar' ? 'إلغاء' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={advanceLoading || !advanceAmount || parseFloat(advanceAmount) <= 0}
                onClick={handleRecordCustomerAdvance}
                className="px-8 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-2xl uppercase text-[10px] tracking-widest shadow-lg shadow-emerald-200 transition-all disabled:opacity-50 cursor-pointer"
              >
                {advanceLoading ? <i className="fa-solid fa-spinner fa-spin mr-2"></i> : <i className="fa-solid fa-check mr-2"></i>}
                {language === 'ar' ? 'إيداع في المحفظة' : 'Deposit to Wallet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div >
  );
};

export const FinanceModule: React.FC<FinanceModuleProps> = (props) => (
  <LanguageProvider pageId="finance">
    <FinanceModuleInner {...props} />
  </LanguageProvider>
);



