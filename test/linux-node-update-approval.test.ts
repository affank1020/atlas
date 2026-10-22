import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const executable = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const available = process.platform === 'linux' && executable.status === 0;
const path = resolve('scripts/linux-node-update-approval.py');

function runPython(code: string) {
    return spawnSync('python3', ['-c', code, path], { encoding: 'utf8', timeout: 20000 });
}

test('host approval source parses and public CLI does not expose claiming/execution', { skip: !available }, () => {
    const help = spawnSync('python3', [path, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /approve/);
    assert.match(help.stdout, /revoke/);
    assert.doesNotMatch(help.stdout, /\bclaim\b|\bexecute\b|\bactivate\b/);
    const compile = spawnSync('python3', ['-c',
        'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', path], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
});

test('host approvals bind intent, installed version and digest; claim is durable and single use', { skip: !available }, () => {
    const py = String.raw`
import datetime as dt, importlib.util, json, pathlib, sys, tempfile, uuid
spec = importlib.util.spec_from_file_location("host_approval", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime.now(dt.timezone.utc)
node = str(uuid.uuid4())
request = str(uuid.uuid4())
source = "b"*40
digest = "a"*64
old = "2.0.0+" + "c"*12
intent = dict(id=request, nodeId=node, installedVersion=old,
    targetVersion="2.0.1", targetCommit=source[:12], targetSourceCommit=source,
    targetSha256=digest, status="requested", approved=False, executable=False,
    createdAt=m.iso(now - dt.timedelta(seconds=5)),
    expiresAt=m.iso(now + dt.timedelta(minutes=10)), resolvedAt=None)
def refuses(f):
    try:
        f()
    except m.Refused:
        return
    raise AssertionError("expected refusal")
with tempfile.TemporaryDirectory() as directory:
    store = m.ApprovalStore(pathlib.Path(directory) / "approvals", owner_uid=None)
    approval = store.approve(intent, node, old, now)
    assert approval["status"] == "approved"
    assert m.when(approval["notAfter"]) <= now + dt.timedelta(minutes=5)
    assert store.status(request, now)["effectiveStatus"] == "approved"
    refuses(lambda: store.approve(intent, node, old, now))
    refuses(lambda: store.claim_once(request, node, "f"*64, old, now))
    refuses(lambda: store.claim_once(request, str(uuid.uuid4()), digest, old, now))
    refuses(lambda: store.claim_once(request, node, digest, "2.0.0+" + "d"*12, now))
    # Independently reopen the store to prove the claim survives process state.
    fresh = m.ApprovalStore(pathlib.Path(directory) / "approvals", owner_uid=None)
    claim = fresh.claim_once(request, node, digest, old, now)
    assert claim["status"] == "claimed"
    assert [e["action"] for e in claim["events"]] == ["approved", "claimed"]
    refuses(lambda: store.claim_once(request, node, digest, old, now))
    refuses(lambda: store.revoke(request, now))
    assert store.status(request, now)["status"] == "claimed"
    assert store.status(str(uuid.uuid4()), now) is None

    other = dict(intent, id=str(uuid.uuid4()))
    second = store.approve(other, node, old, now)
    assert second["status"] == "approved"
    refuses(lambda: store.claim_once(other["id"], node, digest, old, now + dt.timedelta(minutes=6)))
    assert store.status(other["id"], now + dt.timedelta(minutes=6))["effectiveStatus"] == "expired"
    revoked = store.revoke(other["id"], now)
    assert revoked["status"] == "revoked"
    refuses(lambda: store.claim_once(other["id"], node, digest, old, now))
print("approval persistence and single-use claim verified")
`;
    const result = runPython(py);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});

test('host approval rejects forged, stale, mismatched and non-Atlas intents', { skip: !available }, () => {
    const py = String.raw`
import datetime as dt, importlib.util, pathlib, tempfile, uuid
spec = importlib.util.spec_from_file_location("host_approval", __import__("sys").argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime.now(dt.timezone.utc)
node = str(uuid.uuid4())
sha = "a"*40
base = dict(id=str(uuid.uuid4()), nodeId=node, installedVersion="2.0.0+" + "c"*12,
    targetVersion="2.0.1", targetCommit=sha[:12], targetSourceCommit=sha,
    targetSha256="e"*64, status="requested", createdAt=m.iso(now),
    expiresAt=m.iso(now + dt.timedelta(minutes=10)),
    resolvedAt=None, approved=False, executable=False)
def refuses(value):
    try: m.validate_intent(value, node, base["installedVersion"], now)
    except m.Refused: return
    raise AssertionError("bad intent accepted: " + str(value))
assert m.validate_intent(base, node, base["installedVersion"], now)["targetSha256"] == "e"*64
for changes in [
    dict(status="cancelled"), dict(status="expired"), dict(approved=True),
    dict(executable=True), dict(resolvedAt=m.iso(now)),
    dict(nodeId=str(uuid.uuid4())), dict(installedVersion="2.0.1+" + "c"*12),
    dict(targetVersion="2.0.1-rc.1"), dict(targetCommit="b"*12),
    dict(targetSourceCommit="f"*40), dict(targetSha256="x"*64),
    dict(expiresAt=m.iso(now - dt.timedelta(seconds=1))),
    dict(expiresAt=m.iso(now + dt.timedelta(minutes=16))),
    dict(createdAt=m.iso(now + dt.timedelta(minutes=1))),
]:
    refuses({**base, **changes})
refuses({**base, "unknownCapability": "execute"})
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root/"releases").mkdir()
    folder = root/"releases"/("v2.0.0-" + "c"*12)
    folder.mkdir()
    (folder/"atlas-node-release.json").write_text(__import__("json").dumps({
        "application": "@atlas/node", "version": "2.0.0", "protocol": 2,
        "commit": "c"*40, "entrypoint": "apps/node/dist/platforms/desktop/main.js",
    }))
    (root/"current").symlink_to(folder)
    assert m.read_installed_version(root) == base["installedVersion"]
    (folder/"atlas-node-release.json").write_text("{}")
    try: m.read_installed_version(root)
    except m.Refused: pass
    else: raise AssertionError("invalid release manifest accepted")
print("invalid intent and manifest cases rejected")
`;
    const result = runPython(py);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});


test('concurrent processes cannot claim the same host approval twice', { skip: !available }, () => {
    const py = String.raw`
import datetime as dt, importlib.util, multiprocessing as mp, pathlib, sys, tempfile, uuid
spec = importlib.util.spec_from_file_location("host_approval", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime.now(dt.timezone.utc)
node, ident, source = str(uuid.uuid4()), str(uuid.uuid4()), "a"*40
digest = "b"*64
old = "2.0.0+" + "c"*12
intent = dict(id=ident, nodeId=node, installedVersion=old, targetVersion="2.0.1",
    targetCommit=source[:12], targetSourceCommit=source, targetSha256=digest,
    status="requested", approved=False, executable=False, resolvedAt=None,
    createdAt=m.iso(now), expiresAt=m.iso(now + dt.timedelta(minutes=10)))
def worker(root, ready, start, result):
    state = m.ApprovalStore(pathlib.Path(root), owner_uid=None)
    ready.put("ready")
    start.wait(timeout=10)
    try:
        state.claim_once(ident, node, digest, old, now)
        result.put("claimed")
    except m.Refused:
        result.put("rejected")
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory) / "state"
    m.ApprovalStore(root, owner_uid=None).approve(intent, node, old, now)
    ctx = mp.get_context("fork")
    ready, start, result = ctx.Queue(), ctx.Event(), ctx.Queue()
    children = [ctx.Process(target=worker, args=(str(root), ready, start, result)) for _ in range(2)]
    for child in children: child.start()
    for _ in children: assert ready.get(timeout=10) == "ready"
    start.set()
    outcomes = [result.get(timeout=10) for _ in children]
    for child in children:
        child.join(timeout=10)
        assert child.exitcode == 0
    assert sorted(outcomes) == ["claimed", "rejected"], outcomes
    assert m.ApprovalStore(root, owner_uid=None).status(ident)["status"] == "claimed"
print("concurrent claim rejected exactly once")
`;
    const result = runPython(py);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});

test('approval ledger fsyncs new parent directory entries before acknowledging a grant', { skip: !available }, () => {
    const py = String.raw`
import datetime as dt, importlib.util, os, pathlib, sys, tempfile, uuid
from unittest import mock
spec = importlib.util.spec_from_file_location("host_approval", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime.now(dt.timezone.utc)
node = str(uuid.uuid4())
intent_id = str(uuid.uuid4())
source = "a"*40
installed = "2.0.0+" + "c"*12
intent = dict(id=intent_id, nodeId=node, installedVersion=installed,
    targetVersion="2.0.1", targetCommit=source[:12], targetSourceCommit=source,
    targetSha256="b"*64, status="requested", approved=False, executable=False,
    createdAt=m.iso(now), expiresAt=m.iso(now+dt.timedelta(minutes=10)), resolvedAt=None)
with tempfile.TemporaryDirectory() as temporary:
    parent = pathlib.Path(temporary)
    root = parent/"approvals"
    store = m.ApprovalStore(root, owner_uid=None)
    original = os.fsync
    seen = []
    def observed_sync(fd):
        seen.append(os.readlink("/proc/self/fd/" + str(fd)))
        return original(fd)
    with mock.patch.object(m.os, "fsync", side_effect=observed_sync):
        result = store.approve(intent, node, installed, now)
    assert result["status"] == "approved"
    assert str(parent) in seen and str(root) in seen and str(root/"records") in seen, seen
    assert seen.index(str(parent)) < seen.index(str(root)) < seen.index(str(root/"records")), seen
    assert store.status(intent_id)["status"] == "approved"
    # If the parent-directory persistence barrier fails, no approval is acknowledged.
    another = m.ApprovalStore(parent/"fresh", owner_uid=None)
    def parent_fails(fd):
        if os.readlink("/proc/self/fd/"+str(fd)) == str(parent):
            raise OSError("injected directory fsync failure")
        return original(fd)
    try:
        with mock.patch.object(m.os, "fsync", side_effect=parent_fails):
            another.approve({**intent, "id": str(uuid.uuid4())}, node, installed, now)
    except OSError as exc:
        assert "injected" in str(exc)
    else:
        raise AssertionError("approval acknowledged without syncing parent directory")
    assert not (parent/"fresh"/"records").exists()
print("durable directory creation and fail-closed barrier verified")
`;
    const result = runPython(py);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});

test('approval records handle forced short writes and refuse zero-progress publication', { skip: !available }, () => {
    const py = String.raw`
import datetime as dt, importlib.util, os, pathlib, sys, tempfile, uuid
from unittest import mock
spec = importlib.util.spec_from_file_location("host_approval", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime.now(dt.timezone.utc)
node = str(uuid.uuid4())
source = "a"*40
installed = "2.0.0+" + "c"*12
def intent(ident):
    return dict(id=ident, nodeId=node, installedVersion=installed,
        targetVersion="2.0.1", targetCommit=source[:12], targetSourceCommit=source,
        targetSha256="b"*64, status="requested", approved=False, executable=False,
        createdAt=m.iso(now), expiresAt=m.iso(now+dt.timedelta(minutes=10)), resolvedAt=None)
with tempfile.TemporaryDirectory() as temporary:
    store = m.ApprovalStore(pathlib.Path(temporary)/"approvals", owner_uid=None)
    first_id = str(uuid.uuid4())
    real_write = os.write
    calls = []
    def short_write(fd, data):
        calls.append(len(data))
        return real_write(fd, data[:max(1, len(data)//4)])
    with mock.patch.object(m.os, "write", side_effect=short_write):
        assert store.approve(intent(first_id), node, installed, now)["status"] == "approved"
    assert len(calls) > 1, calls
    assert store.status(first_id, now)["status"] == "approved"
    # Verify short writes are also handled when publishing an atomic update.
    with mock.patch.object(m.os, "write", side_effect=short_write):
        assert store.claim_once(first_id, node, "b"*64, installed, now)["status"] == "claimed"
    assert store.status(first_id, now)["status"] == "claimed"
    # Zero-progress on a new record must never publish partial JSON.
    second_id = str(uuid.uuid4())
    with mock.patch.object(m.os, "write", return_value=0):
        try:
            store.approve(intent(second_id), node, installed, now)
        except m.Refused as exc:
            assert "no progress" in str(exc)
        else:
            raise AssertionError("zero-progress write was acknowledged")
    assert not store._path(second_id).exists()
    assert store.status(first_id, now)["status"] == "claimed"
    # Also refuse after an initial partial write followed by zero progress.
    third_id = str(uuid.uuid4())
    remaining = [True]
    def stops_after_short_write(fd, data):
        if remaining:
            remaining.pop()
            return real_write(fd, data[:1])
        return 0
    with mock.patch.object(m.os, "write", side_effect=stops_after_short_write):
        try:
            store.approve(intent(third_id), node, installed, now)
        except m.Refused:
            pass
        else:
            raise AssertionError("partially written record was published")
    assert not store._path(third_id).exists()
print("short write and zero-progress refusal verified")
`;
    const result = runPython(py);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});
