// Recurring items (rent, salary, subscriptions…) that repeat monthly or yearly. Nothing is logged
// automatically: each due date shows on the Budget tab's Recurring card to Log (one tap, dated
// today, or on a day picked with its ▾, at that day's rate; a flat 5 points) or Skip, and the
// Budget tab icon counts what's due. An entry typed
// by hand in the same month with the same category (or income source), currency and amount counts
// as the item logged. Anything left open stays due (overdue) until it's logged or skipped.

import { state, byId } from "./state.js";
import { el, toast, fmtMoney, friendlyError, isoLocal, parseISODate } from "./ui.js";
import { getLiveRate, getRateOn } from "./fx.js";
import {
  fetchRecurring, updateRecurring, skipOccurrence, unskipOccurrence, fetchUnlinkedBetween,
  insertTransaction, deleteTransaction, latestEntryRate,
} from "./db.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NOT_SET_UP = "Recurring items aren't set up yet. Run recurring-migration.sql in Supabase to turn them on.";
// The tables or columns don't exist until recurring-migration.sql has run.
const isMissing = (e) => ["42P01", "42703", "PGRST205", "PGRST204", "PGRST202"].includes(e?.code);

// ---------- dates (months are their 1st day: "2026-10-01") ----------

const pad = (n) => String(n).padStart(2, "0");
const daysIn = (year, month) => new Date(year, month, 0).getDate(); // month: 1–12
const firstOf = (iso) => `${iso.slice(0, 7)}-01`;
function addMonths(month, by) {
  const d = parseISODate(month);
  d.setMonth(d.getMonth() + by);
  return isoLocal(d);
}
function dayBefore(iso) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() - 1);
  return isoLocal(d);
}
export const shortDate = (iso) => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
export function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

// The item's due date in a month, or null when it isn't due then. Days 29–31 fall on the last day
// of shorter months.
function dueIn(item, month) {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (item.frequency === "yearly" && item.month !== m) return null;
  const due = `${year}-${pad(m)}-${pad(Math.min(item.day, daysIn(year, m)))}`;
  if (due < item.starts_on || (item.ended_on && due > item.ended_on)) return null;
  return due;
}

// Every due date from the item's start through a month.
function occurrencesThrough(item, lastMonth) {
  const out = [];
  for (let month = firstOf(item.starts_on); month <= lastMonth; month = addMonths(month, 1)) {
    const due = dueIn(item, month);
    if (due) out.push(due);
  }
  return out;
}

// The next due date on or after a day: where an edit's changes start.
export function nextDue(item, from = isoLocal()) {
  let month = firstOf(from);
  for (let i = 0; i < 26; i++, month = addMonths(month, 1)) {
    const due = dueIn(item, month);
    if (due && due >= from) return due;
  }
  return from;
}

// "🏠 Rent": the item's note if it has one, else its subcategory, category or income source.
export function recurringLabel(item) {
  const source = item.type === "income" ? byId(state.incomeSources, item.income_source_id) : byId(state.categories, item.category_id);
  const name = item.description || byId(state.subcategories, item.subcategory_id)?.name || source?.name || "Unknown";
  return `${source?.icon || "•"} ${name}`;
}

// ---------- data ----------

// handled: "itemId|due" → { status, amount, currency, on }, status "logged" (an entry was logged
// from it) | "matched" (a hand-typed entry looks like it) | "skipped"; amount, currency and on (its
// date, as in History) are the entry's, as actually logged. rate: EGP per USD, for the
// "Remaining recurring" total.
const data = { status: "idle", items: [], handled: new Map(), rate: null, message: "" };
const key = (itemId, due) => `${itemId}|${due}`;
let loading = null;

export function refreshRecurring() {
  loading ??= load().finally(() => { loading = null; });
  return loading;
}

export async function recurringItem(id) {
  if (data.status !== "ready") await refreshRecurring();
  return data.items.find((i) => i.id === id) || null;
}

