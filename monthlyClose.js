// monthlyClose.js
// Cierre mensual del CFO. Reemplaza al "CFO Weekly" del domingo: los gastos solo
// llegan con la subida mensual de statements (Revolut no manda emails por
// transacción y el ingestor IMAP nunca ha registrado una sola fila en prod), así
// que todo análisis a mitad de mes miraba un mes casi vacío y daba cifras falsas.
//
// Flujo:
//   1. Cada import determinista registra el rango de fechas que cubre el fichero
//      (statement_coverage). BNP imprime su periodo ("du … au …"); Amex y Revolut
//      no, así que para ellos se usa el min/max de las filas parseadas.
//   2. Tras cada tanda de imports (debounce en server.js), runMonthlyCloseCheck()
//      mira los 2 últimos meses cerrados: si BNP + Amex + Revolut cubren el mes
//      entero y aún no se envió, genera el cierre UNA vez (monthly_reports).
//   3. Día 10: si el mes anterior sigue incompleto, getCloseReminder() dice qué
//      falta por banco — un solo mensaje, en vez de un reporte con datos a medias.
//   4. A demanda: tool `monthly_close` del agente (genera aunque falten datos y
//      lo avisa en la cabecera).

import db, { getActualSpendVsBudget, listCategoryBudgets, spendByMerchant } from "./memory.js";
import { callLLMText } from "./llm.js";
import { getCeilingStatus } from "./ceiling.js";

export const ACCOUNTS = ["bnp", "amex", "revolut"];

db.exec(`
  -- One row per imported statement file: which dates of which account it covers.
  -- exact=1 → printed statement period (BNP); exact=0 → min/max of its rows.
  CREATE TABLE IF NOT EXISTS statement_coverage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account     TEXT NOT NULL,
    from_date   TEXT NOT NULL,
    to_date     TEXT NOT NULL,
    exact       INTEGER NOT NULL DEFAULT 0,
    rows        INTEGER,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account, from_date, to_date)
  );

  -- Generated closes. sent_at set once broadcast (or shown on demand with
  -- complete data), so the automatic check never sends a month twice.
  CREATE TABLE IF NOT EXISTS monthly_reports (
    period       TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    snapshot     TEXT NOT NULL,
    complete     INTEGER NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at      TEXT
  );
`);

