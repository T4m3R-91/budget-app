// Starts the app: sign-in, loading the household's lists, and switching between tabs. Also the
// offline side: the app's offline copy (sw.js) and its "Reload" for new versions, the offline
// banner, and sending entries saved offline once the connection is back.

import { configured, sb, reloadLists } from "./db.js";
import { state } from "./state.js";
import { el, friendlyError, applyTheme, isNetworkError } from "./ui.js";
import { showAdd, showEdit, showRecurringLog, showRecurringEdit } from "./entry.js";
import { refreshRecurring } from "./recurring.js";
import { syncOutbox } from "./outbox.js";
import { dataAsOf, clearStale } from "./offline.js";
import { prepareReceiptReader } from "./receipt.js";
import { showHistory } from "./history.js";
import { showDashboard, CHART_JS } from "./dashboard.js";
import { FLATPICKR_JS, FLATPICKR_CSS } from "./filters.js";
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
  if (hash.startsWith("#log/")) { // a recurring item's due date, in the Add form to change first
    const [itemId, due] = hash.slice(5).split("/");
    showScreen("add", "budget");
    showRecurringLog(itemId, due);
    return;
  }
  if (hash.startsWith("#recurring/")) { // edit a recurring item
    showScreen("add", "budget");
    showRecurringEdit(hash.slice(11));
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
  refreshRecurring(); // the Budget tab's badge: recurring items due today or overdue
  syncOutbox(); // anything saved offline last time
  setTimeout(prepareReceiptReader, 5000); // once, while online: so receipts can be scanned offline
}

// ---------- offline ----------

// The banner at the top: offline (entries are kept on the phone), and how old the data on screen
// is when it came from the phone rather than the server.
function paintOfflineBanner() {
  const asOf = dataAsOf();
  const banner = $("offline-banner");
  banner.hidden = navigator.onLine && !asOf;
  const when = asOf ? new Date(asOf) : null;
  const time = when && (when.toDateString() === new Date().toDateString()
    ? when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  banner.textContent = !navigator.onLine
    ? `Offline${time ? ` · as of ${time}` : ""}. New entries are saved on this phone and sync when you're back online.`
    : `Can't reach the server · showing data as of ${time}.`;
}

async function backOnline() {
  clearStale(); // the screen reloads below with fresh data
  paintOfflineBanner();
  if (!state.me) return;
  // Opened offline, the lists (categories, members…) came from the phone: get the current ones.
  try {
    await reloadLists();
    state.me = state.members.find((m) => m.email === state.me.email) || state.me;
  } catch { /* keep the ones on screen */ }
  syncOutbox();
  refreshRecurring();
  setTimeout(prepareReceiptReader, 5000); // if the app was opened offline, it wasn't prepared yet
  if (!document.getElementById("screen-add").hidden && !location.hash.startsWith("#edit/")) return; // keep a half-typed entry as is
  route();
}

// Signed in on this phone but offline: the saved sign-in is still valid for opening the app
// (Supabase can't renew it without a connection, and renews it once back online).
function savedSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!/^sb-.+-auth-token$/.test(key)) continue;
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved?.user?.email) return { user: saved.user };
    }
  } catch { /* nothing saved */ }
  return null;
}

// The offline copy (sw.js): register it, keep the libraries this first visit loaded plus the ones
// loaded only when needed (charts, the date picker), and offer a Reload when a new version has
// been downloaded. SheetJS (Download Excel, ~900 KB) is left to load when used.
function startOfflineCopy() {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  const hadController = Boolean(sw.controller);
  sw.addEventListener("controllerchange", () => { if (hadController) location.reload(); }); // after Reload
  sw.register("sw.js").then((reg) => {
    const offer = (worker) => {
      $("update-banner").replaceChildren("A new version is ready. ",
        el("button", { type: "button", class: "link-btn", text: "Reload", onclick: () => worker.postMessage("skip-waiting") }));
      $("update-banner").hidden = false;
    };
    if (reg.waiting && hadController) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      worker?.addEventListener("statechange", () => { if (worker.state === "installed" && sw.controller) offer(worker); });
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => { /* unavailable (e.g. private browsing): the app still works online */ });
  sw.ready.then((reg) => {
    const urls = performance.getEntriesByType("resource").map((r) => r.name)
      .filter((u) => /^https:\/\/(cdn\.jsdelivr\.net|cdn\.sheetjs\.com)\//.test(u));
    reg.active?.postMessage({ type: "keep-libs", urls: [...urls, CHART_JS, FLATPICKR_JS, FLATPICKR_CSS] });
  });
}

async function boot() {
  startOfflineCopy();
  // Auto theme: re-check the clock every minute and whenever the app comes back to the front.
  applyTheme();
  setInterval(applyTheme, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    applyTheme();
    if (!state.me) return;
    refreshRecurring(); // something may have come due, or been logged on the other phone
    syncOutbox();
  });
  paintOfflineBanner();
  window.addEventListener("online", backOnline);
  window.addEventListener("offline", paintOfflineBanner);
  window.addEventListener("datastale", paintOfflineBanner);
  if (!configured) {
    showScreen("setup");
    return;
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") showLogin();
  });
  window.addEventListener("hashchange", route);
  // Offline, the saved sign-in is used as is: asking supabase-js would first try to renew an
  // expired one, for ~25 s. Online, the same applies if that renewal can't reach the server.
  let session = savedSession();
  if (navigator.onLine) {
    const { data, error } = await sb.auth.getSession();
    session = data.session || (error && isNetworkError(error) ? session : null);
  }
  if (session) await enterApp(session);
  else showLogin();
}

boot().catch((e) => showBootMessage(friendlyError(e), () => location.reload()));
