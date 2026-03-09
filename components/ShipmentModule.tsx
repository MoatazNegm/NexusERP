import React, { useState, useEffect, useMemo, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig, User, CustomerOrderItem } from '../types';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

interface ShipmentModuleProps {
    config: AppConfig;
    refreshKey?: number;
    currentUser: User;
}

const DeliveryThresholdMarker: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
    const [remaining, setRemaining] = useState<number>(0);

    useEffect(() => {
        const calc = () => {
            const limitHrs = config.settings.deliveryLimitHrs;
            const lastLog = [...(order.logs || [])].reverse().find(l => l.status === OrderStatus.HUB_RELEASED);
            const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp || order.orderDate).getTime();
            const elapsedMs = Date.now() - startTime;
            setRemaining((limitHrs * 3600000) - elapsedMs);
        };
        calc();
        const timer = setInterval(calc, 60000);
        return () => clearInterval(timer);
    }, [order.status, config.settings, order.logs, order.dataEntryTimestamp, order.orderDate]);

    const isOver = remaining < 0;
    const absRemaining = Math.abs(remaining);
    const hrs = Math.floor(absRemaining / 3600000);
    const mins = Math.floor((absRemaining % 3600000) / 60000);
    const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

    return (
        <div className={`text-[10px] font-black uppercase flex items-center gap-1.5 mt-1 ${isOver ? 'text-rose-500 animate-pulse' : 'text-emerald-500'}`}>
            <i className={`fa-solid ${isOver ? 'fa-clock-rotate-left' : 'fa-truck-fast'}`}></i>
            {isOver ? `Delivery SLA Overdue by ${timeStr}` : `Delivery window: ${timeStr} left`}
        </div>
    );
};

type ShipmentTab = 'pending' | 'transit' | 'history';

