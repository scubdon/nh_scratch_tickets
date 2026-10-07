/* NH Scratch Ticket Odds — front end. Vanilla JS, no build step.
   Reads data.json (built daily by scraper/scrape.py; every statistic is computed
   there, see scraper/metrics.py) and data/history.json (scraper/build_history.py).
   Pages are hash routes so the site stays a static GitHub Pages deploy:
     #/  #/game  #/game/1692  #/compare?g=1692,1658  #/calculator  #/learn  #/methods */
"use strict";

const { pct, oneIn, per100, freq, shares100, commas } = Calc;

const S = {
  data: null,
  games: [],
  byId: new Map(),
  history: null,
  historyPromise: null,
  lastPath: null,
  home: { price: "all", search: "", top: "all", stage: "all", profit: "all", loss: "all", sort: "loss", dir: 1, view: "rel" },
  picker: { search: "", price: "all" },
  compare: loadCompare(),
  explorer: "profit",
  spend: {},          // per-game amount typed into "If I spend…"
  calc: { id: null, mode: "budget", amount: 100, tickets: 10 },
  sim: { id: null, seed: null, runs: [], last: null },
  habit: { id: null, per: 1, period: "week", years: 5 },
};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const app = $("#app");

/* ---------------- formatting ---------------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money0 = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "−$" : "$") + commas(Math.abs(n)));
const money2 = (n) =>
  n == null || !isFinite(n) ? "—" : (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyAuto = (n) => (Math.abs(n) < 1000 ? money2(n) : money0(n));
const moneyBig = (n) => {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1).replace(/\.0$/, "") + " billion";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + " million";
  return money0(n);
};
const prizeShort = (n) => {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e4) return "$" + Math.round(n / 1e3) + "K";
  return money0(n);
};
const cents = (r) => (r == null ? "—" : (r * 100).toFixed(1) + "¢");
const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
function apDate(d) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(d);
  const get = (t) => +parts.find((p) => p.type === t).value;
  return `${AP_MONTHS[get("month") - 1]} ${get("day")}, ${get("year")}`;
}
function apDay(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return `${AP_MONTHS[m - 1]} ${d}, ${y}`;
}
const shortDay = (iso) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${AP_MONTHS[m - 1].replace(".", "")} ${d}`;
};

function qHelp(html, label = "What does this mean?") {
  return `<details class="q"><summary aria-label="${esc(label)}">?</summary><div>${html}</div></details>`;
}

const ESTIMATE_HELP =
  "New Hampshire publishes prizes remaining but not the number of unsold tickets. Tickets remaining are estimated from prize-claim rates, so current odds should be treated as estimates rather than exact values.";
const EV_HELP =
  "Expected value describes the average over enormous numbers of tickets. It is not a prediction of what a typical player will receive.";

/* ---------------- game preparation ---------------- */
function prep(g) {
  g.id = String(g.game_number || g.identifier);
  g.m = g.metrics.live;
  g.mp = g.metrics.printed;
  g.topGone = g.m.top_left === 0;
  g.sold = 1 - g.percent_unsold / 100;
  g.stage = g.sold < 0.25 ? "new" : g.sold > 0.75 ? "late" : "mid";
  g.search = (g.name + " " + g.game_number).toLowerCase();
  g.dist = Calc.payoutDistribution(g);
  g.seg = segments(g.m);
  g.three = shares100([g.m.p_loss, g.m.p_break_even, g.m.p_profit]);
}

/* The one semantic split used everywhere. */
function segments(m) {
  const p2 = m.p_multiple["2x"] ?? 0, p10 = m.p_multiple["10x"] ?? 0;
  return [
    { k: "none", cls: "o-none", label: "No prize", p: m.p_none },
    { k: "below", cls: "o-below", label: "Less than the ticket price back", p: m.p_below_cost },
    { k: "be", cls: "o-be", label: "Break even (ticket price back)", p: m.p_break_even },
    { k: "p1", cls: "o-p1", label: "Profit, under 2× the price", p: m.p_profit - p2 },
    { k: "p2", cls: "o-p2", label: "2× to under 10× the price", p: p2 - p10 },
    { k: "p3", cls: "o-p3", label: "10× the price or more", p: p10 },
  ];
}
const threeSegs = (m) => [
  { cls: "o-none", label: "Lose money", p: m.p_loss },
  { cls: "o-be", label: "Break even", p: m.p_break_even },
  { cls: "o-profit", label: "Make money", p: m.p_profit },
];

function strip(segs, { size = "", aria = "", labels = true } = {}) {
  return (
    `<div class="strip ${size}" role="img" aria-label="${esc(aria)}">` +
    segs
      .filter((s) => s.p > 1e-9)
      .map((s) => {
        const w = s.p * 100;
        const lab = labels && w >= 7 ? Math.round(w) : "";
        return `<span class="${s.cls}" style="width:${w.toFixed(3)}%" title="${esc(s.label)}: ${pct(s.p)}">${lab}</span>`;
      })
      .join("") +
    `</div>`
  );
}

function outcomeSentence(g) {
  const [l, b, p] = g.three;
  const lose = g.m.p_below_cost > 0 ? `${l} return less than the ticket price (most of them nothing)` : `${l} receive no prize`;
  return `Of an estimated 100 tickets, approximately ${lose}, ${b} return the ticket price, and ${p} return more than the ticket price.`;
}

function legendHtml() {
  const anyBelow = S.games.some((g) => g.m.p_below_cost > 0);
  const items = segments(S.games[0].m).filter((s) => s.k !== "below" || anyBelow);
  return `<ul class="legend" aria-label="Key">${items.map((s) => `<li><i class="sw ${s.cls}"></i>${esc(s.label)}</li>`).join("")}</ul>`;
}

function freshness() {
  const src = new Date(S.data.prizes_last_updated || S.data.generated_at);
  const days = Math.floor((Date.now() - src) / 864e5);
  return (
    `<div class="fresh"><span>Prize data updated <strong>${apDate(src)}</strong></span>` +
    `<span>Current figures are estimates${qHelp(ESTIMATE_HELP)}</span></div>` +
    (days >= 2 ? `<p class="notice">Latest available NH Lottery data is ${days} days old.</p>` : "")
  );
}

/* ---------------- tooltip ---------------- */
const tip = $("#tip");
let tipOwner = null;
function showTip(html, x, y, owner) {
  tip.innerHTML = html;
  tip.classList.add("show");
  tipOwner = owner || null;
  const pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
  let tx = x + pad, ty = y + pad;
  if (tx + w > innerWidth - 8) tx = Math.max(8, x - w - pad);
  if (ty + h > innerHeight - 8) ty = Math.max(8, y - h - pad);
  tip.style.left = tx + "px";
  tip.style.top = ty + "px";
}
function hideTip() {
  tip.classList.remove("show");
  tipOwner = null;
}
/* Hover, keyboard focus and tap all reveal the tooltip; a second tap (or click/Enter) follows `href`. */
function tipOn(node, html, href) {
  let lastPointer = "mouse";
  node.addEventListener("pointerdown", (e) => (lastPointer = e.pointerType));
  node.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY, node));
  node.addEventListener("mouseleave", hideTip);
  node.addEventListener("focus", () => {
    const r = node.getBoundingClientRect();
    showTip(html, r.right, r.top, node);
  });
  node.addEventListener("blur", hideTip);
  node.addEventListener("click", (e) => {
    if (lastPointer === "touch" && tipOwner !== node) {
      showTip(html, e.clientX, e.clientY, node);
      return;
    }
    if (href) location.hash = href;
  });
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && href) location.hash = href;
  });
}
document.addEventListener("pointerdown", (e) => {
  if (tipOwner && !tipOwner.contains(e.target)) hideTip();
});

/* ---------------- compare selection ---------------- */
function loadCompare() {
  try {
    return JSON.parse(localStorage.getItem("compare") || "[]").slice(0, 3);
  } catch {
    return [];
  }
}
function saveCompare() {
  try {
    localStorage.setItem("compare", JSON.stringify(S.compare));
  } catch { /* private mode: selection lasts for this visit only */ }
}
function toggleCompare(id) {
  const i = S.compare.indexOf(id);
  if (i >= 0) S.compare.splice(i, 1);
  else {
    if (S.compare.length >= 3) S.compare.shift();
    S.compare.push(id);
  }
  saveCompare();
  renderTray();
  $$(`[data-cmp]`).forEach((b) => b.setAttribute("aria-pressed", S.compare.includes(b.dataset.cmp)));
}
const cmpButton = (g, cls = "btn tiny") =>
  `<button type="button" class="${cls}" data-cmp="${esc(g.id)}" aria-pressed="${S.compare.includes(g.id)}" aria-label="Add ${esc(g.name)} to comparison">Compare</button>`;
function wireCompareButtons(root = app) {
  $$("[data-cmp]", root).forEach((b) => b.addEventListener("click", () => toggleCompare(b.dataset.cmp)));
}
function renderTray() {
  const tray = $("#tray");
  const games = S.compare.map((id) => S.byId.get(id)).filter(Boolean);
  const onCompare = parseHash().path === "/compare";
  if (!games.length || onCompare) {
    tray.hidden = true;
    document.body.classList.remove("has-tray");
    return;
  }
  tray.hidden = false;
  document.body.classList.add("has-tray");
  tray.innerHTML =
    `<div class="wrap"><span class="count"><strong>${games.length} game${games.length > 1 ? "s" : ""}</strong> selected to compare</span><span class="names"><strong>Compare:</strong> ${games.map((g) => esc(g.name) + ` ($${g.price})`).join(" · ")}` +
    (games.length < 2 ? ` <span class="muted">— pick at least one more</span>` : "") + `</span>` +
    `<a class="btn primary" href="#/compare?g=${games.map((g) => g.id).join(",")}">Compare ${games.length}</a>` +
    `<button type="button" class="btn" id="tray-clear">Clear</button></div>`;
  $("#tray-clear").addEventListener("click", () => {
    S.compare = [];
    saveCompare();
    renderTray();
    $$(`[data-cmp]`).forEach((b) => b.setAttribute("aria-pressed", "false"));
  });
}

/* ---------------- routing ---------------- */
const ROUTES = [
  [/^\/?$/, renderHome, "home"],
  [/^\/game\/([^/]+)$/, renderGame, "game"],
  [/^\/game\/?$/, renderPicker, "game"],
  [/^\/compare$/, renderCompare, "home"],
  [/^\/calculator$/, renderCalculator, "calculator"],
  [/^\/learn$/, renderLearn, "learn"],
  [/^\/(methods|data)$/, renderMethods, "methods"],
];

function parseHash() {
  let h = location.hash.replace(/^#/, "");
  if (h === "table" || h === "figures") h = "/"; // links to the old single-page site
  if (h === "methods") h = "/methods";
  const [path, qs] = h.split("?");
  return { path: path || "/", q: new URLSearchParams(qs || "") };
}

function route() {
  const { path, q } = parseHash();
  hideTip();
  const samePage = path === S.lastPath;
  for (const [re, fn, nav] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    $$(".nav a").forEach((a) => (a.dataset.nav === nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    fn(m, q);
    renderTray();
    if (!samePage) {
      scrollTo(0, 0);
      if (S.lastPath !== null) app.focus({ preventScroll: true });
    }
    const target = q.get("s") && document.getElementById(q.get("s"));
    if (target && !samePage) target.scrollIntoView();
    S.lastPath = path;
    return;
  }
  setTitle("Page not found");
  app.innerHTML = `<div class="wrap"><h1 class="page-title">Page not found</h1><p><a href="#/">Back to all games</a></p></div>`;
  S.lastPath = path;
}

function setTitle(t) {
  document.title = t ? `${t} · NH Scratch Ticket Odds` : "NH Scratch Ticket Odds";
}

/* ---------------- init ---------------- */
init();

async function init() {
  let data;
  try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    app.innerHTML = `<div class="wrap"><p class="status">The data file could not be loaded. Try again later.</p></div>`;
    return;
  }
  S.data = data;
  S.games = (data.games || []).filter((g) => g.prizes && g.prizes.length && g.metrics && g.metrics.live);
  S.games.forEach(prep);
  S.games.forEach((g) => S.byId.set(g.id, g));
  S.compare = S.compare.filter((id) => S.byId.has(id));
  const gen = new Date(data.generated_at);
  $("#foot-asof").textContent =
    `Prize data from the New Hampshire Lottery, updated ${apDate(new Date(data.prizes_last_updated || data.generated_at))}; ` +
    `retrieved ${gen.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })} ET.`;
  $(".skip").addEventListener("click", (e) => {
    e.preventDefault();
    app.focus();
  });
  addEventListener("hashchange", route);
  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      $$("[data-redraw]").forEach((el) => el._redraw && el._redraw());
    }, 150);
  });
  route();
}

