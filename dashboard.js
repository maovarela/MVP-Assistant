// dashboard.js
// Single-file HTML shell for the budget dashboard.
// Material 3 inspired layout: centerpiece luminous dial + horizontal scroll
// cards for fixed expenses + bento grid for insights + bottom nav. Tailwind
// via CDN, Inter + Space Grotesk fonts, Material Symbols icons, Chart.js for
// the breakdown views.

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
            // Material-3-ish palette tuned for finance (blue/green primary, red/amber for alerts)
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
            "tertiary": "#565e74",
            "tertiary-container": "#dae2fd",
            "error": "#ba1a1a",
            "error-container": "#ffdad6",
            "on-error": "#ffffff",
            "warn": "#a76900",
            "warn-container": "#ffddb8",
          },
          fontFamily: {
            "headline": ["Space Grotesk", "system-ui"],
            "body":     ["Inter", "system-ui"],
            "label":    ["Inter", "system-ui"],
          },
          borderRadius: { "DEFAULT": "0.25rem", "lg": "0.5rem", "xl": "0.75rem", "2xl": "1rem", "full": "9999px" },
        },
      },
    };
  </script>
  <style>
    .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; vertical-align: middle; }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    body { min-height: 100dvh; }
  </style>
</head><body class="bg-background text-on-background font-body antialiased min-h-screen pb-28">

<!-- Top bar: brand + period selector -->
<header class="sticky top-0 z-50 flex items-center justify-between px-6 py-4 bg-surface/80 backdrop-blur-md border-b border-outline-variant/20">
  <div class="flex items-center gap-3">
    <div class="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center">
      <span class="material-symbols-outlined text-on-primary-container">savings</span>
    </div>
    <div>
      <div class="font-headline font-bold text-lg tracking-tight text-on-surface leading-none">Cuentas MVP</div>
      <div class="text-[11px] text-outline mt-0.5" id="periodLabel">—</div>
    </div>
  </div>
  <select id="periodSel" class="bg-surface-container border-0 rounded-full text-sm font-medium text-on-surface px-4 py-2 focus:ring-2 focus:ring-primary"></select>
</header>

