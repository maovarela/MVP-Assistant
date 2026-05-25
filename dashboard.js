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
</head><body class="bg-background text-on-background font-body antialiased min-h-screen pb-24">

<!-- HEADER (compact, sticky) -->
<header class="sticky top-0 z-50 flex items-center justify-between px-4 py-3 bg-surface/85 backdrop-blur-md border-b border-outline-variant/20">
  <div class="flex items-center gap-2.5">
    <div class="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center">
      <span class="material-symbols-outlined text-on-primary-container" style="font-size:20px">savings</span>
    </div>
    <div class="font-headline font-bold text-base tracking-tight text-on-surface">Cuentas MVP</div>
  </div>

  <!-- Period picker: single button that opens a popover with year tabs + month grid -->
  <div class="relative">
    <button id="periodBtn" class="flex items-center gap-2 bg-primary-container text-on-primary-container rounded-full pl-4 pr-3 py-2 text-sm font-semibold hover:opacity-90 transition-opacity">
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
</header>

<main class="max-w-5xl mx-auto px-4 pt-4 space-y-4">

  <!-- ABOVE THE FOLD: dial + KPIs side-by-side on desktop, stacked on mobile -->
  <section class="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">

    <!-- Dial: 2/5 cols on desktop, full on mobile -->
    <div class="md:col-span-2 flex justify-center">
      <div class="relative w-52 h-52 md:w-56 md:h-56 flex items-center justify-center">
        <div class="absolute inset-0 rounded-full bg-primary/5 blur-3xl"></div>

        <svg class="absolute w-full h-full -rotate-90 transform" viewBox="0 0 100 100">
          <circle class="text-surface-container" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor" stroke-width="6"/>
          <circle id="ringOuter" class="text-primary" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor"
                  stroke-dasharray="282.7" stroke-dashoffset="282.7" stroke-linecap="round" stroke-width="6"/>
        </svg>
        <svg class="absolute w-3/4 h-3/4 -rotate-90 transform" viewBox="0 0 100 100">
          <circle class="text-surface-container-high" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor" stroke-width="8"/>
          <circle id="ringInner" class="text-secondary" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor"
                  stroke-dasharray="282.7" stroke-dashoffset="282.7" stroke-linecap="round" stroke-width="8"/>
        </svg>

        <div class="z-10 text-center">
          <div class="text-[10px] font-bold uppercase tracking-widest text-outline">Residual</div>
          <div class="font-headline text-4xl md:text-5xl font-bold text-on-surface tabular-nums leading-tight" id="dialResidual">—</div>
          <div class="mt-1 text-xs text-outline">
            <span id="dialPctSpent">—</span> del ingreso
          </div>
        </div>
      </div>
    </div>

    <!-- KPI cards: 3/5 cols on desktop, full on mobile. Always 2x2 grid. -->
    <div class="md:col-span-3 grid grid-cols-2 gap-3">
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Ingresos</div>
        <div class="font-headline text-xl font-bold text-on-surface tabular-nums mt-1" id="kpiIncome">—</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Gasto real</div>
        <div class="font-headline text-xl font-bold tabular-nums mt-1" id="kpiActual">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiActualVsPlan">vs plan —</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">Planeado total</div>
        <div class="font-headline text-xl font-bold text-on-surface tabular-nums mt-1" id="kpiPlanned">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiPlannedBreak">F — · V —</div>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-4 border border-outline-variant/15">
        <div class="text-[10px] font-bold uppercase tracking-wider text-outline">% gastado</div>
        <div class="font-headline text-xl font-bold tabular-nums mt-1" id="kpiPct">—</div>
        <div class="text-[10px] text-outline mt-0.5" id="kpiPctSub"></div>
      </div>
    </div>
  </section>

  <!-- Insight strip (1-line, auto-picks the highest-signal message) -->
  <section id="insight" class="rounded-2xl p-4 flex items-center gap-3 border border-outline-variant/15">
    <!-- populated by JS -->
  </section>

  <!-- ═══════════════════ BELOW THE FOLD ═══════════════════ -->

  <!-- COMBINED GASTOS TABLE with filter chips -->
  <section class="space-y-3">
    <div class="flex items-center justify-between px-1">
      <h2 class="font-headline text-lg font-bold tracking-tight text-on-surface">Gastos</h2>
      <div class="flex items-center gap-2" id="filterChips">
        <!-- populated by JS -->
      </div>
    </div>
    <div class="rounded-2xl bg-surface-container-lowest overflow-hidden border border-outline-variant/15">
      <table class="w-full text-sm">
        <thead class="bg-surface-container">
          <tr class="text-left text-[10px] uppercase tracking-wider text-outline">
            <th class="px-3 py-2.5 w-16">Tipo</th>
            <th class="px-3 py-2.5">Concepto</th>
            <th class="px-3 py-2.5">Categoría</th>
            <th class="px-3 py-2.5 text-right">Budget</th>
            <th class="px-3 py-2.5 text-right">Real</th>
            <th class="px-3 py-2.5 text-right w-16">%</th>
          </tr>
        </thead>
        <tbody id="gastosTbl"></tbody>
      </table>
    </div>
  </section>

  <!-- CHARTS -->
  <section class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
      <div class="text-sm font-semibold text-on-surface mb-2">Gasto real por categoría</div>
      <canvas id="donut" style="max-height:260px"></canvas>
    </div>
    <div class="rounded-2xl bg-surface-container-lowest p-5 border border-outline-variant/15">
      <div class="text-sm font-semibold text-on-surface mb-2">Budget vs real</div>
      <canvas id="bar" style="max-height:260px"></canvas>
    </div>
  </section>