function loadHistory() {
  if (!S.historyPromise) {
    S.historyPromise = fetch("data/history.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((h) => (S.history = h));
  }
  return S.historyPromise;
}

const exampleGame = () =>
  S.byId.get("1692") || [...S.games].filter((g) => !g.topGone).sort((a, b) => b.price - a.price)[0] || S.games[0];

/* ====================================================================== */
/* HOME                                                                   */
/* ====================================================================== */
const SORTS = {
  loss: { label: "Expected loss per $100", key: (g) => g.m.loss_per_100, dir: 1 },
  price: { label: "Ticket price", key: (g) => g.price, dir: -1 },
  profit: { label: "Chance of profit", key: (g) => g.m.p_profit, dir: -1 },
  double: { label: "Chance of doubling money", key: (g) => g.m.p_multiple["2x"] ?? 0, dir: -1 },
  p100: { label: "Chance of $100+", key: (g) => g.m.p_at_least["100"], dir: -1 },
  top: { label: "Top-prize odds", key: (g) => g.m.p_top || null, dir: -1 },
  newest: { label: "Newest game", key: (g) => g.on_sale || "", dir: -1 },
  name: { label: "Name", key: (g) => g.name.toLowerCase(), dir: 1 },
};
/* extra keys reachable only by clicking a table heading */
const COL_SORTS = {
  none: { key: (g) => g.m.p_none, dir: 1 },
  be: { key: (g) => g.m.p_break_even, dir: -1 },
  m5: { key: (g) => g.m.p_multiple["5x"] ?? 0, dir: -1 },
  m10: { key: (g) => g.m.p_multiple["10x"] ?? 0, dir: -1 },
  any: { key: (g) => g.m.p_any, dir: -1 },
  a50: { key: (g) => g.m.p_at_least["50"], dir: -1 },
  a500: { key: (g) => g.m.p_at_least["500"], dir: -1 },
  a1000: { key: (g) => g.m.p_at_least["1000"], dir: -1 },
  a10000: { key: (g) => g.m.p_at_least["10000"], dir: -1 },
  ev: { key: (g) => g.m.ev_ticket, dir: -1 },
};
const sortDef = (k) => SORTS[k] || COL_SORTS[k];

const PROFIT_RANGES = { all: null, lo: [0, 0.1], mid: [0.1, 0.15], hi: [0.15, 1] };
const LOSS_RANGES = { all: null, lo: [0, 20], mid: [20, 30], hi: [30, 101] };

function visibleGames() {
  const h = S.home;
  const def = sortDef(h.sort) || SORTS.loss;
  const bad = (v) => v == null || v === "" || (typeof v === "number" && !isFinite(v));
  const inR = (v, r) => !r || (v >= r[0] && v < r[1]);
  return S.games
    .filter((g) => h.price === "all" || String(g.price) === h.price)
    .filter((g) => !h.search || g.search.includes(h.search))
    .filter((g) => h.top === "all" || (h.top === "yes" ? !g.topGone : g.topGone))
    .filter((g) => h.stage === "all" || g.stage === h.stage)
    .filter((g) => inR(g.m.p_profit, PROFIT_RANGES[h.profit]))
    .filter((g) => inR(g.m.loss_per_100, LOSS_RANGES[h.loss]))
    .sort((a, b) => {
      const x = def.key(a), y = def.key(b);
      if (bad(x) && bad(y)) return 0;
      if (bad(x)) return 1;
      if (bad(y)) return -1;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return c * h.dir || b.price - a.price || a.name.localeCompare(b.name);
    });
}

function introExample(g) {
  const [l, b, p] = g.three;
  const loseTxt = g.m.p_below_cost > 0 ? "lose money" : `lose $${g.price}`;
  return (
    `<p class="small">Example from today's data: ${esc(g.name)}</p>` +
    `<h3>Buy one $${g.price} ticket</h3>` +
    strip(threeSegs(g.m), { size: "lg", aria: outcomeSentence(g) }) +
    `<ul class="legend">` +
    `<li><i class="sw o-none"></i><span><strong>${l} of 100</strong> — ${loseTxt}</span></li>` +
    `<li><i class="sw o-be"></i><span><strong>${b} of 100</strong> — get $${g.price} back</span></li>` +
    `<li><i class="sw o-profit"></i><span><strong>${p} of 100</strong> — finish ahead</span></li></ul>` +
    `<p style="margin-top:10px"><strong>Average payout:</strong> ${money2(g.m.ev_ticket)} · <strong>Average loss:</strong> ${money2(g.m.expected_loss)} per ticket</p>` +
    (g.overall_odds
      ? `<p class="small">The lottery's printed “overall odds” for this game, 1 in ${g.overall_odds.toFixed(2)}, count every prize as a win — including the ${b} in 100 tickets that only pay back the $${g.price} they cost.</p>`
      : "")
  );
}

function controlsHtml() {
  const h = S.home;
  const prices = [...new Set(S.games.map((g) => g.price))].sort((a, b) => a - b);
  const opt = (v, label, cur) => `<option value="${v}"${cur === v ? " selected" : ""}>${label}</option>`;
  return (
    `<div class="controls">` +
    `<div class="ctl"><span class="ctl-label" id="price-l">Ticket price</span><div class="seg" id="f-price" role="group" aria-labelledby="price-l">` +
    [`all`, ...prices].map((p) => `<button type="button" data-p="${p}" aria-pressed="${h.price === String(p)}">${p === "all" ? "All" : "$" + p}</button>`).join("") +
    `</div></div>` +
    `<div class="ctl grow"><label class="ctl-label" for="f-search">Search</label><input id="f-search" type="search" placeholder="Game name or number" autocomplete="off" value="${esc(h.search)}" /></div>` +
    `<div class="ctl"><label class="ctl-label" for="f-sort">Sort by</label><select id="f-sort">` +
    Object.entries(SORTS).map(([k, s]) => opt(k, s.label, h.sort)).join("") +
    (SORTS[h.sort] ? "" : `<option value="${h.sort}" selected>Table column</option>`) +
    `</select></div>` +
    `<details class="more"${h.top !== "all" || h.stage !== "all" || h.profit !== "all" || h.loss !== "all" ? " open" : ""}><summary>More filters</summary><div class="controls-inner">` +
    `<div class="ctl"><label class="ctl-label" for="f-top">Top prize</label><select id="f-top">${opt("all", "All games", h.top)}${opt("yes", "Top prize still available", h.top)}${opt("no", "Top prize no longer available", h.top)}</select></div>` +
    `<div class="ctl"><label class="ctl-label" for="f-stage">Game age (est. share sold)</label><select id="f-stage">${opt("all", "All", h.stage)}${opt("new", "New — under 25% sold", h.stage)}${opt("mid", "Established", h.stage)}${opt("late", "Nearing end — over 75% sold", h.stage)}</select></div>` +
    `<div class="ctl"><label class="ctl-label" for="f-profit">Chance of profit</label><select id="f-profit">${opt("all", "Any", h.profit)}${opt("lo", "Under 10 in 100", h.profit)}${opt("mid", "10 to 15 in 100", h.profit)}${opt("hi", "Over 15 in 100", h.profit)}</select></div>` +
    `<div class="ctl"><label class="ctl-label" for="f-loss">Expected loss per $100</label><select id="f-loss">${opt("all", "Any", h.loss)}${opt("lo", "Under $20", h.loss)}${opt("mid", "$20 to $30", h.loss)}${opt("hi", "Over $30", h.loss)}</select></div>` +
    `</div></details>` +
    `</div><p class="small" id="f-count" aria-live="polite"></p>`
  );
}

function renderHome() {
  setTitle(null);
  const ex = exampleGame();
  app.innerHTML =
    `<div class="wrap">` +
    `<section class="block intro" aria-labelledby="intro-h"><div>` +
    `<h1 class="page-title" id="intro-h">“Winning” can mean several different things</h1>` +
    `<p style="margin-top:12px">Lottery odds generally count any prize as a win — including a prize equal to the ticket's purchase price.</p>` +
    `<p>This site separates outcomes into:</p>` +
    `<div class="trio"><span><i class="sw o-none"></i>Lose money</span><span><i class="sw o-be"></i>Break even</span><span><i class="sw o-profit"></i>Make money</span></div>` +
    `</div><div class="eg callout">${introExample(ex)}</div></section>` +
    freshness() +
    `<section aria-label="Find games">${controlsHtml()}</section>` +
    `<section class="block" aria-labelledby="o-h"><h2 id="o-h">What happens to a single ticket?</h2>` +
    `<p class="lede">Each bar is one game, divided into what happens to 100 tickets bought today. The gray part of every bar is tickets that lose money or only break even.</p>` +
    legendHtml() + `<ol class="orows" id="orows" style="margin-top:12px"></ol></section>` +
    `<section class="block" aria-labelledby="t-h"><h2 id="t-h">The numbers</h2>` +
    `<p class="lede">Exact figures for every game. Chances are shown relative to the ticket price by default, since a $100 prize is 100× a $1 ticket but only 3.3× a $30 one.</p>` +
    `<div class="seg" id="t-view" role="group" aria-label="Prize thresholds" style="margin-bottom:12px">` +
    `<button type="button" data-v="rel" aria-pressed="${S.home.view === "rel"}">Relative to ticket price</button>` +
    `<button type="button" data-v="abs" aria-pressed="${S.home.view === "abs"}">Dollar amounts</button></div>` +
    `<div class="table-scroll cards"><table class="gt" id="gt"></table></div></section>` +
    `<section class="block" aria-labelledby="m-h"><h2 id="m-h">How much of $100 is expected to come back?${qHelp("The share that does not come back is sometimes called the “house edge”: the part of ticket sales the lottery keeps for prizes not paid, costs and state revenue.")}</h2>` +
    `<p class="lede">Average prize money returned for every $100 spent on each game, at today's estimated odds. ${esc(EV_HELP)}</p>` +
    `<div class="legend" style="margin-bottom:10px"><span><i class="sw" style="background:var(--return)"></i> Expected back</span><span><i class="sw" style="background:var(--lost)"></i> Expected loss</span></div>` +
    `<ol class="mrows" id="mrows"></ol></section>` +
    `<section class="block" aria-labelledby="s-h"><h2 id="s-h">How the games compare</h2>` +
    `<p class="lede">Each dot is a game: how often one ticket makes a profit (left to right) against how much is expected to be lost per $100 (bottom to top). Larger dots are pricier tickets. Dashed lines mark the median game. Tap or hover a dot for details.</p>` +
    `<div class="chart" id="scatter" data-redraw></div><p class="sr-only" id="scatter-sum"></p></section>` +
    `<section class="block" aria-labelledby="ob-h"><h2 id="ob-h">Things the numbers show</h2><p class="lede">How current games differ, across all ${S.games.length} games on sale.</p>${observations()}</section>` +
    `<section class="block" aria-labelledby="e-h"><h2 id="e-h">About “estimated current odds”</h2>` +
    `<p class="lede">${ESTIMATE_HELP} An unclaimed prize might also be on a ticket that has been bought but not yet scratched or cashed. <a href="#/methods">How the estimates work</a>.</p></section>` +
    `<section class="block" aria-label="More"><div class="links">` +
    `<a href="#/calculator"><strong>Spending calculator</strong><span>What $100, or a weekly habit, is likely to return.</span></a>` +
    `<a href="#/learn"><strong>How the odds work</strong><span>What “1 in 4” and “expected payout” really mean.</span></a>` +
    `<a href="#/methods"><strong>Data &amp; methods</strong><span>Formulas, limitations and data checks.</span></a>` +
    `<a href="#/methods?s=downloads"><strong>Downloads &amp; history</strong><span>Every figure as CSV or JSON, plus daily snapshots.</span></a>` +
    `</div></section></div>`;
  wireHome();
  drawHome();
}

function wireHome() {
  const h = S.home;
  $("#f-price").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    h.price = b.dataset.p;
    $$("#f-price button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawHome();
  });
  $("#f-search").addEventListener("input", (e) => {
    h.search = e.target.value.trim().toLowerCase();
    drawHome();
  });
  $("#f-sort").addEventListener("change", (e) => {
    h.sort = e.target.value;
    h.dir = sortDef(h.sort).dir;
    drawHome();
  });
  [["#f-top", "top"], ["#f-stage", "stage"], ["#f-profit", "profit"], ["#f-loss", "loss"]].forEach(([sel, k]) =>
    $(sel).addEventListener("change", (e) => {
      h[k] = e.target.value;
      drawHome();
    })
  );
  $("#t-view").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    h.view = b.dataset.v;
    $$("#t-view button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawTable(visibleGames());
  });
  $("#scatter")._redraw = () => drawScatter(visibleGames());
}

