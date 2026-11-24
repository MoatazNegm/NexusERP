import React, { useState, useCallback } from 'react';

// v1.0001244 (user order 2026-11-24): every table in Finance Operations is sortable by its columns, the same way as the
// Finance Operations Orders tab (handleSort in FinanceModule.tsx): click a header to sort by it, the first click sorts
// descending, a second click on the same header ascending; the header shows the same marks (unsorted, descending, ascending)
// as the Orders tab headers. The sort only re-orders the rows that are shown: it never changes a computed value (values
// are computed before the sort), and totals/footer rows stay where they are (they are rendered outside the sorted rows).
// One hook per component keeps the sort state of each of its tables under a table id, so nested tables rendered inside
// a .map() (one per order, one per supplier, ...) can be sorted without calling hooks in a loop.

export type SortDir = 'asc' | 'desc';
export type SortAccessor<T> = (row: T) => unknown;
export type SortAccessors<T> = Record<string, SortAccessor<T>>;
export type SortState = Record<string, { key: string; dir: SortDir }>;

// ISO-like dates ('2026-11-24', '2026-11-24T10:00:00.000Z', '2026-11-24 10:00') sort by time, not as text.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type Norm = { kind: 0 } | { kind: 1; n: number } | { kind: 2; s: string };

const normalize = (v: unknown): Norm => {
  if (v === null || v === undefined) return { kind: 0 };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 1, n: v } : { kind: 0 };
  if (typeof v === 'boolean') return { kind: 1, n: v ? 1 : 0 };
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? { kind: 1, n: t } : { kind: 0 }; }
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '—' || s === 'N/A') return { kind: 0 };
  if (ISO_DATE.test(s)) { const t = Date.parse(s); if (Number.isFinite(t)) return { kind: 1, n: t }; }
  return { kind: 2, s };
};

// Ascending comparison: numbers (and dates) before text; text uses a natural, case-insensitive compare
// (so 'PO-9' < 'PO-10' and Arabic text sorts by the locale). Empty values are handled by sortRows (always last).
export const compareSortValues = (a: unknown, b: unknown): number => {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.kind === 0 || nb.kind === 0) return na.kind === nb.kind ? 0 : na.kind === 0 ? 1 : -1;
  if (na.kind === 1 && nb.kind === 1) return na.n - nb.n;
  if (na.kind === 1) return -1;
  if (nb.kind === 1) return 1;
  return (na as { s: string }).s.localeCompare((nb as { s: string }).s, undefined, { numeric: true, sensitivity: 'base' });
};

// Stable, non-mutating sort. Empty cells stay at the end in both directions.
export function sortRows<T>(rows: T[], accessor: SortAccessor<T>, dir: SortDir): T[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const decorated = rows.map((row, i) => { const v = accessor(row); return { row, i, v, empty: normalize(v).kind === 0 }; });
  decorated.sort((x, y) => {
    if (x.empty || y.empty) return x.empty === y.empty ? x.i - y.i : x.empty ? 1 : -1;
    const c = compareSortValues(x.v, y.v);
    if (c !== 0) return dir === 'desc' ? -c : c;
    return x.i - y.i;
  });
  return decorated.map(d => d.row);
}

export function useTableSort(initial?: SortState) {
  const [state, setState] = useState<SortState>(initial || {});
  const requestSort = useCallback((table: string, key: string) => {
    setState(prev => {
      const cur = prev[table];
      // Same toggle as the Orders tab: a new column starts descending, the same column flips desc <-> asc.
      const dir: SortDir = cur && cur.key === key && cur.dir === 'desc' ? 'asc' : 'desc';
      return { ...prev, [table]: { key, dir } };
    });
  }, []);
  const sort = useCallback(<T,>(table: string, rows: T[], accessors: SortAccessors<T>): T[] => {
    const cur = state[table];
    if (!cur || !accessors[cur.key]) return rows;
    return sortRows(rows, accessors[cur.key], cur.dir);
  }, [state]);
  return { state, requestSort, sort };
}

export type TableSorter = ReturnType<typeof useTableSort>;

// Same marks as the Orders tab headers: '⇅' unsorted, '▼' descending, '▲' ascending.
export const SortIcon: React.FC<{ active: boolean; dir?: SortDir }> = ({ active, dir }) => (
  <span data-testid="sort-icon" data-sort-mark={active ? dir : 'none'}>
    {' '}{active ? (dir === 'asc' ? '\u25B2' : '\u25BC') : '\u21C5'}
  </span>
);

interface SortThProps {
  sorter: TableSorter;
  table: string;
  col: string;
  className?: string;
  children?: React.ReactNode;
  colSpan?: number;
  title?: string;
  style?: React.CSSProperties;
}

// A sortable <th>: click sorts by this column (first click descending, again ascending, like the Orders tab).
export const SortTh: React.FC<SortThProps> = ({ sorter, table, col, className = '', children, colSpan, title, style }) => {
  const cur = sorter.state[table];
  const active = !!cur && cur.key === col;
  return (
    <th
      className={`${className} cursor-pointer select-none`}
      onClick={() => sorter.requestSort(table, col)}
      colSpan={colSpan}
      title={title}
      style={style}
      aria-sort={active ? (cur!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-sort-table={table}
      data-sort-col={col}
      data-sort-dir={active ? cur!.dir : undefined}
    >
      {children}
      <SortIcon active={active} dir={active ? cur!.dir : undefined} />
    </th>
  );
};

// The same sortable header for tables drawn as CSS grids (a header row of <div> cells instead of <th>).
export const SortDiv: React.FC<Omit<SortThProps, 'colSpan'>> = ({ sorter, table, col, className = '', children, title, style }) => {
  const cur = sorter.state[table];
  const active = !!cur && cur.key === col;
  return (
    <div
      role="columnheader"
      className={`${className} cursor-pointer select-none`}
      onClick={() => sorter.requestSort(table, col)}
      title={title}
      style={style}
      aria-sort={active ? (cur!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-sort-table={table}
      data-sort-col={col}
      data-sort-dir={active ? cur!.dir : undefined}
    >
      {children}
      <SortIcon active={active} dir={active ? cur!.dir : undefined} />
    </div>
  );
};
