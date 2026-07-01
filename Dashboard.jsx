import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { supabase, supabaseConfigured } from "./src/lib/supabase.js";
import LoginScreen from "./src/components/LoginScreen.jsx";
import BrandWordmark from "./src/components/BrandWordmark.jsx";
import {
  fetchDeals,
  fetchAppSettings,
  fetchAccessStatus,
  savePriorityMarkets,
  saveManagedList,
  insertDeal,
  insertDeals,
  updateDealField,
  updateDealFieldByGroup,
  deleteDealsByIds,
  upsertDeals,
} from "./src/lib/dealsDb.js";
import { TIER_ORDER, normalizeTier, dealTier, tierOptions, tierCounts } from "./src/lib/tiers.js";

// Pipeline data lives in Supabase. Initial seed: scripts/deals-seed.json + scripts/seed-deals.mjs

// ============ CONSTANTS ============
const TODAY = new Date(2026, 5, 18); // Jun 18 2026
const STAGES = ["Lead", "Conversation", "Offer Sent", "Signed", "Onboarded"];
// Onboarded means the venue has left the pipeline and joined Dorsia. It is excluded from
// pipeline counts, status rollups, and insights. PIPELINE_STAGES is everything except Onboarded.
const PIPELINE_STAGES = ["Lead", "Conversation", "Offer Sent", "Signed"];
const isOnboarded = d => d.stage === "Onboarded";
const STATUSES = ["Progressing", "Stuck", "Not a priority"];
const BLOCKERS = ["Price", "Control", "Unresponsive", "Brand", "Logistics", "No need", "Fees", "Min Spend"];
const GROUP_SYNC_FIELDS = new Set(["stage", "status", "lastContact", "blockers"]);

function hasSyncableGroup(group) {
  const g = (group == null ? "" : String(group)).trim();
  return g && g.toLowerCase() !== "no group";
}

function activityNotesAdded(prev, next) {
  const prevIds = new Set((prev || []).map(n => n.id));
  return (next || []).filter(n => !prevIds.has(n.id));
}

function parseMultiValue(value) {
  const s = value == null ? "" : String(value).trim();
  if (!s) return [];
  return s.split(/\s+\+\s+/).map(x => x.trim()).filter(Boolean);
}

function formatMultiValue(list) {
  return list.filter(Boolean).join(" + ");
}

const parseBlockers = parseMultiValue;
const formatBlockers = formatMultiValue;

function replaceInMultiValue(current, oldV, newV) {
  const parts = parseMultiValue(current);
  if (!parts.includes(oldV)) return current;
  return formatMultiValue(parts.map(x => x === oldV ? newV : x));
}

function removeFromMultiValue(current, value) {
  return formatMultiValue(parseMultiValue(current).filter(x => x !== value));
}

function dealFieldIncludes(deal, field, value) {
  if (field === "owner") return parseMultiValue(deal[field]).includes(value);
  return deal[field] === value;
}

