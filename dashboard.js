// dashboard.js
// Cuentas MVP dashboard — v2. Single static HTML + Chart.js via CDN.
// Layout goals after user feedback:
//   - Above-the-fold (no scroll on phone): header + dial + KPIs + insight strip
//   - Single combined "Gastos" table (fijos + variables) with filter chips
//   - Per-type summaries (count + total) in the chips themselves
//   - Year + Month split selectors instead of one big period dropdown
//   - Debt + FOREX sections removed (user has no debt, FX shown in dropdown is enough)

export function renderDashboard(period) {
  const initialPeriod = period ? `"${period}"` : "null";
  return `<!doctype html>
<html class="light" lang="es"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cuentas MVP</title>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    tailwind.config = {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            "background": "#f8f9ff",
            "surface": "#f8f9ff",
            "surface-bright": "#ffffff",
            "surface-container-lowest": "#ffffff",
            "surface-container-low": "#eff4ff",
            "surface-container": "#e5eeff",
            "surface-container-high": "#dce9ff",
            "surface-container-highest": "#d3e4fe",
            "on-surface": "#0b1c30",
            "on-surface-variant": "#3c4a3d",
            "outline": "#6c7b6c",
            "outline-variant": "#bbcbb9",
            "primary": "#006d32",
            "primary-container": "#bdf0c8",
            "on-primary": "#ffffff",
            "on-primary-container": "#005324",
            "secondary": "#0059bb",
            "secondary-container": "#d8e2ff",
            "on-secondary": "#ffffff",
            "error": "#ba1a1a",
            "error-container": "#ffdad6",
            "on-error": "#ffffff",
            "warn": "#a76900",
            "warn-container": "#ffddb8",
          },
          fontFamily: {
            "headline": ["Space Grotesk", "system-ui"],
            "body":     ["Inter", "system-ui"],
          },
          borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "2xl": "1rem", "full": "9999px" },
        },
      },
    };
  </script>
  <style>
    .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
    body { min-height: 100dvh; }
    select { background-image: none; padding-right: 1.5rem; }
  </style>
</head><body class="bg-background text-on-background font-body antialiased min-h-screen pb-8">

<!-- HEADER (compact, sticky, mobile-aware) -->
<header class="sticky top-0 z-50 px-3 sm:px-4 py-2.5 bg-surface/85 backdrop-blur-md border-b border-outline-variant/20">
  <div class="flex items-center justify-between gap-2">
    <!-- Logo: minimalist geometric mark + wordmark in Space Grotesk -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-on-surface flex items-center justify-center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 17V21H21V17M3 17L8 8L13 14L17 6L21 11" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="hidden sm:flex flex-col leading-tight">
        <div class="font-headline font-bold text-base tracking-tight text-on-surface">Accounts</div>
        <div class="font-headline font-medium text-[10px] tracking-[0.2em] text-outline uppercase">MVP</div>
      </div>
    </div>
    <!-- Tab nav: Overview | Transactions -->
    <nav class="flex items-center gap-1">
      <button id="tabResumen"   class="tabBtn px-2.5 sm:px-3 py-3.5 sm:py-1.5 rounded-full text-xs font-semibold transition-colors bg-primary text-on-primary">Overview</button>
      <button id="tabHistorico" class="tabBtn px-2.5 sm:px-3 py-3.5 sm:py-1.5 rounded-full text-xs font-semibold transition-colors bg-surface-container text-on-surface hover:bg-surface-container-high">Transactions</button>
      <button id="tabB2b"       class="tabBtn px-2.5 sm:px-3 py-3.5 sm:py-1.5 rounded-full text-xs font-semibold transition-colors bg-surface-container text-on-surface hover:bg-surface-container-high">B2B</button>
      <button id="addExpenseBtn" title="Log an expense" class="flex items-center gap-1 px-2.5 sm:px-3 py-3.5 sm:py-1.5 rounded-full text-xs font-semibold transition-colors bg-surface-container text-on-surface hover:bg-surface-container-high">
        <span class="material-symbols-outlined" style="font-size:16px">add</span><span class="hidden sm:inline">Add</span>
      </button>
      <span id="reconBadge" class="hidden items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold border border-error/40 text-error bg-surface-container-lowest" title="">
        <span class="material-symbols-outlined" style="font-size:16px">warning</span><span id="reconBadgeText"></span>
      </span>
    </nav>

    <!-- Period picker: single button that opens a popover with year tabs + month grid -->
    <div class="relative flex-shrink-0">
    <button id="periodBtn" class="flex items-center gap-1 sm:gap-2 bg-primary-container text-on-primary-container rounded-full pl-2.5 sm:pl-4 pr-2 sm:pr-3 py-3 sm:py-2 text-xs sm:text-sm font-semibold hover:opacity-90 transition-opacity whitespace-nowrap">
      <span id="periodBtnLabel">—</span>
      <span class="material-symbols-outlined" style="font-size: 18px;">expand_more</span>
    </button>

    <div id="periodPopover" class="hidden absolute right-0 top-full mt-2 z-50 w-80 bg-surface-container-lowest border border-outline-variant/30 rounded-2xl shadow-2xl overflow-hidden">
      <div class="px-4 py-3 border-b border-outline-variant/20 flex items-center justify-between">
        <button id="periodPrev" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined" style="font-size: 18px;">chevron_left</span>
        </button>
        <div id="periodYearLabel" class="font-headline font-bold text-lg tabular-nums">—</div>
        <button id="periodNext" class="w-8 h-8 rounded-full hover:bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined" style="font-size: 18px;">chevron_right</span>
        </button>
      </div>
      <div id="periodMonths" class="grid grid-cols-3 gap-1.5 p-3"></div>
    </div>
    </div>
  </div>
</header>

<main id="viewResumen" class="max-w-5xl mx-auto px-4 pt-4 space-y-4">

  <!-- ABOVE THE FOLD: dial + KPIs side-by-side on desktop, stacked on mobile -->
  <section class="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">

    <!-- Spending progress dial: % of income spent this month -->
    <div class="md:col-span-2 flex justify-center">
      <div class="relative w-52 h-52 md:w-56 md:h-56 flex items-center justify-center">
        <div class="absolute inset-0 rounded-full bg-primary/5 blur-3xl"></div>

        <svg class="absolute w-full h-full -rotate-90 transform" viewBox="0 0 100 100">
          <circle class="text-surface-container" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor" stroke-width="8"/>
          <circle id="ringOuter" class="text-primary transition-all duration-700" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor"
                  stroke-dasharray="282.7" stroke-dashoffset="282.7" stroke-linecap="round" stroke-width="8"/>
        </svg>

        <div class="z-10 text-center px-2" title="Real spending this month vs total income. Green < 60%, amber 60-90%, red > 90%.">
          <div class="text-[10px] font-bold uppercase tracking-widest text-outline">Spent this month</div>
          <div class="font-headline text-3xl md:text-4xl font-bold tabular-nums leading-none mt-1" id="dialResidual">—</div>
          <div class="mt-1 font-headline text-xl font-bold tabular-nums" id="dialPctSpent">—</div>
          <div class="mt-1.5 text-[10px] text-outline leading-tight">
            of <span id="dialIncome">—</span> income<br/>
            <span class="text-on-surface text-[11px] font-semibold" id="dialAvailable">—</span> still available
          </div>
        </div>
      </div>
    </div>

    <!-- KPI cards: 3/5 cols on desktop, full on mobile. Always 2x2 grid. -->
    <div class="md:col-span-3 grid grid-cols-2 gap-3">
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Income</div>
        <div class="font-headline text-xl font-bold text-on-surface tabular-nums mt-1" id="kpiIncome">—</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Actual spend</div>
        <div class="font-headline text-xl font-bold tabular-nums mt-1" id="kpiActual">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiActualVsPlan">vs plan —</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Total planned</div>
        <div class="font-headline text-xl font-bold text-on-surface tabular-nums mt-1" id="kpiPlanned">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiPlannedBreak">F — · V —</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">% spent</div>
        <div class="font-headline text-xl font-bold tabular-nums mt-1" id="kpiPct">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiPctSub"></div>
      </div>
    </div>
  </section>

  <!-- Insight strip (1-line, auto-picks the highest-signal message) -->
  <section id="insight" class="rounded-2xl p-4 flex items-center gap-3 border border-outline-variant/15">
    <!-- populated by JS -->
  </section>

  <!-- 3-month comparison: top movers -->
  <section class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 overflow-hidden">
    <div class="flex items-center justify-between px-4 py-3 border-b border-outline-variant/15">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-tertiary" style="font-size: 18px;">trending_up</span>
        <h3 class="font-headline font-bold text-base tracking-tight">Last 3 months comparison</h3>
      </div>
      <div class="text-[11px]" id="comparisonTotalDelta">—</div>
    </div>
    <div id="comparisonBody" class="p-2">
      <div class="text-xs text-outline italic p-3">Loading…</div>
    </div>
  </section>

  <!-- Account cashflow (BNP, Amex, Revolut) -->
  <section class="space-y-3">
    <div class="flex items-center gap-2 px-1">
      <span class="material-symbols-outlined text-secondary" style="font-size: 18px;">account_balance</span>
      <h3 class="font-headline font-bold text-base tracking-tight">Accounts <span id="bnpPeriodLabel" class="text-outline">—</span></h3>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3" id="accountsGrid">
      <!-- populated by JS — one card per account + a Total card -->
    </div>
    <!-- Internal-transfer panel — BNP madre → hijas Amex/Revolut -->
    <div id="internalFlowsPanel" class="hidden rounded-2xl bg-surface-container-lowest border border-outline-variant/15 p-4">
      <div class="flex items-center gap-2 mb-2.5">
        <span class="material-symbols-outlined text-outline" style="font-size:16px">sync_alt</span>
        <h4 class="font-headline font-bold text-xs uppercase tracking-wider text-outline">Internal transfers (BNP parent → children)</h4>
      </div>
      <div id="internalFlowsBody" class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs"></div>
      <p class="text-[10px] text-outline mt-2">These don't count as real spending — just moves money between your accounts. Excluded from "% of income" and the donut.</p>
    </div>
  </section>

  <!-- YTD strip — consolidado del año hasta ahora -->
  <section class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 overflow-hidden">
    <div class="flex items-center justify-between px-4 py-3 border-b border-outline-variant/15">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-primary" style="font-size: 18px;">calendar_view_month</span>
        <h3 class="font-headline font-bold text-base tracking-tight">Consolidated <span id="ytdYearLabel" class="text-outline">—</span></h3>
      </div>
      <div id="ytdMonthsLabel" class="text-xs text-outline">—</div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-outline-variant/20" id="ytdCards">
      <!-- populated by JS -->
    </div>
    <div class="px-4 py-3 border-t border-outline-variant/15">
      <div class="text-[10px] font-bold uppercase tracking-wider text-outline mb-2">Top categories YTD</div>
      <div id="ytdTopCats" class="flex flex-wrap gap-1.5"></div>
    </div>
  </section>

  <!-- ═══════════════════ BELOW THE FOLD ═══════════════════ -->

  <!-- COMBINED GASTOS TABLE with filter chips -->
  <section class="space-y-3">
    <div class="flex items-center justify-between px-1 flex-wrap gap-2">
      <div class="flex items-center gap-3">
        <h2 class="font-headline text-lg font-bold tracking-tight text-on-surface">Spending</h2>
        <button onclick="openBudgetEditor()" class="text-xs font-semibold px-3 py-1 rounded-full bg-primary text-on-primary hover:opacity-90">
          ✏️ Edit budget
        </button>
        <button id="catAuditBtn" onclick="openCatAudit()" class="hidden text-xs font-semibold px-3 py-1 rounded-full bg-warn-container text-warn hover:opacity-90" title="Compares regex rules vs stored category. Lets you bulk-fix old txs after adding a new rule.">
          🩺 Categorization audit (<span id="catAuditCount">0</span>)
        </button>
        <button id="auditBtn" class="hidden"></button>
      </div>
      <div class="flex items-center gap-2" id="filterChips">
        <!-- populated by JS -->
      </div>
    </div>
    <div class="rounded-2xl bg-surface-container-lowest overflow-hidden border border-outline-variant/15">
      <div class="px-3 py-2 border-b border-outline-variant/15 bg-surface-container-low">
        <input id="gastosFilter" type="search" placeholder="🔎 Filter category…" class="w-full md:w-64 bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none" />
      </div>
      <table class="w-full text-xs sm:text-sm">
        <thead class="bg-surface-container sticky top-0 z-10">
          <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
            <th class="px-2 sm:px-3 py-2.5 cursor-pointer select-none hover:text-on-surface" data-sort="name">Category <span class="gastosSortArrow text-outline" data-col="name"></span></th>
            <th class="px-2 sm:px-3 py-2.5 text-right cursor-pointer select-none hover:text-on-surface" data-sort="budget">Budget <span class="gastosSortArrow text-outline" data-col="budget"></span></th>
            <th class="px-2 sm:px-3 py-2.5 text-right cursor-pointer select-none hover:text-on-surface" data-sort="actual">Actual <span class="gastosSortArrow text-outline" data-col="actual"></span></th>
            <th class="hidden sm:table-cell px-2 sm:px-3 py-2.5 text-right cursor-pointer select-none hover:text-on-surface" data-sort="delta">Δ <span class="gastosSortArrow text-outline" data-col="delta"></span></th>
            <th class="px-2 sm:px-3 py-2.5 text-right w-12 sm:w-16 cursor-pointer select-none hover:text-on-surface" data-sort="pct">% <span class="gastosSortArrow text-outline" data-col="pct"></span></th>
          </tr>
        </thead>
        <tbody id="gastosTbl"></tbody>
      </table>
    </div>
  </section>

  <!-- CHARTS — CFO-grade layout -->

  <!-- ROW 1: Variance (left, wide) + Donut (right, compact) -->
  <section class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <div class="lg:col-span-2 rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="text-sm font-semibold text-on-surface">Budget vs actual</div>
          <div class="text-[11px] text-outline">Real spend vs plan per category, sorted by amount</div>
        </div>
        <div class="flex items-center gap-2 text-[10px]">
          <span class="flex items-center gap-1"><span class="w-2 h-2 bg-primary rounded-full"></span>Under</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 bg-warn rounded-full"></span>Near</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 bg-error rounded-full"></span>Over</span>
        </div>
      </div>
      <div id="varianceList" class="space-y-2.5"></div>
    </div>
    <div class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15 flex flex-col">
      <div class="text-sm font-semibold text-on-surface mb-2">Spending mix</div>
      <div class="relative h-[200px]">
        <canvas id="donut"></canvas>
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div class="text-[10px] uppercase tracking-wider text-outline">Total real</div>
          <div class="font-headline text-2xl font-bold tabular-nums" id="donutCenter">—</div>
          <div class="text-[11px] text-outline mt-1" id="donutSubtitle">—</div>
        </div>
      </div>
      <div id="donutLegend" class="mt-3 space-y-1 text-[11px]"></div>
    </div>
  </section>

  <!-- ROW 2: 6-month stacked trend (full width) -->
  <section class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-sm font-semibold text-on-surface">Spending over time (last 6 months)</div>
        <div class="text-[11px] text-outline">Category mix — detect shifts and growth</div>
      </div>
    </div>
    <canvas id="trendStack" style="max-height: 320px"></canvas>
  </section>

  <!-- ROW 3: Cash position (full width or split) -->
  <section class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-sm font-semibold text-on-surface">BNP cash position</div>
        <div class="text-[11px] text-outline">Closing balance per month — accumulating or burning</div>
      </div>
      <div id="cashTrend" class="text-xs font-semibold"></div>
    </div>
    <canvas id="cashLine" style="max-height: 240px"></canvas>
  </section>

  <!-- ROW 4: Pending items (receivables / payables / reimbursements) -->
  <section class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div>
        <div class="text-sm font-semibold text-on-surface">📝 Pending (debts & reimbursements)</div>
        <div class="text-[11px] text-outline">Off-account notes — people who owe you, who you owe, and refunds in flight</div>
      </div>
      <button id="pendingAddBtn" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-primary text-on-primary hover:opacity-90">+ Add item</button>
    </div>
    <!-- Totals strip -->
    <div id="pendingTotals" class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3"></div>
    <!-- Inline add form (hidden until + clicked) -->
    <div id="pendingAddForm" class="hidden mb-3 p-3 rounded-xl bg-surface-container border border-outline-variant/30">
      <div class="grid grid-cols-1 md:grid-cols-5 gap-2">
        <select id="pfKind" class="bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1.5 focus:ring-2 focus:ring-primary focus:outline-none">
          <option value="receivable">💰 Owed to me</option>
          <option value="payable">📤 I owe</option>
          <option value="reimbursement">🔁 Reimbursement</option>
        </select>
        <input id="pfWho" type="text" placeholder="Who (Sebas, Iván, SNCF, Henner…)" class="bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1.5 focus:ring-2 focus:ring-primary focus:outline-none md:col-span-2" />
        <input id="pfAmount" type="number" step="0.01" min="0" placeholder="€" class="bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1.5 focus:ring-2 focus:ring-primary focus:outline-none" />
        <input id="pfExpected" type="text" placeholder="When (e.g. 2026-07, October)" class="bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1.5 focus:ring-2 focus:ring-primary focus:outline-none" />
      </div>
      <input id="pfDesc" type="text" placeholder="Notes (e.g. train Málaga, podólogo)" class="mt-2 w-full bg-surface-container-lowest text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1.5 focus:ring-2 focus:ring-primary focus:outline-none" />
      <div class="flex justify-end gap-2 mt-2">
        <button id="pfCancel" class="text-xs px-3 py-1 rounded-md text-outline hover:bg-surface-container-low">Cancel</button>
        <button id="pfSave" class="text-xs font-semibold px-3 py-1 rounded-md bg-primary text-on-primary hover:opacity-90">Save</button>
      </div>
    </div>
    <div id="pendingList" class="space-y-1.5"></div>
    <div class="mt-3 flex items-center justify-between text-[11px] text-outline">
      <label class="flex items-center gap-1.5 cursor-pointer"><input id="pendingShowSettled" type="checkbox" class="rounded"/> Show settled</label>
      <span>Edit inline · click ✓ to mark settled · 🗑 to delete</span>
    </div>
  </section>

</main>

<!-- VIEW: B2B (Shine / negocio — independiente de las cuentas personales) -->
<main id="viewB2B" class="hidden max-w-5xl mx-auto px-4 pt-4 space-y-4">

  <!-- Status / connect-Shine note -->
  <section class="rounded-2xl p-4 flex items-start gap-3 border border-outline-variant/15 bg-surface-container-lowest">
    <span class="material-symbols-outlined text-secondary" style="font-size:18px">storefront</span>
    <div class="text-xs text-on-surface">
      <div class="font-semibold">B2B account (Shine) — independent from your personal accounts</div>
      <div class="text-outline mt-0.5">Vandfort + Zentra + Touro share a single micro ceiling (one EI). Connect Shine to feed real revenue; for now it's computed from already-ingested transactions.</div>
    </div>
  </section>

  <!-- Techo: CA combinado + progreso vs umbrales -->
  <section class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 p-5 space-y-4">
    <div class="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Combined revenue <span id="b2bYear">—</span></div>
        <div class="font-headline text-3xl font-bold tabular-nums mt-1" id="b2bCA">—</div>
        <div class="text-[11px] text-outline mt-0.5"><span id="b2bYearFraction">—</span> of the year · run-rate <span id="b2bRunRate" class="text-on-surface font-semibold">—</span>/day</div>
      </div>
      <div class="text-right">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Year-end projection</div>
        <div class="font-headline text-xl font-bold tabular-nums mt-1" id="b2bProjected">—</div>
      </div>
    </div>

    <!-- Franchise TVA -->
    <div>
      <div class="flex items-center justify-between text-[11px] mb-1">
        <span class="font-semibold text-on-surface">Franchise TVA</span>
        <span class="text-outline"><span id="b2bTvaPct">—</span> · <span id="b2bTvaCross">—</span></span>
      </div>
      <div class="h-2.5 rounded-full bg-surface-container overflow-hidden">
        <div id="b2bTvaBar" class="h-full rounded-full bg-primary transition-all duration-700" style="width:0%"></div>
      </div>
      <div class="text-[10px] text-outline mt-0.5" id="b2bTvaLabel">— / —</div>
    </div>

    <!-- Techo micro -->
    <div>
      <div class="flex items-center justify-between text-[11px] mb-1">
        <span class="font-semibold text-on-surface">Micro-entreprise ceiling</span>
        <span class="text-outline"><span id="b2bMicroPct">—</span> · <span id="b2bMicroCross">—</span></span>
      </div>
      <div class="h-2.5 rounded-full bg-surface-container overflow-hidden">
        <div id="b2bMicroBar" class="h-full rounded-full bg-primary transition-all duration-700" style="width:0%"></div>
      </div>
      <div class="text-[10px] text-outline mt-0.5" id="b2bMicroLabel">— / —</div>
    </div>
  </section>

  <!-- Split por negocio -->
  <section class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 overflow-hidden">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-outline-variant/15">
      <span class="material-symbols-outlined text-secondary" style="font-size:18px">donut_small</span>
      <h3 class="font-headline font-bold text-base tracking-tight">Revenue per business</h3>
    </div>
    <div id="b2bSplit" class="p-2">
      <div class="text-xs text-outline italic p-3">Loading…</div>
    </div>
  </section>

  <p class="text-[10px] text-outline px-1">Thresholds to confirm with the expert-comptable (services €37.5k / €77.7k · vente €188.7k). CDI salary and internal transfers excluded from revenue. Zentra and Touro share a Stripe account: they can't be split apart from the bank side.</p>

</main>

<!-- VIEW: Histórico (flat editable transactions list) -->
<main id="viewHistorico" class="hidden max-w-6xl mx-auto px-4 pt-4 space-y-4">
  <section class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 p-5">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div>
        <h2 class="font-headline text-lg font-bold tracking-tight text-on-surface">Transactions</h2>
        <p class="text-xs text-outline">Flat list — edit category inline for quick fixes.</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <button id="histSaveBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-surface-container text-outline cursor-not-allowed" disabled>✓ No unsaved changes</button>
        <input id="histSearch" type="search" placeholder="🔎 Search merchant…" class="bg-surface-container border-0 rounded-full text-xs font-medium px-3 py-1.5 w-48 focus:ring-2 focus:ring-primary focus:outline-none" />
      </div>
    </div>

    <!-- Filter row -->
    <div class="space-y-2 mb-3 pb-3 border-b border-outline-variant/15">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-1" id="histPresets">
          <button data-range="3m"  class="histPreset px-2.5 py-1 rounded-full text-[11px] font-semibold bg-surface-container text-outline hover:bg-surface-container-high transition-colors">3m</button>
          <button data-range="6m"  class="histPreset px-2.5 py-1 rounded-full text-[11px] font-semibold bg-surface-container text-outline hover:bg-surface-container-high transition-colors">6m</button>
          <button data-range="12m" class="histPreset px-2.5 py-1 rounded-full text-[11px] font-semibold bg-surface-container text-outline hover:bg-surface-container-high transition-colors">12m</button>
          <button data-range="ytd" class="histPreset px-2.5 py-1 rounded-full text-[11px] font-semibold bg-surface-container text-outline hover:bg-surface-container-high transition-colors">YTD</button>
        </div>
        <span class="hidden sm:inline text-outline-variant">|</span>
        <div class="flex items-center gap-1.5">
          <label class="text-[11px] font-bold text-on-surface">From</label>
          <select id="histYearFrom"  class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none"></select>
          <select id="histMonthFrom" class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none"></select>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-[11px] font-bold text-on-surface">To</label>
          <select id="histYearTo"  class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none"></select>
          <select id="histMonthTo" class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none"></select>
        </div>
        <span class="hidden sm:inline text-outline-variant">|</span>
        <div class="flex items-center gap-1.5 flex-wrap" id="histAccountFilter">
          <span class="text-[11px] font-bold text-on-surface mr-1">Accounts</span>
          <!-- chips populated by JS -->
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-1.5">
          <label class="text-[11px] font-bold text-on-surface">Category</label>
          <select id="histCategoryFilter" class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none">
            <option value="">All</option>
          </select>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-[11px] font-bold text-on-surface">Type</label>
          <select id="histTypeFilter" class="bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none">
            <option value="all">All</option>
            <option value="out">Outflows only (−)</option>
            <option value="in">Inflows only (+)</option>
            <option value="external">Exclude internal</option>
          </select>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-[11px] font-bold text-on-surface">Min € amount</label>
          <input id="histMinAmount" type="number" min="0" step="1" placeholder="0" class="w-20 bg-surface-container text-on-surface border border-outline-variant/30 rounded-md text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none" />
        </div>
      </div>
    </div>

    <!-- Stats line -->
    <div id="histStats" class="text-xs text-outline mb-3 tabular-nums">—</div>

    <div class="overflow-x-auto">
      <table class="w-full text-sm" id="historicoTbl">
        <thead class="bg-surface-container">
          <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
            <th class="px-2 sm:px-3 py-2.5 w-20 sm:w-24 cursor-pointer select-none hover:text-on-surface" data-histsort="date">Date <span class="histSortArrow" data-col="date"></span></th>
            <th class="hidden sm:table-cell px-2 sm:px-3 py-2.5 w-20 cursor-pointer select-none hover:text-on-surface" data-histsort="account">Account <span class="histSortArrow" data-col="account"></span></th>
            <th class="px-2 sm:px-3 py-2.5 cursor-pointer select-none hover:text-on-surface" data-histsort="merchant">Merchant <span class="histSortArrow" data-col="merchant"></span></th>
            <th class="px-2 sm:px-3 py-2.5 text-right w-20 sm:w-24 cursor-pointer select-none hover:text-on-surface" data-histsort="amount">€ <span class="histSortArrow" data-col="amount"></span></th>
            <th class="px-2 sm:px-3 py-2.5 w-32 sm:w-56 cursor-pointer select-none hover:text-on-surface" data-histsort="category">Category <span class="histSortArrow" data-col="category"></span></th>
          </tr>
        </thead>
        <tbody id="historicoBody"><tr><td colspan="5" class="px-3 py-8 text-center text-outline italic">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>
</main>

<!-- Category drilldown modal -->
<div id="drillModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4">
  <div class="bg-surface-container-lowest w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl max-h-[85vh] overflow-hidden flex flex-col">
    <div class="px-5 py-4 border-b border-outline-variant/20 flex items-center justify-between">
      <div>
        <div class="font-headline font-bold text-lg" id="drillTitle">—</div>
        <div class="text-xs text-outline" id="drillSub">—</div>
      </div>
      <button id="drillClose" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div id="drillBody" class="flex-1 overflow-y-auto"></div>
  </div>
</div>

<!-- Budget editor modal -->
<div id="budgetModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4">
  <div class="bg-surface-container-lowest w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-hidden flex flex-col">
    <div class="px-5 py-4 border-b border-outline-variant/20 flex items-center justify-between">
      <div>
        <div class="font-headline font-bold text-lg">Edit budget</div>
        <div class="text-xs text-outline" id="budgetModalSub">—</div>
      </div>
      <div class="flex items-center gap-2">
        <button id="budgetSaveBtn" class="px-4 py-2 rounded-lg text-sm font-semibold bg-surface-container text-outline cursor-not-allowed" disabled>✓ No unsaved changes</button>
        <button id="budgetCloneBtn" class="text-xs font-semibold text-primary hover:underline" title="Pre-fill empty categories with another month's values">📋 Use another month as template</button>
        <button id="budgetClose" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto" id="budgetBody"></div>
    <div class="px-5 py-3 border-t border-outline-variant/20 flex items-center justify-between text-xs">
      <span class="text-outline">Changes save instantly. Other months are not affected.</span>
      <button id="budgetDoneBtn" class="px-4 py-2 rounded-lg bg-primary text-on-primary font-semibold">Close</button>
    </div>
  </div>
</div>

<!-- BNP balance edit modal -->
<div id="bnpModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
  <div class="bg-surface-container-lowest w-full max-w-md rounded-2xl overflow-hidden">
    <div class="px-5 py-4 border-b border-outline-variant/20">
      <div class="font-headline font-bold text-lg">Balances BNP</div>
      <div class="text-xs text-outline" id="bnpModalPeriod">—</div>
    </div>
    <div class="p-5 space-y-4">
      <div>
        <label class="text-xs font-bold uppercase tracking-wider text-outline">Balance inicial (€)</label>
        <input id="bnpOpening" type="number" step="0.01" placeholder="ej. 4205.36" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm tabular-nums" />
      </div>
      <div>
        <label class="text-xs font-bold uppercase tracking-wider text-outline">Balance final (€) — opcional</label>
        <input id="bnpClosing" type="number" step="0.01" placeholder="se calcula automáticamente" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm tabular-nums" />
      </div>
      <p class="text-[11px] text-outline">If you leave the closing balance empty, it's computed as opening + credits − debits. Following months inherit it automatically.</p>
    </div>
    <div class="px-5 py-3 border-t border-outline-variant/20 flex justify-end gap-2">
      <button id="bnpCancel" class="px-4 py-2 rounded-lg text-sm font-medium text-on-surface hover:bg-surface-container">Cancelar</button>
      <button id="bnpSave"   class="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-on-primary hover:opacity-90">Guardar</button>
    </div>
  </div>
</div>

<!-- Add expense modal -->
<div id="addExpenseModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4">
  <div class="bg-surface-container-lowest w-full md:max-w-md md:rounded-2xl rounded-t-2xl overflow-hidden">
    <div class="px-5 py-4 border-b border-outline-variant/20 flex items-center justify-between">
      <div class="font-headline font-bold text-lg">Add expense</div>
      <button id="addExpenseClose" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="p-5 space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs font-bold uppercase tracking-wider text-outline">Amount (€)</label>
          <input id="aeAmount" type="number" step="0.01" min="0" placeholder="12.50" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm tabular-nums" />
        </div>
        <div>
          <label class="text-xs font-bold uppercase tracking-wider text-outline">Date</label>
          <input id="aeDate" type="date" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm" />
        </div>
      </div>
      <div>
        <label class="text-xs font-bold uppercase tracking-wider text-outline">Merchant</label>
        <input id="aeMerchant" type="text" placeholder="Café de Flore" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm" />
      </div>
      <div>
        <label class="text-xs font-bold uppercase tracking-wider text-outline">Category</label>
        <select id="aeCategory" class="mt-1 w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none text-sm">
          <option value="">Auto-detect from merchant</option>
        </select>
      </div>
      <label class="flex items-center gap-2 text-sm text-on-surface">
        <input id="aeIncome" type="checkbox" class="rounded" /> This is income (refund / inflow)
      </label>
      <p id="aeError" class="hidden text-[11px] text-error"></p>
    </div>
    <div class="px-5 py-3 border-t border-outline-variant/20 flex justify-end gap-2">
      <button id="aeCancel" class="px-4 py-2 rounded-lg text-sm font-medium text-on-surface hover:bg-surface-container">Cancel</button>
      <button id="aeSave"   class="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-on-primary hover:opacity-90">Save</button>
    </div>
  </div>
</div>

<!-- Audit modal -->
<div id="auditModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4">
  <div class="bg-surface-container-lowest w-full md:max-w-3xl md:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-hidden flex flex-col">
    <div class="px-5 py-4 border-b border-outline-variant/20">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-headline font-bold text-lg">Audit</div>
          <div class="text-xs text-outline" id="auditSub">—</div>
        </div>
        <button id="auditClose" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <!-- Totals strip -->
      <div class="grid grid-cols-3 gap-2 mt-3" id="auditTotals"></div>
    </div>
    <div class="flex-1 overflow-y-auto" id="auditBody"></div>
  </div>
</div>

<!-- Categorization audit modal — regex vs stored category drift -->
<div id="catAuditModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4">
  <div class="bg-surface-container-lowest w-full md:max-w-4xl md:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-hidden flex flex-col">
    <div class="px-5 py-4 border-b border-outline-variant/20">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-headline font-bold text-lg">🩺 Categorization audit</div>
          <div class="text-xs text-outline" id="catAuditSub">Compares parser regex rules vs stored category. Old txs imported before a rule existed show up here.</div>
        </div>
        <button id="catAuditClose" class="w-9 h-9 rounded-full hover:bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div id="catAuditSummary" class="mt-3 flex flex-wrap gap-1.5"></div>
    </div>
    <div class="flex-1 overflow-y-auto" id="catAuditBody"></div>
    <div class="px-5 py-3 border-t border-outline-variant/20 flex items-center justify-between gap-2">
      <span class="text-[11px] text-outline">Tip: review each row before applying. The regex isn't always right.</span>
      <div class="flex gap-2">
        <button id="catAuditClose2" class="px-3 py-2 rounded-lg text-sm font-medium text-outline hover:bg-surface-container">Close (do nothing)</button>
        <button id="catAuditApplyAll" class="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-on-primary hover:opacity-90">Apply selected</button>
      </div>
    </div>
  </div>
</div>

<!-- Match-keyword edit modal -->
<div id="kwModal" class="hidden fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
  <div class="bg-surface-container-lowest w-full max-w-md rounded-2xl overflow-hidden">
    <div class="px-5 py-4 border-b border-outline-variant/20">
      <div class="font-headline font-bold text-lg">Match keyword</div>
      <div class="text-xs text-outline mt-0.5" id="kwLabel">—</div>
    </div>
    <div class="p-5 space-y-3">
      <p class="text-sm text-on-surface">Case-insensitive regex on merchant or description. Only counts transactions that match. Empty = default behavior (proportional split).</p>
      <input id="kwInput" type="text" placeholder="e.g. navigo|ratp|sncf" class="w-full px-3 py-2 bg-surface-container rounded-lg border border-outline-variant/30 focus:ring-2 focus:ring-primary focus:outline-none font-mono text-sm" />
      <div class="text-[11px] text-outline">Applied to ALL periods where a line with the same label exists.</div>
    </div>
    <div class="px-5 py-3 border-t border-outline-variant/20 flex justify-end gap-2">
      <button id="kwCancel" class="px-4 py-2 rounded-lg text-sm font-medium text-on-surface hover:bg-surface-container">Cancelar</button>
      <button id="kwSave"   class="px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-on-primary hover:opacity-90">Guardar</button>
    </div>
  </div>
</div>


<script>
  const key = new URLSearchParams(location.search).get("key");
  const urlPeriod = new URLSearchParams(location.search).get("period");
  let initialPeriod = urlPeriod || ${initialPeriod};
  let donutChart, barChart;
  let currentData = null;
  let activeFilter = "fijos"; // 'fijos' | 'variables' | 'todos'
  let activeTab = (new URLSearchParams(location.search).get("tab")) || "resumen";
  let gastosSort = { key: "budget", dir: "desc" }; // header click cycles asc/desc

  // ─── Tab nav ────────────────────────────────────────────────────────────
  function switchTab(tab) {
    activeTab = tab;
    document.getElementById("viewResumen").classList.toggle("hidden",   tab !== "resumen");
    document.getElementById("viewHistorico").classList.toggle("hidden", tab !== "historico");
    document.getElementById("viewB2B").classList.toggle("hidden",       tab !== "b2b");
    document.querySelectorAll(".tabBtn").forEach((b) => {
      const isActive = b.id.endsWith(tab.charAt(0).toUpperCase() + tab.slice(1));
      b.className = "tabBtn px-3 py-1.5 rounded-full text-xs font-semibold transition-colors " +
        (isActive ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface hover:bg-surface-container-high");
    });
    const url = new URL(location.href);
    url.searchParams.set("tab", tab);
    history.replaceState(null, "", url);
    if (tab === "historico") loadHistorico();
    if (tab === "b2b") loadB2B();
  }
  // bind after DOM is parsed (this script is at end of body so OK)
  setTimeout(() => {
    document.getElementById("tabResumen").onclick   = () => switchTab("resumen");
    document.getElementById("tabHistorico").onclick = () => switchTab("historico");
    document.getElementById("tabB2b").onclick       = () => switchTab("b2b");
    if (activeTab === "historico") switchTab("historico");
    if (activeTab === "b2b")       switchTab("b2b");
  }, 0);

  // ─── B2B (Shine / negocio) tab loader ─────────────────────────────────────
  // Reads /api/ceiling.json (CA combinado del año, split por negocio, forecast,
  // progreso vs umbrales). Bars reuse the dial semantics: >90% error, >60% warn.
  async function loadB2B() {
    const elSplit = document.getElementById("b2bSplit");
    try {
      const r = await fetch("/api/ceiling.json?key=" + encodeURIComponent(key));
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      const eur = (n) => "€" + Number(n || 0).toLocaleString("fr-FR");
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

      set("b2bYear", d.year || "");
      set("b2bCA", eur(d.totalCA));
      set("b2bRunRate", eur(d.perDay));
      set("b2bProjected", eur(d.projected));
      set("b2bYearFraction", (d.fractionElapsed != null ? d.fractionElapsed + "%" : "—"));

      const th = {};
      (d.thresholds || []).forEach((t) => { th[t.key] = t; });
      const fillBar = (t, barId, pctId, crossId, labelId) => {
        if (!t) return;
        const bar = document.getElementById(barId);
        if (bar) {
          bar.style.width = Math.min(100, t.pct || 0) + "%";
          bar.className = "h-full rounded-full transition-all duration-700 " +
            ((t.pct || 0) >= 90 ? "bg-error" : (t.pct || 0) >= 60 ? "bg-warn" : "bg-primary");
        }
        set(pctId, (t.pct != null ? t.pct + "%" : "—"));
        set(crossId, t.crossDate ? ("cruce ~" + t.crossDate) : "sin cruce proyectado");
        set(labelId, eur(d.totalCA) + " / " + eur(t.amount));
      };
      fillBar(th.tva_franchise, "b2bTvaBar",   "b2bTvaPct",   "b2bTvaCross",   "b2bTvaLabel");
      fillBar(th.micro_ceiling, "b2bMicroBar", "b2bMicroPct", "b2bMicroCross", "b2bMicroLabel");

      const rows = (d.byBusiness || []).slice();
      if (d.unattributed) rows.push({ name: "Unclassified", ca: d.unattributed, pct_of_total: null });
      const html = rows.map((b) =>
        '<div class="flex items-center justify-between px-3 py-2 text-sm">' +
          '<span class="text-on-surface">' + b.name + '</span>' +
          '<span class="tabular-nums font-semibold">' + eur(b.ca) +
            (b.pct_of_total != null ? ' <span class="text-outline text-[11px] font-normal">' + b.pct_of_total + '%</span>' : '') +
          '</span>' +
        '</div>'
      ).join("");
      elSplit.innerHTML = html || '<div class="text-xs text-outline italic p-3">No business revenue yet. Connect Shine to start.</div>';
    } catch (err) {
      elSplit.innerHTML = '<div class="text-xs text-error p-3">Error: ' + (err.message || err) + '</div>';
    }
  }

  let histSearchTimer = null;
  let histAccounts = new Set(["bnp", "amex", "revolut"]); // default: all
  let histInitialized = false;
  let histSort = { key: "date", dir: "desc" };
  let histLastData = null;

  function ensureHistoricoInit() {
    // Always rebuild the year/month options. histInitialized only blocks the
    // account-chip + category-filter init below (one-shot). The selectors
    // themselves are idempotent — we rebuild every time so they never end up
    // empty (the "checkmark glitch" bug) when currentData wasn't ready.
    const now = new Date();
    const fallback = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2,"0")}\`;
    const periods = (currentData?.available_periods?.length
      ? currentData.available_periods
      : [currentData?.period, fallback].filter(Boolean));
    // Years from the data, PLUS the current year and 2 prior — so the quick
    // presets (and manual picks) that reach back across a year boundary always
    // have their year available in the dropdown.
    const ny = now.getFullYear();
    let years = [...new Set([
      ...periods.map((p) => p.slice(0, 4)),
      String(ny), String(ny - 1), String(ny - 2),
    ])].sort().reverse();
    const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const months = Array.from({ length: 12 }, (_, i) => ({ v: String(i+1).padStart(2,"0"), l: MONTH_LABELS[i] }));
    const yearOpts  = years.map((y)   => \`<option value="\${y}">\${y}</option>\`).join("");
    const monthOpts = months.map((m)  => \`<option value="\${m.v}">\${m.l}</option>\`).join("");
    ["histYearFrom","histYearTo"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const prev = el.value;
      el.innerHTML = yearOpts;
      if (prev && years.includes(prev)) el.value = prev;
    });
    ["histMonthFrom","histMonthTo"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const prev = el.value;
      el.innerHTML = monthOpts;
      if (prev) el.value = prev;
    });
    // First-time default: current month range
    if (!histInitialized) {
      const cur = currentData?.period || fallback;
      const [yy, mm] = cur.split("-");
      ["histYearFrom","histYearTo"].forEach((id) => { const el = document.getElementById(id); if (el && years.includes(yy)) el.value = yy; });
      ["histMonthFrom","histMonthTo"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = mm; });
    }
    // Account chips
    const filterEl = document.getElementById("histAccountFilter");
    const accountList = [
      { id: "bnp",     label: "BNP",     clr: "emerald" },
      { id: "amex",    label: "Amex",    clr: "blue"    },
      { id: "revolut", label: "Revolut", clr: "zinc"    },
    ];
    // Preserve the label span, then append chips
    filterEl.querySelectorAll(".acctChip").forEach((el) => el.remove());
    accountList.forEach((a) => {
      const b = document.createElement("button");
      b.className = "acctChip";
      b.dataset.acct = a.id;
      filterEl.appendChild(b);
      b.onclick = () => {
        if (histAccounts.has(a.id) && histAccounts.size === 1) {
          // clicking the only-active acct → re-enable all
          histAccounts = new Set(accountList.map((x) => x.id));
        } else if (histAccounts.has(a.id)) {
          histAccounts.delete(a.id);
        } else {
          histAccounts.add(a.id);
        }
        renderAcctChips();
        loadHistorico();
      };
    });
    function renderAcctChips() {
      filterEl.querySelectorAll(".acctChip").forEach((b) => {
        const id = b.dataset.acct;
        const active = histAccounts.has(id);
        b.textContent = accountList.find((x) => x.id === id).label;
        b.className = "acctChip px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors " +
          (active ? "bg-primary text-on-primary" : "bg-surface-container text-outline hover:bg-surface-container-high");
      });
    }
    renderAcctChips();

    // Populate category filter dropdown from CAT_GROUPS
    const catSel = document.getElementById("histCategoryFilter");
    if (catSel && catSel.options.length <= 1) {
      const groups = CAT_GROUPS.map((g) => {
        const opts = g.cats.map((c) => {
          const m = CAT_META[c] || { emoji: "", label: c };
          return \`<option value="\${c}">\${m.emoji}  \${m.label}</option>\`;
        }).join("");
        return \`<optgroup label="\${g.name}">\${opts}</optgroup>\`;
      }).join("");
      catSel.innerHTML = '<option value="">All</option>' + groups + '<option value="uncategorised">❓ Uncategorised</option>';
    }

    histInitialized = true;
  }

  // Set the From/To selects to an explicit YYYY-MM range and reload. Used by
  // the quick-preset chips (3m / 6m / 12m / YTD).
  function setHistRange(fromYM, toYM) {
    ensureHistoricoInit();
    const apply = (yId, mId, ym) => {
      const [y, m] = ym.split("-");
      const yEl = document.getElementById(yId);
      const mEl = document.getElementById(mId);
      if (yEl) {
        if (!Array.from(yEl.options).some((o) => o.value === y)) yEl.add(new Option(y, y));
        yEl.value = y;
      }
      if (mEl) mEl.value = m;
    };
    apply("histYearFrom", "histMonthFrom", fromYM);
    apply("histYearTo",   "histMonthTo",   toYM);
    loadHistorico();
  }

  async function loadHistorico() {
    ensureHistoricoInit();
    const yFrom = document.getElementById("histYearFrom")?.value  || "";
    const mFrom = document.getElementById("histMonthFrom")?.value || "";
    const yTo   = document.getElementById("histYearTo")?.value    || "";
    const mTo   = document.getElementById("histMonthTo")?.value   || "";
    let from = yFrom && mFrom ? \`\${yFrom}-\${mFrom}\` : "";
    let to   = yTo   && mTo   ? \`\${yTo}-\${mTo}\`     : "";
    // Auto-swap if user picks from > to
    if (from && to && from > to) { const t = from; from = to; to = t; }
    const search = document.getElementById("histSearch")?.value.trim() || "";
    const qs = new URLSearchParams({ key });
    if (from) qs.set("period_from", from);
    if (to)   qs.set("period_to",   to);
    if (search) qs.set("search", search);
    if (histAccounts.size && histAccounts.size < 3) qs.set("accounts", [...histAccounts].join(","));
    document.getElementById("historicoBody").innerHTML = \`<tr><td colspan="5" class="px-3 py-8 text-center text-outline italic">Loading…</td></tr>\`;
    const r = await fetch("/api/transactions.json?" + qs.toString());
    if (!r.ok) return;
    const d = await r.json();
    renderHistorico(d);
  }
  function renderHistorico(d) {
    histLastData = d;
    const tbody = document.getElementById("historicoBody");
    // Apply client-side filters
    const catFilter  = document.getElementById("histCategoryFilter")?.value || "";
    const typeFilter = document.getElementById("histTypeFilter")?.value || "all";
    const minAmount  = parseFloat(document.getElementById("histMinAmount")?.value || "0") || 0;
    let rows = (d.rows || []).filter((r) => {
      if (catFilter === "uncategorised") { if (r.category && r.category !== "uncategorised") return false; }
      else if (catFilter && r.category !== catFilter) return false;
      if (typeFilter === "out"      && r.amount >= 0) return false;
      if (typeFilter === "in"       && r.amount <= 0) return false;
      if (typeFilter === "external" && r.is_internal_transfer) return false;
      if (minAmount > 0 && Math.abs(r.amount) < minAmount) return false;
      return true;
    });
    // Sort
    const sortFn = {
      date:     (r) => r.date || "",
      account:  (r) => r.account || "",
      merchant: (r) => (r.merchant || "").toLowerCase(),
      amount:   (r) => r.amount,
      category: (r) => r.category || "zzz",
    }[histSort.key];
    rows.sort((a, b) => {
      const av = sortFn(a), bv = sortFn(b);
      if (av < bv) return histSort.dir === "asc" ? -1 : 1;
      if (av > bv) return histSort.dir === "asc" ?  1 : -1;
      return 0;
    });
    document.querySelectorAll(".histSortArrow").forEach((el) => {
      el.textContent = el.dataset.col === histSort.key ? (histSort.dir === "asc" ? "↑" : "↓") : "";
    });

    // Filtered stats
    const fOut = rows.filter((r) => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);
    const fIn  = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const statsEl = document.getElementById("histStats");
    if (statsEl) {
      const all = d.count || 0;
      const shown = rows.length;
      const filtered = shown !== all ? \` (of <strong>\${all}</strong> unfiltered)\` : "";
      statsEl.innerHTML = \`<strong class="text-on-surface">\${shown}</strong> transactions\${filtered} · <span class="text-error">€\${fmt(fOut)} out</span> · <span class="text-primary">€\${fmt(fIn)} in</span> · net <strong class="\${fIn - fOut >= 0 ? "text-primary" : "text-error"}">€\${fmt(fIn - fOut)}</strong>\`;
    }
    if (!rows.length) { tbody.innerHTML = \`<tr><td colspan="5" class="px-3 py-8 text-center text-outline italic">No transactions for filters</td></tr>\`; return; }

    const ACCT_CLR = { BNP: "bg-emerald-50 text-emerald-800", Amex: "bg-blue-50 text-blue-800", Revolut: "bg-zinc-100 text-zinc-800" };
    tbody.innerHTML = rows.map((tx) => {
      const amtClr = tx.amount < 0 ? "text-error" : "text-primary";
      const sign   = tx.amount < 0 ? "−" : "+";
      const intMark = tx.is_internal_transfer ? \` <span class="text-[9px] uppercase text-outline" title="Transferencia interna">int</span>\` : "";
      const acctClass = ACCT_CLR[tx.account] || "bg-surface-container text-on-surface";
      const desc = (tx.description && tx.description !== tx.merchant)
        ? \`<div class="text-[10px] text-outline truncate max-w-xs">\${escapeHtml(tx.description)}</div>\`
        : "";
      return \`<tr class="border-b border-outline-variant/15 last:border-0">
        <td class="px-2 sm:px-3 py-2 text-outline tabular-nums whitespace-nowrap text-[11px] sm:text-sm">\${tx.date || "—"}</td>
        <td class="hidden sm:table-cell px-2 sm:px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-semibold \${acctClass}">\${tx.account}</span></td>
        <td class="px-2 sm:px-3 py-2">
          <div class="font-medium text-on-surface text-xs sm:text-sm flex items-center gap-1.5 flex-wrap"><span class="sm:hidden px-1.5 py-0.5 rounded text-[9px] font-semibold \${acctClass}">\${tx.account}</span>\${escapeHtml(tx.merchant || "—")}\${intMark}</div>
          \${desc}
        </td>
        <td class="px-2 sm:px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap \${amtClr}">\${sign}\${fmt(Math.abs(tx.amount))}</td>
        <td class="px-2 sm:px-3 py-2">
          <select data-tx-id="\${tx.id}" class="histCatSel w-full bg-surface-container border-0 rounded text-xs px-2 py-1 focus:ring-2 focus:ring-primary focus:outline-none">
            \${categoryOptions(tx.category)}
          </select>
        </td>
      </tr>\`;
    }).join("");

    tbody.querySelectorAll(".histCatSel").forEach((sel) => {
      const orig = sel.value;
      sel.dataset.orig = orig;
      // Mark dirty on change — DON'T auto-save. User clicks "Save changes" button.
      sel.onchange = () => {
        const isDirty = sel.value !== sel.dataset.orig;
        sel.classList.toggle("ring-2", isDirty);
        sel.classList.toggle("ring-warn", isDirty);
        sel.dataset.dirty = isDirty ? "1" : "";
        refreshHistDirtyCounter();
      };
    });
    refreshHistDirtyCounter();
  }

  function refreshHistDirtyCounter() {
    const dirty = document.querySelectorAll(".histCatSel[data-dirty='1']").length;
    const btn = document.getElementById("histSaveBtn");
    if (!btn) return;
    btn.textContent = dirty > 0 ? \`💾 Save \${dirty} change\${dirty === 1 ? "" : "s"}\` : "✓ No unsaved changes";
    btn.disabled = dirty === 0;
    btn.className = "px-4 py-2 rounded-lg text-sm font-semibold " +
      (dirty > 0 ? "bg-primary text-on-primary hover:opacity-90" : "bg-surface-container text-outline cursor-not-allowed");
  }

  async function saveHistDirty() {
    const dirty = [...document.querySelectorAll(".histCatSel[data-dirty='1']")];
    if (!dirty.length) return;
    const btn = document.getElementById("histSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "💾 Saving…"; }
    let saved = 0; let failed = 0;
    for (const sel of dirty) {
      const txId = parseInt(sel.dataset.txId, 10);
      const newCat = sel.value;
      const ok = await changeCategory(txId, newCat);
      if (ok) {
        sel.dataset.orig = newCat;
        sel.dataset.dirty = "";
        sel.classList.remove("ring-warn");
        sel.classList.add("ring-primary");
        setTimeout(() => sel.classList.remove("ring-2", "ring-primary"), 800);
        if (histLastData?.rows) {
          const cached = histLastData.rows.find((r) => r.id === txId);
          if (cached) cached.category = newCat;
        }
        saved++;
      } else {
        failed++;
      }
    }
    refreshHistDirtyCounter();
    // Re-render so any filter (e.g. Category=Other) hides rows that no longer match
    if (histLastData) renderHistorico(histLastData);
    if (failed > 0) alert(\`Saved \${saved} · \${failed} failed\`);
  }
  window.saveHistDirty = saveHistDirty;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  setTimeout(() => {
    const PRESET_ON  = "bg-primary text-on-primary";
    const PRESET_OFF = "bg-surface-container text-outline hover:bg-surface-container-high";
    const clearPresetActive = () =>
      document.querySelectorAll(".histPreset").forEach((b) => { b.className = b.className.replace(PRESET_ON, PRESET_OFF); });
    ["histYearFrom","histMonthFrom","histYearTo","histMonthTo"].forEach((id) => {
      const el = document.getElementById(id);
      // Manual range edits clear any active preset highlight
      if (el) el.onchange = () => { clearPresetActive(); loadHistorico(); };
    });
    document.querySelectorAll(".histPreset").forEach((b) => {
      b.onclick = () => {
        const anchor = new Date(); anchor.setDate(1);
        const ym = (off) => { const d = new Date(anchor); d.setMonth(d.getMonth() - off); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
        const thisM = ym(0);
        const r = b.dataset.range;
        if      (r === "3m")  setHistRange(ym(2),  thisM);
        else if (r === "6m")  setHistRange(ym(5),  thisM);
        else if (r === "12m") setHistRange(ym(11), thisM);
        else if (r === "ytd") setHistRange(anchor.getFullYear() + "-01", thisM);
        clearPresetActive();
        b.className = b.className.replace(PRESET_OFF, PRESET_ON);
      };
    });
    const searchEl = document.getElementById("histSearch");
    if (searchEl) {
      searchEl.oninput = () => {
        clearTimeout(histSearchTimer);
        histSearchTimer = setTimeout(loadHistorico, 250);
      };
    }
    const histSaveBtn = document.getElementById("histSaveBtn");
    if (histSaveBtn) histSaveBtn.onclick = saveHistDirty;
    // Client-side filters (no re-fetch needed — work on cached histLastData)
    const reRender = () => { if (histLastData) renderHistorico(histLastData); };
    ["histCategoryFilter","histTypeFilter"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.onchange = reRender;
    });
    const minEl = document.getElementById("histMinAmount");
    if (minEl) {
      let mt; minEl.oninput = () => { clearTimeout(mt); mt = setTimeout(reRender, 200); };
    }
    // Sortable headers
    document.querySelectorAll("[data-histsort]").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.histsort;
        if (histSort.key === k) histSort.dir = histSort.dir === "asc" ? "desc" : "asc";
        else { histSort.key = k; histSort.dir = (k === "amount" || k === "date") ? "desc" : "asc"; }
        reRender();
      };
    });

    // ── Add-expense modal (manual quick capture) ──
    const aeModal = document.getElementById("addExpenseModal");
    if (aeModal) {
      const aeCatSel = document.getElementById("aeCategory");
      if (aeCatSel && aeCatSel.options.length <= 1) {
        aeCatSel.innerHTML = '<option value="">Auto-detect from merchant</option>' +
          CAT_GROUPS.map((g) => {
            const opts = g.cats.map((c) => {
              const meta = CAT_META[c] || { emoji: "", label: c };
              return \`<option value="\${c}">\${meta.emoji}  \${meta.label}</option>\`;
            }).join("");
            return \`<optgroup label="\${g.name}">\${opts}</optgroup>\`;
          }).join("");
      }
      const aeErr  = document.getElementById("aeError");
      const aeOpen = () => {
        document.getElementById("aeAmount").value   = "";
        document.getElementById("aeMerchant").value = "";
        document.getElementById("aeCategory").value = "";
        document.getElementById("aeIncome").checked = false;
        document.getElementById("aeDate").value     = new Date().toISOString().slice(0, 10);
        aeErr.classList.add("hidden");
        aeModal.classList.remove("hidden");
        setTimeout(() => document.getElementById("aeAmount").focus(), 50);
      };
      const aeClose = () => aeModal.classList.add("hidden");
      const aeSaveFn = async () => {
        const amount = parseFloat(document.getElementById("aeAmount").value);
        if (!amount || amount <= 0) { aeErr.textContent = "Enter a valid amount"; aeErr.classList.remove("hidden"); return; }
        const body = {
          amount_eur: amount,
          merchant:   document.getElementById("aeMerchant").value.trim(),
          category:   document.getElementById("aeCategory").value || undefined,
          date:       document.getElementById("aeDate").value || undefined,
          is_income:  document.getElementById("aeIncome").checked,
        };
        const btn = document.getElementById("aeSave");
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          const r = await fetch("/api/transactions/add?key=" + encodeURIComponent(key), {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          });
          const d = await r.json();
          if (!r.ok || d.error) throw new Error(d.error || "Error " + r.status);
          aeClose();
          await load(currentData?.period);
        } catch (err) {
          aeErr.textContent = err.message; aeErr.classList.remove("hidden");
        } finally {
          btn.disabled = false; btn.textContent = "Save";
        }
      };
      document.getElementById("addExpenseBtn").onclick   = aeOpen;
      document.getElementById("addExpenseClose").onclick = aeClose;
      document.getElementById("aeCancel").onclick        = aeClose;
      document.getElementById("aeSave").onclick          = aeSaveFn;
      aeModal.onclick = (e) => { if (e.target === aeModal) aeClose(); };
      document.getElementById("aeAmount").onkeydown = (e) => { if (e.key === "Enter") aeSaveFn(); };
    }
  }, 100);

  const CIRCUM = 282.7;

  const MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const MONTH_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const ICON = {
    housing: "home", groceries: "shopping_cart", restaurants: "restaurant",
    transport: "commute", travel: "flight", subscriptions: "autorenew",
    shopping: "shopping_bag", health: "medical_services", entertainment: "theaters",
    transfers: "send", internal_transfer: "sync_alt",
    savings: "savings", debt: "account_balance_wallet", income: "trending_up", fees: "percent",
    other: "category", uncategorised: "help",
  };
  const CATEGORIES = ["groceries","restaurants","transport","travel","subscriptions","shopping","health","housing","entertainment","transfers","internal_transfer","savings","debt","income","fees","other"];

  // Emoji prefix + Spanish label for each category, so the dropdown is
  // scannable by glance instead of a bare list of English nouns.
  const CAT_META = {
    groceries:         { emoji: "🛒", label: "Groceries" },
    restaurants:       { emoji: "🍽️", label: "Restaurants" },
    transport:         { emoji: "🚇", label: "Transport" },
    travel:            { emoji: "✈️", label: "Travel" },
    subscriptions:     { emoji: "🔁", label: "Subscriptions" },
    shopping:          { emoji: "🛍️", label: "Shopping" },
    health:            { emoji: "💊", label: "Health" },
    housing:           { emoji: "🏠", label: "Housing" },
    entertainment:     { emoji: "🎬", label: "Entertainment" },
    transfers:         { emoji: "📤", label: "Transfers (terceros)" },
    internal_transfer: { emoji: "🔄", label: "Internal (BNP↔hijas)" },
    savings:           { emoji: "💰", label: "Savings" },
    debt:              { emoji: "💳", label: "Debt" },
    income:            { emoji: "📈", label: "Income" },
    fees:              { emoji: "💸", label: "Fees" },
    other:             { emoji: "❓", label: "Other" },
    uncategorised:     { emoji: "❓", label: "Uncategorised" },
  };

  // Logical groups for the dropdown. Within each group: alphabetical.
  const CAT_GROUPS = [
    { name: "Daily spending", cats: ["entertainment", "groceries", "health", "housing", "restaurants", "shopping", "subscriptions", "transport", "travel"] },
    { name: "Real movements", cats: ["debt", "fees", "income", "savings", "transfers"] },
    { name: "Internal (not real spend)", cats: ["internal_transfer"] },
    { name: "Misc",              cats: ["other"] },
  ];

  function categoryOptions(selected) {
    return CAT_GROUPS.map((g) => {
      const opts = g.cats.map((c) => {
        const m = CAT_META[c] || { emoji: "", label: c };
        return \`<option value="\${c}" \${c === selected ? "selected" : ""}>\${m.emoji}  \${m.label}</option>\`;
      }).join("");
      return \`<optgroup label="\${g.name}">\${opts}</optgroup>\`;
    }).join("");
  }

  async function changeCategory(txId, newCat) {
    const r = await fetch("/api/transactions/category?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [txId], category: newCat }),
    });
    return r.ok;
  }
  window.changeCategory = changeCategory;

  const fmt = (n) => n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n) => n == null ? "—" : (Math.round(n * 10) / 10) + "%";

  async function load(period) {
    const url = "/api/dashboard.json?key=" + encodeURIComponent(key) + (period ? "&period=" + period : "");
    const r = await fetch(url);
    if (!r.ok) { document.body.innerHTML = "<p class='p-8 text-error'>Error " + r.status + "</p>"; return; }
    currentData = await r.json();
    render(currentData);
    // Fire-and-forget the YTD load using the period's year
    const year = (period || currentData.period).slice(0, 4);
    loadYear(year);
    // Fire-and-forget audit summary for the button badge
    // New categorization audit (regex vs stored category drift detector)
    loadCatAuditBadge();
    // BNP cashflow panel
    loadBnpCashflow(currentData.period);
    // Pending items panel
    loadPending();
    // If the user is already on the Histórico tab, refresh its selectors with
    // the now-loaded available_periods (fixes the "empty dropdown checkmark" bug
    // when the page is opened directly with ?tab=historico).
    if (activeTab === "historico") loadHistorico();
  }

  // Brand-style account marks: small SVG/text-logo wordmark in the brand color
  // instead of a generic Material icon, so the cashflow cards feel branded.
  const ACCOUNT_META = {
    bnp: {
      label: "BNP Paribas",
      brandHtml: \`<div class="w-7 h-7 rounded-md bg-[#00915a] flex items-center justify-center text-white text-[10px] font-headline font-extrabold tracking-tight">BNP</div>\`,
    },
    amex: {
      label: "American Express",
      brandHtml: \`<div class="w-7 h-7 rounded-md bg-[#006fcf] flex items-center justify-center text-white text-[8px] font-headline font-extrabold tracking-tight">AMEX</div>\`,
    },
    revolut: {
      label: "Revolut",
      brandHtml: \`<div class="w-7 h-7 rounded-md bg-black flex items-center justify-center text-white text-[14px] font-headline font-extrabold leading-none">R</div>\`,
    },
  };

  async function loadBnpCashflow(period) {
    document.getElementById("bnpPeriodLabel").textContent = period;
    const grid = document.getElementById("accountsGrid");
    grid.innerHTML = ["bnp", "amex", "revolut", "total"].map((a) =>
      \`<div class="rounded-2xl bg-surface-container-lowest border border-outline-variant/15 p-4" id="acct-\${a}">
        <div class="text-xs text-outline">Loading \${a === "total" ? "Total" : ACCOUNT_META[a].label}…</div>
       </div>\`
    ).join("");

    const totals = { credits: 0, debits: 0, internalCredits: 0, internalDebits: 0, net: 0, tx: 0 };
    for (const acct of ["bnp", "amex", "revolut"]) {
      const r = await fetch("/api/cashflow.json?key=" + encodeURIComponent(key) + "&account=" + acct + "&period=" + period);
      if (!r.ok) continue;
      const d = await r.json();
      const meta = ACCOUNT_META[acct];
      const opening = d.opening_eur, closing = d.closing_eur;
      const netClr  = d.net_change_eur >= 0 ? "text-primary" : "text-error";
      const editBtn = acct === "bnp" ? \`<button id="bnpEditBtn" onclick="event.stopPropagation()" class="text-[10px] text-primary font-semibold hover:underline">Edit</button>\` : "";
      totals.credits         += d.credits_eur;
      totals.debits          += d.debits_eur;
      totals.internalCredits += d.internal_credits_eur || 0;
      totals.internalDebits  += d.internal_debits_eur  || 0;
      totals.net             += d.net_change_eur;
      totals.tx              += d.tx_count;
      // Internal-transfer breakdown — shows BNP↔hijas flows so the
      // mother/child hierarchy is visible. BNP shows "Movido a hijas",
      // Amex/Revolut show "Recibido de BNP".
      const intIn  = d.internal_credits_eur || 0;
      const intOut = d.internal_debits_eur  || 0;
      let intLine = "";
      if (acct === "bnp" && intOut > 0) {
        intLine = \`<div class="mt-2 text-[10px] flex items-center justify-between rounded-lg bg-amber-50 text-amber-900 px-2 py-1.5">
          <span class="font-semibold">↦ Moved to children</span>
          <span class="tabular-nums font-bold">€\${fmt(intOut).replace("€","")}</span>
        </div>\`;
      } else if (acct !== "bnp" && intIn > 0) {
        intLine = \`<div class="mt-2 text-[10px] flex items-center justify-between rounded-lg bg-emerald-50 text-emerald-900 px-2 py-1.5">
          <span class="font-semibold">↤ Received from BNP</span>
          <span class="tabular-nums font-bold">€\${fmt(intIn).replace("€","")}</span>
        </div>\`;
      }
      document.getElementById("acct-" + acct).innerHTML = \`
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            \${meta.brandHtml}
            <h4 class="font-headline font-bold text-sm">\${meta.label}</h4>
          </div>
          \${editBtn}
        </div>
        <div class="grid grid-cols-2 gap-2 text-center">
          <div class="bg-surface-container rounded-lg p-2">
            <div class="text-[9px] uppercase tracking-wider text-outline">Opening</div>
            <div class="font-headline text-base font-bold tabular-nums">\${opening != null ? fmt(opening) : "—"}</div>
          </div>
          <div class="bg-surface-container rounded-lg p-2">
            <div class="text-[9px] uppercase tracking-wider text-outline">Closing</div>
            <div class="font-headline text-base font-bold tabular-nums">\${closing != null ? fmt(closing) : "—"}</div>
          </div>
          <div class="bg-primary-container/30 rounded-lg p-2">
            <div class="text-[9px] uppercase tracking-wider text-outline">+ In</div>
            <div class="font-headline text-base font-bold tabular-nums text-primary">\${fmt(d.credits_eur)}</div>
            <div class="text-[9px] text-outline">\${d.tx_count} tx</div>
          </div>
          <div class="bg-error-container/30 rounded-lg p-2">
            <div class="text-[9px] uppercase tracking-wider text-outline">− Out</div>
            <div class="font-headline text-base font-bold tabular-nums text-error">\${fmt(d.debits_eur)}</div>
            <div class="text-[9px] \${netClr}">net \${d.net_change_eur >= 0 ? "+" : ""}\${fmt(d.net_change_eur)}</div>
          </div>
        </div>
        \${intLine}\`;
    }

    // "Real cashflow" card — excludes internal transfers (BNP↔hijas).
    // Sumar credits/debits crudos a través de cuentas infla ambos lados con
    // los flows internos (prélèvement Amex, top-up Revolut). Lo útil es el
    // cashflow real: salary entrante + gasto real saliente.
    const realIn  = Math.round((totals.credits - totals.internalCredits) * 100) / 100;
    const realOut = Math.round((totals.debits  - totals.internalDebits)  * 100) / 100;
    const realNet = Math.round((realIn - realOut) * 100) / 100;
    const internalMoved = Math.round(totals.internalDebits * 100) / 100;
    const totalEl = document.getElementById("acct-total");
    totalEl.className = "rounded-2xl bg-on-surface text-white p-4 border border-on-surface";
    totalEl.innerHTML = \`
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-md bg-white/15 flex items-center justify-center">
            <span class="material-symbols-outlined" style="font-size:16px">payments</span>
          </div>
          <h4 class="font-headline font-bold text-sm" title="Real cashflow = excludes internal BNP↔children transfers">Real cashflow</h4>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-center">
        <div class="bg-white/10 rounded-lg p-2" title="Real income — salary + reimbursements + third-party income (excludes top-ups and BNP→Amex payments)">
          <div class="text-[9px] uppercase tracking-wider opacity-60">Real In</div>
          <div class="font-headline text-base font-bold tabular-nums">\${fmt(realIn)}</div>
        </div>
        <div class="bg-white/10 rounded-lg p-2" title="Real spending — all purchases (excludes prélèvements and top-ups)">
          <div class="text-[9px] uppercase tracking-wider opacity-60">Real Out</div>
          <div class="font-headline text-base font-bold tabular-nums">\${fmt(realOut)}</div>
        </div>
      </div>
      <div class="mt-2 bg-white/15 rounded-lg p-2.5 text-center">
        <div class="text-[9px] uppercase tracking-wider opacity-60">Net real</div>
        <div class="font-headline text-xl font-bold tabular-nums \${realNet >= 0 ? "" : "text-red-300"}">\${fmt(realNet)}</div>
      </div>
      <div class="mt-2 text-[10px] text-center opacity-50">
        \${internalMoved > 0 ? "↺ " + fmt(internalMoved) + " moved internally" : "no internal moves"}
      </div>\`;

    // Re-bind the edit button for BNP since it was just rendered
    const bnpBtn = document.getElementById("bnpEditBtn");
    if (bnpBtn) bnpBtn.onclick = openBnpBalanceEditor;

    // Internal-flows panel: render BNP→hijas amounts using internal_debits
    // from BNP (what BNP sent) + internal_credits from each child (what they
    // received). They should match — if they don't, the delta is shown as
    // "pendiente" (e.g. BNP statement not loaded yet for the period).
    try {
      const bnp = await (await fetch("/api/cashflow.json?key=" + encodeURIComponent(key) + "&account=bnp&period="     + period)).json();
      const amx = await (await fetch("/api/cashflow.json?key=" + encodeURIComponent(key) + "&account=amex&period="    + period)).json();
      const rvl = await (await fetch("/api/cashflow.json?key=" + encodeURIComponent(key) + "&account=revolut&period=" + period)).json();
      const bnpOut    = bnp.internal_debits_eur  || 0;
      const amexIn    = amx.internal_credits_eur || 0;
      const revolutIn = rvl.internal_credits_eur || 0;
      const totalIn   = amexIn + revolutIn;
      const panel = document.getElementById("internalFlowsPanel");
      const body  = document.getElementById("internalFlowsBody");
      if (bnpOut === 0 && totalIn === 0) {
        panel.classList.add("hidden");
      } else {
        panel.classList.remove("hidden");
        const cell = (from, to, amt, note) => \`
          <div class="rounded-lg bg-surface-container px-3 py-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">\${from}</span>
              <span class="material-symbols-outlined text-outline" style="font-size:14px">arrow_forward</span>
              <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800">\${to}</span>
            </div>
            <div class="text-right">
              <div class="font-headline font-bold tabular-nums text-on-surface">€\${fmt(amt).replace("€","")}</div>
              \${note ? \`<div class="text-[9px] text-outline">\${note}</div>\` : ""}
            </div>
          </div>\`;
        const delta = Math.round((totalIn - bnpOut) * 100) / 100;
        body.innerHTML = [
          cell("BNP", "Amex",    amexIn,    "prélèvement"),
          cell("BNP", "Revolut", revolutIn, "top-up"),
          cell("BNP", "Total",   bnpOut,    Math.abs(delta) > 0.5 ? \`vs €\${fmt(totalIn).replace("€","")} recibido (Δ €\${fmt(delta).replace("€","")})\` : "match ✓"),
        ].join("");
      }
    } catch (e) { /* silent — panel just stays hidden */ }
  }

  let openBnpBalanceEditor = () => {};   // populated below

  // ─── Pending items (receivables, payables, reimbursements) ──────────────
  let pendingData = null;
  async function loadPending() {
    const includeSettled = document.getElementById("pendingShowSettled")?.checked ? "1" : "0";
    const r = await fetch("/api/pending.json?key=" + encodeURIComponent(key) + "&include_settled=" + includeSettled);
    if (!r.ok) return;
    pendingData = await r.json();
    renderPending(pendingData);
  }
  const KIND_META = {
    receivable:    { emoji: "💰", label: "Owed to me",    chipClr: "bg-emerald-100 text-emerald-800" },
    payable:       { emoji: "📤", label: "I owe",         chipClr: "bg-red-100 text-red-800" },
    reimbursement: { emoji: "🔁", label: "Reimbursement", chipClr: "bg-blue-100 text-blue-800" },
  };
  function renderPending(d) {
    const t = d.totals;
    document.getElementById("pendingTotals").innerHTML = [
      \`<div class="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider text-emerald-700 font-bold">💰 Owed to me</div>
        <div class="font-headline text-lg font-bold text-emerald-900 tabular-nums">€\${fmt(t.receivable).replace("€","")}</div>
      </div>\`,
      \`<div class="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider text-red-700 font-bold">📤 I owe</div>
        <div class="font-headline text-lg font-bold text-red-900 tabular-nums">€\${fmt(t.payable).replace("€","")}</div>
      </div>\`,
      \`<div class="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider text-blue-700 font-bold">🔁 Reimbursements</div>
        <div class="font-headline text-lg font-bold text-blue-900 tabular-nums">€\${fmt(t.reimbursement).replace("€","")}</div>
      </div>\`,
      \`<div class="rounded-lg bg-on-surface text-white px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider opacity-60 font-bold">Net pending</div>
        <div class="font-headline text-lg font-bold tabular-nums \${t.net >= 0 ? "" : "text-red-300"}">\${fmt(t.net)}</div>
      </div>\`,
    ].join("");

    const list = document.getElementById("pendingList");
    if (!d.rows.length) {
      list.innerHTML = \`<div class="text-xs text-outline italic p-4 text-center">No pending items. Click "+ Add item" to log a receivable, payable, or reimbursement.</div>\`;
      return;
    }
    list.innerHTML = d.rows.map((r) => {
      const meta = KIND_META[r.kind] || { emoji: "?", label: r.kind, chipClr: "bg-surface-container text-outline" };
      const settled = r.status === "settled";
      const settledMark = settled ? \`<span class="text-[9px] uppercase tracking-wider text-primary font-bold">SETTLED</span>\` : "";
      return \`<div class="flex items-center gap-2 px-3 py-2 rounded-lg \${settled ? "bg-surface-container-low opacity-60" : "bg-surface-container-low hover:bg-surface-container"}">
        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold \${meta.chipClr} flex-shrink-0">\${meta.emoji} \${meta.label}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-on-surface truncate">\${escapeHtml(r.who)} \${settledMark}</div>
          \${r.description ? \`<div class="text-[11px] text-outline truncate">\${escapeHtml(r.description)}\${r.expected_date ? " · expects " + escapeHtml(r.expected_date) : ""}</div>\` : (r.expected_date ? \`<div class="text-[11px] text-outline">expects \${escapeHtml(r.expected_date)}</div>\` : "")}
        </div>
        <div class="font-headline font-bold tabular-nums text-on-surface \${r.kind === "payable" ? "text-error" : ""}">€\${fmt(r.amount_eur).replace("€","")}</div>
        \${settled ? "" : \`<button class="pendingSettle text-[10px] px-2 py-1 rounded bg-primary-container text-on-primary-container hover:opacity-90" data-id="\${r.id}" title="Mark settled">✓</button>\`}
        <button class="pendingDelete text-[10px] px-1.5 py-1 rounded text-outline hover:text-error hover:bg-error-container" data-id="\${r.id}" title="Delete">🗑</button>
      </div>\`;
    }).join("");

    list.querySelectorAll(".pendingSettle").forEach((b) => {
      b.onclick = async () => {
        const id = parseInt(b.dataset.id, 10);
        const row = b.closest("[class*='rounded-lg']");
        const who = row?.querySelector(".text-on-surface")?.textContent?.trim() || "this item";
        if (!confirm('Mark "' + who + '" as settled?')) return;
        await fetch("/api/pending?key=" + encodeURIComponent(key), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "settle", payload: { id } }),
        });
        await loadPending();
      };
    });
    list.querySelectorAll(".pendingDelete").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Delete this pending item?")) return;
        const id = parseInt(b.dataset.id, 10);
        await fetch("/api/pending?key=" + encodeURIComponent(key), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "delete", payload: { id } }),
        });
        await loadPending();
      };
    });
  }
  // Wire add form (idempotent)
  setTimeout(() => {
    const addBtn  = document.getElementById("pendingAddBtn");
    const form    = document.getElementById("pendingAddForm");
    const saveBtn = document.getElementById("pfSave");
    const cancel  = document.getElementById("pfCancel");
    const settled = document.getElementById("pendingShowSettled");
    if (addBtn) addBtn.onclick = () => {
      form.classList.toggle("hidden");
      if (!form.classList.contains("hidden")) document.getElementById("pfWho").focus();
    };
    if (cancel) cancel.onclick = () => { form.classList.add("hidden"); };
    if (saveBtn) saveBtn.onclick = async () => {
      const kind     = document.getElementById("pfKind").value;
      const who      = document.getElementById("pfWho").value.trim();
      const amount   = parseFloat(document.getElementById("pfAmount").value);
      const desc     = document.getElementById("pfDesc").value.trim();
      const expected = document.getElementById("pfExpected").value.trim();
      if (!who || !Number.isFinite(amount) || amount <= 0) {
        alert("Need who + a positive amount"); return;
      }
      const r = await fetch("/api/pending?key=" + encodeURIComponent(key), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: {
          kind, who, amount_eur: amount,
          description: desc || null, expected_date: expected || null,
        }}),
      });
      if (!r.ok) { alert("Save failed: " + r.status); return; }
      ["pfWho","pfAmount","pfDesc","pfExpected"].forEach((id) => document.getElementById(id).value = "");
      form.classList.add("hidden");
      await loadPending();
    };
    if (settled) settled.onchange = loadPending;
  }, 100);
  window.loadPending = loadPending;

  // ─── Categorization audit ───────────────────────────────────────────────
  // Dismissed tx ids are stored in localStorage so they don't keep showing up
  // every time the dashboard reloads. Persistent within this browser.
  const DISMISS_KEY = "catAuditDismissed";
  function getDismissedIds() {
    try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function addDismissedId(id) {
    const s = getDismissedIds(); s.add(id);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...s]));
  }
  function clearDismissed() { localStorage.removeItem(DISMISS_KEY); }
  window.clearAuditDismissed = clearDismissed;  // exposed for debugging

  let catAuditData = null;
  async function loadCatAuditBadge() {
    const r = await fetch("/api/categorization-audit.json?key=" + encodeURIComponent(key));
    if (!r.ok) return;
    const raw = await r.json();
    const dismissed = getDismissedIds();
    // Filter out previously-dismissed mismatches
    catAuditData = {
      ...raw,
      mismatches: raw.mismatches.filter((m) => !dismissed.has(m.id)),
      dismissed_count: raw.mismatches.filter((m) => dismissed.has(m.id)).length,
    };
    // Rebuild by_change to reflect filtered list
    catAuditData.by_change = {};
    for (const m of catAuditData.mismatches) {
      const k = m.current + "→" + m.suggested;
      catAuditData.by_change[k] = (catAuditData.by_change[k] || 0) + 1;
    }
    const btn = document.getElementById("catAuditBtn");
    const cnt = document.getElementById("catAuditCount");
    if (catAuditData.mismatches.length > 0) {
      btn.classList.remove("hidden");
      cnt.textContent = catAuditData.mismatches.length;
    } else {
      btn.classList.add("hidden");
    }
  }
  function openCatAudit() {
    if (!catAuditData) return;
    document.getElementById("catAuditModal").classList.remove("hidden");
    const d = catAuditData;
    document.getElementById("catAuditSub").innerHTML =
      \`<strong>\${d.mismatches.length}</strong> transactions where the parser regex suggests a different category. Scanned \${d.scanned} rows. <br/>
       <span class="text-on-surface">👉 Check the rows you AGREE with, then click "Apply selected". Click <em>Dismiss</em> per row to ignore a wrong suggestion. Rows are unchecked by default.</span>\`;
    document.getElementById("catAuditSummary").innerHTML = Object.entries(d.by_change)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => \`<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-surface-container text-on-surface">\${k} · <b>\${n}</b></span>\`).join("");
    const body = document.getElementById("catAuditBody");
    body.innerHTML = \`<table class="w-full text-sm">
      <thead class="sticky top-0 bg-surface-container z-10">
        <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
          <th class="px-3 py-2.5 w-10" title="Select to include in 'Apply selected'"><input type="checkbox" id="catAuditSelectAll" title="Select all" /></th>
          <th class="px-3 py-2.5 w-20">Account</th>
          <th class="px-3 py-2.5 w-24">Date</th>
          <th class="px-3 py-2.5">Merchant</th>
          <th class="px-3 py-2.5 text-right w-20">€</th>
          <th class="px-3 py-2.5 w-28">Current</th>
          <th class="px-3 py-2.5 w-28">Suggested</th>
          <th class="px-3 py-2.5 w-32 text-center">Actions</th>
        </tr>
      </thead>
      <tbody>
        \${d.mismatches.map((m) => {
          const curMeta = CAT_META[m.current]   || { emoji: "", label: m.current };
          const sugMeta = CAT_META[m.suggested] || { emoji: "", label: m.suggested };
          return \`<tr class="border-b border-outline-variant/15" data-row-id="\${m.id}">
            <td class="px-3 py-2"><input type="checkbox" class="catAuditCheck" data-id="\${m.id}" data-suggested="\${m.suggested}" /></td>
            <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-container">\${m.account}</span></td>
            <td class="px-3 py-2 text-outline tabular-nums whitespace-nowrap">\${m.date || "—"}</td>
            <td class="px-3 py-2 text-on-surface truncate max-w-xs" title="\${escapeHtml(m.description || m.merchant || "")}">\${escapeHtml(m.merchant || "—")}</td>
            <td class="px-3 py-2 text-right tabular-nums \${m.amount < 0 ? "text-error" : "text-primary"}">\${m.amount < 0 ? "−" : "+"}\${fmt(Math.abs(m.amount)).replace("€","")}</td>
            <td class="px-3 py-2 text-[11px]"><span class="px-1.5 py-0.5 rounded bg-surface-container">\${curMeta.emoji} \${curMeta.label}</span></td>
            <td class="px-3 py-2 text-[11px]"><span class="px-1.5 py-0.5 rounded bg-primary-container text-on-primary-container">\${sugMeta.emoji} \${sugMeta.label}</span></td>
            <td class="px-3 py-2 flex items-center justify-center gap-1">
              <button class="catAuditOne text-[10px] px-2 py-1 rounded bg-primary text-on-primary hover:opacity-90" data-id="\${m.id}" data-suggested="\${m.suggested}" title="Apply this suggestion">✓ Apply</button>
              <button class="catAuditDismiss text-[10px] px-2 py-1 rounded bg-surface-container text-outline hover:bg-surface-container-high" data-id="\${m.id}" title="Ignore this suggestion (hide from list)">✗ Dismiss</button>
            </td>
          </tr>\`;
        }).join("")}
      </tbody>
    </table>\`;
    document.getElementById("catAuditSelectAll").onchange = (e) => {
      body.querySelectorAll(".catAuditCheck").forEach((c) => { if (!c.closest("tr").classList.contains("opacity-40")) c.checked = e.target.checked; });
    };
    body.querySelectorAll(".catAuditOne").forEach((b) => {
      b.onclick = async () => {
        const id = parseInt(b.dataset.id, 10);
        const cat = b.dataset.suggested;
        b.disabled = true;
        b.textContent = "Applying…";
        const r = await fetch("/api/categorization-audit/apply?key=" + encodeURIComponent(key), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ id, category: cat }] }),
        });
        if (!r.ok) {
          b.disabled = false;
          b.textContent = "✓ Apply";
          alert("Apply failed (" + r.status + ")");
          return;
        }
        // Mirror Dismiss flow: remove row, update header + badge, empty-state on last
        const row = b.closest("tr");
        row.remove();
        const remaining = body.querySelectorAll("tbody tr").length;
        document.getElementById("catAuditSub").innerHTML =
          \`<strong>\${remaining}</strong> remaining\`;
        document.getElementById("catAuditCount").textContent = remaining;
        if (remaining === 0) {
          body.innerHTML = \`<div class="p-8 text-center text-outline italic">All clear — no more suggestions.</div>\`;
        }
      };
    });
    body.querySelectorAll(".catAuditDismiss").forEach((b) => {
      b.onclick = () => {
        const id = parseInt(b.dataset.id, 10);
        addDismissedId(id);  // persist so it doesn't come back on reload
        const row = b.closest("tr");
        row.remove();
        // Update remaining count in header + badge
        const remaining = body.querySelectorAll("tbody tr").length;
        document.getElementById("catAuditSub").innerHTML =
          \`<strong>\${remaining}</strong> remaining (1 dismissed this session). Dismissed rows won't reappear on reload.\`;
        document.getElementById("catAuditCount").textContent = remaining;
        if (remaining === 0) {
          body.innerHTML = \`<div class="p-8 text-center text-outline italic">All clear — no more suggestions.</div>\`;
        }
      };
    });
  }
  window.openCatAudit = openCatAudit;
  const closeCatAudit = () => document.getElementById("catAuditModal").classList.add("hidden");
  document.getElementById("catAuditClose").onclick  = closeCatAudit;
  document.getElementById("catAuditClose2").onclick = closeCatAudit;
  document.getElementById("catAuditApplyAll").onclick = async () => {
    const checkedBoxes = [...document.querySelectorAll(".catAuditCheck")]
      .filter((c) => c.checked && !c.disabled);
    if (!checkedBoxes.length) { alert("No rows selected. Check the boxes next to the suggestions you agree with."); return; }
    if (!confirm(\`Apply \${checkedBoxes.length} category change\${checkedBoxes.length === 1 ? "" : "s"}?\`)) return;
    const items = checkedBoxes.map((c) => ({ id: parseInt(c.dataset.id, 10), category: c.dataset.suggested }));
    const btn = document.getElementById("catAuditApplyAll");
    btn.disabled = true;
    btn.textContent = "💾 Applying…";
    const r = await fetch("/api/categorization-audit/apply?key=" + encodeURIComponent(key), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const j = await r.json().catch(() => ({}));
    btn.disabled = false;
    btn.textContent = "Apply selected";
    if (!r.ok) { alert("Failed: " + (j.error || r.status)); return; }
    // Remove applied rows in place — user keeps working in modal
    const body = document.getElementById("catAuditBody");
    for (const c of checkedBoxes) {
      const row = c.closest("tr");
      if (row) row.remove();
    }
    const remaining = body.querySelectorAll("tbody tr").length;
    document.getElementById("catAuditSub").innerHTML =
      \`<strong>\${remaining}</strong> remaining · ✓ Applied \${j.updated}\`;
    document.getElementById("catAuditCount").textContent = remaining;
    if (remaining === 0) {
      body.innerHTML = \`<div class="p-8 text-center text-outline italic">All clear — no more suggestions. <button onclick="document.getElementById('catAuditModal').classList.add('hidden')" class="ml-2 underline text-primary">Close</button></div>\`;
    }
    // Refresh background dashboard so totals reflect the changes
    load(currentData.period);
  };

  let auditData = null;
  async function loadAuditBadge(period) {
    const r = await fetch("/api/audit.json?key=" + encodeURIComponent(key) + "&period=" + period);
    if (!r.ok) return;
    auditData = await r.json();
    const btn = document.getElementById("auditBtn");
    const cnt = document.getElementById("auditCount");
    if (auditData.totals.orphan_count > 0) {
      btn.classList.remove("hidden");
      cnt.textContent = auditData.totals.orphan_count + " · " + fmt(auditData.totals.total_orphan);
    } else {
      btn.classList.add("hidden");
    }
  }

  async function loadYear(year) {
    const r = await fetch("/api/year.json?key=" + encodeURIComponent(key) + "&year=" + year);
    if (!r.ok) return;
    renderYTD(await r.json());
  }

  function renderYTD(y) {
    document.getElementById("ytdYearLabel").textContent = y.year;
    document.getElementById("ytdMonthsLabel").textContent = y.months_with_data + " " + (y.months_with_data === 1 ? "month" : "months") + " with data · " + y.tx_count + " tx";
    const t = y.totals;
    const net = t.net_actual_eur;
    const netCls = net >= 0 ? "text-primary" : "text-error";
    document.getElementById("ytdCards").innerHTML = [
      \`<div class="bg-surface-container-lowest p-3 cursor-pointer hover:bg-surface-container transition-colors" onclick="openCategoryDrill('income', '\${y.year}')"><div class="text-[10px] font-bold uppercase tracking-wider text-outline">Income YTD</div><div class="font-headline text-lg font-bold tabular-nums mt-0.5 text-on-surface">\${fmt(t.income_actual_eur)}</div><div class="text-[9px] text-primary mt-0.5">click → detail</div></div>\`,
      \`<div class="bg-surface-container-lowest p-3 cursor-pointer hover:bg-surface-container transition-colors" onclick="openYTDBreakdown(\${JSON.stringify(y).replace(/"/g, '&quot;')})"><div class="text-[10px] font-bold uppercase tracking-wider text-outline">Spend YTD</div><div class="font-headline text-lg font-bold tabular-nums mt-0.5 text-on-surface">\${fmt(t.expenses_actual_eur)}</div><div class="text-[9px] text-primary mt-0.5">click → breakdown</div></div>\`,
      \`<div class="bg-surface-container-lowest p-3 cursor-pointer hover:bg-surface-container transition-colors" onclick="openYTDBreakdown(\${JSON.stringify(y).replace(/"/g, '&quot;')})"><div class="text-[10px] font-bold uppercase tracking-wider text-outline">Neto YTD</div><div class="font-headline text-lg font-bold tabular-nums mt-0.5 \${netCls}">\${fmt(net)}</div><div class="text-[9px] text-primary mt-0.5">click → mensual</div></div>\`,
      \`<div class="bg-surface-container-lowest p-3 cursor-pointer hover:bg-surface-container transition-colors" onclick="openYTDBreakdown(\${JSON.stringify(y).replace(/"/g, '&quot;')})"><div class="text-[10px] font-bold uppercase tracking-wider text-outline">Avg/month</div><div class="font-headline text-lg font-bold tabular-nums mt-0.5 text-on-surface">\${fmt(t.avg_monthly_expense)}</div><div class="text-[9px] text-primary mt-0.5">click → trend</div></div>\`,
    ].join("");

    // Top categories as clickable chips
    const topCats = (y.by_category || []).slice(0, 8);
    const ytdTotal = topCats.reduce((s, c) => s + c.total, 0) || 1;
    document.getElementById("ytdTopCats").innerHTML = topCats.map((c) => {
      const pct = Math.round((c.total / ytdTotal) * 100);
      return \`<button onclick="openCategoryDrill('\${c.category}', '\${y.year}')" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container hover:bg-primary-container hover:text-on-primary-container text-xs font-medium transition-colors">
        <span class="material-symbols-outlined" style="font-size: 13px">\${ICON[c.category] || ICON.other}</span>
        <span>\${c.category}</span>
        <span class="text-outline tabular-nums">\${fmt(c.total)} · \${pct}%</span>
      </button>\`;
    }).join("");
  }

  // ─── Category drilldown modal ─────────────────────────────────────────────
  async function openCategoryDrill(category, period) {
    const modal = document.getElementById("drillModal");
    const body  = document.getElementById("drillBody");
    document.getElementById("drillTitle").textContent = category;
    document.getElementById("drillSub").textContent   = "Period " + period + " · loading…";
    body.innerHTML = "<div class='p-8 text-center text-outline'>Loading…</div>";
    modal.classList.remove("hidden");

    const url = "/api/category.json?key=" + encodeURIComponent(key) + "&category=" + encodeURIComponent(category) + "&period=" + encodeURIComponent(period);
    const r = await fetch(url);
    if (!r.ok) { body.innerHTML = "<div class='p-8 text-error'>Error " + r.status + "</div>"; return; }
    const d = await r.json();
    document.getElementById("drillSub").textContent = d.count + " transactions · " + fmt(d.total) + " · " + d.period;
    const ACCOUNT_BADGE = {
      "BNP":     "bg-secondary-container text-secondary",
      "Amex":    "bg-primary-container text-on-primary-container",
      "Revolut": "bg-tertiary-container/60 text-tertiary",
    };
    body.innerHTML = d.rows.length ? \`
      <div class="px-4 py-2 border-b border-outline-variant/15 bg-surface-container-low flex items-center justify-between">
        <span class="text-xs text-outline">Change categories below, then click Save.</span>
        <button id="drillSaveBtn" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-container text-outline cursor-not-allowed" disabled>✓ No unsaved changes</button>
      </div>
      <table class="w-full text-sm">
        <thead class="bg-surface-container sticky top-0">
          <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
            <th class="px-3 py-2">Date</th>
            <th class="px-3 py-2 w-20">Account</th>
            <th class="px-3 py-2">Merchant</th>
            <th class="px-3 py-2 text-right">Amount</th>
            <th class="px-3 py-2 text-right">Category</th>
          </tr>
        </thead>
        <tbody>
          \${d.rows.map((r) => {
            const badgeClr = ACCOUNT_BADGE[r.account] || "bg-surface-container text-outline";
            return \`<tr class="border-b border-outline-variant/15 last:border-0">
              <td class="px-3 py-2 text-outline tabular-nums text-xs">\${r.date}</td>
              <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold \${badgeClr}">\${r.account || "—"}</span></td>
              <td class="px-3 py-2 text-on-surface">\${r.merchant || "—"}</td>
              <td class="px-3 py-2 text-right tabular-nums \${r.amount < 0 ? "" : "text-primary"}">\${fmt(r.amount)}</td>
              <td class="px-3 py-2 text-right">
                <select data-tx-id="\${r.id ?? ""}" data-orig="\${category}" class="drillRecat text-xs bg-surface-container border-0 rounded-lg pl-2.5 pr-7 py-1.5 font-medium hover:bg-surface-container-high focus:ring-2 focus:ring-primary focus:outline-none transition-colors">
                  \${categoryOptions(category)}
                </select>
              </td>
            </tr>\`;
          }).join("")}
        </tbody>
      </table>\` : "<div class='p-8 text-center text-outline italic'>No transactions</div>";

    function refreshDrillDirtyCounter() {
      const dirty = body.querySelectorAll(".drillRecat[data-dirty='1']").length;
      const btn = document.getElementById("drillSaveBtn");
      if (!btn) return;
      btn.textContent = dirty > 0 ? \`💾 Save \${dirty} change\${dirty === 1 ? "" : "s"}\` : "✓ No unsaved changes";
      btn.disabled = dirty === 0;
      btn.className = "px-3 py-1.5 rounded-lg text-xs font-semibold " +
        (dirty > 0 ? "bg-primary text-on-primary hover:opacity-90" : "bg-surface-container text-outline cursor-not-allowed");
    }
    body.querySelectorAll(".drillRecat").forEach((sel) => {
      sel.onchange = () => {
        const isDirty = sel.value !== sel.dataset.orig;
        sel.dataset.dirty = isDirty ? "1" : "";
        sel.classList.toggle("ring-2", isDirty);
        sel.classList.toggle("ring-warn", isDirty);
        refreshDrillDirtyCounter();
      };
    });
    const drillSaveBtn = document.getElementById("drillSaveBtn");
    if (drillSaveBtn) drillSaveBtn.onclick = async () => {
      const dirty = [...body.querySelectorAll(".drillRecat[data-dirty='1']")];
      if (!dirty.length) return;
      drillSaveBtn.disabled = true;
      drillSaveBtn.textContent = "💾 Saving…";
      let saved = 0; let failed = 0;
      for (const sel of dirty) {
        const txId = parseInt(sel.dataset.txId, 10);
        if (!txId) continue;
        const ok = await changeCategory(txId, sel.value);
        if (ok) {
          sel.dataset.orig = sel.value;
          sel.dataset.dirty = "";
          sel.classList.remove("ring-2", "ring-warn");
          sel.classList.add("bg-primary-container", "text-on-primary-container");
          setTimeout(() => sel.classList.remove("bg-primary-container", "text-on-primary-container"), 1000);
          saved++;
        } else { failed++; }
      }
      await load(currentData.period);
      refreshDrillDirtyCounter();
      if (failed > 0) alert(\`Saved \${saved} · \${failed} failed\`);
    };
  }
  // expose to inline onclicks
  window.openCategoryDrill = openCategoryDrill;
  window.openYearDrill = (cat) => openCategoryDrill(cat === "all" ? "income" : cat, document.getElementById("ytdYearLabel").textContent);

  // YTD breakdown — uses the drilldown modal with a custom-rendered body
  // showing categories, monthly trend, and top merchants for the year.
  function openYTDBreakdown(y) {
    const modal = document.getElementById("drillModal");
    document.getElementById("drillTitle").textContent = "Gasto YTD · " + y.year;
    document.getElementById("drillSub").textContent =
      "Total " + fmt(y.totals.expenses_actual_eur) + " · " + y.months_with_data + " months · " +
      "net " + fmt(y.totals.net_actual_eur);
    const body = document.getElementById("drillBody");

    const catsHtml = (y.by_category || []).slice(0, 15).map((c) => {
      const pct = y.totals.expenses_actual_eur > 0 ? Math.round(c.total / y.totals.expenses_actual_eur * 100) : 0;
      return \`<tr class="border-b border-outline-variant/15 hover:bg-surface-container-low cursor-pointer" onclick="openCategoryDrill('\${c.category}', '\${y.year}')">
        <td class="px-3 py-2"><span class="material-symbols-outlined text-outline mr-1" style="font-size:14px">\${ICON[c.category] || ICON.other}</span><span class="capitalize">\${c.category}</span></td>
        <td class="px-3 py-2 text-right tabular-nums">\${fmt(c.total)}</td>
        <td class="px-3 py-2 text-right text-outline">\${pct}%</td>
        <td class="px-3 py-2 text-right text-outline tabular-nums text-xs">\${c.count} tx</td>
      </tr>\`;
    }).join("");
    const monthsHtml = (y.by_month || []).map((m) => \`
      <tr class="border-b border-outline-variant/15">
        <td class="px-3 py-2 tabular-nums">\${m.month}</td>
        <td class="px-3 py-2 text-right tabular-nums text-error">\${fmt(m.expenses)}</td>
        <td class="px-3 py-2 text-right tabular-nums text-primary">\${fmt(m.income)}</td>
        <td class="px-3 py-2 text-right tabular-nums font-semibold \${(m.income - m.expenses) >= 0 ? "text-primary" : "text-error"}">\${fmt(m.income - m.expenses)}</td>
      </tr>\`).join("");
    const merchHtml = (y.top_merchants || []).slice(0, 15).map((m) => \`
      <tr class="border-b border-outline-variant/15">
        <td class="px-3 py-2">\${m.merchant.slice(0, 50)}</td>
        <td class="px-3 py-2 text-right tabular-nums">\${fmt(m.total)}</td>
        <td class="px-3 py-2 text-right text-outline tabular-nums text-xs">\${m.count} tx</td>
      </tr>\`).join("");

    body.innerHTML = \`
      <div class="px-5 py-4 space-y-6">
        <section>
          <h4 class="text-xs font-bold uppercase tracking-wider text-outline mb-2">By category</h4>
          <table class="w-full text-sm"><tbody>\${catsHtml}</tbody></table>
        </section>
        <section>
          <h4 class="text-xs font-bold uppercase tracking-wider text-outline mb-2">By month</h4>
          <table class="w-full text-sm">
            <thead><tr class="text-left text-[10px] uppercase tracking-wider text-outline border-b border-outline-variant/15">
              <th class="px-3 py-2">Month</th><th class="px-3 py-2 text-right">Spend</th><th class="px-3 py-2 text-right">Income</th><th class="px-3 py-2 text-right">Net</th>
            </tr></thead>
            <tbody>\${monthsHtml}</tbody>
          </table>
        </section>
        <section>
          <h4 class="text-xs font-bold uppercase tracking-wider text-outline mb-2">Top comercios</h4>
          <table class="w-full text-sm"><tbody>\${merchHtml}</tbody></table>
        </section>
      </div>\`;
    modal.classList.remove("hidden");
  }
  window.openYTDBreakdown = openYTDBreakdown;
  document.getElementById("drillClose").onclick = () => document.getElementById("drillModal").classList.add("hidden");
  document.getElementById("drillModal").onclick = (e) => { if (e.target.id === "drillModal") e.currentTarget.classList.add("hidden"); };

  // ─── Match-keyword editor ─────────────────────────────────────────────────
  let kwEditingLabel = null;
  let kwEditingType  = "fijo";   // 'fijo' | 'variable'
  function openKeywordEdit(label, currentKw, type) {
    kwEditingLabel = label;
    kwEditingType  = type || "fijo";
    document.getElementById("kwLabel").textContent = label + "  (" + kwEditingType + ")";
    document.getElementById("kwInput").value = currentKw || "";
    document.getElementById("kwModal").classList.remove("hidden");
    setTimeout(() => document.getElementById("kwInput").focus(), 50);
  }
  window.openKeywordEdit = openKeywordEdit;
  document.getElementById("kwCancel").onclick = () => document.getElementById("kwModal").classList.add("hidden");
  document.getElementById("kwSave").onclick = async () => {
    const kw = document.getElementById("kwInput").value.trim();
    const r = await fetch("/api/match-keyword?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: kwEditingLabel,
        match_keyword: kw || null,
        target: kwEditingType === "variable" ? "variable" : "fixed",
      }),
    });
    if (r.ok) {
      document.getElementById("kwModal").classList.add("hidden");
      load(currentData.period);  // refresh dashboard
    } else {
      alert("Error guardando: " + r.status);
    }
  };

  // ─── Budget editor — MECE por categoría ──────────────────────────────────
  // Una fila por categoría (los 14 buckets). El input edita category_budgets
  // (la verdad MECE). Debajo de cada categoría se muestran sus fixed_items
  // como sub-detalle informativo (Arriendo €1604 dentro de housing, etc.).
  function openBudgetEditor() {
    document.getElementById("budgetModalSub").textContent = "Period " + currentData?.period + " — budget per category";
    renderBudgetBody();
    document.getElementById("budgetModal").classList.remove("hidden");
  }
  // Exposed so the "Use another month as template" handler can refresh
  // the modal body in-place after copying, without losing scroll/focus.
  window.rerenderBudgetBody = renderBudgetBody;
  function renderBudgetBody() {
    const d = currentData; if (!d) return;
    document.getElementById("budgetModalSub").textContent = "Period " + d.period + " — budget per category";
    const body = document.getElementById("budgetBody");

    // All 14 categories, sorted by current budget+actual desc, then alpha.
    const rowsByCat = new Map((d.category_rows || []).map((r) => [r.category, r]));
    const ordered = CATEGORIES.map((cat) => {
      const r = rowsByCat.get(cat) || { category: cat, budget_eur: 0, actual_eur: 0, fixed_items: [] };
      return r;
    }).sort((a, b) => {
      const aw = (a.budget_eur || 0) + (a.actual_eur || 0);
      const bw = (b.budget_eur || 0) + (b.actual_eur || 0);
      if (bw !== aw) return bw - aw;
      return a.category.localeCompare(b.category);
    });

    body.innerHTML = \`
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-surface-container z-10">
          <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
            <th class="px-4 py-3">Category</th>
            <th class="px-4 py-3 text-right w-32">Budget €/mo</th>
            <th class="px-4 py-3 text-right">Actual</th>
            <th class="px-4 py-3 text-right w-20">%</th>
          </tr>
        </thead>
        <tbody>
          \${ordered.map((r) => {
            const meta = CAT_META[r.category] || { emoji: "", label: r.category };
            const pct  = r.budget_eur > 0 ? Math.round((r.actual_eur / r.budget_eur) * 1000) / 10 : null;
            const pctClr = pct == null ? "text-outline" :
                           pct > 100 ? "text-error" :
                           pct > 80  ? "text-warn"  : "text-primary";
            const subItems = (r.fixed_items || []).map((it) =>
              \`<div class="text-[11px] text-outline pl-6">↳ \${it.label}: \${fmt(it.budget_eur)}</div>\`
            ).join("");
            return \`<tr class="border-b border-outline-variant/15">
              <td class="px-4 py-2.5">
                <div class="font-medium text-on-surface">\${meta.emoji}  \${meta.label}</div>
                \${subItems}
              </td>
              <td class="px-4 py-2.5 text-right">
                <input type="number" step="1" value="\${r.budget_eur}" min="0"
                       data-category="\${r.category}"
                       data-orig="\${r.budget_eur}"
                       class="catBudgetInput w-28 px-2 py-1 bg-surface-container rounded text-right tabular-nums font-semibold focus:ring-2 focus:ring-primary focus:outline-none" />
              </td>
              <td class="px-4 py-2.5 text-right tabular-nums text-outline">\${fmt(r.actual_eur)}</td>
              <td class="px-4 py-2.5 text-right tabular-nums \${pctClr} font-semibold">\${fmtPct(pct)}</td>
            </tr>\`;
          }).join("")}
          <tr class="bg-surface-container">
            <td colspan="4" class="px-4 py-3 text-xs text-outline italic">
              Set to 0 to clear a category's budget. Sub-items (↳) are legacy fixed_expenses — informational only.
            </td>
          </tr>
        </tbody>
      </table>\`;

    // Explicit save button. Inputs get an orange ring while "dirty" (modified
    // but not saved). User clicks "Save changes" to commit all dirty ones in
    // batch. Way more reliable than relying on change/blur events that don't
    // always fire as users expect.
    function refreshDirtyCounter() {
      const dirty = body.querySelectorAll(".catBudgetInput.dirty").length;
      const saveBtn = document.getElementById("budgetSaveBtn");
      const doneBtn = document.getElementById("budgetDoneBtn");
      if (saveBtn) {
        saveBtn.textContent = dirty > 0 ? \`💾 Save \${dirty} change\${dirty === 1 ? "" : "s"}\` : "✓ No unsaved changes";
        saveBtn.disabled = dirty === 0;
        saveBtn.className = "px-4 py-2 rounded-lg text-sm font-semibold " +
          (dirty > 0 ? "bg-primary text-on-primary hover:opacity-90" : "bg-surface-container text-outline cursor-not-allowed");
      }
      if (doneBtn) {
        doneBtn.textContent = dirty > 0 ? \`💾 Save & close (\${dirty})\` : "Close";
      }
    }
    body.querySelectorAll(".catBudgetInput").forEach((input) => {
      input.oninput = () => {
        const orig = parseFloat(input.dataset.orig);
        const val  = parseFloat(input.value);
        const isDirty = Number.isFinite(val) && val !== orig;
        input.classList.toggle("dirty", isDirty);
        input.classList.toggle("ring-2", isDirty);
        input.classList.toggle("ring-warn", isDirty);
        refreshDirtyCounter();
      };
    });
    refreshDirtyCounter();

    // Batch save all dirty inputs. Called by Save button + Save & close.
    async function saveAllDirty() {
      const dirty = [...body.querySelectorAll(".catBudgetInput.dirty")];
      if (!dirty.length) return { ok: true, saved: 0 };
      const saveBtn = document.getElementById("budgetSaveBtn");
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "💾 Saving…"; }
      let saved = 0; let failed = 0;
      for (const input of dirty) {
        const category = input.dataset.category;
        const val = parseFloat(input.value);
        if (!Number.isFinite(val)) continue;
        try {
          const r = await fetch("/api/budget?key=" + encodeURIComponent(key), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ period: d.period, kind: "category", payload: { category, budget_eur: val } }),
          });
          if (r.ok) {
            input.dataset.orig = val;
            input.classList.remove("dirty", "ring-2", "ring-warn");
            input.classList.add("ring-2", "ring-primary");
            setTimeout(() => input.classList.remove("ring-2", "ring-primary"), 800);
            saved++;
          } else {
            failed++;
            console.error("[budget save] failed for", category, "status", r.status);
          }
        } catch (err) {
          failed++;
          console.error("[budget save] network error for", category, err);
        }
      }
      await load(d.period);
      refreshDirtyCounter();
      if (failed > 0) alert(\`Saved \${saved} · \${failed} failed (check console)\`);
      return { ok: failed === 0, saved };
    }
    window.saveBudgetChanges = saveAllDirty;

    // Wire Save button (in modal header) — saves all dirty, keeps modal open
    document.getElementById("budgetSaveBtn").onclick = saveAllDirty;
  }
  window.openBudgetEditor = openBudgetEditor;
  async function closeBudgetModal() {
    // If user has unsaved changes, ask before closing
    const dirty = document.querySelectorAll("#budgetBody .catBudgetInput.dirty").length;
    if (dirty > 0) {
      if (confirm(\`You have \${dirty} unsaved change\${dirty === 1 ? "" : "s"}. Save before closing?\`)) {
        if (typeof window.saveBudgetChanges === "function") await window.saveBudgetChanges();
      }
    }
    document.getElementById("budgetModal").classList.add("hidden");
  }
  document.getElementById("budgetClose").onclick   = closeBudgetModal;
  document.getElementById("budgetDoneBtn").onclick = closeBudgetModal;
  document.getElementById("budgetCloneBtn").onclick = async () => {
    const fromPeriod = prompt("Which month do you want to copy budgets from?\\nType in YYYY-MM format. Example: 2026-05 to use May 2026 as template for " + currentData.period + ".");
    if (!fromPeriod || !/^\d{4}-\d{2}$/.test(fromPeriod)) return;
    if (!confirm("Only fills in empty categories (won't overwrite values you already set in " + currentData.period + "). Continue?")) return;
    const cloneBtn = document.getElementById("budgetCloneBtn");
    const origText = cloneBtn.textContent;
    cloneBtn.disabled = true;
    cloneBtn.textContent = "Copying…";
    const r = await fetch("/api/budget?key=" + encodeURIComponent(key), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: currentData.period, kind: "copy_categories", payload: { srcPeriod: fromPeriod } }),
    });
    const j = await r.json().catch(() => ({}));
    cloneBtn.disabled = false;
    cloneBtn.textContent = origText;
    if (!r.ok) { alert("Error: " + (j.error || r.status)); return; }
    // Refresh data + re-render modal body IN-PLACE (no close/reopen — preserves scroll/focus)
    await load(currentData.period);
    if (typeof window.rerenderBudgetBody === "function") window.rerenderBudgetBody();
    // Inline confirmation (replaces the disruptive alert)
    const sub = document.getElementById("budgetModalSub");
    const prev = sub.textContent;
    sub.innerHTML = \`<span class="text-primary font-semibold">✓ Copied \${j.copied ?? 0} categories from \${fromPeriod}</span>\`;
    setTimeout(() => { sub.textContent = prev; }, 3000);
  };

  // ─── BNP balance edit modal ──────────────────────────────────────────────
  openBnpBalanceEditor = async () => {
    const period = currentData?.period;
    if (!period) return;
    document.getElementById("bnpModalPeriod").textContent = "Period " + period;
    // Pre-fill with current values
    const r = await fetch("/api/cashflow.json?key=" + encodeURIComponent(key) + "&account=bnp&period=" + period);
    const d = await r.json();
    document.getElementById("bnpOpening").value = d.opening_source === "manual" || d.opening_source === "unset" ? (d.opening_eur ?? "") : "";
    document.getElementById("bnpClosing").value = d.closing_source === "manual" ? (d.closing_eur ?? "") : "";
    document.getElementById("bnpModal").classList.remove("hidden");
    setTimeout(() => document.getElementById("bnpOpening").focus(), 50);
  };
  document.getElementById("bnpCancel").onclick = () => document.getElementById("bnpModal").classList.add("hidden");
  document.getElementById("bnpSave").onclick = async () => {
    const opening = document.getElementById("bnpOpening").value.trim();
    const closing = document.getElementById("bnpClosing").value.trim();
    const r = await fetch("/api/account-balance?key=" + encodeURIComponent(key), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: "bnp",
        period: currentData.period,
        opening_eur: opening === "" ? null : parseFloat(opening),
        closing_eur: closing === "" ? null : parseFloat(closing),
      }),
    });
    if (r.ok) {
      document.getElementById("bnpModal").classList.add("hidden");
      loadBnpCashflow(currentData.period);
    } else {
      alert("Error: " + r.status);
    }
  };
  // expose so the dynamically-rendered BNP card can wire its edit button
  window.openBnpBalanceEditor = openBnpBalanceEditor;

  // ─── Audit modal ──────────────────────────────────────────────────────────
  function openAudit() {
    if (!auditData) return;
    renderAudit(auditData);
    document.getElementById("auditModal").classList.remove("hidden");
  }
  window.openAudit = openAudit;
  document.getElementById("auditClose").onclick = () => document.getElementById("auditModal").classList.add("hidden");
  document.getElementById("auditModal").onclick = (e) => { if (e.target.id === "auditModal") e.currentTarget.classList.add("hidden"); };

  function renderAudit(a) {
    document.getElementById("auditSub").textContent = "Period " + a.period + " — txs not claimed by any fixed line (informational with category-level MECE)";

    document.getElementById("auditTotals").innerHTML = [
      \`<div class="bg-surface-container rounded-lg p-2.5"><div class="text-[10px] uppercase tracking-wider text-outline">Month total</div><div class="font-headline font-bold text-base tabular-nums mt-0.5">\${fmt(a.totals.total_outflow)}</div></div>\`,
      \`<div class="bg-primary-container rounded-lg p-2.5"><div class="text-[10px] uppercase tracking-wider text-on-primary-container/80" title="Transactions matched by a fixed_expenses keyword">Claimed by fixed</div><div class="font-headline font-bold text-base tabular-nums mt-0.5 text-on-primary-container">\${fmt(a.totals.total_claimed)}</div></div>\`,
      \`<div class="bg-warn-container rounded-lg p-2.5" title="Don't match any fixed_expenses keyword. NOT AN ERROR — just not tied to a specific fixed concept (rent/gym/etc). Their category is respected and they count in their category bucket."><div class="text-[10px] uppercase tracking-wider text-warn">No fixed line tied</div><div class="font-headline font-bold text-base tabular-nums mt-0.5 text-warn">\${fmt(a.totals.total_orphan)} · \${a.totals.orphan_pct}%</div></div>\`,
    ].join("");

    // Group orphans by category for visual clarity
    const byCat = {};
    for (const o of a.orphans) {
      const c = o.category || "uncategorised";
      byCat[c] = byCat[c] || [];
      byCat[c].push(o);
    }

    const conflictsBlock = a.conflicts.length ? \`
      <div class="px-5 py-3 bg-error-container/30 border-b border-outline-variant/20">
        <div class="text-xs font-semibold text-error mb-1">\${a.conflicts.length} conflicto(s) — transacciones que matchean varios fijos</div>
        \${a.conflicts.slice(0, 5).map((c) => \`<div class="text-xs text-on-surface">\${c.merchant} \${fmt(c.amount)} → asignado a <b>\${c.assigned_to}</b> (also matches: \${c.matched_by.filter((m) => m !== c.assigned_to).join(", ")})</div>\`).join("")}
      </div>\` : "";

    const body = conflictsBlock + Object.entries(byCat).map(([cat, rows]) => {
      const catTotal = rows.reduce((s, r) => s + r.amount, 0);
      return \`<div class="border-b border-outline-variant/20">
        <div class="sticky top-0 bg-surface-container px-5 py-2 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-outline" style="font-size:16px">\${ICON[cat] || ICON.other}</span>
            <span class="font-semibold text-on-surface">\${cat}</span>
            <span class="text-xs text-outline">\${rows.length} tx</span>
          </div>
          <span class="font-headline font-bold tabular-nums text-warn">\${fmt(catTotal)}</span>
        </div>
        \${rows.map((o) => \`
          <div class="px-5 py-2 flex items-center gap-2 hover:bg-surface-container-low" data-tx-row="\${o.id}">
            <div class="flex-1 min-w-0">
              <div class="text-sm truncate"><span class="text-outline tabular-nums mr-2">\${o.date.slice(5)}</span>\${o.merchant || "—"}</div>
            </div>
            <span class="font-mono tabular-nums text-sm">\${fmt(o.amount)}</span>
            <select data-tx-id="\${o.id}" data-current-cat="\${o.category || ""}" class="auditRecat text-xs bg-surface-container border-0 rounded-lg pl-2.5 pr-7 py-1.5 min-w-[160px] font-medium hover:bg-surface-container-high focus:ring-2 focus:ring-primary focus:outline-none transition-colors" title="Cambiar categoría">
              \${categoryOptions(o.category)}
            </select>
          </div>\`).join("")}
      </div>\`;
    }).join("");

    document.getElementById("auditBody").innerHTML = body || "<div class='p-8 text-center text-outline'>No orphans 🎉</div>";

    // Hook up "Recategorizar" dropdowns
    document.querySelectorAll(".auditRecat").forEach((sel) => {
      sel.onchange = async () => {
        const newCat = sel.value;
        const txId = parseInt(sel.dataset.txId, 10);
        const oldCat = sel.dataset.currentCat;
        if (!newCat || newCat === oldCat) return;
        sel.disabled = true;
        const ok = await changeCategory(txId, newCat);
        if (ok) {
          sel.dataset.currentCat = newCat;
          sel.disabled = false;
          sel.classList.add("bg-primary-container", "text-on-primary-container");
          setTimeout(() => sel.classList.remove("bg-primary-container", "text-on-primary-container"), 1200);
          load(currentData.period);  // refresh dashboard underneath
        } else {
          alert("Error cambiando categoría");
          sel.value = oldCat;
          sel.disabled = false;
        }
      };
    });
  }

  function populatePeriodSelectors(periods, current) {
    const periodSet = new Set(periods);
    const years = [...new Set(periods.map((p) => p.split("-")[0]))].sort();
    const [curY, curM] = current.split("-");

    const btn        = document.getElementById("periodBtn");
    const btnLabel   = document.getElementById("periodBtnLabel");
    const popover    = document.getElementById("periodPopover");
    const yearLabel  = document.getElementById("periodYearLabel");
    const monthsEl   = document.getElementById("periodMonths");
    const prevBtn    = document.getElementById("periodPrev");
    const nextBtn    = document.getElementById("periodNext");

    let viewedYear = curY;  // year currently shown inside the popover

    btnLabel.textContent = MONTH_LONG[parseInt(curM, 10) - 1] + " " + curY;

    function paintMonths() {
      yearLabel.textContent = viewedYear;
      const yearIdx = years.indexOf(viewedYear);
      prevBtn.disabled = yearIdx <= 0;
      nextBtn.disabled = yearIdx >= years.length - 1;
      prevBtn.classList.toggle("opacity-30", prevBtn.disabled);
      nextBtn.classList.toggle("opacity-30", nextBtn.disabled);

      monthsEl.innerHTML = Array.from({length: 12}, (_, i) => {
        const mm = String(i + 1).padStart(2, "0");
        const period = viewedYear + "-" + mm;
        const enabled = periodSet.has(period);
        const isCurrent = period === current;
        const base = "h-12 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center";
        const cls = isCurrent
          ? base + " bg-primary text-on-primary"
          : enabled
            ? base + " bg-surface-container hover:bg-primary-container hover:text-on-primary-container text-on-surface cursor-pointer"
            : base + " text-outline/40 cursor-not-allowed";
        return \`<button data-period="\${period}" \${enabled ? "" : "disabled"} class="\${cls}">\${MONTH_NAMES[i]}</button>\`;
      }).join("");
      monthsEl.querySelectorAll("button[data-period]").forEach((b) => {
        b.onclick = () => {
          const p = b.dataset.period;
          popover.classList.add("hidden");
          history.replaceState(null, "", "?key=" + key + "&period=" + p);
          load(p);
        };
      });
    }
    paintMonths();

    prevBtn.onclick = () => { const i = years.indexOf(viewedYear); if (i > 0) { viewedYear = years[i - 1]; paintMonths(); } };
    nextBtn.onclick = () => { const i = years.indexOf(viewedYear); if (i < years.length - 1) { viewedYear = years[i + 1]; paintMonths(); } };

    btn.onclick = (e) => {
      e.stopPropagation();
      popover.classList.toggle("hidden");
      viewedYear = curY;
      paintMonths();
    };
    document.addEventListener("click", (e) => {
      if (!popover.contains(e.target) && e.target !== btn) popover.classList.add("hidden");
    });
  }

  function render(d) {
    populatePeriodSelectors(d.available_periods.length ? d.available_periods : [d.period], d.period);

    // Reconciliation badge — flag the month if any account's statement didn't
    // add up to its printed closing balance at import time.
    const reconBadge = document.getElementById("reconBadge");
    if (reconBadge) {
      const bad = (d.reconciliation && d.reconciliation.unreconciled) || [];
      if (bad.length) {
        reconBadge.classList.remove("hidden");
        reconBadge.classList.add("flex");
        reconBadge.title = "This month's " + bad.join(", ").toUpperCase() + " statement doesn't reconcile with its balance — the figures may be incomplete. Re-upload the statement.";
        document.getElementById("reconBadgeText").textContent = "Review " + bad.map((a) => a.toUpperCase()).join("/");
      } else {
        reconBadge.classList.add("hidden");
        reconBadge.classList.remove("flex");
      }
    }

    const t = d.totals;
    // category_budgets is MECE: single number per category per month. Fallback
    // to legacy fixed+variable totals if category budgets aren't set yet.
    const planned = t.category_budget_eur > 0 ? t.category_budget_eur : (t.fixed_eur + t.variable_eur);

    // Spending progress dial: single ring, % of income actually spent.
    // Green < 60%, amber 60-90%, red > 90%. Center shows €spent + % + available.
    const pctActual  = t.income_eur > 0 ? (t.actual_eur / t.income_eur) * 100 : 0;
    const ringClr    = pctActual > 90 ? "text-error" : pctActual > 60 ? "text-warn" : "text-primary";
    const amtClr     = pctActual > 90 ? "text-error" : pctActual > 60 ? "text-warn" : "text-on-surface";
    document.getElementById("ringOuter").setAttribute("stroke-dashoffset", String(CIRCUM * (1 - Math.min(pctActual, 100) / 100)));
    document.getElementById("ringOuter").className.baseVal = "transition-all duration-700 " + ringClr;

    const available = Math.max(0, t.income_eur - t.actual_eur);
    document.getElementById("dialResidual").textContent = fmt(t.actual_eur);
    document.getElementById("dialResidual").className   = "font-headline text-3xl md:text-4xl font-bold tabular-nums leading-none mt-1 " + amtClr;
    document.getElementById("dialPctSpent").textContent = fmtPct(pctActual);
    document.getElementById("dialPctSpent").className   = "mt-1 font-headline text-xl font-bold tabular-nums " + amtClr;
    document.getElementById("dialIncome").textContent    = fmt(t.income_eur);
    document.getElementById("dialAvailable").textContent = fmt(available);

    // KPI cards
    document.getElementById("kpiIncome").textContent = fmt(t.income_eur);
    document.getElementById("kpiActual").textContent = fmt(t.actual_eur);
    document.getElementById("kpiActual").className = "font-headline text-xl font-bold tabular-nums mt-1 " + (t.actual_eur > planned ? "text-error" : "text-on-surface");
    const delta = t.actual_eur - planned;
    document.getElementById("kpiActualVsPlan").textContent = "vs plan " + (delta >= 0 ? "+" : "") + fmt(delta);
    document.getElementById("kpiPlanned").textContent = fmt(planned);
    const catCount = (d.category_rows || []).filter((r) => r.budget_eur > 0).length;
    document.getElementById("kpiPlannedBreak").textContent = catCount > 0
      ? catCount + " budgeted categories"
      : "F " + fmt(t.fixed_eur) + " · V " + fmt(t.variable_eur);
    document.getElementById("kpiPct").textContent = fmtPct(t.pct_spent);
    document.getElementById("kpiPct").className = "font-headline text-xl font-bold tabular-nums mt-1 " + (t.pct_spent == null ? "text-on-surface" : t.pct_spent > 95 ? "text-error" : t.pct_spent > 80 ? "text-warn" : "text-primary");
    document.getElementById("kpiPctSub").textContent = t.pct_spent == null ? "—" : t.pct_spent <= 80 ? "Comfortable" : t.pct_spent <= 95 ? "Warning" : "Over budget";

    // Insight strip — worst overspend at category level (MECE)
    const worstOverspend = (d.category_rows || [])
      .filter((r) => r.pct_used != null && r.pct_used > 100)
      .sort((a, b) => b.pct_used - a.pct_used)[0];
    const insight = document.getElementById("insight");
    if (worstOverspend) {
      const meta = CAT_META[worstOverspend.category] || { emoji: "", label: worstOverspend.category };
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-error/20 bg-error-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-error">priority_high</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-surface text-sm">
            \${meta.emoji} \${meta.label} al \${fmtPct(worstOverspend.pct_used)}
          </div>
          <div class="text-xs text-on-surface/70">
            Actual \${fmt(worstOverspend.actual_eur)} of \${fmt(worstOverspend.budget_eur)} planned.
          </div>
        </div>\`;
    } else if (t.pct_spent != null && t.pct_spent > 80) {
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-warn/20 bg-warn-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-warn">trending_up</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-surface text-sm">Near the limit</div>
          <div class="text-xs text-on-surface/70">You've spent \${fmtPct(t.pct_spent)} of income this month.</div>
        </div>\`;
    } else {
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-primary/20 bg-primary-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-primary">eco</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-primary-container text-sm">Under control</div>
          <div class="text-xs text-on-primary-container/80">
            No category over budget. \${t.pct_spent != null ? fmtPct(t.pct_spent) + " spent." : ""}
          </div>
        </div>\`;
    }

    // MECE: una fila por categoría desde el backend (d.category_rows).
    // category_budgets es la fuente única de verdad para el presupuesto;
    // fixed_items se muestran como sub-detalle informativo.
    const allRows = d.category_rows || [];
    const budgetTotal = allRows.reduce((s, r) => s + (r.budget_eur || 0), 0);
    const actualTotal = allRows.reduce((s, r) => s + (r.actual_eur || 0), 0);
    const withBudget  = allRows.filter((r) => r.budget_eur > 0).length;
    const pctOverall  = budgetTotal > 0 ? Math.round((actualTotal / budgetTotal) * 1000) / 10 : null;

    // Stats line — single source of truth, no toggle (filter input below does the work)
    const statsClr = pctOverall == null ? "text-outline" : pctOverall > 100 ? "text-error" : pctOverall > 85 ? "text-warn" : "text-primary";
    const chipsEl = document.getElementById("filterChips");
    chipsEl.innerHTML = \`
      <div class="text-xs text-outline tabular-nums">
        <strong class="text-on-surface">\${withBudget}</strong> categories ·
        plan <strong class="text-on-surface">€\${fmt(budgetTotal).replace("€","")}</strong> ·
        real <strong class="text-on-surface">€\${fmt(actualTotal).replace("€","")}</strong>
        \${pctOverall != null ? \`(<span class="\${statsClr} font-semibold">\${pctOverall}%</span>)\` : ""}
      </div>\`;

    // Wire sortable headers + filter input (idempotent — overwrites onclick)
    document.querySelectorAll("[data-sort]").forEach((th) => {
      th.onclick = () => {
        const k = th.dataset.sort;
        if (gastosSort.key === k) gastosSort.dir = gastosSort.dir === "asc" ? "desc" : "asc";
        else { gastosSort.key = k; gastosSort.dir = k === "name" ? "asc" : "desc"; }
        render(currentData);
      };
    });
    const filterEl = document.getElementById("gastosFilter");
    if (filterEl && !filterEl._wired) {
      filterEl._wired = true;
      let t;
      filterEl.oninput = () => { clearTimeout(t); t = setTimeout(() => render(currentData), 150); };
    }

    const filterQ = (document.getElementById("gastosFilter")?.value || "").trim().toLowerCase();
    const sortKey = gastosSort.key;
    const sortDir = gastosSort.dir;
    const sortFns = {
      name:   (r) => (CAT_META[r.category]?.label || r.category).toLowerCase(),
      budget: (r) => r.budget_eur,
      actual: (r) => r.actual_eur,
      delta:  (r) => r.budget_eur === 0 ? -Infinity : r.delta_eur,
      pct:    (r) => r.pct_used == null ? -1 : r.pct_used,
    };
    const filteredCats = allRows
      .filter((r) => r.budget_eur > 0 || r.actual_eur > 0)
      .filter((r) => !filterQ ? true : (
        (CAT_META[r.category]?.label || r.category).toLowerCase().includes(filterQ) ||
        r.category.toLowerCase().includes(filterQ)
      ))
      .sort((a, b) => {
        const fn = sortFns[sortKey] || sortFns.budget;
        const av = fn(a), bv = fn(b);
        if (av < bv) return sortDir === "asc" ? -1 : 1;
        if (av > bv) return sortDir === "asc" ?  1 : -1;
        return 0;
      });

    // Sort indicators in headers
    document.querySelectorAll(".gastosSortArrow").forEach((el) => {
      el.textContent = el.dataset.col === sortKey ? (sortDir === "asc" ? "↑" : "↓") : "";
    });

    const tbl = document.getElementById("gastosTbl");
    if (!filteredCats.length) {
      tbl.innerHTML = \`<tr><td colspan="5" class="px-3 py-8 text-outline italic text-center">No categories for \${d.period}</td></tr>\`;
    } else {
      const rowsHtml = filteredCats.map((c) => {
        const pct = c.pct_used;
        const meta = CAT_META[c.category] || { emoji: "", label: c.category };
        const pctClr = pct == null ? "bg-surface-container text-on-surface-variant" :
                       pct > 100 ? "bg-error-container text-error" :
                       pct > 80  ? "bg-warn-container text-warn"   : "bg-primary-container text-on-primary-container";
        const deltaClr = c.budget_eur === 0 ? "text-outline" :
                         c.delta_eur >= 0   ? "text-primary"  : "text-error";
        const deltaTxt = c.budget_eur === 0
          ? "—"
          : (c.delta_eur >= 0 ? "+" : "") + fmt(c.delta_eur);
        const subItems = (c.fixed_items || []).length
          ? \`<div class="text-[10px] text-outline pl-6 mt-0.5">\${c.fixed_items.map((it) => it.label + " " + fmt(it.budget_eur)).join(" · ")}</div>\`
          : "";
        // Progress bar: actual vs budget, capped at 100% width, colored by usage.
        const overBudget = c.budget_eur > 0 && c.actual_eur > c.budget_eur;
        const barClr = pct == null ? "bg-outline-variant" : pct > 100 ? "bg-error" : pct > 80 ? "bg-warn" : "bg-primary";
        const barW   = c.budget_eur > 0 ? Math.min(100, Math.round((c.actual_eur / c.budget_eur) * 100)) : 0;
        const bar = c.budget_eur > 0
          ? \`<div class="mt-1.5 h-1.5 w-full max-w-[220px] rounded-full bg-outline-variant/20 overflow-hidden"><div class="h-full \${barClr} transition-all" style="width:\${barW}%"></div></div>\`
          : "";
        return \`<tr class="border-b border-outline-variant/15 hover:bg-surface-container-low cursor-pointer \${overBudget ? 'border-l-2 border-l-error' : ''}" onclick="openCategoryDrill('\${c.category}', '\${d.period}')">
          <td class="px-2 sm:px-3 py-2.5">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-outline hidden sm:inline" style="font-size: 16px">\${ICON[c.category] || ICON.other}</span>
              <span class="text-on-surface font-medium">\${meta.emoji} \${meta.label}</span>
            </div>
            \${subItems}
            \${bar}
          </td>
          <td class="px-2 sm:px-3 py-2.5 text-right tabular-nums">\${c.budget_eur > 0 ? fmt(c.budget_eur) : '<span class="text-outline">—</span>'}</td>
          <td class="px-2 sm:px-3 py-2.5 text-right tabular-nums">\${fmt(c.actual_eur)}</td>
          <td class="hidden sm:table-cell px-2 sm:px-3 py-2.5 text-right tabular-nums \${deltaClr}">\${deltaTxt}</td>
          <td class="px-2 sm:px-3 py-2.5 text-right"><span class="px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-semibold \${pctClr}">\${fmtPct(pct)}</span></td>
        </tr>\`;
      }).join("");

      // Totals row — big, bold, color-coded, at the bottom of the table.
      const totBudget = filteredCats.reduce((s, r) => s + (r.budget_eur || 0), 0);
      const totActual = filteredCats.reduce((s, r) => s + (r.actual_eur || 0), 0);
      const totDelta  = totBudget - totActual;
      const totPct    = totBudget > 0 ? Math.round((totActual / totBudget) * 1000) / 10 : null;
      const totDeltaClr = totBudget === 0 ? "text-outline" : totDelta >= 0 ? "text-primary" : "text-error";
      const totPctClr   = totPct == null ? "bg-surface-container text-on-surface-variant" :
                          totPct > 100 ? "bg-error-container text-error" :
                          totPct > 80  ? "bg-warn-container text-warn"   : "bg-primary-container text-on-primary-container";
      const totalsRow = \`<tr class="bg-surface-container border-t-2 border-on-surface/30">
        <td class="px-2 sm:px-3 py-4">
          <div class="font-headline font-bold text-sm sm:text-base text-on-surface">TOTAL</div>
          <div class="text-[11px] text-outline">\${filteredCats.length} \${filteredCats.length === 1 ? "category" : "categories"}</div>
        </td>
        <td class="px-2 sm:px-3 py-4 text-right tabular-nums font-headline font-bold text-base sm:text-lg text-on-surface">\${fmt(totBudget)}</td>
        <td class="px-2 sm:px-3 py-4 text-right tabular-nums font-headline font-bold text-base sm:text-lg text-on-surface">\${fmt(totActual)}</td>
        <td class="hidden sm:table-cell px-2 sm:px-3 py-4 text-right tabular-nums font-headline font-bold text-lg \${totDeltaClr}">\${totBudget === 0 ? "—" : (totDelta >= 0 ? "+" : "") + fmt(totDelta)}</td>
        <td class="px-2 sm:px-3 py-4 text-right"><span class="px-2 sm:px-2.5 py-1 rounded-full text-xs sm:text-sm font-bold \${totPctClr}">\${fmtPct(totPct)}</span></td>
      </tr>\`;

      tbl.innerHTML = rowsHtml + totalsRow;
    }

    renderCharts(d);
    renderComparison(d.recent_months_comparison);
  }

  function renderComparison(c) {
    if (!c || !c.months || c.months.length < 2) {
      document.getElementById("comparisonBody").innerHTML = \`<div class="text-xs text-outline italic p-3">Need at least 2 months of data</div>\`;
      return;
    }
    const totalsRow = c.summary.total_per_month;
    const lastTotal = totalsRow[totalsRow.length - 1];
    const firstTotal = totalsRow[0];
    const totalDelta = lastTotal - firstTotal;
    const totalPct = c.summary.total_delta_pct;
    const trendClr = totalDelta >= 0 ? "text-error" : "text-primary";
    document.getElementById("comparisonTotalDelta").innerHTML =
      \`Total: <span class="\${trendClr} font-semibold">\${totalDelta >= 0 ? "↑" : "↓"} \${fmt(Math.abs(totalDelta))}\${totalPct != null ? " (" + (totalPct >= 0 ? "+" : "") + totalPct + "%)" : ""}</span> vs \${c.months[0]}\`;

    // Take top 8 movers by absolute delta
    const movers = c.categories.filter((r) => Math.abs(r.delta_abs) >= 5).slice(0, 8);
    // On mobile, hide all but the last 2 months so the Δ column doesn't fall off-screen
    const lastVisibleIdx = c.months.length - 1;
    const prevVisibleIdx = c.months.length - 2;
    const monthHeader = c.months.map((m, i) => {
      const hide = i !== lastVisibleIdx && i !== prevVisibleIdx ? "hidden sm:table-cell" : "";
      return \`<th class="\${hide} px-2 sm:px-3 py-2 text-right text-[10px] uppercase tracking-wider text-outline whitespace-nowrap">\${m}</th>\`;
    }).join("");

    document.getElementById("comparisonBody").innerHTML = movers.length ? \`
      <div class="overflow-x-auto">
      <table class="w-full text-xs sm:text-sm">
        <thead>
          <tr class="border-b border-outline-variant/15">
            <th class="px-2 sm:px-3 py-2 text-left text-[10px] uppercase tracking-wider text-outline">Category</th>
            \${monthHeader}
            <th class="px-2 sm:px-3 py-2 text-right text-[10px] uppercase tracking-wider text-outline">Δ</th>
            <th class="hidden sm:table-cell px-3 py-2 text-right text-[10px] uppercase tracking-wider text-outline">%</th>
          </tr>
        </thead>
        <tbody>
          \${movers.map((r) => {
            const arrow = r.delta_abs > 0 ? "↑" : "↓";
            const clr = r.delta_abs > 0 ? "text-error" : "text-primary";
            // Each month cell is a separate click target → drills that specific month
            const monthCells = r.totals.map((v, i) => {
              const isLast = i === r.totals.length - 1;
              const hide = i !== lastVisibleIdx && i !== prevVisibleIdx ? "hidden sm:table-cell" : "";
              const m = c.months[i];
              return \`<td class="\${hide} px-2 sm:px-3 py-2 text-right tabular-nums \${isLast ? "font-semibold text-on-surface" : "text-outline"} hover:bg-surface-container-high cursor-pointer" onclick="event.stopPropagation(); openCategoryDrill('\${r.category}', '\${m}')" title="Click → view tx for \${m}">\${fmt(v)}</td>\`;
            }).join("");
            return \`<tr class="border-b border-outline-variant/15 last:border-0">
              <td class="px-2 sm:px-3 py-2"><span class="material-symbols-outlined text-outline mr-1.5 align-middle" style="font-size:14px">\${ICON[r.category] || ICON.other}</span><span class="capitalize">\${r.category}</span></td>
              \${monthCells}
              <td class="px-2 sm:px-3 py-2 text-right tabular-nums \${clr} font-semibold whitespace-nowrap">\${arrow} \${fmt(Math.abs(r.delta_abs))}</td>
              <td class="hidden sm:table-cell px-3 py-2 text-right tabular-nums \${clr} text-xs">\${r.delta_pct != null ? (r.delta_pct >= 0 ? "+" : "") + r.delta_pct + "%" : "—"}</td>
            </tr>\`;
          }).join("")}
        </tbody>
      </table>
      </div>\` : \`<div class="text-xs text-outline italic p-3">No significant changes between months</div>\`;
  }

  // ─── CFO-grade charts ───────────────────────────────────────────────────
  let trendChart, cashChart;
  // Softer, more curated palette (less rainbow, more editorial). Inspired by
  // Bloomberg/FT/Stripe data viz: muted hues, good contrast on white.
  const PALETTE = ["#1e4d8b","#2e7d5c","#a86b2d","#9b2c2c","#5d6d7e","#7d56f3","#3b82a4","#b7791f","#9333ea","#0891b2","#dc7a2c","#be185d","#737373"];
  const FONT = { size: 11, family: "Inter", weight: "500" };

  // Configure global Chart.js defaults for a consistent, polished look
  if (window.Chart) {
    Chart.defaults.font.family = "Inter";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = "#475569";
    Chart.defaults.borderColor = "rgba(15,23,42,0.06)";
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(15,23,42,0.95)";
    Chart.defaults.plugins.tooltip.titleFont = { family: "Space Grotesk", weight: "600", size: 12 };
    Chart.defaults.plugins.tooltip.bodyFont  = { family: "Inter", size: 11 };
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.displayColors = true;
    Chart.defaults.plugins.tooltip.boxPadding = 4;
    Chart.defaults.elements.line.tension = 0.4;
    Chart.defaults.elements.point.radius = 0;
    Chart.defaults.elements.point.hoverRadius = 5;
    Chart.defaults.animation.duration = 600;
    Chart.defaults.animation.easing = "easeOutQuart";
  }

  // Helper: create a vertical gradient (top-color → transparent) for area fills
  function makeGradient(ctx, color) {
    const grad = ctx.createLinearGradient(0, 0, 0, 280);
    grad.addColorStop(0, color + "55");
    grad.addColorStop(1, color + "00");
    return grad;
  }

  function renderCharts(d) {
    // ── DONUT: top 7 + agrupar el resto como "Otros" ───────────────────
    // Reduce visual clutter: many tiny slices vs a single "Otros" sliver.
    // Custom HTML legend below replaces Chart.js's clunky default.
    const total = d.by_category_actual.reduce((s, r) => s + r.total, 0);
    document.getElementById("donutCenter").textContent = fmt(total);
    const incomeEur = d.totals.income_eur || 0;
    const pctOfIncome = incomeEur > 0 ? Math.round((total / incomeEur) * 1000) / 10 : null;
    const subClr = pctOfIncome == null ? "text-outline" : pctOfIncome > 100 ? "text-error" : pctOfIncome > 85 ? "text-warn" : "text-primary";
    document.getElementById("donutSubtitle").textContent = pctOfIncome != null ? \`\${pctOfIncome}% del ingreso\` : "—";
    document.getElementById("donutSubtitle").className = "text-[11px] mt-1 " + subClr;

    const sorted = [...d.by_category_actual].sort((a, b) => b.total - a.total);
    const TOP_N = 7;
    const top = sorted.slice(0, TOP_N);
    const rest = sorted.slice(TOP_N);
    const restTotal = rest.reduce((s, r) => s + r.total, 0);
    const donutData = restTotal > 0
      ? [...top, { category: "otros", total: restTotal, _isOthers: true, _members: rest }]
      : top;
    // Cohesive palette: single hue family (slate-to-teal) for pro look
    const DONUT_PALETTE = ["#1e3a8a","#1e4d8b","#2e7d5c","#4a90c2","#7c3aed","#c2410c","#0891b2","#6b7280"];

    if (donutChart) donutChart.destroy();
    donutChart = new Chart(document.getElementById("donut").getContext("2d"), {
      type: "doughnut",
      data: {
        labels: donutData.map((r) => r.category),
        datasets: [{
          data: donutData.map((r) => r.total),
          backgroundColor: donutData.map((_, i) => DONUT_PALETTE[i % DONUT_PALETTE.length]),
          borderColor: "#ffffff", borderWidth: 2, hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "75%",
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(15,23,42,0.95)", padding: 10,
            callbacks: { label: (ctx) => \`\${ctx.label}: \${fmt(ctx.parsed)} (\${(ctx.parsed / total * 100).toFixed(1)}%)\` },
          },
        },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const r = donutData[elements[0].index];
          if (!r._isOthers) openCategoryDrill(r.category, d.period);
        },
      },
    });

    // Custom HTML legend (right side / below donut) — much cleaner than Chart.js default
    const legendEl = document.getElementById("donutLegend");
    legendEl.innerHTML = donutData.map((r, i) => {
      const pct = total > 0 ? Math.round(r.total / total * 100) : 0;
      const meta = CAT_META[r.category] || { emoji: "", label: r.category };
      const clr = DONUT_PALETTE[i % DONUT_PALETTE.length];
      const clickable = !r._isOthers;
      return \`<div class="flex items-center gap-2 \${clickable ? "cursor-pointer hover:bg-surface-container px-1 py-0.5 -mx-1 rounded" : ""}" \${clickable ? \`onclick="openCategoryDrill('\${r.category}','\${d.period}')"\` : ""}>
        <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style="background:\${clr}"></span>
        <span class="flex-1 truncate text-on-surface">\${meta.emoji} \${meta.label}</span>
        <span class="text-outline tabular-nums">\${pct}%</span>
        <span class="text-on-surface tabular-nums font-semibold">€\${fmt(r.total).replace("€","")}</span>
      </div>\`;
    }).join("");

    // ── VARIANCE: HTML progress bars (Linear/Notion style) ─────────────
    // Cleaner than Chart.js — no axis, no grid; bar inside a "ghost" track,
    // numbers prominent on the right.
    const variance = (d.category_rows || [])
      .filter((r) => r.budget_eur > 0)
      .sort((a, b) => b.budget_eur - a.budget_eur);

    const maxBudget = Math.max(1, ...variance.map((r) => Math.max(r.budget_eur, r.actual_eur)));
    const list = document.getElementById("varianceList");
    if (!variance.length) {
      list.innerHTML = \`<div class="text-xs text-outline italic p-3 text-center">No budgeted categories — add budgets in "Edit budget"</div>\`;
    } else {
      list.innerHTML = variance.map((r) => {
        const meta = CAT_META[r.category] || { emoji: "", label: r.category };
        const planPct   = Math.round((r.budget_eur / maxBudget) * 100);
        const actualPct = Math.round((r.actual_eur / maxBudget) * 100);
        const usedPct   = r.pct_used;
        const barClr = usedPct == null ? "#94a3b8" : usedPct > 100 ? "#dc2626" : usedPct > 80 ? "#d97706" : "#2e7d5c";
        const usedClr = usedPct == null ? "text-outline" : usedPct > 100 ? "text-error" : usedPct > 80 ? "text-warn" : "text-primary";
        return \`<div class="cursor-pointer hover:bg-surface-container-low rounded-lg px-2 py-1.5 -mx-2" onclick="openCategoryDrill('\${r.category}','\${d.period}')">
          <div class="flex items-baseline justify-between gap-3 mb-1">
            <span class="text-sm font-medium text-on-surface truncate">\${meta.emoji} \${meta.label}</span>
            <div class="flex items-baseline gap-2 text-xs tabular-nums">
              <span class="text-on-surface font-semibold">€\${fmt(r.actual_eur).replace("€","")}</span>
              <span class="text-outline">/ €\${fmt(r.budget_eur).replace("€","")}</span>
              <span class="\${usedClr} font-bold w-12 text-right">\${fmtPct(usedPct)}</span>
            </div>
          </div>
          <div class="relative h-2 rounded-full bg-surface-container overflow-hidden">
            <div class="absolute inset-y-0 left-0 rounded-full bg-outline-variant/30" style="width: \${planPct}%"></div>
            <div class="absolute inset-y-0 left-0 rounded-full transition-all" style="width: \${Math.min(actualPct, 100)}%; background: \${barClr}"></div>
          </div>
        </div>\`;
      }).join("");
    }

    // ── STACKED AREA: 6-month trend by category ────────────────────────
    const trendData = d.monthly_category_spend || [];
    const catTotals = {};
    for (const m of trendData) for (const [c, v] of Object.entries(m.categories)) catTotals[c] = (catTotals[c] || 0) + v;
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
    const labels  = trendData.map((m) => m.month);
    const trendCtx = document.getElementById("trendStack").getContext("2d");
    const datasets = topCats.map((cat, i) => {
      const color = PALETTE[i % PALETTE.length];
      return {
        label: cat,
        data: trendData.map((m) => m.categories[cat] || 0),
        backgroundColor: color + "aa",
        borderColor:     color,
        borderWidth: 1.5, fill: true, tension: 0.4,
        pointBackgroundColor: color, pointBorderColor: "#fff", pointBorderWidth: 1.5, pointHoverRadius: 5,
      };
    });
    const otherCats = Object.keys(catTotals).filter((c) => !topCats.includes(c));
    if (otherCats.length) {
      datasets.push({
        label: "Otros",
        data: trendData.map((m) => otherCats.reduce((s, c) => s + (m.categories[c] || 0), 0)),
        backgroundColor: "#9ca3af80", borderColor: "#9ca3af",
        borderWidth: 1.5, fill: true, tension: 0.4,
      });
    }

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(document.getElementById("trendStack").getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, padding: 8, font: FONT } },
          tooltip: { callbacks: { label: (ctx) => \`\${ctx.dataset.label}: \${fmt(ctx.parsed.y)}\` } },
        },
        scales: {
          x: { ticks: { font: FONT }, grid: { display: false } },
          y: { ticks: { font: FONT, callback: (v) => "€" + (v >= 1000 ? (v/1000).toFixed(1) + "k" : v) }, grid: { color: "#e5eeff" }, stacked: true, beginAtZero: true },
        },
      },
    });

    // ── CASH POSITION LINE ─────────────────────────────────────────────
    const cashData = d.bnp_balance_history || [];
    const cashLabels = cashData.map((r) => r.period);
    const closings = cashData.map((r) => r.closing_eur);
    let trend = "";
    if (cashData.length >= 2) {
      const first = closings[0], last = closings[closings.length - 1];
      const delta = last - first;
      const trendClr = delta >= 0 ? "text-primary" : "text-error";
      trend = \`<span class="\${trendClr}">\${delta >= 0 ? "↑" : "↓"} \${fmt(Math.abs(delta))} desde \${cashLabels[0]}</span>\`;
    }
    document.getElementById("cashTrend").innerHTML = trend;

    if (cashChart) cashChart.destroy();
    const cashCtx = document.getElementById("cashLine").getContext("2d");
    cashChart = new Chart(cashCtx, {
      type: "line",
      data: {
        labels: cashLabels,
        datasets: [{
          label: "Closing BNP",
          data: closings,
          borderColor: "#1e4d8b",
          backgroundColor: makeGradient(cashCtx, "#1e4d8b"),
          borderWidth: 2.5, fill: true, tension: 0.45,
          pointRadius: 0, pointHoverRadius: 6,
          pointBackgroundColor: "#1e4d8b", pointBorderColor: "#fff", pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => "Cierre " + fmt(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { font: FONT }, grid: { display: false } },
          y: { ticks: { font: FONT, callback: (v) => "€" + (v >= 1000 ? (v/1000).toFixed(1) + "k" : v) }, grid: { color: "#e5eeff" }, beginAtZero: false },
        },
      },
    });
  }

  load(initialPeriod);
</script>
</body></html>`;
}
