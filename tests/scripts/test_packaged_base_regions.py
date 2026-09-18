"""The regions the prompt suites assert are the regions detect_screens.py finds.

tests/orchestrator/mockupBaseRegions.ts seeds the renderer's cache with a
hand-written geometry, so the TypeScript suites never need numpy or scipy. That
is only honest while the geometry matches what the detector really produces for
the committed frames: otherwise the prompt tests keep asserting sizes the
installation no longer has, and the drift shows up first in a real run.

Skipped cleanly when the image stack is not installed, exactly like the rest of
the python suite would be on such a machine.
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DETECT = ROOT / "vendor" / "course-mockups" / "detect_screens.py"
BASES = ROOT / "config" / "standards" / "mockups"
SEED = ROOT / "tests" / "orchestrator" / "mockupBaseRegions.ts"

REQUIRED_MODULES = ("numpy", "scipy", "PIL")
MISSING = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]

REGION_RE = re.compile(
    r"\{\s*id:\s*(\d+),\s*x0:\s*(\d+),\s*x1:\s*(\d+),\s*y0:\s*(\d+),\s*y1:\s*(\d+)\s*\}"
)


def seeded_regions(base: str) -> list[dict[str, int]]:
    """The geometry the TypeScript seed declares for one base frame."""
    text = SEED.read_text(encoding="utf-8")
    start = text.index(f"{base}: [")
    end = text.index("]", start)
    return [
        {"id": int(id_), "x0": int(x0), "x1": int(x1), "y0": int(y0), "y1": int(y1)}
        for id_, x0, x1, y0, y1 in REGION_RE.findall(text[start:end])
    ]


@unittest.skipIf(MISSING, f"image modules not installed: {', '.join(MISSING)}")
class PackagedBaseRegionsTests(unittest.TestCase):
    def detect(self, base: str) -> list[dict[str, int]]:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            regions = root / "regions.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(DETECT),
                    str(BASES / f"base-{base}.default.png"),
                    "--labels",
                    str(root / "labels.npy"),
                    "--regions",
                    str(regions),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            document = json.loads(regions.read_text(encoding="utf-8"))
        return [
            {key: region[key] for key in ("id", "x0", "x1", "y0", "y1")}
            for region in document["regions"]
        ]

    def test_the_seeded_geometry_is_what_the_detector_produces(self) -> None:
        for base in ("devices", "chapter"):
            with self.subTest(base=base):
                seeded = seeded_regions(base)
                self.assertTrue(seeded, f"no seeded regions parsed for {base}")
                self.assertEqual(seeded, self.detect(base))


if __name__ == "__main__":
    unittest.main()