function drawHome() {
  const rows = visibleGames();
  const h = S.home;
  const def = sortDef(h.sort);
  $("#f-count").textContent =
    `Showing ${rows.length} of ${S.games.length} games` + (SORTS[h.sort] ? ` · sorted by ${def.label.toLowerCase()}` : "");
  const sortSel = $("#f-sort");
  if (sortSel.value !== h.sort) {
    if (!SORTS[h.sort] && !sortSel.querySelector(`option[value="${h.sort}"]`)) sortSel.insertAdjacentHTML("beforeend", `<option value="${h.sort}">Table column</option>`);
    sortSel.value = h.sort;
  }
  const empty = `<li class="status">No games match these filters.</li>`;
  $("#orows").innerHTML = rows.length ? rows.map(orowHtml).join("") : empty;
  drawTable(rows);
  $("#mrows").innerHTML = rows.length ? rows.map(mrowHtml).join("") : empty;
  drawScatter(rows);
}

function orowHtml(g) {
  return (
    `<li class="orow"><div><a class="name" href="#/game/${esc(g.id)}">${esc(g.name)}</a>` +
    `<span class="sub">$${g.price} ticket${g.game_number ? " · No. " + esc(g.game_number) : ""}${g.topGone ? ` <span class="tag">top prize gone</span>` : ""}</span></div>` +
    strip(g.seg, { aria: `${g.name}: ${outcomeSentence(g)}` }) +
    `<div class="side"><strong>${g.three[2]} in 100</strong> make money<br>${money2(g.m.loss_per_100)} lost per $100</div></li>`
  );
}

function mrowHtml(g) {
  const back = Math.round(g.m.ev_ratio * 100);
  return (
    `<li class="mrow"><a href="#/game/${esc(g.id)}">${esc(g.name)} <span class="muted">$${g.price}</span></a>` +
    `<div class="mbar" role="img" aria-label="${esc(g.name)}: about $${back} of every $100 comes back; $${100 - back} is lost."><span class="r" style="width:${g.m.ev_ratio * 100}%"></span><span class="x" style="width:${100 - g.m.ev_ratio * 100}%"></span></div>` +
    `<span class="v"><strong>$${back}</strong> back · <strong>$${100 - back}</strong> lost</span></li>`
  );
}

function probCell(p, label, na = "no prize this large") {
  if (p == null) return `<td class="n" data-label="${label}"><span class="gone">n/a</span><span class="s">${na}</span></td>`;
  if (p === 0) return `<td class="n" data-label="${label}"><span class="gone">none left</span><span class="s">all claimed</span></td>`;
  return `<td class="n" data-label="${label}">${pct(p)}<span class="s">${per100(p)}</span></td>`;
}

function drawTable(rows) {
  const rel = S.home.view === "rel";
  const cols = rel
    ? [
        ["none", "No prize", "", (g) => g.m.p_none],
        ["be", "Break even", "", (g) => (g.prizes.some((t) => t.prize === g.price) ? g.m.p_break_even : null), "no break-even prize"],
        ["profit", "Profit", "", (g) => g.m.p_profit],
        ["double", "2×+", "price", (g) => g.m.p_multiple["2x"]],
        ["m5", "5×+", "price", (g) => g.m.p_multiple["5x"]],
        ["m10", "10×+", "price", (g) => g.m.p_multiple["10x"]],
      ]
    : [
        ["any", "Any prize", "", (g) => g.m.p_any],
        ["a50", "$50+", "", (g) => g.m.p_at_least["50"]],
        ["p100", "$100+", "", (g) => g.m.p_at_least["100"]],
        ["a500", "$500+", "", (g) => g.m.p_at_least["500"]],
        ["a1000", "$1,000+", "", (g) => g.m.p_at_least["1000"]],
        ["a10000", "$10,000+", "", (g) => g.m.p_at_least["10000"]],
      ];
  const th = (k, label, sub, cls = "n") =>
    `<th scope="col" class="${cls}" data-sort="${k}" tabindex="0"${S.home.sort === k ? ` aria-sort="${S.home.dir > 0 ? "ascending" : "descending"}"` : ""}><span class="h">${label}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</th>`;
  const head =
    `<caption class="sr-only">Estimated chances and expected payouts for one ticket bought today. Click a column heading to sort.</caption>` +
    `<thead><tr>${th("name", "Game", "", "")}${th("price", "Price", "")}` +
    cols.map(([k, l, s]) => th(k, l, s ? "× ticket " + s : "")).join("") +
    `${th("ev", "Expected payout", "per ticket")}${th("loss", "Expected loss", "per $100 spent")}${th("top", "Top-prize odds", "estimated")}</tr></thead>`;
  const body = rows
    .map(
      (g) =>
        `<tr><td class="g"><a href="#/game/${esc(g.id)}">${esc(g.name)}</a><span class="s">No. ${esc(g.game_number || "—")} ${cmpButton(g)}</span></td>` +
        `<td class="n" data-label="Price">$${g.price}</td>` +
        cols.map(([, l, , f, na]) => probCell(f(g), l, na)).join("") +
        `<td class="n" data-label="Expected payout">${money2(g.m.ev_ticket)}<span class="s">per $${g.price} ticket</span></td>` +
        `<td class="n" data-label="Expected loss / $100">${money2(g.m.loss_per_100)}<span class="s">${cents(g.m.ev_ratio)} back per $1</span></td>` +
        (g.topGone
          ? `<td class="n" data-label="Top-prize odds"><span class="gone">Top prize no longer available</span></td>`
          : `<td class="n" data-label="Top-prize odds">${oneIn(g.m.p_top)}<span class="s">${prizeShort(g.m.top_prize)} top prize</span></td>`) +
        `</tr>`
    )
    .join("");
  const t = $("#gt");
  t.innerHTML = head + `<tbody>${body || `<tr><td colspan="11" class="status">No games match these filters.</td></tr>`}</tbody>`;
  $$("th[data-sort]", t).forEach((h) => {
    const go = () => {
      const k = h.dataset.sort;
      if (S.home.sort === k) S.home.dir = -S.home.dir;
      else {
        S.home.sort = k;
        S.home.dir = sortDef(k).dir;
      }
      drawHome();
      $(`#gt th[data-sort="${k}"]`).focus();
    };
    h.addEventListener("click", go);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });
  wireCompareButtons(t);
}

/* ---------------- SVG helpers ---------------- */
const NS = "http://www.w3.org/2000/svg";
function E(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}
function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function drawScatter(rows) {
  const host = $("#scatter");
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = `<p class="status">No games match these filters.</p>`;
    return;
  }
  const W = Math.max(300, host.clientWidth);
  const narrow = W < 560;
  const H = narrow ? 320 : 400;
  const m = { l: narrow ? 46 : 60, r: 14, t: 14, b: 44 };
  const xs = rows.map((g) => g.m.p_profit), ys = rows.map((g) => g.m.loss_per_100);
  const all = S.games;
  const x0 = Math.floor(Math.min(...all.map((g) => g.m.p_profit)) * 50) / 50;
  const x1 = Math.ceil(Math.max(...all.map((g) => g.m.p_profit)) * 50) / 50;
  const y0 = Math.floor(Math.min(...all.map((g) => g.m.loss_per_100)) / 5) * 5;
  const y1 = Math.ceil(Math.max(...all.map((g) => g.m.loss_per_100)) / 5) * 5;
  const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const svg = E("svg", { viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "Scatter plot of chance of profit against expected loss per $100" });
  niceTicks(x0, x1, narrow ? 4 : 6).forEach((t) => {
    svg.append(E("line", { class: "grid", x1: X(t), x2: X(t), y1: m.t, y2: H - m.b }));
    svg.append(E("text", { x: X(t), y: H - m.b + 16, "text-anchor": "middle" }, Math.round(t * 100) + " in 100"));
  });
  niceTicks(y0, y1, 5).forEach((t) => {
    svg.append(E("line", { class: "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    svg.append(E("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }, "$" + t));
  });
  const mx = median(all.map((g) => g.m.p_profit)), my = median(all.map((g) => g.m.loss_per_100));
  svg.append(E("line", { class: "ref", x1: X(mx), x2: X(mx), y1: m.t, y2: H - m.b }));
  svg.append(E("line", { class: "ref", x1: m.l, x2: W - m.r, y1: Y(my), y2: Y(my) }));
  svg.append(E("text", { class: "lbl", x: (m.l + W - m.r) / 2, y: H - 6, "text-anchor": "middle" }, "Chance one ticket makes a profit →"));
  const yl = E("text", { class: "lbl", x: 12, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` }, "Expected loss per $100 →");
  svg.append(yl);
  [...rows].sort((a, b) => b.price - a.price).forEach((g) => {
    const c = E("circle", {
      class: "dot", cx: X(g.m.p_profit), cy: Y(g.m.loss_per_100), r: 3 + Math.sqrt(g.price) * 1.2, tabindex: 0,
      role: "link", "aria-label": `${g.name}, $${g.price}: ${g.three[2]} in 100 tickets make a profit; ${money2(g.m.loss_per_100)} expected loss per $100.`,
    });
    tipOn(
      c,
      `<strong>${esc(g.name)}</strong> · $${g.price}<br>Profit: ${pct(g.m.p_profit)} (${per100(g.m.p_profit)})<br>Expected loss: ${money2(g.m.loss_per_100)} per $100<br><span style="opacity:.75">Click or tap again to open</span>`,
      `#/game/${g.id}`
    );
    svg.append(c);
  });
  host.append(svg);
  const lo = (f) => rows.reduce((a, b) => (f(b) < f(a) ? b : a));
  const hi = (f) => rows.reduce((a, b) => (f(b) > f(a) ? b : a));
  const fp = (g) => g.m.p_profit, fl = (g) => g.m.loss_per_100;
  $("#scatter-sum").textContent =
    `Chance of profit ranges from ${per100(fp(lo(fp)))} (${lo(fp).name}) to ${per100(fp(hi(fp)))} (${hi(fp).name}). ` +
    `Expected loss per $100 ranges from ${money2(fl(lo(fl)))} (${lo(fl).name}) to ${money2(fl(hi(fl)))} (${hi(fl).name}).`;
}

