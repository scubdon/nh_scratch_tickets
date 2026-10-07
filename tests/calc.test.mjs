// Numerical checks for site/calc.js.   node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Calc = require("../site/calc.js");

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// $10 ticket: 70% nothing, 20% $10, 9% $20, 1% $100.
const DIST = [
  { amount: 0, p: 0.7 },
  { amount: 10, p: 0.2 },
  { amount: 20, p: 0.09 },
  { amount: 100, p: 0.01 },
];

test("one ticket reproduces the single-ticket distribution", () => {
  const s = Calc.sessionStats(DIST, 10, 1);
  close(s.p_lose_all, 0.7);
  close(s.p_back, 0.3);
  close(s.p_ahead, 0.1);
  close(s.expected_payout, 0.2 * 10 + 0.09 * 20 + 1);
  assert.equal(s.median, 0);
});

test("two tickets match a hand enumeration", () => {
  const s = Calc.sessionStats(DIST, 10, 2); // spend $20
  let ahead = 0, back = 0, half = 0;
  for (const a of DIST) for (const b of DIST) {
    const t = a.amount + b.amount, p = a.p * b.p;
    if (t > 20) ahead += p;
    if (t >= 20) back += p;
    if (t <= 10) half += p;
  }
  close(s.p_ahead, ahead);
  close(s.p_back, back);
  close(s.p_lose_half, half);
  close(s.p_lose_all, 0.49);
});

test("many tickets: probabilities stay normalised and the mean is exact", () => {
  const s = Calc.sessionStats(DIST, 10, 50);
  assert.ok(s.p_ahead >= 0 && s.p_ahead <= 1);
  assert.ok(s.p_back >= s.p_ahead);
  close(s.expected_loss, 500 - 50 * 4.8, 1e-6);
});

test("payoutDistribution sums to one", () => {
  const g = { tickets_remaining: 1000, prizes: [{ prize: 100, remaining: 10 }, { prize: 10, remaining: 200 }, { prize: 50, remaining: 0 }] };
  const d = Calc.payoutDistribution(g);
  close(d.reduce((s, o) => s + o.p, 0), 1);
  assert.deepEqual(d.map((o) => o.amount), [0, 10, 100]);
});

test("seeded simulation is reproducible", () => {
  const a = Calc.sampler(DIST, Calc.rng(42));
  const b = Calc.sampler(DIST, Calc.rng(42));
  const xs = Array.from({ length: 50 }, a), ys = Array.from({ length: 50 }, b);
  assert.deepEqual(xs, ys);
  // and roughly right over many draws
  const draw = Calc.sampler(DIST, Calc.rng(7));
  let zero = 0;
  for (let i = 0; i < 20000; i++) if (draw() === 0) zero++;
  assert.ok(Math.abs(zero / 20000 - 0.7) < 0.02);
});

test("wording", () => {
  assert.equal(Calc.pct(0.17837), "17.8%");
  assert.equal(Calc.pct(0.0000025786), "0.00026%");
  assert.equal(Calc.oneIn(1 / 5.6), "1 in 5.6");
  assert.equal(Calc.oneIn(1 / 387801), "1 in 387,801");
  assert.equal(Calc.per100(0.178), "18 in 100");
  assert.equal(Calc.per100(0.0042), "1 in 238");
  assert.equal(Calc.freq(0.178).text, "about 18 out of every 100 tickets");
  assert.equal(Calc.freq(0.0042).short, "4.2 in 1,000");
  assert.equal(Calc.freq(1 / 387801).text, "1 in 387,801");
  assert.equal(Calc.freq(2.6e-6).short, "about 2.6 per million tickets");
  assert.deepEqual(Calc.shares100([0.654, 0.168, 0.178]), [65, 17, 18]);
  assert.equal(Calc.shares100([0.333, 0.333, 0.334]).reduce((a, b) => a + b), 100);
});

test("habit arithmetic", () => {
  const h = Calc.habit({ price: 20, perPeriod: 1, period: "week", years: 5, evRatio: 0.75 });
  assert.equal(h.spend_year, 1040);
  assert.equal(h.prizes_year, 780);
  assert.equal(h.loss_year, 260);
  assert.equal(h.spend_total, 5200);
  assert.equal(h.loss_total, 1300);
});
