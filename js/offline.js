// Reads that still work without a connection: each successful read is kept on the phone, and when
// the server can't be reached the last kept copy is used instead. The offline banner then says
// how old the data on screen is ("Offline · as of 10:42").

import { idbGet, idbPut } from "./store.js";
import { isNetworkError } from "./ui.js";

let staleSince = null; // when the oldest kept copy now on screen was loaded

export const dataAsOf = () => staleSince;

export async function cached(key, read) {
  // Known to be offline: straight to the kept copy. Asking the server would only fail, and
  // supabase-js retries a failed read for ~7 s before giving up.
  if (!navigator.onLine) return keptCopy(key, new TypeError("Failed to fetch"));
  try {
    const value = await read();
    idbPut("cache", { key, value, at: Date.now() }).catch(() => { /* storage full or blocked: still fine online */ });
    return value;
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    return keptCopy(key, e);
  }
}

async function keptCopy(key, error) {
  const kept = await idbGet("cache", key).catch(() => null);
  if (!kept) throw error;
  if (!staleSince || kept.at < staleSince) staleSince = kept.at;
  window.dispatchEvent(new Event("datastale"));
  return kept.value;
}

// The app version running on this phone, as its offline copy (sw.js) names it; null before the
// offline copy is in place (the very first visit) or where the browser doesn't allow one.
export async function appVersion() {
  if (!("serviceWorker" in navigator)) return null;
  const sw = navigator.serviceWorker;
  const worker = sw.controller || (await sw.getRegistration().catch(() => null))?.active;
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    worker.postMessage("version", [channel.port2]);
    setTimeout(() => resolve(null), 3000);
  });
}

// Back online and reloading: the screens are about to show fresh data again.
export function clearStale() {
  staleSince = null;
  window.dispatchEvent(new Event("datastale"));
}
