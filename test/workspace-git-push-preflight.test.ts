import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalNodeRuntime } from '../apps/node/src/platforms/desktop/runtime.js';
const git=(root:string,...args:string[]) => execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8'}).trim();

test('Node Git publishing normalizes early preflight process failures on Linux and macOS', async t => {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-git-detached-push-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-b','atlas/bootstrap');
 git(root,'config','user.name','Test');git(root,'config','user.email','test@example.test');
 writeFileSync(path.join(root,'README.md'),'initial\n');
 git(root,'add','README.md');git(root,'commit','-m','initial');
 git(root,'remote','add','origin','https://github.com/affank1020/atlas.git');
 const head=git(root,'rev-parse','HEAD');
 // Detached HEAD makes preflight symbolic-ref fail before a token is used.
 git(root,'checkout','--detach','HEAD');
 const previous={trusted:process.env.ATLAS_GIT_TRUSTED_ROOTS,write:process.env.ATLAS_GIT_WRITE_ROOTS,remote:process.env.ATLAS_GIT_REMOTE_ROOTS};
 t.after(()=>{
   for(const [key,value] of Object.entries(previous)) {
     const envKey=key==='trusted'?'ATLAS_GIT_TRUSTED_ROOTS':key==='write'?'ATLAS_GIT_WRITE_ROOTS':'ATLAS_GIT_REMOTE_ROOTS';
     if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;
   }
 });
 process.env.ATLAS_GIT_WRITE_ROOTS=root;
 process.env.ATLAS_GIT_REMOTE_ROOTS=root;
 for(const platform of ['darwin','linux'] as const) {
   const runtime=new LocalNodeRuntime([root],new Map(),platform);
   await assert.rejects(runtime.execute({rootPath:root,adapter:null,kind:'generic',status:'active'} as any,
       'workspace_git_push_branch',{repository:'affank1020/atlas',branch:'atlas/bootstrap',expectedHead:head,githubToken:''}),
       (error:any)=> {
         assert.equal(error.code,'GIT_PUSH_FAILED');
         assert.doesNotMatch(error.message,/Node operation failed|Authorization|ghs_/);
         return true;
       });
 }
});
