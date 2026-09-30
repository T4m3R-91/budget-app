// Builds an .xlsx with the same Transactions / Income layout as the old spreadsheet.

import { state, byId, memberName } from "./state.js";
import { loadScript, isoLocal } from "./ui.js";
import { fetchAllTransactions } from "./db.js";

const SHEETJS = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RATE = "Rate at Entry (EGP per USD)";
const MONEY_COLUMNS = new Set(["Amount", "Amount_EGP", "Amount_USD"]);

const TX_HEADERS = ["Date", "Category", "Subcategory", "Description", "Amount", "Currency", "Amount_EGP",
  "Amount_USD", "Who Paid", "Payment Method", "Month", "Year", RATE];
const INCOME_HEADERS = ["Date", "Source", "Amount", "Currency", "Amount_EGP", "Amount_USD", "Who", "Received In", "Month", "Year", RATE];

// Excel serial day number, computed in UTC so no time zone can shift the date.
function excelDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

function monthYear(iso) {
  const [y, m] = iso.split("-").map(Number);
  return [MONTHS[m - 1], y];
}

function sheet(XLSX, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  headers.forEach((h, c) => {
    const format = h === "Date" ? "yyyy-mm-dd" : MONEY_COLUMNS.has(h) ? "#,##0.00" : h === RATE ? "0.0000" : null;
    if (!format) return;
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell) cell.z = format;
    }
  });
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(11, h.length + 2) }));
  return ws;
}

export async function exportToExcel() {
  const [, all] = await Promise.all([loadScript(SHEETJS), fetchAllTransactions()]);
  const XLSX = window.XLSX;
  const rows = all.slice().sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.created_at.localeCompare(b.created_at));

  const expenses = rows.filter((t) => t.type === "expense").map((t) => [
    excelDate(t.occurred_on),
    byId(state.categories, t.category_id)?.name ?? "",
    byId(state.subcategories, t.subcategory_id)?.name ?? "",
    t.description ?? "",
    Number(t.amount), t.currency, Number(t.amount_egp), Number(t.amount_usd),
    memberName(t.who),
    byId(state.paymentMethods, t.payment_method_id)?.name ?? "",
    ...monthYear(t.occurred_on),
    Number(t.rate),
  ]);

  const income = rows.filter((t) => t.type === "income").map((t) => [
    excelDate(t.occurred_on),
    byId(state.incomeSources, t.income_source_id)?.name ?? "",
    Number(t.amount), t.currency, Number(t.amount_egp), Number(t.amount_usd),
    memberName(t.who),
    byId(state.receivingMethods ?? [], t.receiving_method_id)?.name ?? "", // the Add screen's "In"
    ...monthYear(t.occurred_on),
    Number(t.rate),
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, TX_HEADERS, expenses), "Transactions");
  XLSX.utils.book_append_sheet(wb, sheet(XLSX, INCOME_HEADERS, income), "Income");
  XLSX.writeFile(wb, `Household_Budget_${isoLocal()}.xlsx`);
  return { expenses: expenses.length, income: income.length };
}
