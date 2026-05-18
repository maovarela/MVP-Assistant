# Pendientes — MVP-Assistant

## Bloqueante: cuenta Gmail del agente deshabilitada

`mauricio.varela.ai@gmail.com` deshabilitada por Google el **2026-05-12**. Marcada como bot/violación de policies. Borrado permanente programado para **2027-04-07**.

### Camino actual: appeal
- Appeal enviado vía https://support.google.com/accounts (formulario "account disabled")
- Esperando respuesta de Google (típicamente 2–7 días)
- Lenguaje del appeal: evitar "bot", "agent", "automation". Enfatizar "personal", "myself", "my own data"

### Plan B si el appeal falla
Tres opciones, en orden de preferencia:

1. **Provider distinto** (Fastmail $5/mes, Proton, o dominio propio + Cloudflare Email Routing) — el código IMAP/SMTP es agnóstico, sólo cambian `HOST`/`PORT` en `email.js`. No se repite el problema de bot-detection de Google.
2. **Cuenta personal `varelaperezmauricio@gmail.com`** — sólo cambian env vars en Railway, 5 minutos. Coste: el agente mezcla bank emails con personal, y los `send_email` salen con tu nombre real.
3. **Crear otra Gmail dedicada** — NO RECOMENDADO. Mismo patrón → mismo flag.

## Una vez resuelto el email

- [ ] Actualizar `GMAIL_USER` + `GMAIL_APP_PASSWORD` en Railway Variables
- [ ] Verificar `[boot] inbox scan` exitoso en logs
- [ ] Probar `search_emails` end-to-end ("dame info del vuelo a Barcelona")
- [ ] Confirmar que el cron horario vuelve a parsear bank emails
- [ ] Investigar los `[imap] uid=X stage failed` que aparezcan (con el logging por stage ya en `email.js` veremos si falla en fetch/parse/store)

## Ya parchado en `main`

- Error listener en `ImapFlow` antes de `connect()` — sockets muertos no crashean el proceso (PR #4)
- `llm.js` detecta response sin `.choices` como fallo de provider, con cooldown 5min tras 429 (PR #4)
- Tool `search_emails` (IMAP live, Gmail X-GM-RAW con fallback nativo) registrado en agent (PR #4)
- Logging detallado del IMAP parser por stage (fetch/parse/store) (PR #4)
- `server.js`: `uncaughtException` + `unhandledRejection` handlers globales (este commit)

## Notas de arquitectura

- El agente depende de la Gmail dedicada para: IMAP (bank parsing + search_emails), SMTP (send_email), Calendar ICS feed.
- Notion, tasks, projects, transacciones-ya-en-DB siguen funcionando sin Gmail.
- Calendar: el ICS feed es público, debería seguir funcionando aunque la cuenta esté deshabilitada — verificar.
- Si migras a Fastmail/Proton/custom: revisar también el Calendar — probablemente quieras mover el ICS al mismo proveedor o usar Google Calendar OAuth en vez de ICS público desde una cuenta muerta.
