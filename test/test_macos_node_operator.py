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
from types import SimpleNamespace

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

    def fake_check_service(self):
        """Real job plist/fs operations, fake *only* launchctl."""
        self.check_loaded = False
        self.check_commands = []
        def command(*args, capture=False):
            self.check_commands.append(args)
            if args == ("launchctl", "print", operator.check_target(self.layout)):
                if self.check_loaded:
                    return "state = waiting\n"
                raise subprocess.CalledProcessError(113, args)
            if args == ("launchctl", "bootstrap", f"gui/{self.layout.uid}",
                        str(operator.check_paths(self.layout)[0])):
                self.check_loaded = True
                return ""
            if args == ("launchctl", "bootout", operator.check_target(self.layout)):
                self.check_loaded = False
                return ""
            raise AssertionError(f"Unexpected or mutating host command: {args}")
        return patch.object(operator.lifecycle, "command", side_effect=command)

    def test_scheduled_checker_enable_status_disable_is_read_only_for_node(self):
        operator.initial_install(self.layout, self.version1)
        with self.fake_check_service():
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "disabled")
            operator.enable_check(self.layout)
            plist = operator.check_paths(self.layout)[0]
            self.assertTrue(plist.is_file())
            self.assertEqual(plist.stat().st_mode & 0o077, 0)
            schedule = plistlib.loads(plist.read_bytes())
            self.assertEqual(schedule["Label"], operator.CHECK_LABEL)
            self.assertEqual(schedule["StartInterval"], 3600)
            self.assertEqual(schedule["ProgramArguments"][1:],
                             [str(self.layout.app / "operator/current/macos-node-operator.py"),
                              "check-background"])
            self.assertNotIn("EnvironmentVariables", schedule)
            self.assertNotIn("StandardOutPath", schedule)
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "enabled")
            operator.enable_check(self.layout)
            operator.disable_check(self.layout)
            self.assertFalse(plist.exists())
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "disabled")
            operator.disable_check(self.layout)
        self.assertEqual(self.check_commands.count(
            ("launchctl", "bootstrap", f"gui/{self.layout.uid}",
             str(operator.check_paths(self.layout)[0]))), 1)
        self.assertEqual(self.check_commands.count(
            ("launchctl", "bootout", operator.check_target(self.layout))), 1)
        self.assertFalse(self.layout.pending.exists())
        self.assertFalse(self.layout.watchdog_refresh.exists())

    def test_schedule_never_overwrites_unknown_plist_or_loaded_job(self):
        operator.initial_install(self.layout, self.version1)
        plist, _ = operator.check_paths(self.layout)
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(plistlib.dumps({
            "Label": operator.CHECK_LABEL,
            "ProgramArguments": [sys.executable, "/tmp/untrusted.py", "run"],
            "RunAtLoad": True, "StartInterval": 3600,
        }))
        with self.fake_check_service():
            with self.assertRaisesRegex(operator.Refused, "Unexpected release-checker job"):
                operator.enable_check(self.layout)
        self.assertIn(b"/tmp/untrusted.py", plist.read_bytes())

        plist.unlink()
        with self.fake_check_service():
            self.check_loaded = True
            with self.assertRaisesRegex(operator.Refused, "Unrecognized loaded"):
                operator.enable_check(self.layout)
            with self.assertRaisesRegex(operator.Refused, "Unrecognized loaded"):
                operator.disable_check(self.layout)

    def test_missing_python_interpreter_allows_safe_disable_and_reenable(self):
        operator.initial_install(self.layout, self.version1)
        with self.fake_check_service():
            operator.enable_check(self.layout)
            plist, _ = operator.check_paths(self.layout)
            content = plistlib.loads(plist.read_bytes())
            content["ProgramArguments"][0] = str(self.layout.home / "removed-python3")
            plist.write_bytes(plistlib.dumps(content))
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"],
                             "needs-attention")
            with self.assertRaisesRegex(operator.Refused, "Python interpreter is missing"):
                operator.enable_check(self.layout)
            operator.disable_check(self.layout)
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"],
                             "disabled")
            operator.enable_check(self.layout)
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"],
                             "enabled")
        self.assertEqual(plistlib.loads(plist.read_bytes())["ProgramArguments"][0],
                         sys.executable)

    def test_missing_launchd_session_is_needs_attention_not_enabled(self):
        operator.initial_install(self.layout, self.version1)
        with self.fake_check_service():
            operator.enable_check(self.layout)
            self.check_loaded = False
            self.assertEqual(operator.installed_check_status(self.layout)["schedule"],
                             "needs-attention")

    def mock_updater_discover(self, discover):
        """Inject the selected signed module's discovery without public network."""
        class Loader:
            def exec_module(self, module):
                module.discover = discover
        mock_spec = SimpleNamespace(loader=Loader())
        return patch.object(operator.importlib.util, "spec_from_file_location",
                            return_value=mock_spec)

    def test_background_checker_persists_candidate_only_without_identity_or_install(self):
        operator.initial_install(self.layout, self.version1)
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), self.mock_updater_discover(lambda _: {
            "state": "available",
            "installed": self.version1,
            "candidate": "node-" + self.version2,
            "currentEntrypoint": "/sensitive/local/workspace",
            "launchdPid": 7654,
        }), patch.object(operator.importlib.util, "module_from_spec",
                          return_value=SimpleNamespace()):
            operator.background_check(self.layout)
        saved = json.loads(operator.check_paths(self.layout)[1].read_text())
        self.assertEqual(saved["state"], "available")
        self.assertEqual(saved["candidate"], "node-" + self.version2)
        self.assertEqual(saved["verification"], "catalogue-only")
        self.assertNotIn("launchdPid", saved)
        self.assertNotIn("currentEntrypoint", saved)
        self.assertEqual(operator.check_paths(self.layout)[1].stat().st_mode & 0o077, 0)

    def test_background_checker_reports_offline_and_pending_without_fake_success(self):
        operator.initial_install(self.layout, self.version1)
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), self.mock_updater_discover(lambda _: (_ for _ in ()).throw(
            OSError("private path /Users/test/.env.node")
        )), patch.object(operator.importlib.util, "module_from_spec",
                         return_value=SimpleNamespace()):
            operator.background_check(self.layout)
        record = operator.check_paths(self.layout)[1]
        data = json.loads(record.read_text())
        self.assertEqual(data["state"], "unavailable")
        self.assertNotIn("private path", record.read_text())
        self.layout.pending.parent.mkdir(parents=True, exist_ok=True)
        self.layout.pending.write_text("{}")
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), patch.object(operator.importlib.util, "spec_from_file_location",
                         side_effect=AssertionError("Must not query while recovering")):
            operator.background_check(self.layout)
        self.assertEqual(json.loads(record.read_text())["state"], "needs-attention")

    def test_background_checker_discards_candidate_when_operator_changes_midflight(self):
        operator.initial_install(self.layout, self.version1)
        selected = self.first / "scripts"
        changed = self.second / "scripts"
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), patch.object(
            operator, "current_target", side_effect=[selected, changed]
        ), self.mock_updater_discover(lambda _: {
            "state": "available",
            "installed": self.version1,
            "candidate": "node-" + self.version2,
        }), patch.object(operator.importlib.util, "module_from_spec",
                         return_value=SimpleNamespace()):
            operator.background_check(self.layout)
        result = json.loads(operator.check_paths(self.layout)[1].read_text())
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["reason"], "operator-changed-during-check")
        self.assertNotIn("candidate", result)

    def test_checker_publication_blocks_promotion_at_exact_write_boundary(self):
        """Reproduce the reviewer's check-then-write race deterministically.

        The competing promoter tries to acquire the lifecycle lock *inside*
        the final release-check observation write. Without the lock held by
        background_check, it would switch the operator before the old result
        is written; with the lock, it must fail closed and can retry later.
        """
        operator.initial_install(self.layout, self.version1)
        record = operator.check_paths(self.layout)[1]
        real_write = operator.lifecycle.atomic_write
        interleaving = []

        def attempt_promote_at_publish(path, content):
            if path == record:
                try:
                    with operator.lifecycle.lock_state(self.layout):
                        with patch.object(operator, "align_recovery_watchdog"):
                            operator.promote(self.layout, self.version2,
                                             require_existing=True)
                    interleaving.append("promoted-before-write")
                except BlockingIOError:
                    interleaving.append("promotion-blocked-by-checker-lock")
            return real_write(path, content)

        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), self.mock_updater_discover(lambda _: {
            "state": "available",
            "installed": self.version1,
            "candidate": "node-" + self.version2,
        }), patch.object(operator.importlib.util, "module_from_spec",
                         return_value=SimpleNamespace()), patch.object(
            operator.lifecycle, "atomic_write", side_effect=attempt_promote_at_publish
        ):
            operator.background_check(self.layout)

        self.assertEqual(interleaving, ["promotion-blocked-by-checker-lock"])
        self.assertEqual(operator.current_target(self.layout), self.first / "scripts")
        result = json.loads(record.read_text())
        self.assertEqual(result["state"], "available")
        self.assertEqual(result["installed"], self.version1)

        # The pending promotion is legal only after publication's lock exits.
        with operator.lifecycle.lock_state(self.layout):
            with patch.object(operator, "align_recovery_watchdog"):
                operator.promote(self.layout, self.version2, require_existing=True)
        self.assertEqual(operator.current_target(self.layout), self.second / "scripts")

    def test_checker_discovers_without_holding_node_lifecycle_lock(self):
        operator.initial_install(self.layout, self.version1)
        checks = []
        def discover(_):
            with operator.lifecycle.lock_state(self.layout):
                checks.append("public-catalogue-read-happened-unlocked")
            return {"state": "available", "installed": self.version1,
                    "candidate": "node-" + self.version2}

        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), self.mock_updater_discover(discover), patch.object(
            operator.importlib.util, "module_from_spec",
            return_value=SimpleNamespace()
        ):
            operator.background_check(self.layout)
        self.assertEqual(checks, ["public-catalogue-read-happened-unlocked"])

    def test_background_checker_refuses_mutated_signed_source_and_result_symlink(self):
        operator.initial_install(self.layout, self.version1)
        path = operator.check_paths(self.layout)[1]
        path.symlink_to(Path(self.temp.name) / "unknown")
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )), self.mock_updater_discover(lambda _: {
            "state": "current", "installed": self.version1,
            "candidate": "node-" + self.version1,
        }), patch.object(operator.importlib.util, "module_from_spec",
                          return_value=SimpleNamespace()):
            with self.assertRaisesRegex(operator.Refused, "symlinked"):
                operator.background_check(self.layout)
        path.unlink()
        (self.first / "scripts/macos-node-update.py").write_text("tampered")
        with patch.object(operator, "__file__", str(
            self.first / "scripts/macos-node-operator.py"
        )):
            with self.assertRaisesRegex(operator.Refused, "digest mismatch"):
                operator.background_check(self.layout)
        self.assertFalse(path.exists())

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
