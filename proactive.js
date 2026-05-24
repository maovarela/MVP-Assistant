// proactive.js
// The "watchman" agent. Runs every 2h between 08:00 and 22:00 Paris.
// Default behaviour: stay silent. Only emits a message when a real time- or
// money-sensitive signal is found (anomalous charge, deadline today, calendar
// conflict, etc.).
//
// Architectural note: this is NOT a tool-loop agent. It receives a precomputed
// snapshot of the DB + a strict-JSON instruction and returns one decision.
// Keeps cost bounded (1 LLM call per scan) and the contract testable.

import { callLLMText } from "./llm.js";
import db, {
  listTasks,
  listTransactions,
} from "./memory.js";
import { listEvents } from "./calendar.js";

const SYSTEM_PROMPT = `Eres el watchman proactivo de Mauricio Varela.

REGLA #1: Por defecto, NO interrumpes. Solo mandas un mensaje si hay algo
realmente urgente o sorprendente. El usuario ya recibe briefing diario a las
8:00 y weekly review los domingos — no repitas lo que ya verá ahí.

Razones VÁLIDAS para interrumpir AHORA (no más tarde):
- Un cargo bancario sospechoso o inusualmente grande (anomaly).
- Una suscripción nueva detectada (primer cobro de un comercio recurrente).
- Una tarea con due_date = hoy que sigue en Todo y son ya las tardes.
- Un evento de calendario en las próximas 2 horas con conflicto evidente.
- Algo claramente roto (no llegaron emails bancarios en >24h cuando suelen llegar a diario).

Razones INVÁLIDAS (no interrumpas):
- Información que el briefing de mañana cubrirá igual.
- "Estás gastando mucho este mes" sin un dato concreto sorprendente.
- Recordatorios genéricos.

OUTPUT: JSON estricto, una sola línea, sin markdown ni prose fuera del JSON:
{"interrupt": true|false, "message": "...", "why": "..."}

- "message": el texto exacto a mandar al usuario, en español, máx 2 líneas, directo. Vacío si interrupt=false.
- "why": razón técnica corta para los logs (no se muestra al usuario). Siempre obligatoria.

Si dudas, interrupt=false.`;

// ─── Snapshot builders ──────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildTransactionSnapshot() {
  const today = todayISO();
  const last30 = daysAgoISO(30);

  const todays = listTransactions({ from: today, to: today, limit: 50 });
  const last30d = listTransactions({ from: last30, to: today, limit: 1000 });

  const expenseAmts = last30d.filter((t) => t.amount < 0).map((t) => Math.abs(t.amount));
  const med30 = median(expenseAmts);

  // First-time merchants: in last 7 days but not in the prior 90 days.
  const last7Cutoff   = daysAgoISO(7);
  const last90Cutoff  = daysAgoISO(90);
  const recentMerchants = new Set(
    db.prepare(`SELECT DISTINCT merchant FROM transactions WHERE date >= ? AND merchant IS NOT NULL`)
      .all(last7Cutoff).map((r) => r.merchant)
  );
  const priorMerchants = new Set(
    db.prepare(`SELECT DISTINCT merchant FROM transactions WHERE date >= ? AND date < ? AND merchant IS NOT NULL`)
      .all(last90Cutoff, last7Cutoff).map((r) => r.merchant)
  );
  const newMerchants = [...recentMerchants].filter((m) => !priorMerchants.has(m));

  return {
    today_tx_count:        todays.length,
    todays_transactions:   todays.map((t) => ({
      merchant: t.merchant, amount: t.amount, currency: t.currency, category: t.category,
    })),
    median_expense_last_30d: med30,
    new_merchants_last_7d:   newMerchants,
  };
}

function buildTaskSnapshot() {
  const today = todayISO();
  const dueToday = listTasks({ status: "Todo", due_before: today })
    .filter((t) => t.due_date === today);
  const overdue  = listTasks({ status: "Todo", due_before: today })
    .filter((t) => t.due_date && t.due_date < today);
  return {
    due_today_todo: dueToday.map((t) => ({ id: t.id, title: t.title, priority: t.priority, project: t.project_name })),
    overdue_todo:   overdue.map((t)   => ({ id: t.id, title: t.title, priority: t.priority, due: t.due_date, project: t.project_name })),
  };
}

async function buildCalendarSnapshot() {
  // Today + tomorrow, so we can flag back-to-back-with-conflict, early-morning, etc.
  const events = await listEvents({ daysAhead: 1, daysBack: 0 });
  const now = Date.now();
  const next2h = events.filter((e) => {
    const start = new Date(e.start).getTime();
    return start > now && start < now + 2 * 3600_000;
  });
  return {
    next_2h_events: next2h.map((e) => ({ title: e.title, start: e.start, location: e.location })),
    today_event_count: events.filter((e) => new Date(e.start).toDateString() === new Date().toDateString()).length,
  };
}

function buildIngestorHealthSnapshot() {
  const lastTx = db.prepare(`SELECT MAX(created_at) AS last FROM transactions WHERE source='email'`).get();
  const lastTxAt = lastTx?.last ? new Date(lastTx.last).getTime() : 0;
  const hoursSince = lastTxAt ? Math.round((Date.now() - lastTxAt) / 3_600_000) : null;
  return { hours_since_last_bank_email: hoursSince };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Run one proactive scan. Returns:
 *   { interrupt: boolean, message: string, why: string, snapshot: ... }
 * Caller is responsible for actually broadcasting the message if interrupt=true.
 */
export async function runProactiveScan() {
  const snapshot = {
    now_iso:    new Date().toISOString(),
    day_of_week: new Date().toLocaleDateString("en-US", { weekday: "long" }),
    transactions: buildTransactionSnapshot(),
    tasks:        buildTaskSnapshot(),
    calendar:     await buildCalendarSnapshot(),
    ingestor:     buildIngestorHealthSnapshot(),
  };

  const userPrompt =
    `Snapshot actual (JSON):\n\n${JSON.stringify(snapshot, null, 2)}\n\n` +
    `Decide si interrumpir. Devuelve SOLO el JSON.`;

  let text;
  try {
    text = await callLLMText({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
  } catch (err) {
    console.error("[proactive] LLM call failed:", err.message);
    return { interrupt: false, message: "", why: `llm_error: ${err.message}`, snapshot };
  }

  // Strip markdown fences if a provider wraps JSON in ```json blocks.
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  let decision;
  try {
    decision = JSON.parse(cleaned);
  } catch (err) {
    console.error("[proactive] non-JSON output, treating as silent:", cleaned.slice(0, 200));
    return { interrupt: false, message: "", why: "non_json_output", snapshot };
  }

  if (typeof decision.interrupt !== "boolean") {
    return { interrupt: false, message: "", why: "missing_interrupt_field", snapshot };
  }
  if (decision.interrupt && !decision.message?.trim()) {
    return { interrupt: false, message: "", why: "interrupt_true_but_no_message", snapshot };
  }

  return {
    interrupt: decision.interrupt,
    message:   decision.message || "",
    why:       decision.why || "",
    snapshot,
  };
}
