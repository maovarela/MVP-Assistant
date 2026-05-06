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
          const { source } = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!source) { stats.errors++; continue; }

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
