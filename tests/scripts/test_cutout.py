from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
CUTOUT = ROOT / "scripts" / "cutout.py"
CHECK = ROOT / "scripts" / "check-cutout.py"


def run_script(script: Path, *args: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *(str(arg) for arg in args)],
        capture_output=True,
        text=True,
        check=False,
    )


def nontransparent_pixels(path: Path) -> int:
    with Image.open(path) as image:
        alpha = image.convert("RGBA").getchannel("A")
        return sum(value > 16 for value in alpha.get_flattened_data())


class CutoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_existing_alpha_is_preserved_and_second_run_is_byte_stable(self) -> None:
        source = self.root / "source.webp"
        first = self.root / "first.webp"
        second = self.root / "second.webp"

        image = Image.new("RGBA", (120, 140), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((25, 15, 95, 139), fill=(150, 30, 30, 255))
        image.save(source, "WEBP", lossless=True)
        expected_pixels = nontransparent_pixels(source)

        result = run_script(CUTOUT, source, first)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(nontransparent_pixels(first), expected_pixels)

        rerun = run_script(CUTOUT, first, second)
        self.assertEqual(rerun.returncode, 0, rerun.stderr + rerun.stdout)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_opaque_source_is_refused_instead_of_using_an_area_guess(self) -> None:
        source = self.root / "small.png"
        output = self.root / "small-cut.webp"
        image = Image.new("RGB", (240, 240), "white")
        ImageDraw.Draw(image).ellipse((98, 98, 142, 142), fill=(210, 20, 30))
        image.save(source)

        result = run_script(CUTOUT, source, output)

        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn("אטום", result.stderr + result.stdout)
        self.assertFalse(output.exists())

    def test_ambiguous_background_refuses_without_overwriting_destination(self) -> None:
        source = self.root / "ambiguous.png"
        output = self.root / "existing.webp"
        image = Image.new("RGB", (160, 160))
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                base = 18 + ((x * 19 + y * 23) % 55)
                pixels[x, y] = (base, base + (x % 9), base + (y % 7))
        ImageDraw.Draw(image).ellipse((35, 20, 130, 159), fill=(28, 25, 30))
        image.save(source)
        output.write_bytes(b"do-not-overwrite")
        before = hashlib.sha256(output.read_bytes()).hexdigest()

        result = run_script(CUTOUT, source, output)

        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn("סירוב", result.stderr + result.stdout)
        self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), before)
        self.assertFalse((self.root / "existing.webp.cutout.json").exists())
        checked = run_script(CHECK, "--json", output)
        self.assertEqual(checked.returncode, 1)

    def test_source_aware_check_accepts_a_valid_small_cutout(self) -> None:
        source = self.root / "small-source.png"
        candidate = self.root / "small-cut.webp"
        image = Image.new("RGB", (200, 200), "white")
        ImageDraw.Draw(image).rectangle((84, 60, 116, 139), fill=(20, 90, 180))
        image.save(source)
        cut = Image.new("RGBA", (37, 84), (0, 0, 0, 0))
        ImageDraw.Draw(cut).rectangle((2, 2, 34, 81), fill=(20, 90, 180, 255))
        cut.save(candidate, "WEBP", lossless=True)

        checked = run_script(CHECK, "--json", "--source", source, candidate)

        self.assertEqual(checked.returncode, 3, checked.stderr + checked.stdout)
        report = json.loads(checked.stdout)
        self.assertEqual(report[0]["status"], "review_required")
        plain = run_script(CHECK, "--source", source, candidate)
        self.assertEqual(plain.returncode, 3, plain.stderr + plain.stdout)
        self.assertIn("RESULT: REVIEW_REQUIRED", plain.stdout)

    def test_source_aware_check_rejects_an_erased_alpha_subject(self) -> None:
        source = self.root / "alpha-source.webp"
        candidate = self.root / "ghost.webp"
        image = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((20, 10, 100, 119), fill=(30, 30, 30, 255))
        image.save(source, "WEBP", lossless=True)
        ghost = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
        ImageDraw.Draw(ghost).rectangle((55, 80, 65, 119), fill=(30, 30, 30, 255))
        ghost.save(candidate, "WEBP", lossless=True)

        checked = run_script(CHECK, "--json", "--source", source, candidate)

        self.assertEqual(checked.returncode, 1, checked.stderr + checked.stdout)
        report = json.loads(checked.stdout)
        self.assertTrue(any("הדמות" in problem for problem in report[0]["problems"]))

    def test_one_alpha_pixel_does_not_bypass_the_opaque_source_refusal(self) -> None:
        source = self.root / "almost-opaque.png"
        output = self.root / "almost-opaque-cut.webp"
        image = Image.new("RGBA", (200, 200), (20, 20, 20, 255))
        image.putpixel((0, 0), (20, 20, 20, 0))
        image.save(source)

        result = run_script(CUTOUT, source, output)

        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertFalse(output.exists())

    def test_one_alpha_pixel_in_source_abstains_instead_of_false_failing_candidate(self) -> None:
        source = self.root / "almost-opaque.png"
        candidate = self.root / "manual-cutout.webp"
        image = Image.new("RGBA", (200, 200), (20, 20, 20, 255))
        image.putpixel((0, 0), (20, 20, 20, 0))
        image.save(source)
        cut = Image.new("RGBA", (60, 100), (0, 0, 0, 0))
        ImageDraw.Draw(cut).ellipse((8, 5, 52, 99), fill=(50, 80, 120, 255))
        cut.save(candidate, "WEBP", lossless=True)

        checked = run_script(CHECK, "--json", "--source", source, candidate)

        self.assertEqual(checked.returncode, 3, checked.stderr + checked.stdout)
        self.assertEqual(json.loads(checked.stdout)[0]["status"], "review_required")

    def test_explicit_source_snapshot_survives_a_deleted_temporary_source_path_but_needs_review(self) -> None:
        source = self.root / "source.webp"
        candidate = self.root / "candidate.webp"
        image = Image.new("RGBA", (100, 120), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((20, 10, 80, 119), fill=(120, 30, 30, 255))
        image.save(source, "WEBP", lossless=True)
        made = run_script(CUTOUT, source, candidate)
        self.assertEqual(made.returncode, 0, made.stderr + made.stdout)
        receipt_path = self.root / "candidate.webp.cutout.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["source"] = "deleted-temporary-source.webp"
        receipt_path.write_text(json.dumps(receipt))

        checked = run_script(CHECK, "--json", "--source", source, candidate)

        self.assertEqual(checked.returncode, 3, checked.stderr + checked.stdout)
        self.assertEqual(json.loads(checked.stdout)[0]["status"], "review_required")

    def test_exact_sealed_hash_can_reapprove_an_unchanged_cutout(self) -> None:
        source = self.root / "source.webp"
        candidate = self.root / "candidate.webp"
        image = Image.new("RGBA", (100, 120), (0, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((20, 10, 80, 119), fill=(120, 30, 30, 255))
        image.save(source, "WEBP", lossless=True)
        made = run_script(CUTOUT, source, candidate)
        self.assertEqual(made.returncode, 0, made.stderr + made.stdout)

        checked = run_script(
            CHECK,
            "--json",
            "--source",
            source,
            "--trusted-output-sha256",
            hashlib.sha256(candidate.read_bytes()).hexdigest(),
            candidate,
        )

        self.assertEqual(checked.returncode, 0, checked.stderr + checked.stdout)
        self.assertEqual(json.loads(checked.stdout)[0]["status"], "pass")

    def test_sparse_alpha_at_the_old_threshold_is_not_authoritative(self) -> None:
        source = self.root / "sparse-alpha.png"
        output = self.root / "sparse-alpha-cut.webp"
        image = Image.new("RGBA", (200, 200), (20, 20, 20, 255))
        for x in range(40):
            image.putpixel((x, 0), (20, 20, 20, 0))
        image.save(source)

        made = run_script(CUTOUT, source, output)

        self.assertEqual(made.returncode, 1, made.stderr + made.stdout)
        self.assertFalse(output.exists())

    def test_matching_alpha_with_replaced_subject_colours_is_rejected(self) -> None:
        source = self.root / "red-source.png"
        candidate = self.root / "green-candidate.png"
        red = Image.new("RGBA", (100, 120), (0, 0, 0, 0))
        ImageDraw.Draw(red).ellipse((15, 10, 85, 119), fill=(220, 25, 25, 255))
        red.save(source)
        green = Image.new("RGBA", red.size, (0, 0, 0, 0))
        ImageDraw.Draw(green).ellipse((15, 10, 85, 119), fill=(25, 220, 25, 255))
        green.save(candidate)

        checked = run_script(
            CHECK,
            "--json",
            "--source",
            source,
            "--trusted-output-sha256",
            hashlib.sha256(candidate.read_bytes()).hexdigest(),
            candidate,
        )

        self.assertEqual(checked.returncode, 1, checked.stderr + checked.stdout)
        report = json.loads(checked.stdout)[0]
        self.assertTrue(any("צבעי" in problem for problem in report["problems"]))

    def test_failed_receipt_commit_restores_the_previous_pair(self) -> None:
        first_source = self.root / "first-source.webp"
        second_source = self.root / "second-source.webp"
        destination = self.root / "portrait-cut.webp"
        first = Image.new("RGBA", (100, 120), (0, 0, 0, 0))
        ImageDraw.Draw(first).rectangle((20, 10, 80, 119), fill=(180, 30, 30, 255))
        first.save(first_source, "WEBP", lossless=True)
        second = Image.new("RGBA", (100, 120), (0, 0, 0, 0))
        ImageDraw.Draw(second).rectangle((20, 10, 80, 119), fill=(30, 30, 180, 255))
        second.save(second_source, "WEBP", lossless=True)
        made = run_script(CUTOUT, first_source, destination)
        self.assertEqual(made.returncode, 0, made.stderr + made.stdout)
        receipt_path = self.root / "portrait-cut.webp.cutout.json"
        old_output = destination.read_bytes()
        old_receipt = receipt_path.read_bytes()

        spec = importlib.util.spec_from_file_location("cutout_under_test", CUTOUT)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        real_replace = module.os.replace
        failed = False

        def fail_once_on_receipt(source_path, destination_path):
            nonlocal failed
            if not failed and Path(destination_path) == receipt_path:
                failed = True
                raise OSError("simulated crash before receipt commit")
            return real_replace(source_path, destination_path)

        with mock.patch.object(module.os, "replace", side_effect=fail_once_on_receipt):
            with self.assertRaises(OSError):
                module.cutout(second_source, destination)

        self.assertEqual(destination.read_bytes(), old_output)
        self.assertEqual(receipt_path.read_bytes(), old_receipt)
        self.assertFalse((self.root / "portrait-cut.webp.cutout.pending.json").exists())

    def test_forged_receipt_cannot_auto_approve_or_preserve_an_opaque_file(self) -> None:
        source = self.root / "opaque-source.webp"
        candidate = self.root / "opaque-candidate.webp"
        output = self.root / "copied.webp"
        Image.new("RGB", (100, 120), (80, 90, 100)).save(source, "WEBP", lossless=True)
        candidate.write_bytes(source.read_bytes())
        receipt = {
            "schemaVersion": 1,
            "status": "verified",
            "source": source.name,
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "outputSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
        }
        (self.root / "opaque-candidate.webp.cutout.json").write_text(json.dumps(receipt))
        (self.root / "opaque-source.webp.cutout.json").write_text(
            json.dumps({**receipt, "outputSha256": hashlib.sha256(source.read_bytes()).hexdigest()})
        )

        checked = run_script(CHECK, "--json", "--source", source, candidate)
        preserved = run_script(CUTOUT, source, output)

        self.assertEqual(checked.returncode, 1, checked.stderr + checked.stdout)
        self.assertEqual(json.loads(checked.stdout)[0]["status"], "fail")
        self.assertEqual(preserved.returncode, 1, preserved.stderr + preserved.stdout)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
