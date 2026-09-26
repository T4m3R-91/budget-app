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

export function fmtMoney(n, currency, { decimals } = {}) {
  const v = Number(n) || 0;
  const d = decimals ?? (Math.abs(v % 1) > 0.004 ? 2 : 0);
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v < 0 ? "−" : "") + (currency === "USD" ? "$" + s : "EGP " + s);
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

export function friendlyError(e) {
  const msg = String(e?.message || e || "");
  if (e?.code === "23505") return "That name is already in the list.";
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (/jwt expired|invalid jwt|refresh token/i.test(msg)) return "Your session expired. Sign out and back in.";
  return msg || "Something went wrong. Please try again.";
}

// ---------- lazy-loaded libraries ----------

const scripts = new Map();
export function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
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
