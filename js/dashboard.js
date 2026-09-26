// The dashboard from the earlier artifact, now reading live data: filters apply to every
// KPI, chart and the table; EGP/USD switches between each row's frozen converted amounts.

import { state, byId, memberName } from "./state.js";
import { el, fmtMoney, friendlyError, loadScript } from "./ui.js";
import { fetchAllTransactions } from "./db.js";

const CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COLOR = { spend: "#4f9dff", income: "#2bb67a", muted: "#8b97a4", line: "#2d3742", text: "#e6edf3" };
const TABLE_LIMIT = 300;

const view = {
  rows: [],
  currency: "EGP",
  filters: { search: "", categories: new Set(), who: new Set(), payments: new Set(), from: "", to: "" },
  sort: { key: "iso", dir: "desc" },
};
let trendChart = null;
let categoryChart = null;
let built = false;

const $ = (id) => document.getElementById(id);

export async function showDashboard() {
  if (!built) build();
  setStatus("Loading…");
  try {
    const [txns] = await Promise.all([fetchAllTransactions(), loadScript(CHART_JS)]);
    view.rows = txns.map(enrich);
    setStatus("");
    buildFilterMenus();
    renderAll();
  } catch (e) {
    setStatus(friendlyError(e));
  }
}

function setStatus(text) {
  $("d-status").textContent = text;
  $("d-status").hidden = !text;
}

function enrich(t) {
  const income = t.type === "income";
  return {
    id: t.id,
    type: t.type,
    iso: t.occurred_on,
    categoryId: t.category_id,
    category: income ? "" : byId(state.categories, t.category_id)?.name || "Unknown",
    subcategory: byId(state.subcategories, t.subcategory_id)?.name || "",
    source: income ? byId(state.incomeSources, t.income_source_id)?.name || "Unknown" : "",
    paymentId: t.payment_method_id,
    payment: byId(state.paymentMethods, t.payment_method_id)?.name || "",
    who: t.who,
    whoName: memberName(t.who),
    description: t.description || "",
    EGP: Number(t.amount_egp),
    USD: Number(t.amount_usd),
  };
}

const amount = (r) => r[view.currency];
const money = (n) => fmtMoney(n, view.currency, { decimals: 0 });

// ---------- layout ----------

function build() {
  built = true;
  const currencySeg = el("div", { id: "d-cur", class: "seg small", role: "group", "aria-label": "Show amounts in" });
  $("screen-dashboard").replaceChildren(
    el("div", { class: "dash-head" }, el("h2", { text: "Dashboard" }), currencySeg),
    el("p", { id: "d-status", class: "muted", hidden: true }),
    el("div", { class: "filter-bar" },
      el("div", { class: "toolbar" },
        el("input", {
          type: "search", id: "d-search", placeholder: "Search description, category…", "aria-label": "Search",
          oninput: (e) => { view.filters.search = e.target.value; renderAll(); },
        }),
        el("div", { class: "ms-wrap", id: "d-ms-cat" }),
        el("div", { class: "ms-wrap", id: "d-ms-who" }),
        el("div", { class: "ms-wrap", id: "d-ms-pay" }),
        el("label", { class: "dr" }, "From", el("input", {
          type: "date", id: "d-from", onchange: (e) => { view.filters.from = e.target.value; renderAll(); },
        })),
        el("label", { class: "dr" }, "To", el("input", {
          type: "date", id: "d-to", onchange: (e) => { view.filters.to = e.target.value; renderAll(); },
        })),
        el("button", { type: "button", class: "btn secondary small", text: "Clear", onclick: clearFilters }),
        el("span", { id: "d-count", class: "count" }))),
    el("div", { class: "kpis" },
      kpi("Total spend", "d-kpi-spend", "spend"),
      kpi("Total income", "d-kpi-income", "income"),
      kpi("Net", "d-kpi-net", "net")),
    el("div", { class: "chart-grid" },
      el("div", { class: "card" }, el("h3", { text: "Spend vs. income, by month" }),
        el("div", { class: "chart-box", id: "d-trend-box" }, el("canvas", { id: "d-trend", "aria-label": "Monthly spend and income chart", role: "img" }))),
      el("div", { class: "card" }, el("h3", { text: "Spend by category" }),
        el("div", { class: "chart-box", id: "d-cat-box" }, el("canvas", { id: "d-cat", "aria-label": "Spend by category chart", role: "img" })))),
    el("div", { class: "table-card" },
      el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", { id: "d-thead" })), el("tbody", { id: "d-tbody" }))),
      el("p", { id: "d-table-note", class: "table-note", hidden: true }))
  );
  renderCurrencySeg();
  buildTableHead();
  document.addEventListener("click", () => closeMenus());
}

function kpi(label, id, kind) {
  return el("div", { class: `kpi ${kind}` }, el("div", { class: "lbl", text: label }), el("div", { class: "num", id, text: "—" }));
}

