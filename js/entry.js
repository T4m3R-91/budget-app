// The Add / Edit screen: amount + category are the only required inputs; everything else
// is defaulted (date today, EGP, you, last payment method, live rate) and editable.

import { state, byId, subcategoriesOf } from "./state.js";
import { el, toast, fmtMoney, fmtRate, isoLocal, friendlyDate, relativeDay, friendlyError } from "./ui.js";
import { parseAmount, parseRate, round2, round4 } from "./numbers.js";
import { getLiveRate } from "./fx.js";
import { insertTransaction, updateTransaction, deleteTransaction, latestEntryRate, fetchTransaction } from "./db.js";
import { scanReceipt } from "./receipt.js";

const $ = (id) => document.getElementById(id);
const screen = () => $("screen-add");
const isVisible = () => !screen().hidden;

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
    date: isoLocal(), description: "", moreOpen: false,
    saving: false, confirmDelete: false,
  };
}

export function showAdd() {
  // Keep a half-filled entry when hopping between tabs; start fresh after an edit.
  if (!f || f.mode !== "add") f = freshForm();
  if (f.date < isoLocal() && !f.amountText) f.date = isoLocal(); // stale "today" from yesterday
  render();
  if (!["edited", "manual"].includes(f.rateSource)) ensureRate();
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
    rate: Number(t.rate), rateSource: "saved", rateNote: "saved with this entry",
    categoryId: t.category_id, subcategoryId: t.subcategory_id, sourceId: t.income_source_id,
    paymentMethodId: t.payment_method_id, who: t.who, date: t.occurred_on,
    description: t.description || "", moreOpen: Boolean(t.subcategory_id || t.description),
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
  renderFooter();

  const live = navigator.onLine ? await getLiveRate({ force }) : null;
  if (form !== f || userSet()) return;

  if (live) {
    Object.assign(form, { rate: live.rate, rateSource: "live", rateNote: `live, updated ${relativeDay(isoLocal(live.asOf))}` });
  } else {
    let last = null;
    try { last = await latestEntryRate(); } catch { /* offline too */ }
    if (form !== f || userSet()) return;
    if (last) {
      Object.assign(form, {
        rate: Number(last.rate), rateSource: "last_entry",
        rateNote: `from your last entry (${relativeDay(last.occurred_on)}); rate service unreachable`,
      });
    } else if (!form.rate) {
      Object.assign(form, { rateSource: null, rateNote: "couldn't reach the rate service" });
    }
  }
  form.rateLoading = false;
  renderRate();
  renderConverted();
  renderFooter();
}

// ---------- rendering ----------

function render() {
  const r = screen();
  commitRateEdit = null;
  r.classList.toggle("income-mode", f.type === "income");

  const head =
    f.mode === "edit"
      ? el("div", { class: "entry-head" },
          el("a", { class: "link-btn", href: "#history", text: "Cancel" }),
          el("h2", { text: f.type === "income" ? "Edit income" : "Edit expense" }),
          el("span"))
      : el("div", { class: "entry-head centered" }, typeSeg());

  const amount = el("input", {
    id: "e-amount", class: "amount-input", type: "text", inputmode: "decimal",
    autocomplete: "off", enterkeyhint: "done", placeholder: "0", "aria-label": "Amount",
    value: f.amountText,
    oninput: (e) => { f.amountText = e.target.value; sizeAmount(); renderConverted(); renderFooter(); },
  });

  const more = el("details", { class: "more", open: f.moreOpen, ontoggle: (e) => { f.moreOpen = e.target.open; } },
    el("summary", { text: f.type === "income" ? "More: note" : "More: subcategory, note" }),
    el("div", { id: "e-subs", class: "subchips" }),
    el("input", {
      id: "e-desc", class: "text-input", type: "text", maxlength: 200, enterkeyhint: "done",
      placeholder: f.type === "income" ? "Note (optional)" : "Note (optional), e.g. Carrefour",
      "aria-label": "Note", value: f.description,
      oninput: (e) => { f.description = e.target.value; },
    }));

  const left =
    f.mode === "edit"
      ? el("button", { id: "e-delete", type: "button", class: "btn danger", text: "Delete", onclick: onDelete })
      : el("button", { type: "button", class: "btn secondary", text: "📷 Scan", "aria-label": "Scan a receipt", onclick: pickPhoto });

  r.replaceChildren(
    head,
    el("div", { class: "amount-wrap" }, el("span", { id: "e-amount-cur", class: "amount-cur" }), amount),
    el("div", { id: "e-converted", class: "converted", "aria-live": "polite" }),
    el("div", { class: "rate-row" },
      el("div", { id: "e-cur-seg", class: "seg small", role: "group", "aria-label": "Currency" }),
      el("div", { id: "e-rate", class: "rate-box" })),
    el("p", { class: "section-label", text: f.type === "income" ? "Source" : "Category" }),
    el("div", { id: "e-grid", class: "cat-grid" }),
    el("div", { id: "e-chips", class: "chips" }),
    more,
    el("div", { class: "action-bar" },
      el("div", { class: "actions" }, left, el("button", { id: "e-save", type: "button", class: "btn primary", onclick: save })),
      el("p", { id: "e-hint", class: "hint", "aria-live": "polite" }))
  );

  sizeAmount();
  renderCurrency();
  renderRate();
  renderConverted();
  renderGrid();
  renderChips();
  renderSubs();
  renderFooter();
}

