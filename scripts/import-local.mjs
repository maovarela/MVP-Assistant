#!/usr/bin/env node
// One-shot local importer. Walks one or more folders of bank CSV statements,
// auto-detects format (Amex FR vs Revolut consolidated), normalizes everything
// to the bot's transaction shape, prints a summary, and writes
// scripts/normalized-transactions.csv ready to bulk-load once the Railway
// volume is mounted.
//
// Usage:
//   node scripts/import-local.mjs <folder> [<folder>...]
//
// Format detection (heuristic, based on first non-empty line):
//   - Amex FR:  contains "Montant" and "Référence"
//   - Revolut:  contains "Money in/out" (line appears mid-file; we scan)

import { parse } from "csv-parse/sync";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error("Usage: node scripts/import-local.mjs <folder> [<folder>...]");
  process.exit(1);
}

// ─── Categorizer ────────────────────────────────────────────────────────────

const RULES = [
  [/uber\s*eats|deliveroo|just\s*eat/i,                      "restaurants"],
  [/uber(?!\s*eats)|bolt|cabify|free now|smovengo|velib|fpx |paris paris|relay|aeroport|cdg|orly|taxi/i,
                                                              "transport"],
  [/iberia|transavia|air europa|airbnb|hotel|booking|aeropuerto|sncf|trainline|ouigo|easyjet|ryanair|wizz/i,
                                                              "travel"],
  [/restaurant|asado|casa de tapas|club sauvage|empanadas|sushi|pizza|tacos|burger|pret a manger|seggali|chez |brasserie|tapas|teriyaki|crepes|pizzardi|du pain|two tails|bcs co|grupo cob|naturalia|le \w|la \w/i,
                                                              "restaurants"],
  [/monoprix|intermarche|lidl|carrefour|super dominique|suc bosquet|nicolas|fnac monop|inglesa|dollarcity|plaza de andres|bold co|olimpica|ol\W?mpica|aldi|jumbo|farmatodo|miniso|casaideas/i,
                                                              "groceries"],
  [/pharmacie|aquaboulevard|ideal optic|santé|sante|neoness|gym|deca|hospital/i, "health"],
  [/uniqlo|zara|lego|grande recre|el ganso|zalando|fnac|taschen|monoprix les champs|licencia|sodicma|lenovo|apple|samsung|tienda/i,
                                                              "shopping"],
  [/google\*google|openai|chatgpt|claude\.ai|netflix|spotify|notion|vercel|railway|github|cursor|imagineart|myheritage|twilio|uber one|cotisation/i,
                                                              "subscriptions"],
  [/ticketnet|cinema|theatre|spectacle|concert|museo|museum/i, "entertainment"],
  [/top.?up|topup/i,                                          "income"],
  [/transfer to/i,                                            "transfers"],
  [/prelevement automatique/i,                                "transfers"],
  [/versement/i,                                              "fees"],
];

function categorize(desc) {
  for (const [rx, cat] of RULES) if (rx.test(desc)) return cat;
  return "other";
}

// ─── Amex FR parser ─────────────────────────────────────────────────────────

