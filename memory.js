// src/memory.js
// SQLite memory layer — projects, tasks, conversation history

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || "./data/pm.db";

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    channel     TEXT NOT NULL DEFAULT 'telegram',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'done')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER REFERENCES projects(id),
    title       TEXT NOT NULL,
    description TEXT,
    priority    TEXT NOT NULL DEFAULT 'Medium' CHECK(priority IN ('High', 'Medium', 'Low')),
    status      TEXT NOT NULL DEFAULT 'Todo' CHECK(status IN ('Todo', 'In Progress', 'Done', 'Blocked')),
    owner       TEXT DEFAULT 'Me',
    due_date    TEXT,
    effort_h    REAL,
    notion_id   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project   ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_messages_role   ON messages(role);

  -- Transactions: bank transactions ingested from emails / CSV / PDF / manual
  -- amount is signed: negative = outflow (gasto), positive = inflow (ingreso)
  -- external_id is unique per source: gmail message ID, bank's tx ID, or hash for manual
  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id  TEXT UNIQUE,
    source       TEXT NOT NULL CHECK(source IN ('email', 'csv', 'pdf', 'manual')),
    date         TEXT NOT NULL,
    merchant     TEXT,
    amount       REAL NOT NULL,
    currency     TEXT NOT NULL DEFAULT 'EUR',
    category     TEXT,
    description  TEXT,
    raw          TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tx_date     ON transactions(date);
  CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);
  CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant);

  -- Tracks Gmail message IDs we've already processed (avoid double-parsing)
  CREATE TABLE IF NOT EXISTS processed_emails (
    message_id   TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Per-call observability for the LLM provider chain.
  -- One row per HTTP attempt (success or failure), so we can see who
  -- actually does the work, who's rate-limited, and total tokens spent.
  CREATE TABLE IF NOT EXISTS llm_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    total_tokens      INTEGER,
    latency_ms        INTEGER,
    success           INTEGER NOT NULL DEFAULT 1,
    error             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_llm_calls_created  ON llm_calls(created_at);
  CREATE INDEX IF NOT EXISTS idx_llm_calls_provider ON llm_calls(provider);

  -- ─── Budget tables ────────────────────────────────────────────────────────
  -- All keyed by period (YYYY-MM string) so each month is an independent
  -- snapshot — matches the user's monthly "Cuentas MVP" Sheet model.

  CREATE TABLE IF NOT EXISTS incomes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    period     TEXT NOT NULL,
    label      TEXT NOT NULL,
    amount_eur REAL NOT NULL,
    amount_src REAL,
    currency   TEXT NOT NULL DEFAULT 'EUR',
    kind       TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('salary_bruto','salary_neto','other')),
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period, label)
  );

  CREATE TABLE IF NOT EXISTS fixed_expenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    period     TEXT NOT NULL,
    label      TEXT NOT NULL,
    budget_eur REAL NOT NULL,
    category   TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period, label)
  );

  CREATE TABLE IF NOT EXISTS variable_expenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    period     TEXT NOT NULL,
    label      TEXT NOT NULL,
    amount_eur REAL NOT NULL,
    category   TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS debts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    period     TEXT NOT NULL,
    label      TEXT NOT NULL,
    amount_src REAL NOT NULL,
    currency   TEXT NOT NULL,
    amount_eur REAL NOT NULL,
    kind       TEXT CHECK(kind IN ('loan','card_balance','other')),
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period, label)
  );

  CREATE TABLE IF NOT EXISTS fx_rates (
    period     TEXT PRIMARY KEY,
    usd_cop    REAL NOT NULL,
    eur_usd    REAL NOT NULL,
    tax_fr_pct REAL NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_incomes_period           ON incomes(period);
  CREATE INDEX IF NOT EXISTS idx_fixed_expenses_period    ON fixed_expenses(period);
  CREATE INDEX IF NOT EXISTS idx_variable_expenses_period ON variable_expenses(period);
  CREATE INDEX IF NOT EXISTS idx_debts_period             ON debts(period);
`);

// Migration: add channel column for existing DBs that predate multi-channel
// support. ADD COLUMN is idempotent only if the column doesn't exist; pragma
// check first to avoid a noisy error on every boot.
const messageCols = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
if (!messageCols.includes("channel")) {
  db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'`);
}

// Account balances — opening / closing per (account, period). Used by the
// cashflow view so we can show real balances instead of just net changes.
// account = 'bnp' | 'amex' | 'revolut' | future banks. Sourced manually for
// now (user enters once); future work can auto-extract from BNP PDFs.
db.exec(`
  CREATE TABLE IF NOT EXISTS account_balances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account       TEXT NOT NULL,
    period        TEXT NOT NULL,
    opening_eur   REAL,
    closing_eur   REAL,
    source        TEXT NOT NULL DEFAULT 'manual',
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account, period)
  );
`);

// Migration: match_keyword on variable_expenses. Same semantics as the one
// on fixed_expenses — keyword regex (case-insensitive) on merchant or
// description; if it matches, the transaction is attributed to this variable
// line. Lets planned variables (Inversion PERCO, Pago Deuda, Medicina) capture
// their actual transactions across categories.
const varCols = db.prepare(`PRAGMA table_info(variable_expenses)`).all().map((c) => c.name);
if (!varCols.includes("match_keyword")) {
  db.exec(`ALTER TABLE variable_expenses ADD COLUMN match_keyword TEXT`);
}

// Migration: is_internal_transfer flag on transactions. Used to mark Amex bill
// payments and Revolut top-ups that ARE real outflows from the source account
// (BNP) but should NOT count as spending (the underlying purchases are already
// in the Amex/Revolut line items). Cashflow queries include these; spending
// queries filter them out.
const txCols = db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name);
if (!txCols.includes("is_internal_transfer")) {
  db.exec(`ALTER TABLE transactions ADD COLUMN is_internal_transfer INTEGER NOT NULL DEFAULT 0`);
}

// Migration: match_keyword on fixed_expenses. Without it, multiple budget
// lines sharing a category split the actuals proportionally — which leads to
// surprises like "Metro at 199% €119 of €60" when €119 was actually Uber +
// Cabify + Vélib + foreign metros. With a keyword (regex on merchant or
// description), the budget line only counts the transactions it explicitly
// claims; the rest goes to "(sin matchear)" rows per category.
const fixedCols = db.prepare(`PRAGMA table_info(fixed_expenses)`).all().map((c) => c.name);
if (!fixedCols.includes("match_keyword")) {
  db.exec(`ALTER TABLE fixed_expenses ADD COLUMN match_keyword TEXT`);
}

// ─── Messages (conversation history) ─────────────────────────────────────────

export function saveMessage(role, content, channel = "telegram") {
  db.prepare(`
    INSERT INTO messages (role, content, channel) VALUES (?, ?, ?)
  `).run(role, content, channel);
}

// Returns last N messages formatted for Claude API
export function getRecentMessages(limit = 20) {
  return db.prepare(`
    SELECT role, content FROM messages
    ORDER BY id DESC LIMIT ?
  `).all(limit).reverse();
}