// Grows the amount field with its text so the currency label stays right beside the number.
function sizeAmount() {
  const input = $("e-amount");
  if (input) input.style.width = `${Math.max(1, input.value.length) + 0.3}ch`;
}

function typeSeg() {
  return el("div", { class: "seg", role: "group", "aria-label": "Entry type" },
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
}

function renderCurrency() {
  $("e-amount-cur").textContent = f.currency;
  $("e-cur-seg").replaceChildren(...currencyButtons(setCurrency));
}

function currencyButtons(onPick) {
  return ["EGP", "USD"].map((c) =>
    el("button", {
      type: "button", class: f.currency === c ? "active" : "", "aria-pressed": String(f.currency === c),
      text: c, onclick: () => onPick(c),
    }));
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
    const done = () => { commitRateEdit(); renderRate(); renderConverted(); renderFooter(); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); });
    box.replaceChildren(
      el("span", { class: "rate-line", text: "1 USD =" }), input, el("span", { class: "rate-line", text: "EGP" }),
      el("button", { type: "button", class: "link-btn", text: "Done", onclick: done }));
    input.focus();
    input.select();
    return;
  }

  const warn = !f.rateLoading && (!f.rate || f.rateSource === "last_entry");
  let line = f.rate ? `1 USD = ${fmtRate(f.rate)} EGP` : f.rateLoading ? "Getting today's rate…" : "No exchange rate yet";
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
      type: "button", class: "link-btn", text: "Use live rate",
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
      text: isIncome ? "No income sources yet. Add some in Settings." : "No categories yet. Add some in Settings.",
    }));
    return;
  }
  grid.replaceChildren(...items.map((x) =>
    el("button", {
      type: "button", class: "cat-btn" + (x.id === selected ? " sel" : ""), "aria-pressed": String(x.id === selected),
      onclick: () => pick(x.id),
    }, el("span", { class: "ico", "aria-hidden": "true", text: x.icon }), el("span", { class: "nm", text: x.name }))));
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
  renderFooter();
}

function renderSubs() {
  const box = $("e-subs");
  if (!box) return;
  box.hidden = f.type === "income";
  if (f.type === "income") return;
  if (!f.categoryId) {
    box.replaceChildren(el("span", { class: "muted small", text: "Pick a category to see its subcategories." }));
    return;
  }
  const subs = subcategoriesOf(f.categoryId).filter((s) => !s.hidden || s.id === f.subcategoryId);
  if (!subs.length) {
    box.replaceChildren(el("span", { class: "muted small", text: "This category has no subcategories." }));
    return;
  }
  box.replaceChildren(...subs.map((s) =>
    el("button", {
      type: "button", class: "subchip" + (s.id === f.subcategoryId ? " sel" : ""),
      "aria-pressed": String(s.id === f.subcategoryId), text: s.name,
      onclick: () => { f.subcategoryId = f.subcategoryId === s.id ? null : s.id; renderSubs(); },
    })));
}

