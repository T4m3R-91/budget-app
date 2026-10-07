// The notification center, behind the bell beside the Add tab's greeting, in two lists:
// - For me: what the notify function sent you in the last 30 days (reminders and partner
//   activity). The bell counts what's unread; opening the list marks it all read, and tapping one
//   goes where it points. The function keeps a copy of each (public.notifications,
//   inbox-migration.sql), with or without a device turned on.
// - Everything: the household's activity log (activity.js): who added, changed or deleted what,
//   for everyone to see, never counted on the bell. Owners can remove the record of a deletion.

import { state } from "./state.js";
import { el, friendlyError, friendlyDate, isoLocal, toast } from "./ui.js";
import { fetchInbox, markInboxRead, fetchActivity, deleteActivity, LOG_PAGE } from "./db.js";
import { describe, removable } from "./activity.js";

const inbox = { status: "idle", rows: [], message: "" }; // idle | ready | missing | error
let fresh = new Set(); // unread when the list was opened: shown as new until it's left
let loading = null;
let tab = "me"; // "me" (For me) or "all" (Everything)
// The activity log as loaded so far: more, whether there's another page; armed, the line whose
// Delete was tapped once.
const log = { status: "idle", rows: [], message: "", more: false, loadingMore: false, armed: null };

export function refreshInbox() {
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

async function load() {
  try {
    const rows = await fetchInbox();
    Object.assign(inbox, rows === null ? { status: "missing", rows: [] } : { status: "ready", rows });
  } catch (e) {
    // Keep what's on screen; say so only when there's nothing to show.
    Object.assign(inbox, { status: inbox.rows.length ? "ready" : "error", message: friendlyError(e) });
  }
  paintBell();
  if (!document.getElementById("screen-inbox")?.hidden) paintInbox();
}

const unread = () => inbox.rows.filter((n) => !n.read_at).length;

// ---------- the bell ----------

// Sized and drawn by its own attributes too, so it stays a small outline even with an older
// styles.css (without .bell it would fill the screen's width).
const BELL = '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>';

// Hidden until the notification center is set up (inbox-migration.sql).
export function bell() {
  const b = el("a", { id: "bell", class: "bell", href: "#notifications" }, el("b", { class: "bell-badge" }));
  b.insertAdjacentHTML("afterbegin", BELL);
  paintBell(b);
  return b;
}

function paintBell(b = document.getElementById("bell")) {
  if (!b) return;
  const n = unread();
  b.hidden = inbox.status === "missing";
  const badge = b.querySelector(".bell-badge");
  badge.hidden = !n;
  badge.textContent = n > 9 ? "9+" : String(n);
  b.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
}

// ---------- the screen ----------

// view: "me" from the bell; "all" when coming back to Everything (#notifications/everything).
export async function showInbox(view = "me") {
  tab = view;
  log.armed = null;
  fresh = new Set();
  if (tab === "all") loadLog();
  paintInbox();
  await refreshInbox();
  if (tab === "me") readMine();
}

// For me, open: what's unread shows as new, and is marked read.
function readMine() {
  fresh = new Set(inbox.rows.filter((n) => !n.read_at).map((n) => n.id));
  if (!fresh.size) return;
  paintInbox();
  const now = new Date().toISOString();
  for (const n of inbox.rows) n.read_at ??= now;
  paintBell();
  markInboxRead().catch(() => { /* offline: they're still unread next time */ });
}

// The address follows the list, so coming back from where a line led returns to it.
function switchTo(next) {
  if (next === tab) return;
  tab = next;
  log.armed = null;
  history.replaceState(null, "", next === "all" ? "#notifications/everything" : "#notifications");
  if (tab === "all") loadLog();
  paintInbox();
  if (tab === "me") readMine();
}

const time = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const target = (url) => new URL(url || "./", location.href).hash || "#add";
const foot = (text, ...more) => el("div", { class: "list-foot" }, text, ...more);

function paintInbox() {
  const box = document.getElementById("screen-inbox");
  if (!box) return;
  const seg = el("div", { class: "seg small inbox-seg", role: "group", "aria-label": "Show" },
    [["me", "For me"], ["all", "Everything"]].map(([key, label]) =>
      el("button", { type: "button", class: tab === key ? "active" : "", "aria-pressed": String(tab === key), text: label, onclick: () => switchTo(key) })));
  box.replaceChildren(
    el("div", { class: "entry-head" }, el("a", { class: "link-btn", href: "#add", text: "Back" }), el("h2", { text: "Notifications" }), el("span")),
    seg,
    ...(tab === "all" ? logList() : myList()));
}

// As History: by day, newest first (Today, Yesterday, 2 Oct…), a card each.
function byDay(rows, when, card) {
  const out = [];
  let lastDay = null;
  for (const row of rows) {
    const day = isoLocal(new Date(when(row)));
    if (day !== lastDay) out.push(el("h3", { class: "hist-date", text: friendlyDate(day) }));
    lastDay = day;
    out.push(card(row));
  }
  return out;
}

// ---------- For me ----------

function myList() {
  if (inbox.status === "idle") return [foot("Loading…")];
  if (inbox.status === "missing") return [foot("The notification list isn't set up yet. Run inbox-migration.sql in Supabase.")];
  if (inbox.status === "error") {
    return [foot(`Couldn't load notifications. ${inbox.message} `, el("button", { type: "button", class: "link-btn", text: "Try again", onclick: refreshInbox }))];
  }
  if (!inbox.rows.length) return [foot("Nothing yet. Reminders and partner activity from the last 30 days show up here.")];
  return [...byDay(inbox.rows, (n) => n.created_at, card), foot("Notifications from the last 30 days.")];
}

// Amounts in a notification's text: "EGP 450", "USD 15.99", "+EGP 22,000" (income has the +).
const AMOUNT = /\+?(?:EGP|USD) \d[\d,]*(?:\.\d+)?/g;

// Income or a payment, from what the notification says: its amounts (all with + is income), or
// with Show amounts off, the income source its title names.
function isIncome(n) {
  const amounts = (n.body || "").match(AMOUNT) || [];
  if (amounts.length) return amounts.every((a) => a.startsWith("+"));
  return state.incomeSources.some((s) => n.title.includes(`${s.icon} ${s.name}`));
}

// The text with its amounts as History shows them: red with − for a payment, green with + for income.
// A budget's amounts are budgets, not payments: shown as they are.
const aboutBudget = (n) => /'s budget$/.test(n.title);
function bodyText(body, signed = true) {
  if (!signed) return el("span", { class: "txn-sub inbox-body", text: body });
  const parts = [];
  let at = 0;
  for (const m of body.matchAll(AMOUNT)) {
    const income = m[0].startsWith("+");
    parts.push(body.slice(at, m.index), el("span", { class: `inbox-amt ${income ? "in" : "out"}`, text: income ? m[0] : `−${m[0]}` }));
    at = m.index + m[0].length;
  }
  parts.push(body.slice(at));
  return el("span", { class: "txn-sub inbox-body" }, ...parts);
}

// One notification as one of History's cards (its shape, icon tile and red or green), with its own
// text: ⏰ for a reminder, 💳 for an Apple Pay payment to save, 👤 for partner activity, the
// title, the text under it, and the time at the right, after a dot while it's new.
function card(n) {
  return el("a", { class: `txn-row inbox-card ${isIncome(n) ? "income" : "expense"}`, href: target(n.url) },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: n.kind === "reminder" ? "⏰" : n.kind === "payment" ? "💳" : "👤" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: n.title }),
      n.body ? bodyText(n.body, !aboutBudget(n)) : null),
    el("span", { class: "inbox-when" },
      fresh.has(n.id) || !n.read_at ? el("span", { class: "inbox-dot", "aria-label": "New" }) : null,
      time(n.created_at)));
}