export function clearHistory() {
  db.prepare(`DELETE FROM messages`).run();
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function createProject({ name, description }) {
  const result = db.prepare(`
    INSERT INTO projects (name, description) VALUES (?, ?)
  `).run(name, description || null);
  return getProject(result.lastInsertRowid);
}

export function getProject(id) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
}

export function listProjects(status = "active") {
  return db.prepare(`
    SELECT p.*,
      COUNT(t.id) as total_tasks,
      SUM(CASE WHEN t.status = 'Done' THEN 1 ELSE 0 END) as done_tasks
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    WHERE p.status = ?
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all(status);
}

export function updateProject(id, fields) {
  const allowed = ["name", "description", "status"];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = @${k}`)
    .join(", ");
  if (!updates) return;
  db.prepare(`
    UPDATE projects SET ${updates}, updated_at = datetime('now') WHERE id = @id
  `).run({ ...fields, id });
  return getProject(id);
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export function createTask({ project_id, title, description, priority, status, owner, due_date, effort_h, notion_id }) {
  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, description, priority, status, owner, due_date, effort_h, notion_id)
    VALUES (@project_id, @title, @description, @priority, @status, @owner, @due_date, @effort_h, @notion_id)
  `).run({
    project_id: project_id || null,
    title,
    description: description || null,
    priority: priority || "Medium",
    status: status || "Todo",
    owner: owner || "Me",
    due_date: due_date || null,
    effort_h: effort_h || null,
    notion_id: notion_id || null,
  });
  return getTask(result.lastInsertRowid);
}

export function getTask(id) {
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?
  `).get(id);
}

export function listTasks({ project_id, status, priority, due_before } = {}) {
  let query = `
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE 1=1
  `;
  const params = [];

  if (project_id) { query += ` AND t.project_id = ?`; params.push(project_id); }
  if (status)     { query += ` AND t.status = ?`;     params.push(status); }
  if (priority)   { query += ` AND t.priority = ?`;   params.push(priority); }
  if (due_before) { query += ` AND t.due_date <= ?`;  params.push(due_before); }

  query += ` ORDER BY 
    CASE t.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
    t.due_date ASC NULLS LAST`;

  return db.prepare(query).all(...params);
}

export function updateTask(id, fields) {
  const allowed = ["title", "description", "priority", "status", "owner", "due_date", "effort_h", "notion_id", "project_id"];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = @${k}`)
    .join(", ");
  if (!updates) return;
  db.prepare(`
    UPDATE tasks SET ${updates}, updated_at = datetime('now') WHERE id = @id
  `).run({ ...fields, id });
  return getTask(id);
}

// Returns tasks due in the next N days — used by scheduler
export function getTasksDueSoon(days = 2) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  return db.prepare(`
    SELECT t.*, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.due_date <= ?
      AND t.status NOT IN ('Done')
    ORDER BY t.due_date ASC
  `).all(cutoffStr);
}

// Summary used for daily briefing
export function getDailySummary() {
  const today = new Date().toISOString().split("T")[0];
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const in7Str = in7.toISOString().split("T")[0];

  return {
    active_projects: listProjects("active"),
    overdue: db.prepare(`
      SELECT t.*, p.name as project_name FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.due_date < ? AND t.status NOT IN ('Done')
    `).all(today),
    due_this_week: db.prepare(`
      SELECT t.*, p.name as project_name FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.due_date BETWEEN ? AND ? AND t.status NOT IN ('Done')
    `).all(today, in7Str),
    in_progress: listTasks({ status: "In Progress" }),
    blocked: listTasks({ status: "Blocked" }),
  };
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Insert a transaction. Returns null if external_id already exists (dedup).
 * tx fields: { external_id, source, date, merchant, amount, currency, category,
 *             description, raw, is_internal_transfer? }
 * is_internal_transfer = 1 for transfers between the user's own tracked
 * accounts (Amex bill pmt from BNP, Revolut top-up from BNP, etc.). These
 * count in cashflow but are excluded from spending queries.
 */
export function insertTransaction(tx) {
  try {
    const result = db.prepare(`
      INSERT INTO transactions
        (external_id, source, date, merchant, amount, currency, category, description, raw, is_internal_transfer)
      VALUES
        (@external_id, @source, @date, @merchant, @amount, @currency, @category, @description, @raw, @is_internal_transfer)
    `).run({
      external_id: tx.external_id || null,
      source:      tx.source,
      date:        tx.date,
      merchant:    tx.merchant || null,
      amount:      tx.amount,
      currency:    tx.currency || "EUR",
      category:    tx.category || null,
      description: tx.description || null,
      raw:         tx.raw || null,
      is_internal_transfer: tx.is_internal_transfer ? 1 : 0,
    });
    return result.lastInsertRowid;
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") return null; // already imported
    throw err;
  }
}

export function listTransactions({ from, to, category, merchant, limit = 100 } = {}) {
  let query = `SELECT * FROM transactions WHERE 1=1`;
  const params = [];
  if (from)     { query += ` AND date >= ?`;            params.push(from); }
  if (to)       { query += ` AND date <= ?`;            params.push(to); }
  if (category) { query += ` AND category = ?`;         params.push(category); }
  if (merchant) { query += ` AND merchant LIKE ?`;      params.push(`%${merchant}%`); }
  query += ` ORDER BY date DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(query).all(...params);
}

/** Spend summary by category for a date range. Outflows (amount<0) only.
 *  is_internal_transfer rows (Amex bill payments, Revolut top-ups) excluded
 *  so they don't double-count against per-merchant spending. */
export function spendByCategory({ from, to } = {}) {
  let query = `
    SELECT
      COALESCE(category, 'uncategorised') AS category,
      ROUND(SUM(ABS(amount)), 2)          AS total,
      COUNT(*)                            AS count
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0
  `;
  const params = [];
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to)   { query += ` AND date <= ?`; params.push(to); }
  query += ` GROUP BY category ORDER BY total DESC`;
  return db.prepare(query).all(...params);
}

/** Spend summary by merchant for a date range. */
export function spendByMerchant({ from, to, limit = 20 } = {}) {
  let query = `
    SELECT
      COALESCE(merchant, 'unknown')   AS merchant,
      ROUND(SUM(ABS(amount)), 2)      AS total,
      COUNT(*)                        AS count
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0
  `;
  const params = [];
  if (from) { query += ` AND date >= ?`; params.push(from); }
  if (to)   { query += ` AND date <= ?`; params.push(to); }
  query += ` GROUP BY merchant ORDER BY total DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(query).all(...params);
}

/** Monthly net flow (income - expenses). */
export function monthlyTotals({ months = 12 } = {}) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m', date)                                       AS month,
      ROUND(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 2) AS expenses,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount       ELSE 0 END), 2) AS income,
      ROUND(SUM(amount), 2)                                          AS net
    FROM transactions
    GROUP BY month
    ORDER BY month DESC
    LIMIT ?
  `).all(months);
}