function selectChip(label, options, value, onChange) {
  const current = options.find((o) => o.value === value) || options[0];
  const select = el("select", { "aria-label": label, onchange: (e) => onChange(e.target.value) },
    options.map((o) => el("option", { value: o.value, text: o.label, selected: o.value === value })));
  return el("label", { class: "chip" },
    el("span", { class: "k", text: label }), el("span", { text: current?.label ?? "—" }), select);
}

function renderChips() {
  const date = el("label", { class: "chip" },
    el("span", { class: "k", text: "Date" }),
    el("span", { text: friendlyDate(f.date) }),
    el("input", {
      type: "date", "aria-label": "Date", value: f.date,
      onchange: (e) => { if (e.target.value) { f.date = e.target.value; renderChips(); } },
    }));

  const chips = [date];
  if (f.type === "expense") {
    const payments = state.paymentMethods
      .filter((p) => !p.hidden || p.id === f.paymentMethodId)
      .map((p) => ({ value: p.id, label: p.name }));
    chips.push(selectChip("Paid with", [{ value: "", label: "Not set" }, ...payments], f.paymentMethodId ?? "",
      (v) => { f.paymentMethodId = v || null; renderChips(); }));
  }
  const people = state.members.map((m) => ({
    value: m.email, label: m.email === state.me.email ? `${m.display_name} (you)` : m.display_name,
  }));
  chips.push(selectChip(f.type === "income" ? "Received by" : "Paid by", people, f.who,
    (v) => { f.who = v; renderChips(); renderFooter(); }));

  $("e-chips").replaceChildren(...chips);
}

function problem() {
  if (!navigator.onLine) return "You're offline. Connect to save.";
  if (parseAmount(f.amountText) == null) return "Enter an amount.";
  if (f.type === "expense" && !f.categoryId) return "Pick a category.";
  if (f.type === "income" && !f.sourceId) return "Pick a source.";
  if (!(f.rate > 0)) return f.rateLoading ? "Getting today's exchange rate…" : "Enter the exchange rate.";
  if (!f.who) return "Choose who paid.";
  return null;
}

function renderFooter() {
  const save = $("e-save");
  if (!save) return;
  const p = problem();
  save.disabled = Boolean(p) || f.saving;
  save.textContent = f.saving ? "Saving…" : f.mode === "edit" ? "Save changes" : f.type === "income" ? "Save income" : "Save expense";
  $("e-hint").textContent = f.saving ? "" : p || "";
}

// ---------- save / delete / undo ----------

function nameOf(t) {
  return t.type === "income" ? byId(state.incomeSources, t.income_source_id)?.name : byId(state.categories, t.category_id)?.name;
}

async function save() {
  if (commitRateEdit) {
    commitRateEdit();
    renderRate();
  }
  if (problem() || f.saving) {
    renderFooter();
    return;
  }
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
  renderFooter();
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
    toast(`Saved ${nameOf(saved) || ""} · ${fmtMoney(saved.amount, saved.currency)}`, {
      label: "Undo",
      run: () => undo(saved.id),
    });
    const keepLive = form.rateSource === "live";
    f = freshForm(form.type);
    if (keepLive) Object.assign(f, { rate: form.rate, rateSource: "live", rateNote: form.rateNote });
    render();
    if (!keepLive) ensureRate();
  } catch (e) {
    form.saving = false;
    if (form === f) renderFooter();
    toast(friendlyError(e));
  }
}

async function undo(id) {
  try {
    await deleteTransaction(id);
    toast("Entry removed");
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
  const curSeg = el("div", { class: "seg small", role: "group", "aria-label": "Receipt currency" });
  const paintCurrency = () => curSeg.replaceChildren(...currencyButtons((c) => { setCurrency(c); paintCurrency(); }));
  paintCurrency();

  const close = () => backdrop.remove();
  const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Scan a receipt" },
      el("h3", { text: "Reading your receipt" }),
      status, progress, results,
      el("div", { class: "sheet-row" }, el("span", { class: "muted small", text: "Currency on this receipt" }), curSeg),
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
            sizeAmount();
            renderConverted();
            renderFooter();
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
  if (!f || !isVisible()) return;
  renderFooter();
  if (f.mode === "add" && !f.rate) ensureRate();
});
window.addEventListener("offline", () => {
  if (f && isVisible()) renderFooter();
});
