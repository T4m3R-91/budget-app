// Past entries, newest first, grouped by day. Tap one to edit or delete it.

import { state, byId, memberName } from "./state.js";
import { el, fmtMoney, friendlyDate, friendlyError } from "./ui.js";
import { fetchTransactionsPage } from "./db.js";

const PAGE = 50;
const FILTERS = { all: "All", expense: "Expenses", income: "Income" };

let filter = "all";
let items = [];
let done = false;
let loading = false;
let error = null;
let generation = 0; // ignores pages that arrive after the filter changed

const $ = (id) => document.getElementById(id);

export function showHistory() {
  generation++;
  items = [];
  done = false;
  loading = false;
  error = null;
  render();
  loadMore();
}

function render() {
  $("screen-history").replaceChildren(
    el("div", { class: "screen-head" },
      el("h2", { text: "History" }),
      el("div", { class: "seg small", role: "group", "aria-label": "Show" },
        Object.entries(FILTERS).map(([key, label]) =>
          el("button", {
            type: "button", class: filter === key ? "active" : "", "aria-pressed": String(filter === key), text: label,
            onclick: () => { if (filter !== key) { filter = key; showHistory(); } },
          })))),
    el("div", { id: "h-list" }),
    el("div", { id: "h-foot", class: "list-foot" })
  );
  renderList();
}

function renderList() {
  const list = $("h-list");
  if (!list) return;
  const nodes = [];
  let lastDate = null;
  for (const t of items) {
    if (t.occurred_on !== lastDate) {
      lastDate = t.occurred_on;
      nodes.push(el("h3", { class: "hist-date", text: friendlyDate(t.occurred_on) }));
    }
    nodes.push(row(t));
  }
  list.replaceChildren(...nodes);
  renderFoot();
}

function renderFoot() {
  const foot = $("h-foot");
  if (!foot) return;
  if (loading) foot.replaceChildren("Loading…");
  else if (error) foot.replaceChildren(error, " ", el("button", { type: "button", class: "link-btn", text: "Try again", onclick: loadMore }));
  else if (!done) foot.replaceChildren(el("button", { type: "button", class: "btn secondary small", text: "Load more", onclick: loadMore }));
  else if (!items.length) foot.replaceChildren(filter === "income" ? "No income logged yet." : filter === "expense" ? "No expenses logged yet." : "Nothing logged yet. Tap Add to log your first entry.");
  else foot.replaceChildren("That's everything.");
}

async function loadMore() {
  if (loading || done) return;
  const gen = generation;
  loading = true;
  error = null;
  renderFoot();
  try {
    const page = await fetchTransactionsPage(items.length, PAGE, filter);
    if (gen !== generation) return;
    items.push(...page);
    done = page.length < PAGE;
  } catch (e) {
    if (gen !== generation) return;
    error = friendlyError(e);
  }
  loading = false;
  renderList();
}

function row(t) {
  const income = t.type === "income";
  const kind = income ? byId(state.incomeSources, t.income_source_id) : byId(state.categories, t.category_id);
  const detail = [byId(state.subcategories, t.subcategory_id)?.name, t.description, memberName(t.who)]
    .filter(Boolean)
    .join(" · ");
  const other = t.currency === "USD" ? fmtMoney(t.amount_egp, "EGP") : fmtMoney(t.amount_usd, "USD");
  return el("a", { class: `txn-row ${income ? "income" : "expense"}`, href: `#edit/${t.id}` },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: kind?.icon || "•" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: kind?.name || "Unknown" }),
      el("span", { class: "txn-sub", text: detail })),
    el("span", { class: "txn-amt" },
      (income ? "+" : "−") + fmtMoney(t.amount, t.currency),
      el("span", { class: "alt", text: `≈ ${other}` })));
}
