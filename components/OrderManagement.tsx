
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrderItem, OrderStatus, Customer, AppConfig, CustomerOrder, User } from '../types';
import { GoogleGenAI } from "@google/genai";
import { STATUS_CONFIG } from '../constants';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

import { AddCustomerModal } from './AddCustomerModal';

interface OrderManagementProps {
  onGoToCRM?: () => void;
  onNavigateToReview?: (orderId: string, itemId: string) => void;
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

interface ItemWithTaxStatus extends Partial<CustomerOrderItem> {
  taxDetected?: boolean;
}

type ManagementTab = 'new' | 'logged' | 'deliveries';

const DeliveryThresholdMarker: React.FC<{ order: CustomerOrder, config: AppConfig }> = ({ order, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = config.settings.deliveryLimitHrs;
      const lastLog = [...order.logs].reverse().find(l => l.status === OrderStatus.HUB_RELEASED);
      const startTime = lastLog ? new Date(lastLog.timestamp).getTime() : new Date(order.dataEntryTimestamp).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [order.status, config.settings]);

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

export const OrderManagement: React.FC<OrderManagementProps> = ({ config, refreshKey, currentUser }) => {
  const today = new Date().toISOString().split('T')[0];

  const [activeTab, setActiveTab] = useState<ManagementTab>('new');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [existingOrders, setExistingOrders] = useState<CustomerOrder[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerReferenceNumber, setCustomerReferenceNumber] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [paymentSlaDays, setPaymentSlaDays] = useState(config.settings.defaultPaymentSlaDays);
  const [items, setItems] = useState<ItemWithTaxStatus[]>([
    { id: 'temp_1', description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: 14, isAccepted: false, taxDetected: true }
  ]);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info', text: string } | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isNewCustomerCreated, setIsNewCustomerCreated] = useState(false);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delivery Note PDF & POD State
  const deliveryNoteRef = useRef<HTMLDivElement>(null);
  const [printingOrder, setPrintingOrder] = useState<CustomerOrder | null>(null);
  const [confirmingDeliveryId, setConfirmingDeliveryId] = useState<string | null>(null);
  const podUploadRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => { fetchData(); }, [refreshKey]);

  const fetchData = async () => {
    const [c, o] = await Promise.all([dataService.getCustomers(), dataService.getOrders()]);
    setCustomers(c);
    setExistingOrders(o);
  };

  const loggedOrders = useMemo(() => {
    return existingOrders.filter(o => o.status === OrderStatus.LOGGED);
  }, [existingOrders]);

  // Auto-retrieval of existing POs
  const lastAutoLoadedRef = useRef<string | null>(null);

  // Clear tracking ref when starting a fresh acquisition
  useEffect(() => {
    if (!editingOrderId) lastAutoLoadedRef.current = null;
  }, [editingOrderId]);

  useEffect(() => {
    if (!customerReferenceNumber || editingOrderId || isScanning) return;

    const normalizedRef = customerReferenceNumber.trim().toLowerCase();
    const match = existingOrders.find(o =>
      o.customerReferenceNumber?.trim().toLowerCase() === normalizedRef ||
      o.internalOrderNumber?.trim().toLowerCase() === normalizedRef
    );

    if (match && match.id !== lastAutoLoadedRef.current) {
      console.debug(`[OrderManagement] Auto-detected existing PO: ${customerReferenceNumber}`);
      lastAutoLoadedRef.current = match.id;
      loadOrder(match);
      setMessage({ type: 'info', text: 'Existing PO identified. Record retrieved and loaded.' });
    }
  }, [customerReferenceNumber, existingOrders.length, editingOrderId, isScanning]);

  const hasLoggingViolations = useMemo(() => {
    return loggedOrders.some(o => o.loggingComplianceViolation);
  }, [loggedOrders]);

  const hubReleasedOrders = useMemo(() => {
    return existingOrders.filter(o => o.status === OrderStatus.HUB_RELEASED);
  }, [existingOrders]);

  const editStatus = useMemo(() => {
    if (!editingOrderId) return { type: 'new', label: '', isFrozen: false };
    const order = existingOrders.find(o => o.id === editingOrderId);
    if (!order) return { type: 'new', label: '', isFrozen: false };

    const entryTime = new Date(order.dataEntryTimestamp).getTime();
    const now = new Date().getTime();
    const ageHrs = (now - entryTime) / 3600000;
    const limit = config.settings.orderEditTimeLimitHrs;

    if (ageHrs > limit) {
      return { type: 'frozen', label: `LOCKED: This PO exceeded the ${limit}h edit threshold.`, isFrozen: true };
    }
    return { type: 'warning', label: `EDITABLE: Lifecycle window expires in ${Math.max(0, (limit - ageHrs) * 60).toFixed(0)} mins.`, isFrozen: false };
  }, [editingOrderId, existingOrders, config.settings.orderEditTimeLimitHrs]);

  const loadOrder = (match: CustomerOrder) => {
    setCustomerName(match.customerName);
    setCustomerReferenceNumber(match.customerReferenceNumber || match.internalOrderNumber);
    setOrderDate(match.orderDate);
    setPaymentSlaDays(match.paymentSlaDays || config.settings.defaultPaymentSlaDays);
    setItems(match.items.map(it => ({ ...it, taxDetected: true })));
    setEditingOrderId(match.id);
    setActiveTab('new');
    setIsNewCustomerCreated(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const totals = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    items.forEach(item => {
      const base = (Number(item.quantity) || 0) * (Number(item.pricePerUnit) || 0);
      const tax = base * ((Number(item.taxPercent) || 0) / 100);
      subtotal += base;
      taxTotal += tax;
    });
    return { subtotal, taxTotal, total: subtotal + taxTotal };
  }, [items]);

  const handleAIScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isScanning) return;
    setIsScanning(true);
    setIsNewCustomerCreated(false);
    setMessage({ type: 'info', text: 'Vision intelligence mapping PO entities...' });

