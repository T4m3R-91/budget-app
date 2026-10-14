// Past entries, newest first, grouped by day. Tap one to edit or delete it; hold it (half a second,
// or right-click with a mouse) to write a comment under it. Comments and replies sit in a dropdown
// under the entry, closed until opened, with a "Comments (n)" row inside the card saying how many there are. The
// filter bar is the Dashboard's (same bar, same settings; see filters.js), plus History's own
// All / Expenses / Income. Entries saved offline show on top, under "Waiting to sync", until they
// reach the server.

import { state, byId, memberName, isOwner } from "./state.js";
import { el, fmtMoney, friendlyDate, friendlyError, toast, parseISODate, spotlight, isoLocal } from "./ui.js";
import { fetchAllTransactions, fetchComments, addComment, deleteComment } from "./db.js";
import { itemRepeats } from "./recurring.js";
import { mountFilterBar, setFilterOptions, matchesFilters, onFiltersChange, clearFilters } from "./filters.js";
import { withTags } from "./tags.js";
import { pendingEntries, removePending } from "./outbox.js";

const PAGE = 50;
const TYPES = { all: "All", expense: "Expenses", income: "Income" };

let type = "all";
let rows = null; // every entry, newest first; null until loaded
let pending = []; // entries saved offline, still on the phone
let removeArmed = null; // the waiting entry whose Remove was tapped once
let shown = PAGE; // how many of the matching entries are on screen
let error = null;
let generation = 0; // ignores a load that finishes after a newer one started

const MAX_COMMENT = 280;
let comments = new Map(); // entry id → its comments and replies, oldest first
let commentsOn = true; // false until comments-migration.sql has run
const openComments = new Set(); // entries whose comment dropdown is open
let composing = null; // the comment box that's open: { entryId, parentId }
let deleteArmed = null; // the comment whose Delete was tapped once
let heldEntry = null; // the entry just held, so the tap that ends the hold doesn't open it
const countOf = (entryId) => (comments.get(entryId) || []).length;

const $ = (id) => document.getElementById(id);
const onScreen = () => $("screen-history")?.hidden === false;

onFiltersChange(() => {
  if (!onScreen()) return; // on the Dashboard: it redraws itself
  shown = PAGE;
  renderList();
});
// Something was queued, synced or removed: reload, so synced entries move into the list.
window.addEventListener("outboxchange", () => { if (onScreen()) showHistory(); });

// focus: an entry's id, from a notification about it: the list opens on it, highlighted. It's kept
// until a load finishes: opening the app syncs entries saved offline, which reloads the list too.
let focusPending = null;
export async function showHistory(focus = null) {
  if (focus) focusPending = focus;
  const gen = ++generation;
  shown = PAGE;
  error = null;
  removeArmed = null;
  render();
  try {
    const [loaded, waiting, loadedComments] = await Promise.all([
      fetchAllTransactions(), pendingEntries(),
      fetchComments().catch(() => null), // History works without them
    ]);
    if (gen !== generation) return;
    rows = loaded;
    pending = waiting;
    if (loadedComments) {
      commentsOn = loadedComments !== "missing";
      if (commentsOn) {
        comments = new Map();
        for (const c of loadedComments) comments.set(c.entry_id, [...(comments.get(c.entry_id) || []), c]);
      }
    }
    setFilterOptions(rows);
  } catch (e) {
    if (gen !== generation) return;
    error = friendlyError(e);
    pending = await pendingEntries();
  }
  renderList();
  if (focusPending && rows) {
    const id = focusPending;
    focusPending = null;
    focusOn(id);
  }
}

