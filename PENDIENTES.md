# Pendientes — MVP-Assistant

## Estado actual

- **Telegram**: funciona, canal principal del agente
- **Email (Gmail dedicado)**: funciona — la cuenta fue deshabilitada 2026-05-12 y restaurada vía appeal 2026-05-18
- **Notion, Calendar (ICS), tasks, projects**: funcionando
- **Transacciones**: parsers deterministas para Amex FR + Revolut (`bankCsv.js`). El parser viejo basado solo en LLM tenía dos bugs grandes (ver "Aprendizajes 2026-05-24" abajo).
- **3-agent split shipped 2026-05-24**: Ingestor (`transactions.js`/`email.js`) + Analyst (`agent.js`) + Proactive (`proactive.js`). Notion: organigram → `MVP-Assistant — Organigram` page.
- **Proactive watchman**: corre cada 2h entre 08:00–22:00 Paris. Default silencio. Snapshot → JSON estricto → `broadcast()` solo si `interrupt=true`.
- **Daily briefing**: ahora incluye calendario (1d ahead) + `spend_pace` (gasto MTD, proyección fin de mes, top 3 categorías con delta % vs mismo periodo mes anterior).
- **Bulk import histórico**: `scripts/import-local.mjs` + endpoint `POST /import/normalized?key=$INTERNAL_IMPORT_KEY` (solo esquema normalizado). Para exports **crudos** del banco: `POST /import/csv` / `/import/pdf`, o `scripts/sync-bank-folders.mjs` que recorre las carpetas de statements. Ver "Aprendizajes 2026-07-31".
- **Subida de statements: mensual** (desde 2026-07-31). Recordatorio único el día 6 (`0 9 6 * *`); se eliminó el nudge semanal de Revolut.
- **B2B / techo micro shipped 2026-06-05** (`ceiling.js` + tab B2B): el operador opera Vandfort + Zentra + Touro bajo **una sola EI** (SIRET 10549166600019), así que el CA de los tres **suma a un único techo**. El módulo calcula el CA combinado del año, lo atribuye por keyword, excluye salario CDI + transferencias internas, marca ingresos sin clasificar, proyecta el cruce a fin de año, y dispara alerta por Telegram al cruzar 60/70/85/95/100% de la franchise TVA (€37.5k) y el techo micro (€77.7k). Cuenta Shine registrada como prefijo `shine:` (B2B independiente de lo personal). **Pendiente único**: ingestión de Shine (CSV/email/API — por definir cuando la cuenta esté activa); hoy el tab muestra €0 sin datos. Zentra y Touro comparten cuenta Stripe → no se separan entre sí desde el banco.
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
- Mitigación **hasta 2026-07-31**: cron de domingo 10:00 Paris ("sube el CSV de Revolut") antes del weekly review de las 18:00.
- **Desde 2026-07-31**: la subida pasó a ser mensual, así que ese cron semanal se eliminó. Queda solo el recordatorio del día 6 (`0 9 6 * *`), que ya cubre los tres bancos.
- **Consecuencia asumida**: Revolut queda desactualizado dentro del mes — el weekly review del domingo y las alertas de pace del proactive scan no ven su gasto hasta la subida mensual.

## ⚠️ Aprendizajes 2026-07-31 (fallos silenciosos en la ingesta)

Tres huecos encontrados al montar la subida mensual. Los tres **fallaban en silencio** — ninguno daba error, todos devolvían 200 OK.

