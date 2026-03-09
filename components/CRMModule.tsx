
import React, { useState, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { Customer, LogEntry, User } from '../types';

const LogTimeline: React.FC<{ logs: LogEntry[] }> = ({ logs }) => (
  <div className="space-y-4 relative pl-4 border-l-2 border-slate-100 py-2">
    {logs.slice().reverse().map((log, i) => (
      <div key={i} className="relative">
        <div className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-blue-500 border-2 border-white shadow-sm"></div>
        <div className="text-[11px] font-bold text-slate-800 flex items-center gap-2">
          {log.message}
          {log.user && (
            <span className="text-[9px] font-medium text-slate-400 border border-slate-200 px-1.5 py-0.5 rounded bg-slate-50 uppercase tracking-tighter flex items-center gap-1">
              <i className="fa-solid fa-user text-[7px] opacity-60"></i> {log.user}
            </span>
          )}
        </div>
        <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1.5">
          <i className="fa-solid fa-clock opacity-50"></i>
          {new Date(log.timestamp).toLocaleString()}
        </div>
      </div>
    ))}
    {logs.length === 0 && <div className="text-[11px] text-slate-400 italic p-4 text-center">No audit history found for this record.</div>}
  </div>
);

type CRMTab = 'form' | 'history' | 'duplicates';

interface DuplicateGroup {
  primaryId: string;
  customers: Customer[];
}

interface CRMModuleProps {
  refreshKey?: number;
  currentUser: User;
}

export const CRMModule: React.FC<CRMModuleProps> = ({ refreshKey, currentUser }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [custForm, setCustForm] = useState<Omit<Customer, 'id' | 'logs'>>({
    name: '',
    email: '',
    phone: '',
    address: '',
    location: '',
    contactName: '',
    contactPhone: '',
    contactAddress: '',
    contactEmail: '',
    paymentTermDays: 45,
    appliesWithholdingTax: false
  });

  const [activeTab, setActiveTab] = useState<CRMTab>('form');
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    loadCustomers();
  }, [refreshKey]);

  const loadCustomers = async () => {
    const data = await dataService.getCustomers();
    setCustomers(data);
    findDuplicates(data);
    setLoading(false);

    if (editingCustomer) {
      const updated = data.find(x => x.id === editingCustomer.id);
      if (updated) setEditingCustomer(updated);
    }
  };

  const resetForm = () => {
    setCustForm({
      name: '',
      email: '',
      phone: '',
      address: '',
      location: '',
      contactName: '',
      contactPhone: '',
      contactAddress: '',
      contactEmail: '',
      paymentTermDays: 45,
      appliesWithholdingTax: false
    });
    setEditingCustomer(null);
    setIsFormVisible(false);
    setActiveTab('form');
  };

  const findDuplicates = (allCustomers: Customer[]) => {
    const groups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

    allCustomers.forEach(c1 => {
      if (processed.has(c1.id)) return;
      const cluster = [c1];
      const n1 = normalize(c1.name);

      allCustomers.forEach(c2 => {
        if (c1.id === c2.id || processed.has(c2.id)) return;
        const n2 = normalize(c2.name);

        // Similarity criteria: subset or subset after normalization
        const isSubset = n1.includes(n2) || n2.includes(n1) || c1.name.toLowerCase().includes(c2.name.toLowerCase()) || c2.name.toLowerCase().includes(c1.name.toLowerCase());

        if (isSubset) {
          cluster.push(c2);
        }
      });

      if (cluster.length > 1) {
        cluster.forEach(c => processed.add(c.id));
        groups.push({ primaryId: cluster[0].id, customers: cluster });
      }
    });

    setDuplicateGroups(groups);
  };

  const handleMerge = async (primaryId: string, secondaryIds: string[]) => {
    if (!confirm(`Are you sure you want to merge these customers? All POs and activity will be migrated to the primary record, and duplicate records will be deleted.`)) return;

    setMerging(true);
    try {
      await dataService.mergeCustomers(primaryId, secondaryIds);
      await loadCustomers();
      alert("Customers merged successfully!");
    } catch (e: any) {
      alert("Merge failed: " + e.message);
    } finally {
      setMerging(false);
    }
  };

  const handleEdit = (cust: Customer, defaultTab: CRMTab = 'form') => {
    setCustForm({
      name: cust.name,
      email: cust.email,
      phone: cust.phone,
      address: cust.address,
      location: cust.location || '',
      contactName: cust.contactName || '',
      contactPhone: cust.contactPhone || '',
      contactAddress: cust.contactAddress || '',
      contactEmail: cust.contactEmail || '',
      paymentTermDays: cust.paymentTermDays || 45,
      appliesWithholdingTax: cust.appliesWithholdingTax || false
    });
    setEditingCustomer(cust);
    setActiveTab(defaultTab);
    setIsFormVisible(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custForm.name) return;

    if (editingCustomer) {
      // Fix: Pass currentUser.username as the third argument
      await dataService.updateCustomer(editingCustomer.id, custForm);
    } else {
      // Fix: Pass currentUser.username as the second argument
      await dataService.addCustomer(custForm);
    }

    await loadCustomers();
    resetForm();
  };

  const detectLocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }

    setIsDetectingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        setCustForm({ ...custForm, location: mapsUrl });
        setIsDetectingLocation(false);
      },
      (error) => {
        console.error("Error detecting location:", error);
        alert("Unable to retrieve your location");
        setIsDetectingLocation(false);
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Customer Management</h2>
          <p className="text-sm text-slate-500">View and manage your organization's customer database and contacts.</p>
        </div>
        <button
          onClick={() => {
            if (isFormVisible) resetForm();
            else setIsFormVisible(true);
          }}
          className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-all shadow-lg ${isFormVisible ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-100'}`}
        >
          <i className={`fa-solid ${isFormVisible ? 'fa-xmark' : 'fa-plus'}`}></i>
          {isFormVisible ? 'Cancel' : 'New Customer'}
        </button>
        <button
          onClick={() => {
            setIsFormVisible(true);
            setActiveTab('duplicates');
          }}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-bold flex items-center gap-2 hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-all"
        >
          <i className="fa-solid fa-wand-magic-sparkles"></i>
          Check Duplicates
          {duplicateGroups.length > 0 && (
            <span className="bg-white text-indigo-600 text-[10px] px-1.5 py-0.5 rounded-full">{duplicateGroups.length}</span>
          )}
        </button>
      </div>

      {isFormVisible && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300 overflow-hidden">
          {/* Tabs Navigation */}
          <div className="flex border-b border-slate-100">
            <button
              onClick={() => setActiveTab('form')}
              className={`flex-1 px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'form' ? 'text-blue-600 bg-blue-50/30' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <i className={`fa-solid ${editingCustomer ? 'fa-user-pen' : 'fa-user-plus'}`}></i>
              {editingCustomer ? 'Update Customer Record' : 'Register New Customer'}
              {activeTab === 'form' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-600"></div>}
            </button>
            {editingCustomer && (
              <button
                onClick={() => setActiveTab('history')}
                className={`flex-1 px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'history' ? 'text-indigo-600 bg-indigo-50/30' : 'text-slate-400 hover:text-slate-600'}`}
              >
                <i className="fa-solid fa-clock-rotate-left"></i>
                Update History
                {activeTab === 'history' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-600"></div>}
              </button>
            )}
            <button
              onClick={() => setActiveTab('duplicates')}
              className={`flex-1 px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'duplicates' ? 'text-amber-600 bg-amber-50/30' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <i className="fa-solid fa-clone"></i>
              Duplicate Resolution
              {activeTab === 'duplicates' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-amber-600"></div>}
            </button>
          </div>

          <div className="p-0">
            {activeTab === 'form' ? (
              <form onSubmit={handleSubmit}>
                <div className="p-8 space-y-10 animate-in fade-in duration-300">
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] border-b pb-1 flex items-center gap-2">
                      <i className="fa-solid fa-building"></i>
                      Organization Details
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Company Name *</label>
                        <input required className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.name} onChange={e => setCustForm({ ...custForm, name: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Primary Email</label>
                        <input type="email" className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.email} onChange={e => setCustForm({ ...custForm, email: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Switchboard / Phone</label>
                        <input className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.phone} onChange={e => setCustForm({ ...custForm, phone: e.target.value })} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Headquarters Address</label>
                        <input className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.address} onChange={e => setCustForm({ ...custForm, address: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Payment Term (Days)</label>
                        <input type="number" min="0" className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.paymentTermDays} onChange={e => setCustForm({ ...custForm, paymentTermDays: parseInt(e.target.value) || 0 })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Google Maps Location</label>
                        <div className="flex gap-2">
                          <input className="flex-1 px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none text-xs" placeholder="https://google.com/maps/..." value={custForm.location} onChange={e => setCustForm({ ...custForm, location: e.target.value })} />
                          <button
                            type="button"
                            onClick={detectLocation}
                            disabled={isDetectingLocation}
                            className="px-3 py-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors"
                            title="Detect current location"
                          >
                            {isDetectingLocation ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-location-crosshairs"></i>}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 p-4 bg-indigo-50 rounded-xl border border-indigo-100 flex items-start gap-4">
                      <div className="flex-1">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input
                            type="checkbox"
                            className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500"
                            checked={custForm.appliesWithholdingTax}
                            onChange={e => setCustForm({ ...custForm, appliesWithholdingTax: e.target.checked })}
                          />
                          <span className="text-sm font-bold text-slate-800">Apply 1% Withholding Tax Deduction</span>
                        </label>
                        <p className="text-xs text-slate-500 mt-1 pl-8 font-medium">If checked, this customer pays the PO Total MINUS 1%. The system will consider the PO fulfilled upon receiving the 99% payment plus a tax certificate.</p>
                      </div>
                      <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-indigo-500 shrink-0">
                        <i className="fa-solid fa-file-invoice-dollar"></i>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] border-b pb-1 flex items-center gap-2">
                      <i className="fa-solid fa-user-tie"></i>
                      Point of Contact
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Name</label>
                        <input className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.contactName} onChange={e => setCustForm({ ...custForm, contactName: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Email</label>
                        <input type="email" className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.contactEmail} onChange={e => setCustForm({ ...custForm, contactEmail: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Mobile</label>
                        <input className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.contactPhone} onChange={e => setCustForm({ ...custForm, contactPhone: e.target.value })} />
                      </div>
                      <div className="md:col-span-3 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Personal Contact Address (If different)</label>
                        <input className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none" value={custForm.contactAddress} onChange={e => setCustForm({ ...custForm, contactAddress: e.target.value })} />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-slate-50 border-t border-slate-100 flex gap-4">
                  <button type="submit" className="flex-1 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100">
                    {editingCustomer ? 'Save Changes' : 'Register Customer'}
                  </button>
                  <button type="button" onClick={resetForm} className="px-6 py-3 bg-white text-slate-500 font-bold rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors">
                    Discard
                  </button>
                </div>
              </form>
            ) : activeTab === 'history' ? (
              <div className="p-8 animate-in fade-in slide-in-from-bottom-2 duration-300 min-h-[400px]">
                <div className="flex justify-between items-center mb-6">
                  <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <i className="fa-solid fa-list-check"></i>
                    Full Audit History for {editingCustomer?.name}
                  </h4>
                  <div className="text-[10px] text-slate-400 font-medium italic">Chronological list of all system modifications</div>
                </div>
                {editingCustomer && <LogTimeline logs={editingCustomer.logs} />}
              </div>
            ) : (
              <div className="p-8 animate-in fade-in slide-in-from-bottom-2 duration-300 min-h-[400px]">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                      <i className="fa-solid fa-layer-group"></i>
                      Potential Duplicate Groups Found ({duplicateGroups.length})
                    </h4>
                    <p className="text-[10px] text-slate-500 mt-1 italic">We found records with names that are subsets of each other or very similar.</p>
                  </div>
                </div>

                {duplicateGroups.length === 0 ? (
                  <div className="py-20 text-center space-y-4">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-300 border-2 border-dashed border-slate-200">
                      <i className="fa-solid fa-circle-check text-2xl"></i>
                    </div>
                    <p className="text-sm font-bold text-slate-400">Your customer database looks clean! No obvious duplicates detected.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {duplicateGroups.map((group, gIdx) => (
                      <div key={gIdx} className="border border-amber-100 rounded-xl bg-amber-50/20 overflow-hidden">
                        <div className="bg-amber-50 px-4 py-2 border-b border-amber-100 flex justify-between items-center text-[10px]">
                          <span className="font-bold text-amber-700 uppercase tracking-wider">Duplicate Cluster #{gIdx + 1}</span>
                          <span className="text-amber-600 italic">Select one primary record to merge into</span>
                        </div>
                        <div className="p-4 space-y-4">
                          <div className="bg-white rounded-lg border border-slate-100 overflow-hidden shadow-sm">
                            {group.customers.map(c => (
                              <label key={c.id} className="flex items-center gap-4 p-4 hover:bg-slate-50 border-b border-slate-50 last:border-0 cursor-pointer group">
                                <input
                                  type="radio"
                                  name={`group-${gIdx}`}
                                  checked={group.primaryId === c.id}
                                  onChange={() => {
                                    const newGroups = [...duplicateGroups];
                                    newGroups[gIdx].primaryId = c.id;
                                    setDuplicateGroups(newGroups);
                                  }}
                                  className="w-4 h-4 text-blue-600 focus:ring-blue-500 border-slate-300"
                                />
                                <div className="flex-1">
                                  <div className="text-sm font-bold text-slate-800">{c.name}</div>
                                  <div className="text-[10px] text-slate-500 flex gap-4 mt-1">
                                    <span><i className="fa-solid fa-location-dot"></i> {c.address || 'No Address'}</span>
                                    <span><i className="fa-solid fa-envelope"></i> {c.email || 'No Email'}</span>
                                  </div>
                                </div>
                                {group.primaryId === c.id && (
                                  <span className="text-[9px] font-black uppercase text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">Target Primary</span>
                                )}
                              </label>
                            ))}
                          </div>
                          <div className="flex justify-end pr-2">
                            <button
                              disabled={merging}
                              onClick={() => handleMerge(
                                group.primaryId,
                                group.customers.filter(c => c.id !== group.primaryId).map(c => c.id)
                              )}
                              className="px-6 py-2 bg-blue-600 text-white rounded-lg font-black text-[11px] uppercase tracking-wide hover:bg-blue-700 disabled:opacity-50 shadow-lg shadow-blue-100"
                            >
                              {merging ? <i className="fa-solid fa-spinner fa-spin mr-2"></i> : <i className="fa-solid fa-compress mr-2"></i>}
                              Merge Clones into Primary
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center gap-4">
            <i className="fa-solid fa-spinner fa-spin text-2xl text-blue-500"></i>
            Loading customer database...
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Company & Location</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Terms</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Primary Contact</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {customers.map(cust => (
                <tr key={cust.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-800 flex items-center gap-2">
                      {cust.name}
                      {cust.location && (
                        <a href={cust.location} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="Open Google Maps">
                          <i className="fa-solid fa-location-dot text-[10px]"></i>
                        </a>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{cust.address}</div>
                    <div className="flex gap-4 mt-2">
                      <div className="text-[10px] text-slate-400 flex items-center gap-1.5 font-medium">
                        <i className="fa-solid fa-envelope opacity-60"></i> {cust.email || 'N/A'}
                      </div>
                      <div className="text-[10px] text-slate-400 flex items-center gap-1.5 font-medium">
                        <i className="fa-solid fa-phone opacity-60"></i> {cust.phone || 'N/A'}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-2 items-start">
                      <span className="text-xs font-bold text-slate-600 bg-slate-100 px-2 py-1 rounded">Net {cust.paymentTermDays || 45}</span>
                      {cust.appliesWithholdingTax && (
                        <span className="text-[9px] font-black uppercase text-indigo-700 bg-indigo-100 border border-indigo-200 px-2 py-0.5 rounded flex items-center gap-1">
                          <i className="fa-solid fa-percent text-[7px]"></i> 1% WHT
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {cust.contactName ? (
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-slate-700">{cust.contactName}</div>
                        <div className="text-[10px] text-slate-500 flex items-center gap-3">
                          <span className="flex items-center gap-1"><i className="fa-solid fa-mobile-screen"></i> {cust.contactPhone || 'No Mobile'}</span>
                          <span className="flex items-center gap-1"><i className="fa-solid fa-at"></i> {cust.contactEmail || 'No Email'}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 italic">No contact assigned</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => handleEdit(cust, 'history')}
                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                        title="View Audit History"
                      >
                        <i className="fa-solid fa-clock-rotate-left"></i>
                      </button>
                      <button
                        onClick={() => handleEdit(cust, 'form')}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Edit Profile"
                      >
                        <i className="fa-solid fa-pen-to-square"></i>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};