export const ShipmentModule: React.FC<ShipmentModuleProps> = ({ config, refreshKey, currentUser }) => {
    const [activeTab, setActiveTab] = useState<ShipmentTab>('pending');
    const [existingOrders, setExistingOrders] = useState<CustomerOrder[]>([]);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [historySearch, setHistorySearch] = useState('');

    // Delivery Note PDF & POD State
    const deliveryNoteRef = useRef<HTMLDivElement>(null);
    const [printingOrder, setPrintingOrder] = useState<CustomerOrder | null>(null);
    const [confirmingDeliveryId, setConfirmingDeliveryId] = useState<string | null>(null);
    const podUploadRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetchData();
    }, [refreshKey]);

    const fetchData = async () => {
        const o = await dataService.getOrders();
        setExistingOrders(o);
    };

    const pendingTransitOrders = useMemo(() => {
        return existingOrders.filter(o => {
            if (![OrderStatus.IN_PRODUCT_HUB, OrderStatus.ISSUE_INVOICE, OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.PARTIAL_DELIVERY].includes(o.status as OrderStatus)) return false;
            return o.items.some(i => (i.dispatchedQty || 0) > (i.shippedQty || 0));
        });
    }, [existingOrders]);

    const inTransitOrders = useMemo(() => {
        return existingOrders.filter(o => {
            if (![OrderStatus.IN_PRODUCT_HUB, OrderStatus.ISSUE_INVOICE, OrderStatus.INVOICED, OrderStatus.HUB_RELEASED, OrderStatus.PARTIAL_DELIVERY].includes(o.status as OrderStatus)) return false;
            return o.items.some(i => (i.shippedQty || 0) > (i.deliveredQty || 0));
        });
    }, [existingOrders]);

    const deliveryHistory = useMemo(() => {
        const flat: { order: CustomerOrder; delivery: NonNullable<CustomerOrder['deliveries']>[0]; item: CustomerOrderItem; qty: number }[] = [];
        existingOrders.forEach(o => {
            (o.deliveries || []).forEach(d => {
                d.items.forEach(di => {
                    const item = o.items.find(i => i.id === di.itemId);
                    if (item) {
                        flat.push({ order: o, delivery: d, item, qty: di.qty });
                    }
                });
            });
        });

        return flat
            .filter(h =>
                h.order.internalOrderNumber?.toLowerCase().includes(historySearch.toLowerCase()) ||
                h.order.customerName.toLowerCase().includes(historySearch.toLowerCase()) ||
                h.item.description.toLowerCase().includes(historySearch.toLowerCase())
            )
            .sort((a, b) => new Date(b.delivery.date).getTime() - new Date(a.delivery.date).getTime());
    }, [existingOrders, historySearch]);

    const displayOrders = activeTab === 'pending' ? pendingTransitOrders : inTransitOrders;

    useEffect(() => {
        if (printingOrder) {
            setTimeout(() => {
                if (deliveryNoteRef.current) {
                    generatePdf();
                } else {
                    console.error("Ref not found after timeout");
                    alert("Error: Template not generated. Please try again.");
                    setPrintingOrder(null);
                }
            }, 100);
        }
    }, [printingOrder]);

    const generatePdf = async () => {
        if (!printingOrder || !deliveryNoteRef.current) return;
        setProcessingId(printingOrder.id);
        try {
            const element = deliveryNoteRef.current;
            const canvas = await html2canvas(element, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });
            const imgData = canvas.toDataURL('image/png');
            const pdf = new jsPDF({
                orientation: 'p',
                unit: 'pt',
                format: 'a4'
            });
            const pageWidth = pdf.internal.pageSize.getWidth();
            const imgWidth = pageWidth;
            const imgHeight = (canvas.height * imgWidth) / canvas.width;
            pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
            pdf.save(`DeliveryNote-${printingOrder.internalOrderNumber}.pdf`);
        } catch (e: any) {
            console.error("PDF Gen Error:", e);
            alert(`Failed to generate PDF: ${e.message}`);
        } finally {
            setPrintingOrder(null);
            setProcessingId(null);
        }
    };

    const handlePodUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || !e.target.files[0] || !confirmingDeliveryId) return;
        const file = e.target.files[0];
        setProcessingId(confirmingDeliveryId);
        try {
            const uploadRes = await dataService.uploadProofOfDelivery(file);
            if (uploadRes.success) {
                const orderToConfirm = existingOrders.find(o => o.id === confirmingDeliveryId);
                const itemsToDeliver = orderToConfirm?.items.filter(i => (i.shippedQty || 0) > (i.deliveredQty || 0)).map(i => ({
                    itemId: i.id,
                    qty: (i.shippedQty || 0) - (i.deliveredQty || 0)
                })) || [];

                await dataService.confirmOrderDelivery(confirmingDeliveryId, uploadRes.filePath, itemsToDeliver);
                alert("Delivery confirmed and POD uploaded successfully.");
                await fetchData();
            } else {
                throw new Error(uploadRes.error || "Upload failed");
            }
        } catch (err: any) {
            alert("Failed to confirm delivery: " + err.message);
        } finally {
            setProcessingId(null);
            setConfirmingDeliveryId(null);
            if (podUploadRef.current) podUploadRef.current.value = '';
        }
    };

    return (
        <div className="max-w-[1200px] mx-auto pb-12 space-y-6">
            <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-2xl w-fit">
                <button
                    onClick={() => setActiveTab('pending')}
                    className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'pending' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                    {pendingTransitOrders.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-emerald-500 text-white rounded-full">{pendingTransitOrders.length}</span>}
                    Pending Transit
                </button>
                <button
                    onClick={() => setActiveTab('transit')}
                    className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'transit' ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                    {inTransitOrders.length > 0 && <span className="mr-2 px-1.5 py-0.5 bg-sky-500 text-white rounded-full">{inTransitOrders.length}</span>}
                    In Transit
                </button>
                <button
                    onClick={() => setActiveTab('history')}
                    className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'history' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >
                    <i className="fa-solid fa-clock-rotate-left mr-2"></i>
                    Delivery History
                </button>
            </div>

            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                        <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-2xl ${activeTab === 'pending' ? 'bg-emerald-600 shadow-emerald-100' : activeTab === 'transit' ? 'bg-sky-600 shadow-sky-100' : 'bg-slate-800 shadow-slate-200'} flex items-center justify-center text-white shadow-lg`}>
                                <i className={`fa-solid ${activeTab === 'pending' ? 'fa-truck-arrow-right' : activeTab === 'transit' ? 'fa-truck-fast' : 'fa-clipboard-check'} text-xl`}></i>
                            </div>
                            <div className="flex-1 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                                        {activeTab === 'pending' ? 'Cargo Preparation' : activeTab === 'transit' ? 'Last Mile Delivery' : 'Fulfillment Archive'}
                                    </h2>
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                        {activeTab === 'pending' ? 'Load dispatched items onto transport vehicles' : activeTab === 'transit' ? 'Confirm fulfillment and upload POD for items in transit' : 'View all completed deliveries and signed documents'}
                                    </p>
                                </div>
                                {activeTab === 'history' && (
                                    <div className="relative">
                                        <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                                        <input
                                            type="text"
                                            placeholder="Search History..."
                                            value={historySearch}
                                            onChange={e => setHistorySearch(e.target.value)}
                                            className="pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[10px] font-bold uppercase tracking-wider focus:ring-4 focus:ring-slate-50 outline-none w-64 transition-all"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-slate-50/50 border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                                {activeTab === 'history' ? (
                                    <tr>
                                        <th className="px-8 py-5">Delivery Date</th>
                                        <th className="px-8 py-5">Order / Customer</th>
                                        <th className="px-8 py-5">Delivered Item</th>
                                        <th className="px-8 py-5 text-center">Qty</th>
                                        <th className="px-8 py-5 text-right">Documents</th>
                                    </tr>
                                ) : (
                                    <tr>
                                        <th className="px-8 py-5">Reference ID</th>
                                        <th className="px-8 py-5">Customer Entity</th>
                                        <th className="px-8 py-5">Status</th>
                                        <th className="px-8 py-5">Value (Excl. tax)</th>
                                        <th className="px-8 py-5 text-right">Action</th>
                                    </tr>
                                )}
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {activeTab === 'history' ? (
                                    deliveryHistory.map((h, idx) => (
                                        <tr key={`${h.delivery.id}-${h.item.id}-${idx}`} className="hover:bg-slate-50 transition-all">
                                            <td className="px-8 py-6">
                                                <div className="font-black text-slate-700 text-xs">{new Date(h.delivery.date).toLocaleDateString()}</div>
                                                <div className="text-[9px] font-bold text-slate-400 uppercase mt-1">{new Date(h.delivery.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                            </td>
                                            <td className="px-8 py-6">
                                                <div className="font-mono text-[10px] font-black text-blue-600 uppercase mb-1">{h.order.internalOrderNumber}</div>
                                                <div className="font-bold text-slate-800 text-xs">{h.order.customerName}</div>
                                            </td>
                                            <td className="px-8 py-6">
                                                <div className="font-bold text-slate-700 text-xs">{h.item.description}</div>
                                            </td>
                                            <td className="px-8 py-6 text-center">
                                                <span className="px-3 py-1 bg-slate-100 text-slate-800 rounded-full font-black text-[10px]">{h.qty} {h.item.unit}</span>
                                            </td>
                                            <td className="px-8 py-6 text-right">
                                                {h.delivery.podFilePath ? (
                                                    <a
                                                        href={h.delivery.podFilePath}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-xl font-black text-[9px] uppercase hover:bg-emerald-100 transition-all"
                                                    >
                                                        <i className="fa-solid fa-file-contract"></i> View Signed POD
                                                    </a>
                                                ) : (
                                                    <span className="text-[9px] font-bold text-slate-300 uppercase italic">No File Uploaded</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))
                                ) : (
                                    displayOrders.map(order => (
                                        <tr key={order.id} className="hover:bg-sky-50/40 transition-all group">
                                            <td className="px-8 py-6 font-mono text-xs font-black text-sky-600 uppercase">
                                                <div>{order.internalOrderNumber}</div>
                                                <div className="flex flex-col gap-0.5 mt-1.5">
                                                    <div className="text-[9px] text-slate-500 font-black uppercase">PO: {order.customerReferenceNumber || 'UNMATCHED'}</div>
                                                    <div className="text-[9px] text-slate-400 font-bold uppercase">Inv: {order.invoiceNumber || 'NOT ISSUED'}</div>
                                                </div>
                                            </td>
                                            <td className="px-8 py-6">
                                                <div className="font-black text-slate-800 text-sm tracking-tight">{order.customerName}</div>
                                                <div className="text-[10px] text-slate-500 mb-2">{order.items.length} POS Fabricated</div>

                                                {/* Inline Item Display for Shipment Context */}
                                                <div className="flex flex-col gap-1 border-t border-slate-100 pt-2 mt-2">
                                                    <div className="text-[8px] font-black uppercase text-slate-400 tracking-widest mb-1">
                                                        {activeTab === 'pending' ? 'Items Ready for Dispatch' : 'Items In Transit'}
                                                    </div>
                                                    {order.items.map((item, i) => {
                                                        const relevantQty = activeTab === 'pending'
                                                            ? (item.dispatchedQty || 0) - (item.shippedQty || 0)
                                                            : (item.shippedQty || 0) - (item.deliveredQty || 0);

                                                        if (relevantQty <= 0) return null;
                                                        return (
                                                            <div key={i} className="flex justify-between items-center bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                                                <span className="text-[10px] font-bold text-slate-700 truncate max-w-[150px]" title={item.description}>
                                                                    {item.description}
                                                                </span>
                                                                <span className="text-[9px] font-black text-slate-900 bg-white px-2 py-0.5 rounded shadow-sm border border-slate-200">
                                                                    {relevantQty} {item.unit}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </td>
                                            <td className="px-8 py-6 whitespace-nowrap">
                                                {activeTab === 'pending' ? (
                                                    <div className="flex flex-col gap-1">
                                                        <span className="px-2 py-1 bg-emerald-50 text-emerald-600 rounded-lg text-[10px] font-black uppercase border border-emerald-100 w-fit">Dispatched</span>
                                                        <span className="text-[9px] text-slate-400 font-bold uppercase">Awaiting Transit</span>
                                                    </div>
                                                ) : (
                                                    <DeliveryThresholdMarker order={order} config={config} />
                                                )}
                                            </td>
                                            <td className="px-8 py-6 font-black text-slate-700 text-sm">
                                                {order.items.reduce((s, i) => s + (i.quantity * i.pricePerUnit), 0).toLocaleString()} <span className="text-[10px] text-slate-400">L.E.</span>
                                            </td>
                                            <td className="px-8 py-6 text-right">
                                                <div className="flex flex-col gap-2 items-end">
                                                    {activeTab === 'pending' ? (
                                                        <div className="flex flex-col gap-2 items-end">
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() => setPrintingOrder(order)}
                                                                    className="px-4 py-2 bg-slate-100 text-slate-600 font-bold text-[10px] uppercase rounded-lg hover:bg-slate-200 transition-all flex items-center gap-2"
                                                                >
                                                                    <i className="fa-solid fa-download"></i> Delivery Note
                                                                </button>
                                                                <button
                                                                    disabled={processingId === order.id}
                                                                    onClick={async () => {
                                                                        setProcessingId(order.id);
                                                                        try {
                                                                            const itemsToShip = order.items.filter(i => (i.dispatchedQty || 0) > (i.shippedQty || 0)).map(i => ({
                                                                                itemId: i.id,
                                                                                qty: (i.dispatchedQty || 0) - (i.shippedQty || 0)
                                                                            }));
                                                                            await dataService.shipItems(order.id, itemsToShip);
                                                                            fetchData();
                                                                        } finally {
                                                                            setProcessingId(null);
                                                                        }
                                                                    }}
                                                                    className="px-6 py-2 bg-emerald-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 flex items-center gap-2"
                                                                >
                                                                    {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-truck-arrow-right"></i>}
                                                                    Start Transit
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <button
                                                                onClick={() => setPrintingOrder(order)}
                                                                className="px-4 py-2 bg-slate-100 text-slate-600 font-bold text-[10px] uppercase rounded-lg hover:bg-slate-200 transition-all flex items-center gap-2"
                                                            >
                                                                <i className="fa-solid fa-download"></i> Delivery Note
                                                            </button>
                                                            <button
                                                                disabled={processingId === order.id}
                                                                onClick={() => { setConfirmingDeliveryId(order.id); setTimeout(() => podUploadRef.current?.click(), 100); }}
                                                                className="px-6 py-2.5 bg-sky-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-sky-700 transition-all shadow-lg shadow-sky-100 flex items-center gap-2"
                                                            >
                                                                {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-hand-holding-hand"></i>}
                                                                Confirm Delivered
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                                {((activeTab === 'history' && deliveryHistory.length === 0) || (activeTab !== 'history' && displayOrders.length === 0)) && (
                                    <tr>
                                        <td colSpan={5} className="px-8 py-20 text-center text-slate-300">
                                            <div className="flex flex-col items-center gap-3">
                                                <i className={`fa-solid ${activeTab === 'pending' ? 'fa-boxes-packing' : activeTab === 'transit' ? 'fa-truck-fast' : 'fa-clock-rotate-left'} text-5xl opacity-10`}></i>
                                                <p className="font-black text-xs uppercase tracking-[0.2em]">No records found in this stage</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {activeTab !== 'history' && (
                    <div className={`p-6 rounded-2xl border flex gap-4 animate-in slide-in-from-top-4 ${activeTab === 'pending' ? 'bg-emerald-50 border-emerald-100' : 'bg-amber-50 border-amber-100'}`}>
                        <i className={`fa-solid fa-circle-info mt-0.5 ${activeTab === 'pending' ? 'text-emerald-500' : 'text-amber-500'}`}></i>
                        <div className="space-y-1">
                            <h4 className={`text-[10px] font-black uppercase ${activeTab === 'pending' ? 'text-emerald-900' : 'text-amber-900'}`}>
                                {activeTab === 'pending' ? 'Dispatch Clearance' : 'Operational Protocol'}
                            </h4>
                            <p className={`text-xs font-medium ${activeTab === 'pending' ? 'text-emerald-800' : 'text-amber-800'}`}>
                                {activeTab === 'pending'
                                    ? "Items appearing here have been released from the warehouse. Confirming 'Transit' marks them as physically loaded on the truck."
                                    : "Items appearing here are currently 'In Transit'. Download the Delivery Note and ensure the customer signs it before confirming delivery."}
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {/* Hidden Delivery Note Template */}
            {printingOrder && (
                <div className="fixed -left-[3000px] top-0">
                    <div ref={deliveryNoteRef} className="bg-white p-12 text-slate-900 font-sans" style={{ width: '800px', minHeight: '1100px', letterSpacing: '0px', fontVariantLigatures: 'normal', direction: 'ltr' }}>
                        {/* Header */}
                        <div className="flex justify-between items-start mb-12">
                            <div>
                                {config.settings.companyLogo ? (
                                    <img
                                        src={config.settings.companyLogo}
                                        alt={config.settings.companyName}
                                        className="w-32 h-20 object-contain mb-4"
                                        crossOrigin="anonymous"
                                    />
                                ) : (
                                    <div className="w-20 h-20 bg-slate-900 text-white rounded-full flex items-center justify-center text-2xl font-black mb-4">
                                        {config.settings.companyName.substring(0, 2).toUpperCase()}
                                    </div>
                                )}
                                <h1 className="text-2xl font-black text-slate-900 uppercase" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{config.settings.companyName}</h1>
                                <p className="text-sm font-medium text-slate-500 max-w-[200px]" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{config.settings.companyAddress}</p>
                            </div>
                            <div className="text-right">
                                <h2 className="text-4xl font-black text-slate-200 uppercase mb-2" style={{ letterSpacing: '0px' }}>Delivery Note</h2>
                                <div className="text-sm font-bold text-slate-400 uppercase">#{printingOrder.internalOrderNumber}</div>
                                <div className="text-xs font-bold text-slate-400 mt-1">Date: {new Date().toLocaleDateString()}</div>
                            </div>
                        </div>

                        {/* Receiver Info */}
                        <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 mb-10 flex justify-between">
                            <div>
                                <div className="text-[10px] font-black text-slate-400 uppercase mb-2" style={{ letterSpacing: '0px' }}>Deliver To</div>
                                <div className="text-lg font-black text-slate-800" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{printingOrder.customerName}</div>
                                <div className="text-sm font-medium text-slate-600 mt-1" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{printingOrder.customerReferenceNumber}</div>
                            </div>
                            <div className="text-right">
                                <div className="text-[10px] font-black text-slate-400 uppercase mb-2" style={{ letterSpacing: '0px' }}>Reference Documents</div>
                                <div className="text-sm font-bold text-slate-600">PO Ref: {printingOrder.customerReferenceNumber}</div>
                                <div className="text-sm font-bold text-slate-600">Inv Ref: {printingOrder.invoiceNumber || 'PENDING'}</div>
                            </div>
                        </div>

                        {/* Items Table */}
                        <div className="mb-16">
                            <table className="w-full text-left">
                                <thead className="bg-slate-900 text-white text-[10px] font-black uppercase">
                                    <tr>
                                        <th className="px-6 py-4 rounded-l-xl">Item Description</th>
                                        <th className="px-6 py-4 text-center">Unit</th>
                                        <th className="px-6 py-4 text-right rounded-r-xl">Delivered Qty</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100">
                                    {printingOrder.items.map((item, idx) => {
                                        const qty = activeTab === 'pending'
                                            ? (item.dispatchedQty || 0) - (item.shippedQty || 0)
                                            : (item.shippedQty || 0) - (item.deliveredQty || 0);

                                        if (qty <= 0) return null;
                                        return (
                                            <tr key={idx}>
                                                <td className="px-6 py-6 font-bold text-slate-800" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{item.description}</td>
                                                <td className="px-6 py-6 text-center text-sm font-medium text-slate-500">{item.unit}</td>
                                                <td className="px-6 py-6 text-right font-black text-slate-900">{qty}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Signatures */}
                        <div className="grid grid-cols-2 gap-12 mt-auto">
                            <div className="border-t-2 border-slate-200 pt-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase mb-8" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>Issued By ({config.settings.companyName})</div>
                                <div className="h-16"></div>
                                <div className="text-xs font-bold text-slate-900 border-t border-dashed border-slate-300 pt-2 w-2/3">Authorized Signature & Date</div>
                            </div>
                            <div className="border-t-2 border-slate-200 pt-4">
                                <div className="text-[10px] font-black text-slate-400 uppercase mb-8" style={{ letterSpacing: '0px' }}>Received By (Customer)</div>
                                <div className="text-sm font-bold text-slate-800 mb-2">Name: __________________________</div>
                                <div className="text-sm font-bold text-slate-800 mb-6">ID/Ref: __________________________</div>
                                <div className="h-4"></div>
                                <div className="text-xs font-bold text-slate-900 border-t border-dashed border-slate-300 pt-2 w-2/3">Customer Signature & Date</div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="mt-12 text-center text-[10px] font-bold text-slate-300 uppercase" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>
                            Thank you for your business • {config.settings.companyName}
                        </div>
                    </div>
                </div>
            )}
            <input type="file" ref={podUploadRef} className="hidden" accept=".pdf,.jpg,.jpeg,.png" onChange={handlePodUpload} />
        </div>
    );
};
