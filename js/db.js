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
      sb.from("members").select("*").order("display_name"), // with role and status, once household-migration.sql has run
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

// When the nightly backup last ran (backups-migration.sql; backup-repo/ is the job):
// { last_backup_at, table_count, row_count, changed }, null before its first run, "missing"
// until the migration has run.
export function fetchBackupStatus() {
  return cached("backup-status", async () => {
    const { data, error } = await sb.from("backup_status").select("last_backup_at, table_count, row_count, changed").maybeSingle();
    if (isMissingTable(error)) return "missing";
    return unwrap({ data, error });
  });
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

// A payment scheduled once is frequency "once". Until scheduled-migration.sql has run, the database
// refuses that; it's then saved as a yearly item that ends on its date: the same single payment.
const onceRefused = (row, e) => row.frequency === "once" && e?.code === "23514" && /frequency|check/.test(e.message || "");
const asYearlyOnce = (row) => ({ ...row, frequency: "yearly", month: Number(row.starts_on.slice(5, 7)), ended_on: row.starts_on });

export async function insertRecurring(row) {
  try {
    return unwrap(await sb.from("recurring_items").insert(row).select().single());
  } catch (e) {
    if (onceRefused(row, e)) return insertRecurring(asYearlyOnce(row));
    throw e;
  }
}

export async function updateRecurring(id, patch) {
  try {
    unwrap(await sb.from("recurring_items").update(patch).eq("id", id));
  } catch (e) {
    if (onceRefused(patch, e) && patch.starts_on) return updateRecurring(id, asYearlyOnce(patch));
    throw e;
  }
}

export async function deleteRecurring(id) {
  unwrap(await sb.from("recurring_items").delete().eq("id", id));
}

// Changes a scheduled payment from a date on: it continues as a new one with these changes (the
// rest carried over) and the old one ends on endOld, in one step, so the activity log shows one
// change. Returns the new one's id, or null before activity-log-migration.sql has run.
export async function continueRecurring(id, endOld, changes) {
  const { data, error } = await sb.rpc("continue_scheduled", { p_id: id, p_end: endOld, p_changes: changes });
  if (error?.code === "PGRST202") return null;
  if (error) throw error;
  return data;
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

// ---------- favorites (see favorites-migration.sql) ----------

// Your own favorites, most used first (the database only returns your own). null until
// favorites-migration.sql has run, so the Add tab then shows no favorites row.
export function fetchFavorites() {
  return cached(`favorites:${state.me?.email}`, async () => {
    const { data, error } = await sb.from("favorites").select("*").order("uses", { ascending: false }).order("created_at", { ascending: false });
    if (isMissingTable(error)) return null;
    return unwrap({ data, error });
  });
}

export async function insertFavorite(row) {
  return unwrap(await sb.from("favorites").insert(row).select().single());
}

export async function updateFavorite(id, patch) {
  unwrap(await sb.from("favorites").update(patch).eq("id", id));
}

export async function deleteFavorite(id) {
  unwrap(await sb.from("favorites").delete().eq("id", id));
}

// One more entry saved from it.
export async function useFavorite(id) {
  unwrap(await sb.rpc("use_favorite", { p_id: id }));
}

// ---------- notifications (see notifications-migration.sql and supabase/functions/notify) ----------

// This device, for the person signed in: { endpoint, p256dh, auth, device }.
export async function savePushDevice({ endpoint, p256dh, auth, device }) {
  unwrap(await sb.rpc("save_push_device", { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth, p_device: device }));
}

export async function forgetPushDevice(endpoint) {
  unwrap(await sb.from("push_subscriptions").delete().eq("endpoint", endpoint));
}

// Your notification settings, for all your devices (reminders-migration.sql): { reminders,
// reminder_hour, show_amounts, partner_activity, time_zone, … }, or null when you have no row yet
// (the defaults apply). "missing" until the migration has run. partner_activity is absent until
// activity-migration.sql has run.
export function fetchNotifySettings() {
  return cached(`notify-settings:${state.me?.email}`, async () => {
    const { data, error } = await sb.from("notification_settings").select("*").maybeSingle();
    if (isMissingTable(error)) return "missing";
    return unwrap({ data, error });
  });
}

export async function saveNotifySettings(patch) {
  const { error } = await sb.from("notification_settings").upsert({ owner: state.me.email, ...patch, updated_at: new Date().toISOString() });
  if (error?.code === "PGRST204" && "partner_activity" in patch) throw new Error("Partner activity isn't set up yet. Run activity-migration.sql in Supabase.");
  if (error) throw error;
}

// Your notification center (inbox-migration.sql): what was sent to you in the last 30 days, newest
// first: [{ id, kind, title, body, url, created_at, read_at }]. null until the migration has run.
export function fetchInbox() {
  return cached(`inbox:${state.me?.email}`, async () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data, error } = await sb.from("notifications").select("id, kind, title, body, url, created_at, read_at")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(300);
    if (isMissingTable(error)) return null;
    return unwrap({ data, error });
  });
}

