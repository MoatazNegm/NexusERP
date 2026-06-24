
import React, { useState, useEffect, useRef } from 'react';
import { dataService } from '../services/dataService';
import { Supplier, SupplierPart, LogEntry, User, UserRole, AppConfig } from '../types';
import * as XLSX from 'xlsx';
import { GoogleGenAI } from '@google/genai';

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
  userRoles: UserRole[];
  refreshKey?: number;
  config: AppConfig;
}

export const SupplierModule: React.FC<SupplierModuleProps> = ({ currentUser, userRoles, refreshKey, config }) => {
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
  const [priceListUploadMessage, setPriceListUploadMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const [newPart, setNewPart] = useState({ partNumber: '', description: '', price: 0, currency: 'L.E.' });
  const priceListFileInputRef = useRef<HTMLInputElement>(null);

  const canEdit = userRoles.includes('admin') || userRoles.includes('procurement') || userRoles.includes('suppliers');

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
      await dataService.updateSupplier(editingSupplier.id, suppForm);
    } else {
      await dataService.addSupplier(suppForm);
    }

    await loadSuppliers();
    resetForm();
  };

  const handleAddPart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSupplier || !newPart.description || !canEdit) return;
    await dataService.addPartToSupplier(editingSupplier.id, newPart);
    await loadSuppliers();
    setNewPart({ partNumber: '', description: '', price: 0, currency: 'L.E.' });
  };

  const handleRemovePart = async (partId: string) => {
    if (!editingSupplier || !canEdit) return;
    if (confirm("Remove this item from the supplier's price list?")) {
      await dataService.removePartFromSupplier(editingSupplier.id, partId);
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

  const downloadPriceListTemplate = () => {
    if (!editingSupplier) return;

    const worksheet = XLSX.utils.aoa_to_sheet([['Item Description', 'Part Number', 'Unit Price']]);
    worksheet['!cols'] = [{ wch: 24 }, { wch: 50 }, { wch: 18 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'PriceListTemplate');

    const safeSupplierName = (editingSupplier.name || 'supplier').replace(/[^a-zA-Z0-9_-]/g, '_');
    XLSX.writeFile(workbook, `${safeSupplierName}_price_list_template.xlsx`);
    setPriceListUploadMessage({ type: 'info', text: 'Template downloaded. Fill all required columns, then use Bulk Upload.' });
  };

  const parsePrice = (raw: unknown): number | null => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const normalized = raw.replace(/,/g, '').replace(/[^0-9.-]/g, '').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const normalizeHeader = (value: string): string => {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
  };

  const resolveColumnKey = (availableKeys: string[], aliases: string[]): string | null => {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    return availableKeys.find((key) => aliasSet.has(normalizeHeader(key))) || null;
  };

  const findExistingHeader = (availableKeys: string[], candidate: unknown): string | null => {
    if (!candidate || typeof candidate !== 'string') return null;
    const normalizedCandidate = normalizeHeader(candidate);
    return availableKeys.find((key) => normalizeHeader(key) === normalizedCandidate) || null;
  };

  const inferColumnMappingWithAI = async (
    availableKeys: string[],
    rows: Record<string, unknown>[]
  ): Promise<{ partNumberKey: string; descriptionKey: string; unitPriceKey: string } | null> => {
    const sampleRows = rows.slice(0, 5).map((row) => {
      const sample: Record<string, string> = {};
      availableKeys.forEach((key) => {
        sample[key] = String(row[key] ?? '').slice(0, 120);
      });
      return sample;
    });

    const prompt = `
You are mapping spreadsheet headers for a supplier price list import.
Required target fields are:
1) partNumber
2) description
3) unitPrice

Given headers and sample rows, choose exactly one existing header for each target field.
Use only headers that exist in the provided headers list.
Return JSON ONLY in this format:
{
  "partNumberHeader": "...",
  "descriptionHeader": "...",
  "unitPriceHeader": "..."
}

Headers: ${JSON.stringify(availableKeys)}
Sample rows: ${JSON.stringify(sampleRows)}
    `.trim();

    let textOutput = '{}';

    if (config.settings.aiProvider === 'gemini') {
      const apiKey = config.settings.geminiConfig?.apiKey;
      const modelName = config.settings.geminiConfig?.modelName || 'gemini-1.5-flash';
      if (!apiKey) throw new Error('Gemini API key is not configured.');

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      });
      textOutput = response.text || '{}';
    } else {
      const { apiKey, baseUrl, modelName } = config.settings.openaiConfig;
      if (!apiKey) throw new Error('OpenAI API key is not configured.');

      const upstreamEndpoint = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}chat/completions`;
      const response = await fetch('/api/v1/ai-proxy/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: upstreamEndpoint,
          apiKey,
          payload: {
            model: modelName,
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }],
            temperature: 0
          }
        })
      });

      const data = await response.json();
      textOutput = data.choices?.[0]?.message?.content || '{}';
    }

    const parsed = JSON.parse(textOutput);
    const partNumberKey = findExistingHeader(availableKeys, parsed.partNumberHeader);
    const descriptionKey = findExistingHeader(availableKeys, parsed.descriptionHeader);
    const unitPriceKey = findExistingHeader(availableKeys, parsed.unitPriceHeader);

    if (!partNumberKey || !descriptionKey || !unitPriceKey) return null;

    const uniqueKeys = new Set([partNumberKey, descriptionKey, unitPriceKey]);
    if (uniqueKeys.size < 3) return null;

    return { partNumberKey, descriptionKey, unitPriceKey };
  };

  const handleBulkPriceListUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingSupplier || !canEdit) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];

      if (!firstSheetName) {
        setPriceListUploadMessage({ type: 'error', text: 'Upload failed: workbook has no sheets.' });
        return;
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

      if (!rows.length) {
        setPriceListUploadMessage({ type: 'error', text: 'Upload failed: sheet is empty.' });
        return;
      }

      const availableKeys = Object.keys(rows[0] || {});
      let partNumberKey = resolveColumnKey(availableKeys, [
        'Part Number', 'Part No', 'Part #', 'PartNum', 'Part ID', 'SKU', 'Item Code', 'Product Code', 'Model Number'
      ]);
      let descriptionKey = resolveColumnKey(availableKeys, [
        'Item Description', 'Description', 'Item Name', 'Part Description', 'Product Description', 'Material Description', 'Name'
      ]);
      let unitPriceKey = resolveColumnKey(availableKeys, [
        'Unit Price', 'Price', 'Unit Cost', 'Cost', 'Rate', 'Unit Rate', 'Amount', 'Selling Price'
      ]);

      let usedAiFallback = false;
      if (!partNumberKey || !descriptionKey || !unitPriceKey) {
        try {
          const aiMapping = await inferColumnMappingWithAI(availableKeys, rows);
          if (aiMapping) {
            partNumberKey = partNumberKey || aiMapping.partNumberKey;
            descriptionKey = descriptionKey || aiMapping.descriptionKey;
            unitPriceKey = unitPriceKey || aiMapping.unitPriceKey;
            usedAiFallback = true;
          }
        } catch (error: any) {
          setPriceListUploadMessage({ type: 'error', text: `Upload failed. Automatic mapping failed: ${error?.message || 'AI mapping error'}` });
          return;
        }
      }

      if (!partNumberKey || !descriptionKey || !unitPriceKey) {
        setPriceListUploadMessage({
          type: 'error',
          text: `Upload failed. Could not detect required columns. Detected headers: ${availableKeys.join(', ') || 'none'}. Required fields: part number, item description, unit price.`
        });
        return;
      }

      const mappedParts: Omit<SupplierPart, 'id'>[] = [];
      const invalidRows: string[] = [];

      rows.forEach((row, index) => {
        const rowNumber = index + 2;
        const partNumber = String(row[partNumberKey] ?? '').trim();
        const description = String(row[descriptionKey] ?? '').trim();
        const priceRaw = row[unitPriceKey];
        const price = parsePrice(priceRaw);

        if (!partNumber || !description || price === null) {
          invalidRows.push(`Row ${rowNumber}`);
          return;
        }

        mappedParts.push({
          partNumber,
          description,
          price,
          currency: 'L.E.'
        });
      });

      if (invalidRows.length > 0) {
        setPriceListUploadMessage({
          type: 'error',
          text: `Upload failed. Invalid or missing fields in: ${invalidRows.join(', ')}. Required fields are part number, item description, and unit price.`
        });
        return;
      }

      const existingPriceList = editingSupplier.priceList || [];
      const existingMap = new Map(existingPriceList.map(part => [part.partNumber.trim().toLowerCase(), part]));

      const mergedPriceList: SupplierPart[] = mappedParts.map((part, idx) => {
        const existing = existingMap.get(part.partNumber.trim().toLowerCase());
        return {
          id: existing?.id || `spl_${Date.now()}_${idx}`,
          partNumber: part.partNumber,
          description: part.description,
          price: part.price,
          currency: existing?.currency || 'L.E.'
        };
      });

      await dataService.updateSupplier(editingSupplier.id!, {
        ...editingSupplier,
        priceList: mergedPriceList
      });

      await loadSuppliers();
      setPriceListUploadMessage({
        type: 'success',
        text: `Bulk upload successful. ${mergedPriceList.length} price list rows saved.${usedAiFallback ? ' Mapping inferred using AI.' : ''}`
      });
    } catch (error) {
      setPriceListUploadMessage({ type: 'error', text: 'Bulk upload failed. Please use a valid Excel file (.xlsx).' });
    } finally {
      if (priceListFileInputRef.current) {
        priceListFileInputRef.current.value = '';
      }
    }
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
                        <input required disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.name} onChange={e => setSuppForm({ ...suppForm, name: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Sales Email</label>
                        <input type="email" disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.email} onChange={e => setSuppForm({ ...suppForm, email: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Switchboard / Phone</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.phone} onChange={e => setSuppForm({ ...suppForm, phone: e.target.value })} />
                      </div>
                      <div className="md:col-span-2 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Office Address</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.address} onChange={e => setSuppForm({ ...suppForm, address: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Google Maps Location</label>
                        <div className="flex gap-2">
                          <input disabled={!canEdit} className="flex-1 px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none text-xs disabled:bg-slate-50 disabled:text-slate-500" placeholder="https://google.com/maps/..." value={suppForm.location} onChange={e => setSuppForm({ ...suppForm, location: e.target.value })} />
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
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactName} onChange={e => setSuppForm({ ...suppForm, contactName: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Email</label>
                        <input type="email" disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactEmail} onChange={e => setSuppForm({ ...suppForm, contactEmail: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Contact Mobile</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactPhone} onChange={e => setSuppForm({ ...suppForm, contactPhone: e.target.value })} />
                      </div>
                      <div className="md:col-span-3 space-y-1">
                        <label className="text-xs font-bold text-slate-500 uppercase">Personal Contact Address (If different)</label>
                        <input disabled={!canEdit} className="w-full px-3 py-2 border rounded-lg bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none disabled:bg-slate-50 disabled:text-slate-500" value={suppForm.contactAddress} onChange={e => setSuppForm({ ...suppForm, contactAddress: e.target.value })} />
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
                  <div className="flex flex-wrap items-center gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                    <button
                      type="button"
                      onClick={downloadPriceListTemplate}
                      className="px-4 py-2 bg-emerald-600 text-white text-xs font-black uppercase tracking-wider rounded-lg hover:bg-emerald-700 transition-colors flex items-center gap-2"
                    >
                      <i className="fa-solid fa-file-excel"></i>
                      Download Template
                    </button>
                    <button
                      type="button"
                      onClick={() => priceListFileInputRef.current?.click()}
                      className="px-4 py-2 bg-indigo-600 text-white text-xs font-black uppercase tracking-wider rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-2"
                    >
                      <i className="fa-solid fa-upload"></i>
                      Bulk Upload
                    </button>
                    <input
                      ref={priceListFileInputRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={handleBulkPriceListUpload}
                    />
                  </div>
                )}

                {priceListUploadMessage && (
                  <div className={`p-3 rounded-lg border text-xs font-bold uppercase tracking-wide ${priceListUploadMessage.type === 'success'
                    ? 'bg-emerald-50 border-emerald-100 text-emerald-700'
                    : priceListUploadMessage.type === 'info'
                      ? 'bg-blue-50 border-blue-100 text-blue-700'
                      : 'bg-rose-50 border-rose-100 text-rose-700'
                    }`}>
                    {priceListUploadMessage.text}
                  </div>
                )}

                {canEdit && (
                  <form onSubmit={handleAddPart} className="grid grid-cols-1 md:grid-cols-4 gap-4 p-6 bg-slate-50 rounded-xl border border-slate-200">
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-slate-400 uppercase">Part Number</label>
                      <input required className="w-full px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. PN-1234" value={newPart.partNumber} onChange={e => setNewPart({ ...newPart, partNumber: e.target.value })} />
                    </div>
                    <div className="md:col-span-2 space-y-1">
                      <label className="text-[9px] font-black text-slate-400 uppercase">Item Description</label>
                      <input required className="w-full px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. Industrial Valve M-series" value={newPart.description} onChange={e => setNewPart({ ...newPart, description: e.target.value })} />
                    </div>
                    <div className="space-y-1 flex flex-col justify-end">
                      <label className="text-[9px] font-black text-slate-400 uppercase">Unit Price (L.E.)</label>
                      <div className="flex gap-2">
                        <input type="number" step="any" required className="flex-1 px-3 py-2 border rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" placeholder="0.00" value={newPart.price} onChange={e => setNewPart({ ...newPart, price: parseFloat(e.target.value) })} />
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
