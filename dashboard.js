// dashboard.js
// Single-file HTML shell for the budget dashboard. Mobile-first, dark theme.
// Pulls all data from GET /api/dashboard.json — no server-side templating.

export function renderDashboard(period) {
  const initialPeriod = period ? `"${period}"` : "null";
  return `<!doctype html>
<html lang="es"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cuentas MVP</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0e1116; --bg2: #161b22; --bg3: #1f242c;
      --fg: #e6edf3; --fg2: #9da7b3; --fg3: #6b7480;
      --accent: #4f8cff; --good: #3fb950; --bad: #f85149; --warn: #d29922;
      --border: #2d333b;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif;
           background: var(--bg); color: var(--fg); padding: 12px; padding-bottom: 60px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    h1 { font-size: 18px; margin: 0; font-weight: 600; }
    h2 { font-size: 13px; margin: 0 0 8px; color: var(--fg2); text-transform: uppercase; letter-spacing: .5px; font-weight: 500; }
    select { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font: inherit; }
    section { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
    .card .l { color: var(--fg3); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
    .card .v { font-size: 20px; font-weight: 600; margin-top: 4px; }
    .card .d { font-size: 11px; margin-top: 2px; color: var(--fg2); }
    .v.good { color: var(--good); } .v.bad { color: var(--bad); } .v.warn { color: var(--warn); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--fg3); font-weight: 500; font-size: 11px; text-transform: uppercase; padding: 6px 6px 8px; border-bottom: 1px solid var(--border); }
    td { padding: 8px 6px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .bar { height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; margin-top: 4px; }
    .bar > div { height: 100%; background: var(--accent); transition: width .3s; }
    .bar > div.over { background: var(--bad); }
    .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
    .pill.good { background: rgba(63,185,80,.15); color: var(--good); }
    .pill.bad  { background: rgba(248,81,73,.15); color: var(--bad); }
    .pill.warn { background: rgba(210,153,34,.15); color: var(--warn); }
    .charts { display: grid; gap: 12px; }
    .charts canvas { max-height: 260px; }
    .empty { color: var(--fg3); font-style: italic; padding: 8px 0; }
    ul.var { list-style: none; margin: 0; padding: 0; }
    ul.var li { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); }
    ul.var li:last-child { border-bottom: none; }
    .forex { display: flex; gap: 16px; flex-wrap: wrap; color: var(--fg2); }
    .forex b { color: var(--fg); }
    @media (min-width: 720px) {
      body { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .cards { grid-template-columns: repeat(4, 1fr); }
      .charts { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head><body>
  <header>
    <h1>Cuentas MVP <span id="periodLabel" style="color:var(--fg3);font-weight:400;"></span></h1>
    <select id="periodSel"></select>
  </header>

  <section><div class="cards" id="kpis"></div></section>

  <section>
    <h2>Gastos fijos (planeado vs real)</h2>
    <table id="fixedTbl"><thead>
      <tr><th>Concepto</th><th>Categoría</th><th class="num">Budget</th><th class="num">Actual</th><th class="num">%</th></tr>
    </thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Gastos variables (planeados)</h2>
    <ul class="var" id="variableList"></ul>
  </section>

  <section>
    <h2>Charts</h2>
    <div class="charts">
      <canvas id="donut"></canvas>
      <canvas id="bar"></canvas>
    </div>
  </section>

  <section>
    <h2>Deuda</h2>
    <table id="debtTbl"><thead>
      <tr><th>Concepto</th><th>Tipo</th><th class="num">Original</th><th class="num">EUR</th></tr>
    </thead><tbody></tbody></table>
    <p style="margin:10px 0 0; color: var(--fg2);">Total deuda: <b id="debtTotal">—</b></p>
  </section>

  <section>
    <h2>FOREX</h2>
    <div class="forex" id="forex"></div>
  </section>

  <script>
    const key = new URLSearchParams(location.search).get("key");
    let initialPeriod = ${initialPeriod};
    let donutChart, barChart;

    const fmt = (n) => n == null ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
    const fmtPct = (n) => n == null ? "—" : (Math.round(n * 10) / 10) + "%";

    async function load(period) {
      const url = "/api/dashboard.json?key=" + encodeURIComponent(key) + (period ? "&period=" + period : "");
      const r = await fetch(url);
      if (!r.ok) { document.body.innerHTML = "<p style='color:#f85149'>Error " + r.status + " — check the key</p>"; return; }
      const d = await r.json();
      render(d);
    }

    function render(d) {
      document.getElementById("periodLabel").textContent = "· " + d.period;

      const sel = document.getElementById("periodSel");
      sel.innerHTML = "";
      const periods = d.available_periods.length ? d.available_periods : [d.period];
      for (const p of periods) {
        const opt = document.createElement("option");
        opt.value = p; opt.textContent = p; if (p === d.period) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => { history.replaceState(null, "", "?key=" + key + "&period=" + sel.value); load(sel.value); };

      // KPI cards
      const t = d.totals;
      const residualClass = t.residual_eur >= 0 ? "good" : "bad";
      const pctClass = t.pct_spent == null ? "" : (t.pct_spent > 95 ? "bad" : t.pct_spent > 80 ? "warn" : "good");
      const actVsPlanDelta = t.actual_eur - (t.fixed_eur + t.variable_eur);
      document.getElementById("kpis").innerHTML = [
        \`<div class="card"><div class="l">Ingresos</div><div class="v">\${fmt(t.income_eur)}</div></div>\`,
        \`<div class="card"><div class="l">Planeado</div><div class="v">\${fmt(t.fixed_eur + t.variable_eur)}</div><div class="d">Fijos \${fmt(t.fixed_eur)} · Var \${fmt(t.variable_eur)}</div></div>\`,
        \`<div class="card"><div class="l">Gasto real</div><div class="v">\${fmt(t.actual_eur)}</div><div class="d">vs plan \${actVsPlanDelta >= 0 ? "+" : ""}\${fmt(actVsPlanDelta)}</div></div>\`,
        \`<div class="card"><div class="l">Residual / % gastado</div><div class="v \${residualClass}">\${fmt(t.residual_eur)}</div><div class="d \${pctClass}">\${fmtPct(t.pct_spent)} del ingreso</div></div>\`,
      ].join("");

      // Fixed expenses table
      const fixedBody = document.querySelector("#fixedTbl tbody");
      fixedBody.innerHTML = d.fixed.length ? d.fixed.map((f) => {
        const overPct = Math.min(f.pct_used || 0, 200);
        const pillClass = f.pct_used == null ? "" : f.pct_used > 100 ? "bad" : f.pct_used > 80 ? "warn" : "good";
        return \`<tr>
          <td>\${f.label}<div class="bar"><div class="\${f.pct_used > 100 ? 'over' : ''}" style="width:\${Math.min(overPct, 100)}%"></div></div></td>
          <td>\${f.category || "<span class='empty'>—</span>"}</td>
          <td class="num">\${fmt(f.budget_eur)}</td>
          <td class="num">\${fmt(f.actual_eur)}</td>
          <td class="num"><span class="pill \${pillClass}">\${fmtPct(f.pct_used)}</span></td>
        </tr>\`;
      }).join("") : \`<tr><td colspan="5" class="empty">Sin gastos fijos definidos para \${d.period}</td></tr>\`;

      // Variable list
      const varList = document.getElementById("variableList");
      varList.innerHTML = d.variable.length ? d.variable.map((v) =>
        \`<li><span>\${v.label} <span style="color:var(--fg3)">· \${v.category || "—"}</span></span><span>\${fmt(v.amount_eur)}</span></li>\`
      ).join("") : \`<li class="empty">Sin gastos variables planeados</li>\`;

      // Donut: actuals by category
      if (donutChart) donutChart.destroy();
      const donutCtx = document.getElementById("donut").getContext("2d");
      donutChart = new Chart(donutCtx, {
        type: "doughnut",
        data: {
          labels: d.by_category_actual.map((r) => r.category),
          datasets: [{
            data: d.by_category_actual.map((r) => r.total),
            backgroundColor: ["#4f8cff","#f85149","#3fb950","#d29922","#a371f7","#1f6feb","#db61a2","#8b949e","#bc8cff","#39d353","#ec775c"],
            borderColor: "#161b22", borderWidth: 2,
          }],
        },
        options: {
          plugins: {
            title: { display: true, text: "Gastos reales por categoría", color: "#e6edf3", font: { size: 13 } },
            legend: { position: "right", labels: { color: "#e6edf3", boxWidth: 12, font: { size: 11 } } },
          },
          responsive: true,
        },
      });

      // Bar: budget vs actual per category
      if (barChart) barChart.destroy();
      const cats = Array.from(new Set([...d.by_category_actual.map((r) => r.category), ...d.by_category_budget.map((r) => r.category)]));
      const actualByCat = Object.fromEntries(d.by_category_actual.map((r) => [r.category, r.total]));
      const budgetByCat = Object.fromEntries(d.by_category_budget.map((r) => [r.category, r.total]));
      const barCtx = document.getElementById("bar").getContext("2d");
      barChart = new Chart(barCtx, {
        type: "bar",
        data: {
          labels: cats,
          datasets: [
            { label: "Budget",  data: cats.map((c) => budgetByCat[c] || 0), backgroundColor: "#4f8cff88", borderColor: "#4f8cff", borderWidth: 1 },
            { label: "Actual",  data: cats.map((c) => actualByCat[c] || 0), backgroundColor: "#f8514988", borderColor: "#f85149", borderWidth: 1 },
          ],
        },
        options: {
          plugins: {
            title: { display: true, text: "Budget vs real", color: "#e6edf3", font: { size: 13 } },
            legend: { labels: { color: "#e6edf3", font: { size: 11 } } },
          },
          scales: {
            x: { ticks: { color: "#9da7b3", font: { size: 10 } }, grid: { color: "#2d333b" } },
            y: { ticks: { color: "#9da7b3", font: { size: 10 } }, grid: { color: "#2d333b" } },
          },
          responsive: true,
        },
      });

      // Debt table
      const debtBody = document.querySelector("#debtTbl tbody");
      debtBody.innerHTML = d.debts.length ? d.debts.map((x) =>
        \`<tr><td>\${x.label}</td><td>\${x.kind || "—"}</td><td class="num">\${new Intl.NumberFormat("es-ES").format(x.amount_src)} \${x.currency}</td><td class="num">\${fmt(x.amount_eur)}</td></tr>\`
      ).join("") : \`<tr><td colspan="4" class="empty">Sin deuda registrada</td></tr>\`;
      document.getElementById("debtTotal").textContent = fmt(t.debt_total_eur);

      // FOREX
      const fxEl = document.getElementById("forex");
      if (d.fx) {
        fxEl.innerHTML = \`
          <div>USD-COP: <b>\${d.fx.usd_cop}</b></div>
          <div>EUR-USD: <b>\${d.fx.eur_usd}</b></div>
          <div>Tax FR: <b>\${d.fx.tax_fr_pct}%</b></div>
          <div style="color:var(--fg3)">source: \${d.fx.source}</div>
        \`;
      } else {
        fxEl.innerHTML = \`<span class="empty">Sin rates para este periodo</span>\`;
      }
    }

    load(initialPeriod);
  </script>
</body></html>`;
}
