
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrderItem, OrderStatus, Customer, AppConfig, CustomerOrder, User, Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from '../types';
import { GoogleGenAI } from "@google/genai";
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { STATUS_CONFIG } from '../constants';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

import { AddCustomerModal } from './AddCustomerModal';
import { SortableTable, ColumnDef } from './SortableTable';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const renderPdfPageToJpegBase64 = async (pdf: any, pageNumber: number): Promise<string> => {
  const clampedPage = Math.max(1, Math.min(pageNumber, pdf.numPages || 1));
  const page = await pdf.getPage(clampedPage);
  const viewport = page.getViewport({ scale: 2 });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Failed to initialize PDF conversion canvas.');
  }

  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const base64 = jpegDataUrl.split(',')[1];
  if (!base64) {
    throw new Error('Failed to convert PDF to JPEG data.');
  }

  return base64;
};

const scorePdfPageText = (text: string): number => {
  const normalized = text.toLowerCase();
  const has = (re: RegExp) => re.test(normalized);
  let score = 0;

  if (has(/purchase\s*order|\bpo\b|po\s*(number|no|ref|reference)/)) score += 6;
  if (has(/\bitem\b|description|part\s*number|service/)) score += 3;
  if (has(/\bqty\b|quantity|unit\s*price|price\s*per\s*unit|amount|subtotal|grand\s*total|total/)) score += 4;
  if (has(/vat|tax|\btax\s*rate\b|\b14\s*%/)) score += 2;
  if (has(/delivery\s*date|expected\s*delivery|ship\s*by/)) score += 2;
  if (has(/net\s*\d+|payment\s*terms|due\s*within\s*\d+\s*days|after\s*delivery/)) score += 2;
  if (has(/terms\s*(and|&)\s*conditions/)) score -= 2;

  return score;
};

const pickPdfCandidatePages = async (pdf: any, maxPages = 2): Promise<number[]> => {
  const pageCount = Math.min(Math.max(1, pdf.numPages || 1), maxPages);
  const scoredPages: Array<{ page: number; score: number }> = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = (textContent.items || [])
      .map((item: any) => item?.str || '')
      .join(' ');
    scoredPages.push({ page: pageNumber, score: scorePdfPageText(text) });
  }

  return scoredPages.sort((a, b) => b.score - a.score).map(entry => entry.page);
};

const hasStrongExtraction = (extracted: any): boolean => {
  if (!extracted || typeof extracted !== 'object') return false;

  const hasCustomerName = !!String(extracted.customer?.name || '').trim();
  const hasPoRef = !!String(extracted.poRef || '').trim();
  const itemCount = Array.isArray(extracted.items) ? extracted.items.length : 0;
  const hasUsefulItems = itemCount > 0 && extracted.items.some((item: any) => {
    const hasDesc = !!String(item?.description || '').trim();
    const hasPrice = Number.isFinite(Number(item?.price)) || Number.isFinite(Number(item?.pricePerUnit));
    const hasQty = Number.isFinite(Number(item?.quantity));
    return hasDesc || hasPrice || hasQty;
  });

  const hasDateSignal = !!String(extracted.date || extracted.deliveryDate || '').trim();

  return hasPoRef && hasUsefulItems && (hasCustomerName || hasDateSignal);
};

const mergeExtractionResults = (primary: any, fallback: any): any => {
  const merged = { ...(primary || {}) };
  const fallbackObj = fallback || {};

  merged.customer = {
    ...(primary?.customer || {}),
    ...(fallbackObj.customer || {}),
    name: primary?.customer?.name || fallbackObj.customer?.name || '',
    email: primary?.customer?.email || fallbackObj.customer?.email || '',
    phone: primary?.customer?.phone || fallbackObj.customer?.phone || '',
    address: primary?.customer?.address || fallbackObj.customer?.address || '',
    contactName: primary?.customer?.contactName || fallbackObj.customer?.contactName || ''
  };

  const scalarKeys = [
    'poRef',
    'paymentSlaDays',
    'paymentFromDelivery',
    'date',
    'deliveryDate',
    'deliveryTerms',
    'incoterms',
    'currency',
    'partialShipment'
  ];

  scalarKeys.forEach((key) => {
    const primaryValue = merged[key];
    const fallbackValue = fallbackObj[key];
    const isEmptyPrimary = primaryValue === null || primaryValue === undefined || primaryValue === '';
    if (isEmptyPrimary && fallbackValue !== undefined) {
      merged[key] = fallbackValue;
    }
  });

  const primaryItems = Array.isArray(primary?.items) ? primary.items : [];
  const fallbackItems = Array.isArray(fallbackObj?.items) ? fallbackObj.items : [];
  if (primaryItems.length === 0 && fallbackItems.length > 0) {
    merged.items = fallbackItems;
  } else {
    merged.items = primaryItems;
  }

  return merged;
};

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

type ManagementTab = 'new' | 'logged' | 'blanket';
const DEFAULT_TAX_PERCENT = 14;

