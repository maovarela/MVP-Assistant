#!/usr/bin/env node
// One-shot: set sensible match_keyword regexes on the user's 9 standard fijos.
// Tuned to the merchants we've seen across Amex / Revolut / BNP statements.
//
// Run with:
//   $env:DASH_KEY = "..."
//   node scripts/set-default-match-keywords.mjs
//
// Idempotent — re-running just overwrites.

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
if (!DASH_KEY) { console.error("ERROR: set DASH_KEY"); process.exit(1); }

const DEFAULTS = [
  { label: "Arriendo",     match_keyword: "arrend|alquiler|loyer|sogeprom|virement.*habit" },
  { label: "Comida",       match_keyword: "monoprix|carrefour|intermarche|lidl|mercadona|picard|aldi|naturalia|super dominique|suc bosquet|nicolas|fnac monop|supermerc|autoservice" },
  { label: "Electricidad", match_keyword: "totalenergies|edf|engie|enedis|electric" },
  { label: "Internet+Tel", match_keyword: "free telecom|free haut|free mobile|orange|sfr|sosh|bouygues" },
  { label: "Seguro",       match_keyword: "cardif|swisslife|allianz|axa|matmut|maaf|assurance|seguro" },
  { label: "Metro",        match_keyword: "navigo|comutitres|ratp|sncf" },
  { label: "Velib",        match_keyword: "velib|smovengo|fpx sodicma|paris paris" },
  { label: "Therapy",      match_keyword: "therap|psicolog|psy\\b|consult" },
  { label: "Gym",          match_keyword: "neoness|gym|fitness|basic.?fit|on air" },
];

for (const { label, match_keyword } of DEFAULTS) {
  const r = await fetch(`${HOST}/api/match-keyword?key=${encodeURIComponent(DASH_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label, match_keyword }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) console.error(`  ✗ ${label} → ${j.error || r.status}`);
  else                  console.log(`  ✓ ${label.padEnd(15)} /${match_keyword}/  (${j.updated?.length || 0} periods)`);
}
console.log("\n[done] refresh the dashboard to see the new attribution.");
