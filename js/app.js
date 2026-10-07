// Starts the app: sign-in (and "Forgot password?"), loading the household's lists, and switching
// between tabs. Also the offline side: the app's offline copy (sw.js) and its "Reload" for new
// versions, the offline banner, and sending entries saved offline once the connection is back.

import { configured, sb, reloadLists, myMembership, markJoined } from "./db.js";
import { state, isActive } from "./state.js";
import { idbClear } from "./store.js";
import { el, toast, friendlyError, applyTheme, isNetworkError, spotlight } from "./ui.js";
import { showAdd, showEdit, showRecurringLog, showRecurringEdit, showFavorite } from "./entry.js";
import { refreshRecurring, spotlightScheduled } from "./recurring.js";
import { syncOutbox } from "./outbox.js";
import { dataAsOf, clearStale } from "./offline.js";
import { prepareReceiptReader } from "./receipt.js";
import { showHistory } from "./history.js";
import { showDashboard, CHART_JS } from "./dashboard.js";
import { FLATPICKR_JS, FLATPICKR_CSS } from "./filters.js";
import { showProfile } from "./profile.js";
import { openSettings } from "./settings.js";
import { showBudget, showBudgetEditor, openBudgetOn } from "./budget.js";
import { refreshDevice, turnOff } from "./push.js";
import { refreshInbox, showInbox } from "./inbox.js";

window.__appStarted = true;

// The link in a password-reset or invite email opens the app with a one-time sign-in in the
// address (#access_token=…&type=recovery, or type=invite), or with why it didn't work
// (#error_description=…). supabase-js reads that sign-in and blanks the address as it starts, so
// note here which it was.
const arrival = new URLSearchParams(location.hash.slice(1));
const linkType = arrival.get("type");
const resetToken = linkType === "recovery" || linkType === "invite" ? arrival.get("access_token") : null;
const resetLinkFailed = Boolean(arrival.get("error_description"));

const $ = (id) => document.getElementById(id);
const TABS = { add: showAdd, history: showHistory, dashboard: showDashboard, budget: showBudget, profile: showProfile };
const SCREENS = ["boot", "setup", "login", "notmember", "budgetform", "inbox", ...Object.keys(TABS)];
const WITH_ACTION_BAR = ["add", "budgetform"]; // screens with a pinned Save bar

function showScreen(name, activeTab = name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  const inApp = name in TABS || name === "budgetform" || name === "inbox";
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
  if (hash.startsWith("#fav/")) { // a new favorite (#fav/new), or editing one
    showScreen("add");
    showFavorite(decodeURIComponent(hash.slice(5)));
    return;
  }
  // A notification about an entry: History, on it. About a scheduled payment or a budget: the
  // Budget tab on its month, the payment's row highlighted. The address becomes the tab's own.
  if (hash.startsWith("#history/")) {
    history.replaceState(null, "", "#history");
    showScreen("history");
    showHistory(decodeURIComponent(hash.slice(9)));
    return;
  }
  if (hash.startsWith("#month/")) {
    const [month, itemId] = hash.slice(7).split("/");
    history.replaceState(null, "", "#budget");
    if (/^\d{4}-\d{2}-01$/.test(month)) openBudgetOn(month);
    showScreen("budget");
    showBudget();
    if (itemId) spotlightScheduled(decodeURIComponent(itemId));
    return;
  }
  // The notification center: from the bell on the Add tab (For me), or back to its Everything.
  if (hash === "#notifications" || hash === "#notifications/everything") {
    showScreen("inbox", "add");
    showInbox(hash.endsWith("/everything") ? "all" : "me");
    return;
  }
  // From the activity log: Profile, on its Household section, or with Settings open.
  if (hash === "#profile/household" || hash === "#profile/settings") {
    const settings = hash.endsWith("/settings");
    history.replaceState(null, "", "#profile");
    if (settings) openSettings();
    showScreen("profile");
    showProfile();
    const node = settings ? document.querySelector("#screen-profile .settings-card") : document.getElementById("household");
    if (node) spotlight(node);
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
    form,
    el("button", { type: "button", class: "link-btn forgot", text: "Forgot password?", onclick: () => showForgot(email.value.trim()) })));
}

