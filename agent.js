// src/agent.js
// Claude loop — receives message, loads memory, runs tools, returns response

import Anthropic from "@anthropic-ai/sdk";
import {
  saveMessage,
  getRecentMessages,
  createProject,
  listProjects,
  createTask,
  updateTask,
  listTasks,
  getDailySummary,
} from "./memory.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-5";

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el PM Agent personal de Mauricio Varela.

CONTEXTO:
- Mauricio trabaja en Edenred Payment Solutions (EPNA) en RevOps/Sales Ops
- Tiene proyectos activos: ICDB regulatory reporting, Closing Accounts Project, PortPagos (startup B2B payments)
- Vive en París, 7ème arrondissement
- Prefiere respuestas directas, sin fluff
- Habla contigo en español

COMPORTAMIENTO:
- Cuando detectas una tarea o proyecto nuevo, usas tools directamente sin pedir confirmación
- Eres proactivo: si ves un deadline en riesgo, lo mencionas aunque no te pregunten
- Eres conciso — máximo 3-4 líneas salvo que pidan detalles
- Usas bullet points solo cuando hay múltiples items
- Nunca dices "claro que sí" ni "por supuesto" — vas directo al punto

MEMORIA:
- Tienes acceso a historial de conversación y todos los proyectos y tareas guardados
- Cuando el usuario dice "mis proyectos" o "mis tareas", consultas la base de datos primero`;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "create_project",
    description: "Crea un nuevo proyecto en la base de datos",
    input_schema: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Nombre del proyecto" },
        description: { type: "string", description: "Descripción breve" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_projects",
    description: "Lista todos los proyectos activos con su progreso",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "paused", "done"], description: "Filtro de estado" },
      },
    },
  },
  {
    name: "create_task",
    description: "Crea una tarea nueva, opcionalmente vinculada a un proyecto",
    input_schema: {
      type: "object",
      properties: {
        title:       { type: "string", description: "Título de la tarea" },
        description: { type: "string", description: "Detalle de qué hay que hacer" },
        project_id:  { type: "number", description: "ID del proyecto (opcional)" },
        priority:    { type: "string", enum: ["High", "Medium", "Low"] },
        due_date:    { type: "string", description: "Fecha límite en formato YYYY-MM-DD" },
        effort_h:    { type: "number", description: "Esfuerzo estimado en horas" },
        owner:       { type: "string", description: "Quién lo hace (default: Me)" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task_status",
    description: "Actualiza el estado de una tarea",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number", description: "ID de la tarea" },
        status:  { type: "string", enum: ["Todo", "In Progress", "Done", "Blocked"] },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "list_tasks",
    description: "Lista tareas con filtros opcionales",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        status:     { type: "string", enum: ["Todo", "In Progress", "Done", "Blocked"] },
        priority:   { type: "string", enum: ["High", "Medium", "Low"] },
        due_before: { type: "string", description: "Fecha límite en YYYY-MM-DD" },
      },
    },
  },
  {
    name: "get_daily_summary",
    description: "Resumen del día: proyectos activos, tareas vencidas, tareas de esta semana, bloqueadas",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ─── Tool Executor ─────────────────────────────────────────────────────────────

async function executeTool(name, input) {
  console.log(`[tool] ${name}`, JSON.stringify(input));

  switch (name) {
    case "create_project":
      return createProject(input);

    case "list_projects":
      return listProjects(input.status || "active");

    case "create_task":
      return createTask(input);

    case "update_task_status":
      return updateTask(input.task_id, { status: input.status });

    case "list_tasks":
      return listTasks(input);

    case "get_daily_summary":
      return getDailySummary();

    default:
      return { error: `Tool ${name} not implemented yet` };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

export async function runAgent(userMessage) {
  // Save incoming message
  saveMessage("user", userMessage);

  // Load recent conversation history
  const history = getRecentMessages(20);

  // Build messages array for Claude
  const messages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let response;
  let loopCount = 0;
  const MAX_LOOPS = 5; // Safety limit

  // Agentic loop — keeps running until Claude stops calling tools
  while (loopCount < MAX_LOOPS) {
    loopCount++;

    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // If Claude is done (no more tool calls), break
    if (response.stop_reason === "end_turn") break;

    // Process tool calls
    if (response.stop_reason === "tool_use") {
      // Add Claude's response (with tool_use blocks) to messages
      messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls (in parallel for speed)
      const toolResults = await Promise.all(
        response.content
          .filter((block) => block.type === "tool_use")
          .map(async (block) => {
            const result = await executeTool(block.name, block.input);
            return {
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            };
          })
      );

      // Add tool results back into messages
      messages.push({ role: "user", content: toolResults });

      // Continue loop — Claude will process results and either respond or call more tools
      continue;
    }

    break;
  }

  // Extract final text response
  const finalText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Save assistant response to memory
  saveMessage("assistant", finalText);

  return finalText;
}
