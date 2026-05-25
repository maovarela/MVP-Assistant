# Pendientes — MVP-Assistant

## Estado actual

- **Telegram**: funciona, canal principal del agente
- **Email (Gmail dedicado)**: funciona — la cuenta fue deshabilitada 2026-05-12 y restaurada vía appeal 2026-05-18
- **Notion, Calendar (ICS), tasks, projects**: funcionando
- **Transacciones**: parsers deterministas para Amex FR + Revolut (`bankCsv.js`). El parser viejo basado solo en LLM tenía dos bugs grandes (ver "Aprendizajes 2026-05-24" abajo).
- **3-agent split shipped 2026-05-24**: Ingestor (`transactions.js`/`email.js`) + Analyst (`agent.js`) + Proactive (`proactive.js`). Notion: organigram → `MVP-Assistant — Organigram` page.
- **Proactive watchman**: corre cada 2h entre 08:00–22:00 Paris. Default silencio. Snapshot → JSON estricto → `broadcast()` solo si `interrupt=true`.
- **Daily briefing**: ahora incluye calendario (1d ahead) + `spend_pace` (gasto MTD, proyección fin de mes, top 3 categorías con delta % vs mismo periodo mes anterior).
- **Bulk import histórico**: `scripts/import-local.mjs` + endpoint `POST /import/normalized?key=$INTERNAL_IMPORT_KEY`. Soporta cargar años de CSV en un solo curl.
- **WhatsApp**: **diferido** — código integrado pero apagado por flag (`ENABLE_WHATSAPP=false` default). Detalles abajo.

## ⚠️ Aprendizajes 2026-05-24 (no repetir)

### Railway volume / persistencia
- El bot perdió **todos los datos uploadeados** porque el volumen no estaba montado en Railway. El código hace fallback silencioso a `./data/pm.db` (efímero) si `DB_PATH` no está seteado.
- **Mitigación**: el endpoint `GET /debug/stats` devuelve `db_path` en la respuesta. Si dice `./data/pm.db`, está roto — fix inmediato: montar volume en `/data` + setear `DB_PATH=/data/pm.db`.
- **TODO opcional**: añadir un guard al boot que abortee el proceso (o mande un broadcast crítico) si `DB_PATH` no apunta a un volumen montado. Evita perder horas de uploads otra vez.

### Amex CSV sign convention
- Amex FR exporta cargos como **positivos** y pagos de factura como **negativos** — al revés de lo que asume el bot (`amount < 0` = gasto).
- Cuando se usaba solo el parser LLM, los cargos se almacenaban como ingresos. Las queries de gasto devolvían 0 aunque hubiera datos.
- **Solución**: `bankCsv.js` parser determinista que flippea signo. `importCsv` ahora detecta formato Amex y usa esta ruta sin LLM.

### Revolut consolidated statements multi-section
- Un solo CSV "consolidated statement" de Revolut contiene 3+ tablas de transacciones (una por cuenta/moneda) concatenadas con headers de account-summary en medio.
- `csv-parse` con `columns: true` no puede digerir el layout mixto — se rompe o devuelve fragmentos.
- **Solución**: parser custom en `bankCsv.js` que escanea línea por línea, trackea la moneda activa por header `Personal Account (XXX)`, y parsea cada bloque como CSV independiente.

### Revolut no tiene email-on-transaction
- Lo mataron hace ~2 años. Solo push notification. Para tener gastos en-mes hay que subir CSV manual.
- Mitigación: cron de domingo a las 10:00 Paris que pinge "sube el CSV de Revolut" antes del weekly review de las 18:00.

## WhatsApp — por qué quedó diferido

Se exploró integrar WhatsApp como segundo canal usando Evolution API self-hosted (Baileys bajo el capó). Llegó hasta funcionar pero se descartó por una limitación conceptual de WhatsApp Web, no técnica.

### Lo que se hizo y funcionó
1. Deploy de Evolution API v1.8.2 en Railway (servicio aparte del MVP-Assistant, mismo proyecto)
2. Auth con `AUTHENTICATION_API_KEY`, instancia `mvp-assistant` creada
3. QR escaneado, número personal conectado, `state: open`
4. Send manual via curl funcionó (Evolution → mi número personal, mensaje entregado)

### Por qué se descartó
WhatsApp Web protocol no tiene concepto de "bot account" separado del usuario humano. Si el bot vive en mi número personal (33685391914):
- Cualquier mensaje desde mi teléfono sale con `fromMe=true`
- El código del bot ignora `fromMe=true` para evitar loops infinitos
- Resultado: el bot nunca ve mis mensajes desde mi propio WhatsApp
- El chat "Mensaje a ti mismo" cae en el mismo problema

Para que funcione como Telegram (yo le hablo al bot, el bot me responde), el bot necesita **vivir en un número distinto al mío**. Igual que el bot de Telegram tiene su propio token y yo mi chat_id.

### Para reactivar en el futuro
Cuando consiga un segundo número (Free Mobile €2/mes en Francia, OnOff app virtual, eSIM Airalo, o SIM secundaria), los pasos son:

