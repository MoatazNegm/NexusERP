import React, { useState, useMemo } from 'react';
import { CustomerOrder, ManufacturingComponent, Supplier, ReplacementRequest } from '../types';

interface PartHistoryProps {
    orders: CustomerOrder[];
    suppliers: Supplier[];
}

interface PartRow {
    id: string;
    internalPN: string;
    mfrPN: string;
    description: string;
    qty: number;
    unit: string;
    purchaseDate: string;
    usageDate: string;
    price: number;
    supplier: string;
    orderRef: string;
    // Detail fields
    customerName: string;
    poNumber: string;
    status: string;
    itemDescription: string;
    rfpId: string;
    awardId: string;
    sendPoId: string;
    statusUpdatedAt: string;
    procurementStartedAt: string;
    source: string;
    productionType: string;
    orderLogs: { timestamp: string; message: string; status?: string; user?: string }[];
    replacementHistory?: ReplacementRequest[];
    contractNumber?: string;
    contractDuration?: string;
    contractStartDate?: string;
    scopeOfWork?: string;
}

type ColKey = keyof Pick<PartRow, 'internalPN' | 'mfrPN' | 'description' | 'qty' | 'purchaseDate' | 'usageDate' | 'price' | 'supplier'>;

const DEFAULT_COLUMNS: { key: ColKey; label: string; contractLabel: string; labelAr: string }[] = [
    { key: 'internalPN', label: 'Internal P#', contractLabel: 'Service ID', labelAr: 'الرقم الداخلي' },
    { key: 'mfrPN', label: 'Mfr/Supplier P#', contractLabel: 'Contract Ref', labelAr: 'رقم المصنع' },
    { key: 'description', label: 'Description', contractLabel: 'Scope of Work', labelAr: 'الوصف' },
    { key: 'qty', label: 'Qty', contractLabel: 'Qty / Goal', labelAr: 'الكمية' },
    { key: 'purchaseDate', label: 'Date of Purchase', contractLabel: 'Contract Date', labelAr: 'تاريخ الشراء' },
    { key: 'usageDate', label: 'Date of Usage', contractLabel: 'Completion Date', labelAr: 'تاريخ الاستخدام' },
    { key: 'price', label: 'Price', contractLabel: 'Contract Value', labelAr: 'السعر' },
    { key: 'supplier', label: 'Supplier', contractLabel: 'Contractor', labelAr: 'المورد' },
];

const STATUS_COLORS: Record<string, string> = {
    'PENDING_OFFER': 'bg-slate-100 text-slate-600',
    'RFP_SENT': 'bg-blue-100 text-blue-700',
    'AWARDED': 'bg-amber-100 text-amber-700',
    'ORDERED': 'bg-indigo-100 text-indigo-700',
    'RECEIVED': 'bg-emerald-100 text-emerald-700',
    'IN_MANUFACTURING': 'bg-purple-100 text-purple-700',
    'MANUFACTURED': 'bg-teal-100 text-teal-700',
    'RESERVED': 'bg-cyan-100 text-cyan-700',
    'CANCELLED': 'bg-rose-100 text-rose-600',
};

