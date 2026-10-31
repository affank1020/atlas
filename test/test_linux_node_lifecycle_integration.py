"""Disposable Linux lifecycle acceptance tests, using the REAL bash lifecycle.

The mocked systemctl/npm commands act only on temporary releases and an
isolated heartbeat file. This is a non-privileged integration test, NOT proof
of Sigstore provenance, host-root authorization or a live systemd installation.
Those additional host-level gates are documented in LINUX_NODE_LIFECYCLE.md.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/linux-node-lifecycle.sh"
ENTRYPOINT = "apps/node/dist/platforms/desktop/main.js"
SHA = ("1" * 40, "2" * 40, "3" * 40)
RELEASES = tuple("v2.0.0-" + commit[:12] for commit in SHA)

# Run the real lifecycle shell script while replacing ONLY external service
# management and npm dependency inspection. A restart generates the private
# heartbeat that the lifecycle independently checks against MainPID. The
# optional hard kill simulates the invoking SSH/updater process disappearing.
FAKE_SYSTEMCTL = r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import signal
import sys

args = sys.argv[1:]
root = Path(os.environ["ATLAS_LIFECYCLE_ROOT"])
status = Path(os.environ["ATLAS_LIFECYCLE_STATUS_FILE"])
history = Path(os.environ["FAKE_SYSTEMCTL_HISTORY"])
pid = int(os.environ["FAKE_SYSTEMCTL_PID"])
if args[:1] == ["is-active"]:
    if "--quiet" not in args:
        print("active")
    sys.exit(0)
if args[:1] == ["show"]:
    if args != ["show", "atlas-node", "-p", "MainPID", "--value"]:
        sys.exit(20)
    print(pid)
    sys.exit(0)
if args == ["restart", "atlas-node"]:
    current = (root / "current").resolve(strict=True).name
    with history.open("a", encoding="utf-8") as log:
        log.write("restart:" + current + "\n")
    if current == os.environ.get("FAKE_KILL_ON"):
        # Durable journal and symlink must already exist at this point.
        os.kill(os.getppid(), signal.SIGKILL)
        sys.exit(21)
    state = "disconnected" if current == os.environ.get("FAKE_FAIL_ON") else "connected"
    status.parent.mkdir(parents=True, exist_ok=True)
    status.write_text(json.dumps({"state": state, "pid": pid}))
    sys.exit(0)
print("Unexpected mock systemctl invocation", args, file=sys.stderr)
sys.exit(22)
'''

FAKE_NPM = """#!/bin/sh
# The lifecycle checks dependency completeness before starting a release.
# This isolated test validates that check's ordering, not npm dependency data.
test "$1" = ls && test "$2" = --omit=dev && test "$3" = --depth=0
"""


class DisposableHost(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-lifecycle-acceptance-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "node"
        self.releases = self.root / "releases"
        self.releases.mkdir(parents=True)
        self.bin = Path(self.temp.name) / "bin"
        self.bin.mkdir()
        self.status = Path(self.temp.name) / "state" / "node-status.json"
        self.status.parent.mkdir()
        self.status.write_text(json.dumps({"state": "connected", "pid": 4242}))
        self.history = Path(self.temp.name) / "restart-history"
        self.history.write_text("")
        for commit, name in zip(SHA, RELEASES):
            self._make_release(commit, name)
        (self.root / "current").symlink_to(self.releases / RELEASES[0])
        self._fake_binary("systemctl", FAKE_SYSTEMCTL)
        self._fake_binary("npm", FAKE_NPM)
        self.env = os.environ.copy()
        self.env.update({
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "ATLAS_LIFECYCLE_ROOT": str(self.root),
            "ATLAS_LIFECYCLE_STATUS_FILE": str(self.status),
            "ATLAS_LIFECYCLE_LOCK_FILE": str(Path(self.temp.name) / "lifecycle.lock"),
            "ATLAS_LIFECYCLE_TIMEOUT": "1",
            "FAKE_SYSTEMCTL_HISTORY": str(self.history),
            "FAKE_SYSTEMCTL_PID": "4242",
        })
        for name in ("FAKE_FAIL_ON", "FAKE_KILL_ON"):
            self.env.pop(name, None)

    def _fake_binary(self, name, body):
        target = self.bin / name
        target.write_text(body)
        target.chmod(0o755)

    def _make_release(self, commit, name):
        base = self.releases / name
        (base / "apps/node/dist/platforms/desktop").mkdir(parents=True)
        (base / "node_modules/ws").mkdir(parents=True)
        (base / ENTRYPOINT).write_text("// deliberately inert test runtime\n")
        (base / "node_modules/ws/package.json").write_text('{"name":"ws","version":"1.0.0"}')
        (base / "atlas-node-release.json").write_text(json.dumps({
            "application": "@atlas/node",
            "protocol": 2,
            "entrypoint": ENTRYPOINT,
            "version": "2.0.0",
            "commit": commit,
        }))

    def lifecycle(self, *args):
        return subprocess.run(
            ["bash", str(SCRIPT), *args],
            env=self.env,
            cwd=self.temp.name,
            capture_output=True,
            text=True,
            timeout=25,
        )

    def current(self):
        return (self.root / "current").resolve(strict=True).name

    def previous(self):
        path = self.root / "previous"
        return path.resolve(strict=True).name if path.is_symlink() else None

    def journal(self):
        return self.root / ".activation-pending"

    def restarts(self):
        return self.history.read_text().splitlines()

    def assert_success(self, command):
        self.assertEqual(command.returncode, 0, command.stdout + "\n" + command.stderr)

    def test_happy_path_commits_previous_only_after_live_reconnect(self):
        result = self.lifecycle("activate", RELEASES[1], "--expect-current", RELEASES[0])
        self.assert_success(result)
        self.assertEqual(self.current(), RELEASES[1])
        self.assertEqual(self.previous(), RELEASES[0])
        self.assertFalse(self.journal().exists())
        self.assertEqual(self.restarts(), ["restart:" + RELEASES[1]])
        self.assertIn("WebSocket: connected (live PID verified)", result.stdout)

    def test_bad_reconnect_auto_rolls_back_to_old_release(self):
        self.env["FAKE_FAIL_ON"] = RELEASES[1]
        result = self.lifecycle("activate", RELEASES[1], "--expect-current", RELEASES[0])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertIsNone(self.previous())
        self.assertFalse(self.journal().exists())
        self.assertEqual(self.restarts(), ["restart:" + RELEASES[1], "restart:" + RELEASES[0]])
        self.assertIn("Rollback completed", result.stderr)

    def test_sigkill_during_restart_leaves_journal_for_recovery(self):
        self.env["FAKE_KILL_ON"] = RELEASES[1]
        interrupted = self.lifecycle("activate", RELEASES[1])
        self.assertNotEqual(interrupted.returncode, 0)
        self.assertEqual(self.current(), RELEASES[1])
        self.assertEqual(self.journal().read_text().splitlines(),
                         [RELEASES[0], RELEASES[1], "activate"])
        del self.env["FAKE_KILL_ON"]
        recovered = self.lifecycle("recover")
        self.assert_success(recovered)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertIsNone(self.previous())
        self.assertFalse(self.journal().exists())
        self.assertEqual(self.restarts(), ["restart:" + RELEASES[1], "restart:" + RELEASES[0]])

    def test_explicit_rollback_does_not_reactivate_rejected_release(self):
        self.assert_success(self.lifecycle("activate", RELEASES[1]))
        rolled_back = self.lifecycle("rollback")
        self.assert_success(rolled_back)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertEqual(self.previous(), RELEASES[1])
        self.assertFalse(self.journal().exists())

    def test_interrupted_explicit_rollback_finishes_chosen_target(self):
        self.assert_success(self.lifecycle("activate", RELEASES[1]))
        self.env["FAKE_KILL_ON"] = RELEASES[0]
        interrupted = self.lifecycle("rollback")
        self.assertNotEqual(interrupted.returncode, 0)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertTrue(self.journal().exists())
        del self.env["FAKE_KILL_ON"]
        self.assert_success(self.lifecycle("recover"))
        self.assertEqual(self.current(), RELEASES[0])
        self.assertEqual(self.previous(), RELEASES[1])
        self.assertFalse(self.journal().exists())

    def test_stale_expected_current_refuses_restart_and_journal(self):
        result = self.lifecycle("activate", RELEASES[1], "--expect-current", RELEASES[2])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertFalse(self.journal().exists())
        self.assertEqual(self.restarts(), [])

    def test_corrupt_pending_journal_refuses_recovery_without_switching(self):
        self.journal().write_text("../bad\nnot-a-version\nactivate\n")
        result = self.lifecycle("recover")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertTrue(self.journal().exists())
        self.assertEqual(self.restarts(), [])

    def test_missing_candidate_is_rejected_without_restart(self):
        result = self.lifecycle("activate", "v2.0.0-" + "f" * 12)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.current(), RELEASES[0])
        self.assertFalse(self.journal().exists())
        self.assertEqual(self.restarts(), [])


if __name__ == "__main__":
    unittest.main()