async function load() {
  try {
    const ratePromise = currentRate();
    const { items, skips, links } = await fetchRecurring();
    const handled = new Map();
    for (const l of links) handled.set(key(l.recurring_id, l.recurring_due_on), { status: "logged", amount: l.amount, currency: l.currency, on: l.occurred_on });
    for (const s of skips) if (!handled.has(key(s.item_id, s.due_on))) handled.set(key(s.item_id, s.due_on), { status: "skipped" });

    // Match entries typed by hand to occurrences still open: same month, type, category (or
    // income source), currency and amount; one entry per occurrence, earliest first.
    const through = addMonths(firstOf(isoLocal()), 1); // next month, the furthest the Budget tab goes
    const open = items
      .flatMap((item) => occurrencesThrough(item, through).map((due) => ({ item, due })))
      .filter((o) => !handled.has(key(o.item.id, o.due)))
      .sort((a, b) => a.due.localeCompare(b.due));
    if (open.length) {
      const candidates = await fetchUnlinkedBetween(firstOf(open[0].due), addMonths(through, 1));
      const used = new Set();
      for (const { item, due } of open) {
        const hit = candidates.find((t) => !used.has(t.id) && t.type === item.type && firstOf(t.occurred_on) === firstOf(due)
          && t.currency === item.currency && Number(t.amount) === Number(item.amount)
          && (item.type === "expense" ? t.category_id === item.category_id : t.income_source_id === item.income_source_id));
        if (hit) {
          used.add(hit.id);
          handled.set(key(item.id, due), { status: "matched", amount: hit.amount, currency: hit.currency, on: hit.occurred_on });
        }
      }
    }
    Object.assign(data, { status: "ready", items, handled, rate: (await ratePromise)?.rate ?? null });
  } catch (e) {
    Object.assign(data, { status: isMissing(e) ? "missing" : "error", items: [], handled: new Map(), message: friendlyError(e) });
  }
  paintBadge();
  paintRecurring();
}

async function currentRate() {
  const live = await getLiveRate(); // offline: the last one fetched, if any
  if (live) return { rate: live.rate, source: "live" };
  try {
    const last = await latestEntryRate();
    if (last) return { rate: Number(last.rate), source: "last_entry" };
  } catch { /* offline */ }
  return null;
}

// The rate an entry dated on a day is saved with, as on the Add screen: that day's rate when it's
// in the past (today's if that can't be had), otherwise today's.
async function rateFor(date) {
  if (date < isoLocal()) {
    const day = await getRateOn(date);
    if (day) return { rate: day.rate, source: "historical" };
  }
  return currentRate();
}

function statusOf(item, due, today) {
  const h = data.handled.get(key(item.id, due));
  if (h) return h.status === "skipped" ? "skipped" : "logged";
  return due < today ? "overdue" : due === today ? "due" : "later";
}

// ---------- the Budget tab badge: what's due today or overdue ----------

function paintBadge() {
  const badge = document.getElementById("budget-badge");
  if (!badge) return;
  const today = isoLocal();
  const count = data.status !== "ready" ? 0 : data.items.reduce((n, item) =>
    n + occurrencesThrough(item, firstOf(today)).filter((due) => due <= today && !data.handled.has(key(item.id, due))).length, 0);
  badge.hidden = !count;
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.closest("a")?.setAttribute("aria-label", count ? `Budget, ${count} due` : "Budget");
}

// ---------- the Budget tab's Recurring card (follows the tab's month switcher) ----------

let viewMonth = null;
let menuFor = null; // "itemId|due" of the row whose Edit / Remove menu is open
let stopArmed = null; // "itemId|due" of the row waiting for a second tap on Remove
const logDates = new Map(); // "itemId|due" → the date picked with Log's ▾ (otherwise: today)

export function paintRecurring(month = viewMonth) {
  viewMonth = month;
  const box = document.getElementById("r-card");
  if (!box || !month) return;
  box.replaceChildren(el("div", { class: "card-head" }, el("h3", { text: "Recurring" })), ...cardBody(month));
}