export const PartHistory: React.FC<PartHistoryProps> = ({ orders, suppliers }) => {
    const [search, setSearch] = useState('');
    const [columnOrder, setColumnOrder] = useState<ColKey[]>(DEFAULT_COLUMNS.map(c => c.key));
    const [sortKey, setSortKey] = useState<ColKey | null>('purchaseDate');
    const [sortAsc, setSortAsc] = useState(false);
    const [dragCol, setDragCol] = useState<ColKey | null>(null);
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'parts' | 'contracts'>('parts');

    // Flatten all components from all orders into PartRow[]
    const allParts = useMemo<PartRow[]>(() => {
        const rows: PartRow[] = [];
        orders.forEach(order => {
            order.items.forEach(item => {
                (item.components || []).forEach(comp => {
                    const supp = suppliers.find(s => s.id === comp.supplierId);

                    // Purchase date: use procurementStartedAt, statusUpdatedAt, or order date as fallback
                    const purchaseDate = comp.procurementStartedAt || comp.statusUpdatedAt || order.orderDate || order.dataEntryTimestamp || '';

                    // Determine usage date: when went into manufacturing
                    let usageDate = '';
                    if (['IN_MANUFACTURING', 'MANUFACTURED'].includes(comp.status || '')) {
                        usageDate = comp.statusUpdatedAt || '';
                    }

                    rows.push({
                        id: comp.id || `${order.id}-${item.id}-${comp.description}`,
                        internalPN: comp.componentNumber || '',
                        mfrPN: comp.supplierPartNumber || '',
                        description: comp.description || '',
                        qty: comp.quantity,
                        unit: comp.unit,
                        purchaseDate,
                        usageDate,
                        price: comp.unitCost || 0,
                        supplier: supp?.name || '',
                        orderRef: order.internalOrderNumber || '',
                        // Detail fields
                        customerName: order.customerName || '',
                        poNumber: comp.poNumber || '',
                        status: comp.status || '',
                        itemDescription: item.description || '',
                        rfpId: comp.rfpId || '',
                        awardId: comp.awardId || '',
                        sendPoId: comp.sendPoId || '',
                        statusUpdatedAt: comp.statusUpdatedAt || '',
                        procurementStartedAt: comp.procurementStartedAt || '',
                        source: comp.source || '',
                        productionType: item.productionType || 'MANUFACTURING',
                        orderLogs: (order.logs || []).filter(l =>
                            (l.message || '').toLowerCase().includes((comp.description || '').toLowerCase().substring(0, 15)) ||
                            (l.message || '').toLowerCase().includes((comp.componentNumber || '').toLowerCase()) ||
                            (l.message || '').toLowerCase().includes('component') ||
                            (l.message || '').toLowerCase().includes('rfp') ||
                            (l.message || '').toLowerCase().includes('award') ||
                            (l.message || '').toLowerCase().includes('po ')
                        ),
                        replacementHistory: comp.replacementHistory || [],
                        contractNumber: comp.contractNumber || '',
                        contractDuration: comp.contractDuration || '',
                        contractStartDate: comp.contractStartDate || '',
                        scopeOfWork: comp.scopeOfWork || '',
                    });
                });
            });
        });
        return rows;
    }, [orders, suppliers]);

    // Filter by type
    const typedParts = useMemo(() => {
        return allParts.filter(p => activeTab === 'contracts' ? p.productionType === 'OUTSOURCING' : p.productionType !== 'OUTSOURCING');
    }, [allParts, activeTab]);

    // Filter by search
    const filtered = useMemo(() => {
        const q = search.toLowerCase().trim();
        if (!q) return typedParts;
        return typedParts.filter(r =>
            r.internalPN.toLowerCase().includes(q) ||
            r.mfrPN.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q) ||
            r.supplier.toLowerCase().includes(q) ||
            r.orderRef.toLowerCase().includes(q) ||
            r.customerName.toLowerCase().includes(q)
        );
    }, [typedParts, search]);

    // Sort
    const sorted = useMemo(() => {
        if (!sortKey) return filtered;
        const copy = [...filtered];
        copy.sort((a, b) => {
            const va = a[sortKey];
            const vb = b[sortKey];
            if (typeof va === 'number' && typeof vb === 'number') {
                return sortAsc ? va - vb : vb - va;
            }
            const sa = String(va).toLowerCase();
            const sb = String(vb).toLowerCase();
            return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
        });
        return copy;
    }, [filtered, sortKey, sortAsc]);

    const handleSort = (key: ColKey) => {
        if (sortKey === key) {
            setSortAsc(!sortAsc);
        } else {
            setSortKey(key);
            setSortAsc(true);
        }
    };

    // Drag & drop column reorder
    const handleDragStart = (key: ColKey) => {
        setDragCol(key);
    };

    const handleDragOver = (e: React.DragEvent, targetKey: ColKey) => {
        e.preventDefault();
        if (!dragCol || dragCol === targetKey) return;
    };

    const handleDrop = (targetKey: ColKey) => {
        if (!dragCol || dragCol === targetKey) return;
        const newOrder = [...columnOrder];
        const fromIdx = newOrder.indexOf(dragCol);
        const toIdx = newOrder.indexOf(targetKey);
        newOrder.splice(fromIdx, 1);
        newOrder.splice(toIdx, 0, dragCol);
        setColumnOrder(newOrder);
        setDragCol(null);
    };

    const colMeta = DEFAULT_COLUMNS.reduce((acc, c) => {
        acc[c.key] = c;
        return acc;
    }, {} as Record<ColKey, typeof DEFAULT_COLUMNS[0]>);

    const formatDate = (d: string) => {
        if (!d) return '-';
        try { return new Date(d).toLocaleDateString(); } catch { return d; }
    };

    const formatDateTime = (d: string) => {
        if (!d) return '-';
        try {
            const dt = new Date(d);
            return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } catch { return d; }
    };

    const renderCell = (row: PartRow, key: ColKey) => {
        switch (key) {
            case 'price': return <span className="font-mono">{row.price.toLocaleString()} <span className="text-[9px] text-slate-400">L.E.</span></span>;
            case 'qty': return <span>{row.qty} <span className="text-[9px] text-slate-400">{row.unit}</span></span>;
            case 'purchaseDate': return formatDate(row.purchaseDate);
            case 'usageDate': return formatDate(row.usageDate);
            case 'internalPN': return <span className="font-mono text-blue-600">{row.internalPN || '-'}</span>;
            case 'mfrPN': return <span className="font-mono text-amber-700">{row.mfrPN || '-'}</span>;
            default: return String(row[key] || '-');
        }
    };

    const totalCols = columnOrder.length + 3; // # + columns + Order Ref + Actions

    return (
        <div className="space-y-6">
            <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200">
                <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                    <div>
                        <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">
                            {activeTab === 'contracts' ? 'Outsourcing Contract History' : 'Part & Component History'}
                        </h2>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">
                            Complete {activeTab === 'contracts' ? 'Contract' : 'Part'} Registry • {typedParts.length} Records • Drag column headers to reorder
                        </p>
                    </div>

                    <div className="flex gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100">
                        <button
                            onClick={() => setActiveTab('parts')}
                            className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'parts' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            Parts
                        </button>
                        <button
                            onClick={() => setActiveTab('contracts')}
                            className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'contracts' ? 'bg-white text-violet-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            Contracts
                        </button>
                    </div>

                    <div className="relative w-full md:w-96">
                        <input
                            type="text"
                            placeholder="Search by part number, description, supplier..."
                            className="w-full px-5 py-4 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:border-blue-500 transition-all font-bold text-sm"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 text-lg"></i>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50 border-b border-slate-100">
                            <tr>
                                <th className="px-4 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest w-8">#</th>
                                {columnOrder.map(key => (
                                    <th
                                        key={key}
                                        draggable
                                        onDragStart={() => handleDragStart(key)}
                                        onDragOver={(e) => handleDragOver(e, key)}
                                        onDrop={() => handleDrop(key)}
                                        onClick={() => handleSort(key)}
                                        className={`px-4 py-4 text-[10px] font-black uppercase tracking-widest cursor-pointer select-none transition-colors hover:bg-slate-100 ${dragCol === key ? 'bg-blue-50 text-blue-600' : 'text-slate-400'}`}
                                        style={{ cursor: 'grab' }}
                                    >
                                        <div className="flex items-center gap-2">
                                            <i className="fa-solid fa-grip-vertical text-[8px] text-slate-300"></i>
                                            <span>{activeTab === 'contracts' ? colMeta[key].contractLabel : colMeta[key].label}</span>
                                            {sortKey === key && (
                                                <i className={`fa-solid ${sortAsc ? 'fa-sort-up' : 'fa-sort-down'} text-blue-500`}></i>
                                            )}
                                        </div>
                                    </th>
                                ))}
                                <th className="px-4 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest">Order Ref</th>
                                <th className="px-4 py-4 text-[10px] font-black uppercase text-slate-400 tracking-widest w-12"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {sorted.map((row, idx) => (
                                <React.Fragment key={row.id + idx}>
                                    <tr
                                        className={`transition-colors cursor-pointer ${expandedRowId === row.id ? 'bg-blue-50' : 'hover:bg-blue-50/30'}`}
                                        onClick={() => setExpandedRowId(expandedRowId === row.id ? null : row.id)}
                                    >
                                        <td className="px-4 py-3 text-[10px] font-mono text-slate-300">{idx + 1}</td>
                                        {columnOrder.map(key => (
                                            <td key={key} className="px-4 py-3 text-xs font-bold text-slate-700 whitespace-nowrap">
                                                {renderCell(row, key)}
                                            </td>
                                        ))}
                                        <td className="px-4 py-3 text-[10px] font-mono font-black text-blue-600">{row.orderRef}</td>
                                        <td className="px-4 py-3 text-center">
                                            <i className={`fa-solid ${expandedRowId === row.id ? 'fa-chevron-up text-blue-500' : 'fa-chevron-down text-slate-300'} text-[10px] transition-transform`}></i>
                                        </td>
                                    </tr>
                                    {expandedRowId === row.id && (
                                        <tr>
                                            <td colSpan={totalCols} className="p-0">
                                                <div className="bg-slate-50 border-t border-b border-slate-200 p-6 animate-in slide-in-from-top-1 duration-200">
                                                    <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
                                                        {/* Component Info */}
                                                        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                                                            <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4 flex items-center gap-2">
                                                                <i className="fa-solid fa-microchip text-blue-500"></i> Component Details
                                                            </h4>
                                                            <div className="space-y-3">
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Status</span>
                                                                    <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${STATUS_COLORS[row.status] || 'bg-slate-100 text-slate-600'}`}>
                                                                        {row.status.replace(/_/g, ' ') || 'N/A'}
                                                                    </span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Source</span>
                                                                    <span className="text-xs font-black text-slate-700">{row.source}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">PO Number</span>
                                                                    <span className="text-xs font-mono font-black text-indigo-600">{row.poNumber || '-'}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Unit Cost</span>
                                                                    <span className="text-xs font-black text-slate-700">{row.price.toLocaleString()} L.E.</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Total Cost</span>
                                                                    <span className="text-xs font-black text-slate-900">{(row.price * row.qty).toLocaleString()} L.E.</span>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Order Info */}
                                                        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                                                            <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4 flex items-center gap-2">
                                                                <i className="fa-solid fa-file-invoice text-amber-500"></i> Order Context
                                                            </h4>
                                                            <div className="space-y-3">
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Customer</span>
                                                                    <span className="text-xs font-black text-slate-700">{row.customerName}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Order Ref</span>
                                                                    <span className="text-xs font-mono font-black text-blue-600">{row.orderRef}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Line Item</span>
                                                                    <span className="text-xs font-bold text-slate-600 truncate max-w-[150px]">{row.itemDescription}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Supplier</span>
                                                                    <span className="text-xs font-black text-slate-700">{row.supplier || '-'}</span>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Tracking IDs */}
                                                        <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                                                            <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4 flex items-center gap-2">
                                                                <i className="fa-solid fa-fingerprint text-emerald-500"></i> Tracking IDs
                                                            </h4>
                                                            <div className="space-y-3">
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">RFP ID</span>
                                                                    <span className="text-[10px] font-mono font-bold text-blue-600">{row.rfpId ? row.rfpId.substring(0, 8) + '...' : '-'}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Award ID</span>
                                                                    <span className="text-[10px] font-mono font-bold text-amber-600">{row.awardId ? row.awardId.substring(0, 8) + '...' : '-'}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">PO Batch ID</span>
                                                                    <span className="text-[10px] font-mono font-bold text-indigo-600">{row.sendPoId ? row.sendPoId.substring(0, 8) + '...' : '-'}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Procurement Started</span>
                                                                    <span className="text-[10px] font-bold text-slate-600">{formatDateTime(row.procurementStartedAt)}</span>
                                                                </div>
                                                                <div className="flex justify-between">
                                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Last Status Update</span>
                                                                    <span className="text-[10px] font-bold text-slate-600">{formatDateTime(row.statusUpdatedAt)}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Order Logs Timeline */}
                                                    {row.orderLogs.length > 0 && (
                                                        <div className="mt-6 bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                                                            <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4 flex items-center gap-2">
                                                                <i className="fa-solid fa-timeline text-violet-500"></i> Order Activity Log
                                                            </h4>
                                                            <div className="space-y-0 relative">
                                                                <div className="absolute left-[7px] top-3 bottom-3 w-[2px] bg-slate-100"></div>
                                                                {row.orderLogs.slice().reverse().map((log, logIdx) => (
                                                                    <div key={logIdx} className="flex items-start gap-4 py-2 relative">
                                                                        <div className="w-4 h-4 rounded-full bg-white border-2 border-slate-300 shrink-0 relative z-10 mt-0.5"></div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="flex items-center gap-3 flex-wrap">
                                                                                <span className="text-[10px] font-mono font-bold text-slate-400">{formatDateTime(log.timestamp)}</span>
                                                                                {log.status && (
                                                                                    <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${STATUS_COLORS[log.status] || 'bg-slate-100 text-slate-500'}`}>
                                                                                        {log.status.replace(/_/g, ' ')}
                                                                                    </span>
                                                                                )}
                                                                                {log.user && <span className="text-[9px] font-bold text-slate-400">by {log.user}</span>}
                                                                            </div>
                                                                            <p className="text-xs font-bold text-slate-600 mt-0.5 whitespace-pre-wrap leading-relaxed">
                                                                                {log.message}
                                                                                {row.productionType === 'OUTSOURCING' && log.message.startsWith('Component updated:') && (
                                                                                    <span className="block mt-1 font-normal italic text-[10px] text-violet-500">
                                                                                        (Contract: {row.contractNumber || row.orderRef}, Duration: {row.contractDuration || 'N/A'}, Start Date: {row.contractStartDate ? formatDate(row.contractStartDate) : 'N/A'}, Reason: {row.scopeOfWork || row.description})
                                                                                    </span>
                                                                                )}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Resource Replacement History */}
                                                    {row.replacementHistory && row.replacementHistory.length > 0 && (
                                                        <div className="mt-6 bg-white rounded-2xl p-5 border border-slate-200 shadow-sm border-l-4 border-l-violet-500">
                                                            <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-violet-600 mb-4 flex items-center gap-2">
                                                                <i className="fa-solid fa-clock-rotate-left"></i> Resource Replacement History
                                                            </h4>
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                                {row.replacementHistory.map((req, ridx) => (
                                                                    <div key={ridx} className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-[10px]">
                                                                        <div className="flex justify-between items-center mb-2">
                                                                            <span className="font-black text-slate-700 uppercase">Request Date: {formatDate(req.requestDate)}</span>
                                                                            <span className="bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full font-black">{req.remainingDuration}</span>
                                                                        </div>
                                                                        <div className="text-slate-500 font-bold italic mb-2">"{req.reason}"</div>
                                                                        <div className="flex items-center gap-2 text-slate-400 font-black">
                                                                            <span>Start: {formatDate(req.originalStartDate)}</span>
                                                                            <i className="fa-solid fa-arrow-right text-[8px] opacity-40"></i>
                                                                            <span className="text-violet-600">New: {formatDate(req.newStartDate)}</span>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
                {sorted.length === 0 && (
                    <div className="p-20 text-center flex flex-col items-center gap-4 text-slate-300">
                        <i className="fa-solid fa-box-open text-6xl opacity-10"></i>
                        <p className="font-black text-xs uppercase tracking-[0.3em]">
                            {search ? 'No matching records found' : 'No component history available'}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};