### `/import/normalized` se tragaba los CSV crudos
- `sync-bank-folders.mjs` posteaba los CSV crudos de Amex/Revolut a `/import/normalized`, que solo entiende **nuestro** esquema (`date,merchant,amount,…`). Un export crudo no matchea ninguna columna → todas las filas caían en la rama de skip → `0 inserted, N skipped`, **idéntico a "todo duplicado"**. Ningún endpoint HTTP ejecutaba `importCsv`.
- **Solución**: nuevo `POST /import/csv` (mismo guard `INTERNAL_IMPORT_KEY`) que corre `importCsv` — la misma ruta que el handler de documentos de Telegram. `importNormalized` ahora rechaza con **400** un CSV que no traiga columnas `date`+`amount`.
- **Regla**: si un import puede devolver "no hice nada" por dos razones distintas (duplicado vs. no parseado), **tienen que ser contadores distintos**. `duplicates` vs `unparsed`; `skipped` queda solo como la suma. Un fichero con `inserted=0` y `unparsed>0` devuelve **422**, no 200.

### Revolut entraba sin verificar
- `bankCsv.js` solo reconcilia el export **mensual** (continuidad de balance fila a fila). El **consolidated** año-a-la-fecha está documentado como "one-time load" y no produce veredicto… pero era justamente el fichero que se había vuelto la rutina mensual: **135 de las 188 filas nuevas entraron sin ningún control**.
- **Solución**: el consolidated ahora devuelve `reconciled: null` **explícito + `reason`** (antes no devolvía nada, y "no verificado" era indistinguible de "verificado y OK"). El recordatorio del día 6 pide el export **mensual**.

### El badge ⚠️ del dashboard solo cubría BNP
- `setAccountBalance` se llamaba únicamente desde la rama del PDF de BNP. `importCsv` calculaba el veredicto de reconciliación y lo tiraba a la basura → un mes de Revolut roto se veía limpio.
- **Solución**: la reconciliación se atribuye **por `YYYY-MM`** (un fichero a caballo entre dos meses no puede marcar como roto el mes sano) y se persiste en `account_balances.reconciled` desde la ruta CSV también.

### Pendiente que queda abierto
- **Las filas ya cargadas desde el consolidated siguen sin verificar.** Los fixes evitan que vuelva a pasar, no validan retroactivamente lo que ya está en la DB. Ver "Verificación retroactiva de Revolut" abajo.
- **No hay tests.** Cero: ni runner ni dependencia. Para un código que parsea dinero y que ya acumula tres bugs de corrupción silenciosa documentados (signos Amex, TAB/espacio en BNP, y estos), unos golden-file tests sobre los parsers (statements de muestra + row count / suma neta / distribución de signos esperados) es lo de mayor valor pendiente.

## Verificación retroactiva de Revolut (pendiente)

Las ~135 filas cargadas desde el consolidated no tienen anchor de balance. Dos formas de cerrarlo:

1. **Re-pasar los exports mensuales de ene–jul** por `/import/csv`. Cada mes se reconcilia solo y el overlap guard deduplica. **El diagnóstico es el propio `inserted`**: debería salir ~0. Cualquier inserción sobre un mes ya cargado = discrepancia entre las dos fuentes (fila que faltaba, o fila que está mal y por eso no matchea la clave natural) → investigar esa.
2. **Check agregado opening/closing por mes** (estilo BNP): `opening + Σ(transacciones) == closing`. Es **independiente del orden**, así que funciona sobre el consolidated pese a que su layout reordene — que es justo lo que impide la continuidad fila a fila. Necesita el balance de cierre real de cada mes, que el propio consolidated ya trae en su columna `Balance`.

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

### Shipped 2026-05-27 (mobile pass — narrow viewport adaptation)

Dashboard was desktop-first. User reported "tiene que verse más adaptado" on phone. Quick adjustments — all in `dashboard.js` HTML template with Tailwind `sm:` breakpoint (640px):

