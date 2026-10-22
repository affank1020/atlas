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
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+[.][0-9]+[.][0-9]+[+][0-9a-f]{12}$")
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}


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


def live_pid(status_path: Path = NODE_STATUS, runner=subprocess.run) -> int:
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


def attest(intent_id: str, challenge: str, *, executor=None,
           key: Path = HOST_KEY, signer=openssl_sign, runner=subprocess.run) -> dict:
    if not UUID.fullmatch(intent_id) or not SHA.fullmatch(challenge):
        raise Refused("Canonical intent UUID and 64-character nonce are required.")
    executor = executor or import_executor()
    approval = executor.load_approval_module()
    store = approval.ApprovalStore(executor.STATE)
    # Take the same host-exclusive execution lock so a second executor cannot
    # mutate the host concurrently with snapshot collection. Do not trust any
    # command arguments for release identity; use root-owned receipt and host.
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
        if input("Type 'ATTEST " + intent_id +
                 "' to sign this host snapshot (NOT reconciliation): ") != "ATTEST " + intent_id:
            raise Refused("Operator declined root evidence signing.")
        # Recheck local state following interactive confirmation. A later,
        # Server-issued challenge will also need an expiry/nonce fence.
        if approval.read_installed_version() != expected or pending.exists() or pending.is_symlink():
            raise Refused("Host release or recovery state changed before signing.")
        fields["observedPid"] = live_pid(runner=runner)
        return {**fields, "signature": base64.b64encode(
            signer(signed_bytes(fields), key)).decode("ascii")}


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
