from __future__ import annotations

import unittest

import numpy as np
from PIL import Image

from ml.service.app import (
    binary_preprocessing_version,
    detection_score_diagnostics,
    max_detection_confidence,
    preprocess_binary_classifier,
)


class BinaryPreprocessingTests(unittest.TestCase):
    def test_resizes_entire_roi_without_additional_center_crop(self) -> None:
        pixels = np.zeros((768, 768, 3), dtype=np.uint8)
        pixels[:, :80, 0] = 255
        pixels[:, -80:, 2] = 255

        tensor = preprocess_binary_classifier(Image.fromarray(pixels))

        self.assertEqual(tensor.shape, (1, 3, 224, 224))
        self.assertGreater(float(tensor[0, 0, 112, 0]), 2.0)
        self.assertGreater(float(tensor[0, 2, 112, -1]), 2.0)

    def test_shared_roi_dimensions_use_training_preprocessing_version(self) -> None:
        self.assertEqual(
            binary_preprocessing_version(Image.new("RGB", (768, 768))),
            "stool-roi-768-to-imagenet-224-v1",
        )

    def test_legacy_full_image_dimensions_remain_traceable_during_rollout(self) -> None:
        self.assertEqual(
            binary_preprocessing_version(Image.new("RGB", (960, 1280))),
            "legacy-full-image-imagenet-resize-224-v1",
        )


class DetectionConfidenceTests(unittest.TestCase):
    def test_returns_highest_sigmoid_across_three_scales(self) -> None:
        outputs = [
            np.asarray([[[[-4.0, -2.0]]]], dtype=np.float32),
            np.asarray([[[[0.0]]]], dtype=np.float32),
            np.asarray([[[[2.0]]]], dtype=np.float32),
        ]
        self.assertAlmostEqual(max_detection_confidence(outputs), 0.880797, places=5)

    def test_rejects_unexpected_output_contract(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "unexpected_shitspotter_output_contract"):
            max_detection_confidence([np.zeros((1, 2, 4, 4), dtype=np.float32)] * 3)

    def test_reports_bounded_raw_activation_diagnostics(self) -> None:
        outputs = [
            np.asarray([[[[-10.0, -8.0]]]], dtype=np.float32),
            np.asarray([[[[-9.0]]]], dtype=np.float32),
            np.asarray([[[[-7.0]]]], dtype=np.float32),
        ]

        diagnostics = detection_score_diagnostics(outputs)

        self.assertAlmostEqual(diagnostics["max_activation"], 0.000911051, places=8)
        self.assertEqual(diagnostics["max_logit"], -7.0)
        self.assertEqual(diagnostics["activation_floor"], 0.0001)
        self.assertEqual(diagnostics["activation_count_above_floor"], 3)
        self.assertEqual(
            diagnostics["confidence_map_shapes"],
            [[1, 1, 1, 2], [1, 1, 1, 1], [1, 1, 1, 1]],
        )


if __name__ == "__main__":
    unittest.main()
