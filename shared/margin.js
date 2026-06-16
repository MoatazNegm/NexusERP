// Shared margin rule used by both client and server.
// A margin breach only exists when costs have been identified (cost > 0) and
// the markup percentage is below the configured minimum threshold.
export const isMarginBreach = (cost, markupPct, minMargin) => cost > 0 && markupPct < minMargin;
