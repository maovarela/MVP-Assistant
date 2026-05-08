// email.js
// IMAP reader for the agent's dedicated Gmail.
// Fetches recent unread messages, hands each one to the parser.
//
// Auth: Gmail App Password (no OAuth setup) — required env vars:
//   GMAIL_USER          (e.g. mauricio.varela.ai@gmail.com)
//   GMAIL_APP_PASSWORD  (16-char app password)

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { parseAndStoreEmail } from "./transactions.js";

const HOST = "imap.gmail.com";
const PORT = 993;

// Domains we recognise as bank/card transaction senders. Email from any of
// these gets parsed; everything else is ignored to save LLM calls.
// Add more as needed — anything whose @domain matches one of these patterns.
const BANK_SENDER_PATTERNS = [
  /@revolut\.com$/i,
  /@aexp\.com$/i,
  /@americanexpress\./i,
  /@welcome\.aexp\.com$/i,
  /@bnpparibas\./i,
  /@mailing\.bnpparibas\./i,
  /@notification\.bnpparibas\./i,
];

function isBankEmail(fromAddress) {
  if (!fromAddress) return false;
  return BANK_SENDER_PATTERNS.some((rx) => rx.test(fromAddress));
}

async function openClient() {
  const user = process.env.GMAIL_USER;
  // Strip spaces — Gmail shows app passwords as "abcd efgh ijkl mnop" but the
  // actual value is the 16 chars concatenated. Pasting with spaces is a very
  // common gotcha.
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    // Surface the underlying IMAP error so we can debug ("Command failed" is
    // imapflow's generic wrapper — the original Gmail error is in err.response
    // or err.responseText).
    const detail = err.responseText || err.response || err.code || err.message;
    throw new Error(`IMAP connect to ${HOST} as ${user} failed: ${detail}`);
  }
  return client;
}

/**
 * Fetch and parse new bank transaction emails since N days ago (default 1).
 * Returns counts: { fetched, parsed, skipped, errors }.
 */
