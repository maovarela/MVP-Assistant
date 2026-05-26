#!/usr/bin/env node
// Set sensible match_keyword on the user's planned variables so they capture
// their corresponding real transactions. Run once after deploy; idempotent.
//
//   $env:DASH_KEY = "..."
//   node scripts/set-default-variable-keywords.mjs

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
if (!DASH_KEY) { console.error("ERROR: set DASH_KEY"); process.exit(1); }

const DEFAULTS = [
  { label: "Inversion PERCO",       match_keyword: "perco|cofidis|inversion|swisslife.*retraite|swisslife ar|swisslife assurance et" },
  { label: "Pago Deuda",            match_keyword: "davivienda|bancolombia|prestamo|cuota|amortiz|corredores" },
  { label: "Pago tarjeta Colombia", match_keyword: "tarjeta colombia|mastercard col|visa col|cuota tarjeta" },
  { label: "Cleopatra",             match_keyword: "cleopatra" },
  { label: "Uniqlo",                match_keyword: "uniqlo" },
  { label: "Medicina",              match_keyword: "medicina|farma|drogueria|consulta medica" },
  { label: "Comision Banco",        match_keyword: "commissions|frais bnp|cotisation a une offre|cotisation situation" },
];

for (const { label, match_keyword } of DEFAULTS) {
  const r = await fetch(`${HOST}/api/match-keyword?key=${encodeURIComponent(DASH_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, match_keyword, target: "variable" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) console.error(`  ✗ ${label} → ${j.error || r.status}`);
  else                  console.log(`  ✓ ${label.padEnd(28)} /${match_keyword}/  (${j.updated?.length || 0} periods)`);
}
console.log("\n[done] refresh the dashboard to see the new variable actuals.");
