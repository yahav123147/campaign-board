#!/usr/bin/env python3
"""Cut a full-page screenshot into contiguous horizontal strips.

Usage: slice-shot.py <png> <strip-height> <out-dir>
Prints one absolute strip path per line, top-most first. Exit 1 on failure.

Why: `shoot` writes one file per width with fullPage, and a real sales page
comes out over 20,000px tall. A vision model handed a file with that aspect
ratio sees a compressed sliver and cannot read the page, which in the 10th
acceptance run produced three failing design verdicts, two of them with
confident blockers the pixels contradict. The critics get strips instead.

The strip height is decided by orchestrator/shotStrips.ts, which owns the
arithmetic and is tested as a table; this script only performs the cut.
"""
import os
import sys

from PIL import Image

MAX_STRIPS = 64
MAX_EDGE_PX = 80_000


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main(argv):
    if len(argv) != 3:
        fail("usage: slice-shot.py <png> <strip-height> <out-dir>")
    source, raw_height, out_dir = argv

    try:
        strip_height = int(raw_height)
    except ValueError:
        fail("strip height must be an integer")
    if strip_height <= 0:
        fail("strip height must be positive")

    if not os.path.isfile(source):
        fail("no such screenshot: %s" % source)

    with Image.open(source) as image:
        width, height = image.size
        if width <= 0 or height <= 0:
            fail("screenshot has no pixels")
        if width > MAX_EDGE_PX or height > MAX_EDGE_PX:
            fail("screenshot is larger than this tool will cut (%dx%d)" % (width, height))

        count = (height + strip_height - 1) // strip_height
        if count > MAX_STRIPS:
            fail("%d strips exceeds the %d the caller may ask for" % (count, MAX_STRIPS))

        os.makedirs(out_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(source))[0]
        written = []
        for index in range(count):
            top = index * strip_height
            bottom = min(top + strip_height, height)
            target = os.path.abspath(os.path.join(out_dir, "%s-strip-%02d.png" % (stem, index + 1)))
            image.crop((0, top, width, bottom)).save(target, format="PNG")
            written.append(target)

    # Printed only after every strip is on disk, so a partial cut is never
    # reported as a usable set of files.
    for target in written:
        print(target)


if __name__ == "__main__":
    main(sys.argv[1:])
