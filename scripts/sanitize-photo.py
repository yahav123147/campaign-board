#!/usr/bin/env python3
"""Re-encode an uploaded presenter photo before it enters the photo library.

Uploaded phone photos carry EXIF metadata (including GPS coordinates). Saving
through PIL without exif produces a clean JPEG; exif_transpose runs first so
the visual orientation survives the strip. Non-images fail here loudly, which
doubles as the real file-type validation for the upload endpoint.
"""
import sys

from PIL import Image, ImageOps

def main() -> int:
    if len(sys.argv) != 3:
        print("usage: sanitize-photo.py <src> <dst.jpg>", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        im.thumbnail((2200, 2200))
        im.save(dst, "JPEG", quality=92)
    print(dst)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
