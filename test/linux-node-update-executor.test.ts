import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const available = process.platform === 'linux' && python.status === 0;
const executor = resolve('scripts/linux-node-update-executor.py');
const approval = resolve('scripts/linux-node-update-approval.py');
function runPython(source: string) {
    return spawnSync('python3', ['-c', source, executor, approval], {
        encoding: 'utf8', timeout: 30_000,
    });
}
function passes(source: string) {
    const result = runPython(source);
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
}

test('root executor parses and exposes no unattended/scheduled command', { skip: !available }, () => {
    const syntax = spawnSync('python3', ['-c', String.raw`
import ast, sys
ast.parse(open(sys.argv[1], encoding="utf-8").read())
`, executor], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const help = spawnSync('python3', [executor, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /execute/);
    assert.match(help.stdout, /status/);
    assert.doesNotMatch(help.stdout, /retry|daemon|schedule|rollback/);
});

test('root executor derives only the configured Node claim URL and validates Server response identity', { skip: !available }, () => {
    passes(String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("exe", sys.argv[1])
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
assert e.claim_url("wss://atlas.example.com/node/connect") == "https://atlas.example.com/node/update-intents/claim"
assert e.claim_url("ws://127.0.0.1:3000/node/connect") == "http://127.0.0.1:3000/node/update-intents/claim"
assert e.claim_url("wss://[::1]:443/node/connect") == "https://[::1]:443/node/update-intents/claim"
def rejects(call):
    try: call()
    except e.Refused: return
    raise AssertionError("unsafe URL/claim accepted")
for url in ("ws://evil.example/node/connect", "https://atlas.example.com/node/connect",
            "wss://user:pass@atlas.example.com/node/connect", "wss://atlas.example.com/foo",
            "wss://atlas.example.com/node/connect?redirect=1",
            "wss://atlas.example.com:99999/node/connect"):
    rejects(lambda url=url: e.claim_url(url))
grant = dict(intentId="a", nodeId="b", installedVersion="2.0.0+cccccccccccc",
    targetVersion="2.0.1", targetCommit="d"*12,
    targetSourceCommit="d"*40, targetSha256="e"*64)
valid = dict(id="a",nodeId="b",installedVersion=grant["installedVersion"],
    targetVersion=grant["targetVersion"],targetCommit=grant["targetCommit"],
    targetSourceCommit=grant["targetSourceCommit"],targetSha256=grant["targetSha256"],
    status="claimed",approved=False,executable=False,resolvedAt="2026-10-22T12:00:00Z")
assert e.validate_claim_response({"intent":valid}, grant)["status"] == "claimed"
for field, value in [("id","wrong"),("status","requested"),("targetSha256","0"*64),
                     ("approved",True),("executable",True),("resolvedAt",None),
                     ("targetSourceCommit","f"*40)]:
    rejects(lambda field=field,value=value:
        e.validate_claim_response({"intent":{**valid,field:value}}, grant))
print("claim identity verified")
`);
});

test('root executor snapshots reject symlinks and verify exact digest, signed manifest and bytes', { skip: !available }, () => {
    passes(String.raw`
import hashlib,importlib.util,io,json,pathlib,sys,tarfile,tempfile
spec=importlib.util.spec_from_file_location("exe",sys.argv[1])
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
commit="b"*40;short=commit[:12];name="atlas-node-v2.0.1-"+short+".tar.gz"
with tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td)
    original=root/"input"
    meta={"application":"@atlas/node","protocol":2,"version":"2.0.1",
        "commit":commit,"entrypoint":"apps/node/dist/platforms/desktop/main.js"}
    with tarfile.open(original,"w:gz") as tar:
        data=json.dumps(meta).encode()
        info=tarfile.TarInfo("./atlas-node-release.json");info.size=len(data)
        tar.addfile(info,io.BytesIO(data))
    archive=root/name
    e.copy_snapshot(original,archive,e.MAX_ARCHIVE)
    sha=e.digest_file(archive,e.MAX_ARCHIVE)
    sidecar=root/(name+".sha256");sidecar.write_text(sha+"  "+name+"\n")
    bundle=root/"attestations.jsonl";bundle.write_text("offline attestation stub")
    grant=dict(targetVersion="2.0.1",targetCommit=short,targetSourceCommit=commit,targetSha256=sha)
    called=[]
    e.secure_executable=lambda path:None
    e.verify_snapshot(archive,sidecar,bundle,grant,
        lambda args,**kwargs:called.append((args,kwargs)))
    assert len(called)==1
    assert called[0][0][2]=="verify"
    assert called[0][1]["env"]==e.SAFE_ENV
    def rejects(f):
        try:f()
        except (e.Refused,OSError):return
        raise AssertionError("tampered bundle accepted")
    rejects(lambda:e.verify_snapshot(archive,sidecar,bundle,{**grant,"targetSha256":"0"*64}))
    wrong=root/"other-sha256";wrong.write_text("a"*64+"  "+name+"\n")
    rejects(lambda:e.verify_snapshot(archive,wrong,bundle,grant))
    tampered=root/"link";tampered.symlink_to(original)
    rejects(lambda:e.copy_snapshot(tampered,root/"copy",1024*1024))
    assert len(called)==1,"tampered bytes must be refused before trusted signature verifier"
print("bundle identity gate verified")
`);
});

test('root executor persists single-use execution state and never replays Server claims', { skip: !available }, () => {
    passes(String.raw`
import importlib.util,datetime as dt,json,pathlib,sys,tempfile
from unittest import mock
def load(name,fn):
    spec=importlib.util.spec_from_file_location(name,fn)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
e=load("exe",sys.argv[1]);a=load("approval",sys.argv[2])
node="01234567-89ab-4cde-8fab-0123456789ab"
ident="12345678-90ab-4cde-8fab-1234567890ab"
now=dt.datetime.now(dt.timezone.utc)
old="2.0.0+"+"c"*12
digest="d"*64
source="b"*40
intent=dict(id=ident,nodeId=node,installedVersion=old,targetVersion="2.0.1",
    targetCommit=source[:12],targetSourceCommit=source,targetSha256=digest,
    createdAt=a.iso(now),expiresAt=a.iso(now+dt.timedelta(minutes=10)),
    status="requested",resolvedAt=None,approved=False,executable=False)
def refuses(fn):
    try:fn()
    except (e.Refused,a.Refused):return
    raise AssertionError("expected refusal")
with tempfile.TemporaryDirectory() as td:
    parent=pathlib.Path(td)
    state=parent/"approvals"
    class Store(a.ApprovalStore):
        def __init__(self,ignored):super().__init__(state,owner_uid=None)
    class Module:pass
    m=Module()
    m.ApprovalStore=Store
    m.when=a.when
    m.clock=a.clock
    installed=[old]
    m.read_host_node_id=lambda:node
    m.read_installed_version=lambda:installed[0]
    Store(None).approve(intent,node,old,now)
    e.STATE=state
    e.RELEASE_ROOT=parent/"releases-root"
    (e.RELEASE_ROOT/"releases").mkdir(parents=True)
    e.secure_executable=lambda _:None
    e.read_node_config=lambda _:{"ATLAS_NODE_ID":node,"ATLAS_NODE_CREDENTIAL":"s"*43,
        "ATLAS_SERVER_URL":"wss://atlas.example.com/node/connect"}
    log=[]
    def verified(archive,checksum,bundle,grant,runner):
        log.append("verify")
        assert grant["intentId"]==ident
        assert len(archive.read_bytes())>0
    e.verify_snapshot=verified
    def server(url,node_id,token,grant):
        log.append("server")
        assert log==["verify","watchdog-enabled","watchdog-active","node-active","server"], "claim requires signed verification and watchdog preflight"
        return {"status":"claimed"}
    e.claim_server=server
    e.input=lambda prompt:"EXECUTE "+ident
    def shell(command,**kwargs):
        assert kwargs["check"] and kwargs["env"]==e.SAFE_ENV
        if command[0]=="/usr/bin/systemctl":
            assert command[2]=="--quiet"
            assert command[3] in ("atlas-node-lifecycle-recover.timer", "atlas-node.service")
            log.append({"is-enabled":"watchdog-enabled",
                "is-active":("node-active" if command[3]=="atlas-node.service" else "watchdog-active")}[command[1]])
            return
        assert command[0]=="/usr/bin/bash"
        if command[1]==str(e.TRUSTED_STAGE) and command[2]=="install":
            log.append("install")
        elif command[1]==str(e.LIFECYCLE) and command[2]=="plan":
            log.append("plan")
        elif command[1]==str(e.LIFECYCLE) and command[2]=="activate":
            assert command[3:] == ["v2.0.1-"+source[:12],
                "--expect-current", "v2.0.0-"+"c"*12], command
            log.append("activate")
            installed[0]="2.0.1+"+source[:12]
        else:raise AssertionError("unexpected privileged command")
    archive=parent/"original.tar.gz";archive.write_bytes(b"dummy archive")
    checksum=parent/"checksum";checksum.write_text("dummy checksum")
    bundle=parent/"bundle";bundle.write_text("dummy attestation")
    with mock.patch.object(e.sys,"platform","linux"):
        record=e._execute(ident,archive,checksum,bundle,approval_module=m,runner=shell)
    assert record["stage"]=="activated",record
    assert log==["verify","watchdog-enabled","watchdog-active","node-active","server","install","plan","activate"],log
    assert Store(None).status(ident)["status"]=="claimed"
    receipt=e.ReceiptStore(Store(None)).read(ident)
    assert receipt["stage"]=="activated"
    assert not list(state.glob(".executor-input-*")), "successful upgrade must remove private snapshots"
    refuses(lambda:e._execute(ident,archive,checksum,bundle,approval_module=m,runner=shell))
    assert log==["verify","watchdog-enabled","watchdog-active","node-active","server","install","plan","activate"],"replay must stop before any mutation"
print("execution receipt and no-replay proof passed")
`);
});

test('root executor failed activation requires reconciliation and cannot execute twice', { skip: !available }, () => {
    passes(String.raw`
import importlib.util,datetime as dt,pathlib,sys,tempfile
def load(name,fn):
    spec=importlib.util.spec_from_file_location(name,fn)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
e=load("exe",sys.argv[1]);a=load("approval",sys.argv[2])
node="01234567-89ab-4cde-8fab-0123456789ab"
ident="12345678-90ab-4cde-8fab-1234567890ab"
now=dt.datetime.now(dt.timezone.utc)
old="2.0.0+"+"c"*12;source="b"*40
intent=dict(id=ident,nodeId=node,installedVersion=old,targetVersion="2.0.1",
    targetCommit=source[:12],targetSourceCommit=source,targetSha256="d"*64,
    createdAt=a.iso(now),expiresAt=a.iso(now+dt.timedelta(minutes=10)),
    status="requested",resolvedAt=None,approved=False,executable=False)
with tempfile.TemporaryDirectory() as td:
    base=pathlib.Path(td)
    class Store(a.ApprovalStore):
        def __init__(self,ignored):super().__init__(base/"state",owner_uid=None)
    class Module:pass
    m=Module();m.ApprovalStore=Store;m.when=a.when;m.clock=a.clock
    m.read_host_node_id=lambda:node;m.read_installed_version=lambda:old
    Store(None).approve(intent,node,old,now)
    e.STATE=base/"state";e.RELEASE_ROOT=base/"root"
    (e.RELEASE_ROOT/"releases").mkdir(parents=True)
    e.secure_executable=lambda _:None
    e.read_node_config=lambda _:{"ATLAS_NODE_ID":node,"ATLAS_NODE_CREDENTIAL":"s"*43,
        "ATLAS_SERVER_URL":"wss://atlas.example.com/node/connect"}
    e.verify_snapshot=lambda *args:None
    e.claim_server=lambda *args:None
    e.input=lambda _: "EXECUTE "+ident
    archive=base/"tarball";archive.write_bytes(b"a")
    checksum=base/"checksum";checksum.write_bytes(b"b")
    bundle=base/"bundle";bundle.write_bytes(b"c")
    def run(args,**opts):
        if args[1]==str(e.LIFECYCLE) and args[2]=="activate":
            assert args[3:] == ["v2.0.1-"+source[:12], "--expect-current", "v2.0.0-"+"c"*12]
            raise RuntimeError("simulated interrupted activation")
    try:e._execute(ident,archive,checksum,bundle,approval_module=m,runner=run)
    except RuntimeError:pass
    else:raise AssertionError("expected failed activation")
    assert e.ReceiptStore(Store(None)).read(ident)["stage"]=="requires_reconciliation"
    assert Store(None).status(ident)["status"]=="claimed"
    try:e._execute(ident,archive,checksum,bundle,approval_module=m,runner=run)
    except e.Refused:pass
    else:raise AssertionError("failed release was retried")
print("failure remains claimed and requires reconciliation")
`);
});

test('root executor cleans private snapshots on every preclaim refusal but preserves them on uncertain claim', { skip: !available }, () => {
    passes(String.raw`
import importlib.util,datetime as dt,pathlib,sys,tempfile
def load(name,fn):
    spec=importlib.util.spec_from_file_location(name,fn)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
e=load("exe",sys.argv[1]);a=load("approval",sys.argv[2])
node="01234567-89ab-4cde-8fab-0123456789ab"
ident="12345678-90ab-4cde-8fab-1234567890ab"
old="2.0.0+"+"c"*12;commit="b"*40
now=dt.datetime.now(dt.timezone.utc)
intent=dict(id=ident,nodeId=node,installedVersion=old,targetVersion="2.0.1",
    targetCommit=commit[:12],targetSourceCommit=commit,targetSha256="d"*64,
    createdAt=a.iso(now),expiresAt=a.iso(now+dt.timedelta(minutes=10)),
    status="requested",resolvedAt=None,approved=False,executable=False)
with tempfile.TemporaryDirectory() as td:
    parent=pathlib.Path(td)
    state=parent/"approvals"
    class Store(a.ApprovalStore):
        def __init__(self,unused):super().__init__(state,owner_uid=None)
    class Module: pass
    m=Module();m.ApprovalStore=Store;m.when=a.when;m.clock=a.clock
    m.read_host_node_id=lambda:node;m.read_installed_version=lambda:old
    Store(None).approve(intent,node,old,now)
    e.STATE=state;e.RELEASE_ROOT=parent/"root"
    (e.RELEASE_ROOT/"releases").mkdir(parents=True)
    e.secure_executable=lambda _:None
    e.read_node_config=lambda _:{"ATLAS_NODE_ID":node,
        "ATLAS_NODE_CREDENTIAL":"s"*43,
        "ATLAS_SERVER_URL":"wss://atlas.example.com/node/connect"}
    archive=parent/"archive";archive.write_bytes(b"archive")
    checksum=parent/"checksum";checksum.write_bytes(b"sidecar")
    bundle=parent/"bundle";bundle.write_bytes(b"attestation")
    e.claim_server=lambda *args: (_ for _ in ()).throw(e.Refused("uncertain Server reply"))
    good_copy=e.copy_snapshot
    def good_runner(args,**kwargs): return None
    def fail_runner(args,**kwargs):
        if args[0]=="/usr/bin/systemctl":raise RuntimeError("watchdog offline")
    for mode in ("partial_snapshot","bad_signature","watchdog_offline","declined"):
        e.copy_snapshot=good_copy
        e.verify_snapshot=lambda *args:None
        e.input=lambda _: "EXECUTE "+ident
        runner=good_runner
        if mode=="partial_snapshot":
            writes=[0]
            def incomplete_copy(src,dst,limit):
                writes[0]+=1
                if writes[0]==2:
                    dst.write_bytes(b"partial data")
                    raise RuntimeError("interrupted copying")
                return good_copy(src,dst,limit)
            e.copy_snapshot=incomplete_copy
        elif mode=="bad_signature":
            def invalid_signature(*args):
                raise e.Refused("missing verified attestation")
            e.verify_snapshot=invalid_signature
        elif mode=="watchdog_offline": runner=fail_runner
        else:e.input=lambda _: "NO"
        try:
            e._execute(ident,archive,checksum,bundle,approval_module=m,runner=runner)
        except (e.Refused,RuntimeError):
            pass
        else:raise AssertionError("unsafe preclaim path accepted: "+mode)
        assert not list(state.glob(".executor-input-*")), mode+": private stage leaked"
        assert e.ReceiptStore(Store(None)).read(ident) is None, mode+": a claim was recorded"
        assert Store(None).status(ident)["status"]=="approved",mode
    # A subsequent attempt with repaired inputs can still reach the Server,
    # but an ambiguous result MUST preserve the snapshot and receipt.
    e.copy_snapshot=good_copy
    e.verify_snapshot=lambda *args:None
    e.input=lambda _: "EXECUTE "+ident
    try:e._execute(ident,archive,checksum,bundle,approval_module=m,runner=good_runner)
    except e.Refused as exc: assert "uncertain" in str(exc)
    else:raise AssertionError("simulated uncertain claim accepted")
    assert e.ReceiptStore(Store(None)).read(ident)["stage"]=="requires_reconciliation"
    assert len(list(state.glob(".executor-input-*")))==1
    assert Store(None).status(ident)["status"]=="approved"
print("preclaim refused snapshots removed, uncertain claim retained")
`);
});