export const OrderManagement: React.FC<OrderManagementProps> = ({ config, refreshKey, currentUser }) => {
  const today = new Date().toISOString().split('T')[0];
  const getDatePlusDays = (dateStr: string, days: number) => {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const [activeTab, setActiveTab] = useState<ManagementTab>('new');
  const [contracts, setContracts] = useState<any[]>([]);
  const [contractId, setContractId] = useState('');
  const [blanketSubTab, setBlanketSubTab] = useState<'new_blanket' | 'new_contract' | 'logged_contracts'>('new_blanket');
  const [contractFormId, setContractFormId] = useState('');
  const [contractFormCustomerName, setContractFormCustomerName] = useState('');
  const [contractFormDescription, setContractFormDescription] = useState('');
  const [contractFormTargetItems, setContractFormTargetItems] = useState('');
  const [contractFormReceivedDate, setContractFormReceivedDate] = useState(today);
  const [contractSearch, setContractSearch] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [existingOrders, setExistingOrders] = useState<CustomerOrder[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerReferenceNumber, setCustomerReferenceNumber] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [paymentSlaDays, setPaymentSlaDays] = useState(config.settings.defaultPaymentSlaDays);
  const [appliesWithholdingTax, setAppliesWithholdingTax] = useState(false);
  const [blanketOrder, setBlanketOrder] = useState(false);
  const [blanketContractId, setBlanketContractId] = useState('');
  const [deliveryInputMode, setDeliveryInputMode] = useState<'days' | 'date'>('days');
  const [targetDeliveryDays, setTargetDeliveryDays] = useState<number | ''>(30);
  const [targetDeliveryDate, setTargetDeliveryDate] = useState(getDatePlusDays(today, 30));
  const [orderTaxPercent, setOrderTaxPercent] = useState(DEFAULT_TAX_PERCENT);
  const [currency, setCurrency] = useState<Currency>(DEFAULT_CURRENCY);
  const [conversionRate, setConversionRate] = useState<number>(1);
  const [items, setItems] = useState<ItemWithTaxStatus[]>([
    { id: 'temp_1', description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: DEFAULT_TAX_PERCENT, isAccepted: false, taxDetected: true }
  ]);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info', text: string } | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isNewCustomerCreated, setIsNewCustomerCreated] = useState(false);
  const [externalSubmissionFile, setExternalSubmissionFile] = useState<File | null>(null);
  const [externalSubmissionSnapshot, setExternalSubmissionSnapshot] = useState<{ name: string; type: string; base64: string } | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'orderDate', direction: 'asc' });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delivery Note PDF & POD State moved to ShipmentModule

  useEffect(() => { fetchData(); }, [refreshKey]);

  const fetchData = async () => {
    const [c, o, ct] = await Promise.all([
      dataService.getCustomers(), 
      dataService.getOrders(),
      dataService.getContracts().catch(() => [])
    ]);
    setCustomers(c);
    setExistingOrders(o);
    setContracts(ct);
  };

  const loggedOrders = useMemo(() => {
    const filtered = existingOrders.filter(o => o.status === OrderStatus.LOGGED || o.status === OrderStatus.NEGATIVE_MARGIN);

    return filtered.sort((a, b) => {
      let aVal: any = '';
      let bVal: any = '';

      switch (sortConfig.key) {
        case 'id':
          aVal = a.internalOrderNumber || '';
          bVal = b.internalOrderNumber || '';
          break;
        case 'orderDate':
          aVal = a.orderDate || a.dataEntryTimestamp || '';
          bVal = b.orderDate || b.dataEntryTimestamp || '';
          break;
        case 'dataEntryTimestamp':
          aVal = a.dataEntryTimestamp || '';
          bVal = b.dataEntryTimestamp || '';
          break;
        case 'customer':
          aVal = a.customerName || '';
          bVal = b.customerName || '';
          break;
        case 'lineCount':
          aVal = a.items.length;
          bVal = b.items.length;
          break;
        default:
          aVal = a.orderDate || a.dataEntryTimestamp || '';
          bVal = b.orderDate || b.dataEntryTimestamp || '';
      }

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [existingOrders, sortConfig]);

  const formatOrderTimestamp = (timestamp?: string) => {
    if (!timestamp) return 'N/A';
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return 'N/A';
    return `${parsed.toLocaleDateString()} ${parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const getLastEditedInfo = (order: CustomerOrder) => {
    const realUserLogs = (order.logs || [])
      .filter(log =>
        !!log.timestamp &&
        !!log.user &&
        log.user.trim().toLowerCase() !== 'system'
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const latestLog = realUserLogs.pop();

    return {
      timestamp: latestLog?.timestamp || order.dataEntryTimestamp,
      user: latestLog?.user || 'System'
    };
  };

  const getSubmittedBy = (order: CustomerOrder) => {
    const submitLog = (order.logs || [])
      .filter(log => log.message === 'Order acquisition recorded')
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];

    return submitLog?.user || 'System';
  };

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ column }: { column: string }) => {
    if (sortConfig.key !== column) return <i className="fa-solid fa-sort ml-2 opacity-20 group-hover:opacity-100 transition-opacity"></i>;
    return <i className={`fa-solid fa-sort-${sortConfig.direction === 'asc' ? 'up' : 'down'} ml-2 text-blue-600`}></i>;
  };


  // Auto-retrieval of existing POs
  const lastAutoLoadedRef = useRef<string | null>(null);

  // Clear tracking ref when starting a fresh acquisition
  useEffect(() => {
    if (!editingOrderId) lastAutoLoadedRef.current = null;
  }, [editingOrderId]);

  useEffect(() => {
    if (!customerReferenceNumber || editingOrderId || isScanning) return;

    const normalizedRef = customerReferenceNumber.trim().toLowerCase();
    const normalizedCustomerName = customerName.trim().toLowerCase();
    const match = existingOrders.find(o => {
      // Internal order numbers are globally unique
      if (o.internalOrderNumber?.trim().toLowerCase() === normalizedRef) {
        return true;
      }
      // Customer PO references are unique per customer
      if (o.customerReferenceNumber?.trim().toLowerCase() === normalizedRef) {
        if (!normalizedCustomerName) return true;
        return o.customerName?.trim().toLowerCase() === normalizedCustomerName;
      }
      return false;
    });

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



  const editStatus = useMemo(() => {
    if (!editingOrderId) return { type: 'new', label: '', isFrozen: false };
    const order = existingOrders.find(o => o.id === editingOrderId);
    if (!order) return { type: 'new', label: '', isFrozen: false };

    const isManager = currentUser.roles?.includes('management') || false;
    if (isManager) {
      return { type: 'warning', label: 'MANAGER OVERRIDE: Edit time limit bypassed.', isFrozen: false };
    }

    const entrySource = order.dataEntryTimestamp ?? order.orderDate ?? new Date().toISOString();
    const entryTime = new Date(String(entrySource)).getTime();
    const now = new Date().getTime();
    const ageHrs = (now - entryTime) / 3600000;
    const limit = config.settings.orderEditTimeLimitHrs;

    if (ageHrs > limit) {
      return { type: 'frozen', label: `LOCKED: This PO exceeded the ${limit}h edit threshold.`, isFrozen: true };
    }
    return { type: 'warning', label: `EDITABLE: Lifecycle window expires in ${Math.max(0, (limit - ageHrs) * 60).toFixed(0)} mins.`, isFrozen: false };
  }, [editingOrderId, existingOrders, config.settings.orderEditTimeLimitHrs, currentUser]);

  const normalizeQty = (qty: any): number => {
    const num = Number(qty);
    return (!isNaN(num) && num > 0) ? num : 1;
  };

  const loadOrder = (match: CustomerOrder) => {
    setCustomerName(match.customerName);
    setCustomerReferenceNumber(String(match.customerReferenceNumber || match.internalOrderNumber || ''));
    setOrderDate(match.orderDate);
    setPaymentSlaDays(match.paymentSlaDays || config.settings.defaultPaymentSlaDays);
    setAppliesWithholdingTax(match.appliesWithholdingTax || false);
    setBlanketOrder(match.blanketOrder || false);
    setBlanketContractId(match.blanketContractId || '');
    setContractId(match.contractId || '');
    const loadedDeliveryDays = match.targetDeliveryDays || 30;
    setTargetDeliveryDays(loadedDeliveryDays);
    setTargetDeliveryDate(match.targetDeliveryDate || getDatePlusDays(match.orderDate, loadedDeliveryDays));
    // Multi-currency amendment: hydrate currency + conversionRate from the
    // existing record so editing a USD order does not silently reset it to L.E.
    setCurrency(match.currency || DEFAULT_CURRENCY);
    setConversionRate(match.conversionRate || 1);

    setItems(match.items.map(it => ({ ...it, taxDetected: true, quantity: normalizeQty(it.quantity) })));

    setEditingOrderId(match.id);
    if (match.blanketOrder) {
      setActiveTab('blanket');
      setBlanketSubTab('new_blanket');
    } else {
      setActiveTab('new');
    }
    setIsNewCustomerCreated(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const totals = useMemo(() => {
    let subtotal = 0;
    let taxTotal = 0;
    items.forEach(item => {

      const base = (Number(item.quantity) || 1) * (Number(item.pricePerUnit) || 0);
      const tax = base * ((Number(item.taxPercent) || 0) / 100);

      subtotal += base;
      taxTotal += tax;
    });
    return { subtotal, taxTotal, total: subtotal + taxTotal };
  }, [items, orderTaxPercent]);

  const handleAIScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || isScanning) return;
    setExternalSubmissionFile(file);
    setIsScanning(true);
    setIsNewCustomerCreated(false);
    setMessage({ type: 'info', text: 'Vision intelligence mapping PO entities...' });

    const perf: Record<string, number> = {};
    const t0 = performance.now();

    try {
      const originalFileBase64 = await new Promise<string>((resolve, reject) => {
        const originalReader = new FileReader();
        originalReader.onload = () => {
          const result = originalReader.result as string;
          const base64 = result?.split(',')[1] || '';
          if (!base64) {
            reject(new Error('Failed to snapshot external submission file.'));
            return;
          }
          resolve(base64);
        };
        originalReader.onerror = () => reject(new Error('Failed to read external submission file.'));
        originalReader.readAsDataURL(file);
      });

      setExternalSubmissionSnapshot({
        name: file.name,
        type: file.type || 'application/octet-stream',
        base64: originalFileBase64
      });

      const isPdfUpload = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      let inputMimeType = file.type || 'application/octet-stream';
      let base64Data = '';
      let parsedPdf: any = null;
      let rankedPages: number[] = [1];
      let primaryPage = 1;

      const t_read_start = performance.now();
      if (isPdfUpload) {
        setMessage({ type: 'info', text: 'PDF detected. Analyzing pages 1-2 to find the strongest PO data region...' });
        const pdfData = new Uint8Array(await file.arrayBuffer());
        parsedPdf = await getDocument({ data: pdfData }).promise;
        const t_score_start = performance.now();
        rankedPages = await pickPdfCandidatePages(parsedPdf, 2);
        perf['1_pdf_page_scoring_ms'] = performance.now() - t_score_start;

        primaryPage = rankedPages[0] || 1;
        setMessage({ type: 'info', text: `PDF detected. Scanning page ${primaryPage} first based on PO signal scoring...` });
        base64Data = await renderPdfPageToJpegBase64(parsedPdf, primaryPage);
        inputMimeType = 'image/jpeg';
      } else {
        const reader = new FileReader();
        base64Data = await new Promise<string>((res) => {
          reader.onload = () => res((reader.result as string).split(',')[1]);
          reader.readAsDataURL(file);
        });
      }
      perf['1_file_read_ms'] = performance.now() - t_read_start;

      const existingCustomerNames = customers.map(c => c.name).slice(0, 50).join(', '); // Passing a sample of known names
      const prompt = `
        Context: The following customers already exist in our database: [${existingCustomerNames}].
        If the name on the PO is a logical match (e.g., "Google" vs "Google Inc"), you MUST use the exact name from the database.

        Extract all details from this Purchase Order image.
        Structure the response as valid JSON with these keys:
        - customer: { name, email, phone, address, contactName }
        - poRef: (The customer's PO number string)
        - paymentSlaDays: (Payment terms in DAYS ONLY as an integer. Look EVERYWHERE on the PO: header, footer, terms & conditions, line item columns, and notes. Extract the number of days for payment terms like 'Net 30', '45 days', 'Payment due in 15 days', 'payable within 60 days of delivery', 'settlement 30 days post-delivery'. Only return the integer number of days.)
        - paymentFromDelivery: (boolean, true if payment is calculated from delivery date like '30 days after delivery', 'payment due within 15 days of delivery', 'settlement post-delivery'. false if from PO/invoice date like 'Net 30', 'payment terms 45 days'.)
        - date: (The PO issue date in YYYY-MM-DD format)
        - deliveryDate: (Expected delivery date in YYYY-MM-DD format if found anywhere on the PO: headers, footers, terms & conditions, line item columns, notes, or delivery schedules. Leave empty string if not found.)
        - deliveryTerms: (Free text describing any delivery terms or expectations found anywhere on the document. Leave empty string if not found.)
        - incoterms: (Incoterms code if found: FOB, CIF, CFR, DDP, DAP, EXW, FCA, CPT, CIP. Leave empty string if not found.)
        - currency: (Currency code if explicitly stated on the PO: USD, EUR, GBP, EGP, L.E., etc. Leave empty string if not found.)
        - partialShipment: (boolean, true if the PO explicitly allows partial deliveries or split shipments. false otherwise.)
        - items: [ { description, quantity, unit, price, taxPercent, deliveryDate?, deliveryTerms? } ]

        CRITICAL EXTRACTION RULES:
        1. Output ONLY the JSON object.
        2. Scan the ENTIRE document including headers, footers, side margins, terms & conditions blocks, and line item columns for ALL fields.
        3. For paymentSlaDays and paymentFromDelivery, look for phrases like:
           - "Net 30" → 30, paymentFromDelivery: false
           - "Payment due within 45 days" → 45, paymentFromDelivery: false
           - "Payable 60 days after delivery" → 60, paymentFromDelivery: true
           - "Settlement 30 days post-delivery" → 30, paymentFromDelivery: true
           - "Payment terms: 90 days" → 90, paymentFromDelivery: false
           - "Due in 15 days from invoice date" → 15, paymentFromDelivery: false
           - "Due 30 days after receipt of goods" → 30, paymentFromDelivery: true
        4. For deliveryDate and deliveryTerms, look in:
           - Header/footer sections
           - Terms & conditions blocks
           - Line item columns (some POs have delivery dates per item)
           - Side notes or annotations
           - Delivery schedule tables
           - Phrases like "Delivery within 2 weeks", "Expected delivery: 2024-03-15", "Ship by March 1st"
        5. For incoterms, look for standard trade terms anywhere on the PO: FOB, CIF, CFR, DDP, DAP, EXW, FCA, CPT, CIP.
        6. For partialShipment, look for phrases like: "partial shipments allowed", "split delivery permitted", "multiple deliveries accepted".
        7. Default items taxPercent to 14 if tax is detected but the specific rate is not clearly legible (standard VAT).
        8. If delivery info is found per line item, include it in that item's deliveryDate and deliveryTerms fields.
        9. If a general delivery date applies to the whole PO, put it in the top-level deliveryDate field.
      `;

      const runVisionInference = async (scanBase64Data: string, scanMimeType: string): Promise<string> => {
        if (config.settings.aiProvider === 'gemini') {
          const apiKey = config.settings.geminiConfig?.apiKey;
          const modelName = config.settings.geminiConfig?.modelName || 'gemini-1.5-flash';

          if (!apiKey) {
            throw new Error("Gemini API Key is not configured.");
          }

          console.log('[AI Scan] Using Gemini model:', modelName);
          const ai = new GoogleGenAI({ apiKey });
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: scanMimeType, data: scanBase64Data } },
                  { text: prompt }
                ]
              }
            ],
            config: { responseMimeType: "application/json" }
          });
          console.log('[AI Scan] Gemini raw response:', response);
          return response.text || "{}";
        }

        const { apiKey, baseUrl, modelName } = config.settings.openaiConfig;
        console.log('[AI Scan] OpenAI config from settings:', { baseUrl, modelName, apiKeyExists: !!apiKey, apiKeyLength: apiKey?.length, apiKeyPrefix: apiKey?.substring(0, 15) });
        const upstreamEndpoint = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}chat/completions`;
        console.log('[AI Scan] Using OpenAI endpoint (via server proxy):', upstreamEndpoint, 'model:', modelName);
        if (!apiKey) {
          throw new Error("OpenAI API Key is not configured. Please add your API key in Settings > AI Configuration.");
        }
        const response = await fetch('/api/v1/ai-proxy/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: upstreamEndpoint,
            apiKey,
            payload: {
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
                        url: `data:${scanMimeType};base64,${scanBase64Data}`
                      }
                    }
                  ]
                }
              ]
            }
          })
        });
        const data = await response.json();
        console.log('[AI Scan] OpenAI raw response:', data);
        return data.choices?.[0]?.message?.content || "{}";
      };

      const t_ai_primary_start = performance.now();
      let textOutput = await runVisionInference(base64Data, inputMimeType);
      perf['2_ai_primary_inference_ms'] = performance.now() - t_ai_primary_start;
      console.log('[AI Scan] Primary text output:', textOutput);

      console.log('[AI Scan] Parsing extracted text:', textOutput);
      const t_parse_start = performance.now();
      let extracted = JSON.parse(textOutput);
      perf['3_json_parse_ms'] = performance.now() - t_parse_start;
      console.log('[AI Scan] Parsed extracted:', extracted);

      const fallbackPage = rankedPages.find(p => p !== primaryPage);
      if (isPdfUpload && parsedPdf && fallbackPage && !hasStrongExtraction(extracted)) {
        console.log('[AI Scan] Primary extraction incomplete. Running fallback scan on page:', fallbackPage);
        setMessage({ type: 'info', text: `Primary page extraction incomplete. Scanning page ${fallbackPage} for missing order details...` });
        const t_fallback_render_start = performance.now();
        const fallbackBase64 = await renderPdfPageToJpegBase64(parsedPdf, fallbackPage);
        perf['3b_pdf_fallback_render_ms'] = performance.now() - t_fallback_render_start;

        const t_ai_fallback_start = performance.now();
        const fallbackTextOutput = await runVisionInference(fallbackBase64, 'image/jpeg');
        perf['3c_ai_fallback_inference_ms'] = performance.now() - t_ai_fallback_start;
        console.log('[AI Scan] Fallback text output:', fallbackTextOutput);

        const t_fallback_parse_start = performance.now();
        const fallbackExtracted = JSON.parse(fallbackTextOutput);
        perf['3d_json_fallback_parse_ms'] = performance.now() - t_fallback_parse_start;

        extracted = mergeExtractionResults(extracted, fallbackExtracted);
        console.log('[AI Scan] Merged extraction result:', extracted);
      }

      if (extracted.customer?.name) {
        console.log('[AI Scan] Found customer:', extracted.customer.name);
        const t_crm_start = performance.now();
        const existingCust = customers.find(c => c.name.toLowerCase() === extracted.customer.name.toLowerCase());
        if (!existingCust) {
          console.log('[AI Scan] Creating new customer...');
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
          console.log('[AI Scan] New customer created:', newCust);
          setCustomers(prev => [...prev, newCust]);
          setIsNewCustomerCreated(true);
        } else {
          console.log('[AI Scan] Existing customer found:', existingCust.name);
        }
        setCustomerName(extracted.customer.name);
        if (existingCust) {
          setAppliesWithholdingTax(existingCust.appliesWithholdingTax || false);
        }
        perf['4_crm_lookup_or_create_ms'] = performance.now() - t_crm_start;
      } else {
        console.log('[AI Scan] No customer name found in extraction');
      }

      setCustomerReferenceNumber(extracted.poRef || '');
      if (extracted.date) setOrderDate(extracted.date);

      if (extracted.deliveryDate) {
        console.log('[AI Scan] Found delivery date:', extracted.deliveryDate);
        setTargetDeliveryDate(extracted.deliveryDate);
        const start = new Date(extracted.date || orderDate);
        const end = new Date(extracted.deliveryDate);
        const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        if (diff > 0) setTargetDeliveryDays(diff);
      }
      if (extracted.deliveryTerms) {
        console.log('[AI Scan] Found delivery terms:', extracted.deliveryTerms);
      }

      // Extract Incoterms if found
      if (extracted.incoterms) {
        console.log('[AI Scan] Found incoterms:', extracted.incoterms);
      }

      // Extract currency if found — only set when the AI detected a value AND that
      // value is in our supported list, otherwise fall through to the form's
      // current default (L.E.).
      if (extracted.currency && SUPPORTED_CURRENCIES.includes(extracted.currency)) {
        console.log('[AI Scan] Found currency:', extracted.currency);
        setCurrency(extracted.currency);
      }

      // Extract partial shipment flag
      if (extracted.partialShipment === true) {
        console.log('[AI Scan] Partial shipments allowed');
      }

      // Smart payment SLA parsing - handles string values like "30 days"
      const smartParseDays = (value: any): number | null => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
        if (typeof value === 'string') {
          const match = value.match(/(\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            return num > 0 ? num : null;
          }
        }
        return null;
      };

      const parsedPaymentDays = smartParseDays(extracted.paymentSlaDays);
      if (parsedPaymentDays !== null) {
        setPaymentSlaDays(parsedPaymentDays);
        console.log('[AI Scan] Parsed payment SLA:', parsedPaymentDays, 'days',
          extracted.paymentFromDelivery ? '(from delivery date)' : '(from PO/invoice date)');
      }

      if (extracted.items) {
        console.log('[AI Scan] Found items:', extracted.items.length);
        const t_items_start = performance.now();
        const firstDetectedTax = extracted.items.find((i: any) => i?.taxPercent !== null && i?.taxPercent !== undefined)?.taxPercent;
        const normalizedOrderTax = Number.isFinite(Number(firstDetectedTax)) ? Number(firstDetectedTax) : DEFAULT_TAX_PERCENT;
        setOrderTaxPercent(normalizedOrderTax);
        setItems(extracted.items.map((i: any, idx: number) => {
          return {
            id: `temp_${Date.now()}_${idx}`,
            description: i.description,
            quantity: i.quantity || 1,
            unit: i.unit || 'pcs',
            pricePerUnit: i.price,
            taxPercent: normalizedOrderTax,
            taxDetected: true,
            logs: []
          };
        }));
        perf['5_items_mapping_ms'] = performance.now() - t_items_start;
      } else {
        console.log('[AI Scan] No items found in extraction');
      }

      perf['total_ms'] = performance.now() - t0;
      const provider = config.settings.aiProvider === 'gemini'
        ? `Gemini (${config.settings.geminiConfig?.modelName || 'gemini-1.5-flash'})`
        : `OpenAI (${config.settings.openaiConfig?.modelName})`;
      console.group(`%c[NexusERP] OCR Profiling — ${provider}`, 'color: #6366f1; font-weight: bold;');
      console.table(
        Object.entries(perf).map(([step, ms]) => ({ step, 'time (ms)': ms.toFixed(2) }))
      );
      console.groupEnd();
      setMessage({ type: 'success', text: 'finished' });

    } catch (err: any) {
      perf['total_ms'] = performance.now() - t0;
      console.group('%c[NexusERP] OCR Profiling — FAILED', 'color: #ef4444; font-weight: bold;');
      console.table(
        Object.entries(perf).map(([step, ms]) => ({ step, 'time (ms)': ms.toFixed(2) }))
      );
      console.groupEnd();
      console.error("[AI Scan] Caught error:", err);
      console.error("[AI Scan] Error message:", err.message);
      console.error("[AI Scan] Error stack:", err.stack);
      setMessage({ type: 'error', text: `Extraction failed: ${err.message}` });
    }
    setIsScanning(false);
  };

  const resetForm = (clearMessage = true) => {
    setCustomerName(''); setCustomerReferenceNumber(''); setOrderDate(today);
    setPaymentSlaDays(config.settings.defaultPaymentSlaDays);
    setAppliesWithholdingTax(false);
    setBlanketOrder(false);
    setBlanketContractId('');
    setContractId('');
    setTargetDeliveryDays(30);
    setTargetDeliveryDate(getDatePlusDays(today, 30));
    setOrderTaxPercent(DEFAULT_TAX_PERCENT);
    setCurrency(DEFAULT_CURRENCY);
    setConversionRate(1);
    setItems([{ id: 'temp_1', description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: DEFAULT_TAX_PERCENT, taxDetected: true, logs: [] }]);
    setEditingOrderId(null);
    if (clearMessage) setMessage(null);
    setIsNewCustomerCreated(false);
    setExternalSubmissionFile(null);
    setExternalSubmissionSnapshot(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editStatus.isFrozen) return;

    // Validate: every line item must have positive quantity, price and unit; components are also checked for new orders
    const validationErrors: string[] = [];
    items.forEach((item, idx) => {
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0) validationErrors.push(`Item ${idx + 1}: quantity must be greater than 0.`);
      const price = Number(item.pricePerUnit);
      if (!Number.isFinite(price) || price <= 0) validationErrors.push(`Item ${idx + 1}: unit price must be greater than 0.`);
      if (!item.unit || String(item.unit).trim() === '') validationErrors.push(`Item ${idx + 1}: unit is required.`);
      if (!editingOrderId) {
        (item.components || []).forEach((comp, cidx) => {
          const cQty = Number(comp.quantity);
          if (!Number.isFinite(cQty) || cQty <= 0) validationErrors.push(`Item ${idx + 1} component ${cidx + 1}: quantity must be greater than 0.`);
          const cost = Number(comp.unitCost);
          if (!Number.isFinite(cost) || cost <= 0) validationErrors.push(`Item ${idx + 1} component ${cidx + 1}: unit cost must be greater than 0.`);
          if (!comp.unit || String(comp.unit).trim() === '') validationErrors.push(`Item ${idx + 1} component ${cidx + 1}: unit is required.`);
        });
      }
    });
    if (validationErrors.length > 0) {
      setMessage({ type: 'error', text: validationErrors.join(' ') });
      return;
    }

    // Normalize quantities before sending
    const normalizedItems = items.map(item => ({ ...item, quantity: normalizeQty(item.quantity) }));

    try {
      const googleAutoUploadEnabled = !!config.settings.googleDriveConfig?.enabled && !!config.settings.googleDriveConfig?.autoUploadExternalSubmissions;
      const localAutoUploadEnabled = !!config.settings.localStorageConfig?.enabled && !!config.settings.localStorageConfig?.autoUploadExternalSubmissions;
      const hasAnyAutoUploadTarget = googleAutoUploadEnabled || localAutoUploadEnabled;
      const submissionFile = externalSubmissionFile || fileInputRef.current?.files?.[0] || null;
      const snapshotToFile = () => {
        if (!externalSubmissionSnapshot) return null;
        const binaryString = atob(externalSubmissionSnapshot.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new File([bytes], externalSubmissionSnapshot.name || 'external-submission.bin', {
          type: externalSubmissionSnapshot.type || 'application/octet-stream'
        });
      };
      const fallbackOrderFile = (orderLike: { internalOrderNumber?: string; customerReferenceNumber?: string; customerName?: string }) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const summary = {
          generatedAt: new Date().toISOString(),
          source: 'OrderManagementSubmitFallback',
          orderId: editingOrderId || null,
          internalOrderNumber: orderLike.internalOrderNumber || null,
          customerReferenceNumber: orderLike.customerReferenceNumber || customerReferenceNumber,
          customerName: orderLike.customerName || customerName,
          orderDate,
          paymentSlaDays,
          appliesWithholdingTax,
          blanketOrder,
          currency,
          conversionRate,
          targetDeliveryDays,
          targetDeliveryDate,
          items: normalizedItems
        };
        const fileName = `${orderLike.internalOrderNumber || 'order'}_${stamp}.json`;
        return new File([JSON.stringify(summary, null, 2)], fileName, { type: 'application/json' });
      };

      const summarizeUploadTargets = (targets: string[]) => {
        if (targets.length === 0) return 'no storage backends';
        return targets.map(target => target === 'localStorage' ? 'Local Storage' : 'Google Drive').join(' and ');
      };

      const tryStorageUpload = async (orderLike: { id?: string; internalOrderNumber?: string; customerReferenceNumber?: string; customerName?: string }) => {
        if (!hasAnyAutoUploadTarget) {
          return { attempted: false, uploadedTargets: [] as string[], errors: [] as Array<{ target: string; message: string }>, googleDrive: null as any };
        }
        const effectiveUploadFile = submissionFile || snapshotToFile() || fallbackOrderFile(orderLike);
        const uploaded = await dataService.uploadExternalSubmission(effectiveUploadFile, {
          orderId: orderLike.id,
          internalOrderNumber: orderLike.internalOrderNumber,
          customerReferenceNumber: orderLike.customerReferenceNumber,
          customerName: orderLike.customerName
        });
        return {
          attempted: true,
          uploadedTargets: uploaded.uploadedTargets || [],
          errors: uploaded.errors || [],
          googleDrive: uploaded.uploads?.googleDrive || null,
          localStorage: uploaded.uploads?.localStorage || null
        };
      };

      if (editingOrderId) {
        const updatedOrder = await dataService.updateOrder(editingOrderId, { customerName, customerReferenceNumber, orderDate, paymentSlaDays, appliesWithholdingTax, blanketOrder, blanketContractId, contractId, currency, conversionRate, items: normalizedItems as any });
        try {
          const uploadResult = await tryStorageUpload(updatedOrder as any);
          if (uploadResult.googleDrive?.webViewLink) {
              await dataService.updateOrder(updatedOrder.id, {
                googleDriveLink: uploadResult.googleDrive.webViewLink,
                googleDriveFileId: uploadResult.googleDrive.id,
                googleDriveFileName: uploadResult.googleDrive.name
              } as any);
          }

          if (uploadResult.uploadedTargets.length > 0) {
            const successText = submissionFile || externalSubmissionSnapshot
              ? `Record updated. Source file archived to ${summarizeUploadTargets(uploadResult.uploadedTargets)}.`
              : `Record updated. Order snapshot archived to ${summarizeUploadTargets(uploadResult.uploadedTargets)}.`;
            const errorText = uploadResult.errors.length > 0
              ? ` Upload issues: ${uploadResult.errors.map((entry: { target: string; message: string }) => `${entry.target}: ${entry.message}`).join(' | ')}`
              : '';
            setMessage({ type: uploadResult.errors.length > 0 ? 'info' : 'success', text: `${successText}${errorText}` });
          } else {
            setMessage({ type: 'success', text: 'Record updated.' });
          }
        } catch (driveError: any) {
          const errMsg = driveError?.message ? ` Upload failed: ${driveError.message}` : ' Upload failed.';
          setMessage({ type: 'error', text: `Record updated successfully.${errMsg}` });
          await fetchData();
          resetForm(false);
          return;
        }
      } else {
        // Prevent duplicate PO reference for the same customer on the frontend side
        const isDuplicate = existingOrders.some(o =>
          o.status !== 'REJECTED' &&
          o.customerReferenceNumber?.trim().toLowerCase() === customerReferenceNumber.trim().toLowerCase() &&
          o.customerName?.trim().toLowerCase() === customerName.trim().toLowerCase()
        );
        if (isDuplicate) {
          setMessage({ type: 'error', text: `Duplicate PO reference ${customerReferenceNumber} already exists for customer ${customerName}.` });
          return;
        }

        const newOrder = await dataService.addOrder({
          customerName,
          customerReferenceNumber,
          orderDate,
          paymentSlaDays,
          appliesWithholdingTax,
          blanketOrder,
          blanketContractId,
          contractId,
          currency,
          conversionRate,
          targetDeliveryDays: Number(targetDeliveryDays) || 0,
          targetDeliveryDate,
          items: normalizedItems as any
        });

        if (hasAnyAutoUploadTarget) {
          try {
            const uploadResult = await tryStorageUpload(newOrder as any);
            if (uploadResult.googleDrive?.webViewLink) {
              await dataService.updateOrder(newOrder.id, {
                googleDriveLink: uploadResult.googleDrive.webViewLink,
                googleDriveFileId: uploadResult.googleDrive.id,
                googleDriveFileName: uploadResult.googleDrive.name
              } as any);
            }

            const successText = uploadResult.uploadedTargets.length > 0
              ? `Acquisition committed: PO #${newOrder.customerReferenceNumber} logged as Internal ID: ${newOrder.internalOrderNumber}. Source file archived to ${summarizeUploadTargets(uploadResult.uploadedTargets)}.`
              : `Acquisition committed: PO #${newOrder.customerReferenceNumber} logged as Internal ID: ${newOrder.internalOrderNumber}.`;
            const errorText = uploadResult.errors.length > 0
              ? ` Upload issues: ${uploadResult.errors.map((entry: { target: string; message: string }) => `${entry.target}: ${entry.message}`).join(' | ')}`
              : '';
            setMessage({
              type: uploadResult.errors.length > 0 ? 'info' : 'success',
              text: `${successText}${errorText}`
            });
          } catch (driveError: any) {
            const errMsg = driveError?.message ? ` Upload failed: ${driveError.message}` : ' Upload failed.';
            setMessage({ type: 'error', text: `Order created successfully.${errMsg}` });
            await fetchData();
            resetForm();
            return;
          }
        } else {
          setMessage({ 
            type: 'success', 
            text: `Acquisition committed: PO #${newOrder.customerReferenceNumber} logged as Internal ID: ${newOrder.internalOrderNumber}` 
          });
        }
      }
      await fetchData();
      resetForm(false);
    } catch (err) {
      setMessage({ type: 'error', text: 'Transaction failed.' });
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

  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const finalId = contractFormId.trim() || `CON-${Math.floor(100000 + Math.random() * 900000)}`;
      await dataService.addContract({
        id: finalId,
        customerName: contractFormCustomerName.trim(),
        description: contractFormDescription.trim(),
        targetLineItems: contractFormTargetItems.trim(),
        receivedDate: contractFormReceivedDate,
        createdAt: new Date().toISOString()
      });
      setMessage({ type: 'success', text: `Contract "${finalId}" registered successfully.` });
      setContractFormId('');
      setContractFormCustomerName('');
      setContractFormDescription('');
      setContractFormTargetItems('');
      setContractFormReceivedDate(today);
      await fetchData();
      setBlanketSubTab('new_blanket');
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to create contract.' });
    }
  };

  const startStockOrder = () => {
    resetForm();
    setActiveTab('new');
    setCustomerName('Internal Stock');
    setCustomerReferenceNumber(`STOCK-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`);
    setOrderDate(today);
    setPaymentSlaDays(0);
    setAppliesWithholdingTax(false);
    setTargetDeliveryDays(30);
    setTargetDeliveryDate(getDatePlusDays(today, 30));
    setOrderTaxPercent(DEFAULT_TAX_PERCENT);
    setItems([{ id: 'temp_1', description: 'Stock Replenishment', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: DEFAULT_TAX_PERCENT, taxDetected: true, logs: [] }]);
    setMessage({ type: 'info', text: 'Internal Stock Order template loaded.' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteContract = async (id: string) => {
    if (!window.confirm(`Are you sure you want to delete contract template "${id}"?`)) return;
    try {
      await dataService.deleteContract(id);
      setMessage({ type: 'success', text: `Contract template "${id}" deleted successfully.` });
      await fetchData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to delete contract template.' });
    }
  };

  const startContractOrder = (c: any) => {
    resetForm();
    setCustomerName(c.customerName);
    setContractId(c.id);
    setBlanketOrder(true);
    setBlanketSubTab('new_blanket');
    setMessage({ type: 'info', text: `Contract template "${c.id}" pre-selected. Ready to log blanket order.` });
  };

  const contractColumns: ColumnDef<any>[] = [
    {
      key: 'id',
      label: 'Contract ID',
      sortable: true,
      sortValue: (c) => c.id,
      render: (c) => (
        <div>
          <span className="font-mono text-xs font-black text-teal-600 uppercase">{c.id}</span>
          <div className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">{c.description}</div>
        </div>
      )
    },
    {
      key: 'customerName',
      label: 'Customer Name',
      sortable: true,
      sortValue: (c) => c.customerName,
      render: (c) => <span className="font-bold text-slate-800 text-sm">{c.customerName}</span>
    },
    {
      key: 'settlingOrders',
      label: 'Settling Orders',
      sortable: true,
      sortValue: (c) => {
        const linked = existingOrders.filter(o => o.blanketOrder && o.contractId === c.id);
        return linked.length;
      },
      render: (c) => {
        const linked = existingOrders.filter(o => o.blanketOrder && o.contractId === c.id);
        return (
          <div className="space-y-1">
            {linked.length > 0 ? (
              <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 border border-indigo-100 rounded text-[9px] font-black uppercase inline-flex items-center gap-1">
                <i className="fa-solid fa-link"></i> {linked.length} Blanket Order{linked.length > 1 ? 's' : ''}
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 italic">No linked blanket orders</span>
            )}
            {linked.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {linked.map(bo => (
                  <span key={bo.id} className="text-[9px] font-mono font-bold bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">
                    {bo.internalOrderNumber}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }
    },
    {
      key: 'receivedDate',
      label: 'Contract Date',
      sortable: true,
      sortValue: (c) => c.receivedDate || c.createdAt || '',
      render: (c) => (
        <span className="text-xs font-bold text-slate-600">
          {new Date(c.receivedDate || c.createdAt || new Date()).toLocaleDateString()}
        </span>
      )
    },
    {
      key: 'actions',
      label: 'Action',
      sortable: false,
      render: (c) => (
        <div className="flex gap-2">
          <button
            onClick={() => startContractOrder(c)}
            className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-[9px] font-black uppercase flex items-center gap-1 transition-all"
            title="Create a Blanket Order referencing this contract"
          >
            <i className="fa-solid fa-plus"></i> Log Blanket
          </button>
          <button
            onClick={() => handleDeleteContract(c.id)}
            className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100 rounded-lg text-[9px] font-black uppercase flex items-center gap-1 transition-all"
            title="Delete this contract template"
          >
            <i className="fa-solid fa-trash-can"></i> Delete
          </button>
        </div>
      )
    }
  ];

  const sortedAndFilteredContracts = useMemo(() => {
    let result = [...contracts].sort((a, b) => {
      const da = new Date(a.receivedDate || a.createdAt || 0).getTime();
      const db = new Date(b.receivedDate || b.createdAt || 0).getTime();
      return da - db;
    });

    if (contractSearch.trim()) {
      const q = contractSearch.toLowerCase().trim();
      result = result.filter(c => {
        const linked = existingOrders.filter(o => o.blanketOrder && o.contractId === c.id);
        const linkedMatch = linked.some(bo => bo.internalOrderNumber?.toLowerCase().includes(q));
        const dateStr = new Date(c.receivedDate || c.createdAt || '').toLocaleDateString();
        return (
          c.id.toLowerCase().includes(q) ||
          c.customerName.toLowerCase().includes(q) ||
          (c.description || '').toLowerCase().includes(q) ||
          (c.targetLineItems || '').toLowerCase().includes(q) ||
          dateStr.includes(q) ||
          linkedMatch
        );
      });
    }

    return result;
  }, [contracts, contractSearch, existingOrders]);

  return (
    <div className="max-w-[1200px] mx-auto pb-12 space-y-6">
      <div className="flex gap-1 p-1 bg-slate-200 rounded-xl w-fit shadow-inner overflow-x-auto">
        <button
          onClick={() => { setActiveTab('new'); resetForm(); }}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 whitespace-nowrap ${activeTab === 'new' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <i className="fa-solid fa-plus"></i> New Orders
        </button>
        <button
          onClick={() => { setActiveTab('blanket'); resetForm(); setBlanketOrder(true); }}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 whitespace-nowrap ${activeTab === 'blanket' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
        >
          <i className="fa-solid fa-file-contract"></i> Blanket Orders
        </button>
        <button
          onClick={startStockOrder}
          className={`px-8 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 whitespace-nowrap text-slate-500 hover:text-emerald-600 hover:bg-emerald-50`}
        >
          <i className="fa-solid fa-boxes-stacked"></i> Order for Stock
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

      </div>

      {activeTab === 'blanket' && (
        <div className="flex gap-2 p-1 bg-slate-100 rounded-xl w-fit shadow-inner">
          <button
            onClick={() => { setBlanketSubTab('new_blanket'); resetForm(); setBlanketOrder(true); }}
            className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${blanketSubTab === 'new_blanket' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            New Blanket Order
          </button>
          <button
            onClick={() => setBlanketSubTab('new_contract')}
            className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${blanketSubTab === 'new_contract' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            New Contract
          </button>
          <button
            onClick={() => setBlanketSubTab('logged_contracts')}
            className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${blanketSubTab === 'logged_contracts' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            Logged Contracts
          </button>
        </div>
      )}

      {activeTab === 'new' || (activeTab === 'blanket' && blanketSubTab === 'new_blanket') ? (
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
              {editStatus.isFrozen && <button onClick={() => resetForm()} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-[10px] font-black uppercase">Start Fresh</button>}
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
                <button onClick={() => resetForm()} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-[10px] font-black uppercase hover:bg-slate-50">Create New</button>
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
                        const newName = e.target.value;
                        setCustomerName(newName);
                        setIsNewCustomerCreated(false);
                        const matchCust = customers.find(c => c.name.toLowerCase() === newName.toLowerCase());
                        if (matchCust && matchCust.appliesWithholdingTax !== undefined) {
                          setAppliesWithholdingTax(matchCust.appliesWithholdingTax);
                        }
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
                      max={new Date().toISOString().split('T')[0]} // HTML5 constraint
                      className={`w-full p-4 border-2 rounded-2xl outline-none font-bold transition-all shadow-inner ${new Date(orderDate) > new Date(new Date().toISOString().split('T')[0])
                        ? 'bg-rose-50 border-rose-200 text-rose-600 focus:border-rose-400'
                        : 'bg-slate-50 border-slate-100 focus:bg-white focus:border-blue-500'
                        }`}
                      value={orderDate}
                      onChange={e => {
                        const newPoDate = e.target.value;
                        setOrderDate(newPoDate);
                        if (deliveryInputMode === 'days') {
                          const d = new Date(newPoDate);
                          d.setDate(d.getDate() + (Number(targetDeliveryDays) || 0));
                          setTargetDeliveryDate(d.toISOString().split('T')[0]);
                        } else {
                          const start = new Date(newPoDate);
                          const end = new Date(targetDeliveryDate);
                          const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                          setTargetDeliveryDays(diff);
                        }
                      }}
                      required
                    />
                    {new Date(orderDate) > new Date(new Date().toISOString().split('T')[0]) && (
                      <div className="text-[9px] font-black text-rose-500 uppercase tracking-widest ml-1 flex items-center gap-1 animate-pulse">
                        <i className="fa-solid fa-circle-exclamation"></i> Future dates are not allowed
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 col-span-1 md:col-span-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 flex justify-between">
                      <span>Target Delivery</span>
                      <div className="flex bg-slate-200 rounded-lg p-0.5 gap-1">
                        <button type="button" onClick={() => setDeliveryInputMode('days')} className={`px-2 py-0.5 rounded-md text-[8px] transition-all ${deliveryInputMode === 'days' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'}`}>DAYS</button>
                        <button type="button" onClick={() => setDeliveryInputMode('date')} className={`px-2 py-0.5 rounded-md text-[8px] transition-all ${deliveryInputMode === 'date' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-500'}`}>DATE</button>
                      </div>
                    </label>

                    {deliveryInputMode === 'days' ? (
                      <div className="relative">
                        <input
                          disabled={editStatus.isFrozen}
                          type="number"
                          className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner pr-16"
                          value={targetDeliveryDays}
                          onChange={e => {
                            const val = e.target.value === '' ? '' : parseInt(e.target.value);
                            setTargetDeliveryDays(val);
                            if (val !== '' && orderDate) {
                              const d = new Date(orderDate);
                              d.setDate(d.getDate() + val);
                              setTargetDeliveryDate(d.toISOString().split('T')[0]);
                            }
                          }}
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black text-slate-300 uppercase">Days</div>
                      </div>
                    ) : (
                      <input
                        disabled={editStatus.isFrozen}
                        type="date"
                        className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                        value={targetDeliveryDate}
                        onChange={e => {
                          const val = e.target.value;
                          setTargetDeliveryDate(val);
                          if (val && orderDate) {
                            const start = new Date(orderDate);
                            const end = new Date(val);
                            const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                            setTargetDeliveryDays(diff);
                          }
                        }}
                      />
                    )}

                    <div className="px-2 pt-1 flex justify-between items-center opacity-60">
                      <span className="text-[9px] font-bold text-slate-400 uppercase">
                        {deliveryInputMode === 'days' ? `Scheduled: ${targetDeliveryDate}` : `Calculated: ${targetDeliveryDays} Days`}
                      </span>
                    </div>
                  </div>

                  {/* Compact fields row: Payment SLA, Tax %, Currency (unchanged sizes/positions) */}
                  <div className="flex flex-row gap-4 items-start">
                    <div className="flex-2 space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Payment SLA (Days)</label>
                      <input
                        disabled={editStatus.isFrozen}
                        type="number"
                        className="w-full p-2.5 border-2 border-slate-100 rounded-xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                        placeholder="e.g. 30"
                        value={paymentSlaDays}
                        onChange={e => setPaymentSlaDays(parseInt(e.target.value) || 0)}
                        required
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Tax %</label>
                      <input
                        disabled={editStatus.isFrozen}
                        type="number"
                        step="any"
                        className="w-full p-2.5 border-2 border-slate-100 rounded-xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner text-center"
                        value={orderTaxPercent}
                        onChange={e => setOrderTaxPercent(parseFloat(e.target.value) || 0)}
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Currency</label>
                      <select
                        disabled={editStatus.isFrozen}
                        className="w-full p-2.5 border-2 border-slate-100 rounded-xl bg-slate-50 outline-none focus:bg-white focus:border-blue-500 font-bold transition-all shadow-inner"
                        value={currency}
                        onChange={e => setCurrency(e.target.value as Currency)}
                        title="Order currency. Prices on this order are denominated in this currency. Defaults to L.E."
                      >
                        {SUPPORTED_CURRENCIES.map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {/* Blanket Contract ID select (rendered only inside blanket orders tab) */}
                  {activeTab === 'blanket' && (
                    <div className="flex flex-row gap-4 items-start">
                      <div className="flex-2 space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Linked Contract Reference</label>
                        <select
                          disabled={editStatus.isFrozen}
                          className="w-full p-2.5 border-2 border-slate-100 rounded-xl bg-slate-50 outline-none focus:bg-white focus:border-indigo-500 font-bold transition-all shadow-inner"
                          value={contractId}
                          onChange={e => setContractId(e.target.value)}
                        >
                          <option value="">— None (No Contract Linked) —</option>
                          {contracts
                            .filter(c => c.customerName.trim().toLowerCase() === customerName.trim().toLowerCase())
                            .map(c => (
                              <option key={c.id} value={c.id}>{c.id} — {c.customerName}</option>
                            ))}
                        </select>
                        {customerName.trim() === '' ? (
                          <div className="text-[9px] font-black text-amber-600 uppercase tracking-widest ml-1 flex items-center gap-1 mt-1">
                            <i className="fa-solid fa-triangle-exclamation"></i> Please enter/select a customer name to filter available contracts.
                          </div>
                        ) : contracts.filter(c => c.customerName.trim().toLowerCase() === customerName.trim().toLowerCase()).length === 0 ? (
                          <div className="text-[9px] font-black text-rose-500 uppercase tracking-widest ml-1 flex items-center gap-1 mt-1">
                            <i className="fa-solid fa-circle-xmark"></i> No logged contracts found for customer "{customerName}".
                          </div>
                        ) : null}
                        {contractId && (
                          <div className="text-[9px] font-black text-teal-600 uppercase tracking-widest ml-1 flex items-center gap-1 animate-pulse mt-1">
                            <i className="fa-solid fa-link"></i> Linked to contract reference {contractId}.
                          </div>
                        )}
                      </div>
                      <div className="flex-1"></div>
                    </div>
                  )}
                </div>

                <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl flex items-start gap-4">
                  <div className="flex-1">
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        disabled={editStatus.isFrozen}
                        type="checkbox"
                        className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500"
                        checked={appliesWithholdingTax}
                        onChange={e => setAppliesWithholdingTax(e.target.checked)}
                      />
                      <span className="text-sm font-bold text-slate-800">Apply 1% Withholding Tax Deduction for this Order</span>
                    </label>
                    <p className="text-xs text-slate-500 mt-1 pl-8 font-medium">If enabled, the customer is expected to pay exactly 99% of the PO value, plus provide a WHT certificate in the Finance module.</p>
                  </div>
                  <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center text-indigo-500 shrink-0">
                    <i className="fa-solid fa-file-invoice-dollar"></i>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Transaction Line Items</h4>
                  </div>
                  {items.map((item, idx) => {
                    const lineTotal = (Number(item.quantity) || 1) * (Number(item.pricePerUnit) || 0);
                    return (
                      <div key={item.id} className="p-6 bg-slate-50/50 rounded-3xl border border-slate-100 group hover:border-blue-200 transition-all">
                        <div className="flex flex-col lg:flex-row gap-4">
                          <div className="flex-[3] space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Part/Service Description</label>
                            <input disabled={editStatus.isFrozen} className="w-full p-3 border-2 border-white rounded-xl bg-white font-bold outline-none focus:border-blue-500 transition-all shadow-sm" value={item.description} onChange={e => { const n = [...items]; n[idx].description = e.target.value; setItems(n); }} required />
                          </div>
                          <div className="flex-1 space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Quantity</label>
                            <input disabled={editStatus.isFrozen} type="number" step="any" className="w-full p-3 border-2 border-white rounded-xl bg-white font-bold text-center shadow-sm" value={item.quantity} onChange={e => { const n = [...items]; n[idx].quantity = parseFloat(e.target.value) || 1; setItems(n); }} onBlur={e => { const n = [...items]; n[idx].quantity = parseFloat(e.target.value) || 1; setItems(n); }} />
                          </div>
                          <div className="flex-1 space-y-1.5">
                            <label className="text-9px font-black text-slate-400 uppercase">Unit price ({currency})</label>
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
                     <div className="space-y-4">
                       <button type="button" onClick={() => setItems([...items, { id: `temp_${Date.now()}`, description: '', quantity: 1, unit: 'pcs', pricePerUnit: 0, taxPercent: orderTaxPercent, taxDetected: true, logs: [] }])} className="px-6 py-3 bg-white border border-blue-100 text-blue-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-50 transition-all flex items-center gap-2">
                         <i className="fa-solid fa-plus"></i> Append Line Item
                       </button>
                     </div>
                   )}
                 </div>

                <div className="bg-slate-900 p-10 rounded-[3rem] text-white flex flex-col lg:flex-row justify-between items-center gap-10 shadow-2xl relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 opacity-5"><i className="fa-solid fa-coins text-9xl"></i></div>
                  <div className="flex flex-col md:flex-row gap-12 relative z-10">
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest">Subtotal Value</div><div className="text-3xl font-black">{totals.subtotal.toLocaleString()} <span className="text-sm opacity-30">{currency}</span></div></div>
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest text-rose-400">Total Tax</div><div className="text-3xl font-black text-rose-400">{totals.taxTotal.toLocaleString()}</div></div>
                    <div><div className="text-[10px] opacity-40 uppercase font-black tracking-widest text-emerald-400">Grand Transaction Total</div><div className="text-4xl font-black text-emerald-400">{totals.total.toLocaleString()}</div></div>
                  </div>
                  <button
                    disabled={editStatus.isFrozen || new Date(orderDate) > new Date(new Date().toISOString().split('T')[0])}
                    type="submit"
                    className={`px-16 py-5 rounded-3xl font-black uppercase text-sm tracking-[0.2em] transition-all active:scale-95 shadow-xl relative z-10 ${editStatus.isFrozen || new Date(orderDate) > new Date(new Date().toISOString().split('T')[0])
                      ? 'bg-slate-700 text-slate-500 cursor-not-allowed opacity-50'
                      : (editingOrderId ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700')
                      }`}
                  >
                    {editStatus.isFrozen ? 'LOCKED' : (editingOrderId ? 'Save Modification' : 'Commit Acquisition')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : (activeTab === 'blanket' && blanketSubTab === 'new_contract') ? (
        <div className="animate-in fade-in duration-500">
          <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden">
            <div className="p-6 bg-slate-50 border-b flex justify-between items-center">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-teal-600 flex items-center justify-center text-white shadow-lg">
                  <i className="fa-solid fa-file-contract text-xl"></i>
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Contract Registry Terminal</h2>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Define new framework contract agreements</p>
                </div>
              </div>
            </div>

            <div className="p-8">
              {message && (
                <div className={`mb-6 p-4 rounded-2xl border flex items-center gap-3 animate-in slide-in-from-top-4 ${message.type === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-rose-50 border-rose-100 text-rose-700'}`}>
                  <i className={`fa-solid ${message.type === 'success' ? 'fa-circle-check' : 'fa-triangle-exclamation'}`}></i>
                  <span className="text-xs font-bold uppercase">{message.text}</span>
                </div>
              )}

              <form onSubmit={handleCreateContract} className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Contract ID (Optional)</label>
                    <div className="text-[9px] text-slate-400 font-bold ml-1 uppercase">Leave blank to auto-generate a unique ID (e.g. CON-123456)</div>
                    <input
                      type="text"
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-teal-500 font-bold transition-all shadow-inner"
                      placeholder="e.g. CON-2026-08"
                      value={contractFormId}
                      onChange={e => setContractFormId(e.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Customer Name</label>
                    <div className="text-[9px] text-slate-400 font-bold ml-1 uppercase">Select target client from CRM</div>
                    <select
                      required
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-teal-500 font-bold transition-all shadow-inner"
                      value={contractFormCustomerName}
                      onChange={e => setContractFormCustomerName(e.target.value)}
                    >
                      <option value="">— Select Customer —</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Received Date</label>
                    <div className="text-[9px] text-slate-400 font-bold ml-1 uppercase">Date the contract was received</div>
                    <input
                      type="date"
                      required
                      className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-teal-500 font-bold transition-all shadow-inner"
                      value={contractFormReceivedDate}
                      onChange={e => setContractFormReceivedDate(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Contract Description</label>
                  <textarea
                    required
                    rows={4}
                    className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-teal-500 font-bold transition-all shadow-inner"
                    placeholder="Enter detailed scope, terms, and agreements..."
                    value={contractFormDescription}
                    onChange={e => setContractFormDescription(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Contract Target Line Items</label>
                  <textarea
                    required
                    rows={3}
                    className="w-full p-4 border-2 border-slate-100 rounded-2xl bg-slate-50 outline-none focus:bg-white focus:border-teal-500 font-bold transition-all shadow-inner"
                    placeholder="Describe target items, volumes, and quantities..."
                    value={contractFormTargetItems}
                    onChange={e => setContractFormTargetItems(e.target.value)}
                  />
                </div>

                <div className="pt-4">
                  <button
                    type="submit"
                    className="px-12 py-4 bg-teal-600 hover:bg-teal-700 text-white rounded-3xl font-black uppercase text-xs tracking-wider transition-all active:scale-95 shadow-xl shadow-teal-100"
                  >
                    Register Contract Template
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : (activeTab === 'blanket' && blanketSubTab === 'logged_contracts') ? (
        <div className="animate-in fade-in duration-500">
          <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden min-h-[50vh]">
            <div className="p-6 bg-slate-50 border-b flex justify-between items-center flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-teal-600 flex items-center justify-center text-white shadow-lg">
                  <i className="fa-solid fa-file-contract text-xl"></i>
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Logged Contracts</h2>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">View framework contracts and linked blanket order references</p>
                </div>
              </div>
              {/* Search Box */}
              <div className="relative w-full md:w-80">
                <input
                  type="text"
                  className="w-full pl-10 pr-4 py-2 border-2 border-slate-100 rounded-xl bg-slate-50 text-xs font-bold outline-none focus:bg-white focus:border-teal-500 transition-all shadow-inner"
                  placeholder="Search contract ID, customer, etc..."
                  value={contractSearch}
                  onChange={e => setContractSearch(e.target.value)}
                />
                <i className="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-slate-400 text-xs"></i>
              </div>
            </div>

            <div className="overflow-x-auto">
              <SortableTable
                columns={contractColumns}
                data={sortedAndFilteredContracts}
                rowKey={(c) => c.id}
                emptyMessage="No logged contracts found"
                storageKey="order-logged-contracts-table"
              />
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
                    <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('id')}>
                      Internal Ref / PO Ref <SortIcon column="id" />
                    </th>
                    <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('orderDate')}>
                      PO Received <SortIcon column="orderDate" />
                    </th>
                    <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('dataEntryTimestamp')}>
                      Submitted Into The System <SortIcon column="dataEntryTimestamp" />
                    </th>
                    <th className="px-8 py-5">
                      Last Edited
                    </th>
                    <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('customer')}>
                      Customer Entity <SortIcon column="customer" />
                    </th>
                    <th className="px-8 py-5 cursor-pointer group hover:text-blue-600 transition-colors" onClick={() => requestSort('lineCount')}>
                      Lines <SortIcon column="lineCount" />
                    </th>
                    <th className="px-8 py-5 text-right">Action</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-50">
                  {loggedOrders.map(draft => (

                    <tr key={draft.id} className={`hover:bg-slate-50/80 transition-all group ${draft.loggingComplianceViolation ? 'bg-rose-50 hover:!bg-rose-100 border-l-4 border-rose-500' : ''} ${draft.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-rose-50/30 hover:!bg-rose-50 border-l-4 border-rose-400' : ''}`}>

                      <td className="px-8 py-6">
                        <div className="font-mono text-xs font-black text-blue-600 uppercase">{draft.internalOrderNumber}</div>
                        <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">PO: {draft.customerReferenceNumber || 'N/A'}</div>
                        {draft.loggingComplianceViolation && <div className="mt-1"><span className="text-[9px] font-black text-rose-600 bg-rose-100 px-1.5 py-0.5 rounded border border-rose-200 uppercase tracking-wider">Logging Delay</span></div>}
                        {draft.status === OrderStatus.NEGATIVE_MARGIN && <div className="mt-1"><span className="text-[9px] font-black text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded border border-rose-300 uppercase tracking-wider">Negative Margin</span></div>}
                      </td>
                      <td className="px-8 py-6 text-xs text-slate-700 font-black">
                        {draft.orderDate ? new Date(draft.orderDate).toLocaleDateString() : 'N/A'}
                      </td>
                      <td className="px-8 py-6 text-[10px] text-slate-500 font-bold uppercase">
                        {formatOrderTimestamp(draft.dataEntryTimestamp)}
                        <div className="text-[8px] opacity-60 normal-case">by {getSubmittedBy(draft)}</div>
                      </td>
                      <td className="px-8 py-6 text-[10px] text-slate-500 font-bold uppercase">
                        {(() => {
                          const lastEdited = getLastEditedInfo(draft);
                          return (
                            <>
                              {formatOrderTimestamp(lastEdited.timestamp)}
                              <div className="text-[8px] opacity-60 normal-case">by {lastEdited.user}</div>
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-8 py-6 font-black text-slate-800">{draft.customerName}</td>

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
                      <td colSpan={6} className="px-8 py-20 text-center">

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
      ) : null}

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


    </div>
  );
};
