import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gitWrite } from '../apps/node/src/capabilities/workspace-files/git-write.js';
import { WorkspaceFiles } from '../apps/node/src/capabilities/workspace-files/files.js';
function git(root: string, ...args: string[]) {
 return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding:'utf8' }).trim();
}
test('Git writes require per-root opt in, preserve main, and stage explicit inspected files', async t => {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-git-writes-')));
 t.after(()=>{rmSync(root,{recursive:true,force:true});});
 git(root,'init','-b','atlas/bootstrap');
 git(root,'config','user.name','Test');git(root,'config','user.email','test@example.test');
 writeFileSync(path.join(root,'README.md'),'initial\n');
 git(root,'add','README.md');git(root,'commit','-m','initial');
 git(root,'remote','add','origin','https://github.com/affank1020/portfolio-site.git');
 const files=new WorkspaceFiles([root]);
 const old=process.env.ATLAS_GIT_WRITE_ROOTS;
 t.after(()=>{if(old===undefined)delete process.env.ATLAS_GIT_WRITE_ROOTS;else process.env.ATLAS_GIT_WRITE_ROOTS=old;});
 await assert.rejects(gitWrite(root,files,'workspace_git_create_branch',{branch:'atlas/test'}),/not approved/);
 process.env.ATLAS_GIT_WRITE_ROOTS=root;
 await assert.rejects(gitWrite(root,files,'workspace_git_create_branch',{branch:'main'}),/Invalid Git branch/);
 const created=await gitWrite(root,files,'workspace_git_create_branch',{branch:'atlas/test'}) as any;
 assert.equal(created.branch,'atlas/test');
 writeFileSync(path.join(root,'README.md'),'updated\n');
 writeFileSync(path.join(root,'other.txt'),'unrelated\n');
 const checksum=(await files.read(root,'README.md')).sha256;
 await assert.rejects(gitWrite(root,files,'workspace_git_stage',{files:[{path:'README.md',expectedSha256:'0'.repeat(64)}]}),/changed/);
 const staged=await gitWrite(root,files,'workspace_git_stage',{files:[{path:'README.md',expectedSha256:checksum}]}) as any;
 const committed=await gitWrite(root,files,'workspace_git_commit',{branch:'atlas/test',expectedTree:staged.indexTree,files:['README.md'],message:'Update README'}) as any;
 assert.equal(committed.branch,'atlas/test');
 assert.equal(readFileSync(path.join(root,'other.txt'),'utf8'),'unrelated\n');
 assert.ok(git(root,'status','--porcelain').includes('other.txt'));
 const publish = { branch:'atlas/test', expectedHead:committed.head, repository:'affank1020/portfolio-site', githubToken:'ghs_testOnlyTokenDoesNotGrantPermissions' };
 const oldRemote = process.env.ATLAS_GIT_REMOTE_ROOTS;
 t.after(()=>{if(oldRemote===undefined)delete process.env.ATLAS_GIT_REMOTE_ROOTS;else process.env.ATLAS_GIT_REMOTE_ROOTS=oldRemote;});
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',publish),/not approved/);
 process.env.ATLAS_GIT_REMOTE_ROOTS=root;
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',publish),/not clean/);
 rmSync(path.join(root,'other.txt'));
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',{...publish,expectedHead:'0'.repeat(40)}),/HEAD changed/);
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',{...publish,repository:'affank1020/atlas'}),/origin does not match/);
});

