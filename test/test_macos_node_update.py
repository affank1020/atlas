"""Operator macOS update coordinator tests; no network or host launchd changes."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/macos-node-update.py"
spec = importlib.util.spec_from_file_location("macos_node_update", SCRIPT)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class LayoutFixture:
    def __init__(self, root: Path):
        self.releases = root / "releases"
        self.releases.mkdir()
        self.pending = root / "pending.json"
        self.previous = root / "previous.plist"
        self.plist = root / "node.plist"
        self.uid = 501
        self.app = root
        self.target = "gui/501/com.affank1020.atlas.node"
        self.recovery_target = self.target + ".recover"


def release(tag: str, sequence: int, source: str = "a" * 40) -> dict:
    version, short = tag.removeprefix("node-v").rsplit("-", 1)
    archive = f"atlas-node-v{version}-{short}.tar.gz"
    return {
        "tag_name": tag, "target_commitish": source, "immutable": True,
        "draft": False, "prerelease": False,
        "body": f"Atlas-Node-Release-Sequence: {sequence}\n",
        "assets": [
            {"name": archive, "digest": "sha256:" + "b" * 64, "size": 12000},
            {"name": archive + ".sha256", "digest": "sha256:" + "c" * 64, "size": 100},
        ],
    }


class MacUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.layout = LayoutFixture(Path(self.tmp.name))
        self.tag1 = "node-v2.0.0-" + "a" * 12
        self.tag2 = "node-v2.0.0-" + "d" * 12
        self.one = release(self.tag1, 11)
        self.two = release(self.tag2, 12, "d" * 40)

    def test_current_node_recognizes_release_exactly_not_nearby_path(self):
        root = self.layout.releases / self.tag1.removeprefix("node-")
        entry = root / update.lifecycle.ENTRYPOINT
        with patch.object(update.lifecycle, "exact_plist_bytes", return_value=b"plist"), patch.object(
            update.lifecycle, "decode_plist", return_value={"ProgramArguments": ["/node", str(entry)]}
        ):
            self.assertEqual(update.current_node(self.layout), (root.name, "release"))
        with patch.object(update.lifecycle, "exact_plist_bytes", return_value=b"plist"), patch.object(
            update.lifecycle, "decode_plist", return_value={
                "ProgramArguments": ["/node", str(root / "elsewhere/main.js")]
            }
        ):
            with self.assertRaisesRegex(update.Refused, "unexpected release path"):
                update.current_node(self.layout)

    def test_development_checkout_is_explicit_migration(self):
        with patch.object(update, "local_state", return_value={
            "installed": "development-checkout", "mode": "development",
            "launchdPid": 123, "recoveryPending": False
        }), patch.object(update.catalogue, "read_public_release_catalogue",
                        return_value=json.dumps([self.one, self.two])):
            result = update.discover(self.layout)
        self.assertEqual(result["candidate"], self.tag2)
        self.assertEqual(result["state"], "migration-required")
        self.assertEqual(result["verification"], "catalogue-only")

    def test_same_version_sequence_picks_newer_build(self):
        with patch.object(update, "local_state", return_value={
            "installed": self.tag1.removeprefix("node-"), "mode": "release",
            "launchdPid": 123, "recoveryPending": False
        }), patch.object(update.catalogue, "read_public_release_catalogue",
                        return_value=json.dumps([self.one, self.two])):
            result = update.discover(self.layout)
        self.assertEqual(result["candidate"], self.tag2)
        self.assertEqual(result["state"], "available")

    def test_no_migration_flag_refuses_before_mutation(self):
        candidate = {
            "candidate": self.tag2, "candidateSource": "d" * 40,
            "installed": "development-checkout", "mode": "development",
            "state": "migration-required", "launchdPid": 123,
            "recoveryPending": False,
        }
        with patch.object(update, "discover", return_value=candidate), patch.object(
            update.sys.stdin, "isatty", return_value=True
        ), patch.object(update, "prepared_release") as stage, patch.object(
            update.lifecycle, "manage"
        ) as activate:
            with self.assertRaisesRegex(update.Refused, "update --migrate"):
                update.apply_update(self.layout, migrate=False)
            stage.assert_not_called()
            activate.assert_not_called()

    def test_cancel_does_not_touch_staging_or_launchd(self):
        candidate = {
            "candidate": self.tag2, "candidateSource": "d" * 40,
            "installed": self.tag1.removeprefix("node-"), "mode": "release",
            "state": "available", "launchdPid": 123,
            "recoveryPending": False,
        }
        with patch.object(update, "discover", return_value=candidate), patch.object(
            update.sys.stdin, "isatty", return_value=True
        ), patch("builtins.input", return_value="no"), patch.object(
            update, "prepared_release"
        ) as stage, patch.object(update.lifecycle, "manage") as activate:
            with self.assertRaisesRegex(update.Refused, "cancelled"):
                update.apply_update(self.layout, migrate=False)
            stage.assert_not_called()
            activate.assert_not_called()

    def test_changed_catalogue_refuses_after_confirmation(self):
        candidate = {
            "candidate": self.tag2, "candidateSource": "d" * 40,
            "installed": self.tag1.removeprefix("node-"), "mode": "release",
            "state": "available", "launchdPid": 123, "recoveryPending": False,
        }
        altered = dict(candidate, candidateSource="e" * 40)
        with patch.object(update, "discover", side_effect=[candidate, altered]), patch.object(
            update.sys.stdin, "isatty", return_value=True
        ), patch("builtins.input", return_value="UPDATE " + self.tag2), patch.object(
            update, "prepared_release"
        ) as stage:
            with self.assertRaisesRegex(update.Refused, "state changed"):
                update.apply_update(self.layout, migrate=False)
            stage.assert_not_called()

    def test_signed_staged_release_mismatch_fails_before_activation(self):
        root = self.layout.releases / self.tag2.removeprefix("node-")
        root.mkdir()
        with patch.object(update.lifecycle, "release_path", return_value=root):
            (root / update.staging.RECEIPT).write_text(json.dumps({
                "source": "d" * 40, "archiveSha256": "0" * 64
            }))
            with self.assertRaisesRegex(update.Refused, "does not match"):
                update.prepared_release(self.layout, {
                    "tag": self.tag2, "commit": "d" * 40, "digest": "b" * 64
                })

    def test_recovery_pending_refuses_before_confirmation(self):
        state = {"recoveryPending": True, "launchdPid": 321, "mode": "release"}
        with patch.object(update, "discover", return_value=state), patch.object(
            update.sys.stdin, "isatty", return_value=True
        ), patch("builtins.input") as prompt:
            with self.assertRaisesRegex(update.Refused, "Recovery is pending"):
                update.apply_update(self.layout, migrate=False)
            prompt.assert_not_called()

    def test_successful_flow_verifies_staging_then_reuses_lifecycle(self):
        old = self.tag1.removeprefix("node-")
        candidate = {
            "candidate": self.tag2, "candidateSource": "d" * 40,
            "installed": old, "mode": "release", "state": "available",
            "launchdPid": 123, "recoveryPending": False,
        }
        events = []
        with patch.object(update, "discover", return_value=candidate), patch.object(
            update.catalogue, "read_public_release_catalogue",
            return_value=json.dumps([self.one, self.two])
        ), patch.object(update.sys.stdin, "isatty", return_value=True), patch(
            "builtins.input", return_value="UPDATE " + self.tag2
        ), patch.object(update, "prepared_release", side_effect=lambda *_: events.append("stage")), patch.object(
            update.lifecycle, "require_watchdog", side_effect=lambda *_: events.append("watchdog")
        ), patch.object(
            update.lifecycle, "manage", side_effect=lambda *args: events.append(tuple(args[1]))
        ):
            self.assertEqual(update.apply_update(self.layout, migrate=False), 0)
        self.assertEqual(events, ["stage", "watchdog",
                                  ("activate", self.tag2.removeprefix("node-"), "--confirm")])


if __name__ == "__main__":
    unittest.main()
