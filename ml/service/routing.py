"""Dependency-free routing guard used by the service and local tests."""

from __future__ import annotations

import os


def optional_threshold(name: str) -> float | None:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return None
    value = float(raw)
    if not 0.0 <= value <= 1.0:
        raise RuntimeError(f"{name} must be between 0 and 1")
    return value


def route(probability: float) -> tuple[str, bool, str | None]:
    present = optional_threshold("STOOL_PRESENT_THRESHOLD")
    threshold_version = os.getenv("STOOL_THRESHOLD_SET_VERSION")
    if present is None or threshold_version is None:
        return "uncertain", True, None
    if probability >= present:
        return "present", False, threshold_version
    return "uncertain", True, threshold_version
