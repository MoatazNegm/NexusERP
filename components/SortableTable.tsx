import React, { useState, useCallback, useRef } from 'react';

export interface ColumnDef<T> {
    key: string;
    label: string;
    headerClassName?: string;
    cellClassName?: string;
    render: (row: T, index: number) => React.ReactNode;
    sortValue?: (row: T) => string | number;
    sortable?: boolean; // default true
}

interface SortableTableProps<T> {
    columns: ColumnDef<T>[];
    data: T[];
    rowKey: (row: T, index: number) => string;
    theadClassName?: string;
    rowClassName?: string | ((row: T, index: number) => string);
    emptyMessage?: string;
    emptyColSpan?: number;
    storageKey?: string; // localStorage key for persisting column order
}

export function SortableTable<T>({
    columns,
    data,
    rowKey,
    theadClassName = 'bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b',
    rowClassName = 'hover:bg-slate-50 transition-colors',
    emptyMessage = 'No data.',
    emptyColSpan,
    storageKey,
}: SortableTableProps<T>) {
    // Column order
    const [columnOrder, setColumnOrder] = useState<string[]>(() => {
        if (storageKey) {
            try {
                const saved = localStorage.getItem(`col-order-${storageKey}`);
                if (saved) {
                    const parsed = JSON.parse(saved) as string[];
                    // Validate all keys still exist
                    const colKeys = columns.map(c => c.key);
                    if (parsed.every(k => colKeys.includes(k)) && parsed.length === colKeys.length) {
                        return parsed;
                    }
                }
            } catch { }
        }
        return columns.map(c => c.key);
    });

    // Sort state
    const [sortKey, setSortKey] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

    // Drag state
    const dragCol = useRef<string | null>(null);
    const [dragOverCol, setDragOverCol] = useState<string | null>(null);

    const orderedColumns = columnOrder
        .map(key => columns.find(c => c.key === key))
        .filter(Boolean) as ColumnDef<T>[];

    // Sorting
    const handleSort = useCallback((col: ColumnDef<T>) => {
        if (col.sortable === false) return;
        if (sortKey === col.key) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(col.key);
            setSortDir('asc');
        }
    }, [sortKey]);

    const sortedData = React.useMemo(() => {
        if (!sortKey) return data;
        const col = columns.find(c => c.key === sortKey);
        if (!col || !col.sortValue) return data;
        const sorted = [...data].sort((a, b) => {
            const va = col.sortValue!(a);
            const vb = col.sortValue!(b);
            if (typeof va === 'number' && typeof vb === 'number') return va - vb;
            return String(va).localeCompare(String(vb));
        });
        return sortDir === 'desc' ? sorted.reverse() : sorted;
    }, [data, sortKey, sortDir, columns]);

    // Drag handlers
    const handleDragStart = (key: string) => {
        dragCol.current = key;
    };
    const handleDragOver = (e: React.DragEvent, key: string) => {
        e.preventDefault();
        setDragOverCol(key);
    };
    const handleDrop = (targetKey: string) => {
        const srcKey = dragCol.current;
        if (!srcKey || srcKey === targetKey) {
            dragCol.current = null;
            setDragOverCol(null);
            return;
        }
        setColumnOrder(prev => {
            const newOrder = [...prev];
            const srcIdx = newOrder.indexOf(srcKey);
            const tgtIdx = newOrder.indexOf(targetKey);
            newOrder.splice(srcIdx, 1);
            newOrder.splice(tgtIdx, 0, srcKey);
            if (storageKey) {
                try { localStorage.setItem(`col-order-${storageKey}`, JSON.stringify(newOrder)); } catch { }
            }
            return newOrder;
        });
        dragCol.current = null;
        setDragOverCol(null);
    };
    const handleDragEnd = () => {
        dragCol.current = null;
        setDragOverCol(null);
    };

    const getRowClass = (row: T, idx: number) => {
        if (typeof rowClassName === 'function') return rowClassName(row, idx);
        return rowClassName;
    };

    return (
        <table className="w-full text-left">
            <thead className={theadClassName}>
                <tr>
                    {orderedColumns.map(col => {
                        const isSortable = col.sortable !== false && !!col.sortValue;
                        const isSorted = sortKey === col.key;
                        return (
                            <th
                                key={col.key}
                                className={`${col.headerClassName || 'px-8 py-4'} ${isSortable ? 'cursor-pointer select-none' : ''} ${dragOverCol === col.key ? 'bg-blue-500/20' : ''} transition-colors`}
                                onClick={() => isSortable && handleSort(col)}
                                draggable
                                onDragStart={() => handleDragStart(col.key)}
                                onDragOver={(e) => handleDragOver(e, col.key)}
                                onDrop={() => handleDrop(col.key)}
                                onDragEnd={handleDragEnd}
                            >
                                <span className="flex items-center gap-1.5">
                                    {col.label}
                                    {isSortable && (
                                        <span className={`text-[8px] ${isSorted ? 'opacity-100' : 'opacity-30'}`}>
                                            {isSorted && sortDir === 'asc' ? '▲' : isSorted && sortDir === 'desc' ? '▼' : '⇅'}
                                        </span>
                                    )}
                                </span>
                            </th>
                        );
                    })}
                </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
                {sortedData.map((row, idx) => (
                    <tr key={rowKey(row, idx)} className={getRowClass(row, idx)}>
                        {orderedColumns.map(col => (
                            <td key={col.key} className={col.cellClassName || 'px-8 py-6'}>
                                {col.render(row, idx)}
                            </td>
                        ))}
                    </tr>
                ))}
                {sortedData.length === 0 && (
                    <tr>
                        <td colSpan={emptyColSpan || orderedColumns.length} className="px-8 py-16 text-center text-slate-300 italic text-xs font-black uppercase tracking-widest">
                            {emptyMessage}
                        </td>
                    </tr>
                )}
            </tbody>
        </table>
    );
}
