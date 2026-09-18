from __future__ import annotations

import base64
import importlib.util
import io
import unittest
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-image.py"
SPEC = importlib.util.spec_from_file_location("campaign_council_check_image", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ThumbnailTests(unittest.TestCase):
    def test_thumbnail_is_small_decodable_webp(self) -> None:
        source = Image.new("RGBA", (1800, 1200), (20, 80, 180, 190))
        source_bytes = io.BytesIO()
        source.save(source_bytes, format="PNG")

        data_url = MODULE.thumbnail_data_url(source_bytes.getvalue())

        prefix = "data:image/webp;base64,"
        self.assertTrue(data_url.startswith(prefix))
        encoded = base64.b64decode(data_url[len(prefix):])
        self.assertLessEqual(len(encoded), MODULE.MAX_THUMBNAIL_BYTES)
        with Image.open(io.BytesIO(encoded)) as thumbnail:
            self.assertEqual(thumbnail.format, "WEBP")
            self.assertLessEqual(max(thumbnail.size), 560)


if __name__ == "__main__":
    unittest.main()
