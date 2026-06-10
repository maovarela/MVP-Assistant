// transactions.js
// Parse transactions from email bodies, CSV files, and PDF statements.
// Uses Claude for everything — no per-bank hardcoded regex. Same parser
// works for Amex, Revolut, BNP, and anything else with sensible formatting.

import { parse as parseCsv } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import fs from "fs";
import crypto from "crypto";

import db, {
  insertTransaction,
  isEmailProcessed,
  markEmailProcessed,
  setAccountBalance,
} from "./memory.js";
import { callLLMText, callLLM, getProviders } from "./llm.js";
import { detectBankFormat, parseAmexCsv, parseRevolutCsv, parseBnpPdfText, categorize as keywordCategorize } from "./bankCsv.js";

// ─── Categories — single source of truth ─────────────────────────────────────
const CATEGORIES = [
  "groceries",       // supermercados, food shopping
  "restaurants",     // bares, cafés, restaurantes, delivery
  "transport",       // metro, taxi, Uber, gasolina
  "travel",          // hoteles, vuelos, airbnb
  "subscriptions",   // Netflix, Spotify, software
  "shopping",        // ropa, electrónica, ocio retail
  "health",          // farmacia, médico, gimnasio, deporte
  "housing",         // alquiler, hipoteca, electricidad, gas, internet
  "entertainment",   // cine, conciertos, museos
  "transfers",       // money moves between own accounts
  "savings",         // PERCO, retirement plans, investments, ETFs
  "debt",            // loan / credit-card payments
  "income",          // salary, refunds, inflows
  "fees",            // comisiones bancarias, intereses
  "other",
];

// ─── Email parsing ───────────────────────────────────────────────────────────

const EMAIL_PARSE_PROMPT = `You parse bank/card transaction notification emails.

Extract a single transaction if and only if this email reports a real charge,
purchase, refund, transfer, or deposit. If it's marketing, statement summary,
balance alert without a specific charge, or anything else — return {"is_transaction": false}.

Return strict JSON, no prose, no markdown:
{
  "is_transaction": true,
  "date": "YYYY-MM-DD",
  "merchant": "clean merchant name (e.g. 'Mercadona', not 'MERCAD AVILA 23423')",
  "amount": -12.34,                    // negative=outflow, positive=inflow
  "currency": "EUR",
  "category": "one of: ${CATEGORIES.join(", ")}",
  "description": "short human description if useful, else empty"
}`;

/**
 * Parse a single email and insert as a transaction if applicable.
 * Returns the inserted transaction, or null if not a transaction / already processed.
 */
