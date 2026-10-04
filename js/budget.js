// Monthly budgets: the Budget tab, the form that sets a month's budget, and the figures behind
// the Add screen's category fills. One amount per category, in EGP, set month by
// month (calendar months, no rollover). Spending counts each entry's saved EGP value, so a
// category's % used doesn't move with the exchange rate. A month is "set" once it has at least
// one category amount.

import { state, byId } from "./state.js";
import { el, fmtMoney, toast, friendlyError, isoLocal, parseISODate } from "./ui.js";
import { parseAmount } from "./numbers.js";
import { fetchBudget, saveBudget, fetchExpensesBetween, firstEntryDate, notifyActivity } from "./db.js";
import { paintRecurring, refreshRecurring, furthestDueMonth, scheduledFor } from "./recurring.js";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NOT_SET_UP = "Budgets aren't set up yet. Run budgets-migration.sql in Supabase to turn them on.";

// Months are their 1st day: "2026-10-01".
export const monthOf = (iso) => `${iso.slice(0, 7)}-01`;

// Short amounts for the budget bars and tiles: 950, 10.62K, 16K, 1.25M (two decimals at most).
export function compact(n) {
  const two = (x) => Math.round(x * 100) / 100;
  const v = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const fmt = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (two(v / 1e6) >= 1) return `${sign}${fmt(two(v / 1e6))}M`;
  if (two(v / 1e3) >= 1) return `${sign}${fmt(two(v / 1e3))}K`;
  return `${sign}${Math.round(v).toLocaleString("en-US")}`;
}
export function shiftMonth(month, by) {
  const d = parseISODate(month);
  d.setMonth(d.getMonth() + by);
  return isoLocal(d);
}
const monthName = (month) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];
const monthShort = (month) => `${monthName(month).slice(0, 3)} ${month.slice(0, 4)}`;

const egp = (n) => fmtMoney(n, "EGP", { decimals: 0 });
const plain = (n) => Math.round(n).toLocaleString("en-US");
const toMap = (rows) => new Map(rows.map((r) => [r.category_id, Number(r.amount_egp)]));
function spentBy(rows) {
  const out = new Map();
  for (const r of rows) out.set(r.category_id, (out.get(r.category_id) || 0) + Number(r.amount_egp));
  return out;
}
// The budgets table or its save function doesn't exist until budgets-migration.sql has run.
const isMissing = (e) => ["42P01", "PGRST205", "PGRST202"].includes(e?.code);

// ---------- Add screen: the month's budget and spending so far ----------

// { month, budget, spent, spentUsd } (Maps of categoryId → EGP, or USD for spentUsd, each entry at
// its saved value), or null when the month has no budget or budgets can't be reached (not set up
// yet, or offline); the tiles then just stay plain.
export async function monthStatus(month) {
  try {
    const [rows, spend] = await Promise.all([fetchBudget(month), fetchExpensesBetween(month, shiftMonth(month, 1))]);
    const spentUsd = spentBy(spend.map((r) => ({ category_id: r.category_id, amount_egp: r.amount_usd })));
    return rows.length ? { month, budget: toMap(rows), spent: spentBy(spend), spentUsd } : null;
  } catch {
    return null;
  }
}

// ---------- the Budget tab ----------

// data: month → { status: "loading" | "ready" | "missing" | "error", budget, spent }, where budget is
// Map(categoryId → EGP) and spent Map(categoryId → { egp, usd }), each entry at its saved values.
// next: the month to open on once, right after saving one (or coming back from a recurring item's
// form opened from it); otherwise the tab opens on this month.
// earliest: the month of your first entry, the furthest back the month switcher goes.
const card = { month: null, next: null, earliest: null, data: new Map() };
let built = false;

// Recurring items (re)loaded: how far ahead the month switcher goes, and what's scheduled on the
// bars, may have changed.
window.addEventListener("recurringchange", () => {
  if (document.getElementById("screen-budget")?.hidden === false) paintCard();
});
// A payment was logged (or that undone) from the Scheduled card: the spending on the bars is out of
// date. This month is fetched again (its bars stay up meanwhile); other months, when next shown.
window.addEventListener("entrieschange", () => {
  if (document.getElementById("screen-budget")?.hidden !== false) return;
  const shown = card.data.get(card.month);
  card.data.clear();
  if (shown) card.data.set(card.month, shown);
  loadCardMonth({ refresh: true });
});

