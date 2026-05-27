// analyst.js — Financial Analyst subagent (read-only).
//
// A specialized LLM that takes a finance question, runs a tool-loop against
// the budget/transaction DB (read-only, no mutations), and returns markdown.
// The main agent (agent.js) exposes one tool `analyst_query(question)` that
// invokes this. Keeps the main agent's context small and lets the analyst
// have a long, finance-specific prompt without polluting cross-domain queries.

import { callLLM } from "./llm.js";
import {
  getDashboardSummary, getConsolidatedHistory, getRecentMonthsComparison,
  spendByCategory, spendByMerchant, monthlyTotals, getSpendPace,
  listPendingItems, getAccountCashflow, getFxRate,
  listTransactions, listCategoryTransactions, listAllTransactions,
} from "./memory.js";

const ANALYST_SYSTEM_PROMPT = `You are Mauricio's personal Financial Analyst — a CFO who reports to the main PM/finance agent. You receive a single question and must produce a concise, fact-grounded markdown answer.

GROUND TRUTHS (do not improvise around these):

1. **Source-of-truth model is MECE per category** (\`category_budgets\` table).
   - 14 categories: groceries, restaurants, transport, travel, subscriptions, shopping, health, housing, entertainment, transfers, internal_transfer, savings, debt, income, fees, other.
   - One budget number per (category, period). \`fixed_expenses\` are sub-items shown for context, not the source of truth.

2. **Account hierarchy**: BNP = parent, Amex + Revolut = children, funded via prélèvement (BNP→Amex) and top-ups (BNP→Revolut).
   - \`is_internal_transfer = 1\` flags BNP↔children movements. These are NOT real spending or income.
   - Category \`internal_transfer\` (🔄) holds these. Category \`transfers\` (📤) is for REAL third-party movements only.
   - All spend aggregates already exclude \`is_internal_transfer=1\`. \`get_account_cashflow\` returns external vs internal split.

3. **Tricky merchants (already auto-classified, don't re-suggest):**
   - HENNER GMC = mutuelle reimbursement = HEALTH (positive credit, NOT income).
   - SWISSLIFE assurance ET / PERCO = SAVINGS (NOT fees).
   - PRELEVEMENT AUTOMATIQUE on Amex = internal_transfer (NOT income).
   - Revolut "Top-up by *XXXX" = internal_transfer (NOT income).
   - Carlos Antonio Melchor = HEALTH (therapist).
   - Naturalia = GROCERIES (not restaurant).

4. **Pending items** (\`pending_items\`): off-account ledger.
   - kind: receivable (owed to me), payable (I owe), reimbursement (mutuelle / refund pending).
   - Net pending = receivable + reimbursement − payable.

5. **FX**: EUR is base. USD and COP debts converted using \`fx_rates(period)\`.

OUTPUT STYLE:
- Markdown, concise (≤ 300 words unless asked otherwise).
- Lead with the answer. Use **bold** for the headline number/insight.
- Bullet lists for ≥3 items. Tables only if comparing periods or accounts.
- If you flag a problem, propose ONE concrete action.
- NEVER fabricate numbers — call tools to get every value you cite.
- Do NOT explain the tools you used. Just the answer.
- Spanish or English per the question's language.

TOOL DISCIPLINE:
- Up to 5 tool calls per question. Don't loop unnecessarily.
- Start broad (\`get_dashboard_summary\` for "how am I doing this month") then drill down.
- For comparisons across months, prefer \`compare_periods\` or \`get_consolidated_history\` over many single-period calls.
- For "why is X high?" → \`query_transactions\` with merchant_regex.

If a question is outside finance scope (tasks, calendar, projects, Notion, email), respond: "Out of scope — ask the main agent." Do not hallucinate non-financial info.`;

// ─── Tools (read-only, finance-specific) ─────────────────────────────────────

const fn = (name, description, parameters) => ({
  type: "function",
  function: { name, description, parameters },
});