| Component | Before (mobile) | After |
|---|---|---|
| Header | Logo + wordmark + 2 tabs + period picker → overflow at <420px | Wordmark hidden `<sm`, smaller logo (32px vs 36px), tabs/picker compact (`px-2.5`, `text-xs`) |
| Spending table | 5 cols (Category, Budget, Actual, **Δ**, %) too wide | Δ col hidden on mobile (`%` already communicates over/under). Material icon hidden too (emoji enough). Smaller padding `px-2 sm:px-3`. |
| Accounts grid | `grid-cols-1 md:grid-cols-4` → BNP+Amex+Revolut+Total stacked vertically (long scroll) | `grid-cols-2 md:grid-cols-4` — 2×2 on mobile, 4×1 desktop |
| Transactions table | Account col + Date + dropdown ate merchant space | Account col hidden on mobile; account badge appears **inline within the merchant cell** with smaller font. Header `"Amount €"` → `"€"` |
| Filter row separator | `\|` divider rendered as orphan line when wrapping | Hidden on mobile via `hidden sm:inline` |

**Lesson reinforced**: every time I edit the HTML template, re-run the inline-`<script>` parse check (`new Function(html.match(/<script>...).[1])`) — the syntax error from yesterday (`"Mark \"" + who + "\"..."` rendering broken JS) was caught early this time by the same workflow.

**Still desktop-only (deferred — not blocking phone usage):**
- Edit budget modal: 4-col table fine on phone but Save button + Use-template + Close + Modal-title cram in header
- Charts row: donut + variance progress bars stack vertically on `<lg`, currently fine but variance bars are tall
- Period picker popover: `w-80` (320px) fixed width — may overflow on very narrow phones (<340px)

### Shipped 2026-05-27 (mutation UX overhaul — "dirty marker → explicit Save" pattern)

**Problem the day exposed:** auto-save on `change`/`blur` events of `<input type=number>` and `<select>` was unreliable. When the user typed in the budget editor and immediately clicked X to close, no `change` event fired (only fires on blur) → save was lost → user thought "no funciona". The first fix attempted debounce + flush-on-close, which introduced race conditions for slow typing (a save in flight blocked the next one via a concurrency guard).

**Final pattern — "dirty marker + explicit Save button"** applied to all 3 mutation surfaces:

| Surface | Trigger | Indicator | Save action |
|---|---|---|---|
| **Edit Budget** modal | Type in any `€` input | Orange ring + `dirty` class | `💾 Save N changes` button in header (disabled when 0 dirty). Close with dirty → `confirm("Save before closing?")`. Per-row surgical update of Actual/% after save (no scroll loss). |
| **Transactions** tab | Change category dropdown | Orange ring on dropdown | `💾 Save N changes` button next to Search. Batch save → re-render so filter (e.g. Category=Other) re-applies → rows that no longer match disappear. |
| **Drilldown** modal | Change category dropdown | Orange ring + Apply button | `💾 Save N changes` bar above the tx list. Batch save → reload background dashboard. |

Backend `POST /api/budget kind=category` and `POST /api/transactions/category` are UPSERT-idempotent, so no concurrency guards needed.

**Categorization audit modal polish:**
- **Per-row Apply now removes the row** from the table + decrements `N remaining` in header + `(N)` in badge + shows "All clear — no more suggestions" empty-state when 0. Previously it only dimmed the row → users thought nothing happened.
- **Apply selected stays in modal** (no `closeCatAudit() + alert()` after bulk save). Subtitle updates inline: `"N remaining · ✓ Applied X"`. User can keep working on remaining suggestions.
- **Dismiss persists** via `localStorage.catAuditDismissed`. Dismissed rows don't reappear on reload. `window.clearAuditDismissed()` exposed for debugging.
- **Checkboxes default OFF** (opt-in, not opt-out). Clearer UX.

**"Use another month as template" (budget clone):**
- Refreshes modal body **in-place** via new `window.rerenderBudgetBody` (extracted from `openBudgetEditor`). No more close+reopen → preserves scroll position and focus.
- Inline confirmation in subtitle: `"✓ Copied N categories from 2026-04"` (auto-clears after 3s). Replaces disruptive `alert()`.

**Pending Settle button now confirms** (consistent with Delete): `Mark "Sebas Estupinan" as settled?`. Accidental clicks no longer silently mark items settled.

**No-cache headers on `/dashboard`:** `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0`. Prevents stale JS bugs after Railway redeploys — the user kept seeing old code after fixes were pushed because their browser cached the HTML.

