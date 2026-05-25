#!/usr/bin/env node
// clone-period.mjs
// Copies a full budget snapshot (FX + incomes + fixed + variable + debts) from
// one period to another. Useful when a new month starts and the structure
// matches the previous month — saves re-entering 9 fixed expenses, FX rates,
// salary, etc.
//
// Usage:
//   $env:DASH_KEY = "..."
//   node scripts/clone-period.mjs --from 2025-11 --to 2026-05
//
// Behaviour:
//   - Reads source period via GET /api/dashboard.json (no DB access needed).
//   - For each row, POSTs to /api/budget with the target period. UPSERT-aware
//     endpoints mean re-running is safe — same row gets updated, not duplicated.
//   - Skips actuals (they live in the transactions table, not the budget
//     tables — only planned values are cloned).

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
const FROM     = args.from;
const TO       = args.to;

if (!DASH_KEY) { console.error("ERROR: set DASH_KEY env var"); process.exit(1); }
if (!FROM || !TO || !/^\d{4}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}$/.test(TO)) {
  console.error("usage: --from YYYY-MM --to YYYY-MM");
  process.exit(1);
}

async function get(period) {
  const r = await fetch(`${HOST}/api/dashboard.json?key=${encodeURIComponent(DASH_KEY)}&period=${period}`);
  if (!r.ok) throw new Error(`GET ${period} → HTTP ${r.status}`);
  return r.json();
}

async function post(period, kind, payload) {
  const r = await fetch(`${HOST}/api/budget?key=${encodeURIComponent(DASH_KEY)}`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ period, kind, payload }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${kind} → HTTP ${r.status} ${JSON.stringify(j)}`);
  return j.row;
}

console.log(`[clone] ${FROM} → ${TO}`);
console.log(`[clone] target host: ${HOST}`);

const src = await get(FROM);
if (!src.fixed.length && !src.variable.length && !src.incomes.length) {
  console.error(`[clone] source ${FROM} is empty — nothing to copy`);
  process.exit(1);
}

// FX first so debts can compute amount_eur on insert
if (src.fx) {
  const r = await post(TO, "fx", {
    usd_cop:    src.fx.usd_cop,
    eur_usd:    src.fx.eur_usd,
    tax_fr_pct: src.fx.tax_fr_pct,
  });
  console.log(`[clone] fx → usd_cop=${r.usd_cop} eur_usd=${r.eur_usd}`);
}

for (const i of src.incomes) {
  const r = await post(TO, "income", {
    label:      i.label,
    amount_eur: i.amount_eur,
    amount_src: i.amount_src,
    currency:   i.currency,
    kind:       i.kind,
  });
  console.log(`[clone] income → ${r.label} €${r.amount_eur}`);
}

for (const f of src.fixed) {
  const r = await post(TO, "fixed", {
    label:      f.label,
    budget_eur: f.budget_eur,
    category:   f.category,
  });
  console.log(`[clone] fixed  → ${r.label} €${r.budget_eur} (${r.category || "—"})`);
}

for (const v of src.variable) {
  const r = await post(TO, "variable", {
    label:      v.label,
    amount_eur: v.amount_eur,
    category:   v.category,
  });
  console.log(`[clone] var    → ${r.label} €${r.amount_eur}`);
}

for (const d of src.debts) {
  const r = await post(TO, "debt", {
    label:      d.label,
    amount_src: d.amount_src,
    currency:   d.currency,
    kind:       d.kind,
  });
  console.log(`[clone] debt   → ${r.label} ${r.amount_src} ${r.currency} = €${r.amount_eur}`);
}

console.log(`\n[done] cloned to ${TO} — open ${HOST}/dashboard?key=...&period=${TO}`);
