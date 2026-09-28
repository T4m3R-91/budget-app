// Starts the app: sign-in, loading the household's lists, and switching between tabs.

import { configured, sb, reloadLists } from "./db.js";
import { state } from "./state.js";
import { el, friendlyError, applyTheme } from "./ui.js";
import { showAdd, showEdit } from "./entry.js";
import { showHistory } from "./history.js";
import { showDashboard } from "./dashboard.js";
import { showProfile } from "./profile.js";
import { showBudget, showBudgetEditor } from "./budget.js";

window.__appStarted = true;

const $ = (id) => document.getElementById(id);
const TABS = { add: showAdd, history: showHistory, dashboard: showDashboard, budget: showBudget, profile: showProfile };
const SCREENS = ["boot", "setup", "login", "notmember", "budgetform", ...Object.keys(TABS)];
const WITH_ACTION_BAR = ["add", "budgetform"]; // screens with a pinned Save bar

function showScreen(name, activeTab = name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  const inApp = name in TABS || name === "budgetform";
  $("tabbar").hidden = !inApp;
  document.body.classList.toggle("in-app", inApp);
  document.body.classList.toggle("has-action-bar", WITH_ACTION_BAR.includes(name));
  document.querySelectorAll("#tabbar a").forEach((a) => {
    const on = a.dataset.tab === activeTab;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.querySelector("main").scrollTop = 0;
}

function route() {
  if (!state.me) return;
  const hash = location.hash || "#add";
  if (hash.startsWith("#edit/")) {
    showScreen("add", "history");
    showEdit(decodeURIComponent(hash.slice(6)));
    return;
  }
  if (hash.startsWith("#budget/")) {
    showScreen("budgetform", "budget");
    showBudgetEditor(hash.slice(8));
    return;
  }
  if (hash === "#settings") { // Settings now lives in Profile; old links and bookmarks land there
    location.replace("#profile");
    return;
  }
  const tab = hash.slice(1) in TABS ? hash.slice(1) : "add";
  showScreen(tab);
  TABS[tab]();
}

function showBootMessage(text, retry) {
  showScreen("boot");
  const parts = [text];
  if (retry) parts.push(el("br"), el("button", { type: "button", class: "btn secondary small", text: "Try again", onclick: retry }));
  $("boot-message").replaceChildren(...parts);
}

function showLogin(message = "") {
  state.me = null;
  showScreen("login");
  const email = el("input", { class: "text-input", type: "email", autocomplete: "username", inputmode: "email", required: true, id: "login-email" });
  const password = el("input", { class: "text-input", type: "password", autocomplete: "current-password", required: true, id: "login-password" });
  const error = el("p", { class: "form-error", role: "alert", text: message });
  const button = el("button", { type: "submit", class: "btn primary full", text: "Sign in" });

  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      button.textContent = "Signing in…";
      error.textContent = "";
      const { data, error: err } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
      if (err) {
        error.textContent = /invalid login/i.test(err.message) ? "Wrong email or password." : friendlyError(err);
        button.disabled = false;
        button.textContent = "Sign in";
        return;
      }
      await enterApp(data.session);
    },
  },
    el("label", { class: "field", for: "login-email" }, el("span", { text: "Email" }), email),
    el("label", { class: "field", for: "login-password" }, el("span", { text: "Password" }), password),
    error,
    button);

  $("screen-login").replaceChildren(el("div", { class: "login-wrap" },
    el("h1", { text: "Household Budget" }),
    el("p", { class: "sub", text: "Sign in once on this device and you'll stay signed in." }),
    form));
}

function showNotMember(email) {
  showScreen("notmember");
  $("screen-notmember").replaceChildren(el("div", { class: "card-plain" },
    el("h1", { text: "Not part of this household" }),
    el("p", { text: `You're signed in as ${email}, but that email isn't in the household's member list. Ask whoever set up the app to add it.` }),
    el("button", { type: "button", class: "btn secondary", text: "Sign out", onclick: () => sb.auth.signOut() })));
}

async function enterApp(session) {
  state.session = session;
  showBootMessage("Loading your budget…");
  try {
    await reloadLists();
  } catch (e) {
    showBootMessage(friendlyError(e), () => enterApp(session));
    return;
  }
  const email = session.user.email?.toLowerCase();
  state.me = state.members.find((m) => m.email === email) || null;
  if (!state.me) return showNotMember(email);
  route();
}

function syncOnline() {
  $("offline-banner").hidden = navigator.onLine;
}

async function boot() {
  // Auto theme: re-check the clock every minute and whenever the app comes back to the front.
  applyTheme();
  setInterval(applyTheme, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) applyTheme(); });
  syncOnline();
  window.addEventListener("online", syncOnline);
  window.addEventListener("offline", syncOnline);
  if (!configured) {
    showScreen("setup");
    return;
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") showLogin();
  });
  window.addEventListener("hashchange", route);
  const { data } = await sb.auth.getSession();
  if (data.session) await enterApp(data.session);
  else showLogin();
}

boot().catch((e) => showBootMessage(friendlyError(e), () => location.reload()));
