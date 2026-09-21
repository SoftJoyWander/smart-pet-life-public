from __future__ import annotations

from collections import Counter, deque
import copy
import json
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from .mpdd import load_release_records, read_json, sha256_file
from .segmentation import load_segmentation_checkpoint, predict_foreground_probability


def largest_connected_component(mask: np.ndarray) -> tuple[np.ndarray, int]:
    if mask.ndim != 2:
        raise ValueError("foreground mask must be 2D")
    values = mask.astype(bool, copy=False)
    visited = np.zeros(values.shape, dtype=bool)
    best: list[tuple[int, int]] = []
    component_count = 0
    height, width = values.shape
    for row, column in np.argwhere(values):
        row_value = int(row)
        column_value = int(column)
        if visited[row_value, column_value]:
            continue
        component_count += 1
        queue = deque([(row_value, column_value)])
        visited[row_value, column_value] = True
        current: list[tuple[int, int]] = []
        while queue:
            current_row, current_column = queue.popleft()
            current.append((current_row, current_column))
            for next_row, next_column in (
                (current_row - 1, current_column),
                (current_row + 1, current_column),
                (current_row, current_column - 1),
                (current_row, current_column + 1),
            ):
                if (
                    0 <= next_row < height
                    and 0 <= next_column < width
                    and values[next_row, next_column]
                    and not visited[next_row, next_column]
                ):
                    visited[next_row, next_column] = True
                    queue.append((next_row, next_column))
        if len(current) > len(best):
            best = current
    result = np.zeros(values.shape, dtype=bool)
    if best:
        rows, columns = zip(*best, strict=True)
        result[np.asarray(rows), np.asarray(columns)] = True
    return result, component_count


def padded_bbox(mask: np.ndarray, padding_ratio: float) -> tuple[int, int, int, int] | None:
    rows, columns = np.where(mask)
    if not len(rows):
        return None
    height, width = mask.shape
    left = int(columns.min())
    top = int(rows.min())
    right = int(columns.max()) + 1
    bottom = int(rows.max()) + 1
    padding = int(round(max(right - left, bottom - top) * padding_ratio))
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_manifest(path: Path, records: list[dict[str, Any]]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )
    return sha256_file(path)