// Scrolls to an entry and highlights it: All instead of Expenses or Income, and no filters, if
// those would hide it; further down the list than shown so far, if it's older.
function focusOn(id) {
  if (!rows.some((t) => t.id === id)) return toast("This entry was deleted.");
  if (!matching().some((t) => t.id === id)) {
    type = "all";
    clearFilters();
    render();
    toast("Filters cleared to show it.");
  }
  const at = matching().findIndex((t) => t.id === id);
  const unfold = commentsOn && countOf(id) > 0 && !openComments.has(id); // from a notification about a comment
  if (unfold) openComments.add(id);
  if (at >= shown) {
    shown = Math.ceil((at + 1) / PAGE) * PAGE;
    renderList();
  } else if (unfold) {
    renderList();
  }
  const row = document.querySelector(`#h-list .txn-row[data-id="${CSS.escape(id)}"]`);
  // With comments the card is the whole block; a ring on the row alone would be clipped by it.
  if (row) spotlight(row.closest(".txn-block.has-cm") || row);
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
  const waiting = pending.filter((t) => (type === "all" || t.type === type) && matchesFilters(t));
  if (waiting.length) {
    nodes.push(el("h3", { class: "hist-date", text: "Waiting to sync" }), ...waiting.map(pendingRow));
  }
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

// An entry saved offline: dated, but not yet on the server, so it can't be edited; it can be
// removed from the phone before it syncs.
function pendingRow(t) {
  const income = t.type === "income";
  const kind = income ? byId(state.incomeSources, t.income_source_id) : byId(state.categories, t.category_id);
  const note = t.sync_error ? `⚠ Couldn't sync: ${t.sync_error}` : `⏳ ${friendlyDate(t.occurred_on)} · saved on this phone`;
  return el("div", { class: `txn-row pending ${income ? "income" : "expense"}${t.sync_error ? " failed" : ""}` },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: kind?.icon || "•" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title", text: `${t.private_to ? "🔒 " : ""}${kind?.name || "Unknown"}` }),
      el("span", { class: "txn-sub", text: [byId(state.subcategories, t.subcategory_id)?.name, t.description].filter(Boolean).concat(note).join(" · ") })),
    el("span", { class: "txn-amt" },
      (income ? "+" : "−") + fmtMoney(t.amount, t.currency, { code: true }),
      el("button", {
        type: "button", class: "btn danger small pending-remove", text: removeArmed === t.id ? "Tap again to remove" : "Remove",
        onclick: async () => {
          if (removeArmed !== t.id) { removeArmed = t.id; return renderList(); }
          await removePending(t.id);
          toast("Removed from this phone");
        },
      })));
}

// "1 Oct" (with the year when it isn't this year).
function plainDate(iso) {
  const d = parseISODate(iso);
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...year });
}

// An entry and, under it, its comment box and dropdown. Redrawn on its own when they change.
function row(t) {
  const block = el("div", { class: "txn-block", "data-block": t.id }, entryRow(t));
  if (commentsOn) block.append(...commentParts(t));
  if (block.children.length > 1) block.classList.add("has-cm", t.type === "income" ? "income" : "expense"); // one card around the entry and its comments
  return block;
}

const repaintBlock = (entryId) => {
  const t = (rows || []).find((x) => x.id === entryId);
  if (t) document.querySelector(`#h-list .txn-block[data-block="${CSS.escape(entryId)}"]`)?.replaceWith(row(t));
};

// ---------- comments ----------

// Hold an entry (half a second, or right-click with a mouse) to write a comment under it, the way
// holding a favorite edits it on the Add tab; a tap still opens the entry. Moving a finger (scrolling)
// cancels the hold.
function holdToComment(t) {
  if (!commentsOn) return {};
  return holdable(() => { heldEntry = t.id; startComposing(t.id, null); }, () => { heldEntry = null; },
    { onclick: (e) => { if (heldEntry === t.id) { e.preventDefault(); heldEntry = null; } } });
}

// Pointer handlers that call onHold after a half-second press (or a right-click).
function holdable(onHold, onDown = () => {}, extra = {}) {
  let timer = null;
  let start = null;
  const stop = () => clearTimeout(timer);
  const hold = () => { stop(); navigator.vibrate?.(10); onHold(); };
  return {
    onpointerdown: (e) => {
      onDown();
      start = [e.clientX, e.clientY];
      stop();
      timer = setTimeout(hold, 500);
    },
    onpointermove: (e) => { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) stop(); },
    onpointerup: stop,
    onpointerleave: stop,
    onpointercancel: stop,
    oncontextmenu: (e) => { e.preventDefault(); hold(); },
    ...extra,
  };
}

