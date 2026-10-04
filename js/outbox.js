// Entries saved without a connection wait here, on the phone, and are sent when the connection
// returns: on reconnecting, when the app opens, and when you come back to it (iPhone doesn't let
// web apps sync in the background). Each entry carries its own id, so one that did reach the
// server before its reply was lost isn't saved twice. Points are scored when it arrives, so an
// entry that syncs on a later day doesn't get the same-day bonus.

import { idbAll, idbPut, idbDelete } from "./store.js";
import { insertTransaction, notifyActivity } from "./db.js";
import { getRateOn } from "./fx.js";
import { toast, friendlyError, isNetworkError } from "./ui.js";

const changed = () => window.dispatchEvent(new Event("outboxchange"));

// Waiting entries, oldest first: the transaction rows as they'll be saved, plus queued_at,
// rate_pending (dated in the past, saved with today's rate standing in for its day's: it gets
// its day's rate when it's sent) and, if the server turned one down, sync_error.
export async function pendingEntries() {
  try {
    return (await idbAll("outbox")).sort((a, b) => a.queued_at - b.queued_at);
  } catch {
    return [];
  }
}

export async function queueEntry(row) {
  await idbPut("outbox", { ...row, queued_at: Date.now() });
  changed();
}

export async function removePending(id) {
  await idbDelete("outbox", id);
  changed();
}

let syncing = null;
export function syncOutbox() {
  syncing ??= send().finally(() => { syncing = null; });
  return syncing;
}

async function send() {
  if (!navigator.onLine) return;
  const waiting = await pendingEntries();
  if (!waiting.length) return;
  let sent = 0;
  let points = 0;
  let refused = 0;
  let rerated = 0;
  for (const entry of waiting) {
    const { queued_at, sync_error, rate_pending, ...row } = entry;
    const day = rate_pending ? await getRateOn(row.occurred_on) : null;
    if (day) Object.assign(row, { rate: day.rate, rate_source: "historical" });
    try {
      const saved = await insertTransaction(row);
      notifyActivity(row.recurring_id ? "log" : "entry", saved.id); // the others hear about it now
      points += Number.isInteger(saved.points) ? saved.points : 0;
      sent++;
      if (day) rerated++;
      await idbDelete("outbox", entry.id);
    } catch (e) {
      if (e?.code === "23505") { // already there: it arrived before, and only the reply was lost
        sent++;
        await idbDelete("outbox", entry.id);
      } else if (isNetworkError(e)) {
        break; // still no connection; the rest wait for the next try
      } else {
        refused++;
        await idbPut("outbox", { ...entry, sync_error: friendlyError(e) });
      }
    }
  }
  const dayRates = rerated ? ` · ${rerated === sent ? (sent === 1 ? "with its" : "with their") : `${rerated} with their`} day's rate` : "";
  if (sent) toast(`Synced ${sent} ${sent === 1 ? "entry" : "entries"} saved offline${dayRates}${points ? ` · +${points} pts` : ""}`);
  else if (refused) toast(`${refused} offline ${refused === 1 ? "entry" : "entries"} couldn't be saved. See History.`);
  changed();
}
