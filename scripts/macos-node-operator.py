#!/usr/bin/env python3
"""Install the signed macOS Node operator without depending on a source checkout.

A one-time, explicit bootstrap selects Python helpers *inside* an already
Sigstore-staged Node release. Thereafter the private wrapper runs those
helpers, not scripts from a development checkout. No launchd or Node mutation.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
import importlib.util
import json
import os
import plistlib
import subprocess
from pathlib import Path
import stat
import sys

FILES = (
    "macos-node-update.py",
    "macos-node-stage.py",
    "macos-node-lifecycle.py",
    "linux-node-host-updater.py",
    "macos-node-operator.py",
)
CHECK_LABEL = lifecycle_label = "com.affank1020.atlas.node.update-check"
CHECK_INTERVAL = 3600
MAX_CHECK_RECORD = 4096
WRAPPER = """#!/bin/sh
exec python3 "$HOME/Library/Application Support/Atlas/NodeSoftware/operator/current/macos-node-update.py" "$@"
"""


def load_lifecycle():
    path = Path(__file__).resolve().with_name("macos-node-lifecycle.py")
    spec = importlib.util.spec_from_file_location("atlas_mac_operator_lifecycle", path)
    if not spec or not spec.loader:
        raise RuntimeError("Missing macOS lifecycle helper.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lifecycle = load_lifecycle()


class Refused(Exception):
    pass


def layout_for_user():
    if sys.platform != "darwin" or os.geteuid() == 0:
        raise Refused("Only a logged-in non-root macOS operator can provision this CLI.")
    return lifecycle.Layout(Path.home(), os.getuid())


def paths(layout) -> tuple[Path, Path, Path]:
    operator = layout.app / "operator"
    current = operator / "current"
    wrapper = layout.app / "bin" / "atlas-node-mac"
    return operator, current, wrapper


def validate_signed_operator(layout, version: str) -> Path:
    """Require the signed-staging receipt and manifest-bound script digests."""
    release = lifecycle.release_path(layout, version)
    try:
        manifest_path = release / "atlas-node-release.json"
        if manifest_path.is_symlink() or manifest_path.stat().st_size > 16384:
            raise Refused("Signed Node manifest is invalid.")
        manifest = json.loads(manifest_path.read_text())
    except (ValueError, OSError) as exc:
        raise Refused("Signed Node manifest is unreadable.") from exc
    hashes = manifest.get("operatorScripts")
    if not isinstance(hashes, dict) or set(hashes) != {"scripts/" + name for name in FILES}:
        raise Refused("Release is too old or missing the signed macOS operator bundle.")
    scripts = release / "scripts"
    if scripts.is_symlink() or not scripts.is_dir():
        raise Refused("Release operator directory must be regular.")
    for name in FILES:
        source = scripts / name
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 100000:
            raise Refused("Missing or oversized signed operator source: " + name)
        contents = source.read_bytes()
        if (not contents or not isinstance(hashes.get("scripts/" + name), str) or
            hashlib.sha256(contents).hexdigest() != hashes["scripts/" + name]):
            raise Refused("Signed Node operator script digest mismatch: " + name)
        # Syntax check without executing code or writing pycache into a release.
        try:
            compile(contents, str(source), "exec")
        except (SyntaxError, UnicodeError) as exc:
            raise Refused("Invalid Python operator script: " + name) from exc
    return scripts


def signed_lifecycle(scripts: Path):
    """Load the already manifest-verified target release's lifecycle.

    This runs only for a staged, signed release; never select Python from a
    catalogue URL or an arbitrary user-supplied directory.
    """
    source = scripts / "macos-node-lifecycle.py"
    spec = importlib.util.spec_from_file_location("atlas_mac_operator_target_lifecycle", source)
    if not spec or not spec.loader:
        raise Refused("Signed release lifecycle is unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def align_recovery_watchdog(layout, target) -> None:
    """Caller holds lifecycle lock; don't leave CLI ahead of its watchdog."""
    try:
        target.require_watchdog(layout)
    except (target.Refused, OSError):
        if layout.pending.exists() or layout.pending.is_symlink():
            raise Refused("Pending Node recovery prevents operator/watchdog migration.")
        if layout.watchdog_refresh.exists() or layout.watchdog_refresh.is_symlink():
            raise Refused("Pending watchdog repair must be restored before operator migration.")
        if not target.launch_loaded(layout, layout.recovery_target):
            raise Refused("Recovery watchdog is not loaded; refusing operator promotion.")
        # Refresh writes a durable rollback journal and restores the old job
        # on failure. The caller's single lifecycle lock excludes concurrent
        # activation, updater promotion and atlasctl modifications.
        target.refresh_watchdog(layout)
    target.require_watchdog(layout)