/**
 * Spending pace + category deltas for the daily briefing.
 *
 * Returns:
 *   {
 *     today, days_elapsed, days_in_month,
 *     current_month: { from, to, expenses, income },
 *     prior_month_same_window: { from, to, expenses },
 *     prior_month_full:        { from, to, expenses },
 *     projected_month_end_expenses,
 *     pace_delta_pct,            // vs prior month same-day-count
 *     categories: [
 *       { category, current, prior, delta_pct }, ...
 *     ]
 *   }
 *
 * "Pace" projection = current_expenses * (days_in_month / days_elapsed).
 * Naive — assumes spending is roughly uniform over the month. Good enough
 * signal for "am I on track or blowing past last month?".
 */
export function getSpendPace() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = now.getMonth(); // 0-indexed
  const today = now.toISOString().slice(0, 10);
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  const fmt = (d) => d.toISOString().slice(0, 10);
  const monthStart = fmt(new Date(y, m, 1));
  const priorStart = fmt(new Date(y, m - 1, 1));
  const priorEndFull       = fmt(new Date(y, m, 0));                // last day of prior month
  const priorEndSameWindow = fmt(new Date(y, m - 1, Math.min(daysElapsed, new Date(y, m, 0).getDate())));

  const flow = (from, to) => db.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END), 2) AS expenses,
      ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS income
    FROM transactions WHERE date BETWEEN ? AND ? AND is_internal_transfer = 0
  `).get(from, to);

  const current   = flow(monthStart, today);
  const priorSame = flow(priorStart, priorEndSameWindow);
  const priorFull = flow(priorStart, priorEndFull);

  const curExp = current.expenses   || 0;
  const psExp  = priorSame.expenses || 0;
  const pfExp  = priorFull.expenses || 0;

  const projected = daysElapsed > 0 ? Math.round((curExp * daysInMonth / daysElapsed) * 100) / 100 : 0;
  const paceDelta = psExp > 0 ? Math.round(((curExp - psExp) / psExp) * 1000) / 10 : null;

  // Categories: this month so far vs same window prior month, merged.
  const curCats   = spendByCategory({ from: monthStart, to: today });
  const priorCats = spendByCategory({ from: priorStart, to: priorEndSameWindow });
  const priorMap  = new Map(priorCats.map((r) => [r.category, r.total]));

  const categories = curCats.map((c) => {
    const prior = priorMap.get(c.category) || 0;
    const delta = prior > 0 ? Math.round(((c.total - prior) / prior) * 1000) / 10 : null;
    return { category: c.category, current: c.total, prior, delta_pct: delta };
  });

  return {
    today,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    current_month:           { from: monthStart, to: today,             expenses: curExp, income: current.income || 0 },
    prior_month_same_window: { from: priorStart, to: priorEndSameWindow, expenses: psExp },
    prior_month_full:        { from: priorStart, to: priorEndFull,       expenses: pfExp },
    projected_month_end_expenses: projected,
    pace_delta_pct: paceDelta,
    categories,
  };
}

/** Has this email already been processed? */
export function isEmailProcessed(messageId) {
  const row = db.prepare(`SELECT 1 FROM processed_emails WHERE message_id = ?`).get(messageId);
  return Boolean(row);
}

export function markEmailProcessed(messageId) {
  db.prepare(`INSERT OR IGNORE INTO processed_emails (message_id) VALUES (?)`).run(messageId);
}

// ─── LLM observability ────────────────────────────────────────────────────────

export function recordLlmCall({ provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, success, error }) {
  db.prepare(`
    INSERT INTO llm_calls
      (provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, success, error)
    VALUES
      (@provider, @model, @prompt_tokens, @completion_tokens, @total_tokens, @latency_ms, @success, @error)
  `).run({
    provider,
    model,
    prompt_tokens:     prompt_tokens     ?? null,
    completion_tokens: completion_tokens ?? null,
    total_tokens:      total_tokens      ?? null,
    latency_ms:        latency_ms        ?? null,
    success:           success ? 1 : 0,
    error:             error ?? null,
  });
}

/**
 * Aggregate stats over the last `days` days. Returns:
 *   { window_days, overall, by_provider, by_day }
 */
export function getLlmStats({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const overall = db.prepare(`
    SELECT
      COUNT(*)                                                     AS calls,
      SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)                   AS successes,
      SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)                   AS failures,
      COALESCE(SUM(total_tokens), 0)                               AS total_tokens,
      COALESCE(SUM(prompt_tokens), 0)                              AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)                          AS completion_tokens,
      ROUND(AVG(CASE WHEN success=1 THEN latency_ms END))          AS avg_latency_ms_ok,
      ROUND(AVG(latency_ms))                                       AS avg_latency_ms_all
    FROM llm_calls WHERE created_at >= ?
  `).get(since);

  const by_provider = db.prepare(`
    SELECT
      provider,
      model,
      COUNT(*)                                            AS calls,
      SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)          AS successes,
      SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)          AS failures,
      COALESCE(SUM(total_tokens), 0)                      AS total_tokens,
      ROUND(AVG(latency_ms))                              AS avg_latency_ms
    FROM llm_calls WHERE created_at >= ?
    GROUP BY provider, model
    ORDER BY calls DESC
  `).all(since);

  const by_day = db.prepare(`
    SELECT
      DATE(created_at)                                    AS day,
      COUNT(*)                                            AS calls,
      SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)          AS successes,
      COALESCE(SUM(total_tokens), 0)                      AS total_tokens
    FROM llm_calls WHERE created_at >= ?
    GROUP BY day
    ORDER BY day DESC
  `).all(since);

  return { window_days: days, overall, by_provider, by_day };
}

export function getTransactionStats() {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get().n;
  const earliest = db.prepare(`SELECT MIN(date) AS d FROM transactions`).get().d;
  const latest = db.prepare(`SELECT MAX(date) AS d FROM transactions`).get().d;
  return { total, earliest, latest };
}

// ─── Budget layer ───────────────────────────────────────────────────────────
// Mirrors the user's monthly "Cuentas MVP" Sheet:
//   incomes + fixed_expenses + variable_expenses + debts + fx_rates per period
// `period` is a 'YYYY-MM' string. Defaults to current month when omitted.

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Insert/replace FX rates for a period. Manual entries are never overwritten
 *  by auto-fetched ones — this protects user-entered rates from the cron. */
export function setFxRate(period, { usd_cop, eur_usd, tax_fr_pct = 0, source = "manual" }) {
  const p = period || currentPeriod();
  const existing = db.prepare(`SELECT source FROM fx_rates WHERE period = ?`).get(p);
  if (existing && existing.source === "manual" && source !== "manual") return existing;
  db.prepare(`
    INSERT INTO fx_rates (period, usd_cop, eur_usd, tax_fr_pct, source, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(period) DO UPDATE SET
      usd_cop = excluded.usd_cop, eur_usd = excluded.eur_usd,
      tax_fr_pct = excluded.tax_fr_pct, source = excluded.source,
      updated_at = datetime('now')
  `).run(p, usd_cop, eur_usd, tax_fr_pct, source);
  return getFxRate(p);
}

/** Get FX rates for a period. Falls back to the most recent row available. */
export function getFxRate(period) {
  const p = period || currentPeriod();
  const exact = db.prepare(`SELECT * FROM fx_rates WHERE period = ?`).get(p);
  if (exact) return exact;
  return db.prepare(`SELECT * FROM fx_rates ORDER BY period DESC LIMIT 1`).get() || null;
}

export function upsertIncome({ period, label, amount_eur, amount_src, currency, kind, notes }) {
  const p = period || currentPeriod();
  db.prepare(`
    INSERT INTO incomes (period, label, amount_eur, amount_src, currency, kind, notes)
    VALUES (@period, @label, @amount_eur, @amount_src, @currency, @kind, @notes)
    ON CONFLICT(period, label) DO UPDATE SET
      amount_eur = excluded.amount_eur, amount_src = excluded.amount_src,
      currency   = excluded.currency,   kind       = excluded.kind,
      notes      = excluded.notes
  `).run({
    period: p, label, amount_eur,
    amount_src: amount_src ?? null,
    currency:   currency   || "EUR",
    kind:       kind       || "other",
    notes:      notes      ?? null,
  });
  return db.prepare(`SELECT * FROM incomes WHERE period = ? AND label = ?`).get(p, label);
}

export function upsertFixedExpense({ period, label, budget_eur, category, notes, match_keyword }) {
  const p = period || currentPeriod();
  db.prepare(`
    INSERT INTO fixed_expenses (period, label, budget_eur, category, notes, match_keyword)
    VALUES (@period, @label, @budget_eur, @category, @notes, @match_keyword)
    ON CONFLICT(period, label) DO UPDATE SET
      budget_eur    = excluded.budget_eur,
      category      = excluded.category,
      notes         = COALESCE(excluded.notes, fixed_expenses.notes),
      match_keyword = COALESCE(excluded.match_keyword, fixed_expenses.match_keyword)
  `).run({
    period: p, label, budget_eur,
    category:      category      ?? null,
    notes:         notes         ?? null,
    match_keyword: match_keyword ?? null,
  });
  return db.prepare(`SELECT * FROM fixed_expenses WHERE period = ? AND label = ?`).get(p, label);
}

/** Set or clear the match_keyword on a fixed OR variable expense, across one
 *  period or all. target: 'fixed' (default) or 'variable'. */
export function setMatchKeyword({ label, match_keyword, period, target = "fixed" }) {
  const table = target === "variable" ? "variable_expenses" : "fixed_expenses";
  if (period) {
    db.prepare(`UPDATE ${table} SET match_keyword = ? WHERE label = ? AND period = ?`).run(match_keyword || null, label, period);
  } else {
    db.prepare(`UPDATE ${table} SET match_keyword = ? WHERE label = ?`).run(match_keyword || null, label);
  }
  return db.prepare(`SELECT period, label, match_keyword FROM ${table} WHERE label = ?`).all(label);
}

// ─── Account cashflow ───────────────────────────────────────────────────────
// Per-account view: opening + credits - debits = closing.
// Account is identified by the external_id prefix on transactions:
//   bnp:* → BNP, amex:* → Amex card, revolut:* → Revolut.

const ACCOUNT_PREFIX = { bnp: "bnp:", amex: "amex:", revolut: "revolut:" };

/** Set or update an account's opening/closing balance for a period. */
export function setAccountBalance({ account, period, opening_eur, closing_eur, source = "manual" }) {
  if (!account || !period) throw new Error("account + period required");
  db.prepare(`
    INSERT INTO account_balances (account, period, opening_eur, closing_eur, source, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(account, period) DO UPDATE SET
      opening_eur = COALESCE(excluded.opening_eur, account_balances.opening_eur),
      closing_eur = COALESCE(excluded.closing_eur, account_balances.closing_eur),
      source      = excluded.source,
      updated_at  = datetime('now')
  `).run(account, period, opening_eur ?? null, closing_eur ?? null, source);
  return db.prepare(`SELECT * FROM account_balances WHERE account = ? AND period = ?`).get(account, period);
}

/** Cashflow for an account in a period:
 *    opening + ingresos (credits) - egresos (debits) = closing
 *  Opening is taken from account_balances, OR inferred as previous period's
 *  closing if available. Closing is stored OR computed (opening + net).
 *  Returns null fields when balance can't be inferred. */
export function getAccountCashflow({ account = "bnp", period }) {
  const p = period || currentPeriod();
  const prefix = ACCOUNT_PREFIX[account];
  if (!prefix) throw new Error(`unknown account: ${account}`);

  const flows = db.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS credits,
      ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount)  ELSE 0 END), 2) AS debits,
      COUNT(*)                                                       AS tx_count
    FROM transactions
    WHERE external_id LIKE ? AND strftime('%Y-%m', date) = ?
  `).get(prefix + "%", p);

  const credits = flows.credits || 0;
  const debits  = flows.debits  || 0;
  const netChange = Math.round((credits - debits) * 100) / 100;

  const stored = db.prepare(`SELECT * FROM account_balances WHERE account = ? AND period = ?`).get(account, p);

  // Infer opening from previous period's closing if not stored
  let opening = stored?.opening_eur;
  let openingSource = stored?.opening_eur != null ? stored.source : null;
  if (opening == null) {
    const [yr, mm] = p.split("-").map(Number);
    const prev = new Date(yr, mm - 2, 1);
    const prevPeriod = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const prevStored = db.prepare(`SELECT closing_eur FROM account_balances WHERE account = ? AND period = ?`).get(account, prevPeriod);
    if (prevStored?.closing_eur != null) {
      opening = prevStored.closing_eur;
      openingSource = `inferred from ${prevPeriod} closing`;
    }
  }

  const closing = stored?.closing_eur != null
    ? stored.closing_eur
    : (opening != null ? Math.round((opening + netChange) * 100) / 100 : null);

  return {
    account,
    period: p,
    opening_eur:     opening,
    credits_eur:     credits,
    debits_eur:      debits,
    net_change_eur:  netChange,
    closing_eur:     closing,
    tx_count:        flows.tx_count || 0,
    opening_source:  openingSource || "unset",
    closing_source:  stored?.closing_eur != null ? stored.source : (closing != null ? "computed" : "unset"),
  };
}

