#!/usr/bin/env node
// scripts/import-etoro.mjs
// Parse an eToro "Account Statement" .xlsx into the etoro_* tables, then rebuild
// the per-year tax aggregation and reconcile against eToro's Financial Summary.
//
// Usage:
//   node scripts/import-etoro.mjs --file "path/to/etoro-account-statement.xlsx"
//   node scripts/import-etoro.mjs --file "..." --dry   (parse + report, no write)
//
// The parsing/ingestion itself lives in etoro.js (importStatementFromBuffer) so
// the upload route (/api/etoro/import) and this CLI share one code path. This
// script adds the local-only reconciliation print on top.
//
// Idempotent: re-running the same file updates rows in place (keyed on
// position_id / row hash), so it is safe to re-import an updated statement.

import fs from "fs";
import path from "path";
import db, { importStatementFromBuffer, getFinancialSummary } from "../etoro.js";

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

const buf = fs.readFileSync(FILE);
const fileName = path.basename(FILE);
const result = importStatementFromBuffer(buf, { fileName, dryRun: DRY });
const { statement, counts } = result;

console.log(`\neToro import — ${statement.file_name}  (hash ${statement.file_hash})`);
console.log(`Holder: ${statement.holder_name} / ${statement.username} · ${statement.account_currency}`);
console.log(`Period: ${statement.period_start} → ${statement.period_end}`);

console.log(DRY ? `\n[dry run — nothing written]` : `\nWrote (statement_id=${result.statementId}):`);
console.log(`  Closed Positions : ${counts.positions}`);
console.log(`  Dividends        : ${counts.dividends}`);
console.log(`  Activity rows    : ${counts.activity}`);
console.log(`  Fin. summary     : ${counts.finSummary} lines`);
if (DRY) process.exit(0);

// ─── Per-year aggregation ──────────────────────────────────────────────────────
const taxYears = result.taxYears;
console.log(`\nPer-year tax aggregation (EUR):`);
console.log(`  year   stocks    cfd     crypto   dividends  wht    #pos  #div`);
for (const y of taxYears) {
  console.log(
    `  ${y.year}  ${f(y.stocks_pnl_eur)}  ${f(y.cfd_pnl_eur)}  ${f(y.crypto_pnl_eur)}  ` +
    `${f(y.dividends_eur)}  ${f(y.dividends_wht_eur)}  ${String(y.n_positions).padStart(4)} ${String(y.n_dividends).padStart(5)}`
  );
}

// ─── Reconcile against eToro's whole-period Financial Summary ───────────────────
//   USD = structural check (must match tightly — catches row/parse bugs).
//   EUR = tax basis; small diffs are expected because we sum each position's EUR
//         at its own close-date FX, while eToro converts one USD total at a single
//         rate. Per-transaction EUR is the correct basis for the French forms.
const statementId = result.statementId;
const finUsd = Object.fromEntries(getFinancialSummary(statementId).map((l) => [l.line_name, l.amount_usd]));
const finEur = Object.fromEntries(getFinancialSummary(statementId).map((l) => [l.line_name, l.amount_eur]));
const sum = (k) => taxYears.reduce((a, y) => a + (y[k] || 0), 0);

const usdByClass = db_usd();
console.log(`\nReconciliation — USD (structural check):`);
reconUsd("Stocks", usdByClass.Stocks, finUsd["Stocks (Profit or Loss)"]);
reconUsd("CFD",    usdByClass.CFD,    finUsd["CFDs (Profit or Loss)"]);
reconUsd("Crypto", usdByClass.Crypto, finUsd["Crypto (Profit or Loss)"]);
console.log(`\nEUR (tax basis — per-position close-date FX; small vs-eToro diff is the FX method, expected):`);
reconEur("Stocks", sum("stocks_pnl_eur"), finEur["Stocks (Profit or Loss)"]);
reconEur("CFD",    sum("cfd_pnl_eur"),    finEur["CFDs (Profit or Loss)"]);
reconEur("Crypto", sum("crypto_pnl_eur"), finEur["Crypto (Profit or Loss)"]);
console.log(`\nDone.`);

function f(n) { return (n ?? 0).toFixed(2).padStart(8); }

// crypto = single Crypto-typed position; everything non-Stocks/Crypto = CFD bucket.
function db_usd() {
  const rows = db.prepare(
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
