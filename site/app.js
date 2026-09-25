/* NH scratch ticket odds — front end. Vanilla JS, no build step. Reads data.json. */

const THRESHOLDS = [100, 500, 1000];

const state = {
  games: [],
  price: "all",
  search: "",
  hideNoTop: false,
  sort: { key: "ev", dir: -1 },
  open: new Set(),
  fig1: 100,
};

const $ = (s, root = document) => root.querySelector(s);

/* ---------------- formatting ---------------- */
const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const moneyShort = (n) => {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e9) return "$" + trim(n / 1e9, 1) + "B";
  if (n >= 1e6) return "$" + trim(n / 1e6, 1) + "M";
  if (n >= 1e4) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
};
const numShort = (n) => {
  if (n == null) return "—";
  if (n >= 1e6) return trim(n / 1e6, 2) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "K";
  return Math.round(n).toLocaleString("en-US");
};
const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, "");
const oddsText = (n) => {
  if (n == null) return "—";
  if (n < 10) return "1 in " + n.toFixed(2);
  if (n < 100) return "1 in " + n.toFixed(1);
  return "1 in " + numShort(n);
};
const oddsLong = (n) => (n == null ? "—" : "1 in " + (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : fmt(n)));
const dollars = (x) => (x == null ? "—" : "$" + x.toFixed(2));
const pct = (x, d = 0) => (x == null ? "—" : (x * 100).toFixed(d) + "%");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- statistics ----------------
   Every figure below is derived from each game's prize tiers in data.json:
   {prize, total, remaining}. See the Methods tab for the formulas. */

/* Live odds (as N in "1 in N") of winning at least $t on one ticket bought now.
   null  -> the game has no prize that large at all
   Infinity -> it had some, but every one has been claimed */
function oddsAtLeast(g, t) {
  const tiers = g.prizes.filter((p) => p.prize >= t);
  if (!tiers.length) return null;
  if (!g.tickets_remaining) return null;
  const p = tiers.reduce((s, x) => s + x.remaining / g.tickets_remaining, 0);
  return p > 0 ? 1 / p : Infinity;
}

function topTier(g) {
  return g.prizes.reduce((a, b) => (b.prize > a.prize ? b : a), g.prizes[0]);
}

function derive(g) {
  const top = topTier(g);
  g._top = top;
  g._topGone = top.remaining === 0;
  g._odds = {};
  [...THRESHOLDS, 10000].forEach((t) => (g._odds[t] = oddsAtLeast(g, t)));
  g._search = (g.name + " " + g.game_number).toLowerCase();
}

/* sort keys; null/Infinity always sink to the bottom whatever the direction */
const SORTS = {
  name: (g) => g.name.toLowerCase(),
  price: (g) => g.price,
  top: (g) => g._top.prize,
  unsold: (g) => g.percent_unsold,
  overall: (g) => g.overall_odds,
  o100: (g) => g._odds[100],
  o500: (g) => g._odds[500],
  o1000: (g) => g._odds[1000],
  ev: (g) => g.ev_now,
};
/* the direction a fresh click on each heading starts with (best first) */
const FIRST_DIR = { name: 1, price: -1, top: -1, unsold: -1, overall: 1, o100: 1, o500: 1, o1000: 1, ev: -1 };

/* ---------------- init ---------------- */
init();

async function init() {
  let data;
  try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (e) {
    $("#asof").textContent = "The data file could not be loaded.";
    showStatus("The data file could not be loaded. Try again later.");
    return;
  }
  state.games = (data.games || []).filter((g) => g.prizes && g.prizes.length);
  state.games.forEach(derive);

  const when = new Date(data.generated_at);
  const whenTxt = isNaN(when)
    ? data.generated_at
    : when.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "America/New_York" }) + " ET";
  const src = data.prizes_last_updated ? new Date(data.prizes_last_updated) : null;
  $("#asof").textContent =
    "Data retrieved " + whenTxt +
    (src && !isNaN(src) ? " · prize counts as of " + src.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" }) : "");
  $("#foot-asof").textContent = "Retrieved " + whenTxt;

  buildSummary();
  buildControls();
  wireTabs();
  renderTable();
}