/** Change the category of one or many transactions. Returns the count of rows
 *  updated. Used by the audit / drilldown "Recategorizar a..." dropdowns. */
export function updateTransactionCategory({ ids, category }) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("ids[] required");
  if (!category || typeof category !== "string") throw new Error("category required");
  const placeholders = ids.map(() => "?").join(",");
  const r = db.prepare(`UPDATE transactions SET category = ? WHERE id IN (${placeholders})`)
    .run(category, ...ids);
  return r.changes;
}

/** Append a regex-escaped chunk of a merchant name to an existing match_keyword.
 *  Used by the audit UI: user clicks "asignar [merchant] a [Arriendo]" → we
 *  add a literal match for that merchant to Arriendo's keyword. */
export function appendToMatchKeyword({ label, merchant_snippet, period, target = "fixed" }) {
  if (!merchant_snippet || !merchant_snippet.trim()) throw new Error("merchant_snippet required");
  const escaped = merchant_snippet.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const table = target === "variable" ? "variable_expenses" : "fixed_expenses";
  const current = db.prepare(`SELECT match_keyword FROM ${table} WHERE label = ? LIMIT 1`).get(label);
  const cur = (current?.match_keyword || "").trim();
  const next = cur ? `${cur}|${escaped}` : escaped;
  return setMatchKeyword({ label, match_keyword: next, period, target });
}

