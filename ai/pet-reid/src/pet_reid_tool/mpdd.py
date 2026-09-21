from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from PIL import Image


MPDD_SPLITS = ("train", "val", "query", "gallery")
MPDD_NAME = re.compile(
    r"^(?P<identity>\d+)_(?P<camera>c\d+)_?(?P<session>s\d+)_(?P<sample>\d+)\.jpg$",
    re.IGNORECASE,
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_mpdd_filename(filename: str) -> dict[str, str]:
    match = MPDD_NAME.fullmatch(filename)
    if match is None:
        raise ValueError(f"unexpected MPDD filename: {filename}")
    return match.groupdict()


def _validate_split_contract(records: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    split_counts = Counter(record["split"] for record in records)
    split_identities = {
        split: {record["identity_id"] for record in records if record["split"] == split}
        for split in MPDD_SPLITS
    }
    expected = config["expected"]
    if len(records) != expected["image_count"]:
        raise ValueError(f"MPDD image count mismatch: {len(records)} != {expected['image_count']}")
    if dict(split_counts) != expected["split_image_counts"]:
        raise ValueError(
            f"MPDD split image counts mismatch: {dict(split_counts)} != "
            f"{expected['split_image_counts']}"
        )
    identity_counts = {split: len(values) for split, values in split_identities.items()}
    if identity_counts != expected["split_identity_counts"]:
        raise ValueError(
            f"MPDD split identity counts mismatch: {identity_counts} != "
            f"{expected['split_identity_counts']}"
        )
    if split_identities["train"] != split_identities["val"]:
        raise ValueError("MPDD train and val must contain the same identities")
    if split_identities["query"] != split_identities["gallery"]:
        raise ValueError("MPDD query and gallery must contain the same identities")
    if split_identities["train"] & split_identities["query"]:
        raise ValueError("MPDD training identities must be disjoint from query/gallery identities")
    return {
        "split_image_counts": dict(split_counts),
        "split_identity_counts": identity_counts,
        "train_test_identity_overlap": 0,
    }


def audit_mpdd(source_root: Path, config: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    records: list[dict[str, Any]] = []
    hashes: dict[str, list[dict[str, str]]] = defaultdict(list)
    dimensions: Counter[str] = Counter()
    for split in MPDD_SPLITS:
        split_root = source_root / split
        if not split_root.is_dir():
            raise FileNotFoundError(split_root)
        for image_path in sorted(split_root.glob("*.jpg")):
            parsed = parse_mpdd_filename(image_path.name)
            with Image.open(image_path) as image:
                image.verify()
            with Image.open(image_path) as image:
                width, height = image.size
                mode = image.mode
            if width <= 0 or height <= 0:
                raise ValueError(f"invalid image dimensions: {image_path}")
            content_sha256 = sha256_file(image_path)
            identity_id = f"mpdd-dog-{int(parsed['identity']):03d}"
            source_file = image_path.relative_to(source_root).as_posix()
            record = {
                "schema_version": "mpdd-release-item-v1",
                "release_id": config["release_id"],
                "source_file": source_file,
                "source_filename": image_path.name,
                "split": split,
                "identity_id": identity_id,
                "publisher_identity": parsed["identity"],
                "camera_code": parsed["camera"],
                "session_code": parsed["session"],
                "sample_code": parsed["sample"],
                "width": width,
                "height": height,
                "mode": mode,
                "sha256": content_sha256,
                "identity_label_source": "publisher_folder_and_filename",
                "clinical_ground_truth": False,
                "training_consent_source": "external_dataset_cc_by_4_0",
            }
            records.append(record)
            hashes[content_sha256].append(
                {"source_file": source_file, "identity_id": identity_id, "split": split}
            )
            dimensions[f"{width}x{height}"] += 1

    split_summary = _validate_split_contract(records, config)
    duplicate_groups = [items for items in hashes.values() if len(items) > 1]
    cross_identity_duplicates = [
        items for items in duplicate_groups if len({item["identity_id"] for item in items}) > 1
    ]
    if cross_identity_duplicates:
        first = cross_identity_duplicates[0]
        raise ValueError(f"exact duplicate image assigned to different identities: {first}")
    audit = {
        "schema_version": "mpdd-audit-v1",
        "release_id": config["release_id"],
        "record_count": len(records),
        **split_summary,
        "exact_duplicate_groups": duplicate_groups,
        "exact_duplicate_group_count": len(duplicate_groups),
        "cross_identity_exact_duplicate_group_count": len(cross_identity_duplicates),
        "dimension_counts": dict(sorted(dimensions.items())),
        "clinical_ground_truth": False,
    }
    return records, audit


def build_mpdd_release(source_root: Path, output_root: Path, config_path: Path) -> dict[str, Any]:
    config = read_json(config_path)
    if config.get("schema_version") != "pet-reid-training-config-v1":
        raise ValueError("unsupported pet Re-ID training config")
    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(f"release output must be empty: {output_root}")

    records, audit = audit_mpdd(source_root, config)
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "dataset-manifest.jsonl"
    manifest_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
    )
    release = {
        "schema_version": "mpdd-dataset-release-v1",
        "release_id": config["release_id"],
        "source": config["source"],
        "manifest_sha256": sha256_file(manifest_path),
        "preprocessing": config["preprocessing"],
        "identity_split_rule": {
            "training": "publisher train/val identities",
            "evaluation": "publisher query/gallery identities unseen during training",
            "random_image_split": False,
        },
        "label_provenance": "Publisher-provided individual identity encoded in filenames.",
        "clinical_ground_truth": False,
        "operational_app_media_included": False,
        "audit": audit,
    }
    (output_root / "dataset-release.json").write_text(
        json.dumps(release, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "release_id": config["release_id"],
        "manifest": str(manifest_path),
        "manifest_sha256": release["manifest_sha256"],
        **audit,
    }


def load_release_records(release_root: Path) -> list[dict[str, Any]]:
    manifest_path = release_root / "dataset-manifest.jsonl"
    records = [
        json.loads(line)
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not records or any(record.get("schema_version") != "mpdd-release-item-v1" for record in records):
        raise ValueError("invalid or empty MPDD release manifest")
    return records
