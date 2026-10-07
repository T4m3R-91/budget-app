// The activity log (activity-log-migration.sql): the household's record of who added, changed or
// deleted what, shown as the notification center's "Everything" list. The database writes each line
// with the row as it was (before) and became (after); this turns a line into the same kind of text
// as the notifications ("Mona deleted 🍽️ Food" / "EGP 450 · Carrefour · 3 Oct"), its icon, its
// color, and where tapping it goes. Everything is described with the lists as they are now (a
// renamed category shows its new name).

import { state, byId, memberName, isOwner } from "./state.js";
import { fmtMoney, isoLocal, relativeDay } from "./ui.js";
import { shortDate, ordinal } from "./recurring.js";
import { compact } from "./budget.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const firstOf = (iso) => `${iso.slice(0, 7)}-01`;

// "You", or their name ("Someone" for a person no longer listed).
const who = (email) => (email === state.me?.email ? "You" : memberName(email) || "Someone");
// "by you" / "by Mona", for an entry paid by someone other than whoever changed it.
const byWhom = (email) => `by ${email === state.me?.email ? "you" : memberName(email) || "someone"}`;

const money = (r) => `${r.type === "income" ? "+" : ""}${fmtMoney(r.amount, r.currency, { code: true })}`;
const sourceOf = (r) => (r.type === "income" ? byId(state.incomeSources, r.income_source_id) : byId(state.categories, r.category_id));
const labelOf = (r) => { const s = r && sourceOf(r); return s ? `${s.icon || "•"} ${s.name}` : "an entry"; };
const subName = (r) => byId(state.subcategories, r.subcategory_id)?.name;
const methodName = (r) => (r.type === "income"
  ? byId(state.receivingMethods || [], r.receiving_method_id)?.name
  : byId(state.paymentMethods, r.payment_method_id)?.name);
const note = (s) => (s && s.length > 60 ? `${s.slice(0, 59)}…` : s);
// Before the label of something private (private-migration.sql): "Mona added 🔒 🎁 Gifts".
const lock = (r) => (r?.private_to ? "🔒 " : "");
const privacyChange = (b, a) => ((b.private_to ?? null) === (a.private_to ?? null) ? null : a.private_to ? "made private" : "shared again");
const changed = (b, a, key) => (b[key] ?? null) !== (a[key] ?? null);

// Whether an owner can remove this line (the database's rule: the record of a deletion).
export const removable = (line) => isOwner() && line.action === "deleted" && ["entry", "scheduled", "budget"].includes(line.kind);

// { icon, title, body, href, tone, signed }: tone is "expense", "income" or "" (no color); signed:
// whether its amounts are payments and income (− and +) rather than budgets. No href: nothing to
// open (it was deleted).
export function describe(line) {
  const A = who(line.actor);
  const b = line.before || {};
  const a = line.after || {};
  const r = line.after || line.before || {};
  switch (line.kind) {
    case "entry": return entryLine(line, A, b, a, r);
    case "scheduled": return scheduledLine(line, A, b, a, r);
    case "skip": return skipLine(line, A, r);
    case "budget": return budgetLine(line, A, b, a);
    case "member": return memberLine(line, A, b, a, r);
    default: return listLine(line, A, b, a, r);
  }
}

// ---------- entries ----------

function entryLine(line, A, b, a, r) {
  const tone = r.type === "income" ? "income" : "expense";
  const details = (x) => [money(x), subName(x), note(x.description), relativeDay(x.occurred_on), x.who !== line.actor ? byWhom(x.who) : null];
  if (line.action === "deleted") {
    return { icon: "🗑️", title: `${A} deleted ${lock(b)}${labelOf(b)}`, body: details(b).filter(Boolean).join(" · "), tone, signed: true };
  }
  const href = `#history/${line.subject}`;
  if (line.action === "added") {
    // Set up to repeat: the schedule it started. Logged from a scheduled payment: its due date.
    const logged = a.recurring_id && !a.repeat;
    const extra = a.repeat ? `repeats ${a.repeat.frequency}`
      : logged && a.recurring_due_on && a.recurring_due_on !== a.occurred_on ? `due ${shortDate(a.recurring_due_on)}` : null;
    return { icon: "➕", title: `${A} ${logged ? "logged" : "added"} ${lock(a)}${labelOf(a)}`, body: [...details(a), extra].filter(Boolean).join(" · "), href, tone, signed: true };
  }
  const amount = Number(b.amount) !== Number(a.amount) || b.currency !== a.currency;
  const parts = [
    amount ? `${money(b)} → ${money(a)}` : money(a),
    labelOf(b) !== labelOf(a) ? `was ${labelOf(b)}` : null,
    changed(b, a, "subcategory_id") ? `${subName(b) || "no subcategory"} → ${subName(a) || "none"}` : subName(a),
    noteChange(b.description, a.description),
    changed(b, a, "occurred_on") ? `${relativeDay(b.occurred_on)} → ${relativeDay(a.occurred_on)}` : relativeDay(a.occurred_on),
    changed(b, a, "payment_method_id") || changed(b, a, "receiving_method_id") ? `${methodName(b) || "no method"} → ${methodName(a) || "none"}` : null,
    changed(b, a, "who") ? `${byWhom(b.who)} → ${memberName(a.who) || "someone"}` : a.who !== line.actor ? byWhom(a.who) : null,
    changed(b, a, "recurring_id") ? (a.recurring_id ? "now a scheduled payment" : "no longer a scheduled payment") : null,
    privacyChange(b, a),
  ];
  return { icon: "✏️", title: `${A} edited ${lock(a)}${labelOf(a)}`, body: parts.filter(Boolean).join(" · "), href, tone, signed: true };
}