function showStatus(msg) {
  const s = $("#status");
  s.hidden = !msg;
  s.textContent = msg || "";
}

/* ---------------- summary strip ---------------- */
function median(xs) {
  const a = xs.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function buildSummary() {
  const G = state.games;
  const gone = G.filter((g) => g._topGone).length;
  const best100 = G.filter((g) => g._odds[100] && isFinite(g._odds[100])).sort((a, b) => a._odds[100] - b._odds[100])[0];
  const items = [
    [G.length, "games on sale analyzed"],
    [dollars(median(G.map((g) => g.ev_now))), "median expected return per $1"],
    [`${gone} of ${G.length}`, "games with no top prize left"],
    [best100 ? oddsText(best100._odds[100]) : "—", best100 ? `best odds of $100+ (${best100.name}, $${best100.price})` : "best odds of $100+"],
  ];
  $("#summary").innerHTML = items.map(([v, l]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`).join("");
}

/* ---------------- controls ---------------- */
function buildControls() {
  const prices = [...new Set(state.games.map((g) => g.price))].sort((a, b) => a - b);
  const seg = $("#price-filter");
  seg.innerHTML =
    `<button data-p="all" aria-pressed="true">All</button>` +
    prices.map((p) => `<button data-p="${p}" aria-pressed="false">$${p}</button>`).join("");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.price = b.dataset.p;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderTable();
  });

  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderTable();
  });
  $("#hide-no-top").addEventListener("change", (e) => {
    state.hideNoTop = e.target.checked;
    renderTable();
  });

  document.querySelectorAll(".games th[data-sort]").forEach((th) => {
    th.tabIndex = 0;
    const go = () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: FIRST_DIR[k] };
      renderTable();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });
}

/* ---------------- table ---------------- */
function visibleGames() {
  const { price, search, hideNoTop, sort } = state;
  const key = SORTS[sort.key];
  const bad = (v) => v == null || (typeof v === "number" && !isFinite(v));
  return state.games
    .filter((g) => price === "all" || String(g.price) === price)
    .filter((g) => !search || g._search.includes(search))
    .filter((g) => !hideNoTop || !g._topGone)
    .sort((a, b) => {
      const x = key(a), y = key(b);
      if (bad(x) && bad(y)) return 0;
      if (bad(x)) return 1;
      if (bad(y)) return -1;
      const c = x < y ? -1 : x > y ? 1 : 0;
      return c * sort.dir || b.price - a.price;
    });
}

function renderTable() {
  document.querySelectorAll(".games th[data-sort]").forEach((th) => {
    if (th.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });

  const rows = visibleGames();
  $("#row-count").textContent = `${rows.length} of ${state.games.length} shown`;
  const body = $("#games-body");
  body.innerHTML = rows.map(rowHtml).join("");
  showStatus(rows.length ? "" : "No games match these filters.");

  body.querySelectorAll("tr.row").forEach((tr) => {
    const toggle = () => {
      const id = tr.dataset.id;
      if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
      renderTable();
    };
    tr.addEventListener("click", (e) => { if (!e.target.closest("a")) toggle(); });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
  body.querySelectorAll("img").forEach((img) =>
    img.addEventListener("error", () => img.remove(), { once: true })
  );
}

function oddsCell(g, t) {
  const n = g._odds[t];
  if (n == null) return `<td class="num"><span class="na" title="No prize of $${fmt(t)} or more in this game">n/a</span></td>`;
  if (!isFinite(n)) return `<td class="num"><span class="gone" title="Every prize of $${fmt(t)}+ has been claimed">none left</span></td>`;
  const spend = n * g.price;
  return (
    `<td class="num"><span title="${oddsLong(n)}">${oddsText(n)}</span>` +
    `<span class="spend" title="Average spent on tickets per $${fmt(t)}+ win">${moneyShort(spend)} / win</span></td>`
  );
}

function rowHtml(g) {
  const id = String(g.game_number || g.identifier);
  const open = state.open.has(id);
  const top = g._top;
  const d = g.ev_now != null && g.ev_printed != null ? g.ev_now - g.ev_printed : null;
  const dCls = d == null || Math.abs(d) < 0.005 ? "" : d < 0 ? "delta-down" : "delta-up";
  const thumb = g.thumb_url || g.image_url;
  const row =
    `<tr class="row" data-id="${esc(id)}" tabindex="0" aria-expanded="${open}">` +
      `<td class="c-game"><div class="g-wrap">` +
        (thumb ? `<img class="g-thumb" src="${esc(thumb)}" alt="" loading="lazy" />` : "") +
        `<div><span class="g-name">${esc(g.name)}</span>` +
        `<span class="g-no">${g.game_number ? "No. " + esc(g.game_number) : ""}${g.on_sale ? " · since " + esc(shortDate(g.on_sale)) : ""}</span>` +
        (g._topGone ? `<span class="g-flag">top prize claimed</span>` : "") +
        `</div></div></td>` +
      `<td class="num">$${g.price}</td>` +
      `<td class="num">${moneyShort(top.prize)}<span class="spend${top.remaining ? "" : " gone"}">${fmt(top.remaining)} / ${fmt(top.total)}</span></td>` +
      `<td class="num">${numShort(g.tickets_remaining)}<span class="spend">${pct(g.percent_unsold / 100)}</span></td>` +
      `<td class="num">${g.overall_odds ? "1 in " + g.overall_odds.toFixed(2) : "—"}</td>` +
      THRESHOLDS.map((t) => oddsCell(g, t)).join("") +
      `<td class="num">${dollars(g.ev_printed)} &rarr; <strong>${dollars(g.ev_now)}</strong>` +
        `<span class="spend ${dCls}">${d == null ? "" : (d >= 0 ? "+" : "−") + Math.abs(d * 100).toFixed(1) + "¢"}</span></td>` +
    `</tr>`;
  return open ? row + detailHtml(g) : row;
}

function shortDate(s) {
  const d = new Date(s + "T12:00:00");
  return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function detailHtml(g) {
  const top = g._top;
  const topOdds = top.remaining ? g.tickets_remaining / top.remaining : null;
  const unclaimed = g.prizes.reduce((s, p) => s + p.prize * p.remaining, 0);
  const stats = [
    ["Tickets printed", fmt(g.tickets_printed)],
    ["Est. tickets unsold", `${fmt(g.tickets_remaining)} (${pct(g.percent_unsold / 100, 1)})`],
    ["Prize money unclaimed", money(unclaimed)],
    ["Top prize, live odds", topOdds ? oddsLong(topOdds) : "all claimed"],
    ["Cost to expect a top prize", topOdds ? moneyShort(topOdds * g.price) : "—"],
    ["$10,000+ prize, live odds", g._odds[10000] == null ? "n/a" : isFinite(g._odds[10000]) ? oddsLong(g._odds[10000]) : "none left"],
  ];
  const maxPrize = top.prize;
  const tiers = [...g.prizes].sort((a, b) => b.prize - a.prize).map((p) => {
    const live = p.remaining ? g.tickets_remaining / p.remaining : null;
    const share = p.total ? p.remaining / p.total : 0;
    return (
      `<tr class="${p.prize === maxPrize ? "top" : ""}${p.remaining ? "" : " claimed"}">` +
        `<td>${money(p.prize)}</td>` +
        `<td class="num">${p.odds_printed ? oddsLong(p.odds_printed) : "—"}</td>` +
        `<td class="num">${live ? oddsLong(live) : "all claimed"}</td>` +
        `<td class="num">${fmt(p.remaining)}</td>` +
        `<td class="num">${fmt(p.total)}</td>` +
        `<td class="num"><span class="bar" aria-hidden="true"><i style="width:${(share * 100).toFixed(1)}%"></i></span> ${pct(share)}</td>` +
      `</tr>`
    );
  }).join("");
  const img = g.image_url
    ? `<img src="${esc(g.image_url)}" alt="${esc(g.name)} ticket" loading="lazy" />`
    : `<p class="noimg">No image published.</p>`;
  return (
    `<tr class="detail"><td colspan="9"><div class="detail-grid">` +
      `<div class="detail-img">${img}</div>` +
      `<div>` +
        `<dl class="detail-stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>` +
        `<h3>Prize levels</h3>` +
        `<div class="table-scroll" style="border-width:1px"><table class="tiers">` +
          `<thead><tr><th>Prize</th><th class="num">Printed odds</th><th class="num">Live odds</th><th class="num">Unclaimed</th><th class="num">Printed</th><th class="num">Share left</th></tr></thead>` +
          `<tbody>${tiers}</tbody></table></div>` +
        `<p class="links">` +
          (g.page_url ? `<a href="${esc(g.page_url)}" target="_blank" rel="noopener">Game page at nhlottery.com</a>` : "") +
        `</p>` +
      `</div>` +
    `</div></td></tr>`
  );
}

/* ---------------- tabs ---------------- */
let figuresBuilt = false;

function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  const show = (view, push) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", t.dataset.view === view));
    ["table", "figures", "methods"].forEach((v) => ($("#view-" + v).hidden = v !== view));
    if (view === "figures") {
      if (!figuresBuilt) { buildFigures(); figuresBuilt = true; } else redrawFigures();
    }
    if (push) history.replaceState(null, "", "#" + view);
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.view, true)));
  const initial = location.hash.slice(1);
  show(["table", "figures", "methods"].includes(initial) ? initial : "table", false);
}

