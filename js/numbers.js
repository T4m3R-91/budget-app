// Pure number helpers shared by the entry form and the receipt reader. No DOM; unit-tested.

const EASTERN_ARABIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeDigits(text) {
  return String(text)
    .replace(/[٠-٩]/g, (d) => String(EASTERN_ARABIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

// Turns what a person types into a number: "1,450", "1450.5", Arabic digits, and
// "1450,50" from keypads that use a comma as the decimal point.
function parseDecimal(input) {
  let s = normalizeDigits(input ?? "").trim().replace(/\s/g, "");
  if (!s) return null;
  s = /^\d+,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Rounds on the decimal string so 51.52345 -> 51.5235 (plain Math.round(n * 1e4) gives
// 51.5234 because of binary floating point), matching how the database rounds.
function roundTo(n, places) {
  const s = String(n);
  if (s.includes("e")) return Math.round(n * 10 ** places) / 10 ** places;
  return Number(Math.round(Number(`${s}e${places}`)) + `e-${places}`);
}

export const round2 = (n) => roundTo(n, 2);
export const round4 = (n) => roundTo(n, 4);

export function parseAmount(input) {
  const n = parseDecimal(input);
  return n == null ? null : round2(n) || null;
}

export function parseRate(input) {
  const n = parseDecimal(input);
  return n == null ? null : round4(n) || null;
}