/** Variable expenses are one-offs — no unique constraint, plain INSERT. */
export function insertVariableExpense({ period, label, amount_eur, category, notes }) {
  const p = period || currentPeriod();
  const r = db.prepare(`
    INSERT INTO variable_expenses (period, label, amount_eur, category, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(p, label, amount_eur, category ?? null, notes ?? null);
  return db.prepare(`SELECT * FROM variable_expenses WHERE id = ?`).get(r.lastInsertRowid);
}

/** Delete budget rows by label across all periods (or a specific one).
 *  kind: 'fixed' | 'variable' | 'income' | 'debt'. Used to retire a planned
 *  line item from the dashboard without touching transactions. */
export function deleteBudgetRow({ kind, label, period }) {
  const tables = {
    fixed:    "fixed_expenses",
    variable: "variable_expenses",
    income:   "incomes",
    debt:     "debts",
  };
  const tbl = tables[kind];
  if (!tbl) throw new Error(`unknown kind: ${kind}`);
  const args = [label];
  let sql = `DELETE FROM ${tbl} WHERE label = ?`;
  if (period) { sql += ` AND period = ?`; args.push(period); }
  const r = db.prepare(sql).run(...args);
  return { ok: true, deleted: r.changes };
}

/** Insert a debt row. amount_eur is computed from current FX if missing.
 *  Uses ON CONFLICT to replace prior snapshot for the same (period, label). */
export function upsertDebt({ period, label, amount_src, currency, amount_eur, kind, notes }) {
  const p = period || currentPeriod();
  let eur = amount_eur;
  if (eur == null) {
    const fx = getFxRate(p);
    if (!fx) throw new Error("Cannot compute debt amount_eur — no fx_rates row exists. Set FX first.");
    if (currency === "EUR") eur = amount_src;
    else if (currency === "USD") eur = amount_src / fx.eur_usd;
    else if (currency === "COP") eur = (amount_src / fx.usd_cop) / fx.eur_usd;
    else throw new Error(`Unsupported debt currency: ${currency}`);
  }
  db.prepare(`
    INSERT INTO debts (period, label, amount_src, currency, amount_eur, kind, notes)
    VALUES (@period, @label, @amount_src, @currency, @amount_eur, @kind, @notes)
    ON CONFLICT(period, label) DO UPDATE SET
      amount_src = excluded.amount_src, currency   = excluded.currency,
      amount_eur = excluded.amount_eur, kind       = excluded.kind,
      notes      = excluded.notes
  `).run({
    period: p, label, amount_src, currency,
    amount_eur: Math.round(eur * 100) / 100,
    kind:  kind  ?? null,
    notes: notes ?? null,
  });
  return db.prepare(`SELECT * FROM debts WHERE period = ? AND label = ?`).get(p, label);
}

/** Raw rows for a period — used by the dashboard JSON endpoint. */
export function listBudgetPeriod(period) {
  const p = period || currentPeriod();
  return {
    period:   p,
    fx:       getFxRate(p),
    incomes:  db.prepare(`SELECT * FROM incomes           WHERE period = ? ORDER BY kind, label`).all(p),
    fixed:    db.prepare(`SELECT * FROM fixed_expenses    WHERE period = ? ORDER BY budget_eur DESC`).all(p),
    variable: db.prepare(`SELECT * FROM variable_expenses WHERE period = ? ORDER BY amount_eur DESC`).all(p),
    debts:    db.prepare(`SELECT * FROM debts             WHERE period = ? ORDER BY amount_eur DESC`).all(p),
  };
}

/** Attribute period transactions to fixed-expense budget lines.
 *
 *  Strategy (MECE-oriented):
 *
 *  1. CROSS-CATEGORY keyword match. Every fixed line with `match_keyword`
 *     (regex) sees ALL outflow transactions for the period, regardless of the
 *     transaction's stored category. This lets "Arriendo" claim a
 *     "VIR INSTANTANE VARELA" transfer that was tagged 'other', etc.
 *     First match wins; if multiple keyword lines match the same transaction,
 *     it's flagged in the audit but assigned to the first one.
 *
 *  2. PROPORTIONAL fallback for unmatched transactions WITHIN their stored
 *     category. If the category has unkeyed budget lines, the transaction is
 *     split across them by budget weight. If the category has only keyword
 *     lines (none matched) or no budget lines at all, the transaction becomes
 *     a leftover under its stored category.
 *
 *  Returns: { rows: [...], leftovers: [{category, total, count}, ...] }
 */
export function getActualSpendVsBudget(period) {
  const p = period || currentPeriod();
  const fixed    = db.prepare(`SELECT * FROM fixed_expenses    WHERE period = ?`).all(p);
  const variable = db.prepare(`SELECT * FROM variable_expenses WHERE period = ?`).all(p);

  // All outflow transactions for the period (excluding internal account transfers)
  const txs = db.prepare(`
    SELECT id, category, merchant, description, ABS(amount) AS amt
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y-%m', date) = ?
  `).all(p);

  // Tag each budget line with its kind so we can sort attributions back per type
  for (const f of fixed)    f._kind = "fixed";
  for (const v of variable) { v._kind = "variable"; v.budget_eur = v.amount_eur; }  // alias so logic below is uniform

  // Compile keyword regexes once; build cross-category list AND per-category unkeyed groups.
  // PRIORITY ORDER: variables FIRST, then fixed. Variables are usually more
  // specific (e.g. "Inversion PERCO" with keyword swisslife.*retraite should
  // win over fixed "Seguro" with broader swisslife pattern). First match wins.
  const keyedAll  = [];
  const byCatUnkeyed = {};
  for (const f of [...variable, ...fixed]) {
    if (f.match_keyword) {
      try { f._rx = new RegExp(f.match_keyword, "i"); keyedAll.push(f); }
      catch { /* malformed regex → fall through to unkeyed bucket */ if (f._kind === "fixed") byCatUnkeyed[f.category || "__nocat__"] = (byCatUnkeyed[f.category || "__nocat__"] || []).concat(f); }
    } else if (f._kind === "fixed") {
      // Only FIXED lines get the unkeyed proportional fallback (variables are
      // one-offs and don't make sense as a "default catcher" for a category).
      const cat = f.category || "__nocat__";
      byCatUnkeyed[cat] = (byCatUnkeyed[cat] || []).concat(f);
    }
  }

  const actualById = new Map([...fixed, ...variable].map((x) => [`${x._kind}:${x.id}`, 0]));
  const leftover   = {};

  function addLeftover(cat, amt) {
    const c = cat || "uncategorised";
    leftover[c] = leftover[c] || { total: 0, count: 0 };
    leftover[c].total += amt;
    leftover[c].count += 1;
  }

  // Track post-attribution category for each transaction. If a tx is claimed
  // by a budget line, we display it under THAT line's category in the donut
  // (so rent tagged 'transfers' but claimed by Arriendo (housing) shows under
  // 'housing'). Unclaimed transactions keep their raw transaction.category.
  const attributedByCategory = {};
  function addAttributed(cat, amt) {
    const c = cat || "uncategorised";
    attributedByCategory[c] = (attributedByCategory[c] || 0) + amt;
  }

  for (const tx of txs) {
    // 1. Cross-category keyword match (first wins) — checks fixed AND variables
    let matched = null;
    for (const f of keyedAll) {
      if (f._rx.test(tx.merchant || "") || f._rx.test(tx.description || "")) {
        matched = f; break;
      }
    }
    if (matched) {
      const k = `${matched._kind}:${matched.id}`;
      actualById.set(k, actualById.get(k) + tx.amt);
      addAttributed(matched.category, tx.amt);   // ← attribution view uses budget-line category
      continue;
    }

    // 2. Proportional fallback within the transaction's own category (FIXED only)
    const cat = tx.category || "uncategorised";
    const unkeyed = byCatUnkeyed[cat];
    if (unkeyed && unkeyed.length) {
      const totalBudget = unkeyed.reduce((s, f) => s + (f.budget_eur || 0), 0);
      if (totalBudget > 0) {
        for (const f of unkeyed) {
          const share = tx.amt * (f.budget_eur / totalBudget);
          const k = `fixed:${f.id}`;
          actualById.set(k, actualById.get(k) + share);
        }
      } else {
        const share = tx.amt / unkeyed.length;
        for (const f of unkeyed) {
          const k = `fixed:${f.id}`;
          actualById.set(k, actualById.get(k) + share);
        }
      }
      addAttributed(cat, tx.amt);  // proportional fallback → category is same as raw
    } else {
      addLeftover(cat, tx.amt);
      addAttributed(cat, tx.amt);  // orphan → original category
    }
  }

  const rows = fixed.map((f) => {
    const actual = Math.round((actualById.get(`fixed:${f.id}`) || 0) * 100) / 100;
    const delta  = Math.round((actual - f.budget_eur) * 100) / 100;
    const pct    = f.budget_eur > 0 ? Math.round((actual / f.budget_eur) * 1000) / 10 : null;
    return {
      label:         f.label,
      budget_eur:    f.budget_eur,
      category:      f.category,
      match_keyword: f.match_keyword || null,
      actual_eur:    actual,
      delta_eur:     delta,
      pct_used:      pct,
    };
  });

  const variableRows = variable.map((v) => {
    const actual = Math.round((actualById.get(`variable:${v.id}`) || 0) * 100) / 100;
    const delta  = Math.round((actual - v.amount_eur) * 100) / 100;
    const pct    = v.amount_eur > 0 ? Math.round((actual / v.amount_eur) * 1000) / 10 : null;
    return {
      id:            v.id,
      label:         v.label,
      amount_eur:    v.amount_eur,
      category:      v.category,
      match_keyword: v.match_keyword || null,
      actual_eur:    actual,
      delta_eur:     delta,
      pct_used:      pct,
    };
  });

  const leftovers = Object.entries(leftover)
    .map(([category, v]) => ({ category, total: Math.round(v.total * 100) / 100, count: v.count }))
    .sort((a, b) => b.total - a.total);

  const byCategoryAttributed = Object.entries(attributedByCategory)
    .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  return { rows, variableRows, leftovers, byCategoryAttributed };
}

/** Full payload for the dashboard JSON endpoint. */
export function getDashboardSummary(period) {
  const p = period || currentPeriod();
  const raw = listBudgetPeriod(p);
  const attrib = getActualSpendVsBudget(p);
  const fixedWithActual    = attrib.rows;
  const variableWithActual = attrib.variableRows;
  const leftovers          = attrib.leftovers;

  const incomeTotal   = raw.incomes.reduce((s, r) => s + (r.kind === "salary_neto" || r.kind === "other" ? r.amount_eur : 0), 0);
  const fixedTotal    = raw.fixed.reduce((s, r) => s + r.budget_eur, 0);
  const variableTotal = raw.variable.reduce((s, r) => s + r.amount_eur, 0);
  // "Actual" = real outflows this period from the transactions table,
  // excluding internal account transfers (Amex bill payment, Revolut top-up).
  const actualRow = db.prepare(`
    SELECT ROUND(SUM(ABS(amount)), 2) AS total
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y-%m', date) = ?
  `).get(p);
  const actualTotal = actualRow?.total || 0;
  const residual    = Math.round((incomeTotal - fixedTotal - variableTotal) * 100) / 100;
  const pctSpent    = incomeTotal > 0 ? Math.round(((fixedTotal + variableTotal) / incomeTotal) * 1000) / 10 : null;

  // Use post-attribution categories so the donut reflects where the money
  // ACTUALLY landed (rent claimed by Arriendo → housing, even if tagged
  // 'transfers' in the raw transactions table). Falls back to raw aggregate
  // if no attribution available.
  const byCategoryActual = attrib.byCategoryAttributed && attrib.byCategoryAttributed.length
    ? attrib.byCategoryAttributed
    : db.prepare(`
    SELECT COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(ABS(amount)), 2)          AS total
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y-%m', date) = ?
    GROUP BY category ORDER BY total DESC
  `).all(p);

  const byCategoryBudget = db.prepare(`
    SELECT COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(budget_eur), 2)            AS total
    FROM fixed_expenses WHERE period = ?
    GROUP BY category ORDER BY total DESC
  `).all(p);

  return {
    period: p,
    fx:     raw.fx,
    incomes:  raw.incomes,
    fixed:    fixedWithActual,
    variable: variableWithActual,
    debts:    raw.debts,
    leftovers,   // [{category, total, count}] — actuals not claimed by any fixed line's keyword
    totals: {
      income_eur:   Math.round(incomeTotal * 100) / 100,
      fixed_eur:    Math.round(fixedTotal * 100) / 100,
      variable_eur: Math.round(variableTotal * 100) / 100,
      actual_eur:   actualTotal,
      residual_eur: residual,
      pct_spent:    pctSpent,
      debt_total_eur: Math.round(raw.debts.reduce((s, r) => s + r.amount_eur, 0) * 100) / 100,
    },
    by_category_actual: byCategoryActual,
    by_category_budget: byCategoryBudget,
    monthly_category_spend: getMonthlyCategorySpend({ months: 6 }),
    bnp_balance_history:   getAccountClosingHistory({ account: "bnp", months: 12 }),
    recent_months_comparison: getRecentMonthsComparison({ months: 3 }),
    spend_pace: getSpendPace(),
  };
}

/** Audit report for a period: which transactions are orphans (no fijo keyword
 *  matches), which match multiple keywords (conflicts), how much per
 *  fixed line was claimed by keyword vs distributed by fallback. The dashboard
 *  uses this to surface "you have €X of un-attributable spending" with an
 *  actionable list. */
export function getAuditReport(period) {
  const p = period || currentPeriod();
  const fixed = db.prepare(`SELECT * FROM fixed_expenses WHERE period = ?`).all(p);
  const txs = db.prepare(`
    SELECT id, date, category, merchant, description, ABS(amount) AS amt
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y-%m', date) = ?
    ORDER BY amt DESC
  `).all(p);

  // Compile regexes
  const keyed = [];
  for (const f of fixed) {
    if (!f.match_keyword) continue;
    try { f._rx = new RegExp(f.match_keyword, "i"); keyed.push(f); }
    catch { /* skip malformed */ }
  }

  const orphans = [];
  const conflicts = [];
  const claimedByLine = new Map(fixed.map((f) => [f.id, { count: 0, total: 0, label: f.label }]));
  const orphansByCategory = {};

  for (const tx of txs) {
    const matches = [];
    for (const f of keyed) {
      if (f._rx.test(tx.merchant || "") || f._rx.test(tx.description || "")) {
        matches.push(f);
      }
    }
    if (matches.length === 0) {
      orphans.push({ id: tx.id, date: tx.date, merchant: tx.merchant, category: tx.category, amount: tx.amt });
      const c = tx.category || "uncategorised";
      orphansByCategory[c] = orphansByCategory[c] || { total: 0, count: 0 };
      orphansByCategory[c].total += tx.amt;
      orphansByCategory[c].count += 1;
    } else {
      // First match wins for assignment
      const winner = matches[0];
      const acc = claimedByLine.get(winner.id);
      acc.count += 1;
      acc.total += tx.amt;
      if (matches.length > 1) {
        conflicts.push({
          id: tx.id, date: tx.date, merchant: tx.merchant, amount: tx.amt,
          matched_by: matches.map((m) => m.label),
          assigned_to: winner.label,
        });
      }
    }
  }

  const totalOutflow = txs.reduce((s, t) => s + t.amt, 0);
  const totalOrphan  = orphans.reduce((s, t) => s + t.amount, 0);
  const totalClaimed = [...claimedByLine.values()].reduce((s, l) => s + l.total, 0);

  return {
    period: p,
    totals: {
      total_outflow:    Math.round(totalOutflow * 100) / 100,
      total_claimed:    Math.round(totalClaimed * 100) / 100,
      total_orphan:     Math.round(totalOrphan * 100) / 100,
      orphan_pct:       totalOutflow > 0 ? Math.round((totalOrphan / totalOutflow) * 1000) / 10 : 0,
      orphan_count:     orphans.length,
      conflict_count:   conflicts.length,
    },
    orphans_by_category: Object.entries(orphansByCategory)
      .map(([category, v]) => ({ category, total: Math.round(v.total * 100) / 100, count: v.count }))
      .sort((a, b) => b.total - a.total),
    orphans:   orphans.slice(0, 200),  // cap so JSON doesn't bloat
    conflicts: conflicts.slice(0, 50),
    claimed_by_line: [...claimedByLine.values()].filter((l) => l.count > 0).sort((a, b) => b.total - a.total),
    fixed_labels: fixed.map((f) => ({ label: f.label, category: f.category, match_keyword: f.match_keyword || null })),
  };
}

/** Spending broken down by month × category for the last N months.
 *  Used by the stacked-area trend chart. Returns:
 *    [{ month: '2026-04', categories: { restaurants: 421, groceries: 312, ... } }, ...]
 *  ordered chronologically (oldest first). */
export function getMonthlyCategorySpend({ months = 6 } = {}) {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', date)         AS month,
           COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(ABS(amount)), 2)      AS total
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0
    GROUP BY month, category
    ORDER BY month DESC
  `).all();
  // Group by month
  const byMonth = {};
  for (const r of rows) {
    byMonth[r.month] = byMonth[r.month] || {};
    byMonth[r.month][r.category] = r.total;
  }
  const sortedMonths = Object.keys(byMonth).sort().reverse().slice(0, months).reverse();
  return sortedMonths.map((m) => ({ month: m, categories: byMonth[m] }));
}