const TOOLS = [
  fn("get_dashboard_summary", "Full month snapshot: income, totals, category_rows (budget+actual+pct per category), top byCategoryActual, debts, FX, spend_pace. Use as first call for 'how am I doing this month'.", {
    type: "object",
    properties: { period: { type: "string", description: "YYYY-MM, defaults to current month" } },
  }),
  fn("compare_periods", "Compare last N months side-by-side (categories + totals + deltas). Use for 'qué cambió' / 'compara con marzo' / trend questions.", {
    type: "object",
    properties: { months: { type: "number", description: "How many months back (default 3, max 12)" } },
  }),
  fn("get_consolidated_history", "Month × account matrix of credits/debits/net over the last N months. Use for cashflow over time per account.", {
    type: "object",
    properties: { months: { type: "number", description: "default 12" } },
  }),
  fn("spend_by_category", "Aggregated spend per category over a date range. Excludes internal transfers.", {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD" },
      to:   { type: "string", description: "YYYY-MM-DD" },
    },
  }),
  fn("spend_by_merchant", "Top merchants by spend over a date range.", {
    type: "object",
    properties: {
      from:  { type: "string" },
      to:    { type: "string" },
      limit: { type: "number", description: "default 20" },
    },
  }),
  fn("monthly_totals", "Total spend/income per month for the last N months. Use for trend lines.", {
    type: "object",
    properties: { months: { type: "number", description: "default 12" } },
  }),
  fn("spend_pace", "Current month MTD vs prior-month-same-window with projection to end of month. Use for 'voy gastando más o menos que el mes pasado'.", {
    type: "object", properties: {},
  }),
  fn("get_account_cashflow", "Per-account flows for a period with internal vs external split. Use to understand BNP→child transfers.", {
    type: "object",
    properties: {
      account: { type: "string", enum: ["bnp","amex","revolut"], description: "default bnp" },
      period:  { type: "string", description: "YYYY-MM, defaults to current month" },
    },
  }),
  fn("query_transactions", "Search transactions by merchant/description substring, with optional date range, account, and min amount. Use for 'qué pasó con X' / 'cuándo gasté tanto en Y'.", {
    type: "object",
    properties: {
      search:       { type: "string", description: "substring matched against merchant + description (case-insensitive)" },
      period:       { type: "string", description: "YYYY-MM or YYYY" },
      period_from:  { type: "string", description: "YYYY-MM lower bound" },
      period_to:    { type: "string", description: "YYYY-MM upper bound" },
      accounts:     { type: "array", items: { type: "string", enum: ["bnp","amex","revolut"] }, description: "filter by account(s)" },
      limit:        { type: "number", description: "default 100, max 500" },
    },
  }),
  fn("get_pending_items", "Off-account ledger: receivables / payables / reimbursements with totals (net = recv + reimb − payable).", {
    type: "object",
    properties: { include_settled: { type: "boolean", description: "default false" } },
  }),
  fn("get_fx_rate", "Get the FX rates (usd_cop, eur_usd, tax_fr_pct) for a period.", {
    type: "object",
    properties: { period: { type: "string", description: "YYYY-MM" } },
  }),
  fn("get_category_transactions", "All transactions for a specific category in a period (or all-time). Use for category drilldown.", {
    type: "object",
    properties: {
      category: { type: "string" },
      period:   { type: "string", description: "YYYY-MM, YYYY, or omit for all-time" },
    },
    required: ["category"],
  }),
];

// ─── Tool executor ───────────────────────────────────────────────────────────

function executeAnalystTool(name, input = {}) {
  switch (name) {
    case "get_dashboard_summary":
      return getDashboardSummary(input.period);
    case "compare_periods":
      return getRecentMonthsComparison({ months: Math.min(input.months || 3, 12) });
    case "get_consolidated_history":
      return getConsolidatedHistory({ months: input.months || 12 });
    case "spend_by_category":
      return spendByCategory({ from: input.from, to: input.to });
    case "spend_by_merchant":
      return spendByMerchant({ from: input.from, to: input.to, limit: input.limit });
    case "monthly_totals":
      return monthlyTotals({ months: input.months || 12 });
    case "spend_pace":
      return getSpendPace();
    case "get_account_cashflow":
      return getAccountCashflow({ account: input.account || "bnp", period: input.period });
    case "query_transactions":
      return listAllTransactions({
        period:      input.period,
        period_from: input.period_from,
        period_to:   input.period_to,
        accounts:    input.accounts,
        search:      input.search,
        limit:       Math.min(input.limit || 100, 500),
      });
    case "get_pending_items":
      return listPendingItems({ include_settled: !!input.include_settled });
    case "get_fx_rate":
      return getFxRate(input.period);
    case "get_category_transactions":
      return listCategoryTransactions({ category: input.category, period: input.period });
    default:
      throw new Error(`Unknown analyst tool: ${name}`);
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the analyst on a single question. Tool-loop, max 5 rounds.
 * Returns markdown string.
 */
export async function runAnalyst(question) {
  if (!question || typeof question !== "string") {
    throw new Error("question (string) required");
  }
  const messages = [
    { role: "system", content: ANALYST_SYSTEM_PROMPT },
    { role: "user",   content: question },
  ];
  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await callLLM({ messages, tools: TOOLS });
    const choice = resp?.choices?.[0];
    if (!choice) throw new Error("analyst LLM returned no choice");
    const msg = choice.message;
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let result;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          result = executeAnalystTool(tc.function.name, args);
        } catch (err) {
          result = { error: err.message };
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }
    // No more tool calls — final answer
    return msg.content || "(empty)";
  }
  // Force a final answer if we hit max rounds
  messages.push({ role: "user", content: "You've used max tool calls. Give me your best answer now in markdown, citing only the numbers you've already retrieved." });
  const final = await callLLM({ messages });
  return final?.choices?.[0]?.message?.content || "(analyst exhausted tool budget without a final answer)";
}