function cardBody(month) {
  if (data.status === "idle") return [el("p", { class: "muted small", text: "Loading…" })];
  if (data.status === "missing") return [el("p", { class: "muted small", text: NOT_SET_UP })];
  if (data.status === "error") {
    return [el("p", { class: "muted small" }, `Couldn't load recurring items. ${data.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: refreshRecurring }))];
  }
  if (!data.items.length) {
    return [el("p", { class: "muted small", text: "Nothing repeats yet. When adding an entry, tap ↻ on the On tile to repeat it monthly or yearly." })];
  }

  const today = isoLocal();
  const thisMonth = firstOf(today);
  // This month also carries anything still open from earlier months, at the top.
  const earlier = month === thisMonth
    ? data.items.flatMap((item) => occurrencesThrough(item, addMonths(thisMonth, -1))
        .filter((due) => !data.handled.has(key(item.id, due))).map((due) => ({ item, due })))
    : [];
  const rows = [
    ...earlier.sort((a, b) => a.due.localeCompare(b.due)),
    ...data.items.map((item) => ({ item, due: dueIn(item, month) })).filter((o) => o.due).sort((a, b) => a.due.localeCompare(b.due)),
  ];
  if (!rows.length) return [el("p", { class: "muted small", text: `Nothing recurring in ${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}.` })];

  const open = rows.filter((o) => ["overdue", "due", "later"].includes(statusOf(o.item, o.due, today)));
  return [
    el("ul", { class: "rec-list" }, rows.map((o) => rowEl(o, today))),
    open.length
      ? el("p", { class: "rec-left" },
          el("span", { text: `Remaining recurring in ${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}` }), el("span", { text: stillToCome(open) }))
      : null,
  ].filter(Boolean);
}

function rowEl({ item, due }, today) {
  const status = statusOf(item, due, today);
  const k = key(item.id, due);
  const income = item.type === "income";
  // Logged rows show what was actually logged; the rest, the item's current amount.
  const shown = data.handled.get(k)?.amount != null ? data.handled.get(k) : item;
  const amount = `${income ? "+" : "−"}${fmtMoney(shown.amount, shown.currency, { code: true })}`;
  // Paid / received on the entry's own date, as History shows it (not the due date).
  const paidOn = data.handled.get(k)?.on || due;
  const when = {
    logged: `✓ ${income ? "Received" : "Paid"} · ${shortDate(paidOn)}`, skipped: `Skipped · ${shortDate(due)}`,
    overdue: `Overdue · ${shortDate(due)}`, due: "Due today", later: `Due ${shortDate(due)}`,
  }[status];
  const handled = status === "logged" || status === "skipped";
  // Remove this occurrence and every later one; one already logged or skipped is kept.
  const removeLabel = handled ? `Remove after ${shortDate(due)}` : `Remove from ${shortDate(due)} on`;
  // As in History: the category (or income source) as the title, then subcategory · note.
  const source = income ? byId(state.incomeSources, item.income_source_id) : byId(state.categories, item.category_id);
  const details = [byId(state.subcategories, item.subcategory_id)?.name, item.description].filter(Boolean).join(" · ");
  return el("li", { class: `rec-row ${status} ${income ? "income" : "expense"}` },
    el("div", { class: "rec-line" },
      el("button", {
        type: "button", class: "rec-name", "aria-expanded": String(menuFor === k),
        onclick: () => { menuFor = menuFor === k ? null : k; stopArmed = null; paintRecurring(); },
      }, el("span", { text: `${source?.icon || "•"} ${source?.name || "Unknown"}` }), el("span", { class: "rec-more", "aria-hidden": "true", text: "▾" })),
      el("span", { class: "rec-amt", text: amount })),
    details ? el("div", { class: "rec-details", text: details }) : null,
    el("div", { class: "rec-line" },
      el("span", { class: "rec-when", text: when }),
      // Open (overdue, due or still to come, so a payment made early can be logged too):
      // Skip, and "Log today │ ▾"; the ▾ is a calendar, and the button then reads "Log on 5 Sep".
      status === "due" || status === "overdue" || status === "later"
        ? el("div", { class: "rec-actions" },
            el("button", { type: "button", class: "btn secondary small", text: "Skip", onclick: (e) => skipNow(item, due, e.currentTarget) }),
            logButton(item, due, today))
        : status === "skipped"
          ? el("div", { class: "rec-actions" },
              el("button", { type: "button", class: "btn primary small", text: "Unskip", onclick: (e) => unskipNow(item, due, e.currentTarget) }))
          : null),
    menuFor === k
      ? el("div", { class: "rec-menu" },
          el("a", { class: "btn primary small", href: `#recurring/${item.id}`, text: "Edit" }),
          el("button", {
            type: "button", class: "btn danger small", text: stopArmed === k ? "Tap again to remove" : removeLabel,
            onclick: (e) => (stopArmed === k ? removeFrom(item, due, handled, e.currentTarget) : (stopArmed = k, paintRecurring())),
          }))
      : null);
}

// "Log today │ ▾": the ▾ is the phone's own date picker (an invisible date field over it, as on
// the Add screen's On tile); picking a day makes the button "Log on 5 Sep".
function logButton(item, due, today) {
  const k = key(item.id, due);
  const on = logDates.get(k) || today;
  return el("div", { class: "split-btn" },
    el("button", {
      type: "button", class: "btn primary small", text: on === today ? "Log today" : `Log on ${shortDate(on)}`,
      onclick: (e) => logNow(item, due, e.currentTarget, on),
    }),
    el("span", { class: "btn primary small split-date" }, el("span", { "aria-hidden": "true", text: "▾" }),
      el("input", {
        type: "date", value: on, "aria-label": "Date to log it on",
        onchange: (e) => {
          if (!e.target.value) return;
          if (e.target.value === today) logDates.delete(k);
          else logDates.set(k, e.target.value);
          paintRecurring();
        },
        // With a mouse, a click on the (invisible) field doesn't open the calendar by itself.
        onclick: (e) => {
          if (!window.matchMedia("(pointer: fine)").matches) return;
          try { e.currentTarget.showPicker(); } catch { /* older browsers: the field still takes typing */ }
        },
      })));
}

// Open items' total in the tab's currency (≈ when some are converted at today's rate); spending
// and income separately. Without a rate, each currency is totalled on its own.
function stillToCome(open) {
  const cur = state.displayCurrency;
  const sums = new Map(); // "expense|EGP" → total
  let approx = false;
  for (const { item } of open) {
    let amount = Number(item.amount);
    let currency = item.currency;
    if (currency !== cur && data.rate) {
      amount = cur === "USD" ? amount / data.rate : amount * data.rate;
      currency = cur;
      approx = true;
    }
    const k = `${item.type}|${currency}`;
    sums.set(k, (sums.get(k) || 0) + amount);
  }
  const parts = ["expense", "income"].flatMap((type) => ["EGP", "USD"]
    .filter((c) => sums.get(`${type}|${c}`))
    .map((c) => `${type === "income" ? "+" : "−"}${fmtMoney(sums.get(`${type}|${c}`), c, { decimals: 0, code: true })}`));
  return `${approx ? "≈ " : ""}${parts.join(" · ")}`;
}

// ---------- actions ----------

// Logs the occurrence due on `due` as an entry dated `on` (today, or the day picked with Log's ▾),
// at that date's rate. Either way it counts as that occurrence logged, for a flat 5 points.
async function logNow(item, due, button, on = isoLocal()) {
  button.disabled = true;
  const rate = await rateFor(on);
  if (!rate) {
    // No exchange rate to save with: open it in the form, where one can be typed in.
    toast("Couldn't get an exchange rate. Check it and save.");
    location.hash = `#log/${item.id}/${due}`;
    return;
  }
  const expense = item.type === "expense";
  try {
    const saved = await insertTransaction({
      type: item.type, occurred_on: on, amount: Number(item.amount), currency: item.currency,
      rate: rate.rate, rate_source: rate.source,
      category_id: expense ? item.category_id : null, subcategory_id: expense ? item.subcategory_id : null,
      income_source_id: expense ? null : item.income_source_id, payment_method_id: expense ? item.payment_method_id : null,
      who: item.who, description: item.description, recurring_id: item.id, recurring_due_on: due,
    });
    const pts = Number.isInteger(saved.points) ? saved.points : null;
    logDates.delete(key(item.id, due));
    const dated = on === isoLocal() ? "today" : `on ${shortDate(on)}`;
    toast(`Logged ${recurringLabel(item)} · ${fmtMoney(saved.amount, saved.currency, { code: true })} · ${dated}${pts ? ` · +${pts} pts` : ""}`, {
      label: "Undo",
      run: async () => {
        try {
          await deleteTransaction(saved.id);
          toast(pts ? `Entry removed · −${pts} pts` : "Entry removed");
        } catch (e) { toast(friendlyError(e)); }
        refreshRecurring();
      },
    });
  } catch (e) {
    toast(e?.code === "23505" ? "That one's already logged." : friendlyError(e));
  }
  refreshRecurring();
}

async function skipNow(item, due, button) {
  button.disabled = true;
  try {
    await skipOccurrence(item.id, due);
    toast(`Skipped ${recurringLabel(item)} (${shortDate(due)})`, {
      label: "Undo",
      run: async () => {
        try { await unskipOccurrence(item.id, due); } catch (e) { toast(friendlyError(e)); }
        refreshRecurring();
      },
    });
  } catch (e) {
    toast(friendlyError(e));
  }
  refreshRecurring();
}

async function unskipNow(item, due, button) {
  button.disabled = true;
  try {
    await unskipOccurrence(item.id, due);
    toast(`${recurringLabel(item)} (${shortDate(due)}) is back`);
  } catch (e) {
    toast(friendlyError(e));
  }
  refreshRecurring();
}

// Ends the item from this occurrence on: it and every later one disappear. Earlier ones (and this
// one too, if it's already logged or skipped) stay, and so do all entries already logged.
async function removeFrom(item, due, handled, button) {
  button.disabled = true;
  try {
    await updateRecurring(item.id, { ended_on: handled ? due : dayBefore(due) });
    toast(`${recurringLabel(item)} removed ${handled ? `after ${shortDate(due)}` : `from ${shortDate(due)} on`}`);
  } catch (e) {
    toast(friendlyError(e));
  }
  menuFor = null;
  stopArmed = null;
  refreshRecurring();
}