<main class="max-w-5xl mx-auto px-6 pt-8 space-y-10">

  <!-- Centerpiece dial -->
  <section class="flex flex-col items-center">
    <div class="relative w-72 h-72 md:w-80 md:h-80 flex items-center justify-center">
      <div class="absolute inset-0 rounded-full bg-primary/5 blur-3xl"></div>

      <!-- Outer ring: actual spent vs income -->
      <svg class="absolute w-full h-full -rotate-90 transform" viewBox="0 0 100 100">
        <circle class="text-surface-container" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor" stroke-width="6"/>
        <circle id="ringOuter" class="text-primary" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor"
                stroke-dasharray="282.7" stroke-dashoffset="282.7" stroke-linecap="round" stroke-width="6"/>
      </svg>

      <!-- Inner ring: planned (fixed + variable) vs income -->
      <svg class="absolute w-3/4 h-3/4 -rotate-90 transform" viewBox="0 0 100 100">
        <circle class="text-surface-container-high" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor" stroke-width="8"/>
        <circle id="ringInner" class="text-secondary" cx="50" cy="50" fill="transparent" r="45" stroke="currentColor"
                stroke-dasharray="282.7" stroke-dashoffset="282.7" stroke-linecap="round" stroke-width="8"/>
      </svg>

      <!-- Centre -->
      <div class="z-10 text-center">
        <div class="text-[11px] font-bold uppercase tracking-widest text-outline">Residual</div>
        <div class="font-headline text-5xl md:text-6xl font-bold text-on-surface tabular-nums" id="dialResidual">—</div>
        <div class="mt-2 flex items-center justify-center gap-1.5 text-outline text-sm">
          <span id="dialPctSpent">—</span> del ingreso
        </div>
      </div>
    </div>

    <!-- Asymmetric stats below -->
    <div class="grid grid-cols-2 gap-8 mt-10 w-full max-w-md">
      <div class="space-y-1">
        <span class="text-xs font-bold uppercase tracking-tighter text-outline">Ingresos</span>
        <div class="flex items-baseline gap-1">
          <span class="font-headline text-2xl font-bold text-on-surface tabular-nums" id="statIncome">—</span>
        </div>
      </div>
      <div class="space-y-1 text-right">
        <span class="text-xs font-bold uppercase tracking-tighter text-outline">Gasto real</span>
        <div class="flex items-baseline justify-end gap-1">
          <span class="font-headline text-2xl font-bold tabular-nums" id="statActual">—</span>
          <span class="material-symbols-outlined text-sm" id="statActualIcon"></span>
        </div>
        <div class="text-[11px] text-outline" id="statActualVsPlan">vs plan —</div>
      </div>
    </div>
  </section>

  <!-- Gastos fijos: horizontal scroll cards -->
  <section class="space-y-4">
    <div class="flex items-end justify-between px-2">
      <div>
        <h2 class="font-headline text-2xl font-bold tracking-tight text-on-surface">Gastos fijos</h2>
        <p class="text-sm text-outline" id="fixedSubtitle">— sistemas activos</p>
      </div>
      <button onclick="document.getElementById('detailsAll').scrollIntoView({behavior:'smooth'})" class="text-primary font-semibold text-sm hover:underline">Ver todo</button>
    </div>
    <div class="flex gap-4 overflow-x-auto no-scrollbar pb-4 snap-x" id="fixedCards">
      <div class="text-outline italic p-4">Cargando…</div>
    </div>
  </section>

  <!-- Bento insights -->
  <section class="grid grid-cols-1 md:grid-cols-3 gap-4" id="bento">
    <!-- big card (overspend insight) + small card (debt) injected dynamically -->
  </section>

  <!-- Variable expenses -->
  <section class="space-y-3" id="variableSection">
    <h2 class="font-headline text-xl font-bold tracking-tight text-on-surface px-2">Gastos variables</h2>
    <div class="rounded-2xl bg-surface-container-lowest p-2" id="variableList"></div>
  </section>

  <!-- Charts -->
  <section class="space-y-4">
    <h2 class="font-headline text-xl font-bold tracking-tight text-on-surface px-2">Breakdown</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="rounded-2xl bg-surface-container-lowest p-6">
        <div class="text-sm font-semibold text-on-surface mb-3">Gasto real por categoría</div>
        <canvas id="donut" style="max-height:280px"></canvas>
      </div>
      <div class="rounded-2xl bg-surface-container-lowest p-6">
        <div class="text-sm font-semibold text-on-surface mb-3">Budget vs real</div>
        <canvas id="bar" style="max-height:280px"></canvas>
      </div>
    </div>
  </section>

  <!-- Detail tables (anchor target for "Ver todo") -->
  <section class="space-y-4" id="detailsAll">
    <h2 class="font-headline text-xl font-bold tracking-tight text-on-surface px-2">Detalle gastos fijos</h2>
    <div class="rounded-2xl bg-surface-container-lowest overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-surface-container">
          <tr class="text-left text-[11px] uppercase tracking-wider text-outline">
            <th class="px-4 py-3">Concepto</th>
            <th class="px-4 py-3">Categoría</th>
            <th class="px-4 py-3 text-right">Budget</th>
            <th class="px-4 py-3 text-right">Real</th>
            <th class="px-4 py-3 text-right">%</th>
          </tr>
        </thead>
        <tbody id="fixedTbl"></tbody>
      </table>
    </div>
  </section>

  <!-- Debt + FX side by side -->
  <section class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="md:col-span-2 rounded-2xl bg-surface-container-lowest p-6">
      <h3 class="font-headline text-lg font-bold text-on-surface mb-3">Deuda</h3>
      <div class="overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-[11px] uppercase tracking-wider text-outline border-b border-outline-variant/30">
              <th class="px-2 py-2">Concepto</th>
              <th class="px-2 py-2">Tipo</th>
              <th class="px-2 py-2 text-right">Original</th>
              <th class="px-2 py-2 text-right">EUR</th>
            </tr>
          </thead>
          <tbody id="debtTbl"></tbody>
        </table>
      </div>
      <div class="mt-3 text-sm text-outline">Total deuda: <b class="text-on-surface tabular-nums" id="debtTotal">—</b></div>
    </div>
    <div class="rounded-2xl bg-secondary text-on-secondary p-6 flex flex-col justify-between">
      <div>
        <span class="material-symbols-outlined text-3xl">currency_exchange</span>
        <h3 class="font-headline text-lg font-bold mt-3">FOREX</h3>
      </div>
      <div class="space-y-1 mt-4 text-sm tabular-nums" id="forex">—</div>
    </div>
  </section>

</main>

