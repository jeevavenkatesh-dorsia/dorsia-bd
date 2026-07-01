import { supabase } from "./supabase.js";
import { normalizeTier } from "./tiers.js";

const JSON_FIELDS = new Set(["tasks", "meetings", "contacts", "activityNotes"]);

const DB_TO_APP = {
  group_name: "group",
  src_stage: "srcStage",
  last_contact: "lastContact",
  deal_value: "dealValue",
  year1_arr: "year1ARR",
  expected_close: "expectedClose",
  activity_notes: "activityNotes",
  go_live_date: "goLiveDate",
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
  d.tier = normalizeTier(d.tier) || (d.tier || "").trim();
  return d;
}

export function dealToRow(deal) {
  const row = {};
  for (const [key, value] of Object.entries(deal)) {
    if (["staleDays", "lastContactDisplay", "ownerInitials", "goLiveDateDisplay"].includes(key)) continue;
    const dbKey = APP_TO_DB[key] || key;
    let val = value ?? (JSON_FIELDS.has(key) ? [] : "");
    if (key === "tier") val = normalizeTier(val) || (val || "").trim();
    row[dbKey] = val;
  }
  return row;
}

export function patchToRow(key, val) {
  const dbKey = APP_TO_DB[key] || key;
  let v = val ?? (JSON_FIELDS.has(key) ? [] : "");
  if (key === "tier") v = normalizeTier(v) || (v || "").trim();
  return { [dbKey]: v };
}

export async function fetchAccessStatus() {
  const { data, error } = await supabase.rpc("get_access_status");
  if (error) throw error;
  return data;
}

export async function fetchDeals() {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("deals")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    all.push(...batch.map(rowToDeal));
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const MANAGED_LIST_KEYS = {
  group: "restaurant_groups",
  market: "market_list",
  owner: "sales_leads",
};

export async function fetchAppSettings() {
  const { data, error } = await supabase.from("app_settings").select("key, value");
  if (error) throw error;
  const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
  return {
    priorityMarkets: map.priority_markets || [],
    managedLists: {
      group: map.restaurant_groups || [],
      market: map.market_list || [],
      owner: map.sales_leads || [],
    },
  };
}

export async function savePriorityMarkets(markets) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "priority_markets", value: markets });
  if (error) throw error;
}

export async function saveManagedList(field, values) {
  const key = MANAGED_LIST_KEYS[field];
  if (!key) throw new Error(`Unknown managed list: ${field}`);
  const { error } = await supabase.from("app_settings").upsert({ key, value: values });
  if (error) throw error;
}

export async function insertDeal(deal) {
  const { id, ...rest } = deal;
  const row = dealToRow(rest);
  const { data, error } = await supabase.from("deals").insert(row).select("*").single();
  if (error) throw error;
  return rowToDeal(data);
}

export async function insertDeals(dealList) {
  if (!dealList.length) return;
  const rows = dealList.map(d => {
    const { id, ...rest } = d;
    return dealToRow(rest);
  });
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabase.from("deals").insert(rows.slice(i, i + batchSize));
    if (error) throw error;
  }
}

export async function upsertDeals(dealList) {
  if (!dealList.length) return;
  const rows = dealList.map(dealToRow);
  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabase.from("deals").upsert(rows.slice(i, i + batchSize), { onConflict: "id" });
    if (error) throw error;
  }
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

export async function updateDealFieldByGroup(group, key, val) {
  const { data, error } = await supabase
    .from("deals")
    .update(patchToRow(key, val))
    .eq("group_name", group)
    .select("*");
  if (error) throw error;
  return (data || []).map(rowToDeal);
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
