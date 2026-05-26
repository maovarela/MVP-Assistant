#!/usr/bin/env node
// One-shot: delete Uniqlo + Cleopatra variable-expense rows across all periods.
// Run once after deploy; safe to re-run (idempotent — DELETE WHERE label = ?).
//
//   $env:DASH_KEY = "..."
//   node scripts/remove-uniqlo-cleopatra.mjs

const HOST     = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const DASH_KEY = process.env.DASH_KEY;
if (!DASH_KEY) { console.error("ERROR: set DASH_KEY"); process.exit(1); }

const TARGETS = [
  { kind: "variable", label: "Uniqlo" },
  { kind: "variable", label: "Cleopatra" },
];

for (const { kind, label } of TARGETS) {
  const r = await fetch(`${HOST}/api/budget?key=${encodeURIComponent(DASH_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "delete", kind, payload: { label } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) console.error(`  ✗ ${label} → ${j.error || r.status}`);
  else                  console.log(`  ✓ ${label.padEnd(12)} deleted ${j.deleted ?? 0} rows`);
}
console.log("\n[done] refresh the dashboard.");
