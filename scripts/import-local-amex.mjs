#!/usr/bin/env node
// One-shot importer for local Amex FR CSV statements.
//
// Amex CSV format quirks this handles:
//  - Date: MM/DD/YYYY
//  - Amount: French locale "9,15" — comma decimal, no thousand separator
//  - SIGN INVERTED: positive = charge (we want negative), negative = bill payment
//  - "PRELEVEMENT AUTOMATIQUE ..." rows = monthly bill payment from bank to Amex.
//    Marked as `transfers` so they don't pollute spending totals.
//
// Output:
//  1) JSON summary to stdout (total, by month, by category, top merchants).
//  2) normalized CSV at scripts/normalized-amex.csv with the columns the bot's
//     importCsv flow can swallow without re-parsing via LLM. Upload via
//     Telegram once Railway has a persistent volume.
//
// Usage: node scripts/import-local-amex.mjs <folder>

import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";

const folder = process.argv[2];
if (!folder) {
  console.error("Usage: node scripts/import-local-amex.mjs <folder>");
  process.exit(1);
}

// Crude keyword-based categorizer. Good enough for an Amex card whose merchants
// are mostly recurring. Anything not matched -> 'other'.
const RULES = [
  [/uber\s*eats|deliveroo/i,                                  "restaurants"],
  [/uber|bolt|cabify|free now|smovengo|velib|sodicma|fpx|paris paris|relay|aeroport|iberia|transavia|air europa|airbnb|cdg/i,
                                                              "transport"],   // includes some Vélib/metro POS that mostly land here
  [/restaurant|asado|casa de tapas|club sauvage|empanadas|sushi|pizza|tacos|burger|pret a manger|seggali|grande recre|pyramid|el cumpa|le \w|la \w|chez |brasserie|tapas|monoprix mozart/i,
                                                              "restaurants"],
  [/monoprix|intermarche|lidl|carrefour|super dominique|suc bosquet|nicolas|fnac monop|inglesa|dollarcity|plaza de andres|bold co/i,
                                                              "groceries"],
  [/pharmacie|aquaboulevard|ideal optic|santé|sport|gym|deca/i,                  "health"],
  [/uniqlo|zara|lego|grande recre|el ganso|zalando|fnac|taschen|monoprix les champs|licencia/i,
                                                              "shopping"],
  [/airbnb|iberia|transavia|air europa|hotel|booking|aeroport|cdg|orly|aeropuerto|malaga|madrid barajas|aeropuerto|barcelona|train|sncf|trainline/i,
                                                              "travel"],
  [/google\*google|openai|chatgpt|claude\.ai|netflix|spotify|notion|vercel|railway|github|cursor|imagineart|myheritage|twilio|uber one|cotisation/i,
                                                              "subscriptions"],
  [/lenovo|apple|samsung/i,                                   "shopping"],
  [/ticketnet|cinema|theatre|fnac (?!monop)|spectacle/i,      "entertainment"],
  [/front de seine|emova production|seggali|aqu/i,            "other"], // unclear, dump
  [/prelevement automatique/i,                                "transfers"],
  [/versement|cotisation/i,                                   "fees"],
];

function categorize(desc) {
  for (const [rx, cat] of RULES) if (rx.test(desc)) return cat;
  return "other";
}

function parseFrenchAmount(s) {
  // "9,15" -> 9.15  ;  "-326,66" -> -326.66  ;  "1349,10" -> 1349.10
  if (s == null || s === "") return 0;
  const cleaned = String(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseAmexDate(s) {
  // MM/DD/YYYY -> YYYY-MM-DD
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

const files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".csv"));
console.error(`[import] found ${files.length} CSV files in ${folder}`);

const all = [];
for (const f of files) {
  const content = fs.readFileSync(path.join(folder, f), "utf8");
  let rows;
  try {
    rows = parse(content, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  } catch (err) {
    console.error(`[import] ${f}: parse error ${err.message}`);
    continue;
  }
  for (const r of rows) {
    const date     = parseAmexDate(r.Date);
    const desc     = (r.Description || "").trim().replace(/\s+/g, " ");
    const rawAmt   = parseFrenchAmount(r.Montant);
    if (!date || !desc) continue;
    // Flip sign: Amex CSV positive = charge -> store as negative outflow.
    const amount = -rawAmt;
    all.push({
      date,
      merchant:    desc,
      amount,
      currency:    "EUR",
      category:    categorize(desc),
      description: desc,
      external_id: `amex:${r.Référence ? r.Référence.replace(/'/g, "") : `${date}|${desc}|${rawAmt}`}`,
    });
  }
}

// Dedupe by external_id
const seen = new Map();
for (const t of all) if (!seen.has(t.external_id)) seen.set(t.external_id, t);
const txs = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));

// ── Summary ───────────────────────────────────────────────────────────────
const expenses = txs.filter((t) => t.amount < 0 && t.category !== "transfers");
const totalSpend = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);

const byMonth = {};
for (const t of expenses) {
  const m = t.date.slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + Math.abs(t.amount);
}

const byCategory = {};
for (const t of expenses) {
  byCategory[t.category] = (byCategory[t.category] || 0) + Math.abs(t.amount);
}

const merchantTotals = {};
for (const t of expenses) {
  // Normalize merchant: strip city + Amex padding, take first significant word
  const key = t.merchant.replace(/\s{2,}.*$/, "").trim();
  merchantTotals[key] = (merchantTotals[key] || 0) + Math.abs(t.amount);
}
const topMerchants = Object.entries(merchantTotals)
  .sort((a, b) => b[1] - a[1]).slice(0, 15);

const summary = {
  source_folder: folder,
  raw_rows: all.length,
  deduped: txs.length,
  date_range: txs.length ? { from: txs[0].date, to: txs[txs.length - 1].date } : null,
  total_spend_eur: Math.round(totalSpend * 100) / 100,
  transfers_excluded: txs.filter((t) => t.category === "transfers").length,
  by_month: Object.fromEntries(Object.entries(byMonth).sort().reverse().map(([k, v]) => [k, Math.round(v * 100) / 100])),
  by_category: Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  top_merchants: topMerchants.map(([m, v]) => ({ merchant: m, total: Math.round(v * 100) / 100 })),
};

console.log(JSON.stringify(summary, null, 2));

// ── Normalized CSV for later bot ingest ───────────────────────────────────
const outPath = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "normalized-amex.csv");
const lines = ["date,merchant,amount,currency,category,description,external_id"];
for (const t of txs) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  lines.push([t.date, esc(t.merchant), t.amount, t.currency, t.category, esc(t.description), esc(t.external_id)].join(","));
}
fs.writeFileSync(outPath, lines.join("\n"));
console.error(`[import] normalized CSV written to ${outPath} (${txs.length} rows)`);