/* ---------------- figures ---------------- */
const NS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

const tipEl = () => $("#tip");
function tipOn(node, html) {
  const move = (e) => {
    const t = tipEl();
    t.innerHTML = html;
    t.classList.add("show");
    const pad = 12, w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
  };
  node.addEventListener("mousemove", move);
  node.addEventListener("mouseleave", () => tipEl().classList.remove("show"));
  node.addEventListener("touchstart", (e) => move(e.touches[0]), { passive: true });
}

let resizeTimer;
function buildFigures() {
  const seg = $("#fig1-threshold");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.fig1 = +b.dataset.t;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawFig1();
  });
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!$("#view-figures").hidden) redrawFigures(); }, 150);
  });
  redrawFigures();
  buildJackpotTable();
}

function redrawFigures() {
  drawFig1();
  drawFig2();
  drawFig3();
}

/* Games grouped by ticket price (high to low), for the dot charts. */
function grouped(valueOf, asc) {
  const prices = [...new Set(state.games.map((g) => g.price))].sort((a, b) => b - a);
  return prices.map((p) => ({
    price: p,
    games: state.games
      .filter((g) => g.price === p)
      .sort((a, b) => {
        const x = valueOf(a), y = valueOf(b);
        const bx = x == null || !isFinite(x), by = y == null || !isFinite(y);
        if (bx || by) return bx - by;
        return asc ? x - y : y - x;
      }),
  }));
}

