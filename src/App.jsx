import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { supabase, supabaseConfigured } from "./lib/supabase.js";
import LoginScreen from "./components/LoginScreen.jsx";
import {
  fetchDeals,
  fetchAppSettings,
  savePriorityMarkets,
  insertDeal,
  insertDeals,
  updateDealField,
  deleteDealsByIds,
  upsertDeals,
} from "./lib/dealsDb.js";
import { TIER_ORDER, normalizeTier, dealTier, tierOptions, tierCounts } from "./lib/tiers.js";

// Pipeline data lives in Supabase. Initial seed: scripts/deals-seed.json + scripts/seed-deals.mjs

// ============ CONSTANTS ============
const STAGES = ["Lead", "Conversation", "Offer Sent", "Signed", "Onboarded"];
// Onboarded means the venue has left the pipeline and joined Dorsia. It is excluded from
// pipeline counts, status rollups, and insights. PIPELINE_STAGES is everything except Onboarded.
const PIPELINE_STAGES = ["Lead", "Conversation", "Offer Sent", "Signed"];
const isOnboarded = d => d.stage === "Onboarded";
const STATUSES = ["Progressing", "Stuck", "Not a priority"];

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

function matchesMulti(selected, value) {
  return !selected.length || selected.includes(value);
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

// ============ PIPELINE TAB ============
function PipelineCard({ deal, onClick }) {
  const stale = isOnboarded(deal) ? null : staleLabel(deal.staleDays);
  return (
    <button onClick={onClick} style={{
      width: "100%", textAlign: "left", background: "#fff", border: "1px solid #eef0f4",
      borderRadius: 12, padding: 13, cursor: "pointer", display: "block",
      transition: "border-color .15s, box-shadow .15s",
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "#d8b4fe"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(124,58,237,.08)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "#eef0f4"; e.currentTarget.style.boxShadow = "none"; }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{deal.venue}</div>
          <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{deal.group}</div>
        </div>
        <TierBadge tier={dealTier(deal)} />
      </div>
      <div style={{ marginTop: 10, marginBottom: 10 }}><StatusTag status={isOnboarded(deal) ? "Onboarded" : deal.status} /></div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Avatar name={deal.owner} size={20} />
          <span style={{ fontSize: 11, color: "#64748b" }}>{deal.market}</span>
        </div>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{deal.lastContactDisplay !== "No contact logged" ? deal.lastContactDisplay : "—"}</span>
      </div>
      {stale && (
        <div style={{ marginTop: 9, fontSize: 11, color: staleTone(deal.staleDays), background: "#fafafa", borderRadius: 7, padding: "4px 8px" }}>
          {deal.staleDays > 45 ? "Stale · " : ""}{stale}
        </div>
      )}
    </button>
  );
}

function PipelineTab({ deals, onOpenDeal, owners, markets, tiers, tierCountMap, onFilteredCountChange }) {
  const [fStatus, setFStatus] = useState([]);
  const [fMarket, setFMarket] = useState([]);
  const [fOwner, setFOwner] = useState([]);
  const [fTier, setFTier] = useState([]);

  const filtered = useMemo(() => deals.filter(d =>
    matchesMulti(fStatus, d.status) && matchesMulti(fMarket, d.market) && matchesMulti(fOwner, d.owner) && matchesMulti(fTier, dealTier(d))
  ), [deals, fStatus, fMarket, fOwner, fTier]);

  useEffect(() => {
    onFilteredCountChange?.(filtered.length);
  }, [filtered.length, onFilteredCountChange]);

  const cols = useMemo(() => {
    const m = Object.fromEntries(STAGES.map(s => [s, []]));
    filtered.forEach(d => { if (m[d.stage]) m[d.stage].push(d); });
    return m;
  }, [filtered]);

  const selStyle = { fontSize: 13, padding: "8px 12px", borderRadius: 9, border: "1px solid #e5e7eb", background: "#fff", color: "#475569", cursor: "pointer" };
  const active = fStatus.length || fMarket.length || fOwner.length || fTier.length;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <MultiFilter label="All Tiers" options={tiers} selected={fTier} onChange={setFTier} counts={tierCountMap} />
        <MultiFilter label="All Status" options={STATUSES} selected={fStatus} onChange={setFStatus} />
        <MultiFilter label="All Markets" options={markets.filter(Boolean)} selected={fMarket} onChange={setFMarket} />
        <MultiFilter label="All Leads" options={owners.filter(Boolean)} selected={fOwner} onChange={setFOwner} />
        {active > 0 && <button onClick={() => { setFStatus([]); setFMarket([]); setFOwner([]); setFTier([]); }} style={{ ...selStyle, color: "#7c3aed", fontWeight: 600 }}>Clear filters</button>}
        <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>{filtered.length} of {deals.length} deals</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(260px, 1fr))`, gap: 16, alignItems: "start" }}>
        {STAGES.map(stage => {
          const onboardedCol = stage === "Onboarded";
          return (
          <div key={stage} style={{ background: onboardedCol ? "#f5f3ff" : "#f8f7fb", border: `1px solid ${onboardedCol ? "#ddd6fe" : "#f0eef6"}`, borderRadius: 14, padding: 12, minHeight: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "2px 4px" }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: STAGE_DOT[stage] }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, color: onboardedCol ? "#6d28d9" : "#0f172a" }}>{stage}</span>
              <span style={{ background: "#fff", color: "#64748b", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 999, border: "1px solid #eef0f4" }}>{cols[stage].length}</span>
              {onboardedCol && <span style={{ fontSize: 10.5, color: "#a78bfa", marginLeft: "auto" }}>Joined Dorsia</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {cols[stage].map(d => <PipelineCard key={d.id} deal={d} onClick={() => onOpenDeal(d)} />)}
              {cols[stage].length === 0 && <div style={{ fontSize: 12, color: "#cbd5e1", textAlign: "center", padding: 20 }}>No deals</div>}
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
// Editable variant: click the value to edit. Supports dropdown options, plain text, or a custom display renderer.
function EditableDetailRow({ label, value, options, onChange, accent, placeholder, render }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  let body;
  if (editing && options) {
    body = (
      <select ref={ref} value={value} onChange={e => { onChange(e.target.value); setEditing(false); }} onBlur={() => setEditing(false)}
        style={{ fontSize: 13.5, padding: "4px 8px", borderRadius: 7, border: "1.5px solid #a78bfa", background: "#fff", cursor: "pointer", maxWidth: 220 }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (editing) {
    body = (
      <input ref={ref} defaultValue={value} placeholder={placeholder}
        onBlur={e => { onChange(e.target.value); setEditing(false); }}
        onKeyDown={e => { if (e.key === "Enter") { onChange(e.target.value); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
        style={{ fontSize: 13.5, padding: "4px 8px", borderRadius: 7, border: "1.5px solid #a78bfa", textAlign: "right", width: 200 }} />
    );
  } else {
    const display = render ? render(value) : (value || <span style={{ color: "#cbd5e1" }}>{placeholder || "—"}</span>);
    body = (
      <span onClick={() => setEditing(true)} title="Click to edit" style={{ cursor: "pointer", borderRadius: 6, padding: "1px 4px", display: "inline-flex", alignItems: "center", gap: 6, color: accent || "#0f172a", fontWeight: 500 }}
        onMouseEnter={e => e.currentTarget.style.background = "#faf5ff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        {display}
        <span style={{ fontSize: 11, color: "#cbd5e1" }}>✎</span>
      </span>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "9px 0", borderBottom: "1px solid #f4f4f7", gap: 16 }}>
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

function DealDetail({ deal, allDeals, onBack, onOpenDeal, onUpdate, owners, groups, markets, tiers }) {
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
  const tasks = deal.tasks || [{ id: "t0", text: `Follow up with ${(deal.owner || "the lead").split(" ")[0]} on next step`, done: false }];
  const meetings = deal.meetings || [];
  const contacts = deal.contacts || [];

  const addTask = (text) => set("tasks", [...tasks, { id: "t" + Date.now(), text, done: false }]);
  const toggleTask = (id) => set("tasks", tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const addMeeting = (m) => set("meetings", [...meetings, { id: "m" + Date.now(), ...m }]);
  const addContact = (c) => set("contacts", [...contacts, { id: "c" + Date.now(), ...c }]);

  const [taskDraft, setTaskDraft] = useState("");
  const [meetingOpen, setMeetingOpen] = useState(false);
  const [meetingDraft, setMeetingDraft] = useState({ name: "", date: "", participants: "" });
  const [contactOpen, setContactOpen] = useState(false);
  const [contactDraft, setContactDraft] = useState({ name: "", email: "", phone: "" });
  const [noteDraft, setNoteDraft] = useState("");
  const [noteWho, setNoteWho] = useState(deal.owner || "");

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
        <button onClick={onBack} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 9, padding: "7px 14px", fontSize: 13, fontWeight: 500, color: "#475569", cursor: "pointer" }}>← Back</button>
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Avatar name={deal.owner} size={20} /><span style={{ fontSize: 13, color: "#475569" }}>{deal.owner}</span></span>
        <span style={{ color: "#e2e8f0" }}>|</span>
        <span style={{ fontSize: 13, color: "#64748b" }}>Last contact: <strong style={{ color: "#0f172a", fontWeight: 600 }}>{deal.lastContactDisplay}</strong></span>
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
            <EditableDetailRow label="Sales Lead" value={deal.owner} options={owners} onChange={v => set("owner", v)}
              render={v => <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Avatar name={v} size={20} />{v}</span>} />
            <EditableDetailRow label="Status" value={deal.status} options={STATUSES} onChange={v => set("status", v)} render={v => <StatusTag status={v} />} />
            <EditableDetailRow label="Blockers" value={deal.blockers} onChange={v => set("blockers", v)} accent={deal.blockers ? "#b91c1c" : null} placeholder="None logged" />
            <EditableDetailRow label="Deal Value" value={deal.dealValue} onChange={v => set("dealValue", v)} placeholder="Add value" render={v => v ? `$${v}` : null} />
            <EditableDetailRow label="Year 1 ARR Potential" value={deal.year1ARR} onChange={v => set("year1ARR", v)} placeholder="Add amount" render={v => v ? `$${v}` : null} />
            <EditableDetailRow label="Billing Frequency" value={deal.billing} options={["", "Monthly", "Quarterly", "Annual"]} onChange={v => set("billing", v)} placeholder="Set frequency" />
            <EditableDetailRow label="Primary Contact" value={deal.contact} onChange={v => set("contact", v)} placeholder="Add contact" />
            <EditableDetailRow label="Website" value={deal.website} onChange={v => set("website", v)} placeholder="Add website" />
            <EditableDetailRow label="Expected Close" value={deal.expectedClose} onChange={v => set("expectedClose", v)} placeholder="Set date" />
            <EditableDetailRow label="Last Contact" value={deal.lastContact} onChange={v => set("lastContact", v)} placeholder="Add date (YYYY-MM-DD)" render={() => deal.lastContactDisplay} />
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
                <button key={v.id} onClick={() => v.id !== deal.id && onOpenDeal(v)} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10,
                  border: v.id === deal.id ? "1.5px solid #c4b5fd" : "1px solid #f1f5f9",
                  background: v.id === deal.id ? "#faf5ff" : "#fff", cursor: v.id === deal.id ? "default" : "pointer", textAlign: "left", width: "100%",
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
                  {[deal.owner, ...owners.filter(o => o && o !== deal.owner)].filter(Boolean).map(o => <option key={o}>{o}</option>)}
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
function EditableCell({ value, options, onChange, render }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  if (editing && options) {
    return (
      <select ref={ref} value={value} onChange={e => { onChange(e.target.value); setEditing(false); }} onBlur={() => setEditing(false)}
        style={{ fontSize: 13, padding: "4px 6px", borderRadius: 7, border: "1.5px solid #a78bfa", background: "#fff", cursor: "pointer" }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
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

function DealsTable({ deals, owners, groups, markets, tiers, tierCountMap, onUpdate, onOpenDeal, onExport, onManageLists, onAddDeal, onImport, onFilteredCountChange }) {
  const [search, setSearch] = useState("");
  const [fStage, setFStage] = useState([]);
  const [fStatus, setFStatus] = useState([]);
  const [fOwner, setFOwner] = useState([]);
  const [fTier, setFTier] = useState([]);
  const [sort, setSort] = useState({ key: "venue", dir: 1 });
  const [draft, setDraft] = useState(null); // null = no draft open

  const REQUIRED = ["tier", "venue"];
  const startDraft = () => setDraft({ tier: "", venue: "", group: "", market: "", stage: "", status: "", owner: "", lastContact: "" });

  const setDraftField = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const missing = draft ? REQUIRED.filter(k => !String(draft[k]).trim()) : [];
  const draftComplete = draft && missing.length === 0;
  const commitDraft = () => { if (draftComplete) { onAddDeal(draft); setDraft(null); } };

  const filtered = useMemo(() => {
    let r = deals.filter(d =>
      (!search || (d.venue + d.group + d.market).toLowerCase().includes(search.toLowerCase())) &&
      matchesMulti(fStage, d.stage) && matchesMulti(fStatus, d.status) && matchesMulti(fOwner, d.owner) && matchesMulti(fTier, dealTier(d)));
    r = [...r].sort((a, b) => {
      const av = a[sort.key] ?? "", bv = b[sort.key] ?? "";
      return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir;
    });
    return r;
  }, [deals, search, fStage, fStatus, fOwner, fTier, sort]);

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
  const filtersActive = fStage.length || fStatus.length || fOwner.length || fTier.length;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search deals…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, fontSize: 13, padding: "9px 14px", borderRadius: 10, border: "1px solid #e5e7eb" }} />
        <MultiFilter label="All Tiers" options={tiers} selected={fTier} onChange={setFTier} counts={tierCountMap} />
        <MultiFilter label="All Stages" options={STAGES} selected={fStage} onChange={setFStage} />
        <MultiFilter label="All Status" options={STATUSES} selected={fStatus} onChange={setFStatus} />
        <MultiFilter label="All Leads" options={owners.filter(Boolean)} selected={fOwner} onChange={setFOwner} />
        {filtersActive > 0 && <button onClick={() => { setFStage([]); setFStatus([]); setFOwner([]); setFTier([]); }} style={{ ...selStyle, color: "#7c3aed", fontWeight: 600 }}>Clear filters</button>}
        <button onClick={onManageLists} style={{ ...selStyle, fontWeight: 600 }}>⚙ Manage lists</button>
        <button onClick={onImport} style={{ ...selStyle, fontWeight: 600 }}>⬆ Import CSV</button>
        <button onClick={startDraft} disabled={!!draft} style={{ ...selStyle, background: draft ? "#ede9fe" : "#6d28d9", color: draft ? "#a78bfa" : "#fff", fontWeight: 600, border: "none", cursor: draft ? "default" : "pointer" }}>+ Add Deal</button>
        <button onClick={() => onExport(filtered)} style={{ ...selStyle, background: "#1e1b4b", color: "#fff", fontWeight: 600, border: "none" }}>⬇ Export CSV</button>
      </div>

      <div style={{ background: "#fff", border: "1px solid #eef0f4", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "1px solid #f1f5f9" }}>
              <Th k="venue">Restaurant</Th><Th k="stage">Stage</Th><Th k="status">Status</Th><Th k="owner">Sales Lead</Th><Th k="staleDays">Last Contact</Th>
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
                  <td colSpan={5} style={{ padding: "0 14px 10px", fontSize: 12, color: "#b45309" }}>
                    Still needed: {missing.map(k => ({ tier: "Tier", venue: "Restaurant name", group: "Group", stage: "Stage", status: "Status", owner: "Sales Lead", lastContact: "Last Contact" }[k])).join(", ")}
                  </td>
                </tr>
              )}
              {filtered.map(d => (
                <tr key={d.id} onClick={() => onOpenDeal(d)} style={{ borderBottom: "1px solid #f6f6f9", cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#fcfaff"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <TierBadge tier={dealTier(d)} />
                      <div>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: "#0f172a", borderBottom: "1px dotted transparent" }}
                          onMouseEnter={e => e.currentTarget.style.borderBottomColor = "#a78bfa"} onMouseLeave={e => e.currentTarget.style.borderBottomColor = "transparent"}>{d.venue}</span>
                        <span style={{ fontSize: 12, color: "#94a3b8" }}> ({d.group})</span>
                      </div>
                    </div>
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
                    <EditableCell value={d.owner} options={owners} onChange={v => onUpdate(d.id, "owner", v)}
                      render={v => <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}><Avatar name={v} size={20} /><span style={{ fontSize: 13, color: "#334155" }}>{v}</span></span>} />
                  </td>
                  <td style={{ padding: "12px 14px" }} onClick={e => e.stopPropagation()}>
                    <EditableCell value={d.lastContact} onChange={v => onUpdate(d.id, "lastContact", v)}
                      render={() => <span style={{ fontSize: 13, color: "#64748b" }}>{d.lastContactDisplay}</span>} />
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
  const count = v => deals.filter(d => d[field] === v).length;

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
        <p style={{ fontSize: 13, color: "#94a3b8", margin: "0 0 22px" }}>Add, rename, or delete options. Renaming updates every deal using that value. Deleting clears it from affected deals.</p>
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

// ============ APP SHELL ============
const TODAY = new Date(2026, 5, 18); // Jun 18 2026
function recompute(d) {
  const tier = normalizeTier(d.tier) || (d.tier || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((d.lastContact || "").trim());
  if (m) {
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    const days = Math.round((TODAY - dt) / 86400000);
    return { ...d, tier, staleDays: days >= 0 ? days : null, lastContactDisplay: dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) };
  }
  return { ...d, tier, staleDays: null, lastContactDisplay: d.lastContact && d.lastContact.trim() ? d.lastContact : "No contact logged" };
}

function buildInsights(allDeals) {
  const deals = allDeals.filter(d => !isOnboarded(d)); // onboarded venues have left the pipeline
  const out = [];
  const aPlusStuck = deals.filter(d => d.tier === "A+" && d.status === "Stuck");
  if (aPlusStuck.length) out.push({ tone: "#ef4444", title: `${aPlusStuck.length} A+ deals are stuck`, body: `Your highest-tier venues are blocked. Leading blockers: ${[...new Set(aPlusStuck.map(d => d.blockers).filter(Boolean))].slice(0, 3).join(", ") || "unspecified"}. These need senior intervention.`, deals: aPlusStuck.slice(0, 5) });
  const moneyBlocked = deals.filter(d => /money/i.test(d.blockers));
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
  const [tab, setTab] = useState("dashboard");
  const [headerDealCount, setHeaderDealCount] = useState(null);
  const [openDeal, setOpenDeal] = useState(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [groups, setGroups] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [owners, setOwners] = useState([]);
  const [priorityMarkets, setPriorityMarkets] = useState([]);

  const syncListsFromDeals = useCallback((dealList) => {
    setGroups([...new Set(dealList.map(d => d.group).filter(Boolean))].sort());
    setMarkets([...new Set(dealList.map(d => d.market).filter(Boolean))].sort());
    setOwners([...new Set(dealList.map(d => d.owner).filter(Boolean))].sort());
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError("");
    try {
      const [rows, settings] = await Promise.all([fetchDeals(), fetchAppSettings()]);
      const computed = rows.map(recompute);
      setDeals(computed);
      syncListsFromDeals(computed);
      setPriorityMarkets(settings.priorityMarkets?.length ? settings.priorityMarkets : ["New York", "London", "LA", "Miami", "Chicago", "Dubai", "SF"]);
    } catch (e) {
      setDbError(e.message || "Failed to load pipeline data.");
    } finally {
      setLoading(false);
    }
  }, [syncListsFromDeals]);

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
  const tierCountMap = useMemo(() => tierCounts(deals), [deals]);

  const persistError = (e) => setDbError(e?.message || "Save failed. Your change may not have been stored.");

  const update = async (id, key, val) => {
    const prev = deals;
    setDeals(ds => ds.map(d => d.id === id ? recompute({ ...d, [key]: val }) : d));
    try {
      const saved = await updateDealField(id, key, val);
      setDeals(ds => ds.map(d => d.id === id ? recompute(saved) : d));
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
      if (group && !groups.includes(group)) setGroups(l => [...l, group].sort());
      if (draft.market && !markets.includes(draft.market)) setMarkets(l => [...l, draft.market].sort());
      if (draft.owner && !owners.includes(draft.owner)) setOwners(l => [...l, draft.owner].sort());
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
    };
    return recompute(id ? { ...base, id } : base);
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
      const allRows = [...toAdd, ...toUpdate.map(u => u.row)];
      const newGroups = [...new Set(allRows.map(r => r.group).filter(Boolean))].filter(g => !groups.includes(g));
      const newMarkets = [...new Set(allRows.map(r => r.market).filter(Boolean))].filter(m => !markets.includes(m));
      const newOwners = [...new Set(allRows.map(r => r.owner).filter(Boolean))].filter(o => !owners.includes(o));
      if (newGroups.length) setGroups(l => [...new Set([...l, ...newGroups])].sort());
      if (newMarkets.length) setMarkets(l => [...new Set([...l, ...newMarkets])].sort());
      if (newOwners.length) setOwners(l => [...new Set([...l, ...newOwners])].sort());
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
      throw e;
    }
  };

  const listSetters = { group: setGroups, market: setMarkets, owner: setOwners };
  const addOption = (field, value) => {
    const v = value.trim(); if (!v) return;
    listSetters[field](list => list.includes(v) ? list : [...list, v].sort());
  };
  const renameOption = async (field, oldV, newV) => {
    const v = newV.trim(); if (!v || v === oldV) return;
    listSetters[field](list => [...new Set(list.map(x => x === oldV ? v : x))].sort());
    const affected = deals.filter(d => d[field] === oldV);
    setDeals(ds => ds.map(d => d[field] === oldV ? recompute({ ...d, [field]: v }) : d));
    if (field === "market") setPriorityMarkets(pm => pm.map(x => x === oldV ? v : x));
    try {
      for (const d of affected) await updateDealField(d.id, field, v);
      setDbError("");
    } catch (e) {
      persistError(e);
      await loadAll();
    }
  };
  const deleteOption = async (field, value) => {
    listSetters[field](list => list.filter(x => x !== value));
    const affected = deals.filter(d => d[field] === value);
    setDeals(ds => ds.map(d => d[field] === value ? recompute({ ...d, [field]: "" }) : d));
    if (field === "market") setPriorityMarkets(pm => pm.filter(x => x !== value));
    try {
      for (const d of affected) await updateDealField(d.id, field, "");
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

  const exportCSV = rows => {
    const blob = new Blob([toCSV(rows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dorsia_bd_pipeline.csv"; a.click();
    URL.revokeObjectURL(url);
  };
  const goDeal = d => { setOpenDeal(d); setTab("detail"); window.scrollTo(0, 0); };
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
    { id: "pipeline", label: "Pipeline" },
    { id: "deals", label: "Deals" },
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
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; }
        html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100%; }
        body { display: block; place-items: initial; background: #f7f7fb; }
        #root { max-width: none; margin: 0; padding: 0; text-align: left; }
      `}</style>

      <div style={{ maxWidth: 1320, margin: "0 auto", padding: "28px 28px 60px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: "#1e1b4b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15 }}>D</div>
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>Dorsia · BD Pipeline</span>
          </div>
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
            {tab === "pipeline" && <PipelineTab deals={deals} onOpenDeal={goDeal} owners={owners} markets={markets} tiers={tiers} tierCountMap={tierCountMap} onFilteredCountChange={reportFilteredCount} />}
            {tab === "deals" && <DealsTable deals={deals} owners={owners} groups={groups} markets={markets} tiers={tiers} tierCountMap={tierCountMap} onUpdate={update} onOpenDeal={goDeal} onExport={exportCSV} onManageLists={() => setManageOpen(true)} onAddDeal={addDeal} onImport={() => setImportOpen(true)} onFilteredCountChange={reportFilteredCount} />}
            {tab === "detail" && liveDeal && <DealDetail deal={liveDeal} allDeals={deals} onBack={() => setTab("pipeline")} onOpenDeal={goDeal} onUpdate={update} owners={owners} groups={groups} markets={markets} tiers={tiers} />}
          </>
        )}
      </div>
      {manageOpen && <ManageListsModal deals={deals} groups={groups} markets={markets} owners={owners} priorityMarkets={priorityMarkets} onTogglePriority={togglePriorityMarket} onAdd={addOption} onRename={renameOption} onDelete={deleteOption} onClose={() => setManageOpen(false)} />}
      {importOpen && <ImportModal deals={deals} onImport={importDeals} onClose={() => setImportOpen(false)} />}
    </div>
  );
}
