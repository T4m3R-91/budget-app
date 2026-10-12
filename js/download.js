// The Excel download and when the last automatic backup ran: the foot of the Dashboard tab.

import { el, toast, friendlyError, friendlyDate, isoLocal } from "./ui.js";
import { fetchBackupStatus } from "./db.js";
import { exportToExcel } from "./export.js";

export function downloadSection() {
  const label = "Download transactions details as Excel";
  const button = el("button", {
    type: "button", class: "btn secondary full", text: label,
    onclick: async () => {
      button.disabled = true;
      button.textContent = "Preparing file…";
      try {
        const counts = await exportToExcel();
        toast(`Downloaded ${counts.expenses} expenses and ${counts.income} income entries`);
      } catch (e) {
        toast(friendlyError(e));
      }
      button.disabled = false;
      button.textContent = label;
    },
  });
  return el("div", { class: "dash-data" }, button, el("p", { id: "backup-line", class: "backup-line", hidden: true }));
}

// The nightly automatic backup (backup-repo/): when it last ran. Nothing shown until
// backups-migration.sql has run; a warning when it's more than a day and a half old.
export async function paintBackupLine() {
  let status;
  try { status = await fetchBackupStatus(); } catch { return; }
  const line = document.getElementById("backup-line");
  if (!line || status === "missing") return;
  line.hidden = false;
  if (!status) {
    line.textContent = "Automatic backups: waiting for the first one";
    return;
  }
  const at = new Date(status.last_backup_at);
  const day = isoLocal(at);
  const when = friendlyDate(day).replace(/^Today$/, "today").replace(/^Yesterday$/, "yesterday");
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const stale = Date.now() - at.getTime() > 36 * 3600 * 1000;
  line.classList.toggle("stale", stale);
  line.textContent = stale
    ? `⚠ Last automatic backup: ${when}, ${time}. Check the backup repository on GitHub`
    : `Last automatic backup: ${when} ${time} ✓`;
}
