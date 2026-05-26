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

### Shipped 2026-05-26 (dashboard v3 — MECE per categoría + auditoría + pending)

**Modelo de presupuesto refactorizado:**
- Nueva tabla `category_budgets(period, category, budget_eur)` — **single source of truth MECE**, un número por categoría por mes. Migración automática en boot rellena desde `fixed_expenses + variable_expenses` la primera vez.
- `fixed_expenses` queda como sub-detalle informativo (Arriendo €1604 dentro de housing) + sirve para attribution via `match_keyword`.
- `variable_expenses` oculto de la UI (legacy, vive en BD).
- Nueva categoría **`internal_transfer` (🔄)** separada de `transfers` (📤 terceros). Distinción MECE: internal son movimientos BNP↔hijas (no son gasto), transfers son a terceros reales (PERCO→savings, Pago Deuda→debt, friend transfers).

**UI dashboard v3:**
- Layout 2 tabs: **Overview** + **Transactions**.
- "Edit budget" modal ahora edita por categoría (14 filas) inline. "Copy from…" copia category_budgets entre meses.
- Stats line única: `13 categories · plan €4967 · real €1631 (33%)`. Eliminé el toggle "Mostrar sin presupuesto" que no hacía nada (todas las categorías tenían actual≠0).
- **Variance**: Chart.js bar reemplazado por **HTML progress bars estilo Linear/Notion** — más limpio, sin axis, color verde/ámbar/rojo según %.
- **Donut**: top 7 + agrupado "Others", paleta sobria, leyenda HTML custom con emoji + %.
- **Dial top "Spent this month"**: anillo único, % de income gastado, color-coded, center `€spent · X% · of €income · €available still`. Reemplazó el confuso "Te sobraría / Residual planeado" que el usuario no entendía.
- **Account cards**: 4 cards en grid (BNP / Amex / Revolut / **Real cashflow**). La 4ta excluye internal transfers para mostrar el cashflow REAL del mes (los totales crudos doble-cuentan los internos).
- **Panel "Internal transfers (BNP parent → children)"** debajo de las 4 cards: reconciliación BNP→Amex (prélèvement) + BNP→Revolut (top-up). Cards hijas muestran "↤ Received from BNP €X" y BNP muestra "↦ Moved to children €Y".
- **Pestaña Transactions**: lista plana editable con `From / To` selectors (year + month split), chips multi-select de cuentas, filtros Category / Type (in/out/external) / Min €, búsqueda merchant, headers sortables (date/account/merchant/amount/category), dropdown inline de categoría (autoguarda).
- **Pending panel**: nueva tabla `pending_items(kind, who, amount_eur, description, expected_date, status)`. 3 kinds: receivable (💰 owed to me) / payable (📤 I owe) / reimbursement (🔁). Totales + form inline + Settle/Delete por fila. Casos sembrados: Sebas Estupinan €350 (jul), Iván €60, podólogo HENNER €40, trenes Málaga €50, tren Alemania €60.
- **🩺 Categorization audit modal**: drift detector que corre `bankCsv.categorize(desc)` sobre cada tx y muestra mismatches vs categoría guardada. Checkboxes default OFF (opt-in), Dismiss por fila para ignorar sugerencias malas, Apply selected en bulk. Reemplaza el legacy "Auditar" (huérfano) que estaba escondido (concepto obsoleto con MECE).
- **i18n**: toda la UI traducida a inglés (Overview, Transactions, Spending, Edit budget, Income, Actual spend, etc.).

**Regex parser fixes (bankCsv.js):**
- HENNER + AXA SANTE + MALAKOFF + ALAN + CPAM + AMELI + SECURITE SOCIALE → `health` (movido ANTES de la regla `vir sepa recu` → income, que estaba capturándolos mal como ingreso).
- SWISSLIFE assurance ET / PERCO / retraite → `savings` (antes de la regla genérica de fees).
- PRELEVEMENT AUTOMATIQUE (Amex) → `is_internal_transfer=true, category='internal_transfer'`.
- Revolut "Top-up by *XXXX" → flag interno + category transfers (antes "income" = doble-conteo).
- Naturalia eliminado de restaurants, movido a groceries.
- Carlos Antonio Melchor → health (terapeuta, era reembolso de mutuelle confusión).
- Generic `/top.?up/` rule cambiado de `income` a `transfers` (safety net por si parser no flagea).

