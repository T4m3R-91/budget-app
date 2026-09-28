// The Add / Edit screen: amount + category are the only required inputs; everything else
// is defaulted (date today, EGP, you, last payment method, live rate) and editable.

import { state, byId, subcategoriesOf } from "./state.js";
import { el, toast, fmtMoney, fmtRate, isoLocal, friendlyDate, relativeDay, friendlyError, partOfDay } from "./ui.js";
import { parseAmount, parseRate, round2, round4 } from "./numbers.js";
import { getLiveRate } from "./fx.js";
import { insertTransaction, updateTransaction, deleteTransaction, latestEntryRate, fetchTransaction } from "./db.js";
import { scanReceipt } from "./receipt.js";
import { monthStatus, monthOf } from "./budget.js";

const $ = (id) => document.getElementById(id);
const screen = () => $("screen-add");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Required fields that Save can point at when they're missing.
const FIELDS = { amount: "e-amount-box", grid: "e-grid", rate: "e-rate" };

let f = null; // form state
let commitRateEdit = null; // set while the rate field is open, so Save can apply it

// ---------- form state ----------

function lastPaymentKey() {
  return "lastPayment:" + state.me.email;
}

function rememberedPayment() {
  let id = null;
  try { id = localStorage.getItem(lastPaymentKey()); } catch { /* storage unavailable */ }
  const pm = byId(state.paymentMethods, id);
  if (pm && !pm.hidden) return pm.id;
  return state.paymentMethods.find((p) => !p.hidden)?.id || null;
}

function freshForm(type = "expense") {
  return {
    mode: "add", id: null, original: null,
    type, amountText: "", currency: "EGP",
    rate: null, rateSource: null, rateNote: "", rateLoading: false, editingRate: false,
    categoryId: null, subcategoryId: null, sourceId: null,
    paymentMethodId: rememberedPayment(), who: state.me.email,
    date: isoLocal(), description: "",
    saving: false, confirmDelete: false,
  };
}

export function showAdd() {
  // Keep a half-filled entry when hopping between tabs; start fresh after an edit.
  if (!f || f.mode !== "add") f = freshForm();
  if (f.date < isoLocal() && !f.amountText) f.date = isoLocal(); // stale "today" from yesterday
  render();
  if (!["edited", "manual"].includes(f.rateSource)) ensureRate();
  loadBudgetTiles();
}

// ---------- budget fills on category tiles ----------

// For the month of the entry's date: { month, budget, spent } from budget.js, or null when that
// month has no budget. Tiles of budgeted categories fill with the share used; others stay plain.
let budgetTiles = null;

async function loadBudgetTiles() {
  if (!f || f.mode !== "add") return;
  const month = monthOf(f.date);
  const status = await monthStatus(month);
  if (!f || f.mode !== "add" || monthOf(f.date) !== month) return; // moved on meanwhile
  budgetTiles = status;
  if (f.type === "expense") renderGrid();
}

// { used, text, over } for a category tile, or null when it has no budget this month.
function tileBudget(categoryId) {
  if (f.mode !== "add" || f.type !== "expense" || budgetTiles?.month !== monthOf(f.date)) return null;
  const budget = budgetTiles.budget.get(categoryId);
  if (!budget) return null;
  const spent = budgetTiles.spent.get(categoryId) || 0;
  // Budgets are EGP. With the entry in USD, show the USD equivalent, marked ≈ as in History:
  // what's left at the rate on screen; an overflow as that share of the category's saved USD
  // spending, the same figure the Budget tab shows.
  const inUsd = f.currency === "USD" && f.rate > 0;
  const egp = (n) => fmtMoney(n, "EGP", { decimals: 0 });
  const usd = (n) => `≈ ${fmtMoney(n, "USD", { decimals: 0, code: true })}`;
  if (spent > budget) {
    const overUsd = ((spent - budget) / spent) * (budgetTiles.spentUsd.get(categoryId) || 0);
    return { used: 100, over: true, text: `${inUsd ? usd(overUsd) : egp(spent - budget)} over` };
  }
  return { used: (spent / budget) * 100, over: false, text: `${inUsd ? usd((budget - spent) / f.rate) : egp(budget - spent)} left` };
}