// The month the tab is showing (null before it's first opened), and opening it on a given month
// next time: a recurring item's Edit or Log form returns to the month it was opened from.
export const budgetMonth = () => card.month;
export function openBudgetOn(month) {
  if (month) card.next = month;
}

export function showBudget() {
  if (!built) {
    built = true;
    document.getElementById("screen-budget").replaceChildren(
      el("div", { class: "dash-head" },
        el("h2", { text: "Budget" }),
        el("div", { id: "b-cur", class: "seg small", role: "group", "aria-label": "Show amounts in" })),
      el("section", { class: "card budget-card", id: "b-card", "aria-label": "Budget" }),
      el("section", { class: "card budget-card", id: "r-card", "aria-label": "Scheduled" }));
  }
  paintCurrency();
  card.month = card.next ?? monthOf(isoLocal());
  card.next = null;
  card.data.clear(); // either of you may have changed a budget or logged spending since
  loadEarliest();
  loadCardMonth();
  refreshRecurring();
}

// EGP/USD, shared with the Dashboard's switch. Budgets themselves are always EGP (see cardBody).
function paintCurrency() {
  document.getElementById("b-cur").replaceChildren(...["EGP", "USD"].map((c) =>
    el("button", {
      type: "button", class: state.displayCurrency === c ? "active" : "", "aria-pressed": String(state.displayCurrency === c), text: c,
      onclick: () => { state.displayCurrency = c; paintCurrency(); paintCard(); },
    })));
}

async function loadEarliest() {
  try {
    const first = await firstEntryDate();
    card.earliest = first ? monthOf(first) : null;
  } catch { /* the switcher just stays at this month */ }
  paintCard();
}

// refresh: fetch again even if the month is loaded (keeping its figures on screen meanwhile).
async function loadCardMonth({ refresh = false } = {}) {
  const month = card.month;
  const kept = card.data.get(month);
  if (refresh || !kept) {
    if (kept?.status !== "ready") {
      card.data.set(month, { status: "loading" });
      paintCard();
    }
    try {
      const [rows, spend] = await Promise.all([fetchBudget(month), fetchExpensesBetween(month, shiftMonth(month, 1))]);
      const spent = new Map();
      for (const r of spend) {
        const s = spent.get(r.category_id) || { egp: 0, usd: 0 };
        s.egp += Number(r.amount_egp);
        s.usd += Number(r.amount_usd);
        spent.set(r.category_id, s);
      }
      card.data.set(month, { status: "ready", budget: toMap(rows), spent });
    } catch (e) {
      if (kept?.status !== "ready") card.data.set(month, { status: isMissing(e) ? "missing" : "error" }); // a failed refresh keeps what's shown
    }
  }
  if (month === card.month) paintCard();
}

