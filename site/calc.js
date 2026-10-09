/* NH scratch ticket odds — pure arithmetic and number wording, no DOM.
   Loaded as a plain script in the browser (globals under `Calc`) and as a CommonJS
   module by the tests in tests/calc.test.mjs. */

(function (root) {
  "use strict";

  /* ---------------- number wording ----------------
     The site leads with natural frequencies ("about 18 out of every 100 tickets")
     and keeps the percentage and "1 in N" forms as secondary text. */

  const commas = (n) => Math.round(n).toLocaleString("en-US");
  const trimZeros = (s) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

  /* 17.8%, 4.6%, 0.42%, 0.00026% — two significant figures once below 1%. */
  function pct(p) {
    if (p == null || !isFinite(p)) return "—";
    if (p <= 0) return "0%";
    const x = p * 100;
    if (x >= 99.95 && x < 100) return ">99.9%";
    if (x >= 1) return x.toFixed(1) + "%";
    const digits = Math.min(8, 1 - Math.floor(Math.log10(x)));
    return trimZeros(x.toFixed(digits)) + "%";
  }

  /* "1 in 5.6", "1 in 239", "1 in 387,801" */
  function oneIn(p) {
    if (p == null || !isFinite(p) || p <= 0) return "—";
    const n = 1 / p;
    if (n < 10) return "1 in " + trimZeros(n.toFixed(1));
    return "1 in " + commas(n);
  }

  /* Count out of a fixed denominator, e.g. per100(0.178) -> "18". */
  function countOf(p, d) {
    const k = p * d;
    if (k >= 10) return commas(k);
    if (k >= 0.95) return trimZeros(k.toFixed(1));
    return trimZeros(k.toFixed(2));
  }

  /* Same-denominator form for comparisons: "18 in 100", or "1 in N" when rarer than 1 in 100. */
  function per100(p) {
    if (p == null || !isFinite(p)) return "—";
    if (p <= 0) return "none";
    if (p >= 0.01) return countOf(p, 100) + " in 100";
    return oneIn(p);
  }

  /* Natural-frequency headline, choosing a denominator that keeps the count readable.
     Returns {text, short}. */
  function freq(p) {
    if (p == null || !isFinite(p)) return { text: "—", short: "—" };
    if (p <= 0) return { text: "none of the remaining tickets", short: "none" };
    if (p >= 0.995) return { text: "virtually every ticket", short: "~100 in 100" };
    if (p >= 0.001) {
      for (const d of [100, 1000, 10000]) {
        if (p * d >= 1.5 || d === 10000) {
          const k = countOf(p, d);
          return { text: `about ${k} out of every ${commas(d)} tickets`, short: `${k} in ${commas(d)}` };
        }
      }
    }
    const perMillion = p * 1e6;
    const pm = perMillion >= 10 ? commas(perMillion) : trimZeros(perMillion.toPrecision(2));
    return { text: oneIn(p), short: `about ${pm} per million tickets` };
  }

  /* Whole-number shares of 100 that add up to exactly 100 (largest remainder). */
  function shares100(ps) {
    const raw = ps.map((p) => Math.max(0, p) * 100);
    const base = raw.map(Math.floor);
    let left = 100 - base.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
    for (let j = 0; j < order.length && left > 0; j++, left--) base[order[j][1]]++;
    return base;
  }

  /* ---------------- big wins ----------------
     Ticket spending per win of a given size: the price divided by the chance one ticket
     pays that much. Buying 1/p tickets yields one such win on average — roughly a 2-in-3
     chance of at least one, not a certainty. null when no such prize is left. */
  function costPerWin(price, p) {
    return p > 0 && price > 0 ? price / p : null;
  }

  /* How long a dollar amount lasts at a steady weekly spend: "6 weeks", "7 months",
     "3.4 years", "766 years". */
  function habitSpan(amount, perWeek) {
    if (amount == null || !isFinite(amount) || !(perWeek > 0)) return "—";
    const weeks = amount / perWeek;
    const plural = (k, unit) => `${k} ${unit}${k === "1" ? "" : "s"}`;
    if (weeks < 9) return plural(String(Math.max(1, Math.round(weeks))), "week");
    const months = (weeks * 12) / 52;
    if (months < 24) return plural(String(Math.round(months)), "month");
    const years = weeks / 52;
    if (years < 10) return plural(trimZeros(years.toFixed(1)), "year");
    return plural(commas(years), "year");
  }

  /* ---------------- one-ticket distribution ---------------- */

  /* [{amount, p}] for a single ticket bought now, $0 included, smallest amount first. */
  function payoutDistribution(game) {
    const T = game.tickets_remaining;
    const outs = game.prizes.filter((x) => x.remaining > 0).map((x) => ({ amount: x.prize, p: x.remaining / T }));
    const pAny = outs.reduce((s, o) => s + o.p, 0);
    outs.push({ amount: 0, p: Math.max(0, 1 - pAny) });
    return outs.sort((a, b) => a.amount - b.amount);
  }

  /* ---------------- many tickets ----------------
     The payout from n tickets is the sum of n independent draws from the one-ticket
     distribution. (The pool holds hundreds of thousands of tickets, so drawing a few
     hundred barely changes it; independence is a good approximation.) We convolve the
     distribution exactly on a grid of dollar amounts, but only up to the amount spent:
     everything above that is pooled into one "came out ahead" bucket, which is all the
     questions below need. */

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return Math.abs(a);
  }

  const MAX_WORK = 2.5e8;

  function sessionStats(dist, price, n) {
    if (!(n >= 1)) return null;
    const cents = (x) => Math.round(x * 100);
    const spend = n * price;
    let unit = cents(price);
    dist.forEach((o) => { if (o.amount > 0) unit = gcd(unit, cents(o.amount)); });
    const S = Math.round(cents(spend) / unit); // grid index of "exactly the amount spent"
    const cap = S + 1; // grid index of "more than the amount spent"
    const steps = dist.filter((o) => o.p > 0).map((o) => ({ k: Math.round(cents(o.amount) / unit), p: o.p }));
    if (n * (cap + 1) * steps.length > MAX_WORK) return null;

    let cur = new Float64Array(cap + 1);
    cur[0] = 1;
    let reach = 0; // highest index with any probability so far
    const maxK = Math.max(...steps.map((s) => s.k));
    for (let i = 0; i < n; i++) {
      const next = new Float64Array(cap + 1);
      for (let v = 0; v <= reach; v++) {
        const pv = cur[v];
        if (pv === 0) continue;
        for (const s of steps) {
          const j = v === cap ? cap : Math.min(cap, v + s.k);
          next[j] += pv * s.p;
        }
      }
      reach = Math.min(cap, reach + maxK);
      cur = next;
    }

    const halfIdx = Math.floor(cents(spend) / 2 / unit);
    let pHalf = 0;
    for (let v = 0; v <= halfIdx; v++) pHalf += cur[v];
    const quantile = (q) => {
      let c = 0;
      for (let v = 0; v <= cap; v++) {
        c += cur[v];
        if (c >= q - 1e-12) return v === cap ? null : (v * unit) / 100; // null = more than spent
      }
      return null;
    };
    const ev = dist.reduce((s, o) => s + o.amount * o.p, 0);
    return {
      n,
      spend,
      expected_payout: n * ev,
      expected_loss: spend - n * ev,
      p_ahead: cur[cap],
      p_back: cur[S] + cur[cap],
      p_lose_half: pHalf, // got back half or less
      p_lose_all: cur[0],
      median: quantile(0.5),
      p10: quantile(0.1),
      p90: quantile(0.9),
    };
  }

  /* ---------------- simulation ---------------- */

  /* Small, fast, seedable PRNG (mulberry32) so a given seed always replays the same tickets. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampler(dist, rand) {
    const sorted = [...dist].sort((a, b) => b.p - a.p); // common outcomes first: fewer comparisons
    return function () {
      let u = rand();
      for (const o of sorted) {
        if ((u -= o.p) < 0) return o.amount;
      }
      return sorted[0].amount;
    };
  }

  /* ---------------- regular spending ---------------- */

  function habit({ price, perPeriod, period, years, evRatio }) {
    const perYear = period === "week" ? 52 : 12;
    const spendYear = price * perPeriod * perYear;
    return {
      tickets_per_year: perPeriod * perYear,
      spend_year: spendYear,
      prizes_year: spendYear * evRatio,
      loss_year: spendYear * (1 - evRatio),
      spend_total: spendYear * years,
      prizes_total: spendYear * years * evRatio,
      loss_total: spendYear * years * (1 - evRatio),
    };
  }

  const api = { pct, oneIn, per100, freq, countOf, shares100, commas, costPerWin, habitSpan, payoutDistribution, sessionStats, rng, sampler, habit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
