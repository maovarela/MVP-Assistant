#!/usr/bin/env node
// import-sheet.mjs
// Walks the user's "MVP Financial Model" xlsx and produces one budget seed per
// monthly tab. Two modes:
//
//   node scripts/import-sheet.mjs <path>            # dry-run, prints summary
//   node scripts/import-sheet.mjs <path> --commit   # POSTs each to /api/budget
//
// Env vars when --commit:
//   DASH_KEY  (required) — same key the dashboard uses
//   HOST      (optional) — defaults to mvp-assistant-production.up.railway.app
//
// Strategy: label-based discovery rather than hard-coded columns. Tabs across
// years have shifted layouts (FOREX at col J vs K, Gastos Fijos at col 6 vs 7).
// We find anchor labels ("Prestamo", "Arriendo", "USD-COP", etc.) and read the
// adjacent numeric cells.

import xlsx from "xlsx";

const args   = process.argv.slice(2);
const path   = args[0];
const commit = args.includes("--commit");
const verbose = args.includes("--verbose");
if (!path) {
  console.error("usage: node scripts/import-sheet.mjs <path-to-xlsx> [--commit] [--verbose]");
  process.exit(1);
}

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
if (commit && !DASH_KEY) {
  console.error("ERROR: --commit requires DASH_KEY env var");
  process.exit(1);
}

// ─── Maps ───────────────────────────────────────────────────────────────────

const MONTHS = {
  enero:"01", ene:"01",
  febrero:"02", feb:"02",
  marzo:"03", mar:"03",
  abril:"04", abr:"04",
  mayo:"05", may:"05",
  junio:"06", jun:"06",
  julio:"07", jul:"07",
  agosto:"08", ago:"08", agt:"08",
  septiembre:"09", sept:"09", sep:"09",
  octubre:"10", oct:"10",
  noviembre:"11", nov:"11",
  diciembre:"12", dic:"12", dec:"12",
};

function tabToPeriod(name) {
  // "Mayo 2024" -> "2024-05"; ignore undated tabs
  const m = name.toLowerCase().trim().match(/^([a-záéíóúñ]+)\.?\s+(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[1]];
  if (!mm) return null;
  return `${m[2]}-${mm}`;
}

// Known fixed-expense labels we've seen across years → bot category.
// Unknown labels are still imported (kept as fixed) but with category=null
// so the dashboard won't link them to actuals — we can fix later.
const FIXED_CAT = {
  "arriendo": "housing",
  "comida":   "groceries",
  "electricidad": "housing",
  "luz":      "housing",
  "internet": "housing",
  "internet+tel": "housing",
  "internet + tel": "housing",
  "seguro":   "fees",
  "metro":    "transport",
  "velib":    "transport",
  "vélib":    "transport",
  "bici":     "transport",
  "therapy":  "health",
  "gym":      "health",
  "timbre":   "fees",
  "deudas":   "transfers",
  "credito":  "transfers",
  "adicionales": "other",
};

// Heuristic for variable expenses
function varCategory(label) {
  const s = String(label || "").toLowerCase();
  if (/comision|impuestos|tax/.test(s)) return "fees";
  if (/pago tarjeta|pago deuda|inversion|perco|nuevo viaje/.test(s)) return "transfers";
  if (/proteina|medicina|farma|gimnasio/.test(s)) return "health";
  if (/viaje|colombia|hotel|airbnb|vuelo|flight/.test(s)) return "travel";
  if (/zapatos|chaqueta|uniqlo|amazon|decathlon|bici|gafas|tennis|barbour/.test(s)) return "shopping";
  if (/note de frais/.test(s)) return "other";
  return "other";
}

// ─── Sheet parsing ──────────────────────────────────────────────────────────

function rowsOf(wb, sheetName) {
  return xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "", raw: true });
}

function num(x) {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const v = parseFloat(x.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function findCells(rows, predicate) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== "" && v != null && predicate(v, r, c)) out.push({ r, c, v });
    }
  }
  return out;
}

function findLabel(rows, regex) {
  return findCells(rows, (v) => typeof v === "string" && regex.test(v.toLowerCase().trim()));
}

function valueAt(rows, r, c) { return rows[r]?.[c]; }

// FOREX block: find "USD-COP" header cell, read the numeric in the SAME column
// one row down. Same for EUR-USD and Tax France.
function parseFx(rows) {
  const fx = { usd_cop: null, eur_usd: null, tax_fr_pct: 0 };
  for (const cell of findLabel(rows, /^usd[\s-]?cop$/)) {
    const v = num(valueAt(rows, cell.r + 1, cell.c));
    if (v) { fx.usd_cop = v; break; }
  }
  for (const cell of findLabel(rows, /^eur[\s-]?usd$/)) {
    const v = num(valueAt(rows, cell.r + 1, cell.c));
    if (v) { fx.eur_usd = v; break; }
  }
  for (const cell of findLabel(rows, /^tax france$/)) {
    const v = num(valueAt(rows, cell.r + 1, cell.c));
    if (v != null) { fx.tax_fr_pct = v <= 1 ? Math.round(v * 100 * 100) / 100 : v; break; }
  }
  return fx;
}

