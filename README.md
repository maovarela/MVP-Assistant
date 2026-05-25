# MVP-Assistant

Personal PM + finance agent. Telegram bot backed by an OpenAI-compatible LLM (Gemini/Groq/DeepSeek fallback chain) with persistent SQLite memory and automated bank-statement ingestion.

## What it does

- 📋 **Project & task tracking** — projects, tasks with priorities, due dates, status
- 💰 **Spending intelligence** — auto-parses bank notification emails (Amex, Revolut, BNP) + bulk import of historical CSV/PDF statements with **per-bank deterministic parsers** (no LLM call, no sign bugs)
- 🤖 **Conversational** — ask anything in Spanish/English, agent uses tools to query DB
- 📅 **Daily briefings** — 8 AM Paris brief (now includes calendar + spending pace), 9 AM follow-ups, Sunday 6 PM weekly review, Sunday 10 AM Revolut upload nudge
- 🛎️ **Proactive watchman** — scans every 2h between 08:00 and 22:00 Paris; stays silent by default, only interrupts for anomalous charges, deadlines today, calendar conflicts, etc.
- ⚡ **Webhook-based** — instant Telegram replies, no polling lag

## Architecture (3-agent split)

```
                    ┌──────────────────────────────────────┐
                    │   SOURCES                            │
                    │   Gmail · CSV/PDF · Notion           │
                    │   Calendar (ICS) · Telegram          │
                    └──────┬─────────────────┬─────────────┘
                           │                 │
              ┌────────────▼──────┐    ┌─────▼────────────────┐
              │ ① INGESTOR        │    │ ③ PROACTIVE           │
              │ cheap LLM         │    │ smart LLM, 2h cron    │
              │ cron + uploads    │    │ snapshot → JSON       │
              │ parse → categorise│    │ "interrupt? msg?"     │
              └────────┬──────────┘    └──────┬────────────────┘
                       │                      │ only if YES
                       ▼                      ▼
              ┌────────────────────────────────────────────────┐
              │   SQLite (single source of truth)              │
              │   /data/pm.db on Railway volume                │
              └────────┬────────────────────────┬──────────────┘
                       │                        │
              ┌────────▼──────────┐             │
              │ ② ANALYST         │             │
              │ smart LLM         │             │
              │ user msg + cron   │             │
              │ tool-loop         │             │
              └────────┬──────────┘             │
                       │                        │
                       ▼                        ▼
              ┌────────────────────────────────────────────────┐
              │ OUTBOUND (broadcast → Telegram + WhatsApp*)    │
              └────────────────────────────────────────────────┘
```

See `Notion → MVP-Assistant repo` page for full Mermaid diagrams.

## Project structure

```
MVP-Assistant/
├── server.js                # Express + webhooks + scheduler + /debug/stats + /import/normalized
├── agent.js                 # ② Analyst — conversational tool-use loop
├── proactive.js             # ③ Proactive watchman — 2h scans, strict-JSON output
├── transactions.js          # ① Ingestor entrypoint — email/CSV/PDF
├── bankCsv.js               # Deterministic Amex/Revolut CSV parsers (sign-correct, multi-section)
├── dashboard.js             # HTML shell for /dashboard (Chart.js via CDN, mobile-first)
├── fx.js                    # Free FX rate fetch (exchangerate.host + open.er-api fallback)
├── memory.js                # SQLite layer: messages, projects, tasks, transactions, llm_calls
├── email.js                 # IMAP reader (Gmail app password)
├── calendar.js              # Read-only Google Calendar via ICS
├── notion.js                # Notion read access
├── mailer.js                # SMTP send (Gmail)
├── whatsapp.js              # Evolution API wrapper (gated by ENABLE_WHATSAPP, default off)
├── llm.js                   # OpenAI-compatible client w/ provider fallback chain + cooldown
├── scripts/
│   ├── import-local.mjs     # One-shot local importer for historic Amex/Revolut CSVs
│   ├── seed-budget.mjs      # One-shot seed for the budget dashboard (uses budget-seed.json)
│   └── budget-seed.example.json # Template — copy to budget-seed.json (gitignored) and edit
├── railway.json
├── Procfile                 # web: node server.js
└── package.json
```

