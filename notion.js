// src/tools/notion.js
// Notion API integration — Phase 3

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID  = process.env.NOTION_DATABASE_ID;

export async function createNotionTask({ title, priority, due_date, project_name, description }) {
  const page = await notion.pages.create({
    parent: { database_id: DB_ID },
    properties: {
      Name:        { title: [{ text: { content: title } }] },
      Priority:    { select: { name: priority || "Medium" } },
      Status:      { select: { name: "Todo" } },
      Project:     project_name ? { rich_text: [{ text: { content: project_name } }] } : undefined,
      "Due Date":  due_date ? { date: { start: due_date } } : undefined,
    },
    children: description ? [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: description } }] },
    }] : [],
  });
  return page.id;
}

export async function updateNotionTask(pageId, { status, priority, due_date }) {
  const properties = {};
  if (status)   properties["Status"]   = { select: { name: status } };
  if (priority) properties["Priority"] = { select: { name: priority } };
  if (due_date) properties["Due Date"] = { date: { start: due_date } };

  await notion.pages.update({ page_id: pageId, properties });
}

export async function queryNotionTasks({ status, priority } = {}) {
  const filters = [];
  if (status)   filters.push({ property: "Status",   select: { equals: status } });
  if (priority) filters.push({ property: "Priority", select: { equals: priority } });

  const response = await notion.databases.query({
    database_id: DB_ID,
    filter: filters.length > 1
      ? { and: filters }
      : filters[0] || undefined,
    sorts: [{ property: "Due Date", direction: "ascending" }],
  });

  return response.results.map((page) => ({
    notion_id:  page.id,
    title:      page.properties.Name?.title?.[0]?.text?.content || "",
    status:     page.properties.Status?.select?.name || "Todo",
    priority:   page.properties.Priority?.select?.name || "Medium",
    due_date:   page.properties["Due Date"]?.date?.start || null,
  }));
}
