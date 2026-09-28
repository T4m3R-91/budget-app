// The dashboard from the earlier artifact, now reading live data: filters apply to every
// KPI, chart and the table; EGP/USD switches between each row's frozen converted amounts.

import { state, byId, memberName } from "./state.js";
import { el, fmtMoney, friendlyError, loadScript, loadStyle, toast, isoLocal, parseISODate } from "./ui.js";
import { fetchAllTransactions } from "./db.js";

const CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
const FLATPICKR_JS = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js";
const FLATPICKR_CSS = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const COLOR = {}; // chart colors, read from the Day/Night theme's CSS tokens on each render
const TABLE_LIMIT = 300;
const RANGES = [["1m", "1M"], ["1y", "1Y"], ["max", "Max"]];
const EMPTY = { "1m": "No entries in the last 30 days.", "1y": "No entries in the past year.", max: "No entries in this view yet." };

const view = {
  rows: [],
  currency: "EGP",
  filters: { search: "", categories: new Set(), who: new Set(), payments: new Set(), from: "", to: "" },
  sort: { key: "iso", dir: "desc" },
  range: "max", // the trend chart's window; kept while the app is open
};
let trendChart = null;
let picker = null; // the date-range calendar, created the first time Dates is opened
let built = false;

const $ = (id) => document.getElementById(id);

export async function showDashboard() {
  if (!built) build();
  view.currency = state.displayCurrency; // the EGP/USD switch is shared with the Budget tab
  renderCurrencySeg();
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
const money = (n) => fmtMoney(n, view.currency, { decimals: 0, code: true }); // "USD 1,062", not "$1,062"

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
        dateFilter(),
        el("button", { type: "button", class: "btn secondary small", text: "Clear", onclick: clearFilters }))),
    el("div", { class: "kpis" },
      kpi("Total spend", "d-kpi-spend", "spend"),
      kpi("Total income", "d-kpi-income", "income"),
      kpi("Net", "d-kpi-net", "net")),
    el("div", { class: "chart-grid" },
      el("div", { class: "card" },
        el("div", { class: "card-head" },
          el("h3", { text: "Cash flow" }),
          el("div", { id: "d-range", class: "seg small", role: "group", "aria-label": "Chart range" })),
        el("div", { class: "chart-box", id: "d-trend-box" }, el("canvas", { id: "d-trend", "aria-label": "Cash flow chart: income, spend and cumulative net", role: "img" }))),
      el("div", { class: "card" }, el("h3", { text: "Spend by category" }),
        el("div", { class: "treemap", id: "d-cat-box", role: "group", "aria-label": "Spend by category" }),
        el("p", { id: "d-cat-detail", class: "tm-detail", "aria-live": "polite" }))),
    el("div", { class: "table-card" },
      el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", { id: "d-thead" })), el("tbody", { id: "d-tbody" }))),
      el("p", { id: "d-table-note", class: "table-note", hidden: true }))
  );
  renderCurrencySeg();
  renderRangeSeg();
  paintDates();
  buildTableHead();
  document.addEventListener("click", () => closeMenus());
  // Charts draw with the theme's colors, so redraw them if Auto flips Day/Night while they're on screen.
  window.addEventListener("themechange", () => { if (!$("screen-dashboard").hidden) renderAll(); });
  // Treemap tiles are laid out for the box's size: lay them out again when it changes.
  new ResizeObserver(() => paintTreemap()).observe($("d-cat-box"));
}

function kpi(label, id, kind) {
  return el("div", { class: `kpi ${kind}` }, el("div", { class: "lbl", text: label }), el("div", { class: "num", id, text: "—" }));
}

function renderCurrencySeg() {
  $("d-cur").replaceChildren(...["EGP", "USD"].map((c) =>
    el("button", {
      type: "button", class: view.currency === c ? "active" : "", "aria-pressed": String(view.currency === c), text: c,
      onclick: () => { view.currency = state.displayCurrency = c; renderCurrencySeg(); renderAll(); },
    })));
}

