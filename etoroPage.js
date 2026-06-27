// etoroPage.js
// Self-contained "Régularisation eToro" page. Renders the per-year figures
// mapped to the French forms (3916-bis, 2074/2042-C, 2086, 2047/2042) plus a
// reconciliation footer. Print-friendly so the same page is the worksheet you
// hand to the fiscaliste. ?year=YYYY isolates one year; ?print=1 auto-prints.
//
// UI is English (per the dashboard convention); French form numbers are kept
// verbatim as the proper nouns they are.

import {
  getStatement, getTaxYears, getTaxYear, getReconciliation,
  getPositionsByYear, getDividendsByYear,
} from "./etoro.js";

const CURRENT_YEAR = 2026; // statement period end; "current" (not yet a closed declaration year)
const eur = (n) => (n == null ? "—" : `${n < 0 ? "−" : ""}€${Math.abs(n).toFixed(2)}`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Declaration status for a given fiscal year, relative to today (2026).
function yearStatus(year) {
  if (year < CURRENT_YEAR) return { label: "To regularize", cls: "bg-warn-container text-on-surface", note: `income year ${year} — declare via correction (déclaration rectificative)` };
  return { label: "Current year", cls: "bg-secondary-container text-on-surface", note: `declare in spring ${year + 1} with the rest of your ${year} return` };
}

function reconRow(r) {
  const usdDiff = r.ours_usd - r.etoro_usd;
  const ok = Math.abs(usdDiff) <= 0.5;
  return `<tr class="border-t border-outline-variant/30">
    <td class="py-1.5 pr-4 font-medium">${r.cls}</td>
    <td class="py-1.5 pr-4 text-right tabular-nums">${r.ours_usd.toFixed(2)}</td>
    <td class="py-1.5 pr-4 text-right tabular-nums text-on-surface-variant">${r.etoro_usd.toFixed(2)}</td>
    <td class="py-1.5 pr-4 text-right tabular-nums">${ok ? '<span class="text-primary">✓</span>' : `<span class="text-error">${usdDiff.toFixed(2)}</span>`}</td>
    <td class="py-1.5 pr-4 text-right tabular-nums font-medium">${eur(r.ours_eur)}</td>
  </tr>`;
}

// One per-year card: form mapping + 3916-bis checklist.
function yearCard(y, stmt) {
  const st = yearStatus(y.year);
  const gains = (y.stocks_pnl_eur || 0) + (y.cfd_pnl_eur || 0);
  const line = (label, val, form, extra = "") => `
    <div class="flex items-baseline justify-between gap-3 py-1.5 border-t border-outline-variant/20">
      <div class="min-w-0">
        <div class="text-sm font-medium text-on-surface">${label}</div>
        <div class="text-xs text-on-surface-variant">${form}${extra ? ` · ${extra}` : ""}</div>
      </div>
      <div class="tabular-nums font-headline font-semibold ${val < 0 ? "text-error" : "text-on-surface"}">${eur(val)}</div>
    </div>`;

  return `<section class="break-inside-avoid bg-surface-container-lowest rounded-2xl border border-outline-variant/30 p-5 shadow-sm">
    <div class="flex items-center justify-between mb-1">
      <h2 class="font-headline text-xl font-bold text-on-surface">${y.year}</h2>
      <span class="text-xs font-medium px-2.5 py-1 rounded-full ${st.cls}">${st.label}</span>
    </div>
    <p class="text-xs text-on-surface-variant mb-3">${st.note}</p>

    <!-- 3916-bis: the obligation that applies every held year regardless of activity -->
    <div class="mb-4 p-3 rounded-lg bg-surface-container-low">
      <div class="text-sm font-semibold text-on-surface mb-1">Form 3916-bis — foreign account</div>
      <ul class="text-xs text-on-surface-variant space-y-0.5">
        <li>☐ Holder: <span class="font-medium text-on-surface">${esc(stmt?.holder_name || "—")}</span></li>
        <li>☐ Institution: <span class="font-medium text-on-surface">${esc(stmt?.institution || "eToro (Europe) Ltd, Cyprus")}</span></li>
        <li>☐ Account ref: <span class="font-medium text-on-surface">${esc(stmt?.username || "—")}</span> · type: securities + digital-asset account</li>
        <li>☐ Required even with no activity — declare for ${y.year}</li>
      </ul>
    </div>

    ${line("Securities capital gains", gains, "Form 2074 → 2042-C (PFU 30%)", `${y.n_positions} closed positions`)}
    ${line("— of which real stocks", y.stocks_pnl_eur, "Stocks")}
    ${line("— of which CFD / other", y.cfd_pnl_eur, "CFD")}
    ${line("Crypto disposals", y.crypto_pnl_eur, "Form 2086", "method: portfolio-value at each cash-out — confirm w/ fiscaliste")}
    ${line("Foreign dividends (net)", y.dividends_eur, "Form 2047 → 2042", `withholding ${eur(y.dividends_wht_eur)} → crédit d'impôt`)}

    <div class="mt-3 pt-2 border-t border-outline-variant/30 grid grid-cols-3 gap-2 text-center">
      <div><div class="text-[10px] uppercase tracking-wide text-on-surface-variant">Deposits</div><div class="text-sm tabular-nums">${eur(y.deposits_eur)}</div></div>
      <div><div class="text-[10px] uppercase tracking-wide text-on-surface-variant">Withdrawals</div><div class="text-sm tabular-nums">${eur(y.withdrawals_eur)}</div></div>
      <div><div class="text-[10px] uppercase tracking-wide text-on-surface-variant">FX fees</div><div class="text-sm tabular-nums">${eur(y.fx_fees_eur)}</div></div>
    </div>
  </section>`;
}

export function renderEtoroPage({ year, print, key } = {}) {
  // Internal links must carry the DASH_KEY query param or they 401.
  const k = key ? `key=${encodeURIComponent(key)}` : "";
  const href = (qs) => {
    const parts = [qs, k].filter(Boolean);
    return "/etoro" + (parts.length ? "?" + parts.join("&") : "");
  };
  const stmt = getStatement();
  if (!stmt) {
    return `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
      <h1>No eToro statement imported yet</h1>
      <p>Run: <code>node scripts/import-etoro.mjs --file "&lt;statement.xlsx&gt;"</code></p>
    </body></html>`;
  }
  const all = getTaxYears();
  const years = year ? all.filter((y) => y.year === Number(year)) : all;

  const recon = getReconciliation(stmt.id);
  const totals = all.reduce((a, y) => {
    a.gains += (y.stocks_pnl_eur || 0) + (y.cfd_pnl_eur || 0);
    a.crypto += y.crypto_pnl_eur || 0;
    a.div += y.dividends_eur || 0;
    a.wht += y.dividends_wht_eur || 0;
    return a;
  }, { gains: 0, crypto: 0, div: 0, wht: 0 });

  return `<!doctype html>
<html class="light" lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Régularisation eToro</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com?plugins=forms"></script>
  <script>
    tailwind.config = { theme: { extend: {
      colors: {
        "background":"#f8f9ff","surface-container-lowest":"#ffffff","surface-container-low":"#eff4ff",
        "surface-container":"#e5eeff","on-surface":"#0b1c30","on-surface-variant":"#3c4a3d",
        "outline-variant":"#bbcbb9","primary":"#006d32","secondary-container":"#d8e2ff",
        "error":"#ba1a1a","error-container":"#ffdad6","warn-container":"#ffddb8",
      },
      fontFamily:{ "headline":["Space Grotesk","system-ui"], "body":["Inter","system-ui"] },
      borderRadius:{ "lg":"0.5rem","xl":"0.75rem","2xl":"1rem","full":"9999px" },
    }}};
  </script>
  <style>
    body { min-height:100dvh; }
    @media print {
      .no-print { display:none !important; }
      body { background:#fff !important; }
      section { box-shadow:none !important; border-color:#ccc !important; }
    }
  </style>
</head>
<body class="bg-background text-on-surface font-body antialiased pb-12">
  <header class="px-4 sm:px-6 py-4 border-b border-outline-variant/30 bg-surface-container-lowest">
    <div class="max-w-5xl mx-auto flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 class="font-headline text-2xl font-bold">Régularisation eToro</h1>
        <p class="text-sm text-on-surface-variant">${esc(stmt.holder_name)} · ${esc(stmt.institution)} · period ${esc((stmt.period_start||"").slice(0,10))} → ${esc((stmt.period_end||"").slice(0,10))}</p>
      </div>
      <div class="no-print flex items-center gap-2">
        ${year ? `<a href="${href("")}" class="text-sm px-3 py-1.5 rounded-lg border border-outline-variant/40">All years</a>` : ""}
        <button onclick="window.print()" class="text-sm px-3 py-1.5 rounded-lg bg-primary text-white font-medium">Print / PDF</button>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 sm:px-6 pt-5 space-y-5">
    <!-- Scope banner: the held-years correction vs the original "4 years" assumption -->
    <div class="bg-surface-container rounded-xl p-4 text-sm">
      <p class="font-medium mb-1">Scope — ${all.length} active year${all.length === 1 ? "" : "s"} (${all.length ? `${all[0].year}–${all[all.length - 1].year}` : "none"})</p>
      <p class="text-on-surface-variant">First activity was in <strong>${all[0]?.year ?? "—"}</strong>, so the closed years to regularize are <strong>${all.filter((y) => y.year < CURRENT_YEAR).map((y) => y.year).join(" and ") || "—"}</strong> (${CURRENT_YEAR} is the current year). The statement's "${esc((stmt.period_start || "").slice(0, 4))}" start date is just the report window, not the account age. <span class="font-medium">Confirm the account wasn't opened in an earlier year with zero activity — 3916-bis is still due for any held year.</span></p>
    </div>

    <!-- Whole-period totals -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${[
        ["Securities gains", totals.gains, "2074 → 2042-C"],
        ["Crypto P&L", totals.crypto, "2086"],
        ["Dividends (net)", totals.div, "2047 → 2042"],
        ["Withholding (crédit)", totals.wht, "2047"],
      ].map(([l, v, f]) => `<div class="bg-surface-container-lowest rounded-xl border border-outline-variant/30 p-3">
        <div class="text-xs text-on-surface-variant">${l}</div>
        <div class="font-headline text-lg font-bold tabular-nums ${v < 0 ? "text-error" : ""}">${eur(v)}</div>
        <div class="text-[10px] text-on-surface-variant mt-0.5">Form ${f}</div>
      </div>`).join("")}
    </div>

    <!-- Per-year cards -->
    <div class="grid md:grid-cols-2 gap-4">
      ${years.map((y) => yearCard(y, stmt)).join("")}
    </div>

    <!-- Reconciliation -->
    <section class="bg-surface-container-lowest rounded-2xl border border-outline-variant/30 p-5">
      <h2 class="font-headline text-lg font-bold mb-1">Reconciliation vs eToro Financial Summary</h2>
      <p class="text-xs text-on-surface-variant mb-3">USD matches eToro exactly (structural check). EUR is summed per position at its close-date FX — the basis the French forms expect — so it differs slightly from eToro's single-rate total. That gap is the FX method, not an error.</p>
      <table class="w-full text-sm">
        <thead><tr class="text-xs text-on-surface-variant text-left">
          <th class="py-1 pr-4">Asset class</th><th class="py-1 pr-4 text-right">Our USD</th>
          <th class="py-1 pr-4 text-right">eToro USD</th><th class="py-1 pr-4 text-right">Δ USD</th>
          <th class="py-1 pr-4 text-right">Our EUR (tax)</th>
        </tr></thead>
        <tbody>${recon.map(reconRow).join("")}</tbody>
      </table>
    </section>

    <p class="text-xs text-on-surface-variant px-1">
      Figures and checklist only — not tax advice. The <strong>2086</strong> crypto line and the exact held-years for <strong>3916-bis</strong> are the two items worth a fiscaliste consult, as flagged in the brief.
      ${year ? "" : `Per-year worksheets: ${all.map((y) => `<a class="underline" href="${href(`year=${y.year}`)}">${y.year}</a>`).join(" · ")}`}
    </p>
  </main>
  ${print ? "<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300));</script>" : ""}
</body></html>`;
}
