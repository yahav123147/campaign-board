#!/usr/bin/env python3
"""Verify a cutout against its source and the tool provenance record.

Usage:
  check-cutout.py <candidate...>
  check-cutout.py --source <source> <candidate>
  check-cutout.py --json [--source <source>] <candidate...>

Exit 0 means every candidate passed. Exit 1 means at least one quality failure.
Exit 2 means invalid CLI input. Exit 3 means a candidate needs human review.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


SCHEMA_VERSION = 1
MIN_FOREGROUND_PIXELS = 64
MIN_FOREGROUND_DIMENSION = 8
MIN_BBOX_OCCUPANCY = 0.04


def has_useful_alpha(image: Image.Image) -> bool:
    alpha = image.convert("RGBA").getchannel("A")
    values = alpha.tobytes()
    minimum_transparent_pixels = max(16, round(len(values) * 0.001))
    foreground_bbox = alpha.getbbox()
    return (
        foreground_bbox is not None
        and foreground_bbox != (0, 0, image.width, image.height)
        and sum(value < 250 for value in values) >= minimum_transparent_pixels
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metadata_path(candidate: Path) -> Path:
    return candidate.with_name(candidate.name + ".cutout.json")


def alpha_metrics(image: Image.Image) -> dict[str, Any]:
    alpha = image.convert("RGBA").getchannel("A")
    values = alpha.tobytes()
    kept = sum(value > 16 for value in values)
    bbox = alpha.getbbox()
    if bbox is None:
        return {"foregroundPixels": 0, "bbox": None, "bboxOccupancy": 0.0}
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    return {
        "foregroundPixels": kept,
        "bbox": list(bbox),
        "bboxOccupancy": kept / (width * height),
    }


def quality_problems(image: Image.Image) -> tuple[list[str], dict[str, Any]]:
    metrics = alpha_metrics(image)
    problems: list[str] = []
    bbox = metrics["bbox"]
    if metrics["foregroundPixels"] < MIN_FOREGROUND_PIXELS or bbox is None:
        problems.append("לא נשאר foreground משמעותי")
        return problems, metrics
    if bbox[2] - bbox[0] < MIN_FOREGROUND_DIMENSION or bbox[3] - bbox[1] < MIN_FOREGROUND_DIMENSION:
        problems.append("ה-foreground קטן מכדי להיות נכס שימושי")
    if metrics["bboxOccupancy"] < MIN_BBOX_OCCUPANCY:
        problems.append("המסכה דלילה, הגזירה מחקה את הדמות והשאירה ghost")
    if not has_useful_alpha(image):
        problems.append("ל-cutout אין שקיפות משמעותית")
    return problems, metrics


def compare_source(source: Image.Image, candidate: Image.Image) -> list[str]:
    source_alpha = source.convert("RGBA").getchannel("A")
    if not has_useful_alpha(source):
        return []
    source_bbox = source_alpha.getbbox()
    if source_bbox is None:
        return ["גם בקובץ המקור לא קיימת דמות אטומה"]
    expected = source_alpha.crop(source_bbox)
    actual = candidate.convert("RGBA").getchannel("A")
    actual_bbox = actual.getbbox()
    if actual_bbox is None:
        return ["לא נשארה מסכה במועמד"]
    actual = actual.crop(actual_bbox)
    expected_width, expected_height = expected.size
    if abs(actual.width - expected_width) > 1 or abs(actual.height - expected_height) > 1:
        return ["ממדי המסכה אינם תואמים לדמות שבמקור, ולכן ייתכן שחלק מהדמות נמחק"]
    if actual.size != expected.size:
        actual = actual.resize(expected.size, Image.Resampling.NEAREST)
    expected_values = expected.tobytes()
    actual_values = actual.tobytes()
    expected_alpha = sum(expected_values)
    retained_alpha = sum(
        min(expected_value, actual_value)
        for expected_value, actual_value in zip(expected_values, actual_values)
    )
    added_alpha = sum(
        max(0, actual_value - expected_value)
        for expected_value, actual_value in zip(expected_values, actual_values)
    )
    recall = retained_alpha / expected_alpha if expected_alpha else 0.0
    added_fraction = added_alpha / max(1, expected_alpha)
    problems: list[str] = []
    if recall < 0.995:
        problems.append(f"נשמרו רק {round(recall * 100)}% ממשקל ה-alpha של הדמות שבמקור")
    if added_fraction > 0.01:
        problems.append("נוספה אטימות מחוץ למסכת המקור, ייתכן שנשאר רקע")

    # A matching silhouette is insufficient: a producer could replace or badly
    # recolour the subject while keeping the same alpha. Compare visible pixels
    # with alpha weighting so transparent RGB garbage does not create noise.
    expected_rgba = source.convert("RGBA").crop(source_bbox)
    actual_rgba = candidate.convert("RGBA").crop(actual_bbox)
    if actual_rgba.size != expected_rgba.size:
        actual_rgba = actual_rgba.resize(expected_rgba.size, Image.Resampling.LANCZOS)
    weighted_error = 0.0
    total_weight = 0.0
    severe_weight = 0.0
    for expected_pixel, actual_pixel in zip(expected_rgba.getdata(), actual_rgba.getdata()):
        weight = min(expected_pixel[3], actual_pixel[3]) / 255.0
        if weight <= 0.05:
            continue
        channel_error = sum(
            abs(expected_pixel[channel] - actual_pixel[channel]) for channel in range(3)
        ) / 3.0
        weighted_error += channel_error * weight
        total_weight += weight
        if channel_error > 40:
            severe_weight += weight
    mean_error = weighted_error / total_weight if total_weight else 255.0
    severe_fraction = severe_weight / total_weight if total_weight else 1.0
    if mean_error > 14 or severe_fraction > 0.08:
        problems.append("צבעי או פרטי הדמות השתנו לעומת המקור, למרות שמסכת ה-alpha דומה")
    return problems


def resolve_source(candidate: Path, explicit_source: Path | None, metadata: dict[str, Any] | None) -> Path | None:
    if explicit_source is not None:
        return explicit_source
    if metadata is None or not isinstance(metadata.get("source"), str):
        return None
    stored = Path(metadata["source"])
    return stored if stored.is_absolute() else (candidate.parent / stored).resolve()


def check_pair_bytes(
    candidate_data: bytes,
    source_data: bytes,
    candidate_name: str,
    source_name: str,
    trusted_output_sha256: str | None = None,
) -> dict[str, Any]:
    problems: list[str] = []
    try:
        with Image.open(io.BytesIO(candidate_data)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGBA")
            image.load()
    except Exception as error:
        return {
            "path": candidate_name,
            "source": source_name,
            "status": "fail",
            "problems": [f"לא ניתן לקרוא את קובץ התמונה: {error}"],
            "metrics": {},
        }

    quality, metrics = quality_problems(image)
    problems.extend(quality)
    candidate_hash = hashlib.sha256(candidate_data).hexdigest()
    if trusted_output_sha256 is not None and trusted_output_sha256 != candidate_hash:
        problems.append("ה-cutout אינו זהה לנכס שכבר אושר ונחתם")

    source_requires_review = True
    try:
        with Image.open(io.BytesIO(source_data)) as opened:
            source_image = ImageOps.exif_transpose(opened).convert("RGBA")
            source_image.load()
        source_requires_review = not has_useful_alpha(source_image)
        problems.extend(compare_source(source_image, image))
    except Exception as error:
        problems.append(f"לא ניתן לקרוא את קובץ המקור: {error}")

    needs_review = not problems and (
        source_requires_review or trusted_output_sha256 is None
    )
    return {
        "path": candidate_name,
        "source": source_name,
        "status": "fail" if problems else "review_required" if needs_review else "pass",
        "problems": problems,
        "metrics": metrics,
    }


def check(
    candidate_path: str | Path,
    explicit_source: Path | None = None,
    trusted_output_sha256: str | None = None,
) -> dict[str, Any]:
    candidate = Path(candidate_path)
    problems: list[str] = []
    metadata: dict[str, Any] | None = None
    provenance = metadata_path(candidate)
    if provenance.exists():
        try:
            metadata = json.loads(provenance.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            problems.append(f"קובץ ה-provenance אינו קריא: {error}")
    elif explicit_source is None:
        problems.append("חסר קובץ provenance של cutout.py, ולכן הגזירה אינה מאומתת")

    try:
        with Image.open(candidate) as opened:
            image = opened.convert("RGBA")
    except Exception as error:
        return {
            "path": str(candidate),
            "source": str(explicit_source) if explicit_source else None,
            "status": "fail",
            "problems": [*problems, f"לא ניתן לקרוא את קובץ התמונה: {error}"],
            "metrics": {},
        }

    quality, metrics = quality_problems(image)
    problems.extend(quality)
    source = resolve_source(candidate, explicit_source, metadata)
    source_requires_review = False

    if metadata is not None:
        if metadata.get("schemaVersion") != SCHEMA_VERSION:
            problems.append("גרסת ה-provenance אינה נתמכת")
        if metadata.get("status") not in {"verified", "review_required"}:
            problems.append(f"מצב ה-provenance אינו מאושר: {metadata.get('status', 'missing')}")
        if metadata.get("outputSha256") != sha256(candidate):
            problems.append("קובץ ה-cutout השתנה מאז שנבדק")

    candidate_sha256 = sha256(candidate)
    if trusted_output_sha256 is not None and trusted_output_sha256 != candidate_sha256:
        problems.append("ה-cutout אינו זהה לנכס שכבר אושר ונחתם")

    if source is None:
        problems.append("לא נמצא קובץ מקור להשוואה")
    elif not source.exists():
        problems.append(f"קובץ המקור לא נמצא: {source}")
    else:
        if metadata is not None and metadata.get("sourceSha256") != sha256(source):
            problems.append("קובץ המקור השתנה מאז הפקת ה-cutout")
        try:
            with Image.open(source) as opened:
                source_image = ImageOps.exif_transpose(opened).convert("RGBA")
            # Provenance is an audit trail written by an untrusted producer.
            # Only a useful source alpha mask can justify automatic approval.
            source_requires_review = not has_useful_alpha(source_image)
            problems.extend(compare_source(source_image, image))
        except Exception as error:
            problems.append(f"לא ניתן לקרוא את קובץ המקור: {error}")

    needs_review = not problems and (
        source_requires_review
        or trusted_output_sha256 is None
        or (metadata is not None and metadata.get("status") == "review_required")
    )
    return {
        "path": str(candidate),
        "source": str(source) if source else None,
        "status": "fail" if problems else "review_required" if needs_review else "pass",
        "problems": problems,
        "metrics": metrics,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--trusted-output-sha256")
    parser.add_argument("--stdin-pair", nargs=2, metavar=("CANDIDATE", "SOURCE"))
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)
    if args.stdin_pair:
        if args.source is not None or args.paths:
            parser.error("--stdin-pair cannot be combined with --source or paths")
    elif not args.paths:
        parser.error("at least one candidate path is required")
    if args.source is not None and len(args.paths) != 1:
        parser.error("--source supports exactly one candidate")
    if args.trusted_output_sha256 is not None and not args.stdin_pair and len(args.paths) != 1:
        parser.error("--trusted-output-sha256 supports exactly one candidate")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.stdin_pair:
        payload = sys.stdin.buffer.read()
        if len(payload) < 8:
            print("stdin pair payload is missing its length header", file=sys.stderr)
            return 2
        candidate_length = struct.unpack(">Q", payload[:8])[0]
        if candidate_length > len(payload) - 8:
            print("stdin pair payload has an invalid candidate length", file=sys.stderr)
            return 2
        candidate_data = payload[8 : 8 + candidate_length]
        source_data = payload[8 + candidate_length :]
        reports = [
            check_pair_bytes(
                candidate_data,
                source_data,
                args.stdin_pair[0],
                args.stdin_pair[1],
                args.trusted_output_sha256,
            )
        ]
    else:
        reports = [check(path, args.source, args.trusted_output_sha256) for path in args.paths]
    failed = any(report["status"] == "fail" for report in reports)
    review_required = any(report["status"] == "review_required" for report in reports)
    if args.as_json:
        print(json.dumps(reports, ensure_ascii=False))
    else:
        for report in reports:
            print(f"{report['status'].upper()} {report['path']}")
            for problem in report["problems"]:
                print(f"   - {problem}")
        print("RESULT:", "FAIL" if failed else "REVIEW_REQUIRED" if review_required else "PASS")
    return 1 if failed else 3 if review_required else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
