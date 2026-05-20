// whatsapp.js
// Evolution API wrapper for WhatsApp messaging.
//
// Evolution API is a self-hosted REST bridge over Baileys (WhatsApp Web
// reverse-engineered). It's not officially supported by Meta — the account
// number can get banned if Meta detects automation patterns. Use a secondary
// number you can afford to lose.
//
// Required env:
//   EVOLUTION_API_URL         e.g. https://evolution-xxx.up.railway.app
//   EVOLUTION_API_KEY         the global API key set when deploying Evolution
//   EVOLUTION_INSTANCE_NAME   e.g. "mvp-assistant" (created via /instance/create)
//
// Optional:
//   WHATSAPP_ALLOWED_NUMBER   digits only (e.g. "33612345678"). If set, inbound
//                             messages from any other number are dropped.
//   WHATSAPP_WEBHOOK_SECRET   shared secret expected in URL path; if set, the
//                             webhook lives at /webhook/whatsapp/:secret.

const BASE     = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
const API_KEY  = process.env.EVOLUTION_API_KEY || "";
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME || "";

export function isWhatsAppConfigured() {
  return Boolean(BASE && API_KEY && INSTANCE);
}

/**
 * Send a text message via Evolution API.
 * @param {string} to    Recipient number — digits only OR full JID. Strip any
 *                       leading "+" and anything after "@" if present.
 * @param {string} text  Message body.
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendWhatsApp(to, text) {
  if (!isWhatsAppConfigured()) {
    return { ok: false, error: "WhatsApp not configured (missing EVOLUTION_* env vars)" };
  }
  const number = String(to || "").replace(/^\+/, "").split("@")[0];
  if (!number) return { ok: false, error: "empty recipient" };

  const url = `${BASE}/message/sendText/${encodeURIComponent(INSTANCE)}`;
  // Evolution v1.x expects { number, textMessage: { text } }. v2 flattens it
  // to { number, text }. We send both shapes — Evolution ignores unknown
  // fields, so this works against either version without sniffing.
  const payload = { number, text, textMessage: { text } };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: API_KEY },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[whatsapp] send failed ${res.status}: ${body.slice(0, 200)}`);
      return { ok: false, status: res.status, error: body.slice(0, 300) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.warn(`[whatsapp] send threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Normalise an Evolution API webhook payload into a simple
 * { from, fromMe, text, messageId, timestamp } shape — or null if the event
 * isn't a text message we should react to.
 *
 * Evolution version drift: the same logical event can arrive at top level
 * ({ event, data: {...} }) or wrapped ({ instance, body: {...} }), and the
 * text can live in conversation, extendedTextMessage.text, or buttonsResponseMessage.
 */
export function parseEvolutionWebhook(body) {
  if (!body || typeof body !== "object") return null;

  const payload = body.data || body.body || body;
  const event   = body.event || payload.event || "";

  // Accept the two events that carry user text. Ignore status updates,
  // connection events, presence, etc. — they'd cost LLM calls for nothing.
  if (!/messages\.upsert|messages\.update/i.test(event)) return null;

  const msg = payload.messages?.[0] || payload.message ? payload : payload.data;
  // Handle the two common shapes flat.
  const m = body.data?.messages?.[0] || body.data || payload.messages?.[0] || payload;

  const key       = m.key || m.message?.key || {};
  const remoteJid = key.remoteJid || m.remoteJid || "";
  const fromMe    = Boolean(key.fromMe);
  const messageId = key.id || m.id || "";

  const messageObj = m.message || {};
  const text =
    messageObj.conversation ||
    messageObj.extendedTextMessage?.text ||
    messageObj.buttonsResponseMessage?.selectedDisplayText ||
    messageObj.listResponseMessage?.title ||
    "";

  if (!text) return null;

  // remoteJid for personal chats: "33XXXXXXX@s.whatsapp.net".
  // For groups: "...@g.us" — we don't handle group chats.
  if (remoteJid.endsWith("@g.us")) return null;

  const from = remoteJid.split("@")[0];
  const timestamp = m.messageTimestamp || payload.messageTimestamp || null;

  return { from, fromMe, text: String(text).trim(), messageId, timestamp };
}

/**
 * True iff this number is allowed to talk to the bot. If WHATSAPP_ALLOWED_NUMBER
 * isn't set, everyone is allowed (open mode — discouraged).
 */
export function isAllowedSender(fromDigits) {
  const allowed = (process.env.WHATSAPP_ALLOWED_NUMBER || "").replace(/\D/g, "");
  if (!allowed) return true;
  return String(fromDigits || "").replace(/\D/g, "") === allowed;
}