def derive_mpdd_preprocessing_release(
    mpdd_source_root: Path,
    mpdd_release_root: Path,
    mpdd_config_path: Path,
    segmentation_checkpoint: Path,
    segmentation_model_card: Path,
    segmentation_config_path: Path,
    output_root: Path,
) -> dict[str, Any]:
    try:
        import torch
    except ImportError as error:
        raise RuntimeError("MPDD preprocessing requires torch") from error

    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(f"derived output must be empty: {output_root}")
    mpdd_config = read_json(mpdd_config_path)
    mpdd_release = read_json(mpdd_release_root / "dataset-release.json")
    segmentation_config = read_json(segmentation_config_path)
    model_card = read_json(segmentation_model_card)
    if mpdd_release.get("manifest_sha256") != sha256_file(
        mpdd_release_root / "dataset-manifest.jsonl"
    ):
        raise ValueError("MPDD parent manifest checksum mismatch")
    if model_card.get("checkpoint_sha256") != sha256_file(segmentation_checkpoint):
        raise ValueError("segmentation checkpoint checksum mismatch")
    if model_card.get("operational_app_media_included") is not False:
        raise ValueError("segmentation model must exclude operational App media")
    if segmentation_config.get("schema_version") != "pet-foreground-segmentation-config-v1":
        raise ValueError("unsupported segmentation config")

    records = load_release_records(mpdd_release_root)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, checkpoint = load_segmentation_checkpoint(segmentation_checkpoint, device)
    if checkpoint.get("release_id") != segmentation_config["release_id"]:
        raise ValueError("segmentation checkpoint release ID mismatch")

    output_root.mkdir(parents=True, exist_ok=True)
    variants = {
        "bbox": {
            "release_id": f"{mpdd_release['release_id']}-bbox-v1",
            "preprocessing_version": "mpdd-oxford-foreground-bbox-pad10-224-v1",
        },
        "neutral": {
            "release_id": f"{mpdd_release['release_id']}-neutral-v1",
            "preprocessing_version": "mpdd-oxford-foreground-neutral-gray-pad10-224-v1",
        },
    }
    variant_records: dict[str, list[dict[str, Any]]] = {key: [] for key in variants}
    status_counts: Counter[str] = Counter()
    crop_config = segmentation_config["crop"]
    threshold = float(crop_config["foreground_probability_threshold"])
    minimum_fraction = float(crop_config["minimum_foreground_fraction"])
    padding_ratio = float(crop_config["bbox_padding_ratio"])
    background_rgb = np.asarray(crop_config["background_rgb"], dtype=np.uint8)
    input_size = tuple(int(value) for value in segmentation_config["preprocessing"]["input_size"])

    for index, record in enumerate(records, start=1):
        source_path = mpdd_source_root / record["source_file"]
        with Image.open(source_path) as source_image:
            image = ImageOps.exif_transpose(source_image).convert("RGB")
        probability = predict_foreground_probability(model, image, input_size, device)
        raw_mask = probability >= threshold
        component, component_count = largest_connected_component(raw_mask)
        foreground_fraction = float(component.mean())
        bbox = padded_bbox(component, padding_ratio)
        if bbox is None or foreground_fraction < minimum_fraction:
            status = "fallback_foreground_too_small"
            bbox = (0, 0, image.width, image.height)
            component = np.ones((image.height, image.width), dtype=bool)
        else:
            status = "segmented"
        status_counts[status] += 1
        image_values = np.asarray(image, dtype=np.uint8)
        neutral_values = np.where(component[:, :, None], image_values, background_rgb)
        neutral_image = Image.fromarray(neutral_values.astype(np.uint8), mode="RGB")
        derived_images = {
            "bbox": image.crop(bbox),
            "neutral": neutral_image.crop(bbox),
        }
        relative_file = Path(record["split"]) / record["source_filename"]
        for variant, derived_image in derived_images.items():
            image_root = output_root / variant / "images"
            destination = image_root / relative_file
            destination.parent.mkdir(parents=True, exist_ok=True)
            derived_image.save(destination, format="JPEG", quality=95, optimize=True)
            derived_record = {
                **record,
                "release_id": variants[variant]["release_id"],
                "source_file": relative_file.as_posix(),
                "sha256": sha256_file(destination),
                "parent_release_id": mpdd_release["release_id"],
                "parent_source_file": record["source_file"],
                "parent_sha256": record["sha256"],
                "derivation_schema_version": "mpdd-foreground-derived-item-v1",
                "derivation_variant": variant,
                "segmentation_model_version": model_card["model_version"],
                "segmentation_checkpoint_sha256": model_card["checkpoint_sha256"],
                "segmentation_status": status,
                "foreground_probability_threshold": threshold,
                "foreground_fraction": foreground_fraction,
                "foreground_component_count": component_count,
                "predicted_bbox_xyxy": list(bbox),
                "derived_width": derived_image.width,
                "derived_height": derived_image.height,
                "exif_preserved": False,
            }
            variant_records[variant].append(derived_record)
        if index % 100 == 0 or index == len(records):
            print(
                json.dumps(
                    {"processed": index, "total": len(records), "status_counts": status_counts},
                    ensure_ascii=False,
                ),
                flush=True,
            )

    results: dict[str, Any] = {}
    for variant, metadata in variants.items():
        variant_root = output_root / variant
        release_root = variant_root / "release"
        manifest_path = release_root / "dataset-manifest.jsonl"
        manifest_sha256 = _write_manifest(manifest_path, variant_records[variant])
        variant_config = copy.deepcopy(mpdd_config)
        variant_config["release_id"] = metadata["release_id"]
        variant_config["preprocessing"] = {
            "version": metadata["preprocessing_version"],
            "input_size": mpdd_config["preprocessing"]["input_size"],
            "normalization": "imagenet-mean-std",
            "parent_preprocessing_version": mpdd_config["preprocessing"]["version"],
            "segmentation_preprocessing_version": segmentation_config["preprocessing"]["version"],
            "segmentation_model_version": model_card["model_version"],
            "crop_contract": crop_config,
            "training_augmentations": mpdd_config["preprocessing"]["training_augmentations"],
        }
        variant_config["source"]["parent_release_id"] = mpdd_release["release_id"]
        variant_config["source"]["segmentation_model_version"] = model_card["model_version"]
        config_path = variant_root / "reid-config.json"
        _write_json(config_path, variant_config)
        release = {
            "schema_version": "mpdd-dataset-release-v1",
            "release_id": metadata["release_id"],
            "source": variant_config["source"],
            "manifest_sha256": manifest_sha256,
            "preprocessing": variant_config["preprocessing"],
            "identity_split_rule": mpdd_release["identity_split_rule"],
            "label_provenance": mpdd_release["label_provenance"],
            "clinical_ground_truth": False,
            "operational_app_media_included": False,
            "parent_release_id": mpdd_release["release_id"],
            "segmentation_model_lineage": {
                "model_version": model_card["model_version"],
                "checkpoint_sha256": model_card["checkpoint_sha256"],
                "dataset_release_id": model_card["dataset_release_id"],
            },
            "audit": {
                "record_count": len(variant_records[variant]),
                "segmentation_status_counts": dict(status_counts),
                "source_record_count": len(records),
                "exif_preserved": False,
            },
        }
        _write_json(release_root / "dataset-release.json", release)
        results[variant] = {
            "release_id": metadata["release_id"],
            "image_root": str(variant_root / "images"),
            "release_root": str(release_root),
            "config": str(config_path),
            "manifest_sha256": manifest_sha256,
        }
    return {
        "schema_version": "mpdd-foreground-derived-result-v1",
        "source_record_count": len(records),
        "segmentation_status_counts": dict(status_counts),
        "variants": results,
    }
