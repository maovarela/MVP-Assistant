# MVP-Assistant

Personal PM + finance agent. Telegram bot powered by Claude Sonnet 4.5 with persistent SQLite memory and automated bank-statement ingestion.

## What it does

- 📋 **Project & task tracking** — projects, tasks with priorities, due dates, status
- 💰 **Spending intelligence** — auto-parses bank notification emails (Amex, Revolut, BNP) and lets you bulk-import historical CSV/PDF statements
- 🤖 **Conversational** — ask anything in Spanish/English, agent uses tools to query DB
- 📅 **Daily briefings** — 8 AM Paris brief, 9 AM follow-ups, Sunday 6 PM weekly review
- ⚡ **Webhook-based** — instant Telegram replies, no polling lag

## Architecture

```
Telegram  ──webhook──►  Express server  ──►  Claude Sonnet 4.5  ──►  SQLite
                              │                        ▲
                              ▼                        │
                        Cron jobs                  Tool calls
                        (hourly inbox scan,
                         daily brief, weekly)
                              │
                              ▼
                       Gmail IMAP ──► Claude parser ──► transactions table
```

## Project structure

```
MVP-Assistant/
├── server.js         # Express + webhook + scheduler (entry point)
├── agent.js          # Claude tool-use loop (PM + finance tools)
├── memory.js         # SQLite layer: messages, projects, tasks, transactions
├── transactions.js   # Email/CSV/PDF parsing via Claude
├── email.js          # IMAP reader (Gmail app password)
├── google.js         # Calendar (legacy Gmail code unused — IMAP supersedes)
├── notion.js         # Notion sync (Phase 3, optional)
├── railway.json      # Railway deploy config
├── Procfile          # web: node server.js
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
   ANTHROPIC_API_KEY=sk-ant-...
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   TELEGRAM_WEBHOOK_SECRET=any-long-random-string
   GMAIL_USER=mauricio.varela.ai@gmail.com
   GMAIL_APP_PASSWORD=...
   DB_PATH=/data/pm.db
   EMAIL_BACKFILL_DAYS=90
   ```
5. Deploy → check logs for `[webhook] registered at https://...`

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

**Finance:** `list_transactions`, `spend_by_category`, `spend_by_merchant`, `monthly_totals`, `transaction_stats`, `scan_inbox_now`

## Schema

- `messages` — conversation history (last 20 fed back to Claude per turn)
- `projects` — name, description, status
- `tasks` — linked to projects, priority, status, due_date, owner
- `transactions` — date, merchant, amount (signed), currency, category, source (email/csv/pdf/manual)
- `processed_emails` — Gmail message IDs already parsed (dedup)

## Operating notes

- LLM: Anthropic only for now (no fallback chain — single API key)
- Webhook returns 200 immediately; processing happens async so Telegram doesn't retry on slow Claude calls
- SQLite file lives on Railway Volume, persists across redeploys
- `EMAIL_BACKFILL_DAYS=90` runs once on boot, scans last 90 days of inbox. Set to 0 / unset on subsequent deploys