**Inline SVG favicon** (€ glyph on blue) at `/favicon.ico` to silence the `404 /favicon.ico` console noise.

**Future periods in budget picker:** `listBudgetPeriods()` now includes today + 6 months ahead so the user can plan Junio/Julio before any data exists for them.

### ⚠️ Aprendizajes 2026-05-27

#### `<input type=number>` change event only fires on blur — not while typing
- Auto-save on `change`/`blur` looks correct in code but breaks for the user who types and immediately closes the modal without tabbing.
- The "debounce on `input`" alternative had its own race condition: a save in flight blocked the next one via a concurrency guard (`dataset.saving === "1"`), losing the final keystroke.
- **Mitigación**: dropped auto-save entirely in favor of explicit "dirty marker + Save button" pattern. Trade-off: one extra click per save batch, but 100% reliable + multi-edit-friendly + visible "you have unsaved changes" state.

#### Escaped quotes in nested template strings collapse — and `node -c` won't catch it
- The whole dashboard.js content is a single backtick template string returned by `renderDashboard()`. Backticks don't require escaping `"` inside, so my `"Mark \"" + who + "\" as settled?"` rendered to `"Mark "" + who + "" as settled?"` in the inline `<script>` → entire JS file failed to parse in the browser → **nothing rendered**.
- `node -c dashboard.js` validates the OUTER template — passes fine. The inline `<script>` content is opaque to the syntax check.
- **Mitigación inmediata**: use single quotes outside / double inside when emitting JS literals from the template: `'Mark "' + who + '" as settled?'`.
- **Mitigación de proceso (TODO)**: extend the syntax-check workflow to also `new Function(renderDashboard(null).match(/<script>([\s\S]*?)<\/script>/g)...)` so any inline-script error fails CI/local check before push. Otherwise the user only finds out when the dashboard is completely blank.

#### Modal that doesn't refresh after a save = "no funciona" from the user
- 4 separate sessions of "no funciona" all turned out to be UI not reflecting the save (backend was always correct via curl). Symptoms: input value reverts visually, % cell doesn't update, row stays in filtered list, modal closes when user wanted to keep working.
- **Mitigación**: every successful save now has visible feedback within 1 second (green flash, row removal, counter decrement, inline confirmation). When in doubt, surgical-update the changed cells rather than full re-render (preserves focus).

### Shipped 2026-05-27 (Financial Analyst subagent + dashboard polish)

**4ª agente: Financial Analyst subagente** (`analyst.js`):
- Read-only, 12 tools especializados (get_dashboard_summary, compare_periods, get_consolidated_history, spend_by_category, spend_by_merchant, monthly_totals, spend_pace, get_account_cashflow, query_transactions, get_pending_items, get_fx_rate, get_category_transactions).
- Tool-loop interno máx 5 rondas, fuerza respuesta final si excede.
- ANALYST_SYSTEM_PROMPT encoded con TODAS las reglas: MECE per category, BNP-parent vs Amex/Revolut-children, is_internal_transfer semantics, tricky merchants (HENNER=health, SWISSLIFE=savings, PRELEVEMENT=internal, Top-up=internal, Naturalia=groceries, Carlos=health), pending items, FX. Output: markdown ≤300 words.
- Main agent (`agent.js`) gana tool `analyst_query(question)` que delega queries financieras complejas. Devuelve `{markdown}` que el main pasa tal cual al usuario.
- Trade-off: el analyst tiene un prompt MÁS LARGO sin inflar el contexto del main agent. Read-only = sin riesgo de corromper datos.

