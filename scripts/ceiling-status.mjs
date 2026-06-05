#!/usr/bin/env node
// Dry-run del techo micro-entreprise: imprime el CA combinado del ano, el split
// por negocio, el forecast lineal a fin de ano, y que alertas dispararian ahora.
// No manda nada ni marca alertas como enviadas (eso solo lo hace el watchman).
//   Uso:  node scripts/ceiling-status.mjs
import { getCeilingStatus, getCeilingAlerts, formatCeilingAlerts } from "../ceiling.js";

const s = getCeilingStatus();

console.log(`\n=== Techo micro-entreprise — ano ${s.year} ===`);
console.log(`Dia ${s.daysElapsed}/${s.daysInYear} (${s.fractionElapsed}% del ano transcurrido)`);
console.log(`CA combinado: EUR ${s.totalCA}  |  run-rate EUR ${s.perDay}/dia  |  proyeccion fin de ano EUR ${s.projected}`);

console.log(`\nPor negocio:`);
for (const b of s.byBusiness) {
  console.log(`  ${b.name.padEnd(12)} EUR ${String(b.ca).padStart(9)}  (${b.pct_of_total}%)`);
}
if (s.unattributed) {
  console.log(`  ${"sin clasificar".padEnd(12)} EUR ${String(s.unattributed).padStart(9)}  <- revisa keywords en ceiling.config.json`);
  for (const t of s.unattributedTxs) {
    console.log(`      ${(t.merchant || "?")} — EUR ${t.amount} [${t.category || "?"}]`);
  }
}

console.log(`\nUmbrales:`);
for (const t of s.thresholds) {
  console.log(
    `  ${t.label.padEnd(26)} EUR ${String(t.amount).padStart(7)}  ->  ${t.pct}% real, ${t.projectedPct}% proyectado` +
    (t.crossDate ? `, cruce ~${t.crossDate}` : "")
  );
}

const { alerts } = getCeilingAlerts();
console.log(`\nAlertas que dispararian ahora (${alerts.length}):`);
console.log(alerts.length ? "\n" + formatCeilingAlerts(alerts) : "  (ninguna — o ya enviadas este ano)");
console.log("");
