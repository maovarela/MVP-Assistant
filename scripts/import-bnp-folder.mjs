#!/usr/bin/env node
// import-bnp-folder.mjs
// Iterates a folder of BNP statement PDFs and POSTs each to /import/pdf.
// The server-side parser (transactions.importPdf) auto-skips Amex / Revolut
// internal transfers to avoid double-counting against the line-item data we
// already loaded from those bank exports.
//
// Usage:
//   $env:INTERNAL_IMPORT_KEY = "..."
//   node scripts/import-bnp-folder.mjs "C:\path\to\BNP"
//
// Optional:
//   $env:HOST = "http://localhost:8080"   # default: Railway prod
//
// Dedup: when the same statement period exists with " (1).pdf" suffix
// alongside the original, we upload BOTH — the server's transaction-level
// dedup (external_id) will keep the union and skip duplicates. Safer than
// guessing which is the "right" file.

import fs from "fs";
import path from "path";

const folder = process.argv[2];
if (!folder) {
  console.error("usage: node scripts/import-bnp-folder.mjs <folder>");
  process.exit(1);
}
const HOST = (process.env.HOST || "https://mvp-assistant-production.up.railway.app").replace(/\/$/, "");
const KEY  = process.env.INTERNAL_IMPORT_KEY;
if (!KEY) { console.error("ERROR: set INTERNAL_IMPORT_KEY"); process.exit(1); }

const files = fs.readdirSync(folder)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .sort();

if (!files.length) { console.error(`no PDFs in ${folder}`); process.exit(1); }
console.log(`[bnp] ${files.length} PDFs in ${folder}`);

let okN = 0, failN = 0, ins = 0, skp = 0, err = 0;
for (const f of files) {
  const full = path.join(folder, f);
  const body = fs.readFileSync(full);
  process.stdout.write(`  ${f} (${(body.length / 1024).toFixed(0)} KB) ... `);
  try {
    const r = await fetch(`${HOST}/import/pdf?key=${encodeURIComponent(KEY)}`, {
      method:  "POST",
      headers: { "content-type": "application/pdf" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      console.log(`FAIL ${r.status} ${j.error || ""}`);
      failN++;
    } else {
      console.log(`ok — ins=${j.inserted} skp=${j.skipped} err=${j.errors} total=${j.total ?? "?"}`);
      okN++;
      ins += j.inserted || 0;
      skp += j.skipped  || 0;
      err += j.errors   || 0;
    }
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    failN++;
  }
}

console.log(`\n[done] ${okN} PDFs ok, ${failN} failed — inserted=${ins} skipped(dup)=${skp} errors=${err}`);