/* Shared layout for a Cleveland dot chart: one labelled row per game, grouped by price. */
function dotFrame(host, groups, { domain, ticks, tickFmt, log }) {
  host.replaceChildren();
  const W = Math.max(320, host.clientWidth);
  const narrow = W < 560;
  const labelW = narrow ? 128 : 230;
  const rowH = 17, groupGap = 24, top = 26, right = 18;
  const nRows = groups.reduce((s, g) => s + g.games.length, 0);
  const H = top + nRows * rowH + groups.length * groupGap + 8;
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const x0 = labelW, x1 = W - right;
  const [d0, d1] = log ? domain.map(Math.log10) : domain;
  const x = (v) => x0 + ((log ? Math.log10(v) : v) - d0) / (d1 - d0) * (x1 - x0);

  ticks.forEach((t) => {
    const xx = x(t);
    svg.append(S("line", { class: "grid", x1: xx, x2: xx, y1: top - 6, y2: H - 4 }));
    svg.append(S("text", { x: xx, y: top - 12, "text-anchor": "middle" }, tickFmt(t)));
  });

  const rows = [];
  let y = top;
  groups.forEach((grp) => {
    if (!grp.games.length) return;
    y += groupGap;
    svg.append(S("text", { class: "lbl", x: 0, y: y - 7, "font-weight": 600 }, `$${grp.price} tickets`));
    svg.append(S("line", { class: "axis", x1: 0, x2: x1, y1: y - 3, y2: y - 3 }));
    grp.games.forEach((g, i) => {
      const cy = y + i * rowH + rowH / 2;
      if (i % 2 === 1) svg.append(S("rect", { class: "band", x: 0, y: cy - rowH / 2, width: x1, height: rowH }));
      const maxChars = narrow ? 18 : 32;
      const name = g.name.length > maxChars ? g.name.slice(0, maxChars - 1) + "…" : g.name;
      svg.append(S("text", { class: "lbl", x: 0, y: cy + 4 }, name));
      rows.push({ g, cy });
    });
    y += grp.games.length * rowH;
  });
  host.append(svg);
  return { svg, x, x0, x1, rows };
}

