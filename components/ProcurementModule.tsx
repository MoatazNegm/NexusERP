
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, ManufacturingComponent, Supplier, OrderStatus, AppConfig, CompStatus, User } from '../types';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';

interface ProcurementModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const getCompLimit = (status: CompStatus, settings: any) => {
  switch (status) {
    case 'PENDING_OFFER': return settings.pendingOfferLimitHrs;
    case 'RFP_SENT': return settings.rfpSentLimitHrs;
    case 'AWARDED': return settings.issuePoLimitHrs;
    case 'ORDERED': return settings.orderedLimitHrs;
    default: return 0;
  }
};

const CompThreshold: React.FC<{ component: ManufacturingComponent, config: AppConfig }> = ({ component, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = getCompLimit(component.status, config.settings);
      if (limitHrs === 0) return;
      const startTime = new Date(component.statusUpdatedAt || component.procurementStartedAt || new Date().toISOString()).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [component.status, component.statusUpdatedAt, config.settings]);

  const limitHrs = getCompLimit(component.status, config.settings);
  if (limitHrs === 0) return null;

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[9px] font-black uppercase flex items-center gap-1.5 mt-2 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-triangle-exclamation' : 'fa-clock'}`}></i>
      {isOver ? `Over Sourcing SLA by ${timeStr}` : `SLA: ${timeStr} left`}
    </div>
  );
};