// Debt: "Prestamo" row, numeric COP in next column (and onwards).
// Also pulls Mastercard / Visa balances (we lump as separate debts).
function parseDebts(rows) {
  const out = [];
  // Prestamo
  for (const cell of findLabel(rows, /^prestamo$/)) {
    const row = rows[cell.r] || [];
    for (let c = cell.c + 1; c < row.length; c++) {
      const v = num(row[c]);
      if (v && v > 1000) { // COP amount, big number
        out.push({ label: "Prestamo COP", amount_src: v, currency: "COP", kind: "loan" });
        break;
      }
    }
    break;
  }
  // Mastercard + Visa (COP balance + USD balance side-by-side)
  for (const cell of findLabel(rows, /^total (mastercard|visa)$/)) {
    const row = rows[cell.r] || [];
    const which = row[cell.c].toLowerCase().includes("mastercard") ? "Mastercard" : "Visa";
    let cop = null, usd = null;
    for (let c = cell.c + 1; c < row.length; c++) {
      const v = num(row[c]);
      if (v == null) continue;
      if (cop == null && v > 1000) { cop = v; continue; }
      if (usd == null && v < 50000 && v >= 0) { usd = v; break; }
    }
    if (cop && cop > 0) out.push({ label: `${which} COP`, amount_src: cop, currency: "COP", kind: "card_balance" });
    if (usd && usd > 0) out.push({ label: `${which} USD`, amount_src: usd, currency: "USD", kind: "card_balance" });
  }
  return out;
}

// Ingresos: "Base" and "Variable" rows. We want NET mensual. Across tabs the
// "Neto"/"Neto mes" column comes one or two cols after "Bruto". Strategy: find
// the row with cell "Base" in col A area; read the next two numeric cells
// (Bruto, Neto). Take the second as net.
function parseIncomes(rows) {
  const out = [];

  function readSalaryRow(label) {
    for (const cell of findLabel(rows, new RegExp(`^${label}$`))) {
      const row = rows[cell.r] || [];
      // First two numeric cells after the label
      const nums = [];
      for (let c = cell.c + 1; c < row.length; c++) {
        const v = num(row[c]);
        if (v != null && v > 0) nums.push(v);
        if (nums.length >= 2) break;
      }
      if (nums.length >= 2) {
        return { bruto: nums[0], neto: nums[1] };
      }
    }
    return null;
  }

  const base = readSalaryRow("base");
  const variable = readSalaryRow("variable");
  if (base) {
    out.push({ label: "Salary Bruto", amount_eur: base.bruto, kind: "salary_bruto" });
    out.push({ label: "Salary Neto",  amount_eur: base.neto + (variable?.neto || 0), kind: "salary_neto" });
  }

  // "Note de frais": label in col A area, value in next non-empty col
  for (const cell of findLabel(rows, /^note de frais$/)) {
    const row = rows[cell.r] || [];
    for (let c = cell.c + 1; c < row.length; c++) {
      const v = num(row[c]);
      if (v != null && v > 0) {
        out.push({ label: "Note de frais", amount_eur: v, kind: "other" });
        break;
      }
    }
  }
  return out;
}

// Gastos Fijos: scan all rows for known category labels in the right half of
// the sheet (col >= 5). For each match, the budget amount is in the cell
// immediately to its LEFT. Skips meta rows like "Gastos Variables" / "Valor Final mes".
function parseFixed(rows) {
  const out = [];
  const seen = new Set();
  const KNOWN = Object.keys(FIXED_CAT);
  for (const cell of findCells(rows, (v, r, c) => c >= 4 && typeof v === "string")) {
    const label = String(cell.v).toLowerCase().trim();
    if (!KNOWN.includes(label)) continue;
    // Skip duplicate labels (xlsx sometimes repeats them)
    if (seen.has(label)) continue;
    const budget = num(valueAt(rows, cell.r, cell.c - 1));
    if (budget == null || budget < 0) continue;
    seen.add(label);
    // Pretty-case the label (Arriendo, Electricidad...)
    const labelPretty = String(cell.v).trim().replace(/\s+/g, " ");
    out.push({
      label:      labelPretty.replace(/\b\w/g, (m) => m.toUpperCase()),
      budget_eur: budget,
      category:   FIXED_CAT[label],
    });
  }
  return out;
}

