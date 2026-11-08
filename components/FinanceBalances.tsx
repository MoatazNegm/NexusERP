import React, { useEffect, useMemo, useState } from 'react';
import { dataService } from '../services/dataService';
import { useLanguage } from '../contexts/LanguageContext';
import { DashboardCard } from './DashboardCard';

// R34 (user order 2026-11-08): Finance "Initial Balances" tab, Finance "Balances & Stock Value" report and the
// Dashboard cards. Figures come from GET /api/v1/finance/position (server computes every account and the stock value).

type Group = 'all' | 'company' | 'customer' | 'supplier' | 'ledger';

interface Account {
  key: string;
  group: 'company' | 'customer' | 'supplier' | 'ledger';
  kind: string;
  walletType?: string;
  label: string;
  labelAr: string;
  customerName?: string;
  supplierName?: string;
  balance: number;
  openingTotal: number;
  openingCount: number;
}

interface Position {
  generatedAt: string;
  accounts: Account[];
  summary: { cashBank: number; taxes: number; customerWallets: number; customerWalletsOutsidePOs?: number; poWallets?: number; receivables: number; supplierWallets: number; payables: number; otherLedger: number; openingTotal: number; openingCount: number };
  stock: { categories: { key: string; label: string; labelAr: string; onHand: boolean; value: number; quantity: number; lines: number; items: any[] }[]; totalOnHand: number; totalInTransit: number; totalWithTransit: number };
  canEnterOpening: boolean;
}

const fmt = (n: number) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const useCur = () => { const { language } = useLanguage(); return language === 'ar' ? 'ج.م' : 'L.E.'; };

const GROUP_LABELS: Record<Group, [string, string]> = {
  all: ['All accounts', 'كل الحسابات'],
  company: ['Company', 'الشركة'],
  customer: ['Customers', 'العملاء'],
  supplier: ['Suppliers', 'الموردون'],
  ledger: ['Other ledger accounts', 'حسابات دفتر أخرى'],
};

