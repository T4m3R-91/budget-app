// Past entries, newest first, grouped by day. Tap one to edit or delete it. The filter bar is the
// Dashboard's (same bar, same settings; see filters.js), plus History's own All / Expenses / Income.

import { state, byId, memberName } from "./state.js";
import { el, fmtMoney, friendlyDate, friendlyError } from "./ui.js";
import { fetchAllTransactions } from "./db.js";
import { mountFilterBar, setFilterOptions, matchesFilters, onFiltersChange } from "./filters.js";

const PAGE = 50;
const TYPES = { all: "All", expense: "Expenses", income: "Income" };

let type = "all";
let rows = null; // every entry, newest first; null until loaded
let shown = PAGE; // how many of the matching entries are on screen
let error = null;
let generation = 0; // ignores a load that finishes after a newer one started

const $ = (id) => document.getElementById(id);

onFiltersChange(() => {
  if ($("screen-history")?.hidden !== false) return; // on the Dashboard: it redraws itself
  shown = PAGE;
  renderList();
});

export async function showHistory() {
  const gen = ++generation;
  shown = PAGE;
  error = null;
  render();
  try {
    const loaded = await fetchAllTransactions();
    if (gen !== generation) return;
    rows = loaded;
    setFilterOptions(rows);
  } catch (e) {
    if (gen !== generation) return;
    error = friendlyError(e);
  }
  renderList();
}

function render() {
  $("screen-history").replaceChildren(
    el("div", { class: "screen-head" },
      el("h2", { text: "History" }),
      el("div", { class: "seg small", role: "group", "aria-label": "Show" },
        Object.entries(TYPES).map(([key, label]) =>
          el("button", {
            type: "button", class: type === key ? "active" : "", "aria-pressed": String(type === key), text: label,
            onclick: () => { if (type !== key) { type = key; shown = PAGE; render(); } },
          })))),
    el("div", { id: "h-filters" }),
    el("div", { id: "h-list" }),
    el("div", { id: "h-foot", class: "list-foot" })
  );
  mountFilterBar($("h-filters")); // the Dashboard's bar, moved here with its settings
  renderList();
}

const matching = () => (rows || []).filter((t) => (type === "all" || t.type === type) && matchesFilters(t));

function renderList() {
  const list = $("h-list");
  if (!list) return;
  const all = matching();
  const nodes = [];
  let lastDate = null;
  for (const t of all.slice(0, shown)) {
    if (t.occurred_on !== lastDate) {
      lastDate = t.occurred_on;
      nodes.push(el("h3", { class: "hist-date", text: friendlyDate(t.occurred_on) }));
    }
    nodes.push(row(t));
  }
  list.replaceChildren(...nodes);
  renderFoot(all.length);
}

function renderFoot(total) {
  const foot = $("h-foot");
  if (!foot) return;
  const filtered = total < (rows || []).filter((t) => type === "all" || t.type === type).length;
  if (error) foot.replaceChildren(error, " ", el("button", { type: "button", class: "link-btn", text: "Try again", onclick: showHistory }));
  else if (!rows) foot.replaceChildren("Loading…");
  else if (shown < total) {
    foot.replaceChildren(el("button", {
      type: "button", class: "btn secondary small", text: `Load more (${total - shown} left)`,
      onclick: () => { shown += PAGE; renderList(); },
    }));
  } else if (!total) {
    foot.replaceChildren(filtered ? "No entries match these filters."
      : type === "income" ? "No income logged yet." : type === "expense" ? "No expenses logged yet." : "Nothing logged yet. Tap Add to log your first entry.");
  } else foot.replaceChildren("That's everything.");
}

function row(t) {
  const income = t.type === "income";
  const kind = income ? byId(state.incomeSources, t.income_source_id) : byId(state.categories, t.category_id);
  const detail = [byId(state.subcategories, t.subcategory_id)?.name, t.description, memberName(t.who)]
    .filter(Boolean)
    .join(" · ");
  const other = t.currency === "USD" ? fmtMoney(t.amount_egp, "EGP") : fmtMoney(t.amount_usd, "USD", { code: true });
  return el("a", { class: `txn-row ${income ? "income" : "expense"}`, href: `#edit/${t.id}` },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: kind?.icon || "•" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: kind?.name || "Unknown" }),
      el("span", { class: "txn-sub", text: detail })),
    el("span", { class: "txn-amt" },
      (income ? "+" : "−") + fmtMoney(t.amount, t.currency, { code: true }),
      el("span", { class: "alt", text: `≈ ${other}` })));
}
