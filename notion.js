// notion.js
// Notion API integration — search, read pages, query databases.
// Works on whatever pages/databases the integration has been shared with.

import { Client } from "@notionhq/client";

const notion  = new Client({ auth: process.env.NOTION_API_KEY });
const TASKS_DB_ID = process.env.NOTION_DATABASE_ID; // optional — for legacy task sync

// ─── Search workspace ────────────────────────────────────────────────────────

/**
 * Search across all pages and databases the integration has access to.
 * Returns a slim list with titles + IDs so the agent can pick what to read.
 */
export async function searchNotion({ query, limit = 10 } = {}) {
  const res = await notion.search({
    query: query || undefined,
    page_size: Math.min(limit, 50),
    sort: { direction: "descending", timestamp: "last_edited_time" },
  });

  return res.results.map((r) => {
    const isPage = r.object === "page";
    const title = extractTitle(r);
    return {
      id:             r.id,
      type:           r.object,             // "page" or "database"
      title:          title || "(untitled)",
      url:            r.url,
      last_edited:    r.last_edited_time,
      parent_type:    r.parent?.type,
    };
  });
}

function extractTitle(obj) {
  // Pages: title lives in properties (varies by db schema)
  if (obj.object === "page") {
    const props = obj.properties || {};
    for (const v of Object.values(props)) {
      if (v.type === "title" && v.title?.length) {
        return v.title.map((t) => t.plain_text).join("");
      }
    }
    return null;
  }
  // Databases: title at top level
  if (obj.object === "database" && obj.title?.length) {
    return obj.title.map((t) => t.plain_text).join("");
  }
  return null;
}

// ─── Read full page content ──────────────────────────────────────────────────

/**
 * Read a Notion page: returns title, properties, and the full body text
 * (recursively flattened from all child blocks). Useful for the agent to
 * answer questions about page content.
 */
export async function readNotionPage(pageId) {
  const id = normalizeNotionId(pageId);

  const [page, blocks] = await Promise.all([
    notion.pages.retrieve({ page_id: id }),
    fetchAllChildren(id),
  ]);

  return {
    id,
    title:        extractTitle(page) || "(untitled)",
    url:          page.url,
    last_edited:  page.last_edited_time,
    properties:   slimProperties(page.properties),
    content:      blocksToText(blocks),
  };
}

async function fetchAllChildren(blockId, depth = 0) {
  if (depth > 3) return []; // bail on deeply nested blocks
  const all = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      all.push(b);
      if (b.has_children) {
        const children = await fetchAllChildren(b.id, depth + 1);
        all.push(...children);
      }
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return all;
}

function blocksToText(blocks) {
  return blocks.map(blockToText).filter(Boolean).join("\n");
}

function blockToText(b) {
  const type = b.type;
  const data = b[type];
  if (!data) return "";

  // Text-bearing blocks
  if (data.rich_text) {
    const text = data.rich_text.map((t) => t.plain_text).join("");
    if (type === "heading_1") return `\n# ${text}`;
    if (type === "heading_2") return `\n## ${text}`;
    if (type === "heading_3") return `\n### ${text}`;
    if (type === "bulleted_list_item" || type === "numbered_list_item") return `- ${text}`;
    if (type === "to_do") return `[${data.checked ? "x" : " "}] ${text}`;
    if (type === "quote") return `> ${text}`;
    if (type === "code") return "```" + (data.language || "") + "\n" + text + "\n```";
    return text;
  }

  if (type === "divider") return "---";
  if (type === "child_page") return `[child page: ${data.title}]`;
  if (type === "image") return `[image]`;
  return "";
}

function slimProperties(props) {
  // Compress page properties to a flat key→string map
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    out[k] = formatProperty(v);
  }
  return out;
}

function formatProperty(p) {
  switch (p.type) {
    case "title":        return (p.title || []).map((t) => t.plain_text).join("");
    case "rich_text":    return (p.rich_text || []).map((t) => t.plain_text).join("");
    case "select":       return p.select?.name || null;
    case "multi_select": return (p.multi_select || []).map((s) => s.name);
    case "status":       return p.status?.name || null;
    case "date":         return p.date?.start || null;
    case "number":       return p.number;
    case "checkbox":     return p.checkbox;
    case "url":          return p.url;
    case "email":        return p.email;
    case "phone_number": return p.phone_number;
    case "people":       return (p.people || []).map((u) => u.name || u.id);
    default:             return null;
  }
}

// ─── Query a database ────────────────────────────────────────────────────────

export async function queryNotionDatabase({ database_id, filter, sorts, limit = 50 } = {}) {
  const id = normalizeNotionId(database_id);
  const res = await notion.databases.query({
    database_id: id,
    filter:      filter || undefined,
    sorts:       sorts  || undefined,
    page_size:   Math.min(limit, 100),
  });

  return res.results.map((r) => ({
    id:          r.id,
    title:       extractTitle(r) || "(untitled)",
    url:         r.url,
    last_edited: r.last_edited_time,
    properties:  slimProperties(r.properties),
  }));
}

/**
 * Notion accepts both dashed UUID and 32-char hex. The URL form uses no dashes.
 * We normalise to the dashed form which is what the API prefers.
 */
function normalizeNotionId(input) {
  if (!input) return input;
  const hex = input.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 32) return input; // already dashed or invalid; let API report
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// ─── Legacy task helpers (kept so old code doesn't break) ───────────────────

export async function createNotionTask({ title, priority, due_date, project_name, description }) {
  if (!TASKS_DB_ID) throw new Error("NOTION_DATABASE_ID not set");
  const page = await notion.pages.create({
    parent: { database_id: TASKS_DB_ID },
    properties: {
      Name:        { title: [{ text: { content: title } }] },
      Priority:    { select: { name: priority || "Medium" } },
      Status:      { select: { name: "Todo" } },
      Project:     project_name ? { rich_text: [{ text: { content: project_name } }] } : undefined,
      "Due Date":  due_date ? { date: { start: due_date } } : undefined,
    },
    children: description ? [{
      object: "block",
      type:   "paragraph",
      paragraph: { rich_text: [{ text: { content: description } }] },
    }] : [],
  });
  return page.id;
}
