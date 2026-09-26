// Everything that talks to Supabase. Access rules live in the database (see supabase-setup.sql).

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { state } from "./state.js";

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export async function reloadLists() {
  const results = await Promise.all([
    sb.from("members").select("email, display_name").order("display_name"),
    sb.from("categories").select("*").order("sort_order").order("name"),
    sb.from("subcategories").select("*").order("sort_order").order("name"),
    sb.from("payment_methods").select("*").order("sort_order").order("name"),
    sb.from("income_sources").select("*").order("sort_order").order("name"),
  ]);
  const [members, categories, subcategories, paymentMethods, incomeSources] = results.map(unwrap);
  Object.assign(state, { members, categories, subcategories, paymentMethods, incomeSources });
}

const newestFirst = (q) => q.order("occurred_on", { ascending: false }).order("created_at", { ascending: false });

// Supabase returns at most 1000 rows per request, so page through.
export async function fetchAllTransactions() {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const page = unwrap(await newestFirst(sb.from("transactions").select("*")).range(from, from + size - 1));
    all.push(...page);
    if (page.length < size) return all;
  }
}

export async function fetchTransactionsPage(offset, limit, type) {
  let q = newestFirst(sb.from("transactions").select("*")).range(offset, offset + limit - 1);
  if (type !== "all") q = q.eq("type", type);
  return unwrap(await q);
}

export async function fetchTransaction(id) {
  return unwrap(await sb.from("transactions").select("*").eq("id", id).maybeSingle());
}

export async function insertTransaction(row) {
  return unwrap(await sb.from("transactions").insert(row).select().single());
}

export async function updateTransaction(id, patch) {
  return unwrap(await sb.from("transactions").update(patch).eq("id", id).select().single());
}

export async function deleteTransaction(id) {
  unwrap(await sb.from("transactions").delete().eq("id", id));
}

export async function latestEntryRate() {
  return unwrap(
    await sb.from("transactions").select("rate, occurred_on").order("created_at", { ascending: false }).limit(1).maybeSingle()
  );
}

export async function insertListItem(table, row) {
  return unwrap(await sb.from(table).insert(row).select().single());
}

export async function updateListItem(table, id, patch) {
  unwrap(await sb.from(table).update(patch).eq("id", id));
}
