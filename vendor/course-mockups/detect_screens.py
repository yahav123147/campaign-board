#!/usr/bin/env python3
"""Find the black (empty) screens in a device mockup base frame.

Usage:
  detect_screens.py <base.png> [--min 5000] [--labels <labels.npy>] [--regions <regions.json>]

Writes the label map (the array composite.py pastes through) and a regions
file naming every screen the base offers, and prints the same regions as JSON
on stdout. The region ids in that file are what an asset plan's
`render.map` refers to.

Both outputs are written where the caller asks, because the packaged base
frames live in a read-only directory and the cache belongs next to the run
data, not next to the base. The regions file records the sha256 of the base it
was computed from, so a replaced base frame invalidates the cache.
"""
import hashlib
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# Anything darker than this on every channel is an empty screen, not a frame.
BLACK_MAX = 28
DEFAULT_MIN_AREA = 5000


def option(argv, name, fallback=None):
    return argv[argv.index(name) + 1] if name in argv else fallback


def main(argv):
    if len(argv) < 2:
        print("usage: detect_screens.py <base.png> [--min N] [--labels F] [--regions F]",
              file=sys.stderr)
        return 1
    base = argv[1]
    stem = base.rsplit(".", 1)[0]
    min_area = int(option(argv, "--min", DEFAULT_MIN_AREA))
    labels_path = option(argv, "--labels", stem + "-lab.npy")
    regions_path = option(argv, "--regions", stem + ".regions.json")

    pixels = np.array(Image.open(base).convert("RGB")).astype(int)
    labels, count = ndimage.label(pixels.max(axis=2) < BLACK_MAX)
    regions = []
    for index in range(1, count + 1):
        ys, xs = np.where(labels == index)
        if len(ys) < min_area:
            continue
        regions.append(dict(
            id=index,
            x0=int(xs.min()), x1=int(xs.max()),
            y0=int(ys.min()), y1=int(ys.max()),
            area=int(len(ys)),
        ))
    regions.sort(key=lambda region: -region["area"])

    np.save(labels_path, labels)
    with open(base, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    document = {
        "schemaVersion": 1,
        "baseSha256": digest,
        "labels": labels_path,
        "regions": regions,
    }
    with open(regions_path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
    print(json.dumps(regions))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
