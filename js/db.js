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

// [{ email, display_name, all_time, this_month }], one row per household member.
export async function fetchLeaderboard() {
  return unwrap(await sb.from("points_leaderboard").select("*"));
}

// ---------- monthly budgets (see budgets-migration.sql) ----------

// [{ category_id, amount_egp }] for one month; month is its 1st day, e.g. "2026-10-01".
export async function fetchBudget(month) {
  return unwrap(await sb.from("budgets").select("category_id, amount_egp").eq("month", month));
}

// Replaces a month's whole budget at once. items: [{ category_id, amount_egp }]; [] clears it.
export async function saveBudget(month, items) {
  unwrap(await sb.rpc("set_month_budget", { p_month: month, p_items: items }));
}

// Just what budgets need from expenses dated first <= day < end:
// [{ category_id, occurred_on, amount_egp, amount_usd }].
export async function fetchExpensesBetween(first, end) {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const page = unwrap(await sb.from("transactions").select("category_id, occurred_on, amount_egp, amount_usd")
      .eq("type", "expense").gte("occurred_on", first).lt("occurred_on", end).order("id").range(from, from + size - 1));
    all.push(...page);
    if (page.length < size) return all;
  }
}

// The date of the earliest entry ("2026-07-01"), or null when there are none yet.
export async function firstEntryDate() {
  const row = unwrap(await sb.from("transactions").select("occurred_on").order("occurred_on").limit(1).maybeSingle());
  return row?.occurred_on ?? null;
}

export async function insertListItem(table, row) {
  return unwrap(await sb.from(table).insert(row).select().single());
}

export async function updateListItem(table, id, patch) {
  unwrap(await sb.from(table).update(patch).eq("id", id));
}
