"""Safe, network-free selection tests for the host-local Linux Node updater."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

p = Path(__file__).resolve().parents[1] / "scripts/linux-node-host-updater.py"
spec = importlib.util.spec_from_file_location("atlas_linux_node_host_updater", p)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)

def release(short, seq, version="2.0.0", immutable=True):
    sha = short + "0" * 28
    file = "atlas-node-v" + version + "-" + short + ".tar.gz"
    return {
        "tag_name": "node-v" + version + "-" + short,
        "target_commitish": sha,
        "immutable": immutable,
        "draft": False,
        "prerelease": False,
        "body": "Atlas-Node-Release-Sequence: " + str(seq) + "\n\nNode build",
        "assets": [
            {"name": file, "digest": "sha256:" + "a" * 64, "size": 80000},
            {"name": file + ".sha256", "digest": "sha256:" + "b" * 64, "size": 104}
        ]
    }

A = "123456789abc"
B = "abcdef123456"
C = "789abcdef123"


class CatalogTests(unittest.TestCase):
    def test_sequence_beats_publication_order(self):
        results = updater.verified_catalogue([release(A, 100), release(B, 144), release(C, 130)])
        candidate, status = updater.choose_latest(results, "v2.0.0-" + A)
        self.assertEqual((candidate["tag"], status), ("node-v2.0.0-" + B, "available"))

    def test_same_build_is_current(self):
        results = updater.verified_catalogue([release(A, 100)])
        self.assertEqual(updater.choose_latest(results, "v2.0.0-" + A)[1], "current")

    def test_new_version_beats_old_sequence(self):
        results = updater.verified_catalogue([release(A, 500), release(B, 1, "2.1.0")])
        self.assertEqual(updater.choose_latest(results, "v2.0.0-" + A)[0]["version"], (2, 1, 0))

    def test_unknown_same_version_fails_closed(self):
        results = updater.verified_catalogue([release(A, 100)])
        with self.assertRaises(updater.Refused):
            updater.choose_latest(results, "v2.0.0-" + B)

    def test_never_downgrade(self):
        results = updater.verified_catalogue([release(A, 100)])
        with self.assertRaises(updater.Refused):
            updater.choose_latest(results, "v3.0.0-" + B)

    def test_nonimmutable_and_debug_releases_are_excluded(self):
        broken = release(A, 100, immutable=False)
        with self.assertRaises(updater.Refused):
            updater.verified_catalogue([broken])
        invalid = release(A, 100)
        invalid["prerelease"] = True
        with self.assertRaises(updater.Refused):
            updater.verified_catalogue([invalid])

    def test_invalid_or_missing_attestation_inputs_fail_catalogue(self):
        invalid = release(A, 100)
        invalid["target_commitish"] = B + "0" * 28
        with self.assertRaises(updater.Refused):
            updater.verified_catalogue([invalid])
        invalid = release(A, 100)
        invalid["assets"][0]["digest"] = "sha256:" + "x" * 64
        with self.assertRaises(updater.Refused):
            updater.verified_catalogue([invalid])

    def test_conflicting_sequence_fails(self):
        with self.assertRaises(updater.Refused):
            updater.verified_catalogue([release(A, 100), release(B, 100)])

    def test_reject_truncated_catalogue(self):
        with self.assertRaises(updater.Refused):
            updater.releases_from_json("[" + ",".join("{}" for _ in range(100)) + "]")

    def test_public_release_check_is_bounded_and_pins_the_url(self):
        class PublicResponse(io.BytesIO):
            def geturl(self):
                return updater.PUBLIC_RELEASES_URL

        payload = json.dumps([release(A, 100)]).encode()
        with patch.object(updater.urllib.request, "urlopen",
                          return_value=PublicResponse(payload)) as fetch:
            self.assertEqual(updater.read_public_release_catalogue(), payload.decode())
        request = fetch.call_args.args[0]
        self.assertEqual(request.full_url, updater.PUBLIC_RELEASES_URL)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(fetch.call_args.kwargs["timeout"], 20)

    def test_public_catalogue_redirect_is_refused(self):
        class Redirected(io.BytesIO):
            def geturl(self):
                return "https://unexpected.example.net/releases"

        with patch.object(updater.urllib.request, "urlopen",
                          return_value=Redirected(b"[]")):
            with self.assertRaisesRegex(updater.Refused, "redirected"):
                updater.read_public_release_catalogue()

    def test_public_catalogue_too_large_fails_closed(self):
        class PublicResponse(io.BytesIO):
            def geturl(self):
                return updater.PUBLIC_RELEASES_URL

        with patch.object(updater, "MAX_CATALOGUE_BYTES", 8), \
             patch.object(updater.urllib.request, "urlopen",
                          return_value=PublicResponse(b"0123456789")):
            with self.assertRaisesRegex(updater.Refused, "bounded"):
                updater.read_public_release_catalogue()

    def test_public_check_json_never_invokes_gh_or_sudo(self):
        payload = json.dumps([release(A, 100), release(B, 110)])
        out = io.StringIO()
        with patch.object(updater.os, "geteuid", return_value=1000), \
             patch.object(updater, "read_public_release_catalogue", return_value=payload) as fetch, \
             patch.object(updater, "installed_release", return_value="v2.0.0-" + A), \
             patch.object(updater, "run", side_effect=AssertionError("No commands in read-only check")), \
             contextlib.redirect_stdout(out):
            self.assertEqual(updater.main(["check", "--json"]), 0)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(json.loads(out.getvalue()), {
            "schema": 1, "installed": "v2.0.0-" + A,
            "candidate": "node-v2.0.0-" + B, "state": "available",
            "verification": "catalogue-only",
        })

    def test_public_check_failure_never_reports_current(self):
        with patch.object(updater.os, "geteuid", return_value=1000), \
             patch.object(updater, "read_public_release_catalogue", side_effect=updater.Refused("429 rate limited")), \
             patch.object(updater, "run", side_effect=AssertionError("No install fallback")):
            with self.assertRaisesRegex(updater.Refused, "429"):
                updater.main(["check", "--json"])

    def test_systemd_checker_is_sandboxed_and_never_installs(self):
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        unit = (scripts / "atlas-node-update-check@.service").read_text()
        timer = (scripts / "atlas-node-update-check@.timer").read_text()
        self.assertIn("User=%i", unit)
        self.assertIn("NoNewPrivileges=yes", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("ExecStart=/usr/local/bin/atlas-node-update check --json", unit)
        self.assertNotIn("ExecStart=sudo", unit)
        self.assertNotIn(" update", unit.split("ExecStart=")[1].splitlines()[0])
        self.assertIn("OnCalendar=hourly", timer)
        self.assertIn("RandomizedDelaySec=15min", timer)

    def test_status_is_read_only_and_no_root_main_allowed(self):
        self.assertFalse(updater.TAG.fullmatch("node-v2.0.0-unsafe;rm"))
        self.assertFalse(updater.DIGEST.fullmatch("sha256:short"))

    def test_github_host_is_pinned_even_if_caller_sets_enterprise_host(self):
        with patch.dict(updater.os.environ, {"GH_HOST": "malicious.example"}):
            with patch.object(updater.subprocess, "run") as subprocess_run:
                subprocess_run.return_value.stdout = "[]"
                updater.run("gh", "api", "-X", "GET", updater.RELEASES_API, capture=True)
                self.assertEqual(subprocess_run.call_args.kwargs["env"]["GH_HOST"], "github.com")

    def test_tampered_download_never_reaches_attestation_or_sudo(self):
        info = updater.verified_catalogue([release(A, 100)])[0]
        calls = []
        def fake_run(*argv, **_kwargs):
            calls.append(argv)
            if argv[:3] == ("gh", "release", "download"):
                filename = info["file"]
                (directory / filename).write_bytes(b"tampered archive")
                (directory / (filename + ".sha256")).write_text("bad manifest")
                return ""
            raise AssertionError("Unverified bytes must not reach privileged or attestation execution.")
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            with patch.object(updater, "run", side_effect=fake_run):
                with self.assertRaises(updater.Refused):
                    updater.download_and_verify(info, directory)
        self.assertEqual(len(calls), 1)

    def test_status_requires_privileged_heartbeat_access(self):
        # Production node-status.json lives beneath a service-user 0700
        # directory. A non-root operator must use the constrained root helper.
        with patch.object(updater.os, "geteuid", return_value=1000), \
             patch.object(updater, "root_helper") as verify_helper, \
             patch.object(updater, "run") as run:
            self.assertEqual(updater.main(["status"]), 0)
        verify_helper.assert_called_once_with(updater.LIFECYCLE)
        run.assert_called_once_with("sudo", str(updater.LIFECYCLE), "status")

    def test_preexisting_checksum_only_stage_cannot_be_activated(self):
        # An older installer could have created a root-owned but unsigned
        # target with a valid directory name and a different runtime payload.
        # Ownership/manifest alone is not release provenance; refuse reuse.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "releases" / ("v2.0.0-" + B)
            target.mkdir(parents=True)
            (target / "atlas-node-release.json").write_text('{"version":"2.0.0"}')
            (target / "unsigned-runtime.js").write_text("untrusted code")
            catalog = json.dumps([release(A, 100), release(B, 101)])
            calls = []

            def fake_run(*argv, **_kwargs):
                calls.append(argv)
                if argv == ("gh", "api", "-X", "GET", updater.RELEASES_API):
                    return catalog
                raise AssertionError("Untrusted pre-stage must not download, stage or activate")

            with patch.object(updater, "ROOT", root), \
                 patch.object(updater.os, "geteuid", return_value=1000), \
                 patch.object(updater, "installed_release", return_value="v2.0.0-" + A), \
                 patch.object(updater, "root_helper"), \
                 patch.object(updater.sys, "stdin") as stdin, \
                 patch.object(updater, "run", side_effect=fake_run):
                stdin.isatty.return_value = True
                with self.assertRaisesRegex(updater.Refused, "provenance cannot be established"):
                    updater.main(["update"])
            self.assertEqual(calls, [("gh", "api", "-X", "GET", updater.RELEASES_API)])
            self.assertTrue((target / "unsigned-runtime.js").exists())

    def test_release_target_appearing_during_download_never_activates(self):
        # A concurrent stage between the initial preflight and sudo must
        # not be accepted even if it uses the expected release directory.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "releases" / ("v2.0.0-" + B)
            catalog = json.dumps([release(A, 100), release(B, 101)])
            calls = []

            def fake_run(*argv, **_kwargs):
                calls.append(argv)
                if argv == ("gh", "api", "-X", "GET", updater.RELEASES_API):
                    return catalog
                raise AssertionError("No sudo/staging/activation after unexpected target appears.")

            def concurrent_stage(_candidate, _directory):
                target.mkdir(parents=True)
                (target / "unexpected.js").write_text("unsigned")
                return (Path(tmp) / "archive", Path(tmp) / "checksum", Path(tmp) / "bundle")

            with patch.object(updater, "ROOT", root), \
                 patch.object(updater.os, "geteuid", return_value=1000), \
                 patch.object(updater, "installed_release", return_value="v2.0.0-" + A), \
                 patch.object(updater, "root_helper"), \
                 patch.object(updater.sys, "stdin") as stdin, \
                 patch.object(updater, "run", side_effect=fake_run), \
                 patch.object(updater, "download_and_verify", side_effect=concurrent_stage), \
                 patch("builtins.input", return_value="UPDATE node-v2.0.0-" + B):
                stdin.isatty.return_value = True
                with self.assertRaisesRegex(updater.Refused, "provenance cannot be established"):
                    updater.main(["update"])
            self.assertEqual(calls, [("gh", "api", "-X", "GET", updater.RELEASES_API)])
            self.assertTrue((target / "unexpected.js").exists())

    def test_dangling_release_symlink_is_not_safe_to_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / ("v2.0.0-" + B)
            target.symlink_to(Path(tmp) / "missing")
            with self.assertRaises(updater.Refused):
                updater.require_new_release_target(target)

    def test_absent_release_target_can_be_safely_staged(self):
        with tempfile.TemporaryDirectory() as tmp:
            updater.require_new_release_target(Path(tmp) / ("v2.0.0-" + B))


if __name__ == "__main__":
    unittest.main()