// "note added: …", "note removed: …", "old → new", or the note as it is.
function noteChange(was, now) {
  if ((was || "") === (now || "")) return note(now);
  if (!was) return `note added: ${note(now)}`;
  if (!now) return `note removed: ${note(was)}`;
  return `${note(was)} → ${note(now)}`;
}

// ---------- scheduled payments and skips ----------

// "on 14 Oct", "monthly on the 5th", "yearly on 5 Mar until 5 Mar 2028".
function scheduleOf(r) {
  if (r.frequency === "once") return `on ${shortDate(r.starts_on)}`;
  const every = r.frequency === "yearly" ? `yearly on ${r.day} ${MONTHS[r.month - 1]}` : `monthly on the ${ordinal(r.day)}`;
  return r.ended_on ? `${every} until ${shortDate(r.ended_on)}` : every;
}

// The Budget tab's month to open a payment on: its own month if it's still to come or has ended,
// otherwise this month.
function monthFor(r) {
  const today = isoLocal();
  if (r.frequency === "once" || r.starts_on > today) return firstOf(r.starts_on);
  if (r.ended_on && r.ended_on < today) return firstOf(r.ended_on);
  return firstOf(today);
}

function scheduledLine(line, A, b, a, r) {
  const tone = r.type === "income" ? "income" : "expense";
  const label = `${lock(r)}${labelOf(r)} (scheduled)`;
  const details = (x) => [money(x), subName(x), note(x.description)];
  if (line.action === "deleted") {
    return { icon: "🗑️", title: `${A} deleted ${label}`, body: [...details(b), scheduleOf(b)].filter(Boolean).join(" · "), tone, signed: true };
  }
  const href = `#month/${monthFor(a)}/${line.subject}`;
  if (line.action === "added") {
    const when = a.frequency === "once" ? scheduleOf(a) : `${scheduleOf(a)} from ${shortDate(a.starts_on)}`;
    return { icon: "🗓️", title: `${A} scheduled ${lock(a)}${labelOf(a)}`, body: [...details(a), when].filter(Boolean).join(" · "), href, tone, signed: true };
  }
  // Removed (an end date) or brought back (no end), nothing else changed.
  const onlyEnd = !a.continues && Object.keys({ ...a, ...b }).every((k) => ["ended_on", "updated_at", "updated_by"].includes(k) || !changed(b, a, k));
  if (onlyEnd && a.ended_on && !b.ended_on) {
    return { icon: "⏹️", title: `${A} removed ${label}`, body: [...details(a), `ends ${shortDate(a.ended_on)}`].filter(Boolean).join(" · "), href, tone, signed: true };
  }
  if (onlyEnd && !a.ended_on) {
    return { icon: "↩️", title: `${A} brought back ${label}`, body: [...details(a), scheduleOf(a)].filter(Boolean).join(" · "), href, tone, signed: true };
  }
  // Edited: what changed, then the rest. Continued from a date (the old one ended, a new one
  // starts; before is the old one as it was): "from 1 Nov". A one-time payment's new date shows
  // as its schedule ("on 14 Oct → on 20 Oct").
  const amount = Number(b.amount) !== Number(a.amount) || b.currency !== a.currency;
  const once = a.frequency === "once" && b.frequency === "once";
  const schedule = ["frequency", "day", "month", "ended_on"].some((k) => changed(b, a, k)) || (once && changed(b, a, "starts_on"));
  const parts = [
    amount ? `${money(b)} → ${money(a)}` : money(a),
    labelOf(b) !== labelOf(a) ? `was ${labelOf(b)}` : null,
    changed(b, a, "subcategory_id") ? `${subName(b) || "no subcategory"} → ${subName(a) || "none"}` : subName(a),
    noteChange(b.description, a.description),
    schedule ? `${scheduleOf(b)} → ${scheduleOf(a)}` : null,
    changed(b, a, "payment_method_id") || changed(b, a, "receiving_method_id") ? `${methodName(b) || "no method"} → ${methodName(a) || "none"}` : null,
    changed(b, a, "who") ? `${byWhom(b.who)} → ${memberName(a.who) || "someone"}` : null,
    a.continues ? `from ${shortDate(a.starts_on)}` : !once && changed(b, a, "starts_on") ? `starts ${shortDate(b.starts_on)} → ${shortDate(a.starts_on)}` : null,
    privacyChange(b, a),
  ];
  return { icon: "✏️", title: `${A} edited ${label}`, body: parts.filter(Boolean).join(" · "), href, tone, signed: true };
}

