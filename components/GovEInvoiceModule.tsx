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
                        {orders.map(order => (
                            <tr key={order.id} className="hover:bg-slate-50/80 transition-colors">
                                <td className="px-8 py-6">
                                    <div className="font-mono text-[10px] font-black text-blue-600 uppercase">{order.internalOrderNumber}</div>
                                    <div className="text-[9px] text-slate-400 font-bold uppercase mt-1">Ref: {order.customerReferenceNumber}</div>
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
                                                onClick={() => { setUploadingOrderId(order.id); setTimeout(() => fileInputRef.current?.click(), 100); }}
                                                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase hover:bg-black transition-all flex items-center gap-2"
                                            >
                                                {processingId === order.id ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-upload"></i>}
                                                Upload E-Invoice
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
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
