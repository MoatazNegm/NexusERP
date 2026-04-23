
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { dataService } from '../services/dataService';
import { CustomerOrder, CustomerOrderItem, ManufacturingComponent, Supplier, OrderStatus, AppConfig, CompStatus, User, getItemEffectiveStatus } from '../types';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { PartHistory } from './PartHistory';

// Converts SVG data URL to PNG data URL for html2canvas compatibility
const rasterizeLogo = (logoDataUrl: string): Promise<string> => {
  return new Promise((resolve) => {
    if (!logoDataUrl || !logoDataUrl.startsWith('data:image/svg')) {
      resolve(logoDataUrl); // Already raster or empty
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Set high resolution (2000px width) while maintaining aspect ratio
      const targetWidth = 1000;
      const ratio = (img.naturalHeight / img.naturalWidth) || 0.5;
      canvas.width = targetWidth;
      canvas.height = targetWidth * ratio;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff'; // Ensure white background for transparency conversion
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } else {
        resolve(logoDataUrl);
      }
    };
    img.onerror = () => resolve(logoDataUrl);
    img.src = logoDataUrl;
  });
};

const sanitizeFileName = (value: string) => {
  return value
    .replace(/[\/\?%\*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120)
    .replace(/^-+|-+$/g, '');
};

/**
 * Binary PO-readiness gate (the "0/1" approach).
 * Returns true (1) if a component has reached or passed the Issue PO stage.
 * Returns false (0) for the only two "pre-PO" statuses.
 * This eliminates the need for ever-growing status whitelists — any new
 * status added to the lifecycle is automatically treated as "past PO".
 */
const hasReachedPoReadiness = (status: string | undefined): boolean => {
  if (!status) return false;
  // Only these two statuses mean the component hasn't reached PO yet
  return !['PENDING_OFFER', 'RFP_SENT'].includes(status);
};

/**
 * Calculate contract end date based on start date and duration
 * Duration format: "12 Months" or "1 Years"
 */
const calculateContractEndDate = (startDate: string, duration: string): Date | null => {
  if (!startDate || !duration) return null;
  
  try {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) return null;
    
    // Parse duration string (e.g., "12 Months" or "1 Years")
    const durationMatch = duration.match(/(\d+)\s*(Month|Year)s?/i);
    if (!durationMatch) return null;
    
    const amount = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    
    const end = new Date(start);
    if (unit === 'month') {
      end.setMonth(end.getMonth() + amount);
    } else if (unit === 'year') {
      end.setFullYear(end.getFullYear() + amount);
    }
    
    return end;
  } catch {
    return null;
  }
};

interface ProcurementModuleProps {
  config: AppConfig;
  refreshKey?: number;
  currentUser: User;
}

const getCompLimit = (status: CompStatus, settings: any) => {
  switch (status) {
    case 'PENDING_OFFER': return settings.pendingOfferLimitHrs;
    case 'RFP_SENT': return settings.rfpSentLimitHrs;
    case 'AWARDED': return settings.issuePoLimitHrs;
    case 'ORDERED': return settings.orderedLimitHrs;
    case 'WAITING_CONTRACT_START': return settings.orderedLimitHrs;
    default: return 0;
  }
};

const CompThreshold: React.FC<{ component: ManufacturingComponent, config: AppConfig }> = ({ component, config }) => {
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    const calc = () => {
      const limitHrs = getCompLimit(component.status, config.settings);
      if (limitHrs === 0) return;
      const startTime = new Date(component.statusUpdatedAt || component.procurementStartedAt || new Date().toISOString()).getTime();
      const elapsedMs = Date.now() - startTime;
      setRemaining((limitHrs * 3600000) - elapsedMs);
    };
    calc();
    const timer = setInterval(calc, 60000);
    return () => clearInterval(timer);
  }, [component.status, component.statusUpdatedAt, config.settings]);

  const limitHrs = getCompLimit(component.status, config.settings);
  if (limitHrs === 0) return null;

  const isOver = remaining < 0;
  const absRemaining = Math.abs(remaining);
  const hrs = Math.floor(absRemaining / 3600000);
  const mins = Math.floor((absRemaining % 3600000) / 60000);
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

  return (
    <div className={`text-[9px] font-black uppercase flex items-center gap-1.5 mt-2 ${isOver ? 'text-rose-500 animate-pulse' : 'text-slate-400'}`}>
      <i className={`fa-solid ${isOver ? 'fa-triangle-exclamation' : 'fa-clock'}`}></i>
      {isOver ? `Over Sourcing SLA by ${timeStr}` : `SLA: ${timeStr} left`}
    </div>
  );
};

