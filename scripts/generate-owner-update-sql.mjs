/**
 * Generate SQL: update deal owner from CSV + merge sales_leads (owner field only).
 *   node scripts/generate-owner-update-sql.mjs
 */
import { readFileSync, writeFileSync } from "fs";

const CSV_PATH = new URL("./deals-export-2026-06-22.csv", import.meta.url);
const OUT_PATH = new URL("../supabase/owner-updates-from-csv.sql", import.meta.url);

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

function sqlEscape(s) {
  return (s || "").replace(/'/g, "''");
}

const text = readFileSync(CSV_PATH, "utf8");
const rows = parseCSV(text);
const hdr = rows[0];
const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));

const votes = new Map();
for (const r of rows.slice(1)) {
  const owner = formatOwner(r[idx["Business Partners"]]);
  if (!owner) continue;
  for (const name of [(r[idx["Deal Name"]] || "").trim(), (r[idx.Account] || "").trim()].filter(Boolean)) {
    const k = normalizeName(name);
    if (!k || k.startsWith("<unknown")) continue;
    if (!votes.has(k)) votes.set(k, new Map());
    const m = votes.get(k);
    m.set(owner, (m.get(owner) || 0) + 1);
  }
}

const mapping = new Map();
for (const [k, m] of votes) {
  mapping.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

const pairs = [...mapping.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const allLeads = [...new Set(pairs.flatMap(([, o]) => o.split(/\s+\+\s+/)))].sort();
const valueRows = pairs.map(([norm, owner]) => `  ('${sqlEscape(norm)}', '${sqlEscape(owner)}')`).join(",\n");
const leadUnions = allLeads.map(l => `    select '${sqlEscape(l)}'::text`).join("\n    union\n");

const lines = [
  "-- Sync sales lead (owner) from Attio CSV — owner column ONLY, skips rows with no Business Partners",
  `-- ${pairs.length} restaurant name mappings`,
  "",
  "begin;",
  "",
  "update public.deals as d",
  "set owner = m.owner, updated_at = now()",
  "from (values",
  valueRows,
  ") as m(venue_norm, owner)",
  "where lower(trim(regexp_replace(d.venue, '\\s+', ' ', 'g'))) = m.venue_norm;",
  "",
  "update public.app_settings",
  "set value = (",
  "  select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb)",
  "  from (",
  "    select jsonb_array_elements_text(value) as x from public.app_settings where key = 'sales_leads'",
  "    union",
  leadUnions,
  "  ) s",
  "), updated_at = now()",
  "where key = 'sales_leads';",
  "",
  "commit;",
  "",
];

writeFileSync(OUT_PATH, lines.join("\n"), "utf8");
console.log(`Wrote supabase/owner-updates-from-csv.sql (${pairs.length} mappings, ${allLeads.length} sales lead names)`);