// ---------- Everything: the activity log ----------

async function loadLog() {
  try {
    const rows = await fetchActivity(0);
    Object.assign(log, rows === null
      ? { status: "missing", rows: [], more: false }
      : { status: "ready", rows, more: rows.length === LOG_PAGE });
  } catch (e) {
    // Keep what's on screen; say so only when there's nothing to show.
    Object.assign(log, { status: log.rows.length ? "ready" : "error", message: friendlyError(e) });
  }
  if (tab === "all") paintInbox();
}

async function loadMore() {
  log.loadingMore = true;
  paintInbox();
  try {
    const rows = await fetchActivity(log.rows.length);
    const have = new Set(log.rows.map((l) => l.id));
    log.rows.push(...rows.filter((l) => !have.has(l.id)));
    log.more = rows.length === LOG_PAGE;
  } catch (e) {
    toast(friendlyError(e));
  }
  log.loadingMore = false;
  paintInbox();
}

function logList() {
  if (log.status === "idle") return [foot("Loading…")];
  if (log.status === "missing") return [foot("The activity log isn't set up yet. Run activity-log-migration.sql in Supabase.")];
  if (log.status === "error") {
    return [foot(`Couldn't load the activity log. ${log.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: () => { log.status = "idle"; paintInbox(); loadLog(); } }))];
  }
  if (!log.rows.length) return [foot("Nothing yet. What anyone adds, changes or deletes from now on shows up here.")];
  return [
    ...byDay(log.rows, (l) => l.at, logCard),
    log.more
      ? foot(el("button", { type: "button", class: "btn secondary small", text: log.loadingMore ? "Loading…" : "Load more", disabled: log.loadingMore, onclick: loadMore }))
      : foot("Everything from the last 12 months."),
  ];
}

// A line as a card like For me's: its icon, what happened, the details, the time. A payment's red
// and income's green; household, Settings and budget lines plain. A line about something deleted
// leads nowhere, and owners can remove it (Delete, then Tap again).
function logCard(line) {
  const d = describe(line);
  const del = removable(line)
    ? el("button", { type: "button", class: "btn danger small log-del", text: log.armed === line.id ? "Tap again" : "Delete", onclick: (e) => removeLine(e, line) })
    : null;
  return el(d.href ? "a" : "div", { class: `txn-row inbox-card log-line${d.tone ? ` ${d.tone}` : ""}`, ...(d.href ? { href: d.href } : {}) },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: d.icon }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: d.title }),
      d.body ? bodyText(d.body, d.signed) : null),
    el("span", { class: "inbox-when log-when" }, time(line.at), del));
}

async function removeLine(e, line) {
  e.preventDefault();
  if (log.armed !== line.id) {
    log.armed = line.id;
    return paintInbox();
  }
  log.armed = null;
  try {
    await deleteActivity(line.id);
    log.rows = log.rows.filter((l) => l.id !== line.id);
    toast("Removed from the log");
  } catch (err) {
    toast(friendlyError(err));
  }
  paintInbox();
}