def current_target(layout) -> Path | None:
    operator, link, _ = paths(layout)
    if link.is_symlink():
        target = Path(os.readlink(link))
        if not target.is_absolute() or target.parent.parent != layout.releases:
            raise Refused("Installed operator points outside the private release tree.")
        if target.name != "scripts" or not lifecycle.TAG.fullmatch(target.parent.name):
            raise Refused("Installed operator release target is malformed.")
        # Check it still resolves to the recorded signed scripts, not a
        # replaceable alternate directory selected through a symlink.
        if (not target.is_dir() or target.is_symlink() or
            target.parent.is_symlink() or layout.releases.is_symlink()):
            raise Refused("Installed operator release is unavailable.")
        return target
    if link.exists():
        raise Refused("Installed operator pointer is not a symlink.")
    if operator.is_symlink():
        raise Refused("Operator directory must not be symlinked.")
    return None


def operator_status(layout) -> dict:
    current = current_target(layout)
    if current is not None:
        validate_signed_operator(layout, current.parent.name)
    return {"installedOperator": current.parent.name if current else None,
            "wrapper": str(paths(layout)[2]),
            "checkoutRequired": False if current else True}


def promote(layout, version: str, *, require_existing: bool = False) -> None:
    """Atomic swap of the CLI pointer, within the existing lifecycle lock."""
    operator, link, wrapper = paths(layout)
    if layout.pending.exists() or layout.pending.is_symlink():
        raise Refused("Node activation is pending; cannot change operator scripts.")
    if layout.watchdog_refresh.exists() or layout.watchdog_refresh.is_symlink():
        raise Refused("Watchdog replacement is pending; cannot change operator scripts.")
    if require_existing and current_target(layout) is None:
        return  # Repo-based updates must not install a wrapper without approval.
    scripts = validate_signed_operator(layout, version)
    operator.mkdir(mode=0o700, parents=True, exist_ok=True)
    lifecycle.require_private(operator, layout.uid)
    wrapper.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lifecycle.require_private(wrapper.parent, layout.uid)
    if wrapper.exists() or wrapper.is_symlink():
        lifecycle.require_private(wrapper, layout.uid, directory=False)
        if wrapper.read_text() != WRAPPER:
            raise Refused("Installed macOS operator entrypoint differs; manual inspection required.")
        if not wrapper.stat().st_mode & stat.S_IXUSR:
            # Complete a previously interrupted first-time bootstrap only
            # after verifying the exact expected user-owned wrapper content.
            wrapper.chmod(0o700)
    else:
        lifecycle.atomic_write(wrapper, WRAPPER.encode())
        wrapper.chmod(0o700)
    current_target(layout)  # Reject an unexpected pointer before replacement.
    # Align the recovery job to the *target release* before the new CLI can
    # be selected. If the watchdog upgrade fails, the current CLI pointer
    # stays unchanged. A process killed between alignment and os.replace
    # leaves the old CLI operable: its confirmed rollback path repairs its
    # own watchdog before touching the Node.
    if require_existing:
        target = signed_lifecycle(scripts)
        align_recovery_watchdog(layout, target)
    if link.is_symlink() and Path(os.readlink(link)) == scripts:
        return
    temp = operator / (".current." + str(os.getpid()) + ".tmp")
    if temp.exists() or temp.is_symlink():
        raise Refused("Unexpected temporary operator pointer.")
    try:
        os.symlink(scripts, temp)
        os.replace(temp, link)
        directory = os.open(operator, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temp.is_symlink():
            temp.unlink()


def initial_install(layout, version: str) -> None:
    # The caller has already confirmed the selected signed release. No
    # privilege elevation, Node restart, service install or identity change.
    layout.app.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lifecycle.lock_state(layout):
        promote(layout, version)
    print("Installed checkout-independent macOS operator:")
    print(paths(layout)[2])
    print("No Node process, LaunchAgent or credential was changed.")


def active_version(layout) -> str:
    data = lifecycle.decode_plist(
        lifecycle.exact_plist_bytes(layout.plist, layout.uid), layout
    )
    entry = Path(data["ProgramArguments"][1])
    version = entry.parents[5].name
    if (entry != layout.releases / version / lifecycle.ENTRYPOINT or
        not lifecycle.TAG.fullmatch(version)):
        raise Refused("Active Node does not use a signed staged release; sync unavailable.")
    return version


def sync_from_active(layout) -> None:
    with lifecycle.lock_state(layout):
        if current_target(layout) is None:
            raise Refused("Install an operator first; sync cannot bootstrap.")
        promote(layout, active_version(layout), require_existing=True)
    print("Operator CLI now follows the currently active signed Node release.")



def check_paths(layout) -> tuple[Path, Path]:
    return (layout.home / "Library/LaunchAgents" / (CHECK_LABEL + ".plist"),
            layout.app / "release-check.json")


def check_target(layout) -> str:
    return f"gui/{layout.uid}/{CHECK_LABEL}"


def check_plist(layout) -> bytes:
    """No credentials, Node identity, privileged service or installer action."""
    return plistlib.dumps({
        "Label": CHECK_LABEL,
        "ProgramArguments": [
            sys.executable,
            str(layout.app / "operator" / "current" / "macos-node-operator.py"),
            "check-background",
        ],
        "RunAtLoad": True,
        "StartInterval": CHECK_INTERVAL,
    }, fmt=plistlib.FMT_XML)


def check_existing_plist(layout) -> bytes | None:
    plist, _ = check_paths(layout)
    if not plist.exists() and not plist.is_symlink():
        return None
    content = lifecycle.exact_plist_bytes(plist, layout.uid)
    try:
        actual = plistlib.loads(content)
        expected = plistlib.loads(check_plist(layout))
    except (ValueError, TypeError, plistlib.InvalidFileException) as exc:
        raise Refused("Invalid macOS release-checker LaunchAgent.") from exc
    if not isinstance(actual, dict):
        raise Refused("Unexpected macOS release-checker job.")
    # An installed version may use a different absolute Python interpreter
    # from the currently running updater, but the scheduled script and its
    # arguments must always be the approved, user-private, signed path.
    args = actual.get("ProgramArguments")
    if (not isinstance(args, list) or len(args) != 3 or
        not isinstance(args[0], str) or not os.path.isabs(args[0]) or
        not Path(args[0]).is_file()):
        raise Refused("Release-checker Python interpreter is unavailable.")
    expected["ProgramArguments"][0] = args[0]
    if actual != expected:
        raise Refused("Unexpected release-checker job configuration; refusing changes.")
    return content


def installed_check_status(layout) -> dict:
    """Read local state only. Status never performs network access."""
    plist, record = check_paths(layout)
    contents = check_existing_plist(layout)
    loaded = lifecycle.launch_loaded(layout, check_target(layout))
    if contents is None and loaded:
        raise Refused("Unexpected loaded release-checker job without its plist.")
    if contents is not None and not loaded:
        state = "needs-attention"
    else:
        state = "enabled" if loaded else "disabled"
    latest = None
    if record.exists() or record.is_symlink():
        lifecycle.require_private(record, layout.uid, directory=False)
        if record.stat().st_size > MAX_CHECK_RECORD:
            raise Refused("Release-checker result is oversized.")
        try:
            latest = json.loads(record.read_text())
        except (ValueError, UnicodeError) as exc:
            raise Refused("Release-checker result is malformed.") from exc
        if (not isinstance(latest, dict) or latest.get("schema") != 1 or
            latest.get("state") not in (
                "current", "available", "migration-required",
                "unavailable", "needs-attention",
            ) or not isinstance(latest.get("checkedAt"), str)):
            raise Refused("Release-checker result has unexpected fields.")
        # Reject unexpected additional data, especially anything that might
        # accidentally serialize a Node secret or an exception.
        if set(latest) - {"schema", "checkedAt", "state", "installed",
                          "candidate", "verification", "reason"}:
            raise Refused("Release-checker result contains unknown fields.")
    return {"schedule": state, "intervalSeconds": CHECK_INTERVAL,
            "lastCheck": latest}


def enable_check(layout) -> None:
    """Provision a check-only user LaunchAgent; never update the Node."""
    with lifecycle.lock_state(layout):
        current = current_target(layout)
        if current is None:
            raise Refused("Install the signed standalone operator first.")
        validate_signed_operator(layout, current.parent.name)
        plist, _ = check_paths(layout)
        lifecycle.require_owned_parent(layout.app, layout.uid)
        plist.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        desired = check_plist(layout)
        existing = check_existing_plist(layout)
        if lifecycle.launch_loaded(layout, check_target(layout)):
            if existing is None:
                raise Refused("Unrecognized loaded release-checker job.")
            print("Release checker is already enabled.")
            return
        if existing is None:
            lifecycle.atomic_write(plist, desired)
        # Preserve a valid prior interpreter path on retry; do not overwrite
        # a plist from a previous attempt or a user-owned job unexpectedly.
        lifecycle.command("launchctl", "bootstrap", f"gui/{layout.uid}", str(plist))
        if not lifecycle.launch_loaded(layout, check_target(layout)):
            raise Refused("Release-checker LaunchAgent did not load.")
    print("Enabled hourly macOS Node release checks (discovery only; no installs).")


def disable_check(layout) -> None:
    with lifecycle.lock_state(layout):
        plist, _ = check_paths(layout)
        existing = check_existing_plist(layout)
        loaded = lifecycle.launch_loaded(layout, check_target(layout))
        if existing is None:
            if loaded:
                raise Refused("Unrecognized loaded release-checker job.")
            print("Release checker is already disabled.")
            return
        if loaded:
            lifecycle.command("launchctl", "bootout", check_target(layout))
            if lifecycle.launch_loaded(layout, check_target(layout)):
                raise Refused("Release-checker job is still loaded after bootout.")
        plist.unlink()
        directory = os.open(plist.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    print("Disabled scheduled release checks; no Node service was changed.")


def background_check(layout) -> None:
    """Noninteractive, public catalogue read; only one private status file written."""
    current = current_target(layout)
    if current is None:
        raise Refused("No signed standalone operator installed.")
    # Prevent arbitrary execution from a checkout, or an out-of-date helper
    # when the installed pointer has moved to a different signed release.
    if Path(__file__).resolve().parent != current.resolve():
        raise Refused("Checker must run from the selected signed operator.")
    validate_signed_operator(layout, current.parent.name)
    observation = {
        "schema": 1,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "state": "unavailable",
        "reason": "catalogue-or-node-unavailable",
    }
    if layout.pending.exists() or layout.pending.is_symlink() or (
        layout.watchdog_refresh.exists() or layout.watchdog_refresh.is_symlink()
    ):
        observation["state"] = "needs-attention"
        observation["reason"] = "local-recovery-pending"
    else:
        try:
            source = Path(__file__).resolve().with_name("macos-node-update.py")
            spec = importlib.util.spec_from_file_location(
                "atlas_background_node_check", source
            )
            if not spec or not spec.loader:
                raise Refused("Selected updater unavailable.")
            updater = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(updater)
            details = updater.discover(layout)
            observation = {
                "schema": 1,
                "checkedAt": observation["checkedAt"],
                "state": details["state"],
                "installed": details["installed"],
                "candidate": details["candidate"],
                "verification": "catalogue-only",
            }
        except Exception:
            # Error type/message could contain a URL or host-local path.
            # Never persist a raw exception or the Node's identity/config.
            pass
    _, record = check_paths(layout)
    lifecycle.require_owned_parent(layout.app, layout.uid)
    if record.is_symlink():
        raise Refused("Release-checker result path is symlinked.")
    if record.exists():
        lifecycle.require_private(record, layout.uid, directory=False)
    lifecycle.atomic_write(record, (
        json.dumps(observation, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode())


def monitor_manage(layout, argv: list[str]) -> int:
    if argv in (["status"], ["status", "--json"]):
        result = installed_check_status(layout)
        if "--json" in argv:
            print(json.dumps(result, sort_keys=True))
        else:
            print("Schedule:", result["schedule"])
            print("Interval:", result["intervalSeconds"], "seconds")
            print("Last check:", json.dumps(result["lastCheck"], sort_keys=True))
        return 0
    if argv not in (["enable"], ["disable"]):
        raise Refused("Usage: atlas-node-mac monitor status [--json] | enable | disable")
    if not sys.stdin.isatty():
        raise Refused("Changing the scheduled checker requires an interactive terminal.")
    word = "ENABLE CHECKS" if argv[0] == "enable" else "DISABLE CHECKS"
    if input("Type " + word + " to proceed: ") != word:
        raise Refused("No schedule change was made.")
    if argv[0] == "enable":
        enable_check(layout)
    else:
        disable_check(layout)
    return 0


def main(argv: list[str]) -> int:
    if not (argv == ["status"] or argv == ["sync", "--confirm"] or
            argv == ["check-background"] or
            len(argv) == 3 and argv[0] == "install" and argv[2] == "--confirm" and
            lifecycle.TAG.fullmatch(argv[1])):
        print("Usage: macos-node-operator.py status | install vVERSION-SHA --confirm | sync --confirm | check-background",
              file=sys.stderr)
        return 2
    layout = layout_for_user()
    if argv[0] == "status":
        print(json.dumps(operator_status(layout), indent=2))
    elif argv[0] == "check-background":
        background_check(layout)
    elif argv[0] == "install":
        if not sys.stdin.isatty() or input("Type INSTALL " + argv[1] + " to provision the CLI: ") != "INSTALL " + argv[1]:
            raise Refused("Operator install requires explicit interactive confirmation.")
        initial_install(layout, argv[1])
    else:
        if not sys.stdin.isatty() or input("Type SYNC to switch to the active signed release: ") != "SYNC":
            raise Refused("Operator sync requires explicit interactive confirmation.")
        sync_from_active(layout)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Refused, lifecycle.Refused, OSError, ValueError, RuntimeError,
            BlockingIOError) as exc:
        print("Atlas macOS Node operator:", exc, file=sys.stderr)
        sys.exit(1)