test('clean main checkout can create/switch to an atlas/* branch, but cannot write directly to main', async t => {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-git-main-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-b','main');
 git(root,'config','user.name','Test');git(root,'config','user.email','test@example.test');
 writeFileSync(path.join(root,'README.md'),'initial\n');
 git(root,'add','README.md');git(root,'commit','-m','initial');
 const files=new WorkspaceFiles([root]);
 const old=process.env.ATLAS_GIT_WRITE_ROOTS;
 t.after(()=>{if(old===undefined)delete process.env.ATLAS_GIT_WRITE_ROOTS;else process.env.ATLAS_GIT_WRITE_ROOTS=old;});
 process.env.ATLAS_GIT_WRITE_ROOTS=root;
 await assert.rejects(gitWrite(root,files,'workspace_git_stage',{files:[{path:'README.md',expectedSha256:'0'.repeat(64)}]}),/require an atlas/);
 await assert.rejects(gitWrite(root,files,'workspace_git_create_branch',{branch:'main'}),/Invalid Git branch/);
 const created=await gitWrite(root,files,'workspace_git_create_branch',{branch:'atlas/first-feature'}) as any;
 assert.equal(created.branch,'atlas/first-feature');
 assert.equal(git(root,'branch','--show-current'),'atlas/first-feature');
 await assert.rejects(gitWrite(root,files,'workspace_git_switch_branch',{branch:'main'}),/Invalid Git branch/);
 git(root,'switch','main');
 const switched=await gitWrite(root,files,'workspace_git_switch_branch',{branch:'atlas/first-feature'}) as any;
 assert.equal(switched.branch,'atlas/first-feature');
});

test('Mac SSH origins must exactly match the approved GitHub repository', async t => {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-git-ssh-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-b','atlas/bootstrap');
 git(root,'config','user.name','Test');git(root,'config','user.email','test@example.test');
 writeFileSync(path.join(root,'README.md'),'initial\n');
 git(root,'add','README.md');git(root,'commit','-m','initial');
 git(root,'remote','add','origin','git@github.com:affank1020/atlas.git');
 const files=new WorkspaceFiles([root]);
 const oldWrite=process.env.ATLAS_GIT_WRITE_ROOTS, oldRemote=process.env.ATLAS_GIT_REMOTE_ROOTS;
 t.after(()=>{
  if(oldWrite===undefined)delete process.env.ATLAS_GIT_WRITE_ROOTS;else process.env.ATLAS_GIT_WRITE_ROOTS=oldWrite;
  if(oldRemote===undefined)delete process.env.ATLAS_GIT_REMOTE_ROOTS;else process.env.ATLAS_GIT_REMOTE_ROOTS=oldRemote;
 });
 process.env.ATLAS_GIT_WRITE_ROOTS=root;process.env.ATLAS_GIT_REMOTE_ROOTS=root;
 const publish={branch:'atlas/bootstrap',expectedHead:git(root,'rev-parse','HEAD'),
  repository:'affank1020/atlas',githubToken:''};
 // A matching origin reaches the token validation, with no network push.
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',publish),/Missing brokered GitHub credential/);
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',{...publish,repository:'affank1020/portfolio-site'}),/origin does not match/);
 git(root,'remote','set-url','origin','ssh://git@github.com/affank1020/atlas.git');
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',publish),/Missing brokered GitHub credential/);
 git(root,'remote','set-url','origin','git@github.com.evil.example:affank1020/atlas.git');
 await assert.rejects(gitWrite(root,files,'workspace_git_push_branch',publish),/origin does not match/);
});

