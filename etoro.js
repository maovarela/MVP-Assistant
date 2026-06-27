// etoro.js
// eToro foreign-account module — schema, ingestion helpers, and per-year
// tax aggregation for the French regularization (form 3916-bis + gains/dividends).
//
// Data source: the eToro "Account Statement" .xlsx (5 sheets). Raw tables are
// source-faithful and re-import-safe (keyed on position_id / row hash). The
// derived table `etoro_tax_year` is the deliverable everything else reads from.
//
// NOT tax advice: this module produces the *figures* and a per-year checklist.
// The 2086 crypto method and the exact held-years for 3916-bis are flagged for
// the fiscaliste rather than treated as final.

import db from "./memory.js";
import crypto from "crypto";
import * as XLSX from "xlsx";

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  -- One row per imported statement file (provenance + idempotency).
  CREATE TABLE IF NOT EXISTS etoro_statements (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name        TEXT NOT NULL,
    file_hash        TEXT NOT NULL UNIQUE,
    holder_name      TEXT,
    username         TEXT,
    institution      TEXT,
    account_currency TEXT,
    period_start     TEXT,
    period_end       TEXT,
    imported_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Closed trades. profit_eur is the figure that feeds plus-values / 2086.
  CREATE TABLE IF NOT EXISTS etoro_closed_positions (
    position_id  TEXT PRIMARY KEY,
    statement_id INTEGER NOT NULL REFERENCES etoro_statements(id),
    action       TEXT,                       -- instrument, e.g. "Apple (AAPL)"
    type         TEXT,                       -- Stocks | CFD | Crypto
    long_short   TEXT,
    amount       REAL,
    units        REAL,
    open_date    TEXT,
    close_date   TEXT,
    close_year   INTEGER,
    leverage     REAL,
    profit_usd   REAL,
    profit_eur   REAL,
    isin         TEXT,
    copied_from  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_etoro_cp_year ON etoro_closed_positions(close_year);
  CREATE INDEX IF NOT EXISTS idx_etoro_cp_type ON etoro_closed_positions(type);

  -- Dividend payments with foreign withholding tax (feeds 2047 + crédit d'impôt).
  CREATE TABLE IF NOT EXISTS etoro_dividends (
    id           TEXT PRIMARY KEY,           -- hash(position_id|date|net_eur)
    statement_id INTEGER NOT NULL REFERENCES etoro_statements(id),
    pay_date     TEXT,
    pay_year     INTEGER,
    instrument   TEXT,
    isin         TEXT,
    net_div_usd  REAL,
    net_div_eur  REAL,
    currency     TEXT,
    wht_rate     TEXT,
    wht_usd      REAL,
    wht_eur      REAL,
    position_id  TEXT,
    type         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_etoro_div_year ON etoro_dividends(pay_year);

  -- Full ledger (deposits / withdrawals / fees / FX conversion). Kept for the
  -- cash trail; aggregated per-year into etoro_tax_year.
  CREATE TABLE IF NOT EXISTS etoro_activity (
    id            TEXT PRIMARY KEY,          -- hash(statement_id|rownum)
    statement_id  INTEGER NOT NULL REFERENCES etoro_statements(id),
    date          TEXT,
    year          INTEGER,
    type          TEXT,
    details       TEXT,
    amount        REAL,
    realized_chg  REAL,
    balance       REAL,
    position_id   TEXT,
    asset_type    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_etoro_act_year ON etoro_activity(year);
  CREATE INDEX IF NOT EXISTS idx_etoro_act_type ON etoro_activity(type);

  -- Whole-period category P&L as reported by eToro (reconciliation reference).
  CREATE TABLE IF NOT EXISTS etoro_financial_summary (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES etoro_statements(id),
    line_name    TEXT,
    amount_usd   REAL,
    amount_eur   REAL,
    tax_rate     REAL,
    UNIQUE(statement_id, line_name)
  );

  -- DERIVED deliverable: one row per fiscal year, mapped to the French forms.
  CREATE TABLE IF NOT EXISTS etoro_tax_year (
    year              INTEGER PRIMARY KEY,
    account_held      INTEGER NOT NULL DEFAULT 1,
    stocks_pnl_eur    REAL NOT NULL DEFAULT 0,
    cfd_pnl_eur       REAL NOT NULL DEFAULT 0,
    crypto_pnl_eur    REAL NOT NULL DEFAULT 0,
    dividends_eur     REAL NOT NULL DEFAULT 0,
    dividends_wht_eur REAL NOT NULL DEFAULT 0,
    deposits_eur      REAL NOT NULL DEFAULT 0,
    withdrawals_eur   REAL NOT NULL DEFAULT 0,
    fx_fees_eur       REAL NOT NULL DEFAULT 0,
    n_positions       INTEGER NOT NULL DEFAULT 0,
    n_dividends       INTEGER NOT NULL DEFAULT 0,
    computed_at       TEXT NOT NULL DEFAULT (datetime('now')),
    notes             TEXT
  );
`);

// ─── Parsing helpers ─────────────────────────────────────────────────────────

// eToro dates look like "DD/MM/YYYY HH:MM:SS" or "DD/MM/YYYY".
// Returns { iso, year } or { iso: raw, year: null } if unparseable.
export function parseEtoroDate(raw) {
  if (!raw || typeof raw !== "string") return { iso: null, year: null };
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return { iso: raw, year: null };
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
  return { iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`, year: Number(yyyy) };
}

// Coerce a spreadsheet cell to a number; eToro uses "-" / "" / "N/A" for blanks
// and renders NEGATIVES IN PARENTHESES, e.g. "(17.03)" = -17.03 (per the
// statement footnote). Missing the brackets silently drops every loss.
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  let s = String(v).trim();
  if (s === "" || s === "-" || s.toUpperCase() === "N/A") return null;
  let sign = 1;
  const br = s.match(/^\((.*)\)$/); // (x) → negative
  if (br) { sign = -1; s = br[1]; }
  s = s.replace(/[,\s$€%]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

export function hashRow(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

// ─── Upserts (idempotent) ────────────────────────────────────────────────────

const upStatement = db.prepare(`
  INSERT INTO etoro_statements
    (file_name, file_hash, holder_name, username, institution, account_currency, period_start, period_end)
  VALUES (@file_name, @file_hash, @holder_name, @username, @institution, @account_currency, @period_start, @period_end)
  ON CONFLICT(file_hash) DO UPDATE SET
    holder_name=excluded.holder_name, username=excluded.username,
    institution=excluded.institution, account_currency=excluded.account_currency,
    period_start=excluded.period_start, period_end=excluded.period_end
`);

export function upsertStatement(row) {
  upStatement.run(row);
  return db.prepare(`SELECT id FROM etoro_statements WHERE file_hash = ?`).get(row.file_hash).id;
}

const upPosition = db.prepare(`
  INSERT INTO etoro_closed_positions
    (position_id, statement_id, action, type, long_short, amount, units, open_date, close_date, close_year, leverage, profit_usd, profit_eur, isin, copied_from)
  VALUES (@position_id, @statement_id, @action, @type, @long_short, @amount, @units, @open_date, @close_date, @close_year, @leverage, @profit_usd, @profit_eur, @isin, @copied_from)
  ON CONFLICT(position_id) DO UPDATE SET
    statement_id=excluded.statement_id, action=excluded.action, type=excluded.type,
    long_short=excluded.long_short, amount=excluded.amount, units=excluded.units,
    open_date=excluded.open_date, close_date=excluded.close_date, close_year=excluded.close_year,
    leverage=excluded.leverage, profit_usd=excluded.profit_usd, profit_eur=excluded.profit_eur,
    isin=excluded.isin, copied_from=excluded.copied_from
`);

const upDividend = db.prepare(`
  INSERT INTO etoro_dividends
    (id, statement_id, pay_date, pay_year, instrument, isin, net_div_usd, net_div_eur, currency, wht_rate, wht_usd, wht_eur, position_id, type)
  VALUES (@id, @statement_id, @pay_date, @pay_year, @instrument, @isin, @net_div_usd, @net_div_eur, @currency, @wht_rate, @wht_usd, @wht_eur, @position_id, @type)
  ON CONFLICT(id) DO UPDATE SET
    statement_id=excluded.statement_id, pay_date=excluded.pay_date, pay_year=excluded.pay_year,
    instrument=excluded.instrument, isin=excluded.isin, net_div_usd=excluded.net_div_usd,
    net_div_eur=excluded.net_div_eur, currency=excluded.currency, wht_rate=excluded.wht_rate,
    wht_usd=excluded.wht_usd, wht_eur=excluded.wht_eur, position_id=excluded.position_id, type=excluded.type
`);

const upActivity = db.prepare(`
  INSERT INTO etoro_activity
    (id, statement_id, date, year, type, details, amount, realized_chg, balance, position_id, asset_type)
  VALUES (@id, @statement_id, @date, @year, @type, @details, @amount, @realized_chg, @balance, @position_id, @asset_type)
  ON CONFLICT(id) DO UPDATE SET
    statement_id=excluded.statement_id, date=excluded.date, year=excluded.year, type=excluded.type,
    details=excluded.details, amount=excluded.amount, realized_chg=excluded.realized_chg,
    balance=excluded.balance, position_id=excluded.position_id, asset_type=excluded.asset_type
`);

const upFinSummary = db.prepare(`
  INSERT INTO etoro_financial_summary (statement_id, line_name, amount_usd, amount_eur, tax_rate)
  VALUES (@statement_id, @line_name, @amount_usd, @amount_eur, @tax_rate)
  ON CONFLICT(statement_id, line_name) DO UPDATE SET
    amount_usd=excluded.amount_usd, amount_eur=excluded.amount_eur, tax_rate=excluded.tax_rate
`);

export const insertPositions   = db.transaction((rows) => rows.forEach((r) => upPosition.run(r)));
export const insertDividends   = db.transaction((rows) => rows.forEach((r) => upDividend.run(r)));
export const insertActivity    = db.transaction((rows) => rows.forEach((r) => upActivity.run(r)));
export const insertFinSummary  = db.transaction((rows) => rows.forEach((r) => upFinSummary.run(r)));

// ─── Per-year aggregation (the deliverable) ──────────────────────────────────

// Activity Type strings (as they appear in the Account Activity sheet) that
// represent EXTERNAL cash in/out and the FX conversion fees on them. Internal
// "Transfer: USD > EUR" / "EUR > USD" moves between the trading and money
// wallets are deliberately excluded — they aren't deposits or withdrawals.
const DEPOSIT_TYPES = new Set(["Deposit"]);
const WITHDRAW_TYPES = new Set(["Withdraw Request", "Withdrawal"]);
const FXFEE_TYPES = new Set(["Deposit Conversion Fee", "Withdrawal Conversion Fee"]);

// Rebuild etoro_tax_year from the raw tables. Returns the rows it wrote.
export const computeTaxYears = db.transaction(() => {
  const pos = db.prepare(`
    SELECT close_year AS year, type,
           SUM(profit_eur) AS pnl, COUNT(*) AS n
    FROM etoro_closed_positions
    WHERE close_year IS NOT NULL
    GROUP BY close_year, type
  `).all();

  const divs = db.prepare(`
    SELECT pay_year AS year,
           SUM(net_div_eur) AS net, SUM(wht_eur) AS wht, COUNT(*) AS n
    FROM etoro_dividends
    WHERE pay_year IS NOT NULL
    GROUP BY pay_year
  `).all();

  const acts = db.prepare(`
    SELECT year, type, SUM(amount) AS total
    FROM etoro_activity
    WHERE year IS NOT NULL
    GROUP BY year, type
  `).all();

  const years = {};
  const y = (yr) => (years[yr] ??= {
    year: yr, account_held: 1,
    stocks_pnl_eur: 0, cfd_pnl_eur: 0, crypto_pnl_eur: 0,
    dividends_eur: 0, dividends_wht_eur: 0,
    deposits_eur: 0, withdrawals_eur: 0, fx_fees_eur: 0,
    n_positions: 0, n_dividends: 0, notes: null,
  });

  for (const p of pos) {
    const row = y(p.year);
    if (p.type === "Stocks") row.stocks_pnl_eur += p.pnl || 0;
    else if (p.type === "Crypto") row.crypto_pnl_eur += p.pnl || 0;
    else row.cfd_pnl_eur += p.pnl || 0; // CFD / TRS / anything else
    row.n_positions += p.n;
  }
  for (const d of divs) {
    const row = y(d.year);
    row.dividends_eur += d.net || 0;
    row.dividends_wht_eur += d.wht || 0;
    row.n_dividends += d.n;
  }
  for (const a of acts) {
    const row = y(a.year);
    if (DEPOSIT_TYPES.has(a.type)) row.deposits_eur += a.total || 0;
    else if (WITHDRAW_TYPES.has(a.type)) row.withdrawals_eur += a.total || 0;
    else if (FXFEE_TYPES.has(a.type)) row.fx_fees_eur += a.total || 0;
  }

  const ins = db.prepare(`
    INSERT INTO etoro_tax_year
      (year, account_held, stocks_pnl_eur, cfd_pnl_eur, crypto_pnl_eur, dividends_eur, dividends_wht_eur, deposits_eur, withdrawals_eur, fx_fees_eur, n_positions, n_dividends, computed_at, notes)
    VALUES (@year, @account_held, @stocks_pnl_eur, @cfd_pnl_eur, @crypto_pnl_eur, @dividends_eur, @dividends_wht_eur, @deposits_eur, @withdrawals_eur, @fx_fees_eur, @n_positions, @n_dividends, datetime('now'), @notes)
    ON CONFLICT(year) DO UPDATE SET
      account_held=excluded.account_held, stocks_pnl_eur=excluded.stocks_pnl_eur,
      cfd_pnl_eur=excluded.cfd_pnl_eur, crypto_pnl_eur=excluded.crypto_pnl_eur,
      dividends_eur=excluded.dividends_eur, dividends_wht_eur=excluded.dividends_wht_eur,
      deposits_eur=excluded.deposits_eur, withdrawals_eur=excluded.withdrawals_eur,
      fx_fees_eur=excluded.fx_fees_eur, n_positions=excluded.n_positions,
      n_dividends=excluded.n_dividends, computed_at=datetime('now'), notes=excluded.notes
  `);
  const out = Object.values(years).sort((a, b) => a.year - b.year);
  out.forEach((r) => ins.run(r));
  return out;
});

// ─── Queries (for API / dashboard) ───────────────────────────────────────────

export function getTaxYears() {
  return db.prepare(`SELECT * FROM etoro_tax_year ORDER BY year`).all();
}

export function getTaxYear(year) {
  return db.prepare(`SELECT * FROM etoro_tax_year WHERE year = ?`).get(Number(year));
}

export function getStatement() {
  return db.prepare(`SELECT * FROM etoro_statements ORDER BY imported_at DESC LIMIT 1`).get();
}

export function getFinancialSummary(statementId) {
  return db.prepare(`SELECT line_name, amount_usd, amount_eur, tax_rate FROM etoro_financial_summary WHERE statement_id = ? ORDER BY id`).all(statementId);
}

// Closed positions for a given year (detail for the 2074 worksheet).
export function getPositionsByYear(year) {
  return db.prepare(`
    SELECT position_id, action, type, open_date, close_date, amount, units, profit_eur, profit_usd, isin
    FROM etoro_closed_positions WHERE close_year = ? ORDER BY close_date
  `).all(Number(year));
}

export function getDividendsByYear(year) {
  return db.prepare(`
    SELECT pay_date, instrument, isin, net_div_eur, wht_rate, wht_eur, type
    FROM etoro_dividends WHERE pay_year = ? ORDER BY pay_date
  `).all(Number(year));
}

// USD structural reconciliation + EUR tax-basis comparison vs eToro's
// whole-period Financial Summary, for the given statement.
export function getReconciliation(statementId) {
  const fin = Object.fromEntries(
    getFinancialSummary(statementId).map((l) => [l.line_name, l]),
  );
  const ours = db.prepare(`
    SELECT CASE WHEN type IN ('Stocks','Crypto') THEN type ELSE 'CFD' END AS cls,
           ROUND(SUM(profit_usd),2) AS usd, ROUND(SUM(profit_eur),2) AS eur
    FROM etoro_closed_positions GROUP BY cls
  `).all();
  const byCls = Object.fromEntries(ours.map((r) => [r.cls, r]));
  const map = { Stocks: "Stocks (Profit or Loss)", CFD: "CFDs (Profit or Loss)", Crypto: "Crypto (Profit or Loss)" };
  return ["Stocks", "CFD", "Crypto"].map((cls) => ({
    cls,
    ours_usd: byCls[cls]?.usd ?? 0,
    etoro_usd: fin[map[cls]]?.amount_usd ?? 0,
    ours_eur: byCls[cls]?.eur ?? 0,
    etoro_eur: fin[map[cls]]?.amount_eur ?? 0,
  }));
}

// ─── Statement ingestion (shared by the CLI script and the upload route) ─────

// Read a sheet as objects keyed by its header row; raw:false so eToro's
// bracketed negatives come through as strings for num() to handle.
function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found. Sheets present: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
}
// Read a sheet as a raw matrix (for the key/value Account Summary).
function sheetMatrix(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet "${name}" not found`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
}

function buildPositions(wb, statementId) {
  return sheetRows(wb, "Closed Positions").map((r) => {
    const close = parseEtoroDate(r["Close Date"]);
    return {
      position_id: String(r["Position ID"]).trim(),
      statement_id: statementId,
      action: r["Action"] || null,
      type: r["Type"] || null,
      long_short: r["Long / Short"] || null,
      amount: num(r["Amount"]),
      units: num(r["Units / Contracts"]),
      open_date: parseEtoroDate(r["Open Date"]).iso,
      close_date: close.iso,
      close_year: close.year,
      leverage: num(r["Leverage"]),
      profit_usd: num(r["Profit(USD)"]),
      profit_eur: num(r["Profit(EUR)"]),
      isin: r["ISIN"] || null,
      copied_from: r["Copied From"] || null,
    };
  }).filter((p) => p.position_id && p.position_id !== "undefined");
}

function buildDividends(wb, statementId) {
  return sheetRows(wb, "Dividends").map((r) => {
    const pay = parseEtoroDate(r["Date of Payment"]);
    const pos = String(r["Position ID"] || "").trim();
    const netEur = num(r["Net Dividend Received (EUR)"]);
    return {
      id: hashRow(statementId, pos, r["Date of Payment"], netEur),
      statement_id: statementId,
      pay_date: pay.iso,
      pay_year: pay.year,
      instrument: (r["Instrument Name"] || "").toString().trim() || null,
      isin: r["ISIN"] || null,
      net_div_usd: num(r["Net Dividend Received (USD)"]),
      net_div_eur: netEur,
      currency: r["Currency"] || null,
      wht_rate: (r["Withholding Tax Rate (%)"] || "").toString().trim() || null,
      wht_usd: num(r["Withholding Tax Amount (USD)"]),
      wht_eur: num(r["Withholding Tax Amount (EUR)"]),
      position_id: pos || null,
      type: r["Type"] || null,
    };
  });
}

function buildActivity(wb, statementId) {
  return sheetRows(wb, "Account Activity").map((r, i) => {
    const d = parseEtoroDate(r["Date"]);
    return {
      id: hashRow(statementId, i, r["Date"], r["Type"], r["Amount"]),
      statement_id: statementId,
      date: d.iso,
      year: d.year,
      type: (r["Type"] || "").toString().trim() || null,
      details: r["Details"] || null,
      amount: num(r["Amount"]),
      realized_chg: num(r["Realized Equity Change"]),
      balance: num(r["Balance"]),
      position_id: String(r["Position ID"] || "").trim() || null,
      asset_type: r["Asset type"] || null,
    };
  });
}

function buildFinSummary(wb, statementId) {
  return sheetMatrix(wb, "Financial Summary").slice(1) // drop header row
    .filter((r) => r[0])
    .map((r) => ({
      statement_id: statementId,
      line_name: String(r[0]).replace(/\s+/g, " ").trim(),
      amount_usd: num(r[1]),
      amount_eur: num(r[2]),
      tax_rate: num(r[3]),
    }));
}

// Parse the Account Summary key/value block into the statement identity row.
function buildStatementRow(wb, fileName, fileHash) {
  const kv = {};
  for (const r of sheetMatrix(wb, "Account Summary")) {
    if (r.length >= 2 && r[0]) kv[String(r[0]).trim()] = r[1];
  }
  return {
    file_name: fileName,
    file_hash: fileHash,
    holder_name: (kv["Name"] || "").toString().trim() || null,
    username: (kv["Username"] || "").toString().trim() || null,
    institution: "eToro (Europe) Ltd, Cyprus (CySEC #109/10)",
    account_currency: (kv["Currency"] || "").toString().trim() || null,
    period_start: parseEtoroDate((kv["Start Date"] || "").toString()).iso,
    period_end: parseEtoroDate((kv["End Date"] || "").toString()).iso,
  };
}

// Ingest an eToro statement .xlsx (as a Buffer) into the etoro_* tables and
// rebuild the per-year aggregation. Idempotent: re-importing the same file
// updates rows in place. With { dryRun } it parses and counts without writing.
// Throws if the workbook is missing the expected eToro sheets.
export function importStatementFromBuffer(buf, { fileName = "statement.xlsx", dryRun = false } = {}) {
  const fileHash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (e) {
    throw new Error(`Not a readable .xlsx file: ${e.message}`);
  }
  const statement = buildStatementRow(wb, fileName, fileHash);

  if (dryRun) {
    return {
      dryRun: true, statement,
      counts: {
        positions: buildPositions(wb, 0).length,
        dividends: buildDividends(wb, 0).length,
        activity: buildActivity(wb, 0).length,
        finSummary: buildFinSummary(wb, 0).length,
      },
    };
  }

  const statementId = upsertStatement(statement);
  const positions = buildPositions(wb, statementId);
  const dividends = buildDividends(wb, statementId);
  const activity = buildActivity(wb, statementId);
  const finSummary = buildFinSummary(wb, statementId);

  insertPositions(positions);
  insertDividends(dividends);
  insertActivity(activity);
  insertFinSummary(finSummary);

  const taxYears = computeTaxYears();
  return {
    statementId,
    statement: { ...statement, id: statementId },
    counts: {
      positions: positions.length,
      dividends: dividends.length,
      activity: activity.length,
      finSummary: finSummary.length,
    },
    taxYears,
    reconciliation: getReconciliation(statementId),
  };
}

export default db;
