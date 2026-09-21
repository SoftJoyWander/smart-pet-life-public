from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import time
from typing import Any

import numpy as np
from PIL import Image, ImageEnhance, ImageOps

from .mpdd import read_json, sha256_file
from .oxford import load_oxford_records, records_for_split


IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def letterbox_image(image: Image.Image, output_size: tuple[int, int]) -> tuple[Image.Image, dict[str, int]]:
    output_height, output_width = output_size
    width, height = image.size
    scale = min(output_width / width, output_height / height)
    resized_width = max(1, int(round(width * scale)))
    resized_height = max(1, int(round(height * scale)))
    left = (output_width - resized_width) // 2
    top = (output_height - resized_height) // 2
    resized = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (output_width, output_height), (0, 0, 0))
    canvas.paste(resized, (left, top))
    return canvas, {
        "original_width": width,
        "original_height": height,
        "resized_width": resized_width,
        "resized_height": resized_height,
        "left": left,
        "top": top,
    }


def letterbox_pair(
    image: Image.Image, trimap: Image.Image, output_size: tuple[int, int]
) -> tuple[Image.Image, np.ndarray, dict[str, int]]:
    boxed_image, metadata = letterbox_image(image, output_size)
    resized_mask = trimap.resize(
        (metadata["resized_width"], metadata["resized_height"]),
        Image.Resampling.NEAREST,
    )
    source = np.asarray(resized_mask, dtype=np.uint8)
    target = np.where(source == 2, 0, 1).astype(np.uint8)
    output_height, output_width = output_size
    canvas = np.full((output_height, output_width), 255, dtype=np.uint8)
    top = metadata["top"]
    left = metadata["left"]
    canvas[top : top + metadata["resized_height"], left : left + metadata["resized_width"]] = target
    return boxed_image, canvas, metadata


def restore_probability(probability: np.ndarray, metadata: dict[str, int]) -> np.ndarray:
    top = metadata["top"]
    left = metadata["left"]
    cropped = probability[
        top : top + metadata["resized_height"],
        left : left + metadata["resized_width"],
    ]
    restored = Image.fromarray(cropped.astype(np.float32), mode="F").resize(
        (metadata["original_width"], metadata["original_height"]),
        Image.Resampling.BILINEAR,
    )
    return np.asarray(restored, dtype=np.float32)


def confusion_summary(confusion: np.ndarray) -> dict[str, Any]:
    if confusion.shape != (2, 2):
        raise ValueError("segmentation confusion matrix must be 2x2")
    true_negative, false_positive = (int(value) for value in confusion[0])
    false_negative, true_positive = (int(value) for value in confusion[1])
    foreground_union = true_positive + false_positive + false_negative
    foreground_iou = true_positive / foreground_union if foreground_union else 0.0
    dice_denominator = 2 * true_positive + false_positive + false_negative
    foreground_dice = 2 * true_positive / dice_denominator if dice_denominator else 0.0
    total = int(confusion.sum())
    return {
        "confusion_matrix": confusion.astype(int).tolist(),
        "foreground_iou": foreground_iou,
        "foreground_dice": foreground_dice,
        "pixel_accuracy": (true_positive + true_negative) / total if total else 0.0,
        "foreground_precision": true_positive / (true_positive + false_positive)
        if true_positive + false_positive
        else 0.0,
        "foreground_recall": true_positive / (true_positive + false_negative)
        if true_positive + false_negative
        else 0.0,
        "evaluated_pixel_count": total,
    }


def build_segmentation_model(*, pretrained_backbone: bool = True) -> Any:
    try:
        from torchvision import models
    except ImportError as error:
        raise RuntimeError("segmentation model requires torchvision") from error
    backbone_weights = (
        models.MobileNet_V3_Large_Weights.IMAGENET1K_V1
        if pretrained_backbone
        else None
    )
    return models.segmentation.lraspp_mobilenet_v3_large(
        weights=None,
        weights_backbone=backbone_weights,
        num_classes=2,
    )


def _image_tensor(image: Image.Image) -> Any:
    import torch

    values = np.asarray(image, dtype=np.float32) / 255.0
    values = (values - IMAGENET_MEAN) / IMAGENET_STD
    return torch.from_numpy(values.transpose(2, 0, 1)).float()


def predict_foreground_probability(
    model: Any, image: Image.Image, output_size: tuple[int, int], device: Any
) -> np.ndarray:
    import torch

    boxed, metadata = letterbox_image(ImageOps.exif_transpose(image).convert("RGB"), output_size)
    tensor = _image_tensor(boxed).unsqueeze(0).to(device)
    model.eval()
    with torch.inference_mode():
        logits = model(tensor)["out"]
        probability = torch.softmax(logits, dim=1)[0, 1].cpu().numpy()
    return restore_probability(probability, metadata)