function drawFig1() {
  const t = state.fig1;
  const val = (g) => g._odds[t];
  const groups = grouped(val, true);
  const finite = state.games.map(val).filter((v) => v != null && isFinite(v));
  if (!finite.length) { $("#fig1").textContent = "No game has a prize this large."; return; }
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...finite))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...finite))));
  const ticks = [];
  for (let v = lo; v <= hi; v *= 10) ticks.push(v);
  const f = dotFrame($("#fig1"), groups, {
    domain: [lo, hi], ticks, log: true,
    tickFmt: (v) => "1 in " + numShort(v),
  });
  f.rows.forEach(({ g, cy }) => {
    const v = val(g);
    if (v == null) {
      f.svg.append(S("text", { x: f.x0 + 4, y: cy + 4 }, `no $${fmt(t)}+ prize`));
      return;
    }
    if (!isFinite(v)) {
      f.svg.append(S("text", { x: f.x0 + 4, y: cy + 4, fill: "var(--bad)" }, "all claimed"));
      return;
    }
    const c = S("circle", { class: "dot", cx: f.x(v), cy, r: 4.5 });
    tipOn(c, `<strong>${esc(g.name)}</strong> · $${g.price}<br>$${fmt(t)}+ prize: ${oddsLong(v)}<br>≈ ${money(v * g.price)} spent per win`);
    f.svg.append(c);
  });
}

function drawFig2() {
  const val = (g) => g.ev_now;
  const groups = grouped(val, false);
  const all = state.games.flatMap((g) => [g.ev_now, g.ev_printed]).filter((v) => v != null);
  const lo = Math.max(0, Math.floor(Math.min(...all) * 10) / 10);
  const hi = Math.max(1.0, Math.ceil(Math.max(...all) * 10) / 10);
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.1) ticks.push(+v.toFixed(2));
  const f = dotFrame($("#fig2"), groups, { domain: [lo, hi], ticks, log: false, tickFmt: (v) => "$" + v.toFixed(2) });
  const top = 26;
  const bx = f.x(1);
  f.svg.insertBefore(S("line", { class: "ref", x1: bx, x2: bx, y1: top - 6, y2: f.svg.viewBox.baseVal.height - 4 }), f.svg.firstChild);
  f.rows.forEach(({ g, cy }) => {
    if (g.ev_now == null || g.ev_printed == null) return;
    const a = f.x(g.ev_printed), b = f.x(g.ev_now);
    f.svg.append(S("line", { class: "link", x1: a, x2: b, y1: cy, y2: cy }));
    f.svg.append(S("circle", { class: "hollow", cx: a, cy, r: 4 }));
    const c = S("circle", { class: "dot", cx: b, cy, r: 4.5 });
    tipOn(c, `<strong>${esc(g.name)}</strong> · $${g.price}<br>Printed: ${dollars(g.ev_printed)} per $1<br>Now: ${dollars(g.ev_now)} per $1`);
    f.svg.append(c);
  });
}