function paintCard() {
  const box = document.getElementById("b-card");
  if (!box || !card.month) return;
  const { month } = card;
  const now = monthOf(isoLocal());
  const data = card.data.get(month);
  // From the month of your first entry up to next month (which can be set ahead), or further when a
  // payment is scheduled further ahead.
  const earliest = card.earliest && card.earliest < now ? card.earliest : now;
  const furthest = [shiftMonth(now, 1), furthestDueMonth()].sort().at(-1);
  const go = (by) => { card.month = shiftMonth(card.month, by); loadCardMonth(); };
  const when = data?.status === "ready" && data.budget.size ? whenText(month, now) : "";
  box.replaceChildren(
    el("div", { class: "card-head" },
      el("div", { class: "bud-title" }, el("h3", { text: `${monthName(month)} ${month.slice(0, 4)}` }), when ? el("span", { text: when }) : null),
      el("div", { class: "month-nav" },
        el("button", { type: "button", class: "icon-btn", "aria-label": "Previous month", text: "‹", disabled: month <= earliest, onclick: () => go(-1) }),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Next month", text: "›", disabled: month >= furthest, onclick: () => go(1) }))),
    ...cardBody(month, now, data));
  paintRecurring(month); // the Recurring card follows the same month
}

function cardBody(month, now, data) {
  const editLink = (text, cls) => el("a", { class: cls, href: `#budget/${month.slice(0, 7)}`, text });
  if (!data || data.status === "loading") return [el("p", { class: "muted small", text: "Loading…" })];
  if (data.status === "missing") return [el("p", { class: "muted small", text: NOT_SET_UP })];
  if (data.status === "error") {
    return [el("p", { class: "muted small" }, "Couldn't load the budget. ",
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: () => { card.data.delete(month); loadCardMonth(); } }))];
  }
  const { budget, spent } = data;
  if (!budget.size) {
    return [
      el("p", { class: "bud-empty", text: month < now ? `No budget was set for ${monthName(month)}.` : `${monthName(month)}'s budget isn't set yet.` }),
      el("div", { class: "bud-foot" }, editLink(`Set ${monthName(month)}'s budget`, "btn primary small")),
    ];
  }

  const none = { egp: 0, usd: 0 };
  const scheduled = scheduledFor(month); // due this month, not logged yet
  const lines = [...budget]
    .map(([id, amount]) => {
      const cat = byId(state.categories, id);
      return { label: `${cat?.icon || "📦"} ${cat?.name || "Unknown"}`, budget: amount, spent: spent.get(id) || none, planned: scheduled.get(id) || none };
    })
    // Over budget first (or about to be, with what's scheduled), then the most used.
    .sort((a, b) => (b.spent.egp + b.planned.egp) / b.budget - (a.spent.egp + a.planned.egp) / a.budget);
  const sum = (list, field, key) => list.reduce((s, l) => s + l[field][key], 0);
  const total = lines.reduce((s, l) => s + l.budget, 0);
  const used = { egp: sum(lines, "spent", "egp"), usd: sum(lines, "spent", "usd") };
  const planned = { egp: sum(lines, "planned", "egp"), usd: sum(lines, "planned", "usd") };
  const unbudgeted = [...spent].filter(([id]) => !budget.has(id)).map(([, s]) => s);
  const inUsd = state.displayCurrency === "USD";
  // USD equivalents are marked ≈, as in History.
  const usd = (n) => `≈ ${fmtMoney(n, "USD", { decimals: 0, code: true })}`;

  // One short format (K / M) for the overall line and every category.
  // EGP: "EGP 10.62K / 15K"; what's scheduled but not logged yet shows as "+12K" in the striped
  // segment's color: "EGP 3K +12K / 16K". Over: "· 1K over", red when the spending is over,
  // orange when the scheduled payments would take it over.
  // USD: the limits are EGP, so only an overflow, in USD ("≈ USD 20 over"); nothing within budget.
  // An overflow already spent is that share of the spending's saved USD value (it doesn't drift
  // with the rate); one still to come, that share of the scheduled payments' USD value.
  const figures = (sp, pl, bu) => {
    const over = sp.egp > bu;
    const willOver = !over && sp.egp + pl.egp > bu;
    const by = over ? sp.egp - bu : sp.egp + pl.egp - bu;
    const overText = (text) => el("span", { class: willOver ? "will-over" : "is-over", text });
    if (inUsd) {
      if (!over && !willOver) return [];
      return [overText(`≈ USD ${compact(over ? (by / sp.egp) * sp.usd : (by / pl.egp) * pl.usd)} over`)];
    }
    return [
      `EGP ${compact(sp.egp)}`,
      pl.egp > 0 ? el("span", { class: "planned-fig", text: ` +${compact(pl.egp)}` }) : null,
      ` / ${compact(bu)}`,
      over || willOver ? [" · ", overText(`${compact(by)} over`)] : null,
    ];
  };
  // This month only: how far through the month today is, marked on every bar (an even pace).
  const pace = month === now ? paceToday() : null;
  const row = (label, sp, pl, bu, size) => {
    const status = sp.egp > bu ? " over" : sp.egp + pl.egp > bu ? " will-over" : "";
    return el("li", { class: `bud-row${size ? ` bud-${size}` : ""}${status}` },
      el("div", { class: "bud-line" },
        el("span", { class: "bud-name", text: label }),
        el("span", { class: "bud-fig" }, figures(sp, pl, bu))),
      bar(sp.egp, bu, size, pace, pl.egp));
  };

  return [
    el("ul", { class: "bud-list" },
      row("Overall", used, planned, total, "overall"),
      lines.map((l) => row(l.label, l.spent, l.planned, l.budget))),
    unbudgeted.length
      ? el("p", { class: "bud-none" }, el("span", { text: "Without a budget" }),
          el("span", { text: inUsd ? usd(unbudgeted.reduce((s, v) => s + v.usd, 0)) : egp(unbudgeted.reduce((s, v) => s + v.egp, 0)) }))
      : null,
    el("div", { class: "bud-foot" }, editLink("Edit budget", "btn primary small")), // same button as "Set …'s budget"
  ].filter(Boolean);
}

