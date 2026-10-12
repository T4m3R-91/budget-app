// Profile's building blocks, laid out the way iPhone Settings does it: a small label above a card,
// and the card is a stack of rows (a title, an optional hint, and a switch, button or chevron at
// the right). A row with a chevron opens in place; which ones are open is remembered while the
// app is, so a redraw (a switch flipped, a name saved) doesn't close them.

import { el } from "./ui.js";

const opened = new Set();

export const openRow = (key) => opened.add(key);

export const group = (label, ...cards) =>
  el("div", { class: "pf-group" }, el("div", { class: "pf-label", text: label }), ...cards);

export const card = (...rows) => el("div", { class: "pf-card" }, ...rows);

// The title with its hint under it (a string, or nodes such as a select).
export const rowText = (title, hint) =>
  el("div", { class: "pf-text" }, el("b", { text: title }), hint ? el("span", { class: "pf-hint" }, hint) : null);

export const row = (title, hint, control) => el("div", { class: "pf-row" }, rowText(title, hint), control);

// A button that fills its row; every button in Profile is this one (the red Sign out adds "danger").
export const buttonRow = (button) => el("div", { class: "pf-row pf-btn-row" }, button);

export const switchEl = (on, label, onclick, disabled = false) =>
  el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label, disabled, onclick });

// A row that opens to show `body` under it, at the same level and on the same background.
export function disclosure(key, summary, ...body) {
  const details = el("details", { class: "pf-disc" },
    el("summary", { class: "pf-row" }, summary, el("span", { class: "pf-chev", "aria-hidden": "true", text: "›" })),
    el("div", { class: "pf-body" }, ...body));
  details.open = opened.has(key);
  details.addEventListener("toggle", () => (details.open ? opened.add(key) : opened.delete(key)));
  return details;
}
