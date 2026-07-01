/**
 * Audit duplicate deals in Supabase (venue + market = one deal).
 *
 * Usage:
 *   $env:SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
 *   node scripts/audit-duplicate-deals.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

function keyOf(row) {
  return `${(row.venue || "").trim().toLowerCase()}|${(row.market || "").trim().toLowerCase()}`;
}

const pageSize = 1000;
const all = [];
let from = 0;
while (true) {
  const { data, error } = await supabase
    .from("deals")
    .select("id, venue, market, stage, updated_at")
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  all.push(...(data || []));
  if (!data || data.length < pageSize) break;
  from += pageSize;
}

const groups = new Map();
for (const row of all) {
  const k = keyOf(row);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(row);
}

const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
dupes.sort((a, b) => b[1].length - a[1].length);

console.log(`Total deals: ${all.length}`);
console.log(`Duplicate groups (venue + market): ${dupes.length}`);
console.log(`Extra rows to remove: ${dupes.reduce((n, [, rows]) => n + rows.length - 1, 0)}`);

if (!dupes.length) {
  console.log("No duplicates found.");
  process.exit(0);
}

console.log("\nTop duplicate groups:");
for (const [, rows] of dupes.slice(0, 25)) {
  const sorted = [...rows].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at) || b.id - a.id);
  const keep = sorted[0];
  const remove = sorted.slice(1).map(r => r.id);
  console.log(`  ${keep.venue} · ${keep.market || "(no market)"} — keep id ${keep.id}, remove ids [${remove.join(", ")}]`);
}

if (dupes.length > 25) console.log(`  … and ${dupes.length - 25} more groups`);
