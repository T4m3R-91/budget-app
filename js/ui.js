// Small DOM and formatting helpers. User-entered text always goes through textContent.

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  let value;
  for (const [key, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (key === "class") node.className = v;
    else if (key === "text") node.textContent = v;
    else if (key === "value") value = v;
    else if (key.startsWith("on") && typeof v === "function") node.addEventListener(key.slice(2), v);
    else node.setAttribute(key, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) node.value = value;
  return node;
}

// ---------- hide amounts (saved on this device; set in Profile → Settings) ----------

// While on, every money figure and percentage is drawn as a fixed-length mask, so the real value
// never reaches the screen, a tooltip or a label. Shapes (bars, tiles) are left as they are.
const HIDE_KEY = "hideAmounts";
export const MASK = "••••";
export const MASK_PCT = "••%";
let hidden_ = (() => {
  try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; }
})();

export const amountsHidden = () => hidden_;

export function setAmountsHidden(on) {
  hidden_ = Boolean(on);
  try { localStorage.setItem(HIDE_KEY, hidden_ ? "1" : "0"); } catch { /* private mode: applies until the app closes */ }
  window.dispatchEvent(new Event("amountschange"));
}

// A percentage like "18%", or its mask.
export const fmtPct = (text) => (hidden_ ? MASK_PCT : text);

// A field that opens already holding a figure (editing an entry, a budget): while hidden it shows
// the mask instead. Tapping it clears the mask so a new figure can be typed; left empty it shows
// the mask again, and typing anything makes it an ordinary field. fieldValue() reads it back (the
// real figure while the mask is still showing). Returns whether it's masked.
export function maskField(input) {
  if (!hidden_ || !input.value) return false;
  input.dataset.real = input.value;
  input.dataset.masked = "1";
  input.value = MASK;
  input.addEventListener("focus", () => { if (input.dataset.masked) input.value = ""; });
  input.addEventListener("blur", () => { if (input.dataset.masked && !input.value) input.value = MASK; });
  input.addEventListener("input", () => { delete input.dataset.masked; delete input.dataset.real; });
  return true;
}
export const fieldValue = (input) => (input.dataset.masked ? input.dataset.real : input.value);

// "EGP 1,450" / "$15.99"; with { code: true } USD is spelled out too: "USD 15.99".
export function fmtMoney(n, currency, { decimals, code = false } = {}) {
  const v = Number(n) || 0;
  const d = decimals ?? (Math.abs(v % 1) > 0.004 ? 2 : 0);
  const s = hidden_ ? MASK : Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const unit = currency === "USD" ? (code ? "USD " : "$") : "EGP ";
  return (v < 0 ? "−" : "") + unit + s;
}

export const fmtRate = (r) => Number(r).toLocaleString("en-US", { maximumFractionDigits: 4 });

// ---------- dates (always local calendar days, never UTC) ----------

export function isoLocal(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function parseISODate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function friendlyDate(iso) {
  if (iso === isoLocal()) return "Today";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (iso === isoLocal(yesterday)) return "Yesterday";
  const d = parseISODate(iso);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

// "today" / "yesterday" / "25 Sep", for use mid-sentence.
export function relativeDay(iso) {
  const f = friendlyDate(iso);
  return f === "Today" || f === "Yesterday" ? f.toLowerCase() : f;
}

// ---------- feedback ----------

// Draws the eye to something a notification was about: scrolls it into view and outlines it for
// a moment (see .spotlight in styles.css).
export function spotlight(node) {
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("spotlight");
  void node.offsetWidth; // restart the animation if it's already showing
  node.classList.add("spotlight");
  node.addEventListener("animationend", () => node.classList.remove("spotlight"), { once: true });
}

let toastTimer;
export function toast(message, action) {
  const t = document.getElementById("toast");
  const hide = () => { t.hidden = true; };
  t.replaceChildren(el("span", { text: message }));
  if (action) {
    t.append(el("button", { type: "button", text: action.label, onclick: () => { hide(); action.run(); } }));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 6000 : 3200);
}

// The request never reached the server (no signal, or the server is unreachable), as opposed to
// the server answering with an error.
export function isNetworkError(e) {
  const msg = String(e?.message || e || "");
  return !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg);
}

export function friendlyError(e) {
  const msg = String(e?.message || e || "");
  if (e?.code === "23505") return "That name is already in the list.";
  if (isNetworkError(e)) return "Couldn't reach the server. Check your connection and try again.";
  if (/jwt expired|invalid jwt|refresh token/i.test(msg)) return "Your session expired. Sign out and back in.";
  return msg || "Something went wrong. Please try again.";
}

// ---------- time of day ----------

// By the phone's clock: morning 5–11, afternoon 12–16, evening 17–21, night 22–4.
// Drives the Add screen's greeting and the Auto theme (Day in the morning and afternoon).
// index.html repeats the Day hours (5–16) to set the theme before the first paint.
export function partOfDay(hour = new Date().getHours()) {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

// ---------- Auto / Day / Night theme (the choice is saved on this device; Auto until one is picked) ----------

const THEME_KEY = "theme";
let themeChoice_ = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  } catch { return "auto"; }
})();

export const themeChoice = () => themeChoice_; // "dark" | "light" | "auto"

export function setThemeChoice(choice) {
  themeChoice_ = choice;
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode: applies until the app closes */ }
  applyTheme();
}

// Puts the chosen theme (or Auto's pick for this hour) on <html>, and tells the charts if it changed.
export function applyTheme() {
  const day = ["morning", "afternoon"].includes(partOfDay());
  const theme = themeChoice_ === "auto" ? (day ? "light" : "dark") : themeChoice_;
  const root = document.documentElement;
  if ((root.dataset.theme === "light" ? "light" : "dark") === theme) return;
  root.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f6f8" : "#0f1419");
  window.dispatchEvent(new Event("themechange"));
}

// ---------- lazy-loaded libraries ----------

const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      // jsdelivr allows CORS: a plain copy is cheaper for the offline cache (sw.js) to keep.
      if (src.startsWith("https://cdn.jsdelivr.net/")) s.crossOrigin = "anonymous";
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        scripts.delete(src);
        reject(new Error("Couldn't load part of the app. Check your connection and try again."));
      };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

// Goes in before styles.css, so the app's own look wins over a library's defaults.
export function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = el("link", { rel: "stylesheet", href, crossorigin: href.startsWith("https://cdn.jsdelivr.net/") ? "anonymous" : null });
  document.head.insertBefore(link, document.querySelector('link[href="styles.css"]'));
}
