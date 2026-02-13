import React, { useState } from 'react';
import { AppConfig } from '../types';

interface AddCustomerModalProps {
    initialName: string;
    config: AppConfig;
    onSave: (customerData: any) => Promise<void>;
    onClose: () => void;
}

export const AddCustomerModal: React.FC<AddCustomerModalProps> = ({ initialName, config, onSave, onClose }) => {
    const [formData, setFormData] = useState({
        name: initialName,
        email: '',
        phone: '',
        address: '',
        paymentTermDays: config.settings.defaultPaymentSlaDays,
        contactName: '',
        contactPhone: '',
        contactEmail: '',
        contactAddress: ''
    });
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            await onSave(formData);
        } catch (error) {
            console.error("Failed to save customer", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-300">
                <div className="p-6 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center text-white shadow-lg shadow-emerald-100">
                            <i className="fa-solid fa-user-plus text-xl"></i>
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">New Customer Entity</h2>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Quick Registration for PO Logging</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white border border-slate-200 text-slate-400 hover:text-rose-500 hover:border-rose-200 flex items-center justify-center transition-all">
                        <i className="fa-solid fa-xmark"></i>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-8 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-1.5 md:col-span-2">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Legal Entity Name</label>
                            <input
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.name}
                                onChange={e => setFormData({ ...formData, name: e.target.value })}
                                required
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Email Address</label>
                            <input
                                type="email"
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.email}
                                onChange={e => setFormData({ ...formData, email: e.target.value })}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Phone Number</label>
                            <input
                                type="tel"
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.phone}
                                onChange={e => setFormData({ ...formData, phone: e.target.value })}
                            />
                        </div>

                        <div className="space-y-1.5 md:col-span-2">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Billing Address</label>
                            <input
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.address}
                                onChange={e => setFormData({ ...formData, address: e.target.value })}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Payment Terms (Days)</label>
                            <input
                                type="number"
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.paymentTermDays}
                                onChange={e => setFormData({ ...formData, paymentTermDays: parseInt(e.target.value) || 0 })}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-wider ml-1">Primary Contact Name</label>
                            <input
                                className="w-full p-3 border-2 border-slate-100 rounded-xl bg-slate-50 font-bold text-slate-800 focus:bg-white focus:border-emerald-500 outline-none transition-all"
                                value={formData.contactName}
                                onChange={e => setFormData({ ...formData, contactName: e.target.value })}
                            />
                        </div>
                    </div>

                    <div className="pt-4 flex justify-end gap-3 border-t border-slate-50">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-6 py-3 rounded-xl font-bold uppercase text-[10px] text-slate-500 hover:bg-slate-50 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="px-8 py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg shadow-emerald-100 transition-all flex items-center gap-2"
                        >
                            {isSubmitting ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check"></i>}
                            Register Customer
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