function renderRangeSeg() {
  $("d-range").replaceChildren(...RANGES.map(([key, label]) =>
    el("button", {
      type: "button", class: view.range === key ? "active" : "", "aria-pressed": String(view.range === key), text: label,
      onclick: () => { view.range = key; renderRangeSeg(); renderTrend(filteredExpenses(), filteredIncome()); },
    })));
}

function clearFilters() {
  const f = view.filters;
  f.search = "";
  f.categories.clear(); f.who.clear(); f.payments.clear();
  $("d-search").value = "";
  clearDates();
  buildFilterMenus();
  renderAll();
}

// ---------- date range: one button, a calendar where you tap a start day then an end day ----------

function dateFilter() {
  return el("div", { class: "ms-wrap", id: "d-dates" },
    el("button", { type: "button", class: "ms-btn", id: "d-dates-btn", "aria-haspopup": "true", onclick: toggleDates }),
    el("div", { class: "ms-drop date-drop", id: "d-dates-drop", hidden: true, onclick: (e) => e.stopPropagation() },
      el("div", { id: "d-cal" }),
      el("div", { class: "date-foot" },
        el("span", { text: "Tap a start day, then an end day." }),
        el("button", { type: "button", class: "link-btn", text: "Clear", onclick: () => { clearDates(); renderAll(); } }))));
}

async function toggleDates(e) {
  e.stopPropagation();
  const drop = $("d-dates-drop");
  const opening = drop.hidden;
  closeMenus();
  if (!opening) return;
  try {
    loadStyle(FLATPICKR_CSS);
    await loadScript(FLATPICKR_JS);
  } catch (err) {
    toast(friendlyError(err));
    return;
  }
  if (!picker) {
    picker = window.flatpickr($("d-cal"), {
      inline: true, mode: "range", disableMobile: true, // disableMobile: iPhone's own picker can't do ranges
      onChange: (dates) => {
        // One day picked = the start of the range; the second pick completes it.
        const [from = "", to = ""] = dates.map((d) => isoLocal(d));
        Object.assign(view.filters, { from, to });
        paintDates();
        renderAll();
        if (dates.length === 2) closeMenus();
      },
    });
  }
  drop.hidden = false;
  // Keep the calendar on screen when the button sits near the right edge.
  drop.style.left = "0px";
  const over = drop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
  if (over > 0) drop.style.left = `${-over}px`;
}

function clearDates() {
  Object.assign(view.filters, { from: "", to: "" });
  picker?.clear(false);
  paintDates();
}

function paintDates() {
  const { from, to } = view.filters;
  const button = $("d-dates-btn");
  button.textContent = from && to ? `${shortDate(from)} – ${shortDate(to)}` : from ? `From ${shortDate(from)}` : "Dates";
  button.classList.toggle("active", Boolean(from));
}