/* ---------------- automatically generated observations ---------------- */
function observations() {
  const G = S.games;
  const link = (g) => `<a href="#/game/${esc(g.id)}">${esc(g.name)}</a> ($${g.price})`;
  const cards = [];

  const gone = G.filter((g) => g.topGone);
  cards.push(
    `<div class="callout"><h3>${gone.length} of ${G.length} games have no top prize left</h3>` +
      `<p class="small">They are still on sale; the lottery notes that tickets can keep selling after the top prizes are claimed.</p>` +
      (gone.length ? `<ul>${gone.sort((a, b) => b.price - a.price).slice(0, 8).map((g) => `<li>${link(g)} — top prize was ${prizeShort(g.m.top_prize)}</li>`).join("")}${gone.length > 8 ? `<li>…and ${gone.length - 8} more</li>` : ""}</ul>` : "") +
      `</div>`
  );

  const delta = G.filter((g) => g.mp).map((g) => ({ g, d: g.m.ev_ratio - g.mp.ev_ratio }));
  const fell = [...delta].sort((a, b) => a.d - b.d).slice(0, 4).filter((x) => x.d < -0.0005);
  const rose = [...delta].sort((a, b) => b.d - a.d).slice(0, 3).filter((x) => x.d > 0.0005);
  cards.push(
    `<div class="callout"><h3>Expected return compared with launch</h3>` +
      `<p class="small">Expected payout per $1 when the game was printed, versus today's estimate.</p>` +
      (fell.length ? `<p class="small" style="margin:8px 0 0"><strong>Fallen the most</strong></p><ul>${fell.map(({ g }) => `<li>${link(g)}: ${cents(g.mp.ev_ratio)} → ${cents(g.m.ev_ratio)}</li>`).join("")}</ul>` : "") +
      (rose.length ? `<p class="small" style="margin:8px 0 0"><strong>Risen the most</strong></p><ul>${rose.map(({ g }) => `<li>${link(g)}: ${cents(g.mp.ev_ratio)} → ${cents(g.m.ev_ratio)}</li>`).join("")}</ul>` : "") +
      `</div>`
  );

  const bigShare = (g) => g.m.return_bands.filter((b) => b.key === "1000_9999" || b.key === "10000_plus").reduce((s, b) => s + b.per_100, 0);
  const withBig = G.filter((g) => g.mp && g.mp.p_at_least["1000"] != null).map((g) => ({ g, s: bigShare(g) })).sort((a, b) => b.s - a.s);
  if (withBig.length) {
    cards.push(
      `<div class="callout"><h3>How much of the average payout comes from $1,000+ prizes</h3>` +
        `<p class="small">Cents of every $1 spent that are expected back through prizes of $1,000 or more — prizes that turn up on very few tickets.</p><ul>` +
        withBig.slice(0, 4).map(({ g, s }) => `<li>${link(g)}: ${s.toFixed(1)}¢ of ${cents(g.m.ev_ratio)}</li>`).join("") +
        `</ul><p class="small" style="margin-top:6px">Lowest among games with such prizes: ${link(withBig[withBig.length - 1].g)}, ${withBig[withBig.length - 1].s.toFixed(1)}¢.</p></div>`
    );
  }

  const prices = [...new Set(G.map((g) => g.price))].sort((a, b) => a - b);
  const byPrice = prices.map((p) => ({ p, r: median(G.filter((g) => g.price === p).map((g) => g.m.ev_ratio)), n: G.filter((g) => g.price === p).length }));
  cards.push(
    `<div class="callout"><h3>Pricier tickets tend to return a larger share</h3>` +
      `<p class="small">Median expected payout per $1 spent, by ticket price (number of games in brackets).</p><ul class="price-ret">` +
      byPrice.map(({ p, r, n }) => `<li><span class="num">$${p}</span><span class="mbar" aria-hidden="true"><span class="r" style="width:${r * 100}%"></span><span class="x" style="width:${100 - r * 100}%"></span></span><span class="num">${Math.round(r * 100)}¢ <span class="muted">(${n})</span></span></li>`).join("") +
      `</ul></div>`
  );

  const topMove = G.filter((g) => !g.topGone && g.mp && g.mp.p_top).map((g) => ({ g, r: g.m.p_top / g.mp.p_top })).sort((a, b) => a.r - b.r);
  if (topMove.length) {
    const worse = topMove.slice(0, 3).filter((x) => x.r < 0.98);
    const better = topMove.slice(-3).reverse().filter((x) => x.r > 1.02);
    cards.push(
      `<div class="callout"><h3>Top-prize odds since launch</h3><p class="small">Among games with a top prize left. Odds lengthen when top prizes are claimed faster than tickets sell, and shorten when they are claimed more slowly.</p>` +
        (worse.length ? `<p class="small" style="margin:8px 0 0"><strong>Longer odds now</strong></p><ul>${worse.map(({ g }) => `<li>${link(g)}: ${oneIn(g.mp.p_top)} → ${oneIn(g.m.p_top)}</li>`).join("")}</ul>` : "") +
        (better.length ? `<p class="small" style="margin:8px 0 0"><strong>Shorter odds now</strong></p><ul>${better.map(({ g }) => `<li>${link(g)}: ${oneIn(g.mp.p_top)} → ${oneIn(g.m.p_top)}</li>`).join("")}</ul>` : "") +
        `</div>`
    );
  }
  return `<div class="obs">${cards.join("")}</div>`;
}

/* ====================================================================== */
/* GAME PICKER                                                            */
/* ====================================================================== */
function renderPicker() {
  setTitle("Explore a game");
  const prices = [...new Set(S.games.map((g) => g.price))].sort((a, b) => a - b);
  app.innerHTML =
    `<div class="wrap"><h1 class="page-title">Explore a game</h1>` +
    `<p class="lede">Choose a game to see what is likely to happen to one ticket, how the prizes break down, and how the game has changed since it went on sale.</p>` +
    `<div class="controls"><div class="ctl"><span class="ctl-label" id="pp-l">Ticket price</span><div class="seg" id="pp" role="group" aria-labelledby="pp-l">` +
    ["all", ...prices].map((p) => `<button type="button" data-p="${p}" aria-pressed="${S.picker.price === String(p)}">${p === "all" ? "All" : "$" + p}</button>`).join("") +
    `</div></div><div class="ctl grow"><label class="ctl-label" for="ps">Search</label><input id="ps" type="search" placeholder="Game name or number" autocomplete="off" value="${esc(S.picker.search)}" /></div></div>` +
    legendHtml() + `<ol class="orows" id="plist" style="margin-top:12px"></ol></div>`;
  const draw = () => {
    const rows = S.games
      .filter((g) => S.picker.price === "all" || String(g.price) === S.picker.price)
      .filter((g) => !S.picker.search || g.search.includes(S.picker.search))
      .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
    $("#plist").innerHTML = rows.length ? rows.map(orowHtml).join("") : `<li class="status">No games match.</li>`;
  };
  $("#pp").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.picker.price = b.dataset.p;
    $$("#pp button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    draw();
  });
  $("#ps").addEventListener("input", (e) => {
    S.picker.search = e.target.value.trim().toLowerCase();
    draw();
  });
  draw();
}

/* ====================================================================== */
/* GAME PAGE                                                              */
/* ====================================================================== */
const EVENTS = [
  ["any", "Any prize", (m) => m.p_any, "getting any prize at all"],
  ["back", "Make my money back", (m) => m.p_break_even + m.p_profit, "getting at least the ticket price back"],
  ["profit", "Make a profit", (m) => m.p_profit, "making a profit (more than the ticket price back)"],
  ["double", "Double my money", (m) => m.p_multiple["2x"], "at least doubling your money"],
  ["100", "Win $100+", (m) => m.p_at_least["100"], "getting a prize of $100 or more"],
  ["500", "Win $500+", (m) => m.p_at_least["500"], "getting a prize of $500 or more"],
  ["1000", "Win $1,000+", (m) => m.p_at_least["1000"], "getting a prize of $1,000 or more"],
  ["top", "Top prize", (m) => m.p_top, "getting the top prize"],
];

function renderGame(match) {
  const g = S.byId.get(decodeURIComponent(match[1]));
  if (!g) {
    setTitle("Game not found");
    app.innerHTML = `<div class="wrap"><h1 class="page-title">Game not found</h1><p>That game is not in today's list of games on sale. <a href="#/game">See all games</a>.</p></div>`;
    return;
  }
  setTitle(g.name);
  const m = g.m;
  const [l, b, p] = g.three;
  const img = g.thumb_url || g.image_url;
  const loseTxt = m.p_below_cost > 0 ? "lose money — less than $" + g.price + " back" : `no prize — lose $${g.price}`;
  app.innerHTML =
    `<div class="wrap">` +
    `<p class="crumbs"><a href="#/">All games</a> › $${g.price} tickets</p>` +
    `<header class="game-head${img ? "" : " noimg"}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()" />` : ""}<div>` +
    `<h1 class="page-title">${esc(g.name)}</h1>` +
    `<div class="facts"><span><strong>$${g.price}</strong> per ticket</span>${g.game_number ? `<span>Game #${esc(g.game_number)}</span>` : ""}${g.on_sale ? `<span>On sale since ${apDay(g.on_sale)}</span>` : ""}</div>` +
    `<div class="actions">${cmpButton(g, "btn")}${g.page_url ? `<a class="btn" href="${esc(g.page_url)}" target="_blank" rel="noopener">Official game page ↗</a>` : ""}</div>` +
    `</div></header>` +
    freshness() +
    `<div id="g-flags">${flagsHtml(g, [])}</div>` +
    (g.topGone ? `<p class="notice"><strong>Top prize no longer available.</strong> All ${commas(g.prizes[0].total)} ${money0(m.top_prize)} top prizes have been claimed, but tickets remain on sale.</p>` : "") +

    `<section class="block" aria-labelledby="one-h"><h2 id="one-h">What happens to one ticket?</h2>` +
    `<div class="big3">` +
    `<div><span class="k">${l} <small>of 100</small></span><span class="l"><i class="mark o-none"></i>${loseTxt}</span><span class="p">${pct(m.p_loss)}</span></div>` +
    `<div><span class="k">${b} <small>of 100</small></span><span class="l"><i class="mark o-be"></i>break even — $${g.price} back</span><span class="p">${pct(m.p_break_even)}</span></div>` +
    `<div><span class="k">${p} <small>of 100</small></span><span class="l"><i class="mark o-profit"></i>finish ahead — more than $${g.price}</span><span class="p">${pct(m.p_profit)}</span></div>` +
    `</div>` +
    strip(g.seg, { size: "lg", aria: outcomeSentence(g) }) +
    legendHtml().replace('class="legend"', 'class="legend" style="margin-bottom:4px"') +
    `<div class="money-line">` +
    `<div><span class="v">${money2(m.ev_ticket)}</span><span class="t">average payout per $${g.price} ticket${qHelp(EV_HELP)}</span></div>` +
    `<div><span class="v">${money2(m.expected_loss)}</span><span class="t">average loss per ticket</span></div>` +
    `<div><span class="v">${money2(m.loss_per_100)}</span><span class="t">expected loss per $100 spent</span></div>` +
    `<div><span class="v">${cents(m.ev_ratio)}</span><span class="t">returned per $1, on average</span></div>` +
    `</div></section>` +

    `<section class="block" aria-labelledby="typ-h"><h2 id="typ-h">Your most likely result</h2>` +
    `<p class="lede">100 tickets bought today, as they would be expected to turn out.</p>` +
    pictogram(g) +
    `<div class="typical">` +
    `<div><span class="t">Most likely outcome for one ticket</span><span class="v">${money0(m.mode_payout)}</span></div>` +
    `<div><span class="t">Median (typical) ticket</span><span class="v">${money0(m.median_payout)}</span></div>` +
    `<div><span class="t">Average payout</span><span class="v">${money2(m.ev_ticket)}</span></div>` +
    `</div>` +
    `<p class="note">An average payout of ${money2(m.ev_ticket)} can sound as though a typical $${g.price} ticket returns about that much. It does not: ${m.median_payout === 0 ? "most tickets pay nothing" : `the typical ticket pays ${money0(m.median_payout)}`}, and the average is pulled up by a small number of large prizes. ${percentileText(g)}</p>` +
    `</section>` +

    `<section class="block" aria-labelledby="ex-h"><h2 id="ex-h">If I buy one ticket…</h2><div class="chips" id="chips" role="group" aria-label="Outcome">` +
    EVENTS.map(([k, label, f]) => {
      const v = f(m);
      return `<button type="button" data-e="${k}" aria-pressed="${S.explorer === k}"${v == null ? ` title="No prize this large in this game"` : ""}>${label}</button>`;
    }).join("") +
    `</div><div id="ex-out" aria-live="polite"></div>` +
    profitFrequency(g) +
    `</section>` +

    `<section class="block" aria-labelledby="sp-h"><h2 id="sp-h">If I spend $100…</h2>` +
    `<div class="form-row"><div class="ctl"><label class="ctl-label" for="sp-amt">Amount spent on this game</label><input type="number" id="sp-amt" min="${g.price}" step="${g.price}" value="${S.spend[g.id] || 100}" inputmode="numeric" /></div>` +
    `<div class="ctl"><span class="ctl-label">Quick amounts</span><div class="seg" id="sp-q">${[20, 100, 300, 1000].filter((a) => a >= g.price).map((a) => `<button type="button" data-a="${a}">$${commas(a)}</button>`).join("")}</div></div></div>` +
    `<div id="sp-out" aria-live="polite"></div></section>` +

    `<section class="block" aria-labelledby="lad-h"><h2 id="lad-h">Prize ladder</h2>` +
    `<p class="lede">Every prize in the game, with how many are still unclaimed and the estimated chance a ticket bought today pays it. These are among an estimated <strong>${commas(g.tickets_remaining)}</strong> tickets still unsold (${pct(g.percent_unsold / 100)} of the ${commas(g.tickets_printed)} printed).</p>` +
    ladder(g) + `</section>` +

    `<section class="block" aria-labelledby="dec-h"><h2 id="dec-h">Where does the average payout come from?</h2>` +
    decomposition(g) + `</section>` +

    `<section class="block" aria-labelledby="rare-h"><h2 id="rare-h">How rare is the top prize?</h2>${rarity(g)}</section>` +

    `<section class="block" aria-labelledby="hist-h"><h2 id="hist-h">How this game has changed</h2>` +
    launchPanel(g) +
    `<div id="hist"><p class="small">Loading history…</p></div></section>` +

    `<section class="block" aria-labelledby="full-h"><h2 id="full-h">Full prize table</h2><details><summary class="btn">Show printed and remaining counts for every prize</summary>${fullTable(g)}</details></section>` +

    `<section class="block" aria-labelledby="est-h"><h2 id="est-h">How exact are these figures?</h2>${estimateBlock(g)}</section>` +
    (g.page_url ? `<p><a href="${esc(g.page_url)}" target="_blank" rel="noopener">${esc(g.name)} on the New Hampshire Lottery website ↗</a></p>` : "") +
    `</div>`;

  wireCompareButtons();
  // one-ticket explorer
  const drawEx = () => ($("#ex-out").innerHTML = explorerHtml(g));
  $("#chips").addEventListener("click", (e) => {
    const bt = e.target.closest("button");
    if (!bt) return;
    S.explorer = bt.dataset.e;
    $$("#chips button").forEach((x) => x.setAttribute("aria-pressed", x === bt));
    drawEx();
  });
  drawEx();
  // spending block
  const drawSp = () => {
    const amt = Math.max(0, +$("#sp-amt").value || 0);
    S.spend[g.id] = amt;
    const n = Math.max(1, Math.floor(amt / g.price));
    $("#sp-out").innerHTML = sessionHtml(g, n, amt);
  };
  $("#sp-amt").addEventListener("input", drawSp);
  $("#sp-q").addEventListener("click", (e) => {
    const bt = e.target.closest("button");
    if (!bt) return;
    $("#sp-amt").value = bt.dataset.a;
    drawSp();
  });
  drawSp();
  // history
  loadHistory().then(() => {
    if (parseHash().path !== `/game/${match[1]}`) return;
    const h = S.history && S.history.games[g.game_number || g.name];
    $("#g-flags").innerHTML = flagsHtml(g, h ? h.flags : []);
    historyBlock(g, h);
  });
}

function flagsHtml(g, histFlags) {
  const all = [...(g.flags || []), ...(histFlags || [])];
  if (!all.length) return "";
  return `<div class="notice"><strong>Data check:</strong> the published figures for this game failed an automatic consistency check, so some numbers below may be unreliable.<ul>${all.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`;
}

function pictogram(g) {
  const segs = g.seg.filter((s) => s.p > 0);
  const counts = shares100(segs.map((s) => s.p));
  const cells = [];
  segs.forEach((s, i) => { for (let j = 0; j < counts[i]; j++) cells.push(s.cls); });
  const desc = {
    none: "$0",
    below: `less than $${g.price}`,
    be: `$${g.price} — money back`,
    p1: `more than $${g.price}, under ${money0(2 * g.price)}`,
    p2: `${money0(2 * g.price)} to under ${money0(10 * g.price)}`,
    p3: `${money0(10 * g.price)} or more`,
  };
  const key = segs
    .map((s, i) => {
      const c = counts[i];
      const cTxt = c === 0 ? "<1" : c;
      return `<li><i class="sw ${s.cls}"></i><span class="c">${cTxt} <small class="muted">of 100</small></span><span>${desc[s.k]}${c === 0 ? ` <span class="small">(${per100(s.p)})</span>` : ""}</span></li>`;
    })
    .join("");
  return (
    `<div class="picto-wrap"><div class="picto" role="img" aria-label="${esc(outcomeSentence(g))}">${cells.map((c) => `<i class="${c}"></i>`).join("")}</div>` +
    `<ul class="picto-key">${key}</ul></div>`
  );
}

function percentileText(g) {
  const pc = g.m.percentiles;
  const parts = [];
  if (pc["50"] === 0) parts.push("Half or more of tickets pay $0.");
  if (pc["75"] != null) parts.push(`3 in 4 pay ${money0(pc["75"])} or less`);
  if (pc["90"] != null) parts.push(`9 in 10 pay ${money0(pc["90"])} or less`);
  if (pc["99"] != null) parts.push(`99 in 100 pay ${money0(pc["99"])} or less`);
  return parts.length ? parts[0] + (parts.length > 1 ? " " + parts.slice(1).join("; ") + "." : "") : "";
}

function explorerHtml(g) {
  const [, label, f, desc] = EVENTS.find((e) => e[0] === S.explorer) || EVENTS[2];
  const p = f(g.m);
  const title = `<h3>Chance of ${desc}</h3>`;
  if (p == null) return title + `<p class="note">This game has no prize that large.</p>`;
  if (p === 0) return title + `<p class="note">Every prize of this size has been claimed. ${S.explorer === "top" ? "Tickets are still on sale without it." : ""}</p>`;
  const fr = freq(p);
  return (
    title +
    `<div class="four">` +
    `<div><span class="v">${pct(p)}</span><span class="t">of tickets</span></div>` +
    `<div><span class="v">${esc(fr.short)}</span><span class="t">${p >= 0.001 ? "tickets" : "frequency"}</span></div>` +
    `<div><span class="v">${oneIn(p)}</span><span class="t">roughly</span></div>` +
    `<div><span class="v">${moneyBig(g.price / p)}</span><span class="t">of ticket purchases per occurrence, on average</span></div>` +
    `</div><p class="small" style="margin-top:8px">The last figure is an average frequency, not a price: spending that much would not guarantee ${desc.replace(/ \(.*\)/, "")}. ${label === "Make my money back" ? "Getting the ticket price back is not a profit." : ""}</p>`
  );
}

function profitFrequency(g) {
  const p = g.m.p_profit;
  if (!p) return "";
  return (
    `<p class="note">A ticket paying more than its purchase price occurs about once per <strong>${(1 / p).toFixed(1)}</strong> tickets. ` +
    `At $${g.price} each, that corresponds to about <strong>${money0(g.price / p)}</strong> in ticket purchases per profitable ticket, on average. ` +
    `A profitable individual ticket does not mean the purchases as a whole are profitable.</p>`
  );
}

function sessionHtml(g, n, amt) {
  if (n > 1000) return `<p class="note">Enter an amount of up to ${money0(1000 * g.price)} (1,000 tickets).</p>`;
  const s = Calc.sessionStats(g.dist, g.price, n);
  if (!s) return `<p class="note">That is too many tickets to calculate. Try a smaller amount.</p>`;
  const spend = n * g.price;
  const leftover = amt && amt - spend >= 1 ? ` (${money0(amt - spend)} left over)` : "";
  const med = s.median == null ? `more than ${money0(spend)}` : moneyAuto(s.median);
  const card = (v, t) => `<div><span class="v">${v}</span><span class="t">${t}</span></div>`;
  const pc = (x) => `${pct(x)}<span class="small" style="display:block;font-weight:400">${per100(x)}</span>`;
  return (
    `<p><strong>${money0(spend)}</strong> buys <strong>${commas(n)}</strong> ticket${n === 1 ? "" : "s"}${leftover}.</p>` +
    `<div class="result-grid">` +
    card(money0(spend), "total spent") +
    card(moneyAuto(s.expected_payout), "expected payout (average)") +
    card(moneyAuto(s.expected_loss), "expected loss (average)") +
    card(med, "median amount returned — half of the time you would get less") +
    card(pc(s.p_ahead), `chance of finishing ahead (more than ${money0(spend)} back)`) +
    card(pc(s.p_back), `chance of getting at least ${money0(spend)} back`) +
    card(pc(s.p_lose_half), `chance of losing at least half (${money0(spend / 2)} or less back)`) +
    card(pc(s.p_lose_all), `chance of losing the full ${money0(spend)}`) +
    `</div><p class="small" style="margin-top:8px">Estimate: treats each ticket as an independent draw from today's estimated prize odds. The pool holds far more tickets than any one buyer purchases, so this is a close approximation.</p>`
  );
}

