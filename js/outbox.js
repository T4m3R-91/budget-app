// Entries saved without a connection wait here, on the phone, and are sent when the connection
// returns: on reconnecting, when the app opens, and when you come back to it (iPhone doesn't let
// web apps sync in the background). Each entry carries its own id, so one that did reach the
// server before its reply was lost isn't saved twice. Points are scored when it arrives, so an
// entry that syncs on a later day doesn't get the same-day bonus.

import { idbAll, idbPut, idbDelete } from "./store.js";
import { insertTransaction } from "./db.js";
import { toast, friendlyError, isNetworkError } from "./ui.js";

const changed = () => window.dispatchEvent(new Event("outboxchange"));

// Waiting entries, oldest first: the transaction rows as they'll be saved, plus queued_at and,
// if the server turned one down, sync_error.
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
  for (const entry of waiting) {
    const { queued_at, sync_error, ...row } = entry;
    try {
      const saved = await insertTransaction(row);
      points += Number.isInteger(saved.points) ? saved.points : 0;
      sent++;
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
  if (sent) toast(`Synced ${sent} ${sent === 1 ? "entry" : "entries"} saved offline${points ? ` · +${points} pts` : ""}`);
  else if (refused) toast(`${refused} offline ${refused === 1 ? "entry" : "entries"} couldn't be saved. See History.`);
  changed();
}
