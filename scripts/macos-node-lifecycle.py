#!/usr/bin/env python3
"""Operator-confirmed, same-user macOS Node launchd cutover and rollback.

Never downloads releases, elevates privilege or reads the contents of Node
credentials. Staging is handled separately by macos-node-stage.py. Requires
explicit operator action; no unattended update policy exists here.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import time

LABEL = "com.affank1020.atlas.node"
RECOVERY_LABEL = LABEL + ".recover"
ENTRYPOINT = "apps/node/dist/platforms/desktop/main.js"
TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{40}$")
MAX_PLIST = 32768
GRACE_SECONDS = 100
HEALTH_SECONDS = 45


class Refused(Exception):
    pass


class Layout:
    def __init__(self, home: Path, uid: int):
        self.home, self.uid = home, uid
        self.app = home / "Library/Application Support/Atlas/NodeSoftware"
        self.state = self.app / "activation"
        self.releases = self.app / "releases"
        self.plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
        self.recovery_plist = home / "Library/LaunchAgents" / (RECOVERY_LABEL + ".plist")
        self.local_status = home / "Library/Application Support/Atlas/node-status.json"
        self.target = f"gui/{uid}/{LABEL}"
        self.recovery_target = f"gui/{uid}/{RECOVERY_LABEL}"
        self.recovery_script = self.state / "macos-node-lifecycle.py"
        self.pending = self.state / "pending.json"
        self.previous = self.state / "previous.plist"
        self.lock = self.state / ".lifecycle.lock"


def require_owned_parent(path: Path, uid: int) -> None:
    # NodeSoftware may have been created as mode 0755 by the standalone
    # staging command's intermediate mkdir; it must not be writable by other
    # users, while all lifecycle state remains strictly private (0700).
    if path.is_symlink() or not path.is_dir():
        raise Refused("NodeSoftware parent directory is invalid.")
    st = path.stat()
    if st.st_uid != uid or st.st_mode & 0o022:
        raise Refused("NodeSoftware parent directory is not safely owned.")


def require_private(path: Path, uid: int, *, directory: bool = True) -> None:
    if path.is_symlink():
        raise Refused(f"Refusing symlinked lifecycle path: {path}")
    st = path.stat()
    if st.st_uid != uid or (st.st_mode & 0o077) or (not stat.S_ISDIR(st.st_mode) if directory else not stat.S_ISREG(st.st_mode)):
        raise Refused(f"Lifecycle path must be private and user-owned: {path}")


def command(*argv: str, capture: bool = False) -> str:
    result = subprocess.run(argv, check=True, timeout=15, text=True,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    return result.stdout or ""


def launch_pid(layout: Layout, target: str | None = None) -> int | None:
    try:
        result = command("launchctl", "print", target or layout.target, capture=True)
    except subprocess.CalledProcessError:
        return None
    match = re.search(r"(?m)^\s*pid\s*=\s*([1-9][0-9]*)\s*$", result)
    return int(match.group(1)) if match else None


def launch_loaded(layout: Layout, target: str) -> bool:
    try:
        command("launchctl", "print", target)
        return True
    except subprocess.CalledProcessError:
        return False


def exact_plist_bytes(path: Path, uid: int) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise Refused("Missing regular LaunchAgent plist.")
    st = path.stat()
    if st.st_uid != uid or st.st_mode & 0o022 or st.st_size > MAX_PLIST:
        raise Refused("LaunchAgent plist is not safely owned or bounded.")
    return path.read_bytes()


def decode_plist(content: bytes, layout: Layout) -> dict:
    if not content or len(content) > MAX_PLIST:
        raise Refused("LaunchAgent plist has an invalid size.")
    try:
        data = plistlib.loads(content)
    except (ValueError, TypeError, plistlib.InvalidFileException) as exc:
        raise Refused("Invalid LaunchAgent plist.") from exc
    if not isinstance(data, dict) or data.get("Label") != LABEL:
        raise Refused("Refusing a different LaunchAgent label.")
    args = data.get("ProgramArguments")
    cwd = data.get("WorkingDirectory")
    env = data.get("EnvironmentVariables")
    if (not isinstance(args, list) or len(args) != 2 or
        not all(isinstance(x, str) and x.startswith("/") for x in args) or
        not isinstance(cwd, str) or not cwd.startswith("/") or
        args[1] != str(Path(cwd).parents[1] / ENTRYPOINT) or
        not isinstance(env, dict) or not isinstance(env.get("ATLAS_NODE_ENV_FILE"), str) or
        not env["ATLAS_NODE_ENV_FILE"].startswith("/") or
        data.get("RunAtLoad") is not True):
        raise Refused("Unexpected Node LaunchAgent shape; manual migration required.")
    if (not Path(args[1]).is_file() or not Path(cwd).is_dir() or
        not Path(env["ATLAS_NODE_ENV_FILE"]).is_file()):
        raise Refused("Node code, workdir or existing identity configuration is unavailable.")
    # Preserve the *path* to the existing configuration; never inspect its contents.
    if Path(env["ATLAS_NODE_ENV_FILE"]).is_symlink():
        raise Refused("Refusing symlinked Node identity configuration.")
    return data


def release_path(layout: Layout, tag: str) -> Path:
    if not TAG.fullmatch(tag):
        raise Refused("Expected versioned release vVERSION-12charSHA.")
    require_private(layout.releases, layout.uid)
    release = layout.releases / tag
    if release.is_symlink() or not release.is_dir():
        raise Refused("Expected one prepared release directory.")
    require_private(release, layout.uid)
    receipt = release / ".atlas-signed-staging.json"
    if receipt.is_symlink() or not receipt.is_file() or receipt.stat().st_size > 4096:
        raise Refused("Missing signed-staging receipt.")
    try:
        data = json.loads(receipt.read_text())
        meta = json.loads((release / "atlas-node-release.json").read_text())
    except (OSError, ValueError) as exc:
        raise Refused("Invalid prepared release receipt or manifest.") from exc
    if (not isinstance(data, dict) or data.get("schema") != 1 or
        data.get("tag") != "node-" + tag or
        data.get("verification") != "signed-github-build-provenance" or
        not isinstance(data.get("source"), str) or not SHA.fullmatch(data["source"]) or
        not data["source"].startswith(tag.rsplit("-", 1)[1]) or
        not isinstance(meta, dict) or meta.get("application") != "@atlas/node" or
        meta.get("commit") != data["source"] or
        meta.get("version") != tag[1:].rsplit("-", 1)[0] or meta.get("protocol") != 2 or
        meta.get("entrypoint") != ENTRYPOINT or
        not isinstance(meta.get("supportedHosts"), list) or
        "darwin" not in meta["supportedHosts"]):
        raise Refused("Staged release does not match its recorded signed source.")
    for name in (ENTRYPOINT, "apps/node/package.json", "package-lock.json"):
        entry = release / name
        if entry.is_symlink() or not entry.is_file():
            raise Refused("Staged release entrypoint or package metadata is missing.")
    return release


def make_plist(old: bytes, layout: Layout, target: Path) -> bytes:
    data = decode_plist(old, layout)
    data["ProgramArguments"] = [data["ProgramArguments"][0], str(target / ENTRYPOINT)]
    data["WorkingDirectory"] = str(target / "apps/node")
    # All original environment keys, including ATLAS_NODE_ENV_FILE, are retained.
    return plistlib.dumps(data, fmt=plistlib.FMT_XML, sort_keys=False)


def atomic_write(path: Path, content: bytes) -> None:
    if path.is_symlink():
        raise Refused("Refusing symlinked output.")
    temp = path.with_name("." + path.name + f".{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        # A directory fsync protects the committed journal across a process
        # crash; on systems that do not support directory fsync, fail closed.
        folder = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
    finally:
        if temp.exists():
            temp.unlink()


def json_write(path: Path, value: dict) -> None:
    atomic_write(path, (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode())


@contextmanager
def lock_state(layout: Layout):
    layout.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    require_owned_parent(layout.app, layout.uid)
    require_private(layout.state, layout.uid)
    fd = os.open(layout.lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "rb") as lock:
        require_private(layout.lock, layout.uid, directory=False)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield lock.fileno()


def recover_record(layout: Layout) -> dict | None:
    if not layout.pending.exists():
        if layout.pending.is_symlink():
            raise Refused("Refusing symlinked journal.")
        return None
    require_private(layout.pending, layout.uid, directory=False)
    if layout.pending.stat().st_size > 100000:
        raise Refused("Pending journal is too large.")
    try:
        data = json.loads(layout.pending.read_text())
        target = base64.b64decode(data["recoverPlist"], validate=True)
    except (ValueError, KeyError, TypeError) as exc:
        raise Refused("Invalid pending lifecycle journal.") from exc
    if (data.get("schema") != 1 or data.get("action") not in ("activate", "rollback") or
        type(data.get("started")) not in (int, float) or
        type(data.get("oldPid")) is not int or data["oldPid"] < 1 or
        hashlib.sha256(target).hexdigest() != data.get("recoverSha256")):
        raise Refused("Invalid pending lifecycle journal.")
    decode_plist(target, layout)
    if data["action"] == "rollback":
        try:
            previous_bytes = base64.b64decode(data["previousPlist"], validate=True)
        except (KeyError, TypeError, ValueError) as exc:
            raise Refused("Rollback journal is missing its original LaunchAgent.") from exc
        decode_plist(previous_bytes, layout)
        data["_previous"] = previous_bytes
    else:
        try:
            saved = data["previousBefore"]
            prior_previous = None if saved is None else base64.b64decode(saved, validate=True)
        except (KeyError, TypeError, ValueError) as exc:
            raise Refused("Activation journal lost its rollback target.") from exc
        if prior_previous is not None:
            decode_plist(prior_previous, layout)
        data["_previous_before"] = prior_previous
    data["_restore"] = target
    return data


def wait_connected(layout: Layout, old_pid: int | None, after: float, timeout: int = HEALTH_SECONDS) -> bool:
    # This is LOCAL health only: launchd PID + fresh "connected" status from
    # the new process. An independent Server-side reconnect is a host drill.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pid = launch_pid(layout)
        if pid and pid != old_pid:
            try:
                if layout.local_status.is_symlink():
                    raise ValueError("Symlinked local status")
                state = json.loads(layout.local_status.read_text())
                timestamp = datetime.fromisoformat(state["updatedAt"].replace("Z", "+00:00"))
                if (state.get("pid") == pid and state.get("state") == "connected" and
                    timestamp.timestamp() >= after):
                    return True
            except (OSError, ValueError, KeyError, TypeError):
                pass
        time.sleep(0.5)
    return False


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def cutover(layout: Layout, plist: bytes) -> None:
    decode_plist(plist, layout)
    # Do not launch two copies of the same Node identity while the prior
    # launchd process is still shutting down. Bootout may return before the
    # underlying process exits; fail closed and preserve the pending journal.
    prior_pid = launch_pid(layout)
    if launch_loaded(layout, layout.target):
        command("launchctl", "bootout", layout.target)
    if prior_pid is not None:
        for _ in range(20):
            if not pid_exists(prior_pid):
                break
            time.sleep(0.5)
        else:
            raise Refused("Previous Node PID still running after launchd bootout.")
    atomic_write(layout.plist, plist)
    command("launchctl", "bootstrap", f"gui/{layout.uid}", str(layout.plist))


def clear_pending(layout: Layout) -> None:
    layout.pending.unlink()
    folder = os.open(layout.state, os.O_RDONLY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def complete(layout: Layout, candidate: bytes, current: bytes, action: str) -> None:
    prior_pid = launch_pid(layout)
    # The earlier preflight PID can disappear before we acquire this value.
    # Refuse before journalling: recovery requires a positive oldPid to
    # distinguish the original Node from any detached/orphaned process.
    if prior_pid is None:
        raise Refused("Current launchd Node exited before activation; no journal written.")
    # Recovery always points at a safe, chosen working target. On an
    # interrupted explicit rollback we must NOT restore rejected code.
    restore = candidate if action == "rollback" else current
    if layout.previous.is_symlink():
        raise Refused("Previous rollback target must not be a symlink.")
    previous_before = exact_plist_bytes(layout.previous, layout.uid) if layout.previous.exists() else None
    started = time.time()
    json_write(layout.pending, {
        "schema": 1, "action": action, "started": started,
        "oldPid": prior_pid,
        "recoverPlist": base64.b64encode(restore).decode(),
        "recoverSha256": hashlib.sha256(restore).hexdigest(),
        "previousPlist": base64.b64encode(current).decode() if action == "rollback" else None,
        "previousBefore": base64.b64encode(previous_before).decode() if previous_before is not None else None,
    })
    try:
        cutover(layout, candidate)
        if not wait_connected(layout, prior_pid, started):
            raise Refused("New launchd process did not confirm a fresh connected status.")
        atomic_write(layout.previous, current)
        clear_pending(layout)
    except (Refused, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Fail closed. Recover even if new bootstrap failed, and do not erase
        # the durable pending transaction unless recovery verifies healthy.
        if action == "activate":
            try:
                recover(layout, force=True)
            except (Refused, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass
        raise


def recover(layout: Layout, *, force: bool = False) -> bool:
    data = recover_record(layout)
    if data is None:
        return False
    if not force and time.time() - data["started"] < GRACE_SECONDS:
        return False  # An in-flight update still owns the normal operation lock.
    old_pid = launch_pid(layout)
    # A failed bootout can leave an orphan process which launchctl no longer
    # lists as a managed job. Do not bootstrap another copy of that identity.
    if old_pid != data["oldPid"] and pid_exists(data["oldPid"]):
        raise Refused("Old Node PID is still alive outside the managed launchd job.")
    started = time.time()
    cutover(layout, data["_restore"])
    if not wait_connected(layout, old_pid, started):
        raise Refused("Recovery booted but healthy reconnect is not confirmed; journal preserved.")
    if data["action"] == "rollback":
        atomic_write(layout.previous, data["_previous"])
    elif data["_previous_before"] is not None:
        atomic_write(layout.previous, data["_previous_before"])
    elif layout.previous.exists() or layout.previous.is_symlink():
        if layout.previous.is_symlink():
            raise Refused("Unexpected symlinked previous rollback record.")
        layout.previous.unlink()
        folder = os.open(layout.state, os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
    clear_pending(layout)
    return True


def watchdog_plist(layout: Layout, script: Path) -> bytes:
    return plistlib.dumps({
        "Label": RECOVERY_LABEL,
        "ProgramArguments": [sys.executable, str(script), "recover"],
        "RunAtLoad": True, "StartInterval": 60,
        "StandardOutPath": str(layout.home / "Library/Logs/Atlas/node-recover.log"),
        "StandardErrorPath": str(layout.home / "Library/Logs/Atlas/node-recover-error.log"),
    }, fmt=plistlib.FMT_XML)


def require_watchdog(layout: Layout) -> None:
    require_private(layout.state, layout.uid)
    script = layout.recovery_script
    if script.is_symlink() or not script.is_file() or not script.read_bytes() == Path(__file__).read_bytes():
        raise Refused("Recovery watchdog is missing or outdated; install it first.")
    existing = exact_plist_bytes(layout.recovery_plist, layout.uid)
    if existing != watchdog_plist(layout, script) or not launch_loaded(layout, layout.recovery_target):
        raise Refused("Recovery LaunchAgent is missing, modified or not loaded.")


def install_watchdog(layout: Layout) -> None:
    # Explicit action only. The watchdog executes with the same user, never
    # root. Provision no unattended installer or update policy.
    if layout.pending.exists() or layout.pending.is_symlink():
        raise Refused("Cannot repair a watchdog while recovery is pending.")
    if launch_loaded(layout, layout.recovery_target):
        raise Refused("Recovery LaunchAgent is already loaded; refusing to overwrite it.")
    # A prior bootstrap may fail after the private files were installed.
    # Only resume an identical, owned on-disk installation. Never replace
    # unexpected watchdog bytes or a different user's LaunchAgent.
    src = Path(__file__).read_bytes()
    script = layout.recovery_script
    if script.exists() or script.is_symlink():
        require_private(script, layout.uid, directory=False)
        if script.read_bytes() != src:
            raise Refused("Existing recovery script differs; manual inspection required.")
    else:
        atomic_write(script, src)
    layout.recovery_plist.parent.mkdir(parents=True, exist_ok=True)
    logs = layout.home / "Library/Logs/Atlas"
    logs.mkdir(parents=True, exist_ok=True)
    expected_plist = watchdog_plist(layout, script)
    if layout.recovery_plist.exists() or layout.recovery_plist.is_symlink():
        if exact_plist_bytes(layout.recovery_plist, layout.uid) != expected_plist:
            raise Refused("Existing recovery plist differs; manual inspection required.")
    else:
        atomic_write(layout.recovery_plist, expected_plist)
    # If bootstrap fails, leave these exact files available for a safe retry.
    # Never delete or overwrite a potentially running watchdog.
    command("launchctl", "bootstrap", f"gui/{layout.uid}", str(layout.recovery_plist))
    require_watchdog(layout)


def manage(layout: Layout, argv: list[str]) -> None:
    action = argv[0] if argv else ""
    if action == "plan" and len(argv) == 2:
        release = release_path(layout, argv[1])
        current = decode_plist(exact_plist_bytes(layout.plist, layout.uid), layout)
        print(json.dumps({"staged": str(release), "runningEntrypoint": current["ProgramArguments"][1],
                          "identityConfigPath": current["EnvironmentVariables"]["ATLAS_NODE_ENV_FILE"],
                          "action": "plan-only; no Node change"}, indent=2))
        return
    if action not in ("status", "install-watchdog", "activate", "rollback", "recover"):
        raise Refused("Usage: status | plan vVERSION-SHA | install-watchdog | activate vVERSION-SHA --confirm | rollback --confirm | recover")
    if action == "activate" and (len(argv) != 3 or argv[2] != "--confirm"):
        raise Refused("Activation requires an exact staged version and --confirm.")
    if action == "rollback" and argv != ["rollback", "--confirm"]:
        raise Refused("Rollback requires --confirm.")
    if action in ("status", "install-watchdog", "recover") and len(argv) != 1:
        raise Refused("Unexpected arguments.")
    with lock_state(layout):
        if action == "status":
            print(json.dumps({"launchdPid": launch_pid(layout), "recoveryPending": layout.pending.exists(),
                              "previousRecorded": layout.previous.exists()}, indent=2))
        elif action == "install-watchdog":
            install_watchdog(layout)
            print("Per-user recovery LaunchAgent installed; no update activated.")
        elif action == "recover":
            print("Recovered interrupted Node activation." if recover(layout) else "No overdue recovery.")
        else:
            require_watchdog(layout)
            if layout.pending.exists() or layout.pending.is_symlink():
                raise Refused("Pending transaction requires recovery; refusing another update.")
            current = exact_plist_bytes(layout.plist, layout.uid)
            decode_plist(current, layout)
            if launch_pid(layout) is None:
                raise Refused("Current launchd Node has no live PID.")
            if action == "activate":
                selected = release_path(layout, argv[1])
                if decode_plist(current, layout)["ProgramArguments"][1] == str(selected / ENTRYPOINT):
                    raise Refused("Selected Node release is already active.")
                new = make_plist(current, layout, selected)
                complete(layout, new, current, action)
            else:
                prior = exact_plist_bytes(layout.previous, layout.uid)
                decode_plist(prior, layout)
                if prior == current:
                    raise Refused("Previous LaunchAgent is identical to current.")
                complete(layout, prior, current, action)
            print("Node " + action + " completed with local PID/connected status verified.")


def guard_atlasctl(argv: list[str]) -> int:
    # atlasctl delegates each hosted/launchd mutation through this helper.
    # Keep the *same* advisory lock for the full Node process, including a
    # potentially slow development build before launchctl bootout/bootstrap.
    if len(argv) < 2 or not os.path.isabs(argv[0]):
        raise Refused("Expected an absolute Node executable and atlasctl action.")
    test_root = os.environ.get("ATLAS_CONTROL_TEST_ROOT")
    test_platform = os.environ.get("ATLAS_CONTROL_TEST_PLATFORM")
    if sys.platform != "darwin" and not (test_root and test_platform == "darwin"):
        raise Refused("Atlas launchd locking requires macOS.")
    if os.geteuid() == 0 and not test_root:
        raise Refused("Never manage the user's LaunchAgent as root.")
    home = Path(test_root) / "home" if test_root else Path.home()
    layout = Layout(home, os.getuid())
    layout.app.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock_state(layout) as lock_fd:
        env = os.environ.copy()
        env["ATLAS_CONTROL_LIFECYCLE_LOCK_HELD"] = "1"
        # Pass the locked descriptor to the child. If the Python supervisor
        # dies, the Node process still holds the flock until it exits.
        result = subprocess.run([argv[0], str(Path(__file__).with_name("atlas-control.mjs")),
                                 *argv[1:]], env=env, check=False, pass_fds=(lock_fd,))
        return result.returncode if result.returncode >= 0 else 1


def main(argv: list[str]) -> int:
    if sys.platform != "darwin" or os.geteuid() == 0:
        raise Refused("Only the logged-in, non-root macOS operator may manage launchd.")
    layout = Layout(Path.home(), os.getuid())
    if not layout.app.is_dir() or not layout.releases.is_dir():
        raise Refused("Stage a signed Node release before using the lifecycle.")
    manage(layout, argv)
    return 0


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "guard-atlasctl":
            sys.exit(guard_atlasctl(sys.argv[2:]))
        sys.exit(main(sys.argv[1:]))
    except (Refused, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired,
            BlockingIOError, ValueError) as exc:
        print("Atlas macOS Node lifecycle:", exc, file=sys.stderr)
        sys.exit(1)
