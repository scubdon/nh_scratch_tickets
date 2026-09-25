#!/usr/bin/env python3
"""
New Hampshire Lottery scratch-ticket odds scraper.

Everything comes from the same public endpoints the nhlottery.com website itself
calls from the browser:

  1. Game catalog (nhlottery.com CMS API) -> name, price, overall odds, tickets
     ordered (the print run), on-sale date, ticket images, page link.
       https://www.nhlottery.com/api/v1/game/collection?identifier=in-store
  2. Instant-game list (the lottery's game-data service) -> the 4-digit game number.
       https://prod.game-data.gambytservices.com/v1/instant-games
  3. Prizes remaining (same service; this is what the site's "Download CSV" button
     exports) -> for every prize level: number printed and number still unclaimed.
       https://prod.game-data.gambytservices.com/v1/instant-game/prizes-remaining

The game-data service wants the X-API-Key header that nhlottery.com ships in its
public JavaScript bundle. We read it out of the bundle on each run (so a rotated key
is picked up automatically) and fall back to the last known value.

What we derive per game (see the Methods tab on the site):

    tickets_printed   = tickets ordered, as published (fallback: overall odds x prizes printed)
    percent_unsold    = 100 x (sum of prizes unclaimed) / (sum of prizes printed)
    tickets_remaining = tickets_printed x percent_unsold / 100
    odds_printed      = tickets_printed / prizes printed at that level
    odds_live         = tickets_remaining / prizes still unclaimed at that level
    ev_printed        = sum(prize x printed)   / (tickets_printed   x price)
    ev_now            = sum(prize x unclaimed) / (tickets_remaining x price)

Outputs:
    site/data.json        consumed by the static front end
    site/data/prizes.csv  flat per-prize-level table, offered as a download

Usage:
    python scraper/scrape.py                 # fetch live data
    python scraper/scrape.py --from-dir DIR  # rebuild from saved raw JSON (offline)
    python scraper/scrape.py --save-raw DIR  # also keep the raw responses
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
OUT_JSON = os.path.join(SITE, "data.json")
OUT_CSV = os.path.join(SITE, "data", "prizes.csv")

NH_BASE = "https://www.nhlottery.com"
COLLECTION_URL = f"{NH_BASE}/api/v1/game/collection?identifier=in-store&platform=web&cmsPreview=false"
PRIZES_PAGE = f"{NH_BASE}/prizes/prizes-remaining"

# Last known values from the site bundle; used only if they can't be read live.
FALLBACK_GAME_DATA_BASE = "https://prod.game-data.gambytservices.com"
FALLBACK_GAME_DATA_KEY = "1c4c69db-274c-4f59-95c5-3211cd74e9d8"

EASTERN = ZoneInfo("America/New_York")

session = requests.Session()
session.headers.update(
    {
        "User-Agent": (
            "Mozilla/5.0 (compatible; nh-scratch-odds/1.0; public-data aggregator; "
            "+https://github.com/scubdon/nh_scratch_tickets)"
        ),
        "Accept": "application/json, text/plain, */*",
        "Referer": NH_BASE + "/",
        "Origin": NH_BASE,
    }
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def get(url: str, *, headers: dict | None = None, as_json: bool = True, retries: int = 3):
    last: Exception | None = None
    for _ in range(retries):
        try:
            r = session.get(url, headers=headers, timeout=45)
            r.raise_for_status()
            return r.json() if as_json else r.text
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"failed to fetch {url}: {last}")


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #
def game_data_config() -> tuple[str, str]:
    """(base URL, API key) for the game-data service, read from the site's JS bundle."""
    base, key = FALLBACK_GAME_DATA_BASE, FALLBACK_GAME_DATA_KEY
    try:
        html = get(PRIZES_PAGE, as_json=False)
        scripts = re.findall(r'<script[^>]+src="([^"]+\.js[^"]*)"', html)
        for src in scripts:
            if "cloudflare" in src or "freshworks" in src:
                continue
            js = get(src if src.startswith("http") else NH_BASE + src, as_json=False)
            k = re.search(r'GAME_DATA_API_KEY:"([^"]+)"', js)
            b = re.search(r'GAME_DATA_BASE_URL:"([^"]+)"', js)
            if k:
                key = k.group(1)
                base = b.group(1) if b else base
                log(f"  game-data config read from {src}")
                break
        else:
            log("  ! game-data key not found in site bundle; using fallback")
    except Exception as exc:  # noqa: BLE001
        log(f"  ! could not read site bundle ({exc}); using fallback key")
    return base.rstrip("/"), os.environ.get("NH_GAME_DATA_API_KEY", key)


