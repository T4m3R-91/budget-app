// The notification center: what the notify function sent you in the last 30 days (reminders and
// partner activity), behind the bell beside the Add tab's greeting. The bell counts what's unread;
// opening the list marks it all read, and tapping one goes where it points. The function keeps a
// copy of each (public.notifications, inbox-migration.sql), with or without a device turned on.

import { state } from "./state.js";
import { el, friendlyError, friendlyDate, isoLocal } from "./ui.js";
import { fetchInbox, markInboxRead } from "./db.js";

const inbox = { status: "idle", rows: [], message: "" }; // idle | ready | missing | error
let fresh = new Set(); // unread when the list was opened: shown as new until it's left
let loading = null;

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

// ---------- the list ----------

export async function showInbox() {
  fresh = new Set();
  paintInbox();
  await refreshInbox();
  fresh = new Set(inbox.rows.filter((n) => !n.read_at).map((n) => n.id));
  if (!fresh.size) return;
  paintInbox();
  const now = new Date().toISOString();
  for (const n of inbox.rows) n.read_at ??= now;
  paintBell();
  markInboxRead().catch(() => { /* offline: they're still unread next time */ });
}

const time = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const target = (url) => new URL(url || "./", location.href).hash || "#add";

function paintInbox() {
  const box = document.getElementById("screen-inbox");
  if (!box) return;
  const foot = (text, ...more) => el("div", { class: "list-foot" }, text, ...more);
  let body;
  if (inbox.status === "idle") body = [foot("Loading…")];
  else if (inbox.status === "missing") body = [foot("The notification list isn't set up yet. Run inbox-migration.sql in Supabase.")];
  else if (inbox.status === "error") {
    body = [foot(`Couldn't load notifications. ${inbox.message} `, el("button", { type: "button", class: "link-btn", text: "Try again", onclick: refreshInbox }))];
  } else if (!inbox.rows.length) {
    body = [foot("Nothing yet. Reminders and partner activity from the last 30 days show up here.")];
  } else {
    // As History: by day, newest first (Today, Yesterday, 2 Oct…), a card each.
    body = [];
    let lastDay = null;
    for (const n of inbox.rows) {
      const day = isoLocal(new Date(n.created_at));
      if (day !== lastDay) body.push(el("h3", { class: "hist-date", text: friendlyDate(day) }));
      lastDay = day;
      body.push(card(n));
    }
    body.push(foot("Notifications from the last 30 days."));
  }
  box.replaceChildren(
    el("div", { class: "entry-head" }, el("a", { class: "link-btn", href: "#add", text: "Back" }), el("h2", { text: "Notifications" }), el("span")),
    ...body);
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
function bodyText(body) {
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
// text: ⏰ for a reminder, 👤 for partner activity, the title, the text under it, and the time at
// the right, after a dot while it's new.
function card(n) {
  return el("a", { class: `txn-row inbox-card ${isIncome(n) ? "income" : "expense"}`, href: target(n.url) },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: n.kind === "reminder" ? "⏰" : "👤" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: n.title }),
      n.body ? bodyText(n.body) : null),
    el("span", { class: "inbox-when" },
      fresh.has(n.id) || !n.read_at ? el("span", { class: "inbox-dot", "aria-label": "New" }) : null,
      time(n.created_at)));
}
