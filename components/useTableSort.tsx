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
// v1.0001247 (user report 2026-11-25, sort "not working" in the real UI): stored values are not always clean numbers / ISO
// dates. A number kept as text ('1,200.50', '75.5', 'L.E. 300', '12%') sorted as text ('75.5' after '75.25', '9' after
// '10,000'), and a column that mixed numbers with numeric text put all real numbers first. Such text is a number now.
const NUM_TEXT = /^\(?[-+\u2212]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\)?$/;
const CURRENCY = /(L\.E\.|EGP|USD|EUR|SAR|AED|GBP|\u062c\.\u0645|[$\u20ac%\u00a0\s])/g;
// Slash / dash dates as shown by toLocaleDateString ('11/24/2026', '24/11/2026', '24-11-2026'), with an optional time.
const SLASH_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
// Month-name dates ('Nov 24, 2026', '24 Nov 2026', 'November 24, 2026 10:00 AM').
const NAMED_DATE = /^(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})([ ,T].*)?$/;

type Norm = { kind: 0 } | { kind: 1; n: number } | { kind: 2; s: string };

const parseNumText = (s: string): number | null => {
  const t = s.replace(CURRENCY, '');
  if (!/\d/.test(t) || !NUM_TEXT.test(t)) return null;
  const neg = /[-\u2212]/.test(t) || /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[-+\u2212(),]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const parseDateText = (s: string): number | null => {
  if (ISO_DATE.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const m = SLASH_DATE.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    // month first (en-US, as the app shows dates) unless the first part cannot be a month
    let mon = a, day = b; if (a > 12 && b <= 12) { mon = b; day = a; }
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    let h = m[4] ? Number(m[4]) : 0; const mi = m[5] ? Number(m[5]) : 0; const se = m[6] ? Number(m[6]) : 0;
    if (m[7]) { const pm = /p/i.test(m[7]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    const t = new Date(y, mon - 1, day, h, mi, se).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (NAMED_DATE.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  return null;
};

const normalize = (v: unknown): Norm => {
  if (v === null || v === undefined) return { kind: 0 };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 1, n: v } : { kind: 0 };
  if (typeof v === 'boolean') return { kind: 1, n: v ? 1 : 0 };
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? { kind: 1, n: t } : { kind: 0 }; }
  if (typeof v === 'object') return { kind: 0 }; // an object / array is not a sortable value (never '[object Object]' text)
  const s = String(v).trim();
  // an empty cell, a placeholder or a broken value ('Invalid Date', 'NaN', 'undefined') always goes last
  if (s === '' || s === '-' || s === '\u2014' || s === '\u2013' || /^(n\/a|nan|null|undefined|invalid date)$/i.test(s)) return { kind: 0 };
  const n = parseNumText(s); if (n !== null) return { kind: 1, n };
  const t = parseDateText(s); if (t !== null) return { kind: 1, n: t };
  return { kind: 2, s };
};

// A date column's sort value: the time, or null (an empty cell, last in both directions) when the stored date cannot be read.
// v1.0001247: an order with the order date 'not a date' (shown as 'Invalid Date') came FIRST when the Orders tab sorted dates
// descending, because unreadable text sorted as text above every date.
export const asDate = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const t = parseDateText(s); if (t !== null) return t;
  const p = Date.parse(s); return Number.isFinite(p) ? p : null;
};

// A stable identity for a row (orders, customers, suppliers, payments, ...), used to break ties. The Finance data is
// re-fetched every 5 seconds (App.tsx sync); breaking ties by the position in the fetched array let equal rows swap
// places whenever the server answered in another order, which looked like a random sort. The position is the last resort.
const rowIdentity = (row: any): string => {
  if (row === null || typeof row !== 'object') return '';
  const pick = (o: any) => (o && typeof o === 'object') ? (o.id ?? o.key ?? o.orderId ?? o.supplierId ?? o.customerId ?? o.receiptNumber ?? o.poNumber ?? o.internalOrderNumber) : undefined;
  const v = pick(row) ?? pick(row.customer) ?? pick(row.supplier) ?? pick(row.order) ?? pick(row.e) ?? pick(row.p);
  return v === undefined || v === null || typeof v === 'object' ? '' : String(v);
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

// Stable, non-mutating sort. Empty cells stay at the end in both directions. Equal values keep a fixed order (row identity,
// then the incoming position), so a data refresh does not shuffle them. An accessor that throws counts as an empty cell.
// The older sort code (Orders, History, Tax Clearances, SortableTable) uses this too since v1.0001247.
export function sortRows<T>(rows: T[], accessor: SortAccessor<T>, dir: SortDir): T[] {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const decorated = rows.map((row, i) => {
    let v: unknown; try { v = accessor(row); } catch { v = null; }
    return { row, i, v, empty: normalize(v).kind === 0, id: rowIdentity(row) };
  });
  type D = typeof decorated[number];
  const tie = (x: D, y: D) => (x.id && y.id && x.id !== y.id) ? x.id.localeCompare(y.id, undefined, { numeric: true }) : x.i - y.i;
  decorated.sort((x, y) => {
    if (x.empty || y.empty) return x.empty === y.empty ? tie(x, y) : x.empty ? 1 : -1;
    const c = compareSortValues(x.v, y.v);
    if (c !== 0) return dir === 'desc' ? -c : c;
    return tie(x, y);
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