function ladder(g) {
  const T = g.tickets_remaining;
  const C = g.price;
  const W = (p) => (p > 0 ? Math.max(1, ((Math.log10(p) + 7) / 7) * 100) : 0); // log scale, 1 in 10 million .. certain
  const cls = (a) => (a < C ? "o-below" : a === C ? "o-be" : a >= 10 * C ? "o-p3" : a >= 2 * C ? "o-p2" : "o-p1");
  const tiers = [...g.prizes].sort((a, b) => b.prize - a.prize);
  let html = `<ul class="ladder" aria-label="Prize ladder">`;
  html += `<li class="axis-row" aria-hidden="true"><span>Prize</span><span class="ticks"><span>1 in 10M</span><span>1 in 100K</span><span>1 in 1,000</span><span>1 in 10</span></span><span style="text-align:right">Unclaimed</span><span style="text-align:right">Est. odds now</span></li>`;
  let group = null;
  tiers.forEach((t) => {
    const gname = t.prize > C ? `Profit — more than $${C}` : t.prize === C ? null : `Less than the ticket price`;
    if (gname && gname !== group) {
      html += `<li class="grp">${gname}</li>`;
      group = gname;
    }
    const p = t.remaining / T;
    html +=
      `<li class="${t.prize === C ? "be" : ""}${t.remaining ? "" : " claimed"}">` +
      `<span class="a">${money0(t.prize)}</span>` +
      `<span class="lb" aria-hidden="true"><i class="${cls(t.prize)}" style="width:${W(p).toFixed(1)}%"></i></span>` +
      `<span class="r">${commas(t.remaining)} left of ${commas(t.total)}</span>` +
      `<span class="o">${t.remaining ? oneIn(p) : "all claimed"}</span></li>`;
  });
  html +=
    `<li><span class="a">$0</span><span class="lb" aria-hidden="true"><i class="o-none" style="width:${W(g.m.p_none).toFixed(1)}%"></i></span>` +
    `<span class="r">no prize</span><span class="o">${pct(g.m.p_none)} · ${per100(g.m.p_none)}</span></li></ul>`;
  return html + `<p class="small" style="margin-top:6px">Bar lengths use a logarithmic scale: each step along the axis is 100 times rarer than the one to its right.</p>`;
}

function decomposition(g) {
  const m = g.m;
  const bands = m.return_bands;
  const cls = { under_100: "d1", "100_999": "d2", "1000_9999": "d3", "10000_plus": "d4" };
  const segs = [
    ...bands.map((b) => ({ cls: cls[b.key], label: b.label, p: b.per_100 / 100 })),
    { cls: "x", label: "Expected loss", p: m.loss_per_100 / 100 },
  ];
  const big = bands.filter((b) => b.key === "1000_9999" || b.key === "10000_plus");
  const bigC = big.reduce((s, b) => s + b.per_100, 0);
  const bigP = big.reduce((s, b) => s + b.p, 0);
  const total = bands.reduce((s, b) => s + b.per_100, 0);
  return (
    `<div class="lede">For every $100 spent on this game, the expected prize money, split by prize size.${qHelp(EV_HELP)}</div>` +
    `<div class="strip lg" role="img" aria-label="Of every $100 spent: ${bands.map((b) => `${money2(b.per_100)} from ${b.label.toLowerCase()}`).join(", ")}; ${money2(m.loss_per_100)} expected loss.">` +
    segs.filter((s) => s.p > 0).map((s) => `<span class="${s.cls}" style="width:${s.p * 100}%" title="${esc(s.label)}">${s.p >= 0.08 ? "$" + Math.round(s.p * 100) : ""}</span>`).join("") +
    `</div><ul class="decomp">` +
    bands.map((b) => `<li><span class="v">${money2(b.per_100)}</span><span><i class="sw ${cls[b.key]}" style="vertical-align:-2px;margin-right:6px"></i>${esc(b.label)}</span><span class="f">${b.p > 0 ? per100(b.p) + " tickets" : "all claimed"}</span></li>`).join("") +
    `<li class="total"><span class="v">${money2(total)}</span><span>expected prize value</span><span></span></li>` +
    `<li class="loss"><span class="v">${money2(m.loss_per_100)}</span><span><i class="sw" style="background:var(--lost);vertical-align:-2px;margin-right:6px"></i>expected loss</span><span></span></li></ul>` +
    (big.length
      ? `<p class="note"><strong>Where the expected return comes from:</strong> of the ${cents(m.ev_ratio)} expected back per $1, <strong>${(100 * m.ev_ratio - bigC).toFixed(1)}¢</strong> comes from prizes below $1,000 and <strong>${bigC.toFixed(1)}¢</strong> from $1,000+ prizes${bigP > 0 ? `, which turn up on about ${oneIn(bigP)} tickets` : ""}. A high average supported by extraordinarily rare prizes is different from the same average made up of frequent small ones.</p>`
      : "")
  );
}

function rarity(g) {
  const m = g.m;
  if (g.topGone) return `<p class="lede">All of this game's ${money0(m.top_prize)} top prizes have been claimed. The largest prize still unclaimed is ${money0((g.prizes.find((t) => t.remaining > 0) || {}).prize)}.</p>`;
  const n = 1 / m.p_top;
  const cost = n * g.price;
  return (
    `<p class="lede">${commas(m.top_left)} of ${commas(g.prizes[0].total)} ${money0(m.top_prize)} top prizes remain, among an estimated ${commas(g.tickets_remaining)} unsold tickets.</p>` +
    `<div class="stats-grid">` +
    `<div><span class="v">1 per ${commas(n)}</span><span class="t">top-prize tickets per remaining ticket, approximately</span></div>` +
    `<div><span class="v">${moneyBig(cost)}</span><span class="t">what ${commas(n)} tickets would cost</span></div>` +
    `<div><span class="v">${commas(n / 52)} years</span><span class="t">of purchases at one ticket per week</span></div></div>` +
    `<p class="note">This is a frequency comparison, not a guarantee. Buying ${commas(n)} tickets would not guarantee a top prize: for an event with a 1-in-N chance, buying N tickets gives only about a 63% chance of seeing it at least once.</p>`
  );
}