1. Re-desplegar evolution-api en Railway (image `atendai/evolution-api:v1.8.2`, env vars en el bloque de abajo)
2. Crear instancia + escanear QR con el **número nuevo** (no el personal)
3. Añadir 6 env vars al service MVP-Assistant:
   ```
   ENABLE_WHATSAPP=true
   EVOLUTION_API_URL=http://${{evolution-api.RAILWAY_PRIVATE_DOMAIN}}:8080
   EVOLUTION_API_KEY=<misma-key-de-evolution>
   EVOLUTION_INSTANCE_NAME=mvp-assistant
   WHATSAPP_ALLOWED_NUMBER=33685391914
   WHATSAPP_WEBHOOK_SECRET=<random-string>
   ```
4. Crear instancia con webhook apuntando a `https://mvp-assistant-production.up.railway.app/webhook/whatsapp/<secret>`
5. Test: mandar WhatsApp desde mi personal al nuevo número del bot → debe responder

### Env vars del service evolution-api (referencia)
```
AUTHENTICATION_TYPE=apikey
AUTHENTICATION_API_KEY=<random>
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
DATABASE_ENABLED=false
REDIS_ENABLED=false
WEBHOOK_GLOBAL_ENABLED=false
CONFIG_SESSION_PHONE_CLIENT=MVP-Assistant
CONFIG_SESSION_PHONE_NAME=Chrome
PORT=8080
```

### Gotchas que aprendí (para no repetir)
- **`atendai/evolution-api:latest` apunta a v2**, que requiere PostgreSQL + Redis. Pinear a `v1.8.2` para in-memory.
- **Schema de send**: v1 usa `{ number, textMessage: { text } }`, v2 usa `{ number, text }`. El código de `whatsapp.js` envía ambos campos para ser tolerante.
- **Railway "Generate Domain"** se queda gris si el input de puerto no se "registra" en React — borrar y reescribir el puerto a mano lo arregla.
- **No usar `atendai/evolution-api:latest`** sin saber qué versión apunta — fijar tag siempre.

## Riesgos vigentes / cosas a vigilar

- **Gmail puede volver a ser deshabilitada**: el patrón "cuenta logueada sólo desde datacenter" sigue activando bot-detection. A largo plazo conviene migrar a Fastmail/Proton/custom domain. Si vuelve a pasar, el appeal language que funcionó: "personal", "myself", "my own data", "real phone number". Nunca usar "bot", "agent", "automation".
- **Secrets pegados en chats**: `GMAIL_APP_PASSWORD` fue pegado en claro durante debugging. Rotarlo cuando sea posible.

## Para Zentra (referencia, no es este proyecto)

Para WhatsApp en Zentra (B2B SaaS de psicólogos con clientes pagando), **no usar Evolution/Baileys**. Quédate con la integración de Twilio que ya tienes en `package.json`. Detalles del por qué guardados en memoria personal.

## Ya parchado en `main` (queda en el repo)

- Error listener en `ImapFlow` antes de `connect()` — sockets muertos no crashean el proceso (PR #4)
- `llm.js` detecta response sin `.choices` como fallo de provider, con cooldown 5min tras 429 (PR #4)
- Tool `search_emails` (IMAP live, Gmail X-GM-RAW con fallback nativo) registrado en agent (PR #4)
- Logging detallado del IMAP parser por stage (fetch/parse/store) (PR #4)
- `server.js`: `uncaughtException` + `unhandledRejection` handlers globales
- Multi-canal: `messages.channel` column, `runAgent(text, {channel})`, broadcast fanout en cron
- `whatsapp.js` Evolution API wrapper + endpoint `/webhook/whatsapp/<secret>` + `/wa` alias en Telegram (apagado por flag)
- Send body compatible v1 y v2 de Evolution (envía `text` y `textMessage.text` simultáneo)

### Shipped 2026-05-24
- Briefings ahora incluyen calendario (daily 1d, weekly 7d)
- Cron domingo 10:00 Paris — nudge para subir CSV de Revolut
- `proactive.js` watchman + cron cada 2h con strict-JSON output (`{interrupt, message, why}`)
- `memory.getSpendPace()` + tool `spend_pace` en analyst
- `GET /debug/stats` — visibilidad sin Telegram round-trips
- `bankCsv.js` con parsers deterministas Amex FR + Revolut consolidated
- `transactions.importCsv` detecta formato y usa parser determinista (sin LLM) cuando matchea
- `transactions.importNormalized()` + endpoint `POST /import/normalized?key=...` para bulk-load histórico
- `scripts/import-local.mjs` — importador local que normaliza CSVs y produce `normalized-transactions.csv` (gitignored)
- `.gitignore` ahora cubre `scripts/normalized-*.csv`, `.obsidian/`, `qr.png`

## Notas de arquitectura

- Canales activos: Telegram (siempre). WhatsApp queda como capacidad latente — código presente, gateado por `ENABLE_WHATSAPP`.
- Si migras email a Fastmail/Proton/custom: revisar también el Calendar (probablemente quieras OAuth en vez de ICS público desde una cuenta potencialmente migrada).
- El patrón multi-canal en `server.js` (`handleIncomingMessage` + `broadcast`) sirve para añadir cualquier canal nuevo (Slack, Discord, segundo Telegram, etc.) con poco esfuerzo.
