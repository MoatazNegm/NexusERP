// R35 (user order 2026-11-15): account-name search for Finance > Account Status (and the other account lists).
// "Searchable by any part of the name, English or not": a case-insensitive SUBSTRING match on the normalized text.
// Normalization (applied to the name and to the query alike, so a substring stays a substring):
//   - Unicode NFKC (full-width / compatibility forms), lower case (English and any cased script);
//   - Arabic: tashkeel (harakat, U+064B-U+065F, U+0670) and tatweel (U+0640) removed; alef forms (أ إ آ ٱ) -> ا,
//     ى -> ي, ة -> ه, ؤ -> و, ئ -> ي; Arabic-Indic and Persian digits -> 0-9;
//   - Latin accents folded (é -> e, Ë -> e);
//   - runs of white space -> one space, trimmed.
const AR_MAP = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ي' };
export const normalizeAccountText = (s) => String(s === undefined || s === null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱىةؤئ]/g, ch => AR_MAP[ch] || ch)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/\s+/g, ' ')
    .trim();
// The names an account is found by: its English and Arabic labels and the customer / supplier / PO / project it belongs to.
// R35 round 2 (validator 1 G4): a PO wallet is also found by the customer's own PO reference (customerReferenceNumber).
export const accountSearchText = (a) => normalizeAccountText([a && a.label, a && a.labelAr, a && a.customerName, a && a.supplierName, a && a.orderNumber, a && a.customerReference, a && a.projectName].filter(Boolean).join(' | '));
export const accountMatches = (a, query) => {
    const q = normalizeAccountText(query);
    if (!q) return true;
    return accountSearchText(a).includes(q);
};
