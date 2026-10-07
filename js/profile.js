// Profile: your account (name, password, sign-out), the household (owners invite, deactivate and
// change roles), your points and the household leaderboard, notifications on this device, the
// Settings card (collapsed until opened), and the Excel download with when the last automatic
// backup ran.

import { state, isActive, isOwner } from "./state.js";
import { el, toast, friendlyError, friendlyDate, isoLocal } from "./ui.js";
import {
  sb, reloadLists, fetchLeaderboard, fetchNotifySettings, saveNotifySettings, fetchBackupStatus,
  inviteMember, cancelInvite, setMemberRole, setMemberActive, renameMe,
  fetchQuickAdd, quickAddOn, quickAddOff, quickAddLink,
} from "./db.js";
import { settingsCard } from "./settings.js";
import { exportToExcel } from "./export.js";
import { appVersion } from "./offline.js";
import { support, deviceState, deviceName, isIOS, prepareKey, turnOn, turnOff, sendTest } from "./push.js";

let board = { status: "loading", rows: [] }; // loading | ready | missing | error
let period = "all_time"; // or "this_month"
let version = null; // e.g. "2.1.2", from sw.js; it only changes on Reload, which starts afresh

const versionLine = () => `Household Budget${version ? ` ${version}` : ""}`;

export function showProfile() {
  document.getElementById("screen-profile").replaceChildren(
    el("h2", { class: "screen-title", text: "Profile" }),
    accountSection(),
    householdSection(),
    el("section", { class: "set-section" }, el("h3", { text: "Points" }), pointsBox()),
    el("section", { class: "set-section" }, el("h3", { text: "Notifications" }), el("div", { id: "push-box" })),
    settingsCard(),
    downloadSection(),
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

// ---------- download ----------

function downloadSection() {
  const button = el("button", {
    type: "button", class: "btn secondary full", text: "Download Excel",
    onclick: async () => {
      button.disabled = true;
      button.textContent = "Preparing file…";
      try {
        const counts = await exportToExcel();
        toast(`Downloaded ${counts.expenses} expenses and ${counts.income} income entries`);
      } catch (e) {
        toast(friendlyError(e));
      }
      button.disabled = false;
      button.textContent = "Download Excel";
    },
  });
  const section = el("section", { class: "set-section" },
    el("h3", { text: "Download" }),
    el("p", { class: "note", text: "Downloads everything as an Excel file with Transactions and Income tabs, in the same layout as your spreadsheet." }),
    button,
    el("p", { id: "backup-line", class: "muted small backup-line", hidden: true }));
  paintBackupLine();
  return section;
}

// The nightly automatic backup (backup-repo/): when it last ran. Nothing shown until
// backups-migration.sql has run; a warning when it's more than a day and a half old.
async function paintBackupLine() {
  let status;
  try { status = await fetchBackupStatus(); } catch { return; }
  const line = document.getElementById("backup-line");
  if (!line || status === "missing") return;
  line.hidden = false;
  if (!status) {
    line.textContent = "Automatic backups: waiting for the first one.";
    return;
  }
  const at = new Date(status.last_backup_at);
  const day = isoLocal(at);
  const when = friendlyDate(day).replace(/^Today$/, "today").replace(/^Yesterday$/, "yesterday");
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const stale = Date.now() - at.getTime() > 36 * 3600 * 1000;
  line.classList.toggle("stale", stale);
  line.textContent = stale
    ? `⚠ Last automatic backup: ${when}, ${time}. Check the backup repository on GitHub.`
    : `Last automatic backup: ${when} ${time} ✓`;
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
  const box = (...children) => el("div", { id: "points-box" }, children);
  if (board.status === "loading") return box(el("p", { class: "muted small", text: "Loading points…" }));
  if (board.status === "missing") {
    return box(el("p", { class: "muted small", text: "Points aren't set up yet. Run points-migration.sql in Supabase to turn them on." }));
  }
  if (board.status === "error") {
    return box(el("p", { class: "muted small" }, `Couldn't load points. ${board.message} `,
      el("button", { type: "button", class: "link-btn", text: "Try again", onclick: loadBoard })));
  }

  const mine = board.rows.find((r) => r.email === state.me.email);
  // Deactivated people keep their points but leave the leaderboard.
  const current = (r) => isActive(state.members.find((m) => m.email === r.email) || {});
  const ranked = board.rows.filter(current).sort((a, b) => b[period] - a[period] || a.display_name.localeCompare(b.display_name));
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

// ---------- notifications ----------

let pushBusy = ""; // "on" or "off" while turning notifications on or off here

// Back from the phone's settings (where blocked notifications are allowed), or renewed as the app
// opened (push.js): show the new state.
document.addEventListener("visibilitychange", () => { if (!document.hidden) paintPush(); });
window.addEventListener("pushchange", () => paintPush());

const here = () => (isIOS() ? `this ${deviceName()}` : "this browser");
const blockedHelp = () => isIOS()
  ? "Blocked. To allow them: iPhone Settings → Notifications → Budget."
  : "Blocked. Allow notifications for this site in the browser (the icon left of the address), then come back.";

// This device's switch, then the test. On iPhone, only the Home Screen app can get notifications.
async function paintPush() {
  if (!document.getElementById("push-box")) return;
  const can = support();
  const now = can === "ready" && !pushBusy ? await deviceState() : null;
  let line;
  let toggle = null;
  if (can === "home-screen") line = "On iPhone, notifications come to the Home Screen app. Open Budget from your Home Screen and turn them on there.";
  else if (can === "unsupported") line = isIOS() ? "Notifications need iOS 16.4 or later." : "This browser can't show notifications.";
  else {
    const on = pushBusy ? pushBusy === "on" : now === "on";
    line = pushBusy === "on" ? "Turning on…" : pushBusy === "off" ? "Turning off…"
      : now === "on" ? `On. Notifications come to ${here()}.`
      : now === "blocked" ? blockedHelp()
      : `Off. Turn on to get notifications on ${here()}.`;
    toggle = switchEl(on, `Notifications on ${here()}`, () => flipPush(on), Boolean(pushBusy) || now === "blocked");
  }
  document.getElementById("push-box")?.replaceChildren(
    pushRow(here().replace(/^t/, "T"), el("span", { class: "muted small", text: line }), toggle),
    ...prefRows(),
    testButton());
}

const pushRow = (title, line, control) =>
  el("div", { class: "push-row" },
    el("div", { class: "push-text" }, el("span", { class: "push-title", text: title }), line),
    control);

const switchEl = (on, label, onclick, disabled = false) =>
  el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label, disabled, onclick });

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
  const note = (text, ...more) => [el("p", { class: "muted small push-note" }, text, ...more)];
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
  // Show amounts first: it applies to every notification (reminders and partner activity).
  return [
    pushRow("Show amounts",
      el("span", { class: "muted small", text: prefs.show_amounts ? "In notifications: 🏠 Rent · EGP 12,000." : "Off. Notifications show names only." }),
      switchEl(prefs.show_amounts, "Show amounts", () => setPref({ show_amounts: !prefs.show_amounts }))),
    pushRow("Reminders",
      prefs.reminders
        ? el("span", { class: "muted small" }, "What's due today or overdue, every day at ", hour, ", and a nudge after a week with no entries.")
        : el("span", { class: "muted small", text: "Off. No reminders are sent." }),
      switchEl(prefs.reminders, "Reminders", () => setPref({ reminders: !prefs.reminders }))),
    pushRow("Partner activity",
      el("span", {
        class: "muted small",
        text: prefs.partner_activity ? "When partner(s) add or change an entry, a scheduled payment or a budget." : "Off. Nothing is sent when partner(s) add or change things.",
      }),
      switchEl(prefs.partner_activity, "Partner activity", () => setPref({ partner_activity: !prefs.partner_activity }))),
    ...quickRows(),
  ];
}

