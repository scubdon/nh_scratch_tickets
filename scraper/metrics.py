"""
Derived, buyer-centred statistics for one scratch game.

Everything here is a pure function of a game's ticket price, its prize levels and a
ticket count, so the same code describes a game "as printed" (all prizes, full print
run) and "as it stands now" (unclaimed prizes, estimated unsold tickets), and can be
re-run over any day of the history.

Notation (matches the Methods page):

    C        ticket price
    T        tickets in the pool (printed, or estimated remaining)
    A[j]     prize amount of level j
    N[j]     prizes of that level in the pool (printed, or unclaimed)
    P[j]     = N[j] / T                      chance one ticket pays exactly A[j]

    P_none        = 1 - sum P[j]
    P_loss        = P_none + sum P[j] where A[j] <  C
    P_break_even  =          sum P[j] where A[j] == C
    P_profit      =          sum P[j] where A[j] >  C
    P_kx          =          sum P[j] where A[j] >= k x C        (k = 2, 5, 10)
    P_$X          =          sum P[j] where A[j] >= X            (X = 50, 100, ...)
    EV_ticket     = sum A[j] x P[j]
    EV_ratio      = EV_ticket / C
    loss_per_100  = 100 x (1 - EV_ratio)
"""

from __future__ import annotations

import math

MULTIPLES = (2, 5, 10)
ABS_THRESHOLDS = (50, 100, 500, 1000, 10000)
PERCENTILES = (10, 25, 50, 75, 90, 99)

# Bands for "where the average payout comes from". Upper bounds are exclusive.
RETURN_BANDS = (
    ("under_100", "Prizes under $100", 0, 100),
    ("100_999", "$100 to $999", 100, 1000),
    ("1000_9999", "$1,000 to $9,999", 1000, 10000),
    ("10000_plus", "$10,000 and up", 10000, math.inf),
)

EPS = 1e-9


def _r(x: float | None, nd: int = 8) -> float | None:
    return None if x is None else round(x, nd)


def _p(x: float | None) -> float | None:
    """Probabilities keep 8 significant figures, so "1 in 383,692" survives the round trip."""
    return None if x is None else float(f"{x:.8g}")


def _amt(a: float | None):
    """Dollar amounts as ints when whole, so JSON reads 30 rather than 30.0."""
    return int(a) if a is not None and float(a).is_integer() else a


def outcome_metrics(price: float, levels: list[tuple[float, int]], tickets: float) -> dict | None:
    """Buyer outcome statistics for one ticket drawn from a pool.

    levels  -- (prize amount, number of those prizes in the pool), any order
    tickets -- tickets in the pool
    Returns None when the pool is empty (nothing can be said about a ticket).
    """
    if not tickets or tickets <= 0 or not price or price <= 0:
        return None
    levels = sorted(((float(a), int(n)) for a, n in levels if n is not None), key=lambda x: -x[0])
    probs = [(a, n / tickets) for a, n in levels]
    p_any = sum(p for _, p in probs)
    p_none = 1 - p_any

    def p_where(cond) -> float:
        return sum(p for a, p in probs if cond(a))

    p_below = p_where(lambda a: a < price - EPS)
    p_be = p_where(lambda a: abs(a - price) <= EPS)
    p_profit = p_where(lambda a: a > price + EPS)
    ev = sum(a * p for a, p in probs)
    ratio = ev / price

    # A threshold no prize level reaches is "not applicable" (None), as opposed to
    # one whose prizes have all been claimed (0).
    def p_at_least(x: float) -> float | None:
        if not any(a >= x - EPS for a, _ in levels):
            return None
        return p_where(lambda a: a >= x - EPS)

    # Full payout distribution, $0 included, smallest payout first.
    dist = sorted([(0.0, max(p_none, 0.0)), *((a, p) for a, p in probs if p > 0)], key=lambda x: x[0])

    def percentile(q: float) -> float:
        cum = 0.0
        for a, p in dist:
            cum += p
            if cum >= q - EPS:
                return a
        return dist[-1][0]

    mode = max(dist, key=lambda x: x[1])[0]

    bands = []
    for key, label, lo, hi in RETURN_BANDS:
        inside = [(a, p) for a, p in probs if lo <= a < hi]
        if not any(n for a, n in levels if lo <= a < hi):
            continue  # the game has no prizes in this band at all
        bands.append(
            {
                "key": key,
                "label": label,
                "per_100": _r(100 * sum(a * p for a, p in inside) / price, 4),
                "p": _p(sum(p for _, p in inside)),
            }
        )

    top_amount, top_n = levels[0] if levels else (None, 0)

    return {
        "p_any": _p(p_any),
        "p_none": _p(p_none),
        "p_below_cost": _p(p_below),
        "p_loss": _p(p_none + p_below),
        "p_break_even": _p(p_be),
        "p_profit": _p(p_profit),
        "p_multiple": {f"{k}x": _p(p_at_least(k * price)) for k in MULTIPLES},
        "p_at_least": {str(x): _p(p_at_least(x)) for x in ABS_THRESHOLDS},
        "ev_ticket": _r(ev, 4),
        "ev_ratio": _r(ratio, 4),
        "expected_loss": _r(price - ev, 4),
        "loss_per_100": _r(100 * (1 - ratio), 4),
        "median_payout": _amt(percentile(0.5)),
        "mode_payout": _amt(mode),
        "percentiles": {str(q): _amt(percentile(q / 100)) for q in PERCENTILES},
        "return_bands": bands,
        "top_prize": _amt(top_amount),
        "top_left": top_n,
        "p_top": _p(top_n / tickets) if levels else None,
    }


