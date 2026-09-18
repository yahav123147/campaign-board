#!/usr/bin/env python3
"""Paste rendered screens onto a base frame by label mask, then drop the white
background while keeping the soft shadow.

Usage:
  composite.py <base.png> <out.webp> --scale 2 --labels <labels.npy>
               --map '<regionId>=screens/a.png' '<regionId>=screens/b.png' [--keep-white]

Screens are rendered at (region bbox size * scale). The output is an RGBA WebP
with a transparent ground, or an opaque image with --keep-white.

The label map is read from --labels, because the packaged base frames live in a
read-only directory and the label cache belongs next to the run data.
A screen larger than the room left on the canvas is clipped rather than
aborting the composite: the mockup is worth more than the overflow.
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# How far from white still counts as background, and how bright a trapped
# remnant has to be before it is treated as one.
WHITE_DISTANCE = 55
REMNANT_LUMINANCE = 150
REMNANT_SATURATION = 28


def main(argv):
    if len(argv) < 3:
        print("usage: composite.py <base.png> <out> --scale N --labels F --map id=png ...",
              file=sys.stderr)
        return 1
    base, out = argv[1], argv[2]
    scale = int(argv[argv.index("--scale") + 1]) if "--scale" in argv else 2
    labels_path = (
        argv[argv.index("--labels") + 1] if "--labels" in argv
        else base.rsplit(".", 1)[0] + "-lab.npy"
    )
    pairs = [item.split("=", 1) for item in argv[argv.index("--map") + 1:] if "=" in item]
    keep_white = "--keep-white" in argv

    image = Image.open(base).convert("RGBA")
    labels = np.load(labels_path)
    image = image.resize((image.width * scale, image.height * scale), Image.LANCZOS)
    arr = np.array(image)

    protected = np.zeros(labels.shape, bool)
    for region_id, png in pairs:
        # Fill holes first: reflections on the base's black screen leave speckle
        # holes in the label mask, and those holes eat the pasted text.
        region = ndimage.binary_fill_holes(labels == int(region_id))
        if not region.any():
            print(f"region {region_id} is empty in the label map", file=sys.stderr)
            return 2
        protected |= region
        scaled = np.kron(region, np.ones((scale, scale), dtype=bool))
        ys, xs = np.where(region)
        x0, y0 = int(xs.min()) * scale, int(ys.min()) * scale
        screen = np.array(Image.open(png).convert("RGBA"))
        height = min(screen.shape[0], arr.shape[0] - y0)
        width = min(screen.shape[1], arr.shape[1] - x0)
        screen = screen[:height, :width]
        mask = scaled[y0:y0 + height, x0:x0 + width]
        patch = arr[y0:y0 + height, x0:x0 + width]
        patch[mask] = screen[mask]
        arr[y0:y0 + height, x0:x0 + width] = patch

    rgb = arr[:, :, :3].astype(int)
    if keep_white:
        Image.fromarray(arr).convert("RGB").save(out, quality=92)
        print(out)
        return 0

    # The screens are never background. A base frame has no bezel: a screen's
    # own edge pixels sit directly against the white ground, so a light screen
    # is connected to the canvas border THROUGH ITSELF, and the flood below
    # would run into it and erase the whole mockup while this script still
    # exits 0. Masking the pasted regions out of the background is what keeps
    # a light brand palette from producing an empty picture.
    protected_scaled = np.kron(protected, np.ones((scale, scale), dtype=bool))

    distance = (255 - rgb).max(axis=2)
    near_white = distance < WHITE_DISTANCE
    connected, _ = ndimage.label(near_white)
    border = set(np.unique(np.concatenate([
        connected[0], connected[-1], connected[:, 0], connected[:, -1],
    ]))) - {0}
    background = np.isin(connected, list(border))
    background &= ~protected_scaled
    alpha = np.full(distance.shape, 255, dtype=np.uint8)
    alpha[background] = np.clip(
        distance[background] * 255 / WHITE_DISTANCE * 0.9, 0, 255
    ).astype(np.uint8)
    flat = rgb.astype(np.uint8)
    flat[background] = 0

    # White remnants trapped between devices are unreachable by the border
    # labelling above. They become shadow alpha; the screens stay protected.
    luminance = rgb.mean(axis=2)
    saturation = rgb.max(axis=2) - rgb.min(axis=2)
    remnant = (
        (luminance > REMNANT_LUMINANCE)
        & (saturation < REMNANT_SATURATION)
        & (~protected_scaled)
        & (~background)
    )
    alpha[remnant] = np.clip((255 - luminance[remnant]) * 1.1, 0, 255).astype(np.uint8)
    flat[remnant] = 0

    result = Image.fromarray(np.dstack([flat, alpha]), "RGBA")
    box = result.split()[3].point(lambda value: 255 if value > 8 else 0).getbbox()
    if box:
        result = result.crop(box)
    result.save(out, quality=85)
    print(out, result.size)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