// ---------- Apple Pay quick-add (apple_pay-quick-add-migration.sql) ----------
// On an iPhone, each Apple Pay payment can bring a "tap to save it" notification that opens the
// Add form filled in. It goes through a Shortcuts automation set up once by hand (Apple lets no
// app set one up itself): turning this on makes your own link for it and shows the steps, until
// your first payment has come through. Off: the steps go, and the link stops working (on again
// makes a new one).

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

// "today, 2:14 PM" / "3 Oct, 9:05 AM"
const atTime = (iso) => {
  const d = new Date(iso);
  return `${friendlyDate(isoLocal(d)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase())}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

// Shown once apple_pay-quick-add-migration.sql has run (and its state could be read).
function quickRows() {
  if (quick.status !== "ready") return [];
  const row = quick.row;
  const line = !row ? "Off. On iPhone, get a “tap to save it” notification after each Apple Pay payment. Needs a one-time setup."
    : row.first_payment_at ? `On. Last Apple Pay payment: ${atTime(row.last_payment_at)}.`
    : "On. Finish the one-time setup below; it takes about 2 minutes.";
  const toggle = pushRow("Apple Pay quick-add", el("span", { class: "muted small", text: line }),
    switchEl(Boolean(row), "Apple Pay quick-add", flipQuick, Boolean(quick.busy)));
  return row && !row.first_payment_at ? [toggle, setupSteps(quickAddLink(row.key))] : [toggle];
}

async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied. Paste it in step 5.");
  } catch {
    toast("Couldn't copy it. Press and hold the link below to copy it.");
  }
}

// The steps, in the words the Shortcuts app uses.
function setupSteps(link) {
  const li = (...parts) => el("li", {}, ...parts);
  const b = (text) => el("strong", { text });
  return el("div", { class: "quick-setup" },
    el("p", { class: "quick-head", text: "One-time setup on your iPhone (iOS 17 or later)" }),
    el("ol", {},
      li("Copy your link. ", el("button", { type: "button", class: "btn secondary small", text: "Copy link", onclick: () => copyLink(link) }),
        el("span", { class: "quick-link", text: link }),
        el("span", { class: "muted", text: "It's only yours: don't share it." })),
      li("Open the ", b("Shortcuts"), " app, go to ", b("Automation"), ", tap ", b("+"), " and choose ", b("Transaction"), "."),
      li("Leave your cards selected, choose ", b("Run Immediately"), ", then tap ", b("Next"), "."),
      li("Tap ", b("New Blank Automation"), ", then ", b("Add Action"), ", and pick ", b("Get Contents of URL"), "."),
      li("Tap ", b("URL"), " and paste your link."),
      li("Tap ", b("›"), " to show more. Set ", b("Method"), " to ", b("POST"), " and ", b("Request Body"), " to ", b("JSON"),
        ", then add three ", b("Text"), " fields:",
        el("ul", {},
          li(b("amount"), ": tap its value, choose ", b("Shortcut Input"), ", then ", b("Amount")),
          li(b("merchant"), ": ", b("Shortcut Input"), ", then ", b("Merchant")),
          li(b("card"), ": ", b("Shortcut Input"), ", then ", b("Card"), " (it may say Card or Pass)"))),
      li("Tap ", b("Done"), ".")),
    el("p", { class: "muted small", text: "Then pay once with Apple Pay in a shop. A “tap to save it” notification arrives (notifications must be on for this iPhone, at the top of this section), and these steps go away. Running the automation by hand in Shortcuts sends no payment, so it only says “Your link works”." }));
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
  const label = "Send a test to my devices";
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

  // Your name as everyone sees it (you're the only one who can change it).
  const nameLine = renaming ? renameForm() : el("p", { class: "acct" },
    el("strong", { text: state.me.display_name }), el("span", { class: "muted", text: ` · ${state.me.email}` }),
    "role" in state.me ? el("button", { type: "button", class: "link-btn acct-rename", text: "Rename", onclick: () => { renaming = true; paintAccount(); } }) : null);

  return el("section", { class: "set-section", id: "account" },
    el("h3", { text: "Account" }),
    nameLine,
    pwForm,
    el("button", {
      type: "button", class: "btn secondary full", text: "Sign out",
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        await turnOff(); // this device stops getting your notifications
        sb.auth.signOut();
      },
    }));
}

let renaming = false;
const paintAccount = () => document.getElementById("account")?.replaceWith(accountSection());

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
  el("button", { type: "button", class: "btn small secondary", text: "Cancel", onclick: () => { renaming = false; paintAccount(); } }));
}

// The household's list again (after a change), and you in it.
async function refreshPeople() {
  await reloadLists();
  state.me = state.members.find((m) => m.email === state.me.email) || state.me;
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
  const body = !("role" in state.me)
    ? [el("p", { class: "muted small", text: "Managing the household isn't set up yet. Run household-migration.sql in Supabase." })]
    : [
        el("div", { class: "li-list" }, people().map(personRow)),
        isOwner() ? inviteBlock() : el("p", { class: "muted small hh-note", text: "Owners can invite or deactivate people." }),
      ];
  return el("section", { class: "set-section", id: "household" }, el("h3", { text: "Household" }), ...body);
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
      isOwner() && !me
        ? el("button", {
            type: "button", class: "icon-btn", text: "⋯", "aria-label": `Options for ${m.display_name}`, "aria-expanded": String(open),
            onclick: () => { menuFor = open ? null : m.email; armed = null; paintHousehold(); },
          })
        : null),
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
      ? `Deactivating ends ${name}'s access at once and stops their notifications. Their entries stay, under their name.`
      : `${name} hasn't accepted the invite yet.`;
  }
  return el("div", { class: "hh-menu" }, el("div", { class: "hh-actions" }, buttons), el("p", { class: "muted small", text: note }));
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
      type: "button", class: "btn secondary full hh-invite-btn", text: "+ Invite someone",
      onclick: () => { inviting = true; paintHousehold(); document.getElementById("hh-email")?.focus(); },
    });
  }
  const email = el("input", { id: "hh-email", class: "text-input", type: "email", inputmode: "email", autocomplete: "off", placeholder: "Their email", "aria-label": "Their email" });
  const name = el("input", { class: "text-input", maxlength: 40, placeholder: "Their name, e.g. Sara", "aria-label": "Their name" });
  const send = el("button", { type: "submit", class: "btn primary small", text: "Send invite" });
  return el("form", {
    class: "hh-invite", novalidate: true, // the app says what's missing, the same way on every phone
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
