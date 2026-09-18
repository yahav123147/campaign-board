from __future__ import annotations

import importlib.util
import ssl
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HARVEST_BRAND = ROOT / "vendor" / "landing-skill" / "scripts" / "harvest_brand.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harvest_brand_under_test", HARVEST_BRAND)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ParseArgsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_uppercase_and_lowercase_schemes_are_both_selected(self) -> None:
        out, urls, ig = self.module.parse_args(
            ["out", "HTTPS://Example.com", "http://a.example"]
        )

        self.assertEqual(out, "out")
        self.assertEqual(urls, ["HTTPS://Example.com", "http://a.example"])
        self.assertIsNone(ig)

    def test_a_non_url_token_is_not_selected(self) -> None:
        out, urls, ig = self.module.parse_args(["out", "not-a-url", "http://a.example"])

        self.assertEqual(urls, ["http://a.example"])

    def test_ig_handle_is_parsed(self) -> None:
        out, urls, ig = self.module.parse_args(
            ["out", "http://a.example", "--ig", "some_handle"]
        )

        self.assertEqual(ig, "some_handle")
        self.assertEqual(urls, ["http://a.example"])

    def test_no_ig_flag_gives_none(self) -> None:
        out, urls, ig = self.module.parse_args(["out", "http://a.example"])

        self.assertIsNone(ig)


class SslContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_verification_stays_on(self) -> None:
        ctx = self.module.ssl_context()

        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)


class SummarizeOutcomeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_zero_fetches_is_a_hard_failure(self) -> None:
        code, message = self.module.summarize_outcome(0, "timed out")

        self.assertEqual(code, 2)
        self.assertIn("no source could be fetched", message)
        self.assertIn("timed out", message)

    def test_zero_fetches_with_no_recorded_error_still_fails(self) -> None:
        code, message = self.module.summarize_outcome(0, None)

        self.assertEqual(code, 2)
        self.assertIn("no source could be fetched", message)

    def test_any_successful_fetch_is_not_a_hard_failure(self) -> None:
        code, message = self.module.summarize_outcome(1, None)

        self.assertEqual(code, 0)
        self.assertIsNone(message)


if __name__ == "__main__":
    unittest.main()