function parseLiveDate(value) {
  const t = (value == null ? "" : String(value)).trim();
  if (!t) return "";
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (slash) {
    return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return "";
}

function formatGoLiveDisplay(iso) {
  const d = parseIsoDate(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
}

function ownersFromLiveRow(row) {
  return formatMultiValue(
    [row.salesRep1, row.salesRep2, row.salesRep3].map(s => (s || "").trim()).filter(Boolean)
  );
}

function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value || "").trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function fieldCounts(deals, field) {
  const counts = {};
  const multi = field === "owner" || field === "blockers";
  for (const d of deals || []) {
    const raw = d[field] == null ? "" : String(d[field]).trim();
    if (!raw) continue;
    const vals = multi ? parseMultiValue(raw) : [raw];
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function statusCounts(deals) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const d of deals || []) {
    const s = (d.status || "").trim();
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

// Maps old/source stage names (from CSV uploads) to the 4 pipeline stages.
const STAGE_MAP = {
  "prospect": "Lead",
  "dorsia target": "Lead",
  "lead": "Lead",
  "unsuccessful": "Conversation",
  "active conversation": "Conversation",
  "cold conversation": "Conversation",
  "needs contract": "Conversation",
  "conversation": "Conversation",
  "offer out": "Offer Sent",
  "offer sent": "Offer Sent",
  "signed": "Signed",
  "onboarded": "Signed",
};
function mapStage(raw) {
  const key = (raw || "").trim().toLowerCase();
  return STAGE_MAP[key] || (STAGES.includes((raw || "").trim()) ? raw.trim() : "Lead");
}

const STATUS_STYLE = {
  "Progressing": { bg: "#ecfdf5", fg: "#047857", dot: "#10b981" },
  "Stuck": { bg: "#fef2f2", fg: "#b91c1c", dot: "#ef4444" },
  "Not a priority": { bg: "#f1f5f9", fg: "#64748b", dot: "#94a3b8" },
  "Onboarded": { bg: "#ede9fe", fg: "#6d28d9", dot: "#7c3aed" },
};
const STAGE_DOT = {
  "Lead": "#a78bfa",
  "Conversation": "#8b5cf6",
  "Offer Sent": "#f59e0b",
  "Signed": "#10b981",
  "Onboarded": "#7c3aed",
};
// purple-forward palette for charts
const PIE_PALETTE = [
  "#6d28d9","#7c3aed","#8b5cf6","#a78bfa","#c4b5fd","#5b21b6",
  "#9333ea","#a855f7","#c084fc","#d8b4fe","#7e22ce","#6b21a8",
  "#4c1d95","#ddd6fe","#e9d5ff","#f3e8ff","#3b0764","#b794f6",
  "#9f7aea","#805ad5","#553c9a","#44337a",
];

// ============ HELPERS ============
function initials(name) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return (p.length > 1 ? p[0][0] + p[p.length - 1][0] : name.slice(0, 2)).toUpperCase();
}
function staleLabel(days) {
  if (days == null) return null;
  if (days < 0) return null;
  if (days < 30) return `${days}d since last contact`;
  if (days < 365) return `${days}d since last contact`;
  return `${Math.floor(days / 365)}y since last contact`;
}
function staleTone(days) {
  if (days == null) return "#94a3b8";
  if (days <= 14) return "#10b981";
  if (days <= 45) return "#f59e0b";
  return "#ef4444";
}
function ownerColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 45%, 55%)`;
}

// Parse a spoken transcript into draft deal fields. Matches against known lists for fuzzy fields.
// ============ SMALL UI PRIMITIVES ============
function StatusTag({ status, size = "sm" }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE["Not a priority"];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: s.bg, color: s.fg,
      fontSize: size === "sm" ? 11 : 12, fontWeight: 600,
      padding: size === "sm" ? "2px 8px" : "3px 10px", borderRadius: 999,
      whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.dot }} />
      {status}
    </span>
  );
}
function TierBadge({ tier }) {
  if (!tier) return null;
  const styles = {
    "A+": { bg: "#1e1b4b", fg: "#fff" },
    "A": { bg: "#ede9fe", fg: "#5b21b6" },
    "B": { bg: "#dbeafe", fg: "#1d4ed8" },
    "C": { bg: "#fef3c7", fg: "#b45309" },
    "D": { bg: "#f1f5f9", fg: "#475569" },
  };
  const s = styles[tier] || { bg: "#f1f5f9", fg: "#64748b" };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
      padding: "1px 6px", borderRadius: 5,
      background: s.bg, color: s.fg,
    }}>{tier}</span>
  );
}
function Avatar({ name, size = 24 }) {
  return (
    <span title={name} style={{
      width: size, height: size, borderRadius: 999, flexShrink: 0,
      background: ownerColor(name || "?"), color: "#fff",
      fontSize: size * 0.4, fontWeight: 700,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    }}>{initials(name)}</span>
  );
}

function OwnerDisplay({ owner, size = 20, showNames = true, compact = false, bar = false }) {
  const names = parseMultiValue(owner);
  const textStyle = bar
    ? { fontSize: 13, fontWeight: 600, color: "#0f172a" }
    : compact
    ? { fontSize: 13, color: "#64748b" }
    : { color: "#475569" };
  const avatarSize = bar || compact ? 14 : size;
  const gap = bar ? 6 : compact ? 5 : 7;
  if (!names.length) return <span style={{ ...textStyle, fontStyle: "italic" }}>Unassigned</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap, flexWrap: "wrap", justifyContent: "flex-end" }}>
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        {names.map((n, i) => (
          <span key={n} style={{ marginLeft: i ? (compact ? -4 : -5) : 0, zIndex: names.length - i, border: "2px solid #fff", borderRadius: 999 }}>
            <Avatar name={n} size={avatarSize} />
          </span>
        ))}
      </span>
      {showNames && <span style={textStyle}>{formatMultiValue(names)}</span>}
    </span>
  );
}

function matchesMulti(selected, value) {
  if (!selected.length) return true;
  const values = parseMultiValue(value);
  if (values.length) return values.some(v => selected.includes(v));
  return selected.includes(value);
}

function applyDealFilters(deals, filters, skip = new Set()) {
  const {
    search = "",
    fStage = [],
    fStatus = [],
    fMarket = [],
    fOwner = [],
    fTier = [],
    fBlocker = [],
  } = filters;

  return (deals || []).filter(d => {
    if (!skip.has("search") && search && !(d.venue + d.group + d.market).toLowerCase().includes(search.toLowerCase())) return false;
    if (!skip.has("fStage") && fStage.length && !matchesMulti(fStage, d.stage)) return false;
    if (!skip.has("fStatus") && fStatus.length && !matchesMulti(fStatus, d.status)) return false;
    if (!skip.has("fMarket") && fMarket.length && !matchesMulti(fMarket, d.market)) return false;
    if (!skip.has("fOwner") && fOwner.length && !matchesMulti(fOwner, d.owner)) return false;
    if (!skip.has("fTier") && fTier.length && !matchesMulti(fTier, dealTier(d))) return false;
    if (!skip.has("fBlocker") && fBlocker.length && !matchesMulti(fBlocker, d.blockers)) return false;
    return true;
  });
}

function contextualCounts(deals, filters, field, skipKey) {
  const subset = applyDealFilters(deals, filters, new Set([skipKey]));
  if (field === "tier") return tierCounts(subset);
  if (field === "status") return statusCounts(subset);
  if (field === "stage") return stageCounts(subset);
  return fieldCounts(subset, field);
}

function stageCounts(deals) {
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  for (const d of deals || []) {
    const s = (d.stage || "").trim();
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

const UI_STORAGE_KEY = "dorsia-bd-ui";
const DEFAULT_UI_STATE = {
  tab: "dashboard",
  search: "",
  fStage: [],
  fStatus: [],
  fMarket: [],
  fOwner: [],
  fTier: [],
  fBlocker: [],
  sort: { key: "venue", dir: 1 },
};

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_UI_STATE,
      ...parsed,
      sort: { ...DEFAULT_UI_STATE.sort, ...(parsed.sort || {}) },
    };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

function saveUiState(state) {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}

function MultiFilter({ label, options, selected, onChange, style, counts }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggle = (opt) => {
    onChange(selected.includes(opt) ? selected.filter(x => x !== opt) : [...selected, opt]);
  };

  const summary = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${selected.length} selected`;
  const active = selected.length > 0;

  return (
    <div ref={ref} style={{ position: "relative", ...style }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: 13, padding: "8px 12px", borderRadius: 9, border: "1px solid #e5e7eb",
          background: "#fff", cursor: "pointer", whiteSpace: "nowrap",
          display: "inline-flex", alignItems: "center", gap: 6,
          fontWeight: active ? 600 : 400,
          color: active ? "#7c3aed" : "#475569",
          borderColor: active ? "#c4b5fd" : "#e5e7eb",
        }}
      >
        {summary}
        <span style={{ fontSize: 10, opacity: 0.6 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 50,
          minWidth: "max(100%, 180px)", background: "#fff", border: "1px solid #e5e7eb",
          borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.08)", padding: "6px 0",
          maxHeight: 280, overflowY: "auto",
        }}>
          {options.map(opt => (
            <label
              key={opt}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                cursor: "pointer", fontSize: 13, color: counts && !counts[opt] ? "#cbd5e1" : "#334155",
                background: selected.includes(opt) ? "#faf5ff" : "transparent",
              }}
            >
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} />
              <span style={{ flex: 1 }}>{opt}</span>
              {counts && <span style={{ fontSize: 11, color: "#94a3b8" }}>{counts[opt] ?? 0}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ DASHBOARD TAB ============
function Donut({ data, size = 180 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = size / 2, ir = r * 0.62;
  let acc = 0;
  const arcs = data.map((d, i) => {
    const start = (acc / total) * 2 * Math.PI;
    acc += d.value;
    const end = (acc / total) * 2 * Math.PI;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = r + r * Math.sin(start), y1 = r - r * Math.cos(start);
    const x2 = r + r * Math.sin(end), y2 = r - r * Math.cos(end);
    const xi1 = r + ir * Math.sin(start), yi1 = r - ir * Math.cos(start);
    const xi2 = r + ir * Math.sin(end), yi2 = r - ir * Math.cos(end);
    const path = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${xi2},${yi2} A${ir},${ir} 0 ${large} 0 ${xi1},${yi1} Z`;
    return <path key={i} d={path} fill={d.color} />;
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {total === 0 ? <circle cx={r} cy={r} r={r} fill="#f1f5f9" /> : arcs}
      <circle cx={r} cy={r} r={ir - 1} fill="#fff" />
      <text x={r} y={r - 4} textAnchor="middle" fontSize={26} fontWeight={700} fill="#0f172a">{total}</text>
      <text x={r} y={r + 16} textAnchor="middle" fontSize={11} fill="#94a3b8">deals</text>
    </svg>
  );
}

function KpiCard({ icon, label, value, sub, accent }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{
          width: 30, height: 30, borderRadius: 9, display: "inline-flex",
          alignItems: "center", justifyContent: "center",
          background: accent.bg, color: accent.fg, fontSize: 15,
        }}>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, color: "#94a3b8", textTransform: "uppercase" }}>{label}</span>
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, color: "#0f172a", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>{sub}</div>
    </div>
  );
}

function ChartCard({ title, data, legendFmt }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, padding: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, color: "#94a3b8", textTransform: "uppercase", marginBottom: 16 }}>{title}</div>
      <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <Donut data={data} />
        <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 7 }}>
          {data.map((d, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: d.color, flexShrink: 0 }} />
              <span style={{ color: "#334155", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</span>
              <span style={{ color: "#0f172a", fontWeight: 600 }}>{d.value}</span>
              <span style={{ color: "#94a3b8", width: 38, textAlign: "right" }}>{total ? Math.round(d.value / total * 100) : 0}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardTab({ deals, insights, tasks, onOpenDeal, priorityMarkets }) {
  const coreMarkets = priorityMarkets;
  // Onboarded venues have left the pipeline, so they are excluded from every dashboard metric.
  const pipeline = deals.filter(d => !isOnboarded(d));
  const aDeals = pipeline.filter(d => d.tier === "A" || d.tier === "A+");
  const coreCount = pipeline.filter(d => coreMarkets.includes(d.market)).length;
  const aProgressing = aDeals.filter(d => d.status === "Progressing").length;
  const aPlusStuck = pipeline.filter(d => d.tier === "A+" && d.status === "Stuck").length;

  const byMarket = useMemo(() => {
    const m = {};
    aDeals.forEach(d => { m[d.market] = (m[d.market] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: PIE_PALETTE[i % PIE_PALETTE.length] }));
  }, [deals]);

  const byStatus = useMemo(() => {
    const order = { "Stuck": 0, "Progressing": 1, "Not a priority": 2 };
    const m = {};
    aDeals.forEach(d => { m[d.status] = (m[d.status] || 0) + 1; });
    return Object.entries(m).sort((a, b) => order[a[0]] - order[b[0]])
      .map(([label, value]) => ({ label, value, color: STATUS_STYLE[label].dot }));
  }, [deals]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
      {/* LEFT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <KpiCard icon="◎" label="Core Market Deals" value={coreCount} sub={`Across ${coreMarkets.length} priority markets`} accent={{ bg: "#ede9fe", fg: "#6d28d9" }} />
          <KpiCard icon="★" label="A / A+ Deals" value={aDeals.length} sub={`${pipeline.filter(d => d.tier === "A+").length} are A+ tier`} accent={{ bg: "#e0e7ff", fg: "#4338ca" }} />
          <KpiCard icon="↗" label="A/A+ Progressing" value={aProgressing} sub={`${aDeals.length ? Math.round(aProgressing / aDeals.length * 100) : 0}% of A/A+ moving`} accent={{ bg: "#ecfdf5", fg: "#047857" }} />
          <KpiCard icon="⚠" label="A+ Stuck" value={aPlusStuck} sub="A+ deals needing attention" accent={{ bg: "#fef2f2", fg: "#b91c1c" }} />
        </div>
        <ChartCard title="A/A+ Deals by Market" data={byMarket} />
        <ChartCard title="A/A+ Deals by Status" data={byStatus} />
      </div>

      {/* RIGHT COLUMN */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <span style={{ color: "#7c3aed", fontSize: 16 }}>✦</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", letterSpacing: 0.4 }}>AI INSIGHTS</span>
            <span style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999 }}>{insights.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {insights.map((ins, i) => (
              <div key={i}>
                <div style={{ display: "flex", gap: 8, marginBottom: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: ins.tone, marginTop: 6, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>{ins.title}</span>
                </div>
                <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5, paddingLeft: 15 }}>{ins.body}</div>
                {ins.deals && ins.deals.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 15, marginTop: 8 }}>
                    {ins.deals.map(d => (
                      <button key={d.id} onClick={() => onOpenDeal(d)} style={{
                        background: "#faf5ff", color: "#6d28d9", border: "1px solid #e9d5ff",
                        fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 7, cursor: "pointer",
                      }}>{d.venue} →</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <span style={{ color: "#7c3aed", fontSize: 15 }}>🗓</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", letterSpacing: 0.4 }}>TASKS DUE SOON</span>
            <span style={{ background: "#ede9fe", color: "#6d28d9", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999 }}>{tasks.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {tasks.map((t, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 0",
                borderBottom: i < tasks.length - 1 ? "1px solid #f1f5f9" : "none",
              }}>
                <span style={{ width: 16, height: 16, borderRadius: 999, border: "1.6px solid #cbd5e1", marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, color: "#0f172a", fontWeight: 500 }}>{t.title}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4 }}>
                    <span style={{ background: "#f1f5f9", color: "#6d28d9", fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 5 }}>{t.venue}</span>
                    <Avatar name={t.owner} size={16} />
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{t.owner}</span>
                  </div>
                </div>
                <span style={{ fontSize: 12, color: t.overdue ? "#dc2626" : "#94a3b8", fontWeight: 500, whiteSpace: "nowrap" }}>{t.due}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function useFitColumnBox(boundsRef, innerRef) {
  const [box, setBox] = useState(null);
  const measure = useCallback(() => {
    if (!boundsRef?.current || !innerRef?.current) return;
    const outer = boundsRef.current.getBoundingClientRect();
    const inner = innerRef.current.getBoundingClientRect();
    setBox({ left: outer.left - inner.left, width: outer.width });
  }, [boundsRef, innerRef]);

  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return box;
}

// ============ PIPELINE TAB ============
function PipelineCard({ deal, onUpdate, onOpenDeal, owners, tiers, onDragStart, onDragEnd, isDragging }) {
  const cardRef = useRef(null);
  const stale = isOnboarded(deal) ? null : staleLabel(deal.staleDays);
  const blockers = parseMultiValue(deal.blockers);
  const set = (key, val) => onUpdate(deal.id, key, val);

  const startDrag = (e) => {
    e.dataTransfer.setData("text/plain", String(deal.id));
    e.dataTransfer.effectAllowed = "move";
    if (cardRef.current && e.dataTransfer.setDragImage) {
      const rect = cardRef.current.getBoundingClientRect();
      e.dataTransfer.setDragImage(cardRef.current, e.clientX - rect.left, e.clientY - rect.top);
    }
    onDragStart?.(deal.id);
  };

  return (
    <div ref={cardRef} style={{
      width: "100%", textAlign: "left", background: "#fff", border: "1px solid #eef0f4",
      borderRadius: 12, padding: 13, display: "block", position: "relative",
      transition: "border-color .15s, box-shadow .15s, opacity .15s",
      opacity: isDragging ? 0.45 : 1,
    }}
      onMouseEnter={e => { if (!isDragging) { e.currentTarget.style.borderColor = "#d8b4fe"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(124,58,237,.08)"; } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "#eef0f4"; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div
          draggable
          onDragStart={startDrag}
          onDragEnd={onDragEnd}
          title="Drag to change stage"
          style={{
            flexShrink: 0, width: 18, paddingTop: 2, cursor: "grab", color: "#cbd5e1",
            fontSize: 14, lineHeight: 1, userSelect: "none", touchAction: "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#a78bfa"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "#cbd5e1"; }}
          onClick={e => e.stopPropagation()}
        >
          ⠿
        </div>
        <div
          onClick={() => onOpenDeal(deal)}
          style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          title="Open deal"
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{deal.venue}</div>
            <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{deal.group}</div>
          </div>
          <span onClick={e => e.stopPropagation()}>
            <EditableCell
              fitColumn
              boundsRef={cardRef}
              value={dealTier(deal)}
              options={tiers}
              onChange={v => set("tier", v)}
              render={v => <TierBadge tier={v} />}
            />
          </span>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
        <EditableCell fitColumn boundsRef={cardRef} value={deal.stage} options={STAGES} onChange={v => set("stage", v)}
          render={v => (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#334155", fontWeight: 500 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: STAGE_DOT[v] }} />{v}
            </span>
          )} />
        {isOnboarded(deal)
          ? <StatusTag status="Onboarded" />
          : <EditableCell fitColumn boundsRef={cardRef} value={deal.status} options={STATUSES} onChange={v => set("status", v)} render={v => <StatusTag status={v} />} />}
        {isOnboarded(deal) && (
          <EditableCell
            fitColumn
            boundsRef={cardRef}
            value={deal.goLiveDate}
            datePicker
            displayValue={deal.goLiveDateDisplay || "Set go-live"}
            onChange={v => set("goLiveDate", v)}
            render={() => (
              <span style={{ fontSize: 11, color: "#6d28d9", fontWeight: 600 }}>
                {deal.goLiveDateDisplay ? `Live ${deal.goLiveDateDisplay}` : "Set go-live date"}
              </span>
            )}
          />
        )}
        {!isOnboarded(deal) && (
        <EditableCell
          fitColumn
          boundsRef={cardRef}
          value={deal.blockers}
          options={BLOCKERS}
          multiSelect
          valueColor="#b91c1c"
          searchPlaceholder="Search blockers…"
          onChange={v => set("blockers", v)}
          render={() => blockers.length
            ? <span style={{ fontSize: 11, color: "#b91c1c", lineHeight: 1.35 }}>{formatMultiValue(blockers)}</span>
            : <span style={{ fontSize: 11, color: "#cbd5e1", fontStyle: "italic" }}>No blockers</span>}
        />
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <EditableCell
            fitColumn
            boundsRef={cardRef}
            hideSummary
            searchPlaceholder="Search leads…"
            value={deal.owner}
            options={owners}
            multiSelect
            valueColor="#64748b"
            onChange={v => set("owner", v)}
            render={v => {
              const names = parseMultiValue(v);
              if (!names.length) {
                return (
                  <span style={{ display: "inline-flex", alignItems: "center" }} title="Unassigned — click to set">
                    <span style={{
                      width: 20, height: 20, borderRadius: 999, background: "#e2e8f0",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, color: "#94a3b8", fontWeight: 600,
                    }}>—</span>
                  </span>
                );
              }
              return (
                <span style={{ display: "inline-flex", alignItems: "center" }} title={formatMultiValue(names)}>
                  {names.slice(0, 2).map((n, i) => (
                    <span key={n} style={{ marginLeft: i ? -4 : 0, zIndex: names.length - i, border: "2px solid #fff", borderRadius: 999 }}>
                      <Avatar name={n} size={20} />
                    </span>
                  ))}
                </span>
              );
            }}
          />
          {deal.market && <span style={{ fontSize: 11, color: "#64748b" }}>{deal.market}</span>}
        </div>
        <EditableCell
          fitColumn
          boundsRef={cardRef}
          value={deal.lastContact}
          datePicker
          displayValue={deal.lastContactDisplay}
          onChange={v => set("lastContact", v)}
          render={() => (
            <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
              {deal.lastContactDisplay !== "No contact logged" ? deal.lastContactDisplay : "—"}
            </span>
          )}
        />
      </div>
      {stale && (
        <div style={{ marginTop: 9, fontSize: 11, color: staleTone(deal.staleDays), background: "#fafafa", borderRadius: 7, padding: "4px 8px" }}>
          {deal.staleDays > 45 ? "Stale · " : ""}{stale}
        </div>
      )}
    </div>
  );
}

function PipelineTab({ deals, onOpenDeal, onUpdate, owners, markets, tiers, onFilteredCountChange, filters, onFilterChange }) {
  const { search, fStatus, fMarket, fOwner, fTier, fBlocker } = filters;
  const setSearch = v => onFilterChange({ search: v });
  const setFStatus = v => onFilterChange({ fStatus: v });
  const setFMarket = v => onFilterChange({ fMarket: v });
  const setFOwner = v => onFilterChange({ fOwner: v });
  const setFTier = v => onFilterChange({ fTier: v });
  const setFBlocker = v => onFilterChange({ fBlocker: v });
  const [dragDealId, setDragDealId] = useState(null);
  const [dropStage, setDropStage] = useState(null);
  const [movedIds, setMovedIds] = useState([]); // most-recently-moved first

  const pipelineFilters = useMemo(() => ({ search, fStatus, fMarket, fOwner, fTier, fBlocker }), [search, fStatus, fMarket, fOwner, fTier, fBlocker]);
  const tierCountMap = useMemo(() => contextualCounts(deals, pipelineFilters, "tier", "fTier"), [deals, pipelineFilters]);
  const statusCountMap = useMemo(() => contextualCounts(deals, pipelineFilters, "status", "fStatus"), [deals, pipelineFilters]);
  const marketCountMap = useMemo(() => contextualCounts(deals, pipelineFilters, "market", "fMarket"), [deals, pipelineFilters]);
  const ownerCountMap = useMemo(() => contextualCounts(deals, pipelineFilters, "owner", "fOwner"), [deals, pipelineFilters]);
  const blockerCountMap = useMemo(() => contextualCounts(deals, pipelineFilters, "blockers", "fBlocker"), [deals, pipelineFilters]);

  const filtered = useMemo(() => deals.filter(d =>
    (!search || (d.venue + d.group + d.market).toLowerCase().includes(search.toLowerCase())) &&
    matchesMulti(fStatus, d.status) && matchesMulti(fMarket, d.market) && matchesMulti(fOwner, d.owner) && matchesMulti(fTier, dealTier(d)) && matchesMulti(fBlocker, d.blockers)
  ), [deals, search, fStatus, fMarket, fOwner, fTier, fBlocker]);

  useEffect(() => {
    onFilteredCountChange?.(filtered.length);
  }, [filtered.length, onFilteredCountChange]);

  const cols = useMemo(() => {
    const m = Object.fromEntries(STAGES.map(s => [s, []]));
    filtered.forEach(d => { if (m[d.stage]) m[d.stage].push(d); });
    const rank = new Map(movedIds.map((id, i) => [id, i]));
    for (const s of STAGES) {
      m[s].sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
    }
    return m;
  }, [filtered, movedIds]);

  const endDrag = () => { setDragDealId(null); setDropStage(null); };

  const handleDrop = (stage, e) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData("text/plain"));
    const deal = deals.find(d => d.id === id);
    if (deal && deal.stage !== stage) {
      onUpdate(id, "stage", stage);
      setMovedIds(prev => [id, ...prev.filter(x => x !== id)]);
    }
    endDrag();
  };

  const selStyle = { fontSize: 13, padding: "8px 12px", borderRadius: 9, border: "1px solid #e5e7eb", background: "#fff", color: "#475569", cursor: "pointer" };
  const active = search || fStatus.length || fMarket.length || fOwner.length || fTier.length || fBlocker.length;
  const clearFilters = () => onFilterChange({ search: "", fStatus: [], fMarket: [], fOwner: [], fTier: [], fBlocker: [] });

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search deals…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, fontSize: 13, padding: "9px 14px", borderRadius: 10, border: "1px solid #e5e7eb" }} />
        <MultiFilter label="All Tiers" options={tiers} selected={fTier} onChange={setFTier} counts={tierCountMap} />
        <MultiFilter label="All Status" options={STATUSES} selected={fStatus} onChange={setFStatus} counts={statusCountMap} />
        <MultiFilter label="All Reasons" options={BLOCKERS} selected={fBlocker} onChange={setFBlocker} counts={blockerCountMap} />
        <MultiFilter label="All Markets" options={markets.filter(Boolean)} selected={fMarket} onChange={setFMarket} counts={marketCountMap} />
        <MultiFilter label="All Leads" options={owners.filter(Boolean)} selected={fOwner} onChange={setFOwner} counts={ownerCountMap} />
        {active > 0 && <button onClick={clearFilters} style={{ ...selStyle, color: "#7c3aed", fontWeight: 600 }}>Clear filters</button>}
        <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>{filtered.length} of {deals.length} deals</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(260px, 1fr))`, gap: 16, alignItems: "start" }}>
        {STAGES.map(stage => {
          const onboardedCol = stage === "Onboarded";
          const isDropTarget = dragDealId && dropStage === stage;
          return (
          <div
            key={stage}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropStage(stage); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropStage(s => s === stage ? null : s); }}
            onDrop={e => handleDrop(stage, e)}
            style={{
              background: isDropTarget ? (onboardedCol ? "#ede9fe" : "#f3e8ff") : (onboardedCol ? "#f5f3ff" : "#f8f7fb"),
              border: `2px solid ${isDropTarget ? "#a78bfa" : (onboardedCol ? "#ddd6fe" : "#f0eef6")}`,
              borderRadius: 14, padding: 12, minHeight: 200, minWidth: 0,
              transition: "background .15s, border-color .15s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "2px 4px" }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: STAGE_DOT[stage] }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: onboardedCol ? "#6d28d9" : "#0f172a" }}>{stage}</span>
              <span style={{ background: "#fff", color: "#64748b", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999, border: "1px solid #eef0f4" }}>{cols[stage].length}</span>
              {onboardedCol && <span style={{ fontSize: 10.5, color: "#a78bfa", marginLeft: "auto" }}>Joined Dorsia</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {cols[stage].map(d => (
                <PipelineCard
                  key={d.id}
                  deal={d}
                  onUpdate={onUpdate}
                  onOpenDeal={onOpenDeal}
                  owners={owners}
                  tiers={tiers}
                  onDragStart={setDragDealId}
                  onDragEnd={endDrag}
                  isDragging={dragDealId === d.id}
                />
              ))}
              {cols[stage].length === 0 && <div style={{ fontSize: 12, color: "#cbd5e1", textAlign: "center", padding: 20 }}>{isDropTarget ? "Drop here" : "No deals"}</div>}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ DEAL DETAIL TAB ============
// Parse the notes field into a pseudo activity feed (dated entries like "4/8:" or "5/6:")
function parseActivity(notes, owner) {
  if (!notes) return [];
  const parts = notes.split(/(?=\b\d{1,2}\/\d{1,2}:)/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return [{ date: "", body: notes.replace(/\*\*/g, ""), who: owner }];
  }
  return parts.map(p => {
    const m = p.match(/^(\d{1,2}\/\d{1,2}):\s*(.*)$/s);
    if (m) return { date: m[1], body: m[2].replace(/\*\*/g, ""), who: owner };
    return { date: "", body: p.replace(/\*\*/g, ""), who: owner };
  });
}

function DetailRow({ label, value, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "9px 0", borderBottom: "1px solid #f4f4f7", gap: 16 }}>
      <span style={{ fontSize: 13, color: "#94a3b8" }}>{label}</span>
      <span style={{ fontSize: 13.5, color: accent || "#0f172a", fontWeight: 500, textAlign: "right" }}>{value || "—"}</span>
    </div>
  );
}
function cleanDetailValue(v) {
  if (v == null) return "";
  return String(v).trim();
}

function normalizeSelectOptions(options, currentValue) {
  const seen = new Set();
  const list = [];
  const add = (v) => {
    const s = cleanDetailValue(v);
    if (!s || seen.has(s)) return;
    seen.add(s);
    list.push(s);
  };
  add(currentValue);
  for (const o of options || []) add(o);
  return list;
}

// Custom single-select dropdown — inline styles only (same pattern as MultiFilter).
function InlineSelect({ value, options, onChange, onClose, placeholder, allowBlank, compact, fitColumn, boundsRef }) {
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const searchRef = useRef(null);
  const fitBox = useFitColumnBox(boundsRef, ref);
  const selectOptions = normalizeSelectOptions(options, value);
  const showSearch = selectOptions.length > 3;
  const current = cleanDetailValue(value);
  const q = query.trim().toLowerCase();
  const filtered = q ? selectOptions.filter(o => o.toLowerCase().includes(q)) : selectOptions;
  const defaultMenuWidth = compact ? 220 : 260;
  const menuWidth = fitColumn && fitBox ? fitBox.width : defaultMenuWidth;

  const menuStyle = {
    position: "absolute", top: "100%", marginTop: 4, zIndex: 400,
    ...(fitColumn && fitBox ? { left: fitBox.left, width: fitBox.width } : { right: 0, width: defaultMenuWidth }),
    background: "#ffffff", border: "1px solid #e5e7eb",
    borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "4px 0",
    maxHeight: 260, overflowY: "auto",
  };
  const itemStyle = (active) => ({
    display: "block", width: "100%", textAlign: "left", padding: compact ? "7px 10px" : "8px 12px",
    cursor: "pointer", fontSize: compact ? 12.5 : 13, color: "#334155", background: active ? "#faf5ff" : "#ffffff",
    fontWeight: active ? 600 : 400, fontFamily: "inherit", lineHeight: 1.4,
  });
  const inputStyle = {
    fontSize: compact ? 12.5 : 13, padding: compact ? "5px 8px" : "6px 10px",
    borderRadius: 7, border: "1.5px solid #a78bfa", color: "#0f172a", background: "#ffffff",
    boxSizing: "border-box",
    ...(fitColumn && fitBox
      ? { display: "block", position: "relative", left: fitBox.left, width: fitBox.width, maxWidth: fitBox.width }
      : { width: menuWidth }),
  };

  useEffect(() => {
    if (showSearch) searchRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose?.(); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (v) => { onChange(v); onClose?.(); };

  return (
    <div ref={ref} style={{ position: "relative", zIndex: 400, display: "inline-block" }}>
      {showSearch ? (
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search…"
          onKeyDown={e => { if (e.key === "Escape") onClose?.(); }}
          style={inputStyle}
        />
      ) : (
        <span style={{ fontSize: compact ? 12.5 : 13.5, color: "#0f172a", fontWeight: 500 }}>
          {current || placeholder || "Select…"}
        </span>
      )}
      <div style={menuStyle}>
        {allowBlank && (
          <label style={{ ...itemStyle(!current), display: "block" }} onMouseDown={(e) => { e.preventDefault(); pick(""); }}>
            <span style={{ color: "#94a3b8" }}>{placeholder || "—"}</span>
          </label>
        )}
        {filtered.map(o => (
          <label key={o} style={{ ...itemStyle(o === current), display: "block" }} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
            <span style={{ color: "#334155" }}>{o}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8", background: "#ffffff" }}>No matches</div>
        )}
      </div>
    </div>
  );
}

// Multi-select dropdown — toggles options and stores value as "A + B + C".
function InlineMultiSelect({ value, options, onChange, onClose, placeholder, valueColor = "#b91c1c", fitColumn, boundsRef, hideSummary, searchPlaceholder }) {
  const ref = useRef(null);
  const searchRef = useRef(null);
  const fitBox = useFitColumnBox(boundsRef, ref);
  const [query, setQuery] = useState("");
  const selected = useMemo(() => parseMultiValue(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const defaultMenuWidth = 260;
  const menuWidth = fitColumn && fitBox ? fitBox.width : defaultMenuWidth;

  const allOptions = useMemo(() => {
    const seen = new Set();
    const list = [];
    const add = (v) => {
      const s = cleanDetailValue(v);
      if (!s || seen.has(s)) return;
      seen.add(s);
      list.push(s);
    };
    for (const o of options || []) add(o);
    for (const s of selected) add(s);
    return list;
  }, [options, selected]);

  const q = query.trim().toLowerCase();
  const filtered = q ? allOptions.filter(o => o.toLowerCase().includes(q)) : allOptions;
  const summary = formatMultiValue(selected) || placeholder || "None logged";

  useEffect(() => {
    if (allOptions.length > 3) searchRef.current?.focus();
  }, [allOptions.length]);

  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose?.(); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (opt) => {
    const next = selectedSet.has(opt) ? selected.filter(x => x !== opt) : [...selected, opt];
    onChange(formatMultiValue(next));
  };

  const menuStyle = {
    position: "absolute", top: "100%", marginTop: 4, zIndex: 400,
    ...(fitColumn && fitBox ? { left: fitBox.left, width: fitBox.width } : { right: 0, width: defaultMenuWidth }),
    background: "#ffffff", border: "1px solid #e5e7eb",
    borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: "4px 0",
    maxHeight: 260, overflowY: "auto",
  };
  const itemStyle = (active) => ({
    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
    padding: "8px 12px", cursor: "pointer", fontSize: 13,
    color: "#334155", background: active ? "#faf5ff" : "#ffffff",
    fontWeight: active ? 600 : 400, fontFamily: "inherit", lineHeight: 1.4,
  });
  const inputStyle = {
    fontSize: 13, padding: "6px 10px", marginBottom: 4,
    borderRadius: 7, border: "1.5px solid #a78bfa", color: "#0f172a", background: "#ffffff",
    boxSizing: "border-box",
    ...(fitColumn && fitBox
      ? { display: "block", position: "relative", left: fitBox.left, width: fitBox.width, maxWidth: fitBox.width }
      : { width: menuWidth }),
  };

  return (
    <div ref={ref} style={{ position: "relative", zIndex: 400, display: "inline-block", textAlign: "right" }}>
      {!hideSummary && (
        <div style={{ fontSize: 13, color: selected.length ? valueColor : "#94a3b8", fontWeight: 500, marginBottom: 4, maxWidth: menuWidth }}>
          {summary}
        </div>
      )}
      {allOptions.length > 3 && (
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={searchPlaceholder || "Search blockers…"}
          onKeyDown={e => { if (e.key === "Escape") onClose?.(); }}
          style={inputStyle}
        />
      )}
      <div style={menuStyle}>
        {filtered.map(o => (
          <label key={o} style={itemStyle(selectedSet.has(o))}>
            <input type="checkbox" checked={selectedSet.has(o)} onChange={() => toggle(o)} />
            <span style={{ color: "#334155", flex: 1 }}>{o}</span>
          </label>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 13, color: "#94a3b8", background: "#ffffff" }}>No matches</div>
        )}
      </div>
    </div>
  );
}

function DatePickerField({ value, onChange, onClose, display, placeholder, defaultOpen, align = "right", triggerStyle, hidePencil, fitColumn, boundsRef }) {
  const ref = useRef(null);
  const fitBox = useFitColumnBox(boundsRef, ref);
  const [open, setOpen] = useState(!!defaultOpen);
  const selected = parseIsoDate(value);
  const [view, setView] = useState(() => {
    const base = selected || TODAY;
    return { year: base.getFullYear(), month: base.getMonth() };
  });

  const close = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handleClose = (e) => { if (!ref.current?.contains(e.target)) close(); };
    document.addEventListener("mousedown", handleClose);
    return () => document.removeEventListener("mousedown", handleClose);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (open && selected) setView({ year: selected.getFullYear(), month: selected.getMonth() });
  }, [open, value]);

  const label = display || placeholder || "No contact logged";
  const empty = !value || !String(value).trim() || display === "No contact logged";
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const firstDow = new Date(view.year, view.month, 1).getDay();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const shiftMonth = (delta) => {
    setView(v => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  const pickDay = (day) => {
    onChange(toIsoDate(new Date(view.year, view.month, day)));
    close();
  };

  const popoverStyle = {
    position: "absolute",
    top: "calc(100% + 6px)",
    zIndex: 500,
    ...(fitColumn && fitBox
      ? { left: fitBox.left, width: fitBox.width }
      : align === "right" ? { right: 0, width: 280 } : { left: 0, width: 280 }),
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    boxShadow: "0 12px 32px rgba(30,27,75,0.12)",
    padding: "14px 14px 10px",
  };

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: open ? "#faf5ff" : "transparent",
          border: "none",
          borderRadius: 8,
          padding: "2px 6px",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13,
          color: empty ? "#94a3b8" : "#0f172a",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          ...triggerStyle,
        }}
        title="Click to set last contact date"
      >
        {label}
        {!hidePencil && <span style={{ fontSize: 11, color: "#cbd5e1", fontWeight: 400 }}>📅</span>}
      </button>
      {open && (
        <div style={popoverStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <button type="button" onClick={() => shiftMonth(-1)} style={{ background: "#f8f7fb", border: "1px solid #eef0f4", borderRadius: 8, width: 30, height: 30, cursor: "pointer", color: "#7c3aed", fontSize: 16 }}>‹</button>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#6d28d9" }}>{MONTH_NAMES[view.month]} {view.year}</span>
            <button type="button" onClick={() => shiftMonth(1)} style={{ background: "#f8f7fb", border: "1px solid #eef0f4", borderRadius: 8, width: 30, height: 30, cursor: "pointer", color: "#7c3aed", fontSize: 16 }}>›</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
            {WEEKDAY_LABELS.map(w => (
              <div key={w} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "#94a3b8", padding: "4px 0" }}>{w}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} />;
              const isSelected = selected && selected.getFullYear() === view.year && selected.getMonth() === view.month && selected.getDate() === day;
              const isToday = TODAY.getFullYear() === view.year && TODAY.getMonth() === view.month && TODAY.getDate() === day;
              return (
                <button
                  key={`${view.year}-${view.month}-${day}`}
                  type="button"
                  onClick={() => pickDay(day)}
                  style={{
                    border: isToday && !isSelected ? "1.5px solid #c4b5fd" : "1px solid transparent",
                    borderRadius: 8,
                    background: isSelected ? "#ede9fe" : "#ffffff",
                    color: isSelected ? "#6d28d9" : "#334155",
                    fontWeight: isSelected ? 700 : 500,
                    fontSize: 13,
                    padding: "7px 0",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#faf5ff"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = isSelected ? "#ede9fe" : "#ffffff"; }}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: "1px solid #f1f5f9" }}>
            <button type="button" onClick={() => { onChange(toIsoDate(TODAY)); close(); }} style={{ background: "none", border: "none", color: "#7c3aed", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Today</button>
            <button type="button" onClick={() => { onChange(""); close(); }} style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>Clear date</button>
          </div>
        </div>
      )}
    </span>
  );
}

// Editable variant: click the value to edit. Supports dropdown options, plain text, or a custom display renderer.
function EditableDetailRow({ label, value, options, onChange, accent, placeholder, render, multiSelect, datePicker, displayValue, valueColor }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  const textValue = cleanDetailValue(value);
  useEffect(() => { if (editing && !options && ref.current) ref.current.focus(); }, [editing, options]);

  const emptyDisplay = <span style={{ color: "#94a3b8", fontStyle: "italic", fontWeight: 400 }}>{placeholder || "—"}</span>;
  const getDisplay = () => {
    if (render) {
      const rendered = render(value);
      if (rendered != null && rendered !== false) return rendered;
    }
    if (textValue) return <span style={{ color: accent || "#0f172a", fontWeight: 500 }}>{textValue}</span>;
    return emptyDisplay;
  };

  let body;
  if (editing && datePicker) {
    body = (
      <DatePickerField
        value={value}
        display={displayValue}
        placeholder={placeholder}
        onChange={onChange}
        onClose={() => setEditing(false)}
        defaultOpen
        hidePencil
      />
    );
  } else if (editing && options && multiSelect) {
    body = (
      <InlineMultiSelect
        value={value}
        options={options}
        placeholder={placeholder}
        onChange={onChange}
        onClose={() => setEditing(false)}
        valueColor={valueColor}
      />
    );
  } else if (editing && options) {
    const allowBlank = (options || []).some(o => cleanDetailValue(o) === "");
    body = (
      <InlineSelect
        value={value}
        options={options}
        placeholder={placeholder}
        allowBlank={allowBlank}
        onChange={onChange}
        onClose={() => setEditing(false)}
      />
    );
  } else if (editing) {
    body = (
      <input ref={ref} defaultValue={value ?? ""} placeholder={placeholder}
        onBlur={e => { onChange(e.target.value); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") { onChange(e.target.value); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize: 13.5, padding: "4px 8px", borderRadius: 7, border: "1.5px solid #a78bfa", textAlign: "right", width: 200, color: "#0f172a" }} />
    );
  } else {
    body = datePicker ? (
      <DatePickerField
        value={value}
        display={displayValue}
        placeholder={placeholder}
        onChange={onChange}
        hidePencil
      />
    ) : (
      <span onClick={() => setEditing(true)} title="Click to edit" style={{ cursor: "pointer", borderRadius: 6, padding: "1px 4px", display: "inline-flex", alignItems: "center", gap: 6, minHeight: 20 }}
        onMouseEnter={e => e.currentTarget.style.background = "#faf5ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        {getDisplay()}
        <span style={{ fontSize: 11, color: "#cbd5e1" }}>✎</span>
      </span>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "9px 0", borderBottom: "1px solid #f4f4f7", gap: 16, position: "relative", zIndex: editing ? 50 : "auto" }}>
      <span style={{ fontSize: 13, color: "#94a3b8" }}>{label}</span>
      <span style={{ fontSize: 13.5, textAlign: "right" }}>{body}</span>
    </div>
  );
}
function SectionCard({ title, icon, right, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {icon && <span style={{ fontSize: 15 }}>{icon}</span>}
          <span style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{title}</span>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function DealDetail({ deal, allDeals, onBack, onOpenDeal, onUpdate, onDelete, owners, groups, markets, tiers }) {
  const set = (key, val) => onUpdate(deal.id, key, val);
  // Parsed-from-notes activity, plus any manually added notes (stored on the deal so they persist).
  const manualNotes = deal.activityNotes || [];
  const activity = useMemo(() => {
    const parsed = parseActivity(deal.notes, deal.owner);
    return [...manualNotes, ...parsed]; // manual notes are newest, shown first
  }, [deal, manualNotes]);
  const addNote = (body, who) => set("activityNotes", [{ id: "a" + Date.now(), body, who: who || deal.owner || "Unassigned", date: TODAY.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) }, ...manualNotes]);

  // Tasks, meetings, contacts live on the deal object so edits persist through onUpdate.
  // Seed tasks with the default follow-up the first time the deal is opened.
  const tasks = deal.tasks || [{ id: "t0", text: `Follow up with ${(parseMultiValue(deal.owner)[0] || "the lead").split(" ")[0]} on next step`, done: false }];
  const meetings = deal.meetings || [];
  const contacts = deal.contacts || [];

  const addTask = (text) => set("tasks", [...tasks, { id: "t" + Date.now(), text, done: false }]);
  const toggleTask = (id) => set("tasks", tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const addMeeting = (m) => set("meetings", [...meetings, { id: "m" + Date.now(), ...m }]);
  const addContact = (c) => set("contacts", [...contacts, { id: "c" + Date.now(), ...c }]);
  const removeContact = (id) => set("contacts", contacts.filter(c => c.id !== id));

  const [taskDraft, setTaskDraft] = useState("");
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingDraft, setMeetingDraft] = useState({ name: "", date: "", participants: "" });
  const [contactOpen, setContactOpen] = useState(false);
  const [contactDraft, setContactDraft] = useState({ name: "", email: "", phone: "" });
  const [noteDraft, setNoteDraft] = useState("");
  const [noteWho, setNoteWho] = useState(() => parseMultiValue(deal.owner)[0] || "");
  const noteOwners = useMemo(() => [...new Set([...parseMultiValue(deal.owner), ...owners.filter(Boolean)])], [deal.owner, owners]);

  const groupVenues = useMemo(
    () => allDeals.filter(d => d.group === deal.group).sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage)),
    [deal, allDeals]
  );
  const stale = isOnboarded(deal) ? null : staleLabel(deal.staleDays);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18, gap: 16 }}>
        <div style={{ display: "flex", gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12, background: "#1e1b4b", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, fontWeight: 700, flexShrink: 0,
          }}>{deal.venue[0]}</div>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", margin: 0, lineHeight: 1.1 }}>{deal.venue}</h1>
            <div style={{ fontSize: 13.5, color: "#94a3b8", marginTop: 3 }}>{deal.group} · {deal.market}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => onDelete(deal.id)}
            style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 9, padding: "7px 14px", fontSize: 13, fontWeight: 500, color: "#dc2626", cursor: "pointer" }}
          >
            Delete
          </button>
          <button onClick={onBack} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "7px 14px", fontSize: 13, fontWeight: 500, color: "#475569", cursor: "pointer" }}>← Back</button>
        </div>
      </div>

      {/* Header status bar */}
      <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 14, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#0f172a" }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: STAGE_DOT[deal.stage] }} />{deal.stage}
        </span>
        <span style={{ color: "#e2e8f0" }}>|</span>
        <TierBadge tier={dealTier(deal)} />
        <StatusTag status={isOnboarded(deal) ? "Onboarded" : deal.status} />
        <span style={{ color: "#e2e8f0" }}>|</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><OwnerDisplay owner={deal.owner} bar /></span>
        <span style={{ color: "#e2e8f0" }}>|</span>
        <span style={{ fontSize: 13, color: "#64748b", display: "inline-flex", alignItems: "center", gap: 6 }}>
          Last contact:
          <DatePickerField value={deal.lastContact} display={deal.lastContactDisplay} onChange={v => set("lastContact", v)} placeholder="No contact logged" />
        </span>
        {isOnboarded(deal) && (
          <>
            <span style={{ color: "#e2e8f0" }}>|</span>
            <span style={{ fontSize: 13, color: "#6d28d9", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
              Go-live:
              <DatePickerField value={deal.goLiveDate} display={deal.goLiveDateDisplay || "Set date"} onChange={v => set("goLiveDate", v)} placeholder="Set go-live date" />
            </span>
          </>
        )}
        {stale && <span style={{ fontSize: 12, color: staleTone(deal.staleDays), fontWeight: 500 }}>· {stale}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
        {/* LEFT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {(!isOnboarded(deal) && deal.status !== "Progressing" && deal.blockers) && (
            <div style={{ background: deal.status === "Stuck" ? "#fef2f2" : "#f8fafc", border: `1px solid ${deal.status === "Stuck" ? "#fecaca" : "#e2e8f0"}`, borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: deal.status === "Stuck" ? "#b91c1c" : "#64748b", textTransform: "uppercase", marginBottom: 6 }}>
                {deal.status === "Stuck" ? "Why this is stuck" : "Why not a priority"}
              </div>
              <div style={{ fontSize: 14, color: "#334155", fontWeight: 500 }}>{deal.blockers}</div>
            </div>
          )}

          <SectionCard title="Contract & Details" icon="📄" right={<span style={{ fontSize: 11.5, color: "#cbd5e1" }}>Click any value to edit</span>}>
            <EditableDetailRow label="Stage" value={deal.stage} options={STAGES} onChange={v => set("stage", v)}
              render={v => <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: 999, background: STAGE_DOT[v] }} />{v} <span style={{ color: "#94a3b8", fontWeight: 400 }}>({deal.srcStage})</span></span>} />
            <EditableDetailRow label="Tier" value={dealTier(deal)} options={tiers} onChange={v => set("tier", v)} render={v => <TierBadge tier={v} />} />
            <EditableDetailRow label="Market" value={deal.market} options={markets} onChange={v => set("market", v)} />
            <EditableDetailRow label="Restaurant Group" value={deal.group} options={groups} onChange={v => set("group", v)} />
            <EditableDetailRow label="Sales Lead" value={deal.owner} options={owners} multiSelect valueColor="#475569" onChange={v => set("owner", v)} placeholder="Unassigned"
              render={v => <OwnerDisplay owner={v} size={20} />} />
            <EditableDetailRow label="Status" value={deal.status} options={STATUSES} onChange={v => set("status", v)} render={v => <StatusTag status={v} />} />
            <EditableDetailRow label="Blockers" value={deal.blockers} options={BLOCKERS} multiSelect onChange={v => set("blockers", v)} accent={deal.blockers ? "#b91c1c" : null} placeholder="None logged" />
            <EditableDetailRow label="Deal Value" value={deal.dealValue} onChange={v => set("dealValue", v)} placeholder="Add value" render={v => v ? `$${v}` : null} />
            <EditableDetailRow label="Year 1 ARR Potential" value={deal.year1ARR} onChange={v => set("year1ARR", v)} placeholder="Add amount" render={v => v ? `$${v}` : null} />
            <EditableDetailRow label="Billing Frequency" value={deal.billing} options={["", "Monthly", "Quarterly", "Annual"]} onChange={v => set("billing", v)} placeholder="Set frequency" />
            <EditableDetailRow label="Primary Contact" value={deal.contact} onChange={v => set("contact", v)} placeholder="Add contact" />
            <EditableDetailRow label="Website" value={deal.website} onChange={v => set("website", v)} placeholder="Add website" />
            <EditableDetailRow label="Expected Close" value={deal.expectedClose} onChange={v => set("expectedClose", v)} placeholder="Set date" />
            <EditableDetailRow label="Last Contact" value={deal.lastContact} datePicker displayValue={deal.lastContactDisplay} onChange={v => set("lastContact", v)} placeholder="No contact logged" accent={deal.lastContact ? "#0f172a" : null} />
            {isOnboarded(deal) && (
              <EditableDetailRow label="Go-live date" value={deal.goLiveDate} datePicker displayValue={deal.goLiveDateDisplay} onChange={v => set("goLiveDate", v)} placeholder="Set go-live date" accent={deal.goLiveDate ? "#6d28d9" : null} />
            )}
          </SectionCard>

          <SectionCard title="Decks" icon="📑">
            <div style={{ border: "1.5px dashed #e2e8f0", borderRadius: 12, padding: 28, textAlign: "center" }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>⬆</div>
              <div style={{ fontSize: 13.5, color: "#475569", fontWeight: 500 }}>Drop a deck PDF here or click to browse</div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>PDF files up to 50 MB</div>
            </div>
          </SectionCard>

          <SectionCard title={`Group · ${deal.group}`} icon="🏛" right={<span style={{ fontSize: 12, color: "#94a3b8" }}>{groupVenues.length} venue{groupVenues.length !== 1 ? "s" : ""}</span>}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {groupVenues.map(v => (
                <button key={v.id} onClick={() => onOpenDeal(v)} title={`Open ${v.venue}`} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10,
                  border: v.id === deal.id ? "1.5px solid #c4b5fd" : "1px solid #f1f5f9",
                  background: v.id === deal.id ? "#faf5ff" : "#fff", cursor: "pointer", textAlign: "left", width: "100%",
                  fontFamily: "inherit",
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: STAGE_DOT[v.stage], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.venue}{v.id === deal.id && <span style={{ color: "#a78bfa", fontWeight: 500 }}> · current</span>}</div>
                    <div style={{ fontSize: 11.5, color: "#94a3b8" }}>{v.market} · {v.stage}</div>
                  </div>
                  {v.blockers ? <span style={{ fontSize: 11, color: "#b91c1c", maxWidth: 130, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.blockers}</span> : <span style={{ fontSize: 11, color: "#cbd5e1" }}>no blockers</span>}
                </button>
              ))}
            </div>
          </SectionCard>
        </div>

        {/* RIGHT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <SectionCard title="Tasks" icon="✓">
            <div style={{ display: "flex", flexDirection: "column" }}>
              {tasks.map(t => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                  <span onClick={() => toggleTask(t.id)} style={{ width: 17, height: 17, borderRadius: 999, flexShrink: 0, cursor: "pointer",
                    border: t.done ? "none" : "1.6px solid #cbd5e1", background: t.done ? "#10b981" : "#fff",
                    display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11 }}>{t.done ? "✓" : ""}</span>
                  <span style={{ fontSize: 13.5, flex: 1, color: t.done ? "#94a3b8" : "#475569", textDecoration: t.done ? "line-through" : "none" }}>{t.text}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input value={taskDraft} onChange={e => setTaskDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && taskDraft.trim()) { addTask(taskDraft.trim()); setTaskDraft(""); } }}
                placeholder="Add a task and press Enter"
                style={{ flex: 1, fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
              <button onClick={() => { if (taskDraft.trim()) { addTask(taskDraft.trim()); setTaskDraft(""); } }}
                style={{ fontSize: 13, fontWeight: 600, padding: "8px 14px", borderRadius: 9, border: "none", background: "#6d28d9", color: "#fff", cursor: "pointer" }}>Add</button>
            </div>
          </SectionCard>

          <SectionCard title="Meetings" icon="🗓" right={<span onClick={() => setMeetingOpen(o => !o)} style={{ fontSize: 12, color: "#7c3aed", fontWeight: 600, cursor: "pointer" }}>{meetingOpen ? "Cancel" : "+ Add"}</span>}>
            {meetings.length === 0 && !meetingOpen && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#94a3b8", fontSize: 13.5, padding: "4px 0" }}>
                <span style={{ fontSize: 16 }}>🗓</span> No meetings linked yet.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {meetings.map(m => (
                <div key={m.id} style={{ border: "1px solid #f1f5f9", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#334155" }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 3 }}>{[m.date, m.participants].filter(Boolean).join(" · ")}</div>
                </div>
              ))}
            </div>
            {meetingOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: meetings.length ? 12 : 4 }}>
                <input value={meetingDraft.name} onChange={e => setMeetingDraft(d => ({ ...d, name: e.target.value }))} placeholder="Meeting name" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <input value={meetingDraft.date} onChange={e => setMeetingDraft(d => ({ ...d, date: e.target.value }))} placeholder="Date (e.g. Jun 24, 2026)" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <input value={meetingDraft.participants} onChange={e => setMeetingDraft(d => ({ ...d, participants: e.target.value }))} placeholder="Participants (comma separated)" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <button disabled={!meetingDraft.name.trim()} onClick={() => { addMeeting(meetingDraft); setMeetingDraft({ name: "", date: "", participants: "" }); setMeetingOpen(false); }}
                  style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 600, padding: "8px 14px", borderRadius: 9, border: "none", background: meetingDraft.name.trim() ? "#6d28d9" : "#e5e7eb", color: "#fff", cursor: meetingDraft.name.trim() ? "pointer" : "default" }}>Add meeting</button>
              </div>
            )}
            {/* Calendar + Gmail sync plugs in here during the Supabase phase. Backend-dependent, so disabled in the prototype. */}
            <div title="Connects after the Supabase/Gmail phase" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderRadius: 9, border: "1px dashed #ddd6fe", background: "#faf5ff", color: "#a78bfa", fontSize: 12, cursor: "not-allowed" }}>
              <span>🔗</span> Auto-pull from Google Calendar + Gmail (available after sync is connected)
            </div>
          </SectionCard>

          <SectionCard title="Activity" icon="⚡">
            <div style={{ marginBottom: 16 }}>
              <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} rows={2} placeholder="Add a note…"
                style={{ width: "100%", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", fontSize: 13, padding: "10px 12px", borderRadius: 10, border: "1px solid #e5e7eb" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>Logged by</span>
                <select value={noteWho} onChange={e => setNoteWho(e.target.value)}
                  style={{ fontSize: 12.5, padding: "5px 9px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", color: "#475569", cursor: "pointer" }}>
                  {noteOwners.map(o => <option key={o}>{o}</option>)}
                </select>
                <button disabled={!noteDraft.trim()} onClick={() => { addNote(noteDraft.trim(), noteWho); setNoteDraft(""); }}
                  style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, padding: "7px 15px", borderRadius: 9, border: "none", background: noteDraft.trim() ? "#6d28d9" : "#e5e7eb", color: "#fff", cursor: noteDraft.trim() ? "pointer" : "default" }}>Post note</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {activity.length === 0 && <div style={{ fontSize: 13, color: "#cbd5e1" }}>No activity logged.</div>}
              {activity.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 11 }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, background: "#faf5ff", color: "#7c3aed", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>✉</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, color: "#334155", lineHeight: 1.5 }}>{a.body}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5 }}>
                      <Avatar name={a.who} size={16} />
                      <span style={{ fontSize: 11.5, color: "#94a3b8" }}>{a.who}</span>
                      {a.date && <span style={{ fontSize: 11.5, color: "#cbd5e1" }}>· {a.date}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Contacts" icon="👤" right={<span onClick={() => setContactOpen(o => !o)} style={{ fontSize: 12, color: "#7c3aed", fontWeight: 600, cursor: "pointer" }}>{contactOpen ? "Cancel" : "+ Add"}</span>}>
            {contacts.length === 0 && !contactOpen && (
              <div style={{ fontSize: 13, color: "#cbd5e1" }}>No contacts linked. Add a primary contact for {deal.venue}.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {contacts.map(c => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <Avatar name={c.name} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "#334155" }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>{[c.email, c.phone].filter(Boolean).join(" · ") || "No contact details"}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeContact(c.id)}
                    title="Remove contact"
                    style={{
                      width: 26, height: 26, borderRadius: 999, flexShrink: 0, border: "1px solid #e5e7eb",
                      background: "#fff", color: "#94a3b8", fontSize: 16, lineHeight: 1, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontFamily: "inherit",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "#fecaca"; e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "#fef2f2"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e7eb"; e.currentTarget.style.color = "#94a3b8"; e.currentTarget.style.background = "#fff"; }}
                  >
                    −
                  </button>
                </div>
              ))}
            </div>
            {contactOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: contacts.length ? 12 : 4 }}>
                <input value={contactDraft.name} onChange={e => setContactDraft(d => ({ ...d, name: e.target.value }))} placeholder="Name (required)" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <input value={contactDraft.email} onChange={e => setContactDraft(d => ({ ...d, email: e.target.value }))} placeholder="Email (optional)" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <input value={contactDraft.phone} onChange={e => setContactDraft(d => ({ ...d, phone: e.target.value }))} placeholder="Phone (optional)" style={{ fontSize: 13, padding: "8px 11px", borderRadius: 9, border: "1px solid #e5e7eb" }} />
                <button disabled={!contactDraft.name.trim()} onClick={() => { addContact(contactDraft); setContactDraft({ name: "", email: "", phone: "" }); setContactOpen(false); }}
                  style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 600, padding: "8px 14px", borderRadius: 9, border: "none", background: contactDraft.name.trim() ? "#6d28d9" : "#e5e7eb", color: "#fff", cursor: contactDraft.name.trim() ? "pointer" : "default" }}>Add contact</button>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

// ============ DEALS TABLE TAB ============
function EditableCell({ value, options, onChange, render, multiSelect, valueColor, datePicker, displayValue, fitColumn, boundsRef, hideSummary, searchPlaceholder }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (editing && !options && !datePicker && ref.current) ref.current.focus(); }, [editing, options, datePicker]);

  if (editing && datePicker) {
    return (
      <DatePickerField
        value={value}
        display={displayValue}
        onChange={onChange}
        onClose={() => setEditing(false)}
        defaultOpen
        align="right"
        hidePencil
        fitColumn={fitColumn}
        boundsRef={boundsRef}
        triggerStyle={{ fontSize: 11, fontWeight: 500, color: "#64748b" }}
      />
    );
  }
  if (editing && options && multiSelect) {
    return (
      <InlineMultiSelect
        value={value}
        options={options}
        onChange={onChange}
        onClose={() => setEditing(false)}
        valueColor={valueColor || "#475569"}
        fitColumn={fitColumn}
        boundsRef={boundsRef}
        hideSummary={hideSummary}
        searchPlaceholder={searchPlaceholder}
      />
    );
  }
  if (editing && options) {
    return (
      <InlineSelect
        value={value}
        options={options}
        onChange={onChange}
        onClose={() => setEditing(false)}
        compact
        fitColumn={fitColumn}
        boundsRef={boundsRef}
      />
    );
  }
  if (editing && !options) {
    return (
      <input ref={ref} defaultValue={value} onBlur={e => { onChange(e.target.value); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") { onChange(e.target.value); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize: 13, padding: "4px 6px", borderRadius: 7, border: "1.5px solid #a78bfa", width: 120 }} />
    );
  }
  return (
    <span onClick={e => { e.stopPropagation(); setEditing(true); }} style={{ cursor: "pointer", borderRadius: 6, display: "inline-block", padding: "1px 2px" }}
      title="Click to edit"
      onMouseEnter={e => e.currentTarget.style.background = "#faf5ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      {render ? render(value) : value}
    </span>
  );
}

function DealsTable({ deals, owners, groups, markets, tiers, onUpdate, onOpenDeal, onDelete, onExport, onManageLists, onAddDeal, onImport, onImportLive, onFilteredCountChange, filters, onFilterChange }) {
  const { search, fStage, fStatus, fMarket, fOwner, fTier, fBlocker, sort } = filters;
  const setSearch = v => onFilterChange({ search: v });
  const setFStage = v => onFilterChange({ fStage: v });
  const setFStatus = v => onFilterChange({ fStatus: v });
  const setFMarket = v => onFilterChange({ fMarket: v });
  const setFOwner = v => onFilterChange({ fOwner: v });
  const setFTier = v => onFilterChange({ fTier: v });
  const setFBlocker = v => onFilterChange({ fBlocker: v });
  const setSort = v => onFilterChange({ sort: typeof v === "function" ? v(sort) : v });
  const [draft, setDraft] = useState(null); // null = no draft open

  const tableFilters = useMemo(() => ({ search, fStage, fStatus, fMarket, fOwner, fTier, fBlocker }), [search, fStage, fStatus, fMarket, fOwner, fTier, fBlocker]);
  const tierCountMap = useMemo(() => contextualCounts(deals, tableFilters, "tier", "fTier"), [deals, tableFilters]);
  const stageCountMap = useMemo(() => contextualCounts(deals, tableFilters, "stage", "fStage"), [deals, tableFilters]);
  const statusCountMap = useMemo(() => contextualCounts(deals, tableFilters, "status", "fStatus"), [deals, tableFilters]);
  const marketCountMap = useMemo(() => contextualCounts(deals, tableFilters, "market", "fMarket"), [deals, tableFilters]);
  const ownerCountMap = useMemo(() => contextualCounts(deals, tableFilters, "owner", "fOwner"), [deals, tableFilters]);
  const blockerCountMap = useMemo(() => contextualCounts(deals, tableFilters, "blockers", "fBlocker"), [deals, tableFilters]);

  const REQUIRED = ["tier", "venue"];
  const startDraft = () => setDraft({ tier: "", venue: "", group: "", market: "", stage: "", status: "", owner: "", lastContact: "" });

  const setDraftField = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const missing = draft ? REQUIRED.filter(k => !String(draft[k]).trim()) : [];
  const draftComplete = draft && missing.length === 0;
  const commitDraft = () => { if (draftComplete) { onAddDeal(draft); setDraft(null); } };

  const filtered = useMemo(() => {
    let r = deals.filter(d =>
      (!search || (d.venue + d.group + d.market).toLowerCase().includes(search.toLowerCase())) &&
      matchesMulti(fStage, d.stage) && matchesMulti(fStatus, d.status) && matchesMulti(fMarket, d.market) && matchesMulti(fOwner, d.owner) && matchesMulti(fTier, dealTier(d)) && matchesMulti(fBlocker, d.blockers));
    r = [...r].sort((a, b) => {
      const av = a[sort.key] ?? "", bv = b[sort.key] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir;
    });
    return r;
  }, [deals, search, fStage, fStatus, fMarket, fOwner, fTier, fBlocker, sort]);

  useEffect(() => {
    onFilteredCountChange?.(filtered.length);
  }, [filtered.length, onFilteredCountChange]);

  const toggleSort = k => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : 1 }));
  const Th = ({ k, children }) => (
    <th onClick={() => toggleSort(k)} style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#94a3b8", textTransform: "uppercase", cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }}>
      {children} <span style={{ color: sort.key === k ? "#7c3aed" : "#cbd5e1" }}>{sort.key === k ? (sort.dir === 1 ? "↑" : "↓") : "⇅"}</span>
    </th>
  );
  const selStyle = { fontSize: 13, padding: "8px 12px", borderRadius: 9, border: "1px solid #e5e7eb", background: "#fff", color: "#475569", cursor: "pointer" };
  const filtersActive = search || fStage.length || fStatus.length || fMarket.length || fOwner.length || fTier.length || fBlocker.length;
  const clearFilters = () => onFilterChange({ search: "", fStage: [], fStatus: [], fMarket: [], fOwner: [], fTier: [], fBlocker: [] });

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search deals…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, fontSize: 13, padding: "9px 14px", borderRadius: 10, border: "1px solid #e5e7eb" }} />
        <MultiFilter label="All Tiers" options={tiers} selected={fTier} onChange={setFTier} counts={tierCountMap} />
        <MultiFilter label="All Stages" options={STAGES} selected={fStage} onChange={setFStage} counts={stageCountMap} />
        <MultiFilter label="All Status" options={STATUSES} selected={fStatus} onChange={setFStatus} counts={statusCountMap} />
        <MultiFilter label="All Reasons" options={BLOCKERS} selected={fBlocker} onChange={setFBlocker} counts={blockerCountMap} />
        <MultiFilter label="All Markets" options={markets.filter(Boolean)} selected={fMarket} onChange={setFMarket} counts={marketCountMap} />
        <MultiFilter label="All Leads" options={owners.filter(Boolean)} selected={fOwner} onChange={setFOwner} counts={ownerCountMap} />
        {filtersActive > 0 && <button onClick={clearFilters} style={{ ...selStyle, color: "#7c3aed", fontWeight: 600 }}>Clear filters</button>}
        <button onClick={onManageLists} style={{ ...selStyle, fontWeight: 600 }}>⚙ Manage lists</button>
        <button onClick={onImport} style={{ ...selStyle, fontWeight: 600 }}>⬆ Import CSV</button>
        <button onClick={onImportLive} style={{ ...selStyle, fontWeight: 600, color: "#6d28d9", borderColor: "#ddd6fe" }}>⬆ Import live restaurants</button>
        <button onClick={startDraft} disabled={!!draft} style={{ ...selStyle, background: draft ? "#ede9fe" : "#6d28d9", color: draft ? "#a78bfa" : "#fff", fontWeight: 600, border: "none", cursor: draft ? "default" : "pointer" }}>+ Add Deal</button>
        <button onClick={() => onExport(filtered)} style={{ ...selStyle, background: "#1e1b4b", color: "#fff", fontWeight: 600, border: "none" }}>⬇ Export CSV</button>
      </div>

      <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "1px solid #f1f5f9" }}>
              <Th k="venue">Restaurant</Th><Th k="tier">Tier</Th><Th k="stage">Stage</Th><Th k="status">Status</Th><Th k="owner">Sales Lead</Th><Th k="market">Market</Th><Th k="blockers">Blockers</Th><Th k="staleDays">Last Contact</Th><th style={{ width: 44 }} />
            </tr></thead>
            <tbody>
              {draft && (() => {
                const inp = { fontSize: 13, padding: "5px 7px", borderRadius: 7, border: "1px solid #e5e7eb", width: "100%" };
                const need = k => missing.includes(k) ? { border: "1.5px solid #fca5a5", background: "#fff7f7" } : {};
                return (
                  <tr style={{ background: "#faf5ff", borderBottom: "2px solid #ede9fe" }}>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <select value={draft.tier} onChange={e => setDraftField("tier", e.target.value)} style={{ ...inp, width: 64, ...need("tier") }}>
                          <option value="">Tier</option>{tiers.map(t => <option key={t}>{t}</option>)}
                        </select>
                        <input autoFocus placeholder="Restaurant name" value={draft.venue} onChange={e => setDraftField("venue", e.target.value)} style={{ ...inp, width: 150, ...need("venue") }} />
                        <select value={draft.group} onChange={e => setDraftField("group", e.target.value)} style={{ ...inp, width: 150, ...need("group") }}>
                          <option value="">Group…</option>{groups.filter(Boolean).map(g => <option key={g}>{g}</option>)}
                        </select>
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <select value={draft.stage} onChange={e => setDraftField("stage", e.target.value)} style={{ ...inp, ...need("stage") }}>
                        <option value="">Stage…</option>{STAGES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <select value={draft.status} onChange={e => setDraftField("status", e.target.value)} style={{ ...inp, ...need("status") }}>
                        <option value="">Status…</option>{STATUSES.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <select value={draft.owner} onChange={e => setDraftField("owner", e.target.value)} style={{ ...inp, ...need("owner") }}>
                        <option value="">Lead…</option>{owners.filter(Boolean).map(o => <option key={o}>{o}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input placeholder="YYYY-MM-DD" value={draft.lastContact} onChange={e => setDraftField("lastContact", e.target.value)} style={{ ...inp, width: 120, ...need("lastContact") }} />
                        <button onClick={commitDraft} disabled={!draftComplete} title={draftComplete ? "Save deal" : "Complete required fields"}
                          style={{ background: draftComplete ? "#10b981" : "#e5e7eb", color: "#fff", border: "none", borderRadius: 7, width: 28, height: 28, fontSize: 14, cursor: draftComplete ? "pointer" : "default", flexShrink: 0 }}>✓</button>
                        <button onClick={() => setDraft(null)} title="Cancel" style={{ background: "#fff", color: "#94a3b8", border: "1px solid #e5e7eb", borderRadius: 7, width: 28, height: 28, fontSize: 13, cursor: "pointer", flexShrink: 0 }}>✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })()}
              {draft && missing.length > 0 && (
                <tr style={{ background: "#faf5ff" }}>
                  <td colSpan={9} style={{ padding: "0 14px 10px", fontSize: 12, color: "#b45309" }}>
                    Still needed: {missing.map(k => ({ tier: "Tier", venue: "Restaurant name", group: "Group", stage: "Stage", status: "Status", owner: "Sales Lead", lastContact: "Last Contact" }[k])).join(", ")}
                  </td>
                </tr>
              )}
              {filtered.map(d => (
                <tr key={d.id} onClick={() => onOpenDeal(d)} style={{ borderBottom: "1px solid #f6f6f9", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#fcfaff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 14px" }}>
                    <div>
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>{d.venue}</span>
                      <div style={{ marginTop: 2 }} onClick={e => e.stopPropagation()}>
                        <EditableCell value={d.group} options={groups} onChange={v => onUpdate(d.id, "group", v)}
                          render={v => <span style={{ fontSize: 12, color: "#94a3b8" }}>{v || "—"}</span>} />
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={dealTier(d)} options={tiers} onChange={v => onUpdate(d.id, "tier", v)} render={v => <TierBadge tier={v} />} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.stage} options={STAGES} onChange={v => onUpdate(d.id, "stage", v)}
                      render={v => <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155" }}><span style={{ width: 7, height: 7, borderRadius: 999, background: STAGE_DOT[v] }} />{v}</span>} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    {isOnboarded(d)
                      ? <StatusTag status="Onboarded" />
                      : <EditableCell value={d.status} options={STATUSES} onChange={v => onUpdate(d.id, "status", v)} render={v => <StatusTag status={v} />} />}
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.owner} options={owners} multiSelect valueColor="#64748b" onChange={v => onUpdate(d.id, "owner", v)}
                      render={v => <OwnerDisplay owner={v} compact />} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.market} options={markets} onChange={v => onUpdate(d.id, "market", v)}
                      render={v => <span style={{ fontSize: 13, color: "#64748b" }}>{v || "—"}</span>} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.blockers} options={BLOCKERS} multiSelect valueColor="#b91c1c" onChange={v => onUpdate(d.id, "blockers", v)}
                      render={v => <span style={{ fontSize: 12, color: v ? "#b91c1c" : "#cbd5e1" }}>{v || "—"}</span>} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.lastContact} datePicker displayValue={d.lastContactDisplay} onChange={v => onUpdate(d.id, "lastContact", v)}
                      render={() => <span style={{ fontSize: 13, color: "#64748b" }}>{d.lastContactDisplay}</span>} />
                  </td>
                  <td style={{ padding: "12px 8px", textAlign: "center" }} onClick={e => e.stopPropagation()}>
                    <button
                      type="button"
                      title="Delete deal"
                      onClick={() => onDelete(d.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 16, padding: "4px 6px", borderRadius: 6, lineHeight: 1 }}
                      onMouseEnter={e => { e.currentTarget.style.color = "#dc2626"; e.currentTarget.style.background = "#fef2f2"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "#cbd5e1"; e.currentTarget.style.background = "none"; }}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#cbd5e1", fontSize: 14 }}>No deals match your filters.</div>}
        </div>
      </div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>{filtered.length} of {deals.length} deals · Click any value to edit inline · Click a row to open the deal</div>
    </div>
  );
}

// ============ MANAGE LISTS MODAL ============
function ListEditor({ title, field, options, deals, onAdd, onRename, onDelete }) {
  const [adding, setAdding] = useState("");
  const [editIdx, setEditIdx] = useState(-1);
  const editRef = useRef(null);
  useEffect(() => { if (editIdx >= 0 && editRef.current) { editRef.current.focus(); editRef.current.select(); } }, [editIdx]);
  const count = v => field === "owner"
    ? deals.filter(d => parseMultiValue(d[field]).includes(v)).length
    : deals.filter(d => d[field] === v).length;

  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: "#94a3b8", textTransform: "uppercase", marginBottom: 10 }}>{title} · {options.length}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input value={adding} onChange={e => setAdding(e.target.value)} placeholder={`Add ${title.toLowerCase().replace(/s$/, "")}…`}
          onKeyDown={e => { if (e.key === "Enter" && adding.trim()) { onAdd(field, adding); setAdding(""); } }}
          style={{ flex: 1, fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #e5e7eb" }} />
        <button onClick={() => { if (adding.trim()) { onAdd(field, adding); setAdding(""); } }}
          style={{ background: "#6d28d9", color: "#fff", border: "none", borderRadius: 8, padding: "0 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Add</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 340, overflowY: "auto" }}>
        {options.map((opt, i) => {
          const n = count(opt);
          return (
            <div key={opt + i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: editIdx === i ? "#faf5ff" : "transparent" }}
              onMouseEnter={e => { if (editIdx !== i) e.currentTarget.style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (editIdx !== i) e.currentTarget.style.background = "transparent"; }}>
              {editIdx === i ? (
                <input ref={editRef} defaultValue={opt}
                  onBlur={e => { onRename(field, opt, e.target.value); setEditIdx(-1); }}
                  onKeyDown={e => { if (e.key === "Enter") { onRename(field, opt, e.target.value); setEditIdx(-1); } if (e.key === "Escape") setEditIdx(-1); }}
                  style={{ flex: 1, fontSize: 13, padding: "4px 7px", borderRadius: 7, border: "1.5px solid #a78bfa" }} />
              ) : (
                <span style={{ flex: 1, fontSize: 13.5, color: opt ? "#334155" : "#cbd5e1" }}>{opt || "(blank)"}</span>
              )}
              <span style={{ fontSize: 11, color: "#94a3b8", background: "#f1f5f9", borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{n} deal{n !== 1 ? "s" : ""}</span>
              {editIdx !== i && (
                <>
                  <button onClick={() => setEditIdx(i)} title="Rename" style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 13, padding: 2 }}>✎</button>
                  <button onClick={() => { if (n === 0 || window.confirm(`Delete "${opt}"? ${n} deal${n !== 1 ? "s" : ""} will have their ${title.toLowerCase().replace(/s$/, "")} cleared.`)) onDelete(field, opt); }}
                    title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 14, padding: 2 }}
                    onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#cbd5e1"}>🗑</button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ManageListsModal({ deals, groups, markets, owners, priorityMarkets, onTogglePriority, onAdd, onRename, onDelete, onClose }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "60px 20px", zIndex: 50, overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, padding: 26, width: "100%", maxWidth: 1000, boxShadow: "0 20px 60px rgba(15,23,42,.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Manage lists</h2>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 9, width: 30, height: 30, fontSize: 16, cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 22px" }}>Add, rename, or delete options. New entries are saved and appear in filters and dropdowns across the app. Renaming updates every deal using that value. Deleting clears it from affected deals.</p>
        <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
          <ListEditor title="Restaurant Groups" field="group" options={groups} deals={deals} onAdd={onAdd} onRename={onRename} onDelete={onDelete} />
          <ListEditor title="Markets" field="market" options={markets} deals={deals} onAdd={onAdd} onRename={onRename} onDelete={onDelete} />
          <ListEditor title="Sales Leads" field="owner" options={owners} deals={deals} onAdd={onAdd} onRename={onRename} onDelete={onDelete} />
        </div>

        <div style={{ borderTop: "1px solid #f1f5f9", marginTop: 22, paddingTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: "#94a3b8", textTransform: "uppercase", marginBottom: 4 }}>Priority Markets · {priorityMarkets.length}</div>
          <p style={{ fontSize: 12.5, color: "#94a3b8", margin: "0 0 12px" }}>Tap a market to include or exclude it from the Dashboard's Core Market Deals count.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {markets.filter(Boolean).map(mk => {
              const on = priorityMarkets.includes(mk);
              return (
                <button key={mk} onClick={() => onTogglePriority(mk)} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${on ? "#6d28d9" : "#e5e7eb"}`, background: on ? "#6d28d9" : "#fff", color: on ? "#fff" : "#64748b",
                }}>
                  <span style={{ fontSize: 12 }}>{on ? "✓" : "+"}</span>{mk}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ CSV IMPORT MODAL ============
function ImportModal({ deals, onImport, onClose }) {
  const [stage, setStage] = useState("upload"); // upload | review
  const [parsed, setParsed] = useState([]);     // mapped rows from file
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const norm = s => (s || "").trim().toLowerCase();
  // Duplicate key is venue + market. Same name in a different market is a distinct deal.
  const keyOf = r => norm(r.venue) + "|" + norm(r.market);
  const existingByKey = useMemo(() => {
    const m = {}; deals.forEach(d => { m[keyOf(d)] = d; }); return m;
  }, [deals]);

  const handleFile = async (file) => {
    setError("");
    try {
      const text = await file.text();
      const rows = mapCSVRows(parseCSV(text));
      if (!rows.length) { setError("No rows with a recognizable restaurant/venue column were found. Make sure the file has a header row including a 'Venue' or 'Restaurant' column."); return; }
      setParsed(rows); setFileName(file.name); setStage("review");
    } catch (e) { setError("Couldn't read that file. Is it a valid .csv?"); }
  };

  // Classify rows: update existing venue+market, add new ones, block duplicate rows within the file.
  const analysis = useMemo(() => {
    const seenInFile = new Set();
    const toAdd = [], toUpdate = [], blocked = [];
    parsed.forEach((r, idx) => {
      const k = keyOf(r);
      if (seenInFile.has(k)) { blocked.push({ row: r, idx, reason: "file" }); return; }
      seenInFile.add(k);
      const existing = existingByKey[k];
      if (existing) toUpdate.push({ id: existing.id, row: r });
      else toAdd.push(r);
    });
    return { toAdd, toUpdate, blocked };
  }, [parsed, existingByKey]);

  const importCount = analysis.toAdd.length + analysis.toUpdate.length;

  const commit = async () => {
    if (!importCount || busy) return;
    setBusy(true);
    setError("");
    try {
      await onImport({ toAdd: analysis.toAdd, toUpdate: analysis.toUpdate, toDeleteIds: [] });
      onClose();
    } catch (e) {
      setError(e?.message || "Import failed. Check the error banner on the main page.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "50px 20px", zIndex: 50, overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, padding: 26, width: "100%", maxWidth: 760, boxShadow: "0 20px 60px rgba(15,23,42,.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Import deals from CSV</h2>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 9, width: 30, height: 30, fontSize: 16, cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        {stage === "upload" && (
          <>
            <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 18px" }}>Upload a CSV with a header row. Recognized columns include Restaurant/Venue (required), Restaurant Group, Tier, Market, Stage, Status, Sales Lead, Last Contact, Blockers, and the contract fields. Old stage names are mapped automatically. Rows matching an existing venue + market update that deal; new venue + market combinations are added. Duplicate rows within the same file are skipped.</p>
            <div onClick={() => fileRef.current && fileRef.current.click()}
              onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              style={{ border: "1.5px dashed #c4b5fd", borderRadius: 14, padding: 40, textAlign: "center", cursor: "pointer", background: "#faf5ff" }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>⬆</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#6d28d9" }}>Drop a CSV here or click to browse</div>
              <div style={{ fontSize: 12, color: "#a78bfa", marginTop: 4 }}>.csv files</div>
              <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
            {error && <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>{error}</div>}
          </>
        )}

        {stage === "review" && (
          <>
            <div style={{ display: "flex", gap: 10, margin: "4px 0 18px", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "#64748b" }}>{fileName} · {parsed.length} rows</span>
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
              <div style={{ flex: 1, background: "#ecfdf5", borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#047857" }}>{analysis.toAdd.length}</div>
                <div style={{ fontSize: 12, color: "#059669" }}>new deals to add</div>
              </div>
              <div style={{ flex: 1, background: "#eff6ff", borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#1d4ed8" }}>{analysis.toUpdate.length}</div>
                <div style={{ fontSize: 12, color: "#2563eb" }}>existing deals to update</div>
              </div>
              <div style={{ flex: 1, background: "#fef2f2", borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#b91c1c" }}>{analysis.blocked.length}</div>
                <div style={{ fontSize: 12, color: "#dc2626" }}>duplicate rows skipped</div>
              </div>
            </div>

            {analysis.blocked.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: "#94a3b8", textTransform: "uppercase", marginBottom: 10 }}>Blocked rows (skipped)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
                  {analysis.blocked.map((b, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid #fecaca", background: "#fffafa", borderRadius: 10, padding: "9px 12px" }}>
                      <span style={{ color: "#ef4444", fontSize: 14 }}>⊘</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a" }}>{b.row.venue || "(no name)"} <span style={{ color: "#94a3b8", fontWeight: 500 }}>· {b.row.market || "no market"}</span></div>
                        <div style={{ fontSize: 11.5, color: "#dc2626" }}>Appears earlier in the file with the same venue + market</div>
                      </div>
                      <span style={{ fontSize: 11, color: "#cbd5e1", whiteSpace: "nowrap" }}>row {b.idx + 2}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 8 }}>To import a blocked row, give it a different market or change the venue name, then re-upload.</div>
              </div>
            )}

            {error && <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>{error}</div>}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
              <button onClick={() => { setStage("upload"); setParsed([]); }} disabled={busy} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 500, color: "#64748b", cursor: busy ? "default" : "pointer" }}>← Choose different file</button>
              <button onClick={commit} disabled={!importCount || busy} style={{ background: importCount && !busy ? "#6d28d9" : "#e5e7eb", color: "#fff", border: "none", borderRadius: 9, padding: "9px 18px", fontSize: 13.5, fontWeight: 600, cursor: importCount && !busy ? "pointer" : "default" }}>{busy ? "Importing…" : `Import ${importCount} deal${importCount !== 1 ? "s" : ""}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const LIVE_CSV_FIELD_ALIASES = {
  group: ["account name", "accountname", "group", "restaurant group"],
  venue: ["restaurant name", "restaurantname", "venue", "restaurant"],
  goLiveDate: ["go live date", "golivedate", "live date"],
  tier: ["restaurant tier", "restauranttier", "tier"],
  market: ["market", "city"],
  salesRep1: ["sales rep name", "salesrepname", "sales lead", "owner", "primary sales rep"],
  salesRep2: ["second sales rep name", "secondsalesrepname", "second sales lead"],
  salesRep3: ["third sales rep name", "thirdsalesrepname", "third sales lead"],
};

function normalizeCSVHeader(h) {
  return h.trim().toLowerCase().replace(/^\ufeff/, "").replace(/_/g, " ").replace(/\s+/g, " ");
}

function mapLiveCSVRows(rows) {
  if (rows.length < 1) return [];
  const header = rows[0].map(normalizeCSVHeader);
  const colIndex = {};
  for (const [field, aliases] of Object.entries(LIVE_CSV_FIELD_ALIASES)) {
    const idx = header.findIndex(h => aliases.includes(h));
    if (idx >= 0) colIndex[field] = idx;
  }
  if (colIndex.tier === undefined) {
    const idx = header.findIndex(h => h.includes("tier"));
    if (idx >= 0) colIndex.tier = idx;
  }
  return rows.slice(1).map(r => {
    const o = {};
    for (const [field, idx] of Object.entries(colIndex)) o[field] = (r[idx] || "").trim();
    if (o.tier) o.tier = normalizeTier(o.tier);
    return o;
  }).filter(o => (o.venue || "").trim());
}

function normVenueName(s) {
  return (s || "").trim().toLowerCase();
}

function buildLiveRestaurantPayload(row) {
  return {
    venue: (row.venue || "").trim(),
    group: (row.group || "").trim() || "No Group",
    tier: normalizeTier(row.tier) || "",
    market: (row.market || "").trim(),
    stage: "Onboarded",
    srcStage: "Onboarded",
    status: "Progressing",
    owner: ownersFromLiveRow(row),
    goLiveDate: parseLiveDate(row.goLiveDate),
    blockers: "",
  };
}

function LiveRestaurantsImportModal({ deals, onImport, onClose }) {
  const [stage, setStage] = useState("upload");
  const [parsed, setParsed] = useState([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const venueIndex = useMemo(() => {
    const m = {};
    deals.forEach(d => {
      const k = normVenueName(d.venue);
      if (!m[k]) m[k] = [];
      m[k].push(d);
    });
    return m;
  }, [deals]);

  const handleFile = async (file) => {
    setError("");
    try {
      const text = await file.text();
      const rows = mapLiveCSVRows(parseCSV(text));
      if (!rows.length) {
        setError("No rows found. Include a header row with restaurant_name (or restaurant name) and go_live_date.");
        return;
      }
      setParsed(rows);
      setFileName(file.name);
      setStage("review");
    } catch {
      setError("Couldn't read that file. Is it a valid .csv?");
    }
  };

  const analysis = useMemo(() => {
    const toUpdate = [];
    const toAdd = [];
    parsed.forEach(row => {
      const matches = venueIndex[normVenueName(row.venue)] || [];
      if (matches.length) {
        matches.forEach(d => toUpdate.push({ deal: d, row }));
      } else {
        toAdd.push(row);
      }
    });
    return { toUpdate, toAdd };
  }, [parsed, venueIndex]);

  const updateVenueCount = useMemo(() => new Set(analysis.toUpdate.map(x => normVenueName(x.row.venue))).size, [analysis.toUpdate]);
  const importCount = analysis.toUpdate.length + analysis.toAdd.length;

  const commit = async () => {
    if (!importCount || busy) return;
    setBusy(true);
    setError("");
    try {
      await onImport(parsed);
      onClose();
    } catch (e) {
      setError(e?.message || "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "50px 20px", zIndex: 50, overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, padding: 26, width: "100%", maxWidth: 760, boxShadow: "0 20px 60px rgba(15,23,42,.25)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Import live restaurants</h2>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 9, width: 30, height: 30, fontSize: 16, cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        {stage === "upload" && (
          <>
            <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 18px", lineHeight: 1.55 }}>
              Upload your live-restaurant export. Expected columns: <strong>account_name</strong>, <strong>restaurant_name</strong>, <strong>go_live_date</strong> (MM/DD/YYYY), <strong>restaurant_tier</strong>, <strong>market</strong>, and up to three sales rep columns.
              Matching restaurants by name are moved to <strong>Onboarded</strong> with updated tier, market, sales lead(s), and go-live date. New names are added as onboarded deals.
            </p>
            <div onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              style={{ border: "1.5px dashed #c4b5fd", borderRadius: 14, padding: 40, textAlign: "center", cursor: "pointer", background: "#faf5ff" }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>⬆</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#6d28d9" }}>Drop live restaurants CSV here</div>
              <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
            </div>
            {error && <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>{error}</div>}
          </>
        )}

        {stage === "review" && (
          <>
            <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 14px" }}>{fileName} · {parsed.length} row{parsed.length !== 1 ? "s" : ""}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
              <div style={{ background: "#f5f3ff", borderRadius: 12, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#6d28d9" }}>{analysis.toUpdate.length}</div>
                <div style={{ fontSize: 12, color: "#7c3aed" }}>pipeline deal{analysis.toUpdate.length !== 1 ? "s" : ""} to onboard</div>
              </div>
              <div style={{ background: "#ecfdf5", borderRadius: 12, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#047857" }}>{analysis.toAdd.length}</div>
                <div style={{ fontSize: 12, color: "#059669" }}>new live restaurant{analysis.toAdd.length !== 1 ? "s" : ""}</div>
              </div>
              <div style={{ background: "#f8fafc", borderRadius: 12, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: "#475569" }}>{updateVenueCount}</div>
                <div style={{ fontSize: 12, color: "#64748b" }}>unique name{updateVenueCount !== 1 ? "s" : ""} matched</div>
              </div>
            </div>
            <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid #eef0f4", borderRadius: 12 }}>
              {parsed.slice(0, 40).map((row, i) => {
                const matches = venueIndex[normVenueName(row.venue)] || [];
                return (
                  <div key={i} style={{ padding: "10px 14px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                    <div style={{ fontWeight: 600, color: "#0f172a" }}>{row.venue}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                      {matches.length ? `Onboard ${matches.length} match${matches.length !== 1 ? "es" : ""}` : "Add as new onboarded"} · {row.market || "no market"} · Live {row.goLiveDate || "—"} · {ownersFromLiveRow(row) || "no lead"}
                    </div>
                  </div>
                );
              })}
              {parsed.length > 40 && <div style={{ padding: 12, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>…and {parsed.length - 40} more</div>}
            </div>
            {error && <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
              <button onClick={() => { setStage("upload"); setParsed([]); }} disabled={busy} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 500, color: "#64748b", cursor: busy ? "default" : "pointer" }}>← Choose different file</button>
              <button onClick={commit} disabled={!importCount || busy} style={{ background: importCount && !busy ? "#6d28d9" : "#e5e7eb", color: "#fff", border: "none", borderRadius: 9, padding: "9px 18px", fontSize: 13.5, fontWeight: 600, cursor: importCount && !busy ? "pointer" : "default" }}>{busy ? "Importing…" : `Onboard ${importCount} deal${importCount !== 1 ? "s" : ""}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============ APP SHELL ============
function recompute(d) {
  const tier = normalizeTier(d.tier) || (d.tier || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((d.lastContact || "").trim());
  const goLive = parseIsoDate(d.goLiveDate);
  let staleDays = null;
  let lastContactDisplay = d.lastContact && String(d.lastContact).trim() ? d.lastContact : "No contact logged";
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    const days = Math.round((TODAY - dt) / 86400000);
    staleDays = days >= 0 ? days : null;
    lastContactDisplay = dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  }
  return {
    ...d,
    tier,
    staleDays,
    lastContactDisplay,
    goLiveDateDisplay: goLive ? formatGoLiveDisplay(d.goLiveDate) : "",
  };
}

function buildInsights(allDeals) {
  const deals = allDeals.filter(d => !isOnboarded(d)); // onboarded venues have left the pipeline
  const out = [];
  const aPlusStuck = deals.filter(d => d.tier === "A+" && d.status === "Stuck");
  if (aPlusStuck.length) out.push({ tone: "#ef4444", title: `${aPlusStuck.length} A+ deals are stuck`, body: `Your highest-tier venues are blocked. Leading blockers: ${[...new Set(aPlusStuck.map(d => d.blockers).filter(Boolean))].slice(0, 3).join(", ") || "unspecified"}. These need senior intervention.`, deals: aPlusStuck.slice(0, 5) });
  const moneyBlocked = deals.filter(d => /money|price|fees|min spend/i.test(d.blockers || ""));
  if (moneyBlocked.length) out.push({ tone: "#f59e0b", title: `${moneyBlocked.length} deals blocked on economics`, body: `Money is the single most common blocker in the pipeline. Consider a standardized counter-offer framework to unblock these in bulk.`, deals: moneyBlocked.slice(0, 5) });
  const controlBlocked = deals.filter(d => /control/i.test(d.blockers));
  if (controlBlocked.length) out.push({ tone: "#8b5cf6", title: `${controlBlocked.length} deals citing control concerns`, body: `Partners want full control over their venue and membership model. A lighter-touch integration tier may convert these.`, deals: controlBlocked.slice(0, 4) });
  const signedReady = deals.filter(d => d.stage === "Offer Sent" && d.status === "Progressing");
  if (signedReady.length) out.push({ tone: "#10b981", title: `${signedReady.length} offers progressing toward signature`, body: `These have an offer out and positive momentum. Prioritize follow-ups to close before the next board cycle.`, deals: signedReady.slice(0, 5) });
  const unresponsive = deals.filter(d => /unresponsive/i.test(d.blockers));
  if (unresponsive.length) out.push({ tone: "#94a3b8", title: `${unresponsive.length} targets have gone dark`, body: `Marked unresponsive with no recent activity. Try a new outreach pathway or warm intro, or deprioritize to clear focus.`, deals: unresponsive.slice(0, 4) });
  return out;
}

function buildTasks(deals) {
  const prog = deals.filter(d => d.status === "Progressing" && d.stage !== "Signed");
  return prog.slice(0, 8).map((d, i) => ({
    title: d.stage === "Offer Sent" ? `Push ${d.venue} for signature` : `Advance ${d.venue} to next stage`,
    venue: d.venue, owner: d.owner,
    due: ["May 27, 2026", "May 27, 2026", "Jun 1, 2026", "Jun 8, 2026", "Jun 10, 2026", "Jun 12, 2026", "Jun 15, 2026", "Jun 20, 2026"][i],
    overdue: i < 3,
  }));
}

function toCSV(rows) {
  const cols = ["venue", "group", "tier", "market", "stage", "srcStage", "status", "owner", "lastContact", "blockers", "dealValue", "year1ARR", "billing", "contact", "website", "expectedClose", "notes"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, and newlines inside quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

// Map header names (flexible aliases) to canonical deal fields.
const CSV_FIELD_ALIASES = {
  venue: ["venue", "restaurant", "restaurant name", "name", "company"],
  group: ["group", "restaurant group", "restaurantgroup"],
  tier: ["tier", "restaurant tier", "venue tier", "account tier", "deal tier", "priority tier", "priority"],
  market: ["market", "city"],
  stage: ["stage"],
  status: ["status"],
  owner: ["owner", "sales lead", "saleslead", "lead", "deal owner"],
  lastContact: ["lastcontact", "last contact", "last activity", "lastactivity"],
  blockers: ["blockers", "blocker", "reason"],
  dealValue: ["dealvalue", "deal value", "value", "arr"],
  year1ARR: ["year1arr", "year 1 arr", "year 1 arr potential", "arr potential"],
  billing: ["billing", "billing frequency"],
  contact: ["contact", "primary contact"],
  website: ["website", "url"],
  expectedClose: ["expectedclose", "expected close"],
  notes: ["notes", "note"],
};
function mapCSVRows(rows) {
  if (rows.length < 1) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/^\ufeff/, "").replace(/\s+/g, " "));
  const colIndex = {};
  for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES)) {
    const idx = header.findIndex(h => aliases.includes(h));
    if (idx >= 0) colIndex[field] = idx;
  }
  if (colIndex.tier === undefined) {
    const idx = header.findIndex(h => h === "tier" || h.includes("tier"));
    if (idx >= 0) colIndex.tier = idx;
  }
  return rows.slice(1).map(r => {
    const o = {};
    for (const [field, idx] of Object.entries(colIndex)) o[field] = (r[idx] || "").trim();
    if (o.tier) o.tier = normalizeTier(o.tier);
    return o;
  }).filter(o => (o.venue || "").trim());
}


export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState("");

  const [deals, setDeals] = useState([]);
  const [uiState, setUiState] = useState(loadUiState);
  const tab = uiState.tab;
  const setTab = useCallback((t) => {
    setUiState(prev => {
      const next = { ...prev, tab: t };
      if (t !== "detail") saveUiState(next);
      return next;
    });
  }, []);
  const onFilterChange = useCallback((patch) => {
    setUiState(prev => {
      const next = { ...prev, ...patch };
      saveUiState(next);
      return next;
    });
  }, []);
  const filters = useMemo(() => ({
    search: uiState.search,
    fStage: uiState.fStage,
    fStatus: uiState.fStatus,
    fMarket: uiState.fMarket,
    fOwner: uiState.fOwner,
    fTier: uiState.fTier,
    fBlocker: uiState.fBlocker,
    sort: uiState.sort,
  }), [uiState]);
  const [headerDealCount, setHeaderDealCount] = useState(null);
  const [returnTab, setReturnTab] = useState("deals");
  const [openDeal, setOpenDeal] = useState(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [liveImportOpen, setLiveImportOpen] = useState(false);

  const [savedLists, setSavedLists] = useState({ group: [], market: [], owner: [] });
  const [priorityMarkets, setPriorityMarkets] = useState([]);

  const dealLists = useMemo(() => {
    const clean = (v) => (v == null ? "" : String(v).trim());
    return {
      group: [...new Set(deals.map(d => clean(d.group)).filter(Boolean))],
      market: [...new Set(deals.map(d => clean(d.market)).filter(Boolean))],
      owner: [...new Set(deals.flatMap(d => parseMultiValue(d.owner)).filter(Boolean))],
    };
  }, [deals]);

  const mergeSortedLists = (a, b) => [...new Set([...a, ...b].filter(Boolean))].sort();
  const groups = useMemo(() => mergeSortedLists(dealLists.group, savedLists.group), [dealLists, savedLists]);
  const markets = useMemo(() => mergeSortedLists(dealLists.market, savedLists.market), [dealLists, savedLists]);
  const owners = useMemo(() => mergeSortedLists(dealLists.owner, savedLists.owner), [dealLists, savedLists]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError("");
    try {
      const [rows, settings] = await Promise.all([fetchDeals(), fetchAppSettings()]);
      const computed = rows.map(recompute);
      setDeals(computed);
      setSavedLists(settings.managedLists || { group: [], market: [], owner: [] });
      setPriorityMarkets(settings.priorityMarkets?.length ? settings.priorityMarkets : ["New York", "London", "LA", "Miami", "Chicago", "Dubai", "SF"]);
      if (!rows.length) {
        try {
          const access = await fetchAccessStatus();
          if (access && access.allowed === false) {
            setDbError(
              `Signed in as ${access.email || "your account"}, but this email domain isn't authorized yet. Ask an admin to add it in Supabase (allowed_email_domains), then refresh.`
            );
          }
        } catch {
          // get_access_status not deployed yet — domain allowlist fix still applies
        }
      }
    } catch (e) {
      setDbError(e.message || "Failed to load pipeline data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) loadAll();
    else setDeals([]);
  }, [session, loadAll]);

  useEffect(() => {
    if (tab === "pipeline" || tab === "deals") setHeaderDealCount(deals.length);
  }, [tab, deals.length]);

  const reportFilteredCount = useCallback((n) => setHeaderDealCount(n), []);

  const insights = useMemo(() => buildInsights(deals), [deals]);
  const tasks = useMemo(() => buildTasks(deals), [deals]);
  const tiers = useMemo(() => tierOptions(deals), [deals]);

  const persistError = (e) => setDbError(e?.message || "Save failed. Your change may not have been stored.");

  const update = async (id, key, val) => {
    const prev = deals;
    const source = deals.find(d => d.id === id);
    if (!source) return;

    const group = source.group;
    const canSyncGroup = hasSyncableGroup(group);

    if (key === "activityNotes" && canSyncGroup) {
      const added = activityNotesAdded(source.activityNotes, val);
      if (!added.length) {
        setDeals(ds => ds.map(d => d.id === id ? recompute({ ...d, activityNotes: val }) : d));
        try {
          const saved = await updateDealField(id, key, val);
          setDeals(ds => ds.map(d => d.id === id ? recompute(saved) : d));
          setDbError("");
        } catch (e) {
          setDeals(prev);
          persistError(e);
        }
        return;
      }

      const patches = deals
        .filter(d => d.group === group)
        .map(d => ({
          id: d.id,
          activityNotes: d.id === id ? val : [...added, ...(d.activityNotes || [])],
        }));

      setDeals(ds => ds.map(d => {
        const patch = patches.find(p => p.id === d.id);
        return patch ? recompute({ ...d, activityNotes: patch.activityNotes }) : d;
      }));

      try {
        const saved = await Promise.all(
          patches.map(p => updateDealField(p.id, "activityNotes", p.activityNotes))
        );
        const byId = Object.fromEntries(saved.map(d => [d.id, recompute(d)]));
        setDeals(ds => ds.map(d => byId[d.id] || d));
        setDbError("");
      } catch (e) {
        setDeals(prev);
        persistError(e);
      }
      return;
    }

    const syncGroup = GROUP_SYNC_FIELDS.has(key) && canSyncGroup;

    setDeals(ds => ds.map(d => {
      if (syncGroup ? d.group === group : d.id === id) return recompute({ ...d, [key]: val });
      return d;
    }));

    try {
      const saved = syncGroup
        ? await updateDealFieldByGroup(group, key, val)
        : [await updateDealField(id, key, val)];
      const byId = Object.fromEntries(saved.map(d => [d.id, recompute(d)]));
      setDeals(ds => ds.map(d => byId[d.id] || d));
      setDbError("");
    } catch (e) {
      setDeals(prev);
      persistError(e);
    }
  };

  const addDeal = async (draft) => {
    const stage = draft.stage || "Lead";
    const status = draft.status || "Not a priority";
    const group = draft.group || "No Group";
    const payload = {
      venue: draft.venue.trim(), group, tier: draft.tier,
      market: draft.market || "", stage, srcStage: stage,
      status, owner: draft.owner || "", lastContact: (draft.lastContact || "").trim(),
      blockers: "", notes: "", dealValue: "", year1ARR: "", billing: "", contact: "", website: "", expectedClose: "",
      tasks: [], meetings: [], contacts: [], activityNotes: [],
    };
    try {
      const saved = await insertDeal(payload);
      const rec = recompute(saved);
      setDeals(ds => [rec, ...ds]);
      setDbError("");
    } catch (e) {
      persistError(e);
    }
  };

  const buildDealFromRow = (row, id) => {
    const rawStage = (row.stage || "").trim();
    const stage = mapStage(rawStage);
    const isUnsuccessful = rawStage.toLowerCase() === "unsuccessful";
    const status = row.status || (isUnsuccessful ? "Stuck" : "Not a priority");
    const base = {
      venue: (row.venue || "").trim(), group: row.group || "No Group", tier: normalizeTier(row.tier) || "",
      market: row.market || "", stage, srcStage: row.srcStage || rawStage || stage, status,
      owner: row.owner || "", lastContact: (row.lastContact || "").trim(), blockers: row.blockers || "",
      notes: row.notes || "", dealValue: row.dealValue || "", year1ARR: row.year1ARR || "", billing: row.billing || "",
      contact: row.contact || "", website: row.website || "", expectedClose: row.expectedClose || "",
      tasks: row.tasks ?? [], meetings: row.meetings ?? [], contacts: row.contacts ?? [], activityNotes: row.activityNotes ?? [],
      goLiveDate: row.goLiveDate || "",
    };
    return recompute(id ? { ...base, id } : base);
  };

  const importLiveRestaurants = async (parsedRows) => {
    const venueIndex = {};
    deals.forEach(d => {
      const k = normVenueName(d.venue);
      if (!venueIndex[k]) venueIndex[k] = [];
      venueIndex[k].push(d);
    });

    const toUpsert = [];
    const toInsert = [];

    for (const row of parsedRows) {
      const patch = buildLiveRestaurantPayload(row);
      const matches = venueIndex[normVenueName(row.venue)] || [];
      if (matches.length) {
        matches.forEach(d => toUpsert.push(recompute({ ...d, ...patch })));
      } else {
        const rec = recompute({
          ...patch,
          lastContact: "",
          notes: "", dealValue: "", year1ARR: "", billing: "", contact: "", website: "", expectedClose: "",
          tasks: [], meetings: [], contacts: [], activityNotes: [],
        });
        delete rec.id;
        toInsert.push(rec);
      }
    }

    try {
      if (toUpsert.length) await upsertDeals(toUpsert);
      if (toInsert.length) await insertDeals(toInsert);
      await loadAll();
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
      throw e;
    }
  };

  const importDeals = async ({ toAdd, toUpdate, toDeleteIds }) => {
    try {
      await deleteDealsByIds(toDeleteIds);
      const updated = toUpdate.map(u => {
        const existing = deals.find(d => d.id === u.id);
        return buildDealFromRow({ ...existing, ...u.row }, u.id);
      });
      await upsertDeals(updated);
      const added = toAdd.map(r => {
        const rec = buildDealFromRow(r, null);
        delete rec.id;
        return rec;
      });
      await insertDeals(added);
      await loadAll();
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
      throw e;
    }
  };

  const updateSavedList = async (field, nextList) => {
    setSavedLists(prev => ({ ...prev, [field]: nextList }));
    try {
      await saveManagedList(field, nextList);
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
    }
  };

  const addOption = async (field, value) => {
    const v = value.trim();
    if (!v) return;
    const merged = mergeSortedLists(dealLists[field], savedLists[field]);
    if (merged.includes(v)) return;
    await updateSavedList(field, [...savedLists[field], v].sort());
  };

  const renameOption = async (field, oldV, newV) => {
    const v = newV.trim(); if (!v || v === oldV) return;
    const merged = mergeSortedLists(dealLists[field], savedLists[field]);
    let nextSaved = savedLists[field].map(x => x === oldV ? v : x);
    if (!nextSaved.includes(v) && merged.includes(oldV)) nextSaved = [...nextSaved, v];
    nextSaved = [...new Set(nextSaved)].filter(Boolean).sort();
    await updateSavedList(field, nextSaved);
    const affected = deals.filter(d => dealFieldIncludes(d, field, oldV));
    setDeals(ds => ds.map(d => dealFieldIncludes(d, field, oldV)
      ? recompute({ ...d, [field]: field === "owner" ? replaceInMultiValue(d[field], oldV, v) : v })
      : d));
    if (field === "market") setPriorityMarkets(pm => pm.map(x => x === oldV ? v : x));
    try {
      for (const d of affected) {
        const newVal = field === "owner" ? replaceInMultiValue(d[field], oldV, v) : v;
        await updateDealField(d.id, field, newVal);
      }
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
    }
  };
  const deleteOption = async (field, value) => {
    const nextSaved = savedLists[field].filter(x => x !== value);
    await updateSavedList(field, nextSaved);
    const affected = deals.filter(d => dealFieldIncludes(d, field, value));
    setDeals(ds => ds.map(d => {
      if (!dealFieldIncludes(d, field, value)) return d;
      const newVal = field === "owner" ? removeFromMultiValue(d[field], value) : "";
      return recompute({ ...d, [field]: newVal });
    }));
    if (field === "market") setPriorityMarkets(pm => pm.filter(x => x !== value));
    try {
      for (const d of affected) {
        const newVal = field === "owner" ? removeFromMultiValue(d[field], value) : "";
        await updateDealField(d.id, field, newVal);
      }
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
    }
  };
  const togglePriorityMarket = async (mk) => {
    const next = priorityMarkets.includes(mk) ? priorityMarkets.filter(x => x !== mk) : [...priorityMarkets, mk];
    setPriorityMarkets(next);
    try {
      await savePriorityMarkets(next);
      setDbError("");
    } catch (e) {
      persistError(e);
    }
  };

  const deleteDeal = async (id) => {
    const deal = deals.find(d => d.id === id);
    if (!deal) return;
    const label = deal.market ? `${deal.venue} (${deal.market})` : deal.venue;
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;

    const prev = deals;
    setDeals(ds => ds.filter(d => d.id !== id));
    if (openDeal?.id === id) goBackFromDeal();

    try {
      await deleteDealsByIds([id]);
      setDbError("");
    } catch (e) {
      setDeals(prev);
      persistError(e);
    }
  };

  const exportCSV = rows => {
    const blob = new Blob([toCSV(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dorsia_bd_pipeline.csv"; a.click();
    URL.revokeObjectURL(url);
  };
  const goDeal = d => {
    if (tab !== "detail") setReturnTab(tab);
    setOpenDeal(d);
    setTab("detail");
    window.scrollTo(0, 0);
  };
  const goBackFromDeal = () => {
    setOpenDeal(null);
    setTab(returnTab);
    window.scrollTo(0, 0);
  };
  const goPipeline = () => { setOpenDeal(null); setTab("pipeline"); window.scrollTo(0, 0); };
  const liveDeal = openDeal ? deals.find(d => d.id === openDeal.id) || openDeal : null;

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
  };

  if (!supabaseConfigured) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Inter, sans-serif" }}>
        <div style={{ maxWidth: 480, background: "#fff", borderRadius: 16, padding: 28, border: "1px solid #eef0f4" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Supabase not configured</h1>
          <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, margin: 0 }}>
            Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to a <code>.env</code> file locally and in Vercel project settings, then redeploy.
          </p>
        </div>
      </div>
    );
  }

  if (!authReady) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>Loading…</div>;
  }

  if (!session) return <LoginScreen />;

  const TABS = [
    { id: "dashboard", label: "Dashboard" },
    { id: "deals", label: "Deals" },
    { id: "pipeline", label: "Pipeline" },
  ];
  const visibleDealCount = headerDealCount ?? deals.length;
  const titles = {
    dashboard: ["Dashboard", "Pipeline overview and key metrics"],
    pipeline: ["Pipeline", `${visibleDealCount} deals across 4 stages`],
    deals: ["Deals", `${visibleDealCount} deals`],
    detail: ["", ""],
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7fb", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: "#0f172a" }}>
      <style>{`
        * { box-sizing: border-box; }
        html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100%; color-scheme: light only; }
        body { display: block; place-items: initial; background: #f7f7fb; color: #0f172a; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        #root { max-width: none; margin: 0; padding: 0; text-align: left; color: #0f172a; }
        button { font-family: inherit; color: inherit; }
        select, option { color-scheme: light only; color: #0f172a; background-color: #fff; }
        input, textarea { color: #0f172a; background-color: #fff; }
      `}</style>

      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "28px 28px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
          <BrandWordmark size={16} onClick={goPipeline} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#64748b" }}>{session.user.email}</span>
            <button onClick={signOut} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "7px 12px", fontSize: 13, cursor: "pointer", color: "#475569" }}>Sign out</button>
          </div>
        </div>

        {dbError && (
          <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 10, background: "#fef2f2", color: "#b91c1c", fontSize: 13, border: "1px solid #fecaca" }}>
            {dbError}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>Loading pipeline…</div>
        ) : (
          <>
            {tab !== "detail" && (
              <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid #ededf3" }}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{
                    background: "none", border: "none", padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer",
                    color: tab === t.id ? "#6d28d9" : "#94a3b8", borderBottom: tab === t.id ? "2px solid #6d28d9" : "2px solid transparent", marginBottom: -1,
                  }}>{t.label}</button>
                ))}
              </div>
            )}

            {tab !== "detail" && (
              <div style={{ marginBottom: 22 }}>
                <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>{titles[tab][0]}</h1>
                <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 4 }}>{titles[tab][1]}</div>
              </div>
            )}

            {tab === "dashboard" && <DashboardTab deals={deals} insights={insights} tasks={tasks} onOpenDeal={goDeal} priorityMarkets={priorityMarkets} />}
            {tab === "pipeline" && <PipelineTab deals={deals} onOpenDeal={goDeal} onUpdate={update} owners={owners} markets={markets} tiers={tiers} onFilteredCountChange={reportFilteredCount} filters={filters} onFilterChange={onFilterChange} />}
            {tab === "deals" && <DealsTable deals={deals} owners={owners} groups={groups} markets={markets} tiers={tiers} onUpdate={update} onOpenDeal={goDeal} onDelete={deleteDeal} onExport={exportCSV} onManageLists={() => setManageOpen(true)} onAddDeal={addDeal} onImport={() => setImportOpen(true)} onImportLive={() => setLiveImportOpen(true)} onFilteredCountChange={reportFilteredCount} filters={filters} onFilterChange={onFilterChange} />}
            {tab === "detail" && liveDeal && <DealDetail deal={liveDeal} allDeals={deals} onBack={goBackFromDeal} onOpenDeal={goDeal} onUpdate={update} onDelete={deleteDeal} owners={owners} groups={groups} markets={markets} tiers={tiers} />}
          </>
        )}
      </div>
      {manageOpen && <ManageListsModal deals={deals} groups={groups} markets={markets} owners={owners} priorityMarkets={priorityMarkets} onTogglePriority={togglePriorityMarket} onAdd={addOption} onRename={renameOption} onDelete={deleteOption} onClose={() => setManageOpen(false)} />}
      {importOpen && <ImportModal deals={deals} onImport={importDeals} onClose={() => setImportOpen(false)} />}
      {liveImportOpen && <LiveRestaurantsImportModal deals={deals} onImport={importLiveRestaurants} onClose={() => setLiveImportOpen(false)} />}
    </div>
  );
}