// "1 Aug", or "1 Aug 2025" outside the current year.
function shortDate(iso) {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`}`;
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
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  Object.assign(COLOR, { spend: token("--accent"), income: token("--income"), muted: token("--muted"), line: token("--line"), text: token("--text") });
  const expenses = filteredExpenses();
  const income = filteredIncome();
  renderKpis(expenses, income);
  renderTrend(expenses, income);
  renderCategories(expenses);
  renderTable(expenses);
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

// Axis labels stay short ("EGP 12k", "USD 1.5k"); tooltips and KPIs show full figures.
function compact(v) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${+(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(a / 1e3).toFixed(1)}k` : String(Math.round(a));
  return `${v < 0 ? "−" : ""}${view.currency} ${s}`;
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

// ---------- cash flow over time ----------

// Every day (1M, 1Y) or month (Max) gets a point, zero when nothing was logged, so points are
// evenly spaced in time. The date filter narrows the window further.
function trendSeries(expenses, income) {
  const all = expenses.concat(income);
  let keys, keyOf;
  if (view.range === "max") {
    if (!all.length) return null;
    const isos = all.map((r) => r.iso).sort();
    keys = monthsBetween(isos[0].slice(0, 7), isos.at(-1).slice(0, 7));
    keyOf = (r) => r.iso.slice(0, 7);
  } else {
    const start = new Date();
    if (view.range === "1m") start.setDate(start.getDate() - 29);
    else { start.setFullYear(start.getFullYear() - 1); start.setDate(start.getDate() + 1); }
    const { from, to } = view.filters;
    const first = [isoLocal(start), from].sort().at(-1);
    const last = to && to < isoLocal() ? to : isoLocal();
    if (first > last || !all.some((r) => r.iso >= first && r.iso <= last)) return null;
    keys = daysBetween(first, last);
    keyOf = (r) => r.iso;
  }
  const index = new Map(keys.map((k, i) => [k, i]));
  const spend = keys.map(() => 0);
  const inc = keys.map(() => 0);
  expenses.forEach((r) => { const i = index.get(keyOf(r)); if (i !== undefined) spend[i] += amount(r); });
  income.forEach((r) => { const i = index.get(keyOf(r)); if (i !== undefined) inc[i] += amount(r); });
  return { keys, spend, income: inc, daily: view.range !== "max" };
}

function daysBetween(first, last) {
  const out = [];
  for (const d = parseISODate(first); isoLocal(d) <= last; d.setDate(d.getDate() + 1)) out.push(isoLocal(d));
  return out;
}

function monthsBetween(first, last) {
  const out = [];
  for (let [y, m] = first.split("-").map(Number); ; m === 12 ? (y++, m = 1) : m++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) return out;
  }
}

// Axis labels. Up to ~2 months of days: a grid line every day, a date every few days.
// Longer runs of days: a line and label at each month. Months: each month, or each year past 2 years.
// When months are too tight to all be labeled, labels fall on Jan, Mar, May… (or Jan, Apr, Jul…),
// so January, shown as the year, always gets one.
// Returning null hides a tick and its grid line; "" keeps the line without a label.
function tickFor({ keys, daily }) {
  const monthName = (m, y) => (m === 1 ? String(y) : MONTHS[m - 1]);
  const every = (count, width, px) => Math.max(1, Math.ceil(px / (width / count)));
  const monthLabel = (key, step) => {
    const [y, m] = key.split("-").map(Number);
    return (m - 1) % (step > 6 ? 12 : step > 4 ? 6 : step) ? "" : monthName(m, y);
  };
  if (daily && keys.length <= 62) {
    return (i, width) => {
      if ((keys.length - 1 - i) % every(keys.length, width, 44)) return "";
      const d = parseISODate(keys[i]);
      return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    };
  }
  if (daily) {
    const starts = keys.map((k, i) => (k.endsWith("-01") ? i : -1)).filter((i) => i >= 0);
    return (i, width) => (starts.includes(i) ? monthLabel(keys[i], every(starts.length, width, 34)) : null);
  }
  if (keys.length > 24) return (i) => (keys[i].endsWith("-01") ? keys[i].slice(0, 4) : null);
  return (i, width) => monthLabel(keys[i], every(keys.length, width, 34));
}

function periodTitle(key) {
  if (key.length === 7) return `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
  return parseISODate(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function renderTrend(expenses, income) {
  const s = trendSeries(expenses, income);
  trendChart?.destroy();
  trendChart = null;
  const canvas = emptyChart("d-trend-box", "d-trend", s ? "" : EMPTY[view.range]);
  if (!canvas) return;

  // Cash flow: income as bars up, spend as bars down (one pair per day or month), and a line
  // for the cumulative net since the start of the range. The line is the net of what's logged,
  // not a bank balance.
  const tick = tickFor(s);
  const n = s.keys.length;
  const inflow = s.income.map(Math.round);
  const outflow = s.spend.map(Math.round);
  let running = 0;
  const cumulative = inflow.map((v, i) => (running += v - outflow[i]));
  const signed = (v) => (v > 0 ? "+" : "") + money(v);
  const bars = (label, data, color) => ({
    type: "bar", label, data, backgroundColor: color, order: 1,
    barPercentage: n > 60 ? 1 : 0.8, categoryPercentage: n > 60 ? 1 : 0.8, borderRadius: n > 60 ? 0 : 3,
  });
  const scales = axisOptions();
  trendChart = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels: s.keys,
      datasets: [
        {
          type: "line", label: "Cumulative net", data: cumulative, order: 0, // drawn over the bars
          borderColor: COLOR.text, backgroundColor: COLOR.text, borderWidth: n > 100 ? 1.5 : 2, tension: 0,
          pointRadius: n > 12 ? 0 : 3, pointHoverRadius: 4, // dots only for a few months; tapping shows the rest
        },
        bars("Income", inflow, COLOR.income),
        bars("Spend", outflow.map((v) => -v), COLOR.spend),
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: COLOR.text, boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          callbacks: {
            title: (items) => periodTitle(s.keys[items[0].dataIndex]),
            label: (c) => (c.dataset.type === "line"
              ? `${c.dataset.label}: ${signed(c.parsed.y)}`
              : `${c.dataset.label}: ${money(Math.abs(c.parsed.y))}`),
            // Max (one point per month) also shows that month's own net; days don't need it.
            footer: (items) => { const i = items[0].dataIndex; return s.daily ? [] : `Net this month: ${signed(inflow[i] - outflow[i])}`; },
          },
        },
      },
      scales: {
        x: {
          stacked: true, // income and spend share one slot: one up, one down
          grid: { color: COLOR.line },
          ticks: {
            color: COLOR.muted, maxRotation: 0, autoSkip: false,
            callback(value, i) { return tick(i, this.width || this.chart.width); },
          },
        },
        y: {
          ...scales.y, stacked: true,
          grid: { color: (c) => (c.tick?.value === 0 ? COLOR.muted : COLOR.line) }, // a firmer zero line
        },
      },
    },
  });
}

