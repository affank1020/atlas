"""Disposable macOS runner acceptance for the *real* check-only launchd job.

Unlike the Python lifecycle unit tests, this exercise calls launchctl for real,
boots a test-unique per-user LaunchAgent, executes the installed checkout-free
operator in that process, checks its private last-check result and boots it out.

The fixture is intentionally LOCAL and UNSIGNED. It is not evidence of signed
release staging, Node activation, reconnect, rollback, or a production rollout.
Only run on an isolated GitHub-hosted macOS runner with explicit CI opt-in.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/macos-node-operator.py"
spec = importlib.util.spec_from_file_location("atlas_real_mac_launchd_operator", SCRIPT)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)

# Never use production labels for a CI launchd probe. The run number is unique
# on the hosted runner; don't pass arbitrary strings into a launchctl target.
RUN_ID = os.environ.get("GITHUB_RUN_ID", "0")
if not RUN_ID.isdecimal() or len(RUN_ID) > 20:
    raise RuntimeError("Unsafe GitHub run ID for launchd test.")
TEST_LABEL = "com.affank1020.atlas.node.update-check.acceptance." + RUN_ID
TEST_RECOVERY_LABEL = "com.affank1020.atlas.node.recover.acceptance." + RUN_ID
VERSION = "v0.0.0-0000deadbeef"
COMMIT = "0000deadbeef" + "0" * 28


@unittest.skipUnless(
    sys.platform == "darwin"
    and os.environ.get("GITHUB_ACTIONS") == "true"
    and os.environ.get("RUNNER_OS") == "macOS"
    and os.environ.get("ATLAS_MACOS_LAUNCHD_SMOKE") == "1",
    "Real launchd acceptance requires explicit opt-in on an isolated hosted macOS runner",
)
class RealMacLaunchdCheckOnly(unittest.TestCase):
    def setUp(self):
        if os.geteuid() == 0:
            self.fail("Refusing launchd acceptance as root.")
        self.original_recovery_label = operator.lifecycle.RECOVERY_LABEL
        # Both smoke labels are different from any production Atlas service.
        # This is restored in cleanup_host even if an assertion fails.
        operator.lifecycle.RECOVERY_LABEL = TEST_RECOVERY_LABEL
        self.layout = operator.lifecycle.Layout(Path.home(), os.getuid())
        # This smoke necessarily uses the actual runner user's HOME because
        # the real launchd Python subprocess builds Layout(Path.home()) itself.
        # Never overwrite a pre-existing Atlas installation or Node identity.
        if self.layout.app.exists() or self.layout.app.is_symlink():
            operator.lifecycle.RECOVERY_LABEL = self.original_recovery_label
            self.fail("Host already contains Atlas NodeSoftware; refusing test setup.")
        if self.layout.plist.exists() or self.layout.plist.is_symlink():
            operator.lifecycle.RECOVERY_LABEL = self.original_recovery_label
            self.fail("Host already has an Atlas Node LaunchAgent; refusing test setup.")
        production_recovery = (
            Path.home() / "Library/LaunchAgents" /
            (self.original_recovery_label + ".plist")
        )
        if (production_recovery.exists() or production_recovery.is_symlink() or
            self.layout.recovery_plist.exists() or self.layout.recovery_plist.is_symlink()):
            operator.lifecycle.RECOVERY_LABEL = self.original_recovery_label
            self.fail("Host already has an Atlas recovery LaunchAgent; refusing test setup.")
        self.original_label = operator.CHECK_LABEL
        operator.CHECK_LABEL = TEST_LABEL
        self.test_logs_dir = Path.home() / "Library/Logs/Atlas"
        self.logs_dir_preexisting = self.test_logs_dir.exists()
        self.addCleanup(self.cleanup_host)
        if operator.lifecycle.launch_loaded(self.layout, operator.check_target(self.layout)):
            self.fail("A test-labelled LaunchAgent is already loaded; refusing takeover.")
        self.layout.releases.mkdir(parents=True, mode=0o700)
        self.layout.app.chmod(0o700)
        self.create_local_fixture()
        operator.initial_install(self.layout, VERSION)

    def create_local_fixture(self):
        release = self.layout.releases / VERSION
        release.mkdir(mode=0o700)
        scripts = release / "scripts"
        scripts.mkdir(mode=0o700)
        hashes = {}
        for name in operator.FILES:
            data = (ROOT / "scripts" / name).read_bytes()
            (scripts / name).write_bytes(data)
            hashes["scripts/" + name] = hashlib.sha256(data).hexdigest()
        for name in (
            operator.lifecycle.ENTRYPOINT, "apps/node/package.json",
            "package-lock.json",
        ):
            path = release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("LOCAL TEST FIXTURE, NOT A SIGNED RELEASE\n")
        (release / "atlas-node-release.json").write_text(json.dumps({
            "application": "@atlas/node",
            "version": "0.0.0",
            "commit": COMMIT,
            "protocol": 2,
            "entrypoint": operator.lifecycle.ENTRYPOINT,
            "supportedHosts": ["darwin"],
            "operatorScripts": hashes,
        }))
        (release / ".atlas-signed-staging.json").write_text(json.dumps({
            "schema": 1,
            "tag": "node-" + VERSION,
            "source": COMMIT,
            "verification": "signed-github-build-provenance",
            "archiveSha256": "0" * 64,
        }))
        # Receipt/metadata are locally manufactured by this disposable test.
        # Their content must not be reused to assert Sigstore verification.

    def cleanup_host(self):
        try:
            operator.CHECK_LABEL = TEST_LABEL
            for label, path in (
                (operator.check_target(self.layout), operator.check_paths(self.layout)[0]),
                (self.layout.recovery_target, self.layout.recovery_plist),
            ):
                if operator.lifecycle.launch_loaded(self.layout, label):
                    # Both labels are generated uniquely for this runner job.
                    operator.lifecycle.command("launchctl", "bootout", label)
                if operator.lifecycle.launch_loaded(self.layout, label):
                    self.fail("Acceptance LaunchAgent is still loaded; preserving fixture.")
                if path.exists() or path.is_symlink():
                    path.unlink()
            if self.layout.app.exists() and not self.layout.app.is_symlink():
                shutil.rmtree(self.layout.app)
            if not self.logs_dir_preexisting and self.test_logs_dir.is_dir():
                shutil.rmtree(self.test_logs_dir)
        finally:
            operator.CHECK_LABEL = self.original_label
            operator.lifecycle.RECOVERY_LABEL = self.original_recovery_label

    def test_actual_launchctl_check_only_bootstrap_run_and_bootout(self):
        # No real Node plist is installed at any point in this test.
        self.assertFalse(self.layout.plist.exists())
        self.assertFalse(self.layout.recovery_plist.exists())
        operator.enable_check(self.layout)
        self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "enabled")

        plist, record = operator.check_paths(self.layout)
        launchd = plistlib.loads(plist.read_bytes())
        self.assertEqual(launchd["Label"], TEST_LABEL)
        self.assertEqual(launchd["StartInterval"], 3600)
        self.assertEqual(launchd["ProgramArguments"][-1], "check-background")
        self.assertNotIn("EnvironmentVariables", launchd)

        # The genuine launchd RunAtLoad job must execute the signed-style
        # checked-out-independent operator. No Node plist exists, so the
        # expected outcome is *unavailable*, never current/updated.
        deadline = time.monotonic() + 35
        while not record.exists() and time.monotonic() < deadline:
            time.sleep(0.25)
        self.assertTrue(record.exists(), "Real launchd checker never wrote its private result.")
        contents = record.read_text()
        result = json.loads(contents)
        self.assertEqual(result["schema"], 1)
        self.assertEqual(result["state"], "unavailable")
        self.assertEqual(result["reason"], "catalogue-or-node-unavailable")
        self.assertNotIn("verification", result)
        self.assertEqual(record.stat().st_mode & 0o077, 0)
        self.assertNotIn(str(self.layout.home), contents)
        self.assertFalse(self.layout.plist.exists())
        self.assertFalse(self.layout.pending.exists())

        # Exercise a separate Python process from the installed pointer.
        # The test-only label is patched only in this harness; the child
        # script deliberately retains the production label, so don't ask
        # that subprocess to inspect the test label.
        installed_script = operator.paths(self.layout)[1] / "macos-node-operator.py"
        independent = subprocess.run(
            [sys.executable, str(installed_script), "status"],
            check=True, capture_output=True, text=True, timeout=15
        )
        self.assertEqual(json.loads(independent.stdout)["installedOperator"], VERSION)
        self.assertEqual(operator.installed_check_status(self.layout)["lastCheck"]["state"],
                         "unavailable")

        operator.disable_check(self.layout)
        self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "disabled")
        self.assertFalse(plist.exists())
        self.assertFalse(self.layout.plist.exists())
        self.assertFalse(self.layout.recovery_plist.exists())


    def test_actual_launchctl_checker_recovers_from_unloaded_job(self):
        # A per-user job may disappear after logout or an abnormal launchd
        # event while its valid plist remains. Status must report attention,
        # and an explicit enable should rebootstrap that known job.
        operator.enable_check(self.layout)
        self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "enabled")
        operator.lifecycle.command(
            "launchctl", "bootout", operator.check_target(self.layout)
        )
        self.assertEqual(operator.installed_check_status(self.layout)["schedule"],
                         "needs-attention")
        operator.enable_check(self.layout)
        self.assertEqual(operator.installed_check_status(self.layout)["schedule"], "enabled")
        operator.disable_check(self.layout)
        self.assertFalse(operator.check_paths(self.layout)[0].exists())
        self.assertFalse(self.layout.plist.exists())

    def test_actual_launchctl_recovery_watchdog_bootstrap_and_bootout(self):
        # Probe the actual watchdog's known per-user launchd shape, without
        # installing or restarting a Node service. With no pending journal,
        # the real watchdog process performs only its safe no-op recover.
        operator.lifecycle.manage(self.layout, ["install-watchdog"])
        operator.lifecycle.require_watchdog(self.layout)
        self.assertTrue(
            operator.lifecycle.launch_loaded(self.layout, self.layout.recovery_target)
        )
        self.assertFalse(self.layout.plist.exists())
        self.assertFalse(self.layout.pending.exists())

        job = plistlib.loads(self.layout.recovery_plist.read_bytes())
        self.assertEqual(job["Label"], TEST_RECOVERY_LABEL)
        self.assertEqual(job["StartInterval"], 60)
        self.assertEqual(job["ProgramArguments"][-1], "recover")
        self.assertEqual(
            job["ProgramArguments"][1], str(self.layout.recovery_script)
        )
        self.assertEqual(
            self.layout.recovery_script.read_bytes(),
            (ROOT / "scripts/macos-node-lifecycle.py").read_bytes(),
        )
        self.assertEqual(self.layout.recovery_script.stat().st_mode & 0o077, 0)

        # Verify the real launchd job can be unloaded, without stopping a Node
        # (there is deliberately no Node process or runtime LaunchAgent).
        operator.lifecycle.command("launchctl", "bootout", self.layout.recovery_target)
        self.assertFalse(
            operator.lifecycle.launch_loaded(self.layout, self.layout.recovery_target)
        )
        self.assertFalse(self.layout.plist.exists())
        self.assertFalse(self.layout.pending.exists())


if __name__ == "__main__":
    unittest.main()