// One-time seed for statements imported before coverage tracking existed
// (2026-10-26): per-account, per-month spans of the transactions already in the
// DB. Re-uploading the old files instead is NOT safe — it would bring back the
// reverted Revolut pre-authorizations deleted on 2026-07-31. The same widening
// rules apply below, so a month with no rows for an account (the Amex
// 21-may→20-jun statement that was never uploaded) still shows as a gap.
try {
  if (db.prepare(`SELECT COUNT(*) AS n FROM statement_coverage`).get().n === 0) {
    const rows = db.prepare(`
      SELECT substr(external_id, 1, instr(external_id, ':') - 1) AS account,
             MIN(date) AS from_date, MAX(date) AS to_date, COUNT(*) AS n
      FROM transactions
      WHERE external_id LIKE 'bnp:%' OR external_id LIKE 'amex:%' OR external_id LIKE 'revolut:%'
      GROUP BY account, strftime('%Y-%m', date)
    `).all();
    const ins = db.prepare(`
      INSERT OR IGNORE INTO statement_coverage (account, from_date, to_date, exact, rows) VALUES (?, ?, ?, 0, ?)
    `);
    db.transaction(() => { for (const r of rows) ins.run(r.account, r.from_date, r.to_date, r.n); })();
    if (rows.length) console.log(`[close] seeded statement_coverage from ${rows.length} account-months of existing transactions`);
  }
} catch (err) {
  console.error("[close] coverage seed failed:", err.message);
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ─── Date helpers (pure string math in UTC — no TZ drift) ──────────────────

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthBounds(period) {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, "0")}` };
}

function shiftPeriod(period, n) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Current month as YYYY-MM in Paris time (the cron + the user both live there). */
function parisPeriod() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 7);
}

/** Most recent fully-ended month. */
export function lastClosedPeriod() {
  return shiftPeriod(parisPeriod(), -1);
}

/** Most recent ended month whose statements cover all three banks — the
 *  dashboard opens here: the running month is always partial now that
 *  transactions arrive with the monthly upload. Null if none in the last year. */
export function lastCompletePeriod() {
  let p = lastClosedPeriod();
  for (let i = 0; i < 12; i++, p = shiftPeriod(p, -1)) {
    if (getMonthCompleteness(p).complete) return p;
  }
  return null;
}

export function periodLabel(period) {
  const [y, m] = period.split("-").map(Number);
  return `${MESES[m - 1]} ${y}`;
}

const shortDate = (iso) => `${Number(iso.slice(8, 10))}-${MESES[Number(iso.slice(5, 7)) - 1].slice(0, 3)}`;

// ─── Coverage ───────────────────────────────────────────────────────────────

export function recordCoverage({ account, from, to, exact = false, rows = null }) {
  if (!ACCOUNTS.includes(account)) return;
  if (!DATE_RX.test(from || "") || !DATE_RX.test(to || "") || from > to) return;
  db.prepare(`
    INSERT INTO statement_coverage (account, from_date, to_date, exact, rows)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account, from_date, to_date) DO UPDATE SET
      exact = MAX(statement_coverage.exact, excluded.exact),
      imported_at = datetime('now')
  `).run(account, from, to, exact ? 1 : 0, rows);
}

/** Coverage from the parsed rows themselves — for exports with no printed period.
 *  Pass ALL parsed rows, duplicates included: a re-uploaded file still proves
 *  the account is covered for those dates. */
export function recordCoverageFromRows(account, txs) {
  const dates = (txs || []).map((t) => t.date).filter((d) => DATE_RX.test(d || "")).sort();
  if (!dates.length) return;
  recordCoverage({ account, from: dates[0], to: dates[dates.length - 1], rows: dates.length });
}

// Row-derived ranges are widened before merging: GAP_TOL backwards bridges the
// quiet days between one statement's last purchase and the next one's first
// (Amex cycles close on the 20th, so 07-20 → 07-24 is normal), END_TOL forward
// absorbs a quiet end of month. A whole missing statement is a ~30-day hole,
// far past either tolerance — that's what this must catch.
const GAP_TOL = 10;
const END_TOL = 3;

/** Merged coverage chains for an account, sorted. w* = widened (used to decide
 *  coverage), raw* = real dates (used to tell the user what's missing). */
function coverageChains(account) {
  const ivs = db.prepare(`SELECT from_date, to_date, exact FROM statement_coverage WHERE account = ?`)
    .all(account)
    .map((r) => ({
      wFrom: r.exact ? r.from_date : addDays(r.from_date, -GAP_TOL),
      wTo:   r.exact ? r.to_date   : addDays(r.to_date, END_TOL),
      rawFrom: r.from_date, rawTo: r.to_date,
    }))
    .sort((a, b) => a.wFrom.localeCompare(b.wFrom));
  const chains = [];
  for (const iv of ivs) {
    const last = chains[chains.length - 1];
    if (last && iv.wFrom <= addDays(last.wTo, 1)) {
      if (iv.wTo > last.wTo) last.wTo = iv.wTo;
      if (iv.rawTo > last.rawTo) last.rawTo = iv.rawTo;
    } else {
      chains.push({ ...iv });
    }
  }
  return chains;
}

/** Is `period` fully covered for every account? For an incomplete account,
 *  returns the first uncovered stretch inside the month (real dates). */
export function getMonthCompleteness(period) {
  const { first, last } = monthBounds(period);
  const accounts = {};
  for (const acc of ACCOUNTS) {
    const chains = coverageChains(acc);
    if (chains.some((c) => c.wFrom <= first && c.wTo >= last)) {
      accounts[acc] = { complete: true };
      continue;
    }
    let gapFrom = first;
    let next = null;
    for (const c of chains) {
      if (c.wTo < gapFrom) continue;
      if (c.wFrom > gapFrom) { next = c; break; }
      gapFrom = addDays(c.rawTo, 1);
    }
    if (gapFrom < first) gapFrom = first;
    let gapTo = next ? addDays(next.rawFrom, -1) : last;
    if (gapTo > last) gapTo = last;
    if (gapTo < gapFrom) gapTo = gapFrom;
    accounts[acc] = { complete: false, missing_from: gapFrom, missing_to: gapTo, has_data: chains.length > 0 };
  }
  return { period, complete: ACCOUNTS.every((a) => accounts[a].complete), accounts };
}

function missingLines(completeness) {
  const NAMES = { bnp: "BNP", amex: "Amex", revolut: "Revolut" };
  return ACCOUNTS.filter((a) => !completeness.accounts[a].complete).map((a) => {
    const s = completeness.accounts[a];
    return `- *${NAMES[a]}*: falta del ${shortDate(s.missing_from)} al ${shortDate(s.missing_to)}`;
  });
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

const round = (n) => Math.round((n || 0) * 100) / 100;
const normMerchant = (m) =>
  String(m || "").toLowerCase().replace(/[0-9*#/]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 28);

function categoryTotals(period) {
  const out = {};
  for (const c of (getActualSpendVsBudget(period).byCategoryAttributed || [])) out[c.category] = c.total;
  return out;
}

/** Budget for the period, or — if that month was never planned — the latest
 *  planned month before it, so the close still has a reference. */
function budgetFor(period) {
  const own = listCategoryBudgets(period);
  if (Object.keys(own).length) return { budget_period: period, budgets: own };
  const prev = db.prepare(`SELECT MAX(period) AS p FROM category_budgets WHERE period < ?`).get(period)?.p;
  return prev ? { budget_period: prev, budgets: listCategoryBudgets(prev) } : { budget_period: null, budgets: {} };
}

/** Subscription / recurring-merchant changes: new, stopped, and price rises. */
function recurringChanges(period, priorPeriods) {
  const all = [period, ...priorPeriods];
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date) AS p, merchant, category, ABS(amount) AS amt
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0
      AND strftime('%Y-%m', date) IN (${all.map(() => "?").join(",")})
  `).all(...all);
  const byMerchant = new Map(); // key → { name, category, months: Map(p → total) }
  for (const r of rows) {
    const k = normMerchant(r.merchant);
    if (!k) continue;
    const e = byMerchant.get(k) || { name: r.merchant, category: r.category, months: new Map() };
    e.months.set(r.p, (e.months.get(r.p) || 0) + r.amt);
    byMerchant.set(k, e);
  }
  const newSubs = [], stoppedSubs = [], priceUp = [];
  for (const e of byMerchant.values()) {
    const cur = e.months.get(period) || 0;
    const priorVals = priorPeriods.map((p) => e.months.get(p) || 0);
    const priorHits = priorVals.filter((v) => v > 0).length;
    if (e.category === "subscriptions" && cur > 0 && priorHits === 0) {
      newSubs.push({ merchant: e.name, amount: round(cur) });
    }
    if (e.category === "subscriptions" && cur === 0 && priorHits >= 2) {
      stoppedSubs.push({ merchant: e.name, prior_avg: round(priorVals.reduce((s, v) => s + v, 0) / priorHits) });
    }
    if (cur > 0 && priorHits === priorPeriods.length && priorPeriods.length >= 2) {
      const avg = priorVals.reduce((s, v) => s + v, 0) / priorHits;
      if (cur > avg * 1.15 && cur - avg >= 3) {
        priceUp.push({ merchant: e.name, amount: round(cur), prior_avg: round(avg), category: e.category });
      }
    }
  }
  const byAmount = (a, b) => (b.amount || b.prior_avg) - (a.amount || a.prior_avg);
  return {
    new_subscriptions:     newSubs.sort(byAmount).slice(0, 5),
    stopped_subscriptions: stoppedSubs.sort(byAmount).slice(0, 5),
    recurring_price_up:    priceUp.sort((a, b) => (b.amount - b.prior_avg) - (a.amount - a.prior_avg)).slice(0, 5),
  };
}

