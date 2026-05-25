#!/usr/bin/env node
// One-shot seed importer for the budget dashboard.
// Reads scripts/budget-seed.json and POSTs each row to /api/budget.
//
// Usage:
//   $env:DASH_KEY = "your-key"
//   node scripts/seed-budget.mjs
//   # OR target a different host:
//   $env:HOST = "http://localhost:8080"; node scripts/seed-budget.mjs

import fs from "fs";
import path from "path";

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
const SEED     = path.join("scripts", "budget-seed.json");

if (!DASH_KEY) {
  console.error("ERROR: set DASH_KEY env var. e.g. $env:DASH_KEY = \"...\"");
  process.exit(1);
}
if (!fs.existsSync(SEED)) {
  console.error(`ERROR: ${SEED} not found. Copy budget-seed.example.json and edit.`);
  process.exit(1);
}

const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
const period = seed.period;
if (!/^\d{4}-\d{2}$/.test(period || "")) {
  console.error("ERROR: seed.period must be YYYY-MM");
  process.exit(1);
}

async function post(kind, payload) {
  const r = await fetch(`${HOST}/api/budget?key=${encodeURIComponent(DASH_KEY)}`, {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify({ period, kind, payload }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(`${kind} ${JSON.stringify(payload)} → HTTP ${r.status} ${JSON.stringify(body)}`);
  return body.row;
}

(async () => {
  console.log(`[seed] target host: ${HOST}`);
  console.log(`[seed] period:      ${period}`);

  // FX FIRST — debts need rates to compute amount_eur.
  if (seed.fx) {
    const row = await post("fx", seed.fx);
    console.log(`[seed] fx → usd_cop=${row.usd_cop} eur_usd=${row.eur_usd}`);
  }

  for (const inc of seed.incomes || []) {
    const row = await post("income", inc);
    console.log(`[seed] income → ${row.label} €${row.amount_eur}`);
  }
  for (const f of seed.fixed || []) {
    const row = await post("fixed", f);
    console.log(`[seed] fixed  → ${row.label} €${row.budget_eur} (${row.category || "—"})`);
  }
  for (const v of seed.variable || []) {
    const row = await post("variable", v);
    console.log(`[seed] var    → ${row.label} €${row.amount_eur}`);
  }
  for (const d of seed.debts || []) {
    const row = await post("debt", d);
    console.log(`[seed] debt   → ${row.label} ${row.amount_src} ${row.currency} = €${row.amount_eur}`);
  }

  console.log(`[seed] done — open ${HOST}/dashboard?key=...&period=${period}`);
})().catch((err) => { console.error("[seed] failed:", err.message); process.exit(1); });