## Setup

### 1. Gmail App Password

1. Activate **2-Step Verification** on the dedicated Gmail
2. Go to <https://myaccount.google.com/apppasswords>
3. Generate new app password ("MVP Assistant")
4. Save the 16-char string

### 2. Telegram bot

`@BotFather` → `/newbot` → save token. Your chat ID via `@userinfobot`.

### 3. Local dev

```bash
npm install
cp .env.example .env  # fill in keys
npm run dev           # starts server.js with file watch
```

### 4. Railway deploy

1. railway.app → New Project → Deploy from GitHub → `maovarela/MVP-Assistant`
2. **Settings → Networking → Generate Domain** (so `RAILWAY_PUBLIC_DOMAIN` is exposed and webhook auto-registers)
3. **Settings → Volumes → New Volume** mounted at `/data` (so SQLite persists across deploys)
4. **Variables** — paste via Raw Editor:
   ```env
   # LLM fallback chain (Gemini → Groq → DeepSeek)
   LLM_API_KEY=AIza...
   LLM_MODEL=gemini-2.0-flash
   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
   LLM_FALLBACK_1_KEY=gsk_...
   LLM_FALLBACK_1_MODEL=llama-3.3-70b-versatile
   LLM_FALLBACK_1_BASE_URL=https://api.groq.com/openai/v1
   LLM_FALLBACK_2_KEY=sk-...
   LLM_FALLBACK_2_MODEL=deepseek-chat
   LLM_FALLBACK_2_BASE_URL=https://api.deepseek.com/v1

   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   TELEGRAM_WEBHOOK_SECRET=any-long-random-string
   GMAIL_USER=mauricio.varela.ai@gmail.com
   GMAIL_APP_PASSWORD=...

   # SQLite persistence — MUST point at the mounted Railway volume.
   # Without this, every redeploy wipes the DB silently. See "Critical: persistence" below.
   DB_PATH=/data/pm.db

   # Auth for POST /import/normalized (bulk-load historic CSV — set to any random string)
   INTERNAL_IMPORT_KEY=...

   # Auth for the budget dashboard at GET /dashboard and the /api/budget mutation endpoint
   DASH_KEY=...

   # OPTIONAL — one-shot inbox backfill on first deploy. Unset after first successful run.
   # EMAIL_BACKFILL_DAYS=90
   ```
5. Deploy → check logs for `[webhook] registered at https://...`

### Critical: persistence

The bot's SQLite DB **must** live on a mounted Railway volume or every redeploy wipes everything (transactions, tasks, conversation history). Verify by curling:

```
curl https://<your-domain>/debug/stats
# → "db_path": "/data/pm.db"   ← correct
# → "db_path": "./data/pm.db"  ← BROKEN, ephemeral, fix immediately
```

## Bank statement ingestion

### Real-time (automatic, going forward)

Every hour the agent scans the inbox for new emails from Amex / Revolut / BNP. New transaction notifications are parsed by Claude and stored in `transactions`.

**To enable transaction emails on each provider:**

| Provider | How to enable transaction emails |
|---|---|
| **Revolut** | App → Profile → Notifications → enable email notifications. Or change account email to `mauricio.varela.ai@gmail.com`. |
| **Amex FR** | americanexpress.fr → Mon compte → Alertes → activate "Notification par email pour chaque opération". |
| **BNP** | mabanque.bnpparibas → Préférences → Alertes → enable email alerts on every debit/credit. |

### Historical (manual upload — one-shot)

For everything older than today, send the bot statements as **PDF or CSV attachments via Telegram**. The bot detects the file type, parses with Claude, dedupes, inserts.

**How to download statements:**

| Provider | Path |
|---|---|
| **Revolut** | App → Profile (top-left avatar) → **Statements** → choose account → date range → Generate → PDF or **Excel/CSV**. |
| **Amex FR** | americanexpress.fr → "Mes relevés" → download monthly PDF. Or "Téléchargement des opérations" → CSV. |
| **BNP** | mabanque.bnpparibas → Comptes → "Relevés de compte" (PDF). Or "Mes opérations → Télécharger" → CSV/Excel. |

