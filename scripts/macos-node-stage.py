#!/usr/bin/env python3
"""Prepare a signed Atlas Node archive on macOS, without changing launchd.

The existing Mac LaunchAgent points into a developer checkout. This command
intentionally never changes its plist, current PID, identity, environment or
workspace roots. Cutover/recovery is a separate reviewed milestone.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

REPO = "affank1020/atlas"
API = "repos/affank1020/atlas/releases/tags/"
TAG = re.compile(r"^node-v(\d+)\.(\d+)\.(\d+)-([a-f0-9]{12})$")
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^sha256:([a-f0-9]{64})$")
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_MEMBERS = 10000
MAX_CONTENT_BYTES = 1024 * 1024 * 1024
ENTRYPOINT = "apps/node/dist/platforms/desktop/main.js"
RECEIPT = ".atlas-signed-staging.json"


class Refused(Exception):
    pass


def command(*args: str, cwd: Path | None = None, capture: bool = False, timeout: int = 180) -> str:
    env = os.environ.copy()
    if args[0] == "gh":
        env["GH_HOST"] = "github.com"
    result = subprocess.run(args, cwd=cwd, env=env, text=True, check=True, timeout=timeout,
                            stdout=subprocess.PIPE if capture else subprocess.DEVNULL)
    return result.stdout or ""


def release_info(item: dict, requested_tag: str) -> dict:
    match = TAG.fullmatch(requested_tag)
    if not match or not isinstance(item, dict) or item.get("tag_name") != requested_tag:
        raise Refused("Expected one exact stable Node release tag.")
    if item.get("draft") is not False or item.get("prerelease") is not False or item.get("immutable") is not True:
        raise Refused("Release is not an immutable, published stable build.")
    commit = item.get("target_commitish")
    if not isinstance(commit, str) or not SHA.fullmatch(commit) or not commit.startswith(match.group(4)):
        raise Refused("Release source commit does not match its tag.")
    version = ".".join(match.group(i) for i in range(1, 4))
    filename = f"atlas-node-v{version}-{match.group(4)}.tar.gz"
    assets = item.get("assets")
    if not isinstance(assets, list):
        raise Refused("Missing release asset list.")
    found = {}
    for name in (filename, filename + ".sha256"):
        matching = [a for a in assets if isinstance(a, dict) and a.get("name") == name]
        if len(matching) != 1:
            raise Refused("Missing or ambiguous required Node release asset.")
        asset = matching[0]
        digest = asset.get("digest")
        size = asset.get("size")
        if (not isinstance(digest, str) or DIGEST.fullmatch(digest) is None or
            type(size) is not int or not (0 < size <= (4096 if name.endswith(".sha256") else MAX_ARCHIVE))):
            raise Refused("Invalid release asset digest or size.")
        found[name] = asset
    return {"tag": requested_tag, "release": "v" + version + "-" + match.group(4),
            "file": filename, "sha": commit,
            "digest": DIGEST.fullmatch(found[filename]["digest"]).group(1)}


def safe_member_path(member: tarfile.TarInfo) -> str | None:
    """Validate exact POSIX archive spelling before creating any filesystem path."""
    name = member.name
    if name in (".", "./") and member.isdir():
        return None
    if (not name.startswith("./") or name.startswith(".//") or
        "\\" in name or any(ord(c) < 32 for c in name)):
        raise Refused("Unsafe release archive path.")
    rel = name[2:].rstrip("/") if member.isdir() else name[2:]
    if not rel or any(part in ("", ".", "..") for part in rel.split("/")):
        raise Refused("Unsafe release archive path.")
    return rel


def inspect_archive(archive: Path, expected: dict) -> None:
    # Inspect every member before extracting any bytes. Never use
    # tarfile.extractall, which can follow malicious archive links.
    seen = set()
    total = 0
    has = set()
    try:
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar:
                if len(seen) >= MAX_MEMBERS:
                    raise Refused("Too many files in Node archive.")
                rel = safe_member_path(member)
                if rel is None:
                    continue
                if rel in seen:
                    raise Refused("Duplicate release archive entry.")
                seen.add(rel)
                if not (member.isfile() or member.isdir()):
                    raise Refused("Links and special archive entries are forbidden.")
                if member.isfile():
                    if member.size < 0 or member.size > MAX_ARCHIVE:
                        raise Refused("Invalid archive member size.")
                    total += member.size
                    if total > MAX_CONTENT_BYTES:
                        raise Refused("Node archive expands beyond its size limit.")
                    has.add(rel)
            required = {"package.json", "package-lock.json", "atlas-node-release.json", ENTRYPOINT}
            if not required.issubset(has):
                raise Refused("Release lacks its runtime or package manifest.")
            manifest_member = tar.getmember("./atlas-node-release.json")
            if manifest_member.size > 16384:
                raise Refused("Release manifest too large.")
            manifest = tar.extractfile(manifest_member)
            if manifest is None:
                raise Refused("Missing release manifest.")
            record = json.loads(manifest.read(16385))
            if not isinstance(record, dict):
                raise Refused("Release manifest must be an object.")
            if (record.get("application") != "@atlas/node" or
                record.get("commit") != expected["sha"] or
                record.get("version") != expected["release"].split("-")[0].removeprefix("v") or
                record.get("entrypoint") != ENTRYPOINT or record.get("protocol") != 2 or
                not isinstance(record.get("supportedHosts"), list) or
                "darwin" not in record["supportedHosts"]):
                raise Refused("Signed manifest does not match release/source/platform.")
    except (tarfile.TarError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, OSError) as exc:
        raise Refused("Invalid or unreadable Node release archive.") from exc


def unpack_safe(archive: Path, destination: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            rel = safe_member_path(member)
            if rel is None:
                continue
            if not (member.isdir() or member.isfile()):
                raise Refused("Unsafe archive entry on re-read.")
            target = destination.joinpath(*rel.split("/"))
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = tar.extractfile(member)
                if source is None:
                    raise Refused("Archive member could not be read.")
                with target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                target.chmod(0o600)


def require_safe_gh() -> None:
    # GitHub CLI 2.102.0 patched attestation identity bypasses. Refuse
    # older versions, including for read-only signature verification.
    version = command("gh", "--version", capture=True, timeout=15)
    match = re.match(r"^gh version (\d+)\.(\d+)\.(\d+)\b", version)
    if not match or tuple(int(x) for x in match.groups()) < (2, 102, 0):
        raise Refused("GitHub CLI >= 2.102.0 is required for trusted attestations.")


def verify_download(directory: Path, info: dict) -> Path:
    filename = info["file"]
    archive = directory / filename
    checksum = directory / (filename + ".sha256")
    if any(p.is_symlink() or not p.is_file() for p in (archive, checksum)):
        raise Refused("Missing regular Node release assets.")
    if not (0 < archive.stat().st_size <= MAX_ARCHIVE and 0 < checksum.stat().st_size <= 4096):
        raise Refused("Archive or checksum size exceeds allowed bounds.")
    digest = hashlib.sha256()
    with archive.open("rb") as data:
        for block in iter(lambda: data.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != info["digest"]:
        raise Refused("GitHub release asset digest mismatch.")
    if checksum.read_text(encoding="ascii") != info["digest"] + "  " + filename + "\n":
        raise Refused("Checksum sidecar differs from the downloaded archive.")
    inspect_archive(archive, info)
    require_safe_gh()
    # Pin GitHub's signed source and workflow identity to main and the EXACT
    # complete source SHA, not just a checksum or a matching tag prefix.
    command("gh", "attestation", "verify", str(archive), "--repo", REPO,
            "--cert-identity", "https://github.com/affank1020/atlas/.github/workflows/node-package.yml@refs/heads/main",
            "--source-ref", "refs/heads/main",
            "--source-digest", info["sha"],
            "--predicate-type", "https://slsa.dev/provenance/v1",
            "--deny-self-hosted-runners")
    return archive


def staging_root() -> Path:
    if sys.platform != "darwin":
        raise Refused("macOS is required to stage Node releases.")
    return Path.home() / "Library" / "Application Support" / "Atlas" / "NodeSoftware" / "releases"


def validate_root(root: Path) -> None:
    # These files are same-user managed, never privileged or shared with the
    # Node's dotenv secrets; reject a symlinked or world-writable staging tree.
    if root.is_symlink() or not root.is_dir():
        raise Refused("Release directory is missing or symlinked.")
    st = root.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Refused("Release directory must be private and user-owned.")


def stage(tag: str, root: Path) -> Path:
    if TAG.fullmatch(tag) is None:
        raise Refused("Invalid stable Node release tag.")
    validate_root(root)
    target = root / tag.removeprefix("node-")
    # File lock protects against two copies of the updater racing on the
    # same user's tree; a half-installed release never becomes active.
    lockfd = os.open(root / ".stage.lock",
                     os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(lockfd, "rb") as lock:
        lockstat = os.fstat(lock.fileno())
        if (lockstat.st_uid != os.getuid() or not stat.S_ISREG(lockstat.st_mode) or
            lockstat.st_nlink != 1 or lockstat.st_mode & 0o077):
            raise Refused("Stage lock is not a private, single-link regular file.")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if target.exists() or target.is_symlink():
            raise Refused("Release directory already exists; never overwrite a staged build.")
        raw = command("gh", "api", "-X", "GET", API + tag, capture=True)
        info = release_info(json.loads(raw), tag)
        with tempfile.TemporaryDirectory(prefix=".signed-stage-", dir=root) as scratch:
            scratch_path = Path(scratch)
            command("gh", "release", "download", tag, "--repo", REPO,
                    "--pattern", info["file"], "--pattern", info["file"] + ".sha256",
                    "--dir", str(scratch_path))
            archive = verify_download(scratch_path, info)
            installed = scratch_path / "installed"
            installed.mkdir(mode=0o700)
            unpack_safe(archive, installed)
            command("npm", "ci", "--omit=dev", "--ignore-scripts", "--workspace",
                    "@atlas/node", "--workspace", "@atlas/protocol",
                    "--include-workspace-root=false", "--no-audit", "--no-fund",
                    cwd=installed, timeout=240)
            command("npm", "ls", "--omit=dev", "--depth=0", cwd=installed, timeout=60)
            receipt = {"schema": 1, "tag": tag, "source": info["sha"],
                       "archiveSha256": info["digest"],
                       "verification": "signed-github-build-provenance"}
            (installed / RECEIPT).write_text(json.dumps(receipt, sort_keys=True) + "\n")
            (installed / RECEIPT).chmod(0o600)
            if target.exists() or target.is_symlink():
                raise Refused("Concurrent staged-release target appeared.")
            installed.rename(target)
    return target


def main(args: list[str]) -> int:
    if len(args) != 2 or args[0] != "stage":
        print("Usage: python3 scripts/macos-node-stage.py stage node-vVERSION-SHA", file=sys.stderr)
        return 2
    root = staging_root()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    result = stage(args[1], root)
    print("Signed Node release staged:", result)
    print("LaunchAgent, Node identity, credentials and workspaces unchanged.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Refused, OSError, ValueError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, BlockingIOError, UnicodeError) as exc:
        print("Atlas macOS Node staging:", str(exc), file=sys.stderr)
        sys.exit(1)
