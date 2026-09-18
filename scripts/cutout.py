#!/usr/bin/env python3
"""Create a conservative transparent cutout and provenance record.

The tool has two safe modes:

1. An input that already has useful alpha is preserved and trimmed. It is never
   flood-filled again.
2. An opaque input is refused. Pixel colour alone cannot prove that dark hair or
   clothing is not part of a similarly coloured background.

If the image is ambiguous, the command exits with code 1 and leaves any existing
destination untouched. Exit code 2 means invalid CLI input or an I/O failure.

Usage: cutout.py <in> <out.webp> [tolerance]   default tolerance 26
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageOps


SCHEMA_VERSION = 1
TOOL_VERSION = "2.0"
MIN_FOREGROUND_PIXELS = 64
MIN_FOREGROUND_DIMENSION = 8
MIN_BBOX_OCCUPANCY = 0.04


class CutoutRefused(Exception):
    """The source cannot be separated confidently without semantic knowledge."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _metadata_path(destination: Path) -> Path:
    return destination.with_name(destination.name + ".cutout.json")


def _pending_path(destination: Path) -> Path:
    return destination.with_name(destination.name + ".cutout.pending.json")


def _rollback_output_path(destination: Path) -> Path:
    return destination.with_name(f".{destination.name}.cutout.rollback-output")


def _rollback_receipt_path(destination: Path) -> Path:
    return destination.with_name(f".{destination.name}.cutout.rollback-receipt")


def _has_matching_verified_receipt(path: Path) -> bool:
    try:
        metadata = json.loads(_metadata_path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        metadata.get("schemaVersion") == SCHEMA_VERSION
        and metadata.get("status") == "verified"
        and metadata.get("outputSha256") == _sha256(path)
    )


def _alpha_values(image: Image.Image) -> bytes:
    return image.convert("RGBA").getchannel("A").tobytes()


def _has_useful_alpha(image: Image.Image) -> bool:
    alpha = image.convert("RGBA").getchannel("A")
    values = alpha.tobytes()
    minimum_transparent_pixels = max(16, round(len(values) * 0.001))
    foreground_bbox = alpha.getbbox()
    # A few transparent pixels can be metadata noise or an intentionally forged
    # corner. Useful alpha must actually change the foreground geometry, leaving
    # at least one transparent canvas edge. Ambiguous tight crops go to review.
    return (
        foreground_bbox is not None
        and foreground_bbox != (0, 0, image.width, image.height)
        and sum(value < 250 for value in values) >= minimum_transparent_pixels
    )


def _validate_foreground(alpha: Image.Image) -> dict[str, float | int | list[int]]:
    values = alpha.tobytes()
    kept = sum(value > 16 for value in values)
    bbox = alpha.getbbox()
    if bbox is None or kept < MIN_FOREGROUND_PIXELS:
        raise CutoutRefused("לא נשאר foreground משמעותי")
    bbox_width = bbox[2] - bbox[0]
    bbox_height = bbox[3] - bbox[1]
    if bbox_width < MIN_FOREGROUND_DIMENSION or bbox_height < MIN_FOREGROUND_DIMENSION:
        raise CutoutRefused("ה-foreground שנשאר קטן מכדי להיות נכס שימושי")
    occupancy = kept / (bbox_width * bbox_height)
    if occupancy < MIN_BBOX_OCCUPANCY:
        raise CutoutRefused("המסכה דלילה ולא קוהרנטית, כנראה שנשאר ghost במקום דמות")
    return {
        "foregroundPixels": kept,
        "bbox": list(bbox),
        "bboxOccupancy": round(occupancy, 6),
    }


def _relative_source(source: Path, destination: Path) -> str:
    try:
        return os.path.relpath(source.resolve(), destination.parent.resolve())
    except ValueError:
        return str(source.resolve())


def _write_json_atomic(file_path: Path, payload: dict[str, object]) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{file_path.name}.", suffix=".tmp", dir=file_path.parent, delete=False
    )
    temporary = Path(handle.name)
    try:
        with handle:
            encoded = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, file_path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_receipt(destination: Path, receipt: dict[str, object]) -> None:
    _write_json_atomic(_metadata_path(destination), receipt)


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        # Some platforms/filesystems do not support fsync on directories. The
        # recovery journal still makes the pair fail-safe on the next launch.
        pass


