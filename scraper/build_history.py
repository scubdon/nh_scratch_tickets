#!/usr/bin/env python3
"""Turn the daily snapshots in data/history/*.csv into per-game time series for the site.

Writes site/data/history.json:

    {
      "generated_at": ...,
      "first_date": "2026-09-25", "last_date": ...,
      "games": {
        "1692": {
          "name": "...",
          "d":        ["2026-09-25", ...],     # snapshot dates
          "ev":       [0.8801, ...],           # expected return per $1
          "p_profit": [...], "p_2x": [...], "p_100": [...],
          "p_top":    [...],                   # chance of the top prize (0 once all claimed)
          "top_left": [...],
          "tickets":  [...],                   # estimated tickets remaining
          "flags":    ["On 2026-10-02 ..."]    # historical consistency problems
        }
      }
    }

The snapshots themselves are never modified: every point is recomputed from the
counts exactly as they were recorded that day. If today's build has not been
snapshotted yet (pushes skip the snapshot step), today's site/data.json is appended
as the latest point so the chart always ends at the figures shown on the page.
"""

from __future__ import annotations

import csv
import datetime as dt
import glob
import json
import os
import sys
from collections import defaultdict
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metrics import outcome_metrics  # noqa: E402
from scrape import OUT_JSON, ROOT, SITE  # noqa: E402

HISTORY_DIR = os.path.join(ROOT, "data", "history")
OUT = os.path.join(SITE, "data", "history.json")


def num(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def load_snapshots() -> dict[str, dict[str, dict]]:
    """{date: {game_number: {"name", "price", "tickets", "levels": {prize: (printed, left)}}}}"""
    days: dict[str, dict[str, dict]] = {}
    for path in sorted(glob.glob(os.path.join(HISTORY_DIR, "*.csv"))):
        day = os.path.splitext(os.path.basename(path))[0]
        games: dict[str, dict] = {}
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                key = row["game_number"] or row["game"]
                g = games.setdefault(
                    key,
                    {"name": row["game"], "price": num(row["price"]), "tickets": num(row["tickets_remaining_est"]), "levels": {}},
                )
                g["levels"][num(row["prize"])] = (int(num(row["prizes_printed"]) or 0), int(num(row["prizes_remaining"]) or 0))
        days[day] = games
    return days


def from_current() -> tuple[str, dict[str, dict]] | None:
    try:
        with open(OUT_JSON, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    day = dt.datetime.fromisoformat(data["generated_at"]).astimezone(ZoneInfo("America/New_York")).date().isoformat()
    games = {}
    for g in data["games"]:
        games[g["game_number"] or g["name"]] = {
            "name": g["name"],
            "price": g["price"],
            "tickets": g["tickets_remaining"],
            "levels": {float(p["prize"]): (p["total"], p["remaining"]) for p in g["prizes"]},
        }
    return day, games


def money(a: float) -> str:
    return f"${a:,.0f}" if float(a).is_integer() else f"${a:,.2f}"


def build(days: dict[str, dict[str, dict]]) -> dict:
    series: dict[str, dict] = defaultdict(lambda: {"d": [], "ev": [], "p_profit": [], "p_2x": [], "p_100": [],
                                                    "p_top": [], "top_left": [], "tickets": [], "flags": []})
    last_seen: dict[str, tuple[str, dict]] = {}
    for day in sorted(days):
        for key, g in days[day].items():
            s = series[key]
            s["name"] = g["name"]
            levels = [(a, left) for a, (_, left) in g["levels"].items()]
            m = outcome_metrics(g["price"], levels, g["tickets"])
            if not m:
                continue
            s["d"].append(day)
            s["ev"].append(m["ev_ratio"])
            s["p_profit"].append(m["p_profit"])
            s["p_2x"].append(m["p_multiple"]["2x"])
            s["p_100"].append(m["p_at_least"]["100"])
            s["p_top"].append(m["p_top"])
            s["top_left"].append(m["top_left"])
            s["tickets"].append(int(g["tickets"]))

            # Historical consistency checks against the previous snapshot of this game.
            if key in last_seen:
                prev_day, prev = last_seen[key]
                if prev["name"] != g["name"]:
                    s["flags"].append(f"On {day} the game's name changed from “{prev['name']}” to “{g['name']}”.")
                if prev["price"] != g["price"]:
                    s["flags"].append(f"On {day} the ticket price changed from {money(prev['price'])} to {money(g['price'])}.")
                for a, (printed, left) in sorted(g["levels"].items(), reverse=True):
                    if a not in prev["levels"]:
                        continue
                    p_printed, p_left = prev["levels"][a]
                    if printed != p_printed:
                        s["flags"].append(
                            f"On {day} the number of {money(a)} prizes printed changed from {p_printed:,} to {printed:,} "
                            "(possible source correction or added tickets)."
                        )
                    elif left > p_left:
                        s["flags"].append(
                            f"On {day} unclaimed {money(a)} prizes rose from {p_left:,} to {left:,} "
                            "(possible source correction)."
                        )
            last_seen[key] = (day, g)

    ordered = sorted(days)
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "first_date": ordered[0] if ordered else None,
        "last_date": ordered[-1] if ordered else None,
        "games": dict(series),
    }


def main() -> int:
    days = load_snapshots()
    cur = from_current()
    if cur and cur[0] not in days:
        days[cur[0]] = cur[1]
    out = build(days)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    flagged = sum(1 for g in out["games"].values() if g["flags"])
    print(
        f"Wrote {os.path.relpath(OUT, ROOT)} — {len(out['games'])} games over {len(days)} days"
        + (f"; {flagged} with history flags" if flagged else ""),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