export async function fetchAndParseRecent({ daysBack = 1 } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const client = await openClient();
  const stats = { fetched: 0, parsed: 0, skipped: 0, errors: 0 };

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Search messages newer than `since`
      const uids = await client.search({ since });

      for (const uid of uids) {
        stats.fetched++;
        try {
          const fetched = await client.fetchOne(uid, { source: true }, { uid: true });
          const source = fetched?.source;
          if (!source) {
            console.error(`[imap] uid=${uid} fetch returned no source (deleted? expunged?)`);
            stats.errors++;
            continue;
          }

          const parsed = await simpleParser(source);
          const fromAddr = parsed.from?.value?.[0]?.address || "";

          if (!isBankEmail(fromAddr)) { stats.skipped++; continue; }

          const result = await parseAndStoreEmail({
            messageId: parsed.messageId || `imap-${uid}`,
            from:      fromAddr,
            subject:   parsed.subject || "",
            date:      parsed.date?.toISOString() || new Date().toISOString(),
            body:      parsed.text || stripHtml(parsed.html || ""),
          });

          if (result) stats.parsed++; else stats.skipped++;
        } catch (err) {
          console.error(`[imap] uid=${uid} parse failed:`, err.message);
          stats.errors++;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return stats;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Bulk import: scan inbox for the last N days. Used for one-shot historical
 * catch-up after first deploy. Default 90 days = recent quarter.
 */
export async function backfillEmails({ daysBack = 90 } = {}) {
  return fetchAndParseRecent({ daysBack });
}

// ─── General email search/read (non-bank) ────────────────────────────────────
// The bank-transaction parser above is finance-specific. These helpers expose
// the inbox to the agent for everything else: reservation confirmations,
// receipts, forwarded threads, etc. The agent uses search_emails to find
// candidates, then read_email to pull full body.

function gmailDate(d) {
  // Gmail X-GM-RAW expects YYYY/MM/DD.
  return d.toISOString().slice(0, 10).replace(/-/g, "/");
}

function summariseAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  if (addr.text) return addr.text;
  const v = addr.value?.[0];
  if (!v) return "";
  return v.name ? `${v.name} <${v.address}>` : v.address || "";
}

// Find the Gmail "All Mail" mailbox. Its localized name varies (English
// "[Gmail]/All Mail", French "[Gmail]/Tous les messages", etc.), so we look it
// up by the IMAP SPECIAL-USE \All flag. Returns null if it can't be found —
// caller falls back to INBOX in that case.
async function findAllMailbox(client) {
  try {
    const list = await client.list();
    const all = list.find((b) => Array.isArray(b.specialUse) ? b.specialUse.includes("\\All") : b.specialUse === "\\All");
    return all?.path || null;
  } catch (err) {
    console.error("[imap] list mailboxes failed:", err.message);
    return null;
  }
}

/**
 * IMAP-native fallback search when X-GM-RAW returns nothing (or isn't
 * supported). Plain IMAP can't do full-text well, but it can match subject /
 * from / body substring and date — good enough as a backup.
 */
async function imapNativeSearch(client, { query, since }) {
  const q = (query || "").trim();
  if (!q) {
    return client.search({ since }, { uid: true });
  }
  // Try in order: subject, from, body. OR them together.
  const orQuery = {
    since,
    or: [
      { subject: q },
      { from: q },
      { body: q },
    ],
  };
  try {
    return await client.search(orQuery, { uid: true });
  } catch (err) {
    console.error("[imap] native OR search failed, falling back to subject-only:", err.message);
    return client.search({ since, subject: q }, { uid: true });
  }
}

async function fetchAndSummarise(client, uid) {
  const msg = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!msg?.source) return null;
  const parsed = await simpleParser(msg.source);
  const body = parsed.text || stripHtml(parsed.html || "");
  return {
    uid,
    message_id: parsed.messageId || `imap-${uid}`,
    from:       summariseAddress(parsed.from),
    to:         summariseAddress(parsed.to),
    subject:    parsed.subject || "",
    date:       parsed.date?.toISOString() || "",
    snippet:    body.replace(/\s+/g, " ").trim().slice(0, 240),
    _body:      body,
  };
}

/**
 * Search the inbox using Gmail's full search syntax (X-GM-RAW), falling back
 * to plain IMAP search if Gmail's extension returns nothing. Searches in the
 * "All Mail" folder so archived/labeled emails are visible too — Gmail's IMAP
 * "INBOX" only contains messages currently in the Inbox view.
 *
 * Examples of `query`: "from:booking.com reserva", "subject:Barcelona",
 * "vuelo iberia". Empty query returns the most recent N emails.
 */
export async function searchEmails({ query = "", daysBack = 30, limit = 10 } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const trimmed = (query || "").trim();
  const gmailQuery = trimmed
    ? `${trimmed} after:${gmailDate(since)}`
    : `after:${gmailDate(since)}`;

  const client = await openClient();
  const out = [];
  try {
    const allMailbox = (await findAllMailbox(client)) || "INBOX";
    const lock = await client.getMailboxLock(allMailbox);
    console.log(`[email] search query=${JSON.stringify(trimmed)} daysBack=${daysBack} mailbox=${allMailbox}`);
    try {
      let uids = [];
      try {
        uids = await client.search({ gmailRaw: gmailQuery }, { uid: true });
      } catch (err) {
        console.error(`[email] gmailRaw search failed: ${err.message}`);
      }
      console.log(`[email] gmailRaw matched ${uids?.length || 0} UIDs`);

      if (!uids || uids.length === 0) {
        uids = await imapNativeSearch(client, { query: trimmed, since });
        console.log(`[email] native fallback matched ${uids?.length || 0} UIDs`);
      }
      if (!uids || uids.length === 0) return out;

      // Most recent first, capped to `limit`.
      uids = uids.sort((a, b) => b - a).slice(0, Math.max(1, limit));

      for (const uid of uids) {
        try {
          const summary = await fetchAndSummarise(client, uid);
          if (!summary) {
            console.error(`[email] uid=${uid} no source returned`);
            continue;
          }
          delete summary._body;
          out.push(summary);
        } catch (err) {
          console.error(`[email] search uid=${uid} failed:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  console.log(`[email] search returning ${out.length} results`);
  return out;
}

/**
 * Read the full content of an email by UID (UID returned from searchEmails).
 * Body is truncated to 8000 chars — plenty for almost any single message and
 * keeps the LLM context bounded.
 */
export async function readEmailByUid(uid) {
  if (uid == null) throw new Error("uid is required");
  const client = await openClient();
  try {
    const allMailbox = (await findAllMailbox(client)) || "INBOX";
    const lock = await client.getMailboxLock(allMailbox);
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg?.source) {
        console.error(`[email] read uid=${uid} no source (deleted/expunged?)`);
        return null;
      }
      const parsed = await simpleParser(msg.source);
      const body = parsed.text || stripHtml(parsed.html || "");
      return {
        uid,
        message_id: parsed.messageId || `imap-${uid}`,
        from:       summariseAddress(parsed.from),
        to:         summariseAddress(parsed.to),
        cc:         summariseAddress(parsed.cc),
        subject:    parsed.subject || "",
        date:       parsed.date?.toISOString() || "",
        body:       body.slice(0, 8000),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