**Bulk:** download every month you want, send each file to the bot. ~30 sec each. Dedup is automatic — safe to re-send.

### One-shot historical bulk import (faster than file-by-file)

For years of statements, the per-message Telegram flow is slow. Use the local importer:

```bash
node scripts/import-local.mjs \
  "/path/to/Amex/" \
  "/path/to/Revolut/"
```

Prints a JSON summary (total / by month / by category / top merchants) and writes `scripts/normalized-transactions.csv` (gitignored — financial data).

Bulk-load all rows into the bot DB in one HTTP call:

```bash
curl -sf "https://<your-domain>/import/normalized?key=$INTERNAL_IMPORT_KEY" \
  -H "content-type: text/csv" \
  --data-binary @scripts/normalized-transactions.csv
# → { "ok": true, "inserted": N, "skipped": M, "errors": 0, "total": N+M }
```

Dedup is keyed by Amex transaction reference / Revolut row hash, so re-running is safe.

### Why deterministic per-bank parsers (and not just LLM)

[bankCsv.js](bankCsv.js) ships hand-written parsers for Amex FR + Revolut consolidated exports because two real bugs surfaced with LLM-only parsing:

1. **Amex CSV signs are inverted** vs the bot's convention (positive = charge in Amex; negative = outflow in our DB). LLM batch parsing was silently storing every Amex spend as income, so spend queries returned zero.
2. **Revolut consolidated statements** contain multiple per-currency transaction tables concatenated into one file with account-summary headers in between. `csv-parse` with `columns: true` chokes on the mixed layout.

`importCsv` now auto-detects format and uses the deterministic parser when it matches; falls back to the LLM batch path for unknown banks.

## Budget dashboard (Cuentas MVP)

Open `https://<your-host>/dashboard?key=$DASH_KEY` on your phone. Replaces the manual monthly Google Sheet.

**Blocks:**
- KPIs: Ingresos · Planeado (fijos+variables) · Gasto real (transacciones) · Residual + % gastado
- Tabla de gastos fijos con budget vs actual + bar de % consumido + pill (verde/ámbar/rojo)
- Lista de gastos variables planeados
- Donut chart: gastos reales por categoría
- Bar chart: budget vs real por categoría
- Deuda: original + EUR, con total
- FOREX: USD-COP, EUR-USD, tax FR

**Cómo lo alimentas:**
1. **Inicial (una vez):** copia `scripts/budget-seed.example.json` a `scripts/budget-seed.json`, edita con tus valores del mes, luego:
   ```powershell
   $env:DASH_KEY = "tu-key"
   node scripts/seed-budget.mjs
   ```
2. **Día a día por Telegram:** habla con el bot.
   - `"mi arriendo este mes son 1600€"` → `set_fixed_expense`
   - `"el dolar está a 4100"` → `set_fx_rate`
   - `"mi salario neto este mes fueron 3700"` → `set_income`
   - `"añade gasto variable: medicina 70"` → `add_variable_expense`
   - `"cómo voy este mes"` → `get_budget_summary` con totales + top categorías
3. **FX automático:** un cron del 1 de cada mes a las 06:00 Paris pulla `exchangerate.host` y guarda el row. Tus entradas manuales (source='manual') nunca son sobrescritas.

## Bot commands & natural language

```
"qué tengo pendiente esta semana?"
"cuánto he gastado este mes?"
"en qué gasto más?"
"cuánto gasté en restaurantes en marzo?"
"resumen del último trimestre"
"crea tarea: enviar reporte ICDB el viernes, alta prioridad"
"marca como done la tarea 3"
"weekly review"
```

## Tools available to the agent

**Tasks/projects:** `create_project`, `list_projects`, `create_task`, `update_task_status`, `list_tasks`, `get_daily_summary`

**Finance:** `list_transactions`, `spend_by_category`, `spend_by_merchant`, `monthly_totals`, `transaction_stats`, `spend_pace`, `scan_inbox_now`

