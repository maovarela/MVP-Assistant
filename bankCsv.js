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

// ─── BNP Paribas PDF (text extracted via pdf-parse) ─────────────────────────
// BNP statements are text-based PDFs with stable layout:
//   - Sections: VIREMENTS RECUS / EMIS, PRELEVEMENTS/AMORTISSEMENTS, PAIEMENTS PAR CARTE,
//     SERVICES BANCAIRES-COTISATIONS ET FRAIS. Sign of each row determined by section.
//   - Transaction lines: "DD.MM DD.MM <description> <cents>\t,\t<integer>"
//   - Amounts are REVERSED across tab characters due to column alignment in the PDF:
//     "84\t,\t3 713" → 3713.84. Spaces inside the integer are thousand separators.
//   - Internal transfers (PRELEVEMENT AMEX, REVOLUT card payments) must be SKIPPED
//     to avoid double-counting against the Amex/Revolut line items already loaded.

const BNP_SECTION_SIGN = {
  "VIREMENTS RECUS":                         1,
  "REMISES DE CHEQUES":                      1,
  "VIREMENTS EMIS":                         -1,
  "PRELEVEMENTS/AMORTISSEMENTS DE PRETS":   -1,
  "PRELEVEMENTS":                           -1,
  "PAIEMENTS PAR CARTE":                    -1,
  "SERVICES BANCAIRES-COTISATIONS ET FRAIS": -1,
  "OPERATIONS DIVERSES":                    -1,
};

const BNP_INTERNAL_TX_RX = /\b(american\s*express|\bamex\b|revolut|mastercard|carte\s*master|visa\s*carte)\b/i;

const FR_MONTHS = {
  "janvier":"01", "février":"02", "fevrier":"02", "mars":"03", "avril":"04",
  "mai":"05", "juin":"06", "juillet":"07", "août":"08", "aout":"08",
  "septembre":"09", "octobre":"10", "novembre":"11", "décembre":"12", "decembre":"12",
};

const BNP_TX_RX     = /^(\d{2})\.(\d{2})\s+\d{2}\.\d{2}\s+(.+?)\s+(\d+)\s*,\s*([\d\s]+)$/;
const BNP_PERIOD_RX = /du\s+\d{1,2}\s+([a-zûéôà]+)\s+(\d{4})\s+au\s+\d{1,2}\s+([a-zûéôà]+)\s+(\d{4})/i;

function reverseFrenchAmount(centsStr, intStr) {
  const cleanInt   = String(intStr).replace(/\s/g, "");
  const cleanCents = String(centsStr).padStart(2, "0").slice(0, 2);
  const v = parseFloat(`${cleanInt}.${cleanCents}`);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse the text content of a BNP Paribas "Relevé de votre compte chèques" PDF.
 * Returns an array of normalized transactions, or null if this doesn't look
 * like a BNP statement (caller should fall back to the LLM path).
 *
 * Internal transfers to other tracked accounts (Amex / Revolut / Mastercard /
 * Visa) are filtered out at parse time to avoid double-counting.
 */
export function parseBnpPdfText(text) {
  if (!text || !/BNP\s*PARIBAS|RELEVÉ DE VOTRE COMPTE/i.test(text)) return null;

  // Statement period → years for date reconstruction
  const periodM = text.match(BNP_PERIOD_RX);
  let startMonth, endMonth, startYear, endYear;
  if (periodM) {
    startMonth = FR_MONTHS[periodM[1].toLowerCase()];
    startYear  = periodM[2];
    endMonth   = FR_MONTHS[periodM[3].toLowerCase()];
    endYear    = periodM[4];
  } else {
    const now = new Date();
    startMonth = endMonth = String(now.getMonth() + 1).padStart(2, "0");
    startYear  = endYear  = String(now.getFullYear());
  }

  const out = [];
  let currentSign = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // Section header
    if (BNP_SECTION_SIGN[line] != null) {
      currentSign = BNP_SECTION_SIGN[line];
      continue;
    }
    if (/^DATE VALEUR/i.test(line))     continue;
    if (/^Sous-total/i.test(line))      continue;
    if (/^CARTE N°/i.test(line))        continue;
    if (/^Solde/i.test(line))           continue;
    if (/^TOTAL\s+[\d,\s]+/i.test(line)) break;  // end of transaction data

    const m = line.match(BNP_TX_RX);
    if (!m || currentSign == null) continue;

    const [, dd, mm, descRaw, cents, intg] = m;
    const amount = reverseFrenchAmount(cents, intg);
    if (amount == null) continue;

    // Year inference based on statement period
    const year = mm === endMonth ? endYear : (mm === startMonth ? startYear : endYear);
    const date = `${year}-${mm}-${dd}`;

    const desc = descRaw.trim().replace(/\s+/g, " ");
    if (BNP_INTERNAL_TX_RX.test(desc)) continue;  // skip Amex/Revolut/etc.

    out.push({
      date,
      merchant:    desc,
      amount:      currentSign * amount,
      currency:    "EUR",
      description: desc,
      external_id: null,    // caller hashes
    });
  }

  return out;
}