def _recover_transaction(destination: Path) -> bool:
    pending = _pending_path(destination)
    if not pending.exists():
        return False
    try:
        journal = json.loads(pending.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise OSError(f"יומן cutout פגום ודורש שחזור ידני: {pending}")

    if journal.get("phase") != "committing":
        pending.unlink(missing_ok=True)
        return True

    receipt = _metadata_path(destination)
    output_backup = _rollback_output_path(destination)
    receipt_backup = _rollback_receipt_path(destination)
    new_pair_is_complete = (
        destination.exists()
        and receipt.exists()
        and journal.get("newOutputSha256") == _sha256(destination)
        and journal.get("newReceiptSha256") == _sha256(receipt)
    )
    if not new_pair_is_complete:
        if journal.get("oldOutputExisted"):
            if not output_backup.exists():
                raise OSError(f"חסר גיבוי לשחזור cutout: {output_backup}")
            os.replace(output_backup, destination)
        else:
            destination.unlink(missing_ok=True)
        if journal.get("oldReceiptExisted"):
            if not receipt_backup.exists():
                raise OSError(f"חסר גיבוי לשחזור provenance: {receipt_backup}")
            os.replace(receipt_backup, receipt)
        else:
            receipt.unlink(missing_ok=True)

    output_backup.unlink(missing_ok=True)
    receipt_backup.unlink(missing_ok=True)
    pending.unlink(missing_ok=True)
    _fsync_directory(destination.parent)
    return True


def _write_transaction(
    image: Image.Image,
    source: Path,
    destination: Path,
    metadata: dict[str, object],
    copy_source_bytes: bool,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    output_handle = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent, delete=False
    )
    output_handle.close()
    output_temp = Path(output_handle.name)
    metadata_destination = _metadata_path(destination)
    metadata_handle = tempfile.NamedTemporaryFile(
        prefix=f".{metadata_destination.name}.", suffix=".tmp", dir=destination.parent, delete=False
    )
    metadata_handle.close()
    metadata_temp = Path(metadata_handle.name)
    pending = _pending_path(destination)
    output_backup = _rollback_output_path(destination)
    receipt_backup = _rollback_receipt_path(destination)

    try:
        if copy_source_bytes:
            shutil.copyfile(source, output_temp)
        else:
            image.save(output_temp, "WEBP", quality=92, method=6)
        metadata["outputSha256"] = _sha256(output_temp)
        with metadata_temp.open("wb") as handle:
            handle.write((json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())

        old_output_existed = destination.exists()
        old_receipt_existed = metadata_destination.exists()
        output_backup.unlink(missing_ok=True)
        receipt_backup.unlink(missing_ok=True)
        if old_output_existed:
            shutil.copyfile(destination, output_backup)
        if old_receipt_existed:
            shutil.copyfile(metadata_destination, receipt_backup)
        _write_json_atomic(
            pending,
            {
                "schemaVersion": SCHEMA_VERSION,
                "phase": "committing",
                "oldOutputExisted": old_output_existed,
                "oldReceiptExisted": old_receipt_existed,
                "newOutputSha256": _sha256(output_temp),
                "newReceiptSha256": _sha256(metadata_temp),
            },
        )
        try:
            os.replace(output_temp, destination)
            os.replace(metadata_temp, metadata_destination)
            _fsync_directory(destination.parent)
        except BaseException:
            _recover_transaction(destination)
            raise
        _recover_transaction(destination)
    finally:
        output_temp.unlink(missing_ok=True)
        metadata_temp.unlink(missing_ok=True)


def _cutout_impl(source_path: str | Path, destination_path: str | Path, tolerance: int = 26) -> tuple[str, tuple[int, int]]:
    source = Path(source_path)
    destination = Path(destination_path)
    if source.resolve() == destination.resolve():
        raise ValueError("קובץ המקור והיעד חייבים להיות שונים")
    if tolerance < 4 or tolerance > 80:
        raise ValueError("הסבילות חייבת להיות בין 4 ל-80")

    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGBA")
    source_size = image.size
    source_hash = _sha256(source)
    source_had_alpha = _has_useful_alpha(image)
    source_has_verified_receipt = source_had_alpha and _has_matching_verified_receipt(source)
    metrics: dict[str, object]

    # A receipt next to the source is only an audit record, not authority. The
    # producing agent can write files, so a receipt can never turn opaque
    # pixels into a verified semantic cutout.
    if source_had_alpha:
        metrics = _validate_foreground(image.getchannel("A"))
        bbox = image.getchannel("A").getbbox()
        assert bbox is not None
        already_trimmed = bbox == (0, 0, image.width, image.height)
        if source_has_verified_receipt:
            # Safe idempotency: alpha and foreground were independently checked
            # above. The receipt only avoids another lossy encode; it never
            # grants an opaque image authority.
            output = image
        elif already_trimmed:
            output = image
        else:
            cropped = image.crop(bbox)
            # Keep a small transparent frame. A perfectly rectangular subject
            # otherwise becomes a fully opaque tight crop and is impossible to
            # distinguish from an uncut photograph during later validation.
            output = Image.new("RGBA", (cropped.width + 4, cropped.height + 4), (0, 0, 0, 0))
            output.alpha_composite(cropped, (2, 2))
        method = "preserve-alpha"
        copy_source_bytes = (
            (source_has_verified_receipt or already_trimmed)
            and source.suffix.lower() == ".webp"
        )
    else:
        raise CutoutRefused(
            "המקור אטום ואין בו מסכת alpha סמכותית. אי אפשר להוכיח שהרקע והדמות ניתנים להפרדה בלי מודל סמנטי ובדיקה אנושית"
        )

    output_metrics = _validate_foreground(output.getchannel("A"))
    metadata: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "toolVersion": TOOL_VERSION,
        "status": "verified",
        "source": _relative_source(source, destination),
        "sourceSha256": source_hash,
        "sourceSize": list(source_size),
        "sourceHadAlpha": source_had_alpha,
        "method": method,
        "metrics": metrics,
        "outputSize": list(output.size),
        "outputMetrics": output_metrics,
    }
    _write_transaction(output, source, destination, metadata, copy_source_bytes)
    return method, output.size


def cutout(source_path: str | Path, destination_path: str | Path, tolerance: int = 26) -> tuple[str, tuple[int, int]]:
    source = Path(source_path)
    destination = Path(destination_path)
    if source.resolve() == destination.resolve():
        raise ValueError("קובץ המקור והיעד חייבים להיות שונים")

    destination.parent.mkdir(parents=True, exist_ok=True)
    _recover_transaction(destination)
    pending_status: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "toolVersion": TOOL_VERSION,
        "phase": "processing",
        "source": _relative_source(source, destination),
    }
    if source.exists():
        pending_status["sourceSha256"] = _sha256(source)
    _write_json_atomic(_pending_path(destination), pending_status)

    try:
        return _cutout_impl(source, destination, tolerance)
    finally:
        # Refusal and ordinary errors never alter the last committed pair.
        # A committing journal is consumed by _write_transaction or recovered
        # on the next invocation.
        pending = _pending_path(destination)
        if pending.exists():
            try:
                journal = json.loads(pending.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                journal = {}
            if journal.get("phase") == "processing":
                pending.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--recover-dir":
        directory = Path(argv[1])
        try:
            if not directory.is_dir():
                raise OSError(f"תיקיית הנכסים אינה קיימת: {directory}")
            suffix = ".cutout.pending.json"
            recovered = 0
            for pending in directory.glob(f"*{suffix}"):
                destination = pending.with_name(pending.name[: -len(suffix)])
                recovered += int(_recover_transaction(destination))
            print(f"RECOVERED {recovered} cutout transactions")
            return 0
        except OSError as error:
            print(f"שגיאה: {error}", file=sys.stderr)
            return 2
    if len(argv) < 2 or len(argv) > 3:
        print(__doc__)
        return 2
    try:
        tolerance = int(argv[2]) if len(argv) == 3 else 26
        method, size = cutout(argv[0], argv[1], tolerance)
    except CutoutRefused as error:
        print(f"סירוב: {error}. השתמש בתמונה ממוסגרת או במסכת חיתוך מאומתת.", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"שגיאה: {error}", file=sys.stderr)
        return 2
    print(f"PASS {method}, גודל סופי {size[0]}x{size[1]} -> {argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
