/**
 * Sync sales lead (owner) from Attio CSV export — owner field ONLY.
 *
 * Uses the "Business Partners" column (Dorsia assignee). Rows with no value are skipped.
 * Matches pipeline deals by restaurant name (venue ↔ Deal Name or Account).
 *
 * Usage:
 *   node scripts/update-owners-from-csv.mjs --preview          # local preview vs deals-seed.json
 *   node scripts/update-owners-from-csv.mjs --dry-run          # preview vs live Supabase
 *   node scripts/update-owners-from-csv.mjs --apply            # write owner + merge sales_leads
 *
 * Env: SUPABASE_URL (or VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 * Optional: CSV_PATH=path/to/export.csv
 */
import { readFileSync, existsSync } from "fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile() {
  const path = new URL("../.env", import.meta.url);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile();

const PREVIEW = process.argv.includes("--preview");
const DRY_RUN = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");

const defaultCsv = new URL("./deals-export-2026-06-22.csv", import.meta.url);
const CSV_PATH = process.env.CSV_PATH
  ? new URL(process.env.CSV_PATH, import.meta.url)
  : defaultCsv;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!PREVIEW && !DRY_RUN && !APPLY) {
  console.log("Pass --preview (local), --dry-run (live), or --apply (write).");
  process.exit(1);
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(x => x !== "")) rows.push(row);
      row = []; field = ""; i++; continue;
    }
    field += c; i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeName(s) {
  return (s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[''`´]/g, "'")
    .replace(/\s+/g, " ");
}

function formatOwner(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  const parts = s.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
  return [...new Set(parts)].sort().join(" + ");
}

function keysForName(name) {
  const n = (name || "").trim();
  if (!n || n.startsWith("<UNKNOWN")) return [];
  return [normalizeName(n)];
}

/** norm key -> Map(ownerString -> rowCount) */
function buildOwnerLookup(rows, idx) {
  const votes = new Map();
  for (const r of rows) {
    const owner = formatOwner(r[idx["Business Partners"]]);
    if (!owner) continue;
    for (const name of [(r[idx["Deal Name"]] || "").trim(), (r[idx.Account] || "").trim()].filter(Boolean)) {
      for (const k of keysForName(name)) {
        if (!votes.has(k)) votes.set(k, new Map());
        const m = votes.get(k);
        m.set(owner, (m.get(owner) || 0) + 1);
      }
    }
  }
  const lookup = new Map();
  for (const [k, m] of votes) {
    const winner = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    lookup.set(k, winner);
  }
  return lookup;
}

function lookupOwner(venue, lookup) {
  for (const k of keysForName(venue)) {
    const hit = lookup.get(k);
    if (hit) return hit;
  }
  return "";
}

function collectLeadNames(lookup) {
  const names = new Set();
  for (const owner of lookup.values()) {
    for (const part of owner.split(/\s+\+\s+/)) names.add(part);
  }
  return [...names].sort();
}

const text = readFileSync(CSV_PATH, "utf8");
const rows = parseCSV(text);
const hdr = rows[0];
if (!hdr.includes("Business Partners")) {
  console.error('CSV must include a "Business Partners" column (Attio sales assignee).');
  process.exit(1);
}
const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));
const lookup = buildOwnerLookup(rows.slice(1), idx);
const csvLeadNames = collectLeadNames(lookup);

console.log(`CSV: ${rows.length - 1} rows, ${lookup.size} restaurant names with a sales lead`);
console.log(`Unique sales lead names in CSV: ${csvLeadNames.length}`);

function planUpdates(deals) {
  const updates = [];
  const unchanged = [];
  const noMatch = [];
  for (const deal of deals) {
    const newOwner = lookupOwner(deal.venue, lookup);
    if (!newOwner) {
      noMatch.push(deal);
      continue;
    }
    const current = (deal.owner || "").trim();
    if (current === newOwner) unchanged.push(deal);
    else updates.push({ id: deal.id, venue: deal.venue, from: current || "(empty)", to: newOwner });
  }
  return { updates, unchanged, noMatch };
}

function printPlan({ updates, unchanged, noMatch }, total) {
  console.log(`\nDeals in DB: ${total}`);
  console.log(`Will update owner: ${updates.length}`);
  console.log(`Already correct: ${unchanged.length}`);
  console.log(`No CSV match / empty in CSV: ${noMatch.length}`);
  if (updates.length) {
    console.log("\nSample changes (owner field only):");
    updates.slice(0, 25).forEach(u => console.log(`  ${u.venue}: "${u.from}" → "${u.to}"`));
    if (updates.length > 25) console.log(`  … and ${updates.length - 25} more`);
  }
}

if (PREVIEW) {
  const seed = JSON.parse(readFileSync(new URL("./deals-seed.json", import.meta.url), "utf8"));
  const deals = seed.map((d, i) => ({ id: d.id ?? i + 1, venue: d.venue, owner: d.owner }));
  printPlan(planUpdates(deals), deals.length);
  console.log("\nPreview uses deals-seed.json — run --dry-run against live Supabase to confirm.");
  process.exit(0);
}

if (!url || !key) {
  console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for --dry-run / --apply.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const allDeals = [];
const pageSize = 1000;
let from = 0;
while (true) {
  const { data, error } = await supabase.from("deals").select("id, venue, owner").order("id").range(from, from + pageSize - 1);
  if (error) throw error;
  const batch = data || [];
  allDeals.push(...batch);
  if (batch.length < pageSize) break;
  from += pageSize;
}

const plan = planUpdates(allDeals);
printPlan(plan, allDeals.length);

if (APPLY) {
  const { updates } = plan;
  if (!updates.length) {
    console.log("\nNothing to update.");
  } else {
    const batchSize = 25;
    for (let i = 0; i < updates.length; i += batchSize) {
      const chunk = updates.slice(i, i + batchSize);
      await Promise.all(chunk.map(u =>
        supabase.from("deals").update({ owner: u.to }).eq("id", u.id).then(({ error }) => {
          if (error) throw error;
        })
      ));
    }
    console.log(`\nUpdated owner on ${updates.length} deals.`);
  }

  const { data: settingsRow } = await supabase.from("app_settings").select("value").eq("key", "sales_leads").maybeSingle();
  const existing = settingsRow?.value || [];
  const merged = [...new Set([...existing, ...csvLeadNames])].sort();
  const { error: settingsErr } = await supabase.from("app_settings").upsert({ key: "sales_leads", value: merged });
  if (settingsErr) throw settingsErr;
  console.log(`Sales leads list: ${merged.length} names (${merged.length - existing.length} newly added).`);
} else {
  console.log("\nDry run — pass --apply to write (owner field only + merge sales_leads).");
}
