// ceiling.js
// Micro-entreprise (EI) ceiling watch. Mauricio opera Vandfort + Zentra + Touro
// bajo UNA sola EI (SIRET 10549166600019), asi que el chiffre d'affaires (CA) de
// los tres SE SUMA en un unico techo. Dos lineas importan, la primera pega antes:
//   - Franchise en base de TVA (~37.5k servicios) -> empiezas a cobrar TVA.
//   - Techo micro-entreprise   (~77.7k servicios) -> 2 anos seguidos = fuera de micro -> sociedad.
// Los montos exactos viven en ceiling.config.json (CONFIRMAR con comptable).
//
// Diseno: igual que getBudgetPaceAlerts en memory.js. Es un alerta DETERMINISTA,
// no un loop de LLM. Calcula el CA del ano civil, lo atribuye por keyword a cada
// negocio, hace forecast lineal a fin de ano, y dispara cuando cruza un nivel.
// El dedup vive en la tabla proactive_ceiling_sent para que el watchman de 2h no
// repita la misma alerta. proactive.js llama getCeilingAlerts() + markCeilingAlertsSent().

import { readFileSync } from "node:fs";
import db from "./memory.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  activityType: "services",
  currency: "EUR",
  thresholds: {
    tva_franchise: { label: "Franchise TVA", amount_eur: 37500 },
    micro_ceiling: { label: "Techo micro-entreprise", amount_eur: 77700 },
  },
  alertLevelsPct: [60, 70, 85, 95, 100],
  skipCategories: ["transfers", "savings", "reimbursement", "refund"],
  personalKeywords: ["salaire", "salary", "virement interne", "remboursement"],
  blindspotWarnPct: 15,
  businesses: [
    { name: "Zentra", keywords: ["zentra", "stripe"] },
    { name: "Touro", keywords: ["touro"] },
    { name: "Vandfort", keywords: ["vandfort"] },
  ],
};

