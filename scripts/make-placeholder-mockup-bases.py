#!/usr/bin/env python3
"""Generate the placeholder device base frames the mockup renderer composites onto.

Usage: make-placeholder-mockup-bases.py [<outDir>]   (default: config/standards/mockups)

A base frame is a white canvas with one solid black rectangle per screen. The
renderer detects those rectangles with detect_screens.py and pastes the agent's
rendered screens into them, so any image with black screens on white works:
these placeholders keep the pipeline runnable, and an operator who has real
device photography replaces the two files in place. The region ids stay
raster-ordered, so a replacement frame keeps the same numbering as long as the
screens are laid out in the same order.

  base-devices.default.png   a laptop screen next to a phone screen
  base-chapter.default.png   a single tablet screen

The output is deterministic: the same command always writes the same bytes.
"""
import sys
from pathlib import Path

from PIL import Image

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)

# canvas size -> the screen rectangles on it, in raster order.
FRAMES = {
    "base-devices.default.png": (
        (2400, 1400),
        (
            (120, 200, 1720, 1200),   # laptop screen, 1600x1000
            (1840, 310, 2200, 1090),  # phone screen, 360x780
        ),
    ),
    "base-chapter.default.png": (
        (1600, 2000),
        (
            (200, 200, 1400, 1800),   # tablet screen, 1200x1600
        ),
    ),
}


def main(argv):
    out_dir = Path(argv[1]) if len(argv) > 1 else Path("config/standards/mockups")
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (canvas, screens) in FRAMES.items():
        image = Image.new("RGB", canvas, WHITE)
        for box in screens:
            image.paste(BLACK, box)
        target = out_dir / name
        image.save(target, optimize=True)
        print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
