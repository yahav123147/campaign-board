from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


MARKER = Path(__file__).resolve().parents[2] / "vendor/landing-skill/scripts/marker.py"


class MarkerTests(unittest.TestCase):
    def run_marker(self, source: Path, output: Path, box: tuple[int, int, int, int], style: str):
        result = subprocess.run(
            [sys.executable, str(MARKER), str(source), str(output),
             *(str(value) for value in box), "--style", style],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_underline_preserves_light_and_dark_text_and_original_context(self):
        # The reported regression was white text on a dark message bubble.
        # Also cover ordinary black text on a white screenshot and legacy callers.
        for style in ("underline", "yellow"):
            for background, foreground in (("#242424", "white"), ("white", "black")):
                with self.subTest(style=style, background=background), tempfile.TemporaryDirectory() as tmp:
                    source, output = Path(tmp) / "source.png", Path(tmp) / "marked.webp"
                    original = Image.new("RGB", (200, 120), background)
                    draw = ImageDraw.Draw(original)
                    draw.text((20, 30), "Original message", fill=foreground)
                    draw.text((12, 96), "14:50", fill=foreground)
                    original.save(source)
                    box = (15, 25, 150, 50)

                    self.run_marker(source, output, box, style)

                    with Image.open(output) as image:
                        actual = image.convert("RGB")
                    self.assertEqual(actual.size, original.size)
                    # Every original pixel except the small strip below the
                    # selected text survives, including the timestamp.
                    changed = ImageChops.difference(original, actual).getbbox()
                    self.assertIsNotNone(changed)
                    self.assertGreater(changed[1], box[3])
                    self.assertLessEqual(changed[3], box[3] + 8)
                    self.assertEqual(actual.crop(box).tobytes(), original.crop(box).tobytes())
                    self.assertEqual(actual.crop((0, 85, 200, 120)).tobytes(), original.crop((0, 85, 200, 120)).tobytes())

    def test_no_space_below_message_leaves_it_unmarked(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "source.png", Path(tmp) / "marked.webp"
            original = Image.new("RGB", (100, 50), "#242424")
            ImageDraw.Draw(original).text((5, 34), "Last line", fill="white")
            original.save(source)

            result = self.run_marker(source, output, (2, 30, 98, 48), "underline")

            with Image.open(output) as actual:
                self.assertEqual(actual.convert("RGB").tobytes(), original.tobytes())
            self.assertIn("left unmarked", result.stdout)


if __name__ == "__main__":
    unittest.main()