**Endpoints nuevos:**
- `POST /api/reconcile-categories` — idempotente, 2 pasos: (1) `is_internal_transfer=1` → `internal_transfer`, (2) re-clasificar txs claim por fixed_expenses.match_keyword a la categoría del fijo (arregla rent en transfers→housing).
- `POST /api/categorization-audit/{apply}` + `GET /api/categorization-audit.json` — drift detector + bulk-fix.
- `POST /api/transactions/update-by-text` — bulk update por substring de merchant/description (one-shot maintenance).
- `POST /api/maintenance/update-variable-category` — fix legacy variable_expenses category por label (usado para Pago Deuda → debt, Inversion PERCO → savings).
- `GET /api/transactions.json` — flat list para el tab Transactions, soporta `period_from/period_to`, `accounts` multi, `search`, `limit`.
- `GET /api/pending.json` + `POST /api/pending` — CRUD pending items.
- `/api/budget` extendido con `kind:'category'` + `kind:'copy_categories'` + `op:'delete'`.

### ⚠️ Aprendizajes 2026-05-26 (no repetir)

#### Sumar credits/debits crudos a través de cuentas es trampa
- BNP "−OUT" incluye prélèvement Amex (€2127). Amex "+IN" tiene el mismo €2127. Si sumas brutos, ambos lados se inflan artificialmente. El neto cuadra (€0) pero los totales dejan de significar nada.
- **Mitigación**: cualquier consolidado debe excluir `is_internal_transfer=1`. La nueva card "Real cashflow" lo hace explícito; los individual account cards muestran tanto brutos como "↦ Moved to children" / "↤ Received from BNP" para que el usuario vea ambos planos.

#### Variable_expenses con categoría incorrecta inflan el donut por attribution
- "Pago Deuda" tenía `category='transfers'` pero match_keyword captura DAVIVIENDA/BANCOLOMBIA → la attribution sumaba €922 a la slice `transfers` cuando debería ir a `debt`.
- Igual con "Inversion PERCO" (transfers → savings).
- **Fix one-shot** via `/api/maintenance/update-variable-category`. **Lesson para el futuro**: cuando agregues un variable o fixed line, su `category` DEBE coincidir con la categoría destino MECE — el match_keyword no la cambia, solo se basa en ella para atribuir.

#### Drilldown por categoría devolvía rent vacío
- Donut mostraba housing €1723 (post-attribution) pero el modal de drilldown solo encontraba €117 (utilidades) porque el rent tx tenía `category='transfers'` en BD.
- **Fix permanente**: `/api/reconcile-categories` reescribe la raw category de cada tx claim para que coincida con la categoría del fixed que la reclamó. Ahora rent → housing en BD, drilldown y donut cuadran.

#### Uncategorised drilldown devolvía 0 rows
- `listCategoryTransactions WHERE category = 'uncategorised'` no matchea porque la columna está NULL, no la string 'uncategorised'.
- **Fix**: query ahora maneja `(category IS NULL OR category = 'uncategorised')` cuando el filtro es 'uncategorised'.

#### Audit "huérfano" era confuso con MECE
- El audit viejo (fixed_expenses keyword vs no-match) era útil cuando los fijos eran la única fuente de presupuesto. Con `category_budgets` MECE toda tx vive en su bucket por categoría — "huérfano" no es accionable.
- **Mitigación**: boton oculto. Lo reemplazó "🩺 Categorization audit" que detecta drift entre regex y BD (mucho más accionable: aplica fixes en bulk cuando agregas una nueva regla).

#### UI controls que no hacen nada visible son peor que no tenerlos
- El toggle "Mostrar sin presupuesto" no producía cambios visibles porque el default ya mostraba todo lo que tenía budget>0 OR actual>0 (que cubre 99% de casos). Usuario reportó "no funciona".
- **Lesson**: si un control depende de un edge case que casi nunca ocurre en los datos del usuario, mejor quitarlo.

#### Etiquetas conditional/abstractas confunden
- "Residual planeado" / "Te sobraría si gastas X%" — el usuario reportó "no entiendo esto" 2 veces. El conditional ("if you spend") + la formula (`ingreso − presupuesto`) crearon ambigüedad.
- **Fix**: dial ahora muestra hechos directos: "Spent this month €1631 · 38% · of €4350 income · €2719 still available". Sin conditional, sin formula, sin jargon.

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
