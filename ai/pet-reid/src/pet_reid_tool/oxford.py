from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageOps

from .mpdd import read_json, sha256_file


OXFORD_OFFICIAL_SPLITS = ("trainval", "test")
VALID_TRIMAP_VALUES = {1, 2, 3}


class _UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, value: int) -> int:
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.rank[left_root] < self.rank[right_root]:
            left_root, right_root = right_root, left_root
        self.parent[right_root] = left_root
        if self.rank[left_root] == self.rank[right_root]:
            self.rank[left_root] += 1


class _BkNode:
    def __init__(self, value: int, index: int) -> None:
        self.value = value
        self.indices = [index]
        self.children: dict[int, _BkNode] = {}

    def add(self, value: int, index: int) -> None:
        distance = (self.value ^ value).bit_count()
        if distance == 0:
            self.indices.append(index)
            return
        child = self.children.get(distance)
        if child is None:
            self.children[distance] = _BkNode(value, index)
        else:
            child.add(value, index)

    def query(self, value: int, maximum_distance: int) -> list[int]:
        distance = (self.value ^ value).bit_count()
        matches = list(self.indices) if distance <= maximum_distance else []
        minimum = max(1, distance - maximum_distance)
        maximum = distance + maximum_distance
        for child_distance, child in self.children.items():
            if minimum <= child_distance <= maximum:
                matches.extend(child.query(value, maximum_distance))
        return matches


def parse_oxford_annotation_line(line: str) -> dict[str, Any]:
    parts = line.strip().split()
    if len(parts) != 4:
        raise ValueError(f"unexpected Oxford annotation line: {line!r}")
    image_id, breed_label, species_label, _ = parts
    if not breed_label.isdigit() or not species_label.isdigit():
        raise ValueError(f"invalid Oxford labels: {line!r}")
    species_value = int(species_label)
    if species_value not in (1, 2):
        raise ValueError(f"invalid Oxford species label: {species_label}")
    return {
        "image_id": image_id,
        "breed": image_id.rsplit("_", 1)[0],
        "breed_label": int(breed_label),
        "species": "cat" if species_value == 1 else "dog",
        "publisher_species_label": species_value,
    }


def image_dhash(image: Image.Image) -> int:
    grayscale = ImageOps.exif_transpose(image).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    values = np.asarray(grayscale, dtype=np.int16)
    bits = values[:, 1:] > values[:, :-1]
    result = 0
    for value in bits.ravel():
        result = (result << 1) | int(value)
    return result