export async function showEdit(id) {
  f = null;
  screen().replaceChildren(el("p", { class: "muted", text: "Loading…" }));
  let t = null;
  try {
    t = await fetchTransaction(id);
  } catch (e) {
    toast(friendlyError(e));
  }
  if (!t) {
    location.hash = "#history";
    return;
  }
  f = {
    ...freshForm(t.type),
    mode: "edit", id: t.id, original: t,
    amountText: String(Number(t.amount)), currency: t.currency,
    rate: Number(t.rate), rateSource: "saved", rateNote: "saved",
    categoryId: t.category_id, subcategoryId: t.subcategory_id, sourceId: t.income_source_id,
    paymentMethodId: t.payment_method_id, who: t.who, date: t.occurred_on,
    description: t.description || "",
  };
  render();
}

// ---------- exchange rate ----------

async function ensureRate({ force = false } = {}) {
  const form = f;
  if (!form || form.mode !== "add") return;
  const userSet = () => form.rateSource === "edited" || form.rateSource === "manual";
  form.rateLoading = true;
  renderRate();

  const live = navigator.onLine ? await getLiveRate({ force }) : null;
  if (form !== f || userSet()) return;

  if (live) {
    Object.assign(form, { rate: live.rate, rateSource: "live", rateNote: `live, ${relativeDay(isoLocal(live.asOf))}` });
  } else {
    let last = null;
    try { last = await latestEntryRate(); } catch { /* offline too */ }
    if (form !== f || userSet()) return;
    if (last) {
      Object.assign(form, {
        rate: Number(last.rate), rateSource: "last_entry",
        rateNote: `last entry's (${relativeDay(last.occurred_on)}), live rate unavailable`,
      });
    } else if (!form.rate) {
      Object.assign(form, { rateSource: null, rateNote: "live rate unavailable" });
    }
  }
  form.rateLoading = false;
  renderRate();
  renderConverted();
  if (form.currency === "USD") renderGrid(); // USD budget figures use this rate
}

// ---------- rendering ----------