const usePosition = (refreshKey?: number) => {
  const [pos, setPos] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    dataService.getFinancePosition()
      .then(p => { if (alive) { setPos(p); setError(null); } })
      .catch(e => { if (alive) setError(e.message || 'Failed to load'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [refreshKey, tick]);
  return { pos, error, loading, reload: () => setTick(x => x + 1) };
};

const SearchBox: React.FC<{ value: string; onChange: (v: string) => void; placeholder: string }> = ({ value, onChange, placeholder }) => (
  <div className="relative w-full xl:w-96">
    <input
      type="text" placeholder={placeholder}
      className="w-full px-5 py-3 pl-12 bg-white border-2 border-slate-100 rounded-2xl outline-none focus:border-blue-500 font-bold transition-all shadow-sm"
      value={value} onChange={e => onChange(e.target.value)}
    />
    <i className="fa-solid fa-magnifying-glass absolute left-5 top-1/2 -translate-y-1/2 text-slate-300"></i>
  </div>
);

const GroupPills: React.FC<{ value: Group; onChange: (g: Group) => void; counts: Record<Group, number> }> = ({ value, onChange, counts }) => {
  const { language } = useLanguage();
  return (
    <div className="flex gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto w-full xl:w-auto max-w-full" style={{ scrollbarWidth: 'thin' }}>
      {(Object.keys(GROUP_LABELS) as Group[]).map(g => (
        <button
          key={g}
          data-testid={`ob-group-${g}`}
          onClick={() => onChange(g)}
          className={`px-5 py-2 min-h-[44px] rounded-lg text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap shrink-0 ${value === g ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
        >
          {language === 'ar' ? GROUP_LABELS[g][1] : GROUP_LABELS[g][0]}
          <span className="ml-1.5 px-1.5 py-0.5 bg-slate-700 text-white rounded-full text-[8px]">{counts[g] || 0}</span>
        </button>
      ))}
    </div>
  );
};

const groupBadge = (a: Account, language: string) => {
  const map: Record<string, [string, string, string]> = {
    company: ['Company', 'الشركة', 'bg-blue-50 text-blue-600 border-blue-100'],
    customer: ['Customer', 'عميل', 'bg-emerald-50 text-emerald-600 border-emerald-100'],
    supplier: ['Supplier', 'مورد', 'bg-rose-50 text-rose-600 border-rose-100'],
    ledger: ['Ledger', 'دفتر', 'bg-slate-50 text-slate-600 border-slate-200'],
  };
  const m = map[a.group] || map.ledger;
  return <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase border ${m[2]}`}>{language === 'ar' ? m[1] : m[0]}</span>;
};

// M4 (validator 2026-11-08): hints under accounts whose opening does not move a neighbouring account.
const accountHint = (a: Account, isAr: boolean): string | null => {
  if (a.walletType === 'po') return isAr
    ? `رصيد محفظة الأمر هو مال محتجز لهذا الأمر ولا يخفض الذمم المدينة له؛ لتعديل المستحق استخدم "${a.customerName || ''} / ذمم مدينة".`
    : `A PO wallet opening is money held for this PO; it does not reduce this PO's receivable. To change what the customer owes, use "${a.customerName || ''} / Accounts receivable".`;
  if (a.walletType === 'supplier_general') return isAr
    ? 'يسجل كدفعة مقدمة للمورد تغطي أوامر الشراء اللاحقة تلقائياً (أو بالتخصيص).'
    : 'Stored as a supplier advance: it covers the supplier\'s later POs automatically (or by Allocate).';
  return null;
};

// Accounts table (desktop) / card list (phone). With onAdjust it shows the entry button per account.
const AccountsList: React.FC<{ accounts: Account[]; onAdjust?: (a: Account) => void }> = ({ accounts, onAdjust }) => {
  const { language } = useLanguage();
  const cur = useCur();
  const isAr = language === 'ar';
  if (accounts.length === 0) {
    return (
      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm px-8 py-20 text-center text-slate-300 italic font-black uppercase tracking-widest text-xs">
        {isAr ? 'لا توجد حسابات مطابقة' : 'No matching accounts'}
      </div>
    );
  }
  return (
    <>
      <div className="hidden lg:block bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start" dir={isAr ? 'rtl' : 'ltr'}>
            <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
              <tr>
                <th className="px-8 py-5">{isAr ? 'الحساب' : 'Account'}</th>
                <th className="px-8 py-5">{isAr ? 'المجموعة' : 'Group'}</th>
                <th className="px-8 py-5 text-end">{isAr ? 'أرصدة افتتاحية' : 'Opening balances'}</th>
                <th className="px-8 py-5 text-end">{isAr ? 'الرصيد الحالي' : 'Current balance'}</th>
                {onAdjust && <th className="px-8 py-5 text-end">{isAr ? 'إجراء' : 'Action'}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {accounts.map(a => (
                <tr key={a.key} data-testid={`ob-row-${a.key}`} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-8 py-5">
                    <div className="font-black text-slate-800 text-sm">{isAr ? a.labelAr : a.label}</div>
                    {accountHint(a, isAr) && <div className="text-[10px] font-bold text-slate-400 mt-1 max-w-xl" data-testid={`ob-hint-${a.key}`}>{accountHint(a, isAr)}</div>}
                  </td>
                  <td className="px-8 py-5">{groupBadge(a, language)}</td>
                  <td className="px-8 py-5 text-end text-xs font-bold text-slate-500">
                    {a.openingCount > 0 ? <>{a.openingTotal > 0 ? '+' : ''}{fmt(a.openingTotal)} {cur} <span className="text-[9px] text-slate-400">({a.openingCount})</span></> : '-'}
                  </td>
                  <td className={`px-8 py-5 text-end font-black text-sm ${a.balance < 0 ? 'text-rose-600' : 'text-slate-800'}`} data-testid={`ob-balance-${a.key}`}>
                    {fmt(a.balance)} {cur}
                  </td>
                  {onAdjust && (
                    <td className="px-8 py-5 text-end">
                      <button
                        onClick={() => onAdjust(a)}
                        data-testid={`ob-adjust-${a.key}`}
                        className="px-4 py-2.5 min-h-[44px] bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all shadow-lg inline-flex items-center gap-2"
                      >
                        <i className="fa-solid fa-plus-minus"></i> {isAr ? 'رصيد افتتاحي' : 'Opening balance'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="lg:hidden grid grid-cols-1 sm:grid-cols-2 gap-3">
        {accounts.map(a => (
          <div key={a.key} data-testid={`ob-card-${a.key}`} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
            <div className="flex justify-between items-start gap-3">
              <div className="font-black text-slate-800 text-sm break-words min-w-0">{isAr ? a.labelAr : a.label}</div>
              <div className="shrink-0">{groupBadge(a, language)}</div>
            </div>
            {accountHint(a, isAr) && <div className="text-[10px] font-bold text-slate-400 break-words" data-testid={`ob-card-hint-${a.key}`}>{accountHint(a, isAr)}</div>}
            <div className="flex justify-between items-baseline gap-3">
              <span className="text-[10px] font-black text-slate-400 uppercase">{isAr ? 'الرصيد الحالي' : 'Current balance'}</span>
              <span className={`text-sm font-black ${a.balance < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{fmt(a.balance)} {cur}</span>
            </div>
            {a.openingCount > 0 && (
              <div className="flex justify-between items-baseline gap-3 pt-2 border-t border-slate-100">
                <span className="text-[10px] font-black text-slate-400 uppercase">{isAr ? 'أرصدة افتتاحية' : 'Opening balances'}</span>
                <span className="text-xs font-bold text-slate-500">{a.openingTotal > 0 ? '+' : ''}{fmt(a.openingTotal)} {cur} ({a.openingCount})</span>
              </div>
            )}
            {onAdjust && (
              <button
                onClick={() => onAdjust(a)}
                className="w-full py-3 min-h-[44px] bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all shadow-lg flex items-center justify-center gap-2"
              >
                <i className="fa-solid fa-plus-minus"></i> {isAr ? 'رصيد افتتاحي' : 'Opening balance'}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
};

const useFilteredAccounts = (pos: Position | null) => {
  const [group, setGroup] = useState<Group>('all');
  const [search, setSearch] = useState('');
  const accounts = pos?.accounts || [];
  const counts = useMemo(() => {
    const c: Record<Group, number> = { all: accounts.length, company: 0, customer: 0, supplier: 0, ledger: 0 };
    accounts.forEach(a => { c[a.group] = (c[a.group] || 0) + 1; });
    return c;
  }, [accounts]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter(a => (group === 'all' || a.group === group) && (!q || `${a.label} ${a.labelAr} ${a.key}`.toLowerCase().includes(q)));
  }, [accounts, group, search]);
  return { group, setGroup, search, setSearch, counts, filtered };
};

// --- Finance > Initial Balances ---
export const InitialBalancesView: React.FC<{ refreshKey?: number; onChanged?: () => void }> = ({ refreshKey, onChanged }) => {
  const { language } = useLanguage();
  const isAr = language === 'ar';
  const cur = useCur();
  const { pos, error, loading, reload } = usePosition(refreshKey);
  const f = useFilteredAccounts(pos);
  const [history, setHistory] = useState<any[]>([]);
  const [target, setTarget] = useState<Account | null>(null);
  const [direction, setDirection] = useState<'+' | '-'>('+');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => { dataService.getOpeningBalances().then(setHistory).catch(() => setHistory([])); }, [refreshKey, pos]);

  const openEntry = (a: Account) => { setTarget(a); setDirection('+'); setAmount(''); setReason(''); setReview(null); setFormError(null); setDone(null); };
  const closeEntry = () => { setTarget(null); setReview(null); setFormError(null); };

  const handleReview = async () => {
    if (!target) return;
    const raw = amount.trim();
    const n = Number(raw);
    if (!raw || !/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n) || n <= 0) { setFormError(isAr ? 'أدخل مبلغاً موجباً' : 'Enter a positive amount'); return; }
    if (!Number.isInteger(n)) { setFormError(isAr ? `مرفوض: الكسر ${n} غير مسموح (وحدات صحيحة فقط).` : `Rejected: fraction ${n} is not allowed (whole units only).`); return; }
    if (reason.trim().length < 3) { setFormError(isAr ? 'السبب إلزامي (3 أحرف على الأقل)' : 'A reason is required (at least 3 characters)'); return; }
    setBusy(true); setFormError(null);
    try {
      const r = await dataService.reviewOpeningBalance(target.key, direction === '-' ? -n : n, reason.trim());
      setReview(r);
    } catch (e: any) { setFormError(e.message || 'Review failed'); }
    finally { setBusy(false); }
  };

  const handleConfirm = async () => {
    if (!review) return;
    setBusy(true); setFormError(null);
    try {
      const r = await dataService.confirmOpeningBalance(review.reviewToken);
      setDone(isAr
        ? `تم تسجيل الرصيد الافتتاحي: ${review.account} الرصيد الجديد ${fmt(r.newBalance)} ${cur}`
        : `Opening balance booked: ${review.account}, new balance ${fmt(r.newBalance)} ${cur}`);
      closeEntry();
      reload();
      onChanged && onChanged();
    } catch (e: any) { setFormError(e.message || 'Confirmation failed'); setReview(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500" data-testid="initial-balances-view">
      <div className="bg-white p-6 md:p-8 rounded-[2.5rem] border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
            <i className="fa-solid fa-scale-unbalanced-flip"></i>
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight">{isAr ? 'الأرصدة الافتتاحية' : 'Initial Balances'}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
              {isAr ? 'المبلغ المؤكد يضاف إلى الرصيد الحالي للحساب (زيادة أو نقص) ويسجل في الدفتر' : 'The confirmed amount is added to the account\'s current balance (plus or minus) and recorded in the ledger'}
            </p>
          </div>
        </div>
        {pos && !pos.canEnterOpening && (
          <div className="p-4 bg-amber-50 text-amber-700 rounded-2xl text-xs font-bold border border-amber-100 flex items-center gap-3" data-testid="ob-readonly-note">
            <i className="fa-solid fa-lock"></i>{isAr ? 'إدخال الأرصدة الافتتاحية لمستخدمي المالية فقط. العرض للقراءة فقط.' : 'Only finance users may enter opening balances. This view is read-only for you.'}
          </div>
        )}
        {done && (
          <div className="p-4 bg-emerald-50 text-emerald-700 rounded-2xl text-xs font-bold border border-emerald-100 flex items-center gap-3" data-testid="ob-done">
            <i className="fa-solid fa-circle-check"></i>{done}
          </div>
        )}
        {error && <div className="p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3"><i className="fa-solid fa-circle-exclamation"></i>{error}</div>}
      </div>

      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
        <GroupPills value={f.group} onChange={f.setGroup} counts={f.counts} />
        <SearchBox value={f.search} onChange={f.setSearch} placeholder={isAr ? 'ابحث باسم الحساب، العميل، المورد، الأمر...' : 'Search account, customer, supplier, PO...'} />
      </div>

      {loading && !pos ? (
        <div className="py-20 text-center text-slate-300"><i className="fa-solid fa-spinner fa-spin text-2xl"></i></div>
      ) : (
        <AccountsList accounts={f.filtered} onAdjust={pos?.canEnterOpening ? openEntry : undefined} />
      )}

      {/* Audit trail of opening balances */}
      <div className="space-y-4">
        <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
          <i className="fa-solid fa-clock-rotate-left text-slate-400"></i> {isAr ? 'سجل الأرصدة الافتتاحية' : 'Opening balance history'}
        </h3>
        {history.length === 0 ? (
          <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm px-8 py-12 text-center text-slate-300 italic font-black uppercase tracking-widest text-xs" data-testid="ob-history-empty">
            {isAr ? 'لم يتم تسجيل أرصدة افتتاحية بعد' : 'No opening balances booked yet'}
          </div>
        ) : (
          <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[720px]" dir={isAr ? 'rtl' : 'ltr'} data-testid="ob-history">
                <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100">
                  <tr>
                    <th className="px-6 py-4">{isAr ? 'التاريخ' : 'Date'}</th>
                    <th className="px-6 py-4">{isAr ? 'الحساب' : 'Account'}</th>
                    <th className="px-6 py-4 text-end">{isAr ? 'الرصيد السابق' : 'Old balance'}</th>
                    <th className="px-6 py-4 text-end">{isAr ? 'المبلغ' : 'Amount'}</th>
                    <th className="px-6 py-4 text-end">{isAr ? 'الرصيد الجديد' : 'New balance'}</th>
                    <th className="px-6 py-4">{isAr ? 'السبب' : 'Reason'}</th>
                    <th className="px-6 py-4">{isAr ? 'المستخدم' : 'User'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {history.map(h => (
                    <tr key={h.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4 text-xs font-bold text-slate-500 whitespace-nowrap">{new Date(h.date).toLocaleString()}</td>
                      <td className="px-6 py-4 font-black text-slate-800 text-xs">{h.account}</td>
                      <td className="px-6 py-4 text-end text-xs font-bold text-slate-500 whitespace-nowrap">{fmt(h.oldBalance)}</td>
                      <td className={`px-6 py-4 text-end font-black text-sm whitespace-nowrap ${h.amount < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{h.amount > 0 ? '+' : ''}{fmt(h.amount)} {cur}</td>
                      <td className="px-6 py-4 text-end font-black text-slate-800 text-sm whitespace-nowrap">{fmt(h.newBalance)}</td>
                      <td className="px-6 py-4 text-xs font-bold text-slate-500">{h.reason}</td>
                      <td className="px-6 py-4 text-xs font-bold text-slate-500">{h.user}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {target && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[200] flex items-center justify-center p-4" data-testid="ob-modal">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-2xl p-6 sm:p-10 animate-in zoom-in-95 border border-slate-100 max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-center gap-4 sm:gap-6 mb-8">
              <div className={`w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-3xl flex items-center justify-center text-2xl sm:text-3xl shadow-inner ${review ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                <i className={`fa-solid ${review ? 'fa-clipboard-check' : 'fa-scale-unbalanced-flip'}`}></i>
              </div>
              <div className="min-w-0">
                <h3 className="text-lg sm:text-xl font-black text-slate-800 uppercase tracking-tight">
                  {review ? (isAr ? 'مراجعة وتأكيد (الخطوة 2 من 2)' : 'Review and confirm (step 2 of 2)') : (isAr ? 'رصيد افتتاحي (الخطوة 1 من 2)' : 'Opening balance (step 1 of 2)')}
                </h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest break-words">{isAr ? target.labelAr : target.label}</p>
              </div>
            </div>

            {accountHint(target, isAr) && (
              <div className="mb-6 p-4 bg-blue-50 text-blue-700 rounded-2xl text-xs font-bold border border-blue-100 flex items-start gap-3" data-testid="ob-modal-hint">
                <i className="fa-solid fa-circle-info mt-0.5"></i><span className="break-words min-w-0">{accountHint(target, isAr)}</span>
              </div>
            )}

            {formError && <div className="mb-6 p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3" data-testid="ob-error"><i className="fa-solid fa-circle-exclamation"></i>{formError}</div>}

            {!review ? (
              <div className="space-y-6">
                <div className="flex justify-between items-baseline p-4 rounded-2xl bg-slate-50 border border-slate-100">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{isAr ? 'الرصيد الحالي' : 'Current balance'}</span>
                  <span className="font-black text-slate-800">{fmt(target.balance)} {cur}</span>
                </div>
                <div className="flex gap-3 sm:gap-4">
                  <button
                    onClick={() => setDirection('+')}
                    data-testid="ob-dir-plus"
                    className={`flex-1 py-4 min-h-[44px] rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 ${direction === '+' ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'bg-slate-50 border-slate-100 text-slate-400'}`}
                  >
                    <i className="fa-solid fa-plus-circle mr-2"></i> {isAr ? 'زيادة (+)' : 'Increase (+)'}
                  </button>
                  <button
                    onClick={() => setDirection('-')}
                    data-testid="ob-dir-minus"
                    className={`flex-1 py-4 min-h-[44px] rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all border-2 ${direction === '-' ? 'bg-rose-50 border-rose-500 text-rose-700' : 'bg-slate-50 border-slate-100 text-slate-400'}`}
                  >
                    <i className="fa-solid fa-minus-circle mr-2"></i> {isAr ? 'نقص (-)' : 'Decrease (-)'}
                  </button>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{isAr ? 'المبلغ' : 'Amount'} ({cur}) - {isAr ? 'وحدات صحيحة فقط' : 'whole units only'}</label>
                  <input
                    type="number" step="1" min="1" inputMode="numeric" autoFocus
                    data-testid="ob-amount"
                    className="w-full p-4 border rounded-2xl bg-slate-50 font-black text-2xl outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                    value={amount} onChange={e => setAmount(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">{isAr ? 'السبب' : 'Reason'}</label>
                  <input
                    type="text"
                    data-testid="ob-reason"
                    className="w-full p-4 border rounded-2xl bg-slate-50 text-sm font-bold outline-none focus:ring-4 focus:ring-blue-50 focus:bg-white"
                    value={reason} onChange={e => setReason(e.target.value)}
                    placeholder={isAr ? 'مثال: رصيد البنك في بداية التشغيل' : 'e.g. bank balance at go-live'}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3" data-testid="ob-review">
                {[
                  [isAr ? 'الحساب' : 'Account', review.account, 'text-slate-800'],
                  [isAr ? 'الرصيد الحالي' : 'Old balance', `${fmt(review.oldBalance)} ${cur}`, 'text-slate-800'],
                  [isAr ? 'المبلغ المضاف' : 'Delta', `${review.delta > 0 ? '+' : ''}${fmt(review.delta)} ${cur}`, review.delta < 0 ? 'text-rose-600' : 'text-emerald-600'],
                  [isAr ? 'الرصيد الجديد' : 'New balance', `${fmt(review.newBalance)} ${cur}`, 'text-blue-700'],
                  [isAr ? 'السبب' : 'Reason', review.reason, 'text-slate-600'],
                ].map(([k, v, cls], i) => (
                  <div key={i} className="flex justify-between items-baseline gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-100">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest shrink-0">{k}</span>
                    <span className={`font-black text-end break-words min-w-0 ${cls}`} data-testid={`ob-review-${i}`}>{v}</span>
                  </div>
                ))}
                <div className="p-4 bg-amber-50 text-amber-700 rounded-2xl text-xs font-bold border border-amber-100 flex items-center gap-3">
                  <i className="fa-solid fa-triangle-exclamation"></i>
                  {isAr ? 'لا يمكن تعديل الرصيد الافتتاحي بعد التأكيد؛ للتصحيح سجل مبلغاً عكسياً.' : 'An opening balance cannot be edited after confirmation; to correct it, book a reverse amount.'}
                </div>
              </div>
            )}

            <div className="mt-10 flex flex-col-reverse sm:flex-row gap-3">
              <button
                onClick={review ? () => setReview(null) : closeEntry}
                data-testid="ob-cancel"
                className="flex-1 py-4 min-h-[44px] bg-slate-100 text-slate-500 font-black rounded-2xl uppercase text-[10px] tracking-widest hover:bg-slate-200"
              >
                {review ? (isAr ? 'رجوع' : 'Back') : (isAr ? 'إلغاء' : 'Cancel')}
              </button>
              <button
                onClick={review ? handleConfirm : handleReview}
                disabled={busy}
                data-testid={review ? 'ob-confirm' : 'ob-review-btn'}
                className="flex-[2] py-4 min-h-[44px] bg-slate-900 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 hover:bg-black transition-all"
              >
                {busy ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className={`fa-solid ${review ? 'fa-check-double' : 'fa-eye'}`}></i>}
                {review ? (isAr ? 'تأكيد الرصيد الافتتاحي' : 'Confirm opening balance') : (isAr ? 'مراجعة' : 'Review')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Stock value block shared by the Finance report.
const StockValueBlock: React.FC<{ stock: Position['stock'] }> = ({ stock }) => {
  const { language } = useLanguage();
  const isAr = language === 'ar';
  const cur = useCur();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden" data-testid="fp-stock">
      <div className="p-6 md:p-8 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h3 className="text-lg font-black text-slate-800 uppercase tracking-tight flex items-center gap-2"><i className="fa-solid fa-boxes-stacked text-slate-400"></i>{isAr ? 'قيمة المخزون الحالية' : 'Current Stock Value'}</h3>
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5"><span data-testid="fp-stock-basis">{isAr ? 'مقيم بالتكلفة: المكونات بآخر تكلفة، المنتجات بالتكلفة الفعلية أو تكلفة المكونات (سعر البيع فقط عند عدم وجود تكلفة)' : 'Valued at cost: components at last cost, products at real or component cost (selling price only when no cost is known)'}</span></p>
        </div>
        <div className="text-end">
          <div className="text-2xl font-black text-slate-800" data-testid="fp-stock-total">{fmt(stock.totalOnHand)} {cur}</div>
          <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">{isAr ? 'إجمالي المخزون الفعلي' : 'Total on hand'}</div>
        </div>
      </div>
      <div className="divide-y divide-slate-50">
        {stock.categories.map(c => (
          <div key={c.key} data-testid={`fp-stock-${c.key}`}>
            <button onClick={() => setOpen(open === c.key ? null : c.key)} className="w-full px-6 md:px-8 py-4 min-h-[44px] flex justify-between items-center gap-4 hover:bg-slate-50/50 transition-colors text-start">
              <div className="min-w-0">
                <div className="font-black text-slate-800 text-sm break-words">{isAr ? c.labelAr : c.label}</div>
                <div className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">
                  {c.lines} {isAr ? 'بند' : 'lines'} · {isAr ? 'الكمية' : 'qty'} {c.quantity.toLocaleString()}
                  {!c.onHand && <span className="ml-2 px-1.5 py-0.5 rounded text-[8px] font-black uppercase border bg-amber-50 text-amber-600 border-amber-100">{isAr ? 'خارج الإجمالي' : 'not in total'}</span>}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-black text-sm text-slate-800">{fmt(c.value)} {cur}</span>
                <i className={`fa-solid fa-chevron-${open === c.key ? 'up' : 'down'} text-slate-300 text-xs`}></i>
              </div>
            </button>
            {open === c.key && (
              <div className="px-6 md:px-8 pb-4">
                {c.items.length === 0 ? (
                  <div className="text-[10px] font-bold text-slate-300 italic uppercase">{isAr ? 'لا توجد بنود' : 'No items'}</div>
                ) : (
                  <div className="overflow-x-auto rounded-2xl border border-slate-100">
                    <table className="w-full text-start min-w-[560px]" dir={isAr ? 'rtl' : 'ltr'}>
                      <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest">
                        <tr>
                          <th className="px-4 py-3">{isAr ? 'البند' : 'Item'}</th>
                          <th className="px-4 py-3">{isAr ? 'المرجع' : 'Ref'}</th>
                          <th className="px-4 py-3 text-end">{isAr ? 'الكمية' : 'Qty'}</th>
                          <th className="px-4 py-3 text-end">{isAr ? 'قيمة الوحدة' : 'Unit value'}</th>
                          <th className="px-4 py-3 text-end">{isAr ? 'القيمة' : 'Value'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {c.items.map((it: any) => (
                          <tr key={it.id}>
                            <td className="px-4 py-3 text-xs font-bold text-slate-700">{it.sku ? <span className="font-mono text-slate-400 mr-2">{it.sku}</span> : null}{it.description}</td>
                            <td className="px-4 py-3 text-xs font-bold text-slate-500">{it.ref}</td>
                            <td className="px-4 py-3 text-end text-xs font-bold text-slate-700">{Number(it.quantity).toLocaleString()}</td>
                            <td className="px-4 py-3 text-end text-xs font-bold text-slate-500">{fmt(it.unitValue)}</td>
                            <td className="px-4 py-3 text-end text-xs font-black text-slate-800">{fmt(it.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div className="px-6 md:px-8 py-4 flex justify-between items-center gap-4 bg-slate-50">
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{isAr ? 'الإجمالي مع البضائع في الطريق' : 'Total incl. in transit'}</span>
          <span className="font-black text-sm text-slate-800" data-testid="fp-stock-total-transit">{fmt(stock.totalWithTransit)} {cur}</span>
        </div>
      </div>
    </div>
  );
};

const SUMMARY_TILES: { key: keyof Position['summary']; en: string; ar: string; icon: string; color: string }[] = [
  { key: 'cashBank', en: 'Cash / Bank', ar: 'النقدية / البنك', icon: 'fa-building-columns', color: 'text-emerald-600' },
  { key: 'customerWallets', en: 'Customer wallets', ar: 'محافظ العملاء', icon: 'fa-wallet', color: 'text-teal-600' },
  { key: 'receivables', en: 'Accounts receivable', ar: 'ذمم مدينة', icon: 'fa-file-invoice', color: 'text-sky-600' },
  { key: 'supplierWallets', en: 'Supplier general wallets', ar: 'محافظ الموردين العامة', icon: 'fa-truck-ramp-box', color: 'text-indigo-600' },
  { key: 'payables', en: 'Accounts payable', ar: 'ذمم دائنة', icon: 'fa-hand-holding-dollar', color: 'text-rose-600' },
  { key: 'taxes', en: 'Taxes', ar: 'الضرائب', icon: 'fa-landmark', color: 'text-violet-600' },
  { key: 'otherLedger', en: 'Other ledger accounts', ar: 'حسابات دفتر أخرى', icon: 'fa-book', color: 'text-slate-700' },
];

// --- Finance > Balances & Stock Value (one report: stock value + all account balances) ---
export const FinancialPositionView: React.FC<{ refreshKey?: number }> = ({ refreshKey }) => {
  const { language } = useLanguage();
  const isAr = language === 'ar';
  const cur = useCur();
  const { pos, error, loading } = usePosition(refreshKey);
  const f = useFilteredAccounts(pos);
  if (loading && !pos) return <div className="py-20 text-center text-slate-300"><i className="fa-solid fa-spinner fa-spin text-2xl"></i></div>;
  if (error || !pos) return <div className="p-4 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold border border-rose-100 flex items-center gap-3"><i className="fa-solid fa-circle-exclamation"></i>{error || 'No data'}</div>;
  return (
    <div className="space-y-8 animate-in fade-in duration-500" data-testid="financial-position-view">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {SUMMARY_TILES.map(tile => (
          <div key={tile.key} className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm" data-testid={`fp-sum-${tile.key}`}>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-2"><i className={`fa-solid ${tile.icon}`}></i>{isAr ? tile.ar : tile.en}</div>
            <div className={`text-2xl font-black tracking-tight break-words ${tile.color}`}>{fmt(pos.summary[tile.key] as number)} <span className="text-sm">{cur}</span></div>
            {tile.key === 'customerWallets' && pos.summary.customerWalletsOutsidePOs !== undefined && (
              <div className="text-[10px] font-bold text-slate-400 mt-2 break-words" data-testid="fp-sum-customerWallets-split">
                {isAr ? `خارج أوامر الشراء ${fmt(pos.summary.customerWalletsOutsidePOs)} (= دفتر الأستاذ) · محافظ الأوامر ${fmt(pos.summary.poWallets || 0)}` : `Outside POs ${fmt(pos.summary.customerWalletsOutsidePOs)} (= Ledger) · PO wallets ${fmt(pos.summary.poWallets || 0)}`}
              </div>
            )}
          </div>
        ))}
        <div className="bg-white p-6 rounded-[2rem] border border-slate-200 shadow-sm" data-testid="fp-sum-stock">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-2"><i className="fa-solid fa-boxes-stacked"></i>{isAr ? 'قيمة المخزون' : 'Stock value'}</div>
          <div className="text-2xl font-black tracking-tight text-amber-600 break-words">{fmt(pos.stock.totalOnHand)} <span className="text-sm">{cur}</span></div>
        </div>
      </div>

      <StockValueBlock stock={pos.stock} />

      <div className="space-y-4">
        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
          <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight flex items-center gap-2"><i className="fa-solid fa-scale-balanced text-slate-400"></i>{isAr ? 'أرصدة كل الحسابات' : 'All account balances'}</h3>
          <SearchBox value={f.search} onChange={f.setSearch} placeholder={isAr ? 'ابحث باسم الحساب...' : 'Search account...'} />
        </div>
        <GroupPills value={f.group} onChange={f.setGroup} counts={f.counts} />
        <AccountsList accounts={f.filtered} />
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{isAr ? 'آخر تحديث' : 'As of'} {new Date(pos.generatedAt).toLocaleString()}</div>
      </div>
    </div>
  );
};

// --- Dashboard: account balances summary + stock value per category ---
export const DashboardFinanceCards: React.FC<{ refreshKey?: number }> = ({ refreshKey }) => {
  // The Dashboard has no language provider and all its cards are English with L.E.: these two cards follow it.
  const isAr = false;
  const cur = 'L.E.';
  const { pos, error } = usePosition(refreshKey);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  if (error || !pos) return null; // roles without access to finance figures see no card
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="dashboard-finance">
      {!hidden.balances && (
        <DashboardCard id="balances" title={isAr ? 'أرصدة الحسابات' : 'Account Balances'} icon="fa-scale-balanced" onClose={() => setHidden(h => ({ ...h, balances: true }))}>
          <div className="p-4 space-y-2" data-testid="dash-balances">
            <div>
              <div className="text-2xl font-black text-emerald-600">{fmt(pos.summary.cashBank)} {cur}</div>
              <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">{isAr ? 'النقدية / البنك' : 'Cash / Bank'}</div>
            </div>
            {SUMMARY_TILES.filter(t => t.key !== 'cashBank').map(tile => (
              <div key={tile.key} className="flex justify-between items-baseline gap-3 pt-2 border-t border-slate-100" data-testid={`dash-bal-${tile.key}`}>
                <span className="text-[10px] font-black text-slate-400 uppercase">{isAr ? tile.ar : tile.en}</span>
                <span className="text-sm font-black text-slate-700 text-end">{fmt(pos.summary[tile.key] as number)} {cur}</span>
              </div>
            ))}
          </div>
        </DashboardCard>
      )}
      {!hidden.stock && (
        <DashboardCard id="stock" title={isAr ? 'قيمة المخزون' : 'Stock Value'} icon="fa-boxes-stacked" onClose={() => setHidden(h => ({ ...h, stock: true }))}>
          <div className="p-4 space-y-2" data-testid="dash-stock">
            <div>
              <div className="text-2xl font-black text-slate-800" data-testid="dash-stock-total">{fmt(pos.stock.totalOnHand)} {cur}</div>
              <div className="text-[10px] text-slate-400 font-bold uppercase mt-1">{isAr ? 'إجمالي المخزون الفعلي' : 'Total on hand'}</div>
            </div>
            {pos.stock.categories.map(c => (
              <div key={c.key} className="flex justify-between items-baseline gap-3 pt-2 border-t border-slate-100" data-testid={`dash-stock-${c.key}`}>
                <span className="text-[10px] font-black text-slate-400 uppercase min-w-0">{isAr ? c.labelAr : c.label}</span>
                <span className="text-sm font-black text-slate-700 text-end shrink-0">{fmt(c.value)} {cur}</span>
              </div>
            ))}
          </div>
        </DashboardCard>
      )}
    </div>
  );
};
