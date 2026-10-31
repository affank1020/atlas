"""Offline tests for the independent, signed macOS Node CLI bootstrap.

No GitHub network, launchctl service or production Node is contacted.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
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

    def make_second_lifecycle_different(self):
        """Model a source-verified release B containing newer lifecycle code."""
        file = self.second / "scripts" / "macos-node-lifecycle.py"
        file.write_bytes(file.read_bytes() + b"\n# signed release B lifecycle revision\n")
        manifest = self.second / "atlas-node-release.json"
        data = json.loads(manifest.read_text())
        data["operatorScripts"]["scripts/macos-node-lifecycle.py"] = hashlib.sha256(
            file.read_bytes()
        ).hexdigest()
        manifest.write_text(json.dumps(data))

    def with_active_node_and_watchdog(self):
        """Signed CLI A, active Node B, rollback Node A, loaded A watchdog."""
        operator.initial_install(self.layout, self.version1)
        self.make_second_lifecycle_different()
        self.layout.recovery_plist.parent.mkdir(mode=0o700, parents=True)
        operator.lifecycle.atomic_write(
            self.layout.recovery_script,
            (self.first / "scripts/macos-node-lifecycle.py").read_bytes()
        )
        operator.lifecycle.atomic_write(
            self.layout.recovery_plist,
            operator.lifecycle.watchdog_plist(self.layout, self.layout.recovery_script),
        )
        env = self.first / "apps/node" / ".env.node"
        env.write_text("FIXTURE_NOT_A_REAL_SECRET")
        def node_plist(release):
            return plistlib.dumps({
                "Label": operator.lifecycle.LABEL,
                "ProgramArguments": [sys.executable, str(release / operator.lifecycle.ENTRYPOINT)],
                "WorkingDirectory": str(release / "apps/node"),
                "EnvironmentVariables": {"ATLAS_NODE_ENV_FILE": str(env)},
                "RunAtLoad": True,
                "KeepAlive": {"SuccessfulExit": False},
            })
        operator.lifecycle.atomic_write(self.layout.plist, node_plist(self.second))
        operator.lifecycle.atomic_write(self.layout.previous, node_plist(self.first))
        self.node_loaded, self.watchdog_loaded, self.node_pid = True, True, 32041
        self.launch_events = []
        self.fail_watcher_once = False
        def fake(*args, capture=False):
            self.launch_events.append(args)
            if args[:2] == ("launchctl", "print"):
                if args[2] == self.layout.recovery_target:
                    if not self.watchdog_loaded:
                        raise subprocess.CalledProcessError(113, args)
                    return "state = waiting\n"
                if args[2] != self.layout.target or not self.node_loaded:
                    raise subprocess.CalledProcessError(113, args)
                return f"state = running\npid = {self.node_pid}\n"
            if args[:2] == ("launchctl", "bootout"):
                if args[2] == self.layout.recovery_target:
                    self.watchdog_loaded = False
                elif args[2] == self.layout.target:
                    self.node_loaded = False
                else:
                    raise AssertionError(args)
                return ""
            if args[:2] == ("launchctl", "bootstrap"):
                if args[3] == str(self.layout.recovery_plist):
                    if self.fail_watcher_once:
                        self.fail_watcher_once = False
                        raise subprocess.CalledProcessError(5, args)
                    self.watchdog_loaded = True
                elif args[3] == str(self.layout.plist):
                    self.node_loaded = True
                    self.node_pid += 1
                    self.layout.local_status.write_text(json.dumps({
                        "state": "connected", "pid": self.node_pid,
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                    }))
                else:
                    raise AssertionError(args)
                return ""
            raise AssertionError(args)
        self.fake_launchctl = fake

    def patched_release_lifecycle(self, scripts):
        """Instrument the actual signed B module, keeping real journals/files."""
        target = self.original_signed_lifecycle(scripts)
        cmd = patch.object(target, "command", side_effect=self.fake_launchctl)
        cmd.start()
        self.addCleanup(cmd.stop)
        dead = patch.object(target, "pid_exists", return_value=False)
        dead.start()
        self.addCleanup(dead.stop)
        return target

    def patch_cli_from(self, release):
        """Load the selected signed operator as a separately executable CLI."""
        update_path = release / "scripts/macos-node-update.py"
        spec = importlib.util.spec_from_file_location(
            "mac_node_test_update_" + release.name.replace("-", "_"), update_path
        )
        update = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(update)
        for field, value in (("command", self.fake_launchctl), ("pid_exists", lambda pid: False)):
            local = patch.object(update.lifecycle, field, side_effect=value if field == "command" else None,
                                 return_value=False if field == "pid_exists" else None)
            local.start()
            self.addCleanup(local.stop)
        guard = patch.object(update, "ensure_operator")
        guard.start()
        self.addCleanup(guard.stop)
        identity = patch.object(update.lifecycle, "Layout", return_value=self.layout)
        identity.start()
        self.addCleanup(identity.stop)
        return update

    def test_install_creates_self_contained_cli_without_launchd_mutation(self):
        with patch.object(operator.lifecycle, "command", side_effect=AssertionError("launchctl contacted")):
            operator.initial_install(self.layout, self.version1)
        op, pointer, wrapper = operator.paths(self.layout)
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
        self.assertEqual(pointer.resolve(), (self.first / "scripts").resolve())
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
        with patch.object(operator, "align_recovery_watchdog") as align:
            with operator.lifecycle.lock_state(self.layout):
                operator.promote(self.layout, self.version2, require_existing=True)
            align.assert_called_once()
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

    def test_signed_b_watchdog_is_activated_before_cli_b_and_rollback_works(self):
        self.with_active_node_and_watchdog()
        self.original_signed_lifecycle = operator.signed_lifecycle
        with patch.object(operator, "signed_lifecycle", side_effect=self.patched_release_lifecycle):
            with operator.lifecycle.lock_state(self.layout):
                operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(operator.current_target(self.layout), self.second / "scripts")
        self.assertEqual(self.layout.recovery_script.read_bytes(),
                         (self.second / "scripts/macos-node-lifecycle.py").read_bytes())
        self.assertTrue(self.watchdog_loaded)
        self.assertFalse(self.layout.watchdog_refresh.exists())
        update_b = self.patch_cli_from(self.second)
        with patch.object(update_b.sys.stdin, "isatty", return_value=True), patch(
            "builtins.input", return_value="ROLLBACK"
        ):
            self.assertEqual(update_b.main(["rollback"]), 0)
        self.assertEqual(plistlib.loads(self.layout.plist.read_bytes())["ProgramArguments"][1],
                         str(self.first / operator.lifecycle.ENTRYPOINT))
        self.assertFalse(self.layout.pending.exists())

    def test_failed_b_watchdog_bootstrap_keeps_cli_a_and_restores_a_watchdog(self):
        self.with_active_node_and_watchdog()
        self.fail_watcher_once = True
        self.original_signed_lifecycle = operator.signed_lifecycle
        with patch.object(operator, "signed_lifecycle", side_effect=self.patched_release_lifecycle):
            with operator.lifecycle.lock_state(self.layout):
                with self.assertRaises(subprocess.CalledProcessError):
                    operator.promote(self.layout, self.version2, require_existing=True)
        self.assertTrue(self.watchdog_loaded)
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
        self.assertEqual(self.layout.recovery_script.read_bytes(),
                         (self.first / "scripts/macos-node-lifecycle.py").read_bytes())
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_crash_after_b_watchdog_before_pointer_leaves_a_cli_rollback_working(self):
        self.with_active_node_and_watchdog()
        self.original_signed_lifecycle = operator.signed_lifecycle
        pointer = operator.paths(self.layout)[1]
        original_replace = os.replace
        def interrupted_pointer_replace(src, dst):
            if Path(dst) == pointer:
                raise SystemExit("simulated power loss after watchdog B bootstrap")
            return original_replace(src, dst)
        with patch.object(operator, "signed_lifecycle", side_effect=self.patched_release_lifecycle), patch.object(
            operator.os, "replace", side_effect=interrupted_pointer_replace
        ):
            with operator.lifecycle.lock_state(self.layout):
                with self.assertRaises(SystemExit):
                    operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
        self.assertTrue(self.watchdog_loaded)
        self.assertEqual(self.layout.recovery_script.read_bytes(),
                         (self.second / "scripts/macos-node-lifecycle.py").read_bytes())
        update_a = self.patch_cli_from(self.first)
        with patch.object(update_a.sys.stdin, "isatty", return_value=True), patch(
            "builtins.input", return_value="ROLLBACK"
        ):
            self.assertEqual(update_a.main(["rollback"]), 0)
        self.assertEqual(self.layout.recovery_script.read_bytes(),
                         (self.first / "scripts/macos-node-lifecycle.py").read_bytes())
        self.assertEqual(plistlib.loads(self.layout.plist.read_bytes())["ProgramArguments"][1],
                         str(self.first / operator.lifecycle.ENTRYPOINT))
        self.assertFalse(self.layout.pending.exists())
        self.assertFalse(self.layout.watchdog_refresh.exists())

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
        with patch.object(operator, "align_recovery_watchdog"):
            operator.sync_from_active(self.layout)
        self.assertEqual(operator.current_target(self.layout), self.second / "scripts")


if __name__ == "__main__":
    unittest.main()