<!-- Bottom nav -->
<nav class="fixed bottom-0 left-0 right-0 z-50 bg-surface/90 backdrop-blur-xl px-6 py-3 border-t border-outline-variant/20">
  <div class="max-w-md mx-auto flex items-center justify-between">
    <a class="flex flex-col items-center gap-1 text-primary" href="#">
      <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1;">dashboard</span>
      <span class="text-[10px] font-bold uppercase tracking-widest">Resumen</span>
    </a>
    <a class="flex flex-col items-center gap-1 text-outline hover:text-on-surface transition-colors" href="#detailsAll">
      <span class="material-symbols-outlined">view_list</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Detalle</span>
    </a>
    <a class="flex flex-col items-center gap-1 text-outline hover:text-on-surface transition-colors" href="#variableSection">
      <span class="material-symbols-outlined">payments</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Variable</span>
    </a>
    <a class="flex flex-col items-center gap-1 text-outline hover:text-on-surface transition-colors" href="#" onclick="window.location.reload();return false;">
      <span class="material-symbols-outlined">refresh</span>
      <span class="text-[10px] font-medium uppercase tracking-widest">Refrescar</span>
    </a>
  </div>
</nav>

<script>
  const key = new URLSearchParams(location.search).get("key");
  let initialPeriod = ${initialPeriod};
  let donutChart, barChart;

  const CIRCUM = 282.7;  // 2*PI*45

  // Map a category to a Material Symbol icon name.
  const ICON = {
    housing: "home", groceries: "shopping_cart", restaurants: "restaurant",
    transport: "commute", travel: "flight", subscriptions: "autorenew",
    shopping: "shopping_bag", health: "medical_services", entertainment: "theaters",
    transfers: "swap_horiz", income: "trending_up", fees: "percent",
    other: "category", uncategorised: "help",
  };

  const fmt = (n) => n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
  const fmtPct = (n) => n == null ? "—" : (Math.round(n * 10) / 10) + "%";
  const colorForPct = (p) => p == null ? "text-on-surface" : p > 100 ? "text-error" : p > 80 ? "text-warn" : "text-primary";
  const bgForPct    = (p) => p == null ? "bg-outline" : p > 100 ? "bg-error" : p > 80 ? "bg-warn" : "bg-primary";

  async function load(period) {
    const url = "/api/dashboard.json?key=" + encodeURIComponent(key) + (period ? "&period=" + period : "");
    const r = await fetch(url);
    if (!r.ok) { document.body.innerHTML = "<p class='p-8 text-error'>Error " + r.status + " — verifica el key</p>"; return; }
    render(await r.json());
  }

  function render(d) {
    document.getElementById("periodLabel").textContent = d.period;

    // Period selector
    const sel = document.getElementById("periodSel");
    sel.innerHTML = "";
    const periods = d.available_periods.length ? d.available_periods : [d.period];
    for (const p of periods) {
      const o = document.createElement("option"); o.value = p; o.textContent = p; if (p === d.period) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { history.replaceState(null, "", "?key=" + key + "&period=" + sel.value); load(sel.value); };

    // Dial
    const t = d.totals;
    const pctActual  = t.income_eur > 0 ? (t.actual_eur / t.income_eur) * 100 : 0;
    const pctPlanned = t.income_eur > 0 ? ((t.fixed_eur + t.variable_eur) / t.income_eur) * 100 : 0;
    document.getElementById("ringOuter").setAttribute("stroke-dashoffset", String(CIRCUM * (1 - Math.min(pctActual, 100) / 100)));
    document.getElementById("ringInner").setAttribute("stroke-dashoffset", String(CIRCUM * (1 - Math.min(pctPlanned, 100) / 100)));
    document.getElementById("ringOuter").className.baseVal = "transition-all duration-700 " + (pctActual > 100 ? "text-error" : pctActual > 80 ? "text-warn" : "text-primary");

    document.getElementById("dialResidual").textContent = fmt(t.residual_eur);
    document.getElementById("dialResidual").className   = "font-headline text-5xl md:text-6xl font-bold tabular-nums " + (t.residual_eur < 0 ? "text-error" : "text-on-surface");
    document.getElementById("dialPctSpent").textContent = fmtPct(t.pct_spent);

    // Asymmetric stats
    document.getElementById("statIncome").textContent = fmt(t.income_eur);
    document.getElementById("statActual").textContent = fmt(t.actual_eur);
    document.getElementById("statActual").className   = "font-headline text-2xl font-bold tabular-nums " + (t.actual_eur > t.fixed_eur + t.variable_eur ? "text-error" : "text-on-surface");
    const delta = t.actual_eur - (t.fixed_eur + t.variable_eur);
    document.getElementById("statActualVsPlan").textContent = "vs plan " + (delta >= 0 ? "+" : "") + fmt(delta);
    document.getElementById("statActualIcon").textContent  = delta > 0 ? "trending_up" : "trending_down";
    document.getElementById("statActualIcon").className     = "material-symbols-outlined text-sm " + (delta > 0 ? "text-error" : "text-primary");

    // Fixed expense cards (horizontal scroll)
    const cardsEl = document.getElementById("fixedCards");
    document.getElementById("fixedSubtitle").textContent = d.fixed.length + " conceptos planeados";
    cardsEl.innerHTML = d.fixed.length ? d.fixed.map((f) => {
      const icon = ICON[f.category] || ICON.other;
      const pct = f.pct_used;
      const barW = Math.min(pct || 0, 100);
      const ringClr = pct == null ? "text-outline" : pct > 100 ? "text-error" : pct > 80 ? "text-warn" : "text-primary";
      const barClr  = bgForPct(pct);
      return \`
        <div class="snap-start flex-shrink-0 w-56 p-5 rounded-xl bg-surface-container-low shadow-sm transition-all hover:bg-surface-container-high">
          <div class="flex justify-between items-start mb-6">
            <div class="p-2.5 rounded-lg bg-primary-container/40 \${ringClr}">
              <span class="material-symbols-outlined">\${icon}</span>
            </div>
            <span class="text-xs font-bold uppercase tracking-wider \${ringClr}">\${fmtPct(pct)}</span>
          </div>
          <h3 class="font-headline text-base font-bold text-on-surface truncate">\${f.label}</h3>
          <div class="text-[11px] uppercase tracking-wider text-outline mt-0.5">\${f.category || "—"}</div>
          <div class="mt-3 space-y-1.5">
            <div class="flex justify-between text-sm">
              <span class="text-outline">Real / Budget</span>
              <span class="font-headline font-bold text-on-surface tabular-nums">\${fmt(f.actual_eur)} / \${fmt(f.budget_eur)}</span>
            </div>
            <div class="w-full bg-surface-container-highest h-1.5 rounded-full overflow-hidden">
              <div class="\${barClr} h-full transition-all duration-500" style="width:\${barW}%"></div>
            </div>
          </div>
        </div>\`;
    }).join("") : \`<div class="text-outline italic p-4">Sin gastos fijos definidos para \${d.period}</div>\`;

    // Bento insights
    const worstOverspend = d.fixed
      .filter((f) => f.pct_used != null && f.pct_used > 100)
      .sort((a, b) => b.pct_used - a.pct_used)[0];
    const bigCard = worstOverspend ? \`
      <div class="md:col-span-2 p-7 rounded-2xl bg-error-container relative overflow-hidden group">
        <div class="relative z-10">
          <h4 class="font-headline text-xl font-bold text-on-surface">Categoría sobre presupuesto</h4>
          <p class="text-sm text-on-surface/70 mt-2 max-w-md">
            <b>\${worstOverspend.label}</b> está en <b>\${fmtPct(worstOverspend.pct_used)}</b> del budget
            (\${fmt(worstOverspend.actual_eur)} de \${fmt(worstOverspend.budget_eur)} planeados).
          </p>
          <button onclick="document.getElementById('detailsAll').scrollIntoView({behavior:'smooth'})"
                  class="mt-5 px-5 py-2 bg-error text-on-error font-semibold rounded-lg hover:opacity-90 transition-opacity text-sm">
            Ver detalle
          </button>
        </div>
        <div class="absolute right-0 bottom-0 opacity-10 group-hover:scale-110 transition-transform">
          <span class="material-symbols-outlined text-[160px] translate-x-10 translate-y-10">trending_up</span>
        </div>
      </div>\` : \`
      <div class="md:col-span-2 p-7 rounded-2xl bg-primary-container relative overflow-hidden group">
        <div class="relative z-10">
          <h4 class="font-headline text-xl font-bold text-on-primary-container">Bajo control</h4>
          <p class="text-sm text-on-primary-container/80 mt-2 max-w-md">
            Ningún gasto fijo está sobre presupuesto. Llevas <b>\${fmtPct(t.pct_spent)}</b> de tu ingreso gastado este mes.
          </p>
        </div>
        <div class="absolute right-0 bottom-0 opacity-10 group-hover:scale-110 transition-transform">
          <span class="material-symbols-outlined text-[160px] translate-x-10 translate-y-10">eco</span>
        </div>
      </div>\`;
    const debtCard = \`
      <div class="p-6 rounded-2xl bg-secondary text-on-secondary flex flex-col justify-between min-h-[180px]">
        <div>
          <span class="material-symbols-outlined text-3xl">account_balance</span>
          <h4 class="font-headline text-lg font-bold mt-3">Deuda total</h4>
        </div>
        <div>
          <div class="font-headline text-3xl font-bold tabular-nums">\${fmt(t.debt_total_eur)}</div>
          <div class="text-sm opacity-80 mt-1">\${d.debts.length} concepto\${d.debts.length === 1 ? "" : "s"}</div>
        </div>
      </div>\`;
    document.getElementById("bento").innerHTML = bigCard + debtCard;

    // Variable expenses
    const varList = document.getElementById("variableList");
    varList.innerHTML = d.variable.length ? d.variable.map((v) => \`
      <div class="flex items-center justify-between px-4 py-3 border-b border-outline-variant/20 last:border-0">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-lg bg-surface-container-high text-on-surface-variant">
            <span class="material-symbols-outlined text-base">\${ICON[v.category] || ICON.other}</span>
          </div>
          <div>
            <div class="text-sm font-semibold text-on-surface">\${v.label}</div>
            <div class="text-[11px] uppercase tracking-wider text-outline">\${v.category || "—"}</div>
          </div>
        </div>
        <div class="font-headline font-bold text-on-surface tabular-nums">\${fmt(v.amount_eur)}</div>
      </div>\`).join("") : \`<div class="px-4 py-6 text-outline italic">Sin gastos variables planeados</div>\`;

    // Fixed table (detail)
    document.getElementById("fixedTbl").innerHTML = d.fixed.length ? d.fixed.map((f) => {
      const pillClr = f.pct_used == null ? "bg-surface-container text-on-surface-variant" :
        f.pct_used > 100 ? "bg-error-container text-error" :
        f.pct_used > 80  ? "bg-warn-container text-warn"   : "bg-primary-container text-on-primary-container";
      return \`<tr class="border-b border-outline-variant/20 last:border-0">
        <td class="px-4 py-3 text-on-surface">\${f.label}</td>
        <td class="px-4 py-3 text-outline">\${f.category || "—"}</td>
        <td class="px-4 py-3 text-right tabular-nums">\${fmt(f.budget_eur)}</td>
        <td class="px-4 py-3 text-right tabular-nums">\${fmt(f.actual_eur)}</td>
        <td class="px-4 py-3 text-right"><span class="px-2 py-1 rounded-full text-[11px] font-semibold \${pillClr}">\${fmtPct(f.pct_used)}</span></td>
      </tr>\`;
    }).join("") : \`<tr><td colspan="5" class="px-4 py-6 text-outline italic">Sin gastos fijos para \${d.period}</td></tr>\`;

    // Donut: actuals by category
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
        cutout: "60%",
        responsive: true, maintainAspectRatio: false,
      },
    });

    // Bar: budget vs actual
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

    // Debt table
    document.getElementById("debtTbl").innerHTML = d.debts.length ? d.debts.map((x) => \`
      <tr class="border-b border-outline-variant/20 last:border-0">
        <td class="px-2 py-2 text-on-surface">\${x.label}</td>
        <td class="px-2 py-2 text-outline">\${x.kind || "—"}</td>
        <td class="px-2 py-2 text-right tabular-nums">\${new Intl.NumberFormat("es-ES").format(x.amount_src)} \${x.currency}</td>
        <td class="px-2 py-2 text-right tabular-nums font-semibold">\${fmt(x.amount_eur)}</td>
      </tr>\`).join("") : \`<tr><td colspan="4" class="px-2 py-4 text-outline italic">Sin deuda registrada</td></tr>\`;
    document.getElementById("debtTotal").textContent = fmt(t.debt_total_eur);

    // FX
    document.getElementById("forex").innerHTML = d.fx ? \`
      <div class="flex justify-between"><span class="opacity-80">USD-COP</span><b>\${d.fx.usd_cop}</b></div>
      <div class="flex justify-between"><span class="opacity-80">EUR-USD</span><b>\${d.fx.eur_usd}</b></div>
      <div class="flex justify-between"><span class="opacity-80">Tax FR</span><b>\${d.fx.tax_fr_pct}%</b></div>
      <div class="text-[10px] opacity-60 mt-2">source: \${d.fx.source}</div>\` : \`<div class="italic opacity-70">Sin rates</div>\`;
  }

  load(initialPeriod);
</script>
</body></html>`;
}
