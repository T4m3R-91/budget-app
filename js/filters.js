// The one filter bar (search, Category, Who, Payment, Dates, Clear), shared by the Dashboard and
// History: a single set of settings and a single bar, moved into whichever of the two is on
// screen, so a change made in either shows in both. Both apply it through matchesFilters().

import { state, byId } from "./state.js";
import { el, friendlyError, loadScript, loadStyle, toast, isoLocal, parseISODate } from "./ui.js";

export const FLATPICKR_JS = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js";
export const FLATPICKR_CSS = "https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const filters = { search: "", categories: new Set(), who: new Set(), payments: new Set(), from: "", to: "" };

const listeners = new Set();
export const onFiltersChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

let bar = null; // built once, then moved between the two screens
let picker = null; // the date-range calendar, created the first time Dates is opened
let used = { categories: new Set(), who: new Set(), payments: new Set() };

// Puts the bar into a screen. It's the same element every time, so nothing resets on the way.
export function mountFilterBar(slot) {
  if (!bar) bar = buildBar();
  slot.replaceChildren(bar);
}

// The menus offer only what the entries actually use. rows: transactions as loaded.
export function setFilterOptions(rows) {
  used = {
    categories: new Set(rows.map((t) => t.category_id).filter(Boolean)),
    who: new Set(rows.map((t) => t.who).filter(Boolean)),
    payments: new Set(rows.map((t) => t.payment_method_id).filter(Boolean)),
  };
  if (bar) buildMenus();
}

// Whether an entry passes the filters. Income has no category or payment method, so it only
// passes while no category or payment filter is set.
export function matchesFilters(t) {
  const f = filters;
  if ((f.from && t.occurred_on < f.from) || (f.to && t.occurred_on > f.to)) return false;
  if (f.who.size && !f.who.has(t.who)) return false;
  if (f.categories.size && !f.categories.has(t.category_id)) return false;
  if (f.payments.size && !f.payments.has(t.payment_method_id)) return false;
  const q = f.search.trim().toLowerCase();
  return !q || searchText(t).includes(q);
}

function searchText(t) {
  const words = t.type === "income"
    ? [byId(state.incomeSources, t.income_source_id)?.name, t.description]
    : [byId(state.categories, t.category_id)?.name, byId(state.subcategories, t.subcategory_id)?.name,
       t.description, byId(state.paymentMethods, t.payment_method_id)?.name];
  return words.filter(Boolean).join(" ").toLowerCase();
}

// ---------- the bar ----------

function buildBar() {
  const node = el("div", { class: "filter-bar" },
    el("div", { class: "toolbar" },
      el("input", {
        type: "search", id: "f-search", placeholder: "Search description, category…", "aria-label": "Search",
        value: filters.search,
        oninput: (e) => { filters.search = e.target.value; changed(); },
      }),
      el("div", { class: "ms-wrap", id: "f-ms-cat" }),
      el("div", { class: "ms-wrap", id: "f-ms-who" }),
      el("div", { class: "ms-wrap", id: "f-ms-pay" }),
      dateFilter(),
      el("button", { type: "button", class: "btn primary small clear-filters", "aria-label": "Clear filters", title: "Clear filters", onclick: clearFilters },
        trashIcon())));
  bar = node;
  buildMenus();
  paintDates();
  document.addEventListener("click", closeMenus);
  return node;
}

// A trash can, drawn like the tab bar icons (stroke only, in the button's text color).
function trashIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 7h16M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5");
  svg.append(path);
  return svg;
}

function clearFilters() {
  filters.search = "";
  filters.categories.clear();
  filters.who.clear();
  filters.payments.clear();
  bar.querySelector("#f-search").value = "";
  clearDates();
  buildMenus();
  changed();
}

// ---------- multi-select menus ----------

function closeMenus() {
  bar?.querySelectorAll(".ms-drop").forEach((d) => { d.hidden = true; });
}

function multiSelect(slot, label, options, selected) {
  const button = el("button", { type: "button", class: "ms-btn", "aria-haspopup": "true" });
  const paint = () => {
    button.textContent = selected.size ? `${label} (${selected.size})` : label;
    button.classList.toggle("active", selected.size > 0);
  };
  const drop = el("div", { class: "ms-drop", hidden: true, onclick: (e) => e.stopPropagation() },
    options.length
      ? options.map((o) =>
          el("label", { class: "ms-item" },
            el("input", {
              type: "checkbox", checked: selected.has(o.value),
              onchange: (e) => {
                if (e.target.checked) selected.add(o.value); else selected.delete(o.value);
                paint();
                changed();
              },
            }),
            o.label))
      : el("div", { class: "ms-item muted", text: "Nothing to filter yet" }));
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = drop.hidden;
    closeMenus();
    drop.hidden = !open;
  });
  paint();
  slot.replaceChildren(button, drop);
}

function buildMenus() {
  // Anything already selected stays listed, even if nothing uses it right now.
  const offer = (list, key, selected) => list.filter((x) => used[key].has(x.id ?? x.email) || selected.has(x.id ?? x.email));
  multiSelect(bar.querySelector("#f-ms-cat"), "Category",
    offer(state.categories, "categories", filters.categories).map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })),
    filters.categories);
  multiSelect(bar.querySelector("#f-ms-who"), "Who",
    offer(state.members, "who", filters.who).map((m) => ({ value: m.email, label: m.display_name })),
    filters.who);
  multiSelect(bar.querySelector("#f-ms-pay"), "Payment",
    offer(state.paymentMethods, "payments", filters.payments).map((p) => ({ value: p.id, label: p.name })),
    filters.payments);
}

// ---------- dates: one button, a calendar where you tap a start day then an end day ----------

function dateFilter() {
  return el("div", { class: "ms-wrap", id: "f-dates" },
    el("button", { type: "button", class: "ms-btn", id: "f-dates-btn", "aria-haspopup": "true", onclick: toggleDates }),
    el("div", { class: "ms-drop date-drop", id: "f-dates-drop", hidden: true, onclick: (e) => e.stopPropagation() },
      el("div", { id: "f-cal" }),
      el("div", { class: "date-foot" },
        el("span", { text: "Tap a start day, then an end day." }),
        el("button", { type: "button", class: "link-btn", text: "Clear", onclick: () => { clearDates(); changed(); } }))));
}

async function toggleDates(e) {
  e.stopPropagation();
  const drop = bar.querySelector("#f-dates-drop");
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
    picker = window.flatpickr(bar.querySelector("#f-cal"), {
      inline: true, mode: "range", disableMobile: true, // disableMobile: iPhone's own picker can't do ranges
      onChange: (dates) => {
        // One day picked = the start of the range; the second pick completes it.
        const [from = "", to = ""] = dates.map((d) => isoLocal(d));
        Object.assign(filters, { from, to });
        paintDates();
        changed();
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
  Object.assign(filters, { from: "", to: "" });
  picker?.clear(false);
  paintDates();
}

function paintDates() {
  const { from, to } = filters;
  const button = bar.querySelector("#f-dates-btn");
  button.textContent = from && to ? `${shortDate(from)} – ${shortDate(to)}` : from ? `From ${shortDate(from)}` : "Dates";
  button.classList.toggle("active", Boolean(from));
}

// "1 Aug", or "1 Aug 2025" outside the current year.
function shortDate(iso) {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}
