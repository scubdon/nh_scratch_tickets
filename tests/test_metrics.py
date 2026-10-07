"""Checks on the derived statistics and on the published data.

    python -m unittest discover -s tests
"""

import json
import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scraper"))

from metrics import estimate_quality, outcome_metrics, validate_game  # noqa: E402

DATA = os.path.join(ROOT, "site", "data.json")

# A toy $10 game: 1,000 tickets, 300 prizes.
TOY_LEVELS = [(1000, 1), (100, 9), (20, 90), (10, 200)]


class OutcomeMetrics(unittest.TestCase):
    def setUp(self):
        self.m = outcome_metrics(10, TOY_LEVELS, 1000)

    def test_outcome_shares(self):
        m = self.m
        self.assertAlmostEqual(m["p_any"], 0.3)
        self.assertAlmostEqual(m["p_none"], 0.7)
        self.assertAlmostEqual(m["p_break_even"], 0.2)
        self.assertAlmostEqual(m["p_profit"], 0.1)
        self.assertAlmostEqual(m["p_loss"], 0.7)
        self.assertAlmostEqual(m["p_loss"] + m["p_break_even"] + m["p_profit"], 1)

    def test_multiples_and_thresholds(self):
        m = self.m
        self.assertAlmostEqual(m["p_multiple"]["2x"], 0.1)   # $20+
        self.assertAlmostEqual(m["p_multiple"]["5x"], 0.01)  # $50+
        self.assertAlmostEqual(m["p_multiple"]["10x"], 0.01)  # $100+
        self.assertAlmostEqual(m["p_at_least"]["100"], 0.01)
        self.assertAlmostEqual(m["p_at_least"]["1000"], 0.001)
        self.assertIsNone(m["p_at_least"]["10000"], "no prize that large -> not applicable")

    def test_expected_value(self):
        m = self.m
        ev = (1000 * 1 + 100 * 9 + 20 * 90 + 10 * 200) / 1000  # 5.70
        self.assertAlmostEqual(m["ev_ticket"], ev)
        self.assertAlmostEqual(m["ev_ratio"], ev / 10)
        self.assertAlmostEqual(m["expected_loss"], 10 - ev)
        self.assertAlmostEqual(m["loss_per_100"], 100 * (1 - ev / 10))

    def test_typical_outcomes(self):
        m = self.m
        self.assertEqual(m["median_payout"], 0)
        self.assertEqual(m["mode_payout"], 0)
        self.assertEqual(m["percentiles"]["75"], 10)  # 70% get $0, next 20% get $10
        self.assertEqual(m["percentiles"]["90"], 10)
        self.assertEqual(m["percentiles"]["99"], 20)

    def test_return_bands_sum_to_ev(self):
        m = self.m
        self.assertAlmostEqual(sum(b["per_100"] for b in m["return_bands"]), 100 * m["ev_ratio"], places=3)
        self.assertEqual([b["key"] for b in m["return_bands"]], ["under_100", "100_999", "1000_9999"])

    def test_claimed_threshold_is_zero_not_none(self):
        m = outcome_metrics(10, [(1000, 0), (10, 100)], 500)
        self.assertEqual(m["p_at_least"]["1000"], 0)
        self.assertEqual(m["top_left"], 0)
        self.assertEqual(m["p_top"], 0)

    def test_below_cost_counts_as_loss(self):
        m = outcome_metrics(5, [(2, 100), (5, 100), (10, 50)], 1000)
        self.assertAlmostEqual(m["p_below_cost"], 0.1)
        self.assertAlmostEqual(m["p_loss"], 0.75 + 0.1)

    def test_empty_pool(self):
        self.assertIsNone(outcome_metrics(10, TOY_LEVELS, 0))


class EstimateQuality(unittest.TestCase):
    def test_stable(self):
        q = estimate_quality([(10, 10000, 5000), (20, 5000, 2510), (50, 2000, 990)])
        self.assertEqual(q["label"], "Estimate appears stable")

    def test_unusual(self):
        q = estimate_quality([(10, 10000, 5000), (20, 5000, 4000)])
        self.assertEqual(q["label"], "Prize redemption pattern unusual")

    def test_limited(self):
        self.assertEqual(estimate_quality([(10, 500, 200)])["label"], "Limited data")


def toy_game(**over):
    g = {
        "name": "Toy", "price": 10, "tickets_printed": 1000, "tickets_remaining": 1000, "ev_now": 0.57,
        "top_prize_display": "$1,000",
        "prizes": [{"prize": a, "total": n, "remaining": n} for a, n in TOY_LEVELS],
    }
    g.update(over)
    g["metrics"] = {
        "live": outcome_metrics(g["price"], [(p["prize"], p["remaining"]) for p in g["prizes"]], g["tickets_remaining"]),
        "printed": outcome_metrics(g["price"], [(p["prize"], p["total"]) for p in g["prizes"]], g["tickets_printed"]),
    }
    return g


class Validation(unittest.TestCase):
    def test_clean_game(self):
        self.assertEqual(validate_game(toy_game()), [])

    def test_remaining_exceeds_printed(self):
        g = toy_game(prizes=[{"prize": 1000, "total": 1, "remaining": 2}, {"prize": 10, "total": 200, "remaining": 200}])
        self.assertTrue(any("More $1,000 prizes unclaimed" in f for f in validate_game(g)))

    def test_more_prizes_than_tickets(self):
        g = toy_game(tickets_remaining=100)
        self.assertTrue(any("negative" in f for f in validate_game(g)))

    def test_top_prize_mismatch(self):
        g = toy_game(top_prize_display="$5,000*")
        self.assertTrue(any("Top prize advertised" in f for f in validate_game(g)))

    def test_non_numeric_top_prize_is_not_compared(self):
        self.assertEqual(validate_game(toy_game(top_prize_display="$1,000 a week for life")), [])


@unittest.skipUnless(os.path.exists(DATA), "site/data.json not built")
class PublishedData(unittest.TestCase):
    """The rules from the spec, applied to every game in the current build."""

    @classmethod
    def setUpClass(cls):
        with open(DATA, encoding="utf-8") as fh:
            cls.data = json.load(fh)

    def test_has_games(self):
        self.assertGreater(len(self.data["games"]), 0)

    def test_every_game(self):
        for g in self.data["games"]:
            with self.subTest(game=g["name"]):
                self.assertGreater(g["price"], 0)
                self.assertGreater(g["tickets_remaining"], 0)
                for p in g["prizes"]:
                    self.assertLessEqual(p["remaining"], p["total"])
                m = g["metrics"]["live"]
                for k in ("p_any", "p_none", "p_loss", "p_break_even", "p_profit"):
                    self.assertGreaterEqual(m[k], -1e-9, k)
                    self.assertLessEqual(m[k], 1 + 1e-9, k)
                self.assertAlmostEqual(m["p_loss"] + m["p_break_even"] + m["p_profit"], 1, places=5)
                ev = sum(p["prize"] * p["remaining"] for p in g["prizes"]) / g["tickets_remaining"]
                self.assertTrue(math.isclose(m["ev_ticket"], ev, abs_tol=1e-3))
                self.assertTrue(math.isclose(m["ev_ratio"], g["ev_now"], abs_tol=5e-4))
                self.assertAlmostEqual(m["expected_loss"], g["price"] - m["ev_ticket"], places=3)
                top = max(g["prizes"], key=lambda p: p["prize"])
                self.assertEqual(m["top_prize"], top["prize"])
                self.assertEqual(m["top_left"], top["remaining"])
                self.assertIsInstance(g["flags"], list)


if __name__ == "__main__":
    unittest.main()