const GREETING = { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening", night: "Good night" };

function render() {
  const r = screen();
  const income = f.type === "income";
  commitRateEdit = null;
  r.classList.toggle("income-mode", income);

  const head =
    f.mode === "edit"
      ? el("div", { class: "entry-head" },
          el("a", { class: "link-btn", href: "#history", text: "Cancel" }),
          el("h2", { text: income ? "Edit income" : "Edit expense" }),
          el("span"))
      : el("div", { class: "entry-head centered" }, typeSeg());
  const greeting = f.mode === "add"
    ? el("div", { class: "greeting" }, el("p", { text: GREETING[partOfDay()] }), el("h2", { text: state.me.display_name }))
    : null;

  // The amount box shows the result of the currency row above it: unit beside the number,
  // and the converted value underneath.
  const amountBox = el("label", { id: "e-amount-box", class: "amount-box" },
    el("span", { class: "amount-main" },
      el("input", {
        id: "e-amount", class: "amount-input", type: "text", inputmode: "decimal",
        autocomplete: "off", enterkeyhint: "done", placeholder: "0", "aria-label": "Amount",
        value: f.amountText,
        oninput: (e) => {
          f.amountText = e.target.value;
          renderConverted();
        },
      }),
      el("span", { id: "e-amount-cur", class: "amount-cur" })),
    el("span", { id: "e-converted", class: "converted", "aria-live": "polite" }));

  const amountRow = f.mode === "add"
    ? el("div", { class: "amount-row" },
        amountBox,
        el("span", { class: "or", text: "or" }),
        el("button", { type: "button", class: "btn secondary scan-btn", "aria-label": "Scan a receipt", onclick: pickPhoto },
          el("span", { "aria-hidden": "true", text: "📷 " }), "Scan"))
    : el("div", { class: "amount-row solo" }, amountBox);

  const save = el("button", { id: "e-save", type: "button", class: "btn primary", onclick: save_ });
  const actions = f.mode === "edit"
    ? el("div", { class: "actions two" },
        el("button", { id: "e-delete", type: "button", class: "btn danger", text: "Delete", onclick: onDelete }), save)
    : el("div", { class: "actions" }, save);

  r.replaceChildren(...[
    greeting,
    head,
    el("div", { class: "cur-row" },
      el("div", { id: "e-cur-seg", class: "seg small", role: "group", "aria-label": "Currency" }),
      el("div", { id: "e-rate", class: "rate-box" })),
    amountRow,
    el("div", { id: "e-grid", class: "cat-grid", role: "group", "aria-label": income ? "Source" : "Category" }),
    el("div", { id: "e-subs", class: "subchips", role: "group", "aria-label": "Subcategory" }),
    el("div", { id: "e-meta", class: "meta-grid" }),
    el("textarea", {
      id: "e-desc", class: "text-input note-input", rows: 3, maxlength: 200,
      placeholder: income ? "Note (optional)" : "Note (optional), e.g. Negmet Heliopolis",
      "aria-label": "Note", value: f.description,
      oninput: (e) => { f.description = e.target.value; },
    }),
    el("div", { class: "action-bar" }, actions),
  ].filter(Boolean));

  renderCurrency();
  renderRate();
  renderConverted();
  renderGrid();
  renderSubs();
  renderMeta();
  renderSaveButton();
}

function typeSeg() {
  return el("div", { class: "seg type-seg", role: "group", "aria-label": "Entry type" },
    ["expense", "income"].map((t) =>
      el("button", {
        type: "button",
        class: [f.type === t ? "active" : "", t === "income" ? "is-income" : ""].join(" "),
        "aria-pressed": String(f.type === t),
        text: t === "expense" ? "Expense" : "Income",
        onclick: () => { if (f.type !== t) { f.type = t; render(); } },
      })));
}

function setCurrency(c) {
  f.currency = c;
  renderCurrency();
  renderConverted();
  renderGrid(); // budget tiles show what's left in the entry's currency
}

function renderCurrency() {
  $("e-amount-cur").textContent = f.currency;
  $("e-cur-seg").replaceChildren(...["EGP", "USD"].map((c) =>
    el("button", {
      type: "button", class: f.currency === c ? "active" : "", "aria-pressed": String(f.currency === c),
      text: c, onclick: () => setCurrency(c),
    })));
}

function renderRate() {
  const box = $("e-rate");
  if (!box) return;
  commitRateEdit = null;

  if (f.editingRate) {
    const input = el("input", {
      class: "text-input rate-input", type: "text", inputmode: "decimal", enterkeyhint: "done",
      "aria-label": "EGP per 1 US dollar", value: f.rate ? String(f.rate) : "",
    });
    commitRateEdit = () => {
      const v = parseRate(input.value);
      if (v) {
        const hadRate = f.rate > 0;
        f.rate = v;
        f.rateSource = f.mode === "edit" || hadRate ? "edited" : "manual";
        f.rateNote = "set by you";
      }
      f.editingRate = false;
      commitRateEdit = null;
    };
    const done = () => { commitRateEdit(); renderRate(); renderConverted(); renderGrid(); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); });
    box.replaceChildren(
      el("span", { class: "rate-line", text: "1 USD =" }), input, el("span", { class: "rate-line", text: "EGP" }),
      el("button", { type: "button", class: "link-btn", text: "Done", onclick: done }));
    input.focus();
    input.select();
    return;
  }

  const warn = !f.rateLoading && (!f.rate || f.rateSource === "last_entry");
  let line = f.rate ? `1 USD = ${fmtRate(f.rate)} EGP` : f.rateLoading ? "Getting today's rate…" : "No rate yet";
  if (f.rateNote && !(f.rateLoading && !f.rate)) line += ` · ${f.rateNote}`;

  const parts = [
    el("span", { class: "rate-line" + (warn ? " warn" : ""), text: line }),
    el("button", {
      type: "button", class: "link-btn", text: f.rate ? "Edit" : "Enter rate",
      onclick: () => { f.editingRate = true; renderRate(); },
    }),
  ];
  if (f.mode === "add" && ["edited", "manual", "last_entry"].includes(f.rateSource)) {
    parts.push(el("button", {
      type: "button", class: "link-btn", text: "Use live",
      onclick: () => { f.rateSource = null; f.rateNote = ""; ensureRate({ force: true }); },
    }));
  }
  box.replaceChildren(...parts);
}