/** Deterministic snapshot of one closed month. Every figure in the close comes
 *  from here — the LLM only narrates it. */
export function buildCloseSnapshot(period) {
  const { first, last } = monthBounds(period);
  const priorPeriods = [1, 2, 3].map((n) => shiftPeriod(period, -n));

  const flow = db.prepare(`
    SELECT ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END), 2) AS expenses,
           ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS income
    FROM transactions WHERE date BETWEEN ? AND ? AND is_internal_transfer = 0
  `).get(first, last);
  const income = flow.income || 0, expenses = flow.expenses || 0;

  // Amounts are summed as stored, like the dashboard does — so say how much of
  // the month was NOT in EUR instead of letting it hide in the totals.
  const nonEur = db.prepare(`
    SELECT currency, COUNT(*) AS n, ROUND(SUM(ABS(amount)), 2) AS total
    FROM transactions WHERE date BETWEEN ? AND ? AND is_internal_transfer = 0 AND currency <> 'EUR'
    GROUP BY currency
  `).all(first, last);

  const cur = categoryTotals(period);
  const prior = priorPeriods.map(categoryTotals);
  const { budget_period, budgets } = budgetFor(period);
  const cats = new Set([...Object.keys(cur), ...Object.keys(budgets)]);
  const categories = [...cats].map((category) => {
    const actual = round(cur[category]);
    const avg = round(prior.reduce((s, m) => s + (m[category] || 0), 0) / prior.length);
    const budget = round(budgets[category]);
    return {
      category, actual, budget, avg_3m: avg,
      pct_of_budget: budget > 0 ? Math.round((actual / budget) * 100) : null,
      vs_avg_pct:    avg > 0 ? Math.round(((actual - avg) / avg) * 100) : null,
    };
  }).filter((c) => c.actual > 0 || c.budget > 0).sort((a, b) => b.actual - a.actual);

  const priorExpenses = prior.map((m) => Object.values(m).reduce((s, v) => s + v, 0));
  const largest = db.prepare(`
    SELECT date, merchant, ROUND(ABS(amount), 2) AS amount, category, currency
    FROM transactions
    WHERE date BETWEEN ? AND ? AND amount <= -150 AND is_internal_transfer = 0
    ORDER BY amount ASC LIMIT 5
  `).all(first, last);

  const recon = {};
  for (const r of db.prepare(`SELECT account, reconciled, closing_eur FROM account_balances WHERE period = ?`).all(period)) {
    recon[r.account] = { reconciled: r.reconciled == null ? null : !!r.reconciled, closing_eur: r.closing_eur };
  }

  let ceiling = null;
  try {
    const c = getCeilingStatus();
    ceiling = { year: c.year, ca_ytd: c.totalCA, projected: c.projected,
      thresholds: c.thresholds.map((t) => ({ label: t.label, pct: t.pct })) };
  } catch (err) { console.warn("[close] ceiling status:", err.message); }

  return {
    period,
    totals: {
      income: round(income), expenses: round(expenses), net: round(income - expenses),
      net_pct_of_income: income > 0 ? Math.round(((income - expenses) / income) * 100) : null,
      avg_expenses_3m: round(priorExpenses.reduce((s, v) => s + v, 0) / priorExpenses.length),
    },
    non_eur: nonEur,
    budget_period,
    categories,
    top_merchants: spendByMerchant({ from: first, to: last, limit: 8 }),
    largest_outflows: largest,
    ...recurringChanges(period, priorPeriods),
    reconciliation: recon,
    ceiling,
  };
}

