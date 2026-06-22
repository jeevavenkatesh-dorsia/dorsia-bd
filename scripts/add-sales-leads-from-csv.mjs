/**
 * Add Business Partners from Attio CSV export as sales leads in app_settings.
 *
 *   node scripts/add-sales-leads-from-csv.mjs --dry-run
 *   node scripts/add-sales-leads-from-csv.mjs --apply
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

const CSV_PATH = new URL("./deals-export-2026-06-22.csv", import.meta.url);
const DRY_RUN = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const EXISTING_LEADS = [
  "Anouschka Rao",
  "Courtney Adams",
  "Josh Mendel",
  "Marc Lotenburg",
  "Steffi Klein",
];

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

const text = readFileSync(CSV_PATH, "utf8");
const rows = parseCSV(text);
const hdr = rows[0];
const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));

const fromCsv = new Set();
for (const r of rows.slice(1)) {
  const raw = (r[idx["Business Partners"]] || "").trim();
  if (!raw) continue;
  for (const part of raw.split(/\s*,\s*/)) {
    const name = part.trim();
    if (name) fromCsv.add(name);
  }
}

const newNames = [...fromCsv].sort();
const mergedPreview = [...new Set([...EXISTING_LEADS, ...newNames])].sort();
const added = newNames.filter(n => !EXISTING_LEADS.includes(n));

console.log(`CSV Business Partners: ${newNames.length} unique names`);
console.log(`New names to add: ${added.length}`);
added.forEach(n => console.log(`  + ${n}`));
console.log(`\nTotal sales leads after merge: ${mergedPreview.length}`);

if (!DRY_RUN && !APPLY) {
  console.log("\nPass --dry-run or --apply");
  process.exit(1);
}

if (!url || !key) {
  console.error("\nSet SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to apply.");
  if (DRY_RUN) process.exit(0);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data: row, error: readErr } = await supabase
  .from("app_settings")
  .select("value")
  .eq("key", "sales_leads")
  .maybeSingle();
if (readErr) throw readErr;

const existing = row?.value?.length ? row.value : EXISTING_LEADS;
const merged = [...new Set([...existing, ...newNames])].sort();

if (APPLY) {
  const { error } = await supabase.from("app_settings").upsert({ key: "sales_leads", value: merged });
  if (error) throw error;
  console.log(`\nSaved ${merged.length} sales leads to app_settings (${merged.length - existing.length} added).`);
} else {
  console.log("\nDry run — pass --apply to write to Supabase.");
}