**Dashboard polish UX (post-v3):**
- **Future periods**: `listBudgetPeriods()` ahora incluye los próximos 6 meses → podés crear el budget de Junio/Julio antes de tener data (clickable en el period picker).
- **Categorization audit Dismiss persistente**: localStorage (`catAuditDismissed`) recuerda qué sugerencias rechazaste → no vuelven a aparecer en próximos reloads. Window-exposed `clearAuditDismissed()` para resetear.
- **Spending dial reemplazado** ("Would have left" → "Spent this month"): anillo único color-coded (green/amber/red según %), center muestra €spent · X% · de €income · €available still. Sin formulas matemáticas, sin "if conditional".
- **TOTAL row al final** de la tabla Spending: typography Headline grande, color-coded, border-top 2px. Stats line chico arriba sigue ahí.
- **"Use another month as template"** reemplaza "Copy from…" (más intuitivo). Prompt aclara: solo rellena categorías vacías, no sobreescribe.
- **Edit Budget modal — fix surgical update**: después de un save, las celdas Actual y % de esa fila se actualizan inmediatamente con los datos frescos del backend. Antes la modal quedaba estática y el usuario pensaba que el save no funcionaba (sí funcionaba, pero la UI no reflejaba).
- **Transactions inline category change — fix re-filter**: cambio inline ahora hace flash verde 600ms + actualiza `histLastData.rows` en caché + re-renderiza con filtros vigentes. Si tenés filtro "Other" y cambias una tx a "Shopping", el row desaparece automáticamente.
- **Histórico filters i18n**: stats line traducido a inglés (era "transacciones · salidas · entradas · neto" → ahora "transactions · out · in · net"). Empty state también.
- **Dropdown empty-state fix**: `ensureHistoricoInit()` ahora SIEMPRE puebla los selectores Year/Month (fallback a JS Date si no hay currentData). Antes daban un check vacío raro cuando entrabas a Histórico con `?tab=historico` antes de que `load()` completara.
- **No-cache headers en `/dashboard`**: `Cache-Control: no-cache, no-store, must-revalidate` evita que el browser sirva JS viejo después de un deploy. ~50KB de HTML, hit insignificante vs pain de stale code.
- **Audit modal regex bug fixes**:
  - HENNER + AXA SANTE + MALAKOFF + ALAN + CPAM + AMELI + SECURITE SOCIALE movidos ANTES de la regla "vir sepa recu" → income. Antes los reembolsos de mutuelle se categorizaban como income.
  - Naturalia eliminado de la regla restaurants, agregado a groceries.
  - Pago Deuda variable_expense → category=debt (estaba en transfers → inflaba el donut transfers via attribution).
  - Inversion PERCO variable_expense → category=savings (mismo problema).
  - SWISSLIFE assurance ET → savings reforzado (ya estaba pero verificado).
- **Audit modal UX**: checkboxes default OFF (opt-in, no opt-out), botón "Dismiss" per fila para rechazar sin aplicar, "Close (do nothing)" como salida segura, "Apply selected" en vez de "Apply all".

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

### Convención: UI del dashboard SOLO en inglés

Todo string visible en `dashboard.js` (labels, headers, modales, badges, empty states, month picker, **tab B2B incluida**) va en **inglés**. Se mantienen nombres propios de regímenes fiscales franceses (Franchise TVA, micro-entreprise, CDI, EI). El **bot de Telegram queda en español** (conversacional, intencional). Al agregar UI: escribir en inglés, no reintroducir español.

### Shipped 2026-06-11

- **Pase completo a inglés + touch targets**: traducidos los strings ES restantes del dashboard, incluida la **tab B2B** (Combined revenue, Year-end projection, Micro-entreprise ceiling, Revenue per business, Unclassified…), YTD strip, modales Audit/keyword, badge de reconciliación ("Review BNP"), modal de balance BNP, month picker (MONTH_LONG → inglés). Touch targets de tabs/Add/month-picker subidos a ~44px en móvil (`py-3.5`/`py-3`), compactos en desktop (`sm:py-1.5`/`sm:py-2`).
- **UI polish**: barras de progreso por categoría + acento rojo over-budget · header sticky · jerarquía de headers de sección (16px) · drill-down attribution-aware (su total = ACTUAL del Spending).

