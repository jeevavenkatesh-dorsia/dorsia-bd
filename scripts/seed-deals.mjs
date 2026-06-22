/**
 * One-time seed: loads scripts/deals-seed.json into Supabase.
 *
 * Usage (from project root):
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/seed-deals.mjs
 *
 * Uses the service role key — never commit it or expose it in the browser.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const APP_TO_DB = {
  group: "group_name",
  srcStage: "src_stage",
  lastContact: "last_contact",
  dealValue: "deal_value",
  year1ARR: "year1_arr",
  expectedClose: "expected_close",
  activityNotes: "activity_notes",
};

function dealToRow(deal) {
  const row = {};
  for (const [key, value] of Object.entries(deal)) {
    if (key === "id" || ["staleDays", "lastContactDisplay", "ownerInitials"].includes(key)) continue;
    const dbKey = APP_TO_DB[key] || key;
    row[dbKey] = value ?? "";
  }
  if (row.tasks === "") row.tasks = [];
  if (row.meetings === "") row.meetings = [];
  if (row.contacts === "") row.contacts = [];
  if (row.activity_notes === "") row.activity_notes = [];
  return row;
}

const deals = JSON.parse(readFileSync(new URL("./deals-seed.json", import.meta.url), "utf8"));
const rows = deals.map(dealToRow);

const { count } = await supabase.from("deals").select("*", { count: "exact", head: true });
if (count > 0) {
  console.log(`deals table already has ${count} rows — skipping seed (delete rows first to re-seed).`);
  process.exit(0);
}

const batchSize = 50;
for (let i = 0; i < rows.length; i += batchSize) {
  const chunk = rows.slice(i, i + batchSize);
  const { error } = await supabase.from("deals").insert(chunk);
  if (error) {
    console.error("Insert failed:", error.message);
    process.exit(1);
  }
  console.log(`Inserted ${Math.min(i + batchSize, rows.length)} / ${rows.length}`);
}

console.log("Seed complete.");

// Identity sequence does not advance when rows insert explicit ids — fix for future inserts.
const { error: seqErr } = await supabase.rpc("reset_deals_id_sequence");
if (seqErr) {
  console.warn("Could not reset id sequence automatically. Run supabase/fix-deals-id-sequence.sql in SQL Editor.");
}