// Gastos Variables: find "Gastos Variables" header, then read the (label, amount)
// pairs in that column and the next one. The header row above the data has
// "Total" + total amount — skip that.
function parseVariable(rows) {
  const out = [];
  const header = findLabel(rows, /^gastos variables$/)[0];
  if (!header) return out;
  const labelCol = header.c;
  const amountCol = header.c + 1;
  // Walk down, skipping the "Total | <number>" row
  for (let r = header.r + 1; r < rows.length && r < header.r + 25; r++) {
    const label = rows[r]?.[labelCol];
    const amount = num(rows[r]?.[amountCol]);
    if (!label || typeof label !== "string") continue;
    const labelStr = label.trim();
    if (/^total$/i.test(labelStr)) continue;
    if (amount == null || amount === 0) continue;
    out.push({
      label:      labelStr,
      amount_eur: amount,
      category:   varCategory(labelStr),
    });
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const wb = xlsx.readFile(path);
console.log(`[sheet] ${path} — ${wb.SheetNames.length} tabs`);

const seeds = [];
const skipped = [];
for (const tab of wb.SheetNames) {
  const period = tabToPeriod(tab);
  if (!period) { skipped.push(tab); continue; }
  const rows = rowsOf(wb, tab);
  const seed = {
    period,
    fx:       parseFx(rows),
    incomes:  parseIncomes(rows),
    fixed:    parseFixed(rows),
    variable: parseVariable(rows),
    debts:    parseDebts(rows),
  };
  // Drop FX if both rates missing
  if (seed.fx.usd_cop == null && seed.fx.eur_usd == null) delete seed.fx;
  // Drop debts if no FX (importNormalized requires FX to compute EUR)
  if (!seed.fx && seed.debts.length) seed.debts = [];
  seeds.push({ tab, seed });
  if (verbose) {
    console.log(`\n[${tab}] period=${period}`);
    console.log(`  fx:       ${JSON.stringify(seed.fx)}`);
    console.log(`  incomes:  ${seed.incomes.length}`);
    console.log(`  fixed:    ${seed.fixed.length} → ${seed.fixed.map((f) => f.label).join(", ")}`);
    console.log(`  variable: ${seed.variable.length}`);
    console.log(`  debts:    ${seed.debts.length}`);
  }
}

// Dedupe by period — if multiple tabs map to the same period, keep the richest.
const byPeriod = new Map();
for (const s of seeds) {
  const score = (s.seed.incomes.length + s.seed.fixed.length + s.seed.variable.length + s.seed.debts.length);
  const existing = byPeriod.get(s.seed.period);
  if (!existing || score > existing.score) byPeriod.set(s.seed.period, { ...s, score });
}
const finalSeeds = [...byPeriod.values()].sort((a, b) => a.seed.period.localeCompare(b.seed.period));

console.log(`\n[summary] ${finalSeeds.length} unique periods, ${skipped.length} tabs skipped`);
console.log(`[skipped] ${skipped.join(", ")}`);
console.log(`\n[per period]`);
for (const s of finalSeeds) {
  const x = s.seed;
  console.log(
    `  ${s.seed.period}  inc=${x.incomes.length}  fix=${x.fixed.length}  var=${x.variable.length}  debt=${x.debts.length}  fx=${x.fx ? "y" : "n"}  (from "${s.tab}")`
  );
}

if (!commit) {
  console.log("\n(dry-run — pass --commit to POST to /api/budget)");
  process.exit(0);
}

// ─── Commit ─────────────────────────────────────────────────────────────────

async function post(period, kind, payload) {
  const r = await fetch(`${HOST}/api/budget?key=${encodeURIComponent(DASH_KEY)}`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ period, kind, payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.row;
}

console.log(`\n[commit] target ${HOST}`);
let ok = 0, fail = 0;
for (const s of finalSeeds) {
  const { period } = s.seed;
  try {
    // FX FIRST so debts can compute EUR
    if (s.seed.fx) await post(period, "fx", s.seed.fx);
    for (const i of s.seed.incomes)  await post(period, "income",   i);
    for (const f of s.seed.fixed)    await post(period, "fixed",    f);
    for (const v of s.seed.variable) await post(period, "variable", v);
    for (const d of s.seed.debts)    await post(period, "debt",     d);
    const total = 1 + s.seed.incomes.length + s.seed.fixed.length + s.seed.variable.length + s.seed.debts.length;
    console.log(`  ✓ ${period} — ${total} rows`);
    ok++;
  } catch (err) {
    console.error(`  ✗ ${period} — ${err.message}`);
    fail++;
  }
}
console.log(`\n[done] ${ok} periods OK, ${fail} failed`);