def fetch_raw() -> dict:
    log("Fetching game catalog…")
    collection = get(COLLECTION_URL)
    base, key = game_data_config()
    headers = {"X-API-Key": key}
    log("Fetching instant-game list…")
    instant_games = get(f"{base}/v1/instant-games", headers=headers)
    log("Fetching prizes remaining…")
    prizes = get(f"{base}/v1/instant-game/prizes-remaining", headers=headers)
    return {"collection": collection, "instant_games": instant_games, "prizes_remaining": prizes}


def load_raw(directory: str) -> dict:
    out = {}
    for name in ("collection", "instant_games", "prizes_remaining"):
        with open(os.path.join(directory, name + ".json"), encoding="utf-8") as fh:
            out[name] = json.load(fh)
    return out


def save_raw(raw: dict, directory: str) -> None:
    os.makedirs(directory, exist_ok=True)
    for name, payload in raw.items():
        with open(os.path.join(directory, name + ".json"), "w", encoding="utf-8") as fh:
            json.dump(payload, fh)


# --------------------------------------------------------------------------- #
# Parsing + derived statistics
# --------------------------------------------------------------------------- #
def catalog_games(collection: dict) -> list[dict]:
    """Scratch games from the in-store catalog payload."""
    games: list[dict] = []
    for block in collection.get("data", {}).get("content", []):
        for g in (block.get("data") or {}).get("games", []) or []:
            if g.get("type") == "scratch":
                games.append(g)
    return games


def parse_date(s: str | None) -> dt.date | None:
    if not s:
        return None
    for f in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s.strip(), f).date()
        except ValueError:
            pass
    return None