// ---------- spend by category: a treemap of the top 4 categories plus "Other" ----------

// Tile areas are shares of spend. Each tile shows as much as fits (name, amount, %); tapping
// one spells out its figures underneath, and "Other" lists what it groups.
function renderCategories(expenses) {
  const byCategory = new Map();
  for (const r of expenses) {
    const t = byCategory.get(r.categoryId) ||
      { key: r.categoryId, name: r.category, icon: byId(state.categories, r.categoryId)?.icon || "📦", amount: 0 };
    t.amount += amount(r);
    byCategory.set(r.categoryId, t);
  }
  const all = [...byCategory.values()].filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount);
  const rest = all.slice(4);
  const tiles = all.length > 5
    ? [...all.slice(0, 4), { key: "other", name: "Other", icon: "", amount: rest.reduce((s, t) => s + t.amount, 0), parts: rest }]
    : all;
  treemap.ready = true;
  treemap.tiles = tiles;
  treemap.total = all.reduce((s, t) => s + t.amount, 0);
  if (!tiles.some((t) => t.key === treemap.picked)) treemap.picked = null;
  paintTreemap();
}

const treemap = { ready: false, tiles: [], total: 0, picked: null };

function paintTreemap() {
  if (!treemap.ready) return; // data still loading
  const box = $("d-cat-box");
  const { tiles, total } = treemap;
  if (!tiles.length) {
    box.replaceChildren(el("div", { class: "chart-empty", text: "No spending in this view yet." }));
    $("d-cat-detail").replaceChildren();
    return;
  }
  const W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return; // hidden; the size observer paints once it's on screen
  const rects = squarify(tiles.map((t) => t.amount), W, H);
  // The top category is exactly the Cash flow chart's spend blue. Every other tile (Other too)
  // gets that blue in proportion to its amount compared with the top one (Food at 18% of Housing
  // is an 18% blue), blended toward a pale blue so the dark text stays readable. 5% at least,
  // so even the smallest tile keeps a hint of blue.
  const top = tiles[0].amount;
  const mix = (t) => `${Math.min(100, Math.max(5, (t.amount / top) * 100)).toFixed(1)}%`;
  box.replaceChildren(...tiles.map((t, i) => {
    const { x, y, w, h } = rects[i];
    // What fits (lines are ~16px, padding 18px across / 18px down): name + amount + %, name + %,
    // icon + %, just %, or nothing (tapping still works).
    const amountWidth = money(t.amount).length * 7 + 18;
    const fit = w >= Math.max(80, amountWidth) && h >= 66 ? "full" : w >= 72 && h >= 50 ? "mid"
      : w >= 30 && h >= 44 && t.icon ? "icon" : w >= 30 && h >= 22 ? "pct" : "none";
    return el("button", {
      type: "button", class: `tm-tile fit-${fit}${i === 0 && !t.parts ? " top" : ""}${treemap.picked === t.key ? " picked" : ""}`,
      style: `left:${(x / W) * 100}%;top:${(y / H) * 100}%;width:${(w / W) * 100}%;height:${(h / H) * 100}%;--mix:${mix(t)}`,
      title: tileSummary(t), "aria-label": tileSummary(t),
      onclick: () => { treemap.picked = treemap.picked === t.key ? null : t.key; paintTreemap(); },
    },
      el("span", { class: "tm-ico", "aria-hidden": "true", text: t.icon }),
      el("span", { class: "tm-name", text: `${t.icon} ${t.name}`.trim() }),
      el("span", { class: "tm-amt", text: money(t.amount) }),
      el("span", { class: "tm-pct", text: share(t.amount, total) }));
  }));

  const picked = tiles.find((t) => t.key === treemap.picked);
  $("d-cat-detail").replaceChildren(picked
    ? el("span", {}, el("strong", { text: tileSummary(picked) }),
        picked.parts ? `: ${picked.parts.map((p) => `${p.icon} ${p.name} ${money(p.amount)} (${share(p.amount, total)})`).join(" · ")}` : "")
    : el("span", { class: "muted", text: "Tap a tile for its figures." }));
}

