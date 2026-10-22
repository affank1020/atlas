#!/usr/bin/env python3
"""Host-local, single-use authorisation store for Atlas Linux Node updates.

This component deliberately NEVER downloads, installs, activates or rolls back
software. Its root-only CLI can authorise an independently reviewed intent;
claim_once() is a library primitive reserved for a future privileged executor
that MUST first revalidate the live intent and signed release provenance.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import tempfile
import uuid

UTC = dt.timezone.utc
STATE = Path("/var/lib/atlas-node-update-approvals")
NODE_ENV = Path("/etc/atlas-node/node.env")
RELEASE_ROOT = Path("/opt/atlas-node")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
INSTALLED = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\+[a-f0-9]{12}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
SHORT_COMMIT = re.compile(r"^[a-f0-9]{12}$")
MAX_INTENT_BYTES = 32 * 1024


class Refused(ValueError):
    """A validation or safety gate refused a mutation."""


def clock() -> dt.datetime:
    return dt.datetime.now(UTC)


def iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def when(value: object) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise Refused("Expected a UTC timestamp ending in Z.")
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Refused("Invalid timestamp.") from exc
    if stamp.utcoffset() != dt.timedelta(0):
        raise Refused("Expected UTC timestamp.")
    return stamp


def canonical_uuid(value: object) -> str:
    if not isinstance(value, str):
        raise Refused("Expected canonical UUID.")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise Refused("Invalid UUID.") from exc
    if str(parsed) != value:
        raise Refused("UUID must be canonical lowercase.")
    return value


def validate_intent(intent: object, host_node_id: str, installed: str, now: dt.datetime) -> dict:
    if not isinstance(intent, dict):
        raise Refused("Intent must be a JSON object.")
    expected = {"id", "nodeId", "installedVersion", "targetVersion", "targetCommit",
                "targetSourceCommit", "targetSha256", "status", "createdAt",
                "expiresAt", "resolvedAt", "approved", "executable"}
    if set(intent) != expected:
        raise Refused("Intent fields do not match the Atlas update-intent contract.")
    intent_id = canonical_uuid(intent["id"])
    node_id = canonical_uuid(intent["nodeId"])
    if node_id != canonical_uuid(host_node_id):
        raise Refused("Intent belongs to a different Node.")
    if not isinstance(intent["installedVersion"], str) or not INSTALLED.fullmatch(intent["installedVersion"]):
        raise Refused("Installed build identity must include the source commit.")
    if intent["installedVersion"] != installed:
        raise Refused("Installed release changed since the request was prepared.")
    version, short, source, digest = (intent["targetVersion"], intent["targetCommit"],
                                      intent["targetSourceCommit"], intent["targetSha256"])
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise Refused("Target must be a stable SemVer release.")
    if not isinstance(short, str) or not SHORT_COMMIT.fullmatch(short):
        raise Refused("Invalid target commit.")
    if not isinstance(source, str) or not COMMIT.fullmatch(source) or source[:12] != short:
        raise Refused("Source commit does not match the target.")
    if not isinstance(digest, str) or not SHA.fullmatch(digest):
        raise Refused("Invalid target archive SHA-256.")
    if (intent["status"] != "requested" or intent["resolvedAt"] is not None
            or intent["approved"] is not False or intent["executable"] is not False):
        raise Refused("Only unapproved, non-executable, outstanding intents can be considered.")
    created, expires = when(intent["createdAt"]), when(intent["expiresAt"])
    if created > now + dt.timedelta(seconds=30):
        raise Refused("Intent creation time is in the future.")
    if not (created < expires <= created + dt.timedelta(minutes=15)) or expires <= now:
        raise Refused("Intent is expired or has an invalid lifetime.")
    return {"intentId": intent_id, "nodeId": node_id, "installedVersion": installed,
            "targetVersion": version, "targetCommit": short,
            "targetSourceCommit": source, "targetSha256": digest,
            "notAfter": iso(min(expires, now + dt.timedelta(minutes=5)))}


def read_host_node_id(env_path: Path = NODE_ENV) -> str:
    # This privileged check reads the existing Node config only to bind its
    # non-secret ID; never print/emit the content or the credential.
    if env_path.is_symlink() or not env_path.is_file():
        raise Refused("Host Node config is missing or symlinked.")
    if env_path == NODE_ENV:
        info = env_path.stat()
        if info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o022):
            raise Refused("Host Node config is not securely owned.")
    values = []
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        match = re.fullmatch(r"ATLAS_NODE_ID\s*=\s*['\"]?([0-9a-fA-F-]+)['\"]?", line)
        if match:
            values.append(match.group(1))
    if len(values) != 1:
        raise Refused("Host config must declare one ATLAS_NODE_ID.")
    return canonical_uuid(values[0])


def read_installed_version(root: Path = RELEASE_ROOT) -> str:
    if root.is_symlink():
        raise Refused("Release root must not be symlinked.")
    if root == RELEASE_ROOT:
        for protected in (root, root / "releases"):
            info = protected.stat()
            if info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o022):
                raise Refused("Installed release tree is not root-owned and immutable.")
    releases = root / "releases"
    current = root / "current"
    if not current.is_symlink():
        raise Refused("Host has no managed current release.")
    resolved = current.resolve(strict=True)
    if resolved.parent != releases.resolve(strict=True):
        raise Refused("Active release escapes the installed release tree.")
    manifest = resolved / "atlas-node-release.json"
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 16384:
        raise Refused("Invalid installed release manifest.")
    if root == RELEASE_ROOT:
        for protected in (resolved, manifest):
            info = protected.stat()
            if info.st_uid != 0 or (stat.S_IMODE(info.st_mode) & 0o022):
                raise Refused("Installed release metadata is not root-owned and immutable.")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        version, commit = data["version"], data["commit"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise Refused("Cannot parse installed release manifest.") from exc
    if (data.get("application") != "@atlas/node" or data.get("protocol") != 2
            or data.get("entrypoint") != "apps/node/dist/platforms/desktop/main.js"
            or not isinstance(version, str) or not VERSION.fullmatch(version)
            or not isinstance(commit, str) or not COMMIT.fullmatch(commit)
            or resolved.name != f"v{version}-{commit[:12]}"):
        raise Refused("Installed release manifest is inconsistent.")
    return f"{version}+{commit[:12]}"


class ApprovalStore:
    """Root-owned, lock-serialised, fail-closed persistent grants."""

    def __init__(self, base: Path, *, owner_uid: int | None = 0):
        self.base = base
        self.owner_uid = owner_uid
        self.records = base / "records"

    def _check_directory(self, path: Path):
        if path.is_symlink() or not path.is_dir():
            raise Refused("Approval store directory must be real.")
        info = path.stat()
        if (self.owner_uid is not None and info.st_uid != self.owner_uid) or (stat.S_IMODE(info.st_mode) & 0o077):
            raise Refused("Approval store directory is not privately owned.")

    @staticmethod
    def _sync_directory(path: Path):
        """Persist the containing directory entry before acknowledging a grant.

        Syncing only records/ is insufficient on a newly provisioned host:
        its entry in the store root and the store root's entry in /var/lib
        also require independent fsync barriers.
        """
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def locked(self):
        self.base.mkdir(mode=0o700, exist_ok=True)
        self._check_directory(self.base)
        # Also sync on subsequent openings, to recover an interrupted first
        # initialization that left a visible but not yet durable directory.
        self._sync_directory(self.base.parent)
        self.records.mkdir(mode=0o700, exist_ok=True)
        self._check_directory(self.records)
        self._sync_directory(self.base)
        flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
        fd = os.open(self.base / ".lock", flags, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (stat.S_IMODE(info.st_mode) & 0o077):
                raise Refused("Unsafe approval lock file.")
            if self.owner_uid is not None and info.st_uid != self.owner_uid:
                raise Refused("Approval lock owner mismatch.")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _path(self, intent_id: str) -> Path:
        return self.records / (canonical_uuid(intent_id) + ".json")

    def _read(self, intent_id: str) -> dict | None:
        path = self._path(intent_id)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 16384
                    or stat.S_IMODE(info.st_mode) & 0o077
                    or (self.owner_uid is not None and info.st_uid != self.owner_uid)):
                raise Refused("Unsafe approval record.")
            with os.fdopen(fd, "rb", closefd=False) as file:
                data = json.load(file)
            if not isinstance(data, dict) or data.get("intentId") != intent_id or data.get("schema") != 1:
                raise Refused("Invalid persistent approval record.")
            return data
        finally:
            os.close(fd)

    def _store(self, record: dict, *, create: bool):
        path = self._path(record["intentId"])
        raw = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(raw) > 16384:
            raise Refused("Approval record too large.")
        fd, name = tempfile.mkstemp(prefix=".pending-", dir=self.records)
        try:
            os.fchmod(fd, 0o600)
            # A successful os.write may write fewer bytes than requested.
            # Never publish a truncated record, even under disk/quota pressure.
            data = memoryview(raw)
            written = 0
            while written < len(data):
                count = os.write(fd, data[written:])
                if count <= 0:
                    raise Refused("Approval record write made no progress.")
                written += count
            os.fsync(fd)
            os.close(fd)
            fd = -1
            if create:
                os.link(name, path, follow_symlinks=False)  # exclusive: no replay/overwrite
            else:
                os.replace(name, path)
            directory = os.open(self.records, os.O_DIRECTORY | os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if fd >= 0:
                os.close(fd)
            if os.path.exists(name):
                os.unlink(name)

    def approve(self, intent: object, host_node_id: str, installed: str,
                now: dt.datetime | None = None) -> dict:
        now = now or clock()
        checked = validate_intent(intent, host_node_id, installed, now)
        with self.locked():
            if self._read(checked["intentId"]) is not None:
                raise Refused("This intent was already approved or resolved: no replay.")
            for path in self.records.glob("*.json"):
                row = self._read(path.stem)
                if row and row.get("nodeId") == host_node_id and row.get("status") == "approved" and when(row["notAfter"]) > now:
                    raise Refused("Another unconsumed host approval is already active for this Node.")
            record = {"schema": 1, **checked, "approvedAt": iso(now),
                      "status": "approved", "resolvedAt": None,
                      "events": [{"action": "approved", "at": iso(now)}]}
            self._store(record, create=True)
            return record

    def status(self, intent_id: str, now: dt.datetime | None = None) -> dict | None:
        now = now or clock()
        with self.locked():
            record = self._read(intent_id)
            if record is None:
                return None
            return {**record, "effectiveStatus": (
                "expired" if record["status"] == "approved" and when(record["notAfter"]) <= now
                else record["status"])}

    def revoke(self, intent_id: str, now: dt.datetime | None = None) -> dict:
        now = now or clock()
        with self.locked():
            record = self._read(intent_id)
            if not record or record["status"] != "approved":
                raise Refused("Approval missing or no longer revocable.")
            record.update(status="revoked", resolvedAt=iso(now))
            record["events"].append({"action": "revoked", "at": iso(now)})
            self._store(record, create=False)
            return record

    def claim_once(self, intent_id: str, expected_node_id: str, expected_sha256: str,
                   installed: str, now: dt.datetime | None = None) -> dict:
        """Internal atomic primitive ONLY. Caller MUST separately revalidate
        a live, not-cancelled intent and cryptographically verify the archive
        before calling. Claiming itself NEVER invokes the lifecycle.
        """
        now = now or clock()
        with self.locked():
            record = self._read(intent_id)
            if (not record or record["status"] != "approved"
                    or when(record["notAfter"]) <= now
                    or record["nodeId"] != canonical_uuid(expected_node_id)
                    or record["targetSha256"] != expected_sha256
                    or record["installedVersion"] != installed):
                raise Refused("Approval expired, mismatched or already consumed.")
            record.update(status="claimed", resolvedAt=iso(now))
            record["events"].append({"action": "claimed", "at": iso(now)})
            self._store(record, create=False)
            return record


def read_intent_file(path: Path) -> dict:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INTENT_BYTES:
            raise Refused("Intent snapshot must be a small regular file.")
        with os.fdopen(fd, "rb", closefd=False) as source:
            raw = source.read(MAX_INTENT_BYTES + 1)
        if len(raw) > MAX_INTENT_BYTES:
            raise Refused("Intent snapshot exceeds size limit.")
        return json.loads(raw)
    finally:
        os.close(fd)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Linux Node update approval (NO execution)")
    subs = parser.add_subparsers(dest="command", required=True)
    approve = subs.add_parser("approve")
    approve.add_argument("intent_json", type=Path)
    status = subs.add_parser("status")
    status.add_argument("intent_id")
    revoke = subs.add_parser("revoke")
    revoke.add_argument("intent_id")
    args = parser.parse_args()

    # There is intentionally NO CLI claim, execute, URL, artifact path, or
    # caller-configurable state root. Node/MCP cannot approve an update.
    if sys.platform != "linux" or os.geteuid() != 0:
        raise Refused("Host approval operations require Linux root.")
    if args.command in {"approve", "revoke"} and not sys.stdin.isatty():
        raise Refused("Approval changes require an interactive host root session.")
    store = ApprovalStore(STATE)
    if args.command == "approve":
        # Bind the confirmation to one already-read snapshot: no reread of a
        # mutable caller-owned JSON file after the operator confirms.
        snapshot = read_intent_file(args.intent_json)
        candidate = validate_intent(snapshot,
                                    read_host_node_id(), read_installed_version(), clock())
        print(f"Node: {candidate['nodeId']}\nFrom: {candidate['installedVersion']}"
              f"\nTo: {candidate['targetVersion']}+{candidate['targetCommit']}"
              f"\nArchive SHA-256: {candidate['targetSha256']}"
              f"\nApproval expiry (UTC): {candidate['notAfter']}")
        print("No release is verified, installed or activated by this approval.")
        required = "APPROVE " + candidate["intentId"]
        if input("Type '" + required + "' to confirm: ") != required:
            raise Refused("Host operator did not confirm the exact intent.")
        row = store.approve(snapshot, read_host_node_id(), read_installed_version())
    elif args.command == "revoke":
        if input("Type 'REVOKE " + args.intent_id + "' to confirm: ") != "REVOKE " + args.intent_id:
            raise Refused("Host operator did not confirm revocation.")
        row = store.revoke(args.intent_id)
    else:
        row = store.status(args.intent_id)
    print(json.dumps(row, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (Refused, OSError, ValueError) as exc:
        print("Atlas host approval refused: " + str(exc), file=sys.stderr)
        raise SystemExit(1)