test('one trusted Git development root approves nested repositories without per-repository env entries', async t => {
 const parent=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-trusted-git-')));
 const root=realpathSync(mkdtempSync(path.join(parent,'repo-')));
 const other=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-outside-git-')));
 t.after(()=>{rmSync(parent,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});});
 for (const dir of [root,other]) {
  git(dir,'init','-b','main');
  git(dir,'config','user.name','Test');git(dir,'config','user.email','test@example.test');
  writeFileSync(path.join(dir,'README.md'),'initial\\n');
  git(dir,'add','README.md');git(dir,'commit','-m','initial');
  git(dir,'remote','add','origin','https://github.com/affank1020/atlas.git');
 }
 const prior={trusted:process.env.ATLAS_GIT_TRUSTED_ROOTS,write:process.env.ATLAS_GIT_WRITE_ROOTS,remote:process.env.ATLAS_GIT_REMOTE_ROOTS};
 t.after(()=>{
  for(const [envKey,previous] of [['ATLAS_GIT_TRUSTED_ROOTS',prior.trusted],['ATLAS_GIT_WRITE_ROOTS',prior.write],['ATLAS_GIT_REMOTE_ROOTS',prior.remote]] as const) {
   if (previous===undefined) delete process.env[envKey]; else process.env[envKey]=previous;
  }
 });
 delete process.env.ATLAS_GIT_WRITE_ROOTS;delete process.env.ATLAS_GIT_REMOTE_ROOTS;
 process.env.ATLAS_GIT_TRUSTED_ROOTS=parent;
 const approved=new WorkspaceFiles([parent]);
 const created=await gitWrite(root,approved,'workspace_git_create_branch',{branch:'atlas/feature'}) as any;
 assert.equal(created.branch,'atlas/feature');
 await assert.rejects(gitWrite(other,new WorkspaceFiles([other]),'workspace_git_create_branch',{branch:'atlas/denied'}),/not approved/);
 const publish={branch:'atlas/feature',repository:'affank1020/atlas',expectedHead:git(root,'rev-parse','HEAD'),githubToken:''};
 await assert.rejects(gitWrite(root,approved,'workspace_git_push_branch',publish),/Missing brokered GitHub credential/);
});

test('verified linked worktrees can stage and commit while keeping main unchanged', async t => {
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'atlas-linked-writes-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const parent=path.join(root,'parent'),linked=path.join(root,'feature');
 mkdirSync(parent);
 git(parent,'init','-b','main');
 git(parent,'config','user.name','Test');git(parent,'config','user.email','test@example.test');
 writeFileSync(path.join(parent,'README.md'),'initial\n');
 git(parent,'add','README.md');git(parent,'commit','-m','initial');
 git(parent,'worktree','add','-b','atlas/linked-test',linked,'HEAD');
 git(parent,'remote','add','origin','https://github.com/affank1020/atlas.git');
 const previous=process.env.ATLAS_GIT_TRUSTED_ROOTS;
 process.env.ATLAS_GIT_TRUSTED_ROOTS=root;
 t.after(()=>{ if(previous===undefined) delete process.env.ATLAS_GIT_TRUSTED_ROOTS;
   else process.env.ATLAS_GIT_TRUSTED_ROOTS=previous; });
 const files=new WorkspaceFiles([root]);
 writeFileSync(path.join(linked,'README.md'),'feature content\n');
 const inspected=await files.read(linked,'README.md');
 const staged:any=await gitWrite(linked,files,'workspace_git_stage',{
   files:[{path:'README.md',expectedSha256:inspected.sha256}]});
 const committed:any=await gitWrite(linked,files,'workspace_git_commit',{
   branch:'atlas/linked-test',expectedTree:staged.indexTree,files:['README.md'],message:'Feature change'});
 assert.equal(committed.branch,'atlas/linked-test');
 // A linked worktree must get through layout checks and reach the normal
 // origin/token publishing safeguards, without making a live network request.
 const expectedHead=git(linked,'rev-parse','HEAD');
 await assert.rejects(gitWrite(linked,files,'workspace_git_push_branch',{
   repository:'affank1020/other',branch:'atlas/linked-test',
   expectedHead,githubToken:'not-a-real-token-with-enough-length'
 }),/origin does not match/);
 await assert.rejects(gitWrite(linked,files,'workspace_git_push_branch',{
   repository:'affank1020/atlas',branch:'atlas/linked-test',
   expectedHead,githubToken:''
 }),/Missing brokered GitHub credential/);
 assert.equal(readFileSync(path.join(parent,'README.md'),'utf8'),'initial\n');
 assert.equal(readFileSync(path.join(linked,'README.md'),'utf8'),'feature content\n');
});
