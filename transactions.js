// transactions.js
// Parse transactions from email bodies, CSV files, and PDF statements.
// Uses Claude for everything — no per-bank hardcoded regex. Same parser
// works for Amex, Revolut, BNP, and anything else with sensible formatting.

import { parse as parseCsv } from "csv-parse/sync";
import fs from "fs";
import crypto from "crypto";

import {
  insertTransaction,
  isEmailProcessed,
  markEmailProcessed,
} from "./memory.js";
import { callLLMText, callLLM, getProviders } from "./llm.js";
import { detectBankFormat, parseAmexCsv, parseRevolutCsv, categorize as keywordCategorize } from "./bankCsv.js";

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
  "transfers",       // movimientos entre cuentas propias
  "income",          // salario, refunds, ingresos
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
export async function importCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");

  // Try a deterministic per-bank parser first (no LLM cost, no sign bugs).
  // Falls back to the generic LLM-batch path if format is unknown.
  const fmt = detectBankFormat(content);
  if (fmt) {
    console.log(`[csv] detected format=${fmt} for ${filePath}`);
    const parsed = fmt === "amex" ? parseAmexCsv(content) : parseRevolutCsv(content);
    let inserted = 0, skipped = 0;
    for (const tx of parsed) {
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

    for (let j = 0; j < parsedBatch.length; j++) {
      const tx = parsedBatch[j];
      if (!tx || !tx.date || tx.amount == null) { skipped++; continue; }

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

const PDF_PARSE_PROMPT = `You're reading a bank statement PDF. Extract every individual transaction
in the document as a JSON array. Do not include opening/closing balances or summary lines.

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
  const base64 = fs.readFileSync(filePath).toString("base64");
  const filename = filePath.split(/[\\/]/).pop() || "statement.pdf";

  // PDF support across OpenAI-compatible endpoints:
  //   - Gemini (primary): accepts the OpenAI `file` content type with a
  //     base64 data URI in `file_data`. The legacy image_url+PDF trick stopped
  //     working in 2026.
  //   - Groq Llama / DeepSeek (fallbacks): text-only, can't read PDFs.
  // Locking to the primary provider prevents fallback to text-only providers
  // returning the misleading "Only image types are supported" error.
  const resp = await callLLM({
    providers: ["primary"],
    messages: [
      { role: "system", content: PDF_PARSE_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract all transactions from this statement." },
          {
            type: "file",
            file: {
              filename,
              file_data: `data:application/pdf;base64,${base64}`,
            },
          },
        ],
      },
    ],
    max_tokens: 8000,
    temperature: 0.2,
  });

  const text = resp.choices[0]?.message?.content || "";
  let txs;
  try {
    txs = JSON.parse(extractJson(text));
  } catch (err) {
    console.error("[pdf parse]", err.message, text.slice(0, 500));
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  let inserted = 0, skipped = 0;
  for (const tx of txs) {
    if (!tx?.date || tx.amount == null) { skipped++; continue; }
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
