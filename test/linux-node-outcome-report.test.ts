import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const available=process.platform==='linux' && spawnSync('python3',['--version'],{encoding:'utf8'}).status===0;
const executor=resolve('scripts/linux-node-update-executor.py');
const approval=resolve('scripts/linux-node-update-approval.py');
function run(code:string){
    const r=spawnSync('python3',['-c',code,executor,approval],{encoding:'utf8',timeout:30_000});
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
}

test('host outcome publishing only exposes unverified, non-clearing results and refuses spoofed acknowledgments',
    {skip:!available},()=>{
    run(String.raw`
import importlib.util,json,sys
from unittest import mock
spec=importlib.util.spec_from_file_location("exe",sys.argv[1])
e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
ident="12345678-90ab-4cde-8fab-1234567890ab"
node="01234567-89ab-4cde-8fab-0123456789ab"
receipt=dict(intentId=ident,nodeId=node,stage="activated",targetSha256="a"*64)
class Reply:
    status=200
    headers={}
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,n):
        return json.dumps({"report":dict(intentId=ident,nodeId=node,reportedState="activated",
            reportedAt="2026-10-22T12:00:00Z",verified=False,clearsClaim=False)}).encode()
class Opener:
    def __init__(self):self.calls=0
    def open(self,request,timeout):
        self.calls+=1
        assert timeout==10
        assert request.full_url=="https://atlas.example.com/node/update-intents/report"
        assert json.loads(request.data)==dict(intentId=ident,targetSha256="a"*64,reportedState="activated")
        assert request.get_header("Authorization")=="Bearer "+"z"*43
        return Reply()
opener=Opener()
with mock.patch.object(e.urllib.request,"build_opener",return_value=opener):
    ok=e.report_server("https://atlas.example.com/node/update-intents/report",node,"z"*43,receipt)
assert ok["verified"] is False and ok["clearsClaim"] is False
assert opener.calls==1
e.urllib.request.build_opener=lambda *args:opener
bad=[{"report":{"intentId":ident,"nodeId":node,"reportedState":"activated",
                "reportedAt":"2026-10-22T12:00:00Z","verified":True,"clearsClaim":True}},
     {"report":{"intentId":"other","nodeId":node,"reportedState":"activated",
                "reportedAt":"2026-10-22T12:00:00Z","verified":False,"clearsClaim":False}}]
for item in bad:
    with mock.patch.object(Reply,"read",lambda self,n,body=item:json.dumps(body).encode()):
        try:e.report_server("https://atlas.example.com/node/update-intents/report",node,"z"*43,receipt)
        except e.Refused:pass
        else:raise AssertionError("host accepted misleading outcome response")
try:e.report_server("https://atlas.example.com/node/update-intents/report",node,"z"*43,
    {**receipt,"stage":"claiming"})
except e.Refused:pass
else:raise AssertionError("intermediate execution receipt was published")
print("unverified outcome ack and terminal-only checks passed")
`);
});

test('host outcome reporting requires a terminal root-owned receipt and explicit confirmation',
    {skip:!available},()=>{
    run(String.raw`
import importlib.util,datetime as dt,pathlib,sys,tempfile
from unittest import mock
def load(name,fn):
    spec=importlib.util.spec_from_file_location(name,fn)
    obj=importlib.util.module_from_spec(spec);spec.loader.exec_module(obj);return obj
e=load("exe",sys.argv[1]);a=load("approval",sys.argv[2])
node="01234567-89ab-4cde-8fab-0123456789ab"
ident="12345678-90ab-4cde-8fab-1234567890ab"
now=dt.datetime.now(dt.timezone.utc)
old="2.0.0+"+"a"*12
intent=dict(id=ident,nodeId=node,installedVersion=old,targetVersion="2.0.1",
 targetCommit="b"*12,targetSourceCommit="b"*40,targetSha256="c"*64,
 createdAt=a.iso(now),expiresAt=a.iso(now+dt.timedelta(minutes=10)),
 status="requested",resolvedAt=None,approved=False,executable=False)
with tempfile.TemporaryDirectory() as td:
    state=pathlib.Path(td)/"approvals"
    class Store(a.ApprovalStore):
        def __init__(self,unused):super().__init__(state,owner_uid=None)
    class Module: pass
    mod=Module();mod.ApprovalStore=Store;mod.read_host_node_id=lambda:node
    mod.read_installed_version=lambda:"2.0.1+"+"b"*12
    e.STATE=state
    e.RELEASE_ROOT=pathlib.Path(td)/"root"
    e.RELEASE_ROOT.mkdir()
    Store(None).approve(intent,node,old,now)
    receipt=e.ReceiptStore(Store(None))
    original=dict(schema=1,intentId=ident,nodeId=node,installedVersion=old,
                  targetVersion="2.0.1",targetCommit="b"*12,targetSha256="c"*64)
    receipt.mark(original,"claiming",create=True)
    e.read_node_config=lambda path:dict(ATLAS_NODE_ID=node,ATLAS_NODE_CREDENTIAL="z"*43,
        ATLAS_SERVER_URL="wss://atlas.example.com/node/connect")
    calls=[]
    e.report_server=lambda *args:(calls.append(args) or dict(verified=False,clearsClaim=False))
    e.input=lambda prompt:"REPORT "+ident
    with mock.patch.object(e.sys,"platform","linux"),mock.patch.object(e.os,"geteuid",return_value=0),mock.patch.object(e.os,"isatty",return_value=True):
        try:e.report_outcome(ident,approval_module=mod)
        except e.Refused:pass
        else:raise AssertionError("accepted intermediate claiming receipt")
        assert not calls
        receipt.mark(original,"requires_reconciliation")
        result=e.report_outcome(ident,approval_module=mod)
        assert result["verified"] is False
        assert calls[0][0]=="https://atlas.example.com/node/update-intents/report"
        assert calls[0][-1]["stage"]=="requires_reconciliation"
        e.input=lambda prompt:"DECLINE"
        try:e.report_outcome(ident,approval_module=mod)
        except e.Refused:pass
        else:raise AssertionError("operator confirmation bypass")
        assert len(calls)==1
        receipt.mark(original,"activated")
        e.input=lambda prompt:"REPORT "+ident
        mod.read_installed_version=lambda:old
        try:e.report_outcome(ident,approval_module=mod)
        except e.Refused:pass
        else:raise AssertionError("stale installed version should refuse activated report")
        assert len(calls)==1
print("root receipt and interactive confirmation enforced")
`);
});