// ─── Text ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el CFO personal de Mauricio Varela y escribes su CIERRE MENSUAL.
Se envía una vez al mes, cuando ya están cargados los statements de BNP, Amex y
Revolut. Los datos del snapshot son el mes completo: analiza, no especules.

CONTEXTO PERMANENTE:
- Vive en París, trabaja en Edenred (RevOps). Salario en BNP.
- Cuentas: BNP (principal), Amex FR (tarjeta), Revolut (viajes + Colombia).
- Ahorra vía PERCO (categoría 'savings') y paga un préstamo en Colombia ('debt').

ESTRUCTURA (siempre, en este orden):
### Resumen
- Máx 2 viñetas: cómo cerró el mes vs la media de 3 meses, con cifras.
### Presupuesto vs real
- Solo categorías fuera de lo normal: >110% del budget o >30% sobre su media de 3 meses (máx 4). Si ninguna: "Todo dentro de lo normal."
### Para revisar
- Suscripciones nuevas / dadas de baja / que subieron de precio y gastos grandes puntuales (máx 4). Si no hay nada, omite la sección entera.
### 3 acciones
- Cada una: qué hacer + € de impacto mensual estimado.

REGLAS:
- Máx 220 palabras. Usa SOLO cifras del snapshot; nunca inventes ni redondees a ojo.
- 'savings' y 'debt' son ahorro y deuda, no gasto discrecional: no propongas recortarlos.
- 'internal_transfer' y 'transfers' no son consumo.
- Si budget_period es distinto de period, el budget es el del último mes planificado: dilo una vez.
- Si no hay budget (budget_period null), compara solo contra la media de 3 meses.
- Formato Telegram: headers "### ", viñetas "- ", cifras clave en **negritas**. Sin tablas ni bloques de código.`;

const eur = (n) => (n < 0 ? "-" : "") + "€" + Math.abs(Math.round(n || 0)).toLocaleString("fr-FR");

function headerLines(snapshot, completeness) {
  const t = snapshot.totals;
  const NAMES = { bnp: "BNP", amex: "Amex", revolut: "Revolut" };
  const data = ACCOUNTS.map((a) => {
    if (!completeness.accounts[a].complete) return `${NAMES[a]} ⚠️`;
    const r = snapshot.reconciliation[a]?.reconciled;
    return r === false ? `${NAMES[a]} ⚠️ no cuadra` : r === true ? `${NAMES[a]} ✅ cuadra` : `${NAMES[a]} ✅`;
  }).join(" · ");
  const lines = [
    `📒 *Cierre de ${periodLabel(snapshot.period)}*`,
    `Ingresos **${eur(t.income)}** · Gastos **${eur(t.expenses)}** · Neto **${eur(t.net)}**` +
      (t.net_pct_of_income != null ? ` (${t.net_pct_of_income}%)` : ""),
    `Datos: ${data}`,
  ];
  if (snapshot.non_eur.length) {
    lines.push(`_Incluye ${snapshot.non_eur.map((c) => `${c.n} mov. en ${c.currency}`).join(", ")} sumados sin convertir._`);
  }
  if (!completeness.complete) {
    lines.push("", "⚠️ *Datos incompletos* — este cierre es provisional:", ...missingLines(completeness));
  }
  return lines.join("\n");
}

/** If the LLM chain is down, still deliver the numbers. */
function fallbackBody(snapshot) {
  const top = snapshot.categories.slice(0, 6).map((c) =>
    `- *${c.category}*: ${eur(c.actual)}` +
    (c.budget ? ` / budget ${eur(c.budget)}` : "") +
    (c.vs_avg_pct != null ? ` (${c.vs_avg_pct >= 0 ? "+" : ""}${c.vs_avg_pct}% vs media 3m)` : ""));
  return `### Categorías\n${top.join("\n")}\n\n_(Análisis del CFO no disponible: fallaron los providers LLM.)_`;
}

