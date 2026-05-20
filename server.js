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
import {
  sendWhatsApp,
  parseEvolutionWebhook,
  isAllowedSender,
  isWhatsAppConfigured,
} from "./whatsapp.js";

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
      const reply = await runAgent("Dame el briefing del día: tareas pendientes, vencidas, urgentes esta semana, y resumen breve del gasto del mes hasta ahora.");
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

  // Sunday 18:00 Paris — weekly review
  cron.schedule("0 18 * * 0", async () => {
    try {
      const reply = await runAgent("Hazme el weekly review: qué completé, qué bloqueado, prioridades próxima semana, y desglose de gasto de la semana.");
      await broadcast(`📊 *Weekly Review*\n\n${reply}`);
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