function renderConverted() {
  const box = $("e-converted");
  if (!box) return;
  const amt = parseAmount(f.amountText);
  if (amt == null || !(f.rate > 0)) {
    box.textContent = "";
    return;
  }
  box.textContent =
    f.currency === "USD"
      ? `≈ ${fmtMoney(round2(amt * f.rate), "EGP")}`
      : `≈ ${fmtMoney(round2(amt / f.rate), "USD")}`;
}

function renderGrid() {
  const isIncome = f.type === "income";
  const selected = isIncome ? f.sourceId : f.categoryId;
  const items = (isIncome ? state.incomeSources : state.categories).filter((x) => !x.hidden || x.id === selected);
  const grid = $("e-grid");
  if (!items.length) {
    grid.replaceChildren(el("p", {
      class: "empty-note",
      text: isIncome ? "No income sources yet. Add some in Profile → Settings." : "No categories yet. Add some in Profile → Settings.",
    }));
    return;
  }
  grid.replaceChildren(...items.map((x) => {
    const b = isIncome ? null : tileBudget(x.id);
    return el("button", {
      type: "button", "aria-pressed": String(x.id === selected),
      class: "cat-btn" + (x.id === selected ? " sel" : "") + (b ? " budgeted" : "") + (b?.over ? " over" : ""),
      style: b ? `--used:${b.used.toFixed(1)}%` : null,
      "aria-label": b ? `${x.name}, ${b.text} this month` : null,
      onclick: () => pick(x.id),
    },
      el("span", { class: "ico", "aria-hidden": "true", text: x.icon }),
      el("span", { class: "nm", text: x.name }),
      b ? el("span", { class: "left", text: b.text }) : null);
  }));
}

function pick(id) {
  if (f.type === "income") {
    f.sourceId = id;
  } else {
    if (f.categoryId !== id) f.subcategoryId = null;
    f.categoryId = id;
    renderSubs();
  }
  renderGrid();
}

// Subcategory chips appear only once a category with subcategories is picked (expenses only).
function renderSubs() {
  const box = $("e-subs");
  if (!box) return;
  const category = f.type === "expense" ? byId(state.categories, f.categoryId) : null;
  const subs = category ? subcategoriesOf(category.id).filter((s) => !s.hidden || s.id === f.subcategoryId) : [];
  box.hidden = !subs.length;
  if (!subs.length) return;
  box.replaceChildren(
    el("span", { class: "sub-lead", text: `${category.name} ›` }),
    ...subs.map((s) =>
      el("button", {
        type: "button", class: "subchip" + (s.id === f.subcategoryId ? " sel" : ""),
        "aria-pressed": String(s.id === f.subcategoryId), text: s.name,
        onclick: () => { f.subcategoryId = f.subcategoryId === s.id ? null : s.id; renderSubs(); },
      })));
}

function metaTile(label, value, control) {
  return el("label", { class: "meta-tile" },
    el("span", { class: "k", text: label }), el("span", { class: "v", text: value }), control);
}

function selectControl(ariaLabel, options, value, onChange) {
  return el("select", { "aria-label": ariaLabel, onchange: (e) => onChange(e.target.value) },
    options.map((o) => el("option", { value: o.value, text: o.label, selected: o.value === value })));
}

