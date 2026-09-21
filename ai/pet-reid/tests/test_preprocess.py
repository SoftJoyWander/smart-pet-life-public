from __future__ import annotations

import unittest

import numpy as np

from pet_reid_tool.preprocess import largest_connected_component, padded_bbox


class PreprocessTests(unittest.TestCase):
    def test_largest_component_ignores_smaller_false_positive(self) -> None:
        mask = np.zeros((10, 12), dtype=bool)
        mask[2:8, 3:9] = True
        mask[0, 0] = True
        largest, count = largest_connected_component(mask)
        self.assertEqual(count, 2)
        self.assertEqual(int(largest.sum()), 36)
        self.assertFalse(largest[0, 0])

    def test_padded_bbox_is_clamped_to_image(self) -> None:
        mask = np.zeros((10, 12), dtype=bool)
        mask[0:5, 0:4] = True
        self.assertEqual(padded_bbox(mask, 0.25), (0, 0, 5, 6))


if __name__ == "__main__":
    unittest.main()
