# NH Scratch Ticket Odds

A small, self-updating static site that answers one question for every New Hampshire
Lottery scratch game: **if I buy this ticket, what is actually likely to happen to my money?**
It's rebuilt every day from the lottery's own prizes-remaining data.

The lottery prints the odds of winning *anything*, and many of those "wins" only pay back the
ticket price. This site splits every ticket into **lose money / break even / make money**,
and reports expected payout, expected loss per $100, how typical and average payouts differ,
and how each game has changed since launch.

## Data sources

All three are public endpoints that nhlottery.com calls from the browser:

| Source | Provides |
| --- | --- |
| `nhlottery.com/api/v1/game/collection?identifier=in-store` | name, price, overall odds, **tickets ordered** (print run), on-sale date, ticket images, page link |
| `prod.game-data.gambytservices.com/v1/instant-games` | 4-digit game number |
| `prod.game-data.gambytservices.com/v1/instant-game/prizes-remaining` | per prize level: printed and still unclaimed (the data behind the site's "Download CSV" button) |

The game-data service needs the `X-API-Key` that nhlottery.com ships in its public
JavaScript bundle. The scraper reads it from the bundle on each run and falls back to the
last known value. If it ever changes and can't be read, set the `NH_GAME_DATA_API_KEY`
environment variable.

## What's computed

```
share unsold      = Σ prizes unclaimed ÷ Σ prizes printed
tickets remaining = tickets ordered × share unsold
P(prize j)        = unclaimed at j ÷ tickets remaining
P(lose / break even / profit) = Σ P(j) for prizes below / equal to / above the ticket price
P(k× or more)     = Σ P(j) for prizes ≥ k × price          (k = 2, 5, 10)
expected payout   = Σ prize × P(j);   loss per $100 = 100 × (1 − payout ÷ price)
```

plus median, most likely and percentile payouts, the split of expected payout by prize
size, an estimate-quality signal, and the same figures "as printed" for comparison. The
formulas live in `scraper/metrics.py`; the Methods page on the site explains them.

Pages (hash routes, so it stays a plain static deploy): `#/` comparison dashboard,
`#/game/<number>` single game, `#/compare?g=a,b,c`, `#/calculator` (budget, habit and
20-ticket simulation), `#/learn`, `#/methods`.

## Layout

```
scraper/
  scrape.py            fetch + compute -> site/data.json, site/data/prizes.csv
  metrics.py           buyer-outcome statistics, estimate quality, validation flags
  record_snapshot.py   daily copy -> data/history/YYYY-MM-DD.csv
  build_history.py     data/history/*.csv -> site/data/history.json (+ history checks)
  stamp_assets.py      cache-busts CSS/JS URLs at deploy time
site/                  the static site (no build step)
  index.html  styles.css  calc.js (pure math)  app.js (pages)
  data.json            generated; committed so the site works before the first CI run
tests/
  test_metrics.py      formulas + checks on the published data   (python -m unittest discover -s tests)
  calc.test.mjs        session maths, simulation, number wording   (node --test tests/calc.test.mjs)
.github/workflows/
  update.yml           daily scrape + history + tests + deploy to GitHub Pages
```

## Run locally

```bash
python3 -m venv .venv
./.venv/bin/pip install -r scraper/requirements.txt
./.venv/bin/python scraper/scrape.py            # refresh site/data.json
./.venv/bin/python scraper/build_history.py     # refresh site/data/history.json
python3 -m http.server -d site 8765             # open http://localhost:8765
```

`scrape.py --save-raw DIR` keeps the raw API responses, and `--from-dir DIR` rebuilds from
them without going online.

## Deploying

1. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**.
2. The **Refresh data & deploy** workflow runs on every push to `main`, daily at 11:23 UTC,
   and on demand (**Actions → Refresh data & deploy → Run workflow**).
3. Scheduled and manual runs also commit that day's snapshot to `data/history/`.

## Caveats

These are estimates. They assume the unsold tickets carry prizes in the same proportion as
the unclaimed pool, which the lottery doesn't guarantee, and an "unclaimed" prize may already
be sitting uncashed in someone's drawer. Not affiliated with or endorsed by the New Hampshire
Lottery Commission.
