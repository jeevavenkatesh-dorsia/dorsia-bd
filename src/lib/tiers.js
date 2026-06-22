export const TIER_ORDER = ["A+", "A", "B", "C", "D"];

export function normalizeTier(raw) {
  const t = (raw || "").trim();
  if (!t) return "";
  const lc = t.toLowerCase().replace(/\s+/g, " ");
  if (/a\s*(\+|plus)/.test(lc)) return "A+";
  if (/tier\s*a\b/.test(lc) || lc === "a") return "A";
  if (/tier\s*b\b/.test(lc) || lc === "b") return "B";
  if (/tier\s*c\b/.test(lc) || lc === "c") return "C";
  if (/tier\s*d\b/.test(lc) || lc === "d") return "D";
  if (/^a\+$/i.test(t)) return "A+";
  if (/^[a-d]$/i.test(t)) return t.toUpperCase();
  return t;
}

export function dealTier(deal) {
  return normalizeTier(deal?.tier) || (deal?.tier || "").trim();
}

export function tierOptions(deals) {
  const known = new Set(TIER_ORDER);
  const extra = [...new Set((deals || []).map(dealTier).filter(t => t && !known.has(t)))].sort();
  return [...TIER_ORDER, ...extra];
}

export function tierCounts(deals) {
  const counts = Object.fromEntries(TIER_ORDER.map(t => [t, 0]));
  for (const d of deals || []) {
    const t = dealTier(d);
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}
