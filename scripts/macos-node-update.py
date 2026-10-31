#!/usr/bin/env python3
"""Operator-controlled macOS Node release discovery and one-command update.

Reuses the verified release catalogue, signed staging and crash-safe launchd
lifecycle. Discovery is candidate metadata only; staging checks Sigstore.
Never installs unattended, changes a credential, or elevates privileges.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
import sys


def load_helper(filename: str):
    source = Path(__file__).resolve().parent / filename
    spec = importlib.util.spec_from_file_location(
        "atlas_" + filename.replace("-", "_").removesuffix(".py"), source
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Missing Node updater component: " + filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


catalogue = load_helper("linux-node-host-updater.py")
staging = load_helper("macos-node-stage.py")
lifecycle = load_helper("macos-node-lifecycle.py")


class Refused(Exception):
    pass


def ensure_operator() -> None:
    if sys.platform != "darwin" or os.geteuid() == 0:
        raise Refused("Run as the logged-in, non-root macOS user.")


def current_node(layout) -> tuple[str, str]:
    """Read the existing plist; never read or print secrets from its env file."""
    data = lifecycle.decode_plist(
        lifecycle.exact_plist_bytes(layout.plist, layout.uid), layout
    )
    executable = Path(data["ProgramArguments"][1])
    parent = executable.parents[5]  # releases/vVERSION-SHA, or source root
    if (
        parent.parent == layout.releases
        and lifecycle.TAG.fullmatch(parent.name)
        and executable == parent / lifecycle.ENTRYPOINT
    ):
        return parent.name, "release", str(executable)
    if layout.releases in executable.parents:
        raise Refused("LaunchAgent points into an unexpected release path.")
    return "development-checkout", "development", str(executable)


def local_state(layout) -> dict:
    installed, mode, entrypoint = current_node(layout)
    if layout.pending.is_symlink():
        raise Refused("Symlinked recovery journal; inspect the lifecycle.")
    pid = lifecycle.launch_pid(layout)
    return {
        "schema": 1,
        "installed": installed,
        "mode": mode,
        "currentEntrypoint": entrypoint,
        "launchdPid": pid,
        "recoveryPending": layout.pending.exists(),
        "rollbackAvailable": layout.previous.exists(),
    }


def discover(layout) -> dict:
    state = local_state(layout)
    raw = catalogue.read_public_release_catalogue()
    releases = catalogue.verified_catalogue(catalogue.releases_from_json(raw))
    if state["mode"] == "release":
        selected, status = catalogue.choose_latest(releases, state["installed"])
    else:
        selected = max(releases, key=lambda item: (item["version"], item["sequence"]))
        status = "migration-required"
    state.update({
        "candidate": selected["tag"],
        "candidateSource": selected["commit"],
        "candidateDigest": selected["digest"],
        "state": status,
        "verification": "catalogue-only",
    })
    return state


def prepared_release(layout, selected: dict) -> None:
    """Use an already verified staging receipt, or stage fresh signed bytes.

    A same-user receipt isn't an immutable trust anchor; neither this CLI nor
    the existing lifecycle claims protection from an adversarial local user.
    """
    layout.app.mkdir(mode=0o700, parents=True, exist_ok=True)
    lifecycle.require_owned_parent(layout.app, layout.uid)
    layout.releases.mkdir(mode=0o700, exist_ok=True)
    lifecycle.require_private(layout.releases, layout.uid)
    tag = selected["tag"]
    target = layout.releases / tag.removeprefix("node-")
    if target.exists() or target.is_symlink():
        print("Checking previously signed-staged release:", tag)
    else:
        print("Downloading and verifying signed release:", tag)
        staging.stage(tag, layout.releases)
    # An exact immutable release tag is re-fetched during staging. Bind its
    # verified receipt back to the full source and archive digest that the
    # operator approved, even when this invocation did the initial staging.
    release = lifecycle.release_path(layout, tag.removeprefix("node-"))
    receipt_path = release / staging.RECEIPT
    receipt = json.loads(receipt_path.read_text())
    if (
        receipt.get("archiveSha256") != selected["digest"]
        or receipt.get("source") != selected["commit"]
    ):
        raise Refused("Signed-staged release does not match the selected catalogue build.")


def apply_update(layout, *, migrate: bool) -> int:
    if not sys.stdin.isatty():
        raise Refused("Updates require an interactive terminal and explicit confirmation.")
    selected_state = discover(layout)
    if selected_state["launchdPid"] is None:
        raise Refused("Current LaunchAgent has no live Node PID.")
    if selected_state["recoveryPending"]:
        raise Refused("Recovery is pending; run macos-node-lifecycle.py recover.")
    if selected_state["state"] == "current":
        print("Node already runs the latest eligible stable release.")
        return 0
    if selected_state["mode"] == "development" and not migrate:
        raise Refused("First migration from the development checkout requires update --migrate.")
    tag = selected_state["candidate"]
    installed = selected_state["installed"]
    print("Installed:", installed)
    print("Candidate:", tag, "(catalogue only; signature verified during staging)")
    if selected_state["mode"] == "development":
        print("First migration keeps the current plist identity/env path and rollback target.")
    if input("Type UPDATE " + tag + " to stage and activate: ") != "UPDATE " + tag:
        raise Refused("Update cancelled before any files or LaunchAgent changed.")

    # Refresh catalogue immediately before signed staging, and refuse if a
    # newer eligible build superseded the operator's approved selection.
    fresh = discover(layout)
    if (
        fresh["candidate"] != tag
        or fresh["candidateSource"] != selected_state["candidateSource"]
        or fresh["installed"] != installed
        or fresh["currentEntrypoint"] != selected_state["currentEntrypoint"]
        or fresh["candidateDigest"] != selected_state["candidateDigest"]
        or fresh["recoveryPending"]
    ):
        raise Refused("Release or host state changed; check again and reconfirm.")
    # The second complete catalogue read already confirmed the same immutable
    # tag, source and digest; staging independently re-fetches the exact
    # release and verifies its signed archive before any activation.
    selected = {
        "tag": tag,
        "commit": fresh["candidateSource"],
        "digest": fresh["candidateDigest"],
    }
    prepared_release(layout, selected)

    # The lifecycle owns the exclusive lock for both watchdog installation and
    # activation. Never bypass its existing checked journal/rollback protocol.
    try:
        lifecycle.require_watchdog(layout)
    except (lifecycle.Refused, OSError):
        if lifecycle.launch_loaded(layout, layout.recovery_target):
            raise Refused("Loaded recovery watchdog needs manual inspection; refusing update.")
        lifecycle.manage(layout, ["install-watchdog"])
    lifecycle.manage(layout, ["activate", tag.removeprefix("node-"), "--confirm",
                              "--expect-entrypoint", selected_state["currentEntrypoint"]])
    print("Local launchd reconnect verified; confirm authenticated Server registration separately.")
    return 0


def main(argv: list[str]) -> int:
    valid = (
        ["status"], ["status", "--json"], ["check"], ["check", "--json"],
        ["update"], ["update", "--migrate"], ["rollback"],
    )
    if argv not in valid:
        print("Usage: macos-node-update.py status [--json] | check [--json] | "
              "update [--migrate] | rollback", file=sys.stderr)
        return 2
    ensure_operator()
    layout = lifecycle.Layout(Path.home(), os.getuid())
    if argv[0] == "rollback":
        if not sys.stdin.isatty() or input("Type ROLLBACK to restore the prior Node: ") != "ROLLBACK":
            raise Refused("Rollback requires explicit interactive confirmation.")
        lifecycle.manage(layout, ["rollback", "--confirm"])
        return 0
    result = local_state(layout) if argv[0] == "status" else (
        discover(layout) if argv[0] == "check" else None
    )
    if result is not None:
        if "--json" in argv:
            print(json.dumps(result, sort_keys=True))
        else:
            for key, value in result.items():
                if key != "schema":
                    print(key + ":", value)
        return 0
    return apply_update(layout, migrate="--migrate" in argv)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Refused, lifecycle.Refused, staging.Refused, catalogue.Refused,
            OSError, ValueError, RuntimeError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
        print("Atlas macOS Node updater:", str(exc), file=sys.stderr)
        sys.exit(1)
