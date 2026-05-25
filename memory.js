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
 * tx fields: { external_id, source, date, merchant, amount, currency, category, description, raw }
 */
export function insertTransaction(tx) {
  try {
    const result = db.prepare(`
      INSERT INTO transactions
        (external_id, source, date, merchant, amount, currency, category, description, raw)
      VALUES
        (@external_id, @source, @date, @merchant, @amount, @currency, @category, @description, @raw)
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

/** Spend summary by category for a date range. Outflows (amount<0) only. */
export function spendByCategory({ from, to } = {}) {
  let query = `
    SELECT
      COALESCE(category, 'uncategorised') AS category,
      ROUND(SUM(ABS(amount)), 2)          AS total,
      COUNT(*)                            AS count
    FROM transactions
    WHERE amount < 0
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
    WHERE amount < 0
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
    FROM transactions WHERE date BETWEEN ? AND ?
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

export function upsertFixedExpense({ period, label, budget_eur, category, notes }) {
  const p = period || currentPeriod();
  db.prepare(`
    INSERT INTO fixed_expenses (period, label, budget_eur, category, notes)
    VALUES (@period, @label, @budget_eur, @category, @notes)
    ON CONFLICT(period, label) DO UPDATE SET
      budget_eur = excluded.budget_eur,
      category   = excluded.category,
      notes      = excluded.notes
  `).run({
    period: p, label, budget_eur,
    category: category ?? null,
    notes:    notes    ?? null,
  });
  return db.prepare(`SELECT * FROM fixed_expenses WHERE period = ? AND label = ?`).get(p, label);
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

/** Join planned fixed_expenses against real transactions for the period.
 *  Match key is `category` (one fixed-expense line ⇔ many transactions).
 *  Returns one row per fixed-expense line with the spend so far + delta. */
export function getActualSpendVsBudget(period) {
  const p = period || currentPeriod();
  const fixed = db.prepare(`SELECT * FROM fixed_expenses WHERE period = ?`).all(p);
  const actuals = db.prepare(`
    SELECT COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(ABS(amount)), 2)          AS total
    FROM transactions
    WHERE amount < 0 AND strftime('%Y-%m', date) = ?
    GROUP BY category
  `).all(p);
  const actualByCat = Object.fromEntries(actuals.map((r) => [r.category, r.total]));
  return fixed.map((f) => {
    const actual = f.category ? (actualByCat[f.category] || 0) : 0;
    const delta  = Math.round((actual - f.budget_eur) * 100) / 100;
    const pct    = f.budget_eur > 0 ? Math.round((actual / f.budget_eur) * 1000) / 10 : null;
    return {
      label:      f.label,
      budget_eur: f.budget_eur,
      category:   f.category,
      actual_eur: actual,
      delta_eur:  delta,
      pct_used:   pct,
    };
  });
}

/** Full payload for the dashboard JSON endpoint. */
export function getDashboardSummary(period) {
  const p = period || currentPeriod();
  const raw = listBudgetPeriod(p);
  const fixedWithActual = getActualSpendVsBudget(p);

  const incomeTotal   = raw.incomes.reduce((s, r) => s + (r.kind === "salary_neto" || r.kind === "other" ? r.amount_eur : 0), 0);
  const fixedTotal    = raw.fixed.reduce((s, r) => s + r.budget_eur, 0);
  const variableTotal = raw.variable.reduce((s, r) => s + r.amount_eur, 0);
  // "Actual" = real outflows this period from the transactions table.
  const actualRow = db.prepare(`
    SELECT ROUND(SUM(ABS(amount)), 2) AS total
    FROM transactions
    WHERE amount < 0 AND strftime('%Y-%m', date) = ?
  `).get(p);
  const actualTotal = actualRow?.total || 0;
  const residual    = Math.round((incomeTotal - fixedTotal - variableTotal) * 100) / 100;
  const pctSpent    = incomeTotal > 0 ? Math.round(((fixedTotal + variableTotal) / incomeTotal) * 1000) / 10 : null;

  const byCategoryActual = db.prepare(`
    SELECT COALESCE(category, 'uncategorised') AS category,
           ROUND(SUM(ABS(amount)), 2)          AS total
    FROM transactions
    WHERE amount < 0 AND strftime('%Y-%m', date) = ?
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
    variable: raw.variable,
    debts:    raw.debts,
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
    spend_pace: getSpendPace(),
  };
}

/** Distinct periods present across budget tables — for the period selector. */
export function listBudgetPeriods() {
  return db.prepare(`
    SELECT period FROM (
      SELECT period FROM incomes
      UNION SELECT period FROM fixed_expenses
      UNION SELECT period FROM variable_expenses
      UNION SELECT period FROM debts
      UNION SELECT period FROM fx_rates
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