def clean_name(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


GAME_NO_IN_IMAGE = re.compile(r"NH[-_ ]?(\d{4})", re.I)


def build(raw: dict) -> dict:
    today = dt.datetime.now(EASTERN).date()
    catalog = catalog_games(raw["collection"])
    numbers = {g["id"]: g.get("gameId") for g in raw["instant_games"] if g.get("id")}

    tiers_by_game: dict[str, list[dict]] = defaultdict(list)
    for p in raw["prizes_remaining"].get("prizesRemaining", []):
        tiers_by_game[p["instantGameId"]].append(p)

    games: list[dict] = []
    skipped: list[str] = []
    for g in catalog:
        name = clean_name(g.get("name"))
        data_id = ((g.get("configuration") or {}).get("dataServices") or {}).get("gameDataServiceId")
        start = parse_date(g.get("startDate"))
        if start and start > today:
            skipped.append(f"{name} (not on sale until {start})")
            continue
        raw_tiers = tiers_by_game.get(data_id or "", [])
        if not raw_tiers:
            end = parse_date(g.get("expirationDate"))
            if not (end and end < today):  # retired games are expected to drop out
                skipped.append(f"{name} (no prizes-remaining data)")
            continue
        price_cents = (g.get("price") or {}).get("priceInCents")
        if not price_cents:
            skipped.append(f"{name} (no price)")
            continue
        price = price_cents / 100

        # Several rows can share a prize amount (different ways to win it); merge them.
        merged: dict[float, dict] = {}
        for t in raw_tiers:
            amt = float(t["prizeAmountInDollars"])
            m = merged.setdefault(amt, {"prize": amt, "total": 0, "remaining": 0})
            m["total"] += int(t.get("startingCount") or 0)
            m["remaining"] += int(t.get("remainingCount") or 0)
        tiers = sorted((t for t in merged.values() if t["total"] > 0), key=lambda t: -t["prize"])
        if not tiers:
            skipped.append(f"{name} (empty prize table)")
            continue

        total_prizes = sum(t["total"] for t in tiers)
        remaining_prizes = sum(t["remaining"] for t in tiers)
        overall = g.get("odds")
        tickets_printed = g.get("ticketsOrdered") or (round(overall * total_prizes) if overall else None)
        if not tickets_printed:
            skipped.append(f"{name} (print run unknown)")
            continue
        share_unsold = remaining_prizes / total_prizes
        tickets_remaining = round(tickets_printed * share_unsold)

        prizes = []
        for t in tiers:
            prizes.append(
                {
                    "prize": int(t["prize"]) if t["prize"].is_integer() else t["prize"],
                    "total": t["total"],
                    "remaining": t["remaining"],
                    "odds_printed": round(tickets_printed / t["total"], 2),
                    "odds_live": round(tickets_remaining / t["remaining"], 2)
                    if t["remaining"] and tickets_remaining
                    else None,
                }
            )

        printed_money = sum(t["prize"] * t["total"] for t in tiers)
        unclaimed_money = sum(t["prize"] * t["remaining"] for t in tiers)
        ev_printed = printed_money / (tickets_printed * price)
        ev_now = unclaimed_money / (tickets_remaining * price) if tickets_remaining else None

        number = numbers.get(data_id)
        if not number:
            m = GAME_NO_IN_IMAGE.search((g.get("imageUrl") or "") + " " + (g.get("previewImageUrl") or ""))
            number = m.group(1) if m else None

        end = parse_date(g.get("expirationDate"))
        games.append(
            {
                "game_number": number,
                "identifier": g.get("identifier"),
                "name": name,
                "price": int(price) if price.is_integer() else price,
                "overall_odds": overall,
                "top_prize_display": g.get("topPrizeDisplay"),
                "on_sale": start.isoformat() if start else None,
                "sales_end": end.isoformat() if end else None,
                "image_url": g.get("imageUrl"),
                "thumb_url": g.get("previewImageUrl"),
                "page_url": f"{NH_BASE}/game/{g['identifier']}" if g.get("identifier") else None,
                "tickets_printed": tickets_printed,
                "tickets_remaining": tickets_remaining,
                "percent_unsold": round(100 * share_unsold, 2),
                "prize_money_printed": round(printed_money),
                "prize_money_unclaimed": round(unclaimed_money),
                "ev_printed": round(ev_printed, 4),
                "ev_now": round(ev_now, 4) if ev_now is not None else None,
                "prizes": prizes,
            }
        )

    games.sort(key=lambda x: (-x["price"], x["name"].lower()))
    for s in skipped:
        log(f"  - skipped {s}")

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "prizes_last_updated": raw["prizes_remaining"].get("lastUpdated"),
        "source": {
            "catalog": COLLECTION_URL,
            "prizes_remaining": PRIZES_PAGE,
        },
        "counts": {"scratch_games_in_catalog": len(catalog), "analyzed": len(games), "skipped": skipped},
        "games": games,
    }


CSV_FIELDS = [
    "game_number", "game", "price", "prize", "prizes_printed", "prizes_remaining",
    "odds_printed", "odds_live", "tickets_printed", "tickets_remaining_est",
    "percent_unsold_est", "ev_printed", "ev_now",
]


def csv_rows(data: dict):
    for g in data["games"]:
        for p in g["prizes"]:
            yield {
                "game_number": g["game_number"],
                "game": g["name"],
                "price": g["price"],
                "prize": p["prize"],
                "prizes_printed": p["total"],
                "prizes_remaining": p["remaining"],
                "odds_printed": p["odds_printed"],
                "odds_live": p["odds_live"] if p["odds_live"] is not None else "",
                "tickets_printed": g["tickets_printed"],
                "tickets_remaining_est": g["tickets_remaining"],
                "percent_unsold_est": g["percent_unsold"],
                "ev_printed": g["ev_printed"],
                "ev_now": g["ev_now"],
            }


def write_csv(data: dict, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(csv_rows(data))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-dir", help="build from raw JSON saved earlier instead of fetching")
    ap.add_argument("--save-raw", help="directory to keep the raw API responses in")
    ap.add_argument("--min-games", type=int, default=10,
                    help="fail (and keep the old data) if fewer games than this are parsed")
    args = ap.parse_args()

    raw = load_raw(args.from_dir) if args.from_dir else fetch_raw()
    if args.save_raw:
        save_raw(raw, args.save_raw)

    data = build(raw)
    n = len(data["games"])
    if n < args.min_games:
        log(f"Only {n} games parsed (minimum {args.min_games}); not overwriting {OUT_JSON}")
        return 1

    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    write_csv(data, OUT_CSV)
    log(f"Wrote {os.path.relpath(OUT_JSON, ROOT)} and {os.path.relpath(OUT_CSV, ROOT)} — {n} games")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
