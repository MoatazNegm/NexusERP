import React, { useState, useEffect, useMemo, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig, User } from '../types';
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

export const ShipmentModule: React.FC<ShipmentModuleProps> = ({ config, refreshKey, currentUser }) => {
    const [existingOrders, setExistingOrders] = useState<CustomerOrder[]>([]);
    const [processingId, setProcessingId] = useState<string | null>(null);

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

    const hubReleasedOrders = useMemo(() => {
        return existingOrders.filter(o => o.status === OrderStatus.HUB_RELEASED);
    }, [existingOrders]);

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
                await dataService.confirmOrderDelivery(confirmingDeliveryId, uploadRes.filePath);
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
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-100">
                                <i className="fa-solid fa-truck-ramp-box text-xl"></i>
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Last Mile Delivery</h2>
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Confirm fulfillment for invoiced and dispatched assets</p>
                            </div>
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead className="bg-slate-50/50 border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                                <tr>
                                    <th className="px-8 py-5">Reference ID</th>
                                    <th className="px-8 py-5">Customer Entity</th>
                                    <th className="px-8 py-5">Dispatch SLA</th>
                                    <th className="px-8 py-5">Value (Excl. tax)</th>
                                    <th className="px-8 py-5 text-right">Confirm Hand-off</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {hubReleasedOrders.map(order => (
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
                                            <div className="text-[10px] text-slate-500">{order.items.length} POS Fabricated</div>
                                        </td>
                                        <td className="px-8 py-6 whitespace-nowrap">
                                            <DeliveryThresholdMarker order={order} config={config} />
                                        </td>
                                        <td className="px-8 py-6 font-black text-slate-700 text-sm">
                                            {order.items.reduce((s, i) => s + (i.quantity * i.pricePerUnit), 0).toLocaleString()} <span className="text-[10px] text-slate-400">L.E.</span>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <button
                                                onClick={() => setPrintingOrder(order)}
                                                className="px-4 py-2 bg-slate-100 text-slate-600 font-bold text-[10px] uppercase rounded-lg hover:bg-slate-200 transition-all flex items-center gap-2 mb-2 ml-auto"
                                            >
                                                <i className="fa-solid fa-download"></i> Delivery Note
                                            </button>
                                            <button
                                                disabled={processingId === order.id}
                                                onClick={() => { setConfirmingDeliveryId(order.id); setTimeout(() => podUploadRef.current?.click(), 100); }}
                                                className="px-6 py-2.5 bg-sky-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-sky-700 transition-all shadow-lg shadow-sky-100 flex items-center gap-2 ml-auto"
                                            >
                                                {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-hand-holding-hand"></i>}
                                                Confirm Delivered
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {hubReleasedOrders.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="px-8 py-20 text-center">
                                            <div className="flex flex-col items-center gap-3 text-slate-300">
                                                <i className="fa-solid fa-box-open text-5xl opacity-10"></i>
                                                <p className="font-black text-xs uppercase tracking-[0.2em]">No shipments awaiting delivery confirmation</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {hubReleasedOrders.length > 0 && (
                    <div className="p-6 bg-amber-50 rounded-2xl border border-amber-100 flex gap-4 animate-in slide-in-from-top-4">
                        <i className="fa-solid fa-circle-info text-amber-500 mt-0.5"></i>
                        <div className="space-y-1">
                            <h4 className="text-[10px] font-black text-amber-900 uppercase">Operational Protocol</h4>
                            <p className="text-xs text-amber-800 font-medium">Orders appearing here have passed through <strong>Manufacturing</strong>, <strong>Quality Staging</strong>, <strong>Finance Invoicing</strong>, and <strong>Warehouse Release</strong>. Confirming delivery closes the active operational lifecycle for these records.</p>
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
                                <div className="w-20 h-20 bg-slate-900 text-white rounded-full flex items-center justify-center text-2xl font-black mb-4">NX</div>
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
                                    {printingOrder.items.map((item, idx) => (
                                        <tr key={idx}>
                                            <td className="px-6 py-6 font-bold text-slate-800" style={{ letterSpacing: '0px', fontVariantLigatures: 'normal' }}>{item.description}</td>
                                            <td className="px-6 py-6 text-center text-sm font-medium text-slate-500">{item.unit}</td>
                                            <td className="px-6 py-6 text-right font-black text-slate-900">{item.quantity}</td>
                                        </tr>
                                    ))}
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