function parseFrenchAmount(s) {
  if (s == null || s === "") return 0;
  const cleaned = String(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseAmexDate(s) {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseAmexFile(content, sourceFile) {
  const rows = parse(content, {
    columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true,
  });
  const out = [];
  for (const r of rows) {
    const date   = parseAmexDate(r.Date);
    const desc   = (r.Description || "").trim().replace(/\s+/g, " ");
    const rawAmt = parseFrenchAmount(r.Montant);
    if (!date || !desc) continue;
    // Amex sign convention is INVERTED. Flip to bot's "negative = outflow".
    const amount = -rawAmt;
    const refRaw = (r.Référence || r["Reference"] || "").replace(/'/g, "");
    const externalId = `amex:${refRaw || `${date}|${desc}|${rawAmt}`}`;
    out.push({
      date, merchant: desc, amount, currency: "EUR",
      category: categorize(desc), description: desc,
      external_id: externalId, source_file: sourceFile,
    });
  }
  return out;
}

// ─── Revolut parser ─────────────────────────────────────────────────────────

const REVOLUT_HEADER = "Date,Description,Category,Money in/out,Balance,Tax withheld,Other taxes,Fees";
const REVOLUT_DATE_RX = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const MONTHS = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06", Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };

function parseRevolutDate(s) {
  const m = String(s || "").trim().match(REVOLUT_DATE_RX);
  if (!m) return null;
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${MONTHS[m[1]]}-${day}`;
}

function parseRevolutMoney(s) {
  // "-â¬9.72" or "€300.00" — the leading char is the currency glyph mangled
  // via UTF-8-as-Latin1. We only need sign + numeric value.
  if (!s) return { amount: 0, currency: "EUR" };
  const cleaned = String(s).replace(/[^\d.,\-]/g, ""); // strip everything but digits, dot, comma, minus
  // Revolut uses "." decimal in EN exports. If there are both "," and ".", drop "," as thousand sep.
  const norm = cleaned.includes(",") && cleaned.includes(".") ? cleaned.replace(/,/g, "") : cleaned.replace(",", ".");
  const n = parseFloat(norm);
  return { amount: Number.isFinite(n) ? n : 0, currency: "EUR" }; // assume EUR section; account header tells truth but we ignore for now
}

function parseRevolutFile(content, sourceFile) {
  // The file has account summaries + multiple transaction sections per currency.
  // Strategy: split on lines, find each "Date,Description,Category,Money in/out,..."
  // header, then parse the block of CSV rows that follows until the next blank
  // line / section break.
  const lines = content.split(/\r?\n/);
  const out = [];

  let currentCurrency = "EUR";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Track currency from "Personal Account (XXX)" markers
    const acctMatch = line.match(/^Personal Account \(([A-Z]{3})\),*$/);
    if (acctMatch) { currentCurrency = acctMatch[1]; i++; continue; }

    // Detect a transaction header
    if (line.replace(/,+$/, "") === REVOLUT_HEADER) {
      // Collect rows until blank line or another header
      const block = [REVOLUT_HEADER];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const stripped = l.replace(/,+$/, "").trim();
        if (stripped === "" || stripped.startsWith("---") || stripped.startsWith("Personal Account ")) break;
        block.push(l);
        i++;
      }
      try {
        const rows = parse(block.join("\n"), {
          columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true,
        });
        for (const r of rows) {
          const date = parseRevolutDate(r.Date);
          const desc = (r.Description || "").trim();
          if (!date || !desc) continue;
          const { amount } = parseRevolutMoney(r["Money in/out"]);
          if (amount === 0) continue;
          const id = crypto.createHash("sha1")
            .update(`revolut|${currentCurrency}|${date}|${desc}|${amount}|${r.Balance || ""}`).digest("hex").slice(0, 16);
          out.push({
            date, merchant: desc, amount, currency: currentCurrency,
            category: categorize(desc), description: desc,
            external_id: `revolut:${id}`, source_file: sourceFile,
          });
        }
      } catch (err) {
        console.error(`[revolut] block parse error in ${sourceFile}: ${err.message}`);
      }
      continue;
    }
    i++;
  }
  return out;
}

// ─── Format detector ────────────────────────────────────────────────────────

function detectFormat(content) {
  const head = content.slice(0, 2000);
  if (head.includes("Money in/out") || head.includes("Revolut")) return "revolut";
  if (head.includes("Montant") && head.includes("Référence")) return "amex";
  if (head.match(/^Date,Description,Montant/)) return "amex";
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const all = [];
for (const folder of folders) {
  if (!fs.existsSync(folder)) { console.error(`[skip] ${folder} not found`); continue; }
  const files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".csv"));
  console.error(`[scan] ${folder} — ${files.length} files`);
  for (const f of files) {
    const fullPath = path.join(folder, f);
    const content = fs.readFileSync(fullPath, "utf8");
    const fmt = detectFormat(content);
    if (!fmt) { console.error(`  [skip] ${f}: unknown format`); continue; }
    const txs = fmt === "amex" ? parseAmexFile(content, f) : parseRevolutFile(content, f);
    console.error(`  [${fmt}] ${f} -> ${txs.length} rows`);
    all.push(...txs);
  }
}

// Dedup by external_id
const seen = new Map();
for (const t of all) if (!seen.has(t.external_id)) seen.set(t.external_id, t);
const txs = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));

// ─── Summary ────────────────────────────────────────────────────────────────

const expenses = txs.filter((t) => t.amount < 0 && t.category !== "transfers");
const totalSpend = expenses.reduce((s, t) => s + Math.abs(t.amount), 0);

const byMonth = {};
for (const t of expenses) {
  const m = t.date.slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + Math.abs(t.amount);
}

const bySource = {};
for (const t of expenses) {
  const source = t.external_id.split(":")[0];
  bySource[source] = (bySource[source] || 0) + Math.abs(t.amount);
}

const byCategory = {};
for (const t of expenses) byCategory[t.category] = (byCategory[t.category] || 0) + Math.abs(t.amount);

const merchantTotals = {};
for (const t of expenses) {
  const key = t.merchant.replace(/\s{2,}.*$/, "").trim();
  merchantTotals[key] = (merchantTotals[key] || 0) + Math.abs(t.amount);
}
const topMerchants = Object.entries(merchantTotals).sort((a, b) => b[1] - a[1]).slice(0, 20);

const rnd = (n) => Math.round(n * 100) / 100;
const summary = {
  raw_rows: all.length,
  deduped:  txs.length,
  date_range: txs.length ? { from: txs[0].date, to: txs[txs.length - 1].date } : null,
  total_spend_eur: rnd(totalSpend),
  transfers_excluded: txs.filter((t) => t.category === "transfers").length,
  by_source: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, rnd(v)])),
  by_month:  Object.fromEntries(Object.entries(byMonth).sort().reverse().map(([k, v]) => [k, rnd(v)])),
  by_category: Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, rnd(v)])),
  top_merchants: topMerchants.map(([m, v]) => ({ merchant: m, total: rnd(v) })),
};

console.log(JSON.stringify(summary, null, 2));

// ─── Normalized CSV ─────────────────────────────────────────────────────────

const outPath = path.join("scripts", "normalized-transactions.csv");
const lines = ["date,merchant,amount,currency,category,description,external_id,source_file"];
for (const t of txs) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  lines.push([t.date, esc(t.merchant), t.amount, t.currency, t.category, esc(t.description), esc(t.external_id), esc(t.source_file)].join(","));
}
fs.writeFileSync(outPath, lines.join("\n"));
console.error(`[done] ${txs.length} rows written to ${outPath}`);
