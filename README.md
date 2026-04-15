# PM Agent

Agente personal de gestión de proyectos. Telegram + Claude Sonnet + SQLite.

## Stack

- **Claude Sonnet 4.5** — 200K contexto, tool use nativo
- **Telegram** — interfaz móvil con push notifications
- **SQLite** — memoria persistente (proyectos, tareas, historial)
- **Notion** — sync de tareas (Fase 3)
- **Google Calendar + Gmail** — acciones (Fase 3)
- **node-cron** — briefing diario y follow-ups automáticos

## Setup local

```bash
git clone <repo>
cd pm-agent
npm install
cp .env.example .env
# Rellena las variables en .env
```

### Crear el bot de Telegram

1. Habla con @BotFather en Telegram
2. `/newbot` → sigue los pasos → copia el token
3. Envía un mensaje al bot, luego visita:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copia tu `chat_id` del JSON de respuesta

### Correr en local

```bash
npm run dev
```

### Test de memoria (sin Telegram)

```bash
node src/memory.js
```

## Deploy en Railway

```bash
npm install -g railway
railway login
railway init
railway up
```

Variables de entorno en Railway Dashboard:
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DB_PATH` = `/data/pm.db`

**Importante:** Crea un Volume en Railway montado en `/data` para que el SQLite persista entre deploys.

## Fases de build

- [x] Fase 1 — Esqueleto + SQLite memory
- [x] Fase 2 — Agent loop con tools básicas
- [x] Fase 3 — Notion + Google Calendar + Gmail (tools/ listas, activar en agent.js)
- [ ] Fase 4 — Telegram streaming
- [ ] Fase 5 — Prompt templates guardados en SQLite

## Comandos disponibles (ejemplos)

```
"Qué tengo pendiente hoy?"
"Crea el proyecto PortPagos Q2 con las tareas de MVP"
"Marca como done la tarea 3"
"Qué está bloqueado?"
"Dame el resumen de la semana"
"Crea una tarea: revisar el ICDB report con Gwenael, viernes, alta prioridad"
```
