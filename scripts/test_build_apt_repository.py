import argparse
import contextlib
import datetime as dt
import io
import pathlib
import tempfile
import unittest
from email.message import Message
from email.parser import Parser
from email.utils import parsedate_to_datetime

from scripts import build_apt_repository as repository


class ReleaseValidityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = repository.build_arg_parser()

    def parse_args(self, *extra: str) -> argparse.Namespace:
        return self.parser.parse_args(["package.deb", "--output", "repository", *extra])

    def render_release(self, args: argparse.Namespace, generated_at: dt.datetime) -> Message:
        with tempfile.TemporaryDirectory() as directory:
            repo_root = pathlib.Path(directory)
            (repo_root / "dists" / args.suite).mkdir(parents=True)
            text = repository.release_file(repo_root, args, ["amd64"], generated_at=generated_at)
        return Parser().parsestr(text)

    def test_default_valid_until_uses_policy_interval_after_utc_date(self) -> None:
        args = self.parse_args()
        generated_at = dt.datetime(2026, 7, 23, 12, 34, 56, 987654, tzinfo=dt.timezone(dt.timedelta(hours=2)))

        release = self.render_release(args, generated_at)
        release_date = parsedate_to_datetime(release["Date"])
        valid_until = parsedate_to_datetime(release["Valid-Until"])

        self.assertEqual(release_date, dt.datetime(2026, 7, 23, 10, 34, 56, tzinfo=dt.timezone.utc))
        self.assertEqual(valid_until - release_date, dt.timedelta(days=repository.DEFAULT_VALID_FOR_DAYS))
        self.assertEqual(repository.DEFAULT_VALID_FOR_DAYS, 30)
        self.assertGreater(valid_until, release_date)

    def test_validity_days_override_controls_valid_until(self) -> None:
        args = self.parse_args("--valid-for-days", "14")
        generated_at = dt.datetime(2026, 7, 23, tzinfo=dt.timezone.utc)

        release = self.render_release(args, generated_at)
        release_date = parsedate_to_datetime(release["Date"])
        valid_until = parsedate_to_datetime(release["Valid-Until"])

        self.assertEqual(args.valid_for_days, 14)
        self.assertEqual(valid_until - release_date, dt.timedelta(days=14))

    def test_cli_rejects_non_positive_and_non_integer_validity(self) -> None:
        for value in ("0", "-1", "1.5", "not-a-number"):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    self.parse_args("--valid-for-days", value)
                self.assertEqual(raised.exception.code, 2)

    def test_release_date_must_be_timezone_aware(self) -> None:
        args = self.parse_args()
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            self.render_release(args, dt.datetime(2026, 7, 23))


if __name__ == "__main__":
    unittest.main()
