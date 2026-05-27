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
  getSpendPace,
  getLlmStats,
  setFxRate, upsertIncome, upsertFixedExpense, insertVariableExpense, upsertDebt,
  getDashboardSummary,
  setAccountBalance, getAccountCashflow,
} from "./memory.js";
import { fetchAndParseRecent, searchEmails, readEmailByUid } from "./email.js";
import { CATEGORIES } from "./transactions.js";
import { callLLM } from "./llm.js";
import { searchNotion, readNotionPage, queryNotionDatabase } from "./notion.js";
import { listEvents, searchEvents } from "./calendar.js";
import { sendEmail } from "./mailer.js";
import { runAdvisorReview } from "./advisor.js";
import { runAnalyst } from "./analyst.js";

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
- Tienes acceso a historial de conversación + proyectos + tareas + transacciones (SQLite)
- Cuando el usuario dice "mis proyectos/tareas/gastos", consulta la DB primero
- Las transacciones tienen amount con signo: negativo = gasto, positivo = ingreso. Para "gastos" usa valor absoluto.
- Categorías de gasto válidas: ${CATEGORIES.join(", ")}
- Para meses pasa el rango YYYY-MM-DD (primer y último día del mes)

INTEGRACIONES EXTERNAS:
- Notion: tienes acceso a sus páginas y databases compartidas con la integración. Si te preguntan algo que probablemente esté en Notion (planes, viajes, notas, docs), llama a search_notion → read_notion_page.
- Google Calendar: read-only via ICS. Cuando preguntan "cuándo", "qué tengo el día X", "cuándo voy a X" → list_calendar_events o search_calendar.
- Gmail SEND: puedes mandar emails desde mauricio.varela.ai@gmail.com vía send_email. PERO siempre confirma con el usuario antes de mandar correos importantes. No envíes sin confirmación explícita.
- Gmail READ: tienes acceso de lectura al inbox del agente. Para reservas, confirmaciones, recibos, threads forwarded, etc. → search_emails (sintaxis Gmail: 'from:booking.com reserva', 'subject:Barcelona', 'vuelo iberia') y luego read_email con el UID. Notas importantes:
  - El agente solo ve emails en SU inbox (mauricio.varela.ai@gmail.com). Confirmaciones que llegaron al Gmail personal solo aparecen si las forwardeaste.
  - Si una búsqueda por keyword devuelve 0 resultados, search_emails ya hace fallback a "los emails recientes de la ventana" — revisa siempre el resultado completo (subject + snippet) antes de decir "no encontré". Una reserva con subject "Confirmation de réservation : Barcelone - RBP5XC" no matcheará "Barcelona" pero SÍ aparecerá en el fallback.
  - Antes de concluir que algo no existe, prueba al menos: query vacía (lista recientes), variantes de idioma (Barcelona/Barcelone/Barcelone), y sintaxis Gmail (from:varelaperezmauricio para emails que tú forwardeaste).
  - El parseo de transacciones bancarias corre solo en background — NO llames scan_inbox_now salvo que el usuario lo pida explícitamente.

PLANIFICACIÓN FINANCIERA (Cuentas MVP — dashboard v3 desde 2026-05-26):