// ─── Categorizer (keyword heuristics — last resort if LLM didn't tag) ───────

// Rules are checked top-to-bottom; first match wins. Put SPECIFIC rules above
// broad ones to avoid false positives (e.g. "FREE MOBILE PARIS" → housing not
// restaurants because of an overly-greedy "le \w" pattern that used to be in
// the restaurant rule).
const RULES = [
  // Telecom / utilities / insurance (BNP direct debits) — must come BEFORE the
  // restaurants pattern because merchant strings often contain "le " / "la ".
  [/free\s*telecom|free\s*mobile|free\s*haut\s*debit|free mobile|orange|sfr|sosh|bouygues/i, "housing"],
  [/totalenergies|edf|engie|electricite|electricidad|gaz|water|veolia|suez/i, "housing"],
  [/cardif|swisslife|assurance|allianz|axa\b|matmut|maaf|seguro/i,            "fees"],
  [/navigo|comutitres|sncf|ratp|metro|velib|free now/i,                       "transport"],
  [/amende\.gouv|amende|impots|tresor public/i,                               "fees"],
  [/vir sepa recu|edenred|salaire|paie\b/i,                                   "income"],
  [/taptap send|wise|moneygram|western union/i,                               "transfers"],
  [/commissions cotisation|frais bnp|frais bancaire|esprit libre/i,           "fees"],

  // Subscriptions (specific so they win over broad rules)
  [/google\*google|openai|chatgpt|claude\.ai|netflix|spotify|notion|vercel|railway|github|cursor|imagineart|myheritage|twilio|uber one|cotisation/i, "subscriptions"],

  // Food / restaurants
  [/uber\s*eats|deliveroo|just\s*eat/i,                                       "restaurants"],
  [/restaurant|asado|casa de tapas|club sauvage|empanadas|sushi|pizza|tacos|burger|pret a manger|seggali|chez\b|brasserie|tapas|teriyaki|crepes|pizzardi|du pain|two tails|bcs co|grupo cob|naturalia/i, "restaurants"],

  // Travel & transport
  [/iberia|transavia|air europa|airbnb|hotel|booking|aeropuerto|trainline|ouigo|easyjet|ryanair|wizz/i, "travel"],
  [/uber(?!\s*eats)|bolt|cabify|smovengo|fpx |paris paris|relay|aeroport|cdg|orly|taxi/i,               "transport"],

  // Groceries
  [/monoprix|intermarche|lidl|carrefour|super dominique|suc bosquet|nicolas|fnac monop|inglesa|dollarcity|plaza de andres|bold co|olimpica|ol\W?mpica|aldi|jumbo|farmatodo|miniso|casaideas/i, "groceries"],

  // Health
  [/pharmacie|aquaboulevard|ideal optic|santé|sante|neoness|gym|deca|hospital|medico|farmacia/i, "health"],

  // Shopping
  [/uniqlo|zara|lego|grande recre|el ganso|zalando|fnac|taschen|monoprix les champs|licencia|sodicma|lenovo|apple|samsung|tienda/i, "shopping"],

  // Entertainment
  [/ticketnet|ticketmaster|cinema|theatre|spectacle|concert|museo|museum/i, "entertainment"],

  // Top-ups / transfers / fees (generic fallbacks)
  [/top.?up|topup/i,           "income"],
  [/transfer to/i,             "transfers"],
  [/prelevement automatique/i, "transfers"],
  [/versement/i,               "fees"],
];

export function categorize(desc) {
  if (!desc) return "other";
  for (const [rx, cat] of RULES) if (rx.test(desc)) return cat;
  return "other";
}
