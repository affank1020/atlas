#!/usr/bin/env python3
"""Operator-initiated Atlas Linux Node update from immutable GitHub Releases.

Run as the normal (non-root) VPS user. The downloaded bytes and attestations are
verified before being passed to already-installed root-owned lifecycle helpers.
This deliberately does not provide unattended installation or remote approval.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import urllib.request

REPO = "affank1020/atlas"
RELEASES_API = "repos/affank1020/atlas/releases?per_page=100"
PUBLIC_RELEASES_URL = "https://api.github.com/" + RELEASES_API
MAX_CATALOGUE_BYTES = 8 * 1024 * 1024
CATALOGUE_DEADLINE_SECONDS = 20.0
ROOT = Path("/opt/atlas-node")
LIFECYCLE = Path("/usr/local/libexec/atlas-node-lifecycle.sh")
TRUSTED_STAGE = Path("/usr/local/libexec/linux-node-trusted-stage.sh")
RELEASE_HELPER = Path("/usr/local/libexec/linux-node-release.sh")
TAG = re.compile(r"^node-v(\d+)\.(\d+)\.(\d+)-([a-f0-9]{12})$")
SHA = re.compile(r"^[a-f0-9]{40}$")
DIGEST = re.compile(r"^sha256:([a-f0-9]{64})$")
SEQ = re.compile(r"^Atlas-Node-Release-Sequence: ([1-9][0-9]*)$")
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024


class Refused(Exception):
    pass


def releases_from_json(raw: str) -> list[dict]:
    try:
        items = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise Refused("Invalid GitHub Releases response.") from exc
    if not isinstance(items, list) or not items:
        raise Refused("No GitHub releases returned.")
    if len(items) >= 100:
        raise Refused("Release catalogue reached the 100-item limit; pagination required before continuing.")
    return items


def read_public_release_catalogue() -> str:
    """Bounded read-only GitHub release discovery: no gh login or host secrets.

    Only the immutable public api.github.com endpoint is accepted. This
    response supplies *candidate metadata*, not verified update authority.
    Actual downloads still require pinned Sigstore attestation verification.
    """
    request = urllib.request.Request(
        PUBLIC_RELEASES_URL,
        headers={"Accept": "application/vnd.github+json",
                 "User-Agent": "atlas-node-update-check"},
        method="GET",
    )
    # urllib's timeout only bounds each socket operation, not the full fetch.
    # A peer that drip-feeds bytes can otherwise keep read() alive forever.
    # This Linux-only CLI uses a SIGALRM wall-clock deadline for connect and
    # the complete response, independently of the per-socket idle timeout.
    if any(signal.getitimer(signal.ITIMER_REAL)):
        raise Refused("Cannot check releases while another real-time alarm is active.")
    previous_handler = signal.getsignal(signal.SIGALRM)

    def deadline_expired(_signum, _frame):
        raise Refused("GitHub release catalogue exceeded the wall-clock deadline.")

    try:
        signal.signal(signal.SIGALRM, deadline_expired)
        signal.setitimer(signal.ITIMER_REAL, CATALOGUE_DEADLINE_SECONDS)
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.geturl() != PUBLIC_RELEASES_URL:
                raise Refused("Release catalogue redirected away from the pinned GitHub API URL.")
            data = response.read(MAX_CATALOGUE_BYTES + 1)
            if len(data) > MAX_CATALOGUE_BYTES:
                raise Refused("GitHub release catalogue exceeds bounded input size.")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Refused("GitHub release catalogue is not UTF-8.") from exc


def verified_catalogue(items: list[dict]) -> list[dict]:
    """Validate available stable releases before deciding update order.

    GitHub's immutable metadata and digest catalogue are discovery signals;
    the signed build attestation is independently verified against the bytes
    during download AND root-owned staging.
    """
    valid = []
    seen_seq = set()
    seen_tag = set()
    for item in items:
        if not isinstance(item, dict) or item.get("draft") or item.get("prerelease"):
            continue
        if item.get("immutable") is not True:
            continue
        name = item.get("tag_name", "")
        match = TAG.fullmatch(name) if isinstance(name, str) else None
        if not match:
            continue
        version = tuple(int(v) for v in match.group(1, 2, 3))
        commit = item.get("target_commitish")
        if not isinstance(commit, str) or not SHA.fullmatch(commit) or not commit.startswith(match.group(4)):
            continue
        body = item.get("body", "")
        first = body.splitlines()[0] if isinstance(body, str) and body.splitlines() else ""
        seq_match = SEQ.fullmatch(first)
        if not seq_match:
            continue
        sequence = int(seq_match.group(1))
        filename = "atlas-node-v" + ".".join(str(v) for v in version) + "-" + match.group(4) + ".tar.gz"
        assets = item.get("assets")
        if not isinstance(assets, list):
            continue
        by_name = {}
        for asset in assets:
            if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
                continue
            by_name.setdefault(asset["name"], []).append(asset)
        if len(by_name.get(filename, [])) != 1 or len(by_name.get(filename + ".sha256", [])) != 1:
            continue
        a = by_name[filename][0]
        checksum = by_name[filename + ".sha256"][0]
        for obj in (a, checksum):
            d = obj.get("digest")
            if not isinstance(d, str) or not DIGEST.fullmatch(d):
                break
            size = obj.get("size")
            if not isinstance(size, int) or not (0 < size <= MAX_ARCHIVE_BYTES):
                break
        else:
            if checksum["size"] > 4096:
                continue
            if name in seen_tag or (version, sequence) in seen_seq:
                raise Refused("Conflicting release tag or monotonic sequence; refusing selection.")
            seen_tag.add(name)
            seen_seq.add((version, sequence))
            valid.append({
                "tag": name, "file": filename, "digest": DIGEST.fullmatch(a["digest"]).group(1),
                "version": version, "sequence": sequence, "commit": commit,
            })
    if not valid:
        raise Refused("No eligible immutable, stable and well-formed Node release.")
    return valid


def choose_latest(releases: list[dict], installed: str) -> tuple[dict, str]:
    match = TAG.fullmatch("node-" + installed)
    if not match:
        raise Refused("Installed Node release name is missing or malformed.")
    version = tuple(int(v) for v in match.group(1, 2, 3))
    candidate = max(releases, key=lambda r: (r["version"], r["sequence"]))
    if candidate["version"] < version:
        raise Refused("Catalogue is older than the installed Node; refusing downgrade.")
    if candidate["tag"] == "node-" + installed:
        return candidate, "current"
    if candidate["version"] == version:
        current = [r for r in releases if r["tag"] == "node-" + installed]
        if len(current) != 1:
            raise Refused("Installed same-version build is absent from the trusted catalogue; cannot establish update order.")
        if current[0]["sequence"] >= candidate["sequence"]:
            raise Refused("Selected build is not newer than installed build.")
    return candidate, "available"


def run(*argv: str, cwd: str | None = None, capture: bool = False) -> str:
    # Never allow GH_HOST from the caller to redirect release discovery to
    # an Enterprise host with a matching owner/repository name.
    env = os.environ.copy()
    if argv[0] == "gh":
        env["GH_HOST"] = "github.com"
    result = subprocess.run(argv, cwd=cwd, check=True, text=True, env=env,
                            stdout=subprocess.PIPE if capture else None,
                            timeout=120)
    return result.stdout or ""


def installed_release() -> str:
    link = ROOT / "current"
    if not link.is_symlink():
        raise Refused("No current Linux Node symlink; use the host recovery runbook.")
    resolved = link.resolve(strict=True)
    if resolved.parent != ROOT / "releases" or not resolved.is_dir() or resolved.is_symlink():
        raise Refused("Current Node release points outside the expected release directory.")
    return resolved.name


def root_helper(path: Path) -> None:
    """Reject replaceable executable helpers before asking sudo to run them."""
    current = path
    while True:
        st = current.lstat()
        if stat.S_ISLNK(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise Refused("Root helper or parent is not trusted: " + str(current))
        if current == path and not stat.S_ISREG(st.st_mode):
            raise Refused("Root helper is not a regular file: " + str(current))
        if current == current.parent:
            break
        current = current.parent


def require_new_release_target(target: Path) -> None:
    """Never activate a pre-staged directory of unknown origin.

    The legacy checksum-only installer and a signed installer can both create
    the same release path. Directory name, ownership, manifest and installed
    dependencies alone do not prove that the contents match a signed archive.
    This CLI owns only *new* trusted staging; previously installed directories
    require supervised inspection/removal and a fresh verified install.
    """
    if target.is_symlink() or target.exists():
        raise Refused(
            "Target release already exists and its provenance cannot be established: "
            + str(target) + ". Refusing activation; inspect/recover the existing "
            "staging manually and retry after supervised removal."
        )


def download_and_verify(release: dict, directory: Path) -> tuple[Path, Path, Path]:
    filename = release["file"]
    run("gh", "release", "download", release["tag"], "--repo", REPO,
        "--pattern", filename, "--pattern", filename + ".sha256", "--dir", str(directory))
    archive = directory / filename
    checksum = directory / (filename + ".sha256")
    if any(p.is_symlink() or not p.is_file() for p in (archive, checksum)):
        raise Refused("Expected two regular release asset files.")
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise Refused("Archive exceeds allowed size.")
    h = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    if digest != release["digest"]:
        raise Refused("Downloaded archive differs from GitHub release digest.")
    expected = checksum.read_text(encoding="ascii").splitlines()
    if len(expected) != 1 or expected[0] != digest + "  " + filename:
        raise Refused("Release checksum sidecar is invalid.")
    # 'gh attestation download' writes sha256:<digest>.jsonl into cwd.
    run("gh", "attestation", "download", str(archive), "--repo", REPO, cwd=str(directory))
    bundle = directory / ("sha256:" + digest + ".jsonl")
    if bundle.is_symlink() or not bundle.is_file() or not (0 < bundle.stat().st_size <= 16 * 1024 * 1024):
        raise Refused("Expected a bounded, regular GitHub attestation bundle.")
    # Before privilege escalation, verify exact repo, main workflow and SHA.
    run("bash", str(TRUSTED_STAGE), "verify", str(archive), str(checksum), str(bundle))
    return archive, checksum, bundle


def main(args: list[str]) -> int:
    if args not in (["check"], ["check", "--json"], ["update"], ["status"], ["rollback"]):
        print("Usage: atlas-node-update check [--json] | update | status | rollback", file=sys.stderr)
        return 2
    command = args[0]
    json_mode = args == ["check", "--json"]
    if os.geteuid() == 0:
        raise Refused("Run as an ordinary VPS user, never via sudo; only the installed helpers use root.")
    if command == "status":
        # The systemd Node heartbeat is private to the atlas-node service user
        # (0700 parent, 0077 service umask). Use the reviewed root-owned
        # read-only status helper, rather than silently reporting it offline.
        root_helper(LIFECYCLE)
        run("sudo", str(LIFECYCLE), "status")
        return 0
    if command == "rollback":
        root_helper(LIFECYCLE)
        if not sys.stdin.isatty():
            raise Refused("Rollback requires interactive operator confirmation.")
        if input("Type ROLLBACK to restore the previous Node release: ") != "ROLLBACK":
            raise Refused("Rollback cancelled.")
        run("sudo", str(LIFECYCLE), "rollback")
        return 0
    # The background-safe "check" path is a public, unprivileged, credential-
    # free HTTPS read. The interactive update path retains authenticated gh.
    raw = read_public_release_catalogue() if command == "check" else run(
        "gh", "api", "-X", "GET", RELEASES_API, capture=True
    )
    catalog = verified_catalogue(releases_from_json(raw))
    current = installed_release()
    candidate, state = choose_latest(catalog, current)
    if json_mode:
        print(json.dumps({
            "schema": 1,
            "installed": current,
            "candidate": candidate["tag"],
            "state": state,
            "verification": "catalogue-only",
        }, sort_keys=True))
    else:
        print("Installed:", current)
        print("Latest catalogue candidate (signature checked on install):", candidate["tag"])
        print("State:", state)
    if command == "check" or state == "current":
        return 0
    if not sys.stdin.isatty():
        raise Refused("Update requires interactive operator confirmation.")
    for helper in (LIFECYCLE, TRUSTED_STAGE, RELEASE_HELPER):
        root_helper(helper)
    target = ROOT / "releases" / candidate["tag"].removeprefix("node-")
    # Fail before download and again immediately before privileged staging.
    # Reusing a directory staged by the old checksum-only installer would
    # activate unsigned, potentially different bytes under a signed name.
    require_new_release_target(target)
    with tempfile.TemporaryDirectory(prefix="atlas-node-host-update-") as tmp:
        os.chmod(tmp, 0o700)
        archive, checksum, bundle = download_and_verify(candidate, Path(tmp))
        if input("Type UPDATE " + candidate["tag"] + " to activate the verified release: ") != "UPDATE " + candidate["tag"]:
            raise Refused("Update cancelled; no release activated.")
        require_new_release_target(target)
        run("sudo", "-v")
        # Root recopies the untrusted caller's files, then re-verifies
        # the signed provenance offline before creating the immutable release.
        # The root installer refuses a concurrent or pre-existing target.
        run("sudo", str(TRUSTED_STAGE), "install", str(archive), str(checksum), str(bundle))
        name = target.name
        run("sudo", str(LIFECYCLE), "plan", name)
        run("sudo", str(LIFECYCLE), "activate", name, "--expect-current", current)
        run("sudo", str(LIFECYCLE), "status")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (Refused, OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print("Atlas Linux Node updater:", str(exc), file=sys.stderr)
        sys.exit(1)
