from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image

from pet_reid_tool.oxford import build_oxford_release, load_oxford_records, parse_oxford_annotation_line
from pet_reid_tool.segmentation import confusion_summary, letterbox_pair, restore_probability


class OxfordSegmentationTests(unittest.TestCase):
    def test_annotation_parser_keeps_species_and_breed(self) -> None:
        dog = parse_oxford_annotation_line("american_bulldog_12 25 2 1")
        cat = parse_oxford_annotation_line("Abyssinian_4 1 1 1")
        self.assertEqual(dog["breed"], "american_bulldog")
        self.assertEqual(dog["species"], "dog")
        self.assertEqual(cat["species"], "cat")

    def test_letterbox_maps_boundary_to_foreground_and_padding_to_ignore(self) -> None:
        image = Image.new("RGB", (8, 4), (10, 20, 30))
        trimap = Image.fromarray(
            np.asarray(
                [
                    [2, 2, 2, 2, 2, 2, 2, 2],
                    [2, 1, 1, 1, 3, 3, 2, 2],
                    [2, 1, 1, 1, 3, 3, 2, 2],
                    [2, 2, 2, 2, 2, 2, 2, 2],
                ],
                dtype=np.uint8,
            )
        )
        boxed, target, metadata = letterbox_pair(image, trimap, (8, 8))
        self.assertEqual(boxed.size, (8, 8))
        self.assertEqual(target.shape, (8, 8))
        self.assertTrue(np.all(target[:2] == 255))
        self.assertIn(1, target)
        restored = restore_probability((target == 1).astype(np.float32), metadata)
        self.assertEqual(restored.shape, (4, 8))

    def test_confusion_summary_reports_foreground_metrics(self) -> None:
        result = confusion_summary(np.asarray([[7, 1], [2, 6]], dtype=np.int64))
        self.assertAlmostEqual(result["foreground_iou"], 6 / 9)
        self.assertAlmostEqual(result["foreground_dice"], 12 / 15)
        self.assertEqual(result["evaluated_pixel_count"], 16)

    def test_release_preserves_official_test_and_external_label_provenance(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "data" / "oxford-iiit-pet"
            images = base / "images"
            trimaps = base / "annotations" / "trimaps"
            images.mkdir(parents=True)
            trimaps.mkdir(parents=True)
            lines = {
                "trainval": ["CatBreed_1 1 1 1", "DogBreed_1 2 2 1"],
                "test": ["CatBreed_2 1 1 1", "DogBreed_2 2 2 1"],
            }
            empty_foreground_ids = {"DogBreed_1", "DogBreed_2"}
            for split, split_lines in lines.items():
                (base / "annotations" / f"{split}.txt").write_text(
                    "\n".join(split_lines) + "\n", encoding="utf-8"
                )
                for position, line in enumerate(split_lines):
                    image_id = line.split()[0]
                    values = np.zeros((12, 16, 3), dtype=np.uint8)
                    values[:, :, position] = np.arange(16, dtype=np.uint8)[None, :] * (5 + len(split))
                    Image.fromarray(values).save(images / f"{image_id}.jpg")
                    mask = np.full((12, 16), 2, dtype=np.uint8)
                    if image_id not in empty_foreground_ids:
                        mask[2:10, 3:13] = 1
                        mask[2, 3:13] = 3
                    Image.fromarray(mask).save(trimaps / f"{image_id}.png")
            config = {
                "schema_version": "pet-foreground-segmentation-config-v1",
                "release_id": "test-oxford",
                "source": {"resources": [], "license": "CC BY-SA 4.0"},
                "expected": {
                    "image_count": 4,
                    "official_split_counts": {"trainval": 2, "test": 2},
                    "empty_foreground_count": 2,
                    "empty_foreground_by_official_split": {"trainval": 1, "test": 1},
                    "breed_count": 2,
                    "species_breed_counts": {"cat": 1, "dog": 1},
                },
                "seed": 7,
                "split": {
                    "validation_fraction": 0.5,
                    "near_duplicate_dhash_max_distance": 0,
                },
                "preprocessing": {"version": "test"},
            }
            config_path = root / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            output = root / "release"
            result = build_oxford_release(root / "data", output, config_path)
            self.assertEqual(result["record_count"], 4)
            records = load_oxford_records(output)
            self.assertEqual(sum(record["assigned_split"] == "test" for record in records), 1)
            invalid_labels = [
                record for record in records if record["segmentation_label_status"] == "empty_foreground"
            ]
            self.assertEqual({record["image_id"] for record in invalid_labels}, empty_foreground_ids)
            self.assertTrue(
                all(
                    record["eligibility_status"] == "excluded_empty_foreground"
                    and record["assigned_split"] == "excluded"
                    for record in invalid_labels
                )
            )
            self.assertTrue(
                all(record["foreground_bbox_xyxy"] is None for record in invalid_labels)
            )
            self.assertTrue(all(record["clinical_ground_truth"] is False for record in records))
            self.assertTrue(
                all(record["training_consent_source"] == "external_dataset_cc_by_sa_4_0" for record in records)
            )


if __name__ == "__main__":
    unittest.main()