// ---------- forgot password ----------

// Supabase emails a link that opens the app signed in, on the "Choose a new password" screen.
function showForgot(prefill = "") {
  showScreen("login");
  const email = el("input", { class: "text-input", type: "email", autocomplete: "username", inputmode: "email", required: true, id: "forgot-email", value: prefill });
  const error = el("p", { class: "form-error", role: "alert" });
  const button = el("button", { type: "submit", class: "btn primary full", text: "Email me a reset link" });
  const wrap = el("div", { class: "login-wrap" });

  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = "";
      if (!navigator.onLine) {
        error.textContent = "Sending a reset link needs a connection.";
        return;
      }
      button.disabled = true;
      button.textContent = "Sending…";
      const address = email.value.trim();
      // Back to this same address: the link opens the app wherever it's hosted.
      const { error: err } = await sb.auth.resetPasswordForEmail(address, { redirectTo: location.origin + location.pathname });
      if (err) {
        error.textContent = /rate limit/i.test(err.message) ? "Too many reset emails were sent recently. Try again in an hour." : friendlyError(err);
        button.disabled = false;
        button.textContent = "Email me a reset link";
        return;
      }
      // Supabase doesn't say whether the email has an account, and neither does this.
      wrap.replaceChildren(
        el("h1", { text: "Check your email" }),
        el("p", { class: "sub", text: `If ${address} has an account, a link to choose a new password is on its way. It works once, within an hour.` }),
        el("p", { class: "sub", text: "Tap it, choose the new password, then sign in with it here." }),
        el("button", { type: "button", class: "btn secondary full", text: "Back to sign in", onclick: () => showLogin() }));
    },
  },
    el("label", { class: "field", for: "forgot-email" }, el("span", { text: "Email" }), email),
    error,
    button);

  wrap.replaceChildren(
    el("h1", { text: "Reset your password" }),
    el("p", { class: "sub", text: "We'll email you a link to choose a new one." }),
    form,
    el("button", { type: "button", class: "link-btn forgot", text: "Back to sign in", onclick: () => showLogin() }));
  $("screen-login").replaceChildren(wrap);
  email.focus();
}

// Opened from a reset or invite link, already signed in by it: the (new) password comes first.
function showNewPassword(session, invited = false) {
  showScreen("login");
  const word = invited ? "Password" : "New password"; // someone invited never had one
  const save = invited ? "Save password" : "Save new password";
  const field = (id, label) => el("input", { class: "text-input", type: "password", autocomplete: "new-password", minlength: 8, required: true, id, "aria-label": label });
  const pw = field("new-password", word);
  const again = field("new-password-again", `${word} again`);
  const error = el("p", { class: "form-error", role: "alert" });
  const button = el("button", { type: "submit", class: "btn primary full", text: save });

  const form = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = "";
      if (pw.value.length < 8) return void (error.textContent = "Use at least 8 characters.");
      if (pw.value !== again.value) return void (error.textContent = "The two passwords don't match.");
      button.disabled = true;
      button.textContent = "Saving…";
      const { error: err } = await sb.auth.updateUser({ password: pw.value });
      if (err) {
        error.textContent = friendlyError(err);
        button.disabled = false;
        button.textContent = save;
        return;
      }
      await enterApp(session);
      toast(invited ? `Welcome, ${state.me?.display_name || "to the household"}!` : "Password changed");
    },
  },
    el("label", { class: "field", for: "new-password" }, el("span", { text: `${word} (8+ characters)` }), pw),
    el("label", { class: "field", for: "new-password-again" }, el("span", { text: `${word} again` }), again),
    error,
    button);

  $("screen-login").replaceChildren(el("div", { class: "login-wrap" },
    el("h1", { text: invited ? "Welcome to Household Budget" : "Choose a new password" }),
    el("p", { class: "sub", text: invited
      ? `You've been invited to the household. Choose a password for ${session.user.email}: you'll use it to sign in, including in the app on your Home Screen.`
      : `For ${session.user.email}. Use it from now on to sign in, including in the app on your Home Screen.` }),
    form));
  pw.focus();
}