/** Month-by-month cashflow per account + combined. Powers the Histórico tab.
 *  Returns: { months: [...], rows: [{ period, accounts: { bnp: {credits,debits,net,tx},
 *  amex: {...}, revolut: {...} }, combined: {credits,debits,net} }, ...] } */
export function getConsolidatedHistory({ months = 12 } = {}) {
  const accounts = ["bnp", "amex", "revolut"];

  const periods = db.prepare(`
    SELECT DISTINCT strftime('%Y-%m', date) AS period FROM transactions
    WHERE date IS NOT NULL
    ORDER BY period DESC LIMIT ?
  `).all(months).map((r) => r.period).reverse();

  const rows = periods.map((p) => {
    const row = {
      period: p,
      accounts: {},
      combined: { credits: 0, debits: 0, net: 0, tx: 0 },
    };
    for (const acc of accounts) {
      const flow = db.prepare(`
        SELECT
          ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS credits,
          ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount)  ELSE 0 END), 2) AS debits,
          COUNT(*) AS tx
        FROM transactions
        WHERE external_id LIKE ? AND strftime('%Y-%m', date) = ?
      `).get(acc + ":%", p);
      const credits = flow.credits || 0;
      const debits  = flow.debits  || 0;
      row.accounts[acc] = {
        credits, debits,
        net: Math.round((credits - debits) * 100) / 100,
        tx: flow.tx || 0,
      };
      row.combined.credits += credits;
      row.combined.debits  += debits;
      row.combined.tx      += flow.tx || 0;
    }
    row.combined.credits = Math.round(row.combined.credits * 100) / 100;
    row.combined.debits  = Math.round(row.combined.debits  * 100) / 100;
    row.combined.net     = Math.round((row.combined.credits - row.combined.debits) * 100) / 100;
    return row;
  });

  return { accounts, months: periods, rows };
}