export const ProcurementModule: React.FC<ProcurementModuleProps> = ({ config, refreshKey, currentUser }) => {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [activeTab, setActiveTab] = useState<'purchases' | 'outsourcing' | 'history'>('purchases');
  const [isActionLoading, setIsActionLoading] = useState<string | null>(null);
  const poTemplateRef = useRef<HTMLDivElement>(null);
  const [poPrintData, setPoPrintData] = useState<{ order: CustomerOrder, items: { item: CustomerOrderItem, comp: ManufacturingComponent }[], supplier: Supplier } | null>(null);
  const [isPoPdfGenerating, setIsPoPdfGenerating] = useState<boolean>(false);
  const [rasterizedLogo, setRasterizedLogo] = useState<string>('');

  // Pre-rasterize SVG logo to PNG for html2canvas compatibility
  useEffect(() => {
    if (config.settings.companyLogo) {
      rasterizeLogo(config.settings.companyLogo).then(setRasterizedLogo);
    }
  }, [config.settings.companyLogo]);

  // Modal States
  const [activeAction, setActiveAction] = useState<{
    type: 'RFP' | 'AWARD' | 'PO' | 'RESET' | 'ORDER_ROLLBACK' | 'CANCEL_PO_BATCH' | 'REVIVE_CONTRACT';
    order: CustomerOrder;
    item?: CustomerOrderItem;
    comp?: ManufacturingComponent;
  } | null>(null);

  const [rfpSelection, setRfpSelection] = useState<string[]>([]);
  const [rfpCompSelection, setRfpCompSelection] = useState<string[]>([]); // For multi-component RFP PDF
  const [rfpTemplateRef, rfpPrintData, setRfpPrintData] = [useRef<HTMLDivElement>(null), ...useState<{ order: CustomerOrder, comps: ManufacturingComponent[] } | null>(null)];
  const [isDownloadingRfp, setIsDownloadingRfp] = useState(false);
  const companyName = config.settings.companyName || 'Nexus ERP';
  const companyNameHasArabic = /[\u0600-\u06FF]/.test(companyName);
  const [awardSupplierId, setAwardSupplierId] = useState<string>('');
  const [awardCosts, setAwardCosts] = useState<Record<string, string>>({});
  const [awardTaxPercent, setAwardTaxPercent] = useState<string>('14');
  const [poNumberInput, setPoNumberInput] = useState<string>('');
  const [contractNumber, setContractNumber] = useState<string>('');
  const [contractStartDate, setContractStartDate] = useState<string>('');
  const [allowPastContractStart, setAllowPastContractStart] = useState<boolean>(false);
  const [resetReason, setResetReason] = useState<string>('');
  
  // Replacement Request Modal States
  const [replacementModalInfo, setReplacementModalInfo] = useState<{order: CustomerOrder, item: CustomerOrderItem, comp: ManufacturingComponent} | null>(null);
  const [replacementReason, setReplacementReason] = useState<string>('');
  const [replacementStartDate, setReplacementStartDate] = useState<string>('');
  const [updateAllContractDates, setUpdateAllContractDates] = useState<boolean>(false);
  const [replacementDateError, setReplacementDateError] = useState<string>('');
  const replacementTemplateRef = useRef<HTMLDivElement>(null);
  const [isReplacementPdfGenerating, setIsReplacementPdfGenerating] = useState<boolean>(false);
  
  // Revive Contract States
  const [reviveReason, setReviveReason] = useState<string>('');
  const [reviveDuration, setReviveDuration] = useState<string>('');
  const [reviveMode, setReviveMode] = useState<'EXTENSION' | 'END_DATE'>('EXTENSION');
  const [reviveEndDate, setReviveEndDate] = useState<string>('');
  
  const deriveOutsourcingContractInfo = (components: { item: CustomerOrderItem; comp: ManufacturingComponent }[]) => {
    const outsourcingComp = components.find(({ item, comp }) => item.productionType === 'OUTSOURCING' && (comp.contractNumber || comp.componentNumber || comp.contractStartDate));
    return {
      contractNumber: outsourcingComp?.comp.contractNumber || outsourcingComp?.comp.componentNumber || '',
      contractStartDate: outsourcingComp?.comp.contractStartDate || ''
    };
  };
  const [compHistory, setCompHistory] = useState<any[] | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [selectedCompIds, setSelectedCompIds] = useState<string[]>([]);
  const [multiComps, setMultiComps] = useState<{ item: CustomerOrderItem, comp: ManufacturingComponent }[]>([]);

  // Computed values for contract date validation
  const today = new Date().toISOString().split('T')[0];
  const selectedOutsourced = multiComps.some(({ item: mi, comp: mc }) => selectedCompIds.includes(mc.id!) && mi.productionType === 'OUTSOURCING');
  const isContractStartDateInvalid = selectedOutsourced && contractStartDate.trim() && contractStartDate < today && !allowPastContractStart;
  const isCommitProcurementDisabled = isActionLoading != null || ((activeAction?.type === 'RESET' || activeAction?.type === 'ORDER_ROLLBACK' || activeAction?.type === 'CANCEL_PO_BATCH') && !resetReason.trim()) || (activeAction?.type === 'REVIVE_CONTRACT' && (!reviveReason.trim() || (reviveMode === 'EXTENSION' ? !reviveDuration.trim() : !reviveEndDate.trim()))) || (activeAction?.type === 'PO' && (!poNumberInput.trim() || selectedCompIds.length === 0 || (selectedOutsourced && !contractStartDate.trim()) || isContractStartDateInvalid));

  // Procurement resolution state (for in-transit components during rollback)
  type CompResolution = 'CANCEL_PO' | 'RECEIVE_TO_STOCK';
  interface InTransitCompRecord {
    itemId: string;
    itemDesc: string;
    compId: string;
    compDesc: string;
    componentNumber?: string;
    supplierName?: string;
    quantity: number;
    status: string;
  }
  const [pendingResolutions, setPendingResolutions] = useState<InTransitCompRecord[] | null>(null);
  const [resolutionChoices, setResolutionChoices] = useState<Record<string, CompResolution>>({});
  const [pendingRollbackOrder, setPendingRollbackOrder] = useState<CustomerOrder | null>(null);
  const [allOrders, setAllOrders] = useState<CustomerOrder[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string, direction: 'asc' | 'desc' }>({ key: 'orderDate', direction: 'asc' });


  useEffect(() => { fetchData(); }, [refreshKey]);

  const fetchData = async () => {
    const [o, s] = await Promise.all([dataService.getOrders(), dataService.getSuppliers()]);
    setAllOrders(o);
    const eligibleOrders = o.filter(order => [
      OrderStatus.WAITING_SUPPLIERS, 
      OrderStatus.NEGATIVE_MARGIN, 
      OrderStatus.TECHNICAL_REVIEW,
      OrderStatus.WAITING_FACTORY,
      OrderStatus.MANUFACTURING
    ].includes(order.status));
    setOrders(eligibleOrders);
    setSuppliers(s);
  };

  // Group procurement components by order, split by productionType
  const purchaseGroups = useMemo(() => {
    const map = new Map<string, { order: CustomerOrder, comps: { item: CustomerOrderItem, comp: ManufacturingComponent }[] }>();
    orders.forEach(o => {
      o.items.forEach(i => {
        if (i.productionType === 'OUTSOURCING') return; // Skip in this tab
        i.components?.forEach(c => {
          if (c.source === 'PROCUREMENT' && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED'].includes(c.status || '')) {
            if (!map.has(o.id)) map.set(o.id, { order: o, comps: [] });
            map.get(o.id)!.comps.push({ item: i, comp: c });
          }
        });
      });
    });
    
    return Array.from(map.values()).sort((a, b) => {
      let aVal: any = '';
      let bVal: any = '';
      switch (sortConfig.key) {
        case 'internalOrderNumber': aVal = a.order.internalOrderNumber || ''; bVal = b.order.internalOrderNumber || ''; break;
        case 'orderDate': aVal = a.order.orderDate || a.order.dataEntryTimestamp || ''; bVal = b.order.orderDate || b.order.dataEntryTimestamp || ''; break;
        case 'customer': aVal = a.order.customerName || ''; bVal = b.order.customerName || ''; break;
        case 'customerReferenceNumber': aVal = a.order.customerReferenceNumber || ''; bVal = b.order.customerReferenceNumber || ''; break;
        default: aVal = a.order.orderDate || a.order.dataEntryTimestamp || ''; bVal = b.order.orderDate || b.order.dataEntryTimestamp || '';
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [orders, sortConfig]);

  const outsourcingGroups = useMemo(() => {
    const map = new Map<string, { order: CustomerOrder, comps: { item: CustomerOrderItem, comp: ManufacturingComponent }[] }>();
    orders.forEach(o => {
      o.items.forEach(i => {
        if (i.productionType !== 'OUTSOURCING') return; // Skip in this tab
        i.components?.forEach(c => {
          if (c.source === 'PROCUREMENT' && ['PENDING_OFFER', 'RFP_SENT', 'AWARDED', 'ORDERED', 'WAITING_CONTRACT_START', 'RECEIVED', 'RESERVED', 'IN_MANUFACTURING', 'MANUFACTURED'].includes(c.status || '')) {
            // Auto-cleanup: If contract end date passed more than 1 month ago, treat as finished and remove from active list
            if (c.contractStartDate && c.contractDuration) {
              const endDate = calculateContractEndDate(c.contractStartDate, c.contractDuration);
              if (endDate) {
                const oneMonthLater = new Date(endDate);
                oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
                if (new Date() > oneMonthLater) return; // Skip old items
              }
            }
            if (!map.has(o.id)) map.set(o.id, { order: o, comps: [] });
            map.get(o.id)!.comps.push({ item: i, comp: c });
          }
        });
      });
    });
    
    return Array.from(map.values()).sort((a, b) => {
      let aVal: any = '';
      let bVal: any = '';
      switch (sortConfig.key) {
        case 'internalOrderNumber': aVal = a.order.internalOrderNumber || ''; bVal = b.order.internalOrderNumber || ''; break;
        case 'orderDate': aVal = a.order.orderDate || a.order.dataEntryTimestamp || ''; bVal = b.order.orderDate || b.order.dataEntryTimestamp || ''; break;
        case 'customer': aVal = a.order.customerName || ''; bVal = b.order.customerName || ''; break;
        case 'customerReferenceNumber': aVal = a.order.customerReferenceNumber || ''; bVal = b.order.customerReferenceNumber || ''; break;
        default: aVal = a.order.orderDate || a.order.dataEntryTimestamp || ''; bVal = b.order.orderDate || b.order.dataEntryTimestamp || '';
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [orders, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ column }: { column: string }) => {
    if (sortConfig.key !== column) return <i className="fa-solid fa-sort ml-2 opacity-20"></i>;
    return <i className={`fa-solid fa-sort-${sortConfig.direction === 'asc' ? 'up' : 'down'} ml-2 text-blue-600`}></i>;
  };


  const totalComponents = purchaseGroups.reduce((sum, g) => sum + g.comps.length, 0) + outsourcingGroups.reduce((sum, g) => sum + g.comps.length, 0);

  const awardSuppliersList = useMemo(() => {
    if (activeAction?.type === 'AWARD' && activeAction.comp?.rfpSupplierIds?.length) {
      return suppliers.filter(s => activeAction.comp?.rfpSupplierIds?.includes(s.id));
    }
    return suppliers;
  }, [activeAction, suppliers]);

  const handleDownloadPO = async (order: CustomerOrder, comp: ManufacturingComponent) => {
    if (isPoPdfGenerating) return;

    const supplier = suppliers.find(s => s.id === comp.supplierId);
    if (!supplier) {
      alert("Supplier data missing. Cannot generate PO.");
      return;
    }

    try {
      // Fetch fresh data to ensure contractStartDate and other fields are up-to-date
      const freshOrders = await dataService.getOrders();
      const freshOrder = freshOrders.find(o => o.id === order.id);
      
      if (!freshOrder) {
        alert("Order not found. Please refresh and try again.");
        return;
      }

      // Find all components in this order sharing the same PO number from THIS supplier
      const items: { item: CustomerOrderItem, comp: ManufacturingComponent }[] = [];
      freshOrder.items.forEach(i => {
        (i.components || []).forEach(c => {
          if (c.poNumber === comp.poNumber && c.supplierId === comp.supplierId) {
            items.push({ item: i, comp: c });
          }
        });
      });

      if (items.length === 0) {
        alert("No components found for this PO number.");
        return;
      }

      setPoPrintData({ order: freshOrder, items, supplier });
    } catch (e: any) {
      alert("Failed to fetch order data: " + (e.message || "Unknown error"));
    }
  };

  useEffect(() => {
    if (!poPrintData) return;

    let cancelled = false;

    const generatePdf = async () => {
      setIsPoPdfGenerating(true);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      await new Promise(resolve => setTimeout(resolve, 600));
      await (document.fonts?.ready || Promise.resolve());

      if (cancelled || !poTemplateRef.current) {
        if (!cancelled) alert("Failed to render PO preview. Please try again.");
        setPoPrintData(null);
        setIsPoPdfGenerating(false);
        return;
      }

      try {
        const printTarget = poTemplateRef.current;
        if (!printTarget) {
          throw new Error('PO template element not found');
        }

        // Clone and convert all styles to inline to avoid stylesheet parsing (oklch issue)
        const clonedElement = printTarget.cloneNode(true) as HTMLElement;
        clonedElement.style.position = 'fixed';
        clonedElement.style.left = '-10000px';
        clonedElement.style.top = '-10000px';
        clonedElement.style.width = '800px';
        document.body.appendChild(clonedElement);

        // Recursively convert all computed styles to inline styles and remove classes
        const convertToInlineStyles = (element: HTMLElement) => {
          if (element.nodeType !== 1) return; // Skip non-element nodes

          const computedStyles = window.getComputedStyle(element);
          
          // List of CSS properties to copy (camelCase for bracket-notation access)
          const stylesToCopy = [
            'display', 'position', 'width', 'height', 'minWidth', 'minHeight',
            'maxWidth', 'maxHeight', 'margin', 'padding',
            'backgroundColor', 'color', 'fontSize', 'fontWeight', 'fontFamily',
            'fontStyle', 'textAlign', 'textTransform', 'textDecoration',
            'lineHeight', 'letterSpacing', 'wordSpacing',
            'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
            'borderColor', 'borderWidth', 'borderStyle', 'borderRadius',
            'gridTemplateColumns', 'gridColumn', 'gridRow', 'gap',
            'flexDirection', 'justifyContent', 'alignItems', 'flex', 'flexWrap',
            'cursor', 'opacity', 'zIndex', 'boxSizing', 'verticalAlign',
            'whiteSpace', 'wordWrap', 'overflow', 'overflowWrap',
            'direction', 'unicodeBidi', 'objectFit'
          ];

          for (const prop of stylesToCopy) {
            try {
              // Use bracket notation — works with camelCase property names
              let value = (computedStyles as any)[prop];
              if (value && typeof value === 'string' && value.trim()) {
                // Replace oklch colors with safe fallbacks
                if (value.includes('oklch')) {
                  if (prop.includes('background') || prop === 'backgroundColor') {
                    value = '#ffffff';
                  } else if (prop.includes('border') || prop.includes('Color')) {
                    value = '#e2e8f0';
                  } else if (prop === 'color') {
                    value = '#0f172a';
                  }
                }
                (element.style as any)[prop] = value;
              }
            } catch (e) {
              // Silently skip invalid assignments
            }
          }

          // Remove classes to prevent stylesheet lookups
          element.removeAttribute('class');
          
          // Process children
          for (let i = 0; i < element.children.length; i++) {
            convertToInlineStyles(element.children[i] as HTMLElement);
          }
        };

        convertToInlineStyles(clonedElement);

        // Explicitly set background for the document
        clonedElement.style.backgroundColor = '#ffffff';
        clonedElement.style.color = '#0f172a';

        const canvas = await html2canvas(clonedElement, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff',
          allowTaint: true
        });

        document.body.removeChild(clonedElement);

        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        const poNumber = poPrintData.items[0]?.comp.poNumber || 'UNKNOWN';
        const safeOrderNumber = sanitizeFileName(poPrintData.order.internalOrderNumber || 'ORDER');
        pdf.save(`PO-${sanitizeFileName(poNumber)}-${safeOrderNumber}.pdf`);
      } catch (err: any) {
        console.error("PDF generation failed:", err, err?.stack, {
          poPrintDataExists: !!poPrintData,
          templatePresent: !!poTemplateRef.current,
          itemsLength: poPrintData?.items.length,
          poNumber: poPrintData?.items[0]?.comp.poNumber,
          internalOrderNumber: poPrintData?.order.internalOrderNumber
        });
        alert("Failed to generate PDF. Check console for details.");
      } finally {
        if (!cancelled) {
          setPoPrintData(null);
          setIsPoPdfGenerating(false);
        }
      }
    };

    generatePdf();

    return () => {
      cancelled = true;
    };
  }, [poPrintData]);

  const handleDownloadRfp = async () => {
    // This handles download from the Send RFP wizard
    if (!activeAction?.order || rfpCompSelection.length === 0 || !rfpTemplateRef.current) return;
    setIsDownloadingRfp(true);
    try {
      const h2c = (await import('html2canvas')).default;
      const canvas = await h2c(rfpTemplateRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
      const imgData = canvas.toDataURL('image/png');
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF('p', 'mm', 'a4');

      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`RFP-${activeAction.order.internalOrderNumber}-${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (e) {
      console.error("RFP PDF Generation Failed", e);
      alert("Failed to generate RFP Request Document.");
    } finally {
      setIsDownloadingRfp(false);
    }
  };

  const handleDownloadExistingRfp = async (order: CustomerOrder, comp: ManufacturingComponent, compsInOrder: { item: CustomerOrderItem, comp: ManufacturingComponent }[]) => {
    // find all components in this order sharing the same rfpId
    const sameRfpGroup = compsInOrder.filter(x => x.comp.rfpId && x.comp.rfpId === comp.rfpId).map(x => x.comp);
    if (sameRfpGroup.length === 0) {
      // Fallback to just this component if no rfpId (though unlikely for RFP_SENT)
      sameRfpGroup.push(comp);
    }

    setRfpPrintData({ order, comps: sameRfpGroup });

    setTimeout(async () => {
      if (!rfpTemplateRef.current) return;
      setIsDownloadingRfp(true);
      try {
        const h2c = (await import('html2canvas')).default;
        const canvas = await h2c(rfpTemplateRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
        const imgData = canvas.toDataURL('image/png');
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF('p', 'mm', 'a4');

        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save(`RFP-${order.internalOrderNumber}-${new Date().toISOString().split('T')[0]}.pdf`);
      } catch (e) {
        console.error("RFP PDF Generation Failed", e);
        alert("Failed to generate RFP Request Document.");
      } finally {
        setIsDownloadingRfp(false);
        setRfpPrintData(null);
      }
    }, 500);
  };

  const handleExecuteAction = async () => {
    if (!activeAction) return;
    const { order, item, comp, type } = activeAction;

    if (type === 'ORDER_ROLLBACK') {
      setIsActionLoading(order.id);
      try {
        if (!resetReason.trim()) throw new Error("Rollback reason is mandatory");

        // Apply any pending resolutions before rolling back
        if (pendingRollbackOrder && pendingResolutions && pendingResolutions.length > 0) {
          for (const rec of pendingResolutions) {
            const choice = resolutionChoices[rec.compId];
            if (choice === 'RECEIVE_TO_STOCK') {
              await dataService.dispatchAction(order.id, 'convert-to-stock-order', { itemId: rec.itemId, compId: rec.compId });
            } else {
              await dataService.cancelComponentPo(order.id, rec.itemId, rec.compId);
            }
          }
          setPendingResolutions(null);
          setResolutionChoices({});
          setPendingRollbackOrder(null);
        }

        await dataService.rollbackOrderToLogged(order.id, resetReason);
        await fetchData();
        closeModal();
      } catch (e: any) { alert(e.message); }
      finally { setIsActionLoading(null); }
      return;
    }

    if (!comp || !item) return;
    setIsActionLoading(comp.id);

    try {
      if (type === 'PO') {
        if (!poNumberInput.trim()) throw new Error("PO Number is required");
        if (selectedCompIds.length === 0) throw new Error("At least one component must be selected");

        // Check if any selected components are from outsourced items
        const anyOutsourced = multiComps.some(({ item: mi, comp: mc }) => 
          selectedCompIds.includes(mc.id!) && mi.productionType === 'OUTSOURCING'
        );
        
        if (anyOutsourced && !contractStartDate.trim()) {
          throw new Error("Contract Start Date is required for outsourcing items");
        }

        if (anyOutsourced && contractStartDate.trim() && !allowPastContractStart) {
          const today = new Date().toISOString().split('T')[0];
          if (contractStartDate < today) {
            throw new Error("Contract Start Date cannot be in the past unless explicitly allowed.");
          }
        }

        setIsActionLoading('bulk-po');
        const componentsToDispatch = selectedCompIds;

        const payload: any = {
          components: componentsToDispatch,
          poNumber: poNumberInput
        };
        
        if (contractStartDate && contractStartDate.trim()) {
          payload.contractStartDate = contractStartDate.trim();
        }
        
        if (contractNumber && contractNumber.trim()) {
          payload.contractNumber = contractNumber.trim();
        }

        await dataService.dispatchAction(order.id, 'issue-po-batch', payload);
      } else if (type === 'CANCEL_PO_BATCH') {
        if (!resetReason.trim()) throw new Error("Cancellation reason is required");

        setIsActionLoading('bulk-cancel');
        await dataService.dispatchAction(order.id, 'cancel-po-batch', {
          sendPoId: comp?.sendPoId
        });
      } else if (type === 'REVERT_PO') {
        setIsActionLoading('revert-po');
        await dataService.dispatchAction(order.id, 'revert-po', {
          itemId: item.id,
          componentId: comp.id
        });
      } else if (type === 'REVERT_TO_PENDING') {
        setIsActionLoading('revert-to-pending');
        // Reset component back to PENDING_OFFER
        const updates: Partial<ManufacturingComponent> = {
          status: 'PENDING_OFFER',
          supplierId: undefined,
          supplierName: undefined,
          awardId: undefined,
          unitCost: 0,
          statusUpdatedAt: new Date().toISOString()
        };
        await dataService.updateComponent(order.id, item.id, comp.id!, updates);
      } else if (type === 'REVIVE_CONTRACT') {
        if (!reviveReason.trim()) throw new Error("Reason is mandatory");
        
        let finalDuration = '';
        const originalDurationNum = parseInt(comp.contractDuration || '0') || 0;
        
        if (reviveMode === 'EXTENSION') {
          const extensionNum = parseInt(reviveDuration) || 0;
          if (extensionNum <= 0) throw new Error("Extension months must be greater than zero");
          finalDuration = (originalDurationNum + extensionNum) + " Months";
        } else {
          if (!reviveEndDate) throw new Error("Please select a new end date");
          const start = new Date(comp.contractStartDate || '');
          const end = new Date(reviveEndDate);
          if (end <= start) throw new Error("New end date must be after original start date");
          
          const diffMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
          if (diffMonths <= originalDurationNum) throw new Error("New end date must result in a longer duration than the original");
          finalDuration = diffMonths + " Months";
        }

        setIsActionLoading('revive-contract');
        await dataService.reviveContract(order.id, item.id, comp.id!, finalDuration, reviveReason.trim());
      } else {
        let updates: Partial<ManufacturingComponent> = { statusUpdatedAt: new Date().toISOString() };

        if (type === 'RFP') {
          setIsActionLoading('bulk-rfp');
          const compsToProcess = rfpCompSelection.length > 0 ? rfpCompSelection : [comp.id!];
          const componentsToDispatch = compsToProcess.map(compId => compId);

          await dataService.dispatchAction(order.id, 'send-rfp-batch', {
            components: componentsToDispatch,
            rfpSupplierIds: rfpSelection,
          });
        } else if (type === 'AWARD') {
          if (!awardSupplierId) throw new Error("Select vendor");

          setIsActionLoading('bulk-award');
          const targetIds = selectedCompIds.length > 0 ? selectedCompIds : [comp.id!];
          const componentsToDispatch = targetIds.map(compId => {
            const unitCost = parseFloat(awardCosts[compId] || '0') || 0;
            return {
              id: compId,
              unitCost
            };
          });

          const supplier = suppliers.find(s => s.id === awardSupplierId);
          if (!supplier) throw new Error("Selected supplier not found.");

          await dataService.dispatchAction(order.id, 'award-tender-batch', {
            components: componentsToDispatch,
            supplierId: awardSupplierId,
            supplierName: supplier.name,
            taxPercent: parseFloat(awardTaxPercent) || 0,
          });
        } else if (type === 'RESET') {
          updates.status = 'PENDING_OFFER';
          updates.supplierId = undefined;
          updates.rfpSupplierIds = [];
          await dataService.updateComponent(order.id, item.id, comp.id!, updates);
        }
      }

      await fetchData();
      closeModal();
    } catch (e: any) {
      alert(e.message || "Operation failed.");
    } finally {
      setIsActionLoading(null);
    }
  };

  const closeModal = () => {
    setActiveAction(null);
    setRfpSelection([]);
    setAwardSupplierId('');
    setAwardCosts({});
    setAwardTaxPercent('14');
    setPoNumberInput('');
    setContractNumber('');
    setContractStartDate('');
    setAllowPastContractStart(false);
    setResetReason('');
    setPendingResolutions(null);
    setResolutionChoices({});
    setPendingRollbackOrder(null);
    setReplacementModalInfo(null);
    setReplacementReason('');
    setReplacementStartDate('');
    setReviveReason('');
    setReviveDuration('');
    setReviveEndDate('');
    setReviveMode('EXTENSION');
  };

  const handleReplacementSubmit = async () => {
    if (!replacementModalInfo || !replacementReason.trim() || !replacementStartDate.trim()) return;
    
    // Validate resource start date against contract start date
    const currentContractStart = new Date(replacementModalInfo.comp.contractStartDate || new Date());
    const newResourceStart = new Date(replacementStartDate);
    const now = new Date();
    
    // Check if current contract start date is in the past
    if (currentContractStart < now) {
      // Contract already started - don't allow new resource start date to be older
      if (newResourceStart < currentContractStart) {
        setReplacementDateError('Resource start date cannot be earlier than the contract start date that already began.');
        return;
      }
    } else {
      // Contract is in the future - offer to update all contract start dates
      if (newResourceStart < currentContractStart && !updateAllContractDates) {
        // This is handled by checkbox, but we could add additional validation here
      }
    }
    
    setIsReplacementPdfGenerating(true);
    try {
      const { order, item, comp } = replacementModalInfo;
      
      // Step 1: Generate PDF snapshot using the safe clone & scrub technique
      console.log('Step 1: Generating PDF...');
      const h2c = (await import('html2canvas')).default;
      if (!replacementTemplateRef.current) throw new Error("Template not ready");
      
      const printTarget = replacementTemplateRef.current;
      const clonedElement = printTarget.cloneNode(true) as HTMLElement;
      clonedElement.style.position = 'fixed';
      clonedElement.style.left = '-10000px';
      clonedElement.style.top = '-10000px';
      clonedElement.style.display = 'block';
      document.body.appendChild(clonedElement);

      // Recursively convert all computed styles to inline styles and remove classes
      const convertToInlineStyles = (element: HTMLElement, originalElement: HTMLElement) => {
        if (element.nodeType !== 1 || originalElement.nodeType !== 1) return;

        const computedStyles = window.getComputedStyle(originalElement);
        const stylesToCopy = [
          'display', 'position', 'width', 'height', 'minWidth', 'minHeight',
          'maxWidth', 'maxHeight', 'margin', 'padding',
          'backgroundColor', 'color', 'fontSize', 'fontWeight', 'fontFamily',
          'fontStyle', 'textAlign', 'textTransform', 'textDecoration',
          'lineHeight', 'letterSpacing', 'wordSpacing',
          'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
          'borderColor', 'borderWidth', 'borderStyle', 'borderRadius',
          'gridTemplateColumns', 'gridColumn', 'gridRow', 'gap',
          'flexDirection', 'justifyContent', 'alignItems', 'flex', 'flexWrap',
          'cursor', 'opacity', 'zIndex', 'boxSizing', 'verticalAlign',
          'whiteSpace', 'wordWrap', 'overflow', 'overflowWrap',
          'direction', 'unicodeBidi', 'objectFit'
        ];

        for (const prop of stylesToCopy) {
          try {
            let value = (computedStyles as any)[prop];
            if (value && typeof value === 'string' && value.trim()) {
              if (value.includes('oklch')) {
                if (prop.includes('background') || prop === 'backgroundColor') value = '#ffffff';
                else if (prop.includes('border') || prop.includes('Color')) value = '#e2e8f0';
                else if (prop === 'color') value = '#0f172a';
              }
              (element.style as any)[prop] = value;
            }
          } catch (e) { /* skip */ }
        }
        element.removeAttribute('class');
        
        for (let i = 0; i < element.children.length; i++) {
          if (originalElement.children[i]) {
            convertToInlineStyles(element.children[i] as HTMLElement, originalElement.children[i] as HTMLElement);
          }
        }
      };

      // We read styles from the original hidden element but apply to the clone
      convertToInlineStyles(clonedElement, printTarget);
      clonedElement.style.backgroundColor = '#ffffff';
      clonedElement.style.color = '#0f172a';

      const canvas = await h2c(clonedElement, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        allowTaint: true
      });
      
      document.body.removeChild(clonedElement);

      const imgData = canvas.toDataURL('image/png');
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`ReplacementRequest-${comp.contractNumber || comp.componentNumber}-${new Date().toISOString().split('T')[0]}.pdf`);
      console.log('PDF generated successfully');

      // Step 2: Prepare replacement history
      console.log('Step 2: Preparing replacement history...');
      const d1 = new Date(comp.contractStartDate || comp.originalStartDate || new Date());
      const d2 = new Date(replacementStartDate);
      let diffMonths = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
      let durationStr = comp.contractDuration || "0";
      let parsedDur = parseFloat(durationStr);
      let remainingDurationStr = durationStr;
      if (!isNaN(parsedDur)) {
         remainingDurationStr = `${Math.max(0, parsedDur - diffMonths)} months remaining`;
      } else {
         remainingDurationStr = `Elapsed approx ${Math.max(0, diffMonths)} months`;
      }

      const newHistory = [...(comp.replacementHistory || [])];
      newHistory.push({
        id: Math.random().toString(36).substring(2, 9),
        requestDate: new Date().toISOString(),
        reason: replacementReason,
        originalStartDate: comp.originalStartDate || comp.contractStartDate || '',
        newStartDate: replacementStartDate,
        remainingDuration: remainingDurationStr
      });

      // Update contract start dates if user chose to move all dates
      let updatedItems = [...order.items];
      if (updateAllContractDates && currentContractStart > now) {
        // Update all components' contract start dates in this order
        updatedItems = updatedItems.map(itm => ({
          ...itm,
          components: (itm.components || []).map(c => ({
            ...c,
            contractStartDate: replacementStartDate
          }))
        }));
      }

      // Step 3: Update component with replacement history
      console.log('Step 3: Updating component with order:', order.id, 'item:', item.id, 'comp:', comp.id);
      
      let finalContractStartDate = comp.contractStartDate || '';
      if (updateAllContractDates && currentContractStart > now) {
        finalContractStartDate = replacementStartDate;
      }
      
      console.log('Update payload:', { originalStartDate: comp.originalStartDate || comp.contractStartDate || '', contractStartDate: finalContractStartDate, replacementHistory: newHistory });
      
      await dataService.updateComponent(order.id, item.id, comp.id!, {
        originalStartDate: comp.originalStartDate || comp.contractStartDate || '',
        contractStartDate: finalContractStartDate,
        replacementHistory: newHistory
      });
      console.log('Component updated successfully');
      
      // If we need to update other components' contract start dates
      if (updateAllContractDates && currentContractStart > now) {
        console.log('Step 4: Updating all other components contract dates...');
        for (const itm of updatedItems) {
          if (itm.id !== item.id) {
            for (const c of (itm.components || [])) {
              if (c.id && c.contractStartDate !== replacementStartDate) {
                await dataService.updateComponent(order.id, itm.id, c.id, {
                  contractStartDate: replacementStartDate
                }).catch(() => {});
              }
            }
          }
        }
      }

      setReplacementModalInfo(null);
      setReplacementReason('');
      setReplacementStartDate('');
      setUpdateAllContractDates(false);
      setReplacementDateError('');
      console.log('Step 5: Fetching updated data...');
      await fetchData();
      console.log('Resource replacement request submitted successfully!');
    } catch(e) {
      console.error('Resource replacement error:', e);
      const errorMsg = (e as any)?.response?.data?.message || (e as any)?.message || 'Unknown error occurred';
      alert(`Failed to submit resource replacement request: ${errorMsg}`);
    } finally {
      setIsReplacementPdfGenerating(false);
    }
  };

  const getContractStartStatus = () => {
    if (!replacementModalInfo) return { isInPast: false, daysUntilStart: 0 };
    const contractStart = new Date(replacementModalInfo.comp.contractStartDate || new Date());
    const now = new Date();
    const isInPast = contractStart < now;
    const daysUntilStart = Math.ceil((contractStart.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return { isInPast, daysUntilStart };
  };

  // Check for in-transit components before initiating a rollback
  const handleInitiateRollback = (order: CustomerOrder) => {
    const IN_TRANSIT_STATUSES = ['ORDERED', 'AWARDED'];
    const found: InTransitCompRecord[] = [];
    order.items.forEach(item => {
      (item.components || []).forEach(comp => {
        if (IN_TRANSIT_STATUSES.includes(comp.status || '')) {
          const supplier = suppliers.find(s => s.id === comp.supplierId);
          found.push({
            itemId: item.id,
            itemDesc: item.description,
            compId: comp.id!,
            compDesc: comp.description,
            componentNumber: comp.componentNumber,
            supplierName: supplier?.name || 'Unknown Supplier',
            quantity: comp.quantity,
            status: comp.status || ''
          });
        }
      });
    });

    if (found.length > 0) {
      // Show resolution dialog first
      const defaults: Record<string, CompResolution> = {};
      found.forEach(c => { defaults[c.compId] = 'CANCEL_PO'; });
      setPendingResolutions(found);
      setResolutionChoices(defaults);
      setPendingRollbackOrder(order);
    } else {
      // No in-transit components, go straight to rollback reason
      setActiveAction({ type: 'ORDER_ROLLBACK', order });
    }
  };

  // After user confirms resolutions
  const handleConfirmResolutions = () => {
    if (!pendingRollbackOrder) return;
    // Move to the rollback reason dialog with order context
    setActiveAction({ type: 'ORDER_ROLLBACK', order: pendingRollbackOrder });
  };

  const openHistory = async (comp: ManufacturingComponent) => {
    setIsHistoryLoading(true);
    try {
      const history = await dataService.getComponentHistory(comp.description, comp.componentNumber);
      setCompHistory(history);
    } catch (e) {
      alert("Failed to load history.");
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const awardCalculations = useMemo(() => {
    let totalExclTax = 0;

    // Sum the individual costs (Quantity * UnitCost) for all selected components
    const selectedComps = multiComps.filter(m => selectedCompIds.includes(m.comp.id!));
    if (selectedComps.length > 0) {
      selectedComps.forEach(m => {
        const qty = m.comp.quantity || 0;
        const unitCost = parseFloat(awardCosts[m.comp.id!] || '0');
        totalExclTax += (qty * unitCost);
      });
    } else if (activeAction?.comp) {
      const qty = activeAction.comp.quantity || 0;
      const unitCost = parseFloat(awardCosts[activeAction.comp.id!] || '0');
      totalExclTax += (qty * unitCost);
    }

    const taxRate = parseFloat(awardTaxPercent) || 0;
    const taxAmount = totalExclTax * (taxRate / 100);
    return {
      totalExclTax,
      taxAmount,
      totalInclTax: totalExclTax + taxAmount
    };
  }, [multiComps, selectedCompIds, activeAction, awardCosts, awardTaxPercent]);



  return (
    <div className="space-y-6">
      {/* Tab Bar */}
      <div className="flex gap-1 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 w-fit">
        <button
          onClick={() => setActiveTab('purchases')}
          className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'purchases' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-50'}`}
        >
          <i className="fa-solid fa-truck-field mr-2"></i> Component Purchases
        </button>
        <button
          onClick={() => setActiveTab('outsourcing')}
          className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'outsourcing' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-50'}`}
        >
          <i className="fa-solid fa-handshake-angle mr-2"></i> Outsourcing
        </button>
<button
           onClick={() => setActiveTab('history')}
           className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'history' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-50'}`}
         >
           <i className="fa-solid fa-clock-rotate-left mr-2"></i> History
         </button>
      </div>

      {activeTab === 'history' ? (
        <PartHistory orders={allOrders} suppliers={suppliers} />
      ) : (
        <>
          {/* Hidden PDF Templates */}
          <div style={{ position: 'absolute', top: '-9999px', left: '-9999px' }}>
            {/* RFP PDF Template */}
            {(rfpPrintData || (activeAction?.type === 'RFP' && activeAction.order && rfpCompSelection.length > 0)) && (
              <div ref={rfpTemplateRef} className="p-12" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'normal', direction: 'ltr', backgroundColor: '#ffffff', color: '#0f172a', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", Inter, "Segoe UI", Tahoma, Arial, sans-serif' }}>
                {/* Determine if this is an outsourcing RFP */}
                {(() => {
                  const compsToRender = rfpPrintData ? rfpPrintData.comps : activeAction!.order.items.flatMap(ci => (ci.components || [])).filter(comp => rfpCompSelection.includes(comp.id || ''));
                  const relatedItems = rfpPrintData 
                    ? rfpPrintData.comps.map(c => activeAction?.order.items.find(i => i.components?.some(comp => comp.id === c.id)) || null).filter(Boolean) as CustomerOrderItem[]
                    : activeAction!.order.items.filter(i => i.components?.some(c => rfpCompSelection.includes(c.id || '')));
                  const isOutsourcing = relatedItems.some(item => item?.productionType === 'OUTSOURCING');
                  
                  return (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '48px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                          {rasterizedLogo && (
                            <div style={{ height: '70px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <img src={rasterizedLogo} alt="Company Logo" style={{ maxHeight: '100%', maxWidth: '220px', objectFit: 'contain' }} />
                            </div>
                          )}
                          <div lang="ar" style={{ direction: 'rtl', textAlign: 'center', unicodeBidi: 'isolate', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", "Segoe UI", Tahoma, Arial, sans-serif' }}>
                            <div style={{ fontSize: '18px', fontWeight: 900, color: '#1e3a8a', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", "Segoe UI", Tahoma, Arial, sans-serif', textTransform: /[\u0600-\u06FF]/.test(config.settings.companyName || '') ? 'none' : 'uppercase' }}>{config.settings.companyName || 'Nexus ERP'}</div>
                            <div style={{ fontSize: '12px', fontWeight: 700, color: '#64748b', whiteSpace: 'pre-line', lineHeight: '1.6', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", "Segoe UI", Tahoma, Arial, sans-serif' }}>
                              {config.settings.companyAddress || 'Headquarters'}
                            </div>
                          </div>
                        </div>
                        <div className="text-right flex flex-col items-end gap-1">
                          <div className="text-4xl font-black uppercase tracking-tighter mb-2" style={{ color: '#0f172a' }}>Request For {isOutsourcing ? 'Services' : 'Proposal'}</div>
                          <div className="flex items-center gap-3">
                            <div className="text-[10px] font-black uppercase tracking-widest" style={{ color: '#94a3b8' }}>Date</div>
                            <div className="font-mono text-sm font-black">{new Date().toLocaleDateString()}</div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-[10px] font-black uppercase tracking-widest" style={{ color: '#94a3b8' }}>Ref</div>
                            <div className="font-mono text-sm font-black" style={{ color: '#1d4ed8' }}>RFQ-{rfpPrintData ? rfpPrintData.order.internalOrderNumber : activeAction!.order.internalOrderNumber}</div>
                          </div>
                        </div>
                      </div>

                      <div className="p-6 rounded-2xl border-2 mb-10 text-sm font-bold leading-relaxed" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#334155' }}>
                        {isOutsourcing 
                          ? <p>Please provide your best commercial offer and estimated timeline for the services listed below. Ensure your quotation clearly states service rates, duration, and total amounts, excluding taxes. If applicable, please attach service scope documentation or qualifications.</p>
                          : <p>Please provide your best commercial offer and lead time for the components listed below. Ensure your quotation clearly states unit prices and total amounts, excluding taxes. If applicable, please attach technical data sheets or compliance certificates.</p>
                        }
                      </div>

                      {/* OUTSOURCING TEMPLATE */}
                      {isOutsourcing && (
                        <div className="border-2 mb-8 flex flex-col" style={{ borderColor: '#0f172a' }}>
                          <div className="grid gap-0 border-b-2 text-[11px] font-black uppercase text-center" style={{ borderColor: '#0f172a', backgroundColor: '#f8fafc', display: 'grid', gridTemplateColumns: '0.8fr 3.5fr 1.2fr 1.2fr 1.2fr' }}>
                            <div style={{ padding: '12px 8px', borderRight: '2px solid #0f172a' }}>#</div>
                            <div style={{ padding: '12px 8px', borderRight: '2px solid #0f172a', textAlign: 'left' }}>Service / Description</div>
                            <div style={{ padding: '12px 8px', borderRight: '2px solid #0f172a' }}>Contract ID</div>
                            <div style={{ padding: '12px 8px', borderRight: '2px solid #0f172a' }}>Duration</div>
                            <div style={{ padding: '12px 8px' }}>Qty</div>
                          </div>

                          {rfpPrintData ? (
                            rfpPrintData.comps.map((comp, idx) => (
                              <div key={comp.id} style={{ display: 'grid', gridTemplateColumns: '0.8fr 3.5fr 1.2fr 1.2fr 1.2fr', gap: 0, borderBottom: '#e2e8f0 1px solid', textAlign: 'center', fontSize: '13px' }}>
                                <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontFamily: 'monospace', fontWeight: 600, color: '#94a3b8' }}>{idx + 1}</div>
                                <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', textAlign: 'left' }}>
                                  <div style={{ fontWeight: 900, fontSize: '12px', marginBottom: '4px' }}>{comp.description}</div>
                                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b' }}>{comp.scopeOfWork || ''}</div>
                                </div>
                                <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontFamily: 'monospace', fontWeight: 900, color: '#1e40af', fontSize: '12px' }}>{comp.contractNumber || 'TBD'}</div>
                                <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontWeight: 700, color: '#7c3aed' }}>{comp.contractDuration || '-'}</div>
                                <div style={{ padding: '12px 8px', fontWeight: 900 }}>{comp.quantity} {comp.unit}</div>
                              </div>
                            ))
                          ) : (
                            activeAction!.order.items.flatMap(ci => (ci.components || []))
                              .filter(comp => rfpCompSelection.includes(comp.id || ''))
                              .map((comp, idx) => (
                                <div key={comp.id} style={{ display: 'grid', gridTemplateColumns: '0.8fr 3.5fr 1.2fr 1.2fr 1.2fr', gap: 0, borderBottom: '#e2e8f0 1px solid', textAlign: 'center', fontSize: '13px' }}>
                                  <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontFamily: 'monospace', fontWeight: 600, color: '#94a3b8' }}>{idx + 1}</div>
                                  <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', textAlign: 'left' }}>
                                    <div style={{ fontWeight: 900, fontSize: '12px', marginBottom: '4px' }}>{comp.description}</div>
                                    <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b' }}>{comp.scopeOfWork || ''}</div>
                                  </div>
                                  <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontFamily: 'monospace', fontWeight: 900, color: '#1e40af', fontSize: '12px' }}>{comp.contractNumber || 'TBD'}</div>
                                  <div style={{ padding: '12px 8px', borderRight: '1px solid #0f172a', fontWeight: 700, color: '#7c3aed' }}>{comp.contractDuration || '-'}</div>
                                  <div style={{ padding: '12px 8px', fontWeight: 900 }}>{comp.quantity} {comp.unit}</div>
                                </div>
                              ))
                          )}
                        </div>
                      )}

                      {/* TRADING & MANUFACTURING TEMPLATE */}
                      {!isOutsourcing && (
                        <div className="border-2 mb-8 flex flex-col" style={{ borderColor: '#0f172a' }}>
                          <div className="grid grid-cols-12 border-b-2 text-[11px] font-black uppercase text-center" style={{ borderColor: '#0f172a', backgroundColor: '#f8fafc' }}>
                            <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>#</div>
                            <div className="col-span-6 p-3 border-r-2 text-left" style={{ borderColor: '#0f172a' }}>Component / Description</div>
                            <div className="col-span-3 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Supplier/Mfr Part #</div>
                            <div className="col-span-2 p-3">Quantity</div>
                          </div>

                          {rfpPrintData ? (
                            rfpPrintData.comps.map((comp, idx) => {
                              const externalPartNum = comp.supplierPartNumber || suppliers.flatMap(s => s.priceList || []).find(p => p.description.trim().toLowerCase() === comp.description.trim().toLowerCase())?.partNumber || '';
                              return (
                                <div key={comp.id} className="grid grid-cols-12 border-b text-center text-sm last:border-b-0" style={{ borderColor: '#e2e8f0' }}>
                                  <div className="col-span-1 p-4 border-r-2 font-mono font-bold" style={{ borderColor: '#0f172a', color: '#94a3b8' }}>{idx + 1}</div>
                                  <div className="col-span-6 p-4 border-r-2 text-left" style={{ borderColor: '#0f172a' }}>
                                    <div className="font-black text-xs leading-relaxed"><span className="font-bold">Component:</span> {comp.description}</div>
                                    <div className="font-black text-xs leading-relaxed mt-2"><span className="font-bold">Description:</span> {comp.scopeOfWork || comp.description}</div>
                                    {comp.componentNumber && !comp.contractNumber && (
                                      <div className="text-[9px] font-bold mt-2 uppercase tracking-widest" style={{ color: '#64748b' }}>(Internal P#: {comp.componentNumber})</div>
                                    )}
                                  </div>
                                  <div className="col-span-3 p-4 border-r-2 font-mono font-bold text-xs" style={{ borderColor: '#0f172a', color: '#1e40af' }}>
                                    {comp.contractNumber || externalPartNum || comp.componentNumber || 'TBD'}
                                  </div>
                                  <div className="col-span-2 p-4 font-black">
                                    {comp.quantity} <span className="text-[9px] font-bold uppercase tracking-widest ml-1" style={{ color: '#94a3b8' }}>{comp.unit}</span>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            activeAction!.order.items.flatMap(ci => (ci.components || []))
                              .filter(comp => rfpCompSelection.includes(comp.id || ''))
                              .map((comp, idx) => {
                                const externalPartNum = comp.supplierPartNumber || suppliers.flatMap(s => s.priceList || []).find(p => p.description.trim().toLowerCase() === comp.description.trim().toLowerCase())?.partNumber || '';
                                return (
                                  <div key={comp.id} className="grid grid-cols-12 border-b text-center text-sm last:border-b-0" style={{ borderColor: '#e2e8f0' }}>
                                    <div className="col-span-1 p-4 border-r-2 font-mono font-bold" style={{ borderColor: '#0f172a', color: '#94a3b8' }}>{idx + 1}</div>
                                    <div className="col-span-6 p-4 border-r-2 text-left" style={{ borderColor: '#0f172a' }}>
                                      <div className="font-black text-xs leading-relaxed"><span className="font-bold">Component:</span> {comp.description}</div>
                                      <div className="font-black text-xs leading-relaxed mt-2"><span className="font-bold">Description:</span> {comp.scopeOfWork || comp.description}</div>
                                      {comp.componentNumber && !comp.contractNumber && (
                                        <div className="text-[9px] font-bold mt-2 uppercase tracking-widest" style={{ color: '#64748b' }}>(Internal P#: {comp.componentNumber})</div>
                                      )}
                                    </div>
                                    <div className="col-span-3 p-4 border-r-2 font-mono font-bold text-xs" style={{ borderColor: '#0f172a', color: '#1e40af' }}>
                                      {comp.contractNumber || externalPartNum}
                                    </div>
                                    <div className="col-span-2 p-4 font-black">
                                      {comp.quantity} <span className="text-[9px] font-bold uppercase tracking-widest ml-1" style={{ color: '#94a3b8' }}>{comp.unit}</span>
                                    </div>
                                  </div>
                                );
                              })
                          )}
                        </div>
                      )}

                      <div style={{ fontSize: '9px', fontWeight: 900, textAlign: 'center', marginTop: '80px', paddingTop: '32px', borderTop: '2px solid #0f172a', color: '#94a3b8', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", Inter, "Segoe UI", Tahoma, Arial, sans-serif' }}>
                        <span style={{ textTransform: 'uppercase', letterSpacing: 'normal' }}>Generated by</span>
                        {' '}
                        <span dir={companyNameHasArabic ? 'rtl' : 'ltr'} lang={companyNameHasArabic ? 'ar' : 'en'} style={{ unicodeBidi: 'isolate', display: 'inline-block', letterSpacing: 'normal', textTransform: companyNameHasArabic ? 'none' : 'none', fontFamily: '"Noto Sans Arabic", "Noto Naskh Arabic", "Segoe UI", Tahoma, Arial, sans-serif' }}>{companyName}</span>
                        {' '}
                        <span style={{ textTransform: 'uppercase', letterSpacing: 'normal' }}>Procurement Operations</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* PO PDF Template */}
            {poPrintData && (
              <div ref={poTemplateRef} className="po-print-template p-10" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'normal', direction: 'ltr', backgroundColor: '#ffffff', color: '#0f172a' }}>
                
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px', paddingBottom: '20px', borderBottom: '3px solid #0f172a' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                    {rasterizedLogo && (
                      <div style={{ height: '70px', display: 'flex', alignItems: 'flex-start' }}>
                        <img src={rasterizedLogo} alt="Company Logo" style={{ maxHeight: '100%', maxWidth: '220px', objectFit: 'contain' }} />
                      </div>
                    )}
                    <div style={{ fontSize: '18px', fontWeight: 900, color: '#0f172a' }}>{config.settings.companyName}</div>
                    <div style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', lineHeight: '1.5' }}>{config.settings.companyAddress}</div>
                  </div>
                  <div style={{ textAlign: 'right', paddingLeft: '20px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 900, color: '#0f172a', marginBottom: '15px' }}>PURCHASE ORDER</div>
                    <div style={{ borderTop: '2px solid #0f172a', paddingTop: '8px', marginBottom: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }}>PO NUMBER</div>
                      <div style={{ fontSize: '16px', fontWeight: 900, color: '#2563eb' }}>{poPrintData.items[0]?.comp.poNumber}</div>
                    </div>
                    <div style={{ borderTop: '2px solid #0f172a', paddingTop: '8px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }}>PO DATE</div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#0f172a' }}>{new Date(poPrintData.items[0]?.comp.statusUpdatedAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                </div>

                {/* Supplier & Order Details */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px' }}>
                  {/* LEFT: Supplier Details (RTL) */}
                  <div style={{ border: '2px solid #0f172a', padding: '15px', backgroundColor: '#f8fafc' }}>
                    <div style={{ textAlign: 'right', direction: 'rtl', marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '6px' }}>المطلوب من (Supplier)</div>
                      <div style={{ fontSize: '13px', fontWeight: 900, color: '#0f172a' }}>{poPrintData.supplier.name}</div>
                    </div>
                    <div style={{ textAlign: 'right', direction: 'rtl', marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>العنوان (Address)</div>
                      <div style={{ fontSize: '10px', fontWeight: 600, color: '#0f172a', lineHeight: '1.5' }}>{poPrintData.supplier.address || 'N/A'}</div>
                    </div>
                    {poPrintData.supplier.phone && (
                      <div style={{ textAlign: 'right', direction: 'rtl' }}>
                        <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>الهاتف (Phone)</div>
                        <div style={{ fontSize: '10px', fontWeight: 600, color: '#0f172a' }}>{poPrintData.supplier.phone}</div>
                      </div>
                    )}
                  </div>

                  {/* RIGHT: Order Details */}
                  <div style={{ border: '2px solid #0f172a', padding: '15px', backgroundColor: '#f8fafc' }}>
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '6px' }}>BUYER ORDER NUMBER</div>
                      <div style={{ fontSize: '13px', fontWeight: 900, color: '#2563eb' }}>{poPrintData.order.internalOrderNumber}</div>
                    </div>
                    {poPrintData.order.customerName && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>CUSTOMER</div>
                        <div style={{ fontSize: '10px', fontWeight: 600, color: '#0f172a' }}>{poPrintData.order.customerName}</div>
                      </div>
                    )}
                    {poPrintData.items.some(({ item, comp }) => (item.productionType === 'OUTSOURCING' || (comp as any).contractStartDate) && comp.contractStartDate) && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Contract Start Date</div>
                        <div style={{ fontSize: '10px', fontWeight: 600, color: '#0f172a' }}>
                          {(() => {
                            const dateComp = poPrintData.items.find(({ item, comp }) => 
                              (item.productionType === 'OUTSOURCING' || (comp as any).contractStartDate) && comp.contractStartDate
                            );
                            return dateComp ? new Date(dateComp.comp.contractStartDate!).toLocaleDateString('en-US') : 'N/A';
                          })()}
                        </div>
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 900, color: '#64748b', textTransform: 'uppercase', marginBottom: '4px' }}>Payment Terms</div>
                      <div style={{ fontSize: '10px', fontWeight: 600, color: '#0f172a' }}>As per agreement</div>
                    </div>
                  </div>
                </div>

                {/* Items Table — conditionally render outsourcing vs trading/manufacturing layout */}
                {(() => {
                  const isOutsourcingPO = poPrintData.items.some(({ item: oi }) => oi?.productionType === 'OUTSOURCING');

                  if (isOutsourcingPO) {
                    // ── OUTSOURCING PO TABLE: No. | Description | Contract ID | Duration | Qty | Start Date | Amount ──
                    const osCols = '0.6fr 2.8fr 1.2fr 0.8fr 0.6fr 1fr 1fr';
                    return (
                      <div style={{ border: '2px solid #0f172a', marginBottom: '25px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: osCols, gap: 0, backgroundColor: '#0f172a', color: '#ffffff' }}>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>No.</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'left', borderRight: '1px solid #ffffff' }}>Description (الوصف)</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Contract ID</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Duration</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Qty</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Start Date</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center' }}>Amount</div>
                        </div>

                        {poPrintData.items.map(({ item: orderItem, comp }, idx) => (
                          <div key={idx} style={{ display: 'grid', gridTemplateColumns: osCols, gap: 0, borderBottom: idx < poPrintData.items.length - 1 ? '1px solid #0f172a' : 'none' }}>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>{idx + 1}</div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 600, textAlign: 'left', borderRight: '1px solid #e2e8f0' }}>
                              <div style={{ fontWeight: 900, marginBottom: '3px' }}>{comp.scopeOfWork || comp.description}</div>
                              {comp.detailedDescription && (
                                <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>{comp.detailedDescription}</div>
                              )}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0', color: '#2563eb' }}>
                              {comp.contractNumber || 'N/A'}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {comp.contractDuration || '-'}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {comp.quantity}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {comp.contractStartDate ? new Date(comp.contractStartDate).toLocaleDateString('en-US') : 'TBD'}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'right' }}>
                              {((comp.quantity || 0) * (comp.unitCost || 0)).toLocaleString('en-US')} LE
                            </div>
                          </div>
                        ))}

                        {Array.from({ length: Math.max(0, 5 - poPrintData.items.length) }).map((_, idx) => (
                          <div key={`empty-${idx}`} style={{ display: 'grid', gridTemplateColumns: osCols, gap: 0, borderBottom: '1px solid #e2e8f0', height: '45px' }}>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div></div>
                          </div>
                        ))}
                      </div>
                    );
                  } else {
                    // ── TRADING / MANUFACTURING PO TABLE: No. | Description | Mfr Part # | Qty | UOM | Unit Price | Amount ──
                    const tmCols = '0.6fr 3fr 1.2fr 0.6fr 0.6fr 1fr 1fr';
                    return (
                      <div style={{ border: '2px solid #0f172a', marginBottom: '25px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: tmCols, gap: 0, backgroundColor: '#0f172a', color: '#ffffff' }}>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>No.</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'left', borderRight: '1px solid #ffffff' }}>Description (الوصف)</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Mfr Part #</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Qty</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Unit</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center', borderRight: '1px solid #ffffff' }}>Unit Price</div>
                          <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'center' }}>Amount</div>
                        </div>

                        {poPrintData.items.map(({ item: orderItem, comp }, idx) => (
                          <div key={idx} style={{ display: 'grid', gridTemplateColumns: tmCols, gap: 0, borderBottom: idx < poPrintData.items.length - 1 ? '1px solid #0f172a' : 'none' }}>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>{idx + 1}</div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 600, textAlign: 'left', borderRight: '1px solid #e2e8f0' }}>
                              <div style={{ fontWeight: 900, marginBottom: '3px' }}>{comp.description}</div>
                              {comp.scopeOfWork && comp.scopeOfWork !== comp.description && (
                                <div style={{ fontSize: '8px', color: '#64748b', marginTop: '2px' }}>{comp.scopeOfWork}</div>
                              )}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0', color: '#2563eb' }}>
                              {comp.supplierPartNumber || comp.componentNumber || 'N/A'}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {comp.quantity}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {comp.unit === 'pcs' ? 'قطعة' : (comp.unit || 'pcs')}
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 700, textAlign: 'center', borderRight: '1px solid #e2e8f0' }}>
                              {(comp.unitCost || 0).toLocaleString('en-US')} LE
                            </div>
                            <div style={{ padding: '10px 8px', fontSize: '9px', fontWeight: 900, textAlign: 'right' }}>
                              {((comp.quantity || 0) * (comp.unitCost || 0)).toLocaleString('en-US')} LE
                            </div>
                          </div>
                        ))}

                        {Array.from({ length: Math.max(0, 5 - poPrintData.items.length) }).map((_, idx) => (
                          <div key={`empty-${idx}`} style={{ display: 'grid', gridTemplateColumns: tmCols, gap: 0, borderBottom: '1px solid #e2e8f0', height: '45px' }}>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div style={{ borderRight: '1px solid #e2e8f0' }}></div>
                            <div></div>
                          </div>
                        ))}
                      </div>
                    );
                  }
                })()}

                {/* Totals Section */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '30px' }}>
                  <div style={{ width: '280px', border: '2px solid #0f172a' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #0f172a' }}>
                      <div style={{ padding: '10px 8px', fontSize: '10px', fontWeight: 900, backgroundColor: '#f8fafc', borderRight: '1px solid #0f172a' }}>SUBTOTAL</div>
                      <div style={{ padding: '10px 8px', fontSize: '10px', fontWeight: 700, textAlign: 'right' }}>
                        {poPrintData.items.reduce((sum, { comp }) => sum + (comp.quantity * comp.unitCost), 0).toLocaleString('en-US')} LE
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #0f172a' }}>
                      <div style={{ padding: '10px 8px', fontSize: '10px', fontWeight: 900, backgroundColor: '#f8fafc', borderRight: '1px solid #0f172a' }}>TAX (14%)</div>
                      <div style={{ padding: '10px 8px', fontSize: '10px', fontWeight: 700, textAlign: 'right' }}>
                        {poPrintData.items.reduce((sum, { comp }) => sum + ((comp.quantity * comp.unitCost) * ((comp.taxPercent || 14) / 100)), 0).toLocaleString('en-US')} LE
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', backgroundColor: '#0f172a', color: '#ffffff' }}>
                      <div style={{ padding: '12px 8px', fontSize: '11px', fontWeight: 900, borderRight: '1px solid #ffffff' }}>TOTAL</div>
                      <div style={{ padding: '12px 8px', fontSize: '14px', fontWeight: 900, textAlign: 'right' }}>
                        {poPrintData.items.reduce((sum, { comp }) => {
                          const base = comp.quantity * comp.unitCost;
                          return sum + base + (base * ((comp.taxPercent || 14) / 100));
                        }, 0).toLocaleString('en-US')} LE
                      </div>
                    </div>
                  </div>
                </div>

                {/* Notes & Signature */}
                <div style={{ marginTop: '40px', paddingTop: '20px', borderTop: '2px solid #0f172a' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '30px' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ height: '50px', borderBottom: '1px solid #0f172a', marginBottom: '5px' }}></div>
                      <div style={{ fontSize: '9px', fontWeight: 700 }}>AUTHORIZED</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ height: '50px', borderBottom: '1px solid #0f172a', marginBottom: '5px' }}></div>
                      <div style={{ fontSize: '9px', fontWeight: 700 }}>APPROVED</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ height: '50px', borderBottom: '1px solid #0f172a', marginBottom: '5px' }}></div>
                      <div style={{ fontSize: '9px', fontWeight: 700 }}>RECEIVED</div>
                    </div>
                  </div>
                  <div style={{ fontSize: '8px', fontWeight: 600, color: '#94a3b8', textAlign: 'center', marginTop: '20px' }}>
                    This is an electronically generated document - Digital Signature on file · تم إنشاء هذا المستند إلكترونياً
                  </div>
                </div>
              </div>
            )}

          </div>

          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">
              <div>
                <h2 className="text-3xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-4">
                  {activeTab === 'outsourcing' ? 'Outsourcing Workflow' : 'Commercial Procurement'}
                </h2>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                  {activeTab === 'outsourcing' 
                    ? `Operational Services • ${outsourcingGroups.length} Orders Pending Action` 
                    : `Supply Chain Orchestration • ${purchaseGroups.length} Orders Pending Action`}
                </p>
              </div>

              {/* Sorting Bar */}
              <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-2xl border border-slate-100 self-end md:self-auto">
                <span className="text-[9px] font-black uppercase text-slate-400 px-3 tracking-widest whitespace-nowrap">Priority Sort:</span>
                <div className="flex gap-1">
                  {[
                    { key: 'orderDate', label: 'PO Received' },
                    { key: 'customer', label: 'Entity' },
                    { key: 'customerReferenceNumber', label: 'PO #' },
                    { key: 'internalOrderNumber', label: 'Int ID' }
                  ].map(btn => (
                    <button
                      key={btn.key}
                      onClick={() => requestSort(btn.key)}
                      className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-1 ${sortConfig.key === btn.key ? 'bg-white text-blue-600 shadow-md ring-1 ring-blue-50' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                      {btn.label}
                      <SortIcon column={btn.key} />
                    </button>
                  ))}
                </div>
              </div>
            </div>


            <div className="space-y-8">
              {(activeTab === 'outsourcing' ? outsourcingGroups : purchaseGroups).map(({ order: o, comps }) => {
                // Binary 0/1 PO-readiness gate:
                // Each component is 1 if it has reached AWARDED or beyond, 0 if still pre-PO.
                // "readyForPo" = at least one comp is AWARDED (needs PO) AND all others are 1 (won't block it).
                const allPoReady = comps.every(({ comp: cc }) => hasReachedPoReadiness(cc.status));  // AND gate
                const anyReadyToOrder = comps.some(({ comp: cc }) => cc.status === 'AWARDED');
                const anyOrdered = comps.some(({ comp: cc }) => hasReachedPoReadiness(cc.status) && cc.status !== 'AWARDED');
                const allOrderedOrHigher = comps.every(({ comp: cc }) => hasReachedPoReadiness(cc.status) && cc.status !== 'AWARDED');
                const readyForPo = anyReadyToOrder && allPoReady;

                const orderProcurementComponents = o.items.flatMap(item => item.components || []).filter(comp => comp.source === 'PROCUREMENT');
                const allOrderProcurementAwarded = orderProcurementComponents.length > 0 && orderProcurementComponents.every(comp => hasReachedPoReadiness(comp.status || ''));
                const anyOrderProcurementNotReady = orderProcurementComponents.some(comp => !hasReachedPoReadiness(comp.status || ''));

                const itemsInFactoryCount = o.items.filter(i => {
                  const eff = getItemEffectiveStatus(i);
                  return ['WAITING_FACTORY', 'MANUFACTURING', 'MANUFACTURED'].includes(eff);
                }).length;
                const totalItems = o.items.length;

                return (
                  <div key={o.id} className="bg-gradient-to-b from-slate-50 to-white rounded-[2rem] border border-slate-200 overflow-hidden">
                    {/* Order Header */}
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-6 bg-slate-100/80 border-b border-slate-200">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-white shadow-sm flex items-center justify-center text-blue-600 text-lg">
                          <i className="fa-solid fa-file-lines"></i>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] font-black text-blue-600 tracking-widest flex items-center gap-2">
                            {o.internalOrderNumber}
                            {itemsInFactoryCount > 0 && (
                              <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-sans text-[9px] uppercase tracking-normal border border-orange-200" title={`${itemsInFactoryCount} of ${totalItems} line items are already in or ready for the factory.`}>
                                <i className="fa-solid fa-bolt mr-1"></i>
{itemsInFactoryCount}/{totalItems} items factory-ready
                              </span>
                            )}
                          </div>
                          <div className="font-black text-slate-800">{o.customerName}</div>
                          <div className="text-[9px] text-slate-400 font-bold uppercase">{comps.length} components</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {/* Rollback button - blocked if any component has PO */}
                        <button
                          onClick={() => {
                            if (anyOrdered) {
                              alert('Cannot rollback: There are active Purchase Orders on this order. Cancel all POs first using the Cancel PO button on each component.');
                              return;
                            }
                            handleInitiateRollback(o);
                          }}
                          className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase flex items-center gap-2 transition-all ${anyOrdered ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-white border border-orange-200 text-orange-500 hover:bg-orange-50'
                            }`}
                          title={anyOrdered ? 'POs Active — Rollback Locked' : 'Rollback to Logged Registry'}
                        >
                          <i className="fa-solid fa-file-export fa-flip-horizontal"></i>
                          {anyOrdered ? 'POs Active — Rollback Locked' : 'Rollback Order'}
                        </button>

                        {/* Global Issue PO for all awarded comps */}
                        {readyForPo && allOrderProcurementAwarded && (
                          <button
                            disabled={o.status === OrderStatus.NEGATIVE_MARGIN || !allOrderProcurementAwarded}
                            onClick={async () => {
                              const po = await dataService.getUniquePoNumber();
                              setPoNumberInput(po);
                              const awarded = comps.filter(({ comp: cc }) => cc.status === 'AWARDED');
                              if (awarded.length > 0) {
                                const sId = awarded[0].comp.supplierId;
                                const sameSupplier = awarded.filter(a => a.comp.supplierId === sId);
                                setMultiComps(sameSupplier);
                                setSelectedCompIds(sameSupplier.map(m => m.comp.id!));
                                const contractInfo = deriveOutsourcingContractInfo(sameSupplier);
                                setContractNumber(contractInfo.contractNumber);
                                setContractStartDate(contractInfo.contractStartDate);
                                setActiveAction({ type: 'PO', order: o, item: sameSupplier[0].item, comp: sameSupplier[0].comp });
                              }
                            }}
                            className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase shadow-lg flex items-center gap-2 transition-all ${o.status === OrderStatus.NEGATIVE_MARGIN || !allOrderProcurementAwarded ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-100'
                              }`}
                          >
                            <i className="fa-solid fa-file-invoice"></i> Issue PO for All
                          </button>
                        )}
                        {anyOrderProcurementNotReady && (
                          <div className="flex items-center gap-1.5 text-[8px] font-black text-rose-600 uppercase bg-rose-50 px-3 py-1.5 rounded-lg">
                            <i className="fa-solid fa-circle-exclamation"></i>
                            Not all line items ready for PO
                          </div>
                        )}
                        {!readyForPo && !allOrderedOrHigher && !anyOrderProcurementNotReady && (
                          <div className="flex items-center gap-1.5 text-[8px] font-black text-amber-600 uppercase bg-amber-50 px-3 py-1.5 rounded-lg">
                            <i className="fa-solid fa-hourglass-half"></i>
                            All components must be awarded for PO
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Components List */}
                    <div className="divide-y divide-slate-100">
                      {comps.map(({ item: i, comp: c }) => {
                        const isContractExpired = (() => {
                          if (activeTab !== 'outsourcing') return false;
                          if (!c.contractStartDate || !c.contractDuration) return false;
                          const endDate = calculateContractEndDate(c.contractStartDate, c.contractDuration);
                          if (!endDate) return false;
                          return endDate.getTime() < new Date().setHours(0, 0, 0, 0);
                        })();

                        const dynamicStatus = (() => {
                          if (activeTab !== 'outsourcing' || !c.contractStartDate || !c.contractDuration) return c.status || '';
                          const today = new Date();
                          today.setHours(0,0,0,0);
                          const start = new Date(c.contractStartDate);
                          start.setHours(0,0,0,0);
                          const end = calculateContractEndDate(c.contractStartDate, c.contractDuration);
                          if (!end) return c.status || '';
                          end.setHours(0,0,0,0);

                          if (today < start) return 'WAITING_CONTRACT_START';
                          if (today >= start && today <= end) return 'RUNNING';
                          return 'GRACE_PERIOD';
                        })();

                        return (
                          <div key={c.id} className="flex flex-col justify-between p-5 hover:bg-blue-50/30 transition-all group gap-3">
                          <div className="flex gap-4 items-center w-full">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg shadow-inner ${dynamicStatus === 'ORDERED' || dynamicStatus === 'RUNNING' ? 'bg-emerald-50 text-emerald-600' :
                              dynamicStatus === 'WAITING_CONTRACT_START' ? 'bg-purple-50 text-purple-600' :
                              dynamicStatus === 'AWARDED' ? 'bg-amber-50 text-amber-600' : 
                              dynamicStatus === 'GRACE_PERIOD' ? 'bg-rose-50 text-rose-600' : 'bg-white text-blue-500 shadow-sm'
                              }`}>
                              <i className={`fa-solid ${dynamicStatus === 'ORDERED' || dynamicStatus === 'RUNNING' ? 'fa-truck-fast' : dynamicStatus === 'WAITING_CONTRACT_START' ? 'fa-calendar-check' : dynamicStatus === 'AWARDED' ? 'fa-file-signature' : dynamicStatus === 'GRACE_PERIOD' ? 'fa-hourglass-end' : 'fa-diagram-project'}`}></i>
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] font-black text-blue-600 font-mono tracking-widest uppercase">{c.componentNumber}</span>
                                {c.supplierPartNumber && <span className="text-[10px] font-black text-amber-600 font-mono tracking-widest uppercase border border-amber-200 bg-amber-50 px-1 rounded">MFR P/N: {c.supplierPartNumber}</span>}
                                <span className={`px-2 py-0.5 text-[8px] font-black rounded uppercase ${dynamicStatus === 'ORDERED' || dynamicStatus === 'RUNNING' ? 'bg-emerald-600 text-white' :
                                  dynamicStatus === 'WAITING_CONTRACT_START' ? 'bg-purple-600 text-white' :
                                  dynamicStatus === 'AWARDED' ? 'bg-amber-600 text-white' : 
                                  dynamicStatus === 'GRACE_PERIOD' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white'
                                  }`}>{dynamicStatus.replace(/_/g, ' ')}</span>
                                {c.rfpId && ['RFP_SENT', 'AWARDED'].includes(c.status || '') && (
                                  <span className="text-[9px] font-black text-blue-600 uppercase border border-blue-200 bg-blue-50 px-2 rounded ml-1" title="RFP Batch Group">
                                    BATCH: {c.rfpId.substring(0, 6)}
                                  </span>
                                )}
                              </div>
                              <div className="font-black text-slate-800 text-base tracking-tight">
                                {c.description}
                                {c.contractStartDate && (
                                  <span className="ml-3 text-[9px] font-black text-purple-600 uppercase tracking-wide">
                                    <i className="fa-solid fa-calendar-check mr-1"></i>Start: {new Date(c.contractStartDate).toLocaleDateString()}
                                    {c.contractStartDate && c.contractDuration && (() => {
                                      const endDate = calculateContractEndDate(c.contractStartDate, c.contractDuration);
                                      return endDate ? (
                                        <span className="text-emerald-600 ml-2">
                                          • End: {endDate.toLocaleDateString()} ✓
                                        </span>
                                      ) : null;
                                    })()}
                                    {c.contractDuration && (
                                      <span className="text-blue-600 ml-2">
                                        • Duration: {c.contractDuration}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </div>
                              <div className="text-[9px] text-slate-400 font-bold uppercase mt-1 flex flex-wrap gap-x-2 gap-y-1">
                                <span>Item: {i.orderNumber}</span>
                                <span>•</span>
                                <span>Ordered Qty: {c.quantity} {c.unit}</span>
                                <span>•</span>
                                <span>Cost: {(c.unitCost || 0).toLocaleString()} L.E.</span>
                                {c.receivedQty !== undefined && c.receivedQty > 0 && (
                                  <>
                                    <span className="text-emerald-600 font-black">• Received: {c.receivedQty}</span>
                                    <span className="text-amber-600 font-black">• Left: {Math.max(0, (c.quantity || 0) - c.receivedQty)}</span>
                                  </>
                                )}
                                {c.supplierId && (
                                  <span className="text-blue-600">
                                    • Supplier: {suppliers.find(s => s.id === c.supplierId)?.name || 'Unknown'}
                                  </span>
                                )}
                              </div>
                              <CompThreshold component={c} config={config} />
                            </div>
                          </div>
                          {isContractExpired ? (
                            <div className="flex flex-col items-end gap-2 mt-4 pt-4 border-t border-slate-100 w-full">
                              <div className="text-[10px] font-black text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-200 uppercase tracking-widest">
                                <i className="fa-solid fa-triangle-exclamation mr-1.5"></i>Contract Expired
                              </div>
                              <button
                                onClick={() => setActiveAction({ type: 'REVIVE_CONTRACT', order: o, item: i, comp: c })}
                                className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg text-[10px] font-black uppercase shadow-lg hover:bg-emerald-700 transition-all flex items-center gap-2 mt-2"
                              >
                                <i className="fa-solid fa-heart-pulse"></i> Revive Contract
                              </button>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2 flex-wrap">
                            <div className="flex items-center">
                              {c.status === 'RFP_SENT' && (
                                <button
                                  onClick={() => setActiveAction({ type: 'RESET', order: o, item: i, comp: c })}
                                  className="p-3 text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100"
                                  title="Resend RFP / Reset Component Sourcing"
                                >
                                  <i className="fa-solid fa-rotate-left"></i>
                                </button>
                              )}

                              <button
                                onClick={() => openHistory(c)}
                                className="p-3 text-slate-300 hover:text-blue-500 transition-colors opacity-0 group-hover:opacity-100"
                                title="View Price History"
                              >
                                <i className="fa-solid fa-clock-rotate-left"></i>
                              </button>
                            </div>

                            {c.status === 'PENDING_OFFER' && (
                              <button onClick={() => {
                                setActiveAction({ type: 'RFP', order: o, item: i, comp: c });
                                setRfpSelection(c.rfpSupplierIds || []);
                                // Auto-select other components with the same rfpId if it exists
                                const sameRfpIds = c.rfpId ? comps.filter(x => x.comp.rfpId === c.rfpId).map(x => x.comp.id!) : [c.id!];
                                setRfpCompSelection(sameRfpIds);
                              }}
                                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-black transition-all"
                              >Send RFP</button>
                            )}
                            {c.status === 'RFP_SENT' && (
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => handleDownloadExistingRfp(o, c, comps)}
                                  className="px-3 py-1.5 bg-white border border-slate-900 text-slate-900 rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-slate-50 transition-all flex items-center gap-1.5"
                                >
                                  <i className="fa-solid fa-file-pdf"></i> Download RFP
                                </button>
                                <button onClick={() => {
                                  const sameRfp = comps.filter(x => x.comp.status === 'RFP_SENT' && c.rfpId && x.comp.rfpId === c.rfpId);
                                  const displayComps = sameRfp.length > 0 ? sameRfp : [comps.find(x => x.comp.id === c.id)!];
                                  setMultiComps(displayComps);
                                  setSelectedCompIds([c.id!]); // Default to only current one selected
                                  setActiveAction({ type: 'AWARD', order: o, item: i, comp: c });
                                  setAwardCosts({ [c.id!]: (c.unitCost || 0).toString() });
                                  setAwardTaxPercent((c.taxPercent || 14).toString());
                                }}
                                  className="px-4 py-2 bg-amber-600 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-amber-700 transition-all"
                                >Award Tender</button>
                              </div>
                            )}
                            {c.status === 'AWARDED' && (
                              <div className="flex flex-col items-end gap-1.5">
                                <div className="flex items-center gap-2">
                                  {!allOrderProcurementAwarded && (
                                    <span className="text-[8px] font-black text-slate-400 uppercase mr-2">All components must be awarded first</span>
                                  )}

                                  {allOrderProcurementAwarded && (
                                    <button
                                      disabled={o.status === OrderStatus.NEGATIVE_MARGIN || !allOrderProcurementAwarded}
                                      onClick={async () => {
                                        const po = await dataService.getUniquePoNumber();
                                        setPoNumberInput(po);
                                        const sameAwardGroup = comps.filter(x =>
                                          x.comp.status === 'AWARDED' &&
                                          x.comp.supplierId === c.supplierId &&
                                          (c.awardId ? x.comp.awardId === c.awardId : true)
                                        );
                                        setMultiComps(sameAwardGroup);
                                        setSelectedCompIds([c.id!]); // Default to only current
                                        const contractInfo = deriveOutsourcingContractInfo(sameAwardGroup);
                                        setContractNumber(contractInfo.contractNumber);
                                        setContractStartDate(contractInfo.contractStartDate);
                                        setActiveAction({ type: 'PO', order: o, item: i, comp: c });
                                      }}
                                      className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase shadow-sm transition-all ${o.status === OrderStatus.NEGATIVE_MARGIN || !allOrderProcurementAwarded ? 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                                    >
                                      Issue PO
                                    </button>
                                  )}
                                  
                                  <button
                                    onClick={() => {
                                      setActiveAction({ type: 'REVERT_TO_PENDING', order: o, item: i, comp: c });
                                    }}
                                    disabled={isActionLoading != null}
                                    className="px-3 py-2 rounded-lg text-[9px] font-black uppercase shadow-sm transition-all bg-orange-500 text-white hover:bg-orange-600 disabled:bg-slate-300 disabled:text-slate-500 disabled:cursor-not-allowed"
                                    title="Reset this award and return to PENDING_OFFER status"
                                  >
                                    Reset Award
                                  </button>
                                </div>
                                {o.status === OrderStatus.NEGATIVE_MARGIN && (
                                  <div className="flex items-center gap-1.5 text-[8px] font-black text-rose-500 uppercase animate-pulse">
                                    <i className="fa-solid fa-triangle-exclamation"></i>
                                    Financial Breach: PO Blocked
                                  </div>
                                )}
                              </div>
                            )}
                            {c.status === 'ORDERED' && (
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => handleDownloadPO(o, c)}
                                  className="px-3 py-1.5 bg-white border border-blue-600 text-blue-600 rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-blue-50 transition-all flex items-center gap-1.5"
                                >
                                  <i className="fa-solid fa-file-pdf"></i> Download PO
                                </button>
                                <button
                                  onClick={() => {
                                    // Find all components sharing this PO number and sendPoId
                                    const samePoBatch = comps.filter(x =>
                                      x.comp.poNumber === c.poNumber &&
                                      x.comp.status === 'ORDERED' &&
                                      (c.sendPoId ? x.comp.sendPoId === c.sendPoId : true)
                                    );
                                    setMultiComps(samePoBatch);
                                    setSelectedCompIds(samePoBatch.map(m => m.comp.id!));
                                    setResetReason('');
                                    setActiveAction({ type: 'CANCEL_PO_BATCH', order: o, item: i, comp: c });
                                  }}
                                  disabled={isActionLoading != null}
                                  className="px-3 py-1.5 bg-rose-600 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-rose-700 transition-all flex items-center gap-1.5"
                                >
                                  <i className="fa-solid fa-ban"></i> Cancel Order
                                </button>
                                <button
                                  onClick={() => {
                                    setActiveAction({ type: 'REVERT_PO', order: o, item: i, comp: c });
                                  }}
                                  disabled={isActionLoading != null}
                                  className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-amber-600 transition-all flex items-center gap-1.5"
                                  title="Revert this PO back to AWARDED status"
                                >
                                  <i className="fa-solid fa-rotate-left"></i> Revert to Award
                                </button>
                                <span className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.15em] px-2 animate-pulse">
                                  <i className="fa-solid fa-truck-fast mr-1"></i>In Transit
                                </span>
                              </div>
                            )}
                            {c.status === 'WAITING_CONTRACT_START' && (
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  onClick={() => handleDownloadPO(o, c)}
                                  className="px-3 py-1.5 bg-white border border-purple-600 text-purple-600 rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-purple-50 transition-all flex items-center gap-1.5"
                                >
                                  <i className="fa-solid fa-file-pdf"></i> Download PO
                                </button>
                                <button
                                  onClick={() => {
                                    const samePoBatch = comps.filter(x =>
                                      x.comp.poNumber === c.poNumber &&
                                      x.comp.status === 'WAITING_CONTRACT_START' &&
                                      (c.sendPoId ? x.comp.sendPoId === c.sendPoId : true)
                                    );
                                    setMultiComps(samePoBatch);
                                    setSelectedCompIds(samePoBatch.map(m => m.comp.id!));
                                    setResetReason('');
                                    setActiveAction({ type: 'CANCEL_PO_BATCH', order: o, item: i, comp: c });
                                  }}
                                  disabled={isActionLoading != null}
                                  className="px-3 py-1.5 bg-rose-600 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-rose-700 transition-all flex items-center gap-1.5"
                                >
                                  <i className="fa-solid fa-ban"></i> Cancel Order
                                </button>
                                <button
                                  onClick={() => {
                                    setActiveAction({ type: 'REVERT_PO', order: o, item: i, comp: c });
                                  }}
                                  disabled={isActionLoading != null}
                                  className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-amber-600 transition-all flex items-center gap-1.5"
                                  title="Revert this PO back to AWARDED status"
                                >
                                  <i className="fa-solid fa-rotate-left"></i> Revert to Award
                                </button>
                              </div>
                            )}
                            {['WAITING_CONTRACT_START', 'RECEIVED', 'RESERVED', 'IN_MANUFACTURING', 'MANUFACTURED'].includes(c.status || '') && activeTab === 'outsourcing' && (
                              <div className="flex items-center gap-2 pt-2 border-t border-slate-100 w-full justify-end">
                                <button
                                  onClick={() => setReplacementModalInfo({ order: o, item: i, comp: c })}
                                  className="px-3 py-1.5 bg-violet-100 border border-violet-100 text-violet-700 rounded-lg text-[9px] font-black uppercase shadow-sm hover:bg-violet-200 hover:border-violet-200 transition-all flex items-center gap-1.5"
                                  title="Request Resource Replacement"
                                >
                                  <i className="fa-solid fa-users-arrows"></i> Resource Replacement
                                </button>
                              </div>
                            )}
                          </div>
                            </>
                          )}
                        </div>
                      )})}
                    </div>
                  </div>
                );
              })}
              {((activeTab === 'outsourcing' ? outsourcingGroups : purchaseGroups).length === 0) && (
                <div className="p-24 text-center text-slate-300 italic uppercase text-xs font-black tracking-widest flex flex-col items-center gap-4">
                  <i className={`fa-solid ${activeTab === 'outsourcing' ? 'fa-handshake-angle' : 'fa-clipboard-check'} text-5xl opacity-10`}></i>
                  {activeTab === 'outsourcing' ? 'No active outsourcing tasks.' : 'Commercial procurement pipeline is empty.'}
                </div>
              )}
            </div>
          </div>

          {
            activeAction && (
              <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 overflow-y-auto">
                <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-xl p-10 my-8 animate-in zoom-in-95 duration-300 border border-slate-100">
                  <div className="flex items-center gap-6 mb-8">
                    <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-3xl shadow-inner ${activeAction.type === 'RFP' ? 'bg-blue-50 text-blue-600' :
                      activeAction.type === 'AWARD' ? 'bg-amber-50 text-amber-600' :
                        activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK' ? 'bg-rose-50 text-rose-600' :
                          activeAction.type === 'REVIVE_CONTRACT' ? 'bg-emerald-50 text-emerald-600' : 'bg-emerald-50 text-emerald-600'
                      }`}>
                      <i className={`fa-solid ${activeAction.type === 'RFP' ? 'fa-paper-plane' :
                        activeAction.type === 'AWARD' ? 'fa-award' :
                          activeAction.type === 'RESET' ? 'fa-rotate-left' :
                            activeAction.type === 'ORDER_ROLLBACK' ? 'fa-file-export fa-flip-horizontal' :
                              activeAction.type === 'REVIVE_CONTRACT' ? 'fa-heart-pulse' : 'fa-file-invoice'
                        }`}></i>
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                        {activeAction.type === 'RFP' ? 'Issue Request for Proposals' :
                          activeAction.type === 'AWARD' ? 'Commercial Award Selection' :
                            activeAction.type === 'RESET' ? 'Reset Sourcing Cycle' :
                              activeAction.type === 'ORDER_ROLLBACK' ? 'Order Workflow Rollback' :
                                activeAction.type === 'REVIVE_CONTRACT' ? 'Revive Expired Contract' : 'Confirm Purchase Order'}
                      </h3>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        {activeAction.type === 'ORDER_ROLLBACK' ? `Reverting to Logged Registry: ${activeAction.order.internalOrderNumber}` : `Comp: ${activeAction.comp?.description}`}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-6">
                    {activeAction.type === 'RFP' && (
                      <>
                        <div className="space-y-3">
                          <div className="flex justify-between items-end mb-2">
                            <div>
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Components to include in RFP</label>
                              <p className="text-[9px] text-slate-400 font-bold uppercase ml-1 -mt-1">Select other components from this order to group into a single request.</p>
                            </div>
                          </div>
                          <div className="border border-slate-100 rounded-2xl p-2 max-h-48 overflow-y-auto custom-scrollbar space-y-1">
                            {activeAction.order.items
                              .filter(ci => {
                                // Filter items by current tab's productionType
                                if (activeTab === 'outsourcing') return ci.productionType === 'OUTSOURCING';
                                if (activeTab === 'purchases') return ci.productionType !== 'OUTSOURCING';
                                return true; // 'history' tab
                              })
                              .flatMap(ci => (ci.components || []).filter(cc =>
                                cc.source === 'PROCUREMENT' &&
                                (['PENDING_OFFER', 'RFP_SENT'].includes(cc.status || ''))
                              )).map(comp => (
                              <label key={comp.id} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${rfpCompSelection.includes(comp.id || '') ? 'bg-blue-600 text-white border-blue-700 shadow-md' : 'bg-slate-50 border-slate-100 hover:border-slate-300'}`}>
                                <input
                                  type="checkbox"
                                  className="hidden"
                                  checked={rfpCompSelection.includes(comp.id || '')}
                                  onChange={(e) => {
                                    if (e.target.checked) setRfpCompSelection(prev => [...prev, comp.id || '']);
                                    else setRfpCompSelection(prev => prev.filter(id => id !== comp.id));
                                  }}
                                />
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${rfpCompSelection.includes(comp.id || '') ? 'bg-white border-white text-blue-600' : 'bg-white border-slate-200'}`}>
                                  {rfpCompSelection.includes(comp.id || '') && <i className="fa-solid fa-check text-[10px]"></i>}
                                </div>
                                <div className="flex-1">
                                  <div className={`text-xs font-black ${rfpCompSelection.includes(comp.id || '') ? 'text-white' : 'text-slate-800'}`}>{comp.description}</div>
                                  <div className={`text-[9px] font-bold uppercase tracking-widest ${rfpCompSelection.includes(comp.id || '') ? 'text-blue-100' : 'text-slate-400'}`}>
                                    Qty: {comp.quantity} {comp.unit} | {comp.status?.replace('_', ' ')}
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="pt-2">
                          <button
                            onClick={handleDownloadRfp}
                            disabled={isDownloadingRfp || rfpCompSelection.length === 0}
                            className="w-full py-3 bg-blue-50 text-blue-700 border border-blue-200 rounded-2xl font-black text-[10px] uppercase shadow-sm hover:bg-blue-600 hover:text-white hover:border-blue-600 transition-all flex items-center justify-center gap-2 group"
                          >
                            {isDownloadingRfp ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-file-pdf text-rose-500 group-hover:text-white"></i>}
                            {isDownloadingRfp ? 'Generating Request Document...' : 'Download Vendor RFP Document'}
                          </button>
                          {rfpCompSelection.length === 0 && <p className="text-center text-[9px] text-rose-500 font-bold uppercase mt-1">Select at least one component to generate PDF</p>}
                        </div>

                        <div className="space-y-3 pt-4 border-t border-slate-100">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Select Target Suppliers (Optional)</label>
                          <p className="text-[9px] text-slate-400 font-bold uppercase ml-1 -mt-1 mb-2">If none selected, Award Tender will show all available vendors.</p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1 custom-scrollbar">
                            {suppliers.map(s => (
                              <button
                                key={s.id}
                                onClick={() => setRfpSelection(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                                className={`p-4 rounded-2xl border text-left transition-all flex items-center justify-between ${rfpSelection.includes(s.id) ? 'bg-blue-600 text-white border-blue-700 shadow-lg' : 'bg-slate-50 text-slate-700 border-slate-100 hover:border-blue-200'}`}
                              >
                                <span className="text-xs font-black uppercase tracking-tight">{s.name}</span>
                                {rfpSelection.includes(s.id) && <i className="fa-solid fa-circle-check"></i>}
                              </button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {activeAction.type === 'AWARD' && activeAction.comp && (
                      <>
                        <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 flex justify-between items-center mb-4">
                          <div>
                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Quantity</div>
                            <div className="text-xl font-black text-slate-800">
                              {selectedCompIds.length > 0 ? multiComps.filter(m => selectedCompIds.includes(m.comp.id!)).reduce((sum, m) => sum + (m.comp.quantity || 0), 0) : activeAction.comp.quantity}
                              <span className="text-xs font-bold text-slate-400 ml-1">{activeAction.comp.unit}</span>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Sourcing Code</div>
                            <div className="font-mono text-xs font-bold text-blue-600">{activeAction.comp.componentNumber}</div>
                          </div>
                        </div>

                        {multiComps.length > 0 && (
                          <div className="space-y-3 mb-4">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Matching Components in RFP</label>
                            <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto p-1 custom-scrollbar">
                              {multiComps.map(({ comp: mc, item: mi }) => {
                                const isSelected = selectedCompIds.includes(mc.id!);
                                return (
                                  <div
                                    key={mc.id}
                                    className={`p-3 rounded-2xl border transition-all ${isSelected ? 'bg-amber-50 border-amber-200 shadow-sm' : 'bg-white border-slate-100'}`}
                                  >
                                    <div className="flex items-center justify-between mb-2">
                                      <div className="flex flex-col cursor-pointer flex-1" onClick={() => setSelectedCompIds(prev => prev.includes(mc.id!) ? prev.filter(x => x !== mc.id) : [...prev, mc.id!])}>
                                        <span className="text-[10px] font-black uppercase text-slate-700">{mc.description}</span>
                                        <span className="text-[9px] font-bold text-slate-400">Qty: {mc.quantity} • Item: {mi.orderNumber}</span>
                                      </div>
                                      <button onClick={() => setSelectedCompIds(prev => prev.includes(mc.id!) ? prev.filter(x => x !== mc.id) : [...prev, mc.id!])} className="p-2">
                                        {isSelected ? <i className="fa-solid fa-circle-check text-amber-500 text-lg"></i> : <i className="fa-regular fa-circle text-slate-300 text-lg"></i>}
                                      </button>
                                    </div>
                                    {isSelected && (
                                      <div className="mt-2 pt-2 border-t border-amber-200/50 flex items-center justify-between animate-in slide-in-from-top-2">
                                        <span className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Price per {mc.unit || 'Item'}</span>
                                        <div className="flex items-center gap-2">
                                          <input
                                            type="number" step="any" min="0" placeholder="0.00"
                                            className="w-24 px-3 py-1.5 bg-white border border-amber-200 rounded-xl font-black text-amber-900 text-right text-sm outline-none focus:border-amber-400 transition-all"
                                            value={awardCosts[mc.id!] || ''}
                                            onChange={e => setAwardCosts(prev => ({ ...prev, [mc.id!]: e.target.value }))}
                                          />
                                          <span className="text-[9px] font-black text-amber-600">L.E.</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        <div className="space-y-4">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Award Winning Vendor</label>
                            <select
                              className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-bold text-sm outline-none focus:bg-white focus:border-blue-500 transition-all"
                              value={awardSupplierId} onChange={e => setAwardSupplierId(e.target.value)}
                            >
                              <option value="">Select Vendor...</option>
                              {awardSuppliersList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </div>

                          <div className="grid grid-cols-1 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Global Tax Percentage (%)</label>
                              <input
                                type="number" step="any"
                                className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-xl outline-none focus:bg-white focus:border-blue-500 transition-all"
                                value={awardTaxPercent} onChange={e => setAwardTaxPercent(e.target.value)}
                              />
                            </div>
                          </div>

                          <div className="p-6 bg-slate-900 rounded-[2rem] text-white space-y-4 mt-6">
                            <div className="flex justify-between items-center opacity-60">
                              <span className="text-[10px] font-black uppercase tracking-widest">Total Cost Without Tax</span>
                              <span className="font-bold">{awardCalculations.totalExclTax.toLocaleString()} L.E.</span>
                            </div>
                            <div className="flex justify-between items-center text-amber-400">
                              <span className="text-[10px] font-black uppercase tracking-widest">Tax Amount ({awardTaxPercent}%)</span>
                              <span className="font-bold">{awardCalculations.taxAmount.toLocaleString()} L.E.</span>
                            </div>
                            <div className="h-px bg-white/10 my-2"></div>
                            <div className="flex justify-between items-center">
                              <span className="text-xs font-black uppercase tracking-[0.2em] text-blue-400">Total Award Value (Incl. Tax)</span>
                              <span className="text-2xl font-black">{awardCalculations.totalInclTax.toLocaleString()} <span className="text-xs opacity-40">L.E.</span></span>
                            </div>
                          </div>
                        </div>
                      </>
                    )}

                    {activeAction.type === 'PO' && (
                      <div className="space-y-6">
                        <div className="p-5 bg-blue-50 rounded-2xl border border-blue-100 flex justify-between items-center">
                          <div>
                            <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Target Supplier</div>
                            <div className="text-lg font-black text-blue-900 uppercase tracking-tight">
                              {suppliers.find(s => s.id === (multiComps[0]?.comp.supplierId || activeAction.comp?.supplierId))?.name || 'Unknown Supplier'}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Order Ref</div>
                            <div className="font-mono text-xs font-bold text-blue-600">{activeAction.order.internalOrderNumber}</div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Include in Purchase Order</label>
                          <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto p-1 custom-scrollbar">
                            {multiComps.map(({ item: mi, comp: mc }) => (
                              <button
                                key={mc.id}
                                onClick={() => setSelectedCompIds(prev => prev.includes(mc.id!) ? prev.filter(x => x !== mc.id) : [...prev, mc.id!])}
                                className={`p-4 rounded-2xl border text-left transition-all flex items-center justify-between ${selectedCompIds.includes(mc.id!) ? 'bg-blue-600 text-white border-blue-700 shadow-lg' : 'bg-slate-50 text-slate-700 border-slate-100 hover:border-blue-200'}`}
                              >
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-black uppercase tracking-tight opacity-70">{mc.componentNumber}</span>
                                  <span className="text-xs font-black uppercase tracking-tight">{mc.description}</span>
                                  <span className="text-[9px] font-bold opacity-60">Qty: {mc.quantity} • Item: {mi.orderNumber}</span>
                                </div>
                                {selectedCompIds.includes(mc.id!) && <i className="fa-solid fa-circle-check"></i>}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">System Purchase Order ID</label>
                          <input
                            className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl font-black text-2xl text-blue-600 outline-none focus:bg-white focus:border-blue-500 transition-all uppercase tracking-widest"
                            value={poNumberInput} onChange={e => setPoNumberInput(e.target.value)}
                          />
                        </div>

                        {multiComps.some(({ item: mi, comp: mc }) => selectedCompIds.includes(mc.id!) && mi.productionType === 'OUTSOURCING') && (
                          <div className="space-y-3 p-4 bg-purple-50 rounded-2xl border border-purple-100">
                            <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest ml-1">Contract/Service Number (Outsourcing)</label>
                            <input
                              className="w-full p-4 bg-slate-100 border-2 border-purple-200 rounded-2xl font-black text-purple-600 outline-none cursor-not-allowed transition-all uppercase tracking-widest"
                              placeholder="Contract number is set from Technical Review"
                              value={contractNumber}
                              readOnly
                            />
                            <div className="text-[9px] text-purple-500 uppercase tracking-[0.2em] mt-1">Pre-filled from Technical Review and not editable here.</div>
                            <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest ml-1 mt-4">Contract Start Date (Outsourcing)</label>
                            <input
                              type="date"
                              min={!allowPastContractStart ? today : undefined}
                              className={`w-full p-4 bg-white border-2 rounded-2xl font-black text-purple-600 outline-none transition-all ${isContractStartDateInvalid ? 'border-red-500 bg-red-50' : 'border-purple-200 focus:border-purple-500'}`}
                              value={contractStartDate}
                              onChange={e => setContractStartDate(e.target.value)}
                            />
                            {isContractStartDateInvalid && (
                              <div className="text-[10px] text-red-600 font-bold uppercase tracking-widest mt-2">
                                Past start dates are prohibited unless the checkbox is checked.
                              </div>
                            )}
                            <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-purple-600">
                              <input
                                type="checkbox"
                                checked={allowPastContractStart}
                                onChange={e => setAllowPastContractStart(e.target.checked)}
                                className="w-4 h-4 rounded border-purple-300 text-purple-600 focus:ring-purple-500"
                              />
                              Allow a past contract start date
                            </label>
                          </div>
                        )}
                      </div>
                    )}

                    {activeAction.type === 'CANCEL_PO_BATCH' && (
                      <div className="space-y-6">
                        <div className="p-6 bg-rose-50 rounded-3xl border border-rose-100 flex justify-between items-center">
                          <div>
                            <div className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Cancelling PO</div>
                            <div className="text-xl font-black text-rose-900 uppercase tracking-tight">
                              {activeAction.comp?.poNumber || 'N/A'}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-rose-400 uppercase tracking-widest">Components</div>
                            <div className="text-lg font-black text-rose-600">{selectedCompIds.length}</div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Affected Components</label>
                          <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto p-1 custom-scrollbar">
                            {multiComps.map(({ comp: mc }) => (
                              <div key={mc.id} className="p-3 bg-white border border-rose-100 rounded-xl flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center text-xs">
                                  <i className="fa-solid fa-ban"></i>
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-[10px] font-black uppercase tracking-tight text-slate-400">{mc.componentNumber}</span>
                                  <span className="text-[11px] font-black uppercase tracking-tight text-slate-700">{mc.description}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="p-6 bg-rose-50 rounded-3xl border border-rose-100 space-y-4">
                          <p className="text-[11px] text-rose-800 font-black leading-relaxed uppercase">
                            Strategic Rollback: Reverting these components to the RFP stage. A mandatory comment is required for the audit trail.
                          </p>
                          <div className="space-y-1.5">
                            <label className="text-[9px] font-black text-rose-400 uppercase">Reason for Cancellation</label>
                            <textarea
                              className="w-full p-4 bg-white border border-rose-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-rose-100 placeholder:text-slate-300"
                              placeholder="e.g. Supplier stock issue, project change, incorrect price..."
                              rows={3}
                              value={resetReason} onChange={e => setResetReason(e.target.value)}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {activeAction.type === 'REVERT_PO' && (
                      <div className="space-y-6">
                        <div className="p-6 bg-amber-50 rounded-3xl border border-amber-100 flex justify-between items-center">
                          <div>
                            <div className="text-[10px] font-black text-amber-400 uppercase tracking-widest">Reverting PO to Award</div>
                            <div className="text-xl font-black text-amber-900 uppercase tracking-tight">
                              {activeAction.comp?.description}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-amber-400 uppercase tracking-widest">PO Number</div>
                            <div className="text-lg font-black text-amber-600">{activeAction.comp?.poNumber || 'N/A'}</div>
                          </div>
                        </div>

                        <div className="p-6 bg-amber-50 rounded-3xl border border-amber-100 space-y-4">
                          <p className="text-[11px] text-amber-800 font-black leading-relaxed uppercase">
                            This component will be reverted from ORDERED/WAITING_CONTRACT_START back to AWARDED status. This allows you to modify the award or issue a new PO.
                          </p>
                          <p className="text-[10px] text-amber-700 font-bold leading-relaxed">
                            <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                            Note: This may re-enable "Issue PO" buttons on other line items if they were blocked by order-wide readiness.
                          </p>
                        </div>
                      </div>
                    )}

                    {activeAction.type === 'REVERT_TO_PENDING' && (
                      <div className="space-y-6">
                        <div className="p-6 bg-orange-50 rounded-3xl border border-orange-100 flex justify-between items-center">
                          <div>
                            <div className="text-[10px] font-black text-orange-400 uppercase tracking-widest">Reverting Award to Pending</div>
                            <div className="text-xl font-black text-orange-900 uppercase tracking-tight">
                              {activeAction.comp?.description}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-orange-400 uppercase tracking-widest">Component ID</div>
                            <div className="font-mono text-sm font-black text-orange-600">{activeAction.comp?.id}</div>
                          </div>
                        </div>

                        <div className="p-6 bg-orange-50 rounded-3xl border border-orange-100 space-y-4">
                          <p className="text-[11px] text-orange-800 font-black leading-relaxed uppercase">
                            This component will be reverted from AWARDED back to PENDING_OFFER status. This allows you to restart the sourcing process from RFP.
                          </p>
                          <p className="text-[10px] text-orange-700 font-bold leading-relaxed bg-white border border-orange-200 rounded-2xl p-3">
                            <i className="fa-solid fa-lock mr-2 text-red-600"></i>
                            <strong>Important:</strong> All "Issue PO" buttons in this order will be DISABLED until ALL components are awarded again.
                          </p>
                        </div>
                      </div>
                    )}

                    {activeAction.type === 'REVIVE_CONTRACT' && (
                      <div className="space-y-6">
                        <div className="p-6 bg-emerald-50 rounded-3xl border border-emerald-100 flex justify-between items-center">
                          <div>
                            <div className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Reviving Contract</div>
                            <div className="text-xl font-black text-emerald-900 uppercase tracking-tight">
                              {activeAction.comp?.contractNumber || activeAction.comp?.componentNumber}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Old End Date</div>
                            <div className="text-lg font-black text-emerald-600">
                              {activeAction.comp?.contractStartDate && activeAction.comp?.contractDuration 
                                ? calculateContractEndDate(activeAction.comp.contractStartDate, activeAction.comp.contractDuration)?.toLocaleDateString()
                                : 'Unknown'}
                            </div>
                          </div>
                        </div>

                        <div className="p-6 bg-amber-50 border border-amber-200 rounded-3xl space-y-2">
                          <p className="text-[10px] text-amber-700 font-bold uppercase tracking-wide">
                            <i className="fa-solid fa-circle-info mr-1.5 text-amber-500"></i>
                            This extension will not incur any payment request from the customer.
                          </p>
                          <p className="text-[10px] text-amber-800 font-medium">
                            If a payment is needed, a new contract PO should be issued and this contract should be ended properly instead.
                          </p>
                        </div>

                        <div className="space-y-4 pt-2">
                          <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Reason for reviving</label>
                            <textarea
                              className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-sm font-bold outline-none focus:bg-white focus:border-emerald-500 transition-all placeholder:text-slate-300"
                              placeholder="Why is this contract being extended for free?"
                              rows={2}
                              value={reviveReason} onChange={e => setReviveReason(e.target.value)}
                            />
                          </div>

                          <div className="space-y-4 pt-4 border-t border-slate-100">
                            <div className="flex bg-slate-100 p-1 rounded-2xl mb-4">
                              <button 
                                onClick={() => setReviveMode('EXTENSION')}
                                className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${reviveMode === 'EXTENSION' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                              >
                                <i className="fa-solid fa-plus-circle"></i> Add Extension
                              </button>
                              <button 
                                onClick={() => setReviveMode('END_DATE')}
                                className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${reviveMode === 'END_DATE' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                              >
                                <i className="fa-solid fa-calendar-day"></i> Pick End Date
                              </button>
                            </div>

                            {reviveMode === 'EXTENSION' ? (
                              <div className="space-y-1.5 flex flex-col">
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Extension Duration (Months)</label>
                                <input
                                  type="number"
                                  className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-lg font-black text-emerald-600 outline-none focus:bg-white focus:border-emerald-500 transition-all"
                                  placeholder="e.g. 1"
                                  value={reviveDuration}
                                  onChange={e => setReviveDuration(e.target.value)}
                                />
                                <p className="text-[9px] text-slate-400 font-bold mt-1 ml-1 leading-relaxed">
                                  Original: {activeAction.comp?.contractDuration}. <span className="text-emerald-500">New Total: {parseInt(activeAction.comp?.contractDuration || '0') + (parseInt(reviveDuration) || 0)} Months.</span>
                                </p>
                              </div>
                            ) : (
                              <div className="space-y-1.5 flex flex-col">
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">New Contract End Date</label>
                                <input
                                  type="date"
                                  className="w-full p-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-lg font-black text-emerald-600 outline-none focus:bg-white focus:border-emerald-500 transition-all font-mono"
                                  value={reviveEndDate}
                                  onChange={e => setReviveEndDate(e.target.value)}
                                  min={calculateContractEndDate(activeAction.comp?.contractStartDate || '', activeAction.comp?.contractDuration || '')?.toISOString().split('T')[0]}
                                />
                                <p className="text-[9px] text-slate-400 font-bold mt-1 ml-1 leading-relaxed uppercase tracking-tight">
                                  Select a date further than {calculateContractEndDate(activeAction.comp?.contractStartDate || '', activeAction.comp?.contractDuration || '')?.toLocaleDateString()}. Duration will be auto-calculated.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {(activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK') && (
                      <div className="p-6 bg-rose-50 rounded-3xl border border-rose-100 space-y-4">
                        <p className="text-sm text-rose-800 font-bold leading-relaxed">
                          {activeAction.type === 'RESET'
                            ? 'Warning: This will void current sourcing progress and return the component to "Pending Offer".'
                            : 'Strategic Action: Reverting this entire order will move it back to the "Logged Registry". This should only be used to correct major entry errors.'
                          }
                        </p>
                        <div className="space-y-1.5">
                          <label className="text-[9px] font-black text-rose-400 uppercase">Mandatory Operational Reason</label>
                          <textarea
                            className="w-full p-4 bg-white border border-rose-200 rounded-2xl text-sm font-bold outline-none focus:ring-4 focus:ring-rose-100"
                            placeholder="e.g. Supplier failed to deliver, pricing expired, correction required..."
                            value={resetReason} onChange={e => setResetReason(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-10 flex gap-3">
                    <button onClick={closeModal} className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200 transition-all">Abort</button>
                    <button
                      disabled={isCommitProcurementDisabled}
                      onClick={handleExecuteAction}
                      className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${isCommitProcurementDisabled ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none' : activeAction?.type === 'RESET' || activeAction?.type === 'ORDER_ROLLBACK' || activeAction?.type === 'CANCEL_PO_BATCH' ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-100' : activeAction?.type === 'REVERT_PO' || activeAction?.type === 'REVERT_TO_PENDING' ? 'bg-orange-600 hover:bg-orange-700 text-white shadow-orange-100' : activeAction?.type === 'REVIVE_CONTRACT' ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-100' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-100'
                        }`}
                    >
                      {isActionLoading ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check-double"></i>}
                      {activeAction.type === 'RFP' ? 'Broadcast RFP' : activeAction.type === 'AWARD' ? 'Confirm Award' : activeAction.type === 'RESET' ? 'Confirm Reset' : activeAction.type === 'ORDER_ROLLBACK' ? 'Execute Rollback' : activeAction.type === 'CANCEL_PO_BATCH' ? 'Confirm Cancellation' : activeAction.type === 'REVERT_PO' ? 'Confirm Revert' : activeAction.type === 'REVERT_TO_PENDING' ? 'Confirm Revert to Pending' : activeAction.type === 'REVIVE_CONTRACT' ? 'Revive Contract' : 'Commit Procurement'}
                    </button>
                  </div>
                </div>
              </div>
            )
          }
          
          {/* --- Resource Replacement Modal --- */}
          {replacementModalInfo && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
              <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-10 animate-in zoom-in-95 duration-200 border border-slate-100">
                <div className="flex items-center gap-6 mb-8">
                  <div className="w-16 h-16 rounded-3xl bg-violet-50 text-violet-600 flex items-center justify-center text-3xl shadow-inner">
                    <i className="fa-solid fa-users-arrows"></i>
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Request Resource Replacement</h3>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                      {replacementModalInfo.comp.description}
                    </p>
                  </div>
                </div>

                {/* Contract Information Section */}
                <div className="bg-slate-50 rounded-2xl p-6 mb-6 border border-slate-100">
                  <h4 className="text-[11px] font-black text-slate-600 uppercase tracking-widest mb-4">Contract Information</h4>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase">Contract ID</label>
                      <p className="text-sm font-black text-blue-600 mt-1">
                        {replacementModalInfo.comp.contractNumber || replacementModalInfo.comp.componentNumber || 'N/A'}
                      </p>
                    </div>
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase">Duration</label>
                      <p className="text-sm font-black text-slate-800 mt-1">
                        {replacementModalInfo.comp.contractDuration || 'Not Set'}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[9px] font-bold text-slate-400 uppercase">Contract Start Date</label>
                      <p className="text-sm font-black text-slate-800 mt-1">
                        {replacementModalInfo.comp.contractStartDate 
                          ? new Date(replacementModalInfo.comp.contractStartDate).toLocaleDateString('en-US')
                          : 'Not Set'}
                      </p>
                      <p className={`text-[10px] font-bold mt-1 ${getContractStartStatus().isInPast ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {getContractStartStatus().isInPast 
                          ? '✓ Contract Already Started'
                          : `Starts in ${getContractStartStatus().daysUntilStart} days`}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Detailed Reason for Replacement</label>
                    <textarea
                      value={replacementReason}
                      onChange={e => setReplacementReason(e.target.value)}
                      className="w-full bg-slate-50 border-2 border-slate-100 rounded-2xl p-4 text-sm font-medium text-slate-700 outline-none focus:border-violet-500 focus:bg-violet-50/30 transition-all custom-scrollbar h-32"
                      placeholder="Explain why this outsourced resource is being replaced..."
                    ></textarea>
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">New Resource Start Date</label>
                    <input
                      type="date"
                      value={replacementStartDate}
                      onChange={e => {
                        const newDate = e.target.value;
                        setReplacementStartDate(newDate);
                        
                        // Validate immediately
                        if (newDate) {
                          const contractStart = new Date(replacementModalInfo.comp.contractStartDate || new Date());
                          const newResourceStart = new Date(newDate);
                          const now = new Date();
                          
                          if (contractStart < now && newResourceStart < contractStart) {
                            setReplacementDateError('❌ Resource start date cannot be earlier than contract start date (2/3/2026)');
                          } else {
                            setReplacementDateError('');
                          }
                        } else {
                          setReplacementDateError('');
                        }
                      }}
                      className={`w-full border-2 rounded-2xl p-4 text-sm font-black text-slate-700 outline-none transition-all uppercase ${
                        replacementDateError 
                          ? 'bg-rose-50 border-rose-300 focus:border-rose-500' 
                          : 'bg-slate-50 border-slate-100 focus:border-violet-500 focus:bg-violet-50/30'
                      }`}
                    />
                    {replacementDateError && (
                      <p className="text-rose-600 text-[10px] font-bold mt-2 flex items-center gap-1">
                        <i className="fa-solid fa-exclamation-circle"></i> {replacementDateError}
                      </p>
                    )}
                  </div>

                  {/* Option to update all contract dates if future contract */}
                  {replacementStartDate && !getContractStartStatus().isInPast && (
                    <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-4">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={updateAllContractDates}
                          onChange={e => setUpdateAllContractDates(e.target.checked)}
                          className="w-5 h-5 accent-blue-600"
                        />
                        <span className="text-[11px] font-bold text-blue-900">
                          Move all contract start dates in this order to {new Date(replacementStartDate).toLocaleDateString('en-US')}
                        </span>
                      </label>
                      <p className="text-[9px] text-blue-700 mt-2 ml-8">
                        This will update the contract start date for all related components in this order.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex gap-3 justify-end mt-10">
                  <button
                    onClick={() => { setReplacementModalInfo(null); setReplacementReason(''); setReplacementStartDate(''); setUpdateAllContractDates(false); setReplacementDateError(''); }}
                    className="px-6 py-3.5 bg-slate-100 text-slate-500 rounded-2xl text-[11px] font-black uppercase tracking-wider hover:bg-slate-200 transition-colors"
                    disabled={isReplacementPdfGenerating}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReplacementSubmit}
                    disabled={!replacementReason.trim() || !replacementStartDate.trim() || isReplacementPdfGenerating || !!replacementDateError}
                    className="px-8 py-3.5 bg-violet-600 text-white rounded-2xl text-[11px] font-black uppercase tracking-wider hover:bg-violet-700 hover:shadow-lg hover:shadow-violet-600/30 transition-all active:scale-95 disabled:opacity-50 disabled:active:scale-100 flex items-center justify-center min-w-[200px]"
                  >
                    {isReplacementPdfGenerating ? <i className="fa-solid fa-spinner fa-spin"></i> : <><i className="fa-solid fa-file-pdf mr-2"></i> Submit & Extract PDF</>}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* --- Procurement Resolution Modal (in-transit components before rollback) --- */}
          {
            pendingResolutions && !activeAction && (
              <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4 overflow-y-auto">
                <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-2xl p-10 my-8 animate-in zoom-in-95 duration-200 border border-slate-100">
                  <div className="flex items-center gap-6 mb-8">
                    <div className="w-16 h-16 rounded-3xl bg-amber-50 text-amber-600 flex items-center justify-center text-3xl shadow-inner">
                      <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">Outstanding Supplier Commitments</h3>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">
                        {pendingResolutions.length} Component{pendingResolutions.length > 1 ? 's' : ''} in transit — Resolve before rollback
                      </p>
                    </div>
                  </div>

                  <p className="text-sm text-slate-500 font-medium leading-relaxed mb-6">
                    The following components have active supplier commitments. You must decide the fate of each before rolling back this order:
                  </p>

                  <div className="space-y-3 max-h-72 overflow-y-auto custom-scrollbar pr-2">
                    {pendingResolutions.map(rec => (
                      <div key={rec.compId} className="bg-slate-50 border border-slate-100 rounded-2xl p-5">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <div className="font-black text-slate-800 text-sm">{rec.compDesc}</div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase mt-0.5 flex gap-3">
                              <span>Ref: {rec.componentNumber || 'N/A'}</span>
                              <span>Supplier: {rec.supplierName}</span>
                              <span>Qty: {rec.quantity}</span>
                            </div>
                            <div className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded mt-1.5 w-fit border ${rec.status === 'ORDERED' ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : rec.status === 'WAITING_CONTRACT_START' ? 'text-purple-600 bg-purple-50 border-purple-100' : 'text-amber-600 bg-amber-50 border-amber-100'
                              }`}>
                              {rec.status === 'ORDERED' ? 'PO Issued — Awaiting Delivery' : rec.status === 'WAITING_CONTRACT_START' ? 'Awaiting Contract Start' : 'Awarded — Pending PO Issuance'}
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => setResolutionChoices(prev => ({ ...prev, [rec.compId]: 'CANCEL_PO' }))}
                            className={`px-4 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest border-2 transition-all flex items-center justify-center gap-2 ${resolutionChoices[rec.compId] === 'CANCEL_PO'
                              ? 'bg-rose-600 text-white border-rose-600 shadow-lg'
                              : 'bg-white text-rose-600 border-rose-200 hover:border-rose-400'
                              }`}
                          >
                            <i className="fa-solid fa-ban"></i> Cancel Supplier PO
                          </button>
                          <button
                            onClick={() => setResolutionChoices(prev => ({ ...prev, [rec.compId]: 'RECEIVE_TO_STOCK' }))}
                            className={`px-4 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest border-2 transition-all flex items-center justify-center gap-2 ${resolutionChoices[rec.compId] === 'RECEIVE_TO_STOCK'
                              ? 'bg-emerald-600 text-white border-emerald-600 shadow-lg'
                              : 'bg-white text-emerald-600 border-emerald-200 hover:border-emerald-400'
                              }`}
                          >
                            <i className="fa-solid fa-boxes-stacked"></i> Receive to Stock
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-8 flex gap-3">
                    <button
                      onClick={closeModal}
                      className="flex-1 py-4 bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200"
                    >
                      Abort
                    </button>
                    <button
                      onClick={handleConfirmResolutions}
                      className="flex-[2] py-4 bg-amber-500 text-white font-black rounded-2xl uppercase text-[10px] tracking-widest shadow-xl shadow-amber-200 hover:bg-amber-600 transition-all flex items-center justify-center gap-2"
                    >
                      <i className="fa-solid fa-arrow-right"></i>
                      Confirm Resolutions & Continue
                    </button>
                  </div>
                </div>
              </div>
            )
          }

          {/* Hidden Template for Replacement PDF Extraction */}
          <div style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}>
            <div id="replacement-pdf-template" ref={replacementTemplateRef} style={{ width: '210mm', minHeight: '297mm', padding: '20mm', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif', backgroundColor: '#ffffff' }}>
              {replacementModalInfo && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #334155', paddingBottom: '20px', marginBottom: '30px' }}>
                    <div style={{ textAlign: 'center' }}>
                      {rasterizedLogo ? (
                        <img src={rasterizedLogo} alt="Company Logo" style={{ height: '70px', maxWidth: '220px', objectFit: 'contain', margin: '0 auto', display: 'block' }} />
                      ) : (
                        <h1 style={{ fontSize: '24px', fontWeight: 900, color: '#1e293b', margin: 0, textTransform: 'uppercase' }}>
                          {config.settings.companyName || 'Nexus ERP'}
                        </h1>
                      )}
                      
                      <div style={{ marginTop: '10px', fontSize: '10px', color: '#64748b' }}>
                        {rasterizedLogo && (
                          <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#1e293b', marginBottom: '4px' }}>
                            {config.settings.companyName || 'Nexus ERP'}
                          </div>
                        )}
                        <div>{config.settings.companyAddress}</div>
                        <div>{config.settings.companyPhone} | {config.settings.companyEmail}</div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <h2 style={{ fontSize: '28px', fontWeight: 900, color: '#000', margin: 0, letterSpacing: '-0.5px' }}>RESOURCE REPLACEMENT</h2>
                      <div style={{ marginTop: '8px', fontSize: '12px', fontWeight: 'bold' }}>
                        <span style={{ color: '#475569' }}>Date:</span>{' '}
                        <span style={{ color: '#000' }}>{new Date().toLocaleDateString('en-GB')}</span>
                      </div>
                      <div style={{ marginTop: '4px', fontSize: '12px', fontWeight: 'bold' }}>
                        <span style={{ color: '#475569' }}>Contract Number:</span>{' '}
                        <span style={{ color: '#000' }}>{replacementModalInfo.comp.contractNumber || replacementModalInfo.comp.componentNumber || '-'}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginBottom: '30px' }}>
                     <h3 style={{ fontSize: '14px', fontWeight: 900, color: '#334155', marginBottom: '10px', textTransform: 'uppercase' }}>Replacement Details</h3>
                     <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                       <tbody>
                          <tr>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', width: '30%', backgroundColor: '#f8fafc' }}>Contract ID</td>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', color: '#2563eb' }}>{replacementModalInfo.comp.contractNumber || replacementModalInfo.comp.componentNumber || '-'}</td>
                          </tr>
                          <tr>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', backgroundColor: '#f8fafc' }}>Description</td>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1' }}>{replacementModalInfo.comp.description}</td>
                          </tr>
                          <tr>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', backgroundColor: '#f8fafc' }}>Contract Duration</td>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1' }}>{replacementModalInfo.comp.contractDuration || 'N/A'}</td>
                          </tr>
                          <tr>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', backgroundColor: '#f8fafc' }}>Contract Start Date</td>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', color: replacementModalInfo.comp.originalStartDate || replacementModalInfo.comp.contractStartDate && new Date(replacementModalInfo.comp.originalStartDate || replacementModalInfo.comp.contractStartDate!) < new Date() ? '#dc2626' : '#059669' }}>{replacementModalInfo.comp.originalStartDate || replacementModalInfo.comp.contractStartDate ? new Date(replacementModalInfo.comp.originalStartDate || replacementModalInfo.comp.contractStartDate!).toLocaleDateString('en-GB') : 'N/A'}</td>
                          </tr>

                          <tr>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', backgroundColor: '#f8fafc' }}>New Resource Start Date</td>
                            <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', color: '#0ea5e9' }}>{replacementStartDate ? new Date(replacementStartDate).toLocaleDateString('en-GB') : '-'}</td>
                          </tr>
                          {updateAllContractDates && (
                            <tr>
                              <td style={{ padding: '8px', border: '1px solid #cbd5e1', fontWeight: 'bold', backgroundColor: '#dbeafe', color: '#0c4a6e' }}>All Contracts Updated</td>
                              <td style={{ padding: '8px', border: '1px solid #cbd5e1', backgroundColor: '#dbeafe', color: '#0c4a6e', fontWeight: 'bold' }}>Yes - All contract dates moved to {replacementStartDate ? new Date(replacementStartDate).toLocaleDateString('en-GB') : '-'}</td>
                            </tr>
                          )}
                       </tbody>
                     </table>
                  </div>

                  <div style={{ marginBottom: '30px' }}>
                    <h3 style={{ fontSize: '14px', fontWeight: 900, color: '#334155', marginBottom: '10px', textTransform: 'uppercase' }}>Reasoning</h3>
                    <div style={{ border: '1px solid #cbd5e1', padding: '15px', backgroundColor: '#f8fafc', whiteSpace: 'pre-wrap', fontSize: '12px', minHeight: '80px' }}>
                      {replacementReason || 'No reason provided.'}
                    </div>
                  </div>

                  <div style={{ marginTop: '50px', display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 'bold' }}>
                    <div style={{ width: '200px', borderTop: '1px solid #94a3b8', paddingTop: '10px', textAlign: 'center' }}>
                      Authorized By
                    </div>
                    <div style={{ width: '200px', borderTop: '1px solid #94a3b8', paddingTop: '10px', textAlign: 'center' }}>
                      Supplier Acknowledgement
                    </div>
                  </div>

                </>
              )}
            </div>
          </div>
        </>
      )}
    </div >
  );
};
