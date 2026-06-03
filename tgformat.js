// tgformat.js
// Convert the loose Markdown our LLM (and hand-built notification strings) emit
// into Telegram-safe HTML.
//
// Why HTML and not Markdown: Telegram's legacy "Markdown" parse mode renders
// **bold** and #### headers LITERALLY (only *single-asterisk* is bold), so the
// briefings looked broken — full of stray ** and ####. HTML parse mode is the
// reliable target: real <b>/<i>/<code>, real newlines, and any stray markup we
// miss degrades to plain text instead of 400-erroring the whole message.
//
// WhatsApp uses its own *single-asterisk* syntax and is left untouched upstream.

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  s = escapeHtml(s);
  // inline code first so we don't bold/italicise inside it
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold: **text** / __text__
  s = s.replace(/\*\*([^\n*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n_]+)__/g, "<b>$1</b>");
  // bold: *text* (single asterisk — WhatsApp/Telegram-legacy + our hand-built headers)
  s = s.replace(/(^|[^\w*])\*(?!\s)([^\n*]+?)(?<!\s)\*(?![\w*])/g, "$1<b>$2</b>");
  // italic: _text_ (word-boundary guards so it doesn't eat snake_case identifiers)
  s = s.replace(/(^|[\s(])_(?!\s)([^\n_]+?)(?<!\s)_(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  return s;
}

/** Markdown-ish string → Telegram HTML. Safe to feed any LLM output. */
export function toTelegramHTML(md) {
  if (md == null) return "";
  const lines = String(md).replace(/\r/g, "").split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, ""); // drop trailing spaces (md hard-breaks)
    // Horizontal rule → thin separator
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push("──────────"); continue; }
    // ATX header (#..######) → bold on its own line, with a blank line above it
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push("<b>" + inline(h[2].replace(/[\s#:]+$/, "")) + "</b>");
      continue;
    }
    // Bullet → • marker, preserving the original indent so nesting still reads
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) {
      const marker = b[1].length >= 2 ? "◦" : "•";
      out.push(`${b[1]}${marker} ${inline(b[2])}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