/** Compare last N months of spending per category. Returns:
 *    {
 *      months: ['2026-02','2026-03','2026-04'],
 *      categories: [{
 *        category, totals: [m1, m2, m3], delta_abs: m3-m1, delta_pct: ...,
 *      }, ...],
 *      summary: { total_per_month: [a,b,c], total_delta_pct: x }
 *    }
 *  Sorted by absolute delta DESC so the biggest movers come first. */
export function getRecentMonthsComparison({ months = 3 } = {}) {
  const monthSpend = getMonthlyCategorySpend({ months });
  if (monthSpend.length < 2) return { months: monthSpend.map((m) => m.month), categories: [], summary: {} };
  const monthList = monthSpend.map((m) => m.month);

  // Union of all categories
  const cats = new Set();
  for (const m of monthSpend) for (const c of Object.keys(m.categories)) cats.add(c);

  const categoryRows = [...cats].map((cat) => {
    const totals = monthSpend.map((m) => Math.round((m.categories[cat] || 0) * 100) / 100);
    const first = totals[0], last = totals[totals.length - 1];
    const delta = Math.round((last - first) * 100) / 100;
    const pct = first > 0 ? Math.round((delta / first) * 1000) / 10 : null;
    return { category: cat, totals, delta_abs: delta, delta_pct: pct };
  }).sort((a, b) => Math.abs(b.delta_abs) - Math.abs(a.delta_abs));

  const totalsPerMonth = monthSpend.map((m) => Math.round(Object.values(m.categories).reduce((s, v) => s + v, 0) * 100) / 100);
  const totalDeltaPct = totalsPerMonth[0] > 0
    ? Math.round(((totalsPerMonth[totalsPerMonth.length - 1] - totalsPerMonth[0]) / totalsPerMonth[0]) * 1000) / 10
    : null;

  return {
    months: monthList,
    categories: categoryRows,
    summary: { total_per_month: totalsPerMonth, total_delta_pct: totalDeltaPct },
  };
}