MODELO MECE POR CATEGORÍA (single source of truth):
- El presupuesto VIVE en \`category_budgets(period, category, budget_eur)\` — **una fila por categoría por mes**. 14 categorías MECE: ${CATEGORIES.join(", ")}.
- \`fixed_expenses\` (Arriendo, Internet, Gym, Metro) son sub-detalle informativo + sus match_keyword sirven para atribuir transacciones al donut/variance correctos.
- \`variable_expenses\` está oculto de la UI (legacy). No agregar variables nuevos.
- IMPORTANTE: el dashboard web tiene un editor in-line por categoría — el usuario edita el budget directamente ahí. Las tools de Telegram (set_fixed_expense, add_variable_expense) siguen funcionando pero son la ruta secundaria.

CATEGORÍAS CRÍTICAS (distinción nueva):
- \`internal_transfer\` (🔄): movimientos BNP↔Amex/Revolut (PRELEVEMENT SEPA AMERICAN EXPRESS, Top-up Revolut). **NO son gasto** — el flag \`is_internal_transfer=1\` los excluye de todos los agregados. NUNCA presentes estos como income o gasto real.
- \`transfers\` (📤): movimientos a TERCEROS reales (Inversion PERCO → en realidad savings, Pago Deuda → en realidad debt, friend transfers tipo Giulia/Iván). Los grandes recurrentes (PERCO, deuda) deberían vivir en \`savings\` / \`debt\` después del fix de 2026-05-26.
- \`savings\`: SWISSLIFE assurance ET / PERCO (plan retraite).
- \`debt\`: Davivienda / Bancolombia / préstamos / amortización.
- \`health\`: HENNER GMC (reembolso mutuelle — arrive como CREDIT positivo, no income), Carlos Antonio Melchor (terapeuta), farmacias.

ESTRUCTURA DE CUENTAS (madre/hijas):
- BNP = cuenta madre. Amex + Revolut = hijas, financiadas vía prélèvement (BNP→Amex) y top-up (BNP→Revolut).
- Los flujos internos están flageados (\`is_internal_transfer=1\`) y EXCLUIDOS del cashflow real. El dashboard tiene una card "Real cashflow" + un panel "Internal transfers" que reconcilia BNP→hijas.
- Si el usuario pregunta "cuánto entró este mes" o "cuánto gasté", el número correcto excluye internos. Las funciones \`spend_by_*\` ya lo hacen.

PENDING ITEMS (off-account ledger, nueva tabla \`pending_items\`):
- 3 kinds: \`receivable\` (gente me debe), \`payable\` (yo debo), \`reimbursement\` (mutuelle/tren/etc pendientes).
- Si el usuario dice "Sebas me debe 350€, me paga en julio" → registralo. Por ahora no hay tool de Telegram para esto (se gestiona desde el dashboard "Pending" panel) — sugiere abrir el dashboard si lo menciona. O pregúntame si quieres que agregue una tool.

LECCIONES IMPORTANTES (no caer en estas trampas):
- HENNER GMC = mutuelle = HEALTH (reembolso), NO income, aunque sea credit positivo.
- SWISSLIFE assurance ET = SAVINGS (PERCO), NO fees.
- PRELEVEMENT AUTOMATIQUE en Amex = internal_transfer (no income).
- Revolut "Top-up by *XXXX" = internal_transfer (no income).
- Naturalia = GROCERIES, no restaurant.
- Si una tx parece income pero viene de BNP/Amex/Revolut internamente, sospecha de internal_transfer.

TOOLS POR ESCENARIO:
- "cómo voy este mes" / "resumen del presupuesto" → get_budget_summary.
- "cuánto he gastado en X" → spend_by_category / spend_by_merchant.
- "dame consejos" / "analiza mis finanzas" / "qué opinas de mi mes" / "revisión financiera" → financial_advisor_review (devuelve markdown formateado — pásaselo tal cual).
- "mi arriendo este mes son 1600€" → set_fixed_expense(label:"Arriendo", budget_eur:1600, category:"housing").
- "el dolar está a 4100" → set_fx_rate.
- "mi salario este mes fueron 3700 netos" → set_income.
- "mi prestamo en Colombia son 9 millones COP" → set_debt (requiere FX seteado).
- Confirma siempre con UNA línea: "✓ Arriendo: €1600 (housing) para 2026-05". No expandas.

DECISIÓN DE TOOLS:
- Si la pregunta es sobre fechas/eventos → calendar primero
- Si es sobre planes, notas, docs → search_notion
- Si es sobre tareas/proyectos guardados → list_tasks/list_projects
- Si es sobre gastos → list_transactions / spend_by_*
- Si menciona un email, reserva, confirmación, vuelo, hotel, recibo recibido por mail → search_emails → read_email
- Cuando combines fuentes, hazlo (ej. "qué tengo en Barcelona": calendar + Notion + emails)`;

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
  fn("spend_pace", "Spending pace del mes actual: gasto hasta hoy, proyección fin de mes, comparación con mismo periodo del mes anterior, y top categorías con deltas. Úsalo en briefings.", {
    type: "object", properties: {},
  }),

  // ── Budget planning (dashboard / Cuentas MVP) ─────────────────────────────
  fn("set_fx_rate", "Setea/actualiza tasas de cambio del mes (sobrescribe manual). usd_cop = pesos por 1 USD. eur_usd = USD por 1 EUR. tax_fr_pct opcional.", {
    type: "object",
    properties: {
      period:     { type: "string", description: "YYYY-MM. Default: mes actual." },
      usd_cop:    { type: "number" },
      eur_usd:    { type: "number" },
      tax_fr_pct: { type: "number" },
    },
    required: ["usd_cop", "eur_usd"],
  }),
  fn("set_income", "Registra un ingreso del mes (salario bruto/neto, note de frais, etc.). UPSERT por (period, label).", {
    type: "object",
    properties: {
      period:     { type: "string", description: "YYYY-MM. Default: mes actual." },
      label:      { type: "string", description: "Ej. 'Salary Neto', 'Note de frais'" },
      amount_eur: { type: "number" },
      amount_src: { type: "number", description: "Monto en moneda original si distinto a EUR" },
      currency:   { type: "string", description: "Default EUR" },
      kind:       { type: "string", enum: ["salary_bruto","salary_neto","other"], description: "Default: other" },
    },
    required: ["label", "amount_eur"],
  }),
  fn("set_fixed_expense", "Registra un gasto fijo planeado del mes (Arriendo, Internet, Gym...). UPSERT por (period, label). 'category' lo enlaza por categoría. 'match_keyword' (opcional regex) restringe la attribution solo a merchants que matcheen — útil cuando varias líneas comparten categoría (ej. Metro+Velib en transport, Gym+Therapy en health) para evitar que una línea absorba el gasto de la otra.", {
    type: "object",
    properties: {
      period:        { type: "string", description: "YYYY-MM. Default: mes actual." },
      label:         { type: "string", description: "Ej. 'Arriendo'" },
      budget_eur:    { type: "number" },
      category:      { type: "string", description: `Categoría para matching con transacciones: ${CATEGORIES.join(", ")}` },
      match_keyword: { type: "string", description: "Opcional. Regex case-insensitive sobre merchant/description. Ej. para Metro: 'navigo|ratp|sncf'. Para Gym: 'neoness|gym|fitness'." },
    },
    required: ["label", "budget_eur"],
  }),
  fn("add_variable_expense", "Añade un gasto variable planeado del mes (Inversion, Comision, etc.). Permite múltiples con mismo label — siempre INSERT, no UPSERT.", {
    type: "object",
    properties: {
      period:     { type: "string" },
      label:      { type: "string" },
      amount_eur: { type: "number" },
      category:   { type: "string" },
    },
    required: ["label", "amount_eur"],
  }),
  fn("set_debt", "Registra una deuda (préstamo COP, balance USD de tarjeta, etc.). UPSERT por (period, label). El monto en EUR se calcula automáticamente desde fx_rates — debe existir un row de FX antes.", {
    type: "object",
    properties: {
      period:     { type: "string" },
      label:      { type: "string", description: "Ej. 'Prestamo COP', 'Amex USD'" },
      amount_src: { type: "number", description: "Monto en moneda original" },
      currency:   { type: "string", enum: ["EUR","USD","COP"] },
      kind:       { type: "string", enum: ["loan","card_balance","other"] },
    },
    required: ["label", "amount_src", "currency"],
  }),
  fn("get_budget_summary", "Resumen completo del mes (igual que el dashboard): ingresos, gastos fijos planeados vs real, gastos variables, deuda, FX, totales, residual, % gastado, top categorías. Úsalo para 'cómo voy este mes'.", {
    type: "object",
    properties: {
      period: { type: "string", description: "YYYY-MM. Default: mes actual." },
    },
  }),
  fn("financial_advisor_review", "Análisis CFO del mes: resumen ejecutivo + alertas + patrones + 3 recomendaciones accionables. Pasa por LLM con prompt de asesor financiero personal. Úsalo cuando el usuario pida 'dame consejos', 'analiza mis finanzas', 'qué opinas de mi mes', 'revisión financiera'. NO lo uses para queries simples como 'cuánto gasté' — para eso usa get_budget_summary o spend_pace.", {
    type: "object",
    properties: {
      period:           { type: "string", description: "YYYY-MM. Default: mes actual." },
      lookback_months:  { type: "number", description: "Cuántos meses pasados para detectar tendencias. Default 6." },
    },
  }),
  fn("analyst_query", "Subagente especializado: Financial Analyst (read-only). Le pasas UNA pregunta libre y él internamente decide qué tools financieros llamar (hasta 5 rondas) y devuelve markdown ya formateado. Úsalo cuando la pregunta requiere MULTIPLES queries o análisis cruzado: 'analiza mi shopping este Q', 'compara abril vs marzo por categoría', 'qué patrón ves en mis transferencias', 'estoy on track para mis ahorros del año', 'por qué subió tanto entertainment'. Pasa la respuesta markdown TAL CUAL al usuario sin re-resumir. NO lo uses para mutaciones (set_*) ni para preguntas simples (cuánto gasté, qué tarea tengo) — para esas usa las tools directas.", {
    type: "object",
    properties: {
      question: { type: "string", description: "La pregunta financiera completa, en el lenguaje del usuario." },
    },
    required: ["question"],
  }),
  fn("set_account_balance", "Setea balance inicial o final de una cuenta (BNP/Amex/Revolut) para un periodo. Útil cuando el usuario dice 'al 1 de mayo tenía 4205 en BNP'. Si no pasas closing, se calcula automáticamente como opening + ingresos - egresos.", {
    type: "object",
    properties: {
      account:     { type: "string", enum: ["bnp", "amex", "revolut"], description: "Cuenta a setear" },
      period:      { type: "string", description: "YYYY-MM" },
      opening_eur: { type: "number", description: "Balance inicial en EUR (opcional)" },
      closing_eur: { type: "number", description: "Balance final en EUR (opcional, se calcula si no se pasa)" },
    },
    required: ["account", "period"],
  }),
  fn("get_account_cashflow", "Cashflow de una cuenta en un periodo: balance inicial + ingresos - egresos = balance final. Úsalo cuando el usuario pregunte 'cómo va mi cuenta BNP este mes', 'cuánto entró y salió'.", {
    type: "object",
    properties: {
      account: { type: "string", enum: ["bnp", "amex", "revolut"], description: "Default bnp" },
      period:  { type: "string", description: "YYYY-MM. Default: mes actual." },
    },
  }),
  fn("scan_inbox_now", "Fuerza un scan inmediato del inbox para parsear transacciones nuevas", {
    type: "object",
    properties: {
      days_back: { type: "number", description: "Default 1" },
    },
  }),

  // ── Email read access (non-bank) ────────────────────────────────────────
  fn("search_emails", "Busca emails en el inbox del agente. Sintaxis Gmail completa: 'from:booking.com', 'subject:reserva', 'iberia vuelo'. Si no encuentra nada con la query, devuelve los emails más recientes de la ventana — siempre revisa el resultado completo (subject + from + snippet) antes de concluir que un email no existe. Cuando busques destinos, prueba variantes de idioma (Barcelona/Barcelone) o usa query vacía.", {
    type: "object",
    properties: {
      query:     { type: "string", description: "Gmail search syntax. Vacío = emails más recientes." },
      days_back: { type: "number", description: "Ventana hacia atrás en días (default 30)" },
      limit:     { type: "number", description: "Máximo de resultados (default 10)" },
    },
  }),
  fn("read_email", "Lee el cuerpo completo de un email. Usa primero search_emails para obtener el UID.", {
    type: "object",
    properties: {
      uid: { type: "number", description: "UID devuelto por search_emails" },
    },
    required: ["uid"],
  }),

  // ── LLM observability ────────────────────────────────────────────────────
  fn("llm_stats", "Reporte de consumo de LLMs en los últimos N días: llamadas, tokens, breakdown por provider y latencia. Útil para responder 'cuánto consumí esta semana'.", {
    type: "object",
    properties: {
      days: { type: "number", description: "Ventana en días (default 7)" },
    },
  }),

  // ── Notion ──────────────────────────────────────────────────────────────
  fn("search_notion", "Busca páginas/databases en el workspace de Notion. Devuelve títulos + IDs para luego leerlos.", {
    type: "object",
    properties: {
      query: { type: "string", description: "Texto a buscar (vacío = top recientes)" },
      limit: { type: "number", description: "Default 10" },
    },
  }),
  fn("read_notion_page", "Lee el contenido completo de una página de Notion: título, propiedades y body en texto plano.", {
    type: "object",
    properties: {
      page_id: { type: "string", description: "ID de la página (UUID con guiones o sin)" },
    },
    required: ["page_id"],
  }),
  fn("query_notion_database", "Lista entradas de un database de Notion. Para filtros complejos usa search_notion + read_notion_page.", {
    type: "object",
    properties: {
      database_id: { type: "string", description: "ID del database (UUID con guiones o sin)" },
      limit:       { type: "number", description: "Default 50" },
    },
    required: ["database_id"],
  }),

  // ── Google Calendar (read-only via ICS feed) ──────────────────────────
  fn("list_calendar_events", "Lista eventos de Google Calendar entre fechas. Default próximos 14 días.", {
    type: "object",
    properties: {
      days_ahead: { type: "number", description: "Días futuros a incluir (default 14)" },
      days_back:  { type: "number", description: "Días pasados a incluir (default 0)" },
    },
  }),
  fn("search_calendar", "Busca eventos por palabra clave en título/descripción/ubicación. Útil para 'cuándo voy a Barcelona'.", {
    type: "object",
    properties: {
      query:      { type: "string", description: "Texto a buscar" },
      days_ahead: { type: "number", description: "Días futuros (default 365)" },
      days_back:  { type: "number", description: "Días pasados (default 30)" },
    },
    required: ["query"],
  }),

  // ── Gmail SEND ────────────────────────────────────────────────────────
  fn("send_email", "Envía un email desde la cuenta del agente vía SMTP. Pide siempre confirmación al usuario antes de mandar correos importantes.", {
    type: "object",
    properties: {
      to:       { type: "string", description: "Destinatario(s), coma-separado" },
      subject:  { type: "string" },
      body:     { type: "string", description: "Cuerpo en texto plano" },
      cc:       { type: "string", description: "CC (opcional)" },
      bcc:      { type: "string", description: "BCC (opcional)" },
      reply_to: { type: "string", description: "Reply-To (opcional)" },
    },
    required: ["to", "subject", "body"],
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
    case "spend_pace":          return getSpendPace();

    case "set_fx_rate":         return setFxRate(input.period, input);
    case "set_income":          return upsertIncome(input);
    case "set_fixed_expense":   return upsertFixedExpense(input);
    case "add_variable_expense":return insertVariableExpense(input);
    case "set_debt":            return upsertDebt(input);
    case "get_budget_summary":  return getDashboardSummary(input.period);
    case "financial_advisor_review":
      return await runAdvisorReview({ period: input.period, lookbackMonths: input.lookback_months });
    case "analyst_query":
      return { markdown: await runAnalyst(input.question) };
    case "set_account_balance":      return setAccountBalance(input);
    case "get_account_cashflow":     return getAccountCashflow({ account: input.account || "bnp", period: input.period });
    case "scan_inbox_now":      return await fetchAndParseRecent({ daysBack: input.days_back || 1 });
    case "search_emails":       return await searchEmails({ query: input.query, daysBack: input.days_back, limit: input.limit });
    case "read_email":          return await readEmailByUid(input.uid);
    case "llm_stats":           return getLlmStats({ days: input.days || 7 });

    case "search_notion":         return await searchNotion(input);
    case "read_notion_page":      return await readNotionPage(input.page_id);
    case "query_notion_database": return await queryNotionDatabase(input);

    case "list_calendar_events":  return await listEvents({ daysAhead: input.days_ahead, daysBack: input.days_back });
    case "search_calendar":       return await searchEvents({ query: input.query, daysAhead: input.days_ahead, daysBack: input.days_back });

    case "send_email":            return await sendEmail({
      to:      input.to,
      subject: input.subject,
      body:    input.body,
      cc:      input.cc,
      bcc:     input.bcc,
      replyTo: input.reply_to,
    });

    default:                    return { error: `Tool ${name} not implemented` };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

const MAX_LOOPS = 6;

export async function runAgent(userMessage, { channel = "telegram" } = {}) {
  saveMessage("user", userMessage, channel);

  // Build conversation: system + recent history + new user message
  // (The new message was just saved, so getRecentMessages already includes it)
  // 10 messages keeps enough conversational context for follow-ups while
  // cutting input tokens roughly in half vs. the previous 20.
  const history = getRecentMessages(10);
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

    const choice = response?.choices?.[0];
    const msg = choice?.message;
    // Belt-and-braces — llm.js already guards this, but if a future provider
    // wrapper bypasses the validation we still want a clean error instead of
    // "Cannot read properties of undefined".
    if (!msg) {
      console.error("[agent] LLM returned no message; aborting loop");
      const fallback = "No pude generar respuesta — los providers LLM están todos fallando. Reintenta en un momento.";
      saveMessage("assistant", fallback, channel);
      return fallback;
    }

    // No more tool calls → done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const finalText = (msg.content || "").trim();
      saveMessage("assistant", finalText, channel);
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
  saveMessage("assistant", finalText, channel);
  return finalText;
}