// Blue up to the budget; full and red once over. pace (0–1) adds a gray fill underneath, up to an
// even pace for today: gray showing past the blue is what an even pace would still allow by today.
// Spending beyond that pace (but still within budget) shows in the over-budget red. Scheduled
// payments not logged yet come last, striped, right after all of that (orange stripes when they'd
// take it over budget); the pace only ever counts what's actually spent.
function bar(spent, budget, size = "", pace = null, planned = 0) {
  const used = Math.min(100, (spent / budget) * 100);
  const later = Math.min(100 - used, (planned / budget) * 100);
  const at = pace == null ? null : pace * 100;
  const ahead = at != null && spent <= budget && used > at;
  const willOver = spent <= budget && spent + planned > budget;
  return el("div", { class: `bud-bar ${size}${spent > budget ? " over" : ""}${willOver ? " will-over" : ""}${later > 0 ? " has-planned" : ""}`, "aria-hidden": "true" },
    at == null ? null : el("span", { class: "pace", style: `width:${at.toFixed(1)}%` }),
    el("span", { class: "fill", style: `width:${used}%` }),
    ahead ? el("span", { class: "ahead", style: `left:${at.toFixed(1)}%;width:${(used - at).toFixed(1)}%` }) : null,
    later > 0 ? el("span", { class: "planned", style: `left:${used}%;width:${later}%` }) : null);
}

// Share of this month gone by the end of today: the 15th of a 30-day month is 0.5.
function paceToday() {
  const today = new Date();
  return today.getDate() / new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
}

function whenText(month, now) {
  if (month > now) return `Starts 1 ${monthName(month).slice(0, 3)}`;
  if (month < now) return "";
  const today = new Date();
  const left = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate() + 1;
  return left === 1 ? "Last day" : `${left} days left`;
}

// ---------- the form that sets a month's budget (#budget/2026-10) ----------

let editor = null;

export async function showBudgetEditor(yearMonth) {
  const screen = document.getElementById("screen-budgetform");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    location.hash = "#budget";
    return;
  }
  const month = `${yearMonth}-01`;
  const form = (editor = { month, saving: false, before: [] });
  screen.replaceChildren(el("p", { class: "muted", text: "Loading…" }));

  const since = shiftMonth(month, -3);
  let existing, history;
  try {
    [existing, history] = await Promise.all([fetchBudget(month), fetchExpensesBetween(since, month)]);
  } catch (e) {
    if (form !== editor) return;
    screen.replaceChildren(
      el("p", { class: "muted", text: isMissing(e) ? NOT_SET_UP : friendlyError(e) }),
      el("a", { class: "link-btn", href: "#budget", text: "Back to Budget" }));
    return;
  }
  if (form !== editor) return;

  // Averages over the 3 months before this one, counting only months with any spending, so a
  // newer household isn't averaged down by months before it started logging.
  const active = new Set(history.map((r) => monthOf(r.occurred_on))).size;
  const totals = spentBy(history);
  const current = toMap(existing);
  form.before = existing.map((r) => ({ category_id: r.category_id, amount_egp: Number(r.amount_egp) })); // for the others' notification
  form.span = `${monthName(since).slice(0, 3)}–${monthShort(shiftMonth(month, -1))}`;
  form.lines = state.categories
    .filter((c) => !c.hidden || current.has(c.id))
    .map((c) => {
      const avg = active ? (totals.get(c.id) || 0) / active : 0;
      // A month already set opens with its amounts; a new month with averages rounded to 100.
      const value = current.size ? current.get(c.id) : Math.round(avg / 100) * 100;
      return { cat: c, avg, value: value || null };
    });
  renderEditor();
}