- **Comparación 3-meses alineada con la tabla Spending** (`memory.getMonthlyCategorySpend`): antes usaba la categoría CRUDA de la tx (la renta caía en `other`), mientras Spending usa la atribución (renta→housing vía keyword "Arriendo"). Ahora `getMonthlyCategorySpend` reusa `getActualSpendVsBudget(mes).byCategoryAttributed` → ambas tablas categorizan IGUAL. Se acabó el "no hay housing arriba pero sí abajo".
- **Reconciliación Revolut (mensual) + nota Amex** (`bankCsv.attachRevolutRecon`): el export mensual de Revolut trae balance por fila → se valida continuidad `balance[i] == balance[i-1] + amount - fee` por moneda. Verificado: mensual cuadra (0 breaks). El consolidado (carga histórica) NO se marca: su layout multi-sección no está estrictamente ordenado por balance (falsos positivos). Amex CSV no trae balance ni total → sin ancla, no se reconcilia (pero sus montos son simples, sin el lío de tabs de BNP).
- **Badge de reconciliación en el dashboard** (`account_balances.reconciled` + `getDashboardSummary.reconciliation` + badge): se guarda por (cuenta, periodo) si el statement cuadró al importar; el dashboard muestra ⚠️ "Revisar BNP" en los meses cuyo statement no cuadró. Migración: `ALTER TABLE account_balances ADD COLUMN reconciled`.

### Shipped 2026-06-03

- **Guard de reconciliación al importar (para que no vuelva a pasar)** (`bankCsv.parseBnpPdfText` + `importPdf` + bot): el statement de BNP imprime saldo inicial + final, así que tras parsear se verifica `opening + Σ(líneas) == closing` (tolerancia €0.01, sobre las líneas PARSEADAS, no las insertadas, así valida el parse aunque haya dedup). Si no cuadra, `importPdf` devuelve `{reconciled:false, recon}` y el bot avisa `⚠️ No cuadra con el saldo del statement`. Esto habría cazado el bug de montos invertidos el día 1. Si cuadra, el bot confirma `✅ Cuadra con el saldo del statement`.
- **Mecanismo de limpieza** (`memory.deleteTransactionsBySource` + `POST /api/maintenance/purge-source?key=&source=&dry_run=`): borra todas las tx de una fuente (`pdf`=BNP, `csv`=Amex/Revolut…) para re-importar limpio tras un fix de parser. `dry_run=1` solo cuenta. Usado para limpiar el histórico BNP con montos invertidos.
- **FIX crítico: montos BNP mal parseados** (`bankCsv.reverseFrenchAmount`): el PDF de BNP alinea por columna y usa DOS separadores con significado distinto en la parte entera: **TAB = frontera de columna** (los chunks salen en orden invertido, ej. `972<tab>1` = 1·972 = 1972) y **ESPACIO = separador de miles** (orden normal, ej. `7 355` = 7355). El parser viejo concatenaba en orden directo (daba 9721); un primer fix invertía TODO (arreglaba meses con solo tabs como mayo, pero rompía meses con miles por espacio como marzo: `7 355`→5537). Fix correcto: **split por TAB, invertir columnas, quitar espacios dentro de cada una**. Verificado contra los sous-totales impresos: los **6 statements (nov–may) reconcilian con Δ 0** (ej. salario marzo €7.355,70, renta mayo €1.972,81). **Limpieza ejecutada**: `purge-source source=pdf` (114 filas) + re-import de los 6 PDFs vía `/import/pdf`.
- **Dedup de overlaps normalizado (todos los bancos)** (`transactions.makeOverlapGuard` + `bankCsv.parseRevolutMonthly`):
  - **Problema**: los statements se solapan en bordes de mes y entre formatos de export (Revolut consolidado vs mensual comparten ~3 semanas; re-descargas; archivos parciales de test). El `external_id` por-fuente es un hash distinto en cada formato → no cacha esos solapes.
  - **Fix general**: guard por **clave natural** `(date, amount-en-céntimos, currency, merchant-normalizado)` aplicado en todas las rutas de import (csv determinista + LLM, pdf BNP + LLM). Es **multiplicidad-aware**: salta una fila entrante solo hasta el conteo que ya existe en la DB, así dos compras idénticas el mismo día sobreviven pero los solapes reales se descartan. Funciona contra data ya importada, sin re-hashear ni re-sembrar.
  - **Revolut formato mensual** (`account-statement_*.csv`: `Type,Product,Started Date,Completed Date,Amount,...`) ahora se detecta y parsea determinista (usa Completed Date — misma base de fecha que el consolidado, verificado contra filas solapadas → deduplican). Antes caía al parser LLM y no cuadraba.
  - **Verificado** (dry-run con archivos reales): consolidado (260 tx) + mensual mayo → el mensual inserta solo 12 (May 25-31) y salta 49 (solape May 1-24); re-import = 0 nuevas; 0 duplicados.
  - **Ojo manual**: el guard NO arregla PDFs truncados/parciales (ej. los BNP `20260108.pdf` y `20260202.pdf` sin "(1)" que extraían <1300 chars) — esos hay que re-descargarlos completos. Y Amex `2026-06-20.csv` era copia byte a byte de `2026-05-20` (no es junio real).