</main>

<!-- BOTTOM NAV -->
<nav class="fixed bottom-0 left-0 right-0 z-50 bg-surface/90 backdrop-blur-xl px-6 py-2.5 border-t border-outline-variant/20">
  <div class="max-w-md mx-auto flex items-center justify-between">
    <a class="flex flex-col items-center gap-0.5 text-primary" href="#">
      <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1; font-size: 22px;">dashboard</span>
      <span class="text-[10px] font-bold uppercase tracking-widest">Resumen</span>
    </a>
    <a class="flex flex-col items-center gap-0.5 text-outline hover:text-on-surface transition-colors" href="#gastosTbl">
      <span class="material-symbols-outlined" style="font-size: 22px;">view_list</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Detalle</span>
    </a>
    <a class="flex flex-col items-center gap-0.5 text-outline hover:text-on-surface transition-colors" href="#donut">
      <span class="material-symbols-outlined" style="font-size: 22px;">pie_chart</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Charts</span>
    </a>
    <a class="flex flex-col items-center gap-0.5 text-outline hover:text-on-surface transition-colors" href="#" onclick="window.location.reload();return false;">
      <span class="material-symbols-outlined" style="font-size: 22px;">refresh</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Refrescar</span>
    </a>
  </div>
</nav>

<script>
  const key = new URLSearchParams(location.search).get("key");
  const urlPeriod = new URLSearchParams(location.search).get("period");
  let initialPeriod = urlPeriod || ${initialPeriod};
  let donutChart, barChart;
  let currentData = null;
  let activeFilter = "fijos"; // 'fijos' | 'variables' | 'todos'

  const CIRCUM = 282.7;

  const MONTH_NAMES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const MONTH_LONG  = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

  const ICON = {
    housing: "home", groceries: "shopping_cart", restaurants: "restaurant",
    transport: "commute", travel: "flight", subscriptions: "autorenew",
    shopping: "shopping_bag", health: "medical_services", entertainment: "theaters",
    transfers: "swap_horiz", income: "trending_up", fees: "percent",
    other: "category", uncategorised: "help",
  };

  const fmt = (n) => n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n) => n == null ? "—" : (Math.round(n * 10) / 10) + "%";

  async function load(period) {
    const url = "/api/dashboard.json?key=" + encodeURIComponent(key) + (period ? "&period=" + period : "");
    const r = await fetch(url);
    if (!r.ok) { document.body.innerHTML = "<p class='p-8 text-error'>Error " + r.status + "</p>"; return; }
    currentData = await r.json();
    render(currentData);
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

    const t = d.totals;
    const planned = t.fixed_eur + t.variable_eur;

    // Dial rings
    const pctActual  = t.income_eur > 0 ? (t.actual_eur / t.income_eur) * 100 : 0;
    const pctPlanned = t.income_eur > 0 ? (planned       / t.income_eur) * 100 : 0;
    document.getElementById("ringOuter").setAttribute("stroke-dashoffset", String(CIRCUM * (1 - Math.min(pctActual, 100) / 100)));
    document.getElementById("ringInner").setAttribute("stroke-dashoffset", String(CIRCUM * (1 - Math.min(pctPlanned, 100) / 100)));
    document.getElementById("ringOuter").className.baseVal = "transition-all duration-700 " + (pctActual > 100 ? "text-error" : pctActual > 80 ? "text-warn" : "text-primary");

    document.getElementById("dialResidual").textContent = fmt(t.residual_eur);
    document.getElementById("dialResidual").className   = "font-headline text-4xl md:text-5xl font-bold tabular-nums leading-tight " + (t.residual_eur < 0 ? "text-error" : "text-on-surface");
    document.getElementById("dialPctSpent").textContent = fmtPct(t.pct_spent);

    // KPI cards
    document.getElementById("kpiIncome").textContent = fmt(t.income_eur);
    document.getElementById("kpiActual").textContent = fmt(t.actual_eur);
    document.getElementById("kpiActual").className = "font-headline text-xl font-bold tabular-nums mt-1 " + (t.actual_eur > planned ? "text-error" : "text-on-surface");
    const delta = t.actual_eur - planned;
    document.getElementById("kpiActualVsPlan").textContent = "vs plan " + (delta >= 0 ? "+" : "") + fmt(delta);
    document.getElementById("kpiPlanned").textContent = fmt(planned);
    document.getElementById("kpiPlannedBreak").textContent = "F " + fmt(t.fixed_eur) + " · V " + fmt(t.variable_eur);
    document.getElementById("kpiPct").textContent = fmtPct(t.pct_spent);
    document.getElementById("kpiPct").className = "font-headline text-xl font-bold tabular-nums mt-1 " + (t.pct_spent == null ? "text-on-surface" : t.pct_spent > 95 ? "text-error" : t.pct_spent > 80 ? "text-warn" : "text-primary");
    document.getElementById("kpiPctSub").textContent = t.pct_spent == null ? "—" : t.pct_spent <= 80 ? "Cómodo" : t.pct_spent <= 95 ? "Atención" : "Sobre presupuesto";

    // Insight strip
    const worstOverspend = d.fixed
      .filter((f) => f.pct_used != null && f.pct_used > 100)
      .sort((a, b) => b.pct_used - a.pct_used)[0];
    const insight = document.getElementById("insight");
    if (worstOverspend) {
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-error/20 bg-error-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-error">priority_high</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-surface text-sm">
            \${worstOverspend.label} al \${fmtPct(worstOverspend.pct_used)}
          </div>
          <div class="text-xs text-on-surface/70">
            Real \${fmt(worstOverspend.actual_eur)} de \${fmt(worstOverspend.budget_eur)} planeados.
          </div>
        </div>\`;
    } else if (t.pct_spent != null && t.pct_spent > 80) {
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-warn/20 bg-warn-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-warn">trending_up</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-surface text-sm">Cerca del límite</div>
          <div class="text-xs text-on-surface/70">Llevas \${fmtPct(t.pct_spent)} del ingreso gastado este mes.</div>
        </div>\`;
    } else {
      insight.className = "rounded-2xl p-4 flex items-center gap-3 border border-primary/20 bg-primary-container";
      insight.innerHTML = \`
        <span class="material-symbols-outlined text-primary">eco</span>
        <div class="flex-1">
          <div class="font-headline font-bold text-on-primary-container text-sm">Bajo control</div>
          <div class="text-xs text-on-primary-container/80">
            Ningún gasto fijo sobre presupuesto. \${t.pct_spent != null ? fmtPct(t.pct_spent) + " gastado." : ""}
          </div>
        </div>\`;
    }

    // Combined table + filter chips
    const fijos = d.fixed.map((f) => ({
      type: "fijo", label: f.label, category: f.category,
      budget_eur: f.budget_eur, actual_eur: f.actual_eur, pct_used: f.pct_used,
    }));
    const variables = d.variable.map((v) => ({
      type: "variable", label: v.label, category: v.category,
      budget_eur: v.amount_eur, actual_eur: null, pct_used: null,
    }));
    const fijosTotal = fijos.reduce((s, r) => s + r.budget_eur, 0);
    const varTotal   = variables.reduce((s, r) => s + r.budget_eur, 0);

    const chipsEl = document.getElementById("filterChips");
    function chip(name, label, count, total, active) {
      return \`<button data-filter="\${name}" class="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors \${active ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface hover:bg-surface-container-high"}">
        \${label} <span class="opacity-70 ml-1">\${count} · \${fmt(total)}</span>
      </button>\`;
    }
    chipsEl.innerHTML = [
      chip("fijos",     "Fijos",     fijos.length,     fijosTotal, activeFilter === "fijos"),
      chip("variables", "Variables", variables.length, varTotal,   activeFilter === "variables"),
      chip("todos",     "Todos",     fijos.length + variables.length, fijosTotal + varTotal, activeFilter === "todos"),
    ].join("");
    chipsEl.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { activeFilter = b.dataset.filter; render(currentData); };
    });

    const filtered = activeFilter === "fijos" ? fijos : activeFilter === "variables" ? variables : [...fijos, ...variables];
    const tbl = document.getElementById("gastosTbl");
    if (!filtered.length) {
      tbl.innerHTML = \`<tr><td colspan="6" class="px-3 py-8 text-outline italic text-center">Sin gastos en \${activeFilter} para \${d.period}</td></tr>\`;
    } else {
      tbl.innerHTML = filtered.map((r) => {
        const typeBadge = r.type === "fijo"
          ? \`<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary-container text-on-primary-container">Fijo</span>\`
          : \`<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-secondary-container text-on-surface">Var</span>\`;
        const pctClr = r.pct_used == null ? "bg-surface-container text-on-surface-variant" :
                       r.pct_used > 100 ? "bg-error-container text-error" :
                       r.pct_used > 80  ? "bg-warn-container text-warn"   : "bg-primary-container text-on-primary-container";
        const real = r.type === "fijo" ? fmt(r.actual_eur) : "—";
        const pct  = r.type === "fijo" ? \`<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold \${pctClr}">\${fmtPct(r.pct_used)}</span>\` : \`<span class="text-outline">—</span>\`;
        return \`<tr class="border-b border-outline-variant/15 last:border-0">
          <td class="px-3 py-2.5">\${typeBadge}</td>
          <td class="px-3 py-2.5 text-on-surface font-medium">\${r.label}</td>
          <td class="px-3 py-2.5"><span class="inline-flex items-center gap-1 text-outline"><span class="material-symbols-outlined" style="font-size: 14px">\${ICON[r.category] || ICON.other}</span>\${r.category || "—"}</span></td>
          <td class="px-3 py-2.5 text-right tabular-nums">\${fmt(r.budget_eur)}</td>
          <td class="px-3 py-2.5 text-right tabular-nums">\${real}</td>
          <td class="px-3 py-2.5 text-right">\${pct}</td>
        </tr>\`;
      }).join("");
    }

    // Donut
    if (donutChart) donutChart.destroy();
    donutChart = new Chart(document.getElementById("donut").getContext("2d"), {
      type: "doughnut",
      data: {
        labels: d.by_category_actual.map((r) => r.category),
        datasets: [{
          data: d.by_category_actual.map((r) => r.total),
          backgroundColor: ["#006d32","#0059bb","#a76900","#ba1a1a","#565e74","#30e375","#0070ea","#d29922","#bc8cff","#ec775c","#3fb950"],
          borderColor: "#ffffff", borderWidth: 2,
        }],
      },
      options: {
        plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11, family: "Inter" } } } },
        cutout: "60%", responsive: true, maintainAspectRatio: false,
      },
    });

    // Bar
    if (barChart) barChart.destroy();
    const cats = Array.from(new Set([...d.by_category_actual.map((r) => r.category), ...d.by_category_budget.map((r) => r.category)]));
    const actualByCat = Object.fromEntries(d.by_category_actual.map((r) => [r.category, r.total]));
    const budgetByCat = Object.fromEntries(d.by_category_budget.map((r) => [r.category, r.total]));
    barChart = new Chart(document.getElementById("bar").getContext("2d"), {
      type: "bar",
      data: {
        labels: cats,
        datasets: [
          { label: "Budget", data: cats.map((c) => budgetByCat[c] || 0), backgroundColor: "#0059bb", borderRadius: 4 },
          { label: "Real",   data: cats.map((c) => actualByCat[c] || 0), backgroundColor: "#006d32", borderRadius: 4 },
        ],
      },
      options: {
        plugins: { legend: { labels: { font: { size: 11, family: "Inter" } } } },
        scales: {
          x: { ticks: { font: { size: 10, family: "Inter" } }, grid: { display: false } },
          y: { ticks: { font: { size: 10, family: "Inter" } }, grid: { color: "#e5eeff" }, beginAtZero: true },
        },
        responsive: true, maintainAspectRatio: false,
      },
    });
  }

  load(initialPeriod);
</script>
</body></html>`;
}