// Open the box under an entry (parentId null) or under a comment (a reply).
function startComposing(entryId, parentId) {
  composing = { entryId, parentId };
  if (parentId) openComments.add(entryId);
  repaintBlock(entryId);
  document.getElementById("cm-input")?.focus();
}

// The comment box (when it's open for this entry's own comment) and the dropdown of comments.
function commentParts(t) {
  const list = comments.get(t.id) || [];
  const parts = [];
  const composingHere = composing?.entryId === t.id;
  const open = openComments.has(t.id);
  // The box sits under the list when it's open; otherwise (hold on a card) right under the entry.
  if (composingHere && !(list.length && open)) parts.push(composer(t.id, null));
  if (list.length) {
    parts.push(el("div", { class: "cm" + (open ? " open" : "") },
      el("button", {
        type: "button", class: "cm-toggle", "aria-expanded": String(open),
        onclick: () => { if (open) openComments.delete(t.id); else openComments.add(t.id); repaintBlock(t.id); },
      }, el("span", { text: `Comments (${list.length})` }), el("span", { class: "cm-chev", "aria-hidden": "true" })),
      open ? el("div", { class: "cm-list" }, list.filter((c) => !c.parent_id).map((c) => commentThread(t.id, c, list)),
        composingHere && !composing.parentId ? composer(t.id, null) : null) : null));
  }
  return parts;
}

