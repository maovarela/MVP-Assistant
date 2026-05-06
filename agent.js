// agent.js
// LLM agent loop using OpenAI Chat Completions API + tool use, with
// provider fallback chain (see llm.js). Works with Gemini, Groq, DeepSeek,
// or any OpenAI-compatible endpoint.

import {
  saveMessage,
  getRecentMessages,
  createProject,
  listProjects,
  createTask,
  updateTask,
  listTasks,
  getDailySummary,
  listTransactions,
  spendByCategory,
  spendByMerchant,
  monthlyTotals,
  getTransactionStats,
} from "./memory.js";
import { fetchAndParseRecent } from "./email.js";
import { CATEGORIES } from "./transactions.js";
import { callLLM } from "./llm.js";

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el PM + finance Agent personal de Mauricio Varela.

CONTEXTO:
- Mauricio trabaja en Edenred Payment Solutions (EPNA) en RevOps/Sales Ops
- Proyectos activos: ICDB regulatory reporting, Closing Accounts Project, PortPagos (startup B2B payments)
- Vive en París, 7ème
- 3 fuentes de gasto: Amex, Revolut, BNP — todas las notificaciones llegan al inbox del agente
- Prefiere respuestas directas, sin fluff
- Habla contigo en español

COMPORTAMIENTO:
- Cuando detectas una tarea o proyecto nuevo, usas tools directamente sin pedir confirmación
- Eres proactivo: si ves un deadline en riesgo o un gasto inusual, lo mencionas aunque no te pregunten
- Eres conciso — máximo 3-4 líneas salvo que pidan detalles
- Usas bullet points solo cuando hay múltiples items
- Nunca dices "claro que sí" ni "por supuesto" — vas directo al punto