const share = (part, total) => { const p = (part / total) * 100; return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`; };
const tileSummary = (t) => `${`${t.icon} ${t.name}`.trim()} · ${money(t.amount)} · ${share(t.amount, treemap.total)}`;

// Squarified treemap (Bruls, Huizing & van Wijk): fills the box row by row, adding a tile to
// the current row only while that keeps the row's tiles closer to square.
function squarify(values, W, H) {
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const areas = values.map((v) => (v / sum(values)) * W * H);
  const rects = [];
  let x = 0, y = 0, w = W, h = H, row = [];
  const worst = (list, side) => {
    const s = sum(list);
    return Math.max(...list.map((a) => Math.max((side * side * a) / (s * s), (s * s) / (side * side * a))));
  };
  const place = (list) => {
    const s = sum(list);
    if (w >= h) { // a column down the left
      const cw = s / h;
      let yy = y;
      for (const a of list) { rects.push({ x, y: yy, w: cw, h: a / cw }); yy += a / cw; }
      x += cw; w -= cw;
    } else { // a row across the top
      const rh = s / w;
      let xx = x;
      for (const a of list) { rects.push({ x: xx, y, w: a / rh, h: rh }); xx += a / rh; }
      y += rh; h -= rh;
    }
  };
  for (let i = 0; i < areas.length;) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, areas[i]], side) <= worst(row, side)) row.push(areas[i++]);
    else { place(row); row = []; }
  }
  if (row.length) place(row);
  return rects;
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
        el("td", { class: "amt", text: fmtMoney(amount(r), view.currency, { code: true }) }),
        el("td", { text: r.whoName }),
        el("td", { text: r.payment }))));
  }
  const note = $("d-table-note");
  note.hidden = sorted.length <= TABLE_LIMIT;
  note.textContent = `Showing the first ${TABLE_LIMIT} of ${sorted.length}. Narrow the filters, or use Download Excel in Profile for everything.`;
}
