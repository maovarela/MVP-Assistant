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
`);

// ─── Messages (conversation history) ─────────────────────────────────────────

export function saveMessage(role, content) {
  db.prepare(`
    INSERT INTO messages (role, content) VALUES (?, ?)
  `).run(role, content);
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