def estimate_quality(levels: list[tuple[float, int, int]]) -> dict:
    """How consistently the high-volume prize levels agree on the share of tickets unsold.

    The tickets-remaining estimate assumes every prize level is being claimed at the
    same rate as tickets are sold. The big low-value levels have enough prizes for
    their own "share left" to be a good read on that, so when they agree with one
    another the estimate is on firm ground; when they diverge, something about the
    claim pattern is unusual. This is a descriptive signal, not a confidence interval.

    levels -- (prize, printed, unclaimed)
    """
    volume = [(a, t, r) for a, t, r in levels if t >= 1000]
    total_printed = sum(t for _, t, _ in levels)
    total_left = sum(r for _, _, r in levels)
    overall = total_left / total_printed if total_printed else None
    if len(volume) < 2 or overall is None:
        return {"label": "Limited data", "spread": None, "levels_used": len(volume)}
    shares = [r / t for _, t, r in volume]
    spread = max(shares) - min(shares)
    if spread <= 0.05:
        label = "Estimate appears stable"
    elif spread <= 0.12:
        label = "Estimate is approximate"
    else:
        label = "Prize redemption pattern unusual"
    return {"label": label, "spread": round(spread, 4), "levels_used": len(volume)}


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_game(game: dict) -> list[str]:
    """Internal-consistency checks. Returns human-readable problems (empty = clean).

    A game that fails is still published, but flagged, so the site can say its
    figures may be unreliable instead of silently showing them.
    """
    flags: list[str] = []
    price = game.get("price") or 0
    if price <= 0:
        flags.append("Ticket price is missing or not positive.")
    if not game.get("tickets_remaining") or game["tickets_remaining"] <= 0:
        flags.append("Estimated tickets remaining is not positive.")
    for p in game.get("prizes", []):
        if p["remaining"] > p["total"]:
            flags.append(f"More ${p['prize']:,} prizes unclaimed ({p['remaining']:,}) than were printed ({p['total']:,}).")
        if p["remaining"] < 0 or p["total"] < 0:
            flags.append(f"Negative prize count at ${p['prize']:,}.")

    for which in ("live", "printed"):
        m = (game.get("metrics") or {}).get(which)
        if not m:
            if which == "live" and game.get("tickets_remaining"):
                flags.append("Live statistics could not be calculated.")
            continue
        probs = [m["p_any"], m["p_none"], m["p_loss"], m["p_break_even"], m["p_profit"],
                 *m["p_multiple"].values(), *m["p_at_least"].values()]
        if any(p is not None and not (-1e-6 <= p <= 1 + 1e-6) for p in probs):
            flags.append(f"A {which} probability falls outside 0–100%.")
        if abs(m["p_loss"] + m["p_break_even"] + m["p_profit"] - 1) > 1e-4:
            flags.append(f"{which.capitalize()} lose / break-even / profit shares do not add up to 100%.")
        if m["p_none"] < -1e-6:
            flags.append(f"More {which} prizes than tickets: the no-prize share is negative.")
        if abs(m["expected_loss"] - (price - m["ev_ticket"])) > 1e-3:
            flags.append(f"{which.capitalize()} expected loss does not match expected payout.")

    m = (game.get("metrics") or {}).get("live")
    if m and game.get("ev_now") is not None and abs(m["ev_ratio"] - game["ev_now"]) > 5e-4:
        flags.append("Expected return recomputed from the prize table does not match the stored value.")

    prizes = game.get("prizes") or []
    if prizes:
        top = max(prizes, key=lambda p: p["prize"])
        disp = game.get("top_prize_display") or ""
        digits = "".join(ch for ch in disp if ch.isdigit() or ch == ".")
        # Only compare plain dollar figures like "$3,000,000*"; skip "for life" etc.
        if digits and all(ch in "$,.* 0123456789" for ch in disp):
            try:
                if abs(float(digits) - top["prize"]) > 0.5:
                    flags.append(
                        f"Top prize advertised as {disp.strip()} but the prize table's largest prize is ${top['prize']:,}."
                    )
            except ValueError:
                pass
    return flags