**Budget planning:** `set_fx_rate`, `set_income`, `set_fixed_expense`, `add_variable_expense`, `set_debt`, `get_budget_summary`

**Notion:** `search_notion`, `read_notion_page`, `query_notion_database`

**Google Calendar (read-only):** `list_calendar_events`, `search_calendar`

**Gmail send:** `send_email` (uses same App Password as IMAP)

## Connecting Notion + Calendar

### Notion
1. https://notion.so/my-integrations → New integration → name: `MVP Assistant` → submit
2. Copy the secret token → set `NOTION_API_KEY=ntn_...` in Railway
3. **Share pages/databases with the integration**: open each page → `···` menu → Connections → Connect to → MVP Assistant. (Connect a parent page and the integration inherits access to children.)

### Google Calendar
1. calendar.google.com → Settings → scroll past "Add calendar" / "Import & export" → find **Settings for my calendars** → click the calendar you want
2. Scroll down to **Integrate calendar** section
3. Copy "Secret address in iCal format"
4. Set `GOOGLE_CALENDAR_ICS_URL=https://...basic.ics` in Railway. Multiple calendars: comma-separated.

## Schema

- `messages` — conversation history (last 20 fed back to Claude per turn)
- `projects` — name, description, status
- `tasks` — linked to projects, priority, status, due_date, owner
- `transactions` — date, merchant, amount (signed), currency, category, source (email/csv/pdf/manual)
- `processed_emails` — Gmail message IDs already parsed (dedup)

## HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/` | Liveness — `{ status }` |
| GET  | `/healthz` | Railway healthcheck |
| GET  | `/debug/stats` | Aggregates: tx count, by_source, by_sign, by_month, latest_10, spend_pace, `db_path`. Read-only, no PII. |
| GET  | `/dashboard?key=$DASH_KEY[&period=YYYY-MM]` | Budget dashboard HTML (replaces the "Cuentas MVP" Sheet). Mobile-friendly. |
| GET  | `/api/dashboard.json?key=$DASH_KEY[&period=YYYY-MM]` | Dashboard JSON payload (incomes, fixed/variable expenses, debts, FX, totals, donut data). |
| POST | `/api/budget?key=$DASH_KEY` | Mutate a budget row. JSON body `{period, kind: 'income'\|'fixed'\|'variable'\|'debt'\|'fx', payload}`. |
| POST | `/webhook/telegram` | Telegram update webhook (HMAC-secret-validated) |
| POST | `/webhook/whatsapp/<secret>` | Evolution API webhook (gated by `ENABLE_WHATSAPP`) |
| POST | `/import/normalized?key=$INTERNAL_IMPORT_KEY` | Bulk-load `text/csv` produced by `scripts/import-local.mjs`. Body limit 20 MB. |

## Scheduled jobs (Europe/Paris)

| Cron | What |
|---|---|
| `0 6 1 * *` | Monthly FX rate refresh (skips months whose row is `source='manual'`) |
| `5 * * * *` | Hourly IMAP scan for bank transaction emails (ingestor) |
| `0 8 * * *` | Daily briefing — calendar (1d ahead) + tasks + spending pace + top categories |
| `0 9 * * *` | Follow-ups for tasks due in next 48h |
| `0 10 * * 0` | Sunday Revolut CSV upload nudge (per-tx alerts not supported) |
| `0 18 * * 0` | Sunday weekly review — calendar (7d ahead) + completions/blockers + week spend |
| `0 8,10,12,14,16,18,20,22 * * *` | Proactive scan — silent by default, broadcasts only if `interrupt=true` |

## Operating notes

- **LLM fallback chain** (matches Runaldo): Gemini → Groq → DeepSeek. All speak the OpenAI Chat Completions API. First success wins. PDF parsing only works on Gemini (Groq's Llama-3.3 and DeepSeek-chat don't support PDF input).
- Webhook returns 200 immediately; processing happens async so Telegram doesn't retry on slow LLM calls
- SQLite file lives on Railway Volume, persists across redeploys
- `EMAIL_BACKFILL_DAYS=90` runs once on boot, scans last 90 days of inbox. Set to 0 / unset on subsequent deploys
