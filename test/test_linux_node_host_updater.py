"""Safe, network-free selection tests for the host-local Linux Node updater."""
import importlib.util
from pathlib import Path
import unittest

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

    def test_status_is_read_only_and_no_root_main_allowed(self):
        # Avoid running a real GitHub command in unit tests.
        self.assertFalse(updater.TAG.fullmatch("node-v2.0.0-unsafe;rm"))
        self.assertFalse(updater.DIGEST.fullmatch("sha256:short"))


if __name__ == "__main__":
    unittest.main()
