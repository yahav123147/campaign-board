#!/usr/bin/env python3
"""Decode a raster asset and verify its declared format and useful dimensions.

Usage: check-image.py [--json] <image...>
Exit 0 means all images passed, 1 means at least one failed, and 2 is bad CLI.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import warnings
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps


MIN_DIMENSION = 8
MAX_PIXELS = 100_000_000
EXPECTED_FORMATS = {
    ".png": {"PNG"},
    ".jpg": {"JPEG"},
    ".jpeg": {"JPEG"},
    ".webp": {"WEBP"},
    ".avif": {"AVIF"},
}
MAX_THUMBNAIL_BYTES = 180_000


def thumbnail_data_url(data: bytes) -> str:
    """Return a bounded, metadata-free WebP snapshot for human review."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGBA")
            image.load()

    attempts = ((560, 74), (440, 68), (320, 60), (240, 52))
    encoded = b""
    for dimension, quality in attempts:
        candidate = image.copy()
        candidate.thumbnail((dimension, dimension), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        candidate.save(output, format="WEBP", quality=quality, method=4, exact=True)
        encoded = output.getvalue()
        if len(encoded) <= MAX_THUMBNAIL_BYTES:
            break
    if not encoded or len(encoded) > MAX_THUMBNAIL_BYTES:
        raise ValueError("thumbnail exceeds its encoded size limit")
    return "data:image/webp;base64," + base64.b64encode(encoded).decode("ascii")


def inspect_bytes(data: bytes, display_name: str) -> dict[str, Any]:
    path = Path(display_name)
    problems: list[str] = []
    details: dict[str, Any] = {}
    expected = EXPECTED_FORMATS.get(path.suffix.lower())
    if expected is None:
        problems.append("סוג הקובץ אינו raster נתמך")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                detected_format = (opened.format or "").upper()
                width, height = opened.size
                frames = int(getattr(opened, "n_frames", 1))
                opened.verify()
            with Image.open(io.BytesIO(data)) as decoded:
                normalized = ImageOps.exif_transpose(decoded).convert("RGBA")
                normalized.load()
                alpha = normalized.getchannel("A")
                alpha_values = alpha.tobytes()
                visible_pixels = sum(value > 16 for value in alpha_values)
                transparent_pixels = sum(value < 250 for value in alpha_values)
                alpha_bbox = alpha.getbbox()
                significant_transparency = transparent_pixels >= max(
                    16, round(len(alpha_values) * 0.001)
                )
                meaningful_alpha = (
                    alpha_bbox is not None
                    and alpha_bbox != (0, 0, normalized.width, normalized.height)
                    and significant_transparency
                )
        details = {
            "format": detected_format,
            "width": width,
            "height": height,
            "frames": frames,
            "visiblePixels": visible_pixels,
            "transparentPixels": transparent_pixels,
            "meaningfulAlpha": meaningful_alpha,
            "significantTransparency": significant_transparency,
            "alphaBBox": list(alpha_bbox) if alpha_bbox else None,
        }
        if expected is not None and detected_format not in expected:
            problems.append(
                f"תוכן הקובץ הוא {detected_format or 'לא ידוע'}, אבל הסיומת מצהירה על {path.suffix.lower()}"
            )
        if width < MIN_DIMENSION or height < MIN_DIMENSION:
            problems.append(f"ממדי התמונה קטנים מדי: {width}x{height}")
        if width * height > MAX_PIXELS:
            problems.append(f"התמונה גדולה מדי לפענוח בטוח: {width}x{height}")
        if frames != 1:
            problems.append("נכס מונפש אינו נתמך בשער הנכסים")
        if visible_pixels < 64 or alpha_bbox is None:
            problems.append("התמונה שקופה כמעט לגמרי ואין בה תוכן חזותי שימושי")
    except Exception as error:
        problems.append(f"לא ניתן לפענח את התמונה: {error}")
    return {
        "path": str(path),
        "status": "fail" if problems else "pass",
        "problems": problems,
        **details,
    }


def inspect(path_value: str | Path) -> dict[str, Any]:
    path = Path(path_value)
    try:
        data = path.read_bytes()
    except Exception as error:
        return {
            "path": str(path),
            "status": "fail",
            "problems": [f"לא ניתן לקרוא את התמונה: {error}"],
        }
    return inspect_bytes(data, str(path))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--thumbnail-data-url", action="store_true")
    parser.add_argument("--stdin-name")
    parser.add_argument("paths", nargs="*")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.thumbnail_data_url:
        if not args.stdin_name or args.paths or args.as_json:
            raise SystemExit("--thumbnail-data-url requires --stdin-name and cannot use paths or --json")
        try:
            print(thumbnail_data_url(sys.stdin.buffer.read()))
            return 0
        except Exception as error:
            print(f"thumbnail failed: {error}", file=sys.stderr)
            return 1
    if args.stdin_name:
        if args.paths:
            raise SystemExit("--stdin-name cannot be combined with paths")
        reports = [inspect_bytes(sys.stdin.buffer.read(), args.stdin_name)]
    else:
        if not args.paths:
            raise SystemExit("at least one image path is required")
        reports = [inspect(path) for path in args.paths]
    if args.as_json:
        print(json.dumps(reports, ensure_ascii=False))
    else:
        for report in reports:
            print(f"{report['status'].upper()} {report['path']}")
            for problem in report["problems"]:
                print(f"   - {problem}")
    return 1 if any(report["status"] == "fail" for report in reports) else 0


if __name__ == "__main__":
    raise SystemExit(main())
