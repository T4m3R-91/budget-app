// Everything that talks to Supabase. Access rules live in the database (see supabase-setup.sql).
// Reads go through cached(): each result is kept on the phone and used when offline (offline.js).
// Writes need a connection, except new entries, which wait in the outbox (outbox.js).

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "../config.js";
import { state } from "./state.js";
import { cached } from "./offline.js";

export const configured = Boolean(SUPABASE_URL && SUPABASE_KEY);
export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Supabase returns at most 1000 rows per request, so page through.
async function allPages(query) {
  const size = 1000;
  const all = [];
  for (let from = 0; ; from += size) {
    const page = unwrap(await query().range(from, from + size - 1));
    all.push(...page);
    if (page.length < size) return all;
  }
}

// A table that doesn't exist yet: its migration hasn't been run.
const isMissingTable = (e) => ["42P01", "PGRST205"].includes(e?.code);

export async function reloadLists() {
  const lists = await cached("lists", async () => {
    const [receiving, ...results] = await Promise.all([
      sb.from("receiving_methods").select("*").order("sort_order").order("name"),
      sb.from("members").select("email, display_name").order("display_name"),
      sb.from("categories").select("*").order("sort_order").order("name"),
      sb.from("subcategories").select("*").order("sort_order").order("name"),
      sb.from("payment_methods").select("*").order("sort_order").order("name"),
      sb.from("income_sources").select("*").order("sort_order").order("name"),
    ]);
    const [members, categories, subcategories, paymentMethods, incomeSources] = results.map(unwrap);
    // null until receiving-methods-migration.sql has run: income then has no "In" tile.
    const receivingMethods = isMissingTable(receiving.error) ? null : unwrap(receiving);
    return { members, categories, subcategories, paymentMethods, incomeSources, receivingMethods };
  });
  Object.assign(state, lists);
}

const newestFirst = (q) => q.order("occurred_on", { ascending: false }).order("created_at", { ascending: false });

export function fetchAllTransactions() {
  return cached("transactions", () => allPages(() => newestFirst(sb.from("transactions").select("*"))));
}

export async function fetchTransaction(id) {
  return unwrap(await sb.from("transactions").select("*").eq("id", id).maybeSingle());
}

// A rate taken on the entry's own day is saved as "historical". Until historical-rates-migration.sql
// has run, the database refuses that; the entry is then saved as "live" (same rate, older label).
const historicalRefused = (row, e) => row.rate_source === "historical" && e?.code === "23514" && /rate_source/.test(e.message || "");

// row may carry its own id (new entries do), so a retry after a lost reply can't save it twice.
export async function insertTransaction(row) {
  try {
    return unwrap(await sb.from("transactions").insert(row).select().single());
  } catch (e) {
    if (historicalRefused(row, e)) return insertTransaction({ ...row, rate_source: "live" });
    throw e;
  }
}

export async function updateTransaction(id, patch) {
  try {
    return unwrap(await sb.from("transactions").update(patch).eq("id", id).select().single());
  } catch (e) {
    if (historicalRefused(patch, e)) return updateTransaction(id, { ...patch, rate_source: "live" });
    throw e;
  }
}

export async function deleteTransaction(id) {
  unwrap(await sb.from("transactions").delete().eq("id", id));
}

export function latestEntryRate() {
  return cached("latest-rate", async () => unwrap(
    await sb.from("transactions").select("rate, occurred_on").order("created_at", { ascending: false }).limit(1).maybeSingle()
  ));
}

// [{ email, display_name, all_time, this_month }], one row per household member.
export function fetchLeaderboard() {
  return cached("leaderboard", async () => unwrap(await sb.from("points_leaderboard").select("*")));
}

// ---------- monthly budgets (see budgets-migration.sql) ----------

// [{ category_id, amount_egp }] for one month; month is its 1st day, e.g. "2026-10-01".
export function fetchBudget(month) {
  return cached(`budget:${month}`, async () => unwrap(await sb.from("budgets").select("category_id, amount_egp").eq("month", month)));
}

// Replaces a month's whole budget at once. items: [{ category_id, amount_egp }]; [] clears it.
export async function saveBudget(month, items) {
  unwrap(await sb.rpc("set_month_budget", { p_month: month, p_items: items }));
}

// Just what budgets need from expenses dated first <= day < end:
// [{ category_id, occurred_on, amount_egp, amount_usd }].
export function fetchExpensesBetween(first, end) {
  return cached(`expenses:${first}:${end}`, () => allPages(() => sb.from("transactions")
    .select("category_id, occurred_on, amount_egp, amount_usd")
    .eq("type", "expense").gte("occurred_on", first).lt("occurred_on", end).order("id")));
}

// The date of the earliest entry ("2026-07-01"), or null when there are none yet.
export function firstEntryDate() {
  return cached("first-entry", async () => {
    const row = unwrap(await sb.from("transactions").select("occurred_on").order("occurred_on").limit(1).maybeSingle());
    return row?.occurred_on ?? null;
  });
}

// ---------- recurring items (see recurring-migration.sql) ----------

// { items, skips: [{ item_id, due_on }], links: [{ id, recurring_id, recurring_due_on, occurred_on, amount, currency }] }:
// the recurring items, the occurrences skipped, and the entries logged from them.
export function fetchRecurring() {
  return cached("recurring", async () => {
    const [items, skips, links] = await Promise.all([
      sb.from("recurring_items").select("*").order("created_at"),
      sb.from("recurring_skips").select("item_id, due_on"),
      allPages(() => sb.from("transactions").select("id, recurring_id, recurring_due_on, occurred_on, amount, currency").not("recurring_id", "is", null).order("id")),
    ]);
    return { items: unwrap(items), skips: unwrap(skips), links };
  });
}

export async function insertRecurring(row) {
  return unwrap(await sb.from("recurring_items").insert(row).select().single());
}

export async function updateRecurring(id, patch) {
  unwrap(await sb.from("recurring_items").update(patch).eq("id", id));
}

export async function deleteRecurring(id) {
  unwrap(await sb.from("recurring_items").delete().eq("id", id));
}

export async function skipOccurrence(itemId, dueOn) {
  unwrap(await sb.from("recurring_skips").insert({ item_id: itemId, due_on: dueOn }));
}

export async function unskipOccurrence(itemId, dueOn) {
  unwrap(await sb.from("recurring_skips").delete().eq("item_id", itemId).eq("due_on", dueOn));
}

// Marks an entry as a recurring item's occurrence (used for the entry that set the item up).
export async function linkToRecurring(transactionId, itemId, dueOn) {
  unwrap(await sb.from("transactions").update({ recurring_id: itemId, recurring_due_on: dueOn }).eq("id", transactionId));
}

// Entries typed by hand (not logged from an item) dated first <= day < end, for matching them to
// due items: [{ id, type, category_id, income_source_id, currency, amount, occurred_on }].
export function fetchUnlinkedBetween(first, end) {
  return cached(`unlinked:${first}:${end}`, () => allPages(() => sb.from("transactions")
    .select("id, type, category_id, income_source_id, currency, amount, occurred_on")
    .is("recurring_id", null).gte("occurred_on", first).lt("occurred_on", end).order("id")));
}

// ---------- the household's lists ----------

export async function insertListItem(table, row) {
  return unwrap(await sb.from(table).insert(row).select().single());
}

export async function updateListItem(table, id, patch) {
  unwrap(await sb.from(table).update(patch).eq("id", id));
}
