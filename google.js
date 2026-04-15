// src/tools/google.js
// Google Calendar + Gmail — Phase 3

import { google } from "googleapis";

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  });
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

export async function listEvents({ daysAhead = 7 } = {}) {
  const auth     = await getAuth().getClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin:    now.toISOString(),
    timeMax:    end.toISOString(),
    singleEvents: true,
    orderBy:    "startTime",
  });

  return (res.data.items || []).map((e) => ({
    id:       e.id,
    title:    e.summary,
    start:    e.start?.dateTime || e.start?.date,
    end:      e.end?.dateTime   || e.end?.date,
    location: e.location || null,
  }));
}

export async function createEvent({ title, start, end, description, location }) {
  const auth     = await getAuth().getClient();
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary:     title,
      description: description || "",
      location:    location    || "",
      start: { dateTime: start, timeZone: "Europe/Paris" },
      end:   { dateTime: end,   timeZone: "Europe/Paris" },
    },
  });

  return { id: res.data.id, link: res.data.htmlLink };
}

export async function findFreeSlots({ date, durationMinutes = 60 }) {
  const events = await listEvents({ daysAhead: 1 });
  // Simple heuristic — returns first open slot after 9am
  // Extend this with proper freebusy query for production
  return { message: `First available slot on ${date} — implement freebusy query` };
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

export async function searchEmails({ query, maxResults = 5 }) {
  const auth  = await getAuth().getClient();
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.list({
    userId:     "me",
    q:          query,
    maxResults,
  });

  const messages = await Promise.all(
    (res.data.messages || []).map(async (m) => {
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata" });
      const headers = msg.data.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || "";
      return {
        id:      m.id,
        from:    get("From"),
        subject: get("Subject"),
        date:    get("Date"),
        snippet: msg.data.snippet,
      };
    })
  );

  return messages;
}

export async function sendEmail({ to, subject, body }) {
  const auth  = await getAuth().getClient();
  const gmail = google.gmail({ version: "v1", auth });

  const raw = Buffer.from(
    `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n\n${body}`
  ).toString("base64url");

  const res = await gmail.users.messages.send({
    userId:      "me",
    requestBody: { raw },
  });

  return { id: res.data.id, threadId: res.data.threadId };
}
