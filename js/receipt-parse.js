// Picks likely totals out of OCR'd receipt text. Pure (no DOM); unit-tested.
// Receipts here are English, Arabic, or mixed, with Western or Eastern Arabic digits.

import { normalizeDigits } from "./numbers.js";

function normalizeArabic(s) {
  return s
    .replace(/[ً-ْـ]/g, "") // diacritics and tatweel
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

const norm = (s) => normalizeArabic(normalizeDigits(s)).toLowerCase();

const TOTAL_WORDS = [
  "grand total", "total due", "amount due", "total amount", "net total", "net amount",
  "balance due", "to pay", "total",
  "الإجمالي", "إجمالي", "المجموع", "الصافي", "صافي", "المطلوب", "المستحق",
].map(norm);

const SUBTOTAL_WORDS = ["subtotal", "sub total", "sub-total", "المجموع الفرعي", "فرعي"].map(norm);

// Lines that carry an amount that is *not* the total: cash handed over, change, tax, etc.
const OTHER_WORDS = [
  "change", "cash", "tendered", "tender", "visa", "mastercard", "card", "tax", "vat",
  "service", "discount", "saving", "savings", "qty", "quantity", "tel", "phone", "mobile",
  "item", "items", "points", "invoice", "receipt no",
  "الباقي", "باقي", "نقدي", "نقدا", "كاش", "ضريبة", "القيمة المضافة", "خدمة", "خصم",
  "كمية", "تليفون", "هاتف", "موبايل", "المدفوع", "نقاط", "عدد", "فاتورة رقم",
].map(norm);

function hasWord(line, word) {
  if (/[a-z]/.test(word)) {
    return new RegExp(`(^|[^a-z])${word.replace(/[-]/g, "\\-")}([^a-z]|$)`).test(line);
  }
  return line.includes(word);
}

const DATE_TIME = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}|\d{1,2}:\d{2}(:\d{2})?/g;
const NUMBER =
  /(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2}|\d+,\d{2}(?!\d)|\d+(?:\.\d{1,2})?)(?![\d])/g;

function toValue(token) {
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(token)) return Number(token.replace(/\./g, "").replace(",", "."));
  if (/^\d+,\d{2}$/.test(token)) return Number(token.replace(",", "."));
  return Number(token.replace(/,/g, ""));
}

function numbersIn(line) {
  const cleaned = line.replace(DATE_TIME, " ");
  const found = [];
  for (const m of cleaned.matchAll(NUMBER)) {
    const token = m[1];
    const after = cleaned.slice(m.index + token.length).trimStart();
    if (after.startsWith("%")) continue;
    const plainDigits = /^\d+$/.test(token);
    if (plainDigits && (token.length >= 7 || /^0\d/.test(token))) continue; // phones, barcodes, IDs
    const value = toValue(token);
    if (!(value > 0) || value > 5_000_000) continue;
    found.push({ value, hasCents: /[.,]\d{2}$/.test(token) });
  }
  return found;
}

// Returns up to `limit` candidates, most likely total first: [{ value, score }].
export function findAmountCandidates(text, limit = 6) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => norm(l).trim())
    .filter(Boolean);

  const candidates = [];
  let totalLabelPending = false; // "Total" on one line, its value on the next

  lines.forEach((line, i) => {
    const isSubtotal = SUBTOTAL_WORDS.some((w) => line.includes(w));
    const isTotal = !isSubtotal && TOTAL_WORDS.some((w) => hasWord(line, w));
    const isOther = OTHER_WORDS.some((w) => hasWord(line, w));
    const nums = numbersIn(line);

    for (const n of nums) {
      let score = 0;
      if (isTotal) score += 6;
      if (isSubtotal) score += 2;
      if (isOther) score -= 4;
      if (totalLabelPending) score += 4;
      if (n.hasCents) score += 1;
      if (i >= lines.length * 0.4) score += 1;
      candidates.push({ value: n.value, score, other: isOther });
    }
    totalLabelPending = isTotal && nums.length === 0;
  });

  // Totals tend to be the biggest figure on the receipt (cash handed over excepted).
  const byValue = [...new Set(candidates.filter((c) => !c.other).map((c) => c.value))].sort((a, b) => b - a);
  for (const c of candidates) {
    if (c.value === byValue[0]) c.score += 2;
    else if (c.value === byValue[1]) c.score += 1;
  }

  const best = new Map();
  for (const c of candidates) {
    if (!best.has(c.value) || best.get(c.value).score < c.score) best.set(c.value, c);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.value - a.value)
    .slice(0, limit)
    .map(({ value, score }) => ({ value, score }));
}
