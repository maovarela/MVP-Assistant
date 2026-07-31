#!/usr/bin/env node
// audit-revolut.mjs
// Audits the Revolut rows in a live DB against an authoritative "complete
// history" consolidated export.
//
// Why this exists: the consolidated export can't be reconciled row-by-row (its
// layout reorders same-day rows), so importing it gives no integrity check at
// all. But the AGGREGATE check is order-independent and works fine:
//
//     opening + Σ(transactions) == closing
//
// using the running Balance column the export already carries. That check found
// 21 rows in the DB that the account's own balance history says never happened
// — Revolut pre-authorizations that were imported from an older export and
// later reverted. The natural-key overlap guard can't catch those, because the
// settled row differs in amount or date from the provisional one.
//
// READ-ONLY: this script never writes. To remove what it finds, POST the ids to
// /api/transactions/delete (send dry_run first).
//
// Usage:
//   $env:DASH_KEY = "..."
//   node scripts/audit-revolut.mjs "<path to consolidated export.csv>" [host]

import fs from "fs";
import { parse } from "csv-parse/sync";
import { parseRevolutCsv } from "../bankCsv.js";

const FILE = process.argv[2];
const HOST = (process.argv[3] || process.env.HOST || "https://money.mauriciovarela.com").replace(/\/$/, "");
const KEY  = process.env.DASH_KEY;

if (!FILE) { console.error("usage: node scripts/audit-revolut.mjs <consolidated-export.csv> [host]"); process.exit(1); }
if (!KEY)  { console.error("ERROR: set DASH_KEY"); process.exit(1); }

const content = fs.readFileSync(FILE, "utf8");
const fileTx  = parseRevolutCsv(content);

const payload = await (await fetch(
  `${HOST}/api/transactions.json?accounts=revolut&limit=2000&key=${encodeURIComponent(KEY)}`)).json();
const dbTx = Array.isArray(payload) ? payload : (payload.rows || payload.transactions || []);
if (!dbTx.length) { console.error("no Revolut rows returned from the DB"); process.exit(1); }
console.log(`file rows: ${fileTx.length}   db rows: ${dbTx.length}`);

// ── Multiset diff on the natural key ────────────────────────────────────────
const key = (t) => [
  String(t.date).slice(0, 10),
  Math.round(Number(t.amount) * 100),
  (t.currency || "EUR").toUpperCase(),
  String(t.merchant || "").trim().toLowerCase().replace(/\s+/g, " "),
].join("|");

const tally = (list) => list.reduce((m, t) => m.set(key(t), (m.get(key(t)) || 0) + 1), new Map());
const fileC = tally(fileTx), dbC = tally(dbTx);
const byKey = dbTx.reduce((m, t) => m.set(key(t), [...(m.get(key(t)) || []), t]), new Map());

const missing = [...fileC].filter(([k, n]) => n > (dbC.get(k) || 0));
const extra   = [...dbC].filter(([k, n]) => n > (fileC.get(k) || 0));

console.log(`\nIN FILE, NOT IN DB (data loss): ${missing.length}`);
for (const [k, n] of missing) console.log(`   x${n - (dbC.get(k) || 0)}  ${k}`);

console.log(`\nIN DB, NOT IN FILE (never happened per the statement): ${extra.length}`);
const extraIds = [];
for (const [k] of extra) for (const t of byKey.get(k) || []) { extraIds.push(t.id); console.log(`   id=${String(t.id).padStart(5)}  ${k}`); }

// ── EUR net per month: file vs DB ───────────────────────────────────────────
const sumBy = (list) => list.reduce((m, t) => {
  if ((t.currency || "EUR").toUpperCase() !== "EUR") return m;
  const p = String(t.date).slice(0, 7);
  return m.set(p, Math.round(((m.get(p) || 0) + Number(t.amount)) * 100) / 100);
}, new Map());
const fSum = sumBy(fileTx), dSum = sumBy(dbTx);
console.log(`\nEUR net change per month`);
let bad = 0;
for (const p of [...new Set([...fSum.keys(), ...dSum.keys()])].sort()) {
  const a = fSum.get(p) ?? 0, b = dSum.get(p) ?? 0, ok = Math.abs(a - b) < 0.01;
  if (!ok) bad++;
  console.log(`   ${p}  file=${a.toFixed(2).padStart(10)}  db=${b.toFixed(2).padStart(10)}  ${ok ? "ok" : "*** MISMATCH ***"}`);
}

// ── Order-independent balance anchor over the EUR stream ────────────────────
const HEADER = "Date,Description,Category,Money in/out,Balance,Tax withheld,Other taxes,Fees";
const lines = content.split(/\r?\n/);
let ccy = "EUR"; const eur = [];
for (let i = 0; i < lines.length; i++) {
  const acct = lines[i].match(/^Personal Account \(([A-Z]{3})\),*$/);
  if (acct) { ccy = acct[1]; continue; }
  if (lines[i].replace(/,+$/, "") !== HEADER) continue;
  const block = [HEADER];
  for (let j = i + 1; j < lines.length; j++) {
    const s = lines[j].replace(/,+$/, "").trim();
    if (s === "" || s.startsWith("---") || s.startsWith("Personal Account ")) break;
    block.push(lines[j]);
  }
  if (ccy !== "EUR") continue;
  for (const row of parse(block.join("\n"), { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true, trim: true })) {
    const b = parseFloat(String(row.Balance || "").replace(/[^\d.-]/g, ""));
    const a = parseFloat(String(row["Money in/out"] || "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(b) && Number.isFinite(a)) eur.push({ bal: b, amt: a });
  }
}

let anchorOk = null;
if (eur.length) {
  const opening = Math.round((eur[0].bal - eur[0].amt) * 100) / 100;
  const closing = eur[eur.length - 1].bal;
  const delta   = Math.round((closing - opening) * 100) / 100;
  const fAll = Math.round([...fSum.values()].reduce((s, v) => s + v, 0) * 100) / 100;
  const dAll = Math.round([...dSum.values()].reduce((s, v) => s + v, 0) * 100) / 100;
  anchorOk = Math.abs(delta - dAll) < 0.05;
  console.log(`\nEUR balance anchor (order-independent)`);
  console.log(`   opening ${opening}  →  closing ${closing}   delta ${delta}`);
  console.log(`   Σ file ${fAll}   ${Math.abs(delta - fAll) < 0.05 ? "ok" : "*** file itself does not reconcile ***"}`);
  console.log(`   Σ db   ${dAll}   ${anchorOk ? "ok" : `*** MISMATCH, db off by ${Math.round((dAll - delta) * 100) / 100} ***`}`);
}

const clean = !missing.length && !extra.length && !bad && anchorOk !== false;
console.log(`\n${clean ? "CLEAN — the DB matches the authoritative history." : "DISCREPANCIES FOUND (see above)."}`);
if (extraIds.length) {
  console.log(`\nTo remove the DB-only rows:`);
  console.log(`  POST ${HOST}/api/transactions/delete?key=$DASH_KEY`);
  console.log(`  {"dry_run": true, "ids": [${extraIds.join(",")}]}`);
}
process.exit(clean ? 0 : 2);
