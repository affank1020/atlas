import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { verifyRootUpdateAttestation } from '../apps/server/src/nodes/root-evidence.js';

const signer = resolve('scripts/linux-node-root-evidence.py');
const executor = resolve('scripts/linux-node-update-executor.py');
const approval = resolve('scripts/linux-node-update-approval.py');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const openssl = spawnSync('/usr/bin/openssl', ['version'], { encoding: 'utf8' });
const available = process.platform === 'linux' && python.status === 0 && openssl.status === 0;
const nodeId = '01234567-89ab-4cde-8fab-0123456789ab';
const intentId = '12345678-90ab-4cde-8fab-1234567890ab';
const challenge = 'c'.repeat(64);
const digest = 'd'.repeat(64);
const activeVersion = '2.0.1+' + 'b'.repeat(12);

function pythonScript(script: string) {
    return spawnSync('python3', ['-c', script, signer, executor, approval], {
        encoding: 'utf8', timeout: 30_000,
    });
}

test('host-root evidence CLI is parseable and cannot execute or reconcile updates', { skip: !available }, () => {
    const s = spawnSync('python3', ['-c', `import ast,sys
ast.parse(open(sys.argv[1],encoding="utf8").read())`, signer], { encoding: 'utf8' });
    assert.equal(s.status, 0, s.stderr);
    const help = spawnSync('python3', [signer, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /challenge/);
    assert.doesNotMatch(help.stdout, /install|activate|reconcile|retry/);
});

test('Python root signer creates Ed25519 proof accepted by Node verifier, never a self-enrolled key', { skip: !available }, () => {
    const result = pythonScript(String.raw`
import contextlib,datetime as dt,importlib.util,json,pathlib,subprocess,sys,tempfile
from unittest import mock
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    obj=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj
s=load("signer",sys.argv[1]);e=load("executor",sys.argv[2]);a=load("approval",sys.argv[3])
node="01234567-89ab-4cde-8fab-0123456789ab"
intent="12345678-90ab-4cde-8fab-1234567890ab"
active="2.0.1+"+"b"*12
now=dt.datetime.now(dt.timezone.utc)
request=dict(id=intent,nodeId=node,installedVersion="2.0.0+"+"a"*12,targetVersion="2.0.1",
 targetCommit="b"*12,targetSourceCommit="b"*40,targetSha256="d"*64,
 status="requested",createdAt=a.iso(now),expiresAt=a.iso(now+dt.timedelta(minutes=10)),
 resolvedAt=None,approved=False,executable=False)
with tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td);state=root/"state"
    key=root/"root-signing-key.pem";public=root/"root-public.pem"
    subprocess.run(["/usr/bin/openssl","genpkey","-algorithm","ED25519","-out",str(key)],
                   check=True,capture_output=True)
    key.chmod(0o600)
    subprocess.run(["/usr/bin/openssl","pkey","-in",str(key),"-pubout","-out",str(public)],
                   check=True,capture_output=True)
    class Store(a.ApprovalStore):
        def __init__(self,unused):super().__init__(state,owner_uid=None)
    class Module:pass
    m=Module();m.ApprovalStore=Store
    m.read_host_node_id=lambda:node
    installed=[active]
    m.read_installed_version=lambda:installed[0]
    Store(None).approve(request,node,request["installedVersion"],now)
    receipt=dict(schema=1,intentId=intent,nodeId=node,targetVersion="2.0.1",
                 targetCommit="b"*12,targetSha256="d"*64,installedVersion=request["installedVersion"])
    e.ReceiptStore(Store(None)).mark(receipt,"activated",create=True)
    e.STATE=state;e.RELEASE_ROOT=root/"release-root";e.RELEASE_ROOT.mkdir()
    e.load_approval_module=lambda:m
    # CI's temporary fixture lives under /tmp (not a root-controlled path);
    # bypass ONLY file ownership in test. OpenSSL still signs using actual
    # generated Ed25519 key and the verifier sees its matching public PEM.
    s.check_private_key=lambda path:None
    s.live_pid=lambda runner:4242
    s.input=lambda prompt:"ATTEST "+intent
    signature=lambda data, path:s.openssl_sign(data,path)
    output=s._attest(intent,"c"*64,executor=e,key=key,signer=signature,
                     runner=subprocess.run)
    assert output["observedPid"]==4242
    assert output["nodeId"]==node
    assert output["targetSha256"]=="d"*64
    assert "private" not in json.dumps(output)
    try:s._attest(intent,"f"*63,executor=e,key=key,signer=signature,runner=subprocess.run)
    except s.Refused:pass
    else:raise AssertionError("invalid nonce accepted")
    installed[0]="2.0.2+"+"f"*12
    try:s._attest(intent,"c"*64,executor=e,key=key,signer=signature,runner=subprocess.run)
    except s.Refused:pass
    else:raise AssertionError("stale host active version signed")
    print(json.dumps({"publicPem":public.read_text(),"attestation":output}))
`);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
    const { publicPem, attestation } = JSON.parse(result.stdout) as { publicPem: string; attestation: unknown };
    const expected = { nodeId, intentId, challenge, activeVersion, targetSha256: digest };
    assert.equal(verifyRootUpdateAttestation(attestation, publicPem, expected), true);
    assert.equal(verifyRootUpdateAttestation(attestation, publicPem,
        { ...expected, challenge: 'f'.repeat(64) }), false);
});

test('host evidence refuses unhealthy PID and pending recovery before signing', { skip: !available }, () => {
    const result = pythonScript(String.raw`
import datetime as dt,importlib.util,json,pathlib,sys,tempfile
class Result:
    def __init__(self,stdout=""):self.stdout=stdout
spec=importlib.util.spec_from_file_location("s",sys.argv[1])
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
now=dt.datetime(2026,10,23,9,30,0,tzinfo=dt.timezone.utc)
iso=lambda when:when.isoformat(timespec="milliseconds").replace("+00:00","Z")
with tempfile.TemporaryDirectory() as td:
    path=pathlib.Path(td)/"status.json"
    valid={"state":"connected","pid":4242,"updatedAt":iso(now-dt.timedelta(seconds=10))}
    path.write_text(json.dumps(valid))
    def runner(args,**kwargs):
        if args[1]=="is-active":return Result()
        return Result("4242\n")
    assert s.live_pid(status_path=path,runner=runner,now=now)==4242
    for modified in [
        {**valid,"state":"reconnecting"},
        {**valid,"pid":4040},
        {**valid,"pid":"4242"},
        {**valid,"updatedAt":None},
        {**valid,"updatedAt":"not-a-date"},
        {**valid,"updatedAt":iso(now-dt.timedelta(minutes=2))},
        {**valid,"updatedAt":iso(now+dt.timedelta(seconds=10))},
        {**valid,"updatedAt":"2026-13-23T09:30:00.000Z"},
        {**valid,"updatedAt":"2026-10-23T09:30:00+00:00"},
        {**valid,"updatedAt":"2026-10-23T09:30:00Z"},
        {**valid,"updatedAt":"2026-10-23T09:30:00.000+01:00"},
    ]:
        path.write_text(json.dumps(modified))
        try:s.live_pid(status_path=path,runner=runner,now=now)
        except s.Refused:pass
        else:raise AssertionError("unhealthy, stale or malformed Node status accepted: "+str(modified))
    # Exactly at the freshness limit is acceptable; older is not.
    path.write_text(json.dumps({**valid,"updatedAt":iso(now-dt.timedelta(seconds=35))}))
    assert s.live_pid(status_path=path,runner=runner,now=now)==4242
    path.write_text(json.dumps({**valid,"updatedAt":iso(now-dt.timedelta(seconds=35,milliseconds=1))}))
    try:s.live_pid(status_path=path,runner=runner,now=now)
    except s.Refused:pass
    else:raise AssertionError("heartbeat past freshness window accepted")
    path.write_bytes(b"x"*32769)
    try:s.live_pid(status_path=path,runner=runner,now=now)
    except s.Refused:pass
    else:raise AssertionError("oversized status file accepted")
print("heartbeat freshness, PID consistency and bounded status checks passed")
`);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});

test('host signer lifecycle flock excludes competing manual activations during evidence collection',
    { skip: !available }, () => {
    const result = pythonScript(String.raw`
import importlib.util,os,pathlib,stat,sys,tempfile
from unittest import mock
spec=importlib.util.spec_from_file_location("signer",sys.argv[1])
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
with tempfile.TemporaryDirectory() as td:
    lock=pathlib.Path(td)/"lifecycle.lock"
    real_lstat=pathlib.Path.lstat
    def fake_secure_parents(path):
        info=real_lstat(path)
        if path != lock:
            # Model a root-controlled directory chain without requiring the
            # CI runner to write to the real /run/lock production folder.
            class Parent:
                st_mode=stat.S_IFDIR | 0o700
                st_uid=os.getuid()
            return Parent()
        return info
    with mock.patch.object(pathlib.Path,"lstat",fake_secure_parents):
        with s.hold_lifecycle_lock(lock,owner_uid=os.getuid()):
            try:
                with s.hold_lifecycle_lock(lock,owner_uid=os.getuid()):
                    pass
            except s.Refused as exc:
                assert "Another manual lifecycle" in str(exc)
            else:raise AssertionError("manual lifecycle acquired locked release tree")
        with s.hold_lifecycle_lock(lock,owner_uid=os.getuid()):
            pass
print("manual lifecycle and root attestation share exclusive flock")
`);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});

test('unanswered operator prompt holds no approval, executor or lifecycle lock; snapshot is rechecked after consent',
    { skip: !available }, () => {
    const result = pythonScript(String.raw`
import contextlib,fcntl,importlib.util,os,pathlib,stat,sys,tempfile,types
from unittest import mock
spec=importlib.util.spec_from_file_location("signer",sys.argv[1])
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
node="01234567-89ab-4cde-8fab-0123456789ab"
ident="12345678-90ab-4cde-8fab-1234567890ab"
with tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td)
    lock=root/".executor.lock"
    lock.touch(mode=0o600)
    held={"approval":False,"lifecycle":False}
    active=["expected"]
    class Store:
        def __init__(self,unused): pass
        @contextlib.contextmanager
        def locked(self):
            assert not held["approval"]
            held["approval"]=True
            try: yield
            finally: held["approval"]=False
    class Approval:
        ApprovalStore=Store
    class Executor:
        STATE=root
        @staticmethod
        def load_approval_module():return Approval
    @contextlib.contextmanager
    def lifecycle():
        assert not held["lifecycle"]
        held["lifecycle"]=True
        try: yield
        finally: held["lifecycle"]=False
    def try_emergency_lock():
        probe=os.open(lock,os.O_RDONLY)
        try:
            fcntl.flock(probe,fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(probe,fcntl.LOCK_UN)
            return True
        except BlockingIOError:return False
        finally:os.close(probe)
    def prompt(message):
        assert "ATTEST "+ident in message
        assert not held["approval"] and not held["lifecycle"]
        assert try_emergency_lock(), "operator input monopolized the executor lock"
        # Simulate a concurrent emergency rollback before operator consent.
        with lifecycle():
            with Store(None).locked():
                active[0]="changed"
        return "ATTEST "+ident
    def fake_sign(*args,**kwargs):
        assert held["lifecycle"], "snapshot collected without lifecycle lock"
        assert not try_emergency_lock(), "snapshot collected without executor lock"
        assert active[0]=="expected", "stale post-confirmation host state was signed"
        return {"ok":True}
    # The harness patches ONLY the os.fstat used to check the fixture's fake
    # root-owned executor lock; the real kernel flock still enforces exclusion.
    with mock.patch.object(s.sys,"platform","linux"), \
         mock.patch.object(s.os,"geteuid",return_value=0), \
         mock.patch.object(s.os,"isatty",return_value=True), \
         mock.patch.object(s.os,"fstat",return_value=types.SimpleNamespace(
             st_mode=stat.S_IFREG | 0o600,st_uid=0)), \
         mock.patch.object(s,"hold_lifecycle_lock",side_effect=lifecycle), \
         mock.patch.object(s,"_attest",side_effect=fake_sign), \
         mock.patch.object(s,"input",side_effect=prompt):
        try:s.attest(ident,"c"*64,executor=Executor())
        except AssertionError as exc:
            assert "stale post-confirmation" in str(exc)
        else:raise AssertionError("post-confirmation snapshot recheck bypassed")
        assert not held["approval"] and not held["lifecycle"]
        assert try_emergency_lock(), "failed signer leaked executor lock"
        active[0]="expected"
        with mock.patch.object(s,"input",return_value="ATTEST "+ident):
            assert s.attest(ident,"c"*64,executor=Executor())=={"ok":True}
        assert try_emergency_lock(), "completed signer leaked executor lock"
print("input never holds host locks; fresh snapshot required after consent")
`);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
});