function renderCurrencySeg() {
  $("d-cur").replaceChildren(...["EGP", "USD"].map((c) =>
    el("button", {
      type: "button", class: view.currency === c ? "active" : "", "aria-pressed": String(view.currency === c), text: c,
      onclick: () => { view.currency = c; renderCurrencySeg(); renderAll(); },
    })));
}

function clearFilters() {
  const f = view.filters;
  f.search = ""; f.from = ""; f.to = "";
  f.categories.clear(); f.who.clear(); f.payments.clear();
  $("d-search").value = ""; $("d-from").value = ""; $("d-to").value = "";
  buildFilterMenus();
  renderAll();
}

// ---------- multi-select filter menus ----------

function closeMenus() {
  document.querySelectorAll("#screen-dashboard .ms-drop").forEach((d) => { d.hidden = true; });
}

function multiSelect(containerId, label, options, selected) {
  const button = el("button", { type: "button", class: "ms-btn", "aria-haspopup": "true" });
  const drop = el("div", { class: "ms-drop", hidden: true, onclick: (e) => e.stopPropagation() },
    options.length
      ? options.map((o) =>
          el("label", { class: "ms-item" },
            el("input", {
              type: "checkbox", checked: selected.has(o.value),
              onchange: (e) => {
                if (e.target.checked) selected.add(o.value); else selected.delete(o.value);
                paint();
                renderAll();
              },
            }),
            o.label))
      : el("div", { class: "ms-item muted", text: "Nothing to filter yet" }));
  const paint = () => {
    button.textContent = selected.size ? `${label} (${selected.size})` : label;
    button.classList.toggle("active", selected.size > 0);
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = drop.hidden;
    closeMenus();
    drop.hidden = !open;
  });
  paint();
  $(containerId).replaceChildren(button, drop);
}

function buildFilterMenus() {
  const used = (key) => new Set(view.rows.map((r) => r[key]).filter(Boolean));
  const usedCats = used("categoryId");
  const usedPays = used("paymentId");
  const usedWho = used("who");
  multiSelect("d-ms-cat", "Category",
    state.categories.filter((c) => usedCats.has(c.id)).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })),
    view.filters.categories);
  multiSelect("d-ms-who", "Who",
    state.members.filter((m) => usedWho.has(m.email)).map((m) => ({ value: m.email, label: m.display_name })),
    view.filters.who);
  multiSelect("d-ms-pay", "Payment",
    state.paymentMethods.filter((p) => usedPays.has(p.id)).map((p) => ({ value: p.id, label: p.name })),
    view.filters.payments);
}

// ---------- filtering ----------

function inRange(r) {
  const { from, to } = view.filters;
  return (!from || r.iso >= from) && (!to || r.iso <= to);
}

function matches(r, ...fields) {
  const q = view.filters.search.trim().toLowerCase();
  return !q || fields.join(" ").toLowerCase().includes(q);
}

function filteredExpenses() {
  const f = view.filters;
  return view.rows.filter((r) =>
    r.type === "expense" && inRange(r) &&
    (!f.categories.size || f.categories.has(r.categoryId)) &&
    (!f.who.size || f.who.has(r.who)) &&
    (!f.payments.size || f.payments.has(r.paymentId)) &&
    matches(r, r.category, r.subcategory, r.description, r.payment));
}

// Category and payment filters describe spending, so they don't narrow income.
function filteredIncome() {
  const f = view.filters;
  return view.rows.filter((r) =>
    r.type === "income" && inRange(r) && (!f.who.size || f.who.has(r.who)) && matches(r, r.source, r.description));
}

// ---------- rendering ----------

function renderAll() {
  if (!window.Chart) return;
  const expenses = filteredExpenses();
  const income = filteredIncome();
  renderKpis(expenses, income);
  renderTrend(expenses, income);
  renderCategories(expenses);
  renderTable(expenses);
  $("d-count").textContent = `${expenses.length} expense${expenses.length === 1 ? "" : "s"} · ${income.length} income`;
}

function renderKpis(expenses, income) {
  const spend = expenses.reduce((s, r) => s + amount(r), 0);
  const inc = income.reduce((s, r) => s + amount(r), 0);
  const net = inc - spend;
  $("d-kpi-spend").textContent = money(spend);
  $("d-kpi-income").textContent = money(inc);
  const netEl = $("d-kpi-net");
  netEl.textContent = (net > 0 ? "+" : "") + money(net);
  netEl.className = "num " + (net >= 0 ? "pos" : "neg");
}