// By · On · With (income: By · On), laid out on the same 3-column grid as the categories.
function renderMeta() {
  const income = f.type === "income";
  const people = state.members.map((m) => ({
    value: m.email, label: m.email === state.me.email ? `${m.display_name} (you)` : m.display_name,
  }));
  const tiles = [
    metaTile("By", people.find((p) => p.value === f.who)?.label ?? "—",
      selectControl(income ? "Received by" : "Paid by", people, f.who, (v) => { f.who = v; renderMeta(); })),
    metaTile("On", friendlyDate(f.date),
      el("input", {
        type: "date", "aria-label": "Date", value: f.date,
        onchange: (e) => {
          if (!e.target.value) return;
          const monthChanged = monthOf(e.target.value) !== monthOf(f.date);
          f.date = e.target.value;
          renderMeta();
          if (monthChanged) { renderGrid(); loadBudgetTiles(); } // the tiles show that month's budget
        },
        // With a mouse, a click on the (invisible) field doesn't open the calendar by itself.
        onclick: (e) => {
          if (!window.matchMedia("(pointer: fine)").matches) return;
          try { e.currentTarget.showPicker(); } catch { /* older browsers: the field still takes typing */ }
        },
      })),
  ];
  if (!income) {
    const payments = [{ value: "", label: "Not set" }, ...state.paymentMethods
      .filter((p) => !p.hidden || p.id === f.paymentMethodId)
      .map((p) => ({ value: p.id, label: p.name }))];
    const current = f.paymentMethodId ?? "";
    tiles.push(metaTile("With", payments.find((p) => p.value === current)?.label ?? "Not set",
      selectControl("Paid with", payments, current, (v) => { f.paymentMethodId = v || null; renderMeta(); })));
  }
  $("e-meta").replaceChildren(...tiles);
}

function renderSaveButton() {
  const button = $("e-save");
  if (!button) return;
  button.disabled = f.saving;
  button.textContent = f.saving ? "Saving…" : f.mode === "edit" ? "Save changes" : f.type === "income" ? "Save income" : "Save expense";
}

// ---------- missing required fields ----------

function missingFields() {
  const missing = [];
  if (parseAmount(f.amountText) == null) missing.push("amount");
  if (f.type === "expense" ? !f.categoryId : !f.sourceId) missing.push("grid");
  if (!(f.rate > 0) && !f.rateLoading) missing.push("rate");
  return missing;
}

// Shakes and glows each missing field, and takes you to the first one.
function flag(missing) {
  for (const name of missing) {
    const node = $(FIELDS[name]);
    node.classList.remove("flag");
    void node.offsetWidth; // restart the animation on repeated taps
    node.classList.add("flag");
    // Two animations run (shake, then the longer glow); clear only when the glow is done.
    const done = (e) => {
      if (e.animationName !== "glow") return;
      node.classList.remove("flag");
      node.removeEventListener("animationend", done);
    };
    node.addEventListener("animationend", done);
  }
  const first = missing[0];
  $(FIELDS[first]).scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  if (first === "amount") $("e-amount").focus({ preventScroll: true });
  if (first === "rate") { f.editingRate = true; renderRate(); }
}

// ---------- save / delete / undo ----------

function nameOf(t) {
  return t.type === "income" ? byId(state.incomeSources, t.income_source_id)?.name : byId(state.categories, t.category_id)?.name;
}

async function save_() {
  if (f.saving) return;
  if (commitRateEdit) {
    commitRateEdit();
    renderRate();
    renderConverted();
  }
  const missing = missingFields();
  if (missing.length) {
    flag(missing);
    if (!navigator.onLine) toast("You're offline. Connect to the internet to save.");
    return;
  }
  if (f.rateLoading && !(f.rate > 0)) return toast("Getting today's exchange rate. Try again in a moment.");
  if (!navigator.onLine) return toast("You're offline. Connect to the internet to save.");

  const form = f;
  const expense = form.type === "expense";
  const row = {
    type: form.type,
    occurred_on: form.date,
    amount: parseAmount(form.amountText),
    currency: form.currency,
    rate: round4(form.rate),
    rate_source: form.rateSource === "saved" ? form.original.rate_source : form.rateSource || "manual",
    category_id: expense ? form.categoryId : null,
    subcategory_id: expense ? form.subcategoryId : null,
    income_source_id: expense ? null : form.sourceId,
    payment_method_id: expense ? form.paymentMethodId : null,
    who: form.who,
    description: form.description.trim() || null,
  };

  form.saving = true;
  renderSaveButton();
  try {
    if (form.mode === "edit") {
      await updateTransaction(form.id, row);
      f = null;
      toast("Changes saved");
      location.hash = "#history";
      return;
    }
    const saved = await insertTransaction(row);
    if (row.payment_method_id) {
      try { localStorage.setItem(lastPaymentKey(), row.payment_method_id); } catch { /* storage unavailable */ }
    }
    // Points are scored by the database; `points` is absent until points-migration.sql has run.
    const earned = Number.isInteger(saved.points) ? saved.points : null;
    toast(`Saved ${nameOf(saved) || ""} · ${fmtMoney(saved.amount, saved.currency, { code: true })}${earned ? ` · +${earned} pts` : ""}`, {
      label: "Undo",
      run: () => undo(saved.id, earned),
    });
    // Count it on its category tile right away; the refetch below catches anyone else's entries.
    if (expense && budgetTiles?.month === monthOf(row.occurred_on)) {
      budgetTiles.spent.set(row.category_id, (budgetTiles.spent.get(row.category_id) || 0) + Number(saved.amount_egp));
      budgetTiles.spentUsd.set(row.category_id, (budgetTiles.spentUsd.get(row.category_id) || 0) + Number(saved.amount_usd));
    }
    const keepLive = form.rateSource === "live";
    f = freshForm(form.type);
    if (keepLive) Object.assign(f, { rate: form.rate, rateSource: "live", rateNote: form.rateNote });
    render();
    document.querySelector("main").scrollTop = 0;
    if (!keepLive) ensureRate();
    loadBudgetTiles();
  } catch (e) {
    form.saving = false;
    if (form === f) renderSaveButton();
    toast(friendlyError(e));
  }
}

