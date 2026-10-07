// Tags: @words in a note, across categories ("Seafood dinner @dahab-trip"). A tag is one word:
// letters (Arabic too), digits, - and _; capitals don't matter (@Dahab is @dahab), and it shows as
// it was first written. Nothing is kept apart from the notes themselves: the household's tags are
// the ones in the notes of the entries and scheduled payments you can see. So a tag lasts as long
// as something uses it (fix a typo and the wrong tag is gone), and a private entry's tags stay
// private.

import { el } from "./ui.js";

// An @ that starts a word (not the middle of an email address), then the tag.
const WORD = "[\\p{L}\\p{M}\\p{N}_-]";
const BEFORE = "(^|[^\\p{L}\\p{M}\\p{N}_@.+-])";
const TAG = new RegExp(`${BEFORE}@(${WORD}+)`, "gu");
const TYPING = new RegExp(`${BEFORE}@(${WORD}*)$`, "u");
const tidy = (word) => word.replace(/[-_]+$/u, ""); // "@trip-" and "@trip_" are @trip

export const tagKey = (name) => name.toLocaleLowerCase();

// The tags in a note, in order: [{ key, name, start, end }] (start and end: the "@…" in the text).
export function tagsIn(text) {
  const out = [];
  for (const m of (text || "").matchAll(TAG)) {
    const name = tidy(m[2]);
    if (!name) continue;
    const start = m.index + m[1].length;
    out.push({ key: tagKey(name), name, start, end: start + 1 + name.length });
  }
  return out;
}

// A note's tags, each once: Set of keys.
export const tagKeys = (text) => new Set(tagsIn(text).map((t) => t.key));

// The tags of these rows (entries, scheduled payments): [{ key, name, uses }], most used first.
// uses: how many of them have it; name: as first written (oldest row first).
export function tagList(rows) {
  const tags = new Map();
  const oldestFirst = rows.slice().sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  for (const r of oldestFirst) {
    const seen = new Set();
    for (const t of tagsIn(r.description)) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      const tag = tags.get(t.key);
      if (tag) tag.uses += 1;
      else tags.set(t.key, { key: t.key, name: t.name, uses: 1 });
    }
  }
  return [...tags.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
}

// A note with its tags marked, as text and <span class="tag"> pieces (History).
export function withTags(text) {
  const parts = [];
  let at = 0;
  for (const t of tagsIn(text)) {
    parts.push(text.slice(at, t.start), el("span", { class: "tag", text: text.slice(t.start, t.end) }));
    at = t.end;
  }
  parts.push(text.slice(at));
  return parts.filter((p) => p !== "");
}

// The tag being typed just before the caret ("dinner @da|": { start: 7, query: "da" }), or null.
export function typingTag(text, caret) {
  const m = text.slice(0, caret).match(TYPING);
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

// Up to five of the household's tags for what's typed: those starting with it, then those
// containing it, most used first in each. Just "@": the five most used.
export function suggestTags(list, query) {
  const q = tagKey(query);
  const starts = list.filter((t) => t.key.startsWith(q));
  const inside = q ? list.filter((t) => !t.key.startsWith(q) && t.key.includes(q)) : [];
  return [...starts, ...inside].slice(0, 5);
}