export const ProcurementModule: React.FC<ProcurementModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isActionLoading, setIsActionLoading] = useState<string | null>(null);
  const poTemplateRef = useRef<HTMLDivElement>(null);
  const [poPrintData, setPoPrintData] = useState<{ order: CustomerOrder, comp: ManufacturingComponent, supplier: Supplier } | null>(null);

  // Modal States
  const [activeAction, setActiveAction] = useState<{
    type: 'RFP' | 'AWARD' | 'PO' | 'RESET' | 'ORDER_ROLLBACK';
    order: CustomerOrder;
    item?: CustomerOrderItem;
    comp?: ManufacturingComponent;
  } | null>(null);

  const [rfpSelection, setRfpSelection] = useState<string[]>([]);
  const [awardSupplierId, setAwardSupplierId] = useState<string>('');
  const [awardCost, setAwardCost] = useState<number>(0);
  const [awardTaxPercent, setAwardTaxPercent] = useState<number>(14);
  const [poNumberInput, setPoNumberInput] = useState<string>('');
  const [resetReason, setResetReason] = useState<string>('');

  useEffect(() => { fetchData(); }, [refreshKey]);

  const fetchData = async () => {
    const [o, s] = await Promise.all([dataService.getOrders(), dataService.getSuppliers()]);
    const eligibleOrders = o.filter(order => [OrderStatus.WAITING_SUPPLIERS, OrderStatus.PARTIAL_PAYMENT, OrderStatus.NEGATIVE_MARGIN, OrderStatus.TECHNICAL_REVIEW].includes(order.status));
    setOrders(eligibleOrders);
    setSuppliers(s);
  };

  const componentsToProcure = useMemo(() => {
    const list: { o: CustomerOrder, i: CustomerOrderItem, c: ManufacturingComponent }[] = [];
    orders.forEach(o => {
      o.items.forEach(i => {
        i.components?.forEach(c => {
          if (c.source === 'PROCUREMENT' && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED'].includes(c.status)) {
            list.push({ o, i, c });
          }
        });
      });
    });
    return list.sort((a, b) => a.c.statusUpdatedAt.localeCompare(b.c.statusUpdatedAt));
  }, [orders]);

  const awardSuppliersList = useMemo(() => {
    if (activeAction?.type === 'AWARD' && activeAction.comp?.rfpSupplierIds?.length) {
      return suppliers.filter(s => activeAction.comp?.rfpSupplierIds?.includes(s.id));
    }
    return suppliers;
  }, [activeAction, suppliers]);

  const handleDownloadPO = async (order: CustomerOrder, comp: ManufacturingComponent) => {
    const supplier = suppliers.find(s => s.id === comp.supplierId);
    if (!supplier) {
      alert("Supplier data missing. Cannot generate PO.");
      return;
    }

    setPoPrintData({ order, comp, supplier });

    setTimeout(async () => {
      if (!poTemplateRef.current) return;

      try {
        const canvas = await html2canvas(poTemplateRef.current, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff'
        });

        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        pdf.save(`PO-${comp.poNumber}-${order.internalOrderNumber}.pdf`);
        setPoPrintData(null);
      } catch (err) {
        console.error("PDF generation failed:", err);
        alert("Failed to generate PDF. Check console.");
        setPoPrintData(null);
      }
    }, 500);
  };

  const handleExecuteAction = async () => {
    if (!activeAction) return;
    const { order, item, comp, type } = activeAction;

    if (type === 'ORDER_ROLLBACK') {
      setIsActionLoading(order.id);
      try {
        if (!resetReason.trim()) throw new Error("Rollback reason is mandatory");
        await dataService.rollbackOrderToLogged(order.id, resetReason);
        await fetchData();
        closeModal();
      } catch (e: any) { alert(e.message); }
      finally { setIsActionLoading(null); }
      return;
    }

    if (!comp || !item) return;
    setIsActionLoading(comp.id);

    try {
      let updates: Partial<ManufacturingComponent> = { statusUpdatedAt: new Date().toISOString() };

      if (type === 'RFP') {
        updates.status = 'RFP_SENT';
        updates.rfpSupplierIds = rfpSelection;
      } else if (type === 'AWARD') {
        if (!awardSupplierId || awardCost <= 0) throw new Error("Select vendor and valid negotiated cost");
        updates.status = 'AWARDED';
        updates.supplierId = awardSupplierId;
        updates.unitCost = awardCost;
        updates.taxPercent = awardTaxPercent;
      } else if (type === 'PO') {
        updates.status = 'ORDERED';
        updates.poNumber = poNumberInput;
        updates.procurementStartedAt = new Date().toISOString();
      } else if (type === 'RESET') {
        updates.status = 'PENDING_OFFER';
        updates.supplierId = undefined;
        updates.rfpSupplierIds = [];
      }

      await dataService.updateComponent(order.id, item.id, comp.id, updates);
      await fetchData();
      closeModal();
    } catch (e: any) {
      alert(e.message || "Operation failed.");
    } finally {
      setIsActionLoading(null);
    }
  };

  const closeModal = () => {
    setActiveAction(null);
    setRfpSelection([]);
    setAwardSupplierId('');
    setAwardCost(0);
    setAwardTaxPercent(14);
    setPoNumberInput('');
    setResetReason('');
  };

  const awardCalculations = useMemo(() => {
    if (activeAction?.type !== 'AWARD' || !activeAction.comp) return { totalExclTax: 0, taxAmount: 0, totalInclTax: 0 };
    const qty = activeAction.comp.quantity;
    const totalExclTax = awardCost * qty;
    const taxAmount = totalExclTax * (awardTaxPercent / 100);
    const totalInclTax = totalExclTax + taxAmount;
    return { totalExclTax, taxAmount, totalInclTax };
  }, [activeAction, awardCost, awardTaxPercent]);

  return (
    <div className="space-y-6">
      {/* Hidden PO Template for Export */}
      <div className="fixed -left-[2000px] top-0 overflow-visible">
        {poPrintData && (
          <div
            ref={poTemplateRef}
            className="bg-white p-12 text-slate-900"
            style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'none' }}
          >
            <div className="flex justify-between items-start mb-10">
              <div className="w-24 h-24 border-4 border-slate-800 rounded-full flex items-center justify-center font-black text-2xl tracking-tighter">
                {config.settings.companyLogo ? (
                  <img src={config.settings.companyLogo} className="w-full h-full object-contain" />
                ) : 'LOGO'}
              </div>
              <div className="text-right">
                <h1 className="text-3xl font-black mb-1">{config.settings.companyName}</h1>
                <p className="text-xl font-bold text-slate-600">{config.settings.companyAddress}</p>
              </div>
            </div>

            <div className="border-t-2 border-b-2 border-slate-200 py-3 mb-8 flex justify-center items-center">
              <h2 className="text-xl font-black uppercase flex items-center gap-6">
                <span>رقم الشراء : {poPrintData.comp.poNumber}</span>
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-8 mb-10">
              <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                <div className="grid grid-cols-3">
                  <div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">المطلوب من:</div>
                  <div className="col-span-2 p-3 font-black text-sm uppercase">{poPrintData.supplier.name}</div>
                </div>
                <div className="grid grid-cols-3">
                  <div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">العنوان :</div>
                  <div className="col-span-2 p-3 text-xs font-bold">{poPrintData.supplier.address || 'N/A'}</div>
                </div>
                <div className="grid grid-cols-3">
                  <div className="col-span-1 p-3 bg-slate-50 border-r-2 border-slate-900 font-bold text-xs text-right">رقم طلب العميل</div>
                  <div className="col-span-2 p-3 font-mono font-black text-blue-600 text-xs">{poPrintData.order.internalOrderNumber}</div>
                </div>
              </div>

              <div className="border-2 border-slate-900 divide-y-2 divide-slate-900">
                <div className="grid grid-cols-3">
                  <div className="col-span-2 p-3 font-black text-sm text-center tracking-widest">
                    {new Date(poPrintData.comp.statusUpdatedAt).toLocaleDateString()}
                  </div>
                  <div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-xs">التاريخ :</div>
                </div>
                <div className="p-3 bg-slate-50 text-center font-bold text-[10px]">
                  مأموريه ضرائب الشركات المساهمه - القاهره
                </div>
                <div className="grid grid-cols-3">
                  <div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">522 803 435</div>
                  <div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-[9px]">رقم التسجيل الضريبي :</div>
                </div>
                <div className="grid grid-cols-3">
                  <div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">00 212 00389 5</div>
                  <div className="col-span-1 p-3 bg-slate-50 border-l-2 border-slate-900 font-bold text-[9px]">رقم الملف الضريبي :</div>
                </div>
              </div>
            </div>

            <div className="border-2 border-slate-900 mb-10 min-h-[400px] flex flex-col">
              <div className="grid grid-cols-12 border-b-2 border-slate-900 bg-slate-50 text-[11px] font-black uppercase text-center">
                <div className="col-span-6 p-3 border-r-2 border-slate-900">Description (الوصف)</div>
                <div className="col-span-1 p-3 border-r-2 border-slate-900">Price LE<br />السعر</div>
                <div className="col-span-1 p-3 border-r-2 border-slate-900">quantities<br />الكميه</div>
                <div className="col-span-2 p-3 border-r-2 border-slate-900">unit<br />الوحده</div>
                <div className="col-span-2 p-3">Value القيمه</div>
              </div>

              <div className="grid grid-cols-12 border-b-2 border-slate-900 text-center font-black">
                <div className="col-span-6 p-6 border-r-2 border-slate-900 text-left text-lg">
                  {poPrintData.comp.description}
                </div>
                <div className="col-span-1 p-6 border-r-2 border-slate-900 flex items-center justify-center text-xl">
                  {poPrintData.comp.unitCost.toLocaleString()}
                </div>
                <div className="col-span-1 p-6 border-r-2 border-slate-900 flex items-center justify-center text-xl">
                  {poPrintData.comp.quantity}
                </div>
                <div className="col-span-2 p-6 border-r-2 border-slate-900 flex items-center justify-center text-xl">
                  {poPrintData.comp.unit === 'pcs' ? 'قطعة' : poPrintData.comp.unit}
                </div>
                <div className="col-span-2 p-6 flex items-center justify-center text-2xl">
                  {(poPrintData.comp.quantity * poPrintData.comp.unitCost).toLocaleString()}
                </div>
              </div>

              {Array.from({ length: 5 }).map((_, idx) => (
                <div key={idx} className="grid grid-cols-12 border-b-2 border-slate-900 h-10">
                  <div className="col-span-6 border-r-2 border-slate-900"></div>
                  <div className="col-span-1 border-r-2 border-slate-900"></div>
                  <div className="col-span-1 border-r-2 border-slate-900"></div>
                  <div className="col-span-2 border-r-2 border-slate-900"></div>
                  <div className="col-span-2"></div>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-end">
              <div className="w-64 border-2 border-slate-900 divide-y-2 divide-slate-900 font-black">
                <div className="grid grid-cols-2">
                  <div className="p-3 bg-slate-50 border-r-2 border-slate-900 text-xs uppercase">Subtotal</div>
                  <div className="p-3 text-right">{(poPrintData.comp.quantity * poPrintData.comp.unitCost).toLocaleString()}</div>
                </div>
                <div className="grid grid-cols-2">
                  <div className="p-3 bg-slate-50 border-r-2 border-slate-900 text-xs uppercase">Tax ){poPrintData.comp.taxPercent}%(</div>
                  <div className="p-3 text-right">{((poPrintData.comp.quantity * poPrintData.comp.unitCost) * (poPrintData.comp.taxPercent / 100)).toLocaleString()}</div>
                </div>
                <div className="grid grid-cols-2 bg-slate-100">
                  <div className="p-3 border-r-2 border-slate-900 text-sm uppercase">TOTAL</div>
                  <div className="p-3 text-right text-xl">
                    {((poPrintData.comp.quantity * poPrintData.comp.unitCost) * (1 + poPrintData.comp.taxPercent / 100)).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="text-right italic text-[10px] text-slate-400 opacity-50 mb-4 pr-10">
                AUTHORIZED DIGITAL DOCUMENT
              </div>
            </div>

            <div className="mt-16 pt-6 border-t-2 border-slate-900 flex justify-between px-4 text-[11px] font-black uppercase tracking-widest">
              <span>AGENT / المختص</span>
              <span>REFERENCE / المرجع</span>
              <span>APPROVED / يعتمد</span>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
        <div className="flex justify-between items-center mb-10">
          <div>
            <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Procurement & Sourcing Control</h2>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Strategic Supply Chain Orchestration • {componentsToProcure.length} Items</p>
          </div>
        </div>

        <div className="space-y-4">
          {componentsToProcure.map(({ o, i, c }) => (
            <div key={c.id} className="flex flex-col lg:flex-row justify-between items-center p-6 bg-slate-50 rounded-[2rem] border border-slate-100 hover:border-blue-200 transition-all group">
              <div className="flex gap-6 items-center w-full lg:w-auto">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-xl shadow-inner ${c.status === 'ORDERED' ? 'bg-emerald-50 text-emerald-600' :
                    c.status === 'AWARDED' ? 'bg-amber-50 text-amber-600' : 'bg-white text-blue-500 shadow-sm'
                  }`}>
                  <i className={`fa-solid ${c.status === 'ORDERED' ? 'fa-truck-fast' : c.status === 'AWARDED' ? 'fa-file-signature' : 'fa-diagram-project'}`}></i>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-blue-600 font-mono tracking-widest uppercase">{c.componentNumber}</span>
                    <span className={`px-2 py-0.5 text-[8px] font-black rounded uppercase ${c.status === 'ORDERED' ? 'bg-emerald-600 text-white' :
                        c.status === 'AWARDED' ? 'bg-amber-600 text-white' : 'bg-slate-900 text-white'
                      }`}>{c.status.replace('_', ' ')}</span>
                    {c.poNumber && <span className="text-[9px] font-black text-emerald-600 uppercase bg-emerald-50 px-2 rounded">PO: {c.poNumber}</span>}
                  </div>
                  <div className="font-black text-slate-800 text-base tracking-tight">{c.description}</div>
                  <div className="text-[9px] text-slate-400 font-bold uppercase mt-1">Order: {o.internalOrderNumber} • {o.customerName}</div>
                  <CompThreshold component={c} config={config} />
                </div>
              </div>
              <div className="flex items-center gap-4 mt-4 lg:mt-0">
                <div className="flex items-center">
                  <button
                    onClick={() => setActiveAction({ type: 'ORDER_ROLLBACK', order: o })}
                    className="p-3 text-slate-300 hover:text-orange-500 transition-colors opacity-0 group-hover:opacity-100"
                    title="Rollback Entire Order to Logged Registry"
                  >
                    <i className="fa-solid fa-file-export fa-flip-horizontal"></i>
                  </button>

                  {c.status === 'RFP_SENT' && (
                    <button
                      onClick={() => setActiveAction({ type: 'RESET', order: o, item: i, comp: c })}
                      className="p-3 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"
                      title="Resend RFP / Reset Component Sourcing"
                    >
                      <i className="fa-solid fa-rotate-left"></i>
                    </button>
                  )}
                </div>

                {c.status === 'PENDING_OFFER' && <button onClick={() => { setActiveAction({ type: 'RFP', order: o, item: i, comp: c }); setRfpSelection(c.rfpSupplierIds || []); }} className="px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-black transition-all">Send RFP</button>}
                {c.status === 'RFP_SENT' && <button onClick={() => { setActiveAction({ type: 'AWARD', order: o, item: i, comp: c }); setAwardCost(c.unitCost); setAwardTaxPercent(c.taxPercent || 14); }} className="px-6 py-3 bg-amber-600 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-amber-700 transition-all">Award Tender</button>}
                {c.status === 'AWARDED' && (
                  <div className="flex flex-col items-end gap-1.5">
                    <button
                      disabled={o.status === OrderStatus.NEGATIVE_MARGIN}
                      onClick={async () => { const po = await dataService.getUniquePoNumber(); setPoNumberInput(po); setActiveAction({ type: 'PO', order: o, item: i, comp: c }); }}
                      className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase shadow-lg transition-all ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                    >
                      Issue PO
                    </button>
                    {o.status === OrderStatus.NEGATIVE_MARGIN && (
                      <div className="flex items-center gap-1.5 text-[8px] font-black text-rose-500 uppercase animate-pulse">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                        Financial Breach: PO Blocked
                      </div>
                    )}
                  </div>
                )}
                {c.status === 'ORDERED' && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleDownloadPO(o, c)}
                      className="px-6 py-3 bg-white border-2 border-blue-600 text-blue-600 rounded-xl text-[10px] font-black uppercase shadow-sm hover:bg-blue-50 transition-all flex items-center gap-2"
                    >
                      <i className="fa-solid fa-file-pdf"></i> Download PO
                    </button>
                    <span className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.2em] px-2 animate-pulse"><i className="fa-solid fa-truck-fast mr-2"></i>In Transit</span>
                  </div>
                )}
              </div>
            </div>
          ))}
          {componentsToProcure.length === 0 && (
            <div className="p-24 text-center text-slate-300 italic uppercase text-xs font-black tracking-widest flex flex-col items-center gap-4">
              <i className="fa-solid fa-clipboard-check text-5xl opacity-10"></i>
              Global procurement pipeline is empty.
            </div>
          )}
        </div>
      </div>

      {activeAction && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-xl p-10 my-8 animate-in zoom-in-95 duration-300 border border-slate-100">
            <div className="flex items-center gap-6 mb-8">
              <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-3xl shadow-inner ${activeAction.type === 'RFP' ? 'bg-blue-50 text-blue-600' :
                  activeAction.type === 'AWARD' ? 'bg-amber-50 text-amber-600' :
                    activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK' ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                }`}>
                <i className={`fa-solid ${activeAction.type === 'RFP' ? 'fa-paper-plane' :
                    activeAction.type === 'AWARD' ? 'fa-award' :
                      activeAction.type === 'RESET' ? 'fa-rotate-left' :
                        activeAction.type === 'ORDER_ROLLBACK' ? 'fa-file-export fa-flip-horizontal' : 'fa-file-invoice'
                  }`}></i>
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                  {activeAction.type === 'RFP' ? 'Issue Request for Proposals' :
                    activeAction.type === 'AWARD' ? 'Commercial Award Selection' :
                      activeAction.type === 'RESET' ? 'Reset Sourcing Cycle' :
                        activeAction.type === 'ORDER_ROLLBACK' ? 'Order Workflow Rollback' : 'Confirm Purchase Order'}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                  {activeAction.type === 'ORDER_ROLLBACK' ? `Reverting to Logged Registry: ${activeAction.order.internalOrderNumber}` : `Comp: ${activeAction.comp?.description}`}
                </p>
              </div>
            </div>

            <div className="space-y-6">
              {activeAction.type === 'RFP' && (
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Select Target Suppliers (Optional)</label>
                  <p className="text-[9px] text-slate-400 font-bold uppercase ml-1 -mt-1 mb-2">If none selected, Award Tender will show all available vendors.</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-60 overflow-y-auto p-1 custom-scrollbar">
                    {suppliers.map(s => (
                      <button
                        key={s.id}
                        onClick={() => setRfpSelection(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                        className={`p-4 rounded-2xl border text-left transition-all flex items-center justify-between ${rfpSelection.includes(s.id) ? 'bg-blue-600 text-white border-blue-700 shadow-lg' : 'bg-slate-50 text-slate-700 border-slate-100 hover:border-blue-200'}`}
                      >
                        <span className="text-xs font-black uppercase tracking-tight">{s.name}</span>
                        {rfpSelection.includes(s.id) && <i className="fa-solid fa-circle-check"></i>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeAction.type === 'AWARD' && activeAction.comp && (
                <>
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center mb-4">
                    <div>
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Component Quantity</div>
                      <div className="text-xl font-black text-slate-800">{activeAction.comp.quantity} <span className="text-xs font-bold text-slate-400">{activeAction.comp.unit}</span></div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Sourcing Code</div>
                      <div className="font-mono text-xs font-bold text-blue-600">{activeAction.comp.componentNumber}</div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Award Winning Vendor</label>
                      <select
                        className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:bg-white focus:border-blue-500 transition-all"
                        value={awardSupplierId} onChange={e => setAwardSupplierId(e.target.value)}
                      >
                        <option value="">Select Vendor...</option>
                        {awardSuppliersList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Price per Item (Excl. Tax)</label>
                        <input
                          type="number" step="any"
                          className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-xl outline-none focus:bg-white focus:border-blue-500 transition-all"
                          value={awardCost} onChange={e => setAwardCost(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Tax Percentage (%)</label>
                        <input
                          type="number" step="any"
                          className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-xl outline-none focus:bg-white focus:border-blue-500 transition-all"
                          value={awardTaxPercent} onChange={e => setAwardTaxPercent(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                    </div>

                    <div className="p-6 bg-slate-900 rounded-[2rem] text-white space-y-4 mt-6">
                      <div className="flex justify-between items-center opacity-60">
                        <span className="text-[10px] font-black uppercase tracking-widest">Total Cost Without Tax</span>
                        <span className="font-bold">{awardCalculations.totalExclTax.toLocaleString()} L.E.</span>
                      </div>
                      <div className="flex justify-between items-center text-amber-400">
                        <span className="text-[10px] font-black uppercase tracking-widest">Tax Amount ({awardTaxPercent}%)</span>
                        <span className="font-bold">+{awardCalculations.taxAmount.toLocaleString()} L.E.</span>
                      </div>
                      <div className="h-px bg-white/10 my-2"></div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-black uppercase tracking-[0.2em] text-blue-400">Total Award Value (Incl. Tax)</span>
                        <span className="text-2xl font-black">{awardCalculations.totalInclTax.toLocaleString()} <span className="text-xs opacity-40">L.E.</span></span>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {activeAction.type === 'PO' && (
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">System Purchase Order ID</label>
                  <input
                    className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-2xl text-blue-600 outline-none focus:bg-white focus:border-blue-500 transition-all uppercase tracking-widest"
                    value={poNumberInput} onChange={e => setPoNumberInput(e.target.value)}
                  />
                  <p className="text-[9px] text-slate-400 font-bold uppercase mt-2">Confirming this step transitions component to "Ordered" state and initiates supply chain lead-time tracking.</p>
                </div>
              )}

              {(activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK') && (
                <div className="p-6 bg-rose-50 rounded-3xl border border-rose-100 space-y-4">
                  <p className="text-sm text-rose-800 font-bold leading-relaxed">
                    {activeAction.type === 'RESET'
                      ? 'Warning: This will void current sourcing progress and return the component to "Pending Offer".'
                      : 'Strategic Action: Reverting this entire order will move it back to the "Logged Registry". This should only be used to correct major entry errors.'
                    }
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-[9px] font-black text-rose-400 uppercase">Mandatory Operational Reason</label>
                    <textarea
                      className="w-full p-4 bg-white border border-rose-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-rose-100"
                      placeholder="e.g. Supplier failed to deliver, pricing expired, correction required..."
                      value={resetReason} onChange={e => setResetReason(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-10 flex gap-3">
              <button onClick={closeModal} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200 transition-all">Abort</button>
              <button
                disabled={isActionLoading === (activeAction.type === 'ORDER_ROLLBACK' ? activeAction.order.id : activeAction.comp?.id) || ((activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK') && !resetReason.trim())}
                onClick={handleExecuteAction}
                className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK' ? 'bg-rose-600 hover:bg-rose-700 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-100'
                  }`}
              >
                {isActionLoading ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check-double"></i>}
                {activeAction.type === 'RFP' ? 'Broadcast RFP' : activeAction.type === 'AWARD' ? 'Confirm Award' : activeAction.type === 'RESET' ? 'Confirm Reset' : activeAction.type === 'ORDER_ROLLBACK' ? 'Execute Rollback' : 'Commit Procurement'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
