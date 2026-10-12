// Profile, in groups of rows the way iPhone Settings lays them out: who you are, your points,
// notifications on this device, the household (owners invite, deactivate and change roles),
// display, the household's lists (settings.js), and your password and sign-out. Rows that need
// room open in place (rows.js). The Excel download lives at the foot of the Dashboard tab.

import { state, isActive, isOwner } from "./state.js";
import { el, toast, friendlyError } from "./ui.js";
import {
  sb, reloadLists, fetchLeaderboard, fetchNotifySettings, saveNotifySettings,
  inviteMember, cancelInvite, setMemberRole, setMemberActive, renameMe,
  fetchQuickAdd, quickAddOn, quickAddOff, quickAddLink,
} from "./db.js";
import { displayCard, listsCard } from "./settings.js";
import { appVersion } from "./offline.js";
import { support, deviceState, isIOS, prepareKey, turnOn, turnOff, sendTest } from "./push.js";
import { group, card, rowText, row, buttonRow, switchEl, disclosure, openRow } from "./rows.js";

let board = { status: "loading", rows: [] }; // loading | ready | missing | error
let period = "all_time"; // or "this_month"
let version = null; // e.g. "2.1.2", from sw.js; it only changes on Reload, which starts afresh

const versionLine = () => `Household Budget${version ? ` ${version}` : ""}`;

export function showProfile() {
  document.getElementById("screen-profile").replaceChildren(
    el("h2", { class: "screen-title", text: "Profile" }),
    headSection(),
    group("Activity", pointsBox()),
    group("Notifications", el("div", { id: "push-box", class: "pf-card" })),
    householdSection(),
    group("Display", displayCard()),
    group("Lists", listsCard()),
    accountSection(),
    el("p", { class: "app-version", id: "app-version", text: versionLine() }));
  loadBoard();
  paintPush();
  loadPrefs();
  loadQuick();
  prepareKey();
  if (!version) appVersion().then((v) => {
    version = v;
    const line = document.getElementById("app-version");
    if (line) line.textContent = versionLine();
  });
}

// ---------- you ----------

let renaming = false;
const paintHead = () => document.getElementById("profile-head")?.replaceWith(headSection());

// Your name as everyone sees it (you're the only one who can change it), with your email and role.
function headSection() {
  const me = state.me;
  const canRename = "role" in me;
  if (renaming) return el("div", { id: "profile-head", class: "pf-head" }, renameForm());
  return el("div", { id: "profile-head", class: "pf-head" },
    el("div", { class: "pf-avatar", "aria-hidden": "true", text: (me.display_name || "?").trim().charAt(0).toUpperCase() }),
    el("div", { class: "pf-who" },
      el("div", { class: "pf-name-row" },
        el("strong", { text: me.display_name }),
        canRename ? el("button", { type: "button", class: "link-btn", text: "Rename", onclick: () => { renaming = true; paintHead(); } }) : null),
      el("span", { class: "muted small pf-mail", text: canRename ? `${me.email} · ${statusOf(me)}` : me.email })));
}

function renameForm() {
  const input = el("input", { class: "text-input", maxlength: 40, value: state.me.display_name, "aria-label": "Your name" });
  setTimeout(() => input.focus(), 0);
  return el("form", {
    class: "inline-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return toast("Type a name.");
      if (!navigator.onLine) return toast("Renaming needs a connection.");
      try {
        await renameMe(name);
        await refreshPeople();
        renaming = false;
        toast("Name changed");
        showProfile(); // the leaderboard and household list show it too
      } catch (err) {
        toast(friendlyError(err));
      }
    },
  }, input,
  el("button", { type: "submit", class: "btn small secondary", text: "Save" }),
  el("button", { type: "button", class: "btn small secondary", text: "Cancel", onclick: () => { renaming = false; paintHead(); } }));
}