/** History of an account's closing balance per month. Used by the
 *  cash-position line chart. */
export function getAccountClosingHistory({ account = "bnp", months = 12 } = {}) {
  const rows = db.prepare(`
    SELECT period, opening_eur, closing_eur, source
    FROM account_balances
    WHERE account = ?
    ORDER BY period DESC
    LIMIT ?
  `).all(account, months);
  return rows.reverse();  // oldest first
}

/** Year-to-date (or any year) consolidated summary across all months of the
 *  given year. Aggregates transactions + budgets monthly and rolls up. */
export function getYearSummary(year) {
  const y = year || String(new Date().getFullYear());

  // Annual totals from transactions (internal transfers excluded from expense/income)
  const totals = db.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END), 2) AS expenses,
      ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS income,
      COUNT(*) AS tx_count
    FROM transactions WHERE strftime('%Y', date) = ? AND is_internal_transfer = 0
  `).get(y);

  // Top categories actuals
  const byCategory = db.prepare(`
    SELECT COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(ABS(amount)), 2)          AS total,
           COUNT(*)                            AS count
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y', date) = ?
    GROUP BY category ORDER BY total DESC
  `).all(y);

  // Monthly trend (excluding internal transfers)
  const byMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', date)                                        AS month,
      ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END), 2)  AS expenses,
      ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS income,
      COUNT(*)                                                       AS count
    FROM transactions WHERE strftime('%Y', date) = ? AND is_internal_transfer = 0
    GROUP BY month ORDER BY month
  `).all(y);

  // Top merchants
  const topMerchants = db.prepare(`
    SELECT COALESCE(merchant, 'unknown')   AS merchant,
           ROUND(SUM(ABS(amount)), 2)      AS total,
           COUNT(*)                        AS count
    FROM transactions
    WHERE amount < 0 AND is_internal_transfer = 0 AND strftime('%Y', date) = ?
    GROUP BY merchant ORDER BY total DESC LIMIT 20
  `).all(y);

  // Annual budget aggregates (sum of monthly planned)
  const budgetTotals = db.prepare(`
    SELECT
      (SELECT ROUND(SUM(amount_eur), 2) FROM incomes           WHERE substr(period, 1, 4) = ?) AS income_planned,
      (SELECT ROUND(SUM(budget_eur), 2) FROM fixed_expenses    WHERE substr(period, 1, 4) = ?) AS fixed_planned,
      (SELECT ROUND(SUM(amount_eur), 2) FROM variable_expenses WHERE substr(period, 1, 4) = ?) AS variable_planned
  `).get(y, y, y);

  const expenses = totals.expenses || 0;
  const income   = totals.income   || 0;
  const monthsCount = byMonth.length || 1;

  return {
    year: y,
    tx_count: totals.tx_count || 0,
    months_with_data: monthsCount,
    totals: {
      income_actual_eur:    income,
      expenses_actual_eur:  expenses,
      net_actual_eur:       Math.round((income - expenses) * 100) / 100,
      income_planned_eur:   budgetTotals.income_planned   || 0,
      fixed_planned_eur:    budgetTotals.fixed_planned    || 0,
      variable_planned_eur: budgetTotals.variable_planned || 0,
      avg_monthly_expense:  Math.round((expenses / monthsCount) * 100) / 100,
      avg_monthly_income:   Math.round((income / monthsCount) * 100) / 100,
    },
    by_category: byCategory,
    by_month:    byMonth,
    top_merchants: topMerchants,
  };
}

/** List distinct years present in the transactions table — for the year picker. */
export function listYears() {
  return db.prepare(`SELECT DISTINCT strftime('%Y', date) AS y FROM transactions ORDER BY y DESC`)
    .all().map((r) => r.y);
}

/** Transactions in a category for a period (month YYYY-MM or year YYYY).
 *  Returns the rows + total, sorted by absolute amount desc. */
export function listCategoryTransactions({ category, period }) {
  if (!category) throw new Error("category required");
  const where = period && /^\d{4}-\d{2}$/.test(period)
    ? `AND strftime('%Y-%m', date) = ?`
    : period && /^\d{4}$/.test(period)
      ? `AND strftime('%Y', date) = ?`
      : "";
  const args  = period ? [category, period] : [category];
  const rows  = db.prepare(`
    SELECT id, date, merchant, amount, currency, source, description, external_id
    FROM transactions WHERE category = ? ${where}
    ORDER BY ABS(amount) DESC LIMIT 500
  `).all(...args);
  // Derive a human-readable account from the external_id prefix
  for (const r of rows) {
    const prefix = (r.external_id || "").split(":")[0];
    r.account = ({ bnp: "BNP", amex: "Amex", revolut: "Revolut", csv: "CSV", pdf: "BNP", email: "Email" })[prefix] || prefix || "—";
  }
  return {
    category, period: period || "all-time",
    count: rows.length,
    total: Math.round(rows.reduce((s, r) => s + Math.abs(r.amount), 0) * 100) / 100,
    rows,
  };
}

/** Distinct periods present across budget tables AND the transactions table.
 *  Includes months that only have actuals (no planned budget) so the user can
 *  still navigate to them in the picker and see what was spent. */
export function listBudgetPeriods() {
  return db.prepare(`
    SELECT period FROM (
      SELECT period FROM incomes
      UNION SELECT period FROM fixed_expenses
      UNION SELECT period FROM variable_expenses
      UNION SELECT period FROM debts
      UNION SELECT period FROM fx_rates
      UNION SELECT strftime('%Y-%m', date) AS period FROM transactions WHERE date IS NOT NULL
    ) GROUP BY period ORDER BY period DESC
  `).all().map((r) => r.period);
}

export default db;

// ─── Self-test (run directly: node src/memory.js) ────────────────────────────

if (process.argv[1].endsWith("memory.js")) {
  console.log("Testing memory layer...\n");

  const project = createProject({ name: "PortPagos MVP", description: "B2B payments for port ops" });
  console.log("Created project:", project);

  const task = createTask({
    project_id: project.id,
    title: "Integrate Bridge API for EUR-USDC corridor",
    priority: "High",
    due_date: new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0],
    effort_h: 8,
  });
  console.log("Created task:", task);

  saveMessage("user", "Hola, qué tengo pendiente hoy?");
  saveMessage("assistant", "Tienes 1 tarea de alta prioridad en PortPagos...");

  console.log("\nRecent messages:", getRecentMessages(5));
  console.log("\nTasks due soon:", getTasksDueSoon(7));
  console.log("\nDaily summary:", JSON.stringify(getDailySummary(), null, 2));

  console.log("\n✅ Memory layer OK");
}
