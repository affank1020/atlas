#!/usr/bin/env python3
"""Manual host-root attestation for a *future* independent reconciliation flow.

This emits a signed, challenge-bound observation. No HTTP request, Node
credential, remote key registration, update operation or Server claim happens.
The recipient must use an independently pinned Ed25519 PUBLIC key. The
attestation is not itself sufficient to clear a claimed intent.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

EXECUTOR = Path("/usr/local/libexec/atlas-node-update-executor")
HOST_KEY = Path("/etc/atlas-node/update-evidence-ed25519.key")
NODE_STATUS = Path("/var/lib/atlas-node/.local/state/atlas/node-status.json")
LIFECYCLE_LOCK = Path("/run/lock/atlas-node-lifecycle.lock")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+[.][0-9]+[.][0-9]+[+][0-9a-f]{12}$")
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}
# Node publishes status every 10 seconds. Allow delayed scheduling, but never
# sign an arbitrarily old "connected" record or one far in the future.
HEARTBEAT_MAX_AGE = dt.timedelta(seconds=35)
HEARTBEAT_FUTURE_SKEW = dt.timedelta(seconds=5)
UTC_STATUS_TIME = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$")


class Refused(RuntimeError):
    pass


def import_executor(path: Path = EXECUTOR):
    parent = path
    while True:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise Refused("Executor is not under root-owned, non-writable directories.")
        if parent == path and not stat.S_ISREG(info.st_mode):
            raise Refused("Executor must be a regular root-owned file.")
        if parent == parent.parent:
            break
        parent = parent.parent
    loader = importlib.machinery.SourceFileLoader("atlas_update_executor", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise Refused("Cannot load installed root-owned executor.")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def check_private_key(path: Path) -> None:
    parent = path.parent
    while True:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise Refused("Host-root key directory is not root controlled.")
        if parent == parent.parent:
            break
        parent = parent.parent
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077:
        raise Refused("Root Ed25519 private key must be regular, root-owned and mode 0600.")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        actual = os.fstat(fd)
        if (not stat.S_ISREG(actual.st_mode) or actual.st_uid != 0 or
                stat.S_IMODE(actual.st_mode) & 0o077 or
                (info.st_dev, info.st_ino) != (actual.st_dev, actual.st_ino)):
            raise Refused("Host-root private key changed during secure open.")
    finally:
        os.close(fd)


@contextlib.contextmanager
def hold_lifecycle_lock(path: Path = LIFECYCLE_LOCK, *, owner_uid: int = 0):
    """Acquire the SAME flock as manual activate/rollback/recover.

    The executor's private flock does not serialize with manual lifecycle
    operators. Keep this lifecycle lock from BEFORE sampling the current
    symlink until the Ed25519 signature has been written.
    """
    parent = path.parent
    while True:
        info = parent.lstat()
        # Ubuntu's standard /run/lock is root-owned but mode 01777.
        # The sticky bit protects root-owned lock entries from replacement;
        # the lock file itself must still be root-owned and not writable
        # by unprivileged processes. Never extend this to arbitrary /tmp.
        sticky_system_lock = (parent == Path("/run/lock") and
                              path == LIFECYCLE_LOCK and
                              bool(info.st_mode & stat.S_ISVTX))
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid or
                (stat.S_IMODE(info.st_mode) & 0o022 and not sticky_system_lock)):
            raise Refused("Lifecycle lock parent is not root controlled.")
        if parent == parent.parent:
            break
        parent = parent.parent
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or
                stat.S_IMODE(info.st_mode) & 0o022):
            raise Refused("Unsafe lifecycle lock file.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Another manual lifecycle operation is in progress.") from None
        yield
    finally:
        os.close(fd)


def live_pid(status_path: Path = NODE_STATUS, runner=subprocess.run,
             *, now: dt.datetime | None = None) -> int:
    runner(["/usr/bin/systemctl", "is-active", "--quiet", "atlas-node.service"],
           check=True, env=SAFE_ENV)
    result = runner(["/usr/bin/systemctl", "show", "atlas-node.service",
                     "-p", "MainPID", "--value"],
                    check=True, capture_output=True, text=True, env=SAFE_ENV)
    raw = result.stdout.strip()
    if not raw.isascii() or not raw.isdigit() or not (1 < int(raw) <= 0x7fffffff):
        raise Refused("Node systemd MainPID is invalid.")
    pid = int(raw)
    # The status record is a Node-originated observation, NOT cryptographic
    # evidence that a particular JS build is running. The independent
    # verifier must treat it accordingly.
    with status_path.open("rb") as handle:
        raw_status = handle.read(32769)
    if len(raw_status) > 32768:
        raise Refused("Node live status is too large.")
    status = json.loads(raw_status)
    if not isinstance(status, dict) or status.get("state") != "connected" or status.get("pid") != pid:
        raise Refused("Live Node PID and connected status are inconsistent.")
    heartbeat = status.get("updatedAt")
    if not isinstance(heartbeat, str) or not UTC_STATUS_TIME.fullmatch(heartbeat):
        raise Refused("Node status has no canonical UTC heartbeat timestamp.")
    try:
        updated_at = dt.datetime.strptime(heartbeat, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise Refused("Node heartbeat timestamp is invalid.") from None
    observed_at = now if now is not None else dt.datetime.now(dt.timezone.utc)
    if observed_at.tzinfo is None:
        raise Refused("Cannot assess heartbeat freshness without a timezone.")
    age = observed_at - updated_at
    if age > HEARTBEAT_MAX_AGE or age < -HEARTBEAT_FUTURE_SKEW:
        raise Refused("Node connected heartbeat is stale or from the future.")
    return pid


def signed_bytes(fields: dict) -> bytes:
    return ("\n".join([
        "atlas-node-root-update-attestation-v1",
        fields["nodeId"],
        fields["intentId"],
        fields["challenge"],
        fields["activeVersion"],
        fields["targetSha256"],
        str(fields["observedPid"]),
        "",
    ])).encode("utf-8")


def openssl_sign(data: bytes, key: Path, runner=subprocess.run) -> bytes:
    check_private_key(key)
    # The fixed local OpenSSL binary reads a root-only key; the content never
    # appears on argv, in a Node RPC or in an environment variable.
    with tempfile.TemporaryDirectory(prefix="atlas-root-evidence-") as dirname:
        directory = Path(dirname)
        message = directory / "message"
        signature = directory / "signature"
        message.write_bytes(data)
        message.chmod(0o600)
        runner(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin",
                "-inkey", str(key), "-in", str(message), "-out", str(signature)],
               check=True, env=SAFE_ENV, stdout=subprocess.DEVNULL,
               stderr=subprocess.DEVNULL)
        raw = signature.read_bytes()
    if len(raw) != 64:
        raise Refused("Ed25519 host-root signature must be 64 bytes.")
    return raw


def _attest(intent_id: str, challenge: str, *, executor,
            key: Path, signer, runner) -> dict:
    if not UUID.fullmatch(intent_id) or not SHA.fullmatch(challenge):
        raise Refused("Canonical intent UUID and 64-character nonce are required.")
    approval = executor.load_approval_module()
    store = approval.ApprovalStore(executor.STATE)
    # The wrapper holds the host's process-wide executor lock. The approval
    # ledger lock here protects the root-owned receipt against local writers.
    # Do not trust command arguments for release identity.
    with store.locked():
        receipt = executor.ReceiptStore(store).read(intent_id)
        if not receipt or receipt.get("stage") != "activated":
            raise Refused("Only a durable activated root-owned receipt can be signed.")
        node_id = approval.read_host_node_id()
        if receipt.get("nodeId") != node_id or not UUID.fullmatch(node_id):
            raise Refused("Host identity does not match the receipt.")
        expected = receipt.get("targetVersion", "") + "+" + receipt.get("targetCommit", "")
        if not VERSION.fullmatch(expected) or approval.read_installed_version() != expected:
            raise Refused("Active release differs from the signed execution receipt.")
        if not SHA.fullmatch(str(receipt.get("targetSha256", ""))):
            raise Refused("Invalid receipt archive digest.")
        pending = executor.RELEASE_ROOT / ".activation-pending"
        if pending.exists() or pending.is_symlink():
            raise Refused("Host activation or recovery is still pending.")
        pid = live_pid(runner=runner)
        fields = {
            "schema": 1,
            "nodeId": node_id,
            "intentId": intent_id,
            "challenge": challenge,
            "activeVersion": expected,
            "targetSha256": receipt["targetSha256"],
            "observedPid": pid,
        }
        # The operator already confirmed OUTSIDE every lock in attest().
        # Do not introduce a human-controlled wait in this critical section:
        # the lifecycle recovery timer and emergency rollback need the flock.
        # Re-sample immediately before signing, under both exclusive locks.
        if approval.read_installed_version() != expected or pending.exists() or pending.is_symlink():
            raise Refused("Host release or recovery state changed before signing.")
        if live_pid(runner=runner) != pid:
            raise Refused("Host Node process changed during root evidence collection.")
        return {**fields, "signature": base64.b64encode(
            signer(signed_bytes(fields), key)).decode("ascii")}


def attest(intent_id: str, challenge: str, *, executor=None,
           key: Path = HOST_KEY, signer=openssl_sign, runner=subprocess.run) -> dict:
    if sys.platform != "linux" or os.geteuid() != 0 or not os.isatty(0):
        raise Refused("Interactive Linux root terminal required.")
    if not UUID.fullmatch(intent_id) or not SHA.fullmatch(challenge):
        raise Refused("Canonical intent UUID and 64-character nonce are required.")
    # A stalled/abandoned operator must NEVER monopolize the lifecycle,
    # executor or approval ledger locks. Take a fresh, complete host snapshot
    # only AFTER confirmation, while holding all three locks.
    if input("Type 'ATTEST " + intent_id +
             "' to verify and sign host evidence (NOT reconciliation): ") != "ATTEST " + intent_id:
        raise Refused("Operator declined root evidence signing.")
    executor = executor or import_executor()
    approval = executor.load_approval_module()
    store = approval.ApprovalStore(executor.STATE)
    # Same process-wide executor lock first, then the short approval ledger
    # lock inside _attest. This preserves lock order and excludes concurrent
    # root-managed executions from changing the source while signing.
    with store.locked():
        pass
    fd = os.open(executor.STATE / ".executor.lock",
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077:
            raise Refused("Unsafe process-wide executor lock.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Another root-managed update is in progress.") from None
        # Legacy/manual lifecycle uses this different flock. The unbounded
        # operator prompt has already completed: protect ONLY verification and
        # signing, so rollback/recover never waits for human confirmation.
        with hold_lifecycle_lock():
            return _attest(intent_id, challenge, executor=executor,
                           key=key, signer=signer, runner=runner)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Root-only offline update evidence; no Server mutation")
    parser.add_argument("intent_id")
    parser.add_argument("challenge", help="64 lowercase hex bytes from a future Server challenge")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0 or not os.isatty(0):
        raise Refused("Interactive Linux root terminal required.")
    print(json.dumps(attest(args.intent_id,args.challenge),sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refused, ValueError, OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        print("Atlas host-root evidence refused; no update or Server operation was performed.",
              file=sys.stderr)
        raise SystemExit(1)
