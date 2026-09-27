// Account, the household's lists (add / rename / reorder / hide), and Excel export.
// Items are hidden rather than deleted so past entries keep their category names.

import { state, subcategoriesOf } from "./state.js";
import { el, toast, friendlyError } from "./ui.js";
import { sb, reloadLists, insertListItem, updateListItem, fetchLeaderboard } from "./db.js";
import { exportToExcel } from "./export.js";

const expanded = new Set(); // categories whose subcategory list is open
let editing = null; // "table:id" of the row being renamed
let board = { status: "loading", rows: [] }; // loading | ready | missing | error
let period = "all_time"; // or "this_month"

export function showSettings() {
  editing = null;
  render();
  loadBoard();
}

function render() {
  document.getElementById("screen-settings").replaceChildren(
    el("h2", { class: "screen-title", text: "Settings" }),
    accountSection(),
    listSection({ title: "Categories", table: "categories", items: state.categories, withIcon: true, nested: true }),
    listSection({ title: "Payment methods", table: "payment_methods", items: state.paymentMethods }),
    listSection({ title: "Income sources", table: "income_sources", items: state.incomeSources, withIcon: true }),
    exportSection(),
    el("p", { class: "app-version", text: "Household Budget 1.0" })
  );
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

// ---------- account ----------

function accountSection() {
  const pw = el("input", {
    class: "text-input", type: "password", autocomplete: "new-password", minlength: 8,
    placeholder: "New password (8+ characters)", "aria-label": "New password",
  });
  const pwForm = el("form", {
    class: "inline-form",
    onsubmit: async (e) => {
      e.preventDefault();
      if (pw.value.length < 8) return toast("Use at least 8 characters.");
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) return toast(friendlyError(error));
      pw.value = "";
      toast("Password changed");
    },
  }, pw, el("button", { type: "submit", class: "btn small secondary", text: "Change" }));

  return el("section", { class: "set-section" },
    el("h3", { text: "Account" }),
    el("p", { class: "acct" }, el("strong", { text: state.me.display_name }), el("span", { class: "muted", text: ` · ${state.me.email}` })),
    pointsBox(),
    pwForm,
    el("button", { type: "button", class: "btn secondary full", text: "Sign out", onclick: () => sb.auth.signOut() }));
}

// ---------- points ----------

const fmtPoints = (n) => Number(n || 0).toLocaleString("en-US");

async function loadBoard() {
  if (!board.rows.length) board = { status: "loading", rows: [] };
  try {
    board = { status: "ready", rows: await fetchLeaderboard() };
  } catch (e) {
    // Before points-migration.sql has run, the leaderboard view doesn't exist yet.
    const missing = e?.code === "42P01" || e?.code === "PGRST205" || /points_leaderboard/.test(e?.message || "");
    board = { status: missing ? "missing" : "error", rows: [], message: friendlyError(e) };
  }
  paintPoints();
}

function paintPoints() {
  document.getElementById("points-box")?.replaceWith(pointsBox());
}

// Your all-time total, then the household ranked for the chosen period. The leader
// gets a star; ties share it, and nobody gets one while everyone is at zero.
function pointsBox() {
  const box = (...children) => el("div", { id: "points-box", class: "points" }, children);
  if (board.status === "loading") return box(el("p", { class: "muted small", text: "Loading points…" }));
  if (board.status === "missing") {
    return box(el("p", { class: "muted small", text: "Points aren't set up yet. Run points-migration.sql in Supabase to turn them on." }));
  }
  if (board.status === "error") {
    return box(el("p", { class: "muted small" }, `Couldn't load points. ${board.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: loadBoard })));
  }

  const mine = board.rows.find((r) => r.email === state.me.email);
  const ranked = board.rows.slice().sort((a, b) => b[period] - a[period] || a.display_name.localeCompare(b.display_name));
  const top = ranked[0]?.[period] || 0;

  return box(
    el("div", { class: "points-total" },
      el("span", { class: "muted", text: "Your points" }),
      el("strong", { text: fmtPoints(mine?.all_time) })),
    el("div", { class: "lb-head" },
      el("span", { class: "lb-title", text: "Leaderboard" }),
      el("div", { class: "seg small", role: "group", "aria-label": "Leaderboard period" },
        [["all_time", "All time"], ["this_month", "This month"]].map(([key, label]) =>
          el("button", {
            type: "button", class: period === key ? "active" : "", "aria-pressed": String(period === key), text: label,
            onclick: () => { period = key; paintPoints(); },
          })))),
    el("ol", { class: "lb-list" },
      ranked.map((r) => {
        const leader = top > 0 && r[period] === top;
        return el("li", { class: "lb-row" + (leader ? " leader" : "") },
          el("span", { class: "lb-star", "aria-label": leader ? "Leader" : null, text: leader ? "⭐" : "" }),
          el("span", { class: "lb-name", text: r.display_name + (r.email === state.me.email ? " (you)" : "") }),
          el("span", { class: "lb-pts", text: `${fmtPoints(r[period])} pts` }));
      })));
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

// ---------- export ----------

function exportSection() {
  const button = el("button", {
    type: "button", class: "btn secondary full", text: "Export to Excel",
    onclick: async () => {
      button.disabled = true;
      button.textContent = "Preparing file…";
      try {
        const counts = await exportToExcel();
        toast(`Exported ${counts.expenses} expenses and ${counts.income} income entries`);
      } catch (e) {
        toast(friendlyError(e));
      }
      button.disabled = false;
      button.textContent = "Export to Excel";
    },
  });
  return el("section", { class: "set-section" },
    el("h3", { text: "Export" }),
    el("p", { class: "note", text: "Downloads everything as an Excel file with Transactions and Income tabs, in the same layout as your spreadsheet." }),
    button);
}