def load_segmentation_checkpoint(checkpoint_path: Path, device: Any) -> tuple[Any, dict[str, Any]]:
    import torch

    checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=True)
    if checkpoint.get("schema_version") != "pet-foreground-segmentation-checkpoint-v1":
        raise ValueError("unsupported segmentation checkpoint")
    # The checkpoint already contains the full backbone. Avoid a network download
    # during evaluation and MPDD preprocessing.
    model = build_segmentation_model(pretrained_backbone=False).to(device)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model, checkpoint


def train_oxford_segmentation(
    data_root: Path,
    release_root: Path,
    config_path: Path,
    output_root: Path,
    cache_root: Path,
) -> dict[str, Any]:
    try:
        import torch
        from torch import nn
        from torch.utils.data import DataLoader, Dataset
    except ImportError as error:
        raise RuntimeError(
            'Install training dependencies with: python -m pip install -e ".[train]"'
        ) from error

    config = read_json(config_path)
    if config.get("schema_version") != "pet-foreground-segmentation-config-v1":
        raise ValueError("unsupported Oxford segmentation config")
    release = read_json(release_root / "dataset-release.json")
    manifest_path = release_root / "dataset-manifest.jsonl"
    if release.get("release_id") != config["release_id"]:
        raise ValueError("Oxford release ID does not match training config")
    if release.get("manifest_sha256") != sha256_file(manifest_path):
        raise ValueError("Oxford manifest checksum mismatch")
    if release.get("operational_app_media_included") is not False:
        raise ValueError("Oxford release must explicitly exclude operational App media")
    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(f"training output must be empty: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    torch.hub.set_dir(str(cache_root.resolve()))

    records = load_oxford_records(release_root)
    selected = {
        split: records_for_split(records, split) for split in ("train", "validation", "test")
    }
    if any(not values for values in selected.values()):
        raise ValueError("Oxford train/validation/test splits must all be non-empty")
    base_root = data_root / "oxford-iiit-pet"
    missing = [
        record["image_file"]
        for record in records
        if not (base_root / record["image_file"]).is_file()
        or not (base_root / record["trimap_file"]).is_file()
    ]
    if missing:
        raise FileNotFoundError(f"missing {len(missing)} Oxford files; first={missing[0]}")

    seed = int(config["seed"])
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.set_num_threads(int(config["training"].get("cpu_threads", 4)))
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    output_size = tuple(int(value) for value in config["preprocessing"]["input_size"])

    class OxfordDataset(Dataset):
        def __init__(self, values: list[dict[str, Any]], training: bool) -> None:
            self.records = values
            self.training = training

        def __len__(self) -> int:
            return len(self.records)

        def __getitem__(self, index: int) -> tuple[Any, Any, str]:
            record = self.records[index]
            with Image.open(base_root / record["image_file"]) as source_image:
                image = ImageOps.exif_transpose(source_image).convert("RGB")
            with Image.open(base_root / record["trimap_file"]) as source_trimap:
                trimap = source_trimap.copy()
            if self.training and random.random() < 0.5:
                image = ImageOps.mirror(image)
                trimap = ImageOps.mirror(trimap)
            if self.training:
                image = ImageEnhance.Brightness(image).enhance(random.uniform(0.85, 1.15))
                image = ImageEnhance.Contrast(image).enhance(random.uniform(0.85, 1.15))
                image = ImageEnhance.Color(image).enhance(random.uniform(0.90, 1.10))
            boxed, target, _ = letterbox_pair(image, trimap, output_size)
            return _image_tensor(boxed), torch.from_numpy(target.astype(np.int64)), record["species"]

    training_config = config["training"]
    loaders = {
        split: DataLoader(
            OxfordDataset(values, training=split == "train"),
            batch_size=int(training_config["batch_size"]),
            shuffle=split == "train",
            num_workers=int(training_config["num_workers"]),
            pin_memory=torch.cuda.is_available(),
        )
        for split, values in selected.items()
    }
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = build_segmentation_model().to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(training_config["learning_rate"]),
        weight_decay=float(training_config["weight_decay"]),
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=int(training_config["epochs"])
    )
    loss_weights = torch.tensor(
        [1.0, float(training_config["foreground_loss_weight"])], device=device
    )
    criterion = nn.CrossEntropyLoss(weight=loss_weights, ignore_index=255)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    def evaluate(split: str) -> dict[str, Any]:
        model.eval()
        confusion_by_group = {
            "all": np.zeros((2, 2), dtype=np.int64),
            "dog": np.zeros((2, 2), dtype=np.int64),
            "cat": np.zeros((2, 2), dtype=np.int64),
        }
        losses: list[float] = []
        with torch.inference_mode():
            for images, targets, species_values in loaders[split]:
                images = images.to(device)
                targets = targets.to(device)
                logits = model(images)["out"]
                losses.append(float(criterion(logits, targets).cpu()))
                predictions = logits.argmax(dim=1)
                valid = targets != 255
                for group in ("all", "dog", "cat"):
                    group_mask = valid.clone()
                    if group != "all":
                        selected_rows = torch.tensor(
                            [value == group for value in species_values],
                            dtype=torch.bool,
                            device=device,
                        )
                        group_mask &= selected_rows[:, None, None]
                    values = targets[group_mask] * 2 + predictions[group_mask]
                    if values.numel():
                        confusion_by_group[group] += (
                            torch.bincount(values, minlength=4).reshape(2, 2).cpu().numpy()
                        )
        return {
            "loss": float(np.mean(losses)),
            "all": confusion_summary(confusion_by_group["all"]),
            "dog": confusion_summary(confusion_by_group["dog"]),
            "cat": confusion_summary(confusion_by_group["cat"]),
        }

    started = time.time()
    history: list[dict[str, Any]] = []
    best_iou = -1.0
    best_epoch = 0
    best_state: dict[str, Any] | None = None
    for epoch in range(1, int(training_config["epochs"]) + 1):
        model.train()
        losses: list[float] = []
        for images, targets, _ in loaders["train"]:
            images = images.to(device)
            targets = targets.to(device)
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast(device_type=device.type, enabled=device.type == "cuda"):
                logits = model(images)["out"]
                loss = criterion(logits, targets)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            losses.append(float(loss.detach().cpu()))
        scheduler.step()
        validation = evaluate("validation")
        result = {
            "epoch": epoch,
            "learning_rate": optimizer.param_groups[0]["lr"],
            "training_loss": float(np.mean(losses)),
            "validation": validation,
        }
        history.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        validation_iou = float(validation["all"]["foreground_iou"])
        if validation_iou > best_iou:
            best_iou = validation_iou
            best_epoch = epoch
            best_state = copy.deepcopy(model.state_dict())

    if best_state is None:
        raise RuntimeError("segmentation training did not produce a checkpoint")
    model.load_state_dict(best_state)
    test_metrics = evaluate("test")
    checkpoint_path = output_root / "best-checkpoint.pt"
    torch.save(
        {
            "schema_version": "pet-foreground-segmentation-checkpoint-v1",
            "release_id": config["release_id"],
            "config": config,
            "best_epoch": best_epoch,
            "state_dict": best_state,
        },
        checkpoint_path,
    )
    evaluation = {
        "schema_version": "pet-foreground-segmentation-evaluation-v1",
        "model_version": f"oxford-lraspp-mobilenetv3-large-v1-epoch-{best_epoch}",
        "release_id": config["release_id"],
        "best_epoch": best_epoch,
        "validation_best_foreground_iou": best_iou,
        "test": test_metrics,
        "split_counts": {split: len(values) for split, values in selected.items()},
        "runtime": {
            "device": str(device),
            "torch_version": torch.__version__,
            "elapsed_seconds": time.time() - started,
        },
        "limitations": [
            "Oxford-IIIT Pet has breed/species labels but no individual pet or household identity.",
            "Internet images do not validate Taiwan street or mobile-camera performance.",
            "This model segments pet foreground; it does not identify an individual animal.",
            "Operational Smart Pet Life media is not included.",
        ],
    }
    _write_json(output_root / "training-history.json", history)
    _write_json(output_root / "evaluation.json", evaluation)
    model_card = {
        "schema_version": "pet-foreground-segmentation-model-card-v1",
        "model_version": evaluation["model_version"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dataset_release_id": config["release_id"],
        "dataset_manifest_sha256": release["manifest_sha256"],
        "source_license": config["source"]["license"],
        "architecture": config["model"],
        "preprocessing": config["preprocessing"],
        "crop_contract": config["crop"],
        "intended_use": config["intended_use"],
        "prohibited_claims": config["prohibited_claims"],
        "clinical_ground_truth": False,
        "identity_annotations_available": False,
        "operational_app_media_included": False,
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "evaluation_file": "evaluation.json",
    }
    _write_json(output_root / "model-card.json", model_card)
    return {
        "model_version": evaluation["model_version"],
        "best_epoch": best_epoch,
        "checkpoint": str(checkpoint_path),
        "checkpoint_sha256": model_card["checkpoint_sha256"],
        "test": test_metrics,
        "runtime": evaluation["runtime"],
    }