- **Captura manual de gastos — 4 vías** (núcleo `transactions.logManualExpense()`: valida, normaliza signo, auto-categoriza desde el merchant vía keyword, inserta con `external_id=null` para no bloquear repeticiones):
  1. **Quick-add por chat**: tool `log_expense` en `agent.js` — "gasté 12€ en café" → transacción. Distinto de set_fixed_expense (budget).
  2. **Botón "+ Add" en el dashboard**: modal con monto/fecha/merchant/categoría/income → `POST /api/transactions/add` (DASH_KEY) → recarga.
  3. **Foto de recibo (OCR)**: `transactions.parseReceiptImage()` (multimodal, locked a provider primario/Gemini) + handler `handleReceiptPhoto` en server.js — mandas foto → extrae total/merchant/fecha/categoría → registra. Caption del foto sobreescribe el merchant. ⚠️ Depende de que el provider primario soporte input de imagen.
  4. **Nota de voz**: `stt.js` (`transcribeAudio`, Whisper vía endpoint OpenAI-compat) + handler `handleVoiceNote` — transcribe y rutea al agente (puede log_expense o cualquier cosa), eco del transcript. ⚠️ Requiere `STT_API_KEY` (+ `STT_BASE_URL`, ej. Groq whisper-large-v3 que acepta ogg) — sin eso, avisa al usuario de escribir.
