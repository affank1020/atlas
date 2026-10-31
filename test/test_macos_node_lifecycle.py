"""Disposable macOS lifecycle acceptance: real plist/journal, fake launchctl.

No processes are started, no live LaunchAgent is changed, and no credentials
are read. These tests do not replace logged-in macOS host acceptance.
"""
from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/macos-node-lifecycle.py"
spec = importlib.util.spec_from_file_location("atlas_macos_lifecycle", SCRIPT)
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class FakeLaunchd:
    def __init__(self, test):
        self.test = test
        self.loaded = True
        self.recovery_loaded = False
        self.pid = 12345
        self.commands = []
        self.online = True

    def __call__(self, *args, capture=False):
        self.commands.append(args)
        if args[:2] == ("launchctl", "print"):
            if args[2] == self.test.layout.recovery_target:
                if not self.recovery_loaded:
                    raise subprocess.CalledProcessError(113, args)
                return "state = waiting\n"
            if not self.loaded:
                raise subprocess.CalledProcessError(113, args)
            return f"state = running\npid = {self.pid}\n"
        if args[:2] == ("launchctl", "bootout"):
            self.loaded = False
            return ""
        if args[:2] == ("launchctl", "bootstrap"):
            if args[3] == str(self.test.layout.recovery_plist):
                self.recovery_loaded = True
            else:
                self.loaded = True
                self.pid += 1
                if self.online:
                    self.test.layout.local_status.write_text(json.dumps({
                        "state": "connected", "pid": self.pid,
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                    }))
            return ""
        raise AssertionError(f"Unexpected launchctl command: {args}")


class MacLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="macos-node-lifecycle-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.layout = lifecycle.Layout(self.home, os.getuid())
        self.layout.releases.mkdir(parents=True, mode=0o700)
        self.layout.state.mkdir(parents=True, mode=0o700)
        self.layout.plist.parent.mkdir(parents=True, mode=0o700)
        repo = self.home / "Documents" / "Atlas"
        cwd = repo / "apps/node"
        (cwd / "dist/platforms/desktop").mkdir(parents=True)
        (cwd / ".env.node").write_text("PLACEHOLDER_SECRET_NOT_A_REAL_NODE_TOKEN\n")
        (cwd / "dist/platforms/desktop/main.js").write_text("// local Mac Node fixture")
        self.old_env = str(cwd / ".env.node")
        self.existing = plistlib.dumps({
            "Label": lifecycle.LABEL,
            "ProgramArguments": [sys.executable, str(repo / lifecycle.ENTRYPOINT)],
            "WorkingDirectory": str(cwd),
            "EnvironmentVariables": {
                "ATLAS_NODE_ENV_FILE": self.old_env,
                "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
            },
            "RunAtLoad": True,
            "KeepAlive": {"SuccessfulExit": False},
        }, fmt=plistlib.FMT_XML)
        self.layout.plist.write_bytes(self.existing)
        self.layout.plist.chmod(0o600)
        self.tag = "v2.0.0-" + "a" * 12
        self.source = "a" * 40
        self.release = self.layout.releases / self.tag
        self.release.mkdir(mode=0o700)
        for name in (lifecycle.ENTRYPOINT, "apps/node/package.json", "package-lock.json"):
            path = self.release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// fixture")
        (self.release / "atlas-node-release.json").write_text(json.dumps({
            "application": "@atlas/node", "protocol": 2,
            "commit": self.source, "version": "2.0.0",
            "entrypoint": lifecycle.ENTRYPOINT, "supportedHosts": ["darwin"],
        }))
        (self.release / ".atlas-signed-staging.json").write_text(json.dumps({
            "schema": 1, "tag": "node-" + self.tag,
            "source": self.source, "verification": "signed-github-build-provenance",
        }))
        self.layout.local_status.write_text(json.dumps({
            "state": "connected", "pid": 12345,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }))
        self.fake = FakeLaunchd(self)
        self.patch_command = patch.object(lifecycle, "command", side_effect=self.fake)
        self.patch_command.start()
        self.addCleanup(self.patch_command.stop)
        self.patch_pid = patch.object(lifecycle, "pid_exists", return_value=False)
        self.patch_pid.start()
        self.addCleanup(self.patch_pid.stop)

    def with_watchdog(self):
        lifecycle.manage(self.layout, ["install-watchdog"])
        self.assertTrue(self.fake.recovery_loaded)

    def plist(self):
        return plistlib.loads(self.layout.plist.read_bytes())

    def test_operator_preflight_only_preserves_node_identity_and_session(self):
        before = self.layout.plist.read_bytes()
        lifecycle.manage(self.layout, ["plan", self.tag])
        self.assertEqual(self.layout.plist.read_bytes(), before)
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.fake.commands, [])
        self.assertEqual((Path(self.old_env)).read_text(), "PLACEHOLDER_SECRET_NOT_A_REAL_NODE_TOKEN\n")

    def test_verified_release_activates_with_new_pid_and_original_env(self):
        self.with_watchdog()
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertEqual(self.plist()["ProgramArguments"][1], str(self.release / lifecycle.ENTRYPOINT))
        self.assertEqual(self.plist()["WorkingDirectory"], str(self.release / "apps/node"))
        self.assertEqual(self.plist()["EnvironmentVariables"]["ATLAS_NODE_ENV_FILE"], self.old_env)
        self.assertEqual(self.layout.previous.read_bytes(), self.existing)
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.fake.pid, 12346)
        self.assertEqual(Path(self.old_env).read_text(), "PLACEHOLDER_SECRET_NOT_A_REAL_NODE_TOKEN\n")

    def test_rollback_restores_dev_checkout_and_keeps_old_release_as_previous(self):
        self.with_watchdog()
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        active = self.layout.plist.read_bytes()
        lifecycle.manage(self.layout, ["rollback", "--confirm"])
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertEqual(self.layout.previous.read_bytes(), active)
        self.assertFalse(self.layout.pending.exists())

    def test_activation_failure_automatically_recovers_original_launchagent(self):
        self.with_watchdog()
        original_wait = lifecycle.wait_connected
        checks = iter([False, True])
        with patch.object(lifecycle, "wait_connected", side_effect=lambda *a, **kw: next(checks)):
            with self.assertRaisesRegex(lifecycle.Refused, "did not confirm"):
                lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.fake.pid, 12347)

    def test_forced_process_death_persists_journal_for_watchdog(self):
        self.with_watchdog()
        original = lifecycle.cutover
        def interrupted(layout, content):
            # Kill after the durable journal and replacement plist, before
            # the new service can establish its connection.
            lifecycle.atomic_write(layout.plist, content)
            raise KeyboardInterrupt()
        with patch.object(lifecycle, "cutover", side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertTrue(self.layout.pending.exists())
        self.assertNotEqual(self.layout.plist.read_bytes(), self.existing)
        pending = json.loads(self.layout.pending.read_text())
        pending["started"] = time.time() - lifecycle.GRACE_SECONDS - 1
        lifecycle.json_write(self.layout.pending, pending)
        lifecycle.manage(self.layout, ["recover"])
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertFalse(self.layout.pending.exists())

    def test_interrupted_manual_rollback_completes_rollback_not_rejected_version(self):
        self.with_watchdog()
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        rejected = self.layout.plist.read_bytes()
        with patch.object(lifecycle, "cutover", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                lifecycle.manage(self.layout, ["rollback", "--confirm"])
        pending = json.loads(self.layout.pending.read_text())
        self.assertEqual(pending["action"], "rollback")
        pending["started"] = time.time() - lifecycle.GRACE_SECONDS - 1
        lifecycle.json_write(self.layout.pending, pending)
        lifecycle.manage(self.layout, ["recover"])
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertEqual(self.layout.previous.read_bytes(), rejected)
        self.assertFalse(self.layout.pending.exists())

    def test_stale_old_pid_status_never_counts_as_fresh_health(self):
        self.fake.pid += 1
        self.assertFalse(lifecycle.wait_connected(self.layout, 12345, time.time() - 1, timeout=0.01))

    def test_previous_node_must_exit_before_new_launchd_bootstrap(self):
        self.with_watchdog()
        with patch.object(lifecycle, "pid_exists", return_value=True), \
             patch.object(lifecycle.time, "sleep", return_value=None):
            with self.assertRaisesRegex(lifecycle.Refused, "still running"):
                lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        # The old process is outside launchd after bootout; attempting to
        # recover immediately must not create another copy of its identity.
        self.assertTrue(self.layout.pending.exists())
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertFalse(any(c[:2] == ("launchctl", "bootstrap") and
                             c[3] == str(self.layout.plist) for c in self.fake.commands))

    def test_pending_activation_prevents_second_update(self):
        self.with_watchdog()
        lifecycle.json_write(self.layout.pending, {
            "schema": 1, "action": "activate", "started": time.time(),
            "recoverPlist": "invalid", "recoverSha256": "0"*64,
        })
        with self.assertRaisesRegex(lifecycle.Refused, "Pending transaction"):
            lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])

    def test_bad_receipt_and_missing_watchdog_fail_before_bootout(self):
        with self.assertRaises(lifecycle.Refused):
            lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.with_watchdog()
        data = json.loads((self.release / ".atlas-signed-staging.json").read_text())
        data["source"] = "b" * 40
        (self.release / ".atlas-signed-staging.json").write_text(json.dumps(data))
        self.fake.commands.clear()
        with self.assertRaisesRegex(lifecycle.Refused, "Staged release"):
            lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertFalse(any(c[:2] == ("launchctl", "bootout") for c in self.fake.commands))

    def test_recovery_refuses_live_orphaned_original_pid(self):
        self.with_watchdog()
        original = lifecycle.cutover
        with patch.object(lifecycle, "cutover", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        pending = json.loads(self.layout.pending.read_text())
        pending["started"] = time.time() - lifecycle.GRACE_SECONDS - 1
        lifecycle.json_write(self.layout.pending, pending)
        self.fake.loaded = False  # bootout occurred but original PID lingers
        with patch.object(lifecycle, "pid_exists", return_value=True):
            with self.assertRaisesRegex(lifecycle.Refused, "still alive"):
                lifecycle.manage(self.layout, ["recover"])
        self.assertTrue(self.layout.pending.exists())

    def test_corrupt_recovery_journal_fails_closed(self):
        self.with_watchdog()
        self.layout.pending.write_text('{"action":"activate","recoverPlist":"bad"}')
        self.layout.pending.chmod(0o600)
        with self.assertRaises(lifecycle.Refused):
            lifecycle.manage(self.layout, ["recover"])
        self.assertTrue(self.layout.pending.exists())

    def test_requires_explicit_confirmation(self):
        self.with_watchdog()
        with self.assertRaisesRegex(lifecycle.Refused, "requires"):
            lifecycle.manage(self.layout, ["activate", self.tag])
        with self.assertRaisesRegex(lifecycle.Refused, "requires"):
            lifecycle.manage(self.layout, ["rollback"])


class AtlasControlGuardTests(unittest.TestCase):
    def test_old_control_manager_refuses_pending_lifecycle_and_release_owned_plist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            fake = bin_dir / "launchctl"
            fake.write_text("#!/bin/sh\nexit 0\n")
            fake.chmod(0o755)
            home = root / "home"
            home.mkdir()
            state = home / "Library/Application Support/Atlas/NodeSoftware/activation"
            state.mkdir(parents=True)
            pending = state / "pending.json"
            pending.write_text("{}")
            env = os.environ.copy()
            env.update({
                "ATLAS_CONTROL_TEST_ROOT": str(root),
                "ATLAS_CONTROL_TEST_PLATFORM": "darwin",
                "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
            })
            control = SCRIPT.parent / "atlas-control.mjs"
            for args in (["launchd", "install"], ["launchd", "uninstall"],
                         ["restart"], ["up"], ["down"]):
                with self.subTest(args=args):
                    result = subprocess.run(["node", str(control), *args],
                                            env=env, capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("pending recovery", result.stderr)
            pending.unlink()
            plist = home / "Library/LaunchAgents" / (lifecycle.LABEL + ".plist")
            plist.parent.mkdir(parents=True, exist_ok=True)
            plist.write_text("<string>" + lifecycle.LABEL + "</string>\\n"
                             "<string>/Users/test/Library/Application Support/Atlas/NodeSoftware/releases/v2.0.0-abcdefabcdef/apps/node/dist/platforms/desktop/main.js</string>\\n")
            result = subprocess.run(["node", str(control), "launchd", "install"],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("release-managed", result.stderr)


if __name__ == "__main__":
    unittest.main()
