// src/index.js
// Entry point — Telegram bot listener + scheduler

import "fs";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import { runAgent } from "./agent.js";
import { getTasksDueSoon, getDailySummary } from "./memory.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

console.log("PM Agent running...");

// ─── Message Handler ──────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id.toString();

  // Only respond to your own chat
  if (chatId !== CHAT_ID) return;

  const text = msg.text?.trim();
  if (!text) return;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

  try {
    const response = await runAgent(text);
    await bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Agent error:", err);
    await bot.sendMessage(chatId, "Error procesando tu mensaje. Revisa los logs.");
  }
});

// ─── Scheduler ────────────────────────────────────────────────────────────────

// Daily briefing — every day at 8:00 AM Paris time
cron.schedule("0 8 * * *", async () => {
  try {
    const response = await runAgent("Dame el resumen del día: qué tengo pendiente, qué está vencido, y qué es urgente esta semana.");
    await bot.sendMessage(CHAT_ID, `📋 *Briefing del día*\n\n${response}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Briefing error:", err);
  }
}, { timezone: "Europe/Paris" });

// Follow-up reminders — every day at 9:00 AM
cron.schedule("0 9 * * *", async () => {
  try {
    const dueSoon = getTasksDueSoon(2);
    if (!dueSoon.length) return;

    const lines = dueSoon.map((t) =>
      `⚡ *${t.title}* (${t.project_name || "sin proyecto"}) — vence ${t.due_date} · ${t.priority}`
    );
    await bot.sendMessage(CHAT_ID, `*Follow-ups próximas 48h*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Follow-up error:", err);
  }
}, { timezone: "Europe/Paris" });

// Weekly review — every Sunday at 6:00 PM
cron.schedule("0 18 * * 0", async () => {
  try {
    const response = await runAgent("Hazme el weekly review: qué completé esta semana, qué está bloqueado, y qué priorizo la próxima semana.");
    await bot.sendMessage(CHAT_ID, `📊 *Weekly Review*\n\n${response}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Weekly review error:", err);
  }
}, { timezone: "Europe/Paris" });

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("Shutting down PM Agent...");
  bot.stopPolling();
  process.exit(0);
});
