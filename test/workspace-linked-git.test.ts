import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFiles, git as inspectGit } from '../apps/node/src/capabilities/workspace-files/files.js';

const git = (root: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

test('safe linked worktree is visible to Git status without leaving Node-approved filesystem roots', async t => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'atlas-worktree-check-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const main = path.join(root, 'main');
    const linked = path.join(root, 'linked');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'user.email', 'test@example.test');
    writeFileSync(path.join(main, 'README.md'), 'original');
    git(main, 'add', 'README.md');
    git(main, 'commit', '-m', 'Initial');
    git(main, 'worktree', 'add', '-b', 'atlas/rebrand', linked, 'main');

    const approved = new WorkspaceFiles([root]);
    const result = await inspectGit(linked, approved);
    assert.equal(result.available, true);
    if (result.available) {
        assert.equal(result.branch, 'atlas/rebrand');
        assert.equal(result.dirty, false);
    }
    const fake = path.join(root, 'untrusted');
    mkdirSync(fake);
    writeFileSync(path.join(fake, '.git'), 'gitdir: /etc\n');
    const denied = await inspectGit(fake, approved);
    assert.equal(denied.available, false);
});
