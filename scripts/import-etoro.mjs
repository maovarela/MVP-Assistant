#!/usr/bin/env node
// scripts/import-etoro.mjs
// Parse an eToro "Account Statement" .xlsx into the etoro_* tables, then rebuild
// the per-year tax aggregation and reconcile against eToro's Financial Summary.
//
// Usage:
//   node scripts/import-etoro.mjs --file "path/to/etoro-account-statement.xlsx"
//   node scripts/import-etoro.mjs --file "..." --dry   (parse + report, no write)
//
// Idempotent: re-running the same file updates rows in place (keyed on
// position_id / row hash), so it is safe to re-import an updated statement.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as XLSX from "xlsx";
import db, {
  parseEtoroDate, num, hashRow,
  upsertStatement, insertPositions, insertDividends, insertActivity, insertFinSummary,
  computeTaxYears, getFinancialSummary,
} from "../etoro.js";

const importDb = () => db;

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const FILE = arg("file");
const DRY = args.includes("--dry");
if (!FILE) {
  console.error('Usage: node scripts/import-etoro.mjs --file "<statement.xlsx>" [--dry]');
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.error(`File not found: ${FILE}`);
  process.exit(1);
}

// ─── sheet readers ─────────────────────────────────────────────────────────────
const buf = fs.readFileSync(FILE);
const fileHash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
const wb = XLSX.read(buf, { type: "buffer" });

// Read a sheet as an array of objects keyed by the header row.
function rows(name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found. Sheets: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
}
// Read a sheet as a raw matrix (for the key/value Account Summary).
function matrix(name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
}

// ─── Account Summary → statement identity ────────────────────────────────────
const summary = matrix("Account Summary");
const kv = {};
for (const r of summary) {
  if (r.length >= 2 && r[0]) kv[String(r[0]).trim()] = r[1];
}
const statementRow = {
  file_name: path.basename(FILE),
  file_hash: fileHash,
  holder_name: (kv["Name"] || "").toString().trim() || null,
  username: (kv["Username"] || "").toString().trim() || null,
  institution: "eToro (Europe) Ltd, Cyprus (CySEC #109/10)",
  account_currency: (kv["Currency"] || "").toString().trim() || null,
  period_start: parseEtoroDate((kv["Start Date"] || "").toString()).iso,
  period_end: parseEtoroDate((kv["End Date"] || "").toString()).iso,
};

// ─── Closed Positions ────────────────────────────────────────────────────────
function buildPositions(statementId) {
  return rows("Closed Positions").map((r) => {
    const close = parseEtoroDate(r["Close Date"]);
    return {
      position_id: String(r["Position ID"]).trim(),
      statement_id: statementId,
      action: r["Action"] || null,
      type: r["Type"] || null,
      long_short: r["Long / Short"] || null,
      amount: num(r["Amount"]),
      units: num(r["Units / Contracts"]),
      open_date: parseEtoroDate(r["Open Date"]).iso,
      close_date: close.iso,
      close_year: close.year,
      leverage: num(r["Leverage"]),
      profit_usd: num(r["Profit(USD)"]),
      profit_eur: num(r["Profit(EUR)"]),
      isin: r["ISIN"] || null,
      copied_from: r["Copied From"] || null,
    };
  }).filter((p) => p.position_id && p.position_id !== "undefined");
}

// ─── Dividends ───────────────────────────────────────────────────────────────
function buildDividends(statementId) {
  return rows("Dividends").map((r) => {
    const pay = parseEtoroDate(r["Date of Payment"]);
    const pos = String(r["Position ID"] || "").trim();
    const netEur = num(r["Net Dividend Received (EUR)"]);
    return {
      id: hashRow(statementId, pos, r["Date of Payment"], netEur),
      statement_id: statementId,
      pay_date: pay.iso,
      pay_year: pay.year,
      instrument: (r["Instrument Name"] || "").toString().trim() || null,
      isin: r["ISIN"] || null,
      net_div_usd: num(r["Net Dividend Received (USD)"]),
      net_div_eur: netEur,
      currency: r["Currency"] || null,
      wht_rate: (r["Withholding Tax Rate (%)"] || "").toString().trim() || null,
      wht_usd: num(r["Withholding Tax Amount (USD)"]),
      wht_eur: num(r["Withholding Tax Amount (EUR)"]),
      position_id: pos || null,
      type: r["Type"] || null,
    };
  });
}

// ─── Account Activity (ledger) ───────────────────────────────────────────────
function buildActivity(statementId) {
  return rows("Account Activity").map((r, i) => {
    const d = parseEtoroDate(r["Date"]);
    return {
      id: hashRow(statementId, i, r["Date"], r["Type"], r["Amount"]),
      statement_id: statementId,
      date: d.iso,
      year: d.year,
      type: (r["Type"] || "").toString().trim() || null,
      details: r["Details"] || null,
      amount: num(r["Amount"]),
      realized_chg: num(r["Realized Equity Change"]),
      balance: num(r["Balance"]),
      position_id: String(r["Position ID"] || "").trim() || null,
      asset_type: r["Asset type"] || null,
    };
  });
}

