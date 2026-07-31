#!/usr/bin/env node
// sync-bank-folders.mjs
// Walks one or more bank-statement folders and ingests any file we haven't
// processed before. Format auto-detected per file:
//
//   - *.csv  → POST /import/csv (server auto-detects Amex/Revolut and uses the
//              deterministic parser; falls back to the LLM batch parser when
//              the format is unknown)
//   - *.pdf  → POST /import/pdf (server hits the deterministic BNP fast-path,
//              falls back to LLM only if it doesn't look like a BNP statement)
//
// Dedup is by file CONTENT hash, stored in scripts/.processed.json. Same hash
// = already done, skip. Hash changes if BNP regenerates a "(1).pdf" with a
// different layout — that's fine, we'll re-ingest and the server-side
// transaction-level dedup (external_id) keeps duplicates out of the DB.
//
// Usage:
//   $env:INTERNAL_IMPORT_KEY = "..."     # both endpoints
//   node scripts/sync-bank-folders.mjs `
//     "C:\Users\varel\OneDrive\Documents\Docs Perso\Bank Statements\Amex" `
//     "C:\Users\varel\OneDrive\Documents\Docs Perso\Bank Statements\Revolut" `
//     "C:\Users\varel\OneDrive\Documents\Docs Perso\Bank Statements\BNP"
//
// Wire into Windows Task Scheduler for set-and-forget ingestion.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error("usage: node scripts/sync-bank-folders.mjs <folder> [<folder>...]");
  process.exit(1);
}

const HOST           = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const INTERNAL_KEY   = process.env.INTERNAL_IMPORT_KEY;
const HASH_DB        = path.join("scripts", ".processed.json");

if (!INTERNAL_KEY) {
  console.error("ERROR: set INTERNAL_IMPORT_KEY (required for both CSV and PDF endpoints).");
  process.exit(1);
}

// ─── Hash cache ─────────────────────────────────────────────────────────────

let cache = {};
if (fs.existsSync(HASH_DB)) {
  try { cache = JSON.parse(fs.readFileSync(HASH_DB, "utf8")); }
  catch { cache = {}; }
}
function hashFile(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}
function save() {
  fs.writeFileSync(HASH_DB, JSON.stringify(cache, null, 2));
}

// ─── Uploaders ──────────────────────────────────────────────────────────────

async function uploadCsv(filePath, buf) {
  const r = await fetch(`${HOST}/import/csv?key=${encodeURIComponent(INTERNAL_KEY)}`, {
    method:  "POST",
    headers: { "content-type": "text/csv" },
    body:    buf,
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}

async function uploadPdf(filePath, buf) {
  const r = await fetch(`${HOST}/import/pdf?key=${encodeURIComponent(INTERNAL_KEY)}`, {
    method:  "POST",
    headers: { "content-type": "application/pdf" },
    body:    buf,
  });
  return await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`[sync] target ${HOST}`);
let total = 0, skipped = 0, uploaded = 0, failed = 0, ins = 0, dupes = 0;

for (const folder of folders) {
  if (!fs.existsSync(folder)) { console.error(`  [skip-folder] ${folder} not found`); continue; }
  const files = fs.readdirSync(folder)
    .filter((f) => /\.(csv|pdf)$/i.test(f))
    .sort();
  console.log(`[scan] ${folder} — ${files.length} files`);

  for (const f of files) {
    total++;
    const full = path.join(folder, f);
    const buf  = fs.readFileSync(full);
    const h    = hashFile(buf);
    const ext  = path.extname(f).toLowerCase();

    if (cache[h]) {
      console.log(`  · ${f} — already processed (${cache[h].at})`);
      skipped++;
      continue;
    }

    process.stdout.write(`  → ${f} (${(buf.length / 1024).toFixed(0)} KB, ${ext}) ... `);
    try {
      const body = ext === ".pdf" ? await uploadPdf(full, buf) : await uploadCsv(full, buf);
      if (body.error) {
        console.log(`FAIL — ${body.error}`);
        failed++;
        continue;
      }
      console.log(`ok — ins=${body.inserted} skp=${body.skipped} err=${body.errors}`);
      uploaded++;
      ins   += body.inserted || 0;
      dupes += body.skipped  || 0;
      cache[h] = { file: f, folder, at: new Date().toISOString(), inserted: body.inserted, skipped: body.skipped };
      save();
    } catch (err) {
      console.log(`FAIL — ${err.message}`);
      failed++;
    }
  }
}

console.log(`\n[done] ${total} files scanned · ${uploaded} uploaded · ${skipped} cached · ${failed} failed`);
console.log(`       inserted=${ins} duplicates-skipped=${dupes}`);