// Deactivated while the app was open: found out when it comes back to the front.
async function stillInHousehold() {
  if (!navigator.onLine || !state.me) return;
  if ((await myMembership()) === "deactivated") showNotMember(state.me.email);
}

// Signed in, but not (or no longer) in the household. A deactivated person's phone also forgets
// what it kept for offline use, and stops getting notifications.
async function showNotMember(email) {
  state.me = null; // nothing else runs or routes for them
  showScreen("notmember");
  const card = (title, text) => $("screen-notmember").replaceChildren(el("div", { class: "card-plain" },
    el("h1", { text: title }), el("p", { text }),
    el("button", { type: "button", class: "btn secondary", text: "Sign out", onclick: () => sb.auth.signOut() })));
  card("Not part of this household", `You're signed in as ${email}, but that email isn't in the household's member list. Ask whoever set up the app to add it.`);
  if ((await myMembership()) !== "deactivated") return;
  card("You're no longer part of this household", `An owner has turned off access for ${email}. Ask them if you need it back.`);
  idbClear("cache").catch(() => {});
  turnOff().catch(() => {});
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
  state.me = state.members.find((m) => m.email === email && isActive(m)) || null;
  if (!state.me) return showNotMember(email);
  if ("joined_at" in state.me && !state.me.joined_at) { // an invite's first sign-in: no longer "Invited"
    markJoined();
    state.me.joined_at = new Date().toISOString();
  }
  route();
  refreshRecurring(); // the Budget tab's badge: recurring items due today or overdue
  syncOutbox(); // anything saved offline last time
  refreshDevice(); // notifications on this device, if turned on (push.js)
  refreshInbox(); // the bell's unread count
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
    const me = state.members.find((m) => m.email === state.me.email);
    if (!me || !isActive(me)) return showNotMember(state.me.email); // deactivated meanwhile
    state.me = me;
  } catch { /* keep the ones on screen */ }
  syncOutbox();
  refreshRecurring();
  refreshInbox();
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
  sw.addEventListener("message", (event) => {
    // A notification was tapped: go to what it's about.
    if (event.data?.type === "open") location.hash = new URL(event.data.url).hash || "#add";
    // One arrived while the app is open: the bell counts it.
    if (event.data?.type === "pushed" && state.me) refreshInbox();
  });
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
    refreshInbox(); // and notifications may have come in meanwhile
    syncOutbox();
    stillInHousehold();
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
    if (event !== "SIGNED_OUT") return;
    // What was kept for offline use was this person's view (their private entries too): the next
    // person signing in on this phone starts from the server. Entries still waiting to sync stay.
    idbClear("cache").catch(() => {});
    showLogin();
  });
  window.addEventListener("hashchange", route);
  // Offline, the saved sign-in is used as is: asking supabase-js would first try to renew an
  // expired one, for ~25 s. Online, the same applies if that renewal can't reach the server.
  let session = savedSession();
  if (navigator.onLine) {
    const { data, error } = await sb.auth.getSession();
    session = data.session || (error && isNetworkError(error) ? session : null);
  }
  if (resetToken || resetLinkFailed) history.replaceState(null, "", location.pathname + location.search); // no leftovers in the address
  // Signed in by the reset link itself (not by an earlier sign-in still on this phone).
  if (resetToken && session?.access_token === resetToken) return showNewPassword(session, linkType === "invite");
  const linkProblem = resetToken || resetLinkFailed ? "That reset link has expired or was already used." : "";
  if (session) {
    await enterApp(session);
    if (linkProblem) toast(`${linkProblem} You're still signed in.`);
  } else {
    showLogin(linkProblem && `${linkProblem} Tap "Forgot password?" for a new one.`);
  }
}

boot().catch((e) => showBootMessage(friendlyError(e), () => location.reload()));