MEMORIA:
- Tienes acceso a historial de conversación + proyectos + tareas + transacciones
- Cuando el usuario dice "mis proyectos/tareas/gastos", consulta la DB primero
- Las transacciones tienen amount con signo: negativo = gasto, positivo = ingreso. Para "gastos" usa valor absoluto.
- Categorías de gasto válidas: ${CATEGORIES.join(", ")}
- Para meses pasa el rango YYYY-MM-DD (primer y último día del mes)`;

// ─── Tool Definitions (OpenAI format) ────────────────────────────────────────

const TOOLS = [
  // ── Projects ─────────────────────────────────────────────────────────────
  fn("create_project", "Crea un nuevo proyecto en la base de datos", {
    type: "object",
    properties: {
      name:        { type: "string", description: "Nombre del proyecto" },
      description: { type: "string", description: "Descripción breve" },
    },
    required: ["name"],
  }),
  fn("list_projects", "Lista proyectos con filtro de estado", {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "paused", "done"] },
    },
  }),

  // ── Tasks ────────────────────────────────────────────────────────────────
  fn("create_task", "Crea una tarea (opcionalmente vinculada a proyecto)", {
    type: "object",
    properties: {
      title:       { type: "string" },
      description: { type: "string" },
      project_id:  { type: "number" },
      priority:    { type: "string", enum: ["High", "Medium", "Low"] },
      due_date:    { type: "string", description: "YYYY-MM-DD" },
      effort_h:    { type: "number" },
      owner:       { type: "string", description: "Default: Me" },
    },
    required: ["title"],
  }),
  fn("update_task_status", "Actualiza el estado de una tarea", {
    type: "object",
    properties: {
      task_id: { type: "number" },
      status:  { type: "string", enum: ["Todo", "In Progress", "Done", "Blocked"] },
    },
    required: ["task_id", "status"],
  }),
  fn("list_tasks", "Lista tareas con filtros", {
    type: "object",
    properties: {
      project_id: { type: "number" },
      status:     { type: "string", enum: ["Todo", "In Progress", "Done", "Blocked"] },
      priority:   { type: "string", enum: ["High", "Medium", "Low"] },
      due_before: { type: "string", description: "YYYY-MM-DD" },
    },
  }),
  fn("get_daily_summary", "Resumen: proyectos activos, vencidas, esta semana, bloqueadas", {
    type: "object", properties: {},
  }),

  // ── Finance ──────────────────────────────────────────────────────────────
  fn("list_transactions", "Lista transacciones bancarias filtradas por fecha/categoría/comercio", {
    type: "object",
    properties: {
      from:     { type: "string", description: "YYYY-MM-DD inclusive" },
      to:       { type: "string", description: "YYYY-MM-DD inclusive" },
      category: { type: "string", description: `Una de: ${CATEGORIES.join(", ")}` },
      merchant: { type: "string", description: "Substring del comercio" },
      limit:    { type: "number", description: "Default 100" },
    },
  }),
  fn("spend_by_category", "Total gastado agrupado por categoría (solo outflows)", {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD" },
      to:   { type: "string", description: "YYYY-MM-DD" },
    },
  }),
  fn("spend_by_merchant", "Top comercios por gasto en un rango", {
    type: "object",
    properties: {
      from:  { type: "string" },
      to:    { type: "string" },
      limit: { type: "number", description: "Top N (default 20)" },
    },
  }),
  fn("monthly_totals", "Totales ingresos/gastos/neto por mes (últimos N)", {
    type: "object",
    properties: {
      months: { type: "number", description: "Default 12" },
    },
  }),
  fn("transaction_stats", "Total de transacciones y rango de fechas (cobertura histórica)", {
    type: "object", properties: {},
  }),
  fn("scan_inbox_now", "Fuerza un scan inmediato del inbox para parsear transacciones nuevas", {
    type: "object",
    properties: {
      days_back: { type: "number", description: "Default 1" },
    },
  }),
];

function fn(name, description, parameters) {
  return { type: "function", function: { name, description, parameters } };
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  console.log(`[tool] ${name}`, JSON.stringify(input));
  switch (name) {
    case "create_project":      return createProject(input);
    case "list_projects":       return listProjects(input.status || "active");
    case "create_task":         return createTask(input);
    case "update_task_status":  return updateTask(input.task_id, { status: input.status });
    case "list_tasks":          return listTasks(input);
    case "get_daily_summary":   return getDailySummary();
    case "list_transactions":   return listTransactions(input);
    case "spend_by_category":   return spendByCategory(input);
    case "spend_by_merchant":   return spendByMerchant(input);
    case "monthly_totals":      return monthlyTotals(input);
    case "transaction_stats":   return getTransactionStats();
    case "scan_inbox_now":      return await fetchAndParseRecent({ daysBack: input.days_back || 1 });
    default:                    return { error: `Tool ${name} not implemented` };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

const MAX_LOOPS = 6;

export async function runAgent(userMessage) {
  saveMessage("user", userMessage);

  // Build conversation: system + recent history + new user message
  // (The new message was just saved, so getRecentMessages already includes it)
  const history = getRecentMessages(20);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  let response;
  for (let i = 0; i < MAX_LOOPS; i++) {
    response = await callLLM({
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      max_tokens: 1500,
      temperature: 0.5,
    });

    const choice = response.choices[0];
    const msg = choice.message;

    // No more tool calls → done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const finalText = (msg.content || "").trim();
      saveMessage("assistant", finalText);
      return finalText;
    }

    // Append assistant message (with tool_calls) to conversation
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: msg.tool_calls,
    });

    // Execute each tool call and append result
    for (const tc of msg.tool_calls) {
      const fnName = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await executeTool(fnName, args);
      } catch (err) {
        result = { error: err.message };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result ?? null),
      });
    }
  }

  // Hit loop limit — return whatever the last response had
  const finalText = (response?.choices?.[0]?.message?.content || "Llegué al límite de iteraciones.").trim();
  saveMessage("assistant", finalText);
  return finalText;
}
