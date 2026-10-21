import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
const script=resolve('scripts/linux-node-repo-bootstrap.sh');
function git(args:string[],cwd?:string){const r=spawnSync('/usr/bin/git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function fixture(){
 // macOS may report /var/... for a directory whose canonical path is /private/var/....
 // Use the canonical location for both the fixture and its strict root assertion.
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'atlas-repo-bootstrap-'))),root=join(dir,'workspaces'),source=join(dir,'source');
 mkdirSync(root);git(['init','--initial-branch=main',source]);
 writeFileSync(join(source,'README.md'),'test\n');git(['add','README.md'],source);
 git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','Initial'],source);
 // Exercise the production Linux script on macOS without changing its Linux-only
 // realpath -e and mv -T semantics in the deployed file.
 const contents=readFileSync(script,'utf8')
 .replace("ROOT='/srv/atlas/workspaces'",`ROOT='${root}'`)
 .replace("SOURCE='https://github.com/affank1020/portfolio-site.git'",`SOURCE='${source}'`)
 .replace("EXPECTED_USER='atlas-node'",`EXPECTED_USER='${userInfo().username}'`)
 .replace('[[ "$ROOT" == /srv/atlas/workspaces ]]',`[[ "$ROOT" == '${root}' ]]`)
 .replaceAll('protocol.file.allow=never','protocol.file.allow=always')
 .replaceAll('realpath -e -- ',process.platform==='darwin' ? 'realpath ' : 'realpath -e -- ')
 .replace('mv -T -- ',process.platform==='darwin' ? 'mv -n -- ' : 'mv -T -- ');
 const file=join(dir,'bootstrap.sh');writeFileSync(file,contents,{mode:0o700});
 const run=(...args:string[])=>spawnSync('bash',[file,...args],{encoding:'utf8',timeout:15000});
 return {dir,root,source,run};
}
test('Linux bootstrap refuses unapproved repos and parses',t=>{
 assert.equal(spawnSync('bash',['-n',script]).status,0);
 const f=fixture();t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
 assert.equal(f.run('clone','../atlas').status,2);
 assert.equal(f.run('delete','portfolio-site').status,2);
});
test('Linux bootstrap clones into independent branch and never overwrites',t=>{
 const f=fixture();t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
 const r=f.run('clone','portfolio-site');assert.equal(r.status,0,r.stderr);
 const dest=join(f.root,'portfolio-site');
 assert.equal(git(['rev-parse','--abbrev-ref','HEAD'],dest),'atlas/bootstrap');
 assert.equal(readFileSync(join(dest,'README.md'),'utf8'),'test\n');
 assert.equal(f.run('status','portfolio-site').status,0);
 assert.notEqual(f.run('clone','portfolio-site').status,0);
});
test('Linux bootstrap rejects symlink entries before checkout',t=>{
 const f=fixture();t.after(()=>rmSync(f.dir,{recursive:true,force:true}));
 symlinkSync('README.md',join(f.source,'link'));git(['add','link'],f.source);
 git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','Link'],f.source);
 const r=f.run('clone','portfolio-site');assert.notEqual(r.status,0);
 assert.match(r.stderr,/symlink or submodule/);
 assert.equal(existsSync(join(f.root,'portfolio-site')),false);
});
