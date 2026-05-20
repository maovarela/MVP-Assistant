# Pendientes — MVP-Assistant

## Gmail del agente (RESUELTO 2026-05-18)

`mauricio.varela.ai@gmail.com` fue deshabilitada por Google el 2026-05-12 (suspected bot). Appeal aceptado el 2026-05-18 y la cuenta está restaurada.

Para futuro: si Google la vuelve a flagear, el lenguaje del appeal que funcionó: enfatizar "personal", "myself", "my own data", "real phone number". Nunca usar "bot", "agent", "automation". A largo plazo, considera migrar a Fastmail/Proton/dominio propio para no depender de Google.

## En vuelo: WhatsApp vía Evolution API

Código integrado en `main` pero **necesita Evolution API desplegado** antes de funcionar. La integración degrada limpiamente: si `ENABLE_WHATSAPP=false` (default) o las env vars faltan, el resto del agente funciona normal.

### Steps para activar

1. **Deploy Evolution API en Railway** (servicio separado)
   - New Project → Deploy from Docker Image → `atendai/evolution-api:latest`
   - Variables:
     ```
     AUTHENTICATION_TYPE=apikey
     AUTHENTICATION_API_KEY=<string-random-tuyo>
     AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
     DATABASE_ENABLED=false
     REDIS_ENABLED=false
     WEBHOOK_GLOBAL_ENABLED=false
     CONFIG_SESSION_PHONE_CLIENT=MVP-Assistant
     CONFIG_SESSION_PHONE_NAME=Chrome
     PORT=8080
     ```
   - Generate public domain en Settings → Networking

2. **Crear instancia** (una vez)
   ```bash
   curl -X POST https://<evolution-url>/instance/create \
     -H "apikey: <tu-api-key>" \
     -H "Content-Type: application/json" \
     -d '{"instanceName":"mvp-assistant","qrcode":true,"webhook":"https://mvp-assistant-production.up.railway.app/webhook/whatsapp/<wa-webhook-secret>","webhook_by_events":false,"events":["MESSAGES_UPSERT"]}'
   ```

3. **Escanear QR**
   ```bash
   curl https://<evolution-url>/instance/connect/mvp-assistant \
     -H "apikey: <tu-api-key>"
   ```
   Decodifica el base64 en https://base64.guru/converter/decode/image y escanea desde WhatsApp → Dispositivos vinculados.

4. **Env vars en MVP-Assistant (Railway)**
   ```
   ENABLE_WHATSAPP=true
   EVOLUTION_API_URL=https://<evolution-url>
   EVOLUTION_API_KEY=<tu-api-key>
   EVOLUTION_INSTANCE_NAME=mvp-assistant
   WHATSAPP_ALLOWED_NUMBER=33XXXXXXXXX   # tu número, solo dígitos
   WHATSAPP_WEBHOOK_SECRET=<string-random>  # mismo que pusiste en la URL del webhook arriba
   ```

5. **Test sin tocar WhatsApp real**: en Telegram manda `/wa hola, qué tareas tengo?`. Eso fuerza la ruta por `channel=whatsapp` y responde de vuelta en Telegram con prefijo `[wa-test]`. Confirma que el routing funciona antes de probar end-to-end.

6. **Test end-to-end**: desde tu WhatsApp manda al número del bot. Debe responder vía Evolution.

### Riesgos a recordar

- **Ban de número**: Evolution usa WhatsApp Web reverse-engineered. Meta puede banear el número si detecta patrones automatizados (mucho volumen, mensajes idénticos, horas no-humanas). Usa un número secundario que puedas perder.
- **Costo**: Evolution API self-hosted en Railway free tier suficiente para uso personal. Si crece, ~$5/mes.
- **Alternativa oficial**: Twilio WhatsApp / Meta Cloud API — sin riesgo de ban, pero $0.005-$0.05/mensaje y verificación de business. No vale la pena para MVP personal.

## Ya parchado en `main`

- Error listener en `ImapFlow` antes de `connect()` — sockets muertos no crashean el proceso (PR #4)
- `llm.js` detecta response sin `.choices` como fallo de provider, con cooldown 5min tras 429 (PR #4)
- Tool `search_emails` (IMAP live, Gmail X-GM-RAW con fallback nativo) registrado en agent (PR #4)
- Logging detallado del IMAP parser por stage (fetch/parse/store) (PR #4)
- `server.js`: `uncaughtException` + `unhandledRejection` handlers globales
- Multi-canal: `messages.channel` column, `runAgent(text, {channel})`, broadcast fanout en cron
- `whatsapp.js` Evolution API wrapper + endpoint `/webhook/whatsapp/<secret>` + `/wa` alias en Telegram

## Notas de arquitectura

- Canales activos: Telegram (siempre), WhatsApp (si `ENABLE_WHATSAPP=true`). Para apagar Telegram poner `ENABLE_TELEGRAM=false`.
- Webhook WhatsApp: el secreto va en el path porque Evolution no soporta headers custom en todas las versiones.
- Auth por número: si `WHATSAPP_ALLOWED_NUMBER` está set, sólo ese número puede hablar con el agente. Otros se loguean e ignoran.
- Si migras email a Fastmail/Proton/custom: revisar también el Calendar (probablemente quieras OAuth en vez de ICS público).