// ─── Financial Summary (reconciliation reference) ────────────────────────────
function buildFinSummary(statementId) {
  return matrix("Financial Summary").slice(1) // drop header row
    .filter((r) => r[0])
    .map((r) => ({
      statement_id: statementId,
      line_name: String(r[0]).replace(/\s+/g, " ").trim(),
      amount_usd: num(r[1]),
      amount_eur: num(r[2]),
      tax_rate: num(r[3]),
    }));
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log(`\neToro import — ${statementRow.file_name}  (hash ${fileHash})`);
console.log(`Holder: ${statementRow.holder_name} / ${statementRow.username} · ${statementRow.account_currency}`);
console.log(`Period: ${statementRow.period_start} → ${statementRow.period_end}`);

if (DRY) {
  const pos = buildPositions(0), div = buildDividends(0), act = buildActivity(0), fin = buildFinSummary(0);
  console.log(`\n[dry run — nothing written]`);
  console.log(`  Closed Positions : ${pos.length}`);
  console.log(`  Dividends        : ${div.length}`);
  console.log(`  Activity rows    : ${act.length}`);
  console.log(`  Fin. summary     : ${fin.length} lines`);
  process.exit(0);
}

const statementId = upsertStatement(statementRow);

const positions = buildPositions(statementId);
const dividends = buildDividends(statementId);
const activity = buildActivity(statementId);
const finSummary = buildFinSummary(statementId);

insertPositions(positions);
insertDividends(dividends);
insertActivity(activity);
insertFinSummary(finSummary);

console.log(`\nWrote (statement_id=${statementId}):`);
console.log(`  Closed Positions : ${positions.length}`);
console.log(`  Dividends        : ${dividends.length}`);
console.log(`  Activity rows    : ${activity.length}`);
console.log(`  Fin. summary     : ${finSummary.length} lines`);

// ─── Aggregate + reconcile ─────────────────────────────────────────────────────
const taxYears = computeTaxYears();
console.log(`\nPer-year tax aggregation (EUR):`);
console.log(`  year   stocks    cfd     crypto   dividends  wht    #pos  #div`);
for (const y of taxYears) {
  console.log(
    `  ${y.year}  ${f(y.stocks_pnl_eur)}  ${f(y.cfd_pnl_eur)}  ${f(y.crypto_pnl_eur)}  ` +
    `${f(y.dividends_eur)}  ${f(y.dividends_wht_eur)}  ${String(y.n_positions).padStart(4)} ${String(y.n_dividends).padStart(5)}`
  );
}

// Reconcile against eToro's whole-period Financial Summary.
//   USD = structural check (must match tightly — catches row/parse bugs).
//   EUR = tax basis; small diffs are expected because we sum each position's
//         EUR at its own close-date FX, while eToro converts one USD total at a
//         single rate. Per-transaction EUR is the correct basis for the French
//         forms, so the EUR figure we keep is ours, not eToro's aggregate.
const finUsd = Object.fromEntries(getFinancialSummary(statementId).map((l) => [l.line_name, l.amount_usd]));
const finEur = Object.fromEntries(getFinancialSummary(statementId).map((l) => [l.line_name, l.amount_eur]));
const sum = (k) => taxYears.reduce((a, y) => a + (y[k] || 0), 0);

// Our USD sums (taxYears only carries EUR, so re-query the raw table for USD).
const usdByClass = db_usd();
console.log(`\nReconciliation — USD (structural check):`);
reconUsd("Stocks", usdByClass.Stocks, finUsd["Stocks (Profit or Loss)"]);
reconUsd("CFD",    usdByClass.CFD,    finUsd["CFDs (Profit or Loss)"]);
reconUsd("Crypto", usdByClass.Crypto, finUsd["Crypto (Profit or Loss)"]);
console.log(`\nEUR (tax basis — per-position close-date FX; small vs-eToro diff is the FX method, expected):`);
reconEur("Stocks", sum("stocks_pnl_eur"), finEur["Stocks (Profit or Loss)"]);
reconEur("CFD",    sum("cfd_pnl_eur"),    finEur["CFDs (Profit or Loss)"]);
reconEur("Crypto", sum("crypto_pnl_eur"), finEur["Crypto (Profit or Loss)"]);
console.log(`\nDone. Review per-year figures, then wire the dashboard/API.`);

function f(n) { return (n ?? 0).toFixed(2).padStart(8); }

// crypto = single Crypto-typed position; everything non-Stocks/Crypto = CFD bucket.
function db_usd() {
  const rows = importDb().prepare(
    `SELECT CASE WHEN type IN ('Stocks','Crypto') THEN type ELSE 'CFD' END AS cls,
            ROUND(SUM(profit_usd),2) AS pnl FROM etoro_closed_positions GROUP BY cls`
  ).all();
  return Object.fromEntries(rows.map((r) => [r.cls, r.pnl]));
}
function reconUsd(label, ours = 0, theirs = 0) {
  const diff = ours - (theirs ?? 0);
  const flag = Math.abs(diff) > 0.5 ? "  ⚠ STRUCTURAL MISMATCH" : "  ✓";
  console.log(`  ${label.padEnd(7)} ours=${ours.toFixed(2).padStart(9)}  eToro=${(theirs ?? 0).toFixed(2).padStart(9)}  diff=${diff.toFixed(2).padStart(8)}${flag}`);
}
function reconEur(label, ours, theirs) {
  const t = theirs ?? 0;
  const diff = ours - t;
  const tol = Math.max(1.0, Math.abs(t) * 0.05); // 5% or 1 EUR — FX-method band
  const flag = Math.abs(diff) > tol ? "  ⚠ check" : "  ✓ (FX method)";
  console.log(`  ${label.padEnd(7)} ours=${ours.toFixed(2).padStart(9)}  eToro=${t.toFixed(2).padStart(9)}  diff=${diff.toFixed(2).padStart(8)}${flag}`);
}
