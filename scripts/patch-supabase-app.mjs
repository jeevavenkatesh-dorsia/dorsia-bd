import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx");
let s = readFileSync(appPath, "utf8");

s = s.replace(
  /^import React[^\n]+\n\n\/\/ ============ DATA[\s\S]*?\n\n\/\/ ============ CONSTANTS/m,
  `import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { supabase, supabaseConfigured } from "./lib/supabase.js";
import LoginScreen from "./components/LoginScreen.jsx";
import {
  fetchDeals,
  fetchAppSettings,
  savePriorityMarkets,
  insertDeal,
  updateDealField,
  deleteDealsByIds,
  upsertDeal,
} from "./lib/dealsDb.js";

// Pipeline data lives in Supabase. Initial seed: scripts/deals-seed.json + scripts/seed-deals.mjs

// ============ CONSTANTS`
);

const appStart = s.indexOf("export default function App()");
const appEnd = s.lastIndexOf("\n}");
if (appStart < 0) throw new Error("App() not found");

const newApp = `export default function App() {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState("");

  const [deals, setDeals] = useState([]);
  const [tab, setTab] = useState("dashboard");
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

  const insights = useMemo(() => buildInsights(deals), [deals]);
  const tasks = useMemo(() => buildTasks(deals), [deals]);

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
      venue: (row.venue || "").trim(), group: row.group || "No Group", tier: row.tier || "",
      market: row.market || "", stage, srcStage: row.srcStage || rawStage || stage, status,
      owner: row.owner || "", lastContact: (row.lastContact || "").trim(), blockers: row.blockers || "",
      notes: row.notes || "", dealValue: row.dealValue || "", year1ARR: row.year1ARR || "", billing: row.billing || "",
      contact: row.contact || "", website: row.website || "", expectedClose: row.expectedClose || "",
      tasks: [], meetings: [], contacts: [], activityNotes: [],
    };
    return recompute(id ? { ...base, id } : base);
  };

  const importDeals = async ({ toAdd, toUpdate, toDeleteIds }) => {
    try {
      await deleteDealsByIds(toDeleteIds);
      for (const u of toUpdate) {
        const existing = deals.find(d => d.id === u.id);
        const rec = buildDealFromRow({ ...existing, ...u.row }, u.id);
        await upsertDeal(rec);
      }
      for (const r of toAdd) {
        const rec = buildDealFromRow(r, null);
        delete rec.id;
        await insertDeal(rec);
      }
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
  const titles = {
    dashboard: ["Dashboard", "Pipeline overview and key metrics"],
    pipeline: ["Pipeline", \`\${deals.length} deals across 4 stages\`],
    deals: ["Deals", \`\${deals.length} deals\`],
    detail: ["", ""],
  };

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7fb", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: "#0f172a" }}>
      <style>{\`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        button { font-family: inherit; }
        html, body, #root { margin: 0; padding: 0; width: 100%; min-height: 100%; }
        body { display: block; place-items: initial; background: #f7f7fb; }
        #root { max-width: none; margin: 0; padding: 0; text-align: left; }
      \`}</style>

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
            {tab === "pipeline" && <PipelineTab deals={deals} onOpenDeal={goDeal} owners={owners} markets={markets} />}
            {tab === "deals" && <DealsTable deals={deals} owners={owners} groups={groups} markets={markets} onUpdate={update} onOpenDeal={goDeal} onExport={exportCSV} onManageLists={() => setManageOpen(true)} onAddDeal={addDeal} onImport={() => setImportOpen(true)} />}
            {tab === "detail" && liveDeal && <DealDetail deal={liveDeal} allDeals={deals} onBack={() => setTab("pipeline")} onOpenDeal={goDeal} onUpdate={update} owners={owners} groups={groups} markets={markets} />}
          </>
        )}
      </div>
      {manageOpen && <ManageListsModal deals={deals} groups={groups} markets={markets} owners={owners} priorityMarkets={priorityMarkets} onTogglePriority={togglePriorityMarket} onAdd={addOption} onRename={renameOption} onDelete={deleteOption} onClose={() => setManageOpen(false)} />}
      {importOpen && <ImportModal deals={deals} onImport={importDeals} onClose={() => setImportOpen(false)} />}
    </div>
  );
}`;

s = s.slice(0, appStart) + newApp + "\n";
writeFileSync(appPath, s);
console.log("Patched", appPath);