def _md5_file(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_oxford_dataset(data_root: Path) -> Path:
    try:
        from torchvision.datasets import OxfordIIITPet
    except ImportError as error:
        raise RuntimeError("Oxford download requires torchvision") from error
    data_root.mkdir(parents=True, exist_ok=True)
    OxfordIIITPet(root=data_root, split="trainval", target_types="segmentation", download=True)
    OxfordIIITPet(root=data_root, split="test", target_types="segmentation", download=False)
    return data_root / "oxford-iiit-pet"


def _group_records(records: list[dict[str, Any]], maximum_distance: int) -> list[list[int]]:
    union_find = _UnionFind(len(records))
    tree: _BkNode | None = None
    for index, record in enumerate(records):
        value = int(record["dhash_64"], 16)
        if tree is None:
            tree = _BkNode(value, index)
            continue
        for match in tree.query(value, maximum_distance):
            union_find.union(index, match)
        tree.add(value, index)
    groups: dict[int, list[int]] = defaultdict(list)
    for index in range(len(records)):
        groups[union_find.find(index)].append(index)
    return sorted(groups.values(), key=lambda values: min(records[index]["image_id"] for index in values))


def _stable_score(seed: int, value: str) -> float:
    digest = hashlib.sha256(f"{seed}:{value}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / float(2**64)


def _assign_splits(
    records: list[dict[str, Any]], groups: list[list[int]], config: dict[str, Any]
) -> dict[str, Any]:
    validation_fraction = float(config["split"]["validation_fraction"])
    seed = int(config["seed"])
    group_ids: dict[int, str] = {}
    group_by_id: dict[str, list[int]] = {}
    cross_official_groups: set[str] = set()
    for indices in groups:
        image_ids = sorted(records[index]["image_id"] for index in indices)
        group_id = "dhash-" + hashlib.sha256("\n".join(image_ids).encode("utf-8")).hexdigest()[:16]
        group_by_id[group_id] = indices
        for index in indices:
            group_ids[index] = group_id
        if len({records[index]["official_split"] for index in indices}) > 1:
            cross_official_groups.add(group_id)

    eligible_trainval_groups = {
        group_id: indices
        for group_id, indices in group_by_id.items()
        if group_id not in cross_official_groups
        and all(records[index]["official_split"] == "trainval" for index in indices)
        and all(records[index]["segmentation_label_status"] == "usable" for index in indices)
    }
    validation_groups = {
        group_id
        for group_id in eligible_trainval_groups
        if _stable_score(seed, group_id) < validation_fraction
    }

    breeds = sorted(
        {
            record["breed"]
            for record in records
            if record["official_split"] == "trainval"
            and record["segmentation_label_status"] == "usable"
        }
    )
    for breed in breeds:
        breed_groups = [
            group_id
            for group_id, indices in eligible_trainval_groups.items()
            if any(records[index]["breed"] == breed for index in indices)
        ]
        if not breed_groups:
            continue
        if not any(group_id in validation_groups for group_id in breed_groups):
            validation_groups.add(min(breed_groups, key=lambda value: _stable_score(seed, value)))
        if all(group_id in validation_groups for group_id in breed_groups) and len(breed_groups) > 1:
            validation_groups.remove(max(breed_groups, key=lambda value: _stable_score(seed, value)))

    for index, record in enumerate(records):
        group_id = group_ids[index]
        record["near_duplicate_cluster_id"] = group_id if len(group_by_id[group_id]) > 1 else None
        if record["segmentation_label_status"] != "usable":
            record["assigned_split"] = "excluded"
            record["eligibility_status"] = "excluded_empty_foreground"
        elif record["official_split"] == "test":
            record["assigned_split"] = "test"
            record["eligibility_status"] = "eligible"
        elif group_id in cross_official_groups:
            record["assigned_split"] = "excluded"
            record["eligibility_status"] = "excluded_trainval_test_near_duplicate"
        elif group_id in validation_groups:
            record["assigned_split"] = "validation"
            record["eligibility_status"] = "eligible"
        else:
            record["assigned_split"] = "train"
            record["eligibility_status"] = "eligible"

    split_counts = Counter(record["assigned_split"] for record in records)
    return {
        "assigned_split_counts": dict(sorted(split_counts.items())),
        "near_duplicate_group_count": sum(len(indices) > 1 for indices in groups),
        "cross_official_near_duplicate_group_count": len(cross_official_groups),
        "excluded_trainval_count": sum(
            record["official_split"] == "trainval"
            and record["eligibility_status"] != "eligible"
            for record in records
        ),
        "excluded_test_count": sum(
            record["official_split"] == "test"
            and record["eligibility_status"] != "eligible"
            for record in records
        ),
        "excluded_empty_foreground_count": sum(
            record["segmentation_label_status"] == "empty_foreground"
            for record in records
        ),
        "excluded_empty_foreground_by_official_split": dict(
            sorted(
                Counter(
                    record["official_split"]
                    for record in records
                    if record["segmentation_label_status"] == "empty_foreground"
                ).items()
            )
        ),
    }


def audit_oxford(data_root: Path, config: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    base_root = data_root / "oxford-iiit-pet"
    images_root = base_root / "images"
    annotations_root = base_root / "annotations"
    trimaps_root = annotations_root / "trimaps"
    records: list[dict[str, Any]] = []
    official_counts: Counter[str] = Counter()
    image_hashes: dict[str, list[int]] = defaultdict(list)
    breed_species: dict[str, str] = {}
    empty_foreground_counts: Counter[str] = Counter()

    for official_split in OXFORD_OFFICIAL_SPLITS:
        annotation_path = annotations_root / f"{official_split}.txt"
        if not annotation_path.is_file():
            raise FileNotFoundError(annotation_path)
        for line in annotation_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            parsed = parse_oxford_annotation_line(line)
            image_path = images_root / f"{parsed['image_id']}.jpg"
            trimap_path = trimaps_root / f"{parsed['image_id']}.png"
            if not image_path.is_file() or not trimap_path.is_file():
                raise FileNotFoundError(f"missing Oxford pair: {image_path}, {trimap_path}")
            with Image.open(image_path) as image:
                oriented = ImageOps.exif_transpose(image).convert("RGB")
                width, height = oriented.size
                dhash_value = image_dhash(oriented)
            with Image.open(trimap_path) as trimap_image:
                trimap = np.asarray(trimap_image, dtype=np.uint8)
            if trimap.shape != (height, width):
                raise ValueError(f"Oxford image/trimap size mismatch: {parsed['image_id']}")
            values = {int(value) for value in np.unique(trimap)}
            if not values or not values.issubset(VALID_TRIMAP_VALUES):
                raise ValueError(f"unexpected trimap values for {parsed['image_id']}: {values}")
            foreground = (trimap == 1) | (trimap == 3)
            rows, columns = np.where(foreground)
            has_foreground = bool(len(rows))
            if not has_foreground:
                empty_foreground_counts[official_split] += 1
            image_sha256 = sha256_file(image_path)
            trimap_sha256 = sha256_file(trimap_path)
            breed = parsed["breed"]
            previous_species = breed_species.setdefault(breed, parsed["species"])
            if previous_species != parsed["species"]:
                raise ValueError(f"breed species changed: {breed}")
            record = {
                "schema_version": "oxford-pet-segmentation-item-v1",
                "release_id": config["release_id"],
                "image_id": parsed["image_id"],
                "image_file": image_path.relative_to(base_root).as_posix(),
                "trimap_file": trimap_path.relative_to(base_root).as_posix(),
                "official_split": official_split,
                "assigned_split": None,
                "eligibility_status": None,
                "species": parsed["species"],
                "breed": breed,
                "publisher_breed_label": parsed["breed_label"],
                "publisher_species_label": parsed["publisher_species_label"],
                "width": width,
                "height": height,
                "segmentation_label_status": "usable" if has_foreground else "empty_foreground",
                "foreground_bbox_xyxy": (
                    [
                        int(columns.min()),
                        int(rows.min()),
                        int(columns.max()) + 1,
                        int(rows.max()) + 1,
                    ]
                    if has_foreground
                    else None
                ),
                "foreground_fraction": float(foreground.mean()),
                "foreground_touches_image_border": bool(
                    foreground[0].any()
                    or foreground[-1].any()
                    or foreground[:, 0].any()
                    or foreground[:, -1].any()
                ),
                "image_sha256": image_sha256,
                "trimap_sha256": trimap_sha256,
                "dhash_64": f"{dhash_value:016x}",
                "near_duplicate_cluster_id": None,
                "label_source": "publisher_pixel_trimap",
                "clinical_ground_truth": False,
                "training_consent_source": "external_dataset_cc_by_sa_4_0",
            }
            image_hashes[image_sha256].append(len(records))
            records.append(record)
            official_counts[official_split] += 1

    expected = config["expected"]
    if len(records) != int(expected["image_count"]):
        raise ValueError(f"Oxford image count mismatch: {len(records)} != {expected['image_count']}")
    if dict(official_counts) != expected["official_split_counts"]:
        raise ValueError(
            f"Oxford split counts mismatch: {dict(official_counts)} != "
            f"{expected['official_split_counts']}"
        )
    empty_foreground_count = sum(empty_foreground_counts.values())
    if "empty_foreground_count" in expected and empty_foreground_count != int(
        expected["empty_foreground_count"]
    ):
        raise ValueError(
            f"Oxford empty foreground count mismatch: {empty_foreground_count} != "
            f"{expected['empty_foreground_count']}"
        )
    if "empty_foreground_by_official_split" in expected and dict(
        empty_foreground_counts
    ) != expected["empty_foreground_by_official_split"]:
        raise ValueError(
            "Oxford empty foreground split counts mismatch: "
            f"{dict(empty_foreground_counts)} != "
            f"{expected['empty_foreground_by_official_split']}"
        )
    breeds = set(breed_species)
    if len(breeds) != int(expected["breed_count"]):
        raise ValueError(f"Oxford breed count mismatch: {len(breeds)}")
    species_breed_counts = Counter(breed_species.values())
    if dict(species_breed_counts) != expected["species_breed_counts"]:
        raise ValueError(
            f"Oxford species breed counts mismatch: {dict(species_breed_counts)} != "
            f"{expected['species_breed_counts']}"
        )

    exact_duplicate_groups = [indices for indices in image_hashes.values() if len(indices) > 1]
    cross_label_exact = [
        indices
        for indices in exact_duplicate_groups
        if len({(records[index]["species"], records[index]["breed"]) for index in indices}) > 1
    ]
    if cross_label_exact:
        raise ValueError("exact Oxford image duplicate has conflicting breed/species labels")

    groups = _group_records(records, int(config["split"]["near_duplicate_dhash_max_distance"]))
    split_audit = _assign_splits(records, groups, config)
    assigned_species = Counter(
        f"{record['assigned_split']}:{record['species']}" for record in records
    )
    audit = {
        "schema_version": "oxford-pet-segmentation-audit-v1",
        "release_id": config["release_id"],
        "record_count": len(records),
        "official_split_counts": dict(official_counts),
        "breed_count": len(breeds),
        "species_breed_counts": dict(species_breed_counts),
        "assigned_split_species_counts": dict(sorted(assigned_species.items())),
        "exact_duplicate_group_count": len(exact_duplicate_groups),
        "cross_label_exact_duplicate_group_count": len(cross_label_exact),
        **split_audit,
        "identity_annotations_available": False,
        "clinical_ground_truth": False,
    }
    return records, audit


def build_oxford_release(
    data_root: Path, output_root: Path, config_path: Path, *, download: bool = False
) -> dict[str, Any]:
    config = read_json(config_path)
    if config.get("schema_version") != "pet-foreground-segmentation-config-v1":
        raise ValueError("unsupported Oxford segmentation config")
    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(f"release output must be empty: {output_root}")
    if download:
        download_oxford_dataset(data_root)
    records, audit = audit_oxford(data_root, config)
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "dataset-manifest.jsonl"
    manifest_path.write_text(
        "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records),
        encoding="utf-8",
        newline="\n",
    )
    base_root = data_root / "oxford-iiit-pet"
    archives = []
    for resource in config["source"]["resources"]:
        archive_path = base_root / resource["filename"]
        archives.append(
            {
                **resource,
                "present": archive_path.is_file(),
                "md5_verified": archive_path.is_file()
                and _md5_file(archive_path) == resource["md5"],
                "sha256": sha256_file(archive_path) if archive_path.is_file() else None,
            }
        )
    release = {
        "schema_version": "oxford-pet-segmentation-release-v1",
        "release_id": config["release_id"],
        "source": {**config["source"], "resources": archives},
        "manifest_sha256": sha256_file(manifest_path),
        "preprocessing": config["preprocessing"],
        "split_rule": {
            "official_test_is_immutable": True,
            "train_validation": "deterministic dHash-cluster split with breed coverage",
            "random_image_split": False,
            "pet_or_household_grouping_available": False,
        },
        "label_provenance": "Publisher pixel-level trimap; not an individual identity label.",
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


def load_oxford_records(release_root: Path) -> list[dict[str, Any]]:
    manifest_path = release_root / "dataset-manifest.jsonl"
    records = [
        json.loads(line)
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not records or any(
        record.get("schema_version") != "oxford-pet-segmentation-item-v1"
        for record in records
    ):
        raise ValueError("invalid or empty Oxford segmentation manifest")
    return records


def records_for_split(records: Iterable[dict[str, Any]], split: str) -> list[dict[str, Any]]:
    return [
        record
        for record in records
        if record["assigned_split"] == split and record["eligibility_status"] == "eligible"
    ]
