// server.js
// Express webhook server + embedded scheduler. Replaces the old polling
// index.js. Pattern lifted from Runaldo's Railway deployment:
//   - POST /webhook/telegram          → bot replies instantly
//   - GET  /healthz                    → for Railway health checks
//   - Scheduler runs cron jobs in-process (daily briefing, weekly review,
//     hourly inbox scan)

import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import fs from "fs";
import os from "os";
import path from "path";

import { runAgent } from "./agent.js";
import { getTasksDueSoon } from "./memory.js";
import { fetchAndParseRecent, backfillEmails } from "./email.js";
import { importCsv, importPdf, importNormalized } from "./transactions.js";
import {
  sendWhatsApp,
  parseEvolutionWebhook,
  isAllowedSender,
  isWhatsAppConfigured,
} from "./whatsapp.js";
import { runProactiveScan } from "./proactive.js";
import db, {
  getTransactionStats, getSpendPace,
  setFxRate, getFxRate,
  upsertIncome, upsertFixedExpense, insertVariableExpense, upsertDebt,
  getDashboardSummary, listBudgetPeriods,
  getYearSummary, listYears, listCategoryTransactions, listAllTransactions,
  setMatchKeyword, appendToMatchKeyword,
  getAuditReport, updateTransactionCategory,
  getAccountCashflow, setAccountBalance,
  getConsolidatedHistory,
  deleteBudgetRow,
  upsertCategoryBudget, copyCategoryBudgets,
  listPendingItems, upsertPendingItem, deletePendingItem,
} from "./memory.js";
import { categorize as keywordCategorize } from "./bankCsv.js";
import { refreshCurrentMonthFx } from "./fx.js";
import { renderDashboard } from "./dashboard.js";
import { runWeeklyAdvisorBriefing } from "./advisor.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN              = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID            = process.env.TELEGRAM_CHAT_ID?.trim();
const PORT               = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DOMAIN      = process.env.RAILWAY_PUBLIC_DOMAIN;
const WEBHOOK_SECRET     = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BACKFILL_ON_BOOT   = process.env.EMAIL_BACKFILL_DAYS;

// WhatsApp / Evolution API
const ENABLE_TELEGRAM    = process.env.ENABLE_TELEGRAM !== "false"; // default on
const ENABLE_WHATSAPP    = process.env.ENABLE_WHATSAPP === "true";  // default off
const WA_WEBHOOK_SECRET  = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const WA_OWNER_NUMBER    = (process.env.WHATSAPP_ALLOWED_NUMBER || "").replace(/\D/g, "");

const WEBHOOK_PATH    = "/webhook/telegram";
const WA_WEBHOOK_PATH = WA_WEBHOOK_SECRET
  ? `/webhook/whatsapp/${WA_WEBHOOK_SECRET}`
  : "/webhook/whatsapp";

if (!TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

// Process-level safety net. Background sockets (IMAP, SMTP) can emit late
// 'error' events long after the originating call returned. Without these
// handlers an unhandled emit crashes the container and Railway loops the
// deploy. The webhook server must stay up so Telegram can reach us.
process.on("uncaughtException", (err) => {
  console.error(`[process] uncaughtException: ${err?.message}`);
  if (err?.stack) console.error(err.stack.split("\n").slice(0, 6).join("\n"));
});
process.on("unhandledRejection", (reason) => {
  console.error(`[process] unhandledRejection: ${reason?.message || reason}`);
});

// Bot client without polling — we drive it via webhook
const bot = new TelegramBot(TOKEN, { polling: false });

// ─── Shared message handler ──────────────────────────────────────────────────
//
// Both Telegram and WhatsApp produce the same shape after their channel layer:
//   { channel: "telegram" | "whatsapp", chatId, text, replyTo }
// `replyTo` is an async (text) => any function the channel layer provides so
// the agent doesn't have to know about Telegram/WhatsApp send semantics.

async function handleIncomingMessage({ channel, chatId, text, replyTo }) {
  try {
    const reply = await runAgent(text, { channel });
    await replyTo(reply);
  } catch (err) {
    console.error(`[agent] (${channel}) error:`, err);
    try { await replyTo("⚠️ Error procesando tu mensaje. Mira los logs."); } catch {}
  }
}

// ─── Telegram message router ─────────────────────────────────────────────────

async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id.toString();
  if (chatId !== CHAT_ID) {
    console.log(`[bot] ignored chat ${chatId}`);
    return;
  }

  // Document upload — bank statement (CSV or PDF)
  if (msg.document) {
    return handleDocument(msg);
  }

  const text = msg.text?.trim();
  if (!text) return;

  await bot.sendChatAction(chatId, "typing").catch(() => {});

  // Dev alias: "/wa <text>" lets you test the whatsapp routing without scanning
  // the QR. The message is processed with channel=whatsapp (so it's tagged in
  // the DB and `runAgent` sees the right channel), but the reply still comes
  // back to Telegram since that's where you sent it from.
  const waPrefix = text.match(/^\/wa(?:\s+([\s\S]+))?$/);
  if (waPrefix) {
    const body = (waPrefix[1] || "").trim();
    if (!body) {
      await bot.sendMessage(chatId, "Usage: /wa <message>");
      return;
    }
    return handleIncomingMessage({
      channel: "whatsapp",
      chatId:  WA_OWNER_NUMBER || "test",
      text:    body,
      replyTo: (reply) => bot.sendMessage(chatId, `[wa-test]\n${reply}`)
                            .catch(() => bot.sendMessage(chatId, reply)),
    });
  }

  return handleIncomingMessage({
    channel: "telegram",
    chatId,
    text,
    replyTo: async (reply) => {
      try {
        await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
      } catch (err) {
        console.warn("[bot] markdown send failed, retrying plain:", err.message);
        await bot.sendMessage(chatId, reply);
      }
    },
  });
}

