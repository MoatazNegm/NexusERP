
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
    type: 'RFP' | 'AWARD' | 'PO' | 'RESET' | 'ORDER_ROLLBACK' | 'CANCEL_PO_BATCH';
    order: CustomerOrder;
    item?: CustomerOrderItem;
    comp?: ManufacturingComponent;
  } | null>(null);

  const [rfpSelection, setRfpSelection] = useState<string[]>([]);
  const [rfpCompSelection, setRfpCompSelection] = useState<string[]>([]); // For multi-component RFP PDF
  const [rfpTemplateRef, rfpPrintData, setRfpPrintData] = [useRef<HTMLDivElement>(null), ...useState<{ order: CustomerOrder, comps: ManufacturingComponent[] } | null>(null)];
  const [isDownloadingRfp, setIsDownloadingRfp] = useState(false);
  const [awardSupplierId, setAwardSupplierId] = useState<string>('');
  const [awardCosts, setAwardCosts] = useState<Record<string, string>>({});
  const [awardTaxPercent, setAwardTaxPercent] = useState<string>('14');
  const [poNumberInput, setPoNumberInput] = useState<string>('');
  const [contractStartDate, setContractStartDate] = useState<string>('');
  const [allowPastContractStart, setAllowPastContractStart] = useState<boolean>(false);
  const [resetReason, setResetReason] = useState<string>('');
  const [compHistory, setCompHistory] = useState<any[] | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [selectedCompIds, setSelectedCompIds] = useState<string[]>([]);
  const [multiComps, setMultiComps] = useState<{ item: CustomerOrderItem, comp: ManufacturingComponent }[]>([]);

  // Computed values for contract date validation
  const today = new Date().toISOString().split('T')[0];
  const selectedOutsourced = multiComps.some(({ item: mi, comp: mc }) => selectedCompIds.includes(mc.id!) && mi.productionType === 'OUTSOURCING');
  const isContractStartDateInvalid = selectedOutsourced && contractStartDate.trim() && contractStartDate < today && !allowPastContractStart;
  const isCommitProcurementDisabled = isActionLoading != null || ((activeAction?.type === 'RESET' || activeAction?.type === 'ORDER_ROLLBACK' || activeAction?.type === 'CANCEL_PO_BATCH') && !resetReason.trim()) || (activeAction?.type === 'PO' && (!poNumberInput.trim() || selectedCompIds.length === 0 || (selectedOutsourced && !contractStartDate.trim()) || isContractStartDateInvalid));

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

    // Find all components in this order sharing the same PO number from THIS supplier
    const items: { item: CustomerOrderItem, comp: ManufacturingComponent }[] = [];
    order.items.forEach(i => {
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

    setPoPrintData({ order, items, supplier });
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
          
          // List of CSS properties to copy
          const stylesToCopy = [
            'display', 'position', 'width', 'height', 'margin', 'padding', 'border',
            'backgroundColor', 'color', 'fontSize', 'fontWeight', 'fontFamily',
            'textAlign', 'borderColor', 'borderWidth', 'borderStyle',
            'gridTemplateColumns', 'gridColumn', 'gridRow', 'gap',
            'flexDirection', 'justifyContent', 'alignItems', 'flex',
            'textDecoration', 'cursor', 'opacity', 'zIndex',
            'whiteSpace', 'wordWrap', 'overflow', 'direction'
          ];

          for (const prop of stylesToCopy) {
            let value = computedStyles.getPropertyValue(prop);
            if (value && value.trim()) {
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
              // Avoid setting computed shorthand properties that may conflict
              if (!prop.includes('border') || prop === 'border') {
                try {
                  (element.style as any)[prop] = value;
                } catch (e) {
                  // Silently skip invalid assignments
                }
              }
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
        
        if (contractStartDate) {
          payload.contractStartDate = contractStartDate;
        }

        await dataService.dispatchAction(order.id, 'issue-po-batch', payload);
      } else if (type === 'CANCEL_PO_BATCH') {
        if (!resetReason.trim()) throw new Error("Cancellation reason is required");

        setIsActionLoading('bulk-cancel');
        await dataService.dispatchAction(order.id, 'cancel-po-batch', {
          sendPoId: comp?.sendPoId
        });
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
    setContractStartDate('');
    setAllowPastContractStart(false);
    setResetReason('');
    setPendingResolutions(null);
    setResolutionChoices({});
    setPendingRollbackOrder(null);
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
          <i className="fa-solid fa-clock-rotate-left mr-2"></i> Part History
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
                    <div className="text-4xl font-black uppercase tracking-tighter mb-2" style={{ color: '#0f172a' }}>Request For Proposal</div>
                    <div className="flex items-center gap-3">
                      <div className="text-[10px] font-black uppercase tracking-widest" style={{ color: '#94a3b8' }}>Date</div>
                      <div className="font-mono text-sm font-black">{new Date().toLocaleDateString()}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-[10px] font-black uppercase tracking-widest" style={{ color: '#94a3b8' }}>Ref</div>
                      <div className="font-mono text-sm font-black" style={{ color: '#1d4ed8' }}>RFP-{rfpPrintData ? rfpPrintData.order.internalOrderNumber : activeAction!.order.internalOrderNumber}</div>
                    </div>
                  </div>
                </div>

                <div className="p-6 rounded-2xl border-2 mb-10 text-sm font-bold leading-relaxed" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a', color: '#334155' }}>
                  <p>Please provide your best commercial offer and lead time for the components listed below. Ensure your quotation clearly states unit prices and total amounts, excluding taxes. If applicable, please attach technical data sheets or compliance certificates.</p>
                </div>

                <div className="border-2 mb-8 flex flex-col" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-12 border-b-2 text-[11px] font-black uppercase text-center" style={{ borderColor: '#0f172a', backgroundColor: '#f8fafc' }}>
                    <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>#</div>
                    <div className="col-span-6 p-3 border-r-2 text-left" style={{ borderColor: '#0f172a' }}>Component Description & Specifications</div>
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
                            <div className="font-black text-xs leading-relaxed">{comp.scopeOfWork || comp.description}</div>
                            {comp.contractDuration && (
                              <div className="text-[10px] font-black uppercase mt-1" style={{ color: '#7c3aed' }}>Duration: {comp.contractDuration}</div>
                            )}
                            {comp.componentNumber && !comp.contractNumber && (
                              <div className="text-[9px] font-bold mt-1 uppercase tracking-widest" style={{ color: '#64748b' }}>(Internal P#: {comp.componentNumber})</div>
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
                  ) : (
                    activeAction!.order.items.flatMap(ci => (ci.components || []))
                      .filter(comp => rfpCompSelection.includes(comp.id || ''))
                      .map((comp, idx) => {
                        const externalPartNum = comp.supplierPartNumber || suppliers.flatMap(s => s.priceList || []).find(p => p.description.trim().toLowerCase() === comp.description.trim().toLowerCase())?.partNumber || '';
                        return (
                          <div key={comp.id} className="grid grid-cols-12 border-b text-center text-sm last:border-b-0" style={{ borderColor: '#e2e8f0' }}>
                            <div className="col-span-1 p-4 border-r-2 font-mono font-bold" style={{ borderColor: '#0f172a', color: '#94a3b8' }}>{idx + 1}</div>
                            <div className="col-span-6 p-4 border-r-2 text-left" style={{ borderColor: '#0f172a' }}>
                              <div className="font-black text-xs leading-relaxed">{comp.scopeOfWork || comp.description}</div>
                              {comp.contractDuration && (
                                <div className="text-[10px] font-black uppercase mt-1" style={{ color: '#7c3aed' }}>Duration: {comp.contractDuration}</div>
                              )}
                              {comp.componentNumber && !comp.contractNumber && (
                                <div className="text-[9px] font-bold mt-1 uppercase tracking-widest" style={{ color: '#64748b' }}>(Internal P#: {comp.componentNumber})</div>
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

                <div className="text-[9px] font-black uppercase tracking-widest text-center mt-20 pt-8 border-t-2" style={{ color: '#94a3b8', borderColor: '#0f172a' }}>
                  Generated by {config.settings.companyName || 'Nexus ERP'} Procurement Operations
                </div>
              </div>
            )}

            {/* PO PDF Template */}
            {poPrintData && (
              <div ref={poTemplateRef} className="po-print-template p-12" style={{ width: '800px', minHeight: '1100px', fontVariantLigatures: 'normal', direction: 'ltr', backgroundColor: '#ffffff', color: '#0f172a' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '40px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {rasterizedLogo && (
                      <div style={{ height: '64px', display: 'flex', alignItems: 'flex-start' }}>
                        <img src={rasterizedLogo} alt="Company Logo" style={{ maxHeight: '100%', maxWidth: '200px', objectFit: 'contain' }} />
                      </div>
                    )}
                    <div style={{ direction: 'rtl', textAlign: 'right', alignSelf: 'flex-start' }}>
                      <div style={{ fontSize: '20px', fontWeight: 900, color: '#0f172a' }}>{config.settings.companyName}</div>
                      <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569', whiteSpace: 'pre-line', lineHeight: '1.6' }}>{config.settings.companyAddress}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                  </div>
                </div>

                <div className="border-t-2 border-b-2 py-3 mb-8 flex justify-center items-center" style={{ borderColor: '#e2e8f0' }}>
                  <h2 className="text-xl font-black uppercase flex items-center gap-6">
                    <span>رقم الشراء : {poPrintData.items[0]?.comp.poNumber}</span>
                  </h2>
                </div>

                <div className="grid grid-cols-2 gap-8 mb-10">
                  <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-1 p-3 border-r-2 font-bold text-xs text-right" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>المطلوب من:</div>
                      <div className="col-span-2 p-3 font-black text-sm uppercase">{poPrintData.supplier.name}</div>
                    </div>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-1 p-3 border-r-2 font-bold text-xs text-right" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>العنوان :</div>
                      <div className="col-span-2 p-3 text-xs font-bold">{poPrintData.supplier.address || 'N/A'}</div>
                    </div>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-1 p-3 border-r-2 font-bold text-xs text-right" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>رقم طلب العميل</div>
                      <div className="col-span-2 p-3 font-mono font-black text-xs" style={{ color: '#2563eb' }}>{poPrintData.order.internalOrderNumber}</div>
                    </div>
                  </div>

                  <div className="border-2 divide-y-2" style={{ borderColor: '#0f172a' }}>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-2 p-3 font-black text-sm text-center tracking-widest">
                        {new Date(poPrintData.items[0]?.comp.statusUpdatedAt).toLocaleDateString()}
                      </div>
                      <div className="col-span-1 p-3 border-l-2 font-bold text-xs" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>التاريخ :</div>
                    </div>
                    <div className="p-3 text-center font-bold text-[10px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>
                      مأموريه ضرائب الشركات المساهمه - القاهره
                    </div>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">522 803 435</div>
                      <div className="col-span-1 p-3 border-l-2 font-bold text-[9px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>رقم التسجيل الضريبي :</div>
                    </div>
                    <div className="grid grid-cols-3" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-2 p-3 font-mono font-black text-xs text-center tracking-widest">00 212 00389 5</div>
                      <div className="col-span-1 p-3 border-l-2 font-bold text-[9px]" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>رقم الملف الضريبي :</div>
                    </div>
                  </div>
                </div>

                <div className="border-2 mb-10 min-h-[400px] flex flex-col" style={{ borderColor: '#0f172a' }}>
                  <div className="grid grid-cols-12 border-b-2 text-[11px] font-black uppercase text-center" style={{ borderColor: '#0f172a', backgroundColor: '#f8fafc' }}>
                    <div className="col-span-3 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Description (الوصف)</div>
                    <div className="col-span-2 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Part No.<br />رقم القطعة</div>
                    <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Price LE<br />السعر</div>
                    <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Qty<br />الكميه</div>
                    <div className="col-span-1 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Unit<br />الوحده</div>
                    <div className="col-span-2 p-3 border-r-2" style={{ borderColor: '#0f172a' }}>Start Date<br />تاريخ البدء</div>
                    <div className="col-span-2 p-3">Value القيمه</div>
                  </div>

                  {poPrintData.items.map(({ comp }, idx) => (
                    <div key={idx} className="grid grid-cols-12 border-b-2 text-center font-black" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-3 p-4 border-r-2 text-left text-sm flex flex-col justify-center" style={{ borderColor: '#0f172a' }}>
                        <span>{comp.scopeOfWork || comp.description}</span>
                        {comp.contractDuration && (
                          <span className="text-[9px] font-bold mt-1 uppercase" style={{ color: '#7c3aed' }}>Duration: {comp.contractDuration}</span>
                        )}
                        {comp.componentNumber && !comp.contractNumber && (
                          <span className="text-[8px] font-bold mt-0.5" style={{ color: '#94a3b8' }}>(Internal P#: {comp.componentNumber})</span>
                        )}
                      </div>
                      <div className="col-span-2 p-4 border-r-2 flex items-center justify-center font-mono text-xs break-all" style={{ borderColor: '#0f172a', color: '#1e40af' }}>
                        {comp.contractNumber || comp.supplierPartNumber || ''}
                      </div>

                      <div className="col-span-1 p-4 border-r-2 flex items-center justify-center text-sm" style={{ borderColor: '#0f172a' }}>
                        {comp.unitCost.toLocaleString()}
                      </div>
                      <div className="col-span-1 p-4 border-r-2 flex items-center justify-center text-sm" style={{ borderColor: '#0f172a' }}>
                        {comp.quantity}
                      </div>
                      <div className="col-span-1 p-4 border-r-2 flex items-center justify-center text-sm" style={{ borderColor: '#0f172a' }}>
                        {comp.unit === 'pcs' ? 'قطعة' : comp.unit}
                      </div>
                      <div className="col-span-2 p-4 border-r-2 flex items-center justify-center text-sm" style={{ borderColor: '#0f172a' }}>
                        {comp.contractStartDate ? new Date(comp.contractStartDate).toLocaleDateString() : '-'}
                      </div>
                      <div className="col-span-2 p-4 flex items-center justify-center text-base">
                        {(comp.quantity * comp.unitCost).toLocaleString()}
                      </div>
                    </div>
                  ))}

                  {Array.from({ length: Math.max(0, 8 - poPrintData.items.length) }).map((_, idx) => (
                    <div key={idx} className="grid grid-cols-12 border-b-2 h-10" style={{ borderColor: '#0f172a' }}>
                      <div className="col-span-3 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-2 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-1 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-1 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-1 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-2 border-r-2" style={{ borderColor: '#0f172a' }}></div>
                      <div className="col-span-2"></div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-between items-end">
                  <div className="w-64 border-2 divide-y-2 font-black" style={{ borderColor: '#0f172a' }}>
                    <div className="grid grid-cols-2" style={{ borderColor: '#0f172a' }}>
                      <div className="p-3 border-r-2 text-xs uppercase" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>Subtotal</div>
                      <div className="p-3 text-right">
                        {poPrintData.items.reduce((sum, { comp }) => sum + (comp.quantity * comp.unitCost), 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="grid grid-cols-2" style={{ borderColor: '#0f172a' }}>
                      <div className="p-3 border-r-2 text-[10px] uppercase" style={{ backgroundColor: '#f8fafc', borderColor: '#0f172a' }}>Tax</div>
                      <div className="p-3 text-right">
                        {poPrintData.items.reduce((sum, { comp }) => sum + ((comp.quantity * comp.unitCost) * ((comp.taxPercent || 0) / 100)), 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="grid grid-cols-2" style={{ backgroundColor: '#f1f5f9', borderColor: '#0f172a' }}>
                      <div className="p-3 border-r-2 text-sm uppercase" style={{ borderColor: '#0f172a' }}>TOTAL</div>
                      <div className="p-3 text-right text-xl">
                        {poPrintData.items.reduce((sum, { comp }) => {
                          const base = comp.quantity * comp.unitCost;
                          return sum + base + (base * ((comp.taxPercent || 0) / 100));
                        }, 0).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="text-right italic text-[10px] text-slate-400 opacity-50 mb-4 pr-10">
                    AUTHORIZED DIGITAL DOCUMENT
                  </div>
                </div>

                <div className="mt-16 pt-6 border-t-2 border-slate-900 flex justify-between px-4 text-[11px] font-black uppercase tracking-widest">
                  <span>AGENT / المختص</span>
                  <span>REFERENCE / المرجع</span>
                  <span>APPROVED / يعتمد</span>
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
                const allAwardedOrOrdered = comps.every(({ comp: cc }) => ['AWARDED', 'ORDERED', 'WAITING_CONTRACT_START', 'RECEIVED'].includes(cc.status || ''));
                const allAwarded = comps.every(({ comp: cc }) => cc.status === 'AWARDED');
                const anyReadyToOrder = comps.some(({ comp: cc }) => cc.status === 'AWARDED');
                const anyOrdered = comps.some(({ comp: cc }) => cc.status === 'ORDERED' || cc.status === 'WAITING_CONTRACT_START' || cc.status === 'RECEIVED');
                const allOrderedOrHigher = comps.every(({ comp: cc }) => cc.status === 'ORDERED' || cc.status === 'WAITING_CONTRACT_START' || cc.status === 'RECEIVED');
                const readyForPo = allAwarded;

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
                        {readyForPo && (
                          <button
                            disabled={o.status === OrderStatus.NEGATIVE_MARGIN}
                            onClick={async () => {
                              const po = await dataService.getUniquePoNumber();
                              setPoNumberInput(po);
                              // Find all AWARDED components regardless of supplier to present a grouped selector
                              const awarded = comps.filter(({ comp: cc }) => cc.status === 'AWARDED');
                              if (awarded.length > 0) {
                                // By default group by the first awarded component's supplier
                                const sId = awarded[0].comp.supplierId;
                                const sameSupplier = awarded.filter(a => a.comp.supplierId === sId);
                                setMultiComps(sameSupplier);
                                setSelectedCompIds(sameSupplier.map(m => m.comp.id!));
                                setActiveAction({ type: 'PO', order: o, item: sameSupplier[0].item, comp: sameSupplier[0].comp });
                              }
                            }}
                            className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase shadow-lg flex items-center gap-2 transition-all ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-100'
                              }`}
                          >
                            <i className="fa-solid fa-file-invoice"></i> Issue PO for All
                          </button>
                        )}
                        {!allAwarded && !allOrderedOrHigher && (
                          <div className="flex items-center gap-1.5 text-[8px] font-black text-amber-600 uppercase bg-amber-50 px-3 py-1.5 rounded-lg">
                            <i className="fa-solid fa-hourglass-half"></i>
                            All components must be awarded for PO
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Components List */}
                    <div className="divide-y divide-slate-100">
                      {comps.map(({ item: i, comp: c }) => (
                        <div key={c.id} className="flex flex-col lg:flex-row justify-between items-center p-6 hover:bg-blue-50/30 transition-all group">
                          <div className="flex gap-6 items-center w-full lg:w-auto">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg shadow-inner ${c.status === 'ORDERED' ? 'bg-emerald-50 text-emerald-600' :
                              c.status === 'WAITING_CONTRACT_START' ? 'bg-purple-50 text-purple-600' :
                              c.status === 'AWARDED' ? 'bg-amber-50 text-amber-600' : 'bg-white text-blue-500 shadow-sm'
                              }`}>
                              <i className={`fa-solid ${c.status === 'ORDERED' ? 'fa-truck-fast' : c.status === 'WAITING_CONTRACT_START' ? 'fa-calendar-check' : c.status === 'AWARDED' ? 'fa-file-signature' : 'fa-diagram-project'}`}></i>
                            </div>
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] font-black text-blue-600 font-mono tracking-widest uppercase">{c.componentNumber}</span>
                                {c.supplierPartNumber && <span className="text-[10px] font-black text-amber-600 font-mono tracking-widest uppercase border border-amber-200 bg-amber-50 px-1 rounded">MFR P/N: {c.supplierPartNumber}</span>}
                                <span className={`px-2 py-0.5 text-[8px] font-black rounded uppercase ${c.status === 'ORDERED' ? 'bg-emerald-600 text-white' :
                                  c.status === 'WAITING_CONTRACT_START' ? 'bg-purple-600 text-white' :
                                  c.status === 'AWARDED' ? 'bg-amber-600 text-white' : 'bg-slate-900 text-white'
                                  }`}>{(c.status || '').replace(/_/g, ' ')}</span>
                                {c.rfpId && ['RFP_SENT', 'AWARDED'].includes(c.status || '') && (
                                  <span className="text-[9px] font-black text-blue-600 uppercase border border-blue-200 bg-blue-50 px-2 rounded ml-1" title="RFP Batch Group">
                                    BATCH: {c.rfpId.substring(0, 6)}
                                  </span>
                                )}
                              </div>
                              <div className="font-black text-slate-800 text-base tracking-tight">{c.description}</div>
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
                          <div className="flex items-center gap-3 mt-4 lg:mt-0">
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
                                className="px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-black transition-all"
                              >Send RFP</button>
                            )}
                            {c.status === 'RFP_SENT' && (
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => handleDownloadExistingRfp(o, c, comps)}
                                  className="px-5 py-2.5 bg-white border-2 border-slate-900 text-slate-900 rounded-xl text-[10px] font-black uppercase shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2"
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
                                  className="px-6 py-3 bg-amber-600 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-amber-700 transition-all"
                                >Award Tender</button>
                              </div>
                            )}
                            {c.status === 'AWARDED' && (
                              <div className="flex flex-col items-end gap-1.5">
                                {!allAwarded && (
                                  <span className="text-[8px] font-black text-slate-400 uppercase">All components must be awarded first</span>
                                )}
                                {allAwarded && (
                                  <button
                                    disabled={o.status === OrderStatus.NEGATIVE_MARGIN}
                                    onClick={async () => {
                                      const po = await dataService.getUniquePoNumber();
                                      setPoNumberInput(po);
                                      // Find all awarded components sharing the same Award ID (and supplier) in THIS order
                                      const sameAwardGroup = comps.filter(x =>
                                        x.comp.status === 'AWARDED' &&
                                        x.comp.supplierId === c.supplierId &&
                                        (c.awardId ? x.comp.awardId === c.awardId : true)
                                      );
                                      setMultiComps(sameAwardGroup);
                                      setSelectedCompIds([c.id!]); // Default to only current
                                      setActiveAction({ type: 'PO', order: o, item: i, comp: c });
                                    }}
                                    className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase shadow-lg transition-all ${o.status === OrderStatus.NEGATIVE_MARGIN ? 'bg-slate-200 text-slate-400 cursor-not-allowed grayscale' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                                  >
                                    Issue PO
                                  </button>
                                )}
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
                                  className="px-5 py-2.5 bg-white border-2 border-blue-600 text-blue-600 rounded-xl text-[10px] font-black uppercase shadow-sm hover:bg-blue-50 transition-all flex items-center gap-2"
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
                                  className="px-5 py-2.5 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-rose-700 transition-all flex items-center gap-2"
                                >
                                  <i className="fa-solid fa-ban"></i> Cancel Order
                                </button>
                                <span className="text-[10px] font-black text-emerald-600 uppercase tracking-[0.15em] px-2 animate-pulse">
                                  <i className="fa-solid fa-truck-fast mr-1"></i>In Transit
                                </span>
                              </div>
                            )}
                            {c.status === 'WAITING_CONTRACT_START' && (
                              <div className="flex flex-col lg:flex-row items-start lg:items-center gap-3">
                                <button
                                  onClick={() => handleDownloadPO(o, c)}
                                  className="px-5 py-2.5 bg-white border-2 border-purple-600 text-purple-600 rounded-xl text-[10px] font-black uppercase shadow-sm hover:bg-purple-50 transition-all flex items-center gap-2"
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
                                  className="px-5 py-2.5 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-rose-700 transition-all flex items-center gap-2"
                                >
                                  <i className="fa-solid fa-ban"></i> Cancel Order
                                </button>
                                <div className="text-[10px] font-black text-purple-600 uppercase tracking-[0.15em] px-2 whitespace-nowrap">
                                  <i className="fa-solid fa-calendar-check mr-1"></i>Waiting Contract: {c.contractStartDate ? new Date(c.contractStartDate).toLocaleDateString() : 'TBD'}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
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
                        activeAction.type === 'RESET' || activeAction.type === 'ORDER_ROLLBACK' ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                      }`}>
                      <i className={`fa-solid ${activeAction.type === 'RFP' ? 'fa-paper-plane' :
                        activeAction.type === 'AWARD' ? 'fa-award' :
                          activeAction.type === 'RESET' ? 'fa-rotate-left' :
                            activeAction.type === 'ORDER_ROLLBACK' ? 'fa-file-export fa-flip-horizontal' : 'fa-file-invoice'
                        }`}></i>
                    </div>
                    <div>
                      <h3 className="text-xl font-black text-slate-800 uppercase tracking-tight">
                        {activeAction.type === 'RFP' ? 'Issue Request for Proposals' :
                          activeAction.type === 'AWARD' ? 'Commercial Award Selection' :
                            activeAction.type === 'RESET' ? 'Reset Sourcing Cycle' :
                              activeAction.type === 'ORDER_ROLLBACK' ? 'Order Workflow Rollback' : 'Confirm Purchase Order'}
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
                            <label className="text-[10px] font-black text-purple-600 uppercase tracking-widest ml-1">Contract Start Date (Outsourcing)</label>
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
                      className={`flex-[2] py-4 rounded-2xl font-black text-[10px] uppercase shadow-xl transition-all flex items-center justify-center gap-2 ${isCommitProcurementDisabled ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none' : activeAction?.type === 'RESET' || activeAction?.type === 'ORDER_ROLLBACK' || activeAction?.type === 'CANCEL_PO_BATCH' ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-100' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-100'
                        }`}
                    >
                      {isActionLoading ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-check-double"></i>}
                      {activeAction.type === 'RFP' ? 'Broadcast RFP' : activeAction.type === 'AWARD' ? 'Confirm Award' : activeAction.type === 'RESET' ? 'Confirm Reset' : activeAction.type === 'ORDER_ROLLBACK' ? 'Execute Rollback' : activeAction.type === 'CANCEL_PO_BATCH' ? 'Confirm Cancellation' : 'Commit Procurement'}
                    </button>
                  </div>
                </div>
              </div>
            )
          }
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
        </>
      )}
    </div >
  );
};
