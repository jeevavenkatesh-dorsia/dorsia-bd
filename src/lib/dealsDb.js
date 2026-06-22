import { supabase } from "./supabase.js";

const JSON_FIELDS = new Set(["tasks", "meetings", "contacts", "activityNotes"]);

const DB_TO_APP = {
  group_name: "group",
  src_stage: "srcStage",
  last_contact: "lastContact",
  deal_value: "dealValue",
  year1_arr: "year1ARR",
  expected_close: "expectedClose",
  activity_notes: "activityNotes",
};

const APP_TO_DB = Object.fromEntries(
  Object.entries(DB_TO_APP).map(([db, app]) => [app, db])
);

export function rowToDeal(row) {
  const d = { id: row.id };
  for (const [dbKey, value] of Object.entries(row)) {
    if (dbKey === "id" || dbKey === "created_at" || dbKey === "updated_at") continue;
    const appKey = DB_TO_APP[dbKey] || dbKey;
    d[appKey] = value ?? (JSON_FIELDS.has(appKey) ? [] : "");
  }
  return d;
}

export function dealToRow(deal) {
  const row = {};
  for (const [key, value] of Object.entries(deal)) {
    if (["staleDays", "lastContactDisplay", "ownerInitials"].includes(key)) continue;
    const dbKey = APP_TO_DB[key] || key;
    row[dbKey] = value ?? (JSON_FIELDS.has(key) ? [] : "");
  }
  return row;
}

export function patchToRow(key, val) {
  const dbKey = APP_TO_DB[key] || key;
  return { [dbKey]: val ?? (JSON_FIELDS.has(key) ? [] : "") };
}

export async function fetchDeals() {
  const { data, error } = await supabase.from("deals").select("*").order("id", { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToDeal);
}

export async function fetchAppSettings() {
  const { data, error } = await supabase.from("app_settings").select("key, value");
  if (error) throw error;
  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  return {
    priorityMarkets: map.priority_markets || [],
  };
}

export async function savePriorityMarkets(markets) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "priority_markets", value: markets });
  if (error) throw error;
}

export async function insertDeal(deal) {
  const { id, ...rest } = deal;
  const row = dealToRow(rest);
  const { data, error } = await supabase.from("deals").insert(row).select("*").single();
  if (error) throw error;
  return rowToDeal(data);
}

export async function updateDealField(id, key, val) {
  const { data, error } = await supabase
    .from("deals")
    .update(patchToRow(key, val))
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return rowToDeal(data);
}

export async function deleteDealsByIds(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from("deals").delete().in("id", ids);
  if (error) throw error;
}

export async function upsertDeal(deal) {
  const row = dealToRow(deal);
  const { data, error } = await supabase
    .from("deals")
    .upsert(row, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throw error;
  return rowToDeal(data);
}
