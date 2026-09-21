from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from ml.service.routing import route


class InferenceRoutingTests(unittest.TestCase):
    def test_unapproved_thresholds_review_everything(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(route(0.99), ("uncertain", True, None))
            self.assertEqual(route(0.01), ("uncertain", True, None))

    def test_interview_presence_threshold_routes_lower_scores_to_review(self) -> None:
        environment = {
            "STOOL_PRESENT_THRESHOLD": "0.80",
            "STOOL_THRESHOLD_SET_VERSION": "interview-demo-80-v1",
        }
        with patch.dict(os.environ, environment, clear=True):
            self.assertEqual(route(0.799999), ("uncertain", True, "interview-demo-80-v1"))
            self.assertEqual(route(0.8), ("present", False, "interview-demo-80-v1"))
            self.assertEqual(route(0.99), ("present", False, "interview-demo-80-v1"))


if __name__ == "__main__":
    unittest.main()