// "today, 2:14 PM" / "3 Oct, 9:05 AM"
function stamp(iso) {
  const d = new Date(iso);
  const day = friendlyDate(isoLocal(d)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase());
  return `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

// A comment with its replies under it, in their own boxes one level in. Replies to a reply (from an
// earlier version) are listed with the others under the same comment.
function commentThread(entryId, c, list) {
  const rootOf = (x) => { let r = x; while (r.parent_id) { const p = list.find((y) => y.id === r.parent_id); if (!p) break; r = p; } return r; };
  const replies = list.filter((r) => r.parent_id && rootOf(r).id === c.id);
  return el("div", { class: "cm-thread" },
    commentView(entryId, c, list, true, c.id),
    replies.length ? el("div", { class: "cm-replies" }, replies.map((r) => commentView(entryId, r, list, false, c.id))) : null,
    composing?.entryId === entryId && composing.parentId === c.id ? composer(entryId, c.id) : null);
}

// One comment box. Delete sits in its header, for the author and for owners (two taps, since a
// comment's replies go with it).
function commentView(entryId, x, list, isTop, rootId) {
  const who = (c) => (c.author === state.me?.email ? "You" : memberName(c.author));
  const mine = x.author === state.me?.email || isOwner();
  // Hold a comment to reply to it; hold a reply to reply to the comment it sits under.
  return el("div", { class: "cm-item", ...holdable(() => startComposing(entryId, rootId)) },
    el("div", { class: "cm-head" },
      el("strong", { text: who(x) }),
      el("span", { class: "muted small", text: stamp(x.created_at) }),
      mine ? el("button", {
        type: "button", class: "cm-del" + (deleteArmed === x.id ? " armed" : ""), "aria-label": "Delete comment",
        text: deleteArmed === x.id ? "Tap again to delete" : "✕",
        onclick: () => removeComment(entryId, x, list),
      }) : null),
    el("div", { class: "cm-body", text: x.body }));
}

async function removeComment(entryId, comment, list) {
  if (deleteArmed !== comment.id) { deleteArmed = comment.id; return repaintBlock(entryId); }
  deleteArmed = null;
  if (!navigator.onLine) { toast("Deleting a comment needs a connection."); return repaintBlock(entryId); }
  try {
    await deleteComment(comment.id);
    const gone = new Set([comment.id]); // its replies go with it, and replies to those
    for (let grew = true; grew;) {
      grew = false;
      for (const r of list) if (!gone.has(r.id) && gone.has(r.parent_id)) { gone.add(r.id); grew = true; }
    }
    comments.set(entryId, list.filter((x) => !gone.has(x.id)));
    if (!countOf(entryId)) openComments.delete(entryId);
  } catch (e) {
    toast(friendlyError(e));
  }
  repaintBlock(entryId);
}

// The text box for a comment (parentId null) or a reply: up to 280 characters, with a counter.
function composer(entryId, parentId) {
  const input = el("textarea", {
    id: "cm-input", class: "text-input", maxlength: MAX_COMMENT, autocomplete: "off", rows: "1",
    placeholder: parentId ? "Write a reply…" : "Write a comment…", "aria-label": parentId ? "Reply" : "Comment",
  });
  const counter = el("span", { class: "cm-count muted small", text: `0/${MAX_COMMENT}` });
  input.addEventListener("input", () => {
    counter.textContent = `${input.value.length}/${MAX_COMMENT}`;
    input.style.height = "auto"; // grows with the text (the CSS caps it)
    input.style.height = `${input.scrollHeight + 2}px`;
  });
  const post = el("button", { type: "submit", class: "btn small primary", text: "Post" });
  return el("form", {
    class: "cm-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      if (!navigator.onLine) return toast("Commenting needs a connection.");
      post.disabled = true;
      try {
        const saved = await addComment(entryId, body, parentId);
        comments.set(entryId, [...(comments.get(entryId) || []), saved]);
        openComments.add(entryId);
        composing = null;
        repaintBlock(entryId);
      } catch (err) {
        toast(friendlyError(err));
        post.disabled = false;
      }
    },
  },
  input,
  el("div", { class: "cm-form-foot" }, counter,
    el("button", { type: "button", class: "btn small secondary", text: "Cancel", onclick: () => { composing = null; repaintBlock(entryId); } }),
    post));
}

function entryRow(t) {
  const income = t.type === "income";
  const kind = income ? byId(state.incomeSources, t.income_source_id) : byId(state.categories, t.category_id);
  // The note's @tags stand out (tags.js).
  const bits = [byId(state.subcategories, t.subcategory_id)?.name, t.description ? withTags(t.description) : null, memberName(t.who)].filter(Boolean);
  const detail = bits.flatMap((b, i) => [...(i ? [" · "] : []), ...[].concat(b)]);
  const other = t.currency === "USD" ? fmtMoney(t.amount_egp, "EGP") : fmtMoney(t.amount_usd, "USD", { code: true });
  // Logged from a recurring item: which due date it settles ("↻ Due 1 Oct"), so a payment made in
  // another month still shows the month it belongs to. It's kept whole; the details before it
  // are shortened instead when the line is too long.
  // (No ↻ for a payment scheduled just once.)
  const due = t.recurring_due_on ? `${bits.length ? "· " : ""}${itemRepeats(t.recurring_id) ? "↻ " : ""}Due ${plainDate(t.recurring_due_on)}` : null;
  return el("a", { class: `txn-row ${income ? "income" : "expense"}`, href: `#edit/${t.id}`, "data-id": t.id, ...holdToComment(t) },
    el("span", { class: "txn-ico", "aria-hidden": "true", text: kind?.icon || "•" }),
    el("span", { class: "txn-main" },
      el("span", { class: "txn-title" },
        `${t.private_to ? "🔒 " : ""}${kind?.name || "Unknown"}`), // private: only its person and owners see it
      el("span", { class: "txn-sub" }, el("span", { class: "txn-detail" }, ...detail), due ? el("span", { class: "txn-due", text: due }) : null)),
    el("span", { class: "txn-amt" },
      (income ? "+" : "−") + fmtMoney(t.amount, t.currency, { code: true }),
      el("span", { class: "alt", text: `≈ ${other}` })));
}