// ─── WhatsApp message router ─────────────────────────────────────────────────

async function handleWhatsAppEvent(body) {
  const parsed = parseEvolutionWebhook(body);
  if (!parsed) return; // not a text message we care about
  if (parsed.fromMe) return; // echo of our own outbound — ignore

  if (!isAllowedSender(parsed.from)) {
    console.log(`[whatsapp] ignored sender ${parsed.from}`);
    return;
  }

  return handleIncomingMessage({
    channel: "whatsapp",
    chatId:  parsed.from,
    text:    parsed.text,
    replyTo: async (reply) => {
      const r = await sendWhatsApp(parsed.from, reply);
      if (!r.ok) console.warn(`[whatsapp] reply send failed: ${r.error}`);
    },
  });
}

async function handleDocument(msg) {
  const chatId = msg.chat.id.toString();
  const doc    = msg.document;
  const name   = (doc.file_name || "upload").toLowerCase();
  const isCsv  = name.endsWith(".csv");
  const isPdf  = name.endsWith(".pdf");

  if (!isCsv && !isPdf) {
    await bot.sendMessage(chatId, "📎 Solo soporto CSV o PDF de bank statements por ahora.");
    return;
  }

  await bot.sendMessage(chatId, `📥 Recibido *${doc.file_name}*. Procesando...`, { parse_mode: "Markdown" });

  let tmpPath;
  try {
    const fileLink = await bot.getFileLink(doc.file_id);
    const buffer   = await fetch(fileLink).then((r) => r.arrayBuffer());
    tmpPath        = path.join(os.tmpdir(), `${Date.now()}-${doc.file_name}`);
    fs.writeFileSync(tmpPath, Buffer.from(buffer));

    const result = isCsv ? await importCsv(tmpPath) : await importPdf(tmpPath);

    await bot.sendMessage(chatId,
      `✅ *${doc.file_name}*\n` +
      `• Insertadas: ${result.inserted}\n` +
      `• Saltadas (duplicados): ${result.skipped}\n` +
      `• Errores: ${result.errors}\n` +
      (result.total ? `• Total filas: ${result.total}` : ""),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("[upload] error:", err);
    await bot.sendMessage(chatId, `⚠️ Error procesando el archivo: ${err.message}`);
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => res.json({ status: "MVP-Assistant running" }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Visibility into the DB without needing Telegram round-trips. No auth — it
// only reads aggregates (no PII, no full transaction list), and the URL is
// public-domain-only. If that becomes a concern later, gate behind ?key=...
app.get("/debug/stats", (_req, res) => {
  try {
    const tx          = getTransactionStats();
    const bySource    = db.prepare(`SELECT source, COUNT(*) AS n FROM transactions GROUP BY source`).all();
    const bySign      = db.prepare(`
      SELECT
        SUM(CASE WHEN amount<0 THEN 1 ELSE 0 END) AS outflows,
        SUM(CASE WHEN amount>0 THEN 1 ELSE 0 END) AS inflows,
        SUM(CASE WHEN amount=0 THEN 1 ELSE 0 END) AS zeros
      FROM transactions
    `).get();
    const byMonth     = db.prepare(`
      SELECT
        strftime('%Y-%m', date) AS month,
        COUNT(*)                 AS count,
        ROUND(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END), 2) AS expenses,
        ROUND(SUM(CASE WHEN amount>0 THEN amount       ELSE 0 END), 2) AS income
      FROM transactions
      GROUP BY month ORDER BY month DESC LIMIT 12
    `).all();
    const sample      = db.prepare(`SELECT date, merchant, amount, currency, category, source FROM transactions ORDER BY id DESC LIMIT 10`).all();
    const taskCount   = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n;
    const projCount   = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get().n;
    const msgCount    = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
    const dbPath      = process.env.DB_PATH || "./data/pm.db";
    res.json({
      db_path:    dbPath,
      transactions: { ...tx, by_source: bySource, by_sign: bySign, by_month: byMonth, latest_10: sample },
      tasks:      taskCount,
      projects:   projCount,
      messages:   msgCount,
      spend_pace: getSpendPace(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inspection: list the transactions in a given category for a period, sorted
// by amount. Use it to figure out what's polluting 'other' so we can add
// keyword rules.
app.get("/debug/category-detail", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  const category = (req.query.category || "other").toString();
  const period   = (req.query.period   || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : null;
  try {
    const rows = period
      ? db.prepare(`SELECT date, merchant, amount, currency, source FROM transactions WHERE category = ? AND strftime('%Y-%m', date) = ? ORDER BY ABS(amount) DESC LIMIT 200`).all(category, period)
      : db.prepare(`SELECT date, merchant, amount, currency, source FROM transactions WHERE category = ? ORDER BY ABS(amount) DESC LIMIT 200`).all(category);
    const total = rows.reduce((s, r) => s + Math.abs(r.amount), 0);
    res.json({ category, period, count: rows.length, total: Math.round(total * 100) / 100, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-apply the current keyword categorizer to every transaction in a period
// (or all-time if period omitted). Only rows whose new category differs from
// the stored one are updated. No LLM cost — pure SQL + regex.
app.post("/api/recategorize", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  const period = (req.query.period || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : null;
  try {
    const rows = period
      ? db.prepare(`SELECT id, merchant, description, category FROM transactions WHERE strftime('%Y-%m', date) = ?`).all(period)
      : db.prepare(`SELECT id, merchant, description, category FROM transactions`).all();
    const upd = db.prepare(`UPDATE transactions SET category = ? WHERE id = ?`);
    let changed = 0;
    const changes = {};
    for (const r of rows) {
      const newCat = keywordCategorize(r.description || r.merchant || "");
      if (newCat === r.category) continue;
      // Guard: never DOWNGRADE a specific category to 'other' just because the
      // regex didn't match. The existing tag was likely set by an LLM bulk
      // recategorize or by the user manually — both more authoritative than
      // the regex fallback.
      if (newCat === "other" && r.category && r.category !== "other" && r.category !== "uncategorised") continue;
      upd.run(newCat, r.id);
      changed++;
      const key = `${r.category || "(null)"} → ${newCat}`;
      changes[key] = (changes[key] || 0) + 1;
    }
    res.json({ period: period || "all", scanned: rows.length, changed, changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Budget dashboard ───────────────────────────────────────────────────────
// Replaces the manual "Cuentas MVP" Google Sheet. Single-user, key-gated.
// HTML shell + Chart.js + JSON API, all served from the same Express app.

app.get("/dashboard", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  const period = (req.query.period || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : null;
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderDashboard(period));
});

app.get("/api/dashboard.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const period = (req.query.period || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : undefined;
    const summary = getDashboardSummary(period);
    const periods = listBudgetPeriods();
    res.json({ ...summary, available_periods: periods });
  } catch (err) {
    console.error("[dashboard json]", err);
    res.status(500).json({ error: err.message });
  }
});

// Annual / YTD consolidated view. ?year=YYYY (default: current year).
app.get("/api/year.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const year = (req.query.year || "").toString().match(/^\d{4}$/) ? req.query.year : undefined;
    res.json({ ...getYearSummary(year), available_years: listYears() });
  } catch (err) {
    console.error("[year json]", err);
    res.status(500).json({ error: err.message });
  }
});

// Set or clear the match_keyword on a fixed_expense across all periods sharing
// the same label. Called by the dashboard's keyword-edit modal.
// If mode === 'append', the merchant_snippet is regex-escaped and appended
// (used by the audit modal "asignar [merchant] a [fijo]" flow).
app.post("/api/match-keyword", express.json({ limit: "10kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { label, match_keyword, period, mode, merchant_snippet, target } = req.body || {};
    if (!label) return res.status(400).json({ error: "label required" });
    const tgt = target === "variable" ? "variable" : "fixed";
    if (mode === "append") {
      const updated = appendToMatchKeyword({ label, merchant_snippet, period, target: tgt });
      return res.json({ ok: true, updated });
    }
    if (match_keyword) {
      try { new RegExp(match_keyword, "i"); }
      catch (e) { return res.status(400).json({ error: "invalid regex: " + e.message }); }
    }
    const updated = setMatchKeyword({ label, match_keyword: match_keyword || null, period, target: tgt });
    res.json({ ok: true, updated });
  } catch (err) {
    console.error("[match-keyword]", err);
    res.status(500).json({ error: err.message });
  }
});

// Consolidated month-by-month view of all 3 accounts (BNP/Amex/Revolut)
app.get("/api/consolidated.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const months = parseInt(req.query.months || "12", 10);
    res.json(getConsolidatedHistory({ months }));
  } catch (err) {
    console.error("[consolidated]", err);
    res.status(500).json({ error: err.message });
  }
});

// Cash-flow for an account in a period (opening + credits - debits = closing)
app.get("/api/cashflow.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const account = (req.query.account || "bnp").toString();
    const period  = (req.query.period  || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : undefined;
    res.json(getAccountCashflow({ account, period }));
  } catch (err) {
    console.error("[cashflow]", err);
    res.status(400).json({ error: err.message });
  }
});

// Set/update an account's opening or closing balance for a period.
// Body: { account: "bnp", period: "2026-04", opening_eur?: 1234.56, closing_eur?: 2345.67 }
app.post("/api/account-balance", express.json({ limit: "10kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const row = setAccountBalance(req.body || {});
    res.json({ ok: true, row });
  } catch (err) {
    console.error("[account-balance]", err);
    res.status(400).json({ error: err.message });
  }
});

// Change category on one or many transactions.
// Body: { ids: [1, 2, 3], category: "income" }
app.post("/api/transactions/category", express.json({ limit: "100kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { ids, category } = req.body || {};
    const changed = updateTransactionCategory({ ids, category });
    res.json({ ok: true, changed });
  } catch (err) {
    console.error("[tx category]", err);
    res.status(400).json({ error: err.message });
  }
});

// Pending items — receivables, payables, reimbursements (no account binding).
app.get("/api/pending.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const include_settled = req.query.include_settled === "1";
    res.json(listPendingItems({ include_settled }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/pending", express.json({ limit: "50kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { op, payload } = req.body || {};
    if (op === "delete") {
      if (!payload || !payload.id) return res.status(400).json({ error: "id required" });
      return res.json(deletePendingItem(payload.id));
    }
    if (op === "settle") {
      if (!payload || !payload.id) return res.status(400).json({ error: "id required" });
      return res.json({ ok: true, row: upsertPendingItem({ id: payload.id, status: "settled" }) });
    }
    // create or update (id present → update)
    const row = upsertPendingItem(payload || {});
    res.json({ ok: true, row });
  } catch (err) {
    console.error("[pending mutate]", err);
    res.status(400).json({ error: err.message });
  }
});

// Two-pass reconciliation:
//   1. All is_internal_transfer=1 rows → category='internal_transfer'
//   2. For each fixed_expense with category + match_keyword, find tx matches
//      and rewrite their raw category to match the fixed's category. Fixes the
//      drilldown bug where rent is tagged 'transfers' but credited to housing
//      via attribution — the drilldown query expects category='housing'.
// Idempotent: run any time the data drifts.
app.post("/api/reconcile-categories", express.json({ limit: "10kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const dry = !!(req.body && req.body.dry_run);
    const out = { internal: 0, fixed_claims: 0, by_label: {} };
    // Pass 1: internal transfers
    if (dry) {
      out.internal = db.prepare(`
        SELECT COUNT(*) AS n FROM transactions
        WHERE is_internal_transfer = 1 AND (category IS NULL OR category != 'internal_transfer')
      `).get().n;
    } else {
      out.internal = db.prepare(`
        UPDATE transactions SET category = 'internal_transfer'
        WHERE is_internal_transfer = 1 AND (category IS NULL OR category != 'internal_transfer')
      `).run().changes;
    }
    // Pass 2: claim-based reassignment per fixed_expense
    const fixedLines = db.prepare(`
      SELECT label, category, match_keyword FROM fixed_expenses
      WHERE category IS NOT NULL AND match_keyword IS NOT NULL AND match_keyword != ''
    `).all();
    const seen = new Set();
    for (const f of fixedLines) {
      const key = f.label + "|" + f.category + "|" + f.match_keyword;
      if (seen.has(key)) continue;
      seen.add(key);
      let rx;
      try { rx = new RegExp(f.match_keyword, "i"); } catch { continue; }
      // Find candidates (negative amount, not internal, not already in target cat)
      const cands = db.prepare(`
        SELECT id, merchant, description, category FROM transactions
        WHERE amount < 0 AND is_internal_transfer = 0 AND (category IS NULL OR category != ?)
      `).all(f.category);
      const ids = [];
      for (const tx of cands) {
        if (rx.test(tx.merchant || "") || rx.test(tx.description || "")) ids.push(tx.id);
      }
      if (!ids.length) continue;
      out.by_label[f.label] = { category: f.category, count: ids.length };
      out.fixed_claims += ids.length;
      if (!dry) {
        const stmt = db.prepare(`UPDATE transactions SET category = ? WHERE id = ?`);
        const tx   = db.transaction((arr) => { for (const id of arr) stmt.run(f.category, id); });
        tx(ids);
      }
    }
    res.json({ ok: true, dry_run: dry, ...out });
  } catch (err) {
    console.error("[reconcile]", err);
    res.status(500).json({ error: err.message });
  }
});

// Update category and/or is_internal_transfer on transactions whose merchant
// or description contains a literal substring (case-insensitive). Used for
// one-shot fixes: re-classify Carlos as health, flag PRELEVEMENT AUTOMATIQUE
// as internal transfer, etc.
// Body: { needle, category?, is_internal_transfer?, dry_run? }
app.post("/api/transactions/update-by-text", express.json({ limit: "10kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { needle, category, is_internal_transfer, dry_run } = req.body || {};
    if (!needle || typeof needle !== "string") return res.status(400).json({ error: "needle required" });
    const like = "%" + needle.toLowerCase() + "%";
    const matched = db.prepare(`
      SELECT id, date, merchant, description, amount, category, is_internal_transfer
      FROM transactions
      WHERE LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?
      LIMIT 500
    `).all(like, like);
    if (dry_run) return res.json({ ok: true, dry_run: true, would_update: matched.length, sample: matched.slice(0, 10) });
    const sets = [];
    const args = [];
    if (category !== undefined)             { sets.push("category = ?");             args.push(category); }
    if (is_internal_transfer !== undefined) { sets.push("is_internal_transfer = ?"); args.push(is_internal_transfer ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ error: "nothing to update — set category and/or is_internal_transfer" });
    args.push(like, like);
    const r = db.prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?`).run(...args);
    res.json({ ok: true, updated: r.changes, sample: matched.slice(0, 10) });
  } catch (err) {
    console.error("[tx update-by-text]", err);
    res.status(500).json({ error: err.message });
  }
});

// Delete transactions whose merchant matches a regex. Used to clean up
// duplicates that snuck in before a parser fix (e.g. Amex→Revolut top-ups
// loaded before AMEX_INTERNAL_TX_RX was added).
// Body: { merchant_regex: "revolut", source?: "csv" }  (regex case-insensitive)
app.post("/api/transactions/delete-by-merchant", express.json({ limit: "10kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { merchant_regex, source } = req.body || {};
    if (!merchant_regex) return res.status(400).json({ error: "merchant_regex required" });
    try { new RegExp(merchant_regex, "i"); }
    catch (e) { return res.status(400).json({ error: "invalid regex: " + e.message }); }
    // SQLite REGEXP needs an extension; use GLOB-ish LIKE on lowercased substring instead.
    // For safety, only allow a simple literal substring delete here.
    const literal = merchant_regex.replace(/[%_]/g, "");
    const sourceFilter = source ? "AND source = ?" : "";
    const args = source ? [`%${literal.toLowerCase()}%`, source] : [`%${literal.toLowerCase()}%`];
    // Preview first
    const matched = db.prepare(`SELECT id, date, merchant, amount, source FROM transactions WHERE LOWER(merchant) LIKE ? ${sourceFilter} LIMIT 500`).all(...args);
    if (req.query.dryRun === "1") return res.json({ ok: true, dryRun: true, would_delete: matched.length, sample: matched.slice(0, 10) });
    const r = db.prepare(`DELETE FROM transactions WHERE LOWER(merchant) LIKE ? ${sourceFilter}`).run(...args);
    res.json({ ok: true, deleted: r.changes, sample: matched.slice(0, 5) });
  } catch (err) {
    console.error("[tx delete]", err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk LLM-categorize transactions currently tagged 'other' (or any category
// via ?from=other). Dedups by merchant so we only ask the LLM about each
// distinct name once. Returns count of rows updated.
// Body: { period?: "YYYY-MM", from?: "other" (default), dry_run?: true }
app.post("/api/bulk-recategorize", express.json({ limit: "10kb" }), async (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { period, from = "other", dry_run = false } = req.body || {};
    const periodFilter = period && /^\d{4}-\d{2}$/.test(period) ? `AND strftime('%Y-%m', date) = ?` : "";
    const args = periodFilter ? [from, period] : [from];

    // Distinct merchants in 'from' category
    const merchants = db.prepare(`
      SELECT merchant, COUNT(*) AS n, ROUND(SUM(ABS(amount)),2) AS total
      FROM transactions
      WHERE category = ? ${periodFilter} AND merchant IS NOT NULL AND merchant != ''
      GROUP BY merchant ORDER BY total DESC
    `).all(...args);

    if (!merchants.length) return res.json({ ok: true, merchants_scanned: 0, rows_updated: 0 });
    console.log(`[bulk-recat] ${merchants.length} distinct merchants in '${from}' for ${period || "all"}`);

    // Import here to avoid circular import problems on boot
    const { callLLMText } = await import("./llm.js");
    const CATS = ["groceries","restaurants","transport","travel","subscriptions","shopping","health","housing","entertainment","transfers","internal_transfer","savings","debt","income","fees","other"];

    const merchantToCat = {};
    const BATCH = 25;
    for (let i = 0; i < merchants.length; i += BATCH) {
      const batch = merchants.slice(i, i + BATCH);
      const prompt = `Categorize each merchant into EXACTLY ONE of: ${CATS.join(", ")}.
Return STRICT JSON array of same length and order: [{"merchant":"...","category":"..."}].
Use 'other' only when truly ambiguous (person names without context, unknown abbreviations).
- food/cafe/restaurant chains → restaurants
- supermarkets → groceries
- Uber/Bolt/Cabify/Metro/Vélib → transport
- flights/hotels/Airbnb → travel
- Netflix/Spotify/Claude.ai/Google subscriptions → subscriptions
- electronics/clothes → shopping
- pharmacies/medical → health
- rent/utilities/internet/insurance → housing or fees (utilities=housing, insurance=fees)
- bank fees/commissions → fees
- bank transfers to other people → transfers
- loan payments → deuda
- salary → income

Merchants:
${batch.map((m, j) => `${j+1}. ${m.merchant}`).join("\n")}`;

      try {
        const text = await callLLMText({
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2000, temperature: 0.1,
        });
        const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        const parsed = JSON.parse(cleaned);
        for (const item of parsed) {
          if (item.merchant && item.category && CATS.includes(item.category)) {
            merchantToCat[item.merchant] = item.category;
          }
        }
      } catch (err) {
        console.error(`[bulk-recat] batch ${i} failed: ${err.message}`);
      }
    }

    // Apply updates
    let rowsUpdated = 0;
    const transitions = {};
    if (!dry_run) {
      const upd = db.prepare(`UPDATE transactions SET category = ? WHERE merchant = ? AND category = ? ${periodFilter}`);
      for (const [merchant, newCat] of Object.entries(merchantToCat)) {
        if (newCat === from) continue; // no change
        const updateArgs = periodFilter ? [newCat, merchant, from, period] : [newCat, merchant, from];
        const r = upd.run(...updateArgs);
        rowsUpdated += r.changes;
        const key = `${from} → ${newCat}`;
        transitions[key] = (transitions[key] || 0) + r.changes;
      }
    }

    res.json({
      ok: true,
      period: period || "all",
      merchants_scanned: merchants.length,
      merchants_recategorised: Object.keys(merchantToCat).length,
      rows_updated: rowsUpdated,
      transitions,
      dry_run,
      sample_assignments: Object.entries(merchantToCat).slice(0, 20).map(([m, c]) => ({ merchant: m, category: c })),
    });
  } catch (err) {
    console.error("[bulk-recat]", err);
    res.status(500).json({ error: err.message });
  }
});

// Audit report for a period: orphan transactions, conflicts, and what each
// fixed line claimed. Used by the dashboard audit modal.
app.get("/api/audit.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const period = (req.query.period || "").toString().match(/^\d{4}-\d{2}$/) ? req.query.period : undefined;
    res.json(getAuditReport(period));
  } catch (err) {
    console.error("[audit]", err);
    res.status(500).json({ error: err.message });
  }
});

// Per-category drilldown. ?category=travel&period=2026-05 or &period=2026
// (year). Returns all transactions in that category sorted by amount.
// Flat transactions list for the Histórico editor.
// ?period=YYYY-MM (optional, defaults to all-time) &search=foo &limit=500
app.get("/api/transactions.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const period      = (req.query.period      || "").toString().match(/^\d{4}(-\d{2})?$/) ? req.query.period      : undefined;
    const period_from = (req.query.period_from || "").toString().match(/^\d{4}-\d{2}$/)    ? req.query.period_from : undefined;
    const period_to   = (req.query.period_to   || "").toString().match(/^\d{4}-\d{2}$/)    ? req.query.period_to   : undefined;
    const search      = (req.query.search      || "").toString().trim() || undefined;
    const accounts    = (req.query.accounts    || "").toString().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const limit       = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);
    res.json(listAllTransactions({ period, period_from, period_to, accounts, search, limit }));
  } catch (err) {
    console.error("[transactions.json]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/category.json", (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const category = (req.query.category || "").toString();
    const period   = (req.query.period   || "").toString();
    if (!category) return res.status(400).json({ error: "category required" });
    res.json(listCategoryTransactions({ category, period: period || undefined }));
  } catch (err) {
    console.error("[category json]", err);
    res.status(500).json({ error: err.message });
  }
});

// Single mutation endpoint — body picks which table.
// kind: 'income' | 'fixed' | 'variable' | 'debt' | 'fx'
app.post("/api/budget", express.json({ limit: "100kb" }), (req, res) => {
  if (!requireKey(req, res, "DASH_KEY")) return;
  try {
    const { period, kind, payload, op } = req.body || {};
    if (!kind || !payload) return res.status(400).json({ error: "kind + payload required" });
    if (op === "delete") {
      const r = deleteBudgetRow({ kind, label: payload.label, period: payload.period || period });
      return res.json(r);
    }
    let row;
    switch (kind) {
      case "income":   row = upsertIncome({ period, ...payload });          break;
      case "fixed":    row = upsertFixedExpense({ period, ...payload });    break;
      case "variable": row = insertVariableExpense({ period, ...payload }); break;
      case "debt":     row = upsertDebt({ period, ...payload });            break;
      case "fx":       row = setFxRate(period, payload);                    break;
      case "category": row = upsertCategoryBudget({ period, ...payload });  break;
      case "copy_categories":
        row = copyCategoryBudgets({ srcPeriod: payload.srcPeriod, dstPeriod: period });
        break;
      default: return res.status(400).json({ error: `unknown kind: ${kind}` });
    }
    res.json({ ok: true, row });
  } catch (err) {
    console.error("[budget mutate]", err);
    res.status(500).json({ error: err.message });
  }
});

// Shared key-gate for non-Telegram endpoints. Same pattern for /import/* and
// /api/* and /dashboard — keeps the auth surface small and consistent.
function requireKey(req, res, envName) {
  const expected = process.env[envName];
  if (!expected) {
    res.status(503).json({ error: `${envName} not set on server` });
    return false;
  }
  if (req.query.key !== expected) {
    res.status(403).json({ error: "invalid key" });
    return false;
  }
  return true;
}

// One-shot bulk import. Accepts the pre-normalized CSV produced by
// scripts/import-local.mjs. Guarded by INTERNAL_IMPORT_KEY env var — we don't
// want random callers stuffing rows into the spending DB.
//
// Usage:
//   curl -sf https://<host>/import/normalized?key=$KEY \
//     -H "content-type: text/csv" \
//     --data-binary @scripts/normalized-transactions.csv
// Single-PDF upload — sends one bank statement through the same Gemini-based
// parser as the Telegram document handler. Useful for bulk-loading historic
// statements with a local script that iterates a folder.
app.post("/import/pdf", express.raw({ type: "application/pdf", limit: "20mb" }), async (req, res) => {
  if (!requireKey(req, res, "INTERNAL_IMPORT_KEY")) return;
  let tmpPath;
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
    tmpPath = path.join(os.tmpdir(), `pdfimport-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, req.body);
    const stats = await importPdf(tmpPath);
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error("[import/pdf]", err);
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch {} }
  }
});

app.post("/import/normalized", express.text({ type: "*/*", limit: "20mb" }), async (req, res) => {
  if (!requireKey(req, res, "INTERNAL_IMPORT_KEY")) return;
  try {
    const tmpPath = path.join(os.tmpdir(), `normalized-${Date.now()}.csv`);
    fs.writeFileSync(tmpPath, req.body || "");
    const stats = importNormalized(tmpPath);
    fs.unlinkSync(tmpPath);
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error("[import/normalized]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post(WEBHOOK_PATH, async (req, res) => {
  if (WEBHOOK_SECRET) {
    const provided = req.header("x-telegram-bot-api-secret-token") || "";
    if (provided !== WEBHOOK_SECRET) {
      console.warn("[webhook] rejected: invalid secret");
      return res.status(403).json({ error: "invalid secret" });
    }
  }

  // Always return 200 fast — process in background so Telegram doesn't retry
  res.json({ ok: true });
  handleTelegramUpdate(req.body).catch((err) => {
    console.error("[webhook] handler crashed:", err);
  });
});

// WhatsApp via Evolution API. The secret (if set) is in the path, not a header,
// because some Evolution versions don't let you add custom headers to webhooks.
// The endpoint is registered unconditionally — Evolution's instance just won't
// have a target if ENABLE_WHATSAPP=false, in which case no events arrive.
app.post(WA_WEBHOOK_PATH, async (req, res) => {
  res.json({ ok: true });
  if (!ENABLE_WHATSAPP) return;
  handleWhatsAppEvent(req.body).catch((err) => {
    console.error("[whatsapp webhook] handler crashed:", err);
  });
});

// ─── Webhook self-registration ───────────────────────────────────────────────

async function registerWebhook() {
  if (!PUBLIC_DOMAIN) {
    console.warn("[webhook] RAILWAY_PUBLIC_DOMAIN not set — skipping registration. " +
                 "Generate a public domain in Railway → Settings → Networking.");
    return;
  }
  const url     = `https://${PUBLIC_DOMAIN}${WEBHOOK_PATH}`;
  const payload = { url, drop_pending_updates: true };
  if (WEBHOOK_SECRET) payload.secret_token = WEBHOOK_SECRET;

  try {
    await bot.setWebHook(url, {
      drop_pending_updates: true,
      ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {}),
    });
    console.log(`[webhook] registered at ${url}`);
  } catch (err) {
    console.error("[webhook] registration failed:", err.message);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

// Fan-out a notification to all enabled outbound channels. Errors on one
// channel never block the other — finance/PM notifications are too important
// to lose because, say, the WhatsApp number got temporarily banned.
async function broadcast(text, { markdown = true } = {}) {
  const tasks = [];
  if (ENABLE_TELEGRAM && CHAT_ID) {
    tasks.push(
      bot.sendMessage(CHAT_ID, text, markdown ? { parse_mode: "Markdown" } : {})
         .catch((err) => bot.sendMessage(CHAT_ID, text).catch(() =>
           console.error("[broadcast] telegram failed:", err.message)
         ))
    );
  }
  if (ENABLE_WHATSAPP && WA_OWNER_NUMBER && isWhatsAppConfigured()) {
    tasks.push(
      sendWhatsApp(WA_OWNER_NUMBER, text).then((r) => {
        if (!r.ok) console.warn(`[broadcast] whatsapp failed: ${r.error}`);
      })
    );
  }
  await Promise.allSettled(tasks);
}

function startScheduler() {
  // Hourly: pull bank emails and parse new transactions
  cron.schedule("5 * * * *", async () => {
    console.log("[cron] inbox scan — starting");
    try {
      const stats = await fetchAndParseRecent({ daysBack: 1 });
      console.log("[cron] inbox scan done", stats);
    } catch (err) {
      console.error("[cron] inbox scan failed:", err.message);
    }
  });

  // Daily 8:00 Paris — briefing
  cron.schedule("0 8 * * *", async () => {
    try {
      const reply = await runAgent("Dame el briefing del día. (1) Llama list_calendar_events (days_ahead 1) para eventos de hoy y mañana — menciónalos primero con hora y ubicación si aplica. (2) Tareas vencidas y urgentes esta semana. (3) Llama spend_pace y resume: gasto del mes hasta hoy, proyección fin de mes vs mes pasado, y top 3 categorías con su delta % vs el mismo periodo del mes anterior.");
      await broadcast(`📋 *Briefing del día*\n\n${reply}`);
    } catch (err) { console.error("[cron] daily briefing:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Daily 9:00 Paris — follow-ups for tasks due in next 48h
  cron.schedule("0 9 * * *", async () => {
    try {
      const due = getTasksDueSoon(2);
      if (!due.length) return;
      const lines = due.map((t) =>
        `⚡ *${t.title}* (${t.project_name || "sin proyecto"}) — vence ${t.due_date} · ${t.priority}`
      );
      await broadcast(`*Follow-ups próximas 48h*\n\n${lines.join("\n")}`);
    } catch (err) { console.error("[cron] follow-ups:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Proactive scan — every 2h between 08:00 and 22:00 Paris. The agent decides
  // on its own whether to interrupt; we only broadcast if interrupt=true.
  cron.schedule("0 8,10,12,14,16,18,20,22 * * *", async () => {
    try {
      const decision = await runProactiveScan();
      console.log(`[cron] proactive scan — interrupt=${decision.interrupt} why=${decision.why}`);
      if (decision.interrupt && decision.message) {
        await broadcast(`🛎️ ${decision.message}`);
      }
    } catch (err) { console.error("[cron] proactive scan:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Monthly FX refresh — 1st of month, 06:00 Paris. Auto rates never overwrite
  // manual ones (setFxRate skips when existing source='manual').
  cron.schedule("0 6 1 * *", async () => {
    try { await refreshCurrentMonthFx(setFxRate); }
    catch (err) { console.error("[cron] fx refresh:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Sunday 10:00 Paris — Revolut CSV upload nudge.
  // Revolut killed per-transaction email alerts, so the only way to ingest its
  // transactions in-month is via manual CSV/PDF upload. This reminder lands
  // before the 18:00 weekly review so the data is fresh when the review runs.
  cron.schedule("0 10 * * 0", async () => {
    try {
      await broadcast(
        "💳 *Revolut weekly upload*\n\n" +
        "Sube el CSV de Revolut de esta semana para que el weekly review de las 18:00 tenga los gastos al día.\n\n" +
        "App Revolut → avatar → Statements → cuenta → últimos 7 días → Excel/CSV → compartir al bot."
      );
    } catch (err) { console.error("[cron] revolut nudge:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Sunday 18:00 Paris — weekly review
  cron.schedule("0 18 * * 0", async () => {
    try {
      const reply = await runAgent("Hazme el weekly review. Llama list_calendar_events (days_ahead 7) para los eventos de la próxima semana — inclúyelos. Luego: qué completé, qué bloqueado, prioridades próxima semana, y desglose de gasto de la semana.");
      await broadcast(`📊 *Weekly Review*\n\n${reply}`);
    } catch (err) { console.error("[cron] weekly review:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Sunday 19:00 Paris — CFO weekly briefing (after the weekly review at 18:00).
  // Single LLM call via advisor.js, deterministic snapshot + structured advice.
  cron.schedule("0 19 * * 0", async () => {
    try {
      const text = await runWeeklyAdvisorBriefing();
      await broadcast(text);
    } catch (err) { console.error("[cron] cfo weekly:", err.message); }
  }, { timezone: "Europe/Paris" });

  console.log("[scheduler] started — hourly inbox scan + daily/weekly briefings + sunday revolut nudge + 2h proactive scan + monthly FX + sunday 19:00 CFO");

  // Boot kick: scan inbox 30s after startup so each redeploy gives quick feedback
  setTimeout(async () => {
    try {
      const stats = await fetchAndParseRecent({ daysBack: 2 });
      console.log("[boot] inbox scan", stats);
    } catch (err) { console.error("[boot] inbox scan failed:", err.message); }
  }, 30_000);

  // Boot kick: if no FX rate exists for current month, fetch one. Idempotent on
  // every redeploy because setFxRate respects manual entries.
  setTimeout(async () => {
    try {
      if (!getFxRate(new Date().toISOString().slice(0, 7))) {
        await refreshCurrentMonthFx(setFxRate);
      }
    } catch (err) { console.error("[boot] fx refresh failed:", err.message); }
  }, 45_000);
}

// ─── Optional one-shot historical email backfill ─────────────────────────────

async function maybeBackfill() {
  if (!BACKFILL_ON_BOOT) return;
  const days = parseInt(BACKFILL_ON_BOOT, 10);
  if (!days || days <= 0) return;
  console.log(`[backfill] scanning last ${days} days of inbox...`);
  try {
    const stats = await backfillEmails({ daysBack: days });
    console.log("[backfill] done", stats);
  } catch (err) {
    console.error("[backfill] failed:", err.message);
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[http] listening on :${PORT}`);
  if (ENABLE_WHATSAPP) {
    if (isWhatsAppConfigured()) {
      const masked = WA_WEBHOOK_SECRET ? "/webhook/whatsapp/<secret>" : "/webhook/whatsapp";
      console.log(`[whatsapp] enabled — webhook ${masked} · owner ${WA_OWNER_NUMBER || "(any)"}`);
    } else {
      console.warn("[whatsapp] ENABLE_WHATSAPP=true but EVOLUTION_* env vars missing — outbound disabled");
    }
  }
  await registerWebhook();
  startScheduler();
  maybeBackfill();
});

process.on("SIGINT", () => { console.log("Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("Shutting down..."); process.exit(0); });
