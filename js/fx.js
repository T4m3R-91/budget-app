// Live USD -> EGP rate from free public services (they update about once a day).
// Tries each source in turn; returns null if none answer, and the entry form falls back.

import { round4 } from "./numbers.js";
import { parseISODate } from "./ui.js";

const MAX_AGE_MS = 60 * 60 * 1000;
let cached = null;

async function fetchJSON(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const SOURCES = [
  async () => {
    const j = await fetchJSON("https://open.er-api.com/v6/latest/USD");
    const rate = j?.rates?.EGP;
    if (j?.result !== "success" || !(rate > 0)) throw new Error("unexpected response");
    return { rate, asOf: new Date(j.time_last_update_unix * 1000) };
  },
  async () => {
    for (const url of [
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
      "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    ]) {
      try {
        const j = await fetchJSON(url);
        if (j?.usd?.egp > 0) return { rate: j.usd.egp, asOf: parseISODate(j.date) };
      } catch {
        /* try the mirror */
      }
    }
    throw new Error("unavailable");
  },
];

// The last rate fetched is also kept on the phone, so an entry logged offline can use it; the
// Add screen labels it with its date ("live, 29 Sept"), as it does any rate.
const KEPT = "lastLiveRate";

// Resolves { rate, asOf: Date } or null.
export async function getLiveRate({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached;
  if (navigator.onLine) {
    for (const source of SOURCES) {
      try {
        const { rate, asOf } = await source();
        cached = { rate: round4(rate), asOf, fetchedAt: Date.now() };
        try { localStorage.setItem(KEPT, JSON.stringify({ rate: cached.rate, asOf: asOf.getTime() })); } catch { /* storage unavailable */ }
        return cached;
      } catch {
        /* next source */
      }
    }
  }
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT));
    if (kept?.rate > 0) return { rate: kept.rate, asOf: new Date(kept.asOf), fetchedAt: 0 };
  } catch { /* nothing kept */ }
  return null;
}