function launchPanel(g) {
  const m = g.m, mp = g.mp;
  if (!mp) return "";
  const rel = (now, then) => {
    if (now == null || then == null || !then) return "";
    const r = now / then - 1;
    if (Math.abs(r) < 0.005) return "about the same";
    return `${r > 0 ? "↑" : "↓"} ${Math.abs(r * 100).toFixed(Math.abs(r) < 0.1 ? 1 : 0)}% ${r > 0 ? "better" : "worse"}`;
  };
  const item = (t, v, d) => `<div><span class="t">${t}</span><span class="v">${v}</span><span class="d">${d || "&nbsp;"}</span></div>`;
  const dEv = (m.ev_ratio - mp.ev_ratio) * 100;
  const a500n = m.p_at_least["500"], a500p = mp.p_at_least["500"];
  return (
    `<h3>Compared with launch</h3><p class="small" style="margin:0 0 8px">Printed figures across the full print run, versus today's estimate for the tickets still unsold.</p><div class="launch">` +
    item("Expected payout per $1", `${cents(mp.ev_ratio)} → ${cents(m.ev_ratio)}`, `${dEv >= 0 ? "+" : "−"}${Math.abs(dEv).toFixed(1)}¢`) +
    item("Chance of profit", `${per100(mp.p_profit)} → ${per100(m.p_profit)}`, rel(m.p_profit, mp.p_profit)) +
    (a500p != null ? item("Odds of $500+", `${oneIn(a500p)} → ${a500n ? oneIn(a500n) : "none left"}`, rel(a500n, a500p)) : "") +
    item("Top-prize odds", `${oneIn(mp.p_top)} → ${g.topGone ? "all claimed" : oneIn(m.p_top)}`, g.topGone ? "" : rel(m.p_top, mp.p_top)) +
    item("Estimated tickets sold", pct(g.sold), `${commas(g.tickets_printed - g.tickets_remaining)} of ${commas(g.tickets_printed)}`) +
    `</div>`
  );
}

const HIST_METRICS = {
  ev: { label: "Expected payout per $1", fmt: (v) => cents(v), launch: (g) => g.mp.ev_ratio },
  p_profit: { label: "Chance of profit", fmt: (v) => per100(v), launch: (g) => g.mp.p_profit },
  p_2x: { label: "Chance of 2×", fmt: (v) => per100(v), launch: (g) => g.mp.p_multiple["2x"] },
  p_100: { label: "Odds of $100+", fmt: (v) => oneIn(v), launch: (g) => g.mp.p_at_least["100"], inv: true },
  p_top: { label: "Top-prize odds", fmt: (v) => (v ? oneIn(v) : "all claimed"), launch: (g) => g.mp.p_top, inv: true },
  tickets: { label: "Estimated tickets remaining", fmt: (v) => commas(v), launch: null },
};

function historyBlock(g, h) {
  const host = $("#hist");
  if (!h || h.d.length < 2) {
    host.innerHTML = `<p class="small">Daily tracking for this game has not built up enough history to chart yet.</p>`;
    return;
  }
  let metric = "ev";
  const first = h.d[0], last = h.d[h.d.length - 1];
  const sinceFirst = S.history.first_date;
  host.innerHTML =
    `<h3 style="margin-top:8px">Day by day</h3>` +
    `<div class="seg" id="hm" role="group" aria-label="Metric" style="margin-bottom:10px">` +
    Object.entries(HIST_METRICS)
      .filter(([k]) => k !== "p_100" || h.p_100.some((v) => v != null))
      .map(([k, d]) => `<button type="button" data-k="${k}" aria-pressed="${k === metric}">${d.label}</button>`)
      .join("") +
    `</div><div class="chart" id="hchart" data-redraw></div><p class="small" id="hsum"></p>` +
    `<p class="small">Daily tracking began ${apDay(sinceFirst)}${first !== sinceFirst ? `; this game's record starts ${apDay(first)}` : ""}. Latest point: ${apDay(last)}.</p>`;
  const draw = () => drawHistory(g, h, metric);
  $("#hm").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    metric = b.dataset.k;
    $$("#hm button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    draw();
  });
  $("#hchart")._redraw = draw;
  draw();
}