export function loadConfig() {
  try {
    const raw = readFileSync(new URL("./ceiling.config.json", import.meta.url), "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG; // file missing/broken -> sane defaults, never crash the watchman
  }
}

// ─── Dedup ledger ─────────────────────────────────────────────────────────────
// One row per (year, threshold_key, level_tag). level_tag is the pct level for
// actual crossings ("60".."100"), or "forecast" / "blindspot" for those buckets.
db.exec(`
  CREATE TABLE IF NOT EXISTS proactive_ceiling_sent (
    year        TEXT NOT NULL,
    threshold   TEXT NOT NULL,
    level_tag   TEXT NOT NULL,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (year, threshold, level_tag)
  );
`);

// ─── Date helpers (calendar year — micro CA es por ano civil) ─────────────────

function yearBounds(now = new Date()) {
  const y = now.getFullYear();
  const start = `${y}-01-01`;
  const end = `${y}-12-31`;
  const startMs = new Date(`${start}T00:00:00`).getTime();
  const daysInYear = (new Date(y, 11, 31) - new Date(y, 0, 1)) / 86400000 + 1;
  const daysElapsed = Math.max(1, Math.floor((now.getTime() - startMs) / 86400000) + 1);
  return { year: String(y), start, end, daysInYear, daysElapsed };
}

function addDays(date, n) {
  const d = new Date(date.getTime() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

function matchesAny(text, keywords) {
  if (!text) return false;
  const hay = text.toLowerCase();
  return keywords.some((k) => hay.includes(String(k).toLowerCase()));
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Full ceiling snapshot for the current calendar year. Pure read — no dedup, no
 * side effects. Used by getCeilingAlerts(), the CLI, and (future) the dashboard.
 *
 * Returns {
 *   year, start, end, daysElapsed, daysInYear, fractionElapsed,
 *   totalCA, projected, perDay,
 *   byBusiness: [{name, ca, pct_of_total}],
 *   unattributed, unattributedTxs,
 *   thresholds: [{ key, label, amount, pct, projectedPct, crossDate }]
 * }
 */
export function getCeilingStatus({ now = new Date(), config = loadConfig() } = {}) {
  const { year, start, end, daysInYear, daysElapsed } = yearBounds(now);
  const cur = (config.currency || "EUR").toUpperCase();

  // Positive inflows in EUR this year, minus internal/non-CA categories.
  const skip = new Set((config.skipCategories || []).map((c) => c.toLowerCase()));
  const rows = db
    .prepare(
      `SELECT merchant, description, amount, category
         FROM transactions
        WHERE date >= ? AND date <= ? AND amount > 0 AND currency = ?`
    )
    .all(start, end, cur)
    .filter((r) => !skip.has(String(r.category || "").toLowerCase()))
    .filter((r) => !matchesAny(`${r.merchant} ${r.description}`, config.personalKeywords || []));

  const businesses = (config.businesses || []).map((b) => ({ name: b.name, keywords: b.keywords || [], ca: 0 }));
  let unattributed = 0;
  const unattributedTxs = [];

  for (const r of rows) {
    const text = `${r.merchant || ""} ${r.description || ""}`;
    const hit = businesses.find((b) => matchesAny(text, b.keywords));
    if (hit) hit.ca += r.amount;
    else {
      unattributed += r.amount;
      unattributedTxs.push({ merchant: r.merchant, amount: Math.round(r.amount), category: r.category });
    }
  }

  const totalCA = Math.round(businesses.reduce((s, b) => s + b.ca, 0));
  const fractionElapsed = daysElapsed / daysInYear;
  const perDay = totalCA / daysElapsed;
  const projected = Math.round(fractionElapsed > 0 ? totalCA / fractionElapsed : 0);

  const thresholds = Object.entries(config.thresholds || {}).map(([key, t]) => {
    const amount = t.amount_eur;
    const pct = amount > 0 ? Math.round((totalCA / amount) * 1000) / 10 : 0;
    const projectedPct = amount > 0 ? Math.round((projected / amount) * 1000) / 10 : 0;
    let crossDate = null;
    if (perDay > 0 && totalCA < amount) {
      const daysToCross = (amount - totalCA) / perDay;
      crossDate = addDays(now, daysToCross); // may fall after Dec 31 -> "el ano que viene"
    }
    return { key, label: t.label, amount, pct, projectedPct, crossDate };
  });

  return {
    year, start, end, daysElapsed, daysInYear,
    fractionElapsed: Math.round(fractionElapsed * 1000) / 10,
    totalCA, projected, perDay: Math.round(perDay),
    byBusiness: businesses.map((b) => ({
      name: b.name,
      ca: Math.round(b.ca),
      pct_of_total: totalCA > 0 ? Math.round((b.ca / totalCA) * 100) : 0,
    })),
    unattributed: Math.round(unattributed),
    unattributedTxs: unattributedTxs.sort((a, b) => b.amount - a.amount).slice(0, 8),
    thresholds,
  };
}

// ─── Alerts (deduped) ──────────────────────────────────────────────────────────

const alreadySent = (year, threshold, tag) =>
  db.prepare(`SELECT 1 FROM proactive_ceiling_sent WHERE year=? AND threshold=? AND level_tag=?`).get(year, threshold, tag);

/**
 * Returns ceiling alerts NOT yet sent this year. Buckets per threshold:
 *   - actual:    CA real cruzo un nivel (60/70/85/95/100%). Dispara el mas alto nuevo.
 *   - forecast:  el run-rate proyecta cruzar el umbral a fin de ano (aunque hoy no).
 *   - blindspot: hay ingresos sin clasificar materiales -> el CA real podria ser mayor.
 * Caller marca como enviadas con markCeilingAlertsSent().
 */
export function getCeilingAlerts({ now = new Date() } = {}) {
  const config = loadConfig();
  const s = getCeilingStatus({ now, config });
  const levels = (config.alertLevelsPct || [60, 70, 85, 95, 100]).slice().sort((a, b) => a - b);
  const alerts = [];

  for (const t of s.thresholds) {
    // actual: highest level the real CA has crossed and we haven't announced yet.
    const crossed = levels.filter((lv) => s.totalCA >= (t.amount * lv) / 100);
    const top = crossed[crossed.length - 1];
    if (top != null && !alreadySent(s.year, t.key, String(top))) {
      // Mark every lower level sent too (no retro-spam of smaller alerts later).
      const tags = crossed.map(String);
      alerts.push({
        bucket: "actual", year: s.year, threshold: t.key, label: t.label,
        level: top, tagsToMark: tags,
        totalCA: s.totalCA, amount: t.amount, pct: t.pct,
        projected: s.projected, crossDate: t.crossDate,
      });
    } else if (s.projected >= t.amount && s.totalCA < t.amount && !alreadySent(s.year, t.key, "forecast")) {
      // forecast: on pace to cross by year end though not crossed yet.
      alerts.push({
        bucket: "forecast", year: s.year, threshold: t.key, label: t.label,
        tagsToMark: ["forecast"],
        totalCA: s.totalCA, amount: t.amount, pct: t.pct,
        projected: s.projected, projectedPct: t.projectedPct, crossDate: t.crossDate,
      });
    }
  }

  // blindspot: unclassified income big enough to move the needle on the nearest
  // threshold. Under-counting is the dangerous direction for a ceiling, so we
  // surface it. Dedup once per year (re-warns next year).
  const nearest = s.thresholds.reduce((m, t) => (t.amount < m.amount ? t : m), s.thresholds[0] || { amount: Infinity });
  const warnPct = config.blindspotWarnPct ?? 15;
  if (nearest && s.unattributed >= (nearest.amount * warnPct) / 100 && !alreadySent(s.year, "_global", "blindspot")) {
    alerts.push({
      bucket: "blindspot", year: s.year, threshold: "_global", label: nearest.label,
      tagsToMark: ["blindspot"], unattributed: s.unattributed, totalCA: s.totalCA,
      topUnattributed: s.unattributedTxs,
    });
  }

  return { alerts, status: s };
}

export function markCeilingAlertsSent(alerts) {
  if (!alerts?.length) return;
  const stmt = db.prepare(`INSERT OR IGNORE INTO proactive_ceiling_sent (year, threshold, level_tag) VALUES (?, ?, ?)`);
  db.transaction((list) => {
    for (const a of list) for (const tag of a.tagsToMark) stmt.run(a.year, a.threshold, tag);
  })(alerts);
}

// ─── Human-facing text (single * = bold in both Telegram + WhatsApp) ──────────

const eur = (n) => `€${Number(n).toLocaleString("fr-FR")}`;

export function formatCeilingAlerts(alerts) {
  return alerts
    .map((a) => {
      if (a.bucket === "blindspot") {
        const top = (a.topUnattributed || []).slice(0, 3).map((t) => `${t.merchant} ${eur(t.amount)}`).join(", ");
        return (
          `⚠️ *Techo micro: punto ciego* — hay ${eur(a.unattributed)} de ingresos sin clasificar este ano.\n` +
          `El CA real podria estar mas cerca del techo de lo que se ve. Revisa keywords en ceiling.config.json` +
          (top ? ` (ej: ${top}).` : ".")
        );
      }
      const head =
        a.bucket === "actual"
          ? `🔴 *${a.label}: ${a.level}% cruzado*`
          : `🟠 *${a.label}: en camino de cruzar*`;
      const lines = [
        head,
        `CA combinado ${eur(a.totalCA)} / ${eur(a.amount)} (${a.pct}%).`,
        a.bucket === "forecast"
          ? `Proyeccion fin de ano ${eur(a.projected)} (${a.projectedPct}%).`
          : `Proyeccion fin de ano ${eur(a.projected)}.`,
      ];
      if (a.crossDate) lines.push(`Cruce estimado: ${a.crossDate}.`);
      if (a.threshold === "micro_ceiling") lines.push(`Accion: decidir SASU (2 anos sobre el techo = fuera de micro).`);
      if (a.threshold === "tva_franchise") lines.push(`Accion: planear repricing con TVA + facturas validas.`);
      return lines.join("\n");
    })
    .join("\n\n");
}
