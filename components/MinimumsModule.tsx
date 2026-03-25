
import React, { useState, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { Customer, User } from '../types';

interface MinimumsModuleProps {
  currentUser: User;
  refreshKey?: number;
}

export const MinimumsModule: React.FC<MinimumsModuleProps> = ({ currentUser, refreshKey }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editMargins, setEditMargins] = useState<Record<string, string>>({});

  const loadCustomers = async (isManual = false) => {
    if (isManual) setLoading(true);
    try {
      const data = await dataService.getCustomers();
      // Sort customers by name
      const sorted = [...data].sort((a, b) => a.name.localeCompare(b.name));
      setCustomers(sorted);
      
      // We don't initialize editMargins here anymore to prevent overwriting user input.
      // editMargins will only hold pending changes.
    } catch (error) {
      console.error("Failed to load customers:", error);
    } finally {
      if (isManual) setLoading(false);
    }
  };

  useEffect(() => {
    // Initial load
    loadCustomers(true);
  }, []); // Only once on mount

  useEffect(() => {
    // Background sync updates the data list but won't touch editMargins
    if (refreshKey !== undefined && refreshKey > 0) {
      loadCustomers(false);
    }
  }, [refreshKey]);

  const handleMarginChange = (customerId: string, value: string) => {
    setEditMargins(prev => ({ ...prev, [customerId]: value }));
  };

  const handleSave = async (customer: Customer) => {
    const customerId = customer.id || '';
    const newValue = editMargins[customerId];
    
    // If no new value was entered, we do nothing or could treat it as "reset to global"
    // However, the user request implies they want to confirm a change.
    if (newValue === undefined) return;

    const marginPct = newValue === '' ? undefined : parseFloat(newValue);

    if (marginPct !== undefined && (isNaN(marginPct) || marginPct < -100 || marginPct > 1000)) {
      alert("Please enter a valid percentage.");
      return;
    }

    setSavingId(customerId);
    try {
      await dataService.updateCustomer(customerId, {
        ...customer,
        minimumMarginPct: marginPct
      });
      // Clear the edit state for this customer upon success
      setEditMargins(prev => {
        const next = { ...prev };
        delete next[customerId];
        return next;
      });
      await loadCustomers(false);
    } catch (error) {
      console.error("Failed to update customer:", error);
      alert("Update failed. Please try again.");
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="p-12 text-center text-slate-400 flex flex-col items-center gap-4">
        <i className="fa-solid fa-spinner fa-spin text-2xl text-blue-500"></i>
        Loading authorized thresholds...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Customer Minimums</h2>
          <p className="text-sm text-slate-500 font-medium">Define customer-specific margin thresholds that override global settings.</p>
        </div>
        <div className="px-4 py-2 bg-slate-100 rounded-xl border border-slate-200 text-[10px] font-black uppercase text-slate-400 tracking-widest">
          Manager Authorization Active
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-200 overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50/50 border-b border-slate-100">
              <th className="px-8 py-5 text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Customer Entity</th>
              <th className="px-8 py-5 text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Authorized</th>
              <th className="px-8 py-5 text-[10px] font-black uppercase text-slate-400 tracking-[0.2em]">Update Threshold</th>
              <th className="px-8 py-5 text-[10px] font-black uppercase text-slate-400 tracking-[0.2em] w-48 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {customers.map(cust => {
              const custId = cust.id || '';
              const isSaving = savingId === custId;
              const hasGlobalFallback = cust.minimumMarginPct === undefined || cust.minimumMarginPct === null;
              const pendingValue = editMargins[custId];
              const isModified = pendingValue !== undefined;

              return (
                <tr key={custId} className="hover:bg-slate-50/30 transition-colors group">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 font-black text-sm border border-blue-100 shadow-sm group-hover:scale-110 transition-transform">
                        {cust.name.slice(0, 1)}
                      </div>
                      <div>
                        <div className="font-black text-slate-800 uppercase tracking-tight text-sm">{cust.name}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{cust.email || 'No registry email'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    {hasGlobalFallback ? (
                      <div className="flex flex-col">
                        <span className="text-xs font-black text-slate-400 italic">GLOBAL DEFAULT</span>
                        <span className="text-[10px] text-slate-300 font-bold uppercase">System Auth</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-black text-slate-800 tracking-tighter">
                          {cust.minimumMarginPct}%
                        </span>
                        <span className="text-[9px] font-black text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-100 uppercase tracking-widest">Active</span>
                      </div>
                    )}
                  </td>
                  <td className="px-8 py-6">
                    <div className="relative max-w-[140px]">
                      <input
                        type="number"
                        step="0.1"
                        placeholder="New % value"
                        className={`w-full bg-slate-50 border-2 rounded-xl px-4 py-2 font-black text-sm outline-none transition-all ${
                          isModified 
                          ? 'border-blue-500 bg-white text-blue-700' 
                          : 'border-slate-100 text-slate-400'
                        }`}
                        value={pendingValue || ''}
                        onChange={(e) => handleMarginChange(custId, e.target.value)}
                      />
                      <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-black ${isModified ? 'text-blue-300' : 'text-slate-300'}`}>%</span>
                    </div>
                  </td>
                  <td className="px-8 py-6 text-right">
                    <button
                      onClick={() => handleSave(cust)}
                      disabled={isSaving || !isModified}
                      className={`px-6 py-2 rounded-xl font-black text-[10px] uppercase tracking-[0.15em] transition-all shadow-lg active:scale-95 ${
                        isSaving || !isModified
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none' 
                        : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-200'
                      }`}
                    >
                      {isSaving ? (
                        <>
                          <i className="fa-solid fa-spinner fa-spin mr-2"></i>
                          Syncing
                        </>
                      ) : (
                        <>
                          <i className="fa-solid fa-cloud-arrow-up mr-2"></i>
                          Commit
                        </>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {customers.length === 0 && (
          <div className="p-20 text-center space-y-4">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-200 border-2 border-dashed border-slate-200">
              <i className="fa-solid fa-users-slash text-2xl"></i>
            </div>
            <p className="text-sm font-bold text-slate-400">No customers found in the registry.</p>
          </div>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-3xl p-8 flex gap-6 items-start">
        <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center text-amber-600 shadow-sm shrink-0 border border-amber-200">
          <i className="fa-solid fa-triangle-exclamation"></i>
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-black text-amber-800 uppercase tracking-tight">SOP Compliance Warning</h4>
          <p className="text-amber-700 text-xs font-medium leading-relaxed max-w-2xl">
            Modifying customer-specific thresholds overrides the global SOP. The system will automatically block any PO that falls below the custom percentage defined here. Leaving the field blank will revert the customer to the global minimum margin defined in System Settings.
          </p>
        </div>
      </div>
    </div>
  );
};
