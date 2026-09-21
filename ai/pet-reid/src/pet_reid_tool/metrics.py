from __future__ import annotations

import hashlib
from typing import Any, Iterable

import numpy as np


def cosine_similarity_matrix(query: np.ndarray, gallery: np.ndarray) -> np.ndarray:
    if query.ndim != 2 or gallery.ndim != 2 or query.shape[1] != gallery.shape[1]:
        raise ValueError("query and gallery embeddings must be aligned 2D arrays")
    query_norm = query / np.clip(np.linalg.norm(query, axis=1, keepdims=True), 1e-12, None)
    gallery_norm = gallery / np.clip(np.linalg.norm(gallery, axis=1, keepdims=True), 1e-12, None)
    return query_norm @ gallery_norm.T


def rank_metrics(
    query_embeddings: np.ndarray,
    query_ids: list[str],
    gallery_embeddings: np.ndarray,
    gallery_ids: list[str],
    rank_k: Iterable[int] = (1, 5),
) -> dict[str, Any]:
    if len(query_ids) != len(query_embeddings) or len(gallery_ids) != len(gallery_embeddings):
        raise ValueError("embedding and identity counts must match")
    similarities = cosine_similarity_matrix(query_embeddings, gallery_embeddings)
    order = np.argsort(-similarities, axis=1)
    ks = sorted({int(value) for value in rank_k if int(value) > 0})
    hits = {value: 0 for value in ks}
    average_precisions: list[float] = []
    first_scores: list[float] = []
    first_correct: list[bool] = []
    for index, query_id in enumerate(query_ids):
        ranked = order[index]
        relevant = np.array([gallery_ids[position] == query_id for position in ranked], dtype=bool)
        if not relevant.any():
            raise ValueError(f"query identity has no gallery match: {query_id}")
        for value in ks:
            hits[value] += int(relevant[:value].any())
        relevant_positions = np.flatnonzero(relevant)
        precisions = [
            relevant[: position + 1].sum() / (position + 1) for position in relevant_positions
        ]
        average_precisions.append(float(np.mean(precisions)))
        first_scores.append(float(similarities[index, ranked[0]]))
        first_correct.append(bool(relevant[0]))
    count = len(query_ids)
    return {
        "query_count": count,
        "gallery_count": len(gallery_ids),
        "rank": {str(value): hits[value] / count for value in ks},
        "mAP": float(np.mean(average_precisions)),
        "rank1_scores": first_scores,
        "rank1_correct": first_correct,
    }


def deterministic_identity_partition(
    identities: Iterable[str], seed: int, known_fraction: float
) -> tuple[set[str], set[str]]:
    values = sorted(set(identities))
    if len(values) < 2 or not 0.0 < known_fraction < 1.0:
        raise ValueError("open-set partition requires at least two identities and 0 < fraction < 1")
    ordered = sorted(
        values,
        key=lambda value: hashlib.sha256(f"{seed}:{value}".encode("utf-8")).hexdigest(),
    )
    known_count = min(len(values) - 1, max(1, round(len(values) * known_fraction)))
    return set(ordered[:known_count]), set(ordered[known_count:])


def select_eer_threshold(known_scores: Iterable[float], unknown_scores: Iterable[float]) -> dict[str, float]:
    known = np.asarray(list(known_scores), dtype=np.float64)
    unknown = np.asarray(list(unknown_scores), dtype=np.float64)
    if known.size == 0 or unknown.size == 0:
        raise ValueError("EER threshold selection requires known and unknown scores")
    candidates = np.unique(np.concatenate([known, unknown]))
    candidates = np.concatenate(
        [[np.nextafter(candidates.min(), -np.inf)], candidates, [np.nextafter(candidates.max(), np.inf)]]
    )
    best: tuple[tuple[float, float], dict[str, float]] | None = None
    for threshold in candidates:
        false_accept_rate = float(np.mean(unknown >= threshold))
        false_reject_rate = float(np.mean(known < threshold))
        value = {
            "threshold": float(threshold),
            "false_accept_rate": false_accept_rate,
            "false_reject_rate": false_reject_rate,
            "eer_estimate": (false_accept_rate + false_reject_rate) / 2,
        }
        key = (abs(false_accept_rate - false_reject_rate), value["eer_estimate"])
        if best is None or key < best[0]:
            best = (key, value)
    assert best is not None
    return best[1]


def open_set_metrics(
    scores: Iterable[float],
    is_known: Iterable[bool],
    rank1_correct: Iterable[bool],
    threshold: float,
) -> dict[str, float | int]:
    score_values = np.asarray(list(scores), dtype=np.float64)
    known_values = np.asarray(list(is_known), dtype=bool)
    correct_values = np.asarray(list(rank1_correct), dtype=bool)
    if not (len(score_values) == len(known_values) == len(correct_values)) or not len(score_values):
        raise ValueError("open-set inputs must be non-empty and aligned")
    accepted = score_values >= threshold
    known_count = int(known_values.sum())
    unknown_count = int((~known_values).sum())
    if known_count == 0 or unknown_count == 0:
        raise ValueError("open-set metrics require both known and unknown queries")
    return {
        "threshold": float(threshold),
        "known_query_count": known_count,
        "unknown_query_count": unknown_count,
        "known_accept_rate": float(np.mean(accepted[known_values])),
        "unknown_false_accept_rate": float(np.mean(accepted[~known_values])),
        "accepted_rank1_identification_rate": float(
            np.mean((accepted & correct_values)[known_values])
        ),
    }
