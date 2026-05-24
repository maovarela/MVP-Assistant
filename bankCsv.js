// bankCsv.js
// Deterministic parsers for bank CSV statement formats we've seen in the wild.
// Two key problems these solve that the LLM-batch parser does NOT:
//
//   1. Amex FR uses INVERTED sign convention (positive = charge). The LLM
//      prompt assumes negative = outflow, so without explicit flipping every
//      Amex spend is stored as income and the spend queries return zero.
//   2. Revolut "consolidated statement" exports concatenate multiple
//      transaction tables (one per currency account) into a single file with
//      account-summary headers in between. csv-parse with columns=true can't
//      digest that — it needs the right header row per block.
//
// Used by both transactions.js (production) and scripts/import-local.mjs (one-shot).

import { parse } from "csv-parse/sync";
import crypto from "crypto";

// ─── Format detection ───────────────────────────────────────────────────────

/**
 * Detect the bank format of a CSV content blob.
 * Returns one of: "amex" | "revolut" | null (unknown — fall back to LLM).
 */
export function detectBankFormat(content) {
  const head = content.slice(0, 2000);
  if (head.includes("Money in/out") || /Revolut/i.test(head)) return "revolut";
  if (head.includes("Montant") && head.includes("Référence")) return "amex";
  if (/^Date,Description,Montant/m.test(head)) return "amex";
  return null;
}

// ─── Amex FR ────────────────────────────────────────────────────────────────

function parseFrenchAmount(s) {
  if (s == null || s === "") return 0;
  const cleaned = String(s).replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseAmexDate(s) {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/**
 * Parse an Amex FR CSV. Returns an array of normalized transactions with the
 * sign already flipped (positive in CSV → negative in DB).
 */
export function parseAmexCsv(content) {
  let rows;
  try {
    rows = parse(content, { columns: true, skip_empty_lines: true, bom: true, relax_quotes: true, relax_column_count: true, trim: true });
  } catch (err) {
    // Some Amex exports use ; — retry
    rows = parse(content, { columns: true, skip_empty_lines: true, bom: true, relax_quotes: true, relax_column_count: true, trim: true, delimiter: ";" });
  }
  const out = [];
  for (const r of rows) {
    const date   = parseAmexDate(r.Date);
    const desc   = (r.Description || "").trim().replace(/\s+/g, " ");
    const rawAmt = parseFrenchAmount(r.Montant);
    if (!date || !desc) continue;
    const refRaw = String(r.Référence || r["Reference"] || "").replace(/'/g, "");
    out.push({
      date,
      merchant:    desc,
      amount:      -rawAmt,        // ← the fix: Amex positive = charge
      currency:    "EUR",
      description: desc,
      external_id: refRaw || null, // caller can prefix with "amex:"
    });
  }
  return out;
}

// ─── Revolut ────────────────────────────────────────────────────────────────

const REVOLUT_HEADER = "Date,Description,Category,Money in/out,Balance,Tax withheld,Other taxes,Fees";
const REVOLUT_DATE_RX = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const MONTHS = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06", Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };

function parseRevolutDate(s) {
  const m = String(s || "").trim().match(REVOLUT_DATE_RX);
  if (!m) return null;
  return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}`;
}

function parseRevolutMoney(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^\d.,\-]/g, "");
  const norm = cleaned.includes(",") && cleaned.includes(".")
    ? cleaned.replace(/,/g, "")
    : cleaned.replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a Revolut consolidated-statement CSV. Handles the multi-section layout:
 * walks the file line by line, tracks the active currency from "Personal
 * Account (XXX)" headers, and parses each "Date,Description,Category,..."
 * block as its own CSV.
 *
 * Revolut already uses negative-out / positive-in, so no sign flip.
 */
export function parseRevolutCsv(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  let currentCurrency = "EUR";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const acctMatch = line.match(/^Personal Account \(([A-Z]{3})\),*$/);
    if (acctMatch) { currentCurrency = acctMatch[1]; i++; continue; }

    if (line.replace(/,+$/, "") === REVOLUT_HEADER) {
      const block = [REVOLUT_HEADER];
      i++;
      while (i < lines.length) {
        const stripped = lines[i].replace(/,+$/, "").trim();
        if (stripped === "" || stripped.startsWith("---") || stripped.startsWith("Personal Account ")) break;
        block.push(lines[i]);
        i++;
      }
      try {
        const rows = parse(block.join("\n"), {
          columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true, trim: true,
        });
        for (const r of rows) {
          const date = parseRevolutDate(r.Date);
          const desc = (r.Description || "").trim();
          if (!date || !desc) continue;
          const amount = parseRevolutMoney(r["Money in/out"]);
          if (amount === 0) continue;
          // Stable id without bank-issued reference: hash the row.
          const id = crypto.createHash("sha1")
            .update(`revolut|${currentCurrency}|${date}|${desc}|${amount}|${r.Balance || ""}`)
            .digest("hex").slice(0, 16);
          out.push({
            date,
            merchant:    desc,
            amount,
            currency:    currentCurrency,
            description: desc,
            external_id: id,
          });
        }
      } catch (err) {
        console.error(`[revolut] block parse error: ${err.message}`);
      }
      continue;
    }
    i++;
  }
  return out;
}

// ─── Categorizer (keyword heuristics — last resort if LLM didn't tag) ───────

const RULES = [
  [/uber\s*eats|deliveroo|just\s*eat/i,                       "restaurants"],
  [/uber(?!\s*eats)|bolt|cabify|free now|smovengo|velib|fpx |paris paris|relay|aeroport|cdg|orly|taxi/i, "transport"],
  [/iberia|transavia|air europa|airbnb|hotel|booking|aeropuerto|sncf|trainline|ouigo|easyjet|ryanair|wizz/i, "travel"],
  [/restaurant|asado|casa de tapas|club sauvage|empanadas|sushi|pizza|tacos|burger|pret a manger|seggali|chez |brasserie|tapas|teriyaki|crepes|pizzardi|du pain|two tails|bcs co|grupo cob|naturalia|le \w|la \w/i, "restaurants"],
  [/monoprix|intermarche|lidl|carrefour|super dominique|suc bosquet|nicolas|fnac monop|inglesa|dollarcity|plaza de andres|bold co|olimpica|ol\W?mpica|aldi|jumbo|farmatodo|miniso|casaideas/i, "groceries"],
  [/pharmacie|aquaboulevard|ideal optic|santé|sante|neoness|gym|deca|hospital/i, "health"],
  [/uniqlo|zara|lego|grande recre|el ganso|zalando|fnac|taschen|monoprix les champs|licencia|sodicma|lenovo|apple|samsung|tienda/i, "shopping"],
  [/google\*google|openai|chatgpt|claude\.ai|netflix|spotify|notion|vercel|railway|github|cursor|imagineart|myheritage|twilio|uber one|cotisation/i, "subscriptions"],
  [/ticketnet|ticketmaster|cinema|theatre|spectacle|concert|museo|museum/i, "entertainment"],
  [/top.?up|topup/i,         "income"],
  [/transfer to/i,           "transfers"],
  [/prelevement automatique/i, "transfers"],
  [/versement/i,             "fees"],
];

export function categorize(desc) {
  if (!desc) return "other";
  for (const [rx, cat] of RULES) if (rx.test(desc)) return cat;
  return "other";
}
