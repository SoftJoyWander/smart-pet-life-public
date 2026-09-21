from __future__ import annotations

import unittest

import numpy as np

from pet_reid_tool.metrics import (
    deterministic_identity_partition,
    open_set_metrics,
    rank_metrics,
    select_eer_threshold,
)


class PetReIdMetricTests(unittest.TestCase):
    def test_rank_metrics_reports_rank_and_map(self) -> None:
        query = np.asarray([[1.0, 0.0], [0.0, 1.0]])
        gallery = np.asarray([[0.9, 0.1], [0.8, 0.2], [0.1, 0.9]])
        result = rank_metrics(query, ["a", "b"], gallery, ["a", "a", "b"], rank_k=(1, 5))
        self.assertEqual(result["rank"]["1"], 1.0)
        self.assertEqual(result["rank"]["5"], 1.0)
        self.assertEqual(result["mAP"], 1.0)

    def test_open_set_threshold_is_selected_from_validation_scores(self) -> None:
        selected = select_eer_threshold([0.90, 0.85], [0.20, 0.30])
        self.assertGreater(selected["threshold"], 0.30)
        result = open_set_metrics(
            [0.90, 0.85, 0.20, 0.30],
            [True, True, False, False],
            [True, False, False, False],
            selected["threshold"],
        )
        self.assertEqual(result["unknown_false_accept_rate"], 0.0)
        self.assertEqual(result["known_accept_rate"], 1.0)

    def test_identity_partition_is_deterministic_and_disjoint(self) -> None:
        identities = [f"dog-{index}" for index in range(20)]
        first = deterministic_identity_partition(identities, 42, 0.75)
        second = deterministic_identity_partition(reversed(identities), 42, 0.75)
        self.assertEqual(first, second)
        self.assertFalse(first[0] & first[1])
        self.assertEqual(first[0] | first[1], set(identities))


if __name__ == "__main__":
    unittest.main()
