"""Authenticated ONNX inference endpoint used by the Supabase Edge Function."""

from __future__ import annotations

import hmac
import io
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Header, HTTPException, Request
from PIL import Image, UnidentifiedImageError

from ml.service.routing import route

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
SHITSPOTTER_YOLO_FAMILY = "shitspotter_yolov9_v06"
BINARY_CLASSIFIER_FAMILY = "mobilenet_binary_v1"
SHITSPOTTER_VALIDATION_ACTIVATION_FLOOR = 0.0001
STOOL_ROI_SIZE = (768, 768)
STOOL_ROI_INPUT_VERSION = "stool-roi-768-square-v1"
STOOL_ROI_PREPROCESSING_VERSION = "stool-roi-768-to-imagenet-224-v1"
LEGACY_BINARY_PREPROCESSING_VERSION = "legacy-full-image-imagenet-resize-224-v1"

logger = logging.getLogger("stool_inference")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Fail deployment startup if the pinned model cannot be loaded."""
    session()
    yield


app = FastAPI(title="Smart Pet Life stool-presence inference", version="1.0.0", lifespan=lifespan)


@lru_cache
def session() -> ort.InferenceSession:
    model_path = os.environ["STOOL_MODEL_PATH"]
    return ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])


def decode_image(payload: bytes) -> Image.Image:
    try:
        return Image.open(io.BytesIO(payload)).convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=422, detail="unsupported_or_corrupt_image") from error


def preprocess_binary_classifier(image: Image.Image) -> np.ndarray:
    """Resize an already extracted stool ROI exactly like the Colab validation transform."""
    image = image.resize((224, 224), Image.Resampling.BILINEAR)
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - np.asarray([0.485, 0.456, 0.406], dtype=np.float32)) / np.asarray(
        [0.229, 0.224, 0.225], dtype=np.float32
    )
    return np.transpose(array, (2, 0, 1))[None, ...]


def binary_preprocessing_version(image: Image.Image) -> str:
    """Keep rollout lineage explicit while older full-image App uploads still exist."""
    if image.size == STOOL_ROI_SIZE:
        return STOOL_ROI_PREPROCESSING_VERSION
    return LEGACY_BINARY_PREPROCESSING_VERSION


def preprocess_shitspotter_yolo(image: Image.Image) -> np.ndarray:
    """Match the published ShitSpotter ONNX demo: 640 square, CHW, 0..255 float."""
    image = image.resize((640, 640), Image.Resampling.BILINEAR)
    array = np.asarray(image, dtype=np.float32)
    return np.transpose(array, (2, 0, 1))[None, ...]


def sigmoid(value: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(value, -80.0, 80.0)))


def max_detection_confidence(outputs: list[np.ndarray]) -> float:
    return float(detection_score_diagnostics(outputs)["max_activation"])


def detection_score_diagnostics(outputs: list[np.ndarray]) -> dict[str, object]:
    if len(outputs) != 3 or any(output.ndim != 4 or output.shape[1] != 1 for output in outputs):
        raise RuntimeError("unexpected_shitspotter_output_contract")
    activations = [sigmoid(output) for output in outputs]
    return {
        "max_activation": max(float(activation.max()) for activation in activations),
        "max_logit": max(float(output.max()) for output in outputs),
        "activation_floor": SHITSPOTTER_VALIDATION_ACTIVATION_FLOOR,
        "activation_count_above_floor": sum(
            int(np.count_nonzero(activation >= SHITSPOTTER_VALIDATION_ACTIVATION_FLOOR))
            for activation in activations
        ),
        "confidence_map_shapes": [list(output.shape) for output in outputs],
    }


def main_confidence_output_names(model: ort.InferenceSession) -> list[str]:
    names: list[str] = []
    seen_sizes: set[tuple[int, int]] = set()
    for output in model.get_outputs():
        shape = output.shape
        if len(shape) != 4 or shape[1] != 1 or not isinstance(shape[2], int) or not isinstance(shape[3], int):
            continue
        size = (shape[2], shape[3])
        if size in seen_sizes:
            continue
        names.append(output.name)
        seen_sizes.add(size)
        if len(names) == 3:
            break
    if len(names) != 3:
        raise RuntimeError("unexpected_shitspotter_output_contract")
    return names


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "model_version": os.getenv("STOOL_MODEL_VERSION", "unconfigured"),
        "model_family": os.getenv("STOOL_MODEL_FAMILY", BINARY_CLASSIFIER_FAMILY),
    }


@app.get("/")
def service_info() -> dict[str, object]:
    threshold = os.getenv("STOOL_PRESENT_THRESHOLD")
    return {
        "service": "Smart Pet Life stool-presence inference",
        "status": "experimental",
        "health_url": "/health",
        "inference_url": "/v1/stool-presence",
        "review_policy": "scores_below_present_threshold_require_human_review" if threshold else "all_results_require_human_review",
        "present_threshold": float(threshold) if threshold else None,
        "threshold_set_version": os.getenv("STOOL_THRESHOLD_SET_VERSION"),
        "medical_use": False,
    }


@app.post("/v1/stool-presence")
async def infer(
    request: Request,
    x_service_token: Annotated[str | None, Header()] = None,
    x_observation_id: Annotated[str | None, Header()] = None,
) -> dict[str, object]:
    started_at = time.perf_counter()
    expected = os.getenv("STOOL_SERVICE_TOKEN")
    if not expected or not x_service_token or not hmac.compare_digest(expected, x_service_token):
        raise HTTPException(status_code=401, detail="invalid_service_token")
    if not x_observation_id:
        raise HTTPException(status_code=400, detail="missing_observation_id")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="unsupported_content_type")
    payload = await request.body()
    if not payload or len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="invalid_image_size")

    image = decode_image(payload)
    model = session()
    model_family = os.getenv("STOOL_MODEL_FAMILY", BINARY_CLASSIFIER_FAMILY)
    if model_family == SHITSPOTTER_YOLO_FAMILY:
        tensor = preprocess_shitspotter_yolo(image)
        output_names = main_confidence_output_names(model)
        diagnostics = detection_score_diagnostics(
            model.run(output_names, {model.get_inputs()[0].name: tensor})
        )
        stool_probability = float(diagnostics["max_activation"])
        score_kind = "max_poop_detection_confidence_uncalibrated"
        calibrated = False
        preprocessing_version = "shitspotter-square-640-raw-float-v1"
        candidate_code = "uncertain"
    elif model_family == BINARY_CLASSIFIER_FAMILY:
        preprocessing_version = binary_preprocessing_version(image)
        tensor = preprocess_binary_classifier(image)
        logits = model.run(None, {model.get_inputs()[0].name: tensor})[0][0]
        shifted = logits - np.max(logits)
        probabilities = np.exp(shifted) / np.sum(np.exp(shifted))
        stool_probability = float(probabilities[1])
        score_kind = "binary_softmax_probability_uncalibrated"
        calibrated = False
        diagnostics = None
        candidate_code = "present" if probabilities[1] >= probabilities[0] else "absent"
    else:
        raise HTTPException(status_code=500, detail="unsupported_model_family")

    result_code, review_required, threshold_version = route(stool_probability)
    response = {
        "schema_version": "stool-inference-v1",
        "observation_id": x_observation_id,
        "model_version": os.getenv("STOOL_MODEL_VERSION", "unconfigured"),
        "model_family": model_family,
        "input_roi_version": STOOL_ROI_INPUT_VERSION if image.size == STOOL_ROI_SIZE else None,
        "preprocessing_version": preprocessing_version,
        "stool_probability": stool_probability,
        "score_kind": score_kind,
        "calibrated": calibrated,
        "candidate_code": candidate_code,
        "result_code": result_code,
        "review_required": review_required,
        "threshold_set_version": threshold_version,
        "medical_interpretation": None,
    }
    if diagnostics is not None:
        response["score_diagnostics"] = {
            **diagnostics,
            "selected_output_names": output_names,
        }
    logger.info(json.dumps({
        "event": "stool_inference_completed",
        "observation_id": x_observation_id,
        "model_version": response["model_version"],
        "model_family": model_family,
        "input_roi_version": response["input_roi_version"],
        "preprocessing_version": preprocessing_version,
        "score_kind": score_kind,
        "calibrated": calibrated,
        "raw_score": stool_probability,
        "score_diagnostics": response.get("score_diagnostics"),
        "result_code": result_code,
        "review_required": review_required,
        "image_width": image.width,
        "image_height": image.height,
        "payload_bytes": len(payload),
        "latency_ms": round((time.perf_counter() - started_at) * 1000),
    }, separators=(",", ":")))
    return response
