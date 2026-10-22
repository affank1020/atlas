#!/usr/bin/env python3
"""Root-only, operator-invoked Linux Node update executor.

A Server claim is NOT approval. This command requires a separate unexpired
local root approval, verified GitHub build attestation and immutable archive
identity before it asks the Server to consume a request. It cannot be run by
the unprivileged Node, an MCP tool or a background worker.

There is deliberately NO retry of a one-use claim: after a lost reply or
crash, the durable local record requires human reconciliation.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

APPROVAL_SCRIPT = Path("/usr/local/libexec/atlas-node-update-approval")
TRUSTED_STAGE = Path("/usr/local/libexec/linux-node-trusted-stage.sh")
RELEASE_CHECK = Path("/usr/local/libexec/linux-node-release.sh")
LIFECYCLE = Path("/usr/local/libexec/atlas-node-lifecycle.sh")
STATE = Path("/var/lib/atlas-node-update-approvals")
NODE_ENV = Path("/etc/atlas-node/node.env")
RELEASE_ROOT = Path("/opt/atlas-node")
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_BUNDLE = 16 * 1024 * 1024
MAX_SMALL_FILE = 32 * 1024
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent",
            "LC_ALL": "C", "GH_HOST": "github.com"}
HEX64 = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,}$")


class Refused(RuntimeError):
    pass


def canonical_id(value: str) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value) or str(uuid.UUID(value)) != value:
        raise Refused("Invalid canonical intent UUID.")
    return value


def secure_executable(path: Path) -> None:
    """Do not execute stale, symlinked or unprivileged-writable root tools."""
    current = path
    while True:
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o022):
            raise Refused("Unsafe root-owned executable or parent: " + str(current))
        if current == path and not stat.S_ISREG(info.st_mode):
            raise Refused("Expected a regular root-owned executable.")
        if current == current.parent:
            break
        current = current.parent


def load_approval_module():
    secure_executable(APPROVAL_SCRIPT)
    loader = importlib.machinery.SourceFileLoader("atlas_root_approval", str(APPROVAL_SCRIPT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise Refused("Cannot load the installed host approval component.")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def read_node_config(path: Path) -> dict[str, str]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o022):
        raise Refused("Host Node config must be a root-owned regular file.")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, MAX_SMALL_FILE + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_SMALL_FILE:
        raise Refused("Host Node config is oversized.")
    wanted = {"ATLAS_NODE_ID", "ATLAS_NODE_CREDENTIAL", "ATLAS_SERVER_URL"}
    found: dict[str, str] = {}
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or key not in wanted:
            continue
        if key in found:
            raise Refused("Duplicate Node configuration key.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        found[key] = value
    if set(found) != wanted or not TOKEN.fullmatch(found["ATLAS_NODE_CREDENTIAL"]):
        raise Refused("Node identity or Server URL missing from private config.")
    canonical_id(found["ATLAS_NODE_ID"])
    return found


def claim_url(websocket_url: str) -> str:
    parsed = urllib.parse.urlsplit(websocket_url)
    if (parsed.scheme not in ("ws", "wss") or parsed.path != "/node/connect" or
            parsed.query or parsed.fragment or parsed.username or parsed.password or
            not parsed.hostname or parsed.netloc.endswith("@")):
        raise Refused("Invalid configured Atlas Node Server address.")
    try:
        port = parsed.port  # Raises ValueError for malformed ports.
    except ValueError as exc:
        raise Refused("Invalid Atlas Server port.") from exc
    if port is not None and not (1 <= port <= 65535):
        raise Refused("Invalid Atlas Server port.")
    if parsed.scheme == "ws" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise Refused("Remote Node claims require authenticated TLS (wss://).")
    return urllib.parse.urlunsplit(("https" if parsed.scheme == "wss" else "http",
                                    parsed.netloc, "/node/update-intents/claim", "", ""))


def validate_claim_response(response: object, grant: dict) -> dict:
    if not isinstance(response, dict) or not isinstance(response.get("intent"), dict):
        raise Refused("Malformed Server claim response.")
    intent = response["intent"]
    matches = {"id": grant["intentId"], "nodeId": grant["nodeId"],
               "installedVersion": grant["installedVersion"],
               "targetVersion": grant["targetVersion"],
               "targetCommit": grant["targetCommit"],
               "targetSourceCommit": grant["targetSourceCommit"],
               "targetSha256": grant["targetSha256"], "status": "claimed",
               "approved": False, "executable": False}
    if any(intent.get(k) != v for k, v in matches.items()):
        raise Refused("Server claim identity or state did not match the host approval.")
    if not isinstance(intent.get("resolvedAt"), str) or not intent["resolvedAt"]:
        raise Refused("Server claim has no durable resolution timestamp.")
    return intent


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def claim_server(url: str, node_id: str, token: str, grant: dict) -> dict:
    body = json.dumps({"intentId": grant["intentId"],
                       "expectedInstalledVersion": grant["installedVersion"],
                       "targetSha256": grant["targetSha256"]}, separators=(",", ":")).encode()
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": "Bearer " + token, "x-atlas-node-id": node_id,
        "Content-Type": "application/json", "Accept": "application/json"})
    # No inherited proxies, URL redirects or credential-bearing exception logs.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    try:
        with opener.open(request, timeout=10) as reply:
            if reply.status != 200 or int(reply.headers.get("Content-Length", "0")) > MAX_SMALL_FILE:
                raise Refused("Server did not accept the one-time claim.")
            raw = reply.read(MAX_SMALL_FILE + 1)
        if len(raw) > MAX_SMALL_FILE:
            raise Refused("Server claim response exceeds limit.")
        return validate_claim_response(json.loads(raw), grant)
    except (urllib.error.URLError, TimeoutError, ValueError, UnicodeError) as exc:
        # Do not print the full urllib error; it may contain private URL data.
        raise Refused("Server claim failed or response uncertain; do not retry.") from None


def digest_file(path: Path, max_bytes: int) -> str:
    digest = hashlib.sha256()
    size = 0
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > max_bytes:
            raise Refused("Invalid or oversized release input.")
        while True:
            block = os.read(fd, min(1024 * 1024, max_bytes + 1 - size))
            if not block:
                break
            size += len(block)
            if size > max_bytes:
                raise Refused("Release input exceeds its limit.")
            digest.update(block)
    finally:
        os.close(fd)
    return digest.hexdigest()


def copy_snapshot(source: Path, destination: Path, max_bytes: int) -> None:
    src = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        meta = os.fstat(src)
        if not stat.S_ISREG(meta.st_mode) or meta.st_size <= 0 or meta.st_size > max_bytes:
            raise Refused("Release input must be a small enough regular file.")
        dst = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            remaining = max_bytes
            while True:
                data = os.read(src, min(1024 * 1024, remaining + 1))
                if not data:
                    break
                remaining -= len(data)
                if remaining < 0:
                    raise Refused("Release input exceeds limit during snapshot.")
                view = memoryview(data)
                while view:
                    count = os.write(dst, view)
                    if count <= 0:
                        raise Refused("Unable to finish release snapshot write.")
                    view = view[count:]
            os.fsync(dst)
        finally:
            os.close(dst)
    finally:
        os.close(src)


def fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def archive_manifest(archive: Path) -> dict:
    try:
        with tarfile.open(archive, "r:gz") as tar:
            members = [m for m in tar.getmembers() if m.name == "./atlas-node-release.json"]
            if len(members) != 1 or not members[0].isfile() or members[0].size > 16384:
                raise Refused("Signed archive has invalid release manifest.")
            file = tar.extractfile(members[0])
            if file is None:
                raise Refused("Cannot read signed release manifest.")
            data = json.loads(file.read(16385))
            if not isinstance(data, dict):
                raise Refused("Invalid signed release manifest.")
            return data
    except (tarfile.TarError, json.JSONDecodeError, OSError, UnicodeError) as exc:
        raise Refused("Cannot inspect signed release metadata.") from None


def verify_snapshot(archive: Path, checksum: Path, bundle: Path, grant: dict,
                    runner=subprocess.run) -> None:
    name = "atlas-node-v" + grant["targetVersion"] + "-" + grant["targetCommit"] + ".tar.gz"
    if archive.name != name or checksum.name != name + ".sha256":
        raise Refused("Archive/checksum filenames do not match the approved target.")
    actual = digest_file(archive, MAX_ARCHIVE)
    if not HEX64.fullmatch(grant["targetSha256"]) or actual != grant["targetSha256"]:
        raise Refused("Archive bytes do not match the approved SHA-256.")
    sidecar = checksum.read_bytes()
    if sidecar != (actual + "  " + name + "\n").encode():
        raise Refused("Checksum sidecar does not match the exact approved archive.")
    if bundle.stat().st_size > MAX_BUNDLE:
        raise Refused("Attestation bundle exceeds 16 MiB.")
    manifest = archive_manifest(archive)
    if (manifest.get("application") != "@atlas/node" or manifest.get("protocol") != 2
            or manifest.get("entrypoint") != "apps/node/dist/platforms/desktop/main.js"
            or manifest.get("version") != grant["targetVersion"]
            or manifest.get("commit") != grant["targetSourceCommit"]):
        raise Refused("Signed archive metadata differs from the authorised target.")
    for script in (TRUSTED_STAGE, RELEASE_CHECK):
        secure_executable(script)
    # The trusted script verifies the actual GitHub Sigstore bundle offline,
    # matching repo, main branch, build workflow and immutable source digest.
    runner(["/usr/bin/bash", str(TRUSTED_STAGE), "verify",
            str(archive), str(checksum), str(bundle)], check=True, env=SAFE_ENV)


class ReceiptStore:
    """Fail-closed durable execution record; no automatic retry or replay."""

    def __init__(self, approval):
        self.approval = approval
        self.directory = approval.base / "execution"

    def _ensure(self):
        self.approval._check_directory(self.approval.base)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.approval._check_directory(self.directory)
        self.approval._sync_directory(self.approval.base)

    def _path(self, identifier: str) -> Path:
        return self.directory / (canonical_id(identifier) + ".json")

    def _write(self, record: dict, *, create: bool):
        self._ensure()
        raw = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(raw) > 16384:
            raise Refused("Execution receipt is too large.")
        fd, name = tempfile.mkstemp(prefix=".pending-", dir=self.directory)
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise Refused("Receipt write stopped before completion.")
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            if create:
                os.link(name, self._path(record["intentId"]), follow_symlinks=False)
            else:
                os.replace(name, self._path(record["intentId"]))
            fsync_dir(self.directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def read(self, identifier: str) -> dict | None:
        path = self._path(identifier)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or
                    info.st_size > 16384 or
                    (self.approval.owner_uid is not None and info.st_uid != self.approval.owner_uid) or
                    stat.S_IMODE(info.st_mode) & 0o077):
                raise Refused("Unsafe execution receipt.")
            with os.fdopen(fd, "r", encoding="utf-8", closefd=False) as file:
                value = json.load(file)
            if not isinstance(value, dict) or value.get("intentId") != identifier:
                raise Refused("Invalid execution receipt.")
            return value
        finally:
            os.close(fd)

    def mark(self, record: dict, stage: str, *, create=False):
        if stage not in {"claiming", "claimed", "installing", "activating",
                         "activated", "requires_reconciliation"}:
            raise Refused("Invalid execution stage.")
        value = {**record, "stage": stage}
        self._write(value, create=create)
        return value


def _execute(intent_id: str, archive: Path, checksum: Path, bundle: Path,
             *, approval_module, runner) -> dict:
    store = approval_module.ApprovalStore(STATE)
    receipts = ReceiptStore(store)
    with store.locked():
        if receipts.read(intent_id) is not None:
            raise Refused("This intent already has an execution receipt; reconcile, never retry.")
        grant = store._read(intent_id)
        if not grant or grant.get("status") != "approved" or approval_module.when(grant["notAfter"]) <= approval_module.clock():
            raise Refused("Missing or expired root-local host approval.")
        node_id = approval_module.read_host_node_id()
        installed = approval_module.read_installed_version()
        if grant["nodeId"] != node_id or grant["installedVersion"] != installed:
            raise Refused("Host Node or installed release changed since approval.")
        # Keep the root-owned private approval lock until a receipt is durably
        # written, preventing revocation/another executor from interleaving.
        for script in (LIFECYCLE,):
            secure_executable(script)
        configuration = read_node_config(NODE_ENV)
        if configuration["ATLAS_NODE_ID"] != node_id:
            raise Refused("Host Node credential config identity does not match approval.")
        endpoint = claim_url(configuration["ATLAS_SERVER_URL"])
        target_name = "v" + grant["targetVersion"] + "-" + grant["targetCommit"]
        if (RELEASE_ROOT / ".activation-pending").exists() or (RELEASE_ROOT / ".activation-pending").is_symlink():
            raise Refused("Interrupted activation requires independent recovery before update.")
        target_path = RELEASE_ROOT / "releases" / target_name
        if target_path.exists() or target_path.is_symlink():
            raise Refused("Target release is already installed. Manual reconciliation required.")

        # Snapshot untrusted caller inputs exactly once into root-private files.
        stage_dir = Path(tempfile.mkdtemp(prefix=".executor-input-", dir=store.base))
        fsync_dir(store.base)
        os.chmod(stage_dir, 0o700)
        archive_copy = stage_dir / ("atlas-node-" + target_name + ".tar.gz")
        checksum_copy = stage_dir / (archive_copy.name + ".sha256")
        bundle_copy = stage_dir / "attestations.jsonl"
        copy_snapshot(archive, archive_copy, MAX_ARCHIVE)
        copy_snapshot(checksum, checksum_copy, MAX_SMALL_FILE)
        copy_snapshot(bundle, bundle_copy, MAX_BUNDLE)
        fsync_dir(stage_dir)
        verify_snapshot(archive_copy, checksum_copy, bundle_copy, grant, runner)
        # Do not consume either one-use approval when an existing lifecycle
        # is unresolved or the independent recovery timer cannot run.
        for action, unit in (
            ("is-enabled", "atlas-node-lifecycle-recover.timer"),
            ("is-active", "atlas-node-lifecycle-recover.timer"),
            ("is-active", "atlas-node.service"),
        ):
            runner(["/usr/bin/systemctl", action, "--quiet", unit],
                   check=True, env=SAFE_ENV)

        print("Node: " + node_id + "\nInstalled: " + installed +
              "\nTarget: " + target_name + "\nDigest: " + grant["targetSha256"])
        exact = "EXECUTE " + intent_id
        if input("Type '" + exact + "' to consume both approvals and update this host: ") != exact:
            raise Refused("Host operator did not confirm execution.")
        # Re-validate fast-moving local state just before the irreversible
        # server claim; prolonged signature checks may outlast approval.
        if (approval_module.read_installed_version() != installed or
                approval_module.when(grant["notAfter"]) <= approval_module.clock()):
            raise Refused("Local release or host approval changed during verification.")
        record = {"schema": 1, "intentId": intent_id, "nodeId": node_id,
                  "installedVersion": installed, "targetVersion": grant["targetVersion"],
                  "targetCommit": grant["targetCommit"], "targetSha256": grant["targetSha256"]}
        record = receipts.mark(record, "claiming", create=True)
    # A network error after POST is ambiguous. There is NO automatic retry.
    try:
        claim_server(endpoint, node_id, configuration["ATLAS_NODE_CREDENTIAL"], grant)
    except Exception:
        receipts.mark(record, "requires_reconciliation")
        raise
    # We MUST drop the ApprovalStore flock before calling claim_once():
    # that method takes its own exclusive lock on a different open-file
    # description. Nesting those locks would deadlock the root executor.
    # If an administrator revokes during the Server request, claim_once
    # refuses and no privileged host mutation can occur.
    store.claim_once(intent_id, node_id, grant["targetSha256"], installed)
    record = receipts.mark(record, "claimed")

    # Host mutations happen only after BOTH one-use claims and signed bytes.
    # Input snapshots remain private and are not cleaned up on uncertainty.
    try:
        record = receipts.mark(record, "installing")
        runner(["/usr/bin/bash", str(TRUSTED_STAGE), "install",
                str(archive_copy), str(checksum_copy), str(bundle_copy)], check=True, env=SAFE_ENV)
        record = receipts.mark(record, "activating")
        runner(["/usr/bin/bash", str(LIFECYCLE), "plan", target_name], check=True, env=SAFE_ENV)
        runner(["/usr/bin/bash", str(LIFECYCLE), "activate", target_name], check=True, env=SAFE_ENV)
        if approval_module.read_installed_version() != grant["targetVersion"] + "+" + grant["targetCommit"]:
            raise Refused("Lifecycle returned without the intended active release.")
        record = receipts.mark(record, "activated")
        return record
    except Exception:
        receipts.mark(record, "requires_reconciliation")
        raise


def execute(intent_id: str, archive: Path, checksum: Path, bundle: Path,
            *, approval_module=None, runner=subprocess.run) -> dict:
    if sys.platform != "linux" or os.geteuid() != 0 or not os.isatty(0):
        raise Refused("Execute requires an interactive Linux root session.")
    approval_module = approval_module or load_approval_module()
    # A separate process-lifetime lock prevents two distinct update intents
    # from installing or activating concurrently. The approval ledger's
    # short transaction lock remains independent and is never nested with
    # claim_once(), avoiding a self-deadlock.
    store = approval_module.ApprovalStore(STATE)
    with store.locked():
        pass
    fd = os.open(STATE / ".executor.lock",
                 os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o077):
            raise Refused("Unsafe root-only executor lock.")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Refused("Another host Node update is already in progress.") from None
        return _execute(intent_id, archive, checksum, bundle,
                        approval_module=approval_module, runner=runner)
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description="Host-root, one-shot Atlas Linux update (manual only)")
    commands = parser.add_subparsers(dest="action", required=True)
    install = commands.add_parser("execute", help="requires interactive root approval")
    install.add_argument("intent_id")
    install.add_argument("archive", type=Path)
    install.add_argument("checksum", type=Path)
    install.add_argument("attestations", type=Path)
    status = commands.add_parser("status", help="inspect local execution receipt")
    status.add_argument("intent_id")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        raise Refused("Linux root is required.")
    identifier = canonical_id(args.intent_id)
    if args.action == "execute":
        print(json.dumps(execute(identifier, args.archive, args.checksum, args.attestations),
                         sort_keys=True))
    else:
        approval = load_approval_module()
        print(json.dumps(ReceiptStore(approval.ApprovalStore(STATE)).read(identifier),
                         sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (Refused, ValueError, OSError, subprocess.CalledProcessError) as error:
        # Never print credentials, request objects or urllib exception text.
        print("Atlas Node execution refused: host approval, signed release or "
              "lifecycle failed. Inspect private execution receipt.", file=sys.stderr)
        raise SystemExit(1)
