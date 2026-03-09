import React, { useState, useEffect, useMemo, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, OrderStatus, AppConfig, User } from '../types';

interface GovEInvoiceModuleProps {
    refreshKey?: number;
    currentUser: User;
}

export const GovEInvoiceModule: React.FC<GovEInvoiceModuleProps> = ({ refreshKey, currentUser }) => {
    const [orders, setOrders] = useState<CustomerOrder[]>([]);
    const [loading, setLoading] = useState(true);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [uploadingOrderId, setUploadingOrderId] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetchData();
    }, [refreshKey]);

    const fetchData = async () => {
        setLoading(true);
        try {
            const allOrders = await dataService.getOrders();
            // Filter only orders where e-invoice was requested
            setOrders(allOrders.filter(o => o.einvoiceRequested));
        } catch (e) {
            console.error("Failed to fetch orders:", e);
        } finally {
            setLoading(false);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || !e.target.files[0] || !uploadingOrderId) return;
        const file = e.target.files[0];
        setProcessingId(uploadingOrderId);
        try {
            const uploadRes = await dataService.uploadEInvoice(file);
            if (uploadRes.success) {
                await dataService.attachEInvoice(uploadingOrderId, uploadRes.filePath);
                alert("Gov. E-Invoice uploaded and attached successfully.");
                await fetchData();
            } else {
                throw new Error(uploadRes.error || "Upload failed");
            }
        } catch (err: any) {
            alert("Upload failed: " + err.message);
        } finally {
            setProcessingId(null);
            setUploadingOrderId(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

    const toggleExpand = (id: string, e: React.MouseEvent) => {
        // Prevent expanding if clicking on buttons.
        if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('a')) {
            return;
        }
        setExpandedOrderId(prev => prev === id ? null : id);
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Gov. E-Invoice Portfolio</h2>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Manage and fulfill official government electronic invoicing requests</p>
                </div>
            </div>

            <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden min-h-[60vh]">
                <table className="w-full text-left">
                    <thead className="bg-slate-900 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-white/5">
                        <tr>
                            <th className="px-8 py-5 text-white">Order Details</th>
                            <th className="px-8 py-5 text-white">Customer</th>
                            <th className="px-8 py-5 text-white">Status</th>
                            <th className="px-8 py-5 text-white text-right">E-Invoice Action</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {orders.map(order => {
                            const grossRevenue = order.items.reduce((s, it) => s + (it.quantity * it.pricePerUnit * (1 + (it.taxPercent || 0) / 100)), 0);
                            const totalPaid = (order.payments || []).reduce((s, p) => s + p.amount, 0);
                            const outstanding = Math.max(0, grossRevenue - totalPaid);
                            const components = order.items.flatMap(it => it.components || []).filter(c => c.source === 'PROCUREMENT' || c.poNumber);

                            const totalComponentCost = components.reduce((s, c) => s + (c.quantity * (c.unitCost || 0) * (1 + (c.taxPercent || 0) / 100)), 0);
                            const poPriceExcludingTaxes = order.items.reduce((s, it) => s + (it.quantity * it.pricePerUnit), 0);
                            const netProfit = poPriceExcludingTaxes - totalComponentCost;

                            return (
                                <React.Fragment key={order.id}>
                                    <tr className="hover:bg-slate-50/80 transition-colors cursor-pointer" onClick={(e) => toggleExpand(order.id, e)}>
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <i className={`fa-solid fa-chevron-${expandedOrderId === order.id ? 'down' : 'right'} text-slate-400 text-xs transition-transform w-4 text-center`}></i>
                                                <div>
                                                    <div className="font-mono text-[10px] font-black text-blue-600 uppercase">{order.internalOrderNumber}</div>
                                                    <div className="text-[9px] text-slate-400 font-bold uppercase mt-1">PO: {order.customerReferenceNumber}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6 font-black text-slate-800 text-sm tracking-tight">
                                            {order.customerName}
                                        </td>
                                        <td className="px-8 py-6">
                                            {order.einvoiceFile ? (
                                                <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center gap-1 w-fit">
                                                    <i className="fa-solid fa-circle-check"></i> Fulfilled
                                                </span>
                                            ) : (
                                                <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase bg-amber-50 text-amber-600 border border-amber-100 flex items-center gap-1 w-fit animate-pulse">
                                                    <i className="fa-solid fa-clock"></i> Pending Upload
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <div className="flex justify-end gap-2">
                                                {order.einvoiceFile ? (
                                                    <a
                                                        href={`/${order.einvoiceFile}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-[9px] font-black uppercase hover:bg-blue-100 transition-all border border-blue-200 flex items-center gap-2"
                                                    >
                                                        <i className="fa-solid fa-file-pdf"></i> View Invoice
                                                    </a>
                                                ) : (
                                                    <button
                                                        disabled={processingId === order.id}
                                                        onClick={(e) => { e.stopPropagation(); setUploadingOrderId(order.id); setTimeout(() => fileInputRef.current?.click(), 100); }}
                                                        className="px-4 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase hover:bg-black transition-all flex items-center gap-2"
                                                    >
                                                        {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-upload"></i>}
                                                        Upload E-Invoice
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                    {expandedOrderId === order.id && (
                                        <tr className="bg-slate-50/50 border-b-2 border-slate-100">
                                            <td colSpan={4} className="px-8 py-6">
                                                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-8 animate-in slide-in-from-top-2 duration-300">
                                                    {/* Financial Overview */}
                                                    <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
                                                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                                                            <div className="text-[10px] font-black text-slate-400 uppercase mb-1">Total Order Value (Gross)</div>
                                                            <div className="text-lg font-black text-slate-800">{grossRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                        </div>
                                                        <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-100">
                                                            <div className="text-[10px] font-black text-emerald-600 uppercase mb-1">Total Paid Value</div>
                                                            <div className="text-lg font-black text-emerald-700">{totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                        </div>
                                                        <div className={`p-4 rounded-xl border ${outstanding > 0 ? 'bg-amber-50 border-amber-100' : 'bg-slate-50 border-slate-100'}`}>
                                                            <div className={`text-[10px] font-black uppercase mb-1 ${outstanding > 0 ? 'text-amber-600' : 'text-slate-400'}`}>Left Value (Balance)</div>
                                                            <div className={`text-lg font-black ${outstanding > 0 ? 'text-amber-700' : 'text-slate-800'}`}>{outstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                        </div>
                                                        <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                                                            <div className="text-[10px] font-black text-blue-600 uppercase mb-1">Total Cost of Manufacture</div>
                                                            <div className="text-lg font-black text-blue-800">{totalComponentCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                        </div>
                                                        <div className={`p-4 rounded-xl border ${netProfit > 0 ? 'bg-indigo-50 border-indigo-100' : 'bg-rose-50 border-rose-100'}`}>
                                                            <div className={`text-[10px] font-black uppercase mb-1 ${netProfit > 0 ? 'text-indigo-600' : 'text-rose-600'}`}>Net Profit</div>
                                                            <div className={`text-lg font-black ${netProfit > 0 ? 'text-indigo-700' : 'text-rose-700'}`}>{netProfit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                                                        {/* Payments Section */}
                                                        <div>
                                                            <h4 className="text-[10px] font-black uppercase text-slate-400 mb-3 flex items-center gap-2"><i className="fa-solid fa-money-bill-wave"></i> Partial Payments History</h4>
                                                            {order.payments && order.payments.length > 0 ? (
                                                                <div className="space-y-2">
                                                                    {order.payments.map((p, idx) => (
                                                                        <div key={idx} className="flex justify-between items-center bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                                                                            <div>
                                                                                <div className="text-sm font-black text-emerald-700">{p.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                                                <div className="text-[10px] font-bold text-slate-500 mt-0.5">{new Date(p.date).toLocaleDateString()}</div>
                                                                            </div>
                                                                            <div className="text-[9px] font-black text-slate-500 uppercase">{p.receiptNumber}</div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            ) : (
                                                                <div className="text-[10px] font-bold text-slate-400 italic bg-white p-3 rounded-xl border border-slate-100">No payment records found.</div>
                                                            )}
                                                        </div>

                                                        {/* Delivery Notes Section */}
                                                        <div>
                                                            <h4 className="text-[10px] font-black uppercase text-slate-400 mb-3 flex items-center gap-2"><i className="fa-solid fa-truck"></i> Delivery Notes (PODs)</h4>
                                                            {order.deliveries && order.deliveries.length > 0 ? (
                                                                <div className="space-y-2">
                                                                    {order.deliveries.map(d => (
                                                                        <div key={d.id} className="flex justify-between items-center bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                                                                            <div>
                                                                                <div className="text-xs font-bold text-slate-800">{new Date(d.date).toLocaleDateString()}</div>
                                                                                <div className="text-[9px] font-bold text-slate-500 mt-0.5">{d.items.reduce((s, i) => s + i.qty, 0)} items delivered</div>
                                                                            </div>
                                                                            {d.podFilePath ? (
                                                                                <a href={`/${d.podFilePath}`} target="_blank" rel="noreferrer" className="text-[9px] font-black text-blue-600 uppercase px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 transition-colors">
                                                                                    <i className="fa-solid fa-file-pdf mr-1"></i> View POD
                                                                                </a>
                                                                            ) : (
                                                                                <span className="text-[9px] font-bold text-slate-400">No POD Uploaded</span>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            ) : (
                                                                <div className="text-[10px] font-bold text-slate-400 italic bg-white p-3 rounded-xl border border-slate-100">No partial deliveries recorded.</div>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Components List */}
                                                    <div>
                                                        <h4 className="text-[10px] font-black uppercase text-slate-400 mb-3 flex items-center gap-2"><i className="fa-solid fa-microchip"></i> Supplier Component Purchase Values</h4>
                                                        {components.length > 0 ? (
                                                            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-100">
                                                                <div className="bg-slate-50 px-4 py-2 grid grid-cols-12 gap-4 text-[9px] font-black text-slate-400 uppercase tracking-widest">
                                                                    <div className="col-span-5">Component</div>
                                                                    <div className="col-span-2">Supplier PO</div>
                                                                    <div className="col-span-2 text-center">Qty</div>
                                                                    <div className="col-span-3 text-right">Purchase Value (Inc. Tax)</div>
                                                                </div>
                                                                {components.map((c, idx) => {
                                                                    const purchaseValue = c.quantity * (c.unitCost || 0) * (1 + (c.taxPercent || 0) / 100);
                                                                    return (
                                                                        <div key={idx} className="px-4 py-3 grid grid-cols-12 gap-4 items-center text-xs">
                                                                            <div className="col-span-5 font-bold text-slate-800">{c.description}</div>
                                                                            <div className="col-span-2 font-mono text-[10px] font-black text-blue-600 uppercase">{c.poNumber || 'N/A'}</div>
                                                                            <div className="col-span-2 text-center font-bold text-slate-500">{c.quantity} {c.unit}</div>
                                                                            <div className="col-span-3 text-right font-black text-amber-700">{purchaseValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L.E.</div>
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        ) : (
                                                            <div className="text-[10px] font-bold text-slate-400 italic bg-white p-3 rounded-xl border border-slate-100">No supplier components linked to this order.</div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
                {orders.length === 0 && !loading && (
                    <div className="p-20 text-center flex flex-col items-center gap-3 text-slate-300 italic uppercase font-black tracking-widest text-xs">
                        <i className="fa-solid fa-file-invoice-dollar text-5xl opacity-10 mb-4"></i>
                        No pending E-Invoice requests
                    </div>
                )}
            </div>

            <div className="p-6 bg-blue-50 rounded-2xl border border-blue-100 flex gap-4">
                <i className="fa-solid fa-circle-info text-blue-500 mt-0.5"></i>
                <div className="space-y-1">
                    <h4 className="text-[10px] font-black text-blue-900 uppercase">Government Compliance Notice</h4>
                    <p className="text-xs text-blue-800 font-medium">Items listed here have been officially flagged by the Finance department for electronic invoicing. Uploads are strictly recorded and associated with the customer's tax profile.</p>
                </div>
            </div>

            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={handleFileUpload}
            />
        </div>
    );
};
