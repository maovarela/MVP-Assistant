// calendar.js
// Read-only Google Calendar via the private iCal feed URL.
// Set GOOGLE_CALENDAR_ICS_URL — for multiple calendars, separate with commas.
//
// Why ICS instead of OAuth: zero token rotation, zero domain delegation,
// and read-only is exactly what we need for the agent. Event creation
// would require OAuth — add later if needed.

import ical from "node-ical";

function feeds() {
  const raw = process.env.GOOGLE_CALENDAR_ICS_URL || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * List events between two dates across all configured calendars.
 * Defaults to the next 14 days from today.
 */
export async function listEvents({ daysAhead = 14, daysBack = 0 } = {}) {
  const now      = new Date();
  const fromDate = new Date(now); fromDate.setDate(now.getDate() - daysBack);
  const toDate   = new Date(now); toDate.setDate(now.getDate() + daysAhead);

  const urls = feeds();
  if (!urls.length) {
    console.warn("[calendar] no GOOGLE_CALENDAR_ICS_URL set");
    return [];
  }

  console.log(`[calendar] window ${fromDate.toISOString()} → ${toDate.toISOString()}`);

  const allEvents = [];
  for (const url of urls) {
    try {
      const data        = await ical.async.fromURL(url);
      const totalVevents = Object.values(data).filter((e) => e?.type === "VEVENT").length;
      const events      = expandEvents(data, fromDate, toDate);
      console.log(`[calendar] ${url.slice(0, 60)}... → ${totalVevents} VEVENTs in feed, ${events.length} in window`);
      if (events.length) {
        console.log(`[calendar] first match:`, events[0].title, events[0].start);
      }
      allEvents.push(...events);
    } catch (err) {
      console.error(`[calendar] failed to fetch ${url.slice(0, 60)}...`, err.message);
    }
  }

  return allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
}

/**
 * Search events by free-text in title/description/location.
 */
export async function searchEvents({ query, daysAhead = 365, daysBack = 30 } = {}) {
  const all = await listEvents({ daysAhead, daysBack });
  const q   = (query || "").toLowerCase();
  if (!q) return all;
  return all.filter((e) =>
    (e.title || "").toLowerCase().includes(q) ||
    (e.description || "").toLowerCase().includes(q) ||
    (e.location || "").toLowerCase().includes(q)
  );
}

/**
 * Expand iCal data into a flat list of {start, end, title, ...}.
 * Handles recurring events (RRULE) by expanding within the requested window.
 */
function expandEvents(data, fromDate, toDate) {
  const out = [];
  for (const key in data) {
    const ev = data[key];
    if (!ev || ev.type !== "VEVENT") continue;

    if (ev.rrule) {
      // Recurring — expand within range
      const dates = ev.rrule.between(fromDate, toDate, true);
      for (const d of dates) {
        out.push(formatEvent(ev, d, addDuration(d, ev.start, ev.end)));
      }
    } else {
      const start = ev.start;
      const end   = ev.end;
      if (!start) continue;
      if (start > toDate || (end && end < fromDate)) continue;
      out.push(formatEvent(ev, start, end));
    }
  }
  return out;
}

function addDuration(occurrenceStart, originalStart, originalEnd) {
  if (!originalStart || !originalEnd) return null;
  const ms = originalEnd.getTime() - originalStart.getTime();
  return new Date(occurrenceStart.getTime() + ms);
}

function formatEvent(ev, start, end) {
  return {
    title:       ev.summary || "(no title)",
    start:       start instanceof Date ? start.toISOString() : start,
    end:         end instanceof Date ? end.toISOString() : (end || null),
    location:    ev.location || null,
    description: ev.description || null,
    organizer:   ev.organizer?.params?.CN || null,
    uid:         ev.uid,
  };
}