export async function parseAndStoreEmail({ messageId, from, subject, date, body }) {
  if (!messageId) return null;
  if (isEmailProcessed(messageId)) return null;

  const userPrompt = `Email metadata:
From: ${from}
Subject: ${subject}
Date: ${date}

Body:
${(body || "").slice(0, 8000)}`;

  let parsed;
  try {
    const text = await callLLMText({
      messages: [
        { role: "system", content: EMAIL_PARSE_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 400,
      temperature: 0.2,
    });
    parsed = JSON.parse(extractJson(text));
  } catch (err) {
    console.error(`[email parse] failed for ${messageId}:`, err.message);
    markEmailProcessed(messageId); // don't retry forever on broken emails
    return null;
  }

  markEmailProcessed(messageId);

  if (!parsed.is_transaction) return null;

  const id = insertTransaction({
    external_id: `email:${messageId}`,
    source:      "email",
    date:        parsed.date,
    merchant:    parsed.merchant,
    amount:      parsed.amount,
    currency:    parsed.currency || "EUR",
    category:    parsed.category,
    description: parsed.description,
    raw:         JSON.stringify({ from, subject, body: body?.slice(0, 2000) }),
  });

  return id ? parsed : null;
}

// ─── CSV import ──────────────────────────────────────────────────────────────

/**
 * Import a CSV file. Sends rows to Claude in batches to map columns to our
 * schema (different banks use different headers / locales / formats).
 */
// ─── Overlap dedup (format-independent) ──────────────────────────────────────
// Statements overlap at month boundaries and across export formats (a Revolut
// consolidated statement and a monthly one share ~3 weeks; re-downloads, partial
// test files, etc.). The per-source external_id hash differs between formats, so
// it can't catch those. This guard adds a NATURAL key —
// (date, amount-in-cents, currency, normalized-merchant) — and skips an incoming
// row only up to the count already in the DB, so genuine same-day repeats (two
// identical coffees) survive while true overlaps are dropped. Works against data
// already imported, with no re-hashing or re-seeding.

function naturalKey(t) {
  const cents    = Math.round(Number(t.amount) * 100);
  const merchant = (t.merchant || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${t.date}|${cents}|${(t.currency || "EUR").toUpperCase()}|${merchant}`;
}

/**
 * Build a multiplicity-aware overlap filter for a batch about to be imported.
 * Returns isOverlap(tx) → true when tx duplicates a transaction already present
 * in the DB (within the batch's date span) and should be skipped.
 */
function makeOverlapGuard(txs) {
  const dates = txs.map((t) => t.date).filter(Boolean).sort();
  const existing = new Map();
  if (dates.length) {
    const rows = db.prepare(
      `SELECT date, amount, currency, merchant FROM transactions WHERE date BETWEEN ? AND ?`
    ).all(dates[0], dates[dates.length - 1]);
    for (const r of rows) {
      const k = naturalKey(r);
      existing.set(k, (existing.get(k) || 0) + 1);
    }
  }
  const seen = new Map();
  return (tx) => {
    const k = naturalKey(tx);
    const s = seen.get(k) || 0;
    seen.set(k, s + 1);
    return s < (existing.get(k) || 0); // DB already holds this many → overlap
  };
}

export async function importCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");

  // Try a deterministic per-bank parser first (no LLM cost, no sign bugs).
  // Falls back to the generic LLM-batch path if format is unknown.
  const fmt = detectBankFormat(content);
  if (fmt) {
    console.log(`[csv] detected format=${fmt} for ${filePath}`);
    const parsed = fmt === "amex" ? parseAmexCsv(content) : parseRevolutCsv(content);
    const isOverlap = makeOverlapGuard(parsed);
    let inserted = 0, skipped = 0;
    for (const tx of parsed) {
      if (isOverlap(tx)) { skipped++; continue; }
      const extId = tx.external_id || hashTx(tx);
      const id = insertTransaction({
        external_id: `${fmt}:${extId}`,
        source:      "csv",
        date:        tx.date,
        merchant:    tx.merchant,
        amount:      tx.amount,
        currency:    tx.currency || "EUR",
        category:    tx.category || keywordCategorize(tx.description || tx.merchant),
        description: tx.description,
        raw:         null,
        is_internal_transfer: !!tx.is_internal_transfer,
      });
      if (id) inserted++; else skipped++;
    }
    return { inserted, skipped, errors: 0, total: parsed.length };
  }

  // Generic fallback — LLM batch parser
  let rows;
  try {
    rows = parseCsv(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    // Fallback: try semicolon (BNP / many EU banks default to ;)
    rows = parseCsv(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      trim: true,
      delimiter: ";",
    });
  }

  if (!rows.length) return { inserted: 0, skipped: 0, errors: 0 };

  let inserted = 0, skipped = 0, errors = 0;

  // Process in batches of 20 rows so Claude sees enough context but stays fast
  const BATCH = 20;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let parsedBatch;
    try {
      parsedBatch = await parseCsvBatch(batch);
    } catch (err) {
      console.error("[csv parse batch]", err.message);
      errors += batch.length;
      continue;
    }

    const isOverlap = makeOverlapGuard(parsedBatch.filter((t) => t && t.date && t.amount != null));
    for (let j = 0; j < parsedBatch.length; j++) {
      const tx = parsedBatch[j];
      if (!tx || !tx.date || tx.amount == null) { skipped++; continue; }
      if (isOverlap(tx)) { skipped++; continue; }

      const externalId = tx.external_id || hashTx(tx, batch[j]);
      const id = insertTransaction({
        external_id: `csv:${externalId}`,
        source:      "csv",
        date:        tx.date,
        merchant:    tx.merchant,
        amount:      tx.amount,
        currency:    tx.currency || "EUR",
        category:    tx.category,
        description: tx.description,
        raw:         JSON.stringify(batch[j]),
      });

      if (id) inserted++; else skipped++;
    }
  }

  return { inserted, skipped, errors, total: rows.length };
}

const CSV_PARSE_PROMPT = `You convert raw bank-statement CSV rows to a normalized transaction format.
The rows may be from Amex, Revolut, BNP, or other banks — schemas vary widely.

Input: array of objects (one per CSV row).
Output: a JSON array of equal length, one normalized transaction per input row.

For each row return:
{
  "date":         "YYYY-MM-DD",
  "merchant":     "clean merchant name (e.g. 'Carrefour' not 'CARREFOUR ANGOULEME 33 / 4567')",
  "amount":       -12.34,                       // negative=outflow, positive=inflow
  "currency":     "EUR" | "USD" | etc.,
  "category":     "one of: ${CATEGORIES.join(", ")}",
  "description":  "optional brief note",
  "external_id":  "stable per-row identifier from the CSV if any (transaction reference, etc.) else null"
}

Return ONLY the JSON array. No prose, no markdown fences.`;

async function parseCsvBatch(batch) {
  const text = await callLLMText({
    messages: [
      { role: "system", content: CSV_PARSE_PROMPT },
      { role: "user", content: JSON.stringify(batch) },
    ],
    max_tokens: 4000,
    temperature: 0.2,
  });
  return JSON.parse(extractJson(text));
}

/**
 * Bulk-import a pre-normalized CSV produced by scripts/import-local.mjs.
 * Schema: date,merchant,amount,currency,category,description,external_id,source_file
 * No LLM call — rows already have correct shape + signs. Just inserts with dedup.
 */
export function importNormalized(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(content, {
    columns: true, skip_empty_lines: true, bom: true, relax_quotes: true, relax_column_count: true, trim: true,
  });

  let inserted = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    try {
      const amount = parseFloat(r.amount);
      if (!r.date || !Number.isFinite(amount)) { skipped++; continue; }
      const extId = r.external_id || hashTx({ date: r.date, merchant: r.merchant, amount });
      const id = insertTransaction({
        external_id: extId.startsWith("amex:") || extId.startsWith("revolut:") ? extId : `csv:${extId}`,
        source:      "csv",
        date:        r.date,
        merchant:    r.merchant || null,
        amount,
        currency:    r.currency || "EUR",
        category:    r.category || keywordCategorize(r.description || r.merchant),
        description: r.description || null,
        raw:         null,
      });
      if (id) inserted++; else skipped++;
    } catch (err) {
      console.error("[normalized import] row error:", err.message);
      errors++;
    }
  }
  return { inserted, skipped, errors, total: rows.length };
}

// ─── PDF import (uses Claude vision via document input) ──────────────────────

const PDF_PARSE_PROMPT = `You're reading the extracted text of a bank statement. Extract every individual transaction
as a JSON array. Do not include opening/closing balances or summary lines.

IMPORTANT — text comes from a PDF extractor and may have quirks:
- French amounts can be split across tab characters in column-aligned PDFs.
  Example: "84\\t,\\t3 713" actually means "3 713,84" i.e. 3713.84. Look for
  the "X\\t,\\tY" pattern and read it as Y,X. Spaces inside Y are thousand
  separators (drop them).
- Negative/positive is determined by which column the amount appears under:
  "DEBIT" column → outflow (negative). "CREDIT" column → inflow (positive).
- Dates may be "DD.MM" or "DD.MM.YYYY". If year missing, infer from the
  statement period printed at the top ("du DD month YYYY au DD month YYYY").

CRITICAL — skip rows that are INTERNAL TRANSFERS between the user's own accounts:
- "PRELEVEMENT AMEX" / "AMERICAN EXPRESS" / "AMEX" debits → SKIP (Amex purchases are tracked separately on the Amex statement)
- "VIREMENT REVOLUT" / "REVOLUT" / "REVOLUT BANK" transfers → SKIP (Revolut transactions are tracked separately)
- "PRELEVEMENT MASTERCARD" / "VISA" credit-card-payment debits → SKIP
- Any explicit "remboursement carte" / "card balance payment" → SKIP
Including these would double-count spending because the underlying purchases are already in the DB.

KEEP everything else:
- Direct debits to utilities, rent, insurance, subscriptions (EDF, Orange, Free, Sogeprom...)
- Card payments made directly from this account (BNP debit card transactions)
- Salary credits, refunds, incoming transfers → positive amount
- Cash withdrawals, fees
- Transfers to investment accounts (PERCO, etc.) → keep, category=transfers

Each transaction:
{
  "date":         "YYYY-MM-DD",
  "merchant":     "clean merchant name",
  "amount":       -12.34,                  // negative=outflow, positive=inflow
  "currency":     "EUR",
  "category":     "one of: ${CATEGORIES.join(", ")}",
  "description":  "optional brief note"
}

Return ONLY the JSON array. If after filtering nothing remains, return [].`;

export async function importPdf(filePath) {
  // Extract text locally with pdf-parse instead of sending the PDF binary to
  // an LLM. Reasons:
  //   - Gemini's OpenAI-compat endpoint stopped accepting our PDF format
  //     (returns 400 with no body in 2026).
  //   - Text is ~10x smaller than base64-PDF → cheaper LLM calls.
  //   - Plain text works with any provider, so the full fallback chain is
  //     available again instead of being pinned to one multimodal provider.
  //   - BNP/Amex/Revolut statements are text-based PDFs (not scanned), so
  //     text extraction is lossless.
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const { text } = await parser.getText();
  if (!text || text.trim().length < 100) {
    console.error("[pdf] extracted text too short — probably a scanned PDF");
    return { inserted: 0, skipped: 0, errors: 1, total: 0 };
  }
  const filename = filePath.split(/[\\/]/).pop();
  console.log(`[pdf] extracted ${text.length} chars from ${filename}`);

  // Fast path: deterministic BNP parser — zero LLM cost. Returns null if the
  // text doesn't look like a BNP statement, in which case we fall through to
  // the generic LLM path (Amex monthly PDFs, other banks).
  const bnpTxs = parseBnpPdfText(text);
  if (bnpTxs && bnpTxs.length > 0) {
    console.log(`[pdf] BNP fast-path: ${bnpTxs.length} transactions (no LLM)`);
    const isOverlap = makeOverlapGuard(bnpTxs);
    let inserted = 0, skipped = 0;
    for (const tx of bnpTxs) {
      if (isOverlap(tx)) { skipped++; continue; }
      const id = insertTransaction({
        external_id: `bnp:${hashTx(tx)}`,
        source:      "pdf",
        date:        tx.date,
        merchant:    tx.merchant,
        amount:      tx.amount,
        currency:    tx.currency,
        category:    tx.category || keywordCategorize(tx.description || tx.merchant),
        description: tx.description,
        raw:         null,
        is_internal_transfer: !!tx.is_internal_transfer,
      });
      if (id) inserted++; else skipped++;
    }
    // Persist opening/closing balances if extracted. opening_eur in this
    // statement = closing of previous month. The end_period is the month the
    // statement closes (typically same as transaction dates).
    const bals = bnpTxs.balances;
    if (bals && (bals.opening_eur != null || bals.closing_eur != null) && bals.end_period) {
      try {
        setAccountBalance({
          account:     "bnp",
          period:      bals.end_period,
          opening_eur: bals.opening_eur,
          closing_eur: bals.closing_eur,
          source:      "pdf-extracted",
        });
        console.log(`[pdf] BNP balances → ${bals.end_period} opening=${bals.opening_eur} closing=${bals.closing_eur}`);
      } catch (err) { console.warn(`[pdf] balance write failed: ${err.message}`); }
    }
    return { inserted, skipped, errors: 0, total: bnpTxs.length };
  }

  const resp = await callLLM({
    messages: [
      { role: "system", content: PDF_PARSE_PROMPT },
      { role: "user",   content: `Statement text below — extract transactions:\n\n${text}` },
    ],
    max_tokens: 8000,
    temperature: 0.2,
  });

  const replyText = resp.choices[0]?.message?.content || "";
  let txs;
  try {
    txs = JSON.parse(extractJson(replyText));
  } catch (err) {
    console.error("[pdf parse]", err.message, replyText.slice(0, 500));
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const isOverlap = makeOverlapGuard(txs.filter((t) => t?.date && t.amount != null));
  let inserted = 0, skipped = 0;
  for (const tx of txs) {
    if (!tx?.date || tx.amount == null) { skipped++; continue; }
    if (isOverlap(tx)) { skipped++; continue; }
    const id = insertTransaction({
      external_id: `pdf:${hashTx(tx)}`,
      source:      "pdf",
      date:        tx.date,
      merchant:    tx.merchant,
      amount:      tx.amount,
      currency:    tx.currency || "EUR",
      category:    tx.category,
      description: tx.description,
      raw:         null,
    });
    if (id) inserted++; else skipped++;
  }

  return { inserted, skipped, errors: 0, total: txs.length };
}

// ─── Manual entry ─────────────────────────────────────────────────────────────

/**
 * Log a single real transaction by hand. Shared core for every "quick capture"
 * surface: chat quick-add, the dashboard "+ Add" form, receipt OCR, and voice
 * notes. Normalizes the sign (expenses negative, income positive), auto-detects
 * the category from the merchant when none is given, and inserts via the same
 * path as imported transactions. external_id is left null so legitimate repeats
 * (two coffees the same day) are never blocked as duplicates.
 *
 * @returns {{id:number, date:string, merchant:string, amount:number, currency:string, category:string}}
 */
export function logManualExpense(e = {}) {
  const amt = Number(e.amount_eur);
  if (!Number.isFinite(amt) || amt === 0) throw new Error("amount_eur must be a non-zero number");

  const date = (typeof e.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    ? e.date
    : new Date().toISOString().slice(0, 10);
  const merchant = (e.merchant || "").toString().trim() || "Manual entry";
  const currency = (e.currency || "EUR").toString().toUpperCase();
  let category = e.category && CATEGORIES.includes(e.category) ? e.category : null;
  if (!category) category = keywordCategorize(merchant) || "other";
  const signed = e.is_income ? Math.abs(amt) : -Math.abs(amt);

  const id = insertTransaction({
    external_id: null,            // manual entries don't dedup — repeats are real
    source:      e.source || "manual",
    date, merchant, amount: signed, currency, category,
    description: e.description || null,
    raw:         null,
    is_internal_transfer: false,
  });
  return { id, date, merchant, amount: signed, currency, category };
}

// ─── Receipt photo OCR ────────────────────────────────────────────────────────

const RECEIPT_PROMPT = `You read a photo of a purchase receipt/ticket and extract the expense.
Return STRICT JSON, no prose, no markdown:
{"amount": 12.34, "merchant": "clean store name", "date": "YYYY-MM-DD" or null, "currency": "EUR", "category": "one of: ${CATEGORIES.join(", ")}"}

Rules:
- amount = the GRAND TOTAL actually paid (a positive number). Never the subtotal or a single line item.
- merchant = the store/brand name, cleaned (e.g. "Monoprix", not "MONOPRIX SA 75007").
- date = the purchase date printed on the receipt if visible, otherwise null.
- currency = ISO code; default "EUR" if ambiguous.
- category = best guess from the list, based on the merchant and items.
If it is not a receipt or no total is readable, return {"amount": null}.`;

/**
 * Extract a single expense from a receipt photo. Needs a multimodal model, so it
 * locks to the primary provider (Gemini). Returns the parsed object
 * { amount, merchant, date, currency, category } — amount is null if unreadable.
 */
export async function parseReceiptImage(buffer, mimeType = "image/jpeg") {
  const b64 = Buffer.from(buffer).toString("base64");
  const resp = await callLLM({
    providers: ["primary"], // image input — don't fall back to text-only providers
    messages: [
      { role: "system", content: RECEIPT_PROMPT },
      { role: "user", content: [
        { type: "text", text: "Extract the expense from this receipt." },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${b64}` } },
      ] },
    ],
    max_tokens: 500,
    temperature: 0.1,
  });
  const txt = resp.choices[0]?.message?.content || "";
  return JSON.parse(extractJson(txt));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Robustly extract JSON from a model response, even if the model wrapped it
 * in markdown fences or added stray prose despite instructions.
 */
function extractJson(text) {
  const trimmed = text.trim();
  // Try fenced code block first
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) return fence[1];
  // Try first {...} or [...]
  const obj = trimmed.match(/(\{[\s\S]+\}|\[[\s\S]+\])/);
  if (obj) return obj[1];
  return trimmed;
}

/** Stable hash for dedup when the source has no native ID. */
function hashTx(tx, raw) {
  const key = `${tx.date}|${tx.merchant || ""}|${tx.amount}|${tx.currency || "EUR"}|${JSON.stringify(raw || "")}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export { CATEGORIES };
