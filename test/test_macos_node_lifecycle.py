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
import shutil
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
        self.fail_watchdog_bootstrap = False
        self.fail_watchdog_bootstrap_once = False
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
            if args[2] == self.test.layout.recovery_target:
                self.recovery_loaded = False
            else:
                self.loaded = False
            return ""
        if args[:2] == ("launchctl", "bootstrap"):
            if args[3] == str(self.test.layout.recovery_plist):
                if self.fail_watchdog_bootstrap or self.fail_watchdog_bootstrap_once:
                    self.fail_watchdog_bootstrap_once = False
                    raise subprocess.CalledProcessError(5, args)
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

    def test_pid_disappears_after_preflight_no_unrecoverable_journal(self):
        self.with_watchdog()
        commands_before = len(self.fake.commands)
        with patch.object(lifecycle, "launch_pid", side_effect=[12345, None]):
            with self.assertRaisesRegex(lifecycle.Refused, "exited before activation"):
                lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.layout.plist.read_bytes(), self.existing)
        self.assertFalse(any(cmd[:2] == ("launchctl", "bootout")
                             for cmd in self.fake.commands[commands_before:]))
        # A subsequent legitimate activation may proceed without repairing a
        # malformed journal; the watchdog is still installed and loaded.
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.plist()["ProgramArguments"][1],
                         str(self.release / lifecycle.ENTRYPOINT))

    def test_refresh_watchdog_upgrades_loaded_old_script_without_changing_node(self):
        self.with_watchdog()
        old_plist = self.layout.plist.read_bytes()
        old_pid = self.fake.pid
        self.layout.recovery_script.write_bytes(b"#!/usr/bin/env python3\n# previous reviewed watchdog\n")
        self.fake.commands.clear()
        lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertEqual(self.layout.recovery_script.read_bytes(), SCRIPT.read_bytes())
        self.assertEqual(self.layout.plist.read_bytes(), old_plist)
        self.assertEqual(self.fake.pid, old_pid)
        self.assertFalse(self.layout.watchdog_refresh.exists())
        self.assertIn(("launchctl", "bootout", self.layout.recovery_target), self.fake.commands)
        self.assertIn(("launchctl", "bootstrap", f"gui/{self.layout.uid}",
                       str(self.layout.recovery_plist)), self.fake.commands)

    def test_refresh_watchdog_bootstrap_failure_restores_previous_loaded_watchdog(self):
        self.with_watchdog()
        prior = b"#!/usr/bin/env python3\n# previous reviewed watchdog\n"
        self.layout.recovery_script.write_bytes(prior)
        old_plist = self.layout.recovery_plist.read_bytes()
        old_node = self.layout.plist.read_bytes()
        self.fake.fail_watchdog_bootstrap_once = True
        with self.assertRaises(subprocess.CalledProcessError):
            lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertEqual(self.layout.recovery_script.read_bytes(), prior)
        self.assertEqual(self.layout.recovery_plist.read_bytes(), old_plist)
        self.assertEqual(self.layout.plist.read_bytes(), old_node)
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_refresh_watchdog_verification_failure_restores_previous_watcher(self):
        self.with_watchdog()
        prior = b"#!/usr/bin/env python3\n# old watchdog source\n"
        self.layout.recovery_script.write_bytes(prior)
        old_plist = self.layout.recovery_plist.read_bytes()
        with patch.object(lifecycle, "require_watchdog",
                          side_effect=lifecycle.Refused("simulated post-bootstrap mismatch")):
            with self.assertRaisesRegex(lifecycle.Refused, "post-bootstrap mismatch"):
                lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertEqual(self.layout.recovery_script.read_bytes(), prior)
        self.assertEqual(self.layout.recovery_plist.read_bytes(), old_plist)
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_refresh_watchdog_rejects_unexpected_old_plist_without_bootout(self):
        self.with_watchdog()
        plist = plistlib.loads(self.layout.recovery_plist.read_bytes())
        plist["ProgramArguments"][1] = "/tmp/not-atlas-recovery.py"
        self.layout.recovery_plist.write_bytes(plistlib.dumps(plist))
        self.fake.commands.clear()
        with self.assertRaisesRegex(lifecycle.Refused, "not the expected per-user job"):
            lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertFalse(any(cmd[:2] == ("launchctl", "bootout") for cmd in self.fake.commands))
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_refresh_watchdog_rejects_pending_node_recovery(self):
        self.with_watchdog()
        self.layout.recovery_script.write_bytes(b"old script")
        self.layout.pending.write_text("{}")
        self.fake.commands.clear()
        with self.assertRaisesRegex(lifecycle.Refused, "Node activation recovery is pending"):
            lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertFalse(any(cmd[:2] == ("launchctl", "bootout") for cmd in self.fake.commands))

    def test_refresh_watchdog_rejects_without_explicit_confirmation(self):
        self.with_watchdog()
        self.fake.commands.clear()
        with self.assertRaisesRegex(lifecycle.Refused, "require --confirm"):
            lifecycle.manage(self.layout, ["refresh-watchdog"])
        self.assertFalse(any(cmd[:2] == ("launchctl", "bootout") for cmd in self.fake.commands))

    def test_interrupted_watchdog_replacement_can_be_restored(self):
        self.with_watchdog()
        old_script = b"#!/usr/bin/env python3\n# old watchdog\n"
        self.layout.recovery_script.write_bytes(old_script)
        old_plist = self.layout.recovery_plist.read_bytes()
        old_node = self.layout.plist.read_bytes()
        original_stop = lifecycle.stop_watchdog

        def killed_after_bootout(layout):
            original_stop(layout)
            raise SystemExit("simulated updater SIGKILL after watchdog bootout")

        with patch.object(lifecycle, "stop_watchdog", side_effect=killed_after_bootout):
            with self.assertRaises(SystemExit):
                lifecycle.manage(self.layout, ["refresh-watchdog", "--confirm"])
        self.assertFalse(self.fake.recovery_loaded)
        self.assertTrue(self.layout.watchdog_refresh.exists())
        with self.assertRaisesRegex(lifecycle.Refused, "upgrade is pending"):
            lifecycle.require_watchdog(self.layout)
        with self.assertRaisesRegex(lifecycle.Refused, "restored before installation"):
            lifecycle.manage(self.layout, ["install-watchdog"])
        lifecycle.manage(self.layout, ["restore-watchdog", "--confirm"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertEqual(self.layout.recovery_script.read_bytes(), old_script)
        self.assertEqual(self.layout.recovery_plist.read_bytes(), old_plist)
        self.assertEqual(self.layout.plist.read_bytes(), old_node)
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_watchdog_bootstrap_failure_can_retry_existing_identical_files(self):
        self.fake.fail_watchdog_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            lifecycle.manage(self.layout, ["install-watchdog"])
        self.assertFalse(self.fake.recovery_loaded)
        self.assertTrue(self.layout.recovery_plist.is_file())
        self.assertTrue(self.layout.recovery_script.is_file())
        old_plist = self.layout.recovery_plist.read_bytes()
        old_script = self.layout.recovery_script.read_bytes()
        self.fake.fail_watchdog_bootstrap = False
        lifecycle.manage(self.layout, ["install-watchdog"])
        self.assertTrue(self.fake.recovery_loaded)
        self.assertEqual(self.layout.recovery_plist.read_bytes(), old_plist)
        self.assertEqual(self.layout.recovery_script.read_bytes(), old_script)
        self.assertFalse(self.layout.pending.exists())

    def test_watchdog_retry_refuses_modified_unloaded_files(self):
        self.fake.fail_watchdog_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            lifecycle.manage(self.layout, ["install-watchdog"])
        self.fake.fail_watchdog_bootstrap = False
        self.layout.recovery_plist.write_bytes(b"changed")
        self.fake.commands.clear()
        with self.assertRaisesRegex(lifecycle.Refused, "differs"):
            lifecycle.manage(self.layout, ["install-watchdog"])
        self.assertFalse(any(c[:2] == ("launchctl", "bootstrap") for c in self.fake.commands))
        self.assertEqual(self.layout.recovery_plist.read_bytes(), b"changed")

    def test_operator_preflight_only_preserves_node_identity_and_session(self):
        before = self.layout.plist.read_bytes()
        lifecycle.manage(self.layout, ["plan", self.tag])
        self.assertEqual(self.layout.plist.read_bytes(), before)
        self.assertFalse(self.layout.pending.exists())
        self.assertEqual(self.fake.commands, [])
        self.assertEqual((Path(self.old_env)).read_text(), "PLACEHOLDER_SECRET_NOT_A_REAL_NODE_TOKEN\n")

    def test_pinned_entrypoint_refuses_racing_manager_before_cutover(self):
        self.with_watchdog()
        before = self.layout.plist.read_bytes()
        before_count = len(self.fake.commands)
        with self.assertRaisesRegex(lifecycle.Refused, "changed since update confirmation"):
            lifecycle.manage(self.layout, ["activate", self.tag, "--confirm",
                                           "--expect-entrypoint", "/other/checkout/main.js"])
        self.assertEqual(self.layout.plist.read_bytes(), before)
        self.assertFalse(self.layout.pending.exists())
        self.assertFalse(any(cmd[:2] == ("launchctl", "bootout")
                             for cmd in self.fake.commands[before_count:]))
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm",
                                       "--expect-entrypoint", str(self.home / "Documents/Atlas" / lifecycle.ENTRYPOINT)])
        self.assertEqual(self.plist()["ProgramArguments"][1], str(self.release / lifecycle.ENTRYPOINT))

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

    def test_crash_after_previous_pointer_write_restores_old_pointer(self):
        self.with_watchdog()
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        first_running = self.layout.plist.read_bytes()
        old_previous = self.layout.previous.read_bytes()
        new_tag = "v2.0.0-" + "b" * 12
        new_source = "b" * 40
        second = self.layout.releases / new_tag
        shutil.copytree(self.release, second)
        manifest = json.loads((second / "atlas-node-release.json").read_text())
        manifest["commit"] = new_source
        (second / "atlas-node-release.json").write_text(json.dumps(manifest))
        receipt = json.loads((second / ".atlas-signed-staging.json").read_text())
        receipt["source"], receipt["tag"] = new_source, "node-" + new_tag
        (second / ".atlas-signed-staging.json").write_text(json.dumps(receipt))
        with patch.object(lifecycle, "clear_pending", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                lifecycle.manage(self.layout, ["activate", new_tag, "--confirm"])
        self.assertNotEqual(self.layout.plist.read_bytes(), first_running)
        self.assertEqual(self.layout.previous.read_bytes(), first_running)
        pending = json.loads(self.layout.pending.read_text())
        pending["started"] = time.time() - lifecycle.GRACE_SECONDS - 1
        lifecycle.json_write(self.layout.pending, pending)
        lifecycle.manage(self.layout, ["recover"])
        self.assertEqual(self.layout.plist.read_bytes(), first_running)
        self.assertEqual(self.layout.previous.read_bytes(), old_previous)
        self.assertFalse(self.layout.pending.exists())

    def test_repeated_activation_of_same_release_refuses_restart(self):
        self.with_watchdog()
        lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        before = len(self.fake.commands)
        with self.assertRaisesRegex(lifecycle.Refused, "already active"):
            lifecycle.manage(self.layout, ["activate", self.tag, "--confirm"])
        self.assertFalse(any(c[:2] == ("launchctl", "bootout") for c in self.fake.commands[before:]))

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
    def test_development_install_build_serializes_activation_across_processes(self):
        # Start a REAL atlas-control.mjs CLI, pause its npm build and attempt
        # a competing Python activation while it is in flight. Neither tool
        # touches the real user's launchd or Node.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            entry = repo / lifecycle.ENTRYPOINT
            entry.parent.mkdir(parents=True)
            entry.write_text("// simulated precompiled Node")
            config = repo / "apps/node/.env.node"
            config.write_text("ATLAS_SERVER_URL=wss://example.test/node/connect\n")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            build_started = root / "build-started"
            build_continue = root / "build-continue"
            loaded = root / "launch-loaded"
            fake_npm = bin_dir / "npm"
            fake_npm.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, time\n"
                "pathlib.Path(os.environ['TEST_BUILD_STARTED']).touch()\n"
                "deadline = time.monotonic() + 15\n"
                "while not pathlib.Path(os.environ['TEST_BUILD_CONTINUE']).exists():\n"
                "    if time.monotonic() > deadline: raise SystemExit(1)\n"
                "    time.sleep(0.025)\n"
            )
            fake_npm.chmod(0o755)
            fake_launchctl = bin_dir / "launchctl"
            fake_launchctl.write_text(
                "#!/bin/sh\n"
                "if [ \"$1\" = print ]; then\n"
                "    if [ -f \"$TEST_LAUNCH_LOADED\" ]; then\n"
                "        printf 'state = running\\npid = 54321\\n'\n"
                "        exit 0\n"
                "    fi\n"
                "    exit 1\n"
                "fi\n"
                "if [ \"$1\" = bootstrap ]; then touch \"$TEST_LAUNCH_LOADED\"; exit 0; fi\n"
                "exit 0\n"
            )
            fake_launchctl.chmod(0o755)
            env = os.environ.copy()
            env.update({
                "ATLAS_CONTROL_TEST_ROOT": str(root),
                "ATLAS_CONTROL_TEST_PLATFORM": "darwin",
                "PATH": str(bin_dir) + os.pathsep + env.get("PATH", ""),
                "TEST_BUILD_STARTED": str(build_started),
                "TEST_BUILD_CONTINUE": str(build_continue),
                "TEST_LAUNCH_LOADED": str(loaded),
            })
            control = SCRIPT.parent / "atlas-control.mjs"
            proc = subprocess.Popen(["node", str(control), "launchd", "install"],
                                    env=env, text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 12
                while not build_started.exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.025)
                self.assertTrue(build_started.exists(), "installer never reached its paused npm build")
                layout = lifecycle.Layout(root / "home", os.getuid())
                # Under the old implementation this would acquire the lock
                # while atlasctl is building and could switch the Node.
                with self.assertRaises(BlockingIOError):
                    lifecycle.manage(layout, ["activate", "v2.0.0-" + "a" * 12, "--confirm"])
            finally:
                build_continue.touch()
                try:
                    stdout, stderr = proc.communicate(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    stdout, stderr = proc.communicate(timeout=5)
                    raise
            self.assertEqual(proc.returncode, 0, stderr + stdout)
            self.assertTrue(loaded.exists())
            self.assertTrue(layout.plist.exists())
            # The lock is now released for the separately confirmed lifecycle.
            with lifecycle.lock_state(layout):
                self.assertFalse(layout.pending.exists())

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
            state.chmod(0o700)
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
