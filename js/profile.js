// Profile: your account (password, sign-out), your points and the household leaderboard, the
// Settings card (collapsed until opened), and the Excel download.

import { state } from "./state.js";
import { el, toast, friendlyError } from "./ui.js";
import { sb, fetchLeaderboard } from "./db.js";
import { settingsCard } from "./settings.js";
import { exportToExcel } from "./export.js";
import { appVersion } from "./offline.js";

let board = { status: "loading", rows: [] }; // loading | ready | missing | error
let period = "all_time"; // or "this_month"
let version = null; // e.g. "2.1.2", from sw.js; it only changes on Reload, which starts afresh

const versionLine = () => `Household Budget${version ? ` ${version}` : ""}`;

export function showProfile() {
  document.getElementById("screen-profile").replaceChildren(
    el("h2", { class: "screen-title", text: "Profile" }),
    accountSection(),
    el("section", { class: "set-section" }, el("h3", { text: "Points" }), pointsBox()),
    settingsCard(),
    downloadSection(),
    el("p", { class: "app-version", id: "app-version", text: versionLine() }));
  loadBoard();
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
    el("button", { type: "button", class: "btn secondary full", text: "Sign out", onclick: () => sb.auth.signOut() }));
}
