// fx.js
// Free FX rate provider for the budget dashboard.
// Two providers, no API keys, both return JSON shape compatible with our use.
//
// Why two: exchangerate.host occasionally returns null rates on edge dates;
// open.er-api.com is a community fallback. First success wins.

const PRIMARY  = "https://api.exchangerate.host/latest?base=EUR&symbols=USD,COP";
const FALLBACK = "https://open.er-api.com/v6/latest/EUR";

/** Returns { usd_cop, eur_usd, source, fetched_at } or throws. */
export async function fetchLatestRates() {
  try {
    const r = await fetch(PRIMARY, { headers: { "accept": "application/json" } });
    if (r.ok) {
      const d = await r.json();
      const eur_usd = d?.rates?.USD;
      const eur_cop = d?.rates?.COP;
      if (eur_usd && eur_cop) {
        return {
          eur_usd:    Math.round(eur_usd * 10000) / 10000,
          usd_cop:    Math.round((eur_cop / eur_usd) * 100) / 100,
          source:     "exchangerate-host",
          fetched_at: new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn(`[fx] exchangerate.host failed: ${err.message}`);
  }

  // Fallback
  try {
    const r = await fetch(FALLBACK, { headers: { "accept": "application/json" } });
    if (r.ok) {
      const d = await r.json();
      const eur_usd = d?.rates?.USD;
      const eur_cop = d?.rates?.COP;
      if (eur_usd && eur_cop) {
        return {
          eur_usd:    Math.round(eur_usd * 10000) / 10000,
          usd_cop:    Math.round((eur_cop / eur_usd) * 100) / 100,
          source:     "open-er-api",
          fetched_at: new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn(`[fx] open.er-api.com failed: ${err.message}`);
  }

  throw new Error("All FX providers failed");
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Fetch + store current month's FX in the DB, unless a manual row exists. */
export async function refreshCurrentMonthFx(setFxRate) {
  const period = currentPeriod();
  const rates  = await fetchLatestRates();
  const stored = setFxRate(period, {
    usd_cop:    rates.usd_cop,
    eur_usd:    rates.eur_usd,
    tax_fr_pct: 0,
    source:     rates.source,
  });
  console.log(`[fx] ${period} usd_cop=${stored.usd_cop} eur_usd=${stored.eur_usd} source=${stored.source}`);
  return stored;
}