function skipLine(line, A, r) {
  const item = r.item;
  const tone = item?.type === "income" ? "income" : "expense";
  const body = [item ? money(item) : null, item ? note(item.description) : null, `due ${shortDate(r.due_on)}`].filter(Boolean).join(" · ");
  return {
    icon: line.action === "deleted" ? "↩️" : "⏭️",
    title: `${A} ${line.action === "deleted" ? "unskipped" : "skipped"} ${item ? `${lock(item)}${labelOf(item)}` : "a scheduled payment"}`,
    body, href: `#month/${firstOf(r.due_on)}/${r.item_id}`, tone, signed: true,
  };
}

// ---------- budgets ----------

// "Total EGP 45,000 → EGP 48,000 · 🍽️ Food 5K → 6K", at most three categories, then "+2 more".
function budgetLine(line, A, b, a) {
  const month = line.subject;
  const year = month.slice(0, 4) === isoLocal().slice(0, 4) ? "" : ` ${month.slice(0, 4)}`;
  const name = `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}${year}'s budget`;
  const was = new Map(Object.entries(b).map(([k, v]) => [k, Number(v)]));
  const now = new Map(Object.entries(a).map(([k, v]) => [k, Number(v)]));
  const cat = (id) => { const c = byId(state.categories, id); return c ? `${c.icon || "•"} ${c.name}` : "a category"; };
  const ids = [...new Set([...was.keys(), ...now.keys()])].filter((id) => (was.get(id) || 0) !== (now.get(id) || 0));
  const lines = ids.slice(0, 3).map((id) => (!was.has(id) ? `${cat(id)} ${compact(now.get(id))}`
    : !now.has(id) ? `${cat(id)} removed` : `${cat(id)} ${compact(was.get(id))} → ${compact(now.get(id))}`));
  if (ids.length > 3) lines.push(`+${ids.length - 3} more`);
  const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  const egp = (n) => fmtMoney(n, "EGP", { code: true });
  const total = !was.size ? `Total ${egp(sum(now))}` : !now.size ? `was ${egp(sum(was))}` : `Total ${egp(sum(was))} → ${egp(sum(now))}`;
  const verb = line.action === "added" ? "set" : line.action === "deleted" ? "cleared" : "changed";
  return {
    icon: line.action === "deleted" ? "🗑️" : "📅", title: `${A} ${verb} ${name}`, body: [total, ...lines].join(" · "),
    href: line.action === "deleted" ? null : `#month/${month}`, tone: "", signed: false,
  };
}

// ---------- the household ----------

function memberLine(line, A, b, a, r) {
  const href = "#profile/household";
  const self = line.subject === line.actor;
  const you = line.actor === state.me?.email;
  const aboutYou = line.subject === state.me?.email; // "Tamer made you an owner"
  const name = aboutYou ? "you" : r.display_name || line.subject;
  const base = { icon: "👤", href, tone: "", signed: false };
  if (line.action === "added") return { ...base, title: `${A} invited ${name}`, body: line.subject };
  if (line.action === "deleted") return { ...base, title: `${A} cancelled ${aboutYou ? "your" : `${name}'s`} invite`, body: line.subject };
  if (!b.joined_at && a.joined_at) return { ...base, title: `${A} joined the household`, body: "" };
  if (changed(b, a, "role")) {
    const whom = self ? (you ? "yourself" : "themselves") : name;
    return { ...base, title: `${A} made ${whom} ${a.role === "owner" ? "an owner" : "a member"}`, body: "" };
  }
  if (changed(b, a, "active")) return { ...base, title: `${A} ${a.active ? "reactivated" : "deactivated"} ${name}`, body: "" };
  const whose = self ? (you ? "your" : "their") : `${b.display_name}'s`;
  return { ...base, title: `${A} changed ${whose} name`, body: `${b.display_name} → ${a.display_name}` };
}

// ---------- Settings lists ----------

const NOUN = {
  categories: "a category", subcategories: "a subcategory", payment_methods: "a payment method",
  income_sources: "an income source", receiving_methods: "a receiving method",
};

function listLine(line, A, b, a, r) {
  const named = (x) => {
    const own = `${x.icon ? `${x.icon} ` : ""}${x.name}`;
    if (line.source !== "subcategories") return own;
    const c = byId(state.categories, x.category_id);
    return c ? `${own} · in ${c.icon || "•"} ${c.name}` : own;
  };
  const noun = NOUN[line.source] || "a list item";
  const base = { icon: "⚙️", href: "#profile/settings", tone: "", signed: false };
  if (line.action === "added") return { ...base, title: `${A} added ${noun}`, body: named(a) };
  if (line.action === "deleted") return { ...base, title: `${A} deleted ${noun}`, body: named(b) };
  if (changed(b, a, "hidden") && !changed(b, a, "name") && !changed(b, a, "icon")) {
    return { ...base, title: a.hidden ? `${A} hid ${noun}` : `${A} showed ${noun} again`, body: named(a) };
  }
  return { ...base, title: `${A} renamed ${noun}`, body: `${named(b)} → ${named(a)}` };
}