// The household's list again (after a change), and you in it.
async function refreshPeople() {
  await reloadLists();
  state.me = state.members.find((m) => m.email === state.me.email) || state.me;
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

// Your all-time total; it opens to the household ranked for the chosen period. The leader
// gets a star; ties share it, and nobody gets one while everyone is at zero.
function pointsBox() {
  const box = (...children) => el("div", { id: "points-box", class: "pf-card" }, children);
  const note = (...children) => el("p", { class: "muted small pf-pad" }, children);
  if (board.status === "loading") return box(note("Loading points…"));
  if (board.status === "missing") return box(note("Points aren't set up yet. Run points-migration.sql in Supabase to turn them on."));
  if (board.status === "error") {
    return box(note(`Couldn't load points. ${board.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: loadBoard })));
  }

  const mine = board.rows.find((r) => r.email === state.me.email);
  // Deactivated people keep their points but leave the leaderboard.
  const current = (r) => isActive(state.members.find((m) => m.email === r.email) || {});
  const ranked = board.rows.filter(current).sort((a, b) => b[period] - a[period] || a.display_name.localeCompare(b.display_name));
  const top = ranked[0]?.[period] || 0;

  return box(disclosure("points",
    el("div", { class: "pf-text" },
      el("span", { class: "pf-hint", text: "Your points · All time" }),
      el("strong", { class: "pf-big", text: fmtPoints(mine?.all_time) })),
    el("div", { class: "pf-pad" },
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
        })))));
}

// ---------- notifications ----------

let pushBusy = ""; // "on" or "off" while turning notifications on or off here

// Back from the phone's settings (where blocked notifications are allowed), or renewed as the app
// opened (push.js): show the new state.
document.addEventListener("visibilitychange", () => { if (!document.hidden) paintPush(); });
window.addEventListener("pushchange", () => paintPush());

const blockedHelp = () => isIOS()
  ? "Blocked. To allow them: iPhone Settings → Notifications → Budget"
  : "Blocked. Allow notifications for this site in the browser (the icon left of the address), then come back";

// This device's switch; with it on, your notification settings and a test button; on an iPhone,
// Apple Pay quick-add too.
async function paintPush() {
  if (!document.getElementById("push-box")) return;
  const can = support();
  const now = can === "ready" && !pushBusy ? await deviceState() : null;
  let hint = "Notifications come to this device";
  let toggle = null;
  let on = false;
  if (can === "home-screen") hint = "On iPhone, notifications come to the Home Screen app. Open Budget from your Home Screen and turn them on there";
  else if (can === "unsupported") hint = isIOS() ? "Notifications need iOS 16.4 or later" : "This browser can't show notifications";
  else {
    on = pushBusy ? pushBusy === "on" : now === "on";
    if (pushBusy) hint = pushBusy === "on" ? "Turning on…" : "Turning off…";
    else if (now === "blocked") hint = blockedHelp();
    toggle = switchEl(on, "Allow notifications on this device", () => flipPush(on), Boolean(pushBusy) || now === "blocked");
  }
  document.getElementById("push-box")?.replaceChildren(
    row("Allow on this device", hint, toggle),
    ...(on ? [disclosure("notif-settings", rowText("Notification settings"), ...prefRows()), buttonRow(testButton())] : []),
    ...(isIOS() ? quickRows() : []));
}

// ---------- your settings, for all your devices (reminders-migration.sql) ----------

const DEFAULT_PREFS = { reminders: true, reminder_hour: 9, show_amounts: true, partner_activity: true };
let prefs = { status: "loading" }; // loading | ready | missing | error, plus the settings when ready
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Cairo";

async function loadPrefs() {
  if (prefs.email !== state.me.email) prefs = { status: "loading", email: state.me.email };
  try {
    const row = await fetchNotifySettings();
    if (row === "missing") prefs = { status: "missing", email: state.me.email };
    else {
      prefs = { status: "ready", email: state.me.email, ...DEFAULT_PREFS, ...(row || {}) };
      // Reminders come at the hour where you are: this phone's time zone, if it's new.
      if (navigator.onLine && row?.time_zone !== timeZone()) saveNotifySettings({ time_zone: timeZone() }).catch(() => {});
    }
  } catch (e) {
    prefs = { status: "error", email: state.me.email, message: friendlyError(e) };
  }
  paintPush();
}

// Saved at once; put back if that fails.
async function setPref(patch) {
  if (!navigator.onLine) {
    toast("Changing notification settings needs a connection.");
    return paintPush();
  }
  const before = prefs;
  prefs = { ...prefs, ...patch };
  paintPush();
  try {
    await saveNotifySettings({ ...patch, time_zone: timeZone() });
  } catch (e) {
    prefs = before;
    paintPush();
    toast(friendlyError(e));
  }
}

// "9:00 AM", "12:00 PM", "12:00 AM" (midnight).
const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? "AM" : "PM"}`;

function prefRows() {
  const note = (...more) => [el("p", { class: "muted small pf-pad" }, ...more)];
  if (prefs.status === "loading") return note("Loading your notification settings…");
  if (prefs.status === "missing") return note("Reminders aren't set up yet. Run reminders-migration.sql in Supabase.");
  if (prefs.status === "error") {
    return note(`Couldn't load your notification settings. ${prefs.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: loadPrefs }));
  }
  const hour = el("select", {
    class: "hour-select", "aria-label": "Reminder time", value: String(prefs.reminder_hour),
    onchange: (e) => setPref({ reminder_hour: Number(e.target.value) }),
  }, Array.from({ length: 24 }, (_, h) => el("option", { value: String(h), text: hourLabel(h) })));
  return [
    row("Send budget reminders",
      prefs.reminders ? ["Every day at ", hour] : `Every day at ${hourLabel(prefs.reminder_hour)}`,
      switchEl(prefs.reminders, "Send budget reminders", () => setPref({ reminders: !prefs.reminders }))),
    row("Send partner activity", "When partner(s) add or change an entry",
      switchEl(prefs.partner_activity, "Send partner activity", () => setPref({ partner_activity: !prefs.partner_activity }))),
    // Applies to every notification (reminders and partner activity).
    row("Show amounts", "In notifications: 🏠 Rent · EGP 12,000",
      switchEl(prefs.show_amounts, "Show amounts", () => setPref({ show_amounts: !prefs.show_amounts }))),
  ];
}

// ---------- Apple Pay quick-add (apple_pay-quick-add-migration.sql) ----------
// On an iPhone, each Apple Pay payment can bring a "tap to save it" notification that opens the
// Add form filled in. It goes through a Shortcuts automation set up once by hand (Apple lets no
// app set one up itself): turning this on makes your own link for it and shows the steps, until
// your first payment has come through. Off: the steps go, and the link stops working (on again
// makes a new one). The row is only drawn on iPhones.

let quick = { status: "loading" }; // loading | ready | missing | error; ready: row (null = off), busy

async function loadQuick() {
  try {
    const row = await fetchQuickAdd();
    quick = row === "missing" ? { status: "missing" } : { status: "ready", row };
  } catch (e) {
    quick = { status: "error", message: friendlyError(e) };
  }
  paintPush();
}

async function flipQuick() {
  if (!navigator.onLine) return toast("Changing this needs a connection.");
  const wasOn = Boolean(quick.row);
  quick = { ...quick, busy: true };
  paintPush();
  try {
    if (wasOn) await quickAddOff();
    else await quickAddOn();
    quick = { status: "ready", row: await fetchQuickAdd() };
    if (!wasOn) toast("Now the one-time setup, below, on your iPhone.");
  } catch (e) {
    quick = { ...quick, busy: false };
    toast(friendlyError(e));
  }
  paintPush();
}

// Shown once apple_pay-quick-add-migration.sql has run (and its state could be read).
function quickRows() {
  if (quick.status !== "ready") return [];
  const on = quick.row;
  const toggle = row("Apple Pay quick-add", null, switchEl(Boolean(on), "Apple Pay quick-add", flipQuick, Boolean(quick.busy)));
  return on && !on.first_payment_at ? [toggle, setupSteps(quickAddLink(on.key))] : [toggle];
}

async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied. Paste it in step 4.");
  } catch {
    toast("Couldn't copy it. Press and hold the link to copy it.");
  }
}

// Your link, then the steps, in the words the Shortcuts app uses.
function setupSteps(link) {
  const li = (...parts) => el("li", {}, ...parts);
  const b = (text) => el("strong", { text });
  return el("div", { class: "pf-steps" },
    el("div", { class: "pf-row" },
      el("div", { class: "pf-text" },
        el("b", { text: "Your link" }),
        el("span", { class: "quick-link", text: link }),
        el("span", { class: "pf-hint", text: "Only yours, don't share it" })),
      el("button", { type: "button", class: "btn secondary small", text: "Copy", onclick: () => copyLink(link) })),
    el("p", { class: "pf-hint pf-pad", text: "One-time setup on your iPhone (iOS 17 or later)" }),
    el("ol", {},
      li("Open the ", b("Shortcuts"), " app, go to ", b("Automation"), ", tap ", b("+"), " and choose ", b("Wallet")),
      li("Leave your cards selected, choose ", b("Run Immediately"), ", then tap ", b("Next")),
      li("Tap ", b("New Blank Automation"), ", then ", b("Add Action"), ", and pick ", b("Get Contents of URL")),
      li("Tap ", b("URL"), " and paste your link"),
      li("Tap ", b("›"), " to show more. Set ", b("Method"), " to ", b("POST"), " and ", b("Request Body"), " to ", b("JSON"),
        ", then add three ", b("Text"), " fields:",
        el("ul", {},
          li(b("amount"), ": tap its value, choose ", b("Shortcut Input"), ", then ", b("Amount")),
          li(b("merchant"), ": ", b("Shortcut Input"), ", then ", b("Merchant")),
          li(b("card"), ": ", b("Shortcut Input"), ", then ", b("Card"), " (it may say Card or Pass)"))),
      li("Tap ", b("Done"))),
    el("p", { class: "pf-hint pf-pad", text: "Then pay once with Apple Pay in a shop. A “tap to save it” notification arrives (notifications must be on for this iPhone), and these steps go away. Running the automation by hand in Shortcuts sends no payment: you get a test notification instead" }));
}

function flipPush(wasOn) {
  if (!wasOn && !navigator.onLine) return toast("Turning notifications on needs a connection.");
  const job = wasOn ? turnOff() : turnOn(); // turnOn asks for permission at once, while the tap still counts
  pushBusy = wasOn ? "off" : "on";
  paintPush();
  job.then((result) => {
    if (result === "blocked") toast("Notifications were blocked. They can be allowed again in settings.");
  }).catch((e) => toast(friendlyError(e))).finally(() => {
    pushBusy = "";
    paintPush();
  });
}

const devices = (n) => `${n} device${n === 1 ? "" : "s"}`;

// When something's due (and reminders are on), the test is today's reminder, as it comes in the
// morning; otherwise a plain "It works".
function testResult({ devices: total, sent, removed, failed = [], reminder }) {
  if (!total) return "None of your devices has notifications on yet. Turn them on above first.";
  const parts = [];
  if (sent && reminder) parts.push(`Sent today's reminder (${reminder} due) to ${devices(sent)}.`);
  else if (sent) parts.push(`Sent to ${devices(sent)}. It should arrive in a few seconds.`);
  if (removed) parts.push(`Removed ${devices(removed)} that no longer take${removed === 1 ? "s" : ""} notifications.`);
  if (failed.length) parts.push(`Couldn't reach ${devices(failed.length)} (${failed[0].slice(0, 60)}).`);
  if (!sent && removed && !failed.length) parts.push("Turn them on again above.");
  return parts.join(" ");
}

// Sends to every device of yours that has notifications on, this one included.
function testButton() {
  const label = "Send a test notification";
  const button = el("button", {
    type: "button", class: "btn secondary full", text: label,
    onclick: async () => {
      if (!navigator.onLine) return toast("Sending a test needs a connection.");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        toast(testResult(await sendTest()));
      } catch (e) {
        toast(friendlyError(e));
      }
      button.disabled = false;
      button.textContent = label;
    },
  });
  return button;
}

// ---------- the household (household-migration.sql) ----------
// Everyone sees who's in it; owners invite people, change roles, deactivate and reactivate.

let menuFor = null;   // the person whose options are open
let armed = null;     // "deactivate|email" or "cancel|email": waiting for a second tap
let inviting = false; // the invite form is open
let busy = false;     // a change is being saved

const statusOf = (m) => (!isActive(m) ? "Deactivated" : !m.joined_at ? "Invited" : m.role === "owner" ? "Owner" : "Member");
const paintHousehold = () => document.getElementById("household")?.replaceWith(householdSection());

function householdSection() {
  if (menuFor || inviting) openRow("members"); // a person's options or the invite form are open: keep the list open
  const rows = !("role" in state.me)
    ? [el("p", { class: "muted small pf-pad", text: "Managing the household isn't set up yet. Run household-migration.sql in Supabase." })]
    : [disclosure("members", rowText("Members"),
        el("div", { class: "li-list pf-pad" }, people().map(personRow)),
        isOwner() ? inviteBlock() : null)];
  const section = group("Household", card(...rows));
  section.id = "household";
  return section;
}

// Owners, members, invites still waiting, then people who were deactivated.
function people() {
  const rank = (m) => (!isActive(m) ? 3 : !m.joined_at ? 2 : m.role === "owner" ? 0 : 1);
  return state.members.slice().sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
}

function personRow(m) {
  const me = m.email === state.me.email;
  const open = menuFor === m.email;
  const status = statusOf(m);
  return el("div", { class: `hh-person${isActive(m) ? "" : " is-former"}` },
    el("div", { class: "li-row" },
      el("div", { class: "li-main" },
        el("div", { class: "li-name", text: me ? `${m.display_name} (you)` : m.display_name }),
        el("div", { class: "muted small hh-email", text: m.email })),
      el("span", { class: `badge hh-${status.toLowerCase()}`, text: status }),
      !isOwner() ? null
        : me ? el("span", { class: "hh-spacer", "aria-hidden": "true" }) // keeps your pill in line with the others'
        : el("button", {
            type: "button", class: "icon-btn", text: "⋯", "aria-label": `Options for ${m.display_name}`, "aria-expanded": String(open),
            onclick: () => { menuFor = open ? null : m.email; armed = null; paintHousehold(); },
          })),
    open ? personMenu(m) : null);
}

// A button that needs a second tap ("Tap again to deactivate").
function twoTap(key, label, again, action) {
  return el("button", {
    type: "button", class: "btn small danger", disabled: busy, text: armed === key ? again : label,
    onclick: () => (armed === key ? action() : ((armed = key), paintHousehold())),
  });
}

function personMenu(m) {
  const name = m.display_name;
  const button = (label, cls, action) => el("button", { type: "button", class: `btn small ${cls}`, disabled: busy, text: label, onclick: action });
  const buttons = [];
  let note;
  if (!isActive(m)) {
    buttons.push(button("Reactivate", "primary", () => change(() => setMemberActive(m.email, true), `${name} can use the app again`)));
    note = `${name}'s entries kept their name. Reactivating gives them access again.`;
  } else {
    if (m.joined_at) {
      const toOwner = m.role !== "owner";
      buttons.push(button(toOwner ? "Make owner" : "Make member", "secondary",
        () => change(() => setMemberRole(m.email, toOwner ? "owner" : "member"), `${name} is now ${toOwner ? "an owner" : "a member"}`)));
    } else {
      buttons.push(twoTap(`cancel|${m.email}`, "Cancel invite", "Tap again to cancel", () => change(() => cancelInvite(m.email), `Invite to ${name} cancelled`)));
    }
    buttons.push(twoTap(`deactivate|${m.email}`, "Deactivate", "Tap again to deactivate", () => change(() => setMemberActive(m.email, false), `${name} was deactivated`)));
    note = m.joined_at
      ? [`Deactivating ends ${name}'s access at once and stops their notifications.`, "Their entries stay, under their name."]
      : `${name} hasn't accepted the invite yet.`;
  }
  const lines = [note].flat().flatMap((line, i) => (i ? [el("br"), line] : [line])); // one line each
  return el("div", { class: "hh-menu" }, el("div", { class: "hh-actions" }, buttons), el("p", { class: "muted small" }, lines));
}

// Saves a change, then shows the household as it is now.
async function change(job, done) {
  if (!navigator.onLine) return toast("Changing the household needs a connection.");
  busy = true;
  paintHousehold();
  try {
    await job();
    await refreshPeople();
    menuFor = null;
    armed = null;
    paintPoints(); // the leaderboard follows (deactivated people leave it)
    toast(done);
  } catch (e) {
    toast(friendlyError(e));
  }
  busy = false;
  paintHousehold();
}

function inviteBlock() {
  if (!inviting) {
    return el("button", {
      type: "button", class: "pf-row pf-tap",
      onclick: () => { inviting = true; paintHousehold(); document.getElementById("hh-email")?.focus(); },
    }, rowText("Invite someone"), el("span", { class: "pf-chev", "aria-hidden": "true", text: "›" }));
  }
  const email = el("input", { id: "hh-email", class: "text-input", type: "email", inputmode: "email", autocomplete: "off", placeholder: "Their email", "aria-label": "Their email" });
  const name = el("input", { class: "text-input", maxlength: 40, placeholder: "Their name, e.g. Sara", "aria-label": "Their name" });
  const send = el("button", { type: "submit", class: "btn primary small", text: "Send invite" });
  return el("form", {
    class: "hh-invite pf-pad", novalidate: true, // the app says what's missing, the same way on every phone
    onsubmit: async (e) => {
      e.preventDefault();
      const address = email.value.trim().toLowerCase();
      const who = name.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return toast("Type their email address.");
      if (!who) return toast("Type their name.");
      if (!navigator.onLine) return toast("Inviting needs a connection.");
      send.disabled = true;
      send.textContent = "Sending…";
      try {
        const result = await inviteMember(address, who);
        await refreshPeople();
        inviting = false;
        toast(result?.emailed === false
          ? `${who} added. They already have an account, so they sign in with it (or use "Forgot password?").`
          : `Invite sent to ${address}. ${who} shows as Invited until they sign in.`);
        paintHousehold();
      } catch (err) {
        toast(friendlyError(err));
        send.disabled = false;
        send.textContent = "Send invite";
      }
    },
  },
  el("p", { class: "muted small", text: "They'll get an email with a link to choose a password, and join as a member." }),
  email, name,
  el("div", { class: "hh-actions" },
    el("button", { type: "button", class: "btn secondary small", text: "Cancel", onclick: () => { inviting = false; paintHousehold(); } }),
    send));
}

// ---------- account ----------

function accountSection() {
  const pw = el("input", {
    class: "text-input", type: "password", autocomplete: "new-password", minlength: 8,
    placeholder: "New password (8+ characters)", "aria-label": "New password",
  });
  const pwForm = el("form", {
    class: "inline-form pf-pad",
    onsubmit: async (e) => {
      e.preventDefault();
      if (pw.value.length < 8) return toast("Use at least 8 characters.");
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) return toast(friendlyError(error));
      pw.value = "";
      toast("Password changed");
    },
  }, pw, el("button", { type: "submit", class: "btn small secondary", text: "Change" }));

  return group("Account", card(
    disclosure("password", rowText("Change password"), pwForm),
    buttonRow(el("button", {
      type: "button", class: "btn danger tint full", text: "Sign out",
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        await turnOff(); // this device stops getting your notifications
        sb.auth.signOut();
      },
    }))));
}
