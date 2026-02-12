
import React, { useState, useEffect } from 'react';
import { dataService } from '../services/dataService';
import { Supplier, SupplierPart, LogEntry, User } from '../types';

const LogTimeline: React.FC<{ logs: LogEntry[] }> = ({ logs }) => (
  <div className="space-y-4 relative pl-4 border-l-2 border-slate-100 py-2">
    {logs.slice().reverse().map((log, i) => (
      <div key={i} className="relative">
        <div className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-blue-500 border-2 border-white shadow-sm"></div>
        <div className="text-[11px] font-bold text-slate-800">{log.message}</div>
        <div className="text-[9px] text-slate-400 mt-0.5 flex items-center gap-1.5">
          <i className="fa-solid fa-clock opacity-50"></i>
          {new Date(log.timestamp).toLocaleString()}
        </div>
      </div>
    ))}
    {logs.length === 0 && <div className="text-[11px] text-slate-400 italic p-4 text-center">No audit history found for this record.</div>}
  </div>
);

type SupplierTab = 'form' | 'pricelist' | 'history';

interface SupplierModuleProps {
  currentUser: User;
  refreshKey?: number;
}

export const SupplierModule: React.FC<SupplierModuleProps> = ({ currentUser, refreshKey }) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppForm, setSuppForm] = useState<Omit<Supplier, 'id' | 'logs' | 'priceList'>>({ 
    name: '', 
    email: '', 
    phone: '', 
    address: '',
    location: '',
    contactName: '',
    contactPhone: '',
    contactAddress: '',
    contactEmail: ''
  });
  
  const [activeTab, setActiveTab] = useState<SupplierTab>('form');
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [isFormVisible, setIsFormVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  
  const [newPart, setNewPart] = useState({ partNumber: '', description: '', price: 0, currency: 'L.E.' });

  const canEdit = currentUser.roles.includes('admin') || currentUser.roles.includes('procurement');

  useEffect(() => {
    loadSuppliers();
  }, [refreshKey]);

  const loadSuppliers = async () => {
    const data = await dataService.getSuppliers();
    setSuppliers(data);
    setLoading(false);
    
    if (editingSupplier) {
      const updated = data.find(x => x.id === editingSupplier.id);
      if (updated) setEditingSupplier(updated);
    }
  };

  const resetForm = () => {
    setSuppForm({ 
      name: '', 
      email: '', 
      phone: '', 
      address: '',
      location: '',
      contactName: '',
      contactPhone: '',
      contactAddress: '',
      contactEmail: ''
    });
    setEditingSupplier(null);
    setIsFormVisible(false);
    setActiveTab('form');
  };

  const handleEdit = (supp: Supplier, defaultTab: SupplierTab = 'form') => {
    // FIX: Replaced 'cust' with 'supp' to match the parameter name and resolve "Cannot find name 'cust'" errors
    setSuppForm({
      name: supp.name,
      email: supp.email,
      phone: supp.phone,
      address: supp.address,
      location: supp.location || '',
      contactName: supp.contactName || '',
      contactPhone: supp.contactPhone || '',
      contactAddress: supp.contactAddress || '',
      contactEmail: supp.contactEmail || ''
    });
    setEditingSupplier(supp);
    setActiveTab(defaultTab);
    setIsFormVisible(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!suppForm.name || !canEdit) return;

    if (editingSupplier) {
      await dataService.updateSupplier(editingSupplier.id, suppForm, currentUser.username);
    } else {
      await dataService.addSupplier(suppForm, currentUser.username);
    }
    
    await loadSuppliers();
    resetForm();
  };

  const handleAddPart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSupplier || !newPart.description || !canEdit) return;
    await dataService.addPartToSupplier(editingSupplier.id, newPart, currentUser.username);
    await loadSuppliers();
    setNewPart({ partNumber: '', description: '', price: 0, currency: 'L.E.' });
  };

  const handleRemovePart = async (partId: string) => {
    if (!editingSupplier || !canEdit) return;
    if (confirm("Remove this item from the supplier's price list?")) {
        await dataService.removePartFromSupplier(editingSupplier.id, partId, currentUser.username);
        await loadSuppliers();
    }
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
        setSuppForm({ ...suppForm, location: mapsUrl });
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
          <h2 className="text-xl font-bold text-slate-800">Supplier Management</h2>
          <p className="text-sm text-slate-500">Maintain records of external suppliers, their contact persons, and price lists.</p>
        </div>
        {canEdit && (
          <button 
            onClick={() => {
              if (isFormVisible) resetForm();
              else setIsFormVisible(true);
            }}
            className={`px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-all shadow-lg ${isFormVisible ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-100'}`}
          >
            <i className={`fa-solid ${isFormVisible ? 'fa-xmark' : 'fa-plus'}`}></i>
            {isFormVisible ? 'Cancel' : 'New Supplier'}
          </button>
        )}
      </div>

      {isFormVisible && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300 overflow-hidden">
          <div className="flex border-b border-slate-100 overflow-x-auto">
            <button 
              onClick={() => setActiveTab('form')}
              className={`flex-1 min-w-[150px] px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'form' ? 'text-blue-600 bg-blue-50/30' : 'text-slate-400 hover:text-slate-600'}`}
            >
              <i className={`fa-solid ${editingSupplier ? 'fa-truck-field' : 'fa-truck-fast'}`}></i>
              {editingSupplier ? 'Update Supplier Record' : 'Register New Supplier'}
              {activeTab === 'form' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-600"></div>}
            </button>
            {editingSupplier && (
              <>
                <button 
                  onClick={() => setActiveTab('pricelist')}
                  className={`flex-1 min-w-[150px] px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'pricelist' ? 'text-amber-600 bg-amber-50/30' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className="fa-solid fa-list-check"></i>
                  Commercial Price List
                  {activeTab === 'pricelist' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-amber-600"></div>}
                </button>
                <button 
                  onClick={() => setActiveTab('history')}
                  className={`flex-1 min-w-[150px] px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all relative ${activeTab === 'history' ? 'text-indigo-600 bg-indigo-50/30' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <i className="fa-solid fa-clock-rotate-left"></i>
                  Update History
                  {activeTab === 'history' && <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-600"></div>}
                </button>
              </>
            )}
          </div>

          <div className="p-0">
            {activeTab === 'form' ? (
              <form onSubmit={handleSubmit}>
                <div className="p-8 space-y-10 animate-in fade-in duration-300">
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] border-b pb-1 flex items-center gap-2">
                      <i className="fa-solid fa-industry"></i>
                      Supplier Details
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Supplier Name *</label>
                        <input required disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.name} onChange={e => setSuppForm({...suppForm, name: e.target.value})} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Sales Email</label>
                        <input type="email" disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.email} onChange={e => setSuppForm({...suppForm, email: e.target.value})} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Switchboard / Phone</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.phone} onChange={e => setSuppForm({...suppForm, phone: e.target.value})} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Office Address</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.address} onChange={e => setSuppForm({...suppForm, address: e.target.value})} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Google Maps Location</label>
                        <div className="flex gap-2">
                          <input disabled={!canEdit} className="flex-1 px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none text-xs disabled:bg-slate-50 disabled:text-slate-500" placeholder="https://google.com/maps/..." value={suppForm.location} onChange={e => setSuppForm({...suppForm, location: e.target.value})} />
                          {canEdit && (
                            <button 
                              type="button" 
                              onClick={detectLocation}
                              disabled={isDetectingLocation}
                              className="px-3 py-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100 transition-colors"
                              title="Detect current location"
                            >
                              {isDetectingLocation ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-location-crosshairs"></i>}
                            </button>
                          )}
                        </div>
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
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactName} onChange={e => setSuppForm({...suppForm, contactName: e.target.value})} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Email</label>
                        <input type="email" disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactEmail} onChange={e => setSuppForm({...suppForm, contactEmail: e.target.value})} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Mobile</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactPhone} onChange={e => setSuppForm({...suppForm, contactPhone: e.target.value})} />
                      </div>
                      <div className="md:col-span-3 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Personal Contact Address (If different)</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactAddress} onChange={e => setSuppForm({...suppForm, contactAddress: e.target.value})} />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-slate-50 border-t border-slate-100 flex gap-4">
                  {canEdit && (
                    <button type="submit" className="flex-1 py-3 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100">
                      {editingSupplier ? 'Save Changes' : 'Register Supplier'}
                    </button>
                  )}
                  <button type="button" onClick={resetForm} className="px-6 py-3 bg-white text-slate-500 font-bold rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors">
                    {canEdit ? 'Discard' : 'Close'}
                  </button>
                </div>
              </form>
            ) : activeTab === 'pricelist' ? (
                <div className="p-8 space-y-8 animate-in fade-in duration-300">
                    <div className="flex justify-between items-center mb-4">
                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                          <i className="fa-solid fa-list-ul"></i>
                          Supplier Price List
                        </h4>
                        <div className="text-[9px] text-slate-400 uppercase font-bold">{editingSupplier?.priceList.length} items defined</div>
                    </div>

                    {canEdit && (
                      <form onSubmit={handleAddPart} className="grid grid-cols-1 md:grid-cols-4 gap-4 p-6 bg-slate-50 rounded-xl border border-slate-200">
                          <div className="space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Part Number</label>
                              <input required className="w-full px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. PN-1234" value={newPart.partNumber} onChange={e => setNewPart({...newPart, partNumber: e.target.value})} />
                          </div>
                          <div className="md:col-span-2 space-y-1">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Item Description</label>
                              <input required className="w-full px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. Industrial Valve M-series" value={newPart.description} onChange={e => setNewPart({...newPart, description: e.target.value})} />
                          </div>
                          <div className="space-y-1 flex flex-col justify-end">
                              <label className="text-[9px] font-black text-slate-400 uppercase">Unit Price (L.E.)</label>
                              <div className="flex gap-2">
                                  <input type="number" step="any" required className="flex-1 px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="0.00" value={newPart.price} onChange={e => setNewPart({...newPart, price: parseFloat(e.target.value)})} />
                                  <button type="submit" className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors shadow-sm">
                                      <i className="fa-solid fa-plus"></i>
                                  </button>
                              </div>
                          </div>
                      </form>
                    )}

                    <div className="overflow-hidden rounded-xl border border-slate-100 shadow-sm bg-white">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-200">
                                <tr>
                                    <th className="px-6 py-4">Part Number</th>
                                    <th className="px-6 py-4">Description</th>
                                    <th className="px-6 py-4 text-right">Price</th>
                                    {canEdit && <th className="px-6 py-4 w-10"></th>}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {editingSupplier?.priceList.map(p => (
                                    <tr key={p.id} className="hover:bg-slate-50/50 transition-colors group">
                                        <td className="px-6 py-4 font-mono text-xs text-blue-600 font-bold">{p.partNumber}</td>
                                        <td className="px-6 py-4 font-bold text-slate-700">{p.description}</td>
                                        <td className="px-6 py-4 text-right font-black text-slate-900">{p.price.toLocaleString()} <span className="text-[10px] text-slate-400 font-normal">{p.currency}</span></td>
                                        {canEdit && (
                                          <td className="px-6 py-4 text-right">
                                              <button onClick={() => handleRemovePart(p.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                                  <i className="fa-solid fa-trash-can"></i>
                                              </button>
                                          </td>
                                        )}
                                    </tr>
                                ))}
                                {(!editingSupplier?.priceList || editingSupplier.priceList.length === 0) && (
                                    <tr>
                                        <td colSpan={canEdit ? 4 : 3} className="px-6 py-16 text-center text-slate-400 italic">No parts added to the price list yet.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
              <div className="p-8 animate-in fade-in slide-in-from-bottom-2 duration-300 min-h-[400px]">
                <div className="flex justify-between items-center mb-6">
                   <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                     <i className="fa-solid fa-list-check"></i>
                     Full Audit History for {editingSupplier?.name}
                   </h4>
                   <div className="text-[10px] text-slate-400 font-medium italic">Chronological list of all system modifications</div>
                </div>
                {editingSupplier && <LogTimeline logs={editingSupplier.logs} />}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center gap-4">
            <i className="fa-solid fa-spinner fa-spin text-2xl text-blue-500"></i>
            Loading supplier records...
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Supplier & Location</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Primary Contact</th>
                <th className="px-6 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suppliers.map(supp => (
                <tr key={supp.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="font-bold text-slate-800 flex items-center gap-2">
                      {supp.name}
                      {supp.location && (
                        <a href={supp.location} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="Open Google Maps">
                          <i className="fa-solid fa-location-dot text-[10px]"></i>
                        </a>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">{supp.address}</div>
                    <div className="flex gap-4 mt-2">
                       <div className="text-[10px] text-slate-400 flex items-center gap-1.5 font-medium">
                         <i className="fa-solid fa-envelope opacity-60"></i> {supp.email || 'N/A'}
                       </div>
                       <div className="text-[10px] text-slate-400 flex items-center gap-1.5 font-medium">
                         <i className="fa-solid fa-phone opacity-60"></i> {supp.phone || 'N/A'}
                       </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {supp.contactName ? (
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-slate-700">{supp.contactName}</div>
                        <div className="text-[10px] text-slate-500 flex items-center gap-3">
                          <span className="flex items-center gap-1"><i className="fa-solid fa-mobile-screen"></i> {supp.contactPhone || 'No Mobile'}</span>
                          <span className="flex items-center gap-1"><i className="fa-solid fa-at"></i> {supp.contactEmail || 'No Email'}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 italic">No contact assigned</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button 
                        onClick={() => handleEdit(supp, 'history')}
                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                        title="View Audit History"
                      >
                        <i className="fa-solid fa-clock-rotate-left"></i>
                      </button>
                      <button 
                        onClick={() => handleEdit(supp, 'pricelist')}
                        className="p-2 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all"
                        title={canEdit ? "Edit Price List" : "View Price List"}
                      >
                        <i className={`fa-solid ${canEdit ? 'fa-list-check' : 'fa-list-ul'}`}></i>
                      </button>
                      <button 
                        onClick={() => handleEdit(supp, 'form')}
                        className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title={canEdit ? "Edit Profile" : "View Details"}
                      >
                        <i className={`fa-solid ${canEdit ? 'fa-pen-to-square' : 'fa-circle-info'}`}></i>
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