function drawHistory(g, h, key) {
  const def = HIST_METRICS[key];
  const host = $("#hchart");
  host.replaceChildren();
  // odds metrics are plotted as N in "1 in N" so that up means rarer
  const tx = (v) => (v == null ? null : def.inv ? (v > 0 ? 1 / v : null) : v);
  const raw = h[key];
  const vals = raw.map(tx);
  const launch = def.launch ? def.launch(g) : null;
  const L = launch == null ? null : tx(launch);
  const finite = vals.filter((v) => v != null);
  if (!finite.length) {
    host.innerHTML = `<p class="small">No values to chart.</p>`;
    return;
  }
  let lo = Math.min(...finite, ...(L != null ? [L] : []));
  let hi = Math.max(...finite, ...(L != null ? [L] : []));
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.02 || 1;
  lo -= pad;
  hi += pad;
  if (key !== "ev" && lo < 0) lo = 0;
  const W = Math.max(300, host.clientWidth), H = 240;
  const m = { l: W < 500 ? 70 : 90, r: 16, t: 16, b: 30 };
  const n = h.d.length;
  const X = (i) => m.l + (n === 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
  const Y = (v) => H - m.b - ((v - lo) / (hi - lo)) * (H - m.t - m.b);
  const fmtAxis = (v) => (def.inv ? "1 in " + commas(v) : def.fmt(v));
  const svg = E("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-labelledby": "hsum" });
  niceTicks(lo, hi, 4).forEach((t) => {
    svg.append(E("line", { class: "grid", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    svg.append(E("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }, fmtAxis(t)));
  });
  const every = Math.ceil(n / (W < 500 ? 4 : 8));
  h.d.forEach((d, i) => {
    if (i % every === 0 || i === n - 1) svg.append(E("text", { x: X(i), y: H - 10, "text-anchor": "middle" }, shortDay(d)));
  });
  if (L != null) {
    svg.append(E("line", { class: "ref", x1: m.l, x2: W - m.r, y1: Y(L), y2: Y(L) }));
    svg.append(E("text", { class: "ann-t", x: W - m.r, y: Y(L) - 5, "text-anchor": "end" }, `When released: ${fmtAxis(L)}`));
  }
  for (let i = 1; i < n; i++) {
    if (h.top_left[i] < h.top_left[i - 1]) {
      svg.append(E("line", { class: "ann", x1: X(i), x2: X(i), y1: m.t, y2: H - m.b }));
      svg.append(E("text", { class: "ann-t", x: X(i) + 4, y: m.t + 10 }, "top prize claimed"));
    }
  }
  let path = "";
  vals.forEach((v, i) => {
    if (v == null) return;
    path += (path && vals[i - 1] != null ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1);
  });
  svg.append(E("path", { class: "line", d: path }));
  vals.forEach((v, i) => {
    if (v == null) return;
    const c = E("circle", { class: "pt", cx: X(i), cy: Y(v), r: 3.5 });
    tipOn(c, `${apDay(h.d[i])}<br><strong>${esc(def.fmt(raw[i]))}</strong>`);
    svg.append(c);
  });
  host.append(svg);
  const i0 = raw.findIndex((v) => v != null);
  $("#hsum").textContent =
    `${def.label}: ${def.fmt(raw[i0])} on ${apDay(h.d[i0])}, ${def.fmt(raw[n - 1])} on ${apDay(h.d[n - 1])}` +
    (launch != null ? `; ${def.fmt(launch)} when the game was released.` : ".");
}

function fullTable(g) {
  const T = g.tickets_remaining;
  return (
    `<div class="table-scroll" style="margin-top:12px"><table><caption class="sr-only">Every prize level of ${esc(g.name)}</caption>` +
    `<thead><tr><th scope="col">Prize</th><th scope="col" class="n">Printed</th><th scope="col" class="n">Unclaimed</th><th scope="col" class="n">Share left</th><th scope="col" class="n">Printed odds</th><th scope="col" class="n">Est. odds now</th></tr></thead><tbody>` +
    [...g.prizes]
      .sort((a, b) => b.prize - a.prize)
      .map(
        (t) =>
          `<tr><td class="num">${money0(t.prize)}</td><td class="n">${commas(t.total)}</td><td class="n">${commas(t.remaining)}</td>` +
          `<td class="n">${pct(t.remaining / t.total)}</td><td class="n">${oneIn(1 / t.odds_printed)}</td><td class="n">${t.remaining ? oneIn(t.remaining / T) : "all claimed"}</td></tr>`
      )
      .join("") +
    `<tr><td>All prizes</td><td class="n">${commas(g.prizes.reduce((s, t) => s + t.total, 0))}</td><td class="n">${commas(g.prizes.reduce((s, t) => s + t.remaining, 0))}</td><td class="n">${pct(g.percent_unsold / 100)}</td><td class="n">${g.overall_odds ? "1 in " + g.overall_odds.toFixed(2) : "—"}</td><td class="n">${oneIn(g.m.p_any)}</td></tr>` +
    `</tbody></table></div><p class="small">Tickets printed: ${commas(g.tickets_printed)}. Estimated unsold: ${commas(T)}. The lottery's “overall odds” cover every prize level, including prizes equal to the ticket price.</p>`
  );
}

function estimateBlock(g) {
  const q = g.estimate || {};
  const EXPLAIN = {
    "Estimate appears stable": "The share of prizes still unclaimed is consistent across this game's high-volume prize levels, which is what the estimate relies on.",
    "Estimate is approximate": "The high-volume prize levels disagree slightly about how much of the game is still unsold, so the estimated ticket count is somewhat less certain than usual.",
    "Prize redemption pattern unusual": "The high-volume prize levels are being claimed at noticeably different rates. The estimated number of unsold tickets, and every live figure built on it, should be treated with extra caution.",
    "Limited data": "There are too few high-volume prize levels to cross-check the estimate.",
  };
  return (
    `<p class="lede"><strong>${esc(q.label || "Estimated")}.</strong> ${EXPLAIN[q.label] || ""}${q.spread != null ? ` (Spread in share remaining across ${q.levels_used} prize levels with 1,000+ printed: ${(q.spread * 100).toFixed(1)} percentage points.)` : ""}</p>` +
    `<p class="lede">${ESTIMATE_HELP}</p>` +
    `<p class="lede">“Unclaimed” does not literally mean “still in a store”: an unclaimed prize may be on an unsold ticket, on a ticket that has been bought but not scratched, or on a scratched winner not yet cashed. <a href="#/methods">Methods and limitations</a>.</p>`
  );
}

/* ====================================================================== */
/* COMPARE                                                                */
/* ====================================================================== */
function renderCompare(_m, q) {
  setTitle("Compare games");
  let ids = (q.get("g") || "").split(",").filter((id) => S.byId.has(id)).slice(0, 3);
  if (!ids.length) ids = S.compare.slice();
  const games = ids.map((id) => S.byId.get(id));
  const options = (sel) =>
    `<option value="">— choose a game —</option>` +
    [...S.games].sort((a, b) => b.price - a.price || a.name.localeCompare(b.name)).map((g) => `<option value="${esc(g.id)}"${g.id === sel ? " selected" : ""}>$${g.price} · ${esc(g.name)}</option>`).join("");
  const picks = [0, 1, 2].map((i) => `<div class="ctl"><label class="ctl-label" for="cp${i}">Game ${i + 1}</label><select id="cp${i}" data-i="${i}">${options(ids[i])}</select></div>`).join("");
  const rows = [
    ["Ticket price", (g) => "$" + g.price],
    ["Lose money", (g) => `${g.three[0]} / 100`],
    ["Break even", (g) => `${g.three[1]} / 100`],
    ["Make a profit", (g) => `${g.three[2]} / 100`],
    ["2× ticket price or more", (g) => per100(g.m.p_multiple["2x"])],
    ["10× ticket price or more", (g) => per100(g.m.p_multiple["10x"])],
    ["Expected payout per ticket", (g) => money2(g.m.ev_ticket)],
    ["Expected loss per $100", (g) => money2(g.m.loss_per_100)],
    ["Median ticket payout", (g) => money0(g.m.median_payout)],
    ["$100+ prize", (g) => (g.m.p_at_least["100"] == null ? "no prize this large" : oneIn(g.m.p_at_least["100"]))],
    ["Top prize", (g) => money0(g.m.top_prize)],
    ["Top-prize odds (est.)", (g) => (g.topGone ? "no longer available" : oneIn(g.m.p_top))],
    ["Top prizes left", (g) => `${commas(g.m.top_left)} of ${commas(g.prizes[0].total)}, among ~${commas(g.tickets_remaining)} tickets`],
    ["Expected payout per $1: launch → now", (g) => `${cents(g.mp.ev_ratio)} → ${cents(g.m.ev_ratio)}`],
    ["Estimated share sold", (g) => pct(g.sold)],
  ];
  app.innerHTML =
    `<div class="wrap"><h1 class="page-title">Compare games</h1>` +
    `<p class="lede">Up to three games side by side, using the same denominators. Different games come out ahead on different measures, so there is no overall “winner”.</p>` +
    `<div class="cmp-pick">${picks}</div>` +
    (games.length
      ? `<div class="table-scroll"><table class="cmp"><caption class="sr-only">Comparison of selected games</caption><thead><tr><th scope="col"><span class="sr-only">Measure</span></th>` +
        games.map((g) => `<th scope="col"><a href="#/game/${esc(g.id)}">${esc(g.name)}</a>${strip(threeSegs(g.m), { size: "sm", aria: outcomeSentence(g) })}</th>`).join("") +
        `</tr></thead><tbody>` +
        rows.map(([label, f]) => `<tr><th scope="row">${label}</th>${games.map((g) => `<td>${f(g)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>` + freshness()
      : `<p class="status">Choose games above, or use the “Compare” buttons in the game table and on game pages.</p>`) +
    `</div>`;
  $$(".cmp-pick select").forEach((sel) =>
    sel.addEventListener("change", () => {
      const chosen = $$(".cmp-pick select").map((s) => s.value).filter(Boolean);
      const uniq = [...new Set(chosen)];
      S.compare = uniq;
      saveCompare();
      location.hash = `#/compare?g=${uniq.join(",")}`;
    })
  );
  if (games.length) {
    S.compare = ids;
    saveCompare();
  }
}

/* ====================================================================== */
/* CALCULATORS                                                            */
/* ====================================================================== */
function gameOptions(sel) {
  return [...S.games]
    .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name))
    .map((g) => `<option value="${esc(g.id)}"${g.id === sel ? " selected" : ""}>$${g.price} · ${esc(g.name)}</option>`)
    .join("");
}

/* A fresh random seed for each simulation session; shown on the page so a sequence can be replayed with ?seed=. */
function newSeed() {
  try {
    return (crypto.getRandomValues(new Uint32Array(1))[0] % 999999) + 1;
  } catch {
    return Math.floor(Math.random() * 999999) + 1;
  }
}

function renderCalculator(_m, q) {
  const askedSeed = parseInt(q && q.get("seed"), 10);
  if (askedSeed > 0) {
    S.sim.seed = askedSeed;
    S.sim.runs = [];
  }
  S.sim.seed ||= newSeed();
  setTitle("Spending calculator");
  const ex = exampleGame();
  S.calc.id ||= ex.id;
  // a typical $20 game: the one with the most tickets still unsold
  const twenty = S.games.filter((g) => g.price === 20 && !g.topGone).sort((a, b) => b.tickets_remaining - a.tickets_remaining)[0] || ex;
  S.sim.id ||= twenty.id;
  S.habit.id ||= twenty.id;
  app.innerHTML =
    `<div class="wrap"><h1 class="page-title">Spending calculator</h1>` +
    `<p class="lede">What a sum of money spent on scratch tickets is likely to return — the average, and the range of results people actually get.</p>` +
    `<div class="subnav"><a class="btn" href="#/calculator?s=budget">What $100 looks like</a><a class="btn" href="#/calculator?s=habit">A regular habit</a><a class="btn" href="#/calculator?s=sim">Simulate 20 tickets</a></div>` +
    freshness() +

    `<section class="block" id="budget" aria-labelledby="b-h"><h2 id="b-h">What $100 looks like</h2>` +
    `<div class="form-row"><div class="ctl"><label class="ctl-label" for="cg">Game</label><select id="cg">${gameOptions(S.calc.id)}</select></div>` +
    `<div class="ctl"><span class="ctl-label" id="cm-l">Enter</span><div class="seg" id="cm" role="group" aria-labelledby="cm-l"><button type="button" data-m="budget" aria-pressed="${S.calc.mode === "budget"}">Budget</button><button type="button" data-m="tickets" aria-pressed="${S.calc.mode === "tickets"}">Tickets</button></div></div>` +
    `<div class="ctl"><label class="ctl-label" for="cv" id="cv-l"></label><input type="number" id="cv" min="1" inputmode="numeric" /></div></div>` +
    `<h3 id="c-title"></h3><div id="c-out" aria-live="polite"></div></section>` +

    `<section class="block" id="habit" aria-labelledby="h-h"><h2 id="h-h">What does a regular scratch-ticket habit look like?</h2>` +
    `<div class="form-row"><div class="ctl"><label class="ctl-label" for="hg">Game</label><select id="hg">${gameOptions(S.habit.id)}</select></div>` +
    `<div class="ctl"><label class="ctl-label" for="hn">Tickets</label><input type="number" id="hn" min="1" max="100" value="${S.habit.per}" inputmode="numeric" /></div>` +
    `<div class="ctl"><span class="ctl-label" id="hp-l">per</span><div class="seg" id="hp" role="group" aria-labelledby="hp-l"><button type="button" data-p="week" aria-pressed="${S.habit.period === "week"}">week</button><button type="button" data-p="month" aria-pressed="${S.habit.period === "month"}">month</button></div></div>` +
    `<div class="ctl"><span class="ctl-label" id="hy-l">for</span><div class="seg" id="hy" role="group" aria-labelledby="hy-l">${[1, 5, 10].map((y) => `<button type="button" data-y="${y}" aria-pressed="${S.habit.years === y}">${y} year${y > 1 ? "s" : ""}</button>`).join("")}</div></div></div>` +
    `<div id="h-out" aria-live="polite"></div></section>` +

    `<section class="block" id="sim" aria-labelledby="s-h"><h2 id="s-h">Scratch 20 imaginary tickets</h2>` +
    `<p class="lede">Each run draws 20 simulated tickets from the selected game's estimated prize odds. One run can go either way; keep running and the running total settles toward the expected loss.</p>` +
    `<div class="form-row"><div class="ctl"><label class="ctl-label" for="sg">Game</label><select id="sg">${gameOptions(S.sim.id)}</select></div>` +
    `<button type="button" class="btn primary" id="s-go">Reveal simulated outcomes</button><button type="button" class="btn" id="s-reset">Start over</button></div>` +
    `<div id="s-out" aria-live="polite"></div></section></div>`;

  // budget
  const drawBudget = () => {
    const g = S.byId.get(S.calc.id);
    const budget = S.calc.mode === "budget";
    $("#cv-l").textContent = budget ? "Amount ($)" : "Number of tickets";
    $("#cv").value = budget ? S.calc.amount : S.calc.tickets;
    $("#cv").step = budget ? g.price : 1;
    const n = budget ? Math.max(1, Math.floor(S.calc.amount / g.price)) : Math.max(1, Math.round(S.calc.tickets));
    $("#c-title").textContent = `Spend ${money0(n * g.price)} on $${g.price} ${g.name} tickets`;
    $("#c-out").innerHTML = sessionHtml(g, n, budget ? S.calc.amount : null);
  };
  $("#cg").addEventListener("change", (e) => { S.calc.id = e.target.value; drawBudget(); });
  $("#cm").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.calc.mode = b.dataset.m;
    $$("#cm button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawBudget();
  });
  $("#cv").addEventListener("input", (e) => {
    const v = Math.max(0, +e.target.value || 0);
    if (S.calc.mode === "budget") S.calc.amount = v; else S.calc.tickets = v;
    const g = S.byId.get(S.calc.id);
    const n = S.calc.mode === "budget" ? Math.max(1, Math.floor(v / g.price)) : Math.max(1, Math.round(v));
    $("#c-title").textContent = `Spend ${money0(n * g.price)} on $${g.price} ${g.name} tickets`;
    $("#c-out").innerHTML = sessionHtml(g, n, S.calc.mode === "budget" ? v : null);
  });
  drawBudget();

  // habit
  const drawHabit = () => {
    const g = S.byId.get(S.habit.id);
    const per = Math.max(1, Math.min(100, Math.round(S.habit.per) || 1));
    const r = Calc.habit({ price: g.price, perPeriod: per, period: S.habit.period, years: S.habit.years, evRatio: g.m.ev_ratio });
    const yrs = S.habit.years;
    const card = (v, t) => `<div><span class="v">${v}</span><span class="t">${t}</span></div>`;
    $("#h-out").innerHTML =
      `<h3>${per === 1 ? "One" : per} $${g.price} ticket${per > 1 ? "s" : ""} each ${S.habit.period}</h3>` +
      `<p class="small" style="margin-top:0">${esc(g.name)} currently returns about ${cents(g.m.ev_ratio)} per $1 on average.</p>` +
      `<div class="result-grid">` +
      card(money0(r.spend_year), "spent per year") +
      card(money0(r.prizes_year), "expected prizes per year") +
      card(money0(r.loss_year), "expected loss per year") +
      (yrs > 1 ? card(money0(r.spend_total), `spent over ${yrs} years`) + card(money0(r.loss_total), `expected loss over ${yrs} years`) : "") +
      `</div><p class="small" style="margin-top:8px">Expected figures are long-run averages; any one year can come out higher or lower. Over many tickets, results tend to settle near the average rather than away from it.</p>`;
  };
  $("#hg").addEventListener("change", (e) => { S.habit.id = e.target.value; drawHabit(); });
  $("#hn").addEventListener("input", (e) => { S.habit.per = +e.target.value || 1; drawHabit(); });
  $("#hp").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.habit.period = b.dataset.p;
    $$("#hp button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawHabit();
  });
  $("#hy").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.habit.years = +b.dataset.y;
    $$("#hy button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawHabit();
  });
  drawHabit();

  // simulation
  const drawSim = () => {
    const g = S.byId.get(S.sim.id);
    const runs = S.sim.runs;
    const last = runs[runs.length - 1];
    const cls = (a) => (a === 0 ? "o-none" : a < g.price ? "o-below" : a === g.price ? "o-be" : a >= 10 * g.price ? "o-p3" : a >= 2 * g.price ? "o-p2" : "o-p1");
    const grid = `<div class="sim-grid" role="list" aria-label="20 simulated tickets">${Array.from({ length: 20 }, (_, i) =>
      last ? `<div role="listitem" class="${cls(last.tickets[i])}">${money0(last.tickets[i])}</div>` : `<div role="listitem" aria-label="not revealed">?</div>`).join("")}</div>`;
    if (!last) {
      $("#s-out").innerHTML = grid + `<p class="small">20 tickets × $${g.price} = ${money0(20 * g.price)} per run.</p>`;
      return;
    }
    const spent = runs.length * 20 * g.price;
    const back = runs.reduce((s, r) => s + r.back, 0);
    const card = (v, t) => `<div><span class="v">${v}</span><span class="t">${t}</span></div>`;
    $("#s-out").innerHTML =
      grid +
      `<h3>This run</h3><div class="result-grid">${card(money0(20 * g.price), "spent")}${card(money0(last.back), "returned")}${card((last.back - 20 * g.price >= 0 ? "+" : "") + money0(last.back - 20 * g.price), "net")}</div>` +
      `<h3 style="margin-top:18px">After ${runs.length} run${runs.length > 1 ? "s" : ""} (${commas(runs.length * 20)} tickets)</h3><div class="result-grid">${card(money0(spent), "total spent")}${card(money0(back), "total returned")}${card((back - spent >= 0 ? "+" : "") + money0(back - spent), "net")}${card(money0(spent * (1 - g.m.ev_ratio)), "expected loss for this many tickets")}</div>` +
      `<p class="small" style="margin-top:8px">Simulation seed ${S.sim.seed}, run ${runs.length}. “Start over” picks a new seed; to replay this exact sequence, open <a href="#/calculator?s=sim&amp;seed=${S.sim.seed}">this link</a>.</p>`;
  };
  $("#sg").addEventListener("change", (e) => { S.sim.id = e.target.value; S.sim.runs = []; S.sim.seed = newSeed(); drawSim(); });
  $("#s-go").addEventListener("click", () => {
    const g = S.byId.get(S.sim.id);
    const draw = Calc.sampler(g.dist, Calc.rng((S.sim.seed ^ Math.imul(S.sim.runs.length + 1, 0x9e3779b9)) >>> 0));
    const tickets = Array.from({ length: 20 }, draw);
    S.sim.runs.push({ tickets, back: tickets.reduce((a, b) => a + b, 0) });
    drawSim();
  });
  $("#s-reset").addEventListener("click", () => { S.sim.runs = []; S.sim.seed = newSeed(); drawSim(); });
  drawSim();
}

