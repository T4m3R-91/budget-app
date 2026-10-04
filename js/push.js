// Notifications on this device (web push). Turning them on asks for the phone's or browser's
// permission, subscribes this device at its push service (Apple's, Google's, Microsoft's or
// Mozilla's) with the app's public key, and saves the device in Supabase, where the notify
// function sends to it (supabase/functions/notify). sw.js shows what arrives.
// iPhone and iPad: only the Home Screen app can get notifications (iOS 16.4 or later), not Safari.

import { savePushDevice, forgetPushDevice, callNotify } from "./db.js";

const KEY = "push-key"; // the app's public key, kept so turning on doesn't wait for it
const ON = "push-on";   // turned on here by the person signed in: renewed if the browser drops it

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private browsing */ } },
  drop: (k) => { try { localStorage.removeItem(k); } catch { /* private browsing */ } },
};

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const homeScreenApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// "ready", "home-screen" (iPhone or iPad in Safari: only the Home Screen app can) or "unsupported".
export function support() {
  if (isIOS() && !homeScreenApp()) return "home-screen";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window ? "ready" : "unsupported";
}

async function subscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// "on", "off" or "blocked" (permission refused: only the phone's or browser's settings can undo it).
export async function deviceState() {
  if (support() !== "ready") return "off";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && (await subscription().catch(() => null)) ? "on" : "off";
}

// "iPhone", "Windows · Edge"…: names the device in Supabase's table.
export function deviceName() {
  const ua = navigator.userAgent;
  if (isIOS()) return /iPhone|iPod/.test(ua) ? "iPhone" : "iPad";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ") || "Browser";
}

async function publicKey({ fresh = false } = {}) {
  const kept = store.get(KEY);
  if (kept && !fresh) return kept;
  const { publicKey: key } = await callNotify("key");
  store.set(KEY, key);
  return key;
}

// Fetched ahead each time Profile opens (so it follows new keys), so the tap that turns
// notifications on has nothing to wait for.
export function prepareKey() {
  if (support() === "ready" && navigator.onLine) publicKey({ fresh: true }).catch(() => { /* fetched on the tap */ });
}

async function save(sub) {
  const { keys } = sub.toJSON();
  try {
    await savePushDevice({ endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth, device: deviceName() });
  } catch (e) {
    // Before notifications-migration.sql has run, the function doesn't exist yet.
    if (e?.code === "PGRST202" || e?.code === "42883") throw new Error("Notifications aren't set up yet. Run notifications-migration.sql in Supabase.");
    throw e;
  }
}

// The app's service worker (sw.js), which receives the notifications. On a first visit it may still
// be installing.
async function worker() {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((done) => setTimeout(done, 10000))]);
  if (!reg) throw new Error("The app is still installing on this device. Try again in a moment.");
  return reg;
}

// The key as bytes: older Safari doesn't take it as text.
const keyBytes = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const subscribe = async (reg) =>
  (await reg.pushManager.getSubscription()) ||
  reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await publicKey()) });

// Called right from the tap: the permission request must come first, while the tap still counts.
// Resolves "on", "off" (the question was dismissed) or "blocked".
export async function turnOn() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const sub = await subscribe(await worker());
  try {
    await save(sub);
  } catch (e) {
    await sub.unsubscribe().catch(() => {}); // on here only when Supabase knows it too
    throw e;
  }
  store.set(ON, "1");
  return "on";
}

// Also on signing out: the next person to sign in on this device turns it on for themselves.
// Offline, Supabase keeps the device until its push service reports it gone on the next send.
export async function turnOff() {
  store.drop(ON);
  const sub = await subscription().catch(() => null);
  if (!sub) return;
  await Promise.race([forgetPushDevice(sub.endpoint).catch(() => {}), new Promise((done) => setTimeout(done, 3000))]);
  await sub.unsubscribe().catch(() => {});
}

// When the app opens: push services renew a device's address now and then, and browsers can drop
// it, so this device is saved again (and renewed if it was turned on here and has gone).
export async function refreshDevice() {
  try {
    if (support() !== "ready" || Notification.permission !== "granted" || !navigator.onLine) return;
    const reg = await worker();
    const had = await reg.pushManager.getSubscription();
    const sub = had || (store.get(ON) ? await subscribe(reg) : null);
    if (sub) await save(sub);
    if (sub && !had) window.dispatchEvent(new Event("pushchange")); // Profile shows it on again
  } catch { /* next time */ }
}

// Sends a test notification to every device of the person signed in: { devices, sent, removed, failed }.
export const sendTest = () => callNotify("test");
