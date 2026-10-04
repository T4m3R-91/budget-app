// Profile: your account (password, sign-out), your points and the household leaderboard,
// notifications on this device, the Settings card (collapsed until opened), and the Excel download.

import { state } from "./state.js";
import { el, toast, friendlyError } from "./ui.js";
import { sb, fetchLeaderboard } from "./db.js";
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
    el("section", { class: "set-section" }, el("h3", { text: "Points" }), pointsBox()),
    el("section", { class: "set-section" }, el("h3", { text: "Notifications" }), el("div", { id: "push-box" })),
    settingsCard(),
    downloadSection(),
    el("p", { class: "app-version", id: "app-version", text: versionLine() }));
  loadBoard();
  paintPush();
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
  return el("section", { class: "set-section" },
    el("h3", { text: "Download" }),
    el("p", { class: "note", text: "Downloads everything as an Excel file with Transactions and Income tabs, in the same layout as your spreadsheet." }),
    button);
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
    toggle = el("button", {
      type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": `Notifications on ${here()}`,
      disabled: Boolean(pushBusy) || now === "blocked", onclick: () => flipPush(on),
    });
  }
  document.getElementById("push-box")?.replaceChildren(
    el("div", { class: "push-row" },
      el("div", { class: "push-text" },
        el("span", { class: "push-title", text: here().replace(/^t/, "T") }),
        el("span", { class: "muted small", text: line })),
      toggle),
    testButton());
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

function testResult({ devices: total, sent, removed, failed = [] }) {
  if (!total) return "None of your devices has notifications on yet. Turn them on above first.";
  const parts = [];
  if (sent) parts.push(`Sent to ${devices(sent)}. It should arrive in a few seconds.`);
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

  return el("section", { class: "set-section" },
    el("h3", { text: "Account" }),
    el("p", { class: "acct" }, el("strong", { text: state.me.display_name }), el("span", { class: "muted", text: ` · ${state.me.email}` })),
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
