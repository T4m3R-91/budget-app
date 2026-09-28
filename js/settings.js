// The Settings card in Profile, collapsed until opened: Day/Night theme and the household's lists
// (add / rename / reorder / hide). Items are hidden rather than deleted so past entries keep
// their category names.

import { state, subcategoriesOf } from "./state.js";
import { el, toast, friendlyError, themeChoice, setThemeChoice } from "./ui.js";
import { reloadLists, insertListItem, updateListItem } from "./db.js";

const expanded = new Set(); // categories whose subcategory list is open
let editing = null; // "table:id" of the row being renamed
let open = false; // the card starts collapsed; it stays as you left it while the app is open
let card = null;

export function settingsCard() {
  editing = null;
  card = el("section", { class: "set-section settings-card" });
  render();
  return card;
}

function render() {
  card.replaceChildren(
    el("h3", { class: "collapse-head" },
      el("button", {
        type: "button", "aria-expanded": String(open), onclick: () => { open = !open; render(); },
      }, el("span", { text: "Settings" }), el("span", { class: "chev", "aria-hidden": "true", text: "▸" }))),
    ...(open
      ? [
          appearanceSection(),
          listSection({ title: "Categories", table: "categories", items: state.categories, withIcon: true, nested: true }),
          listSection({ title: "Payment methods", table: "payment_methods", items: state.paymentMethods }),
          listSection({ title: "Income sources", table: "income_sources", items: state.incomeSources, withIcon: true }),
        ]
      : []));
  document.getElementById("rename-input")?.focus();
}

// Runs a change, refreshes the lists everyone sees, and redraws.
async function change(fn, success) {
  try {
    await fn();
    await reloadLists();
    if (success) toast(success);
  } catch (e) {
    toast(friendlyError(e));
  }
  render();
}

// ---------- appearance ----------

function appearanceSection() {
  const choice = themeChoice();
  return el("section", { class: "set-section" },
    el("h3", { text: "Appearance" }),
    el("div", { class: "seg small theme-seg", role: "group", "aria-label": "Theme" },
      [["auto", "🕒 Auto"], ["light", "☀️ Day"], ["dark", "🌙 Night"]].map(([key, label]) =>
        el("button", {
          type: "button", class: choice === key ? "active" : "", "aria-pressed": String(choice === key), text: label,
          onclick: () => { setThemeChoice(key); render(); },
        }))));
}

// ---------- list editors ----------

function listSection({ title, table, items, withIcon = false, nested = false, parent = null }) {
  const rows = items.map((item, i) => itemRow({ item, i, items, table, withIcon, nested }));
  const body = [
    el("div", { class: "li-list" }, rows.length ? rows : el("p", { class: "muted small", text: "Nothing here yet." })),
    addForm({ table, items, withIcon, parent }),
  ];
  if (parent) return el("div", { class: "sub-editor" }, body);
  return el("section", { class: "set-section" },
    el("h3", { text: title }),
    el("p", { class: "note", text: "Hidden items stay on past entries but disappear from the Add screen." }),
    body);
}

function itemRow({ item, i, items, table, withIcon, nested }) {
  const key = `${table}:${item.id}`;
  if (editing === key) return renameForm({ item, table, withIcon });

  const subs = nested ? subcategoriesOf(item.id) : [];
  const open = nested && expanded.has(item.id);
  const row = el("div", { class: "li-row" + (item.hidden ? " is-hidden" : "") },
    withIcon ? el("span", { class: "li-icon", "aria-hidden": "true", text: item.icon }) : null,
    el("div", { class: "li-main" },
      el("div", { class: "li-name" }, item.name, item.hidden ? el("span", { class: "badge", text: "Hidden" }) : null),
      nested
        ? el("button", {
            type: "button", class: "link-btn", "aria-expanded": String(open),
            text: `${subs.length} subcategor${subs.length === 1 ? "y" : "ies"} ${open ? "▾" : "▸"}`,
            onclick: () => { if (open) expanded.delete(item.id); else expanded.add(item.id); render(); },
          })
        : null),
    el("div", { class: "li-actions" },
      el("button", { type: "button", class: "icon-btn", "aria-label": `Move ${item.name} up`, text: "↑", disabled: i === 0, onclick: () => move(table, items, i, -1) }),
      el("button", { type: "button", class: "icon-btn", "aria-label": `Move ${item.name} down`, text: "↓", disabled: i === items.length - 1, onclick: () => move(table, items, i, 1) }),
      el("button", { type: "button", class: "icon-btn", text: "Edit", onclick: () => { editing = key; render(); } }),
      el("button", {
        type: "button", class: "icon-btn", text: item.hidden ? "Show" : "Hide",
        onclick: () => change(() => updateListItem(table, item.id, { hidden: !item.hidden }), item.hidden ? `${item.name} is back` : `${item.name} hidden`),
      })));

  if (!open) return row;
  return el("div", {}, row, listSection({ table: "subcategories", items: subs, parent: item }));
}

function renameForm({ item, table, withIcon }) {
  const icon = withIcon ? el("input", { class: "text-input icon-input", value: item.icon, maxlength: 8, "aria-label": "Icon" }) : null;
  const name = el("input", { id: "rename-input", class: "text-input", value: item.name, maxlength: 40, "aria-label": "Name" });
  return el("form", {
    class: "inline-form",
    onsubmit: (e) => {
      e.preventDefault();
      const newName = name.value.trim();
      if (!newName) return toast("The name can't be empty.");
      const patch = { name: newName };
      if (icon) patch.icon = icon.value.trim() || item.icon;
      editing = null;
      change(() => updateListItem(table, item.id, patch), "Saved");
    },
  }, icon, name,
    el("button", { type: "submit", class: "btn small primary", text: "Save" }),
    el("button", { type: "button", class: "btn small secondary", text: "Cancel", onclick: () => { editing = null; render(); } }));
}

function addForm({ table, items, withIcon, parent }) {
  const icon = withIcon ? el("input", { class: "text-input icon-input", placeholder: "🙂", maxlength: 8, "aria-label": "Icon (an emoji)" }) : null;
  const placeholder = parent ? `New subcategory of ${parent.name}` : "Add new…";
  const name = el("input", { class: "text-input", placeholder, maxlength: 40, "aria-label": placeholder });
  return el("form", {
    class: "inline-form",
    onsubmit: (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) return;
      if (items.some((x) => x.name.toLowerCase() === n.toLowerCase())) return toast(`"${n}" is already in the list.`);
      const row = { name: n, sort_order: Math.max(0, ...items.map((x) => x.sort_order)) + 10 };
      if (icon) row.icon = icon.value.trim() || (table === "income_sources" ? "💰" : "📦");
      if (parent) row.category_id = parent.id;
      change(() => insertListItem(table, row), `Added ${n}`);
    },
  }, icon, name, el("button", { type: "submit", class: "btn small primary", text: "Add" }));
}

function move(table, items, i, dir) {
  const order = items.slice();
  const [item] = order.splice(i, 1);
  order.splice(i + dir, 0, item);
  const updates = order
    .map((x, idx) => ({ x, sort: (idx + 1) * 10 }))
    .filter(({ x, sort }) => x.sort_order !== sort);
  change(() => Promise.all(updates.map(({ x, sort }) => updateListItem(table, x.id, { sort_order: sort }))));
}
