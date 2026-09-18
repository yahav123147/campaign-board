from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
DETECT = ROOT / "vendor" / "course-mockups" / "detect_screens.py"
COMPOSITE = ROOT / "vendor" / "course-mockups" / "composite.py"

# The synthetic base: a white canvas with two black rectangles standing in for
# the black device screens of a real base frame.
CANVAS = (400, 300)
LEFT = (20, 20, 180, 140)
RIGHT = (220, 60, 380, 260)
SCALE = 2


def run_script(script: Path, *args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *(str(arg) for arg in args)],
        capture_output=True,
        text=True,
        check=False,
    )


def write_base(path: Path) -> None:
    image = Image.new("RGB", CANVAS, (255, 255, 255))
    for box in (LEFT, RIGHT):
        image.paste((0, 0, 0), box)
    image.save(path)


def write_screen(path: Path, box: tuple[int, int, int, int], color: tuple[int, int, int]) -> None:
    width = (box[2] - box[0]) * SCALE
    height = (box[3] - box[1]) * SCALE
    Image.new("RGB", (width, height), color).save(path)


class DetectScreensTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / "base-devices.default.png"
        write_base(self.base)
        self.labels = self.root / "labels.npy"
        self.regions = self.root / "regions.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_finds_both_screens_and_writes_the_regions_file(self) -> None:
        result = run_script(DETECT, self.base, "--labels", self.labels, "--regions", self.regions)
        self.assertEqual(result.returncode, 0, result.stderr)

        printed = json.loads(result.stdout)
        self.assertEqual(len(printed), 2)
        self.assertTrue(self.labels.is_file())

        document = json.loads(self.regions.read_text(encoding="utf-8"))
        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(
            document["baseSha256"],
            hashlib.sha256(self.base.read_bytes()).hexdigest(),
        )
        self.assertEqual(document["labels"], str(self.labels))
        by_id = {region["id"]: region for region in document["regions"]}
        self.assertEqual(sorted(by_id), [1, 2])
        # Raster order: the upper rectangle is labelled first.
        self.assertEqual(
            (by_id[1]["x0"], by_id[1]["y0"], by_id[1]["x1"], by_id[1]["y1"]),
            (LEFT[0], LEFT[1], LEFT[2] - 1, LEFT[3] - 1),
        )
        self.assertEqual(
            (by_id[2]["x0"], by_id[2]["y0"], by_id[2]["x1"], by_id[2]["y1"]),
            (RIGHT[0], RIGHT[1], RIGHT[2] - 1, RIGHT[3] - 1),
        )

    def test_skips_regions_below_the_minimum_area(self) -> None:
        result = run_script(
            DETECT, self.base, "--min", 25_000, "--labels", self.labels, "--regions", self.regions
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(self.regions.read_text(encoding="utf-8"))
        # Only the larger rectangle clears 25,000 pixels.
        self.assertEqual([region["id"] for region in document["regions"]], [2])


class CompositeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / "base-devices.default.png"
        write_base(self.base)
        self.labels = self.root / "labels.npy"
        self.regions = self.root / "regions.json"
        detected = run_script(DETECT, self.base, "--labels", self.labels, "--regions", self.regions)
        self.assertEqual(detected.returncode, 0, detected.stderr)
        self.left_png = self.root / "left.png"
        self.right_png = self.root / "right.png"
        write_screen(self.left_png, LEFT, (255, 0, 0))
        write_screen(self.right_png, RIGHT, (0, 0, 255))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def composite(self, out: Path, *extra: object) -> subprocess.CompletedProcess[str]:
        return run_script(
            COMPOSITE,
            self.base,
            out,
            "--scale",
            SCALE,
            "--labels",
            self.labels,
            "--map",
            f"1={self.left_png}",
            f"2={self.right_png}",
            *extra,
        )

    def test_places_each_screen_inside_its_region(self) -> None:
        out = self.root / "out.png"
        result = self.composite(out, "--keep-white")
        self.assertEqual(result.returncode, 0, result.stderr)

        with Image.open(out) as image:
            rendered = image.convert("RGB")
            self.assertEqual(rendered.size, (CANVAS[0] * SCALE, CANVAS[1] * SCALE))
            for box, color in ((LEFT, (255, 0, 0)), (RIGHT, (0, 0, 255))):
                centre = (
                    (box[0] + box[2]) // 2 * SCALE,
                    (box[1] + box[3]) // 2 * SCALE,
                )
                self.assertEqual(rendered.getpixel(centre), color)
                # A pixel just inside the region corner is the screen too.
                self.assertEqual(
                    rendered.getpixel((box[0] * SCALE + 2, box[1] * SCALE + 2)), color
                )
            # The canvas between the two rectangles is untouched.
            self.assertEqual(rendered.getpixel((200 * SCALE, 10 * SCALE)), (255, 255, 255))

    def test_writes_a_transparent_result_with_the_screens_opaque(self) -> None:
        out = self.root / "out.webp"
        result = self.composite(out)
        self.assertEqual(result.returncode, 0, result.stderr)

        with Image.open(out) as image:
            rendered = image.convert("RGBA")
            # The white ground became transparent and was cropped away, so the
            # result is the box the two screens span, plus the few pixels the
            # base's own resampling bled around their edges.
            spanned = (
                (RIGHT[2] - LEFT[0]) * SCALE,
                (RIGHT[3] - LEFT[1]) * SCALE,
            )
            bleed = (rendered.width - spanned[0]) // 2
            self.assertLessEqual(bleed, 8)
            self.assertEqual(rendered.height - spanned[1], rendered.width - spanned[0])
            offset = (LEFT[0] * SCALE - bleed, LEFT[1] * SCALE - bleed)
            for box, colour in ((LEFT, (255, 0, 0)), (RIGHT, (0, 0, 255))):
                centre = (
                    (box[0] + box[2]) // 2 * SCALE - offset[0],
                    (box[1] + box[3]) // 2 * SCALE - offset[1],
                )
                pixel = rendered.getpixel(centre)
                self.assertEqual(pixel[3], 255)
                # WebP is lossy, so the screen colour is compared with tolerance.
                for channel, expected in zip(pixel[:3], colour):
                    self.assertLessEqual(abs(channel - expected), 8)

    def test_clips_a_screen_that_overflows_its_region_instead_of_failing(self) -> None:
        # A screen rendered larger than the region must not abort the composite:
        # the extra pixels are dropped, the mockup is still produced.
        oversized = self.root / "oversized.png"
        Image.new("RGB", (CANVAS[0] * SCALE, CANVAS[1] * SCALE), (0, 255, 0)).save(oversized)
        out = self.root / "clipped.png"
        result = run_script(
            COMPOSITE,
            self.base,
            out,
            "--scale",
            SCALE,
            "--labels",
            self.labels,
            "--keep-white",
            "--map",
            f"2={oversized}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        with Image.open(out) as image:
            rendered = image.convert("RGB")
            centre = ((RIGHT[0] + RIGHT[2]) // 2 * SCALE, (RIGHT[1] + RIGHT[3]) // 2 * SCALE)
            self.assertEqual(rendered.getpixel(centre), (0, 255, 0))


PACKAGED_BASES = ROOT / "config" / "standards" / "mockups"


class PackagedFrameCompositeTests(unittest.TestCase):
    """The white drop, against the frames the Board actually ships.

    The packaged frames have no bezel: a screen's own edge pixels sit directly
    against the white ground. A light screen is therefore connected to the
    canvas border through its own pixels, and the background flood would run
    straight into it and erase the whole mockup while composite.py still
    exits 0. The screens are protected from that pass, so a light screen
    survives exactly like a dark one.
    """

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = PACKAGED_BASES / "base-devices.default.png"
        self.labels = self.root / "labels.npy"
        self.regions = self.root / "regions.json"
        detected = run_script(DETECT, self.base, "--labels", self.labels, "--regions", self.regions)
        self.assertEqual(detected.returncode, 0, detected.stderr)
        self.by_id = {
            region["id"]: region
            for region in json.loads(self.regions.read_text(encoding="utf-8"))["regions"]
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def screen_for(self, region_id: int, colour: tuple[int, int, int]) -> Path:
        region = self.by_id[region_id]
        width = (region["x1"] - region["x0"] + 1) * SCALE
        height = (region["y1"] - region["y0"] + 1) * SCALE
        path = self.root / f"screen-{region_id}.png"
        Image.new("RGB", (width, height), colour).save(path)
        return path

    def test_a_light_screen_survives_the_white_drop(self) -> None:
        light = self.screen_for(1, (250, 250, 250))
        dark = self.screen_for(2, (10, 10, 20))
        out = self.root / "out.png"
        result = run_script(
            COMPOSITE,
            self.base,
            out,
            "--scale",
            SCALE,
            "--labels",
            self.labels,
            "--map",
            f"1={light}",
            f"2={dark}",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        with Image.open(out) as image:
            rendered = image.convert("RGBA")
            # The result is cropped to the visible box, so the regions are read
            # relative to the first region's own top left corner plus the bleed
            # the crop left around it.
            first = self.by_id[1]
            bleed = (rendered.width - (self.by_id[2]["x1"] - first["x0"] + 1) * SCALE) // 2
            offset = (first["x0"] * SCALE - bleed, first["y0"] * SCALE - bleed)
            for region_id, colour in ((1, (250, 250, 250)), (2, (10, 10, 20))):
                region = self.by_id[region_id]
                centre = (
                    (region["x0"] + region["x1"]) // 2 * SCALE - offset[0],
                    (region["y0"] + region["y1"]) // 2 * SCALE - offset[1],
                )
                pixel = rendered.getpixel(centre)
                self.assertEqual(pixel[3], 255, f"region {region_id} was erased: {pixel}")
                for channel, expected in zip(pixel[:3], colour):
                    self.assertLessEqual(abs(channel - expected), 8)


if __name__ == "__main__":
    unittest.main()
