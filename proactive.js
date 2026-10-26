// proactive.js
// The "watchman" agent. Runs every 2h between 08:00 and 22:00 Paris.
// Default behaviour: stay silent. Only emits a message when a real
// time-sensitive signal is found (deadline today, calendar conflict, a micro
// ceiling crossed).
//
// No spending signals: transactions only arrive with the monthly statement
// upload (Revolut sends no emails and the IMAP ingestor has never stored a row),
// so "anomalous charge today" / budget-pace alerts ran on an almost-empty month
// and were noise. Spending analysis lives in the monthly close (monthlyClose.js).
//
// Architectural note: this is NOT a tool-loop agent. It receives a precomputed
// snapshot of the DB + a strict-JSON instruction and returns one decision.
// Keeps cost bounded (1 LLM call per scan) and the contract testable.

import { callLLMText } from "./llm.js";
import { listTasks } from "./memory.js";
import { listEvents } from "./calendar.js";
import { getCeilingAlerts, markCeilingAlertsSent, formatCeilingAlerts } from "./ceiling.js";

const SYSTEM_PROMPT = `Eres el watchman proactivo de Mauricio Varela.

REGLA #1: Por defecto, NO interrumpes. Solo mandas un mensaje si hay algo
realmente urgente o sorprendente. El usuario ya recibe briefing diario a las
8:00 y weekly review los domingos — no repitas lo que ya verá ahí.

Razones VÁLIDAS para interrumpir AHORA (no más tarde):
- Una tarea con due_date = hoy que sigue en Todo y son ya las tardes.
- Un evento de calendario en las próximas 2 horas con conflicto evidente.

Razones INVÁLIDAS (no interrumpas):
- Información que el briefing de mañana cubrirá igual.
- Cualquier tema de gasto, presupuesto o finanzas — va en el cierre mensual. NO lo menciones.
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

// ─── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Run one proactive scan. Returns:
 *   { interrupt: boolean, message: string, why: string, snapshot: ... }
 * Caller is responsible for actually broadcasting the message if interrupt=true.
 *
 * Two independent signals are merged: (1) deterministic micro ceiling alerts
 * (computed + deduped in ceiling.js — these fire on their own, even if the LLM
 * call fails) and (2) the fuzzy LLM watchman for tasks/calendar.
 */
export async function runProactiveScan() {
  const snapshot = {
    now_iso:    new Date().toISOString(),
    day_of_week: new Date().toLocaleDateString("en-US", { weekday: "long" }),
    tasks:        buildTaskSnapshot(),
    calendar:     await buildCalendarSnapshot(),
  };

  // (1) Deterministic micro-entreprise ceiling alerts: computed + deduped in
  // ceiling.js, fire even if the LLM call errors. CA de Vandfort + Zentra +
  // Touro suma a un unico techo (es una sola EI). Kept out of the LLM snapshot —
  // the watchman is told finances are not its business.
  let ceilingPart = "";
  let ceilingWhy  = "";
  try {
    const { alerts: ceilingAlerts } = getCeilingAlerts();
    if (ceilingAlerts.length) {
      ceilingPart = formatCeilingAlerts(ceilingAlerts);
      ceilingWhy  = `ceiling:${ceilingAlerts.map((a) => `${a.threshold}/${a.bucket}`).join(",")}`;
      markCeilingAlertsSent(ceilingAlerts);
    }
  } catch (err) {
    console.error("[proactive] ceiling check failed:", err.message);
  }

  // (2) Fuzzy LLM watchman. Failures degrade to silence — ceiling alerts (if
  // any) still go out.
  let llmMessage = "";
  let llmWhy     = "";
  const userPrompt =
    `Snapshot actual (JSON):\n\n${JSON.stringify(snapshot, null, 2)}\n\n` +
    `Decide si interrumpir. Devuelve SOLO el JSON.`;

  try {
    const text = await callLLMText({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    // Strip markdown fences if a provider wraps JSON in ```json blocks.
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const decision = JSON.parse(cleaned);
    if (typeof decision.interrupt !== "boolean") {
      llmWhy = "missing_interrupt_field";
    } else if (decision.interrupt && !decision.message?.trim()) {
      llmWhy = "interrupt_true_but_no_message";
    } else {
      llmMessage = decision.interrupt ? (decision.message || "").trim() : "";
      llmWhy     = decision.why || (decision.interrupt ? "" : "llm_silent");
    }
  } catch (err) {
    console.error("[proactive] LLM scan failed:", err.message);
    llmWhy = `llm_error: ${err.message}`;
  }

  const parts = [ceilingPart, llmMessage].filter(Boolean);
  return {
    interrupt: parts.length > 0,
    message:   parts.join("\n\n"),
    why:       [ceilingWhy, llmWhy].filter(Boolean).join(" | "),
    snapshot,
  };
}