export async function markInboxRead() {
  unwrap(await sb.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null));
}

// ---------- the activity log (activity-log-migration.sql) ----------

// A page of the household's activity log, newest first: LOG_PAGE lines from offset, or null until
// the migration has run. The first page is kept on the phone, for offline.
export const LOG_PAGE = 50;
export function fetchActivity(offset = 0) {
  const load = async () => {
    const { data, error } = await sb.from("activity_log").select("*")
      .order("at", { ascending: false }).order("id").range(offset, offset + LOG_PAGE - 1);
    if (isMissingTable(error)) return null;
    return unwrap({ data, error });
  };
  return offset ? load() : cached(`activity:${state.me?.email}`, load);
}

// An owner removes the record of a deletion. Anything else is refused by the database's rule
// (nothing removed, no error), so that's an error here.
export async function deleteActivity(id) {
  const removed = unwrap(await sb.from("activity_log").delete().eq("id", id).select("id"));
  if (!removed.length) throw new Error("Only owners can remove that.");
}

// Right after you save something: the notify function tells the rest of the household. New:
// "entry", "repeat" (an entry set to repeat), "log" (a scheduled payment logged) with the entry's
// id, "scheduled" with the scheduled payment's id. Changes, with what it was before (extra):
// "edit" ({ before }), "edit_scheduled" ({ before, from }), "skip" / "unskip" ({ due }), "budget"
// (id: the month; { before: [{ category_id, amount_egp }] }). Deletes aren't announced. Nothing
// waits for it, and nothing is said if it fails (offline, or the function isn't updated yet).
export function notifyActivity(kind, id, extra = {}) {
  sb.functions.invoke("notify", { body: { action: "activity", kind, id, ...extra } }).catch(() => {});
}

// What an entry or scheduled payment was before an edit, for the others' "EGP 450 → EGP 520".
const BEFORE = ["type", "amount", "currency", "category_id", "subcategory_id", "income_source_id", "payment_method_id",
  "receiving_method_id", "occurred_on", "description", "who", "frequency", "day", "month", "starts_on", "ended_on"];
export const beforeOf = (row) => Object.fromEntries(BEFORE.filter((k) => k in row).map((k) => [k, row[k]]));

// Asks the notify function: "key" -> { publicKey }, "test" -> { devices, sent, removed, failed,
// reminder } (reminder: how many were due, when the test was today's reminder).
// Its own error message ("The push keys aren't set…") is passed on.
export async function callNotify(action, extra = {}) {
  const { data, error } = await sb.functions.invoke("notify", { body: { action, ...extra } });
  if (!error) return data;
  const status = error.context?.status; // context: the reply, or the network error when there was none
  const said = await error.context?.json?.().then((b) => b?.error || b?.message || b?.msg).catch(() => null);
  const e = new Error(status === 404
    ? "The notify function isn't set up in Supabase yet."
    : said || error.context?.message || error.message);
  e.status = status;
  throw e;
}

// ---------- the household (household-migration.sql) ----------
// Owners invite (and cancel invites) through the notify function, which uses Supabase's accounts;
// the rest are database functions that check who's asking.

const household = async (fn, args) => {
  const { error } = await sb.rpc(fn, args);
  if (error?.code === "PGRST202") throw new Error("This isn't set up yet. Run household-migration.sql in Supabase.");
  if (error) throw error;
};

// { invited, emailed }: emailed false when they already had an account (they just sign in).
export const inviteMember = (email, name) => callNotify("invite", { email, name, redirectTo: location.origin + location.pathname });
export const cancelInvite = (email) => callNotify("cancel_invite", { email });
export const setMemberRole = (email, role) => household("set_member_role", { p_email: email, p_role: role });
export const setMemberActive = (email, active) => household("set_member_active", { p_email: email, p_active: active });
export const renameMe = (name) => household("rename_me", { p_name: name });
// Notes your first sign-in, so you no longer show as "Invited".
export const markJoined = () => sb.rpc("mark_joined").then(() => {}, () => {});

// For someone signed in who can't see the household: "deactivated", "none", or "active".
export async function myMembership() {
  const { data, error } = await sb.rpc("my_membership");
  return error ? "none" : data;
}

// ---------- the household's lists ----------

export async function insertListItem(table, row) {
  return unwrap(await sb.from(table).insert(row).select().single());
}

export async function updateListItem(table, id, patch) {
  unwrap(await sb.from(table).update(patch).eq("id", id));
}