/* ====================================================================== */
/* LEARN                                                                  */
/* ====================================================================== */
function renderLearn() {
  setTitle("How the odds work");
  const g = exampleGame();
  const quarter = S.games.filter((x) => x.overall_odds && x.overall_odds > 3.5 && x.overall_odds < 4.5)[0];
  app.innerHTML =
    `<div class="wrap prose"><h1 class="page-title">What do these odds actually mean?</h1>` +
    `<p class="lede">A short guide to reading scratch-ticket numbers, using today's data.</p>` +

    `<h2>“1 in 4” doesn't mean every fourth ticket wins</h2>` +
    `<p>It means roughly one quarter of the tickets in the whole print run have that outcome. Prizes are spread through millions of tickets; you could buy ten in a row with nothing, or two prizes back to back.${quarter ? ` ${esc(quarter.name)} prints overall odds of 1 in ${quarter.overall_odds.toFixed(2)} — which also means about ${Math.round(100 - 100 / quarter.overall_odds)} of every 100 tickets pay nothing.` : ""}</p>` +

    `<h2>“Any prize” doesn't necessarily mean profit</h2>` +
    `<p>A prize equal to the ticket price only returns what was spent. For the $${g.price} ${esc(g.name)}, about ${Math.round(g.m.p_any * 100)} in 100 tickets pay some prize — but ${g.three[1]} of those just give the $${g.price} back, leaving ${g.three[2]} in 100 that actually make money.</p>` +
    strip(threeSegs(g.m), { aria: outcomeSentence(g) }) +
    `<ul class="legend"><li><i class="sw o-none"></i>Lose money</li><li><i class="sw o-be"></i>Break even</li><li><i class="sw o-profit"></i>Make money</li></ul>` +

    `<h2>Expected payout isn't a typical payout</h2>` +
    `<p>The expected (average) payout of a $${g.price} ${esc(g.name)} ticket is ${money2(g.m.ev_ticket)}. But the typical ticket — the median — pays ${money0(g.m.median_payout)}. A small number of huge prizes pull the average up: ${(g.m.return_bands.filter((b) => b.key === "10000_plus").reduce((s, b) => s + b.per_100, 0)).toFixed(1)}¢ of every $1 expected back comes from prizes of $10,000 or more, which turn up on about ${oneIn(g.m.return_bands.filter((b) => b.key === "10000_plus").reduce((s, b) => s + b.p, 0))} tickets.</p>` +
    `<p>${EV_HELP}</p>` +

    `<h2>Remaining prizes aren't enough information</h2>` +
    `<p>“10 jackpots remaining” sounds better than “2 jackpots remaining.” But 10 jackpots among 10 million tickets (1 in 1,000,000) is worse than 2 jackpots among 500,000 tickets (1 in 250,000). Always look at how many tickets are left alongside the prizes. That is why this site always shows prize counts next to the estimated number of unsold tickets.</p>` +

    `<h2>“Expected” doesn't mean “guaranteed”</h2>` +
    `<p>If something happens on 1 in 1,000 tickets, buying 1,000 tickets does not guarantee it. It gives only about a 63% chance of seeing it at least once; about 37% of the time it would not happen at all, and sometimes it happens twice. Figures like “one top prize per 387,000 tickets” describe how rare something is, not a price you can pay to get it.</p>` +

    `<h2>Buying more tickets doesn't improve the economics</h2>` +
    `<p>Buying more tickets makes the overall result more predictable around the game's expected return; it does not turn a loss into a gain. Every game on sale returns less than $1 per $1 on average, so the more tickets bought, the more closely the total tends to approach the expected loss. The <a href="#/calculator?s=sim">20-ticket simulation</a> shows this happening.</p>` +

    `<h2>A profitable ticket isn't a profitable habit</h2>` +
    `<p>About ${g.three[2]} in 100 ${esc(g.name)} tickets pay more than they cost, so “I win fairly often” can be true. But on average it takes ${money0(g.price / g.m.p_profit)} of tickets to get each profitable one, and the prizes on those tickets usually don't cover the tickets that paid nothing.</p>` +

    `<h2>Today's odds are estimates</h2>` +
    `<p>${ESTIMATE_HELP} The printed odds describe the whole print run when the game launched; as prizes are claimed, the odds for the tickets that remain shift. <a href="#/methods">How the estimates are made</a>.</p>` +
    `</div>`;
}

/* ====================================================================== */
/* METHODS                                                                */
/* ====================================================================== */
function renderMethods() {
  setTitle("Data & methods");
  const flagged = S.games.filter((g) => g.flags && g.flags.length);
  const q = {};
  S.games.forEach((g) => (q[g.estimate?.label] = (q[g.estimate?.label] || 0) + 1));
  app.innerHTML =
    `<div class="wrap prose"><h1 class="page-title">Data &amp; methods</h1>` +
    `<ul class="toc"><li><a href="#/methods?s=data-h">Data</a></li><li><a href="#/methods?s=tickets-h">Tickets remaining</a></li><li><a href="#/methods?s=formulas-h">Formulas</a></li><li><a href="#/methods?s=limits-h">Limitations</a></li><li><a href="#/methods?s=checks-h">Data checks</a></li><li><a href="#/methods?s=allgames-h">All games</a></li><li><a href="#/methods?s=downloads">Downloads</a></li></ul>` +

    `<h2 id="data-h">Data</h2>` +
    `<p>Two sources published by the New Hampshire Lottery are joined on game number: the <a href="https://www.nhlottery.com/game-collection/in-store?filters=scratchGame">in-store game collection</a> (name, price, print run, overall odds, ticket image) and the <a href="https://www.nhlottery.com/prizes/prizes-remaining">prizes remaining</a> report (for every prize level, the number printed and the number still unclaimed). Both are read once a day and this site is rebuilt from them.</p>` + freshness() +

    `<h2 id="tickets-h">Estimating how many tickets are left</h2>` +
    `<p>The lottery publishes each game's print run but not how many tickets have been sold, so the share still unsold is estimated from the prize counts:</p>` +
    `<pre class="eq">share unsold      = Σ prizes unclaimed ÷ Σ prizes printed\ntickets remaining = tickets printed × share unsold</pre>` +
    `<p>The low prize levels account for nearly all prizes, so this is effectively the share of small prizes not yet claimed, which tracks sales closely. Every “current” figure on the site is built on this estimate.</p>` +
    `<h3>Estimate-quality signal</h3>` +
    `<p>For each game, the share remaining is compared across its high-volume prize levels (those with at least 1,000 printed). If they agree within 5 percentage points the estimate is labelled <em>appears stable</em>; within 12 points, <em>approximate</em>; beyond that, <em>prize redemption pattern unusual</em>; with fewer than two such levels, <em>limited data</em>. This is a descriptive check, not a statistical confidence interval. Today: ${Object.entries(q).map(([k, v]) => `${v} ${esc(k.toLowerCase())}`).join(", ")}.</p>` +

    `<h2 id="formulas-h">Formulas</h2>` +
    `<p>For a game with ticket price C and an estimated T tickets remaining, where prize level j pays A[j] and has R[j] prizes unclaimed:</p>` +
    `<pre class="eq">P[j]           = R[j] ÷ T                      chance one ticket pays A[j]
P(no prize)    = 1 − Σ P[j]
P(lose money)  = P(no prize) + Σ P[j] where A[j] &lt; C
P(break even)  = Σ P[j] where A[j] = C
P(profit)      = Σ P[j] where A[j] &gt; C
P(k× or more)  = Σ P[j] where A[j] ≥ k × C        k = 2, 5, 10
P($X or more)  = Σ P[j] where A[j] ≥ X            X = 50, 100, 500, 1,000, 10,000

expected payout        = Σ A[j] × P[j]
return per $1          = expected payout ÷ C
expected loss          = C − expected payout
expected loss per $100 = 100 × (1 − return per $1)
median / percentiles   = smallest payout whose cumulative probability (with $0 included) reaches 50%, 10%, 90%…
most likely outcome    = the payout with the highest probability
spend per occurrence   = C ÷ P(event)          an average frequency, not a guarantee</pre>` +
    `<p>“Printed” figures use the same formulas with every prize printed and the full print run. The spending calculator treats each ticket as an independent draw from the one-ticket distribution and adds them up exactly (a convolution on a grid of dollar amounts), which is a close approximation because a buyer's purchase is tiny next to the pool of unsold tickets.</p>` +

    `<h2 id="limits-h">Limitations</h2><ul>` +
    `<li>All current figures are estimates. They assume unsold tickets carry prizes in the same proportion as the unclaimed pool, which the lottery does not guarantee.</li>` +
    `<li><strong>Unclaimed is not the same as available.</strong> An unclaimed prize may be on an unsold ticket, on a ticket that has been bought but not yet scratched, or on a scratched winner that has not been redeemed. So “prizes remaining” does not literally mean winning tickets still sitting in stores, and current odds look slightly better than they really are.</li>` +
    `<li>Prizes paid as annuities or non-cash items are counted at their stated dollar value.</li>` +
    `<li>The lottery can keep selling a game after its top prizes are gone; such games are marked “top prize no longer available”.</li></ul>` +

    `<h2 id="checks-h">Data checks</h2>` +
    `<p>Every daily build verifies, for each game: all probabilities lie between 0 and 1; lose, break-even and profit add up to 100%; the expected payout recomputed from the prize levels matches the stored value; expected loss matches expected payout; no level has more prizes unclaimed than printed; the no-prize share is not negative; ticket price and estimated tickets remaining are positive; and the advertised top prize matches the prize table. The daily snapshots are also compared day to day: a game changing name or price, a printed count changing, or an unclaimed count going up is flagged as a possible source correction. A game that fails is still shown, with a warning on its page.</p>` +
    `<p>${flagged.length ? `Games currently flagged: ${flagged.map((g) => `<a href="#/game/${esc(g.id)}">${esc(g.name)}</a>`).join(", ")}.` : "No game is currently flagged."}</p>` +

    `<h2 id="allgames-h">All games: where the remaining prize money goes</h2>` +
    `<p>All unclaimed prize money across current games, divided by the size of the individual prize.</p>` +
    allGamesMoney() +

    `<h2 id="downloads">Downloads &amp; history</h2>` +
    `<p><a href="data/prizes.csv" download>prizes.csv</a> — one row per prize level with printed and unclaimed counts and the derived figures.<br>` +
    `<a href="data.json">data.json</a> — everything the site displays, including every derived statistic per game.<br>` +
    `<a href="data/history.json">history.json</a> — daily time series per game, used for the “How this game has changed” charts.</p>` +
    `<p>Each daily run also stores a snapshot of every game's prize table in the repository's <code>data/history/</code> folder, one CSV per day. Snapshots are kept exactly as observed and are never regenerated from later data.</p>` +
    `<p class="small">Independent analysis of public data. Not affiliated with or endorsed by the New Hampshire Lottery Commission.</p></div>`;
}

function allGamesMoney() {
  const BUCKETS = [
    [1, 9, "$1–$9"], [10, 49, "$10–$49"], [50, 99, "$50–$99"], [100, 499, "$100–$499"], [500, 999, "$500–$999"],
    [1000, 9999, "$1,000–$9,999"], [10000, 99999, "$10,000–$99,999"], [100000, Infinity, "$100,000 and up"],
  ];
  const sums = BUCKETS.map(() => ({ dollars: 0, count: 0 }));
  S.games.forEach((g) =>
    g.prizes.forEach((p) => {
      const i = BUCKETS.findIndex(([a, b]) => p.prize >= a && p.prize <= b);
      if (i < 0) return;
      sums[i].dollars += p.prize * p.remaining;
      sums[i].count += p.remaining;
    })
  );
  const total = sums.reduce((s, b) => s + b.dollars, 0) || 1;
  const max = Math.max(...sums.map((b) => b.dollars));
  return (
    `<ul class="decomp">` +
    BUCKETS.map(([, , label], i) => {
      const share = sums[i].dollars / total;
      return `<li><span class="v">${pct(share)}</span><span>${label}<span class="mbar" style="margin-top:4px;height:10px" aria-hidden="true"><span class="r" style="width:${(sums[i].dollars / max) * 100}%"></span></span></span><span class="f">${moneyBig(sums[i].dollars)} · ${commas(sums[i].count)} prizes</span></li>`;
    }).join("") +
    `<li class="total"><span class="v">100%</span><span>All unclaimed prize money</span><span class="f">${moneyBig(total)}</span></li></ul>`
  );
}
