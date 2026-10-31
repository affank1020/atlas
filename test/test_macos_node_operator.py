"""Offline tests for the independent, signed macOS Node CLI bootstrap.

No GitHub network, launchctl service or production Node is contacted.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/macos-node-operator.py"
spec = importlib.util.spec_from_file_location("atlas_macos_operator_tests", SCRIPT)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
REPO_SCRIPTS = SCRIPT.parent


class MacOperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mac-node-operator-")
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name) / "home"
        home.mkdir(mode=0o700)
        self.layout = operator.lifecycle.Layout(home, os.getuid())
        self.layout.releases.mkdir(mode=0o700, parents=True)
        self.layout.app.chmod(0o700)
        self.version1 = "v2.0.0-" + "a" * 12
        self.version2 = "v2.0.0-" + "b" * 12
        self.first = self.make_release(self.version1, "a" * 40)
        self.second = self.make_release(self.version2, "b" * 40)

    def make_release(self, version: str, source: str) -> Path:
        root = self.layout.releases / version
        root.mkdir(mode=0o700)
        scripts = root / "scripts"
        scripts.mkdir(mode=0o700)
        hashes = {}
        for name in operator.FILES:
            content = (REPO_SCRIPTS / name).read_bytes()
            (scripts / name).write_bytes(content)
            hashes["scripts/" + name] = hashlib.sha256(content).hexdigest()
        for path in (
            operator.lifecycle.ENTRYPOINT,
            "apps/node/package.json", "package-lock.json",
        ):
            file = root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("test fixture")
        record = {
            "application": "@atlas/node", "protocol": 2,
            "commit": source, "version": "2.0.0",
            "entrypoint": operator.lifecycle.ENTRYPOINT,
            "supportedHosts": ["darwin", "linux"],
            "operatorScripts": hashes,
        }
        (root / "atlas-node-release.json").write_text(json.dumps(record))
        (root / ".atlas-signed-staging.json").write_text(json.dumps({
            "schema": 1, "source": source, "tag": "node-" + version,
            "verification": "signed-github-build-provenance",
            "archiveSha256": "0" * 64,
        }))
        return root

    def test_install_creates_self_contained_cli_without_launchd_mutation(self):
        with patch.object(operator.lifecycle, "command", side_effect=AssertionError("launchctl contacted")):
            operator.initial_install(self.layout, self.version1)
        op, pointer, wrapper = operator.paths(self.layout)
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
        self.assertEqual(pointer.resolve(), self.first / "scripts")
        self.assertEqual(wrapper.read_text(), operator.WRAPPER)
        self.assertEqual(wrapper.stat().st_mode & 0o077, 0)
        self.assertEqual(op.stat().st_mode & 0o077, 0)
        self.assertFalse(self.layout.pending.exists())
        self.assertTrue(operator.operator_status(self.layout)["installedOperator"] == self.version1)
        # The target is a signed-staged release, not the source checkout.
        self.assertNotIn(str(REPO_SCRIPTS), os.readlink(pointer))

    def test_repeated_install_is_idempotent(self):
        operator.initial_install(self.layout, self.version1)
        pointer = operator.paths(self.layout)[1]
        previous = os.readlink(pointer)
        operator.initial_install(self.layout, self.version1)
        self.assertEqual(os.readlink(pointer), previous)

    def test_installed_operator_can_run_without_source_checkout_on_path(self):
        operator.initial_install(self.layout, self.version1)
        path = operator.paths(self.layout)[1] / "macos-node-update.py"
        # Usage validation occurs before macOS-only host checks. This proves
        # the staged scripts load their sibling dependencies in isolation.
        result = subprocess.run([sys.executable, str(path), "invalid-command"],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Usage:", result.stderr)

    def test_modified_bundled_script_fails_closed(self):
        (self.first / "scripts" / "macos-node-update.py").write_text("print('tampered')\n")
        with self.assertRaisesRegex(operator.Refused, "digest mismatch"):
            operator.initial_install(self.layout, self.version1)
        self.assertFalse(operator.paths(self.layout)[1].exists())

    def test_legacy_release_missing_operator_metadata_is_rejected(self):
        manifest = self.first / "atlas-node-release.json"
        record = json.loads(manifest.read_text())
        del record["operatorScripts"]
        manifest.write_text(json.dumps(record))
        with self.assertRaisesRegex(operator.Refused, "too old"):
            operator.initial_install(self.layout, self.version1)
        self.assertFalse(operator.paths(self.layout)[1].exists())

    def test_promote_moves_wrapper_to_new_signed_release_atomically(self):
        operator.initial_install(self.layout, self.version1)
        wrapper = operator.paths(self.layout)[2]
        original_wrapper = wrapper.read_bytes()
        with operator.lifecycle.lock_state(self.layout):
            operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(operator.current_target(self.layout), self.second / "scripts")
        self.assertEqual(wrapper.read_bytes(), original_wrapper)

    def test_promote_does_not_bootstrap_without_existing_operator(self):
        with operator.lifecycle.lock_state(self.layout):
            operator.promote(self.layout, self.version2, require_existing=True)
        self.assertFalse(operator.paths(self.layout)[1].exists())
        self.assertFalse(operator.paths(self.layout)[2].exists())

    def test_pending_lifecycle_and_watchdog_transactions_block_switch(self):
        operator.initial_install(self.layout, self.version1)
        for blocking in (self.layout.pending, self.layout.watchdog_refresh):
            blocking.parent.mkdir(parents=True, exist_ok=True)
            blocking.write_text("{}")
            with operator.lifecycle.lock_state(self.layout):
                with self.assertRaisesRegex(operator.Refused, "pending"):
                    operator.promote(self.layout, self.version2, require_existing=True)
            self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
            blocking.unlink()

    def test_unexpected_existing_pointer_is_not_overwritten(self):
        operator.initial_install(self.layout, self.version1)
        pointer = operator.paths(self.layout)[1]
        pointer.unlink()
        pointer.symlink_to(Path(self.temp.name) / "elsewhere")
        with operator.lifecycle.lock_state(self.layout):
            with self.assertRaisesRegex(operator.Refused, "outside the private release tree"):
                operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(os.readlink(pointer), str(Path(self.temp.name) / "elsewhere"))

    def test_untrusted_modified_wrapper_is_not_overwritten(self):
        operator.initial_install(self.layout, self.version1)
        wrapper = operator.paths(self.layout)[2]
        wrapper.write_text("#!/bin/sh\nexit 0\n")
        with operator.lifecycle.lock_state(self.layout):
            with self.assertRaisesRegex(operator.Refused, "differs"):
                operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")

    def test_operator_sync_uses_active_release_not_latest_catalogue(self):
        operator.initial_install(self.layout, self.version1)
        cwd = self.second / "apps/node"
        env = cwd / ".env.node"
        env.write_text("FIXTURE_NOT_A_SECRET")
        self.layout.plist.parent.mkdir(parents=True)
        self.layout.plist.write_bytes(plistlib.dumps({
            "Label": operator.lifecycle.LABEL,
            "ProgramArguments": [sys.executable,
                                 str(self.second / operator.lifecycle.ENTRYPOINT)],
            "WorkingDirectory": str(cwd),
            "EnvironmentVariables": {"ATLAS_NODE_ENV_FILE": str(env)},
            "RunAtLoad": True,
        }))
        self.layout.plist.chmod(0o600)
        operator.sync_from_active(self.layout)
        self.assertEqual(operator.current_target(self.layout), self.second / "scripts")


if __name__ == "__main__":
    unittest.main()
