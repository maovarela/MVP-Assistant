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
import { importCsv, importPdf } from "./transactions.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const TOKEN              = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID            = process.env.TELEGRAM_CHAT_ID?.trim();
const PORT               = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DOMAIN      = process.env.RAILWAY_PUBLIC_DOMAIN;
const WEBHOOK_SECRET     = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const BACKFILL_ON_BOOT   = process.env.EMAIL_BACKFILL_DAYS;

const WEBHOOK_PATH = "/webhook/telegram";

if (!TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

// Bot client without polling — we drive it via webhook
const bot = new TelegramBot(TOKEN, { polling: false });

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

  try {
    const reply = await runAgent(text);
    await bot.sendMessage(chatId, reply, { parse_mode: "Markdown" })
             .catch(async (err) => {
               // Markdown parse failure → retry plain
               console.warn("[bot] markdown send failed, retrying plain:", err.message);
               await bot.sendMessage(chatId, reply);
             });
  } catch (err) {
    console.error("[agent] error:", err);
    await bot.sendMessage(chatId, "⚠️ Error procesando tu mensaje. Mira los logs.");
  }
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
      const reply = await runAgent("Dame el briefing del día: tareas pendientes, vencidas, urgentes esta semana, y resumen breve del gasto del mes hasta ahora.");
      await bot.sendMessage(CHAT_ID, `📋 *Briefing del día*\n\n${reply}`, { parse_mode: "Markdown" });
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
      await bot.sendMessage(CHAT_ID, `*Follow-ups próximas 48h*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
    } catch (err) { console.error("[cron] follow-ups:", err.message); }
  }, { timezone: "Europe/Paris" });

  // Sunday 18:00 Paris — weekly review
  cron.schedule("0 18 * * 0", async () => {
    try {
      const reply = await runAgent("Hazme el weekly review: qué completé, qué bloqueado, prioridades próxima semana, y desglose de gasto de la semana.");
      await bot.sendMessage(CHAT_ID, `📊 *Weekly Review*\n\n${reply}`, { parse_mode: "Markdown" });
    } catch (err) { console.error("[cron] weekly review:", err.message); }
  }, { timezone: "Europe/Paris" });

  console.log("[scheduler] started — hourly inbox scan + daily/weekly briefings");

  // Boot kick: scan inbox 30s after startup so each redeploy gives quick feedback
  setTimeout(async () => {
    try {
      const stats = await fetchAndParseRecent({ daysBack: 2 });
      console.log("[boot] inbox scan", stats);
    } catch (err) { console.error("[boot] inbox scan failed:", err.message); }
  }, 30_000);
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
  await registerWebhook();
  startScheduler();
  maybeBackfill();
});

process.on("SIGINT", () => { console.log("Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("Shutting down..."); process.exit(0); });
