"""Offline, nonprivileged tests for the macOS signed Node release staging path.

Mock only GitHub CLI/npm; real tar parsing, extraction, SHA-256 and filesystem
staging are exercised under a private disposable directory. No launchctl calls.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "scripts/macos-node-stage.py"
spec = importlib.util.spec_from_file_location("macos_node_stage", source)
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)

COMMIT = "abcdef123456" + "0" * 28
TAG = "node-v2.0.0-abcdef123456"
ARCHIVE = "atlas-node-v2.0.0-abcdef123456.tar.gz"
MANIFEST = {
    "application": "@atlas/node",
    "version": "2.0.0",
    "commit": COMMIT,
    "protocol": 2,
    "entrypoint": stage.ENTRYPOINT,
    "supportedHosts": ["darwin", "linux"],
}


def release(digest="a" * 64):
    return {"tag_name": TAG, "draft": False, "prerelease": False,
            "immutable": True, "target_commitish": COMMIT,
            "assets": [
                {"name": ARCHIVE, "digest": "sha256:" + digest, "size": 4096},
                {"name": ARCHIVE + ".sha256", "digest": "sha256:" + "b" * 64, "size": 100},
            ]}


def create_archive(directory: Path, extra=None, manifest=None):
    archive = directory / ARCHIVE
    content = {
        "package.json": b'{"name":"atlas-node-release","workspaces":["apps/node","packages/protocol"]}',
        "package-lock.json": b'{"name":"atlas-node-release","lockfileVersion":3,"packages":{}}',
        "atlas-node-release.json": json.dumps(manifest or MANIFEST).encode(),
        stage.ENTRYPOINT: b"// harmless compiled fixture",
    }
    content.update(extra or {})
    with tarfile.open(archive, "w:gz") as tar:
        root = tarfile.TarInfo(".")
        root.type = tarfile.DIRTYPE
        tar.addfile(root)
        for path, contents in content.items():
            entry = tarfile.TarInfo("./" + path)
            if isinstance(contents, tarfile.TarInfo):
                tar.addfile(contents)
            else:
                entry.size = len(contents)
                tar.addfile(entry, io.BytesIO(contents))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (directory / (ARCHIVE + ".sha256")).write_text(digest + "  " + ARCHIVE + "\n")
    return archive, digest


class MacStageTests(unittest.TestCase):
    def test_release_requires_immutable_tag_commit_and_both_assets(self):
        self.assertEqual(stage.release_info(release(), TAG)["sha"], COMMIT)
        variants = [
            {"immutable": False}, {"prerelease": True}, {"draft": True},
            {"target_commitish": "0" * 40}, {"tag_name": TAG + "extra"},
            {"assets": []},
        ]
        for change in variants:
            with self.subTest(change=change):
                with self.assertRaises(stage.Refused):
                    stage.release_info({**release(), **change}, TAG)

    def test_stable_archive_and_manifest_validate(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, digest = create_archive(Path(tmp))
            info = stage.release_info(release(digest), TAG)
            stage.inspect_archive(archive, info)

    def test_invalid_manifest_cannot_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, digest = create_archive(Path(tmp), manifest={**MANIFEST, "commit": "0" * 40})
            with self.assertRaisesRegex(stage.Refused, "manifest"):
                stage.inspect_archive(archive, stage.release_info(release(digest), TAG))

    def test_path_traversal_and_links_fail_before_extraction(self):
        for name in ("./../outside", "./a/../outside", "/absolute/path", ".//bad", "././bad"):
            with self.subTest(path=name):
                member = tarfile.TarInfo(name)
                with self.assertRaises(stage.Refused):
                    stage.safe_member_path(member)
        with tempfile.TemporaryDirectory() as tmp:
            bad = tarfile.TarInfo("./malicious")
            bad.type = tarfile.SYMTYPE
            bad.linkname = "/etc/passwd"
            archive, digest = create_archive(Path(tmp), extra={"bad": bad})
            with self.assertRaisesRegex(stage.Refused, "Links and special"):
                stage.inspect_archive(archive, stage.release_info(release(digest), TAG))

    def test_tampered_digest_never_reaches_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            create_archive(Path(tmp))
            with patch.object(stage, "command", side_effect=AssertionError("Signer should not be consulted")):
                with self.assertRaisesRegex(stage.Refused, "digest mismatch"):
                    stage.verify_download(Path(tmp), stage.release_info(release("a" * 64), TAG))

    def test_signature_pins_exact_sha_workflow_and_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, digest = create_archive(Path(tmp))
            calls = []
            def record_command(*argv, **kwargs):
                calls.append(argv)
                return "gh version 2.110.0" if argv == ("gh", "--version") else ""
            with patch.object(stage, "command", side_effect=record_command):
                stage.verify_download(Path(tmp), stage.release_info(release(digest), TAG))
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0], ("gh", "--version"))
            args = calls[1]
            self.assertEqual(args[:3], ("gh", "attestation", "verify"))
            self.assertEqual(args[3], str(archive))
            self.assertEqual(args[args.index("--repo") + 1], "affank1020/atlas")
            self.assertEqual(args[args.index("--source-digest") + 1], COMMIT)
            self.assertEqual(args[args.index("--source-ref") + 1], "refs/heads/main")
            self.assertIn("/node-package.yml@refs/heads/main", args[args.index("--cert-identity") + 1])
            self.assertIn("--deny-self-hosted-runners", args)

    def test_unsafe_gh_version_never_verifies_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, digest = create_archive(Path(tmp))
            with patch.object(stage, "command", return_value="gh version 2.101.0") as cmd:
                with self.assertRaisesRegex(stage.Refused, "2.102.0"):
                    stage.verify_download(Path(tmp), stage.release_info(release(digest), TAG))
            cmd.assert_called_once_with("gh", "--version", capture=True, timeout=15)

    def test_verified_stage_is_isolated_and_never_changes_launchd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "releases"
            root.mkdir(mode=0o700)
            calls = []

            def fake_command(*args, **kwargs):
                calls.append(args)
                if args == ("gh", "--version"):
                    return "gh version 2.110.0"
                if args[:2] == ("gh", "api"):
                    # Catalogue metadata must contain the real archive digest.
                    return json.dumps(release(digest))
                if args[:3] == ("gh", "release", "download"):
                    dest = Path(args[args.index("--dir") + 1])
                    dest.joinpath(ARCHIVE).write_bytes(archive_bytes)
                    dest.joinpath(ARCHIVE + ".sha256").write_text(digest + "  " + ARCHIVE + "\n")
                return ""

            original = Path(tmp) / "fixture"
            original.mkdir()
            archive, digest = create_archive(original)
            archive_bytes = archive.read_bytes()
            with patch.object(stage, "command", side_effect=fake_command):
                output = stage.stage(TAG, root)
                self.assertTrue((output / stage.ENTRYPOINT).is_file())
                self.assertEqual(json.loads((output / stage.RECEIPT).read_text())["source"], COMMIT)
                self.assertFalse(any("launchctl" in argv for call in calls for argv in call))
                self.assertFalse(any("sudo" in argv for call in calls for argv in call))
                self.assertEqual(len([c for c in calls if c[:2] == ("npm", "ci")]), 1)
                with self.assertRaisesRegex(stage.Refused, "already exists"):
                    stage.stage(TAG, root)

    def test_symlinked_lock_cannot_be_opened_or_overwrite_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "releases"
            root.mkdir(mode=0o700)
            secret = Path(tmp) / "untouched-credential"
            secret.write_text("private\n")
            (root / ".stage.lock").symlink_to(secret)
            with patch.object(stage, "command", side_effect=AssertionError("No network with malicious lock")):
                with self.assertRaises(OSError):
                    stage.stage(TAG, root)
            self.assertEqual(secret.read_text(), "private\n")

    def test_symlinked_destination_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "releases"
            root.mkdir(mode=0o700)
            (root / TAG.removeprefix("node-")).symlink_to(Path(tmp) / "outside")
            with patch.object(stage, "command", side_effect=AssertionError("No network after symlink")):
                with self.assertRaisesRegex(stage.Refused, "already exists"):
                    stage.stage(TAG, root)


if __name__ == "__main__":
    unittest.main()