function renderEditor() {
  const form = editor;
  const name = monthName(form.month);
  const inputs = [];
  const total = el("strong");
  const paintTotal = () => { total.textContent = egp(inputs.reduce((s, i) => s + (parseAmount(i.value) || 0), 0)); };
  const rows = form.lines.map((l) => {
    const input = el("input", {
      class: "text-input bud-input", type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "next",
      placeholder: "No budget", "aria-label": `${l.cat.name} budget in EGP`, value: l.value ? String(l.value) : "",
      oninput: paintTotal,
    });
    inputs.push(input);
    return el("label", { class: "bud-edit-row" },
      el("span", { class: "bud-edit-ico", "aria-hidden": "true", text: l.cat.icon }),
      el("span", { class: "bud-edit-name" },
        el("span", { text: l.cat.name }),
        el("span", { class: "bud-hint", text: l.avg ? `avg ${plain(l.avg)}` : "no spending" })),
      input);
  });
  const save = el("button", { type: "button", class: "btn primary", text: `Save ${name}'s budget` });
  save.addEventListener("click", () => saveEditor(inputs, save));

  document.getElementById("screen-budgetform").replaceChildren(
    el("div", { class: "entry-head" },
      el("a", { class: "link-btn", href: "#budget", text: "Cancel" }),
      el("h2", { text: `${name} budget` }),
      el("span")),
    el("p", { class: "bud-sub", text: `In EGP · averages from ${form.span}` }),
    el("div", { class: "bud-edit" }, rows),
    el("p", { class: "bud-edit-total" }, el("span", { text: "Total" }), total),
    el("div", { class: "action-bar" }, el("div", { class: "actions" }, save)));
  paintTotal();
}

async function saveEditor(inputs, button) {
  const form = editor;
  if (form.saving) return;
  const items = [];
  const bad = [];
  form.lines.forEach((l, i) => {
    const raw = inputs[i].value.trim();
    if (!raw || /^[\s0٠۰.,]+$/.test(raw)) return; // blank or zero: no budget for this category
    const amount = parseAmount(raw);
    if (amount == null || amount < 0) bad.push(inputs[i]);
    else items.push({ category_id: l.cat.id, amount_egp: amount });
  });
  if (bad.length) {
    for (const input of bad) {
      input.classList.remove("flag");
      void input.offsetWidth; // restart the animation on repeated taps
      input.classList.add("flag");
      input.addEventListener("animationend", (e) => { if (e.animationName === "glow") input.classList.remove("flag"); });
    }
    bad[0].focus();
    toast("Some amounts aren't numbers. Fix the highlighted ones.");
    return;
  }

  form.saving = true;
  button.disabled = true;
  button.textContent = "Saving…";
  const name = monthName(form.month);
  try {
    await saveBudget(form.month, items);
    notifyActivity("budget", form.month, { before: form.before }); // the others see what changed
    card.data.delete(form.month);
    card.next = form.month; // back on the Budget tab, show the month just set
    toast(items.length ? `${name} budget saved` : `${name} budget cleared`);
    location.hash = "#budget";
  } catch (e) {
    toast(isMissing(e) ? NOT_SET_UP : friendlyError(e));
    form.saving = false;
    button.disabled = false;
    button.textContent = `Save ${name}'s budget`;
  }
}