    try {
      const reader = new FileReader();
      const base64Data = await new Promise<string>((res) => {
        reader.onload = () => res((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const existingCustomerNames = customers.map(c => c.name).slice(0, 50).join(', '); // Passing a sample of known names
      const prompt = `
        Context: The following customers already exist in our database: [${existingCustomerNames}]. 
        If the name on the PO is a logical match (e.g., "Google" vs "Google Inc"), you MUST use the exact name from the database.

        Extract all details from this Purchase Order image. 
        Structure the response as valid JSON with these keys:
        - customer: { name, email, phone, address, contactName }
        - poRef: (The customer's PO number string)
        - paymentSlaDays: (Extract the number of days for payment terms like 'Net 30', '45 days', 'Payment due in 15 days'. Only return the integer)
        - date: (The date on the PO in YYYY-MM-DD format)
        - items: [ { description, quantity, unit, price, taxPercent } ]
        
        Rules: 
        1. Output ONLY the JSON object. 
        2. Default items taxPercent to 14 if tax is detected but the specific rate is not clearly legible (standard VAT).
        3. If "Net 30" is found, paymentSlaDays should be 30.
      `;

      let textOutput = "";

      if (config.settings.aiProvider === 'gemini') {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { mimeType: file.type, data: base64Data } },
              { text: prompt }
            ]
          },
          config: { responseMimeType: "application/json" }
        });
        textOutput = response.text || "{}";
      } else {
        const { apiKey, baseUrl, modelName } = config.settings.openaiConfig;
        const endpoint = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}chat/completions`;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${file.type};base64,${base64Data}`
                    }
                  }
                ]
              }
            ]
          })
        });
        const data = await response.json();
        textOutput = data.choices?.[0]?.message?.content || "{}";
      }

      const extracted = JSON.parse(textOutput);

      if (extracted.customer?.name) {
        const existingCust = customers.find(c => c.name.toLowerCase() === extracted.customer.name.toLowerCase());
        if (!existingCust) {
          const newCust = await dataService.addCustomer({
            name: extracted.customer.name,
            email: extracted.customer.email || '',
            phone: extracted.customer.phone || '',
            address: extracted.customer.address || '',
            paymentTermDays: extracted.paymentSlaDays || config.settings.defaultPaymentSlaDays,
            contactName: extracted.customer.contactName || '',
            contactPhone: extracted.customer.phone || '',
            contactEmail: extracted.customer.email || '',
            contactAddress: extracted.customer.address || ''
          });
          setCustomers(prev => [...prev, newCust]);
          setIsNewCustomerCreated(true);
        }
        setCustomerName(extracted.customer.name);
        if (extracted.paymentSlaDays) {
          setPaymentSlaDays(extracted.paymentSlaDays);
        }
      }

      setCustomerReferenceNumber(extracted.poRef || '');
      if (extracted.date) setOrderDate(extracted.date);

      if (extracted.items) {
        setItems(extracted.items.map((i: any, idx: number) => {
          const hasTax = i.taxPercent !== null && i.taxPercent !== undefined;
          return {
            id: `temp_${Date.now()}_${idx}`,
            description: i.description,
            quantity: i.quantity,
            unit: i.unit || 'pcs',
            pricePerUnit: i.price,
            taxPercent: hasTax ? i.taxPercent : 14, // Default to 14% if tax is implied but not set
            taxDetected: true,
            logs: []
          };
        }));
      }
      setMessage({ type: 'success', text: 'Vision mapping complete.' });
    } catch (err) {
      setMessage({ type: 'error', text: 'Intelligence extraction failed.' });
    }
    setIsScanning(false);
  };

  const resetForm = () => {
    setCustomerName(''); setCustomerReferenceNumber(''); setOrderDate(today);
    setPaymentSlaDays(config.settings.defaultPaymentSlaDays);
    setItems([{ id: 'temp_1', description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: 14, taxDetected: true, logs: [] }]);
    setEditingOrderId(null); setMessage(null); setIsNewCustomerCreated(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editStatus.isFrozen) return;
    try {
      if (editingOrderId) {
        await dataService.updateOrder(editingOrderId, { customerName, customerReferenceNumber, orderDate, paymentSlaDays, items: items as any });
        setMessage({ type: 'success', text: 'Record updated.' });
      } else {
        // Prevent duplicate PO IDs on the frontend side
        const isDuplicate = existingOrders.some(o =>
          o.customerReferenceNumber?.trim().toLowerCase() === customerReferenceNumber.trim().toLowerCase()
        );
        if (isDuplicate) {
          setMessage({ type: 'error', text: `Duplicate PO ID: ${customerReferenceNumber} already exists in the system.` });
          return;
        }

        await dataService.addOrder({
          customerName,
          customerReferenceNumber,
          orderDate,
          paymentSlaDays,
          items: items as any
        });
        setMessage({ type: 'success', text: 'Acquisition committed.' });
      }
      await fetchData();
      resetForm();
    } catch (err) {
      setMessage({ type: 'error', text: 'Transaction failed.' });
    }
  };

  const handleConfirmDelivery = async (orderId: string) => {
    setProcessingId(orderId);
    try {
      await dataService.confirmOrderDelivery(orderId);
      await fetchData();
      setMessage({ type: 'success', text: 'Hand-off successfully logged. Record moved to Delivered.' });
    } catch (e) {
      setMessage({ type: 'error', text: 'Delivery confirmation failed.' });
    } finally {
      setProcessingId(null);
    }
  };

  const handleCustomerBlur = () => {
    if (customerName && !customers.some(c => c.name.toLowerCase() === customerName.toLowerCase())) {
      setShowAddCustomerModal(true);
    }
  };

  const handleSaveNewCustomer = async (data: any) => {
    try {
      const newCust = await dataService.addCustomer(data);
      setCustomers(prev => [...prev, newCust]);
      setCustomerName(newCust.name); // Ensure exact casing match
      setIsNewCustomerCreated(true);
      setShowAddCustomerModal(false);
      setMessage({ type: 'success', text: 'New Customer Entity Registered.' });
    } catch (e) {
      setMessage({ type: 'error', text: 'Failed to register customer.' });
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto pb-12 space-y-6">
      <div className="flex gap-1 p-1 bg-slate-200 rounded-xl w-fit shadow-inner overflow-x-auto">
        <button
          onClick={() => setActiveTab('new')}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 whitespace-nowrap ${activeTab === 'new' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <i className="fa-solid fa-plus"></i> New Acquisition
        </button>
        <button
          onClick={() => setActiveTab('logged')}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all relative flex items-center gap-2 whitespace-nowrap ${activeTab === 'logged'
            ? (hasLoggingViolations ? 'bg-rose-50 text-rose-600 shadow-sm border border-rose-100' : 'bg-white text-blue-600 shadow-sm')
            : (hasLoggingViolations ? 'text-rose-500 hover:text-rose-700 hover:bg-rose-50' : 'text-slate-500 hover:text-slate-800')
            }`}
        >
          <i className={`fa-solid ${hasLoggingViolations ? 'fa-triangle-exclamation animate-pulse' : 'fa-folder-open'}`}></i> Logged Orders
          {loggedOrders.length > 0 && (
            <span className={`w-5 h-5 text-[10px] flex items-center justify-center rounded-full border-2 border-white font-black ${hasLoggingViolations ? 'bg-rose-600 text-white animate-pulse' : 'bg-blue-600 text-white'
              }`}>{loggedOrders.length}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('deliveries')}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all relative flex items-center gap-2 whitespace-nowrap ${activeTab === 'deliveries' ? 'bg-white text-sky-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <i className="fa-solid fa-truck-ramp-box"></i> Deliver to Customer
          {hubReleasedOrders.length > 0 && (
            <span className="w-5 h-5 bg-sky-600 text-white text-[10px] flex items-center justify-center rounded-full border-2 border-white font-black">{hubReleasedOrders.length}</span>
          )}
        </button>
      </div>

      {activeTab === 'new' ? (
        <div className="animate-in fade-in duration-500">
          {editStatus.type !== 'new' && (
            <div className={`mb-6 p-4 rounded-2xl border-l-[8px] flex items-center justify-between shadow-lg ${editStatus.type === 'frozen' ? 'bg-rose-50 border-rose-600 text-rose-800' : 'bg-amber-50 border-amber-400 text-amber-800'
              }`}>
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white ${editStatus.type === 'frozen' ? 'bg-rose-600' : 'bg-amber-500'}`}>
                  <i className={`fa-solid ${editStatus.type === 'frozen' ? 'fa-lock' : 'fa-hourglass-half'}`}></i>
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-tight">{editStatus.label}</p>
                  <p className="text-[10px] font-bold opacity-70">
                    {editStatus.isFrozen ? 'Manual edits disabled.' : 'Initial lifecycle window active.'}
                  </p>
                </div>
              </div>
              {editStatus.isFrozen && <button onClick={resetForm} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-[10px] font-black uppercase">Start Fresh</button>}
            </div>
          )}

          {message && (
            <div className={`mb-6 p-4 rounded-2xl border flex items-center gap-3 animate-in slide-in-from-top-4 ${message.type === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' :
              message.type === 'info' ? 'bg-blue-50 border-blue-100 text-blue-700' : 'bg-rose-50 border-rose-100 text-rose-700'
              }`}>
              <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : message.type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'}`}></i>
              <span className="text-xs font-bold uppercase">{message.text}</span>
            </div>
          )}

          <div className={`bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden ${editStatus.isFrozen ? 'opacity-80' : ''}`}>
            <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-colors ${editingOrderId ? (editStatus.isFrozen ? 'bg-rose-600' : 'bg-amber-500') : 'bg-blue-600'}`}>
                  <i className={`fa-solid ${editingOrderId ? 'fa-pen-to-square' : 'fa-clipboard-list'} text-xl`}></i>
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Order Management Terminal</h2>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{editingOrderId ? `Modifying Internal ID: ${customerReferenceNumber}` : 'Initialize New Transaction Entry'}</p>
                </div>
              </div>
              {editingOrderId && !editStatus.isFrozen && (
                <button onClick={resetForm} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-[10px] font-black uppercase hover:bg-slate-50">Create New</button>
              )}
            </div>

            <div className="p-8 space-y-10">
              {!editingOrderId && (
                <div onClick={() => !isScanning && fileInputRef.current?.click()} className="border-2 border-dashed rounded-[2rem] p-10 bg-slate-50 flex flex-col items-center cursor-pointer hover:bg-blue-50 transition-all border-slate-200 hover:border-blue-400 group">
                  <input type="file" ref={fileInputRef} className="hidden" onChange={handleAIScan} />
                  <div className="w-16 h-16 rounded-3xl bg-white shadow-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <i className={`fa-solid ${isScanning ? 'fa-spinner fa-spin text-blue-600' : 'fa-brain-circuit text-slate-300 group-hover:text-blue-500'} text-3xl transition-colors`}></i>
                  </div>
                  <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest">{isScanning ? 'Syncing Intelligence...' : 'Automated Vision Scan (OCR)'}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-10">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                  <div className="space-y-2 relative">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">PO Reference Number</label>
                    <input
                      disabled={editStatus.isFrozen}
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                      placeholder="e.g. PO-1029"
                      value={customerReferenceNumber}
                      onChange={e => setCustomerReferenceNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 flex justify-between items-center">
                      <span>Customer Entity Name</span>
                      {customerName && (
                        <span className={`text-[8px] px-2 py-0.5 rounded-full border transition-all ${isNewCustomerCreated
                          ? 'bg-emerald-100 text-emerald-700 border-emerald-200 animate-pulse'
                          : (customers.some(c => c.name.toLowerCase() === customerName.toLowerCase())
                            ? 'bg-blue-100 text-blue-700 border-blue-200'
                            : 'bg-slate-100 text-slate-400 border-slate-200')
                          }`}>
                          {isNewCustomerCreated
                            ? 'New Auto-Registered Entity'
                            : (customers.some(c => c.name.toLowerCase() === customerName.toLowerCase())
                              ? 'Matched with CRM Profile'
                              : 'Manual/Unmapped Entity')}
                        </span>
                      )}
                    </label>
                    <input
                      disabled={editStatus.isFrozen}
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                      placeholder="Enter Legal Entity Name..."
                      value={customerName}
                      list="crm-customer-suggestions"
                      onChange={e => {
                        setCustomerName(e.target.value);
                        setIsNewCustomerCreated(false);
                      }}
                      onBlur={handleCustomerBlur}
                      required
                    />
                    <datalist id="crm-customer-suggestions">
                      {customers.map(c => (
                        <option key={c.id} value={c.name} />
                      ))}
                    </datalist>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">PO Received Date</label>
                    <input
                      disabled={editStatus.isFrozen}
                      type="date"
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                      value={orderDate}
                      onChange={e => setOrderDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Payment SLA (Days)</label>
                    <input
                      disabled={editStatus.isFrozen}
                      type="number"
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                      placeholder="Collection Limit..."
                      value={paymentSlaDays}
                      onChange={e => setPaymentSlaDays(parseInt(e.target.value) || 0)}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Transaction Line Items</h4>
                  </div>
                  {items.map((item, idx) => {
                    const lineTotal = (Number(item.quantity) || 0) * (Number(item.pricePerUnit) || 0);
                    return (
                      <div key={item.id} className="p-6 bg-slate-50/50 rounded-3xl border border-slate-100 group hover:border-blue-200 transition-all">
                        <div className="flex flex-col lg:flex-row gap-4">
                          <div className="flex-[3] space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Part/Service Description</label>
                            <input disabled={editStatus.isFrozen} className="w-full p-3 border-2 border-white rounded-xl bg-white font-bold outline-none focus:border-blue-500 transition-all shadow-sm" value={item.description} onChange={e => { const n = [...items]; n[idx].description = e.target.value; setItems(n); }} required />
                          </div>
                          <div className="flex-1 space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Quantity</label>
                            <input disabled={editStatus.isFrozen} type="number" step="any" className="w-full p-3 border-2 border-white rounded-xl bg-white font-bold text-center shadow-sm" value={item.quantity} onChange={e => { const n = [...items]; n[idx].quantity = parseFloat(e.target.value) || 0; setItems(n); }} />
                          </div>
                          <div className="flex-1 space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Unit price (L.E.)</label>
                            <input disabled={editStatus.isFrozen} type="number" step="any" className="w-full p-3 border-2 border-white rounded-xl bg-white font-black text-emerald-600 shadow-sm" value={item.pricePerUnit} onChange={e => { const n = [...items]; n[idx].pricePerUnit = parseFloat(e.target.value) || 0; setItems(n); }} />
                          </div>
                          <div className="flex-1 space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Line Net</label>
                            <div className="w-full p-3 bg-slate-50 border-2 border-slate-100 rounded-xl text-slate-500 font-black text-right text-xs">
                              {lineTotal.toLocaleString()}
                            </div>
                          </div>
                          {!editStatus.isFrozen && (
                            <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))} className="p-3 text-slate-300 hover:text-rose-500 transition-colors"><i className="fa-solid fa-trash-can"></i></button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!editStatus.isFrozen && (
                    <button type="button" onClick={() => setItems([...items, { id: `temp_${Date.now()}`, description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: 14, taxDetected: true, logs: [] }])} className="px-6 py-3 bg-white border border-blue-100 text-blue-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-50 transition-all flex items-center gap-2">
                      <i className="fa-solid fa-plus"></i> Append Line Item
                    </button>
                  )}
                </div>

                <div className="bg-slate-900 p-10 rounded-[3rem] text-white flex flex-col lg:flex-row justify-between items-center gap-10 shadow-2xl relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-5"><i className="fa-solid fa-coins text-9xl"></i></div>
                  <div className="flex flex-col md:flex-row gap-12 relative z-10">
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest">Subtotal Value</div><div className="text-3xl font-black">{totals.subtotal.toLocaleString()} <span className="text-sm opacity-30">L.E.</span></div></div>
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest text-rose-400">Total VAT (14%)</div><div className="text-3xl font-black text-rose-400">+{totals.taxTotal.toLocaleString()}</div></div>
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest text-emerald-400">Grand Transaction Total</div><div className="text-4xl font-black text-emerald-400">{totals.total.toLocaleString()}</div></div>
                  </div>
                  <button disabled={editStatus.isFrozen} type="submit" className={`px-16 py-5 rounded-3xl font-black uppercase text-sm tracking-[0.2em] transition-all active:scale-95 shadow-xl relative z-10 ${editStatus.isFrozen ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : (editingOrderId ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700')}`}>
                    {editStatus.isFrozen ? 'LOCKED' : (editingOrderId ? 'Save Modification' : 'Commit Acquisition')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : activeTab === 'logged' ? (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-slate-900 flex items-center justify-center text-white shadow-lg">
                  <i className="fa-solid fa-inbox text-xl"></i>
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Logged Order Registry</h2>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Manage and resume uncommitted operational records</p>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50/50 border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                  <tr>
                    <th className="px-8 py-5">Internal Ref / PO Ref</th>
                    <th className="px-8 py-5">Customer Entity</th>
                    <th className="px-8 py-5">Created Date</th>
                    <th className="px-8 py-5">Lines</th>
                    <th className="px-8 py-5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {loggedOrders.map(draft => (
                    <tr key={draft.id} className={`hover:bg-slate-50/80 transition-all group ${draft.loggingComplianceViolation ? 'bg-rose-50 hover:!bg-rose-100 border-l-4 border-rose-500' : ''}`}>
                      <td className="px-8 py-6">
                        <div className="font-mono text-xs font-black text-blue-600 uppercase">{draft.internalOrderNumber}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">PO: {draft.customerReferenceNumber || 'N/A'}</div>
                        {draft.loggingComplianceViolation && <div className="mt-1"><span className="text-[9px] font-black text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded border border-rose-200 uppercase tracking-wider">Logging Delay</span></div>}
                      </td>
                      <td className="px-8 py-6 font-black text-slate-800">{draft.customerName}</td>
                      <td className="px-8 py-6 text-xs text-slate-500 font-bold">
                        {(() => {
                          const log = draft.logs.find(l => l.status === OrderStatus.LOGGED);
                          const dateStr = log ? log.timestamp : draft.dataEntryTimestamp;
                          return new Date(dateStr).toLocaleDateString();
                        })()}
                      </td>
                      <td className="px-8 py-6"><span className="px-2.5 py-1 bg-slate-100 rounded-lg text-[10px] font-black text-slate-600 border border-slate-200">{draft.items.length} POS</span></td>
                      <td className="px-8 py-6 text-right">
                        <button
                          onClick={() => loadOrder(draft)}
                          className="px-5 py-2.5 bg-blue-600 text-white font-black text-[10px] uppercase rounded-xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-100 flex items-center gap-2 ml-auto"
                        >
                          <i className="fa-solid fa-rotate-right"></i> Resume Record
                        </button>
                      </td>
                    </tr>
                  ))}
                  {loggedOrders.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-8 py-20 text-center">
                        <div className="flex flex-col items-center gap-3 text-slate-300">
                          <i className="fa-solid fa-folder-open text-5xl opacity-10"></i>
                          <p className="font-black text-xs uppercase tracking-[0.2em]">No Active Logged Orders Found</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
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
      )}

      {/* Add Customer Modal */}
      {showAddCustomerModal && (
        <AddCustomerModal
          initialName={customerName}
          config={config}
          onSave={handleSaveNewCustomer}
          onClose={() => {
            setShowAddCustomerModal(false);
          }}
        />
      )}

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