// Axis labels stay short ("E£12k", "$1.5k"); tooltips and KPIs show full figures.
function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${+(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(a / 1e3).toFixed(1)}k` : String(Math.round(a));
  return (v < 0 ? "−" : "") + (view.currency === "USD" ? "$" : "E£") + s;
}

function axisOptions() {
  return {
    x: { ticks: { color: COLOR.muted, maxRotation: 0 }, grid: { color: COLOR.line } },
    y: { beginAtZero: true, ticks: { color: COLOR.muted, maxTicksLimit: 6, callback: compact }, grid: { color: COLOR.line } },
  };
}

function emptyChart(boxId, canvasId, message) {
  const box = $(boxId);
  if (message) {
    box.replaceChildren(el("div", { class: "chart-empty", text: message }));
    return null;
  }
  if (!$(canvasId)) box.replaceChildren(el("canvas", { id: canvasId, role: "img" }));
  return $(canvasId);
}

function renderTrend(expenses, income) {
  const months = new Map();
  const bucket = (iso) => {
    const key = iso.slice(0, 7);
    if (!months.has(key)) {
      const [y, m] = key.split("-").map(Number);
      months.set(key, { label: `${MONTHS[m - 1]} ${y}`, spend: 0, income: 0 });
    }
    return months.get(key);
  };
  expenses.forEach((r) => { bucket(r.iso).spend += amount(r); });
  income.forEach((r) => { bucket(r.iso).income += amount(r); });
  const keys = [...months.keys()].sort();

  trendChart?.destroy();
  trendChart = null;
  const canvas = emptyChart("d-trend-box", "d-trend", keys.length ? "" : "No entries in this view yet.");
  if (!canvas) return;
  trendChart = new window.Chart(canvas, {
    type: "line",
    data: {
      labels: keys.map((k) => months.get(k).label),
      datasets: [
        { label: "Income", data: keys.map((k) => Math.round(months.get(k).income)), borderColor: COLOR.income, backgroundColor: COLOR.income + "26", fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2 },
        { label: "Spend", data: keys.map((k) => Math.round(months.get(k).spend)), borderColor: COLOR.spend, backgroundColor: COLOR.spend + "26", fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: COLOR.text, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } },
      },
      scales: axisOptions(),
    },
  });
}

function renderCategories(expenses) {
  const sums = new Map();
  expenses.forEach((r) => sums.set(r.category, (sums.get(r.category) || 0) + amount(r)));
  const entries = [...sums].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

  categoryChart?.destroy();
  categoryChart = null;
  const canvas = emptyChart("d-cat-box", "d-cat", entries.length ? "" : "No spending in this view yet.");
  if (!canvas) return;
  const scales = axisOptions();
  categoryChart = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => Math.round(e[1])), backgroundColor: COLOR.spend, borderRadius: 4, maxBarThickness: 22 }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.x) } } },
      scales: {
        x: { ...scales.y, ticks: { ...scales.y.ticks, maxTicksLimit: 5, maxRotation: 0 } },
        y: { ticks: { color: COLOR.text }, grid: { display: false } },
      },
    },
  });
}

// ---------- table ----------

const COLUMNS = [
  { key: "iso", label: "Date" },
  { key: "category", label: "Category" },
  { key: "subcategory", label: "Subcategory" },
  { key: "description", label: "Description" },
  { key: "amount", label: "Amount", numeric: true },
  { key: "whoName", label: "Who" },
  { key: "payment", label: "Payment" },
];

function buildTableHead() {
  $("d-thead").replaceChildren(...COLUMNS.map((c) =>
    el("th", {
      class: [c.numeric ? "amt" : "", view.sort.key === c.key ? `sorted-${view.sort.dir}` : ""].join(" "),
      scope: "col", text: c.label,
      onclick: () => {
        if (view.sort.key === c.key) view.sort.dir = view.sort.dir === "asc" ? "desc" : "asc";
        else Object.assign(view.sort, { key: c.key, dir: c.numeric || c.key === "iso" ? "desc" : "asc" });
        buildTableHead();
        renderTable(filteredExpenses());
      },
    })));
}

function renderTable(expenses) {
  const { key, dir } = view.sort;
  const value = (r) => (key === "amount" ? amount(r) : String(r[key] || "").toLowerCase());
  const sorted = expenses.slice().sort((a, b) => {
    const va = value(a), vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * (dir === "asc" ? 1 : -1);
  });
  const tbody = $("d-tbody");
  if (!sorted.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: COLUMNS.length, class: "muted", text: "No expenses match these filters." })));
  } else {
    tbody.replaceChildren(...sorted.slice(0, TABLE_LIMIT).map((r) =>
      el("tr", {},
        el("td", { text: r.iso }),
        el("td", { text: r.category }),
        el("td", { text: r.subcategory }),
        el("td", { text: r.description }),
        el("td", { class: "amt", text: fmtMoney(amount(r), view.currency) }),
        el("td", { text: r.whoName }),
        el("td", { text: r.payment }))));
  }
  const note = $("d-table-note");
  note.hidden = sorted.length <= TABLE_LIMIT;
  note.textContent = `Showing the first ${TABLE_LIMIT} of ${sorted.length}. Narrow the filters, or export to Excel for everything.`;
}
