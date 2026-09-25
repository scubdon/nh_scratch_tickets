#!/usr/bin/env python3
"""Keep a daily copy of the per-prize-level table in data/history/<YYYY-MM-DD>.csv.

Reads the freshly built site/data.json. One file per calendar day (Eastern time);
re-running on the same day replaces that day's file, so earlier days are never
rewritten. Read the whole history back with e.g.
``pandas.concat(pd.read_csv(f) for f in glob("data/history/*.csv"))``.
"""

import csv
import datetime as dt
import json
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrape import CSV_FIELDS, OUT_JSON, ROOT, csv_rows  # noqa: E402

HISTORY_DIR = os.path.join(ROOT, "data", "history")


def main() -> int:
    with open(OUT_JSON, encoding="utf-8") as fh:
        data = json.load(fh)
    generated = dt.datetime.fromisoformat(data["generated_at"])
    day = generated.astimezone(ZoneInfo("America/New_York")).date().isoformat()

    os.makedirs(HISTORY_DIR, exist_ok=True)
    path = os.path.join(HISTORY_DIR, f"{day}.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["snapshot_date", "prizes_last_updated", *CSV_FIELDS])
        w.writeheader()
        for row in csv_rows(data):
            w.writerow({"snapshot_date": day, "prizes_last_updated": data.get("prizes_last_updated"), **row})
    print(f"Wrote {os.path.relpath(path, ROOT)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