/**
 * Build + store the close for `period`. force=false refuses incomplete months
 * (returns null); force=true generates anyway with a provisional warning.
 */
export async function generateMonthlyClose(period, { force = false } = {}) {
  const completeness = getMonthCompleteness(period);
  if (!completeness.complete && !force) return null;
  const snapshot = buildCloseSnapshot(period);

  let body;
  try {
    body = (await callLLMText({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Snapshot del cierre (JSON):\n\n${JSON.stringify(snapshot, null, 2)}\n\nEscribe el cierre siguiendo el formato del system prompt.` },
      ],
      max_tokens: 900,
      temperature: 0.3,
    }) || "").trim();
  } catch (err) {
    console.error("[close] LLM failed:", err.message);
  }
  const text = `${headerLines(snapshot, completeness)}\n\n${body || fallbackBody(snapshot)}`;

  db.prepare(`
    INSERT INTO monthly_reports (period, text, snapshot, complete, generated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(period) DO UPDATE SET
      text = excluded.text, snapshot = excluded.snapshot,
      complete = excluded.complete, generated_at = excluded.generated_at
  `).run(period, text, JSON.stringify(snapshot), completeness.complete ? 1 : 0);

  return { period, text, complete: completeness.complete, snapshot };
}

function markSent(period) {
  db.prepare(`UPDATE monthly_reports SET sent_at = datetime('now') WHERE period = ?`).run(period);
}

function isSent(period) {
  return !!db.prepare(`SELECT sent_at FROM monthly_reports WHERE period = ?`).get(period)?.sent_at;
}

/** On-demand close (agent tool). Generates even with gaps; a complete one
 *  counts as delivered so the automatic check doesn't resend it. */
export async function getMonthlyCloseOnDemand(period) {
  const p = /^\d{4}-\d{2}$/.test(period || "") ? period : lastClosedPeriod();
  if (p >= parisPeriod()) {
    return { markdown: `El mes ${periodLabel(p)} aún no ha terminado — el cierre sale cuando acabe y estén los statements de los tres bancos.` };
  }
  const r = await generateMonthlyClose(p, { force: true });
  if (r.complete) markSent(p);
  return { markdown: r.text };
}

// The check can be triggered by the boot kick, the debounce and the day-10 cron
// at nearly the same time — never let two runs generate the same month.
let running = null;

/**
 * Send the close for each of the last 2 ended months that is now complete and
 * not yet sent. `send` is the broadcaster; it resolves false when no channel
 * delivered, and then the month stays unsent so the next check retries.
 * Returns the periods sent.
 */
export function runMonthlyCloseCheck({ send }) {
  if (running) return running;
  running = (async () => {
    const sent = [];
    const last = lastClosedPeriod();
    for (const p of [shiftPeriod(last, -1), last]) {
      if (isSent(p)) continue;
      const r = await generateMonthlyClose(p);
      if (!r) continue;
      if ((await send(r.text)) === false) {
        console.warn(`[close] ${p} not delivered on any channel — will retry on the next check`);
        continue;
      }
      markSent(p);
      sent.push(p);
    }
    return sent;
  })().finally(() => { running = null; });
  return running;
}

/** Day-10 nudge text, or null when last month is already closed/closable. */
export function getCloseReminder() {
  const p = lastClosedPeriod();
  if (isSent(p)) return null;
  const c = getMonthCompleteness(p);
  if (c.complete) return null;
  return [
    `📒 *Cierre de ${periodLabel(p)} pendiente*`,
    "",
    "Faltan statements para cerrar el mes:",
    ...missingLines(c),
    "",
    "Súbelos y el cierre te llega solo. Si quieres verlo ya con lo que hay, pídeme \"cierre de " +
      MESES[Number(p.slice(5, 7)) - 1] + "\".",
  ].join("\n");
}

/** Dashboard payload: status of the last 6 closed months + one month's snapshot. */
export function getCloseOverview(period) {
  const last = lastClosedPeriod();
  const p = /^\d{4}-\d{2}$/.test(period || "") && period <= last ? period : last;
  const months = [0, 1, 2, 3, 4, 5].map((n) => {
    const m = shiftPeriod(last, -n);
    const rep = db.prepare(`SELECT generated_at, sent_at, complete FROM monthly_reports WHERE period = ?`).get(m);
    return { period: m, ...getMonthCompleteness(m), report: rep || null };
  });
  return { period: p, months, snapshot: buildCloseSnapshot(p) };
}
