// advisor.js
// Financial advisor / CFO module. Two entry points share the same context
// builder + LLM prompt:
//
//   - runAdvisorReview({period, lookbackMonths}) called by the agent tool
//     `financial_advisor_review` for on-demand chat queries.
//   - runWeeklyAdvisorBriefing() called by the Sunday 19:00 Paris cron;
//     prefixes the output with the briefing header and broadcasts it.
//
// Architectural notes:
//   - This is a SINGLE LLM call, not a tool-loop agent. We assemble a
//     deterministic snapshot of the user's finances (budget, actuals,
//     trends, debt, FX) and ask for analysis in one shot. Bounds cost and
//     makes the output reproducible.
//   - Uses the existing llm.callLLM fallback chain — text-only, works on any
//     provider. Smart-model preferred (Sonnet/DeepSeek) for quality but the
//     fallback is fine.

import db, {
  getDashboardSummary, monthlyTotals, listBudgetPeriods,
  spendByCategory, spendByMerchant,
} from "./memory.js";
import { callLLMText } from "./llm.js";

const SYSTEM_PROMPT = `Eres el CFO personal de Mauricio Varela. Actúas como un asesor financiero
senior con experiencia tanto en el sistema fiscal francés (PERCO, PEE, plafond
mensuel, déclaration des impôts) como en el colombiano (DIAN, cuentas en COP,
préstamo bancario). No eres un chatbot genérico — eres su CFO.

CONTEXTO PERMANENTE:
- Vive en París 7ème, trabaja en Edenred (RevOps).
- Tiene un préstamo en Colombia que paga mensualmente.
- Tres cuentas activas: BNP (mother, salario aquí), Amex FR (tarjeta crédito), Revolut (gastos viaje + Colombia).
- Ahorra vía PERCO mensual (~500€).
- Categorías de gasto: groceries, restaurants, transport, travel, subscriptions, shopping, health, housing, entertainment, transfers, income, fees, other.

TU TAREA:
Dado un snapshot del mes actual + tendencia de últimos meses + transacciones top, devuelve un
análisis estructurado en español. Estructura SIEMPRE:

1. **Resumen ejecutivo** (1-2 líneas): cómo va el mes vs anteriores.
2. **Alertas** (max 3, solo si las hay): anomalías concretas con cifras. Ej. "Subscriptions creció 60% vs media de 6 meses (€487 vs €305)".
3. **Patrones detectados** (max 3): observaciones reales con número. NO genérico.
4. **3 recomendaciones accionables**: cada una con qué hacer + cuánto se ahorra/optimiza.

REGLAS:
- Concisión. Máximo 250 palabras totales. Mauricio prefiere directo, sin fluff.
- Cifras siempre con €. Porcentajes vs base. Nunca "moderado" o "considerable" sin número.
- Si todo está bien, dilo: "Sin alertas. Mes en línea con la media." y solo 1-2 recomendaciones de optimización.
- Si hay datos de < 3 meses, dilo y limita análisis comparativo.
- FORMATO (se renderiza en Telegram con jerarquía real):
  · Cada una de las 4 secciones empieza con un header en su propia línea: "### Resumen ejecutivo", "### Alertas", etc.
  · Dentro de cada sección usa viñetas "- " (una idea por línea), no párrafos largos.
  · Resalta cifras y nombres clave con **negritas**.
  · Nada de tablas ni bloques de código. Sin texto de relleno entre secciones.`;

/** Build the deterministic snapshot fed to the LLM. */
function buildSnapshot({ period, lookbackMonths }) {
  const summary  = getDashboardSummary(period);
  const trend    = monthlyTotals({ months: lookbackMonths || 6 });
  const cats     = summary.by_category_actual;
  const merchants = spendByMerchant({
    from: summary.period + "-01",
    to:   summary.period + "-31",
    limit: 10,
  });

  // Trend deltas for top categories (vs avg of preceding months in trend window)
  const priorMonths = trend.filter((m) => m.month < summary.period).slice(0, lookbackMonths - 1 || 5);
  const priorAvg = priorMonths.length
    ? priorMonths.reduce((s, m) => s + (m.expenses || 0), 0) / priorMonths.length
    : null;

  return {
    period:  summary.period,
    today:   new Date().toISOString().slice(0, 10),
    income_this_month: summary.totals.income_eur,
    spent_this_month_planned:  summary.totals.fixed_eur + summary.totals.variable_eur,
    spent_this_month_actual:   summary.totals.actual_eur,
    residual_eur:              summary.totals.residual_eur,
    pct_spent:                 summary.totals.pct_spent,
    debt_total_eur:            summary.totals.debt_total_eur,
    fx: summary.fx,
    fixed_planned_vs_actual: summary.fixed.map((f) => ({
      label: f.label, category: f.category, budget: f.budget_eur, actual: f.actual_eur, pct: f.pct_used,
    })),
    variable_planned: summary.variable.map((v) => ({ label: v.label, amount: v.amount_eur, category: v.category })),
    top_categories_actual: cats.slice(0, 8),
    top_merchants_this_month: merchants,
    trend_last_months: trend.slice(0, lookbackMonths || 6).map((m) => ({
      month: m.month, expenses: m.expenses, income: m.income, net: m.net,
    })),
    prior_months_avg_expense: priorAvg ? Math.round(priorAvg * 100) / 100 : null,
    delta_vs_prior_avg: priorAvg
      ? Math.round((summary.totals.actual_eur - priorAvg) * 100) / 100
      : null,
    available_history_periods: listBudgetPeriods().length,
  };
}

/**
 * Run the advisor review for a given period (default: current month).
 * Returns { snapshot, advice }. Caller decides what to do with the advice.
 */
export async function runAdvisorReview({ period, lookbackMonths = 6 } = {}) {
  const snapshot = buildSnapshot({ period, lookbackMonths });
  const userPrompt =
    `Snapshot financiero (JSON):\n\n${JSON.stringify(snapshot, null, 2)}\n\n` +
    `Devuelve el análisis estructurado siguiendo el formato del system prompt.`;

  let advice;
  try {
    advice = await callLLMText({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 900,
      temperature: 0.4,
    });
  } catch (err) {
    console.error("[advisor] LLM failed:", err.message);
    advice = `⚠️ No pude generar el análisis — fallo en los providers LLM. Reintenta en un momento. (${err.message})`;
  }
  return { snapshot, advice: (advice || "").trim() };
}

/**
 * Sunday weekly briefing entrypoint. Returns the text to broadcast.
 * Same engine as runAdvisorReview, just with a header.
 */
export async function runWeeklyAdvisorBriefing() {
  const { advice } = await runAdvisorReview({ period: undefined, lookbackMonths: 6 });
  return `💼 *CFO Weekly*\n\n${advice}`;
}
