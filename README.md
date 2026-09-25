# NH Scratch Ticket Odds

A small, self-updating static site with the **live odds of every prize** on New Hampshire
Lottery scratch tickets, and the odds of clearing $100, $500 and $1,000. It's rebuilt every
day from the lottery's own prizes-remaining data.

The lottery prints the odds of winning *anything*, and most of those wins are the ticket
price or less. This site uses the lottery's counts of prizes printed and still unclaimed to
estimate what a ticket bought today is actually likely to pay out.

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
live odds (level) = tickets remaining ÷ that prize still unclaimed
P(win ≥ $X)       = Σ over levels ≥ X of unclaimed ÷ tickets remaining
return per $1     = Σ(prize × unclaimed) ÷ (tickets remaining × price)   (printed version uses totals)
```

The site has three views:

- **Table 1.** A sortable table of every game with live $100+/$500+/$1,000+ odds and the
  average spend per win. Click a row to see the full prize ladder.
- **Figures.** Live odds by threshold, return per dollar (printed vs. now), where the prize
  money goes, and what it would take to expect one top prize.
- **Methods.** The formulas above, limitations, and download links.

## Layout

```
scraper/
  scrape.py            fetch + compute -> site/data.json, site/data/prizes.csv
  record_snapshot.py   daily copy -> data/history/YYYY-MM-DD.csv
  stamp_assets.py      cache-busts CSS/JS URLs at deploy time
site/                  the static site (no build step)
  index.html  styles.css  app.js
  data.json            generated; committed so the site works before the first CI run
.github/workflows/
  update.yml           daily scrape + deploy to GitHub Pages
```

## Run locally

```bash
python3 -m venv .venv
./.venv/bin/pip install -r scraper/requirements.txt
./.venv/bin/python scraper/scrape.py            # refresh site/data.json
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