const BUCKETS = [
  [1, 9, "$1–$9"],
  [10, 49, "$10–$49"],
  [50, 99, "$50–$99"],
  [100, 499, "$100–$499"],
  [500, 999, "$500–$999"],
  [1000, 9999, "$1,000–$9,999"],
  [10000, 99999, "$10,000–$99,999"],
  [100000, Infinity, "$100,000 and up"],
];

function drawFig3() {
  const host = $("#fig3");
  host.replaceChildren();
  const sums = BUCKETS.map(() => ({ dollars: 0, count: 0 }));
  state.games.forEach((g) =>
    g.prizes.forEach((p) => {
      const i = BUCKETS.findIndex(([a, b]) => p.prize >= a && p.prize <= b);
      if (i < 0) return;
      sums[i].dollars += p.prize * p.remaining;
      sums[i].count += p.remaining;
    })
  );
  const total = sums.reduce((s, b) => s + b.dollars, 0) || 1;
  const W = Math.max(320, host.clientWidth);
  const narrow = W < 560;
  const labelW = narrow ? 104 : 140, countW = narrow ? 70 : 110, rowH = 28, top = 8;
  const H = top + BUCKETS.length * rowH + 8;
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const x0 = labelW, x1 = W - countW - 44;
  const maxShare = Math.max(...sums.map((b) => b.dollars / total));
  BUCKETS.forEach(([, , label], i) => {
    const y = top + i * rowH;
    const share = sums[i].dollars / total;
    const w = maxShare ? (share / maxShare) * (x1 - x0) : 0;
    svg.append(S("text", { class: "lbl", x: 0, y: y + rowH / 2 + 4 }, label));
    const r = S("rect", { class: "barfill", x: x0, y: y + 5, width: Math.max(0.5, w), height: rowH - 10 });
    tipOn(r, `<strong>${label}</strong><br>${money(sums[i].dollars)} unclaimed (${pct(share, 1)})<br>${fmt(sums[i].count)} prizes`);
    svg.append(r);
    svg.append(S("text", { class: "val", x: x0 + w + 6, y: y + rowH / 2 + 4 }, pct(share, 1)));
    svg.append(S("text", { x: W, y: y + rowH / 2 + 4, "text-anchor": "end" }, numShort(sums[i].count) + " prizes"));
  });
  host.append(svg);
}

function buildJackpotTable() {
  const rows = state.games
    .filter((g) => g._top.remaining > 0 && g.tickets_remaining)
    .map((g) => ({ g, odds: g.tickets_remaining / g._top.remaining }))
    .sort((a, b) => b.odds - a.odds);
  $("#jackpots tbody").innerHTML = rows
    .map(({ g, odds }) =>
      `<tr><td>${esc(g.name)} <span class="g-no" style="display:inline">$${g.price}</span></td>` +
      `<td class="num">${money(g._top.prize)}</td>` +
      `<td class="num">${fmt(g._top.remaining)} of ${fmt(g._top.total)}</td>` +
      `<td class="num">${oddsLong(odds)}</td>` +
      `<td class="num">${moneyShort(odds * g.price)}</td>` +
      `<td class="num">${fmt(odds / 365)}</td></tr>`
    )
    .join("");
}