- **Alertas de pace de budget** (`memory.getBudgetPaceAlerts()` + `proactive.js`): el watchman (cada 2h) ahora avisa a mitad de mes cuando una categoría discrecional va camino a pasarse del budget (proyección lineal) o ya se pasó — antes del weekly. Determinista (no depende del LLM; dispara aunque la llamada al modelo falle) y con dedup por mes vía tabla `proactive_pace_sent` (bucket 1 = on-pace, bucket 2 = ya excedido) para no repetir cada 2h. Reglas: solo mes corriente, día ≥ 4, categoría con budget>0 y ≥€20 gastado, excluye fijos (housing/savings/income/fees/transfers). El LLM tiene instrucción explícita de NO mencionar pace (se manda por separado).
- **Histórico: chips de rango rápido** (`dashboard.js`): botones 3m / 6m / 12m / YTD sobre el filtro From/To que setean el rango con un clic (highlight activo, se limpia si editas el rango a mano). El dropdown de años ahora siempre incluye año actual + 2 previos para que los presets que cruzan año funcionen. Los 4 selects manuales se mantienen para rangos custom.
- **Recordatorio mensual de statements** (`server.js` cron `0 9 6 * *`, Europe/Paris): el día 6 de cada mes el bot avisa que ya puede descargar los statements completos del mes anterior (BNP/Amex/Revolut publican al día 6) y los suba al bot. Mismo patrón que el nudge de Revolut.
- **Dashboard mes default = último mes con datos** (`memory.defaultDashboardPeriod()`): si el mes corriente aún no tiene gasto real (ej. el mes recién arrancó), el dashboard abre en el último mes **con** movimientos en vez de mostrar todo 0 €. `?period=` y el selector siguen mandando.
- **Comparativo a inglés**: la sección "Last 3 months comparison" (antes "Comparativo últimos 3 meses") + sus textos auxiliares pasaron a inglés para alinear con el resto del dashboard.
- **Formato Telegram arreglado** (`tgformat.js` nuevo): los briefings salían con `**` y `####` literales porque se enviaban con `parse_mode:"Markdown"` (legacy → negrita es `*uno*`, no `**dos**`; headers no existen). Ahora todo lo que va a Telegram pasa por `toTelegramHTML()` → convierte `**`/`*`/`####`/`-`/`` `code` `` a HTML real (`<b>`, `•`, separación de secciones). WhatsApp queda con su `*` intacto. Fallback a texto plano si el parse falla.
  - Prompts de briefing/weekly + system prompt del CFO (`advisor.js`) ahora piden headers `### Sección` + viñetas `-` + cifras en `**negritas**` para jerarquía consistente.
  - `index.js` tiene el mismo bug pero es **legacy** — producción corre `server.js` (Procfile + `npm start`). No se tocó.

## Custom domain & acceso — mauriciovarela.com

El dashboard se sirve bajo un subdominio de `mauriciovarela.com` (dominio registrado en **Cloudflare**), con acceso restringido a un solo usuario vía **Cloudflare Access** (Zero Trust). **Cero cambios de código** — todo se configura en Railway + Cloudflare.

**Rutas (recordatorio):** `/` es solo el health check de Railway (`{"status":"MVP-Assistant running"}`) — NO es error. El dashboard vive en **`/dashboard?key=$DASH_KEY`**. Webhooks en `/webhook/telegram` y `/webhook/whatsapp/<secret>`.

**Setup que funciona:**
1. Railway → service → Settings → Networking → **Custom Domain** → agregar subdominio (ej. `money.mauriciovarela.com`) → copiar el CNAME target.
2. Cloudflare → DNS → CNAME `money` → target de Railway. **Primero DNS-only (gris)** para que Railway emita su cert TLS; cuando Railway marque *Active*, pasar a **Proxied (naranja)** + SSL/TLS = **Full**.
3. Cloudflare **Zero Trust → Access → Applications**, dos apps sobre el mismo host (orden importa, la de webhooks primero por path más específico):
   - **App A — Webhooks:** path `/webhook/*` → policy **Bypass → Everyone**. ⚠️ **Obligatorio**: sin esto Telegram/WhatsApp no pueden entregar (no saben hacer login) y el bot queda mudo.
   - **App B — Dashboard:** resto del host → policy **Allow → email `varelaperezmauricio@gmail.com`**.
4. El `?key=$DASH_KEY` se mantiene como segunda capa — el frontend ya lo manda y las cookies de Access viajan solas en peticiones del mismo origen. URL final: `https://money.mauriciovarela.com/dashboard?key=$DASH_KEY`.

**Trampa documentada:** cualquier candado a nivel de dominio (Access, basic-auth global) rompe los webhooks si no se exenta `/webhook/*`.

## Notas de arquitectura

- Canales activos: Telegram (siempre). WhatsApp queda como capacidad latente — código presente, gateado por `ENABLE_WHATSAPP`.
- Si migras email a Fastmail/Proton/custom: revisar también el Calendar (probablemente quieras OAuth en vez de ICS público desde una cuenta potencialmente migrada).
- El patrón multi-canal en `server.js` (`handleIncomingMessage` + `broadcast`) sirve para añadir cualquier canal nuevo (Slack, Discord, segundo Telegram, etc.) con poco esfuerzo.