async function undo(id, points) {
  try {
    await deleteTransaction(id);
    toast(points ? `Entry removed · −${points} pts` : "Entry removed");
    loadBudgetTiles();
  } catch (e) {
    toast(friendlyError(e));
  }
}

async function onDelete(e) {
  const btn = e.currentTarget;
  const form = f;
  if (!form.confirmDelete) {
    form.confirmDelete = true;
    btn.textContent = "Tap to confirm";
    setTimeout(() => {
      if (form.confirmDelete && btn.isConnected) {
        form.confirmDelete = false;
        btn.textContent = "Delete";
      }
    }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await deleteTransaction(form.id);
    f = null;
    toast("Entry deleted");
    location.hash = "#history";
  } catch (err) {
    form.confirmDelete = false;
    btn.disabled = false;
    btn.textContent = "Delete";
    toast(friendlyError(err));
  }
}

// ---------- receipt scan ----------

function pickPhoto() {
  // Attached to the page because iOS Safari doesn't reliably report a photo picked from a detached input.
  $("e-photo")?.remove();
  const input = el("input", { id: "e-photo", type: "file", accept: "image/*", hidden: true, "aria-label": "Receipt photo" });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.remove();
    if (file) runScan(file);
  });
  document.body.append(input);
  input.click();
}

async function runScan(file) {
  const status = el("p", { class: "sheet-status", text: "Preparing the photo…" });
  const fill = el("div");
  const progress = el("div", { class: "progress" }, fill);
  const results = el("div");

  const close = () => backdrop.remove();
  const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Scan a receipt" },
      el("h3", { text: "Reading your receipt" }),
      status, progress, results,
      el("p", { class: "muted small", text: `Amounts are in ${f.currency}, as set on the Add screen.` }),
      el("button", { type: "button", class: "btn secondary full", text: "Close", onclick: close })));
  document.body.append(backdrop);

  try {
    const candidates = await scanReceipt(file, ({ label, progress: p }) => {
      status.textContent = label;
      fill.style.width = `${Math.round(p * 100)}%`;
    });
    if (!backdrop.isConnected) return;
    progress.remove();
    if (!candidates.length) {
      status.textContent = "Couldn't find any amounts. Try a sharper, well-lit photo, or type the amount.";
      return;
    }
    status.textContent = "Tap the total (best guess highlighted):";
    results.replaceChildren(el("div", { class: "amount-chips" },
      candidates.map((c, i) =>
        el("button", {
          type: "button", class: "amount-chip" + (i === 0 ? " best" : ""),
          text: c.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          onclick: () => {
            f.amountText = String(c.value);
            $("e-amount").value = f.amountText;
            renderConverted();
            close();
          },
        }))));
  } catch (e) {
    progress.remove();
    status.textContent = friendlyError(e);
  }
}

// ---------- connectivity ----------

window.addEventListener("online", () => {
  if (f && !screen().hidden && f.mode === "add" && !f.rate) ensureRate();
});
