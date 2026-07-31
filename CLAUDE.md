# CLAUDE.md

Guidance for working in this repo. Keep this file short and high-signal.

## What this is
MVP-Assistant — a personal PM + finance assistant. A Telegram (and optional
WhatsApp) bot backed by Claude/LLMs, plus a private web dashboard. Single user.
Deployed on Railway.

## Run / dev
- `npm start` → `node server.js` (the entry point)
- `npm run dev` → `node --watch server.js`
- Node **22** required (see the pin gotcha below). Package manager: npm. ESM (`"type": "module"`) — use `import`, not `require`.
- Config via `.env` (see `.env.example`). Needs at minimum `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` or the process exits on boot.

## Architecture
`server.js` is the entry: an Express server (Telegram/WhatsApp webhooks + the
dashboard + JSON APIs) with an in-process `node-cron` scheduler. It imports
everything else. There is no build step.

- `memory.js` — **SQLite data layer**. Owns the single `better-sqlite3` `db` and
  every table/query. Other modules get the connection via `import db from "./memory.js"`.
- `agent.js` — the Claude agent loop (tools, routing) · `llm.js` — multi-provider
  fallback chain (Gemini → Groq → DeepSeek) · `stt.js` — voice transcription.
- `transactions.js` / `bankCsv.js` — bank statement parsing & categorization ·
  `email.js` — IMAP bank-email ingestion · `fx.js` — FX rates.
- `dashboard.js` — server-rendered web dashboard (one big HTML string, Tailwind
  CDN + Chart.js) · `ceiling.js` — micro-entreprise CA ceiling tracking ·
  `proactive.js` / `advisor.js` — scheduled briefings.
- `etoro.js` / `etoroPage.js` — eToro foreign-account tax module (`/etoro`).
- `scripts/*.mjs` — one-off CLI importers/maintenance (run with `node scripts/x.mjs`).

## Conventions
- **Data:** all persistence is SQLite via `memory.js`. New tables: add a
  `CREATE TABLE IF NOT EXISTS` to a `db.exec(...)` block; migrations are done
  inline with `PRAGMA table_info(...)` + `ALTER TABLE ... ADD COLUMN`. A feature
  module may define its own tables by importing the shared `db` (see `etoro.js`).
- **Dashboard / API routes** live in `server.js` and are gated by
  `requireKey(req, res, "DASH_KEY")` (a `?key=` query param — single-user auth).
  Webhooks use separate header/path secrets; any domain-level auth MUST exempt
  `/webhook/*`. The dashboard page reads `key` from the URL and threads it onto
  its own fetches/links.
- **Language:** the **dashboard UI is English-only** (a deliberate convention —
  see README/PENDIENTES). The Telegram/WhatsApp bot replies in **Spanish**. Code
  comments are mixed ES/EN; match the file you're in.
- **Money:** stored as `REAL`; be explicit about currency (EUR vs USD) and, for
  anything tax-facing, convert per-transaction at the transaction's own FX date.
- **Don't commit** `data/pm.db` (gitignored) or secrets.

## Deploy (Railway)
- The service is **`MVP-Assistant` inside the Railway project "AI Agents"** (not
  its own project — won't show in `railway list`). Link with
  `railway link -p "AI Agents" -s "MVP-Assistant" -e production`.
- **Deploys on push to GitHub `main`** (`maovarela/MVP-Assistant`). A push
  auto-builds; `railway logs --build` shows status. Healthcheck: `/healthz`.
- Production DB is the Railway **volume** at `/data/pm.db` (`DB_PATH`). It is a
  *different database* from local `./data/pm.db` — local CLI imports do NOT
  reach production. To load data into prod, use an authenticated upload route
  (`POST /import/csv`, `/import/pdf`, eToro's `POST /api/etoro/import`), not the
  CLI. `scripts/sync-bank-folders.mjs <Amex> <Revolut> <BNP>` walks the statement
  folders and posts each new file (content-hash cache in `scripts/.processed.json`);
  run it under `railway run` so the prod `INTERNAL_IMPORT_KEY` is injected.

## Gotchas (these have bitten us)
- **Node version is pinned to `"22.x"` in `package.json` engines — do not loosen
  it.** A range like `">=20"` makes Nixpacks grab Node 24, which has no prebuilt
  `better-sqlite3` binary, so it compiles from source with node-gyp — and the
  build image has no Python → **every deploy fails**. This silently killed prod
  for two weeks once.
- eToro statements render **negative numbers in parentheses** `(1.23)`; parse as
  negative (see `num()` in `etoro.js`), or you silently drop every loss.
- **Revolut: use the *monthly* export, never the consolidated one, for recurring
  uploads.** Only the monthly export gets a balance check (per-row continuity);
  the consolidated year-to-date layout isn't balance-ordered so it returns
  `reconciled: null` + a `warning` and goes in unverified. Both parse fine —
  the difference is invisible unless you look at `reconciled`.
- **Two CSV import routes, and they are not interchangeable.** `/import/csv` =
  raw bank exports (auto-detects Amex/Revolut → deterministic parser).
  `/import/normalized` = only our own `date,merchant,amount,…` schema. A raw
  export posted to `/import/normalized` matches no column and skips every row;
  it now 400s, but for months it returned `0 inserted, N skipped` — identical
  to "all duplicates" — and silently dropped whole statements.
- **A reverted Revolut pre-authorization survives every row-level dedup.** It was
  real when an older export was imported; Revolut later reversed it and dropped
  it from history, and the settled row differs in amount or date so the natural
  key `(date, amount, currency, merchant)` never matches. Only an aggregate
  balance anchor catches these — `scripts/audit-revolut.mjs` found 21 such rows
  (€255.96) in 2026-01..05. Re-run it after any bulk Revolut load.
- **Never collapse "duplicate" and "couldn't parse" into one counter.** Import
  results carry `duplicates` (benign) and `unparsed` (a statement row was
  DROPPED) separately; `skipped` is kept only as their sum for old callers.
  Conflating them is what hid the bug above.
- Background sockets (IMAP/SMTP) emit late errors; `server.js` has
  `uncaughtException`/`unhandledRejection` handlers to keep the webhook server up
  — don't remove them.